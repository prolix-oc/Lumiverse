import {
  AGENT_CUSTOM_PHASE_CAPABILITIES,
  AGENT_INVOCATION_MIN,
  AGENT_TOOL_CALL_MIN,
  WORKSPACE_CAPABILITIES,
  type AgentCapability,
  type AgentCognitionPolicy,
  type AgentConfigRepairItem,
  type AgentCustomPhaseCapability,
  type AgentCustomPhaseV1,
  type AgentConfigV2,
  type AgentMode,
  type AgentProfileConfigV2,
  type AgentRuntimePolicyV1,
  type AgentTaskTemplate,
  type AgenticRuntimeQuarantineItem,
  type AgenticRuntimeSaveDraft,
  type CognitionPredicate,
  type CoreAgentToolId,
  type LoomPreset,
  type PromptBlock,
  type WorkspaceCapability,
} from './types'
import { generateUUID } from '@/lib/uuid'
import { isUnknownRecord } from '@/lib/type-guards'
import type {
  LoomPolicyBucketV1,
  LoomPolicyBucketsV1,
  LoomPolicyCheckpointV1,
  LoomPolicyDestinationV1,
  LoomPolicyEntryV1,
  LoomPolicySourceV1,
  LoomPromptInspectionBlockV1,
  LoomPromptInspectionInputV1,
  LoomPromptInspectionItemV1,
  LoomPromptInspectionOutcomeV1,
  LoomPromptInspectionV1,
  LoomResponsePolicyOmissionV1,
  LoomResponsePolicyPhaseInstructionV1,
} from '@/types/agent-runtime'

export const AGENTIC_PREDICATE_MAX_DEPTH = 16
export const AGENTIC_PREDICATE_MAX_NODES = 256
const AGENTIC_PREDICATE_DRAFT_SCAN_MAX_NODES = AGENTIC_PREDICATE_MAX_NODES + 1
export const AGENTIC_TASK_TEMPLATE_LIMIT = 256
export const AGENTIC_CUSTOM_PHASE_LIMIT = 64
export const AGENTIC_LOOM_POLICY_BUCKET_LIMIT = 64
export const AGENTIC_LOOM_POLICY_LIMIT = 128
export const AGENTIC_LABEL_MAX_LENGTH = 80
export const AGENTIC_PREDICATE_MAX_LIST_ITEMS = 256
export const AGENTIC_PREDICATE_MAX_STRING_BYTES = 4 * 1024
export const AGENTIC_PREDICATE_MAX_LIST_BYTES = 64 * 1024
export const AGENTIC_PREDICATE_MAX_ID_BYTES = 256
export const AGENTIC_CUSTOM_PHASE_INSTRUCTION_BLOCK_ID_MAX_LENGTH = 128
export const AGENTIC_DESCRIPTION_MAX_BYTES = 8 * 1024
const UTF8_ENCODER = new TextEncoder()
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const SLOT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}(?:\/[a-z][a-z0-9_-]{0,63})?$/
const POLICY_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const COGNITION_POLICY_KEYS = ['workPolicy', 'workspaceUsage', 'completionCriteria', 'renderPolicy'] as const
type CognitionPolicyKey = (typeof COGNITION_POLICY_KEYS)[number]
const AGENT_MARKER_PATTERN = /\{\{agent::([^{}\s:]+)(?:::as=[^{}\s:]+)?\}\}/g

export function isCanonicalBlockRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}


function promptBlockRevision(block: PromptBlock, path: string): number {
  if (block.revision === undefined) return 1
  if (!isCanonicalBlockRevision(block.revision)) {
    return loomPolicyError(path, 'must be a non-negative safe integer')
  }
  return block.revision
}
const LOOM_POLICY_BUCKET_ORDER = ['workPolicy', 'workspaceUsage', 'completionCriteria', 'renderPolicy'] as const
const LOOM_POLICY_DESTINATION_BY_BUCKET: Record<LoomPolicyBucketV1, LoomPolicyDestinationV1> = {
  workPolicy: 'root_work',
  workspaceUsage: 'root_work',
  completionCriteria: 'completion_handoff',
  renderPolicy: 'render',
}
const LOOM_POLICY_CHECKPOINT_BY_BUCKET: Record<LoomPolicyBucketV1, LoomPolicyCheckpointV1> = {
  workPolicy: 'WORK',
  workspaceUsage: 'WORK',
  completionCriteria: 'PREPARE_COMMIT',
  renderPolicy: 'RENDER',
}
const LOOM_POLICY_CHECKPOINT_RANK: Record<LoomPolicyCheckpointV1, number> = {
  ASSEMBLE: 0,
  WORK: 1,
  PREPARE_COMMIT: 2,
  RENDER: 3,
}
export const LOOM_RESPONSE_OMISSION_MAX_PHASE_INSTRUCTIONS = 4096

class CognitionPredicateLimitError extends Error {
  readonly code = 'predicate_limit_exceeded'

  constructor(readonly path: string) {
    super(`${path}: predicate limit exceeded`)
    this.name = 'CognitionPredicateLimitError'
  }
}

function cognitionPredicateLimitError(path: string): never {
  throw new CognitionPredicateLimitError(path)
}

function isCognitionPredicateLimitError(value: unknown): value is CognitionPredicateLimitError {
  return value instanceof CognitionPredicateLimitError
}

function loomPolicyError(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}

function loomPolicyRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) return loomPolicyError(path, 'must be an object')
  return value
}

function loomPolicyExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) if (!allowed.has(key)) loomPolicyError(`${path}.${key}`, 'unknown key')
}

function loomPolicyString(value: unknown, path: string, maxBytes = 4 * 1024): string {
  if (typeof value !== 'string' || value.length === 0 || UTF8_ENCODER.encode(value).byteLength > maxBytes) {
    return loomPolicyError(path, 'must be a bounded non-empty string')
  }
  if (value.includes('{{') || value.includes('}}') || [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x20 || codePoint === 0x7f
  })) {
    return loomPolicyError(path, 'must be a safe identifier')
  }
  return value
}

function loomPolicyLabel(value: unknown, path: string): string {
  if (typeof value !== 'string' || [...value].length > AGENTIC_LABEL_MAX_LENGTH) {
    return loomPolicyError(path, `must be at most ${AGENTIC_LABEL_MAX_LENGTH} characters`)
  }
  return value
}

function loomPolicyRevision(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return loomPolicyError(path, 'must be a non-negative safe integer')
  return value
}

function loomPolicyBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') return loomPolicyError(path, 'must be a boolean')
  return value
}

function parseLoomPolicySourceV1(
  value: unknown,
  path: string,
  blockIdMaxBytes = 256,
  blockIdMaxCharacters?: number,
): LoomPolicySourceV1 {
  const object = loomPolicyRecord(value, path)
  loomPolicyExactKeys(object, ['kind', 'blockId', 'presetRevision', 'blockRevision', 'promptOrder'], path)
  if (object.kind !== 'loom_block') loomPolicyError(`${path}.kind`, 'unsupported source kind')
  const blockId = loomPolicyString(object.blockId, `${path}.blockId`, blockIdMaxBytes)
  if (blockIdMaxCharacters !== undefined && [...blockId].length > blockIdMaxCharacters) {
    loomPolicyError(`${path}.blockId`, `must be at most ${blockIdMaxCharacters} characters`)
  }
  return {
    kind: 'loom_block',
    blockId,
    presetRevision: loomPolicyRevision(object.presetRevision, `${path}.presetRevision`),
    blockRevision: loomPolicyRevision(object.blockRevision, `${path}.blockRevision`),
    promptOrder: loomPolicyRevision(object.promptOrder, `${path}.promptOrder`),
  }
}
function parseLoomResponsePolicyPhaseInstructionV1(
  value: unknown,
  path: string,
): LoomResponsePolicyPhaseInstructionV1 {
  const object = loomPolicyRecord(value, path)
  loomPolicyExactKeys(object, ['phaseId', 'source'], path)
  const phaseId = loomPolicyString(object.phaseId, `${path}.phaseId`, 64)
  if (!POLICY_ID_PATTERN.test(phaseId)) loomPolicyError(`${path}.phaseId`, 'must use a stable lowercase identifier')
  return {
    phaseId,
    source: parseLoomPolicySourceV1(object.source, `${path}.source`),
  }
}

export function parseLoomResponsePolicyOmissionV1(value: unknown): LoomResponsePolicyOmissionV1 {
  const object = loomPolicyRecord(value, 'responseOmission')
  loomPolicyExactKeys(object, [
    'version',
    'surface',
    'visibility',
    'reason',
    'omittedEntryIds',
    'source',
    'omittedPhaseInstructions',
  ], 'responseOmission')
  if (object.version !== 1) loomPolicyError('responseOmission.version', 'unsupported Loom policy version')
  if (object.surface !== 'RESPONSE') loomPolicyError('responseOmission.surface', 'must be RESPONSE')
  if (object.visibility !== 'work_only') loomPolicyError('responseOmission.visibility', 'must be work_only')
  if (object.reason !== 'work_only') loomPolicyError('responseOmission.reason', 'must be work_only')
  if (!isIndexedArray(object.omittedEntryIds) || object.omittedEntryIds.length > 128) {
    loomPolicyError('responseOmission.omittedEntryIds', 'must contain at most 128 entries')
  }
  const omittedEntryIds = object.omittedEntryIds.map((entryId, index) => (
    loomPolicyString(entryId, `responseOmission.omittedEntryIds[${index}]`, 256)
  ))
  if (new Set(omittedEntryIds).size !== omittedEntryIds.length) {
    loomPolicyError('responseOmission.omittedEntryIds', 'contains duplicate entry ids')
  }
  if (!isIndexedArray(object.source) || object.source.length > 128) {
    loomPolicyError('responseOmission.source', 'must contain at most 128 sources')
  }
  const source = object.source.map((value, index) => (
    parseLoomPolicySourceV1(value, `responseOmission.source[${index}]`)
  ))
  if (source.length !== omittedEntryIds.length) {
    loomPolicyError('responseOmission', 'omittedEntryIds and source must preserve one-to-one order')
  }
  if (!isIndexedArray(object.omittedPhaseInstructions)
    || object.omittedPhaseInstructions.length > LOOM_RESPONSE_OMISSION_MAX_PHASE_INSTRUCTIONS) {
    loomPolicyError(
      'responseOmission.omittedPhaseInstructions',
      `must contain at most ${LOOM_RESPONSE_OMISSION_MAX_PHASE_INSTRUCTIONS} entries`,
    )
  }
  const omittedPhaseInstructions = object.omittedPhaseInstructions.map((instruction, index) => (
    parseLoomResponsePolicyPhaseInstructionV1(
      instruction,
      `responseOmission.omittedPhaseInstructions[${index}]`,
    )
  ))
  return Object.freeze({
    version: 1,
    surface: 'RESPONSE',
    visibility: 'work_only',
    reason: 'work_only',
    omittedEntryIds: Object.freeze(omittedEntryIds),
    source: Object.freeze(source),
    omittedPhaseInstructions: Object.freeze(omittedPhaseInstructions),
  })
}

function parseLoomPolicyEntryV1(
  value: unknown,
  path: string,
  bucket: LoomPolicyBucketV1,
  predicateBudget: CognitionPredicateBudget,
): LoomPolicyEntryV1 {
  const object = loomPolicyRecord(value, path)
  loomPolicyExactKeys(object, [
    'version',
    'id',
    'source',
    'destination',
    'checkpoint',
    'required',
    'visibility',
    'condition',
  ], path)
  if (object.version !== 1) loomPolicyError(`${path}.version`, 'unsupported Loom policy version')
  const destination = object.destination
  if (destination !== LOOM_POLICY_DESTINATION_BY_BUCKET[bucket]) {
    loomPolicyError(`${path}.destination`, 'destination is not valid for its bucket')
  }
  if (typeof object.checkpoint !== 'string' || !Object.hasOwn(LOOM_POLICY_CHECKPOINT_RANK, object.checkpoint)) {
    loomPolicyError(`${path}.checkpoint`, 'unsupported checkpoint')
  }
  if (object.checkpoint !== LOOM_POLICY_CHECKPOINT_BY_BUCKET[bucket]) {
    loomPolicyError(`${path}.checkpoint`, 'checkpoint is not valid for its bucket')
  }
  if (object.visibility !== 'work_only') loomPolicyError(`${path}.visibility`, 'unsupported policy visibility')
  const condition = object.condition === undefined
    ? undefined
    : parseCognitionPredicate(object.condition, `${path}.condition`, predicateBudget)
  return {
    version: 1,
    id: loomPolicyString(object.id, `${path}.id`, 256),
    source: parseLoomPolicySourceV1(object.source, `${path}.source`),
    destination: destination as LoomPolicyDestinationV1,
    checkpoint: object.checkpoint as LoomPolicyCheckpointV1,
    required: loomPolicyBoolean(object.required, `${path}.required`),
    visibility: 'work_only',
    ...(condition === undefined ? {} : { condition }),
  }
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = UTF8_ENCODER.encode(left)
  const rightBytes = UTF8_ENCODER.encode(right)
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength)
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! < rightBytes[index]! ? -1 : 1
  }
  return leftBytes.byteLength === rightBytes.byteLength
    ? 0
    : leftBytes.byteLength < rightBytes.byteLength ? -1 : 1
}

