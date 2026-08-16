import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { chatsRoutes } from "./chats.routes";
import {
  resetEditAndSendDispatcherForTests,
  setEditAndSendStartGeneration,
  getGenerationOutboxByRequest,
} from "../services/edit-and-send-dispatcher.service";

const USER_ID = "user-1";

function initRouteTestDb(): void {
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

function seedHistory(): void {
  getDb().query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run("char1", USER_ID, "Alpha");
  getDb()
    .query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("chat-1", USER_ID, "char1", "Chat", "{}", 1, 1);
  const insert = getDb().query(
    `INSERT INTO messages (
      id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id,
      swipes, swipe_dates, extra, parent_message_id, branch_id, created_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  insert.run("greet", "chat-1", 0, 0, "Assistant", "Hi", 1, 0, JSON.stringify(["Hi"]), JSON.stringify([1]), "{}", null, null, 1);
  insert.run("user-1", "chat-1", 1, 1, "User", "Hello", 2, 0, JSON.stringify(["Hello"]), JSON.stringify([2]), "{}", null, null, 2);
  insert.run("asst-1", "chat-1", 2, 0, "Assistant", "There", 3, 0, JSON.stringify(["There"]), JSON.stringify([3]), "{}", null, null, 3);
}

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("userId", USER_ID);
  await next();
});
app.route("/", chatsRoutes);

beforeEach(() => {
  initRouteTestDb();
  seedHistory();
  resetEditAndSendDispatcherForTests();
});

afterEach(() => {
  resetEditAndSendDispatcherForTests();
  closeDatabase();
});

describe("POST /:chatId/edit-and-send", () => {
  test("commits a swipe branch then dispatches the durable generation identity", async () => {
    const started: Array<Record<string, unknown>> = [];
    setEditAndSendStartGeneration(async (input) => {
      started.push(input);
      return { generationId: input.generationId, status: "streaming" };
    });

    const response = await app.request("http://localhost/chat-1/edit-and-send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: "user-1",
        content: "Hello again",
        expectedVersion: 1,
        requestId: "req-1",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.branchChatId).toBeString();
    expect(body.editedMessageId).toBeString();
    expect(body.immediateAssistantId).toBeString();
    expect(body.generationCursor).toMatchObject({
      requestId: "req-1",
      mode: "swipe",
      chatId: body.branchChatId,
    });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      userId: USER_ID,
      chat_id: body.branchChatId,
      generationId: body.generationCursor.generationId,
      generation_type: "swipe",
      message_id: body.immediateAssistantId,
    });
    const outbox = getGenerationOutboxByRequest(USER_ID, "chat-1", "req-1");
    expect(outbox?.status).toBe("running");
    expect(outbox?.dispatched_at).toBeNumber();
    expect(outbox?.generation_id).toBe(body.generationCursor.generationId);
  });

  test("validates the body and is idempotent for the same requestId", async () => {
    let startCount = 0;
    setEditAndSendStartGeneration(async (input) => {
      startCount++;
      return { generationId: input.generationId, status: "streaming" };
    });

    const missing = await app.request("http://localhost/chat-1/edit-and-send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(missing.status).toBe(400);

    const unknown = await app.request("http://localhost/missing/edit-and-send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: "user-1",
        content: "Hello again",
        expectedVersion: 1,
        requestId: "req-missing",
      }),
    });
    expect(unknown.status).toBe(404);

    const first = await app.request("http://localhost/chat-1/edit-and-send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: "user-1",
        content: "Hello again",
        expectedVersion: 1,
        requestId: "req-2",
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const replay = await app.request("http://localhost/chat-1/edit-and-send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: "user-1",
        content: "Hello again",
        expectedVersion: 1,
        requestId: "req-2",
      }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(startCount).toBe(1);

    const clash = await app.request("http://localhost/chat-1/edit-and-send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: "user-1",
        content: "Different",
        expectedVersion: 1,
        requestId: "req-2",
      }),
    });
    expect(clash.status).toBe(409);
  });
});
