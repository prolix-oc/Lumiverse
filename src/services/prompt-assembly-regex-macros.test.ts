import { beforeAll, describe, expect, test } from "bun:test";
import type { LlmMessage } from "../llm/types";
import { initMacros, type MacroEnv } from "../macros";
import {
  isChatHistoryMessage,
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
      groupLastSpeaker: "",
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
});
