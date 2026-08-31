import type { Database } from "bun:sqlite";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { env } from "../env";
import { getDb } from "../db/connection";
import { eventBus, type BufferedEvent } from "../ws/bus";
import { EventType } from "../ws/events";
import {
  persistAgentRunInspectionInTransaction,
  persistTerminalAgentActivityRunInTransaction,
  type PersistAgentActivityRunInput,
  type PersistAgentRunInspectionInputV1,
} from "./agent-activity-runs.service";
import {
  AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1,
  requestDormantTurnCancellation,
  reconcileTerminalAgentTurn,
  type TurnCancellationResult,
  type TurnCommitReceipt,
  type TurnExecutionRecord,
} from "./turn-execution.service";
import * as generationPool from "./generation-pool.service";
import {
  AGENT_PUBLIC_ERROR_CODES,
  type AgentPublicErrorCategory,
  type AgentPublicErrorCode,
  type AgentRecoveryActionV2,
} from "../types/agent-runtime";

import type {
  AgentActivityNodeV2,
  AgentActivityNodeKindV2,
  AgentActivityNodeActorV2,
  AgentActivityNodeStatusV2,
  AgentActivityUsageV2,
  AgentOmissionMarkerV2,
  AgentRunChangeEventV2,
  AgentRunChangesV2,
  AgentRunPublicErrorV2,
  AgentRunGenerationTypeV1,
  AgentRunPublicPhaseV2,
  AgentRunPublicOutcomeV2,
  AgentRunPublicStatusV2,
  AgentRunPublicV2,
  AgentRunStopResponseV2,
  AgentRunStopResultV2,
  AgentRunTargetV1,
  AgentTerminalHandoffV2,
  AgentWorkAttemptLineageV1,
  AgentWorkTargetIdentityV1,
  AgentWorkspaceEntryPreviewV2,
  AgentWorkspaceIndexV2,
  AgentWorkspacePreviewV2,
  AgentWorkspaceRetentionV2,
  AgentWorkspaceSectionIdV2,
  AgentWorkspaceVisibilityV2,
  ChatRunCursorV1,
} from "../types/agent-run-projection";
const AGENT_RUN_CHANGED = "AGENT_RUN_CHANGED" as EventType;

const encoder = new TextEncoder();
const MAX_ID_BYTES = 256;
const MAX_NODE_ID_BYTES = 256;
const MAX_PROFILE_BYTES = 128;
const MAX_TOOL_BYTES = 128;
const MAX_NODES = 128;
const MAX_EVENTS = 128;
const MAX_RUNS = 16;
const MAX_RESYNC_RUNS = 256;
const MAX_RESYNC_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVE_RESYNC_SNAPSHOTS_PER_OWNER = 16;
const MAX_ACTIVE_RESYNC_BYTES_PER_OWNER = 64 * 1024 * 1024;
const MAX_WORKSPACE_ENTRIES = 64;
const MAX_CURSOR_BYTES = 2048;
const CURSOR_TTL_SECONDS = 5 * 60;
const RESYNC_SNAPSHOT_TTL_SECONDS = CURSOR_TTL_SECONDS;
const MAX_SAFE_COUNTER = Number.MAX_SAFE_INTEGER;
const MAX_RECONCILIATION_ROWS = 256;
const SWIPE_EXPIRY_THRESHOLD = 100_000_000_000;
const TERMINAL_OUTBOX_LEASE_SECONDS = 30;
const TERMINAL_OUTBOX_PROCESS_ID = randomUUID();
const MAX_EMITTED_EVENT_KEYS = 2048;
const MAX_OUTBOX_REPLAY_BATCHES = 256;

function expiryToMilliseconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  // Execution rows use milliseconds. Accept legacy second-based rows as well:
  // values below this threshold cannot represent a contemporary millisecond
  // timestamp and are interpreted as Unix seconds.
  return value < SWIPE_EXPIRY_THRESHOLD ? value * 1000 : value;
}

function isExpiredAt(value: unknown, now = Date.now()): boolean {
  const expiresAt = expiryToMilliseconds(value);
  return expiresAt !== null && expiresAt <= now;
}

function executionVisibilitySql(alias: string): string {
  return `(
    ${alias}.expires_at IS NULL
    OR typeof(${alias}.expires_at) NOT IN ('integer', 'real')
    OR ${alias}.expires_at != CAST(${alias}.expires_at AS INTEGER)
    OR ${alias}.expires_at <= 0
    OR CASE
      WHEN ${alias}.expires_at < ${SWIPE_EXPIRY_THRESHOLD} THEN ${alias}.expires_at * 1000
      ELSE ${alias}.expires_at
    END > ?
  )`;
}

function isSafeResyncCursorNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
type StoredRunState =
  | "ASSEMBLE"
  | "WORK"
  | "COMPLETE"
  | "RENDER"
  | "PREPARE_COMMIT"
  | "COMMITTING"
  | "COMMITTED"
  | "COMMIT_FAILED"
  | "EXHAUSTED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

const STORED_STATES = new Set<StoredRunState>([
  "ASSEMBLE", "WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING",
  "COMMITTED", "COMMIT_FAILED", "EXHAUSTED", "FAILED", "CANCELLED", "TIMED_OUT",
]);
const LEGACY_STATE_MAP: Readonly<Record<string, StoredRunState>> = Object.freeze({
  queued: "ASSEMBLE",
  running: "WORK",
  completed: "COMMITTED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  timed_out: "TIMED_OUT",
});
const GENERATION_TYPES = new Set<AgentRunGenerationTypeV1>([
  "normal", "continue", "regenerate", "swipe",
]);
const TERMINAL_STATES = new Set<StoredRunState>([
  "COMMITTED", "COMMIT_FAILED", "EXHAUSTED", "FAILED", "CANCELLED", "TIMED_OUT",
]);

const PUBLIC_ERROR_CODES: ReadonlySet<AgentPublicErrorCode> = new Set(AGENT_PUBLIC_ERROR_CODES);
const TOO_LATE_STATES = new Set<StoredRunState>(["COMMITTING", "COMMITTED"]);
const NODE_KINDS = new Set<AgentActivityNodeKindV2>(["root", "provider", "child", "tool"]);
const NODE_ACTORS = new Set<AgentActivityNodeActorV2>(["root", "provider", "child", "tool"]);
const NODE_STATUSES = new Set<AgentActivityNodeStatusV2>([
  "pending", "running", "completed", "failed", "cancelled", "timed_out", "omitted",
]);
const WORKSPACE_SECTIONS: readonly AgentWorkspaceSectionIdV2[] = [
  "objective", "tasks", "records", "submissions", "artifacts",
];
const RETENTIONS = new Set<AgentWorkspaceRetentionV2>([
  "operational", "turn_terminal", "chat_lifetime",
]);

export interface AgentRunProjectionInputV2 {
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly generationId: string;
  readonly generationType: AgentRunGenerationTypeV1;
  readonly targetMessageId?: string | null;
  readonly targetSwipeId?: number | null;
  readonly attemptLineage?: Partial<AgentWorkAttemptLineageV1> | null;
  /** Private durable state compatibility; public callers use work* fields. */
  readonly status?: StoredRunState;
  readonly phase?: StoredRunState;
  readonly workPhase?: AgentRunPublicPhaseV2;
  readonly workStatus?: AgentRunPublicStatusV2;
  readonly workOutcome?: AgentRunPublicOutcomeV2 | null;
  readonly reason?: unknown;
  readonly error?: {
    readonly code?: unknown;
    readonly category?: unknown;
    readonly summaryCode?: unknown;
    readonly recoveryEligible?: unknown;
    readonly recoveryAction?: unknown;
    readonly target?: unknown;
    readonly workPhase?: unknown;
    readonly workStatus?: unknown;
    readonly workOutcome?: unknown;
    readonly reason?: unknown;
    readonly omissionCount?: unknown;
    readonly inspectionAttemptId?: unknown;
    /** Legacy input compatibility only; never emitted in V2. */
    readonly retryable?: unknown;
  } | null;
  readonly revision?: number;
  readonly startedAt?: number;
  readonly updatedAt?: number;
  readonly activity?: unknown;
  readonly usage?: unknown;
  readonly terminalHandoff?: Partial<AgentTerminalHandoffV2> | null;
  readonly omission?: Partial<AgentOmissionMarkerV2> | null;
  /** Durable commit receipt identity used to authenticate receipt-owned repair. */
  readonly receiptId?: string;
  /** Optional already-redacted V1 activity input for compatibility storage. */
  readonly compatibilitySnapshot?: unknown;
  readonly receiptRepair?: boolean;
  readonly recoveryRepair?: boolean;
  /** One-time, exact-shape recovery for known premature FAILED→rejected writer defects. */
  readonly terminalRejectedOutcomeRepair?: boolean;
  /** Write a terminal public projection without inspecting/rewriting an already-exact inspection. */
  readonly preserveTerminalInspection?: boolean;
}
type AgentRunNormalizationInputV2 = Omit<
  AgentRunProjectionInputV2,
  "targetMessageId" | "targetSwipeId" | "attemptLineage" | "terminalHandoff" | "omission"
> & {
  readonly targetMessageId?: unknown;
  readonly targetSwipeId?: unknown;
  readonly attemptLineage?: unknown;
  readonly terminalHandoff?: unknown;
  readonly omission?: unknown;
};

export interface AgentRunReceiptRepairOptions {
  readonly reason?: string | null;
  readonly error?: AgentRunProjectionInputV2["error"];
  /**
   * Explicit startup-recovery authority for redacting a historical target
   * that no longer exists in the message's durable swipe set.
   */
  readonly historicalTargetRedaction?: true;
}


export interface AgentRunProjectionCommitResult {
  readonly run: AgentRunPublicV2;
  readonly sequence: number;
  readonly revision: number;
  readonly event: BufferedEvent;
  readonly changed?: boolean;
}

interface StoredProjectionRow {
  readonly user_id: string;
  readonly chat_id: string;
  readonly turn_id: string;
  readonly generation_id: string;
  readonly generation_type: string;
  readonly target_message_id: string | null;
  readonly target_swipe_id: number | null;
  readonly status: string;
  readonly phase: string;
  readonly revision: number;
  readonly sequence: number;
  readonly started_at: number;
  readonly updated_at: number;
  readonly snapshot_json: string;
  readonly terminal_handoff_json: string | null;
  readonly omission_json: string;
}

interface StoredEventRow {
  readonly sequence: number;
  readonly turn_id: string;
  readonly run_revision: number;
  readonly status: string;
  readonly snapshot_json: string;
  readonly terminal_handoff_json: string | null;
  readonly omission_json: string;
}

interface CursorClaims {
  readonly v: 1;
  readonly u: string;
  readonly c: string;
  readonly s: number;
  readonly e: number;
  /** Full-resync run-page offset. Presence keeps the token in resync mode. */
  readonly p?: number;
  /** Owner/chat-scoped persisted full-resync snapshot. */
  readonly r?: string;
  /** Stable member ordinal already consumed from the snapshot. */
  readonly q?: number;
}

export interface AgentRunStopContextV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly generationId: string;
}

export type AgentRunStopHandler = (context: AgentRunStopContextV1) => AgentRunStopResultV2;

/** Raised when durable cancellation cannot be proven for a nonterminal execution. */
export class AgentRunStopUnavailableError extends Error {
  readonly code = "live_cancellation_unavailable" as const;

  constructor(turnId: string) {
    super(`live cancellation handler is not registered for ${turnId}`);
    this.name = "AgentRunStopUnavailableError";
  }
}

interface StoredExecutionControlRow {
  readonly expires_at: number | null;
  readonly state?: string | null;
  readonly phase?: string | null;
  readonly cancel_requested_at?: number | bigint | null;
  readonly cancel_requested?: number | bigint | string | boolean | null;
  readonly cancellation_requested?: number | bigint | string | boolean | null;
  readonly cas_owner?: string | null;
  readonly lease_owner?: string | null;
  readonly owner_token?: string | null;
  readonly [key: string]: unknown;
}

const stopHandlers = new Map<string, AgentRunStopHandler>();

function boundedText(value: unknown, maxBytes = MAX_ID_BYTES): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return encoder.encode(value).byteLength <= maxBytes ? value : null;
}

interface AgentRunStopTransactionResult {
  readonly status: AgentRunStopResultV2;
  readonly revision: number;
  readonly event?: BufferedEvent;
  readonly changed?: boolean;
}
function safePublicErrorCode(value: unknown): AgentPublicErrorCode | undefined {
  if (typeof value !== "string") return undefined;
  const canonical = value === "requires_response_mode" ? "response_mode_required" : value;
  return PUBLIC_ERROR_CODES.has(canonical as AgentPublicErrorCode)
    ? canonical as AgentPublicErrorCode
    : undefined;
}
function publicErrorCategory(code: string): AgentPublicErrorCategory {
  if (
    code === "capacity_exceeded"
    || code.startsWith("host_")
    || code.endsWith("_admission_limit_exceeded")
    || code.endsWith("_tool_call_limit_exceeded")
    || code.endsWith("_dispatch_attempt_limit_exceeded")
    || code.endsWith("_execution_limit_exceeded")
    || code === "queue_full"
  ) return "capacity";
  if (
    code.includes("limit")
    || code.includes("budget")
    || code.endsWith("_bytes")
    || code.endsWith("_tokens")
    || code === "exhausted"
  ) return "budget";
  if (
    code.includes("context")
    || code.includes("input")
    || code.includes("argument")
    || code.includes("result")
    || code.includes("continuation")
    || code.includes("retained")
    || code.includes("materialized")
  ) return "context";
  if (code === "timeout" || code === "worker_timed_out") return "timeout";
  if (code === "cancelled" || code === "stopped") return "cancelled";
  if (code.startsWith("provider_") || code.startsWith("worker_")) return "provider";
  if (
    code.startsWith("invalid_")
    || code === "batch_rejected"
    || code === "unknown_tool"
    || code === "target_mismatch"
    || code === "stale_target"
    || code === "response_mode_required"
    || code === "decision_refresh_required"
    || code === "child_required_failed"
    || code === "agentic_protocol_failure"
  ) return "validation";
  return "internal";
}

function isRejectedErrorCode(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return [
    "invalid_input",
    "invalid_task",
    "invalid_profile",
    "invalid_arguments",
    "batch_rejected",
    "target_mismatch",
    "stale_target",
    "unknown_tool",
  ].includes(value);
}

function defaultErrorCodeForState(state: StoredRunState, terminalCode?: unknown, reason?: unknown): string | undefined {
  const explicit = safePublicErrorCode(terminalCode);
  if (explicit) return explicit;
  if (state === "CANCELLED") return "cancelled";
  if (state === "TIMED_OUT") return "timeout";
  if (state === "EXHAUSTED") return "limit_exceeded";
  if (state === "COMMIT_FAILED" || state === "FAILED") {
    return reason === "rejected" ? "invalid_input" : "internal_error";
  }
  return undefined;
}

function normalizeRecoveryAction(value: unknown): AgentRecoveryActionV2 | undefined {
  return value === "retry"
    || value === "repair"
    || value === "reselect"
    || value === "use_response"
    || value === "resync"
    || value === "none"
    ? value
    : undefined;
}

function recoveryForProjection(
  explicitEligible: unknown,
  explicitAction: unknown,
  code: string | undefined,
  outcome: AgentRunPublicOutcomeV2 | null,
  reason: string | null,
): { readonly recoveryEligible: boolean; readonly recoveryAction: AgentRecoveryActionV2 } {
  const action = normalizeRecoveryAction(explicitAction);
  if (action === "none") return { recoveryEligible: false, recoveryAction: "none" };
  if (action) {
    return {
      recoveryEligible: explicitEligible === false ? false : true,
      recoveryAction: explicitEligible === false ? "none" : action,
    };
  }
  if (explicitEligible === false) return { recoveryEligible: false, recoveryAction: "none" };
  if (code === "response_mode_required") {
    return { recoveryEligible: true, recoveryAction: "use_response" };
  }
  if (outcome === "rejected") {
    return {
      recoveryEligible: true,
      recoveryAction: code === "target_mismatch" || code === "stale_target" || code === "invalid_profile"
        ? "reselect" : "repair",
    };
  }
  if (outcome === "failed" || outcome === "exhausted" || outcome === "stopped") {
    return { recoveryEligible: true, recoveryAction: "retry" };
  }
  if (reason === "needs_attention" || reason === "interrupted") {
    return { recoveryEligible: true, recoveryAction: "repair" };
  }
  return { recoveryEligible: false, recoveryAction: "none" };
}
function buildPublicError(
  code: string,
  target: AgentWorkTargetIdentityV1,
  workPhase: AgentRunPublicPhaseV2,
  workStatus: AgentRunPublicStatusV2,
  workOutcome: AgentRunPublicOutcomeV2 | null,
  reason: string | null,
  omission: AgentOmissionMarkerV2,
  inspectionAttemptId: string | null,
  explicitCategory?: unknown,
  explicitSummaryCode?: unknown,
  explicitEligible?: unknown,
  explicitAction?: unknown,
): AgentRunPublicErrorV2 {
  const normalizedCode = safePublicErrorCode(code) ?? "internal_error";
  const category = typeof explicitCategory === "string"
    && ["capacity", "budget", "context", "integrity", "timeout", "cancelled", "provider", "validation", "internal"].includes(explicitCategory)
    ? explicitCategory as AgentPublicErrorCategory
    : publicErrorCategory(normalizedCode);
  const summaryCode = typeof explicitSummaryCode === "string"
    && /^agentRun\.errors\.[A-Za-z0-9_.:-]{1,128}$/.test(explicitSummaryCode)
    ? explicitSummaryCode
    : `agentRun.errors.${normalizedCode}`;
  const recovery = recoveryForProjection(explicitEligible, explicitAction, normalizedCode, workOutcome, reason);
  const omissionCount = Math.min(
    MAX_SAFE_COUNTER,
    omission.omittedNodeCount + omission.omittedEventCount,
  );
  return {
    code: normalizedCode,
    category,
    summaryCode,
    recoveryEligible: recovery.recoveryEligible,
    recoveryAction: recovery.recoveryAction,
    target,
    workPhase,
    workStatus,
    workOutcome,
    reason,
    omissionCount,
    inspectionAttemptId,
  };
}



function boundedId(value: unknown, maxBytes = MAX_ID_BYTES): string | null {
  return boundedText(value, maxBytes);
}

function boundedCounter(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_COUNTER) {
    return fallback;
  }
  return value;
}

function coerceNonNegativeSafeInteger(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const numeric = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : Number.NaN;
}


function boundedBytesJson(value: unknown, maxBytes: number): string | null {
  try {
    const json = JSON.stringify(value);
    return encoder.encode(json).byteLength <= maxBytes ? json : null;
  } catch {
    return null;
  }
}

const WORK_PHASES = new Set<AgentRunPublicPhaseV2>([
  "ADMIT", "ASSEMBLE", "WORK", "PREPARE_COMMIT", "RENDER", "COMMIT", "TERMINAL",
]);
const WORK_STATUSES = new Set<AgentRunPublicStatusV2>([
  "pending", "running", "waiting", "cancelling", "terminal",
]);
const WORK_OUTCOMES = new Set<AgentRunPublicOutcomeV2>([
  "completed", "stopped", "failed", "exhausted", "rejected",
]);
type CanonicalTerminalCause = "stopped" | "exhausted" | "failed";

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAgentRunPublicPhase(value: unknown): value is AgentRunPublicPhaseV2 {
  return typeof value === "string" && WORK_PHASES.has(value as AgentRunPublicPhaseV2);
}

function isAgentRunPublicStatus(value: unknown): value is AgentRunPublicStatusV2 {
  return typeof value === "string" && WORK_STATUSES.has(value as AgentRunPublicStatusV2);
}

function isAgentRunPublicOutcome(value: unknown): value is AgentRunPublicOutcomeV2 {
  return typeof value === "string" && WORK_OUTCOMES.has(value as AgentRunPublicOutcomeV2);
}

function terminalCauseForCode(value: unknown): CanonicalTerminalCause | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase();
  if (!code) return null;
  if (["cancelled", "canceled", "stopped", "user_stop", "accepted_cancellation", "agentic_cancelled"].includes(code)) {
    return "stopped";
  }
  if (code === "root_wall_clock_limit_exceeded") return "failed";
  if (
    code === "exhausted"
    || code === "budget_exhausted"
    || code === "budget_exceeded"
    || code === "limit_exceeded"
    || code === "agentic_work_exhausted"
    || code.endsWith("_limit_exceeded")
    || code.endsWith("_budget_exhausted")
    || code.endsWith("_budget_exceeded")
  ) {
    return "exhausted";
  }
  return "failed";
}

function terminalCodeForInput(input: AgentRunNormalizationInputV2, existing?: AgentRunPublicV2): unknown {
  if (input.error !== undefined) {
    return input.error && typeof input.error === "object" ? input.error.code : undefined;
  }
  return existing?.error?.code;
}

function reasonCodeForInput(input: AgentRunNormalizationInputV2, existing?: AgentRunPublicV2): unknown {
  return input.reason === undefined ? existing?.reason : input.reason;
}


function normalizeStoredState(value: unknown): StoredRunState {
  if (typeof value === "string" && STORED_STATES.has(value as StoredRunState)) {
    return value as StoredRunState;
  }
  return typeof value === "string" ? LEGACY_STATE_MAP[value] ?? "FAILED" : "FAILED";
}

function storedStateFromCanonical(
  phase: AgentRunPublicPhaseV2 | null | undefined,
  status: AgentRunPublicStatusV2 | null | undefined,
  outcome: AgentRunPublicOutcomeV2 | null | undefined,
  reason: string | null | undefined,
  terminalCode?: unknown,
): StoredRunState {
  if (status === "terminal" || phase === "TERMINAL" || outcome !== null && outcome !== undefined) {
    const cause = terminalCauseForCode(terminalCode ?? reason);
    if (outcome === "completed") return "COMMITTED";
    if (outcome === "stopped") return cause === "failed" ? "FAILED" : "CANCELLED";
    if (outcome === "exhausted") return cause === "failed" ? "FAILED" : "EXHAUSTED";
    return "FAILED";
  }
  if (phase === "ADMIT" || phase === "ASSEMBLE") return "ASSEMBLE";
  if (phase === "WORK") return "WORK";
  if (phase === "PREPARE_COMMIT") return "COMPLETE";
  if (phase === "RENDER") return "RENDER";
  if (phase === "COMMIT") return "COMMITTING";
  return "ASSEMBLE";
}

function normalizeInputState(
  input: AgentRunNormalizationInputV2,
  existing?: AgentRunPublicV2,
): StoredRunState {
  if (input.status !== undefined) return normalizeStoredState(input.status);
  if (input.phase !== undefined) return normalizeStoredState(input.phase);
  const phase = input.workPhase ?? existing?.workPhase;
  const status = input.workStatus ?? existing?.workStatus;
  const outcome = input.workOutcome === undefined ? existing?.workOutcome : input.workOutcome;
  const reason = boundedText(reasonCodeForInput(input, existing), MAX_ID_BYTES);
  return storedStateFromCanonical(phase, status, outcome, reason, terminalCodeForInput(input, existing));
}

function phaseForStoredState(state: StoredRunState): AgentRunPublicPhaseV2 {
  if (state === "ASSEMBLE") return "ASSEMBLE";
  if (state === "WORK") return "WORK";
  if (state === "COMPLETE") return "PREPARE_COMMIT";
  if (state === "RENDER") return "RENDER";
  if (state === "PREPARE_COMMIT" || state === "COMMITTING") return "COMMIT";
  return "TERMINAL";
}

