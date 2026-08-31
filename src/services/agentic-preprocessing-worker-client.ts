import {
  HOST_PREPARATION_LIMITS_V1,
  isPreparationFailureCode,
  isPreparationProtocolEnvelopeV1,
} from "../types/agent-preprocessing";
import {
  CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
  CanonicalDataError,
  encodeCanonicalPlainData,
} from "../utils/canonical-plain-data";
import { defaultIsolateCommand } from "./isolate-process";
import type {
  PreparationLimitsV1,
  RenderPreparationInputV1,
  RenderPreparationResultV1,
} from "../types/agent-preprocessing";
import {
  validateAssemblyPlanAgainstSnapshotV1,
  type AssemblyPlanV1 as CompilerAssemblyPlanV1,
  type CompileAgentAssemblyRequestV1,
} from "./agentic-assembly-compiler";
import type { GenerationAssemblySnapshotV1 } from "./prompt-assembly-snapshot.service";
import {
  getIsolateHealthSnapshot,
  IsolatePoolError,
  IsolatePoolV1,
  type ActiveIsolateJob,
} from "./isolate-pool";
import {
  isIsolateResponseEnvelopeV1,
  makeRequestEnvelopeV1,
  type IsolateResponseEnvelopeV1,
} from "./isolate-protocol";

import {
  getEffectiveRenderPreparationLimits,
  validateRenderPreparationInputV1,
  validateRenderPreparationResultV1,
} from "./agentic-render-preparation-validator";
export interface AgenticPreprocessingCallOptions {
  readonly userId: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type AgenticAssemblyInputV1 =
  | CompileAgentAssemblyRequestV1["snapshot"]
  | Pick<CompileAgentAssemblyRequestV1, "snapshot" | "agentConfig">;
function canonical(value: unknown): string {
  try {
    return encodeCanonicalPlainData(value, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes: HOST_PREPARATION_LIMITS_V1.maxInputBytes + HOST_PREPARATION_LIMITS_V1.maxOutputBytes,
    });
  } catch (error) {
    if (error instanceof CanonicalDataError && error.code === "limit_exceeded") {
      throw new IsolatePoolError("worker_malformed", "Agentic render binding exceeds canonical data limits");
    }
    throw new IsolatePoolError("worker_malformed", "Agentic render binding is not closed plain data");
  }
}

function requestedAssemblySnapshot(job: ActiveIsolateJob<unknown, unknown>): Record<string, unknown> | null {
  const payload = job.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidate = payload as Record<string, unknown>;
  const snapshot = "snapshot" in candidate ? candidate.snapshot : payload;
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : null;
}
function requestedRenderInput(job: ActiveIsolateJob<unknown, unknown>): Record<string, unknown> | null {
  if (job.operation !== "prepare_agent_render") return null;
  const payload = job.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

function renderText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const content = value as Record<string, unknown>;
  if (content.kind === "text") return typeof content.text === "string" ? content.text : "";
  if (content.kind !== "parts" || !Array.isArray(content.parts)) return "";
  return content.parts.reduce((text, part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return text;
    const item = part as Record<string, unknown>;
    return item.kind === "text" && typeof item.text === "string" ? text + item.text : text;
  }, "");
}

function renderContentFrame(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const content = value as Record<string, unknown>;
  if (content.kind === "text") return { kind: "text" };
  if (content.kind !== "parts" || !Array.isArray(content.parts)) return null;
  return {
    kind: "parts",
    parts: content.parts.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return null;
      const item = part as Record<string, unknown>;
      if (item.kind === "text") return { kind: "text" };
      if (item.kind === "media") {
        return {
          kind: "media",
          mediaKind: item.mediaKind,
          mimeType: item.mimeType,
          reference: item.reference,
          altText: item.altText,
        };
      }
      return null;
    }),
  };
}

function renderTargetKey(input: RenderPreparationInputV1): string {
  const target = input.target;
  const messageId = target.messageId === undefined ? "" : String(target.messageId);
  const swipeId = target.swipeId === undefined ? "" : String(target.swipeId);
  if (target.kind === "normal") return "generated_message";
  if (target.kind === "continue" && messageId) return `message:${messageId}:continue`;
  if ((target.kind === "regenerate" || target.kind === "swipe") && messageId && swipeId) {
    return `message:${messageId}:swipe:${swipeId}`;
  }
  throw new IsolatePoolError("worker_malformed", "Agentic render target intent is incomplete");
}

