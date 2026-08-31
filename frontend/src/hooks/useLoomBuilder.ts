import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useStore } from '@/store'
import { presetsApi } from '@/api/presets'
import { agenticRuntimeApi } from '@/api/agentic-runtime'
import { connectionsApi } from '@/api/connections'
import { ApiError } from '@/api/client'
import { regexApi } from '@/api/regex'
import { toast } from '@/lib/toast'
import i18n from '@/i18n'
import {
  createPresetSaveCoordinator,
  flushPresetForGeneration as defaultFlushPresetForGeneration,
  presetSaveCoordinator as defaultPresetSaveCoordinator,
  StalePresetHydrationError,
  type PresetSaveCoordinator,
} from '@/lib/loom/preset-save-coordinator'
import { beginActiveLoomPresetSelection, transitionActiveLoomPreset } from '@/lib/loom/preset-selection-coordinator'
import { getMacroCatalog } from '@/api/macros'
import type { SaveAgenticRuntimeEditorResult } from '@/api/agentic-runtime'
import type {
  AgenticRuntimeSaveDraft,
  LoomPreset,
  PromptBlock,
  LoomConnectionProfile,
  MacroGroup,
  PromptVariableDef,
  PromptVariableValues,
} from '@/lib/loom/types'
import {
  DEFAULT_SAMPLER_OVERRIDES,
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
  createEmptyPortableAgenticRuntimeEnvelope,
  createPortableLoomExportPayload,
  extractPortableAgenticRuntimeEnvelope,
  getPortablePresetErrorCode,
  hasLegacyPortableAgenticRuntimeGraph,
  PortablePresetError,
  shouldRollbackImportedPreset,
  toPortableAgentConfigV1,
  sanitizeLumiHubSealedBlocksForExport,
  normalizeCategoryBlockState,
  stripPortableRegexOwnership,
  computeGroups,
  coerceImportedLoomPreset,
  detectImportedPresetKind,
  reconcilePromptVariableValues,
  pruneOrphanPromptVariables,
  validatePromptVariableSchema,
} from '@/lib/loom/service'
import { prepareAgentConfigForRuntimeSave } from '@/lib/loom/agenticRuntime'
import { mergePromptVariableValues } from '@/hooks/preset-profile-prompt-variables'
import { commitRuntimeAuthorityMutation } from '@/lib/agentRuntimeSelection'

export interface LoomBlockOccurrence {
  readonly blockId: string
  readonly promptOrder: number
}

export function encodeLoomBlockOccurrence(target: LoomBlockOccurrence): string {
  return JSON.stringify([target.blockId, target.promptOrder])
}

export function decodeLoomBlockOccurrence(value: unknown): LoomBlockOccurrence | null {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [blockId, promptOrder] = parsed
    if (typeof blockId !== 'string' || blockId.length === 0) return null
    if (!Number.isSafeInteger(promptOrder) || (promptOrder as number) < 0) return null
    return { blockId, promptOrder: promptOrder as number }
  } catch {
    return null
  }
}

export function canMovePromptVariableBetweenOccurrences(
  source: LoomBlockOccurrence,
  target: LoomBlockOccurrence,
): boolean {
  return source.promptOrder !== target.promptOrder && source.blockId !== target.blockId
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function portableSnapshotKey(value: unknown): string {
  return JSON.stringify(value) ?? ''
}

type PortableRegexSource = readonly Record<string, unknown>[]

function readPortableRegexSource(
  sourceRecord: Record<string, unknown> | null,
): PortableRegexSource | null {
  const extensions = Object.hasOwn(sourceRecord ?? {}, 'extensions')
    ? sourceRecord?.extensions
    : undefined
  if (extensions !== undefined && !isObjectRecord(extensions)) {
    throw new PortablePresetError('AGENT_RUNTIME_PORTABLE_REGEX_INVALID')
  }

  const extensionRecord = isObjectRecord(extensions) ? extensions : null
  const extensionHasSnake = extensionRecord !== null && Object.hasOwn(extensionRecord, 'regex_scripts')
  const extensionHasCamel = extensionRecord !== null && Object.hasOwn(extensionRecord, 'regexScripts')
  const rootHasSnake = sourceRecord !== null && Object.hasOwn(sourceRecord, 'regex_scripts')
  const rootHasCamel = sourceRecord !== null && Object.hasOwn(sourceRecord, 'regexScripts')
  const sourceCount = Number(extensionHasSnake) + Number(extensionHasCamel) + Number(rootHasSnake) + Number(rootHasCamel)
  if (sourceCount > 1) {
    throw new PortablePresetError('AGENT_RUNTIME_PORTABLE_REGEX_INVALID')
  }
  if (sourceCount === 0) return null

  const raw = extensionHasSnake
    ? extensionRecord?.regex_scripts
    : extensionHasCamel
      ? extensionRecord?.regexScripts
      : rootHasSnake
        ? sourceRecord?.regex_scripts
        : sourceRecord?.regexScripts
  if (!Array.isArray(raw) || !raw.every(isObjectRecord)) {
    throw new PortablePresetError('AGENT_RUNTIME_PORTABLE_REGEX_INVALID')
  }
  return raw as PortableRegexSource
}

function normalizeAgentSlotBindings(value: unknown): Record<string, string | null> {
  if (Array.isArray(value)) {
    const output: Record<string, string | null> = {}
    for (const entry of value) {
      if (!isObjectRecord(entry) || typeof entry.slotId !== 'string') continue
      output[entry.slotId] = typeof entry.connectionId === 'string' ? entry.connectionId : null
    }
    return output
  }
  if (!isObjectRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, connectionId]) => (
      connectionId === null || typeof connectionId === 'string'
    )),
  ) as Record<string, string | null>
}