function outcomeForStoredState(state: StoredRunState, terminalCode?: unknown): AgentRunPublicOutcomeV2 | null {
  if (state === "COMMITTED") return "completed";
  if (state === "CANCELLED") return "stopped";
  if (state === "EXHAUSTED") return "exhausted";
  if (state === "FAILED" && isRejectedErrorCode(terminalCode)) return "rejected";
  const cause = terminalCauseForCode(terminalCode);
  if (cause && (state === "TIMED_OUT" || state === "FAILED" || state === "COMMIT_FAILED")) {
    return cause;
  }
  if (state === "FAILED" || state === "COMMIT_FAILED" || state === "TIMED_OUT") return "failed";
  return null;
}

function statusForStoredState(
  state: StoredRunState,
  cancelling = false,
  terminalCode?: unknown,
): AgentRunPublicStatusV2 {
  if (outcomeForStoredState(state, terminalCode) !== null) return "terminal";
  if (cancelling) return "cancelling";
  if (state === "ASSEMBLE") return "running";
  if (state === "COMPLETE" || state === "PREPARE_COMMIT") return "waiting";
  return "running";
}

function normalizeWorkPhase(value: unknown, state: StoredRunState): AgentRunPublicPhaseV2 {
  return isAgentRunPublicPhase(value) ? value : phaseForStoredState(state);
}

function normalizeWorkStatus(
  value: unknown,
  state: StoredRunState,
  cancelling = false,
  terminalCode?: unknown,
): AgentRunPublicStatusV2 {
  return isAgentRunPublicStatus(value)
    ? value
    : statusForStoredState(state, cancelling, terminalCode);
}

function normalizeWorkOutcome(
  value: unknown,
  state: StoredRunState,
  terminalCode?: unknown,
): AgentRunPublicOutcomeV2 | null {
  const derived = outcomeForStoredState(state, terminalCode);
  if (derived !== null) return derived;
  if (value === null) return null;
  return isAgentRunPublicOutcome(value) ? value : null;
}

function normalizeReason(value: unknown, state: StoredRunState, outcome: AgentRunPublicOutcomeV2 | null): string | null {
  const reason = boundedText(value, MAX_ID_BYTES);
  if (reason && outcome === "stopped" && terminalCauseForCode(reason) === "stopped") return "stopped";
  if (reason) return reason;
  if (state === "TIMED_OUT") return "timed_out";
  if (state === "CANCELLED") return "stopped";
  if (state === "COMMIT_FAILED") return "commit_failed";
  if (state === "EXHAUSTED") return "exhausted";
  if (state === "FAILED") return "failed";
  if (outcome === "rejected") return "rejected";
  return null;
}

function normalizeTargetIdentity(
  value: unknown,
  chatId: string,
  generationType: AgentRunGenerationTypeV1,
  messageId: string | null,
  swipeId: number | null,
): AgentWorkTargetIdentityV1 {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const sourceChatId = boundedId(source.chatId) ?? chatId;
  const sourceGenerationType = normalizeGenerationType(source.generationType) ?? generationType;
  const sourceMessageId = source.messageId === null ? null : boundedId(source.messageId) ?? messageId;
  const sourceSwipeId = source.swipeId === null
    ? null
    : (coerceNonNegativeSafeInteger(source.swipeId) ?? swipeId ?? 0);
  return {
    chatId: sourceChatId,
    generationType: sourceGenerationType,
    messageId: sourceMessageId,
    swipeId: sourceMessageId === null ? null : sourceSwipeId,
  };
}

function normalizeAttemptLineage(
  input: AgentRunNormalizationInputV2,
  chatId: string,
  generationType: AgentRunGenerationTypeV1,
  target: AgentRunTargetV1 | null,
  startedAt: number,
  existing?: AgentRunPublicV2,
): AgentWorkAttemptLineageV1 {
  const source = input.attemptLineage && typeof input.attemptLineage === "object"
    ? input.attemptLineage as Record<string, unknown> : existing?.attemptLineage;
  const targetIdentity = normalizeTargetIdentity(
    source?.target,
    chatId,
    generationType,
    target?.messageId ?? null,
    target?.swipeId ?? null,
  );
  const attemptId = boundedId(source?.attemptId) ?? existing?.attemptLineage.attemptId ?? input.turnId;
  const previousAttemptId = source?.previousAttemptId === null
    ? null
    : boundedId(source?.previousAttemptId) ?? existing?.attemptLineage.previousAttemptId ?? null;
  const createdAt = boundedCounter(source?.createdAt, existing?.attemptLineage.createdAt ?? startedAt);
  return {
    version: 1,
    attemptId,
    previousAttemptId,
    target: targetIdentity,
    createdAt,
  };
}

function normalizeGenerationType(value: unknown): AgentRunGenerationTypeV1 | null {
  return typeof value === "string" && GENERATION_TYPES.has(value as AgentRunGenerationTypeV1)
    ? value as AgentRunGenerationTypeV1
    : null;
}

function normalizeUsage(value: unknown): AgentActivityUsageV2 {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    inputTokens: boundedCounter(source.inputTokens),
    outputTokens: boundedCounter(source.outputTokens),
    totalTokens: boundedCounter(source.totalTokens),
    toolCalls: boundedCounter(source.toolCalls),
    childInvocations: boundedCounter(source.childInvocations),
  };
}

function normalizeNodeStatus(value: unknown): AgentActivityNodeStatusV2 {
  if (typeof value === "string" && NODE_STATUSES.has(value as AgentActivityNodeStatusV2)) {
    return value as AgentActivityNodeStatusV2;
  }
  if (value === "queued" || value === "pending") return "pending";
  return "omitted";
}

function normalizeNodeKind(value: unknown): AgentActivityNodeKindV2 {
  if (typeof value === "string" && NODE_KINDS.has(value as AgentActivityNodeKindV2)) {
    return value as AgentActivityNodeKindV2;
  }
  if (value === "root_turn") return "root";
  if (value === "provider_round") return "provider";
  if (value === "child_invocation") return "child";
  if (value === "tool_attempt") return "tool";
  return "tool";
}

function normalizeNodeActor(value: unknown, kind: AgentActivityNodeKindV2): AgentActivityNodeActorV2 {
  if (typeof value === "string" && NODE_ACTORS.has(value as AgentActivityNodeActorV2)) {
    return value as AgentActivityNodeActorV2;
  }
  return kind;
}

function normalizeNode(value: unknown, fallbackIndex: number, phase: AgentRunPublicPhaseV2): AgentActivityNodeV2 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = boundedId(source.id, MAX_NODE_ID_BYTES) ?? `omitted-${fallbackIndex}`;
  const kind = normalizeNodeKind(source.kind);
  const actor = normalizeNodeActor(source.actor, kind);
  const parentId = source.parentId === null ? null : boundedId(source.parentId, MAX_NODE_ID_BYTES);
  const sourceState = normalizeStoredState(source.phase);
  const nodePhase = source.phase === undefined ? phase : normalizeWorkPhase(source.phase, sourceState);
  const status = normalizeNodeStatus(source.status);
  const startedAt = boundedCounter(source.startedAt);
  const elapsedMs = boundedCounter(source.elapsedMs);
  const profileId = boundedText(source.profileId, MAX_PROFILE_BYTES);
  const toolId = boundedText(source.toolId, MAX_TOOL_BYTES);
  const roundIndex = source.roundIndex === undefined ? undefined : boundedCounter(source.roundIndex);
  const continuationMode = source.continuationMode === "ordinary" || source.continuationMode === "finalization" || source.continuationMode === "none"
    ? source.continuationMode : undefined;
  const usage = source.usage === undefined ? undefined : normalizeUsage(source.usage);
  const errorCode = safePublicErrorCode(source.errorCode);
  return {
    version: 2,
    id,
    parentId,
    kind,
    actor,
    phase: nodePhase,
    status,
    startedAt,
    elapsedMs,
    ...(profileId ? { profileId } : {}),
    ...(toolId ? { toolId } : {}),
    ...(roundIndex !== undefined ? { roundIndex } : {}),
    ...(continuationMode ? { continuationMode } : {}),
    ...(usage ? { usage } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

function normalizeOmission(value: unknown): AgentOmissionMarkerV2 {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const first = source.firstOmittedSequence === null || source.firstOmittedSequence === undefined
    ? null : boundedCounter(source.firstOmittedSequence);
  const last = source.lastOmittedSequence === null || source.lastOmittedSequence === undefined
    ? null : boundedCounter(source.lastOmittedSequence);
  return {
    omittedNodeCount: boundedCounter(source.omittedNodeCount),
    omittedEventCount: boundedCounter(source.omittedEventCount),
    firstOmittedSequence: first,
    lastOmittedSequence: last,
  };
}

function normalizeHandoff(value: unknown): AgentTerminalHandoffV2 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const messageId = source.messageId === null || source.messageId === undefined
    ? null : boundedId(source.messageId);
  const swipeId = source.swipeId === null || source.swipeId === undefined
    ? null : boundedCounter(source.swipeId);
  const messageRevision = source.messageRevision === null || source.messageRevision === undefined
    ? null : boundedCounter(source.messageRevision);
  const swipeRevision = source.swipeRevision === null || source.swipeRevision === undefined
    ? null : boundedCounter(source.swipeRevision);
  if (messageId === null && swipeId !== null) return undefined;
  return {
    version: 2,
    committed: source.committed === true,
    messageId,
    swipeId,
    messageRevision,
    swipeRevision,
  };
}

function normalizeTarget(messageId: unknown, swipeId: unknown): AgentRunTargetV1 | null {
  const normalizedMessageId = messageId === null || messageId === undefined ? null : boundedId(messageId);
  if (messageId !== null && messageId !== undefined && !normalizedMessageId) return null;
  if (normalizedMessageId === null) return null;
  const coercedSwipeId = coerceNonNegativeSafeInteger(swipeId);
  const normalizedSwipeId = Number.isSafeInteger(coercedSwipeId) ? coercedSwipeId as number : 0;
  return { messageId: normalizedMessageId, swipeId: normalizedSwipeId };
}

function mapCompatibilityLifecycle(run: AgentRunPublicV2): "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out" {
  if (run.workPhase === "ADMIT" || run.workPhase === "ASSEMBLE") return "queued";
  if (run.workStatus !== "terminal") return "running";
  if (run.workOutcome === "completed") return "completed";
  if (run.workOutcome === "stopped") return "cancelled";
  return "failed";
}

function storedStateForPublicProjection(
  workPhase: AgentRunPublicPhaseV2,
  workStatus: AgentRunPublicStatusV2,
  workOutcome: AgentRunPublicOutcomeV2 | null,
  terminalCode?: unknown,
): StoredRunState {
  if (workStatus === "terminal") {
    if (workOutcome === "completed") return "COMMITTED";
    if (workOutcome === "stopped") {
      return terminalCauseForCode(terminalCode) === "failed" ? "FAILED" : "CANCELLED";
    }
    if (workOutcome === "exhausted") return "EXHAUSTED";
    return "FAILED";
  }
  if (workPhase === "ADMIT" || workPhase === "ASSEMBLE") return "ASSEMBLE";
  if (workPhase === "WORK") return "WORK";
  if (workPhase === "PREPARE_COMMIT") return "COMPLETE";
  if (workPhase === "RENDER") return "RENDER";
  if (workPhase === "COMMIT") return "COMMITTING";
  return "FAILED";
}

function storedStateForRun(run: AgentRunPublicV2): StoredRunState {
  return storedStateForPublicProjection(
    run.workPhase,
    run.workStatus,
    run.workOutcome,
    run.error?.code,
  );
}
function compatibilitySnapshot(run: AgentRunPublicV2): PersistAgentActivityRunInput["snapshot"] {
  const lifecycle = mapCompatibilityLifecycle(run);
  return {
    version: 1,
    rootId: run.runId,
    nodes: run.activity.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      phase: lifecycle,
      status: node.status === "completed" ? "completed" : node.status === "cancelled" ? "cancelled" : node.status === "timed_out" ? "timed_out" : node.status === "failed" ? "failed" : lifecycle,
      startedAt: node.startedAt,
      elapsedMs: node.elapsedMs,
      ...(node.profileId ? { profileId: node.profileId } : {}),
      ...(node.toolId ? { toolId: node.toolId } : {}),
      ...(node.roundIndex !== undefined ? { roundIndex: node.roundIndex } : {}),
      ...(node.continuationMode ? { continuationMode: node.continuationMode } : {}),
      ...(node.usage ? { usage: node.usage } : {}),
      ...(node.errorCode ? { errorCode: node.errorCode } : {}),
    })),
    omittedNodeCount: run.omission.omittedNodeCount,
    errorCounts: run.error ? { [run.error.code]: 1 } : {},
    usage: run.usage,
    status: lifecycle,
    ...(run.error ? { terminalErrorCode: run.error.code } : {}),
  };
}

function normalizeRun(
  input: AgentRunNormalizationInputV2,
  sequence: number,
  revision: number,
  existing?: AgentRunPublicV2,
  allowTerminalRejectedOutcomeRepair = false,
): AgentRunPublicV2 | null {
  const userId = boundedId(input.userId);
  const chatId = boundedId(input.chatId);
  const turnId = boundedId(input.turnId);
  const generationId = boundedId(input.generationId);
  const generationType = normalizeGenerationType(input.generationType);
  const causalCode = terminalCodeForInput(input, existing);
  const errorSource = input.error === undefined
    ? existing?.error ?? null
    : input.error && typeof input.error === "object" ? input.error : null;
  const storedState = normalizeInputState(input, existing);
  if (!userId || !chatId || !turnId || !generationId || !generationType) return null;
  const candidateTarget = normalizeTarget(
    input.targetMessageId === undefined ? existing?.target?.messageId : input.targetMessageId,
    input.targetSwipeId === undefined ? existing?.target?.swipeId : input.targetSwipeId,
  );
  const fallbackStartedAt = boundedCounter(input.startedAt, existing?.startedAt ?? Math.floor(Date.now() / 1000));
  const terminalState = outcomeForStoredState(storedState, causalCode) !== null;
  const derivesFromStoredState = input.status !== undefined || input.phase !== undefined;
  const workPhase = normalizeWorkPhase(
    terminalState
      ? undefined
      : input.workPhase ?? (derivesFromStoredState ? undefined : existing?.workPhase),
    storedState,
  );
  const workOutcome = allowTerminalRejectedOutcomeRepair && input.workOutcome === "rejected"
    ? "rejected"
    : normalizeWorkOutcome(
        input.workOutcome === undefined ? existing?.workOutcome : input.workOutcome,
        storedState,
        causalCode,
      );
  const workStatus = normalizeWorkStatus(
    terminalState
      ? undefined
      : input.workStatus ?? (derivesFromStoredState ? undefined : existing?.workStatus),
    storedState,
    storedState === "CANCELLED" || storedState === "TIMED_OUT",
    causalCode,
  );
  const reason = normalizeReason(
    input.reason === undefined ? existing?.reason ?? errorSource?.reason : input.reason,
    storedState,
    workOutcome,
  );
  const defaultStatus: AgentActivityNodeStatusV2 = workOutcome === "completed"
    ? "completed"
    : workOutcome === "stopped"
      ? "cancelled"
      : workOutcome !== null
        ? "failed"
        : workStatus === "pending"
          ? "pending"
          : "running";
  const sourceActivity = Array.isArray(input.activity) && input.activity.length > 0
    ? input.activity
    : existing?.activity?.length
      ? existing.activity
      : [{
        id: `root:${turnId}`,
        parentId: null,
        kind: "root",
        actor: "root",
        phase: workPhase,
        status: defaultStatus,
        startedAt: fallbackStartedAt,
        elapsedMs: 0,
      }];
  const activity: AgentActivityNodeV2[] = [];
  for (let index = 0; index < Math.min(sourceActivity.length, MAX_NODES); index += 1) {
    const node = normalizeNode(sourceActivity[index], index, workPhase);
    if (node) activity.push(node);
  }
  const inputOmission = isRecordValue(input.omission) ? input.omission : null;
  const normalizedOmittedNodeCount = boundedCounter(
    (typeof inputOmission?.omittedNodeCount === "number" ? inputOmission.omittedNodeCount : 0)
      + Math.max(0, sourceActivity.length - MAX_NODES),
  );
  const omission: AgentOmissionMarkerV2 = {
    ...normalizeOmission(inputOmission),
    omittedNodeCount: normalizedOmittedNodeCount,
  };
  const startedAt = fallbackStartedAt;
  const updatedAt = boundedCounter(input.updatedAt, existing?.updatedAt ?? fallbackStartedAt);
  const errorCode = safePublicErrorCode(errorSource?.code)
    ?? defaultErrorCodeForState(storedState, causalCode, reason);
  const handoff = normalizeHandoff(input.terminalHandoff ?? existing?.terminalHandoff);
  const attemptLineage = normalizeAttemptLineage(input, chatId, generationType, candidateTarget, startedAt, existing);
  const target = normalizeTarget(attemptLineage.target.messageId, attemptLineage.target.swipeId);
  const recovery = recoveryForProjection(
    errorSource?.recoveryEligible,
    errorSource?.recoveryAction,
    errorCode,
    workOutcome,
    reason,
  );
  const normalizedActivity = workStatus === "terminal"
    ? activity.map((node) => node.status === "pending" || node.status === "running"
      ? {
          ...node,
          ...(node.kind === "root" ? { phase: "TERMINAL" as const } : {}),
          status: defaultStatus,
        }
      : node)
    : activity;
  const mutableActivity = [...normalizedActivity];
  let omittedNodeCount = omission.omittedNodeCount;
  const makeRun = (): AgentRunPublicV2 => {
    const runOmission = { ...omission, omittedNodeCount };
    const error = errorCode
      ? buildPublicError(
        errorCode,
        attemptLineage.target,
        workPhase,
        workStatus,
        workOutcome,
        reason,
        runOmission,
        attemptLineage.attemptId,
        errorSource?.category,
        errorSource?.summaryCode,
        errorSource?.recoveryEligible,
        errorSource?.recoveryAction,
      )
      : undefined;
    return {
      version: 2,
      runId: generationId,
      turnId,
      generationId,
      chatId,
      generationType,
      target,
      workPhase,
      workStatus,
      workOutcome,
      recoveryEligible: recovery.recoveryEligible,
      recoveryAction: recovery.recoveryAction,
      omissionCount: Math.min(MAX_SAFE_COUNTER, runOmission.omittedNodeCount + runOmission.omittedEventCount),
      inspectionAttemptId: attemptLineage.attemptId,
      reason,
      attemptLineage,
      revision,
      sequence,
      startedAt,
      updatedAt,
      activity: mutableActivity,
      usage: normalizeUsage(input.usage ?? existing?.usage),
      omission: runOmission,
      ...(error ? { error } : {}),
      ...(handoff ? { terminalHandoff: handoff } : {}),
    };
  };
  let run = makeRun();
  let json = JSON.stringify(run);
  while (encoder.encode(json).byteLength > 65536 && mutableActivity.length > 0) {
    mutableActivity.splice(mutableActivity.length > 1 ? 1 : 0, 1);
    omittedNodeCount += 1;
    run = makeRun();
    json = JSON.stringify(run);
  }
  return encoder.encode(json).byteLength <= 65536 ? run : null;
}

function parseStoredTerminalHandoff(
  serialized: string | null,
  snapshotFallback: AgentRunProjectionInputV2["terminalHandoff"],
): AgentRunProjectionInputV2["terminalHandoff"] {
  if (serialized === null) return snapshotFallback;
  return JSON.parse(serialized) as AgentRunProjectionInputV2["terminalHandoff"];
}

function parseStoredRun(row: StoredProjectionRow): AgentRunPublicV2 | null {
  try {
    const parsed = JSON.parse(row.snapshot_json) as AgentRunPublicV2;
    const generationType = normalizeGenerationType(parsed.generationType ?? row.generation_type);
    if (!generationType) return null;
    const safe = normalizeRun({
      userId: row.user_id,
      chatId: row.chat_id,
      turnId: row.turn_id,
      generationId: row.generation_id,
      generationType,
      targetMessageId: row.target_message_id,
      targetSwipeId: row.target_swipe_id,
      status: normalizeStoredState(row.status),
      phase: normalizeStoredState(row.phase),
      workPhase: parsed.workPhase,
      workStatus: parsed.workStatus,
      workOutcome: parsed.workOutcome,
      reason: parsed.reason,
      attemptLineage: parsed.attemptLineage,
      revision: row.revision,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      activity: parsed.activity,
      usage: parsed.usage,
      error: parsed.error,
      terminalHandoff: parseStoredTerminalHandoff(row.terminal_handoff_json, parsed.terminalHandoff),
      omission: JSON.parse(row.omission_json),
    }, row.sequence, row.revision);
    return safe;
  } catch {
    return null;
  }
}

function parseStoredEvent(
  db: Database,
  userId: string,
  row: StoredEventRow,
  chatId: string,
): { run: AgentRunPublicV2; omission: AgentOmissionMarkerV2 } | null {
  try {
    const parsed = JSON.parse(row.snapshot_json) as AgentRunPublicV2;
    const generationType = normalizeGenerationType(parsed.generationType);
    if (!generationType) return null;
    const messageId = parsed.target?.messageId ?? null;
    const swipeId = parsed.target?.swipeId ?? null;
    if (!assertStoredTarget(db, chatId, messageId, swipeId, generationType)) return null;
    const run = normalizeRun({
      userId,
      chatId,
      turnId: row.turn_id,
      generationId: parsed.generationId,
      generationType,
      targetMessageId: messageId,
      targetSwipeId: swipeId,
      status: normalizeStoredState(row.status),
      phase: normalizeStoredState(row.status),
      workPhase: parsed.workPhase,
      workStatus: parsed.workStatus,
      workOutcome: parsed.workOutcome,
      reason: parsed.reason,
      attemptLineage: parsed.attemptLineage,
      revision: row.run_revision,
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
      activity: parsed.activity,
      usage: parsed.usage,
      error: parsed.error,
      terminalHandoff: parseStoredTerminalHandoff(row.terminal_handoff_json, parsed.terminalHandoff),
      omission: JSON.parse(row.omission_json),
    }, row.sequence, row.run_revision);
    if (!run) return null;
    return { run, omission: run.omission };
  } catch {
    return null;
  }
}

function projectionKey(userId: string, chatId: string, turnId: string): string {
  return `${userId}\u0000${chatId}\u0000${turnId}`;
}

function tableExists(db: Database, table: string): boolean {
  try {
    return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  } catch {
    return false;
  }
}

function validId(value: unknown): value is string {
  return boundedId(value) !== null;
}

function assertOwnedChat(db: Database, userId: string, chatId: string): boolean {
  return Boolean(db.query("SELECT 1 FROM chats WHERE id = ? AND user_id = ? LIMIT 1").get(chatId, userId));
}

