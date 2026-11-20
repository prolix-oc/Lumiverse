import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mutateChatWithDb } from "./chat-operations";
import { preserveSwipeVariablesSql, prepareNativeSwipeVariablesWithDb, readGenerationVariableSeed, readVariableStateSeed, reconcileSwipeVariablesWithDb, remapSwipeVariableOwnerWithDb, setSwipeVariablesWithDb } from "./swipe-variable-state";
import { readVariableValues } from "../utils/variable-checkpoint";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); databases.push(db);
  db.run("CREATE TABLE chats (id TEXT, user_id TEXT, metadata TEXT, updated_at INTEGER)");
  db.run("CREATE TABLE messages (id TEXT, chat_id TEXT, index_in_chat INTEGER, is_user INTEGER, swipe_id INTEGER, swipes TEXT, extra TEXT)");
  db.run("INSERT INTO chats VALUES ('chat','user',?,0)", [JSON.stringify({ chat_variables: { count: "0", untouched: 123 }, macro_variables: { global: { flag: "old" } } })]);
  const metadata = () => JSON.parse((db.query("SELECT metadata FROM chats WHERE id='chat'").get() as any).metadata);
  const append = (id: string, index: number, swipes = ["A", "B"]) => db.run("INSERT INTO messages VALUES (?, 'chat', ?, 0, 0, ?, '{}')", [id, index, JSON.stringify(swipes)]);
  const read = (id: string) => JSON.parse((db.query("SELECT extra FROM messages WHERE id=?").get(id) as any).extra);
  const install = (id: string, values: string[]) => { const m = metadata(); const before = readVariableValues(m);
    return setSwipeVariablesWithDb(db, "user", "chat", id, { expected_variables: before, expected_revision: m._swipe_variable_state?.revision ?? null,
      expected_swipes: JSON.parse((db.query("SELECT swipes FROM messages WHERE id=?").get(id) as any).swipes),
      variables: values.map(count => ({ ...before, chat: { ...before.chat, count } })),
    });
  };
  const merge = (partial: Record<string, any>) => mutateChatWithDb(db, { action: "merge", userId: "user", id: "chat", partial });
  const select = (id: string, index: number) => { db.run("UPDATE messages SET swipe_id=? WHERE id=?", [index, id]); reconcileSwipeVariablesWithDb(db, "user", "chat", { selectedMessageId: id }); };
  return { db, metadata, append, install, read, merge, select, count: () => metadata().chat_variables.count };
}

test("bulk deletion rewinds through every removed reply and stops at intervening external edits", () => {
  for (const manual of [false, true]) {
    const f = fixture();
    f.append("a", 0); expect(f.install("a", ["1", "10"])).toBe(true);
    f.append("b", 1); f.install("b", ["2", "20"]);
    if (manual) f.merge({ chat_variables: { ...f.metadata().chat_variables, count: "9" } });
    f.append("c", 2); f.install("c", [manual ? "10" : "3", "30"]);
    f.db.run("DELETE FROM messages WHERE id IN ('b','c')");
    reconcileSwipeVariablesWithDb(f.db, "user", "chat");
    expect(f.count()).toBe(manual ? "9" : "1");
    f.select("a", 1); expect(f.count()).toBe(manual ? "9" : "10");
    expect(f.metadata().chat_variables.untouched).toBe(123);
  }
});

test("native prompt and response writes belong to their immutable source swipe", () => {
  const f = fixture(); f.append("a", 0); f.install("a", ["1", "10"]);
  f.db.run("UPDATE messages SET swipes='[\"A\",\"B\",\"native\"]', swipe_id=2 WHERE id='a'");
  const stateId = prepareNativeSwipeVariablesWithDb(f.db, "user", "chat", "a", 2)!;
  const seed = readVariableStateSeed(f.metadata())!;
  prepareNativeSwipeVariablesWithDb(f.db, "user", "chat", "a", 2, seed, stateId);
  const write = (chat: string, global?: string) => mutateChatWithDb(f.db, { action: "merge", userId: "user", id: "chat", partial: {},
    variableSource: { messageId: "a", stateId, values: { chat: { ...seed.values.chat, count: chat }, ...(global ? { global: { flag: global } } : {}) } } });
  write("2"); expect(f.count()).toBe("2");
  expect(f.metadata().macro_variables.global.flag).toBe("old");
  f.select("a", 0); expect(f.count()).toBe("1");
  write("3", "new"); expect(f.count()).toBe("1");
  expect(f.metadata().macro_variables.global.flag).toBe("old");
  f.select("a", 2); expect(f.count()).toBe("3");
  expect(f.metadata().macro_variables.global.flag).toBe("new");
  f.select("a", 1); expect(f.count()).toBe("10");
  expect(f.metadata().macro_variables.global.flag).toBe("old");
  const extra = f.read("a"); extra.variableStateBySwipe.splice(0, 1);
  f.db.run("UPDATE messages SET extra=?, swipes='[\"B\",\"native\"]', swipe_id=1 WHERE id='a'", [JSON.stringify(extra)]);
  write("4"); expect(f.count()).toBe("4");
  extra.variableStateBySwipe.pop(); f.db.run("UPDATE messages SET extra=? WHERE id='a'", [JSON.stringify(extra)]);
  expect(() => write("5")).toThrow("unavailable");
  expect(f.count()).toBe("4");
});