export function getLoomBlockAtOccurrence(
  blocks: readonly PromptBlock[],
  target: LoomBlockOccurrence,
): PromptBlock | null {
  if (!Number.isSafeInteger(target.promptOrder) || target.promptOrder < 0) return null
  const block = blocks[target.promptOrder]
  return block?.id === target.blockId ? block : null
}

function sameBooleanRecord(left: Record<string, boolean>, right: Record<string, boolean>): boolean {
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
}

function canonicalizeCategorySnapshots(blocks: PromptBlock[]): PromptBlock[] {
  let replacements: Map<PromptBlock, Record<string, boolean>> | null = null
  for (const group of computeGroups(blocks)) {
    const category = group.categoryBlock
    const snapshot = category?.savedChildEnabled
    if (!category || !snapshot) continue
    const children = new Set(group.children)
    const canonical: Record<string, boolean> = {}
    for (let promptOrder = 0; promptOrder < blocks.length; promptOrder += 1) {
      const child = blocks[promptOrder]!
      if (!children.has(child)) continue
      const coordinateKey = encodeLoomBlockOccurrence({ blockId: child.id, promptOrder })
      if (Object.hasOwn(snapshot, coordinateKey)) {
        canonical[coordinateKey] = snapshot[coordinateKey] === true
      } else if (Object.hasOwn(snapshot, child.id)) {
        // Legacy snapshots were ID-wide. Duplicate occurrences therefore receive
        // the same legacy value rather than an invented per-occurrence ordering.
        canonical[coordinateKey] = snapshot[child.id] === true
      }
    }
    if (!sameBooleanRecord(snapshot, canonical)) {
      if (!replacements) replacements = new Map()
      replacements.set(category, canonical)
    }
  }
  if (!replacements) return blocks
  return blocks.map((block) => {
    const savedChildEnabled = replacements.get(block)
    return savedChildEnabled ? { ...block, savedChildEnabled } : block
  })
}

function canonicalizeHydratedPreset(preset: LoomPreset): LoomPreset {
  const blocks = canonicalizeCategorySnapshots(preset.blocks)
  return blocks === preset.blocks ? preset : { ...preset, blocks }
}

export interface LoomBlockReorderEntry {
  readonly block: PromptBlock
  readonly source: LoomBlockOccurrence | null
}

export function remapCategorySnapshotsForReorder(
  sourceBlocks: PromptBlock[],
  reorderedEntries: readonly LoomBlockReorderEntry[],
): PromptBlock[] {
  const canonicalSourceBlocks = canonicalizeCategorySnapshots(sourceBlocks)
  const targetBySource = new Map<string, LoomBlockOccurrence>()
  for (let promptOrder = 0; promptOrder < reorderedEntries.length; promptOrder += 1) {
    const entry = reorderedEntries[promptOrder]!
    if (!entry.source) continue
    const sourceBlock = getLoomBlockAtOccurrence(canonicalSourceBlocks, entry.source)
    if (!sourceBlock || sourceBlock.id !== entry.block.id) continue
    targetBySource.set(encodeLoomBlockOccurrence(entry.source), {
      blockId: entry.block.id,
      promptOrder,
    })
  }

  return reorderedEntries.map((entry) => {
    if (!entry.source) return entry.block
    const sourceBlock = getLoomBlockAtOccurrence(canonicalSourceBlocks, entry.source)
    if (!sourceBlock?.savedChildEnabled) return entry.block
    const savedChildEnabled: Record<string, boolean> = {}
    for (const [sourceKey, enabled] of Object.entries(sourceBlock.savedChildEnabled)) {
      const target = targetBySource.get(sourceKey)
      if (!target) continue
      savedChildEnabled[encodeLoomBlockOccurrence(target)] = enabled
    }
    return { ...entry.block, savedChildEnabled }
  })
}

