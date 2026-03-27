import type { StateCreator } from 'zustand'
import type { SpindleSlice, PendingPermissionRequest, PendingTextEditorRequest, PendingContextMenuRequest, ExtensionThemeOverride } from '@/types/store'
import { wsClient } from '@/ws/client'
import { spindleApi } from '@/api/spindle'
import { loadFrontendExtension, unloadFrontendExtension } from '@/lib/spindle/loader'

export const createSpindleSlice: StateCreator<SpindleSlice> = (set, get) => ({
  extensions: [],
  extensionThemeOverrides: {},
  extensionOperationStatus: null,
  spindlePrivileged: false,
  pendingPermissionRequest: null,
  pendingTextEditor: null,
  pendingContextMenu: null,

  loadExtensions: async () => {
    try {
      const { extensions, isPrivileged } = await spindleApi.list()
      set({ extensions, spindlePrivileged: isPrivileged })

      await Promise.all(
        extensions.map(async (ext) => {
          if (ext.enabled && ext.has_frontend) {
            const manifest = await spindleApi.getManifest(ext.id)
            await loadFrontendExtension(ext.id, manifest)
          } else {
            await unloadFrontendExtension(ext.id)
          }
        })
      )
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
    set((state) => ({
      extensions: state.extensions.map((e) => (e.id === id ? updated : e)),
    }))
  },

  switchBranch: async (id: string, branch: string) => {
    const updated = await spindleApi.switchBranch(id, branch)
    set((state) => ({
      extensions: state.extensions.map((e) => (e.id === id ? updated : e)),
    }))
  },

  removeExtension: async (id: string) => {
    await spindleApi.remove(id)
    await unloadFrontendExtension(id)
    set((state) => ({
      extensions: state.extensions.filter((e) => e.id !== id),
    }))
  },

  enableExtension: async (id: string) => {
    await spindleApi.enable(id)

    const manifest = await spindleApi.getManifest(id)
    await loadFrontendExtension(id, manifest)
    set((state) => ({
      extensions: state.extensions.map((e) =>
        e.id === id ? { ...e, enabled: true, status: 'running' as const } : e
      ),
    }))
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
    const manifest = await spindleApi.getManifest(id)
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

  openContextMenu: (request: PendingContextMenuRequest) => {
    set({ pendingContextMenu: request })
  },

  closeContextMenu: (requestId: string, selectedKey: string | null) => {
    set({ pendingContextMenu: null })
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
})
