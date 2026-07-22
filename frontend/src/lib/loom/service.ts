import type { PromptBlockDTO, PromptVariableDefDTO, PromptVariableOptionDTO, PromptVariableValuesDTO } from 'lumiverse-spindle-types'
import type { Preset, CreatePresetInput, UpdatePresetInput, ProviderInfo } from '@/types/api'
import type {
  PromptBlock,
  PromptBlockPlacement,
  PromptVariableValue,
  PromptVariableDef,
  PromptVariableValues,
  LoomPreset,
  LoomRegistryEntry,
  LoomConnectionProfile,
  MacroGroup,
  CategoryGroup,
} from './types'
import { sanitizeCharacterTagTrigger } from './characterTagTrigger'
import { generateUUID } from '@/lib/uuid'
import {
  MARKER_NAMES,
  STRUCTURAL_MARKERS,
  CONTENT_BEARING_MARKERS,
  DEFAULT_SAMPLER_OVERRIDES,
  DEFAULT_CUSTOM_BODY,
  DEFAULT_PROMPT_BEHAVIOR,
  DEFAULT_COMPLETION_SETTINGS,
  DEFAULT_ADVANCED_SETTINGS,
  PROVIDER_PARAMS,
  DEFAULT_PROVIDER_PARAMS,
  CATEGORY_MARKER,
  WIKI_CATEGORY_PATTERN,
  WIKI_SUBCATEGORY_PATTERN,
  ST_IDENTIFIER_TO_MARKER,
  MARKER_TO_ST_IDENTIFIER,
} from './constants'

// ============================================================================
// BLOCK FACTORY
// ============================================================================

export function createBlock(overrides: Partial<PromptBlock> = {}): PromptBlock {
  return {
    id: generateUUID(),
    name: 'New Chat',
    content: '',
    role: 'system',
    enabled: true,
    position: 'pre_history',
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    characterTagTrigger: [],
    group: null,
    categoryMode: null,
    ...overrides,
  }
}

export function createMarkerBlock(markerType: string, name?: string): PromptBlock {
  const displayName = name || MARKER_NAMES[markerType] || markerType
  const isStructural = STRUCTURAL_MARKERS.has(markerType)

  return createBlock({
    name: markerType === 'category' ? (name || 'Category') : displayName,
    marker: markerType,
    content: '',
    isLocked: isStructural,
  })
}

function isPromptBlockPlacement(value: unknown): value is PromptBlockPlacement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const placement = value as Partial<PromptBlockPlacement>
  return (
    (placement.role === 'system' || placement.role === 'user' || placement.role === 'assistant' || placement.role === 'user_append' || placement.role === 'assistant_append')
    && (placement.position === 'pre_history' || placement.position === 'post_history' || placement.position === 'in_history')
    && typeof placement.depth === 'number'
    && Number.isFinite(placement.depth)
    && placement.depth >= 0
  )
}

/**
 * Project select-variable placement bindings for UI surfaces that need to
 * display the same role/position/depth the prompt assembler will use. This is
 * read-only and leaves each preset block's persisted fallback unchanged.
 */
export function resolvePromptBlockPlacements(
  blocks: PromptBlock[],
  values: PromptVariableValues,
): PromptBlock[] {
  return blocks.map((block) => {
    const binding = block.placementBinding
    if (
      !binding
      || typeof binding.variableId !== 'string'
      || !binding.variableId
      || !binding.options
      || typeof binding.options !== 'object'
      || Array.isArray(binding.options)
    ) return block

    const selector = block.variables?.find(
      (variable): variable is Extract<PromptVariableDef, { type: 'select' }> => (
        variable.id === binding.variableId && variable.type === 'select'
      ),
    )
    if (!selector) return block

    const validIds = new Set(selector.options.map((option) => option.id))
    const configured = values[block.id]?.[selector.name]
    const fallback = validIds.has(selector.defaultValue)
      ? selector.defaultValue
      : selector.options[0]?.id ?? ''
    const selectedId = typeof configured === 'string' && validIds.has(configured)
      ? configured
      : fallback
    if (!selectedId || !Object.prototype.hasOwnProperty.call(binding.options, selectedId)) return block

    const placement = binding.options[selectedId]
    if (!isPromptBlockPlacement(placement)) return block
    return {
      ...block,
      role: placement.role,
      position: placement.position,
      depth: Math.floor(placement.depth),
    }
  })
}

function projectPublicPromptVariableOption(option: PromptVariableOptionDTO): PromptVariableOptionDTO {
  return {
    id: option.id,
    label: option.label,
    value: option.value,
  }
}

function projectPublicPromptVariable(variable: PromptVariableDef): PromptVariableDefDTO {
  const projected: Record<string, unknown> = {
    id: variable.id,
    name: variable.name,
    label: variable.label,
    type: variable.type,
    defaultValue: Array.isArray(variable.defaultValue)
      ? [...variable.defaultValue]
      : variable.defaultValue,
  }
  if (variable.description !== undefined) projected.description = variable.description
  if (variable.type === 'textarea' && variable.rows !== undefined) projected.rows = variable.rows
  if ((variable.type === 'number' || variable.type === 'slider') && variable.min !== undefined) {
    projected.min = variable.min
  }
  if ((variable.type === 'number' || variable.type === 'slider') && variable.max !== undefined) {
    projected.max = variable.max
  }
  if ((variable.type === 'number' || variable.type === 'slider') && variable.step !== undefined) {
    projected.step = variable.step
  }
  if (variable.type === 'select' || variable.type === 'multiselect') {
    projected.options = variable.options.map(projectPublicPromptVariableOption)
  }
  if (variable.type === 'multiselect' && variable.separator !== undefined) {
    projected.separator = variable.separator
  }
  return projected as PromptVariableDefDTO
}

export function projectPublicPromptBlock(block: PromptBlock): PromptBlockDTO {
  const projected: PromptBlockDTO = {
    id: block.id,
    name: block.name,
    content: block.content,
    role: block.role,
    enabled: block.enabled,
    position: block.position,
    depth: block.depth,
    marker: block.marker,
    isLocked: block.isLocked,
    color: block.color,
    injectionTrigger: [...block.injectionTrigger],
    characterTagTrigger: [...(block.characterTagTrigger ?? [])],
    group: block.group ?? null,
    categoryMode: block.categoryMode ?? null,
  }
  if (block.variables !== undefined) {
    projected.variables = block.variables.map(projectPublicPromptVariable)
  }
  return projected
}

export function projectPublicPromptBlocks(blocks: PromptBlock[]): PromptBlockDTO[] {
  return blocks.map(projectPublicPromptBlock)
}

// ============================================================================
// PRESET MIGRATION
// ============================================================================

