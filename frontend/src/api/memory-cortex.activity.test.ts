import { afterEach, expect, mock, test } from "bun:test";
const originalWindow = globalThis.window;
let resolvePost!: (value: unknown) => void;
let rejectPost!: (error: Error) => void;
const post = mock((_path: string, _body?: unknown) => new Promise((resolve, reject) => { resolvePost = resolve; rejectPost = reject; }));
mock.module("./client", () => ({ get: async () => ({}), put: async () => ({}), post, del: async () => ({}), patch: async () => ({}) }));
const { memoryCortexApi, CORTEX_REQUEST_EVENT } = await import("./memory-cortex");
afterEach(() => { globalThis.window = originalWindow; });

function collectEvents() {
  const target = new EventTarget();
  globalThis.window = target as unknown as Window & typeof globalThis;
  const events: any[] = [];
  target.addEventListener(CORTEX_REQUEST_EVENT, (event) => events.push((event as CustomEvent).detail));
  return events;
}

test("a rebuild announces user initiation before the API responds and carries the accepted snapshot", async () => {
  const events = collectEvents();
  const pending = memoryCortexApi.rebuild("chat-1");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ chatId: "chat-1", status: "requested" });
  expect(events[0].requestedAt).toBeGreaterThan(0);
  expect(post.mock.calls.at(-1)?.[1]).toEqual({ requestId: events[0].id, initiatedAt: events[0].requestedAt });
  const activity = { chatId: "chat-1", revision: 1, runs: [] };
  resolvePost({ status: "started", chatId: "chat-1", activity });
  await pending;
  expect(events[1]).toMatchObject({ status: "started", id: events[0].id, activity });
});

test("a refused or failed rebuild clears the initiating notice", async () => {
  const events = collectEvents();
  const skipped = memoryCortexApi.rebuild("chat-1");
  resolvePost({ status: "skipped", chatId: "chat-1" });
  await skipped;
  expect(events.at(-1).status).toBe("skipped");
  const pending = memoryCortexApi.rebuild("chat-1");
  rejectPost(new Error("Network unavailable"));
  await expect(pending).rejects.toThrow("Network unavailable");
  expect(events.at(-1).status).toBe("error");
});

test("manual recompilation announces the click and clears its notice when only LTM runs", async () => {
  const events = collectEvents();
  const pending = memoryCortexApi.warm("chat-1", { force: true });
  expect(events[0]).toMatchObject({ chatId: "chat-1", status: "requested" });
  expect(post.mock.calls.at(-1)?.[1]).toEqual({ force: true, requestId: events[0].id, initiatedAt: events[0].requestedAt });
  resolvePost({ status: "complete", cortex: { status: "skipped" }, chatMemory: { status: "complete" } });
  await pending;
  expect(events.at(-1).status).toBe("skipped");
});

test("manual Cortex actions work on HTTP origins without the native UUID API", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
  try {
    const events = collectEvents();
    const rebuild = memoryCortexApi.rebuild("chat-1");
    resolvePost({ status: "started", chatId: "chat-1" });
    await rebuild;
    const warm = memoryCortexApi.warm("chat-1", { force: true });
    resolvePost({ status: "complete", cortex: { status: "complete" } });
    await warm;
    const requested = events.filter((event) => event.status === "requested");
    expect(requested).toHaveLength(2);
    expect(new Set(requested.map((event) => event.id)).size).toBe(2);
    for (const event of requested) {
      expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  } finally {
    if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
    else Reflect.deleteProperty(crypto, "randomUUID");
  }
});

test("passive warmup does not synthesize a user request or a Cortex notice", async () => {
  const events = collectEvents();
  const pending = memoryCortexApi.warm("chat-1");
  expect(events).toEqual([]);
  expect(post.mock.calls.at(-1)?.[1]).toEqual({});
  resolvePost({ status: "skipped", cortex: { status: "skipped" } });
  await pending;
  expect(events).toEqual([]);
});
