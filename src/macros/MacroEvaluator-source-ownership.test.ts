import { beforeAll, describe, expect, test } from "bun:test";
import { initMacros, withPromptBlockContext } from "./index";
import { evaluate } from "./MacroEvaluator";
import { registry } from "./MacroRegistry";
import type { MacroEnv } from "./types";
import {
  macroInterceptorChain,
  type MacroInterceptorCtx,
  type MacroInterceptorResult,
} from "../spindle/macro-interceptor";
import { applyRegexScripts } from "../services/regex-scripts.service";
import type { RegexScript } from "../types/regex-script";

beforeAll(() => {
  initMacros();
});

function makeEnv(): MacroEnv {
  return {
    commit: true,
    names: {
      user: "User", char: "Character", group: "", groupNotMuted: "", notChar: "",
      charGroupFocused: "", groupOthers: "", groupMemberCount: "0", isGroupChat: "no",
      isNarrator: "no", groupLastSpeaker: "", groupCardMode: "solo",
    },
    character: {
      name: "Character", description: "", personality: "", scenario: "", persona: "",
      personaSubjectivePronoun: "", personaObjectivePronoun: "",
      personaPossessivePronoun: "", personaReflexivePronoun: "",
      personaPossessivePronounStandalone: "", mesExamples: "", mesExamplesRaw: "",
      systemPrompt: "", postHistoryInstructions: "", depthPrompt: "", creatorNotes: "",
      version: "", creator: "", firstMessage: "",
    },
    chat: {
      id: "chat", messageCount: 0, lastMessage: "", lastMessageName: "",
      lastUserMessage: "", lastCharMessage: "", lastMessageId: -1,
      firstIncludedMessageId: -1, lastSwipeId: 0, currentSwipeId: 0, rejectedSwipe: "",
    },
    system: {
      model: "test", maxPrompt: 0, maxContext: 0, maxResponse: 0,
      lastGenerationType: "normal", isMobile: false,
    },
    variables: {
      local: new Map([["words_target", "850"]]),
      global: new Map(),
      chat: new Map(),
    },
    dynamicMacros: {},
    extra: {
      promptVariables: { words_target: 850, cot_mode: 0 },
      promptVariableDefaults: { words_target: 850, cot_mode: 0 },
      promptVariablesByBlock: {
        "length-target": { words_target: 850 },
        "full-cot": { cot_mode: 0 },
      },
    },
  };
}

function makeRegexScript(
  presetId: string | null,
  ownerExtensionIdentifier: string | null = null,
): RegexScript {
  return {
    id: `regex-${presetId ?? "unowned"}`,
    user_id: "user",
    name: "Macro replacement",
    script_id: "macro-replacement",
    find_regex: "token",
    replace_string: "{{calc::2 + 3}}",
    actions: [],
    flags: "g",
    placement: ["ai_output"],
    scope: "global",
    scope_id: null,
    target: ["response"],
    min_depth: null,
    max_depth: null,
    substitute_macros: "raw",
    trim_strings: [],
    run_on_edit: false,
    disabled: false,
    sort_order: 0,
    description: "",
    folder: "",
    pack_id: null,
    preset_id: presetId,
    character_id: null,
    owner_extension_identifier: ownerExtensionIdentifier,
    metadata: {},
    created_at: 0,
    updated_at: 0,
  };
}

async function withInterceptor<T>(
  handler: (ctx: MacroInterceptorCtx) => MacroInterceptorResult,
  work: () => Promise<T>,
  priority = 100,
): Promise<T> {
  const unregister = macroInterceptorChain.register({
    extensionId: "test-extension-install",
    priority,
    handler: async (ctx) => handler(ctx),
  });
  try {
    return await work();
  } finally {
    unregister();
  }
}