function migratePreset(preset: LoomPreset): LoomPreset {
  preset.samplerOverrides = { ...DEFAULT_SAMPLER_OVERRIDES, ...(preset.samplerOverrides || {}) }
  preset.customBody = { ...DEFAULT_CUSTOM_BODY, ...(preset.customBody || {}) }
  preset.promptBehavior = { ...DEFAULT_PROMPT_BEHAVIOR, ...(preset.promptBehavior || {}) }
  preset.completionSettings = { ...DEFAULT_COMPLETION_SETTINGS, ...(preset.completionSettings || {}) }
  preset.advancedSettings = { ...DEFAULT_ADVANCED_SETTINGS, ...(preset.advancedSettings || {}) }
  if (!preset.modelProfiles) preset.modelProfiles = {}
  if (!preset.lastProfileKey) preset.lastProfileKey = null
  preset.coverUrl = typeof preset.coverUrl === 'string' && preset.coverUrl.trim()
    ? preset.coverUrl.trim()
    : null
  preset.presetVersion = typeof preset.presetVersion === 'string' && preset.presetVersion.trim()
    ? preset.presetVersion.trim()
    : null
  preset.lumihubMeta = isRecord(preset.lumihubMeta) ? preset.lumihubMeta : null
  preset.passthroughMetadata = isRecord(preset.passthroughMetadata) ? preset.passthroughMetadata : {}
  if (Array.isArray(preset.blocks)) {
    for (const block of preset.blocks) {
      if (!Array.isArray(block.injectionTrigger)) {
        block.injectionTrigger = []
      }
      block.characterTagTrigger = sanitizeCharacterTagTrigger(block.characterTagTrigger)
      block.categoryMode = block.marker === 'category'
        ? coerceCategoryMode(block.categoryMode)
        : null
      if (block.sealedSource === 'lumihub') {
        block.sealed = true
      }
      if (block.sealed !== true) {
        delete block.sealed
        delete block.sealedKey
        delete block.sealedSource
        delete block.sealedOriginPresetId
        delete block.sealedOriginVersion
        delete block.sealedSha256
      } else if (typeof block.sealedKey !== 'string') {
        block.sealedKey = block.id
      }
    }
  }
  preset.blocks = normalizeCategoryBlockState(preset.blocks || [])
  return preset
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Version key is surfaced separately as `presetVersion`; the rest of the bag round-trips verbatim. */
const LUMIHUB_VERSION_META_KEY = '_lumiverse_preset_version'
const LOOM_OWNED_META_KEYS = new Set([
  'source',
  'modelProfiles',
  'schemaVersion',
  'description',
  'coverUrl',
  'cover_url',
  'isDefault',
  'lastProfileKey',
  'promptVariables',
])

export function isLoomOwnedPresetMetadataKey(key: string): boolean {
  return LOOM_OWNED_META_KEYS.has(key) || key.startsWith('_lumiverse_')
}

/**
 * Pull the LumiHub provenance bag (install source, hub id, slug, creator) out of a stored
 * preset's metadata so it survives the marshal/unmarshal round-trip. `marshalUpdate` rewrites
 * the metadata column wholesale, so without this these fields would be wiped on the first edit,
 * breaking manifest sync and re-install update tracking. The version key is excluded — it is
 * surfaced as `presetVersion` and re-applied authoritatively on marshal.
 */
function extractLumihubMeta(meta: Record<string, any>): Record<string, unknown> | null {
  const bag: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (key.startsWith('_lumiverse_') && key !== LUMIHUB_VERSION_META_KEY) {
      bag[key] = value
    }
  }
  return Object.keys(bag).length > 0 ? bag : null
}

function extractPassthroughMetadata(meta: Record<string, any>): Record<string, unknown> {
  const bag: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (isLoomOwnedPresetMetadataKey(key)) continue
    bag[key] = value
  }
  return bag
}

function hasLegacyPromptOrderShape(promptOrder: unknown): boolean {
  if (Array.isArray(promptOrder)) {
    return promptOrder.some((entry) => isRecord(entry) && Array.isArray(entry.order))
  }
  if (isRecord(promptOrder)) {
    return Object.values(promptOrder).some((entry) => isRecord(entry) && Array.isArray(entry.order))
  }
  return false
}

export function looksLikeLegacyPresetData(data: unknown): data is STPresetData {
  return isRecord(data)
    && (Array.isArray(data.prompts) || hasLegacyPromptOrderShape(data.prompt_order))
}

export function looksLikeBackendLoomPresetData(data: unknown): data is Preset {
  return isRecord(data)
    && Array.isArray(data.prompt_order)
    && isRecord(data.parameters)
    && isRecord(data.prompts)
    && isRecord(data.metadata)
}

export function looksLikeLoomPresetData(data: unknown): data is LoomPreset {
  return isRecord(data) && Array.isArray(data.blocks)
}

export function detectImportedPresetKind(data: unknown): 'loom' | 'legacy' | null {
  if (looksLikeWrappedLumiHubPresetData(data) || looksLikeLoomPresetData(data) || looksLikeBackendLoomPresetData(data)) {
    return 'loom'
  }

  if (looksLikeLegacyPresetData(data)) {
    return 'legacy'
  }

  return null
}

export function coerceImportedLoomPreset(data: unknown, fallbackName: string): LoomPreset {
  if (looksLikeWrappedLumiHubPresetData(data)) {
    return migratePreset({
      ...data.preset,
      name: data.preset.name || fallbackName,
      coverUrl: typeof data.cover_url === 'string' ? data.cover_url : null,
    } as LoomPreset)
  }

  if (looksLikeLoomPresetData(data)) {
    return migratePreset({
      ...data,
      name: data.name || fallbackName,
    })
  }

  if (looksLikeBackendLoomPresetData(data)) {
    return unmarshalPreset(data)
  }

  if (looksLikeLegacyPresetData(data)) {
    return importFromSTPreset(data, fallbackName)
  }

  throw new Error('Unrecognized preset JSON format')
}

function looksLikeWrappedLumiHubPresetData(data: unknown): data is { preset: LoomPreset; cover_url?: unknown } {
  return isRecord(data)
    && data.type === 'lumiverse_preset'
    && isRecord(data.preset)
    && Array.isArray(data.preset.blocks)
}

function coerceCategoryMode(mode: unknown): PromptBlock['categoryMode'] {
  return mode === 'radio' || mode === 'checkbox' ? mode : null
}

function normalizeCategoryGroups(blocks: PromptBlock[]): PromptBlock[] {
  let currentCategoryId: string | null = null
  return blocks.map((block) => {
    if (block.marker === 'category') {
      currentCategoryId = block.id
      return { ...block, group: null }
    }

    if (block.group !== undefined) {
      return { ...block, group: block.group || null }
    }

    return { ...block, group: currentCategoryId }
  })
}

export function normalizeCategoryBlockState(
  blocks: PromptBlock[],
  preferredBlockIdByCategory?: Map<string, string>,
): PromptBlock[] {
  const normalizedBlocks = normalizeCategoryGroups(blocks.map((block) => ({
    ...block,
    categoryMode: block.marker === 'category'
      ? coerceCategoryMode(block.categoryMode)
      : null,
  })))

  for (const group of computeGroups(normalizedBlocks)) {
    if (!group.categoryBlock || group.categoryBlock.categoryMode !== 'radio') continue

    const enabledChildren = group.children.filter((block) => block.enabled)
    if (enabledChildren.length <= 1) continue

    const preferredId = preferredBlockIdByCategory?.get(group.categoryBlock.id)
    const keepId = preferredId && enabledChildren.some((block) => block.id === preferredId)
      ? preferredId
      : enabledChildren[0].id

    for (let index = 0; index < normalizedBlocks.length; index += 1) {
      const block = normalizedBlocks[index]
      if (
        block.id !== keepId &&
        group.children.some((child) => child.id === block.id) &&
        block.enabled
      ) {
        normalizedBlocks[index] = { ...block, enabled: false }
      }
    }
  }

  return normalizedBlocks
}

export function toggleBlockWithCategoryRules(
  blocks: PromptBlock[],
  blockId: string,
): PromptBlock[] {
  const target = blocks.find((block) => block.id === blockId)
  if (!target) return blocks

  const categoryGroup = computeGroups(blocks).find((group) => (
    group.categoryBlock?.categoryMode === 'radio' &&
    group.children.some((child) => child.id === blockId)
  ))

  if (!categoryGroup?.categoryBlock) {
    return blocks.map((block) => (
      block.id === blockId ? { ...block, enabled: !block.enabled } : block
    ))
  }

  return blocks.map((block) => {
    if (!categoryGroup.children.some((child) => child.id === block.id)) return block
    return { ...block, enabled: block.id === blockId }
  })
}

// ============================================================================
// MARSHAL / UNMARSHAL — Convert between Loom shape and backend API shape
// ============================================================================

export function marshalPreset(loom: LoomPreset): CreatePresetInput {
  const blocks = normalizeCategoryBlockState(loom.blocks)
  return {
    name: loom.name,
    provider: 'loom',
    parameters: {
      samplerOverrides: loom.samplerOverrides,
      customBody: loom.customBody,
    },
    prompt_order: blocks,
    prompts: {
      promptBehavior: loom.promptBehavior,
      completionSettings: loom.completionSettings,
      advancedSettings: loom.advancedSettings,
    },
    metadata: {
      ...extractPassthroughMetadata(loom.passthroughMetadata ?? {}),
      source: loom.source,
      modelProfiles: loom.modelProfiles,
      schemaVersion: loom.schemaVersion,
      description: loom.description,
      coverUrl: loom.coverUrl ?? null,
      isDefault: loom.isDefault,
      lastProfileKey: loom.lastProfileKey,
      promptVariables: pruneOrphanPromptVariables(loom.promptVariables, blocks),
      // Preserve LumiHub provenance + version so an edit doesn't strip them from the metadata column.
      ...(loom.lumihubMeta ?? {}),
      ...(loom.presetVersion ? { _lumiverse_preset_version: loom.presetVersion } : {}),
    },
  }
}

