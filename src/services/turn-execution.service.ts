import { createHash } from "node:crypto";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { getDb } from "../db/connection";
import {
  AGENT_PUBLIC_ERROR_CODES,
  type AgentWorkAttemptLineageV1,
  type AgentWorkOutcome,
  type AgentWorkPhase,
  type AgentWorkStatus,
} from "../types/agent-runtime";
import type {
  AgentInspectionOutcomeV1,
  AgentInspectionReasonV1,
} from "../types/agent-run-projection";
import {
  AGENT_ACTIVITY_RUN_MAX_BYTES,
  persistAgentRunInspectionInTransaction,
  type PersistAgentRunInspectionInputV1,
} from "./agent-activity-runs.service";
import {
  appendAgentRunSnapshot,
  type AgentRunProjectionInputV2,
  type AgentRunReceiptRepairOptions,
} from "./agent-run-projection.service";
import { invalidateFrameCapabilitiesForTurn } from "./turn-workspace.service";
import { cancellationTerminalCause } from "../utils/turn-cancellation-cause";

/**
 * Durable turn execution states.  This is intentionally a closed union: adding
 * a phase requires adding it to the transition table and its reconciliation
 * policy below.
 */
export const TURN_EXECUTION_PHASES = [
  "ASSEMBLE",
  "WORK",
  "COMPLETE",
  "RENDER",
  "PREPARE_COMMIT",
  "COMMITTING",
  "COMMITTED",
  "COMMIT_FAILED",
  "EXHAUSTED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;
export type TurnExecutionPhase = (typeof TURN_EXECUTION_PHASES)[number];
export type TurnExecutionState = TurnExecutionPhase;

export const GENERATION_TARGETS = ["normal", "continue", "regenerate", "swipe"] as const;
export type GenerationTarget = (typeof GENERATION_TARGETS)[number];

export const TERMINAL_TURN_PHASES = [
  "COMMITTED",
  "COMMIT_FAILED",
  "EXHAUSTED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const satisfies readonly TurnExecutionPhase[];
export type TerminalTurnPhase = (typeof TERMINAL_TURN_PHASES)[number];

export const REVERSIBLE_TURN_PHASES = [
  "ASSEMBLE",
  "WORK",
  "COMPLETE",
  "RENDER",
  "PREPARE_COMMIT",
] as const satisfies readonly TurnExecutionPhase[];

/**
 * The only phase edges accepted by the host.  Failure/cancellation/timeout
 * edges are explicit rather than inferred so a future caller cannot bypass a
 * terminal policy by inventing a new event string.
 */
export const TURN_EXECUTION_TRANSITIONS: Readonly<Record<TurnExecutionPhase, readonly TurnExecutionPhase[]>> = Object.freeze({
  ASSEMBLE: ["WORK", "EXHAUSTED", "FAILED", "CANCELLED", "TIMED_OUT"],
  WORK: ["COMPLETE", "EXHAUSTED", "FAILED", "CANCELLED", "TIMED_OUT"],
  COMPLETE: ["RENDER", "EXHAUSTED", "FAILED", "CANCELLED", "TIMED_OUT"],
  RENDER: ["PREPARE_COMMIT", "EXHAUSTED", "FAILED", "CANCELLED", "TIMED_OUT"],
  PREPARE_COMMIT: ["COMMITTING", "EXHAUSTED", "FAILED", "CANCELLED", "TIMED_OUT"],
  COMMITTING: ["COMMITTED", "COMMIT_FAILED"],
  COMMITTED: [],
  COMMIT_FAILED: [],
  EXHAUSTED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
});

export function isTurnExecutionPhase(value: unknown): value is TurnExecutionPhase {
  return typeof value === "string" && (TURN_EXECUTION_PHASES as readonly string[]).includes(value);
}

export function isGenerationTarget(value: unknown): value is GenerationTarget {
  return typeof value === "string" && (GENERATION_TARGETS as readonly string[]).includes(value);
}

export function isAllowedTurnExecutionTransition(
  current: TurnExecutionPhase,
  next: TurnExecutionPhase,
): boolean {
  return isTurnExecutionPhase(current) && isTurnExecutionPhase(next)
    && TURN_EXECUTION_TRANSITIONS[current].includes(next);
}

export type TurnExecutionErrorCode =
  | "execution_not_found"
  | "execution_schema_unavailable"
  | "invalid_execution_input"
  | "invalid_transition"
  | "stale_execution"
  | "stale_owner"
  | "lease_conflict"
  | "already_terminal"
  | "too_late"
  | "deadline_exceeded"
  | "cancelled"
  | "commit_key_conflict"
  | "render_reservation_taken"
  | "commit_receipt_missing"
  | "commit_failed"
  | "runtime_disabled"
  | "readiness_unavailable";

export class TurnExecutionError extends Error {
  readonly code: TurnExecutionErrorCode;
  readonly executionId?: string;
  readonly phase?: TurnExecutionPhase;

  constructor(code: TurnExecutionErrorCode, message?: string, details?: {
    executionId?: string;
    phase?: TurnExecutionPhase;
  }) {
    super(message ? `${code}: ${message}` : code);
    this.name = "TurnExecutionError";
    this.code = code;
    this.executionId = details?.executionId;
    this.phase = details?.phase;
  }
}
export interface TurnTargetInput {
  readonly kind?: GenerationTarget;
  readonly target?: GenerationTarget;
  readonly messageId?: string | null;
  readonly swipeId?: number | null;
  readonly messageIndex?: number | null;
  readonly swipeCount?: number | null;
  readonly chatGenerationRevision?: number;
  readonly messageGenerationRevision?: number | null;
  readonly chatId?: string;
  readonly branchId?: string | null;
}
export interface TurnExecutionInput {
  id?: string;
  userId: string;
  chatId: string;
  branchId?: string | null;
  generationId?: string | null;
  target?: GenerationTarget | TurnTargetInput;
  targetKind?: GenerationTarget;
  targetMessageId?: string | null;
  targetSwipeId?: number | null;
  targetMessageIndex?: number | null;
  targetSwipeCount?: number | null;
  targetChatRevision?: number;
  targetMessageRevision?: number | null;
  /** Only stable target identity/revision fields are retained. */
  readonly attemptLineage?: Partial<AgentWorkAttemptLineageV1> | null;
  targetSnapshot?: unknown;
  presetSnapshotId?: string | null;
  presetRevision?: number | null;
  configSnapshotId?: string | null;
  configRevision?: number | null;
  concreteConnectionSnapshotId?: string | null;
  concreteConnectionRevision?: number | null;
  worldLoreSnapshotId?: string | null;
  worldLoreRevision?: number | null;
  mode?: "response" | "agentic";
  runtimeEpoch?: number;
  deadlineAt: number;
  expiresAt?: number | null;
  retention?: "operational" | "turn_terminal";
  rootLedger?: unknown;
  frameCapabilities?: unknown;
  workspaceId?: string | null;
  workspaceRevision?: number;
  ownerToken?: string;
  commitKey?: string;
  /** A signal is a convenience for the host; the signal itself is never persisted. */
  cancelSignal?: AbortSignal;
}

export interface TurnExecutionRecord {
  readonly id: string;
  readonly userId: string;
  readonly chatId: string;
  readonly branchId: string | null;
  readonly generationId: string;
  readonly targetKind: GenerationTarget;
  readonly targetMessageId: string | null;
  readonly targetSwipeId: number | null;
  readonly targetMessageIndex: number | null;
  readonly targetSwipeCount: number | null;
  readonly targetChatRevision: number;
  readonly targetMessageRevision: number | null;
  readonly targetSnapshot: unknown;
  readonly presetSnapshotId: string | null;
  readonly presetRevision: number;
  readonly configSnapshotId: string | null;
  readonly configRevision: number;
  readonly concreteConnectionSnapshotId: string | null;
  readonly concreteConnectionRevision: number;
  readonly worldLoreSnapshotId: string | null;
  readonly worldLoreRevision: number;
  readonly mode: "response" | "agentic";
  readonly workPhase: AgentWorkPhase;
  readonly workStatus: AgentWorkStatus;
  readonly workOutcome: AgentWorkOutcome | null;
  readonly reason: string | null;
  readonly attemptLineage: AgentWorkAttemptLineageV1;
  readonly phase: TurnExecutionPhase;
  readonly state: TurnExecutionPhase;
  readonly runtimeEpoch: number;
  readonly deadlineAt: number;
  readonly cancelRequested: boolean;
  readonly cancelRequestedAt: number | null;
  readonly workspaceId: string | null;
  readonly rootLedger: unknown;
  readonly frameCapabilities: unknown;
  readonly workspaceRevision: number;
  readonly casRevision: number;
  readonly phaseRevision: number;
  readonly casOwner: string | null;
  readonly leaseExpiresAt: number | null;
  readonly leaseGeneration: number;
  readonly commitKey: string;
  readonly terminalCode: string | null;
  readonly finalRenderReservationKey: string | null;
  readonly finalRenderReservations: readonly FinalRenderReservationRecord[];
  readonly finalRenderReservationReleasedAt: number | null;
  readonly terminalEventId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | null;
  /** Frozen target/revision shape consumed by runtime decision and commit code. */
  readonly target: GenerationTargetRecord;
  readonly frozenRevisions: FrozenExecutionRevisions;
  readonly cas: ExecutionCasRecord;
}

export interface GenerationTargetRecord {
  readonly target: GenerationTarget;
  readonly chatId: string;
  readonly branchId: string | null;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly messageIndex: number | null;
  readonly swipeCount: number | null;
  readonly chatGenerationRevision: number;
  readonly messageGenerationRevision: number | null;
}

export interface FrozenExecutionRevisions {
  readonly target: GenerationTargetRecord;
  readonly presetId: string | null;
  readonly presetRevision: number;
  readonly configId: string | null;
  readonly configRevision: number;
  readonly connectionId: string | null;
  readonly connectionRevision: number;
  readonly worldLoreSnapshotId: string | null;
  readonly worldLoreRevision: number;
  readonly runtimeEpoch: number;
}

export interface ExecutionCasRecord {
  readonly revision: number;
  readonly owner: string | null;
  readonly ownerExpiresAt: number | null;
}

export interface FinalRenderReservationRecord {
  readonly id: string;
  readonly requestCount: 1;
  /** Non-empty provider chunks allowed by RENDER. */
  readonly activityChunks: number;
  /** RENDER chunks plus the one terminal projection event. */
  readonly activityEvents: number;
  readonly contextBytes: number;
  readonly outputBytes: number;
  /** Full context/output plus every terminal projection/receipt payload. */
  readonly maxBytes: number;
  readonly deadlineAt: number;
  readonly revision: number;
  readonly reservedAt: number;
}

export interface CreateTurnExecutionResult {
  readonly execution: TurnExecutionRecord;
  /** Host capability used to CAS this execution until a lease is claimed. */
  readonly ownerToken: string;
  readonly commitKey: string;
}

export interface TransitionTurnExecutionInput {
  executionId: string;
  expectedPhase: TurnExecutionPhase;
  nextPhase: TurnExecutionPhase;
  ownerToken: string;
  expectedRevision?: number;
  reason?: string;
  now?: number;
  db?: Database;
  /** Internal recovery path: the reconciliation lease already resolved controls. */
  ignoreCancellation?: boolean;
}

export interface TransitionTurnExecutionResult {
  readonly execution: TurnExecutionRecord;
  readonly terminalEventEmitted: boolean;
}

export interface ClaimTurnExecutionInput {
  executionId: string;
  ownerToken: string;
  leaseMs?: number;
  db?: Database;
}

export interface FinalRenderReservationInput {
  executionId: string;
  ownerToken: string;
  reservationKey?: string;
  maxBytes: number;
  contextBytes?: number;
  outputBytes?: number;
  activityChunks?: number;
  deadlineAt?: number;
  expectedRevision?: number;
  db?: Database;
}
export interface CommitReceiptInput {
  executionId: string;
  ownerToken?: string;
  /** The receipt is deliberately a bounded summary, not provider output. */
  summary?: unknown;
  receiptId?: string;
  workspaceId?: string;
  idempotencyKey?: string;
  messageId?: string | null;
  swipeId?: number | null;
  artifactRefCount?: number;
  db?: Database;
}

export interface TurnCommitReceipt {
  readonly id: string;
  readonly executionId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly commitKey: string;
  readonly workspaceId: string | null;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly artifactRefCount: number;
  readonly summary: unknown;
  readonly createdAt: number;
}
export interface TurnCommitTransactionInput<T> extends CommitReceiptInput {
  readonly apply: (db: Database) => T;
}

export interface TurnCommitTransactionResult<T> {
  readonly execution: TurnExecutionRecord;
  readonly receipt: TurnCommitReceipt;
  readonly duplicate: boolean;
  readonly value: T | undefined;
}

export interface ReconcileAgentTurnsResult {
  readonly runtimeEpoch: number;
  readonly inspected: number;
  readonly claimed: number;
  readonly failedInterrupted: number;
  readonly committedFromReceipt: number;
  readonly commitFailedWithoutReceipt: number;
  readonly projectionRepairs: number;
  readonly alreadyTerminal: number;
  readonly releasedReservations: number;
  /** False when the fixed startup scan budget deferred candidates. */
  readonly complete?: boolean;
}
const MAX_TARGET_SNAPSHOT_BYTES = 8 * 1024;
const MAX_RESERVATION_BYTES = 256 * 1024 * 1024;
const FORBIDDEN_PERSISTED_KEYS = /(?:render[_-]?guidance|completion[_-]?guidance|transcript|carrier|reasoning|credential|secret|password|token|argument|args|result|response|content|body|prose|raw|provider)/i;
const MAX_ID_BYTES = 256;
const MAX_SUMMARY_BYTES = 32 * 1024;
/** Maximum serialized receipt summary written by this service. */
export const AGENTIC_RECEIPT_SUMMARY_BYTES_V1 = MAX_SUMMARY_BYTES;
/**
 * Canonical final-render reservation envelope. The two canonical projection
 * rows (`agent_run_projections` and `agent_chat_events`), the compatibility
 * projection, and the receipt are all written by the terminal transaction.
 * Keep their existing service/schema bounds here so callers cannot reserve
 * only provider output and undercount the durable handoff.
 */
export const AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1 = Object.freeze({
  terminalProjectionEvents: 1,
  projectionRows: 2,
  projectionSnapshotBytes: 64 * 1024,
  projectionHandoffBytes: 4 * 1024,
  projectionOmissionBytes: 4 * 1024,
  compatibilityProjectionBytes: AGENT_ACTIVITY_RUN_MAX_BYTES,
  receiptWrites: 1,
  receiptSummaryBytes: AGENTIC_RECEIPT_SUMMARY_BYTES_V1,
});

export interface FinalRenderReservationEnvelopeV1 {
  readonly activityChunks: number;
  /** Chunks plus the one terminal projection event. */
  readonly activityEvents: number;
  readonly projectionBytes: number;
  readonly compatibilityProjectionBytes: number;
  readonly receiptBytes: number;
  readonly contextBytes: number;
  readonly outputBytes: number;
  readonly maxBytes: number;
  /** Number of bounded durable payload writes accounted by this envelope. */
  readonly durablePayloadWrites: number;
}

function checkedReservationSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) {
      throw new RangeError("final render reservation exceeds safe integer bounds");
    }
    total += value;
  }
  if (total > MAX_RESERVATION_BYTES) {
    throw new RangeError("final render reservation exceeds host byte ceiling");
  }
  return total;
}

/**
 * Size one final render before the reservation CAS.
 *
 * Formula:
 *   activityEvents = activityChunks + terminalProjectionEvents
 *   projectionBytes = projectionRows *
 *     (projectionSnapshotBytes + projectionHandoffBytes + projectionOmissionBytes)
 *   maxBytes = contextBytes + outputBytes + projectionBytes +
 *     compatibilityProjectionBytes + receiptSummaryBytes
 */
export function calculateFinalRenderReservationEnvelopeV1(input: {
  readonly activityChunks: number;
  readonly contextBytes: number;
  readonly outputBytes: number;
}): FinalRenderReservationEnvelopeV1 {
  const { activityChunks, contextBytes, outputBytes } = input;
  if (
    !Number.isSafeInteger(activityChunks) || activityChunks < 0
    || !Number.isSafeInteger(contextBytes) || contextBytes < 0
    || !Number.isSafeInteger(outputBytes) || outputBytes <= 0
  ) {
    throw new RangeError("final render reservation components are invalid");
  }
  const components = AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1;
  if (activityChunks > Number.MAX_SAFE_INTEGER - components.terminalProjectionEvents) {
    throw new RangeError("final render activity event count exceeds safe integer bounds");
  }
  const projectionBytes = components.projectionRows * (
    components.projectionSnapshotBytes
    + components.projectionHandoffBytes
    + components.projectionOmissionBytes
  );
  const compatibilityProjectionBytes = components.compatibilityProjectionBytes;
  const receiptBytes = components.receiptSummaryBytes;
  const maxBytes = checkedReservationSum([
    contextBytes,
    outputBytes,
    projectionBytes,
    compatibilityProjectionBytes,
    receiptBytes,
  ]);
  return Object.freeze({
    activityChunks,
    activityEvents: activityChunks + components.terminalProjectionEvents,
    projectionBytes,
    compatibilityProjectionBytes,
    receiptBytes,
    contextBytes,
    outputBytes,
    maxBytes,
    durablePayloadWrites: components.projectionRows + 1 + components.receiptWrites,
  });
}

/** Convert the persisted event envelope back to the no-progress stream bound. */
export function finalRenderActivityChunkLimitV1(activityEvents: number): number {
  if (!Number.isSafeInteger(activityEvents) || activityEvents < AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1.terminalProjectionEvents) {
    return -1;
  }
  return activityEvents - AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1.terminalProjectionEvents;
}

/**
 * Size the RENDER no-progress stream bound from the host activityEvents
 * ceiling. One event is reserved for the terminal projection so the
 * persisted envelope's activityEvents equals the host budget. Visible
 * tokens remain bounded by outputBytes, tokens, and deadline — not this
 * count. The reservation lives on the execution row and is not charged
 * against the WORK activity_events ledger.
 */
export function finalRenderActivityChunksFromHostLimitsV1(activityEvents: number): number {
  const chunks = finalRenderActivityChunkLimitV1(activityEvents);
  if (chunks < 0) {
    throw new RangeError("final render host activity event budget is invalid");
  }
  return chunks;
}
const MAX_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_LEASE_MS = 30 * 1000;
const AGENT_TURN_RECONCILIATION_PAGE_SIZE = 256;
const AGENT_TURN_RECONCILIATION_MAX_ROWS = 2048;
const AGENT_TURN_RECONCILIATION_MAX_MS = 5_000;
const TERMINAL_PHASE_SET = new Set<TurnExecutionPhase>(TERMINAL_TURN_PHASES);
const REVERSIBLE_PHASE_SET = new Set<TurnExecutionPhase>(REVERSIBLE_TURN_PHASES);
const STOP_TOO_LATE_PHASE_SET = new Set<TurnExecutionPhase>([
  "COMPLETE",
  "RENDER",
  "PREPARE_COMMIT",
  "COMMITTING",
  "COMMITTED",
]);

let receiptRepairHandler: ((
  execution: TurnExecutionRecord,
  receipt: TurnCommitReceipt,
  options?: Pick<AgentRunReceiptRepairOptions, "historicalTargetRedaction">,
) => void | Promise<void>) | null = null;
let reconciliationClock: () => number = Date.now;

function nowMs(): number {
  return Date.now();
}

function reconciliationNowMs(): number {
  return reconciliationClock();
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedId(value: unknown, field: string, required = false): string | null {
  if (value == null || value === "") {
    if (required) throw new TurnExecutionError("invalid_execution_input", `${field} is required`);
    return null;
  }
  if (typeof value !== "string" || byteLength(value) > MAX_ID_BYTES) {
    throw new TurnExecutionError("invalid_execution_input", `${field} is invalid`);
  }
  return value;
}

function boundedInteger(value: unknown, field: string, fallback: number | null = null): number | null {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TurnExecutionError("invalid_execution_input", `${field} is invalid`);
  }
  return value;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * Keep only bounded scalar metadata.  This is used for ledger/capability and
 * receipt summaries, and intentionally drops fields that could carry model
 * work, tool payloads, credentials, provider carriers, or raw response data.
 */
function scrubSummary(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value == null ? null : undefined;
  if (typeof value === "string") {
    if (byteLength(value) > 256) return value.slice(0, 256);
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value.slice(0, 64)) {
      const clean = scrubSummary(item, depth + 1);
      if (clean !== undefined) out.push(clean);
    }
    return out;
  }
  if (typeof value !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 128)) {
    if (FORBIDDEN_PERSISTED_KEYS.test(key)) continue;
    const clean = scrubSummary(item, depth + 1);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

function scrubJson(value: unknown, maxBytes: number): string {
  const clean = scrubSummary(value) ?? {};
  let encoded = JSON.stringify(clean);
  if (byteLength(encoded) <= maxBytes) return encoded;
  // A summary is never silently truncated into a syntactically invalid value;
  // drop optional data instead.  The fact that data was omitted is not itself
  // persisted as model content.
  encoded = "{}";
  return encoded;
}

function parseSummary(value: unknown): unknown {
  return scrubSummary(parseJson(value)) ?? {};
}

function hasTable(db: Database, table: string): boolean {
  const row = db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) as { present?: number } | null;
  return !!row?.present;
}

function ensureExecutionTable(db: Database): void {
  if (!hasTable(db, "agent_turn_executions")) {
    throw new TurnExecutionError("execution_schema_unavailable", "agent turn execution schema is unavailable");
  }
}

