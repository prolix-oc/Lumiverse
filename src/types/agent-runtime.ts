import type {
  AgentAuthorizationSnapshot,
  AgentConfigV2,
  CoreAgentToolId,
} from "./agents";

import type { ToolContinuationMode } from "../llm/param-schema";
export const AGENT_WORK_PHASES = [
  "ADMIT",
  "ASSEMBLE",
  "WORK",
  "PREPARE_COMMIT",
  "RENDER",
  "COMMIT",
  "TERMINAL",
] as const;

export type AgentWorkPhase = (typeof AGENT_WORK_PHASES)[number];
export type AgentWorkLifecycle = AgentWorkPhase;

export const AGENT_WORK_STATUSES = [
  "pending",
  "running",
  "waiting",
  "cancelling",
  "terminal",
] as const;

export type AgentWorkStatus = (typeof AGENT_WORK_STATUSES)[number];

export const AGENT_WORK_OUTCOMES = [
  "completed",
  "stopped",
  "failed",
  "exhausted",
  "rejected",
] as const;

export type AgentWorkOutcome = (typeof AGENT_WORK_OUTCOMES)[number];

export type AgentWorkTargetKind = "normal" | "continue" | "regenerate" | "swipe";

export interface AgentWorkTargetIdentityV1 {
  readonly chatId: string;
  readonly generationType: AgentWorkTargetKind;
  readonly messageId: string | null;
  readonly swipeId: number | null;
}

export interface AgentWorkAttemptLineageV1 {
  readonly version: 1;
  readonly attemptId: string;
  readonly previousAttemptId: string | null;
  readonly target: AgentWorkTargetIdentityV1;
  readonly createdAt: number;
}

export interface AgentWorkProjectionV1 {
  readonly version: 1;
  readonly workPhase: AgentWorkPhase;
  readonly workStatus: AgentWorkStatus;
  readonly workOutcome: AgentWorkOutcome | null;
  readonly reason: string | null;
  readonly attemptLineage: AgentWorkAttemptLineageV1;
}


/** Effective process-owned ceilings. Authored preset values are compared at execution time. */
export interface AgentRuntimeHostLimits {
  readonly childAdmissions: number;
  readonly aggregateToolCalls: number;
  readonly logicalProviderRequests: number;
  readonly physicalDispatchAttempts: number;
  readonly childOutputTokens: number;
  /** Independent total WORK-attempt provider-output ceiling. */
  readonly workAttemptOutputTokens: number;
  readonly workAttemptProviderDispatches: number;
  readonly workAttemptUnsignedBoundaries: number;
  readonly workAttemptToolCalls: number;
  readonly workAttemptWorkspaceOperations: number;
  /** Independent one-segment ceilings; none are derived from dispatch or attempt limits. */
  readonly workSegmentOutputTokens: number;
  readonly workSegmentProviderDispatches: number;
  readonly workSegmentUnsignedBoundaries: number;
  readonly workSegmentToolCalls: number;
  readonly workSegmentWorkspaceOperations: number;
  /** Independent hard ceiling for one provider dispatch. */
  readonly workDispatchOutputTokens: number;
  /** Independent reserve available only to recovery dispatches. */
  readonly workRecoveryReserveOutputTokens: number;
  /** Independent reserve protected for later authored phases. */
  readonly workFuturePhaseReserveOutputTokens: number;
  readonly rootWallClockMs: number;
  readonly activityEvents: number;
  readonly activityBytes: number;
  readonly lifecycleLogRecords: number;
  readonly activeRootsPerUser: number;
  readonly activeRootsProcess: number;
  readonly providerDispatchesPerUser: number;
  readonly providerDispatchesProcess: number;
  readonly toolExecutionsPerUser: number;
  readonly toolExecutionsProcess: number;
}

export type AgentPublicErrorCategory =
  | "capacity"
  | "budget"
  | "context"
  | "integrity"
  | "timeout"
  | "cancelled"
  | "provider"
  | "validation"
  | "internal";
export const AGENT_RECOVERY_ACTIONS = [
  "retry",
  "repair",
  "reselect",
  "use_response",
  "resync",
  "none",
] as const;

/** A host-owned next action; it is never inferred by the client. */
export type AgentRecoveryActionV2 = (typeof AGENT_RECOVERY_ACTIONS)[number];

/** Summary codes are localization keys, not backend prose or provider text. */
export const AGENT_SUMMARY_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;


