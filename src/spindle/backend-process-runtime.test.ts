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
  | { type: "stopped" }
  | { type: "import-started" };

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
type LaunchEntryOptions = {
  omitPayload?: boolean;
  omitMetadata?: boolean;
  payload?: unknown;
  metadata?: Record<string, unknown> | undefined;
  allowExitWithoutTerminal?: boolean;
  initProcess?: unknown;
  initProcessOverrides?: Record<string, unknown>;
  initialMessage?: unknown;
  omitProcess?: boolean;
  skipInit?: boolean;
  sendStopBeforeInit?: boolean;
};

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
  options: LaunchEntryOptions = {},
): Promise<BackendProcessResult> {
  const entryDir = mkdtempSync(join(tmpdir(), "lumiverse-backend-process-runtime-"));
  const entryPath = join(entryDir, "entry.ts");
  writeFileSync(entryPath, entrySource, "utf8");

  const messages: BackendProcessMessage[] = [];
  const { promise: terminal, resolve: resolveTerminal } = Promise.withResolvers<BackendProcessMessage>();
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
      if (isTerminalMessage(parsed)) resolveTerminal(parsed);
    },
  });


  try {
    const processInit: Record<string, unknown> = {
      processId: crypto.randomUUID(),
      entry: "runtime-regression-entry",
      allowDynamicCode,
      kind: "test",
      entryPath,
      payload: { source: "runtime-regression" },
    };
    if (options.omitPayload) delete processInit.payload;
    if (options.omitMetadata) delete processInit.metadata;
    if (Object.hasOwn(options, "payload")) processInit.payload = options.payload;
    if (Object.hasOwn(options, "metadata")) processInit.metadata = options.metadata;

    const initMessage: Record<string, unknown> = { type: "init" };
    if (!options.omitProcess) {
      const processPayload = Object.hasOwn(options, "initProcess")
        ? options.initProcess
        : options.initProcessOverrides
          ? { ...processInit, ...options.initProcessOverrides }
          : processInit;
      initMessage.process = processPayload;
    }
    const hostMessage = Object.hasOwn(options, "initialMessage") ? options.initialMessage : initMessage;
    if (options.sendStopBeforeInit) {
      proc.send({ type: "stop", reason: "stop before init" });
    }
    if (!options.skipInit) {
      proc.send(hostMessage);
    }

    await Promise.race([
      terminal,
      proc.exited.then((exitCode) => {
        if (options.allowExitWithoutTerminal) return;
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

test("backend process runtime fails malformed init process payloads and exits", async () => {
  const malformedCases: Array<{ name: string; options: LaunchEntryOptions }> = [
    { name: "null", options: { initProcess: null } },
    { name: "missing", options: { omitProcess: true } },
    { name: "missing required fields", options: { initProcess: {} } },
    { name: "invalid allowDynamicCode", options: { initProcessOverrides: { allowDynamicCode: "yes" } } },
    { name: "invalid key", options: { initProcessOverrides: { key: 42 } } },
    { name: "invalid metadata", options: { initProcessOverrides: { metadata: null } } },
    { name: "invalid userId", options: { initProcessOverrides: { userId: 42 } } },
  ];

  for (const testCase of malformedCases) {
    const result = await launchEntry(
      "export default () => { throw new Error('entry should not run'); };",
      undefined,
      false,
      testCase.options,
    );

    expect(result.messages).toEqual([{ type: "fail", error: "Invalid backend process init payload" }]);
    expect(result.exitCode).toBe(1);
    expect(result.signalCode).toBeNull();
  }
});

test("backend process runtime fails malformed host message envelopes and exits", async () => {
  const malformedCases = [
    { name: "null", message: null },
    { name: "stop reason", message: { type: "stop", reason: {} } },
    { name: "missing message payload", message: { type: "message" } },
  ];

  for (const testCase of malformedCases) {
    const result = await launchEntry(
      "export default () => { throw new Error('entry should not run'); };",
      undefined,
      false,
      { initialMessage: testCase.message },
    );

    expect(result.messages).toEqual([{ type: "fail", error: "Invalid backend process message" }]);
    expect(result.exitCode).toBe(1);
    expect(result.signalCode).toBeNull();
  }
});

test("backend process runtime omits absent payload and metadata while preserving explicit values", async () => {
  const entrySource = `
    export default (ctx) => {
      ctx.ready();
      ctx.send({
        hasPayload: Object.hasOwn(ctx, "payload"),
        hasMetadata: Object.hasOwn(ctx, "metadata"),
        payload: Object.hasOwn(ctx, "payload") ? ctx.payload : "omitted",
        metadata: Object.hasOwn(ctx, "metadata") ? ctx.metadata : "omitted",
      });
      ctx.complete();
    };
  `;

  const omitted = await launchEntry(entrySource, undefined, false, {
    omitPayload: true,
    omitMetadata: true,
  });
  expect(omitted.messages).toEqual([
    { type: "ready" },
    {
      type: "message",
      payload: {
        hasPayload: false,
        hasMetadata: false,
        payload: "omitted",
        metadata: "omitted",
      },
    },
    { type: "complete" },
  ]);
  expect(omitted.exitCode).toBe(0);
  expect(omitted.signalCode).toBeNull();

  const explicit = await launchEntry(entrySource, undefined, false, {
    payload: null,
    metadata: { source: "explicit" },
  });
  expect(explicit.messages).toEqual([
    { type: "ready" },
    {
      type: "message",
      payload: {
        hasPayload: true,
        hasMetadata: true,
        payload: null,
        metadata: { source: "explicit" },
      },
    },
    { type: "complete" },
  ]);
  expect(explicit.exitCode).toBe(0);
  expect(explicit.signalCode).toBeNull();
});

test("backend process runtime preserves explicitly undefined payload and metadata", async () => {
  const result = await launchEntry(
    `
      export default (ctx) => {
        ctx.ready();
        ctx.send({
          hasPayload: Object.hasOwn(ctx, "payload"),
          hasMetadata: Object.hasOwn(ctx, "metadata"),
        });
        ctx.complete();
      };
    `,
    undefined,
    false,
    { payload: undefined, metadata: undefined },
  );

  expect(result.messages).toEqual([
    { type: "ready" },
    { type: "message", payload: { hasPayload: true, hasMetadata: true } },
    { type: "complete" },
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.signalCode).toBeNull();
});

test("backend process runtime exits exactly once when the terminal transport throws", async () => {
  const result = await launchEntry(
    `
      export default (ctx) => {
        if (typeof process.send !== "function") throw new Error("IPC is unavailable");
        ctx.ready();
        const send = process.send.bind(process);
        let terminalPosts = 0;
        process.send = (message) => {
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            (message.type === "complete" || message.type === "fail" || message.type === "stopped")
          ) {
            terminalPosts += 1;
            send({ type: "message", payload: { terminalPosts } });
            throw new Error("transport closed");
          }
          return send(message);
        };
        ctx.complete();
      };
    `,
    undefined,
    false,
    { allowExitWithoutTerminal: true },
  );

  expect(result.messages).toEqual([
    { type: "ready" },
    { type: "message", payload: { terminalPosts: 1 } },
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.signalCode).toBeNull();
});

test("backend process runtime cleans up before a stopped terminal post failure", async () => {
  const result = await launchEntry(
    `
      export default (ctx) => {
        if (typeof process.send !== "function") throw new Error("IPC is unavailable");
        const send = process.send.bind(process);
        let cleaned = false;
        process.send = (message) => {
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            (message.type === "complete" || message.type === "fail" || message.type === "stopped")
          ) {
            send({ type: "message", payload: { cleaned } });
            throw new Error("transport closed");
          }
          return send(message);
        };
        ctx.ready();
        return () => {
          cleaned = true;
        };
      };
    `,
    (proc, message) => {
      if (message.type === "ready") {
        proc.send({ type: "stop", reason: "cleanup regression" });
      }
    },
    false,
    { allowExitWithoutTerminal: true },
  );

  expect(result.messages).toEqual([
    { type: "ready" },
    { type: "message", payload: { cleaned: true } },
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
          ["module", () => globalThis.import("bun:jsc"), "Module loading is disabled in extension context"],
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
test("backend process runtime stops before a delayed entry import resolves", async () => {
  const result = await launchEntry(
    `
      if (typeof process.send !== "function") throw new Error("IPC is unavailable");
      process.send({ type: "import-started" });
      const { promise, resolve } = Promise.withResolvers();
      process.on("message", (message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "release-import"
        ) {
          resolve();
        }
      });
      await promise;
      export default (ctx) => {
        ctx.ready();
        ctx.send({ phase: "late-handler-invoked" });
        ctx.fail("late handler invoked after stop");
      };
    `,
    (proc, message) => {
      if (message.type === "import-started") {
        proc.send({ type: "stop", reason: "stop during delayed import" });
        proc.send({ type: "release-import" });
      }
    },
  );

  expect(result.messages).toEqual([
    { type: "import-started" },
    { type: "stopped" },
  ]);
  expect(result.messages.filter(isTerminalMessage)).toEqual([{ type: "stopped" }]);
  expect(result.exitCode).toBe(0);
  expect(result.signalCode).toBeNull();
});

test("backend process runtime reports stopped when shutdown arrives before init", async () => {
  const result = await launchEntry(
    "export default () => { throw new Error('entry should not run'); };",
    undefined,
    false,
    { skipInit: true, sendStopBeforeInit: true },
  );

  expect(result.messages).toEqual([{ type: "stopped" }]);
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
