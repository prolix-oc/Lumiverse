import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { DEFAULT_CORTEX_CONFIG, normalizeCortexConfig, putCortexConfig } from "./config";
import { consolidateBacklog, getConsolidations } from "./consolidation";
import { rebuildCortex } from "./index";

const userId = "consolidation-scheduling-user";
const chatId = "consolidation-scheduling-chat";
const config = { ...DEFAULT_CORTEX_CONFIG, enabled: true, entityTracking: false,
  consolidation: { ...DEFAULT_CORTEX_CONFIG.consolidation, enabled: true, useSidecar: false,
    chunkThreshold: 12, chunksPerConsolidation: 12, arcThreshold: 3 },
};

beforeEach(async () => {
  closeDatabase(); initDatabase(":memory:");
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(new URL("../../db/baseline.sql", import.meta.url)).text());
  putCortexConfig(userId, config);
  db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run(chatId, userId);
});
afterEach(() => { closeDatabase(); });

function seedChunks(count: number) {
  const insert = getDb().query(`INSERT INTO chat_chunks
    (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count,
     message_range_start, message_range_end, created_at, updated_at)
    VALUES (?, ?, 'm', 'm', '[]', ?, 20, 1, ?, ?, ?, 1)`);
  for (let i = 0; i < count; i++) insert.run(`chunk-${i}`, chatId,
    `Mara promised to return to the observatory after collecting the missing supplies for expedition ${i}.`, i, i, 1000 + i);
}

test("extractive rebuild honors the configured interval and produces scenes and an arc", async () => {
  seedChunks(36);
  await rebuildCortex(userId, chatId, []);
  expect(getConsolidations(chatId, 1)).toHaveLength(3);
  expect(getConsolidations(chatId, 2)).toHaveLength(1);
  expect(getDb().query("SELECT id FROM chat_chunks WHERE consolidation_id IS NULL").all()).toEqual([]);
});

test("a catch-up pass drains due batches and leaves the next partial interval alone", async () => {
  seedChunks(35);
  expect(await consolidateBacklog(userId, chatId, config.consolidation)).toBe(2);
  expect(getConsolidations(chatId, 1)).toHaveLength(2);
  expect(getConsolidations(chatId, 2)).toHaveLength(0);
  expect((getDb().query("SELECT COUNT(*) AS count FROM chat_chunks WHERE consolidation_id IS NULL").get() as any).count).toBe(11);
  expect(await consolidateBacklog(userId, chatId, config.consolidation)).toBe(0);
});

test("consolidation intervals remain positive whole counts", () => {
  const normalized = normalizeCortexConfig({ consolidation: { ...config.consolidation,
    chunkThreshold: 0, chunksPerConsolidation: 6.8, arcThreshold: Number.NaN,
  } });
  expect(normalized.consolidation).toMatchObject({ chunkThreshold: 1, chunksPerConsolidation: 6, arcThreshold: 5 });
});
