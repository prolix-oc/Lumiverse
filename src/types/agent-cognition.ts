/**
 * Closed, deterministic authored cognition contracts.
 *
 * Cognition is deliberately a data-only language. The parser in
 * `agent-cognition.service.ts` is the only authority for values entering a
 * runtime turn: it does not evaluate JavaScript, regular expressions, macros,
 * callbacks, clocks, randomness, or database lookups.
 */

import { createHash } from "node:crypto";

export const COGNITION_OPERATIONAL_TASK_ID_MAX_BYTES = 128;
const COGNITION_OPERATIONAL_TASK_ID_ENCODER = new TextEncoder();
const COGNITION_OPERATIONAL_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COGNITION_HASHED_TASK_ID_PATTERN = /^cognition:[0-9a-f]{64}$/;

/**
 * Derive the bounded operational identity used by both the cognition runtime
 * and workspace persistence. Short safe identities stay readable; every
 * other admitted source pair receives a full-digest identity.
 */
export function deriveCognitionOperationalTaskId(turnId: string, authoredTaskId: string): string {
  const scoped = `${turnId}:${authoredTaskId}`;
  const scopedBytes = COGNITION_OPERATIONAL_TASK_ID_ENCODER.encode(scoped).byteLength;
  if (
    scopedBytes <= COGNITION_OPERATIONAL_TASK_ID_MAX_BYTES
    && COGNITION_OPERATIONAL_TASK_ID_PATTERN.test(scoped)
    && !turnId.includes(":")
    && !authoredTaskId.includes(":")
    && !COGNITION_HASHED_TASK_ID_PATTERN.test(scoped)
  ) {
    return scoped;
  }
  return `cognition:${createHash("sha256")
    .update("cognition-operational-task\0", "utf8")
    .update(turnId, "utf8")
    .update("\0", "utf8")
    .update(authoredTaskId, "utf8")
    .digest("hex")}`;
}

export const AGENT_COGNITION_VERSION = 1 as const;

/** Hard host ceilings. Authored data may never raise these values. */
export const COGNITION_MAX_PREDICATE_DEPTH = 16;
export const COGNITION_MAX_PREDICATE_NODES = 256;
export const COGNITION_MAX_STRING_BYTES = 4 * 1024;
export const COGNITION_MAX_LIST_BYTES = 64 * 1024;
export const COGNITION_MAX_LIST_ITEMS = 256;
export const COGNITION_MAX_TASK_TEMPLATES = 256;
export const COGNITION_MAX_TASK_TRANSITIONS = 256;
export const COGNITION_MAX_BLOCK_REFS_PER_SECTION = 64;
export const COGNITION_MAX_BLOCK_REFS_TOTAL = 128;
export const COGNITION_MAX_ID_BYTES = 256;
export const COGNITION_MAX_SOURCE_BLOCKS = 512;

/** Descriptive aliases retained for callers that prefix host-owned caps. */
export const AGENT_COGNITION_MAX_PREDICATE_DEPTH = COGNITION_MAX_PREDICATE_DEPTH;
export const AGENT_COGNITION_MAX_PREDICATE_NODES = COGNITION_MAX_PREDICATE_NODES;
export const AGENT_COGNITION_MAX_STRING_BYTES = COGNITION_MAX_STRING_BYTES;
export const AGENT_COGNITION_MAX_LIST_BYTES = COGNITION_MAX_LIST_BYTES;

/** Stable generation target names understood by the Agentic runtime. */
export type CognitionGenerationType =
  | "normal"
  | "continue"
  | "regenerate"
  | "swipe";

/** All runtime phases are listed so a predicate cannot smuggle an open string. */
export type CognitionPhase =
  | "ASSEMBLE"
  | "WORK"
  | "COMPLETE"
  | "RENDER"
  | "PREPARE_COMMIT"
  | "COMMITTING"
  | "COMMITTED"
  | "COMMIT_FAILED"
  | "EXHAUSTED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

/** Canonical workspace task states named by cognition predicates. */
export type CognitionTaskTransition =
  | "pending"
  | "active"
  | "blocked"
  | "completed"
  | "cancelled"
  | "failed";

export type CognitionScalar = string | number | boolean;
export type CognitionValue = CognitionScalar | readonly string[];

