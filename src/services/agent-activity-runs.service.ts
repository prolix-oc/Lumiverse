import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import {
  loadAgentInspectionSourceDeletionFromDb,
  type AgentInspectionSourceDeletionV1,
} from "./agent-inspection-retention.service";
import type {
  AgentActivityLifecycle,
  AgentActivityNodeKind,
  AgentActivityNodeV1,
  AgentActivityRunV1,
  AgentActivitySnapshotV1,
  AgentActivityToolId,
  AgentActivityUsageV1,
  AgentPublicErrorCategory,
  AgentPublicErrorCode,
} from "../types/agent-runtime";
import {
  AGENT_PUBLIC_ERROR_CODES,
  PUBLIC_ACTIVITY_TOOL_IDS,
} from "../types/agent-runtime";
import {
  AGENT_RUNTIME_MAX_CUSTOM_PHASES,
  AGENT_RUNTIME_MAX_PHASE_INSTRUCTION_REFS,
} from "../types/agents";
import type {
  CognitionGenerationType,
  CognitionPhase,
  CognitionPredicateV1,
  CognitionScalar,
  CognitionValue,
  LoomPolicyBucketV1,
  LoomPolicyCheckpointV1,
  LoomPolicyDestinationV1,
  LoomPolicySourceV1,
  LoomPromptInspectionItemV1,
  LoomPromptInspectionOutcomeV1,
  LoomPromptInspectionV1,
  LoomResponsePolicyOmissionV1,
  LoomResponsePolicyPhaseInstructionV1,
} from "../types/agent-cognition";
import type {
  AgentActivityMilestoneV1,
  AgentActivityTreeV1,
  AgentCortexReceiptV1,
  AgentCouncilReceiptV1,
  AgentInspectionAuthorityV1,
  AgentInspectionAttemptLineageV1,
  AgentInspectionCorrelationV1,
  AgentInspectionCapGateV1,
  AgentInspectionErrorDetailV1,
  AgentInspectionLifecycleV1,
  AgentInspectionMarkerV1,
  AgentInspectionOutcomeV1,
  AgentInspectionReasonV1,
  AgentInspectionRecordActorV1,
  AgentInspectionRecordKindV1,
  AgentInspectionScopeV1,
  AgentInspectionSectionAvailabilityV1,
  AgentInspectionSectionIdV1,
  AgentInspectionSourceV1,
  AgentInspectionStatusV1,
  AgentInspectionTranscriptRecordV1,
  AgentInspectionUsageLayerIdV1,
  AgentInspectionUsageLayerV1,
  AgentInspectionUsageProjectionV1,
  AgentInspectionUsageV1,
  AgentWorkSegmentInspectionProjectionV1,
  AgentPromptDatabankSourceV1,
  AgentPromptEvidenceV1,
  AgentPromptNativeProvenanceV1,
  AgentRenderCrossingV1,
  AgentRunGenerationTypeV1,
  AgentRunInspectionDetailV1,
  AgentRunInspectionListV1,
  AgentRunInspectionStopV1,
  AgentRunInspectionSummaryV1,
  AgentRunTargetV1,
  AgentTurnSessionEntryV1,
  AgentWorkspaceAssociationV1,
} from "../types/agent-run-projection";
import { readWorkSegmentInspectionChainV1 } from "./agentic-work-segment.repository";

import { compareUtf8 } from "../utils/utf8-order";

type InspectionObject = Record<string, unknown>;

export const AGENT_ACTIVITY_RUN_MAX_BYTES = 32 * 1024;
export const AGENT_ACTIVITY_RUN_MAX_COUNT = 16;
export const AGENT_ACTIVITY_CHAT_MAX_BYTES = 512 * 1024;

const MAX_ID_BYTES = 256;
const MAX_PROFILE_ID_BYTES = 128;
const MAX_NODES_PER_SNAPSHOT = 128;
const MAX_ERROR_CODES = 64;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const encoder = new TextEncoder();
export const AGENT_RUN_INSPECTION_MAX_CURSOR_BYTES = 1024;

const AGENT_RUN_INSPECTION_CURSOR_PREFIX = "v1.";

interface AgentRunInspectionCursor {
  readonly updatedAt: number;
  readonly attemptId: string;
}

function encodeAgentRunInspectionCursor(updatedAt: number, attemptId: string): string {
  return `${AGENT_RUN_INSPECTION_CURSOR_PREFIX}${Buffer.from(
    JSON.stringify({ v: 1, t: updatedAt, i: attemptId }),
    "utf8",
  ).toString("base64url")}`;
}

function decodeAgentRunInspectionCursor(value: unknown): AgentRunInspectionCursor | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || encoder.encode(value).byteLength > AGENT_RUN_INSPECTION_MAX_CURSOR_BYTES
    || !value.startsWith(AGENT_RUN_INSPECTION_CURSOR_PREFIX)
  ) {
    return null;
  }
  const encoded = value.slice(AGENT_RUN_INSPECTION_CURSOR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  let decoded: string;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    decoded = bytes.toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) return null;
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const updatedAt = record.t;
    const attemptId = record.i;
    if (
      record.v !== 1
      || typeof updatedAt !== "number"
      || !Number.isSafeInteger(updatedAt)
      || updatedAt < -1
      || typeof attemptId !== "string"
      || attemptId.length === 0
      || encoder.encode(attemptId).byteLength > MAX_ID_BYTES
    ) {
      return null;
    }
    return { updatedAt, attemptId };
  } catch {
    return null;
  }
}

export function isValidAgentRunInspectionCursor(value: string): boolean {
  return decodeAgentRunInspectionCursor(value) !== null;
}


const LIFECYCLES = new Set<AgentActivityLifecycle>([
  "queued", "running", "completed", "failed", "cancelled", "timed_out",
]);
export function __test__mintAgentRunInspectionCursor(updatedAt: number, attemptId: string): string {
  return encodeAgentRunInspectionCursor(updatedAt, attemptId);
}

const NODE_KINDS = new Set<AgentActivityNodeKind>([
  "root_turn", "provider_round", "child_invocation", "tool_attempt",
]);
const TOOL_IDS = new Set<AgentActivityToolId>(PUBLIC_ACTIVITY_TOOL_IDS);
const ERROR_CODES = new Set<AgentPublicErrorCode>(AGENT_PUBLIC_ERROR_CODES);

export interface PersistAgentActivityRunInput {
  readonly userId: string;
  readonly chatId: string;
  readonly generationId: string;
  readonly targetMessageId?: string | null;
  readonly targetSwipeId?: number | null;
  /** Omit this for setup failures; an empty aggregate snapshot is retained. */
  readonly snapshot?: unknown;
  readonly status?: AgentActivityLifecycle;
}

interface AgentActivityRunRow {
  readonly id: number;
  readonly generation_id: string;
  readonly chat_id: string;
  readonly target_message_id: string | null;
  readonly target_swipe_id: number | null;
  readonly snapshot_json: string;
  readonly byte_size: number;
}

function boundedId(value: unknown, maxBytes = MAX_ID_BYTES): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return encoder.encode(value).byteLength <= maxBytes ? value : null;
}

function boundedNumber(value: unknown, integer = true): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_COUNTER) return null;
  if (integer && !Number.isSafeInteger(value)) return null;
  return integer ? Math.floor(value) : value;
}

function cleanUsage(value: unknown): AgentActivityUsageV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const fields = ["inputTokens", "outputTokens", "totalTokens", "toolCalls", "childInvocations"]
    .map((key) => boundedNumber(source[key]));
  if (fields.some((field) => field === null)) return undefined;
  return {
    inputTokens: fields[0]!, outputTokens: fields[1]!, totalTokens: fields[2]!,
    toolCalls: fields[3]!, childInvocations: fields[4]!,
  };
}

function cleanNode(value: unknown): AgentActivityNodeV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = boundedId(source.id);
  const kind = typeof source.kind === "string" && NODE_KINDS.has(source.kind as AgentActivityNodeKind)
    ? source.kind as AgentActivityNodeKind : null;
  const actor = source.actor === "root" || source.actor === "provider" || source.actor === "child" || source.actor === "tool"
    ? source.actor : null;
  const phase = typeof source.phase === "string" && LIFECYCLES.has(source.phase as AgentActivityLifecycle)
    ? source.phase as AgentActivityLifecycle : null;
  const status = typeof source.status === "string" && LIFECYCLES.has(source.status as AgentActivityLifecycle)
    ? source.status as AgentActivityLifecycle : null;
  const startedAt = boundedNumber(source.startedAt);
  const elapsedMs = boundedNumber(source.elapsedMs);
  if (!id || !kind || !actor || !phase || !status || startedAt === null || elapsedMs === null) return null;
  const profileId = typeof source.profileId === "string" && encoder.encode(source.profileId).byteLength <= MAX_PROFILE_ID_BYTES
    ? source.profileId : undefined;
  const taskId = source.taskId === undefined ? undefined : boundedId(source.taskId) ?? null;
  if (taskId === null) return null;
  const toolId = typeof source.toolId === "string"
    ? TOOL_IDS.has(source.toolId as AgentActivityToolId) ? source.toolId as AgentActivityToolId : "unknown_tool"
    : undefined;
  const roundIndex = boundedNumber(source.roundIndex);
  const continuationMode = source.continuationMode === "ordinary" || source.continuationMode === "finalization" || source.continuationMode === "none"
    ? source.continuationMode : undefined;
  const usage = cleanUsage(source.usage);
  const errorCode = typeof source.errorCode === "string" && ERROR_CODES.has(source.errorCode as AgentPublicErrorCode)
    ? source.errorCode as AgentPublicErrorCode : undefined;
  return {
    id, parentId: source.parentId === null ? null : boundedId(source.parentId), kind, actor, phase, status,
    ...(taskId ? { taskId } : {}), ...(profileId ? { profileId } : {}), ...(toolId ? { toolId } : {}),
    ...(roundIndex !== null ? { roundIndex } : {}), ...(continuationMode ? { continuationMode } : {}),
    startedAt, elapsedMs, ...(usage ? { usage } : {}), ...(errorCode ? { errorCode } : {}),
  };
}

function cleanErrorCounts(value: unknown): Readonly<Partial<Record<AgentPublicErrorCode, number>>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Partial<Record<AgentPublicErrorCode, number>> = {};
  for (const [code, count] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(result).length >= MAX_ERROR_CODES || !ERROR_CODES.has(code as AgentPublicErrorCode)) continue;
    const normalized = boundedNumber(count);
    if (normalized !== null && normalized > 0) result[code as AgentPublicErrorCode] = normalized;
  }
  return result;
}

function cleanSnapshot(value: unknown, generationId: string, statusOverride?: AgentActivityLifecycle): AgentActivitySnapshotV1 {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rootId = boundedId(source.rootId) ?? generationId;
  const nodes = Array.isArray(source.nodes)
    ? source.nodes.slice(0, MAX_NODES_PER_SNAPSHOT).map(cleanNode).filter((node): node is AgentActivityNodeV1 => node !== null)
    : [];
  const status = statusOverride && LIFECYCLES.has(statusOverride) ? statusOverride
    : typeof source.status === "string" && LIFECYCLES.has(source.status as AgentActivityLifecycle)
      ? source.status as AgentActivityLifecycle : "failed";
  const terminalErrorCode = typeof source.terminalErrorCode === "string" && ERROR_CODES.has(source.terminalErrorCode as AgentPublicErrorCode)
    ? source.terminalErrorCode as AgentPublicErrorCode : undefined;
  return {
    version: 1, rootId, nodes, omittedNodeCount: boundedNumber(source.omittedNodeCount) ?? 0,
    errorCounts: cleanErrorCounts(source.errorCounts),
    usage: cleanUsage(source.usage) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0, childInvocations: 0 },
    status, ...(terminalErrorCode ? { terminalErrorCode } : {}),
  };
}

function makeRun(input: PersistAgentActivityRunInput): AgentActivityRunV1 | null {
  const generationId = boundedId(input.generationId);
  if (!boundedId(input.userId) || !boundedId(input.chatId) || !generationId) return null;
  const targetMessageId = input.targetMessageId == null ? null : boundedId(input.targetMessageId);
  if (input.targetMessageId != null && !targetMessageId) return null;
  const targetSwipeId = input.targetSwipeId == null ? null : boundedNumber(input.targetSwipeId);
  if (input.targetSwipeId != null && targetSwipeId === null) return null;
  return {
    version: 1, generationId, chatId: input.chatId, targetMessageId, targetSwipeId,
    snapshot: cleanSnapshot(input.snapshot, generationId, input.status),
  };
}

function serializeRun(run: AgentActivityRunV1): { run: AgentActivityRunV1; json: string; byteSize: number } | null {
  let current = run;
  let json = JSON.stringify(current);
  let byteSize = encoder.encode(json).byteLength;
  if (byteSize <= AGENT_ACTIVITY_RUN_MAX_BYTES) return { run: current, json, byteSize };
  const nodes = [...run.snapshot.nodes];
  let omitted = run.snapshot.omittedNodeCount;
  while (nodes.length > 0 && byteSize > AGENT_ACTIVITY_RUN_MAX_BYTES) {
    nodes.splice(nodes.length > 1 ? 1 : 0, 1);
    omitted++;
    current = { ...run, snapshot: { ...run.snapshot, nodes, omittedNodeCount: omitted } };
    json = JSON.stringify(current);
    byteSize = encoder.encode(json).byteLength;
  }
  return byteSize <= AGENT_ACTIVITY_RUN_MAX_BYTES ? { run: current, json, byteSize } : null;
}

function evictOldestRuns(db: Database, userId: string, chatId: string): void {
  const rows = db.query(
    `SELECT id, byte_size FROM agent_activity_runs WHERE user_id = ? AND chat_id = ? ORDER BY created_at DESC, id DESC`,
  ).all(userId, chatId) as Array<{ id: number; byte_size: number }>;
  let totalBytes = rows.reduce((sum, row) => sum + Math.max(0, row.byte_size), 0);
  let remainingCount = rows.length;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (
      remainingCount <= AGENT_ACTIVITY_RUN_MAX_COUNT &&
      totalBytes <= AGENT_ACTIVITY_CHAT_MAX_BYTES
    ) break;
    const row = rows[index]!;
    db.query("DELETE FROM agent_activity_runs WHERE id = ?").run(row.id);
    remainingCount -= 1;
    totalBytes -= Math.max(0, row.byte_size);
  }
  if (
    remainingCount > AGENT_ACTIVITY_RUN_MAX_COUNT ||
    totalBytes > AGENT_ACTIVITY_CHAT_MAX_BYTES
  ) {
    throw new Error("agent activity eviction failed to enforce bounds");
  }
}