/** Stable, server-owned terminal codes safe for owner-facing responses. */
export type AgentPublicErrorCode =
  | "capacity_exceeded"
  | "host_child_admission_limit_exceeded"
  | "host_tool_call_limit_exceeded"
  | "child_admission_limit_exceeded"
  | "tool_call_limit_exceeded"
  | "logical_provider_request_limit_exceeded"
  | "physical_dispatch_attempt_limit_exceeded"
  | "child_output_token_limit_exceeded"
  | "root_wall_clock_limit_exceeded"
  | "activity_event_limit_exceeded"
  | "activity_byte_limit_exceeded"
  | "lifecycle_log_record_limit_exceeded"
  | "context_limit_exceeded"
  | "initial_input_limit_exceeded"
  | "argument_limit_exceeded"
  | "result_limit_exceeded"
  | "continuation_limit_exceeded"
  | "retained_output_limit_exceeded"
  | "materialized_limit_exceeded"
  | "timeout"
  | "cancelled"
  | "provider_unavailable"
  | "provider_unsupported"
  | "provider_tool_calling_unsupported"
  | "provider_tool_continuation_unsupported"
  | "provider_tool_finalization_unsupported"
  | "provider_request_error"
  | "provider_protocol_error"
  | "provider_schema_error"
  | "invalid_task"
  | "invalid_profile"
  | "invalid_input"
  | "invalid_arguments"
  | "batch_rejected"
  | "unknown_tool"
  | "unauthorized"
  | "integrity_error"
  | "internal_error"
  | "not_found"
  | "invalid_request"
  | "projection_unavailable"
  | "inspection_unavailable"
  | "workspace_unavailable"
  | "stop_unavailable"
  | "retry_unavailable"
  | "target_mismatch"
  | "stale_target"
  | "resync_required"
  | "recovery_unavailable"
  | "response_mode_required"
  | "decision_refresh_required"
  | "limit_exceeded"
  | "queue_full"
  | "worker_disabled"
  | "worker_unavailable"
  | "worker_crashed"
  | "worker_timed_out"
  | "worker_malformed"
  | "child_required_failed"
  | "child_output_limit_exceeded"
  | "agentic_protocol_failure";
/** Runtime values for the closed public error-code taxonomy. */
export const AGENT_PUBLIC_ERROR_CODES = [
  "capacity_exceeded",
  "host_child_admission_limit_exceeded",
  "host_tool_call_limit_exceeded",
  "child_admission_limit_exceeded",
  "tool_call_limit_exceeded",
  "logical_provider_request_limit_exceeded",
  "physical_dispatch_attempt_limit_exceeded",
  "child_output_token_limit_exceeded",
  "root_wall_clock_limit_exceeded",
  "activity_event_limit_exceeded",
  "activity_byte_limit_exceeded",
  "lifecycle_log_record_limit_exceeded",
  "context_limit_exceeded",
  "initial_input_limit_exceeded",
  "argument_limit_exceeded",
  "result_limit_exceeded",
  "continuation_limit_exceeded",
  "retained_output_limit_exceeded",
  "materialized_limit_exceeded",
  "timeout",
  "cancelled",
  "provider_unavailable",
  "provider_unsupported",
  "provider_tool_calling_unsupported",
  "provider_tool_continuation_unsupported",
  "provider_tool_finalization_unsupported",
  "provider_request_error",
  "provider_protocol_error",
  "provider_schema_error",
  "invalid_task",
  "invalid_profile",
  "invalid_input",
  "invalid_arguments",
  "batch_rejected",
  "unknown_tool",
  "unauthorized",
  "integrity_error",
  "internal_error",
  "not_found",
  "invalid_request",
  "projection_unavailable",
  "inspection_unavailable",
  "workspace_unavailable",
  "stop_unavailable",
  "retry_unavailable",
  "target_mismatch",
  "stale_target",
  "resync_required",
  "recovery_unavailable",
  "response_mode_required",
  "decision_refresh_required",
  "limit_exceeded",
  "queue_full",
  "worker_disabled",
  "worker_unavailable",
  "worker_crashed",
  "worker_timed_out",
  "worker_malformed",
  "child_required_failed",
  "child_output_limit_exceeded",
  "agentic_protocol_failure",
] as const satisfies readonly AgentPublicErrorCode[];


/** Server-owned counters that can be named in a public terminal error. */
export type AgentPublicBudgetId =
  | "child_admissions"
  | "aggregate_tool_calls"
  | "logical_provider_requests"
  | "physical_dispatch_attempts"
  | "child_output_tokens"
  | "root_wall_clock_ms"
  | "activity_events"
  | "activity_bytes"
  | "lifecycle_log_records"
  | "initial_input_bytes"
  | "argument_bytes"
  | "result_bytes"
  | "continuation_bytes"
  | "retained_output_bytes"
  | "materialized_bytes"
  | "context_tokens";

/** Admission dimensions are reported separately from semantic ledger budgets. */
export type AgentPublicCapacityId =
  | "active_roots_per_user"
  | "active_roots_process"
  | "provider_dispatches_per_user"
  | "provider_dispatches_process"
  | "tool_executions_per_user"
  | "tool_executions_process";

