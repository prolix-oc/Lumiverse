import { del, post, put, type RequestOptions } from './client'
import { isUnknownRecord } from '@/lib/type-guards'
import type {
  LoomPolicySourceV1,
  LoomPromptInspectionItemV1,
  LoomPromptInspectionOutcomeV1,
  LoomPromptInspectionV1,
  LoomResponsePolicyOmissionV1,
} from '@/types/agent-runtime'
import type {
  CognitionPredicate,
  CognitionScalar,
  CognitionValue,
} from '@/lib/loom/types'
import type {
  AgentRuntimeCapabilityRequirement,
  AgentRuntimeRepairCode,
  ChatAgentModeWriteResponseV1,
  ChatAgentModeWriteV1,
  EffectiveRuntimePublicResponseV1,
  EffectiveRuntimeRequestV1,
  GenerationTargetV1,
  LoomRuntimePolicyV1,
  RuntimeRevision,
  SafeConnectionProjectionV1,
  SafePresetProjectionV1,
} from '@/types/effective-runtime'
import {
  AGENT_RUNTIME_REPAIR_CODES,
  LOOM_RUNTIME_POLICY_AVAILABILITY,
  LOOM_RUNTIME_POLICY_SCOPES,
  LOOM_RUNTIME_POLICY_SOURCES,
} from '@/types/effective-runtime'

/**
 * Successful API bodies are still untrusted: a proxy, stale service, or
 * malformed test double can return any JSON value. Keep the limits here so
 * every effective-runtime operation has one bounded protocol boundary.
 */
export const EFFECTIVE_RUNTIME_LIMITS = Object.freeze({
  maxIdBytes: 256,
  maxTextBytes: 4 * 1024,
  maxTokenBytes: 512,
  maxArrayItems: 64,
  maxRevision: 2_000_000_000,
  maxTimestamp: 9_000_000_000_000_000,
  maxInspectionItems: 128,
  maxPhaseInstructions: 512,
  maxPredicateDepth: 16,
  maxPredicateNodes: 256,
  maxPredicateListItems: 256,
  maxPredicateListBytes: 64 * 1024,
})

export class EffectiveRuntimeProtocolError extends Error {
  readonly code = 'malformed_response' as const

  constructor(path: string, reason = 'is invalid') {
    super(`Invalid effective runtime response: ${path} ${reason}`)
    this.name = 'EffectiveRuntimeProtocolError'
  }
}

export interface EffectiveRuntimeResponseIdentity {
  chatId: string
  target: GenerationTargetV1
}

const CAPABILITY_REQUIREMENTS = [
  'generation',
  'streaming',
  'tool_calling',
  'native_tool_continuation',
  'tools_disabled_finalization',
] as const satisfies readonly AgentRuntimeCapabilityRequirement[]

const MODES = ['response', 'agentic'] as const
const GENERATION_TYPES = ['normal', 'continue', 'regenerate', 'swipe'] as const
const PRESET_SOURCES = ['chat', 'persona', 'character', 'connection', 'default', 'forced', 'none'] as const
const OVERRIDE_STATES = ['ready', 'review_required', 'repair_required'] as const
const RUNTIME_POLICY_ACK_STATES = ['not_required', 'required', 'acknowledged'] as const
const LOOM_POLICY_BUCKETS = ['workPolicy', 'workspaceUsage', 'completionCriteria', 'renderPolicy'] as const
const LOOM_POLICY_DESTINATIONS = ['root_work', 'completion_handoff', 'render'] as const
const LOOM_POLICY_CHECKPOINTS = ['ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER'] as const
const LOOM_CONDITION_RESULTS = ['true', 'false', 'not_evaluated', 'invalid', 'not_applicable'] as const
const COGNITION_PREDICATE_KINDS = [
  'all',
  'any',
  'not',
  'generation_type',
  'phase',
  'preset_variable',
  'participant_fact',
  'tool_available',
  'task_transition',
] as const
const COGNITION_PHASES = [
  'ASSEMBLE',
  'WORK',
  'COMPLETE',
  'RENDER',
  'PREPARE_COMMIT',
  'COMMITTING',
  'COMMITTED',
  'COMMIT_FAILED',
  'EXHAUSTED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
] as const
const COGNITION_TASK_TRANSITIONS = ['pending', 'active', 'blocked', 'completed', 'cancelled', 'failed'] as const
const LOOM_ROUTE_BY_BUCKET = {
  workPolicy: { destination: 'root_work', checkpoint: 'WORK' },
  workspaceUsage: { destination: 'root_work', checkpoint: 'WORK' },
  completionCriteria: { destination: 'completion_handoff', checkpoint: 'PREPARE_COMMIT' },
  renderPolicy: { destination: 'render', checkpoint: 'RENDER' },
} as const satisfies Record<
  LoomPromptInspectionItemV1['bucket'],
  {
    destination: LoomPromptInspectionItemV1['destination']
    checkpoint: LoomPromptInspectionItemV1['checkpoint']
  }
>

type RuntimeRecord = Record<string, unknown>

function invalid(path: string, reason?: string): never {
  throw new EffectiveRuntimeProtocolError(path, reason)
}

function record(value: unknown, path: string): RuntimeRecord {
  if (!isUnknownRecord(value)) invalid(path, 'must be an object')
  return value
}

function exactKeys(
  value: RuntimeRecord,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, 'is unknown')
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, 'is required')
  }
}


function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function boundedString(
  value: unknown,
  path: string,
  limit = EFFECTIVE_RUNTIME_LIMITS.maxTextBytes,
): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || byteLength(value) > limit
  ) {
    invalid(path, 'must be a bounded non-empty string')
  }
  return value
}

function nullableString(
  value: unknown,
  path: string,
  limit = EFFECTIVE_RUNTIME_LIMITS.maxTextBytes,
): string | null {
  return value === null ? null : boundedString(value, path, limit)
}

