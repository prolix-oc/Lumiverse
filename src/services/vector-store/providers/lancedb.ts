/**
 * LanceDB vector store provider.
 *
 * This is the ONLY module that imports `@lancedb/lancedb`. It contains all of the
 * LanceDB infrastructure that historically lived inline in
 * `embeddings.service.ts` — connection singleton, write lock + cross-process
 * Termux lock, read/maintenance gate, table-handle cache, schema-drift &
 * broken-table recovery, index management, optimize scheduling, the world-book
 * split migration, and the per-table health reader — moved here VERBATIM (only
 * imports/exports adjusted).
 *
 * On top of the infra it exposes a {@link LanceDbStore} that implements the
 * provider-neutral {@link VectorStore} contract, plus a {@link translateFilter}
 * that renders a structured {@link VectorFilter} into a LanceDB SQL `where()`
 * string using the same `sqlValue` quoting the inline code used.
 *
 * IMPORTANT: this module MUST NOT import embeddings.service.ts (one-directional
 * dependency: embeddings.service → lancedb.ts). Embedding *generation* stays in
 * embeddings.service.ts.
 */
import { connect, Index, type Connection, type Table } from "@lancedb/lancedb";

export type { Table } from "@lancedb/lancedb";
import { dirname, join } from "path";
import { mkdirSync, readdirSync, renameSync, rmSync, existsSync, readFileSync } from "fs";
import { env } from "../../../env";
import { getDb } from "../../../db/connection";
import { embeddingCache } from "../../embedding-cache";
import { resolveBrokenTermuxLanceDbMirrorPath, resolveLanceDbConnectUri } from "../../../utils/lancedb-path";
import type { WorldBookVectorIndexStatus } from "../../../types/world-book";
import { LANCEDB_CAPABILITIES } from "../capabilities";
import { toSimilarity } from "../addressing";
import type {
  CollectionName,
  LexicalSearchOptions,
  ProviderCapabilities,
  SearchOptions,
  TableHealth,
  VectorFilter,
  VectorHit,
  VectorRow,
  VectorStore,
  VectorStoreProviderId,
} from "../types";

export const LANCEDB_PATH = join(env.dataDir, "lancedb");
export const LANCEDB_URI = resolveLanceDbConnectUri(LANCEDB_PATH);
export const EMBEDDINGS_TABLE = "embeddings";
export const WORLD_BOOK_EMBEDDINGS_TABLE = "embeddings_world_books";
const TERMUX_PATH_PREFIX = "/data/data/com.termux/";
export const LANCEDB_TERMUX_LIKE = Boolean(process.env.TERMUX_VERSION)
  || process.env.LUMIVERSE_IS_TERMUX === "true"
  || process.env.LUMIVERSE_IS_PROOT === "true"
  || process.env.PREFIX?.startsWith(TERMUX_PATH_PREFIX) === true
  || process.env.HOME?.startsWith(`${TERMUX_PATH_PREFIX}files/home`) === true
  || LANCEDB_PATH.startsWith(TERMUX_PATH_PREFIX);

/**
 * Row shape stored in LanceDB. Identical field set to {@link VectorRow}; kept as
 * its own alias so the historical local code reads unchanged.
 */
export type EmbeddingRow = VectorRow;

type LanceRow = Record<string, unknown>;

export function asLanceRows(rows: EmbeddingRow[]): LanceRow[] {
  return rows as unknown as LanceRow[];
}

let loggedUnknownLegacyWorldBookVectorShape = false;

export function coerceLanceVector(raw: unknown): number[] {
  if (raw instanceof Float32Array || raw instanceof Float64Array) {
    return Array.from(raw);
  }
  if (Array.isArray(raw)) {
    return raw.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  }
  if (raw && typeof raw === "object") {
    const iterable = raw as Iterable<unknown>;
    if (typeof (raw as { toArray?: unknown }).toArray === "function") {
      try {
        return coerceLanceVector((raw as { toArray: () => unknown }).toArray());
      } catch {}
    }
    if (typeof iterable[Symbol.iterator] === "function") {
      try {
        return coerceLanceVector(Array.from(iterable));
      } catch {}
    }
    const indexed = raw as { length?: unknown; [key: number]: unknown };
    if (typeof indexed.length === "number" && Number.isFinite(indexed.length) && indexed.length > 0) {
      try {
        const values = Array.from({ length: indexed.length }, (_, idx) => indexed[idx]);
        return coerceLanceVector(values);
      } catch {}
    }
    const candidate = raw as { values?: unknown; data?: unknown; vector?: unknown };
    if (candidate.values !== undefined) return coerceLanceVector(candidate.values);
    if (candidate.data !== undefined) return coerceLanceVector(candidate.data);
    if (candidate.vector !== undefined) return coerceLanceVector(candidate.vector);
    if (!loggedUnknownLegacyWorldBookVectorShape) {
      loggedUnknownLegacyWorldBookVectorShape = true;
      try {
        const ctor = (raw as { constructor?: { name?: string } }).constructor?.name || typeof raw;
        const keys = Object.keys(raw as Record<string, unknown>).slice(0, 12);
        console.warn(`[embeddings] Unknown legacy world-book vector payload shape: constructor=${ctor}; keys=${keys.join(",") || "(none)"}`);
      } catch {}
    }
  }
  return [];
}

let connPromise: Promise<Connection> | null = null;
let connHandle: Connection | null = null;
let connGeneration = 0;
let lancedbPathDiagnosticsLogged = false;
let optimizeTimer: ReturnType<typeof setTimeout> | null = null;
const OPTIMIZE_DEBOUNCE_MS = 15_000; // 15 seconds after last write (reduced from 30s)
/** Grace period for version cleanup — keeps old versions alive long enough for
 *  in-flight reads to complete. Without this, optimize() can delete manifests
 *  that concurrent queries still reference, causing "Object not found" errors. */
const CLEANUP_GRACE_PERIOD_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// Write serialization — prevents concurrent LanceDB mutations from racing.
// LanceDB's internal conflict resolver panics when optimize() deletes version
// manifests that in-flight mergeInsert() operations still reference.
// Serializing all writes through a single async mutex eliminates this entirely.
//
// Safety bounds:
//   - Lock acquisition times out after WRITE_LOCK_WAIT_TIMEOUT_MS to prevent
//     unbounded queue growth when LanceDB operations are slow or hung.
//   - The queue is capped at MAX_WRITE_LOCK_QUEUE to reject new work instead
//     of piling up indefinitely behind a slow lock holder.
// ---------------------------------------------------------------------------
const WRITE_LOCK_WAIT_TIMEOUT_MS = 120_000; // 120s max wait to acquire the lock
const MAX_WRITE_LOCK_QUEUE = 50;           // reject if more than 50 waiters queued
const CROSS_PROCESS_WRITE_LOCK_DIR = join(env.dataDir, ".lancedb-write-lock");
const CROSS_PROCESS_WRITE_LOCK_INFO = join(CROSS_PROCESS_WRITE_LOCK_DIR, "owner.json");
const CROSS_PROCESS_WRITE_LOCK_POLL_MS = 250;
const CROSS_PROCESS_WRITE_LOCK_STALE_MS = 5 * 60_000;
const _writeLockQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
let _writeLockHeld = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryWriteCrossProcessLockInfo(): void {
  try {
    Bun.write(
      CROSS_PROCESS_WRITE_LOCK_INFO,
      JSON.stringify({
        pid: process.pid,
        acquiredAt: Date.now(),
        cwd: process.cwd(),
      }),
    ).catch(() => {});
  } catch {}
}

