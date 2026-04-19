import type { LlmProvider } from "../provider";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import { readWithAbort } from "../stream-utils";
import { getTextContent, type GenerationRequest, type GenerationResponse, type StreamChunk, type ToolCallResult, type LlmMessage, type LlmMessagePart } from "../types";

const API_VERSION = "2023-06-01";

export class AnthropicProvider implements LlmProvider {
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

  async generate(apiKey: string, apiUrl: string, request: GenerationRequest): Promise<GenerationResponse> {
    const url = `${this.baseUrl(apiUrl)}/v1/messages`;
    const body = this.buildBody(request, false);

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const data = await res.json() as any;
    const blocks = data.content || [];
    const textContent = blocks
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
    const thinkingContent = blocks
      .filter((c: any) => c.type === "thinking")
      .map((c: any) => c.thinking)
      .join("");

    const toolUseBlocks = blocks.filter((c: any) => c.type === "tool_use");
    const toolCalls: ToolCallResult[] | undefined = toolUseBlocks.length > 0
      ? toolUseBlocks.map((c: any) => ({ name: c.name, args: c.input ?? {}, call_id: c.id }))
      : undefined;

    return {
      content: textContent,
      reasoning: thinkingContent || undefined,
      finish_reason: toolCalls ? "tool_calls" : (data.stop_reason || "end_turn"),
      tool_calls: toolCalls,
      usage: data.usage
        ? {
            prompt_tokens: data.usage.input_tokens,
            completion_tokens: data.usage.output_tokens,
            total_tokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined,
    };
  }

  async *generateStream(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const url = `${this.baseUrl(apiUrl)}/v1/messages`;
    const body = this.buildBody(request, true);

    // NOTE: signal intentionally NOT passed to fetch — see src/llm/stream-utils.ts.
    // Abort is handled in-loop via readWithAbort() and a reader.cancel() in finally.
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamInputTokens = 0;

    // Tool call accumulation — Anthropic streams tool_use as content blocks
    const pendingToolCalls: { id: string; name: string; inputJson: string }[] = [];
    let currentToolIdx = -1;

    try {
    while (true) {
      const { done, value } = await readWithAbort(reader, request.signal);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        try {
          const data = JSON.parse(trimmed.slice(6));

          if (data.type === "message_start" && data.message?.usage) {
            // Capture input token count from message_start (output tokens arrive in message_delta)
            streamInputTokens = data.message.usage.input_tokens || 0;
          } else if (data.type === "content_block_start") {
            if (data.content_block?.type === "tool_use") {
              pendingToolCalls.push({ id: data.content_block.id, name: data.content_block.name, inputJson: "" });
              currentToolIdx = pendingToolCalls.length - 1;
            }
          } else if (data.type === "content_block_delta") {
            if (data.delta?.type === "thinking_delta") {
              yield { token: "", reasoning: data.delta.thinking };
            } else if (data.delta?.type === "text_delta") {
              yield { token: data.delta.text };
            } else if (data.delta?.type === "input_json_delta" && currentToolIdx >= 0) {
              pendingToolCalls[currentToolIdx].inputJson += data.delta.partial_json;
            }
          } else if (data.type === "message_delta") {
            const outputTokens = data.usage?.output_tokens || 0;
            const usage = (streamInputTokens || outputTokens)
              ? {
                  prompt_tokens: streamInputTokens,
                  completion_tokens: outputTokens,
                  total_tokens: streamInputTokens + outputTokens,
                }
              : undefined;

            const stopReason = data.delta?.stop_reason;
            if (stopReason) {
              // Emit accumulated tool calls when Anthropic signals tool_use stop
              const toolCalls: ToolCallResult[] | undefined = pendingToolCalls.length > 0
                ? pendingToolCalls.map(tc => ({ name: tc.name, args: JSON.parse(tc.inputJson || "{}"), call_id: tc.id }))
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
      return res.status !== 401 && res.status !== 403;
    } catch {
      return false;
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/v1/models`, {
        headers: this.headers(apiKey),
      });
      if (!res.ok) return [];
      const data = await res.json() as any;
      return (data.data || []).map((m: any) => m.id).sort();
    } catch {
      return [];
    }
  }

  /** Format message content for the Anthropic API, handling multipart (vision) content. */
  private formatContent(m: LlmMessage): string | any[] {
    if (typeof m.content === "string") return m.content;
    return m.content.map((part: LlmMessagePart) => {
      switch (part.type) {
        case "text":
          return { type: "text", text: part.text };
        case "image":
          return { type: "image", source: { type: "base64", media_type: part.mime_type, data: part.data } };
        case "audio":
          // Anthropic doesn't support native audio content blocks — include as text note
          return { type: "text", text: `[Audio attachment: ${part.mime_type}]` };
        default:
          return { type: "text", text: "" };
      }
    });
  }

  /** Keys that are internal to Lumiverse and should never be sent to any provider API. */
  private static readonly INTERNAL_PARAMS = new Set(["max_context_length", "_include_usage", "_streaming"]);

  /** Keys explicitly handled by Anthropic's buildBody — excluded from passthrough. */
  private static readonly HANDLED_PARAMS = new Set([
    "temperature", "max_tokens", "top_p", "top_k", "stop", "thinking", "output_config",
  ]);

  private buildBody(request: GenerationRequest, stream: boolean): any {
    const params = request.parameters || {};

    // Separate system message from the rest
    const systemMessages = request.messages.filter((m) => m.role === "system");
    const otherMessages = request.messages.filter((m) => m.role !== "system");

    const body: any = {
      model: request.model,
      messages: otherMessages.map((m) => ({ role: m.role, content: this.formatContent(m) })),
      max_tokens: params.max_tokens || 4096,
      stream,
    };

    if (systemMessages.length > 0) {
      body.system = systemMessages.map((m) => getTextContent(m)).join("\n\n");
    }

    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.top_p !== undefined) body.top_p = params.top_p;
    if (params.top_k !== undefined) body.top_k = params.top_k;
    if (params.stop) body.stop_sequences = params.stop;

    // Extended/adaptive thinking
    if (params.thinking) {
      body.thinking = params.thinking;
    }
    // Adaptive thinking effort: { effort: "low" | "medium" | "high" | "max" }
    if (params.output_config) {
      body.output_config = params.output_config;
    }

    // Passthrough: include extra params (e.g. from custom body) not already
    // handled explicitly. This enables provider-specific params to reach the API.
    for (const key of Object.keys(params)) {
      if (body[key] !== undefined) continue;
      if (AnthropicProvider.HANDLED_PARAMS.has(key)) continue;
      if (AnthropicProvider.INTERNAL_PARAMS.has(key)) continue;
      body[key] = params[key];
    }

    // Inline council tools: pass as Anthropic tool_use format
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    return body;
  }
}
