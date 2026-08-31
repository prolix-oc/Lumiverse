import {
  AGENT_WORK_OUTCOMES,
  AGENT_WORK_PHASES,
  AGENT_WORK_STATUSES,
  type AgentWorkOutcome,
  type AgentWorkPhase,
  type AgentWorkStatus,
} from "./agent-runtime";
import type {
  FinalRenderReservationV1,
  TurnExecutionStateV1,
} from "./turn-execution";
import type { PaginatedResult } from "./pagination";

/** Workspace records are retained owner-visible summaries, never raw work data. */
export type WorkspaceRetentionV1 = "operational" | "turn_terminal" | "chat_lifetime";
export type WorkspaceRetention = WorkspaceRetentionV1;

/** Canonical task lifecycle. Submission acceptance is represented separately. */
export const WORKSPACE_TASK_STATES = [
  "pending",
  "active",
  "blocked",
  "completed",
  "cancelled",
  "failed",
] as const;
export type WorkspaceTaskStateV1 = (typeof WORKSPACE_TASK_STATES)[number];
export type WorkspaceTaskState = WorkspaceTaskStateV1;

export const WORKSPACE_RECORD_KINDS = ["finding", "decision", "question"] as const;
export type WorkspaceRecordKindV1 = (typeof WORKSPACE_RECORD_KINDS)[number];
export type WorkspaceRecordKind = WorkspaceRecordKindV1;

export const WORKSPACE_SUBMISSION_STATES = ["submitted", "accepted", "rejected"] as const;
export type WorkspaceSubmissionStateV1 = (typeof WORKSPACE_SUBMISSION_STATES)[number];

export const WORKSPACE_PUBLICATION_CATEGORIES = ["task", "finding", "objective", "artifact"] as const;
export type WorkspacePublicationCategoryV1 = (typeof WORKSPACE_PUBLICATION_CATEGORIES)[number];
export type WorkspacePublicationCategory = WorkspacePublicationCategoryV1;

export const PERSISTENT_WORKSPACE_TURN_PHASES = AGENT_WORK_PHASES;
export type PersistentWorkspaceTurnPhaseV1 = AgentWorkPhase;

export const PERSISTENT_WORKSPACE_TURN_STATUSES = AGENT_WORK_STATUSES;
export type PersistentWorkspaceTurnStatusV1 = AgentWorkStatus;

export const PERSISTENT_WORKSPACE_TERMINAL_OUTCOMES = AGENT_WORK_OUTCOMES;
export type PersistentWorkspaceTerminalOutcomeV1 = AgentWorkOutcome;

export type PersistentWorkspaceStateV1 = "active" | "archived";

export const PERSISTENT_WORKSPACE_RECORD_KINDS = ["finding", "decision", "question"] as const;
export type PersistentWorkspaceRecordKindV1 = (typeof PERSISTENT_WORKSPACE_RECORD_KINDS)[number];


export const WORKSPACE_ARTIFACT_PUBLICATION_STATES = [
  "attached",
  "proposed",
  "published",
] as const;
export type WorkspaceArtifactPublicationStateV1 =
  (typeof WORKSPACE_ARTIFACT_PUBLICATION_STATES)[number];

/** Closed operation vocabulary exposed to a granted frame. */
export const WORKSPACE_OPERATIONS = [
  "read_section",
  "read_page",
  "create_task",
  "update_assigned_progress",
  "submit_child_result",
  "submit_root_result",
  "accept_submission",
  "record_finding",
  "record_decision",
  "record_question",
  "attach_artifact",
  "propose_publication",
] as const;
export type WorkspaceOperationKindV1 = (typeof WORKSPACE_OPERATIONS)[number];
export type WorkspaceOperationKind = WorkspaceOperationKindV1;

/**
 * Per-frame host grants. A false capability is an authorization failure, not a
 * request to silently downgrade the operation.
 */
export interface WorkspaceOperationCapabilitiesV1 {
  readonly revision: number;
  readonly allowed: readonly WorkspaceOperationKindV1[];
  readonly maxOperationBytes: number;
  readonly maxOperations: number;
}
export type WorkspaceFieldCapabilitiesV1 = WorkspaceOperationCapabilitiesV1;

export interface WorkspaceQuotaV1 {
  readonly maxTasks: number;
  readonly maxRecords: number;
  readonly maxSubmissions: number;
  readonly maxArtifacts: number;
  readonly maxBytes: number;
}