function boundedId(value: unknown, path: string): string {
  const id = boundedString(value, path, EFFECTIVE_RUNTIME_LIMITS.maxIdBytes)
  if (id !== id.trim()) invalid(path, 'must not have surrounding whitespace')
  return id
}

function nullableId(value: unknown, path: string): string | null {
  return value === null ? null : boundedId(value, path)
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'must be a boolean')
  return value
}

function boundedInteger(value: unknown, path: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > EFFECTIVE_RUNTIME_LIMITS.maxRevision
  ) {
    invalid(path, 'must be a bounded non-negative integer')
  }
  return value
}

function boundedTimestamp(value: unknown, path: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > EFFECTIVE_RUNTIME_LIMITS.maxTimestamp
  ) {
    invalid(path, 'must be a bounded timestamp')
  }
  return value
}

function nullableInteger(value: unknown, path: string): number | null {
  return value === null ? null : boundedInteger(value, path)
}

function runtimeRevision(value: unknown, path: string): RuntimeRevision | null {
  if (value === null) return null
  if (typeof value === 'number') return boundedInteger(value, path)
  if (typeof value === 'string') return boundedString(value, path, EFFECTIVE_RUNTIME_LIMITS.maxIdBytes)
  invalid(path, 'must be null, a bounded integer, or a bounded string')
}

function runtimeRevisionRequired(value: unknown, path: string): RuntimeRevision {
  const parsed = runtimeRevision(value, path)
  if (parsed === null) invalid(path, 'must be present')
  return parsed
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid(path, 'has an unsupported value')
  return value as T
}

function enumArray<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
  max: number = EFFECTIVE_RUNTIME_LIMITS.maxArrayItems,
): T[] {
  if (!Array.isArray(value) || value.length > max) invalid(path, 'must be a bounded array')
  const result: T[] = []
  const seen = new Set<T>()
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid(`${path}.${index}`, 'must not be sparse')
    const item = enumValue(value[index], values, `${path}.${index}`)
    if (seen.has(item)) invalid(`${path}.${index}`, 'must not contain duplicates')
    seen.add(item)
    result.push(item)
  }
  return result
}

function capabilityArray(value: unknown, path: string): AgentRuntimeCapabilityRequirement[] {
  return enumArray(value, CAPABILITY_REQUIREMENTS, path, CAPABILITY_REQUIREMENTS.length)
}

function repairArray(value: unknown, path: string): AgentRuntimeRepairCode[] {
  return enumArray(value, AGENT_RUNTIME_REPAIR_CODES, path)
}

function nullableRepairCode(value: unknown, path: string): AgentRuntimeRepairCode | null {
  return value === null ? null : enumValue(value, AGENT_RUNTIME_REPAIR_CODES, path)
}

function boundedArray(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(path, `must contain at most ${max} items`)
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid(`${path}.${index}`, 'must not be sparse')
  }
  return value
}

function boundedSafeText(
  value: unknown,
  path: string,
  limit = EFFECTIVE_RUNTIME_LIMITS.maxTextBytes,
): string {
  if (typeof value !== 'string' || byteLength(value) > limit) {
    invalid(path, 'must be a bounded string')
  }
  if (value.includes('{{') || value.includes('}}')) invalid(path, 'must not contain macro markup')
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      codePoint === 0
      || codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d
    ) {
      invalid(path, 'must not contain control characters')
    }
  }
  return value
}

function boundedInspectionId(value: unknown, path: string): string {
  const parsed = boundedSafeText(value, path, EFFECTIVE_RUNTIME_LIMITS.maxIdBytes)
  if (parsed.length === 0) invalid(path, 'must not be empty')
  for (const character of parsed) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x20 || codePoint === 0x7f) invalid(path, 'must not contain whitespace')
  }
  return parsed
}

interface PredicateBudget {
  nodes: number
  listBytes: number
}

function accountPredicateText(value: string, path: string, budget: PredicateBudget): void {
  budget.listBytes += byteLength(value)
  if (budget.listBytes > EFFECTIVE_RUNTIME_LIMITS.maxPredicateListBytes) {
    invalid(path, 'exceeds the aggregate predicate string limit')
  }
}

function normalizePredicateScalar(
  value: unknown,
  path: string,
  budget: PredicateBudget,
): CognitionScalar {
  if (typeof value === 'string') {
    const parsed = boundedSafeText(value, path)
    accountPredicateText(parsed, path, budget)
    return parsed
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(path, 'must be finite')
    return value
  }
  if (typeof value === 'boolean') return value
  invalid(path, 'must be a string, finite number, or boolean')
}

function normalizePredicateValue(
  value: unknown,
  path: string,
  budget: PredicateBudget,
): CognitionValue {
  if (!Array.isArray(value)) return normalizePredicateScalar(value, path, budget)
  const values = boundedArray(value, path, EFFECTIVE_RUNTIME_LIMITS.maxPredicateListItems)
  return values.map((item, index) => {
    if (typeof item !== 'string') invalid(`${path}.${index}`, 'must be a string')
    const parsed = boundedSafeText(item, `${path}.${index}`)
    accountPredicateText(parsed, `${path}.${index}`, budget)
    return parsed
  })
}

function predicateScalarKey(value: CognitionScalar): string {
  return `${typeof value}:${String(value)}`
}

function normalizePredicateScalarList(
  value: unknown,
  path: string,
  budget: PredicateBudget,
): CognitionScalar[] {
  const values = boundedArray(value, path, EFFECTIVE_RUNTIME_LIMITS.maxPredicateListItems)
  if (values.length === 0) invalid(path, 'must not be empty')
  const seen = new Set<string>()
  return values.map((item, index) => {
    const parsed = normalizePredicateScalar(item, `${path}.${index}`, budget)
    const key = predicateScalarKey(parsed)
    if (seen.has(key)) invalid(`${path}.${index}`, 'must not duplicate another value')
    seen.add(key)
    return parsed
  })
}

