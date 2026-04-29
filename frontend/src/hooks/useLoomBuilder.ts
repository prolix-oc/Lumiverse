import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useStore } from '@/store'
import { presetsApi } from '@/api/presets'
import { connectionsApi } from '@/api/connections'
import { ApiError, BASE_URL } from '@/api/client'
import { regexApi } from '@/api/regex'
import { toast } from '@/lib/toast'
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
  marshalUpdate,
  unmarshalPreset,
  detectSupportedParamsFromProviders,
  getAvailableMacros,
  exportToSTPreset,
  normalizeCategoryBlockState,
  toggleBlockWithCategoryRules,
  coerceImportedLoomPreset,
  detectImportedPresetKind,
  looksLikeLegacyPresetData,
} from '@/lib/loom/service'

const PENDING_LOOM_PRESETS_KEY = '__lumiverse_pending_loom_presets'

function readPendingLoomPresets(): Record<string, LoomPreset> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(PENDING_LOOM_PRESETS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writePendingLoomPresets(presets: Record<string, LoomPreset>) {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(presets).length === 0) {
      localStorage.removeItem(PENDING_LOOM_PRESETS_KEY)
      return
    }
    localStorage.setItem(PENDING_LOOM_PRESETS_KEY, JSON.stringify(presets))
  } catch {}
}

function getPendingLoomPreset(id: string): LoomPreset | null {
  const pending = readPendingLoomPresets()[id]
  return pending && typeof pending === 'object' ? pending : null
}

function setPendingLoomPreset(preset: LoomPreset) {
  const pending = readPendingLoomPresets()
  pending[preset.id] = preset
  writePendingLoomPresets(pending)
}

