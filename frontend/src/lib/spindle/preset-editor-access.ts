import type { SpindlePresetEditorScopedHelper } from './preset-editor-types'
import { createPresetEditorScopedHelper, type PresetEditorScopedAccess } from './preset-editor-helper'

/**
 * Owns the revocation epoch for one extension's scoped preset-editor helpers.
 * A retained helper can never become valid again after `revoke()`; callers must
 * acquire a new facade after the permission is granted again.
 */
export function createPresetEditorAccess(
  extensionIdentifier: string,
  getGrantedPermissions: () => readonly string[],
  trackSubscription: PresetEditorScopedAccess['trackSubscription'],
): {
  acquire(): SpindlePresetEditorScopedHelper
  revoke(): void
  dispose(): void
} {
  let epoch = 0
  let disposed = false

  return {
    acquire(): SpindlePresetEditorScopedHelper {
      if (disposed) {
        throw new Error('PRESET_EDITOR_DISPOSED: Extension frontend has been unloaded')
      }
      if (!getGrantedPermissions().includes('presets')) {
        throw new Error('PERMISSION_DENIED:presets — preset editor extension helper requires the presets permission')
      }
      const acquiredEpoch = epoch
      return createPresetEditorScopedHelper(extensionIdentifier, {
        assertActive() {
          if (disposed) {
            throw new Error('PRESET_EDITOR_DISPOSED: Extension frontend has been unloaded')
          }
          if (!getGrantedPermissions().includes('presets')) {
            throw new Error('PERMISSION_DENIED:presets — preset editor extension helper requires the presets permission')
          }
          if (epoch !== acquiredEpoch) {
            throw new Error('PRESET_EDITOR_REVOKED: Acquire a fresh preset editor helper before using it')
          }
        },
        trackSubscription,
      })
    },
    revoke() {
      epoch += 1
    },
    dispose() {
      if (disposed) return
      disposed = true
      epoch += 1
    },
  }
}
