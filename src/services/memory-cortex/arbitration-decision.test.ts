import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { evaluateDecision, evaluateDecisionAnswers } from "../decisions.service";
import * as secrets from "../secrets.service";
import { ProviderRequestError } from "../../utils/provider-errors";
import { arbitrateCortexCandidates, type CortexArbitrationInput } from "./arbitration";
import { DEFAULT_CORTEX_CONFIG, normalizeCortexConfig, putCortexConfig } from "./config";
import { normalizeCharacterName, processChunk, rebuildCortex } from "./index";
import { runHeuristicAnalysis } from "./heuristic-analysis";
import * as graph from "./entity-graph";

const originalFetch = globalThis.fetch;
const originalDebug = process.env.LUMIVERSE_CORTEX_DEBUG;
const userId = "decision-recovery-user";
const profileId = "decision-recovery-profile";
const config = normalizeCortexConfig({ ...DEFAULT_CORTEX_CONFIG, enabled: true,
  consolidation: { ...DEFAULT_CORTEX_CONFIG.consolidation, enabled: false },
  sidecarReliability: { ...DEFAULT_CORTEX_CONFIG.sidecarReliability, arbitratesHeuristics: true, gradesExistingRecords: true },
  arbitration: { ...DEFAULT_CORTEX_CONFIG.arbitration, backend: "decision", connectionProfileId: profileId, timeoutMs: 100 },
});
const input: CortexArbitrationInput = { passage: "Mara returned; Tovin waited.", canonicals: [], candidates: [
  { id: "e0", kind: "entity", name: "Mara" },
  { id: "x3", kind: "existing", name: "Tovin" },
] };
let secretSpy: ReturnType<typeof spyOn>;
let requests: any[];

beforeEach(async () => {
  delete process.env.LUMIVERSE_CORTEX_DEBUG;
  closeDatabase(); initDatabase(":memory:");
  const db = getDb(); db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(new URL("../../db/baseline.sql", import.meta.url)).text());
  db.query("INSERT INTO decision_connections (id, user_id, name, provider, model, has_api_key, created_at, updated_at) VALUES (?, ?, 'Recovery test', 'openrouter', 'fixture-model', 1, 1, 1)").run(profileId, userId);
  secretSpy = spyOn(secrets, "getSecret").mockImplementation(async () => "fixture-key");
  requests = [];
});
afterEach(() => {
  if (originalDebug === undefined) delete process.env.LUMIVERSE_CORTEX_DEBUG;
  else process.env.LUMIVERSE_CORTEX_DEBUG = originalDebug;
  globalThis.fetch = originalFetch; secretSpy.mockRestore(); closeDatabase();
});

/** Local fetch fixture exercises the native adapter, service, and Cortex gate. */
function provider(respond: (body: any, attempt: number, signal: AbortSignal) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: any, init: any) => {
    expect(String(url)).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(init.headers.Authorization).toBe("Bearer fixture-key");
    const body = JSON.parse(init.body);
    requests.push(body);
    return respond(body, requests.length, init.signal);
  }) as typeof fetch;
}
function response(body: any, invalid: (id: string, candidate: any) => boolean = () => false) {
  return { model: body.model, answers: Object.fromEntries(Object.entries(body.questions).map(([id, raw]) => {
    const question = raw as any;
    const candidate = body.state.candidates.find((entry: any) => entry.id === id);
    const choice = candidate.kind === "existing" ? "reject" : "keep";
    const keys = Object.keys(question.criteria);
    const other = (1 - 0.98) / (keys.length - 1);
    return [id, { type: "choice", choice, confidence: 0.98,
      probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 0.98 : invalid(id, candidate) ? 0.4 : other])) }];
  })) };
}
const evaluate = (signal?: AbortSignal) => arbitrateCortexCandidates({ userId, config, input, signal });

test("an unselected reviewer stays unused even when a default Decision connection exists", async () => {
  getDb().query("UPDATE decision_connections SET is_default = 1 WHERE id = ?").run(profileId);
  const unconfigured = putCortexConfig(userId, { ...config,
    arbitration: { ...config.arbitration, connectionProfileId: null, model: null },
  });
  expect(unconfigured.sidecarReliability.arbitratesHeuristics).toBe(true);
  expect(unconfigured.arbitration.connectionProfileId).toBeNull();
  provider(() => { throw new Error("Unconfigured review must not start inference"); });
  await expect(arbitrateCortexCandidates({ userId, config: unconfigured, input })).rejects.toThrow("Select a Decision arbitration connection");
  const chatId = "unconfigured-review-chat";
  const passage = "Mara returned home.";
  const db = getDb();
  db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run(chatId, userId);
  db.query("INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at) VALUES ('unconfigured-chunk', ?, 'm1', 'm1', '[]', ?, 20, 1, 1, 1)").run(chatId, passage);
  const heuristic = runHeuristicAnalysis({ cleanContent: passage, knownEntities: [], characterNames: ["Mara"], entityWhitelist: [], minConfidence: 0.5, entityExtractionFilters: config.entityExtractionFilters });
  await processChunk({ chunkId: "unconfigured-chunk", chatId, userId, characterId: null, content: passage, messageIds: [], startMessageIndex: 0, endMessageIndex: 0, createdAt: 1 },
    ["Mara"], undefined, undefined, undefined, heuristic, true);
  expect(requests).toEqual([]);
  expect(db.query("SELECT id FROM memory_salience WHERE chunk_id = 'unconfigured-chunk'").get()).not.toBeNull();
  expect((db.query("SELECT cortex_warmup_signature FROM chat_chunks WHERE id = 'unconfigured-chunk'").get() as any).cortex_warmup_signature).not.toBeNull();
});

