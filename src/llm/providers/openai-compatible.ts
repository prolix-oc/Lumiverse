import type { LlmProvider } from "../provider";
import type { ProviderCapabilities } from "../param-schema";
import { cancelStreamAndCloseConnection, fetchWithPreflightAbort, readJsonWithAbort, readWithAbort, yieldToEventLoop } from "../stream-utils";
import type { GenerationRequest, GenerationResponse, StreamChunk, ToolCallResult, LlmMessage, LlmMessagePart } from "../types";
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

/**
 * Accumulates OpenRouter `reasoning_details` deltas streamed across chunks into
 * a single ordered array. OpenRouter sends each reasoning block as it becomes
 * available; the complete sequence is rebuilt by concatenating the streamable
 * text fields per block `index` while preserving block metadata. The result is
 * replayed verbatim on the assistant message to keep chain-of-thought intact
 * across tool calls (interleaved thinking). Opaque otherwise.
 */
export class ReasoningDetailsAccumulator {
  private byIndex = new Map<number, Record<string, unknown>>();
  private order = 0;
  private seen = false;

  push(incoming: unknown): void {
    if (!Array.isArray(incoming)) return;
    for (const d of incoming) {
      if (!d || typeof d !== "object") continue;
      this.seen = true;
      const rec = d as Record<string, unknown>;
      const idx = typeof rec.index === "number" ? rec.index : this.order++;
      let existing = this.byIndex.get(idx);
      if (!existing) {
        existing = {};
        this.byIndex.set(idx, existing);
      }
      for (const [k, v] of Object.entries(rec)) {
        if (
          REASONING_DETAIL_APPEND_FIELDS.has(k) &&
          typeof v === "string" &&
          typeof existing[k] === "string"
        ) {
          existing[k] = (existing[k] as string) + v;
        } else {
          existing[k] = v;
        }
      }
    }
  }

  finalize(): Record<string, unknown>[] | undefined {
    if (!this.seen) return undefined;
    return [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);
  }
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
    const url = `${this.baseUrl(apiUrl)}/chat/completions`;
    const body = this.buildBody(request, false);

