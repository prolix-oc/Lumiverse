import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize } from "node:v8";
import { createImageReferenceDiagnostics, formatImageReferenceDiagnostics } from "./image-reference-diagnostics";
import { extractImageIds, hasImageReferenceIndex, populateImageReferenceIndex, refreshImageReferenceIndex } from "./image-reference-index";
import { findReferencedImageIds } from "./image-reference-operations";
import { DatabaseExecutor } from "./execution";
import { encodeDatabaseMessage } from "./execution-transport";

const baseline = readFileSync(join(import.meta.dir, "baseline.sql"), "utf8");
const oldBaseline = baseline.slice(0, baseline.indexOf("-- 126: Durable reverse image references"));
const migration = readFileSync(join(import.meta.dir, "migrations/126_image_references.sql"), "utf8");
const image = "a0123456-1234-7234-8234-123456789abc";
const otherImage = "b0123456-1234-4234-9234-123456789abc";
const absentImage = "c0123456-1234-4234-8234-123456789abc";
let db: Database;
let directory: string | undefined;

function openFileDatabase(path: string): Database {
  const target = new Database(path);
  // Match runtime journaling. DELETE/FULL makes every fixture DDL statement
  // sync a rollback journal, which is particularly expensive on Windows CI.
  target.run("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA mmap_size = 0");
  return target;
}

function seed(target: Database): void {
  target.run("PRAGMA foreign_keys = ON; PRAGMA mmap_size = 0");
  for (const user of ["user", "other"]) {
    target.query('INSERT INTO "user"(id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)').run(user, user, `${user}@example.com`);
  }
  target.run("INSERT INTO characters(id, user_id, name) VALUES ('hero', 'user', 'Hero'); INSERT INTO chats(id, user_id) VALUES ('chat', 'user')");
}
function finishIndex(target = db): void {
  for (let i = 0; i < 1000; i++) {
    if (!populateImageReferenceIndex(target, 100, Infinity).pending) return;
  }
  throw new Error("Index did not finish");
}
function check(ids = [image], userId = "user") {
  const diagnostics = createImageReferenceDiagnostics(ids.length);
  const referenced = findReferencedImageIds(db, userId, new Set(ids), diagnostics);
  return { referenced, diagnostics };
}
function message(id: string, content: string, chat = "chat"): void {
  db.query("INSERT INTO messages(id, chat_id, index_in_chat, content) VALUES (?, ?, 0, ?)").run(id, chat, content);
}

