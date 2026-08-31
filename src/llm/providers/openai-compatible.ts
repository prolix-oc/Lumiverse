import type { LlmProvider } from "../provider";
import type { ProviderCapabilities } from "../param-schema";
import {
  createBoundedSseReader,
  ProviderProtocolError,
  ProviderResponseTooLargeError,
  PROVIDER_STREAM_LIMITS,
  readJsonWithAbort,
  yieldToEventLoop,
  fetchWithPreflightAbort,
} from "../stream-utils";
import type {
  GenerationRequest,
  GenerationResponse,
  GenerationUsage,
  StreamChunk,
  ToolCallResult,
  LlmMessage,
  LlmMessagePart,
} from "../types";
import { parseModelToolArguments } from "../tool-arguments";
import { AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES } from "../../services/agent-runtime-accounting";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";

const GENERATE_OPERATION = "generate";
const STREAM_OPERATION = "stream";

/** Streamable text-ish fields within a reasoning_details block that are
 *  concatenated across chunks; everything else (type/id/format/index) is set. */
const REASONING_DETAIL_APPEND_FIELDS = new Set([
  "text",
  "summary",
  "data",
  "signature",
]);

function usageRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderProtocolError(`${label} usage must be an object`);
  }
  return value as Record<string, unknown>;
}

function usageCount(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProviderProtocolError(`${label} usage ${key} must be a finite nonnegative safe integer`);
  }
  return value as number;
}

/** Validate the canonical Chat Completions usage shape before forwarding it. */
export function parseOpenAIUsage(
  value: unknown,
  allowStreamingNull = false,
): GenerationUsage | undefined {
  if (value === undefined) return undefined;
  if (value === null && allowStreamingNull) return undefined;
  const record = usageRecord(value, "OpenAI");
  const promptTokens = usageCount(record, "prompt_tokens", "OpenAI");
  const completionTokens = usageCount(record, "completion_tokens", "OpenAI");
  const totalTokens = usageCount(record, "total_tokens", "OpenAI");
  if (promptTokens > Number.MAX_SAFE_INTEGER - completionTokens) {
    throw new ProviderProtocolError("OpenAI usage total exceeds safe integer range");
  }
  if (totalTokens !== promptTokens + completionTokens) {
    throw new ProviderProtocolError("OpenAI usage total_tokens does not match prompt_tokens plus completion_tokens");
  }
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    provider_raw: { ...record },
  };
}

/** Validate the input/output usage shape emitted by the Responses API. */
export function parseOpenAIResponsesUsage(
  value: unknown,
  allowStreamingNull = false,
): GenerationUsage | undefined {
  if (value === undefined) return undefined;
  if (value === null && allowStreamingNull) return undefined;
  const record = usageRecord(value, "OpenAI Responses");
  const promptTokens = usageCount(record, "input_tokens", "OpenAI Responses");
  const completionTokens = usageCount(record, "output_tokens", "OpenAI Responses");
  if (promptTokens > Number.MAX_SAFE_INTEGER - completionTokens) {
    throw new ProviderProtocolError("OpenAI Responses usage total exceeds safe integer range");
  }
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    provider_raw: { ...record },
  };
}

function reasoningValueBytes(value: unknown): number {
  if (typeof value === "string") {
    return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new ProviderProtocolError("OpenAI reasoning_details field is not serializable", { cause: error });
  }
  if (serialized === undefined) {
    throw new ProviderProtocolError("OpenAI reasoning_details field is malformed");
  }
  return Buffer.byteLength(serialized, "utf8");
}
export function jsonStringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
/** Exact JSON-string byte size after appending a fragment without allocating the combined string. */
export function jsonStringBytesWithAppend(prefix: string, suffix: string): number {
  let bytes = 2;
  let pendingHighSurrogate: number | undefined;
  const consume = (value: string): void => {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (pendingHighSurrogate !== undefined) {
        if (code >= 0xdc00 && code <= 0xdfff) {
          bytes += 4;
          pendingHighSurrogate = undefined;
          continue;
        }
        bytes += 6;
        pendingHighSurrogate = undefined;
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        pendingHighSurrogate = code;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        bytes += 6;
      } else if (code === 0x22 || code === 0x5c) {
        bytes += 2;
      } else if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
        bytes += 2;
      } else if (code < 0x20) {
        bytes += 6;
      } else {
        bytes += Buffer.byteLength(String.fromCharCode(code), "utf8");
      }
    }
  };
  consume(prefix);
  consume(suffix);
  if (pendingHighSurrogate !== undefined) bytes += 6;
  return bytes;
}


