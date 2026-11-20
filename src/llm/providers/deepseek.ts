import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import type { GenerationRequest, LlmMessage } from "../types";

export class DeepSeekProvider extends OpenAICompatibleProvider {
  readonly name = "deepseek";
  readonly displayName = "DeepSeek";
  readonly defaultUrl = "https://api.deepseek.com/v1";

  readonly capabilities: ProviderCapabilities = {
    parameters: {
      temperature: { ...COMMON_PARAMS.temperature, max: 2 },
      max_tokens: COMMON_PARAMS.max_tokens,
      top_p: COMMON_PARAMS.top_p,
      frequency_penalty: COMMON_PARAMS.frequency_penalty,
      presence_penalty: COMMON_PARAMS.presence_penalty,
      stop: COMMON_PARAMS.stop,
    },
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: true,
    modelListStyle: "openai",
    // DeepSeek thinking mode (deepseek-reasoner / deepseek-chat with thinking
    // enabled) round-trips its chain of thought via `reasoning_content`, which
    // `OpenAICompatibleProvider.flattenForChat` echoes back on assistant
    // tool-call turns. That lets the model keep thinking across inline tool
    // calls — interleaved thinking.
    interleavedThinking: true,
  };

  protected override replayReasoningContentOnPlainAssistant(_message: LlmMessage): boolean {
    return false;
  }

  /**
   * DeepSeek Chat Prefix Completion uses `prefix: true` on the trailing
   * assistant message. Its optional `reasoning_content` is the thinking-mode
   * prefix and is only valid alongside that flag.
   */
  protected override flattenForChat(m: LlmMessage): any[] {
    const messages = super.flattenForChat(m);
    if (!m.partial || m.role !== "assistant") return messages;

    const assistant = messages.find((message) => message.role === "assistant");
    if (!assistant) return messages;

    assistant.prefix = true;
    if (m.name) assistant.name = m.name;
    if (m.reasoning_content) assistant.reasoning_content = m.reasoning_content;
    return messages;
  }

  /**
   * Prefix completion is a beta-only DeepSeek feature. Route just those chat
   * requests from the official stable `/v1` base to `/beta`; model listing,
   * key validation, and ordinary generations remain on the configured base.
   * Explicit beta URLs and custom proxy URLs are preserved.
   */
  protected override chatCompletionsUrl(
    apiUrl: string,
    request: GenerationRequest,
  ): string {
    const hasPrefix = request.messages.some(
      (message) => message.role === "assistant" && message.partial === true,
    );
    if (!hasPrefix) return super.chatCompletionsUrl(apiUrl, request);

    const base = this.baseUrl(apiUrl);
    try {
      const url = new URL(base);
      if (url.hostname === "api.deepseek.com") {
        url.pathname = "/beta/chat/completions";
        return url.toString();
      }
    } catch {
      // Preserve malformed/custom values for the normal request error path.
    }
    return `${base}/chat/completions`;
  }
}