test("metadata replacements cannot restore old ownership after external ABA writes", () => {
  const f = fixture(); f.append("a", 0); f.install("a", ["1", "10"]);
  const stale = f.metadata();
  f.merge({ chat_variables: { ...stale.chat_variables, count: "7" } });
  f.merge({ chat_variables: { ...stale.chat_variables, count: "1" } });
  const revision = f.metadata()._swipe_variable_state.revision;
  mutateChatWithDb(f.db, { action: "update", userId: "user", id: "chat", input: { metadata: { ...stale, unrelated: true } } });
  expect(f.metadata()._swipe_variable_state.revision).toBe(revision);
  f.select("a", 1); expect(f.count()).toBe("1");
});

test("assembly uses the captured epoch and cannot overwrite an edit made after its snapshot", () => {
  const f = fixture(); f.append("a", 0); f.install("a", ["1", "10"]);
  f.append("b", 1, ["native"]);
  const id = prepareNativeSwipeVariablesWithDb(f.db, "user", "chat", "b", 0)!;
  const seed = readVariableStateSeed(f.metadata())!;
  f.merge({ chat_variables: { count: "7" } }); f.merge({ chat_variables: { count: "1" } });
  prepareNativeSwipeVariablesWithDb(f.db, "user", "chat", "b", 0, seed, id);
  mutateChatWithDb(f.db, { action: "merge", userId: "user", id: "chat", partial: {}, variableSource: { messageId: "b", stateId: id, values: { chat: { count: "2" } } } });
  expect(f.count()).toBe("1");
});

test("native preparation starts tracking without extension setup; installs reject changed baselines and other owners", () => {
  const f = fixture(); f.append("a", 0);
  const input = { expected_variables: readVariableValues(f.metadata()), expected_revision: null, variables: [readVariableValues(f.metadata())], expected_swipes: ["wrong"] };
  expect(setSwipeVariablesWithDb(f.db, "user", "chat", "a", input)).toBe(false);
  expect(() => setSwipeVariablesWithDb(f.db, "other", "chat", "a", input)).toThrow("Chat not found");
  expect(f.metadata()._swipe_variable_state).toBeUndefined();
  expect(prepareNativeSwipeVariablesWithDb(f.db, "user", "chat", "a", 0)).toBeString();
  expect(f.read("a").variableStateBySwipe[0].before.values.chat.count).toBe("0");
});

test("historical selections and delayed writes leave current state unchanged until later messages are removed", () => {
  for (const laterUser of [false, true]) {
    const f = fixture(); f.append("a", 0); f.install("a", ["1", "10"]);
    f.append("b", 1);
    if (laterUser) f.db.run("UPDATE messages SET is_user=1 WHERE id='b'");
    else f.install("b", ["2", "20"]);
    const before = f.metadata();
    f.select("a", 1); expect(f.metadata()).toEqual(before);
    mutateChatWithDb(f.db, { action: "merge", userId: "user", id: "chat", partial: {}, variableSource: {
      messageId: "a", stateId: f.read("a").variableStateBySwipe[1].id, values: { chat: { count: "11" } },
    } });
    expect(f.metadata()).toEqual(before);
    expect(f.read("a").variableStateBySwipe[1].values.chat.count).toBe("11");
    f.db.run("DELETE FROM messages WHERE id='b'");
    reconcileSwipeVariablesWithDb(f.db, "user", "chat");
    expect(f.count()).toBe("11");
    f.select("a", 0); expect(f.count()).toBe("1");
  }
});

test("native alternatives share their starting state and retain a distinct before snapshot for later replies", () => {
  const f = fixture(); f.append("a", 0);
  const write = (messageId: string, stateId: string, count: string) => mutateChatWithDb(f.db, {
    action: "merge", userId: "user", id: "chat", partial: {}, variableSource: { messageId, stateId, values: { chat: { count } } },
  });
  const first = prepareNativeSwipeVariablesWithDb(f.db, "user", "chat", "a", 0)!;
  write("a", first, "1");
  const alternateSeed = readGenerationVariableSeed(f.metadata(), f.read("a"), 0, true);
  expect(alternateSeed.values.chat.count).toBe("0");
  const alternate = prepareNativeSwipeVariablesWithDb(f.db, "user", "chat", "a", 1, alternateSeed)!;
  f.select("a", 1); write("a", alternate, "1");
  expect(f.count()).toBe("1");
  expect(f.read("a").variableStateBySwipe.map((record: any) => record.before.values.chat.count)).toEqual(["0", "0"]);
  f.append("b", 1);
  const next = prepareNativeSwipeVariablesWithDb(f.db, "user", "chat", "b", 0)!;
  write("b", next, "2");
  const record = f.read("b").variableStateBySwipe[0];
  expect(record.before.values.chat.count).toBe("1");
  expect(record.values.chat.count).toBe("2");
  const continued = prepareNativeSwipeVariablesWithDb(f.db, "user", "chat", "b", 0)!;
  expect(continued).toBe(next); write("b", continued, "3");
  expect(f.read("b").variableStateBySwipe[0].before.values.chat.count).toBe("1");
});

