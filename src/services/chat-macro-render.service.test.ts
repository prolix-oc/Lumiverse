import { describe, expect, test } from "bun:test";
import type { MacroEnv } from "../macros";
import type { Message } from "../types/message";
import { resolveRenderedChatMessages } from "./chat-macro-render.service";

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
      messageCount: 0,
      lastMessage: "",
      lastMessageName: "",
      lastUserMessage: "",
      lastCharMessage: "",
      lastMessageId: -1,
      firstIncludedMessageId: -1,
      lastSwipeId: 0,
      currentSwipeId: 0,
    },
    system: {
      model: "",
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
    extra: {},
  };
}

function makeMessage(id: string, content: string, isUser: boolean): Message {
  return {
    id,
    chat_id: "chat-1",
    index_in_chat: 0,
    is_user: isUser,
    name: isUser ? "User" : "Assistant",
    content,
    send_date: 0,
    swipe_id: 0,
    swipes: [content],
    swipe_dates: [0],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: 0,
  };
}

describe("resolveRenderedChatMessages", () => {
  test("resolves user message getters after the reply finishes", async () => {
    const env = makeEnv();
    env.variables.local.set("topic", "starlight");

    const messages = [
      makeMessage("user-1", "Value: {{getvar::topic}}", true),
      makeMessage("assistant-1", "Plain reply", false),
    ];

    const result = await resolveRenderedChatMessages({
      messages,
      messageIds: ["user-1", "assistant-1"],
      macroEnvSeed: env,
    });

    expect(result.resolvedById.get("user-1")).toBe("Value: starlight");
    expect(result.resolvedById.get("assistant-1")).toBe("Plain reply");
  });

  test("strips setter macros while preserving chat-scoped side effects", async () => {
    const messages = [
      makeMessage("user-1", "{{setchatvar::mood::calm}}", true),
      makeMessage("assistant-1", "Mood: {{getchatvar::mood}}", false),
    ];

    const result = await resolveRenderedChatMessages({
      messages,
      messageIds: ["user-1", "assistant-1"],
      macroEnvSeed: makeEnv(),
    });

    expect(result.resolvedById.get("user-1")).toBe("");
    expect(result.resolvedById.get("assistant-1")).toBe("Mood: calm");
    expect(result.chatVariables).toEqual({ mood: "calm" });
  });
});
