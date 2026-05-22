/**
 * Summarize Pool Service
 *
 * Lightweight per-chat tracker for in-flight Loom summary generations. Unlike
 * the main generation pool, summaries are request/response (no streamed
 * tokens) so we only need a minimal {active, startedAt, generationId} record
 * plus WS signalling so frontends can recover state across chat switches,
 * tabs, and reconnects.
 *
 * The `/generate/summarize` route registers on entry, `completePool`/`failPool`
 * on exit. A WS listener on the frontend flips the summary slice's flag when
 * the pool transitions.
 */
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

export interface SummarizePoolEntry {
  /** Uniquely identifies this summary job — not tied to any LLM generationId */
  generationId: string;
  userId: string;
  chatId: string;
  startedAt: number;
}

/** Primary index: "userId:chatId" → entry */
const pool = new Map<string, SummarizePoolEntry>();

/** Safety cap: sweep entries older than this in case of a crash before completion */
const STALE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SWEEP_INTERVAL_MS = 60 * 1000; // 60 seconds

function key(userId: string, chatId: string): string {
  return `${userId}:${chatId}`;
}

/**
 * Register a new summary job. Emits `SUMMARIZATION_STARTED`.
 *
 * If an entry already exists for (userId, chatId), it is replaced — the caller
 * may be a second tab initiating a new run, and we want WS listeners to treat
 * that as a fresh start rather than silently discarding the new `generationId`.
 */
export function startSummarizePool(opts: {
  generationId: string;
  userId: string;
  chatId: string;
}): void {
  const entry: SummarizePoolEntry = {
    generationId: opts.generationId,
    userId: opts.userId,
    chatId: opts.chatId,
    startedAt: Date.now(),
  };
  pool.set(key(opts.userId, opts.chatId), entry);
  eventBus.emit(
    EventType.SUMMARIZATION_STARTED,
    { chatId: opts.chatId, generationId: opts.generationId, startedAt: entry.startedAt },
    opts.userId,
  );
}

/**
 * Mark a summary job as completed. Emits `SUMMARIZATION_COMPLETED` and removes
 * the pool entry. No-op if the entry was already cleared (e.g. by a later
 * registration from another tab).
 */
export function completeSummarizePool(opts: {
  generationId: string;
  userId: string;
  chatId: string;
}): void {
  const k = key(opts.userId, opts.chatId);
  const entry = pool.get(k);
  if (entry && entry.generationId === opts.generationId) {
    pool.delete(k);
  }
  eventBus.emit(
    EventType.SUMMARIZATION_COMPLETED,
    { chatId: opts.chatId, generationId: opts.generationId },
    opts.userId,
  );
}

/**
 * Mark a summary job as failed. Emits `SUMMARIZATION_FAILED` and removes the
 * pool entry. No-op on the map if a later registration replaced us.
 */
export function failSummarizePool(opts: {
  generationId: string;
  userId: string;
  chatId: string;
  error: string;
}): void {
  const k = key(opts.userId, opts.chatId);
  const entry = pool.get(k);
  if (entry && entry.generationId === opts.generationId) {
    pool.delete(k);
  }
  eventBus.emit(
    EventType.SUMMARIZATION_FAILED,
    { chatId: opts.chatId, generationId: opts.generationId, error: opts.error },
    opts.userId,
  );
}

/**
 * Look up the current in-flight summary for (userId, chatId), if any.
 */
export function getSummarizePoolEntry(userId: string, chatId: string): SummarizePoolEntry | undefined {
  return pool.get(key(userId, chatId));
}

// ── Sweep ────────────────────────────────────────────────────────────────────

function sweep(): void {
  const now = Date.now();
  for (const [k, entry] of pool) {
    if (now - entry.startedAt > STALE_TTL_MS) {
      pool.delete(k);
      // Emit a failed event so any listening frontends resolve their local
      // flag. Without this, a crashed handler would leave the UI spinner
      // stuck until a manual refresh.
      eventBus.emit(
        EventType.SUMMARIZATION_FAILED,
        { chatId: entry.chatId, generationId: entry.generationId, error: "Summary timed out" },
        entry.userId,
      );
    }
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startSummarizePoolSweep(): void {
  if (!sweepTimer) {
    sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  }
}

export function stopSummarizePoolSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

// Auto-start sweep on module load
startSummarizePoolSweep();
