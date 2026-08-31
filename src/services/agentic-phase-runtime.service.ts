import type {
  AgentChildInstructionSubsetV1,
  AgentCustomPhaseV1,
  AgentRuntimePhaseCapabilityV1,
} from "../types/agents";
import {
  AGENT_RUNTIME_MAX_CUSTOM_PHASES,
  AGENT_RUNTIME_MAX_PHASE_INSTRUCTION_REFS,
  AGENT_RUNTIME_PHASE_CAPABILITIES,
} from "../types/agents";
import type {
  CognitionEvaluationContextV1,
  CognitionPredicateV1,
  CognitionSourceSnapshotV1,
  LoomPolicySourceV1,
} from "../types/agent-cognition";
import {
  evaluateCognitionPredicate,
  parseCognitionPredicate,
} from "./agent-cognition.service";

/** Host result for compiling preset-authored custom WORK phases. */
export type AgentRuntimePhaseCompileStatusV1 = "ready" | "repair_required" | "failed";

export type AgentRuntimePhaseCompileIssueCodeV1 =
  | "invalid_phase"
  | "invalid_predicate"
  | "invalid_source"
  | "stale_source"
  | "duplicate_phase_id"
  | "unknown_phase"
  | "invalid_transition"
  | "optional_phase_omitted"
  | "required_phase_unavailable";

export interface AgentRuntimePhaseCompileIssueV1 {
  readonly code: AgentRuntimePhaseCompileIssueCodeV1;
  readonly phaseId: string;
  readonly phaseIndex: number;
  readonly required: boolean;
  readonly detail: string;
  readonly source: "authoring" | "revision" | "transition";
}

export interface AgentRuntimePhaseSourceIdentityV1 {
  readonly blockId: string;
  readonly presetRevision: number;
  readonly blockRevision: number;
  readonly promptOrder: number;
}
export interface AgentRuntimePhaseChildInstructionSubsetIdentityV1 {
  readonly profileId: string;
  readonly sourceIdentity: readonly AgentRuntimePhaseSourceIdentityV1[];
}


/** A phase after host validation, retaining the exact authored source refs. */
export interface CompiledAgentRuntimePhaseV1 extends AgentCustomPhaseV1 {
  readonly index: number;
  readonly sourceStatus: "verified" | "unverified";
  readonly sourceIdentity: readonly AgentRuntimePhaseSourceIdentityV1[];
  readonly childInstructionSubsetIdentity: readonly AgentRuntimePhaseChildInstructionSubsetIdentityV1[];
}

export interface AgentRuntimePhaseCompileResultV1 {
  readonly status: AgentRuntimePhaseCompileStatusV1;
  readonly phases: readonly CompiledAgentRuntimePhaseV1[];
  readonly issues: readonly AgentRuntimePhaseCompileIssueV1[];
  readonly omittedPhaseIds: readonly string[];
}

export interface CompileAgentRuntimePhasesOptionsV1 {
  /** Frozen source snapshot captured at admission. Omit only for source-independent tests. */
  readonly source?: CognitionSourceSnapshotV1 | null;
  /** Authored profile IDs used to close child subset assignments at admission. */
  readonly profileIds?: readonly string[];
}

/**
 * Intersect authored phase requests with grants already admitted by the host.
 * This function never broadens the host grant and preserves authored order.
 */
