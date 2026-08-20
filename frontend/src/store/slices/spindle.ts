import type { StateCreator } from 'zustand'
import type { SpindleSlice, PendingPermissionRequest, PendingTextEditorRequest, PendingContextMenuRequest, ExtensionThemeOverride, BulkUpdateStatus } from '@/types/store'
import type { ExtensionInfo } from 'lumiverse-spindle-types'
import { wsClient } from '@/ws/client'
import { spindleApi } from '@/api/spindle'
import { loadFrontendExtension, unloadFrontendExtension } from '@/lib/spindle/loader'
import { scheduleLowPriorityTask } from '@/lib/low-priority-task'
import { yieldToBrowser } from '@/lib/spindle/browser-scheduler'
import { compareFrontendHydrationPriority } from '@/lib/spindle/frontend-startup-priority'
import { shareExtensionLoad } from '@/lib/spindle/extension-load-flight'

const MUTED_THEMES_KEY = 'lumiverse:mutedExtensionThemes'
const FRONTEND_HYDRATION_CONCURRENCY = 4
const SPINDLE_LIST_RETRY_ATTEMPTS = 5
const SPINDLE_LIST_RETRY_BASE_DELAY_MS = 1_000
const SPINDLE_LIST_RETRY_BACKOFF = 1.7
const SPINDLE_LIST_RETRY_MAX_DELAY_MS = 8_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Boot hydration is one-shot (WS CONNECTED -> loadExtensions). A transient
 * failure of the single `GET /api/v1/spindle` request at cold start left the
 * store empty so Canvas never loaded until the user happened to open the
 * Extensions panel (which only re-runs when empty). Retry the list fetch with
 * a bounded backoff so a cold-start hiccup self-heals.
 */
