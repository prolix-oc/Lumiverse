import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { claimAssociativeRegexAction, claimAssociativeRegexActions } from "./chats.service";

describe("associative regex action claims", () => {
  beforeAll(() => {
    closeDatabase();
    initDatabase(":memory:");
    const db = getDb();
    db.run(`CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      character_id TEXT,
      name TEXT NOT NULL DEFAULT '',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )`);
    db.run(`CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      index_in_chat INTEGER NOT NULL,
      is_user INTEGER NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      send_date INTEGER NOT NULL,
      swipe_id INTEGER NOT NULL,
      swipes TEXT NOT NULL,
      swipe_dates TEXT NOT NULL,
      extra TEXT NOT NULL,
      parent_message_id TEXT,
      branch_id TEXT,
      created_at INTEGER NOT NULL
    )`);
    db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run("chat-1", "user-1");
    db.query(
      `INSERT INTO messages
       (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, created_at)
       VALUES (?, ?, 0, 0, 'Guide', 'Choose', 1, 0, '["Choose"]', '[1]', '{}', 1)`,
    ).run("message-1", "chat-1");
    db.query(
      `INSERT INTO messages
       (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, created_at)
       VALUES (?, ?, 1, 1, 'User', 'Choose', 2, 0, '["Choose"]', '[2]', '{}', 2)`,
    ).run("user-message", "chat-1");
  });

  afterAll(() => closeDatabase());

  test("only the first action selected from a rendered block can claim it", () => {
    const first = claimAssociativeRegexAction("user-1", "chat-1", "message-1", {
      instanceId: "script-1:10:20",
      scriptId: "script-1",
      actionId: "north",
    });
    expect(first.status).toBe("claimed");

    const duplicate = claimAssociativeRegexAction("user-1", "chat-1", "message-1", {
      instanceId: "script-1:10:20",
      scriptId: "script-1",
      actionId: "south",
    });
    expect(duplicate.status).toBe("used");
    if (duplicate.status === "used") {
      expect(duplicate.usage.action_id).toBe("north");
      expect(duplicate.message.extra.associative_regex_action_usage).toEqual({
        "script-1:10:20": duplicate.usage,
      });
    }

    const otherBlock = claimAssociativeRegexAction("user-1", "chat-1", "message-1", {
      instanceId: "script-1:30:40",
      scriptId: "script-1",
      actionId: "east",
    });
    expect(otherBlock.status).toBe("claimed");

    const multiNorth = claimAssociativeRegexAction("user-1", "chat-1", "message-1", {
      instanceId: "script-2:50:60",
      scriptId: "script-2",
      actionId: "north",
      multiSelect: true,
    });
    const multiSouth = claimAssociativeRegexAction("user-1", "chat-1", "message-1", {
      instanceId: "script-2:50:60",
      scriptId: "script-2",
      actionId: "south",
      multiSelect: true,
    });
    expect(multiNorth.status).toBe("claimed");
    expect(multiSouth.status).toBe("claimed");

    const duplicateMultiNorth = claimAssociativeRegexAction("user-1", "chat-1", "message-1", {
      instanceId: "script-2:50:60",
      scriptId: "script-2",
      actionId: "north",
      multiSelect: true,
    });
    expect(duplicateMultiNorth.status).toBe("used");

    const singleAfterMulti = claimAssociativeRegexAction("user-1", "chat-1", "message-1", {
      instanceId: "script-2:50:60",
      scriptId: "script-2",
      actionId: "confirm",
    });
    expect(singleAfterMulti.status).toBe("used");
  });

  test("finalizes a multi-select set atomically at send time", () => {
    const claimed = claimAssociativeRegexActions("user-1", "chat-1", [
      { messageId: "message-1", instanceId: "script-3:70:80", scriptId: "script-3", actionId: "north", multiSelect: true },
      { messageId: "message-1", instanceId: "script-3:70:80", scriptId: "script-3", actionId: "south", multiSelect: true },
      { messageId: "message-1", instanceId: "script-3:70:80", scriptId: "script-3", actionId: "confirm", multiSelect: false },
    ]);
    expect(claimed.status).toBe("claimed");
    if (claimed.status === "claimed") {
      expect(claimed.usages).toHaveLength(3);
      expect(claimed.messages[0].extra.associative_regex_action_usage).toMatchObject({
        "script-3:70:80": { action_id: "confirm" },
        "script-3:70:80:north": { action_id: "north" },
        "script-3:70:80:south": { action_id: "south" },
      });
    }

    const conflict = claimAssociativeRegexActions("user-1", "chat-1", [
      { messageId: "message-1", instanceId: "script-3:70:80", scriptId: "script-3", actionId: "north", multiSelect: true },
      { messageId: "message-1", instanceId: "script-3:90:100", scriptId: "script-3", actionId: "east", multiSelect: true },
    ]);
    expect(conflict.status).toBe("used");

    const eastAfterConflict = claimAssociativeRegexActions("user-1", "chat-1", [
      { messageId: "message-1", instanceId: "script-3:90:100", scriptId: "script-3", actionId: "east", multiSelect: true },
    ]);
    expect(eastAfterConflict.status).toBe("claimed");
  });

  test("commits resolved state effects into persistent chat variables", () => {
    const claimed = claimAssociativeRegexAction("user-1", "chat-1", "message-1", {
      instanceId: "script-state:0:6",
      scriptId: "script-state",
      actionId: "choose-route",
      stateEffects: [{ key: "adventure.route", value: "rooftops" }],
    });

    expect(claimed.status).toBe("claimed");
    const metadata = JSON.parse((getDb().query("SELECT metadata FROM chats WHERE id = ?").get("chat-1") as any).metadata);
    expect(metadata.chat_variables).toEqual({ "adventure.route": "rooftops" });

    const duplicate = claimAssociativeRegexAction("user-1", "chat-1", "message-1", {
      instanceId: "script-state:0:6",
      scriptId: "script-state",
      actionId: "choose-route",
      stateEffects: [{ key: "adventure.route", value: "street" }],
    });
    expect(duplicate.status).toBe("used");
    const afterDuplicate = JSON.parse((getDb().query("SELECT metadata FROM chats WHERE id = ?").get("chat-1") as any).metadata);
    expect(afterDuplicate.chat_variables).toEqual({ "adventure.route": "rooftops" });
  });

  test("applies multi-select state effects together at commit", () => {
    const claimed = claimAssociativeRegexActions("user-1", "chat-1", [
      {
        messageId: "message-1",
        instanceId: "script-state-batch:0:6",
        scriptId: "script-state-batch",
        actionId: "route",
        multiSelect: true,
        stateEffects: [{ key: "adventure.route", value: "canals" }],
      },
      {
        messageId: "message-1",
        instanceId: "script-state-batch:0:6",
        scriptId: "script-state-batch",
        actionId: "companion",
        multiSelect: true,
        stateEffects: [{ key: "adventure.companion", value: "Lyra" }],
      },
    ]);

    expect(claimed.status).toBe("claimed");
    const metadata = JSON.parse((getDb().query("SELECT metadata FROM chats WHERE id = ?").get("chat-1") as any).metadata);
    expect(metadata.chat_variables).toMatchObject({
      "adventure.route": "canals",
      "adventure.companion": "Lyra",
    });
  });

  test("rejects state effects sourced from a user-role message", () => {
    const result = claimAssociativeRegexAction("user-1", "chat-1", "user-message", {
      instanceId: "script-state-user:0:6",
      scriptId: "script-state-user",
      actionId: "unsafe",
      stateEffects: [{ key: "adventure.route", value: "forged" }],
    });

    expect(result.status).toBe("forbidden");
    const metadata = JSON.parse((getDb().query("SELECT metadata FROM chats WHERE id = ?").get("chat-1") as any).metadata);
    expect(metadata.chat_variables?.["adventure.route"]).not.toBe("forged");
  });

  test("atomically combines state changes with a fork at the source message", () => {
    const result = claimAssociativeRegexAction("user-1", "chat-1", "message-1", {
      instanceId: "script-composite:0:6",
      scriptId: "script-composite",
      actionId: "branch-route",
      requiresAssistantSource: true,
      stateEffects: [{ key: "adventure.route", value: "hidden-pass" }],
      fork: true,
    });

    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") return;
    expect(result.forkedChat).toBeTruthy();
    expect(result.forkedChat?.metadata.chat_variables).toMatchObject({
      "adventure.route": "hidden-pass",
    });
    expect(result.forkedChat?.metadata).toMatchObject({
      branched_from: "chat-1",
      branch_at_message: "message-1",
    });
    const forkMessages = getDb()
      .query("SELECT is_user, content FROM messages WHERE chat_id = ? ORDER BY index_in_chat")
      .all(result.forkedChat!.id);
    expect(forkMessages).toEqual([{ is_user: 0, content: "Choose" }]);
  });

  test("rejects fork effects sourced from a user-role message", () => {
    const result = claimAssociativeRegexAction("user-1", "chat-1", "user-message", {
      instanceId: "script-fork-user:0:6",
      scriptId: "script-fork-user",
      actionId: "unsafe-fork",
      requiresAssistantSource: true,
      fork: true,
    });

    expect(result.status).toBe("forbidden");
  });
});