for (const verdict of ["keep", "reject", "defer", "low-confidence"] as const) {
  test(`sidecar rebuild proposes omitted first-person romance to native Decision review: ${verdict}`, async () => {
    const chatId = "romance-rebuild-chat";
    const db = getDb();
    putCortexConfig(userId, { ...config, entityExtractionMode: "sidecar", salienceScoringMode: "sidecar",
      sidecar: { ...config.sidecar, connectionProfileId: "sidecar", model: "fixture-sidecar", chunkBatchSize: 2, rebuildConcurrency: 1 },
      queryGeneration: { primary: { connectionProfileId: "sidecar", model: "fixture-sidecar" }, secondary: null },
      sidecarReliability: { ...config.sidecarReliability, gradesExistingRecords: false },
    });
    db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run(chatId, userId);
    db.query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content) VALUES ('romance-user', ?, 0, 1, 'Prolix', 'Shall we walk?')").run(chatId);
    const texts = ['"I have a crush on you. I want to date you," I said.', '"I will stay in your room tonight."'];
    for (let index = 0; index < texts.length; index++) {
      const id = `romance-${index}`;
      db.query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content) VALUES (?, ?, ?, 0, 'Mara', ?)")
        .run(id, chatId, index + 1, texts[index]!);
      db.query("INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, message_range_start, message_range_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 20, 1, ?, ?, 1, 1)")
        .run(id, chatId, id, id, JSON.stringify([id]), texts[index]!, index + 1, index + 1);
    }
    let extractionCalls = 0;
    provider((body) => {
      expect(body.state.participants).toContainEqual({ name: "Mara", role: "character" });
      expect(body.state.participants).toContainEqual({ name: "Prolix", role: "user" });
      const value = response(body);
      for (const [id, answer] of Object.entries(value.answers)) {
        const candidate = body.state.candidates.find((entry: any) => entry.id === id);
        const relationship = candidate.kind === "relationship";
        if (relationship) {
          expect(candidate).toMatchObject({ source: "Mara", target: "Prolix", type: "lover" });
          expect(candidate.evidence.join(" ")).toContain("I have a crush on you");
          expect(body.questions[id].instructions).toContain("A supported love interest is sufficient");
        }
        answer.choice = relationship && verdict !== "low-confidence" ? verdict
          : candidate.kind === "entity" && !["Mara", "Prolix"].includes(candidate.name) ? "reject" : "keep";
        if (relationship && verdict === "low-confidence") answer.confidence = 0.7;
        const keys = Object.keys(answer.probabilities);
        answer.probabilities = Object.fromEntries(keys.map((key) => [key, key === answer.choice ? 0.98 : 0.02 / (keys.length - 1)]));
      }
      return Response.json(value);
    });
    const result = await rebuildCortex(userId, chatId, ["Mara", "Prolix"], async (request) => {
      extractionCalls++;
      expect(request.requestPurpose).toBe("batch extraction");
      expect(request.messages[0]!.content).toContain("A love interest is a relationship even before a formal partnership");
      expect(request.messages[1]!.content).toContain('"name":"Prolix","role":"user"');
      // Reproduce the reported omission instead of supplying a relationship
      // fixture. The real ingestion path must discover and review the proposal.
      return { content: JSON.stringify({ results: texts.map((_, index) => ({ index, importance: 3,
        emotional_tones: [], narrative_flags: [], key_facts: [], entities_present: [], relationships_shown: [],
        status_changes: [], color_attributions: [], discovered_aliases: [],
      })) }) };
    }, "sidecar");
    expect(extractionCalls).toBe(1);
    expect(requests.flatMap((request) => request.state.candidates).filter((candidate: any) => candidate.kind === "relationship")).toHaveLength(1);
    const relations = graph.getRelationsIncludingInactive(chatId);
    expect(result.relationsFound).toBe(verdict === "keep" ? 1 : 0);
    expect(relations).toHaveLength(verdict === "keep" ? 1 : 0);
    if (verdict === "keep") expect(relations[0]).toMatchObject({ relationType: "lover",
      sourceEntityId: graph.findEntityByName(chatId, "Mara")!.id, targetEntityId: graph.findEntityByName(chatId, "Prolix")!.id });
    expect(result.chunksProcessed).toBe(2);
  });
}