function normalizeCognitionPredicate(
  value: unknown,
  path: string,
  budget: PredicateBudget,
  depth = 1,
): CognitionPredicate {
  if (depth > EFFECTIVE_RUNTIME_LIMITS.maxPredicateDepth) {
    invalid(path, 'exceeds the predicate depth limit')
  }
  budget.nodes += 1
  if (budget.nodes > EFFECTIVE_RUNTIME_LIMITS.maxPredicateNodes) {
    invalid(path, 'exceeds the aggregate predicate node limit')
  }
  const source = record(value, path)
  const kind = enumValue(source.kind, COGNITION_PREDICATE_KINDS, `${path}.kind`)
  if (kind === 'all' || kind === 'any') {
    exactKeys(source, ['kind', 'children'], [], path)
    const children = boundedArray(
      source.children,
      `${path}.children`,
      EFFECTIVE_RUNTIME_LIMITS.maxPredicateListItems,
    ).map((child, index) => normalizeCognitionPredicate(child, `${path}.children.${index}`, budget, depth + 1))
    return kind === 'all' ? { kind: 'all', children } : { kind: 'any', children }
  }
  if (kind === 'not') {
    exactKeys(source, ['kind', 'child'], [], path)
    return { kind, child: normalizeCognitionPredicate(source.child, `${path}.child`, budget, depth + 1) }
  }
  if (kind === 'generation_type') {
    exactKeys(source, ['kind', 'value'], [], path)
    return { kind, value: enumValue(source.value, GENERATION_TYPES, `${path}.value`) }
  }
  if (kind === 'phase') {
    exactKeys(source, ['kind', 'value'], [], path)
    return { kind, value: enumValue(source.value, COGNITION_PHASES, `${path}.value`) }
  }
  if (kind === 'preset_variable' || kind === 'participant_fact') {
    const operator = enumValue(
      source.operator,
      ['equals', 'in', 'includes', 'present'] as const,
      `${path}.operator`,
    )
    const name = boundedInspectionId(source.name, `${path}.name`)
    if (operator === 'present') {
      exactKeys(source, ['kind', 'name', 'operator'], [], path)
      return { kind, name, operator }
    }
    if (operator === 'in') {
      exactKeys(source, ['kind', 'name', 'operator', 'values'], [], path)
      return {
        kind,
        name,
        operator,
        values: normalizePredicateScalarList(source.values, `${path}.values`, budget),
      }
    }
    exactKeys(source, ['kind', 'name', 'operator', 'value'], [], path)
    if (operator === 'equals') {
      return {
        kind,
        name,
        operator,
        value: normalizePredicateValue(source.value, `${path}.value`, budget),
      }
    }
    return {
      kind,
      name,
      operator,
      value: normalizePredicateScalar(source.value, `${path}.value`, budget),
    }
  }
  if (kind === 'tool_available') {
    exactKeys(source, ['kind', 'toolId', 'available'], [], path)
    return {
      kind,
      toolId: boundedInspectionId(source.toolId, `${path}.toolId`),
      available: booleanValue(source.available, `${path}.available`),
    }
  }
  exactKeys(source, ['kind', 'taskId', 'transition'], [], path)
  return {
    kind: 'task_transition',
    taskId: boundedInspectionId(source.taskId, `${path}.taskId`),
    transition: enumValue(source.transition, COGNITION_TASK_TRANSITIONS, `${path}.transition`),
  }
}

function normalizeLoomSource(value: unknown, path: string): LoomPolicySourceV1 {
  const source = record(value, path)
  exactKeys(source, ['kind', 'blockId', 'presetRevision', 'blockRevision', 'promptOrder'], [], path)
  if (source.kind !== 'loom_block') invalid(`${path}.kind`, 'must be loom_block')
  return {
    kind: 'loom_block',
    blockId: boundedInspectionId(source.blockId, `${path}.blockId`),
    presetRevision: boundedInteger(source.presetRevision, `${path}.presetRevision`),
    blockRevision: boundedInteger(source.blockRevision, `${path}.blockRevision`),
    promptOrder: boundedInteger(source.promptOrder, `${path}.promptOrder`),
  }
}

function sameLoomSource(left: LoomPolicySourceV1, right: LoomPolicySourceV1): boolean {
  return left.kind === right.kind
    && left.blockId === right.blockId
    && left.presetRevision === right.presetRevision
    && left.blockRevision === right.blockRevision
    && left.promptOrder === right.promptOrder
}


function normalizeLoomOutcome(value: unknown, path: string): LoomPromptInspectionOutcomeV1 {
  const source = record(value, path)
  const status = enumValue(
    source.status,
    ['included', 'skipped', 'rejected', 'omitted', 'deduplicated'] as const,
    `${path}.status`,
  )
  if (status === 'included') {
    exactKeys(source, ['status', 'effectiveIndex', 'reason'], [], path)
    if (source.reason !== 'selected') invalid(`${path}.reason`, 'included items must record selected')
    return { status, effectiveIndex: boundedInteger(source.effectiveIndex, `${path}.effectiveIndex`), reason: 'selected' }
  }
  if (status === 'skipped') {
    exactKeys(source, ['status', 'reason'], [], path)
    return {
      status,
      reason: enumValue(
        source.reason,
        ['checkpoint_not_reached', 'condition_not_met', 'stale_source'] as const,
        `${path}.reason`,
      ),
    }
  }
  if (status === 'rejected') {
    exactKeys(source, ['status', 'reason'], [], path)
    return {
      status,
      reason: enumValue(
        source.reason,
        ['invalid_source', 'stale_source', 'required_source_unavailable'] as const,
        `${path}.reason`,
      ),
    }
  }
  if (status === 'omitted') {
    exactKeys(source, ['status', 'reason'], [], path)
    return {
      status,
      reason: enumValue(
        source.reason,
        ['response_mode', 'destination_unavailable', 'not_work_surface'] as const,
        `${path}.reason`,
      ),
    }
  }
  exactKeys(source, ['status', 'reason', 'keptEntryId', 'destination'], [], path)
  if (source.reason !== 'destination_overlap') invalid(`${path}.reason`, 'deduplicated items must record destination_overlap')
  return {
    status,
    reason: 'destination_overlap',
    keptEntryId: boundedInspectionId(source.keptEntryId, `${path}.keptEntryId`),
    destination: enumValue(source.destination, LOOM_POLICY_DESTINATIONS, `${path}.destination`),
  }
}

