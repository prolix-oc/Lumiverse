import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";

mock.module("../auth/index", () => ({ auth: { api: {} } }));
mock.module("../services/connections.service", () => ({
  resolveConnection: (_user: string, id?: string) => id ? { id, provider: "fixture", has_api_key: true } : null,
  testConnection: async () => ({ success: true }),
}));
mock.module("../llm/registry", () => ({ getProvider: () => ({ capabilities: { apiKeyRequired: false } }) }));

const { closeDatabase, getDb, initDatabase } = await import("../db/connection");
const embeddings = await import("../services/embeddings.service");
const chats = await import("../services/chats.service");
const cortex = await import("../services/memory-cortex");
const { DEFAULT_CORTEX_CONFIG } = await import("../services/memory-cortex/config");
const cache = await import("../services/chat-memory-cache.service");
const vectors = await import("../services/vectorization-queue.service");
const regex = await import("../services/regex-scripts.service");
const { putSetting } = await import("../services/settings.service");
const { eventBus } = await import("../ws/bus");
const { memoryCortexRoutes } = await import("./memory-cortex.routes");
const { getCortexActivity } = await import("../services/memory-cortex/activity");
const { enqueueChatPipelineTask, getChatPipelineStatus, resetChatPipelineCoordinatorForTests } = await import("../services/chat-pipeline-coordinator.service");

const userId = "warmup-owner";
const restore: Array<() => void> = [];
let rebuild: ReturnType<typeof spyOn>;
let resume: ReturnType<typeof spyOn>;
let rebuildChunks: ReturnType<typeof spyOn>;
const generate = mock(async () => ({ content: JSON.stringify({ importance: 5, key_facts: [], entities_present: [],
  relationships_shown: [], emotional_tones: [], narrative_flags: [], status_changes: [],
  color_attributions: [], discovered_aliases: [] }) }));