function parseSwipes(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function messageHasSwipe(
  db: Database,
  chatId: string,
  messageId: string,
  swipeId: number | string | null | undefined,
  options?: { readonly allowAppendSlot?: boolean },
): boolean {
  const row = db.query(
    "SELECT swipes FROM messages WHERE id = ? AND chat_id = ? LIMIT 1",
  ).get(messageId, chatId) as { swipes?: unknown } | null;
  if (!row) return false;
  if (swipeId === null || swipeId === undefined) return true;
  const coercedSwipeId = coerceNonNegativeSafeInteger(swipeId);
  if (coercedSwipeId === null || coercedSwipeId === undefined || !Number.isSafeInteger(coercedSwipeId)) return false;
  const swipes = parseSwipes(row.swipes);
  if (swipes === null) return false;
  // regenerate/swipe may target swipeCount before that slot exists.
  if (options?.allowAppendSlot === true && coercedSwipeId === swipes.length) return true;
  return coercedSwipeId < swipes.length;
}

function assertStoredTarget(
  db: Database,
  chatId: string,
  messageId: string | null,
  swipeId: number | string | null,
  generationType?: unknown,
): boolean {
  if (messageId === null) return swipeId === null;
  if (!validId(messageId)) return false;
  return messageHasSwipe(db, chatId, messageId, swipeId, {
    allowAppendSlot: generationType === "regenerate" || generationType === "swipe",
  });
}

function executionControlRow(
  db: Database,
  userId: string,
  chatId: string,
  turnId: string,
): StoredExecutionControlRow | null {
  if (!tableExists(db, "agent_turn_executions")) return null;
  try {
    return db.query(
      `SELECT *
         FROM agent_turn_executions
        WHERE user_id = ? AND chat_id = ? AND id = ?
        LIMIT 1`,
    ).get(userId, chatId, turnId) as StoredExecutionControlRow | null;
  } catch {
    return null;
  }
}

function executionReadVisible(db: Database, row: StoredExecutionControlRow | null): boolean {
  // A missing execution table is a legacy compatibility mode. Once the table
  // exists, a projection without its owner-scoped execution is not readable.
  return row === null ? !tableExists(db, "agent_turn_executions") : !isExpiredAt(row.expires_at);
}

function executionTerminalCode(row: StoredExecutionControlRow | null): string | null {
  return boundedText(row?.terminal_code ?? row?.error_code, MAX_ID_BYTES);
}

function storedCancellationMarkerSet(value: unknown): boolean {
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  return value === true || value === "true" || value === "1";
}

function executionCancellationRequested(row: StoredExecutionControlRow): boolean {
  const requestedAt = row.cancel_requested_at;
  if (
    (typeof requestedAt === "number" && Number.isFinite(requestedAt))
    || typeof requestedAt === "bigint"
  ) return true;
  return storedCancellationMarkerSet(row.cancel_requested)
    || storedCancellationMarkerSet(row.cancellation_requested);
}

interface CanonicalExecutionProjection {
  readonly state: StoredRunState;
  readonly status: AgentRunPublicStatusV2;
  readonly outcome: AgentRunPublicOutcomeV2 | null;
}

function canonicalExecutionProjection(row: StoredExecutionControlRow | null): CanonicalExecutionProjection | null {
  if (!row) return null;
  const rawState = typeof row.phase === "string" ? row.phase : row.state;
  if (typeof rawState !== "string" || !STORED_STATES.has(rawState as StoredRunState)) return null;
  const state = normalizeStoredState(rawState);
  const terminalCode = executionTerminalCode(row);
  return {
    state,
    status: statusForStoredState(state, executionCancellationRequested(row), terminalCode),
    outcome: outcomeForStoredState(state, terminalCode),
  };
}

function stopTerminalError(status: StoredRunState, terminalCode?: unknown): { code: string } | null {
  const code = defaultErrorCodeForState(status, terminalCode);
  return code ? { code } : null;
}
function terminalProjectionMatchesState(
  run: AgentRunPublicV2,
  state: StoredRunState,
  terminalCode?: unknown,
): boolean {
  const durableOutcome = outcomeForStoredState(state, terminalCode);
  return durableOutcome !== null && durableOutcome === run.workOutcome;
}


function terminalActivityNodes(
  activity: readonly AgentActivityNodeV2[],
  status: StoredRunState,
): readonly AgentActivityNodeV2[] {
  const terminalNodeStatus: AgentActivityNodeStatusV2 = status === "TIMED_OUT"
    ? "timed_out"
    : status === "CANCELLED"
      ? "cancelled"
      : status === "COMMITTED"
        ? "completed"
        : "failed";
  return activity.map((node) => ({
    ...node,
    phase: node.phase === "TERMINAL" ? node.phase : "TERMINAL",
    status: node.status === "pending" || node.status === "running" ? terminalNodeStatus : node.status,
  }));
}
function inspectionReasonForTerminalState(
  status: StoredRunState,
  terminalCode?: unknown,
): PersistAgentRunInspectionInputV1["reason"] {
  const code = boundedText(terminalCode, MAX_ID_BYTES)?.toLowerCase() ?? "";
  if (status === "COMMITTED") return "none";
  if (status === "CANCELLED") return "user_stop";
  if (status === "TIMED_OUT") return "deadline";
  if (status === "EXHAUSTED" || code.includes("budget") || code.includes("limit")) return "budget_exhausted";
  if (code === "invalid_input" || code === "agentic_runtime_unavailable") return "invalid_input";
  if (code.includes("provider")) return "provider_failure";
  if (code.includes("tool")) return "tool_failure";
  if (code.includes("required_work")) return "required_work_failure";
  if (code === "interrupted" || code === "process_interrupted") return "interrupted";
  return code.length > 0 ? "needs_attention" : "unknown";
}

function convergeDurableTerminalOwnersInTransaction(
  db: Database,
  userId: string,
  run: AgentRunPublicV2,
  status: StoredRunState,
  terminalCode?: unknown,
): void {
  const outcome = outcomeForStoredState(status, terminalCode);
  if (!outcome) throw new Error("terminal execution outcome is unavailable");
  const reason = status === "CANCELLED"
    ? "stopped"
    : boundedText(terminalCode, MAX_ID_BYTES)
      ?? (status === "TIMED_OUT" ? "timed_out" : status.toLowerCase());
  const now = Date.now();
  if (tableExists(db, "persistent_workspace_turn_sessions")) {
    const session = db.query(
      "SELECT phase, status, outcome, revision, attempt_id FROM persistent_workspace_turn_sessions " +
        "WHERE user_id = ? AND turn_id = ? AND execution_id = ? LIMIT 1",
    ).get(
      userId,
      run.turnId,
      run.turnId,
    ) as { phase: string; status: string; outcome: string | null; revision: number; attempt_id: string } | null;
    if (session && session.attempt_id !== run.attemptLineage.attemptId && session.attempt_id !== run.turnId) {
      throw new Error("terminal Turn Session attempt identity conflicts with durable execution");
    }
    if (session) {
      if (session.phase === "TERMINAL" || session.status === "terminal") {
        if (session.phase !== "TERMINAL" || session.status !== "terminal" || session.outcome !== outcome) {
          throw new Error("terminal Turn Session conflicts with durable execution");
        }
      } else {
        const changed = db.query(
          "UPDATE persistent_workspace_turn_sessions " +
            "SET phase = 'TERMINAL', status = 'terminal', outcome = ?, reason = ?, revision = revision + 1, updated_at = ?, terminal_at = ? " +
            "WHERE user_id = ? AND turn_id = ? AND attempt_id = ? AND execution_id = ? AND revision = ?",
        ).run(
          outcome,
          reason,
          Math.floor(now / 1000),
          Math.floor(now / 1000),
          userId,
          run.turnId,
          session.attempt_id,
          run.turnId,
          session.revision,
        ).changes;
        if (changed !== 1) throw new Error("terminal Turn Session CAS failed");
      }
    }
  }
  const inspection = persistAgentRunInspectionInTransaction(db, {
    userId,
    chatId: run.chatId,
    attemptId: run.attemptLineage.attemptId,
    previousAttemptId: run.attemptLineage.previousAttemptId,
    runId: run.generationId,
    turnSessionId: run.turnId,
    generationId: run.generationId,
    generationType: run.generationType,
    targetMessageId: run.target?.messageId ?? null,
    targetSwipeId: run.target?.swipeId ?? null,
    hostCorrelationId: "agentic:" + run.turnId + ":" + run.attemptLineage.attemptId,
    lifecycle: "TERMINAL",
    status: "terminal",
    outcome,
    reason: inspectionReasonForTerminalState(status, terminalCode),
    updatedAt: now,
    terminalAt: now,
    reconciliation: "recovered",
  });
  if (!inspection) throw new Error("terminal inspection convergence failed");
}

function appendDurableTerminalProjection(
  db: Database,
  userId: string,
  run: AgentRunPublicV2,
  status: StoredRunState,
  terminalCode?: unknown,
): AgentRunProjectionCommitResult {
  convergeDurableTerminalOwnersInTransaction(db, userId, run, status, terminalCode);
  const reason = status === "CANCELLED"
    ? "stopped"
    : boundedText(terminalCode, MAX_ID_BYTES)
      ?? (status === "TIMED_OUT"
        ? "timed_out"
        : status === "COMMIT_FAILED"
          ? "commit_failed"
          : status === "EXHAUSTED"
            ? "exhausted"
            : status === "FAILED"
              ? "failed"
              : null);
  return appendAgentRunSnapshot(db, {
    userId,
    chatId: run.chatId,
    turnId: run.turnId,
    generationId: run.generationId,
    generationType: run.generationType,
    targetMessageId: run.target?.messageId ?? null,
    targetSwipeId: run.target?.swipeId ?? null,
    status,
    workPhase: "TERMINAL",
    workStatus: "terminal",
    workOutcome: outcomeForStoredState(status, terminalCode),
    reason,
    attemptLineage: run.attemptLineage,
    revision: run.revision + 1,
    activity: terminalActivityNodes(run.activity, status),
    usage: run.usage,
    omission: run.omission,
    error: stopTerminalError(status, terminalCode),
    terminalHandoff: run.terminalHandoff ?? null,
  });
}
function appendDurableCancellingProjection(
  db: Database,
  userId: string,
  run: AgentRunPublicV2,
): AgentRunProjectionCommitResult {
  return appendAgentRunSnapshot(db, {
    userId,
    chatId: run.chatId,
    turnId: run.turnId,
    generationId: run.generationId,
    generationType: run.generationType,
    targetMessageId: run.target?.messageId ?? null,
    targetSwipeId: run.target?.swipeId ?? null,
    status: storedStateForRun(run),
    workPhase: run.workPhase,
    workStatus: "cancelling",
    workOutcome: null,
    reason: run.reason,
    attemptLineage: run.attemptLineage,
    revision: run.revision + 1,
    activity: run.activity,
    usage: run.usage,
    omission: run.omission,
    error: run.error,
    terminalHandoff: run.terminalHandoff ?? null,
  });
}

function historicalInspectionTargetIsAudited(
  db: Database,
  userId: string,
  chatId: string,
  attemptId: string,
  targetMessageId: string | null,
  targetSwipeId: number | null,
): boolean {
  if (targetMessageId === null || !tableExists(db, "agent_run_audit_records")) return false;
  try {
    const rows = db.query(
      `SELECT payload_json
         FROM agent_run_audit_records
        WHERE user_id = ? AND chat_id = ? AND attempt_id = ?
        ORDER BY host_sequence, record_id
        LIMIT 512`,
    ).all(userId, chatId, attemptId) as Array<{ payload_json?: unknown }>;
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(String(row.payload_json ?? "{}")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        payload = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const correlation = payload.correlation;
      if (!correlation || typeof correlation !== "object" || Array.isArray(correlation)) continue;
      const candidate = correlation as Record<string, unknown>;
      if (
        candidate.messageId === targetMessageId
        && candidate.swipeId === targetSwipeId
      ) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function persistInspectionRepairMarker(
  db: Database,
  input: AgentRunProjectionInputV2,
  run: AgentRunPublicV2,
): void {
  if (!input.receiptRepair && !input.recoveryRepair) return;
  const markerKind = input.receiptRepair ? "late_event" : "reordered_event";
  const markerId = `projection:${run.runId}:${markerKind}`;
  const receiptTargetMessageId = input.receiptRepair
    ? input.targetMessageId ?? null
    : run.target?.messageId ?? null;
  const receiptTargetSwipeId = receiptTargetMessageId === null
    ? null
    : input.receiptRepair
      ? input.targetSwipeId ?? 0
      : run.target?.swipeId ?? 0;
  const hostSequence = Number.isSafeInteger(run.sequence) && run.sequence >= 0 ? run.sequence : 0;
  const marker = {
    id: markerId,
    kind: markerKind,
    scope: "run",
    correlation: {
      turnSessionId: run.turnId,
      runId: run.runId,
      attemptId: run.attemptLineage.attemptId,
      chatId: run.chatId,
      generationId: run.generationId,
      messageId: receiptTargetMessageId,
      swipeId: receiptTargetSwipeId,
      actorId: "host",
      recipientId: null,
      phase: run.workPhase,
      taskId: null,
      toolId: null,
      parentId: null,
      hostCorrelationId: `${run.runId}:projection`,
      hostSequence,
    },
    firstSequence: hostSequence,
    lastSequence: hostSequence,
    recoverable: true,
    detail: input.receiptRepair
      ? "A durable terminal receipt reconciled the projection and inspection after the original event boundary."
      : "A startup recovery reconciled an interrupted execution after an out-of-order lifecycle boundary.",
  };
  const existingInspection = tableExists(db, "agent_run_attempts")
    ? db.query(
      `SELECT user_id, chat_id, attempt_id, previous_attempt_id, run_id, turn_id,
              generation_id, generation_type, target_message_id, target_swipe_id,
              lifecycle, status, outcome, reason, started_at, updated_at, terminal_at,
              terminal, host_correlation_id, reconciliation_state, terminal_receipt_json
         FROM agent_run_attempts
        WHERE user_id = ? AND attempt_id = ?
        LIMIT 1`,
    ).get(input.userId, run.attemptLineage.attemptId) as {
      user_id: string;
      chat_id: string;
      attempt_id: string;
      previous_attempt_id: string | null;
      run_id: string;
      turn_id: string;
      generation_id: string;
      generation_type: string;
      target_message_id: string | null;
      target_swipe_id: number | null;
      lifecycle: string;
      status: string;
      outcome: string | null;
      reason: string;
      started_at: number;
      updated_at: number;
      terminal_at: number | null;
      terminal: number;
      host_correlation_id: string;
      reconciliation_state: string;
      terminal_receipt_json: string | null;
    } | null
    : null;
  const receiptRepairAuthority = input.receiptRepair === true
    && validId(input.receiptId)
    && normalizeStoredState(input.status ?? input.phase ?? input.workPhase) === "COMMITTED"
    && run.workPhase === "TERMINAL"
    && run.workStatus === "terminal"
    && run.workOutcome === "completed"
    && run.terminalHandoff?.committed === true;
  const failedTerminalInspectionRow = existingInspection !== null
    && existingInspection.terminal === 1
    && existingInspection.lifecycle === "TERMINAL"
    && existingInspection.status === "terminal"
    && existingInspection.outcome === "failed"
    ? existingInspection
    : null;
  const failedTerminalInspection = failedTerminalInspectionRow !== null;
  const historicalTargetConflictAuthorized = receiptRepairAuthority
    && existingInspection !== null
    && (existingInspection.reconciliation_state === "authoritative"
      || existingInspection.reconciliation_state === "recovered")
    && historicalInspectionTargetIsAudited(
      db,
      existingInspection.user_id,
      existingInspection.chat_id,
      existingInspection.attempt_id,
      existingInspection.target_message_id,
      existingInspection.target_swipe_id,
    );
  const receiptIdentityConflict = receiptRepairAuthority
    && existingInspection !== null
    && (
      existingInspection.chat_id !== input.chatId
      || existingInspection.run_id !== run.runId
      || existingInspection.turn_id !== run.turnId
      || existingInspection.generation_id !== run.generationId
      || existingInspection.generation_type !== run.generationType
      || existingInspection.attempt_id !== run.attemptLineage.attemptId
      || existingInspection.previous_attempt_id !== run.attemptLineage.previousAttemptId
      || (
        !historicalTargetConflictAuthorized
        && (
          existingInspection.target_message_id !== null
            && existingInspection.target_message_id !== receiptTargetMessageId
          || existingInspection.target_swipe_id !== null
            && existingInspection.target_swipe_id !== receiptTargetSwipeId
        )
      )
    );
  let terminalReceiptIdentityConflict = false;
  if (receiptRepairAuthority && existingInspection?.terminal_receipt_json) {
    try {
      const parsed = JSON.parse(existingInspection.terminal_receipt_json) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        terminalReceiptIdentityConflict = true;
      } else {
        const source = parsed as Record<string, unknown>;
        const storedReceiptId = source.receiptId;
        if (storedReceiptId !== undefined
          && storedReceiptId !== null
          && (!validId(storedReceiptId) || storedReceiptId !== input.receiptId)) {
          terminalReceiptIdentityConflict = true;
        }
        const nestedTarget = source.target && typeof source.target === "object" && !Array.isArray(source.target)
          ? source.target as Record<string, unknown>
          : null;
        const legacyReceipt = validId(storedReceiptId);
        const emptyPlaceholder = (value: unknown): boolean => Boolean(
          value
          && typeof value === "object"
          && !Array.isArray(value)
          && Object.keys(value).length === 0,
        );
        const storedMessageId = source.messageId ?? nestedTarget?.messageId;
        const storedSwipeId = source.swipeId ?? nestedTarget?.swipeId;
        const messageIdAbsent = storedMessageId === undefined
          || storedMessageId === null
          || legacyReceipt && emptyPlaceholder(storedMessageId);
        const swipeIdAbsent = storedSwipeId === undefined
          || storedSwipeId === null
          || legacyReceipt && emptyPlaceholder(storedSwipeId);
        if (!messageIdAbsent
          && (typeof storedMessageId !== "string" || storedMessageId !== receiptTargetMessageId)) {
          terminalReceiptIdentityConflict = true;
        }
        if (!swipeIdAbsent
          && (!Number.isSafeInteger(storedSwipeId) || storedSwipeId !== receiptTargetSwipeId)) {
          terminalReceiptIdentityConflict = true;
        }
      }
    } catch {
      terminalReceiptIdentityConflict = true;
    }
  }
  if (terminalReceiptIdentityConflict) {
    throw new Error("agent run inspection repair conflicts with receipt identity");
  }
  if (receiptIdentityConflict) {
    throw new Error("agent run inspection repair conflicts with receipt identity");
  }
  if (existingInspection?.terminal === 1
    && (!receiptRepairAuthority || !failedTerminalInspection)
    && (
      existingInspection.lifecycle !== run.workPhase
      || existingInspection.status !== run.workStatus
      || existingInspection.outcome !== run.workOutcome
    )) {
    throw new Error("agent run inspection repair conflicts with terminal inspection");
  }
  const markerAlreadyPersisted = existingInspection !== null
    && tableExists(db, "agent_run_audit_records")
    && Boolean(db.query(
      `SELECT 1
         FROM agent_run_audit_records
        WHERE user_id = ? AND attempt_id = ? AND record_kind = 'marker' AND event_id = ?
        LIMIT 1`,
    ).get(input.userId, existingInspection.attempt_id, markerId));
  const inspectionInput: PersistAgentRunInspectionInputV1 = failedTerminalInspectionRow && receiptRepairAuthority
    ? {
        userId: failedTerminalInspectionRow.user_id,
        chatId: failedTerminalInspectionRow.chat_id,
        attemptId: failedTerminalInspectionRow.attempt_id,
        previousAttemptId: failedTerminalInspectionRow.previous_attempt_id,
        runId: failedTerminalInspectionRow.run_id,
        turnSessionId: failedTerminalInspectionRow.turn_id,
        generationId: failedTerminalInspectionRow.generation_id,
        generationType: failedTerminalInspectionRow.generation_type as PersistAgentRunInspectionInputV1["generationType"],
        targetMessageId: failedTerminalInspectionRow.target_message_id,
        targetSwipeId: failedTerminalInspectionRow.target_swipe_id,
        hostCorrelationId: failedTerminalInspectionRow.host_correlation_id,
        lifecycle: "TERMINAL",
        status: "terminal",
        outcome: "failed",
        reason: failedTerminalInspectionRow.reason as PersistAgentRunInspectionInputV1["reason"],
        startedAt: failedTerminalInspectionRow.started_at,
        updatedAt: failedTerminalInspectionRow.updated_at,
        terminalAt: failedTerminalInspectionRow.terminal_at,
        reconciliation: "recovered",
        ...(markerAlreadyPersisted ? {} : { markers: [marker] }),
      }
    : existingInspection
      ? {
          userId: existingInspection.user_id,
          chatId: existingInspection.chat_id,
          attemptId: existingInspection.attempt_id,
          previousAttemptId: existingInspection.previous_attempt_id,
          runId: existingInspection.run_id,
          turnSessionId: existingInspection.turn_id,
          generationId: existingInspection.generation_id,
          generationType: existingInspection.generation_type as PersistAgentRunInspectionInputV1["generationType"],
          targetMessageId: existingInspection.target_message_id,
          targetSwipeId: existingInspection.target_swipe_id,
          hostCorrelationId: existingInspection.host_correlation_id,
          lifecycle: run.workPhase,
          status: run.workStatus,
          outcome: run.workOutcome,
          reason: "reconciled",
          startedAt: existingInspection.started_at,
          updatedAt: Math.max(existingInspection.updated_at, run.updatedAt),
          terminalAt: existingInspection.terminal_at === null
            ? (run.workStatus === "terminal" ? run.updatedAt : null)
            : Math.max(existingInspection.terminal_at, run.updatedAt),
          reconciliation: "recovered",
          ...(markerAlreadyPersisted ? {} : { markers: [marker] }),
        }
      : {
          userId: input.userId,
          chatId: input.chatId,
          attemptId: run.attemptLineage.attemptId,
          previousAttemptId: run.attemptLineage.previousAttemptId,
          runId: run.runId,
          turnSessionId: run.turnId,
          generationId: run.generationId,
          generationType: run.generationType,
          targetMessageId: receiptTargetMessageId,
          targetSwipeId: receiptTargetSwipeId,
          hostCorrelationId: `${run.runId}:projection`,
          lifecycle: run.workPhase,
          status: run.workStatus,
          outcome: run.workOutcome,
          reason: "reconciled",
          startedAt: run.startedAt,
          updatedAt: run.updatedAt,
          terminalAt: run.workStatus === "terminal" ? run.updatedAt : null,
          reconciliation: "recovered",
          ...(markerAlreadyPersisted ? {} : { markers: [marker] }),
        };
  const persisted = persistAgentRunInspectionInTransaction(db, inspectionInput);
  if (!persisted) throw new Error("agent run inspection repair projection unavailable");
  if (failedTerminalInspectionRow && receiptRepairAuthority) {
    let priorReceiptEvidence: Record<string, unknown> = {};
    if (failedTerminalInspectionRow.terminal_receipt_json) {
      try {
        const parsed = JSON.parse(failedTerminalInspectionRow.terminal_receipt_json) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          priorReceiptEvidence = parsed as Record<string, unknown>;
        }
      } catch {
        // Receipt identity validation above rejects malformed persisted evidence.
      }
    }
    const messageRevision = input.terminalHandoff?.messageRevision ?? run.terminalHandoff?.messageRevision ?? null;
    const swipeRevision = input.terminalHandoff?.swipeRevision ?? run.terminalHandoff?.swipeRevision ?? null;
    const terminalReceiptJson = boundedBytesJson({
      ...priorReceiptEvidence,
      receiptId: input.receiptId,
      messageId: receiptTargetMessageId,
      swipeId: receiptTargetSwipeId,
      messageRevision,
      swipeRevision,
      error: priorReceiptEvidence.error ?? input.error ?? run.error ?? null,
    }, 16384)
      ?? boundedBytesJson({
        receiptId: input.receiptId,
        messageId: receiptTargetMessageId,
        swipeId: receiptTargetSwipeId,
        messageRevision,
        swipeRevision,
        error: input.error ?? run.error ?? null,
      }, 16384)
      ?? boundedBytesJson({
        receiptId: input.receiptId,
        messageId: receiptTargetMessageId,
        swipeId: receiptTargetSwipeId,
      }, 16384);
    const updatedAt = Math.max(failedTerminalInspectionRow.updated_at, run.updatedAt);
    const terminalAt = Math.max(failedTerminalInspectionRow.terminal_at ?? 0, updatedAt);
    const repaired = db.query(
      `UPDATE agent_run_attempts
          SET target_message_id = ?, target_swipe_id = ?,
              lifecycle = 'TERMINAL', status = 'terminal', outcome = 'completed',
              reason = 'reconciled', terminal = 1, updated_at = ?, terminal_at = ?,
              reconciliation_state = 'recovered',
              terminal_receipt_json = COALESCE(?, terminal_receipt_json)
        WHERE user_id = ? AND attempt_id = ?
          AND chat_id = ? AND run_id = ? AND turn_id = ?
          AND generation_id = ? AND generation_type = ?
          AND terminal = 1 AND lifecycle = 'TERMINAL'
          AND status = 'terminal' AND outcome = 'failed'
          AND ((target_message_id = ?) OR (target_message_id IS NULL AND ? IS NULL))
          AND ((target_swipe_id = ?) OR (target_swipe_id IS NULL AND ? IS NULL))`,
    ).run(
      receiptTargetMessageId,
      receiptTargetSwipeId,
      updatedAt,
      terminalAt,
      terminalReceiptJson,
      input.userId,
      failedTerminalInspectionRow.attempt_id,
      input.chatId,
      run.runId,
      run.turnId,
      run.generationId,
      run.generationType,
      failedTerminalInspectionRow.target_message_id,
      failedTerminalInspectionRow.target_message_id,
      failedTerminalInspectionRow.target_swipe_id,
      failedTerminalInspectionRow.target_swipe_id,
    );
    if (repaired.changes !== 1) {
      throw new Error("agent run inspection receipt repair lost terminal authority");
    }
  }
}


function workspaceExpired(retention: AgentWorkspaceRetentionV2, expiresAt: unknown, now = Math.floor(Date.now() / 1000)): boolean {
  if (retention === "chat_lifetime") return false;
  return typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= now;
}

function workspaceChildVisible(row: Record<string, unknown>, now = Math.floor(Date.now() / 1000)): boolean {
  return !workspaceExpired(workspacePolicy(row.retention), row.expires_at, now);
}

function assertOwnedTarget(db: Database, input: AgentRunProjectionInputV2): boolean {
  if (!validId(input.userId) || !validId(input.chatId)) return false;
  if (!assertOwnedChat(db, input.userId, input.chatId)) return false;
  const targetSwipeId = coerceNonNegativeSafeInteger(input.targetSwipeId);
  if (input.targetSwipeId !== undefined && input.targetSwipeId !== null
    && !Number.isSafeInteger(targetSwipeId)) return false;
  if (input.targetMessageId === undefined || input.targetMessageId === null) {
    return input.targetSwipeId === undefined || input.targetSwipeId === null;
  }
  if (!validId(input.targetMessageId)) return false;
  // normalizeTarget() defaults a message target to swipe zero. Validate that
  // concrete stored association now, not only when the run is later read.
  // regenerate/swipe may publish ASSEMBLE against the not-yet-written append slot.
  return messageHasSwipe(db, input.chatId, input.targetMessageId, targetSwipeId ?? 0, {
    allowAppendSlot: input.generationType === "regenerate" || input.generationType === "swipe",
  });
}

function getProjectionRow(db: Database, userId: string, chatId: string, turnId: string): StoredProjectionRow | null {
  return db.query(
    `SELECT user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
            target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
            snapshot_json, terminal_handoff_json, omission_json
       FROM agent_run_projections
      WHERE user_id = ? AND chat_id = ? AND turn_id = ?
      LIMIT 1`,
  ).get(userId, chatId, turnId) as StoredProjectionRow | null;
}

function getProjectionByTurn(db: Database, userId: string, turnId: string): StoredProjectionRow | null {
  return db.query(
    `SELECT user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
            target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
            snapshot_json, terminal_handoff_json, omission_json
       FROM agent_run_projections
      WHERE user_id = ? AND turn_id = ?
      LIMIT 1`,
  ).get(userId, turnId) as StoredProjectionRow | null;
}
function hasDurableTerminalEvent(db: Database, userId: string, run: AgentRunPublicV2): boolean {
  if (!tableExists(db, "agent_chat_events")) return false;
  const row = db.query(
    `SELECT 1 AS present
       FROM agent_chat_events
      WHERE user_id = ? AND chat_id = ? AND turn_id = ?
        AND sequence = ? AND run_revision = ? AND event_kind = 'terminal'
      LIMIT 1`,
  ).get(userId, run.chatId, run.turnId, run.sequence, run.revision) as { present?: number } | null;
  return Number(row?.present ?? 0) === 1;
}

function allocateChatSequence(db: Database, userId: string, chatId: string): number {
  db.query(
    `INSERT INTO agent_chat_event_sequences (user_id, chat_id, last_sequence, updated_at)
     VALUES (?, ?, 1, unixepoch())
     ON CONFLICT(user_id, chat_id) DO UPDATE SET
       last_sequence = agent_chat_event_sequences.last_sequence + 1,
       updated_at = unixepoch()`,
  ).run(userId, chatId);
  const row = db.query(
    "SELECT last_sequence FROM agent_chat_event_sequences WHERE user_id = ? AND chat_id = ?",
  ).get(userId, chatId) as { last_sequence: number } | null;
  if (!row || !Number.isSafeInteger(row.last_sequence) || row.last_sequence < 1) {
    throw new Error("agent chat event sequence allocation failed");
  }
  return row.last_sequence;
}

function isTerminal(value: AgentRunPublicV2 | AgentRunPublicStatusV2 | StoredRunState): boolean {
  if (typeof value === "object") return value.workStatus === "terminal";
  if (value === "terminal") return true;
  return STORED_STATES.has(value as StoredRunState) && TERMINAL_STATES.has(value as StoredRunState);
}

function persistCompatibilityProjection(db: Database, input: AgentRunProjectionInputV2, run: AgentRunPublicV2): void {
  if (!isTerminal(run)) return;
  const compatibilityTarget = run.terminalHandoff?.committed === true
    ? normalizeTarget(run.terminalHandoff.messageId, run.terminalHandoff.swipeId)
    : run.target;
  const targetMessageId = compatibilityTarget?.messageId ?? null;
  const targetSwipeId = compatibilityTarget?.swipeId ?? null;
  const snapshot = input.compatibilitySnapshot ?? compatibilitySnapshot(run);
  const lifecycle = mapCompatibilityLifecycle(run);
  if (input.receiptRepair === true && run.workOutcome === "completed" && tableExists(db, "agent_activity_runs")) {
    const existing = db.query(
      `SELECT target_message_id, target_swipe_id, snapshot_json
         FROM agent_activity_runs
        WHERE user_id = ? AND chat_id = ? AND generation_id = ?
        LIMIT 1`,
    ).get(input.userId, input.chatId, input.generationId) as {
      target_message_id?: unknown;
      target_swipe_id?: unknown;
      snapshot_json?: unknown;
    } | null;
    let existingLifecycle: string | null = null;
    if (typeof existing?.snapshot_json === "string") {
      try {
        const parsed = JSON.parse(existing.snapshot_json) as { snapshot?: { status?: unknown } };
        existingLifecycle = typeof parsed.snapshot?.status === "string" ? parsed.snapshot.status : null;
      } catch {
        // A malformed compatibility row is stale repair evidence.
      }
    }
    if (existingLifecycle === "failed"
      && (existingLifecycle !== lifecycle
        || existing?.target_message_id !== targetMessageId
        || (existing?.target_swipe_id ?? null) !== targetSwipeId)) {
      db.query(
        `DELETE FROM agent_activity_runs
          WHERE user_id = ? AND chat_id = ? AND generation_id = ?`,
      ).run(input.userId, input.chatId, input.generationId);
    }
  }
  try {
    const persisted = persistTerminalAgentActivityRunInTransaction(db, {
      userId: input.userId,
      chatId: input.chatId,
      generationId: input.generationId,
      targetMessageId,
      targetSwipeId,
      snapshot,
      status: lifecycle,
    });
    if (!persisted) throw new Error("agent activity compatibility projection unavailable");
  } catch (error) {
    if (
      (
        input.receiptRepair === true
        || input.recoveryRepair === true
        || input.preserveTerminalInspection === true
      )
      && error instanceof Error
      && error.message === "agent activity replay identity conflict"
    ) return;
    throw error;
  }
}

function eventForRun(run: AgentRunPublicV2, userId?: string): BufferedEvent {
  const eventPayload = {
    version: 2 as const,
    chatId: run.chatId,
    sequence: run.sequence,
    run,
    omission: run.omission,
  };
  return {
    event: AGENT_RUN_CHANGED,
    payload: eventPayload,
    userId,
  };
}

const emittedAgentRunEventKeys = new Set<string>();

function emittedEventKey(event: BufferedEvent): string | null {
  if (event.event !== AGENT_RUN_CHANGED || !event.userId) return null;
  const payload = event.payload;
  const chatId = payload && typeof payload === "object" && typeof payload.chatId === "string"
    ? payload.chatId
    : null;
  const sequence = payload && typeof payload === "object" && Number.isSafeInteger(payload.sequence)
    ? payload.sequence
    : null;
  if (!chatId || sequence === null || sequence < 1) return null;
  return `${event.userId}\u0000${chatId}\u0000${sequence}`;
}

function terminalOutboxIdentity(event: BufferedEvent): { userId: string; chatId: string; sequence: number } | null {
  const key = emittedEventKey(event);
  if (!key || !event.userId || !event.payload || typeof event.payload !== "object") return null;
  const payload = event.payload as Record<string, unknown>;
  const run = payload.run;
  if (!run || typeof run !== "object" || !isTerminal(run as AgentRunPublicV2)) return null;
  const chatId = typeof payload.chatId === "string" ? payload.chatId : null;
  const sequence = Number.isSafeInteger(payload.sequence) ? payload.sequence as number : null;
  if (!chatId || sequence === null || sequence < 1) return null;
  return { userId: event.userId, chatId, sequence };
}
function terminalProjectionEvent(event: BufferedEvent): boolean {
  if (event.event !== AGENT_RUN_CHANGED || !event.payload || typeof event.payload !== "object") return false;
  const run = (event.payload as Record<string, unknown>).run;
  return !!run && typeof run === "object" && !Array.isArray(run) && isTerminal(run as AgentRunPublicV2);
}

function hasTerminalOutboxDeliveryColumns(db: Database): boolean {
  if (!tableExists(db, "agent_chat_events")) return false;
  try {
    const columns = new Set((db.query("PRAGMA table_info('agent_chat_events')").all() as Array<{ name?: unknown }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === "string"));
    return columns.has("delivery_state")
      && columns.has("delivery_attempts")
      && columns.has("delivery_lease_token")
      && columns.has("delivery_lease_expires_at")
      && columns.has("delivered_at");
  } catch {
    return false;
  }
}
function resetTerminalOutboxLeases(db: Database, userId?: string): void {
  if (!hasTerminalOutboxDeliveryColumns(db)) return;
  const now = Math.floor(Date.now() / 1000);
  const processPrefix = `${TERMINAL_OUTBOX_PROCESS_ID}:`;
  const scope = userId ? " AND user_id = ?" : "";
  const bindings = userId
    ? [now, processPrefix, processPrefix, userId]
    : [now, processPrefix, processPrefix];
  db.query(
    `UPDATE agent_chat_events
        SET delivery_state = 'pending',
            delivery_lease_token = NULL,
            delivery_lease_expires_at = NULL
      WHERE event_kind = 'terminal'
        AND delivery_state = 'leased'
        AND (
          delivery_lease_expires_at IS NULL
          OR delivery_lease_expires_at <= ?
          OR delivery_lease_token IS NULL
          OR substr(delivery_lease_token, 1, length(?)) <> ?
        )${scope}`,
  ).run(...bindings);
}

function terminalOutboxLeaseToken(): string {
  return `${TERMINAL_OUTBOX_PROCESS_ID}:${randomUUID()}`;
}

/**
 * Claim one durable terminal outbox row. A lease is a retry fence: a clean
 * process restart skips rows marked delivered, while a crash before the
 * delivered marker leaves an expired lease that can be claimed again.
 */
function claimTerminalOutboxEvent(
  event: BufferedEvent,
  db: Database,
): { identity: { userId: string; chatId: string; sequence: number }; token: string } | false | null {
  const identity = terminalOutboxIdentity(event);
  if (!identity) return null;
  if (!hasTerminalOutboxDeliveryColumns(db)) return null;
  const row = db.query(
    `SELECT delivery_state, delivery_attempts, delivery_lease_expires_at
       FROM agent_chat_events
      WHERE user_id = ? AND chat_id = ? AND sequence = ? AND event_kind = 'terminal'
      LIMIT 1`,
  ).get(identity.userId, identity.chatId, identity.sequence) as {
    delivery_state?: unknown;
    delivery_attempts?: unknown;
    delivery_lease_expires_at?: unknown;
  } | null;
  if (!row) return null;
  if (row.delivery_state === "delivered") return false;
  const now = Math.floor(Date.now() / 1000);
  const attempts = Number(row.delivery_attempts);
  if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts >= 100_000) return false;
  const token = terminalOutboxLeaseToken();
  const claimed = db.query(
    `UPDATE agent_chat_events
        SET delivery_state = 'leased',
            delivery_attempts = delivery_attempts + 1,
            delivery_lease_token = ?,
            delivery_lease_expires_at = ?
      WHERE user_id = ? AND chat_id = ? AND sequence = ?
        AND event_kind = 'terminal'
        AND delivery_state <> 'delivered'
        AND (delivery_state = 'pending' OR (delivery_state = 'leased' AND delivery_lease_expires_at <= ?))`,
  ).run(token, now + TERMINAL_OUTBOX_LEASE_SECONDS, identity.userId, identity.chatId, identity.sequence, now);
  return claimed.changes === 1 ? { identity, token } : false;

}
function markTerminalOutboxDelivered(
  identity: { userId: string; chatId: string; sequence: number },
  token: string,
  db: Database,
): boolean {
  if (!hasTerminalOutboxDeliveryColumns(db)) return false;
  const result = db.query(
    `UPDATE agent_chat_events
        SET delivery_state = 'delivered',
            delivered_at = unixepoch(),
            delivery_lease_token = NULL,
            delivery_lease_expires_at = NULL
      WHERE user_id = ? AND chat_id = ? AND sequence = ?
        AND event_kind = 'terminal'
        AND delivery_state = 'leased'
        AND delivery_lease_token = ?`,
  ).run(identity.userId, identity.chatId, identity.sequence, token);
  return result.changes === 1;
}
function releaseTerminalOutboxLease(
  identity: { userId: string; chatId: string; sequence: number },
  token: string,
  db: Database,
): void {
  if (!hasTerminalOutboxDeliveryColumns(db)) return;
  db.query(
    `UPDATE agent_chat_events
        SET delivery_state = 'pending',
            delivery_lease_token = NULL,
            delivery_lease_expires_at = NULL
      WHERE user_id = ? AND chat_id = ? AND sequence = ?
        AND event_kind = 'terminal'
        AND delivery_state = 'leased'
        AND delivery_lease_token = ?`,
  ).run(identity.userId, identity.chatId, identity.sequence, token);
}

function rememberEmittedEventKey(key: string): void {
  if (emittedAgentRunEventKeys.size >= MAX_EMITTED_EVENT_KEYS) {
    const oldest = emittedAgentRunEventKeys.values().next().value;
    if (typeof oldest === "string") emittedAgentRunEventKeys.delete(oldest);
  }
  emittedAgentRunEventKeys.add(key);
}

/**
 * Publish an already-durable Agent run event once per process. Terminal rows
 * use the SQLite outbox marker as the restart-safe idempotency authority.
 */
export function emitAgentRunProjectionEvent(event: BufferedEvent, db: Database = getDb()): boolean {
  const key = emittedEventKey(event);
  if (key && emittedAgentRunEventKeys.has(key)) return false;
  const terminalEvent = terminalProjectionEvent(event);
  const claim = claimTerminalOutboxEvent(event, db);
  if (terminalEvent && !claim) return false;
  let accepted = false;
  try {
    accepted = eventBus.emit(event.event, event.payload, event.userId, event.options);
  } catch {
    if (claim) releaseTerminalOutboxLease(claim.identity, claim.token, db);
    return false;
  }
  if (claim && !accepted) {
    releaseTerminalOutboxLease(claim.identity, claim.token, db);
    return false;
  }
  if (claim && !markTerminalOutboxDelivered(claim.identity, claim.token, db)) return false;
  if (key) rememberEmittedEventKey(key);
  return !claim || accepted;
}
function epochSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) return Math.floor(Date.now() / 1000);
  return value >= 100_000_000_000 ? Math.floor(value / 1000) : value;
}


