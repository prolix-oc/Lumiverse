import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";

mock.module("../services/embeddings.service", () => ({
  deleteWorldBookEntryEmbeddings: async () => {},
  deleteWorldBookEntryEmbeddingsBeforeSourceDelete: async <T>(
    _userId: string,
    _entryIds: string[],
    deleteSource: () => T | Promise<T>,
  ): Promise<T> => await deleteSource(),
}));
mock.module("../services/vectorization-queue.service", () => ({
  queueWorldBookEntryVectorization: () => {},
}));

const svc = await import("../services/world-books.service");
const { worldBooksRoutes } = await import("./world-books.routes");

const USER_ID = "world-books-route-user";
const app = new Hono();
app.use("*", async (c, next) => {
  c.set("userId", c.req.header("x-test-user") ?? USER_ID);
  await next();
});
app.route("/world-books", worldBooksRoutes);

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
});
afterEach(() => closeDatabase());

describe("world-book P8 REST mutation contracts", () => {
  test("forwards reorder expected revisions", async () => {
    const book = svc.createWorldBook(USER_ID, { name: "Reorder fixture" });
    const first = svc.createEntry(USER_ID, book.id, { comment: "first", content: "lore" })!;
    const second = svc.createEntry(USER_ID, book.id, { comment: "second", content: "lore" })!;
    const url = `http://localhost/world-books/${book.id}/entries/reorder`;
    const headers = { "content-type": "application/json", "x-test-user": USER_ID };
    const expectedRevisions = { [first.id]: first.revision, [second.id]: second.revision };

    const winner = await app.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ordered_ids: [second.id, first.id], expected_revisions: expectedRevisions }),
    });
    expect(winner.status).toBe(200);

    const stale = await app.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ordered_ids: [first.id, second.id], expected_revisions: expectedRevisions }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: "world_book_entry_conflict",
      code: "WORLD_BOOK_ENTRY_CONFLICT",
      conflicts: [{ id: first.id }],
    });
  });

  test("maps malformed and stale entry revisions canonically", async () => {
    const book = svc.createWorldBook(USER_ID, { name: "Route fixture" });
    const entry = svc.createEntry(USER_ID, book.id, { comment: "first", content: "lore" })!;

    const malformed = await app.request(`http://localhost/world-books/${book.id}/entries/${entry.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-test-user": USER_ID },
      body: JSON.stringify({ comment: "bad", expected_revision: 0 }),
    });
    expect(malformed.status).toBe(428);
    expect(await malformed.json()).toMatchObject({
      error: "WORLD_BOOK_ENTRY_REVISION_INVALID",
      code: "WORLD_BOOK_ENTRY_REVISION_INVALID",
      field: "expected_revision",
    });

    const winner = await app.request(`http://localhost/world-books/${book.id}/entries/${entry.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-test-user": USER_ID },
      body: JSON.stringify({ comment: "winner", expected_revision: entry.revision }),
    });
    expect(winner.status).toBe(200);

    const stale = await app.request(`http://localhost/world-books/${book.id}/entries/${entry.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-test-user": USER_ID },
      body: JSON.stringify({ comment: "stale", expected_revision: entry.revision }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: "world_book_entry_conflict",
      code: "WORLD_BOOK_ENTRY_CONFLICT",
      conflicts: [{ id: entry.id, current: { comment: "winner" } }],
    });
  });
  test("duplicate enforces malformed and stale source revisions", async () => {
    const book = svc.createWorldBook(USER_ID, { name: "Duplicate fixture" });
    const entry = svc.createEntry(USER_ID, book.id, { comment: "first", content: "lore" })!;
    const duplicateUrl = `http://localhost/world-books/${book.id}/entries/${entry.id}/duplicate`;
    const headers = { "content-type": "application/json", "x-test-user": USER_ID };

    const malformed = await app.request(duplicateUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ expected_revision: 0 }),
    });
    expect(malformed.status).toBe(428);

    const winner = await app.request(`http://localhost/world-books/${book.id}/entries/${entry.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ comment: "winner", expected_revision: entry.revision }),
    });
    expect(winner.status).toBe(200);

    const stale = await app.request(duplicateUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ expected_revision: entry.revision }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: "world_book_entry_conflict",
      code: "WORLD_BOOK_ENTRY_CONFLICT",
      conflicts: [{ id: entry.id, current: { comment: "winner" } }],
    });
  });

  test("writes one H12 namespace without touching host-managed entry fields", async () => {
    const book = svc.createWorldBook(USER_ID, { name: "H12 fixture" });
    const entry = svc.createEntry(USER_ID, book.id, {
      comment: "entry",
      wi_marker: "scenario",
      wi_marker_side: "before",
      extensions: { sibling: true },
    })!;

    const response = await app.request(
      `http://localhost/world-books/${book.id}/entries/${entry.id}/extensions/example_ext`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-test-user": USER_ID },
        body: JSON.stringify({ value: { enabled: true } }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      entity: "world_book_entry",
      id: entry.id,
      namespace: "example_ext",
      value: { enabled: true },
      extensions: { sibling: true, example_ext: { enabled: true } },
    });

    const hostManaged = await app.request(
      `http://localhost/world-books/${book.id}/entries/${entry.id}/extensions/wi_marker`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-test-user": USER_ID },
        body: JSON.stringify({ value: "forged" }),
      },
    );
    expect(hostManaged.status).toBe(400);
    expect(await hostManaged.json()).toMatchObject({ error: "HOST_MANAGED_NAMESPACE" });
    expect(svc.getEntry(USER_ID, entry.id)).toMatchObject({
      wi_marker: "scenario",
      extensions: { sibling: true, example_ext: { enabled: true } },
    });
  });

  test("accepts the planned atomic bulk actions and trigger alias", async () => {
    const source = svc.createWorldBook(USER_ID, { name: "Action source" });
    const target = svc.createWorldBook(USER_ID, { name: "Action target" });
    const first = svc.createEntry(USER_ID, source.id, { comment: "first", content: "lore" })!;
    const second = svc.createEntry(USER_ID, source.id, { comment: "second", content: "lore" })!;
    const revisions = () => ({
      [first.id]: svc.getEntry(USER_ID, first.id)!.revision,
      [second.id]: svc.getEntry(USER_ID, second.id)!.revision,
    });

    for (const body of [
      { action: "set_priority", priority: 42 },
      { action: "set_depth", depth: 7 },
      { action: "set_enabled", enabled: false },
      { action: "set_fields", fields: { comment: "updated" } },
      { action: "set_trigger" },
    ]) {
      const response = await app.request(`http://localhost/world-books/${source.id}/entries/bulk`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": USER_ID },
        body: JSON.stringify({ ...body, entry_ids: [first.id, second.id], expected_revisions: revisions() }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).action).toBe(body.action);
    }

    const copied = await app.request(`http://localhost/world-books/${source.id}/entries/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": USER_ID },
      body: JSON.stringify({
        action: "copy",
        entry_ids: [first.id, second.id],
        target_book_id: target.id,
        expected_revisions: revisions(),
      }),
    });
    expect(copied.status).toBe(200);
    expect((await copied.json()).affected).toBe(2);
    expect(svc.listEntries(USER_ID, target.id)).toHaveLength(2);
  });

  test("maps malformed and stale bulk revisions canonically", async () => {
    const book = svc.createWorldBook(USER_ID, { name: "Bulk revision fixture" });
    const entry = svc.createEntry(USER_ID, book.id, { comment: "first", content: "lore" })!;
    const url = `http://localhost/world-books/${book.id}/entries/bulk`;
    const headers = { "content-type": "application/json", "x-test-user": USER_ID };

    const malformed = await app.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "set_enabled",
        enabled: false,
        entry_ids: [entry.id],
        expected_revisions: { [entry.id]: 0 },
      }),
    });
    expect(malformed.status).toBe(428);
    expect(await malformed.json()).toMatchObject({
      error: "WORLD_BOOK_ENTRY_REVISION_INVALID",
      code: "WORLD_BOOK_ENTRY_REVISION_INVALID",
      field: "expected_revisions",
    });

    const expectedRevisions = { [entry.id]: entry.revision };
    const winner = await app.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "set_enabled",
        enabled: false,
        entry_ids: [entry.id],
        expected_revisions: expectedRevisions,
      }),
    });
    expect(winner.status).toBe(200);

    const stale = await app.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "set_enabled",
        enabled: true,
        entry_ids: [entry.id],
        expected_revisions: expectedRevisions,
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: "world_book_entry_conflict",
      code: "WORLD_BOOK_ENTRY_CONFLICT",
      conflicts: [{ id: entry.id }],
    });
  });
});

