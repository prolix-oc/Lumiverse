import type {
  CognitionActivationResultV1,
  CognitionActivationRootsV1,
  CognitionActivationStateV1,
  CognitionEvaluationContextV1,
  CognitionFrozenSourceRevisionsV1,
  CognitionLoomBlockRefV1,
  CognitionPhase,
  CognitionTaskTransition,
  FrozenCognitionGraphV1,
  LoomPolicyBucketsV1,
  LoomPromptInspectionBlockV1,
  LoomPromptInspectionV1,
  LoomResponsePolicyOmissionV1,
  TaskTemplateV1,
} from "./agent-cognition";
import type { AgenticWorkWorkspaceMutationReservationV1 } from "./agent-work-segment";

/** Runtime phases which may activate authored cognition. */
export const COGNITION_RUNTIME_PHASES = [
  "ASSEMBLE",
  "WORK",
  "RENDER",
  "PREPARE_COMMIT",
  "COMMITTING",
  "COMMITTED",
] as const;
export type CognitionRuntimePhaseV1 = (typeof COGNITION_RUNTIME_PHASES)[number];

/** The authored cognition ID and its turn-scoped workspace identity are distinct. */
export interface CognitionTaskIdentityV1 {
  readonly authoredTaskId: string;
  readonly operationalTaskId: string;
}

/** Immutable source input for one turn. */
export interface AgentCognitionRuntimeSourceV1 {
  /** Frozen graph may be supplied directly by a strict loader or derived from config below. */
  readonly graph?: unknown;
  readonly source: unknown;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly taskTemplates?: readonly unknown[];
  /** Exact AgentConfigV2 task-policy roots selected for this turn. */
  readonly taskTemplateIds?: readonly unknown[];
  /** Canonical, host-authenticated Loom policy and its sealed inspection inputs. */
  readonly loomPolicy?: LoomPolicyBucketsV1;
  readonly loomBlocks?: readonly LoomPromptInspectionBlockV1[];
  /** Host-authenticated, opaque Cortex sidecar input sealed for this turn. */
  readonly cortexSidecarSnapshot?: unknown;
}

/** Base predicate input frozen before the first provider/isolate dispatch. */
export type AgentCognitionRuntimeEvaluationV1 = CognitionEvaluationContextV1;
export interface CreateAgentCognitionRuntimeInputV1 {
  readonly source: AgentCognitionRuntimeSourceV1;
  readonly evaluation: AgentCognitionRuntimeEvaluationV1;
  readonly workspaceRevision: number;
  /** Authenticated host/root workspace context; initial ASSEMBLE activation commits through its CAS. */
  readonly workspace: Record<string, unknown>;
}

export interface CognitionPromptBlockSelectionV1 {
  readonly phase: CognitionPhase;
  readonly refs: readonly CognitionLoomBlockRefV1[];
}

export interface CognitionRuntimePolicySurfaceV1 {
  readonly policies: LoomPolicyBucketsV1;
  readonly promptInspection?: LoomPromptInspectionV1;
  readonly responseOmission?: LoomResponsePolicyOmissionV1;
}

export interface CognitionRuntimeActivationV1 {
  readonly phase: CognitionPhase;
  readonly state: CognitionActivationStateV1;
  readonly activation: CognitionActivationResultV1;
  readonly promptBlocks: CognitionPromptBlockSelectionV1;
  readonly policySurface?: CognitionRuntimePolicySurfaceV1;
  readonly sourceRevisions: CognitionFrozenSourceRevisionsV1;
  readonly sourceDigest: string;
  readonly workspaceRevision: number;
}