export function intersectAgentRuntimePhaseCapabilities(
  requested: readonly AgentRuntimePhaseCapabilityV1[],
  admitted: readonly AgentRuntimePhaseCapabilityV1[],
): readonly AgentRuntimePhaseCapabilityV1[] {
  const admittedSet = new Set<string>();
  for (const capability of admitted) {
    if ((AGENT_RUNTIME_PHASE_CAPABILITIES as readonly string[]).includes(capability)) {
      admittedSet.add(capability);
    }
  }
  const result: AgentRuntimePhaseCapabilityV1[] = [];
  const seen = new Set<string>();
  for (const capability of requested) {
    if (
      (AGENT_RUNTIME_PHASE_CAPABILITIES as readonly string[]).includes(capability)
      && admittedSet.has(capability)
      && !seen.has(capability)
    ) {
      seen.add(capability);
      result.push(capability);
    }
  }
  return Object.freeze(result);
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCapability(value: unknown): value is AgentRuntimePhaseCapabilityV1 {
  return typeof value === "string"
    && (AGENT_RUNTIME_PHASE_CAPABILITIES as readonly string[]).includes(value);
}

function sourceIdentity(ref: LoomPolicySourceV1): AgentRuntimePhaseSourceIdentityV1 {
  return {
    blockId: ref.blockId,
    presetRevision: ref.presetRevision,
    blockRevision: ref.blockRevision,
    promptOrder: ref.promptOrder,
  };
}

function issue(
  code: AgentRuntimePhaseCompileIssueCodeV1,
  phase: Partial<AgentCustomPhaseV1>,
  phaseIndex: number,
  detail: string,
  source: AgentRuntimePhaseCompileIssueV1["source"],
): AgentRuntimePhaseCompileIssueV1 {
  return {
    code,
    phaseId: typeof phase.id === "string" ? phase.id : `phase-${phaseIndex}`,
    phaseIndex,
    required: phase.required === true,
    detail,
    source,
  };
}

function sourceKey(ref: LoomPolicySourceV1): string {
  return `${ref.kind}\u0000${ref.blockId}\u0000${ref.presetRevision}\u0000${ref.blockRevision}\u0000${ref.promptOrder}`;
}

function validateSourceRef(
  ref: unknown,
  path: string,
  source: CognitionSourceSnapshotV1 | null | undefined,
): { readonly code: "invalid_source" | "stale_source"; readonly detail: string; readonly source: "authoring" | "revision" } | null {
  if (
    !ref || typeof ref !== "object" || Array.isArray(ref)
    || (ref as Record<string, unknown>).kind !== "loom_block"
    || typeof (ref as Record<string, unknown>).blockId !== "string"
    || ((ref as Record<string, unknown>).blockId as string).length === 0
    || !isSafeRevision((ref as Record<string, unknown>).presetRevision)
    || !isSafeRevision((ref as Record<string, unknown>).blockRevision)
    || !isSafeRevision((ref as Record<string, unknown>).promptOrder)
  ) {
    return { code: "invalid_source", detail: `${path} contains an invalid source`, source: "authoring" };
  }
  const sourceRef = ref as LoomPolicySourceV1;
  if (source === undefined || source === null) return null;
  if (sourceRef.presetRevision !== source.presetRevision) {
    return {
      code: "stale_source",
      detail: `${path} preset revision ${sourceRef.presetRevision} is not ${source.presetRevision}`,
      source: "revision",
    };
  }
  const block = source.blocks.find((candidate) => candidate.promptOrder === sourceRef.promptOrder);
  if (!block || block.blockId !== sourceRef.blockId || block.revision !== sourceRef.blockRevision) {
    return {
      code: "stale_source",
      detail: "source block " + sourceRef.blockId + " revision or order is stale",
      source: "revision",
    };
  }
  return null;
}

function validateSourceRefs(
  phase: AgentCustomPhaseV1,
  phaseIndex: number,
  source: CognitionSourceSnapshotV1 | null | undefined,
  profileIds?: readonly string[],
): AgentRuntimePhaseCompileIssueV1 | null {
  const refs = phase.instructionRefs;
  if (!Array.isArray(refs)) {
    return issue("invalid_source", phase, phaseIndex, "instructionRefs must be an array", "authoring");
  }
  if (refs.length > AGENT_RUNTIME_MAX_PHASE_INSTRUCTION_REFS) {
    return issue("invalid_source", phase, phaseIndex, `instructionRefs must contain at most ${AGENT_RUNTIME_MAX_PHASE_INSTRUCTION_REFS} entries`, "authoring");
  }
  const seen = new Set<string>();
  for (const [index, ref] of refs.entries()) {
    const invalid = validateSourceRef(ref, `instructionRefs[${index}]`, source);
    const key = invalid === null ? sourceKey(ref as LoomPolicySourceV1) : "";
    if (invalid !== null || seen.has(key)) {
      return issue(
        invalid?.code ?? "invalid_source",
        phase,
        phaseIndex,
        invalid?.detail ?? "instructionRefs contains an invalid or duplicate source",
        invalid?.source ?? "authoring",
      );
    }
    seen.add(key);
  }
  const subsets = phase.childInstructionSubsets === undefined ? [] : phase.childInstructionSubsets;
  if (!Array.isArray(subsets)) {
    return issue("invalid_source", phase, phaseIndex, "childInstructionSubsets must be an array", "authoring");
  }
  const rootSources = new Set(refs.map((ref) => sourceKey(ref)));
  const assignedProfiles = new Set<string>();
  const knownProfiles = profileIds === undefined ? null : new Set(profileIds);
  let aggregateRefs = 0;
  for (const [subsetIndex, subset] of subsets.entries()) {
    if (
      !subset || typeof subset !== "object" || Array.isArray(subset)
      || typeof (subset as AgentChildInstructionSubsetV1).profileId !== "string"
      || (subset as AgentChildInstructionSubsetV1).profileId.length === 0
    ) {
      return issue("invalid_source", phase, phaseIndex, `childInstructionSubsets[${subsetIndex}] has an invalid profile`, "authoring");
    }
    const profileId = (subset as AgentChildInstructionSubsetV1).profileId;
    if (assignedProfiles.has(profileId)) {
      return issue("invalid_source", phase, phaseIndex, `childInstructionSubsets profile ${profileId} is duplicated`, "authoring");
    }
    if (knownProfiles !== null && !knownProfiles.has(profileId)) {
      return issue("invalid_source", phase, phaseIndex, `childInstructionSubsets profile ${profileId} is unknown`, "authoring");
    }
    assignedProfiles.add(profileId);
    const subsetRefs = (subset as AgentChildInstructionSubsetV1).instructionRefs;
    if (!Array.isArray(subsetRefs) || subsetRefs.length > AGENT_RUNTIME_MAX_PHASE_INSTRUCTION_REFS) {
      return issue("invalid_source", phase, phaseIndex, `childInstructionSubsets[${subsetIndex}].instructionRefs exceeds the phase source limit`, "authoring");
    }
    aggregateRefs += subsetRefs.length;
    if (aggregateRefs > AGENT_RUNTIME_MAX_PHASE_INSTRUCTION_REFS) {
      return issue("invalid_source", phase, phaseIndex, `childInstructionSubsets exceed ${AGENT_RUNTIME_MAX_PHASE_INSTRUCTION_REFS} aggregate source references`, "authoring");
    }
    const subsetSeen = new Set<string>();
    for (const [refIndex, ref] of subsetRefs.entries()) {
      const invalid = validateSourceRef(ref, `childInstructionSubsets[${subsetIndex}].instructionRefs[${refIndex}]`, source);
      const key = invalid === null && ref && typeof ref === "object" && !Array.isArray(ref)
        ? sourceKey(ref as LoomPolicySourceV1)
        : "";
      if (invalid !== null) {
        return issue(invalid.code, phase, phaseIndex, invalid.detail, invalid.source);
      }
      if (!rootSources.has(key) || subsetSeen.has(key)) {
        return issue("invalid_source", phase, phaseIndex, `childInstructionSubsets[${subsetIndex}] contains an out-of-phase or duplicate source`, "authoring");
      }
      subsetSeen.add(key);
    }
  }
  return null;
}

function parsePhasePredicate(
  predicate: CognitionPredicateV1,
  phase: AgentCustomPhaseV1,
  phaseIndex: number,
  field: "enter" | "exit" | "skip",
): { readonly predicate: CognitionPredicateV1 } | { readonly issue: AgentRuntimePhaseCompileIssueV1 } {
  try {
    return { predicate: parseCognitionPredicate(predicate) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : `${field} predicate is invalid`;
    return { issue: issue("invalid_predicate", phase, phaseIndex, `${field}: ${detail}`, "authoring") };
  }
}

/**
 * Compile the ordered custom phase array. Optional malformed/stale phases are
 * omitted with a visible repair issue; malformed/stale required phases fail
 * closed. This does not mutate or invent any authored phase or transition.
 */
export function compileAgentRuntimePhases(
  phases: readonly AgentCustomPhaseV1[],
  options: CompileAgentRuntimePhasesOptionsV1 = {},
): AgentRuntimePhaseCompileResultV1 {
  if (!Array.isArray(phases) || phases.length > AGENT_RUNTIME_MAX_CUSTOM_PHASES) {
    const limitIssue: AgentRuntimePhaseCompileIssueV1 = {
      ...issue(
        "invalid_phase",
        {},
        -1,
        `phase array must contain at most ${AGENT_RUNTIME_MAX_CUSTOM_PHASES} phases`,
        "authoring",
      ),
      required: true,
    };
    return Object.freeze({
      status: "failed",
      phases: Object.freeze([]),
      issues: Object.freeze([limitIssue]),
      omittedPhaseIds: Object.freeze([]),
    });
  }
  const issues: AgentRuntimePhaseCompileIssueV1[] = [];
  const omittedPhaseIds: string[] = [];
  const phaseIds = new Set<string>();
  const candidates: Array<{ phase: AgentCustomPhaseV1; index: number }> = [];

  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    if (!phase || typeof phase !== "object") {
      issues.push(issue("invalid_phase", {}, index, "phase must be an object", "authoring"));
      continue;
    }
    if (typeof phase.id !== "string" || phase.id.length === 0 || phaseIds.has(phase.id)) {
      const duplicate = typeof phase.id === "string" && phaseIds.has(phase.id);
      issues.push(issue(duplicate ? "duplicate_phase_id" : "invalid_phase", phase, index, duplicate ? "phase id is duplicated" : "phase id is invalid", "authoring"));
      if (phase.required === true) omittedPhaseIds.push(phase.id ?? `phase-${index}`);
      continue;
    }
    phaseIds.add(phase.id);
    candidates.push({ phase, index });
  }

  const validCandidates: Array<{ phase: AgentCustomPhaseV1; index: number; sourceStatus: "verified" | "unverified" }> = [];
  for (const candidate of candidates) {
    const { phase, index } = candidate;
    let phaseIssue: AgentRuntimePhaseCompileIssueV1 | null = null;
    if (
      phase.version !== 1
      || typeof phase.label !== "string"
      || phase.label.length === 0
      || typeof phase.required !== "boolean"
      || !Array.isArray(phase.nextPhaseIds)
      || phase.nextPhaseIds.some((nextId) => typeof nextId !== "string" || nextId.length === 0)
    ) {
      phaseIssue = issue("invalid_phase", phase, index, "phase version, label, required flag, or transitions are invalid", "authoring");
    } else if (!Number.isSafeInteger(phase.repeatLimit) || phase.repeatLimit < 0 || phase.repeatLimit > 4) {
      phaseIssue = issue("invalid_phase", phase, index, "repeatLimit must be an integer from 0 through 4", "authoring");
    } else {
      phaseIssue = validateSourceRefs(phase, index, options.source, options.profileIds);
      if (phaseIssue === null) {
        const enter = parsePhasePredicate(phase.enter, phase, index, "enter");
        const exit = parsePhasePredicate(phase.exit, phase, index, "exit");
        const skip = phase.skip === undefined ? null : parsePhasePredicate(phase.skip, phase, index, "skip");
        if ("issue" in enter) phaseIssue = enter.issue;
        else if ("issue" in exit) phaseIssue = exit.issue;
        else if (skip !== null && "issue" in skip) phaseIssue = skip.issue;
        else if (!Array.isArray(phase.capabilityRequests) || phase.capabilityRequests.some((capability) => !isCapability(capability))) {
          phaseIssue = issue("invalid_phase", phase, index, "capabilityRequests must contain only closed capabilities", "authoring");
        }
      }
    }
    if (phaseIssue !== null) {
      issues.push(phaseIssue);
      if (phase.required) omittedPhaseIds.push(phase.id);
      else issues.push({ ...phaseIssue, code: "optional_phase_omitted", required: false });
      continue;
    }
    validCandidates.push({
      ...candidate,
      sourceStatus: options.source === undefined || options.source === null ? "unverified" : "verified",
    });
  }

  const validIds = new Set(validCandidates.map(({ phase }) => phase.id));
  const compiled: CompiledAgentRuntimePhaseV1[] = [];
  for (const candidate of validCandidates) {
    const { phase, index } = candidate;
    let transitionIssue: AgentRuntimePhaseCompileIssueV1 | null = null;
    for (const nextId of phase.nextPhaseIds) {
      const isSelf = nextId === phase.id;
      const isImmediateNext = nextId === phases[index + 1]?.id;
      if (!validIds.has(nextId)) {
        transitionIssue = issue("unknown_phase", phase, index, `transition references unavailable phase ${nextId}`, "transition");
        break;
      }
      if (!isSelf && !isImmediateNext) {
        transitionIssue = issue("invalid_transition", phase, index, "transitions may target only itself or the immediate next phase", "transition");
        break;
      }
      if (isSelf && phase.repeatLimit === 0) {
        transitionIssue = issue("invalid_transition", phase, index, "self transitions require a positive repeatLimit", "transition");
        break;
      }
    }
    if (transitionIssue !== null) {
      issues.push(transitionIssue);
      if (phase.required) omittedPhaseIds.push(phase.id);
      else issues.push({ ...transitionIssue, code: "optional_phase_omitted", required: false });
      continue;
    }
    const parsedEnter = parseCognitionPredicate(phase.enter);
    const parsedExit = parseCognitionPredicate(phase.exit);
    const parsedSkip = phase.skip === undefined ? undefined : parseCognitionPredicate(phase.skip);
    const childInstructionSubsets = phase.childInstructionSubsets ?? [];
    const normalized: CompiledAgentRuntimePhaseV1 = {
      ...phase,
      enter: parsedEnter,
      exit: parsedExit,
      ...(parsedSkip === undefined ? {} : { skip: parsedSkip }),
      instructionRefs: Object.freeze(phase.instructionRefs.map((ref) => ({ ...ref }))),
      childInstructionSubsets: Object.freeze(childInstructionSubsets.map((subset) => Object.freeze({
        profileId: subset.profileId,
        instructionRefs: Object.freeze(subset.instructionRefs.map((ref) => ({ ...ref }))),
      }))),
      capabilityRequests: Object.freeze([...phase.capabilityRequests]),
      nextPhaseIds: Object.freeze([...phase.nextPhaseIds]),
      index: compiled.length,
      sourceStatus: candidate.sourceStatus,
      sourceIdentity: Object.freeze(phase.instructionRefs.map(sourceIdentity)),
      childInstructionSubsetIdentity: Object.freeze(childInstructionSubsets.map((subset) => Object.freeze({
        profileId: subset.profileId,
        sourceIdentity: Object.freeze(subset.instructionRefs.map(sourceIdentity)),
      }))),
    };
    compiled.push(Object.freeze(normalized));
  }

  const hasRequiredIssue = issues.some((entry) => entry.required && entry.code !== "optional_phase_omitted");
  const status: AgentRuntimePhaseCompileStatusV1 = hasRequiredIssue
    ? "failed"
    : issues.length > 0
      ? "repair_required"
      : "ready";
  return Object.freeze({
    status,
    phases: Object.freeze(compiled),
    issues: Object.freeze(issues),
    omittedPhaseIds: Object.freeze([...new Set(omittedPhaseIds)]),
  });
}

export type AgentRuntimePhaseMachineStatusV1 =
  | "ready"
  | "entered"
  | "completed"
  | "blocked"
  | "failed";

export type AgentRuntimePhaseDecisionStatusV1 =
  | "entered"
  | "skipped"
  | "repeated"
  | "advanced"
  | "completed"
  | "blocked"
  | "failed"
  | "noop";

export type AgentRuntimePhaseConditionResultV1 = "true" | "false" | "invalid" | "omitted";
export type AgentRuntimePhaseCheckpointV1 = "entry" | "exit" | "skip";

export interface AgentRuntimePhaseMachineStateV1 {
  readonly status: AgentRuntimePhaseMachineStatusV1;
  readonly phaseIndex: number | null;
  readonly phaseId: string | null;
  readonly repeatCount: number;
  readonly checkpointRevision: number | null;
  readonly nextPhaseId: string | null;
}

export interface AgentRuntimePhaseDecisionV1 {
  readonly status: AgentRuntimePhaseDecisionStatusV1;
  readonly action: AgentRuntimePhaseDecisionStatusV1;
  readonly phaseId: string | null;
  readonly phaseIndex: number | null;
  readonly checkpoint: AgentRuntimePhaseCheckpointV1;
  readonly revision: number;
  readonly condition: AgentRuntimePhaseConditionResultV1;
  readonly required: boolean;
  readonly repeatCount: number;
  readonly requestedCapabilities: readonly AgentRuntimePhaseCapabilityV1[];
  readonly admittedCapabilities: readonly AgentRuntimePhaseCapabilityV1[];
  readonly reason: string | null;
}

export interface AgentRuntimePhaseInspectionEvidenceV1 {
  readonly version: 1;
  readonly kind: "phase_condition";
  readonly phaseId: string;
  readonly phaseIndex: number;
  readonly phaseLabel: string;
  readonly checkpoint: AgentRuntimePhaseCheckpointV1;
  readonly revision: number;
  readonly condition: AgentRuntimePhaseConditionResultV1;
  readonly required: boolean;
  readonly repeatCount: number;
  readonly status: AgentRuntimePhaseDecisionStatusV1;
  readonly reason: string | null;
  readonly sourceStatus: "verified" | "unverified";
  readonly sourceIdentity: readonly AgentRuntimePhaseSourceIdentityV1[];
  readonly childInstructionSubsetIdentity: readonly AgentRuntimePhaseChildInstructionSubsetIdentityV1[];
  readonly requestedCapabilities: readonly AgentRuntimePhaseCapabilityV1[];
  readonly admittedCapabilities: readonly AgentRuntimePhaseCapabilityV1[];
}

export interface AgentRuntimePhaseCheckpointInputV1 {
  readonly revision: number;
  readonly context: CognitionEvaluationContextV1;
  /** False means the host could not provide a canonical immutable snapshot. */
  readonly snapshotAvailable?: boolean;
}

/** Exact durable authority for resuming an already-admitted phase occurrence. */
export interface AgentRuntimePhaseMachineInitialStateV1 {
  readonly status: "entered";
  readonly phaseIndex: number;
  readonly phaseId: string;
  readonly repeatCount: number;
  readonly checkpointRevision: number;
}

export interface AgentRuntimePhaseMachineOptionsV1 {
  readonly admittedCapabilities?: readonly AgentRuntimePhaseCapabilityV1[];
  /** Restored directly; construction never replays checkpoint predicates or evidence. */
  readonly initialState?: AgentRuntimePhaseMachineInitialStateV1;
}

export interface AgentRuntimePhaseMachineV1 {
  readonly phases: readonly CompiledAgentRuntimePhaseV1[];
  state(): AgentRuntimePhaseMachineStateV1;
  capabilities(): readonly AgentRuntimePhaseCapabilityV1[];
  currentPhase(): CompiledAgentRuntimePhaseV1 | null;
  enter(input: AgentRuntimePhaseCheckpointInputV1): AgentRuntimePhaseDecisionV1;
  /** Evaluate an exit without changing state or recording evidence. */
  previewExit(input: AgentRuntimePhaseCheckpointInputV1): AgentRuntimePhaseDecisionV1;
  exit(input: AgentRuntimePhaseCheckpointInputV1): AgentRuntimePhaseDecisionV1;
  evidence(): readonly AgentRuntimePhaseInspectionEvidenceV1[];
}

interface PredicateCacheEntry {
  readonly revision: number;
  readonly result: AgentRuntimePhaseConditionResultV1;
}

function normalizeAdmittedCapabilities(
  capabilities: readonly AgentRuntimePhaseCapabilityV1[] | undefined,
): readonly AgentRuntimePhaseCapabilityV1[] {
  const result: AgentRuntimePhaseCapabilityV1[] = [];
  const seen = new Set<string>();
  for (const capability of capabilities ?? []) {
    if (isCapability(capability) && !seen.has(capability)) {
      seen.add(capability);
      result.push(capability);
    }
  }
  return Object.freeze(result);
}

function checkpointKey(index: number, checkpoint: AgentRuntimePhaseCheckpointV1): string {
  return `${index}:${checkpoint}`;
}

function invalidInitialState(detail: string): never {
  throw new TypeError("invalid initial phase machine state: " + detail);
}
function phaseParticipatesInAuthoredCycle(
  phases: readonly CompiledAgentRuntimePhaseV1[],
  phase: CompiledAgentRuntimePhaseV1,
): boolean {
  const phasesById = new Map(phases.map((candidate) => [candidate.id, candidate]));
  const pending = [...phase.nextPhaseIds];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const candidateId = pending.pop()!;
    if (candidateId === phase.id) return true;
    if (visited.has(candidateId)) continue;
    visited.add(candidateId);
    const candidate = phasesById.get(candidateId);
    if (candidate) pending.push(...candidate.nextPhaseIds);
  }
  return false;
}

