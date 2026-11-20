import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { upgradeWebSocket } from "@hono/bun";
import type { ServerWebSocket } from "bun";
import { queuedWebSocketEvents } from "./receive-queue";
import { websocket } from "./transport";
import { eventBus } from "./bus";
import { EventType } from "./events";

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for WebSocket progress");
    await Bun.sleep(2);
  }
}
function client(url: string) {
  const ws = new WebSocket(url);
  const messages: any[] = [];
  ws.addEventListener("message", event => messages.push(JSON.parse(String(event.data))));
  // Failures are asserted through state/messages, rather than becoming uncaught errors.
  ws.addEventListener("error", () => {});
  return { ws, messages };
}

test("the native error callback closes the socket whose handler threw", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const app = new Hono().get("/ws", upgradeWebSocket(context => ({
    onMessage(_event, ws) {
      if (context.req.query("id") === "failing") throw new Error("native callback failure");
      ws.send(JSON.stringify({ ok: true }));
    },
  })));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket });
  const origin = `ws://127.0.0.1:${server.port}/ws?id=`;
  const c = client(origin + "failing"), healthy = client(origin + "healthy");
  let closeCode = 0;
  c.ws.addEventListener("close", event => { closeCode = event.code; });
  try {
    await until(() => c.ws.readyState === WebSocket.OPEN && healthy.ws.readyState === WebSocket.OPEN);
    c.ws.send("throw");
    await until(() => closeCode !== 0);
    expect(closeCode).toBe(1011);
    expect(log).toHaveBeenCalledTimes(1);
    healthy.ws.send("ping");
    await until(() => healthy.messages.length === 1);
    expect(healthy.messages).toEqual([{ ok: true }]);
    expect(healthy.ws.readyState).toBe(WebSocket.OPEN);
  } finally { server.stop(true); log.mockRestore(); }
});

test("real receive pauses drain in order while a separate heartbeat stays responsive", async () => {
  const blocked = Promise.withResolvers<void>();
  const raw = new Map<string, ServerWebSocket<unknown>>();
  let started = false;
  const app = new Hono().get("/ws", upgradeWebSocket(c => queuedWebSocketEvents({
    onOpen(_event, ws) { raw.set(c.req.query("id")!, ws.raw!); },
    async onMessage(event, ws) {
      const data = JSON.parse(event.data);
      if (data.type === "bulk" && data.id === 1) { started = true; await blocked.promise; }
      ws.send(JSON.stringify(data));
    },
  }, { highMessages: 2, lowMessages: 0, maxMessages: 16 })));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket });
  const origin = `ws://127.0.0.1:${server.port}/ws`;
  const main = client(origin + "?id=main"), heartbeat = client(origin + "?id=heartbeat");
  try {
    await until(() => raw.size === 2 && main.ws.readyState === WebSocket.OPEN && heartbeat.ws.readyState === WebSocket.OPEN);
    main.ws.send(JSON.stringify({ type: "bulk", id: 1 }));
    await until(() => started);
    main.ws.send(JSON.stringify({ type: "bulk", id: 2 }));
    await until(() => raw.get("main")!.isPaused);
    heartbeat.ws.send(JSON.stringify({ type: "ping", id: "live" }));
    await until(() => heartbeat.messages.some(value => value.id === "live"));
    expect(main.messages).toEqual([]);
    blocked.resolve();
    await until(() => main.messages.length === 2);
    expect(main.messages.map(value => value.id)).toEqual([1, 2]);
    expect(raw.get("main")!.isPaused).toBe(false);
  } finally {
    blocked.resolve();
    server.stop(true);
  }
});

test("native stream pub/sub evicts a slow subscriber without losing fast-client deltas or terminal events", async () => {
  const raw = new Map<string, ServerWebSocket<unknown>>();
  const closed = new Set<string>();
  const app = new Hono().get("/ws", upgradeWebSocket(c => queuedWebSocketEvents({
    onOpen(_event, ws) {
      const id = c.req.query("id")!;
      raw.set(id, ws.raw!);
      const user = id === "other-user" ? "other" : "owner";
      eventBus.addClient(ws.raw!, user);
      eventBus.setClientStreamFocus(ws.raw!, user, id === "other-chat" ? "other-chat" : "chat");
    },
    onClose(_event, ws) {
      for (const [id, socket] of raw) if (socket === ws.raw) closed.add(id);
      eventBus.removeClient(ws.raw!);
    },
  })));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch,
    websocket: { ...websocket, backpressureLimit: 64 * 1024 } });
  eventBus.setServer(server as import("bun").Server<unknown>, 64 * 1024);
  const origin = `ws://127.0.0.1:${server.port}/ws?id=`;
  const fast = client(origin + "fast"), slow = client(origin + "slow");
  const otherChat = client(origin + "other-chat"), otherUser = client(origin + "other-user");
  const token = "x".repeat(16 * 1024);
  let emitted = 0;
  function emitSegment() {
    eventBus.emit(EventType.STREAM_TOKEN_RECEIVED, {
      generationId: "generation", chatId: "chat", token, seq: emitted, startSeq: emitted,
      ...(emitted % 2 ? { type: "reasoning" } : {}),
      offset: Math.floor(emitted / 2) * token.length,
    }, "owner", { topic: "stream:owner:chat" });
    emitted++;
  }
  try {
    await until(() => raw.size === 4 && [fast, slow, otherChat, otherUser].every(({ ws }) => ws.readyState === WebSocket.OPEN));
    expect((slow.ws as WebSocket & { pause(): boolean }).pause()).toBe(true);
    while (emitted < 1024 && !closed.has("slow")) {
      emitSegment();
      // Let the fast subscriber drain; never wait for the stalled subscriber.
      await Bun.sleep(1);
    }
    await until(() => closed.has("slow"));
    // Generation continues after eviction, including both stream types.
    for (let index = 0; index < 4; index++) { emitSegment(); await Bun.sleep(1); }
    eventBus.emit(EventType.GENERATION_ENDED, { generationId: "generation", chatId: "chat" }, "owner");
    await until(() => fast.messages.some(value => value.event === EventType.GENERATION_ENDED));
    const segments = fast.messages.filter(value => value.event === EventType.STREAM_TOKEN_RECEIVED);
    expect(segments).toHaveLength(emitted);
    for (let index = 0; index < segments.length; index++) {
      expect(segments[index].payload.seq).toBe(index);
      expect(segments[index].payload.startSeq).toBe(index);
      expect(segments[index].payload.type).toBe(index % 2 ? "reasoning" : undefined);
      expect(segments[index].payload.offset).toBe(Math.floor(index / 2) * token.length);
      expect(segments[index].payload.token).toBe(token);
    }
    expect(fast.ws.readyState).toBe(WebSocket.OPEN);
    expect(closed.has("fast")).toBe(false);
    expect(fast.messages.at(-1).event).toBe(EventType.GENERATION_ENDED);
    expect(otherChat.messages.some(value => value.event === EventType.STREAM_TOKEN_RECEIVED)).toBe(false);
    expect(otherUser.messages).toEqual([]);
  } finally {
    (slow.ws as WebSocket & { resume(): boolean }).resume();
    server.stop(true);
    eventBus.stopSweep();
  }
}, 10_000);
