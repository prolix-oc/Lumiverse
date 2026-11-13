import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { editAndSend } from "./chats.service";
import {
  dispatchEditAndSendRequest,
  getGenerationOutboxByRequest,
  resetEditAndSendDispatcherForTests,
  setEditAndSendStartGeneration,
  type StartEditAndSendGenerationInput,
} from "./edit-and-send-dispatcher.service";
import * as coordinator from "./chat-pipeline-coordinator.service";

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
    updated_at INTEGER NOT NULL,
    -- migrations/111_generation_outbox_connection_id.sql. Hand-written schema
    -- (no migrations run here), so the column is mirrored last to match the
    -- ALTER TABLE append order.
    connection_id TEXT
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

describe("chat pipeline coordinator edit-and-send", () => {
  let enqueueSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    initEditAndSendTestDb();
    seedCharacter();
    resetEditAndSendDispatcherForTests();
    coordinator.resetChatPipelineCoordinatorForTests();
    enqueueSpy = spyOn(coordinator, "enqueueChatPipelineTask");
  });

  afterEach(() => {
    enqueueSpy.mockRestore();
    resetEditAndSendDispatcherForTests();
    coordinator.resetChatPipelineCoordinatorForTests();
    closeDatabase();
  });

  test("preserves tail dispatch without creating an assistant target", async () => {
    seedChat("chat");
    seedMessage("user-1", "chat", "hello", { index: 0, isUser: true });
    const starts: StartEditAndSendGenerationInput[] = [];
    const startOptions: Array<Record<string, unknown> | undefined> = [];
    setEditAndSendStartGeneration(async (input, options) => {
      starts.push(input);
      startOptions.push(options as Record<string, unknown> | undefined);
      return { generationId: input.generationId, status: "streaming" };
    });

    const result = editAndSend(USER, "chat", {
      messageId: "user-1",
      content: "hello edited",
      expectedVersion: 1,
      requestId: "req-1",
      branchChatOnEditAndSend: true,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.replayed).toBe(false);
    expect(result.payload).toEqual({
      branchChatId: expect.any(String),
      editedMessageId: expect.any(String),
      immediateAssistantId: null,
      generationCursor: {
        generationId: expect.any(String),
        chatId: expect.any(String),
        requestId: "req-1",
        mode: "normal",
        // Committed edit identity recorded by the producer: the branch copy is
        // created at revision 1 and the commit bumps it to 2.
        editAndSendContext: {
          editedUserMessageId: result.payload.editedMessageId,
          committedRevision: 2,
        },
      },
    });
    expect(result.payload.branchChatId).not.toBe("chat");
    expect(result.payload.generationCursor.chatId).toBe(result.payload.branchChatId);
    expect(enqueueSpy).not.toHaveBeenCalled();

    const pending = getGenerationOutboxByRequest(USER, "chat", "req-1");
    expect(pending).toMatchObject({
      request_id: "req-1",
      user_id: USER,
      chat_id: "chat",
      branch_chat_id: result.payload.branchChatId,
      edited_message_id: result.payload.editedMessageId,
      target_message_id: null,
      target_swipe_index: null,
      expected_version: 1,
      generation_id: result.payload.generationCursor.generationId,
      mode: "normal",
      status: "pending",
      attempt_count: 0,
      dispatched_at: null,
    });
    expect(getGenerationOutboxByRequest(USER, result.payload.branchChatId, "req-1")).toBeNull();

    const dispatched = await dispatchEditAndSendRequest(USER, "chat", "req-1");
    expect(starts).toEqual([{
      userId: USER,
      chat_id: result.payload.branchChatId,
      generationId: result.payload.generationCursor.generationId,
      generation_type: "normal",
    }]);
    // The dispatcher forwards the committed identity read from the request
    // cursor as the trusted out-of-band second argument.
    expect(startOptions).toEqual([{
      origin: "edit_and_send",
      connectionId: undefined,
      editAndSendContext: {
        editedUserMessageId: result.payload.editedMessageId,
        committedRevision: 2,
      },
    }]);
    expect(dispatched).toMatchObject({
      chat_id: "chat",
      branch_chat_id: result.payload.branchChatId,
      target_message_id: null,
      mode: "normal",
      status: "running",
      attempt_count: 1,
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  test("dispatches a historical edit only to the copied branch assistant and deduplicates generation", async () => {
    seedChat("chat");
    seedMessage("greet", "chat", "Hi", { index: 0 });
    seedMessage("user-1", "chat", "ask", { index: 1, isUser: true });
    seedMessage("asst-1", "chat", "reply", { index: 2 });

    const starts: StartEditAndSendGenerationInput[] = [];
    const startOptions: Array<Record<string, unknown> | undefined> = [];
    setEditAndSendStartGeneration(async (input, options) => {
      starts.push(input);
      startOptions.push(options as Record<string, unknown> | undefined);
      return { generationId: input.generationId, status: "streaming" };
    });

    const result = editAndSend(USER, "chat", {
      messageId: "user-1",
      content: "ask again",
      expectedVersion: 1,
      requestId: "req-swipe",
      branchChatOnEditAndSend: true,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.payload).toEqual({
      branchChatId: expect.any(String),
      editedMessageId: expect.any(String),
      immediateAssistantId: expect.any(String),
      generationCursor: {
        generationId: expect.any(String),
        chatId: expect.any(String),
        requestId: "req-swipe",
        mode: "swipe",
        // Same producer contract: the copied user turn starts at revision 1 and
        // the commit bumps it to 2.
        editAndSendContext: {
          editedUserMessageId: result.payload.editedMessageId,
          committedRevision: 2,
        },
      },
    });
    const copiedAssistantId = result.payload.immediateAssistantId;
    if (!copiedAssistantId) throw new Error("expected copied assistant id");
    expect(result.payload.branchChatId).not.toBe("chat");
    expect(result.payload.editedMessageId).not.toBe("user-1");
    expect(copiedAssistantId).not.toBe("asst-1");
    expect(result.payload.generationCursor.chatId).toBe(result.payload.branchChatId);
    expect(getDb().query(
      "SELECT id, chat_id, is_user, content, revision FROM messages WHERE id = ?",
    ).get(copiedAssistantId)).toEqual({
      id: copiedAssistantId,
      chat_id: result.payload.branchChatId,
      is_user: 0,
      content: "reply",
      revision: 1,
    });
    expect(getDb().query(
      "SELECT id, chat_id, is_user, content, revision FROM messages WHERE id = ?",
    ).get("asst-1")).toEqual({
      id: "asst-1",
      chat_id: "chat",
      is_user: 0,
      content: "reply",
      revision: 1,
    });
    expect(enqueueSpy).not.toHaveBeenCalled();

    const pending = getGenerationOutboxByRequest(USER, "chat", "req-swipe");
    expect(pending).toEqual({
      id: expect.any(String),
      request_id: "req-swipe",
      user_id: USER,
      chat_id: "chat",
      branch_chat_id: result.payload.branchChatId,
      edited_message_id: result.payload.editedMessageId,
      target_message_id: copiedAssistantId,
      target_swipe_index: 1,
      expected_version: 1,
      generation_id: result.payload.generationCursor.generationId,
      mode: "swipe",
      status: "pending",
      lease_owner: null,
      lease_expires_at: null,
      attempt_count: 0,
      next_attempt_at: null,
      last_error_code: null,
      terminal_reason: null,
      dispatched_at: null,
      completed_at: null,
      cancelled_at: null,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
      // This harness creates no `settings` / `connection_profiles` tables, so
      // `resolveEditAndSendConnectionId` resolves nothing and the committed
      // identity is NULL — the documented "fall back to the legacy
      // resolve-at-dispatch ladder" value.
      connection_id: null,
    });
    expect(getGenerationOutboxByRequest(USER, result.payload.branchChatId, "req-swipe")).toBeNull();

    const first = await dispatchEditAndSendRequest(USER, "chat", "req-swipe");
    const second = await dispatchEditAndSendRequest(USER, "chat", "req-swipe");

    expect(first?.status).toBe("running");
    expect(second).toEqual(first);
    expect(first?.generation_id).toBe(result.payload.generationCursor.generationId);
    expect(starts).toEqual([{
      userId: USER,
      chat_id: result.payload.branchChatId,
      generationId: result.payload.generationCursor.generationId,
      generation_type: "swipe",
      message_id: copiedAssistantId,
    }]);
    expect(startOptions).toEqual([{
      origin: "edit_and_send",
      connectionId: undefined,
      editAndSendContext: {
        editedUserMessageId: result.payload.editedMessageId,
        committedRevision: 2,
      },
    }]);
    expect(first).toMatchObject({
      request_id: "req-swipe",
      user_id: USER,
      chat_id: "chat",
      branch_chat_id: result.payload.branchChatId,
      edited_message_id: result.payload.editedMessageId,
      target_message_id: copiedAssistantId,
      target_swipe_index: 1,
      expected_version: 1,
      generation_id: result.payload.generationCursor.generationId,
      mode: "swipe",
      status: "running",
      attempt_count: 1,
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