function tableColumns(db: Database, table: string): Set<string> {
  if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error("invalid table name");
  const rows = db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function quoteColumn(name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("invalid column name");
  return `"${name}"`;
}

function firstColumn(columns: Set<string>, ...names: string[]): string | null {
  return names.find((name) => columns.has(name)) ?? null;
}

function addValue(
  columns: Set<string>,
  values: Record<string, unknown>,
  candidates: readonly string[],
  value: unknown,
): void {
  const column = firstColumn(columns, ...candidates);
  if (column && value !== undefined) values[column] = value;
}

function addValues(
  columns: Set<string>,
  values: Record<string, unknown>,
  candidates: readonly string[],
  value: unknown,
): void {
  for (const candidate of candidates) {
    if (columns.has(candidate) && value !== undefined) values[candidate] = value;
  }
}

function insertRow(db: Database, table: string, values: Record<string, unknown>): void {
  const columns = tableColumns(db, table);
  const selected = Object.entries(values).filter(([name, value]) => columns.has(name) && value !== undefined);
  if (selected.length === 0) throw new TurnExecutionError("execution_schema_unavailable", `${table} has no writable columns`);
  const names = selected.map(([name]) => quoteColumn(name)).join(", ");
  const placeholders = selected.map(() => "?").join(", ");
  try {
    db.query(`INSERT INTO ${quoteColumn(table)} (${names}) VALUES (${placeholders})`).run(
      ...(selected.map(([, value]) => value).filter((value): value is SQLQueryBindings => value === null
        || typeof value === "string"
        || typeof value === "number"
        || typeof value === "bigint"
        || typeof value === "boolean"
        || value instanceof Uint8Array)),
    );
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    if (/unique|constraint/i.test(message) && /commit|execution/i.test(message)) {
      throw new TurnExecutionError("commit_key_conflict", "commit key is already in use");
    }
    throw error;
  }
}
function updateRow(
  db: Database,
  table: string,
  values: Record<string, unknown>,
  where: string,
  params: readonly SQLQueryBindings[],
  resultMode: "changes" | "matched" = "changes",
): number {
  const columns = tableColumns(db, table);
  const selected = Object.entries(values).filter(([name, value]) => columns.has(name) && value !== undefined);
  if (selected.length === 0) return 0;
  const assignments = selected.map(([name]) => `${quoteColumn(name)} = ?`).join(", ");
  const bindings: SQLQueryBindings[] = selected
    .map(([, value]) => value)
    .filter((value): value is SQLQueryBindings => value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "bigint"
      || typeof value === "boolean"
      || value instanceof Uint8Array);
  const result = db.query(`UPDATE ${quoteColumn(table)} SET ${assignments} WHERE ${where}`).run(
    ...bindings,
    ...params,
  ) as { changes?: number };
  if (resultMode === "matched") {
    const directResult = db.query("SELECT changes() AS changes").get() as { changes?: unknown } | null;
    return Number(directResult?.changes ?? 0);
  }
  return Number(result?.changes ?? 0);
}
function normalizeTarget(input: TurnExecutionInput): GenerationTargetRecord {
  let kind = input.targetKind;
  let messageId = input.targetMessageId ?? null;
  let swipeId = input.targetSwipeId ?? null;
  if (typeof input.target === "string") kind = input.target;
  if (input.target && typeof input.target === "object") {
    kind = input.target.kind ?? input.target.target;
    messageId = input.target.messageId ?? messageId;
    swipeId = input.target.swipeId ?? swipeId;
  }
  if (!isGenerationTarget(kind)) throw new TurnExecutionError("invalid_execution_input", "target must be normal, continue, regenerate, or swipe");
  messageId = boundedId(messageId, "targetMessageId");
  swipeId = boundedInteger(swipeId, "targetSwipeId");
  let messageIndexValue = input.targetMessageIndex;
  let swipeCountValue = input.targetSwipeCount;
  let chatRevisionValue = input.targetChatRevision;
  let messageRevisionValue = input.targetMessageRevision;
  if (input.target && typeof input.target === "object") {
    messageIndexValue = input.target.messageIndex ?? messageIndexValue;
    swipeCountValue = input.target.swipeCount ?? swipeCountValue;
    chatRevisionValue = input.target.chatGenerationRevision ?? chatRevisionValue;
    messageRevisionValue = input.target.messageGenerationRevision ?? messageRevisionValue;
  }
  const messageIndex = boundedInteger(messageIndexValue, "targetMessageIndex");
  const swipeCount = boundedInteger(swipeCountValue, "targetSwipeCount");
  const chatGenerationRevision = boundedInteger(chatRevisionValue, "targetChatRevision", 0) ?? 0;
  const messageGenerationRevision = boundedInteger(messageRevisionValue, "targetMessageRevision");
  if (kind === "swipe" && swipeId == null) {
    throw new TurnExecutionError("invalid_execution_input", "swipe target requires targetSwipeId");
  }
  if (chatGenerationRevision < 0 || (messageIndex != null && messageIndex < 0)
    || (swipeCount != null && swipeCount < 1)
    || (messageGenerationRevision != null && messageGenerationRevision < 0)) {
    throw new TurnExecutionError("invalid_execution_input", "target revisions are invalid");
  }
  return {
    target: kind,
    chatId: input.chatId,
    branchId: boundedId(input.branchId, "branchId"),
    messageId,
    swipeId,
    messageIndex,
    swipeCount,
    chatGenerationRevision,
    messageGenerationRevision,
  };
}

function normalizeInput(input: TurnExecutionInput): {
  userId: string;
  chatId: string;
  deadlineAt: number;
  id: string;
  branchId: string | null;
  generationId: string;
  target: GenerationTargetRecord;
  targetSnapshot: string;
  attemptLineage: AgentWorkAttemptLineageV1;
  mode: "response" | "agentic";
  runtimeEpoch: number;
  expiresAt: number;
  retention: "operational" | "turn_terminal";
  rootLedger: string;
  frameCapabilities: string;
  workspaceId: string | null;
  workspaceRevision: number;
  ownerToken: string;
  commitKey: string;
} {
  const userId = boundedId(input.userId, "userId", true)!;
  const chatId = boundedId(input.chatId, "chatId", true)!;
  if (typeof input.deadlineAt !== "number" || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt < 0) {
    throw new TurnExecutionError("invalid_execution_input", "deadlineAt is invalid");
  }
  const id = boundedId(input.id, "id") ?? randomId("turn");
  const target = normalizeTarget(input);
  const attemptLineage = attemptLineageForTarget(input.attemptLineage, id, target, nowMs());
  const targetSnapshotValue = scrubSummary({
    ...(input.targetSnapshot && typeof input.targetSnapshot === "object" ? input.targetSnapshot as Record<string, unknown> : {}),
    branchId: target.branchId,
    messageId: target.messageId,
    swipeId: target.swipeId,
    targetKind: target.target,
    messageIndex: target.messageIndex,
    swipeCount: target.swipeCount,
    chatGenerationRevision: target.chatGenerationRevision,
    messageGenerationRevision: target.messageGenerationRevision,
    attemptLineage,
  });
  const targetSnapshot = scrubJson(targetSnapshotValue, MAX_TARGET_SNAPSHOT_BYTES);
  const mode = input.mode ?? "agentic";
  if (mode !== "agentic" && mode !== "response") throw new TurnExecutionError("invalid_execution_input", "mode is invalid");
  const runtimeEpoch = input.runtimeEpoch ?? getRuntimeEpoch();
  if (!Number.isSafeInteger(runtimeEpoch) || runtimeEpoch < 0) throw new TurnExecutionError("invalid_execution_input", "runtimeEpoch is invalid");
  const retention = input.retention ?? "operational";
  if (retention !== "operational" && retention !== "turn_terminal") {
    throw new TurnExecutionError("invalid_execution_input", "retention is invalid");
  }
  const expiresAt = input.expiresAt == null
    ? Math.max(input.deadlineAt, nowMs() + 24 * 60 * 60 * 1000)
    : boundedInteger(input.expiresAt, "expiresAt");
  if (expiresAt == null || expiresAt < 0) throw new TurnExecutionError("invalid_execution_input", "expiresAt is invalid");
  return {
    userId,
    chatId,
    deadlineAt: input.deadlineAt,
    id,
    branchId: target.branchId,
    generationId: boundedId(input.generationId, "generationId") ?? id,
    target,
    targetSnapshot,
    attemptLineage,
    mode,
    runtimeEpoch,
    expiresAt,
    retention,
    rootLedger: scrubJson(input.rootLedger ?? {}, MAX_SUMMARY_BYTES),
    frameCapabilities: scrubJson(input.frameCapabilities ?? {}, MAX_SUMMARY_BYTES),
    workspaceId: boundedId(input.workspaceId, "workspaceId"),
    workspaceRevision: boundedInteger(input.workspaceRevision, "workspaceRevision", 0) ?? 0,
    ownerToken: boundedId(input.ownerToken, "ownerToken") ?? randomId("owner"),
    commitKey: boundedId(input.commitKey, "commitKey") ?? randomId("commit"),
  };
}

function rawExecution(db: Database, executionId: string): Record<string, unknown> | null {
  const row = db.query(`SELECT * FROM ${quoteColumn("agent_turn_executions")} WHERE id = ? LIMIT 1`).get(executionId) as Record<string, unknown> | null;
  return row ?? null;
}

function rowString(row: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = row[name];
    if (typeof value === "string") return value;
  }
  return null;
}

