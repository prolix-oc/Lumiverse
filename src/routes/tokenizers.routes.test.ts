import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";

// Keep this route-policy test independent from the optional BetterAuth runtime.
// The production app supplies the real session middleware; this test only
// needs its owner/admin versus ordinary-user decision.
mock.module("../auth/middleware", () => ({
  requireOwner: async (c: any, next: any) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (session.user.role !== "owner" && session.user.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }
    return next();
  },
}));
const warmed: Array<[string, string | null]> = [];
mock.module("../services/tokenizer-warmup.service", () => ({ warmAssemblyTokenizer: (model: string, chat: string | null) => warmed.push([model, chat]) }));

const { tokenizersRoutes } = await import("./tokenizers.routes");

const PUBLIC_ROUTES = [
  "POST /warm",
  "POST /count",
  "POST /count-batch",
  "POST /patterns/test",
] as const;

const OWNER_ROUTES = [
  "GET /",
  "POST /",
  "PUT /:id",
  "DELETE /:id",
  "POST /test",
  "POST /resolve",
  "GET /hf-token",
  "PUT /hf-token",
  "POST /install",
  "GET /patterns",
  "POST /patterns",
  "PUT /patterns/:id",
  "DELETE /patterns/:id",
] as const;

function initTokenizerTestDb(): void {
  warmed.length = 0;
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE tokenizer_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL,
    is_built_in INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  getDb().run(`CREATE TABLE tokenizer_model_patterns (
    id TEXT PRIMARY KEY,
    tokenizer_id TEXT NOT NULL,
    pattern TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    is_built_in INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  getDb().run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  getDb().run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY, user_id TEXT, name TEXT, model TEXT, provider TEXT,
    metadata TEXT DEFAULT '{}', is_default INTEGER DEFAULT 0
  )`);
}

function createTestApp(role: "owner" | "user" = "user"): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("session", {
      user: { id: "user-1", role },
      session: { id: "session-1", userId: "user-1", token: "test", expiresAt: new Date(Date.now() + 60_000) },
    } as never);
    c.set("userId", "user-1");
    await next();
  });
  app.route("/", tokenizersRoutes);
  return app;
}

async function request(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return app.request(`http://localhost${path}`, {
    method,
    headers: payload === undefined
      ? undefined
      : {
          "content-type": "application/json",
          "content-length": String(new TextEncoder().encode(payload).byteLength),
        },
    body: payload,
  });
}

beforeEach(initTokenizerTestDb);
afterEach(() => closeDatabase());

describe("H14 tokenizer route policy", () => {
  test("warmup resolves only the caller's connection and returns without waiting for loading", async () => {
    getDb().exec("INSERT INTO connection_profiles (id, user_id, model, provider) VALUES ('mine', 'user-1', 'kimi-k2.5', 'openai'), ('other', 'user-2', 'private-model', 'openai')");
    const app = createTestApp();
    expect((await request(app, "POST", "/warm", { connection_id: "other" })).status).toBe(404);
    expect((await request(app, "POST", "/warm", { connection_id: 123 })).status).toBe(400);
    expect((await request(app, "POST", "/warm", { connection_id: "mine", chat_id: "chat" })).status).toBe(202);
    await Bun.sleep(0);
    expect(warmed).toEqual([["kimi-k2.5", "chat"]]);
  });
  test("registered routes are exactly the public and owner policy sets", () => {
    const registered = new Set(
      tokenizersRoutes.routes.map((route) => `${route.method} ${route.path}`),
    );
    const expected = new Set([...PUBLIC_ROUTES, ...OWNER_ROUTES]);
    expect(registered).toEqual(expected);
  });

  test("non-owner sessions can use the public tokenizer routes", async () => {
    const app = createTestApp();

    for (const route of OWNER_ROUTES) {
      const [method, path] = route.split(" ");
      const response = await request(app, method!, path!, {});
      expect(response.status).toBe(403);
    }

    const count = await request(app, "POST", "/count", { model_id: "unknown", text: "hello" });
    expect(count.status).toBe(200);

    const batch = await request(app, "POST", "/count-batch", {
      model_id: "unknown",
      texts: ["one", "two"],
    });
    expect(batch.status).toBe(200);
    expect((await batch.json()).results).toEqual([
      { token_count: null, char_count: 3 },
      { token_count: null, char_count: 3 },
    ]);

    const pattern = await request(app, "POST", "/patterns/test", { model_id: "unknown" });
    expect(pattern.status).toBe(200);
    expect(await pattern.json()).toEqual({ matched: false, tokenizer_id: null, tokenizer_name: null });
  });

  test("rejects batches over the 64-text cap", async () => {
    const app = createTestApp();
    const response = await request(app, "POST", "/count-batch", {
      model_id: "unknown",
      texts: Array.from({ length: 65 }, (_, index) => String(index)),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Batch exceeds the 64-item cap" });
  });

  test("caps every public tokenizer request body before JSON parsing", async () => {
    const app = createTestApp();
    const oversized = "x".repeat(1024 * 1024);

    for (const [path, body] of [
      ["/count", { model_id: "unknown", text: oversized }],
      ["/count-batch", { model_id: "unknown", texts: [oversized] }],
      ["/patterns/test", { model_id: oversized }],
    ] as const) {
      const response = await request(app, "POST", path, body);
      expect(response.status).toBe(413);
    }
  });
});
