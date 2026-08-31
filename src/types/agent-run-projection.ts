import type { LoomPromptInspectionV1 } from "./agent-cognition";
import type { RuntimeRevision } from "./agent-runtime-decision";
import type {
  AgentPublicErrorCategory,
  AgentPublicErrorCode,
  AgentRecoveryActionV2,
  AgentWorkAttemptLineageV1,
  AgentWorkOutcome,
  AgentWorkPhase,
  AgentWorkProjectionV1,
  AgentWorkStatus,
  AgentWorkTargetIdentityV1,
} from "./agent-runtime";

export type {
  AgentWorkAttemptLineageV1,
  AgentWorkOutcome,
  AgentWorkPhase,
  AgentWorkProjectionV1,
  AgentWorkStatus,
  AgentWorkTargetIdentityV1,
} from "./agent-runtime";


/**
 * Authenticated, status-only projection contracts for Agentic turns.
 *
 * These types are deliberately closed. Public payloads are assembled from
 * allowlisted fields by the projection service; callers must not spread model,
 * provider, tool, workspace, or metadata objects into these DTOs.
 */

export type AgentRunPublicStatusV2 = AgentWorkStatus;
export type AgentRunPublicPhaseV2 = AgentWorkPhase;
export type AgentRunPublicOutcomeV2 = AgentWorkOutcome;
export type AgentRunPublicProjectionV1 = AgentWorkProjectionV1;

export type AgentRunGenerationTypeV1 = "normal" | "continue" | "regenerate" | "swipe";

export type AgentActivityNodeKindV2 = "root" | "provider" | "child" | "tool";
export type AgentActivityNodeActorV2 = "root" | "provider" | "child" | "tool";
export type AgentActivityNodeStatusV2 =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "omitted";

export interface AgentActivityUsageV2 {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCalls: number;
  readonly childInvocations: number;
}

/** A bounded status-only node. It has no task, prompt, argument, result, or carrier fields. */
export interface AgentActivityNodeV2 {
  readonly version: 2;
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: AgentActivityNodeKindV2;
  readonly actor: AgentActivityNodeActorV2;
  readonly phase: AgentRunPublicPhaseV2;
  readonly status: AgentActivityNodeStatusV2;
  readonly startedAt: number;
  readonly elapsedMs: number;
  readonly profileId?: string;
  readonly toolId?: string;
  readonly roundIndex?: number;
  readonly continuationMode?: "ordinary" | "finalization" | "none";
  readonly usage?: AgentActivityUsageV2;
  readonly errorCode?: string;
}

export interface AgentOmissionMarkerV2 {
  readonly omittedNodeCount: number;
  readonly omittedEventCount: number;
  readonly firstOmittedSequence: number | null;
  readonly lastOmittedSequence: number | null;
}

export interface AgentRunTargetV1 {
  readonly messageId: string;
  readonly swipeId: number;
}

/** The only durable generation handoff exposed after an atomic commit. */
export interface AgentTerminalHandoffV2 {
  readonly version: 2;
  readonly committed: boolean;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly messageRevision: number | null;
  readonly swipeRevision: number | null;
}

export interface AgentRunPublicErrorV2 {
  readonly code: string;
  readonly category: AgentPublicErrorCategory;
  readonly summaryCode: string;
  readonly recoveryEligible: boolean;
  readonly recoveryAction: AgentRecoveryActionV2;
  readonly target: AgentWorkTargetIdentityV1 | null;
  readonly workPhase: AgentRunPublicPhaseV2;
  readonly workStatus: AgentRunPublicStatusV2;
  readonly workOutcome: AgentRunPublicOutcomeV2 | null;
  readonly reason: string | null;
  readonly omissionCount: number;
  readonly inspectionAttemptId: string | null;
}



