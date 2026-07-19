import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  deleteWorldBookFolder,
  getWorldBook,
  renameWorldBookFolder,
} from "./world-books.service";

function initDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE world_books (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    user_id TEXT NOT NULL
  )`);
}

function insertBook(id: string, userId: string, folder: string, updatedAt: number = 1): void {
  getDb().run(
    "INSERT INTO world_books (id, name, description, folder, metadata, created_at, updated_at, user_id) VALUES (?, ?, '', ?, '{}', 1, ?, ?)",
    [id, id, folder, updatedAt, userId],
  );
}

beforeEach(initDb);
afterEach(() => closeDatabase());

describe("world-book folder operations", () => {
  test("renaming a folder moves only the current user's matching lorebooks", () => {
    insertBook("a-1", "user-a", "Drafts");
    insertBook("a-2", "user-a", "Drafts");
    insertBook("a-target", "user-a", "Published");
    insertBook("b-1", "user-b", "Drafts");

    const updated = renameWorldBookFolder("user-a", " Drafts ", " Published ");

    expect(updated.map((book) => book.id).sort()).toEqual(["a-1", "a-2"]);
    expect(updated.every((book) => book.folder === "Published")).toBe(true);
    expect(getWorldBook("user-a", "a-1")?.folder).toBe("Published");
    expect(getWorldBook("user-a", "a-2")?.folder).toBe("Published");
    expect(getWorldBook("user-a", "a-target")?.folder).toBe("Published");
    expect(getWorldBook("user-b", "b-1")?.folder).toBe("Drafts");
  });

  test("deleting a folder preserves its lorebooks and moves them to no folder", () => {
    insertBook("a-1", "user-a", "Archive");
    insertBook("a-2", "user-a", "Archive");
    insertBook("a-other", "user-a", "Keep");
    insertBook("b-1", "user-b", "Archive");

    const updated = deleteWorldBookFolder("user-a", " Archive ");

    expect(updated.map((book) => book.id).sort()).toEqual(["a-1", "a-2"]);
    expect(updated.every((book) => book.folder === "")).toBe(true);
    expect(getWorldBook("user-a", "a-1")?.folder).toBe("");
    expect(getWorldBook("user-a", "a-2")?.folder).toBe("");
    expect(getWorldBook("user-a", "a-other")?.folder).toBe("Keep");
    expect(getWorldBook("user-b", "b-1")?.folder).toBe("Archive");
  });

  test("blank or unknown folders leave all lorebooks untouched", () => {
    insertBook("a-1", "user-a", "Drafts", 42);

    expect(renameWorldBookFolder("user-a", "", "Published")).toEqual([]);
    expect(renameWorldBookFolder("user-a", "Missing", "Published")).toEqual([]);
    expect(deleteWorldBookFolder("user-a", "")).toEqual([]);
    expect(deleteWorldBookFolder("user-a", "Missing")).toEqual([]);
    expect(getWorldBook("user-a", "a-1")).toMatchObject({ folder: "Drafts", updated_at: 42 });
  });
});
