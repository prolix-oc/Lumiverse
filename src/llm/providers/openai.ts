import {
  OpenAICompatibleProvider,
  jsonStringBytes,
  jsonStringBytesWithAppend,
  parseOpenAIResponsesUsage,
} from "./openai-compatible";
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
import type {
  GenerationRequest,
  GenerationResponse,
  StreamChunk,
  ToolCallResult,
  LlmMessage,
  LlmMessagePart,
  ProviderTransientCarrier,
  ResponsesFunctionCallOutput,
  ResponsesFunctionCallOutputItem,
  ResponsesInputMessageItem,
  ResponsesMessageOutputItem,
  ResponsesOutputItem,
  ResponsesOutputTextPart,
  ResponsesReasoningOutputItem,
  ResponsesReasoningSummaryPart,
} from "../types";
import { getTextContent } from "../types";
import { parseModelToolArguments } from "../tool-arguments";
import { throwProviderResponseError } from "../../utils/provider-errors";
import { splitLeadingSystemMessagePrefix } from "../system-message-prefix";

const RESPONSES_MAX_OUTPUT_ITEMS = 256;
const RESPONSES_MAX_CARRIER_BYTES = 256 * 1024;
const RESPONSES_ID_MAX_BYTES = 256;

type ResponsesRecord = Record<string, unknown>;

function asResponsesRecord(value: unknown, message: string): ResponsesRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderProtocolError(message);
  }
  return value as ResponsesRecord;
}
function optionalStatus(record: ResponsesRecord): string | undefined {
  if (record.status === undefined) return undefined;
  if (typeof record.status !== "string") {
    throw new ProviderProtocolError("OpenAI Responses output item status is malformed");
  }
  const bytes = Buffer.byteLength(record.status, "utf8");
  if (bytes > RESPONSES_ID_MAX_BYTES) {
    throw new ProviderResponseTooLargeError(
      "OpenAI Responses output item status exceeded its bounded length",
      RESPONSES_ID_MAX_BYTES,
      bytes,
    );
  }
  return record.status;
}

function requiredBoundedString(
  record: ResponsesRecord,
  key: string,
  message: string,
  maxBytes = RESPONSES_ID_MAX_BYTES,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderProtocolError(message);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) {
    throw new ProviderResponseTooLargeError(`${message} exceeded its bounded length`, maxBytes, bytes);
  }

  return value;
}
function optionalOutputTextMetadata(
  record: ResponsesRecord,
  key: "annotations" | "logprobs",
  message: string,
): ResponsesOutputTextPart["annotations"] | ResponsesOutputTextPart["logprobs"] {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new ProviderProtocolError(message);
  }
  const metadata: Readonly<Record<string, unknown>>[] = [];
  let bytes = 2;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ProviderProtocolError(message);
    }
    const entryBytes = jsonBytes(entry, message);
    const nextBytes = bytes + (metadata.length > 0 ? 1 : 0) + entryBytes;
    if (nextBytes > RESPONSES_MAX_CARRIER_BYTES) {
      throw new ProviderResponseTooLargeError(
        `${message} exceeded its bounded length`,
        RESPONSES_MAX_CARRIER_BYTES,
        nextBytes,
      );
    }
    metadata.push(entry as Readonly<Record<string, unknown>>);
    bytes = nextBytes;
  }
  return metadata;
}

function jsonBytes(value: unknown, label: string): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new ProviderProtocolError(`${label} is not serializable`, { cause: error });
  }
  if (serialized === undefined) throw new ProviderProtocolError(`${label} is malformed`);
  return Buffer.byteLength(serialized, "utf8");
}

function normalizeResponsesMessageItem(record: ResponsesRecord): ResponsesMessageOutputItem {
  const id = requiredBoundedString(record, "id", "OpenAI Responses message is missing item id");
  if (record.role !== "assistant") {
    throw new ProviderProtocolError("OpenAI Responses message item must have assistant role");
  }
  if (!Array.isArray(record.content)) {
    throw new ProviderProtocolError("OpenAI Responses message content is malformed");
  }
  const status = optionalStatus(record);
  const content: ResponsesMessageOutputItem["content"][number][] = [];
  const base: ResponsesMessageOutputItem = {
    type: "message",
    id,
    role: "assistant",
    ...(status !== undefined ? { status } : {}),
    content: [],
  };
  let itemBytes = jsonBytes(base, "OpenAI Responses message");
  for (const rawPart of record.content) {
    const part = asResponsesRecord(rawPart, "OpenAI Responses message content part is malformed");
    let normalizedPart: ResponsesMessageOutputItem["content"][number];
    if (part.type === "output_text") {
      const annotations = optionalOutputTextMetadata(
        part,
        "annotations",
        "OpenAI Responses output text annotations are malformed",
      );
      const logprobs = optionalOutputTextMetadata(
        part,
        "logprobs",
        "OpenAI Responses output text logprobs are malformed",
      );
      normalizedPart = {
        type: "output_text",
        text: requiredBoundedString(
          part,
          "text",
          "OpenAI Responses output text is malformed",
          RESPONSES_MAX_CARRIER_BYTES,
        ),
        ...(annotations !== undefined ? { annotations } : {}),
        ...(logprobs !== undefined ? { logprobs } : {}),
      };
    } else if (part.type === "refusal") {
      normalizedPart = {
        type: "refusal",
        refusal: requiredBoundedString(
          part,
          "refusal",
          "OpenAI Responses refusal content is malformed",
          RESPONSES_MAX_CARRIER_BYTES,
        ),
      };
    } else {
      throw new ProviderProtocolError("OpenAI Responses message content part type is unsupported");
    }
    const partBytes = jsonBytes(normalizedPart, "OpenAI Responses message content");
    const nextItemBytes = itemBytes + partBytes + (content.length > 0 ? 1 : 0);
    if (nextItemBytes > RESPONSES_MAX_CARRIER_BYTES) {
      throw new ProviderResponseTooLargeError(
        "OpenAI Responses message carrier exceeded its bounded length",
        RESPONSES_MAX_CARRIER_BYTES,
        nextItemBytes,
      );
    }
    content.push(normalizedPart);
    itemBytes = nextItemBytes;
  }
  return {
    ...base,
    content,
  };
}

