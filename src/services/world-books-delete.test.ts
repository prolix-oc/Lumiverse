import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";

interface FakeVectorRow {
  userId: string;
  ownerId: string;
  sourceId: string;
}

let vectors: FakeVectorRow[] = [];
let failCleanup = false;
let sourceVisibleDuringCleanup = false;
let cleanupStarted: (() => void) | null = null;
let cleanupBarrier: Promise<void> | null = null;
let beforeEntryDelete: (() => void) | null = null;
function readCount(sql: string, ...args: string[]): number {
  const value: unknown = getDb().query(sql).get(...args);
  if (!value || typeof value !== "object" || !("count" in value) || typeof value.count !== "number") {
    throw new Error("count query returned an invalid row");
  }
  return value.count;
}

mock.module("./embeddings.service", () => ({
  deleteWorldBookEmbeddingsBeforeSourceDelete: async <T>(
    userId: string,
    worldBookIds: string[],
    _lockEntryIds: string[],
    deleteSource: () => T | Promise<T>,
  ): Promise<T> => {
    const placeholders = worldBookIds.map(() => "?").join(", ");
    const deleted = await deleteSource();
    sourceVisibleDuringCleanup = worldBookIds.length === 0 || readCount(
      `SELECT COUNT(*) AS count FROM world_books WHERE user_id = ? AND id IN (${placeholders})`,
      userId,
      ...worldBookIds,
    ) === worldBookIds.length;
    cleanupStarted?.();
    if (cleanupBarrier) await cleanupBarrier;
    if (failCleanup) throw new Error("vector cleanup failed");
    const bookIds = new Set(worldBookIds);
    vectors = vectors.filter((row) => row.userId !== userId || !bookIds.has(row.ownerId));
    return deleted;
  },
  deleteWorldBookEntryEmbeddingsBeforeSourceDelete: async <T>(
    userId: string,
    entryIds: string[],
    deleteSource: () => T | Promise<T>,
  ): Promise<T> => {
    beforeEntryDelete?.();
    beforeEntryDelete = null;
    const deleted = await deleteSource();
    const placeholders = entryIds.map(() => "?").join(", ");
    sourceVisibleDuringCleanup = entryIds.length === 0 || readCount(
      `SELECT COUNT(*) AS count FROM world_book_entries WHERE id IN (${placeholders})`,
      ...entryIds,
    ) === entryIds.length;
    if (failCleanup) throw new Error("vector cleanup failed");
    const ids = new Set(entryIds);
    vectors = vectors.filter((row) => row.userId !== userId || !ids.has(row.sourceId));
    return deleted;
  },
  deleteWorldBookEntryEmbeddings: async () => {},
}));

const worldBooksSvc = await import("./world-books.service");

function insertBook(id: string, userId: string, metadata: Record<string, unknown> = {}): void {
  getDb().query(`INSERT INTO world_books (
    id, user_id, name, description, folder, metadata, created_at, updated_at
  ) VALUES (?, ?, ?, '', '', ?, 1, 1)`).run(id, userId, id, JSON.stringify(metadata));
}

function insertEntry(id: string, bookId: string): void {
  getDb().query(`INSERT INTO world_book_entries (
    id, world_book_id, key, keysecondary, content, comment, vectorized, disabled,
    vector_index_status, vector_indexed_at, vector_index_error, extensions
  ) VALUES (?, ?, '[]', '[]', 'lore', '', 1, 0, 'indexed', 1, NULL, '{}')`)
    .run(id, bookId);
}

