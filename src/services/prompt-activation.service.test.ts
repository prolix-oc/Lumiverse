import { describe, expect, test } from "bun:test";
import type { PromptBlock } from "../types/preset";
import type { RegexPromptActivation, RegexScript } from "../types/regex-script";
import { applyPromptActivations, makePromptActivationSource, promptActivationSource } from "./prompt-activation.service";
import { matchPromptActivation, validatePromptActivation } from "../utils/regex-prompt-activation";
import { createActivationInputSnapshot } from "../utils/regex-activation-inputs";

function block(id: string, extra: Partial<PromptBlock> = {}): PromptBlock {
  return { id, name: id, content: id, enabled: true, role: "system", position: "pre_history", depth: 0,
    marker: null, isLocked: false, color: null, injectionTrigger: [], group: null, ...extra };
}
function config(extra: Partial<RegexPromptActivation> = {}): RegexPromptActivation {
  return { source: "user_input", lifetime: "latest", mappings: [
    { capture: "0", value: "combat", block_ids: ["rules", "format"], enabled: true },
  ], ...extra };
}
function script(activation = config(), extra: Partial<RegexScript> = {}): RegexScript {
  return { id: "regex-1", user_id: "user", name: "Combat", script_id: "", find_regex: "\\bcombat\\b", flags: "gi",
    replace_string: "", actions: [], placement: ["ai_output"], target: ["display"], scope: "global", scope_id: null,
    disabled: false, min_depth: null, max_depth: null, trim_strings: [], run_on_edit: false, substitute_macros: "none",
    sort_order: 0, description: "", folder: "", pack_id: null, preset_id: "preset", character_id: null,
    owner_extension_identifier: null, metadata: { prompt_activation: activation }, created_at: 0, updated_at: 0, ...extra };
}
function message(content: string, is_user = true, id = "message", extra: Record<string, any> = {}) {
  return { id, content, is_user, extra };
}

