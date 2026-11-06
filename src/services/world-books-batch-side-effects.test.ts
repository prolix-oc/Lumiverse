import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { WorkerHostContentApi, type SpindleBatchJsonValue, type SpindleBatchOperation } from "../spindle/worker-host-content-api";

const singleDeletes: string[] = [];
const groupedDeletes: string[][] = [];

mock.module("./embeddings.service", () => ({
  deleteWorldBookEntryEmbeddings: async (_userId: string, entryId: string) => {
    singleDeletes.push(entryId);
  },
  deleteWorldBookEntryEmbeddingsBeforeSourceDelete: async <T>(
    _userId: string,
    entryIds: string[],
    deleteSource: () => T | Promise<T>,
  ): Promise<T> => {
    groupedDeletes.push([...entryIds]);
    return await deleteSource();
  },
}));
mock.module("./vectorization-queue.service", () => ({
  queueWorldBookEntryVectorization: () => {},
}));

const { bulkOperateEntries, createEntry, createWorldBook, getEntry, updateEntry } = await import("./world-books.service");

const OWNER_ID = "batch-side-effects-owner";

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function deletedIds(): string[] {
  return [...singleDeletes, ...groupedDeletes.flat()].sort();
}

function markIndexed(entryId: string): void {
  getDb().query(
    "UPDATE world_book_entries SET vector_index_status = 'indexed', vector_indexed_at = 1 WHERE id = ?",
  ).run(entryId);
}

function entries(bookId: string, count: number, vectorized: boolean) {
  return Array.from({ length: count }, (_, i) => {
    const entry = createEntry(OWNER_ID, bookId, { comment: `entry ${i}`, content: `lore ${i}`, vectorized });
    if (!entry) throw new Error("failed to create entry");
    if (vectorized) markIndexed(entry.id);
    return entry;
  });
}

const update = (id: string, input: { [key: string]: SpindleBatchJsonValue }): SpindleBatchOperation => ({ domain: "world_books", op: "entries.update", args: { id, input } });

function makeApi() {
  const responses: Array<{ requestId: string; result?: unknown; error?: string }> = [];
  const api = new WorkerHostContentApi({
    manifest: { identifier: "batch-side-effects-test" },
    hasPermission: (permission) => permission === "world_books",
    resolveEffectiveUserId: () => OWNER_ID,
    enforceScopedUser: (userId) => expect(userId).toBe(OWNER_ID),
    postResponse: (message) => responses.push(message),
  });
  return { api, responses };
}

function recordEvents() {
  const bookChanged: string[] = [];
  const counts = { entryChanged: 0, batchChanged: 0 };
  const off = [
    eventBus.on(EventType.WORLD_BOOK_CHANGED, (message) => { bookChanged.push((message.payload as { id: string }).id); }),
    eventBus.on(EventType.WORLD_BOOK_ENTRY_CHANGED, () => { counts.entryChanged++; }),
    eventBus.on(EventType.SPINDLE_BATCH_CHANGED, () => { counts.batchChanged++; }),
  ];
  return { bookChanged, counts, stop: () => off.forEach((remove) => remove()) };
}

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  await applyBaseline();
  singleDeletes.length = 0;
  groupedDeletes.length = 0;
});

afterEach(() => closeDatabase());

describe("spindle batch world book events", () => {
  test("a committed batch emits one WORLD_BOOK_CHANGED per touched book and no per-entry events", async () => {
    const bookA = createWorldBook(OWNER_ID, { name: "A" });
    const bookB = createWorldBook(OWNER_ID, { name: "B" });
    const untouched = createWorldBook(OWNER_ID, { name: "Untouched" });
    const ops = [...entries(bookA.id, 3, false), ...entries(bookB.id, 2, false)].map((e) => update(e.id, { comment: "changed" }));
    entries(untouched.id, 1, false);
    const events = recordEvents();
    const { api, responses } = makeApi();
    try {
      api.handleSpindleBatch("commit", ops, undefined, OWNER_ID);
      await settle();
      expect(responses[0]?.result).toHaveLength(5);
      expect((responses[0]?.result as Array<{ ok: boolean }>).every((r) => r.ok)).toBe(true);
      expect(events.bookChanged.sort()).toEqual([bookA.id, bookB.id].sort());
      expect(events.counts).toEqual({ entryChanged: 0, batchChanged: 1 });
    } finally {
      events.stop();
    }
  });

  test("the book event carries the book with its post-batch timestamp", async () => {
    const book = createWorldBook(OWNER_ID, { name: "Stamped" });
    const [entry] = entries(book.id, 1, false);
    getDb().query("UPDATE world_books SET updated_at = 1 WHERE id = ?").run(book.id);
    const payloads: Array<{ id: string; worldBook: { id: string; updated_at: number } }> = [];
    const off = eventBus.on(EventType.WORLD_BOOK_CHANGED, (message) => { payloads.push(message.payload as never); });
    try {
      makeApi().api.handleSpindleBatch("commit", [update(entry!.id, { comment: "changed" })], undefined, OWNER_ID);
      await settle();
      expect(payloads).toHaveLength(1);
      expect(payloads[0]!.worldBook.id).toBe(book.id);
      expect(payloads[0]!.worldBook.updated_at).toBeGreaterThan(1);
    } finally {
      off();
    }
  });

  test("a rolled back batch emits no book events", async () => {
    const book = createWorldBook(OWNER_ID, { name: "Rollback" });
    const [entry] = entries(book.id, 1, false);
    const events = recordEvents();
    const { api, responses } = makeApi();
    try {
      api.handleSpindleBatch("rollback", [update(entry!.id, { comment: "leaked" }), update("missing-entry", { comment: "never" })], undefined, OWNER_ID);
      await settle();
      expect(getEntry(OWNER_ID, entry!.id)?.comment).toBe(entry!.comment);
      expect((responses[0]?.result as Array<{ ok: boolean }>).every((r) => !r.ok)).toBe(true);
      expect(events.bookChanged).toEqual([]);
      expect(events.counts).toEqual({ entryChanged: 0, batchChanged: 0 });
    } finally {
      events.stop();
    }
  });

  test("a revision conflict rolls back the batch without events or vector deletes", async () => {
    const book = createWorldBook(OWNER_ID, { name: "Conflict" });
    const [entry] = entries(book.id, 1, true);
    const events = recordEvents();
    try {
      makeApi().api.handleSpindleBatch("conflict", [update(entry!.id, { vectorized: false })], { expected_revisions: { [entry!.id]: entry!.revision + 5 } }, OWNER_ID);
      await settle();
      expect(getEntry(OWNER_ID, entry!.id)?.vectorized).toBe(true);
      expect(events.bookChanged).toEqual([]);
      expect(deletedIds()).toEqual([]);
    } finally {
      events.stop();
    }
  });
});

