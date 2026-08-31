import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../env";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { applyBaseDatabasePragmas } from "./maintenance";

let db: Database | null = null;
let dbPathResolved: string | null = null;
/** Monotonically incremented whenever the underlying Database changes. */
let _generation = 0;

export interface DatabaseResetEvent {
  previousGeneration: number;
  nextGeneration: number;
}

export interface DatabaseReplacementFence {
  /** Block new owner work immediately, then resolve once old work is drained. */
  prepare(): Promise<() => void>;
  /** Synchronous teardown may proceed only when the fence can be acquired now. */
  tryPrepareSync(): (() => void) | null;
}
interface DatabaseGenerationAdmission {
  generation: number;
  signal: AbortSignal;
}

const _resetListeners = new Set<(event: DatabaseResetEvent) => void>();
const _replacementFences = new Set<DatabaseReplacementFence>();
const admittedGeneration = new AsyncLocalStorage<DatabaseGenerationAdmission>();
let generationController = new AbortController();
let databaseReplacement: Promise<void> | null = null;

export class DatabaseGenerationCancelledError extends Error {
  readonly code = "database_generation_cancelled";

  constructor(readonly admittedGeneration: number, readonly currentGeneration: number) {
    super(`Database generation ${admittedGeneration} was replaced by generation ${currentGeneration}`);
    this.name = "DatabaseGenerationCancelledError";
  }
}

export function initDatabase(path?: string): Database {
  if (databaseReplacement || generationController.signal.aborted) {
    throw generationController.signal.reason instanceof Error
      ? generationController.signal.reason
      : new Error("Database replacement is in progress");
  }
  if (db) return db;

  const dbPath = path || `${env.dataDir}/lumiverse.db`;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const opened = new Database(dbPath);
  applyBaseDatabasePragmas(opened);
  dbPathResolved = dbPath;
  const reset = replaceGenerationDatabase(opened);
  notifyReset(reset);
  return opened;
}

export function getDb(): Database {
  const admitted = admittedGeneration.getStore();
  if (admitted !== undefined) assertDbGeneration(admitted.generation);
  if (generationController.signal.aborted) {
    throw generationController.signal.reason instanceof Error
      ? generationController.signal.reason
      : new DatabaseGenerationCancelledError(_generation, _generation + 1);
  }
  if (!db) throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

export function getDatabasePath(): string {
  return dbPathResolved || `${env.dataDir}/lumiverse.db`;
}

export function closeDatabase(): void {
  if (databaseReplacement) {
    throw new Error("Cannot synchronously close the database while an asynchronous replacement is pending");
  }
  const releases: Array<() => void> = [];
  for (const fence of _replacementFences) {
    const release = fence.tryPrepareSync();
    if (!release) {
      for (const acquired of releases.reverse()) acquired();
      throw new Error("Cannot synchronously close the database while database-owned native work is active");
    }
    releases.push(release);
  }
  const closing = db;
  try {
    dbPathResolved = null;
    const reset = replaceGenerationDatabase(null);
    closing?.close();
    notifyReset(reset);
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/**
 * Authoritative production replacement path. Fences synchronously stop new
 * generation-owned native work, retire the generation signal, and wait for
 * already-invoked native work before the generation, handle, or close becomes
 * observable.
 */
export function closeDatabaseAsync(): Promise<void> {
  if (databaseReplacement) return databaseReplacement;

  const closing = db;
  const previousGeneration = _generation;
  const nextGeneration = previousGeneration + 1;
  const waits = Array.from(_replacementFences, (fence) => fence.prepare());
  generationController.abort(new DatabaseGenerationCancelledError(previousGeneration, nextGeneration));

  const replacement = (async () => {
    const releases = await Promise.all(waits);
    try {
      dbPathResolved = null;
      const reset = replaceGenerationDatabase(null);
      closing?.close();
      notifyReset(reset);
    } finally {
      for (const release of releases.reverse()) release();
    }
  })();
  const tracked = replacement.finally(() => {
    if (databaseReplacement === tracked) databaseReplacement = null;
  });
  databaseReplacement = tracked;
  return tracked;
}

export function getDbGeneration(): number {
  const admitted = admittedGeneration.getStore();
  if (admitted !== undefined) assertDbGeneration(admitted.generation);
  return _generation;
}

export function assertDbGeneration(generation: number): void {
  const admitted = admittedGeneration.getStore();
  const signal = admitted?.generation === generation
    ? admitted.signal
    : generation === _generation
      ? generationController.signal
      : null;
  if (generation !== _generation || !db || signal?.aborted) {
    if (signal?.aborted && signal.reason instanceof DatabaseGenerationCancelledError) {
      throw signal.reason;
    }
    throw new DatabaseGenerationCancelledError(generation, _generation);
  }
}

export function getDbForGeneration(generation: number): Database {
  assertDbGeneration(generation);
  return db!;
}

/** Run admitted asynchronous work under a generation fence enforced by getDb. */
export function runWithDbGeneration<T>(generation: number, callback: () => T): T {
  assertDbGeneration(generation);
  const signal = getDbGenerationSignal(generation);
  return admittedGeneration.run({ generation, signal }, callback);
}

/** The lifecycle signal shared by every operation admitted to this generation. */
export function getDbGenerationSignal(generation: number): AbortSignal {
  assertDbGeneration(generation);
  const admitted = admittedGeneration.getStore();
  if (admitted?.generation === generation) return admitted.signal;
  return generationController.signal;
}

/** Race external or native waits so reset barriers settle even when the wait does not. */
export function raceDbGenerationCancellation<T>(
  generation: number,
  task: PromiseLike<T>,
): Promise<T> {
  const signal = getDbGenerationSignal(generation);
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(
      signal.reason instanceof DatabaseGenerationCancelledError
        ? signal.reason
        : new DatabaseGenerationCancelledError(generation, _generation),
    );
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve(task).then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) cancel();
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
}

export function isDatabaseGenerationCancellation(error: unknown): error is DatabaseGenerationCancelledError {
  return error instanceof DatabaseGenerationCancelledError;
}

/** Subscribe to DB-reset events. Returns an unsubscribe function. */
export function onDbReset(listener: (event: DatabaseResetEvent) => void): () => void {
  _resetListeners.add(listener);
  return () => _resetListeners.delete(listener);
}
/** Register native/storage work that must drain before a DB generation changes. */
export function registerDatabaseReplacementFence(fence: DatabaseReplacementFence): () => void {
  _replacementFences.add(fence);
  return () => _replacementFences.delete(fence);
}

function replaceGenerationDatabase(nextDb: Database | null): DatabaseResetEvent {
  const previousGeneration = _generation;
  const nextGeneration = previousGeneration + 1;
  const previousController = generationController;
  _generation = nextGeneration;
  db = nextDb;
  generationController = new AbortController();
  previousController.abort(new DatabaseGenerationCancelledError(previousGeneration, nextGeneration));
  return { previousGeneration, nextGeneration };
}

function notifyReset(event: DatabaseResetEvent): void {
  admittedGeneration.exit(() => {
    for (const listener of _resetListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[db] reset listener failed:", err);
      }
    }
  });
}