function normalizeLoomInspectionItem(
  value: unknown,
  path: string,
  budget: PredicateBudget,
): LoomPromptInspectionItemV1 {
  const source = record(value, path)
  exactKeys(
    source,
    [
      'entryId',
      'bucket',
      'destination',
      'checkpoint',
      'source',
      'effectiveText',
      'required',
      'ordinaryPromptSuppressed',
      'outcome',
    ],
    ['condition', 'conditionResult'],
    path,
  )
  const bucket = enumValue(source.bucket, LOOM_POLICY_BUCKETS, `${path}.bucket`)
  const destination = enumValue(source.destination, LOOM_POLICY_DESTINATIONS, `${path}.destination`)
  const checkpoint = enumValue(source.checkpoint, LOOM_POLICY_CHECKPOINTS, `${path}.checkpoint`)
  const fixedRoute = LOOM_ROUTE_BY_BUCKET[bucket]
  if (destination !== fixedRoute.destination) invalid(`${path}.destination`, 'does not match its fixed bucket route')
  if (checkpoint !== fixedRoute.checkpoint) invalid(`${path}.checkpoint`, 'does not match its fixed bucket route')
  const condition = Object.hasOwn(source, 'condition')
    ? normalizeCognitionPredicate(source.condition, `${path}.condition`, budget)
    : undefined
  const conditionResult = Object.hasOwn(source, 'conditionResult')
    ? enumValue(source.conditionResult, LOOM_CONDITION_RESULTS, `${path}.conditionResult`)
    : undefined
  return {
    entryId: boundedInspectionId(source.entryId, `${path}.entryId`),
    bucket,
    destination,
    checkpoint,
    source: normalizeLoomSource(source.source, `${path}.source`),
    ...(condition === undefined ? {} : { condition }),
    ...(conditionResult === undefined ? {} : { conditionResult }),
    effectiveText: source.effectiveText === null
      ? null
      : boundedSafeText(source.effectiveText, `${path}.effectiveText`),
    required: booleanValue(source.required, `${path}.required`),
    ordinaryPromptSuppressed: booleanValue(
      source.ordinaryPromptSuppressed,
      `${path}.ordinaryPromptSuppressed`,
    ),
    outcome: normalizeLoomOutcome(source.outcome, `${path}.outcome`),
  }
}

function normalizeLoomResponseOmission(
  value: unknown,
  path: string,
): LoomResponsePolicyOmissionV1 {
  const source = record(value, path)
  exactKeys(
    source,
    ['version', 'surface', 'visibility', 'reason', 'omittedEntryIds', 'source', 'omittedPhaseInstructions'],
    ['reviewReason'],
    path,
  )
  if (source.version !== 1) invalid(`${path}.version`, 'must be version 1')
  if (source.surface !== 'RESPONSE') invalid(`${path}.surface`, 'must be RESPONSE')
  if (source.visibility !== 'work_only') invalid(`${path}.visibility`, 'must be work_only')
  if (source.reason !== 'work_only') invalid(`${path}.reason`, 'must be work_only')
  const seenEntryIds = new Set<string>()
  const omittedEntryIds = boundedArray(
    source.omittedEntryIds,
    `${path}.omittedEntryIds`,
    EFFECTIVE_RUNTIME_LIMITS.maxInspectionItems,
  ).map((entryId, index) => {
    const parsed = boundedInspectionId(entryId, `${path}.omittedEntryIds.${index}`)
    if (seenEntryIds.has(parsed)) invalid(`${path}.omittedEntryIds.${index}`, 'must not contain duplicates')
    seenEntryIds.add(parsed)
    return parsed
  })
  const sources = boundedArray(
    source.source,
    `${path}.source`,
    EFFECTIVE_RUNTIME_LIMITS.maxInspectionItems,
  ).map((item, index) => normalizeLoomSource(item, `${path}.source.${index}`))
  if (sources.length !== omittedEntryIds.length) {
    invalid(path, 'must contain one source for every omitted entry')
  }
  const omittedPhaseInstructions = boundedArray(
    source.omittedPhaseInstructions,
    `${path}.omittedPhaseInstructions`,
    EFFECTIVE_RUNTIME_LIMITS.maxPhaseInstructions,
  ).map((item, index) => {
    const itemPath = `${path}.omittedPhaseInstructions.${index}`
    const instruction = record(item, itemPath)
    exactKeys(instruction, ['phaseId', 'source'], ['profileId'], itemPath)
    const phaseId = boundedInspectionId(instruction.phaseId, `${itemPath}.phaseId`)
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(phaseId)) {
      invalid(`${itemPath}.phaseId`, 'must be a stable lowercase identifier')
    }
    const instructionSource = normalizeLoomSource(instruction.source, `${itemPath}.source`)
    if (!Object.hasOwn(instruction, 'profileId')) {
      return { phaseId, source: instructionSource }
    }
    const profileId = boundedInspectionId(instruction.profileId, `${itemPath}.profileId`)
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(profileId)) {
      invalid(`${itemPath}.profileId`, 'must be a stable lowercase identifier')
    }
    return { phaseId, source: instructionSource, profileId }
  })
  const reviewReason = Object.hasOwn(source, 'reviewReason')
    ? boundedInspectionId(source.reviewReason, `${path}.reviewReason`)
    : undefined
  return {
    version: 1,
    surface: 'RESPONSE',
    visibility: 'work_only',
    reason: 'work_only',
    omittedEntryIds,
    source: sources,
    omittedPhaseInstructions,
    ...(reviewReason === undefined ? {} : { reviewReason }),
  }
}