async function retrySpindleList(): Promise<{ extensions: ExtensionInfo[]; isPrivileged: boolean }> {
  let delay = SPINDLE_LIST_RETRY_BASE_DELAY_MS
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await spindleApi.list()
    } catch (err) {
      if (attempt >= SPINDLE_LIST_RETRY_ATTEMPTS) throw err
      console.warn(
        `[Spindle] Extension list fetch failed (attempt ${attempt}/${SPINDLE_LIST_RETRY_ATTEMPTS}), retrying:`,
        err,
      )
      await sleep(delay)
      delay = Math.min(delay * SPINDLE_LIST_RETRY_BACKOFF, SPINDLE_LIST_RETRY_MAX_DELAY_MS)
    }
  }
}

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
  extensionUpdates: [],
  extensionThemeOverrides: {},
  mutedExtensionThemes: loadMutedThemes(),
  chatStyleModes: {},
  extensionOperationStatus: null,
  bulkUpdateStatus: null,
  spindlePrivileged: false,
  pendingPermissionRequest: null,
  pendingTextEditor: null,
  pendingModal: null,
  pendingConfirm: null,
  pendingInputPrompt: null,
  pendingContextMenu: null,

  loadExtensions: () => shareExtensionLoad(async () => {
    try {
      // Retry the one-shot list fetch so a transient cold-start failure does
      // not leave the store empty (and the extension unloaded until the user
      // happens to open the Extensions panel, which only re-runs when empty).
      const { extensions, isPrivileged } = await retrySpindleList()
      set({ extensions, spindlePrivileged: isPrivileged })

      await new Promise<void>((resolveHydration) => {
        scheduleLowPriorityTask(async () => {
          const hydrateExtension = async (ext: typeof extensions[number]) => {
            const status = get().extensionOperationStatus
            const updateReloadPending =
              status?.extensionId === ext.id &&
              (status.operation === 'updating' || status.operation === 'updated')

            if (updateReloadPending) return

            if (ext.enabled && ext.has_frontend) {
              const manifest = await spindleApi.getManifest(ext.id)
              await loadFrontendExtension(ext.id, manifest)
            } else {
              await unloadFrontendExtension(ext.id)
            }
          }

          try {
            const hydrationQueue = extensions
              .filter((ext) => ext.enabled && ext.has_frontend)
              .sort(compareFrontendHydrationPriority)

            const cleanupQueue = extensions.filter((ext) => !(ext.enabled && ext.has_frontend))

            let nextIndex = 0
            const workerCount = Math.min(FRONTEND_HYDRATION_CONCURRENCY, Math.max(1, hydrationQueue.length))

            if (hydrationQueue.length > 0) {
              await Promise.allSettled(
                Array.from({ length: workerCount }, async () => {
                  while (true) {
                    const ext = hydrationQueue[nextIndex++]
                    if (!ext) return

                    try {
                      await hydrateExtension(ext)
                    } catch (err) {
                      console.error(`[Spindle] Failed to hydrate frontend for ${ext.id}:`, err)
                    }

                    await yieldToBrowser({ when: 'paint' })
                  }
                })
              )
            }

            for (const ext of cleanupQueue) {
              try {
                await hydrateExtension(ext)
              } catch (err) {
                console.error(`[Spindle] Failed to reconcile frontend for ${ext.id}:`, err)
              }
            }
          } catch (err) {
            console.error('[Spindle] Frontend hydration loop failed:', err)
          } finally {
            resolveHydration()
          }
        }, { label: 'spindle frontend hydration' })
      })
    } catch (err) {
      console.error('[Spindle] Failed to load extensions:', err)
    }
  }),

  setExtensionUpdates: (extensionUpdates) => {
    set({ extensionUpdates })
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
      extensionUpdates: state.extensionUpdates.filter((update) => update.extensionId !== id),
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
      extensionUpdates: state.extensionUpdates.filter((update) => update.extensionId !== id),
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
    get().clearExtensionChatStyleModes(id)
    set((state) => {
      const { [id]: _o, ...overridesRest } = state.extensionThemeOverrides
      const { [id]: _m, ...mutedRest } = state.mutedExtensionThemes
      if (id in state.mutedExtensionThemes) saveMutedThemes(mutedRest)
      return {
        extensions: state.extensions.filter((e) => e.id !== id),
        extensionUpdates: state.extensionUpdates.filter((update) => update.extensionId !== id),
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
      scheduleLowPriorityTask(() => {
        void spindleApi.getManifest(id)
          .then((manifest) => loadFrontendExtension(id, manifest))
          .catch((err) => console.error('[Spindle] Failed to load frontend after enable:', err))
      }, { label: 'spindle frontend enable hydration' })
    }
  },

  disableExtension: async (id: string) => {
    await spindleApi.disable(id)
    await unloadFrontendExtension(id)
    get().clearExtensionChatStyleModes(id)
    set((state) => ({
      extensions: state.extensions.map((e) =>
        e.id === id ? { ...e, enabled: false, status: 'stopped' as const } : e
      ),
      extensionUpdates: state.extensionUpdates.filter((update) => update.extensionId !== id),
      extensionThemeOverrides: Object.fromEntries(
        Object.entries(state.extensionThemeOverrides).filter(([extensionId]) => extensionId !== id)
      ),
    }))
  },

  restartExtension: async (id: string) => {
    get().clearExtensionThemeOverride(id)
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

  grantPermissions: async (id: string, permissions: string[]) => {
    if (permissions.length === 0) return
    const result = await spindleApi.setPermissions(id, { grant: permissions })
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

  dismissTextEditor: (requestId: string) => {
    set((state) => {
      if (state.pendingTextEditor?.requestId !== requestId) return state
      return { ...state, pendingTextEditor: null }
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
    const previous = get().pendingConfirm
    if (previous && previous.requestId !== request.requestId) {
      wsClient.send({
        type: 'SPINDLE_CONFIRM_RESULT',
        requestId: previous.requestId,
        confirmed: false,
      })
      window.dispatchEvent(
        new CustomEvent('spindle:confirm-resolved', {
          detail: { requestId: previous.requestId, confirmed: false },
        })
      )
    }
    set({ pendingConfirm: request })
  },

  closeSpindleConfirm: (requestId: string, confirmed: boolean) => {
    const current = get().pendingConfirm
    if (!current || current.requestId !== requestId) return
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

  setChatStyleMode: (chatId: string, extensionId: string, mode: 'bounded' | 'extension-relaxed') => {
    set((state) => {
      const current = state.chatStyleModes[chatId] ?? {}
      const hasClaim = extensionId in current
      if (mode === 'bounded') {
        if (!hasClaim) return state
        const { [extensionId]: _, ...remaining } = current
        const nextBucket = remaining
        if (Object.keys(nextBucket).length === 0) {
          const { [chatId]: __, ...rest } = state.chatStyleModes
          return { chatStyleModes: rest }
        }
        return { chatStyleModes: { ...state.chatStyleModes, [chatId]: nextBucket } }
      }
      if (current[extensionId] === mode) return state
      return {
        chatStyleModes: {
          ...state.chatStyleModes,
          [chatId]: { ...current, [extensionId]: mode },
        },
      }
    })
  },

  clearChatStyleMode: (chatId: string) => {
    set((state) => {
      if (!(chatId in state.chatStyleModes)) return state
      const { [chatId]: _, ...rest } = state.chatStyleModes
      return { chatStyleModes: rest }
    })
  },

  clearExtensionChatStyleModes: (extensionId: string) => {
    set((state) => {
      let mutated = false
      const next: Record<string, Record<string, 'extension-relaxed'>> = {}
      for (const [chatId, bucket] of Object.entries(state.chatStyleModes)) {
        if (!(extensionId in bucket)) {
          next[chatId] = bucket
          continue
        }
        mutated = true
        const { [extensionId]: _, ...remaining } = bucket
        if (Object.keys(remaining).length > 0) {
          next[chatId] = remaining as Record<string, 'extension-relaxed'>
        }
      }
      return mutated ? { chatStyleModes: next } : state
    })
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
