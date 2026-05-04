import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  addSwipe,
  convertSoloChatToGroup,
  getChat,
  cycleSwipe,
  getMessage,
  getMessages,
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
  options?: { index?: number; isUser?: boolean; name?: string; sendDate?: number },
): void {
  const index = options?.index ?? 0;
  const isUser = options?.isUser ?? false;
  const name = options?.name ?? (isUser ? "User" : "Assistant");
  const sendDate = options?.sendDate ?? 100;
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
      index,
      isUser ? 1 : 0,
      name,
      content,
      sendDate,
      0,
      JSON.stringify([content]),
      JSON.stringify([sendDate]),
      JSON.stringify(extra),
      null,
      null,
      sendDate,
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

  test("keeps generation metadata scoped to the active swipe", () => {
    seedChat("chat-1", "c1", "Swipe chat", "{}", 100);
    seedMessage("msg-1", "chat-1", "first swipe", {
      tokenCount: 11,
      generationMetrics: { model: "first-model", tps: 1.1 },
      usage: { completion_tokens: 11, total_tokens: 22 },
    });

    const added = addSwipe("u1", "msg-1", "")!;
    expect(added.swipe_id).toBe(1);
    expect(added.extra.tokenCount).toBeUndefined();
    expect(added.extra.generationMetrics).toBeUndefined();
    expect(added.extra.usage).toBeUndefined();

    patchMessageExtra("u1", "msg-1", {
      ...added.extra,
      tokenCount: 33,
      generationMetrics: { model: "second-model", tps: 3.3 },
      usage: { completion_tokens: 33, total_tokens: 44 },
    });

    const secondSwipe = getMessage("u1", "msg-1")!;
    expect(secondSwipe.extra.tokenCount).toBe(33);
    expect(secondSwipe.extra.generationMetrics).toEqual({ model: "second-model", tps: 3.3 });
    expect(secondSwipe.extra.usage).toEqual({ completion_tokens: 33, total_tokens: 44 });

    const firstSwipe = cycleSwipe("u1", "msg-1", "left")!;
    expect(firstSwipe.swipe_id).toBe(0);
    expect(firstSwipe.extra.tokenCount).toBe(11);
    expect(firstSwipe.extra.generationMetrics).toEqual({ model: "first-model", tps: 1.1 });
    expect(firstSwipe.extra.usage).toEqual({ completion_tokens: 11, total_tokens: 22 });

    const restoredSecondSwipe = cycleSwipe("u1", "msg-1", "right")!;
    expect(restoredSecondSwipe.swipe_id).toBe(1);
    expect(restoredSecondSwipe.extra.tokenCount).toBe(33);
    expect(restoredSecondSwipe.extra.generationMetrics).toEqual({ model: "second-model", tps: 3.3 });
    expect(restoredSecondSwipe.extra.usage).toEqual({ completion_tokens: 33, total_tokens: 44 });
  });

  test("converts a solo chat into a new group chat with copied messages", () => {
    seedChat("solo", "c1", "Alpha chat", JSON.stringify({ author_note: "keep me" }), 200);
    seedMessage("msg-1", "solo", "Hello there", { greeting: true }, { index: 0, sendDate: 100 });
    seedMessage("msg-2", "solo", "Hi back", { persona_id: "p1" }, { index: 1, isUser: true, name: "User", sendDate: 150 });

    const converted = convertSoloChatToGroup("u1", "solo")!;
    const copiedMessages = getMessages("u1", converted.id);
    const original = getChat("u1", "solo")!;

    expect(converted.id).not.toBe("solo");
    expect(converted.character_id).toBe("c1");
    expect(converted.name).toBe("Alpha chat");
    expect(converted.metadata).toEqual({
      author_note: "keep me",
      group: true,
      character_ids: ["c1"],
    });
    expect(copiedMessages).toHaveLength(2);
    expect(copiedMessages.map((message) => ({
      is_user: message.is_user,
      name: message.name,
      content: message.content,
      send_date: message.send_date,
      extra: message.extra,
    }))).toEqual([
      {
        is_user: false,
        name: "Assistant",
        content: "Hello there",
        send_date: 100,
        extra: { greeting: true },
      },
      {
        is_user: true,
        name: "User",
        content: "Hi back",
        send_date: 150,
        extra: { persona_id: "p1" },
      },
    ]);
    expect(original.metadata).toEqual({ author_note: "keep me" });
  });
});
