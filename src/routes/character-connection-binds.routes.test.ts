import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { characterConnectionBindsRoutes } from "./character-connection-binds.routes";

/**
 * Route-level contract for `/api/v1/character-connection-binds` ("bind to
 * char"): GET null-when-unset, PUT bind / PUT null clear, error mapping
 * (unknown character 404, unknown connection 404, malformed body 400), and
 * user scoping — user A must not read or write user B's binding, even though
 * both rows live under the same `characterConnection:{characterId}` key
 * family in the shared settings table.
 */

const USER_A = "user-a";
const USER_B = "user-b";

const CHAR_A = "char-a";
const CHAR_B = "char-b";

const CONN_A1 = "conn-a1";
const CONN_A2 = "conn-a2";
const CONN_B1 = "conn-b1";

function initBindsTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  // Column set mirrors the hand-written fixtures in
  // `chats.routes.edit-and-send.test.ts` / `connections.service.acting-connection.test.ts`;
  // `charactersSvc.getCharacter` tolerates the absent library-scope columns.
  db.run(`CREATE TABLE characters (
    id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '', scenario TEXT NOT NULL DEFAULT '', first_mes TEXT NOT NULL DEFAULT '',
    mes_example TEXT NOT NULL DEFAULT '', creator TEXT NOT NULL DEFAULT '', creator_notes TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '', post_history_instructions TEXT NOT NULL DEFAULT '', avatar_path TEXT,
    image_id TEXT, tags TEXT NOT NULL DEFAULT '[]', alternate_greetings TEXT NOT NULL DEFAULT '[]',
    extensions TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1
  )`);
  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL, value TEXT NOT NULL, user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key, user_id)
  )`);
  db.run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, api_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '', preset_id TEXT, is_default INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1,
    has_api_key INTEGER NOT NULL DEFAULT 0, user_id TEXT
  )`);

  db.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run(CHAR_A, USER_A, "A's character");
  db.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run(CHAR_B, USER_B, "B's character");
  for (const id of [CONN_A1, CONN_A2, CONN_B1]) {
    db.query(
      `INSERT INTO connection_profiles
         (id, name, provider, api_url, model, preset_id, is_default, metadata, created_at, updated_at, has_api_key, user_id)
       VALUES (?, ?, 'custom', 'http://127.0.0.1:1234/v1', ?, NULL, 0, '{}', 1, 1, 0, ?)`,
    ).run(id, id, `${id}-model`, id === CONN_B1 ? USER_B : USER_A);
  }
}

/** Mutable so the scoping cases can act as either tenant through the same middleware. */
let currentUserId = USER_A;

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("userId", currentUserId);
  await next();
});
app.route("/", characterConnectionBindsRoutes);

