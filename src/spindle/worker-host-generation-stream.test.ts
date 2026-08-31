import { describe, expect, test } from "bun:test";
import type { StreamChunk } from "../llm/types";
import { relayGenerationStreamToSpindle } from "./worker-host";

async function* providerStream(): AsyncGenerator<StreamChunk, void, unknown> {
  yield {
    token: "answer",
    reasoning: "first",
    thinking_blocks: [
      {
        type: "thinking",
        thinking: "private reasoning",
        signature: "signature-1",
        display_suppressed: true,
      },
    ],
    reasoning_details: [{ type: "reasoning.text", id: "detail-1" }],
  };
  yield {
    token: " complete",
    reasoning: " second",
    finish_reason: "tool_calls",
    tool_calls: [{ name: "lookup", args: { id: 7 }, call_id: "call-1" }],
    thinking_blocks: [{ type: "redacted_thinking", data: "encrypted-2" }],
    reasoning_details: [{ type: "reasoning.encrypted", data: "detail-2" }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  };
}

describe("Spindle direct-generation streaming", () => {
  test("forwards native continuation carriers on the terminal chunk", async () => {
    const chunks: unknown[] = [];
    const outcome = await relayGenerationStreamToSpindle(
      providerStream(),
      new AbortController().signal,
      (chunk) => chunks.push(chunk),
    );

    expect(outcome).toBe("completed");
    expect(chunks).toEqual([
      { type: "token", token: "answer" },
      { type: "reasoning", token: "first" },
      { type: "token", token: " complete" },
      { type: "reasoning", token: " second" },
      {
        type: "done",
        content: "answer complete",
        reasoning: "first second",
        finish_reason: "tool_calls",
        tool_calls: [{ name: "lookup", args: { id: 7 }, call_id: "call-1" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        thinking_blocks: [
          {
            type: "thinking",
            thinking: "private reasoning",
            signature: "signature-1",
            data: undefined,
          },
          {
            type: "redacted_thinking",
            thinking: undefined,
            signature: undefined,
            data: "encrypted-2",
          },
        ],
        reasoning_details: [
          { type: "reasoning.text", id: "detail-1" },
          { type: "reasoning.encrypted", data: "detail-2" },
        ],
      },
    ]);
  });
});