export interface AgentRunPublicV2 {
  readonly version: 2;
  readonly runId: string;
  readonly turnId: string;
  readonly generationId: string;
  readonly chatId: string;
  readonly generationType: AgentRunGenerationTypeV1;
  readonly target: AgentRunTargetV1 | null;
  readonly workPhase: AgentRunPublicPhaseV2;
  readonly workStatus: AgentRunPublicStatusV2;
  readonly workOutcome: AgentRunPublicOutcomeV2 | null;
  readonly recoveryEligible: boolean;
  readonly recoveryAction: AgentRecoveryActionV2;
  readonly omissionCount: number;
  /** Owner-inspection link for expandable causal detail. */
  readonly inspectionAttemptId: string;
  readonly reason: string | null;
  readonly attemptLineage: AgentWorkAttemptLineageV1;
  readonly revision: number;
  /** The chat event sequence that carried this snapshot; it is not a run cursor. */
  readonly sequence: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly activity: readonly AgentActivityNodeV2[];
  readonly usage: AgentActivityUsageV2;
  readonly omission: AgentOmissionMarkerV2;
  readonly error?: AgentRunPublicErrorV2;
  readonly terminalHandoff?: AgentTerminalHandoffV2;
}
/** Stable envelope used by every Agent Run route failure. */
export interface AgentRunErrorResponseV2 {
  readonly version: 2;
  readonly error: AgentRunPublicErrorV2;
}

export type AgentWorkspaceSectionIdV2 =
  | "objective"
  | "tasks"
  | "records"
  | "submissions"
  | "artifacts";

export type AgentWorkspaceRetentionV2 = "operational" | "turn_terminal" | "chat_lifetime";
export type AgentWorkspaceVisibilityV2 = "owner" | "participants" | "public";

export interface AgentWorkspaceSectionIndexV2 {
  readonly section: AgentWorkspaceSectionIdV2;
  readonly count: number;
  readonly revision: number;
  readonly retention: AgentWorkspaceRetentionV2;
  readonly visibility: AgentWorkspaceVisibilityV2;
}

/** Redacted workspace index: counts and policy only, never workspace prose. */
export interface AgentWorkspaceIndexV2 {
  readonly version: 2;
  readonly turnId: string;
  readonly workspaceRevision: number;
  readonly sections: readonly AgentWorkspaceSectionIndexV2[];
  readonly omitted: number;
}

export interface AgentWorkspaceEntryBaseV2 {
  readonly id: string;
  readonly revision: number;
  readonly retention: AgentWorkspaceRetentionV2;
  readonly visibility: AgentWorkspaceVisibilityV2;
}

export interface AgentWorkspaceTaskPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  readonly kind: "task";
  readonly title: string;
  readonly state: "pending" | "active" | "blocked" | "completed" | "cancelled" | "failed";
  readonly required: boolean;
  readonly assigned: boolean;
  readonly dependencyCount: number;
}

export interface AgentWorkspaceSubmissionPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  readonly kind: "submission";
  readonly taskId: string;
  readonly profileId: string | null;
  readonly state: "submitted" | "accepted" | "rejected";
}

export interface AgentWorkspaceRecordPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  readonly kind: "finding" | "decision" | "question";
  readonly title: string;
  readonly state: "active" | "accepted" | "omitted";
}

export interface AgentWorkspaceArtifactPreviewV2 extends AgentWorkspaceEntryBaseV2 {
  readonly kind: "artifact";
  readonly name: string;
  readonly mimeType: string;
  readonly byteCount: number;
  readonly digestPrefix: string;
  readonly published: boolean;
}

export type AgentWorkspaceEntryPreviewV2 =
  | AgentWorkspaceTaskPreviewV2
  | AgentWorkspaceSubmissionPreviewV2
  | AgentWorkspaceRecordPreviewV2
  | AgentWorkspaceArtifactPreviewV2;

/** View-only page DTO. It never carries objective, constraints, notes, or child content. */
export interface AgentWorkspacePreviewV2 {
  readonly version: 2;
  readonly turnId: string;
  readonly section: AgentWorkspaceSectionIdV2;
  readonly workspaceRevision: number;
  readonly entries: readonly AgentWorkspaceEntryPreviewV2[];
  readonly nextPage: string | null;
  readonly omitted: number;
}

/** Opaque integrity-protected cursor. The token is never decoded by clients. */
export interface ChatRunCursorV1 {
  readonly version: 1;
  readonly token: string;
}

