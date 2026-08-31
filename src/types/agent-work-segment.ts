import type { WorkspaceOperationKindV1 } from "./turn-workspace";

export const WORK_SEGMENT_SCHEMA_VERSION_V1 = 1 as const;

export type WorkSegmentSchemaVersionV1 = typeof WORK_SEGMENT_SCHEMA_VERSION_V1;

export type WorkProviderBoundaryClassV1 =
  | "tool_action"
  | "tool_free_stop"
  | "reasoning_only_stop"
  | "reasoning_only_length"
  | "empty_provider_response"
  | "provider_protocol_failure";

export type WorkSegmentLifecycleV1 =
  | "admitted"
  | "running"
  | "closed"
  | "interrupted"
  | "failed"
  | "exhausted"
  | "cancelled";

export type WorkSegmentTransitionKindV1 = "advance" | "repeat" | "rollover" | "terminal";
export type WorkSegmentDispatchLifecycleV1 = "reserved" | "in_flight" | "settled" | "interrupted";
export type WorkSegmentToolModeV1 = "ordinary" | "required";
/** Host-only accounting authority; it is never serialized to a provider. */
export type WorkSegmentDispatchBudgetClassV1 = "normal" | "recovery";

/**
 * Phase occurrence is authored control-flow identity. A recovery rollover keeps
 * it stable and increments only segmentOrdinal. An authored repeat increments
 * both phaseOccurrence and segmentOrdinal.
 */
export interface WorkSegmentIdentityV1 {
  readonly version: WorkSegmentSchemaVersionV1;
  readonly executionId: string;
  readonly attemptId: string;
  readonly segmentId: string;
  readonly phaseId: string | null;
  readonly phaseIndex: number;
  readonly phaseOccurrence: number;
  readonly segmentOrdinal: number;
}