function vectorization(enabled: boolean) {
  putSetting(userId, "embeddingConfig", { enabled: true, vectorize_chat_messages: enabled });
}
function chatMemory(autoWarmup: boolean) {
  putSetting(userId, "chatMemorySettings", { autoWarmup, injectionStrategy: "disabled" });
}
function seedChat(greeting = false) {
  const chat = chats.createChat(userId, greeting ? { character_id: "warmup-character" } : { name: "Warmup test" });
  if (!greeting) {
    for (let i = 0; i < 3; i++) getDb().query(`INSERT INTO chat_chunks
      (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at)
      VALUES (?, ?, 'm', 'm', '[]', 'Earlier conversation', 10, 1, 1, 1)`)
      .run(`${chat.id}-${i}`, chat.id);
  }
  chats.updateChat(userId, chat.id, { metadata: { ltcm_config_hash: "current-hash" } });
  return chat;
}
function app() {
  const instance = new Hono();
  instance.use("*", async (c, next) => { c.set("userId", userId); await next(); });
  instance.route("/", memoryCortexRoutes);
  return instance;
}
async function request(chatId: string, endpoint = "warm", force = false) {
  const response = await app().request(`/chats/${chatId}/${endpoint}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }),
  });
  expect(response.status).toBe(200);
  return await response.json() as any;
}
async function until(done: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (done()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for Cortex work");
}
function blockLane(chatId: string) {
  const held = Promise.withResolvers<void>();
  const task = enqueueChatPipelineTask({ chatId, kind: "chunk_rebuild", run: () => held.promise });
  return { release: held.resolve, done: task };
}

beforeEach(async () => {
  closeDatabase();
  const db = initDatabase(":memory:");
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  db.query(`INSERT INTO "user" (id, name, email, emailVerified) VALUES (?, 'Owner', 'warmup@example.test', 1)`).run(userId);
  db.query("INSERT INTO characters (id, user_id, name, first_mes) VALUES ('warmup-character', ?, 'Mara', 'Mara opened the observatory.')").run(userId);
  vectorization(true);
  chatMemory(false);
  cortex.putCortexConfig(userId, { ...DEFAULT_CORTEX_CONFIG, enabled: true, autoWarmup: false,
    entityTracking: false, salienceScoring: true, salienceScoringMode: "sidecar",
    consolidation: { ...DEFAULT_CORTEX_CONFIG.consolidation, enabled: false },
    sidecar: { ...DEFAULT_CORTEX_CONFIG.sidecar, connectionProfileId: "sidecar", model: "fixture" },
    queryGeneration: { primary: { connectionProfileId: "sidecar", model: "fixture" }, secondary: null },
  });
  const spies = [
    spyOn(chats, "getCurrentChatMemoryHash").mockResolvedValue("current-hash"),
    spyOn(chats, "ensureChatMemoryFresh").mockResolvedValue(false),
    rebuildChunks = spyOn(chats, "rebuildChatChunks").mockResolvedValue(undefined),
    spyOn(cache, "scheduleChatMemoryRefresh").mockImplementation(() => {}),
    spyOn(vectors, "queueChunkVectorization").mockImplementation(() => {}),
    resume = spyOn(vectors, "queuePendingChatChunkVectorization").mockReturnValue(0),
    spyOn(embeddings, "reconcileChatChunkEmbeddings").mockResolvedValue(0),
    rebuild = spyOn(cortex, "rebuildCortex").mockResolvedValue({ chunksProcessed: 3, entitiesFound: 0, relationsFound: 0 }),
    spyOn(cortex, "createCortexSidecarGenerateRawAdapter").mockReturnValue(generate),
    spyOn(eventBus, "emit").mockImplementation(() => {}),
  ];
  restore.push(...spies.map((spy) => () => spy.mockRestore()));
  generate.mockClear();
});
afterEach(async () => {
  await Bun.sleep(0); // Flush coalesced progress broadcasts before closing SQLite.
  restore.splice(0).reverse().forEach((reset) => reset());
  resetChatPipelineCoordinatorForTests();
  closeDatabase();
});

test("passive warmup skips both opted-out components without creating activity", async () => {
  const chat = seedChat();
  const result = await request(chat.id);
  expect(result).toMatchObject({ status: "skipped",
    chatMemory: { status: "skipped", reason: "chat_memory_auto_warmup_disabled" },
    cortex: { status: "skipped", reason: "cortex_auto_warmup_disabled" },
  });
  expect(getCortexActivity(chat.id).runs).toEqual([]);
  expect(rebuild).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
});

test("disabled vectorization prevents passive work even with both warmups opted in", async () => {
  vectorization(false); chatMemory(true); cortex.putCortexConfig(userId, { autoWarmup: true });
  const chat = seedChat();
  expect(await request(chat.id)).toMatchObject({ status: "skipped",
    chatMemory: { status: "skipped", reason: "chat_vectorization_disabled" },
    cortex: { status: "skipped", reason: "chat_vectorization_disabled" },
  });
  expect(getCortexActivity(chat.id).runs).toEqual([]);
});

test("LTCM-only warmup leaves Cortex skipped in the response and does not rebuild it", async () => {
  chatMemory(true);
  const chat = seedChat();
  expect(await request(chat.id)).toMatchObject({ status: "started", chatMemory: { status: "started" },
    cortex: { status: "skipped", reason: "cortex_auto_warmup_disabled" } });
  await until(() => resume.mock.calls.length > 0);
  expect(rebuild).not.toHaveBeenCalled();
  expect(getCortexActivity(chat.id).runs).toEqual([]);
});

test("a duplicate LTCM-only request reports the eligible warmup already in progress", async () => {
  chatMemory(true);
  const chat = seedChat();
  await request(chat.id);
  expect(await request(chat.id)).toMatchObject({ status: "skipped", reason: "warmup_in_progress",
    chatMemory: { status: "skipped", reason: "warmup_in_progress" },
    cortex: { status: "skipped", reason: "cortex_auto_warmup_disabled" } });
  await until(() => resume.mock.calls.length > 0);
  expect(rebuild).not.toHaveBeenCalled();
});

test("Cortex-only warmup leaves LTCM skipped and starts a resumable build", async () => {
  cortex.putCortexConfig(userId, { autoWarmup: true });
  const chat = seedChat();
  expect(await request(chat.id)).toMatchObject({ status: "started", cortex: { status: "started" },
    chatMemory: { status: "skipped", reason: "chat_memory_auto_warmup_disabled" } });
  await until(() => getCortexActivity(chat.id).runs.some((run) => run.status === "complete"));
  expect(rebuild.mock.calls[0][7]).toMatchObject({ resumable: true });
  expect(resume).not.toHaveBeenCalled();
});

test.each(["rebuild", "warm"])("manual %s remains available with automatic warmup off", async (endpoint) => {
  const chat = seedChat();
  expect((await request(chat.id, endpoint, true)).status).toBe("started");
  await until(() => getCortexActivity(chat.id).runs.some((run) => run.status === "complete"));
  expect(rebuild).toHaveBeenCalledTimes(1);
  expect(rebuild.mock.calls[0][7]).toMatchObject({ resumable: false });
});

test.each(["rebuild", "warm"])("manual %s respects disabled vectorization", async (endpoint) => {
  vectorization(false);
  const chat = seedChat();
  expect(await request(chat.id, endpoint, true)).toMatchObject({ status: "skipped", reason: "chat_vectorization_disabled" });
  expect(rebuild).not.toHaveBeenCalled();
  expect(rebuildChunks).not.toHaveBeenCalled();
  expect(getCortexActivity(chat.id).runs).toEqual([]);
});

describe("queued Cortex rebuilds", () => {
  test.each(["warmup", "vectorization", "cortex", "chat"])("rechecks %s opt-out before running", async (setting) => {
    cortex.putCortexConfig(userId, { autoWarmup: true });
    const chat = seedChat();
    const lane = blockLane(chat.id);
    try {
      await request(chat.id);
      await until(() => (getChatPipelineStatus(chat.id)?.queuedCounts.cortex_warmup ?? 0) > 0);
      if (setting === "warmup") cortex.putCortexConfig(userId, { autoWarmup: false });
      if (setting === "vectorization") vectorization(false);
      if (setting === "cortex") cortex.putCortexConfig(userId, { enabled: false });
      if (setting === "chat") chats.updateChat(userId, chat.id, { metadata: { cortex_settings: { enabled: false } } });
    } finally { lane.release(); await lane.done; }
    await until(() => getCortexActivity(chat.id).runs.some((run) => run.status === "cancelled"));
    expect(rebuild).not.toHaveBeenCalled();
  });

  test("a queued manual rebuild also respects vectorization being disabled", async () => {
    const chat = seedChat();
    const lane = blockLane(chat.id);
    try {
      await request(chat.id, "rebuild");
      await until(() => (getChatPipelineStatus(chat.id)?.queuedCounts.cortex_rebuild ?? 0) > 0);
      vectorization(false);
    } finally { lane.release(); await lane.done; }
    await until(() => getCortexActivity(chat.id).runs.some((run) => run.status === "cancelled"));
    expect(rebuild).not.toHaveBeenCalled();
  });
});

test("creating a greeting with vectorization off creates no chunks or Cortex activity", async () => {
  vectorization(false);
  const chat = seedChat(true);
  expect(getDb().query("SELECT id FROM chat_chunks WHERE chat_id = ?").all(chat.id)).toEqual([]);
  expect(getCortexActivity(chat.id).runs).toEqual([]);
  expect(generate).not.toHaveBeenCalled();
});

test("disabling vectorization during greeting preparation prevents chunk creation", async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const strip = spyOn(regex, "applyMemoryIngestionRegex").mockImplementation(async (_user, content) => {
    started.resolve(); await release.promise; return content;
  });
  restore.push(() => strip.mockRestore());
  const chat = seedChat(true);
  await started.promise;
  vectorization(false); release.resolve();
  await Bun.sleep(0);
  expect(getDb().query("SELECT id FROM chat_chunks WHERE chat_id = ?").all(chat.id)).toEqual([]);
  expect(getCortexActivity(chat.id).runs).toEqual([]);
  expect(generate).not.toHaveBeenCalled();
});

test("queued greeting ingestion rechecks vectorization before any provider call", async () => {
  const chat = seedChat();
  const lane = blockLane(chat.id);
  try {
    chats.createMessage(chat.id, { is_user: false, name: "Mara", content: "Mara opened the observatory." }, userId);
    await until(() => (getChatPipelineStatus(chat.id)?.queuedCounts.cortex_ingest ?? 0) > 0);
    vectorization(false);
  } finally { lane.release(); await lane.done; }
  await until(() => getCortexActivity(chat.id).runs.some((run) => run.status === "cancelled"));
  expect(generate).not.toHaveBeenCalled();
});

test("ingestion submitted after vectorization is disabled does not create queued activity", async () => {
  const chat = seedChat();
  vectorization(false);
  const result = await cortex.scheduleProcessChunk({ chunkId: `${chat.id}-0`, chatId: chat.id, userId,
    characterId: null, content: "Earlier conversation", messageIds: [], startMessageIndex: 0, endMessageIndex: 0, createdAt: 1,
  }, ["Mara"], generate, "sidecar");
  expect(result).toMatchObject({ status: "skipped", reason: "chat_vectorization_disabled" });
  expect(getCortexActivity(chat.id).runs).toEqual([]);
  expect(getChatPipelineStatus(chat.id)).toBeNull();
  expect(generate).not.toHaveBeenCalled();
});

test("ordinary greeting ingestion still runs when only automatic warmup and injection are disabled", async () => {
  const chat = seedChat(true);
  await until(() => getCortexActivity(chat.id).runs.some((run) => run.status === "complete"));
  expect(generate).toHaveBeenCalledTimes(1);
  expect(getCortexActivity(chat.id).runs[0].kind).toBe("ingestion");
  expect(rebuild).not.toHaveBeenCalled();
});
