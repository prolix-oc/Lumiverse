import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("character picker search and thumbnails cross the worker RPC boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spindle-character-picker-"));
  const entry = join(directory, "backend.mjs");
  await Bun.write(entry, `
    spindle.onFrontendMessage(async () => {
      const result = await spindle.characters.list({ search: 'Mira', limit: 50, offset: 100, userId: 'alice' });
      spindle.sendToFrontend({ pickerTest: 'done', result });
    });
  `);
  const received: any[] = [];
  const listeners = new Set<() => void>();
  const worker = Bun.spawn([process.execPath, join(import.meta.dir, "worker-runtime.ts")], {
    stdout: "ignore", stderr: "pipe",
    ipc(message: any, child) {
      if (message.type === "permissions_get_granted") child.send({ type: "response", requestId: message.requestId, result: ["characters"] });
      if (message.type === "characters_list") child.send({ type: "response", requestId: message.requestId, result: { data: [{ id: 'mira', avatar_url: '/thumbnail.png' }], total: 101 } });
      received.push(message);
      for (const listener of listeners) listener();
    },
  });
  function waitFor(predicate: (message: any) => boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error("Character picker RPC timed out")); }, 3000);
      const check = () => {
        const message = received.find(predicate);
        if (!message) return;
        clearTimeout(timer); listeners.delete(check); resolve(message);
      };
      listeners.add(check); check();
    });
  }
  try {
    worker.send({ type: "init", manifest: { identifier: "picker-test", entry_backend: pathToFileURL(entry).href, permissions: ["characters"] }, storagePath: directory });
    await waitFor(message => message.message === "__worker_ready__");
    worker.send({ type: "frontend_message", userId: "alice", payload: {} });
    expect(await waitFor(message => message.type === "characters_list")).toMatchObject({ search: "Mira", limit: 50, offset: 100, userId: "alice" });
    expect((await waitFor(message => message.payload?.pickerTest === "done")).payload.result).toEqual({ data: [{ id: "mira", avatar_url: "/thumbnail.png" }], total: 101 });
  } finally {
    worker.kill(); await worker.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
