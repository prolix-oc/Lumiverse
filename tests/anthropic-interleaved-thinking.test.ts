import { describe, expect, test } from "bun:test";
import { AnthropicProvider } from "../src/llm/providers/anthropic";
import { buildInlineToolContinuation } from "../src/services/inline-tool-continuation";
import type {
  GenerationRequest,
  LlmMessage,
  LlmThinkingBlock,
} from "../src/llm/types";

// Expose the protected seams used by the interleaved-thinking implementation.
class TestAnthropic extends AnthropicProvider {
  public collect(blocks: any[]) {
    return this.collectThinkingBlocks(blocks);
  }
  public format(m: LlmMessage) {
    return this.formatContent(m);
  }
  public headersFor(request: GenerationRequest) {
    return this.requestHeaders("test-key", request);
  }
  public wantsInterleaved(request: GenerationRequest) {
    return this.wantsInterleavedThinking(request);
  }
}

const provider = new TestAnthropic();
const BETA = "interleaved-thinking-2025-05-14";

const req = (over: Partial<GenerationRequest> = {}): GenerationRequest => ({
  messages: [{ role: "user", content: "hi" }],
  model: "claude-opus-4-8",
  ...over,
});

describe("Anthropic capability + beta header", () => {
  test("declares interleavedThinking capability", () => {
    expect(provider.capabilities.interleavedThinking).toBe(true);
  });

  test("sends the beta header when tools are present and thinking is enabled", () => {
    const headers = provider.headersFor(
      req({
        tools: [{ name: "search", description: "", parameters: {} }],
        parameters: { thinking: { type: "adaptive" } },
      }),
    );
    expect(headers["anthropic-beta"]).toBe(BETA);
  });

  test("omits the beta header when thinking is disabled", () => {
    const headers = provider.headersFor(
      req({
        tools: [{ name: "search", description: "", parameters: {} }],
        parameters: { thinking: { type: "disabled" } },
      }),
    );
    expect(headers["anthropic-beta"]).toBeUndefined();
  });

  test("omits the beta header when there are no tools", () => {
    expect(
      provider.wantsInterleaved(req({ parameters: { thinking: { type: "adaptive" } } })),
    ).toBe(false);
    const headers = provider.headersFor(
      req({ parameters: { thinking: { type: "adaptive" } } }),
    );
    expect(headers["anthropic-beta"]).toBeUndefined();
  });
});

describe("Anthropic thinking-block capture (non-streaming content array)", () => {
  test("extracts thinking + redacted_thinking blocks with signatures, in order", () => {
    const blocks = [
      { type: "thinking", thinking: "let me reason", signature: "sig-abc" },
      { type: "redacted_thinking", data: "enc-xyz" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "call_1", name: "search", input: { q: "x" } },
    ];
    const out = provider.collect(blocks);
    expect(out).toEqual([
      { type: "thinking", thinking: "let me reason", signature: "sig-abc" },
      { type: "redacted_thinking", data: "enc-xyz" },
    ]);
  });

  test("keeps thinking blocks even when signature is absent", () => {
    const out = provider.collect([{ type: "thinking", thinking: "x" }]);
    expect(out).toEqual([{ type: "thinking", thinking: "x" }]);
  });
});

describe("Anthropic thinking-block replay (formatContent)", () => {
  test("prepends thinking blocks before text and tool_use, signature intact", () => {
    const msg: LlmMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "calling a tool" },
        { type: "tool_use", id: "call_1", name: "search", input: { q: "x" } },
      ],
      thinking_blocks: [
        { type: "thinking", thinking: "I should search", signature: "sig-abc" },
      ],
    };

    const out = provider.format(msg) as Array<Record<string, unknown>>;
    expect(Array.isArray(out)).toBe(true);
    // Thinking block must come FIRST.
    expect(out[0]).toEqual({
      type: "thinking",
      thinking: "I should search",
      signature: "sig-abc",
    });
    expect(out[1]).toMatchObject({ type: "text", text: "calling a tool" });
    expect(out[2]).toMatchObject({ type: "tool_use", id: "call_1", name: "search" });
  });

  test("serializes redacted_thinking blocks", () => {
    const msg: LlmMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "t", input: {} }],
      thinking_blocks: [{ type: "redacted_thinking", data: "enc-1" }],
    };
    const out = provider.format(msg) as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({ type: "redacted_thinking", data: "enc-1" });
  });

  test("does not inject thinking blocks for non-assistant roles", () => {
    const msg: LlmMessage = {
      role: "user",
      content: "plain user text",
      thinking_blocks: [{ type: "thinking", thinking: "x", signature: "s" }],
    };
    // user message with string content and no cache control → passthrough string.
    expect(provider.format(msg)).toBe("plain user text");
  });

  test("string-content assistant turn still prepends thinking blocks", () => {
    const msg: LlmMessage = {
      role: "assistant",
      content: "final text",
      thinking_blocks: [{ type: "thinking", thinking: "t", signature: "s" }],
    };
    const out = provider.format(msg) as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({ type: "thinking", thinking: "t", signature: "s" });
    expect(out[1]).toMatchObject({ type: "text", text: "final text" });
  });
});

