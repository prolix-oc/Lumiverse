import * as embeddingsSvc from "./embeddings.service";
import {
  DatabaseGenerationCancelledError,
  assertDbGeneration,
  getDb,
  getDbGeneration,
  getDbGenerationSignal,
  isDatabaseGenerationCancellation,
  onDbReset,
  raceDbGenerationCancellation,
  runWithDbGeneration,
} from "../db/connection";
import { scheduleChatMemoryRefresh } from "./chat-memory-cache.service";
import {
  cancelChatChunkVectorizationGeneration,
  canUseChatChunkVectorizationSubprocess,
  isChatChunkVectorizationSubprocessStartupError,
  processChatChunkVectorizationBatchInSubprocess,
  shutdownChatChunkVectorizationSubprocess,
  warnChatChunkVectorizationFallback,
} from "./chat-chunk-vectorization-client";
import {
  processChatChunkVectorizationBatch,
  type ChatChunkVectorizationBatchResult,
  type ChatChunkVectorizationTask,
} from "./chat-chunk-vectorization-runner";
import { isLanceDbMaintenanceRunning } from "./lancedb-maintenance-supervisor";
import type { WorldBookEntry, WorldBookVectorIndexStatus } from "../types/world-book";
import {
  desiredWorldBookVectorIndexStatus,
  isWorldBookEntryVectorEligible,
  worldBookVectorSettingsFingerprint,
} from "./world-book-vector-state";
import { loadWorldBookVectorSettings } from "./world-book-vector-settings.service";
import { trackChatChunkMaintenance } from "./chat-chunk-maintenance.service";