test("valid Decision answers need only one provider request", async () => {
  provider((body) => Response.json(response(body)));
  expect((await evaluate()).verdicts.map((verdict) => verdict.action)).toEqual(["keep", "reject"]);
  expect(requests).toHaveLength(1);
});

for (const [mode, debug] of [["live", false], ["live", true], ["rebuild", false], ["rebuild", true]] as const) {
  test(`${mode} preserves Still in Love's full participant identity and trainer relationship (debug=${debug})`, async () => {
    if (debug) process.env.LUMIVERSE_CORTEX_DEBUG = "1";
    const chatId = `complete-character-name-${mode}`;
    const chunkId = `${chatId}-chunk`;
    const characterName = "Still in Love";
    const cardName = "Still in Love - Veil of Reason and Instinct";
    const characterNames = [normalizeCharacterName(cardName), normalizeCharacterName("Darran")];
    const passage = "Darran agreed to be Still's trainer.";
    const db = getDb();
    putCortexConfig(userId, { ...config, entityExtractionMode: "sidecar", salienceScoringMode: "sidecar",
      sidecar: { ...config.sidecar, connectionProfileId: "sidecar", chunkBatchSize: 2, rebuildConcurrency: 1 },
      queryGeneration: { primary: { connectionProfileId: "sidecar", model: null }, secondary: null },
      sidecarReliability: { ...config.sidecarReliability, gradesExistingRecords: false },
    });
    db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run(chatId, userId);
    db.query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content) VALUES (?, ?, 0, 0, ?, ?)")
      .run(`${chatId}-author`, chatId, cardName, passage);
    db.query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content) VALUES (?, ?, 1, 1, 'Darran', 'Agreed.')")
      .run(`${chatId}-user`, chatId);
    db.query("INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 20, 1, 1, 1)")
      .run(chunkId, chatId, `${chatId}-author`, `${chatId}-author`, JSON.stringify([`${chatId}-author`]), passage);
    if (mode === "rebuild") {
      db.query("INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 20, 1, 2, 1)")
        .run(`${chunkId}-2`, chatId, `${chatId}-author`, `${chatId}-author`, JSON.stringify([`${chatId}-author`]), passage);
      // Rebuilds must replace the clipped identity left by the old cleaner.
      graph.upsertEntity(chatId, { name: "Still", type: "character", aliases: [], confidence: 1 }, chunkId, 1);
    }
    provider((body) => {
      expect(body.state.participants).toContainEqual({ name: characterName, role: "character" });
      expect(body.state.canonicals.some((canonical: any) => canonical.name === "Still")).toBe(false);
      expect(body.state.candidates.filter((candidate: any) => candidate.kind === "entity").map((candidate: any) => candidate.name)).not.toContain(cardName);
      const value = response(body);
      for (const [id, answer] of Object.entries(value.answers)) {
        const candidate = body.state.candidates.find((entry: any) => entry.id === id);
        answer.choice = (candidate.kind === "entity" && ![characterName, "Darran"].includes(candidate.name))
          || (candidate.kind === "relationship" && candidate.type !== "mentor") ? "reject" : "keep";
        const keys = Object.keys(answer.probabilities);
        answer.probabilities = Object.fromEntries(keys.map((key) => [key, key === answer.choice ? 0.98 : 0.02 / (keys.length - 1)]));
      }
      return Response.json(value);
    });
    const fact = "Darran agreed to be Still in Love's trainer.";
    const extraction = { importance: 6, emotional_tones: [], narrative_flags: [], key_facts: [fact, "Unrelated arrived in the harbor."],
      // Models sometimes copy the author label despite the canonical-name hint.
      entities_present: [{ name: cardName, type: "character" }, { name: "Darran", type: "character" }],
      relationships_shown: [{ source: "Darran", target: cardName, type: "mentor", label: "trainer", sentiment: 0.5 }],
      discovered_aliases: [{ canonical_name: characterName, alias: "Still", evidence: passage }],
      status_changes: [], color_attributions: [],
    };
    const generate = async (request: any) => {
      expect(request.messages[1].content).toContain(`${cardName.toLowerCase()} → ${characterName}`);
      expect(request.messages[0].content).toContain("Write the relevant canonical entity names explicitly");
      return { content: JSON.stringify(mode === "rebuild" ? { results: [0, 1].map((index) => ({ index, ...extraction })) } : extraction) };
    };
    const lines: string[] = [];
    const info = spyOn(console, "info").mockImplementation((message) => { lines.push(String(message)); });
    try {
      if (mode === "rebuild") await rebuildCortex(userId, chatId, characterNames, generate, "sidecar");
      else await processChunk({ chunkId, chatId, userId, characterId: null, content: passage,
        messageIds: [`${chatId}-author`], startMessageIndex: 0, endMessageIndex: 0, createdAt: 1 }, characterNames, generate, "sidecar", undefined, undefined, true);
    } finally { info.mockRestore(); }
    if (debug) {
      const factLog = lines.find((line) => line.startsWith("[memory-cortex] fact_attribution"))!;
      expect(factLog).toContain("proposed=2 matched=1 unmatched=1 importance=6 threshold=3 applied_links=2");
      expect(factLog).not.toContain(characterName);
      const relationshipLog = lines.find((line) => line.startsWith("[memory-cortex] relationship_review"))!;
      expect(relationshipLog).toContain('"action":"keep"');
      expect(relationshipLog).not.toContain(characterName);
    } else {
      const summaries = lines.filter((line) => line.startsWith("[memory-cortex] review "));
      expect(summaries).toHaveLength(mode === "rebuild" ? 2 : 1);
      expect(summaries.every((line) => line.length < 180 && /keep=\d+ resolve=\d+ reject=\d+ defer=\d+/.test(line))).toBe(true);
      expect(lines.some((line) => /entity_review|relationship_review|fact_attribution|arbitration backend=| → | ← /.test(line))).toBe(false);
    }
    expect(requests.length).toBeGreaterThan(0);
    const entities = graph.getEntities(chatId);
    expect(entities.map((entity) => entity.name).sort()).toEqual(["Darran", characterName]);
    const character = entities.find((entity) => entity.name === characterName)!;
    expect(character.aliases).toContain("Still");
    expect(graph.findEntityByName(chatId, "Still")?.id).toBe(character.id);
    expect(character.facts.map(graph.stripFactTags)).toContain(fact);
    expect(character.facts.join(" ")).not.toContain("Unrelated arrived");
    expect(graph.getRelationsIncludingInactive(chatId)).toEqual([expect.objectContaining({
      sourceEntityId: graph.findEntityByName(chatId, "Darran")!.id,
      targetEntityId: character.id, relationType: "mentor",
    })]);
  });
}

