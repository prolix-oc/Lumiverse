import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import { DEFAULT_CORTEX_CONFIG, getCortexConfig, putCortexConfig } from "../src/services/memory-cortex/config";
import { curateEntityFactsWithLLM, processChunk } from "../src/services/memory-cortex";
import { runHeuristicAnalysis } from "../src/services/memory-cortex/heuristic-analysis";
import * as graph from "../src/services/memory-cortex/entity-graph";
import { getColorMap } from "../src/services/memory-cortex/font-attribution";
import * as decisions from "../src/services/decisions.service";
import type { CortexArbitrationInput, ArbitrationVerdict } from "../src/services/memory-cortex/arbitration";

let reviewSpy: ReturnType<typeof spyOn> | undefined;
function mockDecisionReview(review: (state: CortexArbitrationInput) => ArbitrationVerdict[]) {
  reviewSpy = spyOn(decisions, "evaluateDecisionAnswers").mockImplementation(async (_userId, request) => {
    expect(request.connection_id).toBe("decision-reviewer");
    const verdicts = review(request.state as unknown as CortexArbitrationInput);
    return { issues: [], result: { model: "fixture", answers: Object.fromEntries(verdicts.map((verdict) => {
      const choice = verdict.action === "resolve" ? `resolve_${verdict.canonicalId}` : verdict.action;
      return [verdict.id, { type: "choice" as const, choice, confidence: 1, probabilities: { [choice]: 1 } }];
    })) } };
  });
}
const noGenerativeReview = async () => { throw new Error("Candidate review must not call a generative sidecar"); };

beforeEach(async () => {
  closeDatabase(); initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../src/db/baseline.sql", import.meta.url)).text());
});
afterEach(() => { reviewSpy?.mockRestore(); reviewSpy = undefined; closeDatabase(); });

test("heuristic-only ingestion records a wrapped thought without a sidecar", async () => {
  const config = putCortexConfig("thought-user", { ...DEFAULT_CORTEX_CONFIG, enabled: true,
    consolidation: { ...DEFAULT_CORTEX_CONFIG.consolidation, enabled: false },
  });
  const passage = '[CHARACTER | Mara]: The spoon slipped from my fingers. Kama shoved his head through my collar.\n\n*<font color=#D987FF>A bed. A locked door. My mouth had better catch up before he decides the spoon spoke for me.</font>*\n\nI set the utensil across the rim. Auntie Mei arrived carrying a paper bag.';
  getDb().query("INSERT INTO chats (id, user_id) VALUES ('thought-chat', 'thought-user')").run();
  getDb().query("INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at) VALUES ('thought-chunk', 'thought-chat', 'm1', 'm1', '[]', ?, 20, 1, 1, 1)").run(passage);
  const names = ["Mara", "Kama", "Auntie Mei"];
  const heuristic = runHeuristicAnalysis({ cleanContent: passage, knownEntities: [], characterNames: names, entityWhitelist: [], minConfidence: 0.5, entityExtractionFilters: config.entityExtractionFilters });
  await processChunk({ chunkId: "thought-chunk", chatId: "thought-chat", userId: "thought-user", characterId: null, content: passage, messageIds: [], startMessageIndex: 0, endMessageIndex: 0, createdAt: 1 }, names, undefined, undefined, undefined, heuristic, true);
  expect(getColorMap("thought-chat")).toEqual([expect.objectContaining({ hexColor: "#d987ff", usageType: "thought", sampleCount: 1 })]);
});

