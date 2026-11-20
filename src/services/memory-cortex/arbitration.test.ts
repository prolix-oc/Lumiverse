import { describe, expect, spyOn, test } from "bun:test";
import { arbitrateCortexCandidates, buildArbitrationBatches, validateArbitrationVerdicts, type CortexArbitrationInput } from "./arbitration";
import { attributeFactsToEntities, buildCortexArbitrationPlan } from "./arbitration-plan";
import { DEFAULT_CORTEX_CONFIG, normalizeCortexConfig } from "./config";
import { getCortexStructuralSignature } from "./index";
import * as decisions from "../decisions.service";

const input: CortexArbitrationInput = { passage: "Mara, known as Red, promised to protect Tovin.", canonicals: [{ id: "c0", name: "Mara", aliases: ["Red"] }], candidates: [
  { id: "e0", kind: "entity", name: "Red", canonicalIds: ["c0"] },
  { id: "e1", kind: "entity", name: "Tovin" },
] };

describe("Cortex arbitration contract", () => {
  test("pages every candidate including candidates beyond old prompt caps", () => {
    const candidates = Array.from({ length: 257 }, (_, i) => ({ id: `e${i}`, kind: "entity" as const, name: `Name${i}` }));
    const batches = buildArbitrationBatches({ ...input, candidates });
    expect(batches).toHaveLength(9);
    expect(batches.flatMap((b) => Object.keys(b.questions))).toEqual(candidates.map((c) => c.id));
    expect(() => buildArbitrationBatches({ ...input, passage: "x".repeat(900_000) })).toThrow("budget");
  });
  test("rejects missing, duplicate, foreign and invented-target verdicts", () => {
    for (const verdicts of [[], [{ id: "e0", action: "keep" }, { id: "e0", action: "keep" }],
      [{ id: "e0", action: "resolve", canonicalId: "invented" }, { id: "e1", action: "keep" }],
      [{ id: "foreign", action: "reject" }, { id: "e1", action: "keep" }]]) {
      expect(() => validateArbitrationVerdicts(verdicts, input.candidates)).toThrow();
    }
  });
  test("Decision batches fit a 16K estimate while preserving every candidate and all evidence", () => {
    const candidates = Array.from({ length: 35 }, (_, i) => ({ id: `e${i}`, kind: "entity" as const,
      name: `Name${i}`, canonicalIds: ["c0"], evidence: [`Full evidence for candidate ${i}.`] }));
    const batches = buildArbitrationBatches({ ...input, candidates }, 16384);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => (batch.state as any).candidates)).toEqual(candidates);
    for (const batch of batches) {
      expect(256 + Math.ceil(Buffer.byteLength(JSON.stringify(batch)) / 3)).toBeLessThanOrEqual(Math.floor(16384 * 0.8));
      expect((batch.state as any).passage).toBe(input.passage);
      expect((batch.state as any).canonicals).toEqual(input.canonicals);
      expect(Object.keys(batch.questions)).toEqual((batch.state as any).candidates.map((c: any) => c.id));
      expect(Object.values(batch.questions)[0]!.instructions).not.toContain("For color candidates");
    }
    expect(() => buildArbitrationBatches({ ...input, passage: "Full passage. ".repeat(10000) }, 16384)).toThrow("no evidence was truncated");
  });
  test("each question retains its relevant rules without unrelated review instructions", () => {
    const [batch] = buildArbitrationBatches({ ...input, candidates: [
      ...input.candidates, { id: "r0", kind: "relationship", source: "Mara", target: "Tovin", type: "lover" },
      { id: "f0", kind: "color", name: "Mara", type: "thought", hexColor: "#abcdef" },
      { id: "x0", kind: "existing", name: "Mara" },
    ] });
    expect(batch!.questions.r0!.instructions).toContain("A supported love interest is sufficient");
    expect(batch!.questions.r0!.instructions).toContain("A student is not a child relationship");
    expect(batch!.questions.r0!.instructions).not.toContain("For color candidates");
    expect(batch!.questions.f0!.instructions).toContain("Thought/italic wrappers");
    expect(batch!.questions.f0!.instructions).toContain("established viewpoint, in any POV");
    expect(batch!.questions.f0!.instructions).not.toContain("For lover");
    expect(batch!.questions.x0!.instructions).toContain("Absence from this passage or low importance is never grounds for rejection");
  });
  test("an unconfigured reviewer never calls a Decision default or a generative sidecar", async () => {
    const evaluate = spyOn(decisions, "evaluateDecisionAnswers").mockImplementation(async () => { throw new Error("Unexpected inference"); });
    try {
      const config = normalizeCortexConfig({ ...DEFAULT_CORTEX_CONFIG, queryGeneration: {
        primary: { connectionProfileId: "llm-default", model: "llm-model" }, secondary: null,
      } });
      await expect(arbitrateCortexCandidates({ userId: "test", config, input })).rejects.toThrow("Select a Decision arbitration connection");
      expect(evaluate).not.toHaveBeenCalled();
    } finally { evaluate.mockRestore(); }
  });
  test("a cancelled review never starts inference", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(arbitrateCortexCandidates({ userId: "test", config: DEFAULT_CORTEX_CONFIG, input, signal: controller.signal })).rejects.toThrow();
  });
  test("legacy configs remain optional and relevant settings invalidate warmup", () => {
    const config = normalizeCortexConfig({ enabled: true });
    expect(config.sidecarReliability.arbitratesHeuristics).toBe(false);
    expect(config.arbitration.backend).toBe("decision");
    const enabled = { ...config, arbitration: { ...config.arbitration, connectionProfileId: "decision-a" }, sidecarReliability: { ...config.sidecarReliability, arbitratesHeuristics: true } };
    const signature = getCortexStructuralSignature(enabled);
    expect(getCortexStructuralSignature({ ...enabled, arbitration: { ...enabled.arbitration, connectionProfileId: "decision-b" } })).not.toBe(signature);
    expect(getCortexStructuralSignature({ ...enabled, arbitration: { ...enabled.arbitration, minConfidence: 0.9 } })).not.toBe(signature);
    expect(getCortexStructuralSignature({ ...enabled, nonProseScaffoldTags: ["hud"] })).not.toBe(signature);
  });
});

