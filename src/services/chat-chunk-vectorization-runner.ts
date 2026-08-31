import { getDb } from "../db/connection";
import * as embeddingsSvc from "./embeddings.service";

export interface ChatChunkVectorizationTask {
  userId: string;
  chatId: string;
  chunkId: string;
}

export interface ChatChunkVectorizationBatchResult {
  refreshedChatIds: string[];
  failedChunkIds: string[];
  processedCount: number;
}

interface ProcessChatChunkVectorizationBatchOptions {
  signal?: AbortSignal;
}

function assertBatchActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

export async function processChatChunkVectorizationBatch(
  tasks: ChatChunkVectorizationTask[],
  options?: ProcessChatChunkVectorizationBatchOptions,
): Promise<ChatChunkVectorizationBatchResult> {
  if (tasks.length === 0) {
    return { refreshedChatIds: [], failedChunkIds: [], processedCount: 0 };
  }

  assertBatchActive(options?.signal);
  const db = getDb();
  const chunks: Array<{
    id: string;
    content: string;
    chatId: string;
    messageIds: string[];
    messageCount: number;
    tokenCount: number;
  }> = [];

  for (const task of tasks) {
    assertBatchActive(options?.signal);
    const chunk = db
      .query("SELECT id, content, chat_id, vectorized_at, message_ids, message_count, token_count FROM chat_chunks WHERE id = ?")
      .get(task.chunkId) as any;

    if (chunk && chunk.vectorized_at == null) {
      let messageIds: string[] = [];
      try {
        const parsed = JSON.parse(chunk.message_ids || "[]");
        if (Array.isArray(parsed)) {
          messageIds = parsed.filter((id): id is string => typeof id === "string");
        }
      } catch {
        messageIds = [];
      }
      chunks.push({
        id: chunk.id,
        content: chunk.content,
        chatId: chunk.chat_id,
        messageIds,
        messageCount: Number(chunk.message_count ?? messageIds.length ?? 0),
        tokenCount: Number(chunk.token_count ?? 0),
      });
    }
  }

  if (chunks.length === 0) {
    return { refreshedChatIds: [], failedChunkIds: [], processedCount: 0 };
  }

  const cfg = await embeddingsSvc.getEmbeddingConfig(tasks[0].userId);
  assertBatchActive(options?.signal);
  const batchSize = Math.max(1, Math.min(cfg.batch_size, 200));
  const refreshedChats = new Set<string>();
  const failedChunkIds = new Set<string>();

  await embeddingsSvc.embedWithAdaptiveBatching(
    tasks[0].userId,
    chunks,
    batchSize,
    (chunk) => chunk.content,
    async (batchChunks, _texts, vectors) => {
      assertBatchActive(options?.signal);
      // Re-confirm each chunk still exists before writing. The embedding API call
      // above can take seconds; a chunk rebuild that ran in that window deletes
      // these rows and mints new chunk UUIDs. Writing now would leave orphaned
      // vectors that retrieval surfaces as duplicate memory-injection entries.
      const batchIds = batchChunks.map((chunk) => chunk.id);
      const placeholders = batchIds.map(() => "?").join(",");
      assertBatchActive(options?.signal);
      const surviving = new Set(
        (db
          .query(`SELECT id FROM chat_chunks WHERE id IN (${placeholders})`)
          .all(...batchIds) as Array<{ id: string }>).map((row) => row.id),
      );

      const batchItems: Array<{
        chatId: string;
        chunkId: string;
        vector: number[];
        content: string;
        metadata: Record<string, any>;
      }> = [];
      const writtenChunks: Array<{
        id: string;
        content: string;
        chatId: string;
        messageIds: string[];
        messageCount: number;
        tokenCount: number;
      }> = [];
      batchChunks.forEach((chunk, i) => {
        if (!surviving.has(chunk.id)) return;
        batchItems.push({
          chatId: chunk.chatId,
          chunkId: chunk.id,
          vector: vectors[i],
          content: chunk.content,
          metadata: {
            chunkId: chunk.id,
            messageIds: chunk.messageIds,
          },
        });
        writtenChunks.push(chunk);
      });

      if (batchItems.length === 0) return;

      assertBatchActive(options?.signal);
      await embeddingsSvc.batchUpsertChunkVectors(tasks[0].userId, batchItems, options?.signal);
      assertBatchActive(options?.signal);

      const now = Math.floor(Date.now() / 1000);
      const updatePlaceholders = writtenChunks.map(() => "?").join(", ");
      assertBatchActive(options?.signal);
      db.query(
        `UPDATE chat_chunks SET vectorized_at = ?, vector_model = ? WHERE id IN (${updatePlaceholders})`,
      ).run(now, cfg.model, ...writtenChunks.map((chunk) => chunk.id));
      for (const chunk of writtenChunks) refreshedChats.add(chunk.chatId);
    },
    async (failedItems, error) => {
      if (!options?.signal?.aborted && failedItems.length === 1) {
        const [chunk] = failedItems;
        console.warn("[vectorization] Terminal chat chunk embedding failure:", {
          chunkId: chunk.id,
          chatId: chunk.chatId,
          sourceChars: chunk.content.length,
          sourceTokensApprox: chunk.tokenCount,
          messageCount: chunk.messageCount,
          messageIdCount: chunk.messageIds.length,
          model: cfg.model,
          timeoutSeconds: cfg.request_timeout,
          error: error.message,
        });

        try {
          assertBatchActive(options?.signal);
          const recovered = await embeddingsSvc.tryRecoverChatChunkEmbeddingWithAutoSplit(
            tasks[0].userId,
            chunk.chatId,
            chunk.id,
            chunk.content,
            error,
            {
              chunkId: chunk.id,
              messageIds: chunk.messageIds,
            },
            chunk.tokenCount,
            { signal: options?.signal },
          );
          assertBatchActive(options?.signal);
          if (recovered.recovered) {
            if (!recovered.skipped) {
              assertBatchActive(options?.signal);
              db.query("UPDATE chat_chunks SET vectorized_at = ?, vector_model = ? WHERE id = ?")
                .run(Math.floor(Date.now() / 1000), cfg.model, chunk.id);
              refreshedChats.add(chunk.chatId);
            }
            return;
          }
        } catch (recoveryErr) {
          assertBatchActive(options?.signal);
          const recoveryError = recoveryErr instanceof Error ? recoveryErr : new Error(String(recoveryErr));
          console.warn("[vectorization] Chat chunk auto-split recovery failed:", {
            chunkId: chunk.id,
            chatId: chunk.chatId,
            error: recoveryError.message,
          });
        }
      }

      console.warn(`[vectorization] Failed to embed ${failedItems.length} chunk(s):`, error.message);
      for (const chunk of failedItems) failedChunkIds.add(chunk.id);
    },
    { label: "chat-chunks", signal: options?.signal },
  );
  assertBatchActive(options?.signal);

  for (const chatId of refreshedChats) {
    assertBatchActive(options?.signal);
    // Self-heal: drop any vectors left over from a previous chunk generation
    // that a concurrent rebuild couldn't clean up.
    try {
      const liveIds = (db
        .query("SELECT id FROM chat_chunks WHERE chat_id = ?")
        .all(chatId) as Array<{ id: string }>).map((row) => row.id);
      assertBatchActive(options?.signal);
      await embeddingsSvc.reconcileChatChunkEmbeddings(tasks[0].userId, chatId, liveIds, options?.signal);
      assertBatchActive(options?.signal);
    } catch (err) {
      assertBatchActive(options?.signal);
      console.warn(`[vectorization] Orphan reconcile failed for chat ${chatId}:`, err);
    }
  }

  return {
    refreshedChatIds: Array.from(refreshedChats),
    failedChunkIds: Array.from(failedChunkIds),
    processedCount: Math.max(0, chunks.length - failedChunkIds.size),
  };
}
