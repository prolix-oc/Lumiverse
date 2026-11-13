import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { countTokens as countCl100k } from "gpt-tokenizer/encoding/cl100k_base";
import { countTokens as countO200k } from "gpt-tokenizer/encoding/o200k_base";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { getPresenceChatSnapshot, getPresenceSnapshot } from "./presence.service";
import { _resetForTests } from "./tokenizer.service";
import { putSetting } from "./settings.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

const content = "こんにちは、世界！ This is a 🧠 tokenizer check.";

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run("CREATE TABLE settings (key TEXT, user_id TEXT, value TEXT, updated_at INTEGER, PRIMARY KEY (key, user_id))");
  db.run("CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT, user_id TEXT, deleting INTEGER NOT NULL DEFAULT 0)");
  db.run("CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT, character_id TEXT, metadata TEXT)");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT, content TEXT, swipe_id INTEGER, extra TEXT)");
  db.run("CREATE TABLE connection_profiles (id TEXT PRIMARY KEY, user_id TEXT, model TEXT, is_default INTEGER, metadata TEXT, parameters TEXT)");
  db.run("CREATE TABLE tokenizer_configs (id TEXT PRIMARY KEY, name TEXT, type TEXT, config TEXT, is_built_in INTEGER, created_at INTEGER, updated_at INTEGER)");
  db.run("CREATE TABLE tokenizer_model_patterns (id TEXT PRIMARY KEY, tokenizer_id TEXT, pattern TEXT, priority INTEGER, is_built_in INTEGER, created_at INTEGER, updated_at INTEGER)");
  db.run("INSERT INTO characters (id, name, user_id) VALUES ('character', 'Aria', 'user')");
  db.query("INSERT INTO connection_profiles VALUES (?, 'user', ?, ?, '{}', '{}')").run("active", "active-model", 1);
  db.query("INSERT INTO connection_profiles VALUES (?, 'user', ?, ?, '{}', '{}')").run("pinned", "pinned-model", 0);
  db.query("INSERT INTO chats VALUES (?, 'user', 'character', ?)").run("chat-a", "{}");
  db.query("INSERT INTO chats VALUES (?, 'user', 'character', ?)").run("chat-b", JSON.stringify({ connection_profile_id: "pinned", connection_model: "override-model" }));
  for (const [model, encoding] of [["active-model", "cl100k_base"], ["pinned-model", "cl100k_base"], ["override-model", "o200k_base"]]) {
    db.query("INSERT INTO tokenizer_configs VALUES (?, ?, 'openai', ?, 0, 0, 0)").run(model, model, JSON.stringify({ encoding }));
    db.query("INSERT INTO tokenizer_model_patterns VALUES (?, ?, ?, 100, 0, 0, 0)").run(model, model, `^${model}$`);
  }
  db.query("INSERT INTO messages VALUES (?, ?, ?, 1, ?)").run("a1", "chat-a", content, JSON.stringify({ tokenCount: 999, tokenCountBySwipe: [888, 777] }));
  db.query("INSERT INTO messages VALUES (?, ?, ?, 1, ?)").run("b1", "chat-b", content, JSON.stringify({ tokenCount: 999 }));
  db.query("INSERT INTO messages VALUES (?, ?, ?, 0, '{}')").run("b2", "chat-b", "Second message without stored counts.");
  putSetting("user", "activeProfileId", "active");
  putSetting("user", "activeChatId", "chat-a");
  _resetForTests();
});

afterEach(() => {
  closeDatabase();
  _resetForTests();
});

