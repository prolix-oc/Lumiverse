import { describe, test, expect, beforeAll } from "bun:test";
import { evaluate } from "../macros/MacroEvaluator";
import { registry } from "../macros/MacroRegistry";
import { initMacros } from "../macros";
import type { MacroEnv } from "../macros/types";
import type { PromptVariableDef } from "../types/preset";
import { coercePromptVariable } from "./prompt-assembly.service";

// ---------------------------------------------------------------------------
// Minimal env factory — only the fields {{var}} touches matter here.
// ---------------------------------------------------------------------------

function makeEnv(overrides: {
  promptVariables?: Record<string, string | number>;
  promptVariableDefaults?: Record<string, string | number>;
  promptVariableSelections?: Record<string, string[]>;
  localVars?: Record<string, string>;
} = {}): MacroEnv {
  return {
    commit: true,
    names: {
      user: "u", char: "c", group: "", groupNotMuted: "", notChar: "",
      charGroupFocused: "", groupOthers: "", groupMemberCount: "0",
      isGroupChat: "no", isNarrator: "no", groupLastSpeaker: "", groupCardMode: "solo",
    },
    character: {
      name: "", description: "", personality: "", scenario: "", persona: "",
      personaSubjectivePronoun: "", personaObjectivePronoun: "",
      personaPossessivePronoun: "", mesExamples: "", mesExamplesRaw: "",
      systemPrompt: "", postHistoryInstructions: "", depthPrompt: "",
      creatorNotes: "", version: "", creator: "", firstMessage: "",
    },
    chat: {
      id: "x", messageCount: 0, lastMessage: "", lastMessageName: "",
      lastUserMessage: "", lastCharMessage: "", lastMessageId: 0,
      firstIncludedMessageId: 0, lastSwipeId: 0, currentSwipeId: 0,
    },
    system: {
      model: "test", maxPrompt: 0, maxContext: 0, maxResponse: 0,
      lastGenerationType: "normal", isMobile: false,
    },
    variables: {
      local: new Map(Object.entries(overrides.localVars ?? {})),
      global: new Map(),
      chat: new Map(),
    },
    dynamicMacros: {},
    extra: {
      promptVariables: overrides.promptVariables ?? {},
      promptVariableDefaults: overrides.promptVariableDefaults ?? {},
      promptVariableSelections: overrides.promptVariableSelections ?? {},
    },
  };
}

async function ev(template: string, env: MacroEnv): Promise<string> {
  const result = await evaluate(template, env, registry);
  return result.text;
}

beforeAll(() => {
  initMacros();
});

// ---------------------------------------------------------------------------
// coercePromptVariable
// ---------------------------------------------------------------------------

describe("coercePromptVariable — select", () => {
  const def: PromptVariableDef = {
    id: "v1",
    name: "tone",
    label: "Tone",
    type: "select",
    defaultValue: "warm",
    options: [
      { id: "warm", label: "Warm", value: "Respond with warmth." },
      { id: "clinical", label: "Clinical", value: "Respond clinically and tersely." },
    ],
  };

  test("returns the selected option's value", () => {
    const r = coercePromptVariable(def, "clinical");
    expect(r.rendered).toBe("Respond clinically and tersely.");
    expect(r.selectedIds).toEqual(["clinical"]);
  });

  test("falls back to defaultValue's value when override is unknown", () => {
    const r = coercePromptVariable(def, "nonsense");
    expect(r.rendered).toBe("Respond with warmth.");
    expect(r.selectedIds).toEqual(["warm"]);
  });

  test("undefined override resolves to the default option", () => {
    const r = coercePromptVariable(def, undefined);
    expect(r.rendered).toBe("Respond with warmth.");
  });

  test("invalid defaultValue + no override falls back to the first option", () => {
    const broken: PromptVariableDef = { ...def, defaultValue: "ghost" };
    const r = coercePromptVariable(broken, undefined);
    expect(r.rendered).toBe("Respond with warmth.");
    expect(r.selectedIds).toEqual(["warm"]);
  });
});

