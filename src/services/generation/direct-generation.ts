import { getProvider } from "../../llm/registry";
import type { GenerationCallOptions } from "../../llm/request-observer";
import { createRequestObserver } from "../request-history.service";
import type { LlmProvider } from "../../llm/provider";
import type {
  GenerationParameters,
  GenerationRequest,
  GenerationResponse,
  LlmMessage,
  StreamChunk,
  ToolDefinition,
} from "../../llm/types";
import type { ConnectionProfile } from "../../types/connection-profile";
import type { GenerationReasoningOverrideDTO } from "lumiverse-spindle-types";
import { applyPromptCaching } from "../caching";
import {
  withInferenceLease,
  withInferenceLeaseStream,
  withLeaseAbort,
  type InferenceLeaseOptions,
  type InferenceRequestClass,
} from "../inference-scheduler";
import * as presetsSvc from "../presets.service";
import { injectConnectionMetadataFlags } from "./connection-metadata";
import { resolveGoogleMediaResolution } from "../../llm/providers/google-media";
import {
  resolveConnection,
  resolveProviderAndKey,
} from "./connection-resolution";
import {
  applyDelimitedReasoningParsing,
  applyEffectiveReasoningSettings,
  wrapDelimitedReasoningForUser,
} from "./reasoning";

export interface RawGenerateInput {
  onProviderChunk?: (chunk: StreamChunk) => void;
  onInferenceWait?: (waiting: boolean) => void;
  provider: string;
  model: string;
  messages: LlmMessage[];
  parameters?: GenerationParameters;
  api_url?: string;
  /** Resolve the credential from a connection instead of using an inline key. */
  connection_id?: string;
  /** Use this key directly for extension-owned requests. */
  api_key?: string;
  /** Tool/function definitions for inline function calling. */
  tools?: ToolDefinition[];
  /** Per-request reasoning settings, or the inherited connection/global settings. */
  reasoning?: GenerationReasoningOverrideDTO;
}

export interface QuietGenerateInput {
  /** Consume a provider stream while returning the complete validated result. */
  stream?: boolean;
  onStreamActivity?: (phase: "waiting" | "thinking" | "responding") => void;
  messages: LlmMessage[];
  connection_id?: string;
  parameters?: GenerationParameters;
  /** Tool/function definitions for inline function calling. */
  tools?: ToolDefinition[];
  /** Cancels the in-flight provider request when aborted. */
  signal?: AbortSignal;
  /** Reserved caller context; quiet generation does not currently use it. */
  chat_id?: string;
  /** Per-request reasoning settings, or the inherited connection/global settings. */
  reasoning?: GenerationReasoningOverrideDTO;
}

interface PreparedGenerationCall {
  provider: LlmProvider;
  apiKey: string;
  apiUrl: string;
  request: GenerationRequest;
}

async function resolveRawProviderAndKey(
  userId: string,
  input: RawGenerateInput,
): Promise<{
  provider: LlmProvider;
  apiKey: string;
  apiUrl: string;
  connection: ConnectionProfile | null;
}> {
  if (input.connection_id) {
    return resolveProviderAndKey(userId, input.connection_id);
  }

  const provider = getProvider(input.provider);
  if (!provider) throw new Error(`Unknown provider: ${input.provider}`);
  if (input.api_key) {
    return {
      provider,
      apiKey: input.api_key,
      apiUrl: input.api_url || "",
      connection: null,
    };
  }
  if (provider.capabilities.apiKeyRequired) {
    throw new Error("No API key provided. Pass api_key or connection_id in the request.");
  }
  return {
    provider,
    apiKey: "",
    apiUrl: input.api_url || "",
    connection: null,
  };
}

async function consumeStream(
  stream: AsyncGenerator<StreamChunk, void, unknown>,
  userId?: string,
  onActivity?: QuietGenerateInput["onStreamActivity"],
): Promise<GenerationResponse> {
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let stopDetails: GenerationResponse["stop_details"];
  let stopSequence: string | null | undefined;
  let toolCalls: GenerationResponse["tool_calls"];
  // Signed reasoning must go back with the tool calls it preceded, so keep it
  // for callers that continue the turn.
  let thinkingBlocks: GenerationResponse["thinking_blocks"];
  let reasoningDetails: GenerationResponse["reasoning_details"];
  let usage: GenerationResponse["usage"];
  const source = userId
    ? wrapDelimitedReasoningForUser(userId, stream)
    : stream;
  for await (const chunk of source) {
    if (chunk.reasoning) onActivity?.("thinking");
    if (chunk.token || chunk.tool_calls?.length) onActivity?.("responding");
    if (chunk.token) content += chunk.token;
    if (chunk.reasoning) reasoning += chunk.reasoning;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.finish_reason) finishReason = chunk.finish_reason;
    if (chunk.stop_details !== undefined) stopDetails = chunk.stop_details;
    if (chunk.stop_sequence !== undefined) stopSequence = chunk.stop_sequence;
    if (chunk.tool_calls) toolCalls = chunk.tool_calls;
    if (chunk.thinking_blocks) thinkingBlocks = chunk.thinking_blocks;
    if (chunk.reasoning_details) reasoningDetails = chunk.reasoning_details;
  }
  return {
    content,
    reasoning: reasoning || undefined,
    finish_reason: finishReason,
    stop_details: stopDetails,
    stop_sequence: stopSequence,
    tool_calls: toolCalls,
    thinking_blocks: thinkingBlocks,
    reasoning_details: reasoningDetails,
    usage,
  };
}

