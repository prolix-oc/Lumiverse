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
import { AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES } from "../../services/agent-runtime-accounting";
import {
  getTextContent,
  type GenerationUsage,
  type GenerationRequest,
  type GenerationResponse,
  type StreamChunk,
  type ToolCallResult,
  type LlmMessage,
  type LlmMessagePart,
  type LlmThinkingBlock,
} from "../types";
import { parseModelToolArguments } from "../tool-arguments";
import {
  fetchProviderJson,
  parseProviderErrorBody,
  ProviderRequestError,
  readBoundedText,
  throwProviderResponseError,
} from "../../utils/provider-errors";

const API_VERSION = "2023-06-01";

export class AnthropicProvider implements LlmProvider {
  private static readonly PROMPT_PLACEHOLDER = "Let's get started.";
  private static readonly CACHE_TTLS = new Set(["5m", "1h"]);

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
      prompt_caching: COMMON_PARAMS.prompt_caching,
    },
    requiresMaxTokens: true,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: true,
    modelListStyle: "anthropic",
    toolCalling: true,
    requiredToolChoice: true,
    nativeToolContinuation: true,
    toolContinuationMode: "native",
    toolsDisabledFinalization: true,
    supportsToolFinalization: true,
    // Anthropic preserves reasoning across tool calls via native `thinking`
    // blocks (with opaque signatures) replayed before each turn's `tool_use`.
    // formatContent re-injects them and buildBody sends the interleaved-thinking
    // beta header, so the generation loop can use the structured continuation.
    interleavedThinking: true,
  };

  private static readonly INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

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

  /**
   * Opus 4.7/4.8 and every direct Claude 5-family model ID (including
   * point releases) use adaptive thinking and reject manual sampling params.
   */
  private omitsSamplingParams(model: string): boolean {
    return /^claude-(?:opus-4-(?:7|8)|[a-z0-9][a-z0-9-]*-5)(?:$|[-.:@])/i.test(
      (model || "").trim(),
    );
  }

  private shouldSuppressThinking(request: GenerationRequest): boolean {
    const thinking = request.parameters?.thinking;
    return (
      !!thinking &&
      typeof thinking === "object" &&
      (thinking as any).type === "disabled"
    );
  }

  /** True when extended/adaptive thinking is active (set and not disabled). */
  private thinkingEnabled(request: GenerationRequest): boolean {
    const thinking = request.parameters?.thinking;
    return (
      !!thinking &&
      typeof thinking === "object" &&
      !Array.isArray(thinking) &&
      (thinking as any).type !== "disabled"
    );
  }

  /**
   * Whether to request interleaved thinking for this call. Only meaningful when
   * tools are present (nothing to interleave otherwise) and thinking is enabled.
   * The `interleaved-thinking-2025-05-14` beta header is accepted on any model
   * and is safely ignored / deprecated where interleaved thinking is automatic
   * (adaptive thinking on Claude 4.6+/4.7/4.8 and Claude 5), so it's safe to
   * send whenever these conditions hold.
   */
  protected wantsInterleavedThinking(request: GenerationRequest): boolean {
    return !!request.tools?.length && this.thinkingEnabled(request);
  }

  /** Merge the interleaved-thinking beta header onto the base headers when applicable. */
  protected requestHeaders(
    apiKey: string,
    request: GenerationRequest,
  ): Record<string, string> {
    const headers = this.headers(apiKey);
    if (this.wantsInterleavedThinking(request)) {
      headers["anthropic-beta"] = AnthropicProvider.INTERLEAVED_THINKING_BETA;
    }
    return headers;
  }

  /**
   * Extract native thinking / redacted_thinking blocks (with signatures) from a
   * non-streaming response `content` array, preserving order. These are opaque
   * and must be replayed verbatim on tool-use continuations.
   */
  protected collectThinkingBlocks(
    blocks: any[],
    displaySuppressed = false,
  ): LlmThinkingBlock[] {
    const out: LlmThinkingBlock[] = [];
    for (const block of blocks) {
      if (block?.display_suppressed !== undefined) {
        throw new ProviderProtocolError("Anthropic thinking provenance is provider-authored");
      }
      if (block?.type === "thinking") {
        out.push({
          type: "thinking",
          thinking: block.thinking || "",
          ...(block.signature !== undefined ? { signature: block.signature } : {}),
          ...(displaySuppressed ? { display_suppressed: true as const } : {}),
        });
      } else if (block?.type === "redacted_thinking") {
        out.push({
          type: "redacted_thinking",
          data: block.data,
          ...(displaySuppressed ? { display_suppressed: true as const } : {}),
        });
      }
    }
    return out;
  }

  private normalizeThinkingConfig(thinking: unknown):
    | Record<string, unknown>
    | undefined {
    if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) {
      return undefined;
    }

    if ((thinking as any).type === "disabled") {
      // Anthropic treats `display` as invalid when thinking is disabled, so send
      // the minimal explicit off-switch only.
      return { type: "disabled" };
    }

    return { ...(thinking as Record<string, unknown>) };
  }

  private normalizeOutputConfig(
    outputConfig: unknown,
    thinking: unknown,
  ): Record<string, unknown> | undefined {
    if (
      !outputConfig ||
      typeof outputConfig !== "object" ||
      Array.isArray(outputConfig)
    )
      return undefined;
    const next = { ...(outputConfig as Record<string, unknown>) };
    if (
      !thinking ||
      typeof thinking !== "object" ||
      Array.isArray(thinking) ||
      (thinking as any).type === "disabled"
    ) {
      delete next.effort;
    }
    return Object.keys(next).length > 0 ? next : undefined;
  }

  private normalizeCacheControl(
    value: unknown,
  ): Record<string, unknown> | undefined {
    if (value === true) {
      return { type: "ephemeral" };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    if (record.type !== "ephemeral") {
      return undefined;
    }

    const normalized: Record<string, unknown> = { type: "ephemeral" };
    if (
      typeof record.ttl === "string" &&
      AnthropicProvider.CACHE_TTLS.has(record.ttl)
    ) {
      normalized.ttl = record.ttl;
    }
    return normalized;
  }

  private validateUsage(
    value: unknown,
    context: string,
    requiredFields: readonly string[] = [],
  ): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ProviderProtocolError(`${context} is malformed`);
    }
    const usage = value as Record<string, unknown>;
    const tokenFields = [
      "input_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "output_tokens",
    ];
    for (const field of tokenFields) {
      const tokenValue = usage[field];
      if (
        tokenValue !== undefined &&
        (!Number.isSafeInteger(tokenValue) || (tokenValue as number) < 0)
      ) {
        throw new ProviderProtocolError(`${context}.${field} is not a safe nonnegative integer`);
      }
    }
    for (const field of requiredFields) {
      if (!Number.isSafeInteger(usage[field]) || (usage[field] as number) < 0) {
        throw new ProviderProtocolError(`${context}.${field} is missing or malformed`);
      }
    }
    return usage;
  }

  private sumUsageTokens(
    usage: Record<string, unknown>,
    fields: readonly string[],
    context: string,
  ): number {
    let total = 0;
    for (const field of fields) {
      const value = usage[field];
      if (value === undefined) continue;
      const next = total + (value as number);
      if (!Number.isSafeInteger(next)) {
        throw new ProviderProtocolError(`${context} exceeds safe integer range`);
      }
      total = next;
    }
    return total;
  }

  private reserveCarrierBytes(
    currentBytes: number,
    fragment: string,
    label: string,
  ): number {
    const fragmentBytes = Buffer.byteLength(fragment, "utf8");
    const nextBytes = currentBytes + fragmentBytes;
    if (
      !Number.isSafeInteger(nextBytes) ||
      nextBytes > AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES
    ) {
      throw new ProviderResponseTooLargeError(
        `Anthropic ${label} exceeded its bounded opaque carrier`,
        AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES,
        nextBytes,
      );
    }
    return nextBytes;
  }

  private buildUsage(data: unknown): GenerationUsage {
    if (!data || typeof data !== "object" || Array.isArray(data) || !("usage" in data)) {
      throw new ProviderProtocolError("Anthropic usage is missing or malformed");
    }
    const usageValue = data.usage;
    if (usageValue === undefined) {
      throw new ProviderProtocolError("Anthropic usage is missing or malformed");
    }
    const usage = this.validateUsage(
      usageValue,
      "Anthropic usage",
      ["input_tokens", "output_tokens"],
    );
    const inputTokens = this.sumUsageTokens(
      usage,
      ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"],
      "Anthropic input token usage",
    );
    const outputTokens = usage.output_tokens as number;
    const totalTokens = inputTokens + outputTokens;
    if (!Number.isSafeInteger(totalTokens)) {
      throw new ProviderProtocolError("Anthropic total token usage exceeds safe integer range");
    }
    return {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: totalTokens,
      provider_raw: { ...usage },
    };
  }

  private buildStreamingUsage(
    inputTokens: number,
    outputTokens: number,
    rawUsage?: Record<string, unknown>,
  ): GenerationUsage | undefined {
    if (!inputTokens && !outputTokens && !rawUsage) return undefined;
    if (
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0 ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 0
    ) {
      throw new ProviderProtocolError("Anthropic streaming usage is malformed");
    }
    const totalTokens = inputTokens + outputTokens;
    if (!Number.isSafeInteger(totalTokens)) {
      throw new ProviderProtocolError("Anthropic total token usage exceeds safe integer range");
    }
    return {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: totalTokens,
      provider_raw: rawUsage,
    };
  }

  async generate(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest,
  ): Promise<GenerationResponse> {
    const url = `${this.baseUrl(apiUrl)}/v1/messages`;
    const body = this.buildBody(request, false);
    const suppressThinking = this.shouldSuppressThinking(request);

    const res = await fetchWithPreflightAbort(url, {
      method: "POST",
      headers: this.requestHeaders(apiKey, request),
      body: JSON.stringify(body),
    }, request.signal);

    if (!res.ok) {
      const rawBody = await readBoundedText(
        res,
        request.signal,
        request.receiveLimitBytes,
      );
      this.logSystemValidationError(body, rawBody);
      const parsed = parseProviderErrorBody(rawBody);
      throw new ProviderRequestError({
        provider: this.displayName,
        operation: "generate",
        status: res.status,
        code: parsed.code || res.statusText || undefined,
        detail: parsed.detail || res.statusText || undefined,
        rawBody,
      });
    }

    const data = (await readJsonWithAbort<any>(res, request.signal, request.receiveLimitBytes)) as any;
    if (!data || typeof data !== "object" || !Array.isArray(data.content)) {
      throw new ProviderProtocolError("Anthropic response content is malformed");
    }
    if (typeof data.stop_reason !== "string") {
      throw new ProviderProtocolError("Anthropic stop_reason is malformed");
    }
    const blocks = data.content;
    if (blocks.length > PROVIDER_STREAM_LIMITS.maxCalls * 4) {
      throw new ProviderResponseTooLargeError("Anthropic content block count exceeded its limit", PROVIDER_STREAM_LIMITS.maxCalls * 4, blocks.length);
    }
    let textContent = "";
    let thinkingContent = "";
    let reasoningBytes = 0;
    const seenIds = new Set<string>();
    const toolUseBlocks: any[] = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object" || typeof block.type !== "string") {
        throw new ProviderProtocolError("Anthropic content block is malformed");
      }
      if (block.type === "text") {
        if (typeof block.text !== "string") throw new ProviderProtocolError("Anthropic text block is malformed");
        textContent += block.text;
      } else if (block.type === "thinking") {
        if (typeof block.thinking !== "string") throw new ProviderProtocolError("Anthropic thinking block is malformed");
        if (block.signature !== undefined && typeof block.signature !== "string") {
          throw new ProviderProtocolError("Anthropic thinking signature is malformed");
        }
        reasoningBytes = this.reserveCarrierBytes(
          reasoningBytes,
          block.thinking,
          "thinking",
        );
        reasoningBytes = this.reserveCarrierBytes(
          reasoningBytes,
          block.signature || "",
          "thinking signature",
        );
        if (suppressThinking) textContent += block.thinking;
        else thinkingContent += block.thinking;
      } else if (block.type === "redacted_thinking") {
        if (typeof block.data !== "string") throw new ProviderProtocolError("Anthropic redacted thinking block is malformed");
        reasoningBytes = this.reserveCarrierBytes(
          reasoningBytes,
          block.data,
          "redacted thinking",
        );
      } else if (block.type === "tool_use") {
        if (toolUseBlocks.length >= PROVIDER_STREAM_LIMITS.maxCalls) {
          throw new ProviderResponseTooLargeError("Anthropic tool call count exceeded its limit", PROVIDER_STREAM_LIMITS.maxCalls, toolUseBlocks.length + 1);
        }
        if (typeof block.id !== "string" || block.id.length === 0 || seenIds.has(block.id)) {
          throw new ProviderProtocolError("Anthropic tool_use requires a unique native ID");
        }
        if (typeof block.name !== "string" || block.name.length === 0) {
          throw new ProviderProtocolError("Anthropic tool_use requires a name");
        }
        if (block.input === undefined || !block.input || typeof block.input !== "object" || Array.isArray(block.input)) {
          throw new ProviderProtocolError("Anthropic tool_use input is malformed");
        }
        const argBytes = Buffer.byteLength(JSON.stringify(block.input), "utf8");
        if (argBytes > PROVIDER_STREAM_LIMITS.maxArgumentsBytes) {
          throw new ProviderResponseTooLargeError("Anthropic tool arguments exceeded their bounded carrier", PROVIDER_STREAM_LIMITS.maxArgumentsBytes, argBytes);
        }
        seenIds.add(block.id);
        toolUseBlocks.push(block);
      } else {
        throw new ProviderProtocolError("Anthropic response contains an unsupported content block");
      }
    }

    const toolCalls: ToolCallResult[] | undefined =
      toolUseBlocks.length > 0
        ? toolUseBlocks.map((block) => ({
            name: block.name,
            args: parseModelToolArguments(block.input),
            call_id: block.id,
          }))
        : undefined;
    const stopReason = data.stop_reason;
    if (toolCalls && stopReason !== "tool_use") {
      throw new ProviderProtocolError("Anthropic stop_reason does not match tool_use content");
    }
    if (!toolCalls && stopReason === "tool_use") {
      throw new ProviderProtocolError("Anthropic tool_use stop has no tool blocks");
    }

    const thinkingBlocks = this.collectThinkingBlocks(blocks, suppressThinking);
    // them on tool-use continuations — required for interleaved thinking. The
    // display suppression setting only controls reasoning presentation; it must
    // not discard the opaque carrier required for protocol replay.

    return {
      content: textContent,
      reasoning: thinkingContent || undefined,
      finish_reason: toolCalls ? "tool_calls" : data.stop_reason || "end_turn",
      tool_calls: toolCalls,
      thinking_blocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      usage: this.buildUsage(data),
    };
  }

  async *generateStream(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const url = `${this.baseUrl(apiUrl)}/v1/messages`;
    const body = this.buildBody(request, true);
    const suppressThinking = this.shouldSuppressThinking(request);

    const res = await fetchWithPreflightAbort(url, {
      method: "POST",
      headers: this.requestHeaders(apiKey, request),
      body: JSON.stringify(body),
    }, request.signal);

    if (!res.ok) {
      const rawBody = await readBoundedText(
        res,
        request.signal,
        request.receiveLimitBytes,
      );
      this.logSystemValidationError(body, rawBody);
      const parsed = parseProviderErrorBody(rawBody);
      throw new ProviderRequestError({
        provider: this.displayName,
        operation: "stream",
        status: res.status,
        code: parsed.code || res.statusText || undefined,
        detail: parsed.detail || res.statusText || undefined,
        rawBody,
      });
    }

    const sse = createBoundedSseReader(res, request.signal, {
      maxResponseBytes: request.receiveLimitBytes,
      singleDataLineEvents: true,
    });
    let eventCount = 0;
    let streamInputTokens = 0;
    let streamUsageRaw: Record<string, unknown> | undefined;
    let activeBlockIndex: number | undefined;
    let activeBlockType: string | undefined;
    let lastStartedBlockIndex = -1;
    const startedBlockIndices = new Set<number>();
    const openBlockIndices = new Set<number>();
    const closedBlockIndices = new Set<number>();
    let sawMessageStart = false;
    let sawMessageDelta = false;
    let sawStopReason = false;
    let sawMessageStop = false;
    const pendingToolCalls: Array<{ id: string; name: string; inputJson: string; index: number }> = [];
    const seenIds = new Set<string>();
    const thinkingBlocks: LlmThinkingBlock[] = [];
    let currentThinkingIdx = -1;
    let reasoningBytes = 0;

    for await (const event of sse) {
      eventCount += 1;
      if (eventCount % 64 === 0) await yieldToEventLoop(request.signal);

      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch (error) {
        throw new ProviderProtocolError("Malformed Anthropic SSE JSON", { cause: error });
      }
      if (!data || typeof data !== "object" || typeof data.type !== "string") {
        throw new ProviderProtocolError("Anthropic SSE event is malformed");
      }
      if (event.event !== undefined && event.event !== data.type) {
        throw new ProviderProtocolError("Anthropic SSE event name does not match its payload");
      }

      switch (data.type) {
        case "message_start": {
          if (sawMessageStart || sawMessageStop) {
            throw new ProviderProtocolError("Anthropic stream emitted an invalid message_start");
          }
          const message = data.message;
          if (!message || typeof message !== "object" || Array.isArray(message)) {
            throw new ProviderProtocolError("Anthropic message_start message is malformed");
          }
          const usage = this.validateUsage(
            message.usage,
            "Anthropic message_start usage",
            ["input_tokens"],
          );
          sawMessageStart = true;
          streamUsageRaw = { ...usage };
          streamInputTokens = this.sumUsageTokens(
            usage,
            ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"],
            "Anthropic message_start input token usage",
          );
          break;
        }
        case "content_block_start": {
          if (!sawMessageStart || sawMessageDelta || sawStopReason || sawMessageStop) {
            throw new ProviderProtocolError("Anthropic content block started outside message content");
          }
          if (!Number.isSafeInteger(data.index) || data.index < 0) {
            throw new ProviderProtocolError("Anthropic content block has an invalid index");
          }
          if (activeBlockIndex !== undefined) {
            throw new ProviderProtocolError("Anthropic content block started before the active block stopped");
          }
          if (
            data.index !== lastStartedBlockIndex + 1 ||
            startedBlockIndices.has(data.index)
          ) {
            throw new ProviderProtocolError("Anthropic content blocks arrived out of order");
          }
          const block = data.content_block;
          if (!block || typeof block !== "object" || typeof block.type !== "string") {
            throw new ProviderProtocolError("Anthropic content block is malformed");
          }
          if (block.display_suppressed !== undefined) {
            throw new ProviderProtocolError("Anthropic thinking provenance is provider-authored");
          }
          if (!["text", "tool_use", "thinking", "redacted_thinking"].includes(block.type)) {
            throw new ProviderProtocolError("Anthropic response contains an unsupported content block");
          }
          let initialChunk: StreamChunk | undefined;
          if (block.type === "text") {
            if (block.text !== undefined && typeof block.text !== "string") {
              throw new ProviderProtocolError("Anthropic text block is malformed");
            }
            if (block.text) initialChunk = { token: block.text };
            currentThinkingIdx = -1;
          } else if (block.type === "tool_use") {
            if (pendingToolCalls.length >= PROVIDER_STREAM_LIMITS.maxCalls) {
              throw new ProviderResponseTooLargeError(
                `Anthropic call count exceeded ${PROVIDER_STREAM_LIMITS.maxCalls}`,
                PROVIDER_STREAM_LIMITS.maxCalls,
                pendingToolCalls.length + 1,
              );
            }
            if (typeof block.id !== "string" || block.id.length === 0 || seenIds.has(block.id)) {
              throw new ProviderProtocolError("Anthropic tool_use requires a unique native ID");
            }
            if (typeof block.name !== "string" || block.name.length === 0) {
              throw new ProviderProtocolError("Anthropic tool_use requires a name");
            }
            seenIds.add(block.id);
            pendingToolCalls.push({ id: block.id, name: block.name, inputJson: "", index: data.index });
            currentThinkingIdx = -1;
          } else if (block.type === "thinking") {
            if (block.thinking !== undefined && typeof block.thinking !== "string") {
              throw new ProviderProtocolError("Anthropic thinking block is malformed");
            }
            if (block.signature !== undefined && typeof block.signature !== "string") {
              throw new ProviderProtocolError("Anthropic thinking signature is malformed");
            }
            const initialThinking = block.thinking ?? "";
            reasoningBytes = this.reserveCarrierBytes(
              reasoningBytes,
              initialThinking,
              "thinking",
            );
            reasoningBytes = this.reserveCarrierBytes(
              reasoningBytes,
              block.signature ?? "",
              "thinking signature",
            );
            currentThinkingIdx = -1;
            thinkingBlocks.push({
              type: "thinking",
              thinking: initialThinking,
              ...(block.signature !== undefined ? { signature: block.signature } : {}),
              ...(suppressThinking ? { display_suppressed: true as const } : {}),
            });
            currentThinkingIdx = thinkingBlocks.length - 1;
            if (initialThinking) {
              initialChunk = suppressThinking
                ? { token: initialThinking }
                : { token: "", reasoning: initialThinking };
            }
          } else {
            if (typeof block.data !== "string") {
              throw new ProviderProtocolError("Anthropic redacted thinking block is malformed");
            }
            reasoningBytes = this.reserveCarrierBytes(
              reasoningBytes,
              block.data,
              "redacted thinking",
            );
            currentThinkingIdx = -1;
            thinkingBlocks.push({
              type: "redacted_thinking",
              data: block.data,
              ...(suppressThinking ? { display_suppressed: true as const } : {}),
            });
          }
          activeBlockIndex = data.index;
          activeBlockType = block.type;
          lastStartedBlockIndex = data.index;
          startedBlockIndices.add(data.index);
          openBlockIndices.add(data.index);
          if (initialChunk) yield initialChunk;
          break;
        }
        case "content_block_delta": {
          if (
            activeBlockIndex === undefined ||
            data.index !== activeBlockIndex ||
            !activeBlockType
          ) {
            throw new ProviderProtocolError("Anthropic content block delta references no active block");
          }
          const delta = data.delta;
          if (!delta || typeof delta !== "object" || typeof delta.type !== "string") {
            throw new ProviderProtocolError("Anthropic content block delta is malformed");
          }
          if (delta.type === "thinking_delta") {
            if (activeBlockType !== "thinking") {
              throw new ProviderProtocolError("Anthropic thinking delta targets a non-thinking block");
            }
            if (typeof delta.thinking !== "string") {
              throw new ProviderProtocolError("Anthropic thinking delta must be a string");
            }
            reasoningBytes = this.reserveCarrierBytes(
              reasoningBytes,
              delta.thinking,
              "thinking",
            );
            if (currentThinkingIdx < 0) {
              throw new ProviderProtocolError("Anthropic thinking delta has no active block");
            }
            thinkingBlocks[currentThinkingIdx].thinking =
              `${thinkingBlocks[currentThinkingIdx].thinking || ""}${delta.thinking}`;
            if (suppressThinking) {
              yield { token: delta.thinking };
            } else {
              yield { token: "", reasoning: delta.thinking };
            }
          } else if (delta.type === "signature_delta") {
            if (activeBlockType !== "thinking") {
              throw new ProviderProtocolError("Anthropic signature delta targets a non-thinking block");
            }
            if (typeof delta.signature !== "string") {
              throw new ProviderProtocolError("Anthropic signature delta must be a string");
            }
            reasoningBytes = this.reserveCarrierBytes(
              reasoningBytes,
              delta.signature,
              "thinking signature",
            );
            if (currentThinkingIdx < 0) {
              throw new ProviderProtocolError("Anthropic signature delta has no active block");
            }
            thinkingBlocks[currentThinkingIdx].signature =
              `${thinkingBlocks[currentThinkingIdx].signature || ""}${delta.signature}`;
          } else if (delta.type === "text_delta") {
            if (activeBlockType !== "text") {
              throw new ProviderProtocolError("Anthropic text delta targets a non-text block");
            }
            if (typeof delta.text !== "string") {
              throw new ProviderProtocolError("Anthropic text delta must be a string");
            }
            yield { token: delta.text };
          } else if (delta.type === "input_json_delta") {
            if (activeBlockType !== "tool_use") {
              throw new ProviderProtocolError("Anthropic input JSON delta targets a non-tool block");
            }
            const tool = pendingToolCalls.find((call) => call.index === data.index);
            if (!tool) {
              throw new ProviderProtocolError("Anthropic input JSON delta references an unknown tool block");
            }
            if (typeof delta.partial_json !== "string") {
              throw new ProviderProtocolError("Anthropic input JSON delta must be a string");
            }
            const deltaBytes = Buffer.byteLength(delta.partial_json, "utf8");
            if (deltaBytes > PROVIDER_STREAM_LIMITS.maxToolDeltaBytes) {
              throw new ProviderResponseTooLargeError("Anthropic tool argument delta exceeded its bounded carrier", PROVIDER_STREAM_LIMITS.maxToolDeltaBytes, deltaBytes);
            }
            const nextBytes = Buffer.byteLength(tool.inputJson, "utf8") + deltaBytes;
            if (nextBytes > PROVIDER_STREAM_LIMITS.maxArgumentsBytes) {
              throw new ProviderResponseTooLargeError("Anthropic tool arguments exceeded their bounded carrier", PROVIDER_STREAM_LIMITS.maxArgumentsBytes, nextBytes);
            }
            tool.inputJson += delta.partial_json;
          } else {
            throw new ProviderProtocolError("Unknown Anthropic content block delta type");
          }
          break;
        }
        case "content_block_stop": {
          if (!Number.isSafeInteger(data.index) || data.index < 0) {
            throw new ProviderProtocolError("Anthropic content block stop has an invalid index");
          }
          if (closedBlockIndices.has(data.index)) {
            throw new ProviderProtocolError("Anthropic content block stop was duplicated");
          }
          if (activeBlockIndex === undefined || data.index !== activeBlockIndex) {
            throw new ProviderProtocolError("Anthropic content block stop does not match the active block");
          }
          openBlockIndices.delete(data.index);
          closedBlockIndices.add(data.index);
          activeBlockIndex = undefined;
          activeBlockType = undefined;
          currentThinkingIdx = -1;
          break;
        }
        case "message_delta": {
          if (!sawMessageStart || sawMessageStop || sawStopReason) {
            throw new ProviderProtocolError("Anthropic message_delta arrived outside the active message");
          }
          const delta = data.delta;
          if (
            delta !== undefined &&
            (!delta || typeof delta !== "object" || Array.isArray(delta))
          ) {
            throw new ProviderProtocolError("Anthropic message_delta delta is malformed");
          }
          const stopReason = delta?.stop_reason;
          if (openBlockIndices.size > 0 || activeBlockIndex !== undefined) {
            if (stopReason !== "max_tokens") {
              throw new ProviderProtocolError("Anthropic message_delta arrived before all content blocks stopped");
            }
            openBlockIndices.clear();
            activeBlockIndex = undefined;
            activeBlockType = undefined;
            currentThinkingIdx = -1;
            pendingToolCalls.length = 0;
          }
          const messageUsage = this.validateUsage(
            data.usage,
            "Anthropic message_delta usage",
            ["output_tokens"],
          );
          const usageRaw = { ...(streamUsageRaw || {}), ...messageUsage };
          const outputTokens = this.sumUsageTokens(
            messageUsage,
            ["output_tokens"],
            "Anthropic message_delta output token usage",
          );
          const usage = this.buildStreamingUsage(
            streamInputTokens,
            outputTokens,
            usageRaw,
          );
          if (stopReason !== undefined && stopReason !== null) {
            if (typeof stopReason !== "string" || sawStopReason) {
              throw new ProviderProtocolError("Anthropic stream emitted an invalid or duplicate stop reason");
            }
            sawStopReason = true;
            let toolCalls: ToolCallResult[] | undefined;
            if (stopReason === "tool_use") {
              if (pendingToolCalls.length === 0) throw new ProviderProtocolError("Anthropic tool_use stop had no tool blocks");
              toolCalls = pendingToolCalls.map((tool) => ({
                name: tool.name,
                args: parseModelToolArguments(tool.inputJson) as Record<string, unknown>,
                call_id: tool.id,
              }));
            } else if (pendingToolCalls.length > 0) {
              throw new ProviderProtocolError("Anthropic stream stopped with unresolved tool blocks");
            }
            yield {
              token: "",
              finish_reason: toolCalls ? "tool_calls" : stopReason,
              tool_calls: toolCalls,
              thinking_blocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
              usage,
            };
          } else if (usage) {
            yield { token: "", usage };
          }
          sawMessageDelta = true;
          break;
        }
        case "message_stop":
          if (
            !sawMessageStart ||
            !sawMessageDelta ||
            !sawStopReason ||
            sawMessageStop
          ) {
            throw new ProviderProtocolError("Anthropic message_stop arrived before a complete terminal message");
          }
          if (openBlockIndices.size > 0 || activeBlockIndex !== undefined) {
            throw new ProviderProtocolError("Anthropic message_stop arrived before all content blocks stopped");
          }
          sawMessageStop = true;
          sse.markTerminal();
          break;
        case "ping":
          break;
        default:
          throw new ProviderProtocolError(`Unknown Anthropic SSE event type: ${data.type}`);
      }
    }
    if (!sawMessageStop) throw new ProviderProtocolError("Anthropic stream ended without message_stop");
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
      if (res.status === 401 || res.status === 403) {
        await throwProviderResponseError(
          this.displayName,
          "authentication",
          res,
        );
      }
      return res.status !== 401 && res.status !== 403;
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
    const data = await fetchProviderJson<any>(
      this.displayName,
      "model listing",
      `${this.baseUrl(apiUrl)}/v1/models`,
      {
        headers: this.headers(apiKey),
      },
    );
    return (data.data || []).map((m: any) => m.id).sort();
  }

  private applyCacheControl(
    target: Record<string, unknown>,
    cacheControl: unknown,
  ): Record<string, unknown> {
    const normalized = this.normalizeCacheControl(cacheControl);
    return normalized ? { ...target, cache_control: normalized } : target;
  }

  /** Serialize native thinking blocks to Anthropic content-block form. */
  private formatThinkingBlocks(
    blocks: LlmThinkingBlock[] | undefined,
  ): Array<Record<string, unknown>> {
    if (!blocks?.length) return [];
    return blocks.map((b) =>
      b.type === "redacted_thinking"
        ? { type: "redacted_thinking", data: b.data }
        : {
            type: "thinking",
            thinking: b.thinking ?? "",
            // The signature is opaque and must be sent back unmodified. Omit it
            // only if absent (shouldn't happen for a captured thinking block).
            ...(b.signature !== undefined ? { signature: b.signature } : {}),
          },
    );
  }

  private hasSuppressedDisplayOrigin(
    blocks: LlmThinkingBlock[] | undefined,
  ): boolean {
    if (!blocks?.length) return false;
    let marked = 0;
    for (const block of blocks) {
      if (
        block.display_suppressed !== undefined &&
        block.display_suppressed !== true
      ) {
        throw new ProviderProtocolError("Anthropic thinking provenance is malformed");
      }
      if (block.display_suppressed === true) marked += 1;
    }
    if (marked !== 0 && marked !== blocks.length) {
      throw new ProviderProtocolError("Anthropic thinking provenance is incomplete");
    }
    return marked === blocks.length;
  }

  /**
   * A thinking-disabled response exposes native thinking text as ordinary
   * output while retaining its carrier for a possible tool continuation. When
   * that response is serialized again, remove the display copy that overlaps
   * the carrier so Anthropic sees the text exactly once.
   */
  private stripReplayedThinkingText(
    content: string,
    blocks: LlmThinkingBlock[] | undefined,
  ): string {
    const carrierText = (blocks ?? [])
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking ?? "")
      .join("");
    if (!carrierText || !content) return content;
    return content.startsWith(carrierText)
      ? content.slice(carrierText.length)
      : content;
  }

  private stripReplayedThinkingParts(
    parts: LlmMessagePart[],
    blocks: LlmThinkingBlock[] | undefined,
  ): LlmMessagePart[] {
    const carrierText = (blocks ?? [])
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking ?? "")
      .join("");
    if (!carrierText) return parts;

    const pending: LlmMessagePart[] = [];
    const output: LlmMessagePart[] = [];
    let consumed = 0;
    let matching = true;
    const flushPending = () => {
      output.push(...pending);
      pending.length = 0;
    };
    for (const part of parts) {
      if (!matching || consumed >= carrierText.length) {
        output.push(part);
        continue;
      }
      if (part.type !== "text") {
        flushPending();
        output.push(part);
        matching = false;
        continue;
      }
      if (!part.text) {
        pending.push(part);
        continue;
      }
      const remaining = carrierText.slice(consumed);
      if (remaining.startsWith(part.text)) {
        pending.push(part);
        consumed += part.text.length;
        if (consumed === carrierText.length) {
          output.push(...pending.map((candidate) => (
            candidate.type === "text" ? { ...candidate, text: "" } : candidate
          )));
          pending.length = 0;
          matching = false;
        }
        continue;
      }
      if (part.text.startsWith(remaining)) {
        output.push(...pending.map((candidate) => (
          candidate.type === "text" ? { ...candidate, text: "" } : candidate
        )));
        pending.length = 0;
        output.push({ ...part, text: part.text.slice(remaining.length) });
        consumed = carrierText.length;
        matching = false;
        continue;
      }
      flushPending();
      output.push(part);
      matching = false;
    }
    flushPending();
    return output;
  }

  /** Format message content for the Anthropic API, handling multipart (vision)
   *  content and replaying native thinking blocks for interleaved thinking. */
  protected formatContent(
    m: LlmMessage,
    suppressThinking = false,
  ): string | any[] {
    // Native thinking blocks must be replayed verbatim at the START of the
    // assistant turn, before any text or tool_use blocks. When thinking is
    // active, Anthropic requires the assistant turn to begin with them and
    // rejects tool_use turns that drop them.
    const nativeThinkingBlocks =
      m.role === "assistant" ? m.thinking_blocks : undefined;
    const hasSuppressedDisplayOrigin =
      this.hasSuppressedDisplayOrigin(nativeThinkingBlocks);
    const deduplicateThinkingDisplay =
      suppressThinking && hasSuppressedDisplayOrigin;
    const thinkingParts = nativeThinkingBlocks
      ? this.formatThinkingBlocks(nativeThinkingBlocks)
      : [];

    if (typeof m.content === "string") {
      const content = deduplicateThinkingDisplay
        ? this.stripReplayedThinkingText(m.content, nativeThinkingBlocks)
        : m.content;
      const hasCacheControl = !!this.normalizeCacheControl(m.cache_control);
      if (thinkingParts.length === 0 && !hasCacheControl) return content;
      const textParts = content
        ? [this.applyCacheControl({ type: "text", text: content }, m.cache_control)]
        : [];
      return [...thinkingParts, ...textParts];
    }

    const sourceParts = deduplicateThinkingDisplay
      ? this.stripReplayedThinkingParts(m.content, nativeThinkingBlocks)
      : m.content;
    const parts = sourceParts.map((part: LlmMessagePart) => {
      switch (part.type) {
        case "text":
          return this.applyCacheControl({ type: "text", text: part.text }, part.cache_control);
        case "image":
          return this.applyCacheControl({
            type: "image",
            source: { type: "base64", media_type: part.mime_type, data: part.data },
          }, part.cache_control);
        case "audio":
          return this.applyCacheControl({
            type: "text",
            text: `[Audio attachment: ${part.mime_type}]`,
          }, part.cache_control);
        case "tool_use":
          return this.applyCacheControl({
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: part.input,
          }, part.cache_control);
        case "tool_result":
          return this.applyCacheControl({
            type: "tool_result",
            tool_use_id: part.tool_use_id,
            content: part.content,
            ...(part.is_error ? { is_error: true } : {}),
          }, part.cache_control);
        default:
          return { type: "text", text: "" };
      }
    });
    return thinkingParts.length > 0 ? [...thinkingParts, ...parts] : parts;
  }

  private formatSystemMessage(m: LlmMessage): Array<Record<string, unknown>> {
    if (typeof m.content === "string") {
      const text = this.finalizeSystemText([m.content]);
      return text
        ? [this.applyCacheControl({ type: "text", text }, m.cache_control)]
        : [];
    }

    return m.content
      .filter((part): part is Extract<LlmMessagePart, { type: "text" }> =>
        part.type === "text",
      )
      .map((part) => this.finalizeSystemText([part.text])
        ? this.applyCacheControl(
            { type: "text", text: this.finalizeSystemText([part.text]) as string },
            part.cache_control,
          )
        : null)
      .filter((part): part is Record<string, unknown> => !!part);
  }

  /**
   * Anthropic accepts `system` as either a string or TextBlockParam[]. In
   * practice, Lumiverse does not need block-level system features here, and the
   * string form is the least error-prone across custom-body inputs and proxies.
   */
  private normalizeSystemParam(value: unknown):
    | Array<Record<string, unknown>>
    | undefined {
    if (typeof value === "string") {
      const text = this.finalizeSystemText([value]);
      return text ? [{ type: "text", text }] : undefined;
    }

    const blocks: Array<Record<string, unknown>> = [];

    const visit = (input: unknown) => {
      if (typeof input === "string") {
        const text = this.finalizeSystemText([input]);
        if (text) blocks.push({ type: "text", text });
        return;
      }
      if (Array.isArray(input)) {
        for (const item of input) visit(item);
        return;
      }
      if (!input || typeof input !== "object") return;

      const record = input as Record<string, unknown>;
      if (typeof record.text === "string") {
        const text = this.finalizeSystemText([record.text]);
        if (text) {
          blocks.push(
            this.applyCacheControl({ type: "text", text }, record.cache_control),
          );
        }
        return;
      }
      if (typeof record.content === "string") {
        const text = this.finalizeSystemText([record.content]);
        if (text) {
          blocks.push(
            this.applyCacheControl({ type: "text", text }, record.cache_control),
          );
        }
        return;
      }
      if (record.content !== undefined) {
        visit(record.content);
        return;
      }
      if (Array.isArray(record.parts)) {
        visit(record.parts);
      }
    };

    visit(value);
    return blocks.length > 0 ? blocks : undefined;
  }

  /**
   * Canonicalize system content to the safest Anthropic form: a single trimmed
   * string with whitespace-only chunks removed.
   */
  private finalizeSystemText(chunks: string[]): string | undefined {
    const cleaned = chunks
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0);
    if (cleaned.length === 0) return undefined;
    return cleaned.join("\n\n");
  }

  private logSystemValidationError(body: any, err: string): void {
    if (!/invalid_request_error/i.test(err)) return;
    if (!/system(?:\.\d+)?\s*:/i.test(err)) return;
    const systemValue = body?.system;
    console.error("[anthropic] system validation failed", {
      code: "invalid_request_error",
      model: body?.model,
      systemType: Array.isArray(systemValue) ? "array" : typeof systemValue,
      systemUtf8Bytes:
        typeof systemValue === "string"
          ? Buffer.byteLength(systemValue, "utf8")
          : null,
      systemBlockCount: Array.isArray(systemValue) ? systemValue.length : null,
      messageCount: Array.isArray(body?.messages) ? body.messages.length : null,
      toolCount: Array.isArray(body?.tools) ? body.tools.length : null,
    });
  }

  /** Keys that are internal to Lumiverse and should never be sent to APIs. */
  private static readonly INTERNAL_PARAMS = new Set([
    "max_context_length",
    "_include_usage",
    "_streaming",
  ]);

  /** Tool controls are scrubbed only for host-owned feature modes. */
  private static readonly TOOL_CONTROL_PARAMS = new Set([
    "tools", "tool_choice", "parallel_tool_calls", "functions", "function_call",
    "plugins", "web_search", "google_search", "enable_web_search", "enableSearch",
  ]);

  /** Keys explicitly handled by Anthropic's buildBody — excluded from passthrough. */
  private static readonly HANDLED_PARAMS = new Set([
    "temperature",
    "max_tokens",
    "top_p",
    "top_k",
    "stop",
    "thinking",
    "output_config",
    "system",
    "prompt_caching",
  ]);

  private buildBody(request: GenerationRequest, stream: boolean): any {
    if (request.toolMode === "required" && !this.capabilities.requiredToolChoice) {
      throw new Error("Provider does not support required tool choice");
    }
    const params = request.parameters || {};
    const omitSampling = this.omitsSamplingParams(request.model);
    const suppressThinking = this.shouldSuppressThinking(request);
    const systemBlocks: Array<Record<string, unknown>> = [];
    const normalizedMessages: Array<{
      role: "user" | "assistant";
      content: string | any[];
    }> = [];
    let sawNonSystem = false;

    for (const message of request.messages) {
      if (!sawNonSystem && message.role === "system") {
        systemBlocks.push(...this.formatSystemMessage(message));
        continue;
      }

      sawNonSystem = true;
      normalizedMessages.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content: this.formatContent(message, suppressThinking),
      });
    }

    const mergedMessages: typeof normalizedMessages = [];
    for (const msg of normalizedMessages) {
      if (
        mergedMessages.length > 0 &&
        mergedMessages[mergedMessages.length - 1].role === msg.role
      ) {
        const prev = mergedMessages[mergedMessages.length - 1];
        if (
          typeof prev.content === "string" &&
          typeof msg.content === "string"
        ) {
          prev.content += "\n\n" + msg.content;
        } else {
          // If either is multipart, combine them into an array
          const prevParts =
            typeof prev.content === "string"
              ? [{ type: "text", text: prev.content }]
              : [...prev.content];
          const newParts =
            typeof msg.content === "string"
              ? [{ type: "text", text: "\n\n" + msg.content }]
              : msg.content;
          prev.content = prevParts.concat(newParts) as any;
        }
      } else {
        mergedMessages.push(msg);
      }
    }

    const body: any = {
      model: request.model,
      messages: mergedMessages,
      max_tokens: params.max_tokens || 4096,
      stream,
    };

    const normalizedParamSystem = this.normalizeSystemParam(params.system);
    if (normalizedParamSystem) {
      systemBlocks.push(...normalizedParamSystem);
    }
    if (systemBlocks.length > 0) {
      body.system = systemBlocks;
    }

    if (body.messages.length === 0) {
      body.messages = [
        { role: "user", content: AnthropicProvider.PROMPT_PLACEHOLDER },
      ];
    }

    if (!omitSampling && params.temperature !== undefined)
      body.temperature = params.temperature;
    if (!omitSampling && params.top_p !== undefined) body.top_p = params.top_p;
    if (!omitSampling && params.top_k !== undefined) body.top_k = params.top_k;
    if (params.stop) body.stop_sequences = params.stop;

    const normalizedCacheControl = this.normalizeCacheControl(
      params.prompt_caching,
    );
    if (normalizedCacheControl) {
      body.cache_control = normalizedCacheControl;
    }

    // Extended/adaptive thinking
    const normalizedThinking = this.normalizeThinkingConfig(params.thinking);
    if (normalizedThinking) {
      body.thinking = normalizedThinking;
    }
    // Anthropic uses `output_config` for both structured output (`format`) and
    // reasoning effort. Preserve non-reasoning keys even when thinking is off,
    // but never leak `effort` alongside `thinking: disabled`.
    const normalizedOutputConfig = this.normalizeOutputConfig(
      params.output_config,
      normalizedThinking,
    );
    if (normalizedOutputConfig) {
      body.output_config = normalizedOutputConfig;
    }

    // Passthrough: include extra params (e.g. from custom body) not already
    // handled explicitly. This enables provider-specific params to reach the API.
    for (const key of Object.keys(params)) {
      if (body[key] !== undefined) continue;
      if (AnthropicProvider.HANDLED_PARAMS.has(key)) continue;
      if (AnthropicProvider.INTERNAL_PARAMS.has(key)) continue;
      if (request.toolMode && AnthropicProvider.TOOL_CONTROL_PARAMS.has(key)) continue;
      if (
        omitSampling &&
        (key === "temperature" || key === "top_p" || key === "top_k")
      ) {
        continue;
      }
      body[key] = params[key];
    }
    // Feature-active modes own all tool controls after custom-body merge.
    if (request.toolMode === "finalization") {
      body.tools = [];
      body.tool_choice = { type: "none" };
    } else if (request.toolMode === "required") {
      if (!request.tools || request.tools.length === 0) throw new Error("Required tool mode needs at least one admitted host tool");
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        ...(this.normalizeCacheControl(t.cache_control)
          ? { cache_control: this.normalizeCacheControl(t.cache_control) }
          : {}),
        strict: false,
      }));
      body.tool_choice = { type: "any" };
    } else if (request.toolMode === "ordinary") {
      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
          ...(this.normalizeCacheControl(t.cache_control)
            ? { cache_control: this.normalizeCacheControl(t.cache_control) }
            : {}),
          strict: false,
        }));
      } else {
        delete body.tools;
        body.tool_choice = { type: "none" };
      }
    } else if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        ...(this.normalizeCacheControl(t.cache_control)
          ? { cache_control: this.normalizeCacheControl(t.cache_control) }
          : {}),
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
        ...(t.inputExamples ? { input_examples: t.inputExamples } : {}),
      }));
    }

    return body;
  }
}
