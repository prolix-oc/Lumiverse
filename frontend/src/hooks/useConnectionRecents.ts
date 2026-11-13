import { useMemo } from 'react'
import { useStore } from '@/store'
import { recentConnectionIds, withRecentConnection } from '@/lib/connectionRecents'
import type { ConnectionLibraryKind } from '@/lib/connectionLibrary'

export function rememberConnection(kind: ConnectionLibraryKind, id: string) {
  const state = useStore.getState()
  if (!id || state.fullSettingsLoaded === false) return
  state.setSetting('recentConnections', withRecentConnection(state.recentConnections, kind, id, state.connectionsPickerSettings?.recentProfileIds))
}

export function useConnectionRecents(kind: ConnectionLibraryKind) {
  const enabled = useStore(state => state.showRecentConnections !== false)
  const recent = useStore(state => state.recentConnections)
  const legacyText = useStore(state => state.connectionsPickerSettings?.recentProfileIds)
  return useMemo(() => enabled ? recentConnectionIds(recent, kind, legacyText).slice(0, 4) : [], [enabled, recent, kind, legacyText])
}
