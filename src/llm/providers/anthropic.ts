import type { LlmProvider } from "../provider";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import type { GenerationRequest, GenerationResponse, StreamChunk } from "../types";

const API_VERSION = "2023-06-01";

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly displayName = "Anthropic";
  readonly defaultUrl = "https://api.anthropic.com";

  readonly capabilities: ProviderCapabilities = {
    parameters: {
      temperature: { ...COMMON_PARAMS.temperature, max: 1 },
      max_tokens: { ...COMMON_PARAMS.max_tokens, required: true },
      top_p: COMMON_PARAMS.top_p,
      top_k: COMMON_PARAMS.top_k,
      stop: COMMON_PARAMS.stop,
    },
    requiresMaxTokens: true,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: true,
    modelListStyle: "anthropic",
  };

  private baseUrl(apiUrl: string): string {
    let url = (apiUrl || this.defaultUrl).replace(/\/+$/, "");
    // Strip path suffixes the user may have included that we append ourselves
    url = url.replace(/\/v1\/messages$/, "");
    url = url.replace(/\/v1\/models$/, "");
    url = url.replace(/\/v1$/, "");
    return url;
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
    };
  }

  async generate(apiKey: string, apiUrl: string, request: GenerationRequest): Promise<GenerationResponse> {
    const url = `${this.baseUrl(apiUrl)}/v1/messages`;
    const body = this.buildBody(request, false);

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const data = await res.json() as any;
    const textContent = (data.content || [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");

    return {
      content: textContent,
      finish_reason: data.stop_reason || "end_turn",
      usage: data.usage
        ? {
            prompt_tokens: data.usage.input_tokens,
            completion_tokens: data.usage.output_tokens,
            total_tokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined,
    };
  }

  async *generateStream(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const url = `${this.baseUrl(apiUrl)}/v1/messages`;
    const body = this.buildBody(request, true);

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
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

        try {
          const data = JSON.parse(trimmed.slice(6));

          if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
            yield { token: data.delta.text };
          } else if (data.type === "message_delta" && data.delta?.stop_reason) {
            yield { token: "", finish_reason: data.delta.stop_reason };
          } else if (data.type === "message_stop") {
            return;
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
    }
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      // Send a minimal request to check the key
      const res = await fetch(`${this.baseUrl(apiUrl)}/v1/messages`, {
        method: "POST",
        headers: this.headers(apiKey),
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      // 200 or 400 (bad request but valid auth) both indicate valid key
      return res.status !== 401 && res.status !== 403;
    } catch {
      return false;
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/v1/models`, {
        headers: this.headers(apiKey),
      });
      if (!res.ok) return [];
      const data = await res.json() as any;
      return (data.data || []).map((m: any) => m.id).sort();
    } catch {
      return [];
    }
  }

  private buildBody(request: GenerationRequest, stream: boolean): any {
    const params = request.parameters || {};

    // Separate system message from the rest
    const systemMessages = request.messages.filter((m) => m.role === "system");
    const otherMessages = request.messages.filter((m) => m.role !== "system");

    const body: any = {
      model: request.model,
      messages: otherMessages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: params.max_tokens || 4096,
      stream,
    };

    if (systemMessages.length > 0) {
      body.system = systemMessages.map((m) => m.content).join("\n\n");
    }

    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.top_p !== undefined) body.top_p = params.top_p;
    if (params.top_k !== undefined) body.top_k = params.top_k;
    if (params.stop) body.stop_sequences = params.stop;

    // Inline council tools: pass as Anthropic tool_use format
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    return body;
  }
}