function validateInitialState(
  phases: readonly CompiledAgentRuntimePhaseV1[],
  value: AgentRuntimePhaseMachineInitialStateV1 | undefined,
): AgentRuntimePhaseMachineInitialStateV1 | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidInitialState("state must be an object");
  }
  if (value.status !== "entered") {
    return invalidInitialState("only an entered phase may be restored");
  }
  if (!Number.isSafeInteger(value.phaseIndex) || value.phaseIndex < 0) {
    return invalidInitialState("phaseIndex must be a non-negative safe integer");
  }
  if (typeof value.phaseId !== "string" || value.phaseId.length === 0) {
    return invalidInitialState("phaseId must be a non-empty string");
  }
  if (!Number.isSafeInteger(value.repeatCount) || value.repeatCount < 0) {
    return invalidInitialState("repeatCount must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(value.checkpointRevision) || value.checkpointRevision < 0) {
    return invalidInitialState("checkpointRevision must be a non-negative safe integer");
  }

  const phase = phases[value.phaseIndex];
  if (phase === undefined || phase.index !== value.phaseIndex || phase.id !== value.phaseId) {
    return invalidInitialState("phase index and id do not match compiled phase authority");
  }
  if (!Number.isSafeInteger(phase.repeatLimit) || phase.repeatLimit < 0 || !Array.isArray(phase.nextPhaseIds)) {
    return invalidInitialState("compiled phase repeat authority is invalid");
  }
  if (value.repeatCount > phase.repeatLimit) {
    return invalidInitialState("repeatCount exceeds the compiled phase repeat limit");
  }
  if (value.repeatCount > 0 && !phaseParticipatesInAuthoredCycle(phases, phase)) {
    return invalidInitialState("a repeated occurrence requires an authored transition cycle");
  }

  return Object.freeze({
    status: "entered",
    phaseIndex: value.phaseIndex,
    phaseId: value.phaseId,
    repeatCount: value.repeatCount,
    checkpointRevision: value.checkpointRevision,
  });
}

