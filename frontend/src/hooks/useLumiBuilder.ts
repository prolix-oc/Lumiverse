import { useState, useEffect, useCallback } from 'react'
import { useStore } from '@/store'
import { presetsApi } from '@/api/presets'
import { lumiApi } from '@/api/lumi'
import type { Preset, LumiPresetMetadata, LumiPipeline, LumiModule, LumiSidecarConfig, BlockGroupConfig } from '@/types/api'
import { generateUUID } from '@/lib/uuid'

const DEFAULT_SIDECAR: LumiSidecarConfig = {
  connectionProfileId: null,
  model: null,
  temperature: 0.7,
  topP: 0.9,
  maxTokensPerModule: 2048,
  contextWindow: 8192,
}

const DEFAULT_LUMI_METADATA: LumiPresetMetadata = {
  pipelines: [],
  sidecar: { ...DEFAULT_SIDECAR },
}

const DEFAULT_SAMPLER_OVERRIDES = {
  enabled: true,
  maxTokens: 16384,
  contextSize: null,
  temperature: 1.0,
  topP: 0.95,
  minP: null,
  topK: null,
  frequencyPenalty: null,
  presencePenalty: null,
  repetitionPenalty: null,
}

const DEFAULT_PROMPT_BEHAVIOR = {
  continueNudge: '',
  impersonationPrompt: '',
  groupNudge: '',
  newChatPrompt: '',
  newGroupChatPrompt: '',
  sendIfEmpty: '',
}

const DEFAULT_COMPLETION_SETTINGS = {
  assistantPrefill: '',
  assistantImpersonation: '',
  continuePrefill: false,
  continuePostfix: '',
  namesBehavior: 0,
  squashSystemMessages: false,
  useSystemPrompt: false,
  enableWebSearch: false,
  sendInlineMedia: false,
  enableFunctionCalling: false,
  includeUsage: false,
}

export interface LumiRegistryEntry {
  id: string
  name: string
  provider: string
  updatedAt: number
}

