import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteStaleMessageBreakdowns,
  runDatabaseMaintenance,
} from "./maintenance";

const temporaryDirectories: string[] = [];

function createBreakdownDatabase(path = ":memory:"): Database {
  const db = new Database(path);
  db.run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    index_in_chat INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE message_breakdowns (
    message_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    user_id TEXT,
    data TEXT NOT NULL
  )`);
  return db;
}

function insertChat(db: Database, id: string, userId = "u1"): void {
  db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run(id, userId);
}

function insertMessage(db: Database, id: string, chatId: string, index: number): void {
  db.query("INSERT INTO messages (id, chat_id, index_in_chat) VALUES (?, ?, ?)").run(id, chatId, index);
}

function insertBreakdown(
  db: Database,
  messageId: string,
  chatId: string,
  marker = messageId,
  userId: string | null = "u1",
): void {
  db.query(
    "INSERT INTO message_breakdowns (message_id, chat_id, user_id, data) VALUES (?, ?, ?, ?)",
  ).run(messageId, chatId, userId, JSON.stringify({ marker }));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("stale message-breakdown cleanup", () => {
  test("removes true orphans and mismatches without pruning live gap snapshots", () => {
    const db = createBreakdownDatabase();

    insertChat(db, "gap-chat");
    insertMessage(db, "gap-before", "gap-chat", 0);
    insertMessage(db, "gap-after", "gap-chat", 2);
    insertBreakdown(db, "gap-before", "gap-chat");
    insertBreakdown(db, "deleted-message", "gap-chat", "direct-orphan");
    insertBreakdown(db, "gap-after", "gap-chat", "embedded-deleted-content");

    insertChat(db, "deleted-chat");
    insertMessage(db, "deleted-chat-message", "deleted-chat", 0);
    insertBreakdown(db, "deleted-chat-message", "deleted-chat");
    db.query("DELETE FROM messages WHERE chat_id = ?").run("deleted-chat");
    db.query("DELETE FROM chats WHERE id = ?").run("deleted-chat");

    insertChat(db, "keep-chat", "u2");
    insertMessage(db, "keep-zero", "keep-chat", 0);
    insertMessage(db, "keep-one", "keep-chat", 1);
    insertBreakdown(db, "keep-zero", "keep-chat", "keep-zero", "u2");
    insertBreakdown(db, "keep-one", "keep-chat", "keep-one", "u2");

    insertChat(db, "mismatch-chat");
    insertMessage(db, "mismatch-message", "mismatch-chat", 0);
    insertBreakdown(db, "mismatch-message", "mismatch-chat", "wrong-owner", "u2");

    expect(deleteStaleMessageBreakdowns(db)).toBe(3);
    expect(
      db.query("SELECT message_id FROM message_breakdowns ORDER BY message_id").all(),
    ).toEqual([
      { message_id: "gap-after" },
      { message_id: "gap-before" },
      { message_id: "keep-one" },
      { message_id: "keep-zero" },
    ]);
    expect(deleteStaleMessageBreakdowns(db)).toBe(0);

    db.close();
  });

  test("VACUUM purges a legacy marker from the database file", () => {
    const directory = mkdtempSync(join(tmpdir(), "lumiverse-breakdown-vacuum-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "test.db");
    const marker = "legacy-deleted-message-private-marker";
    const db = createBreakdownDatabase(path);

    insertChat(db, "chat");
    insertMessage(db, "message", "chat", 0);
    insertBreakdown(db, "message", "chat", marker);
    db.query("DELETE FROM messages WHERE id = ?").run("message");

    const result = runDatabaseMaintenance(db, {
      dbPath: path,
      optimize: false,
      vacuum: true,
    });
    db.close();

    expect(result.vacuumed).toBe(true);
    expect(result.staleBreakdownsDeleted).toBe(1);
    expect(readFileSync(path).includes(Buffer.from(marker))).toBe(false);
  });

  test("the one-time cleanup plus VACUUM purges content embedded after a deletion gap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lumiverse-breakdown-gap-vacuum-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "test.db");
    const marker = "legacy-message-embedded-in-later-prompt";
    const db = createBreakdownDatabase(path);

    insertChat(db, "chat");
    insertMessage(db, "before-gap", "chat", 0);
    insertMessage(db, "after-gap", "chat", 2);
    insertBreakdown(db, "after-gap", "chat", marker);

    const migration = await Bun.file(
      `${import.meta.dir}/migrations/114_cleanup_stale_message_breakdowns.sql`,
    ).text();
    db.run(migration);
    expect(db.query("SELECT 1 FROM message_breakdowns").get()).toBeNull();

    const result = runDatabaseMaintenance(db, {
      dbPath: path,
      optimize: false,
      vacuum: true,
    });
    db.close();

    expect(result.vacuumed).toBe(true);
    expect(result.staleBreakdownsDeleted).toBe(0);
    expect(readFileSync(path).includes(Buffer.from(marker))).toBe(false);
  });
});
