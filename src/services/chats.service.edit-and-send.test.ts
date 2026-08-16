import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { editAndSend, getChat, getMessage, getMessages } from "./chats.service";
import { getGenerationOutboxByRequest } from "./edit-and-send-dispatcher.service";

const USER = "u1";

function initEditAndSendTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();

  db.run(`CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '',
    scenario TEXT NOT NULL DEFAULT '',
    first_mes TEXT NOT NULL DEFAULT '',
    mes_example TEXT NOT NULL DEFAULT '',
    creator TEXT NOT NULL DEFAULT '',
    creator_notes TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    post_history_instructions TEXT NOT NULL DEFAULT '',
    avatar_path TEXT,
    image_id TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    alternate_greetings TEXT NOT NULL DEFAULT '[]',
    extensions TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT 1
  )`);

  db.run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    character_id TEXT,
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
    created_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  )`);

  db.run(`CREATE TABLE chat_memory_cache (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    settings_key TEXT NOT NULL,
    source_message_count INTEGER NOT NULL DEFAULT 0,
    query_preview TEXT NOT NULL DEFAULT '',
    chunks_json TEXT NOT NULL DEFAULT '[]',
    formatted TEXT NOT NULL DEFAULT '',
    count INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    settings_source TEXT NOT NULL DEFAULT 'global',
    chunks_available INTEGER NOT NULL DEFAULT 0,
    chunks_pending INTEGER NOT NULL DEFAULT 0,
    retrieval_mode TEXT NOT NULL DEFAULT 'empty',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(chat_id, settings_key)
  )`);

  db.run(`CREATE TABLE edit_and_send_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    branch_chat_id TEXT NOT NULL,
    edited_message_id TEXT NOT NULL,
    target_message_id TEXT,
    target_swipe_index INTEGER,
    generation_id TEXT NOT NULL,
    response TEXT NOT NULL,
    cursor TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, chat_id, request_id)
  )`);

  db.run(`CREATE TABLE generation_outbox (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    branch_chat_id TEXT NOT NULL,
    edited_message_id TEXT NOT NULL,
    target_message_id TEXT,
    target_swipe_index INTEGER,
    expected_version INTEGER NOT NULL,
    generation_id TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL CHECK(mode IN ('normal', 'swipe')),
    status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
    lease_owner TEXT,
    lease_expires_at INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    last_error_code TEXT,
    terminal_reason TEXT,
    dispatched_at INTEGER,
    completed_at INTEGER,
    cancelled_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

function seedCharacter(): void {
  getDb().query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run("char1", USER, "Alpha");
}

function seedChat(id: string): void {
  getDb()
    .query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, USER, "char1", "Chat", "{}", 1, 1);
}

