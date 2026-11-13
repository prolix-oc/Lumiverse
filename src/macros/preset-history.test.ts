import { describe, expect, test } from "bun:test";
import { buildEnv, cloneEnv, evaluate, initMacros, registry, restoreLiteralBraces } from "./index";
import { makeAssistantCharacter } from "../types/character";
import { capturePresetHistory, MAX_PRESET_HISTORY, presetHistoryDependency, readPresetHistoryEntry } from "../types/preset-history";
import type { Message } from "../types/message";

initMacros();
function message(name: string, extra: Record<string, any> = {}): Message {
  return { id: name, chat_id: "history", index_in_chat: 0, is_user: false, name: "Assistant", content: "Reply",
    swipe_id: 0, swipes: ["Reply"], swipe_dates: [0], extra: { generationMetrics: { presetId: name, presetName: name }, ...extra },
    send_date: 0, created_at: 0, parent_message_id: null, branch_id: null };
}
function env(messages: Message[] = []) {
  return buildEnv({ character: makeAssistantCharacter(), persona: null,
    chat: { id: "history", character_id: null, name: "", metadata: {}, created_at: 0, updated_at: 0 },
    messages, generationType: "normal", commit: false });
}
const resolve = (source: string, messages: Message[] = []) => evaluate(source, env(messages), registry);

describe("selected preset provenance", () => {
  test("reads only the selected canonical slot, including sparse slots", () => {
    const source = message("stale", { generationMetricsBySwipe: [{ presetId: "a", presetName: "A" }, null, { presetId: "b", presetName: "B" }] });
    expect(readPresetHistoryEntry(source)).toEqual({ id: "a", name: "A" });
    source.swipe_id = 1;
    expect(readPresetHistoryEntry(source)).toBeNull();
    source.swipe_id = 2;
    expect(readPresetHistoryEntry(source)).toEqual({ id: "b", name: "B" });
  });
  test("contexts and native attribution never borrow a conflicting metrics name", () => {
    expect(readPresetHistoryEntry(message("old", { spindle_metadata: { preset_contexts: [{ preset_id: "context" }] } }))).toEqual({ id: "context" });
    expect(readPresetHistoryEntry(message("old", { promptActivation: { preset_id: "new" } }))).toEqual({ id: "new" });
    expect(readPresetHistoryEntry(message("old", { promptActivation: { preset_id: null } }))).toBeNull();
    expect(readPresetHistoryEntry(message("old", { promptActivation: { preset_id: "" } }))).toBeNull();
    expect(readPresetHistoryEntry(message("old", { spindle_metadata: { preset_contexts: { 0: { preset_id: "bad" } } } })))
      .toEqual({ id: "old", name: "old" });
  });
  test("ignores ineligible responses and invalid swipe indexes", () => {
    for (const extra of [{ hidden: true }, { _loom_inject: true }, { greeting: true }, { spindle_role: "system" }]) {
      expect(readPresetHistoryEntry(message("ignored", extra))).toBeNull();
    }
    for (const swipe_id of [-1, 0.5, NaN, Infinity]) expect(readPresetHistoryEntry({ ...message("bad"), swipe_id })).toBeNull();
    expect(readPresetHistoryEntry({ ...message("user"), is_user: true })).toBeNull();
    expect(readPresetHistoryEntry({ ...message("pending"), content: " " })).toBeNull();
  });
  test("restores original target attribution without reintroducing its blank prompt text", () => {
    const blank = { ...message("target"), content: "" };
    expect(capturePresetHistory([message("older"), blank], { messageId: blank.id, entry: { id: "original", name: "Original" } }).candidates)
      .toEqual([{ id: "original", name: "Original" }, { id: "older", name: "older" }]);
  });
});

describe("preset history macros", () => {
  test("returns newest selected names, preserves repeats, and resolves count/separator arguments", async () => {
    const messages = [message("A"), message("A"), message("B")];
    expect((await resolve("{{lastPreset}}", messages)).text).toBe("B");
    expect((await resolve("{{lastPresets::3}}", messages)).text).toBe("B\nA\nA");
    expect((await resolve("{{setvar::n::2}}{{lastPresets::{{getvar::n}}::, }}", messages)).text).toBe("B, A");
    expect((await resolve("{{upper::{{lastPreset}}}}", [message("Mixed")])).text).toBe("MIXED");
  });
  test("tracks positive and negative context dependencies without mutating variables", async () => {
    for (const messages of [[], [message("A")]]) {
      const current = env(messages);
      const result = await evaluate("{{lastPreset}}", current, registry);
      expect(result.cacheable).toBe(true);
      expect([...result.touchedVars]).toEqual([presetHistoryDependency("history")]);
      expect(current.variables.chat.size).toBe(0);
      expect(current._chatVarsDirty).toBeUndefined();
    }
  });
  test("enforces count and output limits", async () => {
    for (const count of ["-1", "1.5", "nope"]) {
      const result = await resolve(`{{lastPresets::${count}}}`, [message("A")]);
      expect(result.text).toBe(""); expect(result.diagnostics).toHaveLength(1);
    }
    expect((await resolve("{{lastPresets::0}}", [message("A")])).text).toBe("");
    const many = Array.from({ length: 150 }, (_, i) => message(String(i)));
    const result = await resolve("{{lastPresets::1000::,}}", many);
    expect(result.text.split(",")).toHaveLength(MAX_PRESET_HISTORY);
    expect(result.diagnostics).toHaveLength(1);
    const oversized = await resolve("{{lastPreset}}", [message("a".repeat(65_537))]);
    expect(oversized.text).toBe(""); expect(oversized.diagnostics).toHaveLength(1);
  });
  test("keeps macro-looking names and backslashes literal across assembly passes", async () => {
    const current = env([message("Preset \\{literal\\} {{setchatvar::bad::1}}")]);
    const first = await evaluate("{{lastPreset}}", current, registry, { deferLiteralBraceRestore: true });
    const second = await evaluate(first.text, current, registry, { deferLiteralBraceRestore: true });
    expect(restoreLiteralBraces(second.text)).toBe("Preset \\{literal\\} {{setchatvar::bad::1}}");
    expect(current.variables.chat.has("bad")).toBe(false);
  });
  test("shares an immutable result between clones and transfers data across a worker boundary", async () => {
    const source = message("A");
    const current = env([source]);
    source.extra.generationMetrics.presetName = "Later edit";
    await evaluate("{{lastPreset}}", current, registry);
    const clone = cloneEnv(current);
    expect(clone.extra.presetHistory).toBe(current.extra.presetHistory);
    expect((await evaluate("{{lastPreset}}", structuredClone(clone), registry)).text).toBe("A");
    expect((await resolve("{{lastPreset}}", [message("B")])).text).toBe("B");
  });
});