beforeEach(() => { db = new Database(":memory:"); db.run(baseline); seed(db); });
afterEach(() => { db.close(true); if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

describe("durable image reference index", () => {
  test("extracts case insensitive and embedded UUIDs of every version without parsing JSON", () => {
    expect(extractImageIds([`prefix${image.toUpperCase()}suffix`, `{invalid json ${image}`, otherImage, null])).toEqual(new Set([image, otherImage]));
  });

  test("all six text sources retain their references and isolate owners", () => {
    const ids = Array.from({ length: 6 }, (_, i) => `${i + 1}0123456-1234-7234-8234-123456789abc`);
    db.query("UPDATE characters SET description = ? WHERE id = 'hero'").run(`prefix${ids[0].toUpperCase()}suffix`);
    db.query("INSERT INTO personas(id, user_id, name, metadata) VALUES ('persona', 'user', 'Persona', ?)").run(JSON.stringify({ image: ids[1] }));
    db.query("INSERT INTO presets(id, user_id, name, provider, metadata) VALUES ('preset', 'user', 'Preset', 'test', ?)").run(JSON.stringify({ image: ids[2] }));
    db.query("UPDATE chats SET metadata = ? WHERE id = 'chat'").run(JSON.stringify({ image: ids[3] }));
    message("message", ids[4]);
    db.query("INSERT INTO settings(key, user_id, value) VALUES ('test', 'user', ?)").run(ids[5]);
    finishIndex();
    const result = check([...ids, absentImage]);
    expect(result.referenced).toEqual(new Set(ids));
    expect(result.diagnostics.strategy).toBe("indexed");
    expect(check(ids, "other").referenced.size).toBe(0);
  });

  test("historical rows are scanned conservatively until upgrade backfill completes", () => {
    db.close(true);
    db = new Database(":memory:"); db.run(oldBaseline); seed(db);
    message("old", image);
    db.run(migration);
    expect(db.query("SELECT * FROM image_reference_dirty").all()).toEqual([]);
    const before = check();
    expect(before.referenced.has(image)).toBe(true);
    expect(before.diagnostics.strategy).toBe("backfill");
    expect(before.diagnostics.stages.some(stage => stage.name === "messages")).toBe(true);
    finishIndex();
    expect(check().diagnostics.strategy).toBe("indexed");
    expect(check().referenced.has(image)).toBe(true);
  });

  test("ready negative lookups use the B-tree without any history or LIKE scans", () => {
    for (let i = 0; i < 350; i++) message(`message-${i}`, "ordinary text");
    finishIndex();
    const query = spyOn(db, "query");
    try {
      const result = check([image, absentImage]);
      expect(result.referenced.size).toBe(0);
      expect(result.diagnostics.strategy).toBe("indexed");
      const sql = query.mock.calls.map(call => call[0] as string);
      expect(sql.some(text => /LIKE|FROM messages|SELECT metadata FROM|SELECT value FROM/i.test(text))).toBe(false);
    } finally { query.mockRestore(); }
    const plan = db.query("EXPLAIN QUERY PLAN SELECT 1 FROM image_references WHERE user_id = ? AND image_id = ? LIMIT 1").all("user", image) as { detail: string }[];
    expect(plan.some(row => row.detail.includes("idx_image_references_lookup"))).toBe(true);
  });

  test("raw writes refresh changed records before trusting an indexed negative result", () => {
    finishIndex();
    message("new", image);
    const inserted = check();
    expect(inserted.diagnostics.strategy).toBe("indexed");
    expect(inserted.diagnostics.dirtyProcessed).toBe(1);
    expect(inserted.referenced.has(image)).toBe(true);
    db.query("UPDATE messages SET content = ?, extra = ?, swipes = ? WHERE id = 'new'").run("", JSON.stringify({ attachment: otherImage }), JSON.stringify([image]));
    expect(check([image, otherImage]).referenced).toEqual(new Set([image, otherImage]));
    db.run("DELETE FROM messages WHERE id = 'new'");
    expect(check([image, otherImage]).referenced.size).toBe(0);
    expect(db.query("SELECT * FROM image_reference_dirty").all()).toEqual([]);
  });

  test("INSERT OR REPLACE imports invalidate existing mappings even with recursive triggers off", () => {
    message("imported", image); finishIndex();
    db.run("PRAGMA recursive_triggers = OFF");
    db.query("INSERT OR REPLACE INTO messages(id, chat_id, index_in_chat, content) VALUES ('imported', 'chat', 0, ?)").run(otherImage);
    expect(check([image, otherImage]).referenced).toEqual(new Set([otherImage]));
  });

  test("rollback restores both source references and invalidation state", () => {
    message("message", image); finishIndex();
    expect(() => db.transaction(() => {
      db.query("UPDATE messages SET content = ? WHERE id = 'message'").run(otherImage);
      expect(check([otherImage]).referenced.has(otherImage)).toBe(true);
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(check([image, otherImage]).referenced).toEqual(new Set([image]));
    expect(db.query("SELECT * FROM image_reference_dirty").all()).toEqual([]);
  });

  test("chat ownership transfer queues its messages and parent cascades remove mappings", () => {
    message("message", image); finishIndex();
    db.run("UPDATE chats SET user_id = 'other' WHERE id = 'chat'");
    expect(check([image], "other").referenced.has(image)).toBe(true);
    expect(check().referenced.has(image)).toBe(false);
    db.run("DELETE FROM chats WHERE id = 'chat'");
    expect(check([image], "other").referenced.size).toBe(0);
    expect(db.query("SELECT * FROM image_references WHERE source_type = 'messages'").all()).toEqual([]);
  });

  test("moving a message to another chat changes its reference owner", () => {
    message("message", image); finishIndex();
    db.run("INSERT INTO chats(id, user_id) VALUES ('other-chat', 'other'); UPDATE messages SET chat_id = 'other-chat' WHERE id = 'message'");
    expect(check([image], "other").referenced.has(image)).toBe(true);
    expect(check().referenced.has(image)).toBe(false);
  });

  test("tombstoned characters stop retaining their text and avatar references", () => {
    db.query("UPDATE characters SET description = ? WHERE id = 'hero'").run(image);
    finishIndex();
    expect(check().referenced.has(image)).toBe(true);
    db.run("UPDATE characters SET deleting = 1 WHERE id = 'hero'");
    expect(check().referenced.has(image)).toBe(false);
  });

  test("settings with the same key have independent mappings; key/owner changes invalidate them", () => {
    for (const user of ["user", "other"]) db.query("INSERT INTO settings(key, user_id, value) VALUES ('same', ?, ?)").run(user, image);
    finishIndex();
    db.run("DELETE FROM settings WHERE key = 'same' AND user_id = 'user'");
    expect(check().referenced.has(image)).toBe(false);
    expect(check([image], "other").referenced.has(image)).toBe(true);
    db.run("UPDATE settings SET key = 'renamed', user_id = 'user' WHERE key = 'same' AND user_id = 'other'");
    expect(check().referenced.has(image)).toBe(true);
    expect(check([image], "other").referenced.has(image)).toBe(false);
  });

  test("unrelated and no-op changes do not schedule reindexing", () => {
    message("message", image); finishIndex();
    db.run("UPDATE characters SET name = 'Renamed', tags = '[\"tag\"]'; UPDATE messages SET swipe_id = 1; UPDATE chats SET metadata = metadata; UPDATE characters SET description = description");
    expect(db.query("SELECT * FROM image_reference_dirty").all()).toEqual([]);
  });

  test("exact gallery, avatar, theme and wallpaper references remain protected without text mappings", () => {
    const ids = Array.from({ length: 5 }, (_, i) => `${i + 1}0123456-1234-4234-8234-123456789abc`);
    for (const id of ids) db.query("INSERT INTO images(id, user_id, filename) VALUES (?, 'user', 'image.png')").run(id);
    db.query("INSERT INTO character_gallery(id, user_id, character_id, image_id, created_at) VALUES ('gallery', 'user', 'hero', ?, 0)").run(ids[0]);
    db.query("UPDATE characters SET image_id = ? WHERE id = 'hero'").run(ids[1]);
    db.query("INSERT INTO personas(id, user_id, name, image_id) VALUES ('persona', 'user', 'Persona', ?)").run(ids[2]);
    db.query("INSERT INTO theme_assets(id, user_id, bundle_id, slug, storage_type, image_id) VALUES ('asset', 'user', 'bundle', 'slug', 'image', ?)").run(ids[3]);
    db.query("UPDATE images SET owner_extension_identifier = 'lumiverse.wallpaper' WHERE id = ?").run(ids[4]);
    finishIndex();
    expect(db.query("SELECT * FROM image_references").all()).toEqual([]);
    expect(check([...ids, absentImage]).referenced).toEqual(new Set(ids));
  });

  test("bounded refresh with remaining dirty rows falls back instead of missing a late reference", () => {
    finishIndex();
    for (let i = 0; i < 140; i++) message(String(i).padStart(3, "0"), i === 139 ? image : "empty");
    const result = check();
    expect(result.diagnostics.strategy).toBe("dirty-fallback");
    expect(result.diagnostics.dirtyProcessed).toBeLessThanOrEqual(100);
    expect(result.referenced.has(image)).toBe(true);
    finishIndex();
    expect(check().diagnostics.strategy).toBe("indexed");
  });

  test("row and time budgets bound background batches", () => {
    for (let i = 0; i < 30; i++) message(`message-${i}`, image);
    const result = populateImageReferenceIndex(db, 4, 0);
    expect(result.processed).toBe(1);
    expect(result.pending).toBe(true);
    const refresh = db.transaction(() => refreshImageReferenceIndex(db, "user", 3, Infinity)).immediate();
    expect(refresh.processed).toBe(3);
    expect(refresh.dirtyRemaining).toBe(true);
    finishIndex();
  });

  test("an idle background indexer does not acquire a writer transaction", () => {
    finishIndex();
    const transaction = spyOn(db, "transaction");
    try {
      expect(populateImageReferenceIndex(db)).toEqual({ processed: 0, pending: false });
      expect(transaction).not.toHaveBeenCalled();
    } finally { transaction.mockRestore(); }
  });

  test("every tracked text field invalidates its source when changed", () => {
    db.run("INSERT INTO personas(id, user_id, name) VALUES ('persona', 'user', 'Persona'); INSERT INTO presets(id, user_id, name, provider) VALUES ('preset', 'user', 'Preset', 'test'); INSERT INTO settings(key, user_id, value) VALUES ('test', 'user', '{}')");
    message("message", ""); finishIndex();
    const fields = {
      characters: ["extensions", "description", "personality", "scenario", "first_mes", "mes_example", "creator_notes", "system_prompt", "post_history_instructions", "alternate_greetings"],
      personas: ["metadata"], presets: ["metadata"], chats: ["metadata"], messages: ["extra", "swipes", "content"], settings: ["value"],
    };
    for (const [table, columns] of Object.entries(fields)) {
      for (const column of columns) {
        const before = (db.query(`SELECT ${column} AS value FROM ${table}`).get() as { value: string }).value;
        db.query(`UPDATE ${table} SET ${column} = ?`).run(JSON.stringify([image]));
        expect(check().referenced.has(image)).toBe(true);
        db.query(`UPDATE ${table} SET ${column} = ?`).run(before);
        expect(check().referenced.has(image)).toBe(false);
      }
    }
  });

  test("failed index refresh retains candidates and rolls back its partial work", () => {
    finishIndex(); message("message", image);
    db.run("CREATE TRIGGER reject_image_reference BEFORE INSERT ON image_references BEGIN SELECT RAISE(ABORT, 'test index failure'); END");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(check([image, absentImage]).referenced).toEqual(new Set([image, absentImage]));
      expect(check().diagnostics.strategy).toBe("index-error");
      expect(db.query("SELECT COUNT(*) AS count FROM image_reference_dirty").get()).toEqual({ count: 1 });
    } finally { error.mockRestore(); }
    db.run("DROP TRIGGER reject_image_reference");
    expect(check([image, absentImage]).referenced).toEqual(new Set([image]));
  });

  test("missing triggers or coverage state force a safe source scan", () => {
    finishIndex();
    db.run("DROP TRIGGER image_refs_messages_insert");
    message("message", image);
    expect(hasImageReferenceIndex(db)).toBe(false);
    expect(check().diagnostics.strategy).toBe("legacy");
    expect(check().referenced.has(image)).toBe(true);
  });

  test("missing backfill state never authorizes an indexed negative", () => {
    finishIndex();
    db.run("DELETE FROM image_reference_index_state WHERE source_type = 'messages'");
    message("message", image);
    expect(check().diagnostics.strategy).toBe("backfill");
    expect(check().referenced.has(image)).toBe(true);
  });

  test("non-UUID IDs retain legacy semantics even in bulk", () => {
    message("message", "legacy-image-id"); finishIndex();
    const result = check(["legacy-image-id", ...Array.from({ length: 9 }, (_, i) => `missing-${i}`)]);
    expect(result.referenced).toEqual(new Set(["legacy-image-id"]));
    expect(result.diagnostics.strategy).toBe("legacy");
  });

  test("large batches and mixed-case candidates retain all matching originals", () => {
    message("message", `prefix${image.toUpperCase()}suffix`); finishIndex();
    const ids = [image, image.toUpperCase(), ...Array.from({ length: 450 }, (_, i) => `${String(i).padStart(8, "0")}-1234-7234-8234-123456789abc`)];
    expect(check(ids).referenced).toEqual(new Set([image, image.toUpperCase()]));
    // Check the conservative pre-index bulk path too.
    db.run("UPDATE image_reference_index_state SET completed = 0");
    expect(check(ids).referenced).toEqual(new Set([image, image.toUpperCase()]));
  });

  test("backfill resumes from a stable primary-key cursor after reopen and VACUUM", () => {
    db.close(true);
    directory = mkdtempSync(join(tmpdir(), "lumiverse-image-index-"));
    const path = join(directory, "db.sqlite");
    db = openFileDatabase(path);
    // Schema and seed data are fixture setup, not hundreds of separate commits.
    db.transaction(() => {
      db.run(oldBaseline); seed(db);
      for (let i = 0; i < 20; i++) message(`message-${String(i).padStart(3, "0")}`, image);
      db.run(migration);
    })();
    for (let i = 0; i < 3; i++) populateImageReferenceIndex(db, 2, Infinity);
    expect(db.query("SELECT last_id FROM image_reference_index_state WHERE source_type = 'messages'").get()).toEqual({ last_id: "message-001" });
    db.close(true); db = openFileDatabase(path); db.run("VACUUM");
    const writer = openFileDatabase(path);
    try { writer.query("UPDATE messages SET content = ? WHERE id = 'message-000'").run(otherImage); }
    finally { writer.close(true); }
    finishIndex();
    expect(db.query("SELECT COUNT(DISTINCT source_id) AS count FROM image_references WHERE source_type = 'messages'").get()).toEqual({ count: 20 });
    expect(check([image, otherImage]).referenced).toEqual(new Set([image, otherImage]));
  });

  test("failed backfill batches roll back their cursors and retry safely", () => {
    db.close(true); db = new Database(":memory:"); db.run(oldBaseline); seed(db);
    message("old", image); db.run(migration);
    db.run("CREATE TRIGGER reject_image_reference BEFORE INSERT ON image_references BEGIN SELECT RAISE(ABORT, 'test backfill failure'); END");
    populateImageReferenceIndex(db); populateImageReferenceIndex(db);
    expect(() => populateImageReferenceIndex(db)).toThrow("test backfill failure");
    expect(db.query("SELECT last_id, completed FROM image_reference_index_state WHERE source_type = 'messages'").get()).toEqual({ last_id: null, completed: 0 });
    expect(check().referenced.has(image)).toBe(true);
    db.run("DROP TRIGGER reject_image_reference"); finishIndex();
    expect(check().diagnostics.strategy).toBe("indexed");
  });

  test("timings and counts are serializable and formatted without image IDs", () => {
    message("message", image);
    const { diagnostics } = check([image, absentImage]);
    expect(diagnostics.candidateCount).toBe(2);
    expect(diagnostics.referencedCount).toBe(1);
    expect(diagnostics.stages.every(stage => stage.durationMs >= 0)).toBe(true);
    const detail = formatImageReferenceDiagnostics(diagnostics);
    expect(detail).toContain("candidates=2"); expect(detail).toContain("strategy=backfill");
    expect(detail).toContain("messages:"); expect(detail).not.toContain(image);
    const resultMessage = { type: "result" as const, requestId: "request", result: [image], durationMs: 500, imageReferences: diagnostics };
    // The framing helper decodes the payload after the four-byte length header.
    expect(deserialize(encodeDatabaseMessage(resultMessage).subarray(4))).toEqual(resultMessage);
  });

  for (const transport of (process.platform === "win32" ? ["socket"] : ["socket", "stdio", "ipc"]) as Array<"socket" | "stdio" | "ipc">) {
    test(`subprocess backfills and observes another connection's writes over ${transport}`, async () => {
      db.close(true);
      directory = mkdtempSync(join(tmpdir(), "lumiverse-image-index-worker-"));
      const path = join(directory, "db.sqlite");
      db = openFileDatabase(path);
      db.transaction(() => { db.run(oldBaseline); seed(db); message("old", image); db.run(migration); })();
      const executor = new DatabaseExecutor(path, { transport });
      try {
        await executor.execute({ kind: "checkpoint" });
        const deadline = Date.now() + 2000;
        while ((db.query("SELECT COUNT(*) AS count FROM image_reference_index_state WHERE completed = 0").get() as { count: number }).count > 0 && Date.now() < deadline) await Bun.sleep(10);
        expect(db.query("SELECT COUNT(*) AS count FROM image_reference_index_state WHERE completed = 0").get()).toEqual({ count: 0 });
        expect(await executor.execute<string[]>({ kind: "image-references", userId: "user", ids: [image, absentImage] })).toEqual([image]);
        db.query("UPDATE messages SET content = ? WHERE id = 'old'").run(otherImage);
        expect(await executor.execute<string[]>({ kind: "image-references", userId: "user", ids: [image, otherImage] })).toEqual([otherImage]);
      } finally { await executor.close(); }
    });
  }
});
