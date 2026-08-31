import { AGENT_ARGUMENT_MAX_BYTES, AGENT_CONTINUATION_FRAME_MAX_BYTES } from "../services/agent-runtime-accounting";

// Workaround for Bun v1.3.x on Windows: passing the user AbortSignal directly
// to a streaming fetch and letting Bun cancel the resulting ReadableStream
// mid-read can trigger an internal assertion failure on the main thread,
// crashing the process. Streaming providers therefore use a short-lived fetch
// signal only until response headers arrive, then handle mid-stream aborts in
// user-space through readWithAbort() and reader.cancel().
//
// However, reader.cancel() alone does NOT close the underlying HTTP connection
// in Bun — the upstream server never sees a disconnect and keeps generating
// into the void (a local llama.cpp/LM Studio keeps burning GPU and blocks its
// single slot; metered APIs keep billing). Each response's internal controller
// is therefore retained so closeConnection() can force the socket shut AFTER
// the body stream has been cancelled. Aborting post-cancel avoids the mid-read
// cancellation path that crashes Bun on Windows.
const responseConnections = new WeakMap<Response, AbortController>();

/** Force-close the HTTP connection behind a fetchWithPreflightAbort response.
 *  Call only after reader.cancel() has settled (or when no read is pending) —
 *  aborting with a read in flight is the crash path the preflight pattern
 *  exists to avoid. No-op for responses not created by fetchWithPreflightAbort. */
export function closeConnection(res: Response): void {
  responseConnections.get(res)?.abort(new DOMException("Aborted", "AbortError"));
}

/** Standard mid-stream teardown: gracefully cancel the body reader, then close
 *  the connection so the upstream server actually stops generating. */
export async function cancelStreamAndCloseConnection(
  reader: ReadableStreamDefaultReader<unknown>,
  res: Response,
): Promise<void> {
  await reader.cancel().catch(() => {});
  closeConnection(res);
}

export async function fetchWithPreflightAbort(
  input: RequestInfo | URL,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<Response> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  const controller = new AbortController();
  const onAbort = () => {
    controller.abort(signal!.reason ?? new DOMException("Aborted", "AbortError"));
  };

  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    responseConnections.set(res, controller);
    return res;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function readWithAbort<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal | undefined
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>> {
  if (!signal) return reader.read();
  if (signal.aborted) return { done: true, value: undefined };
  return new Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      resolve({ done: true, value: undefined });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (err) => {
        cleanup();
        if (signal.aborted) {
          resolve({ done: true, value: undefined });
        } else {
          reject(err);
        }
      }
    );
  });
}

export const PROVIDER_STREAM_LIMITS = Object.freeze({
  maxLineBytes: 64 * 1024,
  maxEventBytes: 256 * 1024,
  maxBufferBytes: 1 * 1024 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  maxToolDeltaBytes: 64 * 1024,
  maxArgumentsBytes: AGENT_ARGUMENT_MAX_BYTES,
  maxCalls: 64,
  maxEvents: 16_384,
});

type ProviderStreamLimitName = keyof typeof PROVIDER_STREAM_LIMITS;

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

/**
 * Resolve an untrusted caller-provided receive bound without ever widening the
 * immutable provider wire ceiling. Undefined selects the host default; a
 * smaller valid bound remains unchanged, while a larger valid bound is
 * clamped to the corresponding host limit.
 */
export function normalizeProviderReceiveLimit(
  value: number | undefined,
  name = "receiveLimitBytes",
): number {
  if (value === undefined) return PROVIDER_STREAM_LIMITS.maxResponseBytes;
  return Math.min(
    positiveSafeInteger(value, name),
    PROVIDER_STREAM_LIMITS.maxResponseBytes,
  );
}

function normalizeProviderStreamLimit<K extends ProviderStreamLimitName>(
  name: K,
  value: number | undefined,
): number {
  const hostLimit = PROVIDER_STREAM_LIMITS[name];
  if (value === undefined) return hostLimit;
  return Math.min(positiveSafeInteger(value, name), hostLimit);
}

export type ProviderWireErrorCode =
  | "provider_protocol_error"
  | "provider_response_too_large";

/** A provider response violated the bounded wire contract. */
export class ProviderProtocolError extends Error {
  readonly code = "provider_protocol_error" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderProtocolError";
  }
}

/** A provider response exceeded an incremental receive-boundary cap. */
export class ProviderResponseTooLargeError extends Error {
  readonly code = "provider_response_too_large" as const;
  readonly limit: number;
  readonly observed: number;

  constructor(message: string, limit: number, observed: number) {
    super(message);
    this.name = "ProviderResponseTooLargeError";
    this.limit = limit;
    this.observed = observed;
  }
}

