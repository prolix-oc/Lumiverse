import type { AssemblyContext, AssemblyResult } from "../llm/types";
import { HOST_PREPARATION_LIMITS_V1, isPreparationFailureCode } from "../types/agent-preprocessing";
import { registry } from "../macros";
import { macroInterceptorChain } from "../spindle/macro-interceptor";
import { worldInfoInterceptorChain } from "../spindle/world-info-interceptor";
import { defaultIsolateCommand } from "./isolate-process";
import {
  getIsolateHealthSnapshot,
  IsolatePoolError,
  IsolatePoolV1,
  type ActiveIsolateJob,
} from "./isolate-pool";
import {
  isIsolateResponseEnvelopeV1,
} from "./isolate-protocol";

export type PromptAssemblyWorkerContext = Omit<
  AssemblyContext,
  "signal" | "prefetched" | "agentRuntimeOwner" | "createAgentRuntimeOwner"
>;

export type PromptAssemblyWorkerResponse =
  | { type: "result"; requestId: string; result: AssemblyResult }
  | { type: "error"; requestId: string; error: string; name?: string; stack?: string; code?: string };

function workerDisabledByEnv(): boolean {
  return process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER === "false";
}

function hasMainProcessOnlyMacros(): boolean {
  return registry.getAllMacros().some((macro) => !macro.builtIn);
}

export function canUsePromptAssemblyWorker(): boolean {
  if (workerDisabledByEnv()) return false;
  // Extension macros and interceptors are registered in the main process. The
  // Response pipeline must retain its established compatibility fallback for
  // these callbacks rather than silently dropping their behavior in an isolate.
  if (hasMainProcessOnlyMacros()) return false;
  if (macroInterceptorChain.count > 0) return false;
  if (worldInfoInterceptorChain.count > 0) return false;
  return true;
}

function parsePromptAssemblyResponse(
  message: unknown,
  job: ActiveIsolateJob<PromptAssemblyWorkerContext, AssemblyResult>,
): AssemblyResult {
  if (isIsolateResponseEnvelopeV1(message) && message.requestId === job.requestId) {
    if (message.type === "result") return message.result as AssemblyResult;
    const error = new IsolatePoolError(
      isPreparationFailureCode(message.code) ? message.code : "worker_unavailable",
      message.error,
      { remote: true },
    );
    if (message.name) error.name = message.name;
    if (message.stack) error.stack = message.stack;
    throw error;
  }
  if (!message || typeof message !== "object") {
    throw new IsolatePoolError("worker_malformed", "Prompt assembly worker returned a malformed response");
  }
  const response = message as Partial<PromptAssemblyWorkerResponse>;
  if (response.requestId !== job.requestId || (response.type !== "result" && response.type !== "error")) {
    throw new IsolatePoolError("worker_malformed", "Prompt assembly worker response identity is invalid");
  }
  if (response.type === "error") {
    const error = new IsolatePoolError("worker_malformed", response.error || "Prompt assembly worker failed", { remote: true });
    if (response.name) error.name = response.name;
    if (response.stack) error.stack = response.stack;
    throw error;
  }
  if (!(response.type === "result" && "result" in response)) {
    throw new IsolatePoolError("worker_malformed", "Prompt assembly worker result is missing");
  }
  return response.result as AssemblyResult;
}
export function isSafeResponseAssemblyFallbackError(error: unknown): boolean {
  const code = error instanceof IsolatePoolError
    ? error.code
    : error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  // Main-process retry is only a compatibility escape for a disabled or
  // unavailable transport. Validation, queue, cancellation, and every
  // preparation limit remain visible and must never be retried inline.
  return code === "worker_disabled"
    || code === "worker_unavailable"
    || code === "worker_crashed"
    || code === "worker_timed_out"
    || code === "worker_malformed";
}

function createPromptAssemblyPool(): IsolatePoolV1<PromptAssemblyWorkerContext, AssemblyResult> {
  return new IsolatePoolV1<PromptAssemblyWorkerContext, AssemblyResult>({
    name: "prompt-assembly",
    workerUrl: new URL("./prompt-assembly-worker.ts", import.meta.url),
    subprocessCommand: defaultIsolateCommand(new URL("./prompt-assembly-subprocess.ts", import.meta.url)),
    workerRequest: (job) => ({
      version: 1,
      type: "request",
      requestId: job.requestId,
      operation: "assemble_prompt",
      payload: job.payload,
    }),
    responseParser: parsePromptAssemblyResponse,
    maxWorkers: HOST_PREPARATION_LIMITS_V1.maxWorkers,
    maxQueuedPerUser: HOST_PREPARATION_LIMITS_V1.maxQueuedJobsPerUser,
    maxQueuedGlobal: HOST_PREPARATION_LIMITS_V1.maxQueuedJobsProcess,
    maxFrameBytes: HOST_PREPARATION_LIMITS_V1.maxOutputBytes,
    defaultTimeoutMs: HOST_PREPARATION_LIMITS_V1.maxWallClockMs,
  });
}

let pool = createPromptAssemblyPool();

export function assemblePromptInWorker(ctx: AssemblyContext): Promise<AssemblyResult> {
  const {
    signal,
    prefetched: _prefetched,
    agentRuntimeOwner: _agentRuntimeOwner,
    createAgentRuntimeOwner: _createAgentRuntimeOwner,
    ...workerCtx
  } = ctx;
  return pool.submit({
    userId: workerCtx.userId,
    operation: "assemble_prompt",
    payload: workerCtx,
    signal,
    timeoutMs: HOST_PREPARATION_LIMITS_V1.maxWallClockMs,
  });
}

export function getPromptAssemblyWorkerHealth() {
  return getIsolateHealthSnapshot();
}

/** Release the reconstructable pool only when no prompt is active or queued. */
export function releaseIdlePromptAssemblyWorkers(): number {
  if (pool.activeCount() > 0 || pool.queuedCount() > 0) return 0;
  const idlePool = pool;
  pool = createPromptAssemblyPool();
  void idlePool.shutdown();
  return 1;
}

export async function shutdownPromptAssemblyWorkerPool(): Promise<void> {
  await pool.shutdown();
}