for (const { review, endpointAction } of [
  { review: false, endpointAction: "keep" },
  { review: true, endpointAction: "keep" },
  { review: true, endpointAction: "reject" },
  { review: true, endpointAction: "defer" },
] as const) {
  test(`omitted known relationship endpoints honor review=${review} and endpoint verdict ${endpointAction}`, async () => {
    const config = putCortexConfig("relation-user", { ...DEFAULT_CORTEX_CONFIG, enabled: true,
      arbitration: { ...DEFAULT_CORTEX_CONFIG.arbitration, connectionProfileId: "decision-reviewer" },
      sidecarReliability: { ...DEFAULT_CORTEX_CONFIG.sidecarReliability, arbitratesHeuristics: review },
      consolidation: { ...DEFAULT_CORTEX_CONFIG.consolidation, enabled: false },
    });
    const passage = '[CHARACTER | Mara]: Tovin has always been my mentor.';
    getDb().query("INSERT INTO chats (id, user_id) VALUES ('relation-chat', 'relation-user')").run();
    getDb().query("INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at) VALUES ('relation-chunk', 'relation-chat', 'm1', 'm1', '[]', ?, 20, 1, 1, 1)").run(passage);
    const tovin = graph.upsertEntity("relation-chat", { name: "Tovin", type: "character", aliases: ["Tov"], confidence: 1 }, "old", 1);
    const heuristic = runHeuristicAnalysis({ cleanContent: "Quiet weather.", knownEntities: [], characterNames: [], entityWhitelist: [], minConfidence: 0.5, entityExtractionFilters: config.entityExtractionFilters });
    let reviewed = false;
    mockDecisionReview((state) => {
      expect(state.candidates).toContainEqual(expect.objectContaining({ kind: "relationship", source: "Tovin", target: "Mara", type: "mentor" }));
      reviewed = true;
      return state.candidates.map((candidate: any) => ({ id: candidate.id,
        action: candidate.kind === "entity" && candidate.name === "Tovin" ? endpointAction
          : candidate.kind === "relationship" || ["Mara", "Tovin"].includes(candidate.name) ? "keep" : "reject" }));
    });
    await processChunk({ chunkId: "relation-chunk", chatId: "relation-chat", userId: "relation-user", characterId: null, content: passage, messageIds: [], startMessageIndex: 0, endMessageIndex: 0, createdAt: 1 }, ["Mara"], noGenerativeReview, "unused-llm", undefined, heuristic, true, undefined, {
      score: 0.3, emotionalTags: [], narrativeFlags: [], entitiesPresent: [], statusChanges: [], keyFacts: [], discoveredAliases: [], fontColors: [],
      relationshipsShown: [{ source: "Tov", target: "mara", type: "mentor", label: "longstanding mentor", sentiment: 0.5 }],
    });
    const mara = graph.findEntityByName("relation-chat", "Mara")!;
    expect(mara).not.toBeNull();
    expect(getDb().query("SELECT source_entity_id, target_entity_id, relation_type FROM memory_relations WHERE chat_id = 'relation-chat'").all())
      .toEqual(endpointAction === "keep" ? [{ source_entity_id: tovin, target_entity_id: mara.id, relation_type: "mentor" }] : []);
    expect(graph.getEntity(tovin)).not.toBeNull();
    expect(reviewed).toBe(review);
  });
}

