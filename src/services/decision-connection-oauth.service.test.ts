import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";

mock.module("./secrets.service", () => ({
  SYSTEM_SECRET_PRINCIPAL: "__system__",
  SYSTEM_SECRET_PRINCIPAL_EMAIL: "system@lumiverse.local",
  getSecretForStatus: async () => null,
  deleteSecret: () => {},
}));
const connections = await import("./decision-connections.service");
const oauth = await import("./decision-connection-oauth.service");
const { decisionConnectionsRoutes } = await import("../routes/decision-connections.routes");
const origin = "https://app.example.test";
const callback_url = `${origin}/api/v1/openrouter/oauth-landing`;
const connection = { name: "Decision", provider: "openrouter", model: "~typesafe/jev-latest" };
let fetchSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  closeDatabase(); initDatabase(":memory:");
  getDb().exec(readFileSync(new URL("../db/migrations/124_decision_connections.sql", import.meta.url), "utf8"));
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => { throw new Error("Invalid requests must not contact a provider"); }) as unknown as typeof fetch);
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore(); closeDatabase(); });

test("starts PKCE with correlated state and no profile or exposed verifier", async () => {
  const result = await oauth.initiateOAuth("alice", "openrouter", { callback_url, connection }, origin);
  expect(Object.keys(result).sort()).toEqual(["auth_url", "session_token"]);
  const url = new URL(result.auth_url);
  expect(url.origin).toBe("https://openrouter.ai");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
  expect(new URL(url.searchParams.get("callback_url")!).searchParams.get("state")).toBe(result.session_token);
  expect(connections.listConnections("alice", { limit: 10, offset: 0 }).total).toBe(0);
});

test("rejects unsupported providers, malformed targets, and unsafe callbacks before dispatch", async () => {
  await expect(oauth.initiateOAuth("alice", "typesafe", { callback_url, connection }, origin)).rejects.toThrow("does not support");
  for (const input of [null, {}, { callback_url }, { callback_url, connection, connection_id: "id" },
    { callback_url, connection_id: 12 }, { callback_url, connection: { ...connection, name: " " } },
    { callback_url, connection: { ...connection, provider: "nanogpt" } },
    { callback_url, connection: { ...connection, api_url: "https://proxy.test/v1" } },
    { callback_url: "https://other.test/api/v1/openrouter/oauth-landing", connection },
    { callback_url: `${origin}/other-callback`, connection }]) {
    await expect(oauth.initiateOAuth("alice", "openrouter", input, origin)).rejects.toThrow();
  }
});

test("validates ownership, provider and endpoint for saved targets", async () => {
  const saved = await connections.createConnection("alice", connection);
  await expect(oauth.initiateOAuth("bob", "openrouter", { callback_url, connection_id: saved.id }, origin)).rejects.toThrow("not found");
  await connections.updateConnection("alice", saved.id, { provider: "typesafe" });
  await expect(oauth.initiateOAuth("alice", "openrouter", { callback_url, connection_id: saved.id }, origin)).rejects.toThrow("provider has changed");
});

test("foreign, malformed, expired and changed-target callbacks never exchange codes", async () => {
  const saved = await connections.createConnection("alice", connection);
  const result = await oauth.initiateOAuth("alice", "openrouter", { callback_url, connection_id: saved.id }, origin);
  const callback = { session_token: result.session_token, code: "authorization-code" };
  await expect(oauth.completeOAuth("bob", callback)).rejects.toThrow("Invalid or expired");
  for (const input of [null, {}, { ...callback, code: 1 }, { ...callback, code: " " }]) {
    await expect(oauth.completeOAuth("alice", input)).rejects.toThrow("required");
  }
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
  try { await expect(oauth.completeOAuth("alice", callback)).rejects.toThrow("expired"); }
  finally { clock.mockRestore(); }
  const next = await oauth.initiateOAuth("alice", "openrouter", { callback_url, connection_id: saved.id }, origin);
  await connections.updateConnection("alice", saved.id, { provider: "typesafe" });
  await expect(oauth.completeOAuth("alice", { ...callback, session_token: next.session_token })).rejects.toThrow("provider has changed");
});

test("REST returns validation errors and uses the authenticated account", async () => {
  const saved = await connections.createConnection("alice", connection);
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", "bob"); await next(); });
  app.route("/api/v1/decision-connections", decisionConnectionsRoutes);
  const response = await app.request(`${origin}/api/v1/decision-connections/auth/openrouter`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_url, connection_id: saved.id }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Decision connection not found" });
});

test("REST supports a trusted browser origin whose host was rewritten by a proxy", async () => {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", "alice"); await next(); });
  app.route("/api/v1/decision-connections", decisionConnectionsRoutes);
  const response = await app.request("http://localhost:7860/api/v1/decision-connections/auth/openrouter", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ callback_url, connection }),
  });
  expect(response.status).toBe(200);
  const result = await response.json() as { auth_url: string };
  expect(new URL(new URL(result.auth_url).searchParams.get("callback_url")!).origin).toBe(origin);
});
