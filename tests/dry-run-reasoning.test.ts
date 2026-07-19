import { describe, expect, test } from "bun:test";
import { __test__ } from "../src/services/generate.service";
import type { LlmMessage } from "../src/llm/types";

describe("dry-run reasoning display messages", () => {
  test("hydrates reasoning from the source chat message when available", () => {
    const messages = [
      {
        role: "assistant",
        content: "Visible reply",
        __sourceMessageId: "msg-1",
      },
    ] as unknown as LlmMessage[];

    const sourceMessages = new Map([
      [
        "msg-1",
        {
          id: "msg-1",
          extra: { reasoning: "Hidden reasoning" },
        },
      ],
    ]) as any;

    const [display] = __test__.buildDryRunDisplayMessages(messages, sourceMessages);

    expect(display.content).toBe("Visible reply");
    expect(display.reasoning).toBe("Hidden reasoning");
  });

  test("falls back to assistant reasoning carriers when no source message exists", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        reasoning_content: "Tool planning",
      },
      {
        role: "assistant",
        content: "",
        thinking_blocks: [
          { type: "thinking", thinking: "Anthropic thinking", signature: "sig-1" },
        ],
      },
      {
        role: "assistant",
        content: "",
        reasoning_details: [
          { type: "reasoning.text", text: "OpenRouter reasoning" },
        ],
      },
    ] as unknown as LlmMessage[];

    const displays = __test__.buildDryRunDisplayMessages(messages);

    expect(displays[0].reasoning).toBe("Tool planning");
    expect(displays[1].reasoning).toBe("Anthropic thinking");
    expect(displays[2].reasoning).toBe("OpenRouter reasoning");
  });

  test("does not duplicate reasoning when it matches the visible content", () => {
    const messages = [
      {
        role: "assistant",
        content: "Same text",
        reasoning_content: "Same text",
      },
    ] as unknown as LlmMessage[];

    const [display] = __test__.buildDryRunDisplayMessages(messages);

    expect(display.reasoning).toBeUndefined();
  });

  test("preserves user content that happens to contain reasoning delimiters", () => {
    const messages = [
      {
        role: "user",
        content: "Literal prefix\n<think>manual cot block</think>\nLiteral suffix",
        __chatHistorySource: true,
      },
    ] as unknown as LlmMessage[];

    const [display] = __test__.buildDryRunDisplayMessages(messages);

    expect(display.content).toBe(
      "Literal prefix\n<think>manual cot block</think>\nLiteral suffix",
    );
    expect(display.reasoning).toBeUndefined();
  });

  test("still extracts delimited reasoning from assistant chat history", () => {
    const messages = [
      {
        role: "assistant",
        content: "Visible reply<think>Hidden plan</think>",
        __chatHistorySource: true,
      },
    ] as unknown as LlmMessage[];

    const [display] = __test__.buildDryRunDisplayMessages(messages);

    expect(display.content).toBe("Visible reply");
    expect(display.reasoning).toBe("Hidden plan");
  });

  test("preserves assistant content when assembly marks delimiters as literal", () => {
    const messages = [
      {
        role: "assistant",
        content: "Visible reply<think>manual block</think>",
        __chatHistorySource: true,
        __preserveDisplayReasoningDelimiters: true,
      },
    ] as unknown as LlmMessage[];

    const [display] = __test__.buildDryRunDisplayMessages(messages);

    expect(display.content).toBe("Visible reply<think>manual block</think>");
    expect(display.reasoning).toBeUndefined();
  });

  test("surfaces non-text message parts separately for dry run display", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          { type: "image", data: "aaa", mime_type: "image/png" },
          { type: "audio", data: "bbb", mime_type: "audio/mpeg" },
        ],
      },
    ] as unknown as LlmMessage[];

    const [display] = __test__.buildDryRunDisplayMessages(messages);

    expect(display.content).toContain("[image: image/png]");
    expect(display.content).toContain("[audio: audio/mpeg]");
    expect(display.contentParts).toEqual([
      { type: "image", count: 1 },
      { type: "audio", count: 1 },
    ]);
  });

  test("respects keepInHistory when surfacing chat-history reasoning", () => {
    const messages = [
      {
        role: "assistant",
        content: "Reply one",
        __sourceMessageId: "msg-1",
        __chatHistorySource: true,
      },
      {
        role: "assistant",
        content: "Reply two",
        __sourceMessageId: "msg-2",
        __chatHistorySource: true,
      },
      {
        role: "assistant",
        content: "Reply three",
        __sourceMessageId: "msg-3",
        __chatHistorySource: true,
      },
    ] as unknown as LlmMessage[];

    const sourceMessages = new Map([
      ["msg-1", { id: "msg-1", extra: { reasoning: "Reasoning one" } }],
      ["msg-2", { id: "msg-2", extra: { reasoning: "Reasoning two" } }],
      ["msg-3", { id: "msg-3", extra: { reasoning: "Reasoning three" } }],
    ]) as any;

    const displays = __test__.buildDryRunDisplayMessages(messages, sourceMessages, {
      keepInHistory: 2,
    });

    expect(displays[0].reasoning).toBeUndefined();
    expect(displays[1].reasoning).toBe("Reasoning two");
    expect(displays[2].reasoning).toBe("Reasoning three");
  });
});