for (const aliasAction of ["keep", "reject", "defer"] as const) {
  test(`a relationship follows a new alias only after alias verdict ${aliasAction}`, async () => {
    const config = putCortexConfig("alias-user", { ...DEFAULT_CORTEX_CONFIG, enabled: true,
      arbitration: { ...DEFAULT_CORTEX_CONFIG.arbitration, connectionProfileId: "decision-reviewer" },
      sidecarReliability: { ...DEFAULT_CORTEX_CONFIG.sidecarReliability, arbitratesHeuristics: true },
      consolidation: { ...DEFAULT_CORTEX_CONFIG.consolidation, enabled: false },
    });
    const passage = 'Mara, known as Red, is Tovin’s mentor.';
    getDb().query("INSERT INTO chats (id, user_id) VALUES ('alias-chat', 'alias-user')").run();
    getDb().query("INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at) VALUES ('alias-chunk', 'alias-chat', 'm1', 'm1', '[]', ?, 20, 1, 1, 1)").run(passage);
    const heuristic = runHeuristicAnalysis({ cleanContent: "Quiet weather.", knownEntities: [], characterNames: [], entityWhitelist: [], minConfidence: 0.5, entityExtractionFilters: config.entityExtractionFilters });
    mockDecisionReview((state) => {
      expect(state.candidates).toContainEqual(expect.objectContaining({ kind: "relationship", source: "Red", target: "Tovin" }));
      return state.candidates.map((candidate: any) => ({ id: candidate.id,
        action: candidate.kind === "alias" ? aliasAction : candidate.kind === "relationship" || ["Mara", "Tovin"].includes(candidate.name) ? "keep" : "reject" }));
    });
    await processChunk({ chunkId: "alias-chunk", chatId: "alias-chat", userId: "alias-user", characterId: null, content: passage, messageIds: [], startMessageIndex: 0, endMessageIndex: 0, createdAt: 1 }, ["Mara", "Tovin"], noGenerativeReview, "unused-llm", undefined, heuristic, true, undefined, {
      score: 0.3, emotionalTags: [], narrativeFlags: [], entitiesPresent: [{ name: "Mara", type: "character" }], statusChanges: [], keyFacts: [], fontColors: [],
      discoveredAliases: [{ canonicalName: "Mara", alias: "Red", evidence: "Mara, known as Red" }],
      relationshipsShown: [{ source: "Red", target: "Tovin", type: "mentor", label: "mentor", sentiment: 0.5 }],
    });
    const relations = getDb().query("SELECT source_entity_id, target_entity_id, relation_type FROM memory_relations WHERE chat_id = 'alias-chat'").all();
    expect(relations).toEqual(aliasAction === "keep" ? [{ source_entity_id: graph.findEntityByName("alias-chat", "Mara")!.id,
      target_entity_id: graph.findEntityByName("alias-chat", "Tovin")!.id, relation_type: "mentor" }] : []);
  });
}

for (const entityAction of ["keep", "reject"] as const) {
  test(`color claims for a newly discovered character follow its ${entityAction} identity verdict`, async () => {
    const config = putCortexConfig("new-color-user", { ...DEFAULT_CORTEX_CONFIG, enabled: true,
      arbitration: { ...DEFAULT_CORTEX_CONFIG.arbitration, connectionProfileId: "decision-reviewer" },
      sidecarReliability: { ...DEFAULT_CORTEX_CONFIG.sidecarReliability, arbitratesHeuristics: true },
      consolidation: { ...DEFAULT_CORTEX_CONFIG.consolidation, enabled: false },
    });
    const passage = 'Selene thought: *<font color=#abc>My secret is safe.</font>*';
    getDb().query("INSERT INTO chats (id, user_id) VALUES ('new-color-chat', 'new-color-user')").run();
    getDb().query("INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at) VALUES ('new-color-chunk', 'new-color-chat', 'm1', 'm1', '[]', ?, 20, 1, 1, 1)").run(passage);
    const heuristic = runHeuristicAnalysis({ cleanContent: "Quiet weather.", knownEntities: [], characterNames: [], entityWhitelist: [], minConfidence: 0.5, entityExtractionFilters: config.entityExtractionFilters });
    mockDecisionReview((state) => {
      expect(state.candidates).toContainEqual(expect.objectContaining({ kind: "color", name: "Selene", type: "thought" }));
      return state.candidates.map((candidate: any) => ({ id: candidate.id,
        action: candidate.kind === "color" ? "keep" : candidate.name === "Selene" ? entityAction : "reject" }));
    });
    await processChunk({ chunkId: "new-color-chunk", chatId: "new-color-chat", userId: "new-color-user", characterId: null, content: passage, messageIds: [], startMessageIndex: 0, endMessageIndex: 0, createdAt: 1 }, [], noGenerativeReview, "unused-llm", undefined, heuristic, true, undefined, {
      score: 0.3, emotionalTags: [], narrativeFlags: [], entitiesPresent: [{ name: "Selene", type: "character" }], statusChanges: [], keyFacts: [], discoveredAliases: [], relationshipsShown: [],
      fontColors: [{ hexColor: "#abc", characterName: "Selene", usageType: "thought" }],
    });
    expect(getColorMap("new-color-chat")).toHaveLength(entityAction === "keep" ? 1 : 0);
  });
}