/** Insert the compatibility terminal activity projection into an existing transaction. */
export function persistTerminalAgentActivityRunInTransaction(
  db: Database,
  input: PersistAgentActivityRunInput,
): AgentActivityRunV1 | null {
  const prepared = makeRun(input);
  if (!prepared) return null;
  const serialized = serializeRun(prepared);
  if (!serialized) return null;
  const existing = db.query(
    `SELECT id, generation_id, chat_id, target_message_id, target_swipe_id, snapshot_json, byte_size
       FROM agent_activity_runs
      WHERE user_id = ? AND chat_id = ? AND generation_id = ?
      LIMIT 1`,
  ).get(input.userId, input.chatId, prepared.generationId) as AgentActivityRunRow | null;
  if (existing) {
    const existingRun = decodeRow(existing);
    const same = existingRun !== null
      && existing.target_message_id === serialized.run.targetMessageId
      && existing.target_swipe_id === serialized.run.targetSwipeId
      && JSON.stringify(existingRun) === JSON.stringify(serialized.run);
    if (!same) throw new Error("agent activity replay identity conflict");
    return existingRun;
  }
  db.query(
    `INSERT INTO agent_activity_runs
      (user_id, chat_id, generation_id, target_message_id, target_swipe_id, snapshot_json, byte_size)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.userId,
    input.chatId,
    prepared.generationId,
    prepared.targetMessageId,
    prepared.targetSwipeId,
    serialized.json,
    serialized.byteSize,
  );
  evictOldestRuns(db, input.userId, input.chatId);
  return serialized.run;
}

/** Call exactly once from the terminal CAS winner. The unique key makes retries idempotent. */
export function persistTerminalAgentActivityRun(input: PersistAgentActivityRunInput): AgentActivityRunV1 | null {
  try {
    const db = getDb();
    return db.transaction(() => persistTerminalAgentActivityRunInTransaction(db, input))();
  } catch {
    console.warn("[agent activity] terminal activity persistence unavailable");
    return null;
  }
}

function decodeRow(row: AgentActivityRunRow): AgentActivityRunV1 | null {
  try {
    const parsed = JSON.parse(row.snapshot_json) as Record<string, unknown>;
    return {
      version: 1, generationId: row.generation_id, chatId: row.chat_id,
      targetMessageId: row.target_message_id, targetSwipeId: row.target_swipe_id,
      snapshot: cleanSnapshot(parsed.snapshot, row.generation_id),
    };
  } catch { return null; }
}

export function listAgentActivityRuns(userId: string, chatId: string): AgentActivityRunV1[] {
  if (!boundedId(userId) || !boundedId(chatId)) return [];
  const rows = getDb().query(
    `SELECT id, generation_id, chat_id, target_message_id, target_swipe_id, snapshot_json, byte_size
     FROM agent_activity_runs WHERE user_id = ? AND chat_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(userId, chatId, AGENT_ACTIVITY_RUN_MAX_COUNT) as AgentActivityRunRow[];
  return rows.map(decodeRow).filter((run): run is AgentActivityRunV1 => run !== null);
}

function ownsChatForActivityInDb(db: Database, userId: string, chatId: string): boolean {
  if (!boundedId(userId) || !boundedId(chatId)) return false;
  return Boolean(db.query("SELECT 1 FROM chats WHERE id = ? AND user_id = ? LIMIT 1").get(chatId, userId));
}

export function ownsChatForActivity(userId: string, chatId: string): boolean {
  return ownsChatForActivityInDb(getDb(), userId, chatId);
}

export function __test__serializeAgentActivityRun(input: PersistAgentActivityRunInput) {
  const prepared = makeRun(input);
  return prepared ? serializeRun(prepared) : null;
}
export const AGENT_RUN_INSPECTION_MAX_PAYLOAD_BYTES = 64 * 1024;
export const AGENT_RUN_INSPECTION_MAX_RECORD_BYTES = 128 * 1024;
export const AGENT_RUN_INSPECTION_MAX_RECORDS = 4096;
export const AGENT_RUN_INSPECTION_MAX_LIST = 64;

const INSPECTION_PHASES = new Set([
  "ADMIT", "ASSEMBLE", "WORK", "PREPARE_COMMIT", "RENDER", "COMMIT", "TERMINAL",
]);
const INSPECTION_STATUSES = new Set(["pending", "running", "waiting", "cancelling", "terminal"]);
const INSPECTION_OUTCOMES = new Set(["completed", "stopped", "failed", "exhausted", "rejected"]);
const INSPECTION_PHASE_RANK: Readonly<Record<string, number>> = {
  ADMIT: 0,
  ASSEMBLE: 1,
  WORK: 2,
  PREPARE_COMMIT: 3,
  RENDER: 4,
  COMMIT: 5,
  TERMINAL: 6,
};
const INSPECTION_STATUS_RANK: Readonly<Record<string, number>> = {
  pending: 0,
  running: 1,
  waiting: 2,
  cancelling: 3,
  terminal: 4,
};

function inspectionLifecycleTupleRegresses(
  nextLifecycle: string,
  nextStatus: string,
  currentLifecycle: string,
  currentStatus: string,
): boolean {
  const phaseDelta = (INSPECTION_PHASE_RANK[nextLifecycle] ?? -1)
    - (INSPECTION_PHASE_RANK[currentLifecycle] ?? -1);
  if (phaseDelta !== 0) return phaseDelta < 0;
  return (INSPECTION_STATUS_RANK[nextStatus] ?? -1)
    < (INSPECTION_STATUS_RANK[currentStatus] ?? -1);
}

const INSPECTION_REASONS = new Set([
  "none", "user_stop", "deadline", "provider_failure", "tool_failure", "required_work_failure",
  "budget_exhausted", "invalid_input", "stale_input", "unavailable", "needs_attention",
  "interrupted", "retry_requested", "reconciled", "unknown",
]);
const INSPECTION_ACTORS = new Set([
  "host", "owner", "provider", "agent", "child", "tool", "cortex", "council",
]);
type InspectionReconciliation =
  | "authoritative"
  | "reconciling"
  | "recovered"
  | "stale";

const INSPECTION_RECONCILIATIONS: Readonly<Record<InspectionReconciliation, true>> = {
  authoritative: true,
  reconciling: true,
  recovered: true,
  stale: true,
};

function normalizeInspectionReconciliation(value: unknown): InspectionReconciliation {
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(INSPECTION_RECONCILIATIONS, value)
    ? value as InspectionReconciliation
    : "authoritative";
}

function normalizeInspectionGenerationType(value: unknown): AgentRunGenerationTypeV1 | null {
  if (typeof value !== "string") return null;
  return ["normal", "continue", "regenerate", "swipe"].includes(value)
    ? value as AgentRunGenerationTypeV1
    : null;
}

const SECRET_KEYS = new Set([
  "apikey", "accesstoken", "refreshtoken", "idtoken", "authorization", "cookie",
  "password", "secret", "clientsecret", "privatekey", "credential", "credentials",
  "encryptionkey",
]);
const inspectionEncoder = new TextEncoder();
type InspectionRecordKind =
  | "transcript"
  | "turn_session"
  | "activity"
  | "marker"
  | "usage"
  | "prompt"
  | "cortex"
  | "council"
  | "workspace"
  | "stop"
  | "recovery";

export interface PersistAgentRunInspectionInputV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly attemptId: string;
  readonly previousAttemptId?: string | null;
  readonly runId: string;
  readonly turnSessionId: string;
  readonly generationId: string;
  readonly generationType: AgentRunGenerationTypeV1;
  readonly targetMessageId?: string | null;
  readonly targetSwipeId?: number | null;
  readonly hostCorrelationId: string;
  readonly lifecycle: AgentInspectionLifecycleV1;
  readonly status: AgentInspectionStatusV1;
  readonly outcome?: AgentInspectionOutcomeV1 | null;
  readonly reason?: AgentInspectionReasonV1;
  readonly startedAt?: number;
  readonly updatedAt?: number;
  readonly terminalAt?: number | null;
  readonly reconciliation?: "authoritative" | "reconciling" | "recovered" | "stale";
  readonly terminalReceipt?: unknown;
  readonly transcript?: readonly unknown[];
  readonly turnSession?: readonly unknown[];
  readonly markers?: readonly unknown[];
  readonly usageEvidence?: readonly unknown[];
  readonly promptEvidence?: readonly unknown[];
  readonly cortexReceipts?: readonly unknown[];
  readonly councilReceipts?: readonly unknown[];
  readonly workspaceAssociations?: readonly unknown[];
  readonly activity?: readonly unknown[];
  readonly stop?: unknown;
}
 
export type AgentInspectionAuditKindV1 =
  | AgentInspectionRecordKindV1
  | "transcript"
  | "turn_session"
  | "marker"
  | "usage"
  | "prompt"
  | "cortex"
  | "council"
  | "workspace"
  | "activity"
  | "stop"
  | "recovery"
  | "target"
  | "policy"
  | "input"
  | "completion"
  | "commit";

export interface AgentInspectionBoundaryStateV1 {
  readonly lifecycle?: AgentInspectionLifecycleV1;
  readonly status?: AgentInspectionStatusV1;
  readonly outcome?: AgentInspectionOutcomeV1 | null;
  readonly reason?: AgentInspectionReasonV1;
  readonly updatedAt?: number;
  readonly terminalAt?: number | null;
  readonly reconciliation?: "authoritative" | "reconciling" | "recovered" | "stale";
  readonly terminalReceipt?: unknown;
}

export interface AgentInspectionWriterV1 {
  readonly record: (
    kind: AgentInspectionAuditKindV1,
    value?: unknown,
    state?: AgentInspectionBoundaryStateV1,
  ) => AgentRunInspectionDetailV1 | null;
}

export interface CreateAgentInspectionWriterInputV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly attemptId: string;
  readonly previousAttemptId?: string | null;
  readonly runId: string;
  readonly turnSessionId: string;
  readonly generationId: string;
  readonly generationType: AgentRunGenerationTypeV1;
  readonly targetMessageId?: string | null;
  readonly targetSwipeId?: number | null;
  readonly hostCorrelationId: string;
  readonly lifecycle?: AgentInspectionLifecycleV1;
  readonly status?: AgentInspectionStatusV1;
  readonly outcome?: AgentInspectionOutcomeV1 | null;
  readonly reason?: AgentInspectionReasonV1;
  readonly startedAt?: number;
  readonly reconciliation?: "authoritative" | "reconciling" | "recovered" | "stale";
}

interface InspectionAttemptRow {
  readonly user_id: string;
  readonly chat_id: string;
  readonly attempt_id: string;
  readonly previous_attempt_id: string | null;
  readonly run_id: string;
  readonly turn_id: string;
  readonly generation_id: string;
  readonly generation_type: string;
  readonly target_message_id: string | null;
  readonly target_swipe_id: number | null;
  readonly lifecycle: string;
  readonly status: string;
  readonly outcome: string | null;
  readonly reason: string;
  readonly terminal: number;
  readonly started_at: number;
  readonly updated_at: number;
  readonly terminal_at: number | null;
  readonly host_correlation_id: string;
  readonly reconciliation_state: string;
  readonly terminal_receipt_json: string | null;
  readonly version: number;
  readonly created_at: number;
}

const MAX_WORKSPACE_ID_BYTES = 128;

function sortedInspectionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortedInspectionValue(item));
  if (!value || typeof value !== "object") return value;
  const object = inspectionObject(value);
  return Object.fromEntries(
    Object.keys(object)
      .sort(compareUtf8)
      .map((key) => [key, sortedInspectionValue(object[key])]),
  );
}

const AUDIT_VOLATILE_KEYS: Readonly<Record<string, true>> = {
  late: true,
  reordered: true,
  sequence: true,
  hostSequence: true,
  occurredAt: true,
  firstSequence: true,
  lastSequence: true,
};

function auditComparisonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => auditComparisonValue(item));
  if (!value || typeof value !== "object") return value;
  const object = inspectionObject(value);
  return Object.fromEntries(
    Object.keys(object)
      .filter((key) => AUDIT_VOLATILE_KEYS[key] !== true)
      .sort(compareUtf8)
      .map((key) => [key, auditComparisonValue(object[key])]),
  );
}

function canonicalInspectionJson(value: unknown): string {
  try {
    return JSON.stringify(sortedInspectionValue(value)) ?? "{}";
  } catch {
    return "{}";
  }
}

function canonicalAuditComparisonJson(value: unknown): string {
  try {
    return JSON.stringify(auditComparisonValue(value)) ?? "{}";
  } catch {
    return "{}";
  }
}

interface ExistingAuditRecordRow {
  readonly record_id: string;
  readonly user_id: string;
  readonly chat_id: string;
  readonly attempt_id: string;
  readonly record_kind: string;
  readonly event_id: string | null;
  readonly host_sequence: number;
  readonly occurred_at: number;
  readonly late: number;
  readonly payload_json: string;
  readonly dedupe_key: string | null;
}
/** Tracks durable rows already present plus one reserved slot for a truthful truncation marker. */
interface InspectionRecordBudget {
  remaining: number;
  truncationReserved: boolean;
  omitted: boolean;
}

class InspectionRecordCapacityError extends Error {
  constructor() {
    super("inspection record budget exhausted");
    this.name = "InspectionRecordCapacityError";
  }
}

function createInspectionRecordBudget(db: Database, row: InspectionAttemptRow): InspectionRecordBudget {
  const stored = db.query(
    `SELECT COUNT(*) AS count
       FROM agent_run_audit_records
      WHERE user_id = ? AND attempt_id = ?`,
  ).get(row.user_id, row.attempt_id) as { count: number };
  const free = Math.max(0, AGENT_RUN_INSPECTION_MAX_RECORDS - Math.max(0, stored.count));
  return {
    remaining: Math.max(0, free - (free > 0 ? 1 : 0)),
    truncationReserved: free > 0,
    omitted: false,
  };
}

function reserveInspectionRecordCapacity(
  budget: InspectionRecordBudget | undefined,
  useTruncationReservation: boolean,
): void {
  if (!budget) return;
  if (useTruncationReservation && budget.truncationReserved) {
    budget.truncationReserved = false;
    return;
  }
  if (budget.remaining <= 0) throw new InspectionRecordCapacityError();
  budget.remaining -= 1;
}


function loadExistingAuditRecord(
  db: Database,
  row: InspectionAttemptRow,
  kind: InspectionRecordKind,
  id: string,
  recordId: string,
): ExistingAuditRecordRow | null {
  const byDedupe = db.query(
    `SELECT record_id, user_id, chat_id, attempt_id, record_kind, event_id,
            host_sequence, occurred_at, late, payload_json, dedupe_key
       FROM agent_run_audit_records
      WHERE user_id = ? AND attempt_id = ? AND record_kind = ? AND dedupe_key = ?
      LIMIT 1`,
  ).get(row.user_id, row.attempt_id, kind, id) as ExistingAuditRecordRow | null;
  if (byDedupe) return byDedupe;
  return db.query(
    `SELECT record_id, user_id, chat_id, attempt_id, record_kind, event_id,
            host_sequence, occurred_at, late, payload_json, dedupe_key
       FROM agent_run_audit_records
      WHERE record_id = ?
      LIMIT 1`,
  ).get(recordId) as ExistingAuditRecordRow | null;
}

function boundedInspectionString(value: unknown, maxBytes = MAX_ID_BYTES): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return inspectionEncoder.encode(value).byteLength <= maxBytes ? value : null;
}

function boundedInspectionText(value: unknown, maxBytes = AGENT_RUN_INSPECTION_MAX_PAYLOAD_BYTES): string {
  if (typeof value !== "string") return "";
  const bytes = inspectionEncoder.encode(value);
  return bytes.byteLength <= maxBytes ? value : new TextDecoder().decode(bytes.slice(0, maxBytes));
}

function boundedInspectionInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function inspectionObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function sanitizeInspectionValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[bounded]";
  if (typeof value === "string") return boundedInspectionText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => sanitizeInspectionValue(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(inspectionObject(value))) {
    const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
    if (SECRET_KEYS.has(normalized) || normalized.includes("credential") || normalized.includes("secret")) continue;
    if (normalized === "otheruserdata") continue;
    result[key] = sanitizeInspectionValue(item, depth + 1);
  }
  return result;
}

function boundedInspectionJson(value: unknown, maxBytes: number): string {
  const json = canonicalInspectionJson(sanitizeInspectionValue(value));
  if (inspectionEncoder.encode(json).byteLength <= maxBytes) return json;
  return canonicalInspectionJson({ omitted: true, marker: "truncated" });
}

function normalizeInspectionPhase(value: unknown): AgentInspectionLifecycleV1 {
  return typeof value === "string" && INSPECTION_PHASES.has(value)
    ? value as AgentInspectionLifecycleV1
    : "ADMIT";
}

function normalizeInspectionStatus(value: unknown): AgentInspectionStatusV1 {
  return typeof value === "string" && INSPECTION_STATUSES.has(value)
    ? value as AgentInspectionStatusV1
    : "pending";
}

function normalizeInspectionOutcome(value: unknown): AgentInspectionOutcomeV1 | null {
  return typeof value === "string" && INSPECTION_OUTCOMES.has(value)
    ? value as AgentInspectionOutcomeV1
    : null;
}

function normalizeInspectionReason(value: unknown): AgentInspectionReasonV1 {
  if (value === undefined || value === null) return "none";
  return typeof value === "string" && INSPECTION_REASONS.has(value)
    ? value as AgentInspectionReasonV1
    : "needs_attention";
}

function loadInspectionAttempt(
  db: Database,
  userId: string,
  attemptId: string,
  chatId?: string,
): InspectionAttemptRow | null {
  const boundedUserId = boundedInspectionString(userId);
  const boundedAttemptId = boundedInspectionString(attemptId);
  const boundedChatId = chatId === undefined ? undefined : boundedInspectionString(chatId);
  if (!boundedUserId || !boundedAttemptId || (chatId !== undefined && !boundedChatId)) return null;
  const query = `SELECT user_id, chat_id, attempt_id, previous_attempt_id, run_id, turn_id,
      generation_id, generation_type, target_message_id, target_swipe_id, lifecycle, status,
      outcome, reason, terminal, started_at, updated_at, terminal_at, host_correlation_id,
      reconciliation_state, terminal_receipt_json, version, created_at
    FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?${chatId !== undefined ? " AND chat_id = ?" : ""}`;
  return boundedChatId === undefined
    ? db.query(query).get(boundedUserId, boundedAttemptId) as InspectionAttemptRow | null
    : db.query(query).get(boundedUserId, boundedAttemptId, boundedChatId) as InspectionAttemptRow | null;
}
function inspectionSourceDeletionExists(
  db: Database,
  userId: string,
  attemptId: string,
): boolean {
  const tableExists = db.query(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_run_source_deletions' LIMIT 1",
  ).get() !== null;
  return tableExists && db.query(
    "SELECT 1 FROM agent_run_source_deletions WHERE user_id = ? AND attempt_id = ? LIMIT 1",
  ).get(userId, attemptId) !== null;
}

function inspectionTargetIsValid(db: Database, row: InspectionAttemptRow): boolean {
  if (row.target_message_id === null) return row.target_swipe_id === null;
  const message = db.query(
    "SELECT swipes FROM messages WHERE chat_id = ? AND id = ? LIMIT 1",
  ).get(row.chat_id, row.target_message_id) as { swipes?: unknown } | null;
  if (!message) return false;
  if (row.target_swipe_id === null) return true;
  if (typeof message.swipes !== "string") return false;
  try {
    const swipes = JSON.parse(message.swipes);
    return Array.isArray(swipes) && row.target_swipe_id < swipes.length;
  } catch {
    return false;
  }
}

function inspectionTarget(row: InspectionAttemptRow): AgentRunTargetV1 | null {
  return row.target_message_id ? { messageId: row.target_message_id, swipeId: row.target_swipe_id ?? 0 } : null;
}

function inspectionCommittedTarget(row: InspectionAttemptRow): AgentRunTargetV1 | null {
  if (!row.terminal_receipt_json) return null;
  try {
    const receipt = JSON.parse(row.terminal_receipt_json) as Record<string, unknown>;
    const messageId = boundedInspectionString(receipt.messageId);
    const swipeId = receipt.swipeId;
    return messageId && Number.isSafeInteger(swipeId) && Number(swipeId) >= 0
      ? { messageId, swipeId: Number(swipeId) }
      : null;
  } catch {
    return null;
  }
}

function inspectionTargetMatches(
  row: InspectionAttemptRow,
  targetMessageId: string | null | undefined,
  targetSwipeId: number | null | undefined,
): boolean {
  return (targetMessageId === undefined || targetMessageId === row.target_message_id)
    && (targetSwipeId === undefined || targetSwipeId === row.target_swipe_id);
}

function inspectionLineage(row: InspectionAttemptRow): AgentInspectionAttemptLineageV1 {
  return {
    version: 1,
    attemptId: row.attempt_id,
    previousAttemptId: row.previous_attempt_id,
    target: {
      chatId: row.chat_id,
      generationType: row.generation_type as AgentRunGenerationTypeV1,
      messageId: row.target_message_id,
      swipeId: row.target_swipe_id,
    },
    createdAt: row.created_at,
  };
}

function inspectionCorrelation(row: InspectionAttemptRow, value: unknown, sequence = 0): AgentInspectionCorrelationV1 {
  const source = inspectionObject(value);
  return {
    turnSessionId: boundedInspectionString(source.turnSessionId) ?? row.turn_id,
    runId: boundedInspectionString(source.runId) ?? row.run_id,
    attemptId: row.attempt_id,
    chatId: row.chat_id,
    generationId: row.generation_id,
    messageId: source.messageId === null ? null : boundedInspectionString(source.messageId) ?? row.target_message_id,
    swipeId: source.swipeId === null
      ? null
      : source.swipeId === undefined
        ? row.target_swipe_id
        : boundedInspectionInteger(source.swipeId, row.target_swipe_id ?? 0),
    actorId: source.actorId === null ? null : boundedInspectionString(source.actorId),
    recipientId: source.recipientId === null ? null : boundedInspectionString(source.recipientId),
    phase: normalizeInspectionPhase(source.phase ?? row.lifecycle),
    taskId: source.taskId === null ? null : boundedInspectionString(source.taskId),
    toolId: source.toolId === null ? null : boundedInspectionString(source.toolId, 128),
    parentId: source.parentId === null ? null : boundedInspectionString(source.parentId),
    hostCorrelationId: row.host_correlation_id,
    hostSequence: boundedInspectionInteger(source.hostSequence, sequence),
  };
}

const INSPECTION_MARKER_SCOPES: Readonly<Record<InspectionRecordKind, string>> = {
  transcript: "transcript",
  turn_session: "turn_session",
  activity: "activity",
  marker: "run",
  usage: "usage",
  prompt: "prompt",
  cortex: "cortex",
  council: "council",
  workspace: "workspace",
  stop: "run",
  recovery: "run",
};