describe("prompt source ownership", () => {
  test("offers character fields without requiring host macro syntax", async () => {
    const env = makeEnv();
    env.character.description = "extension source";

    const text = await withInterceptor((ctx) => (
      ctx.sourceHint === "prompt_source:character.description"
        ? "processed source"
        : undefined
    ), async () => (await evaluate(
      "{{description}}",
      env,
      registry,
      { sourceOwner: "host" },
    )).text);

    expect(text).toBe("processed source");
  });

  test("continues native evaluation after a character transform", async () => {
    const env = makeEnv();
    env.character.description = "extension source";

    const text = await withInterceptor((ctx) => (
      ctx.sourceHint === "prompt_source:character.description"
        ? "{{calc::2 + 3}}"
        : undefined
    ), async () => (await evaluate(
      "{{description}}",
      env,
      registry,
      { sourceOwner: "host" },
    )).text);

    expect(text).toBe("5");
  });

  test("keeps preset variables and macros entirely on the native evaluator", async () => {
    const seen: Array<{
      template: string;
      sourceHint?: string;
      local: Record<string, string>;
    }> = [];
    const env = makeEnv();
    env.character.description = "{{and::true::true}}";

    const text = await withInterceptor((ctx) => {
      seen.push({
        template: ctx.template,
        sourceHint: ctx.sourceHint,
        local: ctx.env.variables.local,
      });
      if (ctx.sourceHint === "prompt_source:character.description") {
        return ctx.template;
      }
      return "0 to 0";
    }, () => withPromptBlockContext(
      env,
      { id: "length-target", role: "system", position: "pre_history", depth: 0 },
      async () => (await evaluate(
        "{{floor::{{calc::{{var::words_target}} / 100}}}} to {{ceil::{{calc::{{var::words_target}} / 75}}}}|{{description}}",
        env,
        registry,
        { phase: "prompt", sourceHint: "prompt_source:preset_block", sourceOwner: "host" },
      )).text,
    ));

    expect(text).toBe("8 to 12|true");
    expect(seen).toEqual([{
      template: "{{and::true::true}}",
      sourceHint: "prompt_source:character.description",
      local: { words_target: "850" },
    }]);
  });

  test("falls back to native expansion when extensions leave a character field unchanged", async () => {
    const env = makeEnv();
    env.character.description = "{{calc::2 + 3}}";

    const text = await withInterceptor(() => undefined, async () =>
      (await evaluate("{{description}}", env, registry, { sourceOwner: "host" })).text,
    );

    expect(text).toBe("5");
  });

  test("routes preset-referenced card fields separately and preserves host evaluation", async () => {
    const env = makeEnv();
    env.character.description = "{{calc::1 + 1}}";
    env.character.personality = "{{var::words_target}}";
    env.character.scenario = "{{calc::2 + 2}}";
    env.character.mesExamples = "{{calc::2 + 3}}";
    env.character.systemPrompt = "{{calc::3 + 3}}";
    env.character.postHistoryInstructions = "{{calc::3 + 4}}";
    const seen: Array<{ sourceHint?: string; wordsTarget?: string }> = [];

    const text = await withInterceptor((ctx) => {
      seen.push({
        sourceHint: ctx.sourceHint,
        wordsTarget: ctx.env.variables.local.words_target,
      });
      return ctx.template;
    }, async () => (await evaluate(
      "{{description}}|{{personality}}|{{scenario}}|{{mesExamples}}|{{system}}|{{charPostHistoryInstructions}}",
      env,
      registry,
      { sourceOwner: "host" },
    )).text);

    expect(text).toBe("2|850|4|5|6|7");
    expect(seen).toEqual([
      { sourceHint: "prompt_source:character.description", wordsTarget: "850" },
      { sourceHint: "prompt_source:character.personality", wordsTarget: "850" },
      { sourceHint: "prompt_source:character.scenario", wordsTarget: "850" },
      { sourceHint: "prompt_source:character.mes_examples", wordsTarget: "850" },
      { sourceHint: "prompt_source:character.system_prompt", wordsTarget: "850" },
      { sourceHint: "prompt_source:character.post_history_instructions", wordsTarget: "850" },
    ]);
  });

  test("keeps preset regex macros native without changing unowned regex behavior", async () => {
    const env = makeEnv();
    const seen: string[] = [];

    await withInterceptor((ctx) => {
      seen.push(ctx.template);
      return "intercepted";
    }, async () => {
      expect(await applyRegexScripts(
        "token",
        [makeRegexScript("preset")],
        "ai_output",
        undefined,
        env,
      )).toBe("5");
      expect(await applyRegexScripts(
        "token",
        [makeRegexScript(null)],
        "ai_output",
        undefined,
        env,
      )).toBe("intercepted");

      const persister = makeRegexScript("preset");
      persister.find_regex = "hp-(\\d+)";
      persister.replace_string = "{{setchatvar::hp::$1}}";
      persister.substitute_macros = "after";
      expect(await applyRegexScripts("hp-42", [persister], "ai_output", undefined, env)).toBe("");
      expect(env.variables.chat.get("hp")).toBe("42");
    });

    expect(seen).toEqual(["{{calc::2 + 3}}"]);
  });

  test("keeps extension-owned preset regex macros interceptable", async () => {
    const env = makeEnv();
    await withInterceptor(() => "intercepted", async () => {
      expect(await applyRegexScripts(
        "token",
        [makeRegexScript("preset", "extension.a")],
        "ai_output",
        undefined,
        env,
      )).toBe("intercepted");
    });
  });
});


