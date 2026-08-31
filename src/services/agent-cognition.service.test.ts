import { describe, expect, test } from "bun:test";
import {
  activateCognitionAtPoint,
  applyCognitionTaskTransitionInCas,
  completeCognitionFixedPoint,
  createCognitionActivationState,
  evaluateCognitionPredicate,
  freezeCognitionGraph,
  inspectLoomPromptPolicies,
  normalizeLoomPolicyBucketsV1,
  parseCognitionGraph,
  parseCognitionSourceSnapshot,
  parseCognitionPredicate,
  parseLoomPromptInspectionV1,
  parseTaskTemplate,
} from "./agent-cognition.service";
import {
  AGENT_COGNITION_VERSION,
  AgentCognitionValidationError,
  COGNITION_MAX_PREDICATE_DEPTH,
  COGNITION_MAX_STRING_BYTES,
  type CognitionEvaluationContextV1,
  type CognitionPolicyRefsV1,
  type LoomPolicyBucketsV1,
} from "../types/agent-cognition";

const emptyPolicy: CognitionPolicyRefsV1 = Object.freeze({ workPolicy: [], workspaceUsage: [], completionCriteria: [], renderPolicy: [] });

function source(blocks: Array<{ blockId: string; revision: number; promptOrder: number }> = []) {
  return { presetRevision: 7, blocks };
}

function graph(templates: unknown[] = [], policies: CognitionPolicyRefsV1 = emptyPolicy) {
  return { version: AGENT_COGNITION_VERSION, policies, templates };
}

