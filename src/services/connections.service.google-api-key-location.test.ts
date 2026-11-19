import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";

const keys = new Map<string, string>();
const keyFor = (user: string, key: string) => `${user}:${key}`;
mock.module("./secrets.service", () => ({
  SYSTEM_SECRET_PRINCIPAL: "__system__",
  SYSTEM_SECRET_PRINCIPAL_EMAIL: "system@lumiverse.local",
  getSecret: async (user: string, key: string) => keys.get(keyFor(user, key)) ?? null,
  getSecretForStatus: async (user: string, key: string) => keys.get(keyFor(user, key)) ?? null,
  putSecret: async (user: string, key: string, value: string) => { keys.set(keyFor(user, key), value); },
  deleteSecret: (user: string, key: string) => keys.delete(keyFor(user, key)),
}));

const { testConnection, listConnectionModels } = await import("./connections.service");

const USER = "alice";
const KEY = "placeholder-key";
const GATEWAY = "https://gateway.example.test";
const originalFetch = globalThis.fetch;
let calls: { url: string; headers: Record<string, string> }[] = [];

function insertGoogleProfile(id: string, metadata: Record<string, unknown>): void {
  getDb().query(
    "INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, has_api_key, metadata) VALUES (?, ?, ?, 'google', ?, 'gemini-2.5-flash', 1, ?)"
  ).run(id, USER, `Gateway ${id}`, GATEWAY, JSON.stringify(metadata));
  keys.set(keyFor(USER, `connection_${id}_api_key`), KEY);
}

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  keys.clear();
  calls = [];
  getDb().run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, provider TEXT NOT NULL,
    api_url TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', preset_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0, has_api_key INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  // Stands in for a gateway that, like many Gemini-compatible proxies, reads only the Bearer header.
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url: String(input), headers });
    if (headers.authorization !== `Bearer ${KEY}`) {
      return Response.json({ error: { code: 401, message: "Invalid or missing API key" } }, { status: 401 });
    }
    return Response.json({ models: [{ name: "models/gemini-2.5-flash" }] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeDatabase();
});

test("a Bearer-only gateway rejects the default query key", async () => {
  insertGoogleProfile("default", {});
  expect((await testConnection(USER, "default")).success).toBe(false);
  expect(calls[0].url).toBe(`${GATEWAY}/v1beta/models?key=${KEY}`);
});

test("testConnection sends the key where the profile's metadata says", async () => {
  insertGoogleProfile("bearer", { google_api_key_location: "bearer" });
  const result = await testConnection(USER, "bearer");
  expect(result.success).toBe(true);
  expect(calls[0].url).toBe(`${GATEWAY}/v1beta/models`);
});

test("listConnectionModels uses the saved location", async () => {
  insertGoogleProfile("list", { google_api_key_location: "bearer" });
  expect(await listConnectionModels(USER, "list")).toEqual({ models: ["gemini-2.5-flash"], model_labels: undefined, provider: "google" });
});
