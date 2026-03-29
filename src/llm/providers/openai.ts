import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import type {
  GenerationRequest,
  GenerationResponse,
  StreamChunk,
  ToolCallResult,
  LlmMessage,
  LlmMessagePart,
} from "../types";
import { getTextContent } from "../types";

export class OpenAIProvider extends OpenAICompatibleProvider {
  readonly name = "openai";
  readonly displayName = "OpenAI";
  readonly defaultUrl = "https://api.openai.com/v1";

  readonly capabilities: ProviderCapabilities = {
    parameters: {
      temperature: { ...COMMON_PARAMS.temperature, max: 2 },
      max_tokens: COMMON_PARAMS.max_tokens,
      top_p: COMMON_PARAMS.top_p,
      frequency_penalty: COMMON_PARAMS.frequency_penalty,
      presence_penalty: COMMON_PARAMS.presence_penalty,
      stop: COMMON_PARAMS.stop,
    },
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: true,
    modelListStyle: "openai",
  };

  // ---------------------------------------------------------------------------
  // Responses API support (/v1/responses)
  // ---------------------------------------------------------------------------

  async generate(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest
  ): Promise<GenerationResponse> {
    if (request.parameters?.use_responses_api) {
      return this.generateResponsesApi(apiKey, apiUrl, request);
    }
    return super.generate(apiKey, apiUrl, request);
  }

  async *generateStream(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest
  ): AsyncGenerator<StreamChunk, void, unknown> {
    if (request.parameters?.use_responses_api) {
      yield* this.generateStreamResponsesApi(apiKey, apiUrl, request);
      return;
    }
    yield* super.generateStream(apiKey, apiUrl, request);
  }

  // -- Body building ----------------------------------------------------------

  /** Format multipart content for the Responses API input format. */
  private formatResponsesContent(m: LlmMessage): string | any[] {
    if (typeof m.content === "string") return m.content;
    return m.content.map((part: LlmMessagePart) => {
      switch (part.type) {
        case "text":
          return { type: "input_text", text: part.text };
        case "image":
          return {
            type: "input_image",
            image_url: `data:${part.mime_type};base64,${part.data}`,
          };
        case "audio":
          return {
            type: "input_audio",
            data: part.data,
            format: part.mime_type.split("/")[1],
          };
        default:
          return { type: "input_text", text: "" };
      }
    });
  }

  /**
   * Build the request body for OpenAI's /v1/responses endpoint.
   *
   * Key differences from /v1/chat/completions:
   * - `messages` → `input`
   * - `max_tokens` → `max_output_tokens`
   * - System messages are extracted into the top-level `instructions` field
   * - `frequency_penalty`, `presence_penalty`, `stop` are not supported
   * - Multipart content uses `input_text` / `input_image` / `input_audio` types
   */
  private buildResponsesBody(request: GenerationRequest): Record<string, any> {
    const params = request.parameters || {};

    // Separate system messages → instructions, keep user/assistant as input
    const systemMessages = request.messages.filter((m) => m.role === "system");
    const inputMessages = request.messages.filter((m) => m.role !== "system");

    const body: Record<string, any> = {
      model: request.model,
      input: inputMessages.map((m) => ({
        role: m.role,
        content: this.formatResponsesContent(m),
      })),
    };

    if (systemMessages.length > 0) {
      body.instructions = systemMessages.map((m) => getTextContent(m)).join("\n\n");
    }

    // Map supported sampler params
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.top_p !== undefined) body.top_p = params.top_p;
    if (params.max_tokens !== undefined) body.max_output_tokens = params.max_tokens;

    // Passthrough: forward any extra params the caller set (e.g. reasoning,
    // text.format, previous_response_id, store, metadata, etc.)
    const SKIP_PARAMS = new Set([
      "use_responses_api",
      "max_tokens",
      "temperature",
      "top_p",
      // Not supported by Responses API — silently drop
      "frequency_penalty",
      "presence_penalty",
      "stop",
      // Internal
      "max_context_length",
      "_include_usage",
      "_streaming",
    ]);

    for (const key of Object.keys(params)) {
      if (SKIP_PARAMS.has(key)) continue;
      if (body[key] !== undefined) continue;
      body[key] = params[key];
    }

