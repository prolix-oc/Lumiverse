import type { LlmProvider } from "../provider";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import type { GenerationRequest, GenerationResponse, StreamChunk } from "../types";

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
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Google API error ${res.status}: ${err}`);
    }

    const data = await res.json() as any;
    const candidate = data.candidates?.[0];
    const content = candidate?.content?.parts
      ?.map((p: any) => p.text || "")
      .join("") || "";

    return {
      content,
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
          const text = candidate?.content?.parts
            ?.map((p: any) => p.text || "")
            .join("") || "";
          const finishReason = candidate?.finishReason;

          if (text) {
            yield { token: text, finish_reason: finishReason === "STOP" ? "stop" : undefined };
          } else if (finishReason) {
            yield { token: "", finish_reason: finishReason === "STOP" ? "stop" : finishReason };
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

  private buildBody(request: GenerationRequest): any {
    const params = request.parameters || {};

    // Google uses a different message format
    const systemMessages = request.messages.filter((m) => m.role === "system");
    const otherMessages = request.messages.filter((m) => m.role !== "system");

    const body: any = {
      contents: otherMessages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
    };

    if (systemMessages.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemMessages.map((m) => m.content).join("\n\n") }],
      };
    }

    const generationConfig: any = {};
    if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
    if (params.max_tokens !== undefined) generationConfig.maxOutputTokens = params.max_tokens;
    if (params.top_p !== undefined) generationConfig.topP = params.top_p;
    if (params.top_k !== undefined) generationConfig.topK = params.top_k;
    if (params.stop) generationConfig.stopSequences = params.stop;

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
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