for (const action of ["keep", "reject", "defer"] as const) {
  test(`ingestion explicitly reviews colored thoughts and applies ${action} without double counting`, async () => {
    const config = putCortexConfig("color-user", { ...DEFAULT_CORTEX_CONFIG, enabled: true,
      arbitration: { ...DEFAULT_CORTEX_CONFIG.arbitration, connectionProfileId: "decision-reviewer" },
      sidecarReliability: { ...DEFAULT_CORTEX_CONFIG.sidecarReliability, arbitratesHeuristics: true },
      consolidation: { ...DEFAULT_CORTEX_CONFIG.consolidation, enabled: false },
    });
    const passage = '[CHARACTER | Mara]\n*<font color=#abc>"I must keep going."</font>* *<font color=#abc>"I cannot turn back."</font>*';
    getDb().query("INSERT INTO chats (id, user_id) VALUES ('color-chat', 'color-user')").run();
    getDb().query("INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at) VALUES ('color-chunk', 'color-chat', 'm1', 'm1', '[]', ?, 20, 1, 1, 1)").run(passage);
    const heuristic = runHeuristicAnalysis({ cleanContent: passage, knownEntities: [], characterNames: ["Mara"], entityWhitelist: [], minConfidence: 0.5, entityExtractionFilters: config.entityExtractionFilters });
    let reviewedColors = 0;
    mockDecisionReview((state) => {
      const colors = state.candidates.filter((candidate: any) => candidate.kind === "color");
      reviewedColors += colors.length;
      expect(colors).toHaveLength(1);
      expect(colors[0]).toMatchObject({ name: "Mara", hexColor: "#aabbcc", type: "thought" });
      expect(colors[0].evidence.join(" ")).toContain("<font color=#abc>");
      return state.candidates.map((candidate: any) => ({ id: candidate.id, action: candidate.kind === "color" ? action : "keep" }));
    });
    await processChunk({ chunkId: "color-chunk", chatId: "color-chat", userId: "color-user", characterId: null, content: passage, messageIds: [], startMessageIndex: 0, endMessageIndex: 0, createdAt: 1 }, ["Mara"], noGenerativeReview, "unused-llm", undefined, heuristic, true, undefined, {
      score: 0.3, emotionalTags: [], narrativeFlags: [], entitiesPresent: [{ name: "Mara", type: "character" }],
      statusChanges: [], keyFacts: [], relationshipsShown: [], discoveredAliases: [], fontColors: [
        { hexColor: "#abc", characterName: "Mara", usageType: "thought" },
        { hexColor: "#123456", characterName: "Mara", usageType: "thought" },
        { hexColor: "#abc", characterName: "Mara", usageType: "speech" },
      ],
    });
    expect(reviewedColors).toBe(1);
    const colors = getColorMap("color-chat");
    expect(colors).toHaveLength(action === "keep" ? 1 : 0);
    if (action === "keep") expect(colors[0]).toMatchObject({ hexColor: "#aabbcc", usageType: "thought", sampleCount: 1 });
  });
}

test("automatic cleanup preserves an unedited endpoint of a manually edited relationship", () => {
  const first = graph.upsertEntity("chat", { name: "Mara", type: "character", aliases: [], confidence: 1 }, "chunk", 1);
  const second = graph.upsertEntity("chat", { name: "Tovin", type: "character", aliases: [], confidence: 1 }, "chunk", 1);
  getDb().query("INSERT INTO memory_relations (id, chat_id, source_entity_id, target_entity_id, relation_type, user_edited_at, created_at, updated_at) VALUES ('edited', 'chat', ?, ?, 'ally', 1, 1, 1)").run(first, second);
  expect(graph.deleteEntityIfNotUserEdited(first)).toBe(false);
  expect(graph.getEntity(first)).not.toBeNull();
  expect(getDb().query("SELECT id FROM memory_relations WHERE id = 'edited'").get()).not.toBeNull();
});

