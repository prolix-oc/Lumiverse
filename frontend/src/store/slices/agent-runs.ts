import type { StateCreator } from 'zustand'
import type {
  AgentPersistentWorkspaceCollectionV1,
  AgentPersistentWorkspaceCollectionsStateV1,
  AppStore,
  AgentRunsSlice,
} from '@/types/store'
import type {
  AgentInspectionRecordActorV1,
  AgentInspectionRecordKindV1,
  AgentInspectionTranscriptRecordV1,
  AgentPromptDatabankSourceV1,
  AgentPromptEvidenceV1,
  AgentPromptNativeProvenanceV1,
  AgentRenderCrossingV1,
  AgentTurnSessionEntryV1,
  AgentWorkspaceAssociationV1,
  AgentInspectionProviderIdentityV1,
  AgentActivityNodeStatusV2,
  AgentActivityNodeV2,
  AgentActivityMilestoneV1,
  AgentActivityTreeV1,
  AgentCortexReceiptV1,
  AgentCouncilReceiptV1,
  AgentInspectionCapGateV1,
  AgentInspectionCorrelationV1,
  AgentInspectionErrorDetailV1,
  AgentInspectionLifecycleV1,
  AgentInspectionMarkerKindV1,
  AgentInspectionMarkerScopeV1,
  AgentInspectionMarkerV1,
  AgentInspectionReasonV1,
  AgentInspectionSectionAvailabilityV1,
  AgentInspectionSectionIdV1,
  AgentInspectionSectionStateV1,
  AgentInspectionSourceV1,
  AgentInspectionScopeV1,
  AgentInspectionUsageLayerV1,
  AgentInspectionUsageProjectionV1,
  AgentInspectionUsageV1,
  AgentOmissionMarkerV2,
  AgentPersistentWorkspaceArtifactV1,
  AgentPersistentWorkspacePublicationV1,
  AgentPersistentWorkspaceRecordV1,
  AgentRunInspectionStopV1,
  AgentPersistentWorkspaceStateV1,
  AgentPersistentWorkspaceSubmissionV1,
  AgentPersistentWorkspaceTaskV1,
  AgentPersistentWorkspaceTurnSessionPageV1,
  AgentPersistentWorkspaceTurnSessionV1,
  AgentPersistentWorkspaceV1,
  AgentRunChangeEventV2,
  AgentRunChangesV2,
  AgentRunGenerationTypeV2,
  AgentRunPhaseV2,
  AgentRunInspectionDetailV1,
  AgentRunInspectionListV1,
  AgentRunInspectionRetryResponseV1,
  AgentRunInspectionRetryV1,
  WorkSegmentInspectionProjectionV1,
  AgentRunInspectionSummaryV1,
  AgentRunOutcomeV2,
  AgentRunPublicErrorCodeV2,
  AgentRunPublicErrorV2,
  AgentRunPublicV2,
  AgentRunRecoveryActionV2,
  AgentRunResyncPageV1,
  AgentRunStatusV2,
  AgentRunStopResultV2,
  AgentRunTargetV2,
  AgentRunUsageV2,
  AgentWorkspaceEntryPreviewV2,
  AgentWorkspaceIndexPublicV2,
  AgentWorkspaceTaskPreviewV2,
  AgentWorkspaceSectionPreviewV2,
  AgentWorkspaceSectionV2,
  AgentWorkspaceRetentionV2,
  AgentWorkspaceVisibilityV2,
  AgentWorkAttemptLineageV1,
  AgentWorkTargetIdentityV1,
} from '@/types/agent-runs'
import {
  AGENTIC_PREDICATE_MAX_DEPTH,
  AGENTIC_PREDICATE_MAX_LIST_BYTES,
  AGENTIC_PREDICATE_MAX_LIST_ITEMS,
  AGENTIC_PREDICATE_MAX_NODES,
  AGENTIC_PREDICATE_MAX_STRING_BYTES,
  LOOM_RESPONSE_OMISSION_MAX_PHASE_INSTRUCTIONS,
} from '@/lib/loom/agenticRuntime'
import { isUnknownRecord } from '@/lib/type-guards'
import type { CognitionPredicate } from '@/lib/loom/types'
import type { LoomPromptInspectionItemV1, LoomPromptInspectionV1 } from '@/types/agent-runtime'

const RUN_PHASES: Record<AgentRunPhaseV2, true> = {
  ADMIT: true,
  ASSEMBLE: true,
  WORK: true,
  PREPARE_COMMIT: true,
  RENDER: true,
  COMMIT: true,
  TERMINAL: true,
}
const RUN_STATUSES: Record<AgentRunStatusV2, true> = {
  pending: true,
  running: true,
  waiting: true,
  cancelling: true,
  terminal: true,
}
const RUN_OUTCOMES: Record<AgentRunOutcomeV2, true> = {
  completed: true,
  stopped: true,
  failed: true,
  exhausted: true,
  rejected: true,
}
const GENERATION_TYPES: Record<AgentRunGenerationTypeV2, true> = {
  normal: true,
  continue: true,
  regenerate: true,
  swipe: true,
}
const NODE_KINDS: Record<AgentActivityNodeV2['kind'], true> = {
  root: true,
  provider: true,
  child: true,
  tool: true,
}
const NODE_STATUSES: Record<AgentActivityNodeStatusV2, true> = {
  pending: true,
  running: true,
  completed: true,
  failed: true,
  cancelled: true,
  timed_out: true,
  omitted: true,
}
const CONTINUATION_MODES: Record<NonNullable<AgentActivityNodeV2['continuationMode']>, true> = {
  ordinary: true,
  finalization: true,
  none: true,
}
const WORKSPACE_SECTIONS: Record<AgentWorkspaceSectionV2, true> = {
  objective: true,
  tasks: true,
  records: true,
  submissions: true,
  artifacts: true,
}
const WORKSPACE_RETENTIONS: Record<AgentWorkspaceRetentionV2, true> = {
  operational: true,
  turn_terminal: true,
  chat_lifetime: true,
}
const WORKSPACE_VISIBILITIES: Record<AgentWorkspaceVisibilityV2, true> = {
  owner: true,
  participants: true,
  public: true,
}
const WORKSPACE_TASK_STATES: Record<AgentWorkspaceTaskPreviewV2['state'], true> = {
  pending: true,
  active: true,
  blocked: true,
  completed: true,
  cancelled: true,
  failed: true,
}
const SAFE_TOOL_IDS: Record<string, true> = {
  lore_list_books: true,
  lore_get_book: true,
  lore_list_entries: true,
  lore_get_entry: true,
  lore_search_entries: true,
  chat_search_history: true,
  agent_delegate: true,
  workspace_read_section: true,
  workspace_read_page: true,
  workspace_create_task: true,
  workspace_update_progress: true,
  workspace_submit_result: true,
  workspace_submit_root_result: true,
  workspace_accept_submission: true,
  workspace_record_finding: true,
  workspace_record_decision: true,
  workspace_record_question: true,
  workspace_attach_artifact: true,
  workspace_propose_publication: true,
  unknown_tool: true,
  complete_turn: true,
}
const PUBLIC_ERROR_CODES = new Set<string>([
  'capacity_exceeded', 'host_child_admission_limit_exceeded', 'host_tool_call_limit_exceeded',
  'child_admission_limit_exceeded', 'tool_call_limit_exceeded', 'logical_provider_request_limit_exceeded',
  'physical_dispatch_attempt_limit_exceeded', 'child_output_token_limit_exceeded', 'root_wall_clock_limit_exceeded',
  'activity_event_limit_exceeded', 'activity_byte_limit_exceeded', 'lifecycle_log_record_limit_exceeded',
  'context_limit_exceeded', 'initial_input_limit_exceeded', 'argument_limit_exceeded', 'result_limit_exceeded',
  'continuation_limit_exceeded', 'retained_output_limit_exceeded', 'materialized_limit_exceeded', 'timeout',
  'cancelled', 'provider_unavailable', 'provider_unsupported', 'provider_tool_calling_unsupported',
  'provider_tool_continuation_unsupported', 'provider_tool_finalization_unsupported', 'provider_request_error',
  'provider_protocol_error', 'provider_schema_error', 'invalid_task', 'invalid_profile', 'invalid_input', 'invalid_arguments',
  'batch_rejected', 'unknown_tool', 'unauthorized', 'integrity_error', 'internal_error', 'not_found',
  'invalid_request', 'projection_unavailable', 'inspection_unavailable', 'workspace_unavailable',
  'stop_unavailable', 'retry_unavailable', 'target_mismatch', 'stale_target', 'resync_required',
  'recovery_unavailable', 'response_mode_required', 'decision_refresh_required', 'limit_exceeded', 'queue_full',
  'worker_disabled', 'worker_unavailable', 'worker_crashed', 'worker_timed_out', 'worker_malformed',
  'child_required_failed', 'child_output_limit_exceeded', 'agentic_protocol_failure',
])
const ERROR_CATEGORIES = new Set(['capacity', 'budget', 'context', 'integrity', 'timeout', 'cancelled', 'provider', 'validation', 'internal'])
const RECOVERY_ACTIONS: Record<AgentRunRecoveryActionV2, true> = {
  retry: true,
  repair: true,
  reselect: true,
  use_response: true,
  resync: true,
  none: true,
}
const TERMINAL_STATUSES: Record<AgentRunStatusV2, boolean> = {
  pending: false,
  running: false,
  waiting: false,
  cancelling: false,
  terminal: true,
}
const MAX_ACTIVITY_NODES = 128
const MAX_WORKSPACE_ENTRIES = 256
const MAX_ID_LENGTH = 256
const MAX_LABEL_LENGTH = 160
const MAX_CURSOR_LENGTH = 2_048
const MAX_WORKSPACE_COLLECTION_ITEMS = 256
const MAX_WORKSPACE_TEXT_LENGTH = 64 * 1024
const MAX_WORKSPACE_STRING_ARRAY_ITEMS = 256
const MAX_INSPECTION_RECORDS = 4_096
const MAX_RESYNC_RUNS_PER_PAGE = 16
const MAX_INSPECTION_LIST_RUNS = 64
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000
const MAX_DATE_SECONDS = Math.floor(MAX_DATE_MILLISECONDS / 1_000)
const UTF8_ENCODER = new TextEncoder()

function boundedString(value: unknown, maxLength = MAX_ID_LENGTH): string | null {
  return typeof value === 'string' && value.length > 0 && UTF8_ENCODER.encode(value).byteLength <= maxLength ? value : null
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
function dateTimestamp(value: unknown): number | null {
  const normalized = nonNegativeInteger(value)
  return normalized !== null && normalized <= MAX_DATE_MILLISECONDS ? normalized : null
}
function dateSeconds(value: unknown): number | null {
  const normalized = nonNegativeInteger(value)
  return normalized !== null && normalized <= MAX_DATE_SECONDS ? normalized : null
}
function nullableDateTimestamp(value: unknown): number | null | undefined {
  if (value === null) return null
  if (value === undefined) return undefined
  return dateTimestamp(value) ?? undefined
}
function isIndexedArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, String(index))) return false
  return true
}

function isRunPhase(value: unknown): value is AgentRunPhaseV2 {
  return typeof value === 'string' && Object.hasOwn(RUN_PHASES, value)
}

function isRunStatus(value: unknown): value is AgentRunStatusV2 {
  return typeof value === 'string' && Object.hasOwn(RUN_STATUSES, value)
}
function isRecoveryAction(value: unknown): value is AgentRunRecoveryActionV2 {
  return typeof value === 'string' && Object.hasOwn(RECOVERY_ACTIONS, value)
}
const INSPECTION_LIFECYCLES: Record<AgentInspectionLifecycleV1, true> = {
  ADMIT: true,
  ASSEMBLE: true,
  WORK: true,
  PREPARE_COMMIT: true,
  RENDER: true,
  COMMIT: true,
  TERMINAL: true,
}
const INSPECTION_REASONS: Record<AgentInspectionReasonV1, true> = {
  none: true,
  user_stop: true,
  deadline: true,
  provider_failure: true,
  tool_failure: true,
  required_work_failure: true,
  budget_exhausted: true,
  invalid_input: true,
  stale_input: true,
  unavailable: true,
  needs_attention: true,
  interrupted: true,
  retry_requested: true,
  reconciled: true,
  unknown: true,
}
function isInspectionLifecycle(value: unknown): value is AgentInspectionLifecycleV1 {
  return typeof value === 'string' && Object.hasOwn(INSPECTION_LIFECYCLES, value)
}
function isInspectionReason(value: unknown): value is AgentInspectionReasonV1 {
  return typeof value === 'string' && Object.hasOwn(INSPECTION_REASONS, value)
}
const INSPECTION_MARKER_KINDS: Record<AgentInspectionMarkerKindV1, true> = {
  reconnect_gap: true,
  late_event: true,
  reordered_event: true,
  truncated: true,
  unavailable: true,
  credentials_withheld: true,
  other_user_data_withheld: true,
  recovered_duplicate: true,
}
const INSPECTION_MARKER_SCOPES: Record<AgentInspectionMarkerScopeV1, true> = {
  run: true,
  activity: true,
  transcript: true,
  turn_session: true,
  usage: true,
  prompt: true,
  cortex: true,
  council: true,
  workspace: true,
}
const INSPECTION_AUTHORITIES: Record<AgentInspectionErrorDetailV1['authority'], true> = {
  host: true,
  preset: true,
  provider: true,
  owner: true,
  system: true,
  cortex: true,
  council: true,
}
const INSPECTION_SOURCES: Record<AgentInspectionSourceV1, true> = {
  execution: true,
  projection: true,
  provider: true,
  tool: true,
  host: true,
  recovery: true,
  cortex: true,
  council: true,
  unknown: true,
}
const INSPECTION_SCOPES: Record<AgentInspectionScopeV1, true> = {
  run: true,
  attempt: true,
  turn_session: true,
  target: true,
  phase: true,
  provider: true,
  tool: true,
  usage: true,
  transcript: true,
  cortex: true,
  council: true,
  workspace: true,
}
const ACTIVITY_MILESTONE_KINDS: Record<AgentActivityMilestoneV1['kind'], true> = {
  root: true,
  provider: true,
  child: true,
  tool: true,
  milestone: true,
}
const ACTIVITY_MILESTONE_ACTORS: Record<AgentActivityMilestoneV1['actor'], true> = {
  host: true,
  owner: true,
  provider: true,
  agent: true,
  child: true,
  tool: true,
  cortex: true,
  council: true,
}
const ACTIVITY_MILESTONE_STATUSES: Record<AgentActivityMilestoneV1['status'], true> = {
  pending: true,
  running: true,
  waiting: true,
  cancelling: true,
  terminal: true,
  omitted: true,
}
const ACTIVITY_RECONCILIATIONS: Record<AgentActivityTreeV1['reconciliation'], true> = {
  authoritative: true,
  reconciling: true,
  recovered: true,
  stale: true,
}
function nullableBoundedString(value: unknown, maxLength = MAX_ID_LENGTH): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const normalized = boundedString(value, maxLength)
  return normalized === null ? undefined : normalized
}
function nullableNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const normalized = nonNegativeInteger(value)
  return normalized === null ? undefined : normalized
}
const TRANSCRIPT_KINDS: Record<AgentInspectionRecordKindV1, true> = {
  prompt: true,
  provider_exchange: true,
  agent_exchange: true,
  delegation: true,
  child_result: true,
  tool: true,
  condition: true,
  checkpoint: true,
  task: true,
  workspace: true,
  hook: true,
  usage: true,
  failure: true,
  terminal: true,
  stop: true,
  recovery: true,
  milestone: true,
}
const TRANSCRIPT_ACTORS: Record<AgentInspectionRecordActorV1, true> = {
  host: true,
  owner: true,
  provider: true,
  agent: true,
  child: true,
  tool: true,
  cortex: true,
  council: true,
}
const TURN_SESSION_KINDS: Record<AgentTurnSessionEntryV1['kind'], true> = {
  target: true,
  input: true,
  policy: true,
  condition: true,
  hook: true,
  cancellation: true,
  completion: true,
  commit: true,
  terminal: true,
  retry: true,
  recovery: true,
}
const PROMPT_DESTINATIONS: Record<AgentPromptEvidenceV1['destination'], true> = {
  root_work: true,
  child_work: true,
  completion_handoff: true,
  render: true,
  council: true,
  cortex: true,
}
const PROMPT_ROLES: Record<AgentPromptEvidenceV1['role'], true> = {
  system: true,
  user: true,
  assistant: true,
  tool: true,
  context: true,
  policy: true,
}
const CORTEX_STATES: Record<AgentCortexReceiptV1['state'], true> = {
  accepted: true,
  omitted: true,
  failed: true,
  cancelled: true,
}
const CORTEX_OMISSION_REASONS: Record<NonNullable<AgentCortexReceiptV1['omission']>['reason'], true> = {
  stale: true,
  unauthorized: true,
  unavailable: true,
  cancelled: true,
  failed: true,
  limit_exceeded: true,
  snapshot_mismatch: true,
}
const WORKSPACE_ASSOCIATION_KINDS: Record<AgentWorkspaceAssociationV1['objectKind'], true> = {
  objective: true,
  task: true,
  finding: true,
  decision: true,
  question: true,
  submission: true,
  artifact: true,
  publication: true,
}
const WORKSPACE_ASSOCIATION_RELATIONS: Record<AgentWorkspaceAssociationV1['relation'], true> = {
  linked: true,
  published: true,
  omitted: true,
}
function isOwn<T extends string>(values: Record<T, true>, value: unknown): value is T {
  return typeof value === 'string' && Object.hasOwn(values, value)
}
function normalizeInspectionCorrelation(value: unknown): AgentInspectionCorrelationV1 | null {
  if (!isUnknownRecord(value)) return null
  const turnSessionId = boundedString(value.turnSessionId)
  const runId = boundedString(value.runId)
  const attemptId = boundedString(value.attemptId)
  const chatId = boundedString(value.chatId)
  const generationId = boundedString(value.generationId)
  const messageId = nullableBoundedString(value.messageId)
  const swipeId = nullableNonNegativeInteger(value.swipeId)
  const actorId = nullableBoundedString(value.actorId)
  const recipientId = nullableBoundedString(value.recipientId)
  const phase = isInspectionLifecycle(value.phase) ? value.phase : null
  const taskId = nullableBoundedString(value.taskId)
  const toolId = nullableBoundedString(value.toolId)
  const parentId = nullableBoundedString(value.parentId)
  const hostCorrelationId = boundedString(value.hostCorrelationId)
  const hostSequence = nonNegativeInteger(value.hostSequence)
  if (!turnSessionId || !runId || !attemptId || !chatId || !generationId || messageId === undefined || swipeId === undefined || actorId === undefined || recipientId === undefined || !phase || taskId === undefined || toolId === undefined || parentId === undefined || !hostCorrelationId || hostSequence === null) return null
  return { turnSessionId, runId, attemptId, chatId, generationId, messageId, swipeId, actorId, recipientId, phase, taskId, toolId, parentId, hostCorrelationId, hostSequence }
}
function normalizeInspectionMarker(value: unknown): AgentInspectionMarkerV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const id = boundedString(value.id)
  const kind = isOwn(INSPECTION_MARKER_KINDS, value.kind) ? value.kind : null
  const scope = isOwn(INSPECTION_MARKER_SCOPES, value.scope) ? value.scope : null
  const correlation = value.correlation === null ? null : normalizeInspectionCorrelation(value.correlation)
  const firstSequence = nullableNonNegativeInteger(value.firstSequence)
  const lastSequence = nullableNonNegativeInteger(value.lastSequence)
  const recoverable = value.recoverable === null ? null : typeof value.recoverable === 'boolean' ? value.recoverable : undefined
  const detail = value.detail === null ? null : typeof value.detail === 'string' ? value.detail : undefined
  if (!id || !kind || !scope || correlation === null && value.correlation !== null || firstSequence === undefined || lastSequence === undefined || recoverable === undefined || detail === undefined) return null
  return { version: 1, id, kind, scope, correlation, firstSequence, lastSequence, recoverable, detail }
}
function normalizeActivityMilestone(value: unknown): AgentActivityMilestoneV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const id = boundedString(value.id)
  const parentId = nullableBoundedString(value.parentId)
  const kind = isOwn(ACTIVITY_MILESTONE_KINDS, value.kind) ? value.kind : null
  const actor = isOwn(ACTIVITY_MILESTONE_ACTORS, value.actor) ? value.actor : null
  const phase = isInspectionLifecycle(value.phase) ? value.phase : null
  const status = isOwn(ACTIVITY_MILESTONE_STATUSES, value.status) ? value.status : null
  const label = typeof value.label === 'string' ? value.label : null
  const toolId = nullableBoundedString(value.toolId)
  const taskId = nullableBoundedString(value.taskId)
  const sequence = nonNegativeInteger(value.sequence)
  const startedAt = dateTimestamp(value.startedAt)
  const endedAt = nullableDateTimestamp(value.endedAt)
  const elapsedMs = nullableNonNegativeInteger(value.elapsedMs)
  const usage = value.usage === null ? null : normalizeInspectionUsageEvidence(value.usage)
  const correlation = normalizeInspectionCorrelation(value.correlation)
  if (!id || parentId === undefined || !kind || !actor || !phase || !status || !label || toolId === undefined || taskId === undefined || sequence === null || startedAt === null || endedAt === undefined || elapsedMs === undefined || usage === null && value.usage !== null || !correlation) return null
  return { version: 1, id, parentId, kind, actor, phase, status, label, toolId, taskId, sequence, startedAt, endedAt, elapsedMs, usage, correlation }
}
function normalizeActivityTree(value: unknown): AgentActivityTreeV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1 || !isIndexedArray(value.milestones) || !isIndexedArray(value.markers)) return null
  const attempt = normalizeAttempt(value.attempt)
  const lifecycle = isInspectionLifecycle(value.lifecycle) ? value.lifecycle : null
  const status = isRunStatus(value.status) ? value.status : null
  const outcome = value.outcome === null ? null : isRunOutcome(value.outcome) ? value.outcome : undefined
  const reason = isInspectionReason(value.reason) ? value.reason : null
  const revision = nonNegativeInteger(value.revision)
  const startedAt = dateTimestamp(value.startedAt)
  const updatedAt = dateTimestamp(value.updatedAt)
  const terminalAt = nullableDateTimestamp(value.terminalAt)
  const target = normalizeTarget(value.target)
  const usage = normalizeUsage(value.usage)
  const reconciliation = isOwn(ACTIVITY_RECONCILIATIONS, value.reconciliation) ? value.reconciliation : null
  const milestones = value.milestones.map(normalizeActivityMilestone)
  const markers = value.markers.map(normalizeInspectionMarker)
  if (!attempt || !lifecycle || !status || outcome === undefined || !reason || revision === null || startedAt === null || updatedAt === null || terminalAt === undefined || target === undefined || !usage || !reconciliation || milestones.some((item) => item === null) || markers.some((item) => item === null)) return null
  return { version: 1, attempt, lifecycle, status, outcome, reason, revision, startedAt, updatedAt, terminalAt, target, milestones: milestones.filter((item): item is AgentActivityMilestoneV1 => item !== null), usage, markers: markers.filter((item): item is AgentInspectionMarkerV1 => item !== null), reconciliation }
}
const INSPECTION_STOP_STATES: Record<AgentRunInspectionStopV1['state'], true> = {
  accepted: true,
  too_late: true,
  terminal: true,
  failed: true,
  reconciled: true,
}