describe("spindle batch vector cleanup", () => {
  test("a rolled back batch does not delete vectors of entries that stay vectorized", async () => {
    const book = createWorldBook(OWNER_ID, { name: "Rollback vectors" });
    const [entry] = entries(book.id, 1, true);
    const { api } = makeApi();
    api.handleSpindleBatch("rollback", [update(entry!.id, { vectorized: false }), update("missing-entry", { comment: "never" })], undefined, OWNER_ID);
    await settle();
    const after = getEntry(OWNER_ID, entry!.id);
    expect(after?.vectorized).toBe(true);
    expect(after?.vector_index_status).toBe("indexed");
    expect(deletedIds()).toEqual([]);
  });

  test("updates to entries that never had vectors delete nothing", async () => {
    const book = createWorldBook(OWNER_ID, { name: "Never vectorized" });
    const ops = entries(book.id, 64, false).map((e, i) => update(e.id, { comment: `c${i}`, constant: true, disabled: i % 2 === 0, content: `new ${i}` }));
    makeApi().api.handleSpindleBatch("plain", ops, undefined, OWNER_ID);
    await settle();
    expect(deletedIds()).toEqual([]);
  });

  test("a committed batch turning vectors off deletes every affected entry in one call", async () => {
    const book = createWorldBook(OWNER_ID, { name: "Vectors off" });
    const vectorized = entries(book.id, 64, true);
    makeApi().api.handleSpindleBatch("off", vectorized.map((e) => update(e.id, { vectorized: false })), undefined, OWNER_ID);
    await settle();
    expect(singleDeletes).toEqual([]);
    expect(groupedDeletes).toHaveLength(1);
    expect(groupedDeletes[0]!.sort()).toEqual(vectorized.map((e) => e.id).sort());
    for (const e of vectorized) expect(getEntry(OWNER_ID, e.id)?.vector_index_status).toBe("not_enabled");
  });

  test("a mixed batch deletes vectors only for entries that had them", async () => {
    const book = createWorldBook(OWNER_ID, { name: "Mixed" });
    const had = entries(book.id, 3, true);
    const never = entries(book.id, 3, false);
    makeApi().api.handleSpindleBatch("mixed", [...had, ...never].map((e) => update(e.id, { vectorized: false, comment: "x" })), undefined, OWNER_ID);
    await settle();
    expect(deletedIds()).toEqual(had.map((e) => e.id).sort());
  });

  test("a non-vectorized entry with a stale index status still gets its vectors deleted", async () => {
    const book = createWorldBook(OWNER_ID, { name: "Stale status" });
    const [entry] = entries(book.id, 1, false);
    getDb().query("UPDATE world_book_entries SET vector_index_status = 'indexed' WHERE id = ?").run(entry!.id);
    makeApi().api.handleSpindleBatch("stale", [update(entry!.id, { comment: "x" })], undefined, OWNER_ID);
    await settle();
    expect(deletedIds()).toEqual([entry!.id]);
  });
});

describe("direct entry updates", () => {
  test("editing an entry that never had vectors deletes nothing", () => {
    const book = createWorldBook(OWNER_ID, { name: "Direct never" });
    const [entry] = entries(book.id, 1, false);
    updateEntry(OWNER_ID, entry!.id, { comment: "x", content: "y", disabled: true });
    expect(deletedIds()).toEqual([]);
  });

  test("turning vectors off on a single entry still deletes immediately", () => {
    const book = createWorldBook(OWNER_ID, { name: "Direct off" });
    const [entry] = entries(book.id, 1, true);
    updateEntry(OWNER_ID, entry!.id, { vectorized: false });
    expect(singleDeletes).toEqual([entry!.id]);
  });

  test("bulk set_fields deletes vectors only for entries that had them, in one call", async () => {
    const book = createWorldBook(OWNER_ID, { name: "Bulk" });
    const had = entries(book.id, 60, true);
    const never = entries(book.id, 40, false);
    await bulkOperateEntries(OWNER_ID, book.id, { action: "set_fields", entry_ids: [...had, ...never].map((e) => e.id), fields: { vectorized: false } });
    await settle();
    expect(singleDeletes).toEqual([]);
    expect(groupedDeletes).toHaveLength(1);
    expect(groupedDeletes[0]!.sort()).toEqual(had.map((e) => e.id).sort());
  });
});
