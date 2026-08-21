import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import { embedPngTextChunk } from "../services/character-export.service";
import {
  listCharacterSourceFilenameIds,
  listCharacterSummaries,
} from "../services/characters.service";
import { listSillyTavernWorldBookSourceFilenameIds } from "../services/world-books.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { MigrationLogger } from "./st-reader";
import { importCharacters, importWorldBooks } from "./st-importer";

const USER_ID = "st-import-user";
const ONE_BY_ONE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==";
const originalDataDir = env.dataDir;
let workDir = "";

const logger: MigrationLogger = {
  info() {},
  warn() {},
  error() {},
  progress() {},
};

function cardPng(name: string): Buffer {
  const card = JSON.stringify({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: { name },
  });
  return embedPngTextChunk(
    Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"),
    "ccv3",
    Buffer.from(card).toString("base64"),
  );
}

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());

  workDir = mkdtempSync(join(tmpdir(), "lumiverse-st-import-"));
  env.dataDir = join(workDir, "lumiverse-data");
  mkdirSync(join(workDir, "st-data", "characters"), { recursive: true });
  writeFileSync(join(workDir, "st-data", "characters", "alice.png"), cardPng("Alice"));
  writeFileSync(join(workDir, "st-data", "characters", "bob.png"), cardPng("Bob"));
  mkdirSync(join(workDir, "st-data", "worlds"), { recursive: true });
  writeFileSync(join(workDir, "st-data", "worlds", "alpha.json"), JSON.stringify({
    name: "Alpha",
    entries: {
      0: { key: ["alpha"], content: "Alpha content" },
      1: { key: ["beta"], content: "Beta content" },
    },
  }));
  writeFileSync(join(workDir, "st-data", "worlds", "empty.json"), JSON.stringify({
    name: "Empty",
    entries: {},
  }));
});

afterEach(() => {
  closeDatabase();
  env.dataDir = originalDataDir;
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("SillyTavern world-book bulk migration", () => {
  test("uses one coarse event and preloaded source identities across reruns", async () => {
    let fullBookEvents = 0;
    let libraryEvents = 0;
    const offBook = eventBus.on(EventType.WORLD_BOOK_CHANGED, () => fullBookEvents++);
    const offLibrary = eventBus.on(EventType.WORLD_BOOK_LIBRARY_CHANGED, () => libraryEvents++);

    try {
      const first = await importWorldBooks(USER_ID, join(workDir, "st-data"), logger);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      expect(first).toMatchObject({ imported: 2, skipped: 0, failed: 0, totalEntries: 2 });
      expect(first.nameToId.size).toBe(2);
      expect(fullBookEvents).toBe(0);
      expect(libraryEvents).toBe(1);
      expect([...listSillyTavernWorldBookSourceFilenameIds(USER_ID).keys()].sort()).toEqual([
        "alpha.json",
        "empty.json",
      ]);

      const second = await importWorldBooks(USER_ID, join(workDir, "st-data"), logger);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      expect(second).toMatchObject({ imported: 0, skipped: 2, failed: 0, totalEntries: 0 });
      expect(second.nameToId.size).toBe(2);
      expect(fullBookEvents).toBe(0);
      expect(libraryEvents).toBe(1);
      expect(getDb().query("SELECT COUNT(*) AS count FROM world_books").get()).toEqual({ count: 2 });
      expect(getDb().query("SELECT COUNT(*) AS count FROM world_book_entries").get()).toEqual({ count: 2 });
    } finally {
      offBook();
      offLibrary();
    }
  });

  test("uses the source-filename expression index for migration identity scans", () => {
    const plan = getDb().query(
      `EXPLAIN QUERY PLAN
       SELECT id, json_extract(metadata, '$._lumiverse_source_filename')
       FROM world_books
       WHERE user_id = ?
         AND json_extract(metadata, '$._lumiverse_source_filename') = ?`,
    ).all(USER_ID, "alpha.json") as Array<{ detail: string }>;

    expect(plan.some((row) => row.detail.includes("idx_world_books_user_source_filename"))).toBe(true);
  });
});

describe("SillyTavern character bulk migration", () => {
  test("imports in bulk without per-row events and reruns from preloaded identities", async () => {
    let characterEvents = 0;
    let imageEvents = 0;
    const offCharacter = eventBus.on(EventType.CHARACTER_CREATED, () => characterEvents++);
    const offImage = eventBus.on(EventType.IMAGE_UPLOADED, () => imageEvents++);

    try {
      const first = await importCharacters(USER_ID, join(workDir, "st-data"), logger);
      expect(first).toMatchObject({ imported: 2, skipped: 0, failed: 0 });
      expect(first.filenameToId.size).toBe(2);
      expect(characterEvents).toBe(0);
      expect(imageEvents).toBe(0);

      const rows = getDb().query(
        `SELECT name, image_id, avatar_path,
                json_extract(extensions, '$._lumiverse_source_filename') AS source_filename
         FROM characters WHERE user_id = ? ORDER BY name`,
      ).all(USER_ID) as Array<{
        name: string;
        image_id: string | null;
        avatar_path: string | null;
        source_filename: string;
      }>;
      expect(rows.map((row) => row.source_filename)).toEqual(["alice.png", "bob.png"]);
      expect(rows.every((row) => !!row.image_id && !!row.avatar_path)).toBe(true);
      expect(
        listCharacterSummaries(USER_ID, { limit: 10, offset: 0 }, { search: "Alice" }).data
          .map((character) => character.name),
      ).toEqual(["Alice"]);

      const images = getDb().query(
        "SELECT has_thumbnail, owner_character_id FROM images WHERE user_id = ?",
      ).all(USER_ID) as Array<{ has_thumbnail: number; owner_character_id: string | null }>;
      expect(images).toHaveLength(2);
      expect(images.every((image) => image.has_thumbnail === 0 && !!image.owner_character_id)).toBe(true);

      expect([...listCharacterSourceFilenameIds(USER_ID).keys()].sort()).toEqual([
        "alice.png",
        "bob.png",
      ]);

      const second = await importCharacters(USER_ID, join(workDir, "st-data"), logger);
      expect(second).toMatchObject({ imported: 0, skipped: 2, failed: 0 });
      expect(getDb().query("SELECT COUNT(*) AS count FROM characters").get()).toEqual({ count: 2 });
      expect(getDb().query("SELECT COUNT(*) AS count FROM images").get()).toEqual({ count: 2 });
    } finally {
      offCharacter();
      offImage();
    }
  });

  test("uses the source-filename expression index for point lookups", () => {
    const plan = getDb().query(
      `EXPLAIN QUERY PLAN
       SELECT * FROM characters
       WHERE user_id = ?
         AND json_extract(extensions, '$._lumiverse_source_filename') = ?
       LIMIT 1`,
    ).all(USER_ID, "alice.png") as Array<{ detail: string }>;

    expect(plan.some((row) => row.detail.includes("idx_characters_user_source_filename"))).toBe(true);
  });
});