test("the plan gates provisional entities, attached aliases and relationship endpoints", () => {
  const plan = buildCortexArbitrationPlan({ passage: input.passage, knownEntities: [], characterNames: ["Mara"], gradeExisting: false, graph: {
    entities: [{ name: "Mara", type: "character", aliases: ["Red"], confidence: 0.9 }, { name: "Tovin", type: "concept", aliases: [], confidence: 0.5, provisional: true }],
    aliases: [], relationships: [{ source: "Mara", target: "Tovin", type: "ally", label: "protection promise", sentiment: 0.8 }],
  } });
  expect(plan.input.candidates.map((c) => c.kind)).toEqual(["entity", "entity", "relationship", "alias"]);
  const result = plan.apply(plan.input.candidates.map((candidate) => ({ id: candidate.id, action: candidate.id === "e0" || candidate.kind === "relationship" ? "keep" : "defer" })));
  expect(result.graph.entities.map((e) => e.name)).toEqual(["Mara"]);
  expect(result.graph.entities[0]?.aliases).toEqual([]);
  expect(result.graph.relationships).toEqual([]);
  expect(result.graph.aliases).toEqual([]);
});

test("facts attach to explicit names and aliases with word boundaries", () => {
  const result = attributeFactsToEntities(["Mara saved Tovin.", "Red promised to return.", "It was quiet.", "Marathon continued."], [
    { name: "Mara", aliases: ["Red"] }, { name: "Tovin", aliases: [] },
  ]);
  expect(result.get("Mara")).toEqual(["Mara saved Tovin.", "Red promised to return."]);
  expect(result.get("Tovin")).toEqual(["Mara saved Tovin."]);
});

test("review retains unambiguous short-name identity hints without persisting unreviewed aliases", () => {
  const plan = buildCortexArbitrationPlan({ passage: "Pulchra entered New Eridu.", knownEntities: [],
    characterNames: ["Pulchra Fellini"], gradeExisting: false, graph: {
      entities: [{ name: "Pulchra Fellini", type: "character", aliases: [], confidence: 1 }],
      relationships: [], aliases: [],
    } });
  const [batch] = buildArbitrationBatches(plan.input);
  expect((batch!.state as any).canonicals[0]).toMatchObject({ name: "Pulchra Fellini", nameParts: ["Pulchra", "Fellini"] });
  expect(batch!.questions.e0!.instructions).toContain("A single clear mention is sufficient");
  expect(batch!.questions.e0!.instructions).toContain("nameParts");
  const kept = plan.apply([{ id: "e0", action: "keep" }]);
  expect(kept.graph.entities[0]!.aliases).toEqual([]);
  expect(kept.graph.aliases).toEqual([]);
});

