import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import type { LlmMessage } from "../types";

export class MoonshotProvider extends OpenAICompatibleProvider {
  readonly name = "moonshot";
  readonly displayName = "Moonshot";
  readonly defaultUrl = "https://api.moonshot.ai/v1";

  readonly capabilities: ProviderCapabilities = {
    parameters: {
      temperature: { ...COMMON_PARAMS.temperature, max: 2 },
      max_tokens: COMMON_PARAMS.max_tokens,
      top_p: COMMON_PARAMS.top_p,
      top_k: COMMON_PARAMS.top_k,
      frequency_penalty: COMMON_PARAMS.frequency_penalty,
      presence_penalty: COMMON_PARAMS.presence_penalty,
      stop: COMMON_PARAMS.stop,
    },
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: true,
    modelListStyle: "openai",
    toolCalling: true,
    requiredToolChoice: true,
    nativeToolContinuation: true,
    toolContinuationMode: "native",
    toolsDisabledFinalization: true,
    supportsToolFinalization: true,
    // Kimi K2/K3 Thinking is end-to-end trained to interleave chain-of-thought
    // with tool calls. Like DeepSeek it carries reasoning via `reasoning_content`
    // (streamed before `content`), which the inherited
    // OpenAICompatibleProvider.flattenForChat echoes back on assistant tool-call
    // turns — so the generation loop's structured continuation keeps the model
    // reasoning across tool calls. K2.x uses `thinking: { type: "enabled" }` (with
    // optional `keep: "all"` for preserved thinking); K3 uses top-level
    // `reasoning_effort: "max"`. Moonshot recommends max_tokens >= 16000 and
    // temperature = 1.0 for thinking models.
    interleavedThinking: true,
  };

  protected override replayReasoningContentOnPlainAssistant(_message: LlmMessage): boolean {
    return false;
  }

  /**
   * Kimi Partial Mode is enabled per message, not with a top-level request
   * parameter. A trailing assistant prefill must therefore be serialized as
   * `{ role: "assistant", content, partial: true }`. When this is resuming a
   * thinking response, Moonshot also requires the prior `reasoning_content`.
   *
   * Keep the extension here rather than in OpenAICompatibleProvider: `partial`
   * is a Moonshot/Kimi-specific field and other OpenAI-compatible APIs reject
   * it.
   */
  protected override flattenForChat(m: LlmMessage): any[] {
    const messages = super.flattenForChat(m);
    if (!m.partial || m.role !== "assistant") return messages;

    const assistant = messages.find((message) => message.role === "assistant");
    if (!assistant) return messages;

    assistant.partial = true;
    if (m.name) assistant.name = m.name;
    if (m.reasoning_content) assistant.reasoning_content = m.reasoning_content;
    return messages;
  }
}
