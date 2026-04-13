import { useEffect, useState, useCallback } from 'react'
import { dreamWeaverApi } from '@/api/dream-weaver'
import type { ComfyUICapabilities } from '@/api/image-gen'

interface UseComfyUICapabilitiesResult {
  capabilities: ComfyUICapabilities | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useComfyUICapabilities(
  connectionId: string | null,
  provider: string | null,
): UseComfyUICapabilitiesResult {
  const [capabilities, setCapabilities] = useState<ComfyUICapabilities | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchCapabilities = useCallback(
    async (forceRefresh = false) => {
      if (!connectionId || provider !== 'comfyui') {
        setCapabilities(null)
        setError(null)
        return
      }

      setLoading(true)
      setError(null)
      try {
        const caps = await dreamWeaverApi.getComfyUICapabilities(connectionId, forceRefresh)
        setCapabilities(caps)
      } catch (err: any) {
        setError(err?.message ?? 'Failed to connect to ComfyUI server')
        setCapabilities(null)
      } finally {
        setLoading(false)
      }
    },
    [connectionId, provider],
  )

  useEffect(() => {
    void fetchCapabilities()
  }, [fetchCapabilities])

  const refresh = useCallback(() => fetchCapabilities(true), [fetchCapabilities])

  return { capabilities, loading, error, refresh }
}