function sortLoomPolicyEntriesV1(entries: readonly LoomPolicyEntryV1[]): LoomPolicyEntryV1[] {
  return [...entries].sort((left, right) =>
    left.source.promptOrder - right.source.promptOrder
    || compareUtf8(left.source.blockId, right.source.blockId)
    || compareUtf8(left.id, right.id))
}
function sortLoomPolicySourcesV1(sources: readonly LoomPolicySourceV1[]): LoomPolicySourceV1[] {
  return [...sources].sort((left, right) =>
    left.promptOrder - right.promptOrder
    || compareUtf8(left.blockId, right.blockId)
    || left.presetRevision - right.presetRevision
    || left.blockRevision - right.blockRevision)
}


function parseLoomPolicyBucketsWithBudget(
  value: unknown,
  predicateBudget: CognitionPredicateBudget,
): LoomPolicyBucketsV1 {
  const object = loomPolicyRecord(value, 'policies')
  loomPolicyExactKeys(object, ['version', ...LOOM_POLICY_BUCKET_ORDER], 'policies')
  if (object.version !== 1) loomPolicyError('policies.version', 'unsupported Loom policy version')
  const entriesByBucket = Object.fromEntries(LOOM_POLICY_BUCKET_ORDER.map((bucket) => {
    const raw = object[bucket]
    if (!isIndexedArray(raw)) loomPolicyError(`policies.${bucket}`, 'must be a dense array')
    if (raw.length > AGENTIC_LOOM_POLICY_BUCKET_LIMIT) {
      loomPolicyError(`policies.${bucket}`, 'contains too many policy entries')
    }
    return [bucket, sortLoomPolicyEntriesV1(raw.map((entry, index) => (
      parseLoomPolicyEntryV1(entry, `policies.${bucket}[${index}]`, bucket, predicateBudget)
    )))]
  })) as Record<LoomPolicyBucketV1, LoomPolicyEntryV1[]>
  const ids = new Set<string>()
  for (const bucket of LOOM_POLICY_BUCKET_ORDER) {
    for (const entry of entriesByBucket[bucket]) {
      if (ids.has(entry.id)) loomPolicyError(`policies.${bucket}`, 'duplicate policy id')
      ids.add(entry.id)
    }
  }
  if (ids.size > AGENTIC_LOOM_POLICY_LIMIT) loomPolicyError('policies', 'contains too many policy entries')
  return Object.freeze({
    version: 1,
    workPolicy: Object.freeze(entriesByBucket.workPolicy),
    workspaceUsage: Object.freeze(entriesByBucket.workspaceUsage),
    completionCriteria: Object.freeze(entriesByBucket.completionCriteria),
    renderPolicy: Object.freeze(entriesByBucket.renderPolicy),
  })
}

export function parseLoomPolicyBucketsV1(value: unknown): LoomPolicyBucketsV1 {
  return parseLoomPolicyBucketsWithBudget(value, createCognitionPredicateBudget())
}

function parseAgentCustomPhaseV1(value: unknown, path: string): AgentCustomPhaseV1 {
  const object = loomPolicyRecord(value, path)
  loomPolicyExactKeys(object, [
    'version',
    'id',
    'label',
    'instructionRefs',
    'childInstructionSubsets',
    'required',
    'enter',
    'exit',
    'skip',
    'capabilityRequests',
    'repeatLimit',
    'nextPhaseIds',
  ], path)
  if (object.version !== 1) loomPolicyError(`${path}.version`, 'unsupported custom phase version')
  const id = loomPolicyString(object.id, `${path}.id`, 64)
  if (!POLICY_ID_PATTERN.test(id)) loomPolicyError(`${path}.id`, 'must use a stable lowercase identifier')
  const label = loomPolicyLabel(object.label, `${path}.label`)
  if (!isIndexedArray(object.instructionRefs) || object.instructionRefs.length > 64) {
    loomPolicyError(`${path}.instructionRefs`, 'must contain at most 64 exact Loom block references')
  }
  const parsedInstructionRefs = object.instructionRefs.map((ref, index) => (
    parseLoomPolicySourceV1(
      ref,
      `${path}.instructionRefs[${index}]`,
      AGENTIC_PREDICATE_MAX_STRING_BYTES,
      AGENTIC_CUSTOM_PHASE_INSTRUCTION_BLOCK_ID_MAX_LENGTH,
    )
  ))
  const sourceKeys = new Set<string>()
  parsedInstructionRefs.forEach((source, index) => {
    const key = loomSourceOccurrenceKey(source)
    if (sourceKeys.has(key)) loomPolicyError(`${path}.instructionRefs[${index}]`, 'duplicate instruction reference')
    sourceKeys.add(key)
  })
  const instructionRefs = sortLoomPolicySourcesV1(parsedInstructionRefs)
  const phaseSourceKeys = new Set(instructionRefs.map(loomSourceKey))
  const childInstructionSubsets = Object.hasOwn(object, 'childInstructionSubsets')
    ? (() => {
        if (!isIndexedArray(object.childInstructionSubsets) || object.childInstructionSubsets.length > AGENT_PROFILE_LIMIT) {
          loomPolicyError(
            `${path}.childInstructionSubsets`,
            `must contain at most ${AGENT_PROFILE_LIMIT} authored child profile subsets`,
          )
        }
        const profileIds = new Set<string>()
        let totalInstructionRefs = 0
        const subsets = object.childInstructionSubsets.map((value, subsetIndex) => {
          const subsetPath = `${path}.childInstructionSubsets[${subsetIndex}]`
          const subset = loomPolicyRecord(value, subsetPath)
          loomPolicyExactKeys(subset, ['profileId', 'instructionRefs'], subsetPath)
          const profileId = loomPolicyString(subset.profileId, `${subsetPath}.profileId`, 64)
          if (!PROFILE_ID_PATTERN.test(profileId)) {
            loomPolicyError(`${subsetPath}.profileId`, 'must use a stable lowercase profile identifier')
          }
          if (profileIds.has(profileId)) {
            loomPolicyError(`${subsetPath}.profileId`, 'duplicate child profile subset')
          }
          profileIds.add(profileId)
          if (!isIndexedArray(subset.instructionRefs) || subset.instructionRefs.length > 64) {
            loomPolicyError(
              `${subsetPath}.instructionRefs`,
              'must contain at most 64 exact Loom block references',
            )
          }
          totalInstructionRefs += subset.instructionRefs.length
          if (totalInstructionRefs > 64) {
            loomPolicyError(
              `${path}.childInstructionSubsets`,
              'contains too many aggregate exact Loom block references',
            )
          }
          const subsetSourceKeys = new Set<string>()
          const parsedInstructionRefs = subset.instructionRefs.map((ref, refIndex) => {
            const source = parseLoomPolicySourceV1(
              ref,
              `${subsetPath}.instructionRefs[${refIndex}]`,
              AGENTIC_PREDICATE_MAX_STRING_BYTES,
              AGENTIC_CUSTOM_PHASE_INSTRUCTION_BLOCK_ID_MAX_LENGTH,
            )
            const sourceKey = loomSourceKey(source)
            if (subsetSourceKeys.has(sourceKey)) {
              loomPolicyError(
                `${subsetPath}.instructionRefs[${refIndex}]`,
                'duplicate child instruction reference',
              )
            }
            subsetSourceKeys.add(sourceKey)
            if (!phaseSourceKeys.has(sourceKey)) {
              loomPolicyError(
                `${subsetPath}.instructionRefs[${refIndex}]`,
                'must exactly match an instruction reference in this phase',
              )
            }
            return source
          })
          const instructionRefs = sortLoomPolicySourcesV1(parsedInstructionRefs)
          return {
            profileId,
            instructionRefs,
          }
        })
        return Object.freeze(subsets.map((subset) => Object.freeze({
          profileId: subset.profileId,
          instructionRefs: Object.freeze(subset.instructionRefs),
        })))
      })()
    : Object.freeze([])
  const required = loomPolicyBoolean(object.required, `${path}.required`)
  const enter = parseCognitionPredicate(object.enter, `${path}.enter`)
  const exit = parseCognitionPredicate(object.exit, `${path}.exit`)
  const skipValue = object.skip
  const skip = skipValue === undefined
    ? undefined
    : parseCognitionPredicate(skipValue, `${path}.skip`)
  if (!isIndexedArray(object.capabilityRequests) || object.capabilityRequests.length > AGENT_CUSTOM_PHASE_CAPABILITIES.length) {
    loomPolicyError(`${path}.capabilityRequests`, 'must contain only closed capability requests')
  }
  const capabilityRequests = object.capabilityRequests.map((capability, index) => {
    if (typeof capability !== 'string'
      || !AGENT_CUSTOM_PHASE_CAPABILITIES.includes(capability as AgentCustomPhaseCapability)) {
      return loomPolicyError(`${path}.capabilityRequests[${index}]`, 'unsupported capability request')
    }
    return capability as AgentCustomPhaseV1['capabilityRequests'][number]
  })
  if (new Set(capabilityRequests).size !== capabilityRequests.length) {
    loomPolicyError(`${path}.capabilityRequests`, 'duplicate capability request')
  }
  if (typeof object.repeatLimit !== 'number'
    || !Number.isSafeInteger(object.repeatLimit)
    || object.repeatLimit < 0
    || object.repeatLimit > 4) {
    loomPolicyError(`${path}.repeatLimit`, 'must be an integer from 0 through 4')
  }
  if (!isIndexedArray(object.nextPhaseIds) || object.nextPhaseIds.length > 2) {
    loomPolicyError(`${path}.nextPhaseIds`, 'must contain at most self and the immediate next phase')
  }
  const nextPhaseIds = object.nextPhaseIds.map((phaseId, index) => {
    const idValue = loomPolicyString(phaseId, `${path}.nextPhaseIds[${index}]`, 64)
    if (!POLICY_ID_PATTERN.test(idValue)) loomPolicyError(`${path}.nextPhaseIds[${index}]`, 'must use a stable lowercase identifier')
    return idValue
  })
  if (new Set(nextPhaseIds).size !== nextPhaseIds.length) {
    loomPolicyError(`${path}.nextPhaseIds`, 'duplicate next phase id')
  }
  if (nextPhaseIds.includes(id) && object.repeatLimit === 0) {
    loomPolicyError(`${path}.nextPhaseIds`, 'self transition requires repeatLimit greater than zero')
  }
  return {
    version: 1,
    id,
    label,
    instructionRefs,
    childInstructionSubsets,
    required,
    enter,
    exit,
    ...(skip === undefined ? {} : { skip }),
    capabilityRequests,
    repeatLimit: object.repeatLimit,
    nextPhaseIds,
  }
}

export function parseAgentCustomPhasesV1(value: unknown): readonly AgentCustomPhaseV1[] {
  if (!isIndexedArray(value) || value.length > AGENTIC_CUSTOM_PHASE_LIMIT) {
    loomPolicyError('config.runtimePolicy.phases', `must contain at most ${AGENTIC_CUSTOM_PHASE_LIMIT} ordered phases`)
  }
  const phases = value.map((phase, index) => parseAgentCustomPhaseV1(phase, `config.runtimePolicy.phases.${index}`))
  const ids = new Set<string>()
  phases.forEach((phase, index) => {
    if (ids.has(phase.id)) loomPolicyError(`config.runtimePolicy.phases.${index}.id`, 'duplicate custom phase id')
    ids.add(phase.id)
  })
  return Object.freeze(phases)
}
const AGENT_RUNTIME_POLICY_SOURCE_BLOCK_LIMIT = 512

export function parseAgentRuntimePolicyV1(value: unknown): AgentRuntimePolicyV1 {
  const object = loomPolicyRecord(value, 'runtimePolicy')
  const requiredKeys = ['version', 'authority', 'scope', 'defaultMode', 'loomPolicy'] as const
  loomPolicyExactKeys(object, [...requiredKeys, 'phases'], 'runtimePolicy')
  for (const key of requiredKeys) {
    if (!Object.hasOwn(object, key)) loomPolicyError(`runtimePolicy.${key}`, 'is required')
  }
  if (object.version !== 1) loomPolicyError('runtimePolicy.version', 'must be version 1')
  if (object.authority !== 'loom') loomPolicyError('runtimePolicy.authority', 'must be loom')
  if (object.scope !== 'preset') loomPolicyError('runtimePolicy.scope', 'must be preset')
  if (object.defaultMode !== 'response' && object.defaultMode !== 'agentic') {
    loomPolicyError('runtimePolicy.defaultMode', 'must be response or agentic')
  }
  const loomPolicy = object.loomPolicy === null
    ? null
    : parseLoomPolicyBucketsV1(object.loomPolicy)
  const phases = Object.hasOwn(object, 'phases')
    ? parseAgentCustomPhasesV1(object.phases)
    : []
  const phaseIds = new Set(phases.map((phase) => phase.id))
  phases.forEach((phase, index) => {
    const immediateNextId = phases[index + 1]?.id
    for (const nextPhaseId of phase.nextPhaseIds) {
      if (!phaseIds.has(nextPhaseId)
        || (nextPhaseId !== phase.id && nextPhaseId !== immediateNextId)) {
        loomPolicyError(
          `runtimePolicy.phases.${index}.nextPhaseIds`,
          'transitions may target only the next phase or itself',
        )
      }
    }
  })
  const sourceBlockOccurrences = new Set<string>()
  for (const bucket of LOOM_POLICY_BUCKET_ORDER) {
    for (const entry of loomPolicy?.[bucket] ?? []) sourceBlockOccurrences.add(loomSourceOccurrenceKey(entry.source))
  }
  for (const phase of phases) {
    for (const source of phase.instructionRefs) sourceBlockOccurrences.add(loomSourceOccurrenceKey(source))
  }
  if (sourceBlockOccurrences.size > AGENT_RUNTIME_POLICY_SOURCE_BLOCK_LIMIT) {
    loomPolicyError(
      'runtimePolicy',
      `source block references must contain at most ${AGENT_RUNTIME_POLICY_SOURCE_BLOCK_LIMIT} distinct block occurrences`,
    )
  }
  return Object.freeze({
    version: 1,
    authority: 'loom',
    scope: 'preset',
    defaultMode: object.defaultMode,
    loomPolicy,
    phases,
  })
}


