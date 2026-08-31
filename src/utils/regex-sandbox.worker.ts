import { runRegexRequest, type RegexRequest } from "./regex-sandbox-core";
import {
  DEFAULT_ISOLATE_MAX_FRAME_BYTES,
  decodeLengthPrefixedJson,
  encodeLengthPrefixedJson,
  isIsolateRequestEnvelopeV1,
  makeErrorEnvelopeV1,
  makeStartedEnvelopeV1,
  makeResultEnvelopeV1,
  normalizeIsolateMaxFrameBytes,
} from "../services/isolate-protocol";

const REGEX_OPERATIONS: Record<string, true> = Object.freeze({
  replace: true,
  test: true,
  collect: true,
  "capture-replacements": true,
});

type RegexPayload = Omit<RegexRequest, "id">;

/**
 * Worker-side regex evaluator. The Worker and subprocess backends both use
 * the same length-prefixed request/response protocol. A malformed frame is a
 * transport failure; a valid request that fails validation receives a typed
 * error envelope.
 */
const workerSelf = self as unknown as {
  addEventListener: (type: "message", handler: (event: MessageEvent<unknown>) => void) => void;
  postMessage: (message: unknown) => void;
};

function errorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; failureCode?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    if (typeof candidate.failureCode === "string") return candidate.failureCode;
  }
  if (error instanceof SyntaxError) {
    return /flag/i.test(error.message) ? "invalid_flags" : "invalid_regex";
  }
  return "worker_malformed";
}

function executeRegexRequest(
  payload: unknown,
  requestId: string,
  operation: string,
): unknown {
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || REGEX_OPERATIONS[operation] !== true
  ) {
    throw Object.assign(new TypeError("Regex isolate request is invalid"), { code: "invalid_input" });
  }
  const candidate = payload as Partial<RegexPayload>;
  if (candidate.op !== operation) {
    throw Object.assign(new TypeError("Regex isolate operation identity is invalid"), { code: "invalid_input" });
  }
  return runRegexRequest({
    ...candidate,
    id: requestId,
  } as RegexRequest);
}

const configuredFrameBytes = Number(
  typeof location !== "undefined"
    ? new URL(location.href).searchParams.get("maxFrameBytes")
    : process.env.LUMIVERSE_ISOLATE_MAX_FRAME_BYTES,
);
const workerMaxFrameBytes = normalizeIsolateMaxFrameBytes(
  Number.isFinite(configuredFrameBytes) && configuredFrameBytes > 0
    ? configuredFrameBytes
    : DEFAULT_ISOLATE_MAX_FRAME_BYTES,
);

async function handleRequest(message: unknown): Promise<void> {
  const request = decodeLengthPrefixedJson<unknown>(
    message as Uint8Array | ArrayBuffer,
    workerMaxFrameBytes,
  );
  if (!isIsolateRequestEnvelopeV1(request) || REGEX_OPERATIONS[request.operation] !== true) {
    throw new Error("Malformed isolate regex request envelope");
  }
  workerSelf.postMessage(encodeLengthPrefixedJson(
    makeStartedEnvelopeV1(request.requestId),
    workerMaxFrameBytes,
  ));
  try {
    const result = executeRegexRequest(request.payload, request.requestId, request.operation);
    workerSelf.postMessage(encodeLengthPrefixedJson(
      makeResultEnvelopeV1(request.requestId, result),
      workerMaxFrameBytes,
    ));
  } catch (error) {
    workerSelf.postMessage(encodeLengthPrefixedJson(
      makeErrorEnvelopeV1(request.requestId, error, errorCode(error)),
      workerMaxFrameBytes,
    ));
  }
}

workerSelf.addEventListener("message", (event) => {
  void handleRequest(event.data);
});