async function prepareRawCall(
  userId: string,
  input: RawGenerateInput & { signal?: AbortSignal },
  options?: GenerationCallOptions,
): Promise<PreparedGenerationCall> {
  const { provider, apiKey, apiUrl, connection } =
    await resolveRawProviderAndKey(userId, input);
  const parameters: GenerationParameters = { ...(input.parameters || {}) };
  if (provider.name === "google" || provider.name === "google_vertex") {
    const explicitMediaResolution = resolveGoogleMediaResolution(parameters);
    if (explicitMediaResolution !== undefined) parameters.media_resolution = explicitMediaResolution;
  }
  applyEffectiveReasoningSettings(
    userId,
    connection || {},
    provider.name,
    input.model,
    parameters,
    input.reasoning,
    true,
  );
  // Raw calls keep their explicit parameters, but can inherit the selected
  // connection's media detail without importing unrelated sampling settings.
  if ((provider.name === "google" || provider.name === "google_vertex")
    && connection?.preset_id && resolveGoogleMediaResolution(parameters) === undefined) {
    const preset = await presetsSvc.getPresetAsync(userId, connection.preset_id);
    const mediaResolution = resolveGoogleMediaResolution(preset?.parameters ?? {});
    if (mediaResolution !== undefined) parameters.media_resolution = mediaResolution;
  }
  if (connection) injectConnectionMetadataFlags(connection, parameters);
  const cached = applyPromptCaching(
    {
      provider: provider.name,
      model: input.model,
      metadata: connection?.metadata,
    },
    { params: parameters, messages: input.messages, tools: input.tools },
  );
  return {
    provider,
    apiKey,
    apiUrl,
    request: {
      onProviderRequest: createRequestObserver(userId, options?.origin ?? { kind: "api", name: "Local API", operation: "raw" }, {
        connectionId: connection?.id, chatId: options?.chatId, generationId: options?.generationId,
      }, [apiKey]),
      messages: cached.messages,
      model: input.model,
      parameters: cached.params,
      tools: cached.tools,
      signal: input.signal,
    },
  };
}

async function prepareQuietCall(
  userId: string,
  input: QuietGenerateInput,
  options?: GenerationCallOptions,
): Promise<PreparedGenerationCall> {
  const connection = resolveConnection(userId, input.connection_id);
  const { provider, apiKey, apiUrl } = await resolveProviderAndKey(
    userId,
    connection.id,
  );
  let mergedParams: GenerationParameters = input.parameters || {};
  if (connection.preset_id) {
    const preset = await presetsSvc.getPresetAsync(userId, connection.preset_id);
    if (preset) mergedParams = { ...preset.parameters, ...mergedParams };
  }
  applyEffectiveReasoningSettings(
    userId,
    connection,
    provider.name,
    connection.model || undefined,
    mergedParams,
    input.reasoning,
    true,
  );
  const paramModel = typeof (mergedParams as any).model === "string"
    ? (mergedParams as any).model.trim()
    : "";
  if ("model" in mergedParams) delete (mergedParams as any).model;
  injectConnectionMetadataFlags(connection, mergedParams);
  const resolvedModel = paramModel || connection.model;
  const cached = applyPromptCaching(
    {
      provider: provider.name,
      model: resolvedModel,
      metadata: connection.metadata,
    },
    { params: mergedParams, messages: input.messages, tools: input.tools },
  );
  return {
    provider,
    apiKey,
    apiUrl,
    request: {
      onProviderRequest: createRequestObserver(userId, options?.origin ?? { kind: "api", name: "Local API", operation: "quiet" }, {
        connectionId: connection.id, chatId: options?.chatId ?? input.chat_id, generationId: options?.generationId,
      }, [apiKey]),
      messages: cached.messages,
      model: resolvedModel,
      parameters: cached.params,
      tools: cached.tools,
      signal: input.signal,
    },
  };
}

