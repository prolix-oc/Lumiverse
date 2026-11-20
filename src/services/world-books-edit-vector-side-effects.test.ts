import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

import { closeDatabase, getDb, initDatabase } from "../db/connection";

const deletedEntryIds: string[] = [];
const queued: Array<{ userId: string; entryId: string; priority?: number; supersedesIndexed?: boolean }> = [];

mock.module("./embeddings.service", () => ({
  deleteWorldBookEntryEmbeddings: async (userId: string, entryId: string) => {
    deletedEntryIds.push(`${userId}:${entryId}`);
  },
  deleteWorldBookEntryEmbeddingsBeforeSourceDelete: async <T>(
    _userId: string,
    _entryIds: string[],
    deleteSource: () => T | Promise<T>,
  ): Promise<T> => await deleteSource(),
}));
mock.module("./vectorization-queue.service", () => ({
  queueWorldBookEntryVectorization: (
    userId: string,
    entryId: string,
    priority?: number,
    supersedesIndexed?: boolean,
  ) => {
    queued.push({ userId, entryId, priority, supersedesIndexed });
  },
}));

const { createEntry, createWorldBook, getWorldBookVectorSummary, updateEntry } = await import("./world-books.service");

const OWNER_ID = "lorebook-edit-vector-owner";

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
}

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  await applyBaseline();
  deletedEntryIds.length = 0;
  queued.length = 0;
});

afterEach(() => closeDatabase());

describe("lorebook edit vector side effects", () => {
  test("baseline indexes authored-order pagination by book", () => {
    const indexes = getDb().query("PRAGMA index_list('world_book_entries')").all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain("idx_wbe_world_book_order");
  });

  test("vector summary aggregates entry state without materializing entry payloads", () => {
    const book = createWorldBook(OWNER_ID, { name: "Summary" });
    const indexed = createEntry(OWNER_ID, book.id, { content: "indexed", vectorized: true })!;
    const pending = createEntry(OWNER_ID, book.id, { content: "pending", vectorized: true })!;
    const failed = createEntry(OWNER_ID, book.id, { content: "failed", vectorized: true })!;
    createEntry(OWNER_ID, book.id, { content: "", vectorized: false });
    getDb().query("UPDATE world_book_entries SET vector_index_status = 'indexed' WHERE id = ?").run(indexed.id);
    getDb().query("UPDATE world_book_entries SET vector_index_status = 'pending' WHERE id = ?").run(pending.id);
    getDb().query("UPDATE world_book_entries SET vector_index_status = 'error' WHERE id = ?").run(failed.id);

    expect(getWorldBookVectorSummary(OWNER_ID, book.id)).toEqual({
      total: 4,
      enabled: 3,
      non_empty: 3,
      enabled_non_empty: 3,
      not_enabled: 1,
      pending: 1,
      indexed: 1,
      error: 1,
    });
    expect(getWorldBookVectorSummary("different-owner", book.id)).toBeNull();
  });

  test("content edits mark pending and enqueue replacement instead of deleting Lance rows", () => {
    const book = createWorldBook(OWNER_ID, { name: "Edit settle" });
    const entry = createEntry(OWNER_ID, book.id, {
      comment: "dragon",
      content: "old lore",
      vectorized: true,
    });
    if (!entry) throw new Error("failed to create vectorized lorebook entry");
    queued.length = 0;

    getDb().query(
      "UPDATE world_book_entries SET vector_index_status = 'indexed', vector_indexed_at = 1 WHERE id = ?",
    ).run(entry.id);

    const updated = updateEntry(OWNER_ID, entry.id, { content: "new lore" });
    expect(updated?.vector_index_status).toBe("pending");
    expect(updated?.vector_indexed_at).toBeNull();
    expect(deletedEntryIds).toEqual([]);
    expect(queued).toEqual([{
      userId: OWNER_ID,
      entryId: entry.id,
      priority: 4,
      supersedesIndexed: true,
    }]);
  });

  test("turning vectorization off still deletes Lance rows immediately", () => {
    const book = createWorldBook(OWNER_ID, { name: "Disable vectors" });
    const entry = createEntry(OWNER_ID, book.id, {
      comment: "dragon",
      content: "old lore",
      vectorized: true,
    });
    if (!entry) throw new Error("failed to create vectorized lorebook entry");
    queued.length = 0;

    const updated = updateEntry(OWNER_ID, entry.id, { vectorized: false });
    expect(updated?.vectorized).toBe(false);
    expect(updated?.vector_index_status).toBe("not_enabled");
    expect(deletedEntryIds).toEqual([`${OWNER_ID}:${entry.id}`]);
    expect(queued).toEqual([]);
  });
});