export function useLumiBuilder() {
  const [activePreset, setActivePreset] = useState<Preset | null>(null)
  const [registry, setRegistry] = useState<LumiRegistryEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Use the store for active Lumi preset ID — this feeds getActivePresetForGeneration()
  const activePresetId = useStore((s) => s.activeLumiPresetId)
  const setActiveLumiPreset = useStore((s) => s.setActiveLumiPreset)

  const setActivePresetId = useCallback((id: string | null) => {
    setActiveLumiPreset(id)
  }, [setActiveLumiPreset])

  // Load actve preset when ID changes
  useEffect(() => {
    if (!activePresetId) {
      setActivePreset(null)
      return
    }
    if (activePreset?.id === activePresetId) return

    let cancelled = false
    setIsLoading(true)
    presetsApi.get(activePresetId)
      .then((preset) => {
        if (!cancelled) {
          setActivePreset(preset)
          setIsLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[LumiBuilder] Failed to load preset:', err)
          setError(err.message)
          setIsLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [activePresetId, activePreset?.id])

  // Refresh registry filter by engine, not provider
  const refreshRegistry = useCallback(async () => {
    try {
      const result = await presetsApi.listRegistry({ engine: 'lumi', limit: 200 })
      setRegistry(result.data.map((p) => ({
        id: p.id,
        name: p.name,
        provider: p.provider,
        updatedAt: p.updated_at,
      })))
    } catch (err) {
      console.warn('[LumiBuilder] Failed to refresh registry:', err)
    }
  }, [])

  useEffect(() => {
    refreshRegistry()
  }, [refreshRegistry])

  // Derived metadata
  const metadata: LumiPresetMetadata = (activePreset?.metadata as LumiPresetMetadata | undefined)?.pipelines
    ? activePreset!.metadata as LumiPresetMetadata
    : DEFAULT_LUMI_METADATA

  // Derived prompt data
  const promptOrder = activePreset?.prompt_order ?? []
  const prompts = activePreset?.prompts ?? {}
  const parameters = activePreset?.parameters ?? {}
  const samplerOverrides = parameters.samplerOverrides ?? DEFAULT_SAMPLER_OVERRIDES
  const promptBehavior = prompts.promptBehavior ?? DEFAULT_PROMPT_BEHAVIOR
  const completionSettings = prompts.completionSettings ?? DEFAULT_COMPLETION_SETTINGS


  const savePreset = useCallback(async (updates: Partial<{ metadata: any; prompt_order: any; prompts: any; parameters: any; name: any; provider: any }>) => {
    if (!activePreset) return
    const updated = { ...activePreset, ...updates }
    setActivePreset(updated)
    try {
      await presetsApi.update(activePreset.id, updates)
      refreshRegistry()
    } catch (err) {
      console.error('[LumiBuilder] Failed to save:', err)
    }
  }, [activePreset, refreshRegistry])

  const saveMetadata = useCallback(async (updates: Partial<LumiPresetMetadata>) => {
    if (!activePreset) return
    const newMetadata = { ...activePreset.metadata, ...updates }
    savePreset({ metadata: newMetadata })
  }, [activePreset, savePreset])

  const addPipeline = useCallback((name: string) => {
    const pipeline: LumiPipeline = {
      key: generateUUID(),
      name,
      enabled: true,
      modules: [],
    }
    saveMetadata({ pipelines: [...metadata.pipelines, pipeline] })
  }, [metadata.pipelines, saveMetadata])

  const removePipeline = useCallback((key: string) => {
    saveMetadata({ pipelines: metadata.pipelines.filter((p) => p.key !== key) })
  }, [metadata.pipelines, saveMetadata])

  const togglePipeline = useCallback((key: string) => {
    saveMetadata({
      pipelines: metadata.pipelines.map((p) =>
        p.key === key ? { ...p, enabled: !p.enabled } : p
      ),
    })
  }, [metadata.pipelines, saveMetadata])

  const updatePipeline = useCallback((key: string, updates: Partial<LumiPipeline>) => {
    saveMetadata({
      pipelines: metadata.pipelines.map((p) =>
        p.key === key ? { ...p, ...updates } : p
      ),
    })
  }, [metadata.pipelines, saveMetadata])

  const addModule = useCallback((pipelineKey: string) => {
    const mod: LumiModule = {
      key: generateUUID(),
      name: 'New Module',
      enabled: true,
      prompt: '',
    }
    saveMetadata({
      pipelines: metadata.pipelines.map((p) =>
        p.key === pipelineKey
          ? { ...p, modules: [...p.modules, mod] }
          : p
      ),
    })
  }, [metadata.pipelines, saveMetadata])

  const removeModule = useCallback((pipelineKey: string, moduleKey: string) => {
    saveMetadata({
      pipelines: metadata.pipelines.map((p) =>
        p.key === pipelineKey
          ? { ...p, modules: p.modules.filter((m) => m.key !== moduleKey) }
          : p
      ),
    })
  }, [metadata.pipelines, saveMetadata])

  const updateModule = useCallback((pipelineKey: string, moduleKey: string, updates: Partial<LumiModule>) => {
    saveMetadata({
      pipelines: metadata.pipelines.map((p) =>
        p.key === pipelineKey
          ? { ...p, modules: p.modules.map((m) => m.key === moduleKey ? { ...m, ...updates } : m) }
          : p
      ),
    })
  }, [metadata.pipelines, saveMetadata])

  // Sidecar config
  const updateSidecar = useCallback((updates: Partial<LumiSidecarConfig>) => {
    saveMetadata({ sidecar: { ...metadata.sidecar, ...updates } })
  }, [metadata.sidecar, saveMetadata])

  // Prompt blocks (Loom blocks)
  const saveBlocks = useCallback((blocks: any[]) => {
    savePreset({ prompt_order: blocks })
  }, [savePreset])

  const addBlock = useCallback((group: string | null = null) => {
    const block = {
      id: generateUUID(),
      name: 'New Block',
      content: '',
      role: 'system',
      enabled: true,
      position: 'pre_history',
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
      group,
    }
    saveBlocks([...promptOrder, block])
  }, [promptOrder, saveBlocks])

  const updateBlock = useCallback((blockId: string, updates: Record<string, any>) => {
    saveBlocks(promptOrder.map((b: any) =>
      b.id === blockId ? { ...b, ...updates } : b
    ))
  }, [promptOrder, saveBlocks])

  const removeBlock = useCallback((blockId: string) => {
    const block = promptOrder.find((b: any) => b.id === blockId)
    if (block?.isLocked) return
    saveBlocks(promptOrder.filter((b: any) => b.id !== blockId))
  }, [promptOrder, saveBlocks])

  const moveBlock = useCallback((blockId: string, direction: 'up' | 'down') => {
    const idx = promptOrder.findIndex((b: any) => b.id === blockId)
    if (idx < 0) return
    const newIdx = direction === 'up' ? idx - 1 : idx + 1
    if (newIdx < 0 || newIdx >= promptOrder.length) return
    const copy = [...promptOrder]
    ;[copy[idx], copy[newIdx]] = [copy[newIdx], copy[idx]]
    saveBlocks(copy)
  }, [promptOrder, saveBlocks])

  //  Block Group CRUD
  const blockGroups = metadata.blockGroups ?? []

  const createBlockGroup = useCallback((name: string, mode: 'radio' | 'checkbox') => {
    const maxOrder = blockGroups.reduce((max, g) => Math.max(max, g.order), 0)
    const group: BlockGroupConfig = { name, mode, order: maxOrder + 1 }
    saveMetadata({ blockGroups: [...blockGroups, group] })
  }, [blockGroups, saveMetadata])

  const renameBlockGroup = useCallback((oldName: string, newName: string) => {
    const updated = blockGroups.map((g) =>
      g.name === oldName ? { ...g, name: newName } : g
    )
    saveMetadata({ blockGroups: updated })
    const updatedBlocks = promptOrder.map((b: any) =>
      b.group === oldName ? { ...b, group: newName } : b
    )
    saveBlocks(updatedBlocks)
  }, [blockGroups, promptOrder, saveMetadata, saveBlocks])

  const deleteBlockGroup = useCallback((name: string) => {
    saveMetadata({ blockGroups: blockGroups.filter((g) => g.name !== name) })
    const updatedBlocks = promptOrder.map((b: any) =>
      b.group === name ? { ...b, group: null } : b
    )
    saveBlocks(updatedBlocks)
  }, [blockGroups, promptOrder, saveMetadata, saveBlocks])

  const reorderBlockGroups = useCallback((groups: BlockGroupConfig[]) => {
    saveMetadata({ blockGroups: groups })
  }, [saveMetadata])

  const setBlockGroup = useCallback((blockId: string, group: string | null) => {
    saveBlocks(promptOrder.map((b: any) =>
      b.id === blockId ? { ...b, group } : b
    ))
  }, [promptOrder, saveBlocks])

  const toggleBlockInRadioGroup = useCallback((blockId: string) => {
    const block = promptOrder.find((b: any) => b.id === blockId)
    if (!block || !block.group) return
    const groupConfig = blockGroups.find((g) => g.name === block.group)
    if (!groupConfig || groupConfig.mode !== 'radio') {
      saveBlocks(promptOrder.map((b: any) =>
        b.id === blockId ? { ...b, enabled: !b.enabled } : b
      ))
      return
    }
    saveBlocks(promptOrder.map((b: any) => {
      if (b.id === blockId) return { ...b, enabled: true }
      if (b.group === block.group) return { ...b, enabled: false }
      return b
    }))
  }, [promptOrder, blockGroups, saveBlocks])

  const updateBlockGroupConfig = useCallback((name: string, updates: Partial<BlockGroupConfig>) => {
    saveMetadata({
      blockGroups: blockGroups.map((g) =>
        g.name === name ? { ...g, ...updates } : g
      ),
    })
  }, [blockGroups, saveMetadata])

  const saveSamplerOverrides = useCallback((overrides: any) => {
    savePreset({ parameters: { ...parameters, samplerOverrides: overrides } })
  }, [parameters, savePreset])

  const savePromptBehavior = useCallback((updates: Record<string, any>) => {
    savePreset({ prompts: { ...prompts, promptBehavior: { ...promptBehavior, ...updates } } })
  }, [prompts, promptBehavior, savePreset])

  const saveCompletionSettings = useCallback((updates: Record<string, any>) => {
    savePreset({ prompts: { ...prompts, completionSettings: { ...completionSettings, ...updates } } })
  }, [prompts, completionSettings, savePreset])

  const createPreset = useCallback(async (name: string, provider: string) => {
    setIsLoading(true)
    try {
      const preset = await presetsApi.create({
        name,
        provider,
        metadata: DEFAULT_LUMI_METADATA,
      })
      const updated = await presetsApi.update(preset.id, { engine: 'lumi' } as any)
      await refreshRegistry()
      setActivePresetId(updated.id)
      setActivePreset(updated)
      return updated
    } catch (err: any) {
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [refreshRegistry, setActivePresetId])

  const selectPreset = useCallback((id: string | null) => {
    setActivePresetId(id)
  }, [setActivePresetId])

  const deletePreset = useCallback(async (id: string) => {
    await presetsApi.delete(id)
    await refreshRegistry()
    if (id === activePresetId) {
      setActivePresetId(null)
      setActivePreset(null)
    }
  }, [activePresetId, refreshRegistry, setActivePresetId])

  const duplicatePreset = useCallback(async (id: string, newName: string) => {
    setIsLoading(true)
    try {
      const original = await presetsApi.get(id)
      const copy = await presetsApi.create({
        name: newName,
        provider: original.provider,
        parameters: original.parameters,
        prompts: original.prompts,
        prompt_order: original.prompt_order,
        metadata: JSON.parse(JSON.stringify(original.metadata)),
      })
      // Set engine to lumi
      const updated = await presetsApi.update(copy.id, { engine: 'lumi' } as any)
      await refreshRegistry()
      setActivePresetId(updated.id)
      setActivePreset(updated)
      return updated
    } catch (err: any) {
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [refreshRegistry, setActivePresetId])

  // Import/Export
  const importLumiFile = useCallback(async (data: any) => {
    setIsLoading(true)
    try {
      const preset = await lumiApi.importLumiFile(data)
      await refreshRegistry()
      setActivePresetId(preset.id)
      setActivePreset(preset)
      return preset
    } catch (err: any) {
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [refreshRegistry, setActivePresetId])

  const exportLumiFile = useCallback(async () => {
    if (!activePresetId) return null
    return lumiApi.exportLumiFile(activePresetId)
  }, [activePresetId])

  return {
    registry,
    activePresetId,
    activePreset,
    metadata,
    // Prompt blocks
    promptOrder,
    prompts,
    parameters,
    samplerOverrides,
    promptBehavior,
    completionSettings,
    // Loading state
    isLoading,
    error,
    refreshRegistry,
    // Metadata (pipelines + sidecar)
    saveMetadata,
    addPipeline,
    removePipeline,
    togglePipeline,
    updatePipeline,
    addModule,
    removeModule,
    updateModule,
    updateSidecar,
    // Blocks
    saveBlocks,
    addBlock,
    updateBlock,
    removeBlock,
    moveBlock,
    // Block Groups
    blockGroups,
    createBlockGroup,
    renameBlockGroup,
    deleteBlockGroup,
    reorderBlockGroups,
    setBlockGroup,
    toggleBlockInRadioGroup,
    updateBlockGroupConfig,
    // Samplers & behavior
    saveSamplerOverrides,
    savePromptBehavior,
    saveCompletionSettings,
    // Preset CRUD
    createPreset,
    selectPreset,
    deletePreset,
    duplicatePreset,
    savePreset,
    // Import/Export
    importLumiFile,
    exportLumiFile,
  }
}
