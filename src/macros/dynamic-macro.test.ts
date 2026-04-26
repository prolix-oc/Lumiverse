import { describe, test, expect, beforeAll } from "bun:test";
import { evaluate } from "./MacroEvaluator";
import { registry } from "./MacroRegistry";
import { initMacros } from "./index";
import type { MacroEnv } from "./types";

beforeAll(() => initMacros());

function makeEnv(dynamicMacros?: Record<string, string>): MacroEnv {
  return {
    commit: true,
    names: { user: "Alice", char: "Bob", group: "", groupNotMuted: "", notChar: "Alice", charGroupFocused: "", groupOthers: "", groupMemberCount: "0", isGroupChat: "no", groupLastSpeaker: "" },
    character: { name: "Bob", description: "", personality: "", scenario: "", persona: "", personaSubjectivePronoun: "", personaObjectivePronoun: "", personaPossessivePronoun: "", mesExamples: "", mesExamplesRaw: "", systemPrompt: "", postHistoryInstructions: "", depthPrompt: "", creatorNotes: "", version: "", creator: "", firstMessage: "" },
    chat: { id: "c1", messageCount: 0, lastMessage: "", lastMessageName: "", lastUserMessage: "", lastCharMessage: "", lastMessageId: 0, firstIncludedMessageId: 0, lastSwipeId: 0, currentSwipeId: 0 },
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
});