function isGenerationType(value: unknown): value is AgentRunGenerationTypeV2 {
  return typeof value === 'string' && Object.hasOwn(GENERATION_TYPES, value)
}

function isPublicErrorCode(value: unknown): value is AgentRunPublicErrorCodeV2 {
  return typeof value === 'string' && PUBLIC_ERROR_CODES.has(value)
}

function normalizeUsage(value: unknown): AgentRunUsageV2 | null {
  if (!isUnknownRecord(value)) return null
  const inputTokens = nonNegativeInteger(value.inputTokens)
  const outputTokens = nonNegativeInteger(value.outputTokens)
  const totalTokens = nonNegativeInteger(value.totalTokens)
  const toolCalls = nonNegativeInteger(value.toolCalls)
  const childInvocations = nonNegativeInteger(value.childInvocations)
  if ([inputTokens, outputTokens, totalTokens, toolCalls, childInvocations].some((item) => item === null)) return null
  return { inputTokens, outputTokens, totalTokens, toolCalls, childInvocations }
}

function normalizeOmission(value: unknown): AgentOmissionMarkerV2 | null {
  if (!isUnknownRecord(value)) return null
  const omittedNodeCount = nonNegativeInteger(value.omittedNodeCount)
  const omittedEventCount = nonNegativeInteger(value.omittedEventCount)
  const firstOmittedSequence = value.firstOmittedSequence === null ? null : nonNegativeInteger(value.firstOmittedSequence)
  const lastOmittedSequence = value.lastOmittedSequence === null ? null : nonNegativeInteger(value.lastOmittedSequence)
  if (
    omittedNodeCount === null || omittedEventCount === null
    || firstOmittedSequence === null && value.firstOmittedSequence !== null
    || lastOmittedSequence === null && value.lastOmittedSequence !== null
  ) return null
  return { omittedNodeCount, omittedEventCount, firstOmittedSequence, lastOmittedSequence }
}

function normalizeTarget(value: unknown): AgentRunTargetV2 | null | undefined {
  if (value === null) return null
  if (!isUnknownRecord(value)) return undefined
  const messageId = boundedString(value.messageId)
  const swipeId = nonNegativeInteger(value.swipeId)
  return messageId && swipeId !== null ? { messageId, swipeId } : undefined
}

function normalizeWorkTarget(value: unknown): AgentWorkTargetIdentityV1 | null {
  if (!isUnknownRecord(value)) return null
  const chatId = boundedString(value.chatId)
  const generationType = isGenerationType(value.generationType) ? value.generationType : null
  const messageId = value.messageId === null ? null : boundedString(value.messageId)
  const swipeId = value.swipeId === null ? null : nonNegativeInteger(value.swipeId)
  if (!chatId || !generationType || messageId === null && value.messageId !== null || swipeId === null && value.swipeId !== null
    || messageId === null && swipeId !== null) return null
  return { chatId, generationType, messageId, swipeId }
}

function normalizeAttempt(value: unknown): AgentWorkAttemptLineageV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const attemptId = boundedString(value.attemptId)
  const previousAttemptId = value.previousAttemptId === null ? null : boundedString(value.previousAttemptId)
  const target = normalizeWorkTarget(value.target)
  const createdAt = dateTimestamp(value.createdAt)
  if (!attemptId || !target || createdAt === null || previousAttemptId === null && value.previousAttemptId !== null) return null
  return { version: 1, attemptId, previousAttemptId, target, createdAt }
}
function sameWorkTarget(left: AgentWorkTargetIdentityV1, right: AgentWorkTargetIdentityV1): boolean {
  return left.chatId === right.chatId
    && left.generationType === right.generationType
    && left.messageId === right.messageId
    && left.swipeId === right.swipeId
}
function sameActivityTarget(left: AgentRunTargetV2, right: AgentWorkTargetIdentityV1): boolean {
  return (left?.messageId ?? null) === right.messageId
    && (left?.swipeId ?? null) === (right.swipeId ?? null)
}
function sameSummaryTarget(left: AgentRunTargetV2 | null, right: AgentWorkTargetIdentityV1): boolean {
  if (right.messageId === null) return left === null
  return left !== null
    && left.messageId === right.messageId
    && left.swipeId === (right.swipeId ?? 0)
}
function sameAttemptIdentity(left: AgentWorkAttemptLineageV1, right: AgentWorkAttemptLineageV1): boolean {
  return left.attemptId === right.attemptId
    && left.previousAttemptId === right.previousAttemptId
    && left.createdAt === right.createdAt
    && sameWorkTarget(left.target, right.target)
}
function sameInspectionCorrelationIdentity(
  correlation: AgentInspectionCorrelationV1,
  summary: AgentRunInspectionSummaryV1,
): boolean {
  return correlation.attemptId === summary.attempt.attemptId
    && correlation.chatId === summary.attempt.target.chatId
    && correlation.turnSessionId === summary.turnSessionId
    && correlation.runId === summary.runId
    && correlation.generationId === summary.generationId
    && correlation.hostCorrelationId === summary.hostCorrelationId
    && correlation.messageId === summary.attempt.target.messageId
    && correlation.swipeId === summary.attempt.target.swipeId
}

function normalizeError(value: unknown): AgentRunPublicErrorV2 | undefined {
  if (!isUnknownRecord(value)) return undefined
  const publicCode = isPublicErrorCode(value.code) ? value.code : null
  const knownCode = publicCode !== null
  const code: AgentRunPublicErrorCodeV2 = publicCode ?? 'internal_error'
  const category = knownCode
    ? (typeof value.category === 'string' && ERROR_CATEGORIES.has(value.category)
      ? value.category as AgentRunPublicErrorV2['category']
      : null)
    : 'internal'
  const summaryCode = knownCode
    ? boundedString(value.summaryCode, MAX_LABEL_LENGTH)
    : 'internal_error'
  const recoveryAction = isRecoveryAction(value.recoveryAction) ? value.recoveryAction : null
  const target = value.target === null ? null : normalizeWorkTarget(value.target)
  const workPhase = isRunPhase(value.workPhase) ? value.workPhase : null
  const workStatus = isRunStatus(value.workStatus) ? value.workStatus : null
  const workOutcome = value.workOutcome === null ? null : isRunOutcome(value.workOutcome) ? value.workOutcome : undefined
  const omissionCount = nonNegativeInteger(value.omissionCount)
  const inspectionAttemptId = value.inspectionAttemptId === null ? null : boundedString(value.inspectionAttemptId)
  const reason = value.reason === null ? null : boundedString(value.reason, MAX_LABEL_LENGTH)
  if (
    !code || !category || !summaryCode || typeof value.recoveryEligible !== 'boolean' || !recoveryAction
    || target === null && value.target !== null || !workPhase || !workStatus || workOutcome === undefined
    || omissionCount === null || inspectionAttemptId === null && value.inspectionAttemptId !== null
    || reason === null && value.reason !== null
  ) return undefined
  return {
    code,
    category,
    summaryCode,
    recoveryEligible: value.recoveryEligible,
    recoveryAction,
    target,
    workPhase,
    workStatus,
    workOutcome,
    reason,
    omissionCount,
    inspectionAttemptId,
  }
}

function isInspectionErrorCategory(value: unknown): value is AgentInspectionErrorDetailV1['category'] {
  return typeof value === 'string' && ERROR_CATEGORIES.has(value)
}
function normalizeInspectionCapGate(value: unknown): AgentInspectionCapGateV1 | null | undefined {
  if (value === null) return null
  if (!isUnknownRecord(value)) return undefined
  const id = boundedString(value.id)
  const limit = nullableNonNegativeInteger(value.limit)
  const observed = nullableNonNegativeInteger(value.observed)
  const authority = isOwn(INSPECTION_AUTHORITIES, value.authority) ? value.authority : null
  const source = isOwn(INSPECTION_SOURCES, value.source) ? value.source : null
  if (!id || limit === undefined || observed === undefined || !authority || !source || typeof value.exceeded !== 'boolean') return undefined
  return { id, limit, observed, exceeded: value.exceeded, authority, source }
}
function normalizeInspectionErrorDetail(value: unknown): AgentInspectionErrorDetailV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const inspectionAttemptId = boundedString(value.inspectionAttemptId)
  const code = typeof value.code === 'string' ? value.code : null
  const category = isInspectionErrorCategory(value.category) ? value.category : null
  const summaryCode = boundedString(value.summaryCode, MAX_LABEL_LENGTH)
  const causalCode = value.causalCode === null ? null : typeof value.causalCode === 'string' ? value.causalCode : undefined
  const authority = isOwn(INSPECTION_AUTHORITIES, value.authority) ? value.authority : null
  const source = isOwn(INSPECTION_SOURCES, value.source) ? value.source : null
  const scope = isOwn(INSPECTION_SCOPES, value.scope) ? value.scope : null
  const capGate = normalizeInspectionCapGate(value.capGate)
  const target = normalizeWorkTarget(value.target)
  const workPhase = isRunPhase(value.workPhase) ? value.workPhase : null
  const workStatus = isRunStatus(value.workStatus) ? value.workStatus : null
  const workOutcome = value.workOutcome === null ? null : isRunOutcome(value.workOutcome) ? value.workOutcome : undefined
  const reason = value.reason === null ? null : typeof value.reason === 'string' ? value.reason : undefined
  const recoveryAction = isRecoveryAction(value.recoveryAction) ? value.recoveryAction : null
  const omissionCount = nonNegativeInteger(value.omissionCount)
  if (!inspectionAttemptId || code === null || !category || !summaryCode || causalCode === undefined || !authority || !source || !scope || capGate === undefined || !target || !workPhase || !workStatus || workOutcome === undefined || reason === undefined || typeof value.recoveryEligible !== 'boolean' || !recoveryAction || omissionCount === null) return null
  return { version: 1, inspectionAttemptId, code, category, summaryCode, causalCode, authority, source, scope, capGate, target, workPhase, workStatus, workOutcome, reason, recoveryEligible: value.recoveryEligible, recoveryAction, omissionCount }
}
function normalizeInspectionStop(value: unknown): AgentRunInspectionStopV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const state = isOwn(INSPECTION_STOP_STATES, value.state) ? value.state : null
  const requestedAt = dateTimestamp(value.requestedAt)
  const receiptAt = nullableDateTimestamp(value.receiptAt)
  const correlation = normalizeInspectionCorrelation(value.correlation)
  const reason = isInspectionReason(value.reason) ? value.reason : null
  if (!state || requestedAt === null || receiptAt === undefined || !correlation || !reason) return null
  return { version: 1, state, requestedAt, receiptAt, correlation, reason }
}
function normalizeActivityNode(value: unknown): AgentActivityNodeV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2) return null
  const id = boundedString(value.id)
  const parentId = value.parentId === null ? null : boundedString(value.parentId)
  const kind = typeof value.kind === 'string' && Object.hasOwn(NODE_KINDS, value.kind) ? value.kind as AgentActivityNodeV2['kind'] : null
  const actor = typeof value.actor === 'string' && Object.hasOwn(NODE_KINDS, value.actor) ? value.actor as AgentActivityNodeV2['actor'] : null
  const phase = isRunPhase(value.phase) ? value.phase : null
  const status = typeof value.status === 'string' && Object.hasOwn(NODE_STATUSES, value.status) ? value.status as AgentActivityNodeStatusV2 : null
  const startedAt = dateTimestamp(value.startedAt)
  const elapsedMs = nonNegativeInteger(value.elapsedMs)
  const profileId = value.profileId === undefined ? undefined : boundedString(value.profileId, 128)
  const toolId = value.toolId === undefined
    ? undefined
    : typeof value.toolId === 'string'
      ? Object.hasOwn(SAFE_TOOL_IDS, value.toolId) ? value.toolId : 'unknown_tool'
      : null
  const roundIndex = value.roundIndex === undefined ? undefined : nonNegativeInteger(value.roundIndex)
  const continuationMode = value.continuationMode === undefined
    ? undefined
    : typeof value.continuationMode === 'string' && Object.hasOwn(CONTINUATION_MODES, value.continuationMode)
      ? value.continuationMode as AgentActivityNodeV2['continuationMode']
      : null
  const usage = value.usage === undefined ? undefined : normalizeUsage(value.usage)
  const errorCode = isPublicErrorCode(value.errorCode) ? value.errorCode : undefined
  if (
    !id || parentId === null && value.parentId !== null || !kind || !actor || !phase || !status
    || startedAt === null || elapsedMs === null || profileId === null || toolId === null
    || roundIndex === null || continuationMode === null
    || value.usage !== undefined && usage === null
  ) return null
  const node: AgentActivityNodeV2 = { version: 2, id, parentId, kind, actor, phase, status, startedAt, elapsedMs }
  if (profileId !== undefined) node.profileId = profileId
  if (toolId !== undefined) node.toolId = toolId
  if (roundIndex !== undefined) node.roundIndex = roundIndex
  if (continuationMode !== undefined) node.continuationMode = continuationMode
  if (usage) node.usage = usage
  if (errorCode !== undefined) node.errorCode = errorCode
  return node
}

function normalizeHandoff(value: unknown): AgentRunPublicV2['terminalHandoff'] {
  if (!isUnknownRecord(value) || value.version !== 2 || typeof value.committed !== 'boolean') return undefined
  const messageId = value.messageId === null ? null : boundedString(value.messageId)
  const swipeId = value.swipeId === null ? null : nonNegativeInteger(value.swipeId)
  const messageRevision = value.messageRevision === null ? null : nonNegativeInteger(value.messageRevision)
  const swipeRevision = value.swipeRevision === null ? null : nonNegativeInteger(value.swipeRevision)
  if (messageId === null && value.messageId !== null || swipeId === null && value.swipeId !== null || messageRevision === null && value.messageRevision !== null || swipeRevision === null && value.swipeRevision !== null) return undefined
  return { version: 2, committed: value.committed, messageId, swipeId, messageRevision, swipeRevision }
}
export function normalizeAgentRunStopResultV2(
  value: unknown,
  expectedTurnId?: string,
  expectedChatId?: string,
  expectedGenerationId?: string,
): AgentRunStopResultV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2) return null
  const status = value.status === 'accepted' || value.status === 'too_late' || value.status === 'terminal' ? value.status : null
  const turnId = boundedString(value.turnId)
  const revision = nonNegativeInteger(value.revision)
  const target = normalizeWorkTarget(value.target)
  const reason = value.reason === undefined ? undefined : value.reason === null ? null : boundedString(value.reason, MAX_LABEL_LENGTH)
  const recoveryAction = isRecoveryAction(value.recoveryAction) ? value.recoveryAction : null
  const workPhase = isRunPhase(value.workPhase) ? value.workPhase : null
  const workStatus = isRunStatus(value.workStatus) ? value.workStatus : null
  const workOutcome = value.workOutcome === null ? null : isRunOutcome(value.workOutcome) ? value.workOutcome : undefined
  const omissionCount = nonNegativeInteger(value.omissionCount)
  const inspectionAttemptId = boundedString(value.inspectionAttemptId)
  const error = value.error === undefined ? undefined : normalizeError(value.error)
  const responseGenerationId = value.generationId === undefined ? undefined : boundedString(value.generationId)
  const statusCoherent = status !== 'terminal'
    || workPhase === 'TERMINAL' && workStatus === 'terminal' && workOutcome !== null
  const errorCoherent = error === undefined || (
    error.target !== null
    && target !== null
    && sameWorkTarget(error.target, target)
    && error.workPhase === workPhase
    && error.workStatus === workStatus
    && error.workOutcome === workOutcome
    && error.reason === reason
    && error.recoveryEligible === value.recoveryEligible
    && error.recoveryAction === recoveryAction
    && error.omissionCount === omissionCount
    && error.inspectionAttemptId === inspectionAttemptId
  )
  if (
    !status || !turnId || revision === null || !target || !workPhase || !workStatus || workOutcome === undefined
    || reason === undefined || typeof value.recoveryEligible !== 'boolean' || !recoveryAction
    || omissionCount === null || !inspectionAttemptId || !statusCoherent
    || value.error !== undefined && !error
    || responseGenerationId === null
    || expectedTurnId !== undefined && turnId !== expectedTurnId
    || expectedChatId !== undefined && target.chatId !== expectedChatId
    || expectedGenerationId !== undefined && (responseGenerationId === undefined || responseGenerationId !== expectedGenerationId)
    || !errorCoherent
  ) return null
  return {
    version: 2,
    status,
    turnId,
    revision,
    target,
    workPhase,
    workStatus,
    workOutcome,
    reason,
    recoveryEligible: value.recoveryEligible,
    recoveryAction,
    omissionCount,
    inspectionAttemptId,
    ...(error ? { error } : {}),
  }
}

export function normalizeAgentRunPublicV2(value: unknown): AgentRunPublicV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2) return null
  const runId = boundedString(value.runId)
  const turnId = boundedString(value.turnId)
  const generationId = boundedString(value.generationId)
  const chatId = boundedString(value.chatId)
  const generationType = isGenerationType(value.generationType) ? value.generationType : null
  const target = normalizeTarget(value.target)
  const workPhase = isRunPhase(value.workPhase) ? value.workPhase : null
  const workStatus = isRunStatus(value.workStatus) ? value.workStatus : null
  const workOutcome = value.workOutcome === null ? null : isRunOutcome(value.workOutcome) ? value.workOutcome : undefined
  const revision = nonNegativeInteger(value.revision)
  const sequence = nonNegativeInteger(value.sequence)
  const startedAt = dateTimestamp(value.startedAt)
  const updatedAt = dateTimestamp(value.updatedAt)
  const omissionCount = nonNegativeInteger(value.omissionCount)
  const inspectionAttemptId = boundedString(value.inspectionAttemptId)
  const attemptLineage = normalizeAttempt(value.attemptLineage)
  const usage = normalizeUsage(value.usage)
  const omission = normalizeOmission(value.omission)
  const recoveryAction = isRecoveryAction(value.recoveryAction) ? value.recoveryAction : null
  const reason = value.reason === null ? null : typeof value.reason === 'string' ? value.reason : undefined
  if (
    !runId || !turnId || !generationId || !chatId || !generationType || target === undefined || !workPhase || !workStatus
    || workOutcome === undefined || revision === null || sequence === null || startedAt === null || updatedAt === null || omissionCount === null
    || !inspectionAttemptId || !attemptLineage || !usage || !omission || !isIndexedArray(value.activity)
    || typeof value.recoveryEligible !== 'boolean' || !recoveryAction || reason === undefined
    || attemptLineage.attemptId !== inspectionAttemptId
    || attemptLineage.target.chatId !== chatId
    || attemptLineage.target.generationType !== generationType
    || attemptLineage.target.messageId !== (target?.messageId ?? null)
    || attemptLineage.target.swipeId !== (target?.swipeId ?? null)
  ) return null
  const normalizedActivity = value.activity.map(normalizeActivityNode)
  const activity = normalizedActivity.filter((node): node is AgentActivityNodeV2 => node !== null)
  if (activity.length !== normalizedActivity.length) return null
  const boundedActivity = activity.slice(0, MAX_ACTIVITY_NODES)
  const run: AgentRunPublicV2 = {
    version: 2,
    runId,
    turnId,
    generationId,
    chatId,
    generationType,
    target,
    workPhase,
    workStatus,
    workOutcome,
    recoveryEligible: value.recoveryEligible,
    recoveryAction,
    omissionCount,
    inspectionAttemptId,
    reason,
    attemptLineage,
    revision,
    sequence,
    startedAt,
    updatedAt,
    activity: boundedActivity,
    usage,
    omission: { ...omission, omittedNodeCount: omission.omittedNodeCount + value.activity.length - boundedActivity.length },
  }
  const error = normalizeError(value.error)
  if (value.error !== undefined && !error) return null
  if (error) run.error = error
  const terminalHandoff = normalizeHandoff(value.terminalHandoff)
  if (value.terminalHandoff !== undefined && !terminalHandoff) return null
  if (terminalHandoff) run.terminalHandoff = terminalHandoff
  return run
}

export function normalizeAgentRunChangeEventV2(value: unknown): AgentRunChangeEventV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2) return null
  const chatId = boundedString(value.chatId)
  const sequence = nonNegativeInteger(value.sequence)
  const run = normalizeAgentRunPublicV2(value.run)
  const omission = normalizeOmission(value.omission)
  if (!chatId || sequence === null || !run || !omission || run.chatId !== chatId || run.sequence !== sequence) return null
  return { version: 2, chatId, sequence, run, omission }
}

