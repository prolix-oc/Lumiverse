import { beforeEach, expect, mock, test } from "bun:test";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
const invoke = mock<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(
  async () => undefined,
);
mock.module("@tauri-apps/api/core", () => ({ invoke }));
mock.module("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  },
}));

const { RunnerClient } = await import("../src/runner-client");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function exited(): void {
  listeners.get("runner-exit")?.({ payload: 0 });
}

beforeEach(() => {
  listeners.clear();
  invoke.mockReset();
  invoke.mockImplementation(async (command) => command === "runner_alive");
});

test("shutdown of an inactive runner does not send quit or force-kill", async () => {
  invoke.mockImplementation(async () => false);
  const client = new RunnerClient();
  await client.init();

  await client.shutdown(100);

  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["runner_alive"]);
});

test("a quit acknowledgement does not complete shutdown before process exit", async () => {
  const sent = deferred<void>();
  invoke.mockImplementation(async (command, args) => {
    if (command === "runner_alive") return true;
    if (command === "runner_send") {
      const message = JSON.parse(args!.line as string);
      expect(message.type).toBe("quit");
      listeners.get("runner-frame")?.({ payload: JSON.stringify({
        type: "response", id: message.id, payload: { success: true },
      }) });
      sent.resolve();
    }
  });
  const client = new RunnerClient();
  await client.init();
  let settled = false;
  const shutdown = client.shutdown(1_000).then(() => { settled = true; });
  await sent.promise;
  await Bun.sleep(5);
  expect(settled).toBe(false);

  exited();
  await shutdown;
  expect(invoke.mock.calls.some(([command]) => command === "runner_kill")).toBe(false);
});

test("process exit completes shutdown even if the stdin invoke never resolves", async () => {
  const sent = deferred<void>();
  invoke.mockImplementation(async (command) => {
    if (command === "runner_alive") return true;
    if (command === "runner_send") {
      sent.resolve();
      return new Promise(() => {});
    }
  });
  const client = new RunnerClient();
  await client.init();
  const shutdown = client.shutdown(1_000);
  await sent.promise;

  exited();
  await shutdown;
  expect(invoke.mock.calls.some(([command]) => command === "runner_kill")).toBe(false);
});

test("the shutdown deadline includes an unresponsive alive probe", async () => {
  const alive = deferred<boolean>();
  invoke.mockImplementation(async (command) => {
    if (command === "runner_alive") return alive.promise;
  });
  const client = new RunnerClient();
  await client.init();

  await client.shutdown(20);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["runner_alive", "runner_kill"]);

  // Resolving the old probe must not send a delayed quit to a new runner.
  alive.resolve(true);
  await Bun.sleep(5);
  expect(invoke.mock.calls.some(([command]) => command === "runner_send")).toBe(false);
});

test("an exit event during the alive probe does not send a stale quit", async () => {
  const alive = deferred<boolean>();
  invoke.mockImplementation(async () => alive.promise);
  const client = new RunnerClient();
  await client.init();
  const shutdown = client.shutdown(1_000);

  exited();
  await shutdown;
  alive.resolve(true);
  await Bun.sleep(5);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["runner_alive"]);
});

test("a runner that remains alive after quit is force-killed", async () => {
  const client = new RunnerClient();
  await client.init();

  await client.shutdown(20);

  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "runner_alive", "runner_send", "runner_kill",
  ]);
});

test("a failed quit write triggers force-kill", async () => {
  invoke.mockImplementation(async (command) => {
    if (command === "runner_alive") return true;
    if (command === "runner_send") throw new Error("Broken pipe");
  });
  const client = new RunnerClient();
  await client.init();

  await client.shutdown(1_000);

  expect(invoke.mock.calls.at(-1)?.[0]).toBe("runner_kill");
});

test("a force-kill failure is reported to the caller for native exit cleanup", async () => {
  invoke.mockImplementation(async (command) => {
    if (command === "runner_alive") return true;
    if (command === "runner_send") throw new Error("Broken pipe");
    if (command === "runner_kill") throw new Error("Kill failed");
  });
  const client = new RunnerClient();
  await client.init();

  await expect(client.shutdown(1_000)).rejects.toThrow("Kill failed");
});
