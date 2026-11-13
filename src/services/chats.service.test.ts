import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ExtensionInfo, HostToWorker, SpindleManifest } from "lumiverse-spindle-types";
import { WorkerHost } from "../spindle/worker-host";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import { eventBus } from "../ws/bus";
import { EventType, type EventMessage } from "../ws/events";
import {
  addGroupMember,
  addSwipe,
  updateSwipe,
  deleteSwipe,
  setSwipeScopedExtra,
  applyChatAppearance,
  branchChat,
  convertSoloChatToGroup,
  createChat,
  compareAndSetChatMetadata,
  deleteChat,
  deleteChats,
  deleteMessage,
  bulkDeleteMessages,
  getChat,
  getChatTree,
  cycleSwipe,
  getMessage,
  getMessages,
  getPreviousSameRoleContent,
  getTrailingVisibleUserMessageIds,
  listHiddenRecentChats,
  listGroupChatSummaries,
  listRecentChats,
  listRecentChatsGrouped,
  patchMessageExtra,
  removeMessageAttachment,
  removeGroupMember,
  searchMessages,
  setGroupMemberAlternateFields,
  updateMessage,
} from "./chats.service";
import { makePromptActivationSource, promptActivationSource } from "./prompt-activation.service";

function initChatsTestDb(path = ":memory:"): void {
  closeDatabase();
  initDatabase(path);
  const db = getDb();

  db.run(`CREATE TABLE settings (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, key)
  )`);

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

  db.run(`CREATE TABLE message_breakdowns (
    message_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 1
  )`);
}

function seedCharacter(id: string, name: string): void {
  getDb().query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run(id, "u1", name);
}

