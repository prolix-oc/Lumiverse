import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import * as embeddingsSvc from "./embeddings.service";
import * as memoryCortex from "./memory-cortex";
import * as vectorizationQueue from './vectorization-queue.service';
import { resetChatPipelineCoordinatorForTests, getChatPipelineStatus } from "./chat-pipeline-coordinator.service";
import { getChatChunks, rebuildChatChunksFromMessages, createMessage, updateMessage } from "./chats.service";

const USER_ID = "chunk-order-user";
const CHAT_ID = "chunk-order-chat";

function seedChat(messageCount: number): void {
  const db = getDb();
  db.query(
    `INSERT INTO "user" (id, name, email, emailVerified)
     VALUES (?, 'Chunk Tester', 'chunks@example.test', 1)`,
  ).run(USER_ID);
  db.query(
    `INSERT INTO characters (id, user_id, name)
     VALUES ('chunk-character', ?, 'Chunk Character')`,
  ).run(USER_ID);
  db.query(
    `INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at)
     VALUES (?, ?, 'chunk-character', 'Chunk Chat', '{}', 1, 1)`,
  ).run(CHAT_ID, USER_ID);

  for (let index = 0; index < messageCount; index++) {
    const messageId = `message-${index}`;
    const chunkId = `chunk-${index}`;
    db.query(
      `INSERT INTO messages (
         id, chat_id, index_in_chat, is_user, name, content, send_date,
         swipe_id, swipes, swipe_dates, extra, created_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, '[]', '{}', 1, 1)`,
    ).run(
      messageId,
      CHAT_ID,
      index,
      index % 2,
      index % 2 ? "User" : "Character",
      `content-${index}`,
      index + 1,
      JSON.stringify([`content-${index}`]),
    );
    db.query(
      `INSERT INTO chat_chunks (
         id, chat_id, start_message_id, end_message_id, message_ids, content,
         token_count, message_count, message_range_start, message_range_end,
         created_at, updated_at, vectorized_at, cortex_warmup_signature
       ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 100, 100, 100, 'warm')`,
    ).run(
      chunkId,
      CHAT_ID,
      messageId,
      messageId,
      JSON.stringify([messageId]),
      `content-${index}`,
      index,
      index,
    );
  }
}