    const res = await fetchWithPreflightAbort(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
    }, request.signal);

    if (!res.ok) await throwProviderResponseError(this.displayName, GENERATE_OPERATION, res);

    const data = (await readJsonWithAbort<any>(res, request.signal)) as any;
    const choice = data.choices?.[0];

    const rawToolCalls = choice?.message?.tool_calls;
    const toolCalls: ToolCallResult[] | undefined = Array.isArray(rawToolCalls) && rawToolCalls.length > 0
      ? rawToolCalls.map((tc: any) => ({
          name: tc.function?.name || tc.name || "",
          args: typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : (tc.function?.arguments ?? {}),
          call_id: tc.id || crypto.randomUUID(),
        }))
      : undefined;

    const normalized = this.splitMirroredReasoning(
      choice?.message?.content,
      choice?.message?.reasoning || choice?.message?.reasoning_content,
    );

    // OpenRouter (and some routed providers) return normalized `reasoning_details`
    // blocks that must be replayed verbatim across tool calls for interleaved
    // thinking. Opaque to us — capture as-is when present.
    const rawReasoningDetails = choice?.message?.reasoning_details;
    const reasoningDetails =
      Array.isArray(rawReasoningDetails) && rawReasoningDetails.length > 0
        ? (rawReasoningDetails as Record<string, unknown>[])
        : undefined;

    return {
      content: normalized.content,
      reasoning: normalized.reasoning,
      finish_reason: toolCalls ? "tool_calls" : (choice?.finish_reason || "stop"),
      tool_calls: toolCalls,
      reasoning_details: reasoningDetails,
      usage: data.usage
        ? {
            prompt_tokens: data.usage.prompt_tokens,
            completion_tokens: data.usage.completion_tokens,
            total_tokens: data.usage.total_tokens,
            // Preserve provider-side telemetry so consumers (e.g. NanoGPT
            // cache hit summary in the prompt breakdown UI) can read fields
            // beyond the canonical three — cache_read_input_tokens,
            // cache_creation_input_tokens, prompt_tokens_details.cached_tokens,
            // and any other passthrough metadata.
            provider_raw: { ...data.usage },
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

    const res = await fetchWithPreflightAbort(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
    }, request.signal);

    if (!res.ok) await throwProviderResponseError(this.displayName, STREAM_OPERATION, res);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Inline counter instead of createCooperativeYielder: the yielder is an
    // async fn, so calling it allocates a promise (and an await hop) on every
    // SSE line even when it doesn't yield. The sync modulo check keeps the
    // 63/64 non-yielding lines allocation-free.
    let lineCount = 0;
    // Auto-detect reasoning field: modern APIs use `reasoning`, legacy uses
    // `reasoning_content`. Lock to whichever key appears first so we don't
    // check both on every chunk.
    let reasoningKey: "reasoning" | "reasoning_content" | null = null;

    // Tool call accumulation — OpenAI streams tool_calls as delta chunks
    const toolCallBuffer: { id: string; name: string; argsJson: string }[] = [];
    // OpenRouter reasoning_details accumulation (streamed as deltas).
    const reasoningDetails = new ReasoningDetailsAccumulator();

    let streamDoneNaturally = false;
    try {
    while (true) {
      const { done, value } = await readWithAbort(reader, request.signal);
      if (done) { streamDoneNaturally = !request.signal?.aborted; break; }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (++lineCount % 64 === 0) await yieldToEventLoop(request.signal);
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          const finishReason = parsed.choices?.[0]?.finish_reason;

          // Accumulate tool call deltas
          for (const tc of (delta?.tool_calls ?? [])) {
            const idx = tc.index ?? toolCallBuffer.length;
            if (!toolCallBuffer[idx]) toolCallBuffer[idx] = { id: tc.id ?? "", name: "", argsJson: "" };
            if (tc.id && !toolCallBuffer[idx].id) toolCallBuffer[idx].id = tc.id;
            if (tc.function?.name) toolCallBuffer[idx].name += tc.function.name;
            if (tc.function?.arguments) toolCallBuffer[idx].argsJson += tc.function.arguments;
          }

          // Accumulate OpenRouter reasoning_details deltas
          reasoningDetails.push(delta?.reasoning_details);

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
          const normalized = this.splitMirroredReasoning(delta?.content, reasoning);
          const content = normalized.content;
          reasoning = normalized.reasoning;

          // Usage data arrives in the final chunk when stream_options.include_usage is true
          const usage = parsed.usage
            ? {
                prompt_tokens: parsed.usage.prompt_tokens || 0,
                completion_tokens: parsed.usage.completion_tokens || 0,
                total_tokens: parsed.usage.total_tokens || 0,
                provider_raw: { ...parsed.usage },
              }
            : undefined;

          if (finishReason) {
            // Emit accumulated tool calls on the finish chunk
            const toolCalls: ToolCallResult[] | undefined = toolCallBuffer.length > 0
              ? toolCallBuffer.map(tc => ({ name: tc.name, args: JSON.parse(tc.argsJson || "{}"), call_id: tc.id || crypto.randomUUID() }))
              : undefined;
            yield {
              token: content || "",
              reasoning,
              finish_reason: toolCalls ? "tool_calls" : finishReason,
              tool_calls: toolCalls,
              reasoning_details: reasoningDetails.finalize(),
              usage,
            };
          } else if (reasoning || content) {
            yield {
              token: content || "",
              reasoning,
              usage,
            };
          } else if (usage) {
            yield { token: "", usage };
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
      return [{ role: m.role, content: m.content }];
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
      out.push({ role: m.role, content: this.formatContent({ ...m, content: nonTool }) });
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

  /** Keys that are internal to Lumiverse and should never be sent to any provider API. */
  protected static readonly INTERNAL_PARAMS = new Set(["max_context_length", "_include_usage", "use_responses_api"]);

  /** Build the request body using capabilities as the parameter allowlist. */
  protected buildBody(request: GenerationRequest, stream: boolean): any {
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
          ...(t.strict !== undefined ? { strict: t.strict } : {}),
        },
      }));
    }

    return body;
  }
}
