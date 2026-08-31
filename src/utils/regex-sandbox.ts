import {
  releaseIdleRegexIsolatePool,
  runRegexInIsolate,
  shutdownRegexIsolatePool,
} from "../services/isolate-pool";
import type { RegexIsolateRequest } from "../services/isolate-pool";
import {
  isRegexValidationErrorCode,
  REGEX_LIMITS_V1,
  RegexCancelledError,
  RegexDeadlineError,
  RegexLimitError,
  assertRegexTextBytes,
  throwIfRegexAborted,
} from "./regex-limits";

/**
 * Untrusted regexes execute only through the shared terminable isolate pool.
 * A missing or unhealthy backend fails closed; there is deliberately no
 * synchronous/main-process fallback.
 */
const DEFAULT_TIMEOUT_MS = 500;


export class RegexTimeoutError extends RegexLimitError {
  constructor(public readonly timeoutMs: number) {
    super("worker_timed_out", `Regex evaluation exceeded ${timeoutMs}ms and was aborted`);
    this.name = "RegexTimeoutError";
  }
}

export class RegexSandboxError extends Error {
  constructor(
    message: string,
    public readonly code: "worker_unavailable" | "worker_crashed" | "worker_malformed" | "queue_full" = "worker_crashed",
  ) {
    super(message);
    this.name = "RegexSandboxError";
  }
}

export class RegexWorkerStartupTimeoutError extends RegexSandboxError {
  constructor(public readonly timeoutMs: number) {
    super(`Regex worker did not acknowledge the request within ${timeoutMs}ms`);
    this.name = "RegexWorkerStartupTimeoutError";
  }
}

export interface SandboxMatch {
  fullMatch: string;
  index: number;
  groups: (string | undefined)[];
  namedGroups?: Record<string, string | undefined>;
}

export interface SandboxCaptureReplacement {
  index: number;
  matchLength: number;
  replacement: string;
}

export interface RegexSandboxOptions {
  userId?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
  maxMatches?: number;
  maxExpansionBytes?: number;
  maxOutputBytes?: number;
  maxOperationBytes?: number;
}

function getTimeoutMs(timeoutMs: number, deadlineAt?: number): number {
  if (deadlineAt === undefined) return timeoutMs;
  return Math.min(timeoutMs, deadlineAt - Date.now());
}
function mapIsolateError(error: unknown, timeoutMs: number): Error {
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    timeoutPhase?: unknown;
    timeoutMs?: unknown;
  };
  const code = typeof candidate.code === "string" ? candidate.code : "worker_crashed";
  const message = typeof candidate.message === "string" ? candidate.message : "Regex isolate failed";
  if (
    (code === "worker_timed_out" || code === "timed_out")
    && candidate.timeoutPhase === "startup"
  ) {
    return new RegexWorkerStartupTimeoutError(
      typeof candidate.timeoutMs === "number" ? candidate.timeoutMs : timeoutMs,
    );
  }
  if (code === "worker_timed_out" || code === "timed_out") return new RegexTimeoutError(timeoutMs);
  if (code === "cancelled") return new RegexCancelledError(message);
  if (code === "deadline_exceeded") return new RegexDeadlineError(message);
  if (code === "queue_full") return new RegexSandboxError(message, "queue_full");
  if (code === "worker_unavailable") return new RegexSandboxError(message, "worker_unavailable");
  if (code === "worker_crashed" || code === "crashed") return new RegexSandboxError(message, "worker_crashed");
  if (code === "worker_malformed") return new RegexSandboxError(message, "worker_malformed");
  if (isRegexValidationErrorCode(code)) return new RegexLimitError(code, message);
  return new RegexSandboxError(message, "worker_malformed");
}

