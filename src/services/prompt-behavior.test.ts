import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PROMPT_BEHAVIOR,
  isGenuinelyNewChat,
  resolveNewChatPromptConfig,
  resolvePromptBehavior,
  shouldInjectEmptySendNudge,
  shouldInjectGroupNudge,
} from "./prompt-behavior";
import type { Message } from "../types/message";

function message(overrides: Partial<Message>): Message {
  return {
    id: crypto.randomUUID(),
    chat_id: "chat-1",
    index_in_chat: 0,
    is_user: false,
    name: "Character",
    content: "Reply",
    send_date: 0,
    swipe_id: 0,
    swipes: ["Reply"],
    swipe_dates: [0],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: 0,
    ...overrides,
  };
}

describe("Loom prompt behavior", () => {
  test("resolves partial and malformed persisted behavior without overriding explicit opt-outs", () => {
    const resolved = resolvePromptBehavior({
      emptySendNudge: "",
      groupNudge: "[Prompt only {{char}}.]",
      continueNudge: 42,
    });

    expect(resolved.emptySendNudge).toBe("");
    expect(resolved.groupNudge).toBe("[Prompt only {{char}}.]");
    expect(resolved.continueNudge).toBe(
      DEFAULT_PROMPT_BEHAVIOR.continueNudge,
    );
    expect(resolved.newChatPrompt).toBe(DEFAULT_PROMPT_BEHAVIOR.newChatPrompt);
    expect(resolvePromptBehavior(null)).toEqual(DEFAULT_PROMPT_BEHAVIOR);
    expect(
      resolvePromptBehavior({ newChatPrompt: "[Legacy start]" })
        .newGroupChatPrompt,
    ).toBe("[Legacy start]");
  });

  test("recognizes a new chat only until the first non-greeting assistant reply", () => {
    expect(
      isGenuinelyNewChat([
        message({ extra: { greeting: true } }),
        message({ is_user: true, content: "Hello" }),
        message({ extra: { hidden: true } }),
      ]),
    ).toBe(true);
    expect(isGenuinelyNewChat([message({})])).toBe(false);
  });

  test("selects the configured group separator independently of the solo separator", () => {
    const behavior = resolvePromptBehavior({
      newChatPrompt: "[Solo start]",
      newGroupChatPrompt: "[Group start]",
    });

    expect(resolveNewChatPromptConfig(behavior, false)).toEqual({
      prompt: "[Solo start]",
      label: "New Chat Prompt",
    });
    expect(resolveNewChatPromptConfig(behavior, true)).toEqual({
      prompt: "[Group start]",
      label: "New Group Chat Prompt",
    });
  });

  test("injects an empty-send nudge for an assistant-ending chat regardless of user-role preset blocks", () => {
    const assistantEnding = [message({})];

    expect(
      shouldInjectEmptySendNudge({
        generationType: "normal",
        messages: assistantEnding,
      }),
    ).toBe(true);
    expect(
      shouldInjectEmptySendNudge({
        generationType: "normal",
        targetCharacterId: "group-member-1",
        messages: assistantEnding,
      }),
    ).toBe(false);
    expect(
      shouldInjectEmptySendNudge({
        generationType: "continue",
        messages: assistantEnding,
      }),
    ).toBe(false);
    expect(
      shouldInjectEmptySendNudge({
        generationType: "normal",
        messages: [message({ is_user: true, content: "A real user turn" })],
      }),
    ).toBe(false);
  });

  test("uses group nudges only for a concrete targeted group member", () => {
    expect(
      shouldInjectGroupNudge({
        isGroupChat: true,
        groupCharacterIds: ["group-member-1"],
        targetCharacterId: "group-member-1",
      }),
    ).toBe(true);
    expect(
      shouldInjectGroupNudge({
        isGroupChat: false,
        groupCharacterIds: ["direct-chat-character"],
        targetCharacterId: "direct-chat-character",
      }),
    ).toBe(false);
    expect(
      shouldInjectGroupNudge({
        isGroupChat: true,
        groupCharacterIds: ["group-member-1"],
        targetCharacterId: "not-a-member",
      }),
    ).toBe(false);
    expect(
      shouldInjectGroupNudge({
        isGroupChat: true,
        groupCharacterIds: ["group-member-1"],
        targetCharacterId: "",
      }),
    ).toBe(
      false,
    );
    expect(
      shouldInjectGroupNudge({
        isGroupChat: true,
        groupCharacterIds: ["group-member-1"],
      }),
    ).toBe(false);
  });
});
