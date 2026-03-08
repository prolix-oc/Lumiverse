import type { LlmProvider } from "../provider";
import type { ProviderCapabilities } from "../param-schema";
import type { GenerationRequest, GenerationResponse, StreamChunk } from "../types";

/**
 * Abstract base class for providers that use the OpenAI-compatible
 * /chat/completions API format. Subclasses override `name`, `defaultUrl`,
 * `capabilities`, and optionally `extraHeaders` / `buildBody` / model-filtering logic.
 */
export abstract class OpenAICompatibleProvider implements LlmProvider {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly defaultUrl: string;
  abstract readonly capabilities: ProviderCapabilities;

  protected baseUrl(apiUrl: string): string {
    return (apiUrl || this.defaultUrl).replace(/\/+$/, "");
  }

  /** Override to add provider-specific headers (e.g. OpenRouter's HTTP-Referer). */
  protected extraHeaders(_apiKey: string): Record<string, string> {
    return {};
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...this.extraHeaders(apiKey),
    };
  }

  async generate(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest
  ): Promise<GenerationResponse> {
    const url = `${this.baseUrl(apiUrl)}/chat/completions`;
    const body = this.buildBody(request, false);

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(apiKey),
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
    request: GenerationRequest
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const url = `${this.baseUrl(apiUrl)}/chat/completions`;
    const body = this.buildBody(request, true);

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(apiKey),
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

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/models`, {
        headers: this.headers(apiKey),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/models`, {
        headers: this.headers(apiKey),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as any;
      return this.filterModels(data);
    } catch {
      return [];
    }
  }

  /** Override to customise model list extraction / filtering. */
  protected filterModels(data: any): string[] {
    return (data.data || []).map((m: any) => m.id).sort();
  }

  /** Build the request body using capabilities as the parameter allowlist. */
  protected buildBody(request: GenerationRequest, stream: boolean): any {
    const params = request.parameters || {};
    const allowed = this.capabilities.parameters;

    const body: any = {
      model: request.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
    };

    // Include each parameter present in both the allowlist and the request
    for (const key of Object.keys(allowed)) {
      if (params[key] !== undefined) {
        body[key] = params[key];
      }
    }

    // Handle requiresMaxTokens — inject default when max_tokens is absent
    if (this.capabilities.requiresMaxTokens && body.max_tokens === undefined) {
      body.max_tokens = allowed.max_tokens?.default ?? 4096;
    }

    // Inline council tools: pass as OpenAI function calling format
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    return body;
  }
}