export async function rawGenerate(
  userId: string,
  input: RawGenerateInput & { signal?: AbortSignal },
  options?: GenerationCallOptions,
): Promise<GenerationResponse> {
  const { provider, apiKey, apiUrl, request } = await prepareRawCall(
    userId,
    input,
    options,
  );
  return withInferenceLease(
    leaseOptionsFor(userId, apiUrl, input.signal, options, "user", "raw-generate"),
    async (lease) => {
      const signal = withLeaseAbort(request.signal, lease);
      if (input.tools && input.tools.length > 0) {
        const result = await consumeStream(
          provider.generateStream(apiKey, apiUrl, { ...request, signal, stream: true }),
          userId,
        );
        throwIfGenerationAborted(signal);
        return result;
      }
      const result = await provider.generate(apiKey, apiUrl, { ...request, signal, stream: false });
      throwIfGenerationAborted(signal);
      return applyDelimitedReasoningParsing(userId, result);
    },
  );
}

export async function quietGenerate(
  userId: string,
  input: QuietGenerateInput,
  options?: GenerationCallOptions,
): Promise<GenerationResponse> {
  const { provider, apiKey, apiUrl, request } = await prepareQuietCall(
    userId,
    input,
    options,
  );
  return withInferenceLease(
    leaseOptionsFor(userId, apiUrl, input.signal, options, "background", "quiet-generate"),
    async (lease) => {
      const signal = withLeaseAbort(request.signal, lease);
      if (input.stream || (request.tools && request.tools.length > 0)) {
        const result = await consumeStream(
          provider.generateStream(apiKey, apiUrl, { ...request, signal, stream: true,
            onProviderRequest: input.onStreamActivity ? (snapshot) => {
              input.onStreamActivity!("waiting");
              return request.onProviderRequest?.(snapshot);
            } : request.onProviderRequest,
            onResponseActivity: () => input.onStreamActivity?.("responding") }),
          userId,
          input.onStreamActivity,
        );
        throwIfGenerationAborted(signal);
        return result;
      }
      const result = await provider.generate(apiKey, apiUrl, { ...request, signal, stream: false });
      throwIfGenerationAborted(signal);
      return applyDelimitedReasoningParsing(userId, result);
    },
  );
}

/**
 * Stream a raw generation with the caller's abort signal wired into the
 * provider request.
 */
export async function rawGenerateStream(
  userId: string,
  input: RawGenerateInput & { signal?: AbortSignal },
  options?: GenerationCallOptions,
): Promise<AsyncGenerator<StreamChunk, void, unknown>> {
  const { provider, apiKey, apiUrl, request } = await prepareRawCall(userId, input, options);
  const stream = withInferenceLeaseStream(
    leaseOptionsFor(userId, apiUrl, input.signal, options, "user", "raw-generate-stream"),
    (lease) => {
      input.onInferenceWait?.(false);
      const source = provider.generateStream(apiKey, apiUrl, { ...request, signal: withLeaseAbort(request.signal, lease), stream: true });
      if (!input.onProviderChunk) return source;
      return (async function* () { for await (const chunk of source) { input.onProviderChunk!(chunk); yield chunk; } })();
    },
  );
  if (!input.onInferenceWait) return wrapDelimitedReasoningForUser(userId, stream);
  return (async function* () {
    input.onInferenceWait!(true);
    try { yield* wrapDelimitedReasoningForUser(userId, stream); }
    finally { input.onInferenceWait!(false); }
  })();
}

/**
 * Stream a quiet generation after resolving its connection, preset,
 * reasoning settings, and provider metadata.
 */
export async function quietGenerateStream(
  userId: string,
  input: QuietGenerateInput,
  options?: GenerationCallOptions,
): Promise<AsyncGenerator<StreamChunk, void, unknown>> {
  const { provider, apiKey, apiUrl, request } = await prepareQuietCall(userId, input, options);
  return wrapDelimitedReasoningForUser(
    userId,
    withInferenceLeaseStream(
      leaseOptionsFor(userId, apiUrl, input.signal, options, "background", "quiet-generate-stream"),
      (lease) => provider.generateStream(apiKey, apiUrl, {
        ...request,
        signal: withLeaseAbort(request.signal, lease),
        stream: true,
      }),
    ),
  );
}

function leaseOptionsFor(
  userId: string,
  apiUrl: string,
  signal: AbortSignal | undefined,
  options: GenerationCallOptions | undefined,
  fallbackClass: InferenceRequestClass,
  fallbackPurpose: string,
): InferenceLeaseOptions {
  return {
    userId,
    endpoint: apiUrl,
    requestClass: options?.leaseClass ?? fallbackClass,
    purpose: options?.leasePurpose ?? options?.origin?.name ?? fallbackPurpose,
    signal,
  };
}

/**
 * A provider stream can end normally after an abort (notably OpenAI-compatible
 * transports). Treat the lease/caller abort as authoritative so partial output
 * is never returned or persisted as a successful completion.
 */
function throwIfGenerationAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