export function unmarshalPreset(preset: Preset): LoomPreset {
  const params = preset.parameters || {}
  const prompts = preset.prompts || {}
  const meta = preset.metadata || {}

  const loom: LoomPreset = {
    id: preset.id,
    name: preset.name,
    description: meta.description || '',
    coverUrl: typeof meta.coverUrl === 'string' ? meta.coverUrl : (typeof meta.cover_url === 'string' ? meta.cover_url : null),
    presetVersion: typeof meta._lumiverse_preset_version === 'string' ? meta._lumiverse_preset_version : null,
    lumihubMeta: extractLumihubMeta(meta),
    passthroughMetadata: extractPassthroughMetadata(meta),
    schemaVersion: meta.schemaVersion || 1,
    createdAt: preset.created_at,
    updatedAt: preset.updated_at,
    ...(typeof preset.cache_revision === 'number' ? { cacheRevision: preset.cache_revision } : {}),
    blocks: (preset.prompt_order || []) as PromptBlock[],
    source: meta.source || null,
    isDefault: meta.isDefault || false,
    samplerOverrides: params.samplerOverrides || { ...DEFAULT_SAMPLER_OVERRIDES },
    customBody: params.customBody || { ...DEFAULT_CUSTOM_BODY },
    promptBehavior: prompts.promptBehavior || { ...DEFAULT_PROMPT_BEHAVIOR },
    completionSettings: prompts.completionSettings || { ...DEFAULT_COMPLETION_SETTINGS },
    advancedSettings: prompts.advancedSettings || { ...DEFAULT_ADVANCED_SETTINGS },
    modelProfiles: meta.modelProfiles || {},
    lastProfileKey: meta.lastProfileKey || null,
    promptVariables: meta.promptVariables && typeof meta.promptVariables === 'object'
      ? meta.promptVariables
      : {},
  }

  return migratePreset(loom)
}

export function marshalUpdate(loom: LoomPreset): UpdatePresetInput {
  const blocks = normalizeCategoryBlockState(loom.blocks)
  return {
    name: loom.name,
    ...(typeof loom.cacheRevision === 'number'
      ? { expected_cache_revision: loom.cacheRevision }
      : {}),
    parameters: {
      samplerOverrides: loom.samplerOverrides,
      customBody: loom.customBody,
    },
    prompt_order: blocks,
    prompts: {
      promptBehavior: loom.promptBehavior,
      completionSettings: loom.completionSettings,
      advancedSettings: loom.advancedSettings,
    },
    metadata: {
      ...extractPassthroughMetadata(loom.passthroughMetadata ?? {}),
      source: loom.source,
      modelProfiles: loom.modelProfiles,
      schemaVersion: loom.schemaVersion,
      description: loom.description,
      coverUrl: loom.coverUrl ?? null,
      isDefault: loom.isDefault,
      lastProfileKey: loom.lastProfileKey,
      promptVariables: pruneOrphanPromptVariables(loom.promptVariables, blocks),
      // Preserve LumiHub provenance + version so an edit doesn't strip them from the metadata column.
      ...(loom.lumihubMeta ?? {}),
      ...(loom.presetVersion ? { _lumiverse_preset_version: loom.presetVersion } : {}),
    },
  }
}

export function sanitizeLumiHubSealedBlocksForExport<T extends LoomPreset>(loom: T): T {
  const manifestKeys = getLumiHubSealedManifestKeys(loom)
  if (!manifestKeys.size && !loom.blocks.some((block) => isLumiHubSealedBlock(block))) return loom

  return {
    ...loom,
    blocks: loom.blocks.map((block) => {
      const key = getLumiHubSealedExportKey(block, manifestKeys)
      if (!key) return block
      return {
        ...block,
        content: sealedPresetBlockPlaceholder(key),
        sealed: true,
        sealedKey: key,
      }
    }),
  }
}

function getLumiHubSealedExportKey(block: PromptBlock, manifestKeys: Set<string>): string | null {
  const sealedKey = typeof block.sealedKey === 'string' && block.sealedKey.trim() ? block.sealedKey.trim() : null
  if (sealedKey && (block.sealedSource === 'lumihub' || manifestKeys.has(sealedKey))) return sealedKey

  const placeholderKey = extractExactSealedPlaceholder(block.content || '')
  if (placeholderKey && manifestKeys.has(placeholderKey)) return placeholderKey

  return null
}

function isLumiHubSealedBlock(block: PromptBlock): boolean {
  return block.sealedSource === 'lumihub'
}

function getLumiHubSealedManifestKeys(loom: LoomPreset): Set<string> {
  const sealedPreset = isRecord(loom.lumihubMeta?._lumiverse_sealed_preset)
    ? loom.lumihubMeta._lumiverse_sealed_preset
    : null
  const blocks = Array.isArray(sealedPreset?.blocks) ? sealedPreset.blocks : []
  const keys = new Set<string>()
  for (const block of blocks) {
    if (isRecord(block) && typeof block.key === 'string' && block.key.trim()) {
      keys.add(block.key.trim())
    }
  }
  return keys
}

function sealedPresetBlockPlaceholder(key: string): string {
  return `{{presetBlock::${key}}}`
}

function extractExactSealedPlaceholder(content: string): string | null {
  const match = content.trim().match(/^\{\{(?:presetBlock|pblock)::([^}]+)\}\}$/)
  return match?.[1]?.trim() || null
}

function hasEnumerableDataProperty(value: unknown, key: string): { value: unknown } | null {
  if (!value || typeof value !== 'object') return null
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
    return { value: descriptor.value }
  } catch {
    return null
  }
}

function clonePromptVariableValue(value: unknown): PromptVariableValue | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!Array.isArray(value)) return undefined

  const length = readOwnDataProperty(value, 'length')
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return undefined
  let ownKeys: (string | symbol)[]
  let enumerableKeys: string[]
  try {
    ownKeys = Reflect.ownKeys(value)
    enumerableKeys = Object.keys(value)
  } catch {
    return undefined
  }
  if (enumerableKeys.length !== length) return undefined
  for (const key of ownKeys) {
    if (
      key !== 'length'
      && (
        typeof key !== 'string'
        || !/^(0|[1-9]\d*)$/.test(key)
        || Number(key) >= length
      )
    ) {
      return undefined
    }
  }
  const entries: string[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = hasEnumerableDataProperty(value, String(index))
    if (!descriptor || typeof descriptor.value !== 'string') return undefined
    entries.push(descriptor.value)
  }
  return entries
}

function isPromptVariableValueCompatible(
  variable: PromptVariableDef,
  value: PromptVariableValue,
): boolean {
  if (variable.type === 'text' || variable.type === 'textarea') {
    return typeof value === 'string'
  }
  if (variable.type === 'number' || variable.type === 'slider') {
    return typeof value === 'number'
      && Number.isFinite(value)
      && (variable.min === undefined || value >= variable.min)
      && (variable.max === undefined || value <= variable.max)
  }
  if (variable.type === 'switch') {
    return value === 0 || value === 1
  }
  const optionIds = new Set(variable.options.map((option) => option.id))
  if (variable.type === 'select') {
    return typeof value === 'string' && optionIds.has(value)
  }
  return Array.isArray(value)
    && Object.keys(value).length === value.length
    && Reflect.ownKeys(value).every((key) => (
      key === 'length'
      || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length)
    ))
    && value.every((entry) => typeof entry === 'string' && optionIds.has(entry))
    && new Set(value).size === value.length
}

function cloneCompatiblePromptVariableValue(
  variable: PromptVariableDef,
  value: unknown,
): PromptVariableValue | undefined {
  const cloned = clonePromptVariableValue(value)
  return cloned !== undefined && isPromptVariableValueCompatible(variable, cloned)
    ? cloned
    : undefined
}