/** A reference to an existing Loom block; block content is never copied here. */
export interface CognitionLoomBlockRefV1 {
  readonly blockId: string;
  readonly expectedPresetRevision: number;
  readonly expectedBlockRevision: number;
  readonly promptOrder: number;
}

/**
 * The four authored phase sections. Arrays retain selected references;
 * `freezeCognitionGraph` orders them by the source preset's prompt_order.
 */
export interface CognitionPolicyRefsV1 {
  readonly workPolicy: readonly CognitionLoomBlockRefV1[];
  readonly workspaceUsage: readonly CognitionLoomBlockRefV1[];
  readonly completionCriteria: readonly CognitionLoomBlockRefV1[];
  readonly renderPolicy: readonly CognitionLoomBlockRefV1[];
}
export const LOOM_POLICY_VERSION = 1 as const;
export const LOOM_POLICY_BUCKETS = [
  "workPolicy",
  "workspaceUsage",
  "completionCriteria",
  "renderPolicy",
] as const;
export type LoomPolicyBucketV1 = (typeof LOOM_POLICY_BUCKETS)[number];

export const LOOM_POLICY_DESTINATIONS = [
  "root_work",
  "completion_handoff",
  "render",
] as const;
export type LoomPolicyDestinationV1 = (typeof LOOM_POLICY_DESTINATIONS)[number];

export const LOOM_POLICY_CHECKPOINTS = [
  "ASSEMBLE",
  "WORK",
  "PREPARE_COMMIT",
  "RENDER",
] as const;
export type LoomPolicyCheckpointV1 = (typeof LOOM_POLICY_CHECKPOINTS)[number];

export const LOOM_POLICY_VISIBILITY = "work_only" as const;
export type LoomPolicyVisibilityV1 = typeof LOOM_POLICY_VISIBILITY;

export interface LoomPolicySourceV1 {
  readonly kind: "loom_block";
  readonly blockId: string;
  readonly presetRevision: number;
  readonly blockRevision: number;
  readonly promptOrder: number;
}

/** A typed gate evaluated only at the entry's named Loom checkpoint. */
export interface LoomPolicyEntryV1 {
  readonly version: typeof LOOM_POLICY_VERSION;
  readonly id: string;
  readonly source: LoomPolicySourceV1;
  readonly destination: LoomPolicyDestinationV1;
  readonly checkpoint: LoomPolicyCheckpointV1;
  readonly required: boolean;
  readonly visibility: LoomPolicyVisibilityV1;
  readonly condition?: CognitionPredicateV1;
}

export interface LoomPolicyBucketsV1 {
  readonly version: typeof LOOM_POLICY_VERSION;
  readonly workPolicy: readonly LoomPolicyEntryV1[];
  readonly workspaceUsage: readonly LoomPolicyEntryV1[];
  readonly completionCriteria: readonly LoomPolicyEntryV1[];
  readonly renderPolicy: readonly LoomPolicyEntryV1[];
}

export type LoomPolicyConditionResultV1 =
  | "true"
  | "false"
  | "not_evaluated"
  | "invalid"
  | "not_applicable";

export type LoomPromptInspectionOutcomeV1 =
  | { readonly status: "included"; readonly effectiveIndex: number; readonly reason: "selected" }
  | {
      readonly status: "skipped";
      readonly reason: "checkpoint_not_reached" | "condition_not_met" | "stale_source";
    }
  | {
      readonly status: "rejected";
      readonly reason: "invalid_source" | "stale_source" | "required_source_unavailable";
    }
  | {
      readonly status: "omitted";
      readonly reason: "response_mode" | "destination_unavailable" | "not_work_surface";
    }
  | {
      readonly status: "deduplicated";
      readonly reason: "destination_overlap";
      readonly keptEntryId: string;
      readonly destination: LoomPolicyDestinationV1;
    };

export interface LoomPromptInspectionItemV1 {
  readonly entryId: string;
  readonly bucket: LoomPolicyBucketV1;
  readonly destination: LoomPolicyDestinationV1;
  readonly checkpoint: LoomPolicyCheckpointV1;
  readonly source: LoomPolicySourceV1;
  readonly condition?: CognitionPredicateV1;
  readonly conditionResult?: LoomPolicyConditionResultV1;
  readonly effectiveText: string | null;
  readonly required: boolean;
  /** The source block was removed from ordinary prompt assembly and routed only through Loom. */
  readonly ordinaryPromptSuppressed: boolean;
  readonly outcome: LoomPromptInspectionOutcomeV1;
}

