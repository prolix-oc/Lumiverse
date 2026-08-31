import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  closeDatabase,
  getDb,
  getDbGeneration,
  initDatabase,
  onDbReset,
  runWithDbGeneration,
} from "../db/connection";
import { runMigrations } from "../db/migrate";
import * as chatMemoryCacheSvc from "./chat-memory-cache.service";
import * as chatsSvc from "./chats.service";
import * as embeddingsSvc from "./embeddings.service";
import type { EmbeddingConfigWithStatus } from "./embeddings.service";
import * as memoryCortex from "./memory-cortex";
import * as vectorizationQueueSvc from "./vectorization-queue.service";
import { __test__ as userDataImportTest } from "./user-data/import.service";
import {
  __test__ as maintenanceTest,
  trackChatChunkMaintenance,
} from "./chat-chunk-maintenance.service";

const USER_ID = "maintenance-owner";

describe.serial("chat chunk maintenance lifecycle", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  let enabledEmbeddingConfig: EmbeddingConfigWithStatus;
  let refreshCacheImpl: () => Promise<void>;

  function track<T extends { mockRestore: () => void }>(spy: T): T {
    spies.push(spy);
    return spy;
  }

  function createTemporaryChat() {
    return chatsSvc.createChat(USER_ID, {
      character_id: null,
      name: "Maintenance lifecycle",
      metadata: { temporary: true },
    });
  }

  function seedMessage(
    chatId: string,
    id: string,
    index: number,
    isUser: boolean,
    content: string,
  ): void {
    getDb().query(
      `INSERT INTO messages (
        id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id,
        swipes, swipe_dates, extra, parent_message_id, branch_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '{}', NULL, NULL, ?)`,
    ).run(
      id,
      chatId,
      index,
      isUser ? 1 : 0,
      isUser ? "User" : "Assistant",
      content,
      index + 1,
      JSON.stringify([content]),
      JSON.stringify([index + 1]),
      index + 1,
    );
  }

  function seedChunk(
    chatId: string,
    id: string,
    messageIds: string[],
    createdAt: number,
  ): void {
    const startMessageId = messageIds[0];
    const endMessageId = messageIds.at(-1);
    if (!startMessageId || !endMessageId) throw new Error("chunk fixture requires at least one message");
    getDb().query(
      `INSERT INTO chat_chunks (
        id, chat_id, start_message_id, end_message_id, message_ids, content,
        token_count, message_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      id,
      chatId,
      startMessageId,
      endMessageId,
      JSON.stringify(messageIds),
      `chunk:${id}`,
      messageIds.length,
      createdAt,
      createdAt,
    );
  }

  function isPending(promise: Promise<unknown>): () => boolean {
    let pending = true;
    void promise.then(
      () => { pending = false; },
      () => { pending = false; },
    );
    return () => pending;
  }

  async function replaceDatabaseWithCollision(
    chatId: string,
    messageId: string,
    chunkId: string,
  ): Promise<void> {
    closeDatabase();
    initDatabase(":memory:");
    await runMigrations(getDb());
    getDb().query(
      'INSERT INTO "user" (id, name, email, emailVerified) VALUES (?, ?, ?, 1)',
    ).run(USER_ID, "Replacement Owner", "replacement-owner@example.test");
    getDb().run("CREATE TABLE lifecycle_probe (stage TEXT PRIMARY KEY)");
    const replacement = createTemporaryChat();
    getDb().query("UPDATE chats SET id = ? WHERE id = ?").run(chatId, replacement.id);
    seedMessage(chatId, messageId, 0, true, "replacement message");
    seedChunk(chatId, chunkId, [messageId], 1);
  }

  beforeEach(async () => {
    await chatsSvc.waitForChatChunkMaintenance();
    closeDatabase();
    initDatabase(":memory:");
    await runMigrations(getDb());
    getDb().query(
      'INSERT INTO "user" (id, name, email, emailVerified) VALUES (?, ?, ?, 1)',
    ).run(USER_ID, "Maintenance Owner", "maintenance-owner@example.test");
    getDb().run("CREATE TABLE lifecycle_probe (stage TEXT PRIMARY KEY)");

    const defaultConfig = await embeddingsSvc.getEmbeddingConfig(USER_ID);
    enabledEmbeddingConfig = {
      ...defaultConfig,
      enabled: true,
      vectorize_chat_messages: true,
    };

    track(spyOn(embeddingsSvc, "deleteChatChunkEmbeddings").mockResolvedValue(undefined));
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(async (tasks) => ({
      processedCount: tasks.length,
      failedChunkIds: [],
      refreshedChatIds: [],
    }));
    refreshCacheImpl = async () => {};
    chatMemoryCacheSvc.__test__.setRefreshChatMemoryCache(async () => refreshCacheImpl());
    track(spyOn(chatMemoryCacheSvc, "refreshChatMemoryCache").mockImplementation(() => (
      refreshCacheImpl()
    )));
  });

  afterEach(async () => {
    let maintenanceError: unknown;
    try {
      await chatsSvc.waitForChatChunkMaintenance();
    } catch (error) {
      maintenanceError = error;
    }
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(null);
    chatMemoryCacheSvc.__test__.setRefreshChatMemoryCache(null);
    for (const spy of spies.splice(0)) spy.mockRestore();
    closeDatabase();
    if (maintenanceError) throw maintenanceError;
  });
  test("reset listeners receive raw generations outside a nested stale admission context", async () => {
    const previousGeneration = getDbGeneration();
    const observed: Array<{ previousGeneration: number; nextGeneration: number }> = [];
    const unsubscribe = onDbReset((event) => { observed.push(event); });

    runWithDbGeneration(previousGeneration, () => closeDatabase());
    unsubscribe();

    expect(observed).toEqual([{
      previousGeneration,
      nextGeneration: previousGeneration + 1,
    }]);
    initDatabase(":memory:");
    await runMigrations(getDb());
  });
  test("nested reset cancels hung vector cache rebuild and import work before the barrier", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "hung-message", 0, true, "old hung source");
    seedChunk(chat.id, "hung-chunk", ["hung-message"], 1);
    const importChat = createTemporaryChat();
    seedMessage(importChat.id, "hung-import-message", 0, true, "old import source");

    const rebuildEntered = Promise.withResolvers<void>();
    const rebuildGate = Promise.withResolvers<void>();
    let embeddingConfigCalls = 0;
    track(spyOn(embeddingsSvc, "getEmbeddingConfig").mockImplementation(async () => {
      embeddingConfigCalls += 1;
      if (embeddingConfigCalls === 1) {
        rebuildEntered.resolve();
        await rebuildGate.promise;
      }
      return enabledEmbeddingConfig;
    }));
    const rebuild = chatsSvc.rebuildChatChunks(USER_ID, chat.id);
    void rebuild.catch(() => undefined);
    await rebuildEntered.promise;

    const vectorEntered = Promise.withResolvers<void>();
    const vectorGate = Promise.withResolvers<void>();
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(async (tasks) => {
      vectorEntered.resolve();
      await vectorGate.promise;
      getDb().query("UPDATE chat_chunks SET content = 'late-vector' WHERE id = ?").run(tasks[0]!.chunkId);
      return { processedCount: tasks.length, failedChunkIds: [], refreshedChatIds: [] };
    });
    const cacheEntered = Promise.withResolvers<void>();
    const cacheGate = Promise.withResolvers<void>();
    chatMemoryCacheSvc.__test__.setRefreshChatMemoryCache(async (_userId, chatId) => {
      cacheEntered.resolve();
      await cacheGate.promise;
      getDb().query("UPDATE chat_chunks SET content = 'late-cache' WHERE chat_id = ?").run(chatId);
    });

    vectorizationQueueSvc.queueChunkVectorization(USER_ID, chat.id, "hung-chunk", 1);
    chatMemoryCacheSvc.scheduleChatMemoryRefresh(USER_ID, chat.id, 1);
    expect(userDataImportTest.scheduleDerivedVectorProjectionSync(USER_ID)).toBeGreaterThan(0);
    await Promise.all([vectorEntered.promise, cacheEntered.promise]);

    const previousGeneration = getDbGeneration();
    runWithDbGeneration(previousGeneration, () => closeDatabase());
    initDatabase(":memory:");
    await runMigrations(getDb());
    getDb().query(
      'INSERT INTO "user" (id, name, email, emailVerified) VALUES (?, ?, ?, 1)',
    ).run(USER_ID, "Replacement Owner", "replacement-owner@example.test");
    getDb().run("CREATE TABLE lifecycle_probe (stage TEXT PRIMARY KEY)");
    const replacementChat = createTemporaryChat();
    getDb().query("UPDATE chats SET id = ? WHERE id = ?").run(chat.id, replacementChat.id);
    const replacementImportChat = createTemporaryChat();
    getDb().query("UPDATE chats SET id = ? WHERE id = ?").run(importChat.id, replacementImportChat.id);
    seedMessage(chat.id, "hung-message", 0, true, "replacement message");
    seedChunk(chat.id, "hung-chunk", ["hung-message"], 1);
    seedMessage(importChat.id, "hung-import-message", 0, true, "replacement import message");
    seedChunk(importChat.id, "hung-import-chunk", ["hung-import-message"], 1);

    await Promise.race([
      chatsSvc.waitForChatChunkMaintenance(),
      Bun.sleep(250).then(() => { throw new Error("maintenance barrier remained blocked by stale work"); }),
    ]);

    rebuildGate.resolve();
    vectorGate.resolve();
    cacheGate.resolve();
    await Promise.allSettled([rebuild]);
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(getDb().query("SELECT content FROM chat_chunks WHERE id = 'hung-chunk'").get())
      .toEqual({ content: "chunk:hung-chunk" });
    expect(getDb().query("SELECT content FROM chat_chunks WHERE id = 'hung-import-chunk'").get())
      .toEqual({ content: "chunk:hung-import-chunk" });
  });

  test("replacement vectorization starts before a cancelled processor returns", async () => {
    track(spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue(enabledEmbeddingConfig));
    const chat = createTemporaryChat();
    seedMessage(chat.id, "epoch-message", 0, true, "old source");
    seedChunk(chat.id, "epoch-chunk", ["epoch-message"], 1);

    const oldEntered = Promise.withResolvers<void>();
    const oldGate = Promise.withResolvers<void>();
    const replacementEntered = Promise.withResolvers<void>();
    let calls = 0;
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(async (tasks) => {
      calls += 1;
      if (calls === 1) {
        oldEntered.resolve();
        await oldGate.promise;
        getDb().query("UPDATE chat_chunks SET content = 'late-old-processor' WHERE id = ?").run(tasks[0]!.chunkId);
      } else {
        replacementEntered.resolve();
        getDb().query("UPDATE chat_chunks SET content = 'replacement-processed' WHERE id = ?").run(tasks[0]!.chunkId);
      }
      return { processedCount: tasks.length, failedChunkIds: [], refreshedChatIds: [] };
    });

    vectorizationQueueSvc.queueChunkVectorization(USER_ID, chat.id, "epoch-chunk", 1);
    await oldEntered.promise;
    closeDatabase();
    initDatabase(":memory:");
    await runMigrations(getDb());
    getDb().query(
      'INSERT INTO "user" (id, name, email, emailVerified) VALUES (?, ?, ?, 1)',
    ).run(USER_ID, "Replacement Owner", "replacement-owner@example.test");
    const replacementChat = createTemporaryChat();
    getDb().query("UPDATE chats SET id = ? WHERE id = ?").run(chat.id, replacementChat.id);
    seedMessage(chat.id, "epoch-message", 0, true, "replacement source");
    seedChunk(chat.id, "epoch-chunk", ["epoch-message"], 1);

    vectorizationQueueSvc.queueChunkVectorization(USER_ID, chat.id, "epoch-chunk", 1);
    await Promise.race([
      replacementEntered.promise,
      Bun.sleep(250).then(() => { throw new Error("replacement vectorization was blocked by the retired processor"); }),
    ]);
    expect(getDb().query("SELECT content FROM chat_chunks WHERE id = 'epoch-chunk'").get())
      .toEqual({ content: "replacement-processed" });

    oldGate.resolve();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(getDb().query("SELECT content FROM chat_chunks WHERE id = 'epoch-chunk'").get())
      .toEqual({ content: "replacement-processed" });
  });

  test("ordinary old-generation rejection cannot requeue into the replacement epoch", async () => {
    track(spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue(enabledEmbeddingConfig));
    const chat = createTemporaryChat();
    seedMessage(chat.id, "ordinary-message", 0, true, "old source");
    seedChunk(chat.id, "ordinary-chunk", ["ordinary-message"], 1);

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let processorCalls = 0;
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(async () => {
      processorCalls += 1;
      entered.resolve();
      await release.promise;
      throw new Error("ordinary old-generation failure");
    });

    const maintenance = vectorizationQueueSvc.queueChunkVectorization(USER_ID, chat.id, "ordinary-chunk", 1);
    let settlements = 0;
    const observed = maintenance.then(
      () => { settlements += 1; return { status: "resolved" as const }; },
      (reason: unknown) => { settlements += 1; return { status: "rejected" as const, reason }; },
    );
    await entered.promise;
    await replaceDatabaseWithCollision(chat.id, "ordinary-message", "ordinary-chunk");
    release.resolve();

    expect(await observed).toMatchObject({
      status: "rejected",
      reason: { code: "database_generation_cancelled" },
    });
    await Bun.sleep(150);
    expect(vectorizationQueueSvc.getQueueStatus()).toEqual({
      queueLength: 0,
      processing: false,
      chunkJobs: 0,
      worldBookJobs: 0,
    });
    expect(processorCalls).toBe(1);
    expect(settlements).toBe(1);
  });
  test("reset aborts an admitted Lance delete before replacement SQLite mutation", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "lance-message", 0, true, "old source");
    seedChunk(chat.id, "lance-chunk", ["lance-message"], 1);
    const deleteEntered = Promise.withResolvers<void>();
    const deleteGate = Promise.withResolvers<void>();
    let observedSignal: AbortSignal | undefined;
    track(spyOn(embeddingsSvc, "deleteChatChunkEmbeddings").mockImplementation(async (
      _userId,
      _chatId,
      _chunkIds,
      signal,
    ) => {
      observedSignal = signal;
      deleteEntered.resolve();
      await deleteGate.promise;
    }));

    const rebuild = chatsSvc.rebuildChatChunks(USER_ID, chat.id);
    void rebuild.catch(() => undefined);
    await deleteEntered.promise;
    closeDatabase();
    initDatabase(":memory:");
    await runMigrations(getDb());
    getDb().query(
      'INSERT INTO "user" (id, name, email, emailVerified) VALUES (?, ?, ?, 1)',
    ).run(USER_ID, "Replacement Owner", "replacement-owner@example.test");
    const replacementChat = createTemporaryChat();
    getDb().query("UPDATE chats SET id = ? WHERE id = ?").run(chat.id, replacementChat.id);
    seedMessage(chat.id, "lance-message", 0, true, "replacement source");
    seedChunk(chat.id, "lance-chunk", ["lance-message"], 1);

    expect(observedSignal?.aborted).toBe(true);
    deleteGate.resolve();
    await expect(rebuild).rejects.toMatchObject({ code: "database_generation_cancelled" });
    expect(getDb().query("SELECT content FROM chat_chunks WHERE id = 'lance-chunk'").get())
      .toEqual({ content: "chunk:lance-chunk" });
  });
  test("create waits through the deferred cortex callback before database replacement", async () => {
    track(spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue(enabledEmbeddingConfig));
    track(spyOn(memoryCortex, "isCortexEnabledForChat").mockReturnValue(true));

    const cortexEntered = Promise.withResolvers<void>();
    const releaseCortex = Promise.withResolvers<void>();
    track(spyOn(memoryCortex, "scheduleProcessChunk").mockImplementation(async () => {
      cortexEntered.resolve();
      await releaseCortex.promise;
      getDb().query("INSERT INTO lifecycle_probe (stage) VALUES ('cortex')").run();
      return { status: "completed" };
    }));

    const chat = createTemporaryChat();
    const message = chatsSvc.createMessage(chat.id, {
      is_user: true,
      name: "User",
      content: "Remember the deferred callback",
    }, USER_ID);
    expect(message.content).toBe("Remember the deferred callback");

    const maintenance = chatsSvc.waitForChatChunkMaintenance(chat.id);
    const maintenancePending = isPending(maintenance);
    await cortexEntered.promise;
    await Promise.resolve();
    expect(maintenancePending()).toBe(true);

    releaseCortex.resolve();
    await maintenance;
    expect(getDb().query("SELECT stage FROM lifecycle_probe").all()).toEqual([
      { stage: "cortex" },
    ]);

    closeDatabase();
    initDatabase(":memory:");
    getDb().run("CREATE TABLE lifecycle_probe (stage TEXT PRIMARY KEY)");
    expect(getDb().query("SELECT stage FROM lifecycle_probe").all()).toEqual([]);
  });

  test("update waits for surgical rebuild hashing before exposing quiescence", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "message-1", 0, true, "first");
    seedMessage(chat.id, "message-2", 1, false, "second");
    seedMessage(chat.id, "message-3", 2, true, "third");
    seedChunk(chat.id, "preserved-chunk", ["message-1"], 1);
    seedChunk(chat.id, "replaced-chunk", ["message-2", "message-3"], 2);

    let configCalls = 0;
    const hashEntered = Promise.withResolvers<void>();
    const releaseHash = Promise.withResolvers<void>();
    track(spyOn(embeddingsSvc, "getEmbeddingConfig").mockImplementation(async () => {
      configCalls += 1;
      if (configCalls === 2) {
        hashEntered.resolve();
        await releaseHash.promise;
      }
      return enabledEmbeddingConfig;
    }));

    const updated = chatsSvc.updateMessage(USER_ID, "message-2", {
      content: "edited second",
    });
    expect(updated?.content).toBe("edited second");

    const maintenance = chatsSvc.waitForChatChunkMaintenance(chat.id);
    const maintenancePending = isPending(maintenance);
    await hashEntered.promise;
    await Promise.resolve();

    expect(maintenancePending()).toBe(true);
    expect(getDb().query("SELECT id FROM chat_chunks WHERE id = 'preserved-chunk'").get())
      .toEqual({ id: "preserved-chunk" });
    expect(chatsSvc.getChat(USER_ID, chat.id)?.metadata.ltcm_config_hash).toBeUndefined();

    releaseHash.resolve();
    await maintenance;

    expect(chatsSvc.getChat(USER_ID, chat.id)?.metadata.ltcm_config_hash)
      .toEqual(expect.any(String));
    expect(getDb().query("SELECT id FROM chat_chunks WHERE id = 'preserved-chunk'").get())
      .toEqual({ id: "preserved-chunk" });
    expect(getDb().query("SELECT id FROM chat_chunks WHERE id = 'replaced-chunk'").get())
      .toBeNull();
  });

  test("full rebuild awaits hash and cache work and reports maintenance failures", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "message-1", 0, true, "rebuild me");

    const configSpy = track(
      spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue(enabledEmbeddingConfig),
    );
    const refreshEntered = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<void>();
    refreshCacheImpl = async () => {
      refreshEntered.resolve();
      await releaseRefresh.promise;
      getDb().query("INSERT INTO lifecycle_probe (stage) VALUES ('cache')").run();
    };

    const rebuild = chatsSvc.rebuildChatChunks(USER_ID, chat.id);
    const maintenance = chatsSvc.waitForChatChunkMaintenance(chat.id);
    const rebuildPending = isPending(rebuild);
    const maintenancePending = isPending(maintenance);
    await refreshEntered.promise;
    await Promise.resolve();

    expect(rebuildPending()).toBe(true);
    expect(maintenancePending()).toBe(true);
    expect(chatsSvc.getChat(USER_ID, chat.id)?.metadata.ltcm_config_hash)
      .toEqual(expect.any(String));

    releaseRefresh.resolve();
    await Promise.all([rebuild, maintenance]);
    expect(getDb().query("SELECT stage FROM lifecycle_probe").all()).toEqual([
      { stage: "cache" },
    ]);

    const hashFailure = new Error("hash lookup failed");
    let failedConfigCalls = 0;
    configSpy.mockImplementation(async () => {
      failedConfigCalls += 1;
      if (failedConfigCalls === 2) throw hashFailure;
      return enabledEmbeddingConfig;
    });
    refreshCacheImpl = async () => {};

    const failedRebuild = chatsSvc.rebuildChatChunks(USER_ID, chat.id);
    const failedMaintenance = chatsSvc.waitForChatChunkMaintenance(chat.id);
    const [rebuildResult, maintenanceResult] = await Promise.allSettled([
      failedRebuild,
      failedMaintenance,
    ]);

    expect(rebuildResult).toEqual({ status: "rejected", reason: hashFailure });
    expect(maintenanceResult).toEqual({ status: "rejected", reason: hashFailure });
  });
  test("barrier follows the real vector queue timer through a retry", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "retry-message", 0, true, "retry vectorization");
    seedChunk(chat.id, "retry-chunk", ["retry-message"], 1);

    let calls = 0;
    const retryEntered = Promise.withResolvers<void>();
    const releaseRetry = Promise.withResolvers<void>();
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(async (tasks) => {
      calls += 1;
      if (calls === 1) {
        return { processedCount: 0, failedChunkIds: tasks.map((task) => task.chunkId), refreshedChatIds: [] };
      }
      retryEntered.resolve();
      await releaseRetry.promise;
      return { processedCount: tasks.length, failedChunkIds: [], refreshedChatIds: [] };
    });

    vectorizationQueueSvc.queueChunkVectorization(USER_ID, chat.id, "retry-chunk", 1);
    const maintenance = chatsSvc.waitForChatChunkMaintenance(chat.id);
    const maintenancePending = isPending(maintenance);
    await retryEntered.promise;
    await Promise.resolve();
    expect(maintenancePending()).toBe(true);
    expect(calls).toBe(2);

    releaseRetry.resolve();
    await maintenance;
  });

  test("terminal vector failure is retained until the barrier reports it", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "failed-message", 0, true, "fail vectorization");
    seedChunk(chat.id, "failed-chunk", ["failed-message"], 1);
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(async (tasks) => ({
      processedCount: 0,
      failedChunkIds: tasks.map((task) => task.chunkId),
      refreshedChatIds: [],
    }));

    vectorizationQueueSvc.queueChunkVectorization(USER_ID, chat.id, "failed-chunk", 0);
    await expect(chatsSvc.waitForChatChunkMaintenance(chat.id))
      .rejects.toThrow("Chunk vectorization failed after retries: failed-chunk");
  });

  test("barrier includes the cache refresh scheduled after vector persistence", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "cache-message", 0, true, "refresh cache after vectors");
    seedChunk(chat.id, "cache-chunk", ["cache-message"], 1);
    const refreshEntered = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<void>();
    refreshCacheImpl = async () => {
      refreshEntered.resolve();
      await releaseRefresh.promise;
    };
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(async (tasks) => ({
      processedCount: tasks.length,
      failedChunkIds: [],
      refreshedChatIds: [chat.id],
    }));

    vectorizationQueueSvc.queueChunkVectorization(USER_ID, chat.id, "cache-chunk", 1);
    const maintenance = chatsSvc.waitForChatChunkMaintenance(chat.id);
    const maintenancePending = isPending(maintenance);
    await refreshEntered.promise;
    await Promise.resolve();
    expect(maintenancePending()).toBe(true);

    releaseRefresh.resolve();
    await maintenance;
  });

  test("import rebuild is registered before its dynamic import can resolve", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "import-message", 0, true, "rebuild after import");
    track(spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue(enabledEmbeddingConfig));

    const vectorEntered = Promise.withResolvers<void>();
    const releaseVector = Promise.withResolvers<void>();
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(async (tasks) => {
      vectorEntered.resolve();
      await releaseVector.promise;
      return { processedCount: tasks.length, failedChunkIds: [], refreshedChatIds: [] };
    });

    expect(userDataImportTest.scheduleDerivedVectorProjectionSync(USER_ID)).toBeGreaterThan(0);
    const maintenance = chatsSvc.waitForChatChunkMaintenance(chat.id);
    const maintenancePending = isPending(maintenance);
    await vectorEntered.promise;
    await Promise.resolve();
    expect(maintenancePending()).toBe(true);

    releaseVector.resolve();
    await maintenance;
    expect(getDb().query("SELECT COUNT(*) AS count FROM chat_chunks WHERE chat_id = ?").get(chat.id))
      .toEqual({ count: 1 });
  });

  test("stale vector retry cannot write a replacement database with colliding ids", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "collision-message", 0, true, "old vector source");
    seedChunk(chat.id, "collision-chunk", ["collision-message"], 1);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    vectorizationQueueSvc.__test__.setChatChunkBatchProcessor(async (tasks) => {
      entered.resolve();
      await gate.promise;
      getDb().query("UPDATE chat_chunks SET content = 'stale-vector-write' WHERE id = ?")
        .run(tasks[0]!.chunkId);
      return { processedCount: tasks.length, failedChunkIds: [], refreshedChatIds: [] };
    });

    vectorizationQueueSvc.queueChunkVectorization(USER_ID, chat.id, "collision-chunk", 1);
    await entered.promise;
    await replaceDatabaseWithCollision(chat.id, "collision-message", "collision-chunk");
    gate.resolve();
    await chatsSvc.waitForChatChunkMaintenance(chat.id);

    expect(getDb().query("SELECT content FROM chat_chunks WHERE id = 'collision-chunk'").get())
      .toEqual({ content: "chunk:collision-chunk" });
  });

  test("stale cache refresh cannot write a replacement database with colliding ids", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "cache-collision-message", 0, true, "old cache source");
    seedChunk(chat.id, "cache-collision-chunk", ["cache-collision-message"], 1);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    chatMemoryCacheSvc.__test__.setRefreshChatMemoryCache(async (_userId, chatId) => {
      entered.resolve();
      await gate.promise;
      getDb().query("UPDATE chat_chunks SET content = 'stale-cache-write' WHERE chat_id = ?").run(chatId);
    });

    chatMemoryCacheSvc.scheduleChatMemoryRefresh(USER_ID, chat.id, 9);
    await entered.promise;
    await replaceDatabaseWithCollision(chat.id, "cache-collision-message", "cache-collision-chunk");
    gate.resolve();
    await chatsSvc.waitForChatChunkMaintenance(chat.id);

    expect(getDb().query("SELECT content FROM chat_chunks WHERE id = 'cache-collision-chunk'").get())
      .toEqual({ content: "chunk:cache-collision-chunk" });
  });

  test("stale hash continuation cannot stamp colliding replacement chat metadata", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "hash-collision-message", 0, true, "old hash source");
    seedChunk(chat.id, "hash-collision-chunk", ["hash-collision-message"], 1);
    let calls = 0;
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    track(spyOn(embeddingsSvc, "getEmbeddingConfig").mockImplementation(async () => {
      calls += 1;
      if (calls === 2) {
        entered.resolve();
        await gate.promise;
      }
      return enabledEmbeddingConfig;
    }));

    chatsSvc.updateMessage(USER_ID, "hash-collision-message", { content: "old edit" });
    await entered.promise;
    await replaceDatabaseWithCollision(chat.id, "hash-collision-message", "hash-collision-chunk");
    gate.resolve();
    await chatsSvc.waitForChatChunkMaintenance(chat.id);

    expect(chatsSvc.getChat(USER_ID, chat.id)?.metadata.ltcm_config_hash).toBeUndefined();
    expect(chatsSvc.getMessage(USER_ID, "hash-collision-message")?.content).toBe("replacement message");
  });

  test("stale cortex continuation cannot write a colliding replacement database", async () => {
    track(spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue(enabledEmbeddingConfig));
    track(spyOn(memoryCortex, "isCortexEnabledForChat").mockReturnValue(true));
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    track(spyOn(memoryCortex, "scheduleProcessChunk").mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      getDb().query("INSERT INTO lifecycle_probe (stage) VALUES ('stale-cortex')").run();
      return { status: "completed" };
    }));

    const chat = createTemporaryChat();
    const message = chatsSvc.createMessage(chat.id, {
      is_user: true,
      name: "User",
      content: "old cortex source",
    }, USER_ID);
    await entered.promise;
    await replaceDatabaseWithCollision(chat.id, message.id, crypto.randomUUID());
    gate.resolve();
    await chatsSvc.waitForChatChunkMaintenance(chat.id);

    expect(getDb().query("SELECT stage FROM lifecycle_probe").all()).toEqual([]);
  });

  test("stale import microtask cannot rebuild colliding replacement rows", async () => {
    const chat = createTemporaryChat();
    seedMessage(chat.id, "import-collision-message", 0, true, "old import source");

    expect(userDataImportTest.scheduleDerivedVectorProjectionSync(USER_ID)).toBeGreaterThan(0);
    await replaceDatabaseWithCollision(chat.id, "import-collision-message", "import-collision-chunk");
    await chatsSvc.waitForChatChunkMaintenance(chat.id);

    expect(getDb().query("SELECT content FROM chat_chunks WHERE id = 'import-collision-chunk'").get())
      .toEqual({ content: "chunk:import-collision-chunk" });
  });

  test("failure summaries remain bounded, are consumed by the barrier, and never go unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      for (let index = 0; index < 1_000; index += 1) {
        const chatId = `failure-chat-${index % 20}`;
        void trackChatChunkMaintenance(chatId, Promise.reject(new Error(`failure-${index}`)));
      }
      await Bun.sleep(0);
      const snapshot = maintenanceTest.snapshot();
      expect(snapshot.pending).toBe(0);
      expect(snapshot.failures).toBeLessThanOrEqual(256);
      expect(Math.max(...Object.values(snapshot.perChatFailures))).toBeLessThanOrEqual(16);
      await expect(chatsSvc.waitForChatChunkMaintenance()).rejects.toThrow("Chat chunk maintenance failed");
      expect(maintenanceTest.snapshot()).toEqual({ pending: 0, failures: 0, perChatFailures: {} });
      await expect(chatsSvc.waitForChatChunkMaintenance()).resolves.toBeUndefined();
      await Bun.sleep(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

});