function sameLoomResponseOmission(
  left: LoomResponsePolicyOmissionV1,
  right: LoomResponsePolicyOmissionV1,
): boolean {
  if (
    left.version !== right.version
    || left.surface !== right.surface
    || left.visibility !== right.visibility
    || left.reason !== right.reason
    || left.reviewReason !== right.reviewReason
    || left.omittedEntryIds.length !== right.omittedEntryIds.length
    || left.source.length !== right.source.length
    || left.omittedPhaseInstructions.length !== right.omittedPhaseInstructions.length
  ) return false
  for (let index = 0; index < left.omittedEntryIds.length; index += 1) {
    if (
      left.omittedEntryIds[index] !== right.omittedEntryIds[index]
      || !sameLoomSource(left.source[index], right.source[index])
    ) return false
  }
  for (let index = 0; index < left.omittedPhaseInstructions.length; index += 1) {
    const leftInstruction = left.omittedPhaseInstructions[index]
    const rightInstruction = right.omittedPhaseInstructions[index]
    if (
      leftInstruction.phaseId !== rightInstruction.phaseId
      || leftInstruction.profileId !== rightInstruction.profileId
      || !sameLoomSource(leftInstruction.source, rightInstruction.source)
    ) return false
  }
  return true
}

function normalizeLoomInspection(value: unknown, path: string): LoomPromptInspectionV1 {
  const source = record(value, path)
  exactKeys(
    source,
    ['version', 'surface', 'checkpoint', 'items', 'effectiveEntryIds'],
    ['responseOmission'],
    path,
  )
  if (source.version !== 1) invalid(`${path}.version`, 'must be version 1')
  const surface = enumValue(source.surface, ['WORK', 'RESPONSE'] as const, `${path}.surface`)
  const checkpoint = enumValue(source.checkpoint, LOOM_POLICY_CHECKPOINTS, `${path}.checkpoint`)
  const budget: PredicateBudget = { nodes: 0, listBytes: 0 }
  const itemIds = new Set<string>()
  const items = boundedArray(
    source.items,
    `${path}.items`,
    EFFECTIVE_RUNTIME_LIMITS.maxInspectionItems,
  ).map((item, index) => {
    const normalized = normalizeLoomInspectionItem(item, `${path}.items.${index}`, budget)
    if (itemIds.has(normalized.entryId)) invalid(`${path}.items.${index}.entryId`, 'must be unique')
    itemIds.add(normalized.entryId)
    return normalized
  })
  const seenEffectiveEntryIds = new Set<string>()
  const effectiveEntryIds = boundedArray(
    source.effectiveEntryIds,
    `${path}.effectiveEntryIds`,
    EFFECTIVE_RUNTIME_LIMITS.maxInspectionItems,
  ).map((entryId, index) => {
    const parsed = boundedInspectionId(entryId, `${path}.effectiveEntryIds.${index}`)
    if (seenEffectiveEntryIds.has(parsed)) {
      invalid(`${path}.effectiveEntryIds.${index}`, 'must not contain duplicates')
    }
    seenEffectiveEntryIds.add(parsed)
    return parsed
  })
  let includedCount = 0
  for (const item of items) {
    if (item.outcome.status !== 'included') continue
    includedCount += 1
    if (effectiveEntryIds[item.outcome.effectiveIndex] !== item.entryId) {
      invalid(`${path}.effectiveEntryIds`, 'must match every included item and effective index')
    }
  }
  if (includedCount !== effectiveEntryIds.length) {
    invalid(`${path}.effectiveEntryIds`, 'must contain exactly the included items')
  }
  const responseOmission = Object.hasOwn(source, 'responseOmission')
    ? normalizeLoomResponseOmission(source.responseOmission, `${path}.responseOmission`)
    : undefined
  if (surface === 'WORK') {
    if (responseOmission !== undefined) {
      invalid(`${path}.responseOmission`, 'must be absent for WORK inspection')
    }
  } else {
    if (!responseOmission) invalid(`${path}.responseOmission`, 'is required for Response inspection')
    if (responseOmission.omittedEntryIds.length !== items.length) {
      invalid(`${path}.responseOmission`, 'must account for every Response inspection item')
    }
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (
        item.outcome.status !== 'omitted'
        || item.outcome.reason !== 'response_mode'
        || responseOmission.omittedEntryIds[index] !== item.entryId
        || !sameLoomSource(responseOmission.source[index], item.source)
      ) {
        invalid(`${path}.responseOmission`, 'must match Response item IDs, sources, and outcomes in order')
      }
    }
  }
  return {
    version: 1,
    surface,
    checkpoint,
    items,
    effectiveEntryIds,
    ...(responseOmission === undefined ? {} : { responseOmission }),
  }
}

function normalizeTarget(value: unknown, path: string): GenerationTargetV1 {
  const source = record(value, path)
  exactKeys(
    source,
    ['generationType'],
    ['messageId', 'swipeId', 'branchId', 'targetCharacterId', 'revision'],
    path,
  )
  const target: GenerationTargetV1 = {
    generationType: enumValue(source.generationType, GENERATION_TYPES, `${path}.generationType`),
  }
  if (Object.hasOwn(source, 'messageId')) target.messageId = nullableId(source.messageId, `${path}.messageId`)
  if (Object.hasOwn(source, 'swipeId')) target.swipeId = nullableInteger(source.swipeId, `${path}.swipeId`)
  if (Object.hasOwn(source, 'branchId')) target.branchId = nullableId(source.branchId, `${path}.branchId`)
  if (Object.hasOwn(source, 'targetCharacterId')) {
    target.targetCharacterId = nullableId(source.targetCharacterId, `${path}.targetCharacterId`)
  }
  if (Object.hasOwn(source, 'revision')) target.revision = runtimeRevision(source.revision, `${path}.revision`)
  return target
}

