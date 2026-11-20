import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import * as chats from "../chats.service";
import * as connections from "../connections.service";
import * as secrets from "../secrets.service";
import * as pool from "../generation-pool.service";
import { rawGenerate, quietGenerateStream } from "./direct-generation";
import { startGeneration, startRebuildSummary, stopAllGenerations, stopGenerationSweep } from "../generate.service";
import { getRequestHistory, getRequestHistoryEntry, setRequestHistoryTracking, observeSidecarBrokerRequest } from "../request-history.service";
import { requestHistoryStore } from "../request-history-store";
import { ProviderRegistry } from "../../spindle/provider-registry";
import { WorkerHost } from "../../spindle/worker-host";
import { WorkerHostDesktopCaptureApi } from "../../spindle/worker-host-desktop-capture-api";

const userId = "request-history-test";
let secretSpy: ReturnType<typeof spyOn>;
let eventSpy: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
let connectionId: string;
const ended: any[] = [];
const reply = () => new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');

beforeAll(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../../db/baseline.sql", import.meta.url)).text());
  secretSpy = spyOn(secrets, "getSecret").mockResolvedValue("actual-provider-credential");
  eventSpy = spyOn(eventBus, "emit").mockImplementation((type, payload) => {
    if (type === EventType.GENERATION_ENDED) ended.push(payload);
  });
  connectionId = (await connections.createConnection(userId, {
    name: "Test", provider: "custom", model: "test-model", api_url: "https://example.test",
  })).id;
});
beforeEach(() => {
  requestHistoryStore.clear(userId);
  setRequestHistoryTracking(userId, true);
});
afterEach(async () => { await Bun.sleep(5); fetchSpy?.mockRestore(); });
afterAll(() => {
  stopAllGenerations(); stopGenerationSweep(); pool.stopPoolSweep(); pool.clearAllPoolEntries();
  secretSpy.mockRestore(); eventSpy.mockRestore(); closeDatabase();
});

test("raw generation uses trusted origin options and preserves the provider's credential while redacting history", async () => {
  const sent: any[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  }) as unknown as typeof fetch);
  await rawGenerate(userId, {
    provider: "custom", model: "test-model", connection_id: connectionId,
    messages: [{ role: "user", content: "actual-provider-credential" }],
    parameters: { api_key: "actual-provider-credential" },
    ...{ origin: { kind: "extension", name: "forged" }, onProviderRequest: "forged" },
  }, { origin: { kind: "sidecar", name: "Weaver", operation: "review" } });
  expect(sent[0].headers.get("authorization")).toBe("Bearer actual-provider-credential");
  expect(sent[0].body.api_key).toBe("actual-provider-credential");
  const summary = getRequestHistory(userId).entries[0];
  const entry = getRequestHistoryEntry(userId, summary.id)!;
  expect(entry.origin).toMatchObject({ kind: "sidecar", name: "Weaver", operation: "review" });
  expect(JSON.stringify(entry)).not.toContain("actual-provider-credential");
  expect(entry.bodyJson).not.toContain("forged");
  expect(entry.response).toMatchObject({ status: 200, state: "complete", format: "json" });
  expect(JSON.parse(entry.responseBody!).choices[0].message.content).toBe("ok");
});

test("quiet streams retain attribution when consumed outside their creation context", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => reply()) as unknown as typeof fetch);
  const stream = await quietGenerateStream(userId, {
    connection_id: connectionId, messages: [{ role: "user", content: "Hello" }],
  }, { origin: { kind: "extension", name: "Example", extensionId: "installation-1", operation: "quiet stream" }, generationId: "extension-request" });
  expect(getRequestHistory(userId).entries).toHaveLength(0);
  for await (const _chunk of stream) { /* Consume the deferred send. */ }
  expect(getRequestHistory(userId).entries[0]).toMatchObject({
    origin: { name: "Example", extensionId: "installation-1", operation: "quiet stream" }, generationId: "extension-request", connectionId,
  });
  expect(getRequestHistory(userId).entries[0].response).toMatchObject({ state: "complete", format: "json" });
  const entry = getRequestHistoryEntry(userId, getRequestHistory(userId).entries[0].id)!;
  expect(JSON.parse(entry.responseBody!).choices[0].message.content).toBe("Hello");
  expect(entry.responseBody).not.toContain("data:");
});

test("Spindle generation records the host's extension identity instead of input claims", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] })) as unknown as typeof fetch);
  const posted: any[] = [];
  const host = Object.assign(Object.create(WorkerHost.prototype), {
    manifest: { name: "Trusted extension", identifier: "trusted-extension" },
    extensionId: "installation-1",
    generationAbortControllers: new Map(),
    captureGenerationRequests: new Set(),
    hasPermission: () => true,
    resolveEffectiveUserId: () => userId,
    enforceScopedUser: () => {},
    postToWorker: (message: unknown) => posted.push(message),
  });
  host.desktopCaptureApi = new WorkerHostDesktopCaptureApi({
    extensionId: host.extensionId,
    identifier: host.manifest.identifier,
    name: host.manifest.name,
    declaredPermissions: ["generation"],
    hasPermission: host.hasPermission,
    authorize: () => () => true,
    resolveEffectiveUserId: host.resolveEffectiveUserId,
    enforceScopedUser: host.enforceScopedUser,
    postResponse: host.postToWorker,
  });
  await host.handleGeneration("worker-request", {
    type: "quiet", userId: "untrusted-user", connection_id: connectionId,
    messages: [{ role: "user", content: "hello" }],
    origin: { kind: "extension", name: "forged", extensionId: "forged" },
  });
  expect(posted[0].error).toBeUndefined();
  expect(host.generationAbortControllers.size).toBe(0);
  expect(host.captureGenerationRequests.size).toBe(0);
  expect(getRequestHistory(userId).entries[0]).toMatchObject({
    generationId: "worker-request", origin: { kind: "extension", name: "Trusted extension", extensionId: "installation-1", operation: "quiet" },
  });
  expect(requestHistoryStore.list("untrusted-user")).toEqual([]);
});

