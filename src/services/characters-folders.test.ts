import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { buildCCSv3Json } from "./character-export.service";
import {
  bulkUpdateCharacterFolders,
  createCharacter,
  deleteCharacterFolder,
  duplicateCharacter,
  getCharacter,
  listCharacterSummaries,
  renameCharacterFolder,
} from "./characters.service";

const USER_A = "character-folder-user-a";
const USER_B = "character-folder-user-b";

async function initDb(): Promise<void> {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "092_characters_deleting_flag.sql")).text());
  db.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run("legacy-character", USER_A, "Legacy");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "096_character_folders.sql")).text());
}

beforeEach(initDb);
afterEach(() => closeDatabase());

describe("character folder operations", () => {
  test("existing and new characters default to Uncategorized while duplicates retain their folder", () => {
    const uncategorized = createCharacter(USER_A, { name: "Uncategorized" });
    const filed = createCharacter(USER_A, { name: "Filed", folder: " Cast " });
    const duplicate = duplicateCharacter(USER_A, filed.id);

    expect(getCharacter(USER_A, "legacy-character")?.folder).toBe("");
    expect(uncategorized.folder).toBe("");
    expect(filed.folder).toBe("Cast");
    expect(duplicate?.folder).toBe("Cast");
  });

  test("normal and Discover summaries include the folder", () => {
    createCharacter(USER_A, { name: "Filed", folder: "Cast" });

    const normal = listCharacterSummaries(USER_A, { limit: 10, offset: 0 }, { sort: "name" });
    const discover = listCharacterSummaries(USER_A, { limit: 10, offset: 0 }, { sort: "discover", seed: 7 });

    expect(normal.data.find((character) => character.name === "Filed")?.folder).toBe("Cast");
    expect(discover.data.find((character) => character.name === "Filed")?.folder).toBe("Cast");
  });

  test("renaming merges folders and affects only the current user", () => {
    const first = createCharacter(USER_A, { name: "First", folder: "Drafts" });
    const second = createCharacter(USER_A, { name: "Second", folder: "Drafts" });
    const existingTarget = createCharacter(USER_A, { name: "Target", folder: "Published" });
    const otherUser = createCharacter(USER_B, { name: "Other", folder: "Drafts" });

    const updated = renameCharacterFolder(USER_A, " Drafts ", " Published ");

    expect(updated.map((character) => character.id).sort()).toEqual([first.id, second.id].sort());
    expect(getCharacter(USER_A, first.id)?.folder).toBe("Published");
    expect(getCharacter(USER_A, second.id)?.folder).toBe("Published");
    expect(getCharacter(USER_A, existingTarget.id)?.folder).toBe("Published");
    expect(getCharacter(USER_B, otherUser.id)?.folder).toBe("Drafts");
  });

  test("deleting a folder moves its characters to Uncategorized", () => {
    const first = createCharacter(USER_A, { name: "First", folder: "Archive" });
    const second = createCharacter(USER_A, { name: "Second", folder: "Archive" });
    const keep = createCharacter(USER_A, { name: "Keep", folder: "Keep" });

    const updated = deleteCharacterFolder(USER_A, " Archive ");

    expect(updated).toHaveLength(2);
    expect(getCharacter(USER_A, first.id)?.folder).toBe("");
    expect(getCharacter(USER_A, second.id)?.folder).toBe("");
    expect(getCharacter(USER_A, keep.id)?.folder).toBe("Keep");
  });

  test("bulk move deduplicates ids, skips missing and foreign characters, and trims the target", () => {
    const first = createCharacter(USER_A, { name: "First" });
    const second = createCharacter(USER_A, { name: "Second" });
    const otherUser = createCharacter(USER_B, { name: "Other" });

    const updated = bulkUpdateCharacterFolders(
      USER_A,
      [first.id, first.id, second.id, otherUser.id, "missing"],
      " Cast ",
    );

    expect(updated.map((character) => character.id).sort()).toEqual([first.id, second.id].sort());
    expect(getCharacter(USER_A, first.id)?.folder).toBe("Cast");
    expect(getCharacter(USER_A, second.id)?.folder).toBe("Cast");
    expect(getCharacter(USER_B, otherUser.id)?.folder).toBe("");
  });

  test("blank and unknown folder operations leave characters untouched", () => {
    const character = createCharacter(USER_A, { name: "Filed", folder: "Drafts" });

    expect(renameCharacterFolder(USER_A, "", "Published")).toEqual([]);
    expect(renameCharacterFolder(USER_A, "Missing", "Published")).toEqual([]);
    expect(deleteCharacterFolder(USER_A, "")).toEqual([]);
    expect(deleteCharacterFolder(USER_A, "Missing")).toEqual([]);
    expect(getCharacter(USER_A, character.id)?.folder).toBe("Drafts");
  });

  test("portable card exports exclude the local folder", () => {
    const character = createCharacter(USER_A, { name: "Filed", folder: "Private organization" });
    const exported = buildCCSv3Json(USER_A, character);

    expect(exported).not.toHaveProperty("folder");
    expect(exported.data).not.toHaveProperty("folder");
  });
});
