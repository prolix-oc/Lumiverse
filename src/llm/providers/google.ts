import type { LlmProvider } from "../provider";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import { getTextContent, type GenerationRequest, type GenerationResponse, type StreamChunk, type LlmMessage, type LlmMessagePart } from "../types";

export class GoogleProvider implements LlmProvider {
  readonly name = "google";
  readonly displayName = "Google Gemini";
  readonly defaultUrl = "https://generativelanguage.googleapis.com";

  readonly capabilities: ProviderCapabilities = {
    parameters: {
      temperature: { ...COMMON_PARAMS.temperature, max: 2 },
      max_tokens: COMMON_PARAMS.max_tokens,
      top_p: COMMON_PARAMS.top_p,
      top_k: COMMON_PARAMS.top_k,
      stop: COMMON_PARAMS.stop,
    },
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: true,
    modelListStyle: "google",
  };

  private baseUrl(apiUrl: string): string {
    let url = (apiUrl || this.defaultUrl).replace(/\/+$/, "");
    // Strip path suffixes the user may have included that we append ourselves
    url = url.replace(/\/v1beta\/models(\/.*)?$/, "");
    url = url.replace(/\/v1beta$/, "");
    return url;
  }

  async generate(apiKey: string, apiUrl: string, request: GenerationRequest): Promise<GenerationResponse> {
    const url = `${this.baseUrl(apiUrl)}/v1beta/models/${request.model}:generateContent?key=${apiKey}`;
    const body = this.buildBody(request);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Google API error ${res.status}: ${err}`);
    }

    const data = await res.json() as any;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    // Separate thinking parts from regular text
    let content = "";
    let reasoning = "";
    for (const p of parts) {
      if (p.thought) {
        reasoning += p.text || "";
      } else {
        content += p.text || "";
      }
    }

    return {
      content,
      reasoning: reasoning || undefined,
      finish_reason: candidate?.finishReason || "STOP",
      usage: data.usageMetadata
        ? {
            prompt_tokens: data.usageMetadata.promptTokenCount || 0,
            completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
            total_tokens: data.usageMetadata.totalTokenCount || 0,
          }
        : undefined,
    };
  }

  async *generateStream(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const url = `${this.baseUrl(apiUrl)}/v1beta/models/${request.model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const body = this.buildBody(request);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Google API error ${res.status}: ${err}`);
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
          const candidate = data.candidates?.[0];
          const parts = candidate?.content?.parts || [];
          const finishReason = candidate?.finishReason;

          // Separate thinking parts (thought: true) from regular text parts
          let text = "";
          let reasoning = "";
          for (const p of parts) {
            if (p.thought) {
              reasoning += p.text || "";
            } else {
              text += p.text || "";
            }
          }

          // Capture usage metadata (Google includes it in the final streaming chunk)
          const usage = data.usageMetadata
            ? {
                prompt_tokens: data.usageMetadata.promptTokenCount || 0,
                completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
                total_tokens: data.usageMetadata.totalTokenCount || 0,
              }
            : undefined;

          if (text || reasoning) {
            yield {
              token: text,
              reasoning: reasoning || undefined,
              finish_reason: finishReason === "STOP" ? "stop" : undefined,
              usage,
            };
          } else if (finishReason || usage) {
            yield { token: "", finish_reason: finishReason === "STOP" ? "stop" : (finishReason || undefined), usage };
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
    }
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.baseUrl(apiUrl)}/v1beta/models?key=${apiKey}`
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<string[]> {
    try {
      const res = await fetch(
        `${this.baseUrl(apiUrl)}/v1beta/models?key=${apiKey}`
      );
      if (!res.ok) return [];
      const data = await res.json() as any;
      return (data.models || [])
        .map((m: any) => m.name?.replace("models/", "") || m.name)
        .filter((n: string) => n.includes("gemini"))
        .sort();
    } catch {
      return [];
    }
  }

  /** Format message content into Google Gemini parts array, handling multipart (vision/audio) content. */
  private formatParts(m: LlmMessage): any[] {
    if (typeof m.content === "string") return [{ text: m.content }];
    return m.content.map((part: LlmMessagePart) => {
      switch (part.type) {
        case "text":
          return { text: part.text };
        case "image":
        case "audio":
          return { inlineData: { mimeType: part.mime_type, data: part.data } };
        default:
          return { text: "" };
      }
    });
  }

  /** Keys that are internal to Lumiverse and should never be sent to any provider API. */
  private static readonly INTERNAL_PARAMS = new Set(["max_context_length", "_include_usage"]);

  /** Keys explicitly handled by Google's buildBody — excluded from passthrough. */
  private static readonly HANDLED_PARAMS = new Set([
    "temperature", "max_tokens", "top_p", "top_k", "stop", "thinkingConfig",
  ]);

  private buildBody(request: GenerationRequest): any {
    const params = request.parameters || {};

    // Google uses a different message format
    const systemMessages = request.messages.filter((m) => m.role === "system");
    const otherMessages = request.messages.filter((m) => m.role !== "system");

    const body: any = {
      contents: otherMessages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: this.formatParts(m),
      })),
    };

    if (systemMessages.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemMessages.map((m) => getTextContent(m)).join("\n\n") }],
      };
    }

    const generationConfig: any = {};
    if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
    if (params.max_tokens !== undefined) generationConfig.maxOutputTokens = params.max_tokens;
    if (params.top_p !== undefined) generationConfig.topP = params.top_p;
    if (params.top_k !== undefined) generationConfig.topK = params.top_k;
    if (params.stop) generationConfig.stopSequences = params.stop;

    // Thinking configuration for Gemini 2.5+ and 3.x models
    if (params.thinkingConfig) {
      generationConfig.thinkingConfig = params.thinkingConfig;
    }

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    // Passthrough: inject extra params (e.g. from custom body) directly into the
    // top-level request body. This enables provider-specific fields like
    // safetySettings, cachedContent, etc. to reach the API.
    for (const key of Object.keys(params)) {
      if (body[key] !== undefined) continue;          // already set (e.g. generationConfig)
      if (GoogleProvider.HANDLED_PARAMS.has(key)) continue;
      if (GoogleProvider.INTERNAL_PARAMS.has(key)) continue;
      body[key] = params[key];
    }

    // Inline council tools: pass as Google function calling format
    if (request.tools && request.tools.length > 0) {
      body.tools = [{
        functionDeclarations: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }];
    }

    return body;
  }
}
