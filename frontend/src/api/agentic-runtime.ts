import { get, put } from './client'
import type { Preset } from '@/types/api'
import {
  AGENTIC_LABEL_MAX_LENGTH,
  AGENTIC_PREDICATE_MAX_ID_BYTES,
  AGENTIC_PREDICATE_MAX_LIST_ITEMS,
  AGENTIC_TASK_TEMPLATE_LIMIT,
  AGENT_INVOCATION_MIN,
  AGENT_MAX_OUTPUT_TOKENS_MAX,
  AGENT_MAX_OUTPUT_TOKENS_MIN,
  AGENT_MODES,
  AGENT_PROFILE_ID_PATTERN,
  AGENT_PROFILE_LIMIT,
  AGENT_PROFILE_NAME_MAX_LENGTH,
  AGENT_SYSTEM_PROMPT_MAX_BYTES,
  AGENT_TIMEOUT_MS_MIN,
  CORE_AGENT_TOOL_IDS,
  isAgentTaskTemplate,
  parseAgentRuntimePolicyV1,
  AGENT_TOOL_CALL_MIN,
} from '@/lib/loom/agenticRuntime'
import { WORKSPACE_CAPABILITIES } from '@/lib/loom/types'
import type {
  AgentConfigRepairItem,
  AgentConfigReview,
  AgentConfigV2,
  AgentConnectionSlot,
  AgentProfileConfigV2,
  AgentTaskTemplate,
  AgenticRuntimeHostCeilings,
  AgenticRuntimeSaveDraft,
  PromptBlock,
} from '@/lib/loom/types'
import { isUnknownRecord } from '@/lib/type-guards'

export interface AgenticRuntimeEditorProjection {
  presetId: string
  presetRevision: number
  configRevision: number
  config: AgentConfigV2 | null
  review: AgentConfigReview | null
  slotBindings: Record<string, string | null>
  taskTemplates: AgentTaskTemplate[]
  reviewAcknowledgements: string[]
  hostCeilings: AgenticRuntimeHostCeilings
}

export interface SaveAgenticRuntimeEditorResult {
  preset: Preset
  editor: AgenticRuntimeEditorProjection
}

interface AgenticRuntimeSlotBindingWire {
  slotId: string
  connectionId: string | null
}

const MAX_SLOT_BINDINGS = AGENT_PROFILE_LIMIT * 2
const MAX_POLICY_REFS = 512
const MAX_CONNECTION_ID_BYTES = AGENTIC_PREDICATE_MAX_ID_BYTES
const SLOT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}(?:\/[a-z][a-z0-9_-]{0,63})?$/
const AGENT_CAPABILITY_IDS = [
  'generation',
  'streaming',
  'tool_calling',
  'native_tool_continuation',
  'tools_disabled_finalization',
] as const
const LORE_TOOL_IDS: Record<string, true> = {
  lore_list_books: true,
  lore_get_book: true,
  lore_list_entries: true,
  lore_get_entry: true,
  lore_search_entries: true,
}

const REPAIR_KINDS: Record<string, true> = {
  unresolved_slot: true,
  stale_slot: true,
  disabled_import: true,
  capability_mismatch: true,
  stale_block: true,
}
const REPAIR_ACTION_KINDS: Record<string, true> = {
  acknowledge: true,
  map_slot: true,
  choose_response: true,
}
const HOST_CEILING_KEY_SET = {
  childAdmissions: true,
  aggregateToolCalls: true,
  logicalProviderRequests: true,
  physicalDispatchAttempts: true,
  childOutputTokens: true,
  workAttemptOutputTokens: true,
  workAttemptProviderDispatches: true,
  workAttemptUnsignedBoundaries: true,
  workAttemptToolCalls: true,
  workAttemptWorkspaceOperations: true,
  workSegmentOutputTokens: true,
  workSegmentProviderDispatches: true,
  workSegmentUnsignedBoundaries: true,
  workSegmentToolCalls: true,
  workSegmentWorkspaceOperations: true,
  workDispatchOutputTokens: true,
  workRecoveryReserveOutputTokens: true,
  workFuturePhaseReserveOutputTokens: true,
  rootWallClockMs: true,
  activityEvents: true,
  activityBytes: true,
  lifecycleLogRecords: true,
  activeRootsPerUser: true,
  activeRootsProcess: true,
  providerDispatchesPerUser: true,
  providerDispatchesProcess: true,
  toolExecutionsPerUser: true,
  toolExecutionsProcess: true,
} as const satisfies Readonly<Record<keyof AgenticRuntimeHostCeilings, true>>
const HOST_CEILING_KEYS = Object.keys(HOST_CEILING_KEY_SET) as Array<keyof AgenticRuntimeHostCeilings>
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const UTF8_ENCODER = new TextEncoder()
const MATCHED_EDITOR_GET_ATTEMPTS = 3

type UnknownRecord = Record<string, unknown>

function projectionError(path: string, reason = 'is invalid'): never {
  throw new Error(`Invalid agentic runtime editor projection: ${path} ${reason}`)
}

function requireOwn(record: UnknownRecord, key: string, path: string): void {
  if (!Object.hasOwn(record, key)) projectionError(`${path}.${key}`, 'is required')
}

function exactKeys(record: UnknownRecord, keys: readonly string[], path: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) projectionError(`${path}.${key}`, 'is unknown')
  }
}

function asRecord(value: unknown, path: string): UnknownRecord {
  if (!isUnknownRecord(value)) projectionError(path, 'must be an object')
  return value
}

