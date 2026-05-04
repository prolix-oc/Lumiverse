import type { AssemblyContext, AssemblyResult } from "../llm/types";
import type { MacroDefinition, MacroEnv, MacroHandler } from "../macros/types";
import { configureLanceDbNativeOverride } from "../lancedb-preflight";
import { initIdentity } from "../crypto/init";
import { initDatabase } from "../db/connection";

type AssembleRequest = {
  type: "assemble";
  requestId: string;
  ctx: Omit<AssemblyContext, "signal" | "prefetched">;
};

type WorkerResponse =
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

async function handleAssemble(message: AssembleRequest): Promise<void> {
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
  } satisfies WorkerResponse);
}

self.onmessage = (event: MessageEvent<AssembleRequest>) => {
  const message = event.data;
  if (!message || message.type !== "assemble") return;

  handleAssemble(message).catch((err: any) => {
    postMessage({
      type: "error",
      requestId: message.requestId,
      error: err?.message || String(err),
      name: err?.name,
      stack: err?.stack,
    } satisfies WorkerResponse);
  });
};
