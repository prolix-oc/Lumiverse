import type { LlmProvider } from "../provider";
import type { ProviderCapabilities } from "../param-schema";
import type { GenerationRequest, GenerationResponse, StreamChunk, LlmMessage, LlmMessagePart } from "../types";

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
    let url = (apiUrl || this.defaultUrl).replace(/\/+$/, "");
    // Strip path suffixes the user may have included that we append ourselves
    url = url.replace(/\/chat\/completions$/, "");
    url = url.replace(/\/models$/, "");
    return url;
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
    // Auto-detect reasoning field: modern APIs use `reasoning`, legacy uses
    // `reasoning_content`. Lock to whichever key appears first so we don't
    // check both on every chunk.
    let reasoningKey: "reasoning" | "reasoning_content" | null = null;

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

          // Resolve reasoning from the detected key, or auto-detect on first occurrence
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

          // Usage data arrives in the final chunk when stream_options.include_usage is true
          const usage = parsed.usage
            ? {
                prompt_tokens: parsed.usage.prompt_tokens || 0,
                completion_tokens: parsed.usage.completion_tokens || 0,
                total_tokens: parsed.usage.total_tokens || 0,
              }
            : undefined;

          if (reasoning || content) {
            yield {
              token: content || "",
              reasoning: reasoning || undefined,
              finish_reason: finishReason || undefined,
              usage,
            };
          } else if (finishReason || usage) {
            yield { token: "", finish_reason: finishReason || undefined, usage };
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

  /** Format message content for the OpenAI API, handling multipart (vision/audio) content. */
  protected formatContent(m: LlmMessage): string | any[] {
    if (typeof m.content === "string") return m.content;
    return m.content.map((part: LlmMessagePart) => {
      switch (part.type) {
        case "text":
          return { type: "text", text: part.text };
        case "image":
          return { type: "image_url", image_url: { url: `data:${part.mime_type};base64,${part.data}` } };
        case "audio":
          return { type: "input_audio", input_audio: { data: part.data, format: part.mime_type.split("/")[1] } };
        default:
          return { type: "text", text: "" };
      }
    });
  }

  /** Keys that are internal to Lumiverse and should never be sent to any provider API. */
  private static readonly INTERNAL_PARAMS = new Set(["max_context_length", "_include_usage"]);

  /** Build the request body using capabilities as the parameter allowlist. */
  protected buildBody(request: GenerationRequest, stream: boolean): any {
    const params = request.parameters || {};
    const allowed = this.capabilities.parameters;

    const body: any = {
      model: request.model,
      messages: request.messages.map((m) => ({ role: m.role, content: this.formatContent(m) })),
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

    // Passthrough: include extra params (e.g. from custom body) not in the
    // allowlist and not internal. This enables provider-specific params like
    // reasoning_effort, seed, response_format, etc. to reach the API.
    for (const key of Object.keys(params)) {
      if (body[key] !== undefined) continue;          // already set by allowlist
      if (allowed[key]) continue;                     // in allowlist but undefined — skip
      if (OpenAICompatibleProvider.INTERNAL_PARAMS.has(key)) continue;
      body[key] = params[key];
    }

    // Request token usage in streaming responses when _include_usage is set
    if (stream && params._include_usage) {
      body.stream_options = { include_usage: true };
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
