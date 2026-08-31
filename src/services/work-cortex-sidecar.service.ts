import { createHash, randomUUID } from "node:crypto";
import type {
  AgentCortexCheckpointV1,
  AgentCortexOmissionReasonV1,
  AgentCortexOmissionV1,
  AgentCortexReceiptStateV1,
  AgentCortexReceiptV1,
  AgentCortexRevisionV1,
  AgentCortexScopeV1,
  AgentInspectionCorrelationV1,
} from "../types/agent-run-projection";

/** Cortex is admitted at exactly one host checkpoint in Alpha 1. */
export const WORK_CORTEX_CHECKPOINT = "WORK" as const satisfies AgentCortexCheckpointV1;
export type WorkCortexCheckpointV1 = typeof WORK_CORTEX_CHECKPOINT;

export type CortexSnapshotAvailabilityV1 =
  | "available"
  | "stale"
  | "unauthorized"
  | "unavailable";

export type CortexSidecarFailureCodeV1 = AgentCortexOmissionReasonV1;

export const WORK_CORTEX_MAX_SNAPSHOT_BYTES = 256 * 1024;
export const WORK_CORTEX_MAX_RESULT_BYTES = 128 * 1024;
export const WORK_CORTEX_MAX_SNAPSHOT_ITEMS = 4096;
export const WORK_CORTEX_MAX_RESULT_ITEMS = 1024;
export const WORK_CORTEX_MAX_DEPTH = 16;
export const WORK_CORTEX_MAX_ID_BYTES = 256;

const encoder = new TextEncoder();
const REVISION_MAX_BYTES = 256;
const DETAIL_MAX_BYTES = 1024;
const authorizedSnapshots = new WeakSet<object>();

function normalizeAuthorizedSnapshot(value: unknown): CortexAuthorizedSnapshotV1 {
  if (typeof value === "object" && value !== null && authorizedSnapshots.has(value)) {
    return value as CortexAuthorizedSnapshotV1;
  }
  const supplied = value as CortexAuthorizedSnapshotV1;
  if (supplied.version !== 1) throw new TypeError("invalid Cortex snapshot version");
  const normalized = createCortexAuthorizedSnapshot({
    ownerId: supplied.ownerId,
    attemptId: supplied.attemptId,
    chatId: supplied.scope.chatId,
    targetMessageId: supplied.scope.targetMessageId,
    targetSwipeId: supplied.scope.targetSwipeId,
    checkpoint: supplied.checkpoint,
    snapshotId: supplied.snapshotId,
    revision: supplied.revision,
    value: supplied.value,
    availability: supplied.availability,
  });
  if (supplied.valueDigest !== normalized.valueDigest) {
    throw new TypeError("Cortex snapshot digest mismatch");
  }
  return normalized;
}


export interface CortexAuthorizedSnapshotInputV1 {
  readonly ownerId: string;
  readonly attemptId: string;
  readonly chatId: string;
  readonly targetMessageId: string | null;
  readonly targetSwipeId: number | null;
  readonly checkpoint: WorkCortexCheckpointV1;
  readonly snapshotId: string;
  /** Opaque source revision; digest-like revisions must remain strings. */
  readonly revision: AgentCortexRevisionV1;
  readonly value: unknown;
  readonly availability?: CortexSnapshotAvailabilityV1;
}

/**
 * Host-owned immutable input.  `value` is a bounded clone, never the caller's
 * object, and the sidecar receives no owner/session capability through it.
 */
export interface CortexAuthorizedSnapshotV1 {
  readonly version: 1;
  readonly ownerId: string;
  readonly attemptId: string;
  readonly scope: AgentCortexScopeV1;
  readonly checkpoint: WorkCortexCheckpointV1;
  readonly snapshotId: string;
  readonly revision: AgentCortexRevisionV1;
  readonly availability: CortexSnapshotAvailabilityV1;
  readonly value: unknown;
  readonly valueDigest: string;
}

export interface CortexSidecarReadRequestV1 {
  readonly ownerId?: string;
  readonly attemptId?: string;
  readonly snapshotId?: string;
  readonly checkpoint?: WorkCortexCheckpointV1;
  readonly revision?: AgentCortexRevisionV1;
  readonly scope?: Partial<AgentCortexScopeV1>;
  readonly signal?: AbortSignal;
}

/** Reader is intentionally pure: it receives only the frozen source value. */
export type CortexSidecarReaderV1 = (
  value: unknown,
  signal: AbortSignal | undefined,
) => unknown | PromiseLike<unknown>;

