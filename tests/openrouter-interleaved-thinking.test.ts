import { describe, expect, test } from "bun:test";
import {
  OpenAICompatibleProvider,
  ReasoningDetailsAccumulator,
} from "../src/llm/providers/openai-compatible";
import { OpenRouterProvider } from "../src/llm/providers/openrouter";
import { buildInlineToolContinuation } from "../src/services/inline-tool-continuation";
import type { LlmMessage } from "../src/llm/types";

// Expose the protected flattenForChat seam.
class TestOpenRouter extends OpenRouterProvider {
  public flatten(m: LlmMessage) {
    return this.flattenForChat(m);
  }
}
const provider = new TestOpenRouter();

describe("OpenRouter capability", () => {
  test("declares interleavedThinking", () => {
    expect(provider.capabilities.interleavedThinking).toBe(true);
  });
});

describe("ReasoningDetailsAccumulator", () => {
  test("returns undefined when nothing was streamed", () => {
    expect(new ReasoningDetailsAccumulator().finalize()).toBeUndefined();
  });

  test("concatenates text within an index and preserves metadata, sorted by index", () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.push([
      { type: "reasoning.text", text: "Let me ", id: "r1", format: "anthropic-claude-v1", index: 0 },
    ]);
    acc.push([{ type: "reasoning.text", text: "think.", signature: "SIG", index: 0 }]);
    // An out-of-order, lower-index summary block.
    acc.push([{ type: "reasoning.summary", summary: "S", index: 0 }]); // same index merges in

    const out = acc.finalize()!;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "reasoning.summary", // last type set wins
      text: "Let me think.",
      signature: "SIG",
      summary: "S",
      id: "r1",
      format: "anthropic-claude-v1",
      index: 0,
    });
  });

  test("keeps distinct blocks by index and orders them", () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.push([{ type: "reasoning.encrypted", data: "enc", index: 2 }]);
    acc.push([{ type: "reasoning.text", text: "a", index: 1 }]);
    acc.push([{ type: "reasoning.text", text: "b", index: 1 }]);
    const out = acc.finalize()!;
    expect(out.map((b) => b.index)).toEqual([1, 2]);
    expect(out[0]).toMatchObject({ type: "reasoning.text", text: "ab", index: 1 });
    expect(out[1]).toMatchObject({ type: "reasoning.encrypted", data: "enc", index: 2 });
  });

  test("ignores non-array / non-object input", () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.push(undefined);
    acc.push("nope");
    acc.push([null, 5]);
    expect(acc.finalize()).toBeUndefined();
  });
});

describe("OpenRouter replays reasoning_details on the assistant message", () => {
  const details = [
    { type: "reasoning.text", text: "thinking", signature: "SIG", id: "r1", format: "anthropic-claude-v1", index: 0 },
  ];

  test("flattenForChat puts reasoning_details verbatim on the tool-call assistant message", () => {
    const msg: LlmMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "search", input: { q: "x" } }],
      reasoning_details: details,
    };
    const flat = provider.flatten(msg);
    expect(flat[0].reasoning_details).toEqual(details);
    expect(flat[0].tool_calls).toHaveLength(1);
  });

  test("reasoning_details takes precedence over reasoning_content when both present", () => {
    const msg: LlmMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "search", input: {} }],
      reasoning_content: "plaintext alias",
      reasoning_details: details,
    };
    const flat = provider.flatten(msg);
    expect(flat[0].reasoning_details).toEqual(details);
    expect(flat[0].reasoning_content).toBeUndefined();
  });

  test("falls back to reasoning_content when no reasoning_details", () => {
    const msg: LlmMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "search", input: {} }],
      reasoning_content: "plaintext",
    };
    const flat = provider.flatten(msg);
    expect(flat[0].reasoning_content).toBe("plaintext");
    expect(flat[0].reasoning_details).toBeUndefined();
  });
});

describe("builder attaches reasoning_details on the structured continuation", () => {
  test("assistant turn carries reasoning_details verbatim", () => {
    const details = [{ type: "reasoning.encrypted", data: "enc", index: 0 }];
    const [assistantMsg] = buildInlineToolContinuation({
      structured: true,
      legacyAssistantOutput: "",
      roundContent: "",
      roundReasoning: "",
      toolCalls: [{ name: "search", args: { q: "x" }, call_id: "call_1" }],
      results: [
        { callId: "call_1", qualifiedName: "search", toolName: "search", toolDisplayName: "Search", result: "ok" },
      ],
      reasoningDetails: details,
    });
    expect(assistantMsg.reasoning_details).toEqual(details);
  });
});

describe("OpenRouter streaming accumulates reasoning_details across chunks", () => {
  test("terminal chunk carries the merged reasoning_details + tool_calls", async () => {
    const sse = [
      { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "Let me ", id: "r1", format: "anthropic-claude-v1", index: 0 }] } }] },
      { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "think.", signature: "SIG", index: 0 }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: '{"q":"x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n`)
      .join("") + "data: [DONE]\n";

    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(sse, { status: 200 })) as typeof fetch;
    try {
      const chunks: any[] = [];
      for await (const c of provider.generateStream("key", "https://openrouter.ai/api/v1", {
        messages: [{ role: "user", content: "find x" }],
        model: "anthropic/claude-opus-4.8",
        parameters: { reasoning: { effort: "high" } },
        tools: [{ name: "search", description: "", parameters: {} }],
      })) {
        chunks.push(c);
      }

      const terminal = chunks.find((c) => c.finish_reason);
      expect(terminal.finish_reason).toBe("tool_calls");
      expect(terminal.tool_calls[0]).toMatchObject({ name: "search", args: { q: "x" }, call_id: "call_1" });
      expect(terminal.reasoning_details).toEqual([
        {
          type: "reasoning.text",
          text: "Let me think.",
          signature: "SIG",
          id: "r1",
          format: "anthropic-claude-v1",
          index: 0,
        },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("non-OpenRouter OpenAI-compatible providers are unaffected", () => {
  // A bare OpenAI-compatible provider that returns no reasoning_details should
  // never emit the field — proving the carrier is naturally scoped.
  class Bare extends OpenAICompatibleProvider {
    readonly name = "bare";
    readonly displayName = "Bare";
    readonly defaultUrl = "https://example.com/v1";
    readonly capabilities = provider.capabilities;
    public flatten(m: LlmMessage) {
      return this.flattenForChat(m);
    }
  }
  test("assistant tool-call message without reasoning_details omits the field", () => {
    const flat = new Bare().flatten({
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "t", input: {} }],
    });
    expect(flat[0].reasoning_details).toBeUndefined();
    expect(flat[0].reasoning_content).toBeUndefined();
  });
});
