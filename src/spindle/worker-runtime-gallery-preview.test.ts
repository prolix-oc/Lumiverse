import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { createCharacter, getCharacter, updateCharacter } from "../services/characters.service";
import { WorkerHostContentApi } from "./worker-host-content-api";

test("characters.getGallery preserves saved data during non-committing macro resolution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spindle-gallery-preview-"));
  let worker: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    closeDatabase();
    initDatabase(":memory:");
    getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
    const userId = "gallery-preview-user";
    getDb().query('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)')
      .run(userId, "Gallery Preview", "gallery-preview@example.com");
    const character = createCharacter(userId, { name: "Aster" });
    const itemId = "22222222-2222-4222-8222-222222222222";
    const imageId = "33333333-3333-4333-8333-333333333333";
    getDb().query("INSERT INTO images (id, filename, original_filename, mime_type, user_id) VALUES (?, ?, ?, ?, ?)")
      .run(imageId, "scene.webp", "scene.webp", "image/webp", userId);
    getDb().query("INSERT INTO character_gallery (id, user_id, character_id, image_id, caption, sort_order, created_at) VALUES (?, ?, ?, ?, ?, 0, 0)")
      .run(itemId, userId, character.id, imageId, "Opening scene");
    updateCharacter(userId, character.id, { first_mes: `![Scene](gallery://${itemId})` });
    const before = getCharacter(userId, character.id);
    const entry = join(directory, "backend.mjs");
    await Bun.write(entry, `
      spindle.registerMacro({
        name: 'galleryread',
        handler: async () => (await spindle.characters.getGallery('${character.id}'))[0].reference,
      });
    `);
    const completed = Promise.withResolvers<any>();
    const contentApi = new WorkerHostContentApi({
      manifest: { identifier: "gallery-preview-test" },
      hasPermission: (permission) => permission === "characters",
      resolveEffectiveUserId: () => userId,
      enforceScopedUser: (resolvedUserId) => expect(resolvedUserId).toBe(userId),
      postResponse: (message) => worker!.send(message),
    });
    worker = Bun.spawn([process.execPath, join(import.meta.dir, "worker-runtime.ts")], {
      stdout: "ignore", stderr: "pipe",
      ipc(message: any, child) {
        if (message.type === "permissions_get_granted") {
          child.send({ type: "response", requestId: message.requestId, result: ["characters"] });
        } else if (message.type === "characters_get_gallery") {
          contentApi.handleCharactersGetGallery(message.requestId, message.characterId, message.userId);
        } else if (message.type === "macro_result") {
          completed.resolve(message);
        } else if (message.type === "log" && message.message === "__worker_ready__") {
          child.send({ type: "event", event: "__macro_invoke__", payload: { requestId: "preview", name: "galleryread", context: { commit: false } } });
        } else if (message.type === "log" && message.level === "error") {
          completed.reject(new Error(message.message));
        }
      },
    });
    timer = setTimeout(() => completed.reject(new Error("Gallery preview timed out")), 10_000);
    worker.send({ type: "init", manifest: { identifier: "gallery-preview-test", entry_backend: pathToFileURL(entry).href, permissions: ["characters"] }, storagePath: directory });
    const result = await completed.promise;
    expect(result.error).toBeUndefined();
    expect(getCharacter(userId, character.id)).toEqual(before);
    expect(result.result).toBe(`gallery://${itemId}`);
  } finally {
    clearTimeout(timer);
    if (worker) { worker.kill(); await worker.exited; }
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