for (const mode of ["live", "rebuild"] as const) {
  test(`${mode} sidecar ingestion retains characters by short name alongside every entity category`, async () => {
    const chatId = `entity-identity-${mode}`;
    const db = getDb();
    putCortexConfig(userId, { ...config, entityExtractionMode: "sidecar", salienceScoringMode: "sidecar",
      sidecar: { ...config.sidecar, connectionProfileId: "sidecar", chunkBatchSize: 2, rebuildConcurrency: 1 },
      queryGeneration: { primary: { connectionProfileId: "sidecar", model: null }, secondary: null },
      sidecarReliability: { ...config.sidecarReliability, gradesExistingRecords: false },
    });
    const passage = "Pulchra carried Dawnbreaker through New Eridu. Azure Guard honored the Silver Oath after the Black Tide Incident.";
    const extracted = [
      { name: "Pulchra", type: "character" }, { name: "Dawnbreaker", type: "item" },
      { name: "New Eridu", type: "location" }, { name: "Azure Guard", type: "faction" },
      { name: "Silver Oath", type: "concept" }, { name: "Black Tide Incident", type: "event" },
    ];
    db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run(chatId, userId);
    const chunkCount = mode === "rebuild" ? 2 : 1;
    for (let i = 0; i < chunkCount; i++) {
      db.query("INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at) VALUES (?, ?, 'm1', 'm1', '[]', ?, 40, 1, ?, 1)")
        .run(`${chatId}-${i}`, chatId, passage, i + 1);
    }
    provider((body) => {
      const value = response(body);
      const canonical = body.state.canonicals.find((c: any) => c.name === "Pulchra Fellini");
      expect(canonical?.nameParts).toContain("Pulchra");
      for (const [id, answer] of Object.entries(value.answers)) {
        const candidate = body.state.candidates.find((c: any) => c.id === id);
        expect(body.questions[id].instructions).toContain("A single clear mention is sufficient");
        answer.choice = candidate.name === "Pulchra" ? `resolve_${canonical.id}`
          : candidate.kind === "entity" && ["Pulchra Fellini", ...extracted.map((e) => e.name)].includes(candidate.name) ? "keep" : "reject";
        const keys = Object.keys(answer.probabilities);
        answer.probabilities = Object.fromEntries(keys.map((key) => [key, key === answer.choice ? 0.98 : 0.02 / (keys.length - 1)]));
      }
      return Response.json(value);
    });
    const extraction = { importance: 6, emotional_tones: [], narrative_flags: [], key_facts: [],
      entities_present: extracted, relationships_shown: [], status_changes: [], color_attributions: [], discovered_aliases: [] };
    let sidecarCalls = 0;
    const generate = async (request: any) => {
      sidecarCalls++;
      expect(request.messages[0].content).toContain("A single clear mention is sufficient");
      return { content: JSON.stringify(mode === "live" ? extraction
        : { results: [0, 1].map((index) => ({ index, ...extraction })) }) };
    };
    if (mode === "rebuild") await rebuildCortex(userId, chatId, ["Pulchra Fellini"], generate, "sidecar");
    else await processChunk({ chunkId: `${chatId}-0`, chatId, userId, characterId: null, content: passage,
      messageIds: [], startMessageIndex: 0, endMessageIndex: 0, createdAt: 1 }, ["Pulchra Fellini"], generate, "sidecar", undefined, undefined, true);
    expect(sidecarCalls).toBe(1);
    const entities = graph.getEntities(chatId);
    expect(entities).toHaveLength(6);
    const character = entities.find((entity) => entity.name === "Pulchra Fellini")!;
    expect(character).toMatchObject({ entityType: "character", confidence: "confirmed" });
    expect(db.query("SELECT chunk_id FROM memory_mentions WHERE entity_id = ?").all(character.id)).toHaveLength(chunkCount);
    expect(entities.map((entity) => entity.entityType).sort()).toEqual(["character", "concept", "event", "faction", "item", "location"]);
    expect(db.query("SELECT id FROM chat_chunks WHERE chat_id = ? AND cortex_warmup_signature IS NULL").all(chatId)).toEqual([]);
  });
}