function resyncRunIdentityKeys(run: AgentRunPublicV2): readonly string[] {
  return [`run:${run.runId}`, `turn:${run.turnId}`, `attempt:${run.inspectionAttemptId}`]
}
function hasDuplicateResyncRunIdentities(runs: readonly AgentRunPublicV2[]): boolean {
  const seen = new Set<string>()
  for (const run of runs) {
    for (const key of resyncRunIdentityKeys(run)) {
      if (seen.has(key)) return true
      seen.add(key)
    }
  }
  return false
}
function resyncRunIdentityRecord(runs: readonly AgentRunPublicV2[]): Record<string, true> {
  const identities: Record<string, true> = {}
  for (const run of runs) {
    for (const key of resyncRunIdentityKeys(run)) identities[key] = true
  }
  return identities
}

function normalizeResyncPage(value: unknown): AgentRunResyncPageV1 | undefined {
  if (!isUnknownRecord(value)) return undefined
  const offset = nonNegativeInteger(value.offset)
  const returnedRuns = nonNegativeInteger(value.returnedRuns)
  const totalRuns = nonNegativeInteger(value.totalRuns)
  const snapshotSequence = nonNegativeInteger(value.snapshotSequence)
  const omittedRuns = nonNegativeInteger(value.omittedRuns)
  const omittedOlderRuns = nonNegativeInteger(value.omittedOlderRuns)
  if (
    offset === null
    || returnedRuns === null
    || totalRuns === null
    || snapshotSequence === null
    || omittedRuns === null
    || omittedOlderRuns === null
    || totalRuns > 256
    || typeof value.complete !== 'boolean'
    || returnedRuns > MAX_RESYNC_RUNS_PER_PAGE
    || offset > totalRuns
    || returnedRuns > totalRuns - offset
    || omittedRuns !== totalRuns - offset - returnedRuns
    || value.complete !== (omittedRuns === 0)
  ) return undefined
  return { offset, returnedRuns, totalRuns, snapshotSequence, complete: value.complete, omittedRuns, omittedOlderRuns }
}

export function normalizeAgentRunChangesV2(value: unknown): AgentRunChangesV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2 || !isUnknownRecord(value.cursor) || value.cursor.version !== 1) return null
  const chatId = boundedString(value.chatId)
  const token = boundedString(value.cursor.token, MAX_CURSOR_LENGTH)
  const lastSequence = nonNegativeInteger(value.lastSequence)
  const cursorSequence = nonNegativeInteger(value.cursorSequence)
  const tailSequence = nonNegativeInteger(value.tailSequence)
  const omission = normalizeOmission(value.omission)
  const resyncPage = value.resyncPage === undefined ? undefined : normalizeResyncPage(value.resyncPage)
  if (
    !chatId
    || !token
    || lastSequence === null
    || cursorSequence === null
    || tailSequence === null
    || lastSequence !== cursorSequence
    || tailSequence < lastSequence
    || typeof value.hasMore !== 'boolean'
    || typeof value.resync !== 'boolean'
    || value.resync !== (resyncPage !== undefined)
    || value.resyncPage !== undefined && !resyncPage
    || !isIndexedArray(value.runs)
    || !isIndexedArray(value.events)
    || !omission
  ) return null
  const runs = value.runs.map(normalizeAgentRunPublicV2).filter((run): run is AgentRunPublicV2 => run !== null)
  const events = value.events.map(normalizeAgentRunChangeEventV2).filter((event): event is AgentRunChangeEventV2 => event !== null)
  if (runs.length !== value.runs.length || events.length !== value.events.length) return null
  if (runs.some((run) => run.chatId !== chatId) || events.some((event) => event.chatId !== chatId)) return null
  if (resyncPage !== undefined && (
    events.length !== 0
    || hasDuplicateResyncRunIdentities(runs)
    || resyncPage.snapshotSequence !== cursorSequence
    || resyncPage.snapshotSequence > tailSequence
    || resyncPage.returnedRuns !== runs.length
    || resyncPage.complete === false && resyncPage.returnedRuns !== Math.min(MAX_RESYNC_RUNS_PER_PAGE, resyncPage.totalRuns - resyncPage.offset)
    || value.hasMore !== (!resyncPage.complete || resyncPage.snapshotSequence < tailSequence)
  )) return null
  return { version: 2, chatId, cursor: { version: 1, token }, cursorSequence, lastSequence, tailSequence, hasMore: value.hasMore, resync: value.resync, ...(resyncPage ? { resyncPage } : {}), runs, events, omission }
}

function normalizeWorkspaceRetention(value: unknown): AgentWorkspaceRetentionV2 | null {
  return typeof value === 'string' && Object.hasOwn(WORKSPACE_RETENTIONS, value) ? value as AgentWorkspaceRetentionV2 : null
}
function normalizeWorkspaceVisibility(value: unknown): AgentWorkspaceVisibilityV2 | null {
  return typeof value === 'string' && Object.hasOwn(WORKSPACE_VISIBILITIES, value) ? value as AgentWorkspaceVisibilityV2 : null
}

export function normalizeAgentWorkspaceIndexV2(value: unknown): AgentWorkspaceIndexPublicV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2 || !Array.isArray(value.sections)) return null
  const turnId = boundedString(value.turnId)
  const workspaceRevision = nonNegativeInteger(value.workspaceRevision)
  const omitted = nonNegativeInteger(value.omitted)
  if (!turnId || workspaceRevision === null || omitted === null) return null
  const sections: AgentWorkspaceIndexPublicV2['sections'] = []
  const seen = new Set<AgentWorkspaceSectionV2>()
  for (const raw of value.sections) {
    if (!isUnknownRecord(raw) || typeof raw.section !== 'string' || !Object.hasOwn(WORKSPACE_SECTIONS, raw.section)) return null
    const section = raw.section as AgentWorkspaceSectionV2
    const count = nonNegativeInteger(raw.count)
    const revision = nonNegativeInteger(raw.revision)
    const retention = normalizeWorkspaceRetention(raw.retention)
    const visibility = normalizeWorkspaceVisibility(raw.visibility)
    if (seen.has(section) || count === null || revision === null || !retention || !visibility) return null
    seen.add(section)
    sections.push({ section, count, revision, retention, visibility })
  }
  return { version: 2, turnId, workspaceRevision, sections, omitted }
}

function normalizeWorkspaceEntry(value: unknown): AgentWorkspaceEntryPreviewV2 | null {
  if (!isUnknownRecord(value)) return null
  const id = boundedString(value.id)
  const revision = nonNegativeInteger(value.revision)
  const retention = normalizeWorkspaceRetention(value.retention)
  const visibility = normalizeWorkspaceVisibility(value.visibility)
  if (!id || revision === null || !retention || !visibility || typeof value.kind !== 'string') return null
  const base = { id, revision, retention, visibility }
  if (value.kind === 'task') {
    const title = boundedString(value.title, MAX_LABEL_LENGTH)
    const dependencyCount = nonNegativeInteger(value.dependencyCount)
    if (!title || dependencyCount === null || !isOwn(WORKSPACE_TASK_STATES, value.state) || typeof value.required !== 'boolean' || typeof value.assigned !== 'boolean') return null
    return { ...base, kind: 'task', title, dependencyCount, state: value.state, required: value.required, assigned: value.assigned }
  }
  if (value.kind === 'submission') {
    const taskId = boundedString(value.taskId)
    const profileId = value.profileId === null ? null : boundedString(value.profileId, 128)
    const states = ['submitted', 'accepted', 'rejected']
    if (!taskId || profileId === null && value.profileId !== null || typeof value.state !== 'string' || !states.includes(value.state)) return null
    return { ...base, kind: 'submission', taskId, profileId, state: value.state as 'submitted' | 'accepted' | 'rejected' }
  }
  if (value.kind === 'finding' || value.kind === 'decision' || value.kind === 'question') {
    const title = boundedString(value.title, MAX_LABEL_LENGTH)
    const states = ['active', 'accepted', 'omitted']
    if (!title || typeof value.state !== 'string' || !states.includes(value.state)) return null
    return { ...base, kind: value.kind, title, state: value.state as 'active' | 'accepted' | 'omitted' }
  }
  if (value.kind === 'artifact') {
    const name = boundedString(value.name, MAX_LABEL_LENGTH)
    const mimeType = boundedString(value.mimeType, 128)
    const byteCount = nonNegativeInteger(value.byteCount)
    const digestPrefix = boundedString(value.digestPrefix, 64)
    if (!name || !mimeType || byteCount === null || !digestPrefix || typeof value.published !== 'boolean') return null
    return { ...base, kind: 'artifact', name, mimeType, byteCount, digestPrefix, published: value.published }
  }
  return null
}

export function normalizeAgentWorkspaceSectionV2(value: unknown): AgentWorkspaceSectionPreviewV2 | null {
  if (!isUnknownRecord(value) || value.version !== 2 || !Array.isArray(value.entries)) return null
  const turnId = boundedString(value.turnId)
  const workspaceRevision = nonNegativeInteger(value.workspaceRevision)
  const omitted = nonNegativeInteger(value.omitted)
  const nextPage = value.nextPage === null ? null : boundedString(value.nextPage, MAX_CURSOR_LENGTH)
  if (!turnId || workspaceRevision === null || omitted === null || typeof value.section !== 'string' || !Object.hasOwn(WORKSPACE_SECTIONS, value.section) || nextPage === null && value.nextPage !== null) return null
  const entries = value.entries.slice(0, MAX_WORKSPACE_ENTRIES).map(normalizeWorkspaceEntry).filter((entry): entry is AgentWorkspaceEntryPreviewV2 => entry !== null)
  if (entries.length !== Math.min(value.entries.length, MAX_WORKSPACE_ENTRIES)) return null
  return { version: 2, turnId, section: value.section as AgentWorkspaceSectionV2, workspaceRevision, entries, nextPage, omitted: omitted + value.entries.length - entries.length }
}

function inspectionAvailability(value: unknown): AgentInspectionSectionAvailabilityV1[] | null {
  if (!Array.isArray(value) || value.length !== 9) return null
  const states: Record<AgentInspectionSectionStateV1, true> = { available: true, not_recorded: true, source_deleted: true, unavailable: true, withheld: true }
  const scopes: Record<AgentInspectionSectionIdV1, true> = { run: true, activity: true, transcript: true, turn_session: true, usage: true, prompt: true, cortex: true, council: true, workspace: true }
  const seen = new Set<AgentInspectionSectionIdV1>()
  const normalized: AgentInspectionSectionAvailabilityV1[] = []
  for (const item of value) {
    if (!isUnknownRecord(item) || typeof item.section !== 'string' || !Object.hasOwn(scopes, item.section) || typeof item.state !== 'string' || !Object.hasOwn(states, item.state) || item.reason !== null && !isInspectionReason(item.reason)) return null
    const section = item.section as AgentInspectionSectionIdV1
    if (seen.has(section)) return null
    seen.add(section)
    normalized.push({ section, state: item.state as AgentInspectionSectionStateV1, reason: item.reason as AgentInspectionSectionAvailabilityV1['reason'] })
  }
  return normalized
}

function normalizeInspectionUsageEvidence(value: unknown): AgentInspectionUsageV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const id = boundedString(value.id)
  const source = typeof value.source === 'string' && ['provider_reported', 'provisional', 'final', 'recovered_duplicate'].includes(value.source) ? value.source : null
  const layer = value.layer === undefined ? undefined : typeof value.layer === 'string' && ['root', 'child', 'provider', 'tool', 'cortex', 'council'].includes(value.layer) ? value.layer : null
  const correlation = value.correlation === null ? null : normalizeInspectionCorrelation(value.correlation)
  const counters = [value.inputTokens, value.outputTokens, value.totalTokens, value.toolCalls, value.childInvocations].map(nonNegativeInteger)
  if (!id || !source || layer === null || counters.some((counter) => counter === null) || typeof value.canonical !== 'boolean' || value.correlation !== null && correlation === null) return null
  return {
    version: 1,
    id,
    source: source as AgentInspectionUsageV1['source'],
    ...(layer ? { layer: layer as AgentInspectionUsageV1['layer'] } : {}),
    correlation,
    inputTokens: counters[0]!,
    outputTokens: counters[1]!,
    totalTokens: counters[2]!,
    toolCalls: counters[3]!,
    childInvocations: counters[4]!,
    canonical: value.canonical,
  }
}

function normalizeInspectionUsageLayer(value: unknown): AgentInspectionUsageLayerV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1 || !Array.isArray(value.evidenceIds)) return null
  const source = typeof value.source === 'string' && ['provider_reported', 'provisional', 'final', 'recovered_duplicate'].includes(value.source) ? value.source : null
  const layer = typeof value.layer === 'string' && ['root', 'child', 'provider', 'tool', 'cortex', 'council'].includes(value.layer) ? value.layer : null
  const correlation = value.correlation === null
    ? null
    : normalizeInspectionCorrelation(value.correlation) ?? undefined
  const counters = [value.inputTokens, value.outputTokens, value.totalTokens, value.toolCalls, value.childInvocations].map(nonNegativeInteger)
  const evidenceIds = value.evidenceIds.slice(0, MAX_INSPECTION_RECORDS).map((id) => boundedString(id)).filter((id): id is string => id !== null)
  if (!source || !layer || correlation === undefined || counters.some((counter) => counter === null) || evidenceIds.length !== value.evidenceIds.length || typeof value.canonical !== 'boolean') return null
  return {
    version: 1,
    source: source as AgentInspectionUsageLayerV1['source'],
    layer: layer as AgentInspectionUsageLayerV1['layer'],
    correlation,
    inputTokens: counters[0]!,
    outputTokens: counters[1]!,
    totalTokens: counters[2]!,
    toolCalls: counters[3]!,
    childInvocations: counters[4]!,
    evidenceIds,
    canonical: value.canonical,
  }
}

function normalizeInspectionUsageProjection(value: unknown): AgentInspectionUsageProjectionV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1 || !Array.isArray(value.layers)) return null
  const inspectionAttemptId = boundedString(value.inspectionAttemptId)
  const totals = normalizeUsage(value.totals)
  const evidenceCount = nonNegativeInteger(value.evidenceCount)
  const omittedEvidenceCount = nonNegativeInteger(value.omittedEvidenceCount)
  const layers: AgentInspectionUsageLayerV1[] = []
  for (const raw of value.layers.slice(0, MAX_INSPECTION_RECORDS)) {
    const layer = normalizeInspectionUsageLayer(raw)
    if (!layer) return null
    layers.push(layer)
  }
  if (!inspectionAttemptId || !totals || evidenceCount === null || omittedEvidenceCount === null) return null
  return { version: 1, inspectionAttemptId, totals, layers, evidenceCount, omittedEvidenceCount }
}

function normalizeInspectionRetry(value: unknown): AgentRunInspectionRetryV1 | null {
  if (!isUnknownRecord(value) || typeof value.allowed !== 'boolean' || !isInspectionReason(value.reason) || typeof value.targetValid !== 'boolean') return null
  const linkedAttemptId = value.linkedAttemptId === null ? null : boundedString(value.linkedAttemptId)
  if (linkedAttemptId === null && value.linkedAttemptId !== null) return null
  return { allowed: value.allowed, reason: value.reason, targetValid: value.targetValid, linkedAttemptId }
}

function normalizeInspectionSummary(value: unknown): AgentRunInspectionSummaryV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1 || !isUnknownRecord(value.attempt) || !isUnknownRecord(value.activity)) return null
  const attempt = normalizeAttempt(value.attempt)
  const runId = boundedString(value.runId)
  const turnSessionId = boundedString(value.turnSessionId)
  const generationId = boundedString(value.generationId)
  const lifecycle = isInspectionLifecycle(value.lifecycle) ? value.lifecycle : null
  const status = isRunStatus(value.status) ? value.status : null
  const outcome = value.outcome === null ? null : isRunOutcome(value.outcome) ? value.outcome : undefined
  const reason = isInspectionReason(value.reason) ? value.reason : null
  const target = normalizeTarget(value.target)
  const committedTarget = normalizeTarget(value.committedTarget)
  const hostCorrelationId = boundedString(value.hostCorrelationId)
  const revision = nonNegativeInteger(value.revision)
  const startedAt = dateTimestamp(value.startedAt)
  const updatedAt = dateTimestamp(value.updatedAt)
  const terminalAt = nullableDateTimestamp(value.terminalAt)
  const markerCount = nonNegativeInteger(value.markerCount)
  const transcriptCount = nonNegativeInteger(value.transcriptCount)
  const activity = normalizeActivityTree(value.activity)
  if (!attempt || !runId || !turnSessionId || !generationId || !lifecycle || !status || outcome === undefined || !reason || target === undefined || committedTarget === undefined || !hostCorrelationId || revision === null || startedAt === null || updatedAt === null || terminalAt === undefined || markerCount === null || transcriptCount === null || typeof value.terminal !== 'boolean' || !activity
    || !sameAttemptIdentity(attempt, activity.attempt)
    || !sameSummaryTarget(target, attempt.target)) return null
  return {
    version: 1,
    attempt,
    runId,
    turnSessionId,
    generationId,
    hostCorrelationId,
    lifecycle,
    status,
    outcome,
    reason,
    target,
    committedTarget,
    revision,
    startedAt,
    updatedAt,
    terminalAt,
    activity,
    markerCount,
    transcriptCount,
    terminal: value.terminal,
  }
}