for (const status of [429, 503]) {
  for (const streaming of [true, false]) {
    test(`${streaming ? "streaming" : "non-streaming"} chat sends once on HTTP ${status} and retains the failure response`, async () => {
      const body = { error: { code: `http_${status}`, message: "Provider unavailable" } };
      let count = 0;
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
        if (count++ === 0) return Response.json(body, { status, headers: { "retry-after": "0" } });
        // A recovering provider must not cause the failed chat to be retried silently.
        return streaming ? reply() : Response.json({ choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] });
      }) as unknown as typeof fetch);
      const chat = chats.createChat(userId, { character_id: null, name: "Test", metadata: { temporary: true, no_preset: true } });
      chats.createMessage(chat.id, { is_user: true, name: "User", content: "Hello" }, userId);
      const result = await startGeneration({ userId, chat_id: chat.id, connection_id: connectionId, parameters: { _streaming: streaming } }, {
        requestOrigin: { kind: "extension", name: "Example", extensionId: "installation-1", operation: "chat append" },
      });
      const deadline = Date.now() + 3000;
      while (!ended.some((entry) => entry.generationId === result.generationId) && Date.now() < deadline) await Bun.sleep(5);
      const events = ended.filter((entry) => entry.generationId === result.generationId);
      expect(events).toHaveLength(1);
      expect(events[0].error).toContain("Provider unavailable");
      expect(events[0].errorCode).toBe(`http_${status}`);
      expect(pool.getPoolEntry(result.generationId)?.status).toBe("error");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const rows = getRequestHistory(userId).entries;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        generationId: result.generationId, chatId: chat.id, connectionId,
        origin: { name: "Example", extensionId: "installation-1", operation: "chat append" },
        response: { status, state: "failed", format: "json" },
      });
      const entry = getRequestHistoryEntry(userId, rows[0].id)!;
      expect(JSON.parse(entry.bodyJson!).stream).toBe(streaming);
      expect(JSON.parse(entry.responseBody!)).toEqual(body);
    });
  }
}

test("Loom rebuild failures send once and keep the existing summary", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ error: { message: "Unavailable" } }, { status: 503 })) as unknown as typeof fetch);
  const chat = chats.createChat(userId, { character_id: null, name: "Rebuild", metadata: { temporary: true, no_preset: true, loom_summary: "Saved summary" } });
  chats.createMessage(chat.id, { is_user: true, name: "User", content: "Hello" }, userId);
  await startRebuildSummary(userId, { chat_id: chat.id, batch_size: 20, userName: "User", connection_id: connectionId });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(chats.getChat(userId, chat.id)?.metadata.loom_summary).toBe("Saved summary");
  const rows = getRequestHistory(userId).entries;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ origin: { name: "Loom Summary" }, response: { status: 503, state: "failed" } });
});

test("sidecar broker sends are attributed and sanitized; embedding and system sends are excluded", async () => {
  const sent: string[] = [];
  const registry = new ProviderRegistry({
    observeRequest: observeSidecarBrokerRequest,
    getSecret: async () => "broker-provider-credential",
    fetch: async (_url, init) => {
      sent.push(String(init?.body));
      return Response.json({ ok: true });
    },
  });
  for (const [kind, scope] of [["sidecar", "user"], ["embedding", "user"], ["sidecar", "system"]] as const) {
    const prepared = registry.prepareBroker({
      kind, providerId: "custom-sidecar", url: "https://example.test", secretKey: "extension:installation-1:api-key",
      correlationId: "broker-request", body: { model: "test", prompt: "broker-provider-credential" },
    }, { installationId: "installation-1", installScope: scope, ...(scope === "user" ? { authenticatedSubject: userId } : {}) });
    expect((await registry.completeBroker(prepared)).ok).toBe(true);
  }
  expect(sent).toHaveLength(3);
  expect(sent[0]).toContain("broker-provider-credential");
  const rows = getRequestHistory(userId).entries;
  expect(rows).toHaveLength(1);
  expect(rows[0].origin).toMatchObject({ kind: "extension", extensionId: "installation-1", operation: "broker" });
  expect(getRequestHistoryEntry(userId, rows[0].id)!.bodyJson).not.toContain("broker-provider-credential");
  expect(rows[0].response).toMatchObject({ status: 200, state: "complete" });
  expect(JSON.parse(getRequestHistoryEntry(userId, rows[0].id)!.responseBody!)).toEqual({ ok: true });
});
