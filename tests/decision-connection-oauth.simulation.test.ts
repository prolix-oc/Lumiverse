import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";

// Start: postman simulation run tests/fixtures/provider-pkce/provider-pkce.sim.yaml --port 4921 --no-history
// Run: PROVIDER_PKCE_SIMULATION_URL=http://127.0.0.1:4921/pkce bun test --isolate tests/decision-connection-oauth.simulation.test.ts
// Internal run notes: internal-docs/provider-pkce.context.md.

const keys = new Map<string, string>();
mock.module("../src/services/secrets.service", () => ({
  SYSTEM_SECRET_PRINCIPAL: "__system__", SYSTEM_SECRET_PRINCIPAL_EMAIL: "system@lumiverse.local",
  getSecret: async (user: string, key: string) => keys.get(`${user}:${key}`) ?? null,
  getSecretForStatus: async (user: string, key: string) => keys.get(`${user}:${key}`) ?? null,
  putSecret: async (user: string, key: string, value: string) => { keys.set(`${user}:${key}`, value); },
  deleteSecret: (user: string, key: string) => keys.delete(`${user}:${key}`),
}));
const connections = await import("../src/services/decision-connections.service");
const { decisionConnectionsRoutes } = await import("../src/routes/decision-connections.routes");
const textOpenRouter = await import("../src/services/openrouter.service");
const textNanoGpt = await import("../src/services/nanogpt.service");
const baseUrl = process.env.PROVIDER_PKCE_SIMULATION_URL;
const nativeFetch = globalThis.fetch;
const origin = "https://app.example.test";
const callbackUrl = (provider: string) => `${origin}/api/v1/${provider}/oauth-landing?opener_origin=${encodeURIComponent(origin)}`;
const requests: string[] = [];
let app: Hono;
async function post(path: string, body: unknown, user = "alice") {
  return app.request(`${origin}/api/v1/decision-connections${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-test-user": user }, body: JSON.stringify(body),
  });
}
async function start(provider: string, target: Record<string, unknown>) {
  const response = await post(`/auth/${provider}`, { callback_url: callbackUrl(provider), ...target });
  expect(response.status).toBe(200);
  const result = await response.json() as { auth_url: string; session_token: string };
  const authorization = new URL(result.auth_url);
  expect(new URL(authorization.searchParams.get("callback_url")!).searchParams.get("state")).toBe(result.session_token);
  return { ...result, code: `fixture-${authorization.searchParams.get("code_challenge")}` };
}

describe.skipIf(!baseUrl)("Decision connection PKCE over real provider HTTP", () => {
  beforeEach(() => {
    closeDatabase(); initDatabase(":memory:"); keys.clear(); requests.length = 0;
    getDb().exec(readFileSync(new URL("../src/db/migrations/124_decision_connections.sql", import.meta.url), "utf8"));
    app = new Hono();
    app.use("*", async (c, next) => { c.set("userId", c.req.header("x-test-user") || "alice"); await next(); });
    app.route("/api/v1/decision-connections", decisionConnectionsRoutes);
    // Change only routing. Requests still use the production fetch, JSON body,
    // timeout and response handling, over real HTTP to the Postman simulation.
    globalThis.fetch = ((input: any, init: any) => {
      const url = new URL(String(input));
      const provider = url.hostname === "openrouter.ai" ? "openrouter" : url.hostname === "nano-gpt.com" ? "nanogpt" : null;
      if (!provider || url.pathname !== "/api/v1/auth/keys") throw new Error(`Unexpected upstream: ${url}`);
      requests.push(provider);
      return nativeFetch(`${baseUrl}/${provider}${url.pathname}`, init);
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = nativeFetch; closeDatabase(); });

  test.each(["openrouter", "nanogpt"])("creates %s profiles with their selected model, defaults and private credential", async (provider) => {
    await connections.createConnection("alice", { name: "Old default", provider: "typesafe", is_default: true });
    const connection = { name: "New decision", provider, model: "typesafe/pinned", is_default: true, metadata: { marker: "keep" } };
    const session = await start(provider, { connection });
    expect(connections.listConnections("alice", { limit: 10, offset: 0 }).total).toBe(1);
    expect(keys.size).toBe(0);
    const response = await post("/auth/callback", { session_token: session.session_token, code: session.code });
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.created).toBe(true);
    expect(result.profile).toMatchObject({ ...connection, has_api_key: true });
    expect(connections.getDefaultConnection("alice")?.id).toBe(result.connection_id);
    expect(keys.get(`alice:${connections.decisionConnectionSecretKey(result.connection_id)}`)).toBe(`${provider}-fixture-key`);
    expect([...keys.keys()].every((key) => key.startsWith("alice:decision_connection_"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fixture-key");
    expect(requests).toEqual([provider]);
    expect((await post("/auth/callback", { session_token: session.session_token, code: session.code })).status).toBe(400);
    expect(requests).toHaveLength(1);
  });

  test.each(["openrouter", "nanogpt"])("replaces only the existing %s key and rejects another account's callback", async (provider) => {
    const saved = await connections.createConnection("alice", { name: "Pinned", provider, model: "pinned-model", api_key: "old-key", metadata: { marker: "keep" } });
    const session = await start(provider, { connection_id: saved.id });
    const body = { session_token: session.session_token, code: session.code };
    expect((await post("/auth/callback", body, "bob")).status).toBe(400);
    expect(requests).toHaveLength(0);
    const response = await post("/auth/callback", body);
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.created).toBe(false);
    expect(result.profile).toMatchObject({ id: saved.id, name: "Pinned", model: "pinned-model", metadata: { marker: "keep" }, has_api_key: true });
    expect(keys.get(`alice:${connections.decisionConnectionSecretKey(saved.id)}`)).toBe(`${provider}-fixture-key`);
  });

  test.each(["simulate-error", "simulate-missing-key"])("failed exchange %s leaves no profile or secret and permits a new sign-in", async (code) => {
    const session = await start("openrouter", { connection: { name: "Pending", provider: "openrouter" } });
    const response = await post("/auth/callback", { session_token: session.session_token, code });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Provider sign-in failed. Please try again." });
    expect(connections.listConnections("alice", { limit: 10, offset: 0 }).total).toBe(0);
    expect(keys.size).toBe(0);
    const retry = await start("openrouter", { connection: { name: "Pending", provider: "openrouter" } });
    expect((await post("/auth/callback", { session_token: retry.session_token, code: retry.code })).status).toBe(200);
  });

  test("simultaneous callbacks consume a session once", async () => {
    const session = await start("nanogpt", { connection: { name: "Once", provider: "nanogpt" } });
    const responses = await Promise.all([1, 2].map(() => post("/auth/callback", { session_token: session.session_token, code: session.code })));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(requests).toEqual(["nanogpt"]);
  });

  test.each(["openrouter", "nanogpt"])("existing %s text sign-in still uses its own credential namespace", async (provider) => {
    // Minimal real SQLite table for the unchanged text-connection service.
    getDb().exec(readFileSync(new URL("../src/db/baseline.sql", import.meta.url), "utf8"));
    getDb().query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run("alice", "Alice", "alice@example.test");
    const service = provider === "openrouter" ? textOpenRouter : textNanoGpt;
    const session = await service.initiateOAuthAsync(callbackUrl(provider), { connectionName: "Text profile" });
    const challenge = new URL(session.auth_url).searchParams.get("code_challenge");
    const result = await service.completeOAuth("alice", session.session_token, `fixture-${challenge}`);
    expect(result.profile?.provider).toBe(provider);
    expect(keys.get(`alice:connection_${result.connection_id}_api_key`)).toBe(`${provider}-fixture-key`);
    expect(connections.listConnections("alice", { limit: 10, offset: 0 }).total).toBe(0);
  });
});
