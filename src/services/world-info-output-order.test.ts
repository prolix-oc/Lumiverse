import { describe, expect, test } from "bun:test";
import type { WorldBookEntry } from "../types/world-book";
import type { MacroEnv } from "../macros";
import { WorldInfoInterceptorChain } from "../spindle/world-info-interceptor";
import { activateWorldInfo, materializeWorldInfoCache } from "./world-info-activation.service";
import { mergeActivatedWorldInfoEntries, resolveWorldInfoOutlets, buildRuntimeWorldInfoChatPlacements } from "./prompt-assembly.service";
import { orderWorldInfoForOutput } from "./world-info-output-order";

const context = {
  chatId: "chat", characterId: "character", messages: [], chatTurn: 1, chatMetadata: {},
  activationSettings: { globalScanDepth: null, maxRecursionPasses: 0 },
};
const none = new Set<string>();
function entry(id: string, order: number): WorldBookEntry {
  return {
    id, world_book_id: "book", uid: id, key: ["match"], keysecondary: [], content: id,
    comment: id, position: 0, depth: 0, role: null, order_value: order, priority: order,
    selective: false, constant: false, disabled: false, group_name: "", group_override: false,
    group_weight: 1, probability: 100, scan_depth: null, exclude_greeting: false,
    case_sensitive: false, match_whole_words: false, automation_id: null, use_regex: false,
    prevent_recursion: false, exclude_recursion: false, delay_until_recursion: false,
    sticky: 0, cooldown: 0, delay: 0, selective_logic: 0, use_probability: false,
    vectorized: false, vector_index_status: "not_enabled", vector_indexed_at: null,
    vector_index_error: null, outlet_name: "notes", wi_marker: null, wi_marker_side: null,
    revision: 1, extensions: {}, created_at: 0, updated_at: 0,
  };
}

describe("world info output ordering", () => {
  for (const budget of [1, 2, 3]) {
    test(`reorders output after a ${budget}-token budget without changing survivors or stored entries`, async () => {
      const entries = [entry("A", 100), entry("B", 200), entry("C", 300)];
      const chain = new WorldInfoInterceptorChain();
      chain.register({ extensionId: "extension", priority: 0, handler: async ctx => ({
        mutated: ctx.entries.map(row => ({ id: row.id, outputOrder: "insertion" as const })),
      }) });
      const interception = await chain.run(entries, context);
      const settings = { maxTokenBudget: budget, maxActivatedEntries: 0, minPriority: 0, maxRecursionPasses: 0 };
      const activated = activateWorldInfo({
        entries: interception.entries, messages: [{
          id: "message", content: "match", is_user: true, extra: {}, index_in_chat: 1,
        }] as never, chatTurn: 1, wiState: {}, settings,
      });
      const merged = mergeActivatedWorldInfoEntries(activated.activatedEntries, [], settings);
      const selected = merged.activatedEntries.map(row => row.id);
      const output = orderWorldInfoForOutput(merged.activatedEntries, interception.insertionOrderByEntryId, none);
      const expected = ["A", "B", "C"].slice(3 - budget);
      expect(materializeWorldInfoCache(output).before.map(row => row.content)).toEqual(expected);
      expect((await resolveWorldInfoOutlets(output, { extra: {} } as MacroEnv)).notes).toBe(expected.join("\n\n"));
      expect(merged.activatedEntries.map(row => row.id)).toEqual(selected);
      expect(selected).toEqual([...expected].reverse());
      expect(entries.map(row => row.id)).toEqual(["A", "B", "C"]);
      expect(output.every(row => entries.includes(row))).toBe(true);
    });
  }

  test("keeps native and separate extension slots fixed and reverses equal-order ties", () => {
    const entries = [entry("a2", 20), entry("native", 5), entry("b2", 20), entry("a1", 10), entry("b1", 10), entry("tie1", 20), entry("tie2", 20)];
    const groups = new Map([["a2", "a"], ["a1", "a"], ["tie1", "a"], ["tie2", "a"], ["b2", "b"], ["b1", "b"]]);
    const result = orderWorldInfoForOutput(entries, groups, none);
    expect(result.map(row => row.id)).toEqual(["a1", "native", "b1", "tie2", "b2", "tie1", "a2"]);
    expect(result[1]).toBe(entries[1]);
  });

  test("does not copy or access text, including a million-token-sized body", () => {
    const body = "word ".repeat(1_000_000);
    const entries = [entry("B", 2), entry("A", 1)];
    entries[0].content = body;
    Object.defineProperty(entries[1], "content", { get: () => { throw new Error("text was accessed"); } });
    const result = orderWorldInfoForOutput(entries, new Map([["A", "ext"], ["B", "ext"]]), none);
    expect(result[0]).toBe(entries[1]);
    expect(result[1]).toBe(entries[0]);
    expect(result[1].content).toBe(body);
  });

  test("retains the original array without an applicable group and leaves explicit chat placements alone", () => {
    const entries = [entry("B", 2), entry("A", 1)];
    expect(orderWorldInfoForOutput(entries, new Map(), none)).toBe(entries);
    expect(orderWorldInfoForOutput(entries, new Map([["missing", "ext"]]), none)).toBe(entries);
    const groups = new Map([["A", "ext"], ["B", "ext"]]);
    expect(orderWorldInfoForOutput(entries, groups, new Set(["B"]))).toBe(entries);
    const placed = buildRuntimeWorldInfoChatPlacements(entries, new Map(entries.map(row => [row.id, {
      type: "chat_depth" as const, depth: 1, role: "system" as const, direction: "from_start" as const,
    }])));
    expect(placed.map(row => row.id)).toEqual(["A", "B"]);
  });
});