function sameTarget(left: GenerationTargetV1, right: GenerationTargetV1): boolean {
  if (left.generationType !== right.generationType) return false
  const optionalKeys = ['messageId', 'swipeId', 'branchId', 'targetCharacterId', 'revision'] as const
  for (const key of optionalKeys) {
    const leftPresent = Object.hasOwn(left, key)
    const rightPresent = Object.hasOwn(right, key)
    if (leftPresent !== rightPresent) return false
    if (leftPresent && left[key] !== right[key]) return false
  }
  return true
}

function normalizeExpectedIdentity(
  identity: EffectiveRuntimeResponseIdentity,
): EffectiveRuntimeResponseIdentity {
  return {
    chatId: boundedId(identity.chatId, 'request.chatId'),
    target: normalizeTarget(identity.target, 'request.target'),
  }
}

function normalizeConnection(value: unknown): SafeConnectionProjectionV1 {
  const source = record(value, 'connection')
  exactKeys(
    source,
    ['id', 'label', 'provider', 'model', 'revision', 'endpointRevision', 'credentialRevision', 'candidateRevision'],
    [],
    'connection',
  )
  return {
    id: nullableId(source.id, 'connection.id'),
    label: nullableString(source.label, 'connection.label'),
    provider: nullableString(source.provider, 'connection.provider'),
    model: nullableString(source.model, 'connection.model'),
    revision: runtimeRevision(source.revision, 'connection.revision'),
    endpointRevision: runtimeRevision(source.endpointRevision, 'connection.endpointRevision'),
    credentialRevision: runtimeRevision(source.credentialRevision, 'connection.credentialRevision'),
    candidateRevision: runtimeRevision(source.candidateRevision, 'connection.candidateRevision'),
  }
}

function normalizePreset(value: unknown): SafePresetProjectionV1 {
  const source = record(value, 'preset')
  exactKeys(source, ['id', 'label', 'revision', 'source'], [], 'preset')
  return {
    id: nullableId(source.id, 'preset.id'),
    label: nullableString(source.label, 'preset.label'),
    revision: runtimeRevision(source.revision, 'preset.revision'),
    source: enumValue(source.source, PRESET_SOURCES, 'preset.source'),
  }
}

function normalizeChatOverride(value: unknown): EffectiveRuntimePublicResponseV1['chatOverride'] {
  if (value === null) return null
  const source = record(value, 'chatOverride')
  exactKeys(source, ['mode', 'revision', 'state'], ['reviewCode', 'acknowledged'], 'chatOverride')
  const override: NonNullable<EffectiveRuntimePublicResponseV1['chatOverride']> = {
    mode: source.mode === null ? null : enumValue(source.mode, MODES, 'chatOverride.mode'),
    revision: boundedInteger(source.revision, 'chatOverride.revision'),
    state: enumValue(source.state, OVERRIDE_STATES, 'chatOverride.state'),
  }
  if (Object.hasOwn(source, 'reviewCode')) override.reviewCode = nullableString(source.reviewCode, 'chatOverride.reviewCode')
  if (Object.hasOwn(source, 'acknowledged')) override.acknowledged = booleanValue(source.acknowledged, 'chatOverride.acknowledged')
  return override
}

function normalizeRuntimePolicy(value: unknown): LoomRuntimePolicyV1 {
  const source = record(value, 'runtimePolicy')
  exactKeys(
    source,
    [
      'version',
      'authoredValue',
      'effectiveValue',
      'source',
      'scope',
      'cap',
      'availability',
      'presetRevision',
      'transientSelection',
      'durableChatOverride',
      'repairAcknowledgement',
      'nextTurnOnly',
    ],
    [],
    'runtimePolicy',
  )
  if (source.version !== 1) invalid('runtimePolicy.version', 'must be version 1')
  if (source.nextTurnOnly !== true) invalid('runtimePolicy.nextTurnOnly', 'must be true')

  const capSource = record(source.cap, 'runtimePolicy.cap')
  exactKeys(capSource, ['authority', 'allowedModes', 'reasonCode'], [], 'runtimePolicy.cap')
  if (capSource.authority !== 'host') invalid('runtimePolicy.cap.authority', 'must be host')
  const allowedModes = enumArray(capSource.allowedModes, MODES, 'runtimePolicy.cap.allowedModes', MODES.length)
  const availabilitySource = record(source.availability, 'runtimePolicy.availability')
  exactKeys(availabilitySource, ['state', 'reasonCode'], [], 'runtimePolicy.availability')

  let transientSelection: LoomRuntimePolicyV1['transientSelection'] = null
  if (source.transientSelection !== null) {
    const transientSource = record(source.transientSelection, 'runtimePolicy.transientSelection')
    exactKeys(transientSource, ['mode', 'turnFence', 'authenticated'], [], 'runtimePolicy.transientSelection')
    if (transientSource.authenticated !== true) invalid('runtimePolicy.transientSelection.authenticated', 'must be true')
    transientSelection = {
      mode: enumValue(transientSource.mode, MODES, 'runtimePolicy.transientSelection.mode'),
      turnFence: runtimeRevisionRequired(transientSource.turnFence, 'runtimePolicy.transientSelection.turnFence'),
      authenticated: true,
    }
  }

  let durableChatOverride: LoomRuntimePolicyV1['durableChatOverride'] = null
  if (source.durableChatOverride !== null) {
    const durableSource = record(source.durableChatOverride, 'runtimePolicy.durableChatOverride')
    exactKeys(
      durableSource,
      ['mode', 'revision', 'state', 'reviewCode', 'acknowledged'],
      [],
      'runtimePolicy.durableChatOverride',
    )
    durableChatOverride = {
      mode: durableSource.mode === null
        ? null
        : enumValue(durableSource.mode, MODES, 'runtimePolicy.durableChatOverride.mode'),
      revision: boundedInteger(durableSource.revision, 'runtimePolicy.durableChatOverride.revision'),
      state: enumValue(durableSource.state, OVERRIDE_STATES, 'runtimePolicy.durableChatOverride.state'),
      reviewCode: nullableString(durableSource.reviewCode, 'runtimePolicy.durableChatOverride.reviewCode'),
      acknowledged: booleanValue(durableSource.acknowledged, 'runtimePolicy.durableChatOverride.acknowledged'),
    }
  }

  const acknowledgementSource = record(source.repairAcknowledgement, 'runtimePolicy.repairAcknowledgement')
  exactKeys(
    acknowledgementSource,
    ['state', 'presetRevision', 'reasonCode', 'acknowledgedAt'],
    [],
    'runtimePolicy.repairAcknowledgement',
  )
  const normalizedSource = enumValue(source.source, LOOM_RUNTIME_POLICY_SOURCES, 'runtimePolicy.source')
  const normalizedScope = enumValue(source.scope, LOOM_RUNTIME_POLICY_SCOPES, 'runtimePolicy.scope')
  const expectedScope = normalizedSource === 'authenticated_one_turn'
    ? 'turn'
    : normalizedSource === 'durable_chat_override'
      ? 'chat'
      : normalizedSource === 'reviewed_preset_default'
        ? 'preset'
        : normalizedSource === 'response_fallback'
          ? 'fallback'
          : 'host'
  if (normalizedScope !== expectedScope) invalid('runtimePolicy.scope', 'does not match runtimePolicy.source')
  return {
    version: 1,
    authoredValue: enumValue(source.authoredValue, MODES, 'runtimePolicy.authoredValue'),
    effectiveValue: enumValue(source.effectiveValue, MODES, 'runtimePolicy.effectiveValue'),
    source: normalizedSource,
    scope: normalizedScope,
    cap: {
      authority: 'host',
      allowedModes,
      reasonCode: nullableRepairCode(capSource.reasonCode, 'runtimePolicy.cap.reasonCode'),
    },
    availability: {
      state: enumValue(availabilitySource.state, LOOM_RUNTIME_POLICY_AVAILABILITY, 'runtimePolicy.availability.state'),
      reasonCode: nullableRepairCode(availabilitySource.reasonCode, 'runtimePolicy.availability.reasonCode'),
    },
    presetRevision: runtimeRevision(source.presetRevision, 'runtimePolicy.presetRevision'),
    transientSelection,
    durableChatOverride,
    repairAcknowledgement: {
      state: enumValue(acknowledgementSource.state, RUNTIME_POLICY_ACK_STATES, 'runtimePolicy.repairAcknowledgement.state'),
      presetRevision: runtimeRevision(acknowledgementSource.presetRevision, 'runtimePolicy.repairAcknowledgement.presetRevision'),
      reasonCode: nullableString(acknowledgementSource.reasonCode, 'runtimePolicy.repairAcknowledgement.reasonCode'),
      acknowledgedAt: acknowledgementSource.acknowledgedAt === null
        ? null
        : boundedTimestamp(acknowledgementSource.acknowledgedAt, 'runtimePolicy.repairAcknowledgement.acknowledgedAt'),
    },
    nextTurnOnly: true,
  }
}