function refsToLoomPolicyBuckets(
  refs: AgentCognitionPolicy,
  blocks: readonly PromptBlock[],
): LoomPolicyBucketsV1 {
  const sourcesById = new Map<string, LoomPolicySourceV1[]>()
  blocks.forEach((block, index) => {
    const source = {
      kind: 'loom_block' as const,
      blockId: block.id,
      presetRevision: 0,
      blockRevision: promptBlockRevision(block, `blocks[${index}].revision`),
      promptOrder: index,
    }
    const matches = sourcesById.get(block.id) ?? []
    matches.push(source)
    sourcesById.set(block.id, matches)
  })
  const convert = (bucket: LoomPolicyBucketV1): LoomPolicyEntryV1[] => {
    const refsForBucket = refs[bucket] ?? []
    return sortLoomPolicyEntriesV1(refsForBucket.map((ref, index) => {
      const matches = sourcesById.get(ref.blockId) ?? []
      if (matches.length === 0) loomPolicyError(`${bucket}[${index}].blockId`, 'source block is unavailable')
      if (matches.length > 1) loomPolicyError(`${bucket}[${index}].blockId`, 'source block is ambiguous; explicit repair is required')
      const source = matches[0]!
      return {
        version: 1,
        id: `${bucket}-${ref.blockId}`,
        source: {
          ...source,
          presetRevision: ref.expectedPresetRevision,
          blockRevision: ref.expectedBlockRevision,
        },
        destination: LOOM_POLICY_DESTINATION_BY_BUCKET[bucket],
        checkpoint: LOOM_POLICY_CHECKPOINT_BY_BUCKET[bucket],
        required: true,
        visibility: 'work_only',
      }
    }))
  }
  return {
    version: 1,
    workPolicy: convert('workPolicy'),
    workspaceUsage: convert('workspaceUsage'),
    completionCriteria: convert('completionCriteria'),
    renderPolicy: convert('renderPolicy'),
  }
}

export function normalizeLoomPolicyBucketsV1(
  value: unknown,
  sourceBlocks: readonly PromptBlock[],
): LoomPolicyBucketsV1 {
  if (isUnknownRecord(value) && value.version === 1) {
    return parseLoomPolicyBucketsV1(value)
  }
  const normalized = refsToLoomPolicyBuckets(
    (isCognitionPolicyShape(value) ? value : defaultCognitionPolicy()) as AgentCognitionPolicy,
    sourceBlocks,
  )
  return Object.freeze({
    version: 1,
    workPolicy: Object.freeze(normalized.workPolicy),
    workspaceUsage: Object.freeze(normalized.workspaceUsage),
    completionCriteria: Object.freeze(normalized.completionCriteria),
    renderPolicy: Object.freeze(normalized.renderPolicy),
  })
}

function loomSourcePin(source: LoomPolicySourceV1): string {
  return `${source.presetRevision}\u0000${source.blockRevision}\u0000${source.promptOrder}`
}

function loomDestBlockKey(destination: LoomPolicyDestinationV1, source: LoomPolicySourceV1): string {
  return `${destination}\u0000${source.blockId}\u0000${source.promptOrder}`
}

function conflictingDestBlockEntryIds(policies: LoomPolicyBucketsV1): ReadonlySet<string> {
  const groups = new Map<string, { pin: string; ids: string[]; conflicted: boolean }>()
  const conflicting = new Set<string>()
  for (const bucket of LOOM_POLICY_BUCKET_ORDER) {
    for (const entry of policies[bucket]) {
      const key = loomDestBlockKey(entry.destination, entry.source)
      const pin = loomSourcePin(entry.source)
      const group = groups.get(key)
      if (!group) {
        groups.set(key, { pin, ids: [entry.id], conflicted: false })
        continue
      }
      group.ids.push(entry.id)
      if (group.pin !== pin) group.conflicted = true
      if (group.conflicted) {
        for (const id of group.ids) conflicting.add(id)
      }
    }
  }
  return conflicting
}

function loomSourceOccurrenceKey(source: LoomPolicySourceV1): string {
  return `${source.kind}\u0000${source.blockId}\u0000${source.promptOrder}`
}

function loomSourceKey(source: LoomPolicySourceV1): string {
  return `${source.kind}\u0000${source.blockId}\u0000${source.presetRevision}\u0000${source.blockRevision}\u0000${source.promptOrder}`
}


function loomScalarEqual(left: unknown, right: unknown): boolean {
  return isCognitionScalar(left)
    && isCognitionScalar(right)
    && typeof left === typeof right
    && left === right
}

function loomValuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => loomScalarEqual(item, right[index]))
  }
  if (Array.isArray(left) || Array.isArray(right)) return false
  return loomScalarEqual(left, right)
}

function evaluateLoomPredicate(predicate: CognitionPredicate, evaluation: NonNullable<LoomPromptInspectionInputV1['evaluation']>): boolean {
  switch (predicate.kind) {
    case 'all':
      return predicate.children.every((child) => evaluateLoomPredicate(child, evaluation))
    case 'any':
      return predicate.children.some((child) => evaluateLoomPredicate(child, evaluation))
    case 'not':
      return !evaluateLoomPredicate(predicate.child, evaluation)
    case 'generation_type':
      return predicate.value === evaluation.generationType
    case 'phase':
      return predicate.value === evaluation.phase
    case 'tool_available':
      return evaluation.availableTools.includes(predicate.toolId) === predicate.available
    case 'task_transition':
      return evaluation.taskTransitions[predicate.taskId] === predicate.transition
    case 'preset_variable':
    case 'participant_fact': {
      const values = predicate.kind === 'preset_variable' ? evaluation.presetVariables : evaluation.participantFacts
      const current = values[predicate.name]
      if (predicate.operator === 'present') return Object.prototype.hasOwnProperty.call(values, predicate.name)
      if (predicate.operator === 'equals') return loomValuesEqual(current, predicate.value)
      if (predicate.operator === 'in') {
        return Array.isArray(current)
          ? current.some((item) => predicate.values.some((value) => loomScalarEqual(item, value)))
          : predicate.values.some((value) => loomScalarEqual(current, value))
      }
      return Array.isArray(current)
        && current.some((item) => loomScalarEqual(item, predicate.value))
    }
  }
}

function copyAndDeepFreezeLoomInspectionValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => copyAndDeepFreezeLoomInspectionValue(item)))
  }
  if (!isUnknownRecord(value)) return value
  const copy: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    copy[key] = copyAndDeepFreezeLoomInspectionValue(item)
  }
  return Object.freeze(copy)
}

function loomInspectionItem(
  entry: LoomPolicyEntryV1,
  bucket: LoomPolicyBucketV1,
  outcome: LoomPromptInspectionOutcomeV1,
  effectiveText: string | null,
  conditionResult: LoomPromptInspectionItemV1['conditionResult'] = 'not_applicable',
): LoomPromptInspectionItemV1 {
  return copyAndDeepFreezeLoomInspectionValue({
    entryId: entry.id,
    bucket,
    destination: entry.destination,
    checkpoint: entry.checkpoint,
    source: entry.source,
    ...(entry.condition === undefined ? {} : { condition: entry.condition }),
    conditionResult,
    effectiveText,
    required: entry.required,
    ordinaryPromptSuppressed: true,
    outcome,
  }) as LoomPromptInspectionItemV1
}

export function inspectLoomPromptPoliciesV1(
  policiesValue: unknown,
  input: LoomPromptInspectionInputV1,
): LoomPromptInspectionV1 {
  const policies = parseLoomPolicyBucketsV1(policiesValue)
  const sourceBlocks = new Map<string, LoomPromptInspectionBlockV1>()
  for (const block of input.blocks) sourceBlocks.set(loomSourceKey(block.source), block)
  const items: LoomPromptInspectionItemV1[] = []
  const effectiveEntryIds: string[] = []
  const kept = new Map<string, string>()
  const conflictingIds = conflictingDestBlockEntryIds(policies)
  for (const bucket of LOOM_POLICY_BUCKET_ORDER) {
    for (const entry of policies[bucket]) {
      if (input.surface === 'RESPONSE') {
        items.push(loomInspectionItem(entry, bucket, { status: 'omitted', reason: 'response_mode' }, null, entry.condition === undefined ? 'not_applicable' : 'not_evaluated'))
        continue
      }
      if (conflictingIds.has(entry.id)) {
        items.push(loomInspectionItem(entry, bucket, { status: 'rejected', reason: 'invalid_source' }, null, entry.condition === undefined ? 'not_applicable' : 'not_evaluated'))
        continue
      }
      if (LOOM_POLICY_CHECKPOINT_RANK[input.checkpoint] < LOOM_POLICY_CHECKPOINT_RANK[entry.checkpoint]) {
        items.push(loomInspectionItem(entry, bucket, { status: 'skipped', reason: 'checkpoint_not_reached' }, null, entry.condition === undefined ? 'not_applicable' : 'not_evaluated'))
        continue
      }
      const block = sourceBlocks.get(loomSourceKey(entry.source))
      if (!block) {
        items.push(loomInspectionItem(entry, bucket, entry.required
          ? { status: 'rejected', reason: 'required_source_unavailable' }
          : { status: 'skipped', reason: 'stale_source' }, null, entry.condition === undefined ? 'not_applicable' : 'not_evaluated'))
        continue
      }
      const effectiveText = block.content
      if (entry.condition !== undefined) {
        if (!input.evaluation) {
          items.push(loomInspectionItem(entry, bucket, entry.required
            ? { status: 'rejected', reason: 'required_source_unavailable' }
            : { status: 'skipped', reason: 'condition_not_met' }, effectiveText, 'not_evaluated'))
          continue
        }
        if (!evaluateLoomPredicate(entry.condition, input.evaluation)) {
          items.push(loomInspectionItem(entry, bucket, { status: 'skipped', reason: 'condition_not_met' }, effectiveText, 'false'))
          continue
        }
      }
      const dedupKey = loomDestBlockKey(entry.destination, entry.source)
      const keptEntryId = kept.get(dedupKey)
      if (keptEntryId) {
        items.push(loomInspectionItem(entry, bucket, {
          status: 'deduplicated',
          reason: 'destination_overlap',
          keptEntryId,
          destination: entry.destination,
        }, effectiveText, entry.condition === undefined ? 'not_applicable' : 'true'))
        continue
      }
      kept.set(dedupKey, entry.id)
      effectiveEntryIds.push(entry.id)
      items.push(loomInspectionItem(entry, bucket, {
        status: 'included',
        effectiveIndex: effectiveEntryIds.length - 1,
        reason: 'selected',
      }, effectiveText, entry.condition === undefined ? 'not_applicable' : 'true'))
    }
  }
  const responseOmission: LoomResponsePolicyOmissionV1 | undefined = input.surface === 'RESPONSE'
    ? parseLoomResponsePolicyOmissionV1({
      version: 1,
      surface: 'RESPONSE',
      visibility: 'work_only',
      reason: 'work_only',
      omittedEntryIds: items.map((item) => item.entryId),
      source: items.map((item) => item.source),
      omittedPhaseInstructions: [],
    })
    : undefined
  return Object.freeze({
    version: 1,
    surface: input.surface,
    checkpoint: input.checkpoint,
    items: Object.freeze(items),
    effectiveEntryIds: Object.freeze(effectiveEntryIds),
    ...(responseOmission === undefined ? {} : { responseOmission }),
  })
}

export const inspectLoomPrompt = inspectLoomPromptPoliciesV1

export function getAgentProfileMarkerIds(value: unknown): string[] {
  if (typeof value !== 'string') return []
  const ids: string[] = []
  AGENT_MARKER_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = AGENT_MARKER_PATTERN.exec(value)) !== null) ids.push(match[1]!)
  AGENT_MARKER_PATTERN.lastIndex = 0
  return ids
}

export function rewriteAgentProfileMarkers(value: unknown, previousId: string, nextId: string): unknown {
  if (typeof value !== 'string' || previousId === nextId) return value
  const previousResultName = getAgentResultName(previousId)
  const nextResultName = getAgentResultName(nextId)
  AGENT_MARKER_PATTERN.lastIndex = 0
  const rewritten = value.replace(AGENT_MARKER_PATTERN, (marker, markerId: string) => {
    if (markerId !== previousId) return marker
    return marker.replace(`{{agent::${previousId}`, `{{agent::${nextId}`)
      .replace(`as=${previousResultName}`, `as=${nextResultName}`)
  })
  AGENT_MARKER_PATTERN.lastIndex = 0
  return rewritten
}

/**
 * Remove one profile's generated agent block without leaving a dangling
 * closing marker. Unpaired markers are removed on their own so imported or
 * hand-authored prompt text remains saveable.
 */
