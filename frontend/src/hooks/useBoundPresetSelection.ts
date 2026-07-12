import { useEffect } from 'react'
import { presetProfilesApi } from '@/api/preset-profiles'
import { useStore } from '@/store'
import { transitionActiveLoomPreset } from '@/lib/loom/preset-selection-coordinator'

export function useBoundPresetSelection() {
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const settingsLoaded = useStore((s) => s.settingsLoaded)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)

  useEffect(() => {
    if (!isAuthenticated || !settingsLoaded || !activeChatId) return

    let cancelled = false
    const selectionAbort = new AbortController()
    const fallbackPresetId = useStore.getState().activeLoomPresetId

    presetProfilesApi.resolve(activeChatId, fallbackPresetId, activeProfileId)
      .then((resolved) => {
        if (cancelled) return
        if (resolved.source !== 'chat' && resolved.source !== 'character' && resolved.source !== 'connection') return
        if (!resolved.preset_id) return
        if (useStore.getState().activeChatId !== activeChatId) return
        if (activeLoomPresetId === resolved.preset_id) return
        void transitionActiveLoomPreset(resolved.preset_id, { signal: selectionAbort.signal }).catch(() => {})
      })
      .catch(() => {})

    return () => {
      cancelled = true
      selectionAbort.abort()
    }
  }, [activeChatId, activeCharacterId, activeLoomPresetId, activeProfileId, isAuthenticated, settingsLoaded])
}