function rowNumber(row: Record<string, unknown>, ...names: string[]): number | null {
  for (const name of names) {
    const value = row[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
  }
  return null;
}

function rowBool(row: Record<string, unknown>, ...names: string[]): boolean {
  const value = rowNumber(row, ...names);
  if (value != null) return value !== 0;
  const string = rowString(row, ...names);
  return string === "true" || string === "1";
}

function rowPhase(row: Record<string, unknown>): TurnExecutionPhase {
  const value = rowString(row, "phase", "state");
  if (!isTurnExecutionPhase(value)) throw new TurnExecutionError("execution_schema_unavailable", "execution contains an unknown phase");
  return value;
}
function workPhaseForExecution(phase: TurnExecutionPhase): AgentWorkPhase {
  if (phase === "ASSEMBLE") return "ASSEMBLE";
  if (phase === "WORK") return "WORK";
  if (phase === "COMPLETE") return "PREPARE_COMMIT";
  if (phase === "RENDER") return "RENDER";
  if (phase === "PREPARE_COMMIT") return "COMMIT";
  if (phase === "COMMITTING") return "COMMIT";
  return "TERMINAL";
}

type CanonicalTerminalCause = "stopped" | "exhausted" | "failed" | "rejected";

const STOPPED_TERMINAL_CODES: ReadonlySet<string> = new Set([
  "cancelled",
  "canceled",
  "stopped",
  "user_stop",
  "accepted_cancellation",
  "agentic_cancelled",
]);
const FAILED_TERMINAL_CODES: ReadonlySet<string> = new Set([
  "timed_out",
  "timeout",
  "deadline_exceeded",
  "agentic_timed_out",
  "root_wall_clock_limit_exceeded",
]);
const EXHAUSTED_TERMINAL_CODES: ReadonlySet<string> = new Set([
  "exhausted",
  "budget_exhausted",
  "budget_exceeded",
  "limit_exceeded",
  "agentic_work_exhausted",
]);
const REJECTED_TERMINAL_CODES: ReadonlySet<string> = new Set([
  "rejected",
  "invalid_input",
  "decision_refresh_required",
  "agentic_runtime_unavailable",
]);
// SQLite's one-argument trim removes only U+0020. This set mirrors
// ECMAScript String.prototype.trim WhiteSpace and LineTerminator code points.
const SQL_ECMASCRIPT_TRIM_CHARACTERS = "char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)";

function terminalCauseForExecutionCode(value: string | null): CanonicalTerminalCause | null {
  if (!value) return null;
  const code = value.trim().toLowerCase();
  if (!code) return null;
  if (STOPPED_TERMINAL_CODES.has(code)) return "stopped";
  if (FAILED_TERMINAL_CODES.has(code)) return "failed";
  if (
    EXHAUSTED_TERMINAL_CODES.has(code)
    || code.endsWith("_limit_exceeded")
    || code.endsWith("_budget_exhausted")
    || code.endsWith("_budget_exceeded")
  ) return "exhausted";
  if (REJECTED_TERMINAL_CODES.has(code)) return "rejected";
  return "failed";
}

function workOutcomeForExecution(
  phase: TurnExecutionPhase,
  terminalCode: string | null,
): AgentWorkOutcome | null {
  if (phase === "COMMITTED") return "completed";
  if (phase === "CANCELLED") return "stopped";
  if (phase === "TIMED_OUT") return "failed";
  if (phase === "EXHAUSTED") return "exhausted";
  if (phase !== "COMMIT_FAILED" && phase !== "FAILED") return null;
  return terminalCauseForExecutionCode(terminalCode) ?? "failed";
}

function workStatusForExecution(
  phase: TurnExecutionPhase,
  cancelRequested: boolean,
  terminalCode: string | null,
): AgentWorkStatus {
  if (workOutcomeForExecution(phase, terminalCode) !== null) return "terminal";
  if (cancelRequested) return "cancelling";
  if (phase === "COMPLETE" || phase === "PREPARE_COMMIT") return "waiting";
  return "running";
}

function workReasonForExecution(
  phase: TurnExecutionPhase,
  terminalCode: string | null,
): string | null {
  if (!TERMINAL_PHASE_SET.has(phase) || phase === "COMMITTED") return null;
  if (terminalCode && terminalCode.trim().length > 0) {
    return terminalCauseForExecutionCode(terminalCode) === "stopped" ? "stopped" : terminalCode;
  }
  if (phase === "CANCELLED") return "stopped";
  if (phase === "TIMED_OUT") return "timed_out";
  if (phase === "EXHAUSTED") return "exhausted";
  if (phase === "COMMIT_FAILED") return "commit_failed";
  return "failed";
}
function attemptLineageForTarget(
  value: unknown,
  id: string,
  target: GenerationTargetRecord,
  createdAt: number,
): AgentWorkAttemptLineageV1 {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const attemptId = boundedId(source.attemptId, "attemptId") ?? id;
  const previousAttemptId = source.previousAttemptId === null
    ? null
    : boundedId(source.previousAttemptId, "previousAttemptId");
  const sourceCreatedAt = boundedInteger(source.createdAt, "attemptCreatedAt");
  return {
    version: 1,
    attemptId,
    previousAttemptId,
    target: {
      chatId: target.chatId,
      generationType: target.target,
      messageId: target.messageId,
      swipeId: target.swipeId,
    },
    createdAt: sourceCreatedAt ?? createdAt,
  };
}


function parseReservations(value: unknown): FinalRenderReservationRecord[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  const reservations: FinalRenderReservationRecord[] = [];
  for (const item of parsed.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const id = boundedId(candidate.id, "reservationId");
    const requestCount = candidate.requestCount === 1 ? 1 : boundedInteger(candidate.requestCount, "requestCount");
    const activityChunks = boundedInteger(candidate.activityChunks, "activityChunks", 0);
    const activityEvents = boundedInteger(candidate.activityEvents, "activityEvents", 1);
    const contextBytes = boundedInteger(candidate.contextBytes, "contextBytes");
    const outputBytes = boundedInteger(candidate.outputBytes, "outputBytes");
    const maxBytes = boundedInteger(candidate.maxBytes, "maxBytes");
    const deadlineAt = boundedInteger(candidate.deadlineAt, "reservationDeadline");
    const revision = boundedInteger(candidate.revision, "reservationRevision");
    const reservedAt = boundedInteger(candidate.reservedAt, "reservedAt");
    if (
      !id || requestCount !== 1 || activityChunks == null || activityEvents == null
      || contextBytes == null || outputBytes == null || maxBytes == null
      || deadlineAt == null || revision == null || reservedAt == null
    ) continue;
    let envelope: FinalRenderReservationEnvelopeV1;
    try {
      envelope = calculateFinalRenderReservationEnvelopeV1({ activityChunks, contextBytes, outputBytes });
    } catch {
      continue;
    }
    if (activityEvents !== envelope.activityEvents || maxBytes !== envelope.maxBytes) continue;
    reservations.push({
      id,
      requestCount: 1,
      activityChunks,
      activityEvents,
      contextBytes,
      outputBytes,
      maxBytes,
      deadlineAt,
      revision,
      reservedAt,
    });
  }
  return reservations;
}

function recordFromRow(row: Record<string, unknown>): TurnExecutionRecord {
  const phase = rowPhase(row);
  const id = rowString(row, "id", "execution_id");
  const userId = rowString(row, "user_id");
  const chatId = rowString(row, "chat_id");
  const commitKey = rowString(row, "commit_key");
  if (!id || !userId || !chatId || !commitKey) throw new TurnExecutionError("execution_schema_unavailable", "execution identity is incomplete");
  if (TERMINAL_PHASE_SET.has(phase)) {
    invalidateFrameCapabilitiesForTurn({ userId, chatId, turnId: id });
  }
  const targetKindValue = rowString(row, "target_kind", "target");
  if (!isGenerationTarget(targetKindValue)) throw new TurnExecutionError("execution_schema_unavailable", "execution target is invalid");
  const targetMessageIndex = rowNumber(row, "target_message_index");
  const targetSwipeCount = rowNumber(row, "target_swipe_count");
  const targetChatRevision = rowNumber(row, "target_chat_revision") ?? 0;
  const targetMessageRevision = rowNumber(row, "target_message_revision");
  const target: GenerationTargetRecord = {
    target: targetKindValue,
    chatId,
    branchId: rowString(row, "branch_id"),
    messageId: rowString(row, "target_message_id", "message_id"),
    swipeId: rowNumber(row, "target_swipe_id", "swipe_id"),
    messageIndex: targetMessageIndex,
    swipeCount: targetSwipeCount,
    chatGenerationRevision: targetChatRevision,
    messageGenerationRevision: targetMessageRevision,
  };
  const presetRevision = rowNumber(row, "preset_revision") ?? 0;
  const configRevision = rowNumber(row, "config_revision") ?? 0;
  const concreteConnectionRevision = rowNumber(row, "concrete_connection_revision", "connection_revision") ?? 0;
  const worldLoreRevision = rowNumber(row, "world_lore_revision", "world_revision") ?? 0;
  const runtimeEpoch = rowNumber(row, "runtime_epoch") ?? 0;
  const casRevision = rowNumber(row, "cas_revision", "revision") ?? 0;
  const phaseRevision = rowNumber(row, "phase_revision") ?? casRevision;
  const cancelRequestedAt = rowNumber(row, "cancel_requested_at");
  const cancelRequested = cancelRequestedAt != null || rowBool(row, "cancel_requested", "cancellation_requested");
  const createdAt = rowNumber(row, "created_at") ?? 0;
  const updatedAt = rowNumber(row, "updated_at") ?? 0;
  const targetSnapshot = parseJson(rowString(row, "target_snapshot_json", "target_snapshot")) ?? target;
  const targetSnapshotObject = targetSnapshot && typeof targetSnapshot === "object" && !Array.isArray(targetSnapshot)
    ? targetSnapshot as Record<string, unknown> : {};
  const attemptLineage = attemptLineageForTarget(targetSnapshotObject.attemptLineage, id, target, createdAt);
  const terminalCode = rowString(row, "terminal_code", "error_code");
  const workPhase = workPhaseForExecution(phase);
  const workStatus = workStatusForExecution(phase, cancelRequested, terminalCode);
  const workOutcome = workOutcomeForExecution(phase, terminalCode);
  const reason = workReasonForExecution(phase, terminalCode);
  const finalRenderReservations = parseReservations(rowString(row, "final_render_reservations_json"));
  const activeReservation = finalRenderReservations[finalRenderReservations.length - 1] ?? null;
  return {
    id,
    userId,
    chatId,
    branchId: target.branchId,
    generationId: rowString(row, "generation_id") ?? id,
    targetKind: targetKindValue,
    targetMessageId: target.messageId,
    targetSwipeId: target.swipeId,
    targetMessageIndex,
    targetSwipeCount,
    targetChatRevision,
    targetMessageRevision,
    targetSnapshot,
    presetSnapshotId: rowString(row, "preset_snapshot_id", "preset_id"),
    presetRevision,
    configSnapshotId: rowString(row, "config_snapshot_id", "config_id"),
    configRevision,
    concreteConnectionSnapshotId: rowString(row, "concrete_connection_snapshot_id", "connection_snapshot_id"),
    concreteConnectionRevision,
    worldLoreSnapshotId: rowString(row, "world_lore_snapshot_id", "world_snapshot_id"),
    worldLoreRevision,
    mode: rowString(row, "mode") === "response" ? "response" : "agentic",
    workPhase,
    workStatus,
    workOutcome,
    reason,
    attemptLineage,
    phase,
    state: phase,
    runtimeEpoch,
    deadlineAt: rowNumber(row, "deadline_at", "deadline") ?? 0,
    cancelRequested,
    cancelRequestedAt,
    workspaceId: rowString(row, "workspace_id"),
    rootLedger: parseSummary(rowString(row, "root_ledger_json", "root_ledger")),
    frameCapabilities: parseSummary(rowString(row, "frame_capabilities_json", "frame_capabilities")),
    workspaceRevision: rowNumber(row, "workspace_revision") ?? 0,
    casRevision,
    phaseRevision,
    casOwner: rowString(row, "cas_owner", "lease_owner", "owner_token"),
    leaseExpiresAt: rowNumber(row, "cas_expires_at", "lease_expires_at", "lease_expires"),
    leaseGeneration: rowNumber(row, "lease_generation") ?? 0,
    commitKey,
    terminalCode,
    finalRenderReservationKey: activeReservation?.id ?? null,
    finalRenderReservations,
    finalRenderReservationReleasedAt: TERMINAL_PHASE_SET.has(phase) && finalRenderReservations.length === 0
      ? rowNumber(row, "terminal_at")
      : null,
    terminalEventId: rowString(row, "terminal_event_id", "terminal_event_key"),
    createdAt,
    updatedAt,
    terminalAt: rowNumber(row, "terminal_at"),
    target,
    frozenRevisions: {
      target,
      presetId: rowString(row, "preset_snapshot_id", "preset_id"),
      presetRevision,
      configId: rowString(row, "config_snapshot_id", "config_id"),
      configRevision,
      connectionId: rowString(row, "concrete_connection_snapshot_id", "connection_snapshot_id"),
      connectionRevision: concreteConnectionRevision,
      worldLoreSnapshotId: rowString(row, "world_lore_snapshot_id", "world_snapshot_id"),
      worldLoreRevision,
      runtimeEpoch,
    },
    cas: {
      revision: casRevision,
      owner: rowString(row, "cas_owner", "lease_owner", "owner_token"),
      ownerExpiresAt: rowNumber(row, "cas_expires_at", "lease_expires_at", "lease_expires"),
    },
  };
}

function requireExecution(db: Database, executionId: string, userId?: string): { raw: Record<string, unknown>; execution: TurnExecutionRecord } {
  ensureExecutionTable(db);
  const raw = rawExecution(db, executionId);
  if (!raw) throw new TurnExecutionError("execution_not_found", "execution not found", { executionId });
  const execution = recordFromRow(raw);
  if (userId !== undefined && execution.userId !== userId) {
    throw new TurnExecutionError("execution_not_found", "execution not found", { executionId });
  }
  if (TERMINAL_PHASE_SET.has(execution.phase)) {
    invalidateFrameCapabilitiesForTurn({
      userId: execution.userId,
      chatId: execution.chatId,
      turnId: execution.id,
    });
  }
  return { raw, execution };
}

function ownerMatches(execution: TurnExecutionRecord, ownerToken: string): boolean {
  return !!ownerToken && execution.casOwner === ownerToken;
}

function ensureOwner(execution: TurnExecutionRecord, ownerToken: string): void {
  if (!ownerMatches(execution, ownerToken)) {
    throw new TurnExecutionError("stale_owner", "execution lease is not owned by this caller", {
      executionId: execution.id,
      phase: execution.phase,
    });
  }
}

function terminalCodeFor(phase: TerminalTurnPhase, reason?: string): string {
  if (reason && byteLength(reason) <= 128) return reason;
  switch (phase) {
    case "FAILED": return "failed";
    case "CANCELLED": return "cancelled";
    case "TIMED_OUT": return "timed_out";
    case "EXHAUSTED": return "exhausted";
    case "COMMIT_FAILED": return "commit_failed";
    case "COMMITTED": return "committed";
  }
}


function cancellationMarkerAbsentPredicates(db: Database): readonly string[] {
  const columns = tableColumns(db, "agent_turn_executions");
  if (columns.has("cancel_requested_at")) return [`${quoteColumn("cancel_requested_at")} IS NULL`];
  const compatible = ["cancel_requested", "cancellation_requested"].filter((column) => columns.has(column));
  if (compatible.length === 0) {
    throw new TurnExecutionError(
      "execution_schema_unavailable",
      "agent turn execution schema has no durable cancellation marker",
    );
  }
  return compatible.map((column) => `COALESCE(${quoteColumn(column)}, 0) = 0`);
}
function updateCas(
  db: Database,
  current: TurnExecutionRecord,
  values: Record<string, unknown>,
  ownerToken: string | null,
  expectedPhase: TurnExecutionPhase,
  expectedRevision: number,
  additionalPredicates: readonly string[] = [],
): boolean {
  const columns = tableColumns(db, "agent_turn_executions");
  const where: string[] = ["id = ?"];
  const params: SQLQueryBindings[] = [current.id];
  if (columns.has("phase")) {
    where.push("phase = ?");
    params.push(expectedPhase);
  } else if (columns.has("state")) {
    where.push("state = ?");
    params.push(expectedPhase);
  }
  if (columns.has("cas_revision")) {
    where.push("cas_revision = ?");
    params.push(expectedRevision);
  } else if (columns.has("revision")) {
    where.push("revision = ?");
    params.push(expectedRevision);
  }
  if (ownerToken === null) {
    const ownerColumns = ["cas_owner", "lease_owner", "owner_token"].filter((column) => columns.has(column));
    if (ownerColumns.length === 0) return false;
    for (const column of ownerColumns) where.push(`${column} IS NULL`);
  } else if (columns.has("cas_owner")) {
    where.push("cas_owner = ?");
    params.push(ownerToken);
  } else if (columns.has("lease_owner")) {
    where.push("lease_owner = ?");
    params.push(ownerToken);
  } else if (columns.has("owner_token")) {
    where.push("owner_token = ?");
    params.push(ownerToken);
  } else {
    return false;
  }
  where.push(...additionalPredicates);
  return updateRow(db, "agent_turn_executions", values, where.join(" AND "), params, "matched") === 1;
}

function terminalUpdateValues(
  db: Database,
  current: TurnExecutionRecord,
  phase: TerminalTurnPhase,
  now: number,
  reason?: string,
): Record<string, unknown> {
  // COMMITTED first becomes authoritative with its receipt. Its public
  // terminal event is a separate, receipt-backed convergence transaction.
  const terminalEventId = phase === "COMMITTED" ? null : randomId("terminal");
  const values: Record<string, unknown> = {
    phase,
    state: phase,
    terminal_code: terminalCodeFor(phase, reason),
    terminal_at: now,
    updated_at: now,
    terminal_event_id: terminalEventId,
    terminal_event_emitted_at: phase === "COMMITTED" ? null : now,
    cas_owner: null,
    lease_owner: null,
    cas_expires_at: null,
    lease_expires_at: null,
    final_render_reservation_key: null,
    final_render_reservation_released_at: now,
    final_render_reservations_json: "[]",
  };
  const markerAt = current.cancelRequested
    ? current.cancelRequestedAt ?? current.updatedAt
    : phase === "CANCELLED" ? now : null;
  if (markerAt !== null) {
    const columns = tableColumns(db, "agent_turn_executions");
    if (columns.has("cancel_requested_at")) {
      values.cancel_requested_at = markerAt;
    } else {
      for (const column of ["cancel_requested", "cancellation_requested"]) {
        if (columns.has(column)) values[column] = 1;
      }
      // Boolean-only compatibility uses updated_at as first-cause authority.
      values.updated_at = markerAt;
    }
  }
  return values;
}

function terminalizeWithCas(
  db: Database,
  current: TurnExecutionRecord,
  ownerToken: string | null,
  expectedPhase: TurnExecutionPhase,
  expectedRevision: number,
  phase: TerminalTurnPhase,
  reason?: string,
  now = nowMs(),
  additionalPredicates: readonly string[] = [],
): TransitionTurnExecutionResult {
  const values = terminalUpdateValues(db, current, phase, now, reason);
  values.cas_revision = current.casRevision + 1;
  values.phase_revision = current.phaseRevision + 1;
  if (!updateCas(db, current, values, ownerToken, expectedPhase, expectedRevision, additionalPredicates)) {
    const latest = rawExecution(db, current.id);
    if (latest && TERMINAL_PHASE_SET.has(rowPhase(latest))) {
      return { execution: recordFromRow(latest), terminalEventEmitted: false };
    }
    throw new TurnExecutionError("stale_execution", "execution changed before terminal transition", {
      executionId: current.id,
      phase: current.phase,
    });
  }
  const latest = requireExecution(db, current.id).execution;
  return { execution: latest, terminalEventEmitted: true };
}
function ensureCanonicalMarkerTerminal(
  execution: TurnExecutionRecord,
  markerCause: ReturnType<typeof cancellationTerminalCause>,
): void {
  if (execution.phase !== markerCause.phase
    || execution.terminalCode !== terminalCodeFor(markerCause.phase, markerCause.reason)) {
    throw new TurnExecutionError("invalid_execution_input", "accepted cancellation marker lost its terminal cause", {
      executionId: execution.id,
      phase: execution.phase,
    });
  }
}
function terminalizeWithCancellationMarkerFence(
  db: Database,
  current: TurnExecutionRecord,
  ownerToken: string | null,
  phase: TerminalTurnPhase,
  reason: string | undefined,
  now: number,
): {
  outcome: TransitionTurnExecutionResult;
  markerCause: ReturnType<typeof cancellationTerminalCause> | null;
} {
  const terminalizeMarker = (candidate: TurnExecutionRecord) => {
    const markerCause = cancellationTerminalCause(
      candidate.cancelRequestedAt ?? candidate.updatedAt,
      candidate.deadlineAt,
    );
    const outcome = terminalizeWithCas(
      db,
      candidate,
      ownerToken,
      candidate.phase,
      candidate.casRevision,
      markerCause.phase,
      markerCause.reason,
      now,
    );
    ensureCanonicalMarkerTerminal(outcome.execution, markerCause);
    return { outcome, markerCause };
  };

  if (current.cancelRequested) return terminalizeMarker(current);
  const terminalReason = phase === "CANCELLED"
    ? cancellationTerminalCause(now, current.deadlineAt).reason
    : reason;
  try {
    const outcome = terminalizeWithCas(
      db,
      current,
      ownerToken,
      current.phase,
      current.casRevision,
      phase,
      terminalReason,
      now,
      cancellationMarkerAbsentPredicates(db),
    );
    const markerCause = outcome.execution.cancelRequested
      ? cancellationTerminalCause(
          outcome.execution.cancelRequestedAt ?? outcome.execution.updatedAt,
          outcome.execution.deadlineAt,
        )
      : null;
    if (markerCause) ensureCanonicalMarkerTerminal(outcome.execution, markerCause);
    return { outcome, markerCause };
  } catch (error) {
    if (!(error instanceof TurnExecutionError) || error.code !== "stale_execution") throw error;
  }

  const latest = requireExecution(db, current.id).execution;
  if (latest.cancelRequested && REVERSIBLE_PHASE_SET.has(latest.phase)) {
    return terminalizeMarker(latest);
  }
  if (TERMINAL_PHASE_SET.has(latest.phase)) {
    const markerCause = latest.cancelRequested
      ? cancellationTerminalCause(latest.cancelRequestedAt ?? latest.updatedAt, latest.deadlineAt)
      : null;
    if (markerCause) ensureCanonicalMarkerTerminal(latest, markerCause);
    return {
      outcome: { execution: latest, terminalEventEmitted: false },
      markerCause,
    };
  }
  throw new TurnExecutionError("stale_execution", "execution changed before cancellation-fenced terminal transition", {
    executionId: latest.id,
    phase: latest.phase,
  });
}

/** Create the durable row before any generation/chat mutation is permitted. */
export function createTurnExecution(
  input: TurnExecutionInput,
  db: Database = getDb(),
): CreateTurnExecutionResult {
  ensureExecutionTable(db);
  const normalized = normalizeInput(input);
  const columns = tableColumns(db, "agent_turn_executions");
  const now = nowMs();
  const values: Record<string, unknown> = {};
  addValue(columns, values, ["id"], normalized.id);
  addValue(columns, values, ["user_id"], normalized.userId);
  addValue(columns, values, ["chat_id"], normalized.chatId);
  addValue(columns, values, ["branch_id"], normalized.branchId);
  addValue(columns, values, ["generation_id"], normalized.generationId);
  addValue(columns, values, ["target_kind", "target"], normalized.target.target);
  addValue(columns, values, ["target_message_id", "message_id"], normalized.target.messageId);
  addValue(columns, values, ["target_swipe_id", "swipe_id"], normalized.target.swipeId);
  addValue(columns, values, ["target_message_index"], normalized.target.messageIndex);
  addValue(columns, values, ["target_swipe_count"], normalized.target.swipeCount);
  addValue(columns, values, ["target_chat_revision"], normalized.target.chatGenerationRevision);
  addValue(columns, values, ["target_message_revision"], normalized.target.messageGenerationRevision);
  addValue(columns, values, ["target_snapshot_json", "target_snapshot"], normalized.targetSnapshot);
  addValue(columns, values, ["preset_snapshot_id", "preset_id"], boundedId(input.presetSnapshotId, "presetSnapshotId"));
  addValue(columns, values, ["preset_revision"], boundedInteger(input.presetRevision, "presetRevision", 0));
  addValue(columns, values, ["config_snapshot_id", "config_id"], boundedId(input.configSnapshotId, "configSnapshotId"));
  addValue(columns, values, ["config_revision"], boundedInteger(input.configRevision, "configRevision", 0));
  addValue(columns, values, ["concrete_connection_snapshot_id", "connection_snapshot_id"], boundedId(input.concreteConnectionSnapshotId, "concreteConnectionSnapshotId"));
  addValue(columns, values, ["concrete_connection_revision", "connection_revision"], boundedInteger(input.concreteConnectionRevision, "concreteConnectionRevision", 0));
  addValue(columns, values, ["world_lore_snapshot_id", "world_snapshot_id"], boundedId(input.worldLoreSnapshotId, "worldLoreSnapshotId"));
  addValue(columns, values, ["world_lore_revision", "world_revision"], boundedInteger(input.worldLoreRevision, "worldLoreRevision", 0));
  addValue(columns, values, ["mode"], normalized.mode);
  addValues(columns, values, ["phase", "state"], "ASSEMBLE");
  addValue(columns, values, ["runtime_epoch"], normalized.runtimeEpoch);
  addValue(columns, values, ["deadline_at", "deadline"], normalized.deadlineAt);
  addValue(columns, values, ["cancel_requested_at"], null);
  addValues(columns, values, ["cancel_requested", "cancellation_requested"], 0);
  addValue(columns, values, ["workspace_id"], normalized.workspaceId);
  addValue(columns, values, ["root_ledger_json", "root_ledger"], normalized.rootLedger);
  addValue(columns, values, ["frame_capabilities_json", "frame_capabilities"], normalized.frameCapabilities);
  addValue(columns, values, ["workspace_revision"], normalized.workspaceRevision);
  addValue(columns, values, ["cas_revision", "revision"], 0);
  addValue(columns, values, ["phase_revision"], 0);
  addValues(columns, values, ["cas_owner", "lease_owner", "owner_token"], normalized.ownerToken);
  addValue(columns, values, ["lease_generation"], 1);
  addValue(columns, values, ["cas_expires_at", "lease_expires_at", "lease_expires"], Math.min(now + DEFAULT_LEASE_MS, normalized.deadlineAt));
  addValue(columns, values, ["commit_key"], normalized.commitKey);
  addValue(columns, values, ["final_render_reservations_json"], "[]");
  addValue(columns, values, ["expires_at"], normalized.expiresAt);
  addValue(columns, values, ["retention"], normalized.retention);
  addValue(columns, values, ["created_at"], now);
  addValue(columns, values, ["updated_at"], now);
  try {
    insertRow(db, "agent_turn_executions", values);
  } catch (error) {
    if (error instanceof TurnExecutionError) throw error;
    const message = String((error as Error)?.message ?? error);
    if (/unique|constraint/i.test(message) && /commit_key/i.test(message)) {
      throw new TurnExecutionError("commit_key_conflict", "commit key is already in use", { executionId: normalized.id });
    }
    throw error;
  }
  const execution = requireExecution(db, normalized.id).execution;
  if (input.cancelSignal) {
    input.cancelSignal.addEventListener("abort", () => {
      try {
        const reason = input.cancelSignal?.reason as { name?: unknown } | undefined;
        requestActiveTurnCancellation({
          executionId: normalized.id,
          ownerToken: normalized.ownerToken,
          reason: reason?.name === "TimeoutError" ? "timed_out" : "cancelled",
          db,
        });
      } catch {
        // A terminal owner or process restart owns cleanup; abort never retries.
      }
    }, { once: true });
  }
  return { execution, ownerToken: normalized.ownerToken, commitKey: normalized.commitKey };
}

export function getTurnExecution(
  executionId: string,
  userId?: string,
  db: Database = getDb(),
): TurnExecutionRecord | null {
  try {
    return requireExecution(db, executionId, userId).execution;
  } catch (error) {
    if (error instanceof TurnExecutionError && error.code === "execution_not_found") return null;
    throw error;
  }
}
/**
 * Read the durable commit receipt without changing execution state.
 *
 * Recovery callers use the receipt as the commit boundary, but the execution
 * phase remains authoritative until the receipt repair transaction has
 * completed. Keeping this lookup read-only lets startup order those two
 * repairs explicitly.
 */
export function getTurnCommitReceipt(
  executionId: string,
  userId?: string,
  db: Database = getDb(),
): TurnCommitReceipt | null {
  const execution = getTurnExecution(executionId, userId, db);
  if (!execution) return null;
  const row = rawReceipt(db, execution);
  return row ? receiptFromRow(row, execution) : null;
}

export function claimTurnExecution(
  input: ClaimTurnExecutionInput,
): TurnExecutionRecord {
  const db = input.db ?? getDb();
  const current = requireExecution(db, input.executionId).execution;
  if (TERMINAL_PHASE_SET.has(current.phase)) return current;
  const leaseMs = Math.max(1_000, Math.min(MAX_LEASE_MS, Math.floor(input.leaseMs ?? DEFAULT_LEASE_MS)));
  if (!input.ownerToken || byteLength(input.ownerToken) > MAX_ID_BYTES) {
    throw new TurnExecutionError("invalid_execution_input", "ownerToken is invalid", { executionId: current.id });
  }
  const now = nowMs();
  if (current.casOwner && current.casOwner !== input.ownerToken
    && current.leaseExpiresAt != null && current.leaseExpiresAt > now
    && current.runtimeEpoch === getRuntimeEpoch()) {
    throw new TurnExecutionError("lease_conflict", "execution lease is held by another owner", {
      executionId: current.id,
      phase: current.phase,
    });
  }
  const values: Record<string, unknown> = {
    cas_owner: input.ownerToken,
    lease_owner: input.ownerToken,
    cas_expires_at: now + leaseMs,
    lease_expires_at: now + leaseMs,
    runtime_epoch: getRuntimeEpoch(),
    cas_revision: current.casRevision + 1,
    revision: current.casRevision + 1,
    phase_revision: current.phaseRevision,
    lease_generation: current.leaseGeneration + 1,
    updated_at: now,
  };
  const columns = tableColumns(db, "agent_turn_executions");
  const where = ["id = ?"];
  const params: SQLQueryBindings[] = [current.id];
  if (columns.has("cas_revision")) {
    where.push("cas_revision = ?");
    params.push(current.casRevision);
  } else if (columns.has("revision")) {
    where.push("revision = ?");
    params.push(current.casRevision);
  }
  if (columns.has("phase")) {
    where.push("phase = ?");
    params.push(current.phase);
  } else if (columns.has("state")) {
    where.push("state = ?");
    params.push(current.phase);
  }
  const changes = updateRow(db, "agent_turn_executions", values, where.join(" AND "), params);
  if (changes !== 1) throw new TurnExecutionError("stale_execution", "execution changed before lease claim", { executionId: current.id });
  return requireExecution(db, current.id).execution;
}

export function transitionTurnExecution(input: TransitionTurnExecutionInput): TransitionTurnExecutionResult {
  const db = input.db ?? getDb();
  const current = requireExecution(db, input.executionId).execution;
  if (TERMINAL_PHASE_SET.has(current.phase)) {
    throw new TurnExecutionError("already_terminal", "execution is already terminal", { executionId: current.id, phase: current.phase });
  }
  if (current.phase !== input.expectedPhase) {
    throw new TurnExecutionError("stale_execution", "execution phase no longer matches", { executionId: current.id, phase: current.phase });
  }
  ensureOwner(current, input.ownerToken);
  const expectedRevision = input.expectedRevision ?? current.casRevision;
  if (current.casRevision !== expectedRevision) {
    throw new TurnExecutionError("stale_execution", "execution revision no longer matches", { executionId: current.id, phase: current.phase });
  }
  if (!isAllowedTurnExecutionTransition(input.expectedPhase, input.nextPhase)) {
    throw new TurnExecutionError("invalid_transition", `${input.expectedPhase} cannot transition to ${input.nextPhase}`, {
      executionId: current.id,
      phase: current.phase,
    });
  }
  const now = input.now ?? nowMs();
  const cancellationFenced = !input.ignoreCancellation && REVERSIBLE_PHASE_SET.has(current.phase);
  const markerAbsentPredicates = cancellationFenced ? cancellationMarkerAbsentPredicates(db) : [];
  if (cancellationFenced && current.cancelRequested) {
    const markerAt = current.cancelRequestedAt ?? current.updatedAt;
    const requestedCause = cancellationTerminalCause(markerAt, current.deadlineAt);
    return terminalizeWithCancellationMarkerFence(
      db,
      current,
      input.ownerToken,
      requestedCause.phase,
      requestedCause.reason,
      now,
    ).outcome;
  }
  const deadlineElapsed = cancellationFenced && current.deadlineAt > 0 && now >= current.deadlineAt;
  const nextPhase = deadlineElapsed ? "TIMED_OUT" : input.nextPhase;
  const reason = deadlineElapsed ? "root_wall_clock_limit_exceeded" : input.reason;
  const terminal = TERMINAL_PHASE_SET.has(nextPhase);
  const values: Record<string, unknown> = terminal
    ? {
        ...terminalUpdateValues(db, current, nextPhase as TerminalTurnPhase, now, reason),
        cas_revision: current.casRevision + 1,
        phase_revision: current.phaseRevision + 1,
      }
    : {
        phase: nextPhase,
        state: nextPhase,
        cas_revision: current.casRevision + 1,
        revision: current.casRevision + 1,
        phase_revision: current.phaseRevision + 1,
        updated_at: now,
      };
  if (!updateCas(
    db, current, values, input.ownerToken, input.expectedPhase, expectedRevision, markerAbsentPredicates,
  )) {
    const latest = requireExecution(db, current.id).execution;
    if (cancellationFenced && latest.cancelRequested && REVERSIBLE_PHASE_SET.has(latest.phase)) {
      const markerAt = latest.cancelRequestedAt ?? latest.updatedAt;
      const requestedCause = cancellationTerminalCause(markerAt, latest.deadlineAt);
      return terminalizeWithCancellationMarkerFence(
        db,
        latest,
        input.ownerToken,
        requestedCause.phase,
        requestedCause.reason,
        now,
      ).outcome;
    }
    if (TERMINAL_PHASE_SET.has(latest.phase)) {
      throw new TurnExecutionError("already_terminal", "execution became terminal", { executionId: current.id, phase: latest.phase });
    }
    throw new TurnExecutionError("stale_execution", "execution changed before transition", { executionId: current.id, phase: latest.phase });
  }
  return {
    execution: requireExecution(db, current.id).execution,
    terminalEventEmitted: terminal,
  };
}

export type TurnCancellationCode = "cancelled" | "timed_out" | "too_late" | "already_terminal";

export interface TurnCancellationResult {
  readonly execution: TurnExecutionRecord;
  readonly code: TurnCancellationCode;
}
export interface ActiveTurnCancellationRequestResult {
  readonly execution: TurnExecutionRecord;
  readonly code: TurnCancellationCode;
}
function cancellationResultFromSettlement(
  settled: ReturnType<typeof terminalizeWithCancellationMarkerFence>,
  fallbackCode: TurnCancellationCode,
): TurnCancellationResult {
  const execution = settled.outcome.execution;
  const cancellationAuthority = settled.outcome.terminalEventEmitted || settled.markerCause !== null;
  const code: TurnCancellationCode = cancellationAuthority && execution.phase === "CANCELLED"
    ? "cancelled"
    : cancellationAuthority && execution.phase === "TIMED_OUT"
      ? "timed_out"
      : STOP_TOO_LATE_PHASE_SET.has(execution.phase)
        ? "too_late"
        : TERMINAL_PHASE_SET.has(execution.phase)
          ? "already_terminal"
          : fallbackCode;
  return { execution, code };
}

/**
 * Persist cancellation intent for a live reversible turn without releasing its
 * owner or changing its CAS revision. Segmented WORK must settle and close its
 * durable dispatch/recovery authority before the ordinary terminal transition
 * clears that authority.
 */
export function requestActiveTurnCancellation(input: {
  executionId: string;
  ownerToken: string;
  reason?: string;
  now?: number;
  db?: Database;
}): ActiveTurnCancellationRequestResult {
  const db = input.db ?? getDb();
  const current = requireExecution(db, input.executionId).execution;
  if (STOP_TOO_LATE_PHASE_SET.has(current.phase)) {
    return { execution: current, code: "too_late" };
  }
  if (TERMINAL_PHASE_SET.has(current.phase)) {
    return { execution: current, code: "already_terminal" };
  }
  if (!REVERSIBLE_PHASE_SET.has(current.phase)) {
    return { execution: current, code: "too_late" };
  }
  ensureOwner(current, input.ownerToken);
  const now = input.now ?? nowMs();
  // The first persisted request wins. Its timestamp relative to the immutable
  // deadline is also the durable cause discriminator, so retries keep the
  // original request time even if a same-owner forward CAS advances the row.
  const requestAt = current.cancelRequested
    ? current.cancelRequestedAt ?? current.updatedAt
    : input.reason === "timed_out" && current.deadlineAt > now ? current.deadlineAt : now;
  const acceptedCause = cancellationTerminalCause(requestAt, current.deadlineAt);
  const acceptedCode: TurnCancellationCode = acceptedCause.code;
  if (current.cancelRequested) return { execution: current, code: acceptedCode };
  if (acceptedCode === "cancelled" && (current.leaseExpiresAt === null || current.leaseExpiresAt <= now)) {
    throw new TurnExecutionError("stale_owner", "execution owner lease expired before cancellation request", {
      executionId: current.id,
      phase: current.phase,
    });
  }

  const columns = tableColumns(db, "agent_turn_executions");
  const markerValues: Record<string, unknown> = { updated_at: requestAt };
  const markerAbsentPredicates: string[] = [];
  if (columns.has("cancel_requested_at")) {
    markerValues.cancel_requested_at = requestAt;
    markerAbsentPredicates.push(`${quoteColumn("cancel_requested_at")} IS NULL`);
  } else {
    for (const column of ["cancel_requested", "cancellation_requested"]) {
      if (!columns.has(column)) continue;
      markerValues[column] = 1;
      markerAbsentPredicates.push(`COALESCE(${quoteColumn(column)}, 0) = 0`);
    }
    if (markerAbsentPredicates.length === 0) {
      throw new TurnExecutionError(
        "execution_schema_unavailable",
        "agent turn execution schema has no durable cancellation marker",
        { executionId: current.id },
      );
    }
  }

  const sameExecutionIdentity = (candidate: TurnExecutionRecord): boolean => candidate.id === current.id
    && candidate.userId === current.userId
    && candidate.chatId === current.chatId
    && candidate.generationId === current.generationId
    && candidate.mode === current.mode
    && candidate.runtimeEpoch === current.runtimeEpoch
    && candidate.deadlineAt === current.deadlineAt;
  let candidate = current;
  // One bounded retry closes the only valid forward race: a same-owner
  // reversible CAS that advances the execution after this request's read.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (updateCas(
      db,
      candidate,
      markerValues,
      input.ownerToken,
      candidate.phase,
      candidate.casRevision,
      markerAbsentPredicates,
    )) {
      return { execution: requireExecution(db, input.executionId).execution, code: acceptedCode };
    }

    const latest = requireExecution(db, input.executionId).execution;
    if (STOP_TOO_LATE_PHASE_SET.has(latest.phase)) return { execution: latest, code: "too_late" };
    if (TERMINAL_PHASE_SET.has(latest.phase)) return { execution: latest, code: "already_terminal" };
    if (!REVERSIBLE_PHASE_SET.has(latest.phase)) return { execution: latest, code: "too_late" };
    if (!sameExecutionIdentity(latest)) {
      throw new TurnExecutionError("stale_execution", "execution identity changed before cancellation request", {
        executionId: current.id,
        phase: latest.phase,
      });
    }
    if (latest.casOwner !== input.ownerToken) ensureOwner(latest, input.ownerToken);
    if (latest.cancelRequested) {
      const latestRequestAt = latest.cancelRequestedAt ?? latest.updatedAt;
      return {
        execution: latest,
        code: cancellationTerminalCause(latestRequestAt, latest.deadlineAt).code,
      };
    }
    if (acceptedCode === "cancelled" && (latest.leaseExpiresAt === null || latest.leaseExpiresAt <= now)) {
      throw new TurnExecutionError("stale_owner", "execution owner lease expired before cancellation retry", {
        executionId: latest.id,
        phase: latest.phase,
      });
    }
    candidate = latest;
  }
  throw new TurnExecutionError("stale_execution", "execution changed repeatedly before cancellation request", {
    executionId: current.id,
    phase: candidate.phase,
  });
}

export function requestTurnCancellation(input: {
  executionId: string;
  ownerToken?: string;
  reason?: string;
  now?: number;
  db?: Database;
}): TurnCancellationResult {
  const db = input.db ?? getDb();
  const current = requireExecution(db, input.executionId).execution;
  if (STOP_TOO_LATE_PHASE_SET.has(current.phase)) {
    return { execution: current, code: "too_late" };
  }
  if (current.phase === "WORK") {
    const owner = input.ownerToken ?? current.casOwner;
    if (!owner) throw new TurnExecutionError("stale_owner", "execution has no active owner", { executionId: current.id });
    return requestActiveTurnCancellation({
      executionId: current.id,
      ownerToken: owner,
      reason: input.reason,
      now: input.now,
      db,
    });
  }
  if (TERMINAL_PHASE_SET.has(current.phase)) return { execution: current, code: "already_terminal" };
  if (input.ownerToken) ensureOwner(current, input.ownerToken);
  const now = input.now ?? nowMs();
  const requestAt = current.cancelRequested
    ? current.cancelRequestedAt ?? current.updatedAt
    : input.reason === "timed_out" && current.deadlineAt > now ? current.deadlineAt : now;
  const cause = cancellationTerminalCause(requestAt, current.deadlineAt);
  const owner = input.ownerToken ?? current.casOwner;
  if (!owner) throw new TurnExecutionError("stale_owner", "execution has no active owner", { executionId: current.id });
  const settled = terminalizeWithCancellationMarkerFence(
    db,
    current,
    owner,
    cause.phase,
    cause.phase === "TIMED_OUT" ? cause.reason : input.reason ?? cause.reason,
    now,
  );
  return cancellationResultFromSettlement(settled, cause.code);
}

/**
 * Cancel a reversible execution left without a lease after process recovery.
 * The ownerless predicate is part of the same CAS as terminalization; callers
 * cannot cancel a row whose owner changed between the read and the update.
 */
export function requestDormantTurnCancellation(input: {
  executionId: string;
  userId: string;
  chatId: string;
  reason?: string;
  now?: number;
  db?: Database;
}): TurnCancellationResult {
  const db = input.db ?? getDb();
  const required = requireExecution(db, input.executionId);
  const current = required.execution;
  if (current.userId !== input.userId || current.chatId !== input.chatId) {
    throw new TurnExecutionError("execution_not_found", "execution does not belong to the requested owner", {
      executionId: current.id,
    });
  }
  if (STOP_TOO_LATE_PHASE_SET.has(current.phase)) {
    return { execution: current, code: "too_late" };
  }
  if (TERMINAL_PHASE_SET.has(current.phase)) {
    return { execution: current, code: "already_terminal" };
  }
  if (!REVERSIBLE_PHASE_SET.has(current.phase)) {
    throw new TurnExecutionError("too_late", "execution is no longer reversible", {
      executionId: current.id,
      phase: current.phase,
    });
  }

  const columns = tableColumns(db, "agent_turn_executions");
  const ownerColumns = ["cas_owner", "lease_owner", "owner_token"].filter((column) => columns.has(column));
  if (ownerColumns.length === 0 || ownerColumns.some((column) => {
    const value = required.raw[column];
    return value !== null && value !== undefined;
  })) {
    throw new TurnExecutionError("stale_owner", "execution has an active owner", {
      executionId: current.id,
      phase: current.phase,
    });
  }

  const now = input.now ?? nowMs();
  const markerAt = current.cancelRequested
    ? current.cancelRequestedAt ?? current.updatedAt
    : input.reason === "timed_out" && current.deadlineAt > now ? current.deadlineAt : now;
  const cause = cancellationTerminalCause(markerAt, current.deadlineAt);
  const settled = terminalizeWithCancellationMarkerFence(
    db,
    current,
    null,
    cause.phase,
    cause.phase === "TIMED_OUT" ? cause.reason : input.reason ?? cause.reason,
    now,
  );
  return cancellationResultFromSettlement(settled, cause.code);
}