export function removeAgentProfileMarkers(value: unknown, profileId: string): unknown {
  if (typeof value !== 'string' || profileId.length === 0) return value
  const escapedId = profileId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const markerSource = `\\{\\{agent::${escapedId}(?:::as=[^{}\\s:]+)?\\}\\}`
  const pairedPattern = new RegExp(`${markerSource}([\\s\\S]*?)\\{\\{/agent\\}\\}`, 'g')
  const markerPattern = new RegExp(markerSource, 'g')
  return value.replace(pairedPattern, '$1').replace(markerPattern, '')
}

export const CORE_AGENT_TOOL_IDS = [
  'lore_list_books',
  'lore_get_book',
  'lore_list_entries',
  'lore_get_entry',
  'lore_search_entries',
  'chat_search_history',
] as const satisfies readonly CoreAgentToolId[]
const AGENT_CAPABILITY_IDS = [
  'generation',
  'streaming',
  'tool_calling',
  'native_tool_continuation',
  'tools_disabled_finalization',
] as const satisfies readonly AgentCapability[]
const AGENT_LORE_SCOPES = ['active', 'all_owned'] as const
const LORE_TOOL_IDS: Record<CoreAgentToolId, boolean> = {
  lore_list_books: true,
  lore_get_book: true,
  lore_list_entries: true,
  lore_get_entry: true,
  lore_search_entries: true,
  chat_search_history: false,
}

export const AGENT_PROFILE_LIMIT = 16
export const AGENT_PROFILE_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
export const AGENT_PROFILE_NAME_MAX_LENGTH = 80
export const AGENT_SYSTEM_PROMPT_MAX_BYTES = 32 * 1024
export const AGENT_MAX_OUTPUT_TOKENS_MIN = 64
export const AGENT_MAX_OUTPUT_TOKENS_MAX = 8192
export const AGENT_TIMEOUT_MS_MIN = 5_000
const MILLISECONDS_PER_SECOND = 1_000
export function agentTimeoutMsToSeconds(timeoutMs: number): number {
  return timeoutMs / MILLISECONDS_PER_SECOND
}
export { AGENT_INVOCATION_MIN, AGENT_TOOL_CALL_MIN }
export const AGENT_MODES = ['response', 'agentic'] as const

export function parseAgentTimeoutSecondsInput(value: string): number {
  if (!/^[+-]?\d+$/.test(value)) return Number.NaN
  const timeoutMs = Number(value) * MILLISECONDS_PER_SECOND
  return Number.isSafeInteger(timeoutMs) ? timeoutMs : Number.NaN
}

export function parseAgentMaxInvocationsInput(value: string): number {
  if (!/^\d+$/.test(value)) return Number.NaN
  const maxInvocations = Number(value)
  return Number.isSafeInteger(maxInvocations) && maxInvocations >= AGENT_INVOCATION_MIN
    ? maxInvocations
    : Number.NaN
}

export function parseAgentMaxToolCallsInput(value: string): number {
  if (!/^\d+$/.test(value)) return Number.NaN
  const maxToolCalls = Number(value)
  return Number.isSafeInteger(maxToolCalls) && maxToolCalls >= AGENT_TOOL_CALL_MIN
    ? maxToolCalls
    : Number.NaN
}

export function getAgentResultName(profileId: string): string {
  const validBase = AGENT_PROFILE_ID_PATTERN.test(profileId) ? profileId : 'agent'
  return `${validBase.slice(0, 57).replace(/_+$/g, '') || 'agent'}_result`
}
export function rewriteTaskTransitionReferences(value: unknown, previousId: string, nextId: string): unknown {
  if (!isUnknownRecord(value) || previousId === nextId) return value
  if (value.kind === 'task_transition') {
    return value.taskId === previousId ? { ...value, taskId: nextId } : value
  }
  if (value.kind === 'all' || value.kind === 'any') {
    return Array.isArray(value.children)
      ? { ...value, children: value.children.map((child) => rewriteTaskTransitionReferences(child, previousId, nextId)) }
      : value
  }
  if (value.kind === 'not') {
    return { ...value, child: rewriteTaskTransitionReferences(value.child, previousId, nextId) }
  }
  return value
}

export function createAgentPromptBlock(
  profile: AgentProfileConfigV2,
  taskText: string,
  blockName: string,
): PromptBlock {
  const options: string[] = []
  if (profile.toolIds.length > 0) options.push(`tools=${profile.toolIds.join(',')}`)
  if (profile.streamActivity) options.push('stream')
  const optionSyntax = options.length > 0 ? `::${options.join('::')}` : ''
  return {
    id: generateUUID(),
    name: blockName,
    content: `{{agent::${profile.id}${optionSyntax}}}\n${taskText}\n{{/agent}}`,
    role: 'user',
    enabled: true,
    position: 'pre_history',
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
  }
}
export type AgenticRuntimeValidationCode =
  | 'invalid_config'
  | 'invalid_modes'
  | 'invalid_default_mode'
  | 'invalid_profile'
  | 'invalid_slot'
  | 'unresolved_slot'
  | 'invalid_block_reference'
  | 'stale_block_revision'
  | 'invalid_runtime_policy'
  | 'invalid_policy_entry'
  | 'stale_policy_source'
  | 'invalid_predicate'
  | 'predicate_limit_exceeded'
  | 'invalid_task_template'
  | 'invalid_task_policy'
  | 'missing_task_dependency'
  | 'cyclic_task_dependency'
  | 'review_acknowledgement_required'
  | 'review_acknowledgement_unknown'

export interface AgenticRuntimeValidationIssue {
  code: AgenticRuntimeValidationCode
  path: string
}

export interface AgenticRuntimeValidationResult {
  valid: boolean
  issues: AgenticRuntimeValidationIssue[]
}
function isStringList(value: unknown): value is string[] {
  return isIndexedArray(value) && value.every((entry) => typeof entry === 'string')
}

function isCognitionScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string'
    || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)
}

interface CognitionPredicateBudget {
  nodes: number
  maxNodes: number
  listBytes: number
  limitExceeded: boolean
}

function createCognitionPredicateBudget(
  maxNodes = AGENTIC_PREDICATE_MAX_NODES,
): CognitionPredicateBudget {
  return { nodes: 0, maxNodes, listBytes: 0, limitExceeded: false }
}

function isCognitionSafeText(
  value: unknown,
  maxBytes = AGENTIC_PREDICATE_MAX_STRING_BYTES,
  budget?: CognitionPredicateBudget,
): value is string {
  if (typeof value !== 'string') return false
  if (UTF8_ENCODER.encode(value).byteLength > maxBytes) {
    if (budget) budget.limitExceeded = true
    return false
  }
  if (value.includes('{{') || value.includes('}}')) return false
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint === 0 || codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) {
      return false
    }
  }
  return true
}

function isCognitionId(value: unknown, budget?: CognitionPredicateBudget): value is string {
  if (!isCognitionSafeText(value, AGENTIC_PREDICATE_MAX_ID_BYTES, budget) || value.length === 0) return false
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x20 || codePoint === 0x7f) return false
  }
  return true
}

function cognitionScalarKey(value: string | number | boolean): string {
  return `${typeof value}:${String(value)}`
}

function accountCognitionListString(value: string, budget: CognitionPredicateBudget): boolean {
  budget.listBytes += UTF8_ENCODER.encode(value).byteLength
  if (budget.listBytes > AGENTIC_PREDICATE_MAX_LIST_BYTES) {
    budget.limitExceeded = true
    return false
  }
  return true
}

function isCognitionSafeScalar(
  value: unknown,
  budget?: CognitionPredicateBudget,
  accountListBytes = true,
): value is string | number | boolean {
  if (!isCognitionScalar(value)) return false
  if (typeof value !== 'string') return true
  return isCognitionSafeText(value, AGENTIC_PREDICATE_MAX_STRING_BYTES, budget)
    && (!accountListBytes || budget === undefined || accountCognitionListString(value, budget))
}

function isCognitionStringList(value: unknown, budget?: CognitionPredicateBudget): value is string[] {
  if (!isIndexedArray(value)) return false
  if (value.length > AGENTIC_PREDICATE_MAX_LIST_ITEMS) {
    if (budget) budget.limitExceeded = true
    return false
  }
  for (const entry of value) {
    if (!isCognitionSafeText(entry, AGENTIC_PREDICATE_MAX_STRING_BYTES, budget)
      || budget !== undefined && !accountCognitionListString(entry, budget)) return false
  }
  return true
}

function isCognitionScalarList(
  value: unknown,
  budget?: CognitionPredicateBudget,
): value is Array<string | number | boolean> {
  if (!isIndexedArray(value)) return false
  if (value.length > AGENTIC_PREDICATE_MAX_LIST_ITEMS || value.length === 0) {
    if (budget && value.length > AGENTIC_PREDICATE_MAX_LIST_ITEMS) budget.limitExceeded = true
    return false
  }
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isCognitionSafeScalar(entry, budget)) return false
    const key = cognitionScalarKey(entry)
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}


function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}


