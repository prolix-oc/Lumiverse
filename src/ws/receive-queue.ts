import type { ServerWebSocket } from "bun";
import type { WSContext, WSEvents } from "hono/ws";

type Socket = WSContext<ServerWebSocket<unknown>>;
type Handlers = {
  onOpen?: (event: Event, ws: Socket) => void | Promise<void>;
  onMessage?: (event: MessageEvent, ws: Socket) => void | Promise<void>;
  onClose?: (event: CloseEvent, ws: Socket) => void;
};

export interface ReceiveQueueLimits {
  highMessages: number;
  lowMessages: number;
  maxMessages: number;
  highBytes: number;
  lowBytes: number;
  maxBytes: number;
  maxPauseMs: number;
}

const DEFAULT_LIMITS: ReceiveQueueLimits = {
  highMessages: 16, lowMessages: 4, maxMessages: 64,
  highBytes: 2 * 1024 * 1024, lowBytes: 512 * 1024, maxBytes: 8 * 1024 * 1024,
  maxPauseMs: 10_000,
};

// These handlers finish without waiting for extension work. Keep interactive
// replies and liveness responsive while application messages are queued.
const CONTROL_TYPES = new Set([
  "ping", "visibility", "stream_focus", "SPINDLE_TEXT_EDITOR_RESULT",
  "SPINDLE_CONFIRM_RESULT", "SPINDLE_MODAL_RESULT", "SPINDLE_INPUT_PROMPT_RESULT",
]);

/** One instance per connection. Hono does not await its async WS callbacks.
 * Counts handler lifetimes; fire-and-forget worker posts need their own
 * acknowledgements to bound the worker's mailbox. */
export function queuedWebSocketEvents(handlers: Handlers, overrides: Partial<ReceiveQueueLimits> = {}): WSEvents<ServerWebSocket<unknown>> {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [low, high, max] of [
    [limits.lowMessages, limits.highMessages, limits.maxMessages],
    [limits.lowBytes, limits.highBytes, limits.maxBytes],
  ]) {
    if (!(0 <= low && low < high && high <= max)) throw new RangeError("Invalid WebSocket receive queue limits");
  }
  if (!(limits.maxPauseMs > 0)) throw new RangeError("Invalid WebSocket pause deadline");

  let closed = false;
  let opened = false;
  let running = false;
  let pending = 0;
  let bytes = 0;
  let paused = false;
  let socket: Socket | undefined;
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: Array<{ event: MessageEvent; ws: Socket; bytes: number }> = [];

  function dispose(): void {
    closed = true;
    queue.length = 0;
    pending = 0;
    bytes = 0;
    clearTimeout(openTimer);
    clearTimeout(pauseTimer);
    // A peer may already have closed its native socket by this point.
    if (paused) { try { socket?.raw?.resume(); } catch { /* already closed */ } }
    paused = false;
  }

  function close(code: number, reason: string): void {
    dispose();
    socket?.close(code, reason);
  }

  function fail(error: unknown): void {
    if (closed) return;
    console.error("[WS] handler failed:", error);
    close(1011, "WebSocket handler failed");
  }

  function updatePressure(): void {
    const raw = socket?.raw;
    if (closed || !raw || raw.readyState !== 1) return;
    if (!paused && (pending >= limits.highMessages || bytes >= limits.highBytes)) {
      // Server pause() returns void; use isPaused to respect another owner.
      if (raw.isPaused) return;
      raw.pause();
      paused = true;
      pauseTimer = setTimeout(() => close(1013, "WebSocket receive queue stalled"), limits.maxPauseMs);
    } else if (paused && pending <= limits.lowMessages && bytes <= limits.lowBytes) {
      raw.resume();
      paused = false;
      clearTimeout(pauseTimer);
    }
  }

  async function run(item: typeof queue[number]): Promise<void> {
    try {
      if (!closed && item.ws.raw?.readyState === 1) await handlers.onMessage?.(item.event, item.ws);
    } catch (error) {
      fail(error);
    } finally {
      if (!closed) {
        pending--;
        bytes -= item.bytes;
        updatePressure();
      }
    }
  }

  async function pump(): Promise<void> {
    if (closed || !opened || running) return;
    running = true;
    try {
      while (!closed && queue.length) await run(queue.shift()!);
    } finally {
      running = false;
    }
  }

  return {
    onOpen(event, ws) {
      socket = ws;
      openTimer = setTimeout(() => close(1013, "WebSocket authentication timed out"), limits.maxPauseMs);
      void (async () => {
        try {
          await handlers.onOpen?.(event, ws);
          if (closed) return;
          opened = true;
          clearTimeout(openTimer);
          await pump();
        } catch (error) { fail(error); }
      })();
    },
    onMessage(event, ws) {
      if (closed) return;
      socket = ws;
      // The application protocol is JSON text. Reject binary frames before
      // retaining them or trying to interpret an ArrayBuffer as a string.
      if (typeof event.data !== "string") { close(1003, "Expected a text message"); return; }
      const size = Buffer.byteLength(event.data);
      if (pending + 1 > limits.maxMessages || bytes + size > limits.maxBytes) {
        close(1013, "WebSocket receive queue full");
        return;
      }
      pending++;
      bytes += size;
      const item = { event, ws, bytes: size };
      let control = false;
      if (opened && size <= 64 * 1024) {
        try { control = CONTROL_TYPES.has(JSON.parse(event.data)?.type); } catch { /* application drops invalid JSON */ }
      }
      updatePressure();
      if (control) void run(item);
      else { queue.push(item); void pump(); }
    },
    onClose(event, ws) {
      dispose();
      handlers.onClose?.(event, ws);
    },
  };
}