/**
 * Normalize one successful effective-runtime decision. If an expected
 * identity is supplied, the response must be for that exact chat and target;
 * callers must not inspect the raw body before this function returns.
 */
export function normalizeEffectiveRuntimeResponse(
  payload: unknown,
  expectedIdentity?: EffectiveRuntimeResponseIdentity,
): EffectiveRuntimePublicResponseV1 {
  const source = record(payload, 'response')
  exactKeys(
    source,
    [
      'version',
      'chatId',
      'target',
      'connection',
      'preset',
      'agentsEnabled',
      'allowedModes',
      'defaultMode',
      'requestedMode',
      'effectiveMode',
      'inspection',
      'responseOmission',
      'runtimePolicy',
      'chatOverride',
      'capabilityReadiness',
      'repairCodes',
      'runtimeDecisionToken',
      'runtimeDecisionExpiresAt',
    ],
    [],
    'response',
  )
  if (source.version !== 1) invalid('response.version', 'must be version 1')
  const chatId = boundedId(source.chatId, 'response.chatId')
  const target = normalizeTarget(source.target, 'response.target')
  const allowedModes = enumArray(source.allowedModes, MODES, 'response.allowedModes', MODES.length)
  const capabilitySource = record(source.capabilityReadiness, 'response.capabilityReadiness')
  exactKeys(
    capabilitySource,
    ['ready', 'sameDomain', 'required', 'missing', 'repairCodes', 'responseEscape'],
    [],
    'response.capabilityReadiness',
  )
  const required = capabilityArray(capabilitySource.required, 'response.capabilityReadiness.required')
  const missing = capabilityArray(capabilitySource.missing, 'response.capabilityReadiness.missing')
  if (missing.some((item) => !required.includes(item))) {
    invalid('response.capabilityReadiness.missing', 'must be a subset of required')
  }
  const ready = booleanValue(capabilitySource.ready, 'response.capabilityReadiness.ready')
  if (ready && missing.length > 0) invalid('response.capabilityReadiness.ready', 'cannot be true with missing capabilities')
  const capabilityRepairCodes = repairArray(capabilitySource.repairCodes, 'response.capabilityReadiness.repairCodes')
  if (capabilitySource.responseEscape !== 'available') {
    invalid('response.capabilityReadiness.responseEscape', 'must be available')
  }
  const effectiveMode = enumValue(source.effectiveMode, MODES, 'response.effectiveMode')
  if (!allowedModes.includes(effectiveMode)) invalid('response.effectiveMode', 'must be allowed')
  const defaultMode = enumValue(source.defaultMode, MODES, 'response.defaultMode')
  const requestedMode = enumValue(source.requestedMode, MODES, 'response.requestedMode')
  let inspection = normalizeLoomInspection(source.inspection, 'response.inspection')
  const responseOmission = source.responseOmission === null
    ? null
    : normalizeLoomResponseOmission(source.responseOmission, 'response.responseOmission')
  const expectedInspectionSurface = effectiveMode === 'response' ? 'RESPONSE' : 'WORK'
  if (inspection.surface !== expectedInspectionSurface) {
    invalid('response.inspection.surface', 'must match the final effective mode')
  }
  if (effectiveMode === 'response') {
    if (!responseOmission || !inspection.responseOmission) {
      invalid('response.responseOmission', 'is required for effective Response mode')
    }
    if (!sameLoomResponseOmission(responseOmission, inspection.responseOmission)) {
      invalid('response.responseOmission', 'must match inspection.responseOmission exactly')
    }
    inspection = { ...inspection, responseOmission }
  } else if (responseOmission !== null) {
    invalid('response.responseOmission', 'must be null for an effective WORK surface')
  }
  const runtimePolicy = normalizeRuntimePolicy(source.runtimePolicy)
  if (runtimePolicy.authoredValue !== requestedMode) {
    invalid('response.requestedMode', 'must match runtimePolicy.authoredValue')
  }
  if (runtimePolicy.effectiveValue !== effectiveMode) {
    invalid('response.effectiveMode', 'must match runtimePolicy.effectiveValue')
  }
  if (!runtimePolicy.cap.allowedModes.includes(runtimePolicy.effectiveValue)) {
    invalid('runtimePolicy.effectiveValue', 'must be allowed by runtimePolicy.cap')
  }
  if (runtimePolicy.cap.allowedModes.some((mode) => !allowedModes.includes(mode))) {
    invalid('runtimePolicy.cap.allowedModes', 'must be a subset of response.allowedModes')
  }
  const parsedToken = source.runtimeDecisionToken === null
    ? null
    : boundedString(source.runtimeDecisionToken, 'response.runtimeDecisionToken', EFFECTIVE_RUNTIME_LIMITS.maxTokenBytes)
  const parsedExpiry = source.runtimeDecisionExpiresAt === null
    ? null
    : boundedTimestamp(source.runtimeDecisionExpiresAt, 'response.runtimeDecisionExpiresAt')
  if ((parsedToken === null) !== (parsedExpiry === null)) {
    invalid('response.runtimeDecisionToken', 'and runtimeDecisionExpiresAt must both be null or present')
  }
  if (effectiveMode === 'agentic' && (!ready || parsedToken === null)) {
    invalid('response.effectiveMode', 'agentic decisions must be ready and tokenized')
  }
  const normalized: EffectiveRuntimePublicResponseV1 = {
    version: 1,
    chatId,
    target,
    connection: normalizeConnection(source.connection),
    preset: normalizePreset(source.preset),
    agentsEnabled: booleanValue(source.agentsEnabled, 'response.agentsEnabled'),
    allowedModes,
    defaultMode,
    requestedMode,
    effectiveMode,
    inspection,
    responseOmission,
    runtimePolicy,
    chatOverride: normalizeChatOverride(source.chatOverride),
    capabilityReadiness: {
      ready,
      sameDomain: booleanValue(capabilitySource.sameDomain, 'response.capabilityReadiness.sameDomain'),
      required,
      missing,
      repairCodes: capabilityRepairCodes,
      responseEscape: 'available',
    },
    repairCodes: repairArray(source.repairCodes, 'response.repairCodes'),
    runtimeDecisionToken: parsedToken,
    runtimeDecisionExpiresAt: parsedExpiry,
  }
  if (expectedIdentity) {
    const expected = normalizeExpectedIdentity(expectedIdentity)
    if (normalized.chatId !== expected.chatId || !sameTarget(normalized.target, expected.target)) {
      invalid('response.identity', 'does not match the request')
    }
  }
  return normalized
}