function assertRenderResultBinding(
  result: RenderPreparationResultV1,
  input: RenderPreparationInputV1,
): void {
  if (canonical(result.inputRevisions) !== canonical(input.inputRevisions)) {
    throw new IsolatePoolError("worker_malformed", "Agentic render result revisions are not bound to the request");
  }
  if (canonical(renderContentFrame(result.content)) !== canonical(renderContentFrame(input.content))) {
    throw new IsolatePoolError("worker_malformed", "Agentic render result changed frozen content metadata");
  }

  const sourceById = new Map(input.sourceMessages.map((source) => [source.sourceMessageId, source]));
  const sourceSeen = new Set<string>();
  for (const delta of result.sourceMessageDeltas) {
    if (delta.operation !== "update" || sourceSeen.has(delta.sourceMessageId)) {
      throw new IsolatePoolError("worker_malformed", "Agentic render source delta intent is invalid");
    }
    sourceSeen.add(delta.sourceMessageId);
    const source = sourceById.get(delta.sourceMessageId);
    const authorized = input.deltas.find((candidate) => (
      candidate.kind === "source_message"
      && candidate.sourceMessageId === delta.sourceMessageId
      && candidate.operation === "update"
      && candidate.swipeId === source?.swipeId
      && candidate.expectedRevision !== undefined
      && String(candidate.expectedRevision) === String(source?.revision)
    ));
    if (
      !source
      || !authorized
      || delta.role !== source.role
      || delta.swipeId !== source.swipeId
      || typeof delta.content !== "string"
      || canonical(delta.expectedRevision) !== canonical(authorized.expectedRevision)
    ) {
      throw new IsolatePoolError("worker_malformed", "Agentic render source delta is not authorized by the request");
    }
  }

  for (const delta of result.macroVariableDeltas) {
    const authorized = input.deltas.find((candidate) => (
      candidate.kind === "macro_variable"
      && candidate.scope === delta.scope
      && candidate.key === delta.key
      && candidate.operation === delta.operation
    ));
    if (
      !authorized
      || canonical(delta.expectedRevision) !== canonical(authorized.expectedRevision)
      || (delta.operation === "set" && typeof delta.value !== "string")
      || (delta.operation === "delete" && delta.value !== undefined)
    ) {
      throw new IsolatePoolError("worker_malformed", "Agentic render macro delta is not authorized by the request");
    }
  }

  const scripts = new Map(input.regexScripts.map((script) => [script.scriptId, script]));
  for (const delta of result.regexActionDeltas) {
    const script = scripts.get(delta.scriptId);
    const authorized = input.deltas.find((candidate) => (
      candidate.kind === "regex_action" && candidate.scriptId === delta.scriptId
    ));
    const expectedRevision = authorized?.expectedRevision ?? script?.revision;
    if (
      !script
      || !authorized
      || delta.operation !== (script.enabled ? "apply" : "skip")
      || canonical(delta.expectedRevision) !== canonical(expectedRevision)
    ) {
      throw new IsolatePoolError("worker_malformed", "Agentic render regex action is not authorized by the request");
    }
  }

  const expectedWorldInfo = input.deltas.filter((delta) => delta.kind === "world_info_state");
  if (canonical(result.worldInfoStateDeltas) !== canonical(expectedWorldInfo)) {
    throw new IsolatePoolError("worker_malformed", "Agentic render world-info deltas are not bound to the request");
  }

  if (result.chatMetadataDeltas.length !== 1) {
    throw new IsolatePoolError("worker_malformed", "Agentic render chat metadata result is incomplete");
  }
  const metadata = result.chatMetadataDeltas[0]!;
  const expectedKey = renderTargetKey(input);
  if (
    metadata.kind !== "chat_metadata"
    || metadata.operation !== "set"
    || metadata.key !== expectedKey
    || metadata.value !== renderText(result.content)
  ) {
    throw new IsolatePoolError("worker_malformed", "Agentic render target metadata is not bound to the request");
  }
  const selectedSwipe = input.swipes.find((swipe) => String(swipe.swipeId) === String(input.target.swipeId));
  const expectedSwipeRevision = selectedSwipe?.slot === "append" ? undefined : selectedSwipe?.revision;
  if (canonical(metadata.expectedRevision) !== canonical(expectedSwipeRevision)) {
    throw new IsolatePoolError("worker_malformed", "Agentic render swipe revision is not bound to the request");
  }
}

