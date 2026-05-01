import { useEffect, useRef } from 'react'
import { regexApi } from '@/api/regex'
import { useStore } from '@/store'
import { enqueuePresetRegexOperation } from '@/lib/presetRegexQueue'

export function usePresetRegexActivation() {
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const settingsLoaded = useStore((s) => s.settingsLoaded)
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)
  const previousPresetIdRef = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    if (!isAuthenticated || !settingsLoaded) {
      previousPresetIdRef.current = undefined
      return
    }

    const previousPresetId = previousPresetIdRef.current
    previousPresetIdRef.current = activeLoomPresetId

    if (previousPresetId === undefined) {
      void enqueuePresetRegexOperation(() => regexApi.activatePresetBound(activeLoomPresetId)).catch(() => {})
      return
    }

    if (previousPresetId === activeLoomPresetId) return
    void enqueuePresetRegexOperation(() => regexApi.switchPresetBound(previousPresetId, activeLoomPresetId)).catch(() => {})
  }, [activeLoomPresetId, isAuthenticated, settingsLoaded])
}