describe("world-book entry parent containment", () => {
  test("PUT ignores client world_book_id and wrong-parent routes stay 404", async () => {
    const bookA = svc.createWorldBook(USER_ID, { name: "Parent A" });
    const bookB = svc.createWorldBook(USER_ID, { name: "Parent B" });
    const entry = svc.createEntry(USER_ID, bookA.id, { comment: "only-a", content: "original" })!;
    const headers = { "content-type": "application/json", "x-test-user": USER_ID };

    const moved = await app.request(`http://localhost/world-books/${bookA.id}/entries/${entry.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        content: "edited",
        world_book_id: bookB.id,
        id: "forged-id",
        expected_revision: entry.revision,
      }),
    });
    expect(moved.status).toBe(200);
    const saved = await moved.json() as { world_book_id: string; content: string; id: string };
    expect(saved.world_book_id).toBe(bookA.id);
    expect(saved.id).toBe(entry.id);
    expect(saved.content).toBe("edited");
    expect(svc.getEntry(USER_ID, entry.id)?.world_book_id).toBe(bookA.id);

    const listB = await app.request(`http://localhost/world-books/${bookB.id}/entries?limit=50`, {
      headers: { "x-test-user": USER_ID },
    });
    expect(listB.status).toBe(200);
    const pageB = await listB.json() as { data: Array<{ id: string }> };
    expect(pageB.data.map((row) => row.id)).not.toContain(entry.id);

    const wrongPut = await app.request(`http://localhost/world-books/${bookB.id}/entries/${entry.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ content: "from-b", expected_revision: entry.revision + 1 }),
    });
    expect(wrongPut.status).toBe(404);
    expect(await wrongPut.json()).toEqual({ error: "Not found" });

    const wrongDelete = await app.request(`http://localhost/world-books/${bookB.id}/entries/${entry.id}`, {
      method: "DELETE",
      headers: { "x-test-user": USER_ID },
    });
    expect(wrongDelete.status).toBe(404);
    expect(await wrongDelete.json()).toEqual({ error: "Not found" });

    const rightDelete = await app.request(`http://localhost/world-books/${bookA.id}/entries/${entry.id}`, {
      method: "DELETE",
      headers: { "x-test-user": USER_ID },
    });
    expect(rightDelete.status).toBe(200);
    expect(svc.getEntry(USER_ID, entry.id)).toBeNull();
  });

  test("stale expected parent after bulk move stays 404 without mutating B", async () => {
    const bookA = svc.createWorldBook(USER_ID, { name: "Parent A" });
    const bookB = svc.createWorldBook(USER_ID, { name: "Parent B" });
    const entry = svc.createEntry(USER_ID, bookA.id, { comment: "move-me", content: "original" })!;
    const headers = { "content-type": "application/json", "x-test-user": USER_ID };

    const moved = await app.request(`http://localhost/world-books/${bookA.id}/entries/bulk`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "move",
        entry_ids: [entry.id],
        target_book_id: bookB.id,
      }),
    });
    expect(moved.status).toBe(200);
    expect(svc.getEntry(USER_ID, entry.id)?.world_book_id).toBe(bookB.id);

    const stalePut = await app.request(`http://localhost/world-books/${bookA.id}/entries/${entry.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ content: "from-stale-a", expected_revision: entry.revision + 1 }),
    });
    expect(stalePut.status).toBe(404);
    expect(await stalePut.json()).toEqual({ error: "Not found" });

    const staleDelete = await app.request(`http://localhost/world-books/${bookA.id}/entries/${entry.id}`, {
      method: "DELETE",
      headers: { "x-test-user": USER_ID },
    });
    expect(staleDelete.status).toBe(404);
    expect(await staleDelete.json()).toEqual({ error: "Not found" });

    const live = svc.getEntry(USER_ID, entry.id);
    expect(live?.world_book_id).toBe(bookB.id);
    expect(live?.content).toBe("original");
  });

});

