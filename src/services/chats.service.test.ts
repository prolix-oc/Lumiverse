import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  addSwipe,
  cycleSwipe,
  getMessage,
  listRecentChats,
  listRecentChatsGrouped,
  patchMessageExtra,
} from "./chats.service";

function initChatsTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();

  db.run(`CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    avatar_path TEXT,
    image_id TEXT
  )`);

  db.run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    character_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    index_in_chat INTEGER NOT NULL,
    is_user INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    send_date INTEGER NOT NULL,
    swipe_id INTEGER NOT NULL DEFAULT 0,
    swipes TEXT NOT NULL DEFAULT '[]',
    swipe_dates TEXT NOT NULL DEFAULT '[]',
    extra TEXT NOT NULL DEFAULT '{}',
    parent_message_id TEXT,
    branch_id TEXT,
    created_at INTEGER NOT NULL
  )`);
}

function seedCharacter(id: string, name: string): void {
  getDb().query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run(id, "u1", name);
}

function seedChat(id: string, characterId: string, name: string, metadata: string, updatedAt: number): void {
  getDb()
    .query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, "u1", characterId, name, metadata, updatedAt, updatedAt);
}

function seedMessage(
  id: string,
  chatId: string,
  content: string,
  extra: Record<string, unknown>,
): void {
  getDb()
    .query(
      `INSERT INTO messages (
        id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id,
        swipes, swipe_dates, extra, parent_message_id, branch_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      chatId,
      0,
      0,
      "Assistant",
      content,
      100,
      0,
      JSON.stringify([content]),
      JSON.stringify([100]),
      JSON.stringify(extra),
      null,
      null,
      100,
    );
}

beforeEach(() => {
  initChatsTestDb();
  seedCharacter("c1", "Alpha");
  seedCharacter("c2", "Beta");
});

afterEach(() => {
  closeDatabase();
});

describe("recent chats", () => {
  test("loads recent chats with malformed metadata", () => {
    seedChat("bad", "c1", "Bad metadata", "not json", 200);
    seedChat("good", "c2", "Good metadata", "{}", 100);

    const result = listRecentChats("u1", { limit: 10, offset: 0 });

    expect(result.total).toBe(2);
    expect(result.data.map((chat) => chat.id)).toEqual(["bad", "good"]);
    expect(result.data[0].metadata).toEqual({});
  });

  test("groups recent chats without SQLite JSON extraction", () => {
    seedChat("c1-old", "c1", "Alpha old", "{}", 100);
    seedChat("group", "c1", "Group", JSON.stringify({ group: true, character_ids: ["c1", "c2"] }), 150);
    seedChat("c1-new", "c1", "Alpha new", "{}", 200);
    seedChat("bad", "c2", "Bad metadata", "not json", 250);

    const result = listRecentChatsGrouped("u1", { limit: 10, offset: 0 });

    expect(result.total).toBe(3);
    expect(result.data.map((chat) => chat.latest_chat_id)).toEqual(["bad", "c1-new", "group"]);
    expect(result.data[1].chat_count).toBe(2);
    expect(result.data[2].is_group).toBe(true);
    expect(result.data[2].group_character_ids).toEqual(["c1", "c2"]);
  });

  test("keeps reasoning scoped to the swipe it belongs to", () => {
    seedChat("chat-1", "c1", "Swipe chat", "{}", 100);
    seedMessage("msg-1", "chat-1", "first swipe", {
      reasoning: "first swipe reasoning",
      reasoningDuration: 123,
    });

    const added = addSwipe("u1", "msg-1", "")!;
    expect(added.swipe_id).toBe(1);
    expect(added.extra.reasoning).toBeUndefined();
    expect(added.extra.reasoningDuration).toBeUndefined();

    patchMessageExtra("u1", "msg-1", {
      ...added.extra,
      reasoning: "second swipe reasoning",
      reasoningDuration: 456,
    });

    const secondSwipe = getMessage("u1", "msg-1")!;
    expect(secondSwipe.swipe_id).toBe(1);
    expect(secondSwipe.extra.reasoning).toBe("second swipe reasoning");
    expect(secondSwipe.extra.reasoningDuration).toBe(456);

    const firstSwipe = cycleSwipe("u1", "msg-1", "left")!;
    expect(firstSwipe.swipe_id).toBe(0);
    expect(firstSwipe.extra.reasoning).toBe("first swipe reasoning");
    expect(firstSwipe.extra.reasoningDuration).toBe(123);

    const restoredSecondSwipe = cycleSwipe("u1", "msg-1", "right")!;
    expect(restoredSecondSwipe.swipe_id).toBe(1);
    expect(restoredSecondSwipe.extra.reasoning).toBe("second swipe reasoning");
    expect(restoredSecondSwipe.extra.reasoningDuration).toBe(456);
  });
});