function auditRecord(
  db: Database,
  row: InspectionAttemptRow,
  kind: InspectionRecordKind,
  id: string,
  value: unknown,
  sequence: number,
  occurredAt: number,
  late = false,
  postTerminal = false,
  emitMarkers = true,
  budget?: InspectionRecordBudget,
  useTruncationReservation = false,
): InspectionObject {
  const source = inspectionObject(sanitizeInspectionValue(value));
  const hasExplicitSequence = source.sequence !== undefined
    || source.hostSequence !== undefined
    || (kind === "marker" && (source.firstSequence !== undefined || source.lastSequence !== undefined));
  const previous = db.query(
    `SELECT MAX(host_sequence) AS max_sequence
       FROM agent_run_audit_records
      WHERE user_id = ? AND attempt_id = ?`,
  ).get(row.user_id, row.attempt_id) as { max_sequence: number | null } | null;
  const reordered = source.reordered === true
    || (hasExplicitSequence && previous?.max_sequence != null && sequence < previous.max_sequence);
  const recordLate = late || postTerminal || source.late === true;
  const candidate: InspectionObject = {
    ...source,
    version: 1,
    correlation: inspectionCorrelation(row, source.correlation, sequence),
  };
  let payload: InspectionObject;
  if (kind === "workspace") {
    const normalized = normalizeInspectionWorkspace(row, candidate);
    if (!normalized) throw new Error("invalid workspace association");
    payload = inspectionObject(normalized);
  } else {
    payload = candidate;
    if (recordLate) payload.late = true;
    if (reordered) payload.reordered = true;
  }
  const json = kind === "workspace"
    ? canonicalInspectionJson(payload)
    : boundedInspectionJson(payload, AGENT_RUN_INSPECTION_MAX_RECORD_BYTES);
  let persistedPayload: InspectionObject;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid bounded audit payload");
    persistedPayload = parsed as InspectionObject;
  } catch {
    throw new Error("invalid bounded audit payload");
  }
  const recordId = `${row.user_id}:${row.attempt_id}:${kind}:${id}`;
  const existing = loadExistingAuditRecord(db, row, kind, id, recordId);
  if (existing) {
    if (
      existing.record_id !== recordId
      || existing.user_id !== row.user_id
      || existing.chat_id !== row.chat_id
      || existing.attempt_id !== row.attempt_id
      || existing.record_kind !== kind
      || existing.event_id !== id
      || existing.dedupe_key !== id
    ) {
      throw new Error("audit record identity conflict");
    }
    let existingPayload: InspectionObject;
    try {
      const parsed = JSON.parse(existing.payload_json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid audit payload");
      existingPayload = parsed as InspectionObject;
    } catch {
      throw new Error("invalid existing audit payload");
    }
    if (kind === "workspace") {
      const currentWorkspace = normalizeInspectionWorkspace(row, payload);
      const persistedWorkspace = normalizeInspectionWorkspace(row, persistedPayload);
      const existingWorkspace = normalizeInspectionWorkspace(row, existingPayload);
      if (
        !currentWorkspace
        || !persistedWorkspace
        || !existingWorkspace
        || !workspaceAssociationReplayMatches(persistedWorkspace, existingWorkspace)
      ) {
        throw new Error("audit record payload conflict");
      }
    } else if (
      canonicalAuditComparisonJson(existingPayload) !== canonicalAuditComparisonJson(persistedPayload)
    ) {
      throw new Error("audit record payload conflict");
    }
  } else {
    reserveInspectionRecordCapacity(budget, useTruncationReservation);
    db.query(
      `INSERT INTO agent_run_audit_records
        (record_id, user_id, chat_id, attempt_id, record_kind, event_id, host_sequence,
         occurred_at, late, payload_json, byte_size, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      recordId,
      row.user_id,
      row.chat_id,
      row.attempt_id,
      kind,
      id,
      sequence,
      occurredAt,
      recordLate ? 1 : 0,
      json,
      inspectionEncoder.encode(json).byteLength,
      id,
    );
  }
  if (!emitMarkers) return payload;

  const markerValues: Array<{
    kind: "late_event" | "reordered_event";
    detail: string;
  }> = [];
  if (recordLate) {
    markerValues.push({
      kind: "late_event",
      detail: postTerminal ? "Record arrived after the terminal attempt." : "Record was marked late by its source.",
    });
  }
  if (reordered) {
    markerValues.push({
      kind: "reordered_event",
      detail: "Record host sequence arrived out of order.",
    });
  }
  for (const marker of markerValues) {
    try {
      auditRecord(
        db,
        row,
        "marker",
        `${kind}:${id}:${marker.kind}`,
        {
          id: `${kind}:${id}:${marker.kind}`,
          kind: marker.kind,
          scope: INSPECTION_MARKER_SCOPES[kind],
          correlation: payload.correlation,
          firstSequence: sequence,
          lastSequence: sequence,
          recoverable: true,
          detail: marker.detail,
        },
        sequence,
        occurredAt,
        recordLate,
        false,
        false,
        budget,
      );
    } catch (error) {
      if (!(error instanceof InspectionRecordCapacityError) || !budget) throw error;
      budget.omitted = true;
    }
  }
  return payload;
}

function workspaceAssociationReplayMatches(
  current: AgentWorkspaceAssociationV1,
  accepted: AgentWorkspaceAssociationV1,
): boolean {
  return current.version === accepted.version
    && current.id === accepted.id
    && current.workspaceId === accepted.workspaceId
    && current.workspaceRevision === accepted.workspaceRevision
    && current.relation === accepted.relation
    && current.objectKind === accepted.objectKind
    && current.objectId === accepted.objectId
    && current.sourceRevision === accepted.sourceRevision
    && current.sourceDeleted === accepted.sourceDeleted
    && current.provenanceDigest === accepted.provenanceDigest
    && current.correlation.turnSessionId === accepted.correlation.turnSessionId
    && current.correlation.runId === accepted.correlation.runId
    && current.correlation.attemptId === accepted.correlation.attemptId
    && current.correlation.chatId === accepted.correlation.chatId
    && current.correlation.generationId === accepted.correlation.generationId
    && current.correlation.messageId === accepted.correlation.messageId
    && current.correlation.swipeId === accepted.correlation.swipeId
    && current.correlation.actorId === accepted.correlation.actorId
    && current.correlation.recipientId === accepted.correlation.recipientId
    && current.correlation.phase === accepted.correlation.phase
    && current.correlation.taskId === accepted.correlation.taskId
    && current.correlation.toolId === accepted.correlation.toolId
    && current.correlation.parentId === accepted.correlation.parentId
    && current.correlation.hostCorrelationId === accepted.correlation.hostCorrelationId;
}

function persistWorkspaceAssociationProjection(
  db: Database,
  row: InspectionAttemptRow,
  id: string,
  currentPayload: InspectionObject,
): void {
  const associationTable = db.query(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_run_workspace_associations' LIMIT 1",
  ).get() !== null;
  const workspaceTable = db.query(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'persistent_workspaces' LIMIT 1",
  ).get() !== null;
  if (!associationTable || !workspaceTable) {
    throw new Error("workspace association schema unavailable");
  }
  const current = normalizeInspectionWorkspace(row, currentPayload);
  if (!current || current.id !== id) throw new Error("invalid workspace association");
  const persistentWorkspace = db.query(
    `SELECT workspace_id, chat_id, revision
       FROM persistent_workspaces
      WHERE workspace_id = ? AND user_id = ?
      LIMIT 1`,
  ).get(current.workspaceId, row.user_id) as {
    workspace_id: string;
    chat_id: string | null;
    revision: number;
  } | null;
  if (!persistentWorkspace) {
    throw new Error("workspace association workspace is not owned");
  }
  const audit = db.query(
    `SELECT payload_json
       FROM agent_run_audit_records
      WHERE user_id = ? AND attempt_id = ? AND record_kind = 'workspace' AND dedupe_key = ?
      LIMIT 1`,
  ).get(row.user_id, row.attempt_id, id) as { payload_json: string } | null;
  if (!audit) throw new Error("workspace association audit record missing");
  let acceptedPayload: InspectionObject;
  try {
    const parsed = JSON.parse(audit.payload_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid audit payload");
    acceptedPayload = parsed as InspectionObject;
  } catch {
    throw new Error("invalid workspace association audit payload");
  }
  const accepted = normalizeInspectionWorkspace(row, acceptedPayload);
  if (!accepted || accepted.id !== id) throw new Error("invalid accepted workspace association");
  if (!workspaceAssociationReplayMatches(current, accepted)) {
    throw new Error("workspace association identity conflict");
  }
  const existing = db.query(
    `SELECT association_id, user_id, chat_id, attempt_id, workspace_id, workspace_revision,
            relation, object_kind, object_id, source_revision, source_deleted,
            provenance_digest, host_sequence
       FROM agent_run_workspace_associations
      WHERE association_id = ?
      LIMIT 1`,
  ).get(accepted.id) as {
    association_id: string;
    user_id: string;
    chat_id: string;
    attempt_id: string;
    workspace_id: string;
    workspace_revision: number;
    relation: string;
    object_kind: string;
    object_id: string | null;
    source_revision: number | null;
    source_deleted: number;
    provenance_digest: string | null;
    host_sequence: number;
  } | null;
  if (existing) {
    const matches = existing.user_id === row.user_id
      && existing.chat_id === row.chat_id
      && existing.attempt_id === row.attempt_id
      && existing.workspace_id === accepted.workspaceId
      && existing.workspace_revision === accepted.workspaceRevision
      && existing.relation === accepted.relation
      && existing.object_kind === accepted.objectKind
      && existing.object_id === accepted.objectId
      && existing.source_revision === accepted.sourceRevision
      && existing.source_deleted === (accepted.sourceDeleted ? 1 : 0)
      && existing.provenance_digest === accepted.provenanceDigest;
    if (!matches) {
      throw new Error("workspace association identity conflict");
    }
    return;
  }
  if (
    persistentWorkspace.chat_id === null
    || persistentWorkspace.chat_id !== row.chat_id
    || persistentWorkspace.revision !== current.workspaceRevision
  ) {
    throw new Error("workspace association workspace boundary conflict");
  }
  db.query(
    `INSERT INTO agent_run_workspace_associations
      (association_id, user_id, chat_id, attempt_id, workspace_id, workspace_revision,
       relation, object_kind, object_id, source_revision, source_deleted,
       provenance_digest, host_sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    accepted.id,
    row.user_id,
    row.chat_id,
    row.attempt_id,
    accepted.workspaceId,
    accepted.workspaceRevision,
    accepted.relation,
    accepted.objectKind,
    accepted.objectId,
    accepted.sourceRevision,
    accepted.sourceDeleted ? 1 : 0,
    accepted.provenanceDigest,
    accepted.correlation.hostSequence,
  );
}


function persistInspectionRecords(
  db: Database,
  row: InspectionAttemptRow,
  input: PersistAgentRunInspectionInputV1,
  postTerminal = false,
): void {
  const groups: readonly [InspectionRecordKind, readonly unknown[] | undefined][] = [
    ["transcript", input.transcript],
    ["turn_session", input.turnSession],
    ["marker", input.markers],
    ["usage", input.usageEvidence],
    ["prompt", input.promptEvidence],
    ["cortex", input.cortexReceipts],
    ["council", input.councilReceipts],
    ["workspace", input.workspaceAssociations],
    ["activity", input.activity],
  ];
  const budget = createInspectionRecordBudget(db, row);
  let omitted = budget.omitted;
  for (const [kind, values] of groups) {
    for (const [index, value] of (values ?? []).entries()) {
      const source = inspectionObject(value);
      const id = boundedInspectionString(source.id) ?? `${row.updated_at}:${kind}:${index}`;
      const requestedSequence = source.sequence
        ?? source.hostSequence
        ?? (kind === "marker" ? source.firstSequence ?? source.lastSequence : undefined);
      let acceptedPayload: InspectionObject | null = null;
      try {
        acceptedPayload = auditRecord(
          db,
          row,
          kind,
          id,
          value,
          boundedInspectionInteger(requestedSequence, index + 1),
          boundedInspectionInteger(source.occurredAt, row.updated_at),
          source.late === true,
          postTerminal,
          true,
          budget,
        );
      } catch (error) {
        if (!(error instanceof InspectionRecordCapacityError)) throw error;
        omitted = true;
      }
      if (kind === "workspace" && acceptedPayload) {
        persistWorkspaceAssociationProjection(db, row, id, acceptedPayload);
      }
    }
  }
  omitted ||= budget.omitted;
  if (input.stop != null) {
    try {
      auditRecord(
        db,
        row,
        "stop",
        `stop:${row.updated_at}`,
        input.stop,
        0,
        row.updated_at,
        false,
        postTerminal,
        true,
        budget,
      );
    } catch (error) {
      if (!(error instanceof InspectionRecordCapacityError)) throw error;
      omitted = true;
    }
  }
  omitted ||= budget.omitted;
  if (!omitted) return;

  const id = "inspection-record-budget";
  try {
    auditRecord(
      db,
      row,
      "marker",
      id,
      {
        id,
        kind: "truncated",
        scope: "run",
        correlation: inspectionCorrelation(row, {}, 0),
        firstSequence: null,
        lastSequence: null,
        recoverable: true,
        detail: "Inspection record budget exhausted; additional records omitted.",
      },
      0,
      row.updated_at,
      false,
      postTerminal,
      false,
      budget,
      true,
    );
  } catch (error) {
    if (!(error instanceof InspectionRecordCapacityError)) throw error;
  }
}


interface AuditRowsProjection {
  readonly records: readonly InspectionObject[];
  readonly unavailableMarkers: readonly AgentInspectionMarkerV1[];
  readonly invalidCount: number;
  readonly selectedCount: number;
  readonly omittedCount: number;
}

const AUDIT_ROW_MARKER_SCOPES: Readonly<Partial<Record<InspectionRecordKind, AgentInspectionMarkerV1["scope"]>>> = {
  transcript: "transcript",
  turn_session: "turn_session",
  activity: "activity",
  marker: "run",
  usage: "usage",
  prompt: "prompt",
  cortex: "cortex",
  council: "council",
  workspace: "workspace",
  stop: "run",
  recovery: "run",
};

function auditRows(
  db: Database,
  row: InspectionAttemptRow,
  kind: InspectionRecordKind,
  limit = AGENT_RUN_INSPECTION_MAX_RECORDS,
): AuditRowsProjection {
  const totalRow = db.query(
    `SELECT COUNT(*) AS count FROM agent_run_audit_records
      WHERE user_id = ? AND chat_id = ? AND attempt_id = ? AND record_kind = ?`,
  ).get(row.user_id, row.chat_id, row.attempt_id, kind) as { count: number };
  const selectedLimit = Math.max(0, Math.min(limit, AGENT_RUN_INSPECTION_MAX_RECORDS));
  const rows = db.query(
    `SELECT payload_json FROM agent_run_audit_records
      WHERE user_id = ? AND chat_id = ? AND attempt_id = ? AND record_kind = ?
      ORDER BY host_sequence, record_id LIMIT ?`,
  ).all(row.user_id, row.chat_id, row.attempt_id, kind, selectedLimit) as Array<{ payload_json: string }>;
  const scope = AUDIT_ROW_MARKER_SCOPES[kind] ?? "run";
  const records: InspectionObject[] = [];
  const unavailableMarkers: AgentInspectionMarkerV1[] = [];
  let invalidCount = 0;
  for (const [index, item] of rows.entries()) {
    try {
      const value = JSON.parse(item.payload_json);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid audit payload");
      records.push(value as InspectionObject);
    } catch {
      invalidCount += 1;
      unavailableMarkers.push(unavailableInspectionMarker(
        row,
        `${row.attempt_id}:${scope}:corrupt:${index}`,
        scope,
        {},
        `${scope} record unavailable: malformed or corrupt payload.`,
      ));
    }
  }
  const omittedCount = Math.max(0, totalRow.count - rows.length);
  if (omittedCount > 0) {
    invalidCount += omittedCount;
    const id = `${row.attempt_id}:${scope}:truncated`;
    const detail = `${scope} records truncated: additional records omitted.`;
    unavailableMarkers.push(scope === "prompt"
      ? {
          version: 1,
          id,
          kind: "truncated",
          scope,
          correlation: null,
          firstSequence: null,
          lastSequence: null,
          recoverable: false,
          detail,
        }
      : unavailableInspectionMarker(row, id, scope, {}, detail));
  }
  return {
    records,
    unavailableMarkers,
    invalidCount,
    selectedCount: rows.length,
    omittedCount,
  };

}

const INSPECTION_RECORD_KINDS: ReadonlySet<string> = new Set([
  "prompt", "provider_exchange", "agent_exchange", "delegation", "child_result", "tool",
  "condition", "checkpoint", "task", "workspace", "hook", "usage", "failure", "terminal",
  "stop", "recovery", "milestone",
]);
const INSPECTION_MARKER_KINDS: ReadonlySet<string> = new Set([
  "reconnect_gap", "late_event", "reordered_event", "truncated", "unavailable",
  "credentials_withheld", "other_user_data_withheld", "recovered_duplicate",
]);
const INSPECTION_MARKER_SCOPE_VALUES: ReadonlySet<string> = new Set([
  "run", "activity", "transcript", "turn_session", "usage", "prompt", "cortex", "council", "workspace",
]);
const TURN_SESSION_KINDS: ReadonlySet<string> = new Set([
  "target", "input", "policy", "condition", "hook", "cancellation", "completion", "commit",
  "terminal", "retry", "recovery",
]);
const PROMPT_DESTINATIONS: ReadonlySet<string> = new Set([
  "root_work", "child_work", "completion_handoff", "render", "council", "cortex",
]);
const PROMPT_ROLES: ReadonlySet<string> = new Set([
  "system", "user", "assistant", "tool", "context", "policy",
]);
const RECEIPT_STATES: ReadonlySet<string> = new Set(["accepted", "omitted", "failed", "cancelled"]);
const WORKSPACE_RELATIONS: ReadonlySet<string> = new Set(["linked", "published", "omitted"]);
const WORKSPACE_OBJECT_KINDS: ReadonlySet<string> = new Set([
  "objective", "task", "finding", "decision", "question", "submission", "artifact", "publication",
]);
const USAGE_SOURCES: ReadonlySet<string> = new Set([
  "provider_reported", "provisional", "final", "recovered_duplicate",
]);
const USAGE_LAYERS: readonly AgentInspectionUsageLayerIdV1[] = [
  "root", "child", "provider", "tool", "cortex", "council",
];
const ACTIVITY_KINDS: ReadonlySet<string> = new Set(["root", "provider", "child", "tool", "milestone"]);
const ACTIVITY_ACTORS: ReadonlySet<string> = new Set(["host", "owner", "provider", "agent", "child", "tool"]);
const CORTEX_OMISSION_REASONS: ReadonlySet<string> = new Set([
  "stale", "unauthorized", "unavailable", "cancelled", "failed", "limit_exceeded", "snapshot_mismatch",
]);
const INSPECTION_AUTHORITIES: ReadonlySet<string> = new Set([
  "host", "preset", "provider", "owner", "system", "cortex", "council",
]);
const INSPECTION_SOURCES: ReadonlySet<string> = new Set([
  "execution", "projection", "provider", "tool", "host", "recovery", "cortex", "council", "unknown",
]);
const INSPECTION_SCOPES: ReadonlySet<string> = new Set([
  "run", "attempt", "turn_session", "target", "phase", "provider", "tool", "usage",
  "transcript", "cortex", "council", "workspace",
]);
const RECOVERY_ACTIONS: ReadonlySet<string> = new Set([
  "retry", "repair", "reselect", "use_response", "resync", "none",
]);
const PUBLIC_ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  "capacity", "budget", "context", "integrity", "timeout", "cancelled", "provider", "validation", "internal",
]);

