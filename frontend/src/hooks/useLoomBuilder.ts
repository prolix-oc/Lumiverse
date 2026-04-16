import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useStore } from '@/store'
import { presetsApi } from '@/api/presets'
import { regexApi } from '@/api/regex'
import { toast } from '@/lib/toast'
import { getMacroCatalog } from '@/api/macros'
import type { LoomPreset, PromptBlock, LoomConnectionProfile, MacroGroup } from '@/lib/loom/types'
import {
  DEFAULT_SAMPLER_OVERRIDES,
  DEFAULT_CUSTOM_BODY,
  DEFAULT_PROMPT_BEHAVIOR,
  DEFAULT_COMPLETION_SETTINGS,
  DEFAULT_ADVANCED_SETTINGS,
  SAMPLER_PARAMS,
} from '@/lib/loom/constants'
import { generateUUID } from '@/lib/uuid'
import {
  createNewLoomPreset,
  marshalPreset,
  marshalUpdate,
  unmarshalPreset,
  detectSupportedParams,
  getAvailableMacros,
  importFromSTPreset,
  exportToSTPreset,
  normalizeCategoryBlockState,
  toggleBlockWithCategoryRules,
} from '@/lib/loom/service'

export function useLoomBuilder() {
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)
  const loomRegistry = useStore((s) => s.loomRegistry)
  const setActiveLoomPreset = useStore((s) => s.setActiveLoomPreset)
  const setLoomRegistry = useStore((s) => s.setLoomRegistry)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const profiles = useStore((s) => s.profiles)

  const [activePreset, setActivePreset] = useState<LoomPreset | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load active preset when activeLoomPresetId changes
  useEffect(() => {
    if (!activeLoomPresetId) {
      setActivePreset(null)
      return
    }
    if (activePreset?.id === activeLoomPresetId) {
      return
    }
    let cancelled = false
    setIsLoading(true)
    presetsApi.get(activeLoomPresetId).then((preset) => {
      if (!cancelled) {
        setActivePreset(unmarshalPreset(preset))
        setIsLoading(false)
      }
    }).catch((err) => {
      if (!cancelled) {
        console.warn('[LoomBuilder] Failed to load preset:', err)
        setError(err.message)
        setIsLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [activeLoomPresetId, activePreset?.id])

  // Refresh registry from API
  const refreshRegistry = useCallback(async () => {
    try {
      const result = await presetsApi.listRegistry({ provider: 'loom', limit: 200 })
      const registry = Object.fromEntries(
        result.data.map((p) => [
          p.id,
          {
            name: p.name,
            blockCount: p.block_count,
            updatedAt: p.updated_at,
            isDefault: false,
          },
        ])
      )
      setLoomRegistry(registry)
    } catch (err) {
      console.warn('[LoomBuilder] Failed to refresh registry:', err)
    }
  }, [setLoomRegistry])

  // Load registry on mount
  useEffect(() => {
    refreshRegistry()
  }, [refreshRegistry])

  // Create a new preset
  const createPreset = useCallback(async (name: string, description?: string) => {
    setIsLoading(true)
    try {
      const loom = createNewLoomPreset(name, description)
      const created = await presetsApi.create(marshalPreset(loom))
      const newLoom = unmarshalPreset(created)
      await refreshRegistry()
      setActiveLoomPreset(created.id)
      setActivePreset(newLoom)
      return newLoom
    } catch (err: any) {
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [refreshRegistry, setActiveLoomPreset])

  // Load and activate a preset by ID
  const selectPreset = useCallback(async (presetId: string | null) => {
    if (!presetId) {
      setActiveLoomPreset(null)
      setActivePreset(null)
      return
    }
    setActiveLoomPreset(presetId)
  }, [setActiveLoomPreset])

  // Debounced preset save
  const pendingSaveRef = useRef<LoomPreset | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const debouncedSavePreset = useCallback((preset: LoomPreset) => {
    pendingSaveRef.current = preset
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      const toSave = pendingSaveRef.current
      if (toSave) {
        pendingSaveRef.current = null
        try {
          await presetsApi.update(toSave.id, marshalUpdate(toSave))
        } catch (err) {
          console.warn('[LoomBuilder] Debounced save failed:', err)
        }
      }
    }, 400)
  }, [])

  // Flush pending save on unmount
  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    if (pendingSaveRef.current) {
      presetsApi.update(pendingSaveRef.current.id, marshalUpdate(pendingSaveRef.current)).catch(() => {})
    }
  }, [])

  const saveStructure = useCallback(async (
    blocks: PromptBlock[],
  ) => {
    if (!activePreset) return
    const normalizedBlocks = normalizeCategoryBlockState(blocks)
    const updated = {
      ...activePreset,
      blocks: normalizedBlocks,
      updatedAt: Date.now(),
    }
    setActivePreset(updated)
    try {
      await presetsApi.update(updated.id, marshalUpdate(updated))
      refreshRegistry()
    } catch (err) {
      console.warn('[LoomBuilder] Failed to save preset structure:', err)
    }
  }, [activePreset, refreshRegistry])

  // Save blocks
  const saveBlocks = useCallback(async (blocks: PromptBlock[]) => {
    await saveStructure(blocks)
  }, [saveStructure])

  // Rename a preset
  const renamePreset = useCallback(async (presetId: string, newName: string) => {
    await presetsApi.update(presetId, { name: newName })
    await refreshRegistry()
    if (activePreset && presetId === activeLoomPresetId) {
      setActivePreset({ ...activePreset, name: newName })
    }
  }, [activePreset, activeLoomPresetId, refreshRegistry])

  // Delete a preset
  const deletePreset = useCallback(async (presetId: string) => {
    await presetsApi.delete(presetId)
    await refreshRegistry()
    if (presetId === activeLoomPresetId) {
      setActiveLoomPreset(null)
      setActivePreset(null)
    }
  }, [activeLoomPresetId, refreshRegistry, setActiveLoomPreset])

  // Duplicate a preset
  const duplicatePreset = useCallback(async (presetId: string, newName: string) => {
    setIsLoading(true)
    try {
      const original = await presetsApi.get(presetId)
      const loom = unmarshalPreset(original)
      const copy = createNewLoomPreset(newName)
      // Copy all content from original
      copy.blocks = JSON.parse(JSON.stringify(loom.blocks))
      copy.samplerOverrides = { ...loom.samplerOverrides }
      copy.customBody = { ...loom.customBody }
      copy.promptBehavior = { ...loom.promptBehavior }
      copy.completionSettings = { ...loom.completionSettings }
      copy.advancedSettings = { ...loom.advancedSettings }
      copy.modelProfiles = { ...loom.modelProfiles }
      copy.source = loom.source ? { ...loom.source } : null

      const created = await presetsApi.create(marshalPreset(copy))
      const newLoom = unmarshalPreset(created)
      await refreshRegistry()
      setActiveLoomPreset(created.id)
      setActivePreset(newLoom)
      return newLoom
    } catch (err: any) {
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [refreshRegistry, setActiveLoomPreset])

  // Block manipulation helpers
  const addBlock = useCallback((block: PromptBlock, index?: number) => {
    if (!activePreset) return
    const blocks = [...activePreset.blocks]
    if (typeof index === 'number') {
      blocks.splice(index, 0, block)
    } else {
      blocks.push(block)
    }
    saveBlocks(blocks)
  }, [activePreset, saveBlocks])

  const removeBlock = useCallback((blockId: string) => {
    if (!activePreset) return
    const blocks = activePreset.blocks.filter(b => b.id !== blockId)
    saveBlocks(blocks)
  }, [activePreset, saveBlocks])

  const updateBlock = useCallback((blockId: string, updates: Partial<PromptBlock>) => {
    if (!activePreset) return
    const blocks = activePreset.blocks.map(b =>
      b.id === blockId ? { ...b, ...updates } : b
    )
    saveBlocks(blocks)
  }, [activePreset, saveBlocks])

  const toggleBlock = useCallback((blockId: string) => {
    if (!activePreset) return
    const blocks = toggleBlockWithCategoryRules(activePreset.blocks, blockId)
    saveBlocks(blocks)
  }, [activePreset, saveBlocks])

  const reorderBlocks = useCallback((fromIndex: number, toIndex: number) => {
    if (!activePreset) return
    const blocks = [...activePreset.blocks]
    const [moved] = blocks.splice(fromIndex, 1)
    blocks.splice(toIndex, 0, moved)
    saveBlocks(blocks)
  }, [activePreset, saveBlocks])

  // Save sampler overrides — immediate state update, debounced API save
  const saveSamplerOverrides = useCallback((overrides: any) => {
    if (!activePreset) return
    const updated = { ...activePreset, samplerOverrides: { ...overrides }, updatedAt: Date.now() }
    setActivePreset(updated)
    debouncedSavePreset(updated)
  }, [activePreset, debouncedSavePreset])

  const saveCustomBody = useCallback((customBody: any) => {
    if (!activePreset) return
    const updated = { ...activePreset, customBody: { ...customBody }, updatedAt: Date.now() }
    setActivePreset(updated)
    debouncedSavePreset(updated)
  }, [activePreset, debouncedSavePreset])

  const savePromptBehavior = useCallback((updates: Record<string, any>) => {
    if (!activePreset) return
    const updated = {
      ...activePreset,
      promptBehavior: { ...(activePreset.promptBehavior || DEFAULT_PROMPT_BEHAVIOR), ...updates },
      updatedAt: Date.now(),
    }
    setActivePreset(updated)
    debouncedSavePreset(updated)
  }, [activePreset, debouncedSavePreset])

  const saveCompletionSettings = useCallback((updates: Record<string, any>) => {
    if (!activePreset) return
    const updated = {
      ...activePreset,
      completionSettings: { ...(activePreset.completionSettings || DEFAULT_COMPLETION_SETTINGS), ...updates },
      updatedAt: Date.now(),
    }
    setActivePreset(updated)
    debouncedSavePreset(updated)
  }, [activePreset, debouncedSavePreset])

  const saveAdvancedSettings = useCallback((updates: Record<string, any>) => {
    if (!activePreset) return
    const updated = {
      ...activePreset,
      advancedSettings: { ...(activePreset.advancedSettings || DEFAULT_ADVANCED_SETTINGS), ...updates },
      updatedAt: Date.now(),
    }
    setActivePreset(updated)
    debouncedSavePreset(updated)
  }, [activePreset, debouncedSavePreset])

  // Import from legacy preset JSON
  const importFromST = useCallback(async (stData: any, fileName: string) => {
    setIsLoading(true)
    try {
      const name = stData.name || fileName.replace(/\.json$/i, '') || 'Imported Preset'
      const loom = importFromSTPreset(stData, name)
      const created = await presetsApi.create(marshalPreset(loom))
      const newLoom = unmarshalPreset(created)
      await refreshRegistry()
      setActiveLoomPreset(created.id)
      setActivePreset(newLoom)

      // Import embedded regex scripts if present, filed under the preset name
      const embeddedRegex = stData.extensions?.regex_scripts
      if (Array.isArray(embeddedRegex) && embeddedRegex.length > 0) {
        try {
          const regexResult = await regexApi.importScripts({ scripts: embeddedRegex, folder: name, preset_id: created.id })
          if (regexResult.imported > 0) {
            const { loadRegexScripts } = useStore.getState() as any
            if (loadRegexScripts) await loadRegexScripts()
            toast.success(`Imported ${regexResult.imported} regex script${regexResult.imported !== 1 ? 's' : ''} from preset`)
          }
          if (regexResult.errors.length > 0) {
            toast.error(`${regexResult.errors.length} regex script${regexResult.errors.length !== 1 ? 's' : ''} failed to import`)
          }
        } catch { /* regex import is best-effort */ }
      }

      return newLoom
    } catch (err: any) {
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [refreshRegistry, setActiveLoomPreset])

  // Import from file (internal JSON format)
  const importFromFile = useCallback(async (jsonData: any) => {
    setIsLoading(true)
    try {
      const loom: LoomPreset = {
        ...jsonData,
        id: generateUUID(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      const created = await presetsApi.create(marshalPreset(loom))
      const newLoom = unmarshalPreset(created)
      await refreshRegistry()
      setActiveLoomPreset(created.id)
      setActivePreset(newLoom)
      return newLoom
    } catch (err: any) {
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [refreshRegistry, setActiveLoomPreset])

  // Export internal JSON
  const exportInternal = useCallback(() => {
    return activePreset
  }, [activePreset])

  // Export as legacy (SillyTavern) JSON
  const exportLegacy = useCallback(() => {
    if (!activePreset) return null
    return exportToSTPreset(activePreset)
  }, [activePreset])

  // Available macros for the inserter — fetched from API, with local fallback
  const [availableMacros, setAvailableMacros] = useState<MacroGroup[]>(() => getAvailableMacros())

  const refreshMacros = useCallback(() => {
    getMacroCatalog()
      .then((catalog) => {
        const groups: MacroGroup[] = catalog.categories.map((c) => ({
          category: c.category,
          macros: c.macros.map((m) => ({
            name: m.name,
            syntax: m.syntax,
            description: m.description,
            args: m.args,
            returns: m.returns,
          })),
        }))
        // Merge: API macros first, then any local-only groups not in the API response
        const apiCategoryNames = new Set(groups.map((g) => g.category))
        const localOnly = getAvailableMacros().filter((g) => !apiCategoryNames.has(g.category))
        setAvailableMacros([...groups, ...localOnly])
      })
      .catch(() => {
        // Keep local fallback on API failure
      })
  }, [])

  useEffect(() => { refreshMacros() }, [refreshMacros])

  // Connection profile detection from store
  const connectionProfile = useMemo<LoomConnectionProfile>(() => {
    const profile = profiles.find(p => p.id === activeProfileId)
    if (profile) {
      return {
        mainApi: 'openai',
        source: profile.provider,
        model: profile.model,
        supportedParams: detectSupportedParams(profile.provider),
      }
    }
    return {
      mainApi: 'unknown',
      source: null,
      model: null,
      supportedParams: detectSupportedParams(null),
    }
  }, [activeProfileId, profiles])

  const refreshConnectionProfile = useCallback(() => {
    // Connection profile is derived from store, no manual refresh needed
  }, [])

  return {
    // State
    registry: loomRegistry,
    activePresetId: activeLoomPresetId,
    activePreset,
    isLoading,
    error,
    availableMacros,
    refreshMacros,

    // Connection profile
    connectionProfile,
    refreshConnectionProfile,

    // Sampler constants
    SAMPLER_PARAMS,
    DEFAULT_SAMPLER_OVERRIDES,
    DEFAULT_CUSTOM_BODY,
    DEFAULT_PROMPT_BEHAVIOR,
    DEFAULT_COMPLETION_SETTINGS,
    DEFAULT_ADVANCED_SETTINGS,

    // Preset CRUD
    createPreset,
    selectPreset,
    saveBlocks,
    deletePreset,
    duplicatePreset,
    renamePreset,
    refreshRegistry,

    // Block manipulation
    addBlock,
    removeBlock,
    updateBlock,
    toggleBlock,
    reorderBlocks,

    // Sampler & body settings
    saveSamplerOverrides,
    saveCustomBody,

    // Prompt behavior, completion, advanced
    savePromptBehavior,
    saveCompletionSettings,
    saveAdvancedSettings,

    // Import/Export
    importFromFile,
    importFromST,
    exportInternal,
    exportLegacy,
  }
}