export interface BoundedSseEvent {
  /** Complete event data after concatenating all `data:` fields with `\n`. */
  data: string;
  /** Optional standard SSE event name. */
  event?: string;
  /** Optional standard SSE event id. */
  id?: string;
  /** Optional standard SSE retry value in milliseconds. */
  retry?: number;
}

export interface BoundedSseReaderOptions {
  maxLineBytes?: number;
  maxEventBytes?: number;
  maxBufferBytes?: number;
  maxResponseBytes?: number;
  maxEvents?: number;
  /** Protocols using the OpenAI wire terminate with this literal marker. */
  terminalMarker?: string;
  /** Require an adapter-provided terminal event before natural EOF. */
  requireTerminal?: boolean;
  /**
   * Compatibility mode for providers whose historical adapter accepted one
   * complete event per `data:` line even when the blank SSE separator was
   * omitted. Multi-line SSE data frames remain the default.
   */
  singleDataLineEvents?: boolean;
}

export function normalizeProviderStreamLimits(
  options: BoundedSseReaderOptions = {},
): Pick<
  Required<BoundedSseReaderOptions>,
  "maxLineBytes" | "maxEventBytes" | "maxBufferBytes" | "maxResponseBytes" | "maxEvents"
> {
  return {
    maxLineBytes: normalizeProviderStreamLimit("maxLineBytes", options.maxLineBytes),
    maxEventBytes: normalizeProviderStreamLimit("maxEventBytes", options.maxEventBytes),
    maxBufferBytes: normalizeProviderStreamLimit("maxBufferBytes", options.maxBufferBytes),
    maxResponseBytes: normalizeProviderReceiveLimit(options.maxResponseBytes, "maxResponseBytes"),
    maxEvents: normalizeProviderStreamLimit("maxEvents", options.maxEvents),
  };
}

/**
 * One bounded reader for all provider SSE responses.
 *
 * The parser follows the SSE field grammar: comments are ignored, fields are
 * accumulated until a blank line, and consecutive `data:` fields are joined
 * with a single newline. Every line, event, response, and event count is
 * bounded before decoding or yielding. A final event may omit its terminating
 * blank line; EOF commits that pending frame through the same event/cap checks.
 */
export class BoundedSseReader implements AsyncIterable<BoundedSseEvent> {
  private terminalSeen = false;
  private iterated = false;
  private readonly options: Required<BoundedSseReaderOptions>;

  constructor(
    private readonly response: Response,
    private readonly signal?: AbortSignal,
    options: BoundedSseReaderOptions = {},
  ) {
    const { maxLineBytes, maxEventBytes, maxBufferBytes, maxResponseBytes, maxEvents } =
      normalizeProviderStreamLimits(options);
    this.options = {
      maxLineBytes,
      maxEventBytes,
      maxBufferBytes,
      maxResponseBytes,
      maxEvents,
      terminalMarker: options.terminalMarker ?? "",
      requireTerminal: options.requireTerminal ?? true,
      singleDataLineEvents: options.singleDataLineEvents ?? false,
    };
  }

  markTerminal(): void {
    if (this.terminalSeen) {
      throw new ProviderProtocolError("Duplicate provider stream terminal marker");
    }
    this.terminalSeen = true;
  }

  get isTerminal(): boolean {
    return this.terminalSeen;
  }

  [Symbol.asyncIterator](): AsyncIterator<BoundedSseEvent> {
    if (this.iterated) {
      throw new ProviderProtocolError("Provider stream reader can only be consumed once");
    }
    this.iterated = true;
    return this.read();
  }

