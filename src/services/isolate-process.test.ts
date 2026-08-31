import { describe, expect, test } from "bun:test";
import {
  createLengthPrefixedSubprocessTransport,
  defaultIsolateCommand,
  resolveIsolateEntrypoint,
  terminateIsolateProcessTree,
  type IsolateProcessTransport,
} from "./isolate-process";
import {
  isIsolateResponseEnvelopeV1,
  makeRequestEnvelopeV1,
} from "./isolate-protocol";

function fakeProcess(pid: number) {
  const signals: string[] = [];
  return {
    pid,
    signals,
    kill(signal?: "SIGTERM" | "SIGKILL") {
      signals.push(signal ?? "SIGTERM");
    },
  };
}
function receiveIsolateMessage(transport: IsolateProcessTransport): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  let detachMessage = () => {};
  let detachError = () => {};
  detachMessage = transport.onMessage((message) => {
    detachMessage();
    detachError();
    resolve(message);
  });
  detachError = transport.onError((error) => {
    detachMessage();
    detachError();
    reject(error);
  });
  return promise;
}

describe("isolate process supervision", () => {
  test("always kills the direct process after attempting tree termination", async () => {
    const processLike = fakeProcess(42);
    await terminateIsolateProcessTree(processLike, "SIGKILL", "linux");
    expect(processLike.signals).toEqual(["SIGKILL"]);
  });

  test("terminates descendants created during a process-group teardown race", async () => {
    const child = Bun.spawn({
      cmd: [
        "sh",
        "-c",
        "trap 'sleep 30 & exit 0' TERM; while :; do sleep 1; done",
      ],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    const processLike = {
      pid: child.pid,
      exited: child.exited,
      kill(signal?: "SIGTERM" | "SIGKILL") {
        child.kill(signal);
      },
    };
    try {
      await terminateIsolateProcessTree(processLike, "SIGTERM");
      await child.exited;
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process group may already be gone after the assertion.
      }
    }
  });

  test("termination is idempotent when the child has no usable PID", async () => {
    const processLike = fakeProcess(Number.NaN);
    await terminateIsolateProcessTree(processLike, "SIGTERM", "win32");
    expect(processLike.signals).toEqual(["SIGTERM"]);
  });

  test("rejects subprocess termination when the process kill fails", async () => {
    const exit = Promise.withResolvers<number>();
    const processLike = {
      pid: Number.NaN,
      stdin: null,
      stdout: new ReadableStream<Uint8Array>({
        cancel() {},
      }),
      exited: exit.promise,
      kill() {
        throw new Error("kill denied");
      },
    };
    const transport = createLengthPrefixedSubprocessTransport({
      command: ["fake-isolate"],
      spawn: () => processLike,
    });
    await expect(transport.terminate("SIGKILL")).rejects.toThrow(/termination failed/);
    exit.resolve(137);
  });
  test("does not duplicate a large frame when Bun reports a partial immediate flush", async () => {
    const transport = createLengthPrefixedSubprocessTransport({
      command: defaultIsolateCommand(new URL("./regex-isolate-subprocess.ts", import.meta.url)),
      maxFrameBytes: 8 * 1024 * 1024,
    });
    try {
      const requestId = "large-frame-request";
      const response = receiveIsolateMessage(transport);
      await transport.send(makeRequestEnvelopeV1(requestId, "replace", {
        op: "replace",
        pattern: "x",
        flags: "g",
        input: "x".repeat(2_000_000),
        replacement: "y",
        limits: { maxInputBytes: 1 },
      }));
      expect(await response).toMatchObject({
        type: "error",
        requestId,
        code: "invalid_input",
      });
    } finally {
      await transport.terminate("SIGKILL");
    }
  });
  test("regex subprocess uses the framed protocol and preserves request identity/error codes", async () => {
    const entrypoint = resolveIsolateEntrypoint(new URL("./regex-isolate-subprocess.ts", import.meta.url));
    expect(await Bun.file(entrypoint).exists()).toBe(true);
    expect(defaultIsolateCommand(new URL("./regex-isolate-subprocess.ts", import.meta.url)).at(-1)).toBe(entrypoint);
    const transport = createLengthPrefixedSubprocessTransport({
      command: defaultIsolateCommand(new URL("./regex-isolate-subprocess.ts", import.meta.url)),
      maxFrameBytes: 1024 * 1024,
    });
    try {
      const requestId = "regex-request-1";
      const response = receiveIsolateMessage(transport);
      await transport.send(makeRequestEnvelopeV1(requestId, "replace", {
        op: "replace",
        pattern: "foo",
        flags: "g",
        input: "foo",
        replacement: "bar",
      }));
      const result = await response;
      expect(isIsolateResponseEnvelopeV1(result)).toBe(true);
      expect(result).toMatchObject({ type: "result", requestId, result: "bar" });

      const errorResponse = receiveIsolateMessage(transport);
      await transport.send(makeRequestEnvelopeV1("regex-request-2", "replace", {
        op: "replace",
        pattern: "foo",
        flags: "g",
        input: "foo",
        replacement: "bar",
        limits: { maxInputBytes: 1 },
      }));
      const error = await errorResponse;
      expect(error).toMatchObject({
        type: "error",
        requestId: "regex-request-2",
        code: "invalid_input",
      });
    } finally {
      await transport.terminate("SIGKILL");
    }
  });
  test("prompt subprocess path resolves and emits protocol errors with request identity", async () => {
    const entrypoint = resolveIsolateEntrypoint(new URL("./prompt-assembly-subprocess.ts", import.meta.url));
    expect(await Bun.file(entrypoint).exists()).toBe(true);
    const transport = createLengthPrefixedSubprocessTransport({
      command: defaultIsolateCommand(new URL("./prompt-assembly-subprocess.ts", import.meta.url)),
      maxFrameBytes: 1024 * 1024,
    });
    try {
      const requestId = "prompt-request-1";
      const response = receiveIsolateMessage(transport);
      await transport.send(makeRequestEnvelopeV1(requestId, "unsupported_prompt_operation", null));
      expect(await response).toMatchObject({
        type: "error",
        requestId,
        code: "invalid_input",
      });
    } finally {
      await transport.terminate("SIGKILL");
    }
  });
});