export function normalizeChatAgentModeWriteResponse(
  payload: unknown,
  expectedChatId?: string,
): ChatAgentModeWriteResponseV1 {
  const source = record(payload, 'response')
  exactKeys(source, ['chatId', 'mode', 'revision', 'state'], ['appliesTo'], 'response')
  const chatId = boundedId(source.chatId, 'response.chatId')
  if (expectedChatId !== undefined && chatId !== boundedId(expectedChatId, 'request.chatId')) {
    invalid('response.chatId', 'does not match the request')
  }
  const response: ChatAgentModeWriteResponseV1 = {
    chatId,
    mode: source.mode === null ? null : enumValue(source.mode, MODES, 'response.mode'),
    revision: boundedInteger(source.revision, 'response.revision'),
    state: enumValue(source.state, OVERRIDE_STATES, 'response.state'),
  }
  if (Object.hasOwn(source, 'appliesTo')) {
    response.appliesTo = enumValue(source.appliesTo, ['next_turn'] as const, 'response.appliesTo')
  }
  return response
}

export function normalizeEffectiveRuntimeRequestIdentity(
  request: EffectiveRuntimeRequestV1,
): EffectiveRuntimeResponseIdentity {
  if (request.target === null || request.target === undefined) invalid('request.target', 'is required')
  if (
    request.generationType !== undefined
    && request.generationType !== request.target.generationType
  ) {
    invalid('request.generationType', 'must match request.target.generationType')
  }
  return normalizeExpectedIdentity({
    chatId: request.chatId,
    target: request.target,
  })
}

export const effectiveRuntimeApi = {
  async resolve(request: EffectiveRuntimeRequestV1, options?: RequestOptions) {
    const identity = normalizeEffectiveRuntimeRequestIdentity(request)
    const payload = await post<unknown>('/generate/effective-runtime', request, options)
    return normalizeEffectiveRuntimeResponse(payload, identity)
  },

  async setChatMode(chatId: string, input: ChatAgentModeWriteV1) {
    const payload = await put<unknown>(`/chats/${encodeURIComponent(chatId)}/agent-mode`, input)
    return normalizeChatAgentModeWriteResponse(payload, chatId)
  },
  async resetChatMode(chatId: string, expectedRevision: number) {
    const payload = await del<unknown>(
      `/chats/${encodeURIComponent(chatId)}/agent-mode`,
      { body: { expectedRevision } },
    )
    return normalizeChatAgentModeWriteResponse(payload, chatId)
  },
}