function isCognitionPredicateShape(
  value: unknown,
  depth = 1,
  budget = createCognitionPredicateBudget(),
): value is CognitionPredicate {
  if (!isUnknownRecord(value)) return false
  if (depth > AGENTIC_PREDICATE_MAX_DEPTH) {
    budget.limitExceeded = true
    return false
  }
  budget.nodes += 1
  if (budget.nodes > budget.maxNodes) {
    budget.limitExceeded = true
    return false
  }
  switch (value.kind) {
    case 'all':
    case 'any': {
      if (!hasOnlyKeys(value, ['kind', 'children']) || !isIndexedArray(value.children)) return false
      if (value.children.length > AGENTIC_PREDICATE_MAX_LIST_ITEMS) {
        budget.limitExceeded = true
        return false
      }
      return value.children.every((child) => isCognitionPredicateShape(child, depth + 1, budget))
    }
    case 'not':
      return hasOnlyKeys(value, ['kind', 'child'])
        && isCognitionPredicateShape(value.child, depth + 1, budget)
    case 'generation_type':
      return hasOnlyKeys(value, ['kind', 'value'])
        && (value.value === 'normal'
          || value.value === 'continue'
          || value.value === 'regenerate'
          || value.value === 'swipe')
    case 'phase':
      return hasOnlyKeys(value, ['kind', 'value'])
        && typeof value.value === 'string'
        && ['ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT', 'COMMITTING', 'COMMITTED',
          'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(value.value)
    case 'preset_variable':
    case 'participant_fact':
      if (!isCognitionId(value.name, budget)) return false
      if (value.operator === 'present') return hasOnlyKeys(value, ['kind', 'name', 'operator'])
      if (value.operator === 'in') {
        return hasOnlyKeys(value, ['kind', 'name', 'operator', 'values'])
          && isCognitionScalarList(value.values, budget)
      }
      if (value.operator === 'equals') {
        return hasOnlyKeys(value, ['kind', 'name', 'operator', 'value'])
          && (isCognitionSafeScalar(value.value, budget, false)
            || isCognitionStringList(value.value, budget))
      }
      if (value.operator === 'includes') {
        return hasOnlyKeys(value, ['kind', 'name', 'operator', 'value'])
          && isCognitionSafeScalar(value.value, budget)
      }
      return false
    case 'tool_available':
      return hasOnlyKeys(value, ['kind', 'toolId', 'available'])
        && isCognitionId(value.toolId, budget)
        && typeof value.available === 'boolean'
    case 'task_transition':
      return hasOnlyKeys(value, ['kind', 'taskId', 'transition'])
        && isCognitionId(value.taskId, budget)
        && ['pending', 'active', 'blocked', 'completed', 'cancelled', 'failed'].includes(String(value.transition))
    default:
      return false
  }
}
function parseCognitionPredicate(
  value: unknown,
  path: string,
  budget = createCognitionPredicateBudget(),
): CognitionPredicate {
  if (isCognitionPredicateShape(value, 1, budget)) return value
  if (budget.limitExceeded) return cognitionPredicateLimitError(path)
  return loomPolicyError(path, 'invalid predicate')
}

function cognitionPredicateBudgetExceeded(value: unknown): boolean {
  const budget = createCognitionPredicateBudget()
  isCognitionPredicateShape(value, 1, budget)
  return budget.limitExceeded
}

export function isAgentTaskTemplate(value: unknown, enforcePredicateBudget = true): value is AgentTaskTemplate {
  if (!isUnknownRecord(value)
    || !hasOnlyKeys(value, ['id', 'required', 'dependencies', 'activation', 'label', 'description'])
    || !isCognitionId(value.id)
    || typeof value.required !== 'boolean'
    || value.dependencies !== undefined && (
      !isIndexedArray(value.dependencies)
      || value.dependencies.length > AGENTIC_PREDICATE_MAX_LIST_ITEMS
      || value.dependencies.some((dependency) => !isCognitionId(dependency))
    )
    || value.activation !== undefined && !isCognitionPredicateShape(
      value.activation,
      1,
      enforcePredicateBudget
        ? createCognitionPredicateBudget()
        : createCognitionPredicateBudget(AGENTIC_PREDICATE_DRAFT_SCAN_MAX_NODES),
    )
    || value.label !== undefined && (
      typeof value.label !== 'string'
      || !isCognitionSafeText(value.label)
    )
    || value.description !== undefined && (
      typeof value.description !== 'string'
      || !isCognitionSafeText(value.description)
    )) {
    return false
  }
  return true
}


function defaultCognitionPolicy() {
  return {
    workPolicy: [],
    workspaceUsage: [],
    completionCriteria: [],
    renderPolicy: [],
  }
}

export function createLoomPolicyEntryV1(
  bucket: LoomPolicyBucketV1,
  block: PromptBlock,
  presetRevision: number,
  promptOrder: number,
  existing?: LoomPolicyEntryV1,
): LoomPolicyEntryV1 {
  const blockRevision = promptBlockRevision(block, `block.${block.id}.revision`)
  return {
    version: 1,
    id: existing?.id ?? `${bucket}-${block.id}-${promptOrder}`,
    source: {
      kind: 'loom_block',
      blockId: block.id,
      presetRevision,
      blockRevision,
      promptOrder,
    },
    destination: LOOM_POLICY_DESTINATION_BY_BUCKET[bucket],
    checkpoint: LOOM_POLICY_CHECKPOINT_BY_BUCKET[bucket],
    required: existing?.required ?? true,
    visibility: 'work_only',
    ...(existing?.condition === undefined ? {} : { condition: existing.condition }),
  }
}

export function getAgentRuntimePolicyBuckets(
  config: AgentConfigV2 | unknown,
  sourceBlocks: readonly PromptBlock[],
): LoomPolicyBucketsV1 {
  const rawConfig = isUnknownRecord(config) ? config : {}
  if (Object.hasOwn(rawConfig, 'runtimePolicy')) {
    const rawRuntimePolicy = rawConfig.runtimePolicy
    if (isUnknownRecord(rawRuntimePolicy)
      && rawRuntimePolicy.loomPolicy !== null
      && rawRuntimePolicy.loomPolicy !== undefined) {
      try {
        return normalizeLoomPolicyBucketsV1(rawRuntimePolicy.loomPolicy, sourceBlocks)
      } catch {
        // Validation retains the malformed canonical value for explicit repair.
      }
    }
    return {
      version: 1,
      workPolicy: [],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }
  }
  try {
    return normalizeLoomPolicyBucketsV1(rawConfig.cognitionPolicy, sourceBlocks)
  } catch {
    return {
      version: 1,
      workPolicy: [],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    }
  }
}

export function getAgentRuntimeCustomPhases(
  config: AgentConfigV2 | unknown,
): readonly AgentCustomPhaseV1[] {
  const rawConfig = isUnknownRecord(config) ? config : {}
  const rawRuntimePolicy = rawConfig.runtimePolicy
  if (!isUnknownRecord(rawRuntimePolicy) || !Array.isArray(rawRuntimePolicy.phases)) return []
  try {
    return parseAgentCustomPhasesV1(rawRuntimePolicy.phases)
  } catch {
    return []
  }
}

function normalizeCustomPhaseRowsForCanonicalSave(
  phases: readonly AgentCustomPhaseV1[],
): AgentCustomPhaseV1[] {
  return phases.map((phase) => {
    const rawPhase = phase as unknown as Record<string, unknown>
    return Object.hasOwn(rawPhase, 'childInstructionSubsets')
      ? phase
      : { ...phase, childInstructionSubsets: [] }
  })
}

export function setAgentRuntimeCustomPhases(
  config: AgentConfigV2,
  phases: readonly AgentCustomPhaseV1[],
): AgentConfigV2 {
  const rawConfig = config as unknown as Record<string, unknown>
  const rawRuntimePolicy = rawConfig.runtimePolicy
  const loomPolicy = isUnknownRecord(rawRuntimePolicy)
    && (rawRuntimePolicy.loomPolicy === null || isUnknownRecord(rawRuntimePolicy.loomPolicy))
    ? rawRuntimePolicy.loomPolicy as LoomPolicyBucketsV1 | null
    : null
  const {
    cognitionPolicy: _legacyCognitionPolicy,
    ...withoutLegacyPolicy
  } = rawConfig
  const runtimePolicy: AgentRuntimePolicyV1 = {
    version: 1,
    authority: 'loom',
    scope: 'preset',
    defaultMode: config.defaultMode,
    loomPolicy,
    phases: normalizeCustomPhaseRowsForCanonicalSave(phases),
  }
  return {
    ...withoutLegacyPolicy,
    runtimePolicy,
  } as AgentConfigV2
}

export function setAgentRuntimePolicyBuckets(
  config: AgentConfigV2,
  buckets: LoomPolicyBucketsV1,
): AgentConfigV2 {
  const rawConfig = config as unknown as Record<string, unknown>
  const rawRuntimePolicy = rawConfig.runtimePolicy
  const phases = isUnknownRecord(rawRuntimePolicy) && Array.isArray(rawRuntimePolicy.phases)
    ? normalizeCustomPhaseRowsForCanonicalSave(rawRuntimePolicy.phases as readonly AgentCustomPhaseV1[])
    : []
  const {
    cognitionPolicy: _legacyCognitionPolicy,
    ...withoutLegacyPolicy
  } = rawConfig
  const runtimePolicy: AgentRuntimePolicyV1 = {
    version: 1,
    authority: 'loom',
    scope: 'preset',
    defaultMode: config.defaultMode,
    loomPolicy: buckets,
    phases,
  }
  return {
    ...withoutLegacyPolicy,
    runtimePolicy,
  } as AgentConfigV2
}





export function createDefaultAgentConfigV2(): AgentConfigV2 {
  return {
    version: 2,
    agentsEnabled: false,
    allowedModes: ['response'],
    defaultMode: 'response',
    maxInvocations: 64,
    maxToolCalls: 64,
    mainToolIds: [],
    mainLoreScope: 'active',
    profiles: [],
    connectionSlots: [],
    runtimePolicy: {
      version: 1,
      authority: 'loom',
      scope: 'preset',
      defaultMode: 'response',
      loomPolicy: {
        version: 1,
        workPolicy: [],
        workspaceUsage: [],
        completionCriteria: [],
        renderPolicy: [],
      },
      phases: [],
    },
    taskPolicy: { templateIds: [] },
    workspacePolicy: { retention: 'turn_terminal', sharing: 'view_only' },
  }
}

export function createAgentProfileV2(
  name: string,
  existingIds: Iterable<string>,
): AgentProfileConfigV2 {
  const used = new Set(existingIds)
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 64) || 'agent'
  let id = base
  for (let suffix = 2; used.has(id); suffix += 1) {
    const tail = `_${suffix}`
    id = `${base.slice(0, 64 - tail.length)}${tail}`
  }
  return {
    id,
    name,
    systemPrompt: '',
    connectionRef: { kind: 'inherit_main' },
    toolIds: [],
    workspaceCapabilities: [],
    loreScope: 'active',
    allowMainDelegation: false,
    failurePolicy: 'required',
    streamActivity: false,
    maxOutputTokens: 1024,
    timeoutMs: 60_000,
  }
}


function isEditorConnectionRef(value: unknown): value is AgentProfileConfigV2['connectionRef'] {
  if (!isUnknownRecord(value) || !hasOnlyKeys(value, ['kind', 'slotId'])) return false
  if (value.kind === 'inherit_main') return !Object.hasOwn(value, 'slotId')
  return value.kind === 'slot'
    && typeof value.slotId === 'string'
    && SLOT_ID_PATTERN.test(value.slotId)
}

function isEditorProfile(value: unknown): value is AgentProfileConfigV2 {
  if (!isUnknownRecord(value)
    || !hasOnlyKeys(value, [
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
    ])
    || typeof value.id !== 'string'
    || !PROFILE_ID_PATTERN.test(value.id)
    || typeof value.name !== 'string'
    || !value.name.trim()
    || [...value.name].length > AGENT_PROFILE_NAME_MAX_LENGTH
    || typeof value.systemPrompt !== 'string'
    || UTF8_ENCODER.encode(value.systemPrompt).byteLength > AGENT_SYSTEM_PROMPT_MAX_BYTES
    || !isEditorConnectionRef(value.connectionRef)
    || !isCanonicalCoreToolIds(value.toolIds)
    || !isCanonicalWorkspaceCapabilities(value.workspaceCapabilities)
    || !isCanonicalLoreScope(value.loreScope)
    || value.loreScope === 'all_owned' && !profileHasLoreTool(value.toolIds)
    || typeof value.allowMainDelegation !== 'boolean'
    || value.failurePolicy !== 'required' && value.failurePolicy !== 'optional'
    || typeof value.streamActivity !== 'boolean'
    || typeof value.maxOutputTokens !== 'number'
    || !Number.isSafeInteger(value.maxOutputTokens)
    || value.maxOutputTokens < AGENT_MAX_OUTPUT_TOKENS_MIN
    || value.maxOutputTokens > AGENT_MAX_OUTPUT_TOKENS_MAX
    || typeof value.timeoutMs !== 'number'
    || !Number.isSafeInteger(value.timeoutMs)
    || value.timeoutMs < AGENT_TIMEOUT_MS_MIN
    || value.timeoutMs % MILLISECONDS_PER_SECOND !== 0) {
    return false
  }
  return true
}

function isEditorConnectionSlot(value: unknown): boolean {
  return isUnknownRecord(value)
    && hasOnlyKeys(value, ['id', 'label', 'requiredCapabilities'])
    && typeof value.id === 'string'
    && SLOT_ID_PATTERN.test(value.id)
    && typeof value.label === 'string'
    && value.label.trim().length > 0
    && [...value.label].length <= AGENT_PROFILE_NAME_MAX_LENGTH
    && isCanonicalAgentCapabilities(value.requiredCapabilities)
}

function quarantineRows(
  raw: unknown,
  predicate: (value: unknown) => boolean,
  reasonCode: AgenticRuntimeQuarantineItem['reasonCode'],
  limit: number,
): AgenticRuntimeQuarantineItem[] {
  if (!isIndexedArray(raw)) {
    return [{ id: `${reasonCode}:array`, index: -1, reasonCode }]
  }
  const rows = raw.slice(0, limit + 1)
    .map((value, index) => predicate(value) ? null : { id: `${reasonCode}:${index}`, index, reasonCode })
    .filter((item): item is AgenticRuntimeQuarantineItem => item !== null)
  if (raw.length > limit && !rows.some((item) => item.index === limit)) {
    rows.push({ id: `${reasonCode}:${limit}`, index: limit, reasonCode })
  }
  return rows
}

export function getAgentConfigQuarantine(config: AgentConfigV2): {
  profiles: AgenticRuntimeQuarantineItem[]
  connectionSlots: AgenticRuntimeQuarantineItem[]
} {
  const raw = config as unknown as Record<string, unknown>
  return {
    profiles: quarantineRows(raw.profiles, isEditorProfile, 'invalid_profile', AGENT_PROFILE_LIMIT),
    connectionSlots: quarantineRows(raw.connectionSlots, isEditorConnectionSlot, 'invalid_slot', AGENT_PROFILE_LIMIT * 2),
  }
}


export function normalizeAgentConfigForEditor(
  config: AgentConfigV2,
  sourceBlocks?: readonly PromptBlock[],
): AgentConfigV2 {
  const raw = config as unknown as Record<string, unknown>
  const profiles = isIndexedArray(raw.profiles)
    ? raw.profiles
      .filter(isEditorProfile)
      .slice(0, AGENT_PROFILE_LIMIT)
      .map((profile) => ({
        ...profile,
        workspaceCapabilities: isIndexedArray(profile.workspaceCapabilities)
          ? [...profile.workspaceCapabilities]
          : profile.workspaceCapabilities,
      }))
    : []
  const connectionSlots = isIndexedArray(raw.connectionSlots)
    ? raw.connectionSlots.filter(isEditorConnectionSlot).slice(0, AGENT_PROFILE_LIMIT * 2)
    : []
  let next = {
    ...raw,
    profiles,
    connectionSlots,
  } as AgentConfigV2
  const rawRuntimePolicy = next.runtimePolicy
  if (isUnknownRecord(rawRuntimePolicy)) {
    try {
      // Canonicalize valid custom phase rows (including absent child subsets)
      // while retaining malformed imported policy for explicit repair.
      next.runtimePolicy = parseAgentRuntimePolicyV1(rawRuntimePolicy)
    } catch {
      // Validation and the panel repair surface own malformed policy values.
    }
  } else if (
    sourceBlocks !== undefined
    && !Object.hasOwn(raw, 'runtimePolicy')
    && Object.hasOwn(raw, 'cognitionPolicy')
    && (raw.cognitionPolicy === undefined
      || raw.cognitionPolicy === null
      || isCognitionPolicyShape(raw.cognitionPolicy))
  ) {
    try {
      // Legacy policy rows are import-only. A valid value becomes the single
      // canonical Loom surface; malformed or unresolved input remains visible
      // to validation instead of being silently discarded.
      next = setAgentRuntimePolicyBuckets(
        next,
        normalizeLoomPolicyBucketsV1(raw.cognitionPolicy, sourceBlocks),
      )
    } catch {
      // Validation and explicit repair own legacy rows that cannot be converted.
    }
  }
  if (!Object.hasOwn(raw, 'taskPolicy')) next.taskPolicy = { templateIds: [] }
  if (!Object.hasOwn(raw, 'workspacePolicy')) {
    next.workspacePolicy = { retention: 'turn_terminal', sharing: 'view_only' }
  }
  return next
}
export function prepareAgentConfigForRuntimeSave(
  config: AgentConfigV2,
  sourceBlocks: readonly PromptBlock[],
  expectedPresetRevision: number,
): AgentConfigV2 {
  if (!Number.isSafeInteger(expectedPresetRevision) || expectedPresetRevision < 0) {
    return loomPolicyError('expectedPresetRevision', 'must be a non-negative safe integer')
  }
  const normalized = normalizeAgentConfigForEditor(config, sourceBlocks)
  const normalizedRecord = normalized as unknown as Record<string, unknown>
  if (Object.hasOwn(normalizedRecord, 'cognitionPolicy')) {
    return loomPolicyError('config.runtimePolicy', 'legacy policy input requires explicit repair before save')
  }
  const rawRuntimePolicy = normalizedRecord.runtimePolicy
  if (rawRuntimePolicy === undefined) {
    if (Object.hasOwn(normalizedRecord, 'runtimePolicy')) {
      return loomPolicyError('config.runtimePolicy', 'undefined policy input requires explicit repair before save')
    }
    return normalized
  }
  const runtimePolicy = parseAgentRuntimePolicyV1(rawRuntimePolicy)
  // The client submits sources against the editor revision it actually loaded.
  // Only the server can decide whether prompt order changed and, when it did,
  // atomically advance preset authority and rebase unchanged exact references.
  const validateSource = (source: LoomPolicySourceV1, path: string): void => {
    const current = sourceBlocks[source.promptOrder]
    if (!current || current.id !== source.blockId || current.marker === 'category') {
      loomPolicyError(path, 'source block requires explicit repair before save')
    }
    const blockRevision = promptBlockRevision(current, `${path}.blockRevision`)
    if (source.presetRevision !== expectedPresetRevision
      || source.blockRevision !== blockRevision
      || source.promptOrder < 0 || source.promptOrder >= sourceBlocks.length) {
      loomPolicyError(path, 'source revision requires explicit repair before save')
    }
  }
  if (runtimePolicy.loomPolicy !== null) {
    for (const bucket of ['workPolicy', 'workspaceUsage', 'completionCriteria', 'renderPolicy'] as const) {
      runtimePolicy.loomPolicy[bucket].forEach((entry, index) => {
        validateSource(entry.source, `config.runtimePolicy.loomPolicy.${bucket}.${index}.source`)
      })
    }
  }
  runtimePolicy.phases.forEach((phase, phaseIndex) => {
    phase.instructionRefs.forEach((source, sourceIndex) => {
      validateSource(source, `config.runtimePolicy.phases.${phaseIndex}.instructionRefs.${sourceIndex}`)
    })
    phase.childInstructionSubsets.forEach((subset, subsetIndex) => {
      subset.instructionRefs.forEach((source, sourceIndex) => {
        validateSource(
          source,
          `config.runtimePolicy.phases.${phaseIndex}.childInstructionSubsets.${subsetIndex}.instructionRefs.${sourceIndex}`,
        )
      })
    })
  })
  return normalized
}


