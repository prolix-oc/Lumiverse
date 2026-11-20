import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("characters.getGallery and connections.getModels send scoped requests over the subprocess RPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spindle-gallery-models-"));
  const entry = join(directory, "backend.mjs");
  await Bun.write(entry, `
    const gallery = await spindle.characters.getGallery('char-1', 'alice');
    const models = await spindle.connections.getModels('conn-1', 'alice');
    spindle.sendToFrontend({ gallery, models });
  `);
  const gallery = [{ id: "item-1", image_id: "image-1", reference: "gallery://1", caption: "", sort_order: 0, created_at: 1, width: null, height: null, mime_type: "image/png" }];
  const models = [{ id: "model-a", label: "Model A" }];
  const requests: any[] = [];
  const completed = Promise.withResolvers<any>();
  const timer = setTimeout(() => completed.reject(new Error("Gallery/models RPC timed out")), 10_000);
  const worker = Bun.spawn([process.execPath, join(import.meta.dir, "worker-runtime.ts")], {
    stdout: "ignore", stderr: "pipe",
    ipc(message: any, child) {
      if (message.type === "permissions_get_granted") {
        child.send({ type: "response", requestId: message.requestId, result: ["characters", "generation"] });
      } else if (message.type === "characters_get_gallery") {
        requests.push(message);
        child.send({ type: "response", requestId: message.requestId, result: gallery });
      } else if (message.type === "connections_models") {
        requests.push(message);
        child.send({ type: "response", requestId: message.requestId, result: models });
      } else if (message.type === "frontend_message") {
        completed.resolve(message.payload);
      } else if (message.type === "log" && message.level === "error") {
        completed.reject(new Error(message.message));
      }
    },
  });
  try {
    worker.send({ type: "init", manifest: { identifier: "gallery-models-test", entry_backend: pathToFileURL(entry).href, permissions: ["characters", "generation"] }, storagePath: directory });
    expect(await completed.promise).toEqual({ gallery, models });
    expect(requests).toMatchObject([
      { type: "characters_get_gallery", characterId: "char-1", userId: "alice" },
      { type: "connections_models", connectionId: "conn-1", userId: "alice" },
    ]);
  } finally {
    clearTimeout(timer);
    worker.kill();
    await worker.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
