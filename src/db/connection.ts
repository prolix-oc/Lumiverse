import { Database } from "bun:sqlite";
import { env } from "../env";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { applyBaseDatabasePragmas, type DatabasePragmaOptions } from "./maintenance";

/** Transactions must finish before yielding control to unrelated requests. */
class ManagedDatabase extends Database {
  override transaction<A extends any[], T>(fn: (...args: A) => T) {
    if (fn.constructor.name === "AsyncFunction") {
      throw new TypeError("SQLite transaction callbacks must be synchronous");
    }
    return super.transaction(function (this: unknown, ...args: A): T {
      const result = fn.apply(this, args);
      if (result && typeof (result as any).then === "function") {
        // Observe a rejected promise while Bun rolls the transaction back.
        void Promise.resolve(result).catch(() => {});
        throw new TypeError("SQLite transaction callbacks must not return promises");
      }
      return result;
    });
  }
}

let db: Database | null = null;
let dbPathResolved: string | null = null;
/**
 * Monotonically-incremented every time the underlying Database changes (open,
 * close, migrate, test reset). Modules that cache prepared statements check
 * this token to invalidate stale handles.
 */
let _generation = 0;
const _resetListeners = new Set<() => void>();

export function initDatabase(path?: string, options: DatabasePragmaOptions = {}): Database {
  if (db) return db;

  const dbPath = path || `${env.dataDir}/lumiverse.db`;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const candidate = new ManagedDatabase(dbPath);
  try {
    applyBaseDatabasePragmas(candidate, options);
  } catch (err) {
    candidate.close(true);
    throw err;
  }
  db = candidate;
  dbPathResolved = dbPath;
  _generation++;
  notifyReset();

  return db;
}

export function getDb(): Database {
  if (!db) throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

export function getDatabasePath(): string {
  return dbPathResolved || `${env.dataDir}/lumiverse.db`;
}

export function closeDatabase(): void {
  if (db) {
    // Finalize outstanding statements, including abandoned iterators, before
    // releasing the connection. Do not leave zombie handles until GC.
    db.close(true);
    db = null;
  }
  dbPathResolved = null;
  _generation++;
  notifyReset();
}

/**
 * Returns a token that changes whenever the underlying Database is replaced.
 * Modules that memoize prepared statements should compare this against their
 * cached value before reusing a statement; statements bound to a closed
 * Database silently fail in bun:sqlite.
 */
export function getDbGeneration(): number {
  return _generation;
}

/** Subscribe to DB-reset events. Returns an unsubscribe function. */
export function onDbReset(listener: () => void): () => void {
  _resetListeners.add(listener);
  return () => _resetListeners.delete(listener);
}

function notifyReset(): void {
  for (const listener of _resetListeners) {
    try {
      listener();
    } catch (err) {
      console.error("[db] reset listener failed:", err);
    }
  }
}