function boundedText(value: unknown, maxLength = 64 * 1024): string | null {
  return typeof value === 'string' && UTF8_ENCODER.encode(value).byteLength <= maxLength ? value : null
}
function nullableBoundedText(value: unknown, maxLength = 64 * 1024): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const normalized = boundedText(value, maxLength)
  return normalized === null ? undefined : normalized
}
function normalizeTranscriptProvider(value: unknown): AgentInspectionProviderIdentityV1 | null {
  if (value === null || value === undefined) return null
  if (!isUnknownRecord(value)) return null
  const adapter = boundedString(value.adapter, 128)
  const providerId = nullableBoundedString(value.providerId, 128)
  const modelId = nullableBoundedString(value.modelId, 256)
  const connectionId = nullableBoundedString(value.connectionId, 256)
  const configRevision = value.configRevision === undefined
    ? undefined
    : value.configRevision === null
      ? null
      : typeof value.configRevision === 'number' && Number.isSafeInteger(value.configRevision) && value.configRevision >= 0
        ? value.configRevision
        : typeof value.configRevision === 'string' ? boundedString(value.configRevision, 256) : undefined
  const connectionRevision = value.connectionRevision === null
    ? null
    : typeof value.connectionRevision === 'number' && Number.isSafeInteger(value.connectionRevision) && value.connectionRevision >= 0
      ? value.connectionRevision
      : typeof value.connectionRevision === 'string' ? boundedString(value.connectionRevision, 256) : undefined
  const fingerprint = nullableBoundedString(value.fingerprint, 256)
  if (!adapter || providerId === undefined || modelId === undefined || connectionId === undefined || (value.configRevision !== undefined && configRevision === undefined) || connectionRevision === undefined || fingerprint === undefined) return null
  return {
    adapter,
    providerId,
    modelId,
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(configRevision === undefined ? {} : { configRevision }),
    connectionRevision,
    fingerprint,
  }
}
function normalizeInspectionTranscriptRecord(value: unknown): AgentInspectionTranscriptRecordV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const id = boundedString(value.id)
  const kind = isOwn(TRANSCRIPT_KINDS, value.kind) ? value.kind : null
  const actor = isOwn(TRANSCRIPT_ACTORS, value.actor) ? value.actor : null
  const recipient = value.recipient === null ? null : isOwn(TRANSCRIPT_ACTORS, value.recipient) ? value.recipient : undefined
  const correlation = normalizeInspectionCorrelation(value.correlation)
  const occurredAt = dateTimestamp(value.occurredAt)
  const durationMs = nullableNonNegativeInteger(value.durationMs)
  const content = nullableBoundedText(value.content)
  const args = nullableBoundedText(value.arguments)
  const result = nullableBoundedText(value.result)
  const provider = normalizeTranscriptProvider(value.provider)
  const errorReason = value.errorReason === undefined || value.errorReason === null
    ? null
    : isInspectionReason(value.errorReason) ? value.errorReason : undefined
  if (!id || !kind || !actor || recipient === undefined || !correlation || occurredAt === null || durationMs === undefined
    || content === undefined || args === undefined || result === undefined
    || value.provider !== undefined && value.provider !== null && !provider
    || errorReason === undefined || typeof value.late !== 'boolean') return null
  return { version: 1, id, kind, actor, recipient, correlation, occurredAt, durationMs, late: value.late, content, arguments: args, result, provider, errorReason }
}
function normalizeTurnSessionEntry(value: unknown): AgentTurnSessionEntryV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const id = boundedString(value.id)
  const kind = isOwn(TURN_SESSION_KINDS, value.kind) ? value.kind : null
  const correlation = normalizeInspectionCorrelation(value.correlation)
  const occurredAt = dateTimestamp(value.occurredAt)
  const detail = boundedText(value.detail, 2_048)
  const rawIds = isIndexedArray(value.transcriptRecordIds) ? value.transcriptRecordIds : null
  const ids = rawIds && rawIds.length <= MAX_INSPECTION_RECORDS
    ? rawIds.map((id) => boundedString(id)).filter((id): id is string => id !== null)
    : null
  if (!id || !kind || !correlation || occurredAt === null || detail === null || !rawIds || !ids) return null
  if (ids.length !== rawIds.length) return null
  return { version: 1, id, kind, correlation, occurredAt, detail, transcriptRecordIds: ids }
}
function normalizeLoomSource(value: unknown): LoomPromptInspectionItemV1['source'] | null {
  if (!isUnknownRecord(value) || value.kind !== 'loom_block') return null
  const blockId = boundedString(value.blockId, 256)
  const presetRevision = nonNegativeInteger(value.presetRevision)
  const blockRevision = nonNegativeInteger(value.blockRevision)
  const promptOrder = nonNegativeInteger(value.promptOrder)
  if (!blockId || presetRevision === null || blockRevision === null || promptOrder === null) return null
  return { kind: 'loom_block', blockId, presetRevision, blockRevision, promptOrder }
}
function inspectionExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
function normalizePredicateScalar(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') return boundedString(value, AGENTIC_PREDICATE_MAX_STRING_BYTES)
  if (typeof value === 'boolean') return value
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function accountPredicateListBytes(budget: { listBytes: number }, value: string): boolean {
  budget.listBytes += UTF8_ENCODER.encode(value).byteLength
  return budget.listBytes <= AGENTIC_PREDICATE_MAX_LIST_BYTES
}
function normalizePredicateValue(
  value: unknown,
  budget: { listBytes: number },
): string | number | boolean | string[] | null {
  const scalar = normalizePredicateScalar(value)
  if (scalar !== null) return scalar
  if (!isIndexedArray(value) || value.length > AGENTIC_PREDICATE_MAX_LIST_ITEMS) return null
  const strings: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    const normalized = normalizePredicateScalar(item)
    if (typeof normalized !== 'string' || !accountPredicateListBytes(budget, normalized)) return null
    strings.push(normalized)
  }
  return strings
}
function normalizeInspectionPredicate(
  value: unknown,
  depth = 1,
  budget: { nodes: number; listBytes: number } = { nodes: 0, listBytes: 0 },
): CognitionPredicate | null {
  if (!isUnknownRecord(value)
    || depth > AGENTIC_PREDICATE_MAX_DEPTH
    || budget.nodes >= AGENTIC_PREDICATE_MAX_NODES
    || typeof value.kind !== 'string') return null
  budget.nodes += 1
  if (value.kind === 'all' || value.kind === 'any') {
    if (!inspectionExactKeys(value, ['kind', 'children'])
      || !isIndexedArray(value.children)
      || value.children.length > AGENTIC_PREDICATE_MAX_LIST_ITEMS) return null
    const children = value.children.map((child) => normalizeInspectionPredicate(child, depth + 1, budget))
    return children.every((child): child is CognitionPredicate => child !== null)
      ? { kind: value.kind as 'all' | 'any', children }
      : null
  }
  if (value.kind === 'not') {
    if (!inspectionExactKeys(value, ['kind', 'child'])) return null
    const child = normalizeInspectionPredicate(value.child, depth + 1, budget)
    return child ? { kind: 'not', child } : null
  }
  if (value.kind === 'generation_type') {
    return inspectionExactKeys(value, ['kind', 'value'])
      && ['normal', 'continue', 'regenerate', 'swipe'].includes(String(value.value))
      ? { kind: 'generation_type', value: value.value as 'normal' | 'continue' | 'regenerate' | 'swipe' }
      : null
  }
  if (value.kind === 'phase') {
    const phases = ['ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT', 'COMMITTING', 'COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT']
    return inspectionExactKeys(value, ['kind', 'value']) && phases.includes(String(value.value))
      ? { kind: 'phase', value: value.value as never }
      : null
  }
  if (value.kind === 'tool_available') {
    const toolId = boundedString(value.toolId, 128)
    return inspectionExactKeys(value, ['kind', 'toolId', 'available']) && toolId && typeof value.available === 'boolean'
      ? { kind: 'tool_available', toolId, available: value.available }
      : null
  }
  if (value.kind === 'task_transition') {
    const taskId = boundedString(value.taskId)
    const transitions = ['pending', 'active', 'blocked', 'completed', 'cancelled', 'failed']
    return inspectionExactKeys(value, ['kind', 'taskId', 'transition']) && taskId && transitions.includes(String(value.transition))
      ? { kind: 'task_transition', taskId, transition: value.transition as never }
      : null
  }
  if (value.kind !== 'preset_variable' && value.kind !== 'participant_fact') return null
  const name = boundedString(value.name)
  if (!name || typeof value.operator !== 'string') return null
  if (value.operator === 'equals' && inspectionExactKeys(value, ['kind', 'name', 'operator', 'value'])) {
    const predicateValue = normalizePredicateValue(value.value, budget)
    return predicateValue === null
      ? null
      : { kind: value.kind as 'preset_variable' | 'participant_fact', name, operator: 'equals', value: predicateValue }
  }
  if (value.operator === 'in'
    && inspectionExactKeys(value, ['kind', 'name', 'operator', 'values'])
    && isIndexedArray(value.values)
    && value.values.length > 0
    && value.values.length <= AGENTIC_PREDICATE_MAX_LIST_ITEMS) {
    const values: Array<string | number | boolean> = []
    for (const item of value.values) {
      const normalized = normalizePredicateScalar(item)
      if (normalized === null
        || typeof normalized === 'string' && !accountPredicateListBytes(budget, normalized)) return null
      values.push(normalized)
    }
    return { kind: value.kind as 'preset_variable' | 'participant_fact', name, operator: 'in', values }
  }
  if (value.operator === 'includes' && inspectionExactKeys(value, ['kind', 'name', 'operator', 'value'])) {
    const predicateValue = normalizePredicateScalar(value.value)
    if (predicateValue === null
      || typeof predicateValue === 'string' && !accountPredicateListBytes(budget, predicateValue)) return null
    return { kind: value.kind as 'preset_variable' | 'participant_fact', name, operator: 'includes', value: predicateValue }
  }
  return value.operator === 'present' && inspectionExactKeys(value, ['kind', 'name', 'operator'])
    ? { kind: value.kind as 'preset_variable' | 'participant_fact', name, operator: 'present' }
    : null
}
function normalizeLoomOutcome(value: unknown): LoomPromptInspectionItemV1['outcome'] | null {
  if (!isUnknownRecord(value) || typeof value.status !== 'string') return null
  if (value.status === 'included' && nonNegativeInteger(value.effectiveIndex) !== null && value.reason === 'selected') {
    return { status: 'included', effectiveIndex: value.effectiveIndex as number, reason: 'selected' }
  }
  if (value.status === 'skipped' && ['checkpoint_not_reached', 'condition_not_met', 'stale_source'].includes(String(value.reason))) {
    return { status: 'skipped', reason: value.reason as never }
  }
  if (value.status === 'rejected' && ['invalid_source', 'stale_source', 'required_source_unavailable'].includes(String(value.reason))) {
    return { status: 'rejected', reason: value.reason as never }
  }
  if (value.status === 'omitted' && ['response_mode', 'destination_unavailable', 'not_work_surface'].includes(String(value.reason))) {
    return { status: 'omitted', reason: value.reason as never }
  }
  if (value.status === 'deduplicated') {
    const keptEntryId = boundedString(value.keptEntryId)
    const destination = ['root_work', 'completion_handoff', 'render'].includes(String(value.destination))
      ? value.destination as LoomPromptInspectionItemV1['destination']
      : null
    return keptEntryId && destination && value.reason === 'destination_overlap'
      ? { status: 'deduplicated', reason: 'destination_overlap', keptEntryId, destination }
      : null
  }
  return null
}
function normalizeLoomInspectionItem(value: unknown): LoomPromptInspectionItemV1 | null {
  if (!isUnknownRecord(value)) return null
  const entryId = boundedString(value.entryId)
  const bucket = ['workPolicy', 'workspaceUsage', 'completionCriteria', 'renderPolicy'].includes(String(value.bucket))
    ? value.bucket as LoomPromptInspectionItemV1['bucket']
    : null
  const destination = ['root_work', 'completion_handoff', 'render'].includes(String(value.destination))
    ? value.destination as LoomPromptInspectionItemV1['destination']
    : null
  const checkpoint = ['ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER'].includes(String(value.checkpoint))
    ? value.checkpoint as LoomPromptInspectionItemV1['checkpoint']
    : null
  const source = normalizeLoomSource(value.source)
  const condition = value.condition === undefined
    ? undefined
    : normalizeInspectionPredicate(value.condition)
  const conditionResult = value.conditionResult === undefined
    ? undefined
    : ['true', 'false', 'not_evaluated', 'invalid', 'not_applicable'].includes(String(value.conditionResult))
      ? value.conditionResult as LoomPromptInspectionItemV1['conditionResult']
      : null
  const effectiveText = value.effectiveText === null ? null : boundedText(value.effectiveText)
  const outcome = normalizeLoomOutcome(value.outcome)
  if (!entryId || !bucket || !destination || !checkpoint || !source
    || condition === null
    || conditionResult === null
    || effectiveText === null && value.effectiveText !== null
    || typeof value.required !== 'boolean'
    || typeof value.ordinaryPromptSuppressed !== 'boolean'
    || !outcome) return null
  return {
    entryId,
    bucket,
    destination,
    checkpoint,
    source,
    ...(condition === undefined ? {} : { condition }),
    ...(conditionResult === undefined ? {} : { conditionResult }),
    effectiveText,
    required: value.required,
    ordinaryPromptSuppressed: value.ordinaryPromptSuppressed,
    outcome,
  }
}
function normalizeLoomResponseOmission(value: unknown): NonNullable<LoomPromptInspectionV1['responseOmission']> | null | undefined {
  if (value === undefined || value === null) return undefined
  if (!isUnknownRecord(value) || value.version !== 1 || value.surface !== 'RESPONSE' || value.visibility !== 'work_only' || value.reason !== 'work_only'
    || !isIndexedArray(value.omittedEntryIds) || value.omittedEntryIds.length > AGENTIC_PREDICATE_MAX_LIST_ITEMS
    || !isIndexedArray(value.source) || value.source.length > AGENTIC_PREDICATE_MAX_LIST_ITEMS
    || !isIndexedArray(value.omittedPhaseInstructions) || value.omittedPhaseInstructions.length > LOOM_RESPONSE_OMISSION_MAX_PHASE_INSTRUCTIONS) return null
  const allowedKeys: Record<string, true> = {
    version: true, surface: true, visibility: true, reason: true,
    omittedEntryIds: true, source: true, omittedPhaseInstructions: true, reviewReason: true,
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys[key]) return null
  }
  for (const key of ['version', 'surface', 'visibility', 'reason', 'omittedEntryIds', 'source', 'omittedPhaseInstructions']) {
    if (!Object.hasOwn(value, key)) return null
  }
  const omittedEntryIds = value.omittedEntryIds.map((id) => boundedString(id))
  const source = value.source.map(normalizeLoomSource)
  const omittedPhaseInstructions = value.omittedPhaseInstructions.map((item) => {
    if (!isUnknownRecord(item)) return null
    const instructionKeys: Record<string, true> = { phaseId: true, source: true, profileId: true }
    for (const key of Object.keys(item)) {
      if (!instructionKeys[key]) return null
    }
    if (!Object.hasOwn(item, 'phaseId') || !Object.hasOwn(item, 'source')) return null
    const phaseId = boundedString(item.phaseId)
    const phaseSource = normalizeLoomSource(item.source)
    if (!phaseId || !phaseSource || !/^[a-z][a-z0-9_]{0,63}$/.test(phaseId)) return null
    if (!Object.hasOwn(item, 'profileId')) return { phaseId, source: phaseSource }
    const profileId = boundedString(item.profileId)
    if (!profileId || !/^[a-z][a-z0-9_]{0,63}$/.test(profileId)) return null
    return { phaseId, source: phaseSource, profileId }
  })
  if (omittedEntryIds.some((id) => id === null) || source.some((item) => item === null) || omittedPhaseInstructions.some((item) => item === null)) return null
  const reviewReason = Object.hasOwn(value, 'reviewReason') ? boundedString(value.reviewReason) : undefined
  if (Object.hasOwn(value, 'reviewReason') && reviewReason === null) return null
  return {
    version: 1,
    surface: 'RESPONSE',
    visibility: 'work_only',
    reason: 'work_only',
    omittedEntryIds: omittedEntryIds as string[],
    source: source as NonNullable<LoomPromptInspectionV1['responseOmission']>['source'],
    omittedPhaseInstructions: omittedPhaseInstructions as NonNullable<LoomPromptInspectionV1['responseOmission']>['omittedPhaseInstructions'],
    ...(reviewReason === undefined ? {} : { reviewReason }),
  }
}
function normalizeLoomInspection(value: unknown): LoomPromptInspectionV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1 || !['WORK', 'RESPONSE'].includes(String(value.surface))
    || !['ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER'].includes(String(value.checkpoint))
    || !isIndexedArray(value.items) || value.items.length > AGENTIC_PREDICATE_MAX_LIST_ITEMS
    || !isIndexedArray(value.effectiveEntryIds) || value.effectiveEntryIds.length > AGENTIC_PREDICATE_MAX_LIST_ITEMS) return null
  const items = value.items.map(normalizeLoomInspectionItem)
  const effectiveEntryIds = value.effectiveEntryIds.map((id) => boundedString(id)).filter((id): id is string => id !== null)
  const responseOmission = normalizeLoomResponseOmission(value.responseOmission)
  if (items.some((item) => item === null) || effectiveEntryIds.length !== value.effectiveEntryIds.length
    || responseOmission === null) return null
  return {
    version: 1,
    surface: value.surface as LoomPromptInspectionV1['surface'],
    checkpoint: value.checkpoint as LoomPromptInspectionV1['checkpoint'],
    items: items as LoomPromptInspectionV1['items'],
    effectiveEntryIds,
    ...(responseOmission === undefined ? {} : { responseOmission }),
  }
}
function normalizePromptRevision(value: unknown): string | number | null {
  if (typeof value === 'string') return boundedString(value)
  return nonNegativeInteger(value)
}
function normalizeSha256(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null
}
function normalizePromptDatabankSource(value: unknown): AgentPromptDatabankSourceV1 | null {
  if (!isUnknownRecord(value) || !inspectionExactKeys(value, ['kind', 'databankId', 'documentId', 'documentName', 'chunkId', 'documentContentHash', 'contentHash'])) return null
  const kind = value.kind === 'automatic' || value.kind === 'mention' ? value.kind : null
  const databankId = boundedString(value.databankId)
  const documentId = boundedString(value.documentId)
  const documentName = boundedString(value.documentName)
  const chunkId = value.chunkId === null ? null : boundedString(value.chunkId)
  const documentContentHash = value.documentContentHash === null ? null : normalizeSha256(value.documentContentHash)
  const contentHash = normalizeSha256(value.contentHash)
  if (!kind || !databankId || !documentId || !documentName || chunkId === null && value.chunkId !== null
    || documentContentHash === null && value.documentContentHash !== null || !contentHash) return null
  return { kind, databankId, documentId, documentName, chunkId, documentContentHash, contentHash }
}
function normalizePromptNativeProvenance(value: unknown): AgentPromptNativeProvenanceV1 | null {
  if (!isUnknownRecord(value)) return null
  if (value.kind === 'world_info') {
    if (!inspectionExactKeys(value, ['kind', 'sourceId', 'sourceRevision', 'sourceIndex'])) return null
    const sourceId = boundedString(value.sourceId)
    const sourceRevision = normalizePromptRevision(value.sourceRevision)
    const sourceIndex = nonNegativeInteger(value.sourceIndex)
    return sourceId && sourceRevision !== null && sourceIndex !== null
      ? { kind: 'world_info', sourceId, sourceRevision, sourceIndex }
      : null
  }
  if (value.kind === 'databank') {
    if (!inspectionExactKeys(value, ['kind', 'sourceRevision', 'sources']) || !isIndexedArray(value.sources)
      || value.sources.length > MAX_INSPECTION_RECORDS) return null
    const sourceRevision = boundedString(value.sourceRevision)
    const sources = value.sources.map(normalizePromptDatabankSource)
    if (!sourceRevision || sources.some((source) => source === null)) return null
    return { kind: 'databank', sourceRevision, sources: sources as AgentPromptDatabankSourceV1[] }
  }
  return null
}
function normalizeRenderCrossing(value: unknown): AgentRenderCrossingV1 | null {
  if (!isUnknownRecord(value) || !inspectionExactKeys(value, ['version', 'id', 'kind', 'sourceId', 'sourceRevision', 'contentDigest', 'content', 'correlation']) || value.version !== 1) return null
  const id = boundedString(value.id)
  const kind = value.kind === 'accepted_finding' || value.kind === 'accepted_submission' || value.kind === 'completion_guidance' ? value.kind : null
  const sourceId = boundedString(value.sourceId)
  const sourceRevision = value.sourceRevision === null ? null : nonNegativeInteger(value.sourceRevision)
  const contentDigest = normalizeSha256(value.contentDigest)
  const content = value.content === null ? null : boundedText(value.content)
  const correlation = normalizeInspectionCorrelation(value.correlation)
  if (!id || !kind || !sourceId || sourceRevision === null && value.sourceRevision !== null || !contentDigest
    || content === null && value.content !== null || !correlation) return null
  return { version: 1, id, kind, sourceId, sourceRevision, contentDigest, content, correlation }
}
function normalizePromptEvidence(value: unknown): AgentPromptEvidenceV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const id = boundedString(value.id)
  const sourceId = boundedString(value.sourceId)
  const sourceRevision = normalizePromptRevision(value.sourceRevision)
  const promptOrder = nonNegativeInteger(value.promptOrder)
  const destination = isOwn(PROMPT_DESTINATIONS, value.destination) ? value.destination : null
  const role = isOwn(PROMPT_ROLES, value.role) ? value.role : null
  const correlation = normalizeInspectionCorrelation(value.correlation)
  const content = boundedText(value.content)
  const contentDigest = normalizeSha256(value.contentDigest)
  const omissionReason = nullableBoundedText(value.omissionReason, 2_048)
  const nativeProvenance = value.nativeProvenance === null ? null : normalizePromptNativeProvenance(value.nativeProvenance)
  const loomInspection = value.loomInspection === null ? null : normalizeLoomInspection(value.loomInspection)
  if (!id || !sourceId || sourceRevision === null || promptOrder === null || !destination || !role || !correlation || typeof value.included !== 'boolean'
    || content === null || !contentDigest || omissionReason === undefined || !Object.hasOwn(value, 'nativeProvenance') || !Object.hasOwn(value, 'loomInspection')
    || value.nativeProvenance !== null && nativeProvenance === null || value.loomInspection !== null && loomInspection === null) return null
  return { version: 1, id, sourceId, sourceRevision, promptOrder, destination, role, correlation, included: value.included, content, contentDigest, omissionReason, nativeProvenance, loomInspection }
}
function hasPromptOccurrenceCollision(prompts: readonly AgentPromptEvidenceV1[]): boolean {
  const fingerprints = new Map<string, string>()
  for (const prompt of prompts) {
    const key = JSON.stringify([prompt.sourceId, prompt.promptOrder, prompt.sourceRevision, prompt.destination])
    const fingerprint = JSON.stringify([
      prompt.role,
      prompt.content,
      prompt.contentDigest,
      prompt.included,
      prompt.omissionReason,
      prompt.nativeProvenance,
      prompt.loomInspection,
    ])
    const retained = fingerprints.get(key)
    if (retained !== undefined && retained !== fingerprint) return true
    fingerprints.set(key, fingerprint)
  }
  return false
}
function normalizeCortexReceipt(value: unknown): AgentCortexReceiptV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1 || value.checkpoint !== 'WORK' || value.canonical !== false) return null
  const id = boundedString(value.id)
  const requestId = boundedString(value.requestId)
  const attemptId = boundedString(value.attemptId)
  const snapshotId = boundedString(value.snapshotId)
  const sourceRevision = typeof value.sourceRevision === 'string' ? boundedString(value.sourceRevision) : nonNegativeInteger(value.sourceRevision)
  const revision = typeof value.revision === 'string' ? boundedString(value.revision) : nonNegativeInteger(value.revision)
  const scope = isUnknownRecord(value.scope) ? value.scope : null
  const scopeChatId = scope ? boundedString(scope.chatId) : null
  const targetMessageId = scope === null ? undefined : nullableBoundedString(scope.targetMessageId)
  const targetSwipeId = scope === null ? undefined : nullableNonNegativeInteger(scope.targetSwipeId)
  const required = typeof value.required === 'boolean' ? value.required : null
  const startedAt = dateTimestamp(value.startedAt)
  const completedAt = nullableDateTimestamp(value.completedAt)
  const state = isOwn(CORTEX_STATES, value.state) ? value.state : null
  const resultDigest = value.resultDigest === null ? null : boundedString(value.resultDigest, 256)
  const resultCount = nonNegativeInteger(value.resultCount)
  const correlation = normalizeInspectionCorrelation(value.correlation)
  const reason = value.reason === null ? null : isInspectionReason(value.reason) ? value.reason : undefined
  const omission = (() => {
    const rawOmission = value.omission
    if (rawOmission === null) return null
    if (!isUnknownRecord(rawOmission)) return undefined
    const omissionReason = isOwn(CORTEX_OMISSION_REASONS, rawOmission.reason) ? rawOmission.reason : null
    const omissionRequired = typeof rawOmission.required === 'boolean' ? rawOmission.required : null
    const omissionDetail = rawOmission.detail === null ? null : boundedText(rawOmission.detail, 2_048)
    if (!omissionReason || omissionRequired === null || omissionDetail === null && rawOmission.detail !== null) return undefined
    return { reason: omissionReason, required: omissionRequired, detail: omissionDetail }
  })()
  if (!id || !requestId || !attemptId || !snapshotId || sourceRevision === null || revision === null || !scopeChatId
    || targetMessageId === undefined || targetSwipeId === undefined || required === null || startedAt === null || completedAt === undefined
    || !state || resultDigest === null && value.resultDigest !== null || resultCount === null || !correlation || reason === undefined || omission === undefined) return null
  return { version: 1, id, requestId, attemptId, checkpoint: 'WORK', snapshotId, sourceRevision, revision, scope: { chatId: scopeChatId, targetMessageId, targetSwipeId }, required, startedAt, completedAt, state, resultDigest, resultCount, correlation, reason, omission, canonical: false }
}
function normalizeCouncilReceipt(value: unknown): AgentCouncilReceiptV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1 || value.checkpoint !== 'WORK' || value.canonical !== false) return null
  const id = boundedString(value.id)
  const requestId = boundedString(value.requestId)
  const startedAt = dateTimestamp(value.startedAt)
  const completedAt = nullableDateTimestamp(value.completedAt)
  const state = isOwn(CORTEX_STATES, value.state) ? value.state : null
  const memberCount = nonNegativeInteger(value.memberCount)
  const resultDigest = value.resultDigest === null ? null : boundedString(value.resultDigest, 256)
  const correlation = normalizeInspectionCorrelation(value.correlation)
  const reason = value.reason === null ? null : isInspectionReason(value.reason) ? value.reason : undefined
  const required = typeof value.required === 'boolean' ? value.required : null
  if (!id || !requestId || startedAt === null || completedAt === undefined || !state || memberCount === null
    || resultDigest === null && value.resultDigest !== null || !correlation || reason === undefined || required === null) return null
  return { version: 1, id, requestId, checkpoint: 'WORK', required, startedAt, completedAt, state, memberCount, resultDigest, correlation, reason, canonical: false }
}
function normalizeWorkspaceAssociation(value: unknown): AgentWorkspaceAssociationV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const id = boundedString(value.id)
  const workspaceId = boundedString(value.workspaceId)
  const workspaceRevision = nonNegativeInteger(value.workspaceRevision)
  const relation = isOwn(WORKSPACE_ASSOCIATION_RELATIONS, value.relation) ? value.relation : null
  const objectKind = isOwn(WORKSPACE_ASSOCIATION_KINDS, value.objectKind) ? value.objectKind : null
  const objectId = nullableBoundedString(value.objectId)
  const sourceRevision = nullableNonNegativeInteger(value.sourceRevision)
  const provenanceDigest = value.provenanceDigest === null
    ? null
    : typeof value.provenanceDigest === 'string' && value.provenanceDigest.length === 64 && UTF8_ENCODER.encode(value.provenanceDigest).byteLength === 64
      ? value.provenanceDigest
      : undefined
  const correlation = normalizeInspectionCorrelation(value.correlation)
  if (!id || !workspaceId || workspaceRevision === null || !relation || !objectKind || objectId === undefined
    || sourceRevision === undefined || typeof value.sourceDeleted !== 'boolean' || provenanceDigest === undefined || !correlation) return null
  return { version: 1, id, workspaceId, workspaceRevision, relation, objectKind, objectId, sourceRevision, sourceDeleted: value.sourceDeleted, provenanceDigest, correlation }
}

