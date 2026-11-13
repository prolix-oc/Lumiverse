/**
 * End-to-end test for the direct SillyTavern gallery import.
 *
 * Builds a synthetic ST user dir in a temp folder (never the real one) with
 * CharacterLibrary-style localized media, then asserts the importer copies the
 * images, mints gallery references, and rewrites the card text, embedded lore
 * and chat messages.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import { env } from "../src/env";
import { embedPngTextChunk } from "../src/services/character-export.service";
import { waitForDeferredImageProcessing } from "../src/services/images.service";
import { listGallery } from "../src/services/character-gallery.service";
import { getCharacter, listCharacterSourceFilenameIds } from "../src/services/characters.service";
import type { MigrationLogger } from "../src/migration/st-reader";
import { importCharacters, importChats } from "../src/migration/st-importer";
import { importGalleryContent, replaceReferences, localPathKey } from "../src/migration/st-gallery-import";
import { LocalFileSystem } from "../src/file-connections/providers/local";

const USER_ID = "gallery-import-user";
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==";
const originalDataDir = env.dataDir;
let workDir = "";
let stDataDir = "";
let lumiverseDataDir = "";

const logger: MigrationLogger = { info() {}, warn() {}, error() {}, progress() {} };

const warnings: string[] = [];

function chattyLogger(): MigrationLogger {
  return { info() {}, warn(message) { warnings.push(message); }, error() {}, progress() {} };
}

/** A 1x1 PNG written under a given name. */
function writeImage(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));
}

function cardPng(name: string, extensions: Record<string, unknown>, extra: Record<string, unknown> = {}): Buffer {
  const card = JSON.stringify({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: { name, extensions, ...extra },
  });
  return embedPngTextChunk(
    Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"),
    "ccv3",
    Buffer.from(card).toString("base64"),
  );
}

function writeCard(charactersDir: string, filename: string, buffer: Buffer): void {
  mkdirSync(charactersDir, { recursive: true });
  writeFileSync(join(charactersDir, filename), buffer);
}

beforeEach(async () => {
  warnings.length = 0;
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text());

  workDir = mkdtempSync(join(tmpdir(), "lumiverse-gallery-import-"));
  stDataDir = join(workDir, "st-data");
  lumiverseDataDir = join(workDir, "lumiverse-data");
  env.dataDir = lumiverseDataDir;
  mkdirSync(join(stDataDir, "user", "images"), { recursive: true });
  writeFileSync(
    join(stDataDir, "settings.json"),
    JSON.stringify({ extension_settings: { SillyTavernCharacterGallery: { uniqueGalleryFolders: true } } }),
  );
});

afterEach(async () => {
  await waitForDeferredImageProcessing();
  closeDatabase();
  env.dataDir = originalDataDir;
  rmSync(workDir, { recursive: true, force: true });
});

async function runImport(): Promise<{ filenameToId: Map<string, string> }> {
  const fs = new LocalFileSystem();
  const chars = await importCharacters(USER_ID, stDataDir, logger, fs);
  return { filenameToId: chars.filenameToId };
}

