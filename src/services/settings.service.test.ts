import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { putMany, putSetting } from "./settings.service";

function initSettingsDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, user_id)
  )`);
  db.run(`CREATE TABLE world_books (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE world_book_entries (
    id TEXT PRIMARY KEY,
    world_book_id TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    vectorized INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    vector_index_status TEXT,
    vector_indexed_at INTEGER,
    vector_index_error TEXT
  )`);
}

function insertBook(id: string, userId = "u1"): void {
  getDb().run("INSERT INTO world_books (id, user_id) VALUES (?, ?)", [id, userId]);
}

function insertEntry(o: {
  id: string;
  world_book_id: string;
  content: string;
  vectorized: number;
  disabled: number;
  vector_index_status: string | null;
  vector_indexed_at: number | null;
  vector_index_error: string | null;
}): void {
  getDb().run(
    `INSERT INTO world_book_entries
     (id, world_book_id, content, vectorized, disabled, vector_index_status, vector_indexed_at, vector_index_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      o.id,
      o.world_book_id,
      o.content,
      o.vectorized,
      o.disabled,
      o.vector_index_status,
      o.vector_indexed_at,
      o.vector_index_error,
    ],
  );
}

beforeEach(initSettingsDb);
afterEach(() => closeDatabase());

describe("settings.service world-book vector tracking", () => {
  test("changing worldBookVectorSettings resets indexed entries back to trackable pending/not_enabled states", () => {
    insertBook("b1");
    insertEntry({
      id: "eligible",
      world_book_id: "b1",
      content: "Lore text",
      vectorized: 1,
      disabled: 0,
      vector_index_status: "indexed",
      vector_indexed_at: 123,
      vector_index_error: "old",
    });
    insertEntry({
      id: "disabled",
      world_book_id: "b1",
      content: "Lore text",
      vectorized: 1,
      disabled: 1,
      vector_index_status: "indexed",
      vector_indexed_at: 456,
      vector_index_error: "old",
    });
    insertEntry({
      id: "plain",
      world_book_id: "b1",
      content: "",
      vectorized: 0,
      disabled: 0,
      vector_index_status: "indexed",
      vector_indexed_at: 789,
      vector_index_error: "old",
    });

    putSetting("u1", "worldBookVectorSettings", { presetMode: "deep", chunkTargetTokens: 720 });

    const rows = getDb().query(
      "SELECT id, vector_index_status, vector_indexed_at, vector_index_error FROM world_book_entries ORDER BY id ASC",
    ).all() as Array<{
      id: string;
      vector_index_status: string | null;
      vector_indexed_at: number | null;
      vector_index_error: string | null;
    }>;

    expect(rows).toEqual([
      { id: "disabled", vector_index_status: "not_enabled", vector_indexed_at: null, vector_index_error: null },
      { id: "eligible", vector_index_status: "pending", vector_indexed_at: null, vector_index_error: null },
      { id: "plain", vector_index_status: "not_enabled", vector_indexed_at: null, vector_index_error: null },
    ]);
  });

  test("rewriting the same worldBookVectorSettings payload does not re-stale entries again", () => {
    insertBook("b1");
    insertEntry({
      id: "eligible",
      world_book_id: "b1",
      content: "Lore text",
      vectorized: 1,
      disabled: 0,
      vector_index_status: "indexed",
      vector_indexed_at: 123,
      vector_index_error: null,
    });

    putSetting("u1", "worldBookVectorSettings", { presetMode: "deep", chunkTargetTokens: 720 });
    getDb().run(
      "UPDATE world_book_entries SET vector_index_status = 'indexed', vector_indexed_at = 999, vector_index_error = 'kept' WHERE id = 'eligible'",
    );

    putSetting("u1", "worldBookVectorSettings", { presetMode: "deep", chunkTargetTokens: 720 });

    const row = getDb().query(
      "SELECT vector_index_status, vector_indexed_at, vector_index_error FROM world_book_entries WHERE id = 'eligible'",
    ).get() as {
      vector_index_status: string | null;
      vector_indexed_at: number | null;
      vector_index_error: string | null;
    };

    expect(row).toEqual({
      vector_index_status: "indexed",
      vector_indexed_at: 999,
      vector_index_error: "kept",
    });
  });

  test("bulk put also resets world-book vector states when the settings payload changes", () => {
    insertBook("b1");
    insertEntry({
      id: "eligible",
      world_book_id: "b1",
      content: "Lore text",
      vectorized: 1,
      disabled: 0,
      vector_index_status: "indexed",
      vector_indexed_at: 123,
      vector_index_error: null,
    });

    putMany("u1", {
      worldBookVectorSettings: { presetMode: "lean", chunkTargetTokens: 220 },
      other: { ok: true },
    });

    const row = getDb().query(
      "SELECT vector_index_status, vector_indexed_at, vector_index_error FROM world_book_entries WHERE id = 'eligible'",
    ).get() as {
      vector_index_status: string | null;
      vector_indexed_at: number | null;
      vector_index_error: string | null;
    };

    expect(row).toEqual({
      vector_index_status: "pending",
      vector_indexed_at: null,
      vector_index_error: null,
    });
  });
});