function hasInspectionCorrelation(row: InspectionAttemptRow, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = inspectionObject(value);
  return source.turnSessionId === row.turn_id
    && source.runId === row.run_id
    && source.attemptId === row.attempt_id
    && source.chatId === row.chat_id
    && source.generationId === row.generation_id
    && source.hostCorrelationId === row.host_correlation_id
    && isSafeInspectionInteger(source.hostSequence);
}

function nullableInspectionText(value: unknown, maxBytes: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || inspectionEncoder.encode(value).byteLength > maxBytes) return undefined;
  return value;
}

function unavailableInspectionMarker(
  row: InspectionAttemptRow,
  id: string,
  scope: AgentInspectionMarkerV1["scope"],
  value: InspectionObject,
  detail: string,
): AgentInspectionMarkerV1 {
  const sequence = isSafeInspectionInteger(value.sequence)
    ? value.sequence
    : isSafeInspectionInteger(value.hostSequence) ? value.hostSequence : null;
  return {
    version: 1,
    id: boundedInspectionString(id) ?? `${row.attempt_id}:${scope}:unavailable`,
    kind: "unavailable",
    scope,
    correlation: hasInspectionCorrelation(row, value.correlation)
      ? inspectionCorrelation(row, value.correlation)
      : null,
    firstSequence: sequence,
    lastSequence: sequence,
    recoverable: false,
    detail,
  };
}

function parseInspectionMarker(
  row: InspectionAttemptRow,
  value: InspectionObject,
): AgentInspectionMarkerV1 | null {
  if (
    value.version !== 1
    || !boundedInspectionString(value.id)
    || typeof value.kind !== "string"
    || !INSPECTION_MARKER_KINDS.has(value.kind)
    || typeof value.scope !== "string"
    || !INSPECTION_MARKER_SCOPE_VALUES.has(value.scope)
    || (value.correlation !== null && !hasInspectionCorrelation(row, value.correlation))
    || !(value.firstSequence === null || isSafeInspectionInteger(value.firstSequence))
    || !(value.lastSequence === null || isSafeInspectionInteger(value.lastSequence))
    || !(value.recoverable === null || typeof value.recoverable === "boolean")
    || nullableInspectionText(value.detail, 2048) === undefined
  ) return null;
  const kind = value.kind as AgentInspectionMarkerV1["kind"];
  const scope = value.scope as AgentInspectionMarkerV1["scope"];
  const detail = nullableInspectionText(value.detail, 2048);
  return {
    version: 1,
    id: value.id as string,
    kind,
    scope,
    correlation: value.correlation === null
      ? null
      : inspectionCorrelation(row, value.correlation),
    firstSequence: value.firstSequence as number | null,
    lastSequence: value.lastSequence as number | null,
    recoverable: value.recoverable as boolean | null,
    detail: detail as string | null,
  };
}


function isSafeInspectionInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeInspectionUsage(
  row: InspectionAttemptRow,
  value: InspectionObject,
): AgentInspectionUsageV1 | null {
  if (
    value.version !== 1
    || !boundedInspectionString(value.id)
    || typeof value.source !== "string"
    || !USAGE_SOURCES.has(value.source)
    || !hasInspectionCorrelation(row, value.correlation)
    || !isSafeInspectionInteger(value.inputTokens)
    || !isSafeInspectionInteger(value.outputTokens)
    || !isSafeInspectionInteger(value.totalTokens)
    || !isSafeInspectionInteger(value.toolCalls)
    || !isSafeInspectionInteger(value.childInvocations)
    || typeof value.canonical !== "boolean"
    || (value.layer !== undefined && (typeof value.layer !== "string" || !USAGE_LAYERS.includes(value.layer as AgentInspectionUsageLayerIdV1)))
  ) return null;
  const source = value.source as AgentInspectionUsageV1["source"];
  const layer = value.layer === undefined ? undefined : value.layer as AgentInspectionUsageLayerIdV1;
  return {
    version: 1,
    id: value.id as string,
    source,
    ...(layer === undefined ? {} : { layer }),
    correlation: inspectionCorrelation(row, value.correlation),
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    toolCalls: value.toolCalls,
    childInvocations: value.childInvocations,
    canonical: value.canonical,
  };
}
function normalizeCortexRevision(value: unknown): AgentCortexReceiptV1["sourceRevision"] | null {
  if (isSafeInspectionInteger(value)) return value;
  return boundedInspectionString(value, 256);
}

function validReceiptState(value: unknown): value is AgentCortexReceiptV1["state"] {
  return typeof value === "string" && RECEIPT_STATES.has(value);
}

function isInspectionReason(value: unknown): value is AgentInspectionReasonV1 {
  return typeof value === "string" && INSPECTION_REASONS.has(value);
}

function validInspectionReason(value: unknown): value is AgentInspectionReasonV1 | null {
  return value === null || isInspectionReason(value);
}


function normalizeCortexReceipt(
  row: InspectionAttemptRow,
  value: InspectionObject,
): AgentCortexReceiptV1 | null {
  const scope = inspectionObject(value.scope);
  const omission = value.omission === null || value.omission === undefined
    ? null
    : inspectionObject(value.omission);
  const omissionReason = omission && typeof omission.reason === "string" && CORTEX_OMISSION_REASONS.has(omission.reason)
    ? omission.reason as NonNullable<AgentCortexReceiptV1["omission"]>["reason"]
    : null;
  if (
    value.version !== 1
    || !boundedInspectionString(value.id)
    || !boundedInspectionString(value.requestId)
    || value.attemptId !== row.attempt_id
    || value.checkpoint !== "WORK"
    || !boundedInspectionString(value.snapshotId)
    || typeof value.required !== "boolean"
    || !isSafeInspectionInteger(value.startedAt)
    || !(value.completedAt === null || isSafeInspectionInteger(value.completedAt))
    || !validReceiptState(value.state)
    || normalizeCortexRevision(value.sourceRevision) === null
    || normalizeCortexRevision(value.revision) === null
    || !(value.resultDigest === null || boundedInspectionString(value.resultDigest, 256) !== null)
    || !isSafeInspectionInteger(value.resultCount)
    || !hasInspectionCorrelation(row, value.correlation)
    || !validInspectionReason(value.reason)
    || value.canonical !== false
    || scope.chatId !== row.chat_id
    || scope.targetMessageId !== row.target_message_id
    || scope.targetSwipeId !== row.target_swipe_id
    || (value.omission !== null && value.omission !== undefined
      && (
        omissionReason === null
        || typeof omission?.required !== "boolean"
        || omission?.required !== value.required
        || !(omission?.detail === null || nullableInspectionText(omission?.detail, 2048) !== undefined)
      ))
    || (value.state === "accepted" ? omissionReason !== null : omissionReason === null)
  ) return null;
  return {
    version: 1,
    id: value.id as string,
    requestId: value.requestId as string,
    attemptId: row.attempt_id,
    checkpoint: "WORK",
    snapshotId: value.snapshotId as string,
    sourceRevision: normalizeCortexRevision(value.sourceRevision) as AgentCortexReceiptV1["sourceRevision"],
    revision: normalizeCortexRevision(value.revision) as AgentCortexReceiptV1["revision"],
    scope: {
      chatId: row.chat_id,
      targetMessageId: row.target_message_id,
      targetSwipeId: row.target_swipe_id,
    },
    required: value.required,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    state: value.state,
    resultDigest: value.resultDigest as string | null,
    resultCount: value.resultCount,
    correlation: inspectionCorrelation(row, value.correlation),
    reason: value.reason as AgentCortexReceiptV1["reason"],
    omission: omissionReason === null
      ? null
      : {
        reason: omissionReason,
        required: omission?.required as boolean,
        detail: omission?.detail as string | null,
      },
    canonical: false,
  };
}

function normalizeCouncilReceipt(
  row: InspectionAttemptRow,
  value: InspectionObject,
): AgentCouncilReceiptV1 | null {
  const startedAt = isSafeInspectionInteger(value.startedAt) ? value.startedAt : null;
  if (
    value.version !== 1
    || !boundedInspectionString(value.id)
    || !boundedInspectionString(value.requestId)
    || value.checkpoint !== "WORK"
    || (value.required !== true && value.required !== false)
    || !(value.completedAt === null || isSafeInspectionInteger(value.completedAt))
    || !validReceiptState(value.state)
    || !isSafeInspectionInteger(value.memberCount)
    || !(value.resultDigest === null || boundedInspectionString(value.resultDigest, 256) !== null)
    || !hasInspectionCorrelation(row, value.correlation)
    || !validInspectionReason(value.reason)
    || value.canonical !== false
    || startedAt === null
  ) return null;
  return {
    version: 1,
    id: value.id as string,
    requestId: value.requestId as string,
    checkpoint: "WORK",
    required: value.required,
    startedAt,
    completedAt: value.completedAt,
    state: value.state,
    memberCount: value.memberCount,
    resultDigest: value.resultDigest as string | null,
    correlation: inspectionCorrelation(row, value.correlation),
    reason: value.reason as AgentCouncilReceiptV1["reason"],
    canonical: false,
  };
}

function normalizeInspectionTranscript(
  row: InspectionAttemptRow,
  value: InspectionObject,
): AgentInspectionTranscriptRecordV1 | null {
  const provider = value.provider === null || value.provider === undefined
    ? null
    : inspectionObject(value.provider);
  const content = nullableInspectionText(value.content, AGENT_RUN_INSPECTION_MAX_PAYLOAD_BYTES);
  const argumentsText = nullableInspectionText(value.arguments, AGENT_RUN_INSPECTION_MAX_PAYLOAD_BYTES);
  const result = nullableInspectionText(value.result, AGENT_RUN_INSPECTION_MAX_PAYLOAD_BYTES);
  if (
    value.version !== 1
    || !boundedInspectionString(value.id)
    || typeof value.kind !== "string"
    || !INSPECTION_RECORD_KINDS.has(value.kind)
    || typeof value.actor !== "string"
    || !INSPECTION_ACTORS.has(value.actor)
    || !(value.recipient === null || (typeof value.recipient === "string" && INSPECTION_ACTORS.has(value.recipient)))
    || !hasInspectionCorrelation(row, value.correlation)
    || !isSafeInspectionInteger(value.occurredAt)
    || !(value.durationMs === null || isSafeInspectionInteger(value.durationMs))
    || typeof value.late !== "boolean"
    || (content === undefined || argumentsText === undefined || result === undefined)
    || (value.errorReason !== undefined && !validInspectionReason(value.errorReason))
    || (provider !== null && (
      !boundedInspectionString(provider.adapter, 128)
      || !(provider.providerId === null || boundedInspectionString(provider.providerId, 128) !== null)
      || !(provider.modelId === null || boundedInspectionString(provider.modelId, 256) !== null)
      || !(provider.connectionId === null
        || provider.connectionId === undefined
        || boundedInspectionString(provider.connectionId, 256) !== null)
      || !(provider.configRevision === null
        || provider.configRevision === undefined
        || normalizeCortexRevision(provider.configRevision) !== null)
      || !(provider.connectionRevision === null
        || provider.connectionRevision === undefined
        || normalizeCortexRevision(provider.connectionRevision) !== null)
      || !(provider.fingerprint === null
        || provider.fingerprint === undefined
        || boundedInspectionString(provider.fingerprint, 256) !== null)
    ))
  ) return null;
  const kind = value.kind as AgentInspectionRecordKindV1;
  const actor = value.actor as AgentInspectionRecordActorV1;
  const recipient = value.recipient === null || value.recipient === undefined
    ? null
    : value.recipient as AgentInspectionRecordActorV1;
  return {
    version: 1,
    id: value.id as string,
    kind,
    actor,
    recipient,
    correlation: inspectionCorrelation(row, value.correlation),
    occurredAt: value.occurredAt,
    durationMs: value.durationMs as number | null,
    late: value.late,
    content: content as string | null,
    arguments: argumentsText as string | null,
    result: result as string | null,
    provider: provider === null ? null : {
      adapter: provider.adapter as string,
      providerId: provider.providerId as string | null,
      modelId: provider.modelId as string | null,
      connectionId: provider.connectionId === null || provider.connectionId === undefined
        ? null
        : boundedInspectionString(provider.connectionId, 256),
      configRevision: provider.configRevision === null || provider.configRevision === undefined
        ? null
        : normalizeCortexRevision(provider.configRevision),
      connectionRevision: provider.connectionRevision === null || provider.connectionRevision === undefined
        ? null
        : normalizeCortexRevision(provider.connectionRevision),
      fingerprint: provider.fingerprint === null || provider.fingerprint === undefined
        ? null
        : boundedInspectionString(provider.fingerprint, 256),
    },
    errorReason: value.errorReason === null || value.errorReason === undefined
      ? null
      : value.errorReason as AgentInspectionReasonV1,
  };
}

function normalizeInspectionTurnSession(
  row: InspectionAttemptRow,
  value: InspectionObject,
): AgentTurnSessionEntryV1 | null {
  const ids = value.transcriptRecordIds;
  if (
    value.version !== 1
    || !boundedInspectionString(value.id)
    || typeof value.kind !== "string"
    || !TURN_SESSION_KINDS.has(value.kind)
    || !hasInspectionCorrelation(row, value.correlation)
    || !isSafeInspectionInteger(value.occurredAt)
    || typeof value.detail !== "string"
    || inspectionEncoder.encode(value.detail).byteLength > 2048
    || !Array.isArray(ids)
    || ids.length > 256
    || ids.some((item) => boundedInspectionString(item) === null)
  ) return null;
  return {
    version: 1,
    id: value.id as string,
    kind: value.kind as AgentTurnSessionEntryV1["kind"],
    correlation: inspectionCorrelation(row, value.correlation),
    occurredAt: value.occurredAt,
    detail: value.detail as string,
    transcriptRecordIds: ids.map((item) => boundedInspectionString(item) as string),
  };
}

const LOOM_BUCKET_VALUES: ReadonlySet<string> = new Set([
  "workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy",
]);
const LOOM_DESTINATION_VALUES: ReadonlySet<string> = new Set([
  "root_work", "completion_handoff", "render",
]);
const LOOM_CHECKPOINT_VALUES: ReadonlySet<string> = new Set([
  "ASSEMBLE", "WORK", "PREPARE_COMMIT", "RENDER",
]);
const LOOM_SURFACE_VALUES: ReadonlySet<string> = new Set(["WORK", "RESPONSE"]);
const LOOM_PREDICATE_PHASES: ReadonlySet<string> = new Set([
  "ASSEMBLE", "WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING",
  "COMMITTED", "COMMIT_FAILED", "EXHAUSTED", "FAILED", "CANCELLED", "TIMED_OUT",
]);
const LOOM_PREDICATE_TRANSITIONS: ReadonlySet<string> = new Set([
  "pending", "active", "blocked", "completed", "cancelled", "failed",
]);
const LOOM_OUTCOME_STATUSES: ReadonlySet<string> = new Set([
  "included", "skipped", "rejected", "omitted", "deduplicated",
]);

function normalizeCognitionScalar(value: unknown): CognitionScalar | null {
  if (typeof value === "string") return boundedInspectionString(value, 4096);
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function normalizeCognitionValue(value: unknown): CognitionValue | null {
  const scalar = normalizeCognitionScalar(value);
  if (scalar !== null) return scalar;
  if (!Array.isArray(value) || value.length > 256) return null;
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || inspectionEncoder.encode(item).byteLength > 4096) return null;
    strings.push(item);
  }
  return strings;
}

