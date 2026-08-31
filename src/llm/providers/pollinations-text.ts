import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import {
  createBoundedSseReader,
  ProviderProtocolError,
  ProviderResponseTooLargeError,
  fetchWithPreflightAbort,
  readJsonWithAbort,
  yieldToEventLoop,
} from "../stream-utils";
import { throwProviderResponseError } from "../../utils/provider-errors";
import {
  AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES,
  validateProviderUsage,
} from "../../services/agent-runtime-accounting";
import type {
  GenerationRequest,
  GenerationResponse,
  GenerationUsage,
  StreamChunk,
} from "../types";

const POLLINATIONS_FINISH_REASONS: Record<string, true> = {
  stop: true,
  length: true,
  content_filter: true,
};

export class PollinationsTextProvider extends OpenAICompatibleProvider {
  readonly name = "pollinations_text";
  readonly displayName = "Pollinations (Text)";
  readonly defaultUrl = "https://text.pollinations.ai/openai";

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
    apiKeyRequired: false,
    modelListStyle: "openai",
    toolCalling: false,
    requiredToolChoice: false,
    nativeToolContinuation: false,
    toolContinuationMode: "unsupported",
    toolsDisabledFinalization: false,
    supportsToolFinalization: false,
  };
  private parseUsage(
    rawUsage: unknown,
    request: GenerationRequest,
  ): GenerationUsage {
    const configuredMaxTokens = request.parameters?.max_tokens;
    const allowance =
      typeof configuredMaxTokens === "number" &&
      Number.isSafeInteger(configuredMaxTokens) &&
      configuredMaxTokens >= 0
        ? configuredMaxTokens
        : Number.MAX_SAFE_INTEGER;
    const validation = validateProviderUsage(rawUsage, allowance);
    if (!validation.valid) {
      throw new ProviderProtocolError("Pollinations usage is malformed");
    }
    const usage = rawUsage as Record<string, unknown>;
    return {
      prompt_tokens: usage.prompt_tokens as number,
      completion_tokens: usage.completion_tokens as number,
      total_tokens: usage.total_tokens as number,
    };
  }

  private parseFinishReason(
    rawFinishReason: unknown,
    allowNull: boolean,
  ): string | undefined {
    if (rawFinishReason === undefined || (allowNull && rawFinishReason === null)) {
      return undefined;
    }
    if (
      typeof rawFinishReason !== "string" ||
      rawFinishReason.length === 0 ||
      POLLINATIONS_FINISH_REASONS[rawFinishReason] !== true
    ) {

      throw new ProviderProtocolError("Pollinations finish_reason is unsupported");
    }
    return rawFinishReason;
  }
  private reserveReasoningBytes(currentBytes: number, fragment: string): number {
    const nextBytes = currentBytes + Buffer.byteLength(fragment, "utf8");
    if (!Number.isSafeInteger(nextBytes) || nextBytes > AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES) {
      throw new ProviderResponseTooLargeError(
        "Pollinations reasoning exceeded its bounded carrier",
        AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES,
        nextBytes,
      );
    }
    return nextBytes;
  }

  /** Pollinations has no tool-calling wire; suppress all tool controls. */
  protected buildBody(request: GenerationRequest, stream: boolean): any {
    if (request.toolMode === "required") throw new Error("Pollinations Text cannot require a host tool");
    const body = super.buildBody({ ...request, tools: undefined, toolMode: undefined }, stream);
    for (const key of ["tools", "tool_choice", "parallel_tool_calls", "functions", "function_call"]) {
      delete body[key];
    }
    return body;
  }

  async validateKey(_apiKey: string, _apiUrl: string): Promise<boolean> {
    return true;
  }

  async generate(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest
  ): Promise<GenerationResponse> {
    const url = `${this.baseUrl(apiUrl)}/chat/completions`;
    const body = this.buildBody(request, false);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetchWithPreflightAbort(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, request.signal);
    if (!res.ok) {
      await throwProviderResponseError(
        this.displayName,
        "generate",
        res,
        request.signal,
        request.receiveLimitBytes,
      );
    }

    const data = (await readJsonWithAbort<unknown>(
      res,
      request.signal,
      request.receiveLimitBytes,
    )) as Record<string, unknown>;
    if (!data || typeof data !== "object" || !Array.isArray(data.choices) || !data.choices[0]) {
      throw new ProviderProtocolError("Pollinations response did not contain a choice");
    }
    const choice = data.choices[0] as Record<string, unknown>;
    if (!choice || typeof choice !== "object" || !choice.message || typeof choice.message !== "object") {
      throw new ProviderProtocolError("Pollinations response choice did not contain a message");
    }
    const message = choice.message as Record<string, unknown>;
    if (message.tool_calls !== undefined) {
      throw new ProviderProtocolError("Pollinations returned unsupported tool calls");
    }
    if (message.content !== undefined && typeof message.content !== "string") {
      throw new ProviderProtocolError("Pollinations response content must be a string");
    }
    const rawReasoning =
      message.reasoning !== undefined
        ? message.reasoning
        : message.reasoning_content;
    if (rawReasoning !== undefined && typeof rawReasoning !== "string") {
      throw new ProviderProtocolError("Pollinations reasoning must be a string");
    }
    if (rawReasoning !== undefined) this.reserveReasoningBytes(0, rawReasoning);
    const finishReason =
      choice.finish_reason === undefined
        ? undefined
        : this.parseFinishReason(choice.finish_reason, false);
    const normalized = this.splitMirroredReasoning(message.content, rawReasoning);
    const usage =
      data.usage === undefined
        ? undefined
        : this.parseUsage(data.usage, request);

    return {
      content: normalized.content,
      reasoning: normalized.reasoning,
      finish_reason: finishReason || "stop",
      usage,
    };
  }

  async *generateStream(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const url = `${this.baseUrl(apiUrl)}/chat/completions`;
    const body = this.buildBody(request, true);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetchWithPreflightAbort(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, request.signal);
    if (!res.ok) {
      await throwProviderResponseError(
        this.displayName,
        "stream",
        res,
        request.signal,
        request.receiveLimitBytes,
      );
    }

    const sse = createBoundedSseReader(res, request.signal, {
      terminalMarker: "[DONE]",
      maxResponseBytes: request.receiveLimitBytes,
    });
    let reasoningKey: "reasoning" | "reasoning_content" | null = null;
    let reasoningBytes = 0;
    let eventCount = 0;
    let sawFinishReason = false;

    for await (const event of sse) {
      eventCount += 1;
      if (eventCount % 64 === 0) await yieldToEventLoop(request.signal);
      if (event.data === "[DONE]") {
        if (!sawFinishReason) {
          throw new ProviderProtocolError(
            "Pollinations stream ended without finish_reason",
          );
        }
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch (error) {
        throw new ProviderProtocolError("Malformed Pollinations SSE JSON", {
          cause: error,
        });
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new ProviderProtocolError("Pollinations SSE payload is malformed");
      }
      if (event.event !== undefined && event.event !== "message") {
        throw new ProviderProtocolError("Pollinations SSE event name is unsupported");
      }
      const payload = parsed as Record<string, unknown>;
      if (payload.choices !== undefined && !Array.isArray(payload.choices)) {
        throw new ProviderProtocolError("Pollinations SSE choices are malformed");
      }
      const usage =
        payload.usage === undefined
          ? undefined
          : this.parseUsage(payload.usage, request);
      const choiceValue = Array.isArray(payload.choices)
        ? payload.choices[0]
        : undefined;
      if (choiceValue === undefined) {
        if (usage === undefined) {
          throw new ProviderProtocolError(
            "Pollinations SSE event did not contain choices",
          );
        }
        yield { token: "", usage };
        continue;
      }
      if (sawFinishReason) {
        throw new ProviderProtocolError(
          "Pollinations stream emitted data after its terminal finish event",
        );
      }
      if (
        choiceValue === null ||
        typeof choiceValue !== "object" ||
        Array.isArray(choiceValue)
      ) {
        throw new ProviderProtocolError("Pollinations SSE choice is missing");
      }
      const choice = choiceValue as Record<string, unknown>;
      const finishReason = this.parseFinishReason(
        choice.finish_reason,
        true,
      );
      const delta = choice.delta;
      if (delta === undefined && !finishReason) {
        throw new ProviderProtocolError("Pollinations SSE delta is malformed");
      }
      if (
        delta !== undefined &&
        (delta === null || typeof delta !== "object" || Array.isArray(delta))
      ) {
        throw new ProviderProtocolError("Pollinations SSE delta is malformed");
      }
      const deltaRecord =
        delta === undefined
          ? {}
          : delta as Record<string, unknown>;
      if (
        deltaRecord.tool_calls !== undefined ||
        deltaRecord.function_call !== undefined
      ) {
        throw new ProviderProtocolError("Pollinations returned unsupported tool calls");
      }
      let reasoning: string | undefined;
      if (reasoningKey) {
        reasoning = deltaRecord[reasoningKey] as string | undefined;
      } else if (deltaRecord.reasoning !== undefined) {
        if (typeof deltaRecord.reasoning !== "string") {
          throw new ProviderProtocolError(
            "Pollinations reasoning delta must be a string",
          );
        }
        reasoningKey = "reasoning";
        reasoning = deltaRecord.reasoning;
      } else if (deltaRecord.reasoning_content !== undefined) {
        if (typeof deltaRecord.reasoning_content !== "string") {
          throw new ProviderProtocolError(
            "Pollinations reasoning delta must be a string",
          );
        }
        reasoningKey = "reasoning_content";
        reasoning = deltaRecord.reasoning_content;
      }
      if (reasoning !== undefined && typeof reasoning !== "string") {
        throw new ProviderProtocolError(
          "Pollinations reasoning delta must be a string",
        );
      }
      if (reasoning !== undefined) {
        reasoningBytes = this.reserveReasoningBytes(reasoningBytes, reasoning);
      }
      if (
        deltaRecord.content !== undefined &&
        typeof deltaRecord.content !== "string"
      ) {
        throw new ProviderProtocolError(
          "Pollinations content delta must be a string",
        );
      }
      const normalized = this.splitMirroredReasoning(
        deltaRecord.content,
        reasoning,
      );
      if (finishReason) {
        sawFinishReason = true;
        yield {
          token: normalized.content || "",
          reasoning: normalized.reasoning,
          finish_reason: finishReason,
          usage,
        };
      } else if (normalized.reasoning || normalized.content) {
        yield {
          token: normalized.content || "",
          reasoning: normalized.reasoning,
          usage,
        };
      } else if (usage) {
        yield { token: "", usage };
      }
    }
  }
}
