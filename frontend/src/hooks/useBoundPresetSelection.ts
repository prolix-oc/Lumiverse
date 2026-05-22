import { useEffect } from 'react'
import { presetProfilesApi } from '@/api/preset-profiles'
import { useStore } from '@/store'

export function useBoundPresetSelection() {
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const settingsLoaded = useStore((s) => s.settingsLoaded)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const setActiveLoomPreset = useStore((s) => s.setActiveLoomPreset)

  useEffect(() => {
    if (!isAuthenticated || !settingsLoaded || !activeChatId) return

    let cancelled = false
    const fallbackPresetId = useStore.getState().activeLoomPresetId

    presetProfilesApi.resolve(activeChatId, fallbackPresetId, activeProfileId)
      .then((resolved) => {
        if (cancelled) return
        if (resolved.source !== 'chat' && resolved.source !== 'character' && resolved.source !== 'connection') return
        if (!resolved.preset_id) return
        if (useStore.getState().activeChatId !== activeChatId) return
        if (useStore.getState().activeLoomPresetId === resolved.preset_id) return
        setActiveLoomPreset(resolved.preset_id)
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [activeChatId, activeCharacterId, activeProfileId, isAuthenticated, settingsLoaded, setActiveLoomPreset])
}
