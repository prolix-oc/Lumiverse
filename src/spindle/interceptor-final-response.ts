import { isDeepStrictEqual } from "node:util";
import type {
  FinalResponseDTO,
  InterceptorBreakdownEntryDTO,
  LlmMessageDTO,
} from "lumiverse-spindle-types";
import type { ParentGenerationSnapshot } from "./bound-generation-types";

const MAX_FINAL_RESPONSE_BYTES = 1024 * 1024;
const TEXT_ENCODER = new TextEncoder();
const FINAL_RESPONSE_CARRIER_FIELD = "__lumiverse_final_response_carrier__";
const RESERVED_BREAKDOWN_LABELS: Record<string, true> = { "final response": true };

type MessageWithPrivateCarrier = LlmMessageDTO & Record<string, unknown>;

export type InterceptorFinalResponseDTO = FinalResponseDTO;

export interface ProtectedFinalResponseBreakdown {
  readonly messageIndex: number;
  readonly name: string;
  readonly role: LlmMessageDTO["role"];
  readonly content: string;
  readonly extensionId: string;
  readonly extensionName: string;
}

export interface ValidInterceptorFinalResponse {
  readonly status: "valid";
  readonly content: string;
  readonly reasoning?: string;
  readonly fallbackMessage: LlmMessageDTO;
  readonly fallbackMessageIndex: number;
  readonly fallbackBreakdown: ProtectedFinalResponseBreakdown;
  readonly carrierNonce: string;
  readonly prefillCarrier?: LlmMessageDTO;
  readonly supersededResponse?: ValidInterceptorFinalResponse;
  readonly extensionId: string;
  readonly extensionName: string;
  readonly workerId: string;
  readonly registrationId: string;
  readonly callbackUserId: string;
  readonly hostGeneration: string;
  readonly permissionGuard: () => boolean;
}

export interface RejectedInterceptorFinalResponse {
  readonly status: "invalid" | "unauthorized";
  readonly reason: string;
  readonly extensionId: string;
  readonly extensionName: string;
  readonly workerId: string;
  readonly registrationId: string;
  readonly callbackUserId: string;
  readonly hostGeneration: string;
}

export type InterceptorFinalResponseState =
  | ValidInterceptorFinalResponse
  | RejectedInterceptorFinalResponse;

export interface NormalizeFinalResponseInput {
  readonly result: unknown;
  readonly inputMessages: readonly LlmMessageDTO[];
  readonly outputMessages: readonly LlmMessageDTO[];
  readonly breakdown: readonly InterceptorBreakdownEntryDTO[];
  readonly parent?: ParentGenerationSnapshot;
  /** Permission state captured by the host at callback receipt. */
  readonly permissionGranted: boolean;
  /** Live host permission/identity check used at receipt and final selection. */
  readonly permissionGuard: () => boolean;
  readonly extensionId: string;
  readonly extensionName: string;
  readonly workerId: string;
  readonly registrationId: string;
  readonly callbackUserId: string;
  readonly hostGeneration: string;
}

export interface NormalizeFinalResponseResult {
  readonly messages: LlmMessageDTO[];
  readonly breakdown: InterceptorBreakdownEntryDTO[];
  readonly finalResponse?: InterceptorFinalResponseState;
}

export interface FinalResponseBreakdownReplacement {
  readonly from: ProtectedFinalResponseBreakdown;
  readonly to: ProtectedFinalResponseBreakdown;
}

export type FinalResponseDispatchDecision =
  | {
      readonly kind: "provider";
      readonly messages: LlmMessageDTO[];
      readonly warning?: string;
    }
  | {
      readonly kind: "final-response";
      readonly response: ValidInterceptorFinalResponse;
      readonly messages: LlmMessageDTO[];
      readonly breakdownReplacement?: FinalResponseBreakdownReplacement;
      readonly warning?: string;
    };

