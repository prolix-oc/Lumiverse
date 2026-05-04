import type { AssemblyContext, AssemblyResult } from "../llm/types";
import { registry } from "../macros";
import { macroInterceptorChain } from "../spindle/macro-interceptor";
import { worldInfoInterceptorChain } from "../spindle/world-info-interceptor";

type AssembleRequest = {
  type: "assemble";
  requestId: string;
  ctx: Omit<AssemblyContext, "signal" | "prefetched">;
};

type WorkerResponse =
  | { type: "result"; requestId: string; result: AssemblyResult }
  | { type: "error"; requestId: string; error: string; name?: string; stack?: string };

function workerDisabledByEnv(): boolean {
  return process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER === "false";
}

function hasMainProcessOnlyMacros(): boolean {
  return registry.getAllMacros().some((macro) => !macro.builtIn);
}

export function canUsePromptAssemblyWorker(): boolean {
  if (workerDisabledByEnv()) return false;
  // Extension macros are registered in the main process and cannot yet execute
  // inside the assembly worker. Keep behavior correct by falling back to the
  // in-process pipeline when any non-built-in macro is registered.
  if (hasMainProcessOnlyMacros()) return false;
  if (macroInterceptorChain.count > 0) return false;
  if (worldInfoInterceptorChain.count > 0) return false;
  return true;
}

export function assemblePromptInWorker(
  ctx: AssemblyContext,
): Promise<AssemblyResult> {
  const requestId = crypto.randomUUID();
  const { signal: _signal, prefetched: _prefetched, ...workerCtx } = ctx;

  return new Promise<AssemblyResult>((resolve, reject) => {
    if (ctx.signal?.aborted) {
      reject(ctx.signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const worker = new Worker(new URL("./prompt-assembly-worker.ts", import.meta.url), {
      type: "module",
    });
    let settled = false;

    const cleanup = () => {
      ctx.signal?.removeEventListener("abort", onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onAbort = () => {
      settle(() =>
        reject(ctx.signal?.reason ?? new DOMException("Aborted", "AbortError")),
      );
    };

    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (!message || message.requestId !== requestId) return;
      if (message.type === "result") {
        settle(() => resolve(message.result));
      } else {
        const err = new Error(message.error);
        err.name = message.name || "PromptAssemblyWorkerError";
        if (message.stack) err.stack = message.stack;
        settle(() => reject(err));
      }
    };

    worker.onerror = (event) => {
      const message = event.message || "Prompt assembly worker failed";
      settle(() => reject(new Error(message)));
    };

    worker.postMessage({
      type: "assemble",
      requestId,
      ctx: workerCtx,
    } satisfies AssembleRequest);
  });
}
