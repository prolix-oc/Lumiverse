import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { createRequestObserver, setRequestHistoryTracking } from "../services/request-history.service";
import { requestHistoryStore } from "../services/request-history-store";
import { fetchWithPreflightAbort } from "./stream-utils";
import { PROVIDER_RESPONSE_MAX_BODY_BYTES } from "./request-observer";

const capture = () => ({ observer: createRequestObserver("alice", { kind: "chat", name: "Chat" }), provider: "custom", model: "test", credentials: ["resolved-provider-secret"] });
const latest = () => requestHistoryStore.get("alice", requestHistoryStore.list("alice")[0].id)!;
const init = { method: "POST", body: JSON.stringify({ api_key: "custom-body-secret", messages: [] }) };
let fetchSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("CREATE TABLE settings (key TEXT, value TEXT, user_id TEXT, updated_at INTEGER, PRIMARY KEY(key, user_id))");
  requestHistoryStore.clear("alice");
  setRequestHistoryTracking("alice", true);
  fetchSpy = spyOn(globalThis, "fetch");
});
afterEach(() => { fetchSpy.mockRestore(); closeDatabase(); });

test("retains the raw JSON response and status with request, transport, and response-only secrets redacted", async () => {
  const body = { choices: [{ message: { content: "resolved-provider-secret custom-body-secret response-only-secret" } }], api_key: "response-only-secret" };
  fetchSpy.mockResolvedValue(Response.json(body, { headers: { "x-test": "unchanged", "set-cookie": "never-retain-cookie" } }));
  const response = await fetchWithPreflightAbort("https://example.test", init, undefined, capture());
  expect(latest().response.state).toBe("receiving");
  expect(response.headers.get("x-test")).toBe("unchanged");
  expect(await response.json()).toEqual(body);
  expect(latest().response).toMatchObject({ status: 200, state: "complete", format: "json", redacted: true });
  expect(latest().responseBody).toContain("[REDACTED]");
  expect(JSON.stringify(latest())).not.toMatch(/resolved-provider-secret|custom-body-secret|response-only-secret|never-retain-cookie/);
  expect(requestHistoryStore.list("alice")[0]).not.toHaveProperty("responseBody");
  expect(requestHistoryStore.list("alice")[0]).not.toHaveProperty("responseError");
});

test("finalizes fragmented SSE and retains the error payload without changing the delivered stream", async () => {
  const wire = 'event: delta\r\ndata: {"choices":[{"delta":{"content":"héllo resolved-provider-secret"}}]}\r\n\r\ndata: {"api_key":\r\ndata: "response-only-secret"}\r\n\r\ndata: {"type":"error","error":{"message":"response-only-secret"}}\r\ndata: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(wire);
  let offset = 0;
  fetchSpy.mockResolvedValue(new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) controller.close();
      else controller.enqueue(bytes.slice(offset, ++offset));
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }));
  const response = await fetchWithPreflightAbort("https://example.test", init, undefined, capture());
  expect(await response.text()).toBe(wire);
  expect(latest().response).toMatchObject({ status: 200, state: "failed", format: "json", redacted: true });
  expect(JSON.parse(latest().responseBody!)).toEqual({ type: 'error', error: { message: '[REDACTED]' } });
  expect(latest().responseBody).not.toContain("data:");
  expect(latest().responseBody).not.toMatch(/resolved-provider-secret|response-only-secret/);
});

test("does not read ahead and forwards cancellation without another reader", async () => {
  let pulls = 0;
  let cancelled = false;
  fetchSpy.mockResolvedValue(new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })));
  const controller = new AbortController();
  const response = await fetchWithPreflightAbort("https://example.test", init, controller.signal, capture());
  await Promise.resolve();
  expect(pulls).toBe(0);
  const reader = response.body!.getReader();
  await reader.read();
  expect(pulls).toBe(1);
  controller.abort();
  await reader.cancel();
  expect(cancelled).toBe(true);
  expect(pulls).toBe(1);
  expect(latest().response).toMatchObject({ state: "cancelled", partial: true });
  expect(latest().responseBody).toContain("hello");
});

