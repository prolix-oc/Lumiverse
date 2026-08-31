import type { LlmProvider } from "../provider";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import {
  createBoundedSseReader,
  ProviderProtocolError,
  ProviderResponseTooLargeError,
  PROVIDER_STREAM_LIMITS,
  fetchWithPreflightAbort,
  readJsonWithAbort,
  yieldToEventLoop,
} from "../stream-utils";
import { getTextContent, type GenerationRequest, type GenerationResponse, type GenerationUsage, type StreamChunk, type ToolCallResult, type LlmMessage, type LlmMessagePart } from "../types";
import { parseModelToolArguments } from "../tool-arguments";
import { AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES } from "../../services/agent-runtime-accounting";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import {
  appendGoogleSearchTool,
  buildGoogleSearchTool,
  GOOGLE_SEARCH_HANDLED_PARAMS,
  GOOGLE_SEARCH_PARAMETERS,
} from "./google-search";
import { splitLeadingSystemMessagePrefix } from "../system-message-prefix";

/**
 * Delegate provider-controlled arguments to the strict shared parser while
 * preserving the ToolCallResult carrier type used by both Gemini adapters.
 */
function parseGoogleToolArguments(raw: unknown): ToolCallResult["args"] {
  return parseModelToolArguments(raw) as ToolCallResult["args"];
}

const GEMINI_OPTIONAL_USAGE_FIELDS = [
  "cachedContentTokenCount",
  "toolUsePromptTokenCount",
  "thoughtsTokenCount",
] as const;

function readGeminiUsageCount(
  usage: Record<string, unknown>,
  field: string,
  providerName: string,
): number {
  const value = usage[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProviderProtocolError(`${providerName} usageMetadata.${field} must be a non-negative safe integer`);
  }
  return value as number;
}

/**
 * Convert Gemini's usageMetadata only after checking all canonical counts and
 * every optional token-count field that is present. Provider usage is
 * untrusted wire data and must never be normalized through `|| 0`.
 */
export function parseGeminiUsageMetadata(
  raw: unknown,
  providerName: string,
  groundingMetadata?: unknown,
): GenerationUsage | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProviderProtocolError(`${providerName} usageMetadata is malformed`);
  }
  const usage = raw as Record<string, unknown>;
  const promptTokens = readGeminiUsageCount(usage, "promptTokenCount", providerName);
  const completionTokens = readGeminiUsageCount(usage, "candidatesTokenCount", providerName);
  const totalTokens = readGeminiUsageCount(usage, "totalTokenCount", providerName);
  for (const field of GEMINI_OPTIONAL_USAGE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(usage, field)) {
      readGeminiUsageCount(usage, field, providerName);
    }
  }
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(groundingMetadata !== undefined ? { provider_raw: { groundingMetadata } } : {}),
  };
}
/**
 * Check a complete merged function-call argument object. Streaming providers
 * often send successive object fragments; checking only each fragment leaves
 * the merged carrier unbounded.
 */
export function assertGeminiFunctionCallArguments(
  args: Record<string, unknown>,
  providerName: string,
): void {
  const bytes = Buffer.byteLength(JSON.stringify(args), "utf8");
  if (bytes > PROVIDER_STREAM_LIMITS.maxArgumentsBytes) {
    throw new ProviderResponseTooLargeError(
      `${providerName} functionCall arguments exceeded their bounded carrier`,
      PROVIDER_STREAM_LIMITS.maxArgumentsBytes,
      bytes,
    );
  }
}

