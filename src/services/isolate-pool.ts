import { fileURLToPath } from "node:url";
import {
  createLengthPrefixedSubprocessTransport,
  defaultIsolateCommand,
} from "./isolate-process";
import {
  DEFAULT_ISOLATE_MAX_FRAME_BYTES,
  decodeLengthPrefixedJson,
  IsolateProtocolError,
  isIsolateStartedEnvelopeV1,
  isIsolateResponseEnvelopeV1,
  makeRequestEnvelopeV1,
  normalizeIsolateMaxFrameBytes,
  preflightEncodedFrame,
  type IsolateResponseEnvelopeV1,
} from "./isolate-protocol";
import {
  isPreparationFailureCode,
  lowerPreparationLimitsV1,
} from "../types/agent-preprocessing";
import {
  isRegexValidationErrorCode,
  type RegexValidationErrorCode,
} from "../utils/regex-limits";
import type {
  PreparationFailureCode,
  PreparationLimitsOverrideV1,
} from "../types/agent-preprocessing";
export type IsolatePoolFailureCode = PreparationFailureCode | RegexValidationErrorCode;

export type IsolateBackendKind = "worker" | "subprocess";
export type IsolateBackendStatus = "unknown" | "healthy" | "unavailable";

export interface IsolateHealthSnapshotV1 {
  readonly epoch: number;
  readonly worker: IsolateBackendStatus;
  readonly subprocess: IsolateBackendStatus;
  readonly selected: IsolateBackendKind | "unavailable";
  readonly workerReason: string | null;
  readonly subprocessReason: string | null;
  readonly checkedAt: number | null;
}

export type IsolateTimeoutPhase = "startup" | "execution";

export class IsolatePoolError extends Error {
  readonly code: IsolatePoolFailureCode;
  readonly failureCode: IsolatePoolFailureCode;
  readonly retryable: boolean;
  readonly remote: boolean;
  readonly timeoutPhase?: IsolateTimeoutPhase;
  readonly timeoutMs?: number;

  constructor(
    code: IsolatePoolFailureCode,
    message: string,
    options?: {
      cause?: unknown;
      retryable?: boolean;
      remote?: boolean;
      timeoutPhase?: IsolateTimeoutPhase;
      timeoutMs?: number;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "IsolatePoolError";
    this.code = code;
    this.failureCode = code;
    this.retryable = options?.retryable ?? (code !== "invalid_input" && code !== "limit_exceeded");
    this.remote = options?.remote ?? false;
    this.timeoutPhase = options?.timeoutPhase;
    this.timeoutMs = options?.timeoutMs;
  }
}
export type IsolateFailureCodeV1 = IsolatePoolFailureCode;

export interface IsolateWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void | Promise<void>;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
}

export interface IsolateTransport {
  readonly kind: IsolateBackendKind;
  readonly pid?: number | null;
  send(message: unknown): void | Promise<void>;
  onMessage(handler: (message: unknown) => void): () => void;
  onError(handler: (error: unknown) => void): () => void;
  terminate(signal?: "SIGTERM" | "SIGKILL"): void | Promise<void>;
}

export interface IsolatePoolJob<TRequest> {
  readonly userId: string;
  readonly operation: string;
  readonly payload: TRequest;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Optional caller-owned absolute deadline that queue/startup may not exceed. */
  readonly hardDeadlineAt?: number;
}

export interface IsolatePoolOptions<TRequest, TResult> {
  readonly name?: string;
  readonly maxWorkers?: number;
  readonly maxQueuedPerUser?: number;
  readonly maxQueuedGlobal?: number;
  readonly maxFrameBytes?: number;
  readonly defaultTimeoutMs?: number;
  readonly workerUrl?: string | URL;
  readonly subprocessCommand?: string[];
  readonly subprocessCwd?: string;
  readonly subprocessEnv?: Record<string, string | undefined>;
  readonly workerFactory?: () => IsolateTransport;
  readonly subprocessFactory?: () => IsolateTransport;
  readonly workerRequest?: (job: ActiveIsolateJob<TRequest, TResult>) => unknown;
  readonly subprocessRequest?: (job: ActiveIsolateJob<TRequest, TResult>) => unknown;
  readonly responseParser?: (message: unknown, job: ActiveIsolateJob<TRequest, TResult>) => TResult | Promise<TResult>;
  /**
   * Opt-in framed acknowledgement that separates Worker startup from the
   * execution budget. Pools without this hook keep admission-to-settlement
   * wall-clock timing unchanged.
   */
  readonly workerStartAcknowledgement?: (
    message: unknown,
    job: ActiveIsolateJob<TRequest, TResult>,
  ) => boolean;
  readonly workerStartTimeoutMs?: number;
  /**
   * Optional test/host probe for one newly created transport. A replacement is
   * healthy only after this probe resolves.
   */
  readonly transportProbe?: (
    kind: IsolateBackendKind,
    transport: IsolateTransport,
  ) => void | Promise<void>;
  readonly backend?: "auto" | IsolateBackendKind;
  readonly disabled?: boolean;
}

export interface ActiveIsolateJob<TRequest, TResult> extends IsolatePoolJob<TRequest> {
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly resolve: (value: TResult) => void;
  /** Current phase deadline; reset on start acknowledgement for opted-in pools. */
  deadlineAt: number;
  readonly reject: (error: unknown) => void;
  /** Number of bounded backend failovers already attempted for this request. */
  backendFailovers?: number;
  /** True once this request has entered execution on any backend. */
  executionStarted?: boolean;
  settled: boolean;
  queueTimer?: ReturnType<typeof setTimeout>;
}

interface PoolSlot<TRequest, TResult> {
  readonly id: number;
  readonly transport: IsolateTransport;
  job: ActiveIsolateJob<TRequest, TResult> | null;
  timeout: ReturnType<typeof setTimeout> | undefined;
  /** Pool-local backend epoch; invalidates stale replacement completions. */
  backendEpoch: number;
  /** Global health epoch observed after this transport's successful probe. */
  healthEpoch: number;
  generation: number;
  retired: boolean;
  detachMessage?: () => void;
  detachError?: () => void;
}


let health: IsolateHealthSnapshotV1 = Object.freeze({
  epoch: 0,
  worker: "unknown",
  subprocess: "unknown",
  selected: "unavailable",
  workerReason: null,
  subprocessReason: null,
  checkedAt: null,
});
let startupProbe: Promise<IsolateHealthSnapshotV1> | null = null;
let startupGeneration = 0;
let backendHealthEpoch: Record<IsolateBackendKind, number> = {
  worker: 0,
  subprocess: 0,
};

function getBackendHealthEpoch(kind: IsolateBackendKind): number {
  return backendHealthEpoch[kind];
}

