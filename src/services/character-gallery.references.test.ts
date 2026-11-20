import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  addToGallery,
  GalleryReferenceConflictError,
  listGallery,
  renameGalleryReference,
} from "./character-gallery.service";
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

  test("assigns a custom primary name, rewrites card content, and preserves old aliases", () => {
    const character = createCharacter(USER_ID, { name: "Aster" });
    const imageId = "55555555-5555-4555-8555-555555555555";
    getDb()
      .query("INSERT INTO images (id, filename, original_filename, mime_type, user_id) VALUES (?, ?, ?, ?, ?)")
      .run(imageId, "beach.webp", "beach.webp", "image/webp", USER_ID);
    const item = addToGallery(USER_ID, character.id, imageId);
    updateCharacter(USER_ID, character.id, {
      first_mes: `![Scene](${item.reference})`,
      alternate_greetings: [`Again: ${item.reference}`],
      extensions: {
        ...getCharacter(USER_ID, character.id)!.extensions,
        custom_gallery_note: item.reference,
      },
    });

    expect(renameGalleryReference(USER_ID, character.id, item.id, "  Beach R\u00e9union  ")).toMatchObject({
      id: item.id,
      reference: "gallery://beach-reunion",
    });
    expect(listGallery(USER_ID, character.id)[0].reference).toBe("gallery://beach-reunion");
    expect(listGallery(USER_ID, character.id, { registerReferences: false })[0].reference).toBe("gallery://beach-reunion");
    expect(getCharacter(USER_ID, character.id)).toMatchObject({
      first_mes: "![Scene](gallery://beach-reunion)",
      alternate_greetings: ["Again: gallery://beach-reunion"],
      extensions: {
        custom_gallery_note: "gallery://beach-reunion",
        gallery_reference_names: { [imageId]: "gallery://beach-reunion" },
        risu_asset_map: {
          "gallery://beach-reunion": imageId,
          "gallery://image-1": imageId,
        },
      },
    });
  });

  test("rejects a custom name already assigned to another gallery image", () => {
    const character = createCharacter(USER_ID, { name: "Aster" });
    const imageIds = [
      "66666666-6666-4666-8666-666666666666",
      "77777777-7777-4777-8777-777777777777",
    ];
    for (const imageId of imageIds) {
      getDb()
        .query("INSERT INTO images (id, filename, original_filename, mime_type, user_id) VALUES (?, ?, ?, ?, ?)")
        .run(imageId, `${imageId}.webp`, `${imageId}.webp`, "image/webp", USER_ID);
    }
    const first = addToGallery(USER_ID, character.id, imageIds[0]);
    const second = addToGallery(USER_ID, character.id, imageIds[1]);
    renameGalleryReference(USER_ID, character.id, first.id, "portrait");

    expect(() => renameGalleryReference(USER_ID, character.id, second.id, "Portrait")).toThrow(
      GalleryReferenceConflictError,
    );
  });
});
