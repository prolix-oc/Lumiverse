import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import { extractCardFromCharx } from "./character-card.service";
import { exportAsCharx } from "./character-export.service";
import { addToGallery, listGallery, renameGalleryReference } from "./character-gallery.service";
import { applyCharxModulesAndAssets } from "./charx-import.service";
import {
  createCharacter,
  getCharacter,
  setCharacterImage,
  updateCharacter,
} from "./characters.service";
import {
  resetDeferredImageProcessingForTests,
  uploadImage,
  waitForDeferredImageProcessing,
} from "./images.service";

const USER_ID = "charx-greeting-round-trip-user";
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==",
  "base64",
);
const originalDataDir = env.dataDir;
let testDataDir = "";

async function uploadTestImage(name: string) {
  return uploadImage(
    USER_ID,
    new File([ONE_BY_ONE_PNG], name, { type: "image/png" }),
    { skip_thumbnail_processing: true },
  );
}

describe("CHARX greeting metadata and backgrounds", () => {
  beforeEach(async () => {
    resetDeferredImageProcessingForTests();
    closeDatabase();
    initDatabase(":memory:");
    const baseline = await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text();
    getDb().run(baseline);
    getDb()
      .query(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)',
      )
      .run(USER_ID, "CHARX Test", "charx-test@example.com");
    testDataDir = mkdtempSync(join(tmpdir(), "lumiverse-charx-greetings-"));
    env.dataDir = testDataDir;
  });

  afterEach(() => {
    resetDeferredImageProcessingForTests();
    closeDatabase();
    env.dataDir = originalDataDir;
    if (testDataDir) {
      rmSync(testDataDir, { recursive: true, force: true });
      testDataDir = "";
    }
  });

  test("restores bundled greeting backgrounds and preserves source and titles", async () => {
    const character = createCharacter(USER_ID, {
      name: "Portable Character",
      first_mes: "Hello",
      alternate_greetings: ["Welcome back"],
      extensions: {
        chub: {
          full_path: "Creator/Portable-Character",
          unknown_source_field: "keep me",
        },
        greeting_tools: {
          mainGreeting: {
            id: "main-id",
            title: "First Meeting",
            description: "keep main description",
          },
          indexMap: { 0: "alternate-id" },
          greetings: {
            "alternate-id": {
              id: "alternate-id",
              title: "Welcome Back",
              contentHash: 42,
            },
          },
          unknown_greeting_tools_field: "keep me too",
        },
      },
    });
    const avatar = await uploadTestImage("avatar.png");
    setCharacterImage(USER_ID, character.id, avatar.id);
    const background = await uploadTestImage("greeting-background.png");
    addToGallery(USER_ID, character.id, background.id);
    updateCharacter(USER_ID, character.id, {
      extensions: {
        ...character.extensions,
        greeting_backgrounds: { 0: background.id, 1: background.id },
      },
    });

    const archive = await exportAsCharx(USER_ID, character.id);
    expect(archive).not.toBeNull();
    const archiveBytes = new Uint8Array(archive!.byteLength);
    archiveBytes.set(archive!);
    const extracted = await extractCardFromCharx(
      new File([archiveBytes], "portable-character.charx", { type: "application/zip" }),
    );
    expect(extracted.card.extensions).toMatchObject({
      chub: {
        full_path: "Creator/Portable-Character",
        unknown_source_field: "keep me",
      },
      greeting_tools: {
        mainGreeting: {
          id: "main-id",
          title: "First Meeting",
          description: "keep main description",
        },
        greetings: {
          "alternate-id": {
            id: "alternate-id",
            title: "Welcome Back",
            contentHash: 42,
          },
        },
        unknown_greeting_tools_field: "keep me too",
      },
      greeting_backgrounds: {
        0: "gallery://image-1",
        1: "gallery://image-1",
      },
    });

    const imported = createCharacter(USER_ID, extracted.card);
    await applyCharxModulesAndAssets(USER_ID, imported, extracted);
    await waitForDeferredImageProcessing();

    const roundTripped = getCharacter(USER_ID, imported.id)!;
    const importedBackgroundId = roundTripped.extensions.greeting_backgrounds[0];
    expect(importedBackgroundId).toBeString();
    expect(importedBackgroundId).not.toBe(background.id);
    expect(roundTripped.extensions.greeting_backgrounds).toEqual({
      0: importedBackgroundId,
      1: importedBackgroundId,
    });
    expect(listGallery(USER_ID, imported.id).map((item) => item.image_id)).toContain(importedBackgroundId);
    expect(roundTripped.extensions.chub).toEqual({
      full_path: "Creator/Portable-Character",
      unknown_source_field: "keep me",
    });
    expect(roundTripped.extensions.greeting_tools).toMatchObject({
      mainGreeting: { id: "main-id", title: "First Meeting" },
      greetings: { "alternate-id": { id: "alternate-id", title: "Welcome Back", contentHash: 42 } },
      unknown_greeting_tools_field: "keep me too",
    });
  });

  test("round-trips a custom gallery reference to a new local image ID", async () => {
    const character = createCharacter(USER_ID, {
      name: "Named Gallery Character",
    });
    const avatar = await uploadTestImage("named-gallery-avatar.png");
    setCharacterImage(USER_ID, character.id, avatar.id);
    const image = await uploadTestImage("opening-scene.png");
    const item = addToGallery(USER_ID, character.id, image.id, "Opening scene");
    updateCharacter(USER_ID, character.id, {
      first_mes: `![Opening scene](${item.reference})`,
    });
    renameGalleryReference(USER_ID, character.id, item.id, "Opening Scene");

    const archive = await exportAsCharx(USER_ID, character.id);
    expect(archive).not.toBeNull();
    const archiveBytes = new Uint8Array(archive!.byteLength);
    archiveBytes.set(archive!);
    const extracted = await extractCardFromCharx(
      new File([archiveBytes], "named-gallery.charx", { type: "application/zip" }),
    );
    expect(extracted.card.first_mes).toBe("![Opening scene](gallery://opening-scene)");
    expect([...extracted.assetFiles.keys()]).toContain(
      "assets/other/image/gallery_opening-scene.png",
    );

    const imported = createCharacter(USER_ID, extracted.card);
    await applyCharxModulesAndAssets(USER_ID, imported, extracted);
    await waitForDeferredImageProcessing();

    const importedItem = listGallery(USER_ID, imported.id).find(
      (galleryItem) => galleryItem.reference === "gallery://opening-scene",
    );
    expect(importedItem).toBeDefined();
    expect(importedItem!.image_id).not.toBe(image.id);
    expect(getCharacter(USER_ID, imported.id)).toMatchObject({
      first_mes: "![Opening scene](gallery://opening-scene)",
      extensions: {
        gallery_reference_names: {
          [importedItem!.image_id]: "gallery://opening-scene",
        },
        risu_asset_map: {
          "gallery://opening-scene": importedItem!.image_id,
        },
      },
    });
  });
});