export interface AgentRunResyncPageV1 {
  /** Zero-based page offset in the bounded full-resync snapshot. */
  readonly offset: number;
  /** Number of runs visible in this response. */
  readonly returnedRuns: number;
  /** Number of runs in the bounded snapshot at its event watermark. */
  readonly totalRuns: number;
  /** Event sequence at which this resync snapshot was taken. */
  readonly snapshotSequence: number;
  /** False until the response contains every run in that snapshot. */
  readonly complete: boolean;
  /** Runs not returned yet; this is not an event omission. */
  readonly omittedRuns: number;
  /** Older visible runs outside the bounded newest snapshot. */
  readonly omittedOlderRuns: number;
}

export interface AgentRunChangeEventV2 {
  readonly version: 2;
  readonly chatId: string;
  readonly sequence: number;
  readonly run: AgentRunPublicV2;
  readonly omission: AgentOmissionMarkerV2;
}

export interface AgentRunChangesV2 {
  readonly version: 2;
  readonly chatId: string;
  readonly cursor: ChatRunCursorV1;
  /** Sequence consumed by the signed cursor in `cursor`. */
  readonly cursorSequence: number;
  /** Processed sequence; always equal to the signed cursor sequence. */
  readonly lastSequence: number;
  /** Highest sequence visible to this read snapshot, not a cursor watermark. */
  readonly tailSequence: number;
  /** More events or resync pages remain after this response. */
  readonly hasMore: boolean;
  readonly resync: boolean;
  readonly resyncPage?: AgentRunResyncPageV1;
  readonly runs: readonly AgentRunPublicV2[];
  readonly events: readonly AgentRunChangeEventV2[];
  readonly omission: AgentOmissionMarkerV2;
}

export type AgentRunStopResultV2 = "accepted" | "too_late" | "terminal";

export interface AgentRunStopResponseV2 {
  readonly version: 2;
  readonly status: AgentRunStopResultV2;
  readonly turnId: string;
  readonly generationId: string;
  readonly revision: number;
  readonly target: AgentWorkTargetIdentityV1;
  readonly workPhase: AgentRunPublicPhaseV2;
  readonly workStatus: AgentRunPublicStatusV2;
  readonly workOutcome: AgentRunPublicOutcomeV2 | null;
  readonly reason: string | null;
  readonly recoveryEligible: boolean;
  readonly recoveryAction: AgentRecoveryActionV2;
  readonly omissionCount: number;
  readonly inspectionAttemptId: string;
  readonly error?: AgentRunPublicErrorV2;
}
export type AgentInspectionLifecycleV1 =
  | "ADMIT"
  | "ASSEMBLE"
  | "WORK"
  | "PREPARE_COMMIT"
  | "RENDER"
  | "COMMIT"
  | "TERMINAL";

export type AgentInspectionStatusV1 =
  | "pending"
  | "running"
  | "waiting"
  | "cancelling"
  | "terminal";

export type AgentInspectionOutcomeV1 =
  | "completed"
  | "stopped"
  | "failed"
  | "exhausted"
  | "rejected";

export type AgentInspectionReasonV1 =
  | "none"
  | "user_stop"
  | "deadline"
  | "provider_failure"
  | "tool_failure"
  | "required_work_failure"
  | "budget_exhausted"
  | "invalid_input"
  | "stale_input"
  | "unavailable"
  | "needs_attention"
  | "interrupted"
  | "retry_requested"
  | "reconciled"
  | "unknown";

export type AgentInspectionSectionIdV1 =
  | "run"
  | "activity"
  | "transcript"
  | "turn_session"
  | "usage"
  | "prompt"
  | "cortex"
  | "council"
  | "workspace";

export type AgentInspectionSectionStateV1 =
  | "available"
  | "not_recorded"
  | "source_deleted"
  | "unavailable"
  | "withheld";

export interface AgentInspectionSectionAvailabilityV1 {
  readonly section: AgentInspectionSectionIdV1;
  readonly state: AgentInspectionSectionStateV1;
  readonly reason: AgentInspectionReasonV1 | null;
}

