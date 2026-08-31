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

function makeRegexScript(presetId: string | null): RegexScript {
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
    owner_extension_identifier: null,
    validation_error_code: null,
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
});
