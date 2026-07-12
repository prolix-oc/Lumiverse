import { describe, expect, test } from "bun:test";

import type { Message } from "../types/message";
import { buildWorldInfoVectorQuery } from "./prompt-assembly.service";

function message(
  index: number,
  content: string,
  extra: Record<string, unknown> = {},
): Message {
  return {
    id: `message-${index}`,
    chat_id: "chat-1",
    index_in_chat: index,
    is_user: index % 2 === 0,
    name: index % 2 === 0 ? "User" : "Character",
    content,
    send_date: index,
    swipe_id: 0,
    swipes: [content],
    swipe_dates: [index],
    extra,
    parent_message_id: null,
    branch_id: null,
    created_at: index,
  };
}

describe("world-book vector query scope", () => {
  test("uses Global Scan Depth instead of chat-memory context size", async () => {
    const result = await buildWorldInfoVectorQuery(
      [
        message(0, "oldest visible"),
        message(1, "hidden", { hidden: true }),
        message(2, "   "),
        message(3, "first selected"),
        message(4, "second selected"),
        message(5, "third selected"),
        message(6, "fourth selected"),
      ],
      4,
      null,
    );

    expect(result.queryPreview).not.toContain("oldest visible");
    expect(result.queryPreview).not.toContain("hidden");
    expect(result.queryPreview).toContain("first selected");
    expect(result.queryPreview).toContain("fourth selected");
    expect(result.queryScope).toEqual({
      configuredScanDepth: 4,
      visibleMessagesAvailable: 5,
      messagesSelected: 4,
      maxTokens: 8000,
      tokenTruncated: false,
    });
  });

  test("uses all visible messages for unlimited depth and reports token truncation", async () => {
    const result = await buildWorldInfoVectorQuery(
      [message(0, `old marker ${"a".repeat(25_000)}`), message(1, `new marker ${"b".repeat(10_000)}`)],
      null,
      null,
    );

    expect(result.queryScope.configuredScanDepth).toBeNull();
    expect(result.queryScope.visibleMessagesAvailable).toBe(2);
    expect(result.queryScope.messagesSelected).toBe(2);
    expect(result.queryScope.tokenTruncated).toBe(true);
    expect(result.queryPreview.length).toBe(24_000);
    expect(result.queryPreview).not.toContain("old marker");
    expect(result.queryPreview).toContain("new marker");
  });
});