describe("chat chunk rebuild ordering", () => {
  let configSpy: ReturnType<typeof spyOn>;
  let deleteEmbeddingsSpy: ReturnType<typeof spyOn>;
  let queueSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await runMigrations(getDb());
    resetChatPipelineCoordinatorForTests();
    configSpy = spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue({
      enabled: true,
      vectorize_chat_messages: true,
      model: "test-model",
      retrieval_top_k: 4,
      preferred_context_size: 6,
      similarity_threshold: 0,
      chat_memory_mode: null,
    } as any);
    deleteEmbeddingsSpy = spyOn(embeddingsSvc, "deleteChatChunkEmbeddings")
      .mockResolvedValue(undefined);
    queueSpy = spyOn(vectorizationQueue, 'queueChunkVectorization').mockImplementation(() => {});
  });

  afterEach(async () => {
    // Surgical rebuilds enqueue a debounced cache refresh; keep its test dependencies alive until it drains.
    await Bun.sleep(120);
    configSpy.mockRestore();
    deleteEmbeddingsSpy.mockRestore();
    queueSpy.mockRestore();
    resetChatPipelineCoordinatorForTests();
    closeDatabase();
  });

  test("orders same-second chunks by message position despite the DESC timestamp index", () => {
    seedChat(4);

    expect(getChatChunks(USER_ID, CHAT_ID).map((chunk) => chunk.id)).toEqual([
      "chunk-0",
      "chunk-1",
      "chunk-2",
      "chunk-3",
    ]);
  });

  test('authored insertion and role changes rebuild the affected chunk sequence', async () => {
    seedChat(3);
    const wait = async () => {
      for (let i = 0; i < 100; i++) {
        await Bun.sleep(2);
        const status = getChatPipelineStatus(CHAT_ID);
        if (!status?.running && !status?.queuedTasks.length) return;
      }
      throw new Error('Chunk rebuild did not finish');
    };
    const inserted = createMessage(CHAT_ID, { content: 'inserted', is_user: true, name: 'User' }, USER_ID, undefined, 'message-1', true);
    await wait();
    expect(getChatChunks(USER_ID, CHAT_ID).flatMap(chunk => chunk.message_ids)).toEqual(['message-0', inserted.id, 'message-1', 'message-2']);
    updateMessage(USER_ID, inserted.id, { is_user: false });
    await wait();
    const chunks = getChatChunks(USER_ID, CHAT_ID);
    expect(chunks.flatMap(chunk => chunk.message_ids)).toEqual(['message-0', inserted.id, 'message-1', 'message-2']);
    expect(chunks.find(chunk => chunk.message_ids.includes(inserted.id))?.content).toContain('[CHARACTER | User]: inserted');
  });

  test("a staged reply enters memory once, when it is finalized with its text", async () => {
    seedChat(1);
    const vectorizationSpy = spyOn(embeddingsSvc, "isChatMemoryVectorizationEnabled").mockReturnValue(true);
    const cortexEnabledSpy = spyOn(memoryCortex, "isCortexEnabledForChat").mockReturnValue(true);
    const processChunkSpy = spyOn(memoryCortex, "scheduleProcessChunk").mockResolvedValue({ status: "completed" });
    try {
      const staged = createMessage(CHAT_ID, { is_user: false, name: "Character", content: "" }, USER_ID);
      await Bun.sleep(30);
      expect(processChunkSpy).not.toHaveBeenCalled();
      expect(getChatChunks(USER_ID, CHAT_ID).flatMap((chunk) => chunk.message_ids)).not.toContain(staged.id);

      updateMessage(USER_ID, staged.id, { content: "The finished reply.", finalizesStaged: true });
      for (let i = 0; i < 100 && processChunkSpy.mock.calls.length === 0; i++) await Bun.sleep(2);

      expect(processChunkSpy).toHaveBeenCalledTimes(1);
      const chunk = processChunkSpy.mock.calls[0]![0];
      expect(chunk.content).toContain("The finished reply.");
      expect(chunk.messageIds).toContain(staged.id);
    } finally {
      vectorizationSpy.mockRestore();
      cortexEnabledSpy.mockRestore();
      processChunkSpy.mockRestore();
    }
  });

  test("a rebuild while a reply streams leaves it to be chunked once, at finalize", async () => {
    seedChat(2);
    const vectorizationSpy = spyOn(embeddingsSvc, "isChatMemoryVectorizationEnabled").mockReturnValue(true);
    try {
      const staged = createMessage(CHAT_ID, { is_user: false, name: "Character", content: "" }, USER_ID);
      await rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["message-0"]);
      expect(getChatChunks(USER_ID, CHAT_ID).flatMap((chunk) => chunk.message_ids)).not.toContain(staged.id);

      updateMessage(USER_ID, staged.id, { content: "The finished reply.", finalizesStaged: true });
      const chunks = () => getChatChunks(USER_ID, CHAT_ID);
      for (let i = 0; i < 100 && !chunks().some((chunk) => chunk.content.includes("The finished reply.")); i++) await Bun.sleep(2);

      expect(chunks().flatMap((chunk) => chunk.message_ids).filter((id) => id === staged.id)).toEqual([staged.id]);
    } finally {
      vectorizationSpy.mockRestore();
    }
  });

  test("an empty user message, such as an image on its own, is still chunked", async () => {
    seedChat(1);
    const vectorizationSpy = spyOn(embeddingsSvc, "isChatMemoryVectorizationEnabled").mockReturnValue(true);
    try {
      const imageOnly = createMessage(CHAT_ID, { is_user: true, name: "User", content: "" }, USER_ID);
      const chunkedIds = () => getChatChunks(USER_ID, CHAT_ID).flatMap((chunk) => chunk.message_ids);
      for (let i = 0; i < 100 && !chunkedIds().includes(imageOnly.id); i++) await Bun.sleep(2);
      expect(chunkedIds()).toContain(imageOnly.id);
    } finally {
      vectorizationSpy.mockRestore();
    }
  });

  test("coalesces overlapping deleted-message rebuilds to the earliest surgical boundary", async () => {
    seedChat(3);
    const db = getDb();

    db.query("DELETE FROM messages WHERE id = ?").run("message-2");
    const later = rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["message-2"]);
    db.query("DELETE FROM messages WHERE id = ?").run("message-1");
    const earlier = rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["message-1"]);

    await Promise.all([later, earlier]);

    expect(db.query(
      `SELECT id, cortex_warmup_signature
       FROM chat_chunks WHERE chat_id = ? ORDER BY message_range_start`,
    ).all(CHAT_ID)).toEqual([
      { id: "chunk-0", cortex_warmup_signature: "warm" },
    ]);
    expect(deleteEmbeddingsSpy).toHaveBeenCalledTimes(1);
    expect(deleteEmbeddingsSpy).toHaveBeenCalledWith(
      USER_ID,
      CHAT_ID,
      ["chunk-1", "chunk-2"],
    );
  });
});