test("consumer cancellation after the terminal SSE event is recorded as a completed response", async () => {
  fetchSpy.mockResolvedValue(new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n'));
  const response = await fetchWithPreflightAbort("https://example.test", init, undefined, capture());
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(latest().response).toMatchObject({ state: "complete", partial: false });
});

test("bounds captured bytes without truncating the response delivered to generation", async () => {
  const wire = "x".repeat(PROVIDER_RESPONSE_MAX_BODY_BYTES + 1);
  fetchSpy.mockResolvedValue(new Response(wire));
  const response = await fetchWithPreflightAbort("https://example.test", init, undefined, capture());
  expect((await response.text()).length).toBe(wire.length);
  expect(latest().responseBody).toBeNull();
  expect(latest().response).toMatchObject({ state: "complete", bodyBytes: wire.length, bodyUnavailable: "too_large" });
});

test("network failures retain a sanitized error without inventing an HTTP response", async () => {
  const error = new Error("connection failed for resolved-provider-secret custom-body-secret");
  fetchSpy.mockRejectedValue(error);
  await expect(fetchWithPreflightAbort("https://example.test", init, undefined, capture())).rejects.toBe(error);
  expect(latest().response.state).toBe("failed");
  expect(latest().response.status).toBeUndefined();
  expect(latest().responseBody).toBeNull();
  expect(latest().responseError).toBe("connection failed for [REDACTED] [REDACTED]");
});

test("stream read failures retain a sanitized error and omit unsafe incomplete JSON", async () => {
  let reads = 0;
  const error = new Error("socket closed resolved-provider-secret");
  fetchSpy.mockResolvedValue(new Response(new ReadableStream({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode('{"api_key":"incomplete-secret'));
      else controller.error(error);
    },
  }, { highWaterMark: 0 })));
  const response = await fetchWithPreflightAbort("https://example.test", init, undefined, capture());
  await expect(response.text()).rejects.toBe(error);
  expect(latest().response).toMatchObject({ state: "failed", bodyUnavailable: "unavailable" });
  expect(latest().responseBody).toBeNull();
  expect(JSON.stringify(latest())).not.toContain("incomplete-secret");
  expect(latest().responseError).toBe("socket closed [REDACTED]");
});

for (const action of ["clear", "disable", "evict"] as const) {
  test(`a late response cannot resurrect a record after ${action}`, async () => {
    fetchSpy.mockResolvedValue(new Response('{"choices":[]}'));
    const response = await fetchWithPreflightAbort("https://example.test", init, undefined, capture());
    const id = latest().id;
    if (action === "clear") requestHistoryStore.clear("alice");
    if (action === "disable") { setRequestHistoryTracking("alice", false); setRequestHistoryTracking("alice", true); }
    if (action === "evict") for (let i = 0; i < 20; i++) capture().observer({ body: "{}", provider: "custom", model: "test", credentials: [] });
    expect(await response.json()).toEqual({ choices: [] });
    expect(requestHistoryStore.get("alice", id)).toBeNull();
    expect(requestHistoryStore.list("alice")).toHaveLength(action === "evict" ? 20 : 0);
  });
}

test("disabled capture leaves the response object and its stream untouched", async () => {
  setRequestHistoryTracking("alice", false);
  const original = new Response("original");
  fetchSpy.mockResolvedValue(original);
  const response = await fetchWithPreflightAbort("https://example.test", init, undefined, capture());
  expect(response).toBe(original);
  expect(original.body!.locked).toBe(false);
});

test("diagnostic completion failures never break the provider response", async () => {
  fetchSpy.mockResolvedValue(new Response("ok"));
  const response = await fetchWithPreflightAbort("https://example.test", init, undefined, {
    provider: "test", model: "test", observer: () => ({ isActive: () => true, headers() {}, complete() { throw new Error("recorder failed"); } }),
  });
  expect(await response.text()).toBe("ok");
});
