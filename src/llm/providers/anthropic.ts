import type { LlmProvider } from "../provider";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import { cancelStreamAndCloseConnection, createCooperativeYielder, fetchWithPreflightAbort, readJsonWithAbort, readWithAbort } from "../stream-utils";
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

  /** Opus 4.7/4.8 use adaptive thinking and reject manual sampling params. */
  private omitsSamplingParams(model: string): boolean {
    return /^claude-opus-4-(?:7|8)(?:$|[-:@])/.test((model || "").trim());
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
   * (adaptive thinking on Opus 4.6+/4.7/4.8 and Sonnet 4.6), so it's safe to
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
  protected collectThinkingBlocks(blocks: any[]): LlmThinkingBlock[] {
    const out: LlmThinkingBlock[] = [];
    for (const block of blocks) {
      if (block?.type === "thinking") {
        out.push({
          type: "thinking",
          thinking: block.thinking || "",
          ...(block.signature ? { signature: block.signature } : {}),
        });
      } else if (block?.type === "redacted_thinking") {
        out.push({ type: "redacted_thinking", data: block.data });
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

  private buildUsage(data: any): GenerationUsage | undefined {
    if (!data?.usage) return undefined;
    const inputTokens =
      (data.usage.input_tokens || 0) +
      (data.usage.cache_read_input_tokens || 0) +
      (data.usage.cache_creation_input_tokens || 0);
    const outputTokens = data.usage.output_tokens || 0;
    return {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      provider_raw: { ...data.usage },
    };
  }

  private buildStreamingUsage(
    inputTokens: number,
    outputTokens: number,
    rawUsage?: Record<string, unknown>,
  ): GenerationUsage | undefined {
    if (!inputTokens && !outputTokens && !rawUsage) return undefined;
    return {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
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
      const rawBody = await readBoundedText(res);
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

    const data = (await readJsonWithAbort<any>(res, request.signal)) as any;
    const blocks = data.content || [];
    let textContent = "";
    let thinkingContent = "";
    for (const block of blocks) {
      if (block?.type === "text") {
        textContent += block.text || "";
      } else if (block?.type === "thinking") {
        if (suppressThinking) {
          textContent += block.thinking || "";
        } else {
          thinkingContent += block.thinking || "";
        }
      }
    }

    const toolUseBlocks = blocks.filter((c: any) => c.type === "tool_use");
    const toolCalls: ToolCallResult[] | undefined =
      toolUseBlocks.length > 0
        ? toolUseBlocks.map((c: any) => ({
            name: c.name,
            args: c.input ?? {},
            call_id: c.id,
          }))
        : undefined;

    // Capture native thinking blocks (with signatures) so the caller can replay
    // them on tool-use continuations — required for interleaved thinking. Not
    // collected when thinking is suppressed (it was merged into text above).
    const thinkingBlocks = suppressThinking
      ? []
      : this.collectThinkingBlocks(blocks);

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
      const rawBody = await readBoundedText(res);
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

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamInputTokens = 0;
    let streamUsageRaw: Record<string, unknown> | undefined;
    const maybeYield = createCooperativeYielder(64, request.signal);

    // Tool call accumulation — Anthropic streams tool_use as content blocks
    const pendingToolCalls: { id: string; name: string; inputJson: string }[] =
      [];
    let currentToolIdx = -1;

    // Native thinking-block accumulation. Thinking blocks carry the model's
    // reasoning text plus an opaque `signature` (streamed as a signature_delta
    // just before content_block_stop). They must be replayed verbatim on
    // tool-use continuations to keep interleaved thinking intact. Skipped when
    // thinking is suppressed (deltas are merged into text instead).
    const thinkingBlocks: LlmThinkingBlock[] = [];
    let currentThinkingIdx = -1;

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

            if (data.type === "message_start" && data.message?.usage) {
              // Capture input token count from message_start (output tokens arrive in message_delta)
              const u = data.message.usage;
              streamUsageRaw = { ...u };
              streamInputTokens = (u.input_tokens || 0) +
                                  (u.cache_read_input_tokens || 0) +
                                  (u.cache_creation_input_tokens || 0);
            } else if (data.type === "content_block_start") {
              if (data.content_block?.type === "tool_use") {
                pendingToolCalls.push({
                  id: data.content_block.id,
                  name: data.content_block.name,
                  inputJson: "",
                });
                currentToolIdx = pendingToolCalls.length - 1;
              } else if (
                !suppressThinking &&
                data.content_block?.type === "thinking"
              ) {
                thinkingBlocks.push({
                  type: "thinking",
                  thinking: data.content_block.thinking || "",
                  ...(data.content_block.signature
                    ? { signature: data.content_block.signature }
                    : {}),
                });
                currentThinkingIdx = thinkingBlocks.length - 1;
              } else if (
                !suppressThinking &&
                data.content_block?.type === "redacted_thinking"
              ) {
                // redacted_thinking is delivered whole (no deltas).
                thinkingBlocks.push({
                  type: "redacted_thinking",
                  data: data.content_block.data,
                });
              }
            } else if (data.type === "content_block_delta") {
              if (data.delta?.type === "thinking_delta") {
                if (suppressThinking) {
                  yield { token: data.delta.thinking };
                } else {
                  if (currentThinkingIdx >= 0) {
                    thinkingBlocks[currentThinkingIdx].thinking =
                      (thinkingBlocks[currentThinkingIdx].thinking || "") +
                      (data.delta.thinking || "");
                  }
                  yield { token: "", reasoning: data.delta.thinking };
                }
              } else if (
                data.delta?.type === "signature_delta" &&
                !suppressThinking
              ) {
                // The opaque signature for the current thinking block. Create a
                // block defensively if none was started (e.g. display:"omitted"
                // where text deltas may be skipped).
                if (currentThinkingIdx < 0) {
                  thinkingBlocks.push({ type: "thinking", thinking: "" });
                  currentThinkingIdx = thinkingBlocks.length - 1;
                }
                thinkingBlocks[currentThinkingIdx].signature =
                  (thinkingBlocks[currentThinkingIdx].signature || "") +
                  (data.delta.signature || "");
              } else if (data.delta?.type === "text_delta") {
                yield { token: data.delta.text };
              } else if (
                data.delta?.type === "input_json_delta" &&
                currentToolIdx >= 0
              ) {
                pendingToolCalls[currentToolIdx].inputJson +=
                  data.delta.partial_json;
              }
            } else if (data.type === "message_delta") {
              const outputTokens = data.usage?.output_tokens || 0;
              const usageRaw = data.usage
                ? { ...(streamUsageRaw || {}), ...data.usage }
                : streamUsageRaw;
              const usage = this.buildStreamingUsage(
                streamInputTokens,
                outputTokens,
                usageRaw,
              );

              const stopReason = data.delta?.stop_reason;
              if (stopReason) {
                // Build tool_calls defensively. If the model was cut off
                // (e.g. stop_reason="max_tokens") mid-input_json, the
                // accumulated partial_json will not be valid JSON. We MUST
                // still yield the terminal chunk so the host sees
                // finish_reason + usage; otherwise worker-host's for-await
                // exits with finishReasonSeen=false and the generation
                // silent-vanishes downstream.
                let toolCalls: ToolCallResult[] | undefined;
                let toolParseError: string | undefined;
                if (pendingToolCalls.length > 0) {
                  toolCalls = pendingToolCalls.map((tc) => {
                    let parsedArgs: unknown = {};
                    try {
                      parsedArgs = JSON.parse(tc.inputJson || "{}");
                    } catch (e) {
                      toolParseError = `tool '${tc.name}' (call_id=${tc.id}) had unparseable inputJson (likely truncated by stop_reason=${stopReason}). Raw inputJson length=${tc.inputJson.length}, content=${JSON.stringify(tc.inputJson.slice(0, 200))}. Error: ${(e as Error).message}`;
                      console.warn(`[lumiverse.anthropic.sse] ${toolParseError}`);
                      parsedArgs = {
                        _incomplete: true,
                        _raw_partial_json: tc.inputJson,
                        _parse_error: (e as Error).message,
                      };
                    }
                    return {
                      name: tc.name,
                      args: parsedArgs as Record<string, unknown>,
                      call_id: tc.id,
                    };
                  });
                }
                // When stop_reason=max_tokens with a partially-emitted tool
                // call, "tool_calls" is misleading because the tool args are
                // incomplete. Surface the real stop_reason so the agent can
                // react (e.g. retry with higher max_tokens).
                const finishReason =
                  toolCalls && stopReason !== "max_tokens" ? "tool_calls" : stopReason;
                yield {
                  token: "",
                  finish_reason: finishReason,
                  tool_calls: toolCalls,
                  thinking_blocks:
                    thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
                  usage,
                };
              } else if (usage) {
                yield { token: "", usage };
              }
            } else if (data.type === "message_stop") {
              return;
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
            ...(b.signature ? { signature: b.signature } : {}),
          },
    );
  }

  /** Format message content for the Anthropic API, handling multipart (vision)
   *  content and replaying native thinking blocks for interleaved thinking. */
  protected formatContent(m: LlmMessage): string | any[] {
    // Native thinking blocks must be replayed verbatim at the START of the
    // assistant turn, before any text or tool_use blocks. When thinking is
    // active, Anthropic requires the assistant turn to begin with them and
    // rejects tool_use turns that drop them.
    const thinkingParts =
      m.role === "assistant" ? this.formatThinkingBlocks(m.thinking_blocks) : [];

    if (typeof m.content === "string") {
      const hasCacheControl = !!this.normalizeCacheControl(m.cache_control);
      if (thinkingParts.length === 0 && !hasCacheControl) return m.content;
      const textParts = m.content
        ? [this.applyCacheControl({ type: "text", text: m.content }, m.cache_control)]
        : [];
      return [...thinkingParts, ...textParts];
    }

    const parts = m.content.map((part: LlmMessagePart) => {
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
      model: body?.model,
      systemType: Array.isArray(systemValue) ? "array" : typeof systemValue,
      systemLength: typeof systemValue === "string" ? systemValue.length : null,
      systemEscaped: JSON.stringify(systemValue),
      payloadEscaped: JSON.stringify(body),
    });
  }

  /** Keys that are internal to Lumiverse and should never be sent to any provider API. */
  private static readonly INTERNAL_PARAMS = new Set([
    "max_context_length",
    "_include_usage",
    "_streaming",
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
    const params = request.parameters || {};
    const omitSampling = this.omitsSamplingParams(request.model);
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
        content: this.formatContent(message),
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
      if (
        omitSampling &&
        (key === "temperature" || key === "top_p" || key === "top_k")
      )
        continue;
      body[key] = params[key];
    }

    // Inline council tools: pass as Anthropic tool_use format
    if (request.tools && request.tools.length > 0) {
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
