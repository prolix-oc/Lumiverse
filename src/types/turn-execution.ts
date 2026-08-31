/**
 * Durable, host-owned state for one generation turn.
 *
 * This contract is intentionally a persistence boundary. Provider transcripts,
 * continuation carriers, reasoning, tool arguments/results, credentials, and
 * other transient runtime payloads are not represented here.
 */

export const TURN_EXECUTION_STATES = [
  "ASSEMBLE",
  "WORK",
  "COMPLETE",
  "RENDER",
  "PREPARE_COMMIT",
  "COMMITTING",
  "COMMITTED",
  "COMMIT_FAILED",
  "EXHAUSTED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;

/** The only durable phase/terminal state names accepted by the host. */
export type TurnExecutionStateV1 = (typeof TURN_EXECUTION_STATES)[number];
export type TurnExecutionPhaseV1 = TurnExecutionStateV1;
export type TurnExecutionState = TurnExecutionStateV1;

export const GENERATION_TARGETS = ["normal", "continue", "regenerate", "swipe"] as const;
export type GenerationTargetKind = (typeof GENERATION_TARGETS)[number];
export type GenerationTarget = GenerationTargetKind;

export type TurnGenerationModeV1 = "response" | "agentic";

/**
 * Frozen target identity and revisions captured before a generation can mutate
 * a chat, message, or swipe. A null message is valid for a normal generation
 * that appends a new assistant message.
 */
export interface GenerationTargetV1 {
  readonly target: GenerationTargetKind;
  readonly chatId: string;
  readonly branchId: string | null;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly messageIndex: number | null;
  readonly swipeCount: number | null;
  readonly chatGenerationRevision: number;
  readonly messageGenerationRevision: number | null;
}

/** Descriptive alias used by snapshot builders and tests. */
export type GenerationTargetSnapshotV1 = GenerationTargetV1;

export interface TurnFrozenRevisionSetV1 {
  readonly target: GenerationTargetV1;
  readonly presetId: string | null;
  readonly presetRevision: number;
  readonly configId: string | null;
  readonly configRevision: number;
  readonly connectionId: string | null;
  readonly connectionRevision: number;
  readonly worldLoreSnapshotId: string | null;
  readonly worldLoreRevision: number;
  readonly runtimeEpoch: number;
  readonly readinessDigest: string;
}

/** Host-owned ledger counters; values contain no provider or user prose. */
export interface TurnLedgerSnapshotV1 {
  readonly revision: number;
  readonly reservedRequests: number;
  readonly usedRequests: number;
  readonly reservedOutputBytes: number;
  readonly usedOutputBytes: number;
  readonly reservedWorkspaceBytes: number;
  readonly usedWorkspaceBytes: number;
  readonly terminal: boolean;
}

/** Capability names are stable host controls, not arbitrary provider tools. */
export type TurnFrameCapabilityV1 =
  | "read_workspace"
  | "create_task"
  | "update_assigned_task"
  | "submit_child_result"
  | "record_finding"
  | "record_decision"
  | "record_question"
  | "attach_artifact"
  | "propose_publication"
  | "complete_turn";

export interface TurnFrameCapabilitiesV1 {
  readonly revision: number;
  readonly allowed: readonly TurnFrameCapabilityV1[];
  readonly maxOperationBytes: number;
  readonly maxOperations: number;
}

/** A reservation for the single final render request. */
export interface FinalRenderReservationV1 {
  readonly id: string;
  readonly requestCount: 1;
  /** Non-empty provider chunks admitted during RENDER. */
  readonly activityChunks: number;
  /** Provider chunks plus the terminal projection event. */
  readonly activityEvents: number;
  readonly contextBytes: number;
  readonly outputBytes: number;
  /** Exact context/output plus bounded durable terminal payloads. */
  readonly maxBytes: number;
  readonly deadlineAt: number;
  readonly revision: number;
  readonly reservedAt: number;
}

export interface TurnExecutionCasV1 {
  readonly revision: number;
  readonly owner: string | null;
  readonly ownerExpiresAt: number | null;
}

/**
 * Durable execution identity. The phase machine is implemented elsewhere; this
 * type only freezes the data needed to validate a future transition/commit.
 */
export interface TurnExecutionV1 {
  readonly id: string;
  readonly userId: string;
  readonly chatId: string;
  readonly branchId: string | null;
  readonly generationId: string;
  readonly target: GenerationTargetV1;
  readonly presetSnapshotId: string | null;
  readonly configSnapshotId: string | null;
  readonly concreteConnectionSnapshotId: string | null;
  readonly frozenRevisions: TurnFrozenRevisionSetV1;
  readonly mode: TurnGenerationModeV1;
  readonly runtimeEpoch: number;
  readonly deadlineAt: number;
  readonly cancelRequestedAt: number | null;
  readonly rootLedger: TurnLedgerSnapshotV1;
  readonly frameCapabilities: TurnFrameCapabilitiesV1;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly state: TurnExecutionStateV1;
  readonly cas: TurnExecutionCasV1;
  readonly commitKey: string;
  readonly finalRenderReservations: readonly FinalRenderReservationV1[];
  readonly terminalCode: string | null;
  readonly retention: "operational" | "turn_terminal";
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | null;
}

/** Persistence-oriented aliases retained for service readability. */
export type TurnExecutionRecordV1 = TurnExecutionV1;
export type TurnExecution = TurnExecutionV1;
