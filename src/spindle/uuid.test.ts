import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import { uuidv7 } from "../utils/uuid";
import { WorkerHost } from "./worker-host";

function fixture(postToWorker: (message: any) => void, identifier = "uuid-test") {
  const host = new WorkerHost(identifier, {
    identifier, permissions: [],
  } as unknown as SpindleManifest, {
    id: identifier, identifier, name: "UUID Test", version: "0.0.0", author: "",
    description: "", github: "", homepage: "", permissions: [], granted_permissions: [],
    enabled: true, installed_at: 0, updated_at: 0, has_frontend: false, has_backend: true,
    status: "stopped", metadata: { install_scope: "operator" },
  } satisfies ExtensionInfo);
  const internal = host as unknown as {
    handleMessage(message: unknown): void;
    postToWorker(message: unknown): void;
  };
  internal.postToWorker = postToWorker;
  return internal;
}

const uuidPattern = (version: 4 | 7) => new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-${version}[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`);

test("UUID generation needs no permissions or user context and rejects unsupported wire versions", () => {
  const responses: any[] = [];
  const host = fixture((message) => responses.push(message));
  for (const version of [4, 7] as const) {
    host.handleMessage({ type: "uuid_generate", requestId: `v${version}`, version });
    expect(responses.at(-1)).toEqual({ type: "response", requestId: `v${version}`, result: expect.stringMatching(uuidPattern(version)) });
  }
  for (const version of [1, 6, "4", "7", null, undefined]) {
    host.handleMessage({ type: "uuid_generate", requestId: "invalid", version });
    expect(responses.at(-1)).toEqual({ type: "response", requestId: "invalid", error: "UUID version must be 4 or 7" });
  }
});

test("UUID v7 shares the backend helper's timestamp and same-millisecond counter across extensions", () => {
  const responses: any[] = [];
  const first = fixture((message) => responses.push(message));
  const second = fixture((message) => responses.push(message), "uuid-test-other");
  const originalNow = Date.now;
  const timestamp = 1_793_400_000_000;
  Date.now = () => timestamp;
  try {
    const before = uuidv7();
    first.handleMessage({ type: "uuid_generate", requestId: "first", version: 7 });
    second.handleMessage({ type: "uuid_generate", requestId: "second", version: 7 });
    const after = uuidv7();
    const ids: string[] = [before, ...responses.map((response) => response.result), after];
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const [index, id] of ids.entries()) {
      expect(id).toMatch(uuidPattern(7));
      expect(parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(timestamp);
      expect(parseInt(id.slice(15, 18), 16)).toBe(parseInt(before.slice(15, 18), 16) + index);
    }
  } finally {
    Date.now = originalNow;
  }
});

for (const mode of ["worker", "process"] as const) {
  test(`UUID API returns host-generated values and propagates errors over ${mode} transport`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `spindle-uuid-${mode}-`));
    let worker: Worker | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const entry = join(directory, "backend.mjs");
      await Bun.write(entry, `
        const ids = await Promise.all(Array.from({ length: 32 }, (_, i) => i % 2 ? spindle.uuid.v7() : spindle.uuid.v4()));
        let error;
        try { await spindle.uuid.v4(); } catch (err) { error = err.message; }
        spindle.sendToFrontend({ ids, error });
      `);
      const completed = Promise.withResolvers<any>();
      const generated: any[] = [];
      let send: (message: any) => void;
      const host = fixture((message) => {
        generated.push(message);
        send(message);
      });
      const onMessage = (message: any) => {
        if (message.type === "permissions_get_granted") {
          send({ type: "response", requestId: message.requestId, result: [] });
        } else if (message.type === "uuid_generate") {
          // Exercise host error handling after the concurrent successful calls.
          host.handleMessage(generated.length === 32 ? { ...message, version: 6 } : message);
        } else if (message.type === "frontend_message") {
          completed.resolve(message.payload);
        } else if (message.type === "log" && message.level === "error") {
          completed.reject(new Error(message.message));
        }
      };
      const runtime = join(import.meta.dir, "worker-runtime.ts");
      if (mode === "worker") {
        worker = new Worker(runtime);
        worker.onmessage = (event) => onMessage(event.data);
        worker.onerror = (error) => completed.reject(error);
        send = (message) => worker!.postMessage(message);
      } else {
        child = Bun.spawn([process.execPath, runtime], { stdout: "ignore", stderr: "pipe", ipc: onMessage });
        send = (message) => child!.send(message);
      }
      timer = setTimeout(() => completed.reject(new Error("UUID worker timed out")), 5_000);
      send({ type: "init", manifest: { identifier: "uuid-test", entry_backend: pathToFileURL(entry).href, permissions: [] }, storagePath: directory });
      const result = await completed.promise;
      expect(result.ids).toHaveLength(32);
      expect(new Set(result.ids).size).toBe(32);
      for (const [index, id] of result.ids.entries()) {
        expect(id).toMatch(uuidPattern(index % 2 ? 7 : 4));
        expect(id).toBe(generated[index].result);
      }
      expect(new Set(generated.map((message) => message.requestId)).size).toBe(33);
      expect(result.error).toBe("UUID version must be 4 or 7");
    } finally {
      clearTimeout(timer);
      worker?.terminate();
      if (child) { child.kill(); await child.exited; }
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
}