function normalizeLoomPredicate(value: unknown, depth = 0): CognitionPredicateV1 | null {
  if (depth > 16 || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = inspectionObject(value);
  if (typeof source.kind !== "string") return null;
  if (source.kind === "all" || source.kind === "any") {
    if (!Array.isArray(source.children) || source.children.length > 256) return null;
    const children: CognitionPredicateV1[] = [];
    for (const child of source.children) {
      const normalized = normalizeLoomPredicate(child, depth + 1);
      if (normalized === null) return null;
      children.push(normalized);
    }
    return source.kind === "all"
      ? { kind: "all", children }
      : { kind: "any", children };
  }
  if (source.kind === "not") {
    const child = normalizeLoomPredicate(source.child, depth + 1);
    return child === null ? null : { kind: "not", child };
  }
  if (source.kind === "generation_type") {
    return typeof source.value === "string"
      && ["normal", "continue", "regenerate", "swipe"].includes(source.value)
      ? { kind: "generation_type", value: source.value as CognitionGenerationType }
      : null;
  }
  if (source.kind === "phase") {
    return typeof source.value === "string" && LOOM_PREDICATE_PHASES.has(source.value)
      ? { kind: "phase", value: source.value as CognitionPhase }
      : null;
  }
  if (source.kind === "tool_available") {
    return boundedInspectionString(source.toolId, 128) !== null && typeof source.available === "boolean"
      ? { kind: "tool_available", toolId: source.toolId as string, available: source.available }
      : null;
  }
  if (source.kind === "task_transition") {
    return boundedInspectionString(source.taskId) !== null
      && typeof source.transition === "string"
      && LOOM_PREDICATE_TRANSITIONS.has(source.transition)
      ? {
        kind: "task_transition",
        taskId: source.taskId as string,
        transition: source.transition as "pending" | "active" | "blocked" | "completed" | "cancelled" | "failed",
      }
      : null;
  }
  if (source.kind !== "preset_variable" && source.kind !== "participant_fact") return null;
  const name = boundedInspectionString(source.name, 256);
  if (name === null || typeof source.operator !== "string") return null;
  const predicateKind = source.kind;
  if (source.operator === "equals") {
    const predicateValue = normalizeCognitionValue(source.value);
    return predicateValue === null
      ? null
      : { kind: predicateKind, name, operator: "equals", value: predicateValue };
  }
  if (source.operator === "in") {
    if (!Array.isArray(source.values) || source.values.length > 256) return null;
    const values: CognitionScalar[] = [];
    for (const item of source.values) {
      const scalar = normalizeCognitionScalar(item);
      if (scalar === null) return null;
      values.push(scalar);
    }
    return { kind: predicateKind, name, operator: "in", values };
  }
  if (source.operator === "includes") {
    const scalar = normalizeCognitionScalar(source.value);
    return scalar === null
      ? null
      : { kind: predicateKind, name, operator: "includes", value: scalar };
  }
  return source.operator === "present"
    ? { kind: predicateKind, name, operator: "present" }
    : null;
}

function normalizeLoomSource(value: unknown): LoomPolicySourceV1 | null {
  const source = inspectionObject(value);
  if (
    source.kind !== "loom_block"
    || boundedInspectionString(source.blockId) === null
    || !isSafeInspectionInteger(source.presetRevision)
    || !isSafeInspectionInteger(source.blockRevision)
    || !isSafeInspectionInteger(source.promptOrder)
  ) return null;
  return {
    kind: "loom_block",
    blockId: source.blockId as string,
    presetRevision: source.presetRevision,
    blockRevision: source.blockRevision,
    promptOrder: source.promptOrder,
  };
}


function normalizeLoomOutcome(value: unknown): LoomPromptInspectionOutcomeV1 | null {
  const source = inspectionObject(value);
  if (typeof source.status !== "string" || !LOOM_OUTCOME_STATUSES.has(source.status)) return null;
  if (source.status === "included") {
    return isSafeInspectionInteger(source.effectiveIndex) && source.reason === "selected"
      ? { status: "included", effectiveIndex: source.effectiveIndex, reason: "selected" }
      : null;
  }
  if (source.status === "skipped") {
    return typeof source.reason === "string"
      && ["checkpoint_not_reached", "condition_not_met", "stale_source"].includes(source.reason)
      ? { status: "skipped", reason: source.reason as "checkpoint_not_reached" | "condition_not_met" | "stale_source" }
      : null;
  }
  if (source.status === "rejected") {
    return typeof source.reason === "string"
      && ["invalid_source", "stale_source", "required_source_unavailable"].includes(source.reason)
      ? { status: "rejected", reason: source.reason as "invalid_source" | "stale_source" | "required_source_unavailable" }
      : null;
  }
  if (source.status === "omitted") {
    return typeof source.reason === "string"
      && ["response_mode", "destination_unavailable", "not_work_surface"].includes(source.reason)
      ? { status: "omitted", reason: source.reason as "response_mode" | "destination_unavailable" | "not_work_surface" }
      : null;
  }
  return boundedInspectionString(source.keptEntryId) !== null
    && source.reason === "destination_overlap"
    && typeof source.destination === "string"
    && LOOM_DESTINATION_VALUES.has(source.destination)
    ? {
      status: "deduplicated",
      reason: "destination_overlap",
      keptEntryId: source.keptEntryId as string,
      destination: source.destination as LoomPolicyDestinationV1,
    }
    : null;
}

function normalizeLoomItem(value: unknown): LoomPromptInspectionItemV1 | null {
  const source = inspectionObject(value);
  const normalizedSource = normalizeLoomSource(source.source);
  const condition = source.condition === undefined
    ? undefined
    : normalizeLoomPredicate(source.condition);
  const outcome = normalizeLoomOutcome(source.outcome);
  const required = source.required === undefined ? false : source.required;
  const conditionResult = source.conditionResult;
  const ordinaryPromptSuppressed = source.ordinaryPromptSuppressed === undefined
    ? true
    : source.ordinaryPromptSuppressed;
  if (
    boundedInspectionString(source.entryId) === null
    || typeof source.bucket !== "string"
    || !LOOM_BUCKET_VALUES.has(source.bucket)
    || typeof source.destination !== "string"
    || !LOOM_DESTINATION_VALUES.has(source.destination)
    || typeof source.checkpoint !== "string"
    || !LOOM_CHECKPOINT_VALUES.has(source.checkpoint)
    || normalizedSource === null
    || (source.condition !== undefined && condition === null)
    || !(source.effectiveText === null
      || (typeof source.effectiveText === "string"
        && inspectionEncoder.encode(source.effectiveText).byteLength <= AGENT_RUN_INSPECTION_MAX_PAYLOAD_BYTES))
    || typeof required !== "boolean"
    || (conditionResult !== undefined
      && (typeof conditionResult !== "string"
        || !["true", "false", "not_evaluated", "invalid", "not_applicable"].includes(conditionResult)))
    || typeof ordinaryPromptSuppressed !== "boolean"
    || outcome === null
  ) return null;
  return {
    entryId: source.entryId as string,
    bucket: source.bucket as LoomPolicyBucketV1,
    destination: source.destination as LoomPolicyDestinationV1,
    checkpoint: source.checkpoint as LoomPolicyCheckpointV1,
    source: normalizedSource,
    ...(condition == null ? {} : { condition }),
    effectiveText: source.effectiveText as string | null,
    required,
    ...(conditionResult === undefined
      ? {}
      : { conditionResult: conditionResult as LoomPromptInspectionItemV1["conditionResult"] }),
    ordinaryPromptSuppressed,
    outcome,
  };
}

function normalizeLoomResponseOmission(value: unknown): LoomResponsePolicyOmissionV1 | null {
  const source = inspectionObject(value);
  const maxPhaseInstructions =
    AGENT_RUNTIME_MAX_CUSTOM_PHASES * AGENT_RUNTIME_MAX_PHASE_INSTRUCTION_REFS;
  const reviewReason = source.reviewReason == null ? undefined : boundedInspectionString(source.reviewReason);
  if (reviewReason === null) return null;
  if (
    source.version !== 1
    || source.surface !== "RESPONSE"
    || source.visibility !== "work_only"
    || source.reason !== "work_only"
    || !Array.isArray(source.omittedEntryIds)
    || source.omittedEntryIds.length > 256
    || source.omittedEntryIds.some((item) => boundedInspectionString(item) === null)
    || !Array.isArray(source.source)
    || source.source.length > 256
    || !Array.isArray(source.omittedPhaseInstructions)
    || source.omittedPhaseInstructions.length > maxPhaseInstructions
  ) return null;
  const normalizedSource: LoomPolicySourceV1[] = [];
  for (const item of source.source) {
    const normalized = normalizeLoomSource(item);
    if (normalized === null) return null;
    normalizedSource.push(normalized);
  }
  const omittedPhaseInstructions: LoomResponsePolicyPhaseInstructionV1[] = [];
  for (const item of source.omittedPhaseInstructions) {
    const phaseInstruction = inspectionObject(item);
    const phaseId = boundedInspectionString(phaseInstruction.phaseId);
    const profileId = phaseInstruction.profileId == null ? undefined : boundedInspectionString(phaseInstruction.profileId);
    const normalized = normalizeLoomSource(phaseInstruction.source);
    if (phaseId === null || normalized === null || profileId === null) return null;
    omittedPhaseInstructions.push({ phaseId, source: normalized, ...(profileId === undefined ? {} : { profileId }) });
  }
  return { version: 1,
    surface: "RESPONSE",
    visibility: "work_only",
    reason: "work_only",
    ...(reviewReason === undefined ? {} : { reviewReason }),
    omittedEntryIds: source.omittedEntryIds.map((item) => boundedInspectionString(item) as string),
    source: normalizedSource,
    omittedPhaseInstructions,
  };
}

function normalizeLoomInspection(value: unknown): LoomPromptInspectionV1 | null {
  const source = inspectionObject(value);
  if (
    source.version !== 1
    || typeof source.surface !== "string"
    || !LOOM_SURFACE_VALUES.has(source.surface)
    || typeof source.checkpoint !== "string"
    || !LOOM_CHECKPOINT_VALUES.has(source.checkpoint)
    || !Array.isArray(source.items)
    || source.items.length > 256
    || !Array.isArray(source.effectiveEntryIds)
    || source.effectiveEntryIds.length > 256
    || source.effectiveEntryIds.some((item) => boundedInspectionString(item) === null)
  ) return null;
  const items: LoomPromptInspectionItemV1[] = [];
  for (const item of source.items) {
    const normalized = normalizeLoomItem(item);
    if (normalized === null) return null;
    items.push(normalized);
  }
  const responseOmission = source.responseOmission === undefined || source.responseOmission === null
    ? undefined
    : normalizeLoomResponseOmission(source.responseOmission);
  if (source.responseOmission !== undefined && source.responseOmission !== null && responseOmission === null) return null;
  return {
    version: 1,
    surface: source.surface as "WORK" | "RESPONSE",
    checkpoint: source.checkpoint as LoomPolicyCheckpointV1,
    items,
    effectiveEntryIds: source.effectiveEntryIds.map((item) => boundedInspectionString(item) as string),
    ...(responseOmission === undefined || responseOmission === null ? {} : { responseOmission }),
  };
}

function normalizePromptRevision(value: unknown): string | number | null {
  if (isSafeInspectionInteger(value)) return value;
  return typeof value === "string" ? boundedInspectionString(value, 256) : null;
}

function normalizeSha256(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value) && boundedInspectionString(value, 64) !== null
    ? value
    : null;
}

function normalizePromptDatabankSource(value: unknown): AgentPromptDatabankSourceV1 | null {
  const source = inspectionObject(value);
  const kind = source.kind === "automatic" || source.kind === "mention" ? source.kind : null;
  const databankId = boundedInspectionString(source.databankId);
  const documentId = boundedInspectionString(source.documentId);
  const documentName = boundedInspectionString(source.documentName, 1024);
  const chunkId = source.chunkId === null ? null : boundedInspectionString(source.chunkId);
  const documentContentHash = source.documentContentHash === null ? null : normalizeSha256(source.documentContentHash);
  const contentHash = normalizeSha256(source.contentHash);
  if (!kind || !databankId || !documentId || !documentName
    || (source.chunkId !== null && !chunkId)
    || (source.documentContentHash !== null && !documentContentHash)
    || !contentHash) return null;
  return { kind, databankId, documentId, documentName, chunkId, documentContentHash, contentHash };
}

function normalizePromptNativeProvenance(value: unknown): AgentPromptNativeProvenanceV1 | null {
  if (value === undefined || value === null) return null;
  const source = inspectionObject(value);
  if (source.kind === "world_info") {
    const sourceId = boundedInspectionString(source.sourceId);
    const sourceRevision = normalizePromptRevision(source.sourceRevision);
    if (!sourceId || sourceRevision === null || !isSafeInspectionInteger(source.sourceIndex)) return null;
    return { kind: "world_info", sourceId, sourceRevision, sourceIndex: source.sourceIndex };
  }
  if (source.kind === "databank") {
    const sourceRevision = boundedInspectionString(source.sourceRevision, 256);
    if (!sourceRevision || !Array.isArray(source.sources) || source.sources.length > 256) return null;
    const sources: AgentPromptDatabankSourceV1[] = [];
    for (const item of source.sources) {
      const normalized = normalizePromptDatabankSource(item);
      if (!normalized) return null;
      sources.push(normalized);
    }
    return { kind: "databank", sourceRevision, sources };
  }
  return null;
}

function normalizeRenderCrossing(row: InspectionAttemptRow, value: unknown, fallbackCorrelation?: unknown): AgentRenderCrossingV1 | null {
  const source = inspectionObject(value);
  const kind = source.kind === "accepted_finding" || source.kind === "accepted_submission" || source.kind === "completion_guidance"
    ? source.kind
    : null;
  const sourceRevision = source.sourceRevision === null ? null : isSafeInspectionInteger(source.sourceRevision) ? source.sourceRevision : undefined;
  const content = source.content === null ? null : typeof source.content === "string" && inspectionEncoder.encode(source.content).byteLength <= AGENT_RUN_INSPECTION_MAX_PAYLOAD_BYTES
    ? source.content
    : undefined;
  const contentDigest = normalizeSha256(source.contentDigest);
  const correlation = hasInspectionCorrelation(row, source.correlation) ? source.correlation : fallbackCorrelation;
  if (source.version !== 1 || !boundedInspectionString(source.id) || !kind || !boundedInspectionString(source.sourceId)
    || sourceRevision === undefined || content === undefined || !contentDigest || !hasInspectionCorrelation(row, correlation)) return null;
  return {
    version: 1,
    id: source.id as string,
    kind,
    sourceId: source.sourceId as string,
    sourceRevision,
    contentDigest,
    content,
    correlation: inspectionCorrelation(row, correlation),
  };
}

interface NormalizedInspectionPrompt extends AgentPromptEvidenceV1 {
  readonly renderCrossing?: AgentRenderCrossingV1;
}

function normalizeInspectionPrompt(
  row: InspectionAttemptRow,
  value: InspectionObject,
): NormalizedInspectionPrompt | null {
  const loomInspection = value.loomInspection === undefined || value.loomInspection === null
    ? null
    : normalizeLoomInspection(value.loomInspection);
  const nativeProvenance = value.nativeProvenance === undefined || value.nativeProvenance === null
    ? null
    : normalizePromptNativeProvenance(value.nativeProvenance);
  const renderCrossing = value.renderCrossing === undefined || value.renderCrossing === null
    ? undefined
    : normalizeRenderCrossing(row, value.renderCrossing, value.correlation) ?? undefined;
  const sourceRevision = normalizePromptRevision(value.sourceRevision);
  if (
    value.version !== 1
    || !boundedInspectionString(value.id)
    || !boundedInspectionString(value.sourceId)
    || sourceRevision === null
    || !isSafeInspectionInteger(value.promptOrder)
    || typeof value.destination !== "string"
    || !PROMPT_DESTINATIONS.has(value.destination)
    || typeof value.role !== "string"
    || !PROMPT_ROLES.has(value.role)
    || !hasInspectionCorrelation(row, value.correlation)
    || typeof value.included !== "boolean"
    || typeof value.content !== "string"
    || inspectionEncoder.encode(value.content).byteLength > AGENT_RUN_INSPECTION_MAX_PAYLOAD_BYTES
    || !boundedInspectionString(value.contentDigest, 256)
    || !(value.omissionReason === null
      || (typeof value.omissionReason === "string"
        && inspectionEncoder.encode(value.omissionReason).byteLength <= 2048))
    || (value.nativeProvenance !== undefined && value.nativeProvenance !== null && nativeProvenance === null)
    || (value.loomInspection !== undefined && value.loomInspection !== null && loomInspection === null)
    || (value.renderCrossing !== undefined && value.renderCrossing !== null && renderCrossing === undefined)
  ) return null;
  return {
    version: 1,
    id: value.id as string,
    sourceId: value.sourceId as string,
    sourceRevision,
    promptOrder: value.promptOrder,
    destination: value.destination as AgentPromptEvidenceV1["destination"],
    role: value.role as AgentPromptEvidenceV1["role"],
    correlation: inspectionCorrelation(row, value.correlation),
    included: value.included,
    content: value.content as string,
    contentDigest: value.contentDigest as string,
    omissionReason: value.omissionReason as string | null,
    nativeProvenance,
    loomInspection,
    ...(renderCrossing === undefined ? {} : { renderCrossing }),
  };
}

function normalizeInspectionWorkspace(
  row: InspectionAttemptRow,
  value: InspectionObject,
): AgentWorkspaceAssociationV1 | null {
  const sourceDeleted = value.sourceDeleted;
  if (typeof sourceDeleted !== "boolean") return null;
  if (
    value.version !== 1
    || !boundedInspectionString(value.id)
    || !boundedInspectionString(value.workspaceId, MAX_WORKSPACE_ID_BYTES)
    || !isSafeInspectionInteger(value.workspaceRevision)
    || typeof value.relation !== "string"
    || !WORKSPACE_RELATIONS.has(value.relation)
    || typeof value.objectKind !== "string"
    || !WORKSPACE_OBJECT_KINDS.has(value.objectKind)
    || !(value.objectId === null || boundedInspectionString(value.objectId) !== null)
    || !(value.sourceRevision === null || isSafeInspectionInteger(value.sourceRevision))
    || !(
      value.provenanceDigest === null
      || (
        typeof value.provenanceDigest === "string"
        && value.provenanceDigest.length === 64
        && boundedInspectionString(value.provenanceDigest, 64) !== null
      )
    )
    || !hasInspectionCorrelation(row, value.correlation)
  ) return null;
  return {
    version: 1,
    id: value.id as string,
    workspaceId: value.workspaceId as string,
    workspaceRevision: value.workspaceRevision,
    relation: value.relation as AgentWorkspaceAssociationV1["relation"],
    objectKind: value.objectKind as AgentWorkspaceAssociationV1["objectKind"],
    objectId: value.objectId as string | null,
    sourceRevision: value.sourceRevision as number | null,
    sourceDeleted,
    provenanceDigest: value.provenanceDigest as string | null,
    correlation: inspectionCorrelation(row, value.correlation),
  };
}

function normalizeInspectionActivity(
  row: InspectionAttemptRow,
  value: InspectionObject,
): AgentActivityMilestoneV1 | null {
  const usage = value.usage === null || value.usage === undefined
    ? null
    : normalizeInspectionUsage(row, inspectionObject(value.usage));
  if (
    value.version !== 1
    || !boundedInspectionString(value.id)
    || !(value.parentId === null || boundedInspectionString(value.parentId) !== null)
    || typeof value.kind !== "string"
    || !ACTIVITY_KINDS.has(value.kind)
    || typeof value.actor !== "string"
    || !ACTIVITY_ACTORS.has(value.actor)
    || typeof value.phase !== "string"
    || !INSPECTION_PHASES.has(value.phase)
    || typeof value.status !== "string"
    || !(value.status === "omitted" || INSPECTION_STATUSES.has(value.status))
    || typeof value.label !== "string"
    || inspectionEncoder.encode(value.label).byteLength > 256
    || !(value.toolId === null || boundedInspectionString(value.toolId, 128) !== null)
    || !(value.taskId === null || boundedInspectionString(value.taskId) !== null)
    || !isSafeInspectionInteger(value.sequence)
    || !isSafeInspectionInteger(value.startedAt)
    || !(value.endedAt === null || isSafeInspectionInteger(value.endedAt))
    || !(value.elapsedMs === null || isSafeInspectionInteger(value.elapsedMs))
    || (value.usage !== null && value.usage !== undefined && usage === null)
    || !hasInspectionCorrelation(row, value.correlation)
  ) return null;
  return {
    version: 1,
    id: value.id as string,
    parentId: value.parentId as string | null,
    kind: value.kind as AgentActivityMilestoneV1["kind"],
    actor: value.actor as AgentActivityMilestoneV1["actor"],
    phase: value.phase as AgentInspectionLifecycleV1,
    status: value.status as AgentActivityMilestoneV1["status"],
    label: value.label as string,
    toolId: value.toolId as string | null,
    taskId: value.taskId as string | null,
    sequence: value.sequence,
    startedAt: value.startedAt,
    endedAt: value.endedAt as number | null,
    elapsedMs: value.elapsedMs as number | null,
    usage,
    correlation: inspectionCorrelation(row, value.correlation),
  };
}