export function createAgenticRuntimeDraft(preset: LoomPreset): AgenticRuntimeSaveDraft {
  const sourceConfig = (isUnknownRecord(preset.agentConfig)
    ? structuredClone(preset.agentConfig)
    : createDefaultAgentConfigV2()) as AgentConfigV2
  const quarantine = getAgentConfigQuarantine(sourceConfig)
  const config = normalizeAgentConfigForEditor(sourceConfig, preset.blocks)
  const reviewValue: unknown = preset.agentConfigReview
  const reviewItems = isUnknownRecord(reviewValue) && Array.isArray(reviewValue.items)
    ? reviewValue.items.filter((item): item is AgentConfigRepairItem => isValidRepairItem(item))
    : []
  const slotBindings = isUnknownRecord(preset.agentSlotBindings)
    ? { ...preset.agentSlotBindings }
    : {}
  return {
    config,
    slotBindings,
    taskTemplates: Array.isArray(preset.agentTaskTemplates)
      ? structuredClone(preset.agentTaskTemplates)
      : [],
    reviewAcknowledgements: reviewItems
      .filter((item) => item.acknowledged)
      .map((item) => item.id),
    quarantinedProfiles: quarantine.profiles,
    quarantinedConnectionSlots: quarantine.connectionSlots,
  }
}
function createPredicateValidationBudget(): PredicateValidationBudget {
  return { nodes: 0, listBytes: 0, listLimitExceeded: false }
}


interface PredicateValidationBudget {
  nodes: number
  listBytes: number
  listLimitExceeded: boolean
}

function accountPredicateListString(
  value: string,
  path: string,
  issues: AgenticRuntimeValidationIssue[],
  budget: PredicateValidationBudget,
): void {
  budget.listBytes += UTF8_ENCODER.encode(value).byteLength
  if (budget.listBytes > AGENTIC_PREDICATE_MAX_LIST_BYTES && !budget.listLimitExceeded) {
    budget.listLimitExceeded = true
    issues.push({ code: 'predicate_limit_exceeded', path })
  }
}

function validatePredicate(
  predicate: CognitionPredicate,
  path: string,
  issues: AgenticRuntimeValidationIssue[],
  budget: PredicateValidationBudget,
  taskTemplateIds?: ReadonlySet<string>,
): void {
  const visit = (current: unknown, currentPath: string, depth: number): void => {
    budget.nodes += 1
    if (depth > AGENTIC_PREDICATE_MAX_DEPTH || budget.nodes > AGENTIC_PREDICATE_MAX_NODES) {
      issues.push({ code: 'predicate_limit_exceeded', path: currentPath })
      return
    }
    if (!isUnknownRecord(current)) {
      issues.push({ code: 'invalid_predicate', path: currentPath })
      return
    }
    if (current.kind === 'all' || current.kind === 'any') {
      if (!isIndexedArray(current.children)) {
        issues.push({ code: 'invalid_predicate', path: currentPath })
        return
      }
      current.children.forEach((child, index) => visit(child, `${currentPath}.children.${index}`, depth + 1))
      return
    }
    if (current.kind === 'not') {
      visit(current.child, `${currentPath}.child`, depth + 1)
      return
    }
    if (current.kind === 'preset_variable' || current.kind === 'participant_fact') {
      const name = typeof current.name === 'string' ? current.name.trim() : ''
      const scalarValue = isCognitionScalar(current.value) ? current.value : null
      const valueList = isCognitionScalarList(current.values) ? current.values : null
      const equalsStringList = isCognitionStringList(current.value) ? current.value : null
      const hasScalar = scalarValue !== null
      const hasValueList = valueList !== null
      const hasEqualsValue = current.operator === 'equals'
        && (hasScalar || equalsStringList !== null)
      const hasIncludesValue = current.operator === 'includes' && hasScalar
      if (!name
        || current.operator === 'in' && !hasValueList
        || current.operator === 'equals' && !hasEqualsValue
        || current.operator === 'includes' && !hasIncludesValue
        || current.operator !== 'present'
          && current.operator !== 'in'
          && current.operator !== 'equals'
          && current.operator !== 'includes'
      ) {
        issues.push({ code: 'invalid_predicate', path: currentPath })
        return
      }
      if (current.operator === 'in' && valueList !== null) {
        valueList.forEach((entry, index) => {
          if (typeof entry === 'string') {
            accountPredicateListString(entry, `${currentPath}.values.${index}`, issues, budget)
          }
        })
      } else if (current.operator === 'equals' && equalsStringList !== null) {
        equalsStringList.forEach((entry, index) => {
          accountPredicateListString(entry, `${currentPath}.value.${index}`, issues, budget)
        })
      } else if (current.operator === 'includes' && typeof scalarValue === 'string') {
        accountPredicateListString(scalarValue, `${currentPath}.value`, issues, budget)
      }
      return
    }
    if (current.kind === 'tool_available') {
      if (typeof current.toolId !== 'string' || !current.toolId.trim() || typeof current.available !== 'boolean') {
        issues.push({ code: 'invalid_predicate', path: currentPath })
      }
      return
    }
    if (current.kind === 'task_transition') {
      if (
        typeof current.taskId !== 'string'
        || !POLICY_ID_PATTERN.test(current.taskId)
        || !['pending', 'active', 'blocked', 'completed', 'cancelled', 'failed'].includes(String(current.transition))
        || taskTemplateIds !== undefined && !taskTemplateIds.has(current.taskId)
      ) {
        issues.push({ code: 'invalid_predicate', path: currentPath })
      }
      return
    }
    if (current.kind === 'generation_type') {
      if (!['normal', 'continue', 'regenerate', 'swipe'].includes(String(current.value))) {
        issues.push({ code: 'invalid_predicate', path: currentPath })
      }
      return
    }
    if (current.kind === 'phase') {
      if (!['ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT', 'COMMITTING', 'COMMITTED',
        'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(String(current.value))) {
        issues.push({ code: 'invalid_predicate', path: currentPath })
      }
      return
    }
    issues.push({ code: 'invalid_predicate', path: currentPath })
  }
  visit(predicate, path, 1)
}

function isCanonicalWorkspaceCapabilities(value: unknown): value is WorkspaceCapability[] {
  if (value === undefined) return true
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
  let previousIndex = -1
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index)) || typeof value[index] !== 'string') return false
    const operationIndex = WORKSPACE_CAPABILITIES.indexOf(value[index] as WorkspaceCapability)
    if (operationIndex < 0 || operationIndex <= previousIndex || seen.has(value[index])) return false
    seen.add(value[index])
    previousIndex = operationIndex
  }
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && (key === 'length' || /^\d+$/.test(key)))
}
function isIndexedArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index))) return false
  }
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && (key === 'length' || /^\d+$/.test(key)))
}

function isCanonicalCoreToolIds(value: unknown): value is CoreAgentToolId[] {
  if (!isIndexedArray(value)) return false
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string'
      || !CORE_AGENT_TOOL_IDS.includes(entry as CoreAgentToolId)
      || seen.has(entry)) {
      return false
    }
    seen.add(entry)
  }
  return true
}
function isCognitionPolicyShape(value: unknown): value is Record<CognitionPolicyKey, unknown[]> {
  return isUnknownRecord(value)
    && hasOnlyKeys(value, COGNITION_POLICY_KEYS)
    && COGNITION_POLICY_KEYS.every((key) => isIndexedArray(value[key]))
}

function isCanonicalAgentCapabilities(value: unknown): value is AgentCapability[] {
  if (!isIndexedArray(value)) return false
  let previousIndex = -1
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') return false
    const capabilityIndex = AGENT_CAPABILITY_IDS.indexOf(entry as (typeof AGENT_CAPABILITY_IDS)[number])
    if (capabilityIndex < 0 || capabilityIndex <= previousIndex || seen.has(entry)) return false
    seen.add(entry)
    previousIndex = capabilityIndex
  }
  return true
}

function isCanonicalLoreScope(value: unknown): value is (typeof AGENT_LORE_SCOPES)[number] {
  return typeof value === 'string' && AGENT_LORE_SCOPES.includes(value as (typeof AGENT_LORE_SCOPES)[number])
}

function profileHasLoreTool(toolIds: readonly CoreAgentToolId[]): boolean {
  return toolIds.some((toolId) => LORE_TOOL_IDS[toolId] === true)
}

function validateProfiles(
  config: AgentConfigV2,
  draft: AgenticRuntimeSaveDraft,
  issues: AgenticRuntimeValidationIssue[],
): Set<string> {
  const profileIds = new Set<string>()
  const slotIds = new Set<string>()
  const profiles: unknown = (config as unknown as Record<string, unknown>).profiles
  const slots: unknown = (config as unknown as Record<string, unknown>).connectionSlots
  if (!isIndexedArray(profiles)) {
    issues.push({ code: 'invalid_profile', path: 'config.profiles' })
    return profileIds
  }
  if (!isIndexedArray(slots)) {
    issues.push({ code: 'invalid_slot', path: 'config.connectionSlots' })
  } else {
    if (slots.length > AGENT_PROFILE_LIMIT * 2) {
      issues.push({ code: 'invalid_slot', path: 'config.connectionSlots' })
    }
    slots.forEach((value, index) => {
      if (!isUnknownRecord(value)
        || !hasOnlyKeys(value, ['id', 'label', 'requiredCapabilities'])
        || typeof value.id !== 'string'
        || !SLOT_ID_PATTERN.test(value.id)
        || typeof value.label !== 'string'
        || !value.label.trim()
        || [...value.label].length > AGENT_PROFILE_NAME_MAX_LENGTH
        || !isCanonicalAgentCapabilities(value.requiredCapabilities)) {
        issues.push({ code: 'invalid_slot', path: `config.connectionSlots.${index}` })
        return
      }
      if (slotIds.has(value.id)) {
        issues.push({ code: 'invalid_slot', path: `config.connectionSlots.${index}.id` })
        return
      }
      slotIds.add(value.id)
    })
  }
  if (profiles.length > AGENT_PROFILE_LIMIT) {
    issues.push({ code: 'invalid_profile', path: 'config.profiles' })
  }
  profiles.forEach((rawProfile, index) => {
    const profile = isUnknownRecord(rawProfile) ? rawProfile : {}
    const profileToolIds = profile.toolIds
    const validToolIds = isCanonicalCoreToolIds(profileToolIds)
    const validLoreScope = isCanonicalLoreScope(profile.loreScope)
    const maxOutputTokens = profile.maxOutputTokens
    const timeoutMs = profile.timeoutMs
    const validMaxOutputTokens = typeof maxOutputTokens === 'number'
      && Number.isSafeInteger(maxOutputTokens)
      && maxOutputTokens >= AGENT_MAX_OUTPUT_TOKENS_MIN
      && maxOutputTokens <= AGENT_MAX_OUTPUT_TOKENS_MAX
    const validTimeoutMs = typeof timeoutMs === 'number'
      && Number.isSafeInteger(timeoutMs)
      && timeoutMs >= AGENT_TIMEOUT_MS_MIN
      && timeoutMs % MILLISECONDS_PER_SECOND === 0
    if (typeof profile.id !== 'string'
      || !PROFILE_ID_PATTERN.test(profile.id)
      || profileIds.has(profile.id)
      || typeof profile.name !== 'string'
      || !profile.name.trim()
      || [...profile.name].length > AGENT_PROFILE_NAME_MAX_LENGTH
      || typeof profile.systemPrompt !== 'string'
      || UTF8_ENCODER.encode(profile.systemPrompt).byteLength > AGENT_SYSTEM_PROMPT_MAX_BYTES
      || !validToolIds
      || !validLoreScope
      || validLoreScope && profile.loreScope === 'all_owned'
        && (!validToolIds || !profileHasLoreTool(profileToolIds))
      || !isCanonicalWorkspaceCapabilities(profile.workspaceCapabilities)
      || typeof profile.allowMainDelegation !== 'boolean'
      || profile.failurePolicy !== 'required' && profile.failurePolicy !== 'optional'
      || typeof profile.streamActivity !== 'boolean'
      || !validMaxOutputTokens
      || !validTimeoutMs) {
      issues.push({ code: 'invalid_profile', path: `config.profiles.${index}` })
    }
    if (typeof profile.id === 'string') profileIds.add(profile.id)
    const connectionRef = profile.connectionRef
    if (!isUnknownRecord(connectionRef) || !hasOnlyKeys(connectionRef, ['kind', 'slotId'])) {
      issues.push({ code: 'invalid_profile', path: `config.profiles.${index}.connectionRef` })
    } else if (connectionRef.kind === 'slot') {
      const slotId = connectionRef.slotId
      if (typeof slotId !== 'string' || !SLOT_ID_PATTERN.test(slotId)) {
        issues.push({ code: 'invalid_profile', path: `config.profiles.${index}.connectionRef` })
      } else if (!slotIds.has(slotId)) {
        issues.push({ code: 'invalid_slot', path: `config.profiles.${index}.connectionRef` })
      } else if (!isUnknownRecord(draft.slotBindings) || !draft.slotBindings[slotId]) {
        issues.push({ code: 'unresolved_slot', path: `slotBindings.${slotId}` })
      }
    } else if (connectionRef.kind !== 'inherit_main') {
      issues.push({ code: 'invalid_profile', path: `config.profiles.${index}.connectionRef` })
    }
  })
  return profileIds
}

