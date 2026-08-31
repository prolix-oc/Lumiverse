import type { AssemblyContext, AssemblyResult } from "../llm/types";
import type { MacroDefinition, MacroEnv, MacroHandler } from "../macros/types";
import { configureLanceDbNativeOverride } from "../lancedb-preflight";
import { initIdentity } from "../crypto/init";
import { initDatabase } from "../db/connection";
import {
  DEFAULT_ISOLATE_MAX_FRAME_BYTES,
  decodeLengthPrefixedJson,
  encodeLengthPrefixedJson,
  isIsolateRequestEnvelopeV1,
  makeErrorEnvelopeV1,
  makeResultEnvelopeV1,
  normalizeIsolateMaxFrameBytes,
} from "./isolate-protocol";

// Mark this isolate as the assembly worker so assemblePrompt can skip work that
// only makes sense in the main process — notably the deferred cortex warm task,
// whose results must populate the *main* process's cache (and which would
// otherwise spawn a nested cortex worker from in here). Set at module load,
// before any assemblePrompt() call.
(globalThis as { __LUMIVERSE_ASSEMBLY_WORKER?: boolean }).__LUMIVERSE_ASSEMBLY_WORKER = true;

export type AssembleRequest = {
  type: "assemble";
  requestId: string;
  ctx: Omit<
    AssemblyContext,
    "signal" | "prefetched" | "agentRuntimeOwner" | "createAgentRuntimeOwner"
  >;
};

export type WorkerResponse =
  | { type: "result"; requestId: string; result: AssemblyResult }
  | { type: "error"; requestId: string; error: string; name?: string; stack?: string };

let initialized: Promise<void> | null = null;

function ensureInitialized(): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
      await configureLanceDbNativeOverride();
      await initIdentity();
      initDatabase();
    })();
  }
  return initialized;
}

function isMacroDefinition(value: unknown): value is MacroDefinition {
  return !!value && typeof value === "object" && "handler" in value;
}

function sanitizeDynamicMacroValue(
  value: string | MacroHandler | MacroDefinition,
): string | undefined {
  if (typeof value === "string") return value;
  if (isMacroDefinition(value) && typeof value.handler !== "function") {
    return undefined;
  }
  return undefined;
}

function sanitizeMacroEnv(env: MacroEnv | undefined): MacroEnv | undefined {
  if (!env) return undefined;

  const dynamicMacros: Record<string, string> = {};
  for (const [key, value] of Object.entries(env.dynamicMacros ?? {})) {
    const sanitized = sanitizeDynamicMacroValue(value);
    if (sanitized !== undefined) dynamicMacros[key] = sanitized;
  }

  return {
    ...env,
    signal: undefined,
    dynamicMacros,
    _dynamicMacrosLower: new Map(
      Object.entries(dynamicMacros).map(([key, value]) => [key.toLowerCase(), value]),
    ),
  };
}

function sanitizeAssemblyResult(result: AssemblyResult): AssemblyResult {
  return {
    ...result,
    macroEnv: sanitizeMacroEnv(result.macroEnv),
    macroEnvSeed: sanitizeMacroEnv(result.macroEnvSeed),
  };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; failureCode?: unknown };
  return typeof candidate.code === "string"
    ? candidate.code
    : typeof candidate.failureCode === "string"
      ? candidate.failureCode
      : undefined;
}

export async function runAssemblyRequest(
  ctx: Omit<
    AssemblyContext,
    "signal" | "prefetched" | "agentRuntimeOwner" | "createAgentRuntimeOwner"
  >,
): Promise<AssemblyResult> {
  await ensureInitialized();

  const [{ prefetchAssemblyData }, { assemblePrompt }] = await Promise.all([
    import("./prompt-assembly-prefetch"),
    import("./prompt-assembly.service"),
  ]);

  const prefetched = await prefetchAssemblyData(ctx);
  const result = await assemblePrompt({ ...ctx, prefetched });
  return sanitizeAssemblyResult(result);
}

async function handleRequest(message: unknown): Promise<void> {
  const request = decodeLengthPrefixedJson<unknown>(
    message as Uint8Array | ArrayBuffer,
    workerMaxFrameBytes,
  );
  if (!isIsolateRequestEnvelopeV1(request) || request.operation !== "assemble_prompt") {
    throw new Error("Malformed isolate assembly request envelope");
  }
  try {
    const result = await runAssemblyRequest(request.payload as AssembleRequest["ctx"]);
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
