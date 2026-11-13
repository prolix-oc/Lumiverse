import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { MAX_PRESET_BODY_BYTES, presetsRoutes } from "./presets.routes";

function initPresetsTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    parameters TEXT NOT NULL DEFAULT '{}',
    prompt_order TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    prompts TEXT NOT NULL DEFAULT '{}',
    user_id TEXT,
    engine TEXT NOT NULL DEFAULT 'classic',
    cache_revision INTEGER NOT NULL DEFAULT 0
  )`);
  getDb().run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (key, user_id)
  )`);
  getDb().run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    preset_id TEXT
  )`);
  getDb().run(`CREATE TABLE regex_scripts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    preset_id TEXT
  )`);
}

function insertPreset(id: string, userId: string, cacheRevision = 0): void {
  getDb().run(
    `INSERT INTO presets (id, name, provider, parameters, prompt_order, metadata, created_at, updated_at, prompts, user_id, engine, cache_revision)
     VALUES (?, 'Preset', 'loom', '{}', '[]', '{}', 1, 1, '{}', ?, 'classic', ?)`,
    [id, userId, cacheRevision],
  );
}

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("userId", c.req.header("x-test-user")!);
  await next();
});
app.route("/", presetsRoutes);

beforeEach(initPresetsTestDb);
afterEach(() => closeDatabase());

describe("preset body size limit", () => {
  test("allows preset creation requests through 50 MB", async () => {
    const response = await app.request("http://localhost/", {
      method: "POST",
      headers: {
        "x-test-user": "u1",
        "content-type": "application/json",
        "content-length": String(MAX_PRESET_BODY_BYTES),
      },
      body: JSON.stringify({ name: "Large preset", provider: "loom" }),
    });

    expect(response.status).toBe(201);
  });

  test("rejects preset creation requests over 50 MB", async () => {
    const response = await app.request("http://localhost/", {
      method: "POST",
      headers: {
        "x-test-user": "u1",
        "content-type": "application/json",
        "content-length": String(MAX_PRESET_BODY_BYTES + 1),
      },
      body: JSON.stringify({ name: "Too large", provider: "loom" }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request body too large" });
  });

  test("allows preset update requests through 50 MB", async () => {
    insertPreset("preset-1", "u1", 0);
    const response = await app.request("http://localhost/preset-1", {
      method: "PUT",
      headers: {
        "x-test-user": "u1",
        "content-type": "application/json",
        "content-length": String(MAX_PRESET_BODY_BYTES),
      },
      body: JSON.stringify({ name: "Updated preset", expected_cache_revision: 0 }),
    });

    expect(response.status).toBe(200);
  });

  test("rejects preset update requests over 50 MB", async () => {
    insertPreset("preset-1", "u1", 0);
    const response = await app.request("http://localhost/preset-1", {
      method: "PUT",
      headers: {
        "x-test-user": "u1",
        "content-type": "application/json",
        "content-length": String(MAX_PRESET_BODY_BYTES + 1),
      },
      body: JSON.stringify({ name: "Too large", expected_cache_revision: 0 }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request body too large" });
  });
});

describe("preset cache validators", () => {
  test('capabilities stay small, owner scoped and fresh after same-second edits', async () => {
    insertPreset('capabilities', 'u1');
    const read = (user = 'u1') => app.request('http://localhost/capabilities/capabilities', { headers: { 'x-test-user': user } });
    expect((await (await read()).json()).has_prompt_variables).toBe(false);
    getDb().run('UPDATE presets SET prompt_order = ?, cache_revision = 1 WHERE id = ?', [
      JSON.stringify([{ content: 'x'.repeat(100_000), variables: [{ name: 'mood' }] }]), 'capabilities',
    ]);
    const response = await read();
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ id: 'capabilities', cache_revision: 1, has_prompt_variables: true });
    expect(body.length).toBeLessThan(150);
    expect((await read('u2')).status).toBe(404);
    for (const value of ['not json', JSON.stringify(['string', null, 12, { variables: 'bad' }]), '[]']) {
      getDb().run('UPDATE presets SET prompt_order = ? WHERE id = ?', [value, 'capabilities']);
      const malformed = await read();
      expect(malformed.status).toBe(200);
      expect((await malformed.json()).has_prompt_variables).toBe(false);
    }
  });

  test("scopes empty registry ETags to the authenticated user and varies on cookies", async () => {
    const first = await app.request("http://localhost/registry", { headers: { "x-test-user": "u1" } });
    const second = await app.request("http://localhost/registry", { headers: { "x-test-user": "u2" } });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("etag")).not.toBe(second.headers.get("etag"));
    expect(first.headers.get("vary")).toBe("Cookie, Accept-Encoding");
  });

  test("invalidates a full preset ETag when its cache revision changes", async () => {
    insertPreset("preset-1", "u1");
    const first = await app.request("http://localhost/preset-1", { headers: { "x-test-user": "u1" } });
    const etag = first.headers.get("etag");
    expect(first.status).toBe(200);
    expect(etag).not.toBeNull();
    expect(etag).toStartWith('W/"');
    const notModified = await app.request("http://localhost/preset-1", {
      headers: { "x-test-user": "u1", "if-none-match": etag!.slice(2) },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(etag);
    expect(notModified.headers.get("vary")).toBe("Cookie, Accept-Encoding");

    getDb().run("UPDATE presets SET cache_revision = 1 WHERE id = ?", ["preset-1"]);
    const second = await app.request("http://localhost/preset-1", {
      headers: { "x-test-user": "u1", "if-none-match": etag! },
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(etag);
    expect(second.headers.get("vary")).toBe("Cookie, Accept-Encoding");
  });
  test("returns a revision conflict without clobbering, then increments on a matching update", async () => {
    insertPreset("preset-1", "u1", 3);

    const stale = await app.request("http://localhost/preset-1", {
      method: "PUT",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({
        name: "stale",
        metadata: { stale: true },
        expected_cache_revision: 2,
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "Preset preset-1 changed since revision 2; current revision is 3",
      code: "PRESET_REVISION_CONFLICT",
      expected_cache_revision: 2,
      actual_cache_revision: 3,
    });

    const successful = await app.request("http://localhost/preset-1", {
      method: "PUT",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({
        name: "newer",
        expected_cache_revision: 3,
      }),
    });
    expect(successful.status).toBe(200);
    const updated = await successful.json();
    expect(updated.name).toBe("newer");
    expect(updated.cache_revision).toBe(4);

    const row = getDb().query("SELECT name, metadata, cache_revision FROM presets WHERE id = ?").get("preset-1");
    expect(row).toEqual({ name: "newer", metadata: "{}", cache_revision: 4 });
  });

  test("rejects unconditional updates without a revision precondition", async () => {
    insertPreset("preset-1", "u1", 3);

    const response = await app.request("http://localhost/preset-1", {
      method: "PUT",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({ metadata: { stale: true } }),
    });

    expect(response.status).toBe(428);
    expect(await response.json()).toEqual({
      error: "expected_cache_revision is required",
      code: "PRESET_REVISION_REQUIRED",
    });
    const row = getDb().query("SELECT metadata, cache_revision FROM presets WHERE id = ?").get("preset-1");
    expect(row).toEqual({ metadata: "{}", cache_revision: 3 });
  });
});

describe("preset bulk mutations", () => {
  test("deletes only selected presets owned by the authenticated user", async () => {
    insertPreset("one", "u1");
    insertPreset("two", "u1");
    insertPreset("foreign", "u2");

    const response = await app.request("http://localhost/bulk-delete", {
      method: "POST",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({ ids: ["one", "foreign"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: ["one"] });
    expect(getDb().query("SELECT id FROM presets ORDER BY id").all()).toEqual([
      { id: "foreign" },
      { id: "two" },
    ]);
  });

  test("rejects malformed bulk selections", async () => {
    const response = await app.request("http://localhost/bulk-delete", {
      method: "POST",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({ ids: [] }),
    });
    expect(response.status).toBe(400);
  });
});