function readCrossProcessLockInfo(): { pid?: number; acquiredAt?: number } | null {
  try {
    if (!existsSync(CROSS_PROCESS_WRITE_LOCK_INFO)) return null;
    const raw = readFileSync(CROSS_PROCESS_WRITE_LOCK_INFO, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; acquiredAt?: unknown };
    return {
      pid: typeof parsed.pid === "number" && Number.isFinite(parsed.pid) ? parsed.pid : undefined,
      acquiredAt: typeof parsed.acquiredAt === "number" && Number.isFinite(parsed.acquiredAt) ? parsed.acquiredAt : undefined,
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shouldBreakStaleCrossProcessLock(): boolean {
  if (!existsSync(CROSS_PROCESS_WRITE_LOCK_DIR)) return false;

  const info = readCrossProcessLockInfo();
  const ageMs = info?.acquiredAt ? Date.now() - info.acquiredAt : Number.POSITIVE_INFINITY;
  if (ageMs < CROSS_PROCESS_WRITE_LOCK_STALE_MS) return false;
  if (info?.pid && isProcessAlive(info.pid)) return false;
  return true;
}

async function acquireCrossProcessWriteLockIfNeeded(): Promise<(() => void) | null> {
  if (!LANCEDB_TERMUX_LIKE) return null;

  const startedAt = Date.now();
  while (true) {
    try {
      mkdirSync(CROSS_PROCESS_WRITE_LOCK_DIR, { recursive: false });
      tryWriteCrossProcessLockInfo();
      return () => {
        try {
          rmSync(CROSS_PROCESS_WRITE_LOCK_DIR, { recursive: true, force: true });
        } catch {}
      };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;

      if (shouldBreakStaleCrossProcessLock()) {
        try {
          rmSync(CROSS_PROCESS_WRITE_LOCK_DIR, { recursive: true, force: true });
          console.warn(`[embeddings] Cleared stale cross-process LanceDB write lock at ${CROSS_PROCESS_WRITE_LOCK_DIR}`);
          continue;
        } catch {}
      }

      const waitedMs = Date.now() - startedAt;
      if (waitedMs >= WRITE_LOCK_WAIT_TIMEOUT_MS) {
        throw new Error(
          `[embeddings] Cross-process LanceDB write lock acquisition timed out after ${WRITE_LOCK_WAIT_TIMEOUT_MS}ms (${CROSS_PROCESS_WRITE_LOCK_DIR})`,
        );
      }

      await sleep(Math.min(CROSS_PROCESS_WRITE_LOCK_POLL_MS, WRITE_LOCK_WAIT_TIMEOUT_MS - waitedMs));
    }
  }
}

export async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!_writeLockHeld) {
    _writeLockHeld = true;
  } else {
    if (_writeLockQueue.length >= MAX_WRITE_LOCK_QUEUE) {
      throw new Error(`[embeddings] Write lock queue full (${_writeLockQueue.length} waiters) — rejecting to prevent resource exhaustion`);
    }
    await new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject };
      _writeLockQueue.push(entry);
      const timer = setTimeout(() => {
        const idx = _writeLockQueue.indexOf(entry);
        if (idx >= 0) {
          _writeLockQueue.splice(idx, 1);
          reject(new Error(`[embeddings] Write lock acquisition timed out after ${WRITE_LOCK_WAIT_TIMEOUT_MS}ms (${_writeLockQueue.length} still queued)`));
        }
      }, WRITE_LOCK_WAIT_TIMEOUT_MS);
      // Clear the timer if the lock is acquired before timeout
      const origResolve = entry.resolve;
      entry.resolve = () => { clearTimeout(timer); origResolve(); };
    });
  }
  const releaseCrossProcessLock = await acquireCrossProcessWriteLockIfNeeded();
  try {
    return await fn();
  } finally {
    releaseCrossProcessLock?.();
    const next = _writeLockQueue.shift();
    if (next) next.resolve();
    else _writeLockHeld = false;
  }
}

// ---------------------------------------------------------------------------
// Read / maintenance mutual exclusion.
//
// LanceDB maintenance ops unlink files out from under readers: optimize() with
// cleanupOlderThan DELETES superseded version files, and createIndex(replace)
// rewrites index files. A native read scanning those files when they vanish
// faults — uncatchably (SIGBUS/SIGSEGV) when mmap is on, or as a catchable
// "failed to get next batch from stream: Lance error: not found" when it's off
// (the default). Either way the read is lost.
//
// CLEANUP_GRACE_PERIOD_MS shields freshly-superseded versions. On top of that,
// reads and file-mutating maintenance are made mutually exclusive:
//   - reads gate through beginRead() before opening a scan,
//   - maintenance gates through withMaintenanceExclusive(), which blocks NEW
//     reads from starting and then waits for in-flight reads to drain before it
//     touches files.
// A bare drain (wait-then-mutate) is not enough on its own: it is a one-shot
// barrier, but reads never take the write lock, so a read could still START
// during the mutation. The gate closes that window from both sides. All
// cancellable native reads flow through raceWithSignal() — route any new native
// read through it too.
// ---------------------------------------------------------------------------
let _activeReadCount = 0;
// Non-null while a file-mutating maintenance op holds exclusivity; resolves when
// it finishes. New reads await it before opening a scan. Maintenance ops always
// run under withWriteLock(), so only one is ever active and the gate has a
// single owner at a time.
let _maintenanceGate: Promise<void> | null = null;

/**
 * Block until any in-progress file-mutating maintenance op finishes, WITHOUT
 * registering as an active read. This is the handle-resolution guard: openTable()
 * / tableNames() / lazy index-metadata loads read the version manifest and
 * `_indices/` files that optimize()'s cleanup deletes and createIndex(replace)
 * rewrites. Running those native calls concurrently with maintenance faults the
 * engine uncatchably (SIGSEGV/SIGBUS) — the read gate previously only covered the
 * scan (toArray), leaving the handle-open step racing compaction. Wakes early on
 * abort so a cancelled retrieval never blocks on a rebuild.
 *
 * Callers that go on to open a scan MUST still pass through beginRead()/
 * raceWithSignal() so the scan is also counted toward waitForReadsToDrain().
 */
async function awaitMaintenanceGate(signal?: AbortSignal): Promise<void> {
  while (_maintenanceGate) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await raceMaintenanceGate(_maintenanceGate, signal);
  }
}

async function beginRead(signal?: AbortSignal): Promise<() => void> {
  // Wait out any in-progress maintenance so the scan we are about to open never
  // references data/index files an optimize or index rebuild is unlinking.
  await awaitMaintenanceGate(signal);
  _activeReadCount++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    _activeReadCount = Math.max(0, _activeReadCount - 1);
  };
}

function raceMaintenanceGate(gate: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return gate;
  return new Promise<void>((resolve) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); resolve(); };
    signal.addEventListener("abort", onAbort, { once: true });
    gate.then(() => { signal.removeEventListener("abort", onAbort); resolve(); });
  });
}

async function waitForReadsToDrain(timeoutMs = 30_000): Promise<void> {
  if (_activeReadCount === 0) return;
  const startedAt = Date.now();
  while (_activeReadCount > 0) {
    if (Date.now() - startedAt >= timeoutMs) {
      console.warn(
        `[embeddings] Compaction proceeding with ${_activeReadCount} read(s) still in flight (drain wait timed out after ${timeoutMs}ms)`,
      );
      return;
    }
    await sleep(25);
  }
}

/**
 * Run a file-mutating maintenance op (optimize cleanup, index replace) with
 * exclusivity against reads: block new reads from opening a scan, wait for
 * in-flight reads to finish streaming, then mutate. MUST be called inside
 * withWriteLock(), which serializes maintenance ops against each other so the
 * gate never has competing owners.
 */
async function withMaintenanceExclusive<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  _maintenanceGate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await waitForReadsToDrain();
    return await fn();
  } finally {
    _maintenanceGate = null;
    release();
  }
}

/**
 * True when an error looks like the read/maintenance file-deletion race — a
 * scan whose underlying data/index file was unlinked mid-stream. Used to drive a
 * one-shot retry against a freshly reopened handle.
 */
export function isLanceReadRaceError(err: unknown): boolean {
  const text = collectErrorMessages(err).join(" | ").toLowerCase();
  if (!text) return false;
  return (
    text.includes("failed to get next batch from stream") ||
    (text.includes("not found") && (text.includes("lance") || text.includes("object") || text.includes("stream")))
  );
}

/**
 * Run a native read; on the file-deletion race, drop the cached table handle and
 * retry once against the reopened (post-maintenance) version. Falls back to a
 * caller-supplied empty result if the retry still races, so retrieval degrades
 * gracefully instead of surfacing an alarming warning upstream.
 */
export async function withReadRetry<T>(
  label: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (signal?.aborted) throw err;
    if (!isLanceReadRaceError(err)) throw err;
    invalidateTableHandle();
    try {
      return await run();
    } catch (err2) {
      if (signal?.aborted) throw err2;
      console.warn(`[embeddings] ${label} degraded after read race:`, err2);
      return fallback;
    }
  }
}

// ---------------------------------------------------------------------------
// Table handle cache — avoids repeated openTable() calls that each hit disk
// to resolve the version manifest. Invalidated on reset/errors.
// ---------------------------------------------------------------------------
interface TableRuntimeState {
  tableHandle: Table | null;
  vectorIndexReady: boolean;
  scalarIndexReady: boolean;
  ftsIndexReady: boolean;
  lastIndexRebuildAt: number;
  unindexedRowEstimate: number;
  indexHealthTimer: ReturnType<typeof setInterval> | null;
}

const tableStates = new Map<string, TableRuntimeState>();