test("a local server context rejection splits questions and their state without losing evidence", async () => {
  const detailed: CortexArbitrationInput = { ...input, canonicals: [
    { id: "c0", name: "Mara", aliases: ["Red"] }, { id: "c1", name: "Tovin", aliases: ["Blue"] },
  ], candidates: [
    { id: "e0", kind: "entity", name: "Red", canonicalIds: ["c0"], evidence: ["Red is Mara."] },
    { id: "x3", kind: "existing", name: "Blue", canonicalIds: ["c1"], evidence: ["Blue is Tovin."] },
  ] };
  provider((body) => Object.keys(body.questions).length > 1
    ? Response.json({ error: { message: "the questions take 16500 tokens, more than the 16384 this model reads", code: "BadRequestError" } }, { status: 400 })
    : Response.json(response(body)));
  const result = await arbitrateCortexCandidates({ userId, config, input: detailed });
  expect(result.verdicts.map((verdict) => verdict.id)).toEqual(["e0", "x3"]);
  expect(requests.map((request) => Object.keys(request.questions))).toEqual([["e0", "x3"], ["e0"], ["x3"]]);
  expect(requests[1].state.candidates).toEqual([detailed.candidates[0]]);
  expect(requests[2].state.candidates).toEqual([detailed.candidates[1]]);
  expect(requests[1].state.canonicals.map((c: any) => c.id)).toEqual(["c0"]);
  expect(requests[2].state.canonicals.map((c: any) => c.id)).toEqual(["c1"]);
  expect(requests.every((request) => request.state.passage === detailed.passage)).toBe(true);
});

test("context splitting still retries invalid probabilities and preserves valid judgments", async () => {
  provider((body) => Object.keys(body.questions).length > 1
    ? Response.json({ error: "Context length exceeded" }, { status: 400 })
    : Response.json(response(body, (id) => id === "x3")));
  expect((await evaluate()).verdicts.map((verdict) => verdict.action)).toEqual(["keep", "defer"]);
  expect(requests.map((request) => Object.keys(request.questions))).toEqual([["e0", "x3"], ["e0"], ["x3"], ["x3"]]);
});

test("one oversized candidate fails with actionable guidance and unrelated 400s are not retried", async () => {
  provider(() => Response.json({ error: "the questions take 16500 tokens, more than the 16384 this model reads" }, { status: 400 }));
  await expect(arbitrateCortexCandidates({ userId, config, input: { ...input, candidates: [input.candidates[0]!] } })).rejects.toThrow("Reduce the memory chunk size");
  expect(requests).toHaveLength(1);
  requests = [];
  provider(() => Response.json({ error: "Invalid model configuration" }, { status: 400 }));
  await expect(evaluate()).rejects.toThrow("Invalid model configuration");
  expect(requests).toHaveLength(1);
});

test("retries only invalid questions and recovers their native verdicts", async () => {
  provider((body, attempt) => Response.json(response(body, (id) => attempt === 1 && id === "x3")));
  const result = await evaluate();
  expect(result.verdicts.map((verdict) => verdict.action)).toEqual(["keep", "reject"]);
  expect(requests.map((request) => Object.keys(request.questions))).toEqual([["e0", "x3"], ["x3"]]);
  expect(requests[1].state).toEqual(requests[0].state);
  expect(result.verdicts[1]).toMatchObject({ confidence: 0.98, probability: 0.98 });
});

