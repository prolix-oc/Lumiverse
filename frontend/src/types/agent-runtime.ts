import type { CognitionPredicate } from '@/lib/loom/types'
export const AGENT_WORK_PHASES = [
  'ADMIT',
  'ASSEMBLE',
  'WORK',
  'PREPARE_COMMIT',
  'RENDER',
  'COMMIT',
  'TERMINAL',
] as const

export type AgentWorkPhase = (typeof AGENT_WORK_PHASES)[number]
export type AgentWorkLifecycle = AgentWorkPhase

export const AGENT_WORK_STATUSES = [
  'pending',
  'running',
  'waiting',
  'cancelling',
  'terminal',
] as const

export type AgentWorkStatus = (typeof AGENT_WORK_STATUSES)[number]

export const AGENT_WORK_OUTCOMES = [
  'completed',
  'stopped',
  'failed',
  'exhausted',
  'rejected',
] as const

export type AgentWorkOutcome = (typeof AGENT_WORK_OUTCOMES)[number]

export type AgentWorkTargetKind = 'normal' | 'continue' | 'regenerate' | 'swipe'

export interface AgentWorkTargetIdentityV1 {
  readonly chatId: string
  readonly generationType: AgentWorkTargetKind
  readonly messageId: string | null
  readonly swipeId: number | null
}

export interface AgentWorkAttemptLineageV1 {
  readonly version: 1
  readonly attemptId: string
  readonly previousAttemptId: string | null
  readonly target: AgentWorkTargetIdentityV1
  readonly createdAt: number
}

export interface AgentWorkProjectionV1 {
  readonly version: 1
  readonly workPhase: AgentWorkPhase
  readonly workStatus: AgentWorkStatus
  readonly workOutcome: AgentWorkOutcome | null
  readonly reason: string | null
  readonly attemptLineage: AgentWorkAttemptLineageV1
}


export interface AgentRuntimeHostLimits {
  childAdmissions: number
  aggregateToolCalls: number
  logicalProviderRequests: number
  physicalDispatchAttempts: number
  childOutputTokens: number
  workAttemptOutputTokens: number
  workAttemptProviderDispatches: number
  workAttemptUnsignedBoundaries: number
  workAttemptToolCalls: number
  workAttemptWorkspaceOperations: number
  workSegmentOutputTokens: number
  workSegmentProviderDispatches: number
  workSegmentUnsignedBoundaries: number
  workSegmentToolCalls: number
  workSegmentWorkspaceOperations: number
  workDispatchOutputTokens: number
  workRecoveryReserveOutputTokens: number
  workFuturePhaseReserveOutputTokens: number
  rootWallClockMs: number
  activityEvents: number
  activityBytes: number
  lifecycleLogRecords: number
  activeRootsPerUser: number
  activeRootsProcess: number
  providerDispatchesPerUser: number
  providerDispatchesProcess: number
  toolExecutionsPerUser: number
  toolExecutionsProcess: number
}

/** Frontend mirror of server-owned runtime/activity DTOs. Status-only by design. */
export type AgentPublicErrorCategory =
  | 'capacity' | 'budget' | 'context' | 'integrity' | 'timeout' | 'cancelled'
  | 'provider' | 'validation' | 'internal'

export type AgentPublicErrorCode =
  | 'capacity_exceeded' | 'host_child_admission_limit_exceeded' | 'host_tool_call_limit_exceeded'
  | 'child_admission_limit_exceeded' | 'tool_call_limit_exceeded'
  | 'logical_provider_request_limit_exceeded' | 'physical_dispatch_attempt_limit_exceeded'
  | 'child_output_token_limit_exceeded' | 'root_wall_clock_limit_exceeded'
  | 'activity_event_limit_exceeded' | 'activity_byte_limit_exceeded'
  | 'lifecycle_log_record_limit_exceeded' | 'context_limit_exceeded'
  | 'initial_input_limit_exceeded' | 'argument_limit_exceeded' | 'result_limit_exceeded'
  | 'continuation_limit_exceeded' | 'retained_output_limit_exceeded' | 'materialized_limit_exceeded'
  | 'timeout' | 'cancelled' | 'provider_unavailable' | 'provider_unsupported'
  | 'provider_tool_calling_unsupported' | 'provider_tool_continuation_unsupported'
  | 'provider_tool_finalization_unsupported'
  | 'provider_request_error' | 'provider_protocol_error' | 'provider_schema_error'
  | 'invalid_task' | 'invalid_profile' | 'invalid_arguments' | 'batch_rejected'
  | 'unknown_tool' | 'unauthorized' | 'integrity_error' | 'internal_error'
  | 'child_required_failed' | 'child_output_limit_exceeded' | 'agentic_protocol_failure'

