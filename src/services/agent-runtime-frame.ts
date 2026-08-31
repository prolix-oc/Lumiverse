import type {
  AgentAdapterCapabilities,
  AgentAdapterRequestContext,
  AgentContinuationCarrier,
  AgentLedgerReservation,
  AgentLoopFrameKind,
  AgentProviderAdapterId,
  AgentPublicErrorCode,
  AgentToolLoopFrame as AgentToolLoopFrameContract,
  AgentToolMode,
  AgentToolModePolicy,
} from "../types/agent-runtime";
import type { LlmMessage, ToolCallResult, ToolDefinition } from "../llm/types";
import type { AgentAdmissionPermit } from "./agent-runtime-admission";
import type { AgentTurnLedger } from "./agent-runtime-ledger";
import {
  AGENT_AGGREGATE_TOOL_PAYLOAD_MAX_BYTES,
  AGENT_ARGUMENT_MAX_BYTES,
  AGENT_CONTINUATION_FRAME_MAX_BYTES,
  AGENT_JSON_DEPTH_MAX,
  AGENT_JSON_NODE_MAX,
  AGENT_RESULT_MAX_BYTES,
  assertJsonValueBounds,
  boundedJsonValueBytes,
  utf8ByteLength,
} from "./agent-runtime-accounting";

export const AGENT_PROVIDER_CALL_ID_MAX_BYTES = 256;
export const AGENT_PROVIDER_TOOL_NAME_MAX_BYTES = 256;
export const AGENT_TOOL_BATCH_MAX_CALLS = 64;
export type AgentFrameErrorCode = AgentPublicErrorCode | "cancelled";

/** A typed failure raised while validating or reserving one complete call batch. */
export class AgentToolLoopFailure extends Error {
  readonly code: AgentFrameErrorCode;
  readonly budget?: string;
  readonly observed?: number;
  readonly limit?: number;

  constructor(
    code: AgentFrameErrorCode,
    message?: string,
    details?: { budget?: string; observed?: number; limit?: number },
  ) {
    super(message ?? code);
    this.name = "AgentToolLoopFailure";
    this.code = code;
    this.budget = details?.budget;
    this.observed = details?.observed;
    this.limit = details?.limit;
  }
}

export interface ToolLoopFrameOptions {
  readonly kind: AgentLoopFrameKind;
  readonly invocationId: string;
  readonly parentInvocationId?: string | null;
  readonly ledger: AgentTurnLedger;
  readonly adapterId?: AgentProviderAdapterId;
  readonly capabilities?: AgentAdapterCapabilities;
  readonly signal?: AbortSignal;
  readonly messages?: readonly LlmMessage[];
}

/**
 * Mutable invocation-local state. The shared ledger is deliberately the only
 * mutable object shared by root and child frames; messages, carriers, calls,
 * output, and round indices stay inside this instance.
 */
export class ToolLoopFrame implements AgentToolLoopFrameContract {
  readonly kind: AgentLoopFrameKind;
  readonly invocationId: string;
  readonly parentInvocationId: string | null;
  readonly ledger: AgentTurnLedger;
  readonly adapterId: AgentProviderAdapterId;
  readonly capabilities: AgentAdapterCapabilities;
  readonly signal: AbortSignal;

  #roundIndex = 0;
  #continuation: AgentContinuationCarrier | null = null;
  #pendingCalls: readonly AgentToolLoopFrameContract["pendingCalls"][number][] = [];
  #visibleOutput = "";
  #messages: LlmMessage[];

