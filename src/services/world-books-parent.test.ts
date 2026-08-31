import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

import { closeDatabase, getDb, initDatabase } from "../db/connection";

mock.module("./embeddings.service", () => ({
  deleteWorldBookEntryEmbeddings: async () => {},
  deleteWorldBookEntryEmbeddingsBeforeSourceDelete: async <T>(
    _userId: string,
    _entryIds: string[],
    deleteSource: () => T | Promise<T>,
  ): Promise<T> => await deleteSource(),
}));
mock.module("./vectorization-queue.service", () => ({
  queueWorldBookEntryVectorization: () => {},
}));

const {
  bulkOperateEntries,
  createEntry,
  createWorldBook,
  deleteEntry,
  getEntry,
  listEntries,
  updateEntry,
} = await import("./world-books.service");

const OWNER_ID = "world-books-parent-owner";

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
});
afterEach(() => closeDatabase());

describe("world-book entry parent identity", () => {
  test("updateEntry does not move an entry when world_book_id is supplied", () => {
    const bookA = createWorldBook(OWNER_ID, { name: "A" });
    const bookB = createWorldBook(OWNER_ID, { name: "B" });
    const entry = createEntry(OWNER_ID, bookA.id, {
      comment: "owned-by-a",
      content: "body",
      world_book_id: bookB.id,
    } as Parameters<typeof createEntry>[2] & { world_book_id: string })!;

    expect(entry.world_book_id).toBe(bookA.id);

    const updated = updateEntry(OWNER_ID, bookA.id, entry.id, {
      content: "next",
      world_book_id: bookB.id,
      expected_revision: entry.revision,
    } as Parameters<typeof updateEntry>[3] & { world_book_id: string });

    expect(updated?.world_book_id).toBe(bookA.id);
    expect(updated?.content).toBe("next");
    expect(getEntry(OWNER_ID, entry.id)?.world_book_id).toBe(bookA.id);
    expect(listEntries(OWNER_ID, bookA.id).map((row) => row.id)).toEqual([entry.id]);
    expect(listEntries(OWNER_ID, bookB.id)).toEqual([]);
  });

  test("stale expected parent does not mutate an entry after bulk move", async () => {
    const bookA = createWorldBook(OWNER_ID, { name: "A" });
    const bookB = createWorldBook(OWNER_ID, { name: "B" });
    const entry = createEntry(OWNER_ID, bookA.id, { comment: "move-me", content: "body" })!;

    await bulkOperateEntries(OWNER_ID, bookA.id, {
      action: "move",
      entry_ids: [entry.id],
      target_book_id: bookB.id,
    });

    expect(updateEntry(OWNER_ID, bookA.id, entry.id, { content: "stale-write" })).toBeNull();
    expect(await deleteEntry(OWNER_ID, bookA.id, entry.id)).toBe(false);
    const live = getEntry(OWNER_ID, entry.id);
    expect(live?.world_book_id).toBe(bookB.id);
    expect(live?.content).toBe("body");
    expect(listEntries(OWNER_ID, bookA.id)).toEqual([]);
    expect(listEntries(OWNER_ID, bookB.id).map((row) => row.id)).toEqual([entry.id]);
  });

});