test("short-name identity hints exclude ambiguous parts and other entity names", () => {
  const plan = buildCortexArbitrationPlan({ passage: "Mara met Voss.", knownEntities: [],
    characterNames: ["Mara Voss", "Mara Vale", "Voss"], gradeExisting: false,
    graph: { entities: [], relationships: [], aliases: [] } });
  const first = plan.input.canonicals.find((c) => c.name === "Mara Voss")!;
  expect((first as any).nameParts ?? []).toEqual([]);
  expect((plan.input.canonicals.find((c) => c.name === "Mara Vale") as any).nameParts).toEqual(["Vale"]);
});

test("new alias proposals cannot become canonical hints before review", () => {
  const plan = buildCortexArbitrationPlan({ passage: "Mara introduced herself as Red.", knownEntities: [], characterNames: [], gradeExisting: false,
    canonicalAliases: new Map([["M", "Mara"]]), graph: {
      entities: [{ name: "Mara", type: "character", aliases: ["Invented"], confidence: 0.9 },
        { name: "Red", type: "concept", aliases: [], confidence: 0.5, provisional: true }],
      aliases: [{ alias: "Red", canonicalName: "Mara", evidence: "Mara introduced herself as Red." }], relationships: [],
    } });
  expect(plan.input.canonicals[0]?.aliases).toEqual(["M"]);
  const result = plan.apply(plan.input.candidates.map((c) => c.id === "e1"
    ? { id: c.id, action: "resolve", canonicalId: "c0" }
    : { id: c.id, action: c.kind === "alias" ? "reject" : "keep" }));
  expect(result.graph.entities[0]?.aliases).not.toContain("Invented");
  expect(result.graph.aliases.map((a) => a.alias)).toEqual(["Red"]);
});

test("ambiguous accepted aliases cannot redirect a relationship endpoint", () => {
  const plan = buildCortexArbitrationPlan({ passage: "Mara and Tovin both use Red. Red mentors Voss.", knownEntities: [], characterNames: [], gradeExisting: false,
    graph: { entities: ["Mara", "Tovin", "Voss"].map((name) => ({ name, type: "character", aliases: [], confidence: 0.9 })),
      relationships: [{ source: "Red", target: "Voss", type: "mentor", label: "mentor", sentiment: 0.3 }],
      aliases: [{ canonicalName: "Mara", alias: "Red" }, { canonicalName: "Tovin", alias: "Red" }],
    } });
  expect(plan.apply(plan.input.candidates.map((candidate) => ({ id: candidate.id, action: "keep" }))).graph.relationships).toEqual([]);
});

test("color claims are reviewed independently and follow only accepted character identities", () => {
  const plan = buildCortexArbitrationPlan({ passage: '*<font color="#abc">Red thought of home.</font>*',
    knownEntities: [], characterNames: ["Mara"], canonicalAliases: new Map([["Red", "Mara"]]), gradeExisting: false, graph: {
      entities: [{ name: "Red", type: "character", aliases: [], confidence: 0.8 }], relationships: [], aliases: [],
      colors: [{ hexColor: "#aabbcc", entityName: "Red", usageType: "thought", confidence: 0.8, evidence: ['*<font color="#abc">Red thought of home.</font>*'] }],
    } });
  const candidate = plan.input.candidates.find((entry) => entry.kind === "color")!;
  expect(candidate).toMatchObject({ id: "f0", name: "Red", hexColor: "#aabbcc", type: "thought" });
  const verdicts = [{ id: "e0", action: "resolve" as const, canonicalId: "c0" }, { id: "f0", action: "keep" as const }];
  expect(plan.apply(verdicts).graph.colors?.[0]?.entityName).toBe("Mara");
  for (const action of ["reject", "defer"] as const) {
    expect(plan.apply([{ ...verdicts[0]! }, { id: "f0", action }]).graph.colors).toEqual([]);
  }
  expect(plan.apply([{ id: "e0", action: "reject" }, { id: "f0", action: "keep" }]).graph.colors).toEqual([]);
  expect(() => plan.apply([verdicts[0]!])).toThrow("Incomplete");
});

