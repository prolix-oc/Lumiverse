import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as chub from "../services/chub-api.service";
import { markChubExpressionsChecked } from "../services/chub-expression-import.service";
import * as images from "../services/images.service";
import { getCharacter, listCharacterSummaries, updateCharacter } from "../services/characters.service";
import { putExpressionConfig } from "../services/expressions.service";
import * as safeFetch from "../utils/safe-fetch";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { charactersRoutes } from "./characters.routes";

const USER_ID = "chub-backfill-user";
const CHARACTER_ID = "archived";
const LOCAL_EXTENSIONS = {
  _lumiverse_library_scope: "shared",
  _lumiverse_chub_slug: "author/archived-card",
  gallery_reference_sequence: 17,
  ttsVoice: { voice: "local-voice" },
  customMetadata: { keep: true },
};

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("userId", USER_ID);
  await next();
});
app.route("/", charactersRoutes);

beforeEach(async () => {
  closeDatabase();
  const db = initDatabase(":memory:");
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  const insert = db.query(`INSERT INTO characters
    (id, user_id, name, folder, extensions, library_scope, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'shared', 1, ?)`);
  insert.run("current-a", USER_ID, "A current card", "Current", "{}", 300);
  insert.run("current-b", USER_ID, "B current card", "Current", "{}", 200);
  insert.run(CHARACTER_ID, USER_ID, "Z archived card", "Archive", JSON.stringify(LOCAL_EXTENSIONS), 100);
  // Fail closed if a test forgets to replace external I/O.
  spyOn(chub, "fetchChubJson").mockRejectedValue(new Error("Unexpected Chub request"));
  spyOn(safeFetch, "safeFetch").mockRejectedValue(new Error("Unexpected image request"));
});

afterEach(() => {
  mock.restore();
  closeDatabase();
});

function galleryPages() {
  return ["recent", "most_chats", "name"].map((sort) =>
    listCharacterSummaries(USER_ID, { limit: 2, offset: 0 }, { sort, direction: "desc" }).data,
  );
}

function backfill(id = CHARACTER_ID) {
  return app.request(`http://localhost/${id}/chub-expressions`, { method: "POST" });
}

function mockPack(count: number) {
  const expressions = Object.fromEntries(Array.from({ length: count }, (_, i) =>
    [`label-${i}`, `https://example.com/${i}.png`],
  ));
  spyOn(chub, "fetchChubJson").mockResolvedValue({
    node: { definition: { extensions: { chub: { expressions: { expressions } } } } },
  });
  spyOn(safeFetch, "safeFetch").mockImplementation(async () =>
    new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
  );
}

