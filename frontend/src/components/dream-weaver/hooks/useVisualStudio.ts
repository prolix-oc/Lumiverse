import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  dreamWeaverApi,
  normalizeDraftVisualAssets,
  type DreamWeaverDraft,
  type DreamWeaverVisualAsset,
  type DreamWeaverVisualJob,
} from '@/api/dream-weaver'
import { ApiError } from '@/api/client'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import type { ImageGenConnectionProfile } from '@/types/api'
import { useStore } from '@/store'
import { useDreamWeaverVisualJob } from '@/hooks/useDreamWeaverVisualJob'
import {
  applySuggestedTagsToPrompt,
  collectPromptMacroTokens,
  getLastSuggestedTags,
  getVisualWorkspaceState,
  resolveSelectedImageConnectionId,
  resolveVisualJobImageReference,
  resolveVisualJobImageUrl,
  resolveVisualReferenceImageUrl,
  type VisualWorkspaceState,
} from '../lib/visual-studio-model'
import { useComfyUIWorkflowConfig } from './useComfyUIWorkflowConfig'

export interface VisualStudioModel {
  draft: DreamWeaverDraft | null
  assets: DreamWeaverVisualAsset[]
  selectedAsset: DreamWeaverVisualAsset | null
  selectedAssetId: string | null
  selectedConnection: ImageGenConnectionProfile | null
  connections: ImageGenConnectionProfile[]
  selectedConnectionId: string | null
  activeJob: DreamWeaverVisualJob | null
  acceptedImageUrl: string | null
  candidateImageUrl: string | null
  workspaceState: VisualWorkspaceState
  canGenerate: boolean
  generating: boolean
  tagSuggestionLoading: boolean
  tagSuggestionError: string | null
  pendingTagSuggestion: string | null
  pendingNegativeTagSuggestion: string | null
  providerSchema: Record<string, any> | null
  providerValues: Record<string, unknown>
  comfyui: ReturnType<typeof useComfyUIWorkflowConfig>
  workflowEditorOpen: boolean
  openWorkflowEditor: () => void
  closeWorkflowEditor: () => void
  onSelectConnection: (connectionId: string | null) => void
  onUpdateAsset: (assetId: string, patch: Partial<DreamWeaverVisualAsset>) => void
  onUploadAssetImage: (assetId: string, file: File) => void
  onGenerate: (assetPatch?: Partial<DreamWeaverVisualAsset>) => void
  onSuggestTags: () => void
  onAcceptSuggestedTags: () => void
  onRegenerateSuggestedTags: () => void
  onCancelSuggestedTags: () => void
  onAcceptResult: () => void
  onDiscardResult: () => void
  onRegenerate: () => void
  updateProviderParam: (key: string, value: unknown) => void
}

function createRandomSeed(): number {
  return Math.floor(Math.random() * 2_147_483_647)
}