function updateHealth(
  kind: IsolateBackendKind,
  status: IsolateBackendStatus,
  reason: string | null,
  expectedEpoch?: number,
): boolean {
  if (expectedEpoch !== undefined && getBackendHealthEpoch(kind) !== expectedEpoch) return false;
  const nextWorker = kind === "worker" ? status : health.worker;
  const nextSubprocess = kind === "subprocess" ? status : health.subprocess;
  const nextWorkerReason = kind === "worker" ? reason : health.workerReason;
  const nextSubprocessReason = kind === "subprocess" ? reason : health.subprocessReason;
  const selected = nextWorker === "healthy"
    ? "worker"
    : nextSubprocess === "healthy" ? "subprocess" : "unavailable";
  if (
    health.worker === nextWorker
    && health.subprocess === nextSubprocess
    && health.selected === selected
    && health.workerReason === nextWorkerReason
    && health.subprocessReason === nextSubprocessReason
  ) return true;
  backendHealthEpoch[kind] += 1;
  health = Object.freeze({
    epoch: health.epoch + 1,
    worker: nextWorker,
    subprocess: nextSubprocess,
    selected,
    workerReason: nextWorkerReason,
    subprocessReason: nextSubprocessReason,
    checkedAt: Date.now(),
  });
  return true;
}

export function hasHealthyTerminableIsolate(): boolean {
  return health.selected !== "unavailable";
}

export function getIsolateHealthEpoch(): number {
  return health.epoch;
}

export function getIsolateHealthSnapshot(): IsolateHealthSnapshotV1 {
  return health;
}

export function resetIsolateHealthForTests(): void {
  startupProbe = null;
  startupGeneration++;
  backendHealthEpoch = {
    worker: 0,
    subprocess: 0,
  };
  health = Object.freeze({
    epoch: 0,
    worker: "unknown",
    subprocess: "unknown",
    selected: "unavailable",
    workerReason: null,
    subprocessReason: null,
    checkedAt: null,
  });
}

const ISOLATE_TERMINATION_CONFIRMATION_MS = 1_000;

async function boundedTermination(
  operation: () => void | Promise<void>,
  label: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ISOLATE_TERMINATION_CONFIRMATION_MS);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  });
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function probeWorkerLifecycle(): Promise<void> {
  const probeUrl = new URL("./isolate-worker-probe.ts", import.meta.url);
  const WorkerCtor = globalThis.Worker;
  if (typeof WorkerCtor !== "function") throw new Error("Bun Worker is unavailable");
  const runProbe = async (): Promise<void> => {
    const worker = new WorkerCtor(probeUrl, { type: "module" });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error("Bun Worker startup probe timed out"));
        }, 1_000);
        worker.onmessage = (event: MessageEvent) => {
          if (settled || event.data?.type !== "ready") return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        worker.onerror = (event: ErrorEvent) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(event.message || "Bun Worker startup probe failed"));
        };
      });
    } finally {
      await boundedTermination(
        () => worker.terminate(),
        "Bun Worker startup probe termination",
      );
    }
  };
  await runProbe();
  await runProbe();
}