function evaluation(overrides: Partial<CognitionEvaluationContextV1> = {}): CognitionEvaluationContextV1 {
  return {
    generationType: "normal",
    phase: "WORK",
    presetVariables: {},
    participantFacts: {},
    availableTools: [],
    taskTransitions: {},
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: AgentCognitionValidationError["code"]): void {
  try {
    action();
    throw new Error("expected validation failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentCognitionValidationError);
    expect((error as AgentCognitionValidationError).code).toBe(code);
  }
}

function notDepth(depth: number): unknown {
  let node: unknown = { kind: "generation_type", value: "normal" };
  for (let index = 1; index < depth; index += 1) node = { kind: "not", child: node };
  return node;
}

function loomEntry(
  id: string,
  bucket: "workPolicy" | "workspaceUsage" | "completionCriteria" | "renderPolicy" = "workPolicy",
  options: { required?: boolean; condition?: unknown; blockId?: string; promptOrder?: number } = {},
): Record<string, unknown> {
  const blockId = options.blockId ?? "loom-1";
  const promptOrder = options.promptOrder ?? 1;
  const destination = bucket === "completionCriteria" ? "completion_handoff" : bucket === "renderPolicy" ? "render" : "root_work";
  const checkpoint = bucket === "completionCriteria" ? "PREPARE_COMMIT" : bucket === "renderPolicy" ? "RENDER" : "WORK";
  return {
    version: 1,
    id,
    source: { kind: "loom_block", blockId, presetRevision: 7, blockRevision: 3, promptOrder },
    destination,
    checkpoint,
    required: options.required ?? true,
    visibility: "work_only",
    ...(options.condition === undefined ? {} : { condition: options.condition }),
  };
}

function policy(entries: readonly Record<string, unknown>[] = []): LoomPolicyBucketsV1 {
  return {
    version: 1,
    workPolicy: entries.filter((entry) => entry.destination === "root_work" && entry.checkpoint === "WORK"),
    workspaceUsage: [],
    completionCriteria: entries.filter((entry) => entry.destination === "completion_handoff"),
    renderPolicy: entries.filter((entry) => entry.destination === "render"),
  } as unknown as LoomPolicyBucketsV1;
}

function block(blockId = "loom-1", content = "Loom guidance", promptOrder = 1) {
  return { source: { kind: "loom_block" as const, blockId, presetRevision: 7, blockRevision: 3, promptOrder }, content };
}

describe("agent cognition predicates and task graph", () => {
  test("evaluates typed predicates without dynamic nodes", () => {
    const values = evaluation({
      generationType: "swipe",
      phase: "RENDER",
      presetVariables: { mode: "focused", tags: ["alpha", "beta"], count: 2 },
      participantFacts: { role: "writer" },
      availableTools: ["lore_get_book"],
      taskTransitions: { research: "completed" },
    });
    expect(evaluateCognitionPredicate({ kind: "generation_type", value: "swipe" }, values)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "phase", value: "RENDER" }, values)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "preset_variable", name: "mode", operator: "equals", value: "focused" }, values)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "preset_variable", name: "tags", operator: "includes", value: "beta" }, values)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "participant_fact", name: "role", operator: "equals", value: "writer" }, values)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "tool_available", toolId: "lore_get_book", available: true }, values)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "task_transition", taskId: "research", transition: "completed" }, values)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "all", children: [
      { kind: "phase", value: "RENDER" },
      { kind: "not", child: { kind: "phase", value: "WORK" } },
    ] }, values)).toBe(true);
    expect(evaluateCognitionPredicate({ kind: "participant_fact", name: "missing", operator: "present" }, values)).toBe(false);
  });

  test("rejects unknown predicate and graph fields", () => {
    expectCode(() => parseCognitionPredicate({ kind: "phase", value: "WORK", extra: true }), "unknown_key");
    expectCode(() => parseCognitionPredicate({ kind: "regex", pattern: ".*" }), "invalid_value");
    expectCode(() => parseCognitionPredicate({ kind: "preset_variable", name: "x", operator: "equals", value: "{{now}}" }), "invalid_value");
    expectCode(() => parseCognitionGraph({ ...graph(), unknown: [] }), "unknown_key");
  });

  test("enforces predicate caps", () => {
    expectCode(() => parseCognitionPredicate({ kind: "preset_variable", name: "x".repeat(COGNITION_MAX_STRING_BYTES + 1), operator: "present" }), "limit_exceeded");
    parseCognitionPredicate(notDepth(COGNITION_MAX_PREDICATE_DEPTH));
    expectCode(() => parseCognitionPredicate(notDepth(COGNITION_MAX_PREDICATE_DEPTH + 1)), "limit_exceeded");
  });

  test("parses task templates and rejects removed graph semantics", () => {
    expect(parseTaskTemplate({ id: "review", label: "Review", description: "Read evidence", required: true, dependencies: [] })).toMatchObject({ id: "review", required: true, dependencies: [] });
    expectCode(() => parseTaskTemplate({ id: "review", required: false, dependencies: [], extra: true }), "unknown_key");
    expectCode(() => parseCognitionGraph({ ...graph(), unknown: [] }), "unknown_key");
  });

  test("freezes dependency closure and activates only selected task roots", () => {
    const authored = graph([
      { id: "root", required: true, dependencies: ["dependency"], activation: { kind: "phase", value: "WORK" } },
      { id: "dependency", required: false, dependencies: [] },
      { id: "other", required: false, dependencies: [] },
    ]);
    const frozen = freezeCognitionGraph(authored, source());
    const state = createCognitionActivationState(frozen, 4);
    const activation = activateCognitionAtPoint(frozen, state, evaluation(), "phase_entry", { templateIds: ["root"] });
    expect(activation.state.activatedTemplateIds).toEqual(["dependency", "root"]);
    expect(activation.state.requiredTemplateIds).toEqual(["dependency", "root"]);
    expect(activation.state.workspaceRevision).toBe(4);
    expect(activation.state).toMatchObject({ version: AGENT_COGNITION_VERSION, activatedTemplateIds: ["dependency", "root"], requiredTemplateIds: ["dependency", "root"] });
    const complete = completeCognitionFixedPoint(frozen, activation.state, evaluation({ taskTransitions: { root: "completed", dependency: "completed" } }), { templateIds: ["root"] });
    expect(complete.canComplete).toBe(true);
    expect(complete.blockingRequiredTaskIds).toEqual([]);
  });

  test("applies task transition through the supplied CAS exactly once", () => {
    const frozen = freezeCognitionGraph(graph([{ id: "task", required: false, dependencies: [] }]), source());
    const initial = createCognitionActivationState(frozen, 0);
    let current = initial;
    const result = applyCognitionTaskTransitionInCas(frozen, initial, evaluation(), "task", "active", {
      commit(expectedRevision, update) {
        expect(expectedRevision).toBe(current.workspaceRevision);
        current = update(current);
        return current;
      },
    });
    expect(result.taskId).toBe("task");
    expect(result.transition).toBe("active");
    expect(result.state.workspaceRevision).toBe(1);
    expect(current).toEqual(result.state);
  });
});