function strictWorkerRequest(job: ActiveIsolateJob<unknown, unknown>): unknown {
  const payload = job.payload;
  let strictPayload: unknown = payload;
  if (job.operation === "compile_agent_assembly") {
    const candidate = payload !== null && typeof payload === "object"
      ? payload as Record<string, unknown>
      : undefined;
    strictPayload = {
      version: 1,
      operation: job.operation,
      requestId: job.requestId,
      snapshot: candidate && "snapshot" in candidate ? candidate.snapshot : payload,
      ...(candidate && "agentConfig" in candidate ? { agentConfig: candidate.agentConfig } : {}),
    };
  } else if (payload !== null && typeof payload === "object") {
    strictPayload = {
      ...(payload as Record<string, unknown>),
      version: 1,
      operation: job.operation,
      requestId: job.requestId,
    };
  }
  return makeRequestEnvelopeV1(job.requestId, job.operation, strictPayload);
}
export async function parseAgenticPreprocessingResponseV1(message: unknown, job: ActiveIsolateJob<unknown, unknown>): Promise<unknown> {
  if (!isIsolateResponseEnvelopeV1(message) || message.requestId !== job.requestId) {
    throw new IsolatePoolError("worker_malformed", "Agentic preprocessing isolate response is malformed");
  }
  if (message.type === "error") {
    throw new IsolatePoolError(
      isPreparationFailureCode(message.code) ? message.code : "worker_malformed",
      message.error,
      { remote: true },
    );
  }
  const result = message.result;
  if (
    !isPreparationProtocolEnvelopeV1(result)
    || result.operation !== job.operation
    || result.requestId !== job.requestId
  ) {
    throw new IsolatePoolError("worker_malformed", "Agentic preprocessing result identity is invalid");
  }
  if (job.operation === "compile_agent_assembly") {
    try {
      const requested = requestedAssemblySnapshot(job);
      const requestedLimits = requested?.limits;
      if (
        !requested
        || !requestedLimits
        || typeof requestedLimits !== "object"
        || Array.isArray(requestedLimits)
      ) {
        throw new IsolatePoolError("worker_malformed", "Agentic assembly request limits are missing");
      }
      await validateAssemblyPlanAgainstSnapshotV1(
        result as unknown as CompilerAssemblyPlanV1,
        requested as unknown as GenerationAssemblySnapshotV1,
        requestedLimits as PreparationLimitsV1,
      );
    } catch (error) {
      if (error instanceof IsolatePoolError) throw error;
      throw new IsolatePoolError("worker_malformed", "Agentic assembly plan is malformed");
    }
  }
  if (job.operation === "prepare_agent_render") {
    try {
      const requested = requestedRenderInput(job);
      const requestedLimits = requested?.limits;
      if (
        !requested
        || !requestedLimits
        || typeof requestedLimits !== "object"
        || Array.isArray(requestedLimits)
      ) {
        throw new IsolatePoolError("worker_malformed", "Agentic render request limits are missing");
      }
      const limits = getEffectiveRenderPreparationLimits(requestedLimits as PreparationLimitsV1);
      const input = validateRenderPreparationInputV1(requested, limits);
      const validated = validateRenderPreparationResultV1(result, limits);
      if (validated.operation !== job.operation || validated.requestId !== job.requestId) {
        throw new IsolatePoolError("worker_malformed", "Agentic render result identity is invalid");
      }
      assertRenderResultBinding(validated, input);
    } catch (error) {
      if (error instanceof IsolatePoolError) throw error;
      throw new IsolatePoolError("worker_malformed", "Agentic render result is malformed");
    }
  }
  return result;
}