describe("Anthropic streaming captures thinking blocks + signature", () => {
  const sseBody = (events: object[]) =>
    events.map((e) => `data: ${JSON.stringify(e)}\n`).join("");

  test("accumulates thinking_delta + signature_delta into a thinking block on the terminal chunk", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I should " } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "search." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG123" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "search" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(sseBody(events), { status: 200 })) as typeof fetch;

    try {
      const chunks: any[] = [];
      for await (const chunk of provider.generateStream("k", "https://api.anthropic.com", {
        messages: [{ role: "user", content: "find x" }],
        model: "claude-opus-4-8",
        parameters: { thinking: { type: "adaptive" } },
        tools: [{ name: "search", description: "", parameters: {} }],
      })) {
        chunks.push(chunk);
      }

      const reasoning = chunks.map((c) => c.reasoning || "").join("");
      expect(reasoning).toBe("I should search.");

      const terminal = chunks.find((c) => c.finish_reason);
      expect(terminal).toBeDefined();
      expect(terminal.finish_reason).toBe("tool_calls");
      expect(terminal.tool_calls).toEqual([
        { name: "search", args: { q: "x" }, call_id: "call_1" },
      ]);
      expect(terminal.thinking_blocks).toEqual([
        { type: "thinking", thinking: "I should search.", signature: "SIG123" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("captures signature even when thinking text is omitted (display:omitted)", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 4 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "OMIT-SIG" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "c2", name: "t" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(sseBody(events), { status: 200 })) as typeof fetch;

    try {
      const chunks: any[] = [];
      for await (const chunk of provider.generateStream("k", "https://api.anthropic.com", {
        messages: [{ role: "user", content: "go" }],
        model: "claude-opus-4-8",
        parameters: { thinking: { type: "adaptive" } },
        tools: [{ name: "t", description: "", parameters: {} }],
      })) {
        chunks.push(chunk);
      }

      const terminal = chunks.find((c) => c.finish_reason);
      expect(terminal.thinking_blocks).toEqual([
        { type: "thinking", thinking: "", signature: "OMIT-SIG" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("end-to-end: builder output replays correctly through Anthropic", () => {
  test("structured continuation carries thinking blocks that format first", () => {
    const thinkingBlocks: LlmThinkingBlock[] = [
      { type: "thinking", thinking: "plan the search", signature: "opaque-sig" },
    ];

    const [assistantMsg, toolMsg] = buildInlineToolContinuation({
      structured: true,
      legacyAssistantOutput: "",
      roundContent: "let me look that up",
      roundReasoning: "plan the search",
      toolCalls: [{ name: "search", args: { q: "x" }, call_id: "call_1" }],
      results: [
        {
          callId: "call_1",
          qualifiedName: "search",
          toolName: "search",
          toolDisplayName: "Search",
          result: "the answer",
        },
      ],
      thinkingBlocks,
    });

    // Builder attaches the native blocks to the assistant turn.
    expect(assistantMsg.thinking_blocks).toEqual(thinkingBlocks);

    // Anthropic formats them first, before text + tool_use — the shape the
    // API requires for interleaved thinking (signature preserved verbatim).
    const formatted = provider.format(assistantMsg) as Array<
      Record<string, unknown>
    >;
    expect(formatted[0]).toEqual({
      type: "thinking",
      thinking: "plan the search",
      signature: "opaque-sig",
    });
    expect(formatted.some((p) => p.type === "tool_use")).toBe(true);

    // Tool result is a normal Anthropic tool_result block.
    const toolFormatted = provider.format(toolMsg) as Array<
      Record<string, unknown>
    >;
    expect(toolFormatted[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "call_1",
      content: "the answer",
    });
  });
});