export interface PromptVariableSchemaValidationOptions {
  /** Existing native graph used to tolerate only its already-persisted anomalies. */
  legacyBaseline?: PromptBlock[] | null
}

function hasLegacyVariableIdentity(variables: unknown): variables is PromptVariableDef[] {
  if (!Array.isArray(variables)) return false
  const ids = new Set<string>()
  const names = new Set<string>()
  return variables.some((variable) => {
    if (!variable || typeof variable !== 'object') return true
    const id = (variable as PromptVariableDef).id
    const name = (variable as PromptVariableDef).name
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) return true
    if (ids.has(id) || names.has(name)) return true
    ids.add(id)
    names.add(name)
    return false
  })
}

function preservesLegacyVariableIdentity(
  baseline: unknown,
  next: unknown,
): boolean {
  if (!Array.isArray(baseline) || !Array.isArray(next)) return false
  const idCounts = new Map<string, number>()
  const nameCounts = new Map<string, number>()
  for (const variable of next) {
    if (!variable || typeof variable !== 'object') continue
    const id = (variable as PromptVariableDef).id
    const name = (variable as PromptVariableDef).name
    if (typeof id === 'string') idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
    if (typeof name === 'string') nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  }
  return next.every((variable, index) => {
    if (!variable || typeof variable !== 'object') return false
    const id = (variable as PromptVariableDef).id
    const name = (variable as PromptVariableDef).name
    const invalid = typeof id !== 'string'
      || !id.trim()
      || typeof name !== 'string'
      || !name.trim()
      || idCounts.get(id) !== 1
      || nameCounts.get(name) !== 1
    if (!invalid) return true
    const prior = baseline[index]
    return !!prior
      && typeof prior === 'object'
      && (prior as PromptVariableDef).id === id
      && (prior as PromptVariableDef).name === name
  })
}

function samePromptVariableIdentity(previous: PromptBlock, next: PromptBlock): boolean {
  if (previous.variables === undefined || next.variables === undefined) {
    return previous.variables === undefined && next.variables === undefined
  }
  if (!Array.isArray(previous.variables) || !Array.isArray(next.variables)) return false
  return previous.variables.length === next.variables.length
    && previous.variables.every((variable, index) => (
      variable.id === next.variables?.[index]?.id
      && variable.name === next.variables?.[index]?.name
    ))
}

function sameOrRepairablePromptVariableIdentity(previous: PromptBlock, next: PromptBlock): boolean {
  if (samePromptVariableIdentity(previous, next)) return true
  return hasLegacyVariableIdentity(previous.variables)
    && !hasLegacyVariableIdentity(next.variables)
}

const PROMPT_BLOCK_IDENTITY_KEYS = [
  'id',
  'name',
  'content',
  'role',
  'enabled',
  'position',
  'depth',
  'marker',
  'isLocked',
  'color',
  'injectionTrigger',
  'characterTagTrigger',
  'group',
  'categoryMode',
  'placementBinding',
] as const

function sameNativePromptBlockOccurrence(previous: PromptBlock, next: PromptBlock): boolean {
  if (!sameOrRepairablePromptVariableIdentity(previous, next)) return false
  return PROMPT_BLOCK_IDENTITY_KEYS.every((key) => {
    const left = previous[key]
    const right = next[key]
    if (Object.is(left, right)) return true
    try {
      return JSON.stringify(left) === JSON.stringify(right)
    } catch {
      return false
    }
  })
}

/**
 * Validate the stable identity and name invariants required to migrate prompt
 * values. A native save may pass its current graph as `legacyBaseline`; only
 * duplicate block IDs and invalid variable identities already present there
 * are tolerated, and only when they are unchanged or reduced. Extension draft
 * validation remains strict by default.
 */
export function validatePromptVariableSchema(
  blocks: PromptBlock[],
  options?: PromptVariableSchemaValidationOptions,
): void {
  if (!Array.isArray(blocks)) throw new Error('Invalid Loom prompt-variable schema: blocks must be an array')
  const baseline = options?.legacyBaseline
  const baselineById = new Map<string, PromptBlock[]>()
  for (const block of baseline ?? []) {
    if (!block || typeof block !== 'object' || typeof block.id !== 'string') continue
    const entries = baselineById.get(block.id) ?? []
    entries.push(block)
    baselineById.set(block.id, entries)
  }
  const finalById = new Map<string, PromptBlock[]>()
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || typeof block.id !== 'string') continue
    const entries = finalById.get(block.id) ?? []
    entries.push(block)
    finalById.set(block.id, entries)
  }
  const legacyBlockIds = new Set<string>()
  const selectedBaselineOccurrences = new Map<string, number[]>()
  for (const [id, baselineOccurrences] of baselineById) {
    const finalOccurrences = finalById.get(id) ?? []
    if (baselineOccurrences.length < 2 || finalOccurrences.length > baselineOccurrences.length) continue
    if (finalOccurrences.length === 0) {
      legacyBlockIds.add(id)
      selectedBaselineOccurrences.set(id, [])
      continue
    }
    let safe = true
    const selected: number[] = []
    if (finalOccurrences.length === baselineOccurrences.length) {
      finalOccurrences.forEach((block, index) => {
        if (sameNativePromptBlockOccurrence(baselineOccurrences[index]!, block)) selected.push(index)
        else safe = false
      })
    } else {
      let baselineIndex = 0
      for (const block of finalOccurrences) {
        const match = baselineOccurrences.findIndex((candidate, index) => (
          index >= baselineIndex && sameNativePromptBlockOccurrence(candidate, block)
        ))
        if (match < 0) {
          safe = false
          break
        }
        selected.push(match)
        baselineIndex = match + 1
      }
    }
    if (safe) {
      legacyBlockIds.add(id)
      selectedBaselineOccurrences.set(id, selected)
    }
  }
  const blockIds = new Set<string>()
  const blockOccurrences = new Map<string, number>()
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || typeof block.id !== 'string' || !block.id.trim()) {
      throw new Error('Invalid Loom prompt-variable schema: block id must be non-empty')
    }
    if (blockIds.has(block.id) && !legacyBlockIds.has(block.id)) {
      throw new Error(`Invalid Loom prompt-variable schema: duplicate block id "${block.id}"`)
    }
    blockIds.add(block.id)
    const occurrence = blockOccurrences.get(block.id) ?? 0
    blockOccurrences.set(block.id, occurrence + 1)
    if (block.variables === undefined) continue
    if (!Array.isArray(block.variables)) {
      throw new Error(`Invalid Loom prompt-variable schema: variables for "${block.id}" must be an array`)
    }
    const selectedOccurrence = selectedBaselineOccurrences.get(block.id)?.[occurrence]
    const baselineIndex = selectedOccurrence ?? occurrence
    const baselineBlock = baselineById.get(block.id)?.[baselineIndex]
    const allowLegacyIdentity = hasLegacyVariableIdentity(baselineBlock?.variables)
      && preservesLegacyVariableIdentity(baselineBlock?.variables, block.variables)
    const variableIds = new Set<string>()
    const variableNames = new Set<string>()
    for (const variable of block.variables) {
      if (!variable || typeof variable !== 'object') {
        throw new Error(`Invalid Loom prompt-variable schema: invalid variable in block "${block.id}"`)
      }
      if (typeof variable.id !== 'string' || !variable.id.trim()) {
        if (!allowLegacyIdentity) {
          throw new Error(`Invalid Loom prompt-variable schema: variable id in block "${block.id}" must be non-empty`)
        }
      }
      if (typeof variable.name !== 'string' || !variable.name.trim()) {
        if (!allowLegacyIdentity) {
          throw new Error(`Invalid Loom prompt-variable schema: variable name in block "${block.id}" must be non-empty`)
        }
      }
      if (typeof variable.id === 'string' && variableIds.has(variable.id) && !allowLegacyIdentity) {
        throw new Error(`Invalid Loom prompt-variable schema: duplicate variable id "${variable.id}" in block "${block.id}"`)
      }
      if (typeof variable.name === 'string' && variableNames.has(variable.name) && !allowLegacyIdentity) {
        throw new Error(`Invalid Loom prompt-variable schema: duplicate variable name "${variable.name}" in block "${block.id}"`)
      }
      if (typeof variable.id === 'string') variableIds.add(variable.id)
      if (typeof variable.name === 'string') variableNames.add(variable.name)
    }
  }
}