function toggleBlockAtOccurrence(
  blocks: PromptBlock[],
  target: LoomBlockOccurrence,
): PromptBlock[] {
  const targetBlock = getLoomBlockAtOccurrence(blocks, target)
  if (!targetBlock) return blocks
  const categoryGroup = computeGroups(blocks).find((group) => (
    group.categoryBlock?.categoryMode === 'radio'
    && group.children.includes(targetBlock)
  ))
  if (!categoryGroup?.categoryBlock) {
    return blocks.map((block, promptOrder) => (
      promptOrder === target.promptOrder ? { ...block, enabled: !block.enabled } : block
    ))
  }
  const children = new Set(categoryGroup.children)
  return blocks.map((block) => (
    children.has(block) ? { ...block, enabled: block === targetBlock } : block
  ))
}

function toggleCategoryAtOccurrence(
  blocks: PromptBlock[],
  target: LoomBlockOccurrence,
): PromptBlock[] {
  const targetCategory = getLoomBlockAtOccurrence(blocks, target)
  if (!targetCategory || targetCategory.marker !== 'category') return blocks
  const canonicalBlocks = canonicalizeCategorySnapshots(blocks)
  const category = getLoomBlockAtOccurrence(canonicalBlocks, target)!
  const group = computeGroups(canonicalBlocks).find((candidate) => candidate.categoryBlock === category)
  const groupChildren = group?.children ?? []
  const children = new Set(groupChildren)
  const disabling = category.enabled
  const snapshot = category.savedChildEnabled
  let savedChildEnabled: Record<string, boolean> | undefined
  if (disabling) {
    savedChildEnabled = {}
    for (let promptOrder = 0; promptOrder < canonicalBlocks.length; promptOrder += 1) {
      const block = canonicalBlocks[promptOrder]!
      if (!children.has(block)) continue
      savedChildEnabled[encodeLoomBlockOccurrence({ blockId: block.id, promptOrder })] = block.enabled === true
    }
  }
  const toggled = canonicalBlocks.map((block, promptOrder) => {
    if (block === category) {
      return {
        ...block,
        enabled: !disabling,
        savedChildEnabled,
      }
    }
    if (!children.has(block)) return block
    if (disabling) return { ...block, enabled: false }
    const snapshotKey = encodeLoomBlockOccurrence({ blockId: block.id, promptOrder })
    if (!snapshot || !Object.hasOwn(snapshot, snapshotKey)) return block
    return { ...block, enabled: snapshot[snapshotKey] === true }
  })
  return normalizeCategoryBlockState(toggled)
}

type LoomBuilderDependencies = {
  presetsApi?: typeof presetsApi
  agenticRuntimeApi?: typeof agenticRuntimeApi
  saveCoordinator?: PresetSaveCoordinator
  flushPresetForGeneration?: typeof defaultFlushPresetForGeneration
}

interface AgenticRuntimeSaveIdentity {
  presetId: string
  presetRevision: number
  configRevision: number
}

