import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mutateChatWithDb } from "./chat-operations";
import type { ConditionalChatMetadataInput } from "../types/chat";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); databases.push(db);
  db.run("CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT, metadata TEXT, updated_at INTEGER)");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT, index_in_chat INTEGER, swipe_id INTEGER, swipes TEXT, extra TEXT, content TEXT DEFAULT '')");
  db.run("INSERT INTO chats VALUES ('chat', 'alice', ?, 1)", [JSON.stringify({ variables: { count: "1" }, other: true })]);
  db.run("INSERT INTO messages (id, chat_id, index_in_chat, swipe_id, swipes, extra) VALUES ('reply', 'chat', 0, 0, ?, ?)", [JSON.stringify(["A", "B"]), JSON.stringify({ spindle_metadata: { owned: true } })]);
  const input: ConditionalChatMetadataInput = { expected_metadata: { other: true, variables: { count: "1" } }, metadata: { variables: { count: "2" }, other: true },
    expected_last_message_id: "reply", expected_message: { id: "reply", swipe_id: 0, swipes: ["A", "B"], metadata: { owned: true } } };
  const write = (value = input, userId = "alice") => mutateChatWithDb(db, { action: "compare-metadata", userId, id: "chat", input: value });
  const metadata = () => JSON.parse((db.query("SELECT metadata FROM chats WHERE id = 'chat'").get() as any).metadata);
  return { db, input, write, metadata };
}

test("conditional chat writes compare object values and prevent lost metadata updates", () => {
  const f = fixture();
  const stale = structuredClone(f.input);
  expect(f.write()?.after.metadata.variables).toEqual({ count: "2" });
  expect(f.write(stale)).toBeNull();
  expect(f.metadata()).toEqual(f.input.metadata);
});

test("conditional chat writes reject deleted, switched, edited and replaced target messages", () => {
  for (const change of [
    "DELETE FROM messages",
    "UPDATE messages SET swipe_id = 1",
    `UPDATE messages SET swipes = '["edited","B"]'`,
    `UPDATE messages SET extra = '{"spindle_metadata":{"owned":false}}'`,
    `INSERT INTO messages (id, chat_id, index_in_chat, swipe_id, swipes, extra) VALUES ('later', 'chat', 1, 0, '[]', '{}')`,
    "UPDATE messages SET chat_id = 'another'",
  ]) {
    const f = fixture(); f.db.run(change);
    expect(f.write()).toBeNull(); expect(f.metadata()).toEqual(f.input.expected_metadata);
  }
});

test("conditional chat writes support empty chats, optional guards and user isolation", () => {
  const f = fixture();
  expect(f.write(f.input, "bob")).toBeNull();
  expect(f.write({ ...f.input, expected_last_message_id: null })).toBeNull();
  f.db.run("DELETE FROM messages");
  expect(f.write({ ...f.input, expected_message: undefined, expected_last_message_id: null })).not.toBeNull();
  expect(f.write({ expected_metadata: f.input.metadata, metadata: {} })).not.toBeNull();
  expect(f.metadata()).toEqual({});
});

test("ordinary chat replacements and merges keep their existing semantics", () => {
  const f = fixture();
  mutateChatWithDb(f.db, { action: "update", userId: "alice", id: "chat", input: { metadata: { only: 1 } } });
  expect(f.metadata()).toEqual({ only: 1 });
  mutateChatWithDb(f.db, { action: "merge", userId: "alice", id: "chat", partial: { second: 2 } });
  expect(f.metadata()).toEqual({ only: 1, second: 2 });
});
