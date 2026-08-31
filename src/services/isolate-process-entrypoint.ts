import {
  DEFAULT_ISOLATE_MAX_FRAME_BYTES,
  decodeJsonFrame,
  encodeLengthPrefixedJson,
  isIsolateRequestEnvelopeV1,
  makeErrorEnvelopeV1,
  makeResultEnvelopeV1,
  LengthPrefixedFrameDecoder,
  normalizeIsolateMaxFrameBytes,
} from "./isolate-protocol";

// Framed subprocesses own stdout. Route incidental dependency logs to stderr so
// a migration/provider log can never be misread as an untrusted frame length.
const writeConsoleToStderr = console.error.bind(console);
console.log = writeConsoleToStderr;
console.info = writeConsoleToStderr;
console.debug = writeConsoleToStderr;

export type IsolateProcessOperationHandler = (payload: unknown, requestId: string) => unknown | Promise<unknown>;

export interface IsolateProcessEntrypointOptions {
  readonly handlers: Record<string, IsolateProcessOperationHandler>;
  readonly maxFrameBytes?: number;
}

function writeStdoutFrame(frame: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(Buffer.from(frame), (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("failureCode" in error && typeof error.failureCode === "string") return error.failureCode;
  return undefined;
}

/** Run a strict framed stdin/stdout isolate. Invalid transport frames terminate the child. */
export async function runIsolateProcessEntrypoint(options: IsolateProcessEntrypointOptions): Promise<void> {
  const configuredFrameBytes = options.maxFrameBytes
    ?? Number(process.env.LUMIVERSE_ISOLATE_MAX_FRAME_BYTES);
  const maxFrameBytes = normalizeIsolateMaxFrameBytes(
    Number.isFinite(configuredFrameBytes) && configuredFrameBytes > 0
      ? configuredFrameBytes
      : DEFAULT_ISOLATE_MAX_FRAME_BYTES,
  );
  const decoder = new LengthPrefixedFrameDecoder(maxFrameBytes);
  const input = Bun.stdin.stream();
  const reader = input.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value || next.value.byteLength === 0) continue;
      const frames = decoder.push(next.value);
      for (const frame of frames) {
        const request = decodeJsonFrame<unknown>(frame);
        if (!isIsolateRequestEnvelopeV1(request)) {
          throw new Error("Malformed isolate request envelope");
        }
        const candidate = Object.prototype.hasOwnProperty.call(options.handlers, request.operation)
          ? options.handlers[request.operation]
          : undefined;
        const handler = typeof candidate === "function" ? candidate : undefined;
        if (!handler) {
          await writeStdoutFrame(encodeLengthPrefixedJson(
            makeErrorEnvelopeV1(request.requestId, `Unsupported isolate operation: ${request.operation}`, "invalid_input"),
            maxFrameBytes,
          ));
          continue;
        }
        try {
          const result = await handler(request.payload, request.requestId);
          await writeStdoutFrame(encodeLengthPrefixedJson(
            makeResultEnvelopeV1(request.requestId, result),
            maxFrameBytes,
          ));
        } catch (error) {
          await writeStdoutFrame(encodeLengthPrefixedJson(
            makeErrorEnvelopeV1(request.requestId, error, errorCode(error)),
            maxFrameBytes,
          ));
        }
      }
    }
    decoder.finish();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be closed by process shutdown.
    }
  }
}