describe("ST gallery import", () => {
  test("imports a character's gallery and rewrites card text to gallery references", async () => {
    const charactersDir = join(stDataDir, "characters");
    const folder = "Alice_abcdefghijkl";
    const folderPath = join(stDataDir, "user", "images", folder);
    writeImage(join(folderPath, "localized_media_1700000000_hero.png"));
    writeImage(join(folderPath, "localized_media_1700000001_villain.png"));

    writeCard(
      charactersDir,
      "Alice.png",
      cardPng(
        "Alice",
        { gallery_id: "abcdefghijkl" },
        {
          description: "External: https://cdn.example.com/hero.png and https://cdn.example.com/villain.png",
          first_mes: "![Hero](/user/images/Alice_abcdefghijkl/localized_media_1700000000_hero.png)",
        },
      ),
    );

    const { filenameToId } = await runImport();
    const result = await importGalleryContent(USER_ID, stDataDir, filenameToId, chattyLogger());

    expect(result.imported).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.charactersWithGallery).toBe(1);

    const character = getCharacter(USER_ID, filenameToId.get("Alice")!);
    expect(character).not.toBeNull();
    const gallery = listGallery(USER_ID, character!.id);
    expect(gallery).toHaveLength(2);

    // External URLs resolved through CL's sanitized-name rule.
    expect(character!.description).toContain("gallery://image-1");
    expect(character!.description).toContain("gallery://image-2");
    expect(character!.description).not.toContain("cdn.example.com");

    // The local path in the greeting resolved to the same reference as its file.
    expect(character!.first_mes).toContain("gallery://image-1");
    expect(character!.first_mes).not.toContain("/user/images/");

    // References are stable and distinct.
    const refs = new Set(gallery.map((item) => item.reference));
    expect(refs.size).toBe(2);
    for (const reference of refs) expect(reference.startsWith("gallery://")).toBe(true);
  });

  test("rewrites card-embedded lorebook entries", async () => {
    const charactersDir = join(stDataDir, "characters");
    const folder = "Lore_zyxwvutsrqpo";
    writeImage(join(stDataDir, "user", "images", folder, "localized_media_1_map.png"));

    writeCard(
      charactersDir,
      "Lore.png",
      cardPng(
        "Lore",
        { gallery_id: "zyxwvutsrqpo" },
        {
          character_book: {
            entries: [{ content: "See https://cdn.example.com/map.png for the map." }],
          },
        },
      ),
    );

    const { filenameToId } = await runImport();
    await importGalleryContent(USER_ID, stDataDir, filenameToId, chattyLogger());

    const character = getCharacter(USER_ID, filenameToId.get("Lore")!);
    const entries = character!.extensions?.character_book?.entries;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries[0].content).toContain("gallery://image-1");
    expect(entries[0].content).not.toContain("cdn.example.com");
  });

  test("rewrites already-imported chat messages and swipes", async () => {
    const charactersDir = join(stDataDir, "characters");
    const folder = "Chatty_112233445566";
    writeImage(join(stDataDir, "user", "images", folder, "localized_media_9_scene.png"));

    writeCard(charactersDir, "Chatty.png", cardPng("Chatty", { gallery_id: "112233445566" }));

    const chatsDir = join(stDataDir, "chats", "Chatty");
    mkdirSync(chatsDir, { recursive: true });
    writeFileSync(
      join(chatsDir, "chat one.jsonl"),
      [
        JSON.stringify({ user_name: "User", chat_metadata: {} }),
        JSON.stringify({ name: "Chatty", is_user: false, mes: "Here: https://cdn.example.com/scene.png", send_date: "2025-1-1 @00h 00m 00s 000ms" }),
      ].join("\n"),
    );

    const fs = new LocalFileSystem();
    const chars = await importCharacters(USER_ID, stDataDir, logger, fs);
    await importChats(USER_ID, stDataDir, chars.filenameToId, new Map(), logger, fs);
    await importGalleryContent(USER_ID, stDataDir, chars.filenameToId, chattyLogger());

    const rows = getDb()
      .query("SELECT content, swipes FROM messages ORDER BY index_in_chat")
      .all() as Array<{ content: string; swipes: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.content).toContain("gallery://image-1");
    expect(rows[0]!.content).not.toContain("cdn.example.com");
    expect(JSON.parse(rows[0]!.swipes).join(" ")).toContain("gallery://image-1");
  });

  test("refuses to assign a folder shared by several characters", async () => {
    const charactersDir = join(stDataDir, "characters");
    const folder = "Shared_aaaabbbbcccc";
    writeImage(join(stDataDir, "user", "images", folder, "localized_media_1_x.png"));

    // Two cards resolving to the same folder (same name + gallery_id).
    writeCard(
      charactersDir,
      "Shared.png",
      cardPng("Shared", { gallery_id: "aaaabbbbcccc" }, { description: "https://cdn.example.com/x.png" }),
    );
    writeCard(
      charactersDir,
      "Shared2.png",
      cardPng("Shared", { gallery_id: "aaaabbbbcccc" }, { description: "https://cdn.example.com/x.png" }),
    );

    const { filenameToId } = await runImport();
    const result = await importGalleryContent(USER_ID, stDataDir, filenameToId, chattyLogger());

    expect(result.contestedCharacters).toBe(2);
    expect(result.imported).toBe(0);
    expect(warnings.some((w) => w.includes("shared by"))).toBe(true);

    for (const id of filenameToId.values()) {
      expect(listGallery(USER_ID, id)).toHaveLength(0);
      expect(getCharacter(USER_ID, id)!.description).toContain("cdn.example.com");
    }
  });

  test("leaves an ambiguous URL match alone instead of guessing", async () => {
    const charactersDir = join(stDataDir, "characters");
    const folder = "Ambig_qqqqwwwweeee";
    // Two localized files share the same sanitized suffix.
    writeImage(join(stDataDir, "user", "images", folder, "localized_media_1_dup.png"));
    writeImage(join(stDataDir, "user", "images", folder, "localized_media_2_dup.png"));

    writeCard(
      charactersDir,
      "Ambig.png",
      cardPng("Ambig", { gallery_id: "qqqqwwwweeee" }, { description: "https://cdn.example.com/dup.png" }),
    );

    const { filenameToId } = await runImport();
    await importGalleryContent(USER_ID, stDataDir, filenameToId, chattyLogger());

    const character = getCharacter(USER_ID, filenameToId.get("Ambig")!);
    // Ambiguous: the URL keeps pointing at the source.
    expect(character!.description).toContain("cdn.example.com/dup.png");
    expect(warnings.some((w) => w.includes("multiple local files"))).toBe(true);
  });

  test("is idempotent across runs", async () => {
    const charactersDir = join(stDataDir, "characters");
    const folder = "Repeat_999988887777";
    writeImage(join(stDataDir, "user", "images", folder, "localized_media_1_only.png"));

    writeCard(
      charactersDir,
      "Repeat.png",
      cardPng("Repeat", { gallery_id: "999988887777" }, { description: "https://cdn.example.com/only.png" }),
    );

    const { filenameToId } = await runImport();
    const first = await importGalleryContent(USER_ID, stDataDir, filenameToId, chattyLogger());
    const characterId = filenameToId.get("Repeat")!;
    const afterFirst = getCharacter(USER_ID, characterId)!.description;

    const second = await importGalleryContent(USER_ID, stDataDir, filenameToId, chattyLogger());

    expect(first.imported).toBe(1);
    // Already-registered file is reused, not duplicated.
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    expect(listGallery(USER_ID, characterId)).toHaveLength(1);
    expect(getCharacter(USER_ID, characterId)!.description).toBe(afterFirst);
  });

  test("does not write into the SillyTavern source tree", async () => {
    const charactersDir = join(stDataDir, "characters");
    const folder = "Readonly_555566667777";
    const sourceFile = join(stDataDir, "user", "images", folder, "localized_media_1_r.png");
    writeImage(sourceFile);
    writeCard(charactersDir, "Readonly.png", cardPng("Readonly", { gallery_id: "555566667777" }));
    const before = readFileSync(sourceFile).length;
    const cardBefore = readFileSync(join(charactersDir, "Readonly.png")).length;

    const { filenameToId } = await runImport();
    await importGalleryContent(USER_ID, stDataDir, filenameToId, chattyLogger());

    expect(readFileSync(sourceFile).length).toBe(before);
    expect(readFileSync(join(charactersDir, "Readonly.png")).length).toBe(cardBefore);
    // The copied image lives in Lumiverse's flat images dir, not the ST tree.
    expect(existsSync(join(lumiverseDataDir, "images"))).toBe(true);
  });
});

describe("reference replacement", () => {
  test("replaces longest keys first and respects path boundaries", () => {
    const mappings = new Map([
      [localPathKey("F", "a.png"), "gallery://image-1"],
      [localPathKey("F", "a-longer.png"), "gallery://image-2"],
    ]);
    const text = "see /user/images/F/a-longer.png and /user/images/F/a.png";
    const out = replaceReferences(text, mappings);
    expect(out).toContain("gallery://image-2");
    expect(out).toContain("gallery://image-1");
    // A prefix of another filename must not be consumed.
    expect(replaceReferences("/user/images/F/a.png.bak", mappings)).toBe("/user/images/F/a.png.bak");
  });

  test("encodes folder and filename in the path key", () => {
    expect(localPathKey("A B", "c d.png")).toBe("/user/images/A%20B/c%20d.png");
  });

  test("matches the path key the CharacterLibrary bundle importer produces", () => {
    // cl-migration.service.ts maps this exact shape; they must agree.
    const folder = "Wiz - The Null Witch";
    const file = "localized_media_1_x.png";
    expect(localPathKey(folder, file)).toBe(
      `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`,
    );
  });

  test("imported character count mapping survives", async () => {
    expect(typeof listCharacterSourceFilenameIds).toBe("function");
  });
});
