import type { Preset, CreatePresetInput, UpdatePresetInput } from '@/types/api'
import type {
  PromptBlock,
  LoomPreset,
  LoomRegistryEntry,
  LoomConnectionProfile,
  MacroGroup,
  CategoryGroup,
} from './types'
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
  if (Array.isArray(preset.blocks)) {
    for (const block of preset.blocks) {
      if (!Array.isArray(block.injectionTrigger)) {
        block.injectionTrigger = []
      }
    }
  }
  return preset
}

// ============================================================================
// MARSHAL / UNMARSHAL — Convert between Loom shape and backend API shape
// ============================================================================

export function marshalPreset(loom: LoomPreset): CreatePresetInput {
  return {
    name: loom.name,
    provider: 'loom',
    parameters: {
      samplerOverrides: loom.samplerOverrides,
      customBody: loom.customBody,
    },
    prompt_order: loom.blocks,
    prompts: {
      promptBehavior: loom.promptBehavior,
      completionSettings: loom.completionSettings,
      advancedSettings: loom.advancedSettings,
    },
    metadata: {
      source: loom.source,
      modelProfiles: loom.modelProfiles,
      schemaVersion: loom.schemaVersion,
      description: loom.description,
      isDefault: loom.isDefault,
      lastProfileKey: loom.lastProfileKey,
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
    schemaVersion: meta.schemaVersion || 1,
    createdAt: preset.created_at,
    updatedAt: preset.updated_at,
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
  }

  return migratePreset(loom)
}

export function marshalUpdate(loom: LoomPreset): UpdatePresetInput {
  return {
    name: loom.name,
    parameters: {
      samplerOverrides: loom.samplerOverrides,
      customBody: loom.customBody,
    },
    prompt_order: loom.blocks,
    prompts: {
      promptBehavior: loom.promptBehavior,
      completionSettings: loom.completionSettings,
      advancedSettings: loom.advancedSettings,
    },
    metadata: {
      source: loom.source,
      modelProfiles: loom.modelProfiles,
      schemaVersion: loom.schemaVersion,
      description: loom.description,
      isDefault: loom.isDefault,
      lastProfileKey: loom.lastProfileKey,
    },
  }
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
    if (CONTENT_BEARING_MARKERS.has(markerType) && p.content) {
      block.content = p.content
    }
    return block
  }

  const isCategory = p.name?.startsWith(CATEGORY_MARKER)

  let position: PromptBlock['position'] = 'pre_history'
  let depth = 0
  if (p.injection_position === 1 && typeof p.injection_depth === 'number') {
    position = 'in_history'
    depth = p.injection_depth
  }

  return createBlock({
    name: p.name || 'Untitled',
    content: p.content || '',
    role: (p.role as PromptBlock['role']) || 'system',
    enabled,
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
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    blocks,
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
    promptBehavior: { ...DEFAULT_PROMPT_BEHAVIOR },
    completionSettings: { ...DEFAULT_COMPLETION_SETTINGS },
    advancedSettings: { ...DEFAULT_ADVANCED_SETTINGS },
    modelProfiles: {},
    lastProfileKey: null,
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
  }
}