export interface AdmitCortexSidecarInputV1 {
  readonly ownerId: string;
  readonly attemptId: string;
  readonly scope: AgentCortexScopeV1;
  readonly snapshot: CortexAuthorizedSnapshotV1;
  readonly checkpoint: WorkCortexCheckpointV1;
  readonly revision: AgentCortexRevisionV1;
  readonly required: boolean;
  readonly requestId: string;
  readonly correlation: AgentInspectionCorrelationV1;
  readonly signal?: AbortSignal;
  readonly read?: CortexSidecarReaderV1;
}

export interface CortexSidecarOmissionV1 {
  readonly kind: "omission";
  readonly omission: AgentCortexOmissionV1;
  readonly receipt: AgentCortexReceiptV1;
}

export interface CortexSidecarAcceptedV1 {
  readonly kind: "accepted";
  readonly value: unknown;
  readonly receipt: AgentCortexReceiptV1;
}

export type CortexSidecarReadResultV1 = CortexSidecarAcceptedV1 | CortexSidecarOmissionV1;

export interface CortexSidecarAdmissionV1 {
  readonly snapshot: CortexAuthorizedSnapshotV1;
  readonly required: boolean;
  readonly read: (
    request?: CortexSidecarReadRequestV1,
  ) => Promise<CortexSidecarReadResultV1>;
}

/** A required sidecar read cannot be represented as an optional omission. */
export class CortexSidecarError extends Error {
  readonly code: CortexSidecarFailureCodeV1;
  readonly receipt: AgentCortexReceiptV1;
  readonly omission: AgentCortexOmissionV1;

  constructor(
    code: CortexSidecarFailureCodeV1,
    receipt: AgentCortexReceiptV1,
    omission: AgentCortexOmissionV1,
  ) {
    super(`Cortex sidecar ${code}`);
    this.name = "CortexSidecarError";
    this.code = code;
    this.receipt = receipt;
    this.omission = omission;
  }
}

class CortexSnapshotLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CortexSnapshotLimitError";
  }
}

function boundedId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || encoder.encode(value).byteLength > WORK_CORTEX_MAX_ID_BYTES) {
    throw new TypeError(`invalid Cortex ${field}`);
  }
  return value;
}

function boundedDetail(value: string): string {
  const bytes = encoder.encode(value);
  return bytes.byteLength <= DETAIL_MAX_BYTES
    ? value
    : new TextDecoder().decode(bytes.slice(0, DETAIL_MAX_BYTES));
}

function boundedRevision(value: unknown): AgentCortexRevisionV1 {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid Cortex revision");
    return value;
  }
  if (typeof value !== "string" || value.length === 0 || encoder.encode(value).byteLength > REVISION_MAX_BYTES) {
    throw new TypeError("invalid Cortex revision");
  }
  return value;
}

function sameRevision(left: AgentCortexRevisionV1, right: AgentCortexRevisionV1): boolean {
  return typeof left === typeof right && left === right;
}

