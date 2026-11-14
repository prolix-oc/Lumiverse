import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import * as images from "./images.service";
import { createCharacter, getCharacter } from "./characters.service";
import { embedPngTextChunk, exportAsCharx } from "./character-export.service";
import { createEntry, createWorldBook, listEntries } from "./world-books.service";
import { createRegexScript, getRegexScriptsByCharacterId } from "./regex-scripts.service";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../utils/character-world-books";
import {
  applySelectiveCardUpdate,
  buildCardUpdatePreview,
  findMatchingCharactersForCard,
  parseCardBundle,
} from "./character-card-update.service";

const USER_ID = "card-update-test-user";
const ONE_BY_ONE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==";
const originalDataDir = env.dataDir;
let testDataDir = "";

beforeEach(async () => {
  closeDatabase();
  const db = initDatabase(":memory:");
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  testDataDir = mkdtempSync(join(tmpdir(), "lumiverse-card-update-test-"));
  env.dataDir = testDataDir;
  let imageSeq = 0;
  spyOn(images, "uploadImage").mockImplementation(async (userId, file) => {
    const id = `test-img-${++imageSeq}`;
    const filename = `${id}.png`;
    db.query("INSERT INTO images (id, user_id, filename, original_filename, mime_type) VALUES (?, ?, ?, ?, ?)")
      .run(id, userId, filename, file.name || filename, file.type || "image/png");
    return images.getImage(userId, id)!;
  });
});

afterEach(() => {
  mock.restore();
  closeDatabase();
  env.dataDir = originalDataDir;
  if (testDataDir) {
    if (dirname(resolve(testDataDir)) !== resolve(tmpdir()) || !basename(testDataDir).startsWith("lumiverse-card-update-test-")) {
      throw new Error("Unsafe temporary directory");
    }
    rmSync(testDataDir, { recursive: true, force: true });
    testDataDir = "";
  }
});

function makeJsonCard(filename: string, data: Record<string, any>): File {
  return new File(
    [JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data })],
    filename,
    { type: "application/json" },
  );
}

function makePngCard(filename: string, data: Record<string, any>): File {
  const cardJson = JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data });
  const pngBuffer = embedPngTextChunk(
    Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"),
    "ccv3",
    Buffer.from(cardJson, "utf-8").toString("base64"),
  );
  return new File([new Uint8Array(pngBuffer)], filename, { type: "image/png" });
}

