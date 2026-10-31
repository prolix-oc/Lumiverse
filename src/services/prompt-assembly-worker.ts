import type { AssemblyResult } from "../llm/types";
import type { MacroDefinition, MacroEnv, MacroHandler } from "../macros/types";
import { initIdentity } from "../crypto/init";
import { initDatabase } from "../db/connection";
import type { AssemblyWorkerRequest, AssemblyWorkerResponse } from "./prompt-assembly-worker-protocol";
import { warmTokenizerForModel, getCachedTokenizerIds, invalidate, invalidatePatterns } from "./tokenizer.service";
import { setTokenizerResourceOwner } from "./tokenizer-resource-cache";

// Mark this isolate as the assembly worker so assemblePrompt can skip work that
// only makes sense in the main process — notably the deferred cortex warm task,
// whose results must populate the *main* process's cache (and which would
// otherwise spawn a nested cortex worker from in here). Set at module load,
// before any assemblePrompt() call.
(globalThis as { __LUMIVERSE_ASSEMBLY_WORKER?: boolean }).__LUMIVERSE_ASSEMBLY_WORKER = true;

let initialized: Promise<void> | null = null;
let lastTokenizerRevision = -1;

function ensureInitialized(): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
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

async function handleAssemble(message: Extract<AssemblyWorkerRequest, { type: "assemble" }>): Promise<void> {
  await ensureInitialized();

  const [{ prefetchAssemblyData }, { assemblePrompt }] = await Promise.all([
    import("./prompt-assembly-prefetch"),
    import("./prompt-assembly.service"),
  ]);

  const prefetched = await prefetchAssemblyData(message.ctx);
  const result = await assemblePrompt({ ...message.ctx, prefetched });

  postMessage({
    type: "result",
    requestId: message.requestId,
    result: sanitizeAssemblyResult(result),
    tokenizerRevision: message.tokenizerRevision,
    tokenizerIds: getCachedTokenizerIds(),
  } satisfies AssemblyWorkerResponse);
}

async function handleWarmup(message: Extract<AssemblyWorkerRequest, { type: "warm-tokenizer" }>): Promise<void> {
  await ensureInitialized();
  await warmTokenizerForModel(message.modelId);
  postMessage({ type: "tokenizer-warmed", requestId: message.requestId,
    tokenizerRevision: message.tokenizerRevision, tokenizerIds: getCachedTokenizerIds() } satisfies AssemblyWorkerResponse);
}

self.onmessage = (event: MessageEvent<AssemblyWorkerRequest>) => {
  const message = event.data;
  if (!message) return;
  if (message.type === "invalidate-tokenizer") {
    if (message.tokenizerId === null) invalidatePatterns();
    else invalidate(message.tokenizerId);
    return;
  }
  if (message.type !== "assemble" && message.type !== "warm-tokenizer") return;
  setTokenizerResourceOwner(message.resourceOwner);
  // Recheck at request boundaries too: an older running job may have read
  // patterns while the main process was still committing an admin transaction.
  if (message.tokenizerRevision !== lastTokenizerRevision) {
    invalidatePatterns();
    lastTokenizerRevision = message.tokenizerRevision;
  }

  (message.type === "assemble" ? handleAssemble(message) : handleWarmup(message)).catch((err: any) => {
    postMessage({
      type: "error",
      requestId: message.requestId,
      error: err?.message || String(err),
      name: err?.name,
      stack: err?.stack,
    } satisfies AssemblyWorkerResponse);
  });
};