function denseArray(value: unknown, maxLength: number, path: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    projectionError(path, 'must be a dense array')
  }
  if (value.length > maxLength) projectionError(path, `must contain at most ${maxLength} entries`)
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index))) projectionError(`${path}.${index}`, 'is missing')
  }
  for (const key of Object.keys(value)) {
    if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      projectionError(`${path}.${key}`, 'is not an indexed array entry')
    }
  }
  return value
}

function isBoundedText(value: unknown, maxBytes: number, allowSpaces: boolean): value is string {
  if (typeof value !== 'string' || value.length === 0 || UTF8_ENCODER.encode(value).byteLength > maxBytes) return false
  if (value.includes('{{') || value.includes('}}')) return false
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint === 0 || codePoint === 0x7f || codePoint < 0x20) return false
    if (!allowSpaces && codePoint <= 0x20) return false
  }
  return true
}

function boundedIdentifier(value: unknown, path: string, maxBytes = AGENTIC_PREDICATE_MAX_ID_BYTES): string {
  if (!isBoundedText(value, maxBytes, false)) projectionError(path, 'must be a bounded non-empty identifier')
  return value
}

function boundedDisplayText(value: unknown, path: string, maxCharacters: number, allowEmpty = false): string {
  if (typeof value !== 'string'
    || !allowEmpty && value.length === 0
    || [...value].length > maxCharacters
    || [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint === 0 || codePoint === 0x7f || codePoint < 0x20
    })) {
    projectionError(path, `must be at most ${maxCharacters} safe characters`)
  }
  return value
}
function normalizeOrderedCapabilities(value: unknown, allowed: readonly string[], path: string): string[] {
  const values = denseArray(value, allowed.length, path)
  let previousIndex = -1
  return values.map((entry, index) => {
    if (typeof entry !== 'string') projectionError(`${path}.${index}`, 'must be a known sorted capability')
    const capabilityIndex = allowed.indexOf(entry)
    if (capabilityIndex < 0 || capabilityIndex <= previousIndex) {
      projectionError(`${path}.${index}`, 'must contain known capabilities in canonical order')
    }
    previousIndex = capabilityIndex
    return entry
  })
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    projectionError(path, 'must be a non-negative safe integer')
  }
  return value

}
function positiveSafeInteger(value: unknown, path: string): number {
  const normalized = nonNegativeSafeInteger(value, path)
  if (normalized === 0) projectionError(path, 'must be a positive safe integer')
  return normalized
}
function parseSlotId(value: unknown, path: string): string {
  const slotId = boundedIdentifier(value, path)
  if (!SLOT_ID_PATTERN.test(slotId) || DANGEROUS_OBJECT_KEYS.has(slotId)) {
    projectionError(path, 'must match the bounded slot identifier pattern')
  }
  return slotId
}

function parseConnectionId(value: unknown, path: string): string | null {
  if (value === null) return null
  return boundedIdentifier(value, path, MAX_CONNECTION_ID_BYTES)
}

function normalizeSlotBindings(value: unknown): Record<string, string | null> {
  const entries: Array<[string, string | null]> = []
  const seen = new Set<string>()
  const add = (slotId: string, connectionId: string | null, path: string): void => {
    if (seen.has(slotId)) projectionError(`${path}.slotId`, 'is duplicated')
    seen.add(slotId)
    entries.push([slotId, connectionId])
  }

  if (Array.isArray(value)) {
    const rows = denseArray(value, MAX_SLOT_BINDINGS, 'slotBindings')
    rows.forEach((entry, index) => {
      const path = `slotBindings.${index}`
      const row = asRecord(entry, path)
      exactKeys(row, ['slotId', 'connectionId', 'bindingRevision', 'state', 'reviewCode'], path)
      requireOwn(row, 'slotId', path)
      requireOwn(row, 'connectionId', path)
      const slotId = parseSlotId(row.slotId, `${path}.slotId`)
      const connectionId = parseConnectionId(row.connectionId, `${path}.connectionId`)
      if (Object.hasOwn(row, 'bindingRevision')) nonNegativeSafeInteger(row.bindingRevision, `${path}.bindingRevision`)
      if (Object.hasOwn(row, 'state')
        && row.state !== 'ready'
        && row.state !== 'review_required'
        && row.state !== 'repair_required') {
        projectionError(`${path}.state`, 'must be a known binding state')
      }
      if (Object.hasOwn(row, 'reviewCode')
        && row.reviewCode !== null) {
        boundedIdentifier(row.reviewCode, `${path}.reviewCode`)
      }
      add(slotId, connectionId, path)
    })
  } else {
    const object = asRecord(value, 'slotBindings')
    const keys = Object.keys(object)
    if (keys.length > MAX_SLOT_BINDINGS) {
      projectionError('slotBindings', `must contain at most ${MAX_SLOT_BINDINGS} entries`)
    }
    for (const slotIdKey of keys) {
      if (DANGEROUS_OBJECT_KEYS.has(slotIdKey)) projectionError(`slotBindings.${slotIdKey}`, 'uses a dangerous object key')
      const slotId = parseSlotId(slotIdKey, `slotBindings.${slotIdKey}`)
      if (!Object.hasOwn(object, slotIdKey)) projectionError(`slotBindings.${slotIdKey}`, 'is missing')
      const connectionId = parseConnectionId(object[slotIdKey], `slotBindings.${slotIdKey}`)
      add(slotId, connectionId, `slotBindings.${slotIdKey}`)
    }
  }

  entries.sort(([left], [right]) => left.localeCompare(right))
  return Object.fromEntries(entries)
}

function serializeSlotBindings(value: Record<string, string | null>): AgenticRuntimeSlotBindingWire[] {
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slotId, connectionId]) => ({ slotId, connectionId }))
}

