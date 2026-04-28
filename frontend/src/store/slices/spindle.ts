import type { StateCreator } from 'zustand'
import type { SpindleSlice, PendingPermissionRequest, PendingTextEditorRequest, PendingContextMenuRequest, ExtensionThemeOverride, BulkUpdateStatus } from '@/types/store'
import { wsClient } from '@/ws/client'
import { spindleApi } from '@/api/spindle'
import { loadFrontendExtension, unloadFrontendExtension } from '@/lib/spindle/loader'

const MUTED_THEMES_KEY = 'lumiverse:mutedExtensionThemes'

function loadMutedThemes(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(MUTED_THEMES_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const result: Record<string, boolean> = {}
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === true) result[id] = true
    }
    return result
  } catch { return {} }
}

function saveMutedThemes(muted: Record<string, boolean>) {
  try { localStorage.setItem(MUTED_THEMES_KEY, JSON.stringify(muted)) } catch {}
}

export const createSpindleSlice: StateCreator<SpindleSlice> = (set, get) => ({
  extensions: [],
  extensionThemeOverrides: {},
  mutedExtensionThemes: loadMutedThemes(),
  extensionOperationStatus: null,
  bulkUpdateStatus: null,
  spindlePrivileged: false,
  pendingPermissionRequest: null,
  pendingTextEditor: null,
  pendingModal: null,
  pendingConfirm: null,
  pendingInputPrompt: null,
  pendingContextMenu: null,

  loadExtensions: async () => {
    try {
      const { extensions, isPrivileged } = await spindleApi.list()
      set({ extensions, spindlePrivileged: isPrivileged })

      queueMicrotask(() => {
        void Promise.allSettled(
          extensions.map(async (ext) => {
            if (ext.enabled && ext.has_frontend) {
              const manifest = await spindleApi.getManifest(ext.id)
              await loadFrontendExtension(ext.id, manifest)
            } else {
              await unloadFrontendExtension(ext.id)
            }
          })
        )
      })
    } catch (err) {
      console.error('[Spindle] Failed to load extensions:', err)
    }
  },

  installExtension: async (githubUrl: string, branch?: string | null) => {
    const ext = await spindleApi.install(githubUrl, branch)
    set((state) => ({ extensions: [ext, ...state.extensions] }))
  },

  updateExtension: async (id: string) => {
    const updated = await spindleApi.update(id)
    spindleApi.clearManifestCache(id)
    set((state) => ({
      extensions: state.extensions.map((e) => (e.id === id ? updated : e)),
    }))
    if (updated.enabled && updated.has_frontend) {
      const manifest = await spindleApi.getManifest(id, { force: true })
      await loadFrontendExtension(id, manifest, true)
    }
  },

  switchBranch: async (id: string, branch: string) => {
    const updated = await spindleApi.switchBranch(id, branch)
    spindleApi.clearManifestCache(id)
    set((state) => ({
      extensions: state.extensions.map((e) => (e.id === id ? updated : e)),
    }))
    if (updated.enabled && updated.has_frontend) {
      const manifest = await spindleApi.getManifest(id, { force: true })
      await loadFrontendExtension(id, manifest, true)
    }
  },

  removeExtension: async (id: string) => {
    await spindleApi.remove(id)
    spindleApi.clearManifestCache(id)
    await unloadFrontendExtension(id)
    set((state) => {
      const { [id]: _o, ...overridesRest } = state.extensionThemeOverrides
      const { [id]: _m, ...mutedRest } = state.mutedExtensionThemes
      if (id in state.mutedExtensionThemes) saveMutedThemes(mutedRest)
      return {
        extensions: state.extensions.filter((e) => e.id !== id),
        extensionThemeOverrides: overridesRest,
        mutedExtensionThemes: mutedRest,
      }
    })
  },

  enableExtension: async (id: string) => {
    await spindleApi.enable(id)
    set((state) => ({
      extensions: state.extensions.map((e) =>
        e.id === id ? { ...e, enabled: true, status: 'running' as const } : e
      ),
    }))

    const ext = get().extensions.find((e) => e.id === id)
    if (ext?.has_frontend) {
      queueMicrotask(() => {
        void spindleApi.getManifest(id)
          .then((manifest) => loadFrontendExtension(id, manifest))
          .catch((err) => console.error('[Spindle] Failed to load frontend after enable:', err))
      })
    }
  },

  disableExtension: async (id: string) => {
    await spindleApi.disable(id)
    await unloadFrontendExtension(id)
    set((state) => ({
      extensions: state.extensions.map((e) =>
        e.id === id ? { ...e, enabled: false, status: 'stopped' as const } : e
      ),
    }))
  },

  restartExtension: async (id: string) => {
    await unloadFrontendExtension(id)
    await spindleApi.restart(id)
    spindleApi.clearManifestCache(id)
    const manifest = await spindleApi.getManifest(id, { force: true })
    await loadFrontendExtension(id, manifest)
  },

  grantPermission: async (id: string, permission: string) => {
    const result = await spindleApi.setPermissions(id, { grant: [permission] })
    set((state) => ({
      extensions: state.extensions.map((e) =>
        e.id === id ? { ...e, granted_permissions: result.granted as any } : e
      ),
    }))
  },

  revokePermission: async (id: string, permission: string) => {
    const result = await spindleApi.setPermissions(id, { revoke: [permission] })
    set((state) => ({
      extensions: state.extensions.map((e) =>
        e.id === id ? { ...e, granted_permissions: result.granted as any } : e
      ),
    }))
  },

  showPermissionRequest: (request: PendingPermissionRequest) => {
    set({ pendingPermissionRequest: request })
  },

  resolvePermissionRequest: async (id: string, approved: boolean) => {
    const req = get().pendingPermissionRequest
    if (!req || req.id !== id) return

    let granted: string[] = []
    if (approved) {
      const result = await spindleApi.setPermissions(req.extensionId, { grant: req.permissions })
      granted = result.granted
      // Sync the extension's granted_permissions in the store
      set((state) => ({
        pendingPermissionRequest: null,
        extensions: state.extensions.map((e) =>
          e.id === req.extensionId ? { ...e, granted_permissions: granted as any } : e
        ),
      }))
    } else {
      set({ pendingPermissionRequest: null })
    }

    window.dispatchEvent(
      new CustomEvent('spindle:permission-resolved', {
        detail: { requestId: id, approved, granted },
      })
    )
  },

  openTextEditor: (request: PendingTextEditorRequest) => {
    set({ pendingTextEditor: request })
  },

  closeTextEditor: (requestId: string, text: string, cancelled: boolean) => {
    set({ pendingTextEditor: null })
    wsClient.send({
      type: 'SPINDLE_TEXT_EDITOR_RESULT',
      requestId,
      text,
      cancelled,
    })
  },

  openSpindleModal: (request) => {
    set({ pendingModal: request })
  },

  closeSpindleModal: (requestId: string, dismissedBy: 'user' | 'extension' | 'cleanup') => {
    set({ pendingModal: null })
    wsClient.send({
      type: 'SPINDLE_MODAL_RESULT',
      requestId,
      dismissedBy,
    })
  },

  dismissSpindleModal: (requestId: string) => {
    set((state) => {
      // Only clear if the requestId matches to avoid stale dismissals.
      // Unlike closeSpindleModal, this does NOT send a WS message back —
      // preventing an echo loop when the server initiates the close.
      if (state.pendingModal?.requestId !== requestId) return state
      return { ...state, pendingModal: null }
    })
  },

  openSpindleConfirm: (request) => {
    set({ pendingConfirm: request })
  },

  closeSpindleConfirm: (requestId: string, confirmed: boolean) => {
    set({ pendingConfirm: null })
    wsClient.send({
      type: 'SPINDLE_CONFIRM_RESULT',
      requestId,
      confirmed,
    })
    window.dispatchEvent(
      new CustomEvent('spindle:confirm-resolved', {
        detail: { requestId, confirmed },
      })
    )
  },

  openInputPrompt: (request) => {
    set({ pendingInputPrompt: request })
  },

  closeInputPrompt: (requestId: string, value: string | null) => {
    set({ pendingInputPrompt: null })
    wsClient.send({
      type: 'SPINDLE_INPUT_PROMPT_RESULT',
      requestId,
      value,
      cancelled: value === null,
    })
  },

  openContextMenu: (request: PendingContextMenuRequest) => {
    // If another extension already has a pending context menu, cancel it so
    // its showContextMenu() promise resolves with null instead of being
    // silently orphaned when we overwrite the slot. This preserves ownership
    // correctness: the previous extension sees cancellation, and only the
    // new request owns the visible menu.
    const prev = get().pendingContextMenu
    if (prev && prev.requestId !== request.requestId) {
      window.dispatchEvent(
        new CustomEvent('spindle:context-menu-resolved', {
          detail: { requestId: prev.requestId, selectedKey: null },
        })
      )
    }
    set({ pendingContextMenu: request })
  },

  closeContextMenu: (requestId: string, selectedKey: string | null) => {
    // Only clear the slot if the requestId still matches the currently-pending
    // menu. A stale close (e.g. from an onClose closure captured when a prior
    // request was pending) must not wipe out a newer request's menu.
    const current = get().pendingContextMenu
    if (current && current.requestId === requestId) {
      set({ pendingContextMenu: null })
    }
    window.dispatchEvent(
      new CustomEvent('spindle:context-menu-resolved', {
        detail: { requestId, selectedKey },
      })
    )
  },

  setExtensionThemeOverride: (override: ExtensionThemeOverride) => {
    set((state) => ({
      extensionThemeOverrides: {
        ...state.extensionThemeOverrides,
        [override.extensionId]: override,
      },
    }))
  },

  clearExtensionThemeOverride: (extensionId: string) => {
    set((state) => {
      const { [extensionId]: _, ...rest } = state.extensionThemeOverrides
      return { extensionThemeOverrides: rest }
    })
  },

  clearAllExtensionThemeOverrides: () => {
    set({ extensionThemeOverrides: {} })
  },

  muteExtensionTheme: (extensionId: string) => {
    set((state) => {
      const next = { ...state.mutedExtensionThemes, [extensionId]: true }
      saveMutedThemes(next)
      return { mutedExtensionThemes: next }
    })
  },

  unmuteExtensionTheme: (extensionId: string) => {
    set((state) => {
      const { [extensionId]: _, ...rest } = state.mutedExtensionThemes
      saveMutedThemes(rest)
      return { mutedExtensionThemes: rest }
    })
  },

  setExtensionOperationStatus: (extensionId: string | null, operation: string, name: string | null) => {
    // "completed" operations (past tense) auto-clear after a short delay
    const isCompleted = !operation.endsWith('ing')
    set({ extensionOperationStatus: { extensionId, operation, name } })
    if (isCompleted) {
      setTimeout(() => {
        const current = get().extensionOperationStatus
        if (current && current.operation === operation && current.extensionId === extensionId) {
          set({ extensionOperationStatus: null })
        }
      }, 2000)
    }
  },

  updateAllExtensions: async () => {
    const result = await spindleApi.updateAll()
    // Seed progress state so the button flips to its spinner immediately,
    // before any WS events arrive.
    set({
      bulkUpdateStatus: {
        total: result.total,
        completed: 0,
        failed: 0,
      },
    })
  },

  setBulkUpdateStatus: (status: BulkUpdateStatus | null) => {
    set({ bulkUpdateStatus: status })
  },
})