test("persistent invalid probabilities defer only that candidate without inventing probabilities", async () => {
  provider((body) => Response.json(response(body, (id) => id === "x3")));
  const result = await evaluate();
  expect(result.verdicts[0]).toMatchObject({ id: "e0", action: "keep", probability: 0.98 });
  expect(result.verdicts[1]).toEqual({ id: "x3", action: "defer", deferralReason: "invalid_answer" });
  expect(requests).toHaveLength(2);
});

test("an entirely invalid batch is deferred after one bounded retry", async () => {
  provider((body) => Response.json(response(body, () => true)));
  expect((await evaluate()).verdicts).toEqual([{ id: "e0", action: "defer", deferralReason: "invalid_answer" }, { id: "x3", action: "defer", deferralReason: "invalid_answer" }]);
  expect(requests).toHaveLength(2);
});

test("deferral diagnostics distinguish model uncertainty from the host confidence gate", async () => {
  provider((body) => {
    const value = response(body);
    value.answers.e0.confidence = 0.76;
    value.answers.e0.probabilities = { keep: 0.84, reject: 0.1, defer: 0.06 };
    value.answers.x3.choice = "defer";
    value.answers.x3.probabilities = { keep: 0.01, reject: 0.01, defer: 0.98 };
    return Response.json(value);
  });
  expect((await evaluate()).verdicts).toEqual([
    { id: "e0", action: "defer", modelChoice: "keep", confidence: 0.76, probability: 0.84, deferralReason: "threshold" },
    { id: "x3", action: "defer", modelChoice: "defer", confidence: 0.98, probability: 0.98, deferralReason: "model" },
  ]);
});

for (const debug of [false, true]) test(`entity deferral details are opt-in (debug=${debug})`, async () => {
  if (debug) process.env.LUMIVERSE_CORTEX_DEBUG = "1";
  const chatId = "deferred-entity-chat";
  const chunkId = "deferred-entity-chunk";
  const passage = "Mara returned home.";
  const db = getDb();
  putCortexConfig(userId, config);
  db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run(chatId, userId);
  db.query("INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at) VALUES (?, ?, 'm1', 'm1', '[]', ?, 20, 1, 1, 1)").run(chunkId, chatId, passage);
  const heuristic = runHeuristicAnalysis({ cleanContent: passage, knownEntities: [], characterNames: ["Mara"], entityWhitelist: [], minConfidence: 0.5, entityExtractionFilters: config.entityExtractionFilters });
  provider((body) => {
    const value = response(body);
    for (const answer of Object.values(value.answers)) answer.confidence = 0.76;
    return Response.json(value);
  });
  const lines: string[] = [];
  const info = spyOn(console, "info").mockImplementation((message) => { lines.push(String(message)); });
  try {
    await processChunk({ chunkId, chatId, userId, characterId: null, content: passage, messageIds: [], startMessageIndex: 0, endMessageIndex: 0, createdAt: 1 },
      ["Mara"], undefined, undefined, undefined, heuristic, true);
  } finally { info.mockRestore(); }
  expect(lines.some((line) => line.startsWith("[memory-cortex] review ") && line.includes("defer=1"))).toBe(true);
  if (debug) {
    const line = lines.find((entry) => entry.startsWith("[memory-cortex] entity_review"))!;
    expect(line).toContain(`chunk=${chunkId} threshold=0.8`);
    expect(JSON.parse(line.split("verdicts=")[1]!)).toEqual([
      { id: "e0", action: "defer", model_choice: "keep", confidence: 0.76, probability: 0.98, deferred_by: "threshold" },
    ]);
    expect(line).not.toContain("Mara");
    expect(line).not.toContain("returned home");
  } else {
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("verdicts=");
    expect(lines[0]).not.toContain("Mara");
    expect(lines[0]).not.toContain("returned home");
  }
  expect(graph.getEntities(chatId)).toEqual([]);
});

test("recovered answers still must meet the confidence and selected-probability thresholds", async () => {
  for (const field of ["confidence", "probability"]) {
    requests = [];
    provider((body, attempt) => {
      const value = response(body, (id) => attempt === 1 && id === "x3");
      if (attempt === 2) {
        const answer = value.answers.x3;
        if (field === "confidence") answer.confidence = 0.5;
        else answer.probabilities = { keep: 0.2, reject: 0.6, defer: 0.2 };
      }
      return Response.json(value);
    });
    const result = await evaluate();
    expect(result.verdicts[0].action).toBe("keep");
    expect(result.verdicts[1].action).toBe("defer");
    expect(requests).toHaveLength(2);
  }
});