    // Tools — Responses API uses a slightly different format
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
    }

    return body;
  }

  // -- Non-streaming ----------------------------------------------------------

  private async generateResponsesApi(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest
  ): Promise<GenerationResponse> {
    const url = `${this.baseUrl(apiUrl)}/responses`;
    const body = this.buildResponsesBody(request);

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${this.name} Responses API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as any;

    // Extract text content from response output
    let content = "";
    let reasoning: string | undefined;

    if (data.output_text !== undefined) {
      // SDK-style shorthand present on the response object
      content = data.output_text;
    }

    const fnCalls: ToolCallResult[] = [];

    if (data.output) {
      for (const item of data.output) {
        // Reasoning items (o-series models)
        if (item.type === "reasoning" && item.summary) {
          const parts = Array.isArray(item.summary) ? item.summary : [item.summary];
          reasoning = parts
            .map((s: any) => (typeof s === "string" ? s : s.text || ""))
            .join("");
        }
        // Text message items
        if (item.type === "message" && item.content && !content) {
          for (const part of item.content) {
            if (part.type === "output_text") {
              content += part.text;
            }
          }
        }
        // Function call items
        if (item.type === "function_call") {
          fnCalls.push({
            name: item.name || "",
            args: typeof item.arguments === "string" ? JSON.parse(item.arguments) : (item.arguments ?? {}),
            call_id: item.call_id || item.id || crypto.randomUUID(),
          });
        }
      }
    }

    const toolCalls = fnCalls.length > 0 ? fnCalls : undefined;

    return {
      content,
      reasoning,
      finish_reason: toolCalls ? "tool_calls"
        : data.status === "completed"
          ? "stop"
          : data.incomplete_details?.reason || data.status || "stop",
      tool_calls: toolCalls,
      usage: data.usage
        ? {
            prompt_tokens: data.usage.input_tokens || 0,
            completion_tokens: data.usage.output_tokens || 0,
            total_tokens:
              (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
          }
        : undefined,
    };
  }

  // -- Streaming --------------------------------------------------------------

  private async *generateStreamResponsesApi(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const url = `${this.baseUrl(apiUrl)}/responses`;
    const body = this.buildResponsesBody(request);
    body.stream = true;

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${this.name} Responses API error ${res.status}: ${err}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Tool call accumulation for Responses API function_call streaming
    const fnCallBuffer: Map<string, { name: string; argsJson: string; callId: string }> = new Map();

    try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") return;

        try {
          const parsed = JSON.parse(payload);
          const eventType: string = parsed.type || "";

          switch (eventType) {
            // Text content delta
            case "response.output_text.delta":
              yield { token: parsed.delta || "" };
              break;

            // Reasoning summary delta (o-series models)
            case "response.reasoning_summary_text.delta":
              yield { token: "", reasoning: parsed.delta || "" };
              break;

            // Function call argument streaming
            case "response.function_call_arguments.delta": {
              const itemId = parsed.item_id || parsed.output_index?.toString() || "0";
              const existing = fnCallBuffer.get(itemId);
              if (existing) {
                existing.argsJson += parsed.delta || "";
              }
              break;
            }
            case "response.function_call_arguments.done": {
              const itemId = parsed.item_id || parsed.output_index?.toString() || "0";
              const existing = fnCallBuffer.get(itemId);
              if (existing && parsed.arguments) {
                existing.argsJson = parsed.arguments;
              }
              break;
            }

            // Function call output item added — capture name and call_id
            case "response.output_item.added": {
              const item = parsed.item;
              if (item?.type === "function_call") {
                fnCallBuffer.set(item.id || parsed.output_index?.toString() || String(fnCallBuffer.size), {
                  name: item.name || "",
                  argsJson: "",
                  callId: item.call_id || item.id || crypto.randomUUID(),
                });
              }
              break;
            }

            // Response complete — extract usage and emit tool calls
            case "response.completed":
            case "response.done": {
              const resp = parsed.response || parsed;
              const usage = resp.usage
                ? {
                    prompt_tokens: resp.usage.input_tokens || 0,
                    completion_tokens: resp.usage.output_tokens || 0,
                    total_tokens:
                      (resp.usage.input_tokens || 0) +
                      (resp.usage.output_tokens || 0),
                  }
                : undefined;

              const toolCalls: ToolCallResult[] | undefined = fnCallBuffer.size > 0
                ? [...fnCallBuffer.values()].map(tc => ({
                    name: tc.name,
                    args: JSON.parse(tc.argsJson || "{}"),
                    call_id: tc.callId,
                  }))
                : undefined;

              yield {
                token: "",
                finish_reason: toolCalls ? "tool_calls"
                  : resp.status === "completed"
                    ? "stop"
                    : resp.incomplete_details?.reason || resp.status || "stop",
                tool_calls: toolCalls,
                usage,
              };
              break;
            }

            // All other events (response.created, response.in_progress,
            // response.content_part.added, response.output_text.done,
            // response.output_item.done, etc.) are lifecycle events — silently skip.
            default:
              break;
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
}
