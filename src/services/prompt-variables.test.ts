import { describe, test, expect, beforeAll } from "bun:test";
import { evaluate } from "../macros/MacroEvaluator";
import { registry } from "../macros/MacroRegistry";
import { initMacros } from "../macros";
import type { MacroEnv } from "../macros/types";
import type { Preset, PromptBlock, PromptVariableDef } from "../types/preset";
import { withPromptBlockContext } from "../macros/MacroEnv";
import { coercePromptVariable, resolvePromptBlockPlacements, resolvePromptVariables, resolveCognitionPresetVariables, collectResolvedPromptVariableValues } from "./prompt-assembly.service";
import { evaluateCognitionPredicate } from "./agent-cognition.service";
import type { CognitionEvaluationContextV1 } from "../types/agent-cognition";

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
      personaPossessivePronoun: "", personaReflexivePronoun: "", personaPossessivePronounStandalone: "", mesExamples: "", mesExamplesRaw: "",
      systemPrompt: "", postHistoryInstructions: "", depthPrompt: "",
      creatorNotes: "", version: "", creator: "", firstMessage: "",
    },
    chat: {
      id: "x", messageCount: 0, lastMessage: "", lastMessageName: "",
      lastUserMessage: "", lastCharMessage: "", lastMessageId: 0,
      firstIncludedMessageId: 0, lastSwipeId: 0, currentSwipeId: 0, rejectedSwipe: "",
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

describe("resolvePromptBlockPlacements", () => {
  const selector: PromptVariableDef = {
    id: "placement-target",
    name: "adherence_target",
    label: "Adherence target",
    type: "select",
    defaultValue: "baseline",
    options: [
      { id: "baseline", label: "Balanced", value: "Balanced" },
      { id: "frontier", label: "Frontier", value: "Frontier" },
    ],
  };
  const block: PromptBlock = {
    id: "placement-block",
    name: "Placement-aware prompt",
    content: "{{promptBlockRole}}/{{promptBlockPosition}}/{{promptBlockDepth}}",
    role: "system",
    enabled: true,
    position: "pre_history",
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
    variables: [selector],
    placementBinding: {
      variableId: selector.id,
      options: {
        baseline: { role: "system", position: "pre_history", depth: 0 },
        frontier: { role: "user", position: "in_history", depth: 3 },
      },
    },
  };

  test("projects the saved select option into an effective placement without mutating the stored block", () => {
    const resolved = resolvePromptBlockPlacements([block], {
      metadata: { promptVariables: { "placement-block": { adherence_target: "frontier" } } },
    });

    expect(resolved[0]).toMatchObject({ role: "user", position: "in_history", depth: 3 });
    expect(block).toMatchObject({ role: "system", position: "pre_history", depth: 0 });
  });

  test("uses the select default and leaves the block unchanged when its chosen option has no placement mapping", () => {
    const defaultResolved = resolvePromptBlockPlacements([block], { metadata: { promptVariables: {} } });
    expect(defaultResolved[0]).toMatchObject({ role: "system", position: "pre_history", depth: 0 });

    const unmapped = {
      ...block,
      placementBinding: { variableId: selector.id, options: {} },
    };
    const unchanged = resolvePromptBlockPlacements([unmapped], {
      metadata: { promptVariables: { "placement-block": { adherence_target: "frontier" } } },
    });
    expect(unchanged[0]).toBe(unmapped);
  });

  test("uses a profile selection over the preset's shared placement selection", () => {
    const resolved = resolvePromptBlockPlacements(
      [block],
      { metadata: { promptVariables: { "placement-block": { adherence_target: "baseline" } } } },
      { "placement-block": { adherence_target: "frontier" } },
    );

    expect(resolved[0]).toMatchObject({ role: "user", position: "in_history", depth: 3 });
  });

  test("inherits the preset placement when an active profile has no saved placement value", () => {
    const resolved = resolvePromptBlockPlacements(
      [block],
      { metadata: { promptVariables: { "placement-block": { adherence_target: "frontier" } } } },
      {},
    );

    expect(resolved[0]).toMatchObject({ role: "user", position: "in_history", depth: 3 });
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

describe("resolvePromptVariables", () => {
  test("seeds {{var::}} values from enabled prompt block definitions and preset metadata", async () => {
    const env = makeEnv();
    const blocks: PromptBlock[] = [
      {
        id: "block-1",
        name: "Style",
        content: "{{var::tone}}",
        role: "system",
        enabled: true,
        position: "pre_history",
        depth: 0,
        marker: null,
        isLocked: false,
        color: null,
        injectionTrigger: [],
        group: null,
        variables: [
          {
            id: "var-1",
            name: "tone",
            label: "Tone",
            type: "text",
            defaultValue: "default tone",
          },
        ],
      },
    ];
    const preset = {
      id: "preset-1",
      name: "Preset",
      provider: "test",
      engine: "test",
      parameters: {},
      prompt_order: blocks,
      prompts: {},
      metadata: { promptVariables: { "block-1": { tone: "configured tone" } } },
      created_at: 0,
      updated_at: 0,
    } satisfies Preset;

    resolvePromptVariables(env, blocks, preset);

    expect(await ev("{{var::tone}} / {{getvar::tone}}", env)).toBe("configured tone / configured tone");
  });

  test("does not seed variables from disabled prompt blocks", async () => {
    const env = makeEnv();
    const blocks: PromptBlock[] = [
      {
        id: "block-1",
        name: "Disabled",
        content: "{{var::tone}}",
        role: "system",
        enabled: false,
        position: "pre_history",
        depth: 0,
        marker: null,
        isLocked: false,
        color: null,
        injectionTrigger: [],
        group: null,
        variables: [
          {
            id: "var-1",
            name: "tone",
            label: "Tone",
            type: "text",
            defaultValue: "default tone",
          },
        ],
      },
    ];
    const preset = {
      id: "preset-1",
      name: "Preset",
      provider: "test",
      engine: "test",
      parameters: {},
      prompt_order: blocks,
      prompts: {},
      metadata: { promptVariables: { "block-1": { tone: "configured tone" } } },
      created_at: 0,
      updated_at: 0,
    } satisfies Preset;

    resolvePromptVariables(env, blocks, preset);

    expect(await ev("{{var::tone}}", env)).toBe("");
  });

  test("overlays a profile snapshot over shared preset values", async () => {
    const env = makeEnv();
    const blocks: PromptBlock[] = [{
      id: "block-1", name: "Style", content: "{{var::tone}}", role: "system",
      enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false,
      color: null, injectionTrigger: [], group: null,
      variables: [
        { id: "var-1", name: "tone", label: "Tone", type: "text", defaultValue: "default tone" },
        { id: "var-2", name: "length", label: "Length", type: "text", defaultValue: "default length" },
      ],
    }];
    const preset = {
      id: "preset-1", name: "Preset", provider: "test", engine: "test", parameters: {},
      prompt_order: blocks, prompts: {},
      metadata: { promptVariables: { "block-1": { tone: "outside chat", length: "preset length" } } },
      created_at: 0, updated_at: 0,
    } satisfies Preset;

    resolvePromptVariables(env, blocks, preset, { "block-1": { tone: "chat-specific" } });

    expect(await ev("{{var::tone}} / {{var::length}}", env)).toBe("chat-specific / preset length");
  });

  test("inherits preset values when an active profile has no saved overrides", async () => {
    const env = makeEnv();
    const blocks: PromptBlock[] = [{
      id: "block-1", name: "Style", content: "{{var::tone}}", role: "system",
      enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false,
      color: null, injectionTrigger: [], group: null,
      variables: [{ id: "var-1", name: "tone", label: "Tone", type: "text", defaultValue: "default tone" }],
    }];
    const preset = {
      id: "preset-1", name: "Preset", provider: "test", engine: "test", parameters: {},
      prompt_order: blocks, prompts: {},
      metadata: { promptVariables: { "block-1": { tone: "outside chat" } } },
      created_at: 0, updated_at: 0,
    } satisfies Preset;

    resolvePromptVariables(env, blocks, preset, {});

    expect(await ev("{{var::tone}}", env)).toBe("outside chat");
  });

  test("keeps same-named prompt variables scoped to their defining block", async () => {
    const env = makeEnv();
    const first: PromptBlock = {
      id: "preset-block", name: "Preset block", content: "", role: "system",
      enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false,
      color: null, injectionTrigger: [], group: null,
      variables: [{ id: "preset-tone", name: "tone", label: "Tone", type: "text", defaultValue: "preset default" }],
    };
    const later: PromptBlock = {
      ...first,
      id: "extension-block",
      name: "Later extension block",
      variables: [{ id: "extension-tone", name: "tone", label: "Tone", type: "text", defaultValue: "extension default" }],
    };
    const blocks = [first, later];
    const preset = {
      id: "preset-1", name: "Preset", provider: "test", engine: "test", parameters: {},
      prompt_order: blocks, prompts: {},
      metadata: {
        promptVariables: {
          "preset-block": { tone: "preset instance" },
          "extension-block": { tone: "extension instance" },
        },
      },
      created_at: 0, updated_at: 0,
    } satisfies Preset;

    resolvePromptVariables(env, blocks, preset);

    // The compatibility-wide flat view still has deterministic last-block
    // semantics outside a block render.
    expect(await ev("{{var::tone}}/{{.tone}}", env)).toBe("extension instance/extension instance");

    const firstRendered = await withPromptBlockContext(env, first, () =>
      ev("{{var::tone}}/{{.tone}}", env),
    );
    const laterRendered = await withPromptBlockContext(env, later, () =>
      ev("{{var::tone}}/{{.tone}}", env),
    );

    expect(firstRendered).toBe("preset instance/preset instance");
    expect(laterRendered).toBe("extension instance/extension instance");
    expect(await ev("{{var::tone}}/{{.tone}}", env)).toBe("extension instance/extension instance");
  });

  test("allows block-local setvar writes without leaking them into another block", async () => {
    const env = makeEnv();
    const block: PromptBlock = {
      id: "preset-block", name: "Preset block", content: "", role: "system",
      enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false,
      color: null, injectionTrigger: [], group: null,
      variables: [{ id: "preset-tone", name: "tone", label: "Tone", type: "text", defaultValue: "preset default" }],
    };
    const preset = {
      id: "preset-1", name: "Preset", provider: "test", engine: "test", parameters: {},
      prompt_order: [block], prompts: {},
      metadata: { promptVariables: { "preset-block": { tone: "preset instance" } } },
      created_at: 0, updated_at: 0,
    } satisfies Preset;

    resolvePromptVariables(env, [block], preset);
    const rendered = await withPromptBlockContext(env, block, () =>
      ev("{{setvar::tone::runtime}}{{var::tone}}/{{.tone}}", env),
    );

    expect(rendered).toBe("runtime/runtime");
    expect(await ev("{{var::tone}}/{{.tone}}", env)).toBe("preset instance/preset instance");
  });
});

function switchDef(name: string, defaultValue: 0 | 1): PromptVariableDef {
  return { id: name, name, label: name, type: "switch", defaultValue };
}

function blockWithSwitch(id: string, name: string, defaultValue: 0 | 1, enabled = true): PromptBlock {
  return {
    id,
    name: id,
    content: "",
    role: "system",
    enabled,
    position: "pre_history",
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
    variables: [switchDef(name, defaultValue)],
  };
}

function workContext(presetVariables: Readonly<Record<string, string | number | boolean | readonly string[]>>): CognitionEvaluationContextV1 {
  return {
    generationType: "normal",
    phase: "WORK",
    presetVariables,
    participantFacts: {},
    availableTools: [],
    taskTransitions: {},
  };
}

describe("resolveCognitionPresetVariables", () => {
  const collaborationSkip = {
    kind: "preset_variable" as const,
    name: "fn_collaboration",
    operator: "equals" as const,
    value: 0,
  };
  const requireChildActivation = {
    kind: "all" as const,
    children: [
      { kind: "phase" as const, value: "WORK" as const },
      {
        kind: "preset_variable" as const,
        name: "fn_require_child",
        operator: "equals" as const,
        value: 1,
      },
    ],
  };

  test("flattens block-scoped fn_collaboration=0 so the collaborate skip predicate is true", () => {
    const blocks = [blockWithSwitch("a81dc164-6cfc-5215-b4f5-13c861ce7ab9", "fn_collaboration", 1)];
    const stored = {
      "a81dc164-6cfc-5215-b4f5-13c861ce7ab9": { fn_collaboration: 0 },
    };
    const presetVariables = resolveCognitionPresetVariables(blocks, stored);
    expect(presetVariables).toEqual({ fn_collaboration: 0 });
    expect(evaluateCognitionPredicate(collaborationSkip, workContext(presetVariables))).toBe(true);
  });

  test("does not treat nested metadata.promptVariables as absent fn_* keys", () => {
    const nestedOnly = {
      "a81dc164-6cfc-5215-b4f5-13c861ce7ab9": { fn_collaboration: 0, fn_require_child: 1 },
    };
    expect(Object.keys(nestedOnly).some((key) => key.startsWith("fn_"))).toBe(false);
    const scenario = {
      id: "a81dc164-6cfc-5215-b4f5-13c861ce7ab9",
      name: "Scenario control",
      content: "",
      role: "system" as const,
      enabled: true,
      position: "pre_history" as const,
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
      group: null,
      variables: [switchDef("fn_collaboration", 1), switchDef("fn_require_child", 0)],
    };
    const presetVariables = resolveCognitionPresetVariables([scenario], nestedOnly);
    expect(presetVariables.fn_collaboration).toBe(0);
    expect(presetVariables.fn_require_child).toBe(1);
    expect(evaluateCognitionPredicate(requireChildActivation, workContext(presetVariables))).toBe(true);
  });

  test("last enabled prompt_order block wins on duplicate variable names", () => {
    const first = blockWithSwitch("block-a", "fn_collaboration", 1);
    const later = blockWithSwitch("block-b", "fn_collaboration", 1);
    const stored = {
      "block-a": { fn_collaboration: 0 },
      "block-b": { fn_collaboration: 1 },
    };
    expect(resolveCognitionPresetVariables([first, later], stored)).toEqual({ fn_collaboration: 1 });
    expect(resolveCognitionPresetVariables([later, first], stored)).toEqual({ fn_collaboration: 0 });
  });

  test("skips disabled blocks and ignores nested non-scalar leaves", () => {
    const disabled = blockWithSwitch("disabled-block", "fn_collaboration", 1, false);
    const enabled = blockWithSwitch("enabled-block", "fn_require_child", 0);
    const stored = {
      "disabled-block": { fn_collaboration: 0 },
      "enabled-block": {
        fn_require_child: 1,
        nested: { ignored: true },
        mixed: [1, "x"],
      },
    };
    const presetVariables = resolveCognitionPresetVariables([disabled, enabled], stored);
    expect(presetVariables).toEqual({ fn_require_child: 1 });
    expect(evaluateCognitionPredicate(collaborationSkip, workContext(presetVariables))).toBe(false);
    expect(evaluateCognitionPredicate(requireChildActivation, workContext(presetVariables))).toBe(true);
  });

  test("bound profile overrides fn_require_child and drops a disabled block", () => {
    const collaboration = blockWithSwitch("collab-block", "fn_collaboration", 1);
    const requireChild = blockWithSwitch("child-block", "fn_require_child", 0);
    const stored = {
      "collab-block": { fn_collaboration: 0 },
      "child-block": { fn_require_child: 0 },
    };
    const profile = {
      "child-block": { fn_require_child: 1 },
    };
    const blocks = [{ ...collaboration, enabled: false }, requireChild];
    const presetVariables = resolveCognitionPresetVariables(blocks, stored, profile);
    expect(presetVariables).toEqual({ fn_require_child: 1 });
    expect(evaluateCognitionPredicate(collaborationSkip, workContext(presetVariables))).toBe(false);
    expect(evaluateCognitionPredicate(requireChildActivation, workContext(presetVariables))).toBe(true);
  });

  test("profile overlay inherits missing keys and loses to a later enabled block", () => {
    const first = {
      ...blockWithSwitch("block-a", "fn_require_child", 0),
      variables: [switchDef("fn_require_child", 0), switchDef("fn_collaboration", 1)],
    };
    const later = blockWithSwitch("block-b", "fn_require_child", 0);
    const stored = {
      "block-a": { fn_require_child: 0, fn_collaboration: 0 },
      "block-b": { fn_require_child: 0 },
    };
    const profile = {
      "block-a": { fn_require_child: 1 },
    };
    expect(resolveCognitionPresetVariables([first], stored, profile)).toEqual({
      fn_require_child: 1,
      fn_collaboration: 0,
    });
    expect(resolveCognitionPresetVariables([first, later], stored, profile)).toEqual({
      fn_require_child: 0,
      fn_collaboration: 0,
    });
  });

  test("one collect path yields identical cognition and strict {{var}} values", () => {
    const collaboration = blockWithSwitch("collab-block", "fn_collaboration", 1);
    const requireChild = blockWithSwitch("child-block", "fn_require_child", 0);
    const stored = {
      "collab-block": { fn_collaboration: 0 },
      "child-block": { fn_require_child: 0 },
    };
    const profile = {
      "child-block": { fn_require_child: 1 },
    };
    const blocks = [{ ...collaboration, enabled: false }, requireChild];
    const collected = collectResolvedPromptVariableValues(blocks, stored, profile);
    const cognition = resolveCognitionPresetVariables(blocks, stored, profile);
    expect(cognition).toEqual(collected.values);
    expect(collected.values).toEqual({ fn_require_child: 1 });
    expect(collected.byBlock["child-block"]?.fn_require_child).toBe(1);
    expect(collected.byBlock["collab-block"]).toBeUndefined();
    expect(collected.defaults["fn_require_child"]).toBe(0);
    expect(evaluateCognitionPredicate(requireChildActivation, workContext(cognition))).toBe(true);
    expect(evaluateCognitionPredicate(collaborationSkip, workContext(cognition))).toBe(false);
  });
});
