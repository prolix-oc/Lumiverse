import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { _resetForTests as resetTokenizerForTests } from "../services/tokenizer.service";
import { personasRoutes } from "./personas.routes";

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("userId", "u1");
  await next();
});
app.route("/", personasRoutes);

function initPersonasTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE personas (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT ''
  )`);
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
  resetTokenizerForTests();
}

function seedPersona(id: string, userId: string, description: string): void {
  getDb().query("INSERT INTO personas (id, user_id, description) VALUES (?, ?, ?)").run(id, userId, description);
}

beforeEach(() => {
  initPersonasTestDb();
  seedPersona("empty", "u1", "");
  seedPersona("filled", "u1", "12345");
  seedPersona("other-user", "u2", "x".repeat(100));
});

afterEach(() => {
  closeDatabase();
  resetTokenizerForTests();
});

describe("POST /token-counts", () => {
  test("returns char/4 fallback counts scoped to the authenticated user", async () => {
    const response = await app.request("http://localhost/token-counts", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      counts: { empty: 0, filled: 2 },
      tokenizer_name: "approximate",
      approximate: true,
    });
  });

  test("uses the tokenizer matched by model_id", async () => {
    getDb()
      .query("INSERT INTO tokenizer_configs (id, name, type, config) VALUES ('tok', 'Two chars', 'approximate', ?)")
      .run(JSON.stringify({ charsPerToken: 2 }));
    getDb()
      .query("INSERT INTO tokenizer_model_patterns (id, tokenizer_id, pattern, priority) VALUES ('pat', 'tok', '^chosen-model$', 100)")
      .run();
    resetTokenizerForTests();

    const response = await app.request("http://localhost/token-counts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: "chosen-model" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      counts: { empty: 0, filled: 3 },
      tokenizer_name: "Two chars",
      approximate: false,
    });
  });

  test("rejects non-string model ids", async () => {
    const response = await app.request("http://localhost/token-counts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: 42 }),
    });

    expect(response.status).toBe(400);
  });
});
