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
});