test("a failed repair request defers its candidates and retains already valid answers", async () => {
  for (const failure of ["http", "envelope", "timeout"]) {
    requests = [];
    provider(async (body, attempt, signal) => {
      if (attempt === 1) return Response.json(response(body, (id) => id === "x3"));
      if (failure === "http") return Response.json({ error: "Temporary failure" }, { status: 503 });
      if (failure === "envelope") return Response.json({ model: body.model, answers: {} });
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    expect((await evaluate()).verdicts.map((verdict) => verdict.action)).toEqual(["keep", "defer"]);
    expect(requests).toHaveLength(2);
  }
});

test("caller cancellation and authentication errors during recovery still abort the chunk", async () => {
  const controller = new AbortController();
  provider((body, attempt) => {
    if (attempt === 2) controller.abort();
    return Response.json(response(body, (id) => attempt === 1 && id === "x3"));
  });
  await expect(evaluate(controller.signal)).rejects.toThrow();
  requests = [];
  provider((body, attempt) => attempt === 1 ? Response.json(response(body, (id) => id === "x3"))
    : Response.json({ error: "Invalid credential" }, { status: 401 }));
  await expect(evaluate()).rejects.toThrow("401");
});

test("an incomplete initial response still fails and a foreign profile cannot be used", async () => {
  provider((body) => Response.json({ model: body.model, answers: {} }));
  await expect(evaluate()).rejects.toThrow("invalid Decision answers");
  expect(requests).toHaveLength(1);
  await expect(evaluateDecisionAnswers("another-user", { state: input.passage, questions: { q: { type: "noul", instructions: "Present?" } }, connection_id: profileId })).rejects.toThrow("not found");
  expect(requests).toHaveLength(1);
});

test("the public Decision service remains strict and preserves the typed error code", async () => {
  provider((body) => Response.json(response(body, (id) => id === "x3")));
  try {
    await evaluateDecision(userId, { connection_id: profileId, state: JSON.parse(JSON.stringify({ candidates: input.candidates })), questions: {
      x3: { type: "choice", instructions: "Retain?", criteria: { keep: null, reject: null, defer: null } },
    } });
    throw new Error("Expected invalid response rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error).toMatchObject({ code: "invalid_decision_response", retryable: true });
    expect((error as Error).message).toContain("sum=1.78");
  }
});

test("an invalid cleanup answer preserves its record while the chunk completes normally", async () => {
  const chatId = "decision-recovery-chat";
  const chunkId = "decision-recovery-chunk";
  const db = getDb();
  putCortexConfig(userId, config);
  db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run(chatId, userId);
  db.query("INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at) VALUES (?, ?, 'm1', 'm1', '[]', ?, 20, 1, 1, 1)").run(chunkId, chatId, input.passage);
  const tovinId = graph.upsertEntity(chatId, { name: "Tovin", type: "character", aliases: [], confidence: 1 }, "previous", 1);
  const heuristic = runHeuristicAnalysis({ cleanContent: input.passage, knownEntities: [], characterNames: ["Mara", "Tovin"], entityWhitelist: [], minConfidence: 0.5, entityExtractionFilters: config.entityExtractionFilters });
  heuristic.entities = [{ name: "Mara", type: "character", aliases: [], confidence: 1, mentionRole: "subject" }];
  heuristic.relationships = [];
  heuristic.aliases = [];
  provider((body) => Response.json(response(body, (_, candidate) => candidate.kind === "existing")));
  await processChunk({ chunkId, chatId, userId, characterId: null, content: input.passage, messageIds: [], startMessageIndex: 0, endMessageIndex: 0, createdAt: 1 },
    ["Mara", "Tovin"], undefined, undefined, undefined, heuristic, true);
  expect(graph.findEntityByName(chatId, "Mara")).not.toBeNull();
  expect(graph.getEntity(tovinId)?.name).toBe("Tovin");
  expect(db.query("SELECT id FROM memory_salience WHERE chunk_id = ?").get(chunkId)).not.toBeNull();
  expect((db.query("SELECT cortex_warmup_signature FROM chat_chunks WHERE id = ?").get(chunkId) as any).cortex_warmup_signature).toBeTruthy();
  expect(requests).toHaveLength(2);
});

for (const mode of ["live", "rebuild"] as const) for (const pov of ["first", "second", "third"] as const) {
  test(`${mode} separates characters sharing a card label in ${pov} person`, async () => {
    const db = getDb();
    const chatId = `shared-card-${mode}-${pov}`;
    const label = "Pulchra Fellini and Jane Doe";
    const names = ["Pulchra Fellini", "Jane Doe", "Darran"];
    const fact = "Darran agreed to train Pulchra Fellini.";
    const janeFact = "Jane Doe repaired the radio.";
    const passage = pov === "first" ? '"I will train Pulchra Fellini," Darran said. "I repaired the radio," Jane Doe replied.'
      : pov === "second" ? 'Darran turned to Pulchra Fellini. "I will train you." Jane Doe showed them the radio she had repaired.'
      : 'Darran agreed to train Pulchra Fellini. Jane Doe repaired the radio.';
    putCortexConfig(userId, { ...config, entityExtractionMode: "sidecar", salienceScoringMode: "sidecar",
      sidecar: { ...config.sidecar, connectionProfileId: "sidecar", chunkBatchSize: 2, rebuildConcurrency: 1 },
      queryGeneration: { primary: { connectionProfileId: "sidecar", model: null }, secondary: null },
      sidecarReliability: { ...config.sidecarReliability, gradesExistingRecords: false },
    });
    db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run(chatId, userId);
    db.query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content) VALUES (?, ?, 0, 0, ?, ?)")
      .run(`${chatId}-author`, chatId, label, passage);
    db.query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content) VALUES (?, ?, 1, 1, 'Darran', 'Agreed.')")
      .run(`${chatId}-user`, chatId);
    const chunkId = `${chatId}-chunk`;
    const count = mode === "live" ? 1 : 2;
    for (let i = 0; i < count; i++) db.query(`INSERT INTO chat_chunks
      (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 40, 1, ?, 1)`)
      .run(i ? `${chunkId}-${i}` : chunkId, chatId, `${chatId}-author`, `${chatId}-author`, JSON.stringify([`${chatId}-author`]), passage, i + 1);
    provider((body) => {
      expect(body.state.canonicals.some((canonical: any) => canonical.name === label)).toBe(false);
      expect(body.state.participants).toContainEqual({ name: "Pulchra Fellini", role: "character", authorLabel: label });
      expect(body.state.participants).toContainEqual({ name: "Jane Doe", role: "character", authorLabel: label });
      const value = response(body);
      for (const [id, answer] of Object.entries(value.answers)) {
        const candidate = body.state.candidates.find((entry: any) => entry.id === id);
        if (candidate.kind === "relationship" && !(candidate.source === "Darran" && candidate.target === "Pulchra Fellini" && candidate.type === "mentor")) answer.choice = "reject";
        if (candidate.kind === "entity" && !names.includes(candidate.name)) {
          const canonical = body.state.canonicals.find((entry: any) => names.includes(entry.name) && entry.name.startsWith(candidate.name + " "));
          answer.choice = canonical && candidate.canonicalIds?.includes(canonical.id) ? `resolve_${canonical.id}` : "reject";
        }
        const keys = Object.keys(answer.probabilities);
        answer.probabilities = Object.fromEntries(keys.map((key) => [key, key === answer.choice ? 0.98 : 0.02 / (keys.length - 1)]));
      }
      return Response.json(value);
    });
    const extraction = async (request: any) => {
      expect(request.messages[0].content).toContain("in any narrative POV");
      expect(request.messages[1].content).toContain('"authorLabel":"' + label + '"');
      const result = { importance: 5, emotional_tones: [], narrative_flags: [], key_facts: [fact, janeFact],
        // Deliberately reproduce the model's combined-name mistake alongside
        // independently named characters; the shared label must not persist.
        entities_present: [...names.map((name) => ({ name, type: "character" })), { name: label, type: "character" }],
        relationships_shown: [{ source: "Darran", target: "Pulchra Fellini", type: "mentor", label: "agreed to train", sentiment: 0.5 }],
        status_changes: [], color_attributions: [], discovered_aliases: [{ canonical_name: label, alias: "Jane" }],
      };
      return { content: JSON.stringify(mode === "rebuild" ? { results: [0, 1].map((index) => ({ index, ...result })) } : result) };
    };
    if (mode === "rebuild") {
      graph.upsertEntity(chatId, { name: label, type: "character", aliases: [], confidence: 1 }, chunkId, 1);
      await rebuildCortex(userId, chatId, names, extraction, "sidecar");
    } else {
      await processChunk({ chunkId, chatId, userId, characterId: null, content: passage, messageIds: [`${chatId}-author`],
        startMessageIndex: 0, endMessageIndex: 0, createdAt: 1 }, names, extraction, "sidecar", undefined, undefined, true);
    }
    expect(graph.getEntities(chatId).map((entity) => entity.name).sort()).toEqual([...names].sort());
    const pulchra = graph.findEntityByName(chatId, "Pulchra Fellini")!;
    const jane = graph.findEntityByName(chatId, "Jane Doe")!;
    expect(pulchra.id).not.toBe(jane.id);
    expect(pulchra.facts.map(graph.stripFactTags)).toContain(fact);
    expect(pulchra.facts.map(graph.stripFactTags)).not.toContain(janeFact);
    expect(jane.facts.map(graph.stripFactTags)).toContain(janeFact);
    expect(jane.facts.map(graph.stripFactTags)).not.toContain(fact);
    expect(graph.getRelationsIncludingInactive(chatId)).toEqual([expect.objectContaining({
      sourceEntityId: graph.findEntityByName(chatId, "Darran")!.id, targetEntityId: pulchra.id, relationType: "mentor",
    })]);
  });
}
