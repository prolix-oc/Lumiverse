import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeTransport, type RuntimeTransport } from "./runtime-transport";

async function runBackend(source: string, payload?: unknown, transport?: "stdio" | "ipc", stopOnReady = false) {
  const directory = mkdtempSync(join(tmpdir(), "lumiverse-runtime-test-"));
  const entry = join(directory, "extension.ts");
  await Bun.write(entry, source);
  const events: any[] = [];
  let runtime: RuntimeTransport | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Extension timed out; received ${events.map((event) => event.type).join(", ")}`)), 5_000);
      runtime = createRuntimeTransport({
        runtimePath: join(import.meta.dir, "backend-process-runtime.ts"),
        extensionIdentifier: "transport-test", repoPath: directory, storagePath: directory,
        mode: "process", processTransport: transport,
        onMessage(message) {
          events.push(message);
          if (stopOnReady && (message as any).type === "ready") runtime!.postMessage({ type: "stop", reason: "test" });
        },
        onError: (message) => reject(new Error(message)),
        onExit: (code) => resolve(code),
      });
      runtime.postMessage({ type: "init", process: { processId: "test", entry: "test", entryPath: entry, kind: "test", payload } });
    });
    return { events, exitCode };
  } finally {
    if (timeout) clearTimeout(timeout);
    runtime?.terminate(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the platform's default transport delivers completion before process exit", async () => {
  const { events, exitCode } = await runBackend("export default ctx => { ctx.ready(); ctx.send({ answer: 42 }); ctx.complete(); };");
  expect(exitCode).toBe(0);
  expect(events).toEqual([{ type: "ready" }, { type: "message", payload: { answer: 42 } }, { type: "complete" }]);
});

test("extension pipes drain large binary replies and preserve metadata before exit", async () => {
  const payload = { bytes: new Uint8Array(512 * 1024).fill(37), deleted: undefined, integer: 23n };
  const { events, exitCode } = await runBackend("export default ctx => { console.log('extension diagnostic'); ctx.send(ctx.payload); ctx.complete(); };", payload, "stdio");
  expect(exitCode).toBe(0);
  expect(events).toEqual([{ type: "message", payload }, { type: "complete" }]);
  expect(Object.hasOwn(events[0].payload, "deleted")).toBe(true);
});

test("extension pipes report import failures before the nonzero exit", async () => {
  const { events, exitCode } = await runBackend("throw new Error('extension import failed');", undefined, "stdio");
  expect(exitCode).toBe(1);
  expect(events).toEqual([{ type: "fail", error: "extension import failed" }]);
});

test("extension pipe stop messages run cleanup and deliver the terminal reply", async () => {
  const { events, exitCode } = await runBackend("export default ctx => { ctx.onStop(({ reason }) => { ctx.send({ reason }); ctx.complete(); }); ctx.ready(); };", undefined, "stdio", true);
  expect(exitCode).toBe(0);
  expect(events).toEqual([{ type: "ready" }, { type: "message", payload: { reason: "test" } }, { type: "complete" }]);
});

test("the extension runtime receives RPC replies and flushes shutdown after sandboxing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lumiverse-worker-test-"));
  const entry = join(directory, "extension.ts");
  await Bun.write(entry, "console.log('extension loaded'); export {};\n");
  const events: any[] = [];
  let runtime: RuntimeTransport | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Extension runtime timed out")), 5_000);
      runtime = createRuntimeTransport({
        runtimePath: join(import.meta.dir, "worker-runtime.ts"),
        extensionIdentifier: "worker-test", repoPath: directory, storagePath: directory,
        mode: "process", processTransport: "stdio",
        onMessage(message) {
          const event = message as any;
          events.push(event);
          if (event.type === "permissions_get_granted") runtime!.postMessage({ type: "response", requestId: event.requestId, result: [] });
          if (event.message === "__worker_ready__") runtime!.postMessage({ type: "shutdown" });
        },
        onError: (message) => reject(new Error(message)), onExit: resolve,
      });
      runtime.postMessage({ type: "init", manifest: { identifier: "worker-test", entry_backend: entry }, storagePath: directory });
    });
    expect(exitCode).toBe(0);
    expect(events.some((event) => event.message?.startsWith("Failed to load extension"))).toBe(false);
    expect(events.at(-1)).toEqual({ type: "log", level: "info", message: "__worker_shutdown_ack__" });
  } finally {
    if (timeout) clearTimeout(timeout);
    runtime?.terminate(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