function mockImageStorage(beforeBatch?: (batch: number) => void) {
  let nextId = 0;
  let batch = 0;
  return spyOn(images, "uploadImages").mockImplementation(async (userId, items) => {
    beforeBatch?.(++batch);
    return items.map((item) => {
      const id = `expression-${nextId++}`;
      getDb().query(`INSERT INTO images
        (id, user_id, filename, original_filename, mime_type, owner_character_id)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, userId, `${id}.png`, item.filename, item.mime_type, item.owner_character_id ?? null);
      return { id, image: images.getImage(userId, id)! };
    });
  });
}

describe("Chub expression backfill metadata", () => {
  test.each(["no pack", "404 source", "already mapped"])("%s preserves gallery pages and records the check quietly", async (outcome) => {
    if (outcome === "already mapped") {
      mockPack(1);
      getDb().query("UPDATE characters SET extensions = json_set(extensions, '$.expressions', json(?)) WHERE id = ?")
        .run(JSON.stringify({ enabled: true, defaultExpression: "label-0", mappings: { "label-0": "manual-image" } }), CHARACTER_ID);
    } else if (outcome === "404 source") {
      spyOn(chub, "fetchChubJson").mockRejectedValue(new Error("Chub API returned 404"));
    } else {
      spyOn(chub, "fetchChubJson").mockResolvedValue({ node: { definition: { extensions: {} } } });
    }
    const before = getCharacter(USER_ID, CHARACTER_ID)!;
    const beforePages = galleryPages();
    const emit = spyOn(eventBus, "emit");

    const response = await backfill();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ imported: 0, skipped: outcome === "already mapped" ? 1 : 0 });
    expect(getCharacter(USER_ID, CHARACTER_ID)).toEqual({
      ...before,
      extensions: { ...before.extensions, _lumiverse_chub_expressions_checked: expect.any(Number) },
    });
    expect(galleryPages()).toEqual(beforePages);
    expect(emit.mock.calls.filter(([type]) => type === EventType.CHARACTER_EDITED)).toHaveLength(0);
    expect(await (await app.request("http://localhost/chub-expression-candidates")).json())
      .toEqual({ candidates: [], count: 0 });
  });

  test("a multi-batch pack preserves metadata and publishes one complete expression update", async () => {
    mockPack(8);
    const upload = mockImageStorage();
    const before = getCharacter(USER_ID, CHARACTER_ID)!;
    const beforePages = galleryPages();
    const emit = spyOn(eventBus, "emit");

    const response = await backfill();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ imported: 8, skipped: 0, available: 8 });
    const after = getCharacter(USER_ID, CHARACTER_ID)!;
    expect({ ...after, extensions: before.extensions }).toEqual(before);
    expect(after.extensions).toMatchObject(LOCAL_EXTENSIONS);
    expect(Object.keys(after.extensions.expressions.mappings)).toHaveLength(8);
    expect(after.extensions._lumiverse_chub_expressions_checked).toEqual(expect.any(Number));
    expect(galleryPages()).toEqual(beforePages);
    expect(upload.mock.calls.map(([, items]) => items.length)).toEqual([4, 4]);
    const edits = emit.mock.calls.filter(([type]) => type === EventType.CHARACTER_EDITED);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.[1]).toMatchObject({ id: CHARACTER_ID, character: { extensions: { expressions: after.extensions.expressions } } });
    expect(edits[0]?.[2]).toBe(USER_ID);
  });

  test("publishes saved expressions if a later batch fails without touching recency", async () => {
    mockPack(8);
    mockImageStorage((batch) => {
      if (batch === 2) throw new Error("Image storage failed");
    });
    const before = getCharacter(USER_ID, CHARACTER_ID)!;
    const emit = spyOn(eventBus, "emit");

    const response = await backfill();

    expect(response.status).toBe(502);
    const after = getCharacter(USER_ID, CHARACTER_ID)!;
    expect({ ...after, extensions: before.extensions }).toEqual(before);
    expect(Object.keys(after.extensions.expressions.mappings)).toHaveLength(4);
    expect(after.extensions._lumiverse_chub_expressions_checked).toBeUndefined();
    const edits = emit.mock.calls.filter(([type]) => type === EventType.CHARACTER_EDITED);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.[1]).toEqual({ id: CHARACTER_ID, character: after });
  });

  test("keeps edits made while images are being stored, including their new timestamp", async () => {
    mockPack(8);
    const now = spyOn(Date, "now").mockReturnValue(1_000_000);
    let edited = getCharacter(USER_ID, CHARACTER_ID)!;
    mockImageStorage((batch) => {
      if (batch !== 1) return;
      now.mockReturnValue(2_000_000);
      edited = updateCharacter(USER_ID, CHARACTER_ID, {
        name: "Edited during import",
        folder: "Moved",
        extensions: { ...edited.extensions, customMetadata: { keep: "new value" } },
      })!;
      // Finishing later must neither touch the timestamp again nor restore
      // the snapshot from before the user's edit.
      now.mockReturnValue(3_000_000);
    });

    expect((await backfill()).status).toBe(200);

    const after = getCharacter(USER_ID, CHARACTER_ID)!;
    expect(edited.updated_at).toBe(2_000);
    expect({ ...after, extensions: edited.extensions }).toEqual(edited);
    expect(after.extensions.customMetadata).toEqual({ keep: "new value" });
  });

  test("does not publish a character edit when no images could be imported", async () => {
    mockPack(8);
    spyOn(safeFetch, "safeFetch").mockRejectedValue(new Error("Download failed"));
    const before = getCharacter(USER_ID, CHARACTER_ID)!;
    const emit = spyOn(eventBus, "emit");

    const response = await backfill();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ imported: 0, skipped: 0, available: 8 });
    expect(getCharacter(USER_ID, CHARACTER_ID)).toEqual({
      ...before,
      extensions: { ...before.extensions, _lumiverse_chub_expressions_checked: expect.any(Number) },
    });
    expect(emit.mock.calls.filter(([type]) => type === EventType.CHARACTER_EDITED)).toHaveLength(0);
  });

  test("ordinary expression edits still update recency and notify clients", () => {
    const emit = spyOn(eventBus, "emit");
    putExpressionConfig(USER_ID, CHARACTER_ID, {
      enabled: true, defaultExpression: "joy", mappings: { joy: "manual-image" },
    });
    expect(getCharacter(USER_ID, CHARACTER_ID)?.updated_at).toBeGreaterThan(100);
    expect(emit.mock.calls.filter(([type]) => type === EventType.CHARACTER_EDITED)).toHaveLength(1);
  });

  test("cannot update a different user's character", async () => {
    getDb().query("UPDATE characters SET user_id = 'other-user' WHERE id = ?").run(CHARACTER_ID);
    const before = getCharacter("other-user", CHARACTER_ID);
    expect((await backfill()).status).toBe(404);
    markChubExpressionsChecked(USER_ID, CHARACTER_ID);
    expect(getCharacter("other-user", CHARACTER_ID)).toEqual(before);
  });
});