async function runSandboxed<T>(
  op: "replace" | "test" | "collect" | "capture-replacements",
  payload: Record<string, unknown>,
  timeoutMs: number,
  options?: RegexSandboxOptions,
): Promise<T> {
  throwIfRegexAborted(options?.signal, options?.deadlineAt);
  const effectiveTimeoutMs = getTimeoutMs(timeoutMs, options?.deadlineAt);
  if (effectiveTimeoutMs <= 0) throw new RegexDeadlineError();
  const limits: Record<string, number> = {
    maxInputBytes: REGEX_LIMITS_V1.maxInputBytes,
    maxOutputBytes: options?.maxOutputBytes ?? REGEX_LIMITS_V1.maxOutputBytes,
    maxExpansionBytes: options?.maxExpansionBytes ?? REGEX_LIMITS_V1.maxExpansionBytes,
    maxOperationBytes: options?.maxOperationBytes ?? REGEX_LIMITS_V1.maxOperationBytes,
    maxMatches: options?.maxMatches ?? REGEX_LIMITS_V1.maxMatchCount,
    ...(options?.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  };
  const pattern = payload.pattern;
  const flags = payload.flags;
  const input = payload.input;
  if (typeof pattern !== "string" || typeof flags !== "string" || typeof input !== "string") {
    throw new RegexLimitError("invalid_input", "Regex isolate request is missing pattern, flags, or input");
  }
  const replacement = payload.replacement;
  const replacementMode = payload.replacementMode;
  const request: RegexIsolateRequest = {
    op,
    pattern,
    flags,
    input,
    ...(typeof replacement === "string" ? { replacement } : {}),
    ...(replacementMode === "raw" || replacementMode === "native" ? { replacementMode } : {}),
    limits,
  };
  try {
    return await runRegexInIsolate(
      request,
      {
        userId: options?.userId ?? "regex-host",
        timeoutMs: effectiveTimeoutMs,
        signal: options?.signal,
        deadlineAt: options?.deadlineAt,
      },
    ) as T;
  } catch (error) {
    throw mapIsolateError(error, effectiveTimeoutMs);
  }
}

export async function shutdownRegexSandbox(): Promise<void> {
  await shutdownRegexIsolatePool();
}

export function releaseIdleRegexWorkers(): number {
  return releaseIdleRegexIsolatePool();
}

/** Validate pattern bytes before queueing; syntax compilation stays in the isolate. */
function assertPatternBytes(pattern: string): void {
  assertRegexTextBytes(pattern, REGEX_LIMITS_V1.maxPatternBytes, "pattern_too_large", "Regex pattern");
}

export async function regexReplaceSandboxed(
  pattern: string,
  flags: string,
  input: string,
  replacement: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  options?: RegexSandboxOptions,
): Promise<string> {
  assertPatternBytes(pattern);
  assertRegexTextBytes(input, REGEX_LIMITS_V1.maxInputBytes, "invalid_input", "Regex input");
  assertRegexTextBytes(replacement, REGEX_LIMITS_V1.maxReplacementBytes, "replacement_too_large", "Regex replacement");
  return runSandboxed<string>("replace", { pattern, flags, input, replacement }, timeoutMs, options);
}

export async function regexCollectSandboxed(
  pattern: string,
  flags: string,
  input: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  options?: RegexSandboxOptions,
): Promise<SandboxMatch[]> {
  assertPatternBytes(pattern);
  assertRegexTextBytes(input, REGEX_LIMITS_V1.maxInputBytes, "invalid_input", "Regex input");
  return runSandboxed<SandboxMatch[]>("collect", { pattern, flags, input }, timeoutMs, options);
}

/**
 * Collect raw-mode replacement templates with captures already interpolated.
 * This keeps large capture arrays inside the isolate instead of cloning them
 * across the host boundary.
 */
export async function regexCaptureReplacementsSandboxed(
  pattern: string,
  flags: string,
  input: string,
  replacement: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  options?: RegexSandboxOptions,
): Promise<SandboxCaptureReplacement[]> {
  assertPatternBytes(pattern);
  assertRegexTextBytes(input, REGEX_LIMITS_V1.maxInputBytes, "invalid_input", "Regex input");
  assertRegexTextBytes(replacement, REGEX_LIMITS_V1.maxReplacementBytes, "replacement_too_large", "Regex replacement");
  return runSandboxed<SandboxCaptureReplacement[]>(
    "capture-replacements",
    { pattern, flags, input, replacement },
    timeoutMs,
    options,
  );
}

/** Collect ordinary replacement results with native GetSubstitution semantics. */
export async function regexNativeCaptureReplacementsSandboxed(
  pattern: string,
  flags: string,
  input: string,
  replacement: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  options?: RegexSandboxOptions,
): Promise<SandboxCaptureReplacement[]> {
  assertPatternBytes(pattern);
  assertRegexTextBytes(input, REGEX_LIMITS_V1.maxInputBytes, "invalid_input", "Regex input");
  assertRegexTextBytes(replacement, REGEX_LIMITS_V1.maxReplacementBytes, "replacement_too_large", "Regex replacement");
  return runSandboxed<SandboxCaptureReplacement[]>(
    "capture-replacements",
    { pattern, flags, input, replacement, replacementMode: "native" },
    timeoutMs,
    options,
  );
}

export async function regexTestSandboxed(
  pattern: string,
  flags: string,
  input: string,
  replacement: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  options?: RegexSandboxOptions,
): Promise<{ result: string; matches: number }> {
  assertPatternBytes(pattern);
  assertRegexTextBytes(input, REGEX_LIMITS_V1.maxInputBytes, "invalid_input", "Regex input");
  assertRegexTextBytes(replacement, REGEX_LIMITS_V1.maxReplacementBytes, "replacement_too_large", "Regex replacement");
  return runSandboxed<{ result: string; matches: number }>(
    "test",
    { pattern, flags, input, replacement },
    timeoutMs,
    options,
  );
}