function repairFailedProjectionFromReceipt(
  db: Database,
  execution: Pick<
    TurnExecutionRecord,
    | "id"
    | "userId"
    | "chatId"
    | "generationId"
    | "targetKind"
    | "targetMessageId"
    | "targetSwipeId"
  >,
  receipt: Pick<TurnCommitReceipt, "id" | "messageId" | "swipeId">,
  existing: AgentRunPublicV2,
  options: AgentRunReceiptRepairOptions = {},
): AgentRunProjectionCommitResult {
  if (!validId(receipt.id)) {
    throw new Error("agent run receipt identity is unavailable");
  }
  const messageId = receipt.messageId ?? execution.targetMessageId;
  const swipeId = messageId === null
    ? null
    : receipt.swipeId ?? execution.targetSwipeId ?? 0;
  const historicalTargetRedaction = options.historicalTargetRedaction === true
    && messageId === null
    && execution.targetMessageId === null;
  if (messageId !== null && !assertStoredTarget(db, execution.chatId, messageId, swipeId, execution.targetKind)) {
    throw new Error("agent run receipt target is unavailable");
  }

  if (existing.generationId !== execution.generationId) {
    throw new Error("agent run receipt generation identity conflicts with failed projection");
  }
  if (existing.generationType !== execution.targetKind) {
    throw new Error("agent run receipt generation type conflicts with failed projection");
  }
  const existingTargetMessageId = existing.target?.messageId ?? null;
  const existingTargetSwipeId = existing.target?.swipeId ?? null;
  if (!historicalTargetRedaction && existingTargetMessageId !== null && existingTargetMessageId !== messageId) {
    throw new Error("agent run receipt target conflicts with failed projection");
  }
  if (!historicalTargetRedaction && existingTargetSwipeId !== null && existingTargetSwipeId !== swipeId) {
    throw new Error("agent run receipt swipe conflicts with failed projection");
  }
  const priorHandoff = existing.terminalHandoff;
  if (priorHandoff?.committed === true) {
    throw new Error("agent run failed projection has a committed handoff");
  }
  if (!historicalTargetRedaction
    && priorHandoff?.messageId !== undefined
    && priorHandoff.messageId !== null
    && priorHandoff.messageId !== messageId) {
    throw new Error("agent run receipt target conflicts with failed handoff");
  }
  if (!historicalTargetRedaction
    && priorHandoff?.swipeId !== undefined
    && priorHandoff.swipeId !== null
    && priorHandoff.swipeId !== swipeId) {
    throw new Error("agent run receipt swipe conflicts with failed handoff");
  }
  const priorErrorTarget = existing.error?.target;
  if (!historicalTargetRedaction
    && priorErrorTarget?.messageId !== null
    && priorErrorTarget?.messageId !== undefined
    && priorErrorTarget.messageId !== messageId) {
    throw new Error("agent run receipt target conflicts with failed error evidence");
  }
  if (!historicalTargetRedaction
    && priorErrorTarget?.swipeId !== null
    && priorErrorTarget?.swipeId !== undefined
    && priorErrorTarget.swipeId !== swipeId) {
    throw new Error("agent run receipt swipe conflicts with failed error evidence");
  }

  const priorLineageTarget = existing.attemptLineage.target;
  if (priorLineageTarget.chatId !== existing.chatId
    || priorLineageTarget.generationType !== existing.generationType) {
    throw new Error("agent run receipt lineage identity conflicts with failed projection");
  }
  if (!historicalTargetRedaction
    && priorLineageTarget.messageId !== null
    && priorLineageTarget.messageId !== messageId) {
    throw new Error("agent run receipt lineage target conflicts with failed projection");
  }
  if (!historicalTargetRedaction
    && priorLineageTarget.swipeId !== null
    && priorLineageTarget.swipeId !== swipeId) {
    throw new Error("agent run receipt lineage swipe conflicts with failed projection");
  }

  const targetIdentity = {
    chatId: existing.chatId,
    generationType: existing.generationType,
    messageId,
    swipeId,
  };
  const committedRevision = messageId !== null && tableExists(db, "messages")
    ? (() => {
        const row = db.query(
          "SELECT generation_revision FROM messages WHERE id = ? AND chat_id = ? LIMIT 1",
        ).get(messageId, execution.chatId) as { generation_revision?: unknown } | null;
        const value = Number(row?.generation_revision);
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
      })()
    : null;
  const messageRevision = messageId === null
    ? null
    : committedRevision ?? priorHandoff?.messageRevision ?? 0;
  const swipeRevision = swipeId === null ? null : messageRevision;
  const repairReason = options.reason ?? "reconciliation_required";
  const reconciliationError = {
    ...(options.error ?? existing.error ?? {
      code: "projection_unavailable",
      recoveryEligible: true,
      recoveryAction: "resync" as const,
    }),
    target: targetIdentity,
    workPhase: "TERMINAL" as const,
    workStatus: "terminal" as const,
    workOutcome: "completed" as const,
    reason: repairReason,
  };
  return publishAgentRunCommit(db, {
    userId: execution.userId,
    chatId: execution.chatId,
    turnId: execution.id,
    generationId: existing.generationId,
    generationType: execution.targetKind,
    targetMessageId: messageId,
    targetSwipeId: swipeId,
    attemptLineage: {
      ...existing.attemptLineage,
      target: targetIdentity,
    },
    status: "COMMITTED",
    phase: "COMMITTED",
    workPhase: "TERMINAL",
    workStatus: "terminal",
    workOutcome: "completed",
    reason: repairReason,
    error: reconciliationError,
    startedAt: existing.startedAt,
    updatedAt: existing.updatedAt,
    activity: existing.activity,
    usage: existing.usage,
    omission: existing.omission,
    terminalHandoff: {
      version: 2,
      committed: true,
      messageId,
      swipeId,
      messageRevision,
      swipeRevision,
    },
    receiptId: receipt.id,
    receiptRepair: true,
  });
}

function isRepairableCommitFailure(
  row: StoredProjectionRow,
  run: AgentRunPublicV2 | null,
): run is AgentRunPublicV2 {
  return row.status === "COMMIT_FAILED"
    && row.phase === "COMMIT_FAILED"
    && run?.workStatus === "terminal"
    && run.workOutcome === "failed";
}

