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
});