function normalizePromptRefs(value: unknown, path: string): Array<{ blockId: string; expectedPresetRevision: number; expectedBlockRevision: number }> {
  return denseArray(value, MAX_POLICY_REFS, path).map((entry, index) => {
    const itemPath = `${path}.${index}`
    const record = asRecord(entry, itemPath)
    exactKeys(record, ['blockId', 'expectedPresetRevision', 'expectedBlockRevision'], itemPath)
    requireOwn(record, 'blockId', itemPath)
    requireOwn(record, 'expectedPresetRevision', itemPath)
    requireOwn(record, 'expectedBlockRevision', itemPath)
    return {
      blockId: boundedIdentifier(record.blockId, `${itemPath}.blockId`),
      expectedPresetRevision: nonNegativeSafeInteger(record.expectedPresetRevision, `${itemPath}.expectedPresetRevision`),
      expectedBlockRevision: nonNegativeSafeInteger(record.expectedBlockRevision, `${itemPath}.expectedBlockRevision`),
    }
  })
}

function normalizeAgentProfile(value: unknown, path: string): AgentProfileConfigV2 {
  const record = asRecord(value, path)
  exactKeys(record, [
    'id',
    'name',
    'systemPrompt',
    'connectionRef',
    'toolIds',
    'workspaceCapabilities',
    'loreScope',
    'allowMainDelegation',
    'failurePolicy',
    'streamActivity',
    'maxOutputTokens',
    'timeoutMs',
  ], path)
  for (const key of ['id', 'name', 'systemPrompt', 'connectionRef', 'toolIds', 'loreScope', 'allowMainDelegation', 'failurePolicy', 'streamActivity', 'maxOutputTokens', 'timeoutMs']) {
    requireOwn(record, key, path)
  }
  const id = boundedIdentifier(record.id, `${path}.id`)
  if (!AGENT_PROFILE_ID_PATTERN.test(id)) projectionError(`${path}.id`, 'must match the bounded profile identifier pattern')
  const name = boundedDisplayText(record.name, `${path}.name`, AGENT_PROFILE_NAME_MAX_LENGTH)
  const systemPrompt = record.systemPrompt
  if (typeof systemPrompt !== 'string' || UTF8_ENCODER.encode(systemPrompt).byteLength > AGENT_SYSTEM_PROMPT_MAX_BYTES) {
    projectionError(`${path}.systemPrompt`, 'must be a bounded string')
  }
  const connectionRef = asRecord(record.connectionRef, `${path}.connectionRef`)
  exactKeys(connectionRef, ['kind', 'slotId'], `${path}.connectionRef`)
  requireOwn(connectionRef, 'kind', `${path}.connectionRef`)
  if (connectionRef.kind === 'inherit_main') {
    if (Object.hasOwn(connectionRef, 'slotId')) projectionError(`${path}.connectionRef.slotId`, 'must be absent for inherited connections')
  } else if (connectionRef.kind === 'slot') {
    requireOwn(connectionRef, 'slotId', `${path}.connectionRef`)
    parseSlotId(connectionRef.slotId, `${path}.connectionRef.slotId`)
  } else {
    projectionError(`${path}.connectionRef.kind`, 'must be inherit_main or slot')
  }
  const toolIds = denseArray(record.toolIds, CORE_AGENT_TOOL_IDS.length, `${path}.toolIds`) as unknown[]
  const seenTools = new Set<string>()
  for (let index = 0; index < toolIds.length; index += 1) {
    const toolId = toolIds[index]
    if (typeof toolId !== 'string' || !CORE_AGENT_TOOL_IDS.includes(toolId as typeof CORE_AGENT_TOOL_IDS[number]) || seenTools.has(toolId)) {
      projectionError(`${path}.toolIds.${index}`, 'must be a unique known tool identifier')
    }
    seenTools.add(toolId)
  }
  let workspaceCapabilities: AgentProfileConfigV2['workspaceCapabilities']
  if (Object.hasOwn(record, 'workspaceCapabilities')) {
    workspaceCapabilities = normalizeOrderedCapabilities(
      record.workspaceCapabilities,
      WORKSPACE_CAPABILITIES,
      `${path}.workspaceCapabilities`,
    ) as NonNullable<AgentProfileConfigV2['workspaceCapabilities']>
  }
  if (record.loreScope !== 'active' && record.loreScope !== 'all_owned') projectionError(`${path}.loreScope`, 'must be active or all_owned')
  if (record.loreScope === 'all_owned' && !toolIds.some((toolId) => LORE_TOOL_IDS[toolId as string] === true)) {
    projectionError(`${path}.loreScope`, 'all_owned requires at least one lore tool')
  }
  if (typeof record.allowMainDelegation !== 'boolean') projectionError(`${path}.allowMainDelegation`, 'must be a boolean')
  if (record.failurePolicy !== 'required' && record.failurePolicy !== 'optional') projectionError(`${path}.failurePolicy`, 'must be required or optional')
  if (typeof record.streamActivity !== 'boolean') projectionError(`${path}.streamActivity`, 'must be a boolean')
  const maxOutputTokens = record.maxOutputTokens
  if (typeof maxOutputTokens !== 'number'
    || !Number.isSafeInteger(maxOutputTokens)
    || maxOutputTokens < AGENT_MAX_OUTPUT_TOKENS_MIN
    || maxOutputTokens > AGENT_MAX_OUTPUT_TOKENS_MAX) {
    projectionError(`${path}.maxOutputTokens`, 'must be within the supported range')
  }
  const timeoutMs = record.timeoutMs
  if (typeof timeoutMs !== 'number'
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < AGENT_TIMEOUT_MS_MIN
    || timeoutMs % 1_000 !== 0) {
    projectionError(`${path}.timeoutMs`, 'must be a supported whole-second timeout')
  }
  return {
    id,
    name,
    systemPrompt,
    connectionRef: connectionRef.kind === 'slot'
      ? { kind: 'slot', slotId: parseSlotId(connectionRef.slotId, `${path}.connectionRef.slotId`) }
      : { kind: 'inherit_main' },
    toolIds: [...toolIds] as AgentProfileConfigV2['toolIds'],
    ...(workspaceCapabilities === undefined ? {} : { workspaceCapabilities }),
    loreScope: record.loreScope,
    allowMainDelegation: record.allowMainDelegation,
    failurePolicy: record.failurePolicy,
    streamActivity: record.streamActivity,
    maxOutputTokens,
    timeoutMs,
  }
}