async function probeSubprocessLifecycle(): Promise<void> {
  const entrypoint = fileURLToPath(new URL("./isolate-process-probe.ts", import.meta.url));
  const command = defaultIsolateCommand(entrypoint);
  const transport = createLengthPrefixedSubprocessTransport({
    command,
    maxFrameBytes: 64 * 1024,
  });
  try {
    const requestId = crypto.randomUUID();
    const response = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Isolate subprocess startup probe timed out")), 2_000);
      transport.onMessage((message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      transport.onError((error) => {
        clearTimeout(timeout);
        reject(error);
      });
      transport.send(makeRequestEnvelopeV1(requestId, "probe", null)).catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    if (!isIsolateResponseEnvelopeV1(response) || response.requestId !== requestId || response.type !== "result") {
      throw new Error("Isolate subprocess startup probe returned a malformed response");
    }
  } finally {
    await terminateTransport(transport, "SIGKILL");
  }
}

/**
 * Probe both terminable backends before Agentic admission. This is deliberately
 * separate from database reconciliation: a missing/unstable isolate backend
 * makes Agentic unavailable but must not prevent Response startup.
 */
export function probeIsolateBackendsAtStartup(): Promise<IsolateHealthSnapshotV1> {
  if (startupProbe) return startupProbe;
  const generation = ++startupGeneration;
  startupProbe = (async () => {
    const workerExpectedEpoch = getBackendHealthEpoch("worker");
    try {
      await probeWorkerLifecycle();
      if (startupGeneration !== generation) return health;
      updateHealth("worker", "healthy", null, workerExpectedEpoch);
    } catch (error) {
      if (startupGeneration !== generation) return health;
      updateHealth(
        "worker",
        "unavailable",
        error instanceof Error ? error.message : String(error),
        workerExpectedEpoch,
      );
    }
    const subprocessExpectedEpoch = getBackendHealthEpoch("subprocess");
    try {
      await probeSubprocessLifecycle();
      if (startupGeneration !== generation) return health;
      updateHealth("subprocess", "healthy", null, subprocessExpectedEpoch);
    } catch (error) {
      if (startupGeneration !== generation) return health;
      updateHealth(
        "subprocess",
        "unavailable",
        error instanceof Error ? error.message : String(error),
        subprocessExpectedEpoch,
      );
    }
    health = Object.freeze({ ...health, checkedAt: Date.now() });
    return health;
  })();
  return startupProbe;
}

function createDefaultWorkerTransport<TRequest, TResult>(
  options: IsolatePoolOptions<TRequest, TResult>,
  maxFrameBytes: number,
): IsolateTransport {
  const configuredWorkerUrl = options.workerUrl;
  if (configuredWorkerUrl === undefined) {
    throw new Error("workerUrl is required for worker backend");
  }
  const workerUrl = configuredWorkerUrl instanceof URL
    ? new URL(configuredWorkerUrl.href)
    : new URL(configuredWorkerUrl, import.meta.url);
  workerUrl.searchParams.set("maxFrameBytes", String(maxFrameBytes));
  const worker = new Worker(workerUrl, { type: "module" }) as unknown as IsolateWorkerLike;
  let errorHandler: ((error: unknown) => void) | null = null;
  let pendingError: unknown = null;
  const emitError = (error: unknown): void => {
    if (errorHandler) {
      errorHandler(error);
      return;
    }
    pendingError = error;
  };
  const transport: IsolateTransport = {
    kind: "worker",
    send(message) {
      const frame = preflightEncodedFrame(message, maxFrameBytes);
      worker.postMessage(frame);
    },
    onMessage(handler) {
      const listener = (event: MessageEvent) => {
        try {
          handler(decodeLengthPrefixedJson(event.data, maxFrameBytes));
        } catch (error) {
          emitError(error);
        }
      };
      worker.onmessage = listener;
      return () => {
        if (worker.onmessage === listener) worker.onmessage = null;
      };
    },
    onError(handler) {
      errorHandler = handler;
      if (pendingError !== null) {
        const error = pendingError;
        pendingError = null;
        handler(error);
      }
      const errorListener = (event: ErrorEvent) => emitError(event.message || event.error || "Worker isolate crashed");
      const messageErrorListener = (event: MessageEvent) => emitError(event);
      worker.onerror = errorListener;
      worker.onmessageerror = messageErrorListener;
      return () => {
        if (errorHandler === handler) errorHandler = null;
        if (worker.onerror === errorListener) worker.onerror = null;
        if (worker.onmessageerror === messageErrorListener) worker.onmessageerror = null;
      };
    },
    terminate() {
      return worker.terminate();
    },
  };
  return transport;
}

function createDefaultSubprocessTransport<TRequest, TResult>(
  options: IsolatePoolOptions<TRequest, TResult>,
  maxFrameBytes: number,
): IsolateTransport {
  if (!options.subprocessCommand || options.subprocessCommand.length === 0) {
    throw new Error("subprocessCommand is required for subprocess backend");
  }
  return createLengthPrefixedSubprocessTransport({
    command: options.subprocessCommand,
    cwd: options.subprocessCwd,
    env: options.subprocessEnv,
    maxFrameBytes,
  });
}

function isKnownPoolFailureCode(value: unknown): value is IsolatePoolFailureCode {
  return isPreparationFailureCode(value) || isRegexValidationErrorCode(value);
}

function toPoolFailure(
  fallbackCode: IsolatePoolFailureCode,
  message: string,
  cause?: unknown,
): IsolatePoolError {
  if (cause instanceof IsolatePoolError) return cause;
  let causeCode: unknown;
  if (typeof cause === "object" && cause !== null) {
    if ("code" in cause) causeCode = cause.code;
    if (!isKnownPoolFailureCode(causeCode) && "failureCode" in cause) {
      causeCode = cause.failureCode;
    }
  }
  const code = isKnownPoolFailureCode(causeCode) ? causeCode : fallbackCode;
  return new IsolatePoolError(code, message, { cause });
}

function transportFailureCode(error: unknown): IsolatePoolFailureCode {
  if (error instanceof IsolateProtocolError && error.code === "frame_too_large") {
    return "limit_exceeded";
  }
  return "worker_malformed";
}
function terminateTransport(
  transport: IsolateTransport,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  const termination = Promise.resolve().then(() => transport.terminate(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Isolate ${transport.kind} termination confirmation timed out`)),
      ISOLATE_TERMINATION_CONFIRMATION_MS,
    );
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    termination.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class IsolatePoolV1<TRequest, TResult> {
  private readonly maxWorkers: number;
  private readonly maxQueuedPerUser: number;
  private readonly maxQueuedGlobal: number;
  private readonly maxFrameBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly backend: "auto" | IsolateBackendKind;
  private readonly name: string;
  private readonly transportProbe?: IsolatePoolOptions<TRequest, TResult>["transportProbe"];
  private readonly usesDefaultWorkerFactory: boolean;
  private readonly usesDefaultSubprocessFactory: boolean;
  private workerFactory?: () => IsolateTransport;
  private subprocessFactory?: () => IsolateTransport;
  private readonly workerRequest: (job: ActiveIsolateJob<TRequest, TResult>) => unknown;
  private readonly subprocessRequest: (job: ActiveIsolateJob<TRequest, TResult>) => unknown;
  private readonly responseParser: (message: unknown, job: ActiveIsolateJob<TRequest, TResult>) => TResult | Promise<TResult>;
  private readonly workerStartAcknowledgement?: IsolatePoolOptions<TRequest, TResult>["workerStartAcknowledgement"];
  private readonly workerStartTimeoutMs?: number;
  private readonly disabled: boolean;
  private readonly slots = new Set<PoolSlot<TRequest, TResult>>();
  private readonly waitingByUser = new Map<string, ActiveIsolateJob<TRequest, TResult>[]>();
  private readonly readyUsers: string[] = [];
  private readonly replacementGeneration: Record<IsolateBackendKind, number> = {
    worker: 0,
    subprocess: 0,
  };

  /** Per-pool fence; a stale replacement from this pool cannot re-enter it. */
  private readonly backendEpoch: Record<IsolateBackendKind, number> = {
    worker: 0,
    subprocess: 0,
  };
  private readonly pendingStarts = new Set<Promise<void>>();
  private readonly pendingReplacements = new Set<Promise<void>>();
  private readonly pendingRetirements = new Set<Promise<void>>();
  private recoveryProbe: Promise<void> | null = null;
  private recoveryCooldownUntil = 0;
  private waitingCount = 0;
  private nextSlotId = 1;
  private creatingSlots = 0;
  private draining = false;
  private drainRequested = false;
  private closed = false;
  private lastDispatchedUser: string | null = null;

  constructor(options: IsolatePoolOptions<TRequest, TResult>) {
    this.name = options.name ?? "isolate";
    const requestedLimits: PreparationLimitsOverrideV1 = {
      ...(options.maxWorkers === undefined ? {} : { maxWorkers: options.maxWorkers }),
      ...(options.maxQueuedPerUser === undefined ? {} : { maxQueuedJobsPerUser: options.maxQueuedPerUser }),
      ...(options.maxQueuedGlobal === undefined ? {} : { maxQueuedJobsProcess: options.maxQueuedGlobal }),
      ...(options.defaultTimeoutMs === undefined ? {} : { maxWallClockMs: options.defaultTimeoutMs }),
    };
    const limits = lowerPreparationLimitsV1(requestedLimits);
    this.maxWorkers = limits.maxWorkers;
    this.maxQueuedPerUser = limits.maxQueuedJobsPerUser;
    this.maxQueuedGlobal = limits.maxQueuedJobsProcess;
    this.maxFrameBytes = normalizeIsolateMaxFrameBytes(options.maxFrameBytes);
    this.defaultTimeoutMs = limits.maxWallClockMs;
    this.backend = options.backend ?? "auto";
    this.transportProbe = options.transportProbe;
    this.usesDefaultWorkerFactory = !options.workerFactory && Boolean(options.workerUrl);
    this.usesDefaultSubprocessFactory = !options.subprocessFactory && Boolean(options.subprocessCommand?.length);
    this.workerFactory = options.workerFactory;
    this.subprocessFactory = options.subprocessFactory;
    this.disabled = options.disabled ?? false;
    this.workerRequest = options.workerRequest ?? ((job) => makeRequestEnvelopeV1(job.requestId, job.operation, job.payload));
    this.subprocessRequest = options.subprocessRequest ?? this.workerRequest;
    this.responseParser = options.responseParser ?? ((message, job) => this.parseDefaultResponse(message, job));
    this.workerStartAcknowledgement = options.workerStartAcknowledgement;
    if (this.workerStartAcknowledgement) {
      const workerStartTimeoutMs = options.workerStartTimeoutMs ?? 5_000;
      if (!Number.isSafeInteger(workerStartTimeoutMs) || workerStartTimeoutMs <= 0) {
        throw new RangeError("workerStartTimeoutMs must be a positive integer");
      }
      this.workerStartTimeoutMs = workerStartTimeoutMs;
    } else if (options.workerStartTimeoutMs !== undefined) {
      throw new RangeError("workerStartTimeoutMs requires workerStartAcknowledgement");
    }
    if (!this.workerFactory && options.workerUrl) {
      this.workerFactory = () => createDefaultWorkerTransport(options, this.maxFrameBytes);
    }
    if (!this.subprocessFactory && options.subprocessCommand) {
      this.subprocessFactory = () => createDefaultSubprocessTransport(options, this.maxFrameBytes);
    }
  }


  submit(jobInput: IsolatePoolJob<TRequest>): Promise<TResult> {
    if (this.closed) {
      return Promise.reject(toPoolFailure("worker_unavailable", this.name + " pool is closed"));
    }
    if (this.disabled) {
      return Promise.reject(toPoolFailure("worker_disabled", this.name + " pool is disabled"));
    }
    if (!jobInput.userId || !jobInput.operation) {
      return Promise.reject(toPoolFailure("invalid_input", this.name + " job identity is incomplete"));
    }
    const requestedTimeoutMs = jobInput.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0) {
      return Promise.reject(toPoolFailure("invalid_input", this.name + " timeout is invalid"));
    }
    if (jobInput.hardDeadlineAt !== undefined && !Number.isFinite(jobInput.hardDeadlineAt)) {
      return Promise.reject(toPoolFailure("invalid_input", this.name + " hard deadline is invalid"));
    }
    const boundedTimeoutMs = Math.min(requestedTimeoutMs, this.defaultTimeoutMs);
    if (jobInput.signal?.aborted) {
      return Promise.reject(toPoolFailure("cancelled", this.name + " job was cancelled before admission"));
    }

    const now = Date.now();
    const hardDeadlineAt = jobInput.hardDeadlineAt ?? Number.POSITIVE_INFINITY;
    if (hardDeadlineAt <= now) {
      return Promise.reject(toPoolFailure("worker_timed_out", this.name + " hard deadline elapsed before admission"));
    }
    const phaseTimed = this.workerStartAcknowledgement !== undefined;
    const initialDeadlineAt = phaseTimed
      ? hardDeadlineAt
      : Math.min(now + boundedTimeoutMs, hardDeadlineAt);
    const queuedForUser = this.waitingByUser.get(jobInput.userId)?.length ?? 0;
    if (queuedForUser >= this.maxQueuedPerUser || this.waitingCount >= this.maxQueuedGlobal) {
      return Promise.reject(toPoolFailure("queue_full", this.name + " queue capacity is exhausted"));
    }
    return new Promise<TResult>((resolve, reject) => {
      const job: ActiveIsolateJob<TRequest, TResult> = {
        ...jobInput,
        requestId: crypto.randomUUID(),
        deadlineAt: initialDeadlineAt,
        timeoutMs: boundedTimeoutMs,
        resolve,
        reject,
        settled: false,
      };
      const queue = this.waitingByUser.get(job.userId);
      if (queue) queue.push(job);
      else {
        this.waitingByUser.set(job.userId, [job]);
        this.readyUsers.push(job.userId);
      }
      this.waitingCount++;
      if (Number.isFinite(initialDeadlineAt)) {
        job.queueTimer = setTimeout(() => {
          if (job.settled) return;
          this.cancelJob(
            job,
            toPoolFailure("worker_timed_out", this.name + " isolate exceeded its wall-clock deadline"),
          );
        }, Math.max(0, initialDeadlineAt - now));
      }
      if (job.signal) {
        const onAbort = () => this.cancelJob(job);
        (job as ActiveIsolateJob<TRequest, TResult> & { onAbort?: () => void }).onAbort = onAbort;
        job.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.drain();
    });
  }

  queuedCount(): number {
    return this.waitingCount;
  }

  activeCount(): number {
    let active = 0;
    for (const slot of this.slots) if (slot.job) active++;
    return active;
  }

  releaseIdle(): number {
    if (this.waitingCount > 0) return 0;
    const idle = [...this.slots].filter((slot) => slot.job === null && !slot.retired);
    for (const slot of idle) {
      slot.retired = true;
      clearTimeout(slot.timeout);
      slot.timeout = undefined;
      this.detachSlot(slot);
      this.slots.delete(slot);
      const retirement = terminateTransport(slot.transport, "SIGKILL").catch(() => {});
      this.pendingRetirements.add(retirement);
      void retirement.finally(() => this.pendingRetirements.delete(retirement));
    }
    return idle.length;
  }
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = toPoolFailure("cancelled", `${this.name} pool shut down`);
    for (const queue of this.waitingByUser.values()) {
      for (const job of queue) this.settle(job, () => job.reject(error));
    }
    this.waitingByUser.clear();
    this.readyUsers.length = 0;
    this.waitingCount = 0;
    const terminations: Promise<void>[] = [];
    for (const slot of this.slots) {
      slot.retired = true;
      clearTimeout(slot.timeout);
      slot.timeout = undefined;
      this.detachSlot(slot);
      const job = slot.job;
      slot.job = null;
      if (job) this.settle(job, () => job.reject(error));
      terminations.push(terminateTransport(slot.transport, "SIGTERM"));
    }
    this.slots.clear();
    const pending = [
      ...terminations,
      ...this.pendingStarts,
      ...this.pendingReplacements,
      ...this.pendingRetirements,
    ];
    await Promise.allSettled(pending);
  }

  private async ensureHealth(): Promise<void> {
    if (this.backend !== "auto") return;
    const snapshot = getIsolateHealthSnapshot();
    if (snapshot.worker === "unknown" || snapshot.subprocess === "unknown") {
      await probeIsolateBackendsAtStartup();
      return;
    }
    if (snapshot.selected !== "unavailable") return;
    await this.reprobeUnavailableBackends();
  }

  private async reprobeUnavailableBackends(): Promise<void> {
    const now = Date.now();
    if (this.recoveryProbe) {
      await this.recoveryProbe;
      return;
    }
    if (now < this.recoveryCooldownUntil) return;
    this.recoveryCooldownUntil = now + 1_000;
    const probe = (async () => {
      await this.reprobeBackend("worker");
      await this.reprobeBackend("subprocess");
    })();
    this.recoveryProbe = probe;
    try {
      await probe;
    } finally {
      if (this.recoveryProbe === probe) this.recoveryProbe = null;
    }
  }

  private async reprobeBackend(kind: IsolateBackendKind): Promise<void> {
    const factory = kind === "worker" ? this.workerFactory : this.subprocessFactory;
    if (!factory) return;
    let transport: IsolateTransport | null = null;
    const expectedHealthEpoch = getBackendHealthEpoch(kind);
    let probeFailure: unknown = null;
    try {
      transport = this.createTransport(kind);
      await this.probeTransport(kind, transport, true);
    } catch (error) {
      probeFailure = error;
    }
    if (transport) {
      try {
        await terminateTransport(transport, "SIGKILL");
      } catch (error) {
        probeFailure = error;
      }
    }
    if (probeFailure !== null) {
      updateHealth(
        kind,
        "unavailable",
        probeFailure instanceof Error ? probeFailure.message : String(probeFailure),
        expectedHealthEpoch,
      );
      return;
    }
    updateHealth(kind, "healthy", null, expectedHealthEpoch);
  }

  private async probeTransport(
    kind: IsolateBackendKind,
    transport: IsolateTransport,
    force: boolean,
  ): Promise<void> {
    if (this.transportProbe) {
      await this.transportProbe(kind, transport);
      return;
    }
    const snapshot = getIsolateHealthSnapshot();
    const status = kind === "worker" ? snapshot.worker : snapshot.subprocess;
    if (!force && status === "healthy") return;
    if (kind === "worker" && this.usesDefaultWorkerFactory) {
      await probeWorkerLifecycle();
    } else if (kind === "subprocess" && this.usesDefaultSubprocessFactory) {
      await probeSubprocessLifecycle();
    }
  }

  private createTransport(kind: IsolateBackendKind): IsolateTransport {
    const factory = kind === "worker" ? this.workerFactory : this.subprocessFactory;
    if (!factory) throw new Error(`${this.name} has no ${kind} transport configured`);
    return factory();
  }

  private isHealthyBackend(kind: IsolateBackendKind): boolean {
    const snapshot = getIsolateHealthSnapshot();
    return kind === "worker" ? snapshot.worker === "healthy" : snapshot.subprocess === "healthy";
  }

  private slotEpochMatches(slot: PoolSlot<TRequest, TResult>): boolean {
    return slot.backendEpoch === this.backendEpoch[slot.transport.kind]
      && slot.healthEpoch === getBackendHealthEpoch(slot.transport.kind);
  }

  private advanceBackendEpoch(kind: IsolateBackendKind): number {
    this.backendEpoch[kind] += 1;
    return this.backendEpoch[kind];
  }


  private retireIdleUnhealthySlots(): void {
    for (const slot of [...this.slots]) {
      if (
        slot.job !== null
        || (this.isHealthyBackend(slot.transport.kind) && this.slotEpochMatches(slot))
      ) continue;
      slot.retired = true;
      clearTimeout(slot.timeout);
      slot.timeout = undefined;
      this.detachSlot(slot);
      this.slots.delete(slot);
      this.creatingSlots++;
      const retirement = terminateTransport(slot.transport, "SIGKILL").catch(() => {});
      this.pendingRetirements.add(retirement);
      void retirement.then(() => {
        this.pendingRetirements.delete(retirement);
        this.creatingSlots--;
        if (!this.closed) this.drain();
      });
    }
  }

  private selectedBackend(): IsolateBackendKind | null {
    const snapshot = getIsolateHealthSnapshot();
    if (this.backend === "worker") {
      return this.workerFactory && snapshot.worker !== "unavailable" ? "worker" : null;
    }
    if (this.backend === "subprocess") {
      return this.subprocessFactory && snapshot.subprocess !== "unavailable" ? "subprocess" : null;
    }
    if (snapshot.worker === "healthy" && this.workerFactory) return "worker";
    if (snapshot.subprocess === "healthy" && this.subprocessFactory) return "subprocess";
    return null;
  }
  private alternateBackend(failedKind: IsolateBackendKind): IsolateBackendKind | null {
    if (this.backend !== "auto" || failedKind !== "worker" || !this.subprocessFactory) return null;
    return this.isHealthyBackend("subprocess") ? "subprocess" : null;
  }


  private drain(): void {
    if (this.closed) return;
    if (this.draining) {
      this.drainRequested = true;
      return;
    }
    this.draining = true;
    const drainTask = this.drainAsync();
    void drainTask.then(
      () => {
        this.draining = false;
        const shouldDrainAgain = this.drainRequested;
        this.drainRequested = false;
        if (!this.closed && shouldDrainAgain) this.drain();
      },
      () => {
        this.draining = false;
        const shouldDrainAgain = this.drainRequested;
        this.drainRequested = false;
        if (!this.closed && shouldDrainAgain) this.drain();
      },
    );
  }
  private async drainAsync(): Promise<void> {
    if (this.backend === "auto") {
      if (getIsolateHealthSnapshot().selected === "unavailable") {
        this.retireIdleUnhealthySlots();
      }
      await this.ensureHealth().catch(() => {});
    }
    while (!this.closed && this.waitingCount > 0) {
      this.retireIdleUnhealthySlots();
      const idle = [...this.slots].find(
        (slot) =>
          slot.job === null
          && this.isHealthyBackend(slot.transport.kind)
          && this.slotEpochMatches(slot),
      );
      if (idle) {
        const job = this.dequeueFairJob();
        if (!job) break;
        void this.dispatchJob(idle, job);
        continue;
      }
      if (this.slots.size + this.creatingSlots >= this.maxWorkers) break;
      const job = this.dequeueFairJob();
      if (!job) break;
      this.creatingSlots++;
      const startPromise = this.startJob(job);
      this.pendingStarts.add(startPromise);
      void startPromise.then(
        () => {
          this.pendingStarts.delete(startPromise);
          if (!this.closed && this.waitingCount > 0) this.drain();
        },
        () => {
          this.pendingStarts.delete(startPromise);
          if (!this.closed && this.waitingCount > 0) this.drain();
        },
      );
    }
  }

  private dequeueFairJob(): ActiveIsolateJob<TRequest, TResult> | null {
    while (this.readyUsers.length > 0) {
      const userIndex = this.readyUsers.length > 1 && this.readyUsers[0] === this.lastDispatchedUser ? 1 : 0;
      const userId = this.readyUsers.splice(userIndex, 1)[0]!;
      const queue = this.waitingByUser.get(userId);
      if (!queue || queue.length === 0) {
        this.waitingByUser.delete(userId);
        continue;
      }
      const job = queue.shift()!;
      this.waitingCount--;
      if (queue.length > 0) this.readyUsers.push(userId);
      else this.waitingByUser.delete(userId);
      this.lastDispatchedUser = userId;
      return job;
    }
    return null;
  }

  private remainingWallClockMs(job: ActiveIsolateJob<TRequest, TResult>): number {
    return Math.max(0, job.deadlineAt - Date.now());
  }

  private async startJob(job: ActiveIsolateJob<TRequest, TResult>): Promise<void> {
    let slotCreated = false;
    try {
      if (job.settled) return;
      let kind = this.selectedBackend();
      if (!kind) {
        this.settle(job, () => job.reject(toPoolFailure("worker_unavailable", `${this.name} has no healthy terminable backend`)));
        return;
      }
      let transport: IsolateTransport;
      let createdTransport: IsolateTransport | null = null;
      let slotHealthEpoch = getBackendHealthEpoch(kind);
      let slotBackendEpoch = this.backendEpoch[kind];
      let expectedHealthEpoch = slotHealthEpoch;
      try {
        createdTransport = this.createTransport(kind);
        await this.probeTransport(kind, createdTransport, false);
        if (!updateHealth(kind, "healthy", null, expectedHealthEpoch)) {
          throw new Error(`${this.name} ${kind} health epoch changed during probe`);
        }
        transport = createdTransport;
        slotHealthEpoch = getBackendHealthEpoch(kind);
        slotBackendEpoch = this.backendEpoch[kind];
      } catch (error) {
        if (createdTransport) {
          await terminateTransport(createdTransport, "SIGKILL").catch(() => {});
          createdTransport = null;
        }
        updateHealth(
          kind,
          "unavailable",
          error instanceof Error ? error.message : String(error),
          expectedHealthEpoch,
        );
        if (this.closed || job.settled) {
          this.settle(job, () => job.reject(toPoolFailure("cancelled", `${this.name} pool shut down`)));
          return;
        }
        if (this.backend === "auto" && kind === "worker" && this.subprocessFactory) {
          kind = "subprocess";
          expectedHealthEpoch = getBackendHealthEpoch(kind);
          try {
            createdTransport = this.createTransport(kind);
            await this.probeTransport(kind, createdTransport, false);
            if (!updateHealth(kind, "healthy", null, expectedHealthEpoch)) {
              throw new Error(`${this.name} ${kind} health epoch changed during probe`);
            }
            transport = createdTransport;
            slotHealthEpoch = getBackendHealthEpoch(kind);
            slotBackendEpoch = this.backendEpoch[kind];
          } catch (fallbackError) {
            if (createdTransport) {
              await terminateTransport(createdTransport, "SIGKILL").catch(() => {});
            }
            updateHealth(
              kind,
              "unavailable",
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
              expectedHealthEpoch,
            );
            this.settle(job, () => job.reject(toPoolFailure("worker_unavailable", `${this.name} could not start an isolate`, fallbackError)));
            return;
          }
        } else {
          this.settle(job, () => job.reject(toPoolFailure("worker_unavailable", `${this.name} could not start an isolate`, error)));
          return;
        }
      }
      if (this.closed || job.settled) {
        await terminateTransport(transport, "SIGKILL").catch(() => {});
        this.settle(job, () => job.reject(toPoolFailure("cancelled", `${this.name} pool shut down`)));
        return;
      }
      const slot: PoolSlot<TRequest, TResult> = {
        id: this.nextSlotId++,
        transport,
        job: null,
        timeout: undefined,
        backendEpoch: slotBackendEpoch,
        healthEpoch: slotHealthEpoch,
        generation: 0,
        retired: false,
      };
      this.slots.add(slot);
      slotCreated = true;
      this.creatingSlots--;
      await this.dispatchJob(slot, job, kind);
    } finally {
      if (!slotCreated) this.creatingSlots--;
    }
  }

  private async dispatchJob(
    slot: PoolSlot<TRequest, TResult>,
    job: ActiveIsolateJob<TRequest, TResult>,
    kind: IsolateBackendKind = slot.transport.kind,
  ): Promise<void> {
    if (slot.retired || job.settled || this.closed) return;
    if (!this.isHealthyBackend(slot.transport.kind) || !this.slotEpochMatches(slot)) {
      const failure = toPoolFailure(
        "worker_unavailable",
        this.name + " transport health epoch is stale",
      );
      this.retireIdleUnhealthySlots();
      if (!this.requeueFailedJob(job)) this.settle(job, () => job.reject(failure));
      this.drain();
      return;
    }
    slot.job = job;
    const generation = ++slot.generation;
    const startAcknowledgement = kind === "worker"
      ? this.workerStartAcknowledgement
      : undefined;
    let phase: IsolateTimeoutPhase = startAcknowledgement ? "startup" : "execution";
    let responseSeen = false;
    const current = (): boolean =>
      !slot.retired
      && slot.generation === generation
      && slot.job === job
      && !job.settled
      && this.slotEpochMatches(slot);
    const timeoutFailure = (
      timeoutPhase: IsolateTimeoutPhase,
      timeoutMs: number,
    ): IsolatePoolError => new IsolatePoolError(
      "worker_timed_out",
      timeoutPhase === "startup"
        ? this.name + " Worker did not acknowledge the request within " + timeoutMs + "ms"
        : this.name + " isolate exceeded its " + timeoutMs + "ms execution deadline",
      { timeoutPhase, timeoutMs },
    );
    let activeTimeoutMs = job.timeoutMs;
    const armTimeout = (
      nextPhase: IsolateTimeoutPhase,
      timeoutMs: number,
      resetDeadline: boolean,
    ): boolean => {
      clearTimeout(slot.timeout);
      activeTimeoutMs = timeoutMs;
      phase = nextPhase;
      if (resetDeadline) {
        job.deadlineAt = Math.min(
          Date.now() + timeoutMs,
          job.hardDeadlineAt ?? Number.POSITIVE_INFINITY,
        );
      }
      const remainingMs = this.remainingWallClockMs(job);
      if (remainingMs <= 0) return false;
      slot.timeout = setTimeout(() => {
        if (job.settled || slot.job !== job) return;
        this.failSlot(slot, timeoutFailure(nextPhase, timeoutMs), generation);
      }, remainingMs);
      return true;
    };
    const onMessage = (message: unknown) => {
      if (slot.retired || slot.generation !== generation) return;
      if (!this.slotEpochMatches(slot)) {
        this.failSlot(slot, toPoolFailure("worker_unavailable", this.name + " transport health epoch changed"), generation);
        return;
      }
      if (responseSeen) {
        this.failSlot(slot, toPoolFailure("worker_malformed", this.name + " returned a trailing response"), generation);
        return;
      }
      if (!current()) return;
      if (startAcknowledgement) {
        let acknowledged = false;
        try {
          acknowledged = startAcknowledgement(message, job);
        } catch (error) {
          this.failSlot(
            slot,
            toPoolFailure("worker_malformed", this.name + " start acknowledgement is invalid", error),
            generation,
          );
          return;
        }
        if (phase === "startup") {
          if (!acknowledged) {
            this.failSlot(
              slot,
              toPoolFailure("worker_malformed", this.name + " returned a response before start acknowledgement"),
              generation,
            );
            return;
          }
          const resetExecutionDeadline = !job.executionStarted;
          job.executionStarted = true;
          if (!armTimeout("execution", job.timeoutMs, resetExecutionDeadline)) {
            this.failSlot(slot, timeoutFailure("execution", job.timeoutMs), generation);
          }
          return;
        }
        if (acknowledged) {
          this.failSlot(
            slot,
            toPoolFailure("worker_malformed", this.name + " returned a duplicate start acknowledgement"),
            generation,
          );
          return;
        }
      }
      responseSeen = true;
      this.finishSlot(slot, message, generation);
    };
    const onError = (error: unknown) => {
      if (slot.retired || slot.generation !== generation) return;
      if (!this.slotEpochMatches(slot)) {
        this.failSlot(slot, toPoolFailure("worker_unavailable", this.name + " transport health epoch changed"), generation);
        return;
      }
      if (!responseSeen && !current()) return;
      const code = error instanceof IsolateProtocolError
        ? transportFailureCode(error)
        : "worker_crashed";
      this.failSlot(slot, toPoolFailure(code, this.name + " isolate failed", error), generation);
    };
    slot.detachMessage = slot.transport.onMessage(onMessage);
    slot.detachError = slot.transport.onError(onError);
    if (job.queueTimer) {
      clearTimeout(job.queueTimer);
      job.queueTimer = undefined;
    }
    const phaseTimeoutMs = startAcknowledgement
      ? this.workerStartTimeoutMs!
      : job.timeoutMs;
    const usesPhasedTiming = this.workerStartAcknowledgement !== undefined;
    const resetDeadline = startAcknowledgement !== undefined
      || (usesPhasedTiming && !job.executionStarted);
    if (!startAcknowledgement && usesPhasedTiming && !job.executionStarted) {
      job.executionStarted = true;
    }
    if (!armTimeout(phase, phaseTimeoutMs, resetDeadline)) {
      this.rejectBeforeSend(
        slot,
        job,
        timeoutFailure(phase, activeTimeoutMs),
        generation,
      );
      return;
    }
    let request: unknown;
    let frame: Uint8Array;
    try {
      request = kind === "worker" ? this.workerRequest(job) : this.subprocessRequest(job);
      frame = preflightEncodedFrame(request, this.maxFrameBytes);
    } catch (error) {
      const failure = error instanceof IsolatePoolError
        ? error
        : toPoolFailure(transportFailureCode(error), this.name + " isolate request is invalid", error);
      this.rejectBeforeSend(slot, job, failure, generation);
      return;
    }
    if (this.remainingWallClockMs(job) <= 0) {
      this.failSlot(slot, timeoutFailure(phase, activeTimeoutMs), generation);
      return;
    }
    try {
      await slot.transport.send(frame);
      if (current() && this.remainingWallClockMs(job) <= 0) {
        this.failSlot(slot, timeoutFailure(phase, activeTimeoutMs), generation);
      }
    } catch (error) {
      this.failSlot(
        slot,
        error instanceof IsolatePoolError
          ? error
          : toPoolFailure(transportFailureCode(error), this.name + " isolate request failed", error),
        generation,
      );
    }
  }
  private rejectBeforeSend(
    slot: PoolSlot<TRequest, TResult>,
    job: ActiveIsolateJob<TRequest, TResult>,
    error: IsolatePoolError,
    generation: number,
  ): void {
    if (slot.retired || slot.generation !== generation || slot.job !== job) return;
    clearTimeout(slot.timeout);
    slot.timeout = undefined;
    this.detachSlot(slot);
    slot.job = null;
    this.settle(job, () => job.reject(error));
    this.drain();
  }

  private detachSlot(slot: PoolSlot<TRequest, TResult>): void {
    slot.detachMessage?.();
    slot.detachError?.();
    slot.detachMessage = undefined;
    slot.detachError = undefined;
  }

  private requeueFailedJob(job: ActiveIsolateJob<TRequest, TResult>): boolean {
    if (
      this.closed
      || job.settled
      || job.signal?.aborted
      || this.remainingWallClockMs(job) <= 0
    ) return false;
    const queue = this.waitingByUser.get(job.userId);
    if (
      (queue?.length ?? 0) >= this.maxQueuedPerUser
      || this.waitingCount >= this.maxQueuedGlobal
    ) {
      return false;
    }
    if (queue) {
      queue.push(job);
    } else {
      this.waitingByUser.set(job.userId, [job]);
      this.readyUsers.push(job.userId);
    }
    this.waitingCount++;
    return true;
  }

  private finishSlot(
    slot: PoolSlot<TRequest, TResult>,
    message: unknown,
    generation: number,
  ): void {
    if (slot.retired || slot.generation !== generation) return;
    if (!this.slotEpochMatches(slot)) {
      this.failSlot(slot, toPoolFailure("worker_unavailable", `${this.name} transport health epoch changed`), generation);
      return;
    }
    const job = slot.job;
    if (!job) return;
    if (this.remainingWallClockMs(job) <= 0) {
      this.failSlot(
        slot,
        toPoolFailure("worker_timed_out", `${this.name} isolate exceeded its ${job.timeoutMs}ms wall-clock deadline`),
        generation,
      );
      return;
    }
    this.detachSlot(slot);
    try {
      const parsed = this.responseParser(message, job);
      if (parsed && typeof parsed === "object" && typeof (parsed as Promise<TResult>).then === "function") {
        void Promise.resolve(parsed).then(
          (result) => this.completeParsedSlot(slot, job, result, generation),
          (error) => this.failParsedSlot(slot, job, error, generation),
        );
        return;
      }
      this.completeParsedSlot(slot, job, parsed as TResult, generation);
    } catch (error) {
      this.failParsedSlot(slot, job, error, generation);
    }
  }

  private completeParsedSlot(
    slot: PoolSlot<TRequest, TResult>,
    job: ActiveIsolateJob<TRequest, TResult>,
    result: TResult,
    generation: number,
  ): void {
    if (this.remainingWallClockMs(job) <= 0) {
      this.failSlot(
        slot,
        toPoolFailure("worker_timed_out", `${this.name} isolate exceeded its ${job.timeoutMs}ms wall-clock deadline`),
        generation,
      );
      return;
    }
    if (slot.retired || slot.generation !== generation) return;
    clearTimeout(slot.timeout);
    slot.timeout = undefined;
    this.settle(job, () => job.resolve(result));
    slot.job = null;
    this.drain();
  }

  private failParsedSlot(
    slot: PoolSlot<TRequest, TResult>,
    job: ActiveIsolateJob<TRequest, TResult>,
    error: unknown,
    generation: number,
  ): void {
    if (this.remainingWallClockMs(job) <= 0) {
      this.failSlot(
        slot,
        toPoolFailure("worker_timed_out", `${this.name} isolate exceeded its ${job.timeoutMs}ms wall-clock deadline`),
        generation,
      );
      return;
    }
    if (slot.retired || slot.generation !== generation) return;
    if (
      error instanceof IsolatePoolError
      && error.remote
      && error.code !== "worker_crashed"
      && error.code !== "worker_timed_out"
      && error.code !== "worker_malformed"
    ) {
      slot.job = null;
      this.settle(job, () => job.reject(error));
      this.drain();
      return;
    }
    this.failSlot(
      slot,
      error instanceof IsolatePoolError
        ? error
        : toPoolFailure("worker_malformed", `${this.name} returned a malformed response`, error),
      generation,
    );
  }

  private failSlot(
    slot: PoolSlot<TRequest, TResult>,
    error: IsolatePoolError,
    generation?: number,
  ): void {
    if (slot.retired || (generation !== undefined && slot.generation !== generation)) return;
    slot.retired = true;
    const job = slot.job;
    const kind = slot.transport.kind;
    const slotWasCurrent = this.slotEpochMatches(slot);
    this.advanceBackendEpoch(kind);
    clearTimeout(slot.timeout);
    slot.timeout = undefined;
    slot.job = null;
    this.detachSlot(slot);
    this.slots.delete(slot);
    const runtimeFailure =
      error.code === "worker_crashed"
      || error.code === "worker_timed_out"
      || error.code === "worker_malformed";
    if (runtimeFailure && slotWasCurrent) {
      updateHealth(kind, "unavailable", error.message, getBackendHealthEpoch(kind));
    }
    const replacementKind = this.backend === "auto" ? this.alternateBackend(kind) : kind;
    const shouldFailover =
      job !== null
      && this.backend === "auto"
      && kind === "worker"
      && replacementKind === "subprocess"
      && runtimeFailure
      && (job.backendFailovers ?? 0) < 1
      && !job.signal?.aborted
      && this.remainingWallClockMs(job) > 0;
    if (job) {
      if (shouldFailover) {
        job.backendFailovers = (job.backendFailovers ?? 0) + 1;
        if (!this.requeueFailedJob(job)) this.settle(job, () => job.reject(error));
      } else {
        this.settle(job, () => job.reject(error));
      }
    }
    if (this.closed) {
      void terminateTransport(slot.transport, "SIGKILL").catch(() => {});
      this.drain();
      return;
    }
    if (!replacementKind) {
      void terminateTransport(slot.transport, "SIGKILL").catch(() => {});
      this.drain();
      return;
    }
    const replacementGeneration = ++this.replacementGeneration[replacementKind];
    this.creatingSlots++;
    const replacementPromise = this.terminateAndReplace(
      slot.transport,
      replacementKind,
      replacementGeneration,
    );
    this.pendingReplacements.add(replacementPromise);
    void replacementPromise.then(
      () => {
        this.pendingReplacements.delete(replacementPromise);
        this.creatingSlots--;
        if (!this.closed) this.drain();
      },
      () => {
        this.pendingReplacements.delete(replacementPromise);
        this.creatingSlots--;
        if (!this.closed) this.drain();
      },
    );
    this.drain();
  }

  private async terminateAndReplace(
    transport: IsolateTransport,
    kind: IsolateBackendKind,
    generation: number,
  ): Promise<void> {
    try {
      await terminateTransport(transport, "SIGKILL");
    } catch {
      // A failed isolate is already unusable; replacement probing is decisive.
    }
    await this.replaceFailedSlot(kind, generation);
  }

  private async replaceFailedSlot(kind: IsolateBackendKind, generation: number): Promise<void> {
    if (this.closed || generation !== this.replacementGeneration[kind]) return;
    let replacement: IsolateTransport | null = null;
    const expectedHealthEpoch = getBackendHealthEpoch(kind);
    try {
      replacement = this.createTransport(kind);
      await this.probeTransport(kind, replacement, true);
      if (
        this.closed
        || generation !== this.replacementGeneration[kind]
      ) {
        await terminateTransport(replacement, "SIGKILL").catch(() => {});
        return;
      }
      if (!updateHealth(kind, "healthy", null, expectedHealthEpoch)) {
        throw new Error(`${this.name} ${kind} replacement health epoch is stale`);
      }
      this.slots.add({
        id: this.nextSlotId++,
        transport: replacement,
        job: null,
        timeout: undefined,
        backendEpoch: this.backendEpoch[kind],
        healthEpoch: getBackendHealthEpoch(kind),
        generation: 0,
        retired: false,
      });
    } catch (error) {
      if (replacement) await terminateTransport(replacement, "SIGKILL").catch(() => {});
      if (
        generation === this.replacementGeneration[kind]
        && getBackendHealthEpoch(kind) === expectedHealthEpoch
      ) {
        updateHealth(kind, "unavailable", error instanceof Error ? error.message : String(error), expectedHealthEpoch);
      }
    }
  }

  private cancelJob(job: ActiveIsolateJob<TRequest, TResult>, error?: IsolatePoolError): void {
    if (job.settled) return;
    const failure = error ?? toPoolFailure("cancelled", `${this.name} job was cancelled`);
    const queue = this.waitingByUser.get(job.userId);
    const queuedIndex = queue?.indexOf(job) ?? -1;
    if (queuedIndex >= 0 && queue) {
      queue.splice(queuedIndex, 1);
      this.waitingCount--;
      if (queue.length === 0) {
        this.waitingByUser.delete(job.userId);
        for (let index = this.readyUsers.length - 1; index >= 0; index--) {
          if (this.readyUsers[index] === job.userId) this.readyUsers.splice(index, 1);
        }
      }
      this.settle(job, () => job.reject(failure));
      return;
    }
    const slot = [...this.slots].find((candidate) => candidate.job === job);
    if (slot) {
      this.failSlot(slot, failure);
      return;
    }
    this.settle(job, () => job.reject(failure));
  }

  private settle(job: ActiveIsolateJob<TRequest, TResult>, action: () => void): void {
    if (job.settled) return;
    job.settled = true;
    if (job.queueTimer) {
      clearTimeout(job.queueTimer);
      job.queueTimer = undefined;
    }
    const onAbort = (job as ActiveIsolateJob<TRequest, TResult> & { onAbort?: () => void }).onAbort;
    if (job.signal && onAbort) job.signal.removeEventListener("abort", onAbort);
    action();
  }

  private parseDefaultResponse(message: unknown, job: ActiveIsolateJob<TRequest, TResult>): TResult {
    if (!isIsolateResponseEnvelopeV1(message) || message.requestId !== job.requestId) {
      throw toPoolFailure("worker_malformed", `${this.name} returned an invalid response envelope`);
    }
    if (message.type === "error") {
      throw new IsolatePoolError(
        this.failureCodeFromWorkerError(message),
        message.error,
        { remote: true },
      );
    }
    return message.result as TResult;
  }

  private failureCodeFromWorkerError(message: Extract<IsolateResponseEnvelopeV1, { type: "error" }>): IsolatePoolFailureCode {
    return isKnownPoolFailureCode(message.code) ? message.code : "worker_malformed";
  }
}
export function createIsolatePoolV1<TRequest, TResult>(
  options: IsolatePoolOptions<TRequest, TResult>,
): IsolatePoolV1<TRequest, TResult> {
  return new IsolatePoolV1(options);
}
export { IsolatePoolV1 as IsolatePool };


export interface RegexIsolateRequest {
  readonly op: "replace" | "test" | "collect" | "capture-replacements";
  readonly pattern: string;
  readonly flags: string;
  readonly input: string;
  readonly replacement?: string;
  readonly replacementMode?: "raw" | "native";
  readonly limits?: Record<string, number>;
}

const regexWorkerUrl = new URL("../utils/regex-sandbox.worker.ts", import.meta.url);
let regexPool: IsolatePoolV1<RegexIsolateRequest, unknown> | null = null;

function regexRequest(job: ActiveIsolateJob<RegexIsolateRequest, unknown>): unknown {
  return {
    version: 1,
    type: "request",
    requestId: job.requestId,
    operation: job.operation,
    payload: job.payload,
  };
}

function parseRegexResponse(message: unknown, job: ActiveIsolateJob<RegexIsolateRequest, unknown>): unknown {
  if (!isIsolateResponseEnvelopeV1(message) || message.requestId !== job.requestId) {
    throw toPoolFailure("worker_malformed", "Regex isolate response envelope is invalid");
  }
  if (message.type === "error") {
    throw new IsolatePoolError(
      isKnownPoolFailureCode(message.code) ? message.code : "worker_malformed",
      message.error,
      { remote: true },
    );
  }
  return message.result;
}

function getRegexPool(): IsolatePoolV1<RegexIsolateRequest, unknown> {
  if (!regexPool) {
    regexPool = new IsolatePoolV1({
      name: "response-regex",
      workerUrl: regexWorkerUrl,
      subprocessCommand: defaultIsolateCommand(new URL("./regex-isolate-subprocess.ts", import.meta.url)),
      workerRequest: regexRequest,
      subprocessRequest: regexRequest,
      responseParser: parseRegexResponse,
      workerStartAcknowledgement: (message, job) =>
        isIsolateStartedEnvelopeV1(message) && message.requestId === job.requestId,
      workerStartTimeoutMs: 5_000,
      maxFrameBytes: DEFAULT_ISOLATE_MAX_FRAME_BYTES,
      defaultTimeoutMs: 500,
    });
  }
  return regexPool;
}

/** Run user-authored Response regex only in a terminable isolate backend. */
export function runRegexInIsolate(
  request: RegexIsolateRequest,
  options: {
    userId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    deadlineAt?: number;
  },
): Promise<unknown> {
  return getRegexPool().submit({
    userId: options.userId,
    operation: request.op,
    payload: request,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    hardDeadlineAt: options.deadlineAt,
  });
}

export function releaseIdleRegexIsolatePool(): number {
  return regexPool?.releaseIdle() ?? 0;
}

export async function shutdownRegexIsolatePool(): Promise<void> {
  if (!regexPool) return;
  const pool = regexPool;
  regexPool = null;
  await pool.shutdown();
}