function validateRuntimePolicy(
  config: AgentConfigV2,
  blocks: readonly PromptBlock[],
  expectedPresetRevision: number,
  issues: AgenticRuntimeValidationIssue[],
  taskTemplateIds?: ReadonlySet<string>,
  profileIds?: ReadonlySet<string>,
): void {
  const rawConfig = config as unknown as Record<string, unknown>
  const value = rawConfig.runtimePolicy
  if (value === undefined) {
    if (Object.hasOwn(rawConfig, 'runtimePolicy')) {
      issues.push({ code: 'invalid_runtime_policy', path: 'config.runtimePolicy' })
    }
    return
  }
  if (!isUnknownRecord(value)
    || !hasOnlyKeys(value, ['version', 'authority', 'scope', 'defaultMode', 'loomPolicy', 'phases'])
    || value.version !== 1
    || value.authority !== 'loom'
    || value.scope !== 'preset'
    || value.defaultMode !== config.defaultMode
    || (value.loomPolicy !== null && !isUnknownRecord(value.loomPolicy))
    || !isIndexedArray(value.phases)) {
    issues.push({ code: 'invalid_runtime_policy', path: 'config.runtimePolicy' })
    return
  }
  let phases: readonly AgentCustomPhaseV1[]
  try {
    phases = parseAgentCustomPhasesV1(value.phases)
  } catch (caught) {
    if (isCognitionPredicateLimitError(caught)) {
      issues.push({ code: 'predicate_limit_exceeded', path: caught.path })
      return
    }
    const invalidSelfLoopIndexes = value.phases.flatMap((phase, index) => {
      if (!isUnknownRecord(phase)
        || typeof phase.id !== 'string'
        || phase.repeatLimit !== 0
        || !Array.isArray(phase.nextPhaseIds)
        || !phase.nextPhaseIds.some((phaseId) => phaseId === phase.id)) {
        return []
      }
      return [index]
    })
    if (invalidSelfLoopIndexes.length > 0) {
      invalidSelfLoopIndexes.forEach((index) => {
        issues.push({
          code: 'invalid_policy_entry',
          path: `config.runtimePolicy.phases.${index}.repeatLimit`,
        })
      })
    } else {
      issues.push({ code: 'invalid_runtime_policy', path: 'config.runtimePolicy.phases' })
    }
    return
  }
  let policies: LoomPolicyBucketsV1 | null = null
  if (value.loomPolicy !== null) {
    try {
      policies = parseLoomPolicyBucketsV1(value.loomPolicy)
    } catch (caught) {
      if (isCognitionPredicateLimitError(caught)) {
        issues.push({
          code: 'predicate_limit_exceeded',
          path: caught.path
            .replace(/^policies\./, 'config.runtimePolicy.loomPolicy.')
            .replace(/\[(\d+)\]/g, '.$1'),
        })
      } else {
        issues.push({ code: 'invalid_runtime_policy', path: 'config.runtimePolicy.loomPolicy' })
      }
      return
    }
  }
  phases.forEach((phase, index) => {
    const path = `config.runtimePolicy.phases.${index}`
    const nextPhaseId = phases[index + 1]?.id
    phase.instructionRefs.forEach((source, refIndex) => {
      const block = blocks[source.promptOrder]
      const sourcePath = `${path}.instructionRefs.${refIndex}`
      if (!block || block.id !== source.blockId || block.marker === 'category') {
        issues.push({ code: 'invalid_policy_entry', path: sourcePath })
        return
      }
      if (block.revision !== undefined && !isCanonicalBlockRevision(block.revision)) {
        issues.push({ code: 'invalid_policy_entry', path: sourcePath })
        return
      }
      const blockRevision = block.revision ?? 1
      if (source.presetRevision !== expectedPresetRevision
        || source.blockRevision !== blockRevision
        || source.promptOrder < 0 || source.promptOrder >= blocks.length) {
        issues.push({ code: 'stale_policy_source', path: sourcePath })
      }
    })
    const phaseSourceKeys = new Set(phase.instructionRefs.map(loomSourceKey))
    const subsetProfileIds = new Set<string>()
    let aggregateSubsetRefs = 0
    phase.childInstructionSubsets.forEach((subset, subsetIndex) => {
      const subsetPath = `${path}.childInstructionSubsets.${subsetIndex}`
      if (subsetProfileIds.has(subset.profileId)) {
        issues.push({ code: 'invalid_policy_entry', path: `${subsetPath}.profileId` })
      }
      subsetProfileIds.add(subset.profileId)
      if (profileIds !== undefined && !profileIds.has(subset.profileId)) {
        issues.push({ code: 'invalid_policy_entry', path: `${subsetPath}.profileId` })
      }
      aggregateSubsetRefs += subset.instructionRefs.length
      if (aggregateSubsetRefs > 64) {
        issues.push({ code: 'invalid_policy_entry', path: `${subsetPath}.instructionRefs` })
      }
      const subsetSourceKeys = new Set<string>()
      subset.instructionRefs.forEach((source, refIndex) => {
        const sourceKey = loomSourceKey(source)
        if (subsetSourceKeys.has(sourceKey) || !phaseSourceKeys.has(sourceKey)) {
          issues.push({
            code: 'invalid_policy_entry',
            path: `${subsetPath}.instructionRefs.${refIndex}`,
          })
        }
        subsetSourceKeys.add(sourceKey)
      })
    })
    validatePredicate(phase.enter, `${path}.enter`, issues, createPredicateValidationBudget(), taskTemplateIds)
    validatePredicate(phase.exit, `${path}.exit`, issues, createPredicateValidationBudget(), taskTemplateIds)
    if (phase.skip !== undefined) {
      validatePredicate(phase.skip, `${path}.skip`, issues, createPredicateValidationBudget(), taskTemplateIds)
    }
    if (phase.nextPhaseIds.includes(phase.id) && phase.repeatLimit === 0) {
      issues.push({ code: 'invalid_policy_entry', path: `${path}.repeatLimit` })
    }
    phase.nextPhaseIds.forEach((candidate, nextIndex) => {
      if (candidate !== phase.id && candidate !== nextPhaseId) {
        issues.push({ code: 'invalid_policy_entry', path: `${path}.nextPhaseIds.${nextIndex}` })
      }
    })
  })
  if (policies === null) return
  const loomPredicateBudget = createPredicateValidationBudget()
  for (const bucket of LOOM_POLICY_BUCKET_ORDER) {
    policies[bucket].forEach((entry, index) => {
      const path = `config.runtimePolicy.loomPolicy.${bucket}.${index}`
      const block = blocks[entry.source.promptOrder]
      if (!block || block.id !== entry.source.blockId || block.marker === 'category') {
        issues.push({ code: 'invalid_policy_entry', path })
        return
      }
      if (block.revision !== undefined && !isCanonicalBlockRevision(block.revision)) {
        issues.push({ code: 'invalid_policy_entry', path })
        return
      }
      const currentBlockRevision = block.revision ?? 1
      if (entry.source.presetRevision !== expectedPresetRevision
        || entry.source.blockRevision !== currentBlockRevision
        || entry.source.promptOrder < 0 || entry.source.promptOrder >= blocks.length) {
        issues.push({ code: 'stale_policy_source', path: `${path}.source` })
      }
      if (entry.condition !== undefined) {
        validatePredicate(entry.condition, `${path}.condition`, issues, loomPredicateBudget, taskTemplateIds)
      }
    })
  }
  const conflictingIds = conflictingDestBlockEntryIds(policies)
  if (conflictingIds.size === 0) return
  for (const bucket of LOOM_POLICY_BUCKET_ORDER) {
    policies[bucket].forEach((entry, index) => {
      if (!conflictingIds.has(entry.id)) return
      issues.push({
        code: 'invalid_policy_entry',
        path: `config.runtimePolicy.loomPolicy.${bucket}.${index}.source`,
      })
    })
  }
}
function validateLegacyPolicySurface(
  config: AgentConfigV2,
  _blocks: readonly PromptBlock[],
  issues: AgenticRuntimeValidationIssue[],
): void {
  const raw = config as unknown as Record<string, unknown>
  if (Object.hasOwn(raw, 'cognitionPolicy')) {
    issues.push({ code: 'invalid_runtime_policy', path: 'config.cognitionPolicy' })
  }
}


function validateCognitionBlocks(
  config: AgentConfigV2,
  blocks: readonly PromptBlock[],
  expectedPresetRevision: number,
  issues: AgenticRuntimeValidationIssue[],
): void {
  const blockById = new Map<string, PromptBlock>()
  for (const candidate of blocks) {
    if (isUnknownRecord(candidate) && typeof candidate.id === 'string') {
      blockById.set(candidate.id, candidate as unknown as PromptBlock)
    }
  }
  const policy: unknown = (config as unknown as Record<string, unknown>).cognitionPolicy
  if (policy === undefined || policy === null) return
  if (!isCognitionPolicyShape(policy)) {
    issues.push({ code: 'invalid_config', path: 'config.cognitionPolicy' })
    return
  }
  for (const groupName of COGNITION_POLICY_KEYS) {
    const refs = policy[groupName]
    refs.forEach((rawRef, index) => {
      const path = `config.cognitionPolicy.${groupName}.${index}`
      if (!isUnknownRecord(rawRef)
        || !hasOnlyKeys(rawRef, ['blockId', 'expectedPresetRevision', 'expectedBlockRevision'])
        || typeof rawRef.blockId !== 'string') {
        issues.push({ code: 'invalid_block_reference', path })
        return
      }
      const ref = rawRef
      const blockId = ref.blockId
      if (typeof blockId !== 'string') {
        issues.push({ code: 'invalid_block_reference', path })
        return
      }
      const block = blockById.get(blockId)
      if (!block || block.marker === 'category') {
        issues.push({ code: 'invalid_block_reference', path })
        return
      }
      const rawRevision = (block as unknown as Record<string, unknown>).revision
      const blockRevision = isCanonicalBlockRevision(rawRevision) ? rawRevision : rawRevision === undefined ? 1 : null
      if (!isNonNegativeSafeInteger(expectedPresetRevision)
        || !isNonNegativeSafeInteger(ref.expectedPresetRevision)
        || !isNonNegativeSafeInteger(ref.expectedBlockRevision)
        || blockRevision === null) {
        issues.push({ code: 'invalid_block_reference', path })
      } else if (ref.expectedPresetRevision !== expectedPresetRevision
        || ref.expectedBlockRevision !== blockRevision) {
        issues.push({ code: 'stale_block_revision', path })
      }
    })
  }
}
function validatePromptProfileMarkers(
  profileIds: ReadonlySet<string>,
  blocks: readonly PromptBlock[],
  issues: AgenticRuntimeValidationIssue[],
): void {
  blocks.forEach((block, index) => {
    const content = isUnknownRecord(block) ? block.content : undefined
    for (const profileId of getAgentProfileMarkerIds(content)) {
      if (!profileIds.has(profileId)) {
        issues.push({ code: 'invalid_profile', path: `promptOrder.${index}.content` })
      }
    }
  })
}