function normalizeResponsesReasoningItem(record: ResponsesRecord): ResponsesReasoningOutputItem {
  const id = requiredBoundedString(record, "id", "OpenAI Responses reasoning item is missing item id");
  const status = optionalStatus(record);
  let encryptedContent: string | undefined;
  if (record.encrypted_content !== undefined && record.encrypted_content !== null) {
    if (typeof record.encrypted_content !== "string") {
      throw new ProviderProtocolError("OpenAI Responses encrypted reasoning carrier is malformed");
    }
    const bytes = Buffer.byteLength(record.encrypted_content, "utf8");
    if (bytes > RESPONSES_MAX_CARRIER_BYTES) {
      throw new ProviderResponseTooLargeError(
        "OpenAI Responses encrypted reasoning carrier exceeded its bounded length",
        RESPONSES_MAX_CARRIER_BYTES,
        bytes,
      );
    }
    encryptedContent = record.encrypted_content;
  }
  if (record.summary !== undefined && !Array.isArray(record.summary)) {
    throw new ProviderProtocolError("OpenAI Responses reasoning summary is malformed");
  }
  const summary: ResponsesReasoningSummaryPart[] = [];
  const base: ResponsesReasoningOutputItem = {
    type: "reasoning",
    id,
    ...(status !== undefined ? { status } : {}),
    summary: [],
    ...(encryptedContent !== undefined ? { encrypted_content: encryptedContent } : {}),
  };
  let itemBytes = jsonBytes(base, "OpenAI Responses reasoning");
  for (const rawSummary of (record.summary ?? [])) {
    const part = asResponsesRecord(rawSummary, "OpenAI Responses reasoning summary part is malformed");
    if (part.type !== "summary_text") {
      throw new ProviderProtocolError("OpenAI Responses reasoning summary type is unsupported");
    }
    const normalizedPart: ResponsesReasoningSummaryPart = {
      type: "summary_text",
      text: requiredBoundedString(
        part,
        "text",
        "OpenAI Responses reasoning summary is malformed",
        RESPONSES_MAX_CARRIER_BYTES,
      ),
    };
    const partBytes = jsonBytes(normalizedPart, "OpenAI Responses reasoning summary");
    const nextItemBytes = itemBytes + partBytes + (summary.length > 0 ? 1 : 0);
    if (nextItemBytes > RESPONSES_MAX_CARRIER_BYTES) {
      throw new ProviderResponseTooLargeError(
        "OpenAI Responses reasoning carrier exceeded its bounded length",
        RESPONSES_MAX_CARRIER_BYTES,
        nextItemBytes,
      );
    }
    summary.push(normalizedPart);
    itemBytes = nextItemBytes;
  }
  return {
    ...base,
    summary,
  };
}

function normalizeResponsesFunctionItem(record: ResponsesRecord): ResponsesFunctionCallOutputItem {
  const id = requiredBoundedString(record, "id", "OpenAI Responses function call is missing item id");
  const callId = requiredBoundedString(record, "call_id", "OpenAI Responses function call is missing native call_id");
  const name = requiredBoundedString(record, "name", "OpenAI Responses function call is missing name");
  const args = requiredBoundedString(
    record,
    "arguments",
    "OpenAI Responses function call arguments are incomplete",
    PROVIDER_STREAM_LIMITS.maxArgumentsBytes,
  );
  const status = optionalStatus(record);
  return {
    type: "function_call",
    id,
    call_id: callId,
    name,
    arguments: args,
    ...(status !== undefined ? { status } : {}),
  };
}

function normalizeResponsesOutputItem(value: unknown): ResponsesOutputItem {
  const record = asResponsesRecord(value, "OpenAI Responses output item is malformed");
  switch (record.type) {
    case "message":
      return normalizeResponsesMessageItem(record);
    case "reasoning":
      return normalizeResponsesReasoningItem(record);
    case "function_call":
      return normalizeResponsesFunctionItem(record);
    default:
      throw new ProviderProtocolError("OpenAI Responses output item type is unsupported");
  }
}

type ResponsesCarrierItem =
  | ResponsesOutputItem
  | ResponsesFunctionCallOutput
  | ResponsesInputMessageItem;

function normalizeResponsesFunctionOutput(value: unknown): ResponsesFunctionCallOutput {
  const record = asResponsesRecord(value, "OpenAI Responses function output is malformed");
  if (record.type !== "function_call_output") {
    throw new ProviderProtocolError("OpenAI Responses function output is malformed");
  }
  const callId = requiredBoundedString(
    record,
    "call_id",
    "OpenAI Responses function output is missing call_id",
  );
  if (typeof record.output !== "string") {
    throw new ProviderProtocolError("OpenAI Responses function output is malformed");
  }
  const outputBytes = Buffer.byteLength(record.output, "utf8");
  if (outputBytes > RESPONSES_MAX_CARRIER_BYTES) {
    throw new ProviderResponseTooLargeError(
      "OpenAI Responses function output exceeded its bounded length",
      RESPONSES_MAX_CARRIER_BYTES,
      outputBytes,
    );
  }
  return {
    type: "function_call_output",
    call_id: callId,
    output: record.output,
  };
}

function normalizeResponsesInputMessageItem(value: unknown): ResponsesInputMessageItem {
  const record = asResponsesRecord(value, "OpenAI Responses input message is malformed");
  if (
    record.type !== "message" ||
    (record.role !== "user" && record.role !== "assistant" && record.role !== "system") ||
    typeof record.content !== "string"
  ) {
    throw new ProviderProtocolError("OpenAI Responses input message is malformed");
  }
  const contentBytes = Buffer.byteLength(record.content, "utf8");
  if (contentBytes > RESPONSES_MAX_CARRIER_BYTES) {
    throw new ProviderResponseTooLargeError(
      "OpenAI Responses input message exceeded its bounded length",
      RESPONSES_MAX_CARRIER_BYTES,
      contentBytes,
    );
  }
  return {
    type: "message",
    role: record.role,
    content: record.content,
  };
}

function normalizeResponsesCarrierItem(value: unknown): ResponsesCarrierItem {
  const record = asResponsesRecord(value, "OpenAI Responses continuation item is malformed");
  if (record.type === "function_call_output") return normalizeResponsesFunctionOutput(record);
  if (record.type === "message" && typeof record.content === "string" && !Object.hasOwn(record, "id")) {
    return normalizeResponsesInputMessageItem(record);
  }
  return normalizeResponsesOutputItem(record);
}