export const cancelTurnExecution = requestTurnCancellation;

export function expireTurnExecution(input: {
  executionId: string;
  ownerToken: string;
  now?: number;
  db?: Database;
}): TurnCancellationResult {
  const db = input.db ?? getDb();
  const current = requireExecution(db, input.executionId).execution;
  if (current.phase === "COMMITTING" || current.phase === "COMMITTED") {
    return { execution: current, code: "too_late" };
  }
  if (TERMINAL_PHASE_SET.has(current.phase)) return { execution: current, code: "already_terminal" };
  ensureOwner(current, input.ownerToken);
  const now = input.now ?? nowMs();
  if (!current.cancelRequested && current.deadlineAt > 0 && now < current.deadlineAt) {
    throw new TurnExecutionError("deadline_exceeded", "execution deadline has not elapsed", {
      executionId: current.id,
      phase: current.phase,
    });
  }
  const cause = current.cancelRequested
    ? cancellationTerminalCause(current.cancelRequestedAt ?? current.updatedAt, current.deadlineAt)
    : {
        phase: "TIMED_OUT" as const,
        reason: "root_wall_clock_limit_exceeded" as const,
        code: "timed_out" as const,
      };
  const settled = terminalizeWithCancellationMarkerFence(
    db,
    current,
    input.ownerToken,
    cause.phase,
    cause.reason,
    now,
  );
  return cancellationResultFromSettlement(settled, cause.code);
}

export function reserveFinalRender(
  input: FinalRenderReservationInput,
): { execution: TurnExecutionRecord; reservationKey: string; maxBytes: number } {
  const db = input.db ?? getDb();
  const current = requireExecution(db, input.executionId).execution;
  if (TERMINAL_PHASE_SET.has(current.phase)) {
    if (current.phase === "COMMITTED") throw new TurnExecutionError("too_late", "execution has already committed", { executionId: current.id, phase: current.phase });
    throw new TurnExecutionError("already_terminal", "execution is already terminal", { executionId: current.id, phase: current.phase });
  }
  ensureOwner(current, input.ownerToken);
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || input.maxBytes > MAX_RESERVATION_BYTES) {
    throw new TurnExecutionError("invalid_execution_input", "final render reservation is invalid", { executionId: current.id });
  }
  const contextBytes = input.contextBytes ?? 0;
  const outputBytes = input.outputBytes ?? input.maxBytes;
  const activityChunks = input.activityChunks ?? 0;
  let envelope: FinalRenderReservationEnvelopeV1;
  try {
    envelope = calculateFinalRenderReservationEnvelopeV1({ activityChunks, contextBytes, outputBytes });
  } catch {
    throw new TurnExecutionError("invalid_execution_input", "final render reservation is invalid", { executionId: current.id });
  }
  if (input.maxBytes !== envelope.maxBytes) {
    throw new TurnExecutionError("invalid_execution_input", "final render reservation undercounts its durable envelope", { executionId: current.id });
  }
  const key = boundedId(input.reservationKey, "reservationKey") ?? randomId("render");
  const existing = current.finalRenderReservations.find((reservation) => reservation.id === key);
  if (existing) {
    if (
      existing.contextBytes === envelope.contextBytes
      && existing.outputBytes === envelope.outputBytes
      && existing.activityChunks === envelope.activityChunks
      && existing.activityEvents === envelope.activityEvents
      && existing.maxBytes === envelope.maxBytes
    ) {
      return { execution: current, reservationKey: key, maxBytes: existing.maxBytes };
    }
    throw new TurnExecutionError("render_reservation_taken", "final render reservation key is already in use", { executionId: current.id, phase: current.phase });
  }
  if (current.finalRenderReservations.length > 0) {
    throw new TurnExecutionError("render_reservation_taken", "final render is already reserved", { executionId: current.id, phase: current.phase });
  }
  const expectedRevision = input.expectedRevision ?? current.casRevision;
  if (expectedRevision !== current.casRevision) throw new TurnExecutionError("stale_execution", "execution revision no longer matches", { executionId: current.id, phase: current.phase });
  const now = nowMs();
  const reservation: FinalRenderReservationRecord = {
    id: key,
    requestCount: 1,
    activityChunks: envelope.activityChunks,
    activityEvents: envelope.activityEvents,
    contextBytes: envelope.contextBytes,
    outputBytes: envelope.outputBytes,
    maxBytes: envelope.maxBytes,
    deadlineAt: input.deadlineAt ?? current.deadlineAt,
    revision: current.casRevision + 1,
    reservedAt: now,
  };

  const values: Record<string, unknown> = {
    final_render_reservations_json: scrubJson([...current.finalRenderReservations, reservation], 64 * 1024),
    final_render_request_count: 1,
    final_render_context_bytes: envelope.contextBytes,
    final_render_output_bytes: envelope.outputBytes,
    final_render_activity_events: envelope.activityEvents,
    final_render_deadline_at: reservation.deadlineAt,
    cas_revision: current.casRevision + 1,
    revision: current.casRevision + 1,
    updated_at: now,
  };
  if (!updateCas(db, current, values, input.ownerToken, current.phase, expectedRevision)) {
    throw new TurnExecutionError("stale_execution", "execution changed before render reservation", { executionId: current.id, phase: current.phase });
  }
  return { execution: requireExecution(db, current.id).execution, reservationKey: key, maxBytes: envelope.maxBytes };
}

/** CAS-only commit gate for callers that already own the outer transaction. */
export function beginTurnCommitInTransaction(
  db: Database,
  input: { executionId: string; ownerToken: string; expectedRevision?: number },
): TransitionTurnExecutionResult {
  return transitionTurnExecution({
    executionId: input.executionId,
    expectedPhase: "PREPARE_COMMIT",
    nextPhase: "COMMITTING",
    ownerToken: input.ownerToken,
    expectedRevision: input.expectedRevision,
    db,
    ignoreCancellation: false,
  });
}

export function beginTurnCommit(input: {
  executionId: string;
  ownerToken: string;
  expectedRevision?: number;
  db?: Database;
}): TransitionTurnExecutionResult {
  const db = input.db ?? getDb();
  const current = requireExecution(db, input.executionId).execution;
  if (current.phase === "COMMITTED") {
    return { execution: current, terminalEventEmitted: false };
  }
  if (current.phase === "COMMIT_FAILED") throw new TurnExecutionError("already_terminal", "commit already failed", { executionId: current.id, phase: current.phase });
  return transitionTurnExecution({
    executionId: input.executionId,
    expectedPhase: "PREPARE_COMMIT",
    nextPhase: "COMMITTING",
    ownerToken: input.ownerToken,
    expectedRevision: input.expectedRevision,
    db,
  });
}

function receiptTableAvailable(db: Database): boolean {
  return hasTable(db, "agent_turn_commit_receipts");
}

function rawReceipt(db: Database, execution: TurnExecutionRecord): Record<string, unknown> | null {
  if (!receiptTableAvailable(db)) return null;
  const columns = tableColumns(db, "agent_turn_commit_receipts");
  const keyColumn = firstColumn(columns, "execution_id", "turn_id");
  const commitColumn = firstColumn(columns, "commit_key");
  const orderColumn = firstColumn(columns, "receipt_id", "id", keyColumn ?? "execution_id")!;
  if (keyColumn) {
    const row = db.query(`SELECT * FROM ${quoteColumn("agent_turn_commit_receipts")} WHERE ${quoteColumn(keyColumn)} = ? ORDER BY ${quoteColumn(orderColumn)} LIMIT 1`).get(execution.id) as Record<string, unknown> | null;
    if (row) return row;
  }
  if (commitColumn) {
    return db.query(`SELECT * FROM ${quoteColumn("agent_turn_commit_receipts")} WHERE ${quoteColumn(commitColumn)} = ? ORDER BY ${quoteColumn(orderColumn)} LIMIT 1`).get(execution.commitKey) as Record<string, unknown> | null;
  }
  return null;
}

function assertReceiptTarget(
  execution: TurnExecutionRecord,
  workspaceId: string | null,
  messageId: string | null,
  swipeId: number | null,
): void {
  if (workspaceId !== execution.workspaceId) {
    throw new TurnExecutionError("invalid_execution_input", "receipt workspace does not match the immutable execution workspace", { executionId: execution.id, phase: execution.phase });
  }
  if (execution.targetKind === "normal") {
    if (swipeId !== null && swipeId !== 0) {
      throw new TurnExecutionError("invalid_execution_input", "normal receipt swipe does not match the immutable target", { executionId: execution.id, phase: execution.phase });
    }
    return;
  }
  if (messageId !== execution.targetMessageId || swipeId !== execution.targetSwipeId) {
    throw new TurnExecutionError("invalid_execution_input", "receipt message or swipe does not match the immutable execution target", { executionId: execution.id, phase: execution.phase });
  }
}

function historicalReceiptTargetAuthorized(
  db: Database,
  execution: TurnExecutionRecord,
): boolean {
  if (execution.phase !== "COMMITTED") return false;
  const row = db.query(
    `SELECT *
       FROM agent_run_attempts
      WHERE user_id = ? AND attempt_id = ?
      LIMIT 1`,
  ).get(execution.userId, execution.attemptLineage.attemptId) as Record<string, unknown> | null;
  if (!row || !inspectionCoreIdentityMatches(row, execution)) return false;
  const reconciliationState = rowString(row, "reconciliation_state");
  if (reconciliationState !== "authoritative" && reconciliationState !== "recovered") return false;
  return terminalAuditEvidence(db, execution, row).targetMatches;
}

function receiptFromRow(
  row: Record<string, unknown>,
  execution: TurnExecutionRecord,
  options?: { readonly allowHistoricalTarget?: boolean; readonly db?: Database },
): TurnCommitReceipt {
  const id = rowString(row, "id", "receipt_id") ?? `${execution.id}:${execution.commitKey}`;
  const executionId = rowString(row, "execution_id", "turn_id") ?? execution.id;
  const userId = rowString(row, "user_id") ?? execution.userId;
  const chatId = rowString(row, "chat_id") ?? execution.chatId;
  const commitKey = rowString(row, "commit_key") ?? execution.commitKey;
  const workspaceId = rowString(row, "workspace_id") ?? execution.workspaceId;
  let messageId = rowString(row, "message_id") ?? execution.targetMessageId;
  let swipeId = rowNumber(row, "swipe_id") ?? execution.targetSwipeId;
  if (
    executionId !== execution.id
    || userId !== execution.userId
    || chatId !== execution.chatId
    || commitKey !== execution.commitKey
  ) {
    throw new TurnExecutionError("invalid_execution_input", "receipt authority does not match the immutable execution owner", { executionId: execution.id, phase: execution.phase });
  }
  const targetValid = options?.db
    ? storedRecoveryTargetIsValid(options.db, execution.chatId, messageId, swipeId)
    : true;
  if (
    options?.allowHistoricalTarget === true
    && options.db
    && !targetValid
    && historicalReceiptTargetAuthorized(options.db, execution)
  ) {
    messageId = null;
    swipeId = null;
  } else {
    assertReceiptTarget(execution, workspaceId, messageId, swipeId);
  }
  return {
    id,
    executionId,
    userId,
    chatId,
    commitKey,
    workspaceId,
    messageId,
    swipeId,
    artifactRefCount: rowNumber(row, "artifact_ref_count") ?? 0,
    summary: parseSummary(rowString(row, "summary_json", "summary")),
    createdAt: rowNumber(row, "created_at", "committed_at") ?? 0,
  };
}
function normalizedReceiptExecution(
  db: Database,
  execution: TurnExecutionRecord,
  receipt: TurnCommitReceipt,
): TurnExecutionRecord {
  if (execution.targetMessageId === receipt.messageId && execution.targetSwipeId === receipt.swipeId) {
    return execution;
  }
  const attemptRow = db.query(
    `SELECT target_message_id, target_swipe_id
       FROM agent_run_attempts
      WHERE user_id = ? AND attempt_id = ?
      LIMIT 1`,
  ).get(execution.userId, execution.attemptLineage.attemptId) as Record<string, unknown> | null;
  const lineageTargetMessageId = attemptRow ? rowString(attemptRow, "target_message_id") : receipt.messageId;
  const lineageTargetSwipeId = attemptRow ? rowNumber(attemptRow, "target_swipe_id") : receipt.swipeId;
  return {
    ...execution,
    targetMessageId: receipt.messageId,
    targetSwipeId: receipt.swipeId,
    attemptLineage: {
      ...execution.attemptLineage,
      target: {
        ...execution.attemptLineage.target,
        messageId: lineageTargetMessageId,
        swipeId: lineageTargetMessageId === null ? null : lineageTargetSwipeId,
      },
    },
  };
}

function writeReceipt(db: Database, execution: TurnExecutionRecord, input: CommitReceiptInput, now: number): TurnCommitReceipt {
  if (!receiptTableAvailable(db)) throw new TurnExecutionError("execution_schema_unavailable", "commit receipt schema is unavailable", { executionId: execution.id });
  const columns = tableColumns(db, "agent_turn_commit_receipts");
  const id = boundedId(input.receiptId, "receiptId") ?? randomId("receipt");
  const summary = scrubJson(input.summary ?? {}, MAX_SUMMARY_BYTES);
  const workspaceId = boundedId(input.workspaceId ?? execution.workspaceId, "workspaceId", true)!;
  const messageId = input.messageId ?? execution.targetMessageId;
  const swipeId = input.swipeId ?? execution.targetSwipeId;
  assertReceiptTarget(execution, workspaceId, messageId, swipeId);
  const idempotencyKey = boundedId(input.idempotencyKey ?? execution.commitKey, "idempotencyKey", true)!;
  const summaryDigest = createHash("sha256").update(summary).digest("hex");
  const values: Record<string, unknown> = {};
  addValue(columns, values, ["id", "receipt_id"], id);
  addValues(columns, values, ["execution_id", "turn_id"], execution.id);
  addValue(columns, values, ["workspace_id"], workspaceId);
  addValue(columns, values, ["user_id"], execution.userId);
  addValue(columns, values, ["chat_id"], execution.chatId);
  addValue(columns, values, ["commit_key"], execution.commitKey);
  addValue(columns, values, ["idempotency_key"], idempotencyKey);
  addValue(columns, values, ["state"], "committed");
  addValue(columns, values, ["summary_digest"], summaryDigest);
  addValue(columns, values, ["summary_json", "summary"], summary);
  addValue(columns, values, ["message_id"], messageId);
  addValue(columns, values, ["swipe_id"], swipeId);
  addValue(columns, values, ["artifact_ref_count"], input.artifactRefCount ?? 0);
  addValue(columns, values, ["workspace_revision"], execution.workspaceRevision);
  addValue(columns, values, ["created_at", "committed_at"], now);
  addValue(columns, values, ["updated_at"], now);
  insertRow(db, "agent_turn_commit_receipts", values);
  const row = rawReceipt(db, execution);
  if (!row) throw new TurnExecutionError("commit_receipt_missing", "commit receipt was not readable after insert", { executionId: execution.id });
  return receiptFromRow(row, execution);
}

function repairCommittedFromReceipt(
  db: Database,
  current: TurnExecutionRecord,
  receipt: TurnCommitReceipt,
  ownerToken: string,
  now: number,
  notifyProjectionRepair = true,
): TurnExecutionRecord {
  if (current.phase === "COMMITTED") return current;
  if (current.phase !== "COMMITTING") throw new TurnExecutionError("invalid_transition", "only COMMITTING executions can be receipt-repaired", { executionId: current.id, phase: current.phase });
  const values = terminalUpdateValues(db, current, "COMMITTED", now, "committed");
  values.cas_revision = current.casRevision + 1;
  values.phase_revision = current.phaseRevision + 1;
  if (!updateCas(db, current, values, ownerToken, "COMMITTING", current.casRevision)) {
    const latest = requireExecution(db, current.id).execution;
    if (latest.phase === "COMMITTED") return latest;
    throw new TurnExecutionError("stale_execution", "execution changed during receipt repair", { executionId: current.id, phase: current.phase });
  }
  const repaired = requireExecution(db, current.id).execution;
  if (notifyProjectionRepair) void notifyReceiptRepair(repaired, receipt);
  return repaired;
}

/** Register only a projection repairer for an interrupted terminal transition. */
export type AgentTurnTerminalRecoveryHandler = (
  execution: TurnExecutionRecord,
  status: "FAILED" | "COMMIT_FAILED",
) => void;

let terminalRecoveryHandler: AgentTurnTerminalRecoveryHandler | null = null;

export function registerAgentTurnTerminalRecovery(
  handler: AgentTurnTerminalRecoveryHandler | null,
): void {
  terminalRecoveryHandler = handler;
}

/** Register only a projection/handoff repairer. It must not dispatch providers or replay side effects. */
export function registerAgentTurnReceiptRepair(
  handler: ((
    execution: TurnExecutionRecord,
    receipt: TurnCommitReceipt,
    options?: Pick<AgentRunReceiptRepairOptions, "historicalTargetRedaction">,
  ) => void | Promise<void>) | null,
): void {
  receiptRepairHandler = handler;
}

async function notifyReceiptRepair(execution: TurnExecutionRecord, receipt: TurnCommitReceipt): Promise<void> {
  if (!receiptRepairHandler) return;
  try {

    await receiptRepairHandler(execution, receipt);
  } catch (error) {
    console.warn("[agent-turn] receipt projection repair failed", error);
  }
}
function invokeTerminalRecovery(execution: TurnExecutionRecord, status: "FAILED" | "COMMIT_FAILED"): void {
  terminalRecoveryHandler?.(execution, status);
}

export function finalizeTurnCommit(input: CommitReceiptInput): { execution: TurnExecutionRecord; receipt: TurnCommitReceipt; duplicate: boolean } {
  const db = input.db ?? getDb();
  let current = requireExecution(db, input.executionId).execution;
  const existing = rawReceipt(db, current);
  if (existing) {
    const receipt = receiptFromRow(existing, current);
    if (current.phase === "COMMITTING") {
      const owner = input.ownerToken ?? current.casOwner;
      if (!owner) throw new TurnExecutionError("stale_owner", "execution has no active owner", { executionId: current.id });
      current = repairCommittedFromReceipt(db, current, receipt, owner, nowMs());
    }
    if (current.phase === "COMMITTED") return { execution: current, receipt, duplicate: true };
  }
  if (current.phase !== "COMMITTING") {
    if (current.phase === "COMMITTED") {
      const receipt = rawReceipt(db, current);
      if (!receipt) throw new TurnExecutionError("commit_receipt_missing", "committed execution has no receipt", { executionId: current.id });
      return { execution: current, receipt: receiptFromRow(receipt, current), duplicate: true };
    }
    throw new TurnExecutionError("invalid_transition", "execution is not committing", { executionId: current.id, phase: current.phase });
  }
  const ownerToken = input.ownerToken ?? current.casOwner;
  if (!ownerToken) throw new TurnExecutionError("stale_owner", "execution has no active owner", { executionId: current.id, phase: current.phase });
  ensureOwner(current, ownerToken);
  const now = nowMs();
  try {
    const result: { value?: { execution: TurnExecutionRecord; receipt: TurnCommitReceipt } } = {};
    db.transaction(() => {
      const inside = requireExecution(db, current.id).execution;
      if (inside.phase !== "COMMITTING") throw new TurnExecutionError("stale_execution", "execution changed before commit", { executionId: inside.id, phase: inside.phase });
      const prior = rawReceipt(db, inside);
      if (prior) {
        const priorReceipt = receiptFromRow(prior, inside);
        result.value = { execution: repairCommittedFromReceipt(db, inside, priorReceipt, ownerToken, now), receipt: priorReceipt };
        return;
      }
      const receipt = writeReceipt(db, inside, input, now);
      const values = terminalUpdateValues(db, inside, "COMMITTED", now, "committed");
      values.cas_revision = inside.casRevision + 1;
      values.phase_revision = inside.phaseRevision + 1;
      if (!updateCas(db, inside, values, ownerToken, "COMMITTING", inside.casRevision)) {
        throw new TurnExecutionError("stale_execution", "execution changed before receipt handoff", { executionId: inside.id, phase: inside.phase });
      }
      result.value = { execution: requireExecution(db, inside.id).execution, receipt };
    })();
    const commitResult = result.value;
    if (!commitResult) throw new TurnExecutionError("commit_failed", "commit transaction produced no result", { executionId: current.id });
    void notifyReceiptRepair(commitResult.execution, commitResult.receipt);
    return { execution: commitResult.execution, receipt: commitResult.receipt, duplicate: false };
  } catch (error) {
    const after = rawExecution(db, current.id);
    const afterExecution = after ? recordFromRow(after) : null;
    if (afterExecution?.phase === "COMMITTED") {
      const row = rawReceipt(db, afterExecution);
      if (row) return { execution: afterExecution, receipt: receiptFromRow(row, afterExecution), duplicate: true };
    }
    // A failed statement rolls back the receipt and all caller transaction
    // work.  Marking COMMIT_FAILED is the only durable mutation after that
    // rollback; it never retries provider/render or chat side effects.
    try { failTurnCommit({ executionId: current.id, ownerToken, reason: "commit_failed", db }); } catch { /* stale owner/restart will reconcile */ }
    if (error instanceof TurnExecutionError) throw error;
    throw new TurnExecutionError("commit_failed", "commit transaction failed", { executionId: current.id, phase: "COMMITTING" });
  }
}

/**
 * Complete the durable part of COMMITTING inside a caller-owned SQLite
 * transaction. The caller must invoke this from its synchronous
 * `db.transaction(() => { ... })` callback; this function never opens,
 * commits, or rolls back a transaction and never emits terminal events.
 *
 * A duplicate receipt is authoritative. It is returned without invoking
 * `apply`, which keeps retries from repeating message, artifact, or projection
 * side effects.
 */
export function finalizeTurnCommitInTransaction<T>(
  db: Database,
  input: TurnCommitTransactionInput<T>,
): TurnCommitTransactionResult<T> {
  const current = requireExecution(db, input.executionId).execution;
  const ownerToken = input.ownerToken ?? current.casOwner;
  if (!ownerToken) throw new TurnExecutionError("stale_owner", "execution has no active owner", { executionId: current.id, phase: current.phase });
  const existing = rawReceipt(db, current);
  if (existing) {
    const receipt = receiptFromRow(existing, current);
    if (current.phase === "COMMITTING") {
      const repairedValues = terminalUpdateValues(db, current, "COMMITTED", nowMs(), "committed");
      repairedValues.cas_revision = current.casRevision + 1;
      repairedValues.phase_revision = current.phaseRevision + 1;
      if (!updateCas(db, current, repairedValues, ownerToken, "COMMITTING", current.casRevision)) {
        const latest = requireExecution(db, current.id).execution;
        if (latest.phase !== "COMMITTED") throw new TurnExecutionError("stale_execution", "execution changed during receipt repair", { executionId: current.id, phase: current.phase });
        return { execution: latest, receipt, duplicate: true, value: undefined };
      }
      return { execution: requireExecution(db, current.id).execution, receipt, duplicate: true, value: undefined };
    }
    if (current.phase !== "COMMITTED") throw new TurnExecutionError("invalid_transition", "receipt exists for a nonterminal execution", { executionId: current.id, phase: current.phase });
    return { execution: current, receipt, duplicate: true, value: undefined };
  }
  if (current.phase !== "COMMITTING") {
    throw new TurnExecutionError("invalid_transition", "execution is not committing", { executionId: current.id, phase: current.phase });
  }
  ensureOwner(current, ownerToken);
  const value = input.apply(db);
  const now = nowMs();
  const receipt = writeReceipt(db, current, input, now);
  const values = terminalUpdateValues(db, current, "COMMITTED", now, "committed");
  values.cas_revision = current.casRevision + 1;
  values.phase_revision = current.phaseRevision + 1;
  if (!updateCas(db, current, values, ownerToken, "COMMITTING", current.casRevision)) {
    throw new TurnExecutionError("stale_execution", "execution changed before commit receipt handoff", { executionId: current.id, phase: current.phase });
  }
  return {
    execution: requireExecution(db, current.id).execution,
    receipt,
    duplicate: false,
    value,
  };

}
export function failTurnCommit(input: {
  executionId: string;
  ownerToken: string;
  reason?: string;
  db?: Database;
}): TurnExecutionRecord {
  const db = input.db ?? getDb();
  const current = requireExecution(db, input.executionId).execution;
  const existing = rawReceipt(db, current);
  if (existing) {
    return repairCommittedFromReceipt(db, current, receiptFromRow(existing, current), input.ownerToken, nowMs());
  }
  if (current.phase === "COMMIT_FAILED") return current;
  if (current.phase !== "COMMITTING") throw new TurnExecutionError("invalid_transition", "execution is not committing", { executionId: current.id, phase: current.phase });
  ensureOwner(current, input.ownerToken);
  return terminalizeWithCas(db, current, input.ownerToken, "COMMITTING", current.casRevision, "COMMIT_FAILED", input.reason ?? "commit_failed").execution;
}

