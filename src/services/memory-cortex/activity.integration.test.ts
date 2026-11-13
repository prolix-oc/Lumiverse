import { afterEach, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { DEFAULT_CORTEX_CONFIG, putCortexConfig } from "./config";
import { getCortexActivity } from "./activity";
import { rebuildCortex } from "./index";

afterEach(() => closeDatabase());

test("a failed rebuild batch does not end tracking while another batch is still receiving content", async () => {
  closeDatabase(); initDatabase(":memory:");
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(new URL("../../db/baseline.sql", import.meta.url)).text());
  const userId = "activity-integration-user", chatId = "activity-integration-chat";
  db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run(chatId, userId);
  putCortexConfig(userId, { ...DEFAULT_CORTEX_CONFIG, enabled: true, entityTracking: false,
    salienceScoringMode: "sidecar",
    sidecar: { ...DEFAULT_CORTEX_CONFIG.sidecar, connectionProfileId: "sidecar", model: "test-model", chunkBatchSize: 1, rebuildConcurrency: 2 },
    queryGeneration: { primary: { connectionProfileId: "sidecar", model: "test-model" }, secondary: null },
  });
  for (let i = 0; i < 2; i++) db.query(`INSERT INTO chat_chunks
    (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, message_range_start, message_range_end, created_at, updated_at)
    VALUES (?, ?, 'm', 'm', '[]', ?, 20, 1, ?, ?, 1, 1)`)
    .run(`activity-chunk-${i}`, chatId, `Mara carried supplies back to the observatory on expedition ${i}.`, i, i);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0, failed = false, settled = false;
  const pending = rebuildCortex(userId, chatId, [], async () => {
    if (++calls === 2) await held;
    return { content: JSON.stringify({ importance: 5, key_facts: [], entities_present: [], relationships_shown: [],
      emotional_tones: [], narrative_flags: [], status_changes: [], color_attributions: [], discovered_aliases: [] }) };
  }, "sidecar", (state) => {
    if (state.current === 1 && !failed) { failed = true; throw new Error("Batch persistence observer failed"); }
  }).then(() => { settled = true; return null; }, (error) => { settled = true; return error; });
  try {
    for (let i = 0; i < 200 && !(failed && calls === 2); i++) await Bun.sleep(5);
    expect(failed).toBe(true);
    expect(settled).toBe(false);
    const run = getCortexActivity(chatId).runs[0];
    expect(run.status).toBe("processing");
    expect(run.failedBatches).toBe(1);
    expect(run.activeBatches.map((batch) => batch.batch)).toEqual([2]);
  } finally { release(); }
  expect((await pending)?.message).toBe("Batch persistence observer failed");
  expect(getCortexActivity(chatId).runs[0]).toMatchObject({ status: "error", activeBatches: [], requests: [] });
});