class AgentRuntimePhaseMachine implements AgentRuntimePhaseMachineV1 {
  readonly phases: readonly CompiledAgentRuntimePhaseV1[];
  private readonly admitted: readonly AgentRuntimePhaseCapabilityV1[];
  private currentIndex = 0;
  private status: AgentRuntimePhaseMachineStatusV1;
  private repeatCount = 0;
  private checkpointRevision: number | null = null;
  private readonly cache = new Map<string, PredicateCacheEntry>();
  private readonly inspection: AgentRuntimePhaseInspectionEvidenceV1[] = [];

  constructor(
    phases: readonly CompiledAgentRuntimePhaseV1[],
    options: AgentRuntimePhaseMachineOptionsV1,
  ) {
    this.phases = Object.freeze([...phases]);
    this.admitted = normalizeAdmittedCapabilities(options.admittedCapabilities);
    const initialState = validateInitialState(this.phases, options.initialState);
    if (initialState === null) {
      this.status = this.phases.length === 0 ? "completed" : "ready";
      return;
    }
    this.currentIndex = initialState.phaseIndex;
    this.status = initialState.status;
    this.repeatCount = initialState.repeatCount;
    this.checkpointRevision = initialState.checkpointRevision;
  }

  state(): AgentRuntimePhaseMachineStateV1 {
    const phase = this.phases[this.currentIndex] ?? null;
    const next = phase === null ? null : this.phases[this.currentIndex + 1]?.id ?? null;
    return Object.freeze({
      status: this.status,
      phaseIndex: phase === null ? null : this.currentIndex,
      phaseId: phase?.id ?? null,
      repeatCount: this.repeatCount,
      checkpointRevision: this.checkpointRevision,
      nextPhaseId: next,
    });
  }