export function useLoomBuilder(dependencies: LoomBuilderDependencies = {}) {
  const presetApi = dependencies.presetsApi ?? presetsApi
  const runtimeApi = dependencies.agenticRuntimeApi ?? agenticRuntimeApi
  const presetSaveCoordinator = useMemo(
    () => dependencies.saveCoordinator ?? (
      dependencies.presetsApi
        ? createPresetSaveCoordinator({
            update: (presetId, input) => presetApi.update(presetId, input),
          })
        : defaultPresetSaveCoordinator
    ),
    [dependencies.presetsApi, dependencies.saveCoordinator, presetApi],
  )
  const flushPresetForGeneration = useMemo(
    () => dependencies.flushPresetForGeneration ?? (
      dependencies.presetsApi || dependencies.saveCoordinator
        ? async (presetId: string | undefined) => {
            if (presetId) await presetSaveCoordinator.flush(presetId)
          }
        : defaultFlushPresetForGeneration
    ),
    [
      dependencies.flushPresetForGeneration,
      dependencies.presetsApi,
      dependencies.saveCoordinator,
      presetSaveCoordinator,
    ],
  )
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)
  const loomRegistry = useStore((s) => s.loomRegistry)
  const setActiveLoomPreset = useStore((s) => s.setActiveLoomPreset)
  const setLoomRegistry = useStore((s) => s.setLoomRegistry)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const profiles = useStore((s) => s.profiles)
  const providers = useStore((s) => s.providers)

  const [activePreset, setActivePreset] = useState<LoomPreset | null>(null)
  const [runtimePresetProfile, setRuntimePresetProfile] = useState<{
    presetId: string
    blockStates: Record<string, boolean>
    promptVariables?: PromptVariableValues
  } | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activePresetRef = useRef<LoomPreset | null>(null)
  const effectiveActivePreset = useMemo(() => {
    if (!activePreset || runtimePresetProfile?.presetId !== activePreset.id) return activePreset
    return {
      ...activePreset,
      blocks: activePreset.blocks.map((block) => (
        block.id in runtimePresetProfile.blockStates
          ? { ...block, enabled: runtimePresetProfile.blockStates[block.id] }
          : block
      )),
      promptVariables: mergePromptVariableValues(
        activePreset.promptVariables,
        runtimePresetProfile.promptVariables,
      ),
    }
  }, [activePreset, runtimePresetProfile])
  const effectiveActivePresetRef = useRef<LoomPreset | null>(effectiveActivePreset)
  effectiveActivePresetRef.current = effectiveActivePreset

  const applyRuntimeBlockProfile = useCallback((
    presetId: string,
    blockStates: Record<string, boolean> | null,
    promptVariables?: PromptVariableValues,
  ) => {
    setRuntimePresetProfile(blockStates
      ? {
          presetId,
          blockStates: { ...blockStates },
          ...(promptVariables ? { promptVariables: structuredClone(promptVariables) } : {}),
        }
      : null)
  }, [])

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
    presetApi.get(activeLoomPresetId).then((preset) => {
      if (cancelled) {
        presetSaveCoordinator.cancelHydration(hydration)
        return
      }
      const loadedPreset = presetSaveCoordinator.hydrate(
        canonicalizeHydratedPreset(unmarshalPreset(preset)),
        hydration,
      )
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
      const result = await presetApi.listRegistry({ provider: 'loom', limit: 200 })
      const registry = Object.fromEntries(
        result.data.map((p) => [
          p.id,
          {
            name: p.name,
            blockCount: p.block_count,
            coverUrl: p.cover_url ?? null,
            updatedAt: p.updated_at,
            isDefault: false,
          },
        ])
      )
      setLoomRegistry(registry)
    } catch (err) {
      console.warn('[LoomBuilder] Failed to refresh registry:', err)
    }
  }, [presetApi, setLoomRegistry])

  const reloadActivePreset = useCallback(async (): Promise<SaveAgenticRuntimeEditorResult> => {
    const presetId = activePresetRef.current?.id ?? activeLoomPresetId
    if (!presetId || useStore.getState().activeLoomPresetId !== presetId) {
      throw new Error('No active preset')
    }
    const result = await runtimeApi.getMatchedEditor(presetId)
    if (useStore.getState().activeLoomPresetId !== presetId) {
      throw new Error('No active preset')
    }
    const reloaded = presetSaveCoordinator.acceptPersisted(
      canonicalizeHydratedPreset(unmarshalPreset(result.preset)),
    )
    if (useStore.getState().activeLoomPresetId !== reloaded.id) {
      throw new Error('No active preset')
    }
    activePresetRef.current = reloaded
    setActivePreset(reloaded)
    setError(null)
    await refreshRegistry()
    return result
  }, [activeLoomPresetId, presetSaveCoordinator, refreshRegistry, runtimeApi])

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
      const created = await presetApi.create(marshalPreset(loom))
      const newLoom = presetSaveCoordinator.hydrate(
        canonicalizeHydratedPreset(unmarshalPreset(created)),
      )
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
  }, [presetApi, presetSaveCoordinator, refreshRegistry])

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
    void presetApi.get(presetId).then((preset) => {
        if (useStore.getState().activeLoomPresetId !== presetId) {
          presetSaveCoordinator.cancelHydration(hydration)
          return
        }
        const restored = presetSaveCoordinator.hydrate(
          canonicalizeHydratedPreset(unmarshalPreset(preset)),
          hydration,
        )
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
      (draft) => canonicalizeHydratedPreset(updater(draft)),
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
      const normalizedBlocks = canonicalizeCategorySnapshots(normalizeCategoryBlockState(blocks))
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
      setRuntimePresetProfile((profile) => profile?.presetId === current.id
        ? {
            presetId: current.id,
            blockStates: Object.fromEntries(normalizedBlocks.map((block) => [block.id, block.enabled])),
            promptVariables: profile.promptVariables,
          }
        : profile)
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
  const saveAgenticRuntime = useCallback(async (
    draft: AgenticRuntimeSaveDraft,
    promptOrder: PromptBlock[],
    expectedIdentity: AgenticRuntimeSaveIdentity,
    acceptSnapshot: (result: SaveAgenticRuntimeEditorResult) => boolean,
  ): Promise<SaveAgenticRuntimeEditorResult> => {
    const current = activePresetRef.current
    if (!current || useStore.getState().activeLoomPresetId !== current.id) {
      throw new Error('No active preset')
    }
    await presetSaveCoordinator.flush(current.id)
    const flushed = presetSaveCoordinator.getDraft(current.id) ?? activePresetRef.current ?? current
    if (
      useStore.getState().activeLoomPresetId !== flushed.id
      || expectedIdentity.presetId !== flushed.id
    ) {
      throw new Error('No active preset')
    }
    activePresetRef.current = flushed
    setActivePreset(flushed)
    const normalizedBlocks = canonicalizeCategorySnapshots(normalizeCategoryBlockState(promptOrder))
    validatePromptVariableSchema(normalizedBlocks, { legacyBaseline: flushed.blocks })
    const preparedConfig = prepareAgentConfigForRuntimeSave(
      draft.config,
      normalizedBlocks,
      expectedIdentity.presetRevision,
    )
    const result = await runtimeApi.saveEditor(flushed.id, {
      ...draft,
      config: preparedConfig,
      expectedPresetRevision: expectedIdentity.presetRevision,
      expectedConfigRevision: expectedIdentity.configRevision,
      promptOrder: normalizedBlocks,
    })
    const authorityChanged = result.editor.presetRevision !== expectedIdentity.presetRevision
      || result.editor.configRevision !== expectedIdentity.configRevision
    if (authorityChanged) commitRuntimeAuthorityMutation()
    const livePreset = activePresetRef.current
    if (
      useStore.getState().activeLoomPresetId !== flushed.id
      || livePreset?.id !== flushed.id
    ) {
      throw new Error('No active preset')
    }
    if (
      (livePreset.cacheRevision ?? 0) > result.editor.presetRevision
      || livePreset.agentConfigRevision > result.editor.configRevision
      || !acceptSnapshot(result)
    ) {
      throw new ApiError(409, 'Conflict', { code: 'AGENT_CONFIG_REVISION_CONFLICT' })
    }
    const refreshed = presetSaveCoordinator.hydrate(
      canonicalizeHydratedPreset(unmarshalPreset(result.preset)),
    )
    activePresetRef.current = refreshed
    setActivePreset(refreshed)
    if (authorityChanged) await refreshRegistry()
    return result
  }, [presetSaveCoordinator, refreshRegistry, runtimeApi])

  const saveLoomValue = useCallback(async (
    blocks: PromptBlock[],
    promptVariables: PromptVariableValues,
  ) => {
    const current = activePresetRef.current
    if (!current || useStore.getState().activeLoomPresetId !== current.id) return
    const normalizedBlocks = canonicalizeCategorySnapshots(normalizeCategoryBlockState(blocks))
    validatePromptVariableSchema(normalizedBlocks, { legacyBaseline: current.blocks })
    const nextBlocks = normalizedBlocks
    setRuntimePresetProfile((profile) => profile?.presetId === current.id
      ? {
          presetId: current.id,
          blockStates: Object.fromEntries(nextBlocks.map((block) => [block.id, block.enabled])),
          promptVariables,
        }
      : profile)
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
        current = presetSaveCoordinator.hydrate(
          canonicalizeHydratedPreset(unmarshalPreset(await presetApi.get(presetId))),
          hydration,
        )
      } catch (error) {
        presetSaveCoordinator.cancelHydration(hydration)
        throw error
      }
    }
    const updated = presetSaveCoordinator.mutate(
      presetId,
      current,
      (draft) => canonicalizeHydratedPreset({ ...draft, name: newName }),
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
    await presetApi.delete(presetId)
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

  const bulkDeletePresets = useCallback(async (presetIds: string[]) => {
    const ids = [...new Set(presetIds)].filter(Boolean)
    if (ids.length === 0) return []
    await Promise.all(ids.map((id) => flushPresetForGeneration(id)))
    const result = await presetsApi.bulkDelete(ids)
    for (const id of result.deleted) presetSaveCoordinator.remove(id)
    await refreshRegistry()
    if (useStore.getState().activeLoomPresetId && result.deleted.includes(useStore.getState().activeLoomPresetId!)) {
      activePresetRef.current = null
      useStore.getState().setActiveLoomPreset(null)
      setActivePreset(null)
    }
    try {
      const res = await connectionsApi.list({ limit: 100 })
      useStore.getState().setProfiles(res.data)
    } catch {
      // Non-fatal; the next profile refresh will pick up cleared references.
    }
    return result.deleted
  }, [refreshRegistry])

  const bulkExportPresets = useCallback(async (presetIds: string[]) => {
    const ids = [...new Set(presetIds)].filter(Boolean)
    if (ids.length === 0) return 0
    await Promise.all(ids.map((id) => flushPresetForGeneration(id)))
    const prepared = await presetsApi.prepareBulkExport(ids)
    presetsApi.downloadPreparedExport(prepared.archiveUrl, prepared.filename)
    return prepared.count
  }, [])

  // Duplicate a preset through the authenticated server operation. The
  // endpoint copies normalized Agentic configuration, authored cognition
  // envelope, bindings, and regex companions transactionally; reconstructing
  // a Loom object locally would silently drop those fields.
  const duplicatePreset = useCallback(async (presetId: string, newName: string) => {
    const selection = beginActiveLoomPresetSelection()
    setIsLoading(true)
    try {
      await flushPresetForGeneration(presetId)
      const duplicated = await presetApi.duplicate(presetId, newName)
      const newLoom = presetSaveCoordinator.hydrate(
        canonicalizeHydratedPreset(unmarshalPreset(duplicated.preset)),
      )
      await refreshRegistry()
      if (await selection.transition(duplicated.preset.id)) {
        activePresetRef.current = newLoom
        setActivePreset(newLoom)
      }
      return newLoom
    } catch (err: unknown) {
      selection.cancel()
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [flushPresetForGeneration, presetApi, presetSaveCoordinator, refreshRegistry])

  // Block manipulation helpers
  const addBlock = useCallback((block: PromptBlock, index?: number) => {
    const current = effectiveActivePresetRef.current
    if (!current) return
    const blocks = [...current.blocks]
    if (typeof index === 'number') {
      blocks.splice(index, 0, block)
    } else {
      blocks.push(block)
    }
    saveBlocks(blocks)
  }, [saveBlocks])

  const removeBlock = useCallback(async (
    target: LoomBlockOccurrence,
    replacement?: { blocks: PromptBlock[]; promptVariables?: PromptVariableValues },
  ) => {
    const current = effectiveActivePresetRef.current
    if (!current) return
    const sourceBlocks = replacement?.blocks ?? current.blocks
    const targetBlock = getLoomBlockAtOccurrence(sourceBlocks, target)
    if (!targetBlock) return
    const categoryChildPromptOrders = new Set<number>()
    if (targetBlock.marker === 'category') {
      const children = new Set(
        computeGroups(sourceBlocks).find((group) => group.categoryBlock === targetBlock)?.children ?? [],
      )
      for (let promptOrder = 0; promptOrder < sourceBlocks.length; promptOrder += 1) {
        if (children.has(sourceBlocks[promptOrder]!)) categoryChildPromptOrders.add(promptOrder)
      }
    }
    let entries: LoomBlockReorderEntry[] = sourceBlocks
      .map((block, promptOrder) => ({ block, source: { blockId: block.id, promptOrder } }))
      .filter((entry) => entry.source.promptOrder !== target.promptOrder)
    const duplicateIdRemains = entries.some((entry) => entry.block.id === target.blockId)
    // Persisted group links are ID-scoped. Exact category child coordinates are
    // released directly; ID-wide orphan cleanup waits until the last duplicate is gone.
    const orphanedGroupId = duplicateIdRemains ? null : target.blockId
    entries = entries.map((entry) => (
      categoryChildPromptOrders.has(entry.source.promptOrder)
      || (orphanedGroupId !== null && entry.block.group === orphanedGroupId)
        ? { ...entry, block: { ...entry.block, group: null } }
        : entry
    ))
    const blocks = remapCategorySnapshotsForReorder(sourceBlocks, entries)
    const promptVariables = { ...(replacement?.promptVariables ?? current.promptVariables ?? {}) }
    if (!duplicateIdRemains) delete promptVariables[target.blockId]
    await saveLoomValue(blocks, promptVariables)
  }, [saveLoomValue])

  const updateBlock = useCallback((target: LoomBlockOccurrence, updates: Partial<PromptBlock>): boolean => {
    const current = effectiveActivePresetRef.current
    if (!current) return false
    const targetBlock = getLoomBlockAtOccurrence(current.blocks, target)
    if (!targetBlock) return false
    const blocks = [...current.blocks]
    blocks[target.promptOrder] = { ...targetBlock, ...updates }
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

  const toggleBlock = useCallback((target: LoomBlockOccurrence) => {
    const current = effectiveActivePresetRef.current
    if (!current) return
    const blocks = toggleBlockAtOccurrence(current.blocks, target)
    if (blocks === current.blocks) return
    void saveBlocks(blocks)
  }, [saveBlocks])

  // Blanket category toggle: disable captures each child's enabled state on
  // the category block; enable restores that exact snapshot.
  const toggleCategoryChildren = useCallback((target: LoomBlockOccurrence) => {
    const current = effectiveActivePresetRef.current
    if (!current) return
    const blocks = toggleCategoryAtOccurrence(current.blocks, target)
    if (blocks === current.blocks) return
    void saveBlocks(blocks)
  }, [saveBlocks])

  /**
   * Move a variable definition from one exact block occurrence to another,
   * carrying its saved value bucket along. Def and value travel together in
   * a single saveLoomValue so backend orphan pruning never sees the value
   * stranded under the old block.
   */
  const movePromptVariable = useCallback((
    sourceTarget: LoomBlockOccurrence,
    variable: PromptVariableDef,
    targetTarget: LoomBlockOccurrence,
  ): boolean => {
    const current = effectiveActivePresetRef.current
    if (!current || !canMovePromptVariableBetweenOccurrences(sourceTarget, targetTarget)) return false
    const sourceBlock = getLoomBlockAtOccurrence(current.blocks, sourceTarget)
    const targetBlock = getLoomBlockAtOccurrence(current.blocks, targetTarget)
    if (!sourceBlock || !targetBlock) return false

    const name = variable.name?.trim()
    if (!name) return false
    if ((targetBlock.variables ?? []).some((candidate) => candidate.name?.trim() === name)) return false

    const blocks = current.blocks.map((block, promptOrder) => {
      if (promptOrder === sourceTarget.promptOrder) {
        const next: Partial<PromptBlock> = {
          variables: (block.variables ?? []).filter((candidate) => candidate.id !== variable.id),
        }
        if (block.placementBinding?.variableId === variable.id) next.placementBinding = undefined
        return { ...block, ...next }
      }
      if (promptOrder === targetTarget.promptOrder) {
        return { ...block, variables: [...(block.variables ?? []), variable] }
      }
      return block
    })

    const values = current.promptVariables ?? {}
    const sourceBucket = values[sourceTarget.blockId]
    const savedName = (sourceBlock.variables ?? []).find((candidate) => candidate.id === variable.id)?.name?.trim()
    let nextValues = values
    if (sourceBucket) {
      const valueKey = savedName && savedName in sourceBucket
        ? savedName
        : name in sourceBucket
          ? name
          : null
      if (valueKey !== null) {
        const nextSource = { ...sourceBucket }
        const moved = nextSource[valueKey]
        delete nextSource[valueKey]
        nextValues = {
          ...values,
          [sourceTarget.blockId]: nextSource,
          [targetTarget.blockId]: { ...(values[targetTarget.blockId] ?? {}), [name]: moved },
        }
      }
    }

    let normalizedBlocks: PromptBlock[]
    try {
      normalizedBlocks = normalizeCategoryBlockState(blocks)
      validatePromptVariableSchema(normalizedBlocks, { legacyBaseline: current.blocks })
    } catch {
      return false
    }
    void saveLoomValue(normalizedBlocks, nextValues).catch(() => {})
    return true
  }, [saveLoomValue])

  const reorderBlocks = useCallback((fromIndex: number, toIndex: number) => {
    const current = effectiveActivePresetRef.current
    if (!current) return
    const blocks = [...current.blocks]
    const [moved] = blocks.splice(fromIndex, 1)
    blocks.splice(toIndex, 0, moved)
    saveBlocks(blocks)
  }, [saveBlocks])

  // Save sampler overrides — immediate state update, debounced API save
  const saveSamplerOverrides = useCallback((overrides: any) => {
    updateActivePreset((current) => ({
      ...current,
      samplerOverrides: { ...overrides },
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
      (draft) => canonicalizeHydratedPreset({ ...draft, promptVariables: values }),
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
  const persistImportedPreset = useCallback(async (payload: unknown, fileName?: string) => {
    const selection = beginActiveLoomPresetSelection()
    let importedPresetId: string | null = null
    let portableImportCommitted = false
    let hydrationWarning = false
    setIsLoading(true)
    try {
      const fallbackName = fileName?.replace(/\.json$/i, '') || 'Imported Preset'
      const payloadRecord = isObjectRecord(payload) ? payload : null
      const agentRuntime = extractPortableAgenticRuntimeEnvelope(payload)
      const sourceRecord = payloadRecord?.type === 'lumiverse_preset'
        && isObjectRecord(payloadRecord.preset)
        ? payloadRecord.preset
        : payloadRecord
      const embeddedRegex = readPortableRegexSource(sourceRecord)
      const loom = coerceImportedLoomPreset(payload, fallbackName)
      if (agentRuntime === null && hasLegacyPortableAgenticRuntimeGraph(loom)) {
        throw new PortablePresetError('AGENT_RUNTIME_PORTABLE_INVALID')
      }
      const presetInput = marshalPreset(loom)
      const portablePresetInput = embeddedRegex === null
        ? presetInput
        : {
            ...presetInput,
            regex_scripts: embeddedRegex as unknown as readonly Record<string, unknown>[],
          }
      const legacyPortableConfig = agentRuntime === null && loom.agentConfig
        ? toPortableAgentConfigV1(loom.agentConfig)
        : null
      // Sealed prompt descriptors have no local content to persist. Even
      // without an authored runtime envelope, send them through the
      // transactional portable-import endpoint so the server resolves and
      // verifies every sealed block before writing the preset row.
      const sealedImportRuntime = agentRuntime === null
        && legacyPortableConfig === null
        && loom.portableSealedPreset !== undefined
        && loom.portableSealedPreset !== null
        ? createEmptyPortableAgenticRuntimeEnvelope()
        : null
      const portableImportRuntime = agentRuntime ?? sealedImportRuntime
      let created = portableImportRuntime
        ? (await presetApi.importPortable({
            preset: portablePresetInput,
            agentRuntime: portableImportRuntime,
          })).preset
        : legacyPortableConfig
          ? (await presetApi.importPortableAgentConfig({
              ...portablePresetInput,
              agent_config: legacyPortableConfig,
            })).preset
          : await presetApi.create(portablePresetInput)
      importedPresetId = created.id
      portableImportCommitted = portableImportRuntime !== null || legacyPortableConfig !== null

      if (agentRuntime) {
        try {
          const editor = await runtimeApi.getEditor(created.id)
          created = {
            ...created,
            agent_config: editor.config,
            agent_config_review: editor.review,
            agent_task_templates: editor.taskTemplates,
          }
        } catch {
          hydrationWarning = true
        }
      }

      const newLoom = presetSaveCoordinator.hydrate(
        canonicalizeHydratedPreset(unmarshalPreset(created)),
      )
      try {
        await refreshRegistry()
      } catch {
        hydrationWarning = true
      }
      if (!(await selection.transition(created.id))) {
        return newLoom
      }
      activePresetRef.current = newLoom
      setActivePreset(newLoom)
      if (hydrationWarning) {
        toast.warning(i18n.t('panels.loomBuilder.toast.importHydrationWarning'), {
          title: i18n.t('panels.loomBuilder.toast.presetImportTitle'),
        })
      }
      return newLoom
    } catch (err: unknown) {
      // Portable import is one backend transaction that also owns newly
      // imported sealed runtime material. Never delete that preset after the
      // transaction has committed; a navigation/editor hydration failure must
      // preserve the completed import and its canonical runtime data.
      if (shouldRollbackImportedPreset(importedPresetId, portableImportCommitted)) {
        try {
          await presetApi.delete(importedPresetId)
        } catch {
          // Cleanup is best-effort for the legacy create-only path.
        }
      }
      selection.cancel()
      setError(getPortablePresetErrorCode(err))
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [presetApi, presetSaveCoordinator, refreshRegistry, runtimeApi])

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

  // Export internal JSON. The runtime envelope is fetched from the server
  // after all pending Loom saves settle, so prompt revisions and task metadata
  // cannot drift across the export boundary. An explicit target id keeps the
  // upstream preset-manager export action functional for non-active presets.
  const exportInternal = useCallback(async (presetId?: string) => {
    const targetId = presetId ?? activePresetRef.current?.id ?? activePreset?.id
    if (!targetId) return null
    const maxAttempts = 2
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await flushPresetForGeneration(targetId)
      const persistedBefore = await presetApi.get(targetId)
      const envelopeBefore = await presetApi.getPortableAgentRuntime(targetId)
      const regexBefore = await regexApi.exportScripts(undefined, { preset_id: targetId })
      const persistedAfter = await presetApi.get(targetId)
      const envelopeAfter = await presetApi.getPortableAgentRuntime(targetId)
      const regexAfter = await regexApi.exportScripts(undefined, { preset_id: targetId })
      const presetStable = persistedBefore.cache_revision === persistedAfter.cache_revision
        && persistedBefore.updated_at === persistedAfter.updated_at
      const envelopeStable = portableSnapshotKey(envelopeBefore) === portableSnapshotKey(envelopeAfter)
      const regexBeforePortable = stripPortableRegexOwnership(regexBefore.scripts)
      const regexAfterPortable = stripPortableRegexOwnership(regexAfter.scripts)
      const regexStable = portableSnapshotKey(regexBeforePortable) === portableSnapshotKey(regexAfterPortable)
      if (!presetStable || !envelopeStable || !regexStable) {
        if (attempt + 1 < maxAttempts) continue
        throw new PortablePresetError('PORTABLE_EXPORT_UNSTABLE')
      }
      const exportPreset = createPortableLoomExportPayload(unmarshalPreset(persistedAfter), envelopeAfter)
      if (regexAfterPortable.length === 0) return exportPreset
      const extensions = isObjectRecord(exportPreset.extensions)
        ? { ...exportPreset.extensions }
        : {}
      return {
        ...exportPreset,
        extensions: {
          ...extensions,
          regex_scripts: regexAfterPortable,
        },
      }
    }
    return null
  }, [activePreset, flushPresetForGeneration])

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
    const profile = profiles.find((p) => p.id === activeProfileId && p.review_required !== true)
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
    activePreset: effectiveActivePreset?.id === activeLoomPresetId ? effectiveActivePreset : null,
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
    DEFAULT_PROMPT_BEHAVIOR,
    DEFAULT_COMPLETION_SETTINGS,
    DEFAULT_ADVANCED_SETTINGS,

    // Preset CRUD
    createPreset,
    selectPreset,
    saveBlocks,
    saveLoomValue,
    saveAgenticRuntime,
    deletePreset,
    bulkDeletePresets,
    bulkExportPresets,
    duplicatePreset,
    renamePreset,
    refreshRegistry,
    reloadActivePreset,

    // Block manipulation
    addBlock,
    removeBlock,
    updateBlock,
    toggleBlock,
    toggleCategoryChildren,
    reorderBlocks,
    movePromptVariable,

    // Sampler settings
    saveSamplerOverrides,

    // Prompt behavior, completion, advanced
    savePromptBehavior,
    saveCompletionSettings,
    saveAdvancedSettings,
    savePromptVariableValues,
    applyRuntimeBlockProfile,
    updatePresetDraft: updateActivePreset,
    flushPresetDraft: flushPendingPreset,

    // Import/Export
    importFromFile,
    importFromST,
    exportInternal,
    exportLegacy,
  }
}