function normalizeConnectionSlot(value: unknown, path: string): AgentConnectionSlot {
  const record = asRecord(value, path)
  exactKeys(record, ['id', 'label', 'requiredCapabilities'], path)
  requireOwn(record, 'id', path)
  requireOwn(record, 'label', path)
  requireOwn(record, 'requiredCapabilities', path)
  const id = parseSlotId(record.id, `${path}.id`)
  const label = boundedDisplayText(record.label, `${path}.label`, AGENT_PROFILE_NAME_MAX_LENGTH)
  if (!label.trim()) projectionError(`${path}.label`, 'must not be empty')
  const requiredCapabilities = normalizeOrderedCapabilities(
    record.requiredCapabilities,
    AGENT_CAPABILITY_IDS,
    `${path}.requiredCapabilities`,
  )
  return { id, label, requiredCapabilities: requiredCapabilities as AgentConnectionSlot['requiredCapabilities'] }
}

function normalizeConfig(value: unknown, path: string): AgentConfigV2 | null {
  if (value === null) return null
  const record = asRecord(value, path)
  exactKeys(record, [
    'version',
    'agentsEnabled',
    'allowedModes',
    'defaultMode',
    'maxInvocations',
    'maxToolCalls',
    'mainToolIds',
    'mainLoreScope',
    'profiles',
    'connectionSlots',
    'runtimePolicy',
    'cognitionPolicy',
    'taskPolicy',
    'workspacePolicy',
  ], path)
  for (const key of ['version', 'agentsEnabled', 'allowedModes', 'defaultMode', 'maxInvocations', 'maxToolCalls', 'mainToolIds', 'mainLoreScope', 'profiles', 'connectionSlots']) {
    requireOwn(record, key, path)
  }
  if (record.version !== 2) projectionError(`${path}.version`, 'must be version 2')
  if (typeof record.agentsEnabled !== 'boolean') projectionError(`${path}.agentsEnabled`, 'must be a boolean')
  const allowedModes = denseArray(record.allowedModes, AGENT_MODES.length, `${path}.allowedModes`) as unknown[]
  if (allowedModes.length === 0) projectionError(`${path}.allowedModes`, 'must contain at least one mode')
  const seenModes = new Set<string>()
  for (let index = 0; index < allowedModes.length; index += 1) {
    const mode = allowedModes[index]
    if (typeof mode !== 'string' || !AGENT_MODES.includes(mode as typeof AGENT_MODES[number]) || seenModes.has(mode)) {
      projectionError(`${path}.allowedModes.${index}`, 'must contain unique known modes')
    }
    seenModes.add(mode)
  }
  if (!seenModes.has('response')) projectionError(`${path}.allowedModes`, 'must contain response')
  if (!record.agentsEnabled
    && (allowedModes.length !== 1 || allowedModes[0] !== 'response' || record.defaultMode !== 'response')) {
    projectionError(path, 'disabled configs must be response-only')
  }
  if (record.defaultMode !== 'response' && record.defaultMode !== 'agentic') projectionError(`${path}.defaultMode`, 'must be a known mode')
  if (!allowedModes.includes(record.defaultMode)) projectionError(`${path}.defaultMode`, 'must be included in allowedModes')
  const maxInvocations = record.maxInvocations
  if (typeof maxInvocations !== 'number' || !Number.isSafeInteger(maxInvocations) || maxInvocations < AGENT_INVOCATION_MIN) {
    projectionError(`${path}.maxInvocations`, 'must be a supported non-negative safe integer')
  }
  const maxToolCalls = record.maxToolCalls
  if (typeof maxToolCalls !== 'number' || !Number.isSafeInteger(maxToolCalls) || maxToolCalls < AGENT_TOOL_CALL_MIN) {
    projectionError(`${path}.maxToolCalls`, 'must be a supported non-negative safe integer')
  }
  const mainToolIds = denseArray(record.mainToolIds, CORE_AGENT_TOOL_IDS.length, `${path}.mainToolIds`) as unknown[]
  const seenMainTools = new Set<string>()
  for (let index = 0; index < mainToolIds.length; index += 1) {
    const toolId = mainToolIds[index]
    if (typeof toolId !== 'string'
      || !CORE_AGENT_TOOL_IDS.includes(toolId as typeof CORE_AGENT_TOOL_IDS[number])
      || seenMainTools.has(toolId)) {
      projectionError(`${path}.mainToolIds.${index}`, 'must contain unique known tool identifiers')
    }
    seenMainTools.add(toolId)
  }
  if (record.mainLoreScope !== 'active' && record.mainLoreScope !== 'all_owned') projectionError(`${path}.mainLoreScope`, 'must be active or all_owned')
  if (record.mainLoreScope === 'all_owned' && !mainToolIds.some((toolId) => LORE_TOOL_IDS[toolId as string] === true)) {
    projectionError(`${path}.mainLoreScope`, 'all_owned requires at least one lore tool')
  }
  const profiles = denseArray(record.profiles, AGENT_PROFILE_LIMIT, `${path}.profiles`)
    .map((profile, index) => normalizeAgentProfile(profile, `${path}.profiles.${index}`))
  const profileIds = new Set<string>()
  for (const [index, profile] of profiles.entries()) {
    if (profileIds.has(profile.id)) projectionError(`${path}.profiles.${index}.id`, 'is duplicated')
    profileIds.add(profile.id)
  }
  const connectionSlots = denseArray(record.connectionSlots, MAX_SLOT_BINDINGS, `${path}.connectionSlots`)
    .map((slot, index) => normalizeConnectionSlot(slot, `${path}.connectionSlots.${index}`))
  const slotIds = new Set<string>()
  for (const [index, slot] of connectionSlots.entries()) {
    if (slotIds.has(slot.id)) projectionError(`${path}.connectionSlots.${index}.id`, 'is duplicated')
    slotIds.add(slot.id)
  }
  for (const [index, profile] of profiles.entries()) {
    if (profile.connectionRef.kind === 'slot' && !slotIds.has(profile.connectionRef.slotId)) {
      projectionError(`${path}.profiles.${index}.connectionRef.slotId`, 'references an unknown connection slot')
    }
  }
  const hasRuntimePolicy = Object.hasOwn(record, 'runtimePolicy')
  if (hasRuntimePolicy && Object.hasOwn(record, 'cognitionPolicy')) {
    projectionError(`${path}.runtimePolicy`, 'cannot accompany legacy cognitionPolicy')
  }
  const normalized: AgentConfigV2 = {
    version: 2,
    agentsEnabled: record.agentsEnabled,
    allowedModes: [...allowedModes] as AgentConfigV2['allowedModes'],
    defaultMode: record.defaultMode,
    maxInvocations,
    maxToolCalls,
    mainToolIds: [...mainToolIds] as AgentConfigV2['mainToolIds'],
    mainLoreScope: record.mainLoreScope,
    profiles,
    connectionSlots,
  }
  if (Object.hasOwn(record, 'runtimePolicy')) {
    try {
      const runtimePolicy = parseAgentRuntimePolicyV1(record.runtimePolicy)
      if (runtimePolicy.defaultMode !== record.defaultMode) {
        projectionError(`${path}.runtimePolicy.defaultMode`, 'must match config.defaultMode')
      }
      normalized.runtimePolicy = runtimePolicy
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid agentic runtime editor projection:')) throw error
      projectionError(`${path}.runtimePolicy`, error instanceof Error ? error.message : 'is invalid')
    }
  }
  if (Object.hasOwn(record, 'cognitionPolicy')) {
    const cognitionPolicy = asRecord(record.cognitionPolicy, `${path}.cognitionPolicy`)
    exactKeys(cognitionPolicy, ['workPolicy', 'workspaceUsage', 'completionCriteria', 'renderPolicy'], `${path}.cognitionPolicy`)
    for (const key of ['workPolicy', 'workspaceUsage', 'completionCriteria', 'renderPolicy']) requireOwn(cognitionPolicy, key, `${path}.cognitionPolicy`)
    normalized.cognitionPolicy = {
      workPolicy: normalizePromptRefs(cognitionPolicy.workPolicy, `${path}.cognitionPolicy.workPolicy`),
      workspaceUsage: normalizePromptRefs(cognitionPolicy.workspaceUsage, `${path}.cognitionPolicy.workspaceUsage`),
      completionCriteria: normalizePromptRefs(cognitionPolicy.completionCriteria, `${path}.cognitionPolicy.completionCriteria`),
      renderPolicy: normalizePromptRefs(cognitionPolicy.renderPolicy, `${path}.cognitionPolicy.renderPolicy`),
    }
  }
  if (Object.hasOwn(record, 'taskPolicy')) {
    const taskPolicy = asRecord(record.taskPolicy, `${path}.taskPolicy`)
    exactKeys(taskPolicy, ['templateIds'], `${path}.taskPolicy`)
    requireOwn(taskPolicy, 'templateIds', `${path}.taskPolicy`)
    const templateIds = denseArray(taskPolicy.templateIds, AGENTIC_TASK_TEMPLATE_LIMIT, `${path}.taskPolicy.templateIds`)
      .map((templateId, index) => boundedIdentifier(templateId, `${path}.taskPolicy.templateIds.${index}`))
    if (new Set(templateIds).size !== templateIds.length) projectionError(`${path}.taskPolicy.templateIds`, 'must contain unique identifiers')
    normalized.taskPolicy = { templateIds }
  }
  if (Object.hasOwn(record, 'workspacePolicy')) {
    const workspacePolicy = asRecord(record.workspacePolicy, `${path}.workspacePolicy`)
    exactKeys(workspacePolicy, ['retention', 'sharing'], `${path}.workspacePolicy`)
    requireOwn(workspacePolicy, 'retention', `${path}.workspacePolicy`)
    requireOwn(workspacePolicy, 'sharing', `${path}.workspacePolicy`)
    if (workspacePolicy.retention !== 'turn_terminal' && workspacePolicy.retention !== 'chat_lifetime') {
      projectionError(`${path}.workspacePolicy.retention`, 'must be a known retention policy')
    }
    if (workspacePolicy.sharing !== 'root_only' && workspacePolicy.sharing !== 'view_only') {
      projectionError(`${path}.workspacePolicy.sharing`, 'must be a known sharing policy')
    }
    normalized.workspacePolicy = { retention: workspacePolicy.retention, sharing: workspacePolicy.sharing }
  }
  return normalized
}


