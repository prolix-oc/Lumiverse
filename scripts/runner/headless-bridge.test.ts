import { expect, test } from "bun:test";
import {
  FRAME_PREFIX,
  LOG_SESSION_FRAME_TYPE,
  drainCommandBuffer,
  encodeFrame,
} from "./headless-bridge.js";
import { handleIPCMessage } from "./ipc-handler.js";

test("encodeFrame produces a single 0x1E-prefixed newline-terminated line", () => {
  const frame = encodeFrame({ type: "state", id: "state", payload: { state: "running" } });
  expect(frame.startsWith(FRAME_PREFIX)).toBe(true);
  expect(frame.endsWith("\n")).toBe(true);
  expect(frame.slice(1, -1)).not.toContain("\n");
  expect(JSON.parse(frame.slice(1))).toEqual({
    type: "state",
    id: "state",
    payload: { state: "running" },
  });
});

test("server log sessions use an authenticated native-only protocol frame", () => {
  const session = { id: "session-id", startedAt: "2026-09-17T22:17:30.123Z" };
  const frame = encodeFrame({
    type: LOG_SESSION_FRAME_TYPE,
    id: session.id,
    payload: { ...session, token: "native-secret" },
  });

  expect(JSON.parse(frame.slice(1))).toEqual({
    type: "lumiverse-log-session-v1",
    id: "session-id",
    payload: { ...session, token: "native-secret" },
  });
});

test("drainCommandBuffer parses complete lines and keeps the partial tail", () => {
  const { commands, rest } = drainCommandBuffer(
    '{"type":"full-status","id":"1"}\n{"type":"start-server","id":"2"}\n{"type":"trunc',
  );
  expect(commands).toEqual([
    { type: "full-status", id: "1" },
    { type: "start-server", id: "2" },
  ]);
  expect(rest).toBe('{"type":"trunc');
});

test("log frames neutralize 0x1E in server output (no frame spoofing)", () => {
  // A server log line starting with the record separator must not be able
  // to impersonate a protocol frame: JSON.stringify escapes control chars,
  // so the only raw 0x1E on the wire is the frame's own prefix.
  const hostile = `${FRAME_PREFIX}{"type":"state","id":"state","payload":{"state":"crashed"}}\n`;
  const frame = encodeFrame({ type: "log", id: "log", payload: { stream: "stdout", data: hostile } });
  expect(frame.slice(1)).not.toContain(FRAME_PREFIX);
  const parsed = JSON.parse(frame.slice(1));
  expect(parsed.type).toBe("log");
  expect(parsed.payload.data).toBe(hostile);
});

test("drainCommandBuffer drops blank and malformed lines without throwing", () => {
  const { commands, rest } = drainCommandBuffer('\n   \nnot-json\n{"type":"status","id":"3"}\n');
  expect(commands).toEqual([{ type: "status", id: "3" }]);
  expect(rest).toBe("");
});

test("full-status responds through the provided sink, not child IPC", async () => {
  const received: any[] = [];
  await handleIPCMessage({ type: "full-status", id: "fs-1" }, (message) => received.push(message));

  expect(received).toHaveLength(1);
  const [message] = received;
  expect(message.type).toBe("response");
  expect(message.id).toBe("fs-1");
  expect(message.payload.success).toBe(true);

  const data = message.payload.data;
  expect(data.state).toBe("stopped");
  expect(data.pid).toBeNull();
  expect(typeof data.port).toBe("number");
  expect(typeof data.branch).toBe("string");
  expect(typeof data.version).toBe("string");
  expect(typeof data.updateAvailable).toBe("boolean");
});

test("stop-server on an already-stopped server succeeds via sink", async () => {
  const received: any[] = [];
  await handleIPCMessage({ type: "stop-server", id: "ss-1" }, (message) => received.push(message));

  expect(received).toHaveLength(1);
  expect(received[0].payload.success).toBe(true);
  expect(received[0].payload.data.state).toBe("stopped");
});
