import { describe, expect, test } from "bun:test";

import type { LlmMessage } from "../llm/types";
import { AgentSealRegistry } from "./agent-seals.service";
import {
  clipToContextBudget,
  isChatHistoryMessage,
  selectAgentToolChatCorpora,
} from "./prompt-assembly.service";

describe("clipToContextBudget", () => {
  test("anchors the tool snapshot without changing prompt prefix semantics", () => {
    const messages = [
      { id: "before-1", index_in_chat: 0 },
      { id: "before-2", index_in_chat: 1 },
      { id: "anchor", index_in_chat: 2 },
      { id: "after", index_in_chat: 3 },
    ] as any[];

    const withoutLimit = selectAgentToolChatCorpora(messages, 2, {
      agentRuntime: true,
      promptBlockCount: 1,
      messageLimitEnabled: false,
    });
    expect(withoutLimit.promptMessages.map((message) => message.id)).toEqual([
      "before-1",
      "before-2",
      "anchor",
      "after",
    ]);
    expect(withoutLimit.snapshotMessages.map((message) => message.id)).toEqual([
      "anchor",
      "after",
    ]);

    const withLimit = selectAgentToolChatCorpora(messages, 2, {
      agentRuntime: true,
      promptBlockCount: 1,
      messageLimitEnabled: true,
      messageLimitCount: 3,
    });
    expect(withLimit.promptMessages.map((message) => message.id)).toEqual([
      "before-2",
      "anchor",
      "after",
    ]);
    expect(withLimit.snapshotMessages.map((message) => message.id)).toEqual([
      "anchor",
      "after",
    ]);
  });

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

  test("adopts an opaque Council fallback before the mixed agent final fit", async () => {
    const registry = new AgentSealRegistry();
    const seal = registry.createDirectSeal({
      producerLabel: "child",
      status: "succeeded",
      content: "child output",
    });
    const messages: LlmMessage[] = [
      { role: "system", content: "agent guidance ".repeat(80) },
      { role: "user", content: seal },
      { role: "assistant", content: "history ".repeat(80) },
    ];
    Reflect.set(messages[2]!, "__chatHistorySource", true);
    registry.captureBeforePromptTransforms(messages);
    const fallback = {
      role: "system" as const,
      content: "Council fallback ".repeat(80),
    };
    registry.insertTrustedSystemMessage(
      messages,
      Math.max(0, messages.length - 4),
      fallback,
    );
    expect(() => registry.validateAfterTransforms(messages)).not.toThrow();
    expect(() =>
      registry.insertTrustedSystemMessage(messages, 0, {
        role: "system",
        content: "second fallback",
      }),
    ).toThrow();

    registry.retireClippedSeals(messages);
    registry.restore(messages);

    const baseline = messages
      .filter((message) => message !== fallback)
      .map((message) => ({ ...message }));
    const baselineHistory = baseline.find((message) =>
      String(message.content).includes("history"),
    );
    if (baselineHistory) Reflect.set(baselineHistory, "__chatHistorySource", true);
    const baselineStats = await clipToContextBudget(
      baseline,
      null,
      1_200,
      200,
    );
    const stats = await clipToContextBudget(messages, null, 1_200, 200);
    expect(stats.fixedTokens).toBeGreaterThan(baselineStats.fixedTokens);
    expect(
      messages.some(
        (message) =>
          typeof message.content === "string" &&
          message.content === fallback.content,
      ),
    ).toBe(true);
    expect(stats.fixedOverBudget).not.toBe(true);
    expect(
      messages.some((message) => String(message.content).includes("child output")),
    ).toBe(true);
  });
});
