import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";

export class PollinationsProvider extends OpenAICompatibleProvider {
  readonly name = "pollinations";
  readonly displayName = "Pollinations";
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

  protected extraHeaders(apiKey: string): Record<string, string> {
    // Omit authorization header when no key is provided
    if (!apiKey) return {};
    return {};
  }

  async generate(
    apiKey: string,
    apiUrl: string,
    request: import("../types").GenerationRequest
  ): Promise<import("../types").GenerationResponse> {
    // Override headers to skip auth when key is empty
    const url = `${this.baseUrl(apiUrl)}/chat/completions`;
    const body = this.buildBody(request, false);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${this.name} API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content || "",
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

    while (true) {
      const { done, value } = await reader.read();
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

          if (delta?.content) {
            yield { token: delta.content, finish_reason: finishReason || undefined };
          } else if (finishReason) {
            yield { token: "", finish_reason: finishReason };
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
    }
  }
}
