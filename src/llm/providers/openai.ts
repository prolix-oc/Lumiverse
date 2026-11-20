import { describeGenerationStop } from "../generation-stop";
import { omitDisabledPenalties } from "../generation-parameters";
import { incompleteStream, readProviderSse, throwIfProviderError } from "../provider-sse";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import { fetchWithPreflightAbort, readJsonWithAbort } from "../stream-utils";
import type {
  GenerationRequest,
  GenerationResponse,
  StreamChunk,
  ToolCallResult,
  LlmMessage,
  LlmMessagePart,
} from "../types";
import { getTextContent } from "../types";
import { throwProviderResponseError } from "../../utils/provider-errors";
import { splitLeadingSystemMessagePrefix } from "../system-message-prefix";

export class OpenAIProvider extends OpenAICompatibleProvider {
  readonly name = "openai";
  readonly displayName = "OpenAI";
  readonly defaultUrl = "https://api.openai.com/v1";

  readonly capabilities: ProviderCapabilities = {
    parameters: {
      temperature: { ...COMMON_PARAMS.temperature, max: 2 },
      max_tokens: COMMON_PARAMS.max_tokens,
      top_p: COMMON_PARAMS.top_p,
      top_k: COMMON_PARAMS.top_k,
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
    const out: any[] = [];
    for (const part of m.content as LlmMessagePart[]) {
      switch (part.type) {
        case "text":
          out.push({ type: "input_text", text: part.text });
          break;
        case "image":
          out.push({ type: "input_image", image_url: `data:${part.mime_type};base64,${part.data}` });
          break;
        case "audio":
          out.push({ type: "input_audio", data: part.data, format: part.mime_type.split("/")[1] });
          break;
      }
    }
    return out;
  }

  // Flatten one LlmMessage into the input-item sequence for /v1/responses.
  // tool_use becomes a function_call item, tool_result becomes a
  // function_call_output item. Message items (role+content) are emitted only
  // when non-tool parts exist.
  private flattenForResponses(m: LlmMessage): any[] {
    if (typeof m.content === "string") {
      return [{ role: m.role, content: m.content }];
    }
    const parts = m.content as LlmMessagePart[];
    const out: any[] = [];
    const nonTool = parts.filter((p) => p.type !== "tool_use" && p.type !== "tool_result");
    if (nonTool.length > 0) {
      out.push({ role: m.role, content: this.formatResponsesContent({ ...m, content: nonTool }) });
    }
    for (const p of parts) {
      if (p.type === "tool_use") {
        out.push({
          type: "function_call",
          call_id: p.id,
          name: p.name,
          arguments: JSON.stringify(p.input ?? {}),
        });
      } else if (p.type === "tool_result") {
        out.push({
          type: "function_call_output",
          call_id: p.tool_use_id,
          output: p.content,
        });
      }
    }
    return out;
  }

  /**
   * Build the request body for OpenAI's /v1/responses endpoint.
   *
   * Key differences from /v1/chat/completions:
   * - `messages` → `input`
   * - `max_tokens` → `max_output_tokens`
   * - The leading system-message prefix becomes top-level `instructions`
   *   while later system messages remain transcript items
   * - `frequency_penalty`, `presence_penalty`, `stop` are not supported
   * - Multipart content uses `input_text` / `input_image` / `input_audio` types
   */
  private buildResponsesBody(request: GenerationRequest): Record<string, any> {
    const params = omitDisabledPenalties(request.parameters);

    // Only the leading system prefix belongs in top-level instructions.
    // Later system messages may be depth-positioned inside/after history, and
    // Responses supports compatible message items for preserving transcripts.
    const { prefix: systemMessages, remainder: inputMessages } =
      splitLeadingSystemMessagePrefix(request.messages);

    const body: Record<string, any> = {
      model: request.model,
      input: inputMessages.flatMap((m) => this.flattenForResponses(m)),
    };

    if (systemMessages.length > 0) {
      body.instructions = systemMessages.map((m) => getTextContent(m)).join("\n\n");
    }

    // Map supported sampler params
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.top_p !== undefined) body.top_p = params.top_p;
    if (params.top_k !== undefined) body.top_k = params.top_k;
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

  private responseRefusal(data: any): string {
    return (data.output || []).flatMap((item: any) => item.type === "message" ? item.content || [] : [])
      .filter((part: any) => part.type === "refusal")
      .map((part: any) => part.refusal || "").join("");
  }

  private responseOutcome(data: any, refusal: string): Pick<GenerationResponse, "finish_reason" | "stop_details"> {
    if (data.status === "incomplete") {
      const reason = data.incomplete_details?.reason || "incomplete";
      return { finish_reason: reason, stop_details: { type: "incomplete", category: reason } };
    }
    if (data.status && data.status !== "completed") {
      return { finish_reason: data.status, stop_details: {
        type: "failed", category: data.error?.code || data.status,
        explanation: data.error?.message || null,
      } };
    }
    return {
      finish_reason: "stop",
      ...(refusal ? { stop_details: { type: "refusal", explanation: refusal } } : {}),
    };
  }

  // -- Non-streaming ----------------------------------------------------------

  private async generateResponsesApi(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest
  ): Promise<GenerationResponse> {
    const url = `${this.baseUrl(apiUrl)}/responses`;
    const body = this.buildResponsesBody(request);

    const res = await fetchWithPreflightAbort(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
    }, request.signal, { observer: request.onProviderRequest, provider: this.name, model: request.model, credentials: [apiKey] });

    if (!res.ok) await throwProviderResponseError(this.displayName, "responses generate", res);

    const data = (await readJsonWithAbort<any>(res, request.signal)) as any;

    // Failed Responses carry an error inside the response object; retain it
    // as outcome metadata alongside any partial output.
    if (data.status !== "failed") throwIfProviderError(data, this.displayName, "responses generate");
    const refusal = this.responseRefusal(data);
    const outcome = this.responseOutcome(data, refusal);
    const failed = describeGenerationStop(outcome.finish_reason, outcome.stop_details);

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
        if (item.type === "message" && item.content && data.output_text === undefined) {
          for (const part of item.content) {
            if (part.type === "output_text") content += part.text;
            else if (part.type === "refusal") content += part.refusal || "";
          }
        }
        // Function call items
        if (item.type === "function_call" && !failed) {
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
      content: content || refusal,
      reasoning,
      ...outcome,
      finish_reason: toolCalls && !failed ? "tool_calls" : outcome.finish_reason,
      tool_calls: toolCalls,
      usage: data.usage
        ? {
            prompt_tokens: data.usage.input_tokens || 0,
            completion_tokens: data.usage.output_tokens || 0,
            total_tokens:
              (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
            // Retain `input_tokens_details.cached_tokens` (and any future
            // cache telemetry) so the prompt inspector can report implicit
            // OpenAI prompt-cache hits just as it can for Chat Completions.
            provider_raw: { ...data.usage },
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

    const res = await fetchWithPreflightAbort(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
    }, request.signal, { observer: request.onProviderRequest, provider: this.name, model: request.model, credentials: [apiKey] });

    if (!res.ok) await throwProviderResponseError(this.displayName, "responses stream", res);

    const fnCallBuffer = new Map<string, { name: string; argsJson: string; callId: string }>();
    let refusal = "";
    let terminal: StreamChunk | undefined;
    for await (const parsed of readProviderSse(res, this.displayName, request.signal)) {
      throwIfProviderError(parsed, this.displayName, "responses stream");
      switch (parsed.type) {
        case "response.output_text.delta":
          yield { token: parsed.delta || "" };
          break;
        case "response.reasoning_summary_text.delta":
          yield { token: "", reasoning: parsed.delta || "" };
          break;
        case "response.refusal.delta":
          refusal += parsed.delta || "";
          yield { token: parsed.delta || "" };
          break;
        case "response.refusal.done":
          if (!refusal && parsed.refusal) {
            refusal = parsed.refusal;
            yield { token: refusal };
          }
          break;
        case "response.function_call_arguments.delta":
        case "response.function_call_arguments.done": {
          request.onResponseActivity?.();
          const itemId = parsed.item_id || parsed.output_index?.toString() || "0";
          const existing = fnCallBuffer.get(itemId);
          if (existing) {
            if (parsed.type.endsWith(".done") && parsed.arguments) existing.argsJson = parsed.arguments;
            else existing.argsJson += parsed.delta || "";
          }
          break;
        }
        case "response.output_item.added": {
          const item = parsed.item;
          if (item?.type === "function_call") fnCallBuffer.set(item.id || parsed.output_index?.toString() || String(fnCallBuffer.size), {
            name: item.name || "", argsJson: item.arguments || "",
            callId: item.call_id || item.id || crypto.randomUUID(),
          });
          break;
        }
        case "response.completed":
        case "response.done":
        case "response.incomplete":
        case "response.failed": {
          const resp = parsed.response || parsed;
          if (!refusal) {
            refusal = this.responseRefusal(resp);
            if (refusal) yield { token: refusal };
          }
          const outcome = this.responseOutcome({
            ...resp, status: resp.status || (parsed.type === "response.done" ? "completed" : parsed.type.slice(9)),
          }, refusal);
          const failed = describeGenerationStop(outcome.finish_reason, outcome.stop_details);
          const calls = fnCallBuffer.size ? [...fnCallBuffer.values()]
            : (resp.output || []).filter((item: any) => item.type === "function_call").map((item: any) => ({
                name: item.name, argsJson: item.arguments, callId: item.call_id || item.id || crypto.randomUUID(),
              }));
          const toolCalls: ToolCallResult[] | undefined = !failed && calls.length
            ? calls.map((tc: { name: string; argsJson: string; callId: string }) => ({
                name: tc.name, args: JSON.parse(tc.argsJson || "{}"), call_id: tc.callId,
              })) : undefined;
          terminal = {
            token: "", ...outcome,
            finish_reason: toolCalls && !failed ? "tool_calls" : outcome.finish_reason,
            stopReceivedAt: Date.now(),
            tool_calls: toolCalls,
            usage: resp.usage ? {
              prompt_tokens: resp.usage.input_tokens || 0,
              completion_tokens: resp.usage.output_tokens || 0,
              total_tokens: (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0),
              provider_raw: { ...resp.usage },
            } : undefined,
          };
          break;
        }
        // Other lifecycle events do not mark completion.
      }
      if (terminal) break;
    }
    if (request.signal?.aborted) return;
    if (!terminal) throw incompleteStream(this.displayName);
    yield terminal;
  }
}
