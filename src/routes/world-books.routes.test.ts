import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";

mock.module("../services/embeddings.service", () => ({
  getChatMemoryDistanceThreshold: async () => 0,
  isChatMemoryVectorizationEnabled: () => false,
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


describe("entry organization read routes", () => {
  test("forwards Unfiled, repeated tags, type and pagination and scopes facets to ownership", async () => {
    const book = svc.createWorldBook(USER_ID, { name: "Organization" });
    const matching = svc.createEntry(USER_ID, book.id, { tags: ["villain", "faction,a"], content: "alpha" })!;
    svc.createEntry(USER_ID, book.id, { tags: ["villain"], folder: "Characters", content: "alpha" });
    svc.createEntry(USER_ID, book.id, { tags: ["villain", "faction,a"], constant: true, content: "alpha" });
    const response = await app.request(`http://localhost/world-books/${book.id}/entries?folder=&tag=villain&tag=faction%2Ca&type=trigger&search=alpha&limit=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1, data: [{ id: matching.id }] });
    const summary = await app.request(`http://localhost/world-books/${book.id}/entry-organization`);
    expect(await summary.json()).toMatchObject({ total: 3, unfiled: 2, folders: [{ name: "Characters", count: 1 }] });
    const denied = await app.request(`http://localhost/world-books/${book.id}/entry-organization`, { headers: { "x-test-user": "other" } });
    expect(denied.status).toBe(404);
  });
});

describe("entry organization mutation routes", () => {
  for (const operation of ["rename", "remove", "move"] as const) {
    test(`folder ${operation} validates ownership and returns entry counts unaffected by FTS triggers`, async () => {
      const source = svc.createWorldBook(USER_ID, { name: "Source" });
      const target = svc.createWorldBook(USER_ID, { name: "Target" });
      const entry = svc.createEntry(USER_ID, source.id, { folder: "Characters" })!;
      const input = { action: operation, folder: "Characters", target_folder: "Locations", target_book_id: target.id };
      const response = await app.request(`http://localhost/world-books/${source.id}/entry-folders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ affected: 1 });
      expect(svc.getEntry(USER_ID, entry.id)).toMatchObject({ folder: operation === "remove" ? "" : "Locations", world_book_id: operation === "move" ? target.id : source.id });
      const denied = await app.request(`http://localhost/world-books/${source.id}/entry-folders`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "foreign" }, body: JSON.stringify(input) });
      expect(denied.status).toBe(404);
    });
  }

  for (const path of ["entries", "entries/bulk", "entry-folders", "entries/ENTRY_ID"]) {
    for (const body of ["null", "[]", "false", "{invalid"]) {
      test(`invalid JSON object ${body} at ${path} returns 400 without writes`, async () => {
        const book = svc.createWorldBook(USER_ID, { name: "Source" });
        const entry = svc.createEntry(USER_ID, book.id, { folder: "Characters", tags: ["history"] })!;
        const before = svc.getEntry(USER_ID, entry.id);
        const response = await app.request(`http://localhost/world-books/${book.id}/${path.replace("ENTRY_ID", entry.id)}`, { method: path.endsWith("ENTRY_ID") ? "PUT" : "POST", headers: { "content-type": "application/json" }, body });
        expect(response.status).toBe(400);
        expect(svc.getEntry(USER_ID, entry.id)).toEqual(before);
        expect(svc.listEntries(USER_ID, book.id).length).toBe(1);
      });
    }
  }

  test("malformed folder/tag mutations return 400, target ownership returns 404 and stale selection returns 409", async () => {
    const book = svc.createWorldBook(USER_ID, { name: "Source" });
    const foreign = svc.createWorldBook("foreign", { name: "Foreign" });
    const entry = svc.createEntry(USER_ID, book.id, { folder: "Characters" })!;
    const before = svc.getEntry(USER_ID, entry.id);
    const post = (path: string, input: unknown) => app.request(`http://localhost/world-books/${book.id}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    for (const input of [{ folder: 1 }, { tags: "wrong" }, { tags: [1] }]) expect((await post("entries", input)).status).toBe(400);
    expect((await post("entries/bulk", { action: "add_tags", tags: [], entry_ids: [entry.id] })).status).toBe(400);
    expect((await post("entry-folders", { action: "rename", folder: "Characters", target_folder: "" })).status).toBe(400);
    expect((await post("entry-folders", { action: "move", folder: "Characters", target_book_id: foreign.id })).status).toBe(404);
    expect((await post("entries/bulk", { action: "move", entry_ids: [entry.id], target_book_id: foreign.id })).status).toBe(404);
    expect(svc.getEntry(USER_ID, entry.id)).toEqual(before);
    svc.updateEntry(USER_ID, entry.id, { tags: ["winner"] });
    expect((await post("entries/bulk", { action: "add_tags", entry_ids: [entry.id], tags: ["stale"], expected_revisions: { [entry.id]: 1 } })).status).toBe(409);
  });

  test("organization edits reject mismatched book URLs even when both books are owned", async () => {
    const book = svc.createWorldBook(USER_ID, { name: "Source" });
    const other = svc.createWorldBook(USER_ID, { name: "Other" });
    const entry = svc.createEntry(USER_ID, book.id, { folder: "Characters" })!;
    const response = await app.request(`http://localhost/world-books/${other.id}/entries/${entry.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder: "Wrong" }) });
    expect(response.status).toBe(404);
    expect(svc.getEntry(USER_ID, entry.id)?.folder).toBe("Characters");
  });
});

for (const path of ["", "/entries?folder=Characters"]) {
  test(`same-second organization edits invalidate cached ${path || "book"} responses`, async () => {
    const book = svc.createWorldBook(USER_ID, { name: "Source" });
    const entry = svc.createEntry(USER_ID, book.id, { folder: "Characters" })!;
    const beforeBook = svc.getWorldBook(USER_ID, book.id)!;
    const url = `http://localhost/world-books/${book.id}${path}`;
    const first = await app.request(url);
    const etag = first.headers.get("etag")!;
    const unchanged = await app.request(url, { headers: { "if-none-match": etag } });
    expect(unchanged.status).toBe(304);
    svc.updateEntry(USER_ID, entry.id, { folder: "Locations", tags: ["updated"] });
    // Force the second-resolution timestamps to their exact original values.
    getDb().query("UPDATE world_books SET updated_at = ? WHERE id = ?").run(beforeBook.updated_at, book.id);
    getDb().query("UPDATE world_book_entries SET updated_at = ? WHERE id = ?").run(entry.updated_at, entry.id);
    const changed = await app.request(url, { headers: { "if-none-match": etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    const payload = await changed.json();
    if (path) expect(payload).toMatchObject({ total: 0, data: [] });
    else expect(payload.entries.data[0]).toMatchObject({ folder: "Locations", tags: ["updated"] });
  });
}
