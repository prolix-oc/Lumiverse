import { useEffect } from 'react'
import { presetProfilesApi } from '@/api/preset-profiles'
import { useStore } from '@/store'
import { beginActiveLoomPresetSelection } from '@/lib/loom/preset-selection-coordinator'

export function useBoundPresetSelection() {
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const fullSettingsLoaded = useStore((s) => s.fullSettingsLoaded)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)

  useEffect(() => {
    if (!isAuthenticated || !fullSettingsLoaded || !activeChatId) return

    let cancelled = false
    const selectionAbort = new AbortController()
    const selection = beginActiveLoomPresetSelection({ signal: selectionAbort.signal })
    const fallbackPresetId = useStore.getState().activeLoomPresetId

    presetProfilesApi.resolve(activeChatId, fallbackPresetId, activeProfileId)
      .then((resolved) => {
        if (cancelled) return
        if (
          resolved.source !== 'chat'
          && resolved.source !== 'character'
          && resolved.source !== 'connection'
        ) {
          selection.cancel()
          return
        }
        if (!resolved.preset_id || useStore.getState().activeChatId !== activeChatId) {
          selection.cancel()
          return
        }
        if (useStore.getState().activeLoomPresetId === resolved.preset_id) {
          selection.cancel()
          return
        }
        void selection.transition(resolved.preset_id).catch(() => {})
      })
      .catch(() => { selection.cancel() })

    return () => {
      cancelled = true
      selection.cancel()
      selectionAbort.abort()
    }
  }, [activeChatId, activeCharacterId, activeLoomPresetId, activeProfileId, isAuthenticated, fullSettingsLoaded])
}