export type AgentInspectionTargetKindV1 = AgentRunGenerationTypeV1;

export interface AgentInspectionCorrelationV1 {
  readonly turnSessionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly chatId: string;
  readonly generationId: string;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly actorId: string | null;
  readonly recipientId: string | null;
  readonly phase: AgentInspectionLifecycleV1;
  readonly taskId: string | null;
  readonly toolId: string | null;
  readonly parentId: string | null;
  readonly hostCorrelationId: string;
  readonly hostSequence: number;
}

export type AgentInspectionAttemptLineageV1 = AgentWorkAttemptLineageV1;

export type AgentInspectionRecordKindV1 =
  | "prompt"
  | "provider_exchange"
  | "agent_exchange"
  | "delegation"
  | "child_result"
  | "tool"
  | "condition"
  | "checkpoint"
  | "task"
  | "workspace"
  | "hook"
  | "usage"
  | "failure"
  | "terminal"
  | "stop"
  | "recovery"
  | "milestone";

export type AgentInspectionRecordActorV1 =
  | "host"
  | "owner"
  | "provider"
  | "agent"
  | "child"
  | "tool"
  | "cortex"
  | "council";

export interface AgentInspectionProviderIdentityV1 {
  readonly adapter: string;
  readonly providerId: string | null;
  readonly modelId: string | null;
  /** Concrete frozen connection identity, when the producer has one. */
  readonly connectionId?: string | null;
  /** Frozen Agentic config revision that authorized this dispatch. */
  readonly configRevision?: RuntimeRevision | null;
  readonly connectionRevision: RuntimeRevision | null;
  readonly fingerprint: string | null;
}

export interface AgentInspectionTranscriptRecordV1 {
  readonly version: 1;
  readonly id: string;
  readonly kind: AgentInspectionRecordKindV1;
  readonly actor: AgentInspectionRecordActorV1;
  readonly recipient: AgentInspectionRecordActorV1 | null;
  readonly correlation: AgentInspectionCorrelationV1;
  readonly occurredAt: number;
  readonly durationMs: number | null;
  readonly late: boolean;
  readonly content: string | null;
  readonly arguments: string | null;
  readonly result: string | null;
  readonly provider: AgentInspectionProviderIdentityV1 | null;
  readonly errorReason: AgentInspectionReasonV1 | null;
}

export type AgentTurnSessionEntryKindV1 =
  | "target"
  | "input"
  | "policy"
  | "condition"
  | "hook"
  | "cancellation"
  | "completion"
  | "commit"
  | "terminal"
  | "retry"
  | "recovery";

export interface AgentTurnSessionEntryV1 {
  readonly version: 1;
  readonly id: string;
  readonly kind: AgentTurnSessionEntryKindV1;
  readonly correlation: AgentInspectionCorrelationV1;
  readonly occurredAt: number;
  readonly detail: string;
  readonly transcriptRecordIds: readonly string[];
}

export type AgentInspectionMarkerKindV1 =
  | "reconnect_gap"
  | "late_event"
  | "reordered_event"
  | "truncated"
  | "unavailable"
  | "credentials_withheld"
  | "other_user_data_withheld"
  | "recovered_duplicate";

export type AgentInspectionMarkerScopeV1 =
  | "run"
  | "activity"
  | "transcript"
  | "turn_session"
  | "usage"
  | "prompt"
  | "cortex"
  | "council"
  | "workspace";

export interface AgentInspectionMarkerV1 {
  readonly version: 1;
  readonly id: string;
  readonly kind: AgentInspectionMarkerKindV1;
  readonly scope: AgentInspectionMarkerScopeV1;
  readonly correlation: AgentInspectionCorrelationV1 | null;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly recoverable: boolean | null;
  readonly detail: string | null;
}

export type AgentInspectionUsageSourceV1 =
  | "provider_reported"
  | "provisional"
  | "final"
  | "recovered_duplicate";

export type AgentInspectionUsageLayerIdV1 =
  | "root"
  | "child"
  | "provider"
  | "tool"
  | "cortex"
  | "council";