test("each review question directly states its subject and uses distinct outcomes", () => {
  const [batch] = buildArbitrationBatches({ passage: "Mara met Tovin.", canonicals: [], candidates: [
    { id: "e0", kind: "entity", name: "Mara", type: "character" },
    { id: "r0", kind: "relationship", source: "Mara", target: "Tovin", type: "mentor" },
    { id: "a0", kind: "alias", source: "Red", target: "Mara" },
  ] });
  expect(batch!.questions.e0!.instructions).toStartWith('Does the passage mention or refer to "Mara"');
  expect(batch!.questions.r0!.instructions).toStartWith('Does the passage support "Mara" as mentor of "Tovin"');
  expect(batch!.questions.a0!.instructions).toStartWith('Does "Red" refer to "Mara"');
  const entityQuestion = batch!.questions.e0!;
  if (entityQuestion.type !== "choice") throw new Error("Expected a Choice question");
  expect(entityQuestion.criteria.reject).toContain("no reference");
  expect(entityQuestion.criteria.defer).toContain("ambiguous");
  expect(String(batch!.questions.e0!.instructions).length).toBeLessThan(1400);
  expect(String(batch!.questions.r0!.instructions)).not.toContain("For lover");
});

test("relationship reviews use broad conceptual guidance across all types without examples or a formal-bond requirement", () => {
  for (const kind of ["relationship", "reactivation"] as const) {
    const candidates = ["ally", "mentor", "lover", "enemy", "rival", "parent", "child", "sibling", "owns", "member_of", "located_in", "fears", "serves", "custom"].map((type, index) => ({
      id: `r${index}`, kind, source: "Mara", target: "Prolix", type,
    }));
    const [batch] = buildArbitrationBatches({ passage: 'At Silver Inn, Mara carries Dawnblade. "I trust you to watch my back, Prolix."',
      canonicals: [], participants: [{ name: "Mara", role: "character" }, { name: "Prolix", role: "user" }], candidates });
    for (const question of Object.values(batch!.questions)) {
      expect(question.instructions).toContain("One clear interaction, agreement or commitment is sufficient");
      expect(question.instructions).toContain("an established bond reaffirmed here");
      expect(question.instructions).toContain("The named user persona is an in-story character");
      expect(question.instructions).toContain("Judge this claim independently of item/location links and importance");
      expect(question.instructions).toContain("meaning in context, not a fixed set of words or behaviors");
      expect(question.instructions).toContain("all other types are equally eligible");
      expect(question.instructions).toContain("these overlap and are not exhaustive");
      expect(question.instructions).toContain("Custom admits supported connections outside the standard categories");
      expect(question.instructions).not.toContain("I trust you to watch my back");
      expect(question.instructions).not.toContain("I will train you");
      expect(question.instructions).toContain("Co-presence, routine conversation");
      expect(question.instructions).toContain("Negated or hypothetical claims");
      expect(question.instructions).toContain("Leave ambiguous references unresolved");
      if (question.type !== "choice") throw new Error("Expected a Choice question");
      expect(question.criteria.keep).toContain("even without a formal relationship declaration");
      expect(question.criteria.reject).toContain("about a different pair");
      expect(question.criteria.reject).not.toContain("third-party evidence");
    }
    expect(batch!.questions.r0!.instructions).toContain("Friendship falls within ally");
    expect(batch!.questions.r0!.instructions).not.toContain("A supported love interest is sufficient");
    expect(batch!.questions.r1!.instructions).not.toContain("A supported love interest is sufficient");
    expect(batch!.questions.r2!.instructions).toContain("Do not require marriage, sex, exclusivity or reciprocity");
    expect(batch!.questions.r3!.instructions).toContain("antagonistic bonds within enemy");
  }
});

test("co-presence alone does not turn unrelated entities into identity choices", () => {
  const names = ["Darran", "Mara", "Tovin", "New Eridu", "Triple Tiara", "Arima Kinen"];
  const plan = buildCortexArbitrationPlan({ passage: names.join(" met "), characterNames: ["Darran", "Mara"],
    knownEntities: [], gradeExisting: false, graph: {
      entities: names.map((name) => ({ name, type: "concept", confidence: 0.9, aliases: [] })),
      relationships: [], aliases: [],
    } });
  const [batch] = buildArbitrationBatches(plan.input);
  for (const question of Object.values(batch!.questions)) {
    if (question.type !== "choice") throw new Error("Expected a Choice question");
    expect(Object.keys(question.criteria)).toEqual(["keep", "reject", "defer"]);
  }
});