function normalizeStrictInspectionArray<T>(value: unknown, normalize: (item: unknown) => T | null): T[] | null {
  if (!isIndexedArray(value) || value.length > MAX_INSPECTION_RECORDS) return null
  const normalized: T[] = []
  for (const item of value) {
    const result = normalize(item)
    if (result === null) return null
    normalized.push(result)
  }
  return normalized
}

const WORK_BOUNDARY_CLASSES = new Set(['tool_action', 'tool_free_stop', 'reasoning_only_stop', 'reasoning_only_length', 'empty_provider_response', 'provider_protocol_failure'])
const WORK_SEGMENT_LIFECYCLES = new Set(['admitted', 'running', 'closed', 'interrupted', 'failed', 'exhausted', 'cancelled'])
const WORK_SEGMENT_CLOSE_RESULTS = new Set(['phase_advanced', 'phase_repeated', 'same_phase_rollover', 'work_complete', 'failed', 'exhausted', 'cancelled'])
const WORK_DISPATCH_LIFECYCLES = new Set(['reserved', 'in_flight', 'settled', 'interrupted'])
const WORK_TRANSITION_KINDS = new Set(['advance', 'repeat', 'rollover', 'terminal'])

function workBoundary(value: unknown): WorkSegmentInspectionProjectionV1['segments'][number]['boundaryClass'] | undefined {
  return value === null || typeof value === 'string' && WORK_BOUNDARY_CLASSES.has(value)
    ? value as WorkSegmentInspectionProjectionV1['segments'][number]['boundaryClass']
    : undefined
}
function workTerminalCloseResult(value: unknown): WorkSegmentInspectionProjectionV1['recovery']['terminalCloseResult'] | undefined {
  if (value === null) return null
  if (value === 'failed') return 'failed'
  if (value === 'exhausted') return 'exhausted'
  if (value === 'cancelled') return 'cancelled'
  return undefined
}
function normalizeWorkIdentity(value: unknown): WorkSegmentInspectionProjectionV1['segments'][number]['identity'] | null {
  if (!isUnknownRecord(value) || !inspectionExactKeys(value, ['segmentId', 'phaseId', 'phaseIndex', 'phaseOccurrence', 'segmentOrdinal'])) return null
  const segmentId = boundedString(value.segmentId)
  const phaseId = nullableBoundedString(value.phaseId)
  const phaseIndex = nonNegativeInteger(value.phaseIndex)
  const phaseOccurrence = nonNegativeInteger(value.phaseOccurrence)
  const segmentOrdinal = nonNegativeInteger(value.segmentOrdinal)
  return segmentId && phaseId !== undefined && phaseIndex !== null && phaseOccurrence !== null && segmentOrdinal !== null
    ? { segmentId, phaseId, phaseIndex, phaseOccurrence, segmentOrdinal }
    : null
}
function normalizeWorkUsage(value: unknown): WorkSegmentInspectionProjectionV1['segments'][number]['usage'] | null {
  const keys = ['providerDispatches', 'providerInputTokens', 'providerOutputTokens', 'providerTotalTokens', 'billedOutputTokens', 'toolCalls', 'workspaceOperations', 'unsignedBoundaries', 'receiveBytes', 'publishedOutputBytes'] as const
  if (!isUnknownRecord(value) || !inspectionExactKeys(value, keys)) return null
  const normalized = Object.fromEntries(keys.map((key) => [key, nonNegativeInteger(value[key])])) as Record<typeof keys[number], number | null>
  if (keys.some((key) => normalized[key] === null)) return null
  return normalized as WorkSegmentInspectionProjectionV1['segments'][number]['usage']
}
function sameWorkSegmentIdentity(
  left: WorkSegmentInspectionProjectionV1['segments'][number]['identity'],
  right: WorkSegmentInspectionProjectionV1['segments'][number]['identity'],
): boolean {
  return left.segmentId === right.segmentId
    && left.phaseId === right.phaseId
    && left.phaseIndex === right.phaseIndex
    && left.phaseOccurrence === right.phaseOccurrence
    && left.segmentOrdinal === right.segmentOrdinal
}
function hasCoherentWorkSegmentState(segment: WorkSegmentInspectionProjectionV1['segments'][number]): boolean {
  if (segment.lifecycle === 'admitted' || segment.lifecycle === 'running') {
    return segment.boundaryClass === null
      && segment.closeResult === null
      && segment.closedWorkspaceRevision === null
  }
  if (segment.closeResult === null || segment.closedWorkspaceRevision === null) return false
  if (segment.lifecycle === 'closed') {
    return segment.closeResult === 'phase_advanced'
      || segment.closeResult === 'phase_repeated'
      || segment.closeResult === 'same_phase_rollover'
      || segment.closeResult === 'work_complete'
  }
  if (segment.lifecycle === 'failed') return segment.closeResult === 'failed'
  if (segment.lifecycle === 'exhausted') return segment.closeResult === 'exhausted'
  if (segment.lifecycle === 'cancelled') return segment.closeResult === 'cancelled'
  return segment.lifecycle === 'interrupted'
}
function hasCoherentWorkDispatchState(dispatch: WorkSegmentInspectionProjectionV1['dispatches'][number]): boolean {
  if (dispatch.lifecycle === 'reserved' || dispatch.lifecycle === 'in_flight') {
    return dispatch.settledWorkspaceRevision === null
      && dispatch.boundaryClass === null
      && dispatch.usage === null
  }
  return dispatch.settledWorkspaceRevision !== null
    && dispatch.boundaryClass !== null
    && dispatch.usage !== null
}
function hasCoherentWorkSegmentInspection(projection: WorkSegmentInspectionProjectionV1): boolean {
  const { recovery, segments, dispatches, transitions } = projection
  if (recovery.state === 'active') {
    if (recovery.phaseIndex === null || recovery.phaseOccurrence === null
      || recovery.terminalCloseResult !== null || recovery.terminalBoundaryClass !== null) return false
  } else if (recovery.phaseId !== null || recovery.phaseIndex !== null || recovery.phaseOccurrence !== null
    || recovery.currentSegmentId !== null
    || recovery.terminalCloseResult === null && recovery.terminalBoundaryClass !== null) return false

  const expectedNextSegmentOrdinal = recovery.currentSegmentId === null
    ? segments.length
    : Math.max(0, segments.length - 1)
  if (recovery.usage.segments !== segments.length || recovery.nextSegmentOrdinal !== expectedNextSegmentOrdinal) return false

  const segmentsById = new Map<string, WorkSegmentInspectionProjectionV1['segments'][number]>()
  let activeSegment: WorkSegmentInspectionProjectionV1['segments'][number] | null = null
  for (let ordinal = 0; ordinal < segments.length; ordinal += 1) {
    const segment = segments[ordinal]
    if (!segment || segmentsById.has(segment.identity.segmentId)
      || segment.identity.segmentOrdinal !== ordinal
      || segment.identity.phaseOccurrence > segment.identity.segmentOrdinal
      || !hasCoherentWorkSegmentState(segment)) return false
    segmentsById.set(segment.identity.segmentId, segment)
    if (segment.lifecycle === 'admitted' || segment.lifecycle === 'running') {
      if (activeSegment !== null || ordinal !== segments.length - 1) return false
      activeSegment = segment
    }
  }

  if (recovery.currentSegmentId === null) {
    if (activeSegment !== null) return false
  } else {
    const current = segmentsById.get(recovery.currentSegmentId)
    if (recovery.state !== 'active' || !current || current !== activeSegment
      || current.identity.phaseId !== recovery.phaseId
      || current.identity.phaseIndex !== recovery.phaseIndex
      || current.identity.phaseOccurrence !== recovery.phaseOccurrence
      || current.identity.segmentOrdinal !== recovery.nextSegmentOrdinal) return false
  }

  const dispatchIds = new Set<string>()
  const nextDispatchOrdinal = new Map<string, number>()
  for (const dispatch of dispatches) {
    const segment = segmentsById.get(dispatch.segmentId)
    const expectedOrdinal = nextDispatchOrdinal.get(dispatch.segmentId) ?? 0
    if (!segment || dispatchIds.has(dispatch.dispatchId) || dispatch.dispatchOrdinal !== expectedOrdinal
      || !hasCoherentWorkDispatchState(dispatch)
      || segment.lifecycle !== 'admitted' && segment.lifecycle !== 'running'
        && (dispatch.lifecycle === 'reserved' || dispatch.lifecycle === 'in_flight')) return false
    dispatchIds.add(dispatch.dispatchId)
    nextDispatchOrdinal.set(dispatch.segmentId, expectedOrdinal + 1)
  }

  const transitionIds = new Set<string>()
  const handoffIds = new Set<string>()
  const transitionsBySource = new Map<string, WorkSegmentInspectionProjectionV1['transitions'][number]>()
  for (const transition of transitions) {
    const source = segmentsById.get(transition.sourceSegment.segmentId)
    if (!source || transitionIds.has(transition.transitionId) || handoffIds.has(transition.handoffId)
      || transitionsBySource.has(transition.sourceSegment.segmentId)
      || !sameWorkSegmentIdentity(source.identity, transition.sourceSegment)
      || source.lifecycle !== 'closed'
      || source.closedWorkspaceRevision !== transition.sourceWorkspaceRevision
      || source.boundaryClass !== transition.cause) return false
    transitionIds.add(transition.transitionId)
    handoffIds.add(transition.handoffId)
    transitionsBySource.set(transition.sourceSegment.segmentId, transition)

    const closeResultMatches = transition.transitionKind === 'advance' && source.closeResult === 'phase_advanced'
      || transition.transitionKind === 'repeat' && source.closeResult === 'phase_repeated'
      || transition.transitionKind === 'rollover' && source.closeResult === 'same_phase_rollover'
      || transition.transitionKind === 'terminal' && source.closeResult === 'work_complete'
    if (!closeResultMatches) return false

    if (transition.transitionKind === 'terminal') {
      if (transition.targetPhaseId !== null || transition.targetPhaseIndex !== null
        || transition.targetPhaseOccurrence !== null || transition.targetSegmentOrdinal !== null
        || source.identity.segmentOrdinal !== segments.length - 1 || recovery.state !== 'closed') return false
      continue
    }
    if (transition.targetPhaseIndex === null || transition.targetPhaseOccurrence === null
      || transition.targetSegmentOrdinal === null
      || transition.targetSegmentOrdinal !== source.identity.segmentOrdinal + 1) return false
    if (transition.transitionKind === 'advance') {
      if (transition.targetPhaseId === null || transition.targetPhaseIndex <= source.identity.phaseIndex
        || transition.targetPhaseOccurrence !== 0) return false
    } else if (transition.transitionKind === 'repeat') {
      if (source.identity.phaseId === null || transition.targetPhaseId !== source.identity.phaseId
        || transition.targetPhaseIndex !== source.identity.phaseIndex
        || transition.targetPhaseOccurrence !== source.identity.phaseOccurrence + 1) return false
    } else if (transition.targetPhaseId !== source.identity.phaseId
      || transition.targetPhaseIndex !== source.identity.phaseIndex
      || transition.targetPhaseOccurrence !== source.identity.phaseOccurrence) return false

    const target = segments[transition.targetSegmentOrdinal]
    if (target) {
      if (target.identity.phaseId !== transition.targetPhaseId
        || target.identity.phaseIndex !== transition.targetPhaseIndex
        || target.identity.phaseOccurrence !== transition.targetPhaseOccurrence) return false
    } else if (transition.targetSegmentOrdinal !== segments.length
      || recovery.state !== 'active' || recovery.currentSegmentId !== null
      || recovery.phaseId !== transition.targetPhaseId
      || recovery.phaseIndex !== transition.targetPhaseIndex
      || recovery.phaseOccurrence !== transition.targetPhaseOccurrence
      || recovery.nextSegmentOrdinal !== transition.targetSegmentOrdinal) return false
  }

  for (const segment of segments) {
    if ((segment.lifecycle === 'closed') !== transitionsBySource.has(segment.identity.segmentId)) return false
  }
  if (recovery.state === 'active' && recovery.currentSegmentId === null && segments.length > 0) {
    const finalSegment = segments.at(-1)
    const finalTransition = finalSegment && transitionsBySource.get(finalSegment.identity.segmentId)
    if (!finalTransition || finalTransition.transitionKind === 'terminal') return false
  }
  if (recovery.state === 'closed' && segments.length > 0) {
    const finalSegment = segments.at(-1)
    if (!finalSegment) return false
    if (finalSegment.lifecycle === 'closed') {
      if (recovery.terminalCloseResult !== null || recovery.terminalBoundaryClass !== null) return false
    } else if (recovery.terminalCloseResult !== finalSegment.closeResult
      || recovery.terminalBoundaryClass !== finalSegment.boundaryClass) return false
  }
  return true
}
function normalizeWorkSegmentInspection(value: unknown): WorkSegmentInspectionProjectionV1 | null {
  if (!isUnknownRecord(value) || !inspectionExactKeys(value, ['recovery', 'segments', 'dispatches', 'transitions'])
    || !isUnknownRecord(value.recovery) || !isIndexedArray(value.segments) || value.segments.length > MAX_INSPECTION_RECORDS
    || !isIndexedArray(value.dispatches) || value.dispatches.length > MAX_INSPECTION_RECORDS
    || !isIndexedArray(value.transitions) || value.transitions.length > MAX_INSPECTION_RECORDS) return null
  const recovery = value.recovery
  if (!inspectionExactKeys(recovery, ['state', 'phaseId', 'phaseIndex', 'phaseOccurrence', 'nextSegmentOrdinal', 'currentSegmentId', 'workspaceRevision', 'terminalCloseResult', 'terminalBoundaryClass', 'usage'])
    || !isUnknownRecord(recovery.usage)
    || !inspectionExactKeys(recovery.usage, ['providerDispatches', 'providerInputTokens', 'providerOutputTokens', 'providerTotalTokens', 'billedOutputTokens', 'toolCalls', 'workspaceOperations', 'unsignedBoundaries', 'receiveBytes', 'publishedOutputBytes', 'segments'])) return null
  const recoveryUsage = normalizeWorkUsage(Object.fromEntries(Object.entries(recovery.usage).filter(([key]) => key !== 'segments')))
  const recoveryPhaseId = nullableBoundedString(recovery.phaseId)
  const recoveryPhaseIndex = nullableNonNegativeInteger(recovery.phaseIndex)
  const recoveryPhaseOccurrence = nullableNonNegativeInteger(recovery.phaseOccurrence)
  const currentSegmentId = nullableBoundedString(recovery.currentSegmentId)
  const terminalBoundaryClass = workBoundary(recovery.terminalBoundaryClass)
  const terminalCloseResult = workTerminalCloseResult(recovery.terminalCloseResult)
  const nextSegmentOrdinal = nonNegativeInteger(recovery.nextSegmentOrdinal)
  const workspaceRevision = nonNegativeInteger(recovery.workspaceRevision)
  const recoverySegments = nonNegativeInteger(recovery.usage.segments)
  if ((recovery.state !== 'active' && recovery.state !== 'closed') || recoveryPhaseId === undefined
    || recoveryPhaseIndex === undefined || recoveryPhaseOccurrence === undefined || currentSegmentId === undefined || terminalBoundaryClass === undefined || !recoveryUsage
    || nextSegmentOrdinal === null || workspaceRevision === null || recoverySegments === null
    || terminalCloseResult === undefined) return null
  const segments: WorkSegmentInspectionProjectionV1['segments'] = []
  for (const item of value.segments) {
    if (!isUnknownRecord(item) || !inspectionExactKeys(item, ['identity', 'lifecycle', 'workspaceRevision', 'boundaryClass', 'closeResult', 'closedWorkspaceRevision', 'usage'])) return null
    const identity = normalizeWorkIdentity(item.identity)
    const usage = normalizeWorkUsage(item.usage)
    const boundaryClass = workBoundary(item.boundaryClass)
    const segmentWorkspaceRevision = nonNegativeInteger(item.workspaceRevision)
    const closedWorkspaceRevision = nullableNonNegativeInteger(item.closedWorkspaceRevision)
    if (!identity || !usage || typeof item.lifecycle !== 'string' || !WORK_SEGMENT_LIFECYCLES.has(item.lifecycle)
      || boundaryClass === undefined || segmentWorkspaceRevision === null || closedWorkspaceRevision === undefined
      || !(item.closeResult === null || typeof item.closeResult === 'string' && WORK_SEGMENT_CLOSE_RESULTS.has(item.closeResult))) return null
    segments.push({
      identity,
      lifecycle: item.lifecycle as WorkSegmentInspectionProjectionV1['segments'][number]['lifecycle'],
      workspaceRevision: segmentWorkspaceRevision,
      boundaryClass,
      closeResult: item.closeResult as WorkSegmentInspectionProjectionV1['segments'][number]['closeResult'],
      closedWorkspaceRevision,
      usage,
    })
  }
  const dispatches: WorkSegmentInspectionProjectionV1['dispatches'] = []
  for (const item of value.dispatches) {
    if (!isUnknownRecord(item) || !inspectionExactKeys(item, ['dispatchId', 'segmentId', 'dispatchOrdinal', 'lifecycle', 'toolMode', 'budgetClass', 'workspaceRevision', 'settledWorkspaceRevision', 'boundaryClass', 'usage'])) return null
    const dispatchId = boundedString(item.dispatchId)
    const segmentId = boundedString(item.segmentId)
    const dispatchOrdinal = nonNegativeInteger(item.dispatchOrdinal)
    const dispatchWorkspaceRevision = nonNegativeInteger(item.workspaceRevision)
    const settledWorkspaceRevision = nullableNonNegativeInteger(item.settledWorkspaceRevision)
    const boundaryClass = workBoundary(item.boundaryClass)
    const usage = item.usage === null ? null : normalizeWorkUsage(item.usage)
    if (!dispatchId || !segmentId || dispatchOrdinal === null || dispatchWorkspaceRevision === null || settledWorkspaceRevision === undefined
      || boundaryClass === undefined || item.usage !== null && !usage
      || typeof item.lifecycle !== 'string' || !WORK_DISPATCH_LIFECYCLES.has(item.lifecycle)
      || item.toolMode !== 'ordinary' && item.toolMode !== 'required'
      || item.budgetClass !== 'normal' && item.budgetClass !== 'recovery') return null
    dispatches.push({
      dispatchId,
      segmentId,
      dispatchOrdinal,
      lifecycle: item.lifecycle as WorkSegmentInspectionProjectionV1['dispatches'][number]['lifecycle'],
      toolMode: item.toolMode,
      budgetClass: item.budgetClass,
      workspaceRevision: dispatchWorkspaceRevision,
      settledWorkspaceRevision,
      boundaryClass,
      usage,
    })
  }
  const transitions: WorkSegmentInspectionProjectionV1['transitions'] = []
  for (const item of value.transitions) {
    if (!isUnknownRecord(item) || !inspectionExactKeys(item, ['transitionId', 'handoffId', 'transitionKind', 'sourceSegment', 'sourceWorkspaceRevision', 'targetPhaseId', 'targetPhaseIndex', 'targetPhaseOccurrence', 'targetSegmentOrdinal', 'cause'])) return null
    const transitionId = boundedString(item.transitionId)
    const handoffId = boundedString(item.handoffId)
    const sourceSegment = normalizeWorkIdentity(item.sourceSegment)
    const sourceWorkspaceRevision = nonNegativeInteger(item.sourceWorkspaceRevision)
    const targetPhaseId = nullableBoundedString(item.targetPhaseId)
    const targetPhaseIndex = nullableNonNegativeInteger(item.targetPhaseIndex)
    const targetPhaseOccurrence = nullableNonNegativeInteger(item.targetPhaseOccurrence)
    const targetSegmentOrdinal = nullableNonNegativeInteger(item.targetSegmentOrdinal)
    const cause = workBoundary(item.cause)
    if (!transitionId || !handoffId || !sourceSegment || sourceWorkspaceRevision === null || targetPhaseId === undefined
      || targetPhaseIndex === undefined || targetPhaseOccurrence === undefined || targetSegmentOrdinal === undefined || cause === undefined
      || typeof item.transitionKind !== 'string' || !WORK_TRANSITION_KINDS.has(item.transitionKind)) return null
    transitions.push({
      transitionId,
      handoffId,
      transitionKind: item.transitionKind as WorkSegmentInspectionProjectionV1['transitions'][number]['transitionKind'],
      sourceSegment,
      sourceWorkspaceRevision,
      targetPhaseId,
      targetPhaseIndex,
      targetPhaseOccurrence,
      targetSegmentOrdinal,
      cause,
    })
  }
  const projection: WorkSegmentInspectionProjectionV1 = {
    recovery: {
      state: recovery.state,
      phaseId: recoveryPhaseId,
      phaseIndex: recoveryPhaseIndex,
      phaseOccurrence: recoveryPhaseOccurrence,
      nextSegmentOrdinal,
      currentSegmentId,
      workspaceRevision,
      terminalCloseResult,
      terminalBoundaryClass,
      usage: { ...recoveryUsage, segments: recoverySegments },
    },
    segments,
    dispatches,
    transitions,
  }
  return hasCoherentWorkSegmentInspection(projection) ? projection : null
}
export function normalizeAgentRunInspectionDetailV1(value: unknown, expectedAttemptId?: string, expectedChatId?: string): AgentRunInspectionDetailV1 | null {
  if (!isUnknownRecord(value)
    || !Object.hasOwn(value, 'workSegments')
    || !isIndexedArray(value.transcript)
    || !isIndexedArray(value.turnSession)
    || !isIndexedArray(value.markers)
    || !isIndexedArray(value.usageEvidence)
    || !isIndexedArray(value.promptEvidence)
    || !isIndexedArray(value.renderCrossings)
    || !isIndexedArray(value.cortexReceipts)
    || !isIndexedArray(value.councilReceipts)
    || !isIndexedArray(value.workspaceAssociations)
    || !isIndexedArray(value.sectionAvailability)) return null
  const summary = normalizeInspectionSummary(value)
  const usage = normalizeInspectionUsageProjection(value.usage)
  const retry = normalizeInspectionRetry(value.retry)
  const workSegments = value.workSegments === null ? null : normalizeWorkSegmentInspection(value.workSegments)
  const error = value.error === null ? null : normalizeInspectionErrorDetail(value.error)
  const transcript = normalizeStrictInspectionArray(value.transcript, normalizeInspectionTranscriptRecord)
  const turnSession = normalizeStrictInspectionArray(value.turnSession, normalizeTurnSessionEntry)
  const markers = normalizeStrictInspectionArray(value.markers, normalizeInspectionMarker)
  const usageEvidence = normalizeStrictInspectionArray(value.usageEvidence, normalizeInspectionUsageEvidence)
  const promptEvidence = normalizeStrictInspectionArray(value.promptEvidence, normalizePromptEvidence)
  const renderCrossings = normalizeStrictInspectionArray(value.renderCrossings, normalizeRenderCrossing)
  const cortexReceipts = normalizeStrictInspectionArray(value.cortexReceipts, normalizeCortexReceipt)
  const councilReceipts = normalizeStrictInspectionArray(value.councilReceipts, normalizeCouncilReceipt)
  const workspaceAssociations = normalizeStrictInspectionArray(value.workspaceAssociations, normalizeWorkspaceAssociation)
  const stop = value.stop === null ? null : normalizeInspectionStop(value.stop)
  const sectionAvailability = inspectionAvailability(value.sectionAvailability)
  if (!summary || !usage || !retry || !sectionAvailability
    || expectedAttemptId !== undefined && summary.attempt.attemptId !== expectedAttemptId
    || expectedChatId !== undefined && summary.attempt.target.chatId !== expectedChatId
    || value.error !== null && !error
    || !transcript || !turnSession || !markers || !usageEvidence || !promptEvidence || hasPromptOccurrenceCollision(promptEvidence) || !renderCrossings || !cortexReceipts || !councilReceipts || !workspaceAssociations
    || value.stop !== null && !stop
    || value.workSegments !== null && !workSegments
    || usage.inspectionAttemptId !== summary.attempt.attemptId
    || retry.linkedAttemptId !== null && retry.linkedAttemptId !== summary.attempt.attemptId
    || error !== null && (error.inspectionAttemptId !== summary.attempt.attemptId || !sameWorkTarget(error.target, summary.attempt.target))
    || !sameActivityTarget(summary.activity.target, summary.attempt.target)) return null
  const correlations: AgentInspectionCorrelationV1[] = []
  const addCorrelation = (correlation: AgentInspectionCorrelationV1 | null) => {
    if (correlation) correlations.push(correlation)
  }
  transcript.forEach((item) => addCorrelation(item.correlation))
  turnSession.forEach((item) => addCorrelation(item.correlation))
  markers.forEach((item) => addCorrelation(item.correlation))
  usageEvidence.forEach((item) => addCorrelation(item.correlation))
  promptEvidence.forEach((item) => addCorrelation(item.correlation))
  renderCrossings.forEach((item) => addCorrelation(item.correlation))
  let invalidCortexScope = false
  cortexReceipts.forEach((item) => {
    if (item.attemptId !== summary.attempt.attemptId
      || item.scope.chatId !== summary.attempt.target.chatId
      || item.scope.targetMessageId !== summary.attempt.target.messageId
      || item.scope.targetSwipeId !== summary.attempt.target.swipeId) invalidCortexScope = true
    addCorrelation(item.correlation)
  })
  councilReceipts.forEach((item) => addCorrelation(item.correlation))
  workspaceAssociations.forEach((item) => addCorrelation(item.correlation))
  summary.activity.milestones.forEach((item) => {
    addCorrelation(item.correlation)
    addCorrelation(item.usage?.correlation ?? null)
  })
  summary.activity.markers.forEach((item) => addCorrelation(item.correlation))
  usage.layers.forEach((item) => addCorrelation(item.correlation))
  if (invalidCortexScope || correlations.some((correlation) => !sameInspectionCorrelationIdentity(correlation, summary))) return null
  return {
    ...summary,
    transcript,
    turnSession,
    markers,
    usageEvidence,
    usage,
    error,
    promptEvidence,
    renderCrossings,
    cortexReceipts,
    councilReceipts,
    workspaceAssociations,
    stop,
    retry,
    workSegments,
    sectionAvailability,
  }
}