export interface AgentInspectionUsageLayerV1 {
  readonly version: 1;
  readonly layer: AgentInspectionUsageLayerIdV1;
  readonly source: AgentInspectionUsageSourceV1;
  readonly correlation: AgentInspectionCorrelationV1 | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCalls: number;
  readonly childInvocations: number;
  readonly evidenceIds: readonly string[];
  readonly canonical: boolean;
}

export interface AgentInspectionUsageProjectionV1 {
  readonly version: 1;
  readonly inspectionAttemptId: string;
  readonly totals: AgentActivityUsageV2;
  readonly layers: readonly AgentInspectionUsageLayerV1[];
  readonly evidenceCount: number;
  readonly omittedEvidenceCount: number;
}

export interface AgentInspectionUsageV1 {
  readonly version: 1;
  readonly id: string;
  readonly source: AgentInspectionUsageSourceV1;
  /** The owning accounting layer, when the producer can attribute one. */
  readonly layer?: AgentInspectionUsageLayerIdV1;
  readonly correlation: AgentInspectionCorrelationV1 | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCalls: number;
  readonly childInvocations: number;
  readonly canonical: boolean;
}
export type AgentInspectionAuthorityV1 =
  | "host"
  | "preset"
  | "provider"
  | "owner"
  | "system"
  | "cortex"
  | "council";

export type AgentInspectionSourceV1 =
  | "execution"
  | "projection"
  | "provider"
  | "tool"
  | "host"
  | "recovery"
  | "cortex"
  | "council"
  | "unknown";

export type AgentInspectionScopeV1 =
  | "run"
  | "attempt"
  | "turn_session"
  | "target"
  | "phase"
  | "provider"
  | "tool"
  | "usage"
  | "transcript"
  | "cortex"
  | "council"
  | "workspace";

export interface AgentInspectionCapGateV1 {
  readonly id: string;
  readonly limit: number | null;
  readonly observed: number | null;
  readonly exceeded: boolean;
  readonly authority: AgentInspectionAuthorityV1;
  readonly source: AgentInspectionSourceV1;
}

/** Owner-only causal error detail; public run DTOs carry only AgentRunPublicErrorV2. */
export interface AgentInspectionErrorDetailV1 {
  readonly version: 1;
  readonly inspectionAttemptId: string;
  readonly code: string;
  readonly category: AgentPublicErrorCategory;
  readonly summaryCode: string;
  readonly causalCode: AgentPublicErrorCode | null;
  readonly authority: AgentInspectionAuthorityV1;
  readonly source: AgentInspectionSourceV1;
  readonly scope: AgentInspectionScopeV1;
  readonly capGate: AgentInspectionCapGateV1 | null;
  readonly target: AgentWorkTargetIdentityV1;
  readonly workPhase: AgentRunPublicPhaseV2;
  readonly workStatus: AgentRunPublicStatusV2;
  readonly workOutcome: AgentRunPublicOutcomeV2 | null;
  readonly reason: string | null;
  readonly recoveryEligible: boolean;
  readonly recoveryAction: AgentRecoveryActionV2;
  readonly omissionCount: number;
}


export type AgentPromptRevisionV1 = string | number;

export interface AgentPromptDatabankSourceV1 {
  readonly kind: "automatic" | "mention";
  readonly databankId: string;
  readonly documentId: string;
  readonly documentName: string;
  readonly chunkId: string | null;
  readonly documentContentHash: string | null;
  readonly contentHash: string;
}

export type AgentPromptNativeProvenanceV1 =
  | {
    readonly kind: "world_info";
    readonly sourceId: string;
    readonly sourceRevision: AgentPromptRevisionV1;
    readonly sourceIndex: number;
  }
  | {
    readonly kind: "databank";
    readonly sourceRevision: string;
    readonly sources: readonly AgentPromptDatabankSourceV1[];
  };

export type AgentRenderCrossingKindV1 = "accepted_finding" | "accepted_submission" | "completion_guidance";

