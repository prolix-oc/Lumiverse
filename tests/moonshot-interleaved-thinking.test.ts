import { describe, expect, test } from "bun:test";
import { MoonshotProvider } from "../src/llm/providers/moonshot";
import { buildInlineToolContinuation } from "../src/services/inline-tool-continuation";
import type { GenerationRequest, LlmMessage } from "../src/llm/types";

// Expose the protected seams (inherited from OpenAICompatibleProvider).
class TestMoonshot extends MoonshotProvider {
  public flatten(m: LlmMessage) {
    return this.flattenForChat(m);
  }
  public build(request: GenerationRequest, stream: boolean) {
    return this.buildBody(request, stream);
  }
}

const provider = new TestMoonshot();

describe("Moonshot/Kimi interleaved thinking", () => {
  test("declares interleavedThinking capability", () => {
    expect(provider.capabilities.interleavedThinking).toBe(true);
  });

  test("echoes reasoning_content on the assistant tool-call turn", () => {
    const [assistantMsg, toolMsg] = buildInlineToolContinuation({
      structured: true,
      legacyAssistantOutput: "",
      roundContent: "let me check the weather",
      roundReasoning: "the user asked about weather; I'll call the tool",
      toolCalls: [{ name: "get_weather", args: { city: "Paris" }, call_id: "call_1" }],
      results: [
        {
          callId: "call_1",
          qualifiedName: "get_weather",
          toolName: "get_weather",
          toolDisplayName: "Get Weather",
          result: "18C",
        },
      ],
    });

    const flat = provider.flatten(assistantMsg);
    expect(flat).toHaveLength(1);
    expect(flat[0].role).toBe("assistant");
    expect(flat[0].reasoning_content).toBe(
      "the user asked about weather; I'll call the tool",
    );
    expect(flat[0].tool_calls[0]).toMatchObject({
      id: "call_1",
      type: "function",
      function: {
        name: "get_weather",
        arguments: JSON.stringify({ city: "Paris" }),
      },
    });

    const flatTool = provider.flatten(toolMsg);
    expect(flatTool[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "18C",
    });
  });

  test("passes the thinking param through to the request body", () => {
    const body = provider.build(
      {
        messages: [{ role: "user", content: "hi" }],
        model: "kimi-k2-thinking",
        parameters: {
          temperature: 1.0,
          max_tokens: 16000,
          thinking: { type: "enabled", keep: "all" },
        },
        tools: [{ name: "get_weather", description: "", parameters: {} }],
      },
      true,
    );

    expect(body.thinking).toEqual({ type: "enabled", keep: "all" });
    expect(body.temperature).toBe(1.0);
    expect(body.max_tokens).toBe(16000);
    // Tools serialized to OpenAI function-calling form.
    expect(body.tools[0]).toMatchObject({
      type: "function",
      function: { name: "get_weather" },
    });
  });

  test("does not echo reasoning_content on a plain (non-tool) assistant turn", () => {
    const plain: LlmMessage = {
      role: "assistant",
      content: "just a normal reply",
      reasoning_content: "should be dropped on non-tool turns",
    };
    expect(provider.flatten(plain)[0].reasoning_content).toBeUndefined();
  });
});