export interface AgentPublicBudgetContext {
  readonly id: AgentPublicBudgetId | AgentPublicCapacityId;
  readonly limit: number;
  readonly observed: number;
}

/** Adapter identifiers are protocol classes, never provider display names. */
export type AgentProviderAdapterId =
  | "openai_chat_completions"
  | "openai_responses"
  | "openai_compatible_chat_completions"
  | "anthropic_messages"
  | "google_generative_language"
  | "google_vertex"
  | "unknown";

export const AGENT_PUBLIC_PROVIDER_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Additive terminal error payload. Every value is server-owned or bounded by an
 * allowlist; provider text, URLs, model names, prompts, arguments, and results
 * are deliberately absent.
 */
export interface AgentPublicErrorV1 {
  readonly version: 1;
  readonly code: AgentPublicErrorCode;
  readonly category: AgentPublicErrorCategory;
  readonly budget?: AgentPublicBudgetContext;
  readonly adapter?: AgentProviderAdapterId;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly retryable: boolean;
}

export type AgentActivityNodeKind =
  | "root_turn"
  | "provider_round"
  | "child_invocation"
  | "tool_attempt";

export type AgentActivityLifecycle =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type AgentActivityContinuationMode = "ordinary" | "finalization" | "none";

export type AgentActivityActor = "root" | "provider" | "child" | "tool";

/** Tool labels are host catalog identifiers; unknown provider names are never exposed. */
export type AgentActivityToolId =
  | CoreAgentToolId
  | "agent_delegate"
  | "workspace_read_section"
  | "workspace_read_page"
  | "workspace_create_task"
  | "workspace_update_progress"
  | "workspace_submit_result"
  | "workspace_submit_root_result"
  | "workspace_accept_submission"
  | "workspace_record_finding"
  | "workspace_record_decision"
  | "workspace_record_question"
  | "workspace_attach_artifact"
  | "workspace_propose_publication"
  | "complete_turn"
  | "unknown_tool";

export const PUBLIC_ACTIVITY_TOOL_IDS = [
  "lore_list_books",
  "lore_get_book",
  "lore_list_entries",
  "lore_get_entry",
  "lore_search_entries",
  "chat_search_history",
  "agent_delegate",
  "workspace_read_section",
  "workspace_read_page",
  "workspace_create_task",
  "workspace_update_progress",
  "workspace_submit_result",
  "workspace_submit_root_result",
  "workspace_accept_submission",
  "workspace_record_finding",
  "workspace_record_decision",
  "workspace_record_question",
  "workspace_attach_artifact",
  "workspace_propose_publication",
  "complete_turn",
  "unknown_tool",
] as const satisfies readonly AgentActivityToolId[];

const PUBLIC_ACTIVITY_TOOL_ID_LOOKUP: Record<string, true> = Object.fromEntries(
  PUBLIC_ACTIVITY_TOOL_IDS.map((id) => [id, true]),
);

/** Map a host/WORK tool name onto the closed public activity label, or unknown_tool. */
export function publicActivityToolId(name: unknown): AgentActivityToolId {
  if (name === "workspace_update_assigned_progress") return "workspace_update_progress";
  if (name === "workspace_submit_child_result") return "workspace_submit_result";
  if (name === "workspace_submit_root_result") return "workspace_submit_root_result";
  if (typeof name === "string" && PUBLIC_ACTIVITY_TOOL_ID_LOOKUP[name] === true) {
    return name as AgentActivityToolId;
  }
  return "unknown_tool";
}

export interface AgentActivityUsageV1 {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCalls: number;
  readonly childInvocations: number;
}

/** Status-only live/persisted node. It intentionally contains no prose or payloads. */
export interface AgentActivityNodeV1 {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: AgentActivityNodeKind;
  readonly taskId?: string;
  readonly actor: AgentActivityActor;
  readonly profileId?: string;
  readonly toolId?: AgentActivityToolId;
  readonly phase: AgentActivityLifecycle;
  readonly status: AgentActivityLifecycle;
  readonly roundIndex?: number;
  readonly continuationMode?: AgentActivityContinuationMode;
  readonly startedAt: number;
  readonly elapsedMs: number;
  readonly usage?: AgentActivityUsageV1;
  readonly errorCode?: AgentPublicErrorCode;
}

export const AGENT_ACTIVITY_LIVE_NODE_LIMIT = 128;
export const AGENT_ACTIVITY_LIVE_BYTES_LIMIT = 64 * 1024;

export interface AgentActivitySnapshotV1 {
  readonly version: 1;
  readonly rootId: string;
  readonly nodes: readonly AgentActivityNodeV1[];
  readonly omittedNodeCount: number;
  readonly errorCounts: Readonly<Partial<Record<AgentPublicErrorCode, number>>>;
  readonly usage: AgentActivityUsageV1;
  readonly status: AgentActivityLifecycle;
  readonly terminalErrorCode?: AgentPublicErrorCode;
}