function setPromptVariableValue(
  bucket: Record<string, PromptVariableValue>,
  name: string,
  value: PromptVariableValue,
): void {
  Object.defineProperty(bucket, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function setPromptVariableBucket(
  output: LoomPreset['promptVariables'],
  blockId: string,
  bucket: Record<string, PromptVariableValue>,
): void {
  if (Object.keys(bucket).length === 0) return
  Object.defineProperty(output, blockId, {
    value: bucket,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function readOwnDataProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function readEnumerableArrayItems(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  const length = readOwnDataProperty(value, 'length')
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return []
  const items: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = hasEnumerableDataProperty(value, String(index))
    if (descriptor) items.push(descriptor.value)
  }
  return items
}

function normalizeTolerantPromptVariable(value: unknown): {
  name: string
  variable: PromptVariableDef
} | undefined {
  if (!isRecord(value)) return undefined
  const name = readOwnDataProperty(value, 'name')
  const type = readOwnDataProperty(value, 'type')
  if (typeof name !== 'string' || !name.trim() || typeof type !== 'string') return undefined

  if (type === 'text' || type === 'textarea' || type === 'switch') {
    return { name, variable: { type } as PromptVariableDef }
  }
  if (type === 'number' || type === 'slider') {
    const min = readOwnDataProperty(value, 'min')
    const max = readOwnDataProperty(value, 'max')
    if (
      (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min)))
      || (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max)))
    ) {
      return undefined
    }
    return {
      name,
      variable: {
        type,
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
      } as PromptVariableDef,
    }
  }
  if (type !== 'select' && type !== 'multiselect') return undefined

  const options = readEnumerableArrayItems(readOwnDataProperty(value, 'options'))
  const optionIds: string[] = []
  for (const option of options) {
    const optionId = readOwnDataProperty(option, 'id')
    if (typeof optionId !== 'string') return undefined
    optionIds.push(optionId)
  }
  return {
    name,
    variable: {
      type,
      options: optionIds.map((id) => ({ id })),
    } as PromptVariableDef,
  }
}

function getTolerantPromptVariableSchemas(
  blocks: unknown,
): Map<string, Map<string, PromptVariableDef[]>> {
  const schemas = new Map<string, Map<string, PromptVariableDef[]>>()
  if (!Array.isArray(blocks)) return schemas
  for (const block of readEnumerableArrayItems(blocks)) {
    const blockId = readOwnDataProperty(block, 'id')
    if (typeof blockId !== 'string' || !blockId.trim()) continue
    const variables = readOwnDataProperty(block, 'variables')
    let byName = schemas.get(blockId)
    if (!byName) {
      byName = new Map<string, PromptVariableDef[]>()
      schemas.set(blockId, byName)
    }
    if (!Array.isArray(variables)) continue
    for (const variable of readEnumerableArrayItems(variables)) {
      const normalized = normalizeTolerantPromptVariable(variable)
      if (!normalized) continue
      const definitions = byName.get(normalized.name)
      if (definitions) {
        definitions.push(normalized.variable)
      } else {
        byName.set(normalized.name, [normalized.variable])
      }
    }
  }
  return schemas
}

function readEnumerableObjectKeys(value: unknown): string[] {
  if (!isRecord(value)) return []
  try {
    return Object.keys(value)
  } catch {
    return []
  }
}

function cloneCompatibleTolerantPromptVariableValue(
  definitions: PromptVariableDef[],
  value: unknown,
): PromptVariableValue | undefined {
  for (const variable of definitions) {
    const compatible = cloneCompatiblePromptVariableValue(variable, value)
    if (compatible !== undefined) return compatible
  }
  return undefined
}

export function pruneOrphanPromptVariables(
  values: LoomPreset['promptVariables'] | undefined,
  blocks: PromptBlock[],
): LoomPreset['promptVariables'] {
  const out = Object.create(null) as LoomPreset['promptVariables']
  const schemas = getTolerantPromptVariableSchemas(blocks)
  if (!isRecord(values)) return out

  for (const [blockId, definitionsByName] of schemas) {
    if (definitionsByName.size === 0) continue
    const bucketDescriptor = hasEnumerableDataProperty(values, blockId)
    if (!bucketDescriptor || !isRecord(bucketDescriptor.value)) continue
    const kept = Object.create(null) as Record<string, PromptVariableValue>
    for (const name of readEnumerableObjectKeys(bucketDescriptor.value)) {
      const valueDescriptor = hasEnumerableDataProperty(bucketDescriptor.value, name)
      const definitions = definitionsByName.get(name)
      if (!valueDescriptor || !definitions) continue
      const compatible = cloneCompatibleTolerantPromptVariableValue(definitions, valueDescriptor.value)
      if (compatible !== undefined) setPromptVariableValue(kept, name, compatible)
    }
    setPromptVariableBucket(out, blockId, kept)
  }
  return out
}

/**
 * Project values against a new block schema. When a prior schema is present,
 * values are migrated by stable block id + variable id before being keyed by
 * the new variable names. A missing prior schema deliberately falls back to
 * current-name pruning for backwards compatibility with older presets.
 */
export function reconcilePromptVariableValues(
  values: LoomPreset['promptVariables'] | undefined,
  previousBlocks: PromptBlock[] | null | undefined,
  nextBlocks: PromptBlock[],
  validationOptions?: PromptVariableSchemaValidationOptions,
): LoomPreset['promptVariables'] {
  validatePromptVariableSchema(nextBlocks, validationOptions)
  if (!Array.isArray(previousBlocks) || previousBlocks.length === 0) {
    return pruneOrphanPromptVariables(values, nextBlocks)
  }
  validatePromptVariableSchema(previousBlocks, validationOptions)

  const output = Object.create(null) as LoomPreset['promptVariables']
  if (!values || typeof values !== 'object' || Array.isArray(values)) return output
  const previousByBlockId = new Map(previousBlocks.map((block) => [block.id, block]))

  for (const block of nextBlocks) {
    const bucketDescriptor = hasEnumerableDataProperty(values, block.id)
    if (!bucketDescriptor || !isRecord(bucketDescriptor.value) || !block.variables?.length) continue
    const previousBlock = previousByBlockId.get(block.id)
    const previousByVariableId = new Map(
      (previousBlock?.variables ?? []).map((variable) => [variable.id, variable]),
    )
    const kept = Object.create(null) as Record<string, PromptVariableValue>

    for (const variable of block.variables) {
      const previousVariable = previousByVariableId.get(variable.id)
      const sourceName = previousVariable?.name ?? variable.name
      const sourceDescriptor = hasEnumerableDataProperty(bucketDescriptor.value, sourceName)
      if (sourceDescriptor) {
        const compatible = cloneCompatiblePromptVariableValue(variable, sourceDescriptor.value)
        if (compatible !== undefined) setPromptVariableValue(kept, variable.name, compatible)
        continue
      }
      // A new variable (or a variable in a new block) has no stable source;
      // preserve a compatible value already keyed by its current name.
      if (previousVariable) continue
      const currentDescriptor = hasEnumerableDataProperty(bucketDescriptor.value, variable.name)
      if (!currentDescriptor) continue
      const compatible = cloneCompatiblePromptVariableValue(variable, currentDescriptor.value)
      if (compatible !== undefined) setPromptVariableValue(kept, variable.name, compatible)
    }
    setPromptVariableBucket(output, block.id, kept)
  }
  return output
}

// ============================================================================
// REGISTRY HELPERS
// ============================================================================

export function buildRegistryEntry(preset: LoomPreset): LoomRegistryEntry {
  return {
    name: preset.name,
    blockCount: preset.blocks?.length || 0,
    updatedAt: preset.updatedAt || Date.now(),
    isDefault: preset.isDefault || false,
  }
}

