import { describe, test, expect, beforeAll } from "bun:test";
import { evaluate } from "./MacroEvaluator";
import { registry } from "./MacroRegistry";
import { initMacros } from "./index";
import type { MacroEnv } from "./types";

beforeAll(() => initMacros());

function makeEnv(dynamicMacros?: Record<string, string>): MacroEnv {
  return {
    commit: true,
    names: { user: "Alice", char: "Bob", group: "", groupNotMuted: "", notChar: "Alice", charGroupFocused: "", groupOthers: "", groupMemberCount: "0", isGroupChat: "no", isNarrator: "no", groupLastSpeaker: "", groupCardMode: "solo" },
    character: { name: "Bob", description: "", personality: "", scenario: "", persona: "", personaSubjectivePronoun: "", personaObjectivePronoun: "", personaPossessivePronoun: "", personaReflexivePronoun: "", personaPossessivePronounStandalone: "", mesExamples: "", mesExamplesRaw: "", systemPrompt: "", postHistoryInstructions: "", depthPrompt: "", creatorNotes: "", version: "", creator: "", firstMessage: "" },
    chat: { id: "c1", messageCount: 0, lastMessage: "", lastMessageName: "", lastUserMessage: "", lastCharMessage: "", lastMessageId: 0, firstIncludedMessageId: 0, lastSwipeId: 0, currentSwipeId: 0, rejectedSwipe: "" },
    system: { model: "", maxPrompt: 0, maxContext: 0, maxResponse: 0, lastGenerationType: "normal", isMobile: false },
    variables: { local: new Map(), global: new Map(), chat: new Map() },
    dynamicMacros: dynamicMacros || {},
    _dynamicMacrosLower: dynamicMacros ? new Map(Object.entries(dynamicMacros).map(([k, v]) => [k.toLowerCase(), v])) : undefined,
    extra: {},
  };
}

describe("Dynamic macro recursive expansion", () => {
  test("dynamic macro string containing nested macro resolves in one pass", async () => {
    const env = makeEnv({ greeting: "Hello {{user}}" });
    const result = await evaluate("{{greeting}}", env, registry);
    expect(result.text).toBe("Hello Alice");
  });

  test("dynamic macro with chained nested macros resolves inline", async () => {
    const env = makeEnv({ a: "{{user}} and {{char}}", b: "{{a}}" });
    const result = await evaluate("{{b}}", env, registry);
    expect(result.text).toBe("Alice and Bob");
  });

  test("dynamic macro inside registry macro argument expands before handler", async () => {
    const env = makeEnv({ name: "{{user}}" });
    const result = await evaluate("{{upper::{{name}}}}", env, registry);
    expect(result.text).toBe("ALICE");
  });

  test("dynamic macro function returning macro-bearing text gets expanded", async () => {
    const env: MacroEnv = {
      ...makeEnv(),
      dynamicMacros: {
        myFunc: () => "Hi {{user}}",
      },
      _dynamicMacrosLower: new Map([["myfunc", () => "Hi {{user}}"]]),
    };
    const result = await evaluate("{{myFunc}}", env, registry);
    expect(result.text).toBe("Hi Alice");
  });

  test("deep finite dynamic macro chains are not capped at 20 levels", async () => {
    const macros: Record<string, string> = {};
    for (let i = 0; i < 32; i++) {
      macros[`m${i}`] = `{{m${i + 1}}}`;
    }
    macros.m32 = "{{user}}";

    const result = await evaluate("{{m0}}", makeEnv(macros), registry);
    expect(result.text).toBe("Alice");
    expect(result.diagnostics).toEqual([]);
  });

  test("self-recursive dynamic macro expansion is left unresolved with a diagnostic", async () => {
    const result = await evaluate("{{loop}}", makeEnv({ loop: "{{loop}}" }), registry);

    expect(result.text).toBe("{{loop}}");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("Recursive macro expansion detected"),
      }),
    );
  });

  test("macro resolution budget stops runaway expansion", async () => {
    const macros: Record<string, string> = {};
    for (let i = 0; i < 8; i++) {
      macros[`m${i}`] = `{{m${i + 1}}}`;
    }
    macros.m8 = "{{user}}";

    const result = await evaluate("{{m0}}", makeEnv(macros), registry, {
      maxMacroResolutions: 4,
    });

    expect(result.text).toBe("");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "Macro resolution budget exceeded (4)",
      }),
    );
  });

  test("budget halt prevents enclosing and later side-effect macros", async () => {
    const env = makeEnv({ m0: "{{m1}}", m1: "{{user}}" });

    await evaluate(
      "{{setvar::x::{{m0}}}}{{setvar::after::yes}}",
      env,
      registry,
      { maxMacroResolutions: 3 },
    );

    expect(env.variables.local.has("x")).toBe(false);
    expect(env.variables.local.has("after")).toBe(false);
  });
});