function clearPendingLoomPreset(id: string) {
  const pending = readPendingLoomPresets()
  if (!(id in pending)) return
  delete pending[id]
  writePendingLoomPresets(pending)
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
        const loadedPreset = unmarshalPreset(preset)
        const pendingPreset = getPendingLoomPreset(activeLoomPresetId)

        if (pendingPreset && JSON.stringify(marshalUpdate(pendingPreset)) !== JSON.stringify(marshalUpdate(loadedPreset))) {
          setActivePreset(pendingPreset)
          void presetsApi.update(pendingPreset.id, marshalUpdate(pendingPreset))
            .then(() => clearPendingLoomPreset(pendingPreset.id))
            .catch(() => {})
        } else {
          if (pendingPreset) clearPendingLoomPreset(activeLoomPresetId)
          setActivePreset(loadedPreset)
        }
        setIsLoading(false)
      }
    }).catch((err) => {
      if (cancelled) return
      // Retroactive cleanup: if the persisted active preset id points at a row
      // that no longer exists (legacy deletions that didn't cascade), clear it
      // so generation doesn't keep 400ing on a ghost id.
      if (err instanceof ApiError && err.status === 404) {
        setActiveLoomPreset(null)
        setActivePreset(null)
        setIsLoading(false)
        return
      }
      console.warn('[LoomBuilder] Failed to load preset:', err)
      setError(err.message)
      setIsLoading(false)
    })
    return () => { cancelled = true }
  }, [activeLoomPresetId, activePreset?.id, setActiveLoomPreset])

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

  const persistPreset = useCallback(async (preset: LoomPreset) => {
    await presetsApi.update(preset.id, marshalUpdate(preset))
    clearPendingLoomPreset(preset.id)
  }, [])

  const persistPresetKeepalive = useCallback((preset: LoomPreset) => {
    setPendingLoomPreset(preset)
    fetch(`${BASE_URL}/presets/${encodeURIComponent(preset.id)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(marshalUpdate(preset)),
      keepalive: true,
    }).catch(() => {})
  }, [])

  const debouncedSavePreset = useCallback((preset: LoomPreset) => {
    pendingSaveRef.current = preset
    setPendingLoomPreset(preset)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      const toSave = pendingSaveRef.current
      if (toSave) {
        pendingSaveRef.current = null
        try {
          await persistPreset(toSave)
        } catch (err) {
          console.warn('[LoomBuilder] Debounced save failed:', err)
        }
      }
    }, 400)
  }, [persistPreset])

  const flushPendingPreset = useCallback((mode: 'default' | 'keepalive' = 'default') => {
    const pending = pendingSaveRef.current
    if (!pending) return
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    pendingSaveRef.current = null
    if (mode === 'keepalive') {
      persistPresetKeepalive(pending)
      return
    }
    void persistPreset(pending).catch(() => {})
  }, [persistPreset, persistPresetKeepalive])

  // Flush pending save on unmount
  useEffect(() => () => {
    flushPendingPreset()
  }, [flushPendingPreset])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const handlePageExit = () => flushPendingPreset('keepalive')
    window.addEventListener('beforeunload', handlePageExit)
    window.addEventListener('pagehide', handlePageExit)

    return () => {
      window.removeEventListener('beforeunload', handlePageExit)
      window.removeEventListener('pagehide', handlePageExit)
    }
  }, [flushPendingPreset])

  const takePendingPreset = useCallback((presetId: string): LoomPreset | null => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }

    const pending = pendingSaveRef.current?.id === presetId
      ? pendingSaveRef.current
      : null

    pendingSaveRef.current = null
    return pending
  }, [])

  // Read activePreset through a ref so saveStructure stays reference-stable
  // across renders. When saveBlocks is captured by downstream effects, a
  // changing reference would either cause runaway effect loops or leak stale
  // activePreset into the callback — the ref avoids both.
  const activePresetRef = useRef(activePreset)
  activePresetRef.current = activePreset

  const updateActivePreset = useCallback((updater: (current: LoomPreset) => LoomPreset) => {
    const current = activePresetRef.current
    if (!current) return
    const updated = updater(current)
    activePresetRef.current = updated
    setActivePreset(updated)
    debouncedSavePreset(updated)
  }, [debouncedSavePreset])

  const saveStructure = useCallback(async (
    blocks: PromptBlock[],
  ) => {
    const current = activePresetRef.current
    if (!current) return
    const normalizedBlocks = normalizeCategoryBlockState(blocks)
    const updated = {
      ...current,
      blocks: normalizedBlocks,
      updatedAt: Date.now(),
    }
    activePresetRef.current = updated
    setActivePreset(updated)
    try {
      await presetsApi.update(updated.id, marshalUpdate(updated))
      refreshRegistry()
    } catch (err) {
      console.warn('[LoomBuilder] Failed to save preset structure:', err)
    }
  }, [refreshRegistry])

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
    // Refresh connection profiles so any stale preset_id references (the
    // backend's FK nulls them out on delete) drop from the store.
    try {
      const res = await connectionsApi.list({ limit: 100 })
      useStore.getState().setProfiles(res.data)
    } catch {
      // non-fatal — store just keeps the previous profile list
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
      copy.promptVariables = JSON.parse(JSON.stringify(loom.promptVariables || {}))
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
    if (!activePreset) return
    const base = takePendingPreset(activePreset.id) ?? activePreset
    const updated = { ...base, promptVariables: values, updatedAt: Date.now() }
    activePresetRef.current = updated
    setActivePreset(updated)
    try {
      await persistPreset(updated)
    } catch (err) {
      console.warn('[LoomBuilder] Failed to save prompt variable values:', err)
      throw err
    }
  }, [activePreset, persistPreset, takePendingPreset])

  const persistImportedPreset = useCallback(async (payload: any, fileName?: string) => {
    setIsLoading(true)
    try {
      const fallbackName = fileName?.replace(/\.json$/i, '') || 'Imported Preset'
      const loom = coerceImportedLoomPreset(payload, fallbackName)
      const created = await presetsApi.create(marshalPreset(loom))
      const newLoom = unmarshalPreset(created)
      await refreshRegistry()
      setActiveLoomPreset(created.id)
      setActivePreset(newLoom)

      // Legacy presets can embed regex scripts, so import them alongside the
      // preset creation on the dedicated legacy path.
      const embeddedRegex = looksLikeLegacyPresetData(payload)
        ? payload.extensions?.regex_scripts
        : null
      if (Array.isArray(embeddedRegex) && embeddedRegex.length > 0) {
        try {
          const regexResult = await regexApi.importScripts({ scripts: embeddedRegex, folder: loom.name, preset_id: created.id })
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

  // Import from legacy preset JSON
  const importFromST = useCallback(async (stData: any, fileName: string) => {
    if (detectImportedPresetKind(stData) === 'loom') {
      toast.warning('This file is a Loom preset. Use "Import Loom JSON" instead.', { title: 'Preset Import' })
      return null
    }
    return persistImportedPreset(stData, fileName)
  }, [persistImportedPreset])

  // Import from file (internal JSON format)
  const importFromFile = useCallback(async (jsonData: any, fileName?: string) => {
    if (detectImportedPresetKind(jsonData) === 'legacy') {
      toast.warning('This file is a legacy preset. Use "Import Legacy Preset" instead.', { title: 'Preset Import' })
      return null
    }
    return persistImportedPreset(jsonData, fileName)
  }, [persistImportedPreset])

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
    savePromptVariableValues,

    // Import/Export
    importFromFile,
    importFromST,
    exportInternal,
    exportLegacy,
  }
}