export class PairedAssemblyAdmissionV1 {
  private static readonly PAIR_WIDTH = 2;
  private readonly activeByUser = new Map<string, number>();
  private activeGlobal = 0;
  // Each logical assembly occupies one queue slot in each of two isolate
  // pools. The queue ceilings exclude one active pair, so admission counts
  // physical jobs rather than allowing two pools to double the shared cap.
  private readonly maxPerUser = Math.floor(HOST_PREPARATION_LIMITS_V1.maxQueuedJobsPerUser / PairedAssemblyAdmissionV1.PAIR_WIDTH) + 1;
  private readonly maxGlobal = Math.floor(HOST_PREPARATION_LIMITS_V1.maxQueuedJobsProcess / PairedAssemblyAdmissionV1.PAIR_WIDTH) + 1;

  acquire(userId: string): (() => void) | null {
    const userActive = this.activeByUser.get(userId) ?? 0;
    if (userActive >= this.maxPerUser || this.activeGlobal >= this.maxGlobal) return null;
    this.activeByUser.set(userId, userActive + 1);
    this.activeGlobal += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.activeByUser.get(userId) ?? 1) - 1;
      if (next > 0) this.activeByUser.set(userId, next);
      else this.activeByUser.delete(userId);
      this.activeGlobal = Math.max(0, this.activeGlobal - 1);
    };
  }
}

const pairedAssemblyAdmission = new PairedAssemblyAdmissionV1();

// Strict preprocessing is process-isolated. A degraded Bun Worker message
// channel can block the host event loop before its timeout callback runs; a
// subprocess remains externally terminable without wedging generation. The
// primary pool is reused for render after paired assembly, keeping two isolate
// processes rather than retaining a third.
const pool = new IsolatePoolV1<unknown, unknown>({
  name: "agentic-preprocessing-primary",
  subprocessCommand: defaultIsolateCommand(new URL("./agentic-preprocessing-subprocess.ts", import.meta.url)),
  subprocessRequest: strictWorkerRequest,
  responseParser: parseAgenticPreprocessingResponseV1,
  maxWorkers: 1,
  maxQueuedPerUser: HOST_PREPARATION_LIMITS_V1.maxQueuedJobsPerUser,
  maxQueuedGlobal: HOST_PREPARATION_LIMITS_V1.maxQueuedJobsProcess,
  maxFrameBytes: HOST_PREPARATION_LIMITS_V1.maxOutputBytes,
  defaultTimeoutMs: HOST_PREPARATION_LIMITS_V1.maxWallClockMs,
  backend: "subprocess",
  disabled: process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER === "false",
});

const verifierPool = new IsolatePoolV1<unknown, unknown>({
  name: "agentic-assembly-verifier",
  subprocessCommand: defaultIsolateCommand(new URL("./agentic-preprocessing-subprocess.ts", import.meta.url)),
  subprocessRequest: strictWorkerRequest,
  responseParser: parseAgenticPreprocessingResponseV1,
  maxWorkers: 1,
  maxQueuedPerUser: HOST_PREPARATION_LIMITS_V1.maxQueuedJobsPerUser,
  maxQueuedGlobal: HOST_PREPARATION_LIMITS_V1.maxQueuedJobsProcess,
  maxFrameBytes: HOST_PREPARATION_LIMITS_V1.maxOutputBytes,
  defaultTimeoutMs: HOST_PREPARATION_LIMITS_V1.maxWallClockMs,
  backend: "subprocess",
  disabled: process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER === "false",
});
function assemblySnapshotOf(input: AgenticAssemblyInputV1): GenerationAssemblySnapshotV1 {
  return "snapshot" in input ? input.snapshot : input;
}


export function assertPairedAssemblyResultsV1(
  primary: CompilerAssemblyPlanV1,
  verifier: CompilerAssemblyPlanV1,
): void {
  const { requestId: _primaryRequestId, ...primaryComparable } = primary;
  const { requestId: _verifierRequestId, ...verifierComparable } = verifier;
  if (canonical(primaryComparable) !== canonical(verifierComparable)) {
    throw new IsolatePoolError("worker_malformed", "Independent Agentic assembly results differ");
  }
}


function runStrictOperation<T>(
  operation: "compile_agent_assembly" | "prepare_agent_render",
  payload: unknown,
  options: AgenticPreprocessingCallOptions,
): Promise<T> {
  return pool.submit({
    userId: options.userId,
    operation,
    payload,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  }) as Promise<T>;
}