function validateTaskTemplates(
  templates: readonly unknown[],
  issues: AgenticRuntimeValidationIssue[],
  predicateBudget: PredicateValidationBudget,
): Set<string> {
  if (templates.length > AGENTIC_TASK_TEMPLATE_LIMIT) {
    issues.push({ code: 'invalid_task_template', path: 'taskTemplates' })
  }
  const byId = new Map<string, AgentTaskTemplate>()
  const validTemplates: Array<{ template: AgentTaskTemplate; index: number }> = []
  templates.forEach((value, index) => {
    if (!isAgentTaskTemplate(value, false)) {
      if (isUnknownRecord(value)
        && value.activation !== undefined
        && cognitionPredicateBudgetExceeded(value.activation)) {
        issues.push({ code: 'predicate_limit_exceeded', path: `taskTemplates.${index}.activation` })
      } else {
        issues.push({ code: 'invalid_task_template', path: `taskTemplates.${index}` })
      }
      return
    }
    const template = value
    if (byId.has(template.id)) {
      issues.push({ code: 'invalid_task_template', path: `taskTemplates.${index}` })
    }
    byId.set(template.id, template)
    validTemplates.push({ template, index })
  })
  const templateIds = new Set(byId.keys())
  validTemplates.forEach(({ template, index }) => {
    if (template.activation) {
      validatePredicate(template.activation, `taskTemplates.${index}.activation`, issues, predicateBudget, templateIds)
    }
    const dependencies = template.dependencies ?? []
    if (new Set(dependencies).size !== dependencies.length) {
      issues.push({ code: 'invalid_task_template', path: `taskTemplates.${index}.dependencies` })
    }
    dependencies.forEach((dependencyId, dependencyIndex) => {
      if (!byId.has(dependencyId)) {
        issues.push({
          code: 'missing_task_dependency',
          path: `taskTemplates.${index}.dependencies.${dependencyIndex}`,
        })
      }
    })
  })
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    const cyclic = byId.get(id)?.dependencies?.some((dependencyId) => visit(dependencyId)) ?? false
    visiting.delete(id)
    visited.add(id)
    return cyclic
  }
  for (const id of byId.keys()) {
    if (visit(id)) {
      issues.push({ code: 'cyclic_task_dependency', path: `taskTemplates.${id}.dependencies` })
      break
    }
  }
  return new Set(byId.keys())
}

function validateTaskPolicy(
  policyValue: unknown,
  templateIds: ReadonlySet<string>,
  issues: AgenticRuntimeValidationIssue[],
): void {
  const policy = policyValue === undefined ? { templateIds: [] } : policyValue
  if (!isUnknownRecord(policy)
    || !hasOnlyKeys(policy, ['templateIds'])
    || !isIndexedArray(policy.templateIds)
    || policy.templateIds.length > AGENTIC_TASK_TEMPLATE_LIMIT) {
    issues.push({ code: 'invalid_task_policy', path: 'config.taskPolicy' })
    return
  }
  if (policyValue === undefined && templateIds.size > 0) {
    issues.push({ code: 'invalid_task_policy', path: 'config.taskPolicy' })
    return
  }
  const policyIds = new Set<string>()
  policy.templateIds.forEach((templateId, index) => {
    if (typeof templateId !== 'string'
      || !POLICY_ID_PATTERN.test(templateId)
      || policyIds.has(templateId)
      || !templateIds.has(templateId)) {
      issues.push({ code: 'invalid_task_policy', path: `config.taskPolicy.templateIds.${index}` })
      return
    }
    policyIds.add(templateId)
  })
}


export const INHERITED_IMPORT_REVIEW_ACKNOWLEDGEMENTS: Record<string, true> = {
  'review:foreign_import': true,
  'review:cognition_foreign_authority_blocked': true,
}

export function requiredReviewAcknowledgements(
  liveRequiredReviewIds: readonly string[],
  acknowledgements: readonly string[],
): string[] {
  const liveIncludesImportReview = liveRequiredReviewIds.some((id) => INHERITED_IMPORT_REVIEW_ACKNOWLEDGEMENTS[id] === true)
  if (liveIncludesImportReview) return [...liveRequiredReviewIds]
  const leftover = acknowledgements.filter((id) => INHERITED_IMPORT_REVIEW_ACKNOWLEDGEMENTS[id] === true)
  if (leftover.length === 0) return [...liveRequiredReviewIds]
  return [...new Set([...liveRequiredReviewIds, ...leftover])]
}

export function validateAgenticRuntimeDraft(
  draft: AgenticRuntimeSaveDraft,
  blocks: readonly PromptBlock[],
  expectedPresetRevision: number,
  requiredReviewItemIds: readonly string[] = [],
): AgenticRuntimeValidationResult {
  const issues: AgenticRuntimeValidationIssue[] = []
  if (!isUnknownRecord(draft)) return { valid: false, issues: [{ code: 'invalid_config', path: 'draft' }] }
  const rawConfig = draft.config
  if (!isUnknownRecord(rawConfig)) return { valid: false, issues: [{ code: 'invalid_config', path: 'config' }] }
  const config = rawConfig as unknown as AgentConfigV2
  if (config.version !== 2) return { valid: false, issues: [{ code: 'invalid_config', path: 'config' }] }

  const allowedModes = rawConfig.allowedModes
  const modesAreValid = isIndexedArray(allowedModes)
  if (!modesAreValid
    || allowedModes.length === 0
    || allowedModes[0] !== 'response'
    || new Set(allowedModes).size !== allowedModes.length
    || allowedModes.some((mode) => !AGENT_MODES.includes(mode as AgentMode))) {
    issues.push({ code: 'invalid_modes', path: 'config.allowedModes' })
  }
  if (modesAreValid && typeof rawConfig.defaultMode !== 'string') {
    issues.push({ code: 'invalid_default_mode', path: 'config.defaultMode' })
  } else if (modesAreValid && !allowedModes.includes(rawConfig.defaultMode)) {
    issues.push({ code: 'invalid_default_mode', path: 'config.defaultMode' })
  }
  if (typeof rawConfig.agentsEnabled !== 'boolean') {
    issues.push({ code: 'invalid_config', path: 'config.agentsEnabled' })
  } else if (!rawConfig.agentsEnabled && modesAreValid && allowedModes.includes('agentic')) {
    issues.push({ code: 'invalid_modes', path: 'config.allowedModes' })
  }

  const validMainToolIds = isCanonicalCoreToolIds(rawConfig.mainToolIds)
  const validMainLoreScope = isCanonicalLoreScope(rawConfig.mainLoreScope)
  if (!validMainToolIds
    || !validMainLoreScope
    || validMainLoreScope && rawConfig.mainLoreScope === 'all_owned' && !profileHasLoreTool(rawConfig.mainToolIds)) {
    issues.push({ code: 'invalid_config', path: 'config.mainToolIds' })
  }
  const profileIds = validateProfiles(config, draft, issues)
  if (isIndexedArray(draft.quarantinedProfiles) && draft.quarantinedProfiles.length > 0) {
    issues.push({ code: 'invalid_profile', path: 'config.profiles.quarantine' })
  }
  if (isIndexedArray(draft.quarantinedConnectionSlots) && draft.quarantinedConnectionSlots.length > 0) {
    issues.push({ code: 'invalid_slot', path: 'config.connectionSlots.quarantine' })
  }
  const promptBlocksAreValid = isIndexedArray(blocks)
  const promptBlocks = promptBlocksAreValid ? blocks : []
  if (!promptBlocksAreValid) {
    issues.push({ code: 'invalid_block_reference', path: 'promptOrder' })
  }
  validatePromptProfileMarkers(profileIds, promptBlocks as PromptBlock[], issues)
  validateCognitionBlocks(config, promptBlocks as PromptBlock[], expectedPresetRevision, issues)
  validateLegacyPolicySurface(config, promptBlocks as PromptBlock[], issues)

  const predicateBudget: PredicateValidationBudget = { nodes: 0, listBytes: 0, listLimitExceeded: false }
  const taskTemplates = isIndexedArray(draft.taskTemplates) ? draft.taskTemplates : []
  if (!isIndexedArray(draft.taskTemplates)) {
    issues.push({ code: 'invalid_task_template', path: 'taskTemplates' })
  }
  const taskTemplateIds = validateTaskTemplates(taskTemplates, issues, predicateBudget)
  validateTaskPolicy(rawConfig.taskPolicy, taskTemplateIds, issues)

  validateRuntimePolicy(
    config,
    promptBlocks as PromptBlock[],
    expectedPresetRevision,
    issues,
    taskTemplateIds,
    profileIds,
  )
  const acknowledgements = isStringList(draft.reviewAcknowledgements)
    ? draft.reviewAcknowledgements
    : []
  if (acknowledgements !== draft.reviewAcknowledgements) {
    issues.push({ code: 'review_acknowledgement_unknown', path: 'reviewAcknowledgements' })
  }
  // Live required ids are fail-closed. Leftover inherited import acknowledgements
  // remain required when they are still the only record of that review.
  const effectiveRequiredReviewIds = requiredReviewAcknowledgements(requiredReviewItemIds, acknowledgements)
  if (effectiveRequiredReviewIds.some((id) => !acknowledgements.includes(id))) {
    issues.push({ code: 'review_acknowledgement_required', path: 'reviewAcknowledgements' })
  }
  return { valid: issues.length === 0, issues }
}
function isValidRepairItem(value: unknown): value is AgentConfigRepairItem {
  if (!isUnknownRecord(value) || typeof value.id !== 'string' || typeof value.reasonCode !== 'string') return false
  const action = value.action
  if (!isUnknownRecord(action) || typeof action.kind !== 'string') return false
  return ['unresolved_slot', 'stale_slot', 'disabled_import', 'capability_mismatch', 'stale_block'].includes(String(value.kind))
    && ['acknowledge', 'map_slot', 'choose_response'].includes(action.kind)
}

type ImportedReviewReasonCode = 'foreign_import' | 'cognition_foreign_authority_blocked'

function isImportedReviewReasonCode(value: unknown): value is ImportedReviewReasonCode {
  return value === 'foreign_import' || value === 'cognition_foreign_authority_blocked'
}

function importedReviewItem(reasonCode: ImportedReviewReasonCode, acknowledged: boolean): AgentConfigRepairItem {
  return {
    id: `review:${reasonCode}`,
    kind: 'disabled_import',
    label: reasonCode,
    reasonCode,
    action: { kind: 'acknowledge' },
    acknowledged,
  }
}

export function getAgenticRuntimeRepairItems(preset: LoomPreset): AgentConfigRepairItem[] {
  const reviewValue: unknown = preset.agentConfigReview
  if (reviewValue === null || reviewValue === undefined || !isUnknownRecord(reviewValue)) return []

  const reviewState = reviewValue.state
  const stateIsKnown = reviewState === 'ready' || reviewState === 'review_required' || reviewState === 'repair_required'
  const reviewShapeIsValid = stateIsKnown
    && isNonNegativeSafeInteger(reviewValue.revision)
    && (reviewValue.reasonCode === null || typeof reviewValue.reasonCode === 'string')
    && isStringList(reviewValue.unresolvedSlotIds)
    && isStringList(reviewValue.staleSlotIds)
    && Array.isArray(reviewValue.items)
    && reviewValue.items.every((item) => isValidRepairItem(item))
  if (!reviewShapeIsValid || reviewState === 'ready') return []

  const importReason = isImportedReviewReasonCode(reviewValue.reasonCode)
    ? reviewValue.reasonCode
    : null
  const reviewItems = Array.isArray(reviewValue.items) ? reviewValue.items : []
  const importAcknowledged = importReason !== null && reviewItems.some((item) => (
    isValidRepairItem(item)
      && item.id === `review:${importReason}`
      && item.kind === 'disabled_import'
      && item.reasonCode === importReason
      && item.action.kind === 'acknowledge'
      && item.acknowledged === true
  ))
  const importItem = importReason === null ? null : importedReviewItem(importReason, importAcknowledged)
  // The import acknowledgement is reconstructed from trusted review provenance.
  // Never inherit a disabled-import row from a generic or malformed projection.
  const projected = reviewItems
    .filter((item): item is AgentConfigRepairItem => (
      isValidRepairItem(item) && item.kind !== 'disabled_import'
    ))
  const withInheritedImportReview = (items: AgentConfigRepairItem[]): AgentConfigRepairItem[] => {
    if (!importItem) return items
    return [...items, importItem]
  }
  if (projected.length > 0) return withInheritedImportReview(projected)

  const unresolvedSlotIds = isStringList(reviewValue.unresolvedSlotIds) ? reviewValue.unresolvedSlotIds : []
  const staleSlotIds = isStringList(reviewValue.staleSlotIds) ? reviewValue.staleSlotIds : []
  const items: AgentConfigRepairItem[] = []
  unresolvedSlotIds.forEach((slotId) => items.push({
    id: `slot:${slotId}`,
    kind: 'unresolved_slot',
    label: slotId,
    reasonCode: 'unresolved_slot',
    action: { kind: 'map_slot' },
    acknowledged: false,
  }))
  staleSlotIds.forEach((slotId) => items.push({
    id: `stale-slot:${slotId}`,
    kind: 'stale_slot',
    label: slotId,
    reasonCode: 'stale_slot',
    action: { kind: 'map_slot' },
    acknowledged: false,
  }))
  return withInheritedImportReview(items)
}

export function runtimeDraftFingerprint(draft: AgenticRuntimeSaveDraft): string {
  return JSON.stringify(draft)
}
