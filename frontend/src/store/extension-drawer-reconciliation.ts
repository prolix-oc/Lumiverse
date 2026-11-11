import type { AppStore } from '@/types/store'
import { reconcileExtensionDrawerSettings, removeExtensionDrawerSettings } from '@/lib/drawer-layout'

type ReconciliationState = Pick<AppStore,
  'extensions' | 'extensionsLoaded' | 'drawerSettings' | 'fullSettingsLoaded' | 'setSetting'
>

export function reconcileInstalledExtensionDrawerTabs(state: ReconciliationState, removedExtensionId?: string): void {
  // An empty startup store or a failed list request cannot prove an uninstall.
  // Wait for full settings too, so cleanup is persisted through the normal writer.
  if (!state.fullSettingsLoaded || (!state.extensionsLoaded && !removedExtensionId)) return
  const next = removedExtensionId
    ? removeExtensionDrawerSettings(state.drawerSettings, removedExtensionId)
    : reconcileExtensionDrawerSettings(
        state.drawerSettings,
        new Set(state.extensions.map((extension) => extension.id)),
      )
  if (next !== state.drawerSettings) state.setSetting('drawerSettings', next, 'automatic-sync')
}
