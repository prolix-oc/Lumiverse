import type { LlmProvider } from "../provider";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import { cancelStreamAndCloseConnection, createCooperativeYielder, fetchWithPreflightAbort, readJsonWithAbort, readWithAbort } from "../stream-utils";
import { getTextContent, type GenerationRequest, type GenerationResponse, type StreamChunk, type ToolCallResult, type LlmMessage, type LlmMessagePart } from "../types";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";

const GEMINI_SCHEMA_FIELDS = new Set(["type","format","title","description","nullable","enum","maxItems","minItems","properties","required","minProperties","maxProperties","minLength","maxLength","pattern","example","anyOf","propertyOrdering","default","items","minimum","maximum"]);

export function sanitizeGeminiSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (!GEMINI_SCHEMA_FIELDS.has(k)) continue;
    if (k === "items") out[k] = sanitizeGeminiSchema(v);
    else if (k === "anyOf" && Array.isArray(v)) out[k] = v.map(sanitizeGeminiSchema);
    else if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const p: Record<string, unknown> = {};
      for (const [pn, ps] of Object.entries(v as Record<string, unknown>)) p[pn] = sanitizeGeminiSchema(ps);
      out[k] = p;
    } else out[k] = v;
  }
  return out;
}

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
    // Gemini preserves reasoning across tool calls via the opaque
    // `thoughtSignature` attached to each functionCall part. generate()/
    // generateStream() capture it onto ToolCallResult.thought_signature and
    // formatParts re-emits it, so the structured continuation round-trips the
    // signature (mandatory on Gemini 3 when thinking is enabled).
    interleavedThinking: true,
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

    const res = await fetchWithPreflightAbort(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, request.signal);

    if (!res.ok) await throwProviderResponseError(this.displayName, "generate", res);

    const data = await readJsonWithAbort<any>(res, request.signal) as any;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    // Separate thinking parts from regular text, and collect function calls
    let content = "";
    let reasoning = "";
    const fnCalls: ToolCallResult[] = [];
    for (const p of parts) {
      if (p.thought) {
        reasoning += p.text || "";
      } else if (p.functionCall) {
        fnCalls.push({ name: p.functionCall.name, args: p.functionCall.args ?? {}, call_id: crypto.randomUUID(), thought_signature: p.thoughtSignature });
      } else {
        content += p.text || "";
      }
    }

    const toolCalls = fnCalls.length > 0 ? fnCalls : undefined;

    return {
      content,
      reasoning: reasoning || undefined,
      finish_reason: toolCalls ? "tool_calls" : (candidate?.finishReason || "STOP"),
      tool_calls: toolCalls,
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

    const res = await fetchWithPreflightAbort(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, request.signal);

    if (!res.ok) await throwProviderResponseError(this.displayName, "stream", res);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const maybeYield = createCooperativeYielder(64, request.signal);

    let streamDoneNaturally = false;
    try {
    while (true) {
      const { done, value } = await readWithAbort(reader, request.signal);
      if (done) { streamDoneNaturally = !request.signal?.aborted; break; }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        await maybeYield();
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        try {
          const data = JSON.parse(trimmed.slice(6));
          const candidate = data.candidates?.[0];
          const parts = candidate?.content?.parts || [];
          const finishReason = candidate?.finishReason;

          // Separate thinking parts (thought: true) from regular text parts, and collect function calls
          let text = "";
          let reasoning = "";
          const fnCalls: ToolCallResult[] = [];
          for (const p of parts) {
            if (p.thought) {
              reasoning += p.text || "";
            } else if (p.functionCall) {
              fnCalls.push({ name: p.functionCall.name, args: p.functionCall.args ?? {}, call_id: crypto.randomUUID(), thought_signature: p.thoughtSignature });
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

          const toolCalls = fnCalls.length > 0 ? fnCalls : undefined;

          if (text || reasoning || toolCalls) {
            yield {
              token: text,
              reasoning: reasoning || undefined,
              finish_reason: toolCalls ? "tool_calls" : (finishReason === "STOP" ? "stop" : undefined),
              tool_calls: toolCalls,
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
    } finally {
      if (!streamDoneNaturally) await cancelStreamAndCloseConnection(reader, res);
    }
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.baseUrl(apiUrl)}/v1beta/models?key=${apiKey}`
      );
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({
        provider: this.displayName,
        operation: "authentication",
        detail: err instanceof Error ? err.message : "network request failed",
        retryable: true,
      });
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<string[]> {
    const data = await fetchProviderJson<any>(this.displayName, "model listing", `${this.baseUrl(apiUrl)}/v1beta/models?key=${apiKey}`);
    return (data.models || [])
      .map((m: any) => m.name?.replace("models/", "") || m.name)
      .filter((n: string) => n.includes("gemini"))
      .sort();
  }

  /** Format message content into Google Gemini parts array, handling multipart (vision/audio) content. */
  private formatParts(m: LlmMessage, toolNameById: Map<string, string>): any[] {
    if (typeof m.content === "string") return [{ text: m.content }];
    return m.content.map((part: LlmMessagePart) => {
      switch (part.type) {
        case "text":
          return { text: part.text };
        case "image":
        case "audio":
          return { inlineData: { mimeType: part.mime_type, data: part.data } };
        case "tool_use":
          return { functionCall: { name: part.name, args: part.input }, thoughtSignature: part.thought_signature || "context_engineering_is_the_way_to_go" };
        case "tool_result": {
          let payload: unknown = part.content;
          try { payload = JSON.parse(part.content); } catch { /* keep as string */ }
          const key = part.is_error ? "error" : "output";
          const response: Record<string, unknown> = { [key]: payload };
          const name = toolNameById.get(part.tool_use_id) ?? "tool";
          return { functionResponse: { name, response } };
        }
        default:
          return { text: "" };
      }
    });
  }

  private buildToolNameMap(messages: readonly LlmMessage[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const m of messages) {
      if (typeof m.content === "string") continue;
      for (const p of m.content) {
        if (p.type === "tool_use") map.set(p.id, p.name);
      }
    }
    return map;
  }

  /** Keys that are internal to Lumiverse and should never be sent to any provider API. */
  private static readonly INTERNAL_PARAMS = new Set(["max_context_length", "_include_usage", "_streaming"]);

  /** Keys explicitly handled by Google's buildBody — excluded from passthrough. */
  private static readonly HANDLED_PARAMS = new Set([
    "temperature", "max_tokens", "top_p", "top_k", "stop", "thinkingConfig",
    "responseMimeType", "responseSchema", "responseJsonSchema",
  ]);

  private buildBody(request: GenerationRequest): any {
    const params = request.parameters || {};

    // Google uses a different message format
    const systemMessages = request.messages.filter((m) => m.role === "system");
    const otherMessages = request.messages.filter((m) => m.role !== "system");
    const toolNameById = this.buildToolNameMap(request.messages);

    const body: any = {
      contents: otherMessages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: this.formatParts(m, toolNameById),
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

    // Structured output: responseMimeType and responseSchema go inside generationConfig
    if (params.responseMimeType !== undefined) {
      generationConfig.responseMimeType = params.responseMimeType;
    }
    // Accept both "responseSchema" (Google's native name) and "responseJsonSchema" (alias)
    const responseSchema = params.responseSchema ?? params.responseJsonSchema;
    if (responseSchema !== undefined) {
      generationConfig.responseSchema = responseSchema;
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

    // Default safety settings: disable all content filters unless the user
    // has already provided their own safetySettings via passthrough.
    if (!body.safetySettings) {
      body.safetySettings = [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
      ];
    }

    // Inline council tools: pass as Google function calling format
    if (request.tools && request.tools.length > 0) {
      body.tools = [{
        functionDeclarations: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: sanitizeGeminiSchema(t.parameters),
        })),
      }];
    } else {
      // Insert dummy thought signature on model parts when tools are NOT in use.
      // This bypasses Google's thought signature validator for non-tool contexts.
      for (const entry of body.contents) {
        if (entry.role === "model") {
          for (const part of entry.parts) {
            part.thoughtSignature = "context_engineering_is_the_way_to_go";
          }
        }
      }
    }

    return body;
  }
}