function repairExistingReceiptProjection(
  db: Database,
  execution: Pick<
    TurnExecutionRecord,
    | "id"
    | "userId"
    | "chatId"
    | "generationId"
    | "targetKind"
    | "targetMessageId"
    | "targetSwipeId"
  >,
  receipt: Pick<TurnCommitReceipt, "id" | "messageId" | "swipeId">,
  options: AgentRunReceiptRepairOptions = {},
): AgentRunProjectionCommitResult | null {
  if (!validId(receipt.id)) {
    throw new Error("agent run receipt identity is unavailable");
  }
  const projectionRow = getProjectionRow(db, execution.userId, execution.chatId, execution.id);
  if (!projectionRow) return null;
  const existing = parseStoredRun(projectionRow);
  if (projectionRow.status === "COMMITTED") {
    if (projectionRow.phase !== "COMMITTED") {
      throw new Error("agent run receipt repair conflicts with terminal projection");
    }
    if (!existing) {
      throw new Error("agent run receipt repair projection unavailable");
    }
    const messageId = receipt.messageId ?? execution.targetMessageId;
    const swipeId = messageId === null
      ? null
      : receipt.swipeId ?? execution.targetSwipeId ?? 0;
    const historicalTargetRedaction = options.historicalTargetRedaction === true
      && messageId === null
      && execution.targetMessageId === null;
    if (messageId !== null && !assertStoredTarget(db, execution.chatId, messageId, swipeId, execution.targetKind)) {
      throw new Error("agent run receipt target is unavailable");
    }
    if (
      existing.chatId !== execution.chatId
      || existing.runId !== execution.generationId
      || existing.turnId !== execution.id
      || existing.generationId !== execution.generationId
      || existing.generationType !== execution.targetKind
    ) {
      throw new Error("agent run receipt identity conflicts with terminal projection");
    }
    const existingTargetMessageId = existing.target?.messageId ?? null;
    const existingTargetSwipeId = existing.target?.swipeId ?? null;
    if (!historicalTargetRedaction && existingTargetMessageId !== null && existingTargetMessageId !== messageId) {
      throw new Error("agent run receipt target conflicts with terminal projection");
    }
    if (!historicalTargetRedaction && existingTargetSwipeId !== null && existingTargetSwipeId !== swipeId) {
      throw new Error("agent run receipt swipe conflicts with terminal projection");
    }
    const priorHandoff = existing.terminalHandoff;
    if (!historicalTargetRedaction
      && priorHandoff?.messageId !== undefined
      && priorHandoff.messageId !== null
      && priorHandoff.messageId !== messageId) {
      throw new Error("agent run receipt target conflicts with committed handoff");
    }
    if (!historicalTargetRedaction
      && priorHandoff?.swipeId !== undefined
      && priorHandoff.swipeId !== null
      && priorHandoff.swipeId !== swipeId) {
      throw new Error("agent run receipt swipe conflicts with committed handoff");
    }
    const priorErrorTarget = existing.error?.target;
    if (!historicalTargetRedaction
      && priorErrorTarget?.messageId !== null
      && priorErrorTarget?.messageId !== undefined
      && priorErrorTarget.messageId !== messageId) {
      throw new Error("agent run receipt target conflicts with committed error evidence");
    }
    if (!historicalTargetRedaction
      && priorErrorTarget?.swipeId !== null
      && priorErrorTarget?.swipeId !== undefined
      && priorErrorTarget.swipeId !== swipeId) {
      throw new Error("agent run receipt swipe conflicts with committed error evidence");
    }
    const priorLineageTarget = existing.attemptLineage.target;
    if (priorLineageTarget.chatId !== existing.chatId
      || priorLineageTarget.generationType !== existing.generationType) {
      throw new Error("agent run receipt lineage identity conflicts with terminal projection");
    }
    if (!historicalTargetRedaction
      && priorLineageTarget.messageId !== null
      && priorLineageTarget.messageId !== messageId) {
      throw new Error("agent run receipt lineage target conflicts with terminal projection");
    }
    if (!historicalTargetRedaction
      && priorLineageTarget.swipeId !== null
      && priorLineageTarget.swipeId !== swipeId) {
      throw new Error("agent run receipt lineage swipe conflicts with terminal projection");
    }
    const targetIdentity = {
      chatId: existing.chatId,
      generationType: existing.generationType,
      messageId,
      swipeId,
    };
    const projectionTargetRepairNeeded = historicalTargetRedaction
      ? priorHandoff?.committed !== true
        || existingTargetMessageId !== null
        || existingTargetSwipeId !== null
        || priorHandoff?.messageId != null
        || priorHandoff?.swipeId != null
        || priorLineageTarget.messageId !== null
        || priorLineageTarget.swipeId !== null
        || priorErrorTarget?.messageId != null
        || priorErrorTarget?.swipeId != null
      : priorHandoff?.committed !== true
        || (messageId !== null
          && (
            existingTargetMessageId === null
            || priorHandoff?.messageId == null
            || priorLineageTarget.messageId === null
            || (existing.error != null && priorErrorTarget?.messageId == null)
          ))
        || (swipeId !== null
          && (
            existingTargetSwipeId === null
            || priorHandoff?.swipeId == null
            || priorLineageTarget.swipeId === null
            || (existing.error != null && priorErrorTarget?.swipeId == null)
          ));
    const durableTerminalEvent = hasDurableTerminalEvent(db, execution.userId, existing);
    return publishAgentRunCommit(db, {
      userId: execution.userId,
      chatId: execution.chatId,
      turnId: execution.id,
      generationId: execution.generationId,
      generationType: execution.targetKind,
      targetMessageId: messageId,
      targetSwipeId: swipeId,
      attemptLineage: {
        ...existing.attemptLineage,
        target: targetIdentity,
      },
      status: "COMMITTED",
      phase: "COMMITTED",
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "completed",
      reason: options.reason ?? existing.reason,
      ...(options.error !== undefined
        ? { error: options.error }
        : existing.error ? { error: existing.error } : {}),
      revision: durableTerminalEvent && !projectionTargetRepairNeeded
        ? projectionRow.revision
        : projectionRow.revision + 1,
      startedAt: existing.startedAt,
      updatedAt: existing.updatedAt,
      activity: existing.activity,
      usage: existing.usage,
      omission: existing.omission,
      terminalHandoff: {
        version: 2,
        committed: true,
        messageId,
        swipeId,
        messageRevision: priorHandoff?.messageRevision ?? null,
        swipeRevision: priorHandoff?.swipeRevision ?? null,
      },
      receiptId: receipt.id,
      receiptRepair: true,
    });
  }
  if (projectionRow.status !== "COMMIT_FAILED") {
    if (projectionRow.phase === "COMMIT_FAILED" || existing?.workStatus === "terminal") {
      throw new Error("agent run receipt repair conflicts with terminal projection");
    }
    return null;
  }
  if (!isRepairableCommitFailure(projectionRow, existing)) {
    throw new Error("agent run receipt repair conflicts with terminal projection");
  }
  return repairFailedProjectionFromReceipt(db, execution, receipt, existing, options);
}

/**
 * Rebuild the public terminal handoff from a durable commit receipt. This is
 * intentionally limited to receipt-owned identifiers and a bounded root
 * chronology; it never reads or replays render guidance, work notes, provider
 * output, or any other transient frame data. Callers that need the phase
 * transition and projection to be atomic must invoke this inside their
 * SQLite transaction.
 */
export function repairAgentRunProjectionFromReceipt(
  db: Database,
  execution: Pick<
    TurnExecutionRecord,
    | "id"
    | "userId"
    | "chatId"
    | "generationId"
    | "targetKind"
    | "targetMessageId"
    | "targetSwipeId"
    | "targetMessageRevision"
    | "createdAt"
    | "updatedAt"
  > & Partial<Pick<TurnExecutionRecord, "attemptLineage">>,
  receipt: Pick<TurnCommitReceipt, "id" | "messageId" | "swipeId" | "createdAt">,
  options: AgentRunReceiptRepairOptions = {},
): AgentRunProjectionCommitResult {
  if (!validId(receipt.id)) {
    throw new Error("agent run receipt identity is unavailable");
  }
  if (!tableExists(db, "agent_run_projections") || !tableExists(db, "agent_chat_events")) {
    throw new Error("agent run projection schema is unavailable");
  }
  const existingFailure = repairExistingReceiptProjection(db, execution, receipt, options);
  if (existingFailure) return existingFailure;
  const messageId = receipt.messageId ?? execution.targetMessageId;
  const swipeId = messageId === null
    ? null
    : receipt.swipeId ?? execution.targetSwipeId ?? 0;
  let committedRevision: number | null = null;
  if (messageId !== null && tableExists(db, "messages")) {
    const row = db.query(
      "SELECT generation_revision FROM messages WHERE id = ? AND chat_id = ? LIMIT 1",
    ).get(messageId, execution.chatId) as { generation_revision?: unknown } | null;
    if (row && Number.isSafeInteger(Number(row.generation_revision)) && Number(row.generation_revision) >= 0) {
      committedRevision = Number(row.generation_revision);
    }
  }
  const messageRevision = messageId === null
    ? null
    : committedRevision ?? execution.targetMessageRevision ?? 0;
  const swipeRevision = swipeId === null ? null : messageRevision;
  const timestamp = epochSeconds(receipt.createdAt || execution.updatedAt || execution.createdAt);
  const revision = getProjectionRow(db, execution.userId, execution.chatId, execution.id)?.revision;
  return publishAgentRunCommit(db, {
    userId: execution.userId,
    chatId: execution.chatId,
    turnId: execution.id,
    generationId: execution.generationId,
    generationType: execution.targetKind,
    targetMessageId: messageId,
    targetSwipeId: swipeId,
    status: "COMMITTED",
    ...(revision !== undefined ? { revision: revision + 1 } : {}),
    ...(execution.attemptLineage ? { attemptLineage: execution.attemptLineage } : {}),
    startedAt: epochSeconds(execution.createdAt),
    updatedAt: timestamp,
    activity: [],
    workPhase: "TERMINAL",
    workStatus: "terminal",
    workOutcome: "completed",
    reason: options.reason ?? null,
    ...(options.error ? { error: options.error } : {}),
    terminalHandoff: {
      version: 2,
      committed: true,
      messageId,
      swipeId,
      messageRevision,
      swipeRevision,
    },
    receiptId: receipt.id,
    receiptRepair: true,
  });
}
/**
 * Append the terminal public projection for a startup-interrupted execution.
 * This helper is called from the turn reconciler's transaction and consumes
 * only durable execution/projection fields; it never invokes runtime code.
 */
export function repairAgentRunProjectionFromInterruptedExecution(
  db: Database,
  execution: Pick<
    TurnExecutionRecord,
    | "id"
    | "userId"
    | "chatId"
    | "generationId"
    | "targetKind"
    | "targetMessageId"
    | "targetSwipeId"
    | "createdAt"
    | "updatedAt"
  >,
  status: "FAILED" | "COMMIT_FAILED",
): AgentRunProjectionCommitResult {
  if (!tableExists(db, "agent_run_projections") || !tableExists(db, "agent_chat_events")) {
    throw new Error("agent run projection schema is unavailable");
  }
  const existingRow = getProjectionByTurn(db, execution.userId, execution.id);
  const existing = existingRow ? parseStoredRun(existingRow) : null;
  const requestedMessageId = existing?.target?.messageId ?? execution.targetMessageId;
  const requestedSwipeId = existing?.target?.swipeId ?? execution.targetSwipeId;
  const targetValid = assertStoredTarget(db, execution.chatId, requestedMessageId, requestedSwipeId, execution.targetKind);
  const targetMessageId = targetValid ? requestedMessageId : null;
  const targetSwipeId = targetMessageId === null ? null : requestedSwipeId ?? 0;
  return publishAgentRunCommit(db, {
    userId: execution.userId,
    chatId: execution.chatId,
    turnId: execution.id,
    generationId: execution.generationId,
    generationType: execution.targetKind,
    targetMessageId,
    targetSwipeId,
    status,
    revision: (existing?.revision ?? 0) + 1,
    startedAt: epochSeconds(existing?.startedAt ?? execution.createdAt),
    updatedAt: epochSeconds(execution.updatedAt),
    activity: existing?.activity ?? [],
    usage: existing?.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
      childInvocations: 0,
    },
    omission: existing?.omission ?? emptyOmission(),
    workPhase: "TERMINAL",
    workStatus: "terminal",
    workOutcome: "failed",
    reason: status === "COMMIT_FAILED" ? "commit_failed" : "failed",
    error: { code: "internal_error" },
    terminalHandoff: null,
    recoveryRepair: true,
  });
}


/**
 * Append one status snapshot inside the caller-owned synchronous SQLite
 * transaction. No provider, tool, callback, or websocket operation occurs
 * before the outer transaction commits.
 */
export function appendAgentRunSnapshot(
  db: Database,
  input: AgentRunProjectionInputV2,
): AgentRunProjectionCommitResult {
  return writeProjection(db, input);
}

/** Terminal commit hook. The compatibility activity projection is written in this same transaction. */
export function publishAgentRunCommit(
  db: Database,
  input: AgentRunProjectionInputV2,
): AgentRunProjectionCommitResult {
  const requestedState = normalizeStoredState(input.status ?? input.phase ?? input.workPhase);
  if (input.workStatus !== "terminal" && !TERMINAL_STATES.has(requestedState)) {
    throw new Error("agent run commit hook requires a terminal status");
  }
  return writeProjection(db, input);
}