export interface LoomPromptInspectionV1 {
  readonly version: typeof LOOM_POLICY_VERSION;
  readonly surface: "WORK" | "RESPONSE";
  readonly checkpoint: LoomPolicyCheckpointV1;
  readonly items: readonly LoomPromptInspectionItemV1[];
  readonly effectiveEntryIds: readonly string[];
  readonly responseOmission?: LoomResponsePolicyOmissionV1;
}

export interface LoomResponsePolicyPhaseInstructionV1 {
  readonly phaseId: string;
  readonly source: LoomPolicySourceV1;
  /** Present only when this source belongs to a child-profile subset. */
  readonly profileId?: string;
}

export interface LoomResponsePolicyOmissionV1 {
  readonly version: typeof LOOM_POLICY_VERSION;
  readonly surface: "RESPONSE";
  readonly visibility: LoomPolicyVisibilityV1;
  readonly reason: "work_only";
  /** Why the authored source was recovered or withheld from runtime execution. */
  readonly reviewReason?: string;
  /** Bucket entry IDs only; phase instruction refs live in omittedPhaseInstructions. */
  readonly omittedEntryIds: readonly string[];
  /** Bucket entry sources only; phase instruction refs live in omittedPhaseInstructions. */
  readonly source: readonly LoomPolicySourceV1[];
  /** Every authored custom-phase association, preserving duplicate source use by phase. */
  readonly omittedPhaseInstructions: readonly LoomResponsePolicyPhaseInstructionV1[];
}
export interface LoomPromptInspectionBlockV1 {
  readonly source: LoomPolicySourceV1;
  readonly content: string;
}
export interface LoomPromptInspectionInputV1 {
  readonly checkpoint: LoomPolicyCheckpointV1;
  readonly surface: "WORK" | "RESPONSE";
  readonly evaluation?: CognitionEvaluationContextV1;
  readonly blocks: readonly LoomPromptInspectionBlockV1[];
  /** Exact host-recorded evidence from an earlier checkpoint in this turn. */
  readonly previousInspection?: LoomPromptInspectionV1;
}

/** Alias used by AgentConfig V2 projections. */
export type AgentCognitionPolicyV1 = CognitionPolicyRefsV1;

export type CognitionPredicateOperator = "equals" | "in" | "includes" | "present";

export type CognitionPredicateV1 =
  | { readonly kind: "all"; readonly children: readonly CognitionPredicateV1[] }
  | { readonly kind: "any"; readonly children: readonly CognitionPredicateV1[] }
  | { readonly kind: "not"; readonly child: CognitionPredicateV1 }
  | { readonly kind: "generation_type"; readonly value: CognitionGenerationType }
  | { readonly kind: "phase"; readonly value: CognitionPhase }
  | {
      readonly kind: "preset_variable";
      readonly name: string;
      readonly operator: "equals";
      readonly value: CognitionValue;
    }
  | {
      readonly kind: "preset_variable";
      readonly name: string;
      readonly operator: "in";
      readonly values: readonly CognitionScalar[];
    }
  | {
      readonly kind: "preset_variable";
      readonly name: string;
      readonly operator: "includes";
      readonly value: CognitionScalar;
    }
  | {
      readonly kind: "preset_variable";
      readonly name: string;
      readonly operator: "present";
    }
  | {
      readonly kind: "participant_fact";
      readonly name: string;
      readonly operator: "equals";
      readonly value: CognitionValue;
    }
  | {
      readonly kind: "participant_fact";
      readonly name: string;
      readonly operator: "in";
      readonly values: readonly CognitionScalar[];
    }
  | {
      readonly kind: "participant_fact";
      readonly name: string;
      readonly operator: "includes";
      readonly value: CognitionScalar;
    }
  | {
      readonly kind: "participant_fact";
      readonly name: string;
      readonly operator: "present";
    }
  | { readonly kind: "tool_available"; readonly toolId: string; readonly available: boolean }
  | { readonly kind: "task_transition"; readonly taskId: string; readonly transition: CognitionTaskTransition };

