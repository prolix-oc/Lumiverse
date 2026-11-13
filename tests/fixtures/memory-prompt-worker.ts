import { mkdtempSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mock } from "bun:test";
import type { CortexResult, LinkedCortexResult } from "../../src/services/memory-cortex/types";
import type { CortexWarmJob } from "../../src/services/cortex-warm-worker";

let warmResult: { mainResult: CortexResult | null; linkedResult: LinkedCortexResult | null } = { mainResult: null, linkedResult: null };
const warmJobs: CortexWarmJob[] = [];

const root = resolve(import.meta.dir, "../..");
// Keep retrieval offline while exercising the real host warmer and assembly worker.
mock.module(`${root}/src/services/cortex-warm-worker-client.ts`, () => ({
  canUseCortexWorker: () => true,
  warmCortexInWorker: async (job: CortexWarmJob) => { warmJobs.push(job); return warmResult; },
}));
const dataDir = mkdtempSync("/private/tmp/lumiverse-memory-worker-");
process.env.DATA_DIR = dataDir;
delete process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER;
(globalThis as any).__LUMIVERSE_ASSEMBLY_WORKER = true;
const { initDatabase, closeDatabase, getDb } = await import("../../src/db/connection.ts");
const { createChat, createMessage, updateChat } = await import("../../src/services/chats.service.ts");
const { createPreset } = await import("../../src/services/presets.service.ts");
const { putSetting } = await import("../../src/services/settings.service.ts");
const { assemblePrompt } = await import("../../src/services/prompt-assembly.service.ts");
const { putCortexConfig, primeCortexCache, primeLinkedCortexCache, clearCortexResultCaches } = await import("../../src/services/memory-cortex/index.ts");
const { refreshChatMemoryCache } = await import("../../src/services/chat-memory-cache.service.ts");
const { assemblePromptInWorker, releaseIdlePromptAssemblyWorkers, canUsePromptAssemblyWorker } = await import("../../src/services/prompt-assembly-worker-client.ts");
const db = initDatabase();
db.run("PRAGMA foreign_keys = OFF");
db.run(await Bun.file(`${root}/src/db/baseline.sql`).text());
const userId = "memory-worker-repro";
const chat = createChat(userId, { name: "Worker reproduction" });
const message = createMessage(chat.id, { is_user: true, name: "User", content: "What was Kael's secret?" }, userId);
putSetting(userId, "embeddingConfig", { enabled: true, vectorize_chat_messages: true });
putSetting(userId, "chatMemorySettings", { quickMode: null, exclusionWindow: 5 });
putCortexConfig(userId, { enabled: true, useChatMemoryFormatting: true });
const block = (id: string, content: string, marker: string | null = null) => ({ id, name: id, content, marker,
  enabled: true, role: "system" as const, position: "pre_history" as const, depth: 0,
  isLocked: false, color: null, injectionTrigger: [], group: null });