export class ReasoningDetailsAccumulator {
  private byIndex = new Map<number, Record<string, unknown>>();
  private order = 0;
  private seen = false;
  /** Current structured details plus streamed reasoning text, never history. */
  private bytes = 0;

  private reserve(nextBytes: number, label: string): void {
    if (!Number.isSafeInteger(nextBytes) || nextBytes > AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES) {
      throw new ProviderResponseTooLargeError(
        `OpenAI ${label} exceeded its bounded reasoning carrier`,
        AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES,
        nextBytes,
      );
    }
    this.bytes = nextBytes;
  }

  /** Reserve a plain reasoning fragment before its caller yields or appends it. */
  reserveText(fragment: string): void {
    const fragmentBytes = Buffer.byteLength(fragment, "utf8");
    this.reserve(this.bytes + fragmentBytes, "reasoning");
  }

  push(incoming: unknown): void {
    // Ordinary Response-mode provider payloads historically treated absent,
    // non-array, and malformed reasoning_details as optional opaque metadata.
    // Keep that tolerant ingress here; Agentic validation happens at its
    // protocol boundary instead. Oversized valid values still fail closed
    // through the bounded accumulator below.
    if (!Array.isArray(incoming)) return;
    for (const d of incoming) {
      if (!d || typeof d !== "object" || Array.isArray(d)) continue;

      const rec = d as Record<string, unknown>;
      let entries: [string, unknown][];
      let idx: number;
      let implicitIndex = false;
      try {
        entries = Object.entries(rec);
        if (Object.hasOwn(rec, "index")) {
          if (!Number.isSafeInteger(rec.index) || (rec.index as number) < 0) continue;
          idx = rec.index as number;
        } else {
          idx = this.order;
          implicitIndex = true;
        }
      } catch {
        continue;
      }

      let malformed = false;
      for (const [key, value] of entries) {
        if (key === "index") continue;
        try {
          if (JSON.stringify(value) === undefined) {
            malformed = true;
            break;
          }
        } catch {
          malformed = true;
          break;
        }
      }
      if (malformed) continue;

      this.seen = true;
      const existing = this.byIndex.get(idx);
      if (!existing && this.byIndex.size >= PROVIDER_STREAM_LIMITS.maxCalls) {
        throw new ProviderResponseTooLargeError(
          `OpenAI reasoning_details exceeded ${PROVIDER_STREAM_LIMITS.maxCalls} blocks`,
          PROVIDER_STREAM_LIMITS.maxCalls,
          this.byIndex.size + 1,
        );
      }

      const candidate: Record<string, unknown> = existing ? { ...existing } : {};
      let nextBytes = this.bytes;
      for (const [key, value] of entries) {
        // The block index is a routing field, not carrier text/metadata.
        if (key === "index") {
          candidate[key] = value;
          continue;
        }
        const valueBytes = reasoningValueBytes(value);
        if (valueBytes > AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES) {
          throw new ProviderResponseTooLargeError(
            `OpenAI reasoning_details field ${key} exceeded its bounded length`,
            AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES,
            valueBytes,
          );
        }
        const previous = Object.hasOwn(candidate, key) ? candidate[key] : undefined;
        const hasPrevious = Object.hasOwn(candidate, key);
        const previousBytes = hasPrevious ? reasoningValueBytes(previous) : 0;
        const keyBytes = Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
        const previousKeyBytes = hasPrevious ? keyBytes : 0;
        const append =
          REASONING_DETAIL_APPEND_FIELDS.has(key) &&
          typeof value === "string" &&
          typeof previous === "string";
        const nextValueBytes = append
          ? jsonStringBytesWithAppend(previous as string, value) - 2
          : valueBytes;
        nextBytes = append
          ? nextBytes - previousBytes + nextValueBytes
          : nextBytes - previousBytes - previousKeyBytes + keyBytes + nextValueBytes;
        if (!Number.isSafeInteger(nextBytes) || nextBytes > AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES) {
          throw new ProviderResponseTooLargeError(
            "OpenAI reasoning_details exceeded its bounded carrier",
            AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES,
            nextBytes,
          );
        }
        candidate[key] = append ? previous + value : value;
      }
      if (implicitIndex) this.order += 1;
      if (existing) Object.assign(existing, candidate);
      else this.byIndex.set(idx, candidate);
      this.bytes = nextBytes;
    }
  }