async function request(method: "GET" | "PUT", path: string, body?: unknown): Promise<Response> {
  return app.request(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

beforeEach(() => {
  currentUserId = USER_A;
  initBindsTestDb();
});

afterEach(() => closeDatabase());

describe("GET /:characterId", () => {
  test("returns { connection_id: null } when no binding exists", async () => {
    const response = await request("GET", `/${CHAR_A}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection_id: null });
  });

  test("returns the bound connection id after a PUT", async () => {
    await request("PUT", `/${CHAR_A}`, { connection_id: CONN_A1 });
    const response = await request("GET", `/${CHAR_A}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection_id: CONN_A1 });
  });

  test("unknown character → 404", async () => {
    const response = await request("GET", "/char-never-existed");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Character not found" });
  });
});

describe("PUT /:characterId", () => {
  test("binds and returns the resulting connection_id", async () => {
    const response = await request("PUT", `/${CHAR_A}`, { connection_id: CONN_A2 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection_id: CONN_A2 });
  });

  test("rebinding moves the binding to the new connection", async () => {
    await request("PUT", `/${CHAR_A}`, { connection_id: CONN_A1 });
    const response = await request("PUT", `/${CHAR_A}`, { connection_id: CONN_A2 });
    expect(await response.json()).toEqual({ connection_id: CONN_A2 });
  });

  test("null clears an existing binding", async () => {
    await request("PUT", `/${CHAR_A}`, { connection_id: CONN_A1 });
    const response = await request("PUT", `/${CHAR_A}`, { connection_id: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection_id: null });
    expect(await (await request("GET", `/${CHAR_A}`)).json()).toEqual({ connection_id: null });
  });

  test("an absent connection_id also clears", async () => {
    await request("PUT", `/${CHAR_A}`, { connection_id: CONN_A1 });
    const response = await request("PUT", `/${CHAR_A}`, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection_id: null });
  });

  test("clearing an already-unbound character is idempotent", async () => {
    const response = await request("PUT", `/${CHAR_A}`, { connection_id: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection_id: null });
  });

  test("unknown character → 404", async () => {
    const response = await request("PUT", "/char-never-existed", { connection_id: CONN_A1 });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Character not found" });
  });

  test("unknown connection → 404 (preset-profiles convention)", async () => {
    const response = await request("PUT", `/${CHAR_A}`, { connection_id: "conn-never-existed" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Connection not found" });
  });

  test("another user's connection is not bindable (scoped getConnection)", async () => {
    const response = await request("PUT", `/${CHAR_A}`, { connection_id: CONN_B1 });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Connection not found" });
  });

  test.each([
    ["an empty string", { connection_id: "" }],
    ["a whitespace-only string", { connection_id: "   " }],
    ["a number", { connection_id: 42 }],
    ["an object", { connection_id: { id: CONN_A1 } }],
    ["an array body", [CONN_A1]],
    ["a scalar body", CONN_A1],
  ])("invalid body (%s) → 400", async (_label, body) => {
    const response = await request("PUT", `/${CHAR_A}`, body);
    expect(response.status).toBe(400);
  });

  test("malformed JSON → 400", async () => {
    const response = await app.request(`http://localhost/${CHAR_A}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });
});

describe("user scoping", () => {
  test("user A cannot read user B's binding: a foreign character is a 404", async () => {
    currentUserId = USER_B;
    await request("PUT", `/${CHAR_B}`, { connection_id: CONN_B1 });

    // A knows B's character id and queries it. The route's user-scoped
    // getCharacter makes a foreign character indistinguishable from a
    // nonexistent one, so A learns nothing — not even that the binding exists.
    currentUserId = USER_A;
    const response = await request("GET", `/${CHAR_B}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Character not found" });

    // ...while B still sees its own binding.
    currentUserId = USER_B;
    expect(await (await request("GET", `/${CHAR_B}`)).json()).toEqual({ connection_id: CONN_B1 });
  });

  test("user A cannot write user B's binding", async () => {
    currentUserId = USER_B;
    await request("PUT", `/${CHAR_B}`, { connection_id: CONN_B1 });

    // The character is B's, so A's write is a 404 — never a cross-tenant write.
    currentUserId = USER_A;
    const response = await request("PUT", `/${CHAR_B}`, { connection_id: CONN_A1 });
    expect(response.status).toBe(404);

    currentUserId = USER_B;
    expect(await (await request("GET", `/${CHAR_B}`)).json()).toEqual({ connection_id: CONN_B1 });
  });

  test("the two users' bindings coexist as separate (key, user_id) settings rows", async () => {
    await request("PUT", `/${CHAR_A}`, { connection_id: CONN_A1 });
    currentUserId = USER_B;
    await request("PUT", `/${CHAR_B}`, { connection_id: CONN_B1 });

    // The settings table namespaces by (key, user_id): each user's binding is
    // its own row, so B rebinding can never stomp A's row.
    const rows = getDb()
      .query("SELECT key, value, user_id FROM settings WHERE key LIKE 'characterConnection:%' ORDER BY key")
      .all() as Array<{ key: string; value: string; user_id: string }>;
    expect(rows).toEqual([
      { key: `characterConnection:${CHAR_A}`, value: JSON.stringify(CONN_A1), user_id: USER_A },
      { key: `characterConnection:${CHAR_B}`, value: JSON.stringify(CONN_B1), user_id: USER_B },
    ]);

    currentUserId = USER_B;
    await request("PUT", `/${CHAR_B}`, { connection_id: null });
    currentUserId = USER_A;
    expect(await (await request("GET", `/${CHAR_A}`)).json()).toEqual({ connection_id: CONN_A1 });
  });
});
