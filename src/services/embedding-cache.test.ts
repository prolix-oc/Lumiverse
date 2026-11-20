import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { EmbeddingCache } from "./embedding-cache";

describe("EmbeddingCache memory release", () => {
  test("drops the in-memory tier without requiring the disk cache", () => {
    const cache = new EmbeddingCache(2);
    cache.set("one", [1, 2, 3]);
    cache.set("two", [4, 5, 6]);
    expect(cache.size).toBe(2);

    cache.clearMemory();

    expect(cache.size).toBe(0);
  });
});

describe("EmbeddingCache disk persistence", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "lumiverse-embedding-cache-"));
    initDatabase(join(directory, "cache.db"), { automaticCheckpoint: false });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(directory, { recursive: true, force: true });
  });

  test("batch writes preserve LRU eviction, replacement and disk recovery", () => {
    const cache = new EmbeddingCache(2);
    cache.setMany([
      { key: "first", vector: [1] },
      { key: "second", vector: [2] },
      { key: "first", vector: [3] },
      { key: "third", vector: [4] },
    ]);

    expect(cache.size).toBe(2);
    cache.clearMemory();
    expect(cache.get("first")).toEqual([3]);
    expect(cache.get("second")).toEqual([2]);
    expect(cache.get("third")).toEqual([4]);
  });

  test("a failed disk batch leaves memory usable and does not prevent later batches", () => {
    const db = getDb();
    db.run(`CREATE TABLE embedding_cache (cache_key TEXT PRIMARY KEY, vector TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    db.run(`CREATE TRIGGER reject_one BEFORE INSERT ON embedding_cache
      WHEN NEW.cache_key = 'reject' BEGIN SELECT RAISE(ABORT, 'rejected'); END`);
    const cache = new EmbeddingCache();
    const values = Array.from({ length: 55 }, (_, index) => ({
      key: index === 1 ? "reject" : `key-${index}`,
      vector: [index],
    }));

    expect(() => cache.setMany(values)).not.toThrow();
    expect(cache.get("reject")).toEqual([1]);
    cache.clearMemory();
    expect(cache.get("reject")).toBeNull();
    expect(cache.get("key-54")).toEqual([54]);
  });

  test("recreates disk backing when the database connection is replaced", () => {
    const cache = new EmbeddingCache();
    cache.set("old-database", [1]);
    closeDatabase();
    initDatabase(join(directory, "replacement.db"));
    cache.clearMemory();

    cache.set("new-database", [2]);
    cache.clearMemory();
    expect(cache.get("new-database")).toEqual([2]);
    expect(cache.get("old-database")).toBeNull();
  });

  test("batch persistence produces fewer WAL frames than individual writes", () => {
    const values = Array.from({ length: 100 }, (_, index) => ({
      key: `key-${index}`,
      vector: Array.from({ length: 64 }, (_, dimension) => Math.sin((index + 1) * (dimension + 1))),
    }));
    const measure = (name: string, batched: boolean) => {
      closeDatabase();
      const db = initDatabase(join(directory, `${name}.db`), { automaticCheckpoint: false });
      db.run(`CREATE TABLE embedding_cache (cache_key TEXT PRIMARY KEY, vector TEXT NOT NULL, created_at INTEGER NOT NULL)`);
      db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
      const cache = new EmbeddingCache();
      if (batched) cache.setMany(values);
      else for (const { key, vector } of values) cache.set(key, vector);
      const { log } = db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as { log: number };
      cache.clearMemory();
      expect(cache.get("key-99")).toEqual(values[99].vector);
      return log;
    };

    const individual = measure("individual", false);
    const batched = measure("batched", true);
    expect(batched).toBeLessThan(individual);
  });
});
