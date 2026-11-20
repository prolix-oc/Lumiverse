import { beforeAll, describe, expect, test } from "bun:test";
import type { LlmMessage } from "../llm/types";
import {
  evaluate,
  initMacros,
  registry,
  restoreLiteralBraces,
  type MacroEnv,
} from "../macros";
import {
  isChatHistoryMessage,
  isWorldInfoEntryMessage,
  resolvePromptMacrosAfterRegexPass,
} from "./prompt-assembly.service";

function makeEnv(): MacroEnv {
  return {
    commit: true,
    names: {
      user: "User",
      char: "Assistant",
      group: "",
      groupNotMuted: "",
      notChar: "User",
      charGroupFocused: "",
      groupOthers: "",
      groupMemberCount: "0",
      isGroupChat: "no",
      isNarrator: "no",
      groupLastSpeaker: "",
      groupCardMode: "solo",
    },
    character: {
      name: "Assistant",
      description: "",
      personality: "",
      scenario: "",
      persona: "",
      personaSubjectivePronoun: "",
      personaObjectivePronoun: "",
      personaPossessivePronoun: "",
      personaReflexivePronoun: "",
      personaPossessivePronounStandalone: "",
      mesExamples: "",
      mesExamplesRaw: "",
      systemPrompt: "",
      postHistoryInstructions: "",
      depthPrompt: "",
      creatorNotes: "",
      version: "",
      creator: "",
      firstMessage: "",
    },
    chat: {
      id: "chat-1",
      messageCount: 2,
      lastMessage: "",
      lastMessageName: "",
      lastUserMessage: "",
      lastCharMessage: "",
      lastMessageId: 1,
      firstIncludedMessageId: 0,
      lastSwipeId: 0,
      currentSwipeId: 0,
      rejectedSwipe: "",
    },
    system: {
      model: "test",
      maxPrompt: 0,
      maxContext: 0,
      maxResponse: 0,
      lastGenerationType: "normal",
      isMobile: false,
    },
    variables: {
      local: new Map(),
      global: new Map(),
      chat: new Map(),
    },
    dynamicMacros: {},
    extra: { messages: [] },
  };
}

function markChatHistory(message: LlmMessage): LlmMessage {
  (message as any).__chatHistorySource = true;
  return message;
}

function markWorldInfo(message: LlmMessage): LlmMessage {
  (message as any).__worldInfoSource = true;
  return message;
}

