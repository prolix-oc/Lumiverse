import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { zipSync } from "fflate";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { expressionsRoutes } from "../routes/expressions.routes";
import { getCharacter } from "./characters.service";
import * as images from "./images.service";
import * as expressions from "./expressions.service";
import { applyCharxModulesAndAssets } from "./charx-import.service";
import type { CharxResult } from "./character-card.service";

const userId = "expression-avatar-user";
const characterId = "expression-avatar-character";
const legacy = { enabled: true, defaultExpression: "neutral", mappings: { neutral: "neutral-image" } };
const png = new File([Uint8Array.from([1, 2, 3])], "happy.png", { type: "image/png" });
const app = new Hono();
app.use("*", async (c, next) => { c.set("userId", userId); await next(); });
app.route("/:characterId/expressions", expressionsRoutes);

beforeEach(async () => {
  closeDatabase();
  const db = initDatabase(":memory:");
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  db.query("INSERT INTO characters (id, user_id, name, extensions, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)")
    .run(characterId, userId, "Character", JSON.stringify({ expressions: legacy, unrelated: "keep" }));
  let imageIndex = 0;
  const storeImage = (filename: string) => {
    const id = `uploaded-${++imageIndex}`;
    db.query("INSERT INTO images (id, user_id, filename, original_filename, mime_type) VALUES (?, ?, ?, ?, 'image/png')")
      .run(id, userId, filename, filename);
    return images.getImage(userId, id)!;
  };
  // Exercise real expression persistence without writing images or starting processing jobs.
  spyOn(images, "uploadImage").mockImplementation(async (_userId, file) => storeImage(file.name));
  spyOn(images, "uploadImages").mockImplementation(async (_userId, files) => files.map(file => {
    const image = storeImage(file.filename);
    return { id: image.id, image };
  }));
});

afterEach(() => { mock.restore(); closeDatabase(); });

function read() { return expressions.getExpressionConfig(userId, characterId)!; }
function optIn() { expressions.putExpressionConfig(userId, characterId, { ...legacy, useAsAvatar: true }); }

describe("persisted expression avatar preference", () => {
  test("GET normalizes legacy and missing expression config to false", async () => {
    const response = await app.request(`http://localhost/${characterId}/expressions`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...legacy, useAsAvatar: false });
    getDb().query("UPDATE characters SET extensions = '{}' WHERE id = ?").run(characterId);
    expect(read()).toEqual({ enabled: false, useAsAvatar: false, defaultExpression: "", mappings: {} });
  });

  test("PUT/read round-trip preserves true and supports explicit opt-out", async () => {
    for (const useAsAvatar of [true, false]) {
      const response = await app.request(`http://localhost/${characterId}/expressions`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...legacy, useAsAvatar }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).useAsAvatar).toBe(useAsAvatar);
      expect(read().useAsAvatar).toBe(useAsAvatar);
      expect(getCharacter(userId, characterId)?.extensions.unrelated).toBe("keep");
    }
  });

  test("older clients updating config without the preference preserve the stored value", () => {
    optIn();
    expressions.putExpressionConfig(userId, characterId, { ...legacy, enabled: false });
    expect(read().useAsAvatar).toBe(true);
    expect(read().enabled).toBe(false);
  });

  test("ZIP, gallery, removal, direct assets and remote batches retain opt-in", async () => {
    optIn();
    const operations = [
      () => expressions.importFromZip(userId, characterId, Buffer.from(zipSync({ "happy.png": Uint8Array.from([1, 2, 3]) }))),
      () => expressions.mapFromGallery(userId, characterId, { sad: "gallery-image" }),
      () => expressions.removeExpression(userId, characterId, "neutral"),
      () => expressions.importFromAssets(userId, characterId, [{ label: "surprised", file: png }]),
      () => expressions.importFromImageData(userId, characterId, [{ label: "remote", data: Uint8Array.from([1]), filename: "remote.png", mimeType: "image/png" }]),
    ];
    for (const operation of operations) {
      await operation();
      expect(read().useAsAvatar).toBe(true);
    }
    expect(Object.keys(read().mappings)).toEqual(["happy", "sad", "surprised", "remote"]);
  });

  test("flat/group conversion and group edits preserve the dormant preference", () => {
    optIn();
    expressions.convertToGroups(userId, characterId);
    expect(read()).toMatchObject({ enabled: false, useAsAvatar: true, mappings: {} });
    expressions.putExpressionGroups(userId, characterId, { Character: { happy: "group-happy" } });
    expect(read().useAsAvatar).toBe(true);
    expressions.convertToFlat(userId, characterId, "Character");
    expect(read()).toMatchObject({ enabled: true, useAsAvatar: true, mappings: { happy: "group-happy" } });
  });

  test("CharX module asset import preserves the local preference", async () => {
    optIn();
    const bundle: CharxResult = {
      card: { name: "Imported" }, avatarFile: null, galleryFiles: [], risuModule: null,
      expressionAssets: [], expressionGroupAnalysis: null, polyglotJpegAvatar: null,
      assetFiles: new Map([["assets/happy.png", png]]),
      lumiverseModules: { version: 1, expressions: { enabled: true, defaultExpression: "happy", mappings: { happy: "assets/happy.png" } } },
    };
    await applyCharxModulesAndAssets(userId, getCharacter(userId, characterId)!, bundle, { importWorldBooks: false });
    expect(read()).toMatchObject({ useAsAvatar: true, defaultExpression: "happy", mappings: { happy: "uploaded-1" } });
  });
});