const result: CortexResult = {
  memories: [],
  entityContext: [{ id: "entity", name: "Kael", type: "character", status: "active", description: "A traveler",
    lastSeenAt: null, mentionCount: 1, topFacts: ["CORTEX_SECRET"], emotionalProfile: {}, relationships: [] }],
  activeRelationships: [], arcContext: null,
  stats: { candidatePoolSize: 0, vectorSearchResults: 0, entitiesMatched: 1, scoreFusionApplied: false, topScore: 0, retrievalTimeMs: 0 },
};
primeCortexCache(chat.id, result, [message.id]);
const preset = createPreset(userId, { name: "Memory probe", provider: "openai", prompt_order: [
  block("memory", "ACTIVE={{memoriesActive}} CORTEX={{cortexActive}}\n{{memories}}"), block("history", "", "chat_history"),
] });
const ctx = { userId, chatId: chat.id, generationType: "normal" as const, presetOverride: preset, macroCommit: false };
const content = (assembled: Awaited<ReturnType<typeof assemblePrompt>>) => JSON.stringify(assembled.messages);
const linked: LinkedCortexResult = {
  vaults: [{ vaultId: "vault", vaultName: "Archive", entities: [{ ...result.entityContext[0], topFacts: ["LINKED_SECRET"] }], relations: [] }],
  interlinks: [],
};
primeLinkedCortexCache(chat.id, linked);
try {
  assert.equal(canUsePromptAssemblyWorker(), true);
  const direct = await assemblePrompt(ctx);
  const worker = await assemblePromptInWorker(ctx);
  assert.match(content(direct), /CORTEX_SECRET/);
  assert.match(content(worker), /ACTIVE=yes CORTEX=yes/);
  assert.match(content(worker), /CORTEX_SECRET/);
  assert.match(content(worker), /LINKED_SECRET/);
  assert.equal(worker.deferredCortexWarmJob, undefined);
  await Bun.sleep(0);
  assert.equal(warmJobs.length, 1);
  assert.deepEqual(warmJobs[0].mainQuery.excludeMessageIds, [message.id]);

  // Exercise the actual next-turn transition, rather than only reassembling an
  // unchanged conversation with the same exclusion set.
  const replyId = crypto.randomUUID();
  const nextUserId = crypto.randomUUID();
  const appendTurn = getDb().query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content) VALUES (?, ?, ?, ?, ?, ?)");
  appendTurn.run(replyId, chat.id, 1, 0, "Kael", "A reply");
  appendTurn.run(nextUserId, chat.id, 2, 1, "User", "And then?");
  const nextTurn = await assemblePromptInWorker(ctx);
  assert.match(content(nextTurn), /ACTIVE=yes CORTEX=yes/);
  assert.match(content(nextTurn), /CORTEX_SECRET/);
  getDb().query("DELETE FROM messages WHERE id IN (?, ?)").run(replyId, nextUserId);

  // A reused worker must consume the new empty snapshot, then return warm work
  // to the host so the following assembly can read the newly populated cache.
  clearCortexResultCaches();
  warmResult = { mainResult: result, linkedResult: linked };
  const cold = await assemblePromptInWorker(ctx);
  assert.doesNotMatch(content(cold), /CORTEX_SECRET|LINKED_SECRET/);
  await Bun.sleep(0);
  warmResult = { mainResult: null, linkedResult: null };
  const rewarmed = await assemblePromptInWorker(ctx);
  assert.match(content(rewarmed), /CORTEX_SECRET/);
  assert.match(content(rewarmed), /LINKED_SECRET/);

  // Database opt-outs take precedence over warm snapshots in a reused worker.
  updateChat(userId, chat.id, { metadata: { cortex_settings: { enabled: false } } });
  const optedOut = await assemblePromptInWorker(ctx);
  assert.doesNotMatch(content(optedOut), /CORTEX_SECRET|LINKED_SECRET/);
  updateChat(userId, chat.id, { metadata: { cortex_settings: { enabled: true } } });

  // Graph context survives a changed exclusion set; source memories are checked
  // separately against their chunk provenance before they can be reused.
  primeCortexCache(chat.id, result, []);
  const unsafe = await assemblePromptInWorker(ctx);
  assert.match(content(unsafe), /CORTEX_SECRET/);
  clearCortexResultCaches();

  // Saved entities are available in a cold worker prompt without any vector
  // retrieval succeeding first. The host mock returns no retrieval results.
  getDb().query("INSERT INTO memory_entities (id, chat_id, name, facts, created_at, updated_at) VALUES ('saved', ?, 'Kael', ?, 0, 0)")
    .run(chat.id, JSON.stringify(["SAVED_CORTEX_FACT"]));
  const savedGraph = await assemblePromptInWorker(ctx);
  assert.match(content(savedGraph), /ACTIVE=yes CORTEX=yes/);
  assert.match(content(savedGraph), /SAVED_CORTEX_FACT/);
  const flagOnlyPreset = createPreset(userId, { name: "Only Cortex flag", provider: "openai", prompt_order: [
    block("flag", "{{cortexActive}}"),
  ] });
  const flagOnly = await assemblePromptInWorker({ ...ctx, presetOverride: flagOnlyPreset });
  assert.ok(flagOnly.messages.some((message) => message.content === "yes"));
  const flagWithMemories = await assemblePromptInWorker({ ...ctx, presetOverride: {
    ...flagOnlyPreset, prompt_order: [block("flag-and-memory", "{{cortexActive}}\n{{memories}}")],
  } });
  assert.match(content(flagWithMemories), /SAVED_CORTEX_FACT/);
  getDb().query("DELETE FROM memory_entities WHERE id = 'saved'").run();

  putCortexConfig(userId, { enabled: false });
  const insertMessage = getDb().query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content) VALUES (?, ?, ?, 1, 'User', ?)");
  let lastMessageId = "";
  for (let i = 1; i < 8; i++) {
    lastMessageId = crypto.randomUUID();
    insertMessage.run(lastMessageId, chat.id, i, `Recent turn ${i}`);
  }
  getDb().query("UPDATE messages SET is_user = 0, name = 'Assistant' WHERE id = ?").run(lastMessageId);
  getDb().query(`INSERT INTO chat_chunks (id,chat_id,start_message_id,end_message_id,message_ids,content,token_count,message_count,created_at,updated_at)
    VALUES ('old-chunk',?,?,?,?, 'BASIC_SECRET',4,1,0,0)`).run(chat.id, message.id, message.id, JSON.stringify([message.id]));
  await refreshChatMemoryCache(userId, chat.id);
  const basicDirect = await assemblePrompt(ctx);
  const basicWorker = await assemblePromptInWorker(ctx);
  assert.equal(JSON.stringify(basicDirect.messages).includes("BASIC_SECRET"), true);
  assert.equal(JSON.stringify(basicWorker.messages).includes("BASIC_SECRET"), true);
  const regenCtx = { ...ctx, generationType: "regenerate" as const, excludeMessageId: lastMessageId };
  const regenDirect = await assemblePrompt(regenCtx);
  const regenWorker = await assemblePromptInWorker(regenCtx);
  assert.equal(JSON.stringify(regenDirect.messages).includes("BASIC_SECRET"), true);
  assert.equal(JSON.stringify(regenWorker.messages).includes("BASIC_SECRET"), true);
  assert.equal(regenDirect.memoryStats?.chunksAvailable, 1);
  assert.equal(regenDirect.memoryStats?.chunksRetrieved, 1);
  // A swipe can blank the persisted target before assembly starts.
  getDb().query("UPDATE messages SET content = '' WHERE id = ?").run(lastMessageId);
  assert.match(content(await assemblePromptInWorker(regenCtx)), /BASIC_SECRET/);

  // Saved summaries are read inside the worker on both cold and reused runs.
  // The source range uses timestamps in legacy records; only IDs define it.
  getDb().query(`INSERT INTO memory_consolidations
    (id, chat_id, tier, summary, source_chunk_ids, message_range_start, message_range_end, created_at, updated_at)
    VALUES ('worker-scene', ?, 1, 'WORKER_RECAP {{user}}', '["old-chunk"]', 1700000000, 1700000000, 0, 0)`).run(chat.id);
  putCortexConfig(userId, { enabled: true, replaceConsolidatedMessagesInContext: true });
  const compressedDirect = await assemblePrompt(ctx);
  const compressedWorker = await assemblePromptInWorker(ctx);
  for (const compressed of [compressedDirect, compressedWorker]) {
    assert.match(content(compressed), /WORKER_RECAP \{\{user\}\}/);
    assert.doesNotMatch(content(compressed), /BASIC_SECRET/);
    assert.doesNotMatch(content(compressed), /What was Kael's secret/);
  }
  putCortexConfig(userId, { replaceConsolidatedMessagesInContext: false });
  const uncompressed = await assemblePromptInWorker(ctx);
  assert.doesNotMatch(content(uncompressed), /WORKER_RECAP/);
  assert.match(content(uncompressed), /What was Kael's secret/);

  // Worker snapshots enforce the current distance cutoff independently of
  // the stored rank. Tightening it must work without another vector query.
  const cachedMemories: CortexResult = { ...result, memories: [
    { source: "chunk", sourceId: "measured-close", content: "WORKER_CLOSE_LOW_RANK", vectorDistance: 0.35, finalScore: 0.2,
      components: { semantic: 0.65, salience: 0, recency: 0, reinforcement: 0, emotional: 0, entity: 0 },
      emotionalTags: [], entityNames: [], messageRange: [0, 0], timeRange: [0, 0] },
    { source: "chunk", sourceId: "measured-far", content: "WORKER_FAR_HIGH_RANK", vectorDistance: 0.8, finalScore: 0.99,
      components: { semantic: 0.2, salience: 1, recency: 1, reinforcement: 1, emotional: 1, entity: 1 },
      emotionalTags: [], entityNames: [], messageRange: [0, 0], timeRange: [0, 0] },
  ] };
  const sourceMessageIds = getDb().query("SELECT id FROM messages WHERE chat_id = ?").all(chat.id) as Array<{ id: string }>;
  primeCortexCache(chat.id, cachedMemories, sourceMessageIds.map((m) => m.id));
  putSetting(userId, "chatMemorySettings", { similarityThreshold: 0.6 });
  const gated = await assemblePromptInWorker(ctx);
  assert.match(content(gated), /WORKER_CLOSE_LOW_RANK/);
  assert.doesNotMatch(content(gated), /WORKER_FAR_HIGH_RANK|BASIC_SECRET/);
  putSetting(userId, "chatMemorySettings", { similarityThreshold: 0.3 });
  assert.doesNotMatch(content(await assemblePromptInWorker(ctx)), /WORKER_CLOSE_LOW_RANK|WORKER_FAR_HIGH_RANK/);
  console.log("memory worker integration passed");
} finally {
  releaseIdlePromptAssemblyWorkers();
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(0);
