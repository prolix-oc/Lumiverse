import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const mode of ["worker", "process"] as const) {
  test(`message generation API preserves session and variable contracts over ${mode} transport`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `spindle-message-generation-${mode}-`));
    const entry = join(directory, "backend.mjs");
    await Bun.write(entry, `
      const input = { chatId: 'chat', messageId: 'message', responseContextIds: ['context'], userId: 'alice' };
      spindle.registerMacro({ name: 'begin', handler: () => spindle.generate.beginMessage(input) });
      const prepared = await spindle.generate.dryRun({ chatId: 'chat', retainResponseContext: true, includeRequestMessages: true }, 'alice');
      const session = await spindle.generate.beginMessage(input);
      const chunks = [];
      for await (const chunk of spindle.generate.rawStream({ sessionId: session.id, swipeIndex: 0, userId: 'alice', messages: prepared.request_messages })) chunks.push(chunk);
      const result = await spindle.generate.finishMessage(session.id);
      await spindle.generate.abortMessage(session.id);
      const variables = { global: {}, chat: {} };
      const saved = await spindle.chat.setSwipeVariables('chat', 'message', { expected_variables: variables, expected_revision: null, expected_swipes: ['reply'], variables: [variables] });
      spindle.sendToFrontend({ prepared, result, chunks, saved });
    `);
    const completed = Promise.withResolvers<any>();
    const macro = Promise.withResolvers<any>();
    const requests: any[] = [];
    const prepared = { responseContextId: "context", assistantPrefill: "prefix", request_messages: [{ role: "user", content: "hello" }] };
    let send: (message: unknown) => void;
    const onMessage = (message: any) => {
      if (message.type === "frontend_message") { completed.resolve(message.payload); return; }
      if (message.type === "macro_result") { macro.resolve(message); return; }
      if (message.type === "log" && message.level === "error") { completed.reject(new Error(message.message)); return; }
      if (message.type === "request_generation_stream") {
        requests.push(message);
        send({ type: "generation_stream_chunk", requestId: message.requestId, chunk: { type: "text", token: "reply" } });
        send({ type: "generation_stream_chunk", requestId: message.requestId, chunk: { type: "done" } });
        return;
      }
      const results: Record<string, unknown> = {
        permissions_get_granted: ["generation", "chats", "chat_mutation"],
        generate_dry_run: prepared,
        message_generation_begin: { id: "session" },
        message_generation_finish: { messageId: "message", completed: true },
        message_generation_abort: true,
        chat_set_swipe_variables: false,
      };
      if (Object.hasOwn(results, message.type)) {
        requests.push(message);
        send({ type: "response", requestId: message.requestId, result: results[message.type] });
      }
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
      completed.reject(new Error("Message generation runtime timed out"));
      macro.reject(new Error("Message generation macro timed out"));
    }, 5000);
    try {
      send({
        type: "init",
        manifest: { identifier: "message_generation_runtime", entry_backend: pathToFileURL(entry).href, permissions: ["generation", "chats", "chat_mutation"] },
        storagePath: directory,
        host: { descriptorVersion: 1, lumiverseVersion: "test", capabilities: { "generation-message-sessions-v1": 1, "chat-swipe-variables-v1": 1 }, extensionInstallationId: "message_generation_runtime" },
      });
      expect(await completed.promise).toEqual({ prepared, result: { messageId: "message", completed: true }, chunks: [{ type: "text", token: "reply" }, { type: "done" }], saved: false });
      expect(requests.find(value => value.type === "generate_dry_run")).toMatchObject({ input: { chatId: "chat", retainResponseContext: true, includeRequestMessages: true }, userId: "alice" });
      expect(requests.find(value => value.type === "message_generation_begin").input).toEqual({ chatId: "chat", messageId: "message", responseContextIds: ["context"], userId: "alice" });
      expect(requests.find(value => value.type === "request_generation_stream").input).toEqual({ type: "raw", sessionId: "session", swipeIndex: 0, userId: "alice", messages: prepared.request_messages });
      for (const type of ["message_generation_finish", "message_generation_abort"]) expect(requests.find(value => value.type === type).sessionId).toBe("session");
      expect(requests.find(value => value.type === "chat_set_swipe_variables")).toMatchObject({ chatId: "chat", messageId: "message", input: { expected_revision: null } });
      const count = requests.length;
      send({ type: "event", event: "__macro_invoke__", payload: { requestId: "preview", name: "begin", context: { commit: false } } });
      expect((await macro.promise).error).toContain("not allowed during non-committing macro resolution");
      expect(requests).toHaveLength(count);
    } finally {
      clearTimeout(timer);
      worker?.terminate();
      if (child) { child.kill(); await child.exited; }
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
}
