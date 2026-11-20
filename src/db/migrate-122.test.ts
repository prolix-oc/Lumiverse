import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "./migrate";
const migration = "122_world_book_entry_organization.sql";

describe("122 lorebook entry organization migration", () => {
  test("upgrades existing rows without modifying lore, revisions, vectors or timestamps; runner is repeatable", async () => {
    const db = new Database(":memory:");
    try {
      db.run("PRAGMA foreign_keys = OFF");
      db.run("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))");
      const dir = join(import.meta.dir, "migrations");
      for (const file of readdirSync(dir).filter(file => file.endsWith(".sql") && file < migration).sort()) {
        db.run(await Bun.file(join(dir, file)).text());
        db.query("INSERT INTO _migrations VALUES (?, 1)").run(file);
      }
      db.run("INSERT INTO world_books (id, name, user_id) VALUES ('book', 'Book', 'owner')");
      db.run("INSERT INTO world_book_entries (id, world_book_id, uid, content, key, order_value, revision, vectorized, vector_index_status, vector_indexed_at, created_at, updated_at) VALUES ('old', 'book', 'uid', 'Lore', '[\"alpha\"]', 19, 7, 1, 'indexed', 42, 3, 4)");
      const before = db.query("SELECT * FROM world_book_entries WHERE id = 'old'").get() as Record<string, unknown>;
      await runMigrations(db);
      expect(db.prepare("SELECT * FROM world_book_entries WHERE id = 'old'").get()).toEqual({ ...before, folder: "", tags: "[]" });
      db.run("INSERT INTO world_book_entries (id, world_book_id, uid) VALUES ('new', 'book', 'new-uid')");
      expect(db.query("SELECT folder, tags FROM world_book_entries WHERE id = 'new'").get()).toEqual({ folder: "", tags: "[]" });
      await runMigrations(db);
      expect(db.query("SELECT COUNT(*) AS count FROM _migrations WHERE name = ?").get(migration)).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  test("fresh bootstrap includes columns and migration bookkeeping exactly once", async () => {
    const db = new Database(":memory:");
    try {
      await runMigrations(db);
      await runMigrations(db);
      expect(db.query("SELECT COUNT(*) AS count FROM _migrations WHERE name = ?").get(migration)).toEqual({ count: 1 });
      const columns = db.query("PRAGMA table_info(world_book_entries)").all() as Array<{ name: string; dflt_value: string }>;
      expect(columns.find(column => column.name === "folder")?.dflt_value).toBe("''");
      expect(columns.find(column => column.name === "tags")?.dflt_value).toBe("'[]'");
    } finally { db.close(); }
  });
});

test("migration SQL failure rolls back the first ALTER and leaves bookkeeping unrecorded", async () => {
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))");
    // Simulate schema drift: tags already exists, so the second ALTER must fail.
    db.run("CREATE TABLE world_book_entries (id TEXT PRIMARY KEY, tags TEXT NOT NULL DEFAULT '[]')");
    db.run("INSERT INTO world_book_entries VALUES ('keep', '[\"foreign\"]')");
    for (const file of readdirSync(join(import.meta.dir, "migrations")).filter(file => file.endsWith(".sql") && file < migration)) db.query("INSERT INTO _migrations (name) VALUES (?)").run(file);
    await expect(runMigrations(db)).rejects.toThrow("duplicate column name");
    expect(db.query("PRAGMA table_info(world_book_entries)").all().map((column: any) => column.name)).toEqual(["id", "tags"]);
    expect(db.query("SELECT * FROM world_book_entries").get()).toEqual({ id: "keep", tags: '["foreign"]' });
    expect(db.query("SELECT name FROM _migrations WHERE name = ?").get(migration)).toBeNull();
  } finally { db.close(); }
});
