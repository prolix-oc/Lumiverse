import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { editAndSend, getChat, getMessage, getMessages } from "./chats.service";
import { getGenerationOutboxByRequest } from "./edit-and-send-dispatcher.service";

const USER = "u1";

interface StoredCursor {
  generationId: string;
  chatId: string;
  requestId: string;
  mode: string;
  editAndSendContext?: { editedUserMessageId: string; committedRevision: number };
}

function readStoredCursor(chatId: string, requestId: string): StoredCursor {
  const row = getDb()
    .query(
      `SELECT cursor FROM edit_and_send_requests
       WHERE user_id = ? AND chat_id = ? AND request_id = ?`,
    )
    .get(USER, chatId, requestId) as { cursor: string } | null;
  if (!row) throw new Error("no stored cursor for request");
  return JSON.parse(row.cursor) as StoredCursor;
}

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
    const immediateAssistantId = tail.payload.immediateAssistantId;
    if (!immediateAssistantId) throw new Error("expected an immediate assistant message id");
    expect(tail.payload.generationCursor.mode).toBe("swipe");
    expect(immediateAssistantId).toBeTruthy();
    const tailBranch = getMessages(USER, tail.payload.branchChatId);
    expect(tailBranch).toHaveLength(3);
    expect(tailBranch[1]?.content).toBe("ask again");
    expect(tailBranch[2]?.id).toBe(immediateAssistantId);
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
    expect(getMessage(USER, "hist-user-1")).toMatchObject({ content: "one", revision: 1 });
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

  test("in-place mode edits the source chat and queues generation there", () => {
    seedChat("in-place");
    seedMessage("in-place-user", "in-place", "old", { index: 0, isUser: true, revision: 2 });
    const result = editAndSend(USER, "in-place", {
      messageId: "in-place-user",
      content: "new",
      expectedVersion: 2,
      requestId: "in-place-req",
      branchChatOnEditAndSend: false,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.payload.branchChatId).toBe("in-place");
    expect(getMessages(USER, "in-place")[0]).toMatchObject({ id: "in-place-user", content: "new", revision: 3 });
    expect(getDb().query("SELECT COUNT(*) AS count FROM chats").get()).toEqual({ count: 1 });
    expect(getGenerationOutboxByRequest(USER, "in-place", "in-place-req")?.branch_chat_id).toBe("in-place");
  });

  test("includes branch mode in request idempotency", () => {
    seedChat("mode-chat");
    seedMessage("mode-user", "mode-chat", "old", { index: 0, isUser: true });
    const base = {
      messageId: "mode-user",
      content: "new",
      expectedVersion: 1,
      requestId: "same-request",
    };
    const first = editAndSend(USER, "mode-chat", { ...base, branchChatOnEditAndSend: false });
    expect(first.status).toBe("ok");
    const clash = editAndSend(USER, "mode-chat", { ...base, branchChatOnEditAndSend: true });
    expect(clash).toEqual({ status: "conflict", error: "requestId already used with a different payload" });
  });

  test("branch-enabled generated histories preserve complete source rows and use only branch-owned targets", () => {
    for (const earlierTurnCount of [0, 1, 2]) {
      for (const hasImmediateAssistant of [false, true]) {
        const suffix = `${earlierTurnCount}-${hasImmediateAssistant ? "historical" : "tail"}`;
        const chatId = `isolated-${suffix}`;
        const selectedUserId = `selected-user-${suffix}`;
        const sourceAssistantId = hasImmediateAssistant ? `source-assistant-${suffix}` : null;
        const requestId = `isolated-request-${suffix}`;
        seedChat(chatId);
        seedMessage(`greeting-${suffix}`, chatId, "Greeting", { index: 0 });

        let nextIndex = 1;
        for (let turn = 0; turn < earlierTurnCount; turn += 1) {
          seedMessage(`earlier-user-${suffix}-${turn}`, chatId, `Earlier user ${turn}`, {
            index: nextIndex,
            isUser: true,
            revision: 2 + turn,
          });
          nextIndex += 1;
          seedMessage(`earlier-assistant-${suffix}-${turn}`, chatId, `Earlier assistant ${turn}`, {
            index: nextIndex,
            revision: 3 + turn,
          });
          nextIndex += 1;
        }

        seedMessage(selectedUserId, chatId, "Original selected content", {
          index: nextIndex,
          isUser: true,
          revision: 7,
        });
        if (sourceAssistantId) {
          seedMessage(sourceAssistantId, chatId, "Historical assistant", { index: nextIndex + 1, revision: 9 });
        }

        const sourceBefore = {
          chat: getDb().query("SELECT * FROM chats WHERE id = ?").get(chatId),
          messages: getDb().query("SELECT * FROM messages WHERE chat_id = ? ORDER BY index_in_chat ASC").all(chatId),
        };
        const result = editAndSend(USER, chatId, {
          messageId: selectedUserId,
          content: "Rewritten selected content",
          expectedVersion: 7,
          requestId,
          branchChatOnEditAndSend: true,
        });

        expect(result.status).toBe("ok");
        if (result.status !== "ok") continue;
        expect(result.payload.branchChatId).not.toBe(chatId);
        expect(result.payload.generationCursor.chatId).toBe(result.payload.branchChatId);
        expect({
          chat: getDb().query("SELECT * FROM chats WHERE id = ?").get(chatId),
          messages: getDb().query("SELECT * FROM messages WHERE chat_id = ? ORDER BY index_in_chat ASC").all(chatId),
        }).toEqual(sourceBefore);

        const requestRow = getDb().query(
          `SELECT chat_id, branch_chat_id, edited_message_id, target_message_id
           FROM edit_and_send_requests WHERE user_id = ? AND chat_id = ? AND request_id = ?`,
        ).get(USER, chatId, requestId) as {
          chat_id: string;
          branch_chat_id: string;
          edited_message_id: string;
          target_message_id: string | null;
        };
        const outbox = getGenerationOutboxByRequest(USER, chatId, requestId);
        expect(requestRow).toEqual({
          chat_id: chatId,
          branch_chat_id: result.payload.branchChatId,
          edited_message_id: result.payload.editedMessageId,
          target_message_id: result.payload.immediateAssistantId,
        });
        expect(outbox).toMatchObject({
          chat_id: chatId,
          branch_chat_id: result.payload.branchChatId,
          edited_message_id: result.payload.editedMessageId,
          target_message_id: result.payload.immediateAssistantId,
        });

        const persistedTargetIds = [
          result.payload.editedMessageId,
          result.payload.immediateAssistantId,
          requestRow.edited_message_id,
          requestRow.target_message_id,
          outbox?.edited_message_id,
          outbox?.target_message_id,
        ].filter((id): id is string => typeof id === "string");
        for (const targetId of persistedTargetIds) {
          expect(getMessage(USER, targetId)?.chat_id).toBe(result.payload.branchChatId);
        }

        expect(result.payload.editedMessageId).not.toBe(selectedUserId);
        expect(getMessage(USER, result.payload.editedMessageId)).toMatchObject({
          chat_id: result.payload.branchChatId,
          content: "Rewritten selected content",
          revision: 2,
        });
        if (sourceAssistantId) {
          expect(result.payload.immediateAssistantId).not.toBe(sourceAssistantId);
          expect(result.payload.immediateAssistantId).toBeTruthy();
          expect(outbox?.target_message_id).toBe(result.payload.immediateAssistantId);
          expect(getMessage(USER, sourceAssistantId)).toMatchObject({
            chat_id: chatId,
            content: "Historical assistant",
            revision: 9,
          });
        } else {
          expect(result.payload.immediateAssistantId).toBeNull();
          expect(outbox?.target_message_id).toBeNull();
        }
      }
    }
  });

  test("missing required branch mappings roll back branch, request, outbox, and source changes", () => {
    const cases = [
      { missing: "edited-user", error: "Failed to copy edited message" },
      { missing: "immediate-assistant", error: "Failed to copy immediate assistant message" },
    ] as const;

    for (const testCase of cases) {
      const chatId = `missing-map-${testCase.missing}`;
      const userMessageId = `${testCase.missing}-user`;
      const assistantMessageId = testCase.missing === "edited-user"
        ? `${testCase.missing}-assistant`
        : testCase.missing;
      const missingMessageId = testCase.missing === "edited-user" ? userMessageId : assistantMessageId;
      const requestId = `${testCase.missing}-request`;
      seedChat(chatId);
      seedMessage(userMessageId, chatId, "Source user", { index: 0, isUser: true, revision: 4 });
      seedMessage(assistantMessageId, chatId, "Source assistant", { index: 1, revision: 5 });

      const sourceBefore = {
        chat: getDb().query("SELECT * FROM chats WHERE id = ?").get(chatId),
        messages: getDb().query("SELECT * FROM messages WHERE chat_id = ? ORDER BY index_in_chat ASC").all(chatId),
        chatCount: getDb().query("SELECT COUNT(*) AS count FROM chats").get(),
      };
      const originalMapGet = Map.prototype.get;
      Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
        if (key === missingMessageId) return undefined;
        return originalMapGet.call(this, key);
      } as typeof Map.prototype.get;

      let result;
      try {
        result = editAndSend(USER, chatId, {
          messageId: userMessageId,
          content: "Attempted rewrite",
          expectedVersion: 4,
          requestId,
          branchChatOnEditAndSend: true,
        });
      } finally {
        Map.prototype.get = originalMapGet;
      }

      expect(result).toEqual({ status: "not_found", error: testCase.error });
      expect({
        chat: getDb().query("SELECT * FROM chats WHERE id = ?").get(chatId),
        messages: getDb().query("SELECT * FROM messages WHERE chat_id = ? ORDER BY index_in_chat ASC").all(chatId),
        chatCount: getDb().query("SELECT COUNT(*) AS count FROM chats").get(),
      }).toEqual(sourceBefore);
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM edit_and_send_requests WHERE user_id = ? AND chat_id = ? AND request_id = ?",
      ).get(USER, chatId, requestId)).toEqual({ count: 0 });
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM generation_outbox WHERE user_id = ? AND chat_id = ? AND request_id = ?",
      ).get(USER, chatId, requestId)).toEqual({ count: 0 });
    }
  });

  test("branch-disabled matrix stays in place and replays without creating a branch", () => {
    for (const hasImmediateAssistant of [false, true]) {
      const suffix = hasImmediateAssistant ? "historical" : "tail";
      const chatId = `in-place-matrix-${suffix}`;
      const userMessageId = `in-place-user-${suffix}`;
      const assistantMessageId = hasImmediateAssistant ? `in-place-assistant-${suffix}` : null;
      const requestId = `in-place-request-${suffix}`;
      seedChat(chatId);
      seedMessage("in-place-earlier-user-" + suffix, chatId, "Earlier user", { index: 0, isUser: true });
      seedMessage("in-place-earlier-assistant-" + suffix, chatId, "Earlier assistant", { index: 1 });
      seedMessage(userMessageId, chatId, "Old source", { index: 2, isUser: true, revision: 6 });
      if (assistantMessageId) seedMessage(assistantMessageId, chatId, "Existing assistant", { index: 3, revision: 8 });
      const chatCountBefore = getDb().query("SELECT COUNT(*) AS count FROM chats").get();

      const input = {
        messageId: userMessageId,
        content: "New source",
        expectedVersion: 6,
        requestId,
        branchChatOnEditAndSend: false,
      } as const;
      const result = editAndSend(USER, chatId, input);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") continue;
      expect(result.replayed).toBe(false);
      expect(result.payload).toMatchObject({
        branchChatId: chatId,
        editedMessageId: userMessageId,
        immediateAssistantId: assistantMessageId,
        generationCursor: { chatId, requestId, mode: hasImmediateAssistant ? "swipe" : "normal" },
      });
      expect(getDb().query("SELECT COUNT(*) AS count FROM chats").get()).toEqual(chatCountBefore);
      expect(getMessage(USER, userMessageId)).toMatchObject({ chat_id: chatId, content: "New source", revision: 7 });
      if (assistantMessageId) {
        expect(getMessage(USER, assistantMessageId)).toMatchObject({
          chat_id: chatId,
          content: "Existing assistant",
          revision: 8,
        });
      }
      expect(getGenerationOutboxByRequest(USER, chatId, requestId)).toMatchObject({
        chat_id: chatId,
        branch_chat_id: chatId,
        edited_message_id: userMessageId,
        target_message_id: assistantMessageId,
      });

      const replay = editAndSend(USER, chatId, input);
      expect(replay).toEqual({ status: "ok", replayed: true, payload: result.payload });
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM generation_outbox WHERE user_id = ? AND chat_id = ? AND request_id = ?",
      ).get(USER, chatId, requestId)).toEqual({ count: 1 });
    }
  });

  test("records the committed post-edit revision in the cursor and keeps the outbox expectedVersion pre-edit", () => {
    // Branch mode: the copy starts at revision 1 and the commit bumps it to 2.
    // The recorded committedRevision must be the value actually written (2),
    // NOT expectedVersion (7) and NOT expectedVersion + 1 (8).
    seedChat("cursor-branch");
    seedMessage("cursor-branch-user", "cursor-branch", "Original", {
      index: 0,
      isUser: true,
      revision: 7,
    });

    const branch = editAndSend(USER, "cursor-branch", {
      messageId: "cursor-branch-user",
      content: "Rewritten",
      expectedVersion: 7,
      requestId: "cursor-branch-req",
      branchChatOnEditAndSend: true,
    });
    expect(branch.status).toBe("ok");
    if (branch.status !== "ok") return;

    const branchCursor = readStoredCursor("cursor-branch", "cursor-branch-req");
    expect(branchCursor.editAndSendContext).toEqual({
      editedUserMessageId: branch.payload.editedMessageId,
      committedRevision: 2,
    });
    expect(branchCursor.chatId).toBe(branch.payload.branchChatId);
    expect(branchCursor.generationId).toBe(branch.payload.generationCursor.generationId);
    // The edited copy in the branch really is at revision 2, so the cursor
    // agrees with the live row.
    expect(getMessage(USER, branch.payload.editedMessageId)).toMatchObject({ revision: 2 });

    const branchOutbox = getGenerationOutboxByRequest(USER, "cursor-branch", "cursor-branch-req");
    expect(branchOutbox?.expected_version).toBe(7);

    // In-place mode: the source row keeps its own revision and the write bumps
    // 6 -> 7, so the SAME branch of the code records a different committed
    // revision than the branch case. expectedVersion stays the pre-edit 6.
    seedChat("cursor-inplace");
    seedMessage("cursor-inplace-user", "cursor-inplace", "Old", {
      index: 0,
      isUser: true,
      revision: 6,
    });

    const inPlace = editAndSend(USER, "cursor-inplace", {
      messageId: "cursor-inplace-user",
      content: "New",
      expectedVersion: 6,
      requestId: "cursor-inplace-req",
      branchChatOnEditAndSend: false,
    });
    expect(inPlace.status).toBe("ok");
    if (inPlace.status !== "ok") return;

    const inPlaceCursor = readStoredCursor("cursor-inplace", "cursor-inplace-req");
    expect(inPlaceCursor.editAndSendContext).toEqual({
      editedUserMessageId: "cursor-inplace-user",
      committedRevision: 7,
    });
    expect(inPlaceCursor.chatId).toBe("cursor-inplace");
    expect(getMessage(USER, "cursor-inplace-user")).toMatchObject({ revision: 7 });
    expect(
      getGenerationOutboxByRequest(USER, "cursor-inplace", "cursor-inplace-req")?.expected_version,
    ).toBe(6);
  });

  test("replay returns the stored cursor snapshot byte-for-byte and creates no second outbox row", () => {
    seedChat("cursor-replay");
    seedMessage("cursor-replay-user", "cursor-replay", "Original", {
      index: 0,
      isUser: true,
      revision: 4,
    });
    const input = {
      messageId: "cursor-replay-user",
      content: "Rewritten",
      expectedVersion: 4,
      requestId: "cursor-replay-req",
    } as const;

    const first = editAndSend(USER, "cursor-replay", input);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    const cursorAfterFirst = readStoredCursor("cursor-replay", "cursor-replay-req");

    const replay = editAndSend(USER, "cursor-replay", input);
    expect(replay).toEqual({ status: "ok", replayed: true, payload: first.payload });
    expect(readStoredCursor("cursor-replay", "cursor-replay-req")).toEqual(cursorAfterFirst);

    expect(
      getDb().query(
        "SELECT COUNT(*) AS count FROM generation_outbox WHERE user_id = ? AND chat_id = ? AND request_id = ?",
      ).get(USER, "cursor-replay", "cursor-replay-req"),
    ).toEqual({ count: 1 });
    expect(
      getDb().query(
        "SELECT COUNT(*) AS count FROM edit_and_send_requests WHERE user_id = ? AND chat_id = ? AND request_id = ?",
      ).get(USER, "cursor-replay", "cursor-replay-req"),
    ).toEqual({ count: 1 });
  });
});
