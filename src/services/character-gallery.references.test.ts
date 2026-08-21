import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { addToGallery, listGallery } from "./character-gallery.service";
import { createCharacter, getCharacter, updateCharacter } from "./characters.service";

const USER_ID = "gallery-reference-user";

describe("character gallery references", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    const baseline = await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text();
    getDb().run(baseline);
    getDb()
      .query(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)',
      )
      .run(USER_ID, "Gallery Reference", "gallery-reference@example.com");
  });

  afterEach(closeDatabase);

  test("backfills readable stable slots and rewrites the legacy item-id stub", () => {
    const character = createCharacter(USER_ID, { name: "Aster" });
    const galleryItemId = "22222222-2222-4222-8222-222222222222";
    const imageId = "33333333-3333-4333-8333-333333333333";
    getDb()
      .query("INSERT INTO images (id, filename, original_filename, mime_type, user_id) VALUES (?, ?, ?, ?, ?)")
      .run(imageId, "scene.webp", "scene.webp", "image/webp", USER_ID);
    getDb()
      .query(
        "INSERT INTO character_gallery (id, user_id, character_id, image_id, caption, sort_order, created_at) VALUES (?, ?, ?, ?, ?, 0, 0)",
      )
      .run(galleryItemId, USER_ID, character.id, imageId, "Opening scene");
    updateCharacter(USER_ID, character.id, {
      first_mes: `Welcome\n\n![Opening scene](gallery://${galleryItemId})`,
    });

    expect(listGallery(USER_ID, character.id)).toMatchObject([
      { id: galleryItemId, image_id: imageId, reference: "gallery://image-1" },
    ]);
    expect(getCharacter(USER_ID, character.id)).toMatchObject({
      first_mes: "Welcome\n\n![Opening scene](gallery://image-1)",
      extensions: {
        gallery_reference_sequence: 1,
        risu_asset_map: { "gallery://image-1": imageId },
      },
    });

    const secondImageId = "44444444-4444-4444-8444-444444444444";
    getDb()
      .query("INSERT INTO images (id, filename, original_filename, mime_type, user_id) VALUES (?, ?, ?, ?, ?)")
      .run(secondImageId, "closeup.webp", "closeup.webp", "image/webp", USER_ID);
    expect(addToGallery(USER_ID, character.id, secondImageId).reference).toBe("gallery://image-2");
  });
});