describe("Loom policy inspection", () => {
  test("normalizes four buckets with typed checkpoint condition", () => {
    const raw = policy([loomEntry("work", "workPolicy", { condition: { kind: "phase", value: "WORK" } }), loomEntry("complete", "completionCriteria")]);
    const normalized = normalizeLoomPolicyBucketsV1(raw, source([{ blockId: "loom-1", revision: 3, promptOrder: 1 }]));
    expect(normalized.workPolicy[0]?.condition).toEqual({ kind: "phase", value: "WORK" });
    expect(normalized.completionCriteria[0]?.checkpoint).toBe("PREPARE_COMMIT");
    expect(Object.hasOwn(normalized.workPolicy[0] ?? {}, "condition")).toBe(true);
  });

  test("inspects Loom blocks with conditions, checkpoint gating, and deterministic dedupe", () => {
    const raw = {
      version: 1,
      workPolicy: [loomEntry("first", "workPolicy", { blockId: "same", promptOrder: 1 }), loomEntry("conditional", "workPolicy", { blockId: "other", promptOrder: 2, condition: { kind: "phase", value: "RENDER" } })],
      completionCriteria: [],
      workspaceUsage: [loomEntry("duplicate", "workspaceUsage", { blockId: "same", promptOrder: 1 })],
      renderPolicy: [],
    };
    const normalized = normalizeLoomPolicyBucketsV1(raw, source([
      { blockId: "same", revision: 3, promptOrder: 1 },
      { blockId: "other", revision: 3, promptOrder: 2 },
    ]));
    const inspected = inspectLoomPromptPolicies(normalized, {
      checkpoint: "WORK",
      surface: "WORK",
      blocks: [block("same", "First"), block("other", "Conditional", 2)],
      evaluation: evaluation(),
    });
    expect(inspected.effectiveEntryIds).toEqual(["first"]);
    expect(inspected.items.map((item) => item.outcome.status)).toEqual(["included", "skipped", "deduplicated"]);
    expect(inspected.items[1]?.conditionResult).toBe("false");
    expect(inspected.items[2]?.outcome).toMatchObject({ status: "deduplicated", keptEntryId: "first", destination: "root_work" });
    expect(inspected.items.every((item) => item.ordinaryPromptSuppressed)).toBe(true);
  });

  test("fails closed for missing required source, skips optional stale source, and omits Response", () => {
    const raw = {
      version: 1,
      workPolicy: [loomEntry("required", "workPolicy", { required: true }), loomEntry("optional", "workPolicy", { required: false, blockId: "missing", promptOrder: 2 })],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    };
    const normalized = normalizeLoomPolicyBucketsV1(raw, source([{ blockId: "loom-1", revision: 3, promptOrder: 1 }, { blockId: "missing", revision: 3, promptOrder: 2 }]));
    const work = inspectLoomPromptPolicies(normalized, { checkpoint: "WORK", surface: "WORK", blocks: [block()] });
    expect(work.items.map((item) => item.outcome.status)).toEqual(["included", "skipped"]);
    const response = inspectLoomPromptPolicies(normalized, { checkpoint: "WORK", surface: "RESPONSE", blocks: [] });
    expect(response.effectiveEntryIds).toEqual([]);
    expect(response.items.every((item) => item.outcome.status === "omitted")).toBe(true);
    expect(response.responseOmission?.omittedEntryIds).toEqual(["required", "optional"]);
  });

  test("round-trips and binds repeated block IDs to distinct prompt-order occurrences", () => {
    const duplicateIdSource = source([
      { blockId: "same", revision: 3, promptOrder: 0 },
      { blockId: "same", revision: 3, promptOrder: 1 },
    ]);
    expect(parseCognitionSourceSnapshot(duplicateIdSource).blocks.map((entry) => [entry.blockId, entry.promptOrder])).toEqual([
      ["same", 0],
      ["same", 1],
    ]);
    expectCode(() => parseCognitionSourceSnapshot(source([
      { blockId: "same", revision: 3, promptOrder: 0 },
      { blockId: "same", revision: 3, promptOrder: 0 },
    ])), "duplicate_id");

    const raw = {
      version: 1,
      workPolicy: [
        loomEntry("occurrence-zero", "workPolicy", { blockId: "same", promptOrder: 0 }),
        loomEntry("occurrence-one", "workPolicy", { blockId: "same", promptOrder: 1 }),
      ],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    };
    const normalized = normalizeLoomPolicyBucketsV1(raw, duplicateIdSource);
    const inspected = inspectLoomPromptPolicies(normalized, {
      checkpoint: "WORK",
      surface: "WORK",
      blocks: [block("same", "Occurrence zero", 0), block("same", "Occurrence one", 1)],
      evaluation: evaluation(),
    });
    expect(inspected.effectiveEntryIds).toEqual(["occurrence-zero", "occurrence-one"]);
    expect(inspected.items.filter((item) => item.outcome.status === "included").map((item) => item.effectiveText)).toEqual(["Occurrence zero", "Occurrence one"]);

    const occurrencePolicyRefs: CognitionPolicyRefsV1 = {
      workPolicy: [
        { blockId: "same", expectedPresetRevision: 7, expectedBlockRevision: 3, promptOrder: 0 },
        { blockId: "same", expectedPresetRevision: 7, expectedBlockRevision: 3, promptOrder: 1 },
      ],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    };
    expect(parseCognitionGraph(graph([], occurrencePolicyRefs)).policies).toEqual(occurrencePolicyRefs);
    expectCode(() => parseCognitionGraph(graph([], {
      ...occurrencePolicyRefs,
      workPolicy: [occurrencePolicyRefs.workPolicy[0]!, occurrencePolicyRefs.workPolicy[0]!],
    })), "duplicate_id");
    const frozen = freezeCognitionGraph(graph([], occurrencePolicyRefs), duplicateIdSource);
    expect(frozen.policies).toEqual(occurrencePolicyRefs);
    expect(frozen.sourceRevisions.blockRevisions).toEqual([
      { blockId: "same", revision: 3, promptOrder: 0 },
      { blockId: "same", revision: 3, promptOrder: 1 },
    ]);

    const conflict = normalizeLoomPolicyBucketsV1({
      ...raw,
      workPolicy: [
        { ...loomEntry("conflict-a", "workPolicy", { blockId: "same", promptOrder: 0, required: false }) },
        {
          ...loomEntry("conflict-b", "workPolicy", { blockId: "same", promptOrder: 0, required: false }),
          source: { ...(loomEntry("unused", "workPolicy", { blockId: "same", promptOrder: 0 }).source as Record<string, unknown>), blockRevision: 4 },
        },
      ],
    }, duplicateIdSource);
    const conflictInspection = inspectLoomPromptPolicies(conflict, {
      checkpoint: "WORK",
      surface: "WORK",
      blocks: [block("same", "Occurrence zero", 0)],
      evaluation: evaluation(),
    });
    expect(conflictInspection.items.map((item) => item.outcome)).toEqual([
      { status: "rejected", reason: "invalid_source" },
      { status: "rejected", reason: "invalid_source" },
    ]);

    const denied = inspectLoomPromptPolicies(normalized, {
      checkpoint: "WORK",
      surface: "WORK",
      blocks: [block("same", "Occurrence zero", 0), block("other", "Wrong occurrence", 1)],
      evaluation: evaluation(),
    });
    expect(denied.items.map((item) => item.outcome.status)).toEqual(["included", "rejected"]);
    expectCode(() => normalizeLoomPolicyBucketsV1({
      ...raw,
      workPolicy: [{ ...loomEntry("wrong-category", "workPolicy", { blockId: "same", promptOrder: 0 }), destination: "render" }],
    }, duplicateIdSource), "invalid_value");
  });

  test("round-trips inspection evidence", () => {
    const normalized = normalizeLoomPolicyBucketsV1({ version: 1, workPolicy: [loomEntry("entry")], workspaceUsage: [], completionCriteria: [], renderPolicy: [] }, source([{ blockId: "loom-1", revision: 3, promptOrder: 1 }]));
    const inspected = inspectLoomPromptPolicies(normalized, { checkpoint: "WORK", surface: "WORK", blocks: [block()] });
    expect(parseLoomPromptInspectionV1(inspected)).toEqual(inspected);
    expectCode(() => parseLoomPromptInspectionV1({ ...inspected, items: [{ ...inspected.items[0], extra: "unexpected" }] }), "unknown_key");
  });
});