export interface CognitionCompletionBlockerV1 {
  readonly kind: "task";
  readonly id: string;
}
export interface CognitionRuntimePreparedAcceptanceV1 {
  /** Complete candidate acknowledged inside the workspace acceptance transaction. */
  readonly candidate: CognitionRuntimeCompletionV1;
  /** Immutable, private host handoff bundle; never persisted or model-visible. */
  readonly bundle: unknown;
}
export interface CognitionRuntimeCompletionV1 extends CognitionRuntimeActivationV1 {
  readonly accepted: boolean;
  readonly blockers: readonly CognitionCompletionBlockerV1[];
  readonly blockingRequiredTaskIds: readonly string[];
  /** Stable authored template IDs; workspace DB identities remain turn-scoped host data. */
  readonly materializedTaskIds: readonly string[];
  /** Private host evidence for every successful-path pre-commit phase. */
  readonly preCommitActivations: readonly CognitionRuntimeActivationV1[];
  /** Exact private handoff acknowledged by the workspace CAS. */
  readonly preparedAcceptance?: CognitionRuntimePreparedAcceptanceV1;
}

/** Pure activation result passed into the workspace transaction. */
export interface CognitionWorkspaceActivationUpdateV1 {
  readonly taskId: string;
  readonly transition: CognitionTaskTransition;
  readonly reservation: AgenticWorkWorkspaceMutationReservationV1;
  readonly state: CognitionActivationStateV1;
  readonly activation: CognitionActivationResultV1;
  readonly materializeTemplates: readonly TaskTemplateV1[];
}
export interface CognitionWorkspaceCompletionUpdateV1 {
  readonly state: CognitionActivationStateV1;
  readonly activation: CognitionActivationResultV1;
  readonly accepted: boolean;
  readonly blockingRequiredTaskIds: readonly string[];
  readonly materializeTemplates: readonly TaskTemplateV1[];
}
export interface CognitionWorkspaceActivationFactoryV1 {
  readonly state: CognitionActivationStateV1;
  readonly update: (currentState: CognitionActivationStateV1) => CognitionWorkspaceActivationUpdateV1;
}
export interface CognitionWorkspacePhaseUpdateV1 {
  readonly state: CognitionActivationStateV1;
  readonly activation: CognitionActivationResultV1;
  readonly materializeTemplates: readonly TaskTemplateV1[];
}
export interface CognitionWorkspacePhaseFactoryV1 {
  readonly state: CognitionActivationStateV1;
  readonly update: (currentState: CognitionActivationStateV1) => CognitionWorkspacePhaseUpdateV1;
}
export interface CognitionWorkspaceCompletionFactoryV1 {
  readonly state: CognitionActivationStateV1;
  readonly update: (currentState: CognitionActivationStateV1) => CognitionWorkspaceCompletionUpdateV1;
}
export interface CognitionWorkspaceCompletionResultV1 {
  readonly workspaceRevision: number;
  readonly state: CognitionActivationStateV1;
  readonly activation: CognitionActivationResultV1;
  readonly accepted: boolean;
  readonly blockingRequiredTaskIds: readonly string[];
  readonly materializedTaskIds: readonly string[];
  /** Exact private bundle acknowledged before the workspace CAS updateRow. */
  readonly preparedAcceptance?: {
    readonly candidate: CognitionWorkspaceCompletionResultV1;
    readonly bundle: unknown;
  };
}

/** Public bridge consumed by the coordinator and WORK phase. */
export interface AgentCognitionRuntimeV1 {
  readonly graph: FrozenCognitionGraphV1;
  readonly source: AgentCognitionRuntimeSourceV1;
  /** Exact authored roots whose predicates may be evaluated. */
  readonly activationRoots: CognitionActivationRootsV1;
  readonly policySurface?: CognitionRuntimePolicySurfaceV1;
  readonly initialActivation: CognitionRuntimeActivationV1;
  /** Adopt one committed workspace CAS that cannot change cognition predicates. */
  readonly adoptWorkspaceMutationRevision: (workspaceRevision: number) => void;
  readonly enterPhase: (input: CognitionRuntimePhaseInputV1) => CognitionRuntimeActivationV1;
  readonly applyWorkspaceTransition: (input: CognitionRuntimeTaskTransitionInputV1) => Promise<CognitionWorkspaceMutationResultV1> | CognitionWorkspaceMutationResultV1;
  readonly acceptCompletionFixedPoint: (input: CognitionRuntimeCompletionInputV1) => Promise<CognitionRuntimeCompletionV1> | CognitionRuntimeCompletionV1;
}

