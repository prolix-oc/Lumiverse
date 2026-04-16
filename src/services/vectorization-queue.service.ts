import * as embeddingsSvc from "./embeddings.service";
import { getDb } from "../db/connection";
import { scheduleChatMemoryRefresh } from "./chat-memory-cache.service";

interface VectorizationJob {
  type: "chunk" | "query";
  priority: number;
  userId: string;
  chatId: string;
  chunkId?: string;
  queryText?: string;
  queryHash?: string;
  queuedAt: number;
}

class VectorizationQueue {
  private queue: VectorizationJob[] = [];
  private processing = false;
  private processingTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Add a job to the vectorization queue with priority-based ordering.
   */
  add(job: VectorizationJob) {
    const existing = this.queue.findIndex(
      (j) =>
        j.type === job.type &&
        j.userId === job.userId &&
        j.chatId === job.chatId &&
        j.chunkId === job.chunkId &&
        j.queryHash === job.queryHash
    );

    if (existing >= 0) {
      this.queue[existing].priority = Math.max(this.queue[existing].priority, job.priority);
      return;
    }

    this.queue.push(job);
    this.queue.sort((a, b) => b.priority - a.priority);
    this.scheduleProcessing();
  }

  private scheduleProcessing() {
    if (this.processingTimer) return;
    this.processingTimer = setTimeout(() => {
      this.processingTimer = null;
      this.processQueue();
    }, 100);
  }

  private async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const batch = this.takeBatch(10);

        if (batch[0].type === "chunk") {
          await this.processChunkBatch(batch);
        } else {
          await this.processQueryBatch(batch);
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      this.processing = false;
    }
  }

  private takeBatch(maxSize: number): VectorizationJob[] {
    if (this.queue.length === 0) return [];

    const firstType = this.queue[0].type;
    const firstUserId = this.queue[0].userId;

    const batch: VectorizationJob[] = [];
    let i = 0;

    while (i < this.queue.length && batch.length < maxSize) {
      if (this.queue[i].type === firstType && this.queue[i].userId === firstUserId) {
        batch.push(this.queue.splice(i, 1)[0]);
      } else {
        i++;
      }
    }

    return batch;
  }

  private async processChunkBatch(jobs: VectorizationJob[]) {
    const db = getDb();
    const chunks: Array<{ id: string; content: string; chatId: string }> = [];

    for (const job of jobs) {
      const chunk = db
        .query("SELECT id, content, chat_id FROM chat_chunks WHERE id = ?")
        .get(job.chunkId!) as any;

      if (chunk) {
        chunks.push({
          id: chunk.id,
          content: chunk.content,
          chatId: chunk.chat_id,
        });
      }
    }

    if (chunks.length === 0) return;

    try {
      const cfg = await embeddingsSvc.getEmbeddingConfig(jobs[0].userId);
      const texts = chunks.map((c) => c.content);
      const vectors = await embeddingsSvc.embedTexts(jobs[0].userId, texts);
      const refreshedChats = new Set<string>();

      // Batch upsert all vectors in a single LanceDB mergeInsert call
      // to avoid creating one fragment per chunk (main cause of slow queries).
      const batchItems = chunks.map((chunk, i) => ({
        chatId: chunk.chatId,
        chunkId: chunk.id,
        vector: vectors[i],
        content: chunk.content,
      }));
      await embeddingsSvc.batchUpsertChunkVectors(jobs[0].userId, batchItems);

      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < chunks.length; i++) {
        db.query(
          "UPDATE chat_chunks SET vectorized_at = ?, vector_model = ? WHERE id = ?"
        ).run(now, cfg.model, chunks[i].id);
        refreshedChats.add(chunks[i].chatId);
      }

      for (const chatId of refreshedChats) {
        scheduleChatMemoryRefresh(jobs[0].userId, chatId, 7);
      }

      console.info(`[vectorization] Processed ${chunks.length} chunk(s)`);
    } catch (err) {
      console.warn("[vectorization] Chunk batch failed, requeueing with lower priority", err);
      for (const job of jobs) {
        if (job.priority > 0) {
          this.add({ ...job, priority: job.priority - 1 });
        }
      }
    }
  }

  private async processQueryBatch(jobs: VectorizationJob[]) {
    const db = getDb();

    for (const job of jobs) {
      try {
        const [vector] = await embeddingsSvc.embedTexts(job.userId, [job.queryText!]);
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = now + 300;

        db.query(
          `INSERT INTO query_vector_cache (id, chat_id, query_hash, query_text, vector_json, hit_count, created_at, last_used_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
           ON CONFLICT(chat_id, query_hash) DO UPDATE SET
             vector_json = excluded.vector_json,
             last_used_at = excluded.last_used_at,
             expires_at = excluded.expires_at`
        ).run(
          crypto.randomUUID(),
          job.chatId,
          job.queryHash!,
          job.queryText!,
          JSON.stringify(vector),
          now,
          now,
          expiresAt
        );

        console.info(`[vectorization] Cached query vector for chat ${job.chatId}`);
      } catch (err) {
        console.warn("[vectorization] Query vectorization failed", err);
      }
    }
  }

  getStatus() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      chunkJobs: this.queue.filter((j) => j.type === "chunk").length,
      queryJobs: this.queue.filter((j) => j.type === "query").length,
    };
  }
}

const queue = new VectorizationQueue();

export function queueChunkVectorization(userId: string, chatId: string, chunkId: string, priority = 5) {
  queue.add({
    type: "chunk",
    priority,
    userId,
    chatId,
    chunkId,
    queuedAt: Date.now(),
  });
}

export function queueQueryVectorization(
  userId: string,
  chatId: string,
  queryText: string,
  queryHash: string,
  priority = 10
) {
  queue.add({
    type: "query",
    priority,
    userId,
    chatId,
    queryText,
    queryHash,
    queuedAt: Date.now(),
  });
}

export function getQueueStatus() {
  return queue.getStatus();
}

/**
 * Clean up expired query vector cache entries.
 * Should be called periodically (e.g., every hour).
 */
export function cleanupQueryCache() {
  const now = Math.floor(Date.now() / 1000);
  const result = getDb().query("DELETE FROM query_vector_cache WHERE expires_at < ?").run(now);
  if (result.changes > 0) {
    console.info(`[vectorization] Cleaned up ${result.changes} expired query cache entries`);
  }
}

let _queryCacheCleanupTimer: ReturnType<typeof setInterval> | null = setInterval(cleanupQueryCache, 3600_000);

export function stopQueryCacheCleanup(): void {
  if (_queryCacheCleanupTimer) {
    clearInterval(_queryCacheCleanupTimer);
    _queryCacheCleanupTimer = null;
  }
}