export function getTableState(tableName: string): TableRuntimeState {
  let state = tableStates.get(tableName);
  if (!state) {
    state = {
      tableHandle: null,
      vectorIndexReady: false,
      scalarIndexReady: false,
      ftsIndexReady: false,
      lastIndexRebuildAt: 0,
      unindexedRowEstimate: 0,
      indexHealthTimer: null,
    };
    tableStates.set(tableName, state);
  }
  return state;
}

function invalidateTableHandle(tableName?: string): void {
  if (tableName) {
    getTableState(tableName).tableHandle = null;
    return;
  }
  for (const state of tableStates.values()) {
    state.tableHandle = null;
  }
}

function logLanceDbPathDiagnostics(): void {
  if (lancedbPathDiagnosticsLogged || !LANCEDB_TERMUX_LIKE) return;
  lancedbPathDiagnosticsLogged = true;
  console.info(
    `[embeddings] LanceDB path config: path=${LANCEDB_PATH}; uri=${LANCEDB_URI}; cwd=${process.cwd()}; tmpdir=${process.env.TMPDIR || "(unset)"}`,
  );
  if (process.cwd() === "/") {
    console.warn(
      "[embeddings] Process cwd is / on Termux; keeping LanceDB URI absolute to avoid generating data/data/com.termux/...",
    );
  }
}

function collectErrorMessages(err: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (current && depth < 8) {
    if (current instanceof Error) {
      messages.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else if (typeof current === "object") {
      const candidate = current as { message?: unknown; cause?: unknown };
      if (typeof candidate.message === "string") messages.push(candidate.message);
      else messages.push(String(current));
      current = candidate.cause;
    } else {
      messages.push(String(current));
      break;
    }
    depth += 1;
  }
  return messages.filter(Boolean);
}

function isIncompleteEmbeddingsTableError(err: unknown, tableName: string): boolean {
  const text = collectErrorMessages(err).join(" | ").toLowerCase();
  if (!text) return false;
  if (!text.includes(`${tableName}.lance`) && !text.includes(`table '${tableName}' was not found`)) {
    return false;
  }
  return (
    text.includes("/_versions") ||
    text.includes("\\_versions") ||
    text.includes("dataset at path") ||
    text.includes("table 'embeddings' was not found")
  );
}

function resetInMemoryVectorStoreState(): void {
  if (optimizeTimer) {
    clearTimeout(optimizeTimer);
    optimizeTimer = null;
  }
  optimizeQueuedAt = null;
  stopIndexHealthMonitor();
  embeddingCache.clear();

  try {
    for (const state of tableStates.values()) {
      state.tableHandle?.close();
    }
  } catch {}
  try {
    connHandle?.close();
  } catch {}

  connGeneration += 1;
  connHandle = null;
  connPromise = null;
  invalidateTableHandle();
  for (const state of tableStates.values()) {
    state.vectorIndexReady = false;
    state.scalarIndexReady = false;
    state.ftsIndexReady = false;
    state.lastIndexRebuildAt = 0;
    state.unindexedRowEstimate = 0;
    if (state.indexHealthTimer) {
      clearInterval(state.indexHealthTimer);
      state.indexHealthTimer = null;
    }
  }
}

export function resetSqliteVectorizationState(): void {
  try {
    const db = getDb();
    db.run(
      `UPDATE world_book_entries
       SET vector_index_status = CASE WHEN vectorized = 1 THEN 'pending' ELSE 'not_enabled' END,
           vector_indexed_at = NULL,
           vector_index_error = NULL`
    );
    db.run(`UPDATE chat_chunks SET vectorized_at = NULL, vector_model = NULL`);
    db.run(`DELETE FROM query_vector_cache`);
    db.run(`DELETE FROM chat_memory_cache`);
  } catch (err) {
    console.warn("[embeddings] Failed to reset SQLite vectorization state:", err);
  }
}

function performBrokenEmbeddingsTableRecovery(reason: string, err: unknown): void {
  resetInMemoryVectorStoreState();

  // This store only contains one shared table, so deleting just embeddings.lance
  // can leave parent-level LanceDB metadata claiming the table still exists.
  // Reset the entire store so the next operation can recreate it cleanly.
  const deleted = existsSync(LANCEDB_PATH);
  if (deleted) {
    rmSync(LANCEDB_PATH, { recursive: true, force: true });
  }
  resetSqliteVectorizationState();
  console.warn(`[embeddings] Recovered incomplete LanceDB table after ${reason}; deleted ${LANCEDB_PATH}`, err);
}

async function recoverBrokenEmbeddingsTable(tableName: string, reason: string, err: unknown, lockHeld = false): Promise<boolean> {
  if (!isIncompleteEmbeddingsTableError(err, tableName)) return false;
  if (lockHeld) {
    performBrokenEmbeddingsTableRecovery(reason, err);
    return true;
  }
  await withWriteLock(async () => {
    performBrokenEmbeddingsTableRecovery(reason, err);
  });
  return true;
}

function isEmbeddingsTableSchemaDriftError(err: unknown): boolean {
  const text = collectErrorMessages(err).join(" | ").toLowerCase();
  if (!text) return false;
  if (text.includes("vector not divisible by 8")) return true;

  const mentionsVectorSchema =
    text.includes("fixedsizelist") ||
    text.includes("fixed_size_list") ||
    text.includes("vector");
  const mentionsShapeMismatch =
    text.includes("dimension") ||
    text.includes("dimensionality") ||
    text.includes("length") ||
    text.includes("schema") ||
    (text.includes("expected") && text.includes("got"));

  return mentionsVectorSchema && mentionsShapeMismatch;
}

export async function retryAfterSchemaDriftReset<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isEmbeddingsTableSchemaDriftError(err)) throw err;
    console.warn(`[embeddings] ${reason} hit schema drift; force-resetting LanceDB and retrying once`, err);
    await forceResetLanceDB();
    return await fn();
  }
}

function tableNameForRows(rows: EmbeddingRow[]): string {
  if (rows.every((row) => row.source_type === "world_book_entry")) {
    return WORLD_BOOK_EMBEDDINGS_TABLE;
  }
  return EMBEDDINGS_TABLE;
}

