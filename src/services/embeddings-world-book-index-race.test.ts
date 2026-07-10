import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import type { WorldBookEntry } from "../types/world-book";
import type { VectorRow } from "./vector-store/types";
import { worldBookVectorTrackingFingerprint } from "./world-book-vector-state";
import { __test__ } from "./embeddings.service";

function makeEntry(overrides: Partial<WorldBookEntry> = {}): WorldBookEntry {
  return {
    id: "entry-1",
    world_book_id: "book-1",
    uid: "uid-1",
    outlet_name: null,
    wi_marker: null,
    wi_marker_side: null,
    key: ["old"],
    keysecondary: [],
    content: "old lore",
    comment: "Old lore",
    position: 0,
    depth: 4,
    role: null,
    order_value: 100,
    selective: false,
    constant: false,
    disabled: false,
    group_name: "",
    group_override: false,
    group_weight: 100,
    probability: 100,
    scan_depth: null,
    case_sensitive: false,
    match_whole_words: false,
    automation_id: null,
    use_regex: false,
    prevent_recursion: false,
    exclude_recursion: false,
    delay_until_recursion: false,
    priority: 10,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    selective_logic: 0,
    use_probability: true,
    vectorized: true,
    vector_index_status: "pending",
    vector_indexed_at: null,
    vector_index_error: null,
    extensions: {},
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function makeRow(entry: WorldBookEntry, vector: number[]): VectorRow {
  return {
    id: `user:world_book_entry:${entry.id}:0`,
    user_id: "user",
    source_type: "world_book_entry",
    source_id: entry.id,
    owner_id: entry.world_book_id,
    chunk_index: 0,
    content: entry.content,
    vector,
    metadata_json: "{}",
    updated_at: entry.updated_at,
  };
}

function readTrackedEntry(): WorldBookEntry {
  const row = getDb().query("SELECT * FROM world_book_entries WHERE id = 'entry-1'").get() as any;
  return makeEntry({
    world_book_id: String(row.world_book_id),
    key: JSON.parse(row.key),
    keysecondary: JSON.parse(row.keysecondary),
    content: String(row.content),
    comment: String(row.comment),
    vectorized: !!row.vectorized,
    disabled: !!row.disabled,
    vector_index_status: row.vector_index_status,
    vector_indexed_at: row.vector_indexed_at,
    vector_index_error: row.vector_index_error,
    updated_at: Number(row.updated_at),
  });
}

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run("CREATE TABLE world_books (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)");
  db.run(`CREATE TABLE world_book_entries (
    id TEXT PRIMARY KEY,
    world_book_id TEXT NOT NULL,
    key TEXT NOT NULL,
    keysecondary TEXT NOT NULL,
    content TEXT NOT NULL,
    comment TEXT NOT NULL,
    vectorized INTEGER NOT NULL,
    disabled INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    vector_index_status TEXT NOT NULL,
    vector_indexed_at INTEGER,
    vector_index_error TEXT
  )`);
  db.run("INSERT INTO world_books (id, user_id) VALUES ('book-1', 'user')");
  const entry = makeEntry();
  db.query(`INSERT INTO world_book_entries (
    id, world_book_id, key, keysecondary, content, comment, vectorized, disabled,
    updated_at, vector_index_status, vector_indexed_at, vector_index_error
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      entry.id,
      entry.world_book_id,
      JSON.stringify(entry.key),
      JSON.stringify(entry.keysecondary),
      entry.content,
      entry.comment,
      1,
      0,
      entry.updated_at,
      entry.vector_index_status,
      null,
      null,
    );
});

afterEach(() => closeDatabase());

describe("world-book vector commit races", () => {
  test("compare-and-set rejects an edit after final snapshot validation", async () => {
    const vectors = new Map<string, VectorRow[]>();
    let filterCalls = 0;
    const oldEntry = makeEntry();
    const dependencies = {
      filterCurrent: async (_userId: string, entries: WorldBookEntry[]) => {
        filterCalls += 1;
        if (filterCalls === 2) {
          getDb().query(`UPDATE world_book_entries
            SET content = 'new lore', updated_at = 2, vector_index_status = 'pending'
            WHERE id = 'entry-1'`).run();
        }
        // Model a concurrent process changing SQLite immediately after this
        // job's final snapshot read. The SQL compare-and-set must still reject it.
        return entries;
      },
      deleteRows: async (_userId: string, entryIds: string[]) => {
        for (const entryId of entryIds) vectors.delete(entryId);
      },
      upsertRows: async (rows: VectorRow[]) => {
        for (const row of rows) vectors.set(row.source_id, [row]);
      },
      markIndexedIfCurrent: (userId: string, entries: WorldBookEntry[], indexedAt: number) =>
        __test__.updateWorldBookEntriesVectorStateIfCurrent(userId, entries, "indexed", indexedAt, null),
    };

    const commit = await __test__.commitWorldBookVectorWritesIfCurrent(
      "user",
      [{ entry: oldEntry, rows: [makeRow(oldEntry, [1, 0])] }],
      "settings",
      "config",
      10,
      dependencies,
    );

    expect(commit.indexedIds).toEqual([]);
    expect(commit.staleIds).toEqual(["entry-1"]);
    expect(readTrackedEntry().vector_index_status).toBe("pending");
    expect(vectors.has("entry-1")).toBe(false);
  });

  test("discards an old commit, lets edit deletion finish, and indexes the replacement", async () => {
    const vectors = new Map<string, VectorRow[]>();
    const events: string[] = [];
    let mutateDuringOldUpsert = true;
    let queuedEditDelete: Promise<void> | null = null;

    const dependencies = {
      filterCurrent: async (_userId: string, entries: WorldBookEntry[]) => {
        const current = readTrackedEntry();
        const currentFingerprint = worldBookVectorTrackingFingerprint(current);
        return entries.filter((entry) => worldBookVectorTrackingFingerprint(entry) === currentFingerprint);
      },
      deleteRows: async (_userId: string, entryIds: string[]) => {
        events.push("delete");
        for (const entryId of entryIds) vectors.delete(entryId);
      },
      upsertRows: async (rows: VectorRow[]) => {
        events.push("upsert");
        for (const row of rows) vectors.set(row.source_id, [row]);
        if (!mutateDuringOldUpsert) return;
        mutateDuringOldUpsert = false;
        getDb().query(`UPDATE world_book_entries
          SET content = 'new lore', comment = 'New lore', key = '["new"]',
              updated_at = 2, vector_index_status = 'pending',
              vector_indexed_at = NULL, vector_index_error = NULL
          WHERE id = 'entry-1'`).run();
        queuedEditDelete = __test__.withWorldBookEntryVectorCommitLocks("user", ["entry-1"], async () => {
          events.push("edit-delete");
          vectors.delete("entry-1");
        });
      },
      markIndexedIfCurrent: (userId: string, entries: WorldBookEntry[], indexedAt: number) =>
        __test__.updateWorldBookEntriesVectorStateIfCurrent(userId, entries, "indexed", indexedAt, null),
    };

    const oldEntry = makeEntry();
    const oldCommit = await __test__.commitWorldBookVectorWritesIfCurrent(
      "user",
      [{ entry: oldEntry, rows: [makeRow(oldEntry, [1, 0])] }],
      "settings",
      "config",
      10,
      dependencies,
    );
    if (queuedEditDelete) await queuedEditDelete;

    expect(oldCommit.indexedIds).toEqual([]);
    expect(oldCommit.staleIds).toEqual(["entry-1"]);
    expect(readTrackedEntry().vector_index_status).toBe("pending");
    expect(vectors.has("entry-1")).toBe(false);
    expect(events.lastIndexOf("delete")).toBeLessThan(events.indexOf("edit-delete"));

    const replacementEntry = readTrackedEntry();
    const replacementCommit = await __test__.commitWorldBookVectorWritesIfCurrent(
      "user",
      [{ entry: replacementEntry, rows: [makeRow(replacementEntry, [0, 1])] }],
      "settings",
      "config",
      20,
      dependencies,
    );

    expect(replacementCommit.indexedIds).toEqual(["entry-1"]);
    expect(replacementCommit.staleIds).toEqual([]);
    expect(readTrackedEntry().vector_index_status).toBe("indexed");
    expect(vectors.get("entry-1")?.[0]).toMatchObject({ content: "new lore", vector: [0, 1] });
  });
});