/** Failure/receipt repair counterpart for an already-open outer transaction. */
export function failTurnCommitInTransaction(
  db: Database,
  input: { executionId: string; ownerToken: string; reason?: string },
): TurnExecutionRecord {
  const current = requireExecution(db, input.executionId).execution;
  const existing = rawReceipt(db, current);
  if (existing) {
    if (current.phase === "COMMITTED") return current;
    if (current.phase !== "COMMITTING") {
      throw new TurnExecutionError("invalid_transition", "receipt exists for a non-committing execution", { executionId: current.id, phase: current.phase });
    }
    return terminalizeWithCas(
      db,
      current,
      input.ownerToken,
      "COMMITTING",
      current.casRevision,
      "COMMITTED",
      "committed",
    ).execution;
  }
  if (current.phase === "COMMIT_FAILED") return current;
  if (current.phase !== "COMMITTING") throw new TurnExecutionError("invalid_transition", "execution is not committing", { executionId: current.id, phase: current.phase });
  ensureOwner(current, input.ownerToken);
  return terminalizeWithCas(
    db,
    current,
    input.ownerToken,
    "COMMITTING",
    current.casRevision,
    "COMMIT_FAILED",
    input.reason ?? "commit_failed",
  ).execution;
}

const SERVER_READINESS_COMPONENTS = [
  "schema",
  "reconciliation",
  "archiveRegistry",
  "isolateTermination",
  "publicationStore",
] as const;
type ServerReadinessComponent = (typeof SERVER_READINESS_COMPONENTS)[number];

export interface AgenticReadinessVectorV1 {
  readonly schema: boolean;
  readonly reconciliation: boolean;
  readonly archiveRegistry: boolean;
  readonly isolateTermination: boolean;
  readonly publicationStore: boolean;
  readonly runtimeEpoch: number;
  readonly reason: string | null;
  readonly digest: string;
}



export interface AgenticRuntimeStatus {
  readonly mode: "off" | "auto";
  readonly enabled: boolean;
  readonly runtimeEpoch: number;
  readonly readiness: AgenticReadinessVectorV1;
}

let runtimeEpoch = Math.max(1, Date.now());
let readiness: Omit<AgenticReadinessVectorV1, "digest" | "reason"> = {
  schema: false,
  reconciliation: false,
  archiveRegistry: false,
  isolateTermination: false,
  publicationStore: false,
  runtimeEpoch,
};

function readinessDigest(value: Omit<AgenticReadinessVectorV1, "digest" | "reason">): string {
  const canonical = JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
  ));
  return createHash("sha256").update(canonical).digest("hex");
}

function readinessReason(value: Omit<AgenticReadinessVectorV1, "digest" | "reason">): string | null {
  for (const component of SERVER_READINESS_COMPONENTS) {
    if (!value[component]) return `${component}_unavailable`;
  }
  return null;
}



export function getRuntimeEpoch(): number {
  return runtimeEpoch;
}

/** Start a new server-owned epoch. User data cannot set or increment this value. */
export function startAgentRuntimeEpoch(): number {
  runtimeEpoch = Math.max(runtimeEpoch + 1, Date.now());
  readiness = { ...readiness, runtimeEpoch };
  return runtimeEpoch;
}

export const beginAgentRuntimeEpoch = startAgentRuntimeEpoch;

export function getAgenticRuntimeMode(): "off" | "auto" {
  return process.env.LUMIVERSE_AGENTIC_RUNTIME === "auto" ? "auto" : "off";
}

export const getAgenticKillSwitch = getAgenticRuntimeMode;

/**
 * Server bootstrap may report component health. The function is intentionally
 * not called from settings/preset/import paths; those paths have no access to
 * readiness authority. Omitted fields remain fail-closed.
 */
export function setAgenticRuntimeReadiness(
  patch: Partial<Record<ServerReadinessComponent, boolean>>,
): AgenticReadinessVectorV1 {
  const next = { ...readiness };
  for (const component of SERVER_READINESS_COMPONENTS) {
    if (patch[component] !== undefined) next[component] = patch[component] === true;
  }
  readiness = next;
  return getAgenticReadiness();
}

export function getAgenticReadiness(): AgenticReadinessVectorV1 {
  const snapshot = { ...readiness };
  return Object.freeze({
    ...snapshot,
    reason: readinessReason(snapshot),
    digest: readinessDigest(snapshot),
  });
}

export function isAgenticRuntimeReady(): boolean {
  const mode = getAgenticRuntimeMode();
  const current = getAgenticReadiness();
  return mode === "auto" && current.reason === null;
}

export function isAgenticRuntimeEnabled(): boolean {
  return isAgenticRuntimeReady();
}

export function getAgenticRuntimeStatus(): AgenticRuntimeStatus {
  return Object.freeze({
    mode: getAgenticRuntimeMode(),
    enabled: isAgenticRuntimeReady(),
    runtimeEpoch,
    readiness: getAgenticReadiness(),
  });
}

/** Test-only reset; no production caller should need to alter server health. */
export const __testing = {
  resetRuntimeEpoch(value?: number): void {
    runtimeEpoch = Number.isSafeInteger(value) && (value as number) > 0 ? value as number : Math.max(1, Date.now());
    readiness = { ...readiness, runtimeEpoch };
  },
  resetReadiness(): void {
    readiness = {
      schema: false,
      reconciliation: false,
      archiveRegistry: false,
      isolateTermination: false,
      publicationStore: false,
      runtimeEpoch,
    };
  },
  setReconciliationClock(clock?: (() => number) | null): void {
    reconciliationClock = clock ?? Date.now;
  },
};

function claimForReconciliation(db: Database, current: TurnExecutionRecord, ownerToken: string, now: number): TurnExecutionRecord | null {
  if (TERMINAL_PHASE_SET.has(current.phase)) return null;
  const columns = tableColumns(db, "agent_turn_executions");
  const values: Record<string, unknown> = {
    cas_owner: ownerToken,
    lease_owner: ownerToken,
    cas_expires_at: now + DEFAULT_LEASE_MS,
    lease_expires_at: now + DEFAULT_LEASE_MS,
    runtime_epoch: runtimeEpoch,
    lease_generation: current.leaseGeneration + 1,
    cas_revision: current.casRevision + 1,
    revision: current.casRevision + 1,
    phase_revision: current.phaseRevision,
  };
  const booleanOnlyCancellationMarker = !columns.has("cancel_requested_at")
    && (columns.has("cancel_requested") || columns.has("cancellation_requested"));
  // In boolean-only compatibility schemas updated_at is the marker timestamp.
  // A reconciliation lease claim must not replace first-cause authority.
  if (!booleanOnlyCancellationMarker) values.updated_at = now;
  const where = ["id = ?"];
  const params: SQLQueryBindings[] = [current.id];
  if (columns.has("phase")) {
    where.push("phase = ?");
    params.push(current.phase);
  } else if (columns.has("state")) {
    where.push("state = ?");
    params.push(current.phase);
  }
  if (columns.has("cas_revision")) {
    where.push("cas_revision = ?");
    params.push(current.casRevision);
  } else if (columns.has("revision")) {
    where.push("revision = ?");
    params.push(current.casRevision);
  }
  // The startup reconciler runs before request serving. A row in any
  // nonterminal state is therefore reclaimed regardless of its previous
  // short lease; the phase CAS makes concurrent reconcilers mutually exclusive.
  const changes = updateRow(db, "agent_turn_executions", values, where.join(" AND "), params);
  if (changes !== 1) return null;
  return requireExecution(db, current.id).execution;
}

type WorkSegmentRecoveryFence =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "pending"; reason: "active_work_segment_recovery" | "terminal_work_handoff_pending" }>
  | Readonly<{
      kind: "terminal";
      phase: "FAILED" | "EXHAUSTED" | "CANCELLED" | "TIMED_OUT";
      reason: string;
    }>;

const WORK_SEGMENT_TERMINAL_PHASE: Readonly<Record<
  "failed" | "exhausted" | "cancelled",
  "FAILED" | "EXHAUSTED" | "CANCELLED"
>> = Object.freeze({
  failed: "FAILED",
  exhausted: "EXHAUSTED",
  cancelled: "CANCELLED",
});

function invalidWorkSegmentRecovery(
  execution: TurnExecutionRecord,
  message: string,
): TurnExecutionError {
  return new TurnExecutionError("execution_schema_unavailable", message, {
    executionId: execution.id,
    phase: execution.phase,
  });
}

/**
 * Classify the exact durable V1 WORK-chain authority before generic startup
 * recovery is allowed to claim the Turn Execution. A successful terminal
 * transition still owns final render/commit recovery, while a terminal close
 * is already sufficient authority for a typed Turn Execution terminal CAS.
 */
function workSegmentRecoveryFence(
  db: Database,
  execution: TurnExecutionRecord,
): WorkSegmentRecoveryFence {
  if (execution.phase !== "WORK" || !hasTable(db, "agent_work_segment_recovery")) {
    return { kind: "none" };
  }
  const recovery = db.query(`SELECT
      user_id, execution_id, attempt_id, workspace_id, workspace_revision,
      execution_cas_revision, state, phase_id, phase_index, phase_occurrence,
      next_segment_ordinal, current_segment_id, terminal_close_result,
      terminal_close_reason, terminal_boundary_class, schema_version, record_complete
    FROM agent_work_segment_recovery
    WHERE user_id = ? AND execution_id = ?`)
    .get(execution.userId, execution.id) as Record<string, unknown> | null;
  if (!recovery) return { kind: "none" };

  const invalid = (message: string): never => {
    throw invalidWorkSegmentRecovery(execution, message);
  };
  const recoveryAttemptId = rowString(recovery, "attempt_id");
  const recoveryWorkspaceId = rowString(recovery, "workspace_id");
  const recoveryWorkspaceRevision = rowNumber(recovery, "workspace_revision");
  const recoveryExecutionRevision = rowNumber(recovery, "execution_cas_revision");
  if (
    rowNumber(recovery, "schema_version") !== 1
    || rowNumber(recovery, "record_complete") !== 1
    || rowString(recovery, "user_id") !== execution.userId
    || rowString(recovery, "execution_id") !== execution.id
    || recoveryAttemptId !== execution.attemptLineage.attemptId
    || recoveryWorkspaceId === null
    || recoveryWorkspaceId !== execution.workspaceId
    || recoveryWorkspaceRevision === null
    || recoveryWorkspaceRevision !== execution.workspaceRevision
    || recoveryExecutionRevision === null
    || recoveryExecutionRevision !== execution.casRevision
  ) {
    return invalid("WORK segment recovery authority does not match its Turn Execution fence");
  }

  const state = rowString(recovery, "state");
  if (state === "active") {
    return { kind: "pending", reason: "active_work_segment_recovery" };
  }
  if (state !== "closed"
    || recovery.current_segment_id !== null
    || recovery.phase_id !== null
    || recovery.phase_index !== null
    || recovery.phase_occurrence !== null) {
    return invalid("closed WORK segment recovery authority is malformed");
  }
  if (!hasTable(db, "agent_work_segments") || !hasTable(db, "agent_work_segment_transitions")) {
    return invalid("closed WORK segment recovery ledger is unavailable");
  }

  const nextSegmentOrdinal = rowNumber(recovery, "next_segment_ordinal");
  if (nextSegmentOrdinal === null || !Number.isSafeInteger(nextSegmentOrdinal) || nextSegmentOrdinal < 1) {
    return invalid("closed WORK segment recovery cursor is invalid");
  }
  const source = db.query(`SELECT
      segment_id, attempt_id, workspace_id, workspace_revision, execution_cas_revision,
      segment_ordinal, lifecycle, close_result, close_reason, boundary_class,
      closed_workspace_revision, closed_execution_cas_revision, closure_digest,
      schema_version, record_complete
    FROM agent_work_segments
    WHERE user_id = ? AND execution_id = ? AND segment_ordinal = ?`)
    .get(execution.userId, execution.id, nextSegmentOrdinal - 1) as Record<string, unknown> | null;
  const sourceSegmentId = source ? rowString(source, "segment_id") : null;
  const sourceWorkspaceRevision = source ? rowNumber(source, "workspace_revision") : null;
  const sourceExecutionRevision = source ? rowNumber(source, "execution_cas_revision") : null;
  const sourceClosedExecutionRevision = source ? rowNumber(source, "closed_execution_cas_revision") : null;
  if (
    !source
    || sourceSegmentId === null
    || rowNumber(source, "schema_version") !== 1
    || rowNumber(source, "record_complete") !== 1
    || rowString(source, "attempt_id") !== recoveryAttemptId
    || rowString(source, "workspace_id") !== recoveryWorkspaceId
    || sourceWorkspaceRevision === null
    || sourceWorkspaceRevision > recoveryWorkspaceRevision!
    || sourceExecutionRevision === null
    || sourceExecutionRevision > recoveryExecutionRevision!
    || rowNumber(source, "segment_ordinal") !== nextSegmentOrdinal - 1
    || rowNumber(source, "closed_workspace_revision") !== recoveryWorkspaceRevision
    || sourceClosedExecutionRevision === null
    || sourceClosedExecutionRevision > recoveryExecutionRevision!
    || rowString(source, "closure_digest")?.length !== 64
  ) {
    return invalid("closed WORK segment source does not match its recovery authority");
  }

  const closeResultValue = recovery.terminal_close_result;
  if (closeResultValue === null) {
    if (recovery.terminal_close_reason !== null || recovery.terminal_boundary_class !== null
      || rowString(source, "lifecycle") !== "closed"
      || rowString(source, "close_result") !== "work_complete"
      || rowString(source, "close_reason") !== "transition:terminal") {
      return invalid("terminal WORK handoff close is malformed");
    }
    const transition = db.query(`SELECT
        attempt_id, workspace_id, workspace_revision, execution_cas_revision,
        transition_kind, target_phase_id, target_phase_index,
        target_phase_occurrence, target_segment_ordinal,
        remaining_required_phase_count, schema_version, record_complete
      FROM agent_work_segment_transitions
      WHERE user_id = ? AND execution_id = ? AND source_segment_id = ?`)
      .get(execution.userId, execution.id, sourceSegmentId) as Record<string, unknown> | null;
    if (
      !transition
      || rowNumber(transition, "schema_version") !== 1
      || rowNumber(transition, "record_complete") !== 1
      || rowString(transition, "attempt_id") !== recoveryAttemptId
      || rowString(transition, "workspace_id") !== recoveryWorkspaceId
      || rowNumber(transition, "workspace_revision") !== recoveryWorkspaceRevision
      || rowNumber(transition, "execution_cas_revision") !== sourceClosedExecutionRevision
      || rowString(transition, "transition_kind") !== "terminal"
      || transition.target_phase_id !== null
      || transition.target_phase_index !== null
      || transition.target_phase_occurrence !== null
      || transition.target_segment_ordinal !== null
      || rowNumber(transition, "remaining_required_phase_count") !== 0
    ) {
      return invalid("terminal WORK handoff authority is incomplete");
    }
    return { kind: "pending", reason: "terminal_work_handoff_pending" };
  }

  if (closeResultValue !== "failed" && closeResultValue !== "exhausted" && closeResultValue !== "cancelled") {
    return invalid("terminal WORK close result is invalid");
  }
  const reason = rowString(recovery, "terminal_close_reason");
  const sourceTransition = db.query(
    `SELECT 1 FROM agent_work_segment_transitions
      WHERE user_id = ? AND execution_id = ? AND source_segment_id = ? LIMIT 1`,
  ).get(execution.userId, execution.id, sourceSegmentId);
  if (
    reason === null
    || reason.length === 0
    || byteLength(reason) > 256
    || sourceTransition != null
    || rowString(source, "lifecycle") !== closeResultValue
    || rowString(source, "close_result") !== closeResultValue
    || rowString(source, "close_reason") !== reason
    || rowString(source, "boundary_class") !== rowString(recovery, "terminal_boundary_class")
  ) {
    return invalid("terminal WORK close does not match its durable source segment");
  }
  return {
    kind: "terminal",
    phase: closeResultValue === "failed" && reason === "root_wall_clock_limit_exceeded"
      ? "TIMED_OUT"
      : WORK_SEGMENT_TERMINAL_PHASE[closeResultValue],
    reason,
  };
}

function projectionNeedsReceiptRepair(db: Database, execution: TurnExecutionRecord): boolean {
  if (!hasTable(db, "agent_run_projections") || !hasTable(db, "agent_chat_events")) return false;
  const row = db.query(
    `SELECT p.status,
            EXISTS(
              SELECT 1 FROM agent_chat_events e
               WHERE e.user_id = p.user_id
                 AND e.chat_id = p.chat_id
                 AND e.turn_id = p.turn_id
                 AND e.sequence = p.sequence
                 AND e.run_revision = p.revision
                 AND e.event_kind = 'terminal'
            ) AS terminal_event_present
       FROM agent_run_projections p
      WHERE p.user_id = ? AND p.chat_id = ? AND p.turn_id = ?
      LIMIT 1`,
  ).get(execution.userId, execution.chatId, execution.id) as {
    status?: unknown;
    terminal_event_present?: number;
  } | null;
  return row?.status !== "COMMITTED" || Number(row?.terminal_event_present ?? 0) !== 1;
}

function markCommittedTerminalConvergence(
  db: Database,
  execution: TurnExecutionRecord,
  now = nowMs(),
): TurnExecutionRecord {
  if (execution.phase !== "COMMITTED" || execution.terminalEventId) return execution;
  if (!hasTable(db, "agent_run_projections") || !hasTable(db, "agent_chat_events")) return execution;
  if (projectionNeedsReceiptRepair(db, execution)) return execution;

  const executionColumns = tableColumns(db, "agent_turn_executions");
  const terminalEventColumn = firstColumn(executionColumns, "terminal_event_id", "terminal_event_key");
  if (!terminalEventColumn) return execution;
  const terminalEventSql = quoteColumn(terminalEventColumn);
  const values: Record<string, unknown> = {
    [terminalEventColumn]: randomId("terminal"),
    cas_revision: execution.casRevision + 1,
    revision: execution.casRevision + 1,
    updated_at: now,
  };
  const emittedAtColumn = firstColumn(executionColumns, "terminal_event_emitted_at");
  if (emittedAtColumn) values[emittedAtColumn] = now;

  if (!updateCas(
    db,
    execution,
    values,
    null,
    "COMMITTED",
    execution.casRevision,
    [`(typeof(${terminalEventSql}) <> 'text' OR ${terminalEventSql} = '')`],
  )) {
    const latest = requireExecution(db, execution.id).execution;
    if (latest.phase === "COMMITTED" && latest.terminalEventId) return latest;
    throw new TurnExecutionError(
      "stale_execution",
      "committed execution changed before terminal convergence",
      { executionId: execution.id, phase: execution.phase },
    );
  }
  return requireExecution(db, execution.id).execution;
}

const NONCOMMITTED_TERMINAL_PHASES: readonly TerminalTurnPhase[] = [
  "COMMIT_FAILED",
  "EXHAUSTED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
];

function isNoncommittedTerminalPhase(phase: TurnExecutionPhase): phase is TerminalTurnPhase {
  return (NONCOMMITTED_TERMINAL_PHASES as readonly TurnExecutionPhase[]).includes(phase);
}

function publishedTerminalAuthority(
  db: Database,
  execution: TurnExecutionRecord,
): { readonly phase: TerminalTurnPhase; readonly reason: string } | null {
  if (!terminalRecoveryTablesAvailable(db)) return null;
  const inspection = db.query(
    `SELECT outcome, terminal, reconciliation_state, chat_id, turn_id, generation_id
       FROM agent_run_attempts
      WHERE user_id = ? AND attempt_id = ?
      LIMIT 1`,
  ).get(execution.userId, execution.attemptLineage.attemptId) as Record<string, unknown> | null;
  if (
    !inspection
    || rowNumber(inspection, "terminal") !== 1
    || rowString(inspection, "reconciliation_state") !== "authoritative"
    || rowString(inspection, "chat_id") !== execution.chatId
    || rowString(inspection, "turn_id") !== execution.id
    || rowString(inspection, "generation_id") !== execution.generationId
  ) {
    return null;
  }
  const outcome = rowString(inspection, "outcome");
  let phase: TerminalTurnPhase;
  let reason: string;
  if (outcome === "exhausted") {
    phase = "EXHAUSTED";
    reason = "exhausted";
  } else if (outcome === "stopped") {
    phase = "CANCELLED";
    reason = "cancelled";
  } else {
    return null;
  }
  const projection = db.query(
    `SELECT status, phase, chat_id, generation_id
       FROM agent_run_projections
      WHERE user_id = ? AND turn_id = ?
      LIMIT 1`,
  ).get(execution.userId, execution.id) as Record<string, unknown> | null;
  if (
    !projection
    || rowString(projection, "chat_id") !== execution.chatId
    || rowString(projection, "generation_id") !== execution.generationId
  ) {
    return null;
  }
  if (rowString(projection, "status", "phase") !== phase) return null;
  return { phase, reason };
}

function adoptPublishedTerminalAuthority(
  db: Database,
  current: TurnExecutionRecord,
  ownerToken: string | null,
  now: number,
): TurnExecutionRecord | null {
  const authority = publishedTerminalAuthority(db, current);
  if (!authority) return null;
  if (current.phase === authority.phase) return current;
  const fromInterruptedFailure = current.phase === "FAILED" && current.terminalCode === "process_interrupted";
  const fromReversible = REVERSIBLE_PHASE_SET.has(current.phase);
  if (!fromInterruptedFailure && !fromReversible) return null;
  if (current.cancelRequested || authority.phase === "CANCELLED" || authority.phase === "TIMED_OUT") {
    return terminalizeWithCancellationMarkerFence(
      db,
      current,
      ownerToken,
      authority.phase,
      authority.reason,
      now,
    ).outcome.execution;
  }
  return terminalizeWithCas(
    db,
    current,
    ownerToken,
    current.phase,
    current.casRevision,
    authority.phase,
    authority.reason,
    now,
  ).execution;
}

function terminalInspectionReasonForExecution(
  execution: TurnExecutionRecord,
): AgentInspectionReasonV1 {
  const code = execution.terminalCode?.trim().toLowerCase() ?? "";
  if (code === "terminal_publication_failed" || code === "projection_unavailable") return "needs_attention";
  if (execution.phase === "CANCELLED") return code === "deadline" || code === "timed_out" ? "deadline" : "user_stop";
  if (execution.phase === "TIMED_OUT") return "deadline";
  if (execution.phase === "EXHAUSTED") return "budget_exhausted";
  if (code === "decision_refresh_required") return "stale_input";
  if (code === "invalid_input" || code === "agentic_runtime_unavailable") {
    return "invalid_input";
  }
  if (code.includes("provider")) return "provider_failure";
  if (code.includes("tool")) return "tool_failure";
  if (code.includes("required_work")) return "required_work_failure";
  if (code.includes("budget") || code.includes("limit") || code === "exhausted") return "budget_exhausted";
  if (code === "interrupted" || code === "process_interrupted") return "interrupted";
  if (code.length > 0) return "needs_attention";
  return "unknown";
}
function terminalRecoveryOutcome(execution: TurnExecutionRecord): AgentInspectionOutcomeV1 {
  const outcome = execution.workOutcome;
  if (
    outcome === "completed"
    || outcome === "stopped"
    || outcome === "failed"
    || outcome === "exhausted"
    || outcome === "rejected"
  ) return outcome;
  throw new TurnExecutionError("execution_schema_unavailable", "terminal execution outcome is unavailable", {
    executionId: execution.id,
    phase: execution.phase,
  });
}


const INSPECTION_RECOVERY_REASONS: ReadonlySet<string> = new Set([
  "none",
  "user_stop",
  "deadline",
  "provider_failure",
  "tool_failure",
  "required_work_failure",
  "budget_exhausted",
  "invalid_input",
  "stale_input",
  "unavailable",
  "needs_attention",
  "interrupted",
  "retry_requested",
  "reconciled",
  "unknown",
]);

function isInspectionRecoveryReason(value: string | null): value is AgentInspectionReasonV1 {
  return value !== null && INSPECTION_RECOVERY_REASONS.has(value);
}
const HISTORICAL_INSPECTION_REASON_ALIASES_V1: Readonly<Record<string, true>> = Object.freeze({
  failed: true,
  process_interrupted: true,
  stopped: true,
  cancelled: true,
  exhausted: true,
  stale_input_revision: true,
});

