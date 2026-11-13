import { describe, expect, test } from "bun:test";
import type { PromptBlock, PromptVariableDef } from "../types/preset";
import { activationPatternForValidation, createActivationInputSnapshot, resolveActivationFindPattern } from "./regex-activation-inputs";

describe("bounded activation find inputs", () => {
  test("escapes names and chat values, preserving numbered and named captures", () => {
    const inputs = createActivationInputSnapshot({ characterName: "A.*(B)[x]", userName: "User+$", chatVariables: { mode: "combat|peace" } });
    const pattern = resolveActivationFindPattern("^{{char}}/{{user}}:(?<mode>{{getchatvar::mode}})(!)$", inputs);
    for (const flags of ["", "u", "v"]) {
      const regex = new RegExp(pattern, flags);
      const match = regex.exec("A.*(B)[x]/User+$:combat|peace!")!;
      expect(match.groups?.mode).toBe("combat|peace");
      expect(match.slice(1)).toEqual(["combat|peace", "!"]);
      expect(regex.test("AxB/User:combat!")).toBe(false);
    }
  });

  test("values are nonrecursive single atoms, including unicode, backslashes, and adjacent backreferences", () => {
    const inputs = createActivationInputSnapshot({ chatVariables: { value: "ab", digit: "1", literal: "{{setchatvar::x::boom}}\\😀\n" } });
    expect(new RegExp(resolveActivationFindPattern("^{{getchatvar::value}}+$", inputs)).test("abab")).toBe(true);
    expect(new RegExp(resolveActivationFindPattern("^(a)\\1{{getchatvar::digit}}$", inputs)).test("aa1")).toBe(true);
    expect(new RegExp(resolveActivationFindPattern("^{{getchatvar::literal}}$", inputs), "u").test("{{setchatvar::x::boom}}\\😀\n")).toBe(true);
    expect(inputs.chatVariables?.has("x")).toBe(false);
  });

  test("rejects unsupported, nested, dynamic, malformed, and class inputs", () => {
    for (const pattern of ["{{getvar::x}}", "{{var::x}}", "{{setchatvar::x::boom}}", "{{random::a::b}}", "{{getchatvar::{{char}}}}",
      "{{getchatvar}}", "{{getchatvar::}}", "{{user::extra}}", "{{char", "[{{char}}]", "\\{{char}}", "{{presetvar::block}}"] ) {
      expect(() => resolveActivationFindPattern(pattern)).toThrow();
    }
    expect(resolveActivationFindPattern("\\{\\{char\\}\\}")).toBe("\\{\\{char\\}\\}");
  });

  test("fails closed on missing, empty, non-scalar, or oversized values; keeps zero and false", () => {
    for (const value of [undefined, null, "", "   ", {}, [], NaN, Infinity, "a".repeat(1025)]) {
      expect(() => resolveActivationFindPattern("{{getchatvar::key}}|fallback", { chatVariables: new Map([["key", value]]) })).toThrow();
    }
    for (const value of [0, false]) {
      expect(new RegExp(resolveActivationFindPattern("^{{getchatvar::key}}$", { chatVariables: new Map([["key", value]]) })).test(String(value))).toBe(true);
    }
    expect(() => resolveActivationFindPattern("{{char}}".repeat(33), { char: "x" })).toThrow("32 inputs");
    expect(() => resolveActivationFindPattern("x".repeat(10001))).toThrow("10000");
    expect(() => resolveActivationFindPattern("{{char}}".repeat(32), { char: "x".repeat(1024) })).toThrow("100000");
  });

  test("resolves typed defaults and profile overrides from explicitly identified closed blocks", () => {
    const defs: PromptVariableDef[] = [
      { id: "choice", name: "mode", label: "Mode", type: "select", defaultValue: "a", options: [{ id: "a", label: "A", value: "combat" }, { id: "b", label: "B", value: "peace.*" }] },
      { id: "switch", name: "enabled", label: "Enabled", type: "switch", defaultValue: 0 },
      { id: "number", name: "count", label: "Count", type: "number", defaultValue: 1, min: 0, max: 5 },
      { id: "multi", name: "tags", label: "Tags", type: "multiselect", defaultValue: ["b", "a"], separator: "/", options: [{ id: "a", label: "A", value: "first" }, { id: "b", label: "B", value: "last" }] },
    ];
    const block = { id: "closed", enabled: false, content: "{{setchatvar::x::boom}}", variables: defs } as PromptBlock;
    const preset = { prompt_order: [block], metadata: { promptVariables: { closed: { mode: "a", count: 10 } } } };
    const snapshot = createActivationInputSnapshot({ preset, profileValues: { closed: { mode: "b" } } });
    const find = "^{{presetvar::closed::choice}}:{{presetvar::closed::switch}}:{{presetvar::closed::number}}:{{presetvar::closed::multi}}$";
    expect(new RegExp(resolveActivationFindPattern(find, snapshot)).test("peace.*:0:5:first/last")).toBe(true);
    expect(activationPatternForValidation(find, [block])).toBe("^(?:x):(?:x):(?:x):(?:x)$");
    expect(() => activationPatternForValidation("{{presetvar::foreign::choice}}", [block])).toThrow("Unknown linked preset variable");
    expect(() => activationPatternForValidation("{{presetvar::closed::mode}}", [block])).toThrow("Unknown linked preset variable");
    preset.metadata.promptVariables.closed.mode = "b";
    expect(snapshot.chatVariables?.has("x")).toBe(false);
    expect(block.enabled).toBe(false);
  });

  test("copies stored inputs once and excludes inherited keys", () => {
    const chatVariables = Object.assign(Object.create({ inherited: "bad" }), { key: "before", __proto__: "ignored" });
    const snapshot = createActivationInputSnapshot({ chatVariables });
    chatVariables.key = "after";
    expect(new RegExp(resolveActivationFindPattern("^{{getchatvar::key}}$", snapshot)).test("before")).toBe(true);
    expect(() => resolveActivationFindPattern("{{getchatvar::inherited}}", snapshot)).toThrow("Missing");
    expect(() => resolveActivationFindPattern("{{getchatvar::__proto__}}", snapshot)).toThrow("Missing");
  });

  test("targeted snapshots ignore unrelated schemas and malformed legacy definitions fail closed", () => {
    const preset = { prompt_order: [{ id: "closed", variables: [
      { id: "wanted", name: "mode", type: "text", defaultValue: "combat" },
      { id: "broken", name: "bad", type: "unknown" },
    ] }] as unknown as PromptBlock[], metadata: {} };
    const snapshot = createActivationInputSnapshot({ preset, patterns: ["{{presetvar::closed::wanted}}"] });
    expect(snapshot.presetVariables?.get("closed")?.size).toBe(1);
    expect(resolveActivationFindPattern("{{presetvar::closed::wanted}}", snapshot)).toContain("\\u0063");
    const broken = createActivationInputSnapshot({ preset, patterns: ["{{presetvar::closed::broken}}"] });
    expect(() => resolveActivationFindPattern("{{presetvar::closed::broken}}", broken)).toThrow("Missing");
    expect(createActivationInputSnapshot({ preset, patterns: [] }).presetVariables?.size).toBe(0);
  });
});