  capabilities(): readonly AgentRuntimePhaseCapabilityV1[] {
    const phase = this.phases[this.currentIndex];
    return phase === undefined
      ? Object.freeze([])
      : intersectAgentRuntimePhaseCapabilities(phase.capabilityRequests, this.admitted);
  }

  currentPhase(): CompiledAgentRuntimePhaseV1 | null {
    return this.phases[this.currentIndex] ?? null;
  }

  evidence(): readonly AgentRuntimePhaseInspectionEvidenceV1[] {
    return Object.freeze(this.inspection.map((entry) => ({
      ...entry,
      childInstructionSubsetIdentity: Object.freeze(entry.childInstructionSubsetIdentity.map((subset) => Object.freeze({
        profileId: subset.profileId,
        sourceIdentity: Object.freeze(subset.sourceIdentity.map((source) => ({ ...source }))),
      }))),
      sourceIdentity: Object.freeze(entry.sourceIdentity.map((source) => ({ ...source }))),
      requestedCapabilities: Object.freeze([...entry.requestedCapabilities]),
      admittedCapabilities: Object.freeze([...entry.admittedCapabilities]),
    })));
  }
  previewExit(input: AgentRuntimePhaseCheckpointInputV1): AgentRuntimePhaseDecisionV1 {
    const snapshot = this.snapshot();
    try {
      return this.exit(input);
    } finally {
      this.restore(snapshot);
    }
  }

