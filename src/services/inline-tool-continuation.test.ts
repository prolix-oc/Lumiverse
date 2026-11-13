import { describe, expect, test } from "bun:test";
import { buildInlineToolContinuation } from "./inline-tool-continuation";

describe("inline tool continuation", () => {
  test("keeps an optional Gemini non-tool signature on the assistant text part", () => {
    const messages = buildInlineToolContinuation({
      structured: true,
      legacyAssistantOutput: "",
      roundContent: "I'll look that up.",
      roundReasoning: "I need fresh data.",
      thoughtSignature: "opaque-text-signature",
      toolCalls: [{ call_id: "search-1", name: "web_search", args: { query: "test" } }],
      results: [{
        callId: "search-1",
        qualifiedName: "web_search",
        toolName: "web_search",
        toolDisplayName: "Web Search",
        result: "result",
      }],
    });

    expect(messages[0].role).toBe("assistant");
    expect((messages[0].content as any[])[0]).toEqual({
      type: "text",
      text: "I'll look that up.",
      thought_signature: "opaque-text-signature",
    });
  });

  test("marks structured failed tool calls as errors", () => {
    const messages = buildInlineToolContinuation({
      structured: true,
      legacyAssistantOutput: "",
      roundContent: "",
      roundReasoning: "",
      toolCalls: [{ call_id: "search-1", name: "web_search", args: { query: "test" } }],
      results: [{
        callId: "search-1",
        qualifiedName: "web_search",
        toolName: "web_search",
        toolDisplayName: "Web Search",
        result: "Web search can be called only once per generation.",
        isError: true,
      }],
    });

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "search-1",
        content: "Web search can be called only once per generation.",
        is_error: true,
      }],
    });
  });
});