export interface AgentActivityRunV1 {
  readonly version: 1;
  readonly generationId: string;
  readonly chatId: string;
  readonly targetMessageId: string | null;
  readonly targetSwipeId: number | null;
  readonly snapshot: AgentActivitySnapshotV1;
}

export interface AgentActivityTerminalSummaryV1 {
  readonly status: AgentActivityLifecycle;
  readonly omittedNodeCount: number;
  readonly usage: AgentActivityUsageV1;
  readonly errorCounts: Readonly<Partial<Record<AgentPublicErrorCode, number>>>;
}

/** A single server-owned counter reservation in the shared root ledger. */
export interface AgentLedgerReservation {
  readonly id: string;
  readonly budget: AgentPublicBudgetId;
  readonly amount: number;
  consume(): void;
  release(): void;
}

export interface AgentLedgerCounters {
  readonly childAdmissions: number;
  readonly aggregateToolCalls: number;
  readonly logicalProviderRequests: number;
  readonly physicalDispatchAttempts: number;
  readonly childOutputTokens: number;
}

export type AgentTerminalReason =
  | "completed"
  | "completed_at_tool_budget"
  | "stopped"
  | "failed"
  | AgentPublicErrorCode;

/** Shared per-root budget/terminal owner; implementation is supplied by later phases. */
export interface AgentTurnLedger {
  readonly generationId: string;
  readonly authored: Pick<AgentConfigV2, "maxInvocations" | "maxToolCalls">;
  readonly limits: AgentRuntimeHostLimits;
  readonly authorization: AgentAuthorizationSnapshot;
  readonly signal: AbortSignal;
  readonly counters: AgentLedgerCounters;
  readonly terminal: AgentTerminalReason | null;
  reserve(budget: AgentPublicBudgetId, amount: number): AgentLedgerReservation | null;
  charge(budget: AgentPublicBudgetId, amount: number): boolean;
  tryTerminate(reason: AgentTerminalReason): boolean;
}

export type AgentLoopFrameKind = "root" | "child";

export type AgentToolMode = "ordinary" | "required" | "finalization";

export interface AgentAdapterCapabilities {
  readonly toolCalling: boolean;
  readonly toolContinuationMode: ToolContinuationMode;
  readonly supportsToolFinalization: boolean;
  readonly interleavedThinking: boolean;
}

export interface AgentPendingToolCall {
  readonly nativeCallId: string;
  readonly toolId: AgentActivityToolId;
  readonly argumentsJson: string;
}

/** Opaque, bounded provider continuation state retained only by one loop frame. */
export interface AgentContinuationCarrier {
  readonly kind: "chat_tool_calls" | "responses_items" | "reasoning_carrier";
  readonly byteLength: number;
  readonly itemCount: number;
}

/** Root and child loops own separate transcripts/carriers while sharing one ledger. */
export interface AgentToolLoopFrame {
  readonly kind: AgentLoopFrameKind;
  readonly invocationId: string;
  readonly parentInvocationId: string | null;
  readonly ledger: AgentTurnLedger;
  readonly adapterId: AgentProviderAdapterId;
  readonly capabilities: AgentAdapterCapabilities;
  readonly signal: AbortSignal;
  readonly roundIndex: number;
  readonly continuation: AgentContinuationCarrier | null;
  readonly pendingCalls: readonly AgentPendingToolCall[];
  readonly visibleOutput: string;
}

export interface AgentToolModePolicy {
  readonly mode: AgentToolMode;
  readonly allowedToolIds: readonly AgentActivityToolId[];
  readonly toolChoice: "auto" | "none";
  readonly parallelToolCalls: boolean;
}

export interface AgentAdapterRequestContext {
  readonly frame: AgentToolLoopFrame;
  readonly mode: AgentToolMode;
  readonly policy: AgentToolModePolicy;
}

/** Evidence supplied by each provider adapter for feature-active execution. */
export interface AgentProviderAdapterContract {
  readonly id: AgentProviderAdapterId;
  readonly capabilities: AgentAdapterCapabilities;
  buildToolModePolicy(
    mode: AgentToolMode,
    authorizedToolIds: readonly AgentActivityToolId[],
  ): AgentToolModePolicy;
}

export interface AgentFinalizationRequest {
  readonly mode: "finalization";
  readonly policy: AgentToolModePolicy & {
    readonly toolChoice: "none";
    readonly allowedToolIds: readonly [];
    readonly parallelToolCalls: false;
  };
}

export type AgentPublicErrorPayload = AgentPublicErrorV1;
export type AgentActivityEventV1 = AgentActivityNodeV1;
export type AgentLoopFrame = AgentToolLoopFrame;
export type AgentAdapterCapability = AgentAdapterCapabilities;
