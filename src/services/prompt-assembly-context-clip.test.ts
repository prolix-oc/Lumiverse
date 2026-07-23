import { describe, expect, test } from "bun:test";

import type { LlmMessage } from "../llm/types";
import { clipToContextBudget, isChatHistoryMessage } from "./prompt-assembly.service";

describe("clipToContextBudget", () => {
  test("surfaces when fixed prompt overhead leaves no room for chat history", async () => {
    const messages: LlmMessage[] = [
      { role: "system", content: "S".repeat(3000) },
      { role: "user", content: "U".repeat(200) },
      { role: "assistant", content: "A".repeat(200) },
    ];

    (messages[1] as any).__chatHistorySource = true;
    (messages[2] as any).__chatHistorySource = true;

    const stats = await clipToContextBudget(messages, null, 1200, 200);

    expect(stats.enabled).toBe(true);
    expect(stats.fixedOverBudget).toBe(true);
    expect(stats.remainingHistoryBudget).toBeLessThan(0);
    expect(stats.messagesDropped).toBe(2);
    expect(stats.chatHistoryTokensAfter).toBe(0);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
    expect(isChatHistoryMessage(messages[0])).toBe(false);
  });

  test("clips only history before a protected context anchor", async () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "A ".repeat(5_000) },
      { role: "assistant", content: "B ".repeat(200) },
      { role: "user", content: "C ".repeat(200) },
    ];

    for (const message of messages) (message as any).__chatHistorySource = true;
    (messages[1] as any).__contextAnchorProtected = true;
    (messages[2] as any).__contextAnchorProtected = true;

    const stats = await clipToContextBudget(messages, null, 1_200, 200);

    expect(stats.anchorActive).toBe(true);
    expect(stats.anchorOverflow).not.toBe(true);
    expect(stats.protectedHistoryTokens).toBeGreaterThan(0);
    expect(stats.remainingBeforeAnchor).toBeGreaterThanOrEqual(0);
    expect(stats.messagesDropped).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages.every((message) => (message as any).__contextAnchorProtected)).toBe(true);
  });

  test("always excludes history before a context anchor, even when it fits", async () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "before anchor" },
      { role: "assistant", content: "anchor" },
      { role: "user", content: "after anchor" },
    ];

    for (const message of messages) (message as any).__chatHistorySource = true;
    (messages[1] as any).__contextAnchorProtected = true;
    (messages[2] as any).__contextAnchorProtected = true;

    const stats = await clipToContextBudget(messages, null, 16_000, 200);

    expect(stats.anchorActive).toBe(true);
    expect(stats.anchorOverflow).not.toBe(true);
    expect(stats.messagesDropped).toBe(1);
    expect(messages.map((message) => message.content)).toEqual(["anchor", "after anchor"]);
  });

  test("drops pre-anchor history without trimming an anchor tail that cannot fit", async () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "A ".repeat(1_000) },
      { role: "assistant", content: "B ".repeat(2_000) },
      { role: "user", content: "C ".repeat(2_000) },
    ];

    for (const message of messages) (message as any).__chatHistorySource = true;
    (messages[1] as any).__contextAnchorProtected = true;
    (messages[2] as any).__contextAnchorProtected = true;

    const stats = await clipToContextBudget(messages, null, 1_200, 200);

    expect(stats.anchorActive).toBe(true);
    expect(stats.anchorOverflow).toBe(true);
    expect(stats.messagesDropped).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages.every((message) => (message as any).__contextAnchorProtected)).toBe(true);
  });

  test("applies a context anchor when automatic context clipping is disabled", async () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "before anchor" },
      { role: "assistant", content: "anchor" },
      { role: "user", content: "after anchor" },
    ];

    for (const message of messages) (message as any).__chatHistorySource = true;
    (messages[1] as any).__contextAnchorProtected = true;
    (messages[2] as any).__contextAnchorProtected = true;

    const stats = await clipToContextBudget(messages, null, null, null);

    expect(stats.enabled).toBe(false);
    expect(stats.anchorActive).toBe(true);
    expect(stats.messagesDropped).toBe(1);
    expect(messages.map((message) => message.content)).toEqual(["anchor", "after anchor"]);
  });
});