function normalizedHistoricalInspectionReason(
  execution: TurnExecutionRecord,
  value: string | null,
  historicalState: boolean,
): AgentInspectionReasonV1 | null {
  if (isInspectionRecoveryReason(value)) return value;
  if (!historicalState || value === null || !HISTORICAL_INSPECTION_REASON_ALIASES_V1[value]) return null;
  switch (value) {
    case "failed":
      return terminalInspectionReasonForExecution(execution);
    case "process_interrupted":
      return "interrupted";
    case "stopped":
    case "cancelled":
      return execution.phase === "CANCELLED" ? "user_stop" : null;
    case "exhausted":
      return execution.phase === "EXHAUSTED" ? "budget_exhausted" : null;
    case "stale_input_revision":
      return execution.phase === "COMMIT_FAILED" ? "stale_input" : null;
    default:
      return null;
  }
}

const AGENT_PUBLIC_ERROR_CODES_SET: ReadonlySet<string> = new Set(AGENT_PUBLIC_ERROR_CODES);

function terminalProjectionReasonForExecution(
  execution: TurnExecutionRecord,
  inspectionReason: AgentInspectionReasonV1,
  outcome: AgentInspectionOutcomeV1 = terminalRecoveryOutcome(execution),
): string {
  const code = execution.terminalCode?.trim().toLowerCase() ?? "";
  if (code === "terminal_publication_failed" || code === "projection_unavailable") {
    return "projection_unavailable";
  }
  if (code === "decision_refresh_required") return "stale_input";
  if (outcome === "rejected" && inspectionReason === "needs_attention") return "invalid_input";
  if (execution.phase === "COMMIT_FAILED"
    && (code === "commit_failed" || code === "failed" || code === "interrupted" || code === "process_interrupted")) {
    return "commit_failed";
  }
  if (code === "interrupted" || code === "process_interrupted") return "failed";
  if (code === "failed") return "failed";
  if (execution.phase === "CANCELLED" || outcome === "stopped") return "stopped";
  if (execution.phase === "TIMED_OUT") return "deadline";
  if (execution.phase === "EXHAUSTED" || outcome === "exhausted") return "budget_exhausted";
  return inspectionReason;
}

function terminalProjectionErrorCodeForExecution(
  execution: TurnExecutionRecord,
  inspectionReason: AgentInspectionReasonV1,
  outcome: AgentInspectionOutcomeV1 = terminalRecoveryOutcome(execution),
): string | null {
  const code = execution.terminalCode?.trim().toLowerCase() ?? "";
  if (code === "decision_refresh_required") return "decision_refresh_required";
  if (code === "agentic_runtime_unavailable") return "invalid_input";
  if (code === "agentic_work_exhausted") return "limit_exceeded";
  if (code && AGENT_PUBLIC_ERROR_CODES_SET.has(code)) return code;
  if (inspectionReason === "needs_attention" || code === "terminal_publication_failed") {
    return outcome === "stopped"
      ? "cancelled"
      : outcome === "exhausted"
        ? "limit_exceeded"
        : outcome === "rejected"
          ? "invalid_input"
          : "internal_error";
  }
  if (code === "interrupted" || code === "process_interrupted") return "internal_error";
  if (execution.phase === "COMMIT_FAILED") return "internal_error";
  return null;
}

function terminalRecoveryReason(
  execution: TurnExecutionRecord,
  inspectionReason: AgentInspectionReasonV1,
  outcome: AgentInspectionOutcomeV1 = terminalRecoveryOutcome(execution),
): string {
  return terminalProjectionReasonForExecution(execution, inspectionReason, outcome).slice(0, 128);
}

interface TerminalRecoveryTarget {
  readonly messageId: string | null;
  readonly swipeId: number | null;
}

interface TerminalAuditEvidence {
  readonly targetMatches: boolean;
  readonly auditedTarget: TerminalRecoveryTarget | null;
  readonly quarantineEvidence: boolean;
  readonly terminalOutcome: AgentInspectionOutcomeV1 | null;
  readonly terminalReason: string | null;
}

interface TerminalInspectionResolution {
  readonly outcome: AgentInspectionOutcomeV1;
  readonly inspectionReason: AgentInspectionReasonV1;
  readonly projectionReason: string;
  readonly projectionTarget: TerminalRecoveryTarget;
  readonly inspectionTarget: TerminalRecoveryTarget;
  readonly attemptLineage: AgentWorkAttemptLineageV1;
  readonly hostCorrelationId: string;
  readonly previousAttemptId: string | null;
  readonly inspectionExact: boolean;
  readonly inspectionRow: Record<string, unknown> | null;
  readonly historicalRepair: boolean;
  readonly legacyDecisionRefreshOutcomeRepair: boolean;
  readonly explicitUnrecoverable: boolean;
}

function isTerminalInspectionOutcome(value: string | null): value is AgentInspectionOutcomeV1 {
  return value === "stopped" || value === "failed" || value === "exhausted" || value === "rejected";
}
function normalizeHistoricalTerminalOutcome(value: unknown): AgentInspectionOutcomeV1 | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return isTerminalInspectionOutcome(normalized) ? normalized : null;
}

function sameRecoveryTarget(left: TerminalRecoveryTarget, right: TerminalRecoveryTarget): boolean {
  return left.messageId === right.messageId && left.swipeId === right.swipeId;
}