function normalizeTaskTemplates(value: unknown): AgentTaskTemplate[] {
  const templates = denseArray(value, AGENTIC_TASK_TEMPLATE_LIMIT, 'taskTemplates')
  const seen = new Set<string>()
  return templates.map((entry, index) => {
    const path = `taskTemplates.${index}`
    const rawTemplate = asRecord(entry, path)
    if (!isAgentTaskTemplate(rawTemplate)) projectionError(path, 'is invalid')
    const template = rawTemplate
    for (const key of ['dependencies', 'activation', 'label', 'description']) {
      if (Object.hasOwn(rawTemplate, key) && rawTemplate[key] === undefined) {
        projectionError(`${path}.${key}`, 'must not be undefined when present')
      }
    }
    if (seen.has(template.id)) projectionError(`${path}.id`, 'is duplicated')
    seen.add(template.id)
    return {
      id: template.id,
      required: template.required,
      ...(template.dependencies === undefined ? {} : { dependencies: [...template.dependencies] }),
      ...(template.activation === undefined ? {} : { activation: template.activation }),
      ...(template.label === undefined ? {} : { label: template.label }),
      ...(template.description === undefined ? {} : { description: template.description }),
    }
  })
}

function normalizeRepairAction(value: unknown, path: string): AgentConfigRepairItem['action'] {
  const action = asRecord(value, path)
  exactKeys(action, ['kind', 'href', 'ref'], path)
  requireOwn(action, 'kind', path)
  if (REPAIR_ACTION_KINDS[action.kind as string] !== true) {
    projectionError(`${path}.kind`, 'is unknown')
  }
  const hasHref = Object.hasOwn(action, 'href')
  const hasRef = Object.hasOwn(action, 'ref')
  if (hasHref && hasRef) projectionError(path, 'must not contain both href and ref')
  const target = hasHref ? action.href : hasRef ? action.ref : undefined
  if (hasHref && target === undefined || hasRef && target === undefined) {
    projectionError(path, 'must not contain an undefined target')
  }
  if (target !== undefined) boundedIdentifier(target, `${path}.${hasHref ? 'href' : 'ref'}`)
  return {
    kind: action.kind as AgentConfigRepairItem['action']['kind'],
    ...(hasHref ? { href: target as string } : {}),
    ...(hasRef ? { ref: target as string } : {}),
  }
}