function normalizeScope(input: {
  chatId: unknown;
  targetMessageId: unknown;
  targetSwipeId: unknown;
}): AgentCortexScopeV1 {
  const chatId = boundedId(input.chatId, "chatId");
  const targetMessageId = input.targetMessageId === null
    ? null
    : boundedId(input.targetMessageId, "targetMessageId");
  let targetSwipeId: number | null;
  if (input.targetSwipeId === null) {
    targetSwipeId = null;
  } else {
    const candidate = input.targetSwipeId;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
      throw new TypeError("invalid Cortex targetSwipeId");
    }
    targetSwipeId = candidate;
  }
  if (targetMessageId === null && targetSwipeId !== null) {
    throw new TypeError("Cortex swipe target requires a message target");
  }
  return Object.freeze({ chatId, targetMessageId, targetSwipeId });
}
function cloneBounded(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (depth > WORK_CORTEX_MAX_DEPTH) throw new CortexSnapshotLimitError("Cortex snapshot depth limit exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cortex snapshot contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("Cortex snapshot contains an unsupported value");
  if (seen.has(value)) throw new TypeError("Cortex snapshot must not contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > WORK_CORTEX_MAX_SNAPSHOT_ITEMS) throw new CortexSnapshotLimitError("Cortex snapshot item limit exceeded");
      const output = value.map((item) => cloneBounded(item, depth + 1, seen));
      return Object.freeze(output);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Cortex snapshot must contain plain objects");
    const keys = Object.keys(value);
    if (keys.length > WORK_CORTEX_MAX_SNAPSHOT_ITEMS) throw new CortexSnapshotLimitError("Cortex snapshot property limit exceeded");
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new TypeError("Cortex snapshot contains an accessor");
      Object.defineProperty(output, key, {
        value: cloneBounded(descriptor.value, depth + 1, seen),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(output);
  } finally {
    seen.delete(value);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("unsupported Cortex value");
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function boundedValue(value: unknown, maxBytes: number, label: string): unknown {
  const clone = cloneBounded(value);
  const bytes = encoder.encode(canonical(clone)).byteLength;
  if (bytes > maxBytes) throw new CortexSnapshotLimitError(`${label} byte limit exceeded`);
  return clone;
}

function resultCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.results)) return object.results.length;
    if (Array.isArray(object.memories)) return object.memories.length;
  }
  return value === null ? 0 : 1;
}

function inspectionReason(code: CortexSidecarFailureCodeV1): AgentCortexReceiptV1["reason"] {
  switch (code) {
    case "stale":
    case "snapshot_mismatch":
      return "stale_input";
    case "unauthorized":
    case "unavailable":
      return "unavailable";
    case "cancelled":
      return "interrupted";
    case "failed":
    case "limit_exceeded":
      return "needs_attention";
  }
}

function makeOmission(code: CortexSidecarFailureCodeV1, required: boolean): AgentCortexOmissionV1 {
  const detail = code === "stale"
    ? "The authorized Cortex snapshot is stale."
    : code === "unauthorized"
      ? "The authorized Cortex snapshot is not available to this turn."
      : code === "unavailable"
        ? "The authorized Cortex source is unavailable."
        : code === "cancelled"
          ? "The Cortex sidecar was cancelled."
          : code === "limit_exceeded"
            ? "The Cortex sidecar result exceeded its host limit."
            : code === "snapshot_mismatch"
              ? "The Cortex snapshot no longer matches the admitted turn."
              : "The Cortex sidecar read failed.";
  return Object.freeze({ reason: code, required, detail: boundedDetail(detail) });
}

function makeReceipt(
  input: AdmitCortexSidecarInputV1,
  state: AgentCortexReceiptStateV1,
  startedAt: number,
  completedAt: number | null,
  resultDigest: string | null,
  resultCountValue: number,
  omission: AgentCortexOmissionV1 | null,
): AgentCortexReceiptV1 {
  const snapshot = input.snapshot;
  return Object.freeze({
    version: 1,
    id: randomUUID(),
    requestId: input.requestId,
    attemptId: input.attemptId,
    checkpoint: WORK_CORTEX_CHECKPOINT,
    snapshotId: snapshot.snapshotId,
    sourceRevision: snapshot.revision,
    revision: snapshot.revision,
    scope: input.scope,
    required: input.required,
    startedAt,
    completedAt,
    state,
    resultDigest,
    resultCount: resultCountValue,
    correlation: input.correlation,
    reason: omission ? inspectionReason(omission.reason) : null,
    omission,
    canonical: false,
  });
}

function withFailure(
  input: AdmitCortexSidecarInputV1,
  code: CortexSidecarFailureCodeV1,
  startedAt: number,
): Promise<CortexSidecarReadResultV1> {
  const omission = makeOmission(code, input.required);
  const state: AgentCortexReceiptStateV1 = code === "cancelled" ? "cancelled" : input.required ? "failed" : "omitted";
  const receipt = makeReceipt(input, state, startedAt, Date.now(), null, 0, omission);
  if (input.required) return Promise.reject(new CortexSidecarError(code, receipt, omission));
  return Promise.resolve({ kind: "omission", omission, receipt });
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function requestMismatch(
  input: AdmitCortexSidecarInputV1,
  request: CortexSidecarReadRequestV1 | undefined,
): CortexSidecarFailureCodeV1 | null {
  if (!request) return null;
  if (request.ownerId !== undefined && request.ownerId !== input.ownerId) return "snapshot_mismatch";
  if (request.attemptId !== undefined && request.attemptId !== input.attemptId) return "snapshot_mismatch";
  if (request.snapshotId !== undefined && request.snapshotId !== input.snapshot.snapshotId) return "snapshot_mismatch";
  if (request.checkpoint !== undefined && request.checkpoint !== WORK_CORTEX_CHECKPOINT) return "snapshot_mismatch";
  if (request.revision !== undefined && !sameRevision(request.revision, input.snapshot.revision)) return "stale";
  if (request.scope) {
    const scope = request.scope;
    if (scope.chatId !== undefined && scope.chatId !== input.scope.chatId) return "snapshot_mismatch";
    if (scope.targetMessageId !== undefined && scope.targetMessageId !== input.scope.targetMessageId) return "snapshot_mismatch";
    if (scope.targetSwipeId !== undefined && scope.targetSwipeId !== input.scope.targetSwipeId) return "snapshot_mismatch";
  }
  return null;
}

export function createCortexAuthorizedSnapshot(
  input: CortexAuthorizedSnapshotInputV1,
): CortexAuthorizedSnapshotV1 {
  const ownerId = boundedId(input.ownerId, "ownerId");
  const attemptId = boundedId(input.attemptId, "attemptId");
  const scope = normalizeScope({
    chatId: input.chatId,
    targetMessageId: input.targetMessageId,
    targetSwipeId: input.targetSwipeId,
  });
  if (input.checkpoint !== WORK_CORTEX_CHECKPOINT) throw new TypeError("Cortex snapshot checkpoint must be WORK");
  const snapshotId = boundedId(input.snapshotId, "snapshotId");
  const revision = boundedRevision(input.revision);
  const availability = input.availability ?? "available";
  if (!["available", "stale", "unauthorized", "unavailable"].includes(availability)) {
    throw new TypeError("invalid Cortex snapshot availability");
  }
  const value = boundedValue(input.value, WORK_CORTEX_MAX_SNAPSHOT_BYTES, "Cortex snapshot");
  const snapshot = Object.freeze({
    version: 1 as const,
    ownerId,
    attemptId,
    scope,
    checkpoint: WORK_CORTEX_CHECKPOINT,
    snapshotId,
    revision,
    availability,
    value,
    valueDigest: digest(value),
  });
  authorizedSnapshots.add(snapshot);
  return snapshot;
}

export function admitCortexSidecar(input: AdmitCortexSidecarInputV1): CortexSidecarAdmissionV1 {
  const snapshot = normalizeAuthorizedSnapshot(input.snapshot);
  const ownerId = boundedId(input.ownerId, "ownerId");
  const attemptId = boundedId(input.attemptId, "attemptId");
  const requestId = boundedId(input.requestId, "requestId");
  if (typeof input.required !== "boolean") throw new TypeError("Cortex requiredness must be boolean");
  if (input.checkpoint !== WORK_CORTEX_CHECKPOINT || snapshot.checkpoint !== WORK_CORTEX_CHECKPOINT) {
    throw new TypeError("Cortex sidecar checkpoint must be WORK");
  }
  const scope = normalizeScope(input.scope);
  const revision = boundedRevision(input.revision);
  if (ownerId !== snapshot.ownerId || attemptId !== snapshot.attemptId) {
    throw new TypeError("Cortex snapshot owner/attempt mismatch");
  }
  if (!sameRevision(revision, snapshot.revision)) throw new TypeError("Cortex sidecar revision mismatch");
  if (scope.chatId !== snapshot.scope.chatId
    || scope.targetMessageId !== snapshot.scope.targetMessageId
    || scope.targetSwipeId !== snapshot.scope.targetSwipeId) {
    throw new TypeError("Cortex sidecar scope mismatch");
  }
  const admitted: AdmitCortexSidecarInputV1 = Object.freeze({
    ...input,
    ownerId,
    attemptId,
    requestId,
    scope,
    revision,
    snapshot,
  });

  return Object.freeze({
    snapshot: admitted.snapshot,
    required: admitted.required,
    async read(request?: CortexSidecarReadRequestV1): Promise<CortexSidecarReadResultV1> {
      const startedAt = Date.now();
      const mismatch = requestMismatch(admitted, request);
      if (mismatch) return withFailure(admitted, mismatch, startedAt);
      const signal = request?.signal ?? admitted.signal;
      if (signal?.aborted) return withFailure(admitted, "cancelled", startedAt);
      const availability = admitted.snapshot.availability;
      if (availability !== "available") return withFailure(admitted, availability, startedAt);

      let output: unknown;
      try {
        const readResult = admitted.read
          ? admitted.read(admitted.snapshot.value, signal)
          : admitted.snapshot.value;
        output = await raceAbort(Promise.resolve(readResult), signal);
        if (signal?.aborted) return withFailure(admitted, "cancelled", startedAt);
        const frozenOutput = boundedValue(output, WORK_CORTEX_MAX_RESULT_BYTES, "Cortex result");
        const count = resultCount(frozenOutput);
        if (count > WORK_CORTEX_MAX_RESULT_ITEMS) return withFailure(admitted, "limit_exceeded", startedAt);
        const receipt = makeReceipt(admitted, "accepted", startedAt, Date.now(), digest(frozenOutput), count, null);
        return Object.freeze({ kind: "accepted", value: frozenOutput, receipt });
      } catch (error) {
        if (signal?.aborted) {
          return withFailure(admitted, "cancelled", startedAt);
        }
        if (error instanceof CortexSidecarError) throw error;
        const code: CortexSidecarFailureCodeV1 = error instanceof CortexSnapshotLimitError ? "limit_exceeded" : "failed";
        return withFailure(admitted, code, startedAt);
      }
    },
  });
}

/** Convenience helper for callers that want an opaque request identifier. */
export function createCortexSidecarRequestId(): string {
  return randomUUID();
}