describe("owned regex macro evaluation", () => {
  async function withOwner(handler: (ctx: MacroInterceptorCtx) => Promise<MacroInterceptorResult>, work: () => Promise<void>, opts: Record<string, unknown> = {}) {
    const remove = macroInterceptorChain.register({
      extensionId: "owned-install", extensionIdentifier: "owned", handlesOwnedSources: true,
      userId: "user", priority: 100, handler, ...opts,
    } as any);
    try { await work(); } finally { remove(); }
  }

  test("keeps the owner's raw result and variable macros without native evaluation", async () => {
    const env = makeEnv(); env.extra.userId = "user";
    let calls = 0;
    const template = "<user>|{{setvar::weather::Clear}}|{{calc::2+3}}|\\{{literal}}";
    await withOwner(async (ctx) => {
      calls++;
      expect((ctx as any).sourceOwner).toEqual({ extensionIdentifier: "owned" });
      expect(ctx.template).toBe(template);
      return { text: template, touchedVars: ["weather"], volatile: true };
    }, async () => {
      const row = { ...makeRegexScript(null, "owned"), substitute_macros: "after" as const, replace_string: template };
      const out = await applyRegexScripts("token", [row], "ai_output", 0, env);
      expect(out).toBe(template);
      expect(env.variables.local.has("weather")).toBe(false);
      expect(calls).toBe(1);
    });
  });

  test("routes only opted-in owned sources and preserves normal native behavior", async () => {
    const env = makeEnv(); env.extra.userId = "user";
    let ownCalls = 0; let otherCalls = 0;
    const removeOther = macroInterceptorChain.register({ extensionId: "other", priority: 0, handler: async () => { otherCalls++; } });
    try {
      await withOwner(async (ctx) => {
        ownCalls++;
        return (ctx as any).sourceOwner ? { text: "{{calc::3+4}}", touchedVars: ["x"] } : undefined;
      }, async () => {
        const owned = await evaluate("{{calc::2+3}}", env, registry, { sourceOwner: { extensionIdentifier: "owned" } } as any);
        expect(owned.text).toBe("{{calc::3+4}}");
        expect([...owned.touchedVars]).toEqual(["x"]); expect(owned.cacheable).toBe(true);
        expect(otherCalls).toBe(0); expect(ownCalls).toBe(1);
        expect((await evaluate("{{calc::2+3}}", env, registry)).text).toBe("5");
        expect(otherCalls).toBe(1); expect(ownCalls).toBe(2);
        expect((await evaluate("{{calc::2+3}}", env, registry, { sourceOwner: "host" })).text).toBe("5");
        expect(otherCalls).toBe(1); expect(ownCalls).toBe(2);
      });
    } finally { removeOther(); }
  });

  test("requires a valid result from the opted-in owner", async () => {
    const env = makeEnv(); env.extra.userId = "user";
    for (const handler of [async () => undefined, async () => { throw new Error("owner failed"); }]) {
      await withOwner(handler, async () => {
        await expect(evaluate("{{setvar::x::wrong}}", env, registry, { sourceOwner: { extensionIdentifier: "owned" } } as any)).rejects.toThrow();
        expect(env.variables.local.has("x")).toBe(false);
      });
    }
  });

  test("does not opt in existing owners or call another account's handler", async () => {
    const env = makeEnv(); env.extra.userId = "user";
    await withOwner(async () => "{{calc::3+4}}", async () => {
      expect(await applyRegexScripts("token", [makeRegexScript(null, "owned")], "ai_output", 0, env)).toBe("7");
    }, { handlesOwnedSources: false });
    await withOwner(async () => { throw new Error("wrong account"); }, async () => {
      expect(await applyRegexScripts("token", [makeRegexScript(null, "owned")], "ai_output", 0, env)).toBe("5");
    }, { userId: "different" });
  });

  test("preserves empty results and avoids dispatch for plain or empty text", async () => {
    const env = makeEnv(); env.extra.userId = "user"; let calls = 0;
    await withOwner(async () => { calls++; return ""; }, async () => {
      const opts = { sourceOwner: { extensionIdentifier: "owned" } } as any;
      expect((await evaluate("{{calc::2+3}}", env, registry, opts)).text).toBe("");
      expect((await evaluate("plain", env, registry, opts)).text).toBe("plain");
      expect((await evaluate("", env, registry, opts)).text).toBe("");
      expect(calls).toBe(1);
    });
  });
});