export async function upsertEmbeddingRows(rows: EmbeddingRow[], reason: string): Promise<void> {
  if (rows.length === 0) return;
  const tableName = tableNameForRows(rows);
  await retryAfterSchemaDriftReset(reason, async () => {
    await withWriteLock(async () => {
      const table = await getOrCreateTable(tableName, rows, true);
      await ensureVectorIndex(tableName, table);
      await ensureScalarIndexes(tableName, table);
      await ensureFtsIndex(tableName, table);
      await table
        .mergeInsert("id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(asLanceRows(rows));
    });
  });
}

const WORLD_BOOK_MIGRATION_BATCH_SIZE = 250;

function isRetryableMergeInsertError(err: Error): boolean {
  return isRetryableBatchErrorLocal(err)
    || /resources exhausted|failed to allocate|hashjoininput/i.test(err.message);
}

/**
 * Local copy of the embedding-generation `isRetryableBatchError` shape, used
 * only to classify mergeInsert/storage errors (the storage-side concerns —
 * timeouts, physical batch size, 413/500/503). Embedding generation keeps its
 * own copy in embeddings.service.ts.
 */
function isRetryableBatchErrorLocal(err: Error): boolean {
  const m = err.message;
  if (/timed out|abort/i.test(m)) return true;
  if (/too large to process|physical batch size|increase.*batch.*size/i.test(m)) return true;
  if (/exceeds.*context|context.*exceed/i.test(m)) return true;
  if (/\(413\)|\(500\)|\(503\)/.test(m)) return true;
  return false;
}

async function mergeInsertRowsInBatches(
  table: Table,
  rows: EmbeddingRow[],
  label: string,
  initialBatchSize: number,
): Promise<void> {
  const process = async (batch: EmbeddingRow[], currentSize: number): Promise<void> => {
    try {
      await table
        .mergeInsert("id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(asLanceRows(batch));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (isRetryableMergeInsertError(error) && currentSize > 1) {
        const half = Math.max(1, Math.floor(currentSize / 2));
        console.warn(
          `[embeddings] ${label}: mergeInsert batch of ${batch.length} failed (${error.message}); retrying in sub-batches of ${half}`,
        );
        for (let i = 0; i < batch.length; i += half) {
          await process(batch.slice(i, i + half), half);
        }
        return;
      }
      throw error;
    }
  };

  for (let i = 0; i < rows.length; i += initialBatchSize) {
    await process(rows.slice(i, i + initialBatchSize), initialBatchSize);
  }
}

async function getConnection(): Promise<Connection> {
  if (connHandle) return connHandle;

  const generation = connGeneration;
  logLanceDbPathDiagnostics();
  cleanupBrokenTermuxLanceDbMirror();
  if (!connPromise) connPromise = connect(LANCEDB_URI);

  const conn = await connPromise;
  if (generation !== connGeneration) {
    try {
      conn.close();
    } catch {}
    return getConnection();
  }

  connHandle = conn;
  return conn;
}

async function tableExists(conn: Connection, name: string): Promise<boolean> {
  const names = await conn.tableNames();
  return names.includes(name);
}

export async function getTableIfExists(tableName = EMBEDDINGS_TABLE, lockHeld = false): Promise<Table | null> {
  const state = getTableState(tableName);
  if (state.tableHandle) return state.tableHandle;
  // Reads, the health probe, and the index-health monitor resolve handles
  // outside the read gate. Wait out any in-progress compaction first so
  // openTable()/tableNames() can't run while optimize()/createIndex() rewrites
  // the manifest and index files. Maintenance ops hold the gate themselves
  // (lockHeld=true) and must NOT wait on it here — that would self-deadlock.
  if (!lockHeld) await awaitMaintenanceGate();
  const conn = await getConnection();
  const exists = await tableExists(conn, tableName);
  if (!exists) return null;
  try {
    state.tableHandle = await conn.openTable(tableName);
  } catch (err) {
    if (await recoverBrokenEmbeddingsTable(tableName, `opening ${tableName} table`, err, lockHeld)) {
      return null;
    }
    throw err;
  }
  return state.tableHandle;
}

export async function getOrCreateTable(tableName = EMBEDDINGS_TABLE, seedRows?: EmbeddingRow[], lockHeld = false): Promise<Table> {
  const state = getTableState(tableName);
  if (state.tableHandle) return state.tableHandle;
  // See getTableIfExists: gate handle resolution against in-progress compaction
  // for non-maintenance callers (lockHeld=false) to keep openTable()/createTable()
  // from racing optimize()/createIndex(). Maintenance holds the gate, so skip.
  if (!lockHeld) await awaitMaintenanceGate();
  let conn = await getConnection();
  const exists = await tableExists(conn, tableName);
  if (exists) {
    try {
      state.tableHandle = await conn.openTable(tableName);
      return state.tableHandle;
    } catch (err) {
      if (!(await recoverBrokenEmbeddingsTable(tableName, `opening ${tableName} before write`, err, lockHeld))) {
        throw err;
      }
      conn = await getConnection();
    }
  }
  if (!seedRows || seedRows.length === 0) {
    throw new Error("Cannot create embeddings table without initial seed rows to infer schema.");
  }
  try {
    state.tableHandle = await conn.createTable(tableName, asLanceRows(seedRows));
  } catch (err) {
    if (!(await recoverBrokenEmbeddingsTable(tableName, `creating ${tableName}`, err, lockHeld))) {
      throw err;
    }
    conn = await getConnection();
    state.tableHandle = await conn.createTable(tableName, asLanceRows(seedRows));
  }
  return state.tableHandle;
}

const MIN_ROWS_FOR_VECTOR_INDEX = 5_000;
const MIN_ROWS_FOR_PQ_VECTOR_INDEX = 65_536;
export const MAX_LANCE_SOURCE_FILTER_IDS = 250;
const OPTIMIZE_MAX_WAIT_MS = 2 * 60_000; // 2 minutes (reduced from 5 min to prevent fragment buildup)
const CHAT_OPTIMIZE_MIN_INTERVAL_MS = 30 * 60_000; // Avoid full-table optimize churn from active chat writes
let optimizeQueuedAt: number | null = null;
let lastChatOptimizeScheduledAt = 0;
let optimizeWorldBooksQueued = false;

// ---------------------------------------------------------------------------
// Index health tracking — detect when indexes need rebuilding
// ---------------------------------------------------------------------------
const INDEX_REBUILD_COOLDOWN_MS = 10 * 60_000; // Don't rebuild more than once per 10 min
const UNINDEXED_ROW_THRESHOLD = 2_000; // Rebuild when this many rows are unindexed
const INDEX_HEALTH_CHECK_INTERVAL_MS = 2 * 60_000; // Check index health every 2 min

function getVectorIndexPartitions(rowCount: number): number | null {
  if (rowCount < MIN_ROWS_FOR_VECTOR_INDEX) return null;

  // LanceDB's IVF_PQ training becomes noisy when partitions outpace the data.
  // Keep at least 256 rows per partition to avoid empty-cluster warnings.
  return Math.max(2, Math.min(
    Math.floor(Math.sqrt(rowCount)),
    Math.floor(rowCount / 256),
  ));
}

function getVectorIndexConfig(rowCount: number): any | null {
  const numPartitions = getVectorIndexPartitions(rowCount);
  if (numPartitions === null) return null;

  if (rowCount < MIN_ROWS_FOR_PQ_VECTOR_INDEX) {
    return Index.ivfFlat({
      distanceType: "cosine",
      numPartitions,
    } as any);
  }

  return Index.ivfPq({
    distanceType: "cosine",
    numPartitions,
  } as any);
}

export async function ensureVectorIndex(tableName: string, table: Table): Promise<void> {
  const state = getTableState(tableName);
  if (state.vectorIndexReady) return;
  try {
    const rowCount = await table.countRows();
    const indexConfig = getVectorIndexConfig(rowCount);
    if (indexConfig === null) {
      // Brute-force search is fast enough for small tables and avoids
      // KMeans warnings about empty clusters when rows < num_partitions * 256.
      state.vectorIndexReady = true;
      return;
    }
    await table.createIndex("vector", {
      config: indexConfig,
    } as any);
  } catch {
    // Index may already exist - that's fine
  }
  state.vectorIndexReady = true;
  state.lastIndexRebuildAt = Date.now();
  if (tableName !== WORLD_BOOK_EMBEDDINGS_TABLE) {
    startIndexHealthMonitor(tableName);
  }
}

/**
 * Ensure scalar indexes exist on filter columns for fast prefiltering.
 * BTree for high-cardinality (user_id, owner_id, id), Bitmap for low-cardinality (source_type).
 * The `id` BTree is critical for mergeInsert performance — without it, every upsert
 * does a full table scan to find matching rows.
 *
 * When `force` is true, indexes are rebuilt with `replace: true` even if they already
 * exist. This is needed after compaction cleanup, which can leave stale index files
 * referencing deleted data versions (manifests as "Object not found" errors on Windows
 * and other platforms).
 */
export async function ensureScalarIndexes(tableName: string, table: Table, force = false): Promise<void> {
  const state = getTableState(tableName);
  if (state.scalarIndexReady && !force) return;

  let indexNames: Set<string>;
  try {
    indexNames = new Set((await table.listIndices()).map((i: any) => i.name || i.indexName || ""));
  } catch {
    // listIndices can fail if index files are orphaned from a previous compaction.
    // Treat as empty so every index gets (re)created below.
    indexNames = new Set();
  }

  const create = async (col: string, config?: any) => {
    // LanceDB names indexes as {col}_idx by convention
    if (!force && indexNames.has(`${col}_idx`)) return;
    try {
      const opts: any = config ? { config } : {};
      if (force && indexNames.has(`${col}_idx`)) opts.replace = true;
      await table.createIndex(col, opts);
    } catch (err) {
      // replace: true can fail when the old index references orphaned files.
      // Fall back to a plain create (LanceDB overwrites by column name).
      if (force) {
        try {
          const opts: any = config ? { config } : {};
          await table.createIndex(col, opts);
        } catch {
          // Index may already exist in a usable state
        }
      }
    }
  };
  await create("id"); // Critical for mergeInsert("id") join performance
  await create("user_id");
  await create("owner_id");
  await create("source_id");
  if (tableName !== WORLD_BOOK_EMBEDDINGS_TABLE) {
    await create("source_type", Index.bitmap());
  }
  state.scalarIndexReady = true;
}

/**
 * Ensure FTS index exists on the content column for hybrid search.
 * When `force` is true, the index is rebuilt even if it already exists.
 */
export async function ensureFtsIndex(tableName: string, table: Table, force = false): Promise<void> {
  const state = getTableState(tableName);
  if (state.ftsIndexReady && !force) return;

  let indexNames: Set<string>;
  try {
    indexNames = new Set((await table.listIndices()).map((i: any) => i.name || i.indexName || ""));
  } catch {
    indexNames = new Set();
  }

  if (!force && indexNames.has("content_idx")) {
    state.ftsIndexReady = true;
    return;
  }
  try {
    const opts: any = { config: Index.fts() };
    if (force && indexNames.has("content_idx")) opts.replace = true;
    await table.createIndex("content", opts);
  } catch {
    if (force) {
      try {
        await table.createIndex("content", { config: Index.fts() });
      } catch {
        // Index may already exist in a usable state
      }
    }
  }
  state.ftsIndexReady = true;
}

/**
 * Periodic index health monitor. Checks unindexed row count and triggers
 * a vector index rebuild when too many rows have drifted out of the index
 * (which happens naturally with mergeInsert updates).
 */
function startIndexHealthMonitor(tableName = EMBEDDINGS_TABLE): void {
  const state = getTableState(tableName);
  if (state.indexHealthTimer) return;
  state.indexHealthTimer = setInterval(async () => {
    try {
      const table = await getTableIfExists(tableName);
      if (table) await checkAndRebuildIndexes(tableName, table);
    } catch (err) {
      console.warn(`[embeddings] Index health check failed for ${tableName}:`, err);
    }
  }, INDEX_HEALTH_CHECK_INTERVAL_MS);
}

export function stopIndexHealthMonitor(tableName?: string): void {
  if (tableName) {
    const state = getTableState(tableName);
    if (state.indexHealthTimer) {
      clearInterval(state.indexHealthTimer);
      state.indexHealthTimer = null;
    }
    return;
  }
  for (const state of tableStates.values()) {
    if (state.indexHealthTimer) {
      clearInterval(state.indexHealthTimer);
      state.indexHealthTimer = null;
    }
  }
}

async function checkAndRebuildIndexes(tableName: string, table: Table): Promise<void> {
  const state = getTableState(tableName);
  const now = Date.now();
  if (now - state.lastIndexRebuildAt < INDEX_REBUILD_COOLDOWN_MS) return;

  try {
    const indices = await table.listIndices();
    const vectorIdx = indices.find((i: any) => {
      const name = i.name || i.indexName || "";
      return name.includes("vector");
    });
    if (!vectorIdx) return;

    const idxName = vectorIdx.name || (vectorIdx as any).indexName;
    let unindexed = 0;
    try {
      const stats = await (table as any).indexStats(idxName);
      if (stats) {
        unindexed = (stats as any).num_unindexed_rows ?? (stats as any).numUnindexedRows ?? 0;
      }
    } catch {
      // indexStats may not be supported for this index type — fall back to
      // heuristic: rebuild if enough time has passed since last rebuild and
      // we've been writing (optimizeQueuedAt !== null indicates recent writes).
      if (optimizeQueuedAt !== null && now - state.lastIndexRebuildAt > INDEX_REBUILD_COOLDOWN_MS * 3) {
        unindexed = UNINDEXED_ROW_THRESHOLD; // Force rebuild
      }
    }
    state.unindexedRowEstimate = unindexed;

    if (unindexed >= UNINDEXED_ROW_THRESHOLD) {
      console.info(`[embeddings] ${unindexed} unindexed rows detected, rebuilding vector index...`);
      await withWriteLock(async () => {
        const t = await getTableIfExists(tableName, true);
        if (!t) return;
        const rowCount = await t.countRows();
        const indexConfig = getVectorIndexConfig(rowCount);
        if (indexConfig === null) {
          state.vectorIndexReady = true;
          state.unindexedRowEstimate = 0;
          state.lastIndexRebuildAt = Date.now();
          return;
        }
        // createIndex(replace) rewrites index files out from under any reader —
        // the periodic rebuild fires mid-chat, exactly when retrieval is busy.
        await withMaintenanceExclusive(async () => {
          await t.createIndex("vector", {
            config: indexConfig,
            replace: true,
          } as any);
        });
        state.lastIndexRebuildAt = Date.now();
        state.unindexedRowEstimate = 0;
        console.info(`[embeddings] Vector index rebuilt (${rowCount} rows)`);
      });
    }
  } catch (err) {
    // Non-fatal — index health checks are best-effort
    console.warn("[embeddings] Index health check error:", err);
  }
}

/**
 * One-time startup migration: detect old HNSW_PQ vector index and replace it
 * with IVF_PQ (better for filtered workloads). Also compacts fragments.
 * Safe to call every startup — skips quickly if no table exists or index is
 * already the correct type.
 */
export async function runStartupVectorMaintenance(): Promise<void> {
  const conn = await getConnection();
  const migration = await migrateWorldBookRowsToDedicatedTable();
  if (migration.migratedRows > 0) {
    console.info(`[embeddings] Startup WI split complete: migrated ${migration.migratedRows} row(s) to ${WORLD_BOOK_EMBEDDINGS_TABLE}`);
  } else if (migration.legacyRowsFound) {
    console.warn(`[embeddings] Startup WI split: legacy world-book rows still appear present in ${EMBEDDINGS_TABLE}`);
  }
  const tablesToMaintain = [EMBEDDINGS_TABLE, WORLD_BOOK_EMBEDDINGS_TABLE];

  await withWriteLock(async () => {
    for (const tableName of tablesToMaintain) {
      const exists = await tableExists(conn, tableName);
      if (!exists) continue;
      const table = await getTableIfExists(tableName, true);
      if (!table) continue;
      const state = getTableState(tableName);

      let indices: any[];
      try {
        indices = await table.listIndices();
      } catch {
        indices = [];
      }
      const vectorIdx = indices.find((i: any) => {
        const name = i.name || i.indexName || "";
        return name.includes("vector");
      });
      const idxType = vectorIdx ? ((vectorIdx as any).indexType || (vectorIdx as any).type || "") : "";
      const needsMigration = vectorIdx && /hnsw/i.test(idxType);

      try {
        console.info(`[embeddings] Running startup compaction for ${tableName}...`);
        // optimize() unlinks superseded version files and the index rebuilds
        // below rewrite index files; hold reads off for the whole sequence.
        await withMaintenanceExclusive(async () => {
          try {
            await table.optimize({ cleanupOlderThan: new Date(Date.now() - CLEANUP_GRACE_PERIOD_MS) });
          } catch (err) {
            console.warn(`[embeddings] Startup compaction failed for ${tableName}:`, err);
          }

          if (needsMigration) {
            const rowCount = await table.countRows();
            const indexConfig = getVectorIndexConfig(rowCount);
            if (indexConfig !== null) {
              console.info(`[embeddings] Migrating vector index for ${tableName} from HNSW_PQ → IVF (${rowCount} rows)...`);
              try {
                await table.createIndex("vector", {
                  config: indexConfig,
                  replace: true,
                } as any);
                state.vectorIndexReady = true;
                state.lastIndexRebuildAt = Date.now();
                console.info(`[embeddings] Vector index migrated successfully for ${tableName}`);
              } catch (err) {
                console.warn(`[embeddings] Vector index migration failed for ${tableName} (will retry on next query):`, err);
              }
            }
          }

          await ensureScalarIndexes(tableName, table, true);
          await ensureFtsIndex(tableName, table, true);
          await ensureVectorIndex(tableName, table);
        });
      } catch (err) {
        console.warn(`[embeddings] Startup maintenance failed for ${tableName}:`, err);
      }
    }
  });

  startIndexHealthMonitor(EMBEDDINGS_TABLE);
}

export async function optimizeTable(tableNames?: string[]): Promise<void> {
  const targets = tableNames && tableNames.length > 0
    ? tableNames
    : [EMBEDDINGS_TABLE, WORLD_BOOK_EMBEDDINGS_TABLE];
  await withWriteLock(async () => {
    for (const tableName of targets) {
      try {
        const table = await getTableIfExists(tableName, true);
        if (!table) continue;

        // Block new reads and drain in-flight ones, then compact: optimize()
        // unlinks superseded version files and the forced index rebuilds rewrite
        // index files — either is fatal to a read scanning them concurrently.
        await withMaintenanceExclusive(async () => {
          await table.optimize({
            cleanupOlderThan: new Date(Date.now() - CLEANUP_GRACE_PERIOD_MS),
          });
          await ensureScalarIndexes(tableName, table, true);
          await ensureFtsIndex(tableName, table, true);
        });
      } catch (err) {
        console.warn(`[embeddings] Optimize failed for ${tableName}:`, err);
      }
    }
  });
}

export interface CombinedVectorStoreHealth {
  exists: boolean;
  rowCount: number;
  vectorIndexReady: boolean;
  scalarIndexReady: boolean;
  ftsIndexReady: boolean;
  unindexedRowEstimate: number;
  lastIndexRebuildAt: number;
  indexes: Array<{ name: string; type?: string }>;
  tables?: Record<string, {
    exists: boolean;
    rowCount: number;
    vectorIndexReady: boolean;
    scalarIndexReady: boolean;
    ftsIndexReady: boolean;
    unindexedRowEstimate: number;
    lastIndexRebuildAt: number;
    indexes: Array<{ name: string; type?: string }>;
  }>;
}

interface SingleTableHealth {
  exists: boolean;
  rowCount: number;
  vectorIndexReady: boolean;
  scalarIndexReady: boolean;
  ftsIndexReady: boolean;
  unindexedRowEstimate: number;
  lastIndexRebuildAt: number;
  indexes: Array<{ name: string; type?: string }>;
}

async function readTableHealth(tableName: string): Promise<SingleTableHealth> {
  const table = await getTableIfExists(tableName);
  const state = getTableState(tableName);
  if (!table) {
    return {
      exists: false,
      rowCount: 0,
      vectorIndexReady: state.vectorIndexReady,
      scalarIndexReady: state.scalarIndexReady,
      ftsIndexReady: state.ftsIndexReady,
      unindexedRowEstimate: 0,
      lastIndexRebuildAt: 0,
      indexes: [],
    };
  }

  const rowCount = await table.countRows();
  let indices: any[];
  try {
    indices = await table.listIndices();
  } catch {
    try {
      await withWriteLock(async () => {
        const t = await getTableIfExists(tableName, true);
        if (t) {
          await ensureScalarIndexes(tableName, t, true);
          await ensureFtsIndex(tableName, t, true);
        }
      });
      indices = await table.listIndices();
    } catch {
      indices = [];
    }
  }

  return {
    exists: true,
    rowCount,
    vectorIndexReady: state.vectorIndexReady,
    scalarIndexReady: state.scalarIndexReady,
    ftsIndexReady: state.ftsIndexReady,
    unindexedRowEstimate: state.unindexedRowEstimate,
    lastIndexRebuildAt: state.lastIndexRebuildAt,
    indexes: indices.map((i: any) => ({
      name: i.name || i.indexName || "unknown",
      type: i.indexType || i.type || undefined,
    })),
  };
}

/**
 * Get LanceDB table health diagnostics for the embeddings table.
 */
export async function getVectorStoreHealth(): Promise<CombinedVectorStoreHealth> {
  const runtime = await readTableHealth(EMBEDDINGS_TABLE);
  const worldBooks = await readTableHealth(WORLD_BOOK_EMBEDDINGS_TABLE);
  const combinedExists = runtime.exists || worldBooks.exists;
  const combinedRowCount = runtime.rowCount + worldBooks.rowCount;
  const combinedUnindexedRowEstimate = runtime.unindexedRowEstimate + worldBooks.unindexedRowEstimate;
  const combinedLastIndexRebuildAt = Math.max(runtime.lastIndexRebuildAt, worldBooks.lastIndexRebuildAt);
  const combinedIndexes = [
    ...runtime.indexes.map((idx) => ({
      name: `${EMBEDDINGS_TABLE}:${idx.name}`,
      type: idx.type,
    })),
    ...worldBooks.indexes.map((idx) => ({
      name: `${WORLD_BOOK_EMBEDDINGS_TABLE}:${idx.name}`,
      type: idx.type,
    })),
  ];

  return {
    exists: combinedExists,
    rowCount: combinedRowCount,
    vectorIndexReady: (!runtime.exists || runtime.vectorIndexReady) && (!worldBooks.exists || worldBooks.vectorIndexReady),
    scalarIndexReady: (!runtime.exists || runtime.scalarIndexReady) && (!worldBooks.exists || worldBooks.scalarIndexReady),
    ftsIndexReady: (!runtime.exists || runtime.ftsIndexReady) && (!worldBooks.exists || worldBooks.ftsIndexReady),
    unindexedRowEstimate: combinedUnindexedRowEstimate,
    lastIndexRebuildAt: combinedLastIndexRebuildAt,
    indexes: combinedIndexes,
    tables: {
      [EMBEDDINGS_TABLE]: runtime,
      [WORLD_BOOK_EMBEDDINGS_TABLE]: worldBooks,
    },
  };
}

export function scheduleOptimize(reason: "general" | "chat_chunk" | "world_book" = "general"): void {
  const now = Date.now();
  if (reason === "chat_chunk") {
    // Chat memory writes are high-frequency, but they share the same Lance table
    // as large static world-book corpora. Running full optimize/index rebuilds on
    // every chat-churn window can make disk usage balloon during active chats.
    // Rate-limit the background optimize for chat-only writes and leave startup,
    // manual, and bulk world-book/databank maintenance paths unchanged.
    if (now - lastChatOptimizeScheduledAt < CHAT_OPTIMIZE_MIN_INTERVAL_MS) {
      return;
    }
    lastChatOptimizeScheduledAt = now;
  }
  if (reason === "world_book") {
    optimizeWorldBooksQueued = true;
  }
  if (optimizeQueuedAt == null) optimizeQueuedAt = now;
  if (optimizeTimer) clearTimeout(optimizeTimer);
  const elapsed = now - optimizeQueuedAt;
  const delay = elapsed >= OPTIMIZE_MAX_WAIT_MS
    ? 0
    : Math.min(OPTIMIZE_DEBOUNCE_MS, OPTIMIZE_MAX_WAIT_MS - elapsed);
  optimizeTimer = setTimeout(async () => {
    optimizeTimer = null;
    optimizeQueuedAt = null;
    try {
      const includeWorldBooks = optimizeWorldBooksQueued;
      optimizeWorldBooksQueued = false;
      await optimizeTable(includeWorldBooks ? undefined : [EMBEDDINGS_TABLE]);
    } catch (err) {
      console.warn("[embeddings] Deferred optimize failed:", err);
    }
  }, delay);
}

/**
 * lance-6.0.0's empty-fragment delete bug. A predicated `table.delete()` makes
 * Lance scan fragments to evaluate the filter; on an empty table or a stray
 * 0-byte fragment it throws "Invalid range 0..0 for object of size 0 bytes"
 * (dataset.rs) instead of matching nothing.
 */
function isEmptyFragmentDeleteError(err: unknown): boolean {
  const text = collectErrorMessages(err).join(" | ").toLowerCase();
  if (!text) return false;
  return text.includes("invalid range 0..0") || text.includes("for object of size 0 bytes");
}

/**
 * Predicated delete that tolerates the empty-fragment bug above. A delete that
 * matches nothing is semantically a success, so we (1) short-circuit when the
 * table is empty — there is nothing to delete and `countRows()` reads fragment
 * metadata, not the 0-byte data file — and (2) swallow the empty-fragment error
 * as a no-op, scheduling an optimize to compact the stray fragment away. Every
 * other error propagates unchanged.
 */
export async function safeTableDelete(
  table: Table,
  filter: string,
  reason: "general" | "chat_chunk" | "world_book" = "general",
): Promise<void> {
  if ((await table.countRows()) === 0) return;
  try {
    await table.delete(filter);
  } catch (err) {
    if (!isEmptyFragmentDeleteError(err)) throw err;
    scheduleOptimize(reason);
  }
}

async function migrateWorldBookRowsToDedicatedTable(): Promise<{ migratedRows: number; legacyRowsFound: boolean }> {
  let migratedRowsCount = 0;
  await withWriteLock(async () => {
    const runtimeTable = await getTableIfExists(EMBEDDINGS_TABLE, true);
    if (!runtimeTable) return;

    const rows = await runtimeTable
      .query()
      .where(`source_type = 'world_book_entry'`)
      .select(["id", "user_id", "source_type", "source_id", "owner_id", "chunk_index", "content", "vector", "metadata_json", "updated_at"])
      .toArray();

    if ((rows as any[]).length === 0) return;

    const migratedRows: EmbeddingRow[] = (rows as any[]).map((row) => ({
      id: String(row.id),
      user_id: String(row.user_id),
      source_type: String(row.source_type),
      source_id: String(row.source_id),
      owner_id: String(row.owner_id),
      chunk_index: Number(row.chunk_index ?? 0),
      content: String(row.content || ""),
      vector: coerceLanceVector(row.vector),
      metadata_json: typeof row.metadata_json === "string" ? row.metadata_json : JSON.stringify(row.metadata_json ?? {}),
      updated_at: Number(row.updated_at ?? Math.floor(Date.now() / 1000)),
    })).filter((row) => row.vector.length > 0);

    if (migratedRows.length === 0) {
      console.warn("[embeddings] World-book migration found legacy rows, but none exposed a usable vector payload");
      return;
    }

    let worldBookTable = await getTableIfExists(WORLD_BOOK_EMBEDDINGS_TABLE, true);
    if (!worldBookTable) {
      worldBookTable = await getOrCreateTable(WORLD_BOOK_EMBEDDINGS_TABLE, migratedRows.slice(0, 1), true);
    }

    await mergeInsertRowsInBatches(
      worldBookTable,
      migratedRows,
      "world-book lazy migration",
      WORLD_BOOK_MIGRATION_BATCH_SIZE,
    );
    await ensureVectorIndex(WORLD_BOOK_EMBEDDINGS_TABLE, worldBookTable);
    await ensureScalarIndexes(WORLD_BOOK_EMBEDDINGS_TABLE, worldBookTable);
    await ensureFtsIndex(WORLD_BOOK_EMBEDDINGS_TABLE, worldBookTable);

    const migratedEntryIds = [...new Set(migratedRows.map((row) => row.source_id))];
    const latestUpdatedAt = migratedRows.reduce((max, row) => Math.max(max, row.updated_at), 0);
    updateWorldBookEntriesVectorState(migratedEntryIds, "indexed", latestUpdatedAt || Math.floor(Date.now() / 1000), null);

    migratedRowsCount = migratedRows.length;

    try {
      await runtimeTable.delete(`source_type = 'world_book_entry'`);
    } catch (err) {
      console.warn(
        `[embeddings] World-book migration copied ${migratedRows.length} row(s) into ${WORLD_BOOK_EMBEDDINGS_TABLE}, but failed to delete legacy rows from ${EMBEDDINGS_TABLE}:`,
        err,
      );
    }

    console.info(`[embeddings] Migrated ${migratedRows.length} world-book embedding row(s) into ${WORLD_BOOK_EMBEDDINGS_TABLE}`);
  });

  if (migratedRowsCount > 0) {
    return { migratedRows: migratedRowsCount, legacyRowsFound: true };
  }

  const runtimeTable = await getTableIfExists(EMBEDDINGS_TABLE);
  if (!runtimeTable) {
    return { migratedRows: 0, legacyRowsFound: false };
  }

  try {
    const legacyRows = await runtimeTable
      .query()
      .where(`source_type = 'world_book_entry'`)
      .select(["id"])
      .limit(1)
      .toArray();
    if (legacyRows.length === 0) {
      return { migratedRows: 0, legacyRowsFound: false };
    }
  } catch {}

  return { migratedRows: 0, legacyRowsFound: true };
}

export async function getWorldBookTableForRead(): Promise<Table | null> {
  let table = await getTableIfExists(WORLD_BOOK_EMBEDDINGS_TABLE);
  if (table) return table;

  // Startup maintenance runs fire-and-forget, so the first world-book search can
  // arrive before the dedicated table has been created. Try the migration lazily.
  try {
    await migrateWorldBookRowsToDedicatedTable();
  } catch (err) {
    console.warn("[embeddings] Lazy world-book table migration failed:", err);
  }

  table = await getTableIfExists(WORLD_BOOK_EMBEDDINGS_TABLE);
  if (table) return table;

  // Final fallback: if legacy rows still exist in the runtime table, read them
  // there rather than returning an empty result during migration rollout.
  const legacyTable = await getTableIfExists(EMBEDDINGS_TABLE);
  if (!legacyTable) return null;
  try {
    const legacyRows = await legacyTable
      .query()
      .where(`source_type = 'world_book_entry'`)
      .select(["id"])
      .limit(1)
      .toArray();
    return legacyRows.length > 0 ? legacyTable : null;
  } catch {
    return null;
  }
}

/**
 * Set the SQLite vector-index status for a batch of world-book entries. Lives
 * here because the world-book split migration writes it; embeddings.service.ts
 * imports it back (one-directional embeddings.service → lancedb.ts dependency).
 */
export function updateWorldBookEntriesVectorState(
  entryIds: string[],
  status: WorldBookVectorIndexStatus,
  indexedAt: number | null,
  error: string | null,
): void {
  if (entryIds.length === 0) return;
  const placeholders = entryIds.map(() => "?").join(", ");
  getDb().query(
    `UPDATE world_book_entries
     SET vector_index_status = ?, vector_indexed_at = ?, vector_index_error = ?
     WHERE id IN (${placeholders})`
  ).run(status, indexedAt, error, ...entryIds);
}

export function sqlValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

let termuxMirrorCleanupAttempted = false;

function pruneEmptyAncestors(path: string, stopAt: string): void {
  let current = dirname(path);
  while (current.startsWith(stopAt) && current !== stopAt) {
    try {
      if (readdirSync(current).length > 0) break;
      rmSync(current, { recursive: false, force: true });
    } catch {
      break;
    }
    current = dirname(current);
  }
}

function cleanupBrokenTermuxLanceDbMirror(): void {
  if (termuxMirrorCleanupAttempted) return;
  termuxMirrorCleanupAttempted = true;

  const brokenPath = resolveBrokenTermuxLanceDbMirrorPath(LANCEDB_PATH);
  if (!brokenPath || brokenPath === LANCEDB_PATH || !existsSync(brokenPath)) return;

  const workspaceRoot = process.cwd();
  try {
    if (existsSync(LANCEDB_PATH)) {
      rmSync(brokenPath, { recursive: true, force: true });
      pruneEmptyAncestors(brokenPath, workspaceRoot);
      console.warn(`[embeddings] Removed broken Termux LanceDB mirror at ${brokenPath}`);
      return;
    }

    mkdirSync(dirname(LANCEDB_PATH), { recursive: true });
    renameSync(brokenPath, LANCEDB_PATH);
    pruneEmptyAncestors(brokenPath, workspaceRoot);
    console.warn(`[embeddings] Moved broken Termux LanceDB mirror into place: ${brokenPath} -> ${LANCEDB_PATH}`);
  } catch (err) {
    console.warn(`[embeddings] Failed to clean up broken Termux LanceDB mirror at ${brokenPath}`, err);
  }
}

/**
 * Force reset the entire LanceDB vector store.
 * Nukes the on-disk LanceDB directory, resets all module state, clears caches,
 * and resets vector index state in SQLite. This is the nuclear option for
 * recovering from corruption (e.g. "vector not divisible by 8" errors).
 */
export async function forceResetLanceDB(): Promise<{ deleted: boolean; path: string }> {
  // Acquire write lock to ensure no LanceDB operations are in-flight when we
  // delete the directory. Without this, concurrent writes would panic trying
  // to access files that no longer exist.
  return withWriteLock(async () => {
    resetInMemoryVectorStoreState();

    // Delete the entire LanceDB directory from disk
    const deleted = existsSync(LANCEDB_PATH);
    if (deleted) {
      rmSync(LANCEDB_PATH, { recursive: true, force: true });
      console.info(`[embeddings] Force-deleted LanceDB directory: ${LANCEDB_PATH}`);
    }

    resetSqliteVectorizationState();

    console.info("[embeddings] LanceDB force reset complete. Vector store will reinitialize on next use.");
    return { deleted, path: LANCEDB_PATH };
  });
}

// ---------------------------------------------------------------------------
// Structured filter → LanceDB SQL `where()` translation
// ---------------------------------------------------------------------------

/** Render a structured {@link VectorFilter} into a LanceDB SQL `where()` string
 *  using the same `sqlValue` quoting the inline code used. Numbers are NOT
 *  quoted; strings are. An empty `and` (no clauses) → `"true"` (match all). */
export function translateFilter(filter: VectorFilter): string {
  switch (filter.op) {
    case "eq":
      return `${filter.field} = ${literal(filter.value)}`;
    case "in":
      return `${filter.field} IN (${filter.values.map(literal).join(", ")})`;
    case "nin":
      return `${filter.field} NOT IN (${filter.values.map(literal).join(", ")})`;
    case "and": {
      if (filter.clauses.length === 0) return "true";
      return filter.clauses.map(translateFilter).join(" AND ");
    }
  }
}

function literal(value: string | number): string {
  return typeof value === "number" ? String(value) : sqlValue(value);
}

function collectionToTable(collection: CollectionName): string {
  return collection === "embeddings_world_books" ? WORLD_BOOK_EMBEDDINGS_TABLE : EMBEDDINGS_TABLE;
}

function parseHitVector(raw: unknown): number[] | null {
  if (!raw) return null;
  return raw instanceof Float32Array ? Array.from(raw) : (raw as number[]);
}

// ---------------------------------------------------------------------------
// VectorStore implementation
// ---------------------------------------------------------------------------

export class LanceDbStore implements VectorStore {
  readonly id: VectorStoreProviderId = "lancedb";
  readonly capabilities: ProviderCapabilities = LANCEDB_CAPABILITIES;

  /** Open the connection. Idempotent. Native preflight is handled separately
   *  (index.ts / lancedb-preflight) before any application code imports. */
  async init(): Promise<void> {
    await getConnection();
  }

  /** Tables are created lazily on first upsert (LanceDB infers schema from seed
   *  rows). Nothing to do up front. */
  async ensureCollection(_collection: CollectionName, _dimension: number): Promise<void> {
    // no-op
  }

  async getStoredDimension(collection: CollectionName): Promise<number | null> {
    const tableName = collectionToTable(collection);
    const table = await getTableIfExists(tableName);
    if (!table) return null;
    try {
      const rows = await table.query().select(["vector"]).limit(1).toArray();
      if ((rows as any[]).length === 0) return null;
      const vec = coerceLanceVector((rows as any[])[0].vector);
      return vec.length > 0 ? vec.length : null;
    } catch {
      return null;
    }
  }

  async upsert(_collection: CollectionName, rows: VectorRow[]): Promise<void> {
    await upsertEmbeddingRows(rows, "vector store upsert");
  }

  async getRowsByFilter(collection: CollectionName, filter: VectorFilter, limit = 10_000): Promise<VectorRow[]> {
    const tableName = collectionToTable(collection);
    const table = await getTableIfExists(tableName);
    if (!table) return [];
    const rows = await table
      .query()
      .where(translateFilter(filter))
      .select(["id", "user_id", "source_type", "source_id", "owner_id", "chunk_index", "content", "vector", "metadata_json", "updated_at"])
      .limit(limit)
      .toArray();

    return (rows as any[]).map((row) => ({
      id: String(row.id),
      user_id: String(row.user_id),
      source_type: String(row.source_type),
      source_id: String(row.source_id),
      owner_id: String(row.owner_id),
      chunk_index: Number(row.chunk_index ?? 0),
      content: String(row.content || ""),
      vector: coerceLanceVector(row.vector),
      metadata_json: typeof row.metadata_json === "string" ? row.metadata_json : JSON.stringify(row.metadata_json ?? {}),
      updated_at: Number(row.updated_at ?? 0),
    })).filter((row) => row.vector.length > 0);
  }

  async deleteByFilter(collection: CollectionName, filter: VectorFilter): Promise<void> {
    const tableName = collectionToTable(collection);
    await withWriteLock(async () => {
      const table = await getTableIfExists(tableName, true);
      if (!table) return;
      await safeTableDelete(table, translateFilter(filter), "general");
    });
    scheduleOptimize("general");
  }

  async deleteByIds(collection: CollectionName, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const tableName = collectionToTable(collection);
    await withWriteLock(async () => {
      const table = await getTableIfExists(tableName, true);
      if (!table) return;
      const BATCH = 500;
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH);
        const filter = `id IN (${batch.map((id) => sqlValue(id)).join(", ")})`;
        await safeTableDelete(table, filter, "general");
      }
    });
    scheduleOptimize("general");
  }

  async vectorSearch(opts: SearchOptions): Promise<VectorHit[]> {
    if (opts.signal?.aborted) return [];
    const tableName = collectionToTable(opts.collection);
    const where = translateFilter(opts.filter);
    const columns = opts.withVector
      ? ["source_id", "content", "_distance", "metadata_json", "vector"]
      : ["source_id", "content", "_distance", "metadata_json"];

    const rows = await withReadRetry<any[]>("vector search", opts.signal, async () => {
      const table = await getTableIfExists(tableName);
      if (!table) return [];
      const q = table
        .query()
        .nearestTo(opts.vector)
        .where(where)
        .select(columns)
        .limit(opts.limit) as any;
      if (opts.refine && getTableState(tableName).vectorIndexReady) q.refineFactor(5);
      return await raceWithSignal(() => q.toArray() as Promise<any[]>, opts.signal);
    }, []);

    if (opts.signal?.aborted) return [];

    return (rows as any[]).map((row) => ({
      id: String(row.id ?? ""),
      source_id: String(row.source_id),
      content: String(row.content || ""),
      metadata_json: typeof row.metadata_json === "string"
        ? row.metadata_json
        : JSON.stringify(row.metadata_json ?? {}),
      similarity: typeof row._distance === "number"
        ? toSimilarity(row._distance, "cosine_distance")
        : null,
      lexicalScore: null,
      vector: opts.withVector ? parseHitVector(row.vector) : null,
    }));
  }

  async lexicalSearch(opts: LexicalSearchOptions): Promise<VectorHit[]> {
    if (opts.signal?.aborted) return [];
    const tableName = collectionToTable(opts.collection);
    const where = translateFilter(opts.filter);
    const ftsQueryText = opts.queryText.slice(0, FTS_QUERY_MAX_CHARS);
    const columns = opts.withVector
      ? ["source_id", "content", "_score", "metadata_json", "vector"]
      : ["source_id", "content", "_score", "metadata_json"];

    const rows = await withReadRetry<any[]>("lexical search", opts.signal, async () => {
      const table = await getTableIfExists(tableName);
      if (!table) return [];
      return await raceWithSignal(
        () =>
          table
            .query()
            .fullTextSearch(ftsQueryText)
            .where(where)
            .select(columns)
            .limit(opts.limit)
            .toArray() as Promise<any[]>,
        opts.signal,
      ).catch((err) => {
        // Per-leg degradation: rethrow read-race / abort so withReadRetry sees
        // them; otherwise an FTS index miss or tokenizer reject yields [].
        if (opts.signal?.aborted || isLanceReadRaceError(err)) throw err;
        return [] as any[];
      });
    }, []);

    if (opts.signal?.aborted) return [];

    return (rows as any[]).map((row) => ({
      id: String(row.id ?? ""),
      source_id: String(row.source_id),
      content: String(row.content || ""),
      metadata_json: typeof row.metadata_json === "string"
        ? row.metadata_json
        : JSON.stringify(row.metadata_json ?? {}),
      similarity: null,
      lexicalScore: typeof row._score === "number" ? row._score : null,
      vector: opts.withVector ? parseHitVector(row.vector) : null,
    }));
  }

  async countRows(collection: CollectionName, filter?: VectorFilter): Promise<number> {
    const tableName = collectionToTable(collection);
    const table = await getTableIfExists(tableName);
    if (!table) return 0;
    if (!filter) return table.countRows();
    const rows = await table.query().where(translateFilter(filter)).select(["id"]).toArray();
    return (rows as any[]).length;
  }

  async optimize(collections?: CollectionName[]): Promise<void> {
    const tables = collections?.map(collectionToTable);
    await optimizeTable(tables);
  }

  async health(collection: CollectionName): Promise<TableHealth> {
    const tableName = collectionToTable(collection);
    const single = await readTableHealth(tableName);
    const dimension = await this.getStoredDimension(collection);
    return { ...single, dimension };
  }

  async reset(): Promise<{ deleted: boolean; location: string }> {
    const { deleted } = await forceResetLanceDB();
    return { deleted, location: LANCEDB_PATH };
  }

  async close(): Promise<void> {
    resetInMemoryVectorStoreState();
  }

  withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    return withWriteLock(fn);
  }
}

