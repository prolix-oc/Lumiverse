import { Database } from "bun:sqlite";
import { env } from "../env";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

let db: Database | null = null;

export function initDatabase(path?: string): Database {
  if (db) return db;

  const dbPath = path || `${env.dataDir}/lumiverse.db`;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA cache_size = -64000");
  db.run("PRAGMA temp_store = MEMORY");
  // Memory-mapped I/O: disabled on Windows where mandatory file locks from
  // mmap regions conflict with WAL checkpointing, causing freezes over time.
  const isWindows = process.platform === "win32";
  db.run(`PRAGMA mmap_size = ${isWindows ? 0 : 268435456}`);
  // Checkpoint the WAL more aggressively to prevent unbounded WAL growth.
  // Default (1000 pages) can let the WAL grow large on busy instances;
  // on Windows this compounds the file-locking pressure.
  db.run("PRAGMA wal_autocheckpoint = 500");

  return db;
}

export function getDb(): Database {
  if (!db) throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
