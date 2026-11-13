import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { editAndSend, getMessage } from "./chats.service";
import {
  dispatchEditAndSendRequest,
  getGenerationOutboxByRequest,
  resetEditAndSendDispatcherForTests,
  setEditAndSendStartGeneration,
  type StartEditAndSendGenerationInput,
} from "./edit-and-send-dispatcher.service";

const USER_ALPHA = "user:alpha";
const USER_BETA = "user:beta";

function initTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE characters (
    id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '', scenario TEXT NOT NULL DEFAULT '', first_mes TEXT NOT NULL DEFAULT '',
    mes_example TEXT NOT NULL DEFAULT '', creator TEXT NOT NULL DEFAULT '', creator_notes TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '', post_history_instructions TEXT NOT NULL DEFAULT '', avatar_path TEXT,
    image_id TEXT, tags TEXT NOT NULL DEFAULT '[]', alternate_greetings TEXT NOT NULL DEFAULT '[]',
    extensions TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1
  )`);
  db.run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY, user_id TEXT, character_id TEXT, name TEXT NOT NULL DEFAULT '', metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, index_in_chat INTEGER NOT NULL, is_user INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', send_date INTEGER NOT NULL, swipe_id INTEGER NOT NULL DEFAULT 0,
    swipes TEXT NOT NULL DEFAULT '[]', swipe_dates TEXT NOT NULL DEFAULT '[]', extra TEXT NOT NULL DEFAULT '{}',
    parent_message_id TEXT, branch_id TEXT, created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
  )`);
  db.run(`CREATE TABLE chat_memory_cache (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, settings_key TEXT NOT NULL,
    source_message_count INTEGER NOT NULL DEFAULT 0, query_preview TEXT NOT NULL DEFAULT '', chunks_json TEXT NOT NULL DEFAULT '[]',
    formatted TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
    settings_source TEXT NOT NULL DEFAULT 'global', chunks_available INTEGER NOT NULL DEFAULT 0,
    chunks_pending INTEGER NOT NULL DEFAULT 0, retrieval_mode TEXT NOT NULL DEFAULT 'empty', created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, UNIQUE(chat_id, settings_key)
  )`);
  db.run(`CREATE TABLE edit_and_send_requests (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL, branch_chat_id TEXT NOT NULL, edited_message_id TEXT NOT NULL,
    target_message_id TEXT, target_swipe_index INTEGER, generation_id TEXT NOT NULL, response TEXT NOT NULL,
    cursor TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (user_id, chat_id, request_id)
  )`);
  db.run(`CREATE TABLE generation_outbox (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id TEXT NOT NULL, chat_id TEXT NOT NULL,
    branch_chat_id TEXT NOT NULL, edited_message_id TEXT NOT NULL, target_message_id TEXT, target_swipe_index INTEGER,
    expected_version INTEGER NOT NULL, generation_id TEXT NOT NULL UNIQUE, mode TEXT NOT NULL CHECK(mode IN ('normal', 'swipe')),
    status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
    lease_owner TEXT, lease_expires_at INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
    last_error_code TEXT, terminal_reason TEXT, dispatched_at INTEGER, completed_at INTEGER, cancelled_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    -- migrations/111_generation_outbox_connection_id.sql. Hand-written schema
    -- (no migrations run here), so the column is mirrored LAST to match the
    -- ALTER TABLE append order.
    connection_id TEXT
  )`);
  db.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run("char-alpha", USER_ALPHA, "Alpha");
  db.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run("char-beta", USER_BETA, "Beta");
}

function seedChat(id: string, userId: string, characterId: string): void {
  getDb().query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, characterId, id, "{}", 1, 1);
}