  enter(input: AgentRuntimePhaseCheckpointInputV1): AgentRuntimePhaseDecisionV1 {
    const phase = this.phases[this.currentIndex];
    if (phase === undefined || this.status === "completed" || this.status === "failed" || this.status === "blocked") {
      return this.decision("noop", "omitted", input, null, "phase machine is terminal", "entry");
    }
    if (this.status === "entered" && this.checkpointRevision === input.revision) {
      return this.decision("noop", "omitted", input, phase, "entry checkpoint already evaluated", "entry");
    }
    this.checkpointRevision = input.revision;

    if (phase.skip !== undefined) {
      const skip = this.evaluate(phase, "skip", input);
      if (skip === "true") {
        const decision = this.decision("skipped", skip, input, phase, "phase skipped by authored condition", "skip");
        this.record(decision, phase);
        return this.advanceAfter(decision, phase, input);
      }
      if (skip === "false") {
        this.record(this.decision("noop", skip, input, phase, "optional skip predicate was false", "skip"), phase);
      } else if (skip === "invalid") {
        this.record(this.decision("noop", skip, input, phase, "optional skip predicate omitted", "skip"), phase);
      }
    }

    const entered = this.evaluate(phase, "entry", input);
    if (entered === "invalid") {
      if (phase.required) {
        const decision = this.decision("failed", entered, input, phase, "required phase failed closed", "entry");
        this.status = "failed";
        this.record(decision, phase);
        return decision;
      }
      const decision = this.decision("skipped", entered, input, phase, "optional phase omitted", "entry");
      this.record(decision, phase);
      return this.advanceAfter(decision, phase, input);
    }
    if (entered === "false") {
      if (phase.required) {
        const decision = this.decision("blocked", entered, input, phase, "required phase condition not met", "entry");
        this.status = "blocked";
        this.record(decision, phase);
        return decision;
      }
      const decision = this.decision("skipped", entered, input, phase, "optional phase skipped", "entry");
      this.record(decision, phase);
      return this.advanceAfter(decision, phase, input);
    }

    this.status = "entered";
    const decision = this.decision("entered", entered, input, phase, null, "entry");
    this.record(decision, phase);
    return decision;
  }