interface ActivityProjectionResult {
  readonly records: readonly AgentActivityMilestoneV1[];
  readonly unavailableMarkers: readonly AgentInspectionMarkerV1[];
  readonly invalidCount: number;
}

function projectAgentRunActivity(
  db: Database,
  row: InspectionAttemptRow,
): ActivityProjectionResult {
  const projection = db.query(
    `SELECT snapshot_json
       FROM agent_run_projections
      WHERE user_id = ? AND chat_id = ? AND turn_id = ?
      LIMIT 1`,
  ).get(row.user_id, row.chat_id, row.turn_id) as { snapshot_json: string } | null;
  if (!projection) return { records: [], unavailableMarkers: [], invalidCount: 0 };
  const unavailableMarkers: AgentInspectionMarkerV1[] = [];
  let invalidCount = 0;
  const markUnavailable = (id: string, detail: string): void => {
    invalidCount += 1;
    unavailableMarkers.push(unavailableInspectionMarker(row, id, "activity", {}, detail));
  };
  let value: unknown;
  try {
    value = JSON.parse(projection.snapshot_json);
  } catch {
    markUnavailable(
      `${row.attempt_id}:activity:projection-corrupt`,
      "activity projection unavailable: malformed or corrupt snapshot.",
    );
    return { records: [], unavailableMarkers, invalidCount };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    markUnavailable(
      `${row.attempt_id}:activity:projection-invalid`,
      "activity projection unavailable: malformed or legacy snapshot.",
    );
    return { records: [], unavailableMarkers, invalidCount };
  }
  const source = value as InspectionObject;
  if (
    source.version !== 2
    || source.runId !== row.run_id
    || source.turnId !== row.turn_id
    || source.generationId !== row.generation_id
    || source.chatId !== row.chat_id
    || source.inspectionAttemptId !== row.attempt_id
    || !Array.isArray(source.activity)
  ) {
    markUnavailable(
      `${row.attempt_id}:activity:projection-mismatch`,
      "activity projection unavailable: identity or shape mismatch.",
    );
    return { records: [], unavailableMarkers, invalidCount };
  }
  const values = source.activity;
  const boundedValues = values.slice(0, MAX_NODES_PER_SNAPSHOT);
  if (values.length > boundedValues.length) {
    invalidCount += values.length - boundedValues.length;
    unavailableMarkers.push(unavailableInspectionMarker(
      row,
      `${row.attempt_id}:activity:projection-truncated`,
      "activity",
      {},
      "activity projection truncated: additional nodes omitted.",
    ));
  }
  const records: AgentActivityMilestoneV1[] = [];
  for (const [index, value] of boundedValues.entries()) {
    const node = inspectionObject(value);
    const id = boundedInspectionString(node.id, 224);
    const parentId = node.parentId === null ? null : boundedInspectionString(node.parentId, 224);
    const kind: "root" | "provider" | "child" | "tool" | null =
      typeof node.kind === "string" && ["root", "provider", "child", "tool"].includes(node.kind)
        ? node.kind as "root" | "provider" | "child" | "tool"
        : null;
    const phase = typeof node.phase === "string" && INSPECTION_PHASES.has(node.phase)
      ? node.phase as AgentInspectionLifecycleV1
      : null;
    const publicStatus = typeof node.status === "string"
      && ["pending", "running", "completed", "failed", "cancelled", "timed_out", "omitted"].includes(node.status)
      ? node.status
      : null;
    const startedAt = isSafeInspectionInteger(node.startedAt) ? node.startedAt : null;
    const elapsedMs = isSafeInspectionInteger(node.elapsedMs) ? node.elapsedMs : null;
    if (
      !id
      || (node.parentId !== null && !parentId)
      || !kind
      || !phase
      || !publicStatus
      || startedAt === null
      || elapsedMs === null
    ) {
      markUnavailable(
        `${row.attempt_id}:activity:projection-invalid:${index}`,
        "activity record unavailable: malformed or legacy node.",
      );
      continue;
    }
    const actor: AgentActivityMilestoneV1["actor"] = kind === "root" ? "agent" : kind;
    const toolId = node.toolId === undefined ? null : boundedInspectionString(node.toolId, 128);
    const profileId = node.profileId === undefined ? null : boundedInspectionString(node.profileId, 128);
    const taskId = node.taskId === undefined ? null : boundedInspectionString(node.taskId, 256);
    if ((node.taskId !== undefined && !taskId) || (node.toolId !== undefined && !toolId) || (node.profileId !== undefined && !profileId)) {
      markUnavailable(
        `${row.attempt_id}:activity:projection-invalid:${index}`,
        "activity record unavailable: malformed or legacy node identity.",
      );
      continue;
    }
    const status: AgentActivityMilestoneV1["status"] = publicStatus === "pending" || publicStatus === "running"
      ? publicStatus
      : publicStatus === "omitted"
        ? "omitted"
        : "terminal";
    const endedAt = status === "pending" || status === "running"
      ? null
      : startedAt <= Number.MAX_SAFE_INTEGER - elapsedMs
        ? startedAt + elapsedMs
        : Number.MAX_SAFE_INTEGER;
    const label = toolId ?? profileId ?? kind;
    const hostSequence = index + 1;
    records.push({
      version: 1,
      id: `projection:${id}`,
      parentId: parentId ? `projection:${parentId}` : null,
      kind,
      actor,
      phase,
      status,
      label,
      toolId,
      taskId,
      sequence: hostSequence,
      startedAt,
      endedAt,
      elapsedMs,
      usage: null,
      correlation: inspectionCorrelation(row, {
        actorId: actor,
        phase,
        toolId,
        taskId,
        parentId: parentId ? `projection:${parentId}` : null,
        hostSequence,
      }, hostSequence),
    });
  }
  return { records, unavailableMarkers, invalidCount };
}


function normalizeInspectionStop(
  row: InspectionAttemptRow,
  value: InspectionObject,
): AgentRunInspectionStopV1 | null {
  if (
    value.version !== 1
    || !["accepted", "too_late", "terminal", "failed", "reconciled"].includes(String(value.state))
    || !isSafeInspectionInteger(value.requestedAt)
    || !(value.receiptAt === null || isSafeInspectionInteger(value.receiptAt))
    || !hasInspectionCorrelation(row, value.correlation)
    || !isInspectionReason(value.reason)
  ) return null;
  return {
    version: 1,
    state: value.state as AgentRunInspectionStopV1["state"],
    requestedAt: value.requestedAt,
    receiptAt: value.receiptAt as number | null,
    correlation: inspectionCorrelation(row, value.correlation),
    reason: value.reason as AgentInspectionReasonV1,
  };
}

interface InspectionRecordProjection<T> {
  readonly records: readonly T[];
  readonly unavailableMarkers: readonly AgentInspectionMarkerV1[];
  readonly invalidCount: number;
}

interface InspectionProjectionBudget {
  remaining: number;
}

function projectInspectionRecords<T>(
  db: Database,
  row: InspectionAttemptRow,
  kind: InspectionRecordKind,
  scope: AgentInspectionMarkerV1["scope"],
  parser: (row: InspectionAttemptRow, value: InspectionObject) => T | null,
  budget: InspectionProjectionBudget,
): InspectionRecordProjection<T> {
  const audit = auditRows(db, row, kind, budget.remaining);
  budget.remaining = Math.max(0, budget.remaining - audit.selectedCount);
  const records: T[] = [];
  const unavailableMarkers: AgentInspectionMarkerV1[] = [...audit.unavailableMarkers];
  let invalidCount = audit.invalidCount;
  for (const [index, value] of audit.records.entries()) {
    const record = parser(row, value);
    if (record !== null) {
      records.push(record);
      continue;
    }
    unavailableMarkers.push(unavailableInspectionMarker(
      row,
      `${row.attempt_id}:${scope}:unavailable:${index}`,
      scope,
      value,
      `${scope} record unavailable: malformed or legacy payload.`,
    ));
    invalidCount += 1;
  }
  return { records, unavailableMarkers, invalidCount };
}

