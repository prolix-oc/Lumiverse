import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { characterGalleryRoutes } from "../routes/character-gallery.routes";
import { characterEmbeddedImageUrls } from "../shared/embedded-images";
import * as safeFetch from "../utils/safe-fetch";
import * as images from "./images.service";
import { extractImagesFromCharacter, listGallery } from "./character-gallery.service";
import { createCharacter, getCharacter, updateCharacter } from "./characters.service";

const USER_ID = "embedded-image-user";
const REMOTE = "https://cdn.example.com/scene.png";
const app = new Hono();
app.use("*", async (c, next) => { c.set("userId", USER_ID); await next(); });
app.route("/characters/:characterId/gallery", characterGalleryRoutes);

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  getDb().query('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)')
    .run(USER_ID, "Embedded Images", "embedded-images@example.com");
  spyOn(safeFetch, "safeFetch").mockImplementation(async () =>
    new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
  let sequence = 0;
  spyOn(images, "uploadImageDeferred").mockImplementation(async (userId, file, options) => {
    const id = `embedded-image-${++sequence}`;
    getDb().query(`INSERT INTO images (id, user_id, filename, original_filename, mime_type, owner_character_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, userId, `${id}.png`, file.name, file.type, options?.owner_character_id ?? null);
    return images.getImage(userId, id)!;
  });
});

afterEach(() => { mock.restore(); closeDatabase(); });

describe("embedded image import", () => {
  test("rewrites all character fields and creator note assets to registered local references", async () => {
    const character = createCharacter(USER_ID, {
      name: "Aster", first_mes: `![Scene](${REMOTE} "Opening")`,
      description: REMOTE, personality: REMOTE, scenario: REMOTE, mes_example: REMOTE,
      system_prompt: REMOTE, post_history_instructions: REMOTE,
      creator_notes: `<div style='background:url("https://cdn.example.com/background")'><img class="notes" src="${REMOTE}"></div>`,
      alternate_greetings: [`![Again](${REMOTE})`],
      extensions: { nested: [{ html: '<img src="https://cdn.example.com/render?a=1&amp;b=2">', count: 3 }], keep: true },
    });

    const response = await app.request(`http://localhost/characters/${character.id}/gallery/extract`, { method: "POST" });
    expect(response.status).toBe(201);
    const items = await response.json() as Array<{ reference: string; image_id: string }>;
    expect(items).toHaveLength(3);
    const updated = getCharacter(USER_ID, character.id)!;
    expect(updated.first_mes).toBe('![Scene](gallery://image-1 "Opening")');
    for (const field of ["description", "personality", "scenario", "mes_example", "system_prompt", "post_history_instructions"] as const) {
      expect(updated[field]).toBe("gallery://image-1");
    }
    expect(updated.creator_notes).toBe('<div style=\'background:url("gallery://image-2")\'><img class="notes" src="gallery://image-1"></div>');
    expect(updated.alternate_greetings).toEqual(["![Again](gallery://image-1)"]);
    expect(updated.extensions.nested).toEqual([{ html: '<img src="gallery://image-3">', count: 3 }]);
    expect(updated.extensions.keep).toBe(true);
    for (const item of items) expect(updated.extensions.risu_asset_map[item.reference]).toBe(item.image_id);
    expect(characterEmbeddedImageUrls(updated)).toEqual([]);
    expect(safeFetch.safeFetch).toHaveBeenCalledTimes(3);
    expect(safeFetch.safeFetch).toHaveBeenCalledWith("https://cdn.example.com/render?a=1&b=2", { maxBytes: 50 * 1024 * 1024 });
    expect(await extractImagesFromCharacter(USER_ID, character.id)).toEqual([]);
    expect(listGallery(USER_ID, character.id)).toHaveLength(3);
  });

  test("keeps failed download and storage URLs for retry and leaves similar URLs intact", async () => {
    const failed = `${REMOTE}?version=2`;
    const rejected = "https://cdn.example.com/rejected.png";
    const nonImage = "https://cdn.example.com/not-an-image";
    spyOn(safeFetch, "safeFetch").mockImplementation(async (url) => {
      if (url === failed) return new Response("missing", { status: 404 });
      return new Response(new Uint8Array([1]), { headers: { "content-type": url === nonImage ? "text/html" : "image/png" } });
    });
    spyOn(images, "uploadImageDeferred").mockRejectedValueOnce(new Error("storage failed"));
    const character = createCharacter(USER_ID, {
      name: "Aster", first_mes: `![Rejected](${rejected}) ![Scene](${REMOTE})`,
      creator_notes: `![Missing](${failed}) <img src="${nonImage}">`,
    });
    expect(await extractImagesFromCharacter(USER_ID, character.id)).toHaveLength(1);
    expect(getCharacter(USER_ID, character.id)).toMatchObject({
      first_mes: `![Rejected](${rejected}) ![Scene](gallery://image-1)`,
      creator_notes: character.creator_notes,
    });
  });

  test("preserves edits made while downloading and only rewrites current text", async () => {
    const character = createCharacter(USER_ID, { name: "Aster", first_mes: `![Scene](${REMOTE})` });
    spyOn(safeFetch, "safeFetch").mockImplementation(async () => {
      updateCharacter(USER_ID, character.id, {
        first_mes: "New greeting without an image",
        creator_notes: `New notes: ![Scene](${REMOTE})`,
        extensions: { changedDuringDownload: true },
      });
      return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
    });
    await extractImagesFromCharacter(USER_ID, character.id);
    expect(getCharacter(USER_ID, character.id)).toMatchObject({
      first_mes: "New greeting without an image", creator_notes: "New notes: ![Scene](gallery://image-1)",
      extensions: { changedDuringDownload: true, risu_asset_map: { "gallery://image-1": "embedded-image-1" } },
    });
  });

  test.each([
    ["data:image/png;base64,AQID", new Uint8Array([1, 2, 3])],
    ["data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E", new TextEncoder().encode("<svg></svg>")],
  ])("imports embedded data image %s without fetching local or other users' assets", async (dataUri, bytes) => {
    const character = createCharacter(USER_ID, {
      name: "Aster", creator_notes: `<img src="${dataUri}">`,
      first_mes: '![Local](gallery://image-10) <img src="/api/v1/images/local">',
    });
    expect(await extractImagesFromCharacter("another-user", character.id)).toEqual([]);
    expect(await extractImagesFromCharacter(USER_ID, character.id)).toHaveLength(1);
    expect(getCharacter(USER_ID, character.id)!.creator_notes).toBe('<img src="gallery://image-1">');
    const upload = spyOn(images, "uploadImageDeferred");
    expect(new Uint8Array(await upload.mock.calls[0][1].arrayBuffer())).toEqual(bytes);
    expect(safeFetch.safeFetch).not.toHaveBeenCalled();
  });
});