test("fact curation sees overflow and preserves host-owned tags and source evidence", async () => {
  const id = graph.upsertEntity("chat", { name: "Mara", type: "character", aliases: [], confidence: 1 }, "chunk", 1);
  graph.addEntityFacts(id, ["Mara swore an oath."], "branch-a", 9, 2, { chunkId: "old", evidence: "Mara swore an oath." });
  const initial = graph.getEntity(id)!;
  const candidates = graph.mergeEntityFactCandidates(initial.facts, ["Mara found a key.", "Mara went for a walk."], null, 3);
  graph.addEntityFacts(id, ["Mara found a key.", "Mara went for a walk."], null, 3, 2);
  expect(graph.getEntity(id)!.facts).toHaveLength(2);
  let calls = 0;
  await curateEntityFactsWithLLM(id, candidates, 2, async (request) => {
    calls++; const prompt = JSON.parse(request.messages[1]!.content);
    expect(prompt.facts).toHaveLength(3);
    expect(prompt.facts[0].importance).toBe(9);
    return { content: '{"indices":[0,1]}' };
  }, "sidecar", DEFAULT_CORTEX_CONFIG, undefined, {
    ...initial.metadata.factEvidence, "mara found a key.": [{ chunkId: "new", evidence: "Mara found a key." }],
  });
  expect(calls).toBe(1);
  const current = graph.getEntity(id)!;
  expect(current.facts).toEqual(["[branch:branch-a] [i:9] Mara swore an oath.", "[i:3] Mara found a key."]);
  expect(current.metadata.factEvidence["mara found a key."][0].chunkId).toBe("new");
});

test("curation does not overwrite a user edit made during its request", async () => {
  const id = graph.upsertEntity("chat", { name: "Mara", type: "character", aliases: [], confidence: 1 }, "chunk", 1);
  graph.addEntityFacts(id, ["Mara found the key."], null, 7, 1);
  await curateEntityFactsWithLLM(id, ["Mara found the key.", "Mara returned home."], 1, async () => {
    getDb().query("UPDATE memory_entities SET user_edited_at = 2, facts = ? WHERE id = ?").run('["Manually curated fact"]', id);
    return { content: '{"indices":[1]}' };
  }, "sidecar", DEFAULT_CORTEX_CONFIG);
  expect(graph.getEntity(id)!.facts).toEqual(["Manually curated fact"]);
});

test("ingestion curation includes overflow facts and status changes from the same chunk", async () => {
  const config = putCortexConfig("facts-user", { ...DEFAULT_CORTEX_CONFIG, enabled: true,
    factManagement: { maxFactsPerEntity: 5, importanceThreshold: 0, autopilot: true },
    consolidation: { ...DEFAULT_CORTEX_CONFIG.consolidation, enabled: false },
  });
  const passage = "Mara found the key before she died.";
  getDb().query("INSERT INTO chats (id, user_id) VALUES ('facts-chat', 'facts-user')").run();
  getDb().query("INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at) VALUES ('facts-chunk', 'facts-chat', 'm1', 'm1', '[]', ?, 20, 1, 1, 1)").run(passage);
  const id = graph.upsertEntity("facts-chat", { name: "Mara", type: "character", aliases: [], confidence: 1 }, "old", 1);
  graph.addEntityFacts(id, Array.from({ length: 5 }, (_, index) => `Mara kept promise ${index}.`), null, 7, 5);
  const heuristic = runHeuristicAnalysis({ cleanContent: passage, knownEntities: [], characterNames: ["Mara"], entityWhitelist: [], minConfidence: 0.5, entityExtractionFilters: config.entityExtractionFilters });
  let calls = 0;
  await processChunk({ chunkId: "facts-chunk", chatId: "facts-chat", userId: "facts-user", characterId: null, content: passage, messageIds: [], startMessageIndex: 0, endMessageIndex: 0, createdAt: 1 }, ["Mara"], async (request) => {
    calls++;
    expect(request.requestPurpose).toBe("fact curation");
    const input = JSON.parse(request.messages[1]!.content);
    expect(input.facts).toHaveLength(7);
    expect(input.facts[6].text).toBe("died: Mara died after finding the key.");
    return { content: '{"indices":[0,1,2,5,6]}' };
  }, "sidecar", undefined, heuristic, true, undefined, {
    score: 0.9, emotionalTags: [], narrativeFlags: [], entitiesPresent: [{ name: "Mara", type: "character" }],
    statusChanges: [{ entity: "Mara", change: "died", detail: "Mara died after finding the key." }],
    keyFacts: ["Mara found the key."], relationshipsShown: [], discoveredAliases: [], fontColors: [],
  });
  expect(calls).toBe(1);
  expect(graph.getEntity(id)!.facts.map(graph.stripFactTags)).toContain("died: Mara died after finding the key.");
});