export function buildRegistryFromPresets(presets: Preset[]): Record<string, LoomRegistryEntry> {
  const registry: Record<string, LoomRegistryEntry> = {}
  for (const p of presets) {
    const loom = unmarshalPreset(p)
    registry[p.id] = buildRegistryEntry(loom)
  }
  return registry
}

// ============================================================================
// CATEGORY GROUP COMPUTATION
// ============================================================================

export function computeGroups(blocks: PromptBlock[] | undefined): CategoryGroup[] {
  if (!blocks?.length) return []
  const result: CategoryGroup[] = []
  let currentGroup: CategoryGroup = { categoryBlock: null, children: [] }

  for (const block of blocks) {
    if (block.marker === 'category') {
      if (currentGroup.categoryBlock || currentGroup.children.length > 0) {
        result.push(currentGroup)
      }
      currentGroup = { categoryBlock: block, children: [] }
    } else {
      if (block.group !== undefined && block.group !== (currentGroup.categoryBlock?.id ?? null)) {
        if (currentGroup.categoryBlock || currentGroup.children.length > 0) {
          result.push(currentGroup)
        }
        currentGroup = { categoryBlock: null, children: [] }
      }
      currentGroup.children.push(block)
    }
  }
  if (currentGroup.categoryBlock || currentGroup.children.length > 0) {
    result.push(currentGroup)
  }
  return result
}

// ============================================================================
// CONNECTION PROFILE DETECTION
// ============================================================================

export function detectSupportedParams(provider: string | null): Set<string> {
  if (!provider) return DEFAULT_PROVIDER_PARAMS
  return PROVIDER_PARAMS[provider] || DEFAULT_PROVIDER_PARAMS
}

const PROVIDER_PARAM_KEY_TO_SAMPLER_KEY: Record<string, string> = {
  max_tokens: 'maxTokens',
  temperature: 'temperature',
  top_p: 'topP',
  min_p: 'minP',
  top_k: 'topK',
  frequency_penalty: 'frequencyPenalty',
  presence_penalty: 'presencePenalty',
  repetition_penalty: 'repetitionPenalty',
}

export function detectSupportedParamsFromProviders(
  provider: string | null,
  providers: ProviderInfo[] | null | undefined,
): Set<string> {
  if (!provider) return DEFAULT_PROVIDER_PARAMS

  const providerInfo = providers?.find((entry) => entry.id === provider)
  const capabilityKeys = providerInfo?.capabilities?.parameters

  if (capabilityKeys && typeof capabilityKeys === 'object') {
    const supported = new Set<string>(['contextSize'])
    for (const apiKey of Object.keys(capabilityKeys)) {
      const samplerKey = PROVIDER_PARAM_KEY_TO_SAMPLER_KEY[apiKey]
      if (samplerKey) supported.add(samplerKey)
    }
    return supported
  }

  return detectSupportedParams(provider)
}

// ============================================================================
// MACRO REGISTRY
// ============================================================================

/** @deprecated Prefer fetching from GET /api/v1/macros. Kept as local fallback. */
export function getAvailableMacros(): MacroGroup[] {
  return [
    {
      category: 'ST Standard',
      macros: [
        { name: 'Scenario', syntax: '{{scenario}}', description: 'Character scenario' },
        { name: 'Personality', syntax: '{{personality}}', description: 'Character personality' },
        { name: 'Description', syntax: '{{description}}', description: 'Character description' },
        { name: 'Character Name', syntax: '{{char}}', description: 'Character name' },
        { name: 'User Name', syntax: '{{user}}', description: 'User name' },
        { name: 'User Persona', syntax: '{{persona}}', description: 'User persona' },
        { name: 'Example Messages', syntax: '{{mesExamples}}', description: 'Example dialogue messages' },
      ],
    },
    {
      category: 'Lumiverse — Lumia Content',
      macros: [
        { name: 'Lumia Definition', syntax: '{{lumiaDef}}', description: 'Selected physical definition' },
        { name: 'Lumia Definition Count', syntax: '{{lumiaDef::len}}', description: 'Number of active definitions' },
        { name: 'Lumia Behavior', syntax: '{{lumiaBehavior}}', description: 'All selected behaviors' },
        { name: 'Lumia Behavior Count', syntax: '{{lumiaBehavior::len}}', description: 'Number of active behaviors' },
        { name: 'Lumia Personality', syntax: '{{lumiaPersonality}}', description: 'All selected personalities' },
        { name: 'Lumia Personality Count', syntax: '{{lumiaPersonality::len}}', description: 'Number of active personalities' },
        { name: 'Lumia Quirks', syntax: '{{lumiaQuirks}}', description: 'User-defined behavioral quirks' },
        { name: 'Random Lumia', syntax: '{{randomLumia}}', description: 'Random Lumia (full)' },
        { name: 'Random Lumia Name', syntax: '{{randomLumia::name}}', description: 'Random Lumia name' },
        { name: 'Random Lumia Physical', syntax: '{{randomLumia::phys}}', description: 'Random Lumia physical definition' },
        { name: 'Random Lumia Personality', syntax: '{{randomLumia::pers}}', description: 'Random Lumia personality' },
        { name: 'Random Lumia Behavior', syntax: '{{randomLumia::behav}}', description: 'Random Lumia behavior' },
      ],
    },
    {
      category: 'Lumiverse — Lumia OOC',
      macros: [
        { name: 'Lumia OOC', syntax: '{{lumiaOOC}}', description: 'OOC commentary prompt' },
        { name: 'Lumia OOC Erotic', syntax: '{{lumiaOOCErotic}}', description: 'Mirror & Synapse erotic OOC' },
        { name: 'Lumia OOC Erotic Bleed', syntax: '{{lumiaOOCEroticBleed}}', description: 'Narrative Rupture erotic bleed' },
        { name: 'OOC Trigger', syntax: '{{lumiaOOCTrigger}}', description: 'OOC trigger countdown/activation' },
      ],
    },
    {
      category: 'Lumiverse — Self-Reference',
      macros: [
        { name: 'Self (my/our)', syntax: '{{lumiaSelf::1}}', description: 'Possessive determiner — my or our' },
        { name: 'Self (mine/ours)', syntax: '{{lumiaSelf::2}}', description: 'Possessive pronoun — mine or ours' },
        { name: 'Self (me/us)', syntax: '{{lumiaSelf::3}}', description: 'Object pronoun — me or us' },
        { name: 'Self (I/we)', syntax: '{{lumiaSelf::4}}', description: 'Subject pronoun — I or we' },
      ],
    },
    {
      category: 'Lumiverse — Loom System',
      macros: [
        { name: 'Loom Style', syntax: '{{loomStyle}}', description: 'Selected narrative style' },
        { name: 'Loom Style Count', syntax: '{{loomStyle::len}}', description: 'Number of active styles' },
        { name: 'Loom Utilities', syntax: '{{loomUtils}}', description: 'All selected utilities' },
        { name: 'Loom Utility Count', syntax: '{{loomUtils::len}}', description: 'Number of active utilities' },
        { name: 'Loom Retrofits', syntax: '{{loomRetrofits}}', description: 'All selected retrofits' },
        { name: 'Loom Retrofit Count', syntax: '{{loomRetrofits::len}}', description: 'Number of active retrofits' },
        { name: 'Loom Summary', syntax: '{{loomSummary}}', description: 'Current story summary' },
        { name: 'Summary Directive', syntax: '{{loomSummaryPrompt}}', description: 'Summarization directive prompt' },
        { name: 'Sovereign Hand', syntax: '{{loomSovHand}}', description: 'Co-pilot mode prompt' },
        { name: 'Sovereign Hand Active', syntax: '{{loomSovHandActive}}', description: 'Sovereign Hand status (yes/no)' },
        { name: 'Last User Message', syntax: '{{loomLastUserMessage}}', description: 'Last user message content' },
        { name: 'Last Char Message', syntax: '{{loomLastCharMessage}}', description: 'Last character message content' },
        { name: 'Last Message Name', syntax: '{{lastMessageName}}', description: 'Name of last message sender' },
        { name: 'Continue Prompt', syntax: '{{loomContinuePrompt}}', description: 'Continuation instructions' },
      ],
    },
    {
      category: 'Lumiverse — Council',
      macros: [
        { name: 'Council Instructions', syntax: '{{lumiaCouncilInst}}', description: 'Council member instructions' },
        { name: 'Council Deliberation', syntax: '{{lumiaCouncilDeliberation}}', description: 'Council tool results' },
        { name: 'State Synthesis', syntax: '{{lumiaStateSynthesis}}', description: 'State synthesis prompt' },
        { name: 'Council Mode Active', syntax: '{{lumiaCouncilModeActive}}', description: 'Council mode status (yes/no)' },
        { name: 'Council Tools Active', syntax: '{{lumiaCouncilToolsActive}}', description: 'Council tools status (yes/no)' },
        { name: 'Council Tools List', syntax: '{{lumiaCouncilToolsList}}', description: 'Available council tools reminder' },
      ],
    },
    {
      category: 'Lumiverse — Utility',
      macros: [
        { name: 'Message Count', syntax: '{{lumiaMessageCount}}', description: 'Current chat message count' },
      ],
    },
  ]
}