export interface WorkSegmentUsageV1 {
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

export interface WorkAttemptUsageV1 extends WorkSegmentUsageV1 {
  readonly segments: number;
}

/** Independent attempt-wide ceilings. None are derived by multiplying another ceiling. */
export interface WorkAttemptBudgetV1 {
  readonly maxSegments: number;
  readonly maxProviderDispatches: number;
  readonly maxProviderOutputTokens: number;
  /** Hard ceiling for one provider dispatch, independent of every cumulative ceiling. */
  readonly maxOutputTokensPerDispatch: number;
  readonly maxUnsignedBoundaries: number;
  readonly maxToolCalls: number;
  readonly maxWorkspaceOperations: number;
  readonly recoveryReserveOutputTokens: number;
  readonly futurePhaseReserveOutputTokens: number;
}

/** A segment receives an explicit local allowance carved from the attempt budget. */
export interface WorkSegmentBudgetV1 {
  readonly maxProviderDispatches: number;
  readonly maxProviderOutputTokens: number;
  readonly maxOutputTokensPerDispatch: number;
  readonly maxUnsignedBoundaries: number;
  readonly maxToolCalls: number;
  readonly maxWorkspaceOperations: number;
}

export interface WorkPhasePlanEntryV1 {
  readonly id: string;
  readonly index: number;
  readonly required: boolean;
  readonly nextPhaseIds: readonly string[];
  readonly repeatLimit: number;
  readonly transitionAuthorityDigest: string;
  readonly skipEligibilityDigest: string | null;
}

/** Immutable authored phase order. An empty plan denotes the built-in WORK phase. */
export interface WorkPhasePlanAuthorityV1 {
  readonly version: WorkSegmentSchemaVersionV1;
  readonly phases: readonly WorkPhasePlanEntryV1[];
}

/** One frozen authored-phase skip decision, bound to the inspected workspace revision. */
export interface WorkSegmentSkippedPhaseDecisionAuthorityV1 {
  readonly phaseId: string;
  readonly phaseIndex: number;
  readonly checkpoint: "entry" | "skip";
  readonly revision: number;
  readonly condition: "true" | "false";
  readonly phaseAuthorityDigest: string;
  readonly evaluationDigest: string;
}

/** Exact host authority for admitting the built-in Segment after every authored phase skipped. */
export interface WorkSegmentAllOptionalPhasesSkippedAuthorityV1 {
  readonly version: WorkSegmentSchemaVersionV1;
  readonly kind: "all_authored_optional_phases_skipped";
  readonly skippedPhaseIds: readonly string[];
  readonly decisions: readonly WorkSegmentSkippedPhaseDecisionAuthorityV1[];
  readonly authorityDigest: string;
}

export interface WorkResumeConnectionIdentityV1 {
  readonly logicalId: string;
  readonly concreteId: string;
  readonly label: string;
  readonly provider: string;
  readonly model: string;
  readonly effectiveEndpoint: string;
  readonly endpointRevision: string | number;
  readonly credentialSecretRef: string;
  readonly credentialRevision: string | number;
  readonly candidateRevision: string | number;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly capabilityDigest: string;
  readonly fingerprint: string;
}

/** Bounded immutable authority needed to reconstruct, never replay, admitted WORK. */
export interface WorkSegmentResumeEnvelopeV1 {
  readonly version: WorkSegmentSchemaVersionV1;
  readonly envelopeDigest: string;
  readonly snapshotDigest: string;
  readonly planDigest: string;
  readonly toolCatalogSchemaVersion: number;
  readonly toolCatalogDigest: string;
  readonly configRevision: string | number;
  readonly authoredRootToolIds: readonly string[];
  readonly authoredChildToolIds: Readonly<Record<string, readonly string[]>>;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly rootConnection: WorkResumeConnectionIdentityV1;
  readonly childConnections: Readonly<Record<string, WorkResumeConnectionIdentityV1>>;
  readonly generationParameters: Readonly<Record<string, unknown>> | null;
  /** Exact bounded secret-free public request authority; never includes signal/token/carrier. */
  readonly resumeInput: Readonly<Record<string, unknown>>;
  /** Exact bounded private admission authority excluding duplicated root/child connections. */
  readonly decisionAuthority: Readonly<Record<string, unknown>>;
  readonly liveTargetBinding: Readonly<Record<string, unknown>>;
  readonly runtime: Readonly<{
    deadlineAt: number;
    rootFrameId: string;
    workspaceId: string;
    workspaceRevision: number;
    ownerLimits: Readonly<Record<string, number>>;
    workspaceRetention: "turn_terminal" | "chat_lifetime";
    workspaceSharing: "root_only" | "view_only";
  }>;
}

export interface WorkSegmentAttemptRecoveryV1 {
  readonly version: WorkSegmentSchemaVersionV1;
  readonly complete: true;
  readonly userId: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly executionCasRevision: number;
  /** Runtime epoch that durably queued this active attempt for exact resume. */
  readonly recoveryEpoch: number;
  readonly state: "active" | "closed";
  readonly phaseId: string | null;
  readonly phaseIndex: number | null;
  readonly phaseOccurrence: number | null;
  readonly nextSegmentOrdinal: number;
  readonly currentSegmentId: string | null;
  readonly snapshotDigest: string;
  readonly initialRequiredPhaseCount: number;
  readonly remainingRequiredPhaseCount: number;
  /** Current protected balances. Rollover and repeat cannot reset or release them. */
  readonly protectedRecoveryReserveOutputTokens: number;
  readonly protectedFuturePhaseReserveOutputTokens: number;
  readonly terminalCloseResult: WorkSegmentTerminalResultV1["kind"] | null;
  readonly terminalCloseReason: string | null;
  readonly terminalBoundaryClass: WorkProviderBoundaryClassV1 | null;
  readonly phasePlanDigest: string;
  readonly phasePlan: WorkPhasePlanAuthorityV1;
  readonly bindingDigest: string;
  readonly idempotencyKey: string;
  readonly payloadDigest: string;
  readonly resumeEnvelopeDigest: string;
  readonly resumeEnvelope: WorkSegmentResumeEnvelopeV1;
  readonly budget: WorkAttemptBudgetV1;
  readonly usage: WorkAttemptUsageV1;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorkSegmentAdmissionV1 {
  readonly version: WorkSegmentSchemaVersionV1;
  readonly complete: true;
  readonly identity: WorkSegmentIdentityV1;
  readonly sourceTransitionId: string | null;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly executionCasRevision: number;
  readonly lifecycle: WorkSegmentLifecycleV1;
  readonly admissionKey: string;
  readonly payloadDigest: string;
  readonly contextDigest: string;
  /** Exact bounded provider-neutral authority required to resume this admitted segment. */
  readonly context: WorkSegmentContextV1;
  readonly snapshotDigest: string;
  readonly bindingDigest: string;
  readonly budget: WorkSegmentBudgetV1;
  readonly usage: WorkSegmentUsageV1;
  readonly boundaryClass: WorkProviderBoundaryClassV1 | null;
  readonly closeResult: WorkSegmentRunnerResultV1["kind"] | null;
  readonly closedWorkspaceRevision: number | null;
  readonly closedExecutionCasRevision: number | null;
  readonly closeReason: string | null;
  readonly closureDigest: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
}

export interface WorkHandoffAcceptedIdsV1 {
  readonly authority: "host";
  readonly taskIds: readonly string[];
  readonly submissionIds: readonly string[];
  readonly findingIds: readonly string[];
  readonly decisionIds: readonly string[];
  readonly artifactIds: readonly string[];
}

export interface WorkHandoffAdvisoryCompletionV1 {
  readonly authority: "model_advisory";
  readonly summary: string;
  readonly unresolvedIds: readonly string[];
  readonly renderGuidance: string | null;
}

export interface WorkPhaseHandoffV1 {
  readonly version: WorkSegmentSchemaVersionV1;
  readonly complete: true;
  readonly handoffId: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly sourceSegment: WorkSegmentIdentityV1;
  readonly transitionDecisionDigest: string;
  readonly sourceWorkspaceRevision: number;
  readonly sourceExecutionCasRevision: number;
  readonly transitionKind: WorkSegmentTransitionKindV1;
  readonly remainingRequiredPhaseCount: number;
  readonly releasedFuturePhaseReserveOutputTokens: number;
  readonly targetPhaseId: string | null;
  readonly targetPhaseIndex: number | null;
  readonly targetPhaseOccurrence: number | null;
  readonly targetSegmentOrdinal: number | null;
  readonly acceptedIds: WorkHandoffAcceptedIdsV1;
  readonly openRequiredIds: readonly string[];
  readonly completion: WorkHandoffAdvisoryCompletionV1;
  readonly usage: WorkSegmentUsageV1;
  readonly idempotencyKey: string;
  readonly payloadDigest: string;
  readonly createdAt: number;
}

/** The durable transition receipt and handoff are one immutable 1:1 record. */
export interface WorkPhaseTransitionReceiptV1 {
  readonly version: WorkSegmentSchemaVersionV1;
  readonly complete: true;
  readonly transitionId: string;
  readonly handoff: WorkPhaseHandoffV1;
}

export interface WorkSegmentDispatchReservationV1 {
  readonly version: WorkSegmentSchemaVersionV1;
  readonly complete: true;
  readonly dispatchId: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly segmentId: string;
  readonly dispatchOrdinal: number;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly executionCasRevision: number;
  readonly lifecycle: WorkSegmentDispatchLifecycleV1;
  readonly toolMode: WorkSegmentToolModeV1;
  readonly budgetClass: WorkSegmentDispatchBudgetClassV1;
  readonly reservedOutputTokens: number;
  readonly ordinaryOutputTokensReserved: number;
  readonly recoveryReserveOutputTokensReserved: number;
  readonly recoveryReserveOutputTokensConsumed: number | null;
  readonly interruptionReason: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: number | null;
  readonly fenceGeneration: number;
  readonly idempotencyKey: string;
  readonly payloadDigest: string;
  readonly settlementKey: string | null;
  readonly settlementDigest: string | null;
  readonly settledWorkspaceRevision: number | null;
  readonly settledExecutionCasRevision: number | null;
  readonly boundaryClass: WorkProviderBoundaryClassV1 | null;
  readonly usage: WorkSegmentUsageV1 | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly settledAt: number | null;
  readonly updatedAt: number;
}

export type AgenticWorkMutatingWorkspaceOperationKindV1 =
  | Exclude<WorkspaceOperationKindV1, "read_section" | "read_page">
  | "assign_child_tasks"
  | "settle_child_task";

/** Exact durable dispatch and authenticated frame that own one workspace mutation. */
export interface AgenticWorkWorkspaceMutationReservationV1 {
  readonly version: WorkSegmentSchemaVersionV1;
  readonly operationKey: string;
  readonly operationKind: AgenticWorkMutatingWorkspaceOperationKindV1;
  readonly segmentId: string;
  readonly logicalDispatch: number;
  readonly frameId: string;
}

/**
 * This metadata may refer only to an already-settled transactional workspace
 * operation. It is not permission to retry a provider call or a non-DB effect.
 */
export interface WorkSettledWorkspaceEffectV1 {
  readonly version: WorkSegmentSchemaVersionV1;
  readonly kind: "workspace_operation";
  readonly state: "settled";
  readonly operationKey: string;
  readonly segmentId: string;
  readonly logicalDispatch: number;
  readonly frameId: string;
  readonly operationDigest: string;
  readonly beforeWorkspaceRevision: number;
  readonly afterWorkspaceRevision: number;
}

export interface WorkSegmentAcceptedRecordV1 {
  readonly kind: "task" | "submission" | "finding" | "decision" | "artifact";
  readonly id: string;
  readonly digest: string;
  readonly summary: string;
  readonly taskId: string | null;
}

export interface WorkSegmentContextV1 {
  readonly version: WorkSegmentSchemaVersionV1;
  readonly contextDigest: string;
  /** Aggregate host binding over snapshot, phase plan, protocol, capabilities, and budgets. */
  readonly bindingDigest: string;
  readonly resumeEnvelopeDigest: string;
  readonly phasePlanDigest: string;
  readonly protocolDigest: string;
  readonly capabilityDigest: string;
  readonly phaseCapabilityDigest: string;
  readonly rootObjective: string;
  readonly rootSnapshotId: string;
  readonly rootSnapshotDigest: string;
  readonly phase: Readonly<{
    id: string | null;
    index: number;
    occurrence: number;
    instructions: readonly string[];
    completionCriteria: readonly string[];
    admittedCapabilities: readonly string[];
  }>;
  readonly workspace: Readonly<{
    id: string;
    revision: number;
    acceptedRecords: readonly WorkSegmentAcceptedRecordV1[];
    openRequiredIds: readonly string[];
  }>;
  readonly allOptionalPhasesSkippedAuthority?: WorkSegmentAllOptionalPhasesSkippedAuthorityV1;
  readonly previousHandoff: WorkPhaseHandoffV1 | null;
  readonly attemptBudget: WorkAttemptBudgetV1;
  readonly segmentBudget: WorkSegmentBudgetV1;
  readonly protocol: Readonly<{
    completeTurnCallMode: "standalone_only";
    requiredToolModeAvailable: boolean;
  }>;
}

export type WorkSegmentRunnerResultV1 =
  | WorkSegmentTransitionResultV1
  | WorkSegmentTerminalResultV1;

export type WorkSegmentTransitionResultV1 = Readonly<{
  version: WorkSegmentSchemaVersionV1;
  segment: WorkSegmentIdentityV1;
  workspaceRevision: number;
  usage: WorkSegmentUsageV1;
  boundaryClass: WorkProviderBoundaryClassV1;
}> & (
  | Readonly<{ kind: "phase_advanced"; targetPhaseId: string; targetPhaseIndex: number; targetPhaseOccurrence: number }>
  | Readonly<{ kind: "phase_repeated"; targetPhaseId: string; targetPhaseIndex: number; targetPhaseOccurrence: number }>
  | Readonly<{ kind: "same_phase_rollover"; cause: WorkProviderBoundaryClassV1 }>
  | Readonly<{ kind: "work_complete"; completion: WorkHandoffAdvisoryCompletionV1 }>
);

export type WorkSegmentTerminalResultV1 = Readonly<{
  version: WorkSegmentSchemaVersionV1;
  segment: WorkSegmentIdentityV1;
  workspaceRevision: number;
  usage: WorkSegmentUsageV1;
  boundaryClass: WorkProviderBoundaryClassV1 | null;
}> & (
  | Readonly<{ kind: "failed"; code: string }>
  | Readonly<{ kind: "exhausted"; code: string }>
  | Readonly<{ kind: "cancelled"; code: string }>
);

/**
 * Provider-neutral execution seam. One future Pi run maps to exactly one
 * admitted WorkSegment; completion authority, render, transition commit, and
 * attempt closure remain host-owned outside the runner.
 */
export interface WorkSegmentRunnerV1 {
  run(input: Readonly<{
    admission: WorkSegmentAdmissionV1;
    context: WorkSegmentContextV1;
    signal: AbortSignal;
  }>): Promise<WorkSegmentRunnerResultV1>;
}

export interface WorkSegmentRecoveryChainV1 {
  readonly version: WorkSegmentSchemaVersionV1;
  readonly recovery: WorkSegmentAttemptRecoveryV1;
  readonly segments: readonly WorkSegmentAdmissionV1[];
  readonly transitions: readonly WorkPhaseTransitionReceiptV1[];
  readonly dispatches: readonly WorkSegmentDispatchReservationV1[];
}
