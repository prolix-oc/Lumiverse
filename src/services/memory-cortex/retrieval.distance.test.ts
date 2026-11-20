import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import * as embeddings from "../embeddings.service";
import { putSetting } from "../settings.service";
import { DEFAULT_CORTEX_CONFIG } from "./config";
import { clearCortexResultCaches, queryCortex } from "./index";
import { queryVaultCortex } from "./retrieval";

let embedSpy: ReturnType<typeof spyOn>;
let searchSpy: ReturnType<typeof spyOn>;
let vaultSpy: ReturnType<typeof spyOn>;
const userId = "distance-user";
const chatId = "distance-chat";
const config = { ...DEFAULT_CORTEX_CONFIG, enabled: true, entityTracking: false, salienceScoring: false,
  retrieval: { ...DEFAULT_CORTEX_CONFIG.retrieval, diversitySelection: false, entityContextInjection: false,
    relationshipInjection: false, arcInjection: false } };
let hits: Array<{ chunk_id: string; content: string; score: number | null }>;

beforeEach(async () => {
  const db = initDatabase(":memory:");
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "../../db/baseline.sql")).text());
  putSetting(userId, "chatMemorySettings", { similarityThreshold: 0.6 });
  hits = [{ chunk_id: "close", content: "CLOSE", score: 0.35 },
    { chunk_id: "boundary", content: "BOUNDARY", score: 0.6 },
    { chunk_id: "far", content: "FAR", score: 0.60001 },
    { chunk_id: "unknown", content: "UNKNOWN", score: null }];
  for (const hit of hits) {
    db.query(`INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content,
      token_count, message_count, vectorized_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 4, 1, 1, 0, 0)`)
      .run(hit.chunk_id, chatId, hit.chunk_id, hit.chunk_id, JSON.stringify([hit.chunk_id]), hit.content);
    db.query("INSERT INTO memory_salience (id, chunk_id, chat_id, score, score_source, scored_at, created_at) VALUES (?, ?, ?, ?, 'heuristic', 0, 0)")
      .run(`salience-${hit.chunk_id}`, hit.chunk_id, chatId, hit.chunk_id === "far" ? 1 : 0.01);
  }
  embedSpy = spyOn(embeddings, "cachedEmbedTexts").mockResolvedValue([[1, 0]]);
  searchSpy = spyOn(embeddings, "searchChatChunks").mockImplementation(async () => hits as any);
  vaultSpy = spyOn(embeddings, "searchVaultChunks").mockImplementation(async () => hits as any);
});
afterEach(() => {
  embedSpy?.mockRestore(); searchSpy?.mockRestore(); vaultSpy?.mockRestore();
  clearCortexResultCaches(); closeDatabase();
});
const query = () => queryCortex({ userId, chatId, queryText: "remember", generationType: "normal",
  topK: 10, includeConsolidations: true, includeRelationships: false }, config);

test("Cortex applies the user's raw-distance cutoff before ranking and preserves the measurement", async () => {
  const result = await query();
  expect(result.memories.map((m) => m.sourceId).sort()).toEqual(["boundary", "close"]);
  expect(result.memories.find((m) => m.sourceId === "close")?.vectorDistance).toBe(0.35);
  // The rank is intentionally a separate score and can be below the cutoff.
  expect(result.memories.find((m) => m.sourceId === "close")?.finalScore).toBeLessThan(0.6);
});

test("legacy embedding settings supply the cutoff when chat memory settings are absent", async () => {
  getDb().query("DELETE FROM settings WHERE user_id = ? AND key = 'chatMemorySettings'").run(userId);
  putSetting(userId, "embeddingConfig", { similarity_threshold: 0.4 });
  expect((await query()).memories.map((m) => m.sourceId)).toEqual(["close"]);
});

test("disabling the cutoff admits farther measured matches, never an unknown measurement", async () => {
  putSetting(userId, "chatMemorySettings", { similarityThreshold: 0 });
  expect((await query()).memories.map((m) => m.sourceId).sort()).toEqual(["boundary", "close", "far"]);
});

test("an emitted consolidation inherits its qualifying source hit's distance", async () => {
  getDb().query("INSERT INTO memory_consolidations (id, chat_id, tier, summary, source_chunk_ids, created_at, updated_at) VALUES ('scene', ?, 1, 'SUMMARY', '[\"close\"]', 0, 0)").run(chatId);
  getDb().query("UPDATE chat_chunks SET consolidation_id = 'scene' WHERE id = 'close'").run();
  const memory = (await query()).memories.find((m) => m.sourceId === "scene");
  expect(memory?.source).toBe("consolidation");
  expect(memory?.vectorDistance).toBe(0.35);
});

test("vault retrieval applies the same distance gate before fused ranking", async () => {
  for (const hit of hits) getDb().query(`INSERT INTO cortex_vault_chunks
    (id, vault_id, source_chunk_id, content, salience_score, source_created_at, copied_at)
    VALUES (?, 'vault', ?, ?, 1, 0, 0)`).run(hit.chunk_id, hit.chunk_id, hit.content);
  const result = await queryVaultCortex({ userId, vaultId: "vault", queryText: "remember", topK: 10, maxDistance: 0.6 }, config);
  expect(result.memories.map((m) => m.sourceId).sort()).toEqual(["boundary", "close"]);
});