  exit(input: AgentRuntimePhaseCheckpointInputV1): AgentRuntimePhaseDecisionV1 {
    const phase = this.phases[this.currentIndex];
    if (phase === undefined || this.status !== "entered") {
      return this.decision("noop", "omitted", input, phase ?? null, "phase is not entered", "exit");
    }
    this.checkpointRevision = input.revision;
    const exited = this.evaluate(phase, "exit", input);
    if (exited === "invalid") {
      if (phase.required) {
        const decision = this.decision("failed", exited, input, phase, "required phase failed closed", "exit");
        this.status = "failed";
        this.record(decision, phase);
        return decision;
      }
      const decision = this.decision("skipped", exited, input, phase, "optional phase omitted", "exit");
      this.record(decision, phase);
      return this.advanceAfter(decision, phase, input);
    }
    if (exited === "false") {
      const hasSelfLoop = phase.nextPhaseIds.includes(phase.id);
      if (hasSelfLoop && this.repeatCount < phase.repeatLimit) {
        this.repeatCount += 1;
        this.status = "ready";
        const decision = this.decision("repeated", exited, input, phase, "phase repeats within authored limit", "exit");
        this.record(decision, phase);
        return decision;
      }
      if (hasSelfLoop) {
        if (phase.required) {
          const decision = this.decision("failed", exited, input, phase, "required phase failed closed at repeat limit", "exit");
          this.status = "failed";
          this.record(decision, phase);
          return decision;
        }
        const decision = this.decision("skipped", exited, input, phase, "optional phase omitted at repeat limit", "exit");
        this.record(decision, phase);
        return this.advanceAfter(decision, phase, input);
      }
      // complete_turn is a boundary request. A valid unsatisfied live exit
      // with no authored self-loop stays entered regardless of repeatLimit
      // or required/optional. Skip applies only when skip is true.
      const decision = this.decision("blocked", exited, input, phase, "exit condition not met", "exit");
      this.record(decision, phase);
      return decision;
    }

    const decision = this.decision("advanced", exited, input, phase, null, "exit");
    this.record(decision, phase);
    return this.advanceAfter(decision, phase, input);
  }
  private snapshot(): {
    readonly currentIndex: number;
    readonly status: AgentRuntimePhaseMachineStatusV1;
    readonly repeatCount: number;
    readonly checkpointRevision: number | null;
    readonly cache: ReadonlyMap<string, PredicateCacheEntry>;
    readonly inspectionLength: number;
  } {
    return {
      currentIndex: this.currentIndex,
      status: this.status,
      repeatCount: this.repeatCount,
      checkpointRevision: this.checkpointRevision,
      cache: new Map(this.cache),
      inspectionLength: this.inspection.length,
    };
  }

  private restore(snapshot: {
    readonly currentIndex: number;
    readonly status: AgentRuntimePhaseMachineStatusV1;
    readonly repeatCount: number;
    readonly checkpointRevision: number | null;
    readonly cache: ReadonlyMap<string, PredicateCacheEntry>;
    readonly inspectionLength: number;
  }): void {
    this.currentIndex = snapshot.currentIndex;
    this.status = snapshot.status;
    this.repeatCount = snapshot.repeatCount;
    this.checkpointRevision = snapshot.checkpointRevision;
    this.cache.clear();
    for (const [key, entry] of snapshot.cache) this.cache.set(key, entry);
    this.inspection.length = snapshot.inspectionLength;
  }

