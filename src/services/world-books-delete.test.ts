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

mock.module("./embeddings.service", () => ({
  deleteWorldBookEmbeddingsBeforeSourceDelete: async <T>(
    userId: string,
    worldBookIds: string[],
    _lockEntryIds: string[],
    deleteSource: () => T | Promise<T>,
  ): Promise<T> => {
    const placeholders = worldBookIds.map(() => "?").join(", ");
    sourceVisibleDuringCleanup = worldBookIds.length === 0 || (getDb().query(
      `SELECT COUNT(*) AS count FROM world_books WHERE user_id = ? AND id IN (${placeholders})`
    ).get(userId, ...worldBookIds) as { count: number }).count === worldBookIds.length;
    cleanupStarted?.();
    if (cleanupBarrier) await cleanupBarrier;
    if (failCleanup) throw new Error("vector cleanup failed");
    const bookIds = new Set(worldBookIds);
    vectors = vectors.filter((row) => row.userId !== userId || !bookIds.has(row.ownerId));
    return await deleteSource();
  },
  deleteWorldBookEntryEmbeddingsBeforeSourceDelete: async <T>(
    userId: string,
    entryIds: string[],
    deleteSource: () => T | Promise<T>,
  ): Promise<T> => {
    const placeholders = entryIds.map(() => "?").join(", ");
    sourceVisibleDuringCleanup = entryIds.length === 0 || (getDb().query(
      `SELECT COUNT(*) AS count FROM world_book_entries WHERE id IN (${placeholders})`
    ).get(...entryIds) as { count: number }).count === entryIds.length;
    if (failCleanup) throw new Error("vector cleanup failed");
    const ids = new Set(entryIds);
    vectors = vectors.filter((row) => row.userId !== userId || !ids.has(row.sourceId));
    return await deleteSource();
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
    vector_index_status, vector_indexed_at, vector_index_error, extensions, updated_at
  ) VALUES (?, ?, '[]', '[]', 'lore', '', 1, 0, 'indexed', 1, NULL, '{}', 1)`)
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
    vectorized INTEGER NOT NULL,
    disabled INTEGER NOT NULL,
    vector_index_status TEXT NOT NULL,
    vector_indexed_at INTEGER,
    vector_index_error TEXT,
    extensions TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  )`);
  vectors = [];
  failCleanup = false;
  sourceVisibleDuringCleanup = false;
  cleanupStarted = null;
  cleanupBarrier = null;
});

afterEach(() => closeDatabase());

describe("world-book cleanup-first deletion", () => {
  test("deletes whole-book vectors, including orphans, before cascading SQLite", async () => {
    insertBook("book-1", "user");
    insertEntry("entry-1", "book-1");
    vectors = [
      { userId: "user", ownerId: "book-1", sourceId: "entry-1" },
      { userId: "user", ownerId: "book-1", sourceId: "orphan" },
    ];

    expect(await worldBooksSvc.deleteWorldBook("user", "book-1")).toBe(true);
    expect(sourceVisibleDuringCleanup).toBe(true);
    expect(rowExists("world_books", "book-1")).toBe(false);
    expect(rowExists("world_book_entries", "entry-1")).toBe(false);
    expect(vectors).toEqual([]);
  });

  test("preserves book and entry sources when vector cleanup fails", async () => {
    insertBook("book-1", "user");
    insertEntry("entry-1", "book-1");
    vectors = [{ userId: "user", ownerId: "book-1", sourceId: "entry-1" }];
    failCleanup = true;

    await expect(worldBooksSvc.deleteWorldBook("user", "book-1")).rejects.toThrow("vector cleanup failed");
    expect(rowExists("world_books", "book-1")).toBe(true);
    expect(rowExists("world_book_entries", "entry-1")).toBe(true);
    expect(vectors).toHaveLength(1);

    await expect(worldBooksSvc.deleteEntry("user", "entry-1")).rejects.toThrow("vector cleanup failed");
    expect(rowExists("world_book_entries", "entry-1")).toBe(true);
  });

  test("bulk deletion is all-or-nothing and never touches foreign books", async () => {
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
    expect(rowExists("world_books", "book-1")).toBe(true);
    expect(rowExists("world_books", "book-2")).toBe(true);

    failCleanup = false;
    expect(await worldBooksSvc.bulkDeleteWorldBooks("user", ["book-1", "foreign", "book-2"]))
      .toEqual({ deleted: ["book-1", "book-2"] });
    expect(rowExists("world_books", "foreign")).toBe(true);
    expect(vectors).toEqual([{ userId: "other", ownerId: "foreign", sourceId: "entry-f" }]);
  });

  test("single-entry deletion removes vectors before deleting SQLite", async () => {
    insertBook("book-1", "user");
    insertEntry("entry-1", "book-1");
    vectors = [{ userId: "user", ownerId: "book-1", sourceId: "entry-1" }];

    expect(await worldBooksSvc.deleteEntry("user", "entry-1")).toBe(true);
    expect(sourceVisibleDuringCleanup).toBe(true);
    expect(rowExists("world_book_entries", "entry-1")).toBe(false);
    expect(vectors).toEqual([]);
  });

  test("bulk-entry deletion validates ownership and is cleanup-first", async () => {
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
    expect(rowExists("world_book_entries", "entry-1")).toBe(true);
    expect(rowExists("world_book_entries", "entry-2")).toBe(true);

    failCleanup = false;
    expect(await worldBooksSvc.bulkOperateEntries("user", "book-1", {
      action: "delete",
      entry_ids: ["entry-1", "entry-2"],
    })).toEqual({ action: "delete", affected: 2 });
    expect(rowExists("world_book_entries", "entry-1")).toBe(false);
    expect(rowExists("world_book_entries", "entry-2")).toBe(false);
    expect(vectors).toEqual([{ userId: "user", ownerId: "book-2", sourceId: "foreign-entry" }]);
  });

  test("auto-managed character cleanup awaits vector deletion", async () => {
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
    expect(rowExists("world_books", "book-1")).toBe(true);
    releaseCleanup();

    expect(await deletion).toBe(1);
    expect(rowExists("world_books", "book-1")).toBe(false);
    expect(vectors).toEqual([]);
  });
});