export function normalizeAgentRunInspectionRetryResponseV1(value: unknown): AgentRunInspectionRetryResponseV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1 || typeof value.accepted !== 'boolean' || !isInspectionReason(value.reason)) return null
  const attempt = value.attempt === null ? null : normalizeAttempt(value.attempt)
  if (attempt === null && value.attempt !== null) return null
  const target = value.target === undefined ? undefined : normalizeWorkTarget(value.target)
  if (target === null) return null
  const recoveryAction = value.recoveryAction === undefined ? undefined : isRecoveryAction(value.recoveryAction) ? value.recoveryAction : null
  if (recoveryAction === null) return null
  const inspectionAttemptId: string | null | undefined = value.inspectionAttemptId === undefined ? undefined : value.inspectionAttemptId === null ? null : boundedString(value.inspectionAttemptId)
  if (inspectionAttemptId === null && value.inspectionAttemptId !== null) return null
  const recoveryEligible = value.recoveryEligible === undefined ? undefined : typeof value.recoveryEligible === 'boolean' ? value.recoveryEligible : null
  if (recoveryEligible === null) return null
  const error = value.error === undefined ? undefined : normalizeError(value.error)
  if (value.error !== undefined && !error) return null
  const reason = value.reason
  return { version: 1, accepted: value.accepted, attempt, reason, ...(target ? { target } : {}), ...(recoveryEligible === undefined ? {} : { recoveryEligible }), ...(recoveryAction ? { recoveryAction } : {}), ...(inspectionAttemptId !== undefined ? { inspectionAttemptId } : {}), ...(error ? { error } : {}) }
}

export function normalizeAgentRunInspectionListV1(value: unknown): AgentRunInspectionListV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1 || !isIndexedArray(value.runs) || value.runs.length > MAX_INSPECTION_LIST_RUNS) return null
  const chatId = boundedString(value.chatId)
  if (!chatId) return null
  const nextCursor = value.nextCursor === null ? null : boundedString(value.nextCursor, MAX_CURSOR_LENGTH)
  if (nextCursor === null && value.nextCursor !== null) return null
  const omission = value.omission === null ? null : normalizeInspectionMarker(value.omission)
  const runs: AgentRunInspectionSummaryV1[] = []
  for (const raw of value.runs) {
    const run = normalizeInspectionSummary(raw)
    if (!run || run.attempt.target.chatId !== chatId) return null
    runs.push(run)
  }
  if (value.omission !== null && !omission || omission !== null && omission.correlation !== null && omission.correlation.chatId !== chatId) return null
  return { version: 1, chatId, runs, nextCursor, omission }
}

export function agentRunProvisionalKey(run: Pick<AgentRunPublicV2, 'chatId' | 'turnId' | 'generationType' | 'target'>): string {
  const target = run.target ? `${run.target.messageId}:${run.target.swipeId}` : 'pending'
  return `${run.chatId}:${run.turnId}:${run.generationType}:${target}`
}
export function agentRunTerminalTargetKey(chatId: string, messageId: string, swipeId: number): string {
  return `${chatId}:${messageId}:${swipeId}`
}
function compareNumber(left: number, right: number): number { return left === right ? 0 : left < right ? -1 : 1 }
function compareText(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1 }
function isTerminalRun(run: AgentRunPublicV2): boolean { return TERMINAL_STATUSES[run.workStatus] }
function isActiveRun(run: AgentRunPublicV2): boolean { return !isTerminalRun(run) }
function compareRunVersion(candidate: AgentRunPublicV2, current: AgentRunPublicV2): number {
  for (const [left, right] of [[candidate.revision, current.revision], [candidate.sequence, current.sequence], [candidate.updatedAt, current.updatedAt], [candidate.startedAt, current.startedAt]] as const) {
    const result = compareNumber(left, right)
    if (result !== 0) return result
  }
  for (const [left, right] of [[candidate.runId, current.runId], [candidate.generationId, current.generationId], [candidate.turnId, current.turnId]] as const) {
    const result = compareText(left, right)
    if (result !== 0) return result
  }
  return 0
}
function compareRunFreshness(candidate: AgentRunPublicV2, current: AgentRunPublicV2): number {
  for (const [left, right] of [[candidate.sequence, current.sequence], [candidate.updatedAt, current.updatedAt], [candidate.startedAt, current.startedAt], [candidate.revision, current.revision]] as const) {
    const result = compareNumber(left, right)
    if (result !== 0) return result
  }
  if (isActiveRun(candidate) !== isActiveRun(current)) return isActiveRun(candidate) ? 1 : -1
  return compareText(candidate.runId, current.runId)
}
function targetRevision(run: AgentRunPublicV2): readonly [number, number] | null {
  const handoff = run.terminalHandoff
  return handoff?.committed && handoff.messageRevision !== null && handoff.swipeRevision !== null ? [handoff.messageRevision, handoff.swipeRevision] : null
}
function compareTargetAuthority(candidate: AgentRunPublicV2, current: AgentRunPublicV2): number {
  const left = targetRevision(candidate)
  const right = targetRevision(current)
  if (left && right) {
    const message = compareNumber(left[0], right[0])
    if (message !== 0) return message
    const swipe = compareNumber(left[1], right[1])
    if (swipe !== 0) return swipe
  }
  return compareRunFreshness(candidate, current)
}
function runTargets(run: AgentRunPublicV2, chatId: string, messageId: string, swipeId: number): boolean {
  if (run.chatId !== chatId) return false
  if (run.target?.messageId === messageId && run.target.swipeId === swipeId) return true
  const handoff = run.terminalHandoff
  return handoff?.committed === true && handoff.messageId === messageId && handoff.swipeId === swipeId
}
function findRunByTurnId(state: Pick<AgentRunsSlice, 'agentRunProvisionalByKey' | 'agentRunTerminalByTarget'>, turnId: string): AgentRunPublicV2 | undefined {
  let selected: AgentRunPublicV2 | undefined
  for (const run of [...Object.values(state.agentRunTerminalByTarget), ...Object.values(state.agentRunProvisionalByKey)]) if (run.turnId === turnId && (!selected || compareRunVersion(run, selected) > 0)) selected = run
  return selected
}
function mergeRun(provisional: Record<string, AgentRunPublicV2>, terminal: Record<string, AgentRunPublicV2>, run: AgentRunPublicV2): void {
  const current = findRunByTurnId({ agentRunProvisionalByKey: provisional, agentRunTerminalByTarget: terminal }, run.turnId)
  if (current && compareRunVersion(run, current) <= 0) return
  if (run.terminalHandoff?.committed && run.terminalHandoff.messageId !== null && run.terminalHandoff.swipeId !== null) {
    const key = agentRunTerminalTargetKey(run.chatId, run.terminalHandoff.messageId, run.terminalHandoff.swipeId)
    const destination = terminal[key]
    if (destination && destination.turnId !== run.turnId && compareTargetAuthority(run, destination) <= 0) return
  }
  for (const [key, value] of Object.entries(provisional)) if (value.turnId === run.turnId) delete provisional[key]
  for (const [key, value] of Object.entries(terminal)) if (value.turnId === run.turnId) delete terminal[key]
  if (run.terminalHandoff?.committed && run.terminalHandoff.messageId !== null && run.terminalHandoff.swipeId !== null) terminal[agentRunTerminalTargetKey(run.chatId, run.terminalHandoff.messageId, run.terminalHandoff.swipeId)] = run
  else provisional[agentRunProvisionalKey(run)] = run
}

type ExactTerminalRequestState = Pick<AppStore,
  'agentRunProvisionalByKey' | 'agentRunTerminalByTarget' | 'generationRequests' | 'settleGenerationRequest'
>

function findRunByGeneration(
  state: Pick<AgentRunsSlice, 'agentRunProvisionalByKey' | 'agentRunTerminalByTarget'>,
  chatId: string,
  generationId: string,
): AgentRunPublicV2 | undefined {
  let selected: AgentRunPublicV2 | undefined
  for (const run of [...Object.values(state.agentRunTerminalByTarget), ...Object.values(state.agentRunProvisionalByKey)]) {
    if (
      run.chatId === chatId
      && run.generationId === generationId
      && (!selected || compareRunFreshness(run, selected) > 0)
    ) selected = run
  }
  return selected
}

export function settleGenerationRequestFromExactTerminalRun(
  state: ExactTerminalRequestState,
  chatId: string,
  generationId: string,
): boolean {
  const request = state.generationRequests[chatId]
  const run = findRunByGeneration(state, chatId, generationId)
  if (request?.generationId !== generationId || run?.workStatus !== 'terminal' || run.workOutcome === null) return false
  const status = run.workOutcome === 'completed'
    ? 'completed'
    : run.workOutcome === 'stopped'
      ? 'stopped'
      : 'error'
  return state.settleGenerationRequest(
    chatId,
    status,
    generationId,
    request.requestAuthorityId,
  )
}

function settleExactTerminalGenerationRequest(get: () => AppStore, run: AgentRunPublicV2): void {
  if (run.workStatus !== 'terminal' || run.workOutcome === null) return
  settleGenerationRequestFromExactTerminalRun(get(), run.chatId, run.generationId)
}
function withoutChat<T extends AgentRunPublicV2>(values: Record<string, T>, chatId: string): Record<string, T> {
  return Object.fromEntries(Object.entries(values).filter(([, run]) => run.chatId !== chatId))
}
function workspaceRequestKey(turnId: string, section?: AgentWorkspaceSectionV2): string { return `${turnId}:${section ?? 'index'}` }
function emptyWorkspaceSectionPreview(
  turnId: string,
  section: AgentWorkspaceSectionV2,
  workspaceRevision: number,
): AgentWorkspaceSectionPreviewV2 {
  return {
    version: 2,
    turnId,
    section,
    workspaceRevision,
    entries: [],
    nextPage: null,
    omitted: 0,
  }
}
export function normalizePersistentWorkspace(
  value: unknown,
  expectedWorkspaceId?: string,
  expectedChatId?: string | null,
): AgentPersistentWorkspaceV1 | null {
  if (!isUnknownRecord(value) || value.version !== 1) return null
  const id = boundedString(value.id)
  const userId = boundedString(value.userId)
  const chatId = value.chatId === null ? null : boundedString(value.chatId)
  const objective = isText(value.objective) ? value.objective : null
  const revision = nonNegativeInteger(value.revision)
  const createdAt = dateSeconds(value.createdAt)
  const updatedAt = dateSeconds(value.updatedAt)
  if (!id || !userId || chatId === null && value.chatId !== null || objective === null || revision === null || createdAt === null || updatedAt === null
    || !isUnknownRecord(value.metadata) || !isUnknownRecord(value.progress) || !isUnknownRecord(value.quota) || !isUnknownRecord(value.usage)
    || expectedWorkspaceId !== undefined && id !== expectedWorkspaceId
    || expectedChatId !== undefined && chatId !== expectedChatId) return null
  const metadata = value.metadata
  const labels = isStringArray(metadata.labels) ? metadata.labels : null
  const progressState = ['not_started', 'in_progress', 'blocked', 'completed'].includes(String(value.progress.state))
  const percent = typeof value.progress.percent === 'number' && Number.isFinite(value.progress.percent) && value.progress.percent >= 0 && value.progress.percent <= 100 ? value.progress.percent : null
  const progressUpdatedAt = dateSeconds(value.progress.updatedAt)
  const quotaValues = ['maxTasks', 'maxRecords', 'maxSubmissions', 'maxArtifacts', 'maxPublications', 'maxBytes'].map((key) => nonNegativeInteger(value.quota[key]))
  const usageValues = ['taskCount', 'recordCount', 'submissionCount', 'artifactCount', 'publicationCount', 'byteCount'].map((key) => nonNegativeInteger(value.usage[key]))
  if (!isText(metadata.title) || !isText(metadata.summary) || !labels || !isText(metadata.ownerNote) || !progressState || percent === null
    || !isText(value.progress.summary) || progressUpdatedAt === null || !['active', 'archived'].includes(String(value.state))
    || quotaValues.some((item) => item === null) || usageValues.some((item) => item === null)) return null
  return {
    version: 1,
    id,
    userId,
    chatId,
    objective,
    metadata: { title: metadata.title, summary: metadata.summary, labels, ownerNote: metadata.ownerNote },
    progress: { state: value.progress.state as AgentPersistentWorkspaceV1['progress']['state'], percent, summary: value.progress.summary, updatedAt: progressUpdatedAt },
    state: value.state as AgentPersistentWorkspaceV1['state'],
    revision,
    quota: { maxTasks: quotaValues[0]!, maxRecords: quotaValues[1]!, maxSubmissions: quotaValues[2]!, maxArtifacts: quotaValues[3]!, maxPublications: quotaValues[4]!, maxBytes: quotaValues[5]! },
    usage: { taskCount: usageValues[0]!, recordCount: usageValues[1]!, submissionCount: usageValues[2]!, artifactCount: usageValues[3]!, publicationCount: usageValues[4]!, byteCount: usageValues[5]! },
    createdAt,
    updatedAt,
  }
}

