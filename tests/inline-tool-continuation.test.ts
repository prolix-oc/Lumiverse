import { describe, expect, test } from "bun:test";
import {
  buildInlineToolContinuation,
  type InlineCouncilToolResult,
} from "../src/services/inline-tool-continuation";
import { DeepSeekProvider } from "../src/llm/providers/deepseek";
import type {
  LlmMessage,
  LlmToolUsePart,
  LlmToolResultPart,
  ToolCallResult,
} from "../src/llm/types";

const toolCall = (
  overrides: Partial<ToolCallResult> = {},
): ToolCallResult => ({
  name: "search",
  args: { q: "hello" },
  call_id: "call_1",
  ...overrides,
});

const toolResult = (
  overrides: Partial<InlineCouncilToolResult> = {},
): InlineCouncilToolResult => ({
  callId: "call_1",
  qualifiedName: "search",
  toolName: "search",
  toolDisplayName: "Search",
  result: "found it",
  ...overrides,
});

describe("buildInlineToolContinuation — legacy text path", () => {
  test("emits assistant text + a system results block", () => {
    const msgs = buildInlineToolContinuation({
      structured: false,
      legacyAssistantOutput: "<think>plan</think>\nlet me search",
      roundContent: "let me search",
      roundReasoning: "plan",
      toolCalls: [toolCall()],
      results: [toolResult()],
    });

    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({
      role: "assistant",
      content: "<think>plan</think>\nlet me search",
    });
    expect(msgs[1].role).toBe("system");
    expect(msgs[1].content).toContain("Inline Council Tool Results");
    expect(msgs[1].content).toContain("found it");
    // Legacy path never carries structured reasoning.
    expect((msgs[0] as LlmMessage).reasoning_content).toBeUndefined();
  });

  test("omits the assistant message when there is no output", () => {
    const msgs = buildInlineToolContinuation({
      structured: false,
      legacyAssistantOutput: "",
      roundContent: "",
      roundReasoning: "",
      toolCalls: [toolCall()],
      results: [toolResult()],
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
  });
});

describe("buildInlineToolContinuation — structured interleaved path", () => {
  test("emits tool_use + tool_result parts and echoes reasoning_content", () => {
    const msgs = buildInlineToolContinuation({
      structured: true,
      legacyAssistantOutput: "ignored when structured",
      roundContent: "let me search",
      roundReasoning: "I should look this up",
      toolCalls: [toolCall()],
      results: [toolResult()],
    });

    expect(msgs).toHaveLength(2);

    const assistant = msgs[0];
    expect(assistant.role).toBe("assistant");
    expect(assistant.reasoning_content).toBe("I should look this up");
    const parts = assistant.content as Array<LlmToolUsePart | { type: string }>;
    expect(parts[0]).toEqual({ type: "text", text: "let me search" });
    const toolUse = parts[1] as LlmToolUsePart;
    expect(toolUse.type).toBe("tool_use");
    expect(toolUse.id).toBe("call_1");
    expect(toolUse.name).toBe("search");
    expect(toolUse.input).toEqual({ q: "hello" });

    const toolMsg = msgs[1];
    expect(toolMsg.role).toBe("user");
    const trParts = toolMsg.content as LlmToolResultPart[];
    expect(trParts[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call_1",
      content: "found it",
    });
  });

  test("only includes tool calls that actually produced a result (no orphans)", () => {
    const msgs = buildInlineToolContinuation({
      structured: true,
      legacyAssistantOutput: "",
      roundContent: "",
      roundReasoning: "thinking",
      toolCalls: [
        toolCall({ call_id: "call_1" }),
        toolCall({ call_id: "call_2", name: "unresolved" }),
      ],
      results: [toolResult({ callId: "call_1" })],
    });

    const assistant = msgs[0];
    const toolUses = (assistant.content as LlmToolUsePart[]).filter(
      (p) => p.type === "tool_use",
    );
    const toolResults = msgs[1].content as LlmToolResultPart[];
    // call_2 had no result → excluded so every tool_use is answered.
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].id).toBe("call_1");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe("call_1");
  });

  test("omits reasoning_content when the round produced no reasoning", () => {
    const msgs = buildInlineToolContinuation({
      structured: true,
      legacyAssistantOutput: "",
      roundContent: "no thinking here",
      roundReasoning: "",
      toolCalls: [toolCall()],
      results: [toolResult()],
    });
    expect(msgs[0].reasoning_content).toBeUndefined();
  });

  test("falls back to legacy text when no tool resolved", () => {
    const msgs = buildInlineToolContinuation({
      structured: true,
      legacyAssistantOutput: "some text",
      roundContent: "some text",
      roundReasoning: "thinking",
      toolCalls: [toolCall({ call_id: "call_x" })],
      results: [], // nothing ran
    });
    // Legacy shape: assistant text + system block.
    expect(msgs[msgs.length - 1].role).toBe("system");
  });
});

describe("DeepSeek provider round-trips the structured continuation", () => {
  // Expose the protected flattenForChat for assertion.
  class TestDeepSeek extends DeepSeekProvider {
    public flatten(m: LlmMessage) {
      return this.flattenForChat(m);
    }
  }
  const provider = new TestDeepSeek();

  test("declares interleavedThinking capability", () => {
    expect(provider.capabilities.interleavedThinking).toBe(true);
  });

  test("echoes reasoning_content on the assistant tool-call message", () => {
    const [assistantMsg, toolMsg] = buildInlineToolContinuation({
      structured: true,
      legacyAssistantOutput: "",
      roundContent: "looking it up",
      roundReasoning: "the user wants X, I'll call search",
      toolCalls: [toolCall()],
      results: [toolResult()],
    });

    const flatAssistant = provider.flatten(assistantMsg);
    expect(flatAssistant).toHaveLength(1);
    const sent = flatAssistant[0];
    expect(sent.role).toBe("assistant");
    expect(sent.reasoning_content).toBe("the user wants X, I'll call search");
    expect(sent.tool_calls).toHaveLength(1);
    expect(sent.tool_calls[0]).toMatchObject({
      id: "call_1",
      type: "function",
      function: { name: "search", arguments: JSON.stringify({ q: "hello" }) },
    });

    const flatTool = provider.flatten(toolMsg);
    expect(flatTool).toHaveLength(1);
    expect(flatTool[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "found it",
    });
  });

  test("drops reasoning_content when the assistant turn has no tool call", () => {
    // A plain assistant turn (no tool_use) must NOT carry reasoning_content —
    // DeepSeek degrades quality if the thinking chain is echoed on non-tool
    // turns. flattenForChat scopes the echo to tool-call turns only.
    const plain: LlmMessage = {
      role: "assistant",
      content: "just a normal reply",
      reasoning_content: "should not be sent",
    };
    const flat = provider.flatten(plain);
    expect(flat[0].reasoning_content).toBeUndefined();
  });
});
