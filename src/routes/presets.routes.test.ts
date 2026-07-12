import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { presetsRoutes } from "./presets.routes";

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

describe("preset cache validators", () => {
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
});