type PersistentWorkspaceCollectionItemMapV1 = {
  sessions: AgentPersistentWorkspaceTurnSessionV1
  tasks: AgentPersistentWorkspaceTaskV1
  records: AgentPersistentWorkspaceRecordV1
  artifacts: AgentPersistentWorkspaceArtifactV1
  submissions: AgentPersistentWorkspaceSubmissionV1
  publications: AgentPersistentWorkspacePublicationV1
}
type PersistentWorkspaceCollectionArrayMapV1 = {
  [Collection in AgentPersistentWorkspaceCollectionV1]: PersistentWorkspaceCollectionItemMapV1[Collection][]
}
function isText(value: unknown): value is string { return typeof value === 'string' && UTF8_ENCODER.encode(value).byteLength <= MAX_WORKSPACE_TEXT_LENGTH }
function isNullableText(value: unknown): value is string | null { return value === null || isText(value) }
function isNullableBoundedIdentifier(value: unknown): value is string | null {
  return value === null || boundedString(value) !== null
}
function isStringArray(value: unknown): value is string[] {
  return isIndexedArray(value) && value.length <= MAX_WORKSPACE_STRING_ARRAY_ITEMS && value.every((item) => boundedString(item, MAX_WORKSPACE_TEXT_LENGTH) !== null)
}
function isNullableNonNegativeInteger(value: unknown): boolean { return value === null || nonNegativeInteger(value) !== null }
function isNullableDateSeconds(value: unknown): boolean { return value === null || dateSeconds(value) !== null }
function isPersistentWorkspaceProgressShape(value: unknown): boolean {
  if (!isUnknownRecord(value)) return false
  return ['not_started', 'in_progress', 'blocked', 'completed'].includes(String(value.state))
    && typeof value.percent === 'number'
    && Number.isFinite(value.percent)
    && value.percent >= 0
    && value.percent <= 100
    && isText(value.summary)
    && dateSeconds(value.updatedAt) !== null
}
function isPersistentWorkspaceMetadataShape(value: unknown): boolean {
  if (!isUnknownRecord(value)) return false
  return isText(value.title) && isText(value.summary) && isStringArray(value.labels) && isText(value.ownerNote)
}
function isPersistentWorkspaceRecordContentShape(value: unknown): boolean {
  if (!isUnknownRecord(value)) return false
  return isText(value.summary) && isStringArray(value.evidenceIds) && isNullableText(value.provenance)
}
function isPersistentWorkspacePublicationCopyShape(value: unknown): boolean {
  if (!isUnknownRecord(value) || !isText(value.category) || !isText(value.id)) return false
  if (value.category === 'task') {
    return isText(value.title)
      && isText(value.objective)
      && ['pending', 'active', 'blocked', 'completed', 'cancelled', 'failed'].includes(String(value.state))
      && typeof value.required === 'boolean'
      && isStringArray(value.dependencyIds)
      && isPersistentWorkspaceProgressShape(value.progress)
      && isText(value.summary)
  }
  if (value.category === 'finding') return isPersistentWorkspaceRecordContentShape(value.content) && isNullableBoundedIdentifier(value.taskId)
  if (value.category === 'objective') return isText(value.objective) && isPersistentWorkspaceMetadataShape(value.metadata)
  if (value.category === 'artifact') return isText(value.blobDigest) && isText(value.mimeType) && nonNegativeInteger(value.byteCount) !== null && isText(value.provenance)
  return false
}
function hasPersistentWorkspaceCollectionShape(collection: AgentPersistentWorkspaceCollectionV1, item: Record<string, unknown>): boolean {
  const identity = boundedString(item.workspaceId)
    && boundedString(item.userId)
    && isNullableBoundedIdentifier(item.chatId)
    && nonNegativeInteger(item.revision) !== null
  if (!identity) return false
  if (collection === 'publications') {
    return (item.category === 'task' || item.category === 'finding' || item.category === 'objective' || item.category === 'artifact')
      && boundedString(item.sourceId)
      && nonNegativeInteger(item.sourceRevision) !== null
      && isText(item.sourceDigest)
      && isUnknownRecord(item.sourceProvenance)
      && boundedString(item.sourceProvenance.workspaceId)
      && isNullableBoundedIdentifier(item.sourceProvenance.turnSessionId)
      && isNullableBoundedIdentifier(item.sourceProvenance.attemptId)
      && isNullableBoundedIdentifier(item.sourceProvenance.executionId)
      && isText(item.sourceProvenance.sourceDigest)
      && isNullableBoundedIdentifier(item.sourceProvenance.sourceChatId)
      && isNullableBoundedIdentifier(item.sourceProvenance.sourceMessageId)
      && isNullableNonNegativeInteger(item.sourceProvenance.sourceSwipeId)
      && isNullableDateSeconds(item.sourceProvenance.sourceDeletedAt)
      && isText(item.sourceProvenance.creator)
      && dateSeconds(item.sourceProvenance.capturedAt) !== null
      && dateSeconds(item.sourceCreatedAt) !== null
      && dateSeconds(item.sourceUpdatedAt) !== null
      && isNullableDateSeconds(item.sourceDeletedAt)
      && (item.sourceStatus === 'present' || item.sourceStatus === 'deleted')
      && isUnknownRecord(item.copy)
      && item.copy.category === item.category
      && isPersistentWorkspacePublicationCopyShape(item.copy)
      && isText(item.copyDigest)
      && dateSeconds(item.publishedAt) !== null
      && isText(item.publishedBy)
      && item.revision === 1
  }
  const common = identity
    && dateSeconds(item.createdAt) !== null
    && dateSeconds(item.updatedAt) !== null
  if (!common) return false
  if (collection === 'sessions') {
    return isNullableBoundedIdentifier(item.chatId)
      && boundedString(item.turnId)
      && boundedString(item.attemptId)
      && isNullableBoundedIdentifier(item.executionId)
      && isRunPhase(item.phase)
      && isRunStatus(item.status)
      && (item.outcome === null || isRunOutcome(item.outcome))
      && isNullableDateSeconds(item.terminalAt)
  }
  if (collection === 'tasks') {
    return isNullableBoundedIdentifier(item.turnSessionId)
      && isText(item.title)
      && isText(item.objective)
      && ['pending', 'active', 'blocked', 'completed', 'cancelled', 'failed'].includes(String(item.state))
      && typeof item.required === 'boolean'
      && isStringArray(item.dependencyIds)
      && (item.creator === 'host' || item.creator === 'owner')
      && typeof item.hostAdmitted === 'boolean'
      && isPersistentWorkspaceProgressShape(item.progress)
      && isText(item.summary)
  }
  if (collection === 'records') {
    return isNullableBoundedIdentifier(item.turnSessionId)
      && isNullableBoundedIdentifier(item.chatId)
      && (item.kind === 'finding' || item.kind === 'decision' || item.kind === 'question')
      && isPersistentWorkspaceRecordContentShape(item.content)
      && isNullableBoundedIdentifier(item.taskId)
  }
  if (collection === 'submissions') {
    return isNullableBoundedIdentifier(item.turnSessionId)
      && boundedString(item.taskId)
      && isNullableBoundedIdentifier(item.chatId)
      && (item.state === 'submitted' || item.state === 'accepted' || item.state === 'rejected')
      && isText(item.summary)
      && isText(item.resultDigest)
  }
  if (collection === 'artifacts') {
    return isNullableBoundedIdentifier(item.turnSessionId)
      && isNullableBoundedIdentifier(item.chatId)
      && isText(item.blobDigest)
      && isText(item.mimeType)
      && nonNegativeInteger(item.byteCount) !== null
      && isText(item.provenance)
  }
  return false
}
function isRunOutcome(value: unknown): value is AgentRunOutcomeV2 {
  return typeof value === 'string' && Object.hasOwn(RUN_OUTCOMES, value)
}
export function normalizePersistentWorkspaceCollection<C extends AgentPersistentWorkspaceCollectionV1>(
  collection: C,
  value: unknown,
  expectedWorkspaceId?: string,
): PersistentWorkspaceCollectionArrayMapV1[C] | null {
  if (!isIndexedArray(value) || value.length > MAX_WORKSPACE_COLLECTION_ITEMS) return null
  const items: unknown[] = []
  for (const item of value) {
    if (!isUnknownRecord(item) || item.version !== 1 || !boundedString(item.id) || !hasPersistentWorkspaceCollectionShape(collection, item)
      || expectedWorkspaceId !== undefined && item.workspaceId !== expectedWorkspaceId) return null
    items.push(item)
  }
  return items as PersistentWorkspaceCollectionArrayMapV1[C]
}
export function normalizePersistentWorkspaceTurnSessionPage(
  value: unknown,
  expectedWorkspaceId?: string,
  expectedOffset?: number,
): AgentPersistentWorkspaceTurnSessionPageV1 | null {
  if (!isUnknownRecord(value)
    || !isIndexedArray(value.data)
    || value.data.length > MAX_WORKSPACE_COLLECTION_ITEMS) return null
  const total = nonNegativeInteger(value.total)
  const limit = nonNegativeInteger(value.limit)
  const offset = nonNegativeInteger(value.offset)
  if (total === null || limit === null || limit < 1 || limit > 1_000 || offset === null
    || expectedOffset !== undefined && (nonNegativeInteger(expectedOffset) === null || offset !== expectedOffset)
    || offset > total
    || value.data.length > total - offset
    || value.data.length > limit
    || value.data.length !== Math.min(limit, total - offset)) return null
  const items: unknown[] = []
  const seenIds = new Set<string>()
  for (const item of value.data) {
    const id = isUnknownRecord(item) ? boundedString(item.id) : null
    if (!isUnknownRecord(item) || item.version !== 1 || !id || seenIds.has(id) || !hasPersistentWorkspaceCollectionShape('sessions', item)
      || expectedWorkspaceId !== undefined && item.workspaceId !== expectedWorkspaceId) return null
    seenIds.add(id)
    items.push(item)
  }
  return { data: items as AgentPersistentWorkspaceTurnSessionV1[], total, limit, offset }
}
function emptyPersistentWorkspaceCollections(): AgentPersistentWorkspaceCollectionsStateV1 {
  return {
    sessions: { status: 'idle', items: [], error: null },
    sessionsPage: { total: 0, limit: 0, offset: 0, nextOffset: 0 },
    tasks: { status: 'idle', items: [], error: null },
    records: { status: 'idle', items: [], error: null },
    artifacts: { status: 'idle', items: [], error: null },
    submissions: { status: 'idle', items: [], error: null },
    publications: { status: 'idle', items: [], error: null },
  }
}
function readyPersistentWorkspaceCollections(
  current: AgentPersistentWorkspaceCollectionsStateV1,
  collection: AgentPersistentWorkspaceCollectionV1,
  items: PersistentWorkspaceCollectionArrayMapV1[AgentPersistentWorkspaceCollectionV1],
): AgentPersistentWorkspaceCollectionsStateV1 {
  if (collection === 'sessions') return { ...current, sessions: { status: 'ready', items: items as AgentPersistentWorkspaceTurnSessionV1[], error: null } }
  if (collection === 'tasks') return { ...current, tasks: { status: 'ready', items: items as AgentPersistentWorkspaceTaskV1[], error: null } }
  if (collection === 'records') return { ...current, records: { status: 'ready', items: items as AgentPersistentWorkspaceRecordV1[], error: null } }
  if (collection === 'artifacts') return { ...current, artifacts: { status: 'ready', items: items as AgentPersistentWorkspaceArtifactV1[], error: null } }
  if (collection === 'submissions') return { ...current, submissions: { status: 'ready', items: items as AgentPersistentWorkspaceSubmissionV1[], error: null } }
  return { ...current, publications: { status: 'ready', items: items as AgentPersistentWorkspacePublicationV1[], error: null } }
}

