import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("command callbacks preserve authenticated account/document separately from untrusted UI context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spindle-command-origin-"));
  const entry = join(directory, "backend.mjs");
  await Bun.write(entry, `
    spindle.commands.onInvoked(async (id, context, origin) => {
      await Promise.resolve();
      if (id === 'reject') throw new Error('async command failure');
      if (!origin?.frontendSessionId) return;
      spindle.sendToFrontend({ id, origin, context }, origin.userId, { frontendSessionId: origin.frontendSessionId });
    });
  `);
  const received: any[] = [];
  const listeners = new Set<() => void>();
  const worker = Bun.spawn([process.execPath, join(import.meta.dir, "worker-runtime.ts")], {
    stdout: "ignore", stderr: "pipe",
    ipc(message: any, child) {
      if (message.type === "permissions_get_granted") child.send({ type: "response", requestId: message.requestId, result: [] });
      received.push(message);
      for (const listener of listeners) listener();
    },
  });
  function waitFor(predicate: (message: any) => boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error("Command callback timed out")); }, 3000);
      const check = () => {
        const message = received.find(predicate);
        if (!message) return;
        clearTimeout(timer); listeners.delete(check); resolve(message);
      };
      listeners.add(check); check();
    });
  }
  try {
    worker.send({ type: "init", manifest: { identifier: "command-test", entry_backend: pathToFileURL(entry).href, permissions: [] }, storagePath: directory });
    await waitFor(message => message.message === "__worker_ready__");
    const context = { route: "/", userId: "mallory", frontendSessionId: "forged", trigger: { type: "keybind", bindingId: "binding", scope: "global" } };
    worker.send({ type: "command_invoked", commandId: "alice-action", context, userId: "alice", frontendSessionId: "alice-window" });
    worker.send({ type: "command_invoked", commandId: "bob-action", context, userId: "bob", frontendSessionId: "bob-window" });
    expect(await waitFor(message => message.payload?.id === "alice-action")).toMatchObject({ userId: "alice", frontendSessionId: "alice-window", payload: { origin: { userId: "alice", frontendSessionId: "alice-window" }, context } });
    expect(await waitFor(message => message.payload?.id === "bob-action")).toMatchObject({ userId: "bob", frontendSessionId: "bob-window" });
    worker.send({ type: "command_invoked", commandId: "legacy", context, userId: "alice" });
    worker.send({ type: "command_invoked", commandId: "reject", context, userId: "alice" });
    await waitFor(message => message.level === "error" && message.message.includes("async command failure"));
    expect(received.filter(message => message.type === "frontend_message")).toHaveLength(2);
  } finally {
    worker.kill(); await worker.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
