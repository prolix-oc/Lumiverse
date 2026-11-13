import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const mode of ["worker", "process"] as const) {
  test(`conditional metadata API preserves guards and conflicts over ${mode} transport`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `spindle-chat-metadata-${mode}-`));
    const entry = join(directory, "backend.mjs");
    await Bun.write(entry, `
      const input = {
        expected_metadata: { count: 1 }, metadata: { count: 2 },
        expected_last_message_id: 'reply',
        expected_message: { id: 'reply', swipe_id: 1, swipes: ['A', 'B'], metadata: {} },
      };
      spindle.registerMacro({ name: 'compare', handler: () => spindle.chats.compareAndSetMetadata('chat', input, 'alice') });
      const saved = await spindle.chats.compareAndSetMetadata('chat', input, 'alice');
      const conflict = await spindle.chats.compareAndSetMetadata('chat', input, 'alice');
      spindle.sendToFrontend({ saved, conflict });
    `);
    const completed = Promise.withResolvers<any>();
    const macro = Promise.withResolvers<any>();
    const requests: any[] = [];
    let send: (message: unknown) => void;
    const onMessage = (message: any) => {
      if (message.type === "permissions_get_granted") {
        send({ type: "response", requestId: message.requestId, result: ["chats", "chat_mutation"] });
      } else if (message.type === "chats_compare_metadata") {
        requests.push(message);
        send({ type: "response", requestId: message.requestId, result: requests.length === 1 ? { id: "chat", metadata: { count: 2 } } : null });
      } else if (message.type === "frontend_message") completed.resolve(message.payload);
      else if (message.type === "macro_result") macro.resolve(message);
      else if (message.type === "log" && message.level === "error") completed.reject(new Error(message.message));
    };
    let worker: Worker | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const runtime = join(import.meta.dir, "worker-runtime.ts");
    if (mode === "worker") {
      worker = new Worker(runtime);
      worker.onmessage = event => onMessage(event.data);
      worker.onerror = error => completed.reject(error);
      send = message => worker!.postMessage(message);
    } else {
      child = Bun.spawn([process.execPath, runtime], { stdout: "ignore", stderr: "pipe", ipc: onMessage });
      send = message => child!.send(message);
    }
    const timer = setTimeout(() => {
      completed.reject(new Error("Conditional metadata runtime timed out"));
      macro.reject(new Error("Conditional metadata macro timed out"));
    }, 5000);
    try {
      send({
        type: "init",
        manifest: { identifier: "conditional_metadata_runtime", entry_backend: pathToFileURL(entry).href, permissions: ["chats", "chat_mutation"] },
        storagePath: directory,
        host: { descriptorVersion: 1, lumiverseVersion: "test", capabilities: { "chat-conditional-metadata-v1": 1 }, extensionInstallationId: "conditional_metadata_runtime" },
      });
      expect(await completed.promise).toEqual({ saved: { id: "chat", metadata: { count: 2 } }, conflict: null });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        chatId: "chat", userId: "alice",
        input: {
          expected_metadata: { count: 1 }, metadata: { count: 2 },
          expected_last_message_id: "reply",
          expected_message: { id: "reply", swipe_id: 1, swipes: ["A", "B"], metadata: {} },
        },
      });
      expect(requests[1].requestId).not.toBe(requests[0].requestId);
      send({ type: "event", event: "__macro_invoke__", payload: { requestId: "preview", name: "compare", context: { commit: false } } });
      expect((await macro.promise).error).toContain("not allowed during non-committing macro resolution");
      expect(requests).toHaveLength(2);
    } finally {
      clearTimeout(timer);
      worker?.terminate();
      if (child) { child.kill(); await child.exited; }
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
}
