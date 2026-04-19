import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import { readWithAbort } from "../stream-utils";

export class PollinationsTextProvider extends OpenAICompatibleProvider {
  readonly name = "pollinations_text";
  readonly displayName = "Pollinations (Text)";
  readonly defaultUrl = "https://text.pollinations.ai/openai";

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
    apiKeyRequired: false,
    modelListStyle: "openai",
  };

  async validateKey(_apiKey: string, _apiUrl: string): Promise<boolean> {
    return true;
  }

  async generate(
    apiKey: string,
    apiUrl: string,
    request: import("../types").GenerationRequest
  ): Promise<import("../types").GenerationResponse> {
    const url = `${this.baseUrl(apiUrl)}/chat/completions`;
    const body = this.buildBody(request, false);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${this.name} API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content || "",
      reasoning: choice?.message?.reasoning || choice?.message?.reasoning_content || undefined,
      finish_reason: choice?.finish_reason || "stop",
      usage: data.usage
        ? {
            prompt_tokens: data.usage.prompt_tokens,
            completion_tokens: data.usage.completion_tokens,
            total_tokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }

  async *generateStream(
    apiKey: string,
    apiUrl: string,
    request: import("../types").GenerationRequest
  ): AsyncGenerator<import("../types").StreamChunk, void, unknown> {
    const url = `${this.baseUrl(apiUrl)}/chat/completions`;
    const body = this.buildBody(request, true);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    // NOTE: signal intentionally NOT passed to fetch — see src/llm/stream-utils.ts.
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${this.name} API error ${res.status}: ${err}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let reasoningKey: "reasoning" | "reasoning_content" | null = null;

    try {
      while (true) {
        const { done, value } = await readWithAbort(reader, request.signal);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            const finishReason = parsed.choices?.[0]?.finish_reason;

            let reasoning: string | undefined;
            if (reasoningKey) {
              reasoning = delta?.[reasoningKey];
            } else if (delta?.reasoning !== undefined) {
              reasoningKey = "reasoning";
              reasoning = delta.reasoning;
            } else if (delta?.reasoning_content !== undefined) {
              reasoningKey = "reasoning_content";
              reasoning = delta.reasoning_content;
            }
            const content = delta?.content;

            if (reasoning || content) {
              yield { token: content || "", reasoning: reasoning || undefined, finish_reason: finishReason || undefined };
            } else if (finishReason) {
              yield { token: "", finish_reason: finishReason };
            }
          } catch {
            // Skip malformed SSE lines.
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}