describe("Discord presence snapshots", () => {
  test("landing presence counts only the user's characters that are not being deleted", async () => {
    putSetting("user", "activeChatId", null);
    getDb().run("INSERT INTO characters VALUES ('second', 'Second', 'user', 0)");
    getDb().run("INSERT INTO characters VALUES ('deleted', 'Deleted', 'user', 1)");
    getDb().run("INSERT INTO characters VALUES ('other', 'Other', 'other-user', 0)");
    expect(await getPresenceSnapshot("user")).toEqual({
      chatId: null, characterName: null, messageCount: null,
      totalTokens: null, model: null, characterCount: 2,
    });
    getDb().run("UPDATE characters SET deleting = 1 WHERE user_id = 'user'");
    expect((await getPresenceSnapshot("user"))).toMatchObject({ characterCount: 0 });
  });

  test("presence transitions between a chat and landing without stale chat details", async () => {
    expect(await getPresenceSnapshot("user")).toMatchObject({ chatId: "chat-a", model: "active-model" });
    putSetting("user", "activeChatId", null);
    expect(await getPresenceSnapshot("user")).toEqual({
      chatId: null, characterName: null, messageCount: null,
      totalTokens: null, model: null, characterCount: 1,
    });
    putSetting("user", "activeChatId", "chat-b");
    const chat = await getPresenceSnapshot("user");
    expect(chat).toMatchObject({ chatId: "chat-b", model: "override-model", messageCount: 2 });
    expect(chat).not.toHaveProperty("characterCount");
  });

  test("a missing or stale selection falls back to the user's landing activity", async () => {
    getDb().run("DELETE FROM settings WHERE key = 'activeChatId'");
    expect(await getPresenceSnapshot("user")).toMatchObject({ chatId: null, characterCount: 1 });
    putSetting("user", "activeChatId", "deleted-chat");
    expect(await getPresenceSnapshot("user")).toMatchObject({ chatId: null, characterCount: 1 });
  });

  test("tokenizes canonical messages with the active connection instead of stored estimates", async () => {
    expect(await getPresenceChatSnapshot("user")).toEqual({
      chatId: "chat-a", characterName: "Aria", messageCount: 1,
      model: "active-model", totalTokens: countCl100k(content),
    });
  });

  test("a committed switch updates the model, count, and tokenizer for the pinned chat", async () => {
    await getPresenceChatSnapshot("user");
    const switched = new Promise<void>((resolve) => {
      const off = eventBus.on(EventType.CHAT_SWITCHED, (event) => {
        if (event.userId === "user" && event.payload.chatId === "chat-b") {
          off();
          resolve();
        }
      });
    });
    putSetting("user", "activeChatId", "chat-b");
    await switched;
    expect(await getPresenceChatSnapshot("user")).toEqual({
      chatId: "chat-b", characterName: "Aria", messageCount: 2,
      model: "override-model", totalTokens: countO200k(content) + countO200k("Second message without stored counts."),
    });
  });

  test("edits and swipe changes invalidate content-based counts", async () => {
    await getPresenceChatSnapshot("user");
    getDb().query("UPDATE messages SET content = ?, swipe_id = 2 WHERE id = 'a1'").run("Changed canonical swipe.");
    expect((await getPresenceChatSnapshot("user"))?.totalTokens).toBe(countCl100k("Changed canonical swipe."));
  });

  test("changing the active connection recounts the same chat with its new tokenizer", async () => {
    await getPresenceChatSnapshot("user");
    getDb().query("UPDATE connection_profiles SET model = 'override-model' WHERE id = 'active'").run();
    expect(await getPresenceChatSnapshot("user")).toMatchObject({
      model: "override-model", totalTokens: countO200k(content),
    });
  });

  test("a pinned connection without a model override uses its own model", async () => {
    putSetting("user", "activeChatId", "chat-b");
    getDb().query("UPDATE chats SET metadata = ? WHERE id = 'chat-b'").run(JSON.stringify({ connection_profile_id: "pinned" }));
    expect(await getPresenceChatSnapshot("user")).toMatchObject({
      model: "pinned-model", totalTokens: countCl100k(content) + countCl100k("Second message without stored counts."),
    });
  });

  test("changing a tokenizer config invalidates cached counts for the same model", async () => {
    await getPresenceChatSnapshot("user");
    getDb().query("UPDATE tokenizer_configs SET config = ? WHERE id = 'active-model'").run(JSON.stringify({ encoding: "o200k_base" }));
    expect((await getPresenceChatSnapshot("user"))?.totalTokens).toBe(countO200k(content));
  });

  test.each(["missing", "approximate", "broken"])("omits counts for a %s tokenizer", async (mode) => {
    if (mode === "missing") getDb().run("DELETE FROM tokenizer_model_patterns");
    if (mode === "approximate") getDb().run("UPDATE tokenizer_configs SET type = 'approximate'");
    if (mode === "broken") getDb().run("UPDATE tokenizer_configs SET type = 'huggingface', config = '{}'");
    _resetForTests();
    expect(await getPresenceChatSnapshot("user")).toMatchObject({
      chatId: "chat-a", messageCount: 1, model: "active-model", totalTokens: null,
    });
  });

  test("empty chats have zero counts and leaving a chat clears the snapshot", async () => {
    getDb().run("DELETE FROM messages WHERE chat_id = 'chat-a'");
    expect(await getPresenceChatSnapshot("user")).toMatchObject({ messageCount: 0, totalTokens: 0 });
    putSetting("user", "activeChatId", null);
    expect(await getPresenceChatSnapshot("user")).toBeNull();
  });

  test("a stale or another user's chat selection cannot publish their presence", async () => {
    getDb().run("UPDATE chats SET user_id = 'other' WHERE id = 'chat-a'");
    expect(await getPresenceChatSnapshot("user")).toBeNull();
    putSetting("user", "activeChatId", "deleted-chat");
    expect(await getPresenceChatSnapshot("user")).toBeNull();
  });
});