describe("character-card-update.service", () => {
  test("findMatchingCharactersForCard prioritizes source filename, then name+creator, then name, skipping deleting rows", async () => {
    const byName = createCharacter(USER_ID, { name: "Lyra", creator: "OtherAuthor" });
    const byNameCreator = createCharacter(USER_ID, { name: "Lyra", creator: "Arch" });
    const byFilename = createCharacter(USER_ID, {
      name: "Lyra Renamed",
      creator: "Arch",
      extensions: { _lumiverse_source_filename: "lyra_v2.png" },
    });
    const deleted = createCharacter(USER_ID, { name: "Lyra", creator: "Arch" });
    getDb().query("UPDATE characters SET deleting = 1 WHERE id = ?").run(deleted.id);

    const parsed = await parseCardBundle(
      makePngCard("lyra_v2.png", { name: "Lyra", creator: "Arch", description: "Updated" }),
    );
    const matches = await findMatchingCharactersForCard(USER_ID, parsed.filename, parsed.cardInput);

    expect(matches.map((m) => [m.id, m.matchReason])).toEqual([
      [byFilename.id, "source_filename"],
      [byNameCreator.id, "name_and_creator"],
      [byName.id, "name"],
    ]);
  });

  test("appends only new alternate greetings and demotes replaced first_mes while preserving local state", async () => {
    const existing = createCharacter(USER_ID, {
      name: "Aria",
      description: "My edited local description",
      first_mes: "Old main greeting",
      alternate_greetings: ["Existing alt 1", "Shared alt"],
      tags: ["local-tag"],
      extensions: {
        ttsVoice: { connectionId: "conn-1", voice: "AriaVoice" },
        greeting_tools: {
          mainGreeting: { id: "g_main", title: "Original Main" },
          indexMap: { "0": "g_0", "1": "g_1" },
          greetings: {
            g_0: { id: "g_0", title: "Alt Zero" },
            g_1: { id: "g_1", title: "Shared Title" },
          },
        },
      },
    });

    const parsed = await parseCardBundle(
      makeJsonCard("aria_v2.json", {
        name: "Aria v2",
        description: "Author new description",
        first_mes: "Brand new main greeting",
        alternate_greetings: ["Shared alt", "Brand new alt 2", "Existing alt 1"],
        tags: ["local-tag", "author-new-tag"],
      }),
    );

    const { character: updated, summary } = await applySelectiveCardUpdate(USER_ID, existing, parsed, {
      fields: [], // Keep local description & name untouched
      firstMesMode: "replace_and_demote",
      alternateGreetingsMode: "append_new",
      tagsMode: "merge",
    });

    expect(updated.name).toBe("Aria");
    expect(updated.description).toBe("My edited local description");
    expect(updated.first_mes).toBe("Brand new main greeting");
    expect(updated.alternate_greetings).toEqual([
      "Existing alt 1",
      "Shared alt",
      "Brand new alt 2",
      "Old main greeting",
    ]);
    expect(updated.tags).toEqual(["local-tag", "author-new-tag"]);
    expect(updated.extensions.ttsVoice).toEqual({ connectionId: "conn-1", voice: "AriaVoice" });
    // Greeting tools indexMap for kept existing indices stays intact
    expect(updated.extensions.greeting_tools.indexMap).toEqual({ "0": "g_0", "1": "g_1" });
    expect(updated.extensions.greeting_tools.mainGreeting).toBeNull();
    expect(summary.demotedFirstMes).toBe(true);
    expect(summary.addedAlternateGreetings).toBe(1);
  });

  test("custom greeting selection remaps greeting_tools indices when an existing greeting is removed", async () => {
    const existing = createCharacter(USER_ID, {
      name: "Remap",
      alternate_greetings: ["Drop me", "Keep me"],
      extensions: {
        greeting_tools: {
          indexMap: { "0": "g_drop", "1": "g_keep" },
          greetings: {
            g_drop: { id: "g_drop", title: "Dropped" },
            g_keep: { id: "g_keep", title: "Kept" },
          },
        },
      },
    });

    const parsed = await parseCardBundle(
      makeJsonCard("remap.json", {
        name: "Remap",
        alternate_greetings: ["Incoming A", "Incoming B"],
      }),
    );

    const { character: updated } = await applySelectiveCardUpdate(USER_ID, existing, parsed, {
      alternateGreetingsMode: "select",
      keepExistingGreetingIndices: [1],
      selectedIncomingGreetingIndices: [1],
    });

    expect(updated.alternate_greetings).toEqual(["Keep me", "Incoming B"]);
    expect(updated.extensions.greeting_tools.indexMap).toEqual({ "0": "g_keep" });
    expect(updated.extensions.greeting_tools.greetings).toEqual({
      g_keep: { id: "g_keep", title: "Kept" },
    });
  });

  test("PNG avatar update supports adding as alternate avatar and replacing primary avatar", async () => {
    const existing = createCharacter(USER_ID, { name: "Pix" });
    const parsed = await parseCardBundle(makePngCard("pix.png", { name: "Pix", creator: "Maker" }));
    const preview = await buildCardUpdatePreview(parsed);
    expect(preview.hasAvatar).toBe(true);
    expect(preview.avatarPreviewUrl).toMatch(/^data:image\/png;base64,/);

    const withAlt = await applySelectiveCardUpdate(USER_ID, existing, parsed, {
      avatarMode: "add_alternate",
    });
    expect(withAlt.character.image_id).toBeNull();
    expect(withAlt.character.extensions.alternate_avatars).toHaveLength(1);
    expect(withAlt.character.extensions.alternate_avatars[0].label).toBe("Pix (Imported)");

    const withPrimary = await applySelectiveCardUpdate(USER_ID, withAlt.character, parsed, {
      avatarMode: "replace_primary",
    });
    expect(withPrimary.character.image_id).toBeTruthy();
    expect(withPrimary.summary.avatarUpdated).toBe("replace_primary");
  });

  test("imports worldbooks and merges/replaces character regex scripts without duplicating", async () => {
    const existingBook = createWorldBook(USER_ID, { name: "Existing Book" });
    const existing = createCharacter(USER_ID, {
      name: "LoreChar",
      extensions: setCharacterWorldBookIds({}, [existingBook.id]),
    });
    createRegexScript(USER_ID, {
      name: "Same Script",
      find_regex: "foo",
      replace_string: "bar",
      scope: "character",
      scope_id: existing.id,
      character_id: existing.id,
    });

    const parsed = await parseCardBundle(
      makeJsonCard("lore.json", {
        name: "LoreChar",
        character_book: {
          name: "New Book",
          entries: [{ keys: ["dragon"], content: "Dragons breathe fire.", enabled: true }],
        },
        extensions: {
          regex_scripts: [
            { scriptName: "Same Script", findRegex: "foo", replaceString: "bar", placement: [2] },
            { scriptName: "Brand New Script", findRegex: "baz", replaceString: "qux", placement: [2] },
          ],
        },
      }),
    );

    const preview = await buildCardUpdatePreview(parsed);
    expect(preview.extras.embeddedLorebookEntries).toBe(1);
    expect(preview.extras.regexScriptCount).toBe(2);

    const { character: updated, summary } = await applySelectiveCardUpdate(USER_ID, existing, parsed, {
      worldBookMode: "import_new",
      regexMode: "merge_new",
    });

    const linkedIds = getCharacterWorldBookIds(updated.extensions);
    expect(linkedIds).toHaveLength(2);
    expect(linkedIds[0]).toBe(existingBook.id);
    expect(listEntries(USER_ID, linkedIds[1])).toHaveLength(1);
    expect(summary.worldBooksImported).toBe(1);
    expect(summary.regexScriptsImported).toBe(1);
    expect(getRegexScriptsByCharacterId(USER_ID, existing.id)).toHaveLength(2);
  });

  test("supports CHARX preview and selective merge of modules while preserving unchosen fields", async () => {
    const sourceBook = createWorldBook(USER_ID, { name: "Charx Lore" });
    createEntry(USER_ID, sourceBook.id, { content: "Skyship lore", key: ["skyship"] });

    const sourceChar = createCharacter(USER_ID, {
      name: "SkyCaptain",
      description: "Author updated bio",
      first_mes: "Welcome aboard!",
      alternate_greetings: ["New greeting from charx"],
      extensions: {
        ...setCharacterWorldBookIds({}, [sourceBook.id]),
        alternate_fields: {
          personality: [{ id: "v1", label: "Stern", content: "Strict captain" }],
        },
      },
    });
    const archive = await exportAsCharx(USER_ID, sourceChar.id);
    expect(archive).not.toBeNull();

    const target = createCharacter(USER_ID, {
      name: "SkyCaptain",
      description: "My custom local bio",
      first_mes: "Original greeting",
      alternate_greetings: ["Local alt"],
    });

    const charxFile = new File([new Uint8Array(archive!)], "skycaptain.charx", { type: "application/zip" });
    const parsed = await parseCardBundle(charxFile);
    const preview = await buildCardUpdatePreview(parsed);
    expect(preview.format).toBe("charx");
    expect(preview.extras.lumiverseWorldBookCount).toBe(1);
    expect(preview.extras.alternateFieldKeys).toEqual(["personality"]);

    const { character: updated } = await applySelectiveCardUpdate(USER_ID, target, parsed, {
      fields: [], // Keep local bio
      alternateGreetingsMode: "append_new",
      worldBookMode: "import_new",
      charxAssetsMode: "merge",
    });

    const latest = getCharacter(USER_ID, updated.id)!;
    expect(latest.description).toBe("My custom local bio");
    expect(latest.first_mes).toBe("Original greeting");
    expect(latest.alternate_greetings).toEqual(["Local alt", "New greeting from charx"]);
    expect(latest.extensions.alternate_fields?.personality).toHaveLength(1);
    expect(getCharacterWorldBookIds(latest.extensions)).toHaveLength(1);
  });
});
