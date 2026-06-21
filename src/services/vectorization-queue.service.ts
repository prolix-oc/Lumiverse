import * as embeddingsSvc from "./embeddings.service";
import { getDb } from "../db/connection";
import { scheduleChatMemoryRefresh } from "./chat-memory-cache.service";
import type { WorldBookEntry, WorldBookVectorIndexStatus } from "../types/world-book";

interface VectorizationJob {
  type: "chunk" | "world_book_entry";
  priority: number;
  userId: string;
  chatId: string;
  chunkId?: string;
  worldBookEntryId?: string;
  queuedAt: number;
}

const WORLD_BOOK_SWEEP_INTERVAL_MS = 60_000;
const WORLD_BOOK_SWEEP_LIMIT_PER_USER = 100;
const CHAT_CHUNK_REQUEUE_LIMIT = 500;

function normalizeWorldBookVectorIndexStatus(row: any): WorldBookVectorIndexStatus {
  if (
    row.vector_index_status === "not_enabled" ||
    row.vector_index_status === "pending" ||
    row.vector_index_status === "indexed" ||
    row.vector_index_status === "error"
  ) {
    return row.vector_index_status;
  }
  return row.vectorized ? "pending" : "not_enabled";
}

function rowToWorldBookEntry(row: any): WorldBookEntry {
  const extensions = JSON.parse(row.extensions);
  const outlet_name = typeof extensions?.outlet_name === "string" && extensions.outlet_name.trim().length > 0
    ? extensions.outlet_name.trim()
    : typeof extensions?.outletName === "string" && extensions.outletName.trim().length > 0
      ? extensions.outletName.trim()
      : null;
  if (extensions && typeof extensions === "object") {
    delete extensions.outlet_name;
    delete extensions.outletName;
  }
  return {
    ...row,
    outlet_name,
    key: JSON.parse(row.key),
    keysecondary: JSON.parse(row.keysecondary),
    role: row.role || null,
    selective: !!row.selective,
    constant: !!row.constant,
    disabled: !!row.disabled,
    group_override: !!row.group_override,
    case_sensitive: !!row.case_sensitive,
    match_whole_words: !!row.match_whole_words,
    use_regex: !!row.use_regex,
    prevent_recursion: !!row.prevent_recursion,
    exclude_recursion: !!row.exclude_recursion,
    delay_until_recursion: !!row.delay_until_recursion,
    use_probability: !!row.use_probability,
    vectorized: !!row.vectorized,
    vector_index_status: normalizeWorldBookVectorIndexStatus(row),
    vector_indexed_at: row.vector_indexed_at ?? null,
    vector_index_error: row.vector_index_error || null,
    scan_depth: row.scan_depth ?? null,
    automation_id: row.automation_id || null,
    extensions,
  };
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
        j.worldBookEntryId === job.worldBookEntryId
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
        const userId = this.queue[0].userId;
        let maxBatch = 10;
        try {
          const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
          maxBatch = Math.max(1, Math.min(cfg.batch_size, 200));
        } catch {}
        const batch = this.takeBatch(maxBatch);

        if (batch[0].type === "chunk") {
          await this.processChunkBatch(batch);
        } else {
          await this.processWorldBookEntryBatch(batch);
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
        .query("SELECT id, content, chat_id, vectorized_at FROM chat_chunks WHERE id = ?")
        .get(job.chunkId!) as any;

      if (chunk && chunk.vectorized_at == null) {
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
      const batchSize = Math.max(1, Math.min(cfg.batch_size, 200));
      const refreshedChats = new Set<string>();
      const failedChunkIds = new Set<string>();

      await embeddingsSvc.embedWithAdaptiveBatching(
        jobs[0].userId,
        chunks,
        batchSize,
        (chunk) => chunk.content,
        async (batchChunks, _texts, vectors) => {
          // Re-confirm each chunk still exists before writing. The embedding
          // API call above can take seconds; a chunk rebuild that ran in that
          // window deletes these rows and mints new chunk UUIDs. Writing now
          // would leave orphaned vectors that retrieval surfaces as duplicate
          // memory-injection entries.
          const batchIds = batchChunks.map((c) => c.id);
          const placeholders = batchIds.map(() => "?").join(",");
          const surviving = new Set(
            (db
              .query(`SELECT id FROM chat_chunks WHERE id IN (${placeholders})`)
              .all(...batchIds) as Array<{ id: string }>).map((r) => r.id),
          );

          const batchItems: Array<{ chatId: string; chunkId: string; vector: number[]; content: string }> = [];
          const writtenChunks: Array<{ id: string; content: string; chatId: string }> = [];
          batchChunks.forEach((chunk, i) => {
            if (!surviving.has(chunk.id)) return;
            batchItems.push({
              chatId: chunk.chatId,
              chunkId: chunk.id,
              vector: vectors[i],
              content: chunk.content,
            });
            writtenChunks.push(chunk);
          });

          if (batchItems.length === 0) return;

          await embeddingsSvc.batchUpsertChunkVectors(jobs[0].userId, batchItems);

          const now = Math.floor(Date.now() / 1000);
          // Mark the whole batch vectorized in one statement instead of N
          // per-row UPDATEs (writtenChunks is bounded by the embed batch size,
          // well under the SQLite variable limit). Mirrors the databank path.
          const updatePlaceholders = writtenChunks.map(() => "?").join(", ");
          db.query(
            `UPDATE chat_chunks SET vectorized_at = ?, vector_model = ? WHERE id IN (${updatePlaceholders})`
          ).run(now, cfg.model, ...writtenChunks.map((c) => c.id));
          for (const chunk of writtenChunks) refreshedChats.add(chunk.chatId);
        },
        (failedItems, error) => {
          console.warn(`[vectorization] Failed to embed ${failedItems.length} chunk(s):`, error.message);
          for (const chunk of failedItems) failedChunkIds.add(chunk.id);
        },
        { label: "chat-chunks" },
      );

      for (const job of jobs) {
        if (job.chunkId && failedChunkIds.has(job.chunkId) && job.priority > 0) {
          this.add({ ...job, priority: job.priority - 1 });
        }
      }

      for (const chatId of refreshedChats) {
        scheduleChatMemoryRefresh(jobs[0].userId, chatId, 7);

        // Self-heal: drop any vectors left over from a previous chunk
        // generation that a concurrent rebuild couldn't clean up. Reading
        // chat_chunks here is safe because a chunk row is always inserted
        // before its vector is written, so live chunks are never seen as
        // orphans. An empty set is left alone (chat may be mid-rebuild).
        try {
          const liveIds = (db
            .query("SELECT id FROM chat_chunks WHERE chat_id = ?")
            .all(chatId) as Array<{ id: string }>).map((r) => r.id);
          await embeddingsSvc.reconcileChatChunkEmbeddings(jobs[0].userId, chatId, liveIds);
        } catch (err) {
          console.warn(`[vectorization] Orphan reconcile failed for chat ${chatId}:`, err);
        }
      }

      if (chunks.length > failedChunkIds.size) {
        console.info(`[vectorization] Processed ${chunks.length - failedChunkIds.size} chunk(s)`);
      }
    } catch (err) {
      console.warn("[vectorization] Chunk batch failed, requeueing with lower priority", err);
      for (const job of jobs) {
        if (job.priority > 0) {
          this.add({ ...job, priority: job.priority - 1 });
        }
      }
    }
  }

  private async processWorldBookEntryBatch(jobs: VectorizationJob[]) {
    const entryIds = Array.from(new Set(jobs.map((job) => job.worldBookEntryId).filter((id): id is string => !!id)));
    if (entryIds.length === 0) return;

    const placeholders = entryIds.map(() => "?").join(", ");
    const rows = getDb()
      .query(`
        SELECT e.*, wb.name AS world_book_name
        FROM world_book_entries e
        JOIN world_books wb ON wb.id = e.world_book_id
        WHERE wb.user_id = ?
          AND e.id IN (${placeholders})
          AND (e.vector_index_status != 'indexed' OR e.vector_index_status IS NULL)
        ORDER BY wb.name COLLATE NOCASE, e.updated_at ASC
      `)
      .all(jobs[0].userId, ...entryIds) as any[];

    if (rows.length === 0) return;

    const entries = rows.map(rowToWorldBookEntry);
    const bookCounts = new Map<string, number>();
    for (const row of rows) {
      const name = String(row.world_book_name || "Untitled world book");
      bookCounts.set(name, (bookCounts.get(name) ?? 0) + 1);
    }
    const bookParts = Array.from(bookCounts.entries()).map(([name, count]) => `${name} (${count})`);
    const bookLabel = bookParts.length === 1
      ? bookParts[0]
      : `${bookParts.slice(0, 5).join(", ")}${bookParts.length > 5 ? `, +${bookParts.length - 5} more books` : ""}`;
    try {
      const cfg = await embeddingsSvc.getEmbeddingConfig(jobs[0].userId);
      await embeddingsSvc.reindexWorldBookEntries(jobs[0].userId, entries, {
        batchSize: Math.max(1, Math.min(cfg.batch_size, entries.length, 200)),
        optimizeAfter: false,
        rebuildVectorIndex: false,
      });
      console.info(`[vectorization] Processed ${entries.length} world book entr${entries.length === 1 ? "y" : "ies"} for ${bookParts.length === 1 ? bookLabel : `multiple books: ${bookLabel}`}`);
    } catch (err) {
      const errorMsg = String(err instanceof Error ? err.message : err);
      console.warn("[vectorization] World book batch failed, marked as error:", errorMsg);
      for (const job of jobs) {
        if (job.worldBookEntryId) {
          getDb().query("UPDATE world_book_entries SET vector_index_status = 'error', vector_index_error = ? WHERE id = ?").run(errorMsg, job.worldBookEntryId);
        }
      }
    }
  }

  getStatus() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      chunkJobs: this.queue.filter((j) => j.type === "chunk").length,
      worldBookJobs: this.queue.filter((j) => j.type === "world_book_entry").length,
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

export function queuePendingChatChunkVectorization(userId: string, chatId: string, priority = 4): number {
  const rows = getDb().query(
    `SELECT id
     FROM chat_chunks
     WHERE chat_id = ? AND vectorized_at IS NULL
     ORDER BY updated_at ASC, created_at ASC`,
  ).all(chatId) as Array<{ id: string }>;

  for (const row of rows) {
    queueChunkVectorization(userId, chatId, row.id, priority);
  }

  return rows.length;
}

export async function queueStaleChatChunkVectorization(limit = CHAT_CHUNK_REQUEUE_LIMIT, priority = 2): Promise<number> {
  const rows = getDb().query(
    `SELECT cc.id, cc.chat_id, c.user_id
     FROM chat_chunks cc
     JOIN chats c ON c.id = cc.chat_id
     WHERE cc.vectorized_at IS NULL
     ORDER BY c.updated_at DESC, cc.updated_at ASC, cc.created_at ASC
     LIMIT ?`,
  ).all(Math.max(1, limit)) as Array<{ id: string; chat_id: string; user_id: string }>;

  const eligibleUsers = new Map<string, boolean>();
  let queued = 0;
  for (const row of rows) {
    let eligible = eligibleUsers.get(row.user_id);
    if (eligible === undefined) {
      const cfg = await embeddingsSvc.getEmbeddingConfig(row.user_id);
      eligible = !!(cfg.enabled && cfg.vectorize_chat_messages && cfg.has_api_key);
      eligibleUsers.set(row.user_id, eligible);
    }
    if (!eligible) continue;
    queueChunkVectorization(row.user_id, row.chat_id, row.id, priority);
    queued++;
  }

  return queued;
}

export function queueWorldBookEntryVectorization(userId: string, entryId: string, priority = 4) {
  queue.add({
    type: "world_book_entry",
    priority,
    userId,
    chatId: "",
    worldBookEntryId: entryId,
    queuedAt: Date.now(),
  });
}

function sweepWorldBookVectorizationQueue() {
  void (async () => {
    try {
      const users = getDb().query(
        `SELECT DISTINCT wb.user_id as user_id
         FROM world_book_entries e
         JOIN world_books wb ON wb.id = e.world_book_id
         WHERE e.vectorized = 1`
      ).all() as Array<{ user_id: string }>;

      for (const { user_id: userId } of users) {
        const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
        if (!cfg.enabled || !cfg.vectorize_world_books || !cfg.has_api_key) continue;

        const rows = getDb().query(
          `SELECT e.id
           FROM world_book_entries e
           JOIN world_books wb ON wb.id = e.world_book_id
           WHERE wb.user_id = ?
             AND e.vectorized = 1
             AND e.disabled = 0
             AND length(trim(e.content)) > 0
             AND e.vector_index_status IN ('pending', 'error', 'not_enabled')
           ORDER BY CASE e.vector_index_status
             WHEN 'pending' THEN 0
             WHEN 'error' THEN 1
             ELSE 2
           END,
           COALESCE(e.vector_indexed_at, 0) ASC,
           e.updated_at ASC
           LIMIT ?`
        ).all(userId, WORLD_BOOK_SWEEP_LIMIT_PER_USER) as Array<{ id: string }>;

        for (const row of rows) {
          queueWorldBookEntryVectorization(userId, row.id, 2);
        }
      }
    } catch (err) {
      console.warn("[vectorization] World book sweep failed:", err);
    }
  })();
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

let _queryCacheCleanupTimer: ReturnType<typeof setInterval> | null = null;
let _worldBookSweepTimer: ReturnType<typeof setInterval> | null = null;

export function startVectorizationQueueMaintenance(): void {
  if (!_queryCacheCleanupTimer) {
    _queryCacheCleanupTimer = setInterval(cleanupQueryCache, 3600_000);
  }
  if (!_worldBookSweepTimer) {
    _worldBookSweepTimer = setInterval(sweepWorldBookVectorizationQueue, WORLD_BOOK_SWEEP_INTERVAL_MS);
  }

  // Kick off a passive startup scan so pre-existing pending entries don't have to
  // wait for the first interval tick before being picked up.
  sweepWorldBookVectorizationQueue();
}

export function stopQueryCacheCleanup(): void {
  if (_queryCacheCleanupTimer) {
    clearInterval(_queryCacheCleanupTimer);
    _queryCacheCleanupTimer = null;
  }
}

export function stopWorldBookVectorizationSweep(): void {
  if (_worldBookSweepTimer) {
    clearInterval(_worldBookSweepTimer);
    _worldBookSweepTimer = null;
  }
}
