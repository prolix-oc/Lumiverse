import { afterEach, expect, mock, test } from "bun:test";

const runtime = await import("../../src/runtime/bun-runtime");
mock.module("../../src/runtime/bun-runtime", () => ({
  ...runtime,
  ensureBunRuntime: async () => {},
}));

let onMessage: (message: unknown) => void;
let exit: (code: number) => void;
mock.module("./server-process-launcher", () => ({
  launchServerProcess: (options: { onMessage: (message: unknown) => void }) => {
    onMessage = options.onMessage;
    const exited = new Promise<number>((resolve) => { exit = resolve; });
    return {
      proc: { pid: 12345, exited, kill: () => exit(0) },
      control: { close: () => {}, send: () => true },
      outputDone: Promise.resolve(),
      closeOutput: () => {},
    };
  },
}));

const manager = await import("./server-manager");
afterEach(async () => { await manager.stopServer(); });

test("a slow backend stays starting until its real ready message", async () => {
  const states: string[] = [];
  manager.setStateChangeHandler((state) => states.push(state));
  await manager.startServer(false);
  expect(manager.getServerState()).toBe("starting");

  // Reproduce the live restart: importing/tokenizer/extension startup takes
  // longer than the old three-second optimistic readiness fallback.
  await Bun.sleep(3_200);
  expect(manager.getServerState()).toBe("starting");
  expect(states).toEqual(["starting"]);

  onMessage({ type: "ready", payload: { port: 2004, pid: 12345 } });
  expect(manager.getServerState()).toBe("running");
  expect(states).toEqual(["starting", "running"]);
}, 10_000);
