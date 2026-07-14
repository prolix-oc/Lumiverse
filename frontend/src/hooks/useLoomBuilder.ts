import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useStore } from '@/store'
import { presetsApi } from '@/api/presets'
import { connectionsApi } from '@/api/connections'
import { ApiError } from '@/api/client'
import { regexApi } from '@/api/regex'
import { toast } from '@/lib/toast'
import i18n from '@/i18n'
import { enqueuePresetRegexOperation } from '@/lib/presetRegexQueue'
import { flushPresetForGeneration, presetSaveCoordinator, StalePresetHydrationError } from '@/lib/loom/preset-save-coordinator'
import { beginActiveLoomPresetSelection, transitionActiveLoomPreset } from '@/lib/loom/preset-selection-coordinator'
import { getMacroCatalog } from '@/api/macros'
import type { LoomPreset, PromptBlock, LoomConnectionProfile, MacroGroup, PromptVariableValues } from '@/lib/loom/types'
import {
  DEFAULT_SAMPLER_OVERRIDES,
  DEFAULT_CUSTOM_BODY,
  DEFAULT_PROMPT_BEHAVIOR,
  DEFAULT_COMPLETION_SETTINGS,
  DEFAULT_ADVANCED_SETTINGS,
  SAMPLER_PARAMS,
} from '@/lib/loom/constants'
import {
  createNewLoomPreset,
  marshalPreset,
  unmarshalPreset,
  detectSupportedParamsFromProviders,
  getAvailableMacros,
  exportToSTPreset,
  sanitizeLumiHubSealedBlocksForExport,
  normalizeCategoryBlockState,
  toggleBlockWithCategoryRules,
  coerceImportedLoomPreset,
  detectImportedPresetKind,
  reconcilePromptVariableValues,
  pruneOrphanPromptVariables,
  validatePromptVariableSchema,
} from '@/lib/loom/service'


type LoomPrivateBlockFields = Pick<
  PromptBlock,
  'sealed' | 'sealedKey' | 'sealedSource' | 'sealedOriginPresetId' | 'sealedOriginVersion' | 'sealedSha256'
>

type LoomPrivateBlockChange = {
  blockId: string
  /** Zero-based occurrence among blocks sharing blockId; required for duplicates. */
  occurrence?: number
  patch: Partial<LoomPrivateBlockFields>
}

function applyPrivateBlockChange(
  currentBlocks: PromptBlock[],
  nextBlocks: PromptBlock[],
  change: LoomPrivateBlockChange | undefined,
): PromptBlock[] {
  if (!change) return nextBlocks
  const currentMatches = currentBlocks.filter((block) => block.id === change.blockId).length
  const nextMatches = nextBlocks.filter((block) => block.id === change.blockId).length
  const occurrence = change.occurrence
  if (currentMatches > 1) {
    if (!Number.isSafeInteger(occurrence) || occurrence < 0 || occurrence >= currentMatches) {
      throw new Error('LOOM_AMBIGUOUS_BLOCK_OCCURRENCE: duplicate block changes require an exact occurrence')
    }
    if (nextMatches !== currentMatches) {
      throw new Error('LOOM_AMBIGUOUS_BLOCK_OCCURRENCE: duplicate block occurrence count changed')
    }
  } else if (occurrence !== undefined && occurrence !== 0) {
    throw new Error('LOOM_AMBIGUOUS_BLOCK_OCCURRENCE: occurrence must identify the unique block')
  }
  let seen = 0
  let applied = false
  const updated = nextBlocks.map((block) => {
    if (block.id !== change.blockId) return block
    const matches = occurrence === undefined || occurrence === seen
    seen += 1
    if (!matches) return block
    applied = true
    return { ...block, ...change.patch }
  })
  if (!applied) {
    throw new Error('LOOM_AMBIGUOUS_BLOCK_OCCURRENCE: requested block occurrence is absent')
  }
  return updated
}

