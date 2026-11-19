import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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

const { isStatusCheckBypassed, testConnection } = await import("./connections.service");

const USER = "alice";
const PROXY_URL = "https://proxy.example.test";
// The response a Gemini-compatible proxy gives when it serves generateContent but not the model catalog.
const PROXY_404 = { error: { code: 404, message: "Invalid endpoint: '/v1beta/models' is not a valid endpoint" } };

const originalFetch = globalThis.fetch;
let fetchCalls: string[] = [];

function insertProfile(id: string, metadata: Record<string, unknown>, withKey = true): void {
  getDb().query(
    "INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, has_api_key, metadata) VALUES (?, ?, ?, 'google', ?, 'gemini-2.5-pro', ?, ?)"
  ).run(id, USER, `Proxy ${id}`, PROXY_URL, withKey ? 1 : 0, JSON.stringify(metadata));
  if (withKey) keys.set(keyFor(USER, `connection_${id}_api_key`), "placeholder-key");
}

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  keys.clear();
  fetchCalls = [];
  getDb().run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, provider TEXT NOT NULL,
    api_url TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', preset_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0, has_api_key INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  globalThis.fetch = (async (url: any) => {
    fetchCalls.push(String(url));
    return Response.json(PROXY_404, { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeDatabase();
});

describe("isStatusCheckBypassed", () => {
  test("only a literal true opts out", () => {
    expect(isStatusCheckBypassed({ metadata: { bypass_status_check: true } })).toBe(true);
    for (const value of [false, "true", 1, null, undefined]) {
      expect(isStatusCheckBypassed({ metadata: { bypass_status_check: value } })).toBe(false);
    }
    expect(isStatusCheckBypassed({ metadata: {} })).toBe(false);
    expect(isStatusCheckBypassed(null)).toBe(false);
  });
});

describe("testConnection with bypass_status_check", () => {
  test("without the flag, a proxy that rejects the model catalog fails the test", async () => {
    insertProfile("plain", {});
    const result = await testConnection(USER, "plain");
    expect(result.success).toBe(false);
    expect(result.bypassed).toBeUndefined();
    expect(result.message).toContain("404");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toStartWith(`${PROXY_URL}/v1beta/models`);
  });

  test("with the flag, the probe is skipped and reported as bypassed", async () => {
    insertProfile("bypassed", { bypass_status_check: true });
    const result = await testConnection(USER, "bypassed");
    expect(result).toMatchObject({
      success: true,
      message: "Status check bypassed",
      provider: "google",
      timedOut: false,
      error: null,
      bypassed: true,
    });
    expect(fetchCalls).toHaveLength(0);
  });

  test("a missing API key still fails when the flag is set", async () => {
    insertProfile("nokey", { bypass_status_check: true }, false);
    const result = await testConnection(USER, "nokey");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Missing API key");
    expect(fetchCalls).toHaveLength(0);
  });

  test("an unknown connection id is not bypassed", async () => {
    const result = await testConnection(USER, "missing");
    expect(result.success).toBe(false);
    expect(result.message).toBe("Connection not found");
  });
});