function assertResponsesCarrierBounds(items: readonly ResponsesCarrierItem[]): void {
  if (items.length > RESPONSES_MAX_OUTPUT_ITEMS) {
    throw new ProviderResponseTooLargeError(
      "OpenAI Responses output item count exceeded its bounded carrier",
      RESPONSES_MAX_OUTPUT_ITEMS,
      items.length,
    );
  }
  let functionOutputCount = 0;
  for (const item of items) {
    if (item.type === "function_call_output") {
      functionOutputCount += 1;
      if (functionOutputCount > PROVIDER_STREAM_LIMITS.maxCalls) {
        throw new ProviderResponseTooLargeError(
          `OpenAI Responses function output count exceeded ${PROVIDER_STREAM_LIMITS.maxCalls}`,
          PROVIDER_STREAM_LIMITS.maxCalls,
          functionOutputCount,
        );
      }
      normalizeResponsesFunctionOutput(item);
    } else {
      normalizeResponsesCarrierItem(item);
    }
  }
  const bytes = jsonBytes(items, "OpenAI Responses continuation carrier");
  if (bytes > RESPONSES_MAX_CARRIER_BYTES) {
    throw new ProviderResponseTooLargeError(
      "OpenAI Responses continuation carrier exceeded its bounded length",
      RESPONSES_MAX_CARRIER_BYTES,
      bytes,
    );
  }
}

function reserveResponsesOutputItem(
  currentBytes: number,
  itemCount: number,
  item: ResponsesCarrierItem,
): { itemBytes: number; nextBytes: number } {
  const itemBytes = jsonBytes(item, "OpenAI Responses output item");
  const nextBytes = itemCount === 0
    ? 2 + itemBytes
    : currentBytes + 1 + itemBytes;
  if (nextBytes > RESPONSES_MAX_CARRIER_BYTES) {
    throw new ProviderResponseTooLargeError(
      "OpenAI Responses continuation carrier exceeded its bounded length",
      RESPONSES_MAX_CARRIER_BYTES,
      nextBytes,
    );
  }
  return { itemBytes, nextBytes };
}

function validateResponsesCarrier(carrier: ProviderTransientCarrier): void {
  if (!carrier || carrier.kind !== "openai_responses" || !Array.isArray(carrier.items)) {
    throw new ProviderProtocolError("OpenAI Responses continuation carrier is malformed");
  }
  if (carrier.items.length > RESPONSES_MAX_OUTPUT_ITEMS) {
    throw new ProviderResponseTooLargeError(
      "OpenAI Responses output item count exceeded its bounded carrier",
      RESPONSES_MAX_OUTPUT_ITEMS,
      carrier.items.length,
    );
  }
  const normalizedItems = carrier.items.map((item) => normalizeResponsesCarrierItem(item));
  // Check both the normalized schema and the original object so an injected
  // unknown field cannot bypass the continuation cap while preserving native
  // provider fields on the actual carrier sent back upstream.
  assertResponsesCarrierBounds(normalizedItems);
  const rawBytes = jsonBytes(carrier.items, "OpenAI Responses continuation carrier");
  if (rawBytes > RESPONSES_MAX_CARRIER_BYTES) {
    throw new ProviderResponseTooLargeError(
      "OpenAI Responses continuation carrier exceeded its bounded length",
      RESPONSES_MAX_CARRIER_BYTES,
      rawBytes,
    );
  }
}

function textFromResponsesMessage(item: ResponsesMessageOutputItem): string {
  return item.content
    .filter((part): part is { type: "output_text"; text: string } => part.type === "output_text")
    .map((part) => part.text)
    .join("");
}

function reasoningFromResponsesItem(item: ResponsesReasoningOutputItem): string {
  return item.summary.map((part) => part.text).join("");
}

function responsesCarrierWithItems(items: readonly ResponsesCarrierItem[]): ProviderTransientCarrier {
  assertResponsesCarrierBounds(items);
  return Object.freeze({
    kind: "openai_responses",
    items: Object.freeze([...items]),
  });
}

function isStatelessResponsesRequest(request: GenerationRequest): boolean {
  // Agentic frames and their provider-owned continuation carriers must never
  // depend on OpenAI's server-side response/conversation state. Ordinary
  // Responses calls intentionally retain the caller's stateful parameters.
  return request.toolMode !== undefined || request.providerTransientCarrier !== undefined;
}

function responsesFinishReason(
  status: string,
  incompleteDetails: unknown,
  hasToolCalls: boolean,
): string {
  if (hasToolCalls) return "tool_calls";
  if (status === "completed") return "stop";
  if (incompleteDetails && typeof incompleteDetails === "object" && !Array.isArray(incompleteDetails)) {
    const reason = (incompleteDetails as ResponsesRecord).reason;
    if (typeof reason === "string" && reason.length > 0) return reason;
  }
  return status;
}


