/**
 * Versioned, length-prefixed protocol shared by strict preprocessing isolates.
 *
 * The length is deliberately validated before a payload buffer is allocated.
 * Isolate stdin/stdout is not a trusted transport: a malformed peer must be
 * treated as a terminal protocol failure, never as an inline-fallback signal.
 */

export const ISOLATE_PROTOCOL_VERSION_V1 = 1 as const;
export const ISOLATE_FRAME_HEADER_BYTES = 4;
export const DEFAULT_ISOLATE_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export type IsolateProtocolFailureCode =
  | "invalid_frame"
  | "frame_too_large"
  | "truncated_frame"
  | "malformed_message";

export class IsolateProtocolError extends Error {
  readonly code: IsolateProtocolFailureCode;

  constructor(code: IsolateProtocolFailureCode, message: string) {
    super(message);
    this.name = "IsolateProtocolError";
    this.code = code;
  }
}

export interface IsolateRequestEnvelopeV1<T = unknown> {
  readonly version: typeof ISOLATE_PROTOCOL_VERSION_V1;
  readonly type: "request";
  readonly requestId: string;
  readonly operation: string;
  readonly payload: T;
}

export interface IsolateStartedEnvelopeV1 {
  readonly version: typeof ISOLATE_PROTOCOL_VERSION_V1;
  readonly type: "started";
  readonly requestId: string;
}

export interface IsolateSuccessEnvelopeV1<T = unknown> {
  readonly version: typeof ISOLATE_PROTOCOL_VERSION_V1;
  readonly type: "result";
  readonly requestId: string;
  readonly result: T;
}

export interface IsolateErrorEnvelopeV1 {
  readonly version: typeof ISOLATE_PROTOCOL_VERSION_V1;
  readonly type: "error";
  readonly requestId: string;
  readonly error: string;
  readonly name?: string;
  readonly stack?: string;
  readonly code?: string;
}

export type IsolateResponseEnvelopeV1<T = unknown> =
  | IsolateSuccessEnvelopeV1<T>
  | IsolateErrorEnvelopeV1;

type IsolateFrameInput = Uint8Array | ArrayBuffer | ArrayLike<number>;

