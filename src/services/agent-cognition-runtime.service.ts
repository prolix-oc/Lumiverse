import { createHash } from "node:crypto";
import {
  activateCognitionAtPoint,
  completeCognitionFixedPoint,
  createCognitionActivationState,
  inspectLoomPromptPolicies,
  freezeCognitionGraph,
  parseCognitionEvaluationContext,
  parseCognitionSourceSnapshot,
  parseCanonicalRuntimePolicyV1,
  parseCognitionGraph,
  parseLoomPolicyBuckets,
} from "./agent-cognition.service";
import { compareUtf8 } from "../utils/utf8-order";
import {
  AgentCognitionRuntimeError,
  type AgentCognitionRuntimeSourceV1,
  type AgentCognitionRuntimeV1,
  type AuthenticatedAgentCognitionSourceV1,
  type CognitionTaskIdentityV1,
  type CognitionRuntimeActivationV1,
  type CognitionRuntimeCompletionInputV1,
  type CognitionRuntimeCompletionV1,
  type CognitionRuntimePhaseInputV1,
  type CognitionRuntimePhaseV1,
  type CognitionRuntimePreparedAcceptanceV1,
  type CognitionRuntimeTaskTransitionInputV1,
  type CognitionWorkspaceActivationUpdateV1,
  type CognitionWorkspaceCompletionResultV1,
  type CognitionWorkspaceCompletionUpdateV1,
  type CognitionWorkspaceMutationResultV1,
  type CognitionWorkspacePhaseUpdateV1,
  type CreateAgentCognitionRuntimeInputV1,
} from "../types/agent-cognition-runtime";
import type { AgentRuntimePolicyV1 } from "../types/agents";
import { deriveCognitionOperationalTaskId, LOOM_POLICY_CHECKPOINTS } from "../types/agent-cognition";
import type {
  CognitionActivationResultV1,
  CognitionActivationRootsV1,
  CognitionActivationStateV1,
  CognitionCompletionResultV1,
  CognitionEvaluationContextV1,
  CognitionLoomBlockRefV1,
  CognitionPhase,
  CognitionPolicyRefsV1,
  CognitionTaskTransition,
  FrozenCognitionGraphV1,
  LoomPolicyBucketsV1,
  LoomPolicyCheckpointV1,
  LoomPromptInspectionV1,
  TaskTemplateV1,
} from "../types/agent-cognition";
import {
  acceptWorkspaceSubmissionWithCognition,
  activateWorkspaceCognitionAtPhase,
  createWorkspaceTaskWithCognition,
  freezeWorkspaceForCompletionWithCognition,
  previewWorkspaceCompletionWithCognition,
  settleWorkspaceChildTaskWithCognition,
  submitWorkspaceChildResultWithCognition,
  submitWorkspaceRootResultWithCognition,
  updateWorkspaceTaskProgressWithCognition,
  type CognitionWorkspacePreparedAcceptanceV1,
} from "./turn-workspace.service";

const EMPTY_POLICY: CognitionPolicyRefsV1 = Object.freeze({ workPolicy: Object.freeze([]), workspaceUsage: Object.freeze([]), completionCriteria: Object.freeze([]), renderPolicy: Object.freeze([]) });
const LOOM_POLICY_BUCKET_KEYS = ["workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy"] as const;

function refsFromCanonicalLoomPolicy(value: unknown, sourceValue?: unknown): CognitionPolicyRefsV1 {
  let policy: LoomPolicyBucketsV1;
  try {
    policy = parseLoomPolicyBuckets(value);
  } catch (error) {
    failSource(
      "config.runtimePolicy.loomPolicy",
      error instanceof Error ? error.message : "expected a canonical Loom policy object",
    );
  }
  const source = sourceValue === undefined ? null : parseCognitionSourceSnapshot(sourceValue);
  const result = {} as Record<(typeof LOOM_POLICY_BUCKET_KEYS)[number], CognitionLoomBlockRefV1[]>;
  for (const bucket of LOOM_POLICY_BUCKET_KEYS) {
    const rawEntries = policy[bucket];
    result[bucket] = rawEntries.flatMap((rawEntry, index): CognitionLoomBlockRefV1[] => {
      const path = `config.runtimePolicy.loomPolicy.${bucket}[${index}]`;
      const sourceValue = rawEntry.source;
      const expectedPresetRevision = sourceValue.presetRevision;
      const expectedBlockRevision = sourceValue.blockRevision;
      const expectedPromptOrder = sourceValue.promptOrder;
      const sourceBlock = source?.blocks.find((block) => block.promptOrder === expectedPromptOrder);
      const exact = source !== null
        && sourceBlock !== undefined
        && sourceBlock.blockId === sourceValue.blockId
        && source.presetRevision === expectedPresetRevision
        && sourceBlock.revision === expectedBlockRevision;
      if (!exact) {
        if (rawEntry.required) failSource(path, "required Loom block provenance is stale");
        return [];
      }
      return [{
        blockId: sourceValue.blockId,
        expectedPresetRevision,
        expectedBlockRevision,
        promptOrder: expectedPromptOrder,
      }];
    });
  }
  return { workPolicy: result.workPolicy, workspaceUsage: result.workspaceUsage, completionCriteria: result.completionCriteria, renderPolicy: result.renderPolicy };
}