test("initial tracking preserves external changes made after assembly captured its baseline", () => {
  const f = fixture(); f.append("a", 0);
  const seed = readVariableStateSeed(f.metadata());
  f.merge({ chat_variables: { count: "7" } });
  const id = prepareNativeSwipeVariablesWithDb(f.db, "user", "chat", "a", 0, seed)!;
  mutateChatWithDb(f.db, { action: "merge", userId: "user", id: "chat", partial: {},
    variableSource: { messageId: "a", stateId: id, values: { chat: { count: "1" } } } });
  expect(f.count()).toBe("7");
  expect(f.read("a").variableStateBySwipe[0].values.chat.count).toBe("1");
});

test("message extra writes preserve current checkpoints and remove only the deleted slot", () => {
  const f = fixture(); f.append("a", 0); f.install("a", ["1", "10"]);
  const stale = f.read("a");
  const current = f.read("a"); current.variableStateBySwipe[1].values.chat.count = "20";
  f.db.run("UPDATE messages SET extra=? WHERE id='a'", [JSON.stringify(current)]);
  f.db.query(`UPDATE messages SET extra=${preserveSwipeVariablesSql(stale, 2)} WHERE id='a'`).run(JSON.stringify({ ...stale, other: true }));
  expect(f.read("a").variableStateBySwipe[1].values.chat.count).toBe("20");
  expect(f.read("a").other).toBe(true);
  f.db.query(`UPDATE messages SET extra=${preserveSwipeVariablesSql(stale, 1, 0)} WHERE id='a'`).run(JSON.stringify(stale));
  expect(f.read("a").variableStateBySwipe).toEqual([current.variableStateBySwipe[1]]);
  expect(preserveSwipeVariablesSql({}, 2)).toBe("?");
});

test("sibling native swipes share ownership for newly introduced variables", () => {
  const f = fixture(); f.append("a", 0); f.install("a", ["1", "10"]);
  f.db.run("UPDATE messages SET swipes='[\"A\",\"B\",\"native A\",\"native B\"]' WHERE id='a'");
  for (const [index, value] of [[2, "first"], [3, "second"]] as const) {
    if (index === 3) f.merge({ chat_variables: { ...f.metadata().chat_variables, unrelated: "edit" } });
    const seed = readVariableStateSeed(f.metadata())!;
    const id = prepareNativeSwipeVariablesWithDb(f.db, "user", "chat", "a", index, seed)!;
    mutateChatWithDb(f.db, { action: "merge", userId: "user", id: "chat", partial: {},
      variableSource: { messageId: "a", stateId: id, values: { chat: { introduced: value } } } });
  }
  for (const [index, value] of [[2, "first"], [3, "second"], [0, undefined], [3, "second"], [2, "first"]] as const) {
    f.select("a", index); expect(f.metadata().chat_variables.introduced).toBe(value);
  }
});

test("copies remap the variable owner when a later assistant reply is untracked", () => {
  const f = fixture(); f.append("a", 0); f.install("a", ["1", "10"]); f.append("b", 1, ["manual"]);
  f.db.run("UPDATE messages SET id='copied-a' WHERE id='a'");
  remapSwipeVariableOwnerWithDb(f.db, "user", "chat");
  expect(f.metadata()._swipe_variable_state.messageId).toBe("copied-a");
  reconcileSwipeVariablesWithDb(f.db, "user", "chat");
  expect(f.count()).toBe("1");
  f.db.run("DELETE FROM messages WHERE id='b'");
  reconcileSwipeVariablesWithDb(f.db, "user", "chat");
  f.select("copied-a", 1); expect(f.count()).toBe("10");
});

test("deleting a tracked reply across an untracked reply retains the surviving checkpoint", () => {
  const f = fixture(); f.append("a", 0); f.install("a", ["1", "10"]);
  f.append("b", 1, ["manual"]); f.append("c", 2); f.install("c", ["2", "20"]);
  f.db.run("DELETE FROM messages WHERE id='c'");
  reconcileSwipeVariablesWithDb(f.db, "user", "chat");
  expect(f.count()).toBe("1");
  expect(f.metadata()._swipe_variable_state.messageId).toBe("a");
});