export type AgentPublicBudgetId =
  | 'child_admissions' | 'aggregate_tool_calls' | 'logical_provider_requests'
  | 'physical_dispatch_attempts' | 'child_output_tokens' | 'root_wall_clock_ms'
  | 'activity_events' | 'activity_bytes' | 'lifecycle_log_records'
  | 'initial_input_bytes' | 'argument_bytes' | 'result_bytes' | 'continuation_bytes'
  | 'retained_output_bytes' | 'materialized_bytes' | 'context_tokens'
  | 'active_roots_per_user' | 'active_roots_process'
  | 'provider_dispatches_per_user' | 'provider_dispatches_process'
  | 'tool_executions_per_user' | 'tool_executions_process'

export type AgentProviderAdapterId =
  | 'openai_chat_completions' | 'openai_responses' | 'openai_compatible_chat_completions'
  | 'anthropic_messages' | 'google_generative_language' | 'google_vertex' | 'unknown'

export interface AgentPublicErrorV1 {
  version: 1
  code: AgentPublicErrorCode
  category: AgentPublicErrorCategory
  budget?: { id: AgentPublicBudgetId; limit: number; observed: number }
  adapter?: AgentProviderAdapterId
  httpStatus?: number
  providerCode?: string
  retryable: boolean
}

export type AgentActivityLifecycle = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'
export type AgentActivityNodeKind = 'root_turn' | 'provider_round' | 'child_invocation' | 'tool_attempt'
export type AgentActivityActor = 'root' | 'provider' | 'child' | 'tool'
export type AgentActivityContinuationMode = 'ordinary' | 'finalization' | 'none'
export type AgentActivityToolId =
  | 'lore_list_books' | 'lore_get_book' | 'lore_list_entries' | 'lore_get_entry'
  | 'lore_search_entries' | 'chat_search_history' | 'agent_delegate'
  | 'workspace_read_section' | 'workspace_read_page' | 'workspace_create_task'
  | 'workspace_update_progress' | 'workspace_submit_result' | 'workspace_submit_root_result' | 'workspace_accept_submission'
  | 'workspace_record_finding' | 'workspace_record_decision' | 'workspace_record_question'
  | 'workspace_attach_artifact' | 'workspace_propose_publication'
  | 'complete_turn' | 'unknown_tool'
export type AgentActivityToolName = AgentActivityToolId

export interface AgentActivityUsageV1 {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  toolCalls: number
  childInvocations: number
}

export interface AgentActivityNodeV1 {
  id: string
  parentId: string | null
  kind: AgentActivityNodeKind
  actor: AgentActivityActor
  profileId?: string
  toolId?: AgentActivityToolId
  phase: AgentActivityLifecycle
  status: AgentActivityLifecycle
  roundIndex?: number
  continuationMode?: AgentActivityContinuationMode
  startedAt: number
  elapsedMs: number
  usage?: AgentActivityUsageV1
  errorCode?: AgentPublicErrorCode
}

export interface AgentActivitySnapshotV1 {
  version: 1
  rootId: string
  nodes: AgentActivityNodeV1[]
  omittedNodeCount: number
  errorCounts: Partial<Record<AgentPublicErrorCode, number>>
  usage: AgentActivityUsageV1
  status: AgentActivityLifecycle
  terminalErrorCode?: AgentPublicErrorCode
}

export interface AgentActivityRunV1 {
  version: 1
  generationId: string
  chatId: string
  targetMessageId: string | null
  targetSwipeId: number | null
  snapshot: AgentActivitySnapshotV1
}

export interface AgentActivityTerminalSummaryV1 {
  status: AgentActivityLifecycle
  omittedNodeCount: number
  usage: AgentActivityUsageV1
  errorCounts: Partial<Record<AgentPublicErrorCode, number>>
  terminalErrorCode?: AgentPublicErrorCode
}

export const LOOM_POLICY_VERSION = 1 as const
export const LOOM_POLICY_BUCKETS = ['workPolicy', 'workspaceUsage', 'completionCriteria', 'renderPolicy'] as const
export type LoomPolicyBucketV1 = (typeof LOOM_POLICY_BUCKETS)[number]

export const LOOM_POLICY_DESTINATIONS = ['root_work', 'completion_handoff', 'render'] as const
export type LoomPolicyDestinationV1 = (typeof LOOM_POLICY_DESTINATIONS)[number]

export const LOOM_POLICY_CHECKPOINTS = ['ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER'] as const
export type LoomPolicyCheckpointV1 = (typeof LOOM_POLICY_CHECKPOINTS)[number]

export const LOOM_POLICY_VISIBILITY = 'work_only' as const
export type LoomPolicyVisibilityV1 = typeof LOOM_POLICY_VISIBILITY

export interface LoomPolicySourceV1 {
  readonly kind: 'loom_block'
  readonly blockId: string
  readonly presetRevision: number
  readonly blockRevision: number
  readonly promptOrder: number
}


