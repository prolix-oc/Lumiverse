import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

import { closeDatabase, getDb, initDatabase } from "../db/connection";
import type {
  UpdateWorldBookEntryInput,
  WorldBookEntry,
  WorldBookEntryBulkActionInput,
} from "../types/world-book";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { WorkerHostContentApi } from "../spindle/worker-host-content-api";

// The world-books service imports the optional vector-store provider at module
// load time. These no-op adapters keep this focused DB contract test independent
// of an installed LanceDB runtime and prevent background vector work from
// escaping the fixture.
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

const worldBooks = await import("./world-books.service");
const { createCharacter } = await import("./characters.service");
const { createPreset } = await import("./presets.service");
const {
  bulkOperateEntries,
  convertToVectorized,
  createEntry,
  createWorldBook,
  duplicateEntry,
  getEntry,
  reorderEntries,
  setWorldBookSemanticActivation,
  updateEntry,
} = worldBooks;

const OWNER_ID = "world-books-concurrency-owner";
const OTHER_USER_ID = "world-books-concurrency-other";
const MAX_NAMESPACE_VALUE_BYTES = 2 * 1024 * 1024;

type NamespaceWriter = (
  userId: string,
  entity: "world_book_entry" | "character" | "preset",
  entityId: string,
  namespace: string,
  value: unknown,
) => unknown;

type ServiceContracts = {
  setEntityExtensionNamespace?: NamespaceWriter;
  WorldBookEntryConflictError?: new (...args: unknown[]) => Error;
};

const serviceContracts = worldBooks as unknown as ServiceContracts;

interface FixtureEntries {
  book: ReturnType<typeof createWorldBook>;
  first: WorldBookEntry;
  second: WorldBookEntry;
}

interface EntrySideEffectState {
  updated_at: number;
  revision: number;
  vectorized: number;
  vector_index_status: string;
  vector_indexed_at: number | null;
  vector_index_error: string | null;
}

interface BookSideEffectState {
  updated_at: number;
}

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
}

function createFixtureEntries(): FixtureEntries {
  const book = createWorldBook(OWNER_ID, { name: "Concurrency fixture" });
  const first = createEntry(OWNER_ID, book.id, {
    comment: "first",
    content: "first lore",
    extensions: {
      alpha: { version: 1 },
      beta: "sibling",
    },
    wi_marker: "scenario",
    wi_marker_side: "before",
  });
  const second = createEntry(OWNER_ID, book.id, {
    comment: "second",
    content: "second lore",
    extensions: {
      alpha: { version: 1 },
      beta: "sibling",
    },
  });

  if (!first || !second) throw new Error("failed to create world-book concurrency fixture");
  return { book, first, second };
}

function entrySideEffectState(id: string): EntrySideEffectState {
  return getDb().query(
    `SELECT updated_at, revision, vectorized, vector_index_status,
            vector_indexed_at, vector_index_error
       FROM world_book_entries
      WHERE id = ?`,
  ).get(id) as EntrySideEffectState;
}

function bookSideEffectState(id: string): BookSideEffectState {
  return getDb().query(
    "SELECT updated_at FROM world_books WHERE id = ?",
  ).get(id) as BookSideEffectState;
}

function captureSyncError(operation: () => unknown): unknown {
  let caught: unknown;
  expect(() => {
    try {
      operation();
    } catch (error) {
      caught = error;
      throw error;
    }
  }).toThrow();
  return caught;
}

async function expectAsyncConflict(
  operation: () => Promise<unknown>,
  entryId: string,
): Promise<void> {
  const promise = operation();
  await expect(promise).rejects.toThrow();
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assertCanonicalConflict(error, entryId);
}

function assertCanonicalConflict(error: unknown, entryId: string): void {
  expect(error).toBeDefined();
  const conflictError = serviceContracts.WorldBookEntryConflictError;
  expect(typeof conflictError).toBe("function");
  if (typeof conflictError === "function") {
    expect(error).toBeInstanceOf(conflictError);
  }

  const payload = (error as { payload?: {
    error?: unknown;
    code?: unknown;
    conflicts?: Array<{ id?: unknown; current?: unknown }>;
  } }).payload;
  expect(payload).toMatchObject({
    error: "world_book_entry_conflict",
    code: "WORLD_BOOK_ENTRY_CONFLICT",
  });
  expect(payload?.conflicts).toHaveLength(1);
  expect(payload?.conflicts?.[0]).toMatchObject({ id: entryId });
  expect(payload?.conflicts?.[0]).toHaveProperty("current");
}