export interface WorkspaceUsageV1 {
  readonly taskCount: number;
  readonly recordCount: number;
  readonly submissionCount: number;
  readonly artifactCount: number;
  readonly byteCount: number;
}

export type WorkspaceStateV1 = "active" | "frozen" | "expired";

/** Immutable objective and constraints supplied by the host at turn creation. */
export interface TurnWorkspaceV1 {
  readonly id: string;
  readonly turnId: string;
  readonly executionId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly state: WorkspaceStateV1;
  readonly revision: number;
  readonly quota: WorkspaceQuotaV1;
  readonly usage: WorkspaceUsageV1;
  readonly retention: WorkspaceRetentionV1;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly frozenAt: number | null;
}
export type TurnWorkspaceRecordV1 = TurnWorkspaceV1;
export type TurnWorkspace = TurnWorkspaceV1;

export interface WorkspaceTaskV1 {
  readonly id: string;
  readonly workspaceId: string;
  readonly turnId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly title: string;
  readonly objective: string;
  readonly state: WorkspaceTaskStateV1;
  /** Model-created tasks must always be false; only the host may require work. */
  readonly required: boolean;
  readonly dependencyIds: readonly string[];
  readonly assignedFrameId: string | null;
  readonly progress: number;
  readonly summary: string | null;
  readonly revision: number;
  readonly retention: WorkspaceRetentionV1;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type WorkspaceTask = WorkspaceTaskV1;

/** Host-authenticated task acceptance used to overlay authored phase-exit predicates. */
export interface WorkspaceTaskAcceptanceV1 {
  readonly id: string;
  readonly templateId: string | null;
  readonly required: boolean;
  readonly state: WorkspaceTaskStateV1;
  readonly completionAccepted: boolean;
}


export interface WorkspaceRecordV1 {
  readonly id: string;
  readonly workspaceId: string;
  readonly turnId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly kind: WorkspaceRecordKindV1;
  readonly summary: string;
  readonly digest: string;
  readonly taskId: string | null;
  readonly sourceFrameId: string | null;
  readonly byteCount: number;
  readonly revision: number;
  readonly retention: WorkspaceRetentionV1;
  readonly expiresAt: number;
  readonly createdAt: number;
}
export type WorkspaceRecord = WorkspaceRecordV1;

export interface WorkspaceSubmissionV1 {
  readonly id: string;
  readonly workspaceId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly childFrameId: string;
  readonly state: WorkspaceSubmissionStateV1;
  readonly summary: string;
  readonly resultDigest: string;
  readonly byteCount: number;
  readonly revision: number;
  readonly retention: WorkspaceRetentionV1;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type WorkspaceSubmission = WorkspaceSubmissionV1;

export type WorkspaceArtifactProvenanceV1 = "host" | "root" | "child";

export interface WorkspaceArtifactReferenceV1 {
  readonly id: string;
  readonly workspaceId: string;
  readonly turnId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly blobDigest: string;
  readonly mimeType: string;
  readonly byteCount: number;
  readonly provenance: WorkspaceArtifactProvenanceV1;
  readonly sourceFrameId: string | null;
  readonly sourceTaskId: string | null;
  readonly publicationState: WorkspaceArtifactPublicationStateV1;
  readonly retention: WorkspaceRetentionV1;
  readonly revision: number;
  readonly expiresAt: number;
  readonly createdAt: number;
}
export type WorkspaceArtifact = WorkspaceArtifactReferenceV1;

/** Immutable content-addressed artifact metadata; bytes live in the blob store. */
export interface AgentArtifactBlobV1 {
  readonly digest: string;
  readonly userId: string;
  readonly byteCount: number;
  readonly mimeType: string;
  /** Host-absolute operational blob path; never serialized into account archives. */
  readonly storagePath: string;
  readonly publishedReferenceCount: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type ArtifactBlobJournalStateV1 = "pending" | "installed" | "removed";

export interface AgentArtifactBlobJournalV1 {
  readonly id: string;
  readonly blobDigest: string;
  readonly userId: string;
  readonly turnId: string;
  readonly creatorToken: string;
  readonly fenceGeneration: number;
  readonly stagedPath: string;
  readonly finalPath: string;
  readonly state: ArtifactBlobJournalStateV1;
  readonly observedIdentity: string | null;
  readonly byteCount: number;
  readonly digest: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorkspaceCommitReceiptV1 {
  readonly id: string;
  readonly turnId: string;
  readonly executionId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly commitKey: string;
  readonly idempotencyKey: string;
  readonly state: "committed";
  readonly summaryDigest: string;
  readonly summary: string;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly artifactRefCount: number;
  readonly committedAt: number;
}

export interface PublishedWorkspaceArtifactV1 {
  readonly id: string;
  readonly receiptId: string;
  readonly sourceArtifactId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly blobDigest: string;
  /** Portable owner-relative canonical path used by export and import. */
  readonly storagePath: string;
  readonly mimeType: string;
  readonly byteCount: number;
  readonly digest: string;
  readonly retention: "chat_lifetime";
  readonly revision: number;
  readonly createdAt: number;
}

/** A public handoff contains only bounded identifiers and counts. */
export interface WorkspaceTerminalHandoffV1 {
  readonly workspaceId: string;
  readonly state: Extract<WorkspaceStateV1, "frozen" | "expired">;
  readonly revision: number;
  readonly executionState: TurnExecutionStateV1;
  readonly usage: WorkspaceUsageV1;
  readonly finalRenderReservations: readonly FinalRenderReservationV1[];
}
 
/**
 * Stable owner-only workspace records. These DTOs deliberately contain only
 * bounded, structured fields; provider credentials and private transcripts are
 * not representable.
 */
export interface PersistentWorkspaceMetadataV1 {
  readonly title: string;
  readonly summary: string;
  readonly labels: readonly string[];
  readonly ownerNote: string;
}

export type PersistentWorkspaceProgressStateV1 =
  | "not_started"
  | "in_progress"
  | "blocked"
  | "completed";

export interface PersistentWorkspaceProgressV1 {
  readonly state: PersistentWorkspaceProgressStateV1;
  readonly percent: number;
  readonly summary: string;
  readonly updatedAt: number;
}

export interface PersistentWorkspaceQuotaV1 {
  readonly maxTasks: number;
  readonly maxRecords: number;
  readonly maxSubmissions: number;
  readonly maxArtifacts: number;
  readonly maxPublications: number;
  readonly maxBytes: number;
}

export interface PersistentWorkspaceUsageV1 {
  readonly taskCount: number;
  readonly recordCount: number;
  readonly submissionCount: number;
  readonly artifactCount: number;
  readonly publicationCount: number;
  readonly byteCount: number;
}

export interface PersistentWorkspaceV1 {
  readonly version: 1;
  readonly id: string;
  readonly userId: string;
  /**
   * The live source chat attachment. A null value is an archived/detached
   * workspace; the owner may still read it by stable workspace ID.
   */
  readonly chatId: string | null;
  readonly objective: string;
  readonly metadata: PersistentWorkspaceMetadataV1;
  readonly progress: PersistentWorkspaceProgressV1;
  readonly state: PersistentWorkspaceStateV1;
  readonly revision: number;
  readonly quota: PersistentWorkspaceQuotaV1;
  readonly usage: PersistentWorkspaceUsageV1;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type PersistentWorkspace = PersistentWorkspaceV1;

export interface PersistentWorkspaceTurnSessionV1 {
  readonly version: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly chatId: string | null;
  readonly turnId: string;
  readonly attemptId: string;
  readonly executionId: string | null;
  readonly phase: PersistentWorkspaceTurnPhaseV1;
  readonly status: PersistentWorkspaceTurnStatusV1;
  readonly outcome: PersistentWorkspaceTerminalOutcomeV1 | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | null;
}
export type PersistentWorkspaceTurnSession = PersistentWorkspaceTurnSessionV1;
export type PersistentWorkspaceTurnSessionPageV1 = PaginatedResult<PersistentWorkspaceTurnSessionV1>;

declare const persistentWorkspaceHostAuthorityBrand: unique symbol;

/**
 * Opaque process-issued authority for host-only durable workspace admission.
 * The runtime service additionally validates object identity; serializing and
 * reconstructing this shape cannot mint authority.
 */
export interface PersistentWorkspaceHostAuthorityV1 {
  readonly [persistentWorkspaceHostAuthorityBrand]: true;
}
export type PersistentWorkspaceHostAuthority = PersistentWorkspaceHostAuthorityV1;

export type PersistentWorkspaceTaskCreatorV1 = "host" | "owner";

export interface PersistentWorkspaceTaskV1 {
  readonly version: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly turnSessionId: string | null;
  readonly userId: string;
  readonly chatId: string | null;
  readonly title: string;
  readonly objective: string;
  readonly state: WorkspaceTaskStateV1;
  readonly required: boolean;
  readonly dependencyIds: readonly string[];
  readonly creator: PersistentWorkspaceTaskCreatorV1;
  readonly hostAdmitted: boolean;
  readonly progress: PersistentWorkspaceProgressV1;
  readonly summary: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type PersistentWorkspaceTask = PersistentWorkspaceTaskV1;


export interface PersistentWorkspaceRecordContentV1 {
  readonly summary: string;
  readonly evidenceIds: readonly string[];
  readonly provenance: string | null;
}

export interface PersistentWorkspaceRecordV1 {
  readonly version: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly turnSessionId: string | null;
  readonly userId: string;
  readonly chatId: string | null;
  readonly kind: PersistentWorkspaceRecordKindV1;
  readonly content: PersistentWorkspaceRecordContentV1;
  readonly taskId: string | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type PersistentWorkspaceRecord = PersistentWorkspaceRecordV1;

export interface PersistentWorkspaceSubmissionV1 {
  readonly version: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly turnSessionId: string | null;
  readonly taskId: string;
  readonly userId: string;
  readonly chatId: string | null;
  readonly state: WorkspaceSubmissionStateV1;
  readonly summary: string;
  readonly resultDigest: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type PersistentWorkspaceSubmission = PersistentWorkspaceSubmissionV1;

export interface PersistentWorkspaceArtifactV1 {
  readonly version: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly turnSessionId: string | null;
  readonly userId: string;
  readonly chatId: string | null;
  readonly blobDigest: string;
  readonly mimeType: string;
  readonly byteCount: number;
  readonly provenance: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type PersistentWorkspaceArtifact = PersistentWorkspaceArtifactV1;

export type PersistentWorkspacePublicationSourceKindV1 =
  | "task"
  | "finding"
  | "objective"
  | "artifact";

export interface PersistentWorkspacePublicationProvenanceV1 {
  readonly workspaceId: string;
  readonly turnSessionId: string | null;
  readonly attemptId: string | null;
  /** Exact execution identity from the selected source Turn Session, when present. */
  readonly executionId: string | null;
  /** Digest of the exact operational source revision captured by publication. */
  readonly sourceDigest: string;
  /** Source chat/message/swipe identities are provenance only and may be tombstoned. */
  readonly sourceChatId: string | null;
  readonly sourceMessageId: string | null;
  readonly sourceSwipeId: number | null;
  readonly sourceDeletedAt: number | null;
  readonly creator: string;
  readonly capturedAt: number;
}

export interface PersistentWorkspaceTaskPublicationCopyV1 {
  readonly category: "task";
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly state: WorkspaceTaskStateV1;
  readonly required: boolean;
  readonly dependencyIds: readonly string[];
  readonly progress: PersistentWorkspaceProgressV1;
  readonly summary: string;
}

export interface PersistentWorkspaceFindingPublicationCopyV1 {
  readonly category: "finding";
  readonly id: string;
  readonly content: PersistentWorkspaceRecordContentV1;
  readonly taskId: string | null;
}

export interface PersistentWorkspaceObjectivePublicationCopyV1 {
  readonly category: "objective";
  readonly id: string;
  readonly objective: string;
  readonly metadata: PersistentWorkspaceMetadataV1;
}

export interface PersistentWorkspaceArtifactPublicationCopyV1 {
  readonly category: "artifact";
  readonly id: string;
  readonly blobDigest: string;
  readonly mimeType: string;
  readonly byteCount: number;
  readonly provenance: string;
}

export type PersistentWorkspacePublicationCopyV1 =
  | PersistentWorkspaceTaskPublicationCopyV1
  | PersistentWorkspaceFindingPublicationCopyV1
  | PersistentWorkspaceObjectivePublicationCopyV1
  | PersistentWorkspaceArtifactPublicationCopyV1;

export interface PersistentWorkspacePublicationV1 {
  readonly version: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  /** Historical source-chat provenance; null after source chat deletion. */
  readonly chatId: string | null;
  readonly category: WorkspacePublicationCategoryV1;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly sourceDigest: string;
  readonly sourceProvenance: PersistentWorkspacePublicationProvenanceV1;
  readonly sourceCreatedAt: number;
  readonly sourceUpdatedAt: number;
  readonly sourceDeletedAt: number | null;
  readonly sourceStatus: "present" | "deleted";
  readonly copy: PersistentWorkspacePublicationCopyV1;
  readonly copyDigest: string;
  readonly publishedAt: number;
  readonly publishedBy: string;
  readonly revision: 1;
}
export type PersistentWorkspacePublication = PersistentWorkspacePublicationV1;
export interface PersistentWorkspaceContextV1 {
  readonly userId: string;
  /**
   * A live chat ID authorizes operational association. Null is accepted only
   * for owner reads addressed by stable workspace ID.
   */
  readonly chatId: string | null;
  readonly workspaceId: string;
  readonly expectedRevision: number;
}

/** Authenticated owner scope supplied separately from model task content. */
export type PersistentWorkspaceOwnerScopeV1 = PersistentWorkspaceContextV1;
export type PersistentWorkspaceOwnerScope = PersistentWorkspaceOwnerScopeV1;

/**
 * Publication attribution is an authenticated actor, never a caller-supplied
 * string. Host actors carry an opaque process-issued authority.
 */
export type PersistentWorkspacePublicationActorV1 =
  | { readonly kind: "owner"; readonly userId: string }
  | { readonly kind: "host"; readonly authority: PersistentWorkspaceHostAuthorityV1 };
export type PersistentWorkspacePublicationActor = PersistentWorkspacePublicationActorV1;


export interface CreatePersistentWorkspaceInputV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly workspaceId?: string;
  readonly objective?: string;
  readonly metadata?: Partial<PersistentWorkspaceMetadataV1>;
  readonly progress?: Partial<PersistentWorkspaceProgressV1>;
  readonly quota?: Partial<PersistentWorkspaceQuotaV1>;
}

export interface CreatePersistentWorkspaceTurnSessionInputV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly workspaceId: string;
  readonly turnSessionId?: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly executionId?: string | null;
  readonly expectedRevision?: number;
}

export interface PersistentWorkspaceRecordEditV1 {
  readonly kind: PersistentWorkspaceRecordKindV1;
  readonly summary: string;
  readonly evidenceIds?: readonly string[];
  readonly provenance?: string | null;
  readonly taskId?: string | null;
  readonly turnSessionId?: string | null;
}

export interface EditPersistentWorkspaceInputV1 extends PersistentWorkspaceContextV1 {
  readonly objective?: string;
  readonly metadata?: Partial<PersistentWorkspaceMetadataV1>;
  readonly progress?: Partial<PersistentWorkspaceProgressV1>;
  readonly record?: PersistentWorkspaceRecordEditV1;
}
export interface PublishPersistentWorkspaceSelectionInputV1 extends PersistentWorkspaceContextV1 {
  readonly category: WorkspacePublicationCategoryV1;
  readonly sourceId: string;
  readonly sourceRevision?: number;
  /** Optional caller-supplied digest fence for the exact operational source. */
  readonly sourceDigest?: string;
}

export interface DeletePersistentWorkspacePublicationInputV1 extends PersistentWorkspaceContextV1 {
  readonly publicationId: string;
}

export interface DeletePersistentWorkspaceInputV1 extends PersistentWorkspaceContextV1 {}

export interface PersistentWorkspaceDeletionResultV1 {
  readonly workspaceId: string;
  readonly deleted: true;
  readonly publicationCount: number;
}
 
export interface CreatePersistentWorkspaceTaskInputV1 {
  readonly id?: string;
  readonly turnSessionId?: string | null;
  readonly title: string;
  readonly objective?: string;
  readonly state?: WorkspaceTaskStateV1;
  /**
   * Requiredness is meaningful only for host-authorized admission. Owner
   * ad-hoc creation must omit this or set it to false.
   */
  readonly required?: boolean;
  readonly dependencyIds?: readonly string[];
}
export type PersistentWorkspaceTaskInputV1 = CreatePersistentWorkspaceTaskInputV1;
export interface CreatePersistentWorkspaceHostTaskInputV1
  extends PersistentWorkspaceContextV1, CreatePersistentWorkspaceTaskInputV1 {}

export interface UpdatePersistentWorkspaceTurnSessionInputV1 extends PersistentWorkspaceContextV1 {
  readonly turnSessionId: string;
  readonly phase?: PersistentWorkspaceTurnPhaseV1;
  readonly status?: PersistentWorkspaceTurnStatusV1;
  readonly outcome?: PersistentWorkspaceTerminalOutcomeV1 | null;
}
