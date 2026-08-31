import { handleCompileAgentAssembly } from "./agentic-assembly-compiler";
import { prepareAgentRenderV1 } from "./agentic-render-preparation.service";
import type { RenderPreparationInputV1 } from "../types/agent-preprocessing";
import {
  DEFAULT_ISOLATE_MAX_FRAME_BYTES,
  decodeLengthPrefixedJson,
  encodeLengthPrefixedJson,
  isIsolateRequestEnvelopeV1,
  makeErrorEnvelopeV1,
  makeResultEnvelopeV1,
  normalizeIsolateMaxFrameBytes,
} from "./isolate-protocol";

async function dispatch(operation: string, payload: unknown): Promise<unknown> {
  if (operation === "compile_agent_assembly") {
    return handleCompileAgentAssembly(payload);
  }
  if (operation === "prepare_agent_render") {
    return prepareAgentRenderV1(payload as RenderPreparationInputV1);
  }
  throw new Error(`Unsupported Agentic preprocessing operation: ${operation}`);
}
function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; failureCode?: unknown; name?: unknown };
  const code = typeof candidate.code === "string"
    ? candidate.code
    : typeof candidate.failureCode === "string"
      ? candidate.failureCode
      : undefined;
  if (code === "invalid_input" || code === "limit_exceeded") return code;
  // Assembly-specific rejection reasons are input failures at the strict
  // protocol boundary; do not expose an open-ended worker error taxonomy.
  if (candidate.name === "AssemblyPlanValidationError") return "invalid_input";
  return undefined;
}

async function handleRequest(message: unknown): Promise<void> {
  const request = decodeLengthPrefixedJson<unknown>(
    message as Uint8Array | ArrayBuffer,
    workerMaxFrameBytes,
  );
  if (!isIsolateRequestEnvelopeV1(request)) {
    throw new Error("Malformed isolate request envelope");
  }
  try {
    const result = await dispatch(request.operation, request.payload);
    postMessage(encodeLengthPrefixedJson(
      makeResultEnvelopeV1(request.requestId, result),
      workerMaxFrameBytes,
    ));
  } catch (error) {
    postMessage(encodeLengthPrefixedJson(
      makeErrorEnvelopeV1(request.requestId, error, errorCode(error)),
      workerMaxFrameBytes,
    ));
  }
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

const workerGlobal = typeof self !== "undefined" && typeof (self as unknown as { postMessage?: unknown }).postMessage === "function"
  ? self
  : null;

if (workerGlobal) {
  workerGlobal.onmessage = (event: MessageEvent<unknown>) => {
    void handleRequest(event.data);
  };
}