export interface AgentRenderCrossingV1 {
  readonly version: 1;
  readonly id: string;
  readonly kind: AgentRenderCrossingKindV1;
  readonly sourceId: string;
  readonly sourceRevision: number | null;
  readonly contentDigest: string;
  readonly content: string | null;
  readonly correlation: AgentInspectionCorrelationV1;
}
export type AgentPromptEvidenceDestinationV1 =
  | "root_work"
  | "child_work"
  | "completion_handoff"
  | "render"
  | "council"
  | "cortex";

export interface AgentPromptEvidenceV1 {
  readonly version: 1;
  readonly id: string;
  readonly sourceId: string;
  readonly sourceRevision: AgentPromptRevisionV1;
  /** Canonical zero-based source occurrence: the frozen Loom source coordinate for cognition, assembly source index otherwise. */
  readonly promptOrder: number;
  readonly destination: AgentPromptEvidenceDestinationV1;
  readonly role: "system" | "user" | "assistant" | "tool" | "context" | "policy";
  readonly correlation: AgentInspectionCorrelationV1;
  readonly included: boolean;
  readonly content: string;
  readonly contentDigest: string;
  readonly omissionReason: string | null;
  readonly nativeProvenance: AgentPromptNativeProvenanceV1 | null;
  readonly loomInspection: LoomPromptInspectionV1 | null;
}

export type AgentCortexReceiptStateV1 = "accepted" | "omitted" | "failed" | "cancelled";
export type AgentCortexCheckpointV1 = "WORK";
/** Opaque source revision identity; never coerce a digest-like revision to zero. */
export type AgentCortexRevisionV1 = string | number;
export type AgentCortexOmissionReasonV1 =
  | "stale"
  | "unauthorized"
  | "unavailable"
  | "cancelled"
  | "failed"
  | "limit_exceeded"
  | "snapshot_mismatch";

export interface AgentCortexScopeV1 {
  readonly chatId: string;
  readonly targetMessageId: string | null;
  readonly targetSwipeId: number | null;
}

export interface AgentCortexOmissionV1 {
  readonly reason: AgentCortexOmissionReasonV1;
  readonly required: boolean;
  /** Bounded host diagnostic; never contains the sidecar result or snapshot payload. */
  readonly detail: string | null;
}

export interface AgentCortexReceiptV1 {
  readonly version: 1;
  readonly id: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly checkpoint: AgentCortexCheckpointV1;
  readonly snapshotId: string;
  readonly sourceRevision: AgentCortexRevisionV1;
  readonly revision: AgentCortexRevisionV1;
  readonly scope: AgentCortexScopeV1;
  readonly required: boolean;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly state: AgentCortexReceiptStateV1;
  readonly resultDigest: string | null;
  readonly resultCount: number;
  readonly correlation: AgentInspectionCorrelationV1;
  readonly reason: AgentInspectionReasonV1 | null;
  readonly omission: AgentCortexOmissionV1 | null;
  readonly canonical: false;
}

export type AgentCouncilReceiptStateV1 = AgentCortexReceiptStateV1;
export type AgentCouncilCheckpointV1 = "WORK";

export interface AgentCouncilReceiptV1 {
  readonly version: 1;
  readonly id: string;
  readonly requestId: string;
  readonly checkpoint: AgentCouncilCheckpointV1;
  readonly required: boolean;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly state: AgentCouncilReceiptStateV1;
  readonly memberCount: number;
  readonly resultDigest: string | null;
  readonly correlation: AgentInspectionCorrelationV1;
  readonly reason: AgentInspectionReasonV1 | null;
  readonly canonical: false;
}

export interface AgentWorkspaceAssociationV1 {
  readonly version: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly relation: "linked" | "published" | "omitted";
  readonly objectKind:
    | "objective"
    | "task"
    | "finding"
    | "decision"
    | "question"
    | "submission"
    | "artifact"
    | "publication";
  readonly objectId: string | null;
  readonly sourceRevision: number | null;
  readonly sourceDeleted: boolean;
  readonly provenanceDigest: string | null;
  readonly correlation: AgentInspectionCorrelationV1;
}