function arrayLikeLength(value: ArrayLike<number>): number {
  let rawLength: unknown;
  try {
    rawLength = value.length;
  } catch (error) {
    throw new IsolateProtocolError(
      "invalid_frame",
      `Isolate frame length is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Number.isSafeInteger(rawLength) || Number(rawLength) < 0) {
    throw new IsolateProtocolError("invalid_frame", "Isolate frame length is not a non-negative safe integer");
  }
  return Number(rawLength);
}

/**
 * Normalize bytes without allowing an ArrayLike input to trigger an
 * unbounded Uint8Array.from() allocation. Callers that already have a typed
 * byte input are deliberately kept zero-copy.
 */
function asBytes(
  value: IsolateFrameInput,
  maxInputBytes: number = DEFAULT_ISOLATE_MAX_FRAME_BYTES + ISOLATE_FRAME_HEADER_BYTES,
): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  const length = arrayLikeLength(value);
  if (length > maxInputBytes) {
    throw new IsolateProtocolError(
      "frame_too_large",
      `Isolate frame input is ${length} bytes; maximum is ${maxInputBytes} bytes`,
    );
  }
  return Uint8Array.from(value);
}

/**
 * Normalize a host-supplied frame ceiling. The protocol default is an
 * immutable upper bound; callers may lower it for a pool or test, never raise
 * it.
 */
export function normalizeIsolateMaxFrameBytes(value: unknown = DEFAULT_ISOLATE_MAX_FRAME_BYTES): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new RangeError("maxFrameBytes must be a positive integer");
  }
  return Math.min(Number(value), DEFAULT_ISOLATE_MAX_FRAME_BYTES);
}

/**
 * Encode one UTF-8 JSON message with a big-endian uint32 byte length prefix.
 */
export function encodeLengthPrefixedJson(
  value: unknown,
  maxFrameBytes: number = DEFAULT_ISOLATE_MAX_FRAME_BYTES,
): Uint8Array {
  const normalizedMaxFrameBytes = normalizeIsolateMaxFrameBytes(maxFrameBytes);
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new IsolateProtocolError(
      "malformed_message",
      `Isolate message is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof json !== "string") {
    throw new IsolateProtocolError("malformed_message", "Isolate message is not JSON serializable");
  }
  const payload = new TextEncoder().encode(json);
  if (payload.byteLength > normalizedMaxFrameBytes) {
    throw new IsolateProtocolError(
      "frame_too_large",
      `Isolate frame is ${payload.byteLength} bytes; maximum is ${normalizedMaxFrameBytes} bytes`,
    );
  }

  const frame = new Uint8Array(ISOLATE_FRAME_HEADER_BYTES + payload.byteLength);
  new DataView(frame.buffer, frame.byteOffset, ISOLATE_FRAME_HEADER_BYTES).setUint32(
    0,
    payload.byteLength,
    false,
  );
  frame.set(payload, ISOLATE_FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Validate a complete encoded frame without parsing or allocating its JSON
 * payload. This is used by both transports after a caller has already done a
 * serialization preflight.
 */
export function validateEncodedFrame(
  frame: Uint8Array | ArrayBuffer | ArrayLike<number>,
  maxFrameBytes: number = DEFAULT_ISOLATE_MAX_FRAME_BYTES,
): Uint8Array {
  const normalizedMaxFrameBytes = normalizeIsolateMaxFrameBytes(maxFrameBytes);
  const bytes = asBytes(frame, normalizedMaxFrameBytes + ISOLATE_FRAME_HEADER_BYTES);
  const payloadBytes = readFrameLength(bytes, normalizedMaxFrameBytes);
  const expectedBytes = ISOLATE_FRAME_HEADER_BYTES + payloadBytes;
  if (bytes.byteLength < expectedBytes) {
    throw new IsolateProtocolError("truncated_frame", "Isolate frame payload is incomplete");
  }
  if (bytes.byteLength !== expectedBytes) {
    throw new IsolateProtocolError("invalid_frame", "Isolate frame contains trailing bytes");
  }
  return bytes;
}

/**
 * Decode one complete encoded frame. The length and exact frame boundary are
 * checked before JSON parsing, so malformed or oversized output never reaches
 * a response parser.
 */
export function decodeLengthPrefixedJson<T = unknown>(
  frame: Uint8Array | ArrayBuffer | ArrayLike<number>,
  maxFrameBytes: number = DEFAULT_ISOLATE_MAX_FRAME_BYTES,
): T {
  const bytes = validateEncodedFrame(frame, maxFrameBytes);
  const payloadBytes = readFrameLength(bytes, maxFrameBytes);
  return decodeJsonFrame<T>(bytes.subarray(ISOLATE_FRAME_HEADER_BYTES, ISOLATE_FRAME_HEADER_BYTES + payloadBytes));
}

/**
 * Accept a pre-serialized frame or perform the one serialization preflight
 * required by a direct transport caller.
 */
export function preflightEncodedFrame(
  value: unknown,
  maxFrameBytes: number = DEFAULT_ISOLATE_MAX_FRAME_BYTES,
): Uint8Array {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return validateEncodedFrame(value, maxFrameBytes);
  }
  return encodeLengthPrefixedJson(value, maxFrameBytes);
}

/**
 * Read and validate a frame length without allocating a payload buffer.
 */
export function readFrameLength(
  header: Uint8Array | ArrayBuffer | ArrayLike<number>,
  maxFrameBytes: number = DEFAULT_ISOLATE_MAX_FRAME_BYTES,
): number {
  const normalizedMaxFrameBytes = normalizeIsolateMaxFrameBytes(maxFrameBytes);
  const bytes = asBytes(header, normalizedMaxFrameBytes + ISOLATE_FRAME_HEADER_BYTES);
  if (bytes.byteLength < ISOLATE_FRAME_HEADER_BYTES) {
    throw new IsolateProtocolError("invalid_frame", "Isolate frame prefix is incomplete");
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, ISOLATE_FRAME_HEADER_BYTES).getUint32(0, false);
  if (length === 0) {
    throw new IsolateProtocolError("invalid_frame", "Isolate frame length must be positive");
  }
  if (length > normalizedMaxFrameBytes) {
    throw new IsolateProtocolError(
      "frame_too_large",
      `Isolate frame length ${length} exceeds maximum ${normalizedMaxFrameBytes}`,
    );
  }
  return length;
}

/**
 * Incremental decoder used by Bun subprocess stdout. Chunks are retained only
 * until a validated frame is complete. A hostile length prefix is rejected
 * before `new Uint8Array(length)` can occur.
 */
export class LengthPrefixedFrameDecoder {
  private readonly maxFrameBytes: number;
  private header = new Uint8Array(ISOLATE_FRAME_HEADER_BYTES);
  private headerBytes = 0;
  private payload: Uint8Array | null = null;
  private payloadBytes = 0;
  private expectedPayloadBytes = 0;
  constructor(maxFrameBytes: number = DEFAULT_ISOLATE_MAX_FRAME_BYTES) {
    this.maxFrameBytes = normalizeIsolateMaxFrameBytes(maxFrameBytes);
  }

  push(chunk: Uint8Array | ArrayBuffer | ArrayLike<number>): Uint8Array[] {
    const bytes = asBytes(chunk, this.maxFrameBytes + ISOLATE_FRAME_HEADER_BYTES);
    const frames: Uint8Array[] = [];
    let offset = 0;

    while (offset < bytes.byteLength) {
      if (this.expectedPayloadBytes === 0) {
        const copied = Math.min(ISOLATE_FRAME_HEADER_BYTES - this.headerBytes, bytes.byteLength - offset);
        this.header.set(bytes.subarray(offset, offset + copied), this.headerBytes);
        this.headerBytes += copied;
        offset += copied;
        if (this.headerBytes < ISOLATE_FRAME_HEADER_BYTES) continue;

        // readFrameLength is the only place that validates the attacker-controlled
        // length. Allocation happens only after it returns.
        this.expectedPayloadBytes = readFrameLength(this.header, this.maxFrameBytes);
        this.payload = new Uint8Array(this.expectedPayloadBytes);
        this.payloadBytes = 0;
        this.headerBytes = 0;
      }

      const payload = this.payload;
      if (!payload) {
        throw new IsolateProtocolError("invalid_frame", "Isolate decoder entered an invalid state");
      }
      const copied = Math.min(this.expectedPayloadBytes - this.payloadBytes, bytes.byteLength - offset);
      payload.set(bytes.subarray(offset, offset + copied), this.payloadBytes);
      this.payloadBytes += copied;
      offset += copied;

      if (this.payloadBytes === this.expectedPayloadBytes) {
        frames.push(payload);
        this.payload = null;
        this.payloadBytes = 0;
        this.expectedPayloadBytes = 0;
      }
    }

    return frames;
  }

  finish(): void {
    if (this.headerBytes !== 0 || this.expectedPayloadBytes !== 0 || this.payloadBytes !== 0) {
      throw new IsolateProtocolError("truncated_frame", "Isolate stream ended in the middle of a frame");
    }
  }
}

export function decodeJsonFrame<T = unknown>(payload: Uint8Array): T {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    return JSON.parse(text) as T;
  } catch (error) {
    throw new IsolateProtocolError(
      "malformed_message",
      `Isolate frame is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function isIsolateRequestEnvelopeV1(value: unknown): value is IsolateRequestEnvelopeV1 {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    item.version === ISOLATE_PROTOCOL_VERSION_V1
    && item.type === "request"
    && typeof item.requestId === "string"
    && item.requestId.length > 0
    && item.requestId.length <= 128
    && typeof item.operation === "string"
    && item.operation.length > 0
    && item.operation.length <= 128
    && "payload" in item
  );
}

export function isIsolateStartedEnvelopeV1(value: unknown): value is IsolateStartedEnvelopeV1 {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    item.version === ISOLATE_PROTOCOL_VERSION_V1
    && item.type === "started"
    && typeof item.requestId === "string"
    && item.requestId.length > 0
    && item.requestId.length <= 128
  );
}

export function isIsolateResponseEnvelopeV1(value: unknown): value is IsolateResponseEnvelopeV1 {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (
    item.version !== ISOLATE_PROTOCOL_VERSION_V1
    || (item.type !== "result" && item.type !== "error")
    || typeof item.requestId !== "string"
    || item.requestId.length === 0
    || item.requestId.length > 128
  ) {
    return false;
  }
  if (item.type === "error") return typeof item.error === "string" && item.error.length <= 8_192;
  return "result" in item;
}

export function makeRequestEnvelopeV1<T>(
  requestId: string,
  operation: string,
  payload: T,
): IsolateRequestEnvelopeV1<T> {
  if (!requestId || requestId.length > 128 || !operation || operation.length > 128) {
    throw new IsolateProtocolError("malformed_message", "Invalid isolate request identity");
  }
  return {
    version: ISOLATE_PROTOCOL_VERSION_V1,
    type: "request",
    requestId,
    operation,
    payload,
  };
}

export function makeStartedEnvelopeV1(requestId: string): IsolateStartedEnvelopeV1 {
  if (!requestId || requestId.length > 128) {
    throw new IsolateProtocolError("malformed_message", "Invalid isolate request identity");
  }
  return {
    version: ISOLATE_PROTOCOL_VERSION_V1,
    type: "started",
    requestId,
  };
}

export function makeResultEnvelopeV1<T>(
  requestId: string,
  result: T,
): IsolateSuccessEnvelopeV1<T> {
  return {
    version: ISOLATE_PROTOCOL_VERSION_V1,
    type: "result",
    requestId,
    result,
  };
}

export function makeErrorEnvelopeV1(
  requestId: string,
  error: unknown,
  code?: string,
): IsolateErrorEnvelopeV1 {
  const message = error instanceof Error ? error.message : String(error);
  const item: IsolateErrorEnvelopeV1 = {
    version: ISOLATE_PROTOCOL_VERSION_V1,
    type: "error",
    requestId,
    error: message.slice(0, 8_192),
    name: error instanceof Error ? error.name : undefined,
    stack: error instanceof Error ? error.stack?.slice(0, 16_384) : undefined,
    code,
  };
  return item;
}
export const encodeFrame = encodeLengthPrefixedJson;
export const decodeFrame = decodeJsonFrame;
