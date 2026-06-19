import type {
  LlmMessage,
  LlmMessagePart,
  LlmThinkingBlock,
  LlmToolResultPart,
  ToolCallResult,
} from "../llm/types";

/** One executed inline-tool call result, ready to be fed back to the model. */
export interface InlineCouncilToolResult {
  callId: string;
  qualifiedName: string;
  toolName: string;
  toolDisplayName: string;
  memberName?: string;
  result: string;
}

/**
 * Legacy text rendering of inline tool results — a single human-readable system
 * block. Used for providers that don't natively round-trip reasoning across
 * tool calls (everything except those with `capabilities.interleavedThinking`).
 */
export function formatInlineCouncilToolResults(
  results: InlineCouncilToolResult[],
): string {
  const lines = [
    "## Inline Council Tool Results",
    "The model requested council tool calls during generation. Use these results to continue the reply naturally.",
    "",
  ];

  for (const result of results) {
    lines.push(
      `### ${result.memberName ? `${result.memberName} - ` : ""}${result.toolDisplayName}`,
    );
    lines.push(result.result || "(empty result)");
    lines.push("");
  }

  return lines.join("\n");
}

export interface InlineToolContinuationOptions {
  /**
   * When true, emit native `tool_use` / `tool_result` parts plus the round's
   * `reasoning_content` so a thinking model can keep reasoning across tool
   * calls (interleaved thinking). When false, fall back to the legacy text
   * representation.
   */
  structured: boolean;
  /**
   * Legacy text rendering of the assistant turn (reasoning wrapped in the
   * configured CoT delimiters + content). Used by the non-structured path and
   * as a defensive fallback.
   */
  legacyAssistantOutput: string;
  /** This round's freshly-streamed content (delta, not accumulated). */
  roundContent: string;
  /** This round's freshly-streamed reasoning (delta, not accumulated). */
  roundReasoning: string;
  /** Tool calls the model emitted this round. */
  toolCalls: ToolCallResult[];
  /** Executed tool results (a subset of `toolCalls` — some may be skipped). */
  results: InlineCouncilToolResult[];
  /**
   * Provider-native reasoning blocks captured this round (Anthropic thinking
   * blocks with signatures). Attached verbatim to the structured assistant
   * turn so the provider can replay them before its tool_use blocks. Ignored by
   * providers that carry reasoning via `reasoning_content` instead.
   */
  thinkingBlocks?: LlmThinkingBlock[];
  /**
   * OpenRouter `reasoning_details` captured this round. Attached verbatim to the
   * structured assistant turn for replay. Ignored by other providers.
   */
  reasoningDetails?: Record<string, unknown>[];
}

/**
 * Build the messages that carry one inline-tool round back into the next
 * generation request.
 *
 * **Legacy mode** (most providers): an assistant text message echoing the
 * model's output, followed by a `system` message summarising the tool results.
 *
 * **Structured mode** (`capabilities.interleavedThinking`): a real tool-call
 * round-trip — an assistant message with `tool_use` parts plus the round's
 * `reasoning_content`, followed by a `user` message with matching
 * `tool_result` parts. Preserving the reasoning alongside the tool call is what
 * lets a thinking model (e.g. DeepSeek reasoner) keep reasoning between tool
 * calls instead of restarting its chain of thought each round.
 *
 * Only tool calls that actually produced a result are included as `tool_use`
 * parts, so every `tool_use` has a matching `tool_result` — providers reject
 * assistant turns with orphaned tool calls.
 *
 * NOTE: the structured branch carries reasoning via `reasoning_content`, the
 * OpenAI-compatible (DeepSeek / Moonshot) carrier. Providers that preserve
 * reasoning differently — Anthropic `thinking` blocks, Gemini thought
 * signatures — must wire their own carrier before enabling the capability flag.
 */
export function buildInlineToolContinuation(
  opts: InlineToolContinuationOptions,
): LlmMessage[] {
  const {
    structured,
    legacyAssistantOutput,
    roundContent,
    roundReasoning,
    toolCalls,
    results,
    thinkingBlocks,
    reasoningDetails,
  } = opts;

  const legacyContinuation = (): LlmMessage[] => [
    ...(legacyAssistantOutput
      ? [{ role: "assistant", content: legacyAssistantOutput } as LlmMessage]
      : []),
    { role: "system", content: formatInlineCouncilToolResults(results) },
  ];

  if (!structured) return legacyContinuation();

  const resultsByCallId = new Map(results.map((r) => [r.callId, r]));
  const resolvedCalls = toolCalls.filter((tc) =>
    resultsByCallId.has(tc.call_id),
  );

  // No tool actually ran (e.g. every call was llm-handled or unresolved) — fall
  // back to the legacy text continuation so the model still sees something
  // coherent rather than an empty assistant turn.
  if (resolvedCalls.length === 0) return legacyContinuation();

  const assistantParts: LlmMessagePart[] = [];
  if (roundContent) assistantParts.push({ type: "text", text: roundContent });
  for (const tc of resolvedCalls) {
    assistantParts.push({
      type: "tool_use",
      id: tc.call_id,
      name: tc.name,
      input: tc.args ?? {},
      ...(tc.thought_signature
        ? { thought_signature: tc.thought_signature }
        : {}),
    });
  }

  const toolResultParts: LlmToolResultPart[] = resolvedCalls.map((tc) => ({
    type: "tool_result",
    tool_use_id: tc.call_id,
    content: resultsByCallId.get(tc.call_id)!.result || "(empty result)",
  }));

  return [
    {
      role: "assistant",
      content: assistantParts,
      // `reasoning_content` is only echoed when the model actually produced
      // reasoning this round; `flattenForChat` drops the field otherwise.
      ...(roundReasoning ? { reasoning_content: roundReasoning } : {}),
      // Native thinking blocks (Anthropic) replayed verbatim before tool_use.
      ...(thinkingBlocks?.length ? { thinking_blocks: thinkingBlocks } : {}),
      // OpenRouter reasoning_details replayed verbatim (takes precedence over
      // reasoning_content in flattenForChat when both are present).
      ...(reasoningDetails?.length ? { reasoning_details: reasoningDetails } : {}),
    },
    { role: "user", content: toolResultParts },
  ];
}
