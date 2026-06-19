import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  getWorldBook,
  getWorldBookListSignature,
  getWorldBookEntriesSignature,
} from "./world-books.service";

function initDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE world_books (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    user_id TEXT,
    folder TEXT NOT NULL DEFAULT ''
  )`);
  db.run(`CREATE TABLE world_book_entries (
    id TEXT PRIMARY KEY,
    world_book_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
}

function insertBook(o: { id: string; name: string; user_id: string; updated_at?: number; metadata?: unknown; folder?: string }): void {
  getDb().run(
    "INSERT INTO world_books (id, name, description, metadata, created_at, updated_at, user_id, folder) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [o.id, o.name, "", JSON.stringify(o.metadata ?? {}), 0, o.updated_at ?? 0, o.user_id, o.folder ?? ""],
  );
}

function insertEntry(o: { id: string; world_book_id: string; updated_at?: number }): void {
  getDb().run(
    "INSERT INTO world_book_entries (id, world_book_id, updated_at) VALUES (?, ?, ?)",
    [o.id, o.world_book_id, o.updated_at ?? 0],
  );
}

beforeEach(initDb);
afterEach(() => closeDatabase());

describe("world-books.service — ETag sources + row trim", () => {
  test("getWorldBook parses metadata and does NOT leak internal columns (user_id)", () => {
    insertBook({ id: "b1", name: "Lore", user_id: "u1", updated_at: 100, metadata: { x: 1 }, folder: "f" });
    const book = getWorldBook("u1", "b1");
    expect(book).not.toBeNull();
    expect(Object.keys(book!)).not.toContain("user_id");
    expect(book!.metadata).toEqual({ x: 1 });
    expect(book!.folder).toBe("f");
    expect(book!.updated_at).toBe(100);
  });

  test("getWorldBook is scoped to the owning user", () => {
    insertBook({ id: "b1", name: "Lore", user_id: "u1", updated_at: 100 });
    expect(getWorldBook("u2", "b1")).toBeNull();
  });

  test("list signature reflects count + max(updated_at) per user", () => {
    insertBook({ id: "b1", name: "A", user_id: "u1", updated_at: 100 });
    insertBook({ id: "b2", name: "B", user_id: "u1", updated_at: 300 });
    insertBook({ id: "b3", name: "C", user_id: "u2", updated_at: 999 });
    expect(getWorldBookListSignature("u1")).toEqual({ count: 2, maxUpdatedAt: 300 });
    expect(getWorldBookListSignature("u2")).toEqual({ count: 1, maxUpdatedAt: 999 });
    expect(getWorldBookListSignature("u3")).toEqual({ count: 0, maxUpdatedAt: 0 });
  });

  test("entries signature reflects count + max(updated_at) per book and bumps on edit", () => {
    insertEntry({ id: "e1", world_book_id: "b1", updated_at: 10 });
    insertEntry({ id: "e2", world_book_id: "b1", updated_at: 50 });
    insertEntry({ id: "e3", world_book_id: "b2", updated_at: 999 });
    expect(getWorldBookEntriesSignature("b1")).toEqual({ count: 2, maxUpdatedAt: 50 });
    expect(getWorldBookEntriesSignature("missing")).toEqual({ count: 0, maxUpdatedAt: 0 });

    getDb().run("UPDATE world_book_entries SET updated_at = 80 WHERE id = 'e1'");
    expect(getWorldBookEntriesSignature("b1")).toEqual({ count: 2, maxUpdatedAt: 80 });
  });
});