function normalizeReview(value: unknown): AgentConfigReview | null {
  if (value === null) return null
  const path = 'review'
  const record = asRecord(value, path)
  exactKeys(record, ['state', 'revision', 'reasonCode', 'unresolvedSlotIds', 'staleSlotIds', 'acknowledged', 'items'], path)
  for (const key of ['state', 'revision', 'reasonCode', 'unresolvedSlotIds', 'staleSlotIds', 'items']) requireOwn(record, key, path)
  if (record.state !== 'ready' && record.state !== 'review_required' && record.state !== 'repair_required') projectionError(`${path}.state`, 'is unknown')
  const revision = nonNegativeSafeInteger(record.revision, `${path}.revision`)
  const reasonCode = record.reasonCode === null ? null : boundedIdentifier(record.reasonCode, `${path}.reasonCode`)
  if (Object.hasOwn(record, 'acknowledged') && typeof record.acknowledged !== 'boolean') projectionError(`${path}.acknowledged`, 'must be a boolean')
  const unresolvedSlotIds = denseArray(record.unresolvedSlotIds, MAX_SLOT_BINDINGS, `${path}.unresolvedSlotIds`).map((slotId, index) => parseSlotId(slotId, `${path}.unresolvedSlotIds.${index}`))
  const staleSlotIds = denseArray(record.staleSlotIds, MAX_SLOT_BINDINGS, `${path}.staleSlotIds`).map((slotId, index) => parseSlotId(slotId, `${path}.staleSlotIds.${index}`))
  const allSlotIds = [...unresolvedSlotIds, ...staleSlotIds]
  if (new Set(unresolvedSlotIds).size !== unresolvedSlotIds.length
    || new Set(staleSlotIds).size !== staleSlotIds.length
    || new Set(allSlotIds).size !== allSlotIds.length) {
    projectionError(path, 'contains duplicate slot identities')
  }
  const items = denseArray(record.items, AGENTIC_PREDICATE_MAX_LIST_ITEMS, `${path}.items`).map((entry, index) => {
    const itemPath = `${path}.items.${index}`
    const item = asRecord(entry, itemPath)
    exactKeys(item, ['id', 'kind', 'label', 'reasonCode', 'action', 'acknowledged'], itemPath)
    for (const key of ['id', 'kind', 'reasonCode', 'action']) requireOwn(item, key, itemPath)
    const id = boundedIdentifier(item.id, `${itemPath}.id`)
    if (REPAIR_KINDS[item.kind as string] !== true) projectionError(`${itemPath}.kind`, 'is unknown')
    const reason = boundedIdentifier(item.reasonCode, `${itemPath}.reasonCode`)
    if (Object.hasOwn(item, 'label')) boundedDisplayText(item.label, `${itemPath}.label`, AGENTIC_LABEL_MAX_LENGTH, true)
    if (Object.hasOwn(item, 'acknowledged') && typeof item.acknowledged !== 'boolean') projectionError(`${itemPath}.acknowledged`, 'must be a boolean')
    return {
      id,
      kind: item.kind as AgentConfigRepairItem['kind'],
      ...(item.label === undefined ? {} : { label: item.label as string }),
      reasonCode: reason,
      action: normalizeRepairAction(item.action, `${itemPath}.action`),
      ...(item.acknowledged === undefined ? {} : { acknowledged: item.acknowledged as boolean }),
    }
  })
  if (new Set(items.map((item) => item.id)).size !== items.length) projectionError(`${path}.items`, 'contains duplicate item identities')
  return {
    state: record.state,
    revision,
    ...(record.reasonCode === null ? { reasonCode: null } : { reasonCode }),
    unresolvedSlotIds,
    staleSlotIds,
    ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged as boolean }),
    items,
  }
}