describe("prompt activation", () => {
  test("any listed keyword enables or disables the mapped block group", async () => {
    const rule = script(config({ lifetime: "chat", mappings: [
      { capture: "0", value: ["combat", "fight", "battle"], block_ids: ["rules", "format"], enabled: true },
      { capture: "0", value: ["peace", "calm"], block_ids: ["rules", "format"], enabled: false },
    ] }), { find_regex: "\\b(combat|fight|battle|peace|calm)\\b" });
    for (const keyword of ["combat", "FIGHT", "battle"]) {
      const blocks = [block("rules"), block("format")];
      const result = await applyPromptActivations(blocks, [rule], [message(keyword)], "preset");
      expect(result.errors).toEqual([]);
      expect(blocks.every((block) => block.enabled)).toBe(true);
      await applyPromptActivations(blocks, [rule], [message(keyword), message("calm")], "preset");
      expect(blocks.every((block) => !block.enabled)).toBe(true);
    }
  });

  test("list values match exact named/numbered captures once and still obey case and terminal boundaries", async () => {
    const activation = config({ source: "ai_output", mappings: [
      { capture: "mode", value: ["combat", "fight", " FIGHT "], block_ids: ["rules"], enabled: true },
      { capture: "1", value: ["fight"], block_ids: ["format"], enabled: true },
    ] });
    const pattern = { find_regex: "<mode>(?<mode>[^<]+)</mode>", flags: "gi" };
    expect(await matchPromptActivation(pattern, activation, "<mode> FIGHT </mode>\n")).toEqual([
      { mapping_index: 0, value: "FIGHT", index: 0 }, { mapping_index: 1, value: "FIGHT", index: 0 },
    ]);
    for (const content of ["<mode>fighting</mode>", "<mode>fight</mode> more text", "<mode>unknown</mode>"]) {
      expect(await matchPromptActivation(pattern, activation, content)).toEqual([]);
    }
    const lowercaseOnly = config({ mappings: [{ capture: "0", value: ["combat", "fight"], block_ids: ["rules"], enabled: true }] });
    expect(await matchPromptActivation({ find_regex: "FIGHT", flags: "g" }, lowercaseOnly, "FIGHT")).toEqual([]);
  });

  test("legacy comma-containing strings remain literal and array entries can contain commas", async () => {
    const pattern = { find_regex: "(?<phrase>.+)", flags: "g" };
    for (const value of ["hello, world", ["hello, world", "greetings"]]) {
      const activation = config({ mappings: [{ capture: "phrase", value, block_ids: ["rules"], enabled: true }] });
      expect(await matchPromptActivation(pattern, activation, "hello, world")).toHaveLength(1);
      expect(await matchPromptActivation(pattern, activation, "hello")).toEqual([]);
    }
  });

  test("value lists are bounded and reject empty or malformed entries", () => {
    const withValue = (value: unknown) => ({ ...config(), mappings: [{ ...config().mappings[0], value }] });
    for (const value of [[], [""], ["combat", " "], ["combat", 1], [["combat"]], [null], { value: "combat" }, Array(65).fill("combat"), ["x".repeat(1001)]]) {
      expect(validatePromptActivation(withValue(value))).toBeString();
    }
    for (const value of ["combat", ["combat", "fight"], Array(64).fill("x".repeat(1000))]) {
      expect(validatePromptActivation(withValue(value))).toBeNull();
    }
  });

  test("bounded inputs gate user words and completed assistant captures using the same snapshot", async () => {
    const inputs = createActivationInputSnapshot({ chatVariables: { desired_mode: "combat" } });
    const rule = script(config({ mappings: [{ capture: "mode", value: "combat", block_ids: ["rules"], enabled: true }] }),
      { find_regex: "(?<mode>{{getchatvar::desired_mode}})" });
    const blocks = [block("rules")];
    await applyPromptActivations(blocks, [rule], [message("Enter combat")], "preset", undefined, inputs);
    expect(blocks[0].enabled).toBe(true);
    rule.metadata.prompt_activation.source = "ai_output";
    rule.find_regex = "<mode>(?<mode>{{getchatvar::desired_mode}})</mode>";
    await applyPromptActivations(blocks, [rule], [message("Scene <mode>combat</mode>\n", false)], "preset", undefined, inputs);
    expect(blocks[0].enabled).toBe(true);
    await applyPromptActivations(blocks, [rule], [message("<mode>combat</mode> more", false)], "preset", undefined, inputs);
    expect(blocks[0].enabled).toBe(false);
  });

  test("missing inputs close gates and report once, including empty history; history uses current inputs", async () => {
    const blocks = [block("rules")];
    const rule = script(config({ lifetime: "chat" }), { find_regex: "{{getchatvar::mode}}" });
    for (const history of [[], [message("combat"), message("combat")]]) {
      const result = await applyPromptActivations(blocks, [rule], history, "preset");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Missing or empty");
      expect(blocks[0].enabled).toBe(false);
    }
    await applyPromptActivations(blocks, [rule], [message("combat")], "preset", undefined,
      createActivationInputSnapshot({ chatVariables: { mode: "combat" } }));
    expect(blocks[0].enabled).toBe(true);
    await applyPromptActivations(blocks, [rule], [message("combat")], "preset", undefined,
      createActivationInputSnapshot({ chatVariables: { mode: "peace" } }));
    expect(blocks[0].enabled).toBe(false);
  });

  test("keywords activate several blocks while non-matches remain closed despite profile defaults", async () => {
    const blocks = [block("rules"), block("format"), block("always")];
    const result = await applyPromptActivations(blocks, [script()], [message("Prepare for COMBAT.")], "preset");
    expect(blocks.map((block) => block.enabled)).toEqual([true, true, true]);
    expect(result.states).toHaveLength(2);
    expect(result.states[0]).toMatchObject({ value: "COMBAT", message_id: "message" });
    await applyPromptActivations(blocks, [script()], [message("A noncombatant passes by.")], "preset");
    expect(blocks.map((block) => block.enabled)).toEqual([false, false, true]);
  });

  test("maps separate named and numbered captures in a complete assistant suffix", async () => {
    const rule = script(config({ source: "ai_output", mappings: [
      { capture: "mode", value: "combat", block_ids: ["rules"], enabled: true },
      { capture: "2", value: "brief", block_ids: ["format"], enabled: true },
    ] }), { find_regex: "<state>(?<mode>[^|<]+)\\|([^<]+)</state>" });
    const blocks = [block("rules"), block("format")];
    await applyPromptActivations(blocks, [rule], [message("Scene.\n<state> Combat |brief</state>\n", false)], "preset");
    expect(blocks.every((block) => block.enabled)).toBe(true);
    for (const content of ["<state>combat|brief</state>\nMore prose", "<state>combat|brief", "<state>unknown|unknown</state>"]) {
      await applyPromptActivations(blocks, [rule], [message(content, false)], "preset");
      expect(blocks.every((block) => !block.enabled)).toBe(true);
    }
  });

  test("an m flag or multiple matches cannot treat an earlier capture as the message end", async () => {
    const rule = script(config({ source: "ai_output" }), { find_regex: "combat$", flags: "gm" });
    const blocks = [block("rules")];
    await applyPromptActivations(blocks, [rule], [message("combat\nordinary ending", false)], "preset");
    expect(blocks[0].enabled).toBe(false);
  });

  test("latest resets on a non-matching source message; chat replays explicit on/off changes", async () => {
    const history = [message("combat", true, "first"), message("Scene", false, "reply"), message("Continue", true, "second")];
    const blocks = [block("rules")];
    await applyPromptActivations(blocks, [script()], history, "preset");
    expect(blocks[0].enabled).toBe(false);
    const rule = script(config({ lifetime: "chat", mappings: [
      ...config().mappings, { capture: "0", value: "peace", block_ids: ["rules", "format"], enabled: false },
    ] }), { find_regex: "\\b(combat|peace)\\b" });
    await applyPromptActivations(blocks, [rule], history, "preset");
    expect(blocks[0].enabled).toBe(true);
    await applyPromptActivations(blocks, [rule], [...history, message("peace")], "preset");
    expect(blocks[0].enabled).toBe(false);
    // Rewinding / deleting the activating turn does not leave a persisted toggle.
    await applyPromptActivations(blocks, [rule], [message("Continue")], "preset");
    expect(blocks[0].enabled).toBe(false);
  });

  test("source, visibility, depth, and preset boundaries are enforced", async () => {
    const blocks = [block("rules")];
    await applyPromptActivations(blocks, [script()], [message("combat", false)], "preset");
    expect(blocks[0].enabled).toBe(false);
    await applyPromptActivations(blocks, [script()], [message("combat", true, "hidden", { hidden: true })], "preset");
    expect(blocks[0].enabled).toBe(false);
    await applyPromptActivations(blocks, [script(config(), { max_depth: 0 })], [message("combat"), message("Reply", false)], "preset");
    expect(blocks[0].enabled).toBe(false);
    for (const rule of [script(config(), { preset_id: null }), script(config(), { preset_id: "other" }), script(config(), { disabled: true })]) {
      const untouched = [block("rules")];
      expect((await applyPromptActivations(untouched, [rule], [], "preset")).states).toEqual([]);
      expect(untouched[0].enabled).toBe(true);
    }
  });

  test("category IDs address their contents and radio selection disables siblings", async () => {
    const blocks = [block("category", { marker: "category", categoryMode: "checkbox" }), block("a"), block("b"), block("next", { marker: "category" }), block("outside")];
    const rule = script(config({ mappings: [{ capture: "0", value: "combat", block_ids: ["category"], enabled: true }] }));
    await applyPromptActivations(blocks, [rule], [], "preset");
    expect(blocks.map((block) => block.enabled)).toEqual([false, false, false, true, true]);
    await applyPromptActivations(blocks, [rule], [message("combat")], "preset");
    expect(blocks.every((block) => block.enabled)).toBe(true);
    const radio = [block("radio", { marker: "category", categoryMode: "radio" }), block("a"), block("b")];
    const selectB = script(config({ mappings: [{ capture: "0", value: "combat", block_ids: ["b"], enabled: true }] }));
    await applyPromptActivations(radio, [selectB], [message("combat")], "preset");
    expect(radio.map((block) => block.enabled)).toEqual([true, false, true]);
    const blanket = script(config({ mappings: [{ capture: "0", value: "combat", block_ids: ["radio"], enabled: true }] }));
    await applyPromptActivations(radio, [blanket], [message("combat")], "preset");
    expect(radio.map((block) => block.enabled)).toEqual([true, false, true]);
  });

  test("later matches and mapping rows deterministically win conflicts", async () => {
    const blocks = [block("rules")];
    const rule = script(config({ mappings: [
      { capture: "0", value: "combat", block_ids: ["rules"], enabled: true },
      { capture: "0", value: "peace", block_ids: ["rules"], enabled: false },
    ] }), { find_regex: "combat|peace" });
    await applyPromptActivations(blocks, [rule], [message("combat, peace")], "preset");
    expect(blocks[0].enabled).toBe(false);
    await applyPromptActivations(blocks, [rule], [message("peace, combat")], "preset");
    expect(blocks[0].enabled).toBe(true);
  });

  test("uses source preserved before response cleanup, and invalidates it on edits", async () => {
    const source = "Scene\n<state>combat</state>";
    const saved = message("Scene", false, "reply", { promptActivation: makePromptActivationSource("Scene", "preset", true, source) });
    const blocks = [block("rules")];
    const rule = script(config({ source: "ai_output", mappings: [{ capture: "1", value: "combat", block_ids: ["rules"], enabled: true }] }), { find_regex: "<state>([^<]+)</state>" });
    await applyPromptActivations(blocks, [rule], [saved], "preset");
    expect(blocks[0].enabled).toBe(true);
    expect(promptActivationSource(saved, "another-preset")).toBeNull();
    await applyPromptActivations(blocks, [rule], [{ ...saved, content: "Edited scene" }], "preset");
    expect(blocks[0].enabled).toBe(false);
  });

  test("stopped output never activates even when it contains a complete marker", async () => {
    const content = "combat";
    const saved = message(content, false, "stopped", { promptActivation: makePromptActivationSource(content, "preset", false) });
    const blocks = [block("rules")];
    await applyPromptActivations(blocks, [script(config({ source: "ai_output" }))], [saved], "preset");
    expect(blocks[0].enabled).toBe(false);
  });

  test("unknown optional groups do not match; values obey the case flag", async () => {
    const rule = { find_regex: "(?<mode>combat)(?:-(brief))?", flags: "g" };
    const activation = config({ mappings: [
      { capture: "mode", value: "COMBAT", block_ids: ["rules"], enabled: true },
      { capture: "2", value: "brief", block_ids: ["format"], enabled: true },
    ] });
    expect(await matchPromptActivation(rule, activation, "combat")).toEqual([]);
    expect(await matchPromptActivation({ ...rule, flags: "gi" }, activation, "combat")).toHaveLength(1);
  });

  test("bounded regex failures leave mapped blocks closed and report diagnostics", async () => {
    const blocks = [block("rules")];
    const rule = script(config(), { find_regex: ".", flags: "g" });
    const result = await applyPromptActivations(blocks, [rule], [message("x".repeat(1001))], "preset");
    expect(result.errors[0]).toContain("match limit");
    expect(blocks[0].enabled).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(applyPromptActivations(blocks, [script()], [message("combat")], "preset", controller.signal)).rejects.toThrow();
  });
});