// ============================================================================
// ST PRESET IMPORT / EXPORT
// ============================================================================

/** ST prompt object shape (the subset we care about) */
interface STPrompt {
  identifier?: string
  name?: string
  content?: string
  role?: string
  enabled?: boolean
  injection_trigger?: string[]
  lumiverse_character_tag_trigger?: string[]
  system_prompt?: boolean
  marker?: boolean
  injection_position?: number
  injection_depth?: number
  injection_order?: number
  forbid_overrides?: boolean
}

interface STPresetData {
  name?: string
  prompts?: STPrompt[]
  prompt_order?: Record<string, { order?: Array<{ identifier: string; enabled?: boolean }> }>
  extensions?: {
    regex_scripts?: unknown[]
  }
  // Root-level behavior prompts (ST stores these outside the prompts array)
  continue_nudge_prompt?: string
  impersonation_prompt?: string
  group_nudge_prompt?: string
  new_chat_prompt?: string
  new_group_chat_prompt?: string
  send_if_empty?: string
}

/**
 * Convert a single ST prompt entry to an internal block.
 * Recognizes well-known ST identifiers and converts them to marker blocks.
 */
function convertSTPromptToBlock(p: STPrompt, enabled: boolean): PromptBlock {
  const markerType = p.identifier ? ST_IDENTIFIER_TO_MARKER[p.identifier] : undefined
  if (markerType) {
    const block = createMarkerBlock(markerType, p.name || undefined)
    block.enabled = enabled
    block.injectionTrigger = Array.isArray(p.injection_trigger) ? p.injection_trigger.filter((value): value is string => typeof value === 'string') : []
    block.characterTagTrigger = sanitizeCharacterTagTrigger(p.lumiverse_character_tag_trigger)
    if (CONTENT_BEARING_MARKERS.has(markerType) && p.content) {
      block.content = p.content
    }
    return block
  }

  // NemoPresetExt wiki subcategories (<Name>) flatten to category blocks —
  // Lumiverse has only one level of category nesting.
  const rawName = p.name || 'Untitled'
  const wikiCategoryMatch = rawName.match(WIKI_CATEGORY_PATTERN)
  const wikiSubCategoryMatch = !wikiCategoryMatch ? rawName.match(WIKI_SUBCATEGORY_PATTERN) : null
  const isLegacyCategory = rawName.startsWith(CATEGORY_MARKER)
  // Only treat wiki-style tags as categories when the prompt is acting like a
  // heading. Ordinary prompts can legitimately use angle brackets or ===title===
  // names, and those must round-trip as normal blocks.
  const isWikiHeading = (!p.content || !p.content.trim()) && (!!wikiCategoryMatch || !!wikiSubCategoryMatch)
  const isCategory = isLegacyCategory || isWikiHeading

  let displayName = rawName
  if (wikiCategoryMatch) displayName = wikiCategoryMatch[1].trim()
  else if (wikiSubCategoryMatch) displayName = wikiSubCategoryMatch[1].trim()

  let position: PromptBlock['position'] = 'pre_history'
  let depth = 0
  if (p.injection_position === 1 && typeof p.injection_depth === 'number') {
    position = 'in_history'
    depth = p.injection_depth
  }

  return createBlock({
    name: displayName,
    content: p.content || '',
    role: (p.role as PromptBlock['role']) || 'system',
    enabled,
    injectionTrigger: Array.isArray(p.injection_trigger) ? p.injection_trigger.filter((value): value is string => typeof value === 'string') : [],
    characterTagTrigger: sanitizeCharacterTagTrigger(p.lumiverse_character_tag_trigger),
    position,
    depth,
    marker: isCategory ? 'category' : null,
    isLocked: false,
  })
}

/**
 * Import from a legacy preset JSON (the prompts[] array format).
 * Recognizes all well-known identifiers and parses them as marker blocks.
 * Uses prompt_order for enabled status overrides and sequencing.
 */
export function importFromSTPreset(stPresetData: STPresetData, name: string): LoomPreset {
  const now = Date.now()
  const prompts = stPresetData.prompts || []
  const blocks: PromptBlock[] = []

  // Build enabled overrides AND ordering from prompt_order.
  // ST's prompt_order defines the ACTUAL sequence prompts appear in —
  // the prompts[] array is just a definition pool with arbitrary order.
  const enabledOverrides = new Map<string, boolean>()
  const orderSequence: string[] = []
  const promptOrder = stPresetData.prompt_order
  if (promptOrder) {
    const keys = Object.keys(promptOrder)
      .filter(k => promptOrder[k]?.order?.length)
      .sort((a, b) => Number(b) - Number(a))
    // Apply overrides from all orders, highest priority last wins
    for (let i = keys.length - 1; i >= 0; i--) {
      for (const entry of promptOrder[keys[i]].order!) {
        enabledOverrides.set(entry.identifier, entry.enabled !== false)
      }
    }
    // Use the highest-priority key's order as the canonical sequence
    if (keys.length > 0) {
      for (const entry of promptOrder[keys[0]].order!) {
        orderSequence.push(entry.identifier)
      }
    }
  }

  // Build a lookup map from identifier → prompt object
  const promptByIdentifier = new Map<string, STPrompt>()
  for (const p of prompts) {
    if (p.identifier) promptByIdentifier.set(p.identifier, p)
  }

  const processedIdentifiers = new Set<string>()

  // First pass: follow prompt_order sequence
  for (const identifier of orderSequence) {
    const p = promptByIdentifier.get(identifier)
    if (!p) continue
    processedIdentifiers.add(identifier)

    const enabled = p.identifier && enabledOverrides.has(p.identifier)
      ? enabledOverrides.get(p.identifier)!
      : (p.enabled !== false)

    blocks.push(convertSTPromptToBlock(p, enabled))
  }

  // Second pass: append any prompts not in prompt_order (preserves prompts[] order)
  for (const p of prompts) {
    if (p.identifier && processedIdentifiers.has(p.identifier)) continue
    processedIdentifiers.add(p.identifier || '')

    const enabled = p.identifier && enabledOverrides.has(p.identifier)
      ? enabledOverrides.get(p.identifier)!
      : (p.enabled !== false)

    blocks.push(convertSTPromptToBlock(p, enabled))
  }

  // Ensure chat_history marker exists
  const hasChatHistory = blocks.some(b => b.marker === 'chat_history')
  if (!hasChatHistory) {
    let insertIdx = blocks.length
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].position === 'in_history' || blocks[i].position === 'post_history') {
        insertIdx = i
        break
      }
    }
    blocks.splice(insertIdx, 0, createMarkerBlock('chat_history'))
  }

  return {
    id: generateUUID(),
    name,
    description: `Imported from legacy preset "${stPresetData.name || name}"`,
    coverUrl: null,
    presetVersion: null,
    lumihubMeta: null,
    passthroughMetadata: {},
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    // `createBlock` gives every block a `group: null` default. That is the
    // right default for a manually-created block, but a null group is explicit
    // to the category renderer, so it prevents the imported blocks from being
    // associated with the preceding ST category heading. Preserve ST's
    // sequential category layout by assigning each prompt to that heading.
    blocks: assignSTCategoryGroups(blocks),
    source: {
      type: 'st_import',
      slug: null,
      importedVersion: null,
      importedName: stPresetData.name || name,
      importedAt: now,
    },
    isDefault: false,
    samplerOverrides: { ...DEFAULT_SAMPLER_OVERRIDES },
    customBody: { ...DEFAULT_CUSTOM_BODY },
    promptBehavior: {
      ...DEFAULT_PROMPT_BEHAVIOR,
      ...(stPresetData.continue_nudge_prompt != null && { continueNudge: stPresetData.continue_nudge_prompt }),
      ...(stPresetData.impersonation_prompt != null && { impersonationPrompt: stPresetData.impersonation_prompt }),
      ...(stPresetData.group_nudge_prompt != null && { groupNudge: stPresetData.group_nudge_prompt }),
      ...(stPresetData.new_chat_prompt != null && { newChatPrompt: stPresetData.new_chat_prompt }),
      ...(stPresetData.new_group_chat_prompt != null && { newGroupChatPrompt: stPresetData.new_group_chat_prompt }),
      ...(stPresetData.send_if_empty != null && { sendIfEmpty: stPresetData.send_if_empty }),
    },
    completionSettings: { ...DEFAULT_COMPLETION_SETTINGS },
    advancedSettings: { ...DEFAULT_ADVANCED_SETTINGS },
    modelProfiles: {},
    lastProfileKey: null,
    promptVariables: {},
  }
}