  constructor(options: ToolLoopFrameOptions) {
    this.kind = options.kind;
    this.invocationId = options.invocationId;
    this.parentInvocationId = options.parentInvocationId ?? null;
    this.ledger = options.ledger;
    this.adapterId = options.adapterId ?? "unknown";
    this.capabilities = Object.freeze({
      toolCalling: options.capabilities?.toolCalling === true,
      toolContinuationMode: options.capabilities?.toolContinuationMode ?? "unsupported",
      supportsToolFinalization: options.capabilities?.supportsToolFinalization === true,
      interleavedThinking: options.capabilities?.interleavedThinking === true,
    });
    const signals = [this.ledger.signal, options.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    this.signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    this.#messages = [...(options.messages ?? [])];
  }

  get roundIndex(): number {
    return this.#roundIndex;
  }

  get continuation(): AgentContinuationCarrier | null {
    return this.#continuation;
  }

  get pendingCalls(): readonly AgentToolLoopFrameContract["pendingCalls"][number][] {
    return this.#pendingCalls;
  }

  get visibleOutput(): string {
    return this.#visibleOutput;
  }

  /** The frame transcript is never exposed as a mutable array. */
  get messages(): readonly LlmMessage[] {
    return this.#messages;
  }

  setPendingCalls(calls: readonly AgentToolLoopFrameContract["pendingCalls"][number][]): void {
    this.#pendingCalls = calls.map((call) => ({ ...call }));
  }

  clearPendingCalls(): void {
    this.#pendingCalls = [];
  }

  appendVisibleOutput(text: string): void {
    if (text) this.#visibleOutput += text;
  }

  /** Replace the invocation transcript at a root boundary without sharing mutable state. */
  replaceMessages(messages: readonly LlmMessage[]): void {
    this.#messages = messages.map((message) => structuredClone(message));
  }

  appendMessages(messages: readonly LlmMessage[]): void {
    this.#messages.push(...messages.map((message) => structuredClone(message)));
  }

  advanceRound(): number {
    this.#roundIndex += 1;
    return this.#roundIndex;
  }

  setContinuation(carrier: AgentContinuationCarrier | null): void {
    this.#continuation = carrier
      ? Object.freeze({ ...carrier })
      : null;
  }

  abortIfNeeded(): void {
    if (this.signal.aborted || this.ledger.terminal !== null) {
      throw new AgentToolLoopFailure(
        this.ledger.failure?.code ?? "cancelled",
        "Tool loop cancelled",
      );
    }
  }
}

export type AgentToolLoopFrame = ToolLoopFrame;

export function createRootToolLoopFrame(
  options: Omit<ToolLoopFrameOptions, "kind">,
): ToolLoopFrame {
  return new ToolLoopFrame({ ...options, kind: "root" });
}

export function createChildToolLoopFrame(
  options: Omit<ToolLoopFrameOptions, "kind">,
): ToolLoopFrame {
  return new ToolLoopFrame({ ...options, kind: "child" });
}

export interface ToolCallSemanticError {
  readonly call: ToolCallResult;
  readonly code: AgentFrameErrorCode;
  readonly message: string;
}

export interface ToolCallBatchValidation {
  readonly calls: readonly ToolCallResult[];
  readonly semanticErrors: readonly ToolCallSemanticError[];
  readonly argumentBytes: ReadonlyMap<string, number>;
  readonly totalArgumentBytes: number;
  readonly protocolValid: true;
}

export interface ToolCallBatchValidationOptions {
  readonly definitions?: ReadonlyMap<string, ToolDefinition>;
  readonly authorizedToolIds?: readonly string[];
  readonly maxCalls?: number;
  readonly signal?: AbortSignal;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function schemaTypeMatches(value: unknown, type: unknown): boolean {
  if (typeof type !== "string") return true;
  if (type === "object") return isPlainRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

/** Small, bounded JSON-Schema subset used before any host side effect. */
function validateSchema(value: unknown, schema: unknown, path = "$", depth = 0): string | undefined {
  if (depth > AGENT_JSON_DEPTH_MAX) return `${path} exceeds schema depth`;
  if (!isPlainRecord(schema)) return undefined;
  const schemaType = schema.type;
  if (Array.isArray(schemaType)) {
    if (!schemaType.some((type) => schemaTypeMatches(value, type))) {
      return `${path} has an invalid type`;
    }
  } else if (!schemaTypeMatches(value, schemaType)) {
    return `${path} has an invalid type`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    return `${path} is not an allowed value`;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} is too short`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} is too long`;
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) return `${path} does not match the pattern`;
      } catch {
        return `${path} has an invalid pattern`;
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} is below minimum`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} is above maximum`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} has too few items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} has too many items`;
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateSchema(value[index], schema.items, `${path}[${index}]`, depth + 1);
        if (error) return error;
      }
    }
  }
  if (isPlainRecord(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) return `${path}.${key} is required`;
    }
    const properties = isPlainRecord(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(value)) {
      if (properties[key] !== undefined) {
        const error = validateSchema(child, properties[key], `${path}.${key}`, depth + 1);
        if (error) return error;
      } else if (schema.additionalProperties === false) {
        return `${path}.${key} is not allowed`;
      }
    }
  }
  return undefined;
}

function throwIfCancelled(signal: AbortSignal | undefined, ledger: AgentTurnLedger): void {
  if (signal?.aborted || ledger.signal.aborted || ledger.terminal !== null) {
    throw new AgentToolLoopFailure(ledger.failure?.code ?? "cancelled", "Tool batch cancelled");
  }
}

/**
 * Validate the complete provider batch before a single tool executor is called.
 * Invalid IDs are protocol failures; valid IDs with semantic errors are returned
 * together so callers can submit one correlated error for every ID in order.
 */
export function validateToolCallBatch(
  frame: ToolLoopFrame,
  calls: readonly ToolCallResult[],
  options: ToolCallBatchValidationOptions = {},
): ToolCallBatchValidation {
  throwIfCancelled(options.signal, frame.ledger);
  const maxCalls = options.maxCalls ?? AGENT_TOOL_BATCH_MAX_CALLS;
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new AgentToolLoopFailure("provider_protocol_error", "Provider returned an empty tool batch");
  }
  if (calls.length > maxCalls) {
    throw new AgentToolLoopFailure("provider_protocol_error", "Provider returned too many tool calls");
  }
  const seen = new Set<string>();
  const semanticErrors: ToolCallSemanticError[] = [];
  const argumentBytes = new Map<string, number>();
  let totalArgumentBytes = 0;
  for (const call of calls) {
    if (
      typeof call.call_id !== "string" ||
      call.call_id.trim().length === 0 ||
      utf8ByteLength(call.call_id) > AGENT_PROVIDER_CALL_ID_MAX_BYTES ||
      seen.has(call.call_id)
    ) {
      throw new AgentToolLoopFailure("provider_protocol_error", "Provider returned invalid or duplicate tool call IDs");
    }
    seen.add(call.call_id);
    if (typeof call.name !== "string" || call.name.trim().length === 0 || utf8ByteLength(call.name) > AGENT_PROVIDER_TOOL_NAME_MAX_BYTES) {
      throw new AgentToolLoopFailure("provider_protocol_error", "Provider returned an invalid tool name");
    }
    const observedArgumentBytes = boundedJsonValueBytes(call.args);
    let argumentError: AgentFrameErrorCode | undefined;
    let argumentMessage = "Tool arguments are invalid";
    try {
      const bounds = assertJsonValueBounds(call.args, {
        maxBytes: AGENT_ARGUMENT_MAX_BYTES,
        maxDepth: AGENT_JSON_DEPTH_MAX,
        maxNodes: AGENT_JSON_NODE_MAX,
      });
      if (!isPlainRecord(call.args)) {
        argumentError = "invalid_arguments";
      } else {
        argumentBytes.set(call.call_id, bounds.bytes);
        totalArgumentBytes += bounds.bytes;
      }
    } catch (error) {
      argumentError = "invalid_arguments";
      argumentMessage = error instanceof Error ? error.message : argumentMessage;
      argumentBytes.set(call.call_id, observedArgumentBytes);
      totalArgumentBytes += observedArgumentBytes;
    }
    const definition = options.definitions?.get(call.name);
    if (!definition) {
      semanticErrors.push({ call, code: "unknown_tool", message: "Tool is not in the authorized host catalog" });
    } else if (options.authorizedToolIds && !options.authorizedToolIds.includes(call.name)) {
      semanticErrors.push({ call, code: "unauthorized", message: "Tool is not authorized for this frame" });
    } else {
      const schemaError = validateSchema(call.args, definition.parameters);
      if (schemaError) semanticErrors.push({ call, code: "invalid_arguments", message: schemaError });
    }
    if (argumentError) semanticErrors.push({ call, code: argumentError, message: argumentMessage });
  }
  if (totalArgumentBytes > AGENT_AGGREGATE_TOOL_PAYLOAD_MAX_BYTES) {
    throw new AgentToolLoopFailure(
      "argument_limit_exceeded",
      "Tool argument payload exceeds the shared aggregate limit",
      { budget: "argument_bytes", observed: totalArgumentBytes, limit: AGENT_AGGREGATE_TOOL_PAYLOAD_MAX_BYTES },
    );
  }
  return Object.freeze({ calls: [...calls], semanticErrors, argumentBytes, totalArgumentBytes, protocolValid: true });
}

export interface ToolBatchReservationOptions {
  readonly mode?: AgentToolMode;
  readonly resultBytesPerCall?: number;
  /**
   * Explicit size of the complete assistant-call/result/carrier envelope.
   * When omitted, reserveToolCallBatch computes a conservative estimate from
   * the current frame, native calls, and every result envelope.
   */
  readonly continuationBytes?: number;
  readonly acquireToolPermits?: boolean;
}

export interface ToolBatchReservation {
  readonly logical: AgentLedgerReservation;
  readonly physical: AgentLedgerReservation;
  readonly callAttempts: AgentLedgerReservation;
  readonly argument: AgentLedgerReservation;
  readonly continuation: AgentLedgerReservation;
  readonly results: readonly AgentLedgerReservation[];
  readonly providerPermit: AgentAdmissionPermit | null;
  readonly toolPermits: readonly AgentAdmissionPermit[];
  readonly mode: AgentToolMode;
  consume(): void;
  consumeDispatch(): void;
  consumeCallAttempts(): void;
  consumeArgument(): void;
  /** Release only the provider-dispatch admission permit. */
  releaseDispatch(): void;
  /** Release one sibling's operation permit when that sibling settles. */
  releaseToolPermit(index: number): void;
  /** Release every still-held tool permit. */
  releaseToolPermits(): void;
  /** Release every still-reserved envelope and operation permit. */
  release(): void;
  /** The bounded result envelope assigned to one provider call. */
  resultCapacity(index: number): number;
  settleResult(index: number, bytes: number): boolean;
  settleContinuation(bytes: number): boolean;
}

function releaseReservations(reservations: readonly AgentLedgerReservation[]): void {
  for (const reservation of reservations) reservation.release();
}


/**
 * Atomically reserve every next-continuation and side-effect capacity before
 * execution. Any failed reservation/permit acquisition rolls the whole bundle
 * back, leaving the caller free to emit correlated errors without side effects.
 */
export function reserveToolCallBatch(
  frame: ToolLoopFrame,
  validation: ToolCallBatchValidation,
  options: ToolBatchReservationOptions = {},
): ToolBatchReservation | null {
  throwIfCancelled(frame.signal, frame.ledger);
  const calls = validation.calls;
  const mode = options.mode ?? "ordinary";
  const resultRemaining = frame.ledger.remaining("result_bytes");
  const resultBytesPerCall = Math.max(
    512,
    Math.min(
      AGENT_RESULT_MAX_BYTES,
      options.resultBytesPerCall ?? Math.floor(resultRemaining / calls.length),
    ),
  );
  const estimatedContinuationBytes =
    options.continuationBytes ??
    estimateContinuationBytes(frame, calls, resultBytesPerCall);
  if (
    !Number.isSafeInteger(estimatedContinuationBytes) ||
    estimatedContinuationBytes < 1 ||
    estimatedContinuationBytes > AGENT_CONTINUATION_FRAME_MAX_BYTES
  ) {
    throw new AgentToolLoopFailure(
      "continuation_limit_exceeded",
      "Continuation envelope exceeds its host bound",
      {
        budget: "continuation_bytes",
        observed: estimatedContinuationBytes,
        limit: AGENT_CONTINUATION_FRAME_MAX_BYTES,
      },
    );
  }
  const continuationBytes = estimatedContinuationBytes;
  const reservations: AgentLedgerReservation[] = [];
  let providerPermit: AgentAdmissionPermit | null = null;
  const toolPermits: AgentAdmissionPermit[] = [];
  const toolPermitReleased: boolean[] = [];
  let providerPermitReleased = false;
  let reservationsReleased = false;
  const rollback = (): null => {
    releaseReservations(reservations);
    if (providerPermit) frame.ledger.releaseOperationPermit(providerPermit);
    for (const permit of toolPermits) frame.ledger.releaseOperationPermit(permit);
    providerPermit = null;
    toolPermits.length = 0;
    toolPermitReleased.length = 0;
    return null;
  };
  try {
    const dispatch = frame.ledger.reserveProviderDispatch();
    if (!dispatch) return rollback();
    reservations.push(dispatch.logical, dispatch.physical);
    const callAttempts = frame.ledger.reserve("aggregate_tool_calls", calls.length);
    if (!callAttempts) return rollback();
    reservations.push(callAttempts);
    const argument = frame.ledger.reserve("argument_bytes", Math.max(1, validation.totalArgumentBytes));
    if (!argument) return rollback();
    reservations.push(argument);
    const continuation = frame.ledger.reserve("continuation_bytes", continuationBytes);
    if (!continuation) return rollback();
    reservations.push(continuation);
    const results: AgentLedgerReservation[] = [];
    for (let index = 0; index < calls.length; index += 1) {
      const result = frame.ledger.reserve("result_bytes", resultBytesPerCall);
      if (!result) return rollback();
      results.push(result);
      reservations.push(result);
    }
    providerPermit = frame.ledger.acquireProviderPermit();
    if (!providerPermit) return rollback();
    if (options.acquireToolPermits !== false && validation.semanticErrors.length === 0) {
      for (let index = 0; index < calls.length; index += 1) {
        const permit = frame.ledger.acquireToolPermit();
        if (!permit) return rollback();
        toolPermits.push(permit);
        toolPermitReleased.push(false);
      }
    }
    return {
      logical: reservations[0]!,
      physical: reservations[1]!,
      callAttempts,
      argument,
      continuation,
      results,
      providerPermit,
      toolPermits,
      mode,
      consume(): void {
        for (const reservation of reservations) reservation.consume();
      },
      consumeDispatch(): void {
        reservations[0]?.consume();
        reservations[1]?.consume();
      },
      consumeCallAttempts(): void {
        callAttempts.consume();
      },
      consumeArgument(): void {
        argument.consume();
      },
      releaseDispatch(): void {
        if (providerPermitReleased) return;
        providerPermitReleased = true;
        if (providerPermit) frame.ledger.releaseOperationPermit(providerPermit);
      },
      releaseToolPermit(index: number): void {
        if (index < 0 || index >= toolPermits.length || toolPermitReleased[index]) return;
        toolPermitReleased[index] = true;
        frame.ledger.releaseOperationPermit(toolPermits[index]!);
      },
      releaseToolPermits(): void {
        for (let index = 0; index < toolPermits.length; index += 1) {
          this.releaseToolPermit(index);
        }
      },
      release(): void {
        if (!reservationsReleased) {
          reservationsReleased = true;
          releaseReservations(reservations);
        }
        this.releaseDispatch();
        this.releaseToolPermits();
      },
      resultCapacity(index: number): number {
        return results[index]?.amount ?? 0;
      },
      settleResult(index: number, bytes: number): boolean {
        const reservation = results[index];
        return reservation ? frame.ledger.settleReservation(reservation, Math.max(0, bytes)) : false;
      },
      settleContinuation(bytes: number): boolean {
        return frame.ledger.settleReservation(continuation!, Math.max(0, bytes));
      },
    };
  } catch (error) {
    rollback();
    throw error;
  }
}

function estimateContinuationBytes(
  frame: ToolLoopFrame,
  calls: readonly ToolCallResult[],
  resultBytesPerCall: number,
): number {
  try {
    /**
     * Include the existing transcript, the complete provider call envelope,
     * every assigned result envelope, and fixed assistant/carrier framing.
     * The result allocation is deliberately part of this reservation: a
     * result may not discover an unreserved continuation overflow after the
     * corresponding side effect has run.
     */
    const transcriptBytes = utf8ByteLength(JSON.stringify(frame.messages));
    const callBytes = utf8ByteLength(JSON.stringify(calls));
    const resultEnvelopeBytes = resultBytesPerCall * calls.length;
    const assistantAndCarrierBytes = 2048 + 1024 * calls.length;
    return Math.max(
      1,
      transcriptBytes + callBytes + resultEnvelopeBytes + assistantAndCarrierBytes,
    );
  } catch {
    return AGENT_CONTINUATION_FRAME_MAX_BYTES + 1;
  }
}


export function consumeFrameContinuation(
  frame: ToolLoopFrame,
  reservation: ToolBatchReservation,
  messages: readonly LlmMessage[],
  carrier: AgentContinuationCarrier | null,
  visibleOutput?: string,
): void {
  throwIfCancelled(frame.signal, frame.ledger);
  const bytes = utf8ByteLength(JSON.stringify(messages));
  if (!reservation.settleContinuation(bytes)) {
    reservation.release();
    throw new AgentToolLoopFailure("continuation_limit_exceeded", "Continuation envelope exceeds its reservation");
  }
  frame.appendMessages(messages);
  frame.setContinuation(carrier);
  if (visibleOutput) frame.appendVisibleOutput(visibleOutput);
  frame.advanceRound();
  reservation.continuation.consume();
}

/** Build the adapter-mode context consumed by provider wrappers. */
export function frameRequestContext(
  frame: ToolLoopFrame,
  mode: AgentToolMode,
  policy: AgentToolModePolicy,
): AgentAdapterRequestContext {
  return Object.freeze({ frame, mode, policy });
}

/** Stable no-tool policy used for exhausted-budget finalization requests. */
export function finalizationPolicy(): AgentToolModePolicy {
  return Object.freeze({
    mode: "finalization",
    allowedToolIds: Object.freeze([]),
    toolChoice: "none",
    parallelToolCalls: false,
  });
}

/** Convert a native response into the bounded frame carrier metadata. */
export function carrierFor(
  kind: AgentContinuationCarrier["kind"],
  value: unknown,
): AgentContinuationCarrier {
  let byteLength = 0;
  let itemCount = 0;
  try {
    const serialized = JSON.stringify(value);
    byteLength = utf8ByteLength(serialized);
    itemCount = Array.isArray(value) ? value.length : 1;
  } catch {
    throw new AgentToolLoopFailure("provider_protocol_error", "Provider continuation carrier is not serializable");
  }
  if (byteLength > AGENT_CONTINUATION_FRAME_MAX_BYTES) {
    throw new AgentToolLoopFailure("continuation_limit_exceeded", "Provider continuation carrier is too large", {
      budget: "continuation_bytes",
      observed: byteLength,
      limit: AGENT_CONTINUATION_FRAME_MAX_BYTES,
    });
  }
  return Object.freeze({ kind, byteLength, itemCount });
}