export interface LoomPolicyEntryV1 {
  readonly version: typeof LOOM_POLICY_VERSION
  readonly id: string
  readonly source: LoomPolicySourceV1
  readonly destination: LoomPolicyDestinationV1
  readonly checkpoint: LoomPolicyCheckpointV1
  readonly required: boolean
  readonly visibility: LoomPolicyVisibilityV1
  readonly condition?: CognitionPredicate
}

export interface LoomPolicyBucketsV1 {
  readonly version: typeof LOOM_POLICY_VERSION
  readonly workPolicy: readonly LoomPolicyEntryV1[]
  readonly workspaceUsage: readonly LoomPolicyEntryV1[]
  readonly completionCriteria: readonly LoomPolicyEntryV1[]
  readonly renderPolicy: readonly LoomPolicyEntryV1[]
}

export type LoomPromptInspectionOutcomeV1 =
  | { readonly status: 'included'; readonly effectiveIndex: number; readonly reason: 'selected' }
  | {
      readonly status: 'skipped'
      readonly reason: 'checkpoint_not_reached' | 'condition_not_met' | 'stale_source'
    }
  | {
      readonly status: 'rejected'
      readonly reason: 'invalid_source' | 'stale_source' | 'required_source_unavailable'
    }
  | {
      readonly status: 'omitted'
      readonly reason: 'response_mode' | 'destination_unavailable' | 'not_work_surface'
    }
  | {
      readonly status: 'deduplicated'
      readonly reason: 'destination_overlap'
      readonly keptEntryId: string
      readonly destination: LoomPolicyDestinationV1
    }

export interface LoomPromptInspectionItemV1 {
  readonly entryId: string
  readonly bucket: LoomPolicyBucketV1
  readonly destination: LoomPolicyDestinationV1
  readonly checkpoint: LoomPolicyCheckpointV1
  readonly source: LoomPolicySourceV1
  readonly condition?: CognitionPredicate
  readonly conditionResult?: 'true' | 'false' | 'not_evaluated' | 'invalid' | 'not_applicable'
  readonly effectiveText: string | null
  readonly required: boolean
  readonly ordinaryPromptSuppressed: boolean
  readonly outcome: LoomPromptInspectionOutcomeV1
}

export interface LoomResponsePolicyPhaseInstructionV1 {
  readonly phaseId: string
  readonly source: LoomPolicySourceV1
  readonly profileId?: string
}

export interface LoomResponsePolicyOmissionV1 {
  readonly version: typeof LOOM_POLICY_VERSION
  readonly surface: 'RESPONSE'
  readonly visibility: LoomPolicyVisibilityV1
  readonly reason: 'work_only'
  readonly omittedEntryIds: readonly string[]
  readonly source: readonly LoomPolicySourceV1[]
  readonly omittedPhaseInstructions: readonly LoomResponsePolicyPhaseInstructionV1[]
  readonly reviewReason?: string
}

export interface LoomPromptInspectionV1 {
  readonly version: typeof LOOM_POLICY_VERSION
  readonly surface: 'WORK' | 'RESPONSE'
  readonly checkpoint: LoomPolicyCheckpointV1
  readonly items: readonly LoomPromptInspectionItemV1[]
  readonly effectiveEntryIds: readonly string[]
  readonly responseOmission?: LoomResponsePolicyOmissionV1
}
export interface LoomPromptInspectionBlockV1 {
  readonly source: LoomPolicySourceV1
  readonly content: string
}


export interface LoomPromptEvaluationV1 {
  readonly generationType: 'normal' | 'continue' | 'regenerate' | 'swipe'
  readonly phase: 'ASSEMBLE' | 'WORK' | 'COMPLETE' | 'RENDER' | 'PREPARE_COMMIT' | 'COMMITTING' | 'COMMITTED' | 'COMMIT_FAILED' | 'EXHAUSTED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'
  readonly presetVariables: Readonly<Record<string, string | number | boolean | readonly string[]>>
  readonly participantFacts: Readonly<Record<string, string | number | boolean | readonly string[]>>
  readonly availableTools: readonly string[]
  readonly taskTransitions: Readonly<Record<string, 'pending' | 'active' | 'blocked' | 'completed' | 'cancelled' | 'failed'>>
}

export interface LoomPromptInspectionInputV1 {
  readonly checkpoint: LoomPolicyCheckpointV1
  readonly surface: 'WORK' | 'RESPONSE'
  readonly evaluation?: LoomPromptEvaluationV1
  readonly blocks: readonly LoomPromptInspectionBlockV1[]
}

export interface CognitionRuntimePolicySurfaceV1 {
  readonly policies: LoomPolicyBucketsV1
  readonly promptInspection?: LoomPromptInspectionV1
  readonly responseOmission?: LoomResponsePolicyOmissionV1
}

