import { describe, expect, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { WSContext } from "hono/ws";
import { queuedWebSocketEvents } from "./receive-queue";

const turn = () => Bun.sleep(0);
const gate = () => Promise.withResolvers<void>();
function connection() {
  const calls: string[] = [];
  const closes: Array<[number | undefined, string | undefined]> = [];
  const raw = {
    readyState: 1, isPaused: false,
    pause() { calls.push("pause"); this.isPaused = true; },
    resume() { calls.push("resume"); this.isPaused = false; },
  };
  const ws = { raw, close(code?: number, reason?: string) { closes.push([code, reason]); raw.readyState = 3; } } as unknown as WSContext<ServerWebSocket<unknown>>;
  return { ws, raw, calls, closes };
}
function message(value: unknown) { return new MessageEvent("message", { data: JSON.stringify(value) }); }
const limits = { highMessages: 2, lowMessages: 0, maxMessages: 4 };

describe("WebSocket receive queue", () => {
  test("waits for authentication, serializes application messages and resumes after draining", async () => {
    const auth = gate(), first = gate();
    const c = connection();
    const received: number[] = [];
    const events = queuedWebSocketEvents({
      onOpen: () => auth.promise,
      async onMessage(event) { received.push(JSON.parse(event.data).id); if (received.length === 1) await first.promise; },
    }, limits);
    events.onOpen!(new Event("open"), c.ws);
    events.onMessage!(message({ id: 1 }), c.ws);
    events.onMessage!(message({ id: 2 }), c.ws);
    expect(received).toEqual([]);
    expect(c.calls).toEqual(["pause"]);
    auth.resolve(); await turn();
    expect(received).toEqual([1]);
    first.resolve(); await turn();
    expect(received).toEqual([1, 2]);
    expect(c.calls).toEqual(["pause", "resume"]);
    events.onClose!(new CloseEvent("close"), c.ws);
  });

  test("processes already-read control replies while bulk work is waiting", async () => {
    const pending = gate();
    const c = connection();
    const types: string[] = [];
    const events = queuedWebSocketEvents({
      async onMessage(event) {
        const { type } = JSON.parse(event.data); types.push(type);
        if (type === "bulk") await pending.promise;
      },
    }, limits);
    events.onOpen!(new Event("open"), c.ws); await turn();
    for (const type of ["bulk", "queued", "ping", "SPINDLE_CONFIRM_RESULT"]) events.onMessage!(message({ type }), c.ws);
    await turn();
    expect(types).toEqual(["bulk", "ping", "SPINDLE_CONFIRM_RESULT"]);
    pending.resolve(); await turn();
    expect(types).toEqual(["bulk", "ping", "SPINDLE_CONFIRM_RESULT", "queued"]);
    expect(c.calls).toEqual(["pause", "resume"]);
    events.onClose!(new CloseEvent("close"), c.ws);
  });

  test("caps messages already decoded after pause and discards queued work on overload", async () => {
    const pending = gate();
    const c = connection();
    let ran = 0;
    const events = queuedWebSocketEvents({ async onMessage() { ran++; await pending.promise; } }, limits);
    events.onOpen!(new Event("open"), c.ws); await turn();
    for (let id = 0; id < 5; id++) events.onMessage!(message({ id }), c.ws);
    expect(c.closes[0]?.[0]).toBe(1013);
    expect(c.raw.isPaused).toBe(false);
    pending.resolve(); await turn();
    expect(ran).toBe(1);
    events.onClose!(new CloseEvent("close"), c.ws);
  });

  test("counts UTF-8 bytes, not characters", async () => {
    const pending = gate();
    const c = connection();
    const events = queuedWebSocketEvents({ onMessage: () => pending.promise }, {
      highBytes: 8, lowBytes: 0, maxBytes: 11,
    });
    events.onOpen!(new Event("open"), c.ws); await turn();
    events.onMessage!(message("😀😀"), c.ws); // 10 UTF-8 bytes including JSON quotes
    expect(c.calls).toEqual(["pause"]);
    events.onMessage!(message(1), c.ws);
    expect(c.closes).toEqual([]);
    events.onMessage!(message(2), c.ws);
    expect(c.closes[0]?.[0]).toBe(1013);
    pending.resolve(); await turn();
  });

  test("close releases retained messages and prevents work after late authentication", async () => {
    const auth = gate();
    const c = connection();
    let ran = 0;
    const events = queuedWebSocketEvents({ onOpen: () => auth.promise, onMessage() { ran++; } }, limits);
    events.onOpen!(new Event("open"), c.ws);
    events.onMessage!(message(1), c.ws);
    events.onMessage!(message(2), c.ws);
    events.onClose!(new CloseEvent("close"), c.ws);
    auth.resolve(); await turn();
    expect(ran).toBe(0);
    expect(c.calls).toEqual(["pause", "resume"]);
  });

  test("does not resume a pause owned by another subsystem", async () => {
    const c = connection(); c.raw.isPaused = true;
    const auth = gate();
    const events = queuedWebSocketEvents({ onOpen: () => auth.promise }, limits);
    events.onOpen!(new Event("open"), c.ws);
    events.onMessage!(message(1), c.ws);
    events.onMessage!(message(2), c.ws);
    events.onClose!(new CloseEvent("close"), c.ws);
    auth.resolve(); await turn();
    expect(c.calls).toEqual([]);
    expect(c.raw.isPaused).toBe(true);
  });

  test("closes a stalled receive queue without relying on Bun's suspended idle timeout", async () => {
    const pending = gate();
    const c = connection();
    const events = queuedWebSocketEvents({ onMessage: () => pending.promise }, { ...limits, maxPauseMs: 15 });
    events.onOpen!(new Event("open"), c.ws); await turn();
    events.onMessage!(message(1), c.ws);
    events.onMessage!(message(2), c.ws);
    await Bun.sleep(40);
    expect(c.closes[0]?.[0]).toBe(1013);
    expect(c.calls).toEqual(["pause", "resume"]);
    pending.resolve(); await turn();
  });

  test("authentication has a deadline even when no messages arrive", async () => {
    const auth = gate(), c = connection();
    const events = queuedWebSocketEvents({ onOpen: () => auth.promise }, { maxPauseMs: 15 });
    events.onOpen!(new Event("open"), c.ws);
    await Bun.sleep(40);
    expect(c.closes).toEqual([[1013, "WebSocket authentication timed out"]]);
    auth.resolve(); await turn();
  });

  test("observes rejected async handlers and closes the connection", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    const c = connection();
    const events = queuedWebSocketEvents({ async onMessage() { throw new Error("failed async work"); } });
    try {
      events.onOpen!(new Event("open"), c.ws); await turn();
      events.onMessage!(message({ type: "bulk" }), c.ws); await turn();
      expect(c.closes).toEqual([[1011, "WebSocket handler failed"]]);
      expect(log).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });
});