export function useLoomBuilder() {
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)
  const loomRegistry = useStore((s) => s.loomRegistry)
  const setActiveLoomPreset = useStore((s) => s.setActiveLoomPreset)
  const setLoomRegistry = useStore((s) => s.setLoomRegistry)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const profiles = useStore((s) => s.profiles)
  const providers = useStore((s) => s.providers)

  const [activePreset, setActivePreset] = useState<LoomPreset | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activePresetRef = useRef<LoomPreset | null>(null)

  // Load active preset when activeLoomPresetId changes. Durable recovery is
  // rebased through the process-wide coordinator so an old local snapshot
  // cannot overwrite unrelated prompt-variable or extension metadata changes.
  useEffect(() => {
    if (!activeLoomPresetId) {
      activePresetRef.current = null
      setActivePreset(null)
      return
    }
    if (activePresetRef.current?.id === activeLoomPresetId) return

    let cancelled = false
    setIsLoading(true)
    const hydration = presetSaveCoordinator.beginHydration(activeLoomPresetId, 'loom-editor')
    presetsApi.get(activeLoomPresetId).then((preset) => {
      if (cancelled) {
        presetSaveCoordinator.cancelHydration(hydration)
        return
      }
      const loadedPreset = presetSaveCoordinator.hydrate(unmarshalPreset(preset), hydration)
      activePresetRef.current = loadedPreset
      setActivePreset(loadedPreset)
      setIsLoading(false)
    }).catch((err) => {
      presetSaveCoordinator.cancelHydration(hydration)
      if (cancelled) return
      if (err instanceof StalePresetHydrationError) {
        setIsLoading(false)
        return
      }
      // Retroactive cleanup: if the persisted active preset id points at a row
      // that no longer exists (legacy deletions that didn't cascade), clear it
      // so generation doesn't keep 400ing on a ghost id.
      if (err instanceof ApiError && err.status === 404) {
        presetSaveCoordinator.remove(activeLoomPresetId)
        if (useStore.getState().activeLoomPresetId === activeLoomPresetId) {
          activePresetRef.current = null
          useStore.getState().setActiveLoomPreset(null)
          setActivePreset(null)
        }
        setIsLoading(false)
        return
      }
      console.warn('[LoomBuilder] Failed to load preset:', err)
      setError(err.message)
      setIsLoading(false)
    })
    return () => {
      cancelled = true
      presetSaveCoordinator.cancelHydration(hydration)
    }
  }, [activeLoomPresetId])


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

  // Load registry on mount. The registry is kept in the store across panel
  // open/close cycles, and every mutation path below (create/delete/rename/
  // duplicate/save) already calls `refreshRegistry()` itself, so skip the
  // redundant mount-time fetch when the cache is populated.
  useEffect(() => {
    if (Object.keys(loomRegistry).length > 0) return
    refreshRegistry()
  }, [loomRegistry, refreshRegistry])

  // Create a new preset
  const createPreset = useCallback(async (name: string, description?: string) => {
    const selection = beginActiveLoomPresetSelection()
    setIsLoading(true)
    try {
      const loom = createNewLoomPreset(name, description)
      const created = await presetsApi.create(marshalPreset(loom))
      const newLoom = presetSaveCoordinator.hydrate(unmarshalPreset(created))
      await refreshRegistry()
      if (await selection.transition(created.id)) {
        activePresetRef.current = newLoom
        setActivePreset(newLoom)
      }
      return newLoom
    } catch (err: any) {
      selection.cancel()
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [refreshRegistry])

  const flushPendingPreset = useCallback(async (): Promise<void> => {
    const presetId = activePresetRef.current?.id ?? activeLoomPresetId
    if (!presetId) return
    await flushPresetForGeneration(presetId)
  }, [activeLoomPresetId])

  // Keep this mounted editor synchronized when another owner (the prompt
  // variable modal or a Spindle scoped helper) updates the shared draft.
  useEffect(() => {
    if (!activeLoomPresetId) return
    return presetSaveCoordinator.subscribe(activeLoomPresetId, (preset) => {
      if (useStore.getState().activeLoomPresetId !== preset.id) return
      activePresetRef.current = preset
      setActivePreset(preset)
      setIsLoading(false)
    })
  }, [activeLoomPresetId])

  // Flush pending save on unmount.
  useEffect(() => () => {
    void flushPendingPreset()
  }, [flushPendingPreset])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const handlePageExit = () => {
      const presetId = activePresetRef.current?.id
      if (presetId) presetSaveCoordinator.flushBestEffort(presetId)
    }
    window.addEventListener('beforeunload', handlePageExit)
    window.addEventListener('pagehide', handlePageExit)

    return () => {
      window.removeEventListener('beforeunload', handlePageExit)
      window.removeEventListener('pagehide', handlePageExit)
    }
  }, [])

  // BFCache restoration keeps React mounted, so re-read and field-rebase the
  // active preset instead of replaying a stale full-document snapshot.
  useEffect(() => {
    if (typeof window === 'undefined') return

    const handlePageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      const presetId = activePresetRef.current?.id
      if (!presetId) return
      const hydration = presetSaveCoordinator.beginHydration(presetId, 'loom-editor')
      void presetsApi.get(presetId).then((preset) => {
        if (useStore.getState().activeLoomPresetId !== presetId) {
          presetSaveCoordinator.cancelHydration(hydration)
          return
        }
        const restored = presetSaveCoordinator.hydrate(unmarshalPreset(preset), hydration)
        if (activePresetRef.current?.id !== restored.id) return
        activePresetRef.current = restored
        setActivePreset(restored)
      }).catch((err) => {
        presetSaveCoordinator.cancelHydration(hydration)
        if (err instanceof StalePresetHydrationError) return
        console.warn('[LoomBuilder] Failed to rebase restored preset:', err)
      })
    }
    window.addEventListener('pageshow', handlePageShow)
    return () => { window.removeEventListener('pageshow', handlePageShow) }
  }, [])

  // Flush the prior draft before changing the editor target so extension and
  // native edits cannot be delivered to the wrong preset or lost on unmount.
  // All supported manual and automatic selection paths use the same
  // coordinator so the departing draft is flushed before a new id is exposed.
  const selectPreset = useCallback(async (presetId: string | null) => {
    await transitionActiveLoomPreset(presetId)
  }, [])

  // Read activePreset through a ref so saveStructure stays reference-stable
  // across renders. The coordinator remains the authoritative draft owner.
  activePresetRef.current = activePreset?.id === activeLoomPresetId ? activePreset : null

  const updateActivePreset = useCallback((
    updater: (current: LoomPreset) => LoomPreset,
    immediate = false,
  ) => {
    const current = activePresetRef.current
    if (!current || useStore.getState().activeLoomPresetId !== current.id) return
    const updated = presetSaveCoordinator.mutate(
      current.id,
      current,
      updater,
      { immediate },
    )
    activePresetRef.current = updated
    setActivePreset(updated)
    if (immediate) {
      void presetSaveCoordinator.flush(updated.id).catch((err) => {
        console.warn('[LoomBuilder] Immediate preset save failed:', err)
      })
    }
  }, [])

  const saveStructure = useCallback(async (
    blocks: PromptBlock[],
  ): Promise<boolean> => {
    const current = activePresetRef.current
    if (!current || useStore.getState().activeLoomPresetId !== current.id) return false
    try {
      const normalizedBlocks = normalizeCategoryBlockState(blocks)
      validatePromptVariableSchema(normalizedBlocks, { legacyBaseline: current.blocks })
      let promptVariables: PromptVariableValues
      try {
        // A strict check distinguishes a clean prior schema from a legacy one.
        // Legacy values are pruned by tolerant name/schema union so native edits
        // do not re-run strict validation against the anomaly they preserve.
        validatePromptVariableSchema(current.blocks)
        promptVariables = reconcilePromptVariableValues(
          current.promptVariables,
          current.blocks,
          normalizedBlocks,
          { legacyBaseline: current.blocks },
        )
      } catch {
        promptVariables = pruneOrphanPromptVariables(current.promptVariables, normalizedBlocks)
      }
      const updated = presetSaveCoordinator.mutate(
        current.id,
        current,
        (draft) => ({ ...draft, blocks: normalizedBlocks, promptVariables }),
        { immediate: true },
      )
      activePresetRef.current = updated
      setActivePreset(updated)
      await presetSaveCoordinator.flush(updated.id)
      await refreshRegistry()
      return true
    } catch (err) {
      console.warn('[LoomBuilder] Failed to save preset structure:', err)
      return false
    }
  }, [refreshRegistry])

  // Save blocks
  const saveBlocks = useCallback(async (blocks: PromptBlock[]) => {
    await saveStructure(blocks)
  }, [saveStructure])

  const saveLoomValue = useCallback(async (
    blocks: PromptBlock[],
    promptVariables: PromptVariableValues,
    privateBlockChange?: LoomPrivateBlockChange,
  ) => {
    const current = activePresetRef.current
    if (!current || useStore.getState().activeLoomPresetId !== current.id) return
    const normalizedBlocks = normalizeCategoryBlockState(blocks)
    validatePromptVariableSchema(normalizedBlocks, { legacyBaseline: current.blocks })
    const nextBlocks = applyPrivateBlockChange(current.blocks, normalizedBlocks, privateBlockChange)
    const updated = presetSaveCoordinator.mutate(
      current.id,
      current,
      (draft) => ({
        ...draft,
        blocks: nextBlocks,
        promptVariables,
      }),
      { immediate: true },
    )
    activePresetRef.current = updated
    setActivePreset(updated)
    try {
      await presetSaveCoordinator.flush(updated.id)
      await refreshRegistry()
    } catch (err) {
      console.warn('[LoomBuilder] Failed to save Loom editor value:', err)
      throw err
    }
  }, [refreshRegistry])

  // Rename a preset
  const renamePreset = useCallback(async (presetId: string, newName: string) => {
    let current = presetId === activePresetRef.current?.id ? activePresetRef.current : null
    if (!current) {
      const hydration = presetSaveCoordinator.beginHydration(presetId, 'preset-rename')
      try {
        current = presetSaveCoordinator.hydrate(unmarshalPreset(await presetsApi.get(presetId)), hydration)
      } catch (error) {
        presetSaveCoordinator.cancelHydration(hydration)
        throw error
      }
    }
    const updated = presetSaveCoordinator.mutate(
      presetId,
      current,
      (draft) => ({ ...draft, name: newName }),
      { immediate: true },
    )
    if (updated.id === activePresetRef.current?.id) {
      activePresetRef.current = updated
      setActivePreset(updated)
    }
    await presetSaveCoordinator.flush(presetId)
    await refreshRegistry()
  }, [refreshRegistry])

  // Delete a preset
  const deletePreset = useCallback(async (presetId: string) => {
    await flushPresetForGeneration(presetId)
    await presetsApi.delete(presetId)
    presetSaveCoordinator.remove(presetId)
    await refreshRegistry()
    // A later coordinated selection may have committed while deletion was in
    // flight. Only clear the live selection when it still names this row.
    if (useStore.getState().activeLoomPresetId === presetId) {
      activePresetRef.current = null
      useStore.getState().setActiveLoomPreset(null)
      setActivePreset(null)
    }
    // Refresh connection profiles so any stale preset_id references (the
    // backend's FK nulls them out on delete) drop from the store.
    try {
      const res = await connectionsApi.list({ limit: 100 })
      useStore.getState().setProfiles(res.data)
    } catch {
      // non-fatal — store just keeps the previous profile list
    }
  }, [refreshRegistry])

  // Duplicate a preset
  const duplicatePreset = useCallback(async (presetId: string, newName: string) => {
    const selection = beginActiveLoomPresetSelection()
    setIsLoading(true)
    try {
      await flushPresetForGeneration(presetId)
      const hydration = presetSaveCoordinator.beginHydration(presetId, 'preset-duplicate')
      let hydratedSource: LoomPreset
      try {
        hydratedSource = presetSaveCoordinator.hydrate(
          unmarshalPreset(await presetsApi.get(presetId)),
          hydration,
        )
      } catch (error) {
        presetSaveCoordinator.cancelHydration(hydration)
        throw error
      }
      const source = await presetSaveCoordinator.flush(presetId) ?? hydratedSource
      const copy = createNewLoomPreset(newName)
      // Copy all content from the coordinator-confirmed persisted source.
      copy.blocks = JSON.parse(JSON.stringify(source.blocks))
      copy.samplerOverrides = { ...source.samplerOverrides }
      copy.customBody = { ...source.customBody }
      copy.promptBehavior = { ...source.promptBehavior }
      copy.completionSettings = { ...source.completionSettings }
      copy.advancedSettings = { ...source.advancedSettings }
      copy.modelProfiles = { ...source.modelProfiles }
      copy.passthroughMetadata = JSON.parse(JSON.stringify(source.passthroughMetadata))
      copy.promptVariables = JSON.parse(JSON.stringify(source.promptVariables))
      copy.source = source.source ? { ...source.source } : null
      copy.coverUrl = source.coverUrl

      const created = await presetsApi.create(marshalPreset(copy))
      const newLoom = presetSaveCoordinator.hydrate(unmarshalPreset(created))
      await refreshRegistry()
      await flushPresetForGeneration(presetId)
      if (await selection.transition(created.id)) {
        activePresetRef.current = newLoom
        setActivePreset(newLoom)
      }
      return newLoom
    } catch (err: any) {
      selection.cancel()
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [refreshRegistry])

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

  const removeBlock = useCallback(async (
    blockId: string,
    replacement?: { blocks: PromptBlock[]; promptVariables?: PromptVariableValues },
  ) => {
    const current = activePresetRef.current
    if (!current) return
    const sourceBlocks = replacement?.blocks ?? current.blocks
    const blocks = sourceBlocks
      .filter((block) => block.id !== blockId)
      .map((block) => block.group === blockId ? { ...block, group: null } : block)
    const promptVariables = { ...(replacement?.promptVariables ?? current.promptVariables ?? {}) }
    delete promptVariables[blockId]
    await saveLoomValue(blocks, promptVariables)
  }, [saveLoomValue])

  const updateBlock = useCallback((blockId: string, updates: Partial<PromptBlock>): boolean => {
    const current = activePresetRef.current
    if (!current) return false
    const blocks = current.blocks.map(b => (
      b.id === blockId ? { ...b, ...updates } : b
    ))
    let normalizedBlocks: PromptBlock[]
    try {
      normalizedBlocks = normalizeCategoryBlockState(blocks)
      validatePromptVariableSchema(normalizedBlocks, { legacyBaseline: current.blocks })
    } catch {
      return false
    }
    void saveBlocks(normalizedBlocks).catch(() => {})
    return true
  }, [saveBlocks])

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
    updateActivePreset((current) => ({
      ...current,
      samplerOverrides: { ...overrides },
      updatedAt: Date.now(),
    }))
  }, [updateActivePreset])

  const saveCustomBody = useCallback((customBody: any) => {
    updateActivePreset((current) => ({
      ...current,
      customBody: { ...customBody },
      updatedAt: Date.now(),
    }))
  }, [updateActivePreset])

  const savePromptBehavior = useCallback((updates: Record<string, any>) => {
    updateActivePreset((current) => ({
      ...current,
      promptBehavior: { ...(current.promptBehavior || DEFAULT_PROMPT_BEHAVIOR), ...updates },
      updatedAt: Date.now(),
    }))
  }, [updateActivePreset])

  const saveCompletionSettings = useCallback((updates: Record<string, any>) => {
    updateActivePreset((current) => ({
      ...current,
      completionSettings: { ...(current.completionSettings || DEFAULT_COMPLETION_SETTINGS), ...updates },
      updatedAt: Date.now(),
    }))
  }, [updateActivePreset])

  const saveAdvancedSettings = useCallback((updates: Record<string, any>) => {
    updateActivePreset((current) => ({
      ...current,
      advancedSettings: { ...(current.advancedSettings || DEFAULT_ADVANCED_SETTINGS), ...updates },
      updatedAt: Date.now(),
    }))
  }, [updateActivePreset])

  // Persist the full promptVariables map in one shot. Used by the end-user
  // "Configure Prompt Variables" modal — saves are infrequent and user-driven
  // so we bypass the debouncer and wait for the network round-trip so errors
  // surface immediately.
  const savePromptVariableValues = useCallback(async (values: PromptVariableValues) => {
    const current = activePresetRef.current
    if (!current || useStore.getState().activeLoomPresetId !== current.id) return
    const updated = presetSaveCoordinator.mutate(
      current.id,
      current,
      (draft) => ({ ...draft, promptVariables: values }),
      { immediate: true },
    )
    activePresetRef.current = updated
    setActivePreset(updated)
    try {
      await presetSaveCoordinator.flush(updated.id)
    } catch (err) {
      console.warn('[LoomBuilder] Failed to save prompt variable values:', err)
      throw err
    }
  }, [])

  const persistImportedPreset = useCallback(async (payload: any, fileName?: string) => {
    const selection = beginActiveLoomPresetSelection()
    setIsLoading(true)
    try {
      const fallbackName = fileName?.replace(/\.json$/i, '') || 'Imported Preset'
      const loom = coerceImportedLoomPreset(payload, fallbackName)
      const created = await presetsApi.create(marshalPreset(loom))
      const newLoom = presetSaveCoordinator.hydrate(unmarshalPreset(created))
      await refreshRegistry()
      if (await selection.transition(created.id)) {
        activePresetRef.current = newLoom
        setActivePreset(newLoom)
      }

      const embeddedRegex = Array.isArray(payload?.extensions?.regex_scripts)
        ? payload.extensions.regex_scripts
        : Array.isArray(payload?.regex_scripts)
          ? payload.regex_scripts
          : null
      if (Array.isArray(embeddedRegex) && embeddedRegex.length > 0) {
        try {
          const regexResult = await enqueuePresetRegexOperation(() => regexApi.importScripts({
            scripts: embeddedRegex,
            folder: loom.name,
            preset_id: created.id,
            active_preset_id: created.id,
          }))
          if (regexResult.imported > 0) {
            const { loadRegexScripts } = useStore.getState() as any
            if (loadRegexScripts) await loadRegexScripts()
            toast.success(i18n.t('panels.loomBuilder.toast.importedRegexFromPreset', { count: regexResult.imported }))
          }
          if (regexResult.errors.length > 0) {
            toast.error(i18n.t('panels.loomBuilder.toast.regexImportFailed', { count: regexResult.errors.length }))
          }
        } catch { /* regex import is best-effort */ }
      }

      return newLoom
    } catch (err: any) {
      selection.cancel()
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [refreshRegistry])

  // Import from legacy preset JSON
  const importFromST = useCallback(async (stData: any, fileName: string) => {
    if (detectImportedPresetKind(stData) === 'loom') {
      toast.warning(i18n.t('panels.loomBuilder.toast.importLoomPresetInstead'), { title: i18n.t('panels.loomBuilder.toast.presetImportTitle') })
      return null
    }
    return persistImportedPreset(stData, fileName)
  }, [persistImportedPreset])

  // Import from file (internal JSON format)
  const importFromFile = useCallback(async (jsonData: any, fileName?: string) => {
    if (detectImportedPresetKind(jsonData) === 'legacy') {
      toast.warning(i18n.t('panels.loomBuilder.toast.importLegacyPresetInstead'), { title: i18n.t('panels.loomBuilder.toast.presetImportTitle') })
      return null
    }
    return persistImportedPreset(jsonData, fileName)
  }, [persistImportedPreset])

  // Export internal JSON
  const exportInternal = useCallback(async () => {
    if (!activePreset) return null
    const exportPreset = sanitizeLumiHubSealedBlocksForExport(activePreset)
    const regexExport = await regexApi.exportScripts(undefined, { preset_id: activePreset.id })
    if (regexExport.scripts.length === 0) return exportPreset
    return {
      ...exportPreset,
      extensions: {
        ...((exportPreset as any).extensions || {}),
        regex_scripts: regexExport.scripts,
      },
    }
  }, [activePreset])

  // Export as legacy (SillyTavern) JSON
  const exportLegacy = useCallback(() => {
    if (!activePreset) return null
    return exportToSTPreset(sanitizeLumiHubSealedBlocksForExport(activePreset))
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
        supportedParams: detectSupportedParamsFromProviders(profile.provider, providers),
      }
    }
    return {
      mainApi: 'unknown',
      source: null,
      model: null,
      supportedParams: detectSupportedParamsFromProviders(null, providers),
    }
  }, [activeProfileId, profiles, providers])

  const refreshConnectionProfile = useCallback(() => {
    // Connection profile is derived from store, so no manual refresh is needed.
  }, [])

  return {
    // State
    registry: loomRegistry,
    activePresetId: activeLoomPresetId,
    activePreset: activePreset?.id === activeLoomPresetId ? activePreset : null,
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
    saveLoomValue,
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
    savePromptVariableValues,
    updatePresetDraft: updateActivePreset,
    flushPresetDraft: flushPendingPreset,

    // Import/Export
    importFromFile,
    importFromST,
    exportInternal,
    exportLegacy,
  }
}