export interface AgentActivityMilestoneV1 {
  readonly version: 1;
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: "root" | "provider" | "child" | "tool" | "milestone";
  readonly actor: "host" | "owner" | "provider" | "agent" | "child" | "tool";
  readonly phase: AgentInspectionLifecycleV1;
  readonly status: AgentInspectionStatusV1 | "omitted";
  readonly label: string;
  readonly toolId: string | null;
  readonly taskId: string | null;
  readonly sequence: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly elapsedMs: number | null;
  readonly usage: AgentInspectionUsageV1 | null;
  readonly correlation: AgentInspectionCorrelationV1;
}

export interface AgentActivityTreeV1 {
  readonly version: 1;
  readonly attempt: AgentInspectionAttemptLineageV1;
  readonly lifecycle: AgentInspectionLifecycleV1;
  readonly status: AgentInspectionStatusV1;
  readonly outcome: AgentInspectionOutcomeV1 | null;
  readonly reason: AgentInspectionReasonV1;
  readonly revision: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | null;
  readonly target: AgentRunTargetV1 | null;
  readonly milestones: readonly AgentActivityMilestoneV1[];
  readonly usage: AgentActivityUsageV2;
  readonly markers: readonly AgentInspectionMarkerV1[];
  readonly reconciliation: "authoritative" | "reconciling" | "recovered" | "stale";
}

export interface AgentRunInspectionSummaryV1 {
  readonly version: 1;
  readonly attempt: AgentInspectionAttemptLineageV1;
  readonly runId: string;
  readonly turnSessionId: string;
  readonly generationId: string;
  readonly hostCorrelationId: string;
  readonly lifecycle: AgentInspectionLifecycleV1;
  readonly status: AgentInspectionStatusV1;
  readonly outcome: AgentInspectionOutcomeV1 | null;
  readonly reason: AgentInspectionReasonV1;
  readonly target: AgentRunTargetV1 | null;
  readonly committedTarget: AgentRunTargetV1 | null;
  readonly revision: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | null;
  readonly activity: AgentActivityTreeV1;
  readonly markerCount: number;
  readonly transcriptCount: number;
  readonly terminal: boolean;
}

export interface AgentRunInspectionStopV1 {
  readonly version: 1;
  readonly state: "accepted" | "too_late" | "terminal" | "failed" | "reconciled";
  readonly requestedAt: number;
  readonly receiptAt: number | null;
  readonly correlation: AgentInspectionCorrelationV1;
  readonly reason: AgentInspectionReasonV1;
}

export interface AgentRunInspectionRetryV1 {
  readonly allowed: boolean;
  readonly reason: AgentInspectionReasonV1;
  readonly targetValid: boolean;
  readonly linkedAttemptId: string | null;
}

export type AgentWorkSegmentBoundaryClassV1 =
  | "tool_action"
  | "tool_free_stop"
  | "reasoning_only_stop"
  | "reasoning_only_length"
  | "empty_provider_response"
  | "provider_protocol_failure";

export interface AgentWorkSegmentUsageInspectionV1 {
  readonly providerDispatches: number;
  readonly providerInputTokens: number;
  readonly providerOutputTokens: number;
  readonly providerTotalTokens: number;
  readonly billedOutputTokens: number;
  readonly toolCalls: number;
  readonly workspaceOperations: number;
  readonly unsignedBoundaries: number;
  readonly receiveBytes: number;
  readonly publishedOutputBytes: number;
}

export interface AgentWorkSegmentIdentityInspectionV1 {
  readonly segmentId: string;
  readonly phaseId: string | null;
  readonly phaseIndex: number;
  readonly phaseOccurrence: number;
  readonly segmentOrdinal: number;
}