function assertInvalidRevision(error: unknown): void {
  expect(error).toBeDefined();
  expect((error as { code?: unknown }).code).toBe("WORLD_BOOK_ENTRY_REVISION_INVALID");
}

async function expectAsyncInvalidRevision(operation: () => Promise<unknown>): Promise<void> {
  const promise = operation();
  await expect(promise).rejects.toThrow();
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assertInvalidRevision(error);
}

async function flushEventQueue(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function writeNamespace(
  userId: string,
  entryId: string,
  namespace: string,
  value: unknown,
): Promise<unknown> {
  const writer = serviceContracts.setEntityExtensionNamespace;
  if (typeof writer !== "function") {
    throw new Error("P5 contract missing: setEntityExtensionNamespace");
  }
  return await writer(userId, "world_book_entry", entryId, namespace, value);
}

async function expectNamespaceRejection(operation: () => Promise<unknown>): Promise<unknown> {
  const promise = operation();
  await expect(promise).rejects.toThrow();
  return await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

describe.serial("world-book concurrency contract matrix", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });

  afterEach(() => closeDatabase());

  describe.serial("world-book H11 optimistic concurrency", () => {
  test("single update without expected_revision remains backward-compatible and increments once", () => {
    const { first } = createFixtureEntries();

    const updated = updateEntry(OWNER_ID, first.id, { comment: "unconditional" });

    expect(updated).toMatchObject({
      id: first.id,
      comment: "unconditional",
      revision: first.revision + 1,
    });
  });

  test("duplicate validates the source revision before creating a new entry", () => {
    const { first } = createFixtureEntries();
    const copied = duplicateEntry(OWNER_ID, first.id, { expected_revision: first.revision });
    expect(copied?.id).toBeDefined();

    const winner = updateEntry(OWNER_ID, first.id, {
      comment: "source changed",
      expected_revision: first.revision,
    });
    expect(winner?.revision).toBe(first.revision + 1);

    const stale = captureSyncError(() => duplicateEntry(OWNER_ID, first.id, {
      expected_revision: first.revision,
    }));
    assertCanonicalConflict(stale, first.id);
  });

  test("bulk mutations without expected_revisions and with an empty map are both unchecked", async () => {
    const { book, first, second } = createFixtureEntries();

    const absent = await bulkOperateEntries(OWNER_ID, book.id, {
      action: "add_keyword",
      entry_ids: [first.id, second.id],
      keyword: "absent-map",
    });
    expect(absent).toMatchObject({ action: "add_keyword", affected: 2 });
    expect(getEntry(OWNER_ID, first.id)?.revision).toBe(first.revision + 1);
    expect(getEntry(OWNER_ID, second.id)?.revision).toBe(second.revision + 1);

    const empty = await bulkOperateEntries(OWNER_ID, book.id, {
      action: "set_position",
      entry_ids: [first.id, second.id],
      position: 4,
      depth: 8,
      expected_revisions: {},
    });
    expect(empty).toMatchObject({ action: "set_position", affected: 2 });
    expect(getEntry(OWNER_ID, first.id)?.revision).toBe(first.revision + 2);
    expect(getEntry(OWNER_ID, second.id)?.revision).toBe(second.revision + 2);
  });

  test("a partial expected_revisions map checks only the ids it contains", () => {
    const { book, first, second } = createFixtureEntries();

    expect(reorderEntries(OWNER_ID, book.id, [second.id, first.id], {
      [first.id]: first.revision,
    })).toBe(true);

    expect(getEntry(OWNER_ID, first.id)?.revision).toBe(first.revision + 1);
    expect(getEntry(OWNER_ID, second.id)?.revision).toBe(second.revision + 1);
  });

  test("matching expected_revision succeeds once and stale single writes expose the canonical conflict", () => {
    const { first } = createFixtureEntries();

    const winner = updateEntry(OWNER_ID, first.id, {
      comment: "winner",
      expected_revision: first.revision,
    });
    expect(winner?.revision).toBe(first.revision + 1);

    const staleError = captureSyncError(() => updateEntry(OWNER_ID, first.id, {
      comment: "stale loser",
      expected_revision: first.revision,
    }));
    assertCanonicalConflict(staleError, first.id);
    expect(getEntry(OWNER_ID, first.id)).toMatchObject({
      comment: "winner",
      revision: first.revision + 1,
    });
  });

  test("malformed-present single expectations fail and never become unconditional writes", () => {
    const malformed: unknown[] = [undefined, null, "1", 1.5, -1, {}, []];

    for (const expected_revision of malformed) {
      const { first } = createFixtureEntries();
      const before = getEntry(OWNER_ID, first.id)!;
      const error = captureSyncError(() => updateEntry(OWNER_ID, first.id, {
        comment: "must not land",
        expected_revision,
      } as unknown as UpdateWorldBookEntryInput));

      assertInvalidRevision(error);
      expect(getEntry(OWNER_ID, first.id)).toMatchObject({
        comment: before.comment,
        revision: before.revision,
      });
    }
  });

  test("malformed-present expected_revisions maps fail before any bulk write", async () => {
    const malformedMaps: unknown[] = [
      null,
      [],
      "not-a-map",
      { malformed: "revision" },
    ];

    for (const expected_revisions of malformedMaps) {
      const { book, first, second } = createFixtureEntries();
      const beforeFirst = getEntry(OWNER_ID, first.id)!;
      const beforeSecond = getEntry(OWNER_ID, second.id)!;

      await expectAsyncInvalidRevision(() => bulkOperateEntries(OWNER_ID, book.id, {
        action: "add_keyword",
        entry_ids: [first.id, second.id],
        keyword: "must-not-land",
        expected_revisions,
      } as unknown as WorldBookEntryBulkActionInput));

      expect(getEntry(OWNER_ID, first.id)).toMatchObject({
        key: beforeFirst.key,
        revision: beforeFirst.revision,
      });
      expect(getEntry(OWNER_ID, second.id)).toMatchObject({
        key: beforeSecond.key,
        revision: beforeSecond.revision,
      });
    }
  });

  test("malformed-present reorder maps fail before changing order or revisions", () => {
    const malformedMaps: unknown[] = [
      null,
      [],
      { malformed: "revision" },
    ];

    for (const expectedRevisions of malformedMaps) {
      const { book, first, second } = createFixtureEntries();
      const before = [
        getEntry(OWNER_ID, first.id)!,
        getEntry(OWNER_ID, second.id)!,
      ];
      const error = captureSyncError(() => reorderEntries(
        OWNER_ID,
        book.id,
        [second.id, first.id],
        expectedRevisions as Record<string, number>,
      ));

      assertInvalidRevision(error);
      expect(getEntry(OWNER_ID, first.id)).toMatchObject({
        order_value: before[0].order_value,
        revision: before[0].revision,
      });
      expect(getEntry(OWNER_ID, second.id)).toMatchObject({
        order_value: before[1].order_value,
        revision: before[1].revision,
      });
    }
  });

  test("mixed fresh and stale bulk writes are rejected atomically", async () => {
    const { book, first, second } = createFixtureEntries();
    const beforeFirst = getEntry(OWNER_ID, first.id)!;

    const winner = updateEntry(OWNER_ID, second.id, {
      comment: "winner",
      expected_revision: second.revision,
    })!;

    await expectAsyncConflict(
      () => bulkOperateEntries(OWNER_ID, book.id, {
        action: "add_keyword",
        entry_ids: [first.id, second.id],
        keyword: "atomicity",
        expected_revisions: {
          [first.id]: first.revision,
          [second.id]: second.revision,
        },
      }),
      second.id,
    );

    expect(getEntry(OWNER_ID, first.id)).toMatchObject({
      key: beforeFirst.key,
      revision: beforeFirst.revision,
    });
    expect(getEntry(OWNER_ID, second.id)).toMatchObject({
      comment: winner.comment,
      revision: winner.revision,
    });
  });

  test("stale reorder changes no entry order values or revisions", () => {
    const { book, first, second } = createFixtureEntries();
    updateEntry(OWNER_ID, first.id, {
      comment: "changed first",
      expected_revision: first.revision,
    });

    const before = [
      getEntry(OWNER_ID, first.id)!,
      getEntry(OWNER_ID, second.id)!,
    ];
    const error = captureSyncError(() => reorderEntries(
      OWNER_ID,
      book.id,
      [second.id, first.id],
      {
        [first.id]: first.revision,
        [second.id]: second.revision,
      },
    ));

    assertCanonicalConflict(error, first.id);
    expect(getEntry(OWNER_ID, first.id)).toMatchObject({
      order_value: before[0].order_value,
      revision: before[0].revision,
    });
    expect(getEntry(OWNER_ID, second.id)).toMatchObject({
      order_value: before[1].order_value,
      revision: before[1].revision,
    });
  });

  test("stale async bulk delete removes no entries", async () => {
    const { book, first, second } = createFixtureEntries();
    const winner = updateEntry(OWNER_ID, second.id, {
      comment: "winner",
      expected_revision: second.revision,
    })!;

    await expectAsyncConflict(
      () => bulkOperateEntries(OWNER_ID, book.id, {
        action: "delete",
        entry_ids: [first.id, second.id],
        expected_revisions: {
          [first.id]: first.revision,
          [second.id]: second.revision,
        },
      }),
      second.id,
    );

    expect(getEntry(OWNER_ID, first.id)).not.toBeNull();
    expect(getEntry(OWNER_ID, second.id)).toMatchObject({
      comment: winner.comment,
      revision: winner.revision,
    });
  });

  test("each current user-intent update path increments every affected revision exactly once", async () => {
    const { book, first, second } = createFixtureEntries();
    const initialRevisions = {
      first: first.revision,
      second: second.revision,
    };

    await bulkOperateEntries(OWNER_ID, book.id, {
      action: "set_activation",
      entry_ids: [first.id, second.id],
      activation: "constant",
      expected_revisions: {
        [first.id]: initialRevisions.first,
        [second.id]: initialRevisions.second,
      },
    });
    expect(getEntry(OWNER_ID, first.id)?.revision).toBe(initialRevisions.first + 1);
    expect(getEntry(OWNER_ID, second.id)?.revision).toBe(initialRevisions.second + 1);

    await bulkOperateEntries(OWNER_ID, book.id, {
      action: "add_keyword",
      entry_ids: [first.id, second.id],
      keyword: "one-revision",
      expected_revisions: {
        [first.id]: initialRevisions.first + 1,
        [second.id]: initialRevisions.second + 1,
      },
    });
    expect(getEntry(OWNER_ID, first.id)?.revision).toBe(initialRevisions.first + 2);
    expect(getEntry(OWNER_ID, second.id)?.revision).toBe(initialRevisions.second + 2);

    await bulkOperateEntries(OWNER_ID, book.id, {
      action: "set_position",
      entry_ids: [first.id, second.id],
      position: 4,
      depth: 8,
      expected_revisions: {
        [first.id]: initialRevisions.first + 2,
        [second.id]: initialRevisions.second + 2,
      },
    });
    expect(getEntry(OWNER_ID, first.id)?.revision).toBe(initialRevisions.first + 3);
    expect(getEntry(OWNER_ID, second.id)?.revision).toBe(initialRevisions.second + 3);

    expect(reorderEntries(OWNER_ID, book.id, [second.id, first.id], {
      [first.id]: initialRevisions.first + 3,
      [second.id]: initialRevisions.second + 3,
    })).toBe(true);
    expect(getEntry(OWNER_ID, first.id)?.revision).toBe(initialRevisions.first + 4);
    expect(getEntry(OWNER_ID, second.id)?.revision).toBe(initialRevisions.second + 4);

    const marker = getEntry(OWNER_ID, first.id)!;
    expect(marker.wi_marker).toBe("scenario");
    expect(marker.wi_marker_side).toBe("before");
  });

  test("bulk move and renumber each increment every affected revision exactly once", async () => {
    const moveFixture = createFixtureEntries();
    const targetBook = createWorldBook(OWNER_ID, { name: "Move target" });

    await bulkOperateEntries(OWNER_ID, moveFixture.book.id, {
      action: "move",
      entry_ids: [moveFixture.first.id, moveFixture.second.id],
      target_book_id: targetBook.id,
      expected_revisions: {
        [moveFixture.first.id]: moveFixture.first.revision,
        [moveFixture.second.id]: moveFixture.second.revision,
      },
    });

    expect(getEntry(OWNER_ID, moveFixture.first.id)).toMatchObject({
      world_book_id: targetBook.id,
      revision: moveFixture.first.revision + 1,
    });
    expect(getEntry(OWNER_ID, moveFixture.second.id)).toMatchObject({
      world_book_id: targetBook.id,
      revision: moveFixture.second.revision + 1,
    });

    const renumberFixture = createFixtureEntries();
    await bulkOperateEntries(OWNER_ID, renumberFixture.book.id, {
      action: "renumber",
      entry_ids: [renumberFixture.first.id, renumberFixture.second.id],
      start: 10,
      step: 2,
      expected_revisions: {
        [renumberFixture.first.id]: renumberFixture.first.revision,
        [renumberFixture.second.id]: renumberFixture.second.revision,
      },
    });

    expect(getEntry(OWNER_ID, renumberFixture.first.id)).toMatchObject({
      order_value: 10,
      revision: renumberFixture.first.revision + 1,
    });
    expect(getEntry(OWNER_ID, renumberFixture.second.id)).toMatchObject({
      order_value: 12,
      revision: renumberFixture.second.revision + 1,
    });
  });

  test("semantic activation and vector conversion increment revisions exactly once", () => {
    const { book, first, second } = createFixtureEntries();

    const disabled = setWorldBookSemanticActivation(OWNER_ID, book.id, false);
    expect(disabled?.summary.total).toBe(2);
    expect(disabled?.updated_entries).toBeGreaterThanOrEqual(2);
    expect(getEntry(OWNER_ID, first.id)?.revision).toBe(first.revision + 1);
    expect(getEntry(OWNER_ID, second.id)?.revision).toBe(second.revision + 1);

    const beforeConversion = {
      first: getEntry(OWNER_ID, first.id)!,
      second: getEntry(OWNER_ID, second.id)!,
    };
    const converted = convertToVectorized(OWNER_ID, book.id);
    expect(converted?.summary.total).toBe(2);
    expect(converted?.converted).toBeGreaterThanOrEqual(2);
    expect(getEntry(OWNER_ID, first.id)?.revision).toBe(beforeConversion.first.revision + 1);
    expect(getEntry(OWNER_ID, second.id)?.revision).toBe(beforeConversion.second.revision + 1);
  });

  test("handleSpindleBatch suppresses rollback events and coalesces committed events", async () => {
    const { first } = createFixtureEntries();
    let entryEvents = 0;
    let batchEvents = 0;
    const removeEntryListener = eventBus.on(EventType.WORLD_BOOK_ENTRY_CHANGED, () => { entryEvents++; });
    const removeBatchListener = eventBus.on(EventType.SPINDLE_BATCH_CHANGED, () => { batchEvents++; });
    const responses: Array<{ type: "response"; requestId: string; result?: unknown; error?: string }> = [];
    const api = new WorkerHostContentApi({
      manifest: { identifier: "batch-event-test" },
      hasPermission: (permission) => permission === "world_books",
      resolveEffectiveUserId: () => OWNER_ID,
      enforceScopedUser: (userId) => expect(userId).toBe(OWNER_ID),
      postResponse: (message) => responses.push(message),
    });
    const update = (id: string, comment: string) => ({
      domain: "world_books",
      op: "entries.update",
      args: { id, input: { comment } },
    });

    try {
      api.handleSpindleBatch("rollback", [update(first.id, "leaked"), update("missing-entry", "never")], undefined, OWNER_ID);
      await flushEventQueue();
      expect(getEntry(OWNER_ID, first.id)?.comment).toBe(first.comment);
      expect(entryEvents).toBe(0);
      expect(batchEvents).toBe(0);
      expect(responses[0]?.result).toEqual([
        { ok: false, error: expect.stringContaining("BATCH_ROLLED_BACK") },
        { ok: false, error: expect.stringContaining("BATCH_ROLLED_BACK") },
      ]);

      responses.length = 0;
      api.handleSpindleBatch("commit", [update(first.id, "committed-a"), update(first.id, "committed-b")], undefined, OWNER_ID);
      await flushEventQueue();
      expect(getEntry(OWNER_ID, first.id)?.comment).toBe("committed-b");
      expect(entryEvents).toBe(0);
      expect(batchEvents).toBe(1);
      expect(responses[0]?.result).toEqual([
        { ok: true, result: expect.anything() },
        { ok: true, result: expect.anything() },
      ]);
    } finally {
      removeEntryListener();
      removeBatchListener();
    }
  });
  });

  describe.serial("world-book H12 namespaced metadata writes", () => {
    beforeEach(() => {
      // Keep the missing primitive visible as a contract failure rather than
      // allowing rejection-only tests to pass because the function is absent.
      expect(typeof serviceContracts.setEntityExtensionNamespace).toBe("function");
    });

  test("owner writes preserve sibling namespaces and replace only the target", async () => {
    const { first } = createFixtureEntries();

    await writeNamespace(OWNER_ID, first.id, "gamma", { count: 3 });
    expect(getEntry(OWNER_ID, first.id)?.extensions).toEqual({
      alpha: { version: 1 },
      beta: "sibling",
      gamma: { count: 3 },
    });

    await writeNamespace(OWNER_ID, first.id, "alpha", { version: 2 });
    expect(getEntry(OWNER_ID, first.id)?.extensions).toEqual({
      alpha: { version: 2 },
      beta: "sibling",
      gamma: { count: 3 },
    });
  });

  test("null deletes only one namespace and preserves siblings", async () => {
    const { first } = createFixtureEntries();

    await writeNamespace(OWNER_ID, first.id, "alpha", null);

    expect(getEntry(OWNER_ID, first.id)?.extensions).toEqual({
      beta: "sibling",
    });
  });

  test("missing and cross-user entries are owner-scoped no-ops", async () => {
    const { first } = createFixtureEntries();
    const before = getEntry(OWNER_ID, first.id)!;

    await expect(writeNamespace(OWNER_ID, "missing-entry", "gamma", { value: 1 })).resolves.toBeNull();
    await expect(writeNamespace(OTHER_USER_ID, first.id, "gamma", { value: 1 })).resolves.toBeNull();

    expect(getEntry(OWNER_ID, first.id)).toMatchObject({
      extensions: before.extensions,
      revision: before.revision,
    });
  });

  test("accepts the exact namespace grammar and rejects malformed names", async () => {
    const { first } = createFixtureEntries();
    const valid = ["a", "_a", "foo1", "foo_bar", "_foo_bar2"];
    const invalid = ["", "_", "__foo", "1foo", "Upper", "foo-bar", "foo.bar", "foo bar"];

    for (const namespace of valid) {
      await writeNamespace(OWNER_ID, first.id, namespace, { valid: true });
    }
    for (const namespace of invalid) {
      await expectNamespaceRejection(() => writeNamespace(OWNER_ID, first.id, namespace, { invalid: true }));
    }

    const extensions = getEntry(OWNER_ID, first.id)!.extensions;
    for (const namespace of valid) {
      expect(extensions[namespace]).toEqual({ valid: true });
    }
    for (const namespace of invalid) {
      expect(extensions[namespace]).toBeUndefined();
    }
  });

  test("rejects every host-managed name and alias without changing the bag", async () => {
    const { first } = createFixtureEntries();
    const before = getEntry(OWNER_ID, first.id)!.extensions;
    const hostManaged = [
      "outlet_name",
      "outletName",
      "wi_marker",
      "wiMarker",
      "wi_marker_side",
      "wiMarkerSide",
    ];

    for (const namespace of hostManaged) {
      await expectNamespaceRejection(() => writeNamespace(OWNER_ID, first.id, namespace, { forged: true }));
    }

    expect(getEntry(OWNER_ID, first.id)!.extensions).toEqual(before);
    expect(getEntry(OWNER_ID, first.id)!.wi_marker).toBe("scenario");
    expect(getEntry(OWNER_ID, first.id)!.wi_marker_side).toBe("before");
  });

  test("enforces the serialized UTF-8 2 MiB boundary without a partial write", async () => {
    const { first } = createFixtureEntries();
    const exactValue = "x".repeat(MAX_NAMESPACE_VALUE_BYTES - 2);
    const oversizedValue = "x".repeat(MAX_NAMESPACE_VALUE_BYTES - 1);

    expect(Buffer.byteLength(JSON.stringify(exactValue), "utf8")).toBe(MAX_NAMESPACE_VALUE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(oversizedValue), "utf8")).toBe(MAX_NAMESPACE_VALUE_BYTES + 1);

    await writeNamespace(OWNER_ID, first.id, "boundary", exactValue);
    const afterExact = getEntry(OWNER_ID, first.id)!;
    expect(afterExact.extensions.boundary).toBe(exactValue);
    expect(afterExact.extensions.alpha).toEqual({ version: 1 });

    const beforeOversized = afterExact.extensions;
    const error = await expectNamespaceRejection(
      () => writeNamespace(OWNER_ID, first.id, "oversized", oversizedValue),
    );
    expect((error as { code?: unknown }).code).toBe("NAMESPACE_TOO_LARGE");
    expect(getEntry(OWNER_ID, first.id)!.extensions).toEqual(beforeOversized);
  });

  test("set and delete do not touch entry/parent timestamps, revision, vector state, or events", async () => {
    const { book, first } = createFixtureEntries();
    const db = getDb();
    db.run(
      `UPDATE world_books SET updated_at = ? WHERE id = ?`,
      [4000, book.id],
    );
    db.run(
      `UPDATE world_book_entries
          SET updated_at = ?, revision = ?, vectorized = ?,
              vector_index_status = ?, vector_indexed_at = ?, vector_index_error = ?
        WHERE id = ?`,
      [3000, 9, 1, "indexed", 2000, "must-survive", first.id],
    );

    const beforeEntry = entrySideEffectState(first.id);
    const beforeBook = bookSideEffectState(book.id);
    const beforeMarker = getEntry(OWNER_ID, first.id)!;
    let changedEvents = 0;
    const unsubscribe = eventBus.on(EventType.WORLD_BOOK_ENTRY_CHANGED, () => {
      changedEvents++;
    });

    try {
      await writeNamespace(OWNER_ID, first.id, "derived", { count: 1 });
      await flushEventQueue();
      expect(entrySideEffectState(first.id)).toEqual(beforeEntry);
      expect(bookSideEffectState(book.id)).toEqual(beforeBook);
      expect(getEntry(OWNER_ID, first.id)).toMatchObject({
        wi_marker: beforeMarker.wi_marker,
        wi_marker_side: beforeMarker.wi_marker_side,
      });

      await writeNamespace(OWNER_ID, first.id, "derived", null);
      await flushEventQueue();
      expect(entrySideEffectState(first.id)).toEqual(beforeEntry);
      expect(bookSideEffectState(book.id)).toEqual(beforeBook);
      expect(changedEvents).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  test("H12 namespace writes cover entries, characters, and presets with owner scoping", () => {
    const { first } = createFixtureEntries();
    const character = createCharacter(OWNER_ID, { name: "H12 character" });
    const preset = createPreset(OWNER_ID, { name: "H12 preset", provider: "h12" });
    const writer = serviceContracts.setEntityExtensionNamespace;
    if (typeof writer !== "function") throw new Error("P5 contract missing: setEntityExtensionNamespace");

    for (const [entity, id] of [
      ["world_book_entry", first.id],
      ["character", character.id],
      ["preset", preset.id],
    ] as const) {
      expect(writer(OWNER_ID, entity, id, "h12_namespace", { entity })).toMatchObject({ entity, id });
      expect(writer(OTHER_USER_ID, entity, id, "h12_other", true)).toBeNull();
    }
  });
  });
});