function cortexSnapshotFromSource(source: AgentCognitionRuntimeSourceV1): unknown {
  if (source.cortexSidecarSnapshot !== undefined) return source.cortexSidecarSnapshot;
  if (isPlainObject(source.config) && source.config.cortexSidecarSnapshot !== undefined) return source.config.cortexSidecarSnapshot;
  if (isPlainObject(source.source) && source.source.cortexSidecarSnapshot !== undefined) return source.source.cortexSidecarSnapshot;
  return undefined;
}


function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return typeof (value as { readonly then?: unknown }).then === "function";
}

function failSource(path: string, message: string): never {
  throw new AgentCognitionRuntimeError("invalid_source", message, path);
}



function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach((entry) => deepFreeze(entry));
  else Object.values(value as Record<string, unknown>).forEach((entry) => deepFreeze(entry));
  return Object.freeze(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isPlainObject(value)) return JSON.stringify(String(value));
  return `{${Object.keys(value).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function semanticWorkspacePayload(operation: CognitionRuntimeTaskTransitionInputV1["operation"], workspace: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const fields = operation === "create_task"
    ? ["title", "objective", "required", "dependencyIds", "assignedFrameId", "retention", "ttlSeconds"]
    : operation === "update_assigned_progress"
      ? ["state", "progress", "progressPercent"]
      : operation === "submit_child_result"
        ? ["summary", "resultDigest", "byteCount", "retention", "ttlSeconds"]
        : operation === "submit_root_result"
          ? ["summary", "state", "retention", "ttlSeconds"]
          : operation === "settle_child_failure"
            ? ["state", "assignedFrameId"]
            : ["submissionId"];
  return Object.freeze(Object.fromEntries(fields.filter((field) => Object.hasOwn(workspace, field)).map((field) => [field, workspace[field]])));
}

function semanticCompletionPayload(workspace: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const fields = ["completionSummary", "completionUnresolvedIds", "completionRenderGuidance"];
  return Object.freeze(Object.fromEntries(fields.filter((field) => Object.hasOwn(workspace, field)).map((field) => [field, workspace[field]])));
}

function operationalCognitionTaskId(workspace: Record<string, unknown>, authoredTaskId: string): string {
  if (typeof workspace.turnId !== "string" || workspace.turnId.length === 0) return authoredTaskId;
  return deriveCognitionOperationalTaskId(workspace.turnId, authoredTaskId);
}

function cognitionTaskIdentity(graph: FrozenCognitionGraphV1, workspace: Record<string, unknown>, taskId: string): CognitionTaskIdentityV1 {
  const authored = graph.templates.find((template) => template.id === taskId);
  if (authored) return Object.freeze({ authoredTaskId: authored.id, operationalTaskId: operationalCognitionTaskId(workspace, authored.id) });
  const operational = graph.templates.find((template) => operationalCognitionTaskId(workspace, template.id) === taskId);
  if (operational) return Object.freeze({ authoredTaskId: operational.id, operationalTaskId: taskId });
  return Object.freeze({ authoredTaskId: taskId, operationalTaskId: taskId });
}

function authoredTaskIdForOperational(graph: FrozenCognitionGraphV1, workspace: Record<string, unknown>, operationalTaskId: string): string {
  return graph.templates.find((template) => operationalCognitionTaskId(workspace, template.id) === operationalTaskId)?.id ?? operationalTaskId;
}

function publicMaterializedTaskIds(graph: FrozenCognitionGraphV1, workspace: Record<string, unknown>, operationalTaskIds: readonly string[]): readonly string[] {
  return Object.freeze(operationalTaskIds.map((taskId) => authoredTaskIdForOperational(graph, workspace, taskId)));
}

function sourceDigest(graph: FrozenCognitionGraphV1, source: unknown, roots: CognitionActivationRootsV1, loomPolicy?: unknown, loomBlocks?: unknown): string {
  return createHash("sha256").update(canonical({ graph, source, roots, loomPolicy, loomBlocks }), "utf8").digest("hex");
}

function phaseContext(base: CognitionEvaluationContextV1, phase: CognitionPhase, transitions: Readonly<Record<string, CognitionTaskTransition>>): CognitionEvaluationContextV1 {
  return parseCognitionEvaluationContext({ ...base, phase, taskTransitions: transitions });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("cognition_transition_cancelled");
}

function phaseRefs(graph: FrozenCognitionGraphV1, phase: CognitionPhase): CognitionRuntimeActivationV1["promptBlocks"] {
  const refs = phase === "ASSEMBLE"
    ? [...graph.policies.workPolicy, ...graph.policies.workspaceUsage, ...graph.policies.completionCriteria, ...graph.policies.renderPolicy]
    : phase === "WORK"
      ? [...graph.policies.workPolicy, ...graph.policies.workspaceUsage]
      : phase === "COMPLETE"
        ? [...graph.policies.completionCriteria]
        : phase === "RENDER"
          ? [...graph.policies.renderPolicy]
          : [];
  const seen = new Set<string>();
  const ordered = refs.filter((ref) => {
    const occurrenceKey = `${ref.blockId.length}:${ref.blockId}:${ref.promptOrder}`;
    if (seen.has(occurrenceKey)) return false;
    seen.add(occurrenceKey);
    return true;
  });
  return Object.freeze({ phase, refs: Object.freeze(ordered) });
}

function materializationTemplates(graph: FrozenCognitionGraphV1, ids: readonly string[]): readonly TaskTemplateV1[] {
  const wanted = new Set(ids);
  return Object.freeze(graph.templates.filter((template) => wanted.has(template.id)));
}

function phaseWorkspaceUpdate(state: CognitionActivationStateV1, activation: CognitionActivationResultV1, graph: FrozenCognitionGraphV1): CognitionWorkspacePhaseUpdateV1 {
  return Object.freeze({ state: Object.freeze({ ...activation.state, workspaceRevision: state.workspaceRevision + 1 }), activation, materializeTemplates: materializationTemplates(graph, activation.newlyActivatedTemplateIds) });
}

const SUCCESS_COMPLETION_PHASES = Object.freeze(["RENDER", "PREPARE_COMMIT", "COMMITTING", "COMMITTED"] as const);

function appendedIds(after: readonly string[], before: readonly string[]): readonly string[] {
  const prior = new Set(before);
  return Object.freeze(after.filter((id) => !prior.has(id)));
}

interface CognitionCompletionClosureV1 {
  readonly activation: CognitionActivationResultV1;
  readonly completion: CognitionCompletionResultV1;
  readonly activationViews: readonly CognitionRuntimeActivationV1[];
  readonly materializeTemplates: readonly TaskTemplateV1[];
  readonly blockingRequiredTaskIds: readonly string[];
}

type LoomCheckpointEvidenceV1 = Map<LoomPolicyCheckpointV1, LoomPromptInspectionV1>;

function completionActivationClosure(
  graph: FrozenCognitionGraphV1,
  state: CognitionActivationStateV1,
  baseEvaluation: CognitionEvaluationContextV1,
  transitions: Readonly<Record<string, CognitionTaskTransition>>,
  frozenSourceDigest: string,
  loomSource: AgentCognitionRuntimeSourceV1,
  checkpointEvidence: LoomCheckpointEvidenceV1,
  roots: CognitionActivationRootsV1,
): CognitionCompletionClosureV1 {
  const startingTemplateIds = state.activatedTemplateIds;
  let current = completeCognitionFixedPoint(graph, state, phaseContext(baseEvaluation, "COMPLETE", transitions), roots);
  const activationViews: CognitionRuntimeActivationV1[] = [runtimeActivation("COMPLETE", current.state, current, graph, frozenSourceDigest, loomSource, phaseContext(baseEvaluation, "COMPLETE", transitions), checkpointEvidence)];
  let finalActivation: CognitionActivationResultV1 = current;
  for (const phase of SUCCESS_COMPLETION_PHASES) {
    const next = activateCognitionAtPoint(graph, current.state, phaseContext(baseEvaluation, phase, transitions), "phase_entry", roots);
    current = {
      ...current,
      ...next,
      point: "completion_fixed_point",
      state: next.state,
      newlyActivatedTemplateIds: appendedIds(next.state.activatedTemplateIds, startingTemplateIds),
      newlyRequiredTemplateIds: appendedIds(next.state.requiredTemplateIds, state.requiredTemplateIds),
    };
    finalActivation = current;
    activationViews.push(runtimeActivation(phase, next.state, next, graph, frozenSourceDigest, loomSource, phaseContext(baseEvaluation, phase, transitions), checkpointEvidence));
  }
  const blockingRequiredTaskIds = Object.freeze(finalActivation.state.requiredTemplateIds.filter((taskId) => transitions[taskId] !== "completed").sort(compareUtf8));
  const activation = Object.freeze({
    ...finalActivation,
    state: finalActivation.state,
    newlyActivatedTemplateIds: appendedIds(finalActivation.state.activatedTemplateIds, startingTemplateIds),
    newlyRequiredTemplateIds: appendedIds(finalActivation.state.requiredTemplateIds, state.requiredTemplateIds),
  });
  const completion = Object.freeze({ ...activation, fixedPointIterations: current.fixedPointIterations, blockingRequiredTaskIds, canComplete: blockingRequiredTaskIds.length === 0 });
  return Object.freeze({ activation, completion, activationViews: Object.freeze(activationViews), materializeTemplates: materializationTemplates(graph, finalActivation.state.activatedTemplateIds.filter((id) => !startingTemplateIds.includes(id))), blockingRequiredTaskIds });
}

function loomPolicyCheckpoint(phase: CognitionRuntimePhaseV1 | "COMPLETE"): LoomPolicyCheckpointV1 {
  return phase === "ASSEMBLE" || phase === "WORK" || phase === "RENDER" ? phase : "PREPARE_COMMIT";
}

function loomPolicySurface(
  phase: CognitionRuntimePhaseV1 | "COMPLETE",
  source: AgentCognitionRuntimeSourceV1,
  evaluation: CognitionEvaluationContextV1,
  checkpointEvidence: LoomCheckpointEvidenceV1,
): CognitionRuntimeActivationV1["policySurface"] {
  if (!source.loomPolicy) return undefined;
  const checkpoint = loomPolicyCheckpoint(phase);
  let inspection = checkpointEvidence.get(checkpoint);
  if (inspection === undefined) {
    const targetIndex = LOOM_POLICY_CHECKPOINTS.indexOf(checkpoint);
    for (let index = 0; index <= targetIndex; index += 1) {
      const currentCheckpoint = LOOM_POLICY_CHECKPOINTS[index];
      if (currentCheckpoint === undefined || checkpointEvidence.has(currentCheckpoint)) continue;
      const priorCheckpoint = index === 0 ? undefined : LOOM_POLICY_CHECKPOINTS[index - 1];
      const previousInspection = priorCheckpoint === undefined ? undefined : checkpointEvidence.get(priorCheckpoint);
      const checkpointEvaluation = phaseContext(evaluation, currentCheckpoint, evaluation.taskTransitions);
      const candidate = inspectLoomPromptPolicies(source.loomPolicy, {
        checkpoint: currentCheckpoint,
        surface: "WORK",
        blocks: source.loomBlocks ?? [],
        evaluation: checkpointEvaluation,
        ...(previousInspection === undefined ? {} : { previousInspection }),
      });
      if (candidate.items.some((item) => item.outcome.status === "rejected")) {
        throw new AgentCognitionRuntimeError("invalid_source", "required Loom policy source was rejected at its checkpoint");
      }
      checkpointEvidence.set(currentCheckpoint, candidate);
    }
    inspection = checkpointEvidence.get(checkpoint);
  }
  if (inspection === undefined) {
    throw new AgentCognitionRuntimeError("invalid_source", "Loom checkpoint evidence was not recorded");
  }
  return Object.freeze({ policies: source.loomPolicy, promptInspection: inspection });
}

function runtimeActivation(
  phase: CognitionRuntimePhaseV1 | "COMPLETE",
  state: CognitionActivationStateV1,
  activation: CognitionActivationResultV1,
  graph: FrozenCognitionGraphV1,
  frozenSourceDigest: string,
  loomSource: AgentCognitionRuntimeSourceV1,
  evaluation: CognitionEvaluationContextV1,
  checkpointEvidence: LoomCheckpointEvidenceV1,
): CognitionRuntimeActivationV1 {
  const policySurface = loomPolicySurface(phase, loomSource, evaluation, checkpointEvidence);
  return Object.freeze({
    phase,
    state,
    activation,
    promptBlocks: phaseRefs(graph, phase),
    ...(policySurface === undefined ? {} : { policySurface }),
    sourceRevisions: graph.sourceRevisions,
    sourceDigest: frozenSourceDigest,
    workspaceRevision: state.workspaceRevision,
  });
}

function assertWorkspaceRevision(workspace: Record<string, unknown>, expectedRevision: number): void {
  if (workspace.expectedRevision !== expectedRevision) throw new AgentCognitionRuntimeError("workspace_cas_conflict", "workspace context is stale for cognition CAS");
}

function graphFromAuthenticatedSource(source: AgentCognitionRuntimeSourceV1): AgentCognitionRuntimeSourceV1 {
  const cortexSidecarSnapshot = cortexSnapshotFromSource(source);
  let runtimePolicy: AgentRuntimePolicyV1 | null = null;
  if (source.config !== undefined && source.config !== null) {
    if (!isPlainObject(source.config)) failSource("config", "expected a normalized config object");
    if (Object.hasOwn(source.config, "runtimePolicy")) {
      try {
        runtimePolicy = parseCanonicalRuntimePolicyV1(source.config.runtimePolicy, "config.runtimePolicy");
      } catch (error) {
        failSource("config.runtimePolicy", error instanceof Error ? error.message : "invalid runtime policy");
      }
    }
  }
  const loomPolicy = source.loomPolicy ?? runtimePolicy?.loomPolicy ?? undefined;
  if (loomPolicy !== undefined) refsFromCanonicalLoomPolicy(loomPolicy, source.source);
  if (source.graph !== undefined) {
    return {
      graph: source.graph,
      source: source.source,
      taskTemplates: source.taskTemplates,
      taskTemplateIds: source.taskTemplateIds,
      ...(loomPolicy === undefined ? {} : { loomPolicy }),
      ...(source.loomBlocks === undefined ? {} : { loomBlocks: source.loomBlocks }),
      ...(cortexSidecarSnapshot === undefined ? {} : { cortexSidecarSnapshot }),
    };
  }
  if (!source.config) failSource("config", "normalized config is required when graph is absent");
  return {
    graph: { version: 1, policies: refsFromCanonicalLoomPolicy(loomPolicy, source.source), templates: source.taskTemplates ?? [] },
    source: source.source,
    taskTemplates: source.taskTemplates,
    taskTemplateIds: source.taskTemplateIds,
    ...(loomPolicy === undefined ? {} : { loomPolicy }),
    ...(source.loomBlocks === undefined ? {} : { loomBlocks: source.loomBlocks }),
    ...(cortexSidecarSnapshot === undefined ? {} : { cortexSidecarSnapshot }),
  };
}

function authoredGraphFromSnapshot(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const frozenKeys = ["sourceRevisions", "templateDependencyClosure", "requiredTemplateClosure"] as const;
  if (!frozenKeys.every((key) => Object.hasOwn(value, key))) return value;
  return { version: value.version, policies: value.policies, templates: value.templates };
}

function selectedTaskRootIds(graphValue: unknown, selectedTaskIds: readonly unknown[] | undefined): readonly string[] {
  const parsedGraph = parseCognitionGraph(authoredGraphFromSnapshot(graphValue));
  if (selectedTaskIds === undefined) return Object.freeze(parsedGraph.templates.map((template) => template.id));
  return Object.freeze(selectedTaskIds.map((value, index) => {
    if (typeof value !== "string" || value.length === 0) failSource(`taskTemplateIds[${index}]`, "expected a non-empty template ID");
    return value;
  }));
}

function graphWithSelectedTaskTemplates(graphValue: unknown, selectedTaskIds: readonly unknown[] | undefined): unknown {
  const authored = authoredGraphFromSnapshot(graphValue);
  if (selectedTaskIds === undefined) return authored;
  if (!Array.isArray(selectedTaskIds)) failSource("taskTemplateIds", "expected an array");
  const parsedGraph = parseCognitionGraph(authored);
  const templatesById = new Map(parsedGraph.templates.map((template) => [template.id, template] as const));
  const selectedIds = new Set<string>();
  const selectedRoots = new Set<string>();
  const includeClosure = (id: string, path: string): void => {
    if (selectedIds.has(id)) return;
    const template = templatesById.get(id);
    if (!template) failSource(path, `selected task template ${id} is missing from the frozen graph`);
    selectedIds.add(id);
    for (const dependency of template.dependencies ?? []) includeClosure(dependency, `${path}.dependencies`);
  };
  selectedTaskIds.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) failSource(`taskTemplateIds[${index}]`, "expected a non-empty template ID");
    if (selectedRoots.has(value)) failSource(`taskTemplateIds[${index}]`, `duplicate selected task template ${value}`);
    selectedRoots.add(value);
    if (!templatesById.has(value)) failSource(`taskTemplateIds[${index}]`, `selected task template ${value} is missing from the frozen graph`);
    includeClosure(value, `taskTemplateIds[${index}]`);
  });
  return { ...(authored as Record<string, unknown>), templates: parsedGraph.templates.filter((template) => selectedIds.has(template.id)) };
}

export function createAgentCognitionRuntime(input: CreateAgentCognitionRuntimeInputV1): AgentCognitionRuntimeV1 {
  const authenticatedSource = graphFromAuthenticatedSource(input.source);
  const taskRootIds = selectedTaskRootIds(authenticatedSource.graph, authenticatedSource.taskTemplateIds);
  const graph = freezeCognitionGraph(graphWithSelectedTaskTemplates(authenticatedSource.graph, authenticatedSource.taskTemplateIds), authenticatedSource.source);
  const activationRoots: CognitionActivationRootsV1 = deepFreeze({ templateIds: taskRootIds });
  const frozenSource = deepFreeze(parseCognitionSourceSnapshot(authenticatedSource.source));
  const baseEvaluation = parseCognitionEvaluationContext(input.evaluation);
  const frozenSourceDigest = sourceDigest(graph, frozenSource, activationRoots, authenticatedSource.loomPolicy, authenticatedSource.loomBlocks);
  const initialRevision = input.workspaceRevision;
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 0) failSource("workspaceRevision", "expected a non-negative safe integer");
  const expectedRevision = input.workspace.expectedRevision;
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision !== initialRevision) failSource("workspaceRevision", "runtime revision does not match the workspace CAS revision");
  let state = createCognitionActivationState(graph, initialRevision);
  let currentPhase: CognitionRuntimePhaseV1 = "ASSEMBLE";
  const transitions: Record<string, CognitionTaskTransition> = { ...baseEvaluation.taskTransitions };
  let checkpointEvidence: LoomCheckpointEvidenceV1 = new Map();
  let completionAccepted = false;
  const operationResults = new Map<string, { fingerprint: string; result: CognitionWorkspaceMutationResultV1 }>();
  const completionResults = new Map<string, { fingerprint: string; result: CognitionRuntimeCompletionV1 }>();
  const initialCandidate = activateCognitionAtPoint(graph, state, phaseContext(baseEvaluation, "ASSEMBLE", transitions), "initial", activationRoots);
  const committed = activateWorkspaceCognitionAtPhase(input.workspace, { state, update: (currentState): CognitionWorkspacePhaseUpdateV1 => phaseWorkspaceUpdate(currentState, initialCandidate, graph) });
  state = committed.state;
  const initialView = runtimeActivation("ASSEMBLE", state, committed.activation, graph, frozenSourceDigest, authenticatedSource, phaseContext(baseEvaluation, "ASSEMBLE", transitions), checkpointEvidence);

  const runtime: AgentCognitionRuntimeV1 = {
    graph,
    activationRoots,
    source: deepFreeze({
      graph,
      source: frozenSource,
      taskTemplates: authenticatedSource.taskTemplates,
      taskTemplateIds: authenticatedSource.taskTemplateIds,
      ...(authenticatedSource.loomPolicy === undefined ? {} : { loomPolicy: authenticatedSource.loomPolicy }),
      ...(authenticatedSource.loomBlocks === undefined ? {} : { loomBlocks: authenticatedSource.loomBlocks }),
      ...(authenticatedSource.cortexSidecarSnapshot === undefined ? {} : { cortexSidecarSnapshot: authenticatedSource.cortexSidecarSnapshot }),
    }),
    policySurface: initialView.policySurface,
    initialActivation: initialView,
    adoptWorkspaceMutationRevision(workspaceRevision: number): void {
      if (!Number.isSafeInteger(workspaceRevision) || workspaceRevision !== state.workspaceRevision + 1) throw new AgentCognitionRuntimeError("workspace_cas_conflict", "non-cognition workspace mutation is not the next CAS revision");
      if (completionAccepted) throw new AgentCognitionRuntimeError("completion_blocked", "workspace cognition is frozen after completion");
      state = Object.freeze({ ...state, workspaceRevision });
    },
    enterPhase(inputPhase: CognitionRuntimePhaseInputV1): CognitionRuntimeActivationV1 {
      assertWorkspaceRevision(inputPhase.workspace, state.workspaceRevision);
      const phaseEvaluation = phaseContext(baseEvaluation, inputPhase.phase, transitions);
      const candidate = activateCognitionAtPoint(graph, state, phaseEvaluation, "phase_entry", activationRoots);
      if (completionAccepted) {
        if (candidate.newlyActivatedTemplateIds.length > 0 || candidate.newlyRequiredTemplateIds.length > 0) throw new AgentCognitionRuntimeError("completion_blocked", `cognition activation is not frozen for ${inputPhase.phase}`);
        currentPhase = inputPhase.phase;
        return runtimeActivation(inputPhase.phase, state, candidate, graph, frozenSourceDigest, authenticatedSource, phaseEvaluation, checkpointEvidence);
      }
      const phaseCommit = activateWorkspaceCognitionAtPhase(inputPhase.workspace, { state, update: (currentState): CognitionWorkspacePhaseUpdateV1 => phaseWorkspaceUpdate(currentState, candidate, graph) });
      state = phaseCommit.state;
      currentPhase = inputPhase.phase;
      return runtimeActivation(inputPhase.phase, state, phaseCommit.activation, graph, frozenSourceDigest, authenticatedSource, phaseEvaluation, checkpointEvidence);
    },
    applyWorkspaceTransition(input: CognitionRuntimeTaskTransitionInputV1): CognitionWorkspaceMutationResultV1 {
      throwIfAborted(input.signal);
      const identity = cognitionTaskIdentity(graph, input.workspace, input.taskId);
      const reservation = input.reservation;
      const operationKey = reservation.operationKey;
      const transition: CognitionTaskTransition = input.operation === "create_task"
        ? "pending"
        : input.operation === "submit_child_result" || input.operation === "accept_submission"
          ? "completed"
          : input.operation === "submit_root_result"
            ? input.workspace.state === "failed" ? "failed" : "completed"
            : input.workspace.state === "pending"
              ? "pending"
              : input.workspace.state === "active"
                ? "active"
                : input.workspace.state === "blocked"
                  ? "blocked"
                  : input.workspace.state === "cancelled"
                    ? "cancelled"
                    : input.workspace.state === "failed"
                      ? "failed"
                      : (() => { throw new AgentCognitionRuntimeError("invalid_source", "workspace progress state is invalid"); })();
      if (input.transition !== transition) throw new AgentCognitionRuntimeError("invalid_source", "workspace transition does not match the authenticated operation");
      const reservationOperation = input.operation === "settle_child_failure" ? "settle_child_task" : input.operation;
      if (reservation.operationKind !== reservationOperation) {
        throw new AgentCognitionRuntimeError("invalid_source", "workspace reservation does not match the authenticated operation");
      }
      const fingerprint = canonical({ reservation, operation: input.operation, taskId: identity.authoredTaskId, transition, payload: semanticWorkspacePayload(input.operation, input.workspace) });
      const previous = operationResults.get(operationKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new AgentCognitionRuntimeError("idempotency_conflict", "operation key was reused for a different transition", operationKey);
        return previous.result;
      }
      if (completionAccepted) throw new AgentCognitionRuntimeError("completion_blocked", "workspace cognition is frozen after completion");
      assertWorkspaceRevision(input.workspace, state.workspaceRevision);
      if (input.operation === "create_task" && graph.templates.some((template) => template.id === identity.authoredTaskId)) throw new AgentCognitionRuntimeError("invalid_source", "workspace task identifier is reserved by frozen cognition templates", input.taskId);
      const nextTransitions = { ...transitions, [identity.authoredTaskId]: transition };
      let computed: CognitionWorkspaceActivationUpdateV1 | undefined;
      const update = (current: CognitionActivationStateV1): CognitionWorkspaceActivationUpdateV1 => {
        if (current.workspaceRevision !== state.workspaceRevision) throw new AgentCognitionRuntimeError("workspace_cas_conflict", "cognition state is stale for workspace CAS");
        const activation = activateCognitionAtPoint(graph, current, phaseContext(baseEvaluation, currentPhase, nextTransitions), "task_transition", activationRoots);
        const next: CognitionWorkspaceActivationUpdateV1 = { taskId: identity.operationalTaskId, transition, reservation, state: Object.freeze({ ...activation.state, workspaceRevision: current.workspaceRevision + 1 }), activation, materializeTemplates: materializationTemplates(graph, activation.newlyActivatedTemplateIds) };
        computed = next;
        return next;
      };
      const workspace = { ...input.workspace, taskId: identity.operationalTaskId };
      const workspaceResult = input.operation === "create_task"
        ? createWorkspaceTaskWithCognition(workspace, { state, update })
        : input.operation === "update_assigned_progress"
          ? updateWorkspaceTaskProgressWithCognition(workspace, { state, update })
          : input.operation === "submit_child_result"
            ? submitWorkspaceChildResultWithCognition(workspace, { state, update })
            : input.operation === "submit_root_result"
              ? submitWorkspaceRootResultWithCognition(workspace, { state, update })
              : input.operation === "settle_child_failure"
                ? settleWorkspaceChildTaskWithCognition(workspace, { state, update })
                : acceptWorkspaceSubmissionWithCognition(workspace, { state, update });
      const evaluated = computed;
      if (!evaluated) throw new AgentCognitionRuntimeError("workspace_cas_conflict", "workspace CAS did not evaluate cognition");
      const cognition = runtimeActivation(currentPhase, workspaceResult.state, workspaceResult.activation, graph, frozenSourceDigest, authenticatedSource, phaseContext(baseEvaluation, currentPhase, nextTransitions), checkpointEvidence);
      const result = deepFreeze({
        workspaceRevision: workspaceResult.workspaceRevision,
        state: workspaceResult.state,
        activation: workspaceResult.activation,
        materializedTaskIds: publicMaterializedTaskIds(graph, input.workspace, workspaceResult.materializedTaskIds),
        taskId: evaluated.taskId,
        transition: evaluated.transition,
        operationKey: workspaceResult.operationKey,
        segmentId: workspaceResult.segmentId,
        logicalDispatch: workspaceResult.logicalDispatch,
        frameId: workspaceResult.frameId,
        operationDigest: workspaceResult.operationDigest,
        cognition,
      });
      state = result.state;
      transitions[identity.authoredTaskId] = transition;
      operationResults.set(operationKey, { fingerprint, result });
      return result;
    },
    async acceptCompletionFixedPoint(input: CognitionRuntimeCompletionInputV1): Promise<CognitionRuntimeCompletionV1> {
      throwIfAborted(input.signal);
      const operationKey = input.operationKey;
      const fingerprint = canonical({ operation: "completion_fixed_point", payload: semanticCompletionPayload(input.workspace) });
      if (operationKey) {
        const previous = completionResults.get(operationKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new AgentCognitionRuntimeError("idempotency_conflict", "completion operation key was reused for a different workspace", operationKey);
          return previous.result;
        }
      }
      if (completionAccepted) throw new AgentCognitionRuntimeError("completion_blocked", "completion fixed point is already accepted");
      assertWorkspaceRevision(input.workspace, state.workspaceRevision);
      const candidateCheckpointEvidence: LoomCheckpointEvidenceV1 = new Map(checkpointEvidence);
      let computed: CognitionWorkspaceCompletionUpdateV1 | undefined;
      let closure: CognitionCompletionClosureV1 | undefined;
      const workspace = { ...input.workspace };
      delete workspace.completionSummary;
      delete workspace.completionUnresolvedIds;
      delete workspace.completionRenderGuidance;
      const update = (current: CognitionActivationStateV1): CognitionWorkspaceCompletionUpdateV1 => {
        if (current.workspaceRevision !== state.workspaceRevision) throw new AgentCognitionRuntimeError("workspace_cas_conflict", "cognition state is stale for completion CAS");
        const activationClosure = completionActivationClosure(graph, current, baseEvaluation, transitions, frozenSourceDigest, authenticatedSource, candidateCheckpointEvidence, activationRoots);
        closure = activationClosure;
        const next: CognitionWorkspaceCompletionUpdateV1 = {
          state: Object.freeze({ ...activationClosure.activation.state, workspaceRevision: current.workspaceRevision + 1 }),
          activation: activationClosure.activation,
          accepted: activationClosure.completion.canComplete,
          blockingRequiredTaskIds: activationClosure.blockingRequiredTaskIds,
          materializeTemplates: activationClosure.materializeTemplates,
        };
        computed = next;
        return next;
      };
      const makeRuntimeCompletion = (workspaceResult: CognitionWorkspaceCompletionResultV1, evaluatedClosure: CognitionCompletionClosureV1): CognitionRuntimeCompletionV1 => {
        const finalActivation = Object.freeze({ ...workspaceResult.activation, state: workspaceResult.state });
        const operationalBlockingRequiredTaskIds = [...new Set(workspaceResult.blockingRequiredTaskIds.map((id) => authoredTaskIdForOperational(graph, workspace, id)))];
        const blockers = operationalBlockingRequiredTaskIds.map((id) => ({ kind: "task" as const, id }));
        return deepFreeze({
          ...runtimeActivation("COMPLETE", workspaceResult.state, finalActivation, graph, frozenSourceDigest, authenticatedSource, phaseContext(baseEvaluation, "PREPARE_COMMIT", transitions), candidateCheckpointEvidence),
          accepted: workspaceResult.accepted && blockers.length === 0,
          blockers,
          blockingRequiredTaskIds: Object.freeze(blockers.map((blocker) => blocker.id)),
          materializedTaskIds: publicMaterializedTaskIds(graph, workspace, workspaceResult.materializedTaskIds),
          preCommitActivations: Object.freeze([...evaluatedClosure.activationViews]),
        });
      };
      const provisionalPreview = previewWorkspaceCompletionWithCognition(workspace, { state, update });
      const provisionalWorkspaceResult = provisionalPreview.candidate;
      const provisionalUpdate = computed;
      if (!provisionalUpdate) throw new AgentCognitionRuntimeError("workspace_cas_conflict", "completion fixed point was not evaluated");
      const provisionalClosure = closure;
      if (!provisionalClosure) throw new AgentCognitionRuntimeError("workspace_cas_conflict", "completion fixed point was not evaluated");
      const provisionalResult = makeRuntimeCompletion(provisionalWorkspaceResult, provisionalClosure);
      const preparedWorkspace = input.prepareAcceptance && provisionalResult.accepted ? {
        prepare: (workspaceResult: CognitionWorkspaceCompletionResultV1) => {
          const evaluated = computed;
          const evaluatedClosure = closure;
          if (!evaluated || !evaluatedClosure) throw new AgentCognitionRuntimeError("workspace_cas_conflict", "completion fixed point was not evaluated");
          const transactionResult = makeRuntimeCompletion(workspaceResult, evaluatedClosure);
          let prepared: CognitionRuntimePreparedAcceptanceV1;
          try {
            prepared = input.prepareAcceptance!(transactionResult);
          } catch (error) {
            if (error instanceof AgentCognitionRuntimeError) throw error;
            throw new AgentCognitionRuntimeError("completion_blocked", "completion handoff preparation failed");
          }
          if (isThenable(prepared) || !prepared || canonical(prepared.candidate) !== canonical(transactionResult)) throw new AgentCognitionRuntimeError("completion_blocked", "completion handoff preparation did not match the fixed point");
          if (input.validatePreparedAcceptance && !input.validatePreparedAcceptance(prepared, transactionResult)) throw new AgentCognitionRuntimeError("completion_blocked", "completion handoff preparation was not acknowledged");
          return { candidate: workspaceResult, bundle: prepared.bundle };
        },
      } satisfies CognitionWorkspacePreparedAcceptanceV1 : undefined;
      const workspaceResult = freezeWorkspaceForCompletionWithCognition(workspace, { state, update }, preparedWorkspace);
      const evaluated = computed;
      const evaluatedClosure = closure;
      if (!evaluated || !evaluatedClosure) throw new AgentCognitionRuntimeError("workspace_cas_conflict", "workspace CAS did not evaluate completion cognition");
      const completion = makeRuntimeCompletion(workspaceResult, evaluatedClosure);
      const result = workspaceResult.preparedAcceptance ? deepFreeze({ ...completion, preparedAcceptance: { candidate: completion, bundle: workspaceResult.preparedAcceptance.bundle } }) : completion;
      state = workspaceResult.state;
      currentPhase = "WORK";
      completionAccepted = result.accepted;
      if (result.accepted) checkpointEvidence = candidateCheckpointEvidence;
      if (operationKey) completionResults.set(operationKey, { fingerprint, result });
      return result;
    },
  };
  return runtime;
}

export function cognitionRuntimeCortexSnapshot(runtime: AgentCognitionRuntimeV1): unknown | undefined {
  return cortexSnapshotFromSource(runtime.source);
}

export function createAgentCognitionRuntimeFromAuthenticatedSource(source: AuthenticatedAgentCognitionSourceV1, evaluation: CognitionEvaluationContextV1, workspaceRevision: number, workspace: Record<string, unknown>): AgentCognitionRuntimeV1 {
  return createAgentCognitionRuntime({ source: graphFromAuthenticatedSource(source), evaluation, workspaceRevision, workspace });
}
