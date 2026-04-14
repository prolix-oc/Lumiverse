import { useCallback, useEffect, useState } from 'react'
import {
  dreamWeaverApi,
  type ComfyUIFieldMapping,
  type ComfyUIWorkflowConfig,
} from '@/api/dream-weaver'
import { useComfyUICapabilities } from './useComfyUICapabilities'

interface UseComfyUIWorkflowConfigResult {
  config: ComfyUIWorkflowConfig | null
  capabilities: ReturnType<typeof useComfyUICapabilities>['capabilities']
  loading: boolean
  configFetched: boolean
  error: string | null
  importWorkflow: (workflow: unknown) => Promise<ComfyUIWorkflowConfig | null>
  updateMappings: (mappings: ComfyUIFieldMapping[]) => Promise<ComfyUIWorkflowConfig | null>
  refresh: () => Promise<void>
}

export function useComfyUIWorkflowConfig(
  connectionId: string | null,
  provider: string | null,
): UseComfyUIWorkflowConfigResult {
  const {
    capabilities,
    loading: capabilitiesLoading,
    error: capabilitiesError,
    refresh: refreshCapabilities,
  } = useComfyUICapabilities(connectionId, provider)

  const [config, setConfig] = useState<ComfyUIWorkflowConfig | null>(null)
  const [workflowLoading, setWorkflowLoading] = useState(false)
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  const [configFetched, setConfigFetched] = useState(false)

  const fetchWorkflowConfig = useCallback(async () => {
    if (!connectionId || provider !== 'comfyui') {
      setConfig(null)
      setWorkflowError(null)
      return
    }

    setWorkflowLoading(true)
    try {
      const response = await dreamWeaverApi.getComfyUIWorkflowConfig(connectionId)
      setConfig(response.config)
      setWorkflowError(null)
    } catch (error: any) {
      setConfig(null)
      setWorkflowError(error?.message ?? 'Failed to load ComfyUI workflow')
    } finally {
      setWorkflowLoading(false)
      setConfigFetched(true)
    }
  }, [connectionId, provider])

  useEffect(() => {
    void fetchWorkflowConfig()
  }, [fetchWorkflowConfig])

  const importWorkflow = useCallback(
    async (workflow: unknown) => {
      if (!connectionId) return null
      setWorkflowLoading(true)
      try {
        const response = await dreamWeaverApi.importComfyUIWorkflow(connectionId, workflow)
        setConfig(response.config)
        setWorkflowError(null)
        return response.config
      } catch (error: any) {
        setWorkflowError(error?.message ?? 'Failed to import ComfyUI workflow')
        throw error
      } finally {
        setWorkflowLoading(false)
      }
    },
    [connectionId],
  )

  const updateMappings = useCallback(
    async (mappings: ComfyUIFieldMapping[]) => {
      if (!connectionId) return null
      setWorkflowLoading(true)
      try {
        const response = await dreamWeaverApi.updateComfyUIWorkflowMappings(connectionId, mappings)
        setConfig(response.config)
        setWorkflowError(null)
        return response.config
      } catch (error: any) {
        setWorkflowError(error?.message ?? 'Failed to update ComfyUI workflow mappings')
        throw error
      } finally {
        setWorkflowLoading(false)
      }
    },
    [connectionId],
  )

  const refresh = useCallback(async () => {
    await Promise.all([fetchWorkflowConfig(), refreshCapabilities()])
  }, [fetchWorkflowConfig, refreshCapabilities])

  return {
    config,
    capabilities,
    loading: workflowLoading || capabilitiesLoading,
    configFetched,
    error: workflowError ?? capabilitiesError,
    importWorkflow,
    updateMappings,
    refresh,
  }
}
