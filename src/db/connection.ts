import { Database } from "bun:sqlite";
import { env } from "../env";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { applyBaseDatabasePragmas } from "./maintenance";

let db: Database | null = null;
let dbPathResolved: string | null = null;
/**
 * Monotonically-incremented every time the underlying Database changes (open,
 * close, migrate, test reset). Modules that cache prepared statements check
 * this token to invalidate stale handles.
 */
let _generation = 0;
const _resetListeners = new Set<() => void>();

export function initDatabase(path?: string): Database {
  if (db) return db;

  const dbPath = path || `${env.dataDir}/lumiverse.db`;
  dbPathResolved = dbPath;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  applyBaseDatabasePragmas(db);
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
    db.close();
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