function rowExists(table: "world_books" | "world_book_entries", id: string): boolean {
  return getDb().query(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) != null;
}

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE world_books (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE world_book_entries (
    id TEXT PRIMARY KEY,
    world_book_id TEXT NOT NULL REFERENCES world_books(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    keysecondary TEXT NOT NULL,
    content TEXT NOT NULL,
    comment TEXT NOT NULL,
    constant INTEGER NOT NULL DEFAULT 0,
    vectorized INTEGER NOT NULL,
    disabled INTEGER NOT NULL,
    vector_index_status TEXT NOT NULL,
    vector_indexed_at INTEGER,
    vector_index_error TEXT,
    extensions TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 1
  )`);
  vectors = [];
  failCleanup = false;
  sourceVisibleDuringCleanup = false;
  cleanupStarted = null;
  cleanupBarrier = null;
  beforeEntryDelete = null;
});

afterEach(() => closeDatabase());

describe("world-book source-first deletion", () => {
  test("deletes whole-book vectors after cascading SQLite", async () => {
    insertBook("book-1", "user");
    insertEntry("entry-1", "book-1");
    vectors = [
      { userId: "user", ownerId: "book-1", sourceId: "entry-1" },
      { userId: "user", ownerId: "book-1", sourceId: "orphan" },
    ];

    expect(await worldBooksSvc.deleteWorldBook("user", "book-1")).toBe(true);
    expect(sourceVisibleDuringCleanup).toBe(false);
    expect(rowExists("world_books", "book-1")).toBe(false);
    expect(rowExists("world_book_entries", "entry-1")).toBe(false);
    expect(vectors).toEqual([]);
  });

  test("commits source deletion before reporting vector cleanup failure", async () => {
    insertBook("book-1", "user");
    insertEntry("entry-1", "book-1");
    vectors = [{ userId: "user", ownerId: "book-1", sourceId: "entry-1" }];
    failCleanup = true;

    await expect(worldBooksSvc.deleteWorldBook("user", "book-1")).rejects.toThrow("vector cleanup failed");
    expect(rowExists("world_books", "book-1")).toBe(false);
    expect(rowExists("world_book_entries", "entry-1")).toBe(false);
    expect(vectors).toHaveLength(1);

    insertBook("book-1", "user");
    insertEntry("entry-1", "book-1");
    vectors = [{ userId: "user", ownerId: "book-1", sourceId: "entry-1" }];
    await expect(worldBooksSvc.deleteEntry("user", "book-1", "entry-1")).rejects.toThrow("vector cleanup failed");
    expect(rowExists("world_book_entries", "entry-1")).toBe(false);
    expect(vectors).toHaveLength(1);
  });

  test("bulk deletion commits owned sources before cleanup and never touches foreign books", async () => {
    insertBook("book-1", "user");
    insertBook("book-2", "user");
    insertBook("foreign", "other");
    insertEntry("entry-1", "book-1");
    insertEntry("entry-2", "book-2");
    insertEntry("entry-f", "foreign");
    vectors = [
      { userId: "user", ownerId: "book-1", sourceId: "entry-1" },
      { userId: "user", ownerId: "book-2", sourceId: "entry-2" },
      { userId: "other", ownerId: "foreign", sourceId: "entry-f" },
    ];
    failCleanup = true;
    await expect(worldBooksSvc.bulkDeleteWorldBooks("user", ["book-1", "foreign", "book-2"]))
      .rejects.toThrow("vector cleanup failed");
    expect(rowExists("world_books", "book-1")).toBe(false);
    expect(rowExists("world_books", "book-2")).toBe(false);
    expect(rowExists("world_books", "foreign")).toBe(true);
    expect(vectors).toHaveLength(3);
  });

  test("single-entry deletion removes vectors after deleting SQLite", async () => {
    insertBook("book-1", "user");
    insertEntry("entry-1", "book-1");
    vectors = [{ userId: "user", ownerId: "book-1", sourceId: "entry-1" }];

    expect(await worldBooksSvc.deleteEntry("user", "book-1", "entry-1")).toBe(true);
    expect(sourceVisibleDuringCleanup).toBe(false);
    expect(rowExists("world_book_entries", "entry-1")).toBe(false);
    expect(vectors).toEqual([]);
  });

  test("stale entry deletion preserves the live source vectors", async () => {
    insertBook("book-1", "user");
    insertEntry("entry-1", "book-1");
    vectors = [{ userId: "user", ownerId: "book-1", sourceId: "entry-1" }];
    beforeEntryDelete = () => {
      getDb().query("UPDATE world_book_entries SET revision = 2 WHERE id = ?").run("entry-1");
    };

    await expect(worldBooksSvc.deleteEntry("user", "book-1", "entry-1", 1)).rejects.toThrow();
    expect(rowExists("world_book_entries", "entry-1")).toBe(true);
    expect(vectors).toEqual([{ userId: "user", ownerId: "book-1", sourceId: "entry-1" }]);
  });
  test("stale bulk entry deletion preserves every source vector", async () => {
    insertBook("book-1", "user");
    insertEntry("entry-1", "book-1");
    insertEntry("entry-2", "book-1");
    vectors = [
      { userId: "user", ownerId: "book-1", sourceId: "entry-1" },
      { userId: "user", ownerId: "book-1", sourceId: "entry-2" },
    ];
    beforeEntryDelete = () => {
      getDb().query("UPDATE world_book_entries SET revision = 2 WHERE id = ?").run("entry-1");
    };

    await expect(worldBooksSvc.bulkOperateEntries("user", "book-1", {
      action: "delete",
      entry_ids: ["entry-1", "entry-2"],
      expected_revisions: { "entry-1": 1, "entry-2": 1 },
    })).rejects.toThrow();
    expect(rowExists("world_book_entries", "entry-1")).toBe(true);
    expect(rowExists("world_book_entries", "entry-2")).toBe(true);
    expect(vectors).toEqual([
      { userId: "user", ownerId: "book-1", sourceId: "entry-1" },
      { userId: "user", ownerId: "book-1", sourceId: "entry-2" },
    ]);
  });
  test("bulk-entry deletion validates ownership and deletes vectors after source CAS", async () => {
    insertBook("book-1", "user");
    insertBook("book-2", "user");
    insertEntry("entry-1", "book-1");
    insertEntry("entry-2", "book-1");
    insertEntry("foreign-entry", "book-2");
    vectors = [
      { userId: "user", ownerId: "book-1", sourceId: "entry-1" },
      { userId: "user", ownerId: "book-1", sourceId: "entry-2" },
      { userId: "user", ownerId: "book-2", sourceId: "foreign-entry" },
    ];

    await expect(worldBooksSvc.bulkOperateEntries("user", "book-1", {
      action: "delete",
      entry_ids: ["entry-1", "foreign-entry"],
    })).rejects.toThrow("One or more entries were not found");
    expect(vectors).toHaveLength(3);
    expect(rowExists("world_book_entries", "entry-1")).toBe(true);

    failCleanup = true;
    await expect(worldBooksSvc.bulkOperateEntries("user", "book-1", {
      action: "delete",
      entry_ids: ["entry-1", "entry-2"],
    })).rejects.toThrow("vector cleanup failed");
    expect(rowExists("world_book_entries", "entry-1")).toBe(false);
    expect(rowExists("world_book_entries", "entry-2")).toBe(false);
    expect(vectors).toHaveLength(3);

    insertEntry("entry-1", "book-1");
    insertEntry("entry-2", "book-1");
    failCleanup = false;
    expect(await worldBooksSvc.bulkOperateEntries("user", "book-1", {
      action: "delete",
      entry_ids: ["entry-1", "entry-2"],
    })).toEqual({ action: "delete", affected: 2 });
    expect(rowExists("world_book_entries", "entry-1")).toBe(false);
    expect(rowExists("world_book_entries", "entry-2")).toBe(false);
    expect(vectors).toEqual([{ userId: "user", ownerId: "book-2", sourceId: "foreign-entry" }]);
  });

  test("bulk activation switches selected entries to a single activation method", async () => {
    insertBook("book-1", "user");
    insertEntry("entry-1", "book-1");

    expect(await worldBooksSvc.bulkOperateEntries("user", "book-1", {
      action: "set_activation",
      entry_ids: ["entry-1"],
      activation: "constant",
    })).toEqual({ action: "set_activation", affected: 1 });

    expect(getDb().query(
      "SELECT constant, vectorized, vector_index_status, vector_indexed_at, vector_index_error FROM world_book_entries WHERE id = ?",
    ).get("entry-1")).toEqual({
      constant: 1,
      vectorized: 0,
      vector_index_status: "not_enabled",
      vector_indexed_at: null,
      vector_index_error: null,
    });
  });

  test("auto-managed character cleanup commits source before awaiting vector deletion", async () => {
    insertBook("book-1", "user", {
      auto_managed_by_character: true,
      source_character_id: "character-1",
    });
    insertEntry("entry-1", "book-1");
    vectors = [{ userId: "user", ownerId: "book-1", sourceId: "entry-1" }];
    let releaseCleanup!: () => void;
    let markCleanupStarted!: () => void;
    cleanupBarrier = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const started = new Promise<void>((resolve) => { markCleanupStarted = resolve; });
    cleanupStarted = markCleanupStarted;

    const deletion = worldBooksSvc.deleteAutoManagedCharacterWorldBooks("user", "character-1");
    await started;
    expect(rowExists("world_books", "book-1")).toBe(false);
    releaseCleanup();

    expect(await deletion).toBe(1);
    expect(rowExists("world_books", "book-1")).toBe(false);
    expect(vectors).toEqual([]);
  });
});