export function useVisualStudio(
  sessionId: string,
  draft: DreamWeaverDraft | null,
  onUpdateDraft: (patch: Partial<DreamWeaverDraft>) => void,
): VisualStudioModel {
  const [connections, setConnections] = useState<ImageGenConnectionProfile[]>([])
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null)
  const [assets, setAssets] = useState<DreamWeaverVisualAsset[]>(() =>
    normalizeDraftVisualAssets(draft),
  )
  const [generating, setGenerating] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [workflowEditorOpen, setWorkflowEditorOpen] = useState(false)
  const [tagSuggestionLoading, setTagSuggestionLoading] = useState(false)
  const [tagSuggestionError, setTagSuggestionError] = useState<string | null>(null)
  const [pendingTagSuggestion, setPendingTagSuggestion] = useState<string | null>(null)
  const [pendingNegativeTagSuggestion, setPendingNegativeTagSuggestion] = useState<string | null>(null)

  const assetsRef = useRef(assets)
  assetsRef.current = assets
  const connectionsRef = useRef(connections)
  connectionsRef.current = connections
  const workflowAutoOpenedForConnectionRef = useRef<string | null>(null)

  const imageGenProviders = useStore((s) => s.imageGenProviders)
  const setImageGenProviders = useStore((s) => s.setImageGenProviders)

  const { job: activeJob } = useDreamWeaverVisualJob(activeJobId, !!activeJobId)

  useEffect(() => {
    let cancelled = false
    imageGenConnectionsApi.list({ limit: 100 }).then((result) => {
      if (!cancelled) setConnections(result.data)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Ensure provider capabilities are loaded so parameter schemas are available
  // even if the user hasn't opened ImageGenPanel or the connection manager yet.
  useEffect(() => {
    if (imageGenProviders.length > 0) return
    imageGenConnectionsApi.providers().then((res) => {
      if (res.providers?.length) setImageGenProviders(res.providers)
    }).catch(() => {})
  }, [imageGenProviders.length, setImageGenProviders])

  useEffect(() => {
    if (draft) {
      setAssets(normalizeDraftVisualAssets(draft))
    }
  }, [draft])

  const selectedAsset = assets[0] ?? null
  const selectedAssetId = selectedAsset?.id ?? null
  const selectedConnection =
    connections.find((connection) => connection.id === selectedConnectionId) ?? null
  const provider = selectedConnection?.provider ?? null

  const comfyui = useComfyUIWorkflowConfig(selectedConnectionId, selectedConnection?.provider ?? null)
  const acceptedImageUrl = resolveVisualReferenceImageUrl(selectedAsset?.references[0])
  const candidateImageUrl = resolveVisualJobImageUrl(activeJob)
  const workspaceState = getVisualWorkspaceState({
    provider: provider as any,
    workflowConfig: comfyui.config,
    job: activeJob,
    candidateImageUrl,
  })

  useEffect(() => {
    setTagSuggestionError(null)
    setPendingTagSuggestion(null)
    setPendingNegativeTagSuggestion(null)
  }, [selectedAssetId])

  useEffect(() => {
    const resolvedConnectionId = resolveSelectedImageConnectionId(selectedConnectionId, connections)
    if (resolvedConnectionId !== selectedConnectionId) {
      setSelectedConnectionId(resolvedConnectionId)
    }
  }, [connections, selectedConnectionId])

  useEffect(() => {
    if (selectedConnection?.provider !== 'comfyui') {
      workflowAutoOpenedForConnectionRef.current = null
      setWorkflowEditorOpen(false)
      return
    }

    if (!selectedConnectionId) return
    if (comfyui.loading || !comfyui.configFetched) return
    if (comfyui.config) return
    if (workflowAutoOpenedForConnectionRef.current === selectedConnectionId) return

    workflowAutoOpenedForConnectionRef.current = selectedConnectionId
    setWorkflowEditorOpen(true)
  }, [comfyui.config, comfyui.configFetched, comfyui.loading, selectedConnection?.provider, selectedConnectionId])

  const handleSelectConnection = useCallback(
    (connectionId: string | null) => {
      setSelectedConnectionId(connectionId)

      const nextProvider =
        connectionsRef.current.find((connection) => connection.id === connectionId)?.provider ?? null

      setAssets((prev) => {
        const [firstAsset, ...rest] = prev
        if (!firstAsset) return prev

        const nextAssets = [
          {
            ...firstAsset,
            provider: nextProvider as any,
          },
          ...rest,
        ]

        if (draft) {
          onUpdateDraft({ visual_assets: nextAssets } as any)
        }

        return nextAssets
      })
    },
    [draft, onUpdateDraft],
  )

  const handleUpdateAsset = useCallback(
    (assetId: string, patch: Partial<DreamWeaverVisualAsset>) => {
      setAssets((prev) => {
        const next = prev.map((asset) => (asset.id === assetId ? { ...asset, ...patch } : asset))
        if (draft) {
          onUpdateDraft({ visual_assets: next } as any)
        }
        return next
      })
    },
    [draft, onUpdateDraft],
  )

  const handleUploadAssetImage = useCallback(
    (_assetId: string, _file: File) => {
      // Image upload will be wired to the images API in a later pass.
    },
    [],
  )

  const handleGenerate = useCallback(
    async (assetPatch?: Partial<DreamWeaverVisualAsset>) => {
      const asset = assetsRef.current[0]
      const connection =
        connectionsRef.current.find((item) => item.id === selectedConnectionId) ?? null
      if (!asset || !selectedConnectionId || !sessionId || !connection) return

      const shouldRegenerateSeed =
        connection.provider === 'comfyui' &&
        assetPatch?.seed === undefined &&
        Boolean(asset.references[0] || activeJob?.result)

      const preparedAsset: DreamWeaverVisualAsset = {
        ...asset,
        ...assetPatch,
        provider: connection.provider as any,
        ...(shouldRegenerateSeed ? { seed: createRandomSeed() } : {}),
      }

      setAssets((prev) => {
        const [firstAsset, ...rest] = prev
        if (!firstAsset) return prev
        const nextAssets = [preparedAsset, ...rest]
        if (draft) {
          onUpdateDraft({ visual_assets: nextAssets } as any)
        }
        return nextAssets
      })

      setGenerating(true)
      try {
        const job = await dreamWeaverApi.startVisualJob(sessionId, preparedAsset, selectedConnectionId)
        setActiveJobId(job.id)
      } catch (error) {
        console.error('Failed to start visual job', error)
      } finally {
        setGenerating(false)
      }
    },
    [activeJob?.result, draft, onUpdateDraft, selectedConnectionId, sessionId],
  )

  const handleSuggestTags = useCallback(async () => {
    if (!draft || !sessionId) return

    setTagSuggestionLoading(true)
    setTagSuggestionError(null)
    try {
      const result = await dreamWeaverApi.suggestVisualTags(sessionId, draft)
      setPendingTagSuggestion(result.suggestedTags)
      setPendingNegativeTagSuggestion(result.suggestedNegativeTags || null)
    } catch (error) {
      let message = 'Failed to suggest tags.'
      if (error instanceof ApiError && error.body?.error) {
        message = error.body.error
      } else if (error instanceof Error) {
        message = error.message
      }
      setTagSuggestionError(message)
    } finally {
      setTagSuggestionLoading(false)
    }
  }, [draft, sessionId])

  const handleAcceptSuggestedTags = useCallback(() => {
    const asset = assetsRef.current[0]
    const suggestion = pendingTagSuggestion?.trim()
    if (!asset || !suggestion) return

    const previousSuggestion = getLastSuggestedTags(asset)
    const nextPrompt = applySuggestedTagsToPrompt(asset.prompt, suggestion, previousSuggestion)

    const negSuggestion = pendingNegativeTagSuggestion?.trim() ?? null
    const previousNegSuggestion =
      typeof asset.provider_state?.tag_suggester?.lastSuggestedNegativeTags === 'string'
        ? asset.provider_state.tag_suggester.lastSuggestedNegativeTags
        : null
    const nextNegativePrompt = negSuggestion
      ? applySuggestedTagsToPrompt(asset.negative_prompt ?? '', negSuggestion, previousNegSuggestion)
      : asset.negative_prompt

    handleUpdateAsset(asset.id, {
      prompt: nextPrompt,
      negative_prompt: nextNegativePrompt,
      macro_tokens: collectPromptMacroTokens(nextPrompt),
      provider_state: {
        ...asset.provider_state,
        tag_suggester: {
          ...(asset.provider_state?.tag_suggester ?? {}),
          lastSuggestedTags: suggestion,
          ...(negSuggestion ? { lastSuggestedNegativeTags: negSuggestion } : {}),
        },
      },
    })
    setPendingTagSuggestion(null)
    setPendingNegativeTagSuggestion(null)
    setTagSuggestionError(null)
  }, [handleUpdateAsset, pendingNegativeTagSuggestion, pendingTagSuggestion])

  const handleCancelSuggestedTags = useCallback(() => {
    setPendingTagSuggestion(null)
    setPendingNegativeTagSuggestion(null)
    setTagSuggestionError(null)
  }, [])

  const handleRegenerateSuggestedTags = useCallback(() => {
    void handleSuggestTags()
  }, [handleSuggestTags])

  const handleAcceptResult = useCallback(
    () => {
      const asset = assetsRef.current[0]
      const acceptedReference = resolveVisualJobImageReference(activeJob)
      if (!asset || !acceptedReference) return

      handleUpdateAsset(asset.id, {
        references: [{ id: `${asset.id}-accepted`, ...acceptedReference }],
      })
      setActiveJobId(null)
    },
    [activeJob, handleUpdateAsset],
  )

  const handleDiscardResult = useCallback(() => {
    setActiveJobId(null)
  }, [])

  const handleRegenerate = useCallback(() => {
    setActiveJobId(null)
    void handleGenerate({ seed: createRandomSeed() })
  }, [handleGenerate])

  const updateProviderParam = useCallback(
    (key: string, value: unknown) => {
      const asset = assetsRef.current[0]
      if (!asset) return

      handleUpdateAsset(asset.id, {
        provider_state: {
          ...asset.provider_state,
          params: {
            ...(asset.provider_state?.params ?? {}),
            [key]: value,
          },
        },
      })
    },
    [handleUpdateAsset],
  )

  const isGenerating =
    generating || activeJob?.status === 'running' || activeJob?.status === 'queued'

  // Prefer schema stored on the connection (e.g. ComfyUI capabilities snapshot).
  // Fall back to the live provider capabilities from the registry so that
  // providers like SwarmUI which don't store schema in metadata still surface
  // their parameter controls.
  const providerSchema = useMemo(() => {
    const fromMetadata = selectedConnection?.metadata?.parameter_schema as Record<string, any> | undefined
    if (fromMetadata && Object.keys(fromMetadata).length > 0) return fromMetadata
    if (!selectedConnection?.provider) return null
    const providerInfo = imageGenProviders.find((p) => p.id === selectedConnection.provider)
    const params = providerInfo?.capabilities?.parameters
    if (!params || Object.keys(params).length === 0) return null
    return params
  }, [selectedConnection, imageGenProviders])
  const providerValues = (selectedAsset?.provider_state?.params ??
    selectedConnection?.default_parameters ??
    {}) as Record<string, unknown>
  const canGenerate = workspaceState === 'ready' || workspaceState === 'candidate_ready'

  return useMemo(
    () => ({
      draft,
      assets,
      selectedAsset,
      selectedAssetId,
      selectedConnection,
      connections,
      selectedConnectionId,
      activeJob: activeJob ?? null,
      acceptedImageUrl,
      candidateImageUrl,
      workspaceState,
      canGenerate,
      generating: !!isGenerating,
      tagSuggestionLoading,
      tagSuggestionError,
      pendingTagSuggestion,
      pendingNegativeTagSuggestion,
      providerSchema,
      providerValues,
      comfyui,
      workflowEditorOpen,
      openWorkflowEditor: () => setWorkflowEditorOpen(true),
      closeWorkflowEditor: () => setWorkflowEditorOpen(false),
      onSelectConnection: handleSelectConnection,
      onUpdateAsset: handleUpdateAsset,
      onUploadAssetImage: handleUploadAssetImage,
      onGenerate: handleGenerate,
      onSuggestTags: handleSuggestTags,
      onAcceptSuggestedTags: handleAcceptSuggestedTags,
      onRegenerateSuggestedTags: handleRegenerateSuggestedTags,
      onCancelSuggestedTags: handleCancelSuggestedTags,
      onAcceptResult: handleAcceptResult,
      onDiscardResult: handleDiscardResult,
      onRegenerate: handleRegenerate,
      updateProviderParam,
    }),
    [
      acceptedImageUrl,
      activeJob,
      assets,
      canGenerate,
      candidateImageUrl,
      comfyui,
      connections,
      draft,
      handleAcceptResult,
      handleDiscardResult,
      handleGenerate,
      handleRegenerate,
      handleSelectConnection,
      handleUpdateAsset,
      handleUploadAssetImage,
      isGenerating,
      providerSchema,
      providerValues,
      selectedAsset,
      selectedAssetId,
      selectedConnection,
      selectedConnectionId,
      tagSuggestionError,
      tagSuggestionLoading,
      pendingTagSuggestion,
      pendingNegativeTagSuggestion,
      updateProviderParam,
      workflowEditorOpen,
      workspaceState,
    ],
  )
}
