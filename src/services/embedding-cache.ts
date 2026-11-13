/**
 * Two-tier embedding vector cache: in-memory LRU + SQLite disk backing.
 *
 * Cache keys incorporate a model fingerprint so entries are automatically
 * invalidated when the embedding model/provider/dimensions change.
 *
 * Entries are also persisted to SQLite so they can be recovered after eviction
 * from the in-memory LRU without hitting the embedding API again.
 */

import { getDb, getDbGeneration } from "../db/connection";

export interface ModelFingerprint {
  provider: string;
  model: string;
  dimensions: number | null;
  api_url: string;
}

interface CacheEntry {
  vector: number[];
  createdAt: number;
}

interface DiskCacheEntry {
  key: string;
  vectorJson: string;
  createdAt: number;
}

// Keep write locks bounded even when a caller submits many embedding results.
const DISK_WRITE_BATCH_SIZE = 50;

export function computeCacheKey(content: string, fingerprint: ModelFingerprint): string {
  const fp = `${fingerprint.provider}|${fingerprint.model}|${fingerprint.dimensions ?? ""}|${fingerprint.api_url}`;
  return `${Bun.hash(fp).toString(36)}:${Bun.hash(content).toString(36)}`;
}

export class EmbeddingCache {
  private map = new Map<string, CacheEntry>();
  private maxSize: number;
  private ttlMs: number;
  private diskGeneration = -1;

  constructor(maxSize = 2048, ttlMs = 600_000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  // ---- SQLite disk layer ----

  private ensureDiskTable(): boolean {
    const generation = getDbGeneration();
    if (this.diskGeneration === generation) return true;
    try {
      const db = getDb();
      db.run(`
        CREATE TABLE IF NOT EXISTS embedding_cache (
          cache_key TEXT PRIMARY KEY,
          vector    TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      this.diskGeneration = generation;
      return true;
    } catch {
      // DB not initialised yet — disk layer unavailable, memory-only is fine
      return false;
    }
  }

  private writeToDisk(entries: ReadonlyArray<{ key: string; entry: CacheEntry }>): void {
    if (entries.length === 0) return;
    try {
      if (!this.ensureDiskTable()) return;
      const db = getDb();
      const insert = db.query(
        `INSERT OR REPLACE INTO embedding_cache (cache_key, vector, created_at) VALUES (?, ?, ?)`,
      );
      const writeBatch = db.transaction((batch: DiskCacheEntry[]) => {
        for (const row of batch) insert.run(row.key, row.vectorJson, row.createdAt);
      });

      for (let offset = 0; offset < entries.length; offset += DISK_WRITE_BATCH_SIZE) {
        const batch: DiskCacheEntry[] = [];
        for (const { key, entry } of entries.slice(offset, offset + DISK_WRITE_BATCH_SIZE)) {
          try {
            const vectorJson = JSON.stringify(entry.vector);
            if (typeof vectorJson === "string") batch.push({ key, vectorJson, createdAt: entry.createdAt });
          } catch {
            // A bad cache value must not prevent other vectors from being cached.
          }
        }
        try {
          if (batch.length === 1) {
            const row = batch[0];
            insert.run(row.key, row.vectorJson, row.createdAt);
          } else if (batch.length > 1) {
            writeBatch(batch);
          }
        } catch {
          // Disk caching is best-effort; continue with later bounded batches.
        }
      }
    } catch {
      // Non-critical — worst case we re-embed on next miss
    }
  }

  private readFromDisk(key: string): CacheEntry | null {
    try {
      if (!this.ensureDiskTable()) return null;
      const db = getDb();
      const row = db.query<{ vector: string; created_at: number }, [string]>(
        `SELECT vector, created_at FROM embedding_cache WHERE cache_key = ?`
      ).get(key);
      if (!row) return null;
      return { vector: JSON.parse(row.vector), createdAt: row.created_at };
    } catch {
      return null;
    }
  }

  private deleteFromDisk(key: string): void {
    try {
      if (!this.ensureDiskTable()) return;
      const db = getDb();
      db.run(`DELETE FROM embedding_cache WHERE cache_key = ?`, [key]);
    } catch {
      // Non-critical
    }
  }

  private clearDisk(): void {
    try {
      if (!this.ensureDiskTable()) return;
      const db = getDb();
      db.run(`DELETE FROM embedding_cache`);
    } catch {
      // Non-critical
    }
  }

  // ---- Public API ----

  get(key: string): number[] | null {
    // 1. Check in-memory
    const entry = this.map.get(key);
    if (entry) {
      if (Date.now() - entry.createdAt > this.ttlMs) {
        this.map.delete(key);
        this.deleteFromDisk(key);
        return null;
      }
      // Promote to most-recently-used
      this.map.delete(key);
      this.map.set(key, entry);
      return entry.vector;
    }

    // 2. Check disk
    const diskEntry = this.readFromDisk(key);
    if (!diskEntry) return null;

    if (Date.now() - diskEntry.createdAt > this.ttlMs) {
      this.deleteFromDisk(key);
      return null;
    }

    // Promote into in-memory LRU
    this.evictIfNeeded();
    this.map.set(key, diskEntry);
    return diskEntry.vector;
  }

  set(key: string, vector: number[]): void {
    this.setMany([{ key, vector }]);
  }

  setMany(values: ReadonlyArray<{ key: string; vector: number[] }>): void {
    const entries: Array<{ key: string; entry: CacheEntry }> = [];
    for (const { key, vector } of values) {
      const entry: CacheEntry = { vector, createdAt: Date.now() };

      // If key already exists, delete first so insertion order is updated.
      this.map.delete(key);
      this.evictIfNeeded();
      this.map.set(key, entry);
      entries.push({ key, entry });
    }

    this.writeToDisk(entries);
  }

  clear(): void {
    this.map.clear();
    this.clearDisk();
  }

  /** Drop only the in-memory tier while preserving the reusable SQLite cache. */
  clearMemory(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  // ---- Internal ----

  private evictIfNeeded(): void {
    if (this.map.size < this.maxSize) return;
    const oldest = this.map.keys().next().value;
    if (oldest !== undefined) {
      // Evicted entry is already on disk (written at set() time), so just remove from memory
      this.map.delete(oldest);
    }
  }
}

export const embeddingCache = new EmbeddingCache();
