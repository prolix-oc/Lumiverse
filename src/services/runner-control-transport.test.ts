import { describe, expect, test } from "bun:test";

import {
  createRunnerControlClient,
  createRunnerControlHost,
  RunnerControlFrameDecoder,
} from "./runner-control-transport";

describe("runner control framing", () => {
  test("decodes fragmented and coalesced JSON frames in order", () => {
    const frame = (value: unknown): Buffer => {
      const payload = Buffer.from(JSON.stringify(value));
      const result = Buffer.allocUnsafe(4 + payload.byteLength);
      result.writeUInt32BE(payload.byteLength);
      payload.copy(result, 4);
      return result;
    };
    const bytes = Buffer.concat([frame({ index: 1 }), frame({ index: 2 })]);
    const decoder = new RunnerControlFrameDecoder();
    const messages: unknown[] = [];

    for (const byte of bytes) messages.push(...decoder.push(Uint8Array.of(byte)));

    expect(messages).toEqual([{ index: 1 }, { index: 2 }]);
  });

  test("rejects an invalid declared frame length", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(0xffffffff);
    expect(() => new RunnerControlFrameDecoder().push(header)).toThrow(/frame length/);
  });
});

test("runner control host exchanges queued messages with an authenticated client", async () => {
  const hostReceived = Promise.withResolvers<unknown>();
  const clientReceived = Promise.withResolvers<unknown>();
  const errors: string[] = [];
  let host: ReturnType<typeof createRunnerControlHost> | null = null;
  let client: ReturnType<typeof createRunnerControlClient> = null;

  try {
    host = createRunnerControlHost({
      onMessage(message) {
        hostReceived.resolve(message);
        host?.send({ reply: message });
      },
      onError(message) {
        errors.push(message);
      },
      onDisconnect() {},
    });
    const childEnv: Record<string, string | undefined> = { ...host.bootstrapEnv };
    const bootstrapKeys = Object.keys(host.bootstrapEnv);
    client = createRunnerControlClient({
      env: childEnv,
      onMessage(message) {
        clientReceived.resolve(message);
      },
      onError(message) {
        errors.push(message);
      },
      onDisconnect() {},
    });

    // This is deliberately sent before Bun.connect has completed. The auth
    // frame must stay first and the application message must follow it.
    expect(client?.send({ command: "ready" })).toBe(true);
    expect(await Promise.race([
      hostReceived.promise,
      Bun.sleep(5_000).then(() => { throw new Error("Host message timed out"); }),
    ])).toEqual({ command: "ready" });
    expect(await Promise.race([
      clientReceived.promise,
      Bun.sleep(5_000).then(() => { throw new Error("Client message timed out"); }),
    ])).toEqual({ reply: { command: "ready" } });
    expect(bootstrapKeys.every((key) => childEnv[key] === undefined)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    client?.close();
    host?.close();
  }
}, 10_000);
