import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import * as secrets from "../src/services/secrets.service";
import { arbitrateCortexCandidates } from "../src/services/memory-cortex/arbitration";
import { DEFAULT_CORTEX_CONFIG, normalizeCortexConfig, putCortexConfig } from "../src/services/memory-cortex/config";
import { evaluatePendingReactivations, processChunk } from "../src/services/memory-cortex";
import { runHeuristicAnalysis } from "../src/services/memory-cortex/heuristic-analysis";
import * as graph from "../src/services/memory-cortex/entity-graph";
import type { SidecarExtractionResult } from "../src/services/memory-cortex/types";

// Runs against the committed Postman simulation, with real provider HTTP and SQLite.
const baseUrl = process.env.CORTEX_DECISION_SIMULATION_URL;
const userId = "cortex-simulation-user";
const chatId = "simulation-chat";
const chunkId = "simulation-chunk";
const profileId = "simulation-decision";
const config = normalizeCortexConfig({ ...DEFAULT_CORTEX_CONFIG, enabled: true,
  consolidation: { ...DEFAULT_CORTEX_CONFIG.consolidation, enabled: false },
  sidecarReliability: { ...DEFAULT_CORTEX_CONFIG.sidecarReliability, arbitratesHeuristics: true },
  arbitration: { ...DEFAULT_CORTEX_CONFIG.arbitration, backend: "decision", connectionProfileId: profileId, timeoutMs: 100 },
});
const input = (directive = "") => ({ passage: `Mara met Tovin. ${directive}`, canonicals: [], candidates: [
  { id: "e0", kind: "entity" as const, name: "Mara" }, { id: "e1", kind: "entity" as const, name: "Noise" },
] });
let secretSpy: ReturnType<typeof spyOn>;

