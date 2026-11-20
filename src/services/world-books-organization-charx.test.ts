import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { unzipSync, strFromU8 } from "fflate";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import { createCharacter, getCharacter } from "./characters.service";
import { createEntry, createWorldBook, listEntries } from "./world-books.service";
import { exportAsCharx } from "./character-export.service";
import { extractCardFromCharx } from "./character-card.service";
import { applyCharxModulesAndAssets } from "./charx-import.service";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../utils/character-world-books";

const owner = "organization-charx-owner";
const originalDataDir = env.dataDir;
let testDataDir = "";
beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  testDataDir = mkdtempSync(join(tmpdir(), "lumiverse-lorebook-charx-"));
  env.dataDir = testDataDir;
});
afterEach(() => {
  closeDatabase();
  env.dataDir = originalDataDir;
  if (testDataDir) {
    if (dirname(resolve(testDataDir)) !== resolve(tmpdir()) || !basename(testDataDir).startsWith("lumiverse-lorebook-charx-")) throw new Error("Unsafe temporary directory");
    rmSync(testDataDir, { recursive: true, force: true });
    testDataDir = "";
  }
});

describe("CHARX lorebook organization portability", () => {
  test("native module preserves organization while embedded standard lore stays flat; reimport links only one book", async () => {
    const book = createWorldBook(owner, { name: "Organized" });
    createEntry(owner, book.id, { content: "Alpha lore", key: ["alpha"], folder: "Characters", tags: ["villain", "世界"], order_value: 73 });
    const character = createCharacter(owner, { name: "Portable", extensions: setCharacterWorldBookIds({}, [book.id]) });
    const archive = await exportAsCharx(owner, character.id);
    expect(archive).not.toBeNull();
    const files = unzipSync(archive!);
    const modules = JSON.parse(strFromU8(files["lumiverse_modules.json"]));
    expect(modules.world_books[0].entries[0]).toMatchObject({ folder: "Characters", tags: ["villain", "世界"], content: "Alpha lore", order_value: 73 });
    const card = JSON.parse(strFromU8(files["card.json"]));
    const standard = card.data.character_book.entries[0];
    expect(standard.content).toBe("Alpha lore");
    expect(standard.folder).toBeUndefined();
    expect(standard.tags).toBeUndefined();
    expect(standard.extensions?.folder).toBeUndefined();
    expect(standard.extensions?.tags).toBeUndefined();
    const bytes = new Uint8Array(archive!);
    const extracted = await extractCardFromCharx(new File([bytes], "organized.charx", { type: "application/zip" }));
    const imported = createCharacter(owner, extracted.card);
    await applyCharxModulesAndAssets(owner, imported, extracted);
    const linkedIds = getCharacterWorldBookIds(getCharacter(owner, imported.id)!.extensions);
    expect(linkedIds).toHaveLength(1);
    expect(linkedIds[0]).not.toBe(book.id);
    expect(listEntries(owner, linkedIds[0])).toHaveLength(1);
    expect(listEntries(owner, linkedIds[0])[0]).toMatchObject({ folder: "Characters", tags: ["villain", "世界"], key: ["alpha"], content: "Alpha lore", order_value: 73 });
  });
});