function seedMessage(id: string, chatId: string, content: string, index: number, isUser: boolean, revision = 1): void {
  getDb().query(`INSERT INTO messages (
    id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra,
    parent_message_id, branch_id, created_at, revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    chatId,
    index,
    isUser ? 1 : 0,
    isUser ? "User" : "Assistant",
    content,
    100 + index,
    0,
    JSON.stringify([content]),
    JSON.stringify([100 + index]),
    "{}",
    null,
    null,
    100 + index,
    revision,
  );
}

beforeEach(() => {
  initTestDb();
  resetEditAndSendDispatcherForTests();
});

afterEach(() => {
  resetEditAndSendDispatcherForTests();
  closeDatabase();
});

const scenarios = [
  { name: "tail user message", historical: false, mode: "normal" as const },
  { name: "historical user message", historical: true, mode: "swipe" as const },
];

describe("Property 2 preservation: branch-disabled Edit-and-Send", () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} stays in place with complete durable payloads`, async () => {
      const chatId = `alpha-${scenario.mode}`;
      const userMessageId = `${chatId}-user`;
      const assistantMessageId = `${chatId}-assistant`;
      const requestId = `${chatId}-request`;
      seedChat(chatId, USER_ALPHA, "char-alpha");
      seedMessage(userMessageId, chatId, "original alpha", 0, true, 2);
      if (scenario.historical) seedMessage(assistantMessageId, chatId, "assistant alpha", 1, false);

      seedChat("beta-chat", USER_BETA, "char-beta");
      seedMessage("beta-user", "beta-chat", "original beta", 0, true, 4);
      const betaBefore = structuredClone(getMessage(USER_BETA, "beta-user"));

      const result = editAndSend(USER_ALPHA, chatId, {
        messageId: userMessageId,
        content: "rewritten alpha",
        expectedVersion: 2,
        requestId,
        branchChatOnEditAndSend: false,
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;

      const expectedAssistantId = scenario.historical ? assistantMessageId : null;
      expect(result.replayed).toBe(false);
      expect(result.payload).toEqual({
        branchChatId: chatId,
        editedMessageId: userMessageId,
        immediateAssistantId: expectedAssistantId,
        generationCursor: {
          generationId: expect.any(String),
          chatId,
          requestId,
          mode: scenario.mode,
          // In-place commit: the source row is seeded at revision 2 and the
          // write bumps it to 3, so the producer records the ACTUAL committed
          // revision (not expectedVersion 2, not 2 + 1 inferred).
          editAndSendContext: {
            editedUserMessageId: userMessageId,
            committedRevision: 3,
          },
        },
      });
      expect(getMessage(USER_ALPHA, userMessageId)).toMatchObject({
        id: userMessageId,
        chat_id: chatId,
        content: "rewritten alpha",
        swipes: ["rewritten alpha"],
        revision: 3,
      });
      expect(getMessage(USER_BETA, "beta-user")).toEqual(betaBefore);
      expect(getDb().query("SELECT COUNT(*) AS count FROM chats").get()).toEqual({ count: 2 });

      const requestRow = getDb().query("SELECT * FROM edit_and_send_requests WHERE user_id = ? AND chat_id = ? AND request_id = ?")
        .get(USER_ALPHA, chatId, requestId) as Record<string, unknown>;
      expect(requestRow).toEqual({
        id: expect.any(String),
        user_id: USER_ALPHA,
        chat_id: chatId,
        request_id: requestId,
        request_fingerprint: expect.any(String),
        branch_chat_id: chatId,
        edited_message_id: userMessageId,
        target_message_id: expectedAssistantId,
        target_swipe_index: scenario.historical ? 1 : null,
        generation_id: result.payload.generationCursor.generationId,
        response: JSON.stringify(result.payload),
        cursor: JSON.stringify(result.payload.generationCursor),
        created_at: expect.any(Number),
        updated_at: expect.any(Number),
      });

      const outbox = getGenerationOutboxByRequest(USER_ALPHA, chatId, requestId);
      expect(outbox).toEqual({
        id: expect.any(String),
        request_id: requestId,
        user_id: USER_ALPHA,
        chat_id: chatId,
        branch_chat_id: chatId,
        edited_message_id: userMessageId,
        target_message_id: expectedAssistantId,
        target_swipe_index: scenario.historical ? 1 : null,
        expected_version: 2,
        generation_id: result.payload.generationCursor.generationId,
        mode: scenario.mode,
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
        // This fixture deliberately builds no `settings` / `connection_profiles`
        // tables, so `resolveEditAndSendConnectionId` returns `undefined` and the
        // committed identity is NULL. Asserted explicitly rather than omitted:
        // NULL is the documented "fall back to the legacy resolve-at-dispatch
        // ladder" value, and it must also prove that a missing connection surface
        // cannot fail the user's edit.
        connection_id: null,
      });
      expect(getGenerationOutboxByRequest(USER_BETA, chatId, requestId)).toBeNull();
      expect(getGenerationOutboxByRequest(USER_ALPHA, "wrong-chat", requestId)).toBeNull();

      const starts: StartEditAndSendGenerationInput[] = [];
      const startOptions: Array<Record<string, unknown> | undefined> = [];
      setEditAndSendStartGeneration(async (input, options) => {
        starts.push(input);
        startOptions.push(options as Record<string, unknown> | undefined);
        return { generationId: input.generationId, status: "streaming" };
      });
      const dispatched = await dispatchEditAndSendRequest(USER_ALPHA, chatId, requestId);
      expect(starts).toEqual([scenario.historical
        ? {
            userId: USER_ALPHA,
            chat_id: chatId,
            generationId: result.payload.generationCursor.generationId,
            generation_type: "swipe",
            message_id: assistantMessageId,
          }
        : {
            userId: USER_ALPHA,
            chat_id: chatId,
            generationId: result.payload.generationCursor.generationId,
            generation_type: "normal",
          }]);
      expect(startOptions).toEqual([{
        origin: "edit_and_send",
        connectionId: undefined,
        editAndSendContext: {
          editedUserMessageId: userMessageId,
          committedRevision: 3,
        },
      }]);
      expect(dispatched).toMatchObject({
        request_id: requestId,
        user_id: USER_ALPHA,
        chat_id: chatId,
        branch_chat_id: chatId,
        edited_message_id: userMessageId,
        target_message_id: expectedAssistantId,
        generation_id: result.payload.generationCursor.generationId,
        mode: scenario.mode,
        status: "running",
        attempt_count: 1,
      });

      const replay = editAndSend(USER_ALPHA, chatId, {
        messageId: userMessageId,
        content: "rewritten alpha",
        expectedVersion: 2,
        requestId,
        branchChatOnEditAndSend: false,
      });
      expect(replay).toEqual({ status: "ok", replayed: true, payload: result.payload });
      expect(getDb().query("SELECT COUNT(*) AS count FROM edit_and_send_requests").get()).toEqual({ count: 1 });
      expect(getDb().query("SELECT COUNT(*) AS count FROM generation_outbox").get()).toEqual({ count: 1 });
      expect(starts).toHaveLength(1);
    });
  }
});