function normalizeReviewAcknowledgements(value: unknown): string[] {
  const acknowledgements = denseArray(value, AGENTIC_PREDICATE_MAX_LIST_ITEMS, 'reviewAcknowledgements')
    .map((entry, index) => boundedIdentifier(entry, `reviewAcknowledgements.${index}`))
  if (new Set(acknowledgements).size !== acknowledgements.length) projectionError('reviewAcknowledgements', 'contains duplicate identities')
  return acknowledgements
}

function normalizeHostCeilings(value: unknown): AgenticRuntimeHostCeilings {
  const record = asRecord(value, 'hostCeilings')
  exactKeys(record, HOST_CEILING_KEYS, 'hostCeilings')
  for (const key of HOST_CEILING_KEYS) requireOwn(record, key, 'hostCeilings')
  const normalized = {} as AgenticRuntimeHostCeilings
  for (const key of HOST_CEILING_KEYS) normalized[key] = positiveSafeInteger(record[key], `hostCeilings.${key}`)
  return normalized
}

function validateProjectionPredicateTaskRefs(
  value: unknown,
  taskIds: ReadonlySet<string>,
  path: string,
): void {
  if (!isUnknownRecord(value)) return
  if (value.kind === 'all' || value.kind === 'any') {
    const children = value.children as unknown[]
    children.forEach((child, index) => validateProjectionPredicateTaskRefs(child, taskIds, `${path}.children.${index}`))
    return
  }
  if (value.kind === 'not') {
    validateProjectionPredicateTaskRefs(value.child, taskIds, `${path}.child`)
    return
  }
  if (value.kind === 'task_transition'
    && (typeof value.taskId !== 'string' || !taskIds.has(value.taskId))) {
    projectionError(`${path}.taskId`, 'references an unknown task template')
  }
}

function validateProjectionGraph(
  config: AgentConfigV2,
  templates: readonly AgentTaskTemplate[],
): void {
  const taskIds = new Set(templates.map((template) => template.id))
  const taskDependencies = new Map<string, readonly string[]>()
  for (const [index, template] of templates.entries()) {
    const path = `taskTemplates.${index}`
    const dependencies = template.dependencies ?? []
    if (new Set(dependencies).size !== dependencies.length) {
      projectionError(`${path}.dependencies`, 'contains duplicate task identities')
    }
    for (const [dependencyIndex, dependencyId] of dependencies.entries()) {
      if (!taskIds.has(dependencyId)) {
        projectionError(`${path}.dependencies.${dependencyIndex}`, 'references an unknown task template')
      }
    }
    taskDependencies.set(template.id, dependencies)
    if (template.activation !== undefined) {
      validateProjectionPredicateTaskRefs(template.activation, taskIds, `${path}.activation`)
    }
  }
  const visitingTasks = new Set<string>()
  const visitedTasks = new Set<string>()
  const visitTask = (id: string): boolean => {
    if (visitingTasks.has(id)) return true
    if (visitedTasks.has(id)) return false
    visitingTasks.add(id)
    const cyclic = taskDependencies.get(id)?.some((dependencyId) => visitTask(dependencyId)) ?? false
    visitingTasks.delete(id)
    visitedTasks.add(id)
    return cyclic
  }
  for (const id of taskIds) {
    if (visitTask(id)) projectionError(`taskTemplates.${id}.dependencies`, 'contains a dependency cycle')
  }

  if (config.taskPolicy === undefined && templates.length > 0) {
    projectionError('config.taskPolicy', 'is required when task templates are present')
  }
  for (const [index, templateId] of config.taskPolicy?.templateIds.entries() ?? []) {
    if (!taskIds.has(templateId)) {
      projectionError(`config.taskPolicy.templateIds.${index}`, 'references an unknown task template')
    }
  }

  const runtimePolicy = config.runtimePolicy
  if (runtimePolicy === undefined) return
  runtimePolicy.phases.forEach((phase, index) => {
    validateProjectionPredicateTaskRefs(phase.enter, taskIds, `config.runtimePolicy.phases.${index}.enter`)
    validateProjectionPredicateTaskRefs(phase.exit, taskIds, `config.runtimePolicy.phases.${index}.exit`)
    if (phase.skip !== undefined) {
      validateProjectionPredicateTaskRefs(phase.skip, taskIds, `config.runtimePolicy.phases.${index}.skip`)
    }
  })
  if (runtimePolicy.loomPolicy === null) return
  for (const bucket of ['workPolicy', 'workspaceUsage', 'completionCriteria', 'renderPolicy'] as const) {
    runtimePolicy.loomPolicy[bucket].forEach((entry, index) => {
      if (entry.condition !== undefined) {
        validateProjectionPredicateTaskRefs(
          entry.condition,
          taskIds,
          `config.runtimePolicy.loomPolicy.${bucket}.${index}.condition`,
        )
      }
    })
  }
}

function normalizeEditorProjection(value: unknown): AgenticRuntimeEditorProjection {
  const projection = asRecord(value, 'editor')
  exactKeys(projection, [
    'presetId',
    'presetRevision',
    'configRevision',
    'config',
    'review',
    'slotBindings',
    'taskTemplates',
    'reviewAcknowledgements',
    'hostCeilings',
  ], 'editor')
  for (const key of ['presetId', 'presetRevision', 'configRevision', 'config', 'review', 'slotBindings', 'taskTemplates', 'reviewAcknowledgements', 'hostCeilings']) {
    requireOwn(projection, key, 'editor')
  }
  const config = normalizeConfig(projection.config, 'editor.config')
  const review = normalizeReview(projection.review)
  const slotBindings = normalizeSlotBindings(projection.slotBindings)
  const taskTemplates = normalizeTaskTemplates(projection.taskTemplates)
  const reviewAcknowledgements = normalizeReviewAcknowledgements(projection.reviewAcknowledgements)
  const hostCeilings = normalizeHostCeilings(projection.hostCeilings)
  if (config !== null) validateProjectionGraph(config, taskTemplates)
  return {
    presetId: boundedIdentifier(projection.presetId, 'editor.presetId'),
    presetRevision: nonNegativeSafeInteger(projection.presetRevision, 'editor.presetRevision'),
    configRevision: nonNegativeSafeInteger(projection.configRevision, 'editor.configRevision'),
    config,
    review,
    slotBindings,
    taskTemplates,
    reviewAcknowledgements,
    hostCeilings,
  }
}

