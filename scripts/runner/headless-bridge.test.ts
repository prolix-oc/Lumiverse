import { expect, test } from "bun:test";
import { FRAME_PREFIX, drainCommandBuffer, encodeFrame } from "./headless-bridge.js";
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