  private evaluate(
    phase: CompiledAgentRuntimePhaseV1,
    checkpoint: AgentRuntimePhaseCheckpointV1,
    input: AgentRuntimePhaseCheckpointInputV1,
  ): AgentRuntimePhaseConditionResultV1 {
    const key = checkpointKey(phase.index, checkpoint);
    const cached = this.cache.get(key);
    if (cached?.revision === input.revision) return cached.result;
    if (input.snapshotAvailable === false) {
      const unavailable: AgentRuntimePhaseConditionResultV1 = "invalid";
      this.cache.set(key, { revision: input.revision, result: unavailable });
      return unavailable;
    }
    const predicate = checkpoint === "entry" ? phase.enter : checkpoint === "exit" ? phase.exit : phase.skip;
    let result: AgentRuntimePhaseConditionResultV1;
    try {
      result = evaluateCognitionPredicate(predicate, input.context) ? "true" : "false";
    } catch {
      result = "invalid";
    }
    this.cache.set(key, { revision: input.revision, result });
    return result;
  }

  private advanceAfter(
    decision: AgentRuntimePhaseDecisionV1,
    phase: CompiledAgentRuntimePhaseV1,
    input: AgentRuntimePhaseCheckpointInputV1,
  ): AgentRuntimePhaseDecisionV1 {
    const next = this.phases[this.currentIndex + 1];
    if (next === undefined) {
      this.status = "completed";
      const completed = this.decision("completed", decision.condition, input, phase, "phase sequence completed", decision.checkpoint);
      this.record(completed, phase);
      this.currentIndex = this.phases.length;
      this.repeatCount = 0;
      return completed;
    }
    if (phase.nextPhaseIds.length > 0 && !phase.nextPhaseIds.includes(next.id)) {
      const failed = this.decision("failed", decision.condition, input, phase, "host refused an arbitrary phase transition", decision.checkpoint);
      this.status = phase.required ? "failed" : "blocked";
      this.record(failed, phase);
      return failed;
    }
    this.currentIndex += 1;
    this.repeatCount = 0;
    this.status = "ready";
    const advanced = this.decision("advanced", decision.condition, input, phase, `advanced to ${next.id}`, decision.checkpoint);
    this.record(advanced, phase);
    return advanced;
  }

  private decision(
    status: AgentRuntimePhaseDecisionStatusV1,
    condition: AgentRuntimePhaseConditionResultV1,
    input: AgentRuntimePhaseCheckpointInputV1,
    phase: CompiledAgentRuntimePhaseV1 | null,
    reason: string | null,
    checkpoint: AgentRuntimePhaseCheckpointV1,
  ): AgentRuntimePhaseDecisionV1 {
    const requested = phase?.capabilityRequests ?? [];
    const admitted = phase === null ? [] : intersectAgentRuntimePhaseCapabilities(requested, this.admitted);
    return Object.freeze({
      status,
      action: status,
      phaseId: phase?.id ?? null,
      phaseIndex: phase?.index ?? null,
      checkpoint,
      revision: input.revision,
      condition,
      required: phase?.required === true,
      repeatCount: this.repeatCount,
      requestedCapabilities: Object.freeze([...requested]),
      admittedCapabilities: admitted,
      reason,
    });
  }

  private record(decision: AgentRuntimePhaseDecisionV1, phase: CompiledAgentRuntimePhaseV1): void {
    this.inspection.push(Object.freeze({
      version: 1,
      kind: "phase_condition",
      phaseId: phase.id,
      phaseIndex: phase.index,
      phaseLabel: phase.label,
      checkpoint: decision.checkpoint,
      revision: decision.revision,
      condition: decision.condition,
      required: phase.required,
      childInstructionSubsetIdentity: Object.freeze(phase.childInstructionSubsetIdentity.map((subset) => Object.freeze({
        profileId: subset.profileId,
        sourceIdentity: Object.freeze(subset.sourceIdentity.map((source) => ({ ...source }))),
      }))),
      repeatCount: decision.repeatCount,
      status: decision.status,
      reason: decision.reason,
      sourceStatus: phase.sourceStatus,
      sourceIdentity: Object.freeze(phase.sourceIdentity.map((source) => ({ ...source }))),
      requestedCapabilities: Object.freeze([...phase.capabilityRequests]),
      admittedCapabilities: intersectAgentRuntimePhaseCapabilities(phase.capabilityRequests, this.admitted),
    }));
  }
}

export function createAgentRuntimePhaseMachine(
  phases: readonly CompiledAgentRuntimePhaseV1[] | AgentRuntimePhaseCompileResultV1,
  options: AgentRuntimePhaseMachineOptionsV1 = {},
): AgentRuntimePhaseMachineV1 {
  const compiled = "phases" in phases ? phases.phases : phases;
  return new AgentRuntimePhaseMachine(compiled, options);
}
