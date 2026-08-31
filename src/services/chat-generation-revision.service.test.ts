import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  bumpChatAndMessageGenerationRevision,
  bumpMessageGenerationRevision,
  readChatGenerationRevision,
} from "./chat-generation-revision.service";

describe("chat generation revisions", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(`
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        generation_revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        generation_revision INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run("chat-1", "user-1");
    db.query("INSERT INTO messages (id, chat_id) VALUES (?, ?)").run("message-1", "chat-1");
  });

  afterEach(() => {
    db.close();
  });

  test("increments both revisions inside the caller transaction", () => {
    const transaction = db.transaction(() => {
      const revision = bumpChatAndMessageGenerationRevision(db, "chat-1", "message-1", "user-1");
      expect(revision).toEqual({
        chatId: "chat-1",
        chatRevision: 1,
        messageId: "message-1",
        messageRevision: 1,
      });
    });
    transaction();

    expect(readChatGenerationRevision(db, "chat-1", "message-1")).toEqual({
      chatId: "chat-1",
      chatRevision: 1,
      messageId: "message-1",
      messageRevision: 1,
    });
  });

  test("reads a message revision when no chat filter is supplied", () => {
    expect(bumpMessageGenerationRevision(db, "message-1")).toBe(1);
  });
});
