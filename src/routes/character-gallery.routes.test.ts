import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { addToGallery } from "../services/character-gallery.service";
import { createCharacter } from "../services/characters.service";
import { characterGalleryRoutes } from "./character-gallery.routes";

const USER_ID = "gallery-route-user";

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("userId", USER_ID);
  await next();
});
app.route("/characters/:characterId/gallery", characterGalleryRoutes);

describe("character gallery reference routes", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
    getDb()
      .query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)')
      .run(USER_ID, "Gallery Route", "gallery-route@example.com");
  });

  afterEach(closeDatabase);

  test('gallery removal reports completion and rejects an item under a different character path', async () => {
    const character = createCharacter(USER_ID, { name: 'Aster' });
    const other = createCharacter(USER_ID, { name: 'Other' });
    const imageId = crypto.randomUUID();
    getDb().query('INSERT INTO images (id, user_id, filename, original_filename) VALUES (?, ?, ?, ?)').run(imageId, USER_ID, 'missing.png', 'missing.png');
    const item = addToGallery(USER_ID, character.id, imageId);
    expect((await app.request(`/characters/${other.id}/gallery/${item.id}`, { method: 'DELETE' })).status).toBe(404);
    const response = await app.request(`/characters/${character.id}/gallery/${item.id}`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, id: item.id, characterId: character.id, imageId, status: 'completed' });
    const status = await app.request(`/characters/${character.id}/gallery/${item.id}/deletion-status`);
    expect(status.headers.get('Cache-Control')).toBe('no-store');
    expect(await status.json()).toMatchObject({ deleted: true });
  });

  test("renames a gallery reference through the character-scoped endpoint", async () => {
    const character = createCharacter(USER_ID, { name: "Aster" });
    const imageId = "88888888-8888-4888-8888-888888888888";
    getDb()
      .query("INSERT INTO images (id, filename, original_filename, mime_type, user_id) VALUES (?, ?, ?, ?, ?)")
      .run(imageId, "garden.webp", "garden.webp", "image/webp", USER_ID);
    const item = addToGallery(USER_ID, character.id, imageId);

    const response = await app.request(
      `http://localhost/characters/${character.id}/gallery/${item.id}/reference`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Moonlit Garden" }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: item.id,
      reference: "gallery://moonlit-garden",
    });
  });
});