/**
 * Cap on the query text fed to the FTS leg of hybrid retrieval. The BM25
 * tokenizer doesn't get useful signal from very long fuzzy queries, and
 * tokenizing 24 KB+ of context every chat tick is the kind of native work
 * that's been Bun-fragile in 1.3.12+. Vector leg already uses a fixed-dim
 * embedding so it's unaffected by this clip.
 */
const FTS_QUERY_MAX_CHARS = 4096;

/** Open a native read behind the maintenance gate and race it against an abort
 *  signal so the caller's await can reject on cancel without killing the shared
 *  upstream request.
 *
 *  Takes a THUNK, not a promise: the scan must not start until beginRead() has
 *  cleared the maintenance gate, otherwise a read could open against files an
 *  in-progress optimize/index-rebuild is about to unlink.
 *
 *  Also the single chokepoint for read tracking (see beginRead/waitForReadsToDrain):
 *  the end-read is tied to the UNDERLYING native promise, never to this race
 *  wrapper. On abort the wrapper rejects early, but the native toArray() keeps
 *  running — and keeps its file handles over the version files — until it
 *  actually settles. Decrementing the read count before then would reopen the
 *  very unlink-during-read window the gate exists to close. */
export async function raceWithSignal<T>(makePromise: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const endRead = await beginRead(signal);
  let promise: Promise<T>;
  try {
    promise = makePromise();
  } catch (err) {
    endRead();
    throw err;
  }
  promise.then(endRead, endRead);

  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      v => { signal.removeEventListener("abort", onAbort); resolve(v); },
      e => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}
