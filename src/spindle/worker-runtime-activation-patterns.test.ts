import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("activation preparation RPC preserves context and per-pattern results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spindle-activation-rpc-"));
  const entry = join(directory, "backend.mjs");
  const options = { presetId: "preset", patterns: ["{{char}}", "{{invalid}}"], chatId: "chat", personaId: "persona", characterId: "character", connectionId: "connection", userId: "alice" };
  const result = { patterns: [{ source: "{{char}}", resolved: "Name" }, { source: "{{invalid}}", error: "Unsupported input" }] };
  await Bun.write(entry, `spindle.sendToFrontend(await spindle.regex_scripts.prepareActivationPatterns(${JSON.stringify(options)}));`);
  const completed = Promise.withResolvers<any>();
  let request: any;
  const timer = setTimeout(() => completed.reject(new Error("Activation preparation RPC timed out")), 5000);
  const worker = Bun.spawn([process.execPath, join(import.meta.dir, "worker-runtime.ts")], {
    stdout: "ignore", stderr: "pipe",
    ipc(message: any, child) {
      if (message.type === "permissions_get_granted") {
        child.send({ type: "response", requestId: message.requestId, result: ["regex_scripts"] });
      } else if (message.type === "regex_scripts_prepare_activation_patterns") {
        request = message;
        child.send({ type: "response", requestId: message.requestId, result });
      } else if (message.type === "frontend_message") {
        completed.resolve(message.payload);
      }
    },
  });
  try {
    worker.send({ type: "init", manifest: { identifier: "activation-rpc-test", entry_backend: pathToFileURL(entry).href, permissions: ["regex_scripts"] }, storagePath: directory });
    expect(await completed.promise).toEqual(result);
    expect(request.options).toEqual(options);
  } finally {
    clearTimeout(timer);
    worker.kill();
    await worker.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