/** Relational workspace CAS result. It contains no cognition runtime authority. */
export interface CognitionWorkspaceCommitResultV1 {
  readonly workspaceRevision: number;
  readonly state: CognitionActivationStateV1;
  readonly activation: CognitionActivationResultV1;
  /** Turn-scoped operational task IDs returned by the workspace database. */
  readonly materializedTaskIds: readonly string[];
  readonly taskId: string;
  readonly transition: CognitionTaskTransition;
  readonly operationKey: string;
  readonly segmentId: string;
  readonly logicalDispatch: number;
  readonly frameId: string;
  /** Host-computed digest of the exact atomically committed workspace mutation. */
  readonly operationDigest: string;
}

/** Runtime result wraps the committed DB result with the private cognition view. */
export interface CognitionWorkspaceMutationResultV1 extends Omit<CognitionWorkspaceCommitResultV1, "materializedTaskIds"> {
  /** Stable authored template IDs; operational DB IDs never replace this field. */
  readonly materializedTaskIds: readonly string[];
  /** Private host envelope; never serialize into model-visible workspace output. */
  readonly cognition: CognitionRuntimeActivationV1;
}

export interface CognitionRuntimeTaskTransitionInputV1 {
  readonly taskId: string;
  readonly transition: CognitionTaskTransition;
  readonly reservation: AgenticWorkWorkspaceMutationReservationV1;
  /** Transport-only cancellation fence; never enters fingerprints or persisted state. */
  readonly signal?: AbortSignal;
  readonly workspace: Record<string, unknown>;
  /** Authenticated workspace mutation operation. */
  readonly operation:
    | "create_task"
    | "update_assigned_progress"
    | "submit_child_result"
    | "submit_root_result"
    | "settle_child_failure"
    | "accept_submission";
}

export interface CognitionWorkspacePhaseResultV1 {
  readonly workspaceRevision: number;
  readonly state: CognitionActivationStateV1;
  readonly activation: CognitionActivationResultV1;
  readonly materializedTaskIds: readonly string[];
}

export interface CognitionRuntimePhaseInputV1 {
  readonly phase: CognitionRuntimePhaseV1;
  /** Authenticated host/root workspace context; every phase entry is one workspace CAS. */
  readonly workspace: Record<string, unknown>;
}

export interface CognitionRuntimeCompletionInputV1 {
  readonly operationKey?: string;
  /** Transport-only cancellation fence; never enters fingerprints or persisted state. */
  readonly signal?: AbortSignal;
  readonly workspace: Record<string, unknown>;
  /** Build and acknowledge fallible handoff data inside the workspace transaction. */
  readonly prepareAcceptance?: (
    result: CognitionRuntimeCompletionV1,
  ) => CognitionRuntimePreparedAcceptanceV1;
  /** Validate the prepared bundle before the acceptance row is updated. */
  readonly validatePreparedAcceptance?: (
    prepared: CognitionRuntimePreparedAcceptanceV1,
    result: CognitionRuntimeCompletionV1,
  ) => boolean;
}

export type CognitionRuntimeErrorCode =
  | "invalid_source"
  | "workspace_cas_conflict"
  | "idempotency_conflict"
  | "completion_blocked";

export class AgentCognitionRuntimeError extends Error {
  readonly code: CognitionRuntimeErrorCode;
  readonly path?: string;

  constructor(code: CognitionRuntimeErrorCode, message: string = code, path?: string) {
    super(message);
    this.name = "AgentCognitionRuntimeError";
    this.code = code;
    this.path = path;
  }
}

/** Narrow source projection for authenticated preset config accessors. */
export type AuthenticatedAgentCognitionSourceV1 = AgentCognitionRuntimeSourceV1;

/** Phase-to-policy mapping is closed and deterministic. */
export function cognitionPolicyPhase(phase: CognitionRuntimePhaseV1): CognitionPhase {
  return phase;
}