  finalize(): Record<string, unknown>[] | undefined {
    if (!this.seen) return undefined;
    return [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value);
  }
}

function coerceOpenAIReasoningDelta(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => coerceOpenAIReasoningDelta(entry))
      .filter((part): part is string => part !== undefined && part.length > 0);
    return parts.length > 0 ? parts.join("") : undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "content", "reasoning", "reasoning_content", "thinking"]) {
      const part = coerceOpenAIReasoningDelta(record[key]);
      if (part !== undefined) return part;
    }
  }
  return undefined;
}

type OpenAIStreamToolCallBuffer = { id: string; name: string; argsJson: string };

/** Complete identified stream-end tool calls become executable results; incomplete or malformed calls are dropped. */
function finalizeOpenAIStreamToolCalls(
  buffer: Array<OpenAIStreamToolCallBuffer | undefined>,
): ToolCallResult[] | undefined {
  const completed: ToolCallResult[] = [];
  for (const tc of buffer) {
    if (!tc?.name || !tc.id) continue;
    try {
      completed.push({
        name: tc.name,
        args: parseModelToolArguments(tc.argsJson),
        call_id: tc.id,
      });
    } catch {
      // Truncated, malformed, or non-object arguments drop this call only.
    }
  }
  return completed.length > 0 ? completed : undefined;
}


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

  protected splitMirroredReasoning(
    content: unknown,
    reasoning: unknown,
  ): { content: string; reasoning?: string } {
    const resolvedContent = typeof content === "string" ? content : "";
    const resolvedReasoning =
      typeof reasoning === "string" && reasoning.length > 0
        ? reasoning
        : undefined;

    if (!resolvedReasoning || !resolvedContent) {
      return { content: resolvedContent, reasoning: resolvedReasoning };
    }

    // Some OpenAI-compatible reasoning models mirror the active thinking delta
    // into both `reasoning(_content)` and `content`. Treat exact/trim-equal
    // mirrors as reasoning-only so the chat stream doesn't show duplicates.
    if (resolvedContent === resolvedReasoning) {
      return { content: "", reasoning: resolvedReasoning };
    }

    const trimmedContent = resolvedContent.trim();
    const trimmedReasoning = resolvedReasoning.trim();
    if (trimmedContent && trimmedContent === trimmedReasoning) {
      return { content: "", reasoning: resolvedReasoning };
    }

    return { content: resolvedContent, reasoning: resolvedReasoning };
  }

  protected baseUrl(apiUrl: string): string {
    let url = (apiUrl || this.defaultUrl).replace(/\/+$/, "");
    // Strip path suffixes the user may have included that we append ourselves
    url = url.replace(/\/chat\/completions$/, "");
    url = url.replace(/\/models$/, "");
    return url;
  }

  /** Resolve the request URL separately from model/auth endpoints so providers
   * can route opt-in chat features without changing their stable API base. */
  protected chatCompletionsUrl(
    apiUrl: string,
    _request: GenerationRequest,
  ): string {
    return `${this.baseUrl(apiUrl)}/chat/completions`;
  }

  /** Override to add provider-specific headers (e.g. OpenRouter's HTTP-Referer). */
  protected extraHeaders(_apiKey: string): Record<string, string> {
    return {};
  }

  protected normalizeApiKey(apiKey: string): string {
    return apiKey.trim().replace(/^Bearer\s+/i, "");
  }

  protected headers(apiKey: string): Record<string, string> {
    const normalizedApiKey = this.normalizeApiKey(apiKey);

    return {
      "Content-Type": "application/json",
      ...(normalizedApiKey ? { Authorization: `Bearer ${normalizedApiKey}` } : {}),
      ...this.extraHeaders(normalizedApiKey),
    };
  }

  async generate(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest
  ): Promise<GenerationResponse> {
    const url = this.chatCompletionsUrl(apiUrl, request);
    const body = this.buildBody(request, false);

    const res = await fetchWithPreflightAbort(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
    }, request.signal);

    if (!res.ok) {
      await throwProviderResponseError(
        this.displayName,
        GENERATE_OPERATION,
        res,
        request.signal,
        request.receiveLimitBytes,
      );
    }

    const data = await readJsonWithAbort<any>(res, request.signal, request.receiveLimitBytes);
    const choice = data?.choices?.[0];
    if (!choice || typeof choice !== "object") {
      throw new ProviderProtocolError("OpenAI response did not contain a choice");
    }
    const message = choice.message;
    if (!message || typeof message !== "object") {
      throw new ProviderProtocolError("OpenAI response choice did not contain a message");
    }
    if (
      Object.hasOwn(message, "content") &&
      message.content !== null &&
      typeof message.content !== "string"
    ) {
      throw new ProviderProtocolError("OpenAI message content must be a string or null");
    }

    const rawToolCalls = message.tool_calls;
    let toolCalls: ToolCallResult[] | undefined;
    if (rawToolCalls !== undefined) {
      if (!Array.isArray(rawToolCalls) || rawToolCalls.length > PROVIDER_STREAM_LIMITS.maxCalls) {
        throw new ProviderResponseTooLargeError(
          `OpenAI tool call count exceeded ${PROVIDER_STREAM_LIMITS.maxCalls}`,
          PROVIDER_STREAM_LIMITS.maxCalls,
          Array.isArray(rawToolCalls) ? rawToolCalls.length : PROVIDER_STREAM_LIMITS.maxCalls + 1,
        );
      }
      const ids = new Set<string>();
      toolCalls = rawToolCalls.map((tc: any) => {
        const id = typeof tc?.id === "string" && tc.id.length > 0 ? tc.id : "";
        if (!id) throw new ProviderProtocolError("OpenAI tool call is missing its native ID");
        if (ids.has(id)) throw new ProviderProtocolError("OpenAI tool call IDs must be unique");
        ids.add(id);
        const fn = tc?.function;
        if (!fn || typeof fn.name !== "string" || fn.name.length === 0) {
          throw new ProviderProtocolError("OpenAI tool call is missing its function name");
        }
        if (typeof fn.arguments !== "string") {
          throw new ProviderProtocolError("OpenAI tool call arguments must be a JSON string");
        }
        const argBytes = Buffer.byteLength(fn.arguments, "utf8");
        if (argBytes > PROVIDER_STREAM_LIMITS.maxArgumentsBytes) {
          throw new ProviderResponseTooLargeError(
            "OpenAI tool call arguments exceeded their bounded carrier",
            PROVIDER_STREAM_LIMITS.maxArgumentsBytes,
            argBytes,
          );
        }
        return {
          name: fn.name,
          args: parseModelToolArguments(fn.arguments) as Record<string, unknown>,
          call_id: id,
        };
      });
      if (toolCalls.length === 0) toolCalls = undefined;
    }

    const rawReasoning = coerceOpenAIReasoningDelta(
      message.reasoning !== undefined ? message.reasoning : message.reasoning_content,
    );
    const reasoningDetails = new ReasoningDetailsAccumulator();
    if (rawReasoning !== undefined) reasoningDetails.reserveText(rawReasoning);
    const normalized = this.splitMirroredReasoning(message.content, rawReasoning);
    if (message.reasoning_details !== undefined) {
      reasoningDetails.push(message.reasoning_details);
    }
    const finishReason = choice.finish_reason;
    if (Object.hasOwn(choice, "finish_reason") && finishReason !== null && typeof finishReason !== "string") {
      throw new ProviderProtocolError("OpenAI finish_reason must be a string or null");
    }

    return {
      content: normalized.content,
      reasoning: normalized.reasoning,
      finish_reason: toolCalls ? "tool_calls" : (finishReason || "stop"),
      tool_calls: toolCalls,
      reasoning_details: reasoningDetails.finalize(),
      usage: parseOpenAIUsage(data.usage),
    };
  }

  async *generateStream(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const url = this.chatCompletionsUrl(apiUrl, request);
    const body = this.buildBody(request, true);

    const res = await fetchWithPreflightAbort(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
    }, request.signal);

    if (!res.ok) {
      await throwProviderResponseError(
        this.displayName,
        STREAM_OPERATION,
        res,
        request.signal,
        request.receiveLimitBytes,
      );
    }

    const sse = createBoundedSseReader(res, request.signal, {
      terminalMarker: "[DONE]",
      maxResponseBytes: request.receiveLimitBytes,
    });
    let eventCount = 0;
    let reasoningKey: "reasoning" | "reasoning_content" | null = null;
    const toolCallBuffer: Array<OpenAIStreamToolCallBuffer | undefined> = [];
    const reasoningDetails = new ReasoningDetailsAccumulator();
    let sawFinishReason = false;
    let sawUsageTrailer = false;
    const seenNativeIds = new Set<string>();
    let sawToolFinish = false;

    for await (const event of sse) {
      // Repository fixtures frame each JSON payload with a single LF rather
      // than an SSE blank line. BoundedSseReader preserves those data fields
      // in one event; split them here while retaining strict per-payload
      // validation below.
      for (const data of event.data.split("\n")) {
        if (request.signal?.aborted) {
          throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        eventCount += 1;
        if (eventCount > PROVIDER_STREAM_LIMITS.maxEvents) {
          throw new ProviderResponseTooLargeError(
            `OpenAI stream event count exceeded ${PROVIDER_STREAM_LIMITS.maxEvents}`,
            PROVIDER_STREAM_LIMITS.maxEvents,
            eventCount,
          );
        }
        if (eventCount % 64 === 0) await yieldToEventLoop(request.signal);
        if (data === "[DONE]") {
          if (!sse.isTerminal) sse.markTerminal();
          if (toolCallBuffer.length > 0 && !sawToolFinish) {
            const toolCalls = finalizeOpenAIStreamToolCalls(toolCallBuffer);
            sawFinishReason = true;
            sawToolFinish = true;
            yield {
              token: "",
              finish_reason: toolCalls ? "tool_calls" : "stop",
              tool_calls: toolCalls,
              reasoning_details: reasoningDetails.finalize(),
            };
          } else if (!sawFinishReason) {
            throw new ProviderProtocolError("OpenAI stream ended without finish_reason");
          }
          continue;
        }
        if (sse.isTerminal) {
          throw new ProviderProtocolError("OpenAI stream emitted data after its terminal marker");
        }
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch (error) {
          throw new ProviderProtocolError("Malformed OpenAI SSE JSON", { cause: error });
        }
        if (!parsed || typeof parsed !== "object") {
          throw new ProviderProtocolError("OpenAI SSE payload must be an object");
        }
        if (event.event !== undefined && event.event !== "message") {
          throw new ProviderProtocolError("OpenAI SSE event name is unsupported");
        }
        if (parsed.choices !== undefined && !Array.isArray(parsed.choices)) {
          throw new ProviderProtocolError("OpenAI SSE choices must be an array");
        }
        if (sawFinishReason) {
          const hasUsageObject = parsed.usage !== undefined && parsed.usage !== null;
          if (
            sawUsageTrailer ||
            !Array.isArray(parsed.choices) ||
            parsed.choices.length !== 0 ||
            !hasUsageObject
          ) {
            throw new ProviderProtocolError("OpenAI stream emitted data after finish_reason");
          }
          const usage = parseOpenAIUsage(parsed.usage);
          sawUsageTrailer = true;
          yield { token: "", usage };
          continue;
        }
        const choice = parsed.choices?.[0];
        if (choice === undefined) {
          throw new ProviderProtocolError("OpenAI SSE event did not contain choices");
        }
        if (!choice || typeof choice !== "object") {
          throw new ProviderProtocolError("OpenAI SSE choice must be an object");
        }
        const delta = choice.delta;
        if (delta !== undefined && (!delta || typeof delta !== "object")) {
          throw new ProviderProtocolError("OpenAI SSE delta must be an object");
        }
        if (
          delta !== undefined &&
          Object.hasOwn(delta, "content") &&
          delta.content !== null &&
          typeof delta.content !== "string"
        ) {
          throw new ProviderProtocolError("OpenAI SSE content delta must be a string or null");
        }

      const rawToolDeltas = delta?.tool_calls;
      if (rawToolDeltas !== undefined) {
        if (!Array.isArray(rawToolDeltas)) {
          throw new ProviderProtocolError("OpenAI tool_calls delta must be an array");
        }
        for (const tc of rawToolDeltas) {
          if (!tc || typeof tc !== "object") {
            throw new ProviderProtocolError("OpenAI tool call delta is malformed");
          }
          const idx = tc.index ?? toolCallBuffer.length;
          if (!Number.isSafeInteger(idx) || idx < 0) {
            throw new ProviderProtocolError("OpenAI tool call delta has an invalid index");
          }
          if (idx > PROVIDER_STREAM_LIMITS.maxCalls - 1) {
            throw new ProviderResponseTooLargeError(
              `OpenAI tool call count exceeded ${PROVIDER_STREAM_LIMITS.maxCalls}`,
              PROVIDER_STREAM_LIMITS.maxCalls,
              idx + 1,
            );
          }
          let buffered = toolCallBuffer[idx];
          if (!buffered) {
            if (typeof tc.id !== "string" || tc.id.length === 0) {
              throw new ProviderProtocolError("OpenAI tool call is missing its native ID");
            }
            if (Buffer.byteLength(tc.id, "utf8") > 256) {
              throw new ProviderResponseTooLargeError("OpenAI tool call ID exceeded its bounded length", 256, Buffer.byteLength(tc.id, "utf8"));
            }
            if (seenNativeIds.has(tc.id)) {
              throw new ProviderProtocolError("OpenAI tool call IDs must be unique");
            }
            seenNativeIds.add(tc.id);
            buffered = { id: tc.id, name: "", argsJson: "" };
            toolCallBuffer[idx] = buffered;
          } else if (tc.id !== undefined && tc.id !== buffered.id) {
            throw new ProviderProtocolError("OpenAI tool call ID changed during streaming");
          }
          const functionDelta = tc.function;
          if (functionDelta !== undefined && (!functionDelta || typeof functionDelta !== "object")) {
            throw new ProviderProtocolError("OpenAI tool function delta must be an object");
          }
          if (functionDelta?.name !== undefined) {
            if (typeof functionDelta.name !== "string" || functionDelta.name.length === 0) {
              throw new ProviderProtocolError("OpenAI tool function name must be a non-empty string");
            }
            const currentName = buffered.name;
            if (currentName && currentName !== functionDelta.name) {
              throw new ProviderProtocolError("OpenAI tool function name changed during streaming");
            }
            buffered.name = functionDelta.name;
          }
          if (functionDelta?.arguments !== undefined) {
            if (typeof functionDelta.arguments !== "string") {
              throw new ProviderProtocolError("OpenAI tool arguments delta must be a string");
            }
            const deltaBytes = Buffer.byteLength(functionDelta.arguments, "utf8");
            if (deltaBytes > PROVIDER_STREAM_LIMITS.maxToolDeltaBytes) {
              throw new ProviderResponseTooLargeError(
                "OpenAI tool argument delta exceeded its bounded carrier",
                PROVIDER_STREAM_LIMITS.maxToolDeltaBytes,
                deltaBytes,
              );
            }
            const nextBytes = Buffer.byteLength(buffered.argsJson, "utf8") + deltaBytes;
            if (nextBytes > PROVIDER_STREAM_LIMITS.maxArgumentsBytes) {
              throw new ProviderResponseTooLargeError(
                "OpenAI tool arguments exceeded their bounded carrier",
                PROVIDER_STREAM_LIMITS.maxArgumentsBytes,
                nextBytes,
              );
            }
            buffered.argsJson += functionDelta.arguments;
          }
        }
      }

      reasoningDetails.push(delta?.reasoning_details);
      let reasoning: string | undefined;
      if (reasoningKey) {
        reasoning = coerceOpenAIReasoningDelta(delta?.[reasoningKey]);
      } else if (delta?.reasoning !== undefined) {
        reasoning = coerceOpenAIReasoningDelta(delta.reasoning);
        reasoningKey = "reasoning";
      } else if (delta?.reasoning_content !== undefined) {
        reasoning = coerceOpenAIReasoningDelta(delta.reasoning_content);
        reasoningKey = "reasoning_content";
      }
      if (reasoning !== undefined) reasoningDetails.reserveText(reasoning);
      const normalized = this.splitMirroredReasoning(delta?.content, reasoning);
      const content = normalized.content;
      reasoning = normalized.reasoning;

      const usage = parseOpenAIUsage(parsed.usage, true);
      const finishReason = choice.finish_reason;
      if (Object.hasOwn(choice, "finish_reason") && finishReason !== null && typeof finishReason !== "string") {
        throw new ProviderProtocolError("OpenAI finish_reason must be a string or null");
      }
      if (finishReason) {
        if (sawFinishReason) throw new ProviderProtocolError("OpenAI stream emitted duplicate finish_reason");
        sawFinishReason = true;
        let toolCalls: ToolCallResult[] | undefined;
        let publishedToken = content || "";
        let publishedFinish = finishReason;
        if (toolCallBuffer.length > 0) {
          sawToolFinish = true;
          toolCalls = finalizeOpenAIStreamToolCalls(toolCallBuffer);
          if (toolCalls) {
            publishedFinish = "tool_calls";
          } else {
            publishedFinish = "stop";
            publishedToken = "";
          }
        }
        yield {
          token: publishedToken,
          reasoning,
          finish_reason: publishedFinish,
          tool_calls: toolCalls,
          reasoning_details: reasoningDetails.finalize(),
          usage,
        };
      } else if (reasoning || content) {
        yield { token: content || "", reasoning, usage };
      } else if (usage) {
        yield { token: "", usage };
      }
    }
  }
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/models`, {
        headers: this.headers(apiKey),
      });
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
    const data = await fetchProviderJson<any>(this.displayName, "model listing", `${this.baseUrl(apiUrl)}/models`, {
      headers: this.headers(apiKey),
    });
    return this.filterModels(data);
  }

  /** Override to customise model list extraction / filtering. */
  protected filterModels(data: any): string[] {
    return (data.data || []).map((m: any) => m.id).sort();
  }

  /** Format message content for the OpenAI API, handling multipart (vision/audio) content. */
  protected formatContent(m: LlmMessage): string | any[] {
    if (typeof m.content === "string") return m.content;
    const out: any[] = [];
    for (const part of m.content as LlmMessagePart[]) {
      switch (part.type) {
        case "text":
          out.push({ type: "text", text: part.text });
          break;
        case "image":
          out.push({ type: "image_url", image_url: { url: `data:${part.mime_type};base64,${part.data}` } });
          break;
        case "audio":
          out.push({ type: "input_audio", input_audio: { data: part.data, format: part.mime_type.split("/")[1] } });
          break;
      }
    }
    return out;
  }

  // Flatten one LlmMessage into the sequence of OpenAI Chat Completions
  // messages it maps to. tool_use parts become tool_calls on the assistant
  // message, tool_result parts become separate role:tool messages.
  protected flattenForChat(m: LlmMessage): any[] {
    if (typeof m.content === "string") {
      return [
        {
          role: m.role,
          content: m.content,
          // Plain assistant history may replay OpenRouter's structured
          // reasoning_details, but plaintext reasoning_content belongs only to
          // tool-call continuations (or Moonshot partial prefill).
          ...this.assistantReasoningCarrier(m, false),
        },
      ];
    }
    const parts = m.content as LlmMessagePart[];
    const toolUses = parts.filter((p): p is Extract<LlmMessagePart, { type: "tool_use" }> => p.type === "tool_use");
    const toolResults = parts.filter((p): p is Extract<LlmMessagePart, { type: "tool_result" }> => p.type === "tool_result");
    const nonTool = parts.filter((p) => p.type !== "tool_use" && p.type !== "tool_result");

    const out: any[] = [];

    if (m.role === "assistant" && toolUses.length > 0) {
      const text = nonTool
        .filter((p): p is Extract<LlmMessagePart, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("");
      // DeepSeek thinking-mode (`deepseek-reasoner`, `deepseek-chat` with
      // thinking enabled) requires the previous turn's `reasoning_content` to
      // be echoed back on the assistant message **when the turn invoked a
      // tool call** and the conversation continues. Without it, the API
      // rejects the continuation request with:
      //   "The `reasoning_content` in the thinking mode must be passed back
      //   to the API." (deepseek 400 invalid_request_error)
      // Per DeepSeek's docs, this is required ONLY on tool-call turns —
      // plain-text continuations do not need the field. We scope propagation
      // accordingly. Other openai-compatible providers that route DeepSeek
      // (NanoGPT, OpenRouter, etc.) inherit this behaviour; providers
      // without thinking mode never receive the field anyway.
      out.push({
        role: "assistant",
        content: text.length > 0 ? text : null,
        tool_calls: toolUses.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
        })),
        // OpenRouter's `reasoning_details` is the authoritative, normalized
        // carrier — replay the whole sequence verbatim and prefer it over the
        // plaintext `reasoning_content` alias when both are present.
        ...(m.reasoning_details?.length
          ? { reasoning_details: m.reasoning_details }
          : m.reasoning_content
            ? { reasoning_content: m.reasoning_content }
            : {}),
      });
    } else if (nonTool.length > 0) {
      out.push({
        role: m.role,
        content: this.formatContent({ ...m, content: nonTool }),
        ...this.assistantReasoningCarrier(m),
      });
    }

    for (const tr of toolResults) {
      out.push({
        role: "tool",
        tool_call_id: tr.tool_use_id,
        content: tr.content,
      });
    }

    return out;
  }

  /**
   * Reasoning payloads belong to the assistant turn that produced them. The
   * structured carrier is safe for ordinary prompt history; plaintext
   * reasoning_content is opt-in for multipart history and tool continuations.
   */
  private assistantReasoningCarrier(
    m: LlmMessage,
    includePlaintext = true,
  ): Record<string, unknown> {
    if (m.role !== "assistant") return {};
    if (m.reasoning_details?.length) {
      return { reasoning_details: m.reasoning_details };
    }
    if (!includePlaintext) return {};
    return m.reasoning_content && this.replayReasoningContentOnPlainAssistant(m)
      ? { reasoning_content: m.reasoning_content }
      : {};
  }

  /**
   * Most OpenAI-compatible relays retain native reasoning on ordinary history
   * turns. Providers whose APIs only accept `reasoning_content` on tool-call
   * continuations override this hook; the explicit tool-call branch above is
   * intentionally unaffected.
   */
  protected replayReasoningContentOnPlainAssistant(_message: LlmMessage): boolean {
    return true;
  }

  /** Keys that are internal to Lumiverse and should never be sent to any provider API. */
  protected static readonly INTERNAL_PARAMS = new Set(["max_context_length", "_include_usage", "use_responses_api"]);

  /** Keys that custom bodies cannot use to widen a feature-active tool mode. */
  protected static readonly TOOL_CONTROL_PARAMS = new Set([
    "tools", "tool_choice", "parallel_tool_calls", "functions", "function_call",
    "plugins", "web_search", "google_search", "enable_web_search", "enableSearch",
  ]);

  /** Build the request body using capabilities as the parameter allowlist. */
  protected buildBody(request: GenerationRequest, stream: boolean): any {
    if (request.toolMode === "required" && !this.capabilities.requiredToolChoice) {
      throw new Error("Provider does not support required tool choice");
    }
    const params = request.parameters || {};
    const allowed = this.capabilities.parameters;

    const body: any = {
      model: request.model,
      messages: request.messages.flatMap((m) => this.flattenForChat(m)),
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

    // Passthrough custom params, but feature-active modes cannot widen tools.
    for (const key of Object.keys(params)) {
      if (request.toolMode && OpenAICompatibleProvider.TOOL_CONTROL_PARAMS.has(key)) continue;
      if (body[key] !== undefined) continue;
      if (allowed[key]) continue;
      if (OpenAICompatibleProvider.INTERNAL_PARAMS.has(key)) continue;
      body[key] = params[key];
    }

    // Request token usage in streaming responses when _include_usage is set
    if (stream && params._include_usage) {
      body.stream_options = { include_usage: true };
    }

    // Inline council tools: pass as OpenAI function calling format.
    if (request.toolMode === "finalization") {
      body.tools = [];
      body.tool_choice = "none";
      body.parallel_tool_calls = false;
    } else if (request.toolMode === "required" && (!request.tools || request.tools.length === 0)) {
      throw new Error("Required tool mode needs at least one admitted host tool");
    } else if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          strict: false,
        },
      }));
      if (request.toolMode === "required") body.tool_choice = "required";
    }
    return body;
  }
}