export function mergeGeminiFunctionCallArguments(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
  providerName: string,
): Record<string, unknown> {
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (
      Object.prototype.hasOwnProperty.call(merged, key) &&
      JSON.stringify(merged[key]) !== JSON.stringify(value)
    ) {
      throw new ProviderProtocolError(`${providerName} functionCall arguments changed during streaming`);
    }
    Object.defineProperty(merged, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  assertGeminiFunctionCallArguments(merged, providerName);
  return merged;
}

/**
 * Count every provider-supplied signature before it is assigned to a call
 * carrier. Repeated signatures are still charged: otherwise an upstream can
 * send unbounded signature fragments while each individual assignment looks
 * harmless.
 */
export class GeminiThoughtSignatureAccumulator {
  private totalBytes = 0;

  private reserve(raw: string, providerName: string, label: string): string {
    const bytes = Buffer.byteLength(raw, "utf8");
    const nextBytes = this.totalBytes + bytes;
    if (!Number.isSafeInteger(nextBytes) || nextBytes > AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES) {
      throw new ProviderResponseTooLargeError(
        `${providerName} ${label} exceeded their bounded reasoning carrier`,
        AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES,
        nextBytes,
      );
    }
    this.totalBytes = nextBytes;
    return raw;
  }

  add(raw: unknown, providerName: string): string | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== "string") {
      throw new ProviderProtocolError(`${providerName} thought signature is malformed`);
    }
    return this.reserve(raw, providerName, "thought signatures");
  }

  /** Reserve provider-authored reasoning text before concatenation or yield. */
  addText(raw: string, providerName: string): string {
    return this.reserve(raw, providerName, "reasoning text");
  }
}

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
      ...GOOGLE_SEARCH_PARAMETERS,
    },
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: true,
    modelListStyle: "google",
    toolCalling: true,
    requiredToolChoice: true,
    nativeToolContinuation: true,
    toolContinuationMode: "native",
    toolsDisabledFinalization: true,
    supportsToolFinalization: true,
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

    if (!res.ok) await throwProviderResponseError(
      this.displayName,
      "generate",
      res,
      request.signal,
      request.receiveLimitBytes,
    );

    const data = await readJsonWithAbort<any>(res, request.signal, request.receiveLimitBytes) as any;
    if (!data || typeof data !== "object" || !Array.isArray(data.candidates)) {
      throw new ProviderProtocolError("Gemini response shape is invalid");
    }
    const candidate = data.candidates[0];
    if (!candidate || typeof candidate !== "object") {
      throw new ProviderProtocolError("Gemini response candidate is missing");
    }
    if (!candidate.content || typeof candidate.content !== "object" || !Array.isArray(candidate.content.parts)) {
      throw new ProviderProtocolError("Gemini response content parts are invalid");
    }
    const parts = candidate.content.parts;
    let content = "";
    let reasoning = "";
    const fnCalls: ToolCallResult[] = [];
    const seenIds = new Set<string>();
    const thoughtSignatures = new GeminiThoughtSignatureAccumulator();
    for (const p of parts) {
      if (!p || typeof p !== "object") throw new ProviderProtocolError("Gemini response part is malformed");
      if (p.thought !== undefined && typeof p.thought !== "boolean") {
        throw new ProviderProtocolError("Gemini thought marker is malformed");
      }
      if (p.thoughtSignature !== undefined && !p.functionCall) {
        thoughtSignatures.add(p.thoughtSignature, this.displayName);
      }
      if (p.thought) {
        if (typeof p.text !== "string") throw new ProviderProtocolError("Gemini reasoning part is malformed");
        reasoning += thoughtSignatures.addText(p.text, this.displayName);
      } else if (p.functionCall) {
        const call = p.functionCall;
        if (!call || typeof call !== "object" || typeof call.name !== "string" || call.name.length === 0) {
          throw new ProviderProtocolError("Gemini functionCall is malformed");
        }
        if (fnCalls.length >= PROVIDER_STREAM_LIMITS.maxCalls) {
          throw new ProviderResponseTooLargeError("Gemini call count exceeded its limit", PROVIDER_STREAM_LIMITS.maxCalls, fnCalls.length + 1);
        }
        const args = parseGoogleToolArguments(call.args);
        assertGeminiFunctionCallArguments(args, this.displayName);
        const thoughtSignature = thoughtSignatures.add(p.thoughtSignature, this.displayName);
        const callId = typeof call.id === "string" && call.id.length > 0 ? call.id : crypto.randomUUID();
        if (seenIds.has(callId)) throw new ProviderProtocolError("Gemini native tool call IDs must be unique");
        seenIds.add(callId);
        fnCalls.push({ name: call.name, args, call_id: callId, thought_signature: thoughtSignature });
      } else if (typeof p.text === "string") {
        content += p.text;
      } else if (p.text !== undefined) {
        throw new ProviderProtocolError("Gemini text part is malformed");
      }
    }
    if (candidate.finishReason !== undefined && typeof candidate.finishReason !== "string") {
      throw new ProviderProtocolError("Gemini finishReason must be a string");
    }
    const thoughtSignature = this.getNonToolThoughtSignature(
      parts,
      request.parameters?._replay_thought_signatures === true,
    );

    const toolCalls = fnCalls.length > 0 ? fnCalls : undefined;
    const groundingMetadata = candidate.groundingMetadata ?? data.groundingMetadata;

    return {
      content,
      reasoning: reasoning || undefined,
      finish_reason: toolCalls ? "tool_calls" : (candidate?.finishReason || "STOP"),
      tool_calls: toolCalls,
      ...(thoughtSignature ? { thought_signature: thoughtSignature } : {}),
      usage: parseGeminiUsageMetadata(data.usageMetadata, this.displayName, groundingMetadata),
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

    if (!res.ok) await throwProviderResponseError(
      this.displayName,
      "stream",
      res,
      request.signal,
      request.receiveLimitBytes,
    );

    const sse = createBoundedSseReader(res, request.signal, {
      maxResponseBytes: request.receiveLimitBytes,
      requireTerminal: false,
    });
    const toolCallBuffer = new Map<number, {
      name: string;
      args: ToolCallResult["args"];
      callId: string;
      thoughtSignature?: string;
    }>();
    let eventCount = 0;
    const seenNativeIds = new Set<string>();
    let lastNewToolIndex = -1;
    const thoughtSignatures = new GeminiThoughtSignatureAccumulator();
    let terminalFinishReason: string | undefined;
    let finalUsage: StreamChunk["usage"];

    for await (const event of sse) {
      if (request.signal?.aborted) {
        throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      eventCount += 1;
      if (eventCount % 64 === 0) await yieldToEventLoop(request.signal);
      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch (error) {
        throw new ProviderProtocolError("Malformed Gemini SSE JSON", { cause: error });
      }
      if (event.event !== undefined && event.event !== "message") {
        throw new ProviderProtocolError("Gemini SSE event name does not match its payload");
      }
      if (!data || typeof data !== "object" || !Array.isArray(data.candidates)) {
        throw new ProviderProtocolError("Gemini SSE payload is malformed");
      }
      const candidate = data.candidates[0];
      if (!candidate || typeof candidate !== "object") {
        throw new ProviderProtocolError("Gemini SSE candidate is missing");
      }
      const parts = candidate.content?.parts;
      if (parts !== undefined && !Array.isArray(parts)) {
        throw new ProviderProtocolError("Gemini SSE candidate parts must be an array");
      }
      let text = "";
      let reasoning = "";
      for (let partIndex = 0; partIndex < (parts?.length ?? 0); partIndex += 1) {
        const part = parts[partIndex];
        if (!part || typeof part !== "object") throw new ProviderProtocolError("Gemini SSE part is malformed");
        if (part.thought !== undefined && typeof part.thought !== "boolean") {
          throw new ProviderProtocolError("Gemini thought marker is malformed");
        }
        if (part.thoughtSignature !== undefined && !part.functionCall) {
          thoughtSignatures.add(part.thoughtSignature, this.displayName);
        }
        if (part.thought) {
          if (typeof part.text !== "string") throw new ProviderProtocolError("Gemini reasoning part is malformed");
          reasoning += thoughtSignatures.addText(part.text, this.displayName);
        } else if (part.functionCall) {
          const call = part.functionCall;
          if (!call || typeof call !== "object" || typeof call.name !== "string" || call.name.length === 0) {
            throw new ProviderProtocolError("Gemini functionCall is malformed");
          }
          if (call.id !== undefined && (typeof call.id !== "string" || call.id.length === 0)) {
            throw new ProviderProtocolError("Gemini functionCall ID is malformed");
          }
          const existing = toolCallBuffer.get(partIndex);
          if (!existing && partIndex <= lastNewToolIndex) {
            throw new ProviderProtocolError("Gemini functionCall parts arrived out of order");
          }
          let parsedArgs: ToolCallResult["args"] | undefined;
          if (call.args !== undefined) {
            if (!call.args || typeof call.args !== "object" || Array.isArray(call.args)) {
              throw new ProviderProtocolError("Gemini functionCall args must be an object");
            }
            parsedArgs = parseGoogleToolArguments(call.args);
            assertGeminiFunctionCallArguments(parsedArgs, this.displayName);
          } else if (!existing) {
            throw new ProviderProtocolError("Gemini functionCall is missing arguments");
          }

          if (!existing) {
            if (toolCallBuffer.size >= PROVIDER_STREAM_LIMITS.maxCalls) {
              throw new ProviderResponseTooLargeError(
                "Gemini call count exceeded its limit",
                PROVIDER_STREAM_LIMITS.maxCalls,
                toolCallBuffer.size + 1,
              );
            }
            const callId = call.id ?? crypto.randomUUID();
            if (seenNativeIds.has(callId)) {
              throw new ProviderProtocolError("Gemini native tool call IDs must be unique");
            }
            const thoughtSignature = thoughtSignatures.add(part.thoughtSignature, this.displayName);
            seenNativeIds.add(callId);
            lastNewToolIndex = partIndex;
            toolCallBuffer.set(partIndex, {
              name: call.name,
              args: parsedArgs ?? {},
              callId,
              thoughtSignature,
            });
          } else {
            if (call.id !== undefined && call.id !== existing.callId) {
              throw new ProviderProtocolError("Gemini functionCall ID changed during streaming");
            }
            if (call.name !== existing.name) {
              throw new ProviderProtocolError("Gemini functionCall name changed during streaming");
            }
            if (parsedArgs) {
              existing.args = mergeGeminiFunctionCallArguments(existing.args, parsedArgs, this.displayName);
            }
            const thoughtSignature = thoughtSignatures.add(part.thoughtSignature, this.displayName);
            if (thoughtSignature !== undefined) {
              if (existing.thoughtSignature && existing.thoughtSignature !== thoughtSignature) {
                throw new ProviderProtocolError("Gemini thought signature changed during streaming");
              }
              existing.thoughtSignature = thoughtSignature;
            }
          }
        } else if (typeof part.text === "string") {
          text += part.text;
        } else if (part.text !== undefined) {
          throw new ProviderProtocolError("Gemini text part is malformed");
        }
      }

      const groundingMetadata = candidate.groundingMetadata ?? data.groundingMetadata;
      const usage = parseGeminiUsageMetadata(data.usageMetadata, this.displayName, groundingMetadata);
      const finishReason = candidate.finishReason;
      if (finishReason !== undefined && finishReason !== null && typeof finishReason !== "string") {
        throw new ProviderProtocolError("Gemini finishReason must be a string");
      }
      const toolCalls = toolCallBuffer.size > 0
        ? [...toolCallBuffer.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, call]) => ({
            name: call.name,
            args: call.args,
            call_id: call.callId,
            thought_signature: call.thoughtSignature,
          }))
        : undefined;
      const thoughtSignature = this.getNonToolThoughtSignature(
        parts ?? [],
        request.parameters?._replay_thought_signatures === true,
      );

      if (finishReason) {
        terminalFinishReason = toolCalls
          ? "tool_calls"
          : finishReason === "STOP" ? "stop" : finishReason;
      }
      if (usage) finalUsage = usage;

      if (text || reasoning || thoughtSignature) {
        yield {
          token: text,
          reasoning: reasoning || undefined,
          ...(thoughtSignature ? { thought_signature: thoughtSignature } : {}),
          usage,
        };
      } else if (usage) {
        yield { token: "", usage };
      }
    }

    if (!terminalFinishReason) {
      throw new ProviderProtocolError("Gemini stream ended without a finish reason");
    }
    const toolCalls = toolCallBuffer.size > 0
      ? [...toolCallBuffer.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => ({
          name: call.name,
          args: call.args,
          call_id: call.callId,
          thought_signature: call.thoughtSignature,
        }))
      : undefined;
    yield {
      token: "",
      finish_reason: terminalFinishReason,
      tool_calls: toolCalls,
      usage: finalUsage,
    };
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
  private getNonToolThoughtSignature(parts: any[], enabled: boolean): string | undefined {
    if (!enabled) return undefined;
    for (let index = parts.length - 1; index >= 0; index--) {
      const part = parts[index];
      if (!part?.functionCall && typeof part?.thoughtSignature === "string") {
        return part.thoughtSignature;
      }
    }
    return undefined;
  }

  private formatParts(
    m: LlmMessage,
    toolNameById: Map<string, string>,
    replayThoughtSignatures: boolean,
  ): any[] {
    if (typeof m.content === "string") {
      return [{
        text: m.content,
        ...(m.role === "assistant" && replayThoughtSignatures && m.thought_signature
          ? { thoughtSignature: m.thought_signature }
          : {}),
      }];
    }
    const formatted = m.content.map((part: LlmMessagePart) => {
      switch (part.type) {
        case "text":
          return {
            text: part.text,
            ...(m.role === "assistant" && replayThoughtSignatures && part.thought_signature
              ? { thoughtSignature: part.thought_signature }
              : {}),
          };
        case "image":
        case "audio":
          return { inlineData: { mimeType: part.mime_type, data: part.data } };
        case "tool_use":
          return { functionCall: { name: part.name, args: part.input }, thoughtSignature: part.thought_signature || "context_engineering_is_the_way_to_go" };
        case "tool_result": {
          const name = toolNameById.get(part.tool_use_id);
          if (!name) {
            throw new ProviderProtocolError("Gemini tool result references an unknown tool call");
          }
          let payload: unknown = part.content;
          try { payload = JSON.parse(part.content); } catch { /* keep as string */ }
          const key = part.is_error ? "error" : "output";
          const response: Record<string, unknown> = { [key]: payload };
          return { functionResponse: { name, response } };
        }
        default:
          return { text: "" };
      }
    });
    if (m.role === "assistant" && replayThoughtSignatures && m.thought_signature) {
      const target = [...formatted].reverse().find((part) =>
        Object.hasOwn(part, "text") || Object.hasOwn(part, "inlineData"),
      );
      if (target) target.thoughtSignature = m.thought_signature;
    }
    return formatted;
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
  private static readonly INTERNAL_PARAMS = new Set([
    "max_context_length", "_include_usage", "_streaming", "_replay_thought_signatures",
  ]);
  /** Tool controls are scrubbed only for host-owned feature modes. */
  private static readonly TOOL_CONTROL_PARAMS = new Set([
    "tools", "tool_choice", "parallel_tool_calls", "functions", "function_call",
    "plugins", "web_search", "google_search", "enable_web_search", "enableSearch",
  ]);

  /** Keys explicitly handled by Google's buildBody — excluded from passthrough. */
  private static readonly HANDLED_PARAMS = new Set([
    "temperature", "max_tokens", "top_p", "top_k", "stop", "thinkingConfig",
    "responseMimeType", "responseSchema", "responseJsonSchema",
    ...GOOGLE_SEARCH_HANDLED_PARAMS,
  ]);

  private buildBody(request: GenerationRequest): any {
    if (request.toolMode === "required" && !this.capabilities.requiredToolChoice) {
      throw new Error("Provider does not support required tool choice");
    }
    const params = request.parameters || {};

    // Gemini has one top-level systemInstruction, so lift only the contiguous
    // leading prefix. Later system messages are mapped to user-role contents
    // at their assembled positions instead of being hoisted out of history.
    const { prefix: systemMessages, remainder: otherMessages } =
      splitLeadingSystemMessagePrefix(request.messages);
    const toolNameById = this.buildToolNameMap(request.messages);
    const replayThoughtSignatures = params._replay_thought_signatures === true;
    const functionTools = request.tools ?? [];
    const hasFunctionDeclarations = functionTools.length > 0;
    const googleSearchTool = buildGoogleSearchTool(
      this.name,
      request.model,
      params,
      hasFunctionDeclarations,
    );

    const body: any = {
      contents: otherMessages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: this.formatParts(m, toolNameById, replayThoughtSignatures),
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
      if (request.toolMode && GoogleProvider.TOOL_CONTROL_PARAMS.has(key)) continue;
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

    if (request.toolMode === "finalization") {
      delete body.tools;
      body.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    } else if (request.toolMode === "required") {
      if (!hasFunctionDeclarations) throw new Error("Required tool mode needs at least one admitted host tool");
      body.tools = [{
        functionDeclarations: functionTools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: sanitizeGeminiSchema(t.parameters),
        })),
      }];
      body.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    } else if (request.toolMode === "ordinary") {
      if (hasFunctionDeclarations) {
        body.tools = [{
          functionDeclarations: functionTools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: sanitizeGeminiSchema(t.parameters),
          })),
        }];
      } else {
        delete body.tools;
        body.toolConfig = { functionCallingConfig: { mode: "NONE" } };
      }
    } else if (hasFunctionDeclarations) {
      body.tools = [{
        functionDeclarations: functionTools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: sanitizeGeminiSchema(t.parameters),
        })),
      }];
    } else {
      // Insert dummy thought signature on model parts when tools are NOT in use.
      for (const entry of body.contents) {
        if (entry.role === "model") {
          for (const part of entry.parts) {
            if (!part.thoughtSignature) {
              part.thoughtSignature = "context_engineering_is_the_way_to_go";
            }
          }
        }
      }
    }

    if (!request.toolMode) appendGoogleSearchTool(this.name, body, googleSearchTool);

    return body;
  }
}
