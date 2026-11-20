import { describe, expect, test } from "bun:test";
import { evaluate } from "./MacroEvaluator";
import { MacroRegistry, type MacroOrigin } from "./MacroRegistry";
import type { MacroDefinition, MacroEnv } from "./types";

const extensionA: MacroOrigin = { kind: "extension", extensionId: "extension-a" };
const extensionB: MacroOrigin = { kind: "extension", extensionId: "extension-b" };

function definition(name: string, value: string, aliases?: string[]): MacroDefinition {
  return {
    name,
    category: "Test",
    description: "",
    aliases,
    handler: () => value,
  };
}

function env(dynamicMacros: Record<string, string>): MacroEnv {
  return {
    commit: true,
    names: { user: "User", char: "Character", group: "", groupNotMuted: "", notChar: "User", charGroupFocused: "", groupOthers: "", groupMemberCount: "0", isGroupChat: "no", isNarrator: "no", groupLastSpeaker: "", groupCardMode: "solo" },
    character: { name: "Character", description: "", personality: "", scenario: "", persona: "", personaSubjectivePronoun: "", personaObjectivePronoun: "", personaPossessivePronoun: "", personaReflexivePronoun: "", personaPossessivePronounStandalone: "", mesExamples: "", mesExamplesRaw: "", systemPrompt: "", postHistoryInstructions: "", depthPrompt: "", creatorNotes: "", version: "", creator: "", firstMessage: "" },
    chat: { id: "chat", messageCount: 0, lastMessage: "", lastMessageName: "", lastUserMessage: "", lastCharMessage: "", lastMessageId: 0, firstIncludedMessageId: 0, lastSwipeId: 0, currentSwipeId: 0, rejectedSwipe: "" },
    system: { model: "", maxPrompt: 0, maxContext: 0, maxResponse: 0, lastGenerationType: "normal", isMobile: false },
    variables: { local: new Map(), global: new Map(), chat: new Map() },
    dynamicMacros,
    _dynamicMacrosLower: new Map(Object.entries(dynamicMacros).map(([key, value]) => [key.toLowerCase(), value])),
    extra: {},
  };
}

describe("MacroRegistry ownership", () => {
  test("extensions cannot replace or unregister system and foreign macros", () => {
    const registry = new MacroRegistry();
    expect(registry.registerMacro(definition("system", "system"))).toBe(true);
    expect(registry.registerMacro(definition("system", "extension"), extensionA)).toBe(false);
    expect(registry.unregisterMacro("system", extensionA)).toBe(false);

    expect(registry.registerMacro(definition("owned", "a"), extensionA)).toBe(true);
    expect(registry.registerMacro(definition("owned", "b"), extensionB)).toBe(false);
    expect(registry.unregisterMacro("owned", extensionB)).toBe(false);
    expect(registry.getMacro("owned")?.handler({} as never)).toBe("a");
  });

  test("aliases participate in ownership checks and extension cleanup", () => {
    const registry = new MacroRegistry();
    registry.registerMacro(definition("system", "system", ["reserved"]));
    expect(registry.registerMacro(definition("reserved", "extension"), extensionA)).toBe(false);

    registry.registerMacro(definition("owned", "extension", ["owned_alias"]), extensionA);
    registry.unregisterByExtension("extension-a");
    expect(registry.getMacro("owned")).toBeNull();
    expect(registry.getMacro("owned_alias")).toBeNull();
    expect(registry.getMacro("system")).not.toBeNull();
  });

  test("system macros beat dynamic macros while dynamic macros beat extensions", async () => {
    const registry = new MacroRegistry();
    registry.registerMacro(definition("system", "system"));
    registry.registerMacro(definition("preset_value", "extension"), extensionA);

    const result = await evaluate(
      "{{system}}/{{preset_value}}",
      env({ system: "preset", preset_value: "preset" }),
      registry,
    );
    expect(result.text).toBe("system/preset");
  });
});