function seedMessage(
  id: string,
  chatId: string,
  content: string,
  options: { index: number; isUser?: boolean; revision?: number },
): void {
  const isUser = options.isUser ?? false;
  getDb()
    .query(
      `INSERT INTO messages (
        id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id,
        swipes, swipe_dates, extra, parent_message_id, branch_id, created_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      chatId,
      options.index,
      isUser ? 1 : 0,
      isUser ? "User" : "Assistant",
      content,
      100 + options.index,
      0,
      JSON.stringify([content]),
      JSON.stringify([100 + options.index]),
      "{}",
      null,
      null,
      100 + options.index,
      options.revision ?? 1,
    );
}

beforeEach(() => {
  initEditAndSendTestDb();
  seedCharacter();
});

afterEach(() => closeDatabase());

describe("edit-and-send branching", () => {
  test("branching tail/historical/empty", () => {
    seedChat("empty-chat");
    seedMessage("empty-greet", "empty-chat", "Hi", { index: 0 });
    seedMessage("empty-user", "empty-chat", "first", { index: 1, isUser: true });

    const empty = editAndSend(USER, "empty-chat", {
      messageId: "empty-user",
      content: "first edited",
      expectedVersion: 1,
      requestId: "empty-req",
    });
    expect(empty.status).toBe("ok");
    if (empty.status !== "ok") return;
    expect(empty.replayed).toBe(false);
    expect(empty.payload.immediateAssistantId).toBeNull();
    expect(empty.payload.generationCursor.mode).toBe("normal");
    const emptyBranch = getMessages(USER, empty.payload.branchChatId);
    expect(emptyBranch.map((message) => ({ is_user: message.is_user, content: message.content }))).toEqual([
      { is_user: false, content: "Hi" },
      { is_user: true, content: "first edited" },
    ]);
    expect(getMessages(USER, "empty-chat").map((message) => message.content)).toEqual(["Hi", "first"]);
    const emptyOutbox = getGenerationOutboxByRequest(USER, "empty-chat", "empty-req");
    expect(emptyOutbox?.mode).toBe("normal");
    expect(emptyOutbox?.status).toBe("pending");
    expect(emptyOutbox?.generation_id).toBe(empty.payload.generationCursor.generationId);
    expect(emptyOutbox?.target_message_id).toBeNull();

    seedChat("tail-chat");
    seedMessage("tail-greet", "tail-chat", "Hello", { index: 0 });
    seedMessage("tail-user", "tail-chat", "ask", { index: 1, isUser: true });
    seedMessage("tail-asst", "tail-chat", "reply", { index: 2 });

    const tail = editAndSend(USER, "tail-chat", {
      messageId: "tail-user",
      content: "ask again",
      expectedVersion: 1,
      requestId: "tail-req",
    });
    expect(tail.status).toBe("ok");
    if (tail.status !== "ok") return;
    expect(tail.payload.generationCursor.mode).toBe("swipe");
    expect(tail.payload.immediateAssistantId).toBeTruthy();
    const tailBranch = getMessages(USER, tail.payload.branchChatId);
    expect(tailBranch).toHaveLength(3);
    expect(tailBranch[1]?.content).toBe("ask again");
    expect(tailBranch[2]?.id).toBe(tail.payload.immediateAssistantId);
    expect(tailBranch[2]?.content).toBe("reply");
    expect(getMessages(USER, "tail-chat")).toHaveLength(3);
    const tailOutbox = getGenerationOutboxByRequest(USER, "tail-chat", "tail-req");
    expect(tailOutbox?.mode).toBe("swipe");
    expect(tailOutbox?.target_message_id).toBe(tail.payload.immediateAssistantId);
    expect(tailOutbox?.target_swipe_index).toBe(1);

    seedChat("hist-chat");
    seedMessage("hist-greet", "hist-chat", "Greet", { index: 0 });
    seedMessage("hist-user-1", "hist-chat", "one", { index: 1, isUser: true });
    seedMessage("hist-asst-1", "hist-chat", "one reply", { index: 2 });
    seedMessage("hist-user-2", "hist-chat", "two", { index: 3, isUser: true });
    seedMessage("hist-asst-2", "hist-chat", "two reply", { index: 4 });

    const historical = editAndSend(USER, "hist-chat", {
      messageId: "hist-user-1",
      content: "one rewritten",
      expectedVersion: 1,
      requestId: "hist-req",
    });
    expect(historical.status).toBe("ok");
    if (historical.status !== "ok") return;
    const histBranch = getMessages(USER, historical.payload.branchChatId);
    expect(histBranch.map((message) => message.content)).toEqual(["Greet", "one rewritten", "one reply"]);
    expect(getMessages(USER, "hist-chat").map((message) => message.content)).toEqual([
      "Greet",
      "one",
      "one reply",
      "two",
      "two reply",
    ]);
    const branchChat = getChat(USER, historical.payload.branchChatId);
    expect(branchChat?.metadata.branched_from).toBe("hist-chat");
    expect(historical.payload.generationCursor.mode).toBe("swipe");
    expect(getMessage(USER, "hist-user-1")).toMatchObject({ content: "one", revision: 2 });
  });

  test("rejects stale expectedVersion and replays identical requestId", () => {
    seedChat("chat");
    seedMessage("user-1", "chat", "hello", { index: 0, isUser: true, revision: 3 });

    const stale = editAndSend(USER, "chat", {
      messageId: "user-1",
      content: "hello edited",
      expectedVersion: 1,
      requestId: "req-stale",
    });
    expect(stale).toEqual({ status: "conflict", error: "Message revision mismatch" });

    const first = editAndSend(USER, "chat", {
      messageId: "user-1",
      content: "hello edited",
      expectedVersion: 3,
      requestId: "req-1",
    });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;

    const replay = editAndSend(USER, "chat", {
      messageId: "user-1",
      content: "hello edited",
      expectedVersion: 3,
      requestId: "req-1",
    });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.replayed).toBe(true);
    expect(replay.payload).toEqual(first.payload);

    const clash = editAndSend(USER, "chat", {
      messageId: "user-1",
      content: "different",
      expectedVersion: 3,
      requestId: "req-1",
    });
    expect(clash.status).toBe("conflict");
    expect(getDb().query("SELECT COUNT(*) AS count FROM chats").get()).toEqual({ count: 2 });
    expect(getDb().query("SELECT COUNT(*) AS count FROM generation_outbox").get()).toEqual({ count: 1 });
  });
});
