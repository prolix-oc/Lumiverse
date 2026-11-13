import { describe, expect, test } from "bun:test";
import { messageContentProcessorChain } from "./message-content-processor";

describe("message content processor context", () => {
  test("preserves the message author flag through the chain", async () => {
    const seen: boolean[] = [];
    const unregister = messageContentProcessorChain.register({
      extensionId: "test-author-flag",
      priority: 100,
      handler: async (ctx) => {
        seen.push(ctx.isUser);
      },
    });

    try {
      await messageContentProcessorChain.run({
        chatId: "chat",
        content: "user",
        isUser: true,
        origin: "create",
        userId: "user",
      });
      await messageContentProcessorChain.run({
        chatId: "chat",
        content: "assistant",
        isUser: false,
        origin: "create",
        userId: "user",
      });
    } finally {
      unregister();
    }

    expect(seen).toEqual([true, false]);
  });

  test("reports whether a processor applies to a specific user", () => {
    const unregisterScoped = messageContentProcessorChain.register({
      extensionId: "test-user-scope",
      userId: "user-a",
      priority: 100,
      handler: async () => undefined,
    });

    try {
      expect(messageContentProcessorChain.hasForUser("user-a")).toBe(true);
      expect(messageContentProcessorChain.hasForUser("user-b")).toBe(false);

      const unregisterGlobal = messageContentProcessorChain.register({
        extensionId: "test-global-scope",
        priority: 100,
        handler: async () => undefined,
      });
      try {
        expect(messageContentProcessorChain.hasForUser("user-b")).toBe(true);
      } finally {
        unregisterGlobal();
      }
    } finally {
      unregisterScoped();
    }
  });
});
