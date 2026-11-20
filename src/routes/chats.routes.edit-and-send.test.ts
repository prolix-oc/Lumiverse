import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { chatsRoutes } from "./chats.routes";
import {
  resetEditAndSendDispatcherForTests,
  setEditAndSendStartGeneration,
  getGenerationOutboxByRequest,
  type StartEditAndSendGenerationInput,
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
    updated_at INTEGER NOT NULL,
    -- migrations/111_generation_outbox_connection_id.sql. Hand-written schema
    -- (no migrations run here), so the column is mirrored last to match the
    -- ALTER TABLE append order.
    connection_id TEXT
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
  test("commits a historical branch and dispatches only the copied assistant identity", async () => {
    const started: StartEditAndSendGenerationInput[] = [];
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
        branchChatOnEditAndSend: true,
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      branchChatId: expect.any(String),
      editedMessageId: expect.any(String),
      immediateAssistantId: expect.any(String),
      generationCursor: {
        generationId: expect.any(String),
        chatId: expect.any(String),
        requestId: "req-1",
        mode: "swipe",
        editAndSendContext: {
          editedUserMessageId: body.editedMessageId,
          committedRevision: 2,
        },
      },
    });
    expect(body.branchChatId).not.toBe("chat-1");
    expect(body.editedMessageId).not.toBe("user-1");
    expect(body.immediateAssistantId).not.toBe("asst-1");
    expect(body.generationCursor.chatId).toBe(body.branchChatId);
    expect(getDb().query(
      "SELECT id, chat_id, is_user, content, revision FROM messages WHERE id = ?",
    ).get(body.immediateAssistantId)).toEqual({
      id: body.immediateAssistantId,
      chat_id: body.branchChatId,
      is_user: 0,
      content: "There",
      revision: 1,
    });
    expect(getDb().query(
      "SELECT id, chat_id, is_user, content, revision FROM messages WHERE id = ?",
    ).get("asst-1")).toEqual({
      id: "asst-1",
      chat_id: "chat-1",
      is_user: 0,
      content: "There",
      revision: 1,
    });
    expect(started).toEqual([{
      userId: USER_ID,
      chat_id: body.branchChatId,
      generationId: body.generationCursor.generationId,
      generation_type: "swipe",
      message_id: body.immediateAssistantId,
    }]);

    const outbox = getGenerationOutboxByRequest(USER_ID, "chat-1", "req-1");
    expect(outbox).toEqual({
      id: expect.any(String),
      request_id: "req-1",
      user_id: USER_ID,
      chat_id: "chat-1",
      branch_chat_id: body.branchChatId,
      edited_message_id: body.editedMessageId,
      target_message_id: body.immediateAssistantId,
      target_swipe_index: 1,
      expected_version: 1,
      generation_id: body.generationCursor.generationId,
      mode: "swipe",
      status: "running",
      lease_owner: expect.any(String),
      lease_expires_at: expect.any(Number),
      attempt_count: 1,
      next_attempt_at: null,
      last_error_code: null,
      terminal_reason: null,
      dispatched_at: expect.any(Number),
      completed_at: null,
      cancelled_at: null,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
      // This harness creates no `settings` / `connection_profiles` tables, so
      // `resolveEditAndSendConnectionId` resolves nothing and the committed
      // identity is NULL — the documented "fall back to the legacy
      // resolve-at-dispatch ladder" value. Asserted rather than omitted, because
      // it also proves a missing connection surface cannot fail the route.
      connection_id: null,
    });
    expect(getGenerationOutboxByRequest(USER_ID, body.branchChatId, "req-1")).toBeNull();
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

  test("accepts in-place mode and dispatches the source chat and source assistant", async () => {
    const started: StartEditAndSendGenerationInput[] = [];
    setEditAndSendStartGeneration(async (input) => {
      started.push(input);
      return { generationId: input.generationId, status: "streaming" };
    });

    const response = await app.request("http://localhost/chat-1/edit-and-send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: "user-1",
        content: "Hello in place",
        expectedVersion: 1,
        requestId: "req-in-place",
        branchChatOnEditAndSend: false,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      branchChatId: "chat-1",
      editedMessageId: "user-1",
      immediateAssistantId: "asst-1",
      generationCursor: {
        generationId: expect.any(String),
        chatId: "chat-1",
        requestId: "req-in-place",
        mode: "swipe",
        editAndSendContext: {
          editedUserMessageId: "user-1",
          committedRevision: 2,
        },
      },
    });
    expect(started).toEqual([{
      userId: USER_ID,
      chat_id: "chat-1",
      generationId: body.generationCursor.generationId,
      generation_type: "swipe",
      message_id: "asst-1",
    }]);
    expect(getGenerationOutboxByRequest(USER_ID, "chat-1", "req-in-place")).toMatchObject({
      request_id: "req-in-place",
      user_id: USER_ID,
      chat_id: "chat-1",
      branch_chat_id: "chat-1",
      edited_message_id: "user-1",
      target_message_id: "asst-1",
      target_swipe_index: 1,
      expected_version: 1,
      generation_id: body.generationCursor.generationId,
      mode: "swipe",
      status: "running",
      attempt_count: 1,
    });
  });

  test("rejects a non-boolean branch mode", async () => {
    const response = await app.request("http://localhost/chat-1/edit-and-send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: "user-1",
        content: "Hello",
        expectedVersion: 1,
        requestId: "req-bad-mode",
        branchChatOnEditAndSend: "false",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "branchChatOnEditAndSend must be a boolean" });
  });
});