describe.skipIf(!baseUrl)("Memory Cortex native Decision simulation", () => {
  beforeEach(async () => {
    closeDatabase(); initDatabase(":memory:");
    const db = getDb(); db.run("PRAGMA foreign_keys = OFF");
    db.run(await Bun.file(new URL("../src/db/baseline.sql", import.meta.url)).text());
    db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run(chatId, userId);
    db.query("INSERT INTO decision_connections (id, user_id, name, provider, api_url, model, has_api_key, created_at, updated_at) VALUES (?, ?, 'Simulation', 'typesafe', ?, 'fixture-model', 1, 1, 1)")
      .run(profileId, userId, baseUrl!);
    secretSpy = spyOn(secrets, "getSecret").mockImplementation(async (owner, key) => {
      if (owner !== userId || key !== `decision_connection_${profileId}_api_key`) throw new Error("Unexpected credential lookup");
      return "cortex-test-key";
    });
    putCortexConfig(userId, config);
  });
  afterEach(() => { secretSpy?.mockRestore(); closeDatabase(); });

  test("uses native Choice answers and bounded canonical IDs", async () => {
    const result = await arbitrateCortexCandidates({ userId, config, input: input() });
    expect(result.verdicts.map((v) => v.action)).toEqual(["keep", "reject"]);
    expect(result.models).toEqual(["fixture-model"]);
    const resolved = await arbitrateCortexCandidates({ userId, config, input: { passage: "Mara is called Red.",
      canonicals: [{ id: "c0", name: "Mara", aliases: [] }], candidates: [{ id: "e0", kind: "entity", name: "Red", canonicalIds: ["c0"] }] } });
    expect(resolved.verdicts[0]).toMatchObject({ action: "resolve", canonicalId: "c0" });
  });
  test("requires both confidence and selected probability to pass the threshold", async () => {
    for (const directive of ["SIMULATE_LOW_CONFIDENCE", "SIMULATE_LOW_PROBABILITY"]) {
      const result = await arbitrateCortexCandidates({ userId, config, input: input(directive) });
      expect(result.verdicts.every((v) => v.action === "defer")).toBe(true);
    }
  });
  test("recovers the reported 16K questions overflow over native HTTP", async () => {
    const result = await arbitrateCortexCandidates({ userId, config, input: input("SIMULATE_CONTEXT_LIMIT") });
    expect(result.verdicts.map((verdict) => verdict.action)).toEqual(["keep", "reject"]);
    expect(result.models).toEqual(["fixture-model"]);
  });
  test("reviews every candidate across batches on a 16K endpoint", async () => {
    const candidates = Array.from({ length: 35 }, (_, i) => ({ id: `e${i}`, kind: "entity" as const,
      name: `Character${i}`, evidence: [`Character${i} is explicitly named in the passage.`] }));
    const result = await arbitrateCortexCandidates({ userId, config, input: {
      passage: `SIMULATE_16K_REVIEW ${candidates.map((candidate) => candidate.name).join(" met ")}.`,
      candidates, canonicals: [],
    } });
    expect(result.verdicts.map((verdict) => verdict.id)).toEqual(candidates.map((candidate) => candidate.id));
    expect(result.verdicts.every((verdict) => verdict.action === "keep")).toBe(true);
  });
  test("rejects partial answers, JSON/HTML errors, timeout and inaccessible profiles", async () => {
    for (const directive of ["SIMULATE_PARTIAL", "SIMULATE_JSON_ERROR", "SIMULATE_HTML_ERROR", "SIMULATE_TIMEOUT"]) {
      await expect(arbitrateCortexCandidates({ userId, config, input: input(directive) })).rejects.toThrow();
    }
    await expect(arbitrateCortexCandidates({ userId: "another-user", config, input: input() })).rejects.toThrow("not found");
  });
  test("caller cancellation aborts native evaluation", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Simulation caller cancelled")), 10);
    try {
      await expect(arbitrateCortexCandidates({ userId, config, input: input("SIMULATE_TIMEOUT"), signal: controller.signal })).rejects.toThrow("cancelled");
    } finally { clearTimeout(timer); }
  });

  async function ingest(passage: string, extraction?: SidecarExtractionResult) {
    const db = getDb();
    db.query("INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at) VALUES (?, ?, 'm1', 'm1', '[]', ?, 30, 1, 1, 1)").run(chunkId, chatId, passage);
    const heuristic = runHeuristicAnalysis({ cleanContent: passage, knownEntities: [], characterNames: ["Mara", "Tovin"], entityWhitelist: [], minConfidence: 0.5, entityExtractionFilters: config.entityExtractionFilters });
    heuristic.entities = [{ name: "Mara", type: "character", aliases: [], confidence: 1 }, { name: "Noise", type: "concept", aliases: [], confidence: 1 }];
    return processChunk({ chunkId, chatId, userId, characterId: null, content: passage, messageIds: [], startMessageIndex: 0, endMessageIndex: 0, createdAt: 1 },
      ["Mara", "Tovin"], undefined, undefined, undefined, heuristic, true, undefined, extraction);
  }
  test("reviews heuristic extraction without a generative sidecar", async () => {
    await ingest("Mara promised to return.");
    expect(graph.findEntityByName(chatId, "Mara")).not.toBeNull();
    expect(graph.findEntityByName(chatId, "Noise")).toBeNull();
    expect((getDb().query("SELECT cortex_warmup_signature FROM chat_chunks WHERE id = ?").get(chunkId) as any).cortex_warmup_signature).toBeTruthy();
  });
  test("review failure writes neither graph nor salience and leaves warmup pending", async () => {
    await expect(ingest("Mara returned. SIMULATE_PARTIAL")).rejects.toThrow();
    expect(graph.getEntities(chatId)).toEqual([]);
    expect(getDb().query("SELECT id FROM memory_salience").all()).toEqual([]);
    expect((getDb().query("SELECT cortex_warmup_signature FROM chat_chunks WHERE id = ?").get(chunkId) as any).cortex_warmup_signature).toBeNull();
  });
  test("typed batch extraction uses the same gate, fact attribution and arrived status", async () => {
    const existing = graph.upsertEntity(chatId, { name: "Tovin", type: "character", aliases: [], confidence: 1 }, "earlier", 1);
    graph.updateEntityStatus(existing, "inactive");
    await ingest("Mara saved Tovin, who arrived at the gate.", { score: 0.9, emotionalTags: [], narrativeFlags: [], statusChanges: [{ entity: "Tovin", change: "arrived", detail: "Returned to the gate" }],
      entitiesPresent: [{ name: "Mara", type: "character", role: "subject" }, { name: "Tovin", type: "character", role: "object" }, { name: "Noise", type: "concept" }],
      relationshipsShown: [], keyFacts: ["Tovin arrived at the gate.", "Mara saved Tovin."], fontColors: [], discoveredAliases: [] });
    const mara = graph.findEntityByName(chatId, "Mara")!;
    const tovin = graph.findEntityByName(chatId, "Tovin")!;
    expect(mara.facts.map(graph.stripFactTags)).toEqual(["Mara saved Tovin."]);
    expect(tovin.facts.map(graph.stripFactTags)).toContain("Tovin arrived at the gate.");
    expect(tovin.status).toBe("active");
    expect(mara.metadata.factEvidence["mara saved tovin."][0].chunkId).toBe(chunkId);
    expect(graph.findEntityByName(chatId, "Noise")).toBeNull();
  });
  test("failed or uncertain reactivation preserves dormant state and pending evidence", async () => {
    const mara = graph.upsertEntity(chatId, { name: "Mara", type: "character", aliases: [], confidence: 1 }, "earlier", 1);
    const tovin = graph.upsertEntity(chatId, { name: "Tovin", type: "character", aliases: [], confidence: 1 }, "earlier", 1);
    getDb().query("INSERT INTO memory_relations (id, chat_id, source_entity_id, target_entity_id, relation_type, status, user_edited_at, metadata, created_at, updated_at) VALUES ('dormant', ?, ?, ?, 'ally', 'dormant', 1, ?, 1, 1)")
      .run(chatId, mara, tovin, JSON.stringify({ pending_reactivation: true, reactivation_evidence_chunk: chunkId }));
    for (const directive of ["SIMULATE_JSON_ERROR", "SIMULATE_LOW_CONFIDENCE"]) {
      await evaluatePendingReactivations(userId, chatId, directive, config, undefined, chunkId);
      const row = getDb().query("SELECT status, metadata FROM memory_relations WHERE id = 'dormant'").get() as any;
      expect(row.status).toBe("dormant"); expect(JSON.parse(row.metadata).pending_reactivation).toBe(true);
    }
    await evaluatePendingReactivations(userId, chatId, "Mara and Tovin renewed their alliance.", config, undefined, chunkId);
    expect((getDb().query("SELECT status FROM memory_relations WHERE id = 'dormant'").get() as any).status).toBe("active");
  });
});
