import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
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
const svc = await import("./decision-connections.service");
const { evaluateDecision } = await import("./decisions.service");
const { decisionConnectionsRoutes } = await import("../routes/decision-connections.routes");
const { decisionsRoutes } = await import("../routes/decisions.routes");
const { WorkerHostDecisionsApi } = await import("../spindle/worker-host-decisions-api");
const originalFetch = globalThis.fetch;
beforeEach(() => {
  closeDatabase(); initDatabase(":memory:"); keys.clear();
  getDb().exec(readFileSync(new URL("../db/migrations/124_decision_connections.sql", import.meta.url), "utf8"));
});
afterEach(() => { globalThis.fetch = originalFetch; closeDatabase(); });
const connection = (user = "alice", extra = {}) => svc.createConnection(user, { name: "Decision", provider: "typesafe", model: "jev-latest", api_key: "secret-for-test", ...extra });
const input = { state: "Lumiverse", questions: { check: { type: "noul" as const, instructions: "Mentioned?" } } };
function app() {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", "alice"); await next(); });
  app.route("/connections", decisionConnectionsRoutes); app.route("/decisions", decisionsRoutes);
  return app;
}
test("CRUD is user scoped, maintains one default, and preserves manually entered models", async () => {
  const first = await connection("alice", { is_default: true, model: "jev-pinned-not-in-catalog" });
  const second = await connection("alice", { is_default: true });
  await connection("bob", { is_default: true });
  expect(svc.getConnection("alice", first.id)?.is_default).toBe(false);
  expect(svc.getDefaultConnection("alice")?.id).toBe(second.id);
  expect(svc.getDefaultConnection("bob")).not.toBeNull();
  expect(svc.getConnection("bob", first.id)).toBeNull();
  expect(await svc.updateConnection("bob", first.id, { name: "stolen" })).toBeNull();
  expect(await svc.deleteConnection("bob", first.id)).toBe(false);
  await svc.updateConnection("alice", first.id, { is_default: true });
  expect(svc.getDefaultConnection("alice")?.model).toBe("jev-pinned-not-in-catalog");
  expect(() => getDb().query("UPDATE decision_connections SET is_default = 1 WHERE id = ?").run(second.id)).toThrow();
});
test("duplicates keys privately, handles missing keys, and deletes keys with profiles", async () => {
  const original = await connection("alice", { is_default: true });
  const copied = (await svc.duplicateConnection("alice", original.id))!;
  expect(copied.is_default).toBe(false);
  expect(copied.has_api_key).toBe(true);
  keys.delete(keyFor("alice", svc.decisionConnectionSecretKey(original.id)));
  expect((await svc.duplicateConnection("alice", original.id))!.has_api_key).toBe(false);
  await svc.deleteConnection("alice", copied.id);
  expect(keys.has(keyFor("alice", svc.decisionConnectionSecretKey(copied.id)))).toBe(false);
  expect(await svc.setConnectionApiKey("bob", original.id, "stolen")).toBe(false);
});
test("provider and endpoint edits clear previous credentials unless a replacement is supplied", async () => {
  const profile = await connection();
  expect((await svc.updateConnection("alice", profile.id, { provider: "openrouter" }))!.has_api_key).toBe(false);
  await svc.setConnectionApiKey("alice", profile.id, "new-key");
  expect((await svc.updateConnection("alice", profile.id, { api_url: "https://proxy.test/v1" }))!.has_api_key).toBe(false);
  expect((await svc.updateConnection("alice", profile.id, { api_url: "https://another.test/v1", api_key: "replacement" }))!.has_api_key).toBe(true);
});
test("provider changes reset prior endpoint, model and routing unless explicitly supplied", async () => {
  const profile = await connection("alice", { provider: "openrouter", api_url: "https://proxy.test/v1", model: "~typesafe/jev-latest", default_parameters: { provider: { only: ["TypeSafe"] } } });
  const updated = (await svc.updateConnection("alice", profile.id, { provider: "typesafe" }))!;
  expect(updated).toMatchObject({ provider: "typesafe", api_url: "", model: "", default_parameters: {}, has_api_key: false });
});
test("model preview never sends saved keys to a changed provider or endpoint", async () => {
  const profile = await connection();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ models: [{ name: "jev-latest" }] }); }) as unknown as typeof fetch;
  const changed = await svc.listConnectionModelsPreview("alice", { connection_id: profile.id, provider: "typesafe", api_url: "https://other.test/v1" });
  expect(changed.error).toContain("Enter an API key"); expect(calls).toBe(0);
  expect((await svc.listConnectionModelsPreview("bob", { connection_id: profile.id, provider: "typesafe" })).error).toContain("not found");
  expect((await svc.listConnectionModels("alice", profile.id)).models[0]?.id).toBe("jev-latest");
  expect(calls).toBe(1);
});
test("catalog checks and sample decisions are separate; HTTP 400 is failure", async () => {
  const profile = await connection();
  const calls: string[] = [];
  globalThis.fetch = (async (url: any) => { calls.push(String(url)); return Response.json({ models: [{ name: "jev-latest" }] }); }) as unknown as typeof fetch;
  expect((await svc.testConnection("alice", profile.id)).success).toBe(true);
  expect(calls).toEqual(["https://api.typesafe.ai/v1/models"]);
  globalThis.fetch = (async () => Response.json({ message: "invalid sample", error_type: "validation" }, { status: 400 })) as unknown as typeof fetch;
  expect((await svc.runSampleDecision("alice", profile.id)).success).toBe(false);
});
test("explicit missing IDs never fall back and missing credentials fail before dispatch", async () => {
  const profile = await connection("alice", { is_default: true });
  let calls = 0; globalThis.fetch = (async () => { calls++; throw new Error("must not call"); }) as unknown as typeof fetch;
  await expect(evaluateDecision("alice", { ...input, connection_id: "missing" })).rejects.toThrow("not found");
  await expect(evaluateDecision("bob", { ...input, connection_id: profile.id })).rejects.toThrow("not found");
  await svc.clearConnectionApiKey("alice", profile.id);
  await expect(evaluateDecision("alice", input)).rejects.toThrow("No readable API key");
  expect(calls).toBe(0);
});
test.each([401, 402, 429, 503])("provider HTTP %i errors are redacted before REST or worker responses", async (status) => {
  const profile = await connection();
  globalThis.fetch = (async () => Response.json({ error: { message: "bad key secret-for-test" } }, { status })) as unknown as typeof fetch;
  const res = await app().request("/decisions/evaluate", { method: "POST", body: JSON.stringify({ ...input, connection_id: profile.id }) });
  expect(res.status).toBe(502);
  expect(await res.text()).not.toContain("secret-for-test");
  const responses: any[] = [];
  const api = new WorkerHostDecisionsApi({ hasPermission: () => true, resolveEffectiveUserId: () => "alice", enforceScopedUser: () => {}, postResponse: (response) => { responses.push(response); } });
  await api.handle({ type: "decisions_evaluate", requestId: "error", input: { ...input, connection_id: profile.id } });
  expect(responses[0].error).toBeString();
  expect(responses[0].error).not.toContain("secret-for-test");
});
test("REST validates writes, reports missing connections, and reconciles key status", async () => {
  const profile = await connection();
  const api = app();
  const invalid = await api.request("/connections", { method: "POST", body: JSON.stringify({ name: "Invalid", provider: "made-up" }) });
  expect(invalid.status).toBe(400);
  for (const body of [null, { name: "Invalid", provider: "typesafe", default_parameters: null }]) {
    expect((await api.request("/connections", { method: "POST", body: JSON.stringify(body) })).status).toBe(400);
  }
  expect((await api.request("/connections", { method: "POST", body: "{" })).status).toBe(400);
  keys.clear();
  const fetched = await api.request(`/connections/${profile.id}`);
  const data: any = await fetched.json();
  expect(data.has_api_key).toBe(false); expect(data).not.toHaveProperty("user_id"); expect(data).not.toHaveProperty("api_key");
  expect((await api.request("/decisions/evaluate", { method: "POST", body: JSON.stringify({ ...input, connection_id: "missing" }) })).status).toBe(404);
});
test("REST uses the authenticated account and preserves the resolved model", async () => {
  const profile = await connection("alice", { is_default: true });
  globalThis.fetch = (async (url: any, options: any) => {
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(options.headers.Authorization).toBe("Bearer secret-for-test");
    expect(JSON.parse(options.body)).toEqual({ ...input, model: "jev-pinned-override" });
    return Response.json({ model: "jev-resolved", answers: { check: { type: "noul", noul: 0.999 } } });
  }) as unknown as typeof fetch;
  const res = await app().request("/decisions/evaluate", { method: "POST", body: JSON.stringify({ ...input, model: "jev-pinned-override", userId: "bob" }) });
  expect(res.status).toBe(200);
  expect((await res.json() as any).model).toBe("jev-resolved");
  expect(svc.getDefaultConnection("alice")?.id).toBe(profile.id);
});
test("evaluation deadlines abort provider work and return HTTP 504", async () => {
  const profile = await connection();
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => originalTimeout(10);
  globalThis.fetch = ((_url: any, options: any) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  })) as unknown as typeof fetch;
  try {
    const res = await app().request("/decisions/evaluate", { method: "POST", body: JSON.stringify({ ...input, connection_id: profile.id }) });
    expect(res.status).toBe(504);
    expect(await res.text()).toContain("timed out");
  } finally { AbortSignal.timeout = originalTimeout; }
});
test("worker bridge enforces live permission and account scope on every call", async () => {
  let allowed = false; const responses: any[] = [];
  const api = new WorkerHostDecisionsApi({ hasPermission: () => allowed, resolveEffectiveUserId: (user) => user || "alice", enforceScopedUser: (user) => { if (user !== "alice") throw new Error("Account scope denied"); }, postResponse: (response) => { responses.push(response); } });
  await api.handle({ type: "decisions_providers", requestId: "1" });
  expect(responses.pop().error).toContain("decisions");
  allowed = true; await api.handle({ type: "decisions_providers", requestId: "2" });
  expect(responses.pop().result).toHaveLength(2);
  await api.handle({ type: "decisions_connections_list", requestId: "3", userId: "bob" });
  expect(responses.pop().error).toContain("scope denied");
  allowed = false; await api.handle({ type: "decisions_connections_list", requestId: "4" });
  expect(responses.pop().error).toContain("permission not granted");
});
test.each(["cancel", "dispose"])("worker %s aborts pending inference", async (mode) => {
  const profile = await connection();
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  globalThis.fetch = ((_url: any, options: any) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }); notifyStarted();
  })) as unknown as typeof fetch;
  const responses: any[] = [];
  const api = new WorkerHostDecisionsApi({ hasPermission: () => true, resolveEffectiveUserId: () => "alice", enforceScopedUser: () => {}, postResponse: (response) => { responses.push(response); } });
  const pending = api.handle({ type: "decisions_evaluate", requestId: "pending", input: { ...input, connection_id: profile.id } });
  await started;
  if (mode === "cancel") await api.handle({ type: "decisions_cancel", requestId: "pending" }); else api.dispose();
  await pending; expect(responses[0].error).toContain("cancelled");
});