function runVerifierAssembly(
  payload: AgenticAssemblyInputV1,
  options: AgenticPreprocessingCallOptions,
): Promise<CompilerAssemblyPlanV1> {
  return verifierPool.submit({
    userId: options.userId,
    operation: "compile_agent_assembly",
    payload,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  }) as Promise<CompilerAssemblyPlanV1>;
}

/**
 * Compile a frozen Agentic assembly snapshot in two independent, terminable
 * isolates. The verifier is not a second semantic output: its bytes are
 * discarded after exact comparison with the accepted primary result.
 */
export async function compileAgentAssemblyPlan(
  input: AgenticAssemblyInputV1,
  options: AgenticPreprocessingCallOptions,
): Promise<CompilerAssemblyPlanV1> {
  const release = pairedAssemblyAdmission.acquire(options.userId);
  if (!release) {
    throw new IsolatePoolError("queue_full", "Agentic assembly verification capacity is full");
  }
  try {
    const sourceSnapshot = assemblySnapshotOf(input);
    const totalCpuMs = sourceSnapshot.limits.maxCooperativeCpuMs;
    if (!Number.isSafeInteger(totalCpuMs) || totalCpuMs < 2) {
      throw new IsolatePoolError("limit_exceeded", "Agentic assembly requires two positive CPU budgets");
    }
    const requestedTimeoutMs = options.timeoutMs ?? HOST_PREPARATION_LIMITS_V1.maxWallClockMs;
    if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0) {
      throw new IsolatePoolError("invalid_input", "Agentic assembly timeout is invalid");
    }
    const timeoutMs = Math.min(requestedTimeoutMs, HOST_PREPARATION_LIMITS_V1.maxWallClockMs);
    const primaryCpuMs = Math.floor(totalCpuMs / 2);
    const verifierCpuMs = totalCpuMs - primaryCpuMs;
    const pairedSignal = new AbortController();
    const onAbort = () => pairedSignal.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    let deadlineExceeded = false;
    const deadlineTimer = setTimeout(() => {
      deadlineExceeded = true;
      pairedSignal.abort(new Error("Agentic assembly wall deadline exceeded"));
    }, timeoutMs);
    (deadlineTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    const primaryOptions = {
      ...options,
      signal: pairedSignal.signal,
      timeoutMs: Math.min(timeoutMs, primaryCpuMs),
    };
    const verifierOptions = {
      ...options,
      signal: pairedSignal.signal,
      timeoutMs: Math.min(timeoutMs, verifierCpuMs),
    };
    try {
      const primaryPromise = runStrictOperation<CompilerAssemblyPlanV1>(
        "compile_agent_assembly",
        input,
        primaryOptions,
      );
      const verifierPromise = runVerifierAssembly(input, verifierOptions);
      try {
        const [primaryRaw, verifier] = await Promise.all([primaryPromise, verifierPromise]);
        const primary = primaryRaw;
        await validateAssemblyPlanAgainstSnapshotV1(primary, sourceSnapshot);
        assertPairedAssemblyResultsV1(primary, verifier);
        return primary;
      } catch (error) {
        pairedSignal.abort(error);
        await Promise.allSettled([primaryPromise, verifierPromise]);
        if (deadlineExceeded) {
          throw new IsolatePoolError("worker_timed_out", "Agentic assembly verification timed out", { cause: error });
        }
        throw error;
      }
    } finally {
      clearTimeout(deadlineTimer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    release();
  }
}

/**
 * Prepare frozen Agentic render bytes and typed deltas in a strict isolate.
 * Provider calls, live DB access, and callback registries are unavailable to
 * the worker entrypoint; failure is surfaced to Agentic admission as-is.
 */
export function prepareAgentRender(
  input: RenderPreparationInputV1,
  options: AgenticPreprocessingCallOptions,
): Promise<RenderPreparationResultV1> {
  return runStrictOperation<RenderPreparationResultV1>("prepare_agent_render", input, options);
}

export function getAgenticPreprocessingHealth() {
  return getIsolateHealthSnapshot();
}

export async function shutdownAgenticPreprocessingPool(): Promise<void> {
  await Promise.all([pool.shutdown(), verifierPool.shutdown()]);
}

export type { IsolateResponseEnvelopeV1 };
