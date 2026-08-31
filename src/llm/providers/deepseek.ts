import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import type { GenerationRequest, LlmMessage } from "../types";

function deepSeekReasoningText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => deepSeekReasoningText(entry)).join("");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["reasoning_content", "text", "content", "reasoning", "thinking"]) {
      const part = deepSeekReasoningText(record[key]);
      if (part.length > 0) return part;
    }
  }
  return "";
}

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
    toolCalling: true,
    requiredToolChoice: true,
    nativeToolContinuation: true,
    toolContinuationMode: "native",
    toolsDisabledFinalization: true,
    supportsToolFinalization: true,
    // DeepSeek V4 thinking is on by default. Tool-call continuations must
    // replay reasoning_content; reasoning_details is an OpenRouter carrier
    // and must not replace it.
    interleavedThinking: true,
  };

  protected override buildBody(request: GenerationRequest, stream: boolean) {
    const body = super.buildBody(request, stream) as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    let hasToolCallWithoutReasoning = false;
    for (const raw of messages) {
      if (!raw || typeof raw !== "object") continue;
      const message = raw as Record<string, unknown>;
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
        continue;
      }
      const existing = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
      const fromDetails = deepSeekReasoningText(message.reasoning_details);
      const reasoning = existing.length > 0 ? existing : fromDetails;
      delete message.reasoning_details;
      if (reasoning.length > 0) {
        message.reasoning_content = reasoning;
      } else {
        hasToolCallWithoutReasoning = true;
      }
    }
    // A host-required turn is emitted with thinking disabled because DeepSeek
    // rejects thinking together with tool_choice. Keep that mode stable across
    // the native continuation: re-enabling thinking while replaying the prior
    // carrier-free assistant tool call makes DeepSeek reject the next request
    // because there is no reasoning_content to echo back. Carrier-complete
    // thinking continuations remain enabled.
    if (body.tool_choice !== undefined || hasToolCallWithoutReasoning) {
      body.thinking = { type: "disabled" };
    }
    return body;
  }

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