/**
 * SillyTavern represents categories solely as ordered heading prompts. Its
 * child prompts do not carry a category id, so derive one from their position.
 */
function assignSTCategoryGroups(blocks: PromptBlock[]): PromptBlock[] {
  let currentCategoryId: string | null = null

  return blocks.map((block) => {
    if (block.marker === 'category') {
      currentCategoryId = block.id
      return { ...block, group: null }
    }
    return { ...block, group: currentCategoryId }
  })
}


/**
 * Export a Loom preset to SillyTavern-compatible JSON format.
 * Reverse of importFromSTPreset — maps blocks back to ST prompts/prompt_order
 * and flattens behavior/sampler settings to ST root-level fields.
 */
export function exportToSTPreset(loom: LoomPreset): Record<string, any> {
  const exportLoom = sanitizeLumiHubSealedBlocksForExport(loom)
  const prompts: Array<Record<string, any>> = []
  const orderEntries: Array<{ identifier: string; enabled: boolean }> = []

  for (const block of exportLoom.blocks) {
    // Determine ST identifier — well-known markers use their ST name,
    // everything else (custom blocks, categories) uses the block's own UUID
    const markerMapping = block.marker && block.marker !== 'category'
      ? MARKER_TO_ST_IDENTIFIER[block.marker]
      : undefined
    const identifier = markerMapping ?? block.id
    const isWellKnown = !!markerMapping

    // Map position → injection_position / injection_depth
    let injection_position = 0
    let injection_depth = 4
    if (block.position === 'in_history') {
      injection_position = 1
      injection_depth = block.depth
    } else if (block.position === 'post_history') {
      injection_position = 1
      injection_depth = 0
    }

    // Map role (user_append/assistant_append → base role for ST)
    const role = block.role === 'user_append' ? 'user'
      : block.role === 'assistant_append' ? 'assistant'
      : block.role

    // Build ST prompt entry
    const stPrompt: Record<string, any> = {
      identifier,
      name: block.marker === 'category' && !block.name.startsWith(CATEGORY_MARKER)
        ? `${CATEGORY_MARKER}${block.name}`
        : block.name,
      content: block.content || '',
      role,
      enabled: block.enabled,
      system_prompt: false,
      marker: isWellKnown,
      injection_position,
      injection_depth,
      injection_order: 100,
      forbid_overrides: false,
    }

    // Include injection_trigger for non-marker prompts (maps 1:1 with ST)
    if (!isWellKnown) {
      stPrompt.injection_trigger = block.injectionTrigger ?? []
    }
    if (block.characterTagTrigger?.length) {
      stPrompt.lumiverse_character_tag_trigger = block.characterTagTrigger
    }

    prompts.push(stPrompt)
    orderEntries.push({ identifier, enabled: block.enabled })
  }

  // Build root-level sampler values
  const samplers = exportLoom.samplerOverrides ?? DEFAULT_SAMPLER_OVERRIDES
  const behavior = exportLoom.promptBehavior ?? DEFAULT_PROMPT_BEHAVIOR
  const completion = exportLoom.completionSettings ?? DEFAULT_COMPLETION_SETTINGS
  const advanced = exportLoom.advancedSettings ?? DEFAULT_ADVANCED_SETTINGS

  return {
    // Sampler params at root level (ST convention: these come first)
    temperature: samplers.temperature ?? 1,
    frequency_penalty: samplers.frequencyPenalty ?? 0,
    presence_penalty: samplers.presencePenalty ?? 0,
    top_p: samplers.topP ?? 1,
    top_k: samplers.topK ?? 0,
    top_a: 0,
    min_p: samplers.minP ?? 0,
    repetition_penalty: samplers.repetitionPenalty ?? 1,
    max_context_unlocked: false,
    openai_max_context: samplers.contextSize ?? 128000,
    openai_max_tokens: samplers.maxTokens ?? 4096,

    // Behavior prompts
    names_behavior: completion.namesBehavior ?? 0,
    send_if_empty: behavior.sendIfEmpty ?? '',
    impersonation_prompt: behavior.impersonationPrompt ?? '',
    new_chat_prompt: behavior.newChatPrompt ?? '',
    new_group_chat_prompt: behavior.newGroupChatPrompt ?? '',
    new_example_chat_prompt: '',
    continue_nudge_prompt: behavior.continueNudge ?? '',
    group_nudge_prompt: behavior.groupNudge ?? '',

    // ST formatting defaults
    bias_preset_selected: 'Default (none)',
    wi_format: '{0}',
    scenario_format: '{{scenario}}',
    personality_format: '{{personality}}',

    stream_openai: true,

    // Prompt blocks + ordering
    name: exportLoom.name,
    prompts,
    prompt_order: [{ character_id: 100001, order: orderEntries }],

    // Completion settings
    assistant_prefill: completion.assistantPrefill ?? '',
    assistant_impersonation: completion.assistantImpersonation ?? '',
    use_sysprompt: completion.useSystemPrompt ?? true,
    squash_system_messages: completion.squashSystemMessages ?? false,
    continue_prefill: completion.continuePrefill ?? false,
    continue_postfix: completion.continuePostfix ?? ' ',
    function_calling: completion.enableFunctionCalling ?? false,
    enable_web_search: completion.enableWebSearch ?? false,
    media_inlining: completion.sendInlineMedia ?? false,

    // Advanced
    seed: advanced.seed ?? -1,
    n: 1,
    ...(advanced.customStopStrings?.length && {
      custom_stopping_strings: JSON.stringify(advanced.customStopStrings),
    }),
  }
}

// ============================================================================
// NEW PRESET FACTORY
// ============================================================================

export function createNewLoomPreset(name: string, description = ''): LoomPreset {
  const now = Date.now()
  return {
    id: generateUUID(),
    name,
    description,
    coverUrl: null,
    presetVersion: null,
    lumihubMeta: null,
    passthroughMetadata: {},
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    blocks: [
      createBlock({ name: 'System Prompt', content: '', role: 'system', position: 'pre_history' }),
      createMarkerBlock('chat_history'),
    ],
    source: null,
    isDefault: false,
    samplerOverrides: { ...DEFAULT_SAMPLER_OVERRIDES },
    customBody: { ...DEFAULT_CUSTOM_BODY },
    promptBehavior: { ...DEFAULT_PROMPT_BEHAVIOR },
    completionSettings: { ...DEFAULT_COMPLETION_SETTINGS },
    advancedSettings: { ...DEFAULT_ADVANCED_SETTINGS },
    modelProfiles: {},
    lastProfileKey: null,
    promptVariables: {},
  }
}