function usageProjection(
  row: InspectionAttemptRow,
  evidence: readonly AgentInspectionUsageV1[],
  omittedEvidenceCount: number,
): AgentInspectionUsageProjectionV1 {
  const layers: AgentInspectionUsageLayerV1[] = [];
  const sourceRank = (source: AgentInspectionUsageV1["source"]): number =>
    source === "final" ? 3 : source === "provider_reported" ? 2 : 1;
  for (const layer of USAGE_LAYERS) {
    const candidates = evidence.filter((item) =>
      item.source !== "recovered_duplicate" && (item.layer ?? "root") === layer);
    const selected = candidates.reduce<AgentInspectionUsageV1 | null>((best, item) => {
      if (!best) return item;
      return sourceRank(item.source) > sourceRank(best.source) ? item : best;
    }, null);
    layers.push({
      version: 1,
      layer,
      source: selected?.source ?? "provisional",
      correlation: selected?.correlation ?? null,
      inputTokens: selected?.inputTokens ?? 0,
      outputTokens: selected?.outputTokens ?? 0,
      totalTokens: selected?.totalTokens ?? 0,
      toolCalls: selected?.toolCalls ?? 0,
      childInvocations: selected?.childInvocations ?? 0,
      evidenceIds: candidates.map((item) => item.id),
      canonical: selected?.canonical ?? false,
    });
  }
  const totals = layers.reduce(
    (sum, layer) => ({
      inputTokens: Math.min(MAX_COUNTER, sum.inputTokens + layer.inputTokens),
      outputTokens: Math.min(MAX_COUNTER, sum.outputTokens + layer.outputTokens),
      totalTokens: Math.min(MAX_COUNTER, sum.totalTokens + layer.totalTokens),
      toolCalls: Math.min(MAX_COUNTER, sum.toolCalls + layer.toolCalls),
      childInvocations: Math.min(MAX_COUNTER, sum.childInvocations + layer.childInvocations),
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0, childInvocations: 0 },
  );
  return {
    version: 1,
    inspectionAttemptId: row.attempt_id,
    totals,
    layers,
    evidenceCount: evidence.length,
    omittedEvidenceCount,
  };
}

function normalizeInspectionAuthority(value: unknown): AgentInspectionAuthorityV1 {
  return typeof value === "string" && INSPECTION_AUTHORITIES.has(value)
    ? value as AgentInspectionAuthorityV1
    : "host";
}

function normalizeInspectionSource(value: unknown): AgentInspectionSourceV1 {
  return typeof value === "string" && INSPECTION_SOURCES.has(value)
    ? value as AgentInspectionSourceV1
    : "execution";
}

function normalizeInspectionScope(value: unknown): AgentInspectionScopeV1 {
  return typeof value === "string" && INSPECTION_SCOPES.has(value)
    ? value as AgentInspectionScopeV1
    : "run";
}

function normalizeInspectionCapGate(value: unknown): AgentInspectionCapGateV1 | null {
  if (value === null || value === undefined) return null;
  const source = inspectionObject(value);
  if (
    !boundedInspectionString(source.id)
    || !(source.limit === null || isSafeInspectionInteger(source.limit))
    || !(source.observed === null || isSafeInspectionInteger(source.observed))
    || typeof source.exceeded !== "boolean"
  ) return null;
  return {
    id: source.id as string,
    limit: source.limit as number | null,
    observed: source.observed as number | null,
    exceeded: source.exceeded,
    authority: normalizeInspectionAuthority(source.authority),
    source: normalizeInspectionSource(source.source),
  };
}
function publicInspectionErrorCode(value: unknown): AgentPublicErrorCode | null {
  return typeof value === "string" && ERROR_CODES.has(value as AgentPublicErrorCode)
    ? value as AgentPublicErrorCode
    : null;
}

function inspectionErrorCategory(code: AgentPublicErrorCode): AgentPublicErrorCategory {
  if (code.includes("limit") || code.includes("budget")) return "budget";
  if (code === "child_required_failed" || code === "agentic_protocol_failure") return "validation";
  if (code.startsWith("provider_") || code.startsWith("worker_")) return "provider";
  if (code.startsWith("invalid_") || code === "batch_rejected" || code === "unknown_tool") return "validation";
  if (code === "timeout" || code === "worker_timed_out") return "timeout";
  if (code === "cancelled") return "cancelled";
  if (code === "integrity_error") return "integrity";
  if (code === "internal_error") return "internal";
  return "internal";
}

function inspectionDefaultErrorCode(row: InspectionAttemptRow): AgentPublicErrorCode {
  if (row.outcome === "stopped") return "cancelled";
  if (row.outcome === "exhausted") return "limit_exceeded";
  if (row.outcome === "rejected") {
    return row.reason === "stale_input" ? "decision_refresh_required" : "invalid_input";
  }
  if (row.reason === "provider_failure") return "provider_request_error";
  if (row.reason === "required_work_failure") return "child_required_failed";
  if (row.reason === "budget_exhausted") return "limit_exceeded";
  if (row.reason === "tool_failure") return "internal_error";
  return "internal_error";
}

function normalizeInspectionError(
  db: Database,
  row: InspectionAttemptRow,
  markerCount: number,
): AgentInspectionErrorDetailV1 | null {
  const transcriptFailure = auditRows(db, row, "transcript").records.find((value) =>
    value.kind === "failure" || value.kind === "terminal");
  let receipt: InspectionObject = {};
  if (row.terminal_receipt_json) {
    try {
      receipt = inspectionObject(JSON.parse(row.terminal_receipt_json));
    } catch {
      receipt = {};
    }
  }
  const source = inspectionObject(receipt.error ?? receipt);
  const explicitCode = publicInspectionErrorCode(source.code);
  const hasError = transcriptFailure !== undefined
    || (row.outcome !== null && row.outcome !== "completed")
    || explicitCode !== null;
  if (!hasError) return null;
  const code = explicitCode ?? inspectionDefaultErrorCode(row);
  const explicitCausalCode = publicInspectionErrorCode(source.causalCode);
  const derivedCategory = inspectionErrorCategory(code);
  const category = typeof source.category === "string"
    && PUBLIC_ERROR_CATEGORIES.has(source.category)
    && source.category !== "internal"
    ? source.category as AgentPublicErrorCategory
    : derivedCategory;
  const summaryCode = typeof source.summaryCode === "string"
    && /^agentRun\.errors\.[A-Za-z0-9_.:-]{1,128}$/.test(source.summaryCode)
    ? source.summaryCode
    : `agentRun.errors.${code}`;
  const recoveryEligible = typeof source.recoveryEligible === "boolean"
    ? source.recoveryEligible
    : row.outcome === "failed" || row.outcome === "exhausted" || row.outcome === "stopped" || row.outcome === "rejected";
  const recoveryAction = typeof source.recoveryAction === "string" && RECOVERY_ACTIONS.has(source.recoveryAction)
    ? source.recoveryAction as AgentInspectionErrorDetailV1["recoveryAction"]
    : recoveryEligible ? "retry" : "none";
  const omissionCount = isSafeInspectionInteger(source.omissionCount) ? source.omissionCount : markerCount;
  return {
    version: 1,
    inspectionAttemptId: row.attempt_id,
    code,
    category,
    summaryCode,
    causalCode: explicitCausalCode,
    authority: normalizeInspectionAuthority(source.authority),
    source: normalizeInspectionSource(source.source),
    scope: normalizeInspectionScope(source.scope),
    capGate: normalizeInspectionCapGate(source.capGate),
    target: inspectionLineage(row).target,
    workPhase: normalizeInspectionPhase(row.lifecycle),
    workStatus: normalizeInspectionStatus(row.status),
    workOutcome: normalizeInspectionOutcome(row.outcome),
    reason: normalizeInspectionReason(row.reason),
    recoveryEligible,
    recoveryAction,
    omissionCount,
  };
}

const INSPECTION_SECTION_IDS: readonly AgentInspectionSectionIdV1[] = [
  "run", "activity", "transcript", "turn_session", "usage", "prompt", "cortex", "council", "workspace",
];

function sectionAvailability(
  sections: Pick<
    InspectionSections,
    | "markers"
    | "activity"
    | "transcript"
    | "turnSession"
    | "usageEvidence"
    | "promptEvidence"
    | "cortexReceipts"
    | "councilReceipts"
    | "workspaceAssociations"
  >,
): readonly AgentInspectionSectionAvailabilityV1[] {
  const counts: Record<AgentInspectionSectionIdV1, number> = {
    run: 1,
    activity: sections.activity.length,
    transcript: sections.transcript.length,
    turn_session: sections.turnSession.length,
    usage: sections.usageEvidence.length,
    prompt: sections.promptEvidence.length,
    cortex: sections.cortexReceipts.length,
    council: sections.councilReceipts.length,
    workspace: sections.workspaceAssociations.length,
  };
  return INSPECTION_SECTION_IDS.map((section) => {
    const scopedMarkers = sections.markers.filter((marker) => marker.scope === section);
    const withholdingMarker = scopedMarkers.find((marker) =>
      marker.kind === "credentials_withheld" || marker.kind === "other_user_data_withheld");
    if (withholdingMarker) {
      return {
        section,
        state: "withheld",
        reason: typeof withholdingMarker.detail === "string" && INSPECTION_REASONS.has(withholdingMarker.detail)
          ? withholdingMarker.detail as AgentInspectionReasonV1
          : null,
      };
    }
    const unavailableMarker = scopedMarkers.find((marker) =>
      marker.kind === "unavailable" || marker.kind === "truncated");
    if (unavailableMarker) {
      return {
        section,
        state: "unavailable",
        reason: typeof unavailableMarker.detail === "string" && INSPECTION_REASONS.has(unavailableMarker.detail)
          ? unavailableMarker.detail as AgentInspectionReasonV1
          : null,
      };
    }
    return {
      section,
      state: counts[section] > 0 ? "available" : "not_recorded",
      reason: null,
    };
  });
}

interface InspectionSections {
  readonly markers: readonly AgentInspectionMarkerV1[];
  readonly transcript: readonly AgentInspectionTranscriptRecordV1[];
  readonly turnSession: readonly AgentTurnSessionEntryV1[];
  readonly usageEvidence: readonly AgentInspectionUsageV1[];
  readonly usage: AgentInspectionUsageProjectionV1;
  readonly promptEvidence: readonly AgentPromptEvidenceV1[];
  readonly renderCrossings: readonly AgentRenderCrossingV1[];
  readonly cortexReceipts: readonly AgentCortexReceiptV1[];
  readonly councilReceipts: readonly AgentCouncilReceiptV1[];
  readonly workspaceAssociations: readonly AgentWorkspaceAssociationV1[];
  readonly activity: readonly AgentActivityMilestoneV1[];
  readonly sectionAvailability: readonly AgentInspectionSectionAvailabilityV1[];
  readonly stop: AgentRunInspectionStopV1 | null;
  readonly error: AgentInspectionErrorDetailV1 | null;
}

function promptOccurrenceKey(prompt: AgentPromptEvidenceV1): string {
  return JSON.stringify([prompt.sourceId, prompt.promptOrder, prompt.sourceRevision]);
}

function omitCollidingPromptOccurrences(
  row: InspectionAttemptRow,
  records: readonly NormalizedInspectionPrompt[],
): { records: readonly NormalizedInspectionPrompt[]; markers: readonly AgentInspectionMarkerV1[] } {
  const fingerprints = new Map<string, string>();
  const collisions = new Set<string>();
  for (const prompt of records) {
    const key = promptOccurrenceKey(prompt);
    const fingerprint = JSON.stringify([prompt.role, prompt.contentDigest, prompt.content]);
    const retained = fingerprints.get(key);
    if (retained === undefined) fingerprints.set(key, fingerprint);
    else if (retained !== fingerprint) collisions.add(key);
  }
  if (collisions.size === 0) return { records, markers: [] };
  return {
    records: records.filter((prompt) => !collisions.has(promptOccurrenceKey(prompt))),
    markers: [...collisions].map((_, index) => unavailableInspectionMarker(
      row,
      `${row.attempt_id}:prompt:occurrence-collision:${index}`,
      "prompt",
      {},
      "Prompt occurrence unavailable: conflicting retained evidence.",
    )),
  };
}

function projectInspectionSections(db: Database, row: InspectionAttemptRow): InspectionSections {
  const budget: InspectionProjectionBudget = {
    remaining: AGENT_RUN_INSPECTION_MAX_RECORDS,
  };
  const markerProjection = projectInspectionRecords(db, row, "marker", "run", parseInspectionMarker, budget);
  const transcriptProjection = projectInspectionRecords(db, row, "transcript", "transcript", normalizeInspectionTranscript, budget);
  const turnSessionProjection = projectInspectionRecords(db, row, "turn_session", "turn_session", normalizeInspectionTurnSession, budget);
  const usageRecordsProjection = projectInspectionRecords(db, row, "usage", "usage", normalizeInspectionUsage, budget);
  const promptProjection = projectInspectionRecords(db, row, "prompt", "prompt", normalizeInspectionPrompt, budget);
  const promptOccurrences = omitCollidingPromptOccurrences(row, promptProjection.records);
  const cortexProjection = projectInspectionRecords(db, row, "cortex", "cortex", normalizeCortexReceipt, budget);
  const councilProjection = projectInspectionRecords(db, row, "council", "council", normalizeCouncilReceipt, budget);
  const workspaceProjection = projectInspectionRecords(db, row, "workspace", "workspace", normalizeInspectionWorkspace, budget);
  const activityProjection = projectInspectionRecords(db, row, "activity", "activity", normalizeInspectionActivity, budget);
  const projectedActivity = projectAgentRunActivity(db, row);
  const activity = activityProjection.records.length > 0
    ? activityProjection.records
    : projectedActivity.records;
  const unavailableMarkers: AgentInspectionMarkerV1[] = [
    ...markerProjection.unavailableMarkers,
    ...transcriptProjection.unavailableMarkers,
    ...turnSessionProjection.unavailableMarkers,
    ...usageRecordsProjection.unavailableMarkers,
    ...promptProjection.unavailableMarkers,
    ...promptOccurrences.markers,
    ...cortexProjection.unavailableMarkers,
    ...councilProjection.unavailableMarkers,
    ...workspaceProjection.unavailableMarkers,
    ...activityProjection.unavailableMarkers,
    ...projectedActivity.unavailableMarkers,
  ];
  const validUsage = usageRecordsProjection.records;
  const duplicateUsageCount = validUsage.filter((item) => item.source === "recovered_duplicate").length;
  const stopAudit = auditRows(db, row, "stop", budget.remaining);
  budget.remaining = Math.max(0, budget.remaining - stopAudit.selectedCount);
  unavailableMarkers.push(...stopAudit.unavailableMarkers);
  const stopValues = stopAudit.records;
  let stop: AgentRunInspectionStopV1 | null = null;
  if (stopValues.length > 0) {
    stop = normalizeInspectionStop(row, stopValues[0]);
    if (!stop) {
      unavailableMarkers.push(unavailableInspectionMarker(
        row,
        `${row.attempt_id}:run:stop-unavailable`,
        "run",
        stopValues[0],
        "Stop receipt unavailable: malformed or legacy payload.",
      ));
    }
  }
  const markers = [
    ...markerProjection.records,
    ...unavailableMarkers,
  ];
  const sectionData = {
    markers,
    transcript: transcriptProjection.records,
    turnSession: turnSessionProjection.records,
    usageEvidence: validUsage,
    usage: usageProjection(row, validUsage, usageRecordsProjection.invalidCount + duplicateUsageCount),
    promptEvidence: promptOccurrences.records.map(({ renderCrossing: _renderCrossing, ...prompt }) => prompt),
    renderCrossings: promptOccurrences.records.flatMap(({ renderCrossing }) => renderCrossing === undefined ? [] : [renderCrossing]),
    cortexReceipts: cortexProjection.records,
    councilReceipts: councilProjection.records,
    workspaceAssociations: workspaceProjection.records,
    activity,
  };
  return {
    ...sectionData,
    sectionAvailability: sectionAvailability(sectionData),
    stop,
    error: normalizeInspectionError(db, row, markers.length),
  };
}

function summaryFromRow(db: Database, row: InspectionAttemptRow): AgentRunInspectionSummaryV1 {
  const sections = projectInspectionSections(db, row);
  const attempt = inspectionLineage(row);
  const activity: AgentActivityTreeV1 = {
    version: 1,
    attempt,
    lifecycle: normalizeInspectionPhase(row.lifecycle),
    status: normalizeInspectionStatus(row.status),
    outcome: normalizeInspectionOutcome(row.outcome),
    reason: normalizeInspectionReason(row.reason),
    revision: boundedInspectionInteger(row.version, 1),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
    target: inspectionTarget(row),
    milestones: sections.activity,
    usage: sections.usage.totals,
    markers: sections.markers,
    reconciliation: ["authoritative", "reconciling", "recovered", "stale"].includes(row.reconciliation_state)
      ? row.reconciliation_state as AgentActivityTreeV1["reconciliation"] : "authoritative",
  };
  return {
    version: 1,
    attempt,
    runId: row.run_id,
    turnSessionId: row.turn_id,
    generationId: row.generation_id,
    hostCorrelationId: row.host_correlation_id,
    lifecycle: normalizeInspectionPhase(row.lifecycle),
    status: normalizeInspectionStatus(row.status),
    outcome: normalizeInspectionOutcome(row.outcome),
    reason: normalizeInspectionReason(row.reason),
    target: inspectionTarget(row),
    committedTarget: inspectionCommittedTarget(row),
    revision: boundedInspectionInteger(row.version, 1),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
    activity,
    markerCount: sections.markers.length,
    transcriptCount: sections.transcript.length,
    terminal: row.terminal === 1,
  };
}

function inspectionWorkUsage(
  usage: Readonly<{
    providerDispatches: number;
    providerInputTokens: number;
    providerOutputTokens: number;
    providerTotalTokens: number;
    billedOutputTokens: number;
    toolCalls: number;
    workspaceOperations: number;
    unsignedBoundaries: number;
    receiveBytes: number;
    publishedOutputBytes: number;
  }>,
): AgentWorkSegmentInspectionProjectionV1["segments"][number]["usage"] {
  return Object.freeze({
    providerDispatches: usage.providerDispatches,
    providerInputTokens: usage.providerInputTokens,
    providerOutputTokens: usage.providerOutputTokens,
    providerTotalTokens: usage.providerTotalTokens,
    billedOutputTokens: usage.billedOutputTokens,
    toolCalls: usage.toolCalls,
    workspaceOperations: usage.workspaceOperations,
    unsignedBoundaries: usage.unsignedBoundaries,
    receiveBytes: usage.receiveBytes,
    publishedOutputBytes: usage.publishedOutputBytes,
  });
}

function workSegmentsFromInspectionRow(
  db: Database,
  row: InspectionAttemptRow,
): AgentWorkSegmentInspectionProjectionV1 | null {
  const hasRecoveryAuthorityTable = db.query(
    `SELECT 1 AS present
       FROM sqlite_schema
       WHERE type = 'table' AND name = 'agent_work_segment_recovery'`,
  ).get() as { present: number } | null;
  if (!hasRecoveryAuthorityTable) return null;

  const authority = db.query(
    `SELECT workspace_id
       FROM agent_work_segment_recovery
       WHERE user_id = ?
         AND execution_id = ?
         AND attempt_id = ?`,
  ).get(row.user_id, row.turn_id, row.attempt_id) as { workspace_id: string } | null;
  if (!authority?.workspace_id) return null;
  const chain = readWorkSegmentInspectionChainV1({
    db,
    userId: row.user_id,
    chatId: row.chat_id,
    executionId: row.turn_id,
    attemptId: row.attempt_id,
    workspaceId: authority.workspace_id,
  });
  if (!chain) return null;
  const segmentById = new Map(chain.segments.map((segment) => [segment.identity.segmentId, segment] as const));
  return Object.freeze({
    recovery: Object.freeze({
      state: chain.recovery.state,
      phaseId: chain.recovery.phaseId,
      phaseIndex: chain.recovery.phaseIndex,
      phaseOccurrence: chain.recovery.phaseOccurrence,
      nextSegmentOrdinal: chain.recovery.nextSegmentOrdinal,
      currentSegmentId: chain.recovery.currentSegmentId,
      workspaceRevision: chain.recovery.workspaceRevision,
      terminalCloseResult: chain.recovery.terminalCloseResult,
      terminalBoundaryClass: chain.recovery.terminalBoundaryClass,
      usage: Object.freeze({ ...inspectionWorkUsage(chain.recovery.usage), segments: chain.recovery.usage.segments }),
    }),
    segments: Object.freeze(chain.segments.map((segment) => Object.freeze({
      identity: Object.freeze({
        segmentId: segment.identity.segmentId,
        phaseId: segment.identity.phaseId,
        phaseIndex: segment.identity.phaseIndex,
        phaseOccurrence: segment.identity.phaseOccurrence,
        segmentOrdinal: segment.identity.segmentOrdinal,
      }),
      lifecycle: segment.lifecycle,
      workspaceRevision: segment.workspaceRevision,
      boundaryClass: segment.boundaryClass,
      closeResult: segment.closeResult,
      closedWorkspaceRevision: segment.closedWorkspaceRevision,
      usage: inspectionWorkUsage(segment.usage),
    }))),
    dispatches: Object.freeze(chain.dispatches.map((dispatch) => Object.freeze({
      dispatchId: dispatch.dispatchId,
      segmentId: dispatch.segmentId,
      dispatchOrdinal: dispatch.dispatchOrdinal,
      lifecycle: dispatch.lifecycle,
      toolMode: dispatch.toolMode,
      budgetClass: dispatch.budgetClass,
      workspaceRevision: dispatch.workspaceRevision,
      settledWorkspaceRevision: dispatch.settledWorkspaceRevision,
      boundaryClass: dispatch.boundaryClass,
      usage: dispatch.usage ? inspectionWorkUsage(dispatch.usage) : null,
    }))),
    transitions: Object.freeze(chain.transitions.map((transition) => {
      const handoff = transition.handoff;
      return Object.freeze({
        transitionId: transition.transitionId,
        handoffId: handoff.handoffId,
        transitionKind: handoff.transitionKind,
        sourceSegment: Object.freeze({
          segmentId: handoff.sourceSegment.segmentId,
          phaseId: handoff.sourceSegment.phaseId,
          phaseIndex: handoff.sourceSegment.phaseIndex,
          phaseOccurrence: handoff.sourceSegment.phaseOccurrence,
          segmentOrdinal: handoff.sourceSegment.segmentOrdinal,
        }),
        sourceWorkspaceRevision: handoff.sourceWorkspaceRevision,
        targetPhaseId: handoff.targetPhaseId,
        targetPhaseIndex: handoff.targetPhaseIndex,
        targetPhaseOccurrence: handoff.targetPhaseOccurrence,
        targetSegmentOrdinal: handoff.targetSegmentOrdinal,
        cause: segmentById.get(handoff.sourceSegment.segmentId)?.boundaryClass ?? null,
      });
    })),
  });
}

function detailFromRow(db: Database, row: InspectionAttemptRow): AgentRunInspectionDetailV1 {
  const summary = summaryFromRow(db, row);
  const sections = projectInspectionSections(db, row);
  return {
    ...summary,
    transcript: sections.transcript,
    turnSession: sections.turnSession,
    markers: sections.markers,
    usageEvidence: sections.usageEvidence,
    usage: sections.usage,
    error: sections.error,
    promptEvidence: sections.promptEvidence,
    renderCrossings: sections.renderCrossings,
    cortexReceipts: sections.cortexReceipts,
    councilReceipts: sections.councilReceipts,
    workspaceAssociations: sections.workspaceAssociations,
    stop: sections.stop,
    workSegments: workSegmentsFromInspectionRow(db, row),
    sectionAvailability: sections.sectionAvailability,
    retry: {
      allowed: false,
      reason: "unavailable",
      targetValid: inspectionTargetIsValid(db, row),
      linkedAttemptId: null,
    },
  };
}

export function persistAgentRunInspectionInTransaction(
  db: Database,
  input: PersistAgentRunInspectionInputV1,
): AgentRunInspectionDetailV1 | null {
  const userId = boundedInspectionString(input.userId);
  const chatId = boundedInspectionString(input.chatId);
  const attemptId = boundedInspectionString(input.attemptId);
  const runId = boundedInspectionString(input.runId);
  const turnSessionId = boundedInspectionString(input.turnSessionId);
  const generationId = boundedInspectionString(input.generationId);
  const hostCorrelationId = boundedInspectionString(input.hostCorrelationId);
  const previousAttemptId = input.previousAttemptId === undefined
    ? undefined
    : input.previousAttemptId === null ? null : boundedInspectionString(input.previousAttemptId);
  const targetMessageId = input.targetMessageId === undefined
    ? undefined
    : input.targetMessageId === null ? null : boundedInspectionString(input.targetMessageId);
  const targetSwipeId = input.targetSwipeId === undefined ? undefined : input.targetSwipeId;
  if (
    !userId || !chatId || !attemptId || !runId || !turnSessionId || !generationId || !hostCorrelationId
    || (input.previousAttemptId !== undefined && input.previousAttemptId !== null && previousAttemptId === null)
    || (input.targetMessageId !== undefined && input.targetMessageId !== null && targetMessageId === null)
  ) return null;
  if (!ownsChatForActivityInDb(db, userId, chatId)) return null;
  if (inspectionSourceDeletionExists(db, userId, attemptId)) return null;

  const lifecycle = normalizeInspectionPhase(input.lifecycle);
  const status = normalizeInspectionStatus(input.status);
  const generationType = normalizeInspectionGenerationType(input.generationType);
  if (
    typeof input.lifecycle !== "string" || lifecycle !== input.lifecycle
    || typeof input.status !== "string" || status !== input.status
    || generationType === null
  ) return null;
  const outcome = input.outcome == null ? null : normalizeInspectionOutcome(input.outcome);
  if (input.outcome != null && outcome === null) return null;
  if (
    targetSwipeId !== undefined
    && targetSwipeId !== null
    && (!Number.isSafeInteger(targetSwipeId) || targetSwipeId < 0)
  ) return null;
  const now = Date.now();
  const storedStatus = outcome ? "terminal" : status;
  const terminal = outcome !== null || storedStatus === "terminal";
  const storedLifecycle = terminal ? "TERMINAL" : lifecycle;
  if (
    (storedLifecycle === "TERMINAL" && outcome === null)
    || (storedLifecycle !== "TERMINAL" && outcome !== null)
  ) return null;
  const requestedUpdatedAt = boundedInspectionInteger(input.updatedAt, now);
  const terminalAt = terminal ? boundedInspectionInteger(input.terminalAt, now) : null;
  const reconciliation = normalizeInspectionReconciliation(input.reconciliation);
  const terminalReceiptJson = input.terminalReceipt == null
    ? null
    : boundedInspectionJson(input.terminalReceipt, 16384);
  const existing = loadInspectionAttempt(db, userId, attemptId);
  if (existing) {
    if (
      existing.chat_id !== chatId
      || existing.run_id !== runId
      || existing.turn_id !== turnSessionId
      || existing.generation_id !== generationId
      || existing.generation_type !== generationType
      || existing.host_correlation_id !== hostCorrelationId
      || !inspectionTargetMatches(existing, targetMessageId, targetSwipeId)
      || (input.previousAttemptId !== undefined && previousAttemptId !== existing.previous_attempt_id)
    ) return null;
    if (
      inspectionLifecycleTupleRegresses(
        storedLifecycle,
        storedStatus,
        existing.lifecycle,
        existing.status,
      )
      || requestedUpdatedAt < existing.updated_at
    ) return null;
    if (
      existing.terminal === 1
      && (
        existing.lifecycle !== lifecycle
        || existing.status !== status
        || existing.outcome !== outcome
      )
    ) return null;
  } else if (targetMessageId != null) {
    const target = db.query("SELECT 1 FROM messages WHERE chat_id = ? AND id = ?").get(chatId, targetMessageId);
    if (!target) return null;
  }

  if (!existing && previousAttemptId != null) {
    const previous = loadInspectionAttempt(db, userId, previousAttemptId);
    if (
      !previous
      || previous.chat_id !== chatId
      || previous.generation_type !== generationType
      || previous.target_message_id !== (targetMessageId ?? null)
      || previous.target_swipe_id !== (targetSwipeId ?? null)
    ) return null;
  }
  if (!existing) {
    db.query(
      `INSERT INTO agent_run_attempts
        (user_id, chat_id, attempt_id, previous_attempt_id, run_id, turn_id, generation_id,
         generation_type, target_message_id, target_swipe_id, lifecycle, status, outcome, reason,
         terminal, started_at, updated_at, terminal_at, host_correlation_id, reconciliation_state,
         terminal_receipt_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId, chatId, attemptId, previousAttemptId ?? null, runId,
      turnSessionId, generationId, generationType, targetMessageId ?? null,
      targetSwipeId ?? null, storedLifecycle, storedStatus,
      outcome, normalizeInspectionReason(input.reason), terminal ? 1 : 0,
      boundedInspectionInteger(input.startedAt, now), requestedUpdatedAt,
      terminalAt, hostCorrelationId, reconciliation, terminalReceiptJson,
    );
  } else if (!existing.terminal) {
    db.query(
      `UPDATE agent_run_attempts
        SET lifecycle = ?, status = ?, outcome = ?, reason = ?, terminal = ?,
            updated_at = ?, terminal_at = ?, reconciliation_state = ?,
            terminal_receipt_json = COALESCE(?, terminal_receipt_json)
       WHERE user_id = ? AND attempt_id = ? AND terminal = 0`,
    ).run(
      storedLifecycle, storedStatus, outcome,
      normalizeInspectionReason(input.reason), terminal ? 1 : 0,
      requestedUpdatedAt,
      terminalAt, reconciliation, terminalReceiptJson, userId, attemptId,
    );
  }
  const row = loadInspectionAttempt(db, userId, attemptId);
  if (!row) return null;
  persistInspectionRecords(db, row, input, existing?.terminal === 1);
  return detailFromRow(db, row);
}

export function persistAgentRunInspection(input: PersistAgentRunInspectionInputV1): AgentRunInspectionDetailV1 | null {
  try {
    const db = getDb();
    return db.transaction(() => persistAgentRunInspectionInTransaction(db, input))();
  } catch {
    return null;
  }
}
 
export function createAgentInspectionWriter(
  input: CreateAgentInspectionWriterInputV1,
): AgentInspectionWriterV1 {
  let lifecycle = input.lifecycle ?? "ADMIT";
  let status = input.status ?? "pending";
  let outcome = input.outcome ?? null;
  let reason = input.reason ?? "none";
  let reconciliation = input.reconciliation ?? "authoritative";
  let startedAt = boundedInspectionInteger(input.startedAt, Date.now());
  let updatedAt = startedAt;
  let terminalAt: number | null = null;
  let terminalReceipt: unknown = undefined;
  let sequence = 0;

  const record = (
    kind: AgentInspectionAuditKindV1,
    value: unknown = {},
    state: AgentInspectionBoundaryStateV1 = {},
  ): AgentRunInspectionDetailV1 | null => {
    if (state.lifecycle !== undefined) lifecycle = state.lifecycle;
    if (state.status !== undefined) status = state.status;
    if (state.outcome !== undefined) outcome = state.outcome;
    if (state.reason !== undefined) reason = state.reason;
    if (state.reconciliation !== undefined) reconciliation = state.reconciliation;
    if (state.terminalReceipt !== undefined) terminalReceipt = state.terminalReceipt;

    const source = inspectionObject(value);
    const requestedSequence = source.sequence ?? source.hostSequence;
    const sequenceCandidate = typeof requestedSequence === "number"
      && Number.isSafeInteger(requestedSequence)
      && requestedSequence >= 0
      ? requestedSequence
      : sequence + 1;
    const hostSequence = Math.max(sequence + 1, sequenceCandidate);
    sequence = hostSequence;
    const occurredAtCandidate = source.occurredAt;
    const occurredAt = typeof occurredAtCandidate === "number"
      && Number.isSafeInteger(occurredAtCandidate)
      && occurredAtCandidate >= 0
      ? occurredAtCandidate
      : Date.now();
    const requestedUpdatedAt = state.updatedAt ?? occurredAt;
    updatedAt = Math.max(updatedAt, boundedInspectionInteger(requestedUpdatedAt, occurredAt));
    if (state.terminalAt !== undefined) terminalAt = state.terminalAt;
    if ((outcome !== null || status === "terminal") && terminalAt === null) terminalAt = updatedAt;
    if (startedAt > updatedAt) startedAt = updatedAt;

    const id = boundedInspectionString(source.id) ?? `${kind}:${hostSequence}`;
    const requestedCorrelation = inspectionObject(source.correlation);
    const correlation: AgentInspectionCorrelationV1 = {
      turnSessionId: input.turnSessionId,
      runId: input.runId,
      attemptId: input.attemptId,
      chatId: input.chatId,
      generationId: input.generationId,
      messageId: input.targetMessageId ?? null,
      swipeId: input.targetSwipeId ?? null,
      actorId: boundedInspectionString(requestedCorrelation.actorId) ?? null,
      recipientId: boundedInspectionString(requestedCorrelation.recipientId) ?? null,
      phase: lifecycle,
      taskId: boundedInspectionString(requestedCorrelation.taskId) ?? null,
      toolId: boundedInspectionString(requestedCorrelation.toolId, 128) ?? null,
      parentId: boundedInspectionString(requestedCorrelation.parentId) ?? null,
      hostCorrelationId: input.hostCorrelationId,
      hostSequence,
    };
    const payload = {
      ...source,
      id,
      sequence: hostSequence,
      hostSequence,
      occurredAt,
      correlation,
    };
    const transcriptPayload = {
      ...payload,
      version: 1,
      recipient: source.recipient === undefined ? null : source.recipient,
      durationMs: source.durationMs === undefined ? null : source.durationMs,
      late: source.late === undefined ? false : source.late,
      content: source.content === undefined ? null : source.content,
      arguments: source.arguments === undefined ? null : source.arguments,
      result: source.result === undefined ? null : source.result,
      provider: source.provider === undefined ? null : source.provider,
      errorReason: source.errorReason === undefined ? null : source.errorReason,
    };
    const turnSessionKind = kind === "turn_session"
      ? (typeof source.kind === "string" && TURN_SESSION_KINDS.has(source.kind) ? source.kind : "recovery")
      : TURN_SESSION_KINDS.has(kind) && kind !== "recovery" ? kind : null;
    const turnSessionPayload = turnSessionKind
      ? {
        ...payload,
        kind: turnSessionKind,
        detail: typeof source.detail === "string"
          ? source.detail
          : boundedInspectionJson({
            content: source.content ?? null,
            arguments: source.arguments ?? null,
            result: source.result ?? null,
          }, 2048),
        transcriptRecordIds: Array.isArray(source.transcriptRecordIds)
          ? source.transcriptRecordIds.filter((item): item is string => typeof item === "string").slice(0, 256)
          : [],
      }
      : null;
    const records: Partial<PersistAgentRunInspectionInputV1> =
      turnSessionPayload
        ? { turnSession: [turnSessionPayload] }
        : kind === "marker"
          ? { markers: [payload] }
          : kind === "usage"
            ? { usageEvidence: [payload] }
            : kind === "prompt"
              ? { promptEvidence: [payload] }
              : kind === "cortex"
                ? { cortexReceipts: [payload] }
                : kind === "council"
                  ? { councilReceipts: [payload] }
                  : kind === "workspace"
                    ? { workspaceAssociations: [payload] }
                    : kind === "activity"
                      ? { activity: [payload] }
                      : kind === "stop"
                        ? { stop: payload }
                        : kind === "recovery"
                          ? {
                            markers: [{
                              ...payload,
                              kind: "recovered_duplicate",
                              scope: "run",
                              firstSequence: hostSequence,
                              lastSequence: hostSequence,
                              recoverable: true,
                              detail: boundedInspectionText(source.detail ?? source.result ?? "Recovered duplicate inspection writer"),
                            }],
                          }
                          : { transcript: [transcriptPayload] };
    return persistAgentRunInspection({
      userId: input.userId,
      chatId: input.chatId,
      attemptId: input.attemptId,
      ...(input.previousAttemptId !== undefined ? { previousAttemptId: input.previousAttemptId } : {}),
      runId: input.runId,
      turnSessionId: input.turnSessionId,
      generationId: input.generationId,
      generationType: input.generationType,
      ...(input.targetMessageId !== undefined ? { targetMessageId: input.targetMessageId } : {}),
      ...(input.targetSwipeId !== undefined ? { targetSwipeId: input.targetSwipeId } : {}),
      hostCorrelationId: input.hostCorrelationId,
      lifecycle,
      status,
      outcome,
      reason,
      startedAt,
      updatedAt,
      terminalAt,
      reconciliation,
      ...(terminalReceipt !== undefined ? { terminalReceipt } : {}),
      ...records,
    });
  };

  return Object.freeze({ record });
}


function deletedInspectionLineage(row: AgentInspectionSourceDeletionV1): AgentInspectionAttemptLineageV1 {
  return {
    version: 1,
    attemptId: row.attemptId,
    previousAttemptId: row.previousAttemptId,
    target: {
      chatId: row.chatId,
      generationType: row.generationType,
      messageId: row.targetMessageId,
      swipeId: row.targetSwipeId,
    },
    createdAt: row.createdAt,
  };
}

function deletedInspectionCorrelation(
  row: AgentInspectionSourceDeletionV1,
  hostSequence = 0,
): AgentInspectionCorrelationV1 {
  return {
    turnSessionId: row.turnId,
    runId: row.runId,
    attemptId: row.attemptId,
    chatId: row.chatId,
    generationId: row.generationId,
    messageId: row.targetMessageId,
    swipeId: row.targetSwipeId,
    actorId: null,
    recipientId: null,
    phase: row.lifecycle,
    taskId: null,
    toolId: null,
    parentId: null,
    hostCorrelationId: row.hostCorrelationId,
    hostSequence,
  };
}

const SOURCE_DELETED_SCOPES: readonly AgentInspectionMarkerV1["scope"][] = [
  "transcript",
  "turn_session",
  "prompt",
  "cortex",
  "council",
];

function deletedInspectionMarkers(row: AgentInspectionSourceDeletionV1): readonly AgentInspectionMarkerV1[] {
  return SOURCE_DELETED_SCOPES.map((scope, index) => ({
    version: 1,
    id: `${row.attemptId}:${scope}:source-deleted`,
    kind: "unavailable",
    scope,
    correlation: deletedInspectionCorrelation(row, index),
    firstSequence: null,
    lastSequence: null,
    recoverable: false,
    detail: "source_deleted",
  }));
}

function deletedUsageProjection(row: AgentInspectionSourceDeletionV1): AgentInspectionUsageProjectionV1 {
  return {
    version: 1,
    inspectionAttemptId: row.attemptId,
    totals: row.usage,
    layers: USAGE_LAYERS.map((layer) => ({
      version: 1,
      layer,
      source: "provisional",
      correlation: null,
      inputTokens: layer === "root" ? row.usage.inputTokens : 0,
      outputTokens: layer === "root" ? row.usage.outputTokens : 0,
      totalTokens: layer === "root" ? row.usage.totalTokens : 0,
      toolCalls: layer === "root" ? row.usage.toolCalls : 0,
      childInvocations: layer === "root" ? row.usage.childInvocations : 0,
      evidenceIds: [],
      canonical: false,
    })),
    evidenceCount: 0,
    omittedEvidenceCount: 1,
  };
}

function deletedInspectionSummary(row: AgentInspectionSourceDeletionV1): AgentRunInspectionSummaryV1 {
  const attempt = deletedInspectionLineage(row);
  const markers = deletedInspectionMarkers(row);
  const target = row.targetMessageId === null
    ? null
    : { messageId: row.targetMessageId, swipeId: row.targetSwipeId ?? 0 };
  return {
    version: 1,
    attempt,
    runId: row.runId,
    turnSessionId: row.turnId,
    generationId: row.generationId,
    hostCorrelationId: row.hostCorrelationId,
    lifecycle: row.lifecycle,
    status: row.status,
    outcome: row.outcome,
    reason: normalizeInspectionReason(row.attemptReason),
    target,
    committedTarget: null,
    revision: row.attemptVersion,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    terminalAt: row.terminalAt,
    activity: {
      version: 1,
      attempt,
      lifecycle: row.lifecycle,
      status: row.status,
      outcome: row.outcome,
      reason: normalizeInspectionReason(row.attemptReason),
      revision: row.attemptVersion,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      terminalAt: row.terminalAt,
      target,
      milestones: row.activity,
      usage: row.usage,
      markers,
      reconciliation: row.reconciliationState,
    },
    markerCount: markers.length,
    transcriptCount: 0,
    terminal: row.terminal,
  };
}

function deletedInspectionDetail(row: AgentInspectionSourceDeletionV1): AgentRunInspectionDetailV1 {
  const summary = deletedInspectionSummary(row);
  const markers = deletedInspectionMarkers(row);
  const privateSection = (section: AgentInspectionSectionIdV1): AgentInspectionSectionAvailabilityV1 => ({
    section,
    state: "source_deleted",
    reason: "unavailable",
  });
  const sectionAvailability: readonly AgentInspectionSectionAvailabilityV1[] = [
    { section: "run", state: "available", reason: null },
    { section: "activity", state: "available", reason: null },
    privateSection("transcript"),
    privateSection("turn_session"),
    { section: "usage", state: "available", reason: null },
    privateSection("prompt"),
    privateSection("cortex"),
    privateSection("council"),
    {
      section: "workspace",
      state: row.workspaceAssociations.length > 0 ? "available" : "not_recorded",
      reason: null,
    },
  ];
  return {
    ...summary,
    transcript: [],
    turnSession: [],
    markers,
    usageEvidence: [],
    usage: deletedUsageProjection(row),
    error: {
      version: 1,
      inspectionAttemptId: row.attemptId,
      code: "agentRun.errors.source_deleted",
      category: "integrity",
      summaryCode: "agentRun.errors.source_deleted",
      causalCode: null,
      authority: "owner",
      source: "host",
      scope: "attempt",
      capGate: null,
      target: deletedInspectionLineage(row).target,
      workPhase: row.lifecycle,
      workStatus: row.status,
      workOutcome: row.outcome,
      reason: "source_deleted",
      recoveryEligible: false,
      recoveryAction: "none",
      omissionCount: markers.length,
    },
    promptEvidence: [],
    renderCrossings: [],
    cortexReceipts: [],
    councilReceipts: [],
    workspaceAssociations: row.workspaceAssociations,
    stop: null,
    workSegments: null,
    retry: {
      allowed: false,
      reason: "unavailable",
      targetValid: false,
      linkedAttemptId: null,
    },
    sectionAvailability,
  };
}
export function getAgentRunInspection(
  userId: string,
  attemptId: string,
  chatId?: string,
): AgentRunInspectionDetailV1 | null {
  try {
    const db = getDb();
    return db.transaction(() => {
      const row = loadInspectionAttempt(db, userId, attemptId, chatId);
      if (row) return detailFromRow(db, row);
      const deleted = loadAgentInspectionSourceDeletionFromDb(db, { userId, attemptId, chatId });
      return deleted ? deletedInspectionDetail(deleted) : null;
    })();
  } catch {
    return null;
  }
}

export function getAgentRunInspectionForTarget(
  userId: string,
  chatId: string,
  messageId: string,
  swipeId: number,
): AgentRunInspectionDetailV1 | null {
  if (!ownsChatForActivity(userId, chatId) || !Number.isSafeInteger(swipeId) || swipeId < 0) return null;
  try {
    const db = getDb();
    const row = db.query(
      "SELECT attempt_id FROM agent_run_attempts WHERE user_id = ? AND chat_id = ? AND target_message_id = ? AND target_swipe_id = ? ORDER BY terminal DESC, COALESCE(updated_at, 0) DESC, attempt_id DESC LIMIT 1",
    ).get(userId, chatId, messageId, swipeId) as { attempt_id?: unknown } | null;
    if (typeof row?.attempt_id !== "string") return null;
    return getAgentRunInspection(userId, row.attempt_id, chatId);
  } catch {
    return null;
  }
}
export function listAgentRunInspections(
  userId: string,
  chatId: string,
  limit = AGENT_RUN_INSPECTION_MAX_LIST,
  cursor?: string,
): AgentRunInspectionListV1 | null {
  if (!ownsChatForActivity(userId, chatId)) return null;
  const boundedLimit = Number.isSafeInteger(limit) && limit >= 1
    ? Math.min(limit, AGENT_RUN_INSPECTION_MAX_LIST)
    : AGENT_RUN_INSPECTION_MAX_LIST;
  const inspectionCursor = cursor === undefined ? undefined : decodeAgentRunInspectionCursor(cursor);
  if (cursor !== undefined && inspectionCursor === null) return null;
  const cursorPredicate = inspectionCursor
    ? "(sort_updated_at < ? OR (sort_updated_at = ? AND attempt_id < ?))"
    : "";
  const cursorParams = inspectionCursor
    ? [inspectionCursor.updatedAt, inspectionCursor.updatedAt, inspectionCursor.attemptId]
    : [];
  try {
    const db = getDb();
    return db.transaction(() => {
      const hasDeleted = db.query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_run_source_deletions' LIMIT 1",
      ).get() !== null;
      const keys = hasDeleted
        ? db.query(
          `WITH candidates AS (
             SELECT attempt_id, COALESCE(updated_at, -1) AS sort_updated_at, 0 AS source_deleted
               FROM agent_run_attempts WHERE user_id = ? AND chat_id = ?
             UNION ALL
             SELECT deleted.attempt_id, COALESCE(deleted.updated_at, -1) AS sort_updated_at, 1 AS source_deleted
               FROM agent_run_source_deletions AS deleted
              WHERE deleted.user_id = ? AND deleted.chat_id = ?
                AND NOT EXISTS (
                  SELECT 1 FROM agent_run_attempts AS live
                   WHERE live.user_id = deleted.user_id AND live.attempt_id = deleted.attempt_id
                )
           )
           SELECT attempt_id, source_deleted, sort_updated_at
             FROM candidates
            ${inspectionCursor ? `WHERE ${cursorPredicate}` : ""}
            ORDER BY sort_updated_at DESC, attempt_id DESC
            LIMIT ?`,
        ).all(userId, chatId, userId, chatId, ...cursorParams, boundedLimit + 1) as Array<{
          attempt_id: string;
          source_deleted: number;
          sort_updated_at: number;
        }>
        : db.query(
          `SELECT attempt_id, 0 AS source_deleted,
                  COALESCE(updated_at, -1) AS sort_updated_at
             FROM agent_run_attempts
            WHERE user_id = ? AND chat_id = ?
            ${inspectionCursor ? `AND ${cursorPredicate}` : ""}
            ORDER BY sort_updated_at DESC, attempt_id DESC
            LIMIT ?`,
        ).all(userId, chatId, ...cursorParams, boundedLimit + 1) as Array<{
          attempt_id: string;
          source_deleted: number;
          sort_updated_at: number;
        }>;
      const pageKeys = keys.slice(0, boundedLimit);
      const runs = pageKeys.flatMap((key): AgentRunInspectionSummaryV1[] => {
        if (key.source_deleted === 1) {
          const deleted = loadAgentInspectionSourceDeletionFromDb(db, {
            userId,
            attemptId: key.attempt_id,
            chatId,
          });
          return deleted ? [deletedInspectionSummary(deleted)] : [];
        }
        const live = loadInspectionAttempt(db, userId, key.attempt_id, chatId);
        return live ? [summaryFromRow(db, live)] : [];
      });
      const lastPageKey = pageKeys.at(-1);
      return {
        version: 1 as const,
        chatId,
        runs,
        nextCursor: keys.length > boundedLimit && lastPageKey
          ? encodeAgentRunInspectionCursor(lastPageKey.sort_updated_at, lastPageKey.attempt_id)
          : null,
        omission: null,
      };
    })();
  } catch {
    return null;
  }
}