test("partial arbitration updates preserve the selected connection and model", () => {
  putCortexConfig("config-user", { ...DEFAULT_CORTEX_CONFIG, arbitration: {
    ...DEFAULT_CORTEX_CONFIG.arbitration, backend: "decision", connectionProfileId: "decision-a", model: "model-a",
  } });
  putCortexConfig("config-user", { arbitration: { minConfidence: 0.9 } as any });
  expect(getCortexConfig("config-user").arbitration).toMatchObject({ backend: "decision", connectionProfileId: "decision-a", model: "model-a", minConfidence: 0.9 });
});

for (const change of ["source", "config"] as const) {
  test(`a ${change} edit during review prevents stale persistence`, async () => {
    const config = putCortexConfig("user", { ...DEFAULT_CORTEX_CONFIG, enabled: true,
      arbitration: { ...DEFAULT_CORTEX_CONFIG.arbitration, connectionProfileId: "decision-reviewer" },
      sidecarReliability: { ...DEFAULT_CORTEX_CONFIG.sidecarReliability, arbitratesHeuristics: true },
      consolidation: { ...DEFAULT_CORTEX_CONFIG.consolidation, enabled: false },
    });
    const passage = 'Mara said, "I promise to return."';
    getDb().query("INSERT INTO chats (id, user_id) VALUES ('chat', 'user')").run();
    getDb().query("INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at) VALUES ('chunk', 'chat', 'm1', 'm1', '[]', ?, 20, 1, 1, 1)").run(passage);
    const heuristic = runHeuristicAnalysis({ cleanContent: passage, knownEntities: [], characterNames: ["Mara"], entityWhitelist: [], minConfidence: 0.5, entityExtractionFilters: config.entityExtractionFilters });
    let reviewed = false;
    mockDecisionReview((state) => {
      reviewed = true;
      if (change === "source") getDb().query("UPDATE chat_chunks SET content = 'Revised text' WHERE id = 'chunk'").run();
      else putCortexConfig("user", { arbitration: { ...config.arbitration, minConfidence: 0.95 } });
      return state.candidates.map((c: any) => ({ id: c.id, action: "keep" }));
    });
    await processChunk({ chunkId: "chunk", chatId: "chat", userId: "user", characterId: null, content: passage, messageIds: [], startMessageIndex: 0, endMessageIndex: 0, createdAt: 1 }, ["Mara"], noGenerativeReview, "unused-llm", undefined, heuristic, true);
    expect(reviewed).toBe(true);
    expect(graph.getEntities("chat")).toEqual([]);
    expect(getDb().query("SELECT id FROM memory_salience").all()).toEqual([]);
    expect((getDb().query("SELECT cortex_warmup_signature FROM chat_chunks WHERE id = 'chunk'").get() as any).cortex_warmup_signature).toBeNull();
  });
}
