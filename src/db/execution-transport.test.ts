import { expect, test } from "bun:test";
import { encodeDatabaseMessage, readDatabaseMessages } from "./execution-transport";
import { createDatabaseSocketHost } from "./execution-socket";
import { SubprocessMessageDecoder } from "../utils/subprocess-messages";

test("database pipe framing handles split headers, coalesced messages, and binary values", async () => {
  const first = { type: "result" as const, requestId: "first", durationMs: 0, result: { deleted: undefined, integer: 1n, bytes: new Uint8Array([1, 2, 3]) } };
  const second = { type: "ready" as const };
  const bytes = Buffer.concat([encodeDatabaseMessage(first), encodeDatabaseMessage(second)]);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const [start, end] of [[0, 1], [1, 3], [3, 7], [7, bytes.length]]) controller.enqueue(bytes.subarray(start, end));
      controller.close();
    },
  });
  const received: unknown[] = [];
  await readDatabaseMessages(stream, (message) => received.push(message));
  expect(received).toEqual([first, second]);
  expect(Object.hasOwn((received[0] as typeof first).result, "deleted")).toBe(true);
});

test("database pipe framing rejects truncated messages", async () => {
  const bytes = encodeDatabaseMessage({ type: "ready" });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes.subarray(0, bytes.length - 1)); controller.close(); },
  });
  const received: unknown[] = [];
  await expect(readDatabaseMessages(stream, (message) => received.push(message))).rejects.toThrow("ended mid-frame");
  expect(received).toEqual([]);
});

test("database socket rejects unauthenticated peers and accepts a fragmented token and binary frames", async () => {
  const delivered = Promise.withResolvers<unknown>();
  const received: unknown[] = [];
  const disconnected: unknown[] = [];
  const host = createDatabaseSocketHost({
    receive(message) { received.push(message); delivered.resolve(message); host.send(message); },
    disconnect(error) { disconnected.push(error); },
  });
  const port = Number(host.env.LUMIVERSE_DATABASE_SOCKET_PORT);
  const token = Buffer.from(host.env.LUMIVERSE_DATABASE_SOCKET_TOKEN!, "hex");
  const rejected = Promise.withResolvers<void>();
  const sockets: Bun.Socket[] = [];
  const payload = { deleted: undefined, integer: 1n, bytes: new Uint8Array([0, 128, 255]) };
  const echoed = Promise.withResolvers<unknown>();
  const decoder = new SubprocessMessageDecoder();
  const deadline = setTimeout(() => {
    const error = new Error("Database socket authentication test timed out");
    rejected.reject(error); delivered.reject(error); echoed.reject(error);
  }, 2000);
  try {
    const invalid = await Bun.connect({ hostname: "127.0.0.1", port, socket: {
      open(socket) { socket.write(Buffer.concat([Buffer.alloc(32), encodeDatabaseMessage({ type: "ready" })])); },
      data() {}, close() { rejected.resolve(); },
    } });
    sockets.push(invalid);
    await rejected.promise;
    expect(received).toEqual([]);
    expect(disconnected).toEqual([]);

    const valid = await Bun.connect({ hostname: "127.0.0.1", port, socket: {
      open(socket) { socket.write(token.subarray(0, 7)); },
      data(_socket, bytes) { decoder.push(bytes, message => echoed.resolve(message)); },
    } });
    sockets.push(valid);
    await Bun.sleep(10);
    // Coalesce the rest of the token with the first frame, then split its body.
    const frame = encodeDatabaseMessage({ type: "result", requestId: "auth-test", durationMs: 0, result: payload });
    valid.write(Buffer.concat([token.subarray(7), frame.subarray(0, 6)]));
    await Bun.sleep(10);
    valid.write(frame.subarray(6));
    expect(await delivered.promise).toEqual({ type: "result", requestId: "auth-test", durationMs: 0, result: payload });
    expect(await echoed.promise).toEqual(received[0]);
    expect(Object.hasOwn((received[0] as any).result, "deleted")).toBe(true);
    expect(disconnected).toEqual([]);
  } finally {
    clearTimeout(deadline);
    host.close();
    for (const socket of sockets) socket.terminate();
  }
});
