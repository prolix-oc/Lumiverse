import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { editAndSend } from "./chats.service";
import {
  dispatchEditAndSendRequest,
  resetEditAndSendDispatcherForTests,
  setEditAndSendStartGeneration,
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

  test("never enqueues before commit and does not create generation targets", () => {
    seedChat("chat");
    seedMessage("user-1", "chat", "hello", { index: 0, isUser: true });

    const result = editAndSend(USER, "chat", {
      messageId: "user-1",
      content: "hello edited",
      expectedVersion: 1,
      requestId: "req-1",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.replayed).toBe(false);
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(result.payload.immediateAssistantId).toBeNull();
    expect(result.payload.generationCursor.mode).toBe("normal");
  });

  test("deduplicates post-commit dispatch to a single generation", async () => {
    seedChat("chat");
    seedMessage("greet", "chat", "Hi", { index: 0 });
    seedMessage("user-1", "chat", "ask", { index: 1, isUser: true });
    seedMessage("asst-1", "chat", "reply", { index: 2 });

    const starts: Array<{ generationId: string; message_id?: string; generation_type: string }> = [];
    setEditAndSendStartGeneration(async (input) => {
      starts.push({
        generationId: input.generationId,
        message_id: input.message_id,
        generation_type: input.generation_type,
      });
      return { generationId: input.generationId, status: "streaming" };
    });

    const result = editAndSend(USER, "chat", {
      messageId: "user-1",
      content: "ask again",
      expectedVersion: 1,
      requestId: "req-swipe",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(enqueueSpy).not.toHaveBeenCalled();

    const first = await dispatchEditAndSendRequest(USER, "chat", "req-swipe");
    const second = await dispatchEditAndSendRequest(USER, "chat", "req-swipe");

    expect(first?.status).toBe("running");
    expect(second?.status).toBe("running");
    expect(first?.generation_id).toBe(result.payload.generationCursor.generationId);
    expect(second?.generation_id).toBe(first?.generation_id);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual({
      generationId: result.payload.generationCursor.generationId,
      message_id: result.payload.immediateAssistantId ?? undefined,
      generation_type: "swipe",
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