function seedCharacterWithExtensions(id: string, extensions: Record<string, unknown> = {}): void {
  getDb()
    .query("INSERT INTO characters (id, user_id, name, extensions) VALUES (?, ?, ?, ?)")
    .run(id, "u1", id, JSON.stringify(extensions));
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

function seedBreakdown(
  messageId: string,
  chatId: string,
  data: unknown = { marker: messageId },
  userId = "u1",
): void {
  getDb()
    .query("INSERT INTO message_breakdowns (message_id, chat_id, user_id, data) VALUES (?, ?, ?, ?)")
    .run(messageId, chatId, userId, JSON.stringify(data));
}

function seedStoredImageWithFiles(imageId: string): string[] {
  getDb().run(`CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    filename TEXT NOT NULL,
    owner_extension_identifier TEXT
  )`);

  const filename = `${imageId}.png`;
  getDb()
    .query("INSERT INTO images (id, user_id, filename) VALUES (?, ?, ?)")
    .run(imageId, "u1", filename);

  const imagesDir = join(env.dataDir, "images");
  mkdirSync(imagesDir, { recursive: true });
  const paths = [
    join(imagesDir, filename),
    join(imagesDir, `${imageId}_thumb_sm_v2.webp`),
    join(imagesDir, `${imageId}_thumb_lg_v2.webp`),
  ];
  for (const path of paths) writeFileSync(path, "fixture");
  return paths;
}

beforeEach(() => {
  initChatsTestDb();
  seedCharacter("c1", "Alpha");
  seedCharacter("c2", "Beta");
});

afterEach(() => {
  closeDatabase();
});

test("conditional metadata guards accept the same normalized message returned to extensions", () => {
  for (const contexts of [[{ preset_id: "p" }], [{ preset_id: "p" }, null, { preset_id: "extra" }]]) {
    const id = `chat-${contexts.length}`;
    seedChat(id, "c1", "Chat", "{}", 1);
    seedMessage(id, id, "A", { spindle_metadata: { preset_contexts: contexts } });
    getDb().query("UPDATE messages SET swipes = ? WHERE id = ?").run(JSON.stringify(["A", "B"]), id);
    const message = getMessages("u1", id)[0]!;
    expect(compareAndSetChatMetadata("u1", id, { expected_metadata: {}, metadata: { saved: true }, expected_last_message_id: id,
      expected_message: { id, swipe_id: message.swipe_id, swipes: message.swipes, metadata: message.extra.spindle_metadata as Record<string, unknown> },
    })?.metadata).toEqual({ saved: true });
  }
});

describe("previous same-role content", () => {
  test("finds the nearest earlier message with the same role", () => {
    seedCharacter("char", "Character");
    seedChat("chat", "char", "Chat", "{}", 1);
    seedMessage("greeting", "chat", "hello", {}, { index: 0 });
    seedMessage("user-1", "chat", "first user", {}, { index: 1, isUser: true });
    seedMessage("assistant-1", "chat", "first assistant", {}, { index: 2 });
    seedMessage("user-2", "chat", "second user", {}, { index: 3, isUser: true });
    seedMessage("assistant-2", "chat", "second assistant", {}, { index: 4 });

    expect(getPreviousSameRoleContent("u1", "chat", true, "user-2"))
      .toBe("first user");
    expect(getPreviousSameRoleContent("u1", "chat", false, "assistant-2"))
      .toBe("first assistant");
  });

  test("falls back to the greeting when no same-role message exists", () => {
    seedCharacter("char", "Character");
    seedChat("chat", "char", "Chat", "{}", 1);
    seedMessage("greeting", "chat", "hello", {}, { index: 0 });
    seedMessage("user-1", "chat", "first user", {}, { index: 1, isUser: true });

    expect(getPreviousSameRoleContent("u1", "chat", true, "user-1"))
      .toBe("hello");
  });
});

describe("trailing visible user messages", () => {
  test("skips hidden turns and stops at the latest visible assistant", () => {
    seedChat("chat", "c1", "Chat", "{}", 1);
    seedMessage("assistant", "chat", "reply", {}, { index: 0 });
    seedMessage("user-1", "chat", "one", {}, { index: 1, isUser: true });
    seedMessage("hidden-assistant", "chat", "draft", { hidden: true }, { index: 2 });
    seedMessage("user-2", "chat", "two", {}, { index: 3, isUser: true });
    seedMessage("hidden-user", "chat", "draft", { hidden: true }, { index: 4, isUser: true });

    expect(getTrailingVisibleUserMessageIds("u1", "chat"))
      .toEqual(["user-1", "user-2"]);
    expect(getTrailingVisibleUserMessageIds("other-user", "chat")).toEqual([]);
  });

  test("paginates through long runs of hidden messages", () => {
    seedChat("chat", "c1", "Chat", "{}", 1);
    seedMessage("assistant", "chat", "reply", {}, { index: 0 });
    seedMessage("user", "chat", "queued", {}, { index: 1, isUser: true });
    for (let index = 2; index < 140; index++) {
      seedMessage(`hidden-${index}`, "chat", "draft", { hidden: true }, { index });
    }

    expect(getTrailingVisibleUserMessageIds("u1", "chat")).toEqual(["user"]);
  });
});

describe("chat greeting selection", () => {
  test("persists the selected greeting index on the chat and greeting message", () => {
    getDb()
      .query("UPDATE characters SET first_mes = ?, alternate_greetings = ? WHERE id = ?")
      .run(
        "Default greeting",
        JSON.stringify(["Alternate one", "Alternate two"]),
        "c1",
      );

    const chat = createChat("u1", {
      character_id: "c1",
      greeting_index: 2,
    });
    const greeting = getMessages("u1", chat.id)[0];

    expect(chat.metadata.activeGreetingIndex).toBe(2);
    expect(greeting?.content).toBe("Alternate two");
    expect(greeting?.extra.greeting_index).toBe(2);
  });
});

describe("chat lifecycle events", () => {
  test.each([undefined, "Named fork"])("forks reserve the write transaction before reading with name %s", async (name) => {
    const directory = mkdtempSync(join(tmpdir(), "chat-fork-contention-"));
    const path = join(directory, "database.sqlite");
    initChatsTestDb(path);
    seedCharacter("c1", "Alpha");
    seedChat("source", "c1", "Source", "{}", 100);
    seedMessage("reply", "source", "Reply", {}, { index: 0 });
    const writer = new Database(path);
    writer.exec("PRAGMA busy_timeout = 0");
    const statement = getDb().query("SELECT * FROM chats WHERE id = ? AND user_id = ?");
    const read = statement.get.bind(statement);
    let attempted = false;
    let blocked = false;
    const backgroundWrite = () => writer
      .query("INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)")
      .run("u1", "concurrent", "true");
    const hook = spyOn(statement, "get").mockImplementation((...values) => {
      const result = read(...values);
      if (!attempted) {
        attempted = true;
        try {
          backgroundWrite();
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "SQLITE_BUSY") throw error;
          blocked = true;
        }
      }
      return result;
    });
    try {
      const fork = branchChat("u1", "source", "reply", name);
      expect(attempted).toBe(true);
      expect(fork).not.toBeNull();
      expect(blocked).toBe(true);
      expect(getMessages("u1", fork!.id).map(message => message.content)).toEqual(["Reply"]);
      backgroundWrite();
      expect(writer.query("SELECT value FROM settings WHERE key = 'concurrent'").get()).toEqual({ value: "true" });
      await Bun.sleep(0);
    } finally {
      hook.mockRestore();
      writer.close();
      closeDatabase();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects inaccessible chats and mismatched fork messages without rows or events", async () => {
    seedChat("source", "c1", "Source", "{}", 100);
    seedChat("other", "c1", "Other", "{}", 100);
    seedMessage("reply", "source", "Reply", {}, { index: 0 });
    seedMessage("other-reply", "other", "Other reply", {}, { index: 0 });
    const events: EventMessage[] = [];
    const unsubscribe = eventBus.on(EventType.CHAT_FORKED, (event) => events.push(event));

    try {
      expect(branchChat("u2", "source", "reply")).toBeNull();
      expect(branchChat("u1", "source", "other-reply")).toBeNull();
      expect(branchChat("u1", "missing", "reply")).toBeNull();
      expect(branchChat("u1", "source", "missing")).toBeNull();
      expect(getDb().inTransaction).toBe(false);
      expect(getDb().query("SELECT COUNT(*) as count FROM chats").get()).toEqual({ count: 2 });
      expect(getDb().query("SELECT COUNT(*) as count FROM messages").get()).toEqual({ count: 2 });
      await Bun.sleep(0);
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  test("emits CHAT_CREATED after solo creation and group conversion", async () => {
    const events: EventMessage[] = [];
    const unsubscribe = eventBus.on(EventType.CHAT_CREATED, (event) => events.push(event));

    try {
      const solo = createChat("u1", { character_id: "c1", name: "Solo" });
      const converted = convertSoloChatToGroup("u1", solo.id);
      expect(converted).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events.map((event) => event.payload.id)).toEqual([solo.id, converted!.id]);
      expect(events.every((event) => event.userId === "u1")).toBe(true);
      expect(events[1]?.payload.chat.metadata).toEqual(expect.objectContaining({
        group: true,
        character_ids: ["c1"],
      }));
    } finally {
      unsubscribe();
    }
  });

  test("emits CHAT_FORKED with the source-to-fork message ID map", async () => {
    seedChat("source-chat", "c1", "Source", "{}", 100);
    seedMessage("source-message-1", "source-chat", "Opening", {}, { index: 0 });
    seedMessage("source-message-2", "source-chat", "Reply", {}, { index: 1, isUser: true });
    seedMessage("source-message-3", "source-chat", "Not copied", {}, { index: 2 });

    const events: EventMessage[] = [];
    const unsubscribe = eventBus.on(EventType.CHAT_FORKED, (event) => events.push(event));

    try {
      const fork = branchChat("u1", "source-chat", "source-message-2");
      expect(fork).not.toBeNull();

      const forkedMessages = getMessages("u1", fork!.id);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events).toHaveLength(1);
      expect(events[0]?.userId).toBe("u1");
      expect(events[0]?.payload).toEqual(expect.objectContaining({
        sourceChatId: "source-chat",
        forkedChatId: fork!.id,
        forkedAtMessageId: "source-message-2",
        forkedAtMessageIndex: 1,
        messageIdMap: {
          "source-message-1": forkedMessages[0]?.id,
          "source-message-2": forkedMessages[1]?.id,
        },
      }));
      expect(events[0]?.payload.messageIdMap).not.toHaveProperty("source-message-3");
      expect(forkedMessages.map((message) => message.id)).not.toContain("source-message-1");
      expect(forkedMessages.map((message) => message.id)).not.toContain("source-message-2");
    } finally {
      unsubscribe();
    }
  });
});

describe("chat message search", () => {
  test("searches the active swipe and omits internal injected messages", () => {
    seedChat("chat-find", "c1", "Find", "{}", 100);
    seedMessage("before", "chat-find", "No match here", {}, { index: 0 });
    seedMessage("active-swipe", "chat-find", "Stale content", {}, { index: 1 });
    getDb().query("UPDATE messages SET swipes = ?, swipe_id = ? WHERE id = ?").run(
      JSON.stringify(["needle in an inactive swipe", "Needle in the active swipe"]),
      1,
      "active-swipe",
    );
    seedMessage("injected", "chat-find", "Needle in internal content", { _loom_inject: { block_id: "hidden" } }, { index: 2 });
    seedMessage("after", "chat-find", "A second needle result", {}, { index: 3 });

    const result = searchMessages("u1", "chat-find", "needle");

    expect(result.total).toBe(2);
    expect(result.message_total).toBe(4);
    expect(result.truncated).toBe(false);
    expect(result.data).toEqual([
      { id: "active-swipe", index_in_chat: 1, offset: 1 },
      { id: "after", index_in_chat: 3, offset: 3 },
    ]);
    expect(searchMessages("u1", "chat-find", "inactive").total).toBe(0);
  });
});

describe("recent chats", () => {
  test('later pages reuse summaries, and local writes and reset replace the model', () => {
    seedChat('a', 'c1', 'A', '{}', 200);
    seedChat('b', 'c2', 'B', '{}', 100);
    listRecentChatsGrouped('u1', { limit: 1, offset: 0 });
    const query = spyOn(getDb(), 'query');
    try {
      const next = listRecentChatsGrouped('u1', { limit: 1, offset: 1 });
      expect(next.data[0]?.latest_chat_id).toBe('b');
      expect(query.mock.calls.some(([sql]) => /FROM chats c/.test(sql))).toBe(false);
    } finally { query.mockRestore(); }
    getDb().run("UPDATE chats SET name = 'Changed', updated_at = 300 WHERE id = 'b'");
    expect(listRecentChatsGrouped('u1', { limit: 1, offset: 0 }).data[0]?.latest_chat_name).toBe('Changed');
    initChatsTestDb();
    expect(listRecentChatsGrouped('u1', { limit: 1, offset: 0 }).total).toBe(0);
  });

  test('a second SQLite connection invalidates the warm summary and sorting caches', () => {
    const directory = mkdtempSync(join(tmpdir(), 'recent-summary-'));
    const path = join(directory, 'test.sqlite');
    let writer: Database | undefined;
    try {
      initChatsTestDb(path);
      seedCharacter('c1', 'Before');
      seedChat('external', 'c1', 'Before', '{}', 1);
      expect(listRecentChatsGrouped('u1', { limit: 10, offset: 0 }).data[0]?.latest_chat_name).toBe('Before');
      writer = new Database(path);
      writer.run("UPDATE chats SET name = 'After worker write', metadata = ? WHERE id = 'external'", [JSON.stringify({ multiplayer: true })]);
      const updated = listRecentChatsGrouped('u1', { limit: 10, offset: 0 });
      expect(updated.data[0]?.latest_chat_name).toBe('After worker write');
      expect(updated.data[0]?.multiplayer).toBe(true);
    } finally { writer?.close(); closeDatabase(); rmSync(directory, { recursive: true, force: true }); }
  });

  test.each([
    ["flat", listRecentChats],
    ["grouped", listRecentChatsGrouped],
  ] as const)("%s recent chats apply saved home visibility before totals and pagination", (_kind, list) => {
    seedCharacter("c3", "Gamma");
    seedChat("hidden-character", "c1", "Hidden", "{}", 400);
    seedChat("hidden-chat", "c2", "Hidden chat", JSON.stringify({ hidden_from_recent: true }), 350);
    seedChat("group", "c1", "Group", JSON.stringify({ group: true, character_ids: ["c1", "c2"] }), 300);
    seedChat("visible", "c2", "Visible", "{}", 200);
    seedChat("older", "c3", "Older", "{}", 100);
    getDb().query("INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)")
      .run("u1", "landingHiddenCharacterIds", JSON.stringify(["c1"]));
    // Another account's exclusions cannot affect this user's page.
    getDb().query("INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)")
      .run("u2", "landingHiddenCharacterIds", JSON.stringify(["c2", "c3"]));

    const first = list("u1", { limit: 1, offset: 0 });
    expect(first.total).toBe(3);
    expect(first.data[0]?.character_id).toBe("c1"); // Group remains visible.
    const second = list("u1", { limit: 1, offset: 1 });
    expect(second.total).toBe(3);
    expect(second.data[0]?.character_id).toBe("c2");
    expect(list("u1", { limit: 1, offset: 2 }).data[0]?.character_id).toBe("c3");
  });

  test("grouped client exclusions add to saved visibility and cannot unhide a saved character", () => {
    seedCharacter("c3", "Gamma");
    seedChat("hidden", "c1", "Hidden", "{}", 300);
    seedChat("additional", "c2", "Additional", "{}", 200);
    seedChat("visible", "c3", "Visible", "{}", 100);
    getDb().query("INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)")
      .run("u1", "landingHiddenCharacterIds", JSON.stringify(["c1"]));
    expect(listRecentChatsGrouped("u1", { limit: 10, offset: 0 }, { hiddenCharacterIds: [] })
      .data.map(row => row.character_id)).toEqual(["c2", "c3"]);
    expect(listRecentChatsGrouped("u1", { limit: 10, offset: 0 }, { hiddenCharacterIds: ["c2"] })
      .data.map(row => row.character_id)).toEqual(["c3"]);
    getDb().query("UPDATE settings SET value = '[]' WHERE user_id = 'u1'").run();
    expect(listRecentChatsGrouped("u1", { limit: 10, offset: 0 }).data.map(row => row.character_id))
      .toEqual(["c1", "c2", "c3"]);
  });

  test("loads recent chats with malformed metadata", () => {
    seedChat("bad", "c1", "Bad metadata", "not json", 200);
    seedChat("good", "c2", "Good metadata", "{}", 100);

    const result = listRecentChats("u1", { limit: 10, offset: 0 });

    expect(result.total).toBe(2);
    expect(result.data.map((chat) => chat.id)).toEqual(["bad", "good"]);
    expect(result.data[0].metadata).toEqual({});
  });

  test("flat recent list searches, sorts, and stays one row per chat", () => {
    seedChat("z-newest", "c1", "Zeta newest", "{}", 300);
    seedChat("a-middle", "c1", "Alpha middle", "{}", 200);
    seedChat("debugger", "c2", "Branch #1", "{}", 100);

    const byRecent = listRecentChats("u1", { limit: 10, offset: 0 });
    expect(byRecent.data.map((chat) => chat.id)).toEqual(["z-newest", "a-middle", "debugger"]);

    const byName = listRecentChats("u1", { limit: 10, offset: 0 }, { sort: "name", direction: "asc" });
    expect(byName.data.map((chat) => chat.id)).toEqual(["a-middle", "debugger", "z-newest"]);

    const byCreatedDesc = listRecentChats("u1", { limit: 10, offset: 0 }, { sort: "created", direction: "desc" });
    expect(byCreatedDesc.data.map((chat) => chat.id)).toEqual(["z-newest", "a-middle", "debugger"]);

    const search = listRecentChats("u1", { limit: 10, offset: 0 }, { search: "branch" });
    expect(search.data.map((chat) => chat.id)).toEqual(["debugger"]);
    // Search matches character names too, not just chat names.
    const byCharacter = listRecentChats("u1", { limit: 10, offset: 0 }, { search: "beta" });
    expect(byCharacter.total).toBe(1);
  });

  test("flat recent list hides hidden_from_recent chats", () => {
    seedChat("shown", "c1", "Shown", "{}", 100);
    seedChat("hidden", "c1", "Hidden", JSON.stringify({ hidden_from_recent: true }), 200);

    const result = listRecentChats("u1", { limit: 10, offset: 0 });

    expect(result.data.map((chat) => chat.id)).toEqual(["shown"]);
  });

  test("flat recent list enriches rows with message count and preview", () => {
    seedChat("enriched", "c1", "Enriched", "{}", 100);
    seedMessage("m1", "enriched", "first message", {}, { index: 0 });
    seedMessage("m2", "enriched", "last message body", {}, { index: 1 });
    seedChat("empty", "c2", "Empty", "{}", 50);

    const result = listRecentChats("u1", { limit: 10, offset: 0 });

    const enriched = result.data.find((chat) => chat.id === "enriched");
    expect(enriched?.message_count).toBe(2);
    expect(enriched?.last_message_preview).toBe("last message body");
    const empty = result.data.find((chat) => chat.id === "empty");
    expect(empty?.message_count).toBe(0);
    expect(empty?.last_message_preview).toBe("");
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

  test("groups recent group chat forks by member set", () => {
    seedChat("group-root", "c1", "Group", JSON.stringify({ group: true, character_ids: ["c1", "c2"] }), 100);
    seedChat("group-branch", "c1", "Group — Branch at #2", JSON.stringify({
      group: true,
      character_ids: ["c2", "c1"],
      branched_from: "group-root",
      branch_at_message: "msg-2",
    }), 200);
    seedChat("other-group", "c1", "Other Group", JSON.stringify({ group: true, character_ids: ["c1"] }), 150);

    const result = listRecentChatsGrouped("u1", { limit: 10, offset: 0 });

    expect(result.total).toBe(2);
    expect(result.data.map((chat) => chat.latest_chat_id)).toEqual(["group-branch", "other-group"]);
    expect(result.data[0].chat_count).toBe(2);
    expect(result.data[0].is_group).toBe(true);
    expect(result.data[0].group_character_ids).toEqual(["c2", "c1"]);
  });

  test("clusters group chat forks even when membership has diverged from the root", () => {
    // Parent gained a member after the branch was taken (or the branch dropped
    // one) — the branch should still cluster with the root rather than spawn a
    // second landing-page entry.
    seedChat("group-root", "c1", "Group", JSON.stringify({ group: true, character_ids: ["c1", "c2", "c3"] }), 100);
    seedChat("group-branch", "c1", "Group — Branch at #2", JSON.stringify({
      group: true,
      character_ids: ["c1", "c2"],
      branched_from: "group-root",
      branch_at_message: "msg-2",
    }), 200);

    const result = listRecentChatsGrouped("u1", { limit: 10, offset: 0 });

    expect(result.total).toBe(1);
    expect(result.data[0].latest_chat_id).toBe("group-branch");
    expect(result.data[0].chat_count).toBe(2);
    expect(result.data[0].is_group).toBe(true);
    // group_character_ids reflects the surviving (latest) row's own members.
    expect(result.data[0].group_character_ids).toEqual(["c1", "c2"]);
  });

  test("dedupes group chats whose character_ids contain duplicate entries", () => {
    seedChat("group-clean", "c1", "Group", JSON.stringify({ group: true, character_ids: ["c1", "c2"] }), 100);
    seedChat("group-dup", "c1", "Group dup", JSON.stringify({ group: true, character_ids: ["c1", "c1", "c2"] }), 200);

    const result = listRecentChatsGrouped("u1", { limit: 10, offset: 0 });

    expect(result.total).toBe(1);
    expect(result.data[0].latest_chat_id).toBe("group-dup");
    expect(result.data[0].chat_count).toBe(2);
  });

  test("hides chats marked hidden_from_recent and surfaces the next recent chat", () => {
    seedChat("c1-old", "c1", "Alpha old", "{}", 100);
    seedChat("c1-new", "c1", "Alpha new", JSON.stringify({ hidden_from_recent: true }), 200);
    seedChat("c2-only", "c2", "Beta only", "{}", 150);

    const result = listRecentChatsGrouped("u1", { limit: 10, offset: 0 });

    expect(result.total).toBe(2);
    expect(result.data.map((chat) => chat.latest_chat_id)).toEqual(["c2-only", "c1-old"]);
    expect(result.data[1].chat_count).toBe(1);
  });

  test("lists explicitly hidden chats for the landing-page restore manager", () => {
    seedChat("visible", "c1", "Visible chat", "{}", 100);
    seedChat("hidden-solo", "c1", "Hidden chat", JSON.stringify({ hidden_from_recent: true }), 200);
    seedChat("hidden-group", "c2", "Hidden group", JSON.stringify({
      hidden_from_recent: true,
      group: true,
      character_ids: ["c1", "c2"],
    }), 300);

    expect(listHiddenRecentChats("u1")).toEqual([
      expect.objectContaining({ id: "hidden-group", name: "Hidden group", character_name: "Beta", is_group: true }),
      expect.objectContaining({ id: "hidden-solo", name: "Hidden chat", character_name: "Alpha", is_group: false }),
    ]);
  });

  test("pins favorite solo characters before pagination without moving groups", () => {
    seedChat("favorite-old", "c1", "Favorite", "{}", 100);
    seedChat("recent", "c2", "Recent", "{}", 300);
    seedChat("group", "c2", "Group", JSON.stringify({ group: true, character_ids: ["c1", "c2"] }), 200);

    const result = listRecentChatsGrouped(
      "u1",
      { limit: 2, offset: 0 },
      { favoriteCharacterIds: ["c1"] },
    );

    expect(result.total).toBe(3);
    expect(result.data.map((chat) => chat.latest_chat_id)).toEqual(["favorite-old", "recent"]);
  });

  test("hides solo character cards before grouping and pagination but keeps groups", () => {
    seedChat("c1-old", "c1", "Alpha old", "{}", 100);
    seedChat("c1-new", "c1", "Alpha new", "{}", 300);
    seedChat("c2-only", "c2", "Beta only", "{}", 200);
    seedChat("group", "c1", "Group", JSON.stringify({ group: true, character_ids: ["c1", "c2"] }), 250);

    const result = listRecentChatsGrouped(
      "u1",
      { limit: 10, offset: 0 },
      { hiddenCharacterIds: ["c1"] },
    );

    expect(result.total).toBe(2);
    expect(result.data.map((chat) => chat.latest_chat_id)).toEqual(["group", "c2-only"]);
    expect(result.data[0].is_group).toBe(true);
  });

  test("keeps activation source on the generated swipe through navigation, deletion, and edits", () => {
    seedChat("chat-1", "c1", "Swipe chat", "{}", 100);
    seedMessage("msg-1", "chat-1", "first swipe", {});
    addSwipe("u1", "msg-1", "second swipe");
    cycleSwipe("u1", "msg-1", "left");
    setSwipeScopedExtra("u1", "msg-1", 1, {
      promptActivation: makePromptActivationSource("second swipe", "preset", true, "second swipe\n<state>combat</state>"),
    });
    expect(getMessage("u1", "msg-1")!.extra.promptActivation).toBeUndefined();
    const second = cycleSwipe("u1", "msg-1", "right")!;
    expect(promptActivationSource(second, "preset")).toBe("second swipe\n<state>combat</state>");
    deleteSwipe("u1", "msg-1", 0);
    expect(getMessage("u1", "msg-1")!.swipe_id).toBe(0);
    expect(promptActivationSource(getMessage("u1", "msg-1")!, "preset")).toContain("<state>combat</state>");
    updateMessage("u1", "msg-1", { content: "Edited", skipChunkRebuild: true });
    expect(promptActivationSource(getMessage("u1", "msg-1")!, "preset")).toBe("Edited");
  });

  test("a branch only inherits activation sources up to its fork point", () => {
    seedChat("chat-1", "c1", "Branch chat", "{}", 100);
    seedMessage("msg-1", "chat-1", "before activation", {}, { index: 0 });
    seedMessage("msg-2", "chat-1", "after activation", {
      promptActivation: makePromptActivationSource("after activation", "preset", true, "after activation\n<state>combat</state>"),
    }, { index: 1 });
    const branch = branchChat("u1", "chat-1", "msg-1")!;
    const messages = getMessages("u1", branch.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].extra.promptActivation).toBeUndefined();
  });

  test("background swipe staging and completion preserve the selected content and metadata", () => {
    seedChat("chat-1", "c1", "Swipe chat", "{}", 100);
    seedMessage("msg-1", "chat-1", "still reading", { reasoning: "original reasoning", tokenCount: 12 });
    const staged = addSwipe("u1", "msg-1", "", { select: false })!;
    expect(staged).toMatchObject({ swipe_id: 0, content: "still reading", swipes: ["still reading", ""], extra: { reasoning: "original reasoning", tokenCount: 12 } });
    const completed = updateSwipe("u1", "msg-1", 1, "new response")!;
    expect(completed).toMatchObject({ swipe_id: 0, content: "still reading", swipes: ["still reading", "new response"] });
    setSwipeScopedExtra("u1", "msg-1", 1, { reasoning: "new reasoning", tokenCount: 24 });
    expect(getMessage("u1", "msg-1")!.extra.reasoning).toBe("original reasoning");
    expect(cycleSwipe("u1", "msg-1", "right")).toMatchObject({ swipe_id: 1, content: "new response", extra: { reasoning: "new reasoning", tokenCount: 24 } });
  });

  test("cancelling an unselected blank swipe keeps the reader's selection", () => {
    seedChat("chat-1", "c1", "Swipe chat", "{}", 100);
    seedMessage("msg-1", "chat-1", "original", {});
    addSwipe("u1", "msg-1", "second", { select: false });
    addSwipe("u1", "msg-1", "", { select: false });
    cycleSwipe("u1", "msg-1", "right");
    expect(deleteSwipe("u1", "msg-1", 2, { restoreSwipeId: 0 })).toMatchObject({ swipe_id: 1, content: "second" });
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

  test("Spindle reasoning snapshots survive storage, navigation, and forks without changing generation metadata", async () => {
    seedChat("chat-1", "c1", "Swipe chat", "{}", 100);
    seedMessage("msg-1", "chat-1", "first swipe", {
      reasoning: "old first reasoning", reasoningDuration: 10, tokenCount: 11,
      usage: { total_tokens: 11 }, generationMetrics: { model: "first" },
      generationOutcome: { status: "completed" }, reasoningCarrier: { type: "reasoning_content", content: "native" },
      spindle_metadata: { custom: "retained" },
    });
    addSwipe("u1", "msg-1", "second swipe");
    setSwipeScopedExtra("u1", "msg-1", 1, {
      reasoning: "old second reasoning", reasoningDuration: 20, tokenCount: 22,
      usage: { total_tokens: 22 }, generationMetrics: { model: "second" },
    });
    const before = getMessage("u1", "msg-1")!;
    const host = new WorkerHost("reasoning-test", {
      identifier: "reasoning-test", name: "Reasoning test",
    } as SpindleManifest, {
      id: "reasoning-test", identifier: "reasoning-test", name: "Reasoning test", version: "0.0.0", author: "",
      description: "", github: "", homepage: "", permissions: [], granted_permissions: [], enabled: true,
      installed_at: 0, updated_at: 0, has_frontend: false, has_backend: false, status: "stopped",
      metadata: { install_scope: "user", installed_by_user_id: "u1" },
    } satisfies ExtensionInfo);
    const internal = host as any;
    internal.hasPermission = (permission: string) => permission === "chat_mutation";
    const send = (patch: unknown) => new Promise<Extract<HostToWorker, { type: "response" }>>(resolve => {
      internal.runtime = { mode: "worker", pid: null, postMessage: resolve, terminate() {} };
      internal.handleMessage({ type: "chat_update_message", requestId: "request", chatId: "chat-1", messageId: "msg-1", patch });
    });

    expect(await send({ swipe_reasoning: [{ text: "first reasoning", duration: 0 }, { text: "second reasoning", duration: 25 }] }))
      .toEqual({ type: "response", requestId: "request", result: true });
    const saved = getMessage("u1", "msg-1")!;
    expect(saved).toMatchObject({ swipe_id: 1, content: "second swipe", extra: {
      reasoning: "second reasoning", reasoningDuration: 25,
      reasoningBySwipe: ["first reasoning", "second reasoning"], reasoningDurationBySwipe: [0, 25],
    } });
    for (const key of ["tokenCountBySwipe", "usageBySwipe", "generationMetricsBySwipe", "generationOutcomeBySwipe", "reasoningCarrierBySwipe", "spindle_metadata"]) {
      expect(saved.extra[key]).toEqual(before.extra[key]);
    }
    const fork = branchChat("u1", "chat-1", "msg-1")!;
    const forkedMessage = getMessages("u1", fork.id)[0]!;
    expect(cycleSwipe("u1", forkedMessage.id, "left")!.extra).toMatchObject({ reasoning: "first reasoning", reasoningDuration: 0, tokenCount: 11 });
    expect(cycleSwipe("u1", "msg-1", "left")!.extra).toMatchObject({ reasoning: "first reasoning", reasoningDuration: 0, tokenCount: 11 });

    expect((await send({ swipe_reasoning: [null, { text: "replacement" }] })).result).toBe(true);
    const cleared = getMessage("u1", "msg-1")!;
    expect(cleared.extra.reasoning).toBeUndefined();
    expect(cleared.extra.reasoningDuration).toBeUndefined();
    expect(cycleSwipe("u1", "msg-1", "right")!.extra).toMatchObject({ reasoning: "replacement", tokenCount: 22 });
    expect(getMessage("u1", "msg-1")!.extra.reasoningDuration).toBeUndefined();
    expect((await send({ reasoning: { duration: 0 } })).result).toBe(true);
    expect(getMessage("u1", "msg-1")!.extra.reasoningDuration).toBe(0);
    expect((await send({ swipe_reasoning: [null], content: "must not save" })).error).toContain("swipe_reasoning");
    expect(getMessage("u1", "msg-1")!.content).toBe("second swipe");
    expect(cycleSwipe("u1", forkedMessage.id, "right")!.extra).toMatchObject({ reasoning: "second reasoning", reasoningDuration: 25 });
  });

  test("Spindle metadata patches preserve stored fields and per-swipe data when navigating", async () => {
    seedChat("chat-1", "c1", "Swipe chat", "{}", 100);
    seedMessage("msg-1", "chat-1", "first swipe", {
      reasoning: "first reasoning", reasoningDuration: 10, tokenCount: 11,
      usage: { total_tokens: 11 }, generationMetrics: { model: "first" },
      generationOutcome: { status: "completed" },
      reasoningCarrier: { type: "reasoning_content", content: "first native" },
      promptActivation: makePromptActivationSource("first swipe", "preset", true, "first activation"),
      spindle_metadata: { custom: "retained", nested: { old: true } },
      attachments: [{ id: "attachment" }],
    });
    addSwipe("u1", "msg-1", "second swipe");
    setSwipeScopedExtra("u1", "msg-1", 1, {
      reasoning: "second reasoning", reasoningDuration: 20, tokenCount: 22,
      usage: { total_tokens: 22 }, generationMetrics: { model: "second" },
      generationOutcome: { status: "stopped" },
      reasoningCarrier: { type: "reasoning_content", content: "second native" },
      promptActivation: makePromptActivationSource("second swipe", "preset", true, "second activation"),
    });
    const before = getMessage("u1", "msg-1")!;
    const host = new WorkerHost("metadata-test", {
      identifier: "metadata-test", name: "Metadata test",
    } as SpindleManifest, {
      id: "metadata-test", identifier: "metadata-test", name: "Metadata test", version: "0.0.0", author: "",
      description: "", github: "", homepage: "", permissions: [], granted_permissions: [], enabled: true,
      installed_at: 0, updated_at: 0, has_frontend: false, has_backend: false, status: "stopped",
      metadata: { install_scope: "user", installed_by_user_id: "u1" },
    } satisfies ExtensionInfo);
    const internal = host as any;
    internal.hasPermission = (permission: string) => permission === "chat_mutation";
    const send = (patch: unknown) => new Promise<Extract<HostToWorker, { type: "response" }>>(resolve => {
      internal.runtime = { mode: "worker", pid: null, postMessage: resolve, terminate() {} };
      internal.handleMessage({ type: "chat_update_message", requestId: "request", chatId: "chat-1", messageId: "msg-1", patch });
    });

    expect((await send({ metadata_patch: { other: "latest" } })).result).toBe(true);
    expect((await send({ metadata_patch: { run: null, nested: { replacement: true } }, swipe_id: 0, skipChunkRebuild: true })).result).toBe(true);
    const saved = getMessage("u1", "msg-1")!;
    expect(saved).toMatchObject({ swipe_id: 0, content: "first swipe", extra: {
      spindle_metadata: { custom: "retained", other: "latest", run: null, nested: { replacement: true } },
      reasoning: "first reasoning", reasoningDuration: 10, tokenCount: 11,
      attachments: [{ id: "attachment" }],
    } });
    expect(saved.extra.spindle_metadata).toEqual({ custom: "retained", other: "latest", run: null, nested: { replacement: true } });
    for (const key of ["reasoningBySwipe", "reasoningDurationBySwipe", "tokenCountBySwipe", "usageBySwipe",
      "generationMetricsBySwipe", "generationOutcomeBySwipe", "reasoningCarrierBySwipe", "promptActivationBySwipe"]) {
      expect(saved.extra[key]).toEqual(before.extra[key]);
    }
    const fork = branchChat("u1", "chat-1", "msg-1")!;
    expect(getMessages("u1", fork.id)[0]!.extra.spindle_metadata).toEqual(saved.extra.spindle_metadata);
    expect(cycleSwipe("u1", "msg-1", "right")!.extra).toMatchObject({ reasoning: "second reasoning", tokenCount: 22 });

    expect((await send({ metadata_patch: { progress: 1 }, swipe_id: 0, reasoning: { text: "explicit", duration: 0 }, skipChunkRebuild: true })).result).toBe(true);
    expect(getMessage("u1", "msg-1")!.extra).toMatchObject({ reasoning: "explicit", reasoningDuration: 0, tokenCount: 11 });
    expect((await send({ metadata: { replacement: true } })).result).toBe(true);
    expect(getMessage("u1", "msg-1")!.extra.spindle_metadata).toEqual({ replacement: true });
  });

  test("clears active swipe reasoning with explicit null without clearing other swipes", () => {
    seedChat("chat-1", "c1", "Swipe chat", "{}", 100);
    seedMessage("msg-1", "chat-1", "first swipe", {
      reasoning: "first swipe reasoning",
      reasoningDuration: 123,
    });

    const added = addSwipe("u1", "msg-1", "second swipe")!;
    patchMessageExtra("u1", "msg-1", {
      ...added.extra,
      reasoning: "second swipe reasoning",
      reasoningDuration: 456,
    });

    const activeBeforeClear = getMessage("u1", "msg-1")!;
    const cleared = updateMessage("u1", "msg-1", {
      extra: {
        ...activeBeforeClear.extra,
        reasoning: null,
        reasoningDuration: null,
      },
    })!;

    expect(cleared.swipe_id).toBe(1);
    expect(cleared.extra.reasoning).toBeUndefined();
    expect(cleared.extra.reasoningDuration).toBeUndefined();

    const firstSwipe = cycleSwipe("u1", "msg-1", "left")!;
    expect(firstSwipe.swipe_id).toBe(0);
    expect(firstSwipe.extra.reasoning).toBe("first swipe reasoning");
    expect(firstSwipe.extra.reasoningDuration).toBe(123);

    const restoredSecondSwipe = cycleSwipe("u1", "msg-1", "right")!;
    expect(restoredSecondSwipe.swipe_id).toBe(1);
    expect(restoredSecondSwipe.extra.reasoning).toBeUndefined();
    expect(restoredSecondSwipe.extra.reasoningDuration).toBeUndefined();
  });

  test("keeps native reasoning carriers scoped to the swipe that produced them", () => {
    seedChat("chat-1", "c1", "Swipe chat", "{}", 100);
    seedMessage("msg-1", "chat-1", "first swipe", {
      reasoningCarrier: { type: "reasoning_content", content: "first native" },
    });

    const added = addSwipe("u1", "msg-1", "second swipe")!;
    patchMessageExtra("u1", "msg-1", {
      ...added.extra,
      reasoningCarrier: {
        type: "reasoning_details",
        details: [{ type: "reasoning.text", text: "second native" }],
      },
    });

    expect(getMessage("u1", "msg-1")!.extra.reasoningCarrier).toEqual({
      type: "reasoning_details",
      details: [{ type: "reasoning.text", text: "second native" }],
    });

    expect(cycleSwipe("u1", "msg-1", "left")!.extra.reasoningCarrier).toEqual({
      type: "reasoning_content",
      content: "first native",
    });
  });

  test("keeps generation metadata scoped to the active swipe", () => {
    seedChat("chat-1", "c1", "Swipe chat", "{}", 100);
    seedMessage("msg-1", "chat-1", "first swipe", {
      tokenCount: 11,
      generationMetrics: { model: "first-model", tps: 1.1, presetId: "preset-1", presetName: "First preset" },
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
      generationMetrics: { model: "second-model", tps: 3.3, presetId: "preset-2", presetName: "Second preset" },
      usage: { completion_tokens: 33, total_tokens: 44 },
    });

    const secondSwipe = getMessage("u1", "msg-1")!;
    expect(secondSwipe.extra.tokenCount).toBe(33);
    expect(secondSwipe.extra.generationMetrics).toEqual({
      model: "second-model",
      tps: 3.3,
      presetId: "preset-2",
      presetName: "Second preset",
    });
    expect(secondSwipe.extra.usage).toEqual({ completion_tokens: 33, total_tokens: 44 });

    const firstSwipe = cycleSwipe("u1", "msg-1", "left")!;
    expect(firstSwipe.swipe_id).toBe(0);
    expect(firstSwipe.extra.tokenCount).toBe(11);
    expect(firstSwipe.extra.generationMetrics).toEqual({
      model: "first-model",
      tps: 1.1,
      presetId: "preset-1",
      presetName: "First preset",
    });
    expect(firstSwipe.extra.usage).toEqual({ completion_tokens: 11, total_tokens: 22 });

    const restoredSecondSwipe = cycleSwipe("u1", "msg-1", "right")!;
    expect(restoredSecondSwipe.swipe_id).toBe(1);
    expect(restoredSecondSwipe.extra.tokenCount).toBe(33);
    expect(restoredSecondSwipe.extra.generationMetrics).toEqual({
      model: "second-model",
      tps: 3.3,
      presetId: "preset-2",
      presetName: "Second preset",
    });
    expect(restoredSecondSwipe.extra.usage).toEqual({ completion_tokens: 33, total_tokens: 44 });
  });

  test("keeps generation outcomes on their originating swipe through navigation and deletion", () => {
    seedChat("chat-1", "c1", "Swipe chat", "{}", 100);
    const completed = { finish_reason: "end_turn", stop_details: null };
    seedMessage("msg-1", "chat-1", "first swipe", { generationOutcome: completed });
    expect(addSwipe("u1", "msg-1", "")!.extra.generationOutcome).toBeUndefined();
    cycleSwipe("u1", "msg-1", "left");
    const refused = { finish_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null }, error: "Declined" };
    setSwipeScopedExtra("u1", "msg-1", 1, { generationOutcome: refused });
    expect(getMessage("u1", "msg-1")!.extra.generationOutcome).toEqual(completed);
    expect(cycleSwipe("u1", "msg-1", "right")!.extra.generationOutcome).toEqual(refused);
    const remaining = deleteSwipe("u1", "msg-1", 0)!;
    expect(remaining.extra.generationOutcome).toEqual(refused);
    expect(remaining.extra.generationOutcomeBySwipe).toEqual([refused]);
    setSwipeScopedExtra("u1", "msg-1", 0, { generationOutcome: completed });
    expect(getMessage("u1", "msg-1")!.extra.generationOutcome).toEqual(completed);
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

  test("detaches a converted group chat from a solo fork lineage", () => {
    seedChat("solo-root", "c1", "Alpha chat", "{}", 100);
    seedMessage("msg-1", "solo-root", "Hello there", {}, { index: 0 });

    const fork = branchChat("u1", "solo-root", "msg-1")!;
    expect(fork.metadata.branched_from).toBe("solo-root");

    const converted = convertSoloChatToGroup("u1", fork.id)!;
    const group = addGroupMember("u1", converted.id, "c2", { skip_greeting: true })!;

    expect(group.metadata.group).toBe(true);
    expect(group.metadata.character_ids).toEqual(["c1", "c2"]);
    expect(group.metadata.branched_from).toBeUndefined();
    expect(group.metadata.branch_at_message).toBeUndefined();
    expect(getChatTree("u1", group.id)?.id).toBe(group.id);
  });

  test("keeps a forked one-member converted group separate from unrelated solo RPs", () => {
    seedChat("solo-source", "c1", "Converted RP", "{}", 100);
    seedMessage("source-msg-1", "solo-source", "Opening", {}, { index: 0 });
    seedMessage("source-msg-2", "solo-source", "Reply", {}, { index: 1, isUser: true });
    seedChat("unrelated-solo", "c1", "Other RP", "{}", 300);
    seedChat("unrelated-solo-fork", "c1", "Other RP — Branch", JSON.stringify({
      branched_from: "unrelated-solo",
      branch_at_message: "other-msg",
    }), 400);

    const converted = convertSoloChatToGroup("u1", "solo-source")!;
    const convertedMessages = getMessages("u1", converted.id);
    const fork = branchChat("u1", converted.id, convertedMessages[1].id)!;

    const groupHistory = listGroupChatSummaries("u1", ["c1"]);

    expect(groupHistory.map((chat) => chat.id).sort()).toEqual([converted.id, fork.id].sort());
    expect(groupHistory.every((chat) => !chat.name.startsWith("Other RP"))).toBe(true);
    expect(getChat("u1", converted.id)).not.toBeNull();
  });
});

describe("bulk chat deletion", () => {
  test("deletes only owned selected chats and ignores duplicate or missing ids", () => {
    seedChat("delete-one", "c1", "One", "{}", 100);
    seedChat("delete-two", "c1", "Two", "{}", 200);
    seedChat("keep", "c1", "Keep", "{}", 300);
    getDb()
      .query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("foreign", "u2", "c1", "Foreign", "{}", 400, 400);

    const deleted = deleteChats("u1", ["delete-two", "missing", "delete-one", "delete-two", "foreign"]);

    expect(deleted).toEqual(["delete-two", "delete-one"]);
    expect(getChat("u1", "delete-one")).toBeNull();
    expect(getChat("u1", "delete-two")).toBeNull();
    expect(getChat("u1", "keep")?.name).toBe("Keep");
    const foreign = getDb().query("SELECT id FROM chats WHERE id = ?").get("foreign") as { id: string } | null;
    expect(foreign?.id).toBe("foreign");
  });
});

describe("message breakdown deletion", () => {
  test("deletes all breakdowns for a deleted chat and preserves other chats", () => {
    seedChat("delete-chat", "c1", "Delete", "{}", 100);
    seedMessage("delete-message-1", "delete-chat", "One", {}, { index: 0 });
    seedMessage("delete-message-2", "delete-chat", "Two", {}, { index: 1 });
    seedBreakdown("delete-message-1", "delete-chat");
    seedBreakdown("delete-message-2", "delete-chat");

    seedChat("keep-chat", "c1", "Keep", "{}", 200);
    seedMessage("keep-message", "keep-chat", "Keep", {});
    seedBreakdown("keep-message", "keep-chat");

    expect(deleteChat("u1", "delete-chat")).toBe(true);

    const deletedCount = getDb()
      .query("SELECT COUNT(*) AS count FROM message_breakdowns WHERE chat_id = ?")
      .get("delete-chat") as { count: number };
    expect(deletedCount.count).toBe(0);
    expect(getDb().query("SELECT message_id FROM message_breakdowns WHERE message_id = ?").get("keep-message")).not.toBeNull();
  });

  test("deletes the selected and later prompt breakdowns while preserving earlier ones", () => {
    const deletedContentMarker = "deleted-sensitive-prompt-marker";
    seedChat("message-chat", "c1", "Messages", "{}", 100);
    seedMessage("keep-earlier", "message-chat", "Earlier", {}, { index: 0 });
    seedMessage("delete-message", "message-chat", deletedContentMarker, {}, { index: 1 });
    seedMessage("keep-later", "message-chat", "Later", {}, { index: 2 });
    seedBreakdown("keep-earlier", "message-chat");
    seedBreakdown("delete-message", "message-chat");
    seedBreakdown("keep-later", "message-chat", {
      messages: [
        { role: "user", content: deletedContentMarker },
        { role: "assistant", content: "Later" },
      ],
    });

    expect(deleteMessage("u1", "delete-message")).toBe(true);

    expect(getDb().query("SELECT message_id FROM message_breakdowns WHERE message_id = ?").get("delete-message")).toBeNull();
    expect(getDb().query("SELECT message_id FROM message_breakdowns WHERE message_id = ?").get("keep-later")).toBeNull();
    expect(getDb().query("SELECT message_id FROM message_breakdowns WHERE message_id = ?").get("keep-earlier")).not.toBeNull();
    expect(getMessage("u1", "keep-later")).not.toBeNull();
    const retainedMarkerCount = getDb()
      .query("SELECT COUNT(*) AS count FROM message_breakdowns WHERE instr(data, ?) > 0")
      .get(deletedContentMarker) as { count: number };
    expect(retainedMarkerCount.count).toBe(0);
  });

  test("deletes breakdowns for bulk-deleted messages and preserves unselected messages", () => {
    seedChat("bulk-message-chat", "c1", "Bulk", "{}", 100);
    for (const [index, id] of ["delete-one", "keep", "delete-two"].entries()) {
      seedMessage(id, "bulk-message-chat", id, {}, { index });
      seedBreakdown(id, "bulk-message-chat");
    }

    expect(bulkDeleteMessages("u1", "bulk-message-chat", ["delete-one", "missing", "delete-two"])).toBe(2);

    const remaining = getDb()
      .query("SELECT message_id FROM message_breakdowns WHERE chat_id = ? ORDER BY message_id")
      .all("bulk-message-chat") as Array<{ message_id: string }>;
    expect(remaining).toEqual([]);
    expect(getMessage("u1", "keep")).not.toBeNull();
  });
});

describe("message image attachment cleanup", () => {
  test("deletes the image row, original, and thumbnails with the owning message", () => {
    const originalDataDir = env.dataDir;
    const testDataDir = mkdtempSync(join(tmpdir(), "lumiverse-message-image-cleanup-"));
    env.dataDir = testDataDir;

    try {
      const imageId = "message-image";
      const attachment = {
        type: "image",
        image_id: imageId,
        mime_type: "image/png",
        original_filename: "attached.png",
      };
      seedChat("image-chat", "c1", "Images", "{}", 100);
      seedMessage("image-message", "image-chat", "Attached", { attachments: [attachment] });
      const paths = seedStoredImageWithFiles(imageId);

      expect(deleteMessage("u1", "image-message")).toBe(true);

      expect(getDb().query("SELECT id FROM images WHERE id = ?").get(imageId)).toBeNull();
      expect(paths.every((path) => !existsSync(path))).toBe(true);
    } finally {
      env.dataDir = originalDataDir;
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  test("retains a shared image until its final message attachment is removed", () => {
    const originalDataDir = env.dataDir;
    const testDataDir = mkdtempSync(join(tmpdir(), "lumiverse-shared-message-image-"));
    env.dataDir = testDataDir;

    try {
      const imageId = "shared-message-image";
      const attachment = {
        type: "image",
        image_id: imageId,
        mime_type: "image/png",
        original_filename: "shared.png",
      };
      seedChat("shared-image-chat", "c1", "Shared Images", "{}", 100);
      seedMessage("first-image-message", "shared-image-chat", "First", { attachments: [attachment] }, { index: 0 });
      seedMessage("second-image-message", "shared-image-chat", "Second", { attachments: [attachment] }, { index: 1 });
      const paths = seedStoredImageWithFiles(imageId);

      expect(deleteMessage("u1", "first-image-message")).toBe(true);
      expect(getDb().query("SELECT id FROM images WHERE id = ?").get(imageId)).not.toBeNull();
      expect(paths.every(existsSync)).toBe(true);

      expect(removeMessageAttachment("u1", "second-image-message", imageId)).not.toBeNull();
      expect(getDb().query("SELECT id FROM images WHERE id = ?").get(imageId)).toBeNull();
      expect(paths.every((path) => !existsSync(path))).toBe(true);
    } finally {
      env.dataDir = originalDataDir;
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });
});

describe("group member alternate fields", () => {
  test("merges selections for one member without clobbering other members", () => {
    const extensions = {
      alternate_fields: {
        personality: [{ id: "bold", label: "Bold", content: "Bold personality" }],
      },
    };
    seedCharacterWithExtensions("char1", extensions);
    seedCharacterWithExtensions("char2", extensions);
    seedChat("chat1", "char1", "Group", JSON.stringify({
      group: true,
      character_ids: ["char1", "char2"],
      group_alternate_field_selections: { char2: { personality: "bold" } },
    }), 1);

    const updated = setGroupMemberAlternateFields("u1", "chat1", "char1", { personality: "bold" });

    expect(updated?.metadata.group_alternate_field_selections).toEqual({
      char1: { personality: "bold" },
      char2: { personality: "bold" },
    });
  });

  test("rejects invalid variants", () => {
    seedCharacterWithExtensions("char1", {
      alternate_fields: {
        personality: [{ id: "known", label: "Known", content: "Known personality" }],
      },
    });
    seedCharacterWithExtensions("char2");
    seedChat("chat1", "char1", "Group", JSON.stringify({ group: true, character_ids: ["char1", "char2"] }), 1);

    const updated = setGroupMemberAlternateFields("u1", "chat1", "char1", { personality: "missing" });

    expect(updated).toBeNull();
    expect(getChat("u1", "chat1")?.metadata.group_alternate_field_selections).toBeUndefined();
  });

  test("removing a member clears stale alternate field selections", () => {
    seedCharacterWithExtensions("char1");
    seedCharacterWithExtensions("char2");
    seedCharacterWithExtensions("char3");
    seedChat("chat1", "char1", "Group", JSON.stringify({
      group: true,
      character_ids: ["char1", "char2", "char3"],
      group_alternate_field_selections: {
        char2: { personality: "bold" },
        char3: { personality: "quiet" },
      },
    }), 1);

    const updated = removeGroupMember("u1", "chat1", "char2");

    expect(updated?.metadata.group_alternate_field_selections).toEqual({
      char3: { personality: "quiet" },
    });
  });
});

describe("avatar-bound appearance", () => {
  const appearanceExtensions = {
    alternate_fields: {
      description: [{ id: "winter-desc", label: "Winter", content: "Winter coat" }],
      personality: [{ id: "warm", label: "Warm", content: "Warm personality" }],
    },
    alternate_avatars: [{ id: "winter-avatar", image_id: "winter-image", label: "Winter" }],
    avatar_bindings: {
      "winter-avatar": {
        description: "winter-desc",
        personality: "warm",
        scenario: null,
        greeting_index: 1,
      },
    },
  };

  test("selecting an avatar applies its complete field and greeting state", () => {
    seedCharacterWithExtensions("char1", appearanceExtensions);
    getDb().query("UPDATE characters SET image_id = ?, first_mes = ?, alternate_greetings = ? WHERE id = ?")
      .run("primary-image", "Default hello", JSON.stringify(["Winter hello"]), "char1");
    const chat = createChat("u1", { character_id: "char1", name: "Chat" });

    const result = applyChatAppearance("u1", chat.id, { type: "avatar", avatar_entry_id: "winter-avatar" });

    expect(result?.chat.metadata.active_avatar_id).toBe("winter-image");
    expect(result?.chat.metadata.active_avatar_entry_id).toBe("winter-avatar");
    expect(result?.chat.metadata.alternate_field_selections).toEqual({
      description: "winter-desc",
      personality: "warm",
    });
    expect(result?.chat.metadata.activeGreetingIndex).toBe(1);
    expect(result?.greeting_message?.content).toBe("Winter hello");
    expect(result?.greeting_message?.extra.greeting_index).toBe(1);
  });

  test("selecting a uniquely bound field activates the owning avatar", () => {
    seedCharacterWithExtensions("char1", appearanceExtensions);
    getDb().query("UPDATE characters SET alternate_greetings = ? WHERE id = ?")
      .run(JSON.stringify(["Winter hello"]), "char1");
    seedChat("chat1", "char1", "Chat", "{}", 1);

    const result = applyChatAppearance("u1", "chat1", {
      type: "field",
      field: "description",
      variant_id: "winter-desc",
    });

    expect(result?.chat.metadata.active_avatar_id).toBe("winter-image");
    expect(result?.chat.metadata.alternate_field_selections.personality).toBe("warm");
  });

  test("a deleted variant left in an old avatar binding does not block appearance changes", () => {
    seedCharacterWithExtensions("char1", {
      ...appearanceExtensions,
      alternate_fields: { personality: appearanceExtensions.alternate_fields.personality },
    });
    getDb().query("UPDATE characters SET alternate_greetings = ? WHERE id = ?")
      .run(JSON.stringify(["Winter hello"]), "char1");
    seedChat("chat1", "char1", "Chat", "{}", 1);

    const selectedField = applyChatAppearance("u1", "chat1", {
      type: "field", field: "personality", variant_id: "warm",
    });
    expect(selectedField?.chat.metadata.active_avatar_id).toBe("winter-image");
    expect(selectedField?.chat.metadata.alternate_field_selections).toEqual({ personality: "warm" });

    const selectedAvatar = applyChatAppearance("u1", "chat1", {
      type: "avatar", avatar_entry_id: "winter-avatar",
    });
    expect(selectedAvatar?.chat.metadata.alternate_field_selections).toEqual({ personality: "warm" });
    expect(applyChatAppearance("u1", "chat1", {
      type: "field", field: "description", variant_id: "winter-desc",
    })).toBeNull();
  });

  test("an unbound field change does not rewrite an edited greeting", () => {
    seedCharacterWithExtensions("char1", {
      alternate_fields: {
        description: [{ id: "winter-desc", label: "Winter", content: "Winter coat" }],
      },
    });
    getDb().query("UPDATE characters SET first_mes = ? WHERE id = ?").run("Card greeting", "char1");
    const chat = createChat("u1", { character_id: "char1", name: "Chat" });
    const greeting = getMessages("u1", chat.id)[0];
    updateMessage("u1", greeting.id, { content: "User-edited greeting" });

    const result = applyChatAppearance("u1", chat.id, {
      type: "field",
      field: "description",
      variant_id: "winter-desc",
    });

    expect(result?.greeting_message).toBeUndefined();
    expect(getMessages("u1", chat.id)[0]?.content).toBe("User-edited greeting");
  });

  test("stores group member avatars independently", () => {
    seedCharacterWithExtensions("char1", appearanceExtensions);
    seedCharacterWithExtensions("char2", appearanceExtensions);
    getDb().query("UPDATE characters SET alternate_greetings = ? WHERE id IN (?, ?)")
      .run(JSON.stringify(["Winter hello"]), "char1", "char2");
    seedChat("chat1", "char1", "Group", JSON.stringify({ group: true, character_ids: ["char1", "char2"] }), 1);

    const result = applyChatAppearance("u1", "chat1", {
      type: "field",
      field: "description",
      variant_id: "winter-desc",
      character_id: "char2",
    });

    expect(result?.chat.metadata.group_active_avatar_ids).toEqual({ char2: "winter-image" });
    expect(result?.chat.metadata.group_alternate_field_selections.char2).toEqual({
      description: "winter-desc",
      personality: "warm",
    });
    expect(result?.chat.metadata.active_avatar_id).toBeUndefined();
  });

  test("applies an avatar selection to the addressed group member, not the chat owner", () => {
    seedCharacterWithExtensions("char1", appearanceExtensions);
    seedCharacterWithExtensions("char2", appearanceExtensions);
    getDb().query("UPDATE characters SET alternate_greetings = ? WHERE id IN (?, ?)")
      .run(JSON.stringify(["Winter hello"]), "char1", "char2");
    seedChat("chat1", "char1", "Group", JSON.stringify({ group: true, character_ids: ["char1", "char2"] }), 1);

    const result = applyChatAppearance("u1", "chat1", {
      type: "avatar",
      avatar_entry_id: "winter-avatar",
      character_id: "char2",
    });

    expect(result?.chat.metadata.group_active_avatar_ids).toEqual({ char2: "winter-image" });
    expect(result?.chat.metadata.group_active_avatar_entry_ids).toEqual({ char2: "winter-avatar" });
    expect(result?.chat.metadata.group_active_greeting_indices).toEqual({ char2: 1 });
    expect(result?.chat.metadata.active_avatar_id).toBeUndefined();
  });
});