/** A preset/host-authored workspace task template. */
export interface TaskTemplateV1 {
  readonly id: string;
  readonly required: boolean;
  readonly dependencies?: readonly string[];
  readonly activation?: CognitionPredicateV1;
  readonly label?: string;
  readonly description?: string;
}

/** Closed authored cognition graph before source revisions are resolved. */
export interface CognitionGraphV1 {
  readonly version: typeof AGENT_COGNITION_VERSION;
  readonly policies: CognitionPolicyRefsV1;
  readonly templates: readonly TaskTemplateV1[];
}

/** Read-only source used to resolve expected Loom revisions without a DB call. */
export interface CognitionSourceBlockV1 {
  readonly blockId: string;
  readonly revision: number;
  readonly promptOrder: number;
}

export interface CognitionSourceSnapshotV1 {
  readonly presetRevision: number;
  readonly blocks: readonly CognitionSourceBlockV1[];
}

export interface CognitionFrozenSourceRevisionsV1 {
  readonly presetRevision: number;
  readonly blockRevisions: readonly {
    readonly blockId: string;
    readonly revision: number;
    readonly promptOrder: number;
  }[];
}

/** Graph with immutable, source-checked policy references and dependency maps. */
export interface FrozenCognitionGraphV1 extends CognitionGraphV1 {
  readonly sourceRevisions: CognitionFrozenSourceRevisionsV1;
  readonly templateDependencyClosure: Readonly<Record<string, readonly string[]>>;
  readonly requiredTemplateClosure: readonly string[];
}

/** Exact authored task roots whose predicates may be evaluated for one turn. */
export interface CognitionActivationRootsV1 {
  readonly templateIds: readonly string[];
}

/** Immutable values available to the pure predicate evaluator. */
export interface CognitionEvaluationContextV1 {
  readonly generationType: CognitionGenerationType;
  readonly phase: CognitionPhase;
  readonly presetVariables: Readonly<Record<string, CognitionValue>>;
  readonly participantFacts: Readonly<Record<string, CognitionValue>>;
  readonly availableTools: readonly string[];
  readonly taskTransitions: Readonly<Record<string, CognitionTaskTransition>>;
}

export type CognitionActivationPointV1 =
  | "initial"
  | "phase_entry"
  | "task_transition"
  | "completion_fixed_point";

/** Append-only activation state carried by a workspace CAS row. */
export interface CognitionActivationStateV1 {
  readonly version: typeof AGENT_COGNITION_VERSION;
  readonly workspaceRevision: number;
  readonly activatedTemplateIds: readonly string[];
  readonly requiredTemplateIds: readonly string[];
}

export interface CognitionActivationResultV1 {
  readonly point: CognitionActivationPointV1;
  readonly state: CognitionActivationStateV1;
  readonly newlyActivatedTemplateIds: readonly string[];
  readonly newlyRequiredTemplateIds: readonly string[];
}

export interface CognitionCompletionResultV1 extends CognitionActivationResultV1 {
  readonly fixedPointIterations: number;
  readonly blockingRequiredTaskIds: readonly string[];
  readonly canComplete: boolean;
}

export interface CognitionTaskTransitionResultV1 {
  readonly state: CognitionActivationStateV1;
  readonly transition: CognitionTaskTransition;
  readonly taskId: string;
  readonly activation: CognitionActivationResultV1;
}

/**
 * The only integration seam for a task transition. The callback is supplied
 * by the workspace service and must run inside its single revision CAS.
 */
export interface CognitionWorkspaceCasV1 {
  commit(
    expectedWorkspaceRevision: number,
    update: (current: CognitionActivationStateV1) => CognitionActivationStateV1,
  ): CognitionActivationStateV1;
}

export type CognitionValidationCode =
  | "invalid_type"
  | "invalid_value"
  | "unknown_key"
  | "limit_exceeded"
  | "missing_reference"
  | "cycle"
  | "revision_mismatch"
  | "duplicate_id"
  | "required_closure_invalid"
  | "invalid_state"
  | "fixed_point_limit_exceeded"
  | "cas_conflict";

export class AgentCognitionValidationError extends Error {
  readonly code: CognitionValidationCode;
  readonly path: string;

  constructor(code: CognitionValidationCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "AgentCognitionValidationError";
    this.code = code;
    this.path = path;
  }
}