export interface FinalResponseStateEnvelope {
  readonly messages: readonly LlmMessageDTO[];
  readonly breakdown: readonly InterceptorBreakdownEntryDTO[];
  readonly finalResponse?: InterceptorFinalResponseState;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneArray<T>(value: readonly T[]): T[] {
  return value.map((entry) => clone(entry));
}

function hostIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty host identity`);
  }
  return value.trim();
}

function invalid(
  input: NormalizeFinalResponseInput,
  status: RejectedInterceptorFinalResponse["status"],
  reason: string,
): NormalizeFinalResponseResult {
  return {
    messages: cloneArray(input.outputMessages),
    breakdown: cloneArray(input.breakdown),
    finalResponse: Object.freeze({
      status,
      reason,
      extensionId: hostIdentity(input.extensionId, "extensionId"),
      extensionName: hostIdentity(input.extensionName, "extensionName"),
      workerId: hostIdentity(input.workerId, "workerId"),
      registrationId: hostIdentity(input.registrationId, "registrationId"),
      callbackUserId: hostIdentity(input.callbackUserId, "callbackUserId"),
      hostGeneration: hostIdentity(input.hostGeneration, "hostGeneration"),
    }),
  };
}

function boundedText(value: unknown, label: string, allowEmpty: boolean): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (!allowEmpty && value.trim().length === 0) throw new TypeError(`${label} must be nonempty`);
  if (TEXT_ENCODER.encode(value).byteLength > MAX_FINAL_RESPONSE_BYTES) {
    throw new RangeError(`${label} exceeds ${MAX_FINAL_RESPONSE_BYTES} UTF-8 bytes`);
  }
  return value;
}

function isNonemptyAssistantCarrier(message: LlmMessageDTO | undefined): message is LlmMessageDTO {
  return !!message
    && message.role === "assistant"
    && typeof message.content === "string"
    && message.content.length > 0;
}

function readAuthoritativePrefill(parent: ParentGenerationSnapshot | undefined): LlmMessageDTO | undefined {
  if (!parent || parent.parentPrefill.state !== "available") return undefined;
  const carrier = parent.parentPrefillCarrier;
  if (carrier?.length !== 1 || !isNonemptyAssistantCarrier(carrier[0])) {
    throw new TypeError(
      "PREFILL_CARRIER_MISMATCH: authoritative assistant prefill carrier is missing or ambiguous",
    );
  }
  return clone(carrier[0]);
}

function stripHostMetadata(message: LlmMessageDTO): Record<string, unknown> {
  const copy = clone(message) as MessageWithPrivateCarrier;
  delete copy.cache_control;
  delete copy[FINAL_RESPONSE_CARRIER_FIELD];
  return copy;
}

function sameCarrierIdentity(left: LlmMessageDTO | undefined, right: LlmMessageDTO): boolean {
  return !!left && isDeepStrictEqual(stripHostMetadata(left), stripHostMetadata(right));
}

function markCarrier(message: LlmMessageDTO, nonce: string): LlmMessageDTO {
  const marked = clone(message) as MessageWithPrivateCarrier;
  marked[FINAL_RESPONSE_CARRIER_FIELD] = nonce;
  return marked;
}

export function stripInterceptorFinalResponseCarrier(
  messages: readonly LlmMessageDTO[],
): LlmMessageDTO[] {
  return messages.map((message) => {
    const copy = clone(message) as MessageWithPrivateCarrier;
    delete copy[FINAL_RESPONSE_CARRIER_FIELD];
    return copy;
  });
}
const stripCarrierMarkers = stripInterceptorFinalResponseCarrier;

function isLivePermission(input: NormalizeFinalResponseInput): boolean {
  if (!input.permissionGranted) return false;
  try {
    return input.permissionGuard() === true;
  } catch {
    return false;
  }
}

export function normalizeInterceptorFinalResponse(
  input: NormalizeFinalResponseInput,
): NormalizeFinalResponseResult {
  if (input.result === undefined) {
    return {
      messages: cloneArray(input.outputMessages),
      breakdown: cloneArray(input.breakdown),
    };
  }

  if (!isLivePermission(input)) {
    return invalid(input, "unauthorized", "final_response permission is not granted");
  }

  try {
    if (input.result === null || typeof input.result !== "object" || Array.isArray(input.result)) {
      throw new TypeError("finalResponse must be an object");
    }
    const result = input.result as Record<string, unknown>;
    const content = boundedText(result.content, "finalResponse.content", false);
    const reasoning = result.reasoning === undefined
      ? undefined
      : boundedText(result.reasoning, "finalResponse.reasoning", true);
    const fallbackMessageIndex = result.fallbackMessageIndex;
    if (
      !Number.isSafeInteger(fallbackMessageIndex)
      || (fallbackMessageIndex as number) < 0
      || (fallbackMessageIndex as number) >= input.outputMessages.length
    ) {
      throw new RangeError("finalResponse.fallbackMessageIndex is out of range");
    }
    const fallbackMessage = input.outputMessages[fallbackMessageIndex as number];
    if (
      !fallbackMessage
      || fallbackMessage.role !== "system"
      || typeof fallbackMessage.content !== "string"
      || fallbackMessage.content.trim().length === 0
    ) {
      throw new TypeError("finalResponse fallback must identify one nonempty text system message");
    }
    const withoutFallback = input.outputMessages.filter((_, index) => index !== fallbackMessageIndex);
    if (!isDeepStrictEqual(withoutFallback, input.inputMessages)) {
      throw new TypeError("finalResponse fallback must be the only message inserted by this interceptor result");
    }

    const matchingBreakdownIndexes = input.breakdown
      .map((entry, index) => entry?.messageIndex === fallbackMessageIndex ? index : -1)
      .filter((index) => index >= 0);
    if (matchingBreakdownIndexes.length !== 1) {
      throw new TypeError("finalResponse fallback requires exactly one matching breakdown entry");
    }

    const prefillCarrier = readAuthoritativePrefill(input.parent);
    if (prefillCarrier) {
      const carrierIndexes = input.outputMessages
        .map((message, index) => sameCarrierIdentity(message, prefillCarrier) ? index : -1)
        .filter((index) => index >= 0);
      if (carrierIndexes.length !== 1 || fallbackMessageIndex !== carrierIndexes[0] - 1) {
        throw new TypeError(
          "PREFILL_CARRIER_MISMATCH: finalResponse fallback must be immediately before the authoritative assistant prefill",
        );
      }
    }

    const extensionId = hostIdentity(input.extensionId, "extensionId");
    const extensionName = hostIdentity(input.extensionName, "extensionName");
    const workerId = hostIdentity(input.workerId, "workerId");
    const registrationId = hostIdentity(input.registrationId, "registrationId");
    const callbackUserId = hostIdentity(input.callbackUserId, "callbackUserId");
    const hostGeneration = hostIdentity(input.hostGeneration, "hostGeneration");
    const matchingEntry = input.breakdown[matchingBreakdownIndexes[0]!];
    const requestedName = typeof matchingEntry?.name === "string" && matchingEntry.name.trim()
      ? matchingEntry.name.trim()
      : extensionName;
    const fallbackBreakdown = Object.freeze({
      messageIndex: fallbackMessageIndex as number,
      name: RESERVED_BREAKDOWN_LABELS[requestedName.toLocaleLowerCase("en-US")]
        ? `${extensionName}: ${requestedName}`
        : requestedName,
      role: fallbackMessage.role,
      content: fallbackMessage.content,
      extensionId,
      extensionName,
    });
    const normalizedBreakdown = cloneArray(input.breakdown);
    normalizedBreakdown[matchingBreakdownIndexes[0]!] = {
      ...normalizedBreakdown[matchingBreakdownIndexes[0]!],
      messageIndex: fallbackMessageIndex as number,
      name: fallbackBreakdown.name,
    };
    const carrierNonce = crypto.randomUUID();
    const messagesWithCarrier = cloneArray(input.outputMessages);
    messagesWithCarrier[fallbackMessageIndex as number] = markCarrier(fallbackMessage, carrierNonce);
    const state: ValidInterceptorFinalResponse = Object.freeze({
      status: "valid",
      content,
      ...(reasoning !== undefined ? { reasoning } : {}),
      fallbackMessage: Object.freeze(clone(fallbackMessage)),
      fallbackMessageIndex: fallbackMessageIndex as number,
      fallbackBreakdown,
      carrierNonce,
      ...(prefillCarrier ? { prefillCarrier: Object.freeze(prefillCarrier) } : {}),
      extensionId,
      extensionName,
      workerId,
      registrationId,
      callbackUserId,
      hostGeneration,
      permissionGuard: input.permissionGuard,
    });
    return {
      messages: messagesWithCarrier,
      breakdown: normalizedBreakdown,
      finalResponse: state,
    };
  } catch (error) {
    return invalid(
      input,
      "invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function carrierIndexes(messages: readonly LlmMessageDTO[], nonce: string): number[] {
  return messages
    .map((message, index) =>
      (message as MessageWithPrivateCarrier)[FINAL_RESPONSE_CARRIER_FIELD] === nonce ? index : -1,
    )
    .filter((index) => index >= 0);
}

/**
 * Re-materialize a host-held fallback carrier after an extension callback.
 *
 * Worker transports never carry the private nonce. A callback therefore has
 * to preserve exactly one message equal to the host snapshot; only then may
 * the host put its nonce back. Existing host markers are accepted solely
 * after the same exact-identity check.
 */
export function materializeInterceptorFinalResponseCarrier(
  messages: readonly LlmMessageDTO[],
  response: ValidInterceptorFinalResponse,
): LlmMessageDTO[] {
  const marked = carrierIndexes(messages, response.carrierNonce);
  if (marked.length > 0) {
    if (marked.length !== 1 || !sameCarrierIdentity(messages[marked[0]], response.fallbackMessage)) {
      throw new Error("Final response fallback carrier is missing, modified, or ambiguous");
    }
    return cloneArray(messages);
  }

  const exact = messages
    .map((message, index) => sameCarrierIdentity(message, response.fallbackMessage) ? index : -1)
    .filter((index) => index >= 0);
  if (exact.length !== 1) {
    throw new Error("Final response fallback carrier is missing, modified, or ambiguous");
  }

  const materialized = cloneArray(messages);
  materialized[exact[0]!] = markCarrier(materialized[exact[0]!]!, response.carrierNonce);
  return materialized;
}


function fallbackCandidateIndexes(
  messages: readonly LlmMessageDTO[],
  response: ValidInterceptorFinalResponse,
): number[] {
  const marked = carrierIndexes(messages, response.carrierNonce)
    .filter((index) => sameCarrierIdentity(messages[index], response.fallbackMessage));
  if (marked.length > 0) return marked;
  if (sameCarrierIdentity(messages[response.fallbackMessageIndex], response.fallbackMessage)) {
    return [response.fallbackMessageIndex];
  }
  const exact = messages
    .map((message, index) => sameCarrierIdentity(message, response.fallbackMessage) ? index : -1)
    .filter((index) => index >= 0);
  return exact.length === 1 ? exact : [];
}

/** Restore the immutable host snapshot once, preserving an authoritative prefill. */
export function ensureInterceptorFinalResponseFallback(
  messages: readonly LlmMessageDTO[],
  response: ValidInterceptorFinalResponse,
): LlmMessageDTO[] {
  const candidateIndexList = fallbackCandidateIndexes(messages, response);
  const candidateIndexes = new Set(candidateIndexList);
  const restoredMessages = stripCarrierMarkers(messages)
    .filter((_, index) => !candidateIndexes.has(index));

  let insertionIndex = restoredMessages.length;
  if (response.prefillCarrier) {
    const prefillIndexes = restoredMessages
      .map((message, index) => sameCarrierIdentity(message, response.prefillCarrier!) ? index : -1)
      .filter((index) => index >= 0);
    if (prefillIndexes.length !== 1) {
      const error = new Error(
        "PREFILL_CARRIER_MISMATCH: authoritative assistant prefill carrier is missing or ambiguous",
      );
      error.name = "PrefillCarrierMismatchError";
      throw error;
    }
    insertionIndex = prefillIndexes[0]!;
  }
  restoredMessages.splice(insertionIndex, 0, clone(response.fallbackMessage));
  return restoredMessages;
}

export function detachInterceptorFinalResponseCarrier<TBreakdown extends InterceptorBreakdownEntryDTO>(
  response: ValidInterceptorFinalResponse,
  messages: readonly LlmMessageDTO[],
  breakdown: readonly TBreakdown[],
): {
  readonly messages: LlmMessageDTO[];
  readonly breakdown: TBreakdown[];
  readonly carrierInsertionIndex: number;
  readonly prefillCarrier?: LlmMessageDTO;
  readonly prefillBreakdown: TBreakdown[];
} {
  const indexes = carrierIndexes(messages, response.carrierNonce);
  if (indexes.length !== 1) throw new Error("Final response fallback carrier is missing or ambiguous");
  const carrierIndex = indexes[0]!;
  const strippedMessages = stripCarrierMarkers(messages);
  const prefillIndexes = response.prefillCarrier
    ? strippedMessages
      .map((message, index) => sameCarrierIdentity(message, response.prefillCarrier!) ? index : -1)
      .filter((index) => index >= 0)
    : [];
  if (response.prefillCarrier && prefillIndexes.length !== 1) {
    throw new Error("PREFILL_CARRIER_MISMATCH: authoritative assistant prefill carrier is missing or ambiguous");
  }
  const prefillIndex = prefillIndexes[0];
  const removedIndexes = [carrierIndex, ...(prefillIndex === undefined ? [] : [prefillIndex])]
    .sort((left, right) => left - right);
  const removedIndexSet = new Set(removedIndexes);
  const detachedMessages = strippedMessages.filter((_, index) => !removedIndexSet.has(index));
  const detachedBreakdown = breakdown
    .filter((entry) => !removedIndexSet.has(entry.messageIndex))
    .map((entry) => ({
      ...entry,
      messageIndex: entry.messageIndex - removedIndexes.filter((index) => index < entry.messageIndex).length,
    })) as TBreakdown[];
  return {
    messages: detachedMessages,
    carrierInsertionIndex: carrierIndex - removedIndexes.filter((index) => index < carrierIndex).length,
    breakdown: detachedBreakdown,
    ...(prefillIndex === undefined ? {} : { prefillCarrier: clone(response.prefillCarrier!) }),
    prefillBreakdown: prefillIndex === undefined
      ? []
      : cloneArray(breakdown.filter((entry) => entry.messageIndex === prefillIndex)),
  };
}

export function refreshInterceptorFinalResponseCarrier<TBreakdown extends InterceptorBreakdownEntryDTO>(
  response: ValidInterceptorFinalResponse,
  messages: readonly LlmMessageDTO[],
  breakdown: readonly TBreakdown[],
): {
  readonly messages: LlmMessageDTO[];
  readonly breakdown: TBreakdown[];
  readonly finalResponse: ValidInterceptorFinalResponse;
} {
  const candidateIndexList = fallbackCandidateIndexes(messages, response);
  const candidateIndexes = new Set(candidateIndexList);
  const reconciledMessages = stripCarrierMarkers(messages).filter((_, index) => !candidateIndexes.has(index));
  let insertionIndex = reconciledMessages.length;
  if (response.prefillCarrier) {
    const prefillIndexes = reconciledMessages
      .map((message, index) => sameCarrierIdentity(message, response.prefillCarrier!) ? index : -1)
      .filter((index) => index >= 0);
    if (prefillIndexes.length !== 1) {
      throw new Error("PREFILL_CARRIER_MISMATCH: authoritative assistant prefill carrier is missing or ambiguous");
    }
    insertionIndex = prefillIndexes[0]!;
  }
  reconciledMessages.splice(insertionIndex, 0, markCarrier(response.fallbackMessage, response.carrierNonce));
  const reconciledBreakdown = breakdown
    .filter((entry) => !candidateIndexes.has(entry.messageIndex))
    .map((entry) => {
      const removedBefore = candidateIndexList.filter((index) => index < entry.messageIndex).length;
      const afterRemoval = entry.messageIndex - removedBefore;
      return {
        ...entry,
        messageIndex: afterRemoval >= insertionIndex ? afterRemoval + 1 : afterRemoval,
      };
    }) as TBreakdown[];
  return {
    messages: reconciledMessages,
    breakdown: reconciledBreakdown,
    finalResponse: Object.freeze({
      ...response,
      fallbackMessageIndex: insertionIndex,
      fallbackBreakdown: Object.freeze({ ...response.fallbackBreakdown, messageIndex: insertionIndex }),
    }),
  };
}

export function supersedeInterceptorFinalResponse<TBreakdown extends InterceptorBreakdownEntryDTO>(input: {
  readonly previous: ValidInterceptorFinalResponse;
  readonly next: ValidInterceptorFinalResponse;
  readonly messages: readonly LlmMessageDTO[];
  readonly acceptedBreakdown: readonly TBreakdown[];
  readonly outputBreakdown: readonly TBreakdown[];
}): {
  readonly messages: LlmMessageDTO[];
  readonly acceptedBreakdown: TBreakdown[];
  readonly outputBreakdown: TBreakdown[];
  readonly finalResponse: ValidInterceptorFinalResponse;
} {
  const previousIndexes = carrierIndexes(input.messages, input.previous.carrierNonce);
  if (previousIndexes.length !== 1) {
    throw new Error("Superseded final response fallback carrier is missing or ambiguous");
  }
  const previousIndex = previousIndexes[0]!;
  const messages = cloneArray(input.messages);
  messages.splice(previousIndex, 1);
  const nextIndexes = carrierIndexes(messages, input.next.carrierNonce);
  if (nextIndexes.length !== 1) {
    throw new Error("Replacement final response fallback carrier is missing or ambiguous");
  }
  const nextIndex = nextIndexes[0]!;
  const previousInputIndex = input.previous.fallbackMessageIndex;
  const acceptedBreakdown = input.acceptedBreakdown
    .filter((entry) => !(entry.messageIndex === previousInputIndex && entry.name === input.previous.fallbackBreakdown.name))
    .map((entry) => {
      const afterRemoval = entry.messageIndex > previousInputIndex ? entry.messageIndex - 1 : entry.messageIndex;
      return { ...entry, messageIndex: afterRemoval >= nextIndex ? afterRemoval + 1 : afterRemoval };
    }) as TBreakdown[];
  const outputBreakdown = input.outputBreakdown
    .filter((entry) => entry.messageIndex !== previousIndex)
    .map((entry) => ({
      ...entry,
      messageIndex: entry.messageIndex > previousIndex ? entry.messageIndex - 1 : entry.messageIndex,
    })) as TBreakdown[];
  return {
    messages,
    acceptedBreakdown,
    outputBreakdown,
    finalResponse: Object.freeze({
      ...input.next,
      fallbackMessageIndex: nextIndex,
      fallbackBreakdown: Object.freeze({ ...input.next.fallbackBreakdown, messageIndex: nextIndex }),
      supersededResponse: input.previous,
    }),
  };
}

/** Fold callback results in registration order: omission/rejection retain a winner. */
export function retainInterceptorFinalResponse(
  previous: ValidInterceptorFinalResponse | undefined,
  next: InterceptorFinalResponseState | undefined,
): InterceptorFinalResponseState | undefined {
  if (next === undefined) return previous;
  if (next.status === "valid") {
    return previous && previous !== next
      ? Object.freeze({ ...next, supersededResponse: previous })
      : next;
  }
  return previous ?? next;
}

export function selectInterceptorFinalResponse(input: {
  readonly response: InterceptorFinalResponseState | undefined;
  readonly messages: readonly LlmMessageDTO[];
  readonly generationType: string;
  readonly hasTools: boolean;
  readonly isDryRun: boolean;
}): FinalResponseDispatchDecision {
  if (!input.response || input.response.status !== "valid") {
    return { kind: "provider", messages: stripCarrierMarkers(input.messages) };
  }
  const response = input.response;
  const markedIndexes = carrierIndexes(input.messages, input.response.carrierNonce);
  const markedFallback = markedIndexes.length === 1 ? input.messages[markedIndexes[0]!] : undefined;
  if (input.isDryRun || (input.generationType !== "normal" && input.generationType !== "continue")) {
    return {
      kind: "provider",
      messages: ensureInterceptorFinalResponseFallback(input.messages, input.response),
    };
  }

  let permissionGranted = false;
  try {
    permissionGranted = input.response.permissionGuard() === true;
  } catch {
    permissionGranted = false;
  }
  if (!permissionGranted) {
    return {
      kind: "provider",
      messages: ensureInterceptorFinalResponseFallback(input.messages, input.response),
      warning: `Final response from ${input.response.extensionName} was not used because final_response permission is no longer granted`,
    };
  }
  if (input.hasTools) {
    return {
      kind: "provider",
      messages: ensureInterceptorFinalResponseFallback(input.messages, input.response),
    };
  }
  if (markedIndexes.length !== 1) {
    return {
      kind: "provider",
      messages: ensureInterceptorFinalResponseFallback(input.messages, input.response),
      warning: `Final response from ${input.response.extensionName} was not used because its fallback carrier was missing or ambiguous`,
    };
  }
  if (!markedFallback || !sameCarrierIdentity(markedFallback, input.response.fallbackMessage)) {
    return {
      kind: "provider",
      messages: ensureInterceptorFinalResponseFallback(input.messages, input.response),
      warning: `Final response from ${input.response.extensionName} was not used because its fallback carrier was modified or duplicated`,
    };
  }
  if (response.prefillCarrier) {
    const prefillCarrier = response.prefillCarrier;
    const prefillIndexes = input.messages
      .map((message, index) => sameCarrierIdentity(message, prefillCarrier) ? index : -1)
      .filter((index) => index >= 0);
    if (prefillIndexes.length !== 1 || prefillIndexes[0] !== markedIndexes[0]! + 1) {
      const error = new Error(
        "PREFILL_CARRIER_MISMATCH: authoritative assistant prefill carrier was modified, missing, or displaced",
      );
      error.name = "PrefillCarrierMismatchError";
      throw error;
    }
  }
  const finalMessages = stripCarrierMarkers(input.messages);
  finalMessages.splice(markedIndexes[0]!, 1);
  return {
    kind: "final-response",
    response: input.response,
    messages: finalMessages,
  };
}

export { MAX_FINAL_RESPONSE_BYTES, FINAL_RESPONSE_CARRIER_FIELD };