function writeProjection(db: Database, rawInput: AgentRunProjectionInputV2): AgentRunProjectionCommitResult {
  const targetSwipeId = coerceNonNegativeSafeInteger(rawInput.targetSwipeId);
  if ((rawInput.targetMessageId !== undefined && rawInput.targetMessageId !== null && !validId(rawInput.targetMessageId))
    || (rawInput.targetSwipeId !== undefined && rawInput.targetSwipeId !== null && !Number.isSafeInteger(targetSwipeId))) {
    throw new Error("agent run target association mismatch");
  }
  const input: AgentRunProjectionInputV2 = targetSwipeId === rawInput.targetSwipeId
    ? rawInput
    : { ...rawInput, targetSwipeId: targetSwipeId ?? null };
  if (rawInput.receiptRepair === true && !validId(rawInput.receiptId)) {
    throw new Error("agent run receipt identity is unavailable");
  }
  if (!assertOwnedTarget(db, input)) throw new Error("agent run projection ownership mismatch");
  const existingRow = getProjectionRow(db, input.userId, input.chatId, input.turnId);
  const existing = existingRow ? (parseStoredRun(existingRow) ?? undefined) : undefined;
  const receiptRepairRequested = input.receiptRepair === true;
  const receiptFailureRepair = receiptRepairRequested
    && existingRow?.status === "COMMIT_FAILED"
    && existingRow.phase === "COMMIT_FAILED"
    && existing?.workStatus === "terminal"
    && existing?.workOutcome === "failed"
    && normalizeStoredState(input.status ?? input.phase ?? input.workPhase) === "COMMITTED"
    && input.workStatus === "terminal"
    && input.workOutcome === "completed"
    && input.terminalHandoff?.committed === true;
  const receiptEventRepair = receiptRepairRequested
    && (!existing
      || existingRow?.status === "COMMITTED" && !hasDurableTerminalEvent(db, input.userId, existing));
  const receiptRepairNeeded = receiptFailureRepair || receiptEventRepair;
  const receiptInspectionRepairNeeded = receiptRepairRequested
    && existingRow?.status === "COMMITTED"
    && existing?.workPhase === "TERMINAL"
    && existing.workStatus === "terminal"
    && existing.workOutcome === "completed"
    && existing.terminalHandoff?.committed === true
    && normalizeStoredState(input.status ?? input.phase ?? input.workPhase) === "COMMITTED"
    && input.workStatus === "terminal"
    && input.workOutcome === "completed"
    && input.terminalHandoff?.committed === true
    && tableExists(db, "agent_run_attempts")
    && Boolean(db.query(
      `SELECT 1
         FROM agent_run_attempts
        WHERE user_id = ? AND attempt_id = ?
          AND terminal = 1 AND lifecycle = 'TERMINAL'
          AND status = 'terminal' AND outcome = 'failed'
        LIMIT 1`,
    ).get(input.userId, existing.attemptLineage.attemptId));
  const rawSnapshot = (() => {
    try {
      const parsed = JSON.parse(String(existingRow?.snapshot_json ?? "null"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  })();
  const rawSnapshotOutcome = rawSnapshot?.workOutcome;
  const rawSnapshotError = rawSnapshot?.error && typeof rawSnapshot.error === "object" && !Array.isArray(rawSnapshot.error)
    ? rawSnapshot.error as Record<string, unknown>
    : null;
  const exhaustedSnapshotRepair = input.recoveryRepair === true
    && existingRow?.status === "EXHAUSTED"
    && existingRow.phase === "EXHAUSTED"
    && normalizeStoredState(input.status ?? input.phase ?? input.workPhase) === "EXHAUSTED"
    && input.workOutcome === "exhausted"
    && rawSnapshotOutcome !== "exhausted";
  const rejectedRepairBase = input.terminalRejectedOutcomeRepair === true
    && existingRow?.status === "FAILED"
    && existingRow.phase === "FAILED"
    && existing?.workStatus === "terminal"
    && rawSnapshotOutcome === "failed"
    && rawSnapshotError?.workOutcome === "failed"
    && (existing?.terminalHandoff === null || existing?.terminalHandoff?.committed === false)
    && normalizeStoredState(input.status ?? input.phase ?? input.workPhase) === "FAILED"
    && input.workStatus === "terminal"
    && input.workOutcome === "rejected"
    && input.error?.workOutcome === "rejected"
    && (input.terminalHandoff === null || input.terminalHandoff?.committed === false)
    && input.receiptId === undefined
    && tableExists(db, "agent_turn_commit_receipts")
    && !db.query(
      "SELECT 1 FROM agent_turn_commit_receipts WHERE user_id = ? AND (execution_id = ? OR turn_id = ?) LIMIT 1",
    ).get(input.userId, input.turnId, input.turnId);
  const staleDecisionRejectedRepair = rejectedRepairBase
    && rawSnapshot?.reason === "stale_input"
    && rawSnapshotError?.code === "decision_refresh_required"
    && input.reason === "stale_input"
    && input.error?.code === "decision_refresh_required";
  const prematurePhaseRejectedRepair = rejectedRepairBase
    && rawSnapshot?.reason === "failed"
    && rawSnapshotError?.code === "internal_error"
    && input.reason === "invalid_input"
    && input.error?.code === "invalid_input";
  const terminalRejectedOutcomeRepair = staleDecisionRejectedRepair || prematurePhaseRejectedRepair;
  const recoveryRepairNeeded = (
    input.recoveryRepair === true && !!existing && (!isTerminal(existing) || exhaustedSnapshotRepair)
  ) || terminalRejectedOutcomeRepair;
  if (existing && (
    (input.revision !== undefined && input.revision <= existing.revision)
    || (isTerminal(existing) && !receiptRepairNeeded && !recoveryRepairNeeded)
  )) {
    if (receiptInspectionRepairNeeded) {
      persistInspectionRepairMarker(db, input, existing);
    }
    return {
      run: existing,
      sequence: existing.sequence,
      revision: existing.revision,
      event: eventForRun(existing, input.userId),
      changed: false,
    };
  }
  const revision = input.revision === undefined
    ? (existing?.revision ?? 0) + 1
    : Math.max(1, Math.floor(input.revision));
  if (existing && revision <= existing.revision) {
    return {
      run: existing,
      sequence: existing.sequence,
      revision: existing.revision,
      event: eventForRun(existing, input.userId),
      changed: false,
    };
  }
  const sequence = allocateChatSequence(db, input.userId, input.chatId);
  const run = normalizeRun(input, sequence, revision, existing, terminalRejectedOutcomeRepair);
  if (!run) throw new Error("invalid agent run projection");
  const storedState = input.status !== undefined
    ? normalizeStoredState(input.status)
    : input.phase !== undefined
      ? normalizeStoredState(input.phase)
      : storedStateForRun(run);
  const snapshotJson = boundedBytesJson(run, AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1.projectionSnapshotBytes);
  const handoffJson = run.terminalHandoff
    ? boundedBytesJson(run.terminalHandoff, AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1.projectionHandoffBytes)
    : null;
  const omissionJson = boundedBytesJson(run.omission, AGENTIC_FINAL_RENDER_RESERVATION_COMPONENTS_V1.projectionOmissionBytes);
  if (!snapshotJson || !omissionJson || (run.terminalHandoff && !handoffJson)) {
    throw new Error("agent run projection exceeds storage bounds");
  }
  db.query(
    `INSERT INTO agent_run_projections
      (user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,

       target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
       snapshot_json, terminal_handoff_json, omission_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, turn_id) DO UPDATE SET
       generation_id = excluded.generation_id,
       generation_type = excluded.generation_type,
       target_message_id = excluded.target_message_id,
       target_swipe_id = excluded.target_swipe_id,
       status = excluded.status,
       phase = excluded.phase,
       revision = excluded.revision,
       sequence = excluded.sequence,
       started_at = excluded.started_at,
       updated_at = excluded.updated_at,
       snapshot_json = excluded.snapshot_json,
       terminal_handoff_json = excluded.terminal_handoff_json,
       omission_json = excluded.omission_json`,
  ).run(
    input.userId,
    input.chatId,
    input.turnId,
    run.generationId,
    run.generationType,
    run.target?.messageId ?? null,
    run.target?.swipeId ?? null,
    storedState,
    storedState,
    run.revision,
    run.sequence,
    run.startedAt,
    run.updatedAt,
    snapshotJson,
    handoffJson,
    omissionJson,
  );
  const eventKind = isTerminal(run) ? "terminal" : run.omission.omittedEventCount > 0 || run.omission.omittedNodeCount > 0 ? "omission" : "snapshot";
  db.query(
    `INSERT INTO agent_chat_events
      (user_id, chat_id, sequence, turn_id, generation_id, run_revision, status,
       event_kind, snapshot_json, terminal_handoff_json, omission_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.userId,
    input.chatId,
    run.sequence,
    run.turnId,
    run.generationId,
    run.revision,
    storedState,
    eventKind,
    snapshotJson,
    handoffJson,
    omissionJson,
  );
  persistCompatibilityProjection(db, input, run);
  if (input.preserveTerminalInspection !== true) persistInspectionRepairMarker(db, input, run);
  const event = eventForRun(run, input.userId);
  return { run, sequence, revision, event, changed: true };
}

/** Wrap a projection transaction and flush its websocket handoff only after commit. */
export function withAgentRunProjectionTransaction<T>(
  callback: (db: Database) => T,
): T {
  const db = getDb();
  const buffered = eventBus.withBufferedEvents(() => db.transaction(() => {
    const value = callback(db);
    const candidate = value as unknown as { readonly event?: BufferedEvent; readonly changed?: boolean };
    const projectionEvent = candidate?.event;
    if (candidate?.changed !== false && projectionEvent?.event === AGENT_RUN_CHANGED) {
      eventBus.emit(
        projectionEvent.event,
        projectionEvent.payload,
        projectionEvent.userId,
        projectionEvent.options,
      );
    }
    return value;
  })());
  for (const event of buffered.events) {
    emitAgentRunProjectionEvent(event, db);
  }
  return buffered.value;
}
export interface AgentRunEventReplayResult {
  readonly inspected: number;
  readonly emitted: number;
  readonly skipped: number;
}

/**
 * Replay the durable terminal-event outbox after the EventBus has a live
 * server. Event sequence/revision is the stable idempotency key, so a crash
 * after SQLite commit and before websocket publication never reruns commit
 * side effects and repeat startup reconciliation is harmless.
 */
function drainPendingAgentRunEvents(
  db: Database,
  userId: string | undefined,
  options: { readonly maxRows?: number },
): AgentRunEventReplayResult {
  if (
    !tableExists(db, "agent_chat_events")
    || !tableExists(db, "agent_run_projections")
    || !hasTerminalOutboxDeliveryColumns(db)
  ) {
    return { inspected: 0, emitted: 0, skipped: 0 };
  }
  if (userId !== undefined && !validId(userId)) {
    return { inspected: 0, emitted: 0, skipped: 0 };
  }
  const requested = options.maxRows;
  const maxRows = typeof requested === "number" && Number.isSafeInteger(requested)
    ? Math.max(1, Math.min(requested, MAX_RECONCILIATION_ROWS))
    : MAX_RECONCILIATION_ROWS;
  resetTerminalOutboxLeases(db, userId);
  let inspected = 0;
  let emitted = 0;
  let skipped = 0;
  for (let batch = 0; batch < MAX_OUTBOX_REPLAY_BATCHES; batch += 1) {
    const emittedBeforeBatch = emitted;
    const scope = userId === undefined ? "" : " AND e.user_id = ?";
    const query = `SELECT e.user_id, e.chat_id, e.sequence, e.turn_id, e.run_revision, e.status,
              e.snapshot_json, e.terminal_handoff_json, e.omission_json
         FROM agent_chat_events e
         JOIN agent_run_projections p
           ON p.user_id = e.user_id AND p.chat_id = e.chat_id
          AND p.turn_id = e.turn_id AND p.sequence = e.sequence
          AND p.revision = e.run_revision
        WHERE e.event_kind = 'terminal'
          AND e.delivery_state <> 'delivered'${scope}
        ORDER BY e.sequence ASC
        LIMIT ?`;
    const rows = db.query(query).all(
      ...(userId === undefined ? [maxRows] : [userId, maxRows]),
    ) as Array<StoredEventRow & { user_id: string; chat_id: string }>;
    if (rows.length === 0) break;
    inspected += rows.length;
    for (const row of rows) {
      const parsed = parseStoredEvent(db, row.user_id, row, row.chat_id);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      if (emitAgentRunProjectionEvent(eventForRun(parsed.run, row.user_id), db)) emitted += 1;
    }
    if (emitted === emittedBeforeBatch && rows.length === maxRows) break;
    if (rows.length < maxRows) break;
  }
  return { inspected, emitted, skipped };
}

/**
 * Drain one authenticated user's terminal outbox after the socket has joined
 * that user's topic. Previous-process and expired leases for this user are
 * reset; a current-process lease remains fenced.
 */
export function drainPendingAgentRunEventsForUser(
  userId: string,
  db: Database = getDb(),
  options: { readonly maxRows?: number } = {},
): AgentRunEventReplayResult {
  return drainPendingAgentRunEvents(db, userId, options);
}

/** Compatibility helper for focused recovery tests and explicit all-user repair. */
export function replayPendingAgentRunEvents(
  db: Database = getDb(),
  options: { readonly maxRows?: number } = {},
): AgentRunEventReplayResult {
  return drainPendingAgentRunEvents(db, undefined, options);
}

/**
 * Cursor signing key. Chat cursors are the only owner-bound tokens this
 * service issues, so an unavailable application auth secret must fail closed:
 * a shared static fallback would make every cursor forgeable if the startup
 * identity derivation that populates `env.authSecret` ever regressed.
 */
function cursorKey(): Buffer | null {
  const configured = env.authSecret || process.env.AUTH_SECRET || "";
  return configured.length === 0 ? null : Buffer.from(configured, "utf8");
}

function encodeCursorPayload(claims: CursorClaims): string {
  return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

function signCursor(signingInput: string, key: Buffer): string {
  return createHmac("sha256", key).update(signingInput).digest("base64url");
}

function mintCursor(
  userId: string,
  chatId: string,
  lastSequence: number,
  now = Math.floor(Date.now() / 1000),
  resyncOffset?: number,
  resyncSnapshotId?: string,
  resyncOrdinal?: number,
  resyncExpiresAt?: number,
): ChatRunCursorV1 {
  // No signing key means no cursor: minting an unsigned or statically signed
  // token would hand the caller a forgeable watermark.
  const key = cursorKey();
  if (!key) throw new Error("agent run cursor signing key is unavailable");
  const expiresAt = resyncExpiresAt === undefined
    ? now + CURSOR_TTL_SECONDS
    : Math.min(now + CURSOR_TTL_SECONDS, resyncExpiresAt);
  const claims: CursorClaims = {
    v: 1,
    u: userId,
    c: chatId,
    s: lastSequence,
    e: expiresAt,
    ...(resyncOffset === undefined ? {} : { p: resyncOffset }),
    ...(resyncSnapshotId === undefined ? {} : { r: resyncSnapshotId }),
    ...(resyncOrdinal === undefined ? {} : { q: resyncOrdinal }),
  };
  const signingInput = `v1.${encodeCursorPayload(claims)}`;
  return { version: 1, token: `${signingInput}.${signCursor(signingInput, key)}` };
}



function invalidCursorClaims(): CursorClaims {
  return { v: 1, u: "", c: "", s: 0, e: 0 };
}

function decodeCursor(token: unknown): { claims: CursorClaims; reason: "ok" | "expired" | "invalid" } {
  if (typeof token !== "string" || token.length === 0 || encoder.encode(token).byteLength > MAX_CURSOR_BYTES) {
    return { claims: invalidCursorClaims(), reason: "invalid" };
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) {
    return { claims: invalidCursorClaims(), reason: "invalid" };
  }
  const key = cursorKey();
  if (!key) return { claims: invalidCursorClaims(), reason: "invalid" };
  const signingInput = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(signCursor(signingInput, key), "utf8");
  const provided = Buffer.from(parts[2]!, "utf8");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { claims: invalidCursorClaims(), reason: "invalid" };
  }
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Partial<CursorClaims>;
    if (
      claims.v !== 1
      || typeof claims.u !== "string"
      || typeof claims.c !== "string"
      || typeof claims.s !== "number"
      || typeof claims.e !== "number"
      || claims.p !== undefined && typeof claims.p !== "number"
      || claims.r !== undefined && typeof claims.r !== "string"
      || claims.q !== undefined && typeof claims.q !== "number"
    ) {
      throw new Error("invalid cursor claims");
    }
    if (
      !isSafeResyncCursorNumber(claims.s)
      || !Number.isSafeInteger(claims.e)
      || claims.p !== undefined && !isSafeResyncCursorNumber(claims.p)
      || claims.q !== undefined && !isSafeResyncCursorNumber(claims.q)
      || claims.r !== undefined && !validId(claims.r)
    ) {
      throw new Error("invalid cursor bounds");
    }
    if (claims.p !== undefined && claims.r === undefined) {
      throw new Error("paged cursor is missing its snapshot identity");
    }
    if (claims.p !== undefined && claims.q === undefined) {
      throw new Error("paged cursor is missing its snapshot continuation");
    }
    if (
      claims.p === undefined && (claims.r !== undefined || claims.q !== undefined)
      || claims.p !== undefined && claims.q !== undefined && claims.p !== claims.q + 1
    ) {
      throw new Error("paged cursor has an invalid snapshot continuation");
    }
    return {
      claims: claims as CursorClaims,
      reason: Math.floor(Date.now() / 1000) >= claims.e ? "expired" : "ok",
    };
  } catch {
    return { claims: invalidCursorClaims(), reason: "invalid" };
  }
}

function emptyOmission(): AgentOmissionMarkerV2 {
  return { omittedNodeCount: 0, omittedEventCount: 0, firstOmittedSequence: null, lastOmittedSequence: null };
}

function mergeOmission(a: AgentOmissionMarkerV2, b: AgentOmissionMarkerV2): AgentOmissionMarkerV2 {
  const omittedNodeCount = Math.min(MAX_SAFE_COUNTER, a.omittedNodeCount + b.omittedNodeCount);
  const omittedEventCount = Math.min(MAX_SAFE_COUNTER, a.omittedEventCount + b.omittedEventCount);
  return {
    omittedNodeCount,
    omittedEventCount,
    firstOmittedSequence: a.firstOmittedSequence ?? b.firstOmittedSequence,
    lastOmittedSequence: b.lastOmittedSequence ?? a.lastOmittedSequence,
  };
}

function sequenceBounds(db: Database, userId: string, chatId: string): { last: number; first: number | null } {
  const sequence = db.query(
    "SELECT last_sequence FROM agent_chat_event_sequences WHERE user_id = ? AND chat_id = ?",
  ).get(userId, chatId) as { last_sequence: number } | null;
  const first = tableExists(db, "agent_chat_events")
    ? tableExists(db, "agent_turn_executions")
      ? db.query(
        `SELECT MIN(e.sequence) AS first_sequence
           FROM agent_chat_events e
           JOIN agent_turn_executions t
             ON t.user_id = e.user_id AND t.id = e.turn_id AND t.chat_id = e.chat_id
          WHERE e.user_id = ? AND e.chat_id = ?
            AND ${executionVisibilitySql("t")}`,
      ).get(userId, chatId, Date.now()) as { first_sequence: number | null } | null
      : db.query(
        "SELECT MIN(sequence) AS first_sequence FROM agent_chat_events WHERE user_id = ? AND chat_id = ?",
      ).get(userId, chatId) as { first_sequence: number | null } | null
    : null;
  return { last: sequence?.last_sequence ?? 0, first: first?.first_sequence ?? null };
}

interface CurrentRunsPage {
  readonly runs: AgentRunPublicV2[];
  readonly totalRuns: number;
}

function listCurrentRuns(
  db: Database,
  userId: string,
  chatId: string,
  snapshotSequence: number,
  snapshotAt: number,
  pageLimit = MAX_RUNS,
): CurrentRunsPage {
  const withExecution = tableExists(db, "agent_turn_executions");
  const withHistoricalEvents = tableExists(db, "agent_chat_events");
  const sortExpression = `CASE
    WHEN json_valid(e.snapshot_json) = 1
      THEN COALESCE(CAST(json_extract(e.snapshot_json, '$.updatedAt') AS INTEGER), 0)
    ELSE 0
  END`;

  if (withHistoricalEvents) {
    const historicalCte = `WITH latest AS (
         SELECT user_id, chat_id, turn_id, MAX(sequence) AS sequence
           FROM agent_chat_events
          WHERE user_id = ? AND chat_id = ? AND sequence <= ?
          GROUP BY user_id, chat_id, turn_id
       ),
       visible AS (
         SELECT e.user_id, e.chat_id, e.sequence, e.turn_id, e.run_revision,
                e.status, e.snapshot_json, e.terminal_handoff_json, e.omission_json,
                ${sortExpression} AS sort_updated_at
           FROM latest l
           JOIN agent_chat_events e
             ON e.user_id = l.user_id AND e.chat_id = l.chat_id
            AND e.turn_id = l.turn_id AND e.sequence = l.sequence
           ${withExecution ? `JOIN agent_turn_executions t
             ON t.user_id = e.user_id AND t.id = e.turn_id AND t.chat_id = e.chat_id` : ""}
          WHERE 1 = 1
            ${withExecution ? `AND ${executionVisibilitySql("t")}` : ""}
       )`;
    const pageParameters: Array<string | number> = [userId, chatId, snapshotSequence];
    if (withExecution) pageParameters.push(snapshotAt);
    pageParameters.push(pageLimit);
    const rows = db.query(
      `${historicalCte}
       SELECT *
         FROM visible
        ORDER BY sort_updated_at DESC, turn_id DESC
        LIMIT ?`,
    ).all(...pageParameters) as Array<
      StoredEventRow & { user_id: string; chat_id: string; sort_updated_at: number }
    >;
    const runs = rows.map((row) => {
      const parsed = parseStoredEvent(db, userId, row, chatId);
      if (!parsed) throw new Error("agent run resync encountered malformed historical projection");
      return parsed.run;
    });
    const totalRuns = Number((db.query(
      `${historicalCte}
       SELECT COUNT(*) AS total
         FROM visible`,
    ).get(
      ...([userId, chatId, snapshotSequence, ...(withExecution ? [snapshotAt] : [])] as Array<string | number>),
    ) as { total?: unknown } | null)?.total ?? 0);
    const normalizedTotal = Number.isSafeInteger(totalRuns) && totalRuns >= 0 ? totalRuns : runs.length;
    return { runs, totalRuns: normalizedTotal };
  }

  let rows: StoredProjectionRow[];
  if (withExecution) {
    rows = db.query(
      `SELECT p.user_id, p.chat_id, p.turn_id, p.generation_id, p.generation_type,
              p.target_message_id, p.target_swipe_id, p.status, p.phase, p.revision,
              p.sequence, p.started_at, p.updated_at, p.snapshot_json,
              p.terminal_handoff_json, p.omission_json
         FROM agent_run_projections p
         JOIN agent_turn_executions t
           ON t.user_id = p.user_id AND t.id = p.turn_id AND t.chat_id = p.chat_id
        WHERE p.user_id = ? AND p.chat_id = ? AND p.sequence <= ?
          AND ${executionVisibilitySql("t")}
        ORDER BY p.updated_at DESC, p.turn_id DESC
        LIMIT ?`,
    ).all(userId, chatId, snapshotSequence, snapshotAt, pageLimit) as StoredProjectionRow[];
  } else {
    rows = db.query(
      `SELECT user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
              target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
              snapshot_json, terminal_handoff_json, omission_json
         FROM agent_run_projections
        WHERE user_id = ? AND chat_id = ? AND sequence <= ?
        ORDER BY updated_at DESC, turn_id DESC
        LIMIT ?`,
    ).all(userId, chatId, snapshotSequence, pageLimit) as StoredProjectionRow[];
  }
  const runs = rows.map((row) => {
    if (!assertStoredTarget(db, row.chat_id, row.target_message_id, row.target_swipe_id, row.generation_type)) {
      throw new Error("agent run resync encountered an invalid projection target");
    }
    const parsed = parseStoredRun(row);
    if (!parsed) throw new Error("agent run resync encountered malformed projection");
    return parsed;
  });
  const totalRuns = withExecution
    ? Number((db.query(
      `SELECT COUNT(*) AS total
         FROM agent_run_projections p
         JOIN agent_turn_executions t
           ON t.user_id = p.user_id AND t.id = p.turn_id AND t.chat_id = p.chat_id
        WHERE p.user_id = ? AND p.chat_id = ? AND p.sequence <= ?
          AND ${executionVisibilitySql("t")}`,
    ).get(userId, chatId, snapshotSequence, snapshotAt) as { total?: unknown } | null)?.total ?? 0)
    : Number((db.query(
      "SELECT COUNT(*) AS total FROM agent_run_projections WHERE user_id = ? AND chat_id = ? AND sequence <= ?",
    ).get(userId, chatId, snapshotSequence) as { total?: unknown } | null)?.total ?? 0);
  const normalizedTotal = Number.isSafeInteger(totalRuns) && totalRuns >= 0 ? totalRuns : runs.length;
  return { runs, totalRuns: normalizedTotal };
}
interface ResyncSnapshotMetadata {
  readonly snapshotId: string;
  readonly snapshotSequence: number;
  readonly totalRuns: number;
  readonly omittedOlderRuns: number;
  readonly expiresAt: number;
}

interface ResyncSnapshotMemberRow {
  readonly ordinal: number;
  readonly turn_id: string;
  readonly updated_at: number;
  readonly run_json: string;
}

interface ResyncSnapshotPage {
  readonly runs: AgentRunPublicV2[];
  readonly totalRuns: number;
  readonly omittedOlderRuns: number;
  readonly expiresAt: number;
  readonly lastOrdinal?: number;
}

function cleanupResyncSnapshots(db: Database, userId: string, nowSeconds: number): void {
  if (
    !tableExists(db, "agent_run_resync_snapshots")
    || !tableExists(db, "agent_run_resync_snapshot_members")
  ) return;
  db.query(
    `DELETE FROM agent_run_resync_snapshot_members
      WHERE snapshot_id IN (
        SELECT snapshot_id
          FROM agent_run_resync_snapshots
         WHERE user_id = ? AND expires_at <= ?
      )`,
  ).run(userId, nowSeconds);
  db.query(
    "DELETE FROM agent_run_resync_snapshots WHERE user_id = ? AND expires_at <= ?",
  ).run(userId, nowSeconds);
}


function parseResyncSnapshotRun(
  row: ResyncSnapshotMemberRow,
  userId: string,
  chatId: string,
  snapshotSequence: number,
): AgentRunPublicV2 | null {
  try {
    const decoded: unknown = JSON.parse(row.run_json);
    if (!isRecordValue(decoded)) return null;
    const parsed = decoded;
    const generationType = normalizeGenerationType(parsed.generationType);
    const workOutcome = parsed.workOutcome === null
      ? null
      : isAgentRunPublicOutcome(parsed.workOutcome) ? parsed.workOutcome : undefined;
    if (
      parsed.version !== 2
      || parsed.chatId !== chatId
      || parsed.runId !== parsed.generationId
      || parsed.turnId !== row.turn_id
      || !validId(parsed.runId)
      || !validId(parsed.turnId)
      || !validId(parsed.generationId)
      || !generationType
      || !isAgentRunPublicPhase(parsed.workPhase)
      || !isAgentRunPublicStatus(parsed.workStatus)
      || workOutcome === undefined
      || !isSafeResyncCursorNumber(parsed.sequence)
      || parsed.sequence < 1
      || parsed.sequence > snapshotSequence
      || !isSafeResyncCursorNumber(parsed.revision)
      || parsed.revision < 1
      || !isSafeResyncCursorNumber(parsed.startedAt)
      || !isSafeResyncCursorNumber(parsed.updatedAt)
      || parsed.updatedAt !== row.updated_at
    ) return null;
    const target = isRecordValue(parsed.target) ? parsed.target : null;
    const parsedError: AgentRunProjectionInputV2["error"] | undefined = isRecordValue(parsed.error)
      ? {
          code: parsed.error.code,
          category: parsed.error.category,
          summaryCode: parsed.error.summaryCode,
          recoveryEligible: parsed.error.recoveryEligible,
          recoveryAction: parsed.error.recoveryAction,
          target: parsed.error.target,
          workPhase: parsed.error.workPhase,
          workStatus: parsed.error.workStatus,
          workOutcome: parsed.error.workOutcome,
          reason: parsed.error.reason,
          omissionCount: parsed.error.omissionCount,
          inspectionAttemptId: parsed.error.inspectionAttemptId,
          retryable: parsed.error.retryable,
        }
      : parsed.error === null ? null : undefined;
    const storedState = storedStateForPublicProjection(
      parsed.workPhase,
      parsed.workStatus,
      workOutcome,
      parsedError?.code,
    );
    const canonical = normalizeRun({
      userId,
      chatId,
      turnId: parsed.turnId,
      generationId: parsed.generationId,
      generationType,
      targetMessageId: target?.messageId ?? null,
      targetSwipeId: target?.swipeId ?? null,
      status: storedState,
      phase: storedState,
      workPhase: parsed.workPhase,
      workStatus: parsed.workStatus,
      workOutcome,
      reason: parsed.reason,
      attemptLineage: parsed.attemptLineage,
      revision: parsed.revision,
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
      activity: parsed.activity,
      usage: parsed.usage,
      error: parsedError,
      terminalHandoff: parsed.terminalHandoff,
      omission: parsed.omission,
    }, parsed.sequence, parsed.revision);
    if (!canonical || JSON.stringify(canonical) !== JSON.stringify(parsed)) return null;
    return canonical;
  } catch {
    return null;
  }
}

function materializeResyncSnapshot(
  db: Database,
  userId: string,
  chatId: string,
  snapshotSequence: number,
  snapshotAt: number,
): ResyncSnapshotMetadata {
  if (
    !tableExists(db, "agent_run_resync_snapshots")
    || !tableExists(db, "agent_run_resync_snapshot_members")
  ) {
    throw new Error("agent run resync snapshot schema is unavailable");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  cleanupResyncSnapshots(db, userId, nowSeconds);
  const existing = db.query(
    `SELECT snapshot_id, snapshot_sequence, total_runs, omitted_runs, expires_at
       FROM agent_run_resync_snapshots
      WHERE user_id = ? AND chat_id = ? AND snapshot_sequence = ? AND expires_at > ?
      ORDER BY created_at DESC, snapshot_id DESC
      LIMIT 1`,
  ).get(userId, chatId, snapshotSequence, nowSeconds) as {
    snapshot_id: string;
    snapshot_sequence: number;
    total_runs: number;
    omitted_runs: number;
    expires_at: number;
  } | null;
  if (
    existing
    && validId(existing.snapshot_id)
    && existing.snapshot_sequence === snapshotSequence
    && Number.isSafeInteger(existing.total_runs)
    && existing.total_runs >= 0
    && existing.total_runs <= MAX_RESYNC_RUNS
    && Number.isSafeInteger(existing.omitted_runs)
    && existing.omitted_runs >= 0
    && Number.isSafeInteger(existing.expires_at)
    && existing.expires_at > nowSeconds
  ) {
    return {
      snapshotId: existing.snapshot_id,
      snapshotSequence,
      totalRuns: existing.total_runs,
      omittedOlderRuns: existing.omitted_runs,
      expiresAt: existing.expires_at,
    };
  }

  // Remove only a malformed same-watermark candidate. Active snapshots at
  // different watermarks may still back issued continuation cursors.
  if (existing) {
    db.query("DELETE FROM agent_run_resync_snapshot_members WHERE snapshot_id = ?")
      .run(existing.snapshot_id);
    db.query("DELETE FROM agent_run_resync_snapshots WHERE snapshot_id = ?")
      .run(existing.snapshot_id);
  }

  const source = listCurrentRuns(db, userId, chatId, snapshotSequence, snapshotAt, MAX_RESYNC_RUNS);
  if (source.runs.length > MAX_RESYNC_RUNS || source.runs.length > source.totalRuns) {
    throw new Error("agent run resync membership exceeds the retained snapshot bound");
  }
  const members: Array<{ readonly run: AgentRunPublicV2; readonly json: string; readonly bytes: number }> = [];
  let snapshotBytes = 0;
  for (const run of source.runs) {
    const json = JSON.stringify(run);
    const bytes = encoder.encode(json).byteLength;
    if (bytes > 65536) throw new Error("agent run resync snapshot member exceeds storage bounds");
    if (snapshotBytes + bytes > MAX_RESYNC_SNAPSHOT_BYTES) break;
    members.push({ run, json, bytes });
    snapshotBytes += bytes;
  }
  const omittedOlderRuns = Math.max(0, source.totalRuns - members.length);
  const ownerUsage = db.query(
    `SELECT COUNT(DISTINCT s.snapshot_id) AS snapshot_count,
            COALESCE(SUM(length(CAST(m.run_json AS BLOB))), 0) AS snapshot_bytes
       FROM agent_run_resync_snapshots s
       LEFT JOIN agent_run_resync_snapshot_members m ON m.snapshot_id = s.snapshot_id
      WHERE s.user_id = ? AND s.expires_at > ?`,
  ).get(userId, nowSeconds) as { snapshot_count?: unknown; snapshot_bytes?: unknown } | null;
  const ownerSnapshotCount = Number(ownerUsage?.snapshot_count ?? 0);
  const ownerSnapshotBytes = Number(ownerUsage?.snapshot_bytes ?? 0);
  if (
    !Number.isSafeInteger(ownerSnapshotCount)
    || ownerSnapshotCount >= MAX_ACTIVE_RESYNC_SNAPSHOTS_PER_OWNER
    || !Number.isSafeInteger(ownerSnapshotBytes)
    || ownerSnapshotBytes < 0
    || ownerSnapshotBytes + snapshotBytes > MAX_ACTIVE_RESYNC_BYTES_PER_OWNER
  ) {
    throw new Error("agent run resync snapshot owner quota exceeded");
  }

  const snapshotId = randomUUID();
  const expiresAt = nowSeconds + RESYNC_SNAPSHOT_TTL_SECONDS;
  db.query(
    `INSERT INTO agent_run_resync_snapshots
      (snapshot_id, user_id, chat_id, snapshot_sequence, snapshot_at, total_runs, omitted_runs, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(snapshotId, userId, chatId, snapshotSequence, snapshotAt, members.length, omittedOlderRuns, expiresAt);
  const insertMember = db.query(
    `INSERT INTO agent_run_resync_snapshot_members
      (snapshot_id, user_id, ordinal, turn_id, updated_at, run_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  members.forEach(({ run, json }, ordinal) => {
    insertMember.run(snapshotId, userId, ordinal, run.turnId, run.updatedAt, json);
  });
  return { snapshotId, snapshotSequence, totalRuns: members.length, omittedOlderRuns, expiresAt };
}

function readResyncSnapshotPage(
  db: Database,
  userId: string,
  chatId: string,
  snapshotId: string,
  snapshotSequence: number,
  afterOrdinal = -1,
): ResyncSnapshotPage {
  if (
    !tableExists(db, "agent_run_resync_snapshots")
    || !tableExists(db, "agent_run_resync_snapshot_members")
  ) {
    throw new Error("agent run resync snapshot schema is unavailable");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  cleanupResyncSnapshots(db, userId, nowSeconds);
  const metadata = db.query(
    `SELECT snapshot_sequence, total_runs, omitted_runs, expires_at
       FROM agent_run_resync_snapshots
      WHERE snapshot_id = ? AND user_id = ? AND chat_id = ? AND expires_at > ?
      LIMIT 1`,
  ).get(snapshotId, userId, chatId, nowSeconds) as {
    snapshot_sequence: number;
    total_runs: number;
    omitted_runs: number;
    expires_at: number;
  } | null;
  if (
    !metadata
    || metadata.snapshot_sequence !== snapshotSequence
    || !Number.isSafeInteger(metadata.snapshot_sequence)
    || metadata.snapshot_sequence < 0
    || !Number.isSafeInteger(metadata.total_runs)
    || metadata.total_runs < 0
    || metadata.total_runs > MAX_RESYNC_RUNS
    || !Number.isSafeInteger(metadata.omitted_runs)
    || metadata.omitted_runs < 0
    || !Number.isSafeInteger(metadata.expires_at)
    || metadata.expires_at <= nowSeconds
  ) {
    throw new Error("agent run resync snapshot is unavailable");
  }
  const membership = db.query(
    `SELECT COUNT(*) AS member_count,
            SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS owned_member_count,
            MIN(ordinal) AS first_ordinal,
            MAX(ordinal) AS last_ordinal
       FROM agent_run_resync_snapshot_members
      WHERE snapshot_id = ?`,
  ).get(userId, snapshotId) as {
    member_count?: unknown;
    owned_member_count?: unknown;
    first_ordinal?: unknown;
    last_ordinal?: unknown;
  } | null;
  const memberCount = Number(membership?.member_count ?? Number.NaN);
  const ownedMemberCount = Number(membership?.owned_member_count ?? 0);
  const exactMembership = Number.isSafeInteger(memberCount)
    && Number.isSafeInteger(ownedMemberCount)
    && ownedMemberCount === memberCount
    && memberCount === metadata.total_runs
    && (
      metadata.total_runs === 0
        ? membership?.first_ordinal === null && membership?.last_ordinal === null
        : membership?.first_ordinal === 0
          && membership?.last_ordinal === metadata.total_runs - 1
    );
  if (!exactMembership) {
    throw new Error("agent run resync snapshot membership is incomplete");
  }
  if (
    !Number.isSafeInteger(afterOrdinal)
    || afterOrdinal < -1
    || afterOrdinal !== -1 && afterOrdinal >= metadata.total_runs - 1
  ) {
    throw new Error("agent run resync snapshot continuation is out of range");
  }
  const rows = db.query(
    `SELECT ordinal, turn_id, updated_at, run_json
       FROM agent_run_resync_snapshot_members
      WHERE snapshot_id = ? AND user_id = ? AND ordinal > ?
      ORDER BY ordinal ASC
      LIMIT ?`,
  ).all(snapshotId, userId, afterOrdinal, MAX_RUNS) as ResyncSnapshotMemberRow[];
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]!.ordinal !== afterOrdinal + index + 1) {
      throw new Error("agent run resync snapshot membership has a discontinuous ordinal");
    }
  }
  const runs = rows.map((row) => {
    const run = parseResyncSnapshotRun(row, userId, chatId, snapshotSequence);
    if (!run) throw new Error("agent run resync snapshot contains malformed membership");
    return run;
  });
  if (afterOrdinal + runs.length + 1 < metadata.total_runs && runs.length < MAX_RUNS) {
    throw new Error("agent run resync snapshot membership is incomplete");
  }
  const lastOrdinal = rows.at(-1)?.ordinal;
  return {
    runs,
    totalRuns: metadata.total_runs,
    omittedOlderRuns: metadata.omitted_runs,
    expiresAt: metadata.expires_at,
    ...(lastOrdinal === undefined ? {} : { lastOrdinal }),
  };
}

export function getAgentRunChanges(userId: string, chatId: string, cursorToken?: unknown): AgentRunChangesV2 | null {
  const db = getDb();
  return db.transaction(() => {
    if (!validId(userId) || !validId(chatId) || !assertOwnedChat(db, userId, chatId)) return null;
    cleanupResyncSnapshots(db, userId, Math.floor(Date.now() / 1000));
    const decoded = decodeCursor(cursorToken);
    const bounds = sequenceBounds(db, userId, chatId);
    const cursorMatches = decoded.reason === "ok"
      && decoded.claims.u === userId
      && decoded.claims.c === chatId;
    const cursorSequence = cursorMatches ? decoded.claims.s : 0;
    const pagedResync = cursorMatches && decoded.claims.p !== undefined;
    const resyncOffset = pagedResync ? decoded.claims.p! : 0;
    const retentionGap = cursorMatches && bounds.first !== null && cursorSequence + 1 < bounds.first;
    const cursorAhead = cursorMatches && cursorSequence > bounds.last;
    const resync = !cursorMatches
      || decoded.reason === "expired"
      || retentionGap
      || cursorAhead
      || pagedResync;
    let combinedOmission: AgentOmissionMarkerV2 = resync
      && cursorMatches
      && bounds.first !== null
      && cursorSequence + 1 < bounds.first
      ? {
          ...emptyOmission(),
          omittedEventCount: bounds.first - cursorSequence - 1,
          firstOmittedSequence: cursorSequence + 1,
          lastOmittedSequence: bounds.first - 1,
        }
      : emptyOmission();
    const events: AgentRunChangeEventV2[] = [];

    if (resync) {
      // A paged resync keeps the event watermark and reads an owner-scoped,
      // persisted membership snapshot. Updates, expiry, deletion, and
      // malformed source rows therefore cannot shift a later page.
      const snapshotSequence = pagedResync ? Math.min(cursorSequence, bounds.last) : bounds.last;
      const snapshot = pagedResync
        ? {
            snapshotId: decoded.claims.r!,
            snapshotSequence,
            totalRuns: 0,
            omittedOlderRuns: 0,
            expiresAt: 0,
          }
        : materializeResyncSnapshot(db, userId, chatId, snapshotSequence, Date.now());
      const afterOrdinal = pagedResync ? decoded.claims.q ?? -1 : -1;
      const page = pagedResync
        ? readResyncSnapshotPage(db, userId, chatId, snapshot.snapshotId, snapshotSequence, afterOrdinal)
        : readResyncSnapshotPage(db, userId, chatId, snapshot.snapshotId, snapshotSequence);
      const complete = resyncOffset + page.runs.length >= page.totalRuns;
      if (!complete && page.runs.length === 0) {
        throw new Error("agent run resync cannot advance its stable snapshot boundary");
      }
      const nextOffset = complete ? undefined : resyncOffset + page.runs.length;
      const nextCursor = complete
        ? mintCursor(userId, chatId, snapshotSequence)
        : mintCursor(
          userId,
          chatId,
          snapshotSequence,
          undefined,
          nextOffset,
          snapshot.snapshotId,
          page.lastOrdinal,
          page.expiresAt,
        );
      return {
        version: 2 as const,
        chatId,
        cursor: nextCursor,
        cursorSequence: snapshotSequence,
        lastSequence: snapshotSequence,
        tailSequence: bounds.last,
        hasMore: !complete || snapshotSequence < bounds.last,
        resync: true,
        resyncPage: {
          offset: resyncOffset,
          returnedRuns: page.runs.length,
          totalRuns: page.totalRuns,
          snapshotSequence,
          complete,
          omittedRuns: Math.max(0, page.totalRuns - resyncOffset - page.runs.length),
          omittedOlderRuns: page.omittedOlderRuns,
        },
        runs: page.runs,
        events,
        omission: combinedOmission,
      };
    }

    let nextSequence = cursorSequence;
    if (bounds.last > cursorSequence) {
      const rows = tableExists(db, "agent_turn_executions")
        ? db.query(
          `SELECT e.sequence, e.turn_id, e.run_revision, e.status, e.snapshot_json,
                  e.terminal_handoff_json, e.omission_json
             FROM agent_chat_events e
             JOIN agent_turn_executions t
               ON t.user_id = e.user_id AND t.id = e.turn_id AND t.chat_id = e.chat_id
            WHERE e.user_id = ? AND e.chat_id = ? AND e.sequence > ?
              AND ${executionVisibilitySql("t")}
            ORDER BY e.sequence ASC
            LIMIT ?`,
        ).all(userId, chatId, cursorSequence, Date.now(), MAX_EVENTS) as StoredEventRow[]
        : db.query(
          `SELECT sequence, turn_id, run_revision, status, snapshot_json, terminal_handoff_json, omission_json
             FROM agent_chat_events
            WHERE user_id = ? AND chat_id = ? AND sequence > ?
            ORDER BY sequence ASC
            LIMIT ?`,
        ).all(userId, chatId, cursorSequence, MAX_EVENTS) as StoredEventRow[];
      let expectedSequence = cursorSequence + 1;
      for (const row of rows) {
        if (row.sequence > expectedSequence) {
          combinedOmission = mergeOmission(combinedOmission, {
            ...emptyOmission(),
            omittedEventCount: row.sequence - expectedSequence,
            firstOmittedSequence: expectedSequence,
            lastOmittedSequence: row.sequence - 1,
          });
        }
        const event = parseStoredEvent(db, userId, row, chatId);
        if (!event) {
          combinedOmission = mergeOmission(combinedOmission, {
            ...emptyOmission(),
            omittedEventCount: 1,
            firstOmittedSequence: row.sequence,
            lastOmittedSequence: row.sequence,
          });
        } else {
          events.push({ version: 2, chatId, sequence: row.sequence, run: event.run, omission: event.omission });
          combinedOmission = mergeOmission(combinedOmission, event.omission);
        }
        expectedSequence = row.sequence + 1;
      }
      if (rows.length === 0) {
        combinedOmission = mergeOmission(combinedOmission, {
          ...emptyOmission(),
          omittedEventCount: bounds.last - cursorSequence,
          firstOmittedSequence: cursorSequence + 1,
          lastOmittedSequence: bounds.last,
        });
        nextSequence = bounds.last;
      } else {
        nextSequence = rows[rows.length - 1]!.sequence;
      }
    }
    const nextCursor = mintCursor(userId, chatId, nextSequence);
    return {
      version: 2 as const,
      chatId,
      cursor: nextCursor,
      cursorSequence: nextSequence,
      lastSequence: nextSequence,
      tailSequence: bounds.last,
      hasMore: nextSequence < bounds.last,
      resync: false,
      runs: [],
      events,
      omission: combinedOmission,
    };
  })();
}

export function getAgentRun(userId: string, turnId: string, chatId?: string): AgentRunPublicV2 | null {
  const db = getDb();
  return db.transaction(() => {
    if (!validId(userId) || !validId(turnId) || (chatId !== undefined && !validId(chatId))) return null;
    const row = getProjectionByTurn(db, userId, turnId);
    if (!row || (chatId !== undefined && row.chat_id !== chatId) || !assertOwnedChat(db, userId, row.chat_id)) return null;
    if (!executionReadVisible(db, executionControlRow(db, userId, row.chat_id, turnId))) return null;
    if (!assertStoredTarget(db, row.chat_id, row.target_message_id, row.target_swipe_id, row.generation_type)) return null;
    return parseStoredRun(row);
  })();
}
type RetryRefusalCode =
  | "not_found"
  | "owner_mismatch"
  | "chat_mismatch"
  | "invalid_target"
  | "stale_target"
  | "too_late"
  | "completed"
  | "rejected"
  | "ineligible"
  | "admission_unavailable";

type RetryCandidate = {
  readonly userId: string;
  readonly chatId: string;
  readonly attemptId: string;
  readonly generationId: string;
  readonly turnId: string;
  readonly generationType: AgentRunGenerationTypeV1;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly previousAttemptId: string | null;
  readonly lifecycle: string;
  readonly status: string;
  readonly outcome: AgentRunPublicOutcomeV2 | null;
  readonly terminal: boolean;
  readonly phase: string;
};

type RetryPreflight =
  | {
    readonly accepted: true;
    readonly userId: string;
    readonly chatId: string;
    readonly previousAttemptId: string;
    readonly generationId: string;
    readonly turnId: string;
    readonly generationType: AgentRunGenerationTypeV1;
    readonly messageId: string | null;
    readonly swipeId: number | null;
  }
  | {
    readonly accepted: false;
    readonly code: RetryRefusalCode;
    readonly message: string;
    readonly status: 400 | 404 | 409 | 503;
  };

type RetryRequest = {
  readonly chatId?: string;
  readonly generationType?: string;
  readonly messageId?: string | null;
  readonly swipeId?: number | null;
};

function retryRefusal(
  code: RetryRefusalCode,
  message: string,
  status: 400 | 404 | 409 | 503,
): RetryPreflight {
  return { accepted: false, code, message, status };
}

function retryRowByIdentifier(
  db: Database,
  table: "agent_run_attempts" | "agent_turn_executions" | "agent_run_projections",
  userId: string,
  identifier: string,
): Record<string, unknown> | null {
  if (!tableExists(db, table)) return null;
  const userColumn = table === "agent_run_projections" ? "user_id" : "user_id";
  const identity = table === "agent_run_attempts"
    ? "(attempt_id = ? OR turn_id = ? OR generation_id = ?)"
    : table === "agent_turn_executions"
      ? "(id = ? OR generation_id = ?)"
      : "turn_id = ?";
  const params = table === "agent_run_attempts"
    ? [userId, identifier, identifier, identifier]
    : table === "agent_turn_executions"
      ? [userId, identifier, identifier]
      : [userId, identifier];
  return db.query(
    `SELECT * FROM ${table} WHERE ${userColumn} = ? AND ${identity} LIMIT 1`,
  ).get(...params) as Record<string, unknown> | null;
}

function retryForeignRowByIdentifier(
  db: Database,
  table: "agent_run_attempts" | "agent_turn_executions" | "agent_run_projections",
  identifier: string,
): Record<string, unknown> | null {
  if (!tableExists(db, table)) return null;
  const identity = table === "agent_run_attempts"
    ? "(attempt_id = ? OR turn_id = ? OR generation_id = ?)"
    : table === "agent_turn_executions"
      ? "(id = ? OR generation_id = ?)"
      : "turn_id = ?";
  const params = table === "agent_run_attempts"
    ? [identifier, identifier, identifier]
    : table === "agent_turn_executions"
      ? [identifier, identifier]
      : [identifier];
  return db.query(`SELECT * FROM ${table} WHERE ${identity} LIMIT 1`).get(...params) as Record<string, unknown> | null;
}

function retryString(row: Record<string, unknown>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function retryInteger(row: Record<string, unknown>, ...keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === "string" && /^[0-9]+$/.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
  }
  return null;
}

function retryBoolean(row: Record<string, unknown>, ...keys: readonly string[]): boolean {
  return retryInteger(row, ...keys) === 1 || keys.some((key) => row[key] === true);
}

function retryJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function retryOutcomeForExecution(row: Record<string, unknown>, phase: string): AgentRunPublicOutcomeV2 | null {
  const explicit = retryString(row, "outcome");
  if (explicit === "completed" || explicit === "stopped" || explicit === "failed" || explicit === "exhausted" || explicit === "rejected") {
    return explicit;
  }
  if (phase === "COMMITTED") return "completed";
  if (phase === "EXHAUSTED") return "exhausted";
  if (phase === "CANCELLED") return "stopped";
  if (phase === "FAILED" || phase === "COMMIT_FAILED" || phase === "TIMED_OUT") {
    const code = (retryString(row, "terminal_code", "error_code") ?? "").toLowerCase();
    return code === "cancelled" || code === "canceled" || code === "stopped" || code === "agentic_cancelled"
      ? "stopped"
      : code === "exhausted" || code === "agentic_work_exhausted" || code === "root_wall_clock_limit_exceeded"
        || code.endsWith("_limit_exceeded") || code.endsWith("_budget_exhausted")
        ? "exhausted"
        : "failed";
  }
  return null;
}

function retryCandidateFromRow(
  row: Record<string, unknown>,
  source: "attempt" | "execution" | "projection",
): RetryCandidate | null {
  const userId = retryString(row, "user_id");
  const chatId = retryString(row, "chat_id");
  const turnId = retryString(row, "turn_id", "id");
  const generationId = retryString(row, "generation_id") ?? turnId;
  const generationType = retryString(row, "generation_type", "target_kind", "target") as AgentRunGenerationTypeV1 | null;
  if (!userId || !chatId || !turnId || !generationId || !generationType || !GENERATION_TYPES.has(generationType)) return null;
  const snapshot = retryJsonRecord(row.target_snapshot_json ?? row.target_snapshot);
  const lineage = snapshot.attemptLineage && typeof snapshot.attemptLineage === "object" && !Array.isArray(snapshot.attemptLineage)
    ? snapshot.attemptLineage as Record<string, unknown> : {};
  const attemptId = retryString(row, "attempt_id") ?? retryString(lineage, "attemptId") ?? turnId;
  const previousAttemptId = lineage.previousAttemptId === null
    ? null
    : retryString(row, "previous_attempt_id") ?? retryString(lineage, "previousAttemptId");
  const messageId = retryString(row, "target_message_id", "message_id")
    ?? (lineage.target && typeof lineage.target === "object" && !Array.isArray(lineage.target)
      ? retryString(lineage.target as Record<string, unknown>, "messageId") : null);
  const swipeId = retryInteger(row, "target_swipe_id", "swipe_id")
    ?? (lineage.target && typeof lineage.target === "object" && !Array.isArray(lineage.target)
      ? retryInteger(lineage.target as Record<string, unknown>, "swipeId") : null);
  const phase = retryString(row, "phase", "state") ?? retryString(row, "lifecycle") ?? "";
  const outcome = retryOutcomeForExecution(row, phase);
  const status = retryString(row, "status") ?? (outcome ? "terminal" : "running");
  const lifecycle = retryString(row, "lifecycle") ?? phase;
  const terminal = source === "attempt"
    ? retryBoolean(row, "terminal") || outcome !== null
    : TERMINAL_STATES.has(phase as StoredRunState) || outcome !== null;
  return {
    userId,
    chatId,
    attemptId,
    generationId,
    turnId,
    generationType,
    messageId,
    swipeId,
    previousAttemptId,
    lifecycle,
    status,
    outcome,
    terminal,
    phase,
  };
}

/**
 * Read-only Retry preflight. It never inserts, updates, or reserves a row.
 * The coordinator revalidates this exact target during real admission.
 */
export function prepareAgentRunRetry(
  userId: string,
  identifier: string,
  request: RetryRequest = {},
): RetryPreflight {
  const db = getDb();
  return db.transaction((): RetryPreflight => {
    if (!validId(userId) || !validId(identifier)) {
      return retryRefusal("not_found", "The requested attempt was not found.", 404);
    }
    const sources: Array<["attempt" | "execution" | "projection", "agent_run_attempts" | "agent_turn_executions" | "agent_run_projections"]> = [
      ["attempt", "agent_run_attempts"],
      ["execution", "agent_turn_executions"],
      ["projection", "agent_run_projections"],
    ];
    let candidate: RetryCandidate | null = null;
    let foreign = false;
    for (const [source, table] of sources) {
      const row = retryRowByIdentifier(db, table, userId, identifier);
      if (row) {
        candidate = retryCandidateFromRow(row, source);
        if (candidate) break;
      }
      if (!row && retryForeignRowByIdentifier(db, table, identifier)) foreign = true;
    }
    if (!candidate) {
      return retryRefusal(foreign ? "owner_mismatch" : "not_found", foreign ? "The requested attempt belongs to another owner." : "The requested attempt was not found.", 404);
    }
    if (!assertOwnedChat(db, userId, candidate.chatId)) {
      return retryRefusal("owner_mismatch", "The requested attempt is not owned by this user.", 404);
    }
    if (request.chatId !== undefined && request.chatId !== candidate.chatId) {
      return retryRefusal("chat_mismatch", "Retry chat does not match the prior attempt.", 409);
    }
    if (request.generationType !== undefined && request.generationType !== candidate.generationType) {
      return retryRefusal("invalid_target", "Retry generation target does not match the prior attempt.", 409);
    }
    if (request.messageId !== undefined && (request.messageId ?? null) !== candidate.messageId) {
      return retryRefusal("invalid_target", "Retry message target does not match the prior attempt.", 409);
    }
    if (request.swipeId !== undefined && (request.swipeId ?? null) !== candidate.swipeId) {
      return retryRefusal("invalid_target", "Retry swipe target does not match the prior attempt.", 409);
    }
    const targetValid = assertStoredTarget(
      db,
      candidate.chatId,
      candidate.messageId,
      candidate.swipeId,
      candidate.generationType,
    );
    if (!targetValid) return retryRefusal("stale_target", "The prior generation target is no longer valid.", 409);
    if (candidate.outcome === "completed") {
      return retryRefusal("completed", "The prior generation completed; use Continue or Regenerate.", 409);
    }
    if (candidate.outcome === "rejected") {
      return retryRefusal("rejected", "The prior generation was rejected; repair or reselect its target.", 409);
    }
    if (
      candidate.phase === "COMMITTING"
      || candidate.phase === "COMMITTED"
      || candidate.lifecycle === "COMMIT"
    ) {
      return retryRefusal("too_late", "The prior generation is already at its commit gate.", 409);
    }
    if (!candidate.terminal || candidate.outcome === null || !["failed", "exhausted", "stopped"].includes(candidate.outcome)) {
      return retryRefusal("ineligible", "The prior generation is not eligible for Retry.", 409);
    }
    return {
      accepted: true,
      userId: candidate.userId,
      chatId: candidate.chatId,
      previousAttemptId: candidate.attemptId,
      generationId: candidate.generationId,
      turnId: candidate.turnId,
      generationType: candidate.generationType,
      messageId: candidate.messageId,
      swipeId: candidate.swipeId,
    };
  })();
}

export function listAgentRunChangesForChat(userId: string, chatId: string, cursorToken?: unknown): AgentRunChangesV2 | null {
  return getAgentRunChanges(userId, chatId, cursorToken);
}

function workspaceRow(db: Database, userId: string, turnId: string): Record<string, unknown> | null {
  if (!tableExists(db, "agent_turn_workspaces") || !tableExists(db, "agent_turn_executions")
    || !validId(userId) || !validId(turnId)) return null;
  // Join through the owned execution so a forged workspace chat_id cannot
  // widen a turn lookup to another chat.
  const row = db.query(
    `SELECT w.workspace_id, w.turn_id, w.user_id, w.chat_id, w.revision, w.retention, w.expires_at,
            w.task_count, w.record_count, w.submission_count, w.artifact_count, w.byte_count
       FROM agent_turn_workspaces w
       JOIN agent_turn_executions e
         ON e.user_id = w.user_id AND e.id = w.turn_id AND e.chat_id = w.chat_id
      WHERE w.user_id = ? AND w.turn_id = ?
      LIMIT 1`,
  ).get(userId, turnId) as Record<string, unknown> | null;
  if (!row || workspaceExpired(workspacePolicy(row.retention), row.expires_at)) return null;
  return row;
}

function workspacePolicy(value: unknown): AgentWorkspaceRetentionV2 {
  return typeof value === "string" && RETENTIONS.has(value as AgentWorkspaceRetentionV2)
    ? value as AgentWorkspaceRetentionV2 : "operational";
}

function workspaceVisibility(value: unknown): AgentWorkspaceVisibilityV2 {
  if (value === "participants" || value === "public") return value;
  return "owner";
}

function workspaceCount(db: Database, table: string, userId: string, turnId: string, chatId: string, fallback: unknown): number {
  if (!tableExists(db, table)) return boundedCounter(fallback);
  try {
    const row = db.query(
      `SELECT COUNT(*) AS count
         FROM "${table}"
        WHERE user_id = ? AND turn_id = ? AND chat_id = ?
          AND (retention = 'chat_lifetime' OR expires_at > ?)`,
    ).get(userId, turnId, chatId, Math.floor(Date.now() / 1000)) as { count: number } | null;
    return boundedCounter(row?.count, boundedCounter(fallback));
  } catch {
    return boundedCounter(fallback);
  }
}


export function getWorkspaceIndex(userId: string, turnId: string): AgentWorkspaceIndexV2 | null {
  const db = getDb();
  if (!validId(userId) || !validId(turnId)) return null;
  const workspace = workspaceRow(db, userId, turnId);
  if (!workspace) return null;
  const chatId = workspace.chat_id;
  if (!validId(chatId)) return null;
  const execution = executionControlRow(db, userId, chatId, turnId);
  if (!execution || !executionReadVisible(db, execution)) return null;
  const retention = workspacePolicy(workspace.retention);
  const sections: AgentWorkspaceIndexV2["sections"] = [
    { section: "objective", count: 1, revision: boundedCounter(workspace.revision), retention, visibility: "owner" },
    { section: "tasks", count: workspaceCount(db, "agent_workspace_tasks", userId, turnId, chatId, workspace.task_count), revision: boundedCounter(workspace.revision), retention, visibility: "owner" },
    { section: "records", count: workspaceCount(db, "agent_workspace_records", userId, turnId, chatId, workspace.record_count), revision: boundedCounter(workspace.revision), retention, visibility: "owner" },
    { section: "submissions", count: workspaceCount(db, "agent_workspace_submissions", userId, turnId, chatId, workspace.submission_count), revision: boundedCounter(workspace.revision), retention, visibility: "owner" },
    { section: "artifacts", count: workspaceCount(db, "agent_workspace_artifacts", userId, turnId, chatId, workspace.artifact_count), revision: boundedCounter(workspace.revision), retention, visibility: "owner" },
  ];
  return { version: 2, turnId, workspaceRevision: boundedCounter(workspace.revision), sections, omitted: 0 };
}

function safePreviewId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value) ? value : null;
}

function parseDependencies(value: unknown): number {
  if (typeof value !== "string") return 0;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? Math.min(parsed.length, 100000) : 0;
  } catch {
    return 0;
  }
}

function buildWorkspaceEntries(
  section: AgentWorkspaceSectionIdV2,
  rows: Array<Record<string, unknown>>,
  retention: AgentWorkspaceRetentionV2,
): AgentWorkspaceEntryPreviewV2[] {
  const result: AgentWorkspaceEntryPreviewV2[] = [];
  for (const row of rows.slice(0, MAX_WORKSPACE_ENTRIES)) {
    const id = safePreviewId(row.id);
    if (!workspaceChildVisible(row)) continue;
    if (!id) continue;
    const revision = boundedCounter(row.revision);
    const rowRetention = workspacePolicy(row.retention ?? retention);
    const visibility = workspaceVisibility(row.visibility);
    if (section === "tasks") {
      const state = row.state === "pending"
        ? "pending"
        : row.state === "active"
          ? "active"
          : row.state === "blocked"
            ? "blocked"
            : row.state === "completed"
              ? "completed"
              : row.state === "cancelled"
                ? "cancelled"
                : row.state === "failed"
                  ? "failed"
                  : undefined;
      if (!state) continue;
      result.push({
        kind: "task", id, revision, retention: rowRetention, visibility,
        // Do not expose authored task prose. The UI receives a stable label.
        title: `Task ${id.slice(0, 8)}`,
        state,
        required: row.required === 1,
        assigned: typeof row.assigned_frame_id === "string" && row.assigned_frame_id.length > 0,
        dependencyCount: parseDependencies(row.dependencies_json),
      });
    } else if (section === "submissions") {
      const state = row.state === "submitted"
        ? "submitted"
        : row.state === "accepted"
          ? "accepted"
          : row.state === "rejected"
            ? "rejected"
            : undefined;
      if (!state) continue;
      result.push({
        kind: "submission", id, revision, retention: rowRetention, visibility,
        taskId: safePreviewId(row.task_id) ?? "unknown-task",
        profileId: safePreviewId(row.child_frame_id), state,
      });
    } else if (section === "records") {
      const kind = row.kind === "finding" || row.kind === "decision" || row.kind === "question" ? row.kind : "finding";
      result.push({
        kind, id, revision, retention: rowRetention, visibility,
        title: kind,
        state: row.state === "accepted" ? "accepted" : "active",
      });
    } else if (section === "artifacts") {
      const digest = typeof row.digest === "string" && /^[0-9a-fA-F]{64}$/.test(row.digest)
        ? row.digest : null;
      const mimeType = typeof row.mime_type === "string"
        && row.mime_type.length <= 255
        && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(row.mime_type)
        ? row.mime_type : null;
      const publicationState = row.publication_state === "attached"
        || row.publication_state === "proposed"
        || row.publication_state === "published"
        ? row.publication_state : null;
      const byteCount = boundedCounter(row.byte_count, -1);
      if (!digest || !mimeType || !publicationState || byteCount < 0) continue;
      result.push({
        kind: "artifact", id, revision, retention: rowRetention, visibility,
        name: `Artifact ${id.slice(0, 8)}`, mimeType, byteCount,
        digestPrefix: digest.slice(0, 12),
        published: publicationState === "published",
      });
    }
  }
  return result;
}

export function getWorkspacePreview(
  userId: string,
  turnId: string,
  section: AgentWorkspaceSectionIdV2,
  page = 0,
  expectedRevision?: number,
): AgentWorkspacePreviewV2 | null {
  if (!validId(userId) || !validId(turnId) || !WORKSPACE_SECTIONS.includes(section)
    || !Number.isSafeInteger(page) || page < 0
    || (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) return null;
  const index = getWorkspaceIndex(userId, turnId);
  if (!index) return null;
  if (expectedRevision !== undefined && expectedRevision !== index.workspaceRevision) return null;
  const db = getDb();
  const workspace = workspaceRow(db, userId, turnId);
  if (!workspace || !validId(workspace.chat_id)) return null;
  const chatId = workspace.chat_id;
  const revision = index.workspaceRevision;
  if (section === "objective") {
    return { version: 2, turnId, section, workspaceRevision: revision, entries: [], nextPage: null, omitted: 0 };
  }
  const table = section === "tasks" ? "agent_workspace_tasks"
    : section === "records" ? "agent_workspace_records"
      : section === "submissions" ? "agent_workspace_submissions" : "agent_workspace_artifacts";
  const safePage = Math.min(page, 100000);
  const columns = section === "tasks"
    ? "task_id AS id, state, required, assigned_frame_id, dependencies_json, revision, retention, expires_at, updated_at"
    : section === "records"
      ? "record_id AS id, kind, revision, retention, expires_at, created_at AS updated_at"
      : section === "submissions"
        ? "submission_id AS id, task_id, child_frame_id, state, revision, retention, expires_at, updated_at"
        : "artifact_id AS id, blob_digest AS digest, mime_type, byte_count, publication_state, revision, retention, expires_at, updated_at";
  const rows = db.query(
    `SELECT ${columns}
       FROM "${table}"
      WHERE user_id = ? AND turn_id = ? AND chat_id = ?
        AND (retention = 'chat_lifetime' OR expires_at > unixepoch())
      ORDER BY updated_at ASC, rowid ASC
      LIMIT ? OFFSET ?`,
  ).all(userId, turnId, chatId, MAX_WORKSPACE_ENTRIES + 1, safePage * MAX_WORKSPACE_ENTRIES) as Array<Record<string, unknown>>;
  const entries = buildWorkspaceEntries(section, rows, workspacePolicy(workspace.retention));
  const hasNext = rows.length > MAX_WORKSPACE_ENTRIES;
  return {
    version: 2,
    turnId,
    section,
    workspaceRevision: revision,
    entries: entries.slice(0, MAX_WORKSPACE_ENTRIES),
    nextPage: hasNext ? String(safePage + 1) : null,
    omitted: Math.max(0, rows.length - entries.length),
  };
}

export interface AgentRunProjectionReconcileResult {
  readonly inspectedProjections: number;
  readonly removedProjections: number;
  readonly inspectedWorkspaces: number;
  readonly removedWorkspaces: number;
  readonly preservedChatLifetimeEntries: number;
  readonly failures: number;
  /** False only when a row-level reconciliation operation failed. */
  readonly healthy: boolean;
  /** False while another bounded cleanup page remains. */
  readonly complete: boolean;
}

export interface AgentRunProjectionReconcileOptions {
  readonly maxRows?: number;
  readonly nowMilliseconds?: number;
  readonly nowSeconds?: number;
}

/**
 * Reconcile only expired operational projections and turn-terminal workspace
 * rows. Chat-lifetime workspace entries and published artifact rows are never
 * deleted by this pass.
 */
export function reconcileAgentRunProjections(
  db: Database = getDb(),
  options: AgentRunProjectionReconcileOptions = {},
): AgentRunProjectionReconcileResult {
  const maxRows = typeof options.maxRows === "number" && Number.isSafeInteger(options.maxRows)
    ? Math.max(1, Math.min(options.maxRows, MAX_RECONCILIATION_ROWS))
    : MAX_RECONCILIATION_ROWS;
  const nowMilliseconds = options.nowMilliseconds ?? Date.now();
  const nowSeconds = options.nowSeconds ?? Math.floor(nowMilliseconds / 1000);
  let inspectedProjections = 0;
  let removedProjections = 0;
  let inspectedWorkspaces = 0;
  let removedWorkspaces = 0;
  let preservedChatLifetimeEntries = 0;
  let failures = 0;
  let pendingProjections = false;
  let pendingWorkspaces = false;

  if (tableExists(db, "agent_run_projections") && tableExists(db, "agent_turn_executions")) {
    const candidates = db.query(
      `SELECT p.user_id, p.turn_id, e.expires_at
         FROM agent_run_projections p
         JOIN agent_turn_executions e
           ON e.user_id = p.user_id AND e.id = p.turn_id AND e.chat_id = p.chat_id
        WHERE typeof(e.expires_at) = 'integer'
          AND e.expires_at > 0
          AND CASE
            WHEN e.expires_at < ${SWIPE_EXPIRY_THRESHOLD} THEN e.expires_at * 1000
            ELSE e.expires_at
          END <= ?
        ORDER BY p.updated_at ASC, p.turn_id ASC
        LIMIT ?`,
    ).all(nowMilliseconds, maxRows) as Array<{ user_id: string; turn_id: string; expires_at: number | null }>;
    inspectedProjections = candidates.length;
    for (const candidate of candidates) {
      if (!isExpiredAt(candidate.expires_at, nowMilliseconds)) continue;
      try {
        const deleted = db.transaction(() => {
          if (tableExists(db, "agent_chat_events")) {
            db.query("DELETE FROM agent_chat_events WHERE user_id = ? AND turn_id = ?")
              .run(candidate.user_id, candidate.turn_id);
          }
          return db.query(
            `DELETE FROM agent_run_projections
              WHERE user_id = ? AND turn_id = ?`,
          ).run(candidate.user_id, candidate.turn_id).changes;
        })();
        removedProjections += deleted;
      } catch {
        failures += 1;
      }
    }
    pendingProjections = Boolean(db.query(
      `SELECT 1
         FROM agent_run_projections p
         JOIN agent_turn_executions e
           ON e.user_id = p.user_id AND e.id = p.turn_id AND e.chat_id = p.chat_id
        WHERE typeof(e.expires_at) = 'integer'
          AND e.expires_at > 0
          AND CASE
            WHEN e.expires_at < ${SWIPE_EXPIRY_THRESHOLD} THEN e.expires_at * 1000
            ELSE e.expires_at
          END <= ?
        LIMIT 1`,
    ).get(nowMilliseconds));
  }

  if (tableExists(db, "agent_turn_workspaces")) {
    const workspaces = db.query(
      `SELECT workspace_id, user_id
         FROM agent_turn_workspaces
        WHERE state <> 'expired'
          AND retention = 'turn_terminal' AND expires_at > 0 AND expires_at <= ?
        ORDER BY expires_at ASC, workspace_id ASC
        LIMIT ?`,
    ).all(nowSeconds, maxRows) as Array<{ workspace_id: string; user_id: string }>;
    inspectedWorkspaces = workspaces.length;
    const childTables = [
      "agent_workspace_tasks",
      "agent_workspace_records",
      "agent_workspace_submissions",
      "agent_workspace_artifacts",
    ] as const;
    for (const workspace of workspaces) {
      try {
        const outcome = db.transaction(() => {
          let preserved = 0;
          for (const table of childTables) {
            if (!tableExists(db, table)) continue;
            const row = db.query(
              `SELECT COUNT(*) AS count
                 FROM "${table}"
                WHERE user_id = ? AND workspace_id = ? AND retention = 'chat_lifetime'`,
            ).get(workspace.user_id, workspace.workspace_id) as { count?: unknown } | null;
            preserved += boundedCounter(row?.count);
            db.query(
              `DELETE FROM "${table}"
                WHERE user_id = ? AND workspace_id = ? AND retention <> 'chat_lifetime'`,
            ).run(workspace.user_id, workspace.workspace_id);
          }
          if (preserved > 0) {
            db.query(
              `UPDATE agent_turn_workspaces
                  SET state = 'expired', updated_at = ?
                WHERE user_id = ? AND workspace_id = ?`,
            ).run(nowSeconds, workspace.user_id, workspace.workspace_id);
            return { removed: 0, preserved };
          }
          const removed = db.query(
            "DELETE FROM agent_turn_workspaces WHERE user_id = ? AND workspace_id = ? AND retention = 'turn_terminal'",
          ).run(workspace.user_id, workspace.workspace_id).changes;
          return { removed, preserved: 0 };
        })();
        removedWorkspaces += outcome.removed;
        preservedChatLifetimeEntries += outcome.preserved;
      } catch {
        failures += 1;
      }
    }
    pendingWorkspaces = Boolean(db.query(
      `SELECT 1
         FROM agent_turn_workspaces
        WHERE state <> 'expired'
          AND retention = 'turn_terminal' AND expires_at > 0 AND expires_at <= ?
        LIMIT 1`,
    ).get(nowSeconds));
  }

  return {
    inspectedProjections,
    removedProjections,
    inspectedWorkspaces,
    removedWorkspaces,
    preservedChatLifetimeEntries,
    failures,
    healthy: failures === 0,
    complete: !pendingProjections && !pendingWorkspaces,
  };
}

export function registerAgentRunStopHandler(
  userId: string,
  chatId: string,
  turnId: string,
  handler: AgentRunStopHandler,
): () => void {
  if (!validId(userId) || !validId(chatId) || !validId(turnId) || typeof handler !== "function") {
    throw new TypeError("invalid Agent Run stop handler registration");
  }
  const key = projectionKey(userId, chatId, turnId);
  stopHandlers.set(key, handler);
  return () => {
    if (stopHandlers.get(key) === handler) stopHandlers.delete(key);
  };
}

function stopResponseForRun(
  run: AgentRunPublicV2,
  status: AgentRunStopResultV2,
  revision = run.revision,
): AgentRunStopResponseV2 {
  const error = run.error ?? (status === "too_late"
    ? buildPublicError(
      "stop_unavailable",
      run.attemptLineage.target,
      run.workPhase,
      run.workStatus,
      run.workOutcome,
      "too_late",
      run.omission,
      run.attemptLineage.attemptId,
      "internal",
      undefined,
      false,
      "none",
    )
    : undefined);
  return {
    version: 2,
    status,
    turnId: run.turnId,
    generationId: run.generationId,
    revision,
    target: run.attemptLineage.target,
    workPhase: run.workPhase,
    workStatus: run.workStatus,
    workOutcome: run.workOutcome,
    reason: run.reason,
    recoveryEligible: run.recoveryEligible,
    recoveryAction: run.recoveryAction,
    omissionCount: run.omissionCount,
    inspectionAttemptId: run.inspectionAttemptId,
    ...(error ? { error } : {}),
  };
}
function settlePoolAfterDurableRun(run: AgentRunPublicV2): void {
  if (!isTerminal(run)) return;
  if (run.workOutcome === "stopped") {
    generationPool.stopPool(run.turnId);
  } else if (run.workOutcome === "completed") {
    generationPool.completePool(run.turnId, run.terminalHandoff?.messageId ?? undefined);
  } else {
    generationPool.errorPool(run.turnId, run.reason ?? run.error?.code ?? "agentic_failed");
  }
  const terminalPool = generationPool.getPoolEntry(run.turnId);
  if (!terminalPool || terminalPool.status === "completed" || terminalPool.status === "stopped" || terminalPool.status === "error") {
    generationPool.unregisterPoolTerminalOwner(run.turnId);
  }
}

export function requestAgentRunStop(userId: string, chatId: string, turnId: string): AgentRunStopResponseV2 | null {
  if (!validId(userId) || !validId(chatId) || !validId(turnId)) return null;
  const db = getDb();
  let initialControl = executionControlRow(db, userId, chatId, turnId);
  let run = getAgentRun(userId, turnId, chatId);
  if (!run) {
    if (!initialControl) return null;
    try {
      if (!reconcileTerminalAgentTurn(turnId, userId, db)) return null;
    } catch {
      throw new AgentRunStopUnavailableError(turnId);
    }
    run = getAgentRun(userId, turnId, chatId);
    initialControl = executionControlRow(db, userId, chatId, turnId);
    if (!run || !initialControl) throw new AgentRunStopUnavailableError(turnId);
  }
  if (isTerminal(run)) settlePoolAfterDurableRun(run);
  const initialDurable = canonicalExecutionProjection(initialControl);
  if (initialControl && !initialDurable) throw new AgentRunStopUnavailableError(turnId);
  const currentStoredState = storedStateForRun(run);
  if (TOO_LATE_STATES.has(currentStoredState)) {
    if (
      initialDurable
      && phaseForStoredState(initialDurable.state) !== run.workPhase
      && !(isTerminal(run) && terminalProjectionMatchesState(run, initialDurable.state, executionTerminalCode(initialControl)))
    ) {
      throw new AgentRunStopUnavailableError(turnId);
    }

    return stopResponseForRun(run, "too_late");
  }
  if (isTerminal(run.workStatus)) {
    if (
      initialDurable
      && initialDurable.state !== currentStoredState
      && !(terminalProjectionMatchesState(run, initialDurable.state, executionTerminalCode(initialControl)))
    ) {
      throw new AgentRunStopUnavailableError(turnId);
    }

    return stopResponseForRun(run, "terminal");
  }

  const handler = stopHandlers.get(projectionKey(userId, chatId, turnId));
  if (handler) {
    const status = handler({ userId, chatId, turnId, generationId: run.generationId });
    if (status !== "accepted" && status !== "too_late" && status !== "terminal") {
      throw new Error("invalid Agent Run stop handler result");
    }
    if (status === "terminal") {
      try {
        const control = executionControlRow(db, userId, chatId, turnId);
        const durable = canonicalExecutionProjection(control);
        if (!control || !durable || durable.status !== "terminal" || durable.outcome === null) {
          throw new AgentRunStopUnavailableError(turnId);
        }
        if (!reconcileTerminalAgentTurn(turnId, userId, db)) {
          throw new AgentRunStopUnavailableError(turnId);
        }
        const terminalRun = getAgentRun(userId, turnId, chatId);
        if (
          !terminalRun
          || terminalRun.generationId !== run.generationId
          || !isTerminal(terminalRun)
          || !terminalProjectionMatchesState(terminalRun, durable.state, executionTerminalCode(control))
        ) {
          throw new AgentRunStopUnavailableError(turnId);
        }
        settlePoolAfterDurableRun(terminalRun);
        return stopResponseForRun(
          terminalRun,
          TOO_LATE_STATES.has(durable.state) ? "too_late" : "terminal",
          terminalRun.revision,
        );
      } catch (error) {
        if (error instanceof AgentRunStopUnavailableError) throw error;
        throw new AgentRunStopUnavailableError(turnId);
      }
    }
    if (status === "accepted") {
      withAgentRunProjectionTransaction((transactionDb) => {
        const control = executionControlRow(transactionDb, userId, chatId, turnId);
        const durable = canonicalExecutionProjection(control);
        if (!control || durable?.status !== "cancelling") {
          throw new AgentRunStopUnavailableError(turnId);
        }
        const current = getAgentRun(userId, turnId, chatId) ?? run;
        if (!isTerminal(current) && current.workStatus !== "cancelling") {
          appendDurableCancellingProjection(transactionDb, userId, current);
        }
      });
    }
    const latestRun = getAgentRun(userId, turnId, chatId) ?? run;
    return stopResponseForRun(latestRun, status, latestRun.revision);
  }

  const result = withAgentRunProjectionTransaction((transactionDb) => {
    const control = executionControlRow(transactionDb, userId, chatId, turnId);
    const durable = canonicalExecutionProjection(control);
    if (!control || !durable) throw new AgentRunStopUnavailableError(turnId);

    const publishTerminal = (
      status: StoredRunState,
      responseStatus: "accepted" | "terminal",
      terminalCode?: string | null,
    ): AgentRunStopTransactionResult => {
      const latestRun = getAgentRun(userId, turnId, chatId);
      if (!latestRun) throw new AgentRunStopUnavailableError(turnId);
      const latestStoredState = storedStateForRun(latestRun);
      if (isTerminal(latestRun)) {
        if (
          latestStoredState !== status
          && !terminalProjectionMatchesState(latestRun, status, terminalCode)
        ) {
          throw new AgentRunStopUnavailableError(turnId);
        }
        return { status: "terminal", revision: latestRun.revision, changed: false };
      }
      const projection = appendDurableTerminalProjection(transactionDb, userId, latestRun, status, terminalCode);
      return {
        status: responseStatus,
        revision: projection.revision,
        event: projection.event,
        changed: projection.changed,
      };
    };

    if (TOO_LATE_STATES.has(durable.state)) {
      return { status: "too_late" as const, revision: run.revision };
    }
    if (durable.status === "terminal" || durable.outcome !== null) {
      return publishTerminal(durable.state, "terminal", executionTerminalCode(control));
    }

    let durableResult: TurnCancellationResult;
    try {
      durableResult = requestDormantTurnCancellation({
        executionId: turnId,
        userId,
        chatId,
        db: transactionDb,
      });
    } catch {
      throw new AgentRunStopUnavailableError(turnId);
    }
    if (durableResult.code === "too_late") {
      return { status: "too_late" as const, revision: run.revision };
    }
    if (durableResult.code === "already_terminal") {
      if (!isTerminal(durableResult.execution.phase)) {
        throw new AgentRunStopUnavailableError(turnId);
      }
      return publishTerminal(durableResult.execution.phase, "terminal", durableResult.execution.terminalCode);
    }
    if (durableResult.code !== "cancelled" && durableResult.code !== "timed_out") {
      throw new AgentRunStopUnavailableError(turnId);
    }
    if (!isTerminal(durableResult.execution.phase)) {
      throw new AgentRunStopUnavailableError(turnId);
    }
    return publishTerminal(durableResult.execution.phase, "accepted", durableResult.execution.terminalCode);
  });
  const latestRun = getAgentRun(userId, turnId, chatId) ?? run;
  settlePoolAfterDurableRun(latestRun);
  return stopResponseForRun(latestRun, result.status, result.revision);
}

export function __test__mintChatRunCursor(userId: string, chatId: string, lastSequence: number, now?: number): ChatRunCursorV1 {
  return mintCursor(userId, chatId, lastSequence, now);
}

export function __test__decodeChatRunCursor(token: string): { claims: CursorClaims; reason: "ok" | "expired" | "invalid" } {
  return decodeCursor(token);
}
