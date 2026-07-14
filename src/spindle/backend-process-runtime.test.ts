import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

import { bunCmd } from "../utils/bun-cmd";

type BackendProcessMessage =
  | { type: "ready" }
  | { type: "heartbeat" }
  | { type: "message"; payload: unknown }
  | { type: "complete" }
  | { type: "fail"; error: string }
  | { type: "stopped" };

type BackendProcessResult = {
  messages: BackendProcessMessage[];
  exitCode: number;
  signalCode: NodeJS.Signals | null;
};

const RUNTIME_TIMEOUT_MS = 5_000;
const runtimePath = fileURLToPath(new URL("./backend-process-runtime.ts", import.meta.url));

type ProcessMessageHandler = (
  process: Bun.Subprocess,
  message: BackendProcessMessage,
) => void;

function isTerminalMessage(message: BackendProcessMessage): boolean {
  return message.type === "complete" || message.type === "fail" || message.type === "stopped";
}

function launchExitError(exitCode: number, signalCode: NodeJS.Signals | null): Error {
  return new Error(
    `backend process exited before a terminal IPC message (exitCode=${exitCode}, signal=${signalCode ?? "none"})`,
  );
}

async function launchEntry(
  entrySource: string,
  onMessage?: ProcessMessageHandler,
  allowDynamicCode = false,
): Promise<BackendProcessResult> {
  const entryDir = mkdtempSync(join(tmpdir(), "lumiverse-backend-process-runtime-"));
  const entryPath = join(entryDir, "entry.ts");
  writeFileSync(entryPath, entrySource, "utf8");

  const messages: BackendProcessMessage[] = [];
  let resolveTerminal: ((message: BackendProcessMessage) => void) | undefined;
  const terminal = new Promise<BackendProcessMessage>((resolve) => {
    resolveTerminal = resolve;
  });

  const proc = Bun.spawn({
    cmd: bunCmd(runtimePath, "--spindle-subprocess"),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    serialization: "advanced",
    timeout: RUNTIME_TIMEOUT_MS,
    killSignal: "SIGKILL",
    ipc(message) {
      const parsed = message as BackendProcessMessage;
      messages.push(parsed);
      onMessage?.(proc, parsed);
      if (isTerminalMessage(parsed)) resolveTerminal?.(parsed);
    },
  });

  try {
    proc.send({
      type: "init",
      process: {
        processId: crypto.randomUUID(),
        entry: "runtime-regression-entry",
        allowDynamicCode,
        kind: "test",
        entryPath,
        payload: { source: "runtime-regression" },
      },
    });

    await Promise.race([
      terminal,
      proc.exited.then((exitCode) => {
        throw launchExitError(exitCode, proc.signalCode);
      }),
    ]);
    const exitCode = await proc.exited;
    return {
      messages,
      exitCode,
      signalCode: proc.signalCode,
    };
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await proc.exited.catch(() => undefined);
    rmSync(entryDir, { recursive: true, force: true });
  }
}


test("backend process runtime keeps IPC and complete termination after sandboxing", async () => {
  const result = await launchEntry(`
    export default (ctx) => {
      ctx.ready();
      ctx.send({ phase: "ready", processId: ctx.processId });
      ctx.complete();
    };
  `);

  expect(result.messages).toEqual([
    { type: "ready" },
    { type: "message", payload: { phase: "ready", processId: expect.any(String) } },
    { type: "complete" },
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.signalCode).toBeNull();
});
test("backend process propagates allowDynamicCode while retaining module, process, network, and filesystem guards", async () => {
  const result = await launchEntry(
    `
      export default async (ctx) => {
        ctx.ready();
        const dynamic = new Function("return 41")();
        const blocked = [];
        const attempts = [
          ["module", () => globalThis.import("bun:jsc"), "Module 'bun:jsc' is blocked in extension context"],
          ["process", () => process.getBuiltinModule("fs"), "process.getBuiltinModule is disabled in extension context"],
          ["network", () => fetch("https://example.test"), "fetch is disabled in extension context"],
          ["filesystem", () => Bun.file("/tmp/backend-process-sandbox-denied"), "Bun.file is disabled in extension context"],
        ];
        for (const [label, attempt, expected] of attempts) {
          let guarded = false;
          try {
            await attempt();
          } catch (error) {
            guarded = error instanceof Error && error.message === expected;
          }
          if (guarded) blocked.push(label);
        }
        ctx.send({ dynamic, blocked });
        ctx.complete();
      };
    `,
    undefined,
    true,
  );

  expect(result.messages).toEqual([
    { type: "ready" },
    { type: "message", payload: { dynamic: 41, blocked: ["module", "process", "network", "filesystem"] } },
    { type: "complete" },
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.signalCode).toBeNull();
});


test("backend process runtime preserves stopped termination and host-to-entry IPC", async () => {
  const result = await launchEntry(
    `
      export default (ctx) => {
        ctx.ready();
        ctx.onMessage((payload) => ctx.send({ received: payload }));
      };
    `,
    (proc, message) => {
      if (message.type === "ready") {
        proc.send({ type: "message", payload: { fromHost: true } });
      } else if (
        message.type === "message" &&
        typeof message.payload === "object" &&
        message.payload !== null &&
        "received" in message.payload
      ) {
        proc.send({ type: "stop", reason: "runtime regression" });
      }
    },
  );

  expect(result.messages).toEqual([
    { type: "ready" },
    { type: "message", payload: { received: { fromHost: true } } },
    { type: "stopped" },
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.signalCode).toBeNull();
});

const blockedGlobalCases = [
  {
    name: "fetch",
    expression: 'fetch("https://example.test")',
    expectedError: "fetch is disabled in extension context",
  },
  {
    name: "WebSocket",
    expression: 'new WebSocket("wss://example.test")',
    expectedError: "WebSocket is disabled in extension context",
  },
  {
    name: "Worker",
    expression: 'new Worker("data:text/javascript,export default 1")',
    expectedError: "Worker is disabled in extension context",
  },
  {
    name: "BroadcastChannel",
    expression: 'new BroadcastChannel("runtime-regression")',
    expectedError: "BroadcastChannel is disabled in extension context",
  },
] as const;

for (const testCase of blockedGlobalCases) {
  test(`backend process rejects bare ${testCase.name} at top level before entry succeeds`, async () => {
    const result = await launchEntry(`
      ${testCase.expression};
      throw new Error("entry continued after ${testCase.name}");
      export default () => {};
    `);

    expect(result.messages).toEqual([{ type: "fail", error: testCase.expectedError }]);
    expect(result.exitCode).toBe(1);
    expect(result.signalCode).toBeNull();
  });

  test(`backend process rejects bare ${testCase.name} from the handler`, async () => {
    const result = await launchEntry(`
      export default (ctx) => {
        ctx.ready();
        ${testCase.expression};
        throw new Error("handler continued after ${testCase.name}");
      };
    `);

    expect(result.messages).toEqual([
      { type: "ready" },
      { type: "fail", error: testCase.expectedError },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.signalCode).toBeNull();
  });
}

test("backend process runtime keeps fail termination functional after sandboxing", async () => {
  const result = await launchEntry(`
    export default (ctx) => {
      ctx.ready();
      ctx.fail("intentional runtime failure");
    };
  `);

  expect(result.messages).toEqual([
    { type: "ready" },
    { type: "fail", error: "intentional runtime failure" },
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.signalCode).toBeNull();
});