describe("coercePromptVariable — switch", () => {
  const def: PromptVariableDef = {
    id: "v2",
    name: "verbose",
    label: "Verbose",
    type: "switch",
    defaultValue: 0,
  };

  test("undefined → defaultValue", () => {
    expect(coercePromptVariable(def, undefined).rendered).toBe(0);
    expect(coercePromptVariable({ ...def, defaultValue: 1 }, undefined).rendered).toBe(1);
  });

  test("coerces numbers, booleans, and common strings", () => {
    expect(coercePromptVariable(def, 1).rendered).toBe(1);
    expect(coercePromptVariable(def, 0).rendered).toBe(0);
    expect(coercePromptVariable(def, true).rendered).toBe(1);
    expect(coercePromptVariable(def, false).rendered).toBe(0);
    expect(coercePromptVariable(def, "1").rendered).toBe(1);
    expect(coercePromptVariable(def, "0").rendered).toBe(0);
    expect(coercePromptVariable(def, "true").rendered).toBe(1);
    expect(coercePromptVariable(def, "on").rendered).toBe(1);
    expect(coercePromptVariable(def, "off").rendered).toBe(0);
    expect(coercePromptVariable(def, "garbage").rendered).toBe(0);
  });
});

describe("coercePromptVariable — multiselect", () => {
  const def: PromptVariableDef = {
    id: "v3",
    name: "guides",
    label: "Style guides",
    type: "multiselect",
    defaultValue: ["concise"],
    options: [
      { id: "concise", label: "Concise", value: "Be concise." },
      { id: "polite", label: "Polite", value: "Be polite." },
      { id: "vivid", label: "Vivid", value: "Use vivid imagery." },
    ],
  };

  test("joins selected option values with the default \\n\\n separator", () => {
    const r = coercePromptVariable(def, ["concise", "vivid"]);
    expect(r.rendered).toBe("Be concise.\n\nUse vivid imagery.");
    expect(r.selectedIds).toEqual(["concise", "vivid"]);
  });

  test("preserves option-declaration order, not selection order", () => {
    const r = coercePromptVariable(def, ["vivid", "concise"]);
    expect(r.rendered).toBe("Be concise.\n\nUse vivid imagery.");
    expect(r.selectedIds).toEqual(["concise", "vivid"]);
  });

  test("custom separator wins", () => {
    const custom: PromptVariableDef = { ...def, separator: " | " };
    const r = coercePromptVariable(custom, ["concise", "polite"]);
    expect(r.rendered).toBe("Be concise. | Be polite.");
  });

  test("ignores unknown ids and tolerates empty selection", () => {
    const r = coercePromptVariable(def, ["concise", "ghost"]);
    expect(r.rendered).toBe("Be concise.");
    const empty = coercePromptVariable(def, []);
    expect(empty.rendered).toBe("");
    expect(empty.selectedIds).toEqual([]);
  });

  test("accepts a comma-separated string fallback", () => {
    const r = coercePromptVariable(def, "concise,polite");
    expect(r.rendered).toBe("Be concise.\n\nBe polite.");
  });

  test("undefined override applies the default selection", () => {
    const r = coercePromptVariable(def, undefined);
    expect(r.rendered).toBe("Be concise.");
    expect(r.selectedIds).toEqual(["concise"]);
  });
});

// ---------------------------------------------------------------------------
// {{var::name::ison::keys}} — multiselect AND-query
// ---------------------------------------------------------------------------

describe("{{var::name::ison::keys}} — multiselect AND-query", () => {
  test("returns 'true' when every listed key is selected", async () => {
    const env = makeEnv({
      promptVariableSelections: { guides: ["concise", "polite", "vivid"] },
    });
    expect(await ev("{{var::guides::ison::concise,polite}}", env)).toBe("true");
  });

  test("returns 'false' when any listed key is missing", async () => {
    const env = makeEnv({
      promptVariableSelections: { guides: ["concise"] },
    });
    expect(await ev("{{var::guides::ison::concise,polite}}", env)).toBe("false");
  });

  test("returns 'false' for a variable with no selection record", async () => {
    const env = makeEnv({ promptVariableSelections: {} });
    expect(await ev("{{var::missing::ison::a}}", env)).toBe("false");
  });

  test("empty key list is vacuously true", async () => {
    const env = makeEnv({ promptVariableSelections: { guides: [] } });
    expect(await ev("{{var::guides::ison::}}", env)).toBe("true");
  });

  test("composes with {{#if}} for branching prompts", async () => {
    const env = makeEnv({
      promptVariableSelections: { guides: ["concise", "polite"] },
    });
    const tpl = "{{if::{{var::guides::ison::concise}}}}YES{{else}}NO{{/if}}";
    expect(await ev(tpl, env)).toBe("YES");
  });

  test("plain {{var::name}} still returns the rendered value", async () => {
    const env = makeEnv({
      promptVariables: { tone: "Respond with warmth." },
    });
    expect(await ev("{{var::tone}}", env)).toBe("Respond with warmth.");
  });
});
