import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { requestHistoryRoutes } from "./request-history.routes";
import { createRequestObserver } from "../services/request-history.service";
import { deleteSetting, putMany } from "../services/settings.service";
import { REQUEST_HISTORY_SETTING, requestHistoryStore } from "../services/request-history-store";
import { fetchWithPreflightAbort } from "../llm/stream-utils";
import { spyOn } from "bun:test";

const app = new Hono();
app.use("*", async (c, next) => {
  // Stand-in for requireAuth; route bodies and query parameters cannot change this identity.
  const userId = c.req.header("test-user") ?? "alice";
  c.set("userId", userId);
  c.set("session", {
    user: { id: userId, name: userId, email: `${userId}@example.test`, role: c.req.header("test-role") ?? "user" },
    session: { id: "session-1", userId, token: "session-token", expiresAt: new Date(Date.now() + 60_000), impersonatedBy: c.req.header("test-impersonated-by") },
  });
  await next();
});
app.route("/", requestHistoryRoutes);
const record = (userId = "alice") => {
  const observer = createRequestObserver(userId, { kind: "sidecar", name: "Memory Cortex" })({
    body: '{"messages":[{"role":"user","content":"hello"}]}', provider: "custom", model: "test", credentials: [],
  });
  observer?.headers(200);
  observer?.complete({ body: JSON.stringify({ response: `private to ${userId}` }), bodyBytes: 40, outcome: "complete" });
};
const toggle = (enabled: unknown, user = "alice") => app.request("/tracking", {
  method: "PUT", headers: { "content-type": "application/json", "test-user": user }, body: JSON.stringify({ enabled, userId: "bob" }),
});

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("CREATE TABLE settings (key TEXT, value TEXT, user_id TEXT, updated_at INTEGER, PRIMARY KEY(key, user_id))");
  requestHistoryStore.clear("alice");
  requestHistoryStore.clear("bob");
});
afterEach(() => closeDatabase());

test("defaults off, validates the toggle, and never accepts a supplied user identity", async () => {
  record();
  const response = await app.request("/");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ enabled: false, limit: 20, entries: [] });
  expect((await toggle("true")).status).toBe(400);
  await toggle(true);
  record();
  record("bob");
  const alice = await (await app.request("/")).json() as any;
  expect(alice.entries).toHaveLength(1);
  expect(alice.entries[0]).not.toHaveProperty("bodyJson");
  expect(alice.entries[0]).not.toHaveProperty("responseBody");
  const id = alice.entries[0].id;
  expect((await app.request(`/${id}`, { headers: { "test-user": "bob" } })).status).toBe(404);
  expect((await app.request(`/${id}?userId=bob`)).status).toBe(200);
  expect((await app.request(`/${id}`)).headers.get("cache-control")).toBe("no-store");
});

test("disable, clear, and generic settings writes remove retained bodies immediately", async () => {
  await toggle(true);
  record();
  const id = requestHistoryStore.list("alice")[0].id;
  await toggle(false);
  expect(requestHistoryStore.get("alice", id)).toBeNull();
  expect((await app.request(`/${id}`)).status).toBe(404);
  await toggle(true);
  record();
  const cleared = await (await app.request("/", { method: "DELETE" })).json() as any;
  expect(cleared).toEqual({ enabled: true, limit: 20, entries: [] });
  record();
  putMany("alice", { [REQUEST_HISTORY_SETTING]: false });
  expect(requestHistoryStore.list("alice")).toEqual([]);
  await toggle(true);
  record();
  deleteSetting("alice", REQUEST_HISTORY_SETTING);
  expect(requestHistoryStore.list("alice")).toEqual([]);
});

for (const role of ["admin", "owner"]) {
  test(`${role} accounts cannot list, read, clear, or disable another user's history`, async () => {
    await toggle(true, "alice");
    await toggle(true, "bob");
    record("alice");
    record("bob");
    const aliceId = requestHistoryStore.list("alice")[0].id;
    const bobId = requestHistoryStore.list("bob")[0].id;
    const headers = { "test-user": "bob", "test-role": role, "content-type": "application/json" };
    const listed = await (await app.request("/?userId=alice", { headers })).json() as any;
    expect(listed.entries.map((entry: any) => entry.id)).toEqual([bobId]);
    expect(JSON.stringify(listed)).not.toContain("private to alice");
    expect((await app.request(`/${aliceId}?userId=alice`, { headers })).status).toBe(404);
    await app.request("/?userId=alice", { method: "DELETE", headers });
    expect(requestHistoryStore.list("bob")).toEqual([]);
    expect(requestHistoryStore.get("alice", aliceId)).not.toBeNull();
    await app.request("/tracking?userId=alice", { method: "PUT", headers, body: JSON.stringify({ enabled: false, userId: "alice" }) });
    const alice = await (await app.request("/", { headers: { "test-user": "alice" } })).json() as any;
    expect(alice.enabled).toBe(true);
    expect(alice.entries.map((entry: any) => entry.id)).toEqual([aliceId]);
  });
}

test("impersonating another account does not grant access to its history", async () => {
  await toggle(true);
  record();
  const id = requestHistoryStore.list("alice")[0].id;
  const headers = { "test-user": "alice", "test-impersonated-by": "operator", "content-type": "application/json" };
  for (const [path, method] of [["/", "GET"], [`/${id}`, "GET"], ["/", "DELETE"], ["/tracking", "PUT"]]) {
    const response = await app.request(path, { method, headers, ...(method === "PUT" ? { body: JSON.stringify({ enabled: false }) } : {}) });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("hello");
  }
  expect(requestHistoryStore.get("alice", id)).not.toBeNull();
  expect((await (await app.request("/")).json() as any).enabled).toBe(true);
});

test("checks enabled at dispatch, captures failed sends, skips pre-aborted sends, and tolerates recorder errors", async () => {
  const observer = createRequestObserver("alice", { kind: "extension", name: "Example", extensionId: "installation-1" });
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream failed", { status: 503 }));
  const capture = { observer, provider: "custom", model: "test" };
  const init = { method: "POST", body: '{"model":"test"}' };
  try {
    await toggle(true);
    await fetchWithPreflightAbort("https://example.test", init, undefined, capture);
    expect(requestHistoryStore.list("alice")).toHaveLength(1);
    await expect(fetchWithPreflightAbort("https://example.test", init, AbortSignal.abort(), capture)).rejects.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await toggle(false);
    await fetchWithPreflightAbort("https://example.test", init, undefined, capture);
    expect(requestHistoryStore.list("alice")).toHaveLength(0);
    await fetchWithPreflightAbort("https://example.test", init, undefined, { ...capture, observer: () => { throw new Error("failure"); } });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  } finally { fetchSpy.mockRestore(); }
});