/** Explicit owner-safe projection. It cannot carry prompts, credentials, endpoints, or continuation state. */
export interface AgentWorkSegmentInspectionProjectionV1 {
  readonly recovery: {
    readonly state: "active" | "closed";
    readonly phaseId: string | null;
    readonly phaseIndex: number | null;
    readonly phaseOccurrence: number | null;
    readonly nextSegmentOrdinal: number;
    readonly currentSegmentId: string | null;
    readonly workspaceRevision: number;
    readonly terminalCloseResult: "failed" | "exhausted" | "cancelled" | null;
    readonly terminalBoundaryClass: AgentWorkSegmentBoundaryClassV1 | null;
    readonly usage: AgentWorkSegmentUsageInspectionV1 & { readonly segments: number };
  };
  readonly segments: readonly {
    readonly identity: AgentWorkSegmentIdentityInspectionV1;
    readonly lifecycle: "admitted" | "running" | "closed" | "interrupted" | "failed" | "exhausted" | "cancelled";
    readonly workspaceRevision: number;
    readonly boundaryClass: AgentWorkSegmentBoundaryClassV1 | null;
    readonly closeResult: "phase_advanced" | "phase_repeated" | "same_phase_rollover" | "work_complete" | "failed" | "exhausted" | "cancelled" | null;
    readonly closedWorkspaceRevision: number | null;
    readonly usage: AgentWorkSegmentUsageInspectionV1;
  }[];
  readonly dispatches: readonly {
    readonly dispatchId: string;
    readonly segmentId: string;
    readonly dispatchOrdinal: number;
    readonly lifecycle: "reserved" | "in_flight" | "settled" | "interrupted";
    readonly toolMode: "ordinary" | "required";
    readonly budgetClass: "normal" | "recovery";
    readonly workspaceRevision: number;
    readonly settledWorkspaceRevision: number | null;
    readonly boundaryClass: AgentWorkSegmentBoundaryClassV1 | null;
    readonly usage: AgentWorkSegmentUsageInspectionV1 | null;
  }[];
  readonly transitions: readonly {
    readonly transitionId: string;
    readonly handoffId: string;
    readonly transitionKind: "advance" | "repeat" | "rollover" | "terminal";
    readonly sourceSegment: AgentWorkSegmentIdentityInspectionV1;
    readonly sourceWorkspaceRevision: number;
    readonly targetPhaseId: string | null;
    readonly targetPhaseIndex: number | null;
    readonly targetPhaseOccurrence: number | null;
    readonly targetSegmentOrdinal: number | null;
    readonly cause: AgentWorkSegmentBoundaryClassV1 | null;
  }[];
}

export interface AgentRunInspectionDetailV1 extends AgentRunInspectionSummaryV1 {
  readonly transcript: readonly AgentInspectionTranscriptRecordV1[];
  readonly turnSession: readonly AgentTurnSessionEntryV1[];
  readonly markers: readonly AgentInspectionMarkerV1[];
  readonly usageEvidence: readonly AgentInspectionUsageV1[];
  readonly usage: AgentInspectionUsageProjectionV1;
  readonly error: AgentInspectionErrorDetailV1 | null;
  readonly promptEvidence: readonly AgentPromptEvidenceV1[];
  readonly renderCrossings: readonly AgentRenderCrossingV1[];
  readonly cortexReceipts: readonly AgentCortexReceiptV1[];
  readonly councilReceipts: readonly AgentCouncilReceiptV1[];
  readonly workspaceAssociations: readonly AgentWorkspaceAssociationV1[];
  readonly stop: AgentRunInspectionStopV1 | null;
  readonly retry: AgentRunInspectionRetryV1;
  /** Bounded redacted WORK ledger; null before durable segment authority exists. */
  readonly workSegments: AgentWorkSegmentInspectionProjectionV1 | null;
  readonly sectionAvailability: readonly AgentInspectionSectionAvailabilityV1[];
}

export interface AgentRunInspectionListV1 {
  readonly version: 1;
  readonly chatId: string;
  readonly runs: readonly AgentRunInspectionSummaryV1[];
  readonly nextCursor: string | null;
  readonly omission: AgentInspectionMarkerV1 | null;
}

export interface AgentRunInspectionRetryResponseV1 {
  readonly version: 1;
  readonly accepted: boolean;
  readonly attempt: AgentInspectionAttemptLineageV1 | null;
  readonly reason: AgentInspectionReasonV1;
  readonly target?: AgentWorkTargetIdentityV1;
  readonly recoveryEligible?: boolean;
  readonly recoveryAction?: AgentRecoveryActionV2;
  readonly inspectionAttemptId?: string | null;
  readonly error?: AgentRunPublicErrorV2;
}