  private async *read(): AsyncGenerator<BoundedSseEvent, void, unknown> {
    if (!this.response.body) {
      throw new ProviderProtocolError("Provider stream response has no body");
    }

    const reader = this.response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const encoder = new TextEncoder();
    const lineBytes = new Uint8Array(this.options.maxLineBytes);
    let lineLength = 0;
    let responseBytes = 0;
    let eventCount = 0;
    let readToEnd = false;
    let skipLfAfterCr = false;
    let dataLines: string[] = [];
    let dataBytes = 0;
    let frameBytes = 0;
    let eventName: string | undefined;
    let eventId: string | undefined;
    let retry: number | undefined;
    let frameHasFields = false;

    const resetFrame = () => {
      dataLines = [];
      dataBytes = 0;
      frameBytes = 0;
      eventName = undefined;
      eventId = undefined;
      retry = undefined;
      frameHasFields = false;
    };

    const fieldBytes = (value: string): number => encoder.encode(value).byteLength;
    const checkFrameBytes = (additional: number) => {
      const observed = frameBytes + additional;
      if (observed > this.options.maxBufferBytes) {
        throw new ProviderResponseTooLargeError(
          `Provider SSE frame exceeded ${this.options.maxBufferBytes} bytes`,
          this.options.maxBufferBytes,
          observed,
        );
      }
      frameBytes = observed;
    };
    const emitFrame = (): BoundedSseEvent | undefined => {
      if (!frameHasFields) return undefined;
      if (dataLines.length === 0) {
        resetFrame();
        return undefined;
      }
      const data = dataLines.join("\n");
      if (this.terminalSeen) {
        throw new ProviderProtocolError("Provider emitted data after its terminal marker");
      }
      if (this.options.terminalMarker && data === this.options.terminalMarker) {
        this.terminalSeen = true;
      }
      eventCount += 1;
      if (eventCount > this.options.maxEvents) {
        throw new ProviderResponseTooLargeError(
          `Provider SSE event count exceeded ${this.options.maxEvents}`,
          this.options.maxEvents,
          eventCount,
        );
      }
      const event: BoundedSseEvent = {
        data,
        ...(eventName !== undefined ? { event: eventName } : {}),
        ...(eventId !== undefined ? { id: eventId } : {}),
        ...(retry !== undefined ? { retry } : {}),
      };
      resetFrame();
      return event;
    };

    const consumeLine = (): BoundedSseEvent | undefined => {
      let contentLength = lineLength;
      if (contentLength > 0 && lineBytes[contentLength - 1] === 0x0d) {
        contentLength -= 1;
      }
      const line = decoder.decode(lineBytes.subarray(0, contentLength));
      lineLength = 0;

      if (line.length === 0) return emitFrame();

      frameHasFields = true;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const hasDelimiter = colon >= 0;
      const rawValue = colon < 0 ? "" : line.slice(colon + 1);
      const hasValueSpace = rawValue.startsWith(" ");
      const value = hasValueSpace ? rawValue.slice(1) : rawValue;

      // Charge the complete parsed field before accepting or ignoring it:
      // unknown fields and retry metadata still consume frame memory. Include
      // both the colon and optional SSE separator space in the delimiter.
      const fieldWireBytes =
        fieldBytes(field) +
        (hasDelimiter ? 1 : 0) +
        (hasValueSpace ? 1 : 0) +
        fieldBytes(value) +
        (field === "data" && dataLines.length > 0 ? 1 : 0);
      checkFrameBytes(fieldWireBytes);

      // The SSE standard permits unknown fields; adapters only consume the
      // allowlisted fields below. Comments are charged above and ignored.
      if (field.length === 0 && line.startsWith(":")) return undefined;
      switch (field) {
        case "data": {
          const valueBytes = fieldBytes(value);
          const nextBytes = dataBytes + valueBytes + (dataLines.length > 0 ? 1 : 0);
          if (nextBytes > this.options.maxEventBytes) {
            throw new ProviderResponseTooLargeError(
              `Provider SSE event exceeded ${this.options.maxEventBytes} bytes`,
              this.options.maxEventBytes,
              nextBytes,
            );
          }
          dataBytes = nextBytes;
          dataLines.push(value);
          if (this.options.singleDataLineEvents) return emitFrame();
          break;
        }
        case "event":
          eventName = value;
          break;
        case "id":
          eventId = value;
          break;
        case "retry": {
          if (!/^[0-9]+$/.test(value)) {
            throw new ProviderProtocolError("Provider SSE retry field is invalid");
          }
          const parsed = Number(value);
          if (!Number.isSafeInteger(parsed)) {
            throw new ProviderResponseTooLargeError(
              "Provider SSE retry field exceeded its bounded value",
              Number.MAX_SAFE_INTEGER,
              parsed,
            );
          }
          retry = parsed;
          break;
        }
        default:
          break;
      }
      return undefined;
    };

    try {
      while (true) {
        const { done, value } = await readWithAbort(reader, this.signal);
        if (this.signal?.aborted) {
          throw this.signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        if (done) {
          // SSE permits the final event to end at EOF without the blank line
          // that normally dispatches it. Feed both the last unterminated line
          // and the pending frame through consumeLine so byte/event/terminal
          // accounting is identical to a normally terminated event.
          if (lineLength > 0) {
            const event = consumeLine();
            if (event) yield event;
          }
          if (frameHasFields) {
            const event = consumeLine();
            if (event) yield event;
          }
          if (this.options.requireTerminal && !this.terminalSeen) {
            throw new ProviderProtocolError("Provider stream ended without a terminal marker");
          }
          readToEnd = true;
          return;
        }
        if (!value || value.byteLength === 0) continue;

        const nextResponseBytes = responseBytes + value.byteLength;
        if (nextResponseBytes > this.options.maxResponseBytes) {
          throw new ProviderResponseTooLargeError(
            `Provider response exceeded ${this.options.maxResponseBytes} bytes`,
            this.options.maxResponseBytes,
            nextResponseBytes,
          );
        }
        responseBytes = nextResponseBytes;

        for (const byte of value) {
          if (skipLfAfterCr && byte === 0x0a) {
            skipLfAfterCr = false;
            continue;
          }
          skipLfAfterCr = false;
          if (byte === 0x0a || byte === 0x0d) {
            const event = consumeLine();
            if (byte === 0x0d) skipLfAfterCr = true;
            if (event) yield event;
            continue;
          }
          if (lineLength >= lineBytes.length) {
            throw new ProviderResponseTooLargeError(
              `Provider SSE line exceeded ${this.options.maxLineBytes} bytes`,
              this.options.maxLineBytes,
              lineLength + 1,
            );
          }
          lineBytes[lineLength++] = byte;
        }
      }
    } catch (error) {
      // An abort is an intentional terminal outcome, not malformed provider
      // data. Preserve the caller's reason so cancellation wins races.
      if (this.signal?.aborted) {
        throw this.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      if (error instanceof ProviderProtocolError || error instanceof ProviderResponseTooLargeError) {
        throw error;
      }
      throw new ProviderProtocolError("Provider SSE stream could not be decoded", { cause: error });
    } finally {
      if (!readToEnd) {
        await cancelStreamAndCloseConnection(reader, this.response);
      } else {
        await reader.cancel().catch(() => {});
      }
    }
  }
}
export function createBoundedSseReader(
  response: Response,
  signal?: AbortSignal,
  options?: BoundedSseReaderOptions,
): BoundedSseReader {
  return new BoundedSseReader(response, signal, options);
}


// Hard ceiling on a buffered JSON response. The receive boundary is shared by
// streaming and non-streaming provider requests; callers may pass a tighter
// limit for smaller endpoint-specific payloads.

const DEFAULT_MAX_JSON_BYTES = PROVIDER_STREAM_LIMITS.maxResponseBytes;
// Read a non-streaming JSON response body via the same user-space abort path
// the streaming providers use. The user signal is checked between reads instead
// of being handed to Bun's fetch, and reader.cancel() is awaited so the
// underlying HTTP connection is fully torn down before the response object
// becomes eligible for GC. Byte caps are checked before decode/append/parse.
export async function readJsonWithAbort<T>(
  res: Response,
  signal: AbortSignal | undefined,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  maxBytes = normalizeProviderReceiveLimit(maxBytes, "maxBytes");
  if (!res.body) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const contentLengthHeader =
      res.headers && typeof res.headers.get === "function"
        ? res.headers.get("content-length")?.trim()
        : undefined;
    if (!contentLengthHeader || !/^\d+$/.test(contentLengthHeader)) {
      throw new ProviderProtocolError(
        "Provider response body has no trustworthy content-length",
      );
    }
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength)) {
      throw new ProviderProtocolError(
        "Provider response content-length is not a safe integer",
      );
    }
    if (contentLength > maxBytes) {
      throw new ProviderResponseTooLargeError(
        `Provider response exceeded ${maxBytes} bytes`,
        maxBytes,
        contentLength,
      );
    }
    throw new ProviderProtocolError(
      "Provider response body is not incrementally readable",
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const textChunks: string[] = [];
  let total = 0;
  let readToEnd = false;
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      if (done) {
        readToEnd = true;
        break;
      }
      if (!value || value.byteLength === 0) continue;
      const nextTotal = total + value.byteLength;
      if (nextTotal > maxBytes) {
        throw new ProviderResponseTooLargeError(
          `Provider response exceeded ${maxBytes} bytes`,
          maxBytes,
          nextTotal,
        );
      }
      total = nextTotal;
      textChunks.push(decoder.decode(value, { stream: true }));
    }
    textChunks.push(decoder.decode());
    try {
      return JSON.parse(textChunks.join("")) as T;
    } catch (error) {
      throw new ProviderProtocolError("Provider response was not valid JSON", { cause: error });
    }
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    if (error instanceof ProviderProtocolError || error instanceof ProviderResponseTooLargeError) {
      throw error;
    }
    throw new ProviderProtocolError("Provider response could not be decoded", { cause: error });
  } finally {
    await reader.cancel().catch(() => {});
    if (!readToEnd) closeConnection(res);
  }
}

// Streaming providers can emit a large number of tiny reasoning/text deltas in a
// tight loop. Periodically yielding a macrotask keeps Bun's HTTP/WS queue moving
// so stop requests and health checks do not starve behind an active stream.
export async function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

export function createCooperativeYielder(every: number, signal?: AbortSignal): () => Promise<void> {
  let count = 0;
  const interval = Math.max(1, Math.floor(every));
  return async () => {
    count++;
    if (count % interval !== 0) return;
    await yieldToEventLoop(signal);
  };
}
