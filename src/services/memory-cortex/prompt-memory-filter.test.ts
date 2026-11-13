import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { filterCortexMemoriesForPrompt } from "./prompt-memory-filter";
import type { CortexMemory } from "./types";

beforeEach(async () => {
  const db = initDatabase(":memory:");
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "../../db/baseline.sql")).text());
});
afterEach(() => closeDatabase());

function chunk(id: string, ids: string[], chatId = "chat", consolidationId: string | null = null) {
  getDb().query(`INSERT INTO chat_chunks
    (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at, consolidation_id)
    VALUES (?, ?, 'start', 'end', ?, 'memory', 1, 1, 0, 0, ?)`)
    .run(id, chatId, JSON.stringify(ids), consolidationId);
}

function memory(id: string, source: CortexMemory["source"] = "chunk"): CortexMemory {
  return { source, sourceId: id, content: id, finalScore: 1,
    components: { semantic: 1, salience: 1, recency: 1, reinforcement: 0, emotional: 0, entity: 0 },
    emotionalTags: [], entityNames: [], messageRange: [0, 0], timeRange: [0, 0] };
}

function summary(id: string, sources: string[], tier = 1, chatId = "chat") {
  getDb().query(`INSERT INTO memory_consolidations
    (id, chat_id, tier, summary, source_chunk_ids, created_at, updated_at) VALUES (?, ?, ?, 'summary', ?, 0, 0)`)
    .run(id, chatId, tier, JSON.stringify(sources));
}

test("retains older chunks while excluding live, regenerated, missing and foreign sources", () => {
  chunk("old", ["old-message"]);
  chunk("live", ["old-message", "live-message"]);
  chunk("target", ["regen-target"]);
  chunk("foreign", ["old-message"], "other-chat");
  chunk("unknown", []);
  const memories = ["old", "live", "target", "missing", "foreign", "unknown"].map((id) => memory(id));
  expect(filterCortexMemoriesForPrompt("chat", memories, ["live-message", "regen-target"]).map((m) => m.sourceId)).toEqual(["old"]);
});

test("checks every source chunk of a consolidation, including unlisted linked chunks", () => {
  chunk("old", ["old-message"]);
  chunk("target", ["regen-target"]);
  summary("safe", ["old"]);
  summary("unsafe", ["old", "target"]);
  summary("incomplete", ["old"]);
  chunk("linked-target", ["regen-target"], "chat", "incomplete");
  summary("missing-source", ["deleted"]);
  summary("foreign", ["old"], 1, "other-chat");
  summary("unknown", []);
  summary("higher-tier", ["old"], 2);
  const memories = ["safe", "unsafe", "incomplete", "missing-source", "foreign", "unknown", "higher-tier"].map((id) => memory(id, "consolidation"));
  expect(filterCortexMemoriesForPrompt("chat", memories, ["regen-target"]).map((m) => m.sourceId)).toEqual(["safe"]);
});