export const createAgentRunsSlice: StateCreator<AppStore, [], [], AgentRunsSlice> = (set, get) => ({
  agentRunProvisionalByKey: {},
  agentRunTerminalByTarget: {},
  agentRunCursorByChat: {},
  agentRunLastSequenceByChat: {},
  agentRunCursorSequenceByChat: {},
  agentRunResyncOffsetByChat: {},
  agentRunResyncDescriptorByChat: {},
  agentRunSyncByChat: {},
  agentRunOmittedEventsByChat: {},
  agentRunRequestEpochByChat: {},
  agentRunInspectionByAttemptId: {},
  agentRunInspectionListByChat: {},
  agentRunInspectionRequestEpochByKey: {},
  agentRunRetryByAttemptId: {},
  agentWorkspaceByTurn: {},
  agentWorkspaceRequestEpochByKey: {},
  agentPersistentWorkspaceByChat: {},
  agentPersistentWorkspaceById: {},
  agentPersistentWorkspaceRequestEpochByKey: {},
  agentPersistentWorkspaceCollectionsById: {},
  agentRuntimeSettingsByChat: {},

  beginAgentRunRestore: (chatId) => {
    const epoch = (get().agentRunRequestEpochByChat[chatId] ?? 0) + 1
    set((state) => {
      const offsets = { ...state.agentRunResyncOffsetByChat }
      const descriptors = { ...state.agentRunResyncDescriptorByChat }
      delete offsets[chatId]
      delete descriptors[chatId]
      return {
        agentRunRequestEpochByChat: { ...state.agentRunRequestEpochByChat, [chatId]: epoch },
        agentRunResyncOffsetByChat: offsets,
        agentRunResyncDescriptorByChat: descriptors,
        agentRunSyncByChat: { ...state.agentRunSyncByChat, [chatId]: 'restoring' },
      }
    })
    return epoch
  },
  applyAgentRunChanges: (chatId, requestEpoch, payload) => {
    const normalized = normalizeAgentRunChangesV2(payload)
    const state = get()
    const requestIsCurrent = state.agentRunRequestEpochByChat[chatId] === requestEpoch
    const reject = () => {
      if (!requestIsCurrent || state.activeChatId !== chatId) return
      set((current) => {
        if (current.agentRunRequestEpochByChat[chatId] !== requestEpoch || current.activeChatId !== chatId) return {}
        const offsets = { ...current.agentRunResyncOffsetByChat }
        const descriptors = { ...current.agentRunResyncDescriptorByChat }
        delete offsets[chatId]
        delete descriptors[chatId]
        return {
          agentRunResyncOffsetByChat: offsets,
          agentRunResyncDescriptorByChat: descriptors,
          agentRunSyncByChat: { ...current.agentRunSyncByChat, [chatId]: 'error' },
        }
      })
    }
    if (!normalized || normalized.chatId !== chatId) {
      reject()
      return false
    }
    if (state.activeChatId !== chatId || !requestIsCurrent) return false
    const descriptor = state.agentRunResyncDescriptorByChat[chatId]
    const page = normalized.resyncPage
    const incomingOffset = page?.offset
    const incomingKeys = normalized.resync
      ? normalized.runs.flatMap((run) => resyncRunIdentityKeys(run))
      : []
    const incomingIdentitySet = new Set(incomingKeys)
    const duplicateInPage = incomingIdentitySet.size !== incomingKeys.length
    const overlapsAcceptedPage = descriptor !== undefined
      && incomingKeys.some((key) => descriptor.identities[key] === true)
    const previousCursorSequence = state.agentRunCursorSequenceByChat[chatId]
    const invalidContinuation = normalized.resync
      ? page === undefined
        || incomingOffset !== (descriptor?.nextOffset ?? 0)
        || descriptor !== undefined && (
          page.snapshotSequence !== descriptor.snapshotSequence
          || page.totalRuns !== descriptor.totalRuns
          || page.omittedOlderRuns !== descriptor.omittedOlderRuns
          || normalized.cursorSequence !== descriptor.snapshotSequence
        )
        || previousCursorSequence !== undefined
          && normalized.cursorSequence < previousCursorSequence
          && page.complete === false
        || duplicateInPage
        || overlapsAcceptedPage
      : descriptor !== undefined
    if (invalidContinuation) {
      reject()
      return false
    }
    set((current) => {
      const consumed = current.agentRunCursorSequenceByChat[chatId] ?? 0
      const incoming = normalized.cursorSequence
      const responseIsOlder = incoming < consumed
      const incomingOffset = normalized.resyncPage?.offset ?? 0
      const cursorShouldAdvance = !responseIsOlder && (
        current.agentRunCursorByChat[chatId] === undefined
        || incoming >= consumed
        || normalized.resync && (descriptor === undefined || incomingOffset >= (descriptor?.nextOffset ?? 0))
      )
      let provisional = { ...current.agentRunProvisionalByKey }
      let terminal = { ...current.agentRunTerminalByTarget }
      if (normalized.resync && incomingOffset === 0) {
        const preserved = [...Object.values(provisional), ...Object.values(terminal)].filter((run) => run.chatId === chatId && run.sequence >= incoming)
        provisional = withoutChat(provisional, chatId)
        terminal = withoutChat(terminal, chatId)
        preserved.forEach((run) => mergeRun(provisional, terminal, run))
      }
      normalized.runs.forEach((run) => mergeRun(provisional, terminal, run))
      normalized.events.slice().sort((left, right) => left.sequence - right.sequence).forEach((event) => mergeRun(provisional, terminal, event.run))
      const nextConsumed = cursorShouldAdvance ? incoming : consumed
      const nextPublic = Math.max(current.agentRunLastSequenceByChat[chatId] ?? 0, normalized.lastSequence, ...normalized.events.map((event) => event.sequence))
      const incompleteResync = normalized.resync && normalized.resyncPage?.complete === false
      const nextSync = responseIsOlder || normalized.hasMore || incompleteResync || nextConsumed < nextPublic ? 'stale' : 'ready'
      const nextOffsets = { ...current.agentRunResyncOffsetByChat }
      const nextDescriptors = { ...current.agentRunResyncDescriptorByChat }
      if (incompleteResync && cursorShouldAdvance) {
        const nextPage = normalized.resyncPage!
        nextOffsets[chatId] = nextPage.offset + normalized.runs.length
        nextDescriptors[chatId] = {
          snapshotSequence: nextPage.snapshotSequence,
          totalRuns: nextPage.totalRuns,
          omittedOlderRuns: nextPage.omittedOlderRuns,
          nextOffset: nextPage.offset + normalized.runs.length,
          identities: {
            ...(descriptor?.identities ?? {}),
            ...resyncRunIdentityRecord(normalized.runs),
          },
        }
      } else {
        delete nextOffsets[chatId]
        delete nextDescriptors[chatId]
      }
      return {
        agentRunProvisionalByKey: provisional,
        agentRunTerminalByTarget: terminal,
        agentRunCursorByChat: cursorShouldAdvance ? { ...current.agentRunCursorByChat, [chatId]: normalized.cursor.token } : current.agentRunCursorByChat,
        agentRunLastSequenceByChat: { ...current.agentRunLastSequenceByChat, [chatId]: nextPublic },
        agentRunCursorSequenceByChat: cursorShouldAdvance ? { ...current.agentRunCursorSequenceByChat, [chatId]: incoming } : current.agentRunCursorSequenceByChat,
        agentRunResyncOffsetByChat: nextOffsets,
        agentRunResyncDescriptorByChat: nextDescriptors,
        agentRunSyncByChat: { ...current.agentRunSyncByChat, [chatId]: nextSync },
        agentRunOmittedEventsByChat: { ...current.agentRunOmittedEventsByChat, [chatId]: Math.max(current.agentRunOmittedEventsByChat[chatId] ?? 0, normalized.omission.omittedEventCount) },
      }
    })
    normalized.runs.forEach((run) => settleExactTerminalGenerationRequest(get, run))
    normalized.events.forEach((event) => settleExactTerminalGenerationRequest(get, event.run))
    return true
  },
  failAgentRunRestore: (chatId, requestEpoch) => {
    if (get().agentRunRequestEpochByChat[chatId] !== requestEpoch) return
    set((state) => {
      const offsets = { ...state.agentRunResyncOffsetByChat }
      const descriptors = { ...state.agentRunResyncDescriptorByChat }
      delete offsets[chatId]
      delete descriptors[chatId]
      return {
        agentRunResyncOffsetByChat: offsets,
        agentRunResyncDescriptorByChat: descriptors,
        agentRunSyncByChat: { ...state.agentRunSyncByChat, [chatId]: 'error' },
      }
    })
  },
  reconcileAgentRunEvent: (payload) => {
    const event = normalizeAgentRunChangeEventV2(payload)
    if (!event) return 'rejected'
    const currentSequence = get().agentRunLastSequenceByChat[event.chatId] ?? 0
    if (event.sequence <= currentSequence) return 'stale'
    const gap = event.sequence > currentSequence + 1
    set((state) => {
      const provisional = { ...state.agentRunProvisionalByKey }
      const terminal = { ...state.agentRunTerminalByTarget }
      mergeRun(provisional, terminal, event.run)
      return {
        agentRunProvisionalByKey: provisional,
        agentRunTerminalByTarget: terminal,
        agentRunLastSequenceByChat: { ...state.agentRunLastSequenceByChat, [event.chatId]: event.sequence },
        agentRunSyncByChat: { ...state.agentRunSyncByChat, [event.chatId]: gap ? 'stale' : state.agentRunSyncByChat[event.chatId] ?? 'ready' },
        agentRunOmittedEventsByChat: { ...state.agentRunOmittedEventsByChat, [event.chatId]: (state.agentRunOmittedEventsByChat[event.chatId] ?? 0) + event.omission.omittedEventCount + (gap ? event.sequence - currentSequence - 1 : 0) },
      }
    })
    settleExactTerminalGenerationRequest(get, event.run)
    return gap ? 'gap' : 'applied'
  },
  reconcileExactAgentRun: (chatId, payload) => {
    const run = normalizeAgentRunPublicV2(payload)
    if (!run || run.chatId !== chatId || get().activeChatId !== chatId) return false
    set((state) => {
      const provisional = { ...state.agentRunProvisionalByKey }
      const terminal = { ...state.agentRunTerminalByTarget }
      mergeRun(provisional, terminal, run)
      return { agentRunProvisionalByKey: provisional, agentRunTerminalByTarget: terminal }
    })
    settleExactTerminalGenerationRequest(get, run)
    return true
  },
  markAgentRunsStale: (chatId) => set((state) => {
    const ids: string[] = chatId ? [chatId] : [...Object.values(state.agentRunProvisionalByKey).map((run) => run.chatId), ...Object.values(state.agentRunTerminalByTarget).map((run) => run.chatId), ...Object.keys(state.agentRunCursorByChat)]
    const sync = { ...state.agentRunSyncByChat }
    ids.forEach((id: string) => { sync[id] = 'stale' })
    return { agentRunSyncByChat: sync }
  }),
  clearAgentRunsForChat: (chatId) => set((state) => {
    const cursor = { ...state.agentRunCursorByChat }
    const sequence = { ...state.agentRunLastSequenceByChat }
    const cursorSequence = { ...state.agentRunCursorSequenceByChat }
    const resyncOffset = { ...state.agentRunResyncOffsetByChat }
    const resyncDescriptor = { ...state.agentRunResyncDescriptorByChat }
    const sync = { ...state.agentRunSyncByChat }
    const omitted = { ...state.agentRunOmittedEventsByChat }
    delete cursor[chatId]; delete sequence[chatId]; delete cursorSequence[chatId]; delete resyncOffset[chatId]; delete resyncDescriptor[chatId]; delete sync[chatId]; delete omitted[chatId]
    return { agentRunProvisionalByKey: withoutChat(state.agentRunProvisionalByKey, chatId), agentRunTerminalByTarget: withoutChat(state.agentRunTerminalByTarget, chatId), agentRunCursorByChat: cursor, agentRunLastSequenceByChat: sequence, agentRunCursorSequenceByChat: cursorSequence, agentRunResyncOffsetByChat: resyncOffset, agentRunResyncDescriptorByChat: resyncDescriptor, agentRunSyncByChat: sync, agentRunOmittedEventsByChat: omitted }
  }),

  beginAgentRunInspection: (chatId, attemptId) => {
    const key = `${chatId}:${attemptId}`
    const epoch = (get().agentRunInspectionRequestEpochByKey[key] ?? 0) + 1
    set((state) => ({ agentRunInspectionRequestEpochByKey: { ...state.agentRunInspectionRequestEpochByKey, [key]: epoch }, agentRunInspectionByAttemptId: { ...state.agentRunInspectionByAttemptId, [attemptId]: { status: 'loading', availability: 'live', detail: state.agentRunInspectionByAttemptId[attemptId]?.detail ?? null, error: null } } }))
    return epoch
  },
  applyAgentRunInspection: (chatId, attemptId, requestEpoch, payload) => {
    const detail = normalizeAgentRunInspectionDetailV1(payload, attemptId, chatId)
    const key = `${chatId}:${attemptId}`
    if (!detail || detail.attempt.attemptId !== attemptId || detail.attempt.target.chatId !== chatId || get().agentRunInspectionRequestEpochByKey[key] !== requestEpoch) return false
    const availability = detail.activity.reconciliation === 'recovered' ? 'recovered' : detail.terminal ? 'terminal' : 'live'
    set((state) => ({ agentRunInspectionByAttemptId: { ...state.agentRunInspectionByAttemptId, [attemptId]: { status: 'ready', availability, detail, error: null } } }))
    return true
  },
  failAgentRunInspection: (chatId, attemptId, requestEpoch, availability, error) => {
    const key = `${chatId}:${attemptId}`
    if (get().agentRunInspectionRequestEpochByKey[key] !== requestEpoch) return
    set((state) => ({ agentRunInspectionByAttemptId: { ...state.agentRunInspectionByAttemptId, [attemptId]: { status: 'error', availability, detail: state.agentRunInspectionByAttemptId[attemptId]?.detail ?? null, error: error ?? null } } }))
  },
  clearAgentRunInspection: (attemptId) => set((state) => {
    const inspections = { ...state.agentRunInspectionByAttemptId }
    delete inspections[attemptId]
    return { agentRunInspectionByAttemptId: inspections }
  }),
  beginAgentRunInspectionList: (chatId) => {
    const key = `list:${chatId}`
    const epoch = (get().agentRunInspectionRequestEpochByKey[key] ?? 0) + 1
    set((state) => ({ agentRunInspectionRequestEpochByKey: { ...state.agentRunInspectionRequestEpochByKey, [key]: epoch }, agentRunInspectionListByChat: { ...state.agentRunInspectionListByChat, [chatId]: { status: 'loading', list: state.agentRunInspectionListByChat[chatId]?.list ?? null, error: null } } }))
    return epoch
  },
  applyAgentRunInspectionList: (chatId, requestEpoch, payload) => {
    const list = normalizeAgentRunInspectionListV1(payload)
    const key = `list:${chatId}`
    if (!list || list.chatId !== chatId || get().agentRunInspectionRequestEpochByKey[key] !== requestEpoch) return false
    set((state) => ({ agentRunInspectionListByChat: { ...state.agentRunInspectionListByChat, [chatId]: { status: 'ready', list, error: null } } }))
    return true
  },
  failAgentRunInspectionList: (chatId, requestEpoch, error) => {
    if (get().agentRunInspectionRequestEpochByKey[`list:${chatId}`] !== requestEpoch) return
    set((state) => ({ agentRunInspectionListByChat: { ...state.agentRunInspectionListByChat, [chatId]: { status: 'error', list: state.agentRunInspectionListByChat[chatId]?.list ?? null, error: error ?? null } } }))
  },
  beginAgentRunRetry: (attemptId) => set((state) => ({ agentRunRetryByAttemptId: { ...state.agentRunRetryByAttemptId, [attemptId]: { status: 'submitting', response: null, error: null } } })),
  applyAgentRunRetry: (attemptId, payload) => {
    const response = normalizeAgentRunInspectionRetryResponseV1(payload)
    if (!response) return false
    set((state) => ({ agentRunRetryByAttemptId: { ...state.agentRunRetryByAttemptId, [attemptId]: { status: response.accepted ? 'accepted' : 'refused', response, error: null } } }))
    return true
  },
  failAgentRunRetry: (attemptId, error) => set((state) => ({ agentRunRetryByAttemptId: { ...state.agentRunRetryByAttemptId, [attemptId]: { status: 'error', response: null, error: error ?? null } } })),

  beginAgentWorkspaceRequest: (chatId, turnId, section) => {
    const key = workspaceRequestKey(turnId, section)
    const epoch = (get().agentWorkspaceRequestEpochByKey[key] ?? 0) + 1
    set((state) => {
      const previous = state.agentWorkspaceByTurn[turnId]
      const sections = { ...(previous?.sections ?? {}) }
      if (section) sections[section] = { preview: sections[section]?.preview ?? emptyWorkspaceSectionPreview(turnId, section, previous?.index?.workspaceRevision ?? 0), loadingMore: true, error: false }
      return { agentWorkspaceRequestEpochByKey: { ...state.agentWorkspaceRequestEpochByKey, [key]: epoch }, agentWorkspaceByTurn: { ...state.agentWorkspaceByTurn, [turnId]: { chatId, turnId, status: section ? previous?.status ?? 'idle' : 'loading', index: previous?.index ?? null, sections, error: false } } }
    })
    return epoch
  },
  applyAgentWorkspaceIndex: (chatId, turnId, requestEpoch, payload) => {
    const key = workspaceRequestKey(turnId)
    const state = get()
    const index = normalizeAgentWorkspaceIndexV2(payload)
    if (state.agentWorkspaceRequestEpochByKey[key] !== requestEpoch) return false
    const settleRejectedRequest = (terminalError: boolean, fallbackStatus: 'idle' | 'ready' = 'idle') => {
      set((current) => {
        if (current.agentWorkspaceRequestEpochByKey[key] !== requestEpoch) return {}
        const previous = current.agentWorkspaceByTurn[turnId]
        if (!previous || previous.chatId !== chatId) return {}
        return {
          agentWorkspaceByTurn: {
            ...current.agentWorkspaceByTurn,
            [turnId]: {
              ...previous,
              status: terminalError ? 'error' : fallbackStatus,
              error: terminalError,
            },
          },
        }
      })
    }
    const invalidSnapshot = !index || index.turnId !== turnId
    if (invalidSnapshot || state.activeChatId !== chatId) {
      settleRejectedRequest(invalidSnapshot)
      return false
    }
    let accepted = true
    set((current) => {
      const previous = current.agentWorkspaceByTurn[turnId]
      if (previous?.index && previous.index.workspaceRevision > index.workspaceRevision) {
        accepted = false
        if (previous.chatId !== chatId) return {}
        return {
          agentWorkspaceByTurn: {
            ...current.agentWorkspaceByTurn,
            [turnId]: {
              ...previous,
              status: previous.index ? 'ready' : 'idle',
              error: false,
            },
          },
        }
      }
      const sections: NonNullable<typeof previous>['sections'] = {}
      for (const section of ['objective', 'tasks', 'records', 'submissions', 'artifacts'] as const) {
        if (previous?.sections[section] && previous.sections[section]!.preview.workspaceRevision >= index.workspaceRevision) {
          sections[section] = previous.sections[section]!
        }
      }
      return {
        agentWorkspaceByTurn: {
          ...current.agentWorkspaceByTurn,
          [turnId]: { chatId, turnId, status: 'ready', index, sections, error: false },
        },
      }
    })
    return accepted
  },
  applyAgentWorkspaceSection: (chatId, turnId, section, requestEpoch, payload, append) => {
    const key = workspaceRequestKey(turnId, section)
    const state = get()
    const preview = normalizeAgentWorkspaceSectionV2(payload)
    const settleSectionRequest = (terminalError = true) => {
      set((current) => {
        if (current.agentWorkspaceRequestEpochByKey[key] !== requestEpoch) return {}
        const previous = current.agentWorkspaceByTurn[turnId]
        if (!previous || previous.chatId !== chatId) return {}
        const currentSection = previous.sections[section]
        if (!currentSection) return {}
        return {
          agentWorkspaceByTurn: {
            ...current.agentWorkspaceByTurn,
            [turnId]: {
              ...previous,
              sections: {
                ...previous.sections,
                [section]: { ...currentSection, loadingMore: false, error: terminalError },
              },
            },
          },
        }
      })
    }
    if (state.agentWorkspaceRequestEpochByKey[key] !== requestEpoch) return false
    if (!preview || preview.turnId !== turnId || preview.section !== section || state.activeChatId !== chatId) {
      settleSectionRequest()
      return false
    }
    if (state.agentWorkspaceByTurn[turnId]?.index && preview.workspaceRevision < state.agentWorkspaceByTurn[turnId]!.index!.workspaceRevision) {
      settleSectionRequest()
      return false
    }
    let accepted = true
    set((current) => {
      const previous = current.agentWorkspaceByTurn[turnId]
      const currentSection = previous?.sections[section]?.preview
      if (currentSection && currentSection.workspaceRevision > preview.workspaceRevision) {
        accepted = false
        if (!previous || previous.chatId !== chatId) return {}
        const sectionState = previous.sections[section]
        return sectionState
          ? { agentWorkspaceByTurn: { ...current.agentWorkspaceByTurn, [turnId]: { ...previous, sections: { ...previous.sections, [section]: { ...sectionState, loadingMore: false, error: true } } } } }
          : {}
      }
      let nextPreview = preview
      if (append && currentSection?.workspaceRevision === preview.workspaceRevision) {
        const byId = new Map<string, AgentWorkspaceEntryPreviewV2>(currentSection.entries.map((entry) => [entry.id, entry]))
        preview.entries.forEach((entry) => { const existing = byId.get(entry.id); if (!existing || existing.revision < entry.revision) byId.set(entry.id, entry) })
        nextPreview = { ...preview, entries: [...byId.values()] }
      }
      return { agentWorkspaceByTurn: { ...current.agentWorkspaceByTurn, [turnId]: { chatId, turnId, status: previous?.status ?? 'ready', index: previous?.index ?? null, sections: { ...previous?.sections, [section]: { preview: nextPreview, loadingMore: false, error: false } }, error: false } } }
    })
    return accepted
  },
  failAgentWorkspaceRequest: (chatId, turnId, requestEpoch, section) => {
    const key = workspaceRequestKey(turnId, section)
    if (get().agentWorkspaceRequestEpochByKey[key] !== requestEpoch) return
    set((state) => {
      const previous = state.agentWorkspaceByTurn[turnId]
      if (!previous || previous.chatId !== chatId) return {}
      const sections = { ...previous.sections }
      if (section) sections[section] = { preview: sections[section]?.preview ?? emptyWorkspaceSectionPreview(turnId, section, previous.index?.workspaceRevision ?? 0), loadingMore: false, error: true }
      return { agentWorkspaceByTurn: { ...state.agentWorkspaceByTurn, [turnId]: { ...previous, status: section ? previous.status : 'error', sections, error: section ? previous.error : true } } }
    })
  },

  beginPersistentWorkspaceRequest: (scope) => {
    const epoch = (get().agentPersistentWorkspaceRequestEpochByKey[scope] ?? 0) + 1
    set((state) => ({ agentPersistentWorkspaceRequestEpochByKey: { ...state.agentPersistentWorkspaceRequestEpochByKey, [scope]: epoch } }))
    return epoch
  },
  applyPersistentWorkspace: (scope, requestEpoch, payload) => {
    const state = get()
    if (state.agentPersistentWorkspaceRequestEpochByKey[scope] !== requestEpoch) return false
    const workspace = normalizePersistentWorkspace(
      payload,
      scope.startsWith('id:') ? scope.slice('id:'.length) : undefined,
      scope.startsWith('chat:') ? scope.slice('chat:'.length) : undefined,
    )
    if (!workspace) {
      state.failPersistentWorkspaceRequest(scope, requestEpoch, 'unavailable', 'Invalid persistent workspace response')
      return false
    }
    const scopeCurrent = scope.startsWith('chat:')
      ? state.agentPersistentWorkspaceByChat[scope.slice('chat:'.length)]
      : state.agentPersistentWorkspaceById[workspace.id]
    if (scopeCurrent?.workspace && scopeCurrent.workspace.revision > workspace.revision) return false
    const current = state.agentPersistentWorkspaceById[workspace.id]
    if (current?.workspace && current.workspace.revision > workspace.revision) return false
    set((state) => ({
      agentPersistentWorkspaceById: {
        ...state.agentPersistentWorkspaceById,
        [workspace.id]: {
          status: 'ready',
          availability: workspace.chatId ? 'attached' : 'detached',
          workspace,
          error: null,
          requestEpoch,
        },
      },
      ...(workspace.chatId ? {
        agentPersistentWorkspaceByChat: {
          ...state.agentPersistentWorkspaceByChat,
          [workspace.chatId]: {
            status: 'ready',
            availability: 'attached',
            workspace,
            error: null,
            requestEpoch,
          },
        },
      } : {}),
      agentPersistentWorkspaceCollectionsById: {
        ...state.agentPersistentWorkspaceCollectionsById,
        [workspace.id]: state.agentPersistentWorkspaceCollectionsById[workspace.id] ?? emptyPersistentWorkspaceCollections(),
      },
    }))
    return true
  },
  failPersistentWorkspaceRequest: (scope, requestEpoch, availability, error) => {
    if (get().agentPersistentWorkspaceRequestEpochByKey[scope] !== requestEpoch) return
    const chatId = scope.startsWith('chat:') ? scope.slice('chat:'.length) : null
    const workspaceId = scope.startsWith('id:') ? scope.slice('id:'.length) : scope
    set((state) => {
      const previous = chatId
        ? state.agentPersistentWorkspaceByChat[chatId]
        : state.agentPersistentWorkspaceById[workspaceId]
      const failure: AgentPersistentWorkspaceStateV1 = {
        status: 'error',
        availability,
        workspace: previous?.workspace ?? null,
        error: error ?? null,
        requestEpoch,
      }
      return chatId
        ? { agentPersistentWorkspaceByChat: { ...state.agentPersistentWorkspaceByChat, [chatId]: failure } }
        : { agentPersistentWorkspaceById: { ...state.agentPersistentWorkspaceById, [workspaceId]: failure } }
    })
  },
  beginPersistentWorkspaceCollection: (workspaceId, collection) => {
    const key = `${workspaceId}:${collection}`
    const epoch = (get().agentPersistentWorkspaceRequestEpochByKey[key] ?? 0) + 1
    set((state) => {
      const current = state.agentPersistentWorkspaceCollectionsById[workspaceId] ?? emptyPersistentWorkspaceCollections()
      return {
        agentPersistentWorkspaceRequestEpochByKey: { ...state.agentPersistentWorkspaceRequestEpochByKey, [key]: epoch },
        agentPersistentWorkspaceCollectionsById: {
          ...state.agentPersistentWorkspaceCollectionsById,
          [workspaceId]: {
            ...current,
            [collection]: { ...current[collection], status: 'loading', error: null },
          },
        },
      }
    })
    return epoch
  },
  applyPersistentWorkspaceCollection: (workspaceId, collection, requestEpoch, payload, append = false, expectedOffset) => {
    const key = `${workspaceId}:${collection}`
    const state = get()
    if (state.agentPersistentWorkspaceRequestEpochByKey[key] !== requestEpoch) return false
    const storedWorkspace = state.agentPersistentWorkspaceById[workspaceId]?.workspace
    const expectedChatId = storedWorkspace?.chatId
    const chatMismatch = (items: readonly { chatId: string | null }[]) => expectedChatId === undefined
      ? items.length > 0
      : items.some((item) => item.chatId !== expectedChatId)
    if (collection === 'sessions') {
      const page = normalizePersistentWorkspaceTurnSessionPage(payload, workspaceId, expectedOffset)
      const currentCollections = state.agentPersistentWorkspaceCollectionsById[workspaceId] ?? emptyPersistentWorkspaceCollections()
      const previousPage = currentCollections.sessionsPage
      const pageChatMismatch = page !== null && chatMismatch(page.data)
      const nonAdvancingPage = append && (page === null
        || page.offset <= previousPage.offset
        || page.offset !== previousPage.nextOffset)
      const metadataDrift = append && page !== null
        && (page.total !== previousPage.total || page.limit !== previousPage.limit)
      const existingIds = new Set(currentCollections.sessions.items.map((item) => item.id))
      const duplicateAcceptedId = append && page !== null && page.data.some((item) => existingIds.has(item.id))
      if (!page || pageChatMismatch || nonAdvancingPage || metadataDrift || duplicateAcceptedId) {
        state.failPersistentWorkspaceCollection(workspaceId, collection, requestEpoch, 'Invalid persistent workspace sessions response')
        return false
      }
      set((current) => {
        const collections = current.agentPersistentWorkspaceCollectionsById[workspaceId] ?? emptyPersistentWorkspaceCollections()
        const items = append ? [...collections.sessions.items, ...page.data] : page.data
        return {
          agentPersistentWorkspaceCollectionsById: {
            ...current.agentPersistentWorkspaceCollectionsById,
            [workspaceId]: {
              ...collections,
              sessions: { status: 'ready', items, error: null },
              sessionsPage: { total: page.total, limit: page.limit, offset: page.offset, nextOffset: page.offset + page.data.length },
            },
          },
        }
      })
      return true
    }
    const items = normalizePersistentWorkspaceCollection(collection, payload, workspaceId)
    if (!items || chatMismatch(items)) {
      state.failPersistentWorkspaceCollection(workspaceId, collection, requestEpoch, 'Invalid persistent workspace collection response')
      return false
    }
    set((current) => {
      const collections = current.agentPersistentWorkspaceCollectionsById[workspaceId] ?? emptyPersistentWorkspaceCollections()
      return {
        agentPersistentWorkspaceCollectionsById: {
          ...current.agentPersistentWorkspaceCollectionsById,
          [workspaceId]: readyPersistentWorkspaceCollections(collections, collection, items),
        },
      }
    })
    return true
  },
  failPersistentWorkspaceCollection: (workspaceId, collection, requestEpoch, error) => {
    const key = `${workspaceId}:${collection}`
    if (get().agentPersistentWorkspaceRequestEpochByKey[key] !== requestEpoch) return
    set((state) => {
      const current = state.agentPersistentWorkspaceCollectionsById[workspaceId] ?? emptyPersistentWorkspaceCollections()
      return {
        agentPersistentWorkspaceCollectionsById: {
          ...state.agentPersistentWorkspaceCollectionsById,
          [workspaceId]: {
            ...current,
            [collection]: { ...current[collection], status: 'error', error: error ?? null },
          },
        },
      }
    })
  },
  setAgentRuntimeSettings: (chatId, projection) => set((state) => ({ agentRuntimeSettingsByChat: { ...state.agentRuntimeSettingsByChat, [chatId]: projection } })),
  clearAgentRuntimeSettings: (chatId) => set((state) => { const values = { ...state.agentRuntimeSettingsByChat }; delete values[chatId]; return { agentRuntimeSettingsByChat: values } }),
})

export function selectAgentRunForTarget(state: Pick<AgentRunsSlice, 'agentRunTerminalByTarget'> & Partial<Pick<AgentRunsSlice, 'agentRunProvisionalByKey'>>, chatId: string, messageId: string, swipeId: number): AgentRunPublicV2 | undefined {
  let selected = state.agentRunTerminalByTarget[agentRunTerminalTargetKey(chatId, messageId, swipeId)]
  for (const run of Object.values(state.agentRunProvisionalByKey ?? {})) if (runTargets(run, chatId, messageId, swipeId) && (!selected || compareTargetAuthority(run, selected) > 0)) selected = run
  return selected
}
export function selectAgentRunForTurn(state: Pick<AgentRunsSlice, 'agentRunProvisionalByKey' | 'agentRunTerminalByTarget'>, turnId: string): AgentRunPublicV2 | undefined { return findRunByTurnId(state, turnId) }
export function selectActiveAgentRunForChat(state: Pick<AgentRunsSlice, 'agentRunProvisionalByKey'>, chatId: string, generationId?: string | null): AgentRunPublicV2 | undefined {
  let selected: AgentRunPublicV2 | undefined
  for (const run of Object.values(state.agentRunProvisionalByKey)) if (run.chatId === chatId && isActiveRun(run) && (generationId === undefined || generationId === null || run.generationId === generationId) && (!selected || compareRunFreshness(run, selected) > 0)) selected = run
  return selected
}
export function selectLatestAgentRunForChat(state: Pick<AgentRunsSlice, 'agentRunProvisionalByKey' | 'agentRunTerminalByTarget'>, chatId: string): AgentRunPublicV2 | undefined {
  let selected: AgentRunPublicV2 | undefined
  for (const run of [...Object.values(state.agentRunProvisionalByKey), ...Object.values(state.agentRunTerminalByTarget)]) if (run.chatId === chatId && (!selected || compareRunFreshness(run, selected) > 0)) selected = run
  return selected
}
export function selectAgentRunInspection(state: Pick<AgentRunsSlice, 'agentRunInspectionByAttemptId'>, attemptId: string) { return state.agentRunInspectionByAttemptId[attemptId] }
export function selectAgentRunInspectionList(state: Pick<AgentRunsSlice, 'agentRunInspectionListByChat'>, chatId: string) { return state.agentRunInspectionListByChat[chatId] }
export function selectPersistentWorkspace(state: Pick<AgentRunsSlice, 'agentPersistentWorkspaceByChat' | 'agentPersistentWorkspaceById'>, chatId: string, workspaceId?: string | null) { return workspaceId ? state.agentPersistentWorkspaceById[workspaceId] : state.agentPersistentWorkspaceByChat[chatId] }
export function selectPersistentWorkspaceCollections(state: Pick<AgentRunsSlice, 'agentPersistentWorkspaceCollectionsById'>, workspaceId: string) {
  return state.agentPersistentWorkspaceCollectionsById[workspaceId]
}

export function selectPersistentWorkspaceCollection(
  state: Pick<AgentRunsSlice, 'agentPersistentWorkspaceCollectionsById'>,
  workspaceId: string,
  collection: AgentPersistentWorkspaceCollectionV1,
) {
  return state.agentPersistentWorkspaceCollectionsById[workspaceId]?.[collection]
}