function withProviderTransientCarrier<T extends object>(
  value: T,
  carrier: ProviderTransientCarrier,
): T & { providerTransientCarrier: ProviderTransientCarrier } {
  Object.defineProperty(value, "providerTransientCarrier", {
    configurable: true,
    enumerable: false,
    value: carrier,
    writable: false,
  });
  return value as T & { providerTransientCarrier: ProviderTransientCarrier };
}

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
    toolCalling: true,
    requiredToolChoice: true,
    nativeToolContinuation: true,
    toolContinuationMode: "native",
    toolsDisabledFinalization: true,
    supportsToolFinalization: true,
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
    if (request.toolMode === "required" && !this.capabilities.requiredToolChoice) {
      throw new Error("Provider does not support required tool choice");
    }
    const params = request.parameters || {};
    // Only the leading system prefix belongs in top-level instructions.
    // Later system messages may be depth-positioned inside/after history, and
    // Responses supports compatible message items for preserving transcripts.
    const { prefix: systemMessages, remainder: inputMessages } =
      splitLeadingSystemMessagePrefix(request.messages);
    const flattenedInput = inputMessages.flatMap((m) => this.flattenForResponses(m));
    const carrier = request.providerTransientCarrier;
    let input = flattenedInput;
    if (carrier) {
      validateResponsesCarrier(carrier);
      const callIds = new Set(
        carrier.items
          .filter((item): item is Extract<ResponsesOutputItem, { type: "function_call" }> => item.type === "function_call")
          .map((item) => item.call_id),
      );
      input = flattenedInput.filter((item) => {
        if (!item || typeof item !== "object") return true;
        const record = item as Record<string, unknown>;
        return !(
          (record.type === "function_call" || record.type === "function_call_output") &&
          typeof record.call_id === "string" &&
          callIds.has(record.call_id)
        );
      });
      input.push(...carrier.items);
    }

    const body: Record<string, any> = {
      model: request.model,
      input,
    };
    if (systemMessages.length > 0) {
      body.instructions = systemMessages.map((m) => getTextContent(m)).join("\n\n");
    }

    const stateless = isStatelessResponsesRequest(request);
    if (stateless) {
      // Agentic continuations carry their own complete chronology. Do not let
      // provider/server state or caller-supplied include values alter it.
      body.store = false;
    }
    const SKIP_PARAMS: Record<string, true> = {
      use_responses_api: true,
      max_tokens: true,
      frequency_penalty: true,
      presence_penalty: true,
      stop: true,
      max_context_length: true,
      _include_usage: true,
      _streaming: true,
      ...(stateless
        ? {
            store: true,
            previous_response_id: true,
            conversation: true,
            background: true,
            include: true,
          }
        : {}),
    };
    const TOOL_CONTROL_PARAMS: Record<string, true> = {
      tools: true,
      tool_choice: true,
      parallel_tool_calls: true,
      functions: true,
      function_call: true,
    };

    if (params.max_tokens !== undefined) body.max_output_tokens = params.max_tokens;
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.top_p !== undefined) body.top_p = params.top_p;

    for (const key of Object.keys(params)) {
      if (SKIP_PARAMS[key] || body[key] !== undefined) continue;
      if (stateless && TOOL_CONTROL_PARAMS[key]) continue;
      body[key] = params[key];
    }

    const hostReasoningRequired = stateless || (request.tools?.length ?? 0) > 0;
    if (hostReasoningRequired) {
      const reasoningInclude = "reasoning.encrypted_content";
      if (stateless) {
        body.include = [reasoningInclude];
      } else if (
        Array.isArray(body.include) &&
        body.include.every((value: unknown): value is string => typeof value === "string")
      ) {
        body.include = body.include.includes(reasoningInclude)
          ? body.include
          : [...body.include, reasoningInclude];
      } else {
        body.include = [reasoningInclude];
      }
    }

    const hostTools = request.tools?.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: request.toolMode ? false : t.strict,
    }));
    if (request.toolMode === "finalization") {
      body.tools = [];
      body.tool_choice = "none";
      body.parallel_tool_calls = false;
    } else if (request.toolMode === "required") {
      if (!hostTools?.length) throw new Error("Required tool mode needs at least one admitted host tool");
      body.tools = hostTools;
      body.tool_choice = "required";
    } else if (request.toolMode === "ordinary") {
      if (hostTools?.length) {
        body.tools = hostTools;
      } else {
        body.tools = [];
        body.tool_choice = "none";
        body.parallel_tool_calls = false;
      }
    } else if (hostTools?.length) {
      body.tools = hostTools;
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

    const res = await fetchWithPreflightAbort(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
    }, request.signal);

    if (!res.ok) {
      await throwProviderResponseError(
        this.displayName,
        "responses generate",
        res,
        request.signal,
        request.receiveLimitBytes,
      );
    }

    const data = await readJsonWithAbort<ResponsesRecord>(
      res,
      request.signal,
      request.receiveLimitBytes,
    );
    const status = requiredBoundedString(
      data,
      "status",
      "OpenAI Responses status is malformed",
    );
    if (isStatelessResponsesRequest(request) && status !== "completed") {
      throw new ProviderProtocolError("OpenAI Responses response did not complete successfully");
    }

    let content = "";
    if (data.output_text !== undefined) {
      if (typeof data.output_text !== "string") {
        throw new ProviderProtocolError("OpenAI Responses output_text is malformed");
      }
      const textBytes = Buffer.byteLength(data.output_text, "utf8");
      if (textBytes > RESPONSES_MAX_CARRIER_BYTES) {
        throw new ProviderResponseTooLargeError(
          "OpenAI Responses output_text exceeded its bounded length",
          RESPONSES_MAX_CARRIER_BYTES,
          textBytes,
        );
      }
      content = data.output_text;
    }
    if (data.output !== undefined && !Array.isArray(data.output)) {
      throw new ProviderProtocolError("OpenAI Responses output is malformed");
    }
    const rawOutputItems = data.output ?? [];
    const outputItems: ResponsesOutputItem[] = [];
    let outputBytes = 0;
    for (const rawItem of rawOutputItems) {
      if (outputItems.length >= RESPONSES_MAX_OUTPUT_ITEMS) {
        throw new ProviderResponseTooLargeError(
          "OpenAI Responses output item count exceeded its bounded carrier",
          RESPONSES_MAX_OUTPUT_ITEMS,
          outputItems.length + 1,
        );
      }
      const item = normalizeResponsesOutputItem(rawItem);
      outputBytes = reserveResponsesOutputItem(outputBytes, outputItems.length, item).nextBytes;
      outputItems.push(item);
    }
    const fnCalls: ToolCallResult[] = [];
    const seenCallIds = new Set<string>();
    for (const item of outputItems) {
      if (item.type === "message" && !content) {
        content += textFromResponsesMessage(item);
      } else if (item.type === "function_call") {
        if (fnCalls.length >= PROVIDER_STREAM_LIMITS.maxCalls) {
          throw new ProviderResponseTooLargeError(
            `OpenAI Responses call count exceeded ${PROVIDER_STREAM_LIMITS.maxCalls}`,
            PROVIDER_STREAM_LIMITS.maxCalls,
            fnCalls.length + 1,
          );
        }
        if (seenCallIds.has(item.call_id)) {
          throw new ProviderProtocolError("OpenAI Responses function call IDs must be unique");
        }
        seenCallIds.add(item.call_id);
        fnCalls.push({
          name: item.name,
          args: parseModelToolArguments(item.arguments) as Record<string, unknown>,
          call_id: item.call_id,
        });
      }
    }
    const reasoningItems = outputItems.filter(
      (item): item is ResponsesReasoningOutputItem => item.type === "reasoning",
    );
    const reasoning = reasoningItems.map(reasoningFromResponsesItem).filter(Boolean).join("");
    const toolCalls = fnCalls.length > 0 ? fnCalls : undefined;
    const usage = parseOpenAIResponsesUsage(data.usage);

    const response: GenerationResponse = {
      content,
      reasoning: reasoning || undefined,
      finish_reason: responsesFinishReason(
        status,
        data.incomplete_details,
        Boolean(toolCalls),
      ),
      tool_calls: toolCalls,
      usage,
    };
    return outputItems.length > 0
      ? withProviderTransientCarrier(response, responsesCarrierWithItems(outputItems))
      : response;
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
    }, request.signal);
    if (!res.ok) {
      await throwProviderResponseError(
        this.displayName,
        "responses stream",
        res,
        request.signal,
        request.receiveLimitBytes,
      );
    }

    const completedOutputItemIds = new Set<string>();
    const sse = createBoundedSseReader(res, request.signal, {
      terminalMarker: "[DONE]",
      requireTerminal: false,
      maxResponseBytes: request.receiveLimitBytes,
    });
    type FunctionBuffer = {
      id: string;
      name: string;
      argsJson: string;
      callId: string;
      outputIndex: number;
      status?: string;
    };
    const fnCallBuffer = new Map<string, FunctionBuffer>();
    const outputItems = new Map<number, ResponsesOutputItem>();
    const outputItemBytes = new Map<number, number>();
    const outputIndexesById = new Map<string, number>();
    const seenCallIds = new Set<string>();
    let outputCarrierBytes = 0;
    let lastOutputIndex = -1;
    let eventCount = 0;
    const strictCompletion = isStatelessResponsesRequest(request);
    let responseTerminal = false;
    let sawResponseCreated = false;

    const outputIndex = (value: unknown): number => {
      if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new ProviderProtocolError("OpenAI Responses output item has an invalid output_index");
      }
      return value as number;
    };
    const validateEventOutputIndex = (value: unknown, expected: number): void => {
      if (value === undefined) return;
      if (outputIndex(value) !== expected) {
        throw new ProviderProtocolError("OpenAI Responses delta output_index does not match its item");
      }
    };
    const validateScopedItemEvent = (
      record: ResponsesRecord,
      expectedType: "message" | "reasoning" | "either",
      indexField: "content_index" | "summary_index",
    ): void => {
      const itemId = requiredBoundedString(
        record,
        "item_id",
        "OpenAI Responses item-scoped event is missing item_id",
      );
      if (completedOutputItemIds.has(itemId)) {
        throw new ProviderProtocolError("OpenAI Responses item-scoped event arrived after item completion");
      }
      const index = outputIndexesById.get(itemId);
      if (index === undefined) {
        throw new ProviderProtocolError("OpenAI Responses item-scoped event references an unknown item");
      }
      validateEventOutputIndex(record.output_index, index);
      const scopedIndex = record[indexField] === undefined ? undefined : outputIndex(record[indexField]);
      const item = outputItems.get(index);
      if (
        !item ||
        item.type === "function_call" ||
        (expectedType !== "either" && item.type !== expectedType)
      ) {
        throw new ProviderProtocolError("OpenAI Responses item-scoped event references an unexpected item type");
      }
      if (
        scopedIndex !== undefined &&
        scopedIndex > (item.type === "message" ? item.content.length : item.summary.length)
      ) {
        throw new ProviderProtocolError("OpenAI Responses item-scoped event index is out of order");
      }
    };
    const rememberOutputItem = (index: number, item: ResponsesOutputItem): void => {
      if (index !== lastOutputIndex + 1 || outputItems.has(index) || outputIndexesById.has(item.id)) {
        throw new ProviderProtocolError("OpenAI Responses output items are duplicated or out of order");
      }
      if (outputItems.size >= RESPONSES_MAX_OUTPUT_ITEMS) {
        throw new ProviderResponseTooLargeError(
          "OpenAI Responses output item count exceeded its bounded carrier",
          RESPONSES_MAX_OUTPUT_ITEMS,
          outputItems.size + 1,
        );
      }
      const reserved = reserveResponsesOutputItem(outputCarrierBytes, outputItems.size, item);
      outputItems.set(index, item);
      outputItemBytes.set(index, reserved.itemBytes);
      outputIndexesById.set(item.id, index);
      outputCarrierBytes = reserved.nextBytes;
      lastOutputIndex = index;
    };
    const replaceOutputItem = (item: ResponsesOutputItem): void => {
      const index = outputIndexesById.get(item.id);
      if (index === undefined) {
        throw new ProviderProtocolError("OpenAI Responses output item update references an unknown item");
      }
      const previous = outputItems.get(index);
      const previousBytes = outputItemBytes.get(index);
      if (!previous || previousBytes === undefined || previous.type !== item.type) {
        throw new ProviderProtocolError("OpenAI Responses output item update changes its type");
      }
      const nextItemBytes = jsonBytes(item, "OpenAI Responses output item");
      const nextCarrierBytes = outputCarrierBytes - previousBytes + nextItemBytes;
      if (nextCarrierBytes > RESPONSES_MAX_CARRIER_BYTES) {
        throw new ProviderResponseTooLargeError(
          "OpenAI Responses continuation carrier exceeded its bounded length",
          RESPONSES_MAX_CARRIER_BYTES,
          nextCarrierBytes,
        );
      }
      outputItems.set(index, item);
      outputItemBytes.set(index, nextItemBytes);
      outputCarrierBytes = nextCarrierBytes;
    };
    const updateFunctionArguments = (itemId: string, argsJson: string): void => {
      const buffer = fnCallBuffer.get(itemId);
      if (!buffer) {
        throw new ProviderProtocolError("OpenAI Responses argument update references an unknown item");
      }
      const index = outputIndexesById.get(buffer.id);
      if (index === undefined) {
        throw new ProviderProtocolError("OpenAI Responses argument update references an unknown item");
      }
      const item = outputItems.get(index);
      if (!item || item.type !== "function_call") {
        throw new ProviderProtocolError("OpenAI Responses argument update references a non-function item");
      }
      const bytes = Buffer.byteLength(argsJson, "utf8");
      if (bytes > PROVIDER_STREAM_LIMITS.maxArgumentsBytes) {
        throw new ProviderResponseTooLargeError(
          "OpenAI Responses arguments exceeded their bounded carrier",
          PROVIDER_STREAM_LIMITS.maxArgumentsBytes,
          bytes,
        );
      }
      const nextItem: ResponsesFunctionCallOutputItem = {
        ...item,
        arguments: argsJson,
      };
      replaceOutputItem(nextItem);
      buffer.argsJson = argsJson;
    };

    for await (const event of sse) {
      eventCount += 1;
      if (eventCount % 64 === 0) await yieldToEventLoop(request.signal);
      if (responseTerminal) {
        if (event.data === "[DONE]") continue;
        throw new ProviderProtocolError("OpenAI Responses stream emitted data after its terminal event");
      }
      if (event.data === "[DONE]") {
        throw new ProviderProtocolError("OpenAI Responses stream ended before response.completed");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch (error) {
        throw new ProviderProtocolError("Malformed OpenAI Responses SSE JSON", { cause: error });
      }
      const eventRecord = asResponsesRecord(parsed, "OpenAI Responses SSE event is malformed");
      const eventType = eventRecord.type;
      if (typeof eventType !== "string") {
        throw new ProviderProtocolError("OpenAI Responses SSE event is missing type");
      }
      if (event.event !== undefined && event.event !== eventType) {
        throw new ProviderProtocolError("OpenAI Responses SSE event name does not match its payload");
      }
      if (!sawResponseCreated && eventType !== "response.created") {
        throw new ProviderProtocolError("OpenAI Responses stream did not begin with response.created");
      }

      switch (eventType) {
        case "response.created": {
          if (sawResponseCreated) {
            throw new ProviderProtocolError("OpenAI Responses stream emitted duplicate response.created");
          }
          const createdResponse = asResponsesRecord(
            eventRecord.response,
            "OpenAI Responses created event is incomplete",
          );
          if (typeof createdResponse.status !== "string") {
            throw new ProviderProtocolError("OpenAI Responses created event status is malformed");
          }
          sawResponseCreated = true;
          break;
        }
        case "response.output_text.delta": {
          if (typeof eventRecord.delta !== "string") {
            throw new ProviderProtocolError("OpenAI Responses text delta must be a string");
          }
          const deltaBytes = Buffer.byteLength(eventRecord.delta, "utf8");
          if (deltaBytes > RESPONSES_MAX_CARRIER_BYTES) {
            throw new ProviderResponseTooLargeError(
              "OpenAI Responses text delta exceeded its bounded length",
              RESPONSES_MAX_CARRIER_BYTES,
              deltaBytes,
            );
          }
          const itemId = requiredBoundedString(
            eventRecord,
            "item_id",
            "OpenAI Responses text delta is missing item_id",
          );
          if (completedOutputItemIds.has(itemId)) {
            throw new ProviderProtocolError("OpenAI Responses text delta arrived after item completion");
          }
          const index = outputIndexesById.get(itemId);
          if (index === undefined) {
            throw new ProviderProtocolError("OpenAI Responses text delta references an unknown item");
          }
          validateEventOutputIndex(eventRecord.output_index, index);
          const existing = outputItems.get(index);
          if (!existing || existing.type !== "message") {
            throw new ProviderProtocolError("OpenAI Responses text delta references a non-message item");
          }
          const parts = [...existing.content];
          const contentIndex = eventRecord.content_index === undefined
            ? parts.length
            : outputIndex(eventRecord.content_index);
          if (contentIndex > parts.length) {
            throw new ProviderProtocolError("OpenAI Responses text delta content_index is out of order");
          }
          const currentPart = parts[contentIndex];
          if (currentPart !== undefined && currentPart.type !== "output_text") {
            throw new ProviderProtocolError("OpenAI Responses text delta references a non-text content part");
          }
          const currentText = currentPart?.text ?? "";
          const previousBytes = outputItemBytes.get(index);
          if (previousBytes === undefined) {
            throw new ProviderProtocolError("OpenAI Responses text delta item accounting is missing");
          }
          const nextItemBytes = currentPart
            ? previousBytes - jsonStringBytes(currentText) +
              jsonStringBytesWithAppend(currentText, eventRecord.delta)
            : jsonBytes(
                { ...existing, content: [...parts, { type: "output_text" as const, text: "" }] },
                "OpenAI Responses text delta",
              ) - jsonStringBytes("") + jsonStringBytesWithAppend("", eventRecord.delta);
          if (nextItemBytes > RESPONSES_MAX_CARRIER_BYTES) {
            throw new ProviderResponseTooLargeError(
              "OpenAI Responses continuation carrier exceeded its bounded length",
              RESPONSES_MAX_CARRIER_BYTES,
              outputCarrierBytes - previousBytes + nextItemBytes,
            );
          }
          parts[contentIndex] = {
            ...(currentPart ?? { type: "output_text" as const, text: "" }),
            type: "output_text",
            text: `${currentPart?.text ?? ""}${eventRecord.delta}`,
          };
          replaceOutputItem({ ...existing, content: parts });
          yield { token: eventRecord.delta };
          break;
        }
        case "response.reasoning_summary_text.delta": {
          if (typeof eventRecord.delta !== "string") {
            throw new ProviderProtocolError("OpenAI Responses reasoning delta must be a string");
          }
          const deltaBytes = Buffer.byteLength(eventRecord.delta, "utf8");
          if (deltaBytes > RESPONSES_MAX_CARRIER_BYTES) {
            throw new ProviderResponseTooLargeError(
              "OpenAI Responses reasoning delta exceeded its bounded length",
              RESPONSES_MAX_CARRIER_BYTES,
              deltaBytes,
            );
          }
          const itemId = requiredBoundedString(
            eventRecord,
            "item_id",
            "OpenAI Responses reasoning delta is missing item_id",
          );
          if (completedOutputItemIds.has(itemId)) {
            throw new ProviderProtocolError("OpenAI Responses reasoning delta arrived after item completion");
          }
          const index = outputIndexesById.get(itemId);
          if (index === undefined) {
            throw new ProviderProtocolError("OpenAI Responses reasoning delta references an unknown item");
          }
          validateEventOutputIndex(eventRecord.output_index, index);
          const existing = outputItems.get(index);
          if (!existing || existing.type !== "reasoning") {
            throw new ProviderProtocolError("OpenAI Responses reasoning delta references a non-reasoning item");
          }
          const summary = [...existing.summary];
          const summaryIndex = eventRecord.summary_index === undefined
            ? summary.length
            : outputIndex(eventRecord.summary_index);
          if (summaryIndex > summary.length) {
            throw new ProviderProtocolError("OpenAI Responses reasoning summary_index is out of order");
          }
          const currentSummary = summary[summaryIndex];
          const currentText = currentSummary?.text ?? "";
          const previousBytes = outputItemBytes.get(index);
          if (previousBytes === undefined) {
            throw new ProviderProtocolError("OpenAI Responses reasoning delta item accounting is missing");
          }
          const nextItemBytes = currentSummary
            ? previousBytes - jsonStringBytes(currentText) +
              jsonStringBytesWithAppend(currentText, eventRecord.delta)
            : jsonBytes(
                { ...existing, summary: [...summary, { type: "summary_text" as const, text: "" }] },
                "OpenAI Responses reasoning delta",
              ) - jsonStringBytes("") + jsonStringBytesWithAppend("", eventRecord.delta);
          if (nextItemBytes > RESPONSES_MAX_CARRIER_BYTES) {
            throw new ProviderResponseTooLargeError(
              "OpenAI Responses continuation carrier exceeded its bounded length",
              RESPONSES_MAX_CARRIER_BYTES,
              outputCarrierBytes - previousBytes + nextItemBytes,
            );
          }
          summary[summaryIndex] = {
            ...(summary[summaryIndex] ?? { type: "summary_text" as const, text: "" }),
            type: "summary_text",
            text: `${summary[summaryIndex]?.text ?? ""}${eventRecord.delta}`,
          };
          replaceOutputItem({ ...existing, summary });
          yield { token: "", reasoning: eventRecord.delta };
          break;
        }
        case "response.function_call_arguments.delta": {
          const itemId = requiredBoundedString(
            eventRecord,
            "item_id",
            "OpenAI Responses argument delta is missing item_id",
          );
          if (completedOutputItemIds.has(itemId)) {
            throw new ProviderProtocolError("OpenAI Responses argument delta arrived after item completion");
          }
          if (typeof eventRecord.delta !== "string") {
            throw new ProviderProtocolError("OpenAI Responses argument delta is malformed");
          }
          const existing = fnCallBuffer.get(itemId);
          if (!existing) {
            throw new ProviderProtocolError("OpenAI Responses argument delta references an unknown item");
          }
          const deltaBytes = Buffer.byteLength(eventRecord.delta, "utf8");
          const nextBytes = Buffer.byteLength(existing.argsJson, "utf8") + deltaBytes;
          if (deltaBytes > PROVIDER_STREAM_LIMITS.maxToolDeltaBytes || nextBytes > PROVIDER_STREAM_LIMITS.maxArgumentsBytes) {
            throw new ProviderResponseTooLargeError(
              "OpenAI Responses arguments exceeded their bounded carrier",
              PROVIDER_STREAM_LIMITS.maxArgumentsBytes,
              nextBytes,
            );
          }
          updateFunctionArguments(itemId, existing.argsJson + eventRecord.delta);
          break;
        }
        case "response.function_call_arguments.done": {
          const itemId = requiredBoundedString(
            eventRecord,
            "item_id",
            "OpenAI Responses argument completion is missing item_id",
          );
          if (completedOutputItemIds.has(itemId)) {
            throw new ProviderProtocolError("OpenAI Responses argument completion arrived after item completion");
          }
          const existing = fnCallBuffer.get(itemId);
          if (!existing) {
            throw new ProviderProtocolError("OpenAI Responses argument completion references an unknown item");
          }
          if (eventRecord.arguments !== undefined) {
            if (typeof eventRecord.arguments !== "string") {
              throw new ProviderProtocolError("OpenAI Responses arguments must be a string");
            }
            updateFunctionArguments(itemId, eventRecord.arguments);
          }
          break;
        }
        case "response.output_item.added": {
          const itemRecord = asResponsesRecord(eventRecord.item, "OpenAI Responses output item is malformed");
          const type = itemRecord.type;
          const index = outputIndex(eventRecord.output_index);
          if (type === "function_call") {
            const callId = requiredBoundedString(itemRecord, "call_id", "OpenAI Responses function call is missing native call_id");
            const name = requiredBoundedString(itemRecord, "name", "OpenAI Responses function call is missing name");
            const id = requiredBoundedString(itemRecord, "id", "OpenAI Responses function call is missing item id");
            if (seenCallIds.has(callId)) throw new ProviderProtocolError("OpenAI Responses native call IDs must be unique");
            const initialArguments = itemRecord.arguments === undefined ? "" : itemRecord.arguments;
            if (typeof initialArguments !== "string") {
              throw new ProviderProtocolError("OpenAI Responses arguments must be a string");
            }
            if (Buffer.byteLength(initialArguments, "utf8") > PROVIDER_STREAM_LIMITS.maxArgumentsBytes) {
              throw new ProviderResponseTooLargeError(
                "OpenAI Responses arguments exceeded their bounded carrier",
                PROVIDER_STREAM_LIMITS.maxArgumentsBytes,
                Buffer.byteLength(initialArguments, "utf8"),
              );
            }
            seenCallIds.add(callId);
            const status = optionalStatus(itemRecord);
            const buffer: FunctionBuffer = {
              id,
              name,
              argsJson: initialArguments,
              callId,
              outputIndex: index,
              ...(status !== undefined ? { status } : {}),
            };
            rememberOutputItem(index, {
              type: "function_call",
              id,
              call_id: callId,
              name,
              arguments: initialArguments,
              ...(status !== undefined ? { status } : {}),
            });
            fnCallBuffer.set(id, buffer);
          } else if (type === "message") {
            rememberOutputItem(index, normalizeResponsesMessageItem(itemRecord));
          } else if (type === "reasoning") {
            rememberOutputItem(index, normalizeResponsesReasoningItem(itemRecord));
          } else {
            throw new ProviderProtocolError("OpenAI Responses output item type is unsupported");
          }
          break;
        }
        case "response.output_item.done": {
          const itemRecord = asResponsesRecord(eventRecord.item, "OpenAI Responses output item is malformed");
          const type = itemRecord.type;
          let normalized: ResponsesOutputItem;
          if (type === "message") {
            normalized = normalizeResponsesMessageItem(itemRecord);
          } else if (type === "reasoning") {
            normalized = normalizeResponsesReasoningItem(itemRecord);
          } else if (type === "function_call") {
            const itemId = requiredBoundedString(itemRecord, "id", "OpenAI Responses function call is missing item id");
            normalized = normalizeResponsesFunctionItem({
              ...itemRecord,
              arguments: itemRecord.arguments ?? fnCallBuffer.get(itemId)?.argsJson,
            });
          } else {
            throw new ProviderProtocolError("OpenAI Responses output item type is unsupported");
          }
          const doneIndex = outputIndex(eventRecord.output_index);
          if (outputIndexesById.get(normalized.id) !== doneIndex) {
            throw new ProviderProtocolError("OpenAI Responses output item completion index does not match its item");
          }
          if (completedOutputItemIds.has(normalized.id)) {
            throw new ProviderProtocolError("OpenAI Responses output item was completed more than once");
          }
          const streamed = outputItems.get(doneIndex);
          if (
            streamed?.type === "function_call" &&
            normalized.type === "function_call" &&
            (streamed.call_id !== normalized.call_id || streamed.name !== normalized.name)
          ) {
            throw new ProviderProtocolError("OpenAI Responses output item function identity changed");
          }
          replaceOutputItem(normalized);
          completedOutputItemIds.add(normalized.id);
          break;
        }
        case "response.completed": {
          if (responseTerminal) {
            throw new ProviderProtocolError("OpenAI Responses stream emitted duplicate terminal events");
          }
          const responseRecord = eventRecord.response === undefined
            ? eventRecord
            : asResponsesRecord(eventRecord.response, "OpenAI Responses terminal event is incomplete");
          const responseStatus = requiredBoundedString(
            responseRecord,
            "status",
            "OpenAI Responses terminal event is incomplete",
          );
          if (responseStatus !== "completed" && strictCompletion) {
            throw new ProviderProtocolError("OpenAI Responses response did not complete successfully");
          }
          const responseIsComplete = responseStatus === "completed";
          responseTerminal = true;
          if (Array.isArray(responseRecord.output)) {
            if (responseRecord.output.length > RESPONSES_MAX_OUTPUT_ITEMS) {
              throw new ProviderResponseTooLargeError(
                "OpenAI Responses output item count exceeded its bounded carrier",
                RESPONSES_MAX_OUTPUT_ITEMS,
                responseRecord.output.length,
              );
            }
            const terminalItems = responseRecord.output.map((rawItem) => normalizeResponsesOutputItem(rawItem));
            if (outputItems.size === 0) {
              // A provider may deliver only the terminal output for an
              // incomplete response. Surface that bounded partial content
              // before the finish marker rather than dropping it.
              for (const item of terminalItems) {
                if (item.type === "message") {
                  const token = textFromResponsesMessage(item);
                  if (token) yield { token };
                } else if (item.type === "reasoning") {
                  const reasoning = reasoningFromResponsesItem(item);
                  if (reasoning) yield { token: "", reasoning };
                }
              }
              for (const [index, item] of terminalItems.entries()) {
                rememberOutputItem(index, item);
                completedOutputItemIds.add(item.id);
              }
            } else {
              if (terminalItems.length !== outputItems.size) {
                throw new ProviderProtocolError("OpenAI Responses terminal output item count does not match streamed items");
              }
              for (const [index, item] of terminalItems.entries()) {
                const streamed = outputItems.get(index);
                if (!streamed || streamed.id !== item.id || streamed.type !== item.type) {
                  throw new ProviderProtocolError("OpenAI Responses terminal output item identity does not match streamed item");
                }
                if (
                  streamed.type === "function_call" &&
                  item.type === "function_call" &&
                  (streamed.call_id !== item.call_id || streamed.name !== item.name)
                ) {
                  throw new ProviderProtocolError("OpenAI Responses terminal function call identity changed");
                }
                replaceOutputItem(item);
                completedOutputItemIds.add(item.id);
              }
            }
          } else if (responseRecord.output !== undefined) {
            throw new ProviderProtocolError("OpenAI Responses terminal output is malformed");
          } else if (
            responseIsComplete &&
            [...outputItems.values()].some((item) => !completedOutputItemIds.has(item.id))
          ) {
            throw new ProviderProtocolError("OpenAI Responses output item was not completed");
          }
          const orderedItems = [...outputItems.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, item]) => item);
          assertResponsesCarrierBounds(orderedItems);
          const completeCallItems = orderedItems.filter(
            (item): item is Extract<ResponsesOutputItem, { type: "function_call" }> =>
              item.type === "function_call",
          );
          const completeCallIds = new Set<string>();
          for (const call of completeCallItems) {
            if (completeCallIds.has(call.call_id)) {
              throw new ProviderProtocolError("OpenAI Responses function call IDs must be unique");
            }
            completeCallIds.add(call.call_id);
          }
          const calls = completeCallItems.length > 0
            ? completeCallItems.map((call) => ({
                name: call.name,
                args: parseModelToolArguments(call.arguments) as Record<string, unknown>,
                call_id: call.call_id,
              }))
            : [...fnCallBuffer.values()]
              .sort((a, b) => a.outputIndex - b.outputIndex)
              .map((call) => ({
                name: call.name,
                args: parseModelToolArguments(call.argsJson) as Record<string, unknown>,
                call_id: call.callId,
              }));
          const usage = parseOpenAIResponsesUsage(responseRecord.usage, true);
          const carrier = orderedItems.length > 0 ? responsesCarrierWithItems(orderedItems) : undefined;
          const chunk: StreamChunk = {
            token: "",
            finish_reason: responsesFinishReason(
              responseStatus,
              responseRecord.incomplete_details,
              calls.length > 0,
            ),
            tool_calls: calls.length > 0 ? calls : undefined,
            usage,
          };
          yield carrier ? withProviderTransientCarrier(chunk, carrier) : chunk;
          break;
        }
        case "response.in_progress":
          break;
        case "response.content_part.added":
        case "response.content_part.done":
          validateScopedItemEvent(eventRecord, "either", "content_index");
          break;
        case "response.output_text.annotation.added":
        case "response.output_text.done":
          validateScopedItemEvent(eventRecord, "message", "content_index");
          break;
        case "response.reasoning_summary_part.added":
        case "response.reasoning_summary_part.done":
        case "response.reasoning_summary_text.done":
          validateScopedItemEvent(eventRecord, "reasoning", "summary_index");
          break;
        default:
          throw new ProviderProtocolError("Unknown OpenAI Responses event type");
      }
    }
    if (!responseTerminal) {
      throw new ProviderProtocolError("OpenAI Responses stream ended without response.completed");
    }
  }
}
