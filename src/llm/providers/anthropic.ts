import type { LlmProvider } from "../provider";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import { createCooperativeYielder, readWithAbort } from "../stream-utils";
import {
  getTextContent,
  type GenerationRequest,
  type GenerationResponse,
  type StreamChunk,
  type ToolCallResult,
  type LlmMessage,
  type LlmMessagePart,
} from "../types";
import {
  fetchProviderJson,
  ProviderRequestError,
  throwProviderResponseError,
} from "../../utils/provider-errors";

const API_VERSION = "2023-06-01";

export class AnthropicProvider implements LlmProvider {
  private static readonly PROMPT_PLACEHOLDER = "Let's get started.";

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
  };

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

  private isOpus47Model(model: string): boolean {
    return /^claude-opus-4-7(?:$|[-:@])/.test((model || "").trim());
  }

  private shouldSuppressThinking(request: GenerationRequest): boolean {
    const thinking = request.parameters?.thinking;
    return (
      !!thinking &&
      typeof thinking === "object" &&
      (thinking as any).type === "disabled"
    );
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

  async generate(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest,
  ): Promise<GenerationResponse> {
    const url = `${this.baseUrl(apiUrl)}/v1/messages`;
    const body = this.buildBody(request, false);
    const suppressThinking = this.shouldSuppressThinking(request);

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      this.logSystemValidationError(body, err);
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as any;
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

    const inputTokens = (data.usage?.input_tokens || 0) +
                        (data.usage?.cache_read_input_tokens || 0) +
                        (data.usage?.cache_creation_input_tokens || 0);
    const outputTokens = data.usage?.output_tokens || 0;

    return {
      content: textContent,
      reasoning: thinkingContent || undefined,
      finish_reason: toolCalls ? "tool_calls" : data.stop_reason || "end_turn",
      tool_calls: toolCalls,
      usage: data.usage
        ? {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          }
        : undefined,
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

    // NOTE: signal intentionally NOT passed to fetch — see src/llm/stream-utils.ts.
    // Abort is handled in-loop via readWithAbort() and a reader.cancel() in finally.
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logSystemValidationError(body, err);
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamInputTokens = 0;
    const maybeYield = createCooperativeYielder(64, request.signal);

    // Tool call accumulation — Anthropic streams tool_use as content blocks
    const pendingToolCalls: { id: string; name: string; inputJson: string }[] =
      [];
    let currentToolIdx = -1;

    try {
      while (true) {
        const { done, value } = await readWithAbort(reader, request.signal);
        if (done) break;

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
              }
            } else if (data.type === "content_block_delta") {
              if (data.delta?.type === "thinking_delta") {
                if (suppressThinking) {
                  yield { token: data.delta.thinking };
                } else {
                  yield { token: "", reasoning: data.delta.thinking };
                }
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
              const usage =
                streamInputTokens || outputTokens
                  ? {
                      prompt_tokens: streamInputTokens,
                      completion_tokens: outputTokens,
                      total_tokens: streamInputTokens + outputTokens,
                    }
                  : undefined;

              const stopReason = data.delta?.stop_reason;
              if (stopReason) {
                // Emit accumulated tool calls when Anthropic signals tool_use stop
                const toolCalls: ToolCallResult[] | undefined =
                  pendingToolCalls.length > 0
                    ? pendingToolCalls.map((tc) => ({
                        name: tc.name,
                        args: JSON.parse(tc.inputJson || "{}"),
                        call_id: tc.id,
                      }))
                    : undefined;
                yield {
                  token: "",
                  finish_reason: toolCalls ? "tool_calls" : stopReason,
                  tool_calls: toolCalls,
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
      reader.cancel().catch(() => {});
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

  /** Format message content for the Anthropic API, handling multipart (vision) content. */
  private formatContent(m: LlmMessage): string | any[] {
    if (typeof m.content === "string") return m.content;
    return m.content.map((part: LlmMessagePart) => {
      switch (part.type) {
        case "text":
          return { type: "text", text: part.text };
        case "image":
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: part.mime_type,
              data: part.data,
            },
          };
        case "audio":
          // Anthropic doesn't support native audio content blocks — include as text note
          return {
            type: "text",
            text: `[Audio attachment: ${part.mime_type}]`,
          };
        default:
          return { type: "text", text: "" };
      }
    });
  }

  /**
   * Anthropic accepts `system` as either a string or TextBlockParam[]. In
   * practice, Lumiverse does not need block-level system features here, and the
   * string form is the least error-prone across custom-body inputs and proxies.
   */
  private normalizeSystemParam(value: unknown): string | undefined {
    if (typeof value === "string") {
      return this.finalizeSystemText([value]);
    }

    const chunks: string[] = [];

    const visit = (input: unknown) => {
      if (typeof input === "string") {
        if (input) chunks.push(input);
        return;
      }
      if (Array.isArray(input)) {
        for (const item of input) visit(item);
        return;
      }
      if (!input || typeof input !== "object") return;

      const record = input as Record<string, unknown>;
      if (typeof record.text === "string") {
        if (record.text) chunks.push(record.text);
        return;
      }
      if (typeof record.content === "string") {
        if (record.content) chunks.push(record.content);
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
    return this.finalizeSystemText(chunks);
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
    const omitSampling = this.isOpus47Model(request.model);
    const systemBlocks: Array<{ type: "text"; text: string }> = [];
    const normalizedMessages: Array<{
      role: "user" | "assistant";
      content: string | any[];
    }> = [];
    let sawNonSystem = false;

    for (const message of request.messages) {
      if (!sawNonSystem && message.role === "system") {
        const text = this.finalizeSystemText([getTextContent(message)]);
        if (text) systemBlocks.push({ type: "text", text });
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
      systemBlocks.push({ type: "text", text: normalizedParamSystem });
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

    const enableCaching = params.prompt_caching === true;
    if (enableCaching) {
      body.cache_control = { type: "ephemeral" };
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
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
        ...(t.inputExamples ? { input_examples: t.inputExamples } : {}),
      }));
    }

    return body;
  }
}
