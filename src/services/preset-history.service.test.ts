import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { buildEnv, cloneEnv, evaluate, initMacros, registry } from "../macros";
import { makeAssistantCharacter } from "../types/character";
import { presetHistoryDependency } from "../types/preset-history";
import { presetHistoryDependencyValue, resolvePresetHistory } from "./preset-history.service";

initMacros();
beforeEach(() => {
  closeDatabase(); initDatabase(":memory:");
  getDb().exec(`CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE messages (id TEXT, chat_id TEXT, index_in_chat INTEGER, is_user INTEGER, content TEXT, swipe_id INTEGER, extra TEXT);
    CREATE TABLE presets (id TEXT PRIMARY KEY, user_id TEXT, name TEXT);
    INSERT INTO chats VALUES ('chat', 'owner');
    INSERT INTO presets VALUES ('id-only', 'owner', 'Current name'), ('foreign', 'other', 'Private name');`);
});
afterEach(closeDatabase);
function seed(id: string, extra: unknown, index = 0) {
  getDb().query("INSERT INTO messages VALUES (?, 'chat', ?, 0, 'Reply', 0, ?)").run(id, index, JSON.stringify(extra));
}
function environment(owner = "owner") {
  return buildEnv({ character: makeAssistantCharacter(), persona: null,
    chat: { id: "chat", character_id: null, name: "", metadata: {}, created_at: 0, updated_at: 0 },
    userId: owner, messages: [], deferPresetHistory: true, generationType: "normal", commit: false });
}
test("loads a lightweight snapshot once and batches owner-scoped ID-only names", async () => {
  seed("older", { generationMetrics: { presetId: "deleted", presetName: "Historical name" } });
  seed("id-only", { spindle_metadata: { preset_contexts: [{ preset_id: "id-only" }] } }, 1);
  seed("foreign", { spindle_metadata: { preset_contexts: [{ preset_id: "foreign" }] } }, 2);
  const env = environment();
  const spy = spyOn(getDb(), "query");
  try {
    expect((await evaluate("{{char}}", env, registry)).text).toBe("Assistant");
    expect(spy).not.toHaveBeenCalled();
    expect(resolvePresetHistory(env)).toEqual(["Current name", "Historical name"]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(resolvePresetHistory(cloneEnv(env))).toEqual(["Current name", "Historical name"]);
    expect(spy).toHaveBeenCalledTimes(2);
  } finally { spy.mockRestore(); }
  expect(resolvePresetHistory(environment("other"))).toEqual([]);
});
test("canonical selected attribution wins over stale projections and explicit no-preset blocks fallback", () => {
  seed("canonical", { generationMetrics: { presetId: "wrong", presetName: "Wrong" },
    generationMetricsBySwipe: [{ presetId: "deleted", presetName: "Selected" }, { presetId: "wrong", presetName: "Inactive" }] });
  seed("no-preset", { promptActivation: { preset_id: null }, generationMetrics: { presetId: "old", presetName: "Stale" } }, 1);
  seed("new-attribution", { promptActivation: { preset_id: "id-only", complete: true }, generationMetrics: { presetId: "old", presetName: "Old" } }, 2);
  expect(resolvePresetHistory(environment())).toEqual(["Current name", "Selected"]);
});
test("tokens include empty reads and names but ignore unrelated timings", () => {
  const dependency = presetHistoryDependency("chat");
  expect(presetHistoryDependencyValue(environment(), dependency)).toBe("[]");
  seed("new", { generationMetrics: { presetId: "a", presetName: "A", tps: 1 } });
  const token = presetHistoryDependencyValue(environment(), dependency);
  expect(token).toBe('["A"]');
  getDb().query("UPDATE messages SET extra = json_set(extra, '$.generationMetrics.tps', 99)").run();
  expect(presetHistoryDependencyValue(environment(), dependency)).toBe(token);
  getDb().query("UPDATE messages SET extra = json_set(extra, '$.generationMetrics.presetName', 'B')").run();
  expect(presetHistoryDependencyValue(environment(), dependency)).toBe('["B"]');
});
test("projected eligibility matches loaded messages for whitespace and invalid selected slots", () => {
  seed("valid", { generationMetrics: { presetName: "Valid" } });
  seed("blank", { generationMetrics: { presetName: "Blank" } }, 1);
  seed("invalid-index", { generationMetrics: { presetName: "Invalid index" } }, 2);
  getDb().query("UPDATE messages SET content = ? WHERE id = 'blank'").run("\t\n\u00a0\ufeff");
  getDb().query("UPDATE messages SET swipe_id = 0.5 WHERE id = 'invalid-index'").run();
  expect(resolvePresetHistory(environment())).toEqual(["Valid"]);
});