function normalizePreset(value: unknown): Preset {
  const record = asRecord(value, 'save result.preset')
  for (const key of ['id', 'name', 'provider', 'engine', 'parameters', 'prompt_order', 'prompts', 'metadata', 'created_at', 'updated_at']) {
    requireOwn(record, key, 'save result.preset')
  }
  const preset: Preset = {
    id: boundedIdentifier(record.id, 'save result.preset.id'),
    name: boundedDisplayText(record.name, 'save result.preset.name', 512, true),
    provider: boundedDisplayText(record.provider, 'save result.preset.provider', 128),
    engine: boundedDisplayText(record.engine, 'save result.preset.engine', 128),
    parameters: asRecord(record.parameters, 'save result.preset.parameters'),
    prompt_order: denseArray(record.prompt_order, 4096, 'save result.preset.prompt_order'),
    prompts: asRecord(record.prompts, 'save result.preset.prompts'),
    metadata: asRecord(record.metadata, 'save result.preset.metadata'),
    created_at: nonNegativeSafeInteger(record.created_at, 'save result.preset.created_at'),
    updated_at: nonNegativeSafeInteger(record.updated_at, 'save result.preset.updated_at'),
  }
  if (record.cache_revision !== undefined) {
    preset.cache_revision = nonNegativeSafeInteger(record.cache_revision, 'save result.preset.cache_revision')
  }
  if (Object.hasOwn(record, 'agent_config_revision')) {
    preset.agent_config_revision = nonNegativeSafeInteger(
      record.agent_config_revision,
      'save result.preset.agent_config_revision',
    )
  }
  return preset
}

class MatchedEditorRevisionError extends Error {}

function normalizeEditorResult(value: unknown): SaveAgenticRuntimeEditorResult {
  const result = asRecord(value, 'save result')
  exactKeys(result, ['preset', 'editor'], 'save result')
  requireOwn(result, 'preset', 'save result')
  requireOwn(result, 'editor', 'save result')
  const preset = normalizePreset(result.preset)
  const editor = normalizeEditorProjection(result.editor)
  if (preset.id !== editor.presetId) {
    throw new MatchedEditorRevisionError('Invalid agentic runtime editor result: preset and editor identities do not match')
  }
  if (preset.cache_revision === undefined || preset.cache_revision !== editor.presetRevision) {
    throw new MatchedEditorRevisionError('Invalid agentic runtime editor result: preset and editor revisions do not match')
  }
  if (preset.agent_config_revision === undefined || preset.agent_config_revision !== editor.configRevision) {
    throw new MatchedEditorRevisionError('Invalid agentic runtime editor result: preset and editor config revisions do not match')
  }
  // Presets carry only the base review projection and omit editor-owned bindings/templates.
  // Publish every agent field from the validated editor so consumers hydrate one exact pair.
  return {
    preset: {
      ...preset,
      agent_config: editor.config,
      agent_config_revision: editor.configRevision,
      agent_config_review: editor.review,
      agent_slot_bindings: editor.slotBindings,
      agent_task_templates: editor.taskTemplates,
    },
    editor,
  }
}

export interface SaveAgenticRuntimeEditorInput extends AgenticRuntimeSaveDraft {
  expectedPresetRevision: number
  expectedConfigRevision: number
  promptOrder: PromptBlock[]
}

export const agenticRuntimeApi = {
  async getEditor(presetId: string) {
    const projection = await get<unknown>(`/presets/${presetId}/agent-config`)
    return normalizeEditorProjection(projection)
  },

  async getMatchedEditor(presetId: string) {
    let mismatch: MatchedEditorRevisionError | null = null
    for (let attempt = 0; attempt < MATCHED_EDITOR_GET_ATTEMPTS; attempt += 1) {
      const [preset, editor] = await Promise.all([
        get<unknown>(`/presets/${presetId}`),
        get<unknown>(`/presets/${presetId}/agent-config`),
      ])
      try {
        return normalizeEditorResult({ preset, editor })
      } catch (error) {
        if (!(error instanceof MatchedEditorRevisionError)) throw error
        mismatch = error
      }
    }
    throw mismatch ?? new MatchedEditorRevisionError('Unable to load a matched agentic runtime editor result')
  },

  async saveEditor(presetId: string, input: SaveAgenticRuntimeEditorInput) {
    const {
      config,
      slotBindings,
      taskTemplates,
      reviewAcknowledgements,
      expectedPresetRevision,
      expectedConfigRevision,
      promptOrder,
      quarantinedProfiles: _quarantinedProfiles,
      quarantinedConnectionSlots: _quarantinedConnectionSlots,
    } = input
    const result = await put<unknown>(
      `/presets/${presetId}/agent-config`,
      {
        config,
        slotBindings: serializeSlotBindings(slotBindings),
        taskTemplates,
        reviewAcknowledgements,
        promptOrder,
        expectedPresetRevision,
        expectedConfigRevision,
      },
    )
    return normalizeEditorResult(result)
  },
}