function parseRecoverySwipes(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storedRecoveryTargetIsValid(
  db: Database,
  chatId: string,
  messageId: string | null,
  swipeId: number | null,
): boolean {
  if (messageId === null) return swipeId === null;
  if (!messageId) return false;
  try {
    const row = db.query(
      "SELECT swipes FROM messages WHERE id = ? AND chat_id = ? LIMIT 1",
    ).get(messageId, chatId) as { swipes?: unknown } | null;
    if (!row) return false;
    if (swipeId === null) return true;
    if (!Number.isSafeInteger(swipeId) || swipeId < 0) return false;
    const swipes = parseRecoverySwipes(row.swipes);
    if (!swipes) return false;
    return swipeId < swipes.length;
  } catch {
    return false;
  }
}


function auditNullableId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function auditNullableSwipe(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function terminalAuditEvidence(
  db: Database,
  execution: TurnExecutionRecord,
  row: Record<string, unknown>,
  candidates: readonly TerminalRecoveryTarget[] = [],
): TerminalAuditEvidence {
  if (!hasTable(db, "agent_run_audit_records")) {
    return {
      targetMatches: false,
      auditedTarget: null,
      quarantineEvidence: false,
      terminalOutcome: null,
      terminalReason: null,
    };
  }
  const expectedMessageId = rowString(row, "target_message_id");
  const expectedSwipeId = rowNumber(row, "target_swipe_id");
  let targetMatches = false;
  let auditedTarget: TerminalRecoveryTarget | null = null;
  let ambiguousTarget = false;
  let quarantineEvidence = false;
  let terminalOutcome: AgentInspectionOutcomeV1 | null = null;
  let terminalReason: string | null = null;
  let rows: Array<{ event_id?: unknown; payload_json?: unknown }> = [];
  try {
    rows = db.query(
      `SELECT event_id, payload_json
         FROM agent_run_audit_records
        WHERE user_id = ? AND chat_id = ? AND attempt_id = ?
        ORDER BY host_sequence, record_id
        LIMIT 512`,
    ).all(execution.userId, execution.chatId, rowString(row, "attempt_id") ?? execution.id) as Array<{
      event_id?: unknown;
      payload_json?: unknown;
    }>;
  } catch {
    return { targetMatches, auditedTarget, quarantineEvidence, terminalOutcome, terminalReason };
  }
  for (const auditRow of rows) {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(String(auditRow.payload_json ?? "{}")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      payload = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const detail = typeof payload.detail === "string" ? payload.detail : "";
    if (detail.includes("unrecoverable_target")) quarantineEvidence = true;
    const correlation = payload.correlation;
    if (!correlation || typeof correlation !== "object" || Array.isArray(correlation)) continue;
    const c = correlation as Record<string, unknown>;
    const messageId = auditNullableId(c.messageId);
    const swipeId = auditNullableSwipe(c.swipeId);
    if (messageId === undefined || swipeId === undefined) continue;
    if (messageId === expectedMessageId && swipeId === expectedSwipeId) targetMatches = true;
    for (const candidate of candidates) {
      if (!sameRecoveryTarget(candidate, { messageId, swipeId })) continue;
      if (auditedTarget && !sameRecoveryTarget(auditedTarget, candidate)) ambiguousTarget = true;
      else auditedTarget = candidate;
    }
    const eventId = String(auditRow.event_id ?? "");
    if (!eventId.startsWith("terminal:") && payload.kind !== "terminal") continue;
    let result: Record<string, unknown> = {};
    const rawResult = payload.result;
    if (rawResult && typeof rawResult === "object" && !Array.isArray(rawResult)) {
      result = rawResult as Record<string, unknown>;
    } else if (typeof rawResult === "string") {
      try {
        const parsedResult = JSON.parse(rawResult) as unknown;
        if (parsedResult && typeof parsedResult === "object" && !Array.isArray(parsedResult)) {
          result = parsedResult as Record<string, unknown>;
        }
      } catch {
        // A malformed historical terminal payload is not audit evidence.
      }
    }
    const outcome = normalizeHistoricalTerminalOutcome(
      typeof result.workOutcome === "string"
        ? result.workOutcome
        : typeof result.outcome === "string" ? result.outcome : null,
    );
    const status = normalizeHistoricalTerminalOutcome(
      typeof result.status === "string"
        ? result.status
        : typeof payload.status === "string" ? payload.status : null,
    );
    if (outcome !== null) terminalOutcome = outcome;
    else if (status !== null) terminalOutcome = status;
    const reason = typeof payload.errorReason === "string"
      ? payload.errorReason
      : typeof result.reason === "string" ? result.reason : null;
    if (reason) terminalReason = reason;
  }
  return {
    targetMatches,
    auditedTarget: ambiguousTarget ? null : auditedTarget,
    quarantineEvidence,
    terminalOutcome,
    terminalReason,
  };
}

function inspectionCoreIdentityMatches(
  row: Record<string, unknown>,
  execution: TurnExecutionRecord,
): boolean {
  return rowString(row, "user_id") === execution.userId
    && rowString(row, "chat_id") === execution.chatId
    && rowString(row, "run_id") === execution.generationId
    && rowString(row, "turn_id") === execution.id
    && rowString(row, "generation_id") === execution.generationId
    && rowString(row, "generation_type") === execution.targetKind
    && rowString(row, "target_message_id") === execution.targetMessageId;
}

function inspectionTargetFromRow(
  row: Record<string, unknown> | null,
  execution: TurnExecutionRecord,
  fallback: TerminalRecoveryTarget,
): TerminalRecoveryTarget {
  return row
    ? {
        messageId: rowString(row, "target_message_id"),
        swipeId: rowNumber(row, "target_swipe_id"),
      }
    : {
        messageId: fallback.messageId ?? execution.targetMessageId,
        swipeId: fallback.swipeId ?? execution.targetSwipeId,
      };
}

function attemptLineageForRecovery(
  row: Record<string, unknown> | null,
  execution: TurnExecutionRecord,
  target: TerminalRecoveryTarget,
): AgentWorkAttemptLineageV1 {
  const generationTypeValue = row ? rowString(row, "generation_type") : null;
  const attemptId = row ? rowString(row, "attempt_id") : null;
  const chatId = row ? rowString(row, "chat_id") : null;
  const createdAt = row ? rowNumber(row, "started_at") : null;
  return {
    version: 1,
    attemptId: attemptId ?? execution.attemptLineage.attemptId,
    previousAttemptId: row
      ? rowString(row, "previous_attempt_id")
      : execution.attemptLineage.previousAttemptId ?? null,
    target: {
      chatId: chatId ?? execution.chatId,
      generationType: generationTypeValue && isGenerationTarget(generationTypeValue)
        ? generationTypeValue
        : execution.targetKind,
      messageId: target.messageId,
      swipeId: target.messageId === null ? null : target.swipeId,
    },
    createdAt: createdAt ?? execution.attemptLineage.createdAt,
  };
}

function isLegacyDecisionRefreshOutcomeDefect(
  db: Database,
  execution: TurnExecutionRecord,
  row: Record<string, unknown>,
): boolean {
  const inspectionOutcome = rowString(row, "outcome");
  const reconciliationState = rowString(row, "reconciliation_state");
  const legacyInspection = inspectionOutcome === "failed"
    && (reconciliationState === "authoritative" || reconciliationState === "recovered");
  // The old writer could settle the inspection after it had already emitted
  // the obsolete failed projection, leaving only the projection to repair.
  const canonicalInspectionFromOldWriter = inspectionOutcome === "rejected"
    && reconciliationState === "recovered";
  return execution.phase === "FAILED"
    && execution.terminalCode === "decision_refresh_required"
    && execution.workOutcome === "rejected"
    && rowString(row, "lifecycle") === "TERMINAL"
    && rowString(row, "status") === "terminal"
    && rowNumber(row, "terminal") === 1
    && rowString(row, "reason") === "stale_input"
    && rowString(row, "terminal_receipt_json") === null
    && (legacyInspection || canonicalInspectionFromOldWriter)
    && hasTable(db, "agent_turn_commit_receipts")
    && rawReceipt(db, execution) === null;
}

function resolveTerminalInspection(
  db: Database,
  row: Record<string, unknown> | null,
  execution: TurnExecutionRecord,
): TerminalInspectionResolution {
  const executionOutcome = terminalRecoveryOutcome(execution);
  const executionInspectionReason = terminalInspectionReasonForExecution(execution);
  const executionTarget: TerminalRecoveryTarget = {
    messageId: execution.targetMessageId,
    swipeId: execution.targetSwipeId,
  };
  const executionTargetValid = storedRecoveryTargetIsValid(
    db,
    execution.chatId,
    executionTarget.messageId,
    executionTarget.swipeId,
  );
  const projectionTargetIfValid = executionTargetValid ? executionTarget : { messageId: null, swipeId: null };
  if (!row) {
    if (!executionTargetValid) {
      throw new TurnExecutionError("invalid_execution_input", "historical terminal target has no durable audit authority", {
        executionId: execution.id,
        phase: execution.phase,
      });
    }
    return {
      outcome: executionOutcome,
      inspectionReason: executionInspectionReason,
      projectionReason: terminalRecoveryReason(execution, executionInspectionReason, executionOutcome),
      projectionTarget: projectionTargetIfValid,
      inspectionTarget: projectionTargetIfValid,
      attemptLineage: attemptLineageForRecovery(null, execution, projectionTargetIfValid),
      hostCorrelationId: `agentic:${execution.id}:${execution.attemptLineage.attemptId}`,
      previousAttemptId: execution.attemptLineage.previousAttemptId ?? null,
      inspectionExact: false,
      inspectionRow: null,
      historicalRepair: false,
      legacyDecisionRefreshOutcomeRepair: false,
      explicitUnrecoverable: false,
    };
  }
  if (!inspectionCoreIdentityMatches(row, execution)) {
    throw new TurnExecutionError("invalid_execution_input", "terminal inspection identity does not match the execution", {
      executionId: execution.id,
      phase: execution.phase,
    });
  }
  const inspectionTarget = inspectionTargetFromRow(row, execution, executionTarget);
  const targetMismatch = !sameRecoveryTarget(inspectionTarget, executionTarget);
  const rowTerminal = rowNumber(row, "terminal") === 1;
  const rowOutcome = normalizeHistoricalTerminalOutcome(rowString(row, "outcome"));
  const rowReason = rowString(row, "reason");
  const outcomeMismatch = rowTerminal && rowOutcome !== null && rowOutcome !== executionOutcome;
  const historicalState = rowString(row, "reconciliation_state") === "authoritative"
    || rowString(row, "reconciliation_state") === "recovered";
  const legacyDecisionRefreshOutcomeRepair = isLegacyDecisionRefreshOutcomeDefect(db, execution, row);
  const requiresAudit = !executionTargetValid
    || targetMismatch
    || outcomeMismatch && !legacyDecisionRefreshOutcomeRepair;
  const evidence = requiresAudit
    ? terminalAuditEvidence(db, execution, row, [executionTarget, inspectionTarget])
    : null;
  let projectionTarget = projectionTargetIfValid;
  if (
    !executionTargetValid
    && evidence?.auditedTarget
    && storedRecoveryTargetIsValid(
      db,
      execution.chatId,
      evidence.auditedTarget.messageId,
      evidence.auditedTarget.swipeId,
    )
  ) {
    projectionTarget = evidence.auditedTarget;
  }
  const targetRedacted = !sameRecoveryTarget(projectionTarget, executionTarget);
  const auditedTarget = !targetRedacted && !targetMismatch
    || Boolean(
      evidence?.auditedTarget
      && (
        sameRecoveryTarget(evidence.auditedTarget, executionTarget)
        || sameRecoveryTarget(evidence.auditedTarget, inspectionTarget)
      ),
    );
  const canQuarantine = !executionTargetValid
    && historicalState
    && rowString(row, "reconciliation_state") === "recovered"
    && rowTerminal
    && !storedRecoveryTargetIsValid(
      db,
      execution.chatId,
      inspectionTarget.messageId,
      inspectionTarget.swipeId,
    )
    && !evidence?.auditedTarget;
  const explicitUnrecoverable = canQuarantine || Boolean(evidence?.quarantineEvidence);
  const auditedOutcome = !outcomeMismatch
    || Boolean(
      (evidence?.terminalOutcome === rowOutcome || evidence?.terminalOutcome === executionOutcome)
      && (evidence?.terminalReason === null || evidence?.terminalReason === rowReason),
    );
  if (
    requiresAudit && !historicalState
    || targetRedacted && !auditedTarget && !explicitUnrecoverable
    || targetMismatch && !auditedTarget && !explicitUnrecoverable
    || outcomeMismatch && !legacyDecisionRefreshOutcomeRepair && !auditedOutcome
  ) {
    throw new TurnExecutionError("invalid_execution_input", "terminal inspection contradiction is not durably audited", {
      executionId: execution.id,
      phase: execution.phase,
    });
  }
  const normalizedReason = rowTerminal
    ? normalizedHistoricalInspectionReason(execution, rowReason, historicalState)
    : null;
  if (rowTerminal && (
    rowString(row, "status") !== "terminal"
    || rowOutcome === null
    || normalizedReason === null
  )) {
    throw new TurnExecutionError("invalid_execution_input", "terminal inspection outcome is immutable", {
      executionId: execution.id,
      phase: execution.phase,
    });
  }
  const useStoredOutcome = !(legacyDecisionRefreshOutcomeRepair && outcomeMismatch)
    && rowTerminal && rowOutcome !== null
    && (
      !outcomeMismatch
      || evidence?.terminalOutcome === rowOutcome
      || rowString(row, "reconciliation_state") === "authoritative"
    );
  const outcome = useStoredOutcome ? rowOutcome : executionOutcome;
  const inspectionReason = useStoredOutcome
    && normalizedReason !== null
    && normalizedReason !== "none"
    ? normalizedReason
    : executionInspectionReason;
  const historicalRepair = targetRedacted || targetMismatch || outcomeMismatch || !rowTerminal;
  const inspectionExact = rowTerminal
    && historicalState
    && !(legacyDecisionRefreshOutcomeRepair && outcomeMismatch)
    && (
      rowString(row, "reconciliation_state") === "authoritative"
      || auditedOutcome && (!explicitUnrecoverable || Boolean(evidence?.quarantineEvidence))
    );
  return {
    outcome,
    inspectionReason,
    projectionReason: explicitUnrecoverable
      ? "projection_unavailable"
      : terminalRecoveryReason(execution, inspectionReason, outcome),
    projectionTarget,
    inspectionTarget,
    attemptLineage: attemptLineageForRecovery(
      row,
      execution,
      explicitUnrecoverable ? { messageId: null, swipeId: null } : inspectionTarget,
    ),
    hostCorrelationId: rowString(row, "host_correlation_id")
      ?? `agentic:${execution.id}:${execution.attemptLineage.attemptId}`,
    previousAttemptId: rowString(row, "previous_attempt_id"),
    inspectionExact,
    inspectionRow: row,
    historicalRepair,
    legacyDecisionRefreshOutcomeRepair,
    explicitUnrecoverable,
  };
}

interface TerminalProjectionMatch {
  readonly exact: boolean;
  readonly terminalRejectedOutcomeRepair: boolean;
}

function terminalProjectionMatches(
  db: Database,
  execution: TurnExecutionRecord,
  outcome: AgentInspectionOutcomeV1,
  reason: string,
  errorCode: string | null,
  target: TerminalRecoveryTarget,
  legacyDecisionRefreshOutcomeRepair: boolean,
  inspectionExact: boolean,
): TerminalProjectionMatch {
  const projectionColumns = tableColumns(db, "agent_run_projections");
  const projectionStatusColumns = ["status", "phase"]
    .filter((column) => projectionColumns.has(column))
    .map(quoteColumn)
    .join(", ");
  if (!projectionStatusColumns) {
    throw new TurnExecutionError("execution_schema_unavailable", "terminal projection status is unavailable", {
      executionId: execution.id,
      phase: execution.phase,
    });
  }
  const row = db.query(
    `SELECT user_id, chat_id, turn_id, generation_id, generation_type,
            target_message_id, target_swipe_id, ${projectionStatusColumns}, snapshot_json
       FROM agent_run_projections
      WHERE user_id = ? AND turn_id = ?
      LIMIT 1`,
  ).get(execution.userId, execution.id) as Record<string, unknown> | null;
  if (!row) return { exact: false, terminalRejectedOutcomeRepair: false };
  const parsed = (() => {
    try {
      const value = JSON.parse(String(row.snapshot_json ?? "{}"));
      return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    } catch {
      throw new TurnExecutionError("execution_schema_unavailable", "terminal projection snapshot is malformed", {
        executionId: execution.id,
        phase: execution.phase,
      });
    }
  })();
  if (!parsed) {
    throw new TurnExecutionError("execution_schema_unavailable", "terminal projection snapshot is unavailable", {
      executionId: execution.id,
      phase: execution.phase,
    });
  }
  const storedStatus = rowString(row, "status", "phase");
  if (
    rowString(row, "user_id") !== execution.userId
    || rowString(row, "chat_id") !== execution.chatId
    || rowString(row, "turn_id") !== execution.id
    || rowString(row, "generation_id") !== execution.generationId
    || rowString(row, "generation_type") !== execution.targetKind
  ) {
    throw new TurnExecutionError("invalid_execution_input", "terminal projection identity does not match the canonical projection", {
      executionId: execution.id,
      phase: execution.phase,
    });
  }
  const storedTargetMessageId = rowString(row, "target_message_id");
  if (
    storedTargetMessageId !== null
    && target.messageId !== null
    && storedTargetMessageId !== target.messageId
  ) {
    throw new TurnExecutionError("invalid_execution_input", "terminal projection identity does not match the canonical projection", {
      executionId: execution.id,
      phase: execution.phase,
    });
  }

  const storedTerminal = TERMINAL_PHASE_SET.has(storedStatus as TurnExecutionPhase);
  if (!storedTerminal) return { exact: false, terminalRejectedOutcomeRepair: false };
  const parsedError = parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)
    ? parsed.error as Record<string, unknown>
    : null;
  const storedOutcome = parsed.workOutcome;
  const storedReason = typeof parsed.reason === "string" ? parsed.reason : null;
  const storedErrorCode = parsedError && typeof parsedError.code === "string" ? parsedError.code : null;
  const storedErrorOutcome = parsedError?.workOutcome;
  // Identity plus terminal outcome is the immutable authority. A later
  // recovery pass may re-derive reason/error labels; those must not rewrite
  // an already-terminal projection or fail the whole startup scan.
  if (storedStatus === execution.phase && storedOutcome === outcome) {
    return { exact: true, terminalRejectedOutcomeRepair: false };
  }
  if (
    legacyDecisionRefreshOutcomeRepair
    && storedStatus === "FAILED"
    && execution.phase === "FAILED"
    && storedOutcome === "failed"
    && storedReason === "stale_input"
    && storedErrorCode === "decision_refresh_required"
    && storedErrorOutcome === "failed"
    && outcome === "rejected"
    && reason === "stale_input"
    && errorCode === "decision_refresh_required"
  ) {
    return { exact: false, terminalRejectedOutcomeRepair: true };
  }
  if (
    !legacyDecisionRefreshOutcomeRepair
    && inspectionExact
    && execution.phase === "FAILED"
    && execution.workOutcome === "rejected"
    && execution.terminalCode === "invalid_input"
    && storedStatus === "FAILED"
    && storedOutcome === "failed"
    && storedReason === "failed"
    && storedErrorCode === "internal_error"
    && storedErrorOutcome === "failed"
    && outcome === "rejected"
    && reason === "invalid_input"
    && errorCode === "invalid_input"
    && rowString(row, "target_message_id") === target.messageId
    && rowNumber(row, "target_swipe_id") === target.swipeId
    && rawReceipt(db, execution) === null
  ) {
    return { exact: false, terminalRejectedOutcomeRepair: true };
  }
  if (
    storedStatus === execution.phase
    && storedStatus === "EXHAUSTED"
    && outcome === "exhausted"
  ) {
    return { exact: false, terminalRejectedOutcomeRepair: false };
  }
  throw new TurnExecutionError(
    "invalid_execution_input",
    `terminal projection outcome is immutable: stored ${String(storedOutcome)}/${storedStatus}/${storedReason ?? "none"}/${storedErrorCode ?? "none"}/${rowString(row, "target_message_id") ?? "none"} expected ${outcome}/${execution.phase}/${reason}/${errorCode ?? "none"}/${target.messageId ?? "none"}`,
    { executionId: execution.id, phase: execution.phase },
  );
}


function persistRecoveredTerminalInspection(
  db: Database,
  execution: TurnExecutionRecord,
  resolution: TerminalInspectionResolution,
): void {
  const row = resolution.inspectionRow;
  const rowAttemptId = row ? rowString(row, "attempt_id") : null;
  const rowUserId = row ? rowString(row, "user_id") : null;
  const rowChatId = row ? rowString(row, "chat_id") : null;
  const rowRunId = row ? rowString(row, "run_id") : null;
  const rowTurnId = row ? rowString(row, "turn_id") : null;
  const rowGenerationId = row ? rowString(row, "generation_id") : null;
  const rowStartedAt = row ? rowNumber(row, "started_at") : null;
  const rowUpdatedAt = row ? rowNumber(row, "updated_at") : null;
  const rowTerminalAt = row ? rowNumber(row, "terminal_at") : null;
  const attemptId = rowAttemptId ?? execution.attemptLineage.attemptId;
  if (resolution.legacyDecisionRefreshOutcomeRepair) {
    const repaired = db.query(
      "UPDATE agent_run_attempts SET outcome = 'rejected', reconciliation_state = 'recovered' WHERE user_id = ? AND attempt_id = ? AND run_id = ? AND turn_id = ? AND generation_id = ? AND lifecycle = 'TERMINAL' AND status = 'terminal' AND terminal = 1 AND outcome = 'failed' AND reason = 'stale_input' AND terminal_receipt_json IS NULL AND reconciliation_state IN ('authoritative', 'recovered')",
    ).run(
      execution.userId,
      attemptId,
      execution.generationId,
      execution.id,
      execution.generationId,
    );
    if (repaired.changes !== 1) {
      throw new TurnExecutionError("invalid_execution_input", "legacy stale-decision inspection repair lost its exact authority", {
        executionId: execution.id,
        phase: execution.phase,
      });
    }
  }
  const inspectionTarget = resolution.inspectionTarget;
  const updatedAt = Math.max(
    rowUpdatedAt ?? 0,
    execution.terminalAt ?? execution.updatedAt,
  );
  const terminalAt = Math.max(
    rowTerminalAt ?? 0,
    execution.terminalAt ?? execution.updatedAt,
  );
  const input: PersistAgentRunInspectionInputV1 = {
    userId: rowUserId ?? execution.userId,
    chatId: rowChatId ?? execution.chatId,
    attemptId,
    previousAttemptId: resolution.previousAttemptId,
    runId: rowRunId ?? execution.generationId,
    turnSessionId: rowTurnId ?? execution.id,
    generationId: rowGenerationId ?? execution.generationId,
    generationType: execution.targetKind,
    targetMessageId: inspectionTarget.messageId,
    targetSwipeId: inspectionTarget.swipeId,
    hostCorrelationId: resolution.hostCorrelationId,
    lifecycle: "TERMINAL",
    status: "terminal",
    outcome: resolution.outcome,
    reason: resolution.inspectionReason,
    startedAt: rowStartedAt ?? execution.createdAt,
    updatedAt,
    terminalAt,
    reconciliation: "recovered",
    markers: [{
      id: `recovery:terminal:${execution.id}`,
      kind: "recovery",
      scope: "run",
      terminal: true,
      outcome: resolution.outcome,
      reason: resolution.inspectionReason,
      detail: JSON.stringify({
        source: "startup_terminal_recovery",
        phase: execution.phase,
        status: execution.phase,
        errorCode: execution.terminalCode,
        executionOutcome: execution.workOutcome,
        inspectionOutcome: resolution.outcome,
        inspectionTarget,
        projectionTarget: resolution.projectionTarget,
        ...(resolution.explicitUnrecoverable ? {
          quarantine: "unrecoverable_target",
          quarantineReason: "historical terminal target is invalid without an audited replacement",
        } : {}),
        ...(resolution.legacyDecisionRefreshOutcomeRepair
          ? { repairedDefect: "fd8_stale_decision_terminal_outcome" }
          : {}),
      }),
      correlation: {
        parentId: "root",
        messageId: inspectionTarget.messageId,
        swipeId: inspectionTarget.swipeId,
      },
    }],
  };
  if (!persistAgentRunInspectionInTransaction(db, input)) {
    throw new TurnExecutionError("execution_schema_unavailable", "terminal inspection recovery did not persist", {
      executionId: execution.id,
      phase: execution.phase,
    });
  }
}

function appendRecoveredTerminalProjection(
  db: Database,
  execution: TurnExecutionRecord,
  resolution: TerminalInspectionResolution,
  rewriteInspection: boolean,
  terminalRejectedOutcomeRepair: boolean,
): void {
  const errorCode = resolution.explicitUnrecoverable
    ? "internal_error"
    : terminalProjectionErrorCodeForExecution(
      execution,
      resolution.inspectionReason,
      resolution.outcome,
    );
  const target = resolution.projectionTarget;
  const projection: AgentRunProjectionInputV2 = {
    userId: execution.userId,
    chatId: execution.chatId,
    turnId: execution.id,
    generationId: execution.generationId,
    generationType: execution.targetKind,
    targetMessageId: target.messageId,
    targetSwipeId: target.swipeId,
    attemptLineage: resolution.attemptLineage,
    status: execution.phase,
    workPhase: "TERMINAL",
    workStatus: "terminal",
    workOutcome: resolution.outcome,
    reason: resolution.projectionReason,
    ...(errorCode ? {
      error: {
        code: errorCode,
        recoveryEligible: true,
        recoveryAction: "resync",
        reason: resolution.projectionReason,
        workPhase: "TERMINAL",
        workStatus: "terminal",
        workOutcome: resolution.outcome,
      },
    } : {}),
    startedAt: execution.createdAt,
    updatedAt: execution.updatedAt,
    activity: [],
    terminalHandoff: target.messageId === null ? null : {
      version: 2,
      committed: false,
      messageId: target.messageId,
      swipeId: target.swipeId,
      messageRevision: null,
      swipeRevision: null,
    },
    ...(terminalRejectedOutcomeRepair
      ? { terminalRejectedOutcomeRepair: true as const }
      : {}),
    ...(rewriteInspection || execution.phase === "EXHAUSTED" ? { recoveryRepair: true as const } : { preserveTerminalInspection: true as const }),
  };
  appendAgentRunSnapshot(db, projection);
}


function terminalRecoveryTablesAvailable(db: Database): boolean {
  return hasTable(db, "agent_run_attempts")
    && hasTable(db, "agent_run_projections")
    && hasTable(db, "agent_chat_events");
}
interface TerminalPersistentSessionRow {
  readonly phase: string;
  readonly status: string;
  readonly outcome: string | null;
  readonly revision: number;
  readonly attemptId: string;
  readonly chatId: string | null;
}

function terminalPersistentSessionRow(
  db: Database,
  execution: TurnExecutionRecord,
): TerminalPersistentSessionRow | null {
  if (!hasTable(db, "persistent_workspace_turn_sessions")) return null;
  const row = db.query(
    "SELECT phase, status, outcome, revision, attempt_id AS attemptId, chat_id AS chatId FROM persistent_workspace_turn_sessions " +
      "WHERE user_id = ? AND turn_id = ? AND execution_id = ? LIMIT 1",
  ).get(
    execution.userId,
    execution.id,
    execution.id,
  ) as TerminalPersistentSessionRow | null;
  if (row && row.attemptId !== execution.attemptLineage.attemptId && row.attemptId !== execution.id) {
    throw new TurnExecutionError("invalid_execution_input", "terminal Turn Session attempt identity conflicts with the execution");
  }
  return row;
}

function persistentSessionMatchesTerminalExecution(
  row: TerminalPersistentSessionRow | null,
  outcome: AgentInspectionOutcomeV1,
): boolean {
  if (!row) return true;
  if (row.phase !== "TERMINAL" && row.status !== "terminal") return false;
  if (row.phase !== "TERMINAL" || row.status !== "terminal" || row.outcome !== outcome) {
    throw new TurnExecutionError("invalid_execution_input", "terminal Turn Session conflicts with the execution");
  }
  return true;
}

function persistRecoveredTerminalSession(
  db: Database,
  execution: TurnExecutionRecord,
  row: TerminalPersistentSessionRow | null,
  outcome: AgentInspectionOutcomeV1,
  reason: string,
): void {
  if (!row) return;
  const terminalAt = Math.floor(Date.now() / 1000);
  const changed = db.query(
    "UPDATE persistent_workspace_turn_sessions " +
      "SET phase = 'TERMINAL', status = 'terminal', outcome = ?, reason = ?, revision = revision + 1, updated_at = ?, terminal_at = ? " +
      "WHERE user_id = ? AND turn_id = ? AND attempt_id = ? AND execution_id = ? AND revision = ?",
  ).run(
    outcome,
    reason,
    terminalAt,
    terminalAt,
    execution.userId,
    execution.id,
    row.attemptId,
    execution.id,
    row.revision,
  ).changes;
  if (changed !== 1) {
    throw new TurnExecutionError("stale_execution", "terminal Turn Session changed during recovery", {
      executionId: execution.id,
      phase: execution.phase,
    });
  }
}
function reconcileCommittedPersistentSession(
  db: Database,
  execution: TurnExecutionRecord,
): void {
  const row = terminalPersistentSessionRow(db, execution);
  if (persistentSessionMatchesTerminalExecution(row, "completed")) return;
  persistRecoveredTerminalSession(db, execution, row, "completed", "completed");
}

function reconcileTerminalExecutionProjection(
  db: Database,
  execution: TurnExecutionRecord,
): boolean {
  if (!isNoncommittedTerminalPhase(execution.phase)) return false;
  const persistentSession = terminalPersistentSessionRow(db, execution);
  if (persistentSession?.chatId === null) {
    const outcome = terminalRecoveryOutcome(execution);
    const reason = terminalRecoveryReason(execution, terminalInspectionReasonForExecution(execution), outcome);
    const persistentSessionExact = persistentSessionMatchesTerminalExecution(persistentSession, outcome);
    if (persistentSessionExact) return false;
    db.transaction(() => {
      const latest = requireExecution(db, execution.id).execution;
      if (latest.phase !== execution.phase || latest.casRevision !== execution.casRevision) {
        throw new TurnExecutionError("stale_execution", "terminal execution changed during detached session recovery", {
          executionId: execution.id,
          phase: execution.phase,
        });
      }
      persistRecoveredTerminalSession(db, latest, persistentSession, outcome, reason);
    })();
    return true;
  }
  if (!terminalRecoveryTablesAvailable(db)) return false;
  const attempt = execution.attemptLineage;
  const inspectionRow = db.query(
    `SELECT *
       FROM agent_run_attempts
      WHERE user_id = ? AND attempt_id = ?
      LIMIT 1`,
  ).get(execution.userId, attempt.attemptId) as Record<string, unknown> | null;
  const resolution = resolveTerminalInspection(db, inspectionRow, execution);
  const errorCode = terminalProjectionErrorCodeForExecution(
    execution,
    resolution.inspectionReason,
    resolution.outcome,
  );
  const projectionMatch = terminalProjectionMatches(
    db,
    execution,
    resolution.outcome,
    resolution.projectionReason,
    errorCode,
    resolution.projectionTarget,
    resolution.legacyDecisionRefreshOutcomeRepair,
    resolution.inspectionExact,
  );
  const persistentSessionExact = persistentSessionMatchesTerminalExecution(persistentSession, resolution.outcome);
  if (resolution.inspectionExact && projectionMatch.exact && persistentSessionExact) return false;
  db.transaction(() => {
    const latest = requireExecution(db, execution.id).execution;
    if (latest.phase !== execution.phase || latest.casRevision !== execution.casRevision) {
      throw new TurnExecutionError("stale_execution", "terminal execution changed during recovery", {
        executionId: execution.id,
        phase: execution.phase,
      });
    }
    if (!persistentSessionExact) {
      persistRecoveredTerminalSession(db, latest, persistentSession, resolution.outcome, resolution.projectionReason);
    }
    if (!resolution.inspectionExact) persistRecoveredTerminalInspection(db, latest, resolution);
    if (!projectionMatch.exact) {
      appendRecoveredTerminalProjection(
        db,
        latest,
        resolution,
        !resolution.inspectionExact,
        projectionMatch.terminalRejectedOutcomeRepair,
      );
    }
  })();
  return true;
}

/**
 * Invoke only the registered durable projection repairer. Production
 * registration is synchronous and runs inside the caller-owned transaction;
 * legacy asynchronous test handlers are detached without allowing a rejected
 * promise to become an unhandled startup failure.
 */
function invokeReceiptRepair(
  execution: TurnExecutionRecord,
  receipt: TurnCommitReceipt,
  options?: Pick<AgentRunReceiptRepairOptions, "historicalTargetRedaction">,
): void {
  if (!receiptRepairHandler) return;
  const pending = receiptRepairHandler(execution, receipt, options);
  if (pending) void pending.catch(() => {});
}

function orderedTypedColumnSql(
  tableAlias: string,
  columns: ReadonlySet<string>,
  sqliteTypes: readonly string[],
  names: readonly string[],
): string | null {
  const candidates = names.filter((name) => columns.has(name));
  if (candidates.length === 0) return null;
  const typeList = sqliteTypes.map((type) => `'${type}'`).join(", ");
  const branches = candidates.map((name) => {
    const column = `${tableAlias}.${quoteColumn(name)}`;
    return `WHEN typeof(${column}) IN (${typeList}) THEN ${column}`;
  });
  return `(CASE ${branches.join(" ")} ELSE NULL END)`;
}

function orderedTextColumnSql(
  tableAlias: string,
  columns: ReadonlySet<string>,
  ...names: string[]
): string | null {
  return orderedTypedColumnSql(tableAlias, columns, ["text"], names);
}

function orderedNumberColumnSql(
  tableAlias: string,
  columns: ReadonlySet<string>,
  ...names: string[]
): string | null {
  return orderedTypedColumnSql(tableAlias, columns, ["integer", "real"], names);
}
function exactTerminalReconciliationPredicate(
  db: Database,
  executionColumns: ReadonlySet<string>,
  phase: string,
  executionId: string,
): string | null {
  const attemptColumns = tableColumns(db, "agent_run_attempts");
  const projectionColumns = tableColumns(db, "agent_run_projections");
  const requiredAttemptColumns = [
    "user_id", "chat_id", "attempt_id", "run_id", "turn_id", "generation_id", "generation_type",
    "target_message_id", "target_swipe_id", "status", "outcome", "reason", "terminal",
    "reconciliation_state",
  ] as const;
  const requiredProjectionColumns = [
    "user_id", "chat_id", "turn_id", "generation_id", "generation_type", "target_message_id",
    "target_swipe_id", "status", "snapshot_json",
  ] as const;
  if (
    !requiredAttemptColumns.every((column) => attemptColumns.has(column))
    || !requiredProjectionColumns.every((column) => projectionColumns.has(column))
  ) return null;

  const executionUserId = orderedTextColumnSql("e", executionColumns, "user_id");
  const executionChatId = orderedTextColumnSql("e", executionColumns, "chat_id");
  const executionCommitKey = orderedTextColumnSql("e", executionColumns, "commit_key");
  const executionTargetKind = orderedTextColumnSql("e", executionColumns, "target_kind", "target");
  if (!executionUserId || !executionChatId || !executionCommitKey || !executionTargetKind) return null;
  const storedGenerationId = orderedTextColumnSql("e", executionColumns, "generation_id");
  const executionGenerationId = storedGenerationId
    ? `COALESCE(${storedGenerationId}, ${executionId})`
    : executionId;
  const executionTargetMessageId = orderedTextColumnSql(
    "e",
    executionColumns,
    "target_message_id",
    "message_id",
  ) ?? "NULL";
  const executionTargetSwipeId = orderedNumberColumnSql(
    "e",
    executionColumns,
    "target_swipe_id",
    "swipe_id",
  ) ?? "NULL";

  const targetSnapshot = orderedTextColumnSql(
    "e",
    executionColumns,
    "target_snapshot_json",
    "target_snapshot",
  );
  const attemptId = targetSnapshot
    ? (() => {
        const validSnapshot = `(CASE WHEN json_valid(${targetSnapshot}) THEN ${targetSnapshot} ELSE '{}' END)`;
        const lineageType = `json_type(${validSnapshot}, '$.attemptLineage')`;
        const storedAttemptId = `json_extract(${validSnapshot}, '$.attemptLineage.attemptId')`;
        const storedAttemptIdType = `json_type(${validSnapshot}, '$.attemptLineage.attemptId')`;
        const previousAttemptId = `json_extract(${validSnapshot}, '$.attemptLineage.previousAttemptId')`;
        const previousAttemptIdType = `json_type(${validSnapshot}, '$.attemptLineage.previousAttemptId')`;
        const lineageCreatedAt = `json_extract(${validSnapshot}, '$.attemptLineage.createdAt')`;
        const lineageCreatedAtType = `json_type(${validSnapshot}, '$.attemptLineage.createdAt')`;
        const validAttemptId = `(
          ${lineageType} IS NOT 'object'
          OR ${storedAttemptIdType} IS NULL
          OR ${storedAttemptIdType} = 'null'
          OR (
            ${storedAttemptIdType} = 'text'
            AND (${storedAttemptId} = '' OR length(CAST(${storedAttemptId} AS BLOB)) <= ${MAX_ID_BYTES})
          )
        )`;
        const validPreviousAttemptId = `(
          ${lineageType} IS NOT 'object'
          OR ${previousAttemptIdType} IS NULL
          OR ${previousAttemptIdType} = 'null'
          OR (
            ${previousAttemptIdType} = 'text'
            AND (${previousAttemptId} = '' OR length(CAST(${previousAttemptId} AS BLOB)) <= ${MAX_ID_BYTES})
          )
        )`;
        const validCreatedAt = `(
          ${lineageType} IS NOT 'object'
          OR ${lineageCreatedAtType} IS NULL
          OR ${lineageCreatedAtType} = 'null'
          OR (
            ${lineageCreatedAtType} IN ('integer', 'real')
            AND ${lineageCreatedAt} BETWEEN -${Number.MAX_SAFE_INTEGER} AND ${Number.MAX_SAFE_INTEGER}
            AND CAST(${lineageCreatedAt} AS INTEGER) = ${lineageCreatedAt}
          )
        )`;
        return {
          value: `(CASE
            WHEN ${lineageType} = 'object'
             AND ${storedAttemptIdType} = 'text'
             AND ${storedAttemptId} <> ''
             AND length(CAST(${storedAttemptId} AS BLOB)) <= ${MAX_ID_BYTES}
            THEN ${storedAttemptId}
            ELSE ${executionId}
          END)`,
          valid: `(${validAttemptId} AND ${validPreviousAttemptId} AND ${validCreatedAt})`,
        };
      })()
    : { value: executionId, valid: "1 = 1" };

  const storedTerminalCode = orderedTextColumnSql(
    "e",
    executionColumns,
    "terminal_code",
    "error_code",
  );
  const terminalCode = `lower(trim(COALESCE(${storedTerminalCode ?? "NULL"}, ''), ${SQL_ECMASCRIPT_TRIM_CHARACTERS}))`;
  const sqlCodeList = (values: ReadonlySet<string>): string => [...values]
    .map((value) => `'${value}'`)
    .join(", ");
  const exhaustedCode = `(
    ${terminalCode} IN (${sqlCodeList(EXHAUSTED_TERMINAL_CODES)})
    OR ${terminalCode} GLOB '*_limit_exceeded'
    OR ${terminalCode} GLOB '*_budget_exhausted'
    OR ${terminalCode} GLOB '*_budget_exceeded'
  )`;
  const expectedOutcome = `(CASE
    WHEN ${phase} = 'CANCELLED' THEN 'stopped'
    WHEN ${phase} = 'TIMED_OUT' THEN 'failed'
    WHEN ${phase} = 'EXHAUSTED' THEN 'exhausted'
    WHEN ${terminalCode} IN (${sqlCodeList(STOPPED_TERMINAL_CODES)}) THEN 'stopped'
    WHEN ${terminalCode} IN (${sqlCodeList(FAILED_TERMINAL_CODES)}) THEN 'failed'
    WHEN ${exhaustedCode} THEN 'exhausted'
    WHEN ${terminalCode} IN (${sqlCodeList(REJECTED_TERMINAL_CODES)}) THEN 'rejected'
    ELSE 'failed'
  END)`;

  const canonicalReasons = [...INSPECTION_RECOVERY_REASONS]
    .map((reason) => `'${reason}'`)
    .join(", ");
  const exactReason = `(
    a.reason IN (${canonicalReasons})
    OR a.reason IN ('failed', 'process_interrupted')
    OR (${phase} = 'CANCELLED' AND a.reason IN ('stopped', 'cancelled'))
    OR (${phase} = 'EXHAUSTED' AND a.reason = 'exhausted')
    OR (${phase} = 'COMMIT_FAILED' AND a.reason = 'stale_input_revision')
  )`;

  const messageColumns = tableColumns(db, "messages");
  const messageTargetValid = messageColumns.has("id")
    && messageColumns.has("chat_id")
    && messageColumns.has("swipes")
    ? `OR (
        ${executionTargetMessageId} IS NOT NULL
        AND ${executionTargetMessageId} <> ''
        AND EXISTS (
          SELECT 1
            FROM messages AS m
           WHERE m.id = ${executionTargetMessageId}
             AND m.chat_id = ${executionChatId}
             AND (
               ${executionTargetSwipeId} IS NULL
               OR (
                 ${executionTargetSwipeId} BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                 AND CAST(${executionTargetSwipeId} AS INTEGER) = ${executionTargetSwipeId}
                 AND typeof(m.swipes) = 'text'
                 AND json_valid(m.swipes)
                 AND json_type(CASE WHEN typeof(m.swipes) = 'text' AND json_valid(m.swipes) THEN m.swipes ELSE '[]' END) = 'array'
                 AND ${executionTargetSwipeId} < json_array_length(CASE WHEN typeof(m.swipes) = 'text' AND json_valid(m.swipes) THEN m.swipes ELSE '[]' END)
               )
             )
        )
      )`
    : "";
  const targetValid = `(
    (${executionTargetMessageId} IS NULL AND ${executionTargetSwipeId} IS NULL)
    ${messageTargetValid}
  )`;
  const projectionSnapshot = `(CASE
    WHEN typeof(p.snapshot_json) = 'text' AND json_valid(p.snapshot_json)
    THEN p.snapshot_json
    ELSE '{}'
  END)`;

  return `(
    ${executionId} <> ''
    AND ${executionUserId} <> ''
    AND ${executionChatId} <> ''
    AND ${executionCommitKey} <> ''
    AND ${executionTargetKind} IN ('normal', 'continue', 'regenerate', 'swipe')
    AND ${attemptId.valid}
    AND ${targetValid}
    AND EXISTS (
      SELECT 1
        FROM agent_run_attempts AS a
        JOIN agent_run_projections AS p
          ON p.user_id = a.user_id
         AND p.turn_id = ${executionId}
       WHERE typeof(a.user_id) = 'text'
         AND a.user_id = ${executionUserId}
         AND typeof(a.attempt_id) = 'text'
         AND a.attempt_id = ${attemptId.value}
         AND typeof(a.chat_id) = 'text'
         AND a.chat_id = ${executionChatId}
         AND typeof(a.run_id) = 'text'
         AND a.run_id = ${executionGenerationId}
         AND typeof(a.turn_id) = 'text'
         AND a.turn_id = ${executionId}
         AND typeof(a.generation_id) = 'text'
         AND a.generation_id = ${executionGenerationId}
         AND typeof(a.generation_type) = 'text'
         AND a.generation_type = ${executionTargetKind}
         AND (
           (a.target_message_id IS NULL AND ${executionTargetMessageId} IS NULL)
           OR (typeof(a.target_message_id) = 'text' AND a.target_message_id IS ${executionTargetMessageId})
         )
         AND (
           (a.target_swipe_id IS NULL AND ${executionTargetSwipeId} IS NULL)
           OR (typeof(a.target_swipe_id) IN ('integer', 'real') AND a.target_swipe_id IS ${executionTargetSwipeId})
         )
         AND typeof(a.status) = 'text'
         AND a.status = 'terminal'
         AND typeof(a.terminal) IN ('integer', 'real')
         AND a.terminal = 1
         AND typeof(a.reconciliation_state) = 'text'
         AND a.reconciliation_state IN ('authoritative', 'recovered')
         AND typeof(a.outcome) = 'text'
         AND lower(trim(a.outcome, ${SQL_ECMASCRIPT_TRIM_CHARACTERS})) = ${expectedOutcome}
         AND typeof(a.reason) = 'text'
         AND ${exactReason}
         AND typeof(p.user_id) = 'text'
         AND typeof(p.chat_id) = 'text'
         AND p.chat_id = ${executionChatId}
         AND typeof(p.turn_id) = 'text'
         AND typeof(p.generation_id) = 'text'
         AND p.generation_id = ${executionGenerationId}
         AND typeof(p.generation_type) = 'text'
         AND p.generation_type = ${executionTargetKind}
         AND (
           (p.target_message_id IS NULL AND ${executionTargetMessageId} IS NULL)
           OR (typeof(p.target_message_id) = 'text' AND p.target_message_id IS ${executionTargetMessageId})
         )
         AND (
           (p.target_swipe_id IS NULL AND ${executionTargetSwipeId} IS NULL)
           OR (typeof(p.target_swipe_id) IN ('integer', 'real') AND p.target_swipe_id IS ${executionTargetSwipeId})
         )
         AND typeof(p.status) = 'text'
         AND p.status = ${phase}
         AND typeof(p.snapshot_json) = 'text'
         AND json_valid(p.snapshot_json)
         AND json_type(${projectionSnapshot}) = 'object'
         AND json_extract(${projectionSnapshot}, '$.workOutcome') = ${expectedOutcome}
    )
  )`;
}
/**
 * Build a keyset-paginated candidate scan. Reversible and COMMITTING rows are
 * always candidates. Retained noncommitted terminal history enters the bounded
 * budget only while its private inspection or public projection needs repair;
 * COMMITTED rows remain receipt-repaired only while retained.
 */
function reconciliationCandidateQuery(db: Database, now: number): {
  readonly sql: string;
  readonly phaseValues: readonly TurnExecutionPhase[];
  readonly orderedAtSql: string;
} | null {
  const executionColumns = tableColumns(db, "agent_turn_executions");
  const phase = orderedTextColumnSql("e", executionColumns, "phase", "state");
  const orderedValue = orderedNumberColumnSql("e", executionColumns, "created_at", "updated_at");
  const id = orderedTextColumnSql("e", executionColumns, "id", "execution_id");
  if (!phase || !orderedValue || !id) return null;

  const orderedAt = `COALESCE(${orderedValue}, 0)`;
  const retainedTerminal = executionColumns.has("expires_at")
    ? `(typeof(e.${quoteColumn("expires_at")}) NOT IN ('integer', 'real')
        OR e.${quoteColumn("expires_at")} <= 0
        OR e.${quoteColumn("expires_at")} > ${now})`
    : "CAST(1 AS INTEGER)";
  const phaseValues = [...REVERSIBLE_TURN_PHASES, "COMMITTING"] as const;
  const terminalEventColumn = firstColumn(executionColumns, "terminal_event_id", "terminal_event_key");
  const terminalEventNeedsConvergence = terminalEventColumn
    ? `(typeof(e.${quoteColumn(terminalEventColumn)}) <> 'text' OR e.${quoteColumn(terminalEventColumn)} = '')`
    : "CAST(0 AS INTEGER)";
  const terminalRecoveryAvailable = terminalRecoveryTablesAvailable(db);
  const terminalRepairPhases = terminalRecoveryAvailable
    ? NONCOMMITTED_TERMINAL_PHASES.map((value) => `'${value}'`).join(", ")
    : "";
  const exactTerminal = terminalRecoveryAvailable
    ? exactTerminalReconciliationPredicate(db, executionColumns, phase, id)
    : null;
  const terminalRepairPredicate = exactTerminal
    ? `(${retainedTerminal} AND ${phase} IN (${terminalRepairPhases}) AND NOT ${exactTerminal})`
    : `(${retainedTerminal} AND ${phase} IN (${terminalRepairPhases}))`;
  const candidatePredicates = [
    `${phase} IN (${phaseValues.map(() => "?").join(", ")})`,
    ...(terminalRecoveryAvailable ? [terminalRepairPredicate] : []),
  ];
  const priorityPredicates: string[] = [];

  if (hasTable(db, "agent_run_projections")
    && hasTable(db, "agent_chat_events")
    && hasTable(db, "agent_turn_commit_receipts")) {
    const receiptColumns = tableColumns(db, "agent_turn_commit_receipts");
    const receiptMatches: string[] = [];
    for (const keyColumn of ["execution_id", "turn_id"] as const) {
      if (receiptColumns.has(keyColumn)) {
        receiptMatches.push(`r.${quoteColumn(keyColumn)} = ${id}`);
      }
    }
    if (receiptColumns.has("commit_key") && executionColumns.has("commit_key")) {
      receiptMatches.push(`r.${quoteColumn("commit_key")} = e.${quoteColumn("commit_key")}`);
    }
    if (receiptMatches.length > 0) {
      const receiptExists = `
        EXISTS (
          SELECT 1
            FROM agent_turn_commit_receipts AS r
           WHERE ${receiptMatches.join(" OR ")}
        )`;
      const projectionNeedsRepair = `
        NOT EXISTS (
          SELECT 1
            FROM agent_run_projections AS p
           WHERE p.user_id = e.user_id
             AND p.chat_id = e.chat_id
             AND p.turn_id = ${id}
        )
        OR EXISTS (
          SELECT 1
            FROM agent_run_projections AS p
           WHERE p.user_id = e.user_id
             AND p.chat_id = e.chat_id
             AND p.turn_id = ${id}
             AND (
               COALESCE(p.status, '') <> 'COMMITTED'
               OR NOT EXISTS (
                 SELECT 1
                   FROM agent_chat_events AS event
                  WHERE event.user_id = p.user_id
                    AND event.chat_id = p.chat_id
                    AND event.turn_id = p.turn_id
                    AND event.sequence = p.sequence
                    AND event.run_revision = p.revision
                    AND event.event_kind = 'terminal'
               )
             )
        )`;
      const committedRepair = `(
        ${retainedTerminal}
        AND ${phase} = 'COMMITTED'
        AND ${receiptExists}
        AND ((${projectionNeedsRepair}) OR ${terminalEventNeedsConvergence})
      )`;
      candidatePredicates.push(committedRepair);
      priorityPredicates.push(`(${phase} = 'COMMITTING' AND ${receiptExists})`);
      priorityPredicates.push(committedRepair);
    }
  }

  const priority = priorityPredicates.length > 0
    ? `(CASE WHEN ${priorityPredicates.join(" OR ")} THEN 0 ELSE 1 END)`
    : "CAST(1 AS INTEGER)";
  return {
    sql: `
      SELECT e.*,
             ${priority} AS __reconciliation_priority,
             ${orderedAt} AS __reconciliation_ordered_at,
             ${id} AS __reconciliation_id
        FROM ${quoteColumn("agent_turn_executions")} AS e
       WHERE (${candidatePredicates.join(" OR ")})
         AND ${orderedAt} <= ?
         AND (
           ${priority} > ?
           OR (${priority} = ? AND (
             ${orderedAt} > ?
             OR (${orderedAt} = ? AND ${id} > ?)
           ))
         )
       ORDER BY ${priority} ASC, ${orderedAt} ASC, ${id} ASC
       LIMIT ?
    `,
    phaseValues,
    orderedAtSql: orderedAt,
  };
}
function reconciliationFailureCode(error: unknown): string {
  if (error instanceof TurnExecutionError) return error.code
  if (error instanceof Error && error.name.length > 0) return error.name
  return "unknown"
}

type TurnReconciliationFailure = {
  readonly phase: TurnExecutionPhase | "scan"
  readonly code: string
  readonly message: string | null
  count: number
}
/**
 * Reconcile one already-terminal Agentic turn by exact owner and execution ID.
 * Generic Stop uses this after a live terminal publication fault; it never
 * claims or advances a reversible execution and never replays provider work.
 */
export function reconcileTerminalAgentTurn(
  executionId: string,
  userId: string,
  db: Database = getDb(),
): boolean {
  const execution = getTurnExecution(executionId, userId, db);
  if (!execution || !TERMINAL_PHASE_SET.has(execution.phase)) return false;
  if (execution.phase === "COMMITTED") {
    const receiptRow = rawReceipt(db, execution);
    if (!receiptRow) return false;
    const receipt = receiptFromRow(receiptRow, execution, { allowHistoricalTarget: true, db });
    const historicalTargetRedaction = execution.targetMessageId !== receipt.messageId
      || execution.targetSwipeId !== receipt.swipeId;
    db.transaction(() => {
      const latest = requireExecution(db, execution.id).execution;
      if (
        latest.userId !== execution.userId
        || latest.chatId !== execution.chatId
        || latest.generationId !== execution.generationId
        || latest.attemptLineage.attemptId !== execution.attemptLineage.attemptId
        || latest.phase !== execution.phase
        || latest.casRevision !== execution.casRevision
      ) {
        throw new TurnExecutionError("stale_execution", "terminal execution changed during exact recovery", {
          executionId,
          phase: execution.phase,
        });
      }
      reconcileCommittedPersistentSession(db, latest);
      invokeReceiptRepair(
        normalizedReceiptExecution(db, latest, receipt),
        receipt,
        historicalTargetRedaction ? { historicalTargetRedaction: true } : undefined,
      );
      markCommittedTerminalConvergence(db, latest);
    })();
    return true;
  }
  if (!isNoncommittedTerminalPhase(execution.phase) || !terminalRecoveryTablesAvailable(db)) return false;
  reconcileTerminalExecutionProjection(db, execution);
  return true;
}

/**
 * Startup reconciliation is bounded and receipt-free for every noncommitted
 * terminal row. It never invokes a provider, renderer, tool, workspace mutator,
 * or generation callback; committed rows remain receipt-repaired only.
 */
export function reconcileAgentTurns(db: Database = getDb()): ReconcileAgentTurnsResult {
  const result: {
    runtimeEpoch: number;
    inspected: number;
    claimed: number;
    failedInterrupted: number;
    committedFromReceipt: number;
    commitFailedWithoutReceipt: number;
    projectionRepairs: number;
    alreadyTerminal: number;
    releasedReservations: number;
    complete: boolean;
  } = {
    runtimeEpoch,
    inspected: 0,
    claimed: 0,
    failedInterrupted: 0,
    committedFromReceipt: 0,
    commitFailedWithoutReceipt: 0,
    projectionRepairs: 0,
    alreadyTerminal: 0,
    releasedReservations: 0,
    complete: true,
  };
  const failures = new Map<string, TurnReconciliationFailure & { executionIds: string[] }>()
  const noteFailure = (phase: TurnExecutionPhase | "scan", error: unknown, executionId?: string): void => {
    const code = reconciliationFailureCode(error)
    const message = error instanceof Error && error.message.length > 0
      ? error.message.replace(/\s+/g, " ").slice(0, 256)
      : null
    const key = phase + ":" + code + ":" + (message ?? "")
    const current = failures.get(key)
    if (current) {
      current.count += 1
      if (executionId && current.executionIds.length < 3) current.executionIds.push(executionId)
      return
    }
    failures.set(key, { phase, code, message, count: 1, executionIds: executionId ? [executionId] : [] })
  }
  const finish = (): ReconcileAgentTurnsResult => {
    if (failures.size > 0) {
      console.error("[Agentic] Turn reconciliation incomplete", {
        failures: [...failures.values()],
      })
    }
    return result
  }
  if (!hasTable(db, "agent_turn_executions")) return result;
  const scanStartedAt = reconciliationNowMs();
  const scan = reconciliationCandidateQuery(db, scanStartedAt);
  if (!scan) return result;

  // Freeze the upper bound from the durable population rather than the wall
  // clock. Rapid inserts can legitimately carry timestamps just ahead of the
  // clock observed at the start of this pass.
  const scanUpperBound = (() => {
    try {
      const row = db.query(
        `SELECT MAX(${scan.orderedAtSql}) AS max_ordered_at
           FROM ${quoteColumn("agent_turn_executions")} AS e`,
      ).get() as Record<string, unknown> | null;
      return (row ? rowNumber(row, "max_ordered_at") : null) ?? scanStartedAt;
    } catch {
      return scanStartedAt;
    }
  })();
  const scanDeadline = scanStartedAt + AGENT_TURN_RECONCILIATION_MAX_MS;
  const now = scanStartedAt;
  let remainingRows = AGENT_TURN_RECONCILIATION_MAX_ROWS;
  let cursorPriority = -1;
  let cursorUpdatedAt = 0;
  let cursorId = "";
  for (;;) {
    if (remainingRows <= 0 || reconciliationNowMs() >= scanDeadline) {
      result.complete = false;
      noteFailure("scan", new Error("scan_limit"));
      break;
    }
    const pageLimit = Math.min(AGENT_TURN_RECONCILIATION_PAGE_SIZE, remainingRows);
    const rows = db.query(scan.sql).all(
      ...scan.phaseValues,
      scanUpperBound,
      cursorPriority,
      cursorPriority,
      cursorUpdatedAt,
      cursorUpdatedAt,
      cursorId,
      pageLimit,
    ) as Array<Record<string, unknown>>;
    if (rows.length === 0) break;
    remainingRows -= rows.length;
    result.inspected += rows.length;
    for (const raw of rows) {
      if (reconciliationNowMs() >= scanDeadline) {
        result.complete = false
        noteFailure("scan", new Error("scan_deadline"))
        return finish()
      }
      let current: TurnExecutionRecord;
      try {
        current = recordFromRow(raw);
      } catch (error) {
        result.complete = false
        noteFailure("scan", error)
        continue
      }
      if (TERMINAL_PHASE_SET.has(current.phase)) {
        result.alreadyTerminal++;
        if (current.phase === "COMMITTED" && receiptRepairHandler) {
          const receiptRaw = rawReceipt(db, current);
          if (receiptRaw) {
            const receipt = receiptFromRow(receiptRaw, current, {
              allowHistoricalTarget: true,
              db,
            });
            const historicalTargetRedaction = current.targetMessageId !== receipt.messageId
              || current.targetSwipeId !== receipt.swipeId;
            const needsRepair = projectionNeedsReceiptRepair(db, current);
            try {
              db.transaction(() => {
                const latest = requireExecution(db, current.id).execution;
                reconcileCommittedPersistentSession(db, latest);
                invokeReceiptRepair(
                  normalizedReceiptExecution(db, latest, receipt),
                  receipt,
                  historicalTargetRedaction ? { historicalTargetRedaction: true } : undefined,
                );
                markCommittedTerminalConvergence(db, latest);
              })();
              if (needsRepair && !projectionNeedsReceiptRepair(db, current)) {
                result.projectionRepairs++;
              }
            } catch (error) {
              result.complete = false
              noteFailure(current.phase, error, current.id)
              // Receipt-backed repair remains pending for the next startup
              // epoch. The committed phase and receipt stay authoritative.
            }
          }
        } else if (isNoncommittedTerminalPhase(current.phase)) {
          try {
            if (terminalRecoveryTablesAvailable(db)) {
              const adopted = adoptPublishedTerminalAuthority(db, current, current.casOwner, now);
              const execution = adopted ?? current;
              if (reconcileTerminalExecutionProjection(db, execution)) result.projectionRepairs++;
            } else {
              invokeTerminalRecovery(current, current.phase === "COMMIT_FAILED" ? "COMMIT_FAILED" : "FAILED");
            }
          } catch (error) {
            result.complete = false
            noteFailure(current.phase, error, current.id)
            // The terminal execution row is the durable repair authority. A
            // failed inspection/projection transaction remains queryable for
            // the next bounded startup pass.
          }
        }
        continue;
      }
      if (current.phase === "WORK" && hasTable(db, "agent_work_segment_recovery")) {
        let segmentFence: WorkSegmentRecoveryFence;
        try {
          segmentFence = workSegmentRecoveryFence(db, current);
        } catch (error) {
          result.complete = false;
          noteFailure("WORK", error, current.id);
          continue;
        }
        if (segmentFence.kind === "pending") {
          result.complete = false;
          noteFailure("WORK", new Error(segmentFence.reason), current.id);
          // The specialized V1 recovery drain owns both active segments and a
          // closed work-complete handoff. Generic interruption must wait until
          // that drain advances or terminalizes the Turn Execution.
          continue;
        }
        if (segmentFence.kind === "terminal") {
          const terminalFence = segmentFence;
          try {
            let outcome: TransitionTurnExecutionResult | undefined;
            db.transaction(() => {
              const latest = requireExecution(db, current.id).execution;
              if (latest.phase !== "WORK" || latest.casRevision !== current.casRevision) {
                throw new TurnExecutionError("stale_execution", "WORK execution changed before terminal close convergence", {
                  executionId: current.id,
                  phase: latest.phase,
                });
              }
              const latestFence = workSegmentRecoveryFence(db, latest);
              if (latestFence.kind !== "terminal"
                || latestFence.phase !== terminalFence.phase
                || latestFence.reason !== terminalFence.reason) {
                throw invalidWorkSegmentRecovery(latest, "terminal WORK close authority changed before convergence");
              }
              const settled = terminalizeWithCancellationMarkerFence(
                db,
                latest,
                latest.casOwner,
                terminalFence.phase,
                terminalFence.reason,
                now,
              );
              outcome = settled.outcome;
              if (!settled.markerCause
                && (outcome.execution.phase !== terminalFence.phase
                  || outcome.execution.terminalCode !== terminalCodeFor(terminalFence.phase, terminalFence.reason))) {
                throw invalidWorkSegmentRecovery(outcome.execution, "terminal WORK close lost its typed Turn Execution cause");
              }
            })();
            if (!outcome) {
              throw invalidWorkSegmentRecovery(current, "terminal WORK close convergence produced no Turn Execution");
            }
            try {
              if (terminalRecoveryTablesAvailable(db)
                && reconcileTerminalExecutionProjection(db, outcome.execution)) {
                result.projectionRepairs++;
              }
            } catch (error) {
              result.complete = false;
              noteFailure(terminalFence.phase, error, current.id);
            }
            if (current.finalRenderReservationKey) result.releasedReservations++;
          } catch (error) {
            result.complete = false;
            noteFailure("WORK", error, current.id);
          }
          continue;
        }
      }
      const ownerToken = randomId("reconcile");
      const claimed = claimForReconciliation(db, current, ownerToken, now);
      if (!claimed) {
        result.complete = false;
        noteFailure(current.phase, new Error("claim_failed"), current.id);
        continue;
      }
      result.claimed++;
      if (REVERSIBLE_PHASE_SET.has(claimed.phase)) {
        try {
          const adopted = adoptPublishedTerminalAuthority(db, claimed, ownerToken, now);
          if (adopted) {
            try {
              if (terminalRecoveryTablesAvailable(db)) {
                if (reconcileTerminalExecutionProjection(db, adopted)) result.projectionRepairs++;
              }
            } catch (error) {
              result.complete = false
              noteFailure(claimed.phase, error, claimed.id)
            }
            if (claimed.finalRenderReservationKey) result.releasedReservations++;
            continue;
          }
          const interruptionCause = claimed.cancelRequested
            ? cancellationTerminalCause(claimed.cancelRequestedAt ?? claimed.updatedAt, claimed.deadlineAt)
            : null;
          const terminalPhase: TerminalTurnPhase = interruptionCause?.phase ?? "FAILED";
          const terminalReason = interruptionCause?.reason ?? "process_interrupted";
          let outcome: TransitionTurnExecutionResult | undefined;
          db.transaction(() => {
            outcome = interruptionCause
              ? terminalizeWithCancellationMarkerFence(
                  db,
                  claimed,
                  ownerToken,
                  interruptionCause.phase,
                  interruptionCause.reason,
                  now,
                ).outcome
              : terminalizeWithCas(
                  db,
                  claimed,
                  ownerToken,
                  claimed.phase,
                  claimed.casRevision,
                  terminalPhase,
                  terminalReason,
                  now,
                );
          })();
          if (outcome?.terminalEventEmitted) {
            try {
              if (terminalRecoveryTablesAvailable(db)) {
                if (terminalPhase === "FAILED") invokeTerminalRecovery(outcome.execution, "FAILED");
                if (reconcileTerminalExecutionProjection(db, outcome.execution)) result.projectionRepairs++;
              } else if (terminalPhase === "FAILED") {
                invokeTerminalRecovery(outcome.execution, "FAILED");
              }
            } catch (error) {
              result.complete = false
              noteFailure(claimed.phase, error, claimed.id)
            }
            if (terminalPhase === "FAILED") result.failedInterrupted++;
          }
          if (claimed.finalRenderReservationKey) result.releasedReservations++;
        } catch (error) {
          result.complete = false
          noteFailure(claimed.phase, error, claimed.id)
          // A concurrent owner or terminal projection failure leaves the
          // durable row for the next epoch without replaying work.
        }
        continue;
      }
      if (claimed.phase !== "COMMITTING") {
        result.complete = false;
        noteFailure(claimed.phase, new Error("unsupported_phase"), claimed.id);
        continue;
      }
      const receiptRaw = rawReceipt(db, claimed);
      if (receiptRaw) {
        const receipt = receiptFromRow(receiptRaw, claimed);
        const needsRepair = projectionNeedsReceiptRepair(db, claimed);
        try {
          db.transaction(() => {
            const latest = requireExecution(db, claimed.id).execution;
            const repaired = repairCommittedFromReceipt(db, latest, receipt, ownerToken, now, false);
            reconcileCommittedPersistentSession(db, repaired);
            invokeReceiptRepair(repaired, receipt);
            markCommittedTerminalConvergence(db, repaired, now);
          })();
          result.committedFromReceipt++;
          if (needsRepair && !projectionNeedsReceiptRepair(db, claimed)) {
            result.projectionRepairs++;
          }
          if (claimed.finalRenderReservationKey) result.releasedReservations++;
        } catch (error) {
          result.complete = false
          noteFailure(claimed.phase, error, claimed.id)
          // Keep the receipt and COMMITTING row for a later lease epoch. Do not
          // mark COMMIT_FAILED merely because a derived projection is delayed.
        }
      } else {
        try {
          let outcome: TransitionTurnExecutionResult | undefined;
          db.transaction(() => {
            outcome = terminalizeWithCas(
              db,
              claimed,
              ownerToken,
              claimed.phase,
              claimed.casRevision,
              "COMMIT_FAILED",
              "process_interrupted",
              now,
            );
          })();
          if (outcome?.terminalEventEmitted) {
            try {
              if (terminalRecoveryTablesAvailable(db)) {
                invokeTerminalRecovery(outcome.execution, "COMMIT_FAILED");
                if (reconcileTerminalExecutionProjection(db, outcome.execution)) result.projectionRepairs++;
              } else {
                invokeTerminalRecovery(outcome.execution, "COMMIT_FAILED");
              }
            } catch (error) {
              result.complete = false
              noteFailure(claimed.phase, error, claimed.id)
            }
            result.commitFailedWithoutReceipt++;
          }
          if (claimed.finalRenderReservationKey) result.releasedReservations++;
        } catch (error) {
          result.complete = false
          noteFailure(claimed.phase, error, claimed.id)
          // Another owner or terminal projection failure leaves the durable
          // row for the next epoch without replaying work.
        }
      }
    }
    const lastRow = rows[rows.length - 1]!;
    const nextPriority = rowNumber(lastRow, "__reconciliation_priority") ?? cursorPriority;
    const nextUpdatedAt = rowNumber(lastRow, "__reconciliation_ordered_at") ?? cursorUpdatedAt;
    const nextId = rowString(lastRow, "__reconciliation_id")
      ?? rowString(lastRow, "id", "execution_id")
      ?? cursorId;
    if (nextPriority < cursorPriority
      || nextPriority === cursorPriority && (
        nextUpdatedAt < cursorUpdatedAt
        || nextUpdatedAt === cursorUpdatedAt && nextId <= cursorId
      )) {
      result.complete = false;
      noteFailure("scan", new Error("cursor_stalled"));
      break;
    }
    cursorPriority = nextPriority;
    cursorUpdatedAt = nextUpdatedAt;
    cursorId = nextId;
    if (rows.length < pageLimit) break;
    if (remainingRows <= 0 || reconciliationNowMs() >= scanDeadline) {
      result.complete = false;
      noteFailure("scan", new Error("scan_limit"));
      break;
    }
  }
  return finish()
}

export const reconcileTurnExecutions = reconcileAgentTurns;

export const TURN_EXECUTION_RECONCILIATION = Object.freeze({
  reversible: REVERSIBLE_TURN_PHASES,
  committingWithReceipt: "COMMITTED" as const,
  committingWithoutReceipt: "COMMIT_FAILED" as const,
  providerReplay: false,
  renderReplay: false,
  sideEffectReplay: false,
  pageSize: AGENT_TURN_RECONCILIATION_PAGE_SIZE,
  maxRows: AGENT_TURN_RECONCILIATION_MAX_ROWS,
  maxDurationMs: AGENT_TURN_RECONCILIATION_MAX_MS,
});