describe("resolvePromptMacrosAfterRegexPass", () => {
  beforeAll(() => {
    initMacros();
  });

  test("executes and strips regex-injected setters in prompt chat history", async () => {
    const env = makeEnv();
    const messages: LlmMessage[] = [
      markChatHistory({
        role: "user",
        content: "Preface {{setvar::scene::lantern-lit alley}}",
      }),
      markChatHistory({
        role: "assistant",
        content: "Scene: {{getvar::scene}}",
      }),
    ];

    await resolvePromptMacrosAfterRegexPass(messages, env);

    expect(messages[0].content).toBe("Preface ");
    expect(messages[1].content).toBe("Scene: lantern-lit alley");
    expect(env.variables.local.get("scene")).toBe("lantern-lit alley");
    expect(isChatHistoryMessage(messages[0])).toBe(true);
    expect(isChatHistoryMessage(messages[1])).toBe(true);
  });

  test("preserves world info source markers while resolving prompt macros", async () => {
    const env = makeEnv();
    env.variables.local.set("lore", "the doors answer to moonlight");
    const messages: LlmMessage[] = [
      markWorldInfo({
        role: "system",
        content: "Lore: {{getvar::lore}}",
      }),
    ];

    await resolvePromptMacrosAfterRegexPass(messages, env);

    expect(messages[0].content).toBe("Lore: the doors answer to moonlight");
    expect(isWorldInfoEntryMessage(messages[0])).toBe(true);
    expect(isChatHistoryMessage(messages[0])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// {{#escape}} bodies are shielded while macros run and restored at the end of
// the last macro pass. This is the pass that would otherwise re-expand them.
// ---------------------------------------------------------------------------

describe("resolvePromptMacrosAfterRegexPass + {{#escape}}", () => {
  beforeAll(() => {
    initMacros();
  });

  /** Content as prompt block evaluation leaves it: escaped body shielded. */
  async function escapedBlock(template: string, env: MacroEnv): Promise<string> {
    return (
      await evaluate(template, env, registry, {
        deferLiteralBraceRestore: true,
      })
    ).text;
  }

  test("emits the escaped body literally instead of re-expanding it", async () => {
    const env = makeEnv();
    const content = await escapedBlock("A{{#escape}}{{user}}{{/escape}}B", env);
    const messages: LlmMessage[] = [markChatHistory({ role: "user", content })];

    await resolvePromptMacrosAfterRegexPass(messages, env);

    expect(messages[0].content).toBe("A{{user}}B");
    expect(isChatHistoryMessage(messages[0])).toBe(true);
  });

  test("restores an escaped body that is the whole message", async () => {
    const env = makeEnv();
    const content = await escapedBlock("{{#escape}}{bkspc}{{/escape}}", env);
    const messages: LlmMessage[] = [{ role: "system", content }];

    await resolvePromptMacrosAfterRegexPass(messages, env);

    expect(messages[0].content).toBe("{bkspc}");
  });

  test("still resolves real macros that share the message", async () => {
    const env = makeEnv();
    env.variables.local.set("x", "XVALUE");
    const content =
      (await escapedBlock("{{#escape}}{{getvar::x}}{{/escape}}|{{getvar::x}}", env)) +
      "{{setvar::scene::lantern-lit alley}}";
    const messages: LlmMessage[] = [markChatHistory({ role: "user", content })];

    await resolvePromptMacrosAfterRegexPass(messages, env);

    // The injected setter ran and was consumed; the escaped body stayed literal.
    expect(messages[0].content).toBe("{{getvar::x}}|XVALUE");
    expect(env.variables.local.get("scene")).toBe("lantern-lit alley");
  });

  test("restores escaped bodies inside multimodal text parts", async () => {
    const env = makeEnv();
    const content = await escapedBlock("{{#escape}}{{user}}{{/escape}}", env);
    const imagePart = {
      type: "image_url",
      image_url: { url: "https://example.invalid/a.png" },
    };
    const messages: LlmMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: content }, imagePart],
      } as unknown as LlmMessage,
    ];

    await resolvePromptMacrosAfterRegexPass(messages, env);

    const parts = messages[0].content as any[];
    expect(parts[0].text).toBe("{{user}}");
    // Non-text parts are passed through untouched.
    expect(parts[1]).toEqual(imagePart);
  });

  test("restores escaped bodies inside reasoning content", async () => {
    const env = makeEnv();
    const reasoningContent = await escapedBlock(
      "{{#escape}}{{user}}{{/escape}}",
      env,
    );
    const messages: LlmMessage[] = [
      { role: "assistant", content: "", reasoning_content: reasoningContent },
    ];

    await resolvePromptMacrosAfterRegexPass(messages, env);

    expect(messages[0].reasoning_content).toBe("{{user}}");
  });

  test("leaves unescaped content untouched", async () => {
    const env = makeEnv();
    env.variables.local.set("lore", "moonlit doors");
    const messages: LlmMessage[] = [
      { role: "system", content: "Lore: {{getvar::lore}}" },
    ];

    await resolvePromptMacrosAfterRegexPass(messages, env);

    expect(messages[0].content).toBe("Lore: moonlit doors");
    expect(restoreLiteralBraces(String(messages[0].content))).toBe(
      "Lore: moonlit doors",
    );
  });

  test("preserves literal ETX and EOT characters in prompt content", async () => {
    const env = makeEnv();
    const messages: LlmMessage[] = [
      { role: "user", content: "A\x03B\x04C" },
    ];

    await resolvePromptMacrosAfterRegexPass(messages, env);

    expect(messages[0].content).toBe("A\x03B\x04C");
  });
});

describe("resolvePromptMacrosAfterRegexPass + <json> blocks", () => {
  beforeAll(() => {
    initMacros();
  });

  test("keeps valid blocks verbatim in string and text-part content", async () => {
    const env = makeEnv();
    const block = '<json>{"who": "<user>", "say": " {{user}} "}</json>';
    const messages: LlmMessage[] = [
      markChatHistory({ role: "assistant", content: `{{user}}: ${block}` }),
      { role: "user", content: [{ type: "text", text: `${block} <char>` }] },
    ];

    await resolvePromptMacrosAfterRegexPass(messages, env);

    expect(messages[0].content).toBe(`User: ${block}`);
    expect(isChatHistoryMessage(messages[0])).toBe(true);
    expect(messages[1].content).toEqual([{ type: "text", text: `${block} Assistant` }]);
  });

  test("restores a block one text part captured and a concurrent part read", async () => {
    // Part A captures its block and stays pending until part B, which waits
    // for the capture, has read the variable.
    const gates: Record<string, PromiseWithResolvers<void>> = {
      captured: Promise.withResolvers<void>(),
      read: Promise.withResolvers<void>(),
    };
    registry.registerMacro({
      name: "testJsonSignal",
      category: "Test",
      description: "Opens the named gate",
      handler: (ctx) => {
        gates[ctx.args[0]].resolve();
        return "";
      },
    });
    registry.registerMacro({
      name: "testJsonWait",
      category: "Test",
      description: "Waits until the named gate opens",
      handler: async (ctx) => {
        await gates[ctx.args[0]].promise;
        return "";
      },
    });

    try {
      const env = makeEnv();
      const block = '<json>{"note": "{{user}}"}</json>';
      const messages: LlmMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `{{setchatvar::state}}${block}{{/setchatvar}}{{testJsonSignal::captured}}{{testJsonWait::read}}A`,
            },
            { type: "text", text: "{{testJsonWait::captured}}B={{getchatvar::state}}{{testJsonSignal::read}}" },
          ],
        } as unknown as LlmMessage,
      ];

      await resolvePromptMacrosAfterRegexPass(messages, env);

      expect(messages[0].content).toEqual([
        { type: "text", text: "A" },
        { type: "text", text: `B=${block}` },
      ]);
      expect(env.variables.chat.get("state")).toBe(String.raw`<json>{"note": "\u007b\u007buser\u007d\u007d"}</json>`);
    } finally {
      registry.unregisterMacro("testJsonSignal");
      registry.unregisterMacro("testJsonWait");
    }
  });
});