interface MaintenanceSettlement {
  settled?: boolean;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

interface VectorizationJob {
  generation: number;
  signal: AbortSignal;
  type: "chunk" | "world_book_entry";
  priority: number;
  userId: string;
  chatId: string;
  chunkId?: string;
  worldBookEntryId?: string;
  supersedesIndexed?: boolean;
  queuedAt: number;
  settlements?: MaintenanceSettlement[];
}

let chatChunkBatchProcessorOverride:
  | ((tasks: ChatChunkVectorizationTask[], signal: AbortSignal, generation: number) => Promise<ChatChunkVectorizationBatchResult>)
  | null = null;

const WORLD_BOOK_SWEEP_INTERVAL_MS = 60_000;
const WORLD_BOOK_SWEEP_LIMIT_PER_USER = 100;
const CHAT_CHUNK_REQUEUE_LIMIT = 500;
/** Coalesce lorebook-edit reindexes so typing does not native-write LanceDB each save. */
const WORLD_BOOK_VECTOR_SETTLE_MS = 2_500;
const WORLD_BOOK_VECTOR_MAX_WAIT_MS = 15_000;
const WORLD_BOOK_MAINTENANCE_POLL_MS = 250;

function normalizeWorldBookVectorIndexStatus(row: any): WorldBookVectorIndexStatus {
  if (
    row.vector_index_status === "not_enabled" ||
    row.vector_index_status === "pending" ||
    row.vector_index_status === "indexed" ||
    row.vector_index_status === "error"
  ) {
    return row.vector_index_status;
  }
  return desiredWorldBookVectorIndexStatus({
    vectorized: !!row.vectorized,
    disabled: !!row.disabled,
    content: typeof row.content === "string" ? row.content : "",
  });
}
function mergeVectorizationJobs(existing: VectorizationJob, incoming: VectorizationJob): void {
  existing.priority = Math.max(existing.priority, incoming.priority);
  existing.supersedesIndexed = !!(existing.supersedesIndexed || incoming.supersedesIndexed);
  if (incoming.settlements?.length) {
    existing.settlements = [...(existing.settlements ?? []), ...incoming.settlements];
  }
}

function resolveVectorizationJob(job: VectorizationJob): void {
  for (const settlement of job.settlements ?? []) {
    if (settlement.settled) continue;
    settlement.settled = true;
    settlement.resolve();
  }
}

function rejectVectorizationJob(job: VectorizationJob, reason: unknown): void {
  for (const settlement of job.settlements ?? []) {
    if (settlement.settled) continue;
    settlement.settled = true;
    settlement.reject(reason);
  }
}

function remainingWorldBookSettleMs(queuedAt: number, now: number): number {
  const age = now - queuedAt;
  if (age >= WORLD_BOOK_VECTOR_MAX_WAIT_MS) return 0;
  return Math.max(0, WORLD_BOOK_VECTOR_SETTLE_MS - age);
}

function worldBookJobsHaveSettled(jobs: Array<Pick<VectorizationJob, "type" | "queuedAt">>, now: number): boolean {
  const worldBookJobs = jobs.filter((job) => job.type === "world_book_entry");
  if (worldBookJobs.length === 0) return true;
  const oldest = Math.min(...worldBookJobs.map((job) => job.queuedAt));
  if (now - oldest >= WORLD_BOOK_VECTOR_MAX_WAIT_MS) return true;
  return worldBookJobs.every((job) => remainingWorldBookSettleMs(job.queuedAt, now) === 0);
}

function nextProcessDelayMs(jobs: Array<Pick<VectorizationJob, "type" | "queuedAt">>, now: number): number {
  let delay = 100;
  for (const job of jobs) {
    if (job.type !== "world_book_entry") continue;
    delay = Math.max(delay, remainingWorldBookSettleMs(job.queuedAt, now));
  }
  return delay;
}

function shouldProcessWorldBookVectorizationJob(row: any, job: VectorizationJob | undefined): boolean {
  return normalizeWorldBookVectorIndexStatus(row) !== "indexed" || job?.supersedesIndexed === true;
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
  private processingEpoch: number | null = null;
  private processorEpoch = 0;
  private processingTimer: ReturnType<typeof setTimeout> | null = null;
  private activeBatch: VectorizationJob[] = [];

  /**
   * Add a job to the vectorization queue with priority-based ordering.
   */
  add(job: VectorizationJob) {
    const existing = this.queue.findIndex(
      (j) =>
        j.generation === job.generation &&
        j.type === job.type &&
        j.userId === job.userId &&
        j.chatId === job.chatId &&
        j.chunkId === job.chunkId &&
        j.worldBookEntryId === job.worldBookEntryId,
    );

    if (existing >= 0) {
      mergeVectorizationJobs(this.queue[existing], job);
      this.queue[existing].queuedAt = job.queuedAt;
      this.scheduleProcessing();
      return;
    }

    this.queue.push(job);
    this.queue.sort((a, b) => b.priority - a.priority);
    this.scheduleProcessing();
  }

  private scheduleProcessing() {
    if (this.processingTimer) {
      clearTimeout(this.processingTimer);
      this.processingTimer = null;
    }
    const epoch = this.processorEpoch;
    const delayMs = nextProcessDelayMs(this.queue, Date.now());
    this.processingTimer = setTimeout(() => {
      this.processingTimer = null;
      void this.processQueue(epoch).catch((error) => {
        if (!isDatabaseGenerationCancellation(error)) {
          console.error("[vectorization] Queue processing failed:", error);
        }
      });
    }, delayMs);
  }

  private async awaitLanceMaintenanceIdle(generation: number): Promise<void> {
    while (isLanceDbMaintenanceRunning()) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, WORLD_BOOK_MAINTENANCE_POLL_MS);
      await raceDbGenerationCancellation(generation, promise);
    }
  }

  private async processQueue(epoch: number) {
    if (
      epoch !== this.processorEpoch
      || this.processingEpoch === epoch
      || this.queue.length === 0
    ) return;
    this.processingEpoch = epoch;
    let admittedGeneration: number | null = null;

    try {
      while (epoch === this.processorEpoch && this.queue.length > 0) {
        if (this.queue[0].type === "world_book_entry") {
          if (!worldBookJobsHaveSettled(this.queue, Date.now())) {
            this.scheduleProcessing();
            return;
          }
          await this.awaitLanceMaintenanceIdle(this.queue[0].generation);
          if (epoch !== this.processorEpoch) return;
          if (this.queue.length === 0 || this.queue[0].type !== "world_book_entry") continue;
          if (!worldBookJobsHaveSettled(this.queue, Date.now())) {
            this.scheduleProcessing();
            return;
          }
        }
        const generation = this.queue[0].generation;
        admittedGeneration = generation;
        const userId = this.queue[0].userId;
        let maxBatch = 10;
        try {
          const cfg = await runWithDbGeneration(
            generation,
            () => embeddingsSvc.getEmbeddingConfig(userId),
          );
          maxBatch = Math.max(1, Math.min(cfg.batch_size, 200));
        } catch (error) {
          this.assertProcessorEpoch(epoch, generation);
          if (isDatabaseGenerationCancellation(error)) {
            if (epoch !== this.processorEpoch) return;
            this.invalidateStale(generation, error.currentGeneration);
            continue;
          }
        }
        if (epoch !== this.processorEpoch) return;
        const batch = this.takeBatch(maxBatch, generation);
        if (batch.length === 0) continue;
        this.activeBatch = batch;

        try {
          await runWithDbGeneration(generation, async () => {
            if (batch[0]!.type === "chunk") {
              await this.processChunkBatch(batch, generation, batch[0]!.signal, epoch);
            } else {
              await this.processWorldBookEntryBatch(batch, generation, batch[0]!.signal, epoch);
            }
          });
        } catch (error) {
          this.assertProcessorEpoch(epoch, generation);
          if (!isDatabaseGenerationCancellation(error)) throw error;
          for (const job of batch) rejectVectorizationJob(job, error);
        } finally {
          if (this.activeBatch === batch) {
            this.assertProcessorEpoch(epoch, generation);
            this.activeBatch = [];
          }
        }

        if (epoch !== this.processorEpoch) return;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 100);
        await promise;
      }
    } finally {
      if (this.processingEpoch === epoch) {
        if (admittedGeneration !== null) this.assertProcessorEpoch(epoch, admittedGeneration);
        this.processingEpoch = null;
        if (this.queue.length > 0) this.scheduleProcessing();
      }
    }
  }

  private takeBatch(maxSize: number, generation: number): VectorizationJob[] {
    if (this.queue.length === 0) return [];

    const firstType = this.queue[0].type;
    const firstUserId = this.queue[0].userId;
    const firstGeneration = generation;

    const batch: VectorizationJob[] = [];
    let i = 0;

    while (i < this.queue.length && batch.length < maxSize) {
      if (
        this.queue[i].generation === firstGeneration &&
        this.queue[i].type === firstType &&
        this.queue[i].userId === firstUserId
      ) {
        batch.push(this.queue.splice(i, 1)[0]);
      } else {
        i++;
      }
    }

    return batch;
  }

  private async processChunkBatch(
    jobs: VectorizationJob[],
    generation: number,
    signal: AbortSignal,
    epoch: number,
  ) {
    try {
      const tasks = jobs
        .filter((job): job is VectorizationJob & { chunkId: string } => typeof job.chunkId === "string" && job.chunkId.length > 0)
        .map<ChatChunkVectorizationTask>((job) => ({
          userId: job.userId,
          chatId: job.chatId,
          chunkId: job.chunkId,
        }));
      if (tasks.length !== jobs.length) {
        throw new Error("Chunk vectorization queue contained a job without a chunk id");
      }

      let result: ChatChunkVectorizationBatchResult;
      if (chatChunkBatchProcessorOverride) {
        result = await chatChunkBatchProcessorOverride(tasks, signal, generation);
      } else if (canUseChatChunkVectorizationSubprocess()) {
        try {
          result = await processChatChunkVectorizationBatchInSubprocess(tasks, generation, signal);
        } catch (err) {
          if (!isChatChunkVectorizationSubprocessStartupError(err)) throw err;
          warnChatChunkVectorizationFallback();
          result = await processChatChunkVectorizationBatch(tasks, { signal });
        }
      } else {
        warnChatChunkVectorizationFallback();
        result = await processChatChunkVectorizationBatch(tasks, { signal });
      }
      this.assertProcessorEpoch(epoch, generation);

      const failedChunkIds = new Set(result.failedChunkIds);

      for (const chatId of result.refreshedChatIds) {
        scheduleChatMemoryRefresh(jobs[0].userId, chatId, 7);
      }

      for (const job of jobs) {
        if (job.chunkId && failedChunkIds.has(job.chunkId)) {
          if (job.priority > 0) {
            this.add({ ...job, priority: job.priority - 1 });
          } else {
            const failure = new Error(`Chunk vectorization failed after retries: ${job.chunkId}`);
            console.error("[vectorization] Terminal chunk failure:", failure);
            rejectVectorizationJob(job, failure);
          }
        } else {
          resolveVectorizationJob(job);
        }
      }

      if (result.processedCount > 0) {
        console.info(`[vectorization] Processed ${result.processedCount} chunk(s)`);
      }
    } catch (err) {
      this.assertProcessorEpoch(epoch, generation);
      if (isDatabaseGenerationCancellation(err)) {
        for (const job of jobs) rejectVectorizationJob(job, err);
        return;
      }
      console.warn("[vectorization] Chunk batch failed, requeueing with lower priority", err);
      for (const job of jobs) {
        if (job.priority > 0) {
          this.add({ ...job, priority: job.priority - 1 });
        } else {
          rejectVectorizationJob(job, err);
        }
      }
    }
  }

  private async processWorldBookEntryBatch(
    jobs: VectorizationJob[],
    generation: number,
    signal: AbortSignal,
    epoch: number,
  ) {
    this.assertProcessorEpoch(epoch, generation);
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
        ORDER BY wb.name COLLATE NOCASE, e.updated_at ASC
      `)
      .all(jobs[0].userId, ...entryIds) as any[];

    const jobsByEntryId = new Map(jobs.map((job) => [job.worldBookEntryId, job] as const));
    const rowsToProcess = rows.filter((row) => shouldProcessWorldBookVectorizationJob(row, jobsByEntryId.get(String(row.id))));
    if (rowsToProcess.length === 0) return;

    const entries = rowsToProcess.map(rowToWorldBookEntry);
    const settingsFingerprint = worldBookVectorSettingsFingerprint(loadWorldBookVectorSettings(jobs[0].userId));
    const bookCounts = new Map<string, number>();
    for (const row of rowsToProcess) {
      const name = String(row.world_book_name || "Untitled world book");
      bookCounts.set(name, (bookCounts.get(name) ?? 0) + 1);
    }
    const bookParts = Array.from(bookCounts.entries()).map(([name, count]) => `${name} (${count})`);
    const bookLabel = bookParts.length === 1
      ? bookParts[0]
      : `${bookParts.slice(0, 5).join(", ")}${bookParts.length > 5 ? `, +${bookParts.length - 5} more books` : ""}`;
    let configFingerprint: string | null = null;
    try {
      const cfg = await embeddingsSvc.getEmbeddingConfig(jobs[0].userId);
      this.assertProcessorEpoch(epoch, generation);
      configFingerprint = embeddingsSvc.getWorldBookVectorWriteFingerprint(cfg);
      await embeddingsSvc.reindexWorldBookEntries(jobs[0].userId, entries, {
        batchSize: Math.max(1, Math.min(cfg.batch_size, entries.length, 200)),
        force: true,
        optimizeAfter: false,
        rebuildVectorIndex: false,
        signal,
      });
      this.assertProcessorEpoch(epoch, generation);
      console.info(`[vectorization] Processed ${entries.length} world book entr${entries.length === 1 ? "y" : "ies"} for ${bookParts.length === 1 ? bookLabel : `multiple books: ${bookLabel}`}`);
    } catch (err) {
      this.assertProcessorEpoch(epoch, generation);
      if (isDatabaseGenerationCancellation(err)) throw err;
      const errorMsg = String(err instanceof Error ? err.message : err);
      console.warn("[vectorization] World book batch failed, marked as error:", errorMsg);
      if (configFingerprint) {
        await embeddingsSvc.markWorldBookEntriesVectorErrorIfCurrent(
          jobs[0].userId,
          entries.filter(isWorldBookEntryVectorEligible),
          errorMsg,
          settingsFingerprint,
          configFingerprint,
        );
      } else {
        console.warn("[vectorization] Skipped world-book error-state update because the job config fingerprint was unavailable");
      }
    }
  }

  private assertProcessorEpoch(epoch: number, generation: number): void {
    if (epoch !== this.processorEpoch) {
      throw new DatabaseGenerationCancelledError(generation, getDbGeneration());
    }
    assertDbGeneration(generation);
  }

  invalidateStale(previousGeneration: number, currentGeneration: number): void {
    if (this.processingTimer) {
      clearTimeout(this.processingTimer);
      this.processingTimer = null;
    }
    this.processorEpoch += 1;
    this.processingEpoch = null;
    const retiredBatch = this.activeBatch;
    this.activeBatch = [];
    cancelChatChunkVectorizationGeneration(previousGeneration, currentGeneration);
    for (const job of retiredBatch) {
      if (job.generation === previousGeneration) {
        rejectVectorizationJob(
          job,
          new DatabaseGenerationCancelledError(previousGeneration, currentGeneration),
        );
      }
    }
    const retained: VectorizationJob[] = [];
    for (const job of this.queue) {
      if (job.generation === currentGeneration) {
        retained.push(job);
        continue;
      }
      rejectVectorizationJob(
        job,
        new DatabaseGenerationCancelledError(job.generation, currentGeneration),
      );
    }
    this.queue = retained;
    if (this.queue.length > 0) this.scheduleProcessing();
  }

  getStatus() {
    return {
      queueLength: this.queue.length,
      processing: this.processingEpoch !== null,
      chunkJobs: this.queue.filter((j) => j.type === "chunk").length,
      worldBookJobs: this.queue.filter((j) => j.type === "world_book_entry").length,
    };
  }
}

const queue = new VectorizationQueue();
onDbReset(({ previousGeneration, nextGeneration }) => {
  queue.invalidateStale(previousGeneration, nextGeneration);
});

export function queueChunkVectorization(userId: string, chatId: string, chunkId: string, priority = 5): Promise<void> {
  const generation = getDbGeneration();
  const signal = getDbGenerationSignal(generation);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const tracked = trackChatChunkMaintenance(chatId, promise, generation);
  queue.add({
    generation,
    signal,
    type: "chunk",
    priority,
    userId,
    chatId,
    chunkId,
    queuedAt: Date.now(),
    settlements: [{ resolve, reject }],
  });
  return tracked;
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

export function queueWorldBookEntryVectorization(
  userId: string,
  entryId: string,
  priority = 4,
  supersedesIndexed = false,
) {
  const generation = getDbGeneration();
  queue.add({
    generation,
    signal: getDbGenerationSignal(generation),
    type: "world_book_entry",
    priority,
    userId,
    chatId: "",
    worldBookEntryId: entryId,
    supersedesIndexed,
    queuedAt: Date.now(),
  });
}

function sweepWorldBookVectorizationQueue() {
  const generation = getDbGeneration();
  let sweep: Promise<void>;
  try {
    sweep = runWithDbGeneration(generation, async () => {
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
    });
  } catch (err) {
    if (!isDatabaseGenerationCancellation(err)) {
      console.warn("[vectorization] World book sweep admission failed:", err);
    }
    return;
  }
  void sweep.catch((err) => {
    if (!isDatabaseGenerationCancellation(err)) {
      console.warn("[vectorization] World book sweep failed:", err);
    }
  });
}

export function getQueueStatus() {
  return queue.getStatus();
}

export const __test__ = {
  mergeVectorizationJobs,
  shouldProcessWorldBookVectorizationJob,
  WORLD_BOOK_VECTOR_SETTLE_MS,
  WORLD_BOOK_VECTOR_MAX_WAIT_MS,
  worldBookJobsHaveSettled,
  remainingWorldBookSettleMs,
  nextProcessDelayMs,
  setChatChunkBatchProcessor(
    processor: ((tasks: ChatChunkVectorizationTask[]) => Promise<ChatChunkVectorizationBatchResult>) | null,
  ): void {
    chatChunkBatchProcessorOverride = processor;
  },
};

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

export function stopChatChunkVectorizationWorker(): Promise<void> {
  return shutdownChatChunkVectorizationSubprocess();
}
