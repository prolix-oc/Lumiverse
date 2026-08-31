import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { getDb } from "../db/connection";
import type {
  AgenticWorkMutatingWorkspaceOperationKindV1,
  AgenticWorkWorkspaceMutationReservationV1,
  WorkAttemptBudgetV1,
  WorkAttemptUsageV1,
  WorkHandoffAcceptedIdsV1,
  WorkHandoffAdvisoryCompletionV1,
  WorkPhaseTransitionReceiptV1,
  WorkPhasePlanAuthorityV1,
  WorkProviderBoundaryClassV1,
  WorkSegmentAcceptedRecordV1,
  WorkSegmentAdmissionV1,
  WorkSegmentAllOptionalPhasesSkippedAuthorityV1,
  WorkSegmentAttemptRecoveryV1,
  WorkSegmentDispatchBudgetClassV1,
  WorkSegmentBudgetV1,
  WorkSegmentContextV1,
  WorkSegmentSkippedPhaseDecisionAuthorityV1,
  WorkSegmentDispatchReservationV1,
  WorkSegmentRecoveryChainV1,
  WorkSegmentResumeEnvelopeV1,
  WorkSegmentIdentityV1,
  WorkSegmentRunnerResultV1,
  WorkSegmentToolModeV1,
  WorkSegmentTransitionKindV1,
  WorkSegmentUsageV1,
  WorkSettledWorkspaceEffectV1,
} from "../types/agent-work-segment";
import { WORKSPACE_OPERATIONS } from "../types/turn-workspace";
import { encodeCanonicalPlainData } from "../utils/canonical-plain-data";
import { compareUtf8 } from "../utils/utf8-order";
import { cancellationTerminalCause } from "../utils/turn-cancellation-cause";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_COUNTER = 2_147_483_648;
const MAX_ORDINAL = 1_000_000;
const MAX_ID_BYTES = 256;
const MAX_ID_LIST_ITEMS = 128;
const MAX_SUMMARY_BYTES = 16 * 1024;
const MAX_GUIDANCE_BYTES = 8 * 1024;
const MAX_CANONICAL_BYTES = 1024 * 1024;
const MAX_RESUME_ENVELOPE_BYTES = 8 * 1024 * 1024;
const MAX_DISPATCH_EFFECT_PAYLOAD_BYTES = 128 * 1024;
export const WORK_CANCELLATION_TERMINAL_CLOSE_GRACE_MS = 5_000;
const INTERNAL_WORKSPACE_OPERATIONS = new Set<AgenticWorkMutatingWorkspaceOperationKindV1>([
  "assign_child_tasks",
  "settle_child_task",
]);
const MUTATING_WORKSPACE_OPERATIONS = new Set<string>([
  ...WORKSPACE_OPERATIONS.filter((operation) => operation !== "read_section" && operation !== "read_page"),
  ...INTERNAL_WORKSPACE_OPERATIONS,
]);
const BOUNDARY_CLASSES: Record<WorkProviderBoundaryClassV1, true> = {
  tool_action: true,
  tool_free_stop: true,
  reasoning_only_stop: true,
  reasoning_only_length: true,
  empty_provider_response: true,
  provider_protocol_failure: true,
};
const TRANSITION_KINDS: Record<WorkSegmentTransitionKindV1, true> = {
  advance: true,
  repeat: true,
  rollover: true,
  terminal: true,
};
const TOOL_MODES: Record<WorkSegmentToolModeV1, true> = { ordinary: true, required: true };
const DISPATCH_BUDGET_CLASSES: Record<WorkSegmentDispatchBudgetClassV1, true> = { normal: true, recovery: true };

export type AgenticWorkSegmentRepositoryErrorCode =
  | "invalid_input"
  | "not_found"
  | "stale_execution"
  | "stale_workspace"
  | "stale_segment"
  | "stale_owner"
  | "idempotency_conflict"
  | "attempt_budget_exhausted"
  | "segment_budget_exhausted"
  | "dispatch_budget_exhausted"
  | "recovery_reserve_exhausted"
  | "future_phase_reserve_exhausted"
  | "unsigned_boundary_budget_exhausted"
  | "integrity_error";

export class AgenticWorkSegmentRepositoryError extends Error {
  readonly code: AgenticWorkSegmentRepositoryErrorCode;

  constructor(code: AgenticWorkSegmentRepositoryErrorCode, message: string) {
    super(message);
    this.name = "AgenticWorkSegmentRepositoryError";
    this.code = code;
  }
}

export interface WorkSegmentWriteResult<T> {
  readonly record: T;
  readonly duplicate: boolean;
}

export interface AuthorityInputV1 {
  readonly userId: string;
  readonly executionId: string;
  readonly ownerToken: string;
  readonly expectedExecutionCasRevision: number;
  readonly expectedWorkspaceRevision: number;
  readonly now: number;
  readonly db?: Database;
}

export interface WorkSegmentInspectionAuthorityInputV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly db?: Database;
}
export interface ReconcileWorkSegmentRecoveryResultV1 {
  readonly scanned: number;
  readonly active: number;
  readonly closed: number;
  readonly queued: number;
  readonly reclaimed: number;
  readonly fenced: number;
  readonly terminalized: number;
  readonly complete: boolean;
  readonly healthy: boolean;
}

export interface ClaimQueuedWorkSegmentRecoveryInputV1 {
  readonly userId: string;
  readonly executionId: string;
  readonly runtimeEpoch: number;
  readonly expectedOwnerToken: string;
  readonly expectedExecutionCasRevision: number;
  readonly expectedSegmentId: string;
  readonly claimOwnerToken: string;
  readonly now: number;
  readonly db?: Database;
}


export interface ClaimQueuedWorkCompletionRecoveryInputV1 {
  readonly userId: string;
  readonly executionId: string;
  readonly runtimeEpoch: number;
  readonly expectedOwnerToken: string;
  readonly expectedExecutionCasRevision: number;
  readonly expectedAttemptId: string;
  readonly expectedWorkspaceId: string;
  readonly expectedTerminalTransitionId: string;
  readonly claimOwnerToken: string;
  readonly now: number;
  readonly db?: Database;
}
export interface RenewWorkExecutionOwnerLeaseInputV1 extends AuthorityInputV1 {
  readonly runtimeEpoch: number;
  readonly leaseExpiresAt: number;
}

export interface RenewWorkSegmentOwnerLeaseInputV1 extends AuthorityInputV1 {
  readonly runtimeEpoch: number;
  readonly currentSegmentId: string;
  readonly leaseExpiresAt: number;
}

export interface RenewInFlightWorkSegmentDispatchLeaseInputV1 extends AuthorityInputV1 {
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly leaseOwner: string;
  readonly fenceGeneration: number;
  readonly leaseExpiresAt: number;
}

export interface CreateWorkSegmentAttemptInputV1 extends AuthorityInputV1 {
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly phaseId: string | null;
  readonly phaseIndex: number;
  readonly phaseOccurrence: number;
  readonly remainingRequiredPhaseCount: number;
  readonly snapshotDigest: string;
  readonly phasePlanDigest: string;
  readonly phasePlan: WorkPhasePlanAuthorityV1;
  readonly bindingDigest: string;
  readonly idempotencyKey: string;
  readonly resumeEnvelope: WorkSegmentResumeEnvelopeV1;
  readonly budget: WorkAttemptBudgetV1;
}

export interface AdmitWorkSegmentInputV1 extends AuthorityInputV1 {
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly sourceTransitionId: string | null;
  readonly phaseId: string | null;
  readonly phaseIndex: number;
  readonly phaseOccurrence: number;
  readonly segmentOrdinal: number;
  readonly admissionKey: string;
  readonly contextDigest: string;
  readonly context: WorkSegmentContextV1;
  readonly budget: WorkSegmentBudgetV1;
}

export interface CreateAndAdmitInitialWorkSegmentInputV1 {
  readonly attempt: Omit<CreateWorkSegmentAttemptInputV1, "db">;
  readonly admission: Omit<AdmitWorkSegmentInputV1, "db">;
  readonly db?: Database;
}

export interface CreateAndAdmitInitialWorkSegmentResultV1 {
  readonly attempt: WorkSegmentWriteResult<WorkSegmentAttemptRecoveryV1>;
  readonly admission: WorkSegmentWriteResult<WorkSegmentAdmissionV1>;
}

export interface ReserveWorkSegmentDispatchInputV1 extends AuthorityInputV1 {
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly segmentId: string;
  readonly dispatchOrdinal: number;
  readonly idempotencyKey: string;
  readonly toolMode: WorkSegmentToolModeV1;
  readonly budgetClass: WorkSegmentDispatchBudgetClassV1;
  readonly reservedOutputTokens: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: number;
}

export interface StartWorkSegmentDispatchInputV1 extends AuthorityInputV1 {
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly leaseOwner: string;
  readonly fenceGeneration: number;
}

export interface WorkSegmentWorkspaceMutationEffectV1 extends AgenticWorkWorkspaceMutationReservationV1 {
  readonly outcome: "mutated" | "no_op" | "failed";
  readonly outcomeCode: string | null;
  readonly operationDigest: string | null;
  readonly beforeWorkspaceRevision: number;
  readonly afterWorkspaceRevision: number;
}

export interface SettleWorkSegmentDispatchInputV1 extends AuthorityInputV1 {
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly leaseOwner: string;
  readonly fenceGeneration: number;
  readonly settlementKey: string;
  readonly boundaryClass: WorkProviderBoundaryClassV1;
  readonly usage: WorkSegmentUsageV1;
  readonly workspaceMutations: readonly AgenticWorkWorkspaceMutationReservationV1[];
}

export interface WorkSegmentWorkspaceMutationOwnerV1 {
  readonly segmentId: string;
  readonly logicalDispatch: number;
  readonly frameId: string;
}

export interface AppendSettledWorkSegmentDispatchMutationReservationsInputV1 extends AuthorityInputV1 {
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly fenceGeneration: number;
  readonly expectedSettlementDigest: string;
  readonly appendKey: string;
  readonly owner: WorkSegmentWorkspaceMutationOwnerV1;
  readonly mutations: readonly AgenticWorkWorkspaceMutationReservationV1[];
}

export interface WorkSegmentWorkspaceMutationReservationAppendV1 {
  readonly version: 1;
  readonly appendKey: string;
  readonly appendOrdinal: number;
  readonly owner: WorkSegmentWorkspaceMutationOwnerV1;
  readonly mutations: readonly AgenticWorkWorkspaceMutationReservationV1[];
  readonly appendDigest: string;
}
export interface PersistWorkSegmentChildAssignmentAuthorityInputV1 extends AuthorityInputV1 {
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly fenceGeneration: number;
  readonly expectedSettlementDigest: string;
  readonly assignmentReservation: AgenticWorkWorkspaceMutationReservationV1;
  readonly assignments: readonly Readonly<{
    taskId: string;
    frameId: string;
    settlementReservation: AgenticWorkWorkspaceMutationReservationV1;
  }>[];
}

export interface WorkSegmentChildAssignmentAuthorityV1 {
  readonly version: 1;
  readonly assignmentReservation: AgenticWorkWorkspaceMutationReservationV1;
  readonly assignments: readonly Readonly<{
    taskId: string;
    frameId: string;
    settlementReservation: AgenticWorkWorkspaceMutationReservationV1;
  }>[];
  readonly authorityDigest: string;
}

export interface FinalizeSettledWorkSegmentDispatchEffectsInputV1 extends AuthorityInputV1 {
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly fenceGeneration: number;
  readonly expectedSettlementDigest: string;
  readonly owner: WorkSegmentWorkspaceMutationOwnerV1;
  readonly finalizationKey: string;
  readonly effects: readonly WorkSegmentWorkspaceMutationEffectV1[];
  readonly nextWorkspaceRevision: number;
}

export interface ReclaimReservedWorkSegmentDispatchInputV1 extends AuthorityInputV1 {
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly newLeaseOwner: string;
  readonly newLeaseExpiresAt: number;
}

export interface InterruptUnsettledWorkSegmentDispatchInputV1 extends AuthorityInputV1 {
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly interruptionKey: string;
  readonly reason: string;
}

export interface CommitWorkSegmentTransitionInputV1 extends AuthorityInputV1 {
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly sourceSegmentId: string;
  readonly phasePlanDigest: string;
  readonly transitionDecisionDigest: string;
  readonly idempotencyKey: string;
  readonly transitionKind: WorkSegmentTransitionKindV1;
  readonly targetPhaseId: string | null;
  readonly targetPhaseIndex: number | null;
  readonly targetPhaseOccurrence: number | null;
  readonly targetSegmentOrdinal: number | null;
  readonly remainingRequiredPhaseCount: number;
  readonly boundaryClass: WorkProviderBoundaryClassV1;
  readonly closeResult: Extract<WorkSegmentRunnerResultV1["kind"], "phase_advanced" | "phase_repeated" | "same_phase_rollover" | "work_complete">;
  readonly usage: WorkSegmentUsageV1;
  readonly completion: Omit<WorkHandoffAdvisoryCompletionV1, "authority">;
}

export interface CommitAndAdmitWorkSegmentTransitionInputV1 {
  readonly transition: CommitWorkSegmentTransitionInputV1;
  readonly target: Readonly<{
    phaseId: string | null;
    phaseIndex: number;
    phaseOccurrence: number;
    segmentOrdinal: number;
    admissionKey: string;
    budget: WorkSegmentBudgetV1;
  }>;
  readonly makeTargetContext: (handoff: WorkPhaseTransitionReceiptV1["handoff"]) => WorkSegmentContextV1;
}

export interface CommitAndAdmitWorkSegmentTransitionResultV1 {
  readonly transition: WorkSegmentWriteResult<WorkPhaseTransitionReceiptV1>;
  readonly admission: WorkSegmentWriteResult<WorkSegmentAdmissionV1>;
  readonly context: WorkSegmentContextV1;
}

export interface CloseWorkSegmentTerminalInputV1 extends AuthorityInputV1 {
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly sourceSegmentId: string;
  readonly idempotencyKey: string;
  readonly closeResult: Extract<WorkSegmentRunnerResultV1["kind"], "failed" | "exhausted" | "cancelled">;
  readonly closeReason: string;
  readonly boundaryClass: WorkProviderBoundaryClassV1 | null;
  readonly usage: WorkSegmentUsageV1;
}
export interface CloseAdmittedWorkSegmentWithoutDispatchTerminalInputV1 extends AuthorityInputV1 {
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly sourceSegmentId: string;
  readonly idempotencyKey: string;
  readonly closeResult: Extract<WorkSegmentRunnerResultV1["kind"], "failed" | "exhausted" | "cancelled">;
  readonly closeReason: string;
}

type Row = Record<string, unknown>;

interface AuthorityRow extends Row {
  readonly user_id: string;
  readonly execution_id: string;
  readonly chat_id: string;
  readonly generation_id: string;
  readonly mode: string;
  readonly execution_state: string;
  readonly execution_workspace_id: string | null;
  readonly execution_workspace_revision: number;
  readonly cas_revision: number;
  readonly cas_owner: string | null;
  readonly cas_expires_at: number | null;
  readonly deadline_at: number;
  readonly cancel_requested_at: number | null;
  readonly cancellation_terminal_close_grace: boolean;
  readonly workspace_id: string;
  readonly workspace_revision: number;
  readonly workspace_state: string;
}

function fail(code: AgenticWorkSegmentRepositoryErrorCode, message: string): never {
  throw new AgenticWorkSegmentRepositoryError(code, message);
}


function boundedString(value: unknown, field: string, maxBytes = MAX_ID_BYTES, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || Buffer.byteLength(value, "utf8") > maxBytes) {
    fail("invalid_input", `${field} is invalid`);
  }
  return value;
}

function safeInteger(value: unknown, field: string, max = MAX_SAFE_INTEGER, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail("invalid_input", `${field} is invalid`);
  }
  return value;
}

function id(value: unknown, field: string): string {
  return boundedString(value, field);
}

function nonNegative(value: unknown, field: string, max = MAX_SAFE_INTEGER): number {
  return safeInteger(value, field, max);
}
function digest(value: unknown, field: string): string {
  const normalized = boundedString(value, field, 64);
  if (!/^[0-9a-f]{64}$/.test(normalized)) fail("invalid_input", `${field} is invalid`);
  return normalized;
}

function canonicalDigest(value: unknown, maxBytes = MAX_CANONICAL_BYTES): string {
  let encoded: string;
  try {
    encoded = encodeCanonicalPlainData(value, { maxBytes });
  } catch {
    fail("invalid_input", "canonical payload is invalid");
  }
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

function deterministicId(prefix: "segment" | "transition" | "dispatch", userId: string, executionId: string, key: string): string {
  const suffix = createHash("sha256")
    .update(encodeCanonicalPlainData([prefix, userId, executionId, key]), "utf8")
    .digest("hex");
  return `${prefix}:${suffix}`;
}
type DurableWorkspaceMutationReservationV1 = AgenticWorkWorkspaceMutationReservationV1 & {
  readonly attemptedOperationDigest: string;
};

interface DispatchMutationReservationPayloadV1 {
  readonly version: 1;
  readonly kind: "work_dispatch_mutation_reservation";
  readonly userId: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly fenceGeneration: number;
  readonly settlementKey: string;
  readonly providerSettlementDigest: string;
  readonly baseWorkspaceRevision: number;
  readonly mutations: readonly DurableWorkspaceMutationReservationV1[];
  readonly reservationDigest: string;
}

interface DispatchMutationReservationAppendPayloadV1 {
  readonly version: 1;
  readonly kind: "work_dispatch_mutation_reservation_append";
  readonly userId: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly fenceGeneration: number;
  readonly providerSettlementDigest: string;
  readonly appendKey: string;
  readonly appendOrdinal: number;
  readonly owner: WorkSegmentWorkspaceMutationOwnerV1;
  readonly mutations: readonly DurableWorkspaceMutationReservationV1[];
  readonly appendDigest: string;
}

interface DispatchChildAssignmentAuthorityPayloadV1 {
  readonly version: 1;
  readonly kind: "work_dispatch_child_assignment_authority";
  readonly userId: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly fenceGeneration: number;
  readonly providerSettlementDigest: string;
  readonly assignmentReservation: DurableWorkspaceMutationReservationV1;
  readonly assignments: readonly Readonly<{
    taskId: string;
    frameId: string;
    settlementReservation: DurableWorkspaceMutationReservationV1;
  }>[];
  readonly authorityDigest: string;
}

interface DispatchOwnerEffectFinalizationPayloadV1 {
  readonly version: 1;
  readonly kind: "work_dispatch_owner_effect_finalization";
  readonly userId: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly fenceGeneration: number;
  readonly reservationDigest: string;
  readonly providerSettlementDigest: string;
  readonly owner: WorkSegmentWorkspaceMutationOwnerV1;
  readonly finalizationKey: string;
  readonly effects: readonly (WorkSegmentWorkspaceMutationEffectV1 & { readonly attemptedOperationDigest: string })[];
  readonly nextWorkspaceRevision: number;
  readonly finalizationDigest: string;
}

interface DispatchEffectFinalizationPayloadV1 {
  readonly version: 1;
  readonly kind: "work_dispatch_effect_finalization";
  readonly userId: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly segmentId: string;
  readonly dispatchId: string;
  readonly fenceGeneration: number;
  readonly reservationDigest: string;
  readonly providerSettlementDigest: string;
  readonly finalizationKey: string;
  readonly effects: readonly (WorkSegmentWorkspaceMutationEffectV1 & { readonly attemptedOperationDigest: string })[];
  readonly nextWorkspaceRevision: number;
  readonly finalizationDigest: string;
}

function dispatchEffectRecordId(
  kind: "reservation" | "finalization",
  userId: string,
  executionId: string,
  dispatchId: string,
): string {
  const suffix = createHash("sha256")
    .update(encodeCanonicalPlainData(["work_dispatch_effect", kind, userId, executionId, dispatchId]), "utf8")
    .digest("hex");
  return "work-effect-" + kind + ":" + suffix;
}

function scopedDispatchEffectRecordId(
  kind: "reservation-append" | "child-assignment" | "owner-finalization",
  userId: string,
  executionId: string,
  dispatchId: string,
  scopeKey: string,
): string {
  const suffix = createHash("sha256")
    .update(encodeCanonicalPlainData(["work_dispatch_effect", kind, userId, executionId, dispatchId, scopeKey]), "utf8")
    .digest("hex");
  return "work-effect-" + kind + ":" + suffix;
}

function canonicalEffectPayload(value: unknown): Readonly<{ json: string; digest: string; byteSize: number }> {
  let json: string;
  try {
    json = encodeCanonicalPlainData(value, { maxBytes: MAX_DISPATCH_EFFECT_PAYLOAD_BYTES });
  } catch {
    fail("invalid_input", "dispatch effect payload exceeds its durable bound");
  }
  return Object.freeze({
    json,
    digest: createHash("sha256").update(json, "utf8").digest("hex"),
    byteSize: Buffer.byteLength(json, "utf8"),
  });
}

function rawDispatchEffectPayload(db: Database, recordId: string): unknown | null {
  const row = db.query("SELECT payload_json FROM agent_run_audit_records WHERE record_id = ?").get(recordId) as Row | null;
  if (!row) return null;
  try {
    return JSON.parse(stringFrom(row, "payload_json"));
  } catch {
    fail("integrity_error", "dispatch effect payload is corrupt");
  }
}

function insertDispatchEffectPayload(
  db: Database,
  identity: Readonly<{
    userId: string;
    chatId: string;
    executionId: string;
    attemptId: string;
    segmentId: string;
    dispatchId: string;
  }>,
  kind: "reservation" | "finalization",
  payloadJson: string,
  byteSize: number,
  occurredAt: number,
): void {
  const recordId = dispatchEffectRecordId(kind, identity.userId, identity.executionId, identity.dispatchId);
  db.query(
    "INSERT INTO agent_run_audit_records "
      + "(record_id, user_id, chat_id, attempt_id, record_kind, event_id, causal_parent_id, "
      + "host_sequence, occurred_at, late, payload_json, byte_size, dedupe_key) "
      + "VALUES (?, ?, ?, ?, 'recovery', ?, ?, ?, ?, 0, ?, ?, ?)",
  ).run(
    recordId,
    identity.userId,
    identity.chatId,
    identity.attemptId,
    identity.dispatchId,
    identity.segmentId,
    MAX_COUNTER - 1,
    occurredAt,
    payloadJson,
    byteSize,
    "work-dispatch-effect-" + kind + ":" + identity.dispatchId,
  );
}

function insertScopedDispatchEffectPayload(
  db: Database,
  identity: Readonly<{
    userId: string;
    chatId: string;
    executionId: string;
    attemptId: string;
    segmentId: string;
    dispatchId: string;
  }>,
  kind: "reservation-append" | "child-assignment" | "owner-finalization",
  scopeKey: string,
  payloadJson: string,
  byteSize: number,
  occurredAt: number,
): void {
  const recordId = scopedDispatchEffectRecordId(
    kind,
    identity.userId,
    identity.executionId,
    identity.dispatchId,
    scopeKey,
  );
  db.query(
    "INSERT INTO agent_run_audit_records "
      + "(record_id, user_id, chat_id, attempt_id, record_kind, event_id, causal_parent_id, "
      + "host_sequence, occurred_at, late, payload_json, byte_size, dedupe_key) "
      + "VALUES (?, ?, ?, ?, 'recovery', ?, ?, ?, ?, 0, ?, ?, ?)",
  ).run(
    recordId,
    identity.userId,
    identity.chatId,
    identity.attemptId,
    identity.dispatchId,
    identity.segmentId,
    MAX_COUNTER - 1,
    occurredAt,
    payloadJson,
    byteSize,
    "work-dispatch-effect-" + kind + ":" + identity.dispatchId + ":" + scopeKey,
  );
}

function normalizedIds(value: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ID_LIST_ITEMS) fail("invalid_input", `${field} is invalid`);
  const unique = new Set<string>();
  for (const [index, item] of value.entries()) {
    const id = boundedString(item, `${field}[${index}]`);
    if (unique.has(id)) fail("invalid_input", `${field} contains a duplicate`);
    unique.add(id);
  }
  return Object.freeze([...unique].sort(compareUtf8));
}

function normalizedPhasePlan(value: WorkPhasePlanAuthorityV1, field = "phasePlan"): WorkPhasePlanAuthorityV1 {
  if (!value || value.version !== 1 || !Array.isArray(value.phases) || value.phases.length > MAX_ORDINAL) {
    fail("invalid_input", field + " is invalid");
  }
  const ids = new Set<string>();
  value.phases.forEach((phase, index) => {
    if (!phase || typeof phase !== "object" || phase.index !== index || typeof phase.required !== "boolean") {
      fail("invalid_input", field + " phase order is invalid");
    }
    const id = boundedString(phase.id, field + ".phases[" + index + "].id");
    if (ids.has(id)) fail("invalid_input", field + " contains a duplicate phase id");
    ids.add(id);
  });
  const phases = value.phases.map((phase, index) => {
    const id = boundedString(phase.id, field + ".phases[" + index + "].id");
    const nextPhaseIds = normalizedIds(phase.nextPhaseIds, field + ".phases[" + index + "].nextPhaseIds");
    if (nextPhaseIds.some((nextId) => !ids.has(nextId))) fail("invalid_input", field + " references an unknown next phase");
    const repeatLimit = safeInteger(phase.repeatLimit, field + ".phases[" + index + "].repeatLimit", MAX_ORDINAL);
    const transitionAuthorityDigest = boundedString(phase.transitionAuthorityDigest, field + ".phases[" + index + "].transitionAuthorityDigest");
    const skipEligibilityDigest = phase.skipEligibilityDigest === null
      ? null
      : boundedString(phase.skipEligibilityDigest, field + ".phases[" + index + "].skipEligibilityDigest");
    if (!/^[0-9a-f]{64}$/.test(transitionAuthorityDigest) || (skipEligibilityDigest !== null && !/^[0-9a-f]{64}$/.test(skipEligibilityDigest))) {
      fail("invalid_input", field + " contains an invalid authority digest");
    }
    return Object.freeze({ id, index, required: phase.required, nextPhaseIds, repeatLimit, transitionAuthorityDigest, skipEligibilityDigest });
  });
  return Object.freeze({ version: 1, phases: Object.freeze(phases) });
}

function phasePlanFromRow(row: Row): WorkPhasePlanAuthorityV1 {
  try {
    return normalizedPhasePlan(JSON.parse(stringFrom(row, "phase_plan_json")) as WorkPhasePlanAuthorityV1);
  } catch {
    fail("integrity_error", "phase_plan_json is corrupt");
  }
}

function normalizedAllOptionalPhasesSkippedAuthorityV1(
  value: WorkSegmentAllOptionalPhasesSkippedAuthorityV1 | undefined,
  field: string,
): WorkSegmentAllOptionalPhasesSkippedAuthorityV1 | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1
    || value.kind !== "all_authored_optional_phases_skipped"
    || !Array.isArray(value.skippedPhaseIds)
    || !Array.isArray(value.decisions)
    || value.skippedPhaseIds.length === 0
    || value.skippedPhaseIds.length > MAX_ID_LIST_ITEMS
    || value.decisions.length !== value.skippedPhaseIds.length) {
    fail("invalid_input", field + " is invalid");
  }
  const seenPhaseIds = new Set<string>();
  const decisions = value.decisions.map((decision, index): WorkSegmentSkippedPhaseDecisionAuthorityV1 => {
    if (!decision || typeof decision !== "object" || Array.isArray(decision)
      || (decision.checkpoint !== "entry" && decision.checkpoint !== "skip")
      || (decision.condition !== "true" && decision.condition !== "false")
      || (decision.checkpoint === "entry" ? decision.condition !== "false" : decision.condition !== "true")) {
      fail("invalid_input", field + ".decisions[" + index + "] is invalid");
    }
    const skippedPhaseId = boundedString(value.skippedPhaseIds[index], field + ".skippedPhaseIds[" + index + "]");
    const phaseId = boundedString(decision.phaseId, field + ".decisions[" + index + "].phaseId");
    const phaseIndex = safeInteger(decision.phaseIndex, field + ".decisions[" + index + "].phaseIndex", MAX_ORDINAL);
    const revision = safeInteger(decision.revision, field + ".decisions[" + index + "].revision");
    const phaseAuthorityDigest = digest(
      decision.phaseAuthorityDigest,
      field + ".decisions[" + index + "].phaseAuthorityDigest",
    );
    const evaluationDigest = digest(decision.evaluationDigest, field + ".decisions[" + index + "].evaluationDigest");
    if (skippedPhaseId !== phaseId || phaseIndex !== index || seenPhaseIds.has(phaseId)) {
      fail("invalid_input", field + " phase order is invalid");
    }
    seenPhaseIds.add(phaseId);
    const withoutDigest: Omit<WorkSegmentSkippedPhaseDecisionAuthorityV1, "evaluationDigest"> = Object.freeze({
      phaseId,
      phaseIndex,
      checkpoint: decision.checkpoint,
      revision,
      condition: decision.condition,
      phaseAuthorityDigest,
    });
    if (evaluationDigest !== canonicalDigest(Object.freeze({ version: 1, ...withoutDigest }))) {
      fail("invalid_input", field + " evaluation digest does not match its exact payload");
    }
    return Object.freeze({ ...withoutDigest, evaluationDigest });
  });
  const withoutDigest: Omit<WorkSegmentAllOptionalPhasesSkippedAuthorityV1, "authorityDigest"> = Object.freeze({
    version: 1,
    kind: "all_authored_optional_phases_skipped",
    skippedPhaseIds: Object.freeze(decisions.map((decision) => decision.phaseId)),
    decisions: Object.freeze(decisions),
  });
  const authorityDigest = digest(value.authorityDigest, field + ".authorityDigest");
  if (authorityDigest !== canonicalDigest(withoutDigest)) {
    fail("invalid_input", field + " aggregate digest does not match its exact payload");
  }
  const normalized = Object.freeze({ ...withoutDigest, authorityDigest });
  if (encodeCanonicalPlainData(value) !== encodeCanonicalPlainData(normalized)) {
    fail("invalid_input", field + " contains unsupported authority data");
  }
  return normalized;
}

function normalizedSegmentContext(value: WorkSegmentContextV1, field = "context"): WorkSegmentContextV1 {
  if (!value || typeof value !== "object" || value.version !== 1) fail("invalid_input", field + " is invalid");
  const contextDigest = digest(value.contextDigest, field + ".contextDigest");
  digest(value.bindingDigest, field + ".bindingDigest");
  digest(value.resumeEnvelopeDigest, field + ".resumeEnvelopeDigest");
  digest(value.phasePlanDigest, field + ".phasePlanDigest");
  digest(value.protocolDigest, field + ".protocolDigest");
  digest(value.capabilityDigest, field + ".capabilityDigest");
  digest(value.phaseCapabilityDigest, field + ".phaseCapabilityDigest");
  boundedString(value.rootObjective, field + ".rootObjective", MAX_CANONICAL_BYTES);
  boundedString(value.rootSnapshotId, field + ".rootSnapshotId");
  digest(value.rootSnapshotDigest, field + ".rootSnapshotDigest");
  if (!value.phase || typeof value.phase !== "object" || !value.workspace || typeof value.workspace !== "object") {
    fail("invalid_input", field + " authority is incomplete");
  }
  normalizedNullablePhaseId(value.phase.id, field + ".phase.id");
  safeInteger(value.phase.index, field + ".phase.index", MAX_ORDINAL);
  safeInteger(value.phase.occurrence, field + ".phase.occurrence", MAX_ORDINAL);
  if (!Array.isArray(value.phase.instructions) || !Array.isArray(value.phase.completionCriteria)
    || !Array.isArray(value.phase.admittedCapabilities) || !Array.isArray(value.workspace.acceptedRecords)
    || !Array.isArray(value.workspace.openRequiredIds)) fail("invalid_input", field + " collections are invalid");
  boundedString(value.workspace.id, field + ".workspace.id");
  safeInteger(value.workspace.revision, field + ".workspace.revision");
  normalizedAllOptionalPhasesSkippedAuthorityV1(
    value.allOptionalPhasesSkippedAuthority,
    field + ".allOptionalPhasesSkippedAuthority",
  );
  normalizedAttemptBudget(value.attemptBudget);
  normalizedSegmentBudget(value.segmentBudget);
  if (!value.protocol || value.protocol.completeTurnCallMode !== "standalone_only"
    || typeof value.protocol.requiredToolModeAvailable !== "boolean") fail("invalid_input", field + ".protocol is invalid");
  const { contextDigest: _omitted, ...withoutDigest } = value;
  if (canonicalDigest(withoutDigest) !== contextDigest) fail("invalid_input", field + " digest does not match its exact payload");
  const encoded = encodeCanonicalPlainData(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_CANONICAL_BYTES) fail("invalid_input", field + " exceeds the durable bound");
  return Object.freeze(JSON.parse(encoded) as WorkSegmentContextV1);
}

function assertAtomicSegmentSkipAuthorityV1(
  context: WorkSegmentContextV1,
  phasePlan: WorkPhasePlanAuthorityV1,
  sourceTransitionId: string | null,
  segmentOrdinal: number,
): void {
  const authority = context.allOptionalPhasesSkippedAuthority;
  if (context.phase.id !== null || phasePlan.phases.length === 0) {
    if (authority !== undefined) {
      fail("invalid_input", "skip authority is forbidden outside an authored initial null phase");
    }
    return;
  }
  if (sourceTransitionId !== null
    || segmentOrdinal !== 0
    || context.phase.index !== 0
    || context.phase.occurrence !== 0
    || context.previousHandoff !== null
    || phasePlan.phases.some((phase) => phase.required)
    || authority === undefined) {
    fail("invalid_input", "authored null-phase admission lacks all-optional skip authority");
  }
  if (authority.skippedPhaseIds.length !== phasePlan.phases.length
    || authority.decisions.length !== phasePlan.phases.length) {
    fail("invalid_input", "all-optional skip authority does not cover the exact phase plan");
  }
  const decisions = phasePlan.phases.map((phase, index) => {
    const decision = authority.decisions[index]!;
    const checkpoint = decision.checkpoint;
    const condition = decision.condition;
    const revision = safeInteger(decision.revision, "skipAuthority.decisions[" + index + "].revision");
    const expectedPhaseAuthority = checkpoint === "skip"
      ? phase.skipEligibilityDigest
      : phase.transitionAuthorityDigest;
    if (authority.skippedPhaseIds[index] !== phase.id
      || decision.phaseId !== phase.id
      || decision.phaseIndex !== phase.index
      || revision !== context.workspace.revision
      || (checkpoint === "entry" ? condition !== "false" : condition !== "true")
      || expectedPhaseAuthority === null
      || decision.phaseAuthorityDigest !== expectedPhaseAuthority) {
      fail("invalid_input", "all-optional skip decision does not match frozen phase authority");
    }
    const withoutDigest: Omit<WorkSegmentSkippedPhaseDecisionAuthorityV1, "evaluationDigest"> = Object.freeze({
      phaseId: phase.id,
      phaseIndex: phase.index,
      checkpoint,
      revision,
      condition,
      phaseAuthorityDigest: expectedPhaseAuthority,
    });
    if (decision.evaluationDigest !== canonicalDigest(Object.freeze({ version: 1, ...withoutDigest }))) {
      fail("invalid_input", "all-optional skip evaluation digest changed");
    }
    return Object.freeze({ ...withoutDigest, evaluationDigest: decision.evaluationDigest });
  });
  const normalized: Omit<WorkSegmentAllOptionalPhasesSkippedAuthorityV1, "authorityDigest"> = Object.freeze({
    version: 1,
    kind: "all_authored_optional_phases_skipped",
    skippedPhaseIds: Object.freeze(phasePlan.phases.map((phase) => phase.id)),
    decisions: Object.freeze(decisions),
  });
  if (authority.authorityDigest !== canonicalDigest(normalized)) {
    fail("invalid_input", "all-optional skip aggregate digest changed");
  }
}

export function computeWorkSegmentResumeEnvelopeDigestV1(
  value: Omit<WorkSegmentResumeEnvelopeV1, "envelopeDigest">,
): string {
  return canonicalDigest(value, MAX_RESUME_ENVELOPE_BYTES);
}

const FORBIDDEN_RESUME_AUTHORITY_KEYS = new Set([
  "apikey", "authorization", "carrier", "credential", "credentialcarrier",
  "owner", "ownertoken", "password", "providertransientcarrier", "secret", "signal", "token",
]);

function normalizedResumeAuthorityRecord(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_input", field + " must be a canonical record");
  }
  let encoded: string;
  try {
    encoded = encodeCanonicalPlainData(value, { maxBytes: MAX_RESUME_ENVELOPE_BYTES });
  } catch {
    fail("invalid_input", field + " is not bounded canonical data");
  }
  const normalized = JSON.parse(encoded) as Readonly<Record<string, unknown>>;
  const pending: unknown[] = [normalized];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      const normalizedKey = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
      if (FORBIDDEN_RESUME_AUTHORITY_KEYS.has(normalizedKey)) {
        fail("invalid_input", field + " contains secret or ephemeral runtime authority");
      }
      pending.push(child);
    }
  }
  return Object.freeze(normalized);
}

function normalizedResumeEnvelope(value: WorkSegmentResumeEnvelopeV1, field = "resumeEnvelope"): WorkSegmentResumeEnvelopeV1 {
  if (!value || typeof value !== "object" || value.version !== 1) fail("invalid_input", field + " is invalid");
  const envelopeDigest = digest(value.envelopeDigest, field + ".envelopeDigest");
  digest(value.snapshotDigest, field + ".snapshotDigest");
  digest(value.planDigest, field + ".planDigest");
  digest(value.toolCatalogDigest, field + ".toolCatalogDigest");
  safeInteger(value.toolCatalogSchemaVersion, field + ".toolCatalogSchemaVersion", MAX_COUNTER, 1);
  if (!value.snapshot || !value.plan || !value.rootConnection || !value.runtime
    || !value.resumeInput || !value.decisionAuthority || !value.liveTargetBinding
    || !Array.isArray(value.authoredRootToolIds) || !value.authoredChildToolIds || !value.childConnections) {
    fail("invalid_input", field + " authority is incomplete");
  }
  normalizedResumeAuthorityRecord(value.resumeInput, field + ".resumeInput");
  const decisionAuthority = normalizedResumeAuthorityRecord(value.decisionAuthority, field + ".decisionAuthority");
  normalizedResumeAuthorityRecord(value.liveTargetBinding, field + ".liveTargetBinding");
  if (Object.hasOwn(decisionAuthority, "rootConnection") || Object.hasOwn(decisionAuthority, "childConnections")) {
    fail("invalid_input", field + ".decisionAuthority duplicates frozen connection authority");
  }
  const ownerLimits = normalizedResumeAuthorityRecord(value.runtime.ownerLimits, field + ".runtime.ownerLimits");
  for (const [key, limit] of Object.entries(ownerLimits)) safeInteger(limit, field + ".runtime.ownerLimits." + key);
  safeInteger(value.runtime.deadlineAt, field + ".runtime.deadlineAt", MAX_SAFE_INTEGER, 1);
  boundedString(value.runtime.rootFrameId, field + ".runtime.rootFrameId");
  boundedString(value.runtime.workspaceId, field + ".runtime.workspaceId");
  safeInteger(value.runtime.workspaceRevision, field + ".runtime.workspaceRevision");
  if (!(value.runtime.workspaceRetention === "turn_terminal" || value.runtime.workspaceRetention === "chat_lifetime")
    || !(value.runtime.workspaceSharing === "root_only" || value.runtime.workspaceSharing === "view_only")) {
    fail("invalid_input", field + ".runtime workspace policy is invalid");
  }
  const { envelopeDigest: _omitted, ...withoutDigest } = value;
  if (canonicalDigest(withoutDigest, MAX_RESUME_ENVELOPE_BYTES) !== envelopeDigest) fail("invalid_input", field + " digest does not match its exact payload");
  let encoded: string;
  try {
    encoded = encodeCanonicalPlainData(value, { maxBytes: MAX_RESUME_ENVELOPE_BYTES });
  } catch {
    fail("invalid_input", field + " exceeds the durable canonical bound");
  }
  return Object.freeze(JSON.parse(encoded) as WorkSegmentResumeEnvelopeV1);
}

function resumeEnvelopeFromRow(row: Row): WorkSegmentResumeEnvelopeV1 {
  try {
    return normalizedResumeEnvelope(JSON.parse(stringFrom(row, "resume_envelope_json")) as WorkSegmentResumeEnvelopeV1, "resume_envelope_json");
  } catch {
    fail("integrity_error", "resume envelope is corrupt or unsupported");
  }
}

function segmentContextFromRow(row: Row): WorkSegmentContextV1 {
  try {
    return normalizedSegmentContext(JSON.parse(stringFrom(row, "context_json")) as WorkSegmentContextV1, "context_json");
  } catch {
    fail("integrity_error", "context_json is corrupt or unsupported");
  }
}

function normalizedNullablePhaseId(value: unknown, field: string): string | null {
  return value === null ? null : boundedString(value, field);
}

export function computeWorkPhasePlanDigestV1(value: WorkPhasePlanAuthorityV1): string {
  return canonicalDigest(normalizedPhasePlan(value));
}
export function computeWorkTransitionDecisionDigestV1(input: Readonly<{
  phasePlanDigest: string;
  source: WorkSegmentIdentityV1;
  transitionKind: WorkSegmentTransitionKindV1;
  targetPhaseId: string | null;
  targetPhaseIndex: number | null;
  targetPhaseOccurrence: number | null;
  targetSegmentOrdinal: number | null;
}>): string {
  return canonicalDigest(Object.freeze({ version: 1, ...input }));
}

function normalizedSegmentUsage(value: WorkSegmentUsageV1, field = "usage"): WorkSegmentUsageV1 {
  const normalized = Object.freeze({
    providerDispatches: safeInteger(value.providerDispatches, `${field}.providerDispatches`, MAX_COUNTER),
    providerInputTokens: safeInteger(value.providerInputTokens, `${field}.providerInputTokens`),
    providerOutputTokens: safeInteger(value.providerOutputTokens, `${field}.providerOutputTokens`, MAX_COUNTER),
    providerTotalTokens: safeInteger(value.providerTotalTokens, `${field}.providerTotalTokens`),
    billedOutputTokens: safeInteger(value.billedOutputTokens, `${field}.billedOutputTokens`, MAX_COUNTER),
    toolCalls: safeInteger(value.toolCalls, `${field}.toolCalls`, MAX_COUNTER),
    workspaceOperations: safeInteger(value.workspaceOperations, `${field}.workspaceOperations`, MAX_COUNTER),
    unsignedBoundaries: safeInteger(value.unsignedBoundaries, `${field}.unsignedBoundaries`, MAX_COUNTER),
    receiveBytes: safeInteger(value.receiveBytes, `${field}.receiveBytes`),
    publishedOutputBytes: safeInteger(value.publishedOutputBytes, `${field}.publishedOutputBytes`),
  });
  if (
    normalized.providerTotalTokens < normalized.providerInputTokens
    || normalized.providerTotalTokens < normalized.providerOutputTokens
    || normalized.billedOutputTokens < normalized.providerOutputTokens
  ) fail("invalid_input", `${field} token totals are inconsistent`);
  return normalized;
}

function normalizedAttemptBudget(value: WorkAttemptBudgetV1): WorkAttemptBudgetV1 {
  const normalized = Object.freeze({
    maxSegments: safeInteger(value.maxSegments, "budget.maxSegments", MAX_ORDINAL, 1),
    maxProviderDispatches: safeInteger(value.maxProviderDispatches, "budget.maxProviderDispatches", MAX_COUNTER, 1),
    maxProviderOutputTokens: safeInteger(value.maxProviderOutputTokens, "budget.maxProviderOutputTokens", MAX_COUNTER, 1),
    maxOutputTokensPerDispatch: safeInteger(value.maxOutputTokensPerDispatch, "budget.maxOutputTokensPerDispatch", MAX_COUNTER, 1),
    maxUnsignedBoundaries: safeInteger(value.maxUnsignedBoundaries, "budget.maxUnsignedBoundaries", MAX_COUNTER),
    maxToolCalls: safeInteger(value.maxToolCalls, "budget.maxToolCalls", MAX_COUNTER),
    maxWorkspaceOperations: safeInteger(value.maxWorkspaceOperations, "budget.maxWorkspaceOperations", MAX_COUNTER),
    recoveryReserveOutputTokens: safeInteger(value.recoveryReserveOutputTokens, "budget.recoveryReserveOutputTokens", MAX_COUNTER),
    futurePhaseReserveOutputTokens: safeInteger(value.futurePhaseReserveOutputTokens, "budget.futurePhaseReserveOutputTokens", MAX_COUNTER),
  });
  if (normalized.recoveryReserveOutputTokens + normalized.futurePhaseReserveOutputTokens > normalized.maxProviderOutputTokens) {
    fail("invalid_input", "attempt output reserves exceed the output budget");
  }
  if (normalized.maxOutputTokensPerDispatch > normalized.maxProviderOutputTokens) {
    fail("invalid_input", "per-dispatch output cap exceeds the attempt output budget");
  }
  return normalized;
}

function normalizedSegmentBudget(value: WorkSegmentBudgetV1): WorkSegmentBudgetV1 {
  const normalized = Object.freeze({
    maxProviderDispatches: safeInteger(value.maxProviderDispatches, "segmentBudget.maxProviderDispatches", MAX_COUNTER, 1),
    maxProviderOutputTokens: safeInteger(value.maxProviderOutputTokens, "segmentBudget.maxProviderOutputTokens", MAX_COUNTER, 1),
    maxOutputTokensPerDispatch: safeInteger(value.maxOutputTokensPerDispatch, "segmentBudget.maxOutputTokensPerDispatch", MAX_COUNTER, 1),
    maxUnsignedBoundaries: safeInteger(value.maxUnsignedBoundaries, "segmentBudget.maxUnsignedBoundaries", MAX_COUNTER),
    maxToolCalls: safeInteger(value.maxToolCalls, "segmentBudget.maxToolCalls", MAX_COUNTER),
    maxWorkspaceOperations: safeInteger(value.maxWorkspaceOperations, "segmentBudget.maxWorkspaceOperations", MAX_COUNTER),
  });
  if (normalized.maxOutputTokensPerDispatch > normalized.maxProviderOutputTokens) {
    fail("invalid_input", "per-dispatch output cap exceeds the segment output budget");
  }
  return normalized;
}

function zeroUsage(): WorkSegmentUsageV1 {
  return Object.freeze({
    providerDispatches: 0,
    providerInputTokens: 0,
    providerOutputTokens: 0,
    providerTotalTokens: 0,
    billedOutputTokens: 0,
    toolCalls: 0,
    workspaceOperations: 0,
    unsignedBoundaries: 0,
    receiveBytes: 0,
    publishedOutputBytes: 0,
  });
}

function addUsage(left: WorkSegmentUsageV1, right: WorkSegmentUsageV1): WorkSegmentUsageV1 {
  const sum = (a: number, b: number, field: string): number => safeInteger(a + b, field);
  return normalizedSegmentUsage({
    providerDispatches: sum(left.providerDispatches, right.providerDispatches, "usage.providerDispatches"),
    providerInputTokens: sum(left.providerInputTokens, right.providerInputTokens, "usage.providerInputTokens"),
    providerOutputTokens: sum(left.providerOutputTokens, right.providerOutputTokens, "usage.providerOutputTokens"),
    providerTotalTokens: sum(left.providerTotalTokens, right.providerTotalTokens, "usage.providerTotalTokens"),
    billedOutputTokens: sum(left.billedOutputTokens, right.billedOutputTokens, "usage.billedOutputTokens"),
    toolCalls: sum(left.toolCalls, right.toolCalls, "usage.toolCalls"),
    workspaceOperations: sum(left.workspaceOperations, right.workspaceOperations, "usage.workspaceOperations"),
    unsignedBoundaries: sum(left.unsignedBoundaries, right.unsignedBoundaries, "usage.unsignedBoundaries"),
    receiveBytes: sum(left.receiveBytes, right.receiveBytes, "usage.receiveBytes"),
    publishedOutputBytes: sum(left.publishedOutputBytes, right.publishedOutputBytes, "usage.publishedOutputBytes"),
  });
}

function normalizedWorkspaceMutations(
  value: readonly AgenticWorkWorkspaceMutationReservationV1[],
  field = "workspaceMutations",
): readonly AgenticWorkWorkspaceMutationReservationV1[] {
  if (!Array.isArray(value) || value.length > MAX_ID_LIST_ITEMS) fail("invalid_input", field + " is invalid");
  const operationKeys = new Set<string>();
  return Object.freeze(value.map((mutation, index) => {
    if (!mutation || typeof mutation !== "object" || mutation.version !== 1) {
      fail("invalid_input", field + "[" + index + "] is invalid");
    }
    const operationKey = boundedString(mutation.operationKey, field + "[" + index + "].operationKey");
    if (operationKeys.has(operationKey)) fail("idempotency_conflict", field + " contains a duplicate operation key");
    operationKeys.add(operationKey);
    if (!MUTATING_WORKSPACE_OPERATIONS.has(mutation.operationKind)) {
      fail("invalid_input", field + " contains a non-mutating or unknown operation kind");
    }
    return Object.freeze({
      version: 1 as const,
      operationKey,
      operationKind: mutation.operationKind,
      segmentId: id(mutation.segmentId, field + "[" + index + "].segmentId"),
      logicalDispatch: safeInteger(
        mutation.logicalDispatch,
        field + "[" + index + "].logicalDispatch",
        MAX_COUNTER,
      ),
      frameId: id(mutation.frameId, field + "[" + index + "].frameId"),
    });
  }));
}
function durableWorkspaceMutations(
  value: readonly AgenticWorkWorkspaceMutationReservationV1[],
): readonly DurableWorkspaceMutationReservationV1[] {
  return Object.freeze(normalizedWorkspaceMutations(value).map((mutation) => Object.freeze({
    ...mutation,
    attemptedOperationDigest: canonicalDigest({
      version: 1,
      operationKey: mutation.operationKey,
      operationKind: mutation.operationKind,
      segmentId: mutation.segmentId,
      logicalDispatch: mutation.logicalDispatch,
      frameId: mutation.frameId,
    }),
  })));
}

function dispatchMutationReservationPayload(
  input: Omit<DispatchMutationReservationPayloadV1, "mutations" | "reservationDigest"> & {
    readonly mutations: readonly AgenticWorkWorkspaceMutationReservationV1[];
  },
): Readonly<{ payload: DispatchMutationReservationPayloadV1; encoded: ReturnType<typeof canonicalEffectPayload> }> {
  const withoutDigest = Object.freeze({ ...input, mutations: durableWorkspaceMutations(input.mutations) });
  const reservationDigest = canonicalEffectPayload(withoutDigest).digest;
  const payload = Object.freeze({ ...withoutDigest, reservationDigest });
  return Object.freeze({ payload, encoded: canonicalEffectPayload(payload) });
}

function readDispatchMutationReservationPayload(
  db: Database,
  expected: Readonly<{ userId: string; executionId: string; dispatchId: string }>,
): DispatchMutationReservationPayloadV1 | null {
  const raw = rawDispatchEffectPayload(
    db,
    dispatchEffectRecordId("reservation", expected.userId, expected.executionId, expected.dispatchId),
  );
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") fail("integrity_error", "dispatch mutation reservation is corrupt");
  const value = raw as Partial<DispatchMutationReservationPayloadV1>;
  if (
    value.version !== 1
    || value.kind !== "work_dispatch_mutation_reservation"
    || value.userId !== expected.userId
    || value.executionId !== expected.executionId
    || value.dispatchId !== expected.dispatchId
    || !Array.isArray(value.mutations)
  ) fail("integrity_error", "dispatch mutation reservation identity is corrupt");
  const mutations = durableWorkspaceMutations(value.mutations);
  value.mutations.forEach((mutation, index) => {
    if (mutation.attemptedOperationDigest !== mutations[index]?.attemptedOperationDigest) {
      fail("integrity_error", "dispatch mutation reservation digest is corrupt");
    }
  });
  const payloadWithoutDigest = Object.freeze({
    version: 1 as const,
    kind: "work_dispatch_mutation_reservation" as const,
    userId: id(value.userId, "reservation.userId"),
    executionId: id(value.executionId, "reservation.executionId"),
    attemptId: id(value.attemptId, "reservation.attemptId"),
    workspaceId: id(value.workspaceId, "reservation.workspaceId"),
    segmentId: id(value.segmentId, "reservation.segmentId"),
    dispatchId: id(value.dispatchId, "reservation.dispatchId"),
    fenceGeneration: safeInteger(value.fenceGeneration, "reservation.fenceGeneration", MAX_COUNTER, 1),
    settlementKey: id(value.settlementKey, "reservation.settlementKey"),
    providerSettlementDigest: digest(value.providerSettlementDigest, "reservation.providerSettlementDigest"),
    baseWorkspaceRevision: safeInteger(value.baseWorkspaceRevision, "reservation.baseWorkspaceRevision"),
    mutations,
  });
  const reservationDigest = digest(value.reservationDigest, "reservation.reservationDigest");
  if (canonicalEffectPayload(payloadWithoutDigest).digest !== reservationDigest) {
    fail("integrity_error", "dispatch mutation reservation payload is corrupt");
  }
  return Object.freeze({ ...payloadWithoutDigest, reservationDigest });
}

function normalizedWorkspaceMutationOwner(
  value: WorkSegmentWorkspaceMutationOwnerV1,
  field = "owner",
): WorkSegmentWorkspaceMutationOwnerV1 {
  return Object.freeze({
    segmentId: id(value.segmentId, field + ".segmentId"),
    logicalDispatch: safeInteger(value.logicalDispatch, field + ".logicalDispatch", MAX_COUNTER),
    frameId: id(value.frameId, field + ".frameId"),
  });
}

function workspaceMutationOwnerKey(owner: WorkSegmentWorkspaceMutationOwnerV1): string {
  return canonicalDigest(Object.freeze({ version: 1, ...normalizedWorkspaceMutationOwner(owner) }));
}

function dispatchMutationReservationAppendPayload(
  input: Omit<DispatchMutationReservationAppendPayloadV1, "mutations" | "appendDigest"> & {
    readonly mutations: readonly AgenticWorkWorkspaceMutationReservationV1[];
  },
): Readonly<{
  payload: DispatchMutationReservationAppendPayloadV1;
  encoded: ReturnType<typeof canonicalEffectPayload>;
}> {
  const withoutDigest = Object.freeze({
    ...input,
    owner: normalizedWorkspaceMutationOwner(input.owner),
    mutations: durableWorkspaceMutations(input.mutations),
  });
  const appendDigest = canonicalEffectPayload(withoutDigest).digest;
  const payload = Object.freeze({ ...withoutDigest, appendDigest });
  return Object.freeze({ payload, encoded: canonicalEffectPayload(payload) });
}

function dispatchChildAssignmentAuthorityPayload(
  input: Omit<DispatchChildAssignmentAuthorityPayloadV1, "assignmentReservation" | "assignments" | "authorityDigest"> & Readonly<{
    assignmentReservation: AgenticWorkWorkspaceMutationReservationV1;
    assignments: readonly Readonly<{
      taskId: string;
      frameId: string;
      settlementReservation: AgenticWorkWorkspaceMutationReservationV1;
    }>[];
  }>,
): Readonly<{ payload: DispatchChildAssignmentAuthorityPayloadV1; encoded: ReturnType<typeof canonicalEffectPayload> }> {
  if (!Array.isArray(input.assignments)
    || input.assignments.length === 0
    || input.assignments.length > MAX_ID_LIST_ITEMS) {
    fail("invalid_input", "child assignment authority must contain a bounded non-empty assignment set");
  }
  const assignmentReservation = durableWorkspaceMutations([input.assignmentReservation])[0]!;
  if (assignmentReservation.operationKind !== "assign_child_tasks") {
    fail("invalid_input", "child assignment authority lacks its assignment reservation");
  }
  const taskIds = new Set<string>();
  const frameIds = new Set<string>();
  const operationKeys = new Set<string>([assignmentReservation.operationKey]);
  const assignments = Object.freeze(input.assignments.map((item, index) => {
    const taskId = id(item.taskId, "assignments[" + index + "].taskId");
    const frameId = id(item.frameId, "assignments[" + index + "].frameId");
    const settlementReservation = durableWorkspaceMutations([item.settlementReservation])[0]!;
    if (settlementReservation.operationKind !== "settle_child_task"
      || settlementReservation.frameId !== assignmentReservation.frameId
      || settlementReservation.segmentId !== assignmentReservation.segmentId
      || settlementReservation.logicalDispatch !== assignmentReservation.logicalDispatch
      || taskIds.has(taskId)
      || frameIds.has(frameId)
      || operationKeys.has(settlementReservation.operationKey)) {
      fail("invalid_input", "child assignment authority contains conflicting task, frame, or settlement authority");
    }
    taskIds.add(taskId);
    frameIds.add(frameId);
    operationKeys.add(settlementReservation.operationKey);
    return Object.freeze({ taskId, frameId, settlementReservation });
  }));
  const withoutDigest = Object.freeze({
    ...input,
    assignmentReservation,
    assignments,
  });
  const authorityDigest = canonicalEffectPayload(withoutDigest).digest;
  const payload = Object.freeze({ ...withoutDigest, authorityDigest });
  return Object.freeze({ payload, encoded: canonicalEffectPayload(payload) });
}

function rawScopedDispatchEffectPayloads(
  db: Database,
  userId: string,
  attemptId: string,
  dispatchId: string,
): readonly unknown[] {
  return db.query(
    "SELECT payload_json FROM agent_run_audit_records "
      + "WHERE user_id = ? AND attempt_id = ? AND event_id = ? AND record_kind = 'recovery'",
  ).all(userId, attemptId, dispatchId).map((row) => {
    try {
      return JSON.parse(stringFrom(row as Row, "payload_json")) as unknown;
    } catch {
      fail("integrity_error", "scoped dispatch effect payload is corrupt");
    }
  });
}

function readDispatchChildAssignmentAuthority(
  db: Database,
  base: DispatchMutationReservationPayloadV1,
): DispatchChildAssignmentAuthorityPayloadV1 | null {
  const records = rawScopedDispatchEffectPayloads(db, base.userId, base.attemptId, base.dispatchId)
    .filter((raw): raw is Partial<DispatchChildAssignmentAuthorityPayloadV1> => (
      !!raw && typeof raw === "object"
      && (raw as Partial<DispatchChildAssignmentAuthorityPayloadV1>).kind
        === "work_dispatch_child_assignment_authority"
    ));
  if (records.length > 1) fail("integrity_error", "dispatch has multiple child assignment authorities");
  const value = records[0];
  if (!value) return null;
  if (value.version !== 1
    || value.userId !== base.userId
    || value.executionId !== base.executionId
    || value.attemptId !== base.attemptId
    || value.workspaceId !== base.workspaceId
    || value.segmentId !== base.segmentId
    || value.dispatchId !== base.dispatchId
    || value.fenceGeneration !== base.fenceGeneration
    || value.providerSettlementDigest !== base.providerSettlementDigest
    || !value.assignmentReservation
    || !Array.isArray(value.assignments)) {
    fail("integrity_error", "dispatch child assignment authority identity is corrupt");
  }
  const rebuilt = dispatchChildAssignmentAuthorityPayload({
    version: 1,
    kind: "work_dispatch_child_assignment_authority",
    userId: base.userId,
    executionId: base.executionId,
    attemptId: base.attemptId,
    workspaceId: base.workspaceId,
    segmentId: base.segmentId,
    dispatchId: base.dispatchId,
    fenceGeneration: base.fenceGeneration,
    providerSettlementDigest: base.providerSettlementDigest,
    assignmentReservation: value.assignmentReservation,
    assignments: value.assignments,
  }).payload;
  if (rebuilt.authorityDigest !== value.authorityDigest) {
    fail("integrity_error", "dispatch child assignment authority digest is corrupt");
  }
  return rebuilt;
}

function readDispatchMutationReservationAppends(
  db: Database,
  base: DispatchMutationReservationPayloadV1,
): readonly DispatchMutationReservationAppendPayloadV1[] {
  const appends = rawScopedDispatchEffectPayloads(db, base.userId, base.attemptId, base.dispatchId)
    .filter((raw): raw is Partial<DispatchMutationReservationAppendPayloadV1> => (
      !!raw && typeof raw === "object"
      && (raw as Partial<DispatchMutationReservationAppendPayloadV1>).kind
        === "work_dispatch_mutation_reservation_append"
    ))
    .map((value) => {
      if (
        value.version !== 1
        || value.userId !== base.userId
        || value.executionId !== base.executionId
        || value.attemptId !== base.attemptId
        || value.workspaceId !== base.workspaceId
        || value.segmentId !== base.segmentId
        || value.dispatchId !== base.dispatchId
        || value.fenceGeneration !== base.fenceGeneration
        || value.providerSettlementDigest !== base.providerSettlementDigest
        || !value.owner
        || !Array.isArray(value.mutations)
      ) fail("integrity_error", "dispatch mutation reservation append identity is corrupt");
      const rebuilt = dispatchMutationReservationAppendPayload({
        version: 1,
        kind: "work_dispatch_mutation_reservation_append",
        userId: base.userId,
        executionId: base.executionId,
        attemptId: base.attemptId,
        workspaceId: base.workspaceId,
        segmentId: base.segmentId,
        dispatchId: base.dispatchId,
        fenceGeneration: base.fenceGeneration,
        providerSettlementDigest: base.providerSettlementDigest,
        appendKey: id(value.appendKey, "append.appendKey"),
        appendOrdinal: safeInteger(value.appendOrdinal, "append.appendOrdinal", MAX_COUNTER),
        owner: normalizedWorkspaceMutationOwner(value.owner),
        mutations: value.mutations,
      }).payload;
      if (rebuilt.appendDigest !== value.appendDigest) {
        fail("integrity_error", "dispatch mutation reservation append digest is corrupt");
      }
      value.mutations.forEach((mutation, index) => {
        if (mutation.attemptedOperationDigest !== rebuilt.mutations[index]?.attemptedOperationDigest) {
          fail("integrity_error", "dispatch mutation reservation append operation digest is corrupt");
        }
      });
      return rebuilt;
    })
    .sort((left, right) => left.appendOrdinal - right.appendOrdinal);
  appends.forEach((append, index) => {
    if (append.appendOrdinal !== index) fail("integrity_error", "dispatch mutation reservation append order is corrupt");
  });
  return Object.freeze(appends);
}

function completeDispatchMutationReservationPayload(
  db: Database,
  base: DispatchMutationReservationPayloadV1,
): DispatchMutationReservationPayloadV1 {
  const appends = readDispatchMutationReservationAppends(db, base);
  if (appends.length === 0) return base;
  const mutations = Object.freeze([
    ...base.mutations,
    ...appends.flatMap((append) => append.mutations),
  ]);
  const operationKeys = new Set<string>();
  for (const mutation of mutations) {
    if (operationKeys.has(mutation.operationKey)) {
      fail("integrity_error", "dispatch reservation set contains a duplicate operation key");
    }
    operationKeys.add(mutation.operationKey);
  }
  const reservationDigest = canonicalDigest(Object.freeze({
    version: 1,
    kind: "work_dispatch_mutation_reservation_set",
    baseReservationDigest: base.reservationDigest,
    appendDigests: appends.map((append) => append.appendDigest),
  }));
  return Object.freeze({ ...base, mutations, reservationDigest });
}

function enforceSegmentBudget(usage: WorkSegmentUsageV1, budget: WorkSegmentBudgetV1): void {
  if (usage.unsignedBoundaries > budget.maxUnsignedBoundaries) {
    fail("unsigned_boundary_budget_exhausted", "segment unsigned-boundary ceiling is exhausted");
  }
  if (usage.providerDispatches > budget.maxProviderDispatches
    || usage.billedOutputTokens > budget.maxProviderOutputTokens
    || usage.toolCalls > budget.maxToolCalls
    || usage.workspaceOperations > budget.maxWorkspaceOperations) {
    fail("segment_budget_exhausted", "segment usage exceeds its independent budget");
  }
}

function enforceAttemptBudget(segments: number, usage: WorkSegmentUsageV1, budget: WorkAttemptBudgetV1): void {
  if (usage.unsignedBoundaries > budget.maxUnsignedBoundaries) {
    fail("unsigned_boundary_budget_exhausted", "attempt unsigned-boundary ceiling is exhausted");
  }
  if (segments > budget.maxSegments
    || usage.providerDispatches > budget.maxProviderDispatches
    || usage.billedOutputTokens > budget.maxProviderOutputTokens
    || usage.toolCalls > budget.maxToolCalls
    || usage.workspaceOperations > budget.maxWorkspaceOperations) {
    fail("attempt_budget_exhausted", "attempt usage exceeds its independent budget");
  }
}

function insertRow(db: Database, table: string, values: Readonly<Record<string, string | number | null>>): void {
  const columns = Object.keys(values);
  const placeholders = columns.map(() => "?").join(", ");
  db.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`).run(...Object.values(values));
}

function numberFrom(row: Row, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail("integrity_error", `${field} is corrupt`);
  return value;
}
function integerFrom(row: Row, field: string): number {
  const value = numberFrom(row, field);
  if (value < 0) fail("integrity_error", field + " is corrupt");
  return value;
}

function nullableNumberFrom(row: Row, field: string): number | null {
  return row[field] === null ? null : numberFrom(row, field);
}

function stringFrom(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string") fail("integrity_error", `${field} is corrupt`);
  return value;
}

function nullableStringFrom(row: Row, field: string): string | null {
  return row[field] === null ? null : stringFrom(row, field);
}

function idsFrom(row: Row, field: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(stringFrom(row, field));
  } catch {
    fail("integrity_error", field + " is corrupt");
  }
  if (!Array.isArray(value)) fail("integrity_error", field + " is corrupt");
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") fail("integrity_error", field + " contains a non-string ID");
    strings.push(item);
  }
  try {
    return normalizedIds(strings, field);
  } catch {
    fail("integrity_error", field + " is corrupt");
  }
}

function authority(
  db: Database,
  input: AuthorityInputV1,
  requireActiveLease: boolean,
  allowExecutionWorkspaceProjectionLag = false,
  allowFrozenWorkspace = false,
  allowCancellationTerminalClose = false,
): AuthorityRow {
  const userId = boundedString(input.userId, "userId");
  const executionId = boundedString(input.executionId, "executionId");
  const ownerToken = boundedString(input.ownerToken, "ownerToken");
  const expectedCas = safeInteger(input.expectedExecutionCasRevision, "expectedExecutionCasRevision");
  const expectedWorkspaceRevision = safeInteger(input.expectedWorkspaceRevision, "expectedWorkspaceRevision");
  const now = safeInteger(input.now, "now");
  const row = db.query(
    `SELECT e.user_id, e.id AS execution_id, e.chat_id, e.generation_id, e.mode,
            e.state AS execution_state, e.workspace_id AS execution_workspace_id,
            e.workspace_revision AS execution_workspace_revision, e.cas_revision,
            e.cas_owner, e.cas_expires_at, e.deadline_at, e.cancel_requested_at,
            w.workspace_id, w.revision AS workspace_revision, w.state AS workspace_state
       FROM agent_turn_executions AS e
       JOIN agent_turn_workspaces AS w
         ON w.user_id = e.user_id AND w.execution_id = e.id
      WHERE e.user_id = ? AND e.id = ?`,
  ).get(userId, executionId) as AuthorityRow | null;
  if (!row) fail("not_found", "execution workspace authority was not found");
  if (row.mode !== "agentic" || row.execution_state !== "WORK") fail("stale_execution", "execution is not in Agentic WORK");
  if (row.cas_revision !== expectedCas) fail("stale_execution", "execution CAS revision changed");
  if (row.cas_owner !== ownerToken) fail("stale_owner", "execution owner changed");
  const cancellationTerminalCloseAnchor = row.cancel_requested_at === null
    ? null
    : Math.max(row.deadline_at, row.cancel_requested_at);
  const cancellationTerminalCloseGrace = allowCancellationTerminalClose
    && cancellationTerminalCloseAnchor !== null
    && row.deadline_at > 0
    && now >= cancellationTerminalCloseAnchor
    && now - cancellationTerminalCloseAnchor <= WORK_CANCELLATION_TERMINAL_CLOSE_GRACE_MS;
  if (requireActiveLease && (row.cas_expires_at === null || row.cas_expires_at <= now)
    && !cancellationTerminalCloseGrace) {
    fail("stale_owner", "execution owner lease expired");
  }
  if (row.workspace_state !== "active" && !(allowFrozenWorkspace && row.workspace_state === "frozen")) {
    fail("stale_workspace", "workspace is not active");
  }
  if (
    row.execution_workspace_id !== row.workspace_id
    || row.workspace_revision !== expectedWorkspaceRevision
    || (
      allowExecutionWorkspaceProjectionLag
        ? row.execution_workspace_revision > expectedWorkspaceRevision
        : row.execution_workspace_revision !== expectedWorkspaceRevision
    )
  ) fail("stale_workspace", "workspace revision changed");
  return Object.freeze({ ...row, cancellation_terminal_close_grace: cancellationTerminalCloseGrace });
}

function requireAttemptAuthority(db: Database, authorityRow: AuthorityRow, attemptId: string): void {
  const row = db.query(
    `SELECT user_id, chat_id, attempt_id, turn_id, generation_id
       FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?`,
  ).get(authorityRow.user_id, attemptId) as Row | null;
  if (
    !row
    || row.chat_id !== authorityRow.chat_id
    || row.turn_id !== authorityRow.execution_id
    || row.generation_id !== authorityRow.generation_id
  ) fail("stale_execution", "inspection attempt does not match the execution");
}

function attemptBudgetFrom(row: Row): WorkAttemptBudgetV1 {
  return Object.freeze({
    maxSegments: numberFrom(row, "max_segments"),
    maxProviderDispatches: numberFrom(row, "max_provider_dispatches"),
    maxProviderOutputTokens: numberFrom(row, "max_provider_output_tokens"),
    maxOutputTokensPerDispatch: numberFrom(row, "max_output_tokens_per_dispatch"),
    maxUnsignedBoundaries: numberFrom(row, "max_unsigned_boundaries"),
    maxToolCalls: numberFrom(row, "max_tool_calls"),
    maxWorkspaceOperations: numberFrom(row, "max_workspace_operations"),
    recoveryReserveOutputTokens: numberFrom(row, "recovery_reserve_output_tokens"),
    futurePhaseReserveOutputTokens: numberFrom(row, "future_phase_reserve_output_tokens"),
  });
}

function segmentBudgetFrom(row: Row): WorkSegmentBudgetV1 {
  return Object.freeze({
    maxProviderDispatches: numberFrom(row, "max_provider_dispatches"),
    maxProviderOutputTokens: numberFrom(row, "max_provider_output_tokens"),
    maxOutputTokensPerDispatch: numberFrom(row, "max_output_tokens_per_dispatch"),
    maxUnsignedBoundaries: numberFrom(row, "max_unsigned_boundaries"),
    maxToolCalls: numberFrom(row, "max_tool_calls"),
    maxWorkspaceOperations: numberFrom(row, "max_workspace_operations"),
  });
}

function usageFrom(row: Row, nullable = false): WorkSegmentUsageV1 | null {
  if (nullable && row.provider_input_tokens === null) return null;
  return Object.freeze({
    providerDispatches: row.provider_dispatches === undefined ? 1 : numberFrom(row, "provider_dispatches"),
    providerInputTokens: numberFrom(row, "provider_input_tokens"),
    providerOutputTokens: numberFrom(row, "provider_output_tokens"),
    providerTotalTokens: numberFrom(row, "provider_total_tokens"),
    billedOutputTokens: numberFrom(row, "billed_output_tokens"),
    toolCalls: numberFrom(row, "tool_calls"),
    workspaceOperations: numberFrom(row, "workspace_operations"),
    unsignedBoundaries: numberFrom(row, "unsigned_boundaries"),
    receiveBytes: numberFrom(row, "receive_bytes"),
    publishedOutputBytes: numberFrom(row, "published_output_bytes"),
  });
}

function recoveryFromRow(row: Row): WorkSegmentAttemptRecoveryV1 {
  const segmentUsage = usageFrom(row);
  if (!segmentUsage) fail("integrity_error", "attempt usage is corrupt");
  const usage: WorkAttemptUsageV1 = Object.freeze({
    ...segmentUsage,
    segments: numberFrom(row, "segment_count"),
  });
  const resumeEnvelope = resumeEnvelopeFromRow(row);
  if (resumeEnvelope.envelopeDigest !== stringFrom(row, "resume_envelope_digest")
    || resumeEnvelope.snapshotDigest !== stringFrom(row, "snapshot_digest")) {
    fail("integrity_error", "resume envelope bindings are corrupt");
  }
  return Object.freeze({
    version: 1,
    complete: true,
    userId: stringFrom(row, "user_id"),
    executionId: stringFrom(row, "execution_id"),
    attemptId: stringFrom(row, "attempt_id"),
    workspaceId: stringFrom(row, "workspace_id"),
    workspaceRevision: numberFrom(row, "workspace_revision"),
    executionCasRevision: numberFrom(row, "execution_cas_revision"),
    recoveryEpoch: numberFrom(row, "recovery_epoch"),
    state: stringFrom(row, "state") as "active" | "closed",
    phaseId: nullableStringFrom(row, "phase_id"),
    currentSegmentId: nullableStringFrom(row, "current_segment_id"),
    remainingRequiredPhaseCount: numberFrom(row, "remaining_required_phase_count"),
    initialRequiredPhaseCount: numberFrom(row, "initial_required_phase_count"),
    protectedRecoveryReserveOutputTokens: numberFrom(row, "protected_recovery_reserve_output_tokens"),
    protectedFuturePhaseReserveOutputTokens: numberFrom(row, "protected_future_phase_reserve_output_tokens"),
    terminalCloseResult: nullableStringFrom(row, "terminal_close_result") as WorkSegmentAttemptRecoveryV1["terminalCloseResult"],
    terminalCloseReason: nullableStringFrom(row, "terminal_close_reason"),
    terminalBoundaryClass: nullableStringFrom(row, "terminal_boundary_class") as WorkProviderBoundaryClassV1 | null,
    phaseIndex: nullableNumberFrom(row, "phase_index"),
    phaseOccurrence: nullableNumberFrom(row, "phase_occurrence"),
    nextSegmentOrdinal: numberFrom(row, "next_segment_ordinal"),
    snapshotDigest: stringFrom(row, "snapshot_digest"),
    phasePlanDigest: stringFrom(row, "phase_plan_digest"),
    phasePlan: phasePlanFromRow(row),
    bindingDigest: stringFrom(row, "binding_digest"),
    idempotencyKey: stringFrom(row, "idempotency_key"),
    payloadDigest: stringFrom(row, "payload_digest"),
    resumeEnvelopeDigest: stringFrom(row, "resume_envelope_digest"),
    resumeEnvelope,
    budget: attemptBudgetFrom(row),
    usage,
    createdAt: numberFrom(row, "created_at"),
    updatedAt: numberFrom(row, "updated_at"),
  });
}

function segmentFromRow(row: Row): WorkSegmentAdmissionV1 {
  const usage = usageFrom(row);
  if (!usage) fail("integrity_error", "segment usage is corrupt");
  const context = segmentContextFromRow(row);
  if (context.contextDigest !== stringFrom(row, "context_digest")
    || context.bindingDigest !== stringFrom(row, "binding_digest")
    || context.rootSnapshotDigest !== stringFrom(row, "snapshot_digest")) {
    fail("integrity_error", "segment context bindings are corrupt");
  }
  return Object.freeze({
    version: 1,
    complete: true,
    identity: Object.freeze({
      version: 1,
      executionId: stringFrom(row, "execution_id"),
      attemptId: stringFrom(row, "attempt_id"),
      segmentId: stringFrom(row, "segment_id"),
      phaseId: nullableStringFrom(row, "phase_id"),
      phaseIndex: numberFrom(row, "phase_index"),
      phaseOccurrence: numberFrom(row, "phase_occurrence"),
      segmentOrdinal: numberFrom(row, "segment_ordinal"),
    }),
    sourceTransitionId: nullableStringFrom(row, "source_transition_id"),
    workspaceId: stringFrom(row, "workspace_id"),
    workspaceRevision: numberFrom(row, "workspace_revision"),
    executionCasRevision: numberFrom(row, "execution_cas_revision"),
    lifecycle: stringFrom(row, "lifecycle") as WorkSegmentAdmissionV1["lifecycle"],
    admissionKey: stringFrom(row, "admission_key"),
    payloadDigest: stringFrom(row, "payload_digest"),
    contextDigest: stringFrom(row, "context_digest"),
    context,
    snapshotDigest: stringFrom(row, "snapshot_digest"),
    bindingDigest: stringFrom(row, "binding_digest"),
    budget: segmentBudgetFrom(row),
    usage,
    boundaryClass: nullableStringFrom(row, "boundary_class") as WorkProviderBoundaryClassV1 | null,
    closeReason: nullableStringFrom(row, "close_reason"),
    closeResult: nullableStringFrom(row, "close_result") as WorkSegmentRunnerResultV1["kind"] | null,
    closedWorkspaceRevision: nullableNumberFrom(row, "closed_workspace_revision"),
    closedExecutionCasRevision: nullableNumberFrom(row, "closed_execution_cas_revision"),
    closureDigest: nullableStringFrom(row, "closure_digest"),
    createdAt: numberFrom(row, "created_at"),
    updatedAt: numberFrom(row, "updated_at"),
    closedAt: nullableNumberFrom(row, "closed_at"),
  });
}

function dispatchFromRow(row: Row): WorkSegmentDispatchReservationV1 {
  return Object.freeze({
    version: 1,
    complete: true,
    dispatchId: stringFrom(row, "dispatch_id"),
    executionId: stringFrom(row, "execution_id"),
    attemptId: stringFrom(row, "attempt_id"),
    segmentId: stringFrom(row, "segment_id"),
    dispatchOrdinal: numberFrom(row, "dispatch_ordinal"),
    workspaceId: stringFrom(row, "workspace_id"),
    workspaceRevision: numberFrom(row, "workspace_revision"),
    executionCasRevision: numberFrom(row, "execution_cas_revision"),
    lifecycle: stringFrom(row, "lifecycle") as WorkSegmentDispatchReservationV1["lifecycle"],
    toolMode: stringFrom(row, "tool_mode") as WorkSegmentToolModeV1,
    budgetClass: stringFrom(row, "budget_class") as WorkSegmentDispatchBudgetClassV1,
    reservedOutputTokens: numberFrom(row, "reserved_output_tokens"),
    ordinaryOutputTokensReserved: numberFrom(row, "ordinary_output_tokens_reserved"),
    recoveryReserveOutputTokensReserved: numberFrom(row, "recovery_reserve_output_tokens_reserved"),
    recoveryReserveOutputTokensConsumed: nullableNumberFrom(row, "recovery_reserve_output_tokens_consumed"),
    interruptionReason: nullableStringFrom(row, "interruption_reason"),
    leaseOwner: nullableStringFrom(row, "lease_owner"),
    leaseExpiresAt: nullableNumberFrom(row, "lease_expires_at"),
    fenceGeneration: numberFrom(row, "fence_generation"),
    idempotencyKey: stringFrom(row, "idempotency_key"),
    payloadDigest: stringFrom(row, "payload_digest"),
    settlementKey: nullableStringFrom(row, "settlement_key"),
    settlementDigest: nullableStringFrom(row, "settlement_digest"),
    settledWorkspaceRevision: nullableNumberFrom(row, "settled_workspace_revision"),
    settledExecutionCasRevision: nullableNumberFrom(row, "settled_execution_cas_revision"),
    boundaryClass: nullableStringFrom(row, "boundary_class") as WorkProviderBoundaryClassV1 | null,
    usage: usageFrom(row, true),
    createdAt: numberFrom(row, "created_at"),
    startedAt: nullableNumberFrom(row, "started_at"),
    settledAt: nullableNumberFrom(row, "settled_at"),
    updatedAt: numberFrom(row, "updated_at"),
  });
}

function transitionFromRow(row: Row, source: WorkSegmentAdmissionV1): WorkPhaseTransitionReceiptV1 {
  const transitionId = stringFrom(row, "transition_id");
  const userId = stringFrom(row, "user_id");
  const executionId = stringFrom(row, "execution_id");
  const attemptId = stringFrom(row, "attempt_id");
  const workspaceId = stringFrom(row, "workspace_id");
  const sourceSegmentId = stringFrom(row, "source_segment_id");
  const workspaceRevision = numberFrom(row, "workspace_revision");
  const executionCasRevision = numberFrom(row, "execution_cas_revision");
  const phasePlanDigest = stringFrom(row, "phase_plan_digest");
  const transitionKind = stringFrom(row, "transition_kind") as WorkSegmentTransitionKindV1;
  const target = Object.freeze({
    targetPhaseId: nullableStringFrom(row, "target_phase_id"),
    targetPhaseIndex: nullableNumberFrom(row, "target_phase_index"),
    targetPhaseOccurrence: nullableNumberFrom(row, "target_phase_occurrence"),
    targetSegmentOrdinal: nullableNumberFrom(row, "target_segment_ordinal"),
  });
  const transitionDecisionDigest = stringFrom(row, "transition_decision_digest");
  if (
    numberFrom(row, "schema_version") !== 1
    || numberFrom(row, "record_complete") !== 1
    || stringFrom(row, "accepted_ids_authority") !== "host"
    || stringFrom(row, "advisory_authority") !== "model_advisory"
  ) fail("integrity_error", "persisted transition authority envelope is invalid");
  if (!Object.hasOwn(TRANSITION_KINDS, transitionKind)) {
    fail("integrity_error", "persisted transition kind is invalid");
  }
  const expectedTransitionDecisionDigest = computeWorkTransitionDecisionDigestV1({
    phasePlanDigest,
    source: source.identity,
    transitionKind,
    ...target,
  });
  if (transitionDecisionDigest !== expectedTransitionDecisionDigest) fail("integrity_error", "transition decision digest is corrupt");
  if (
    executionId !== source.identity.executionId
    || attemptId !== source.identity.attemptId
    || sourceSegmentId !== source.identity.segmentId
    || workspaceId !== source.workspaceId
    || source.closedWorkspaceRevision !== workspaceRevision
    || source.closedExecutionCasRevision !== executionCasRevision
    || source.boundaryClass === null
    || source.closeResult === null
  ) fail("integrity_error", "transition source authority is corrupt");
  const remainingRequiredPhaseCount = numberFrom(row, "remaining_required_phase_count");
  const releasedFuturePhaseReserveOutputTokens = numberFrom(row, "released_future_phase_reserve_output_tokens");
  const idempotencyKey = stringFrom(row, "idempotency_key");
  const acceptedIds = Object.freeze({
    taskIds: idsFrom(row, "accepted_task_ids_json"),
    submissionIds: idsFrom(row, "accepted_submission_ids_json"),
    findingIds: idsFrom(row, "accepted_finding_ids_json"),
    decisionIds: idsFrom(row, "accepted_decision_ids_json"),
    artifactIds: idsFrom(row, "accepted_artifact_ids_json"),
  });
  const openRequiredIds = idsFrom(row, "open_required_ids_json");
  const completion = Object.freeze({
    summary: stringFrom(row, "advisory_summary"),
    unresolvedIds: idsFrom(row, "advisory_unresolved_ids_json"),
    renderGuidance: nullableStringFrom(row, "advisory_render_guidance"),
  });
  const payloadDigest = stringFrom(row, "payload_digest");
  const expectedPayloadDigest = canonicalDigest(Object.freeze({
    version: 1,
    userId,
    executionId,
    transitionDecisionDigest,
    attemptId,
    workspaceId,
    workspaceRevision,
    executionCasRevision,
    sourceSegmentId,
    idempotencyKey,
    phasePlanDigest,
    transitionKind,
    ...target,
    boundaryClass: source.boundaryClass,
    closeResult: source.closeResult,
    remainingRequiredPhaseCount,
    releasedFuturePhaseReserveOutputTokens,
    usage: source.usage,
    acceptedIds,
    openRequiredIds,
    completion,
  }));
  if (payloadDigest !== expectedPayloadDigest || source.closureDigest !== payloadDigest) {
    fail("integrity_error", "transition payload digest is corrupt");
  }
  return Object.freeze({
    version: 1,
    complete: true,
    transitionId,
    handoff: Object.freeze({
      version: 1,
      complete: true,
      handoffId: transitionId,
      executionId,
      attemptId,
      sourceSegment: source.identity,
      sourceWorkspaceRevision: workspaceRevision,
      sourceExecutionCasRevision: executionCasRevision,
      transitionDecisionDigest,
      transitionKind,
      remainingRequiredPhaseCount,
      releasedFuturePhaseReserveOutputTokens,
      ...target,
      acceptedIds: Object.freeze({ authority: "host", ...acceptedIds }),
      openRequiredIds,
      completion: Object.freeze({ authority: "model_advisory", ...completion }),
      usage: source.usage,
      idempotencyKey,
      payloadDigest,
      createdAt: numberFrom(row, "created_at"),
    }),
  });
}

function transaction<T>(db: Database, callback: () => T): T {
  let result: T | undefined;
  db.transaction(() => { result = callback(); })();
  if (result === undefined) fail("integrity_error", "transaction produced no result");
  return result;
}

function rawRecovery(db: Database, userId: string, executionId: string): Row | null {
  return db.query(
    "SELECT * FROM agent_work_segment_recovery WHERE user_id = ? AND execution_id = ?",
  ).get(userId, executionId) as Row | null;
}

function rawSegment(db: Database, userId: string, executionId: string, segmentId: string): Row | null {
  return db.query(
    "SELECT * FROM agent_work_segments WHERE user_id = ? AND execution_id = ? AND segment_id = ?",
  ).get(userId, executionId, segmentId) as Row | null;
}

function rawDispatch(db: Database, userId: string, executionId: string, dispatchId: string): Row | null {
  return db.query(
    "SELECT * FROM agent_work_segment_dispatches WHERE user_id = ? AND execution_id = ? AND dispatch_id = ?",
  ).get(userId, executionId, dispatchId) as Row | null;
}

function rawTransitionByKey(db: Database, userId: string, executionId: string, key: string): Row | null {
  return db.query(
    "SELECT * FROM agent_work_segment_transitions WHERE user_id = ? AND execution_id = ? AND idempotency_key = ?",
  ).get(userId, executionId, key) as Row | null;
}

export function createAndAdmitInitialWorkSegmentV1(
  input: CreateAndAdmitInitialWorkSegmentInputV1,
): CreateAndAdmitInitialWorkSegmentResultV1 {
  const db = input.db ?? getDb();
  const attempt = input.attempt;
  const admission = input.admission;
  if (
    attempt.userId !== admission.userId
    || attempt.executionId !== admission.executionId
    || attempt.ownerToken !== admission.ownerToken
    || attempt.expectedExecutionCasRevision !== admission.expectedExecutionCasRevision
    || attempt.expectedWorkspaceRevision !== admission.expectedWorkspaceRevision
    || attempt.now !== admission.now
    || attempt.attemptId !== admission.attemptId
    || attempt.workspaceId !== admission.workspaceId
    || attempt.phaseId !== admission.phaseId
    || attempt.phaseIndex !== admission.phaseIndex
    || attempt.phaseOccurrence !== admission.phaseOccurrence
    || admission.sourceTransitionId !== null
    || admission.segmentOrdinal !== 0
  ) fail("invalid_input", "initial attempt and segment admission do not share exact authority");
  return transaction(db, () => {
    const attemptResult = createWorkSegmentAttemptInTransactionV1(db, { ...attempt, db }, admission);
    const admissionResult = admitWorkSegmentInTransactionV1(db, { ...admission, db });
    return Object.freeze({ attempt: attemptResult, admission: admissionResult });
  });
}

export function createWorkSegmentAttemptV1(
  input: CreateWorkSegmentAttemptInputV1,
): WorkSegmentWriteResult<WorkSegmentAttemptRecoveryV1> {
  const db = input.db ?? getDb();
  return transaction(db, () => createWorkSegmentAttemptInTransactionV1(db, input));
}

export function createWorkSegmentAttemptInTransactionV1(
  db: Database,
  input: CreateWorkSegmentAttemptInputV1,
  atomicInitialAdmission: Pick<
    AdmitWorkSegmentInputV1,
    "context" | "sourceTransitionId" | "segmentOrdinal"
  > | null = null,
): WorkSegmentWriteResult<WorkSegmentAttemptRecoveryV1> {
  const authorityRow = authority(db, input, true);
  const attemptId = boundedString(input.attemptId, "attemptId");
  const workspaceId = boundedString(input.workspaceId, "workspaceId");
  if (workspaceId !== authorityRow.workspace_id) fail("stale_workspace", "workspace identity changed");
  requireAttemptAuthority(db, authorityRow, attemptId);
  const phasePlan = normalizedPhasePlan(input.phasePlan);
  const phaseId = normalizedNullablePhaseId(input.phaseId, "phaseId");
  const phaseIndex = safeInteger(input.phaseIndex, "phaseIndex", MAX_ORDINAL);
  const phaseOccurrence = safeInteger(input.phaseOccurrence, "phaseOccurrence", MAX_ORDINAL);
  if (phaseOccurrence !== 0) fail("invalid_input", "attempt must begin at phase occurrence zero");
  let atomicInitialContext: WorkSegmentContextV1 | null = null;
  const authoredPhase = phasePlan.phases[phaseIndex];
  if (phasePlan.phases.length === 0) {
    if (phaseId !== null || phaseIndex !== 0) {
      fail("invalid_input", "initial phase is not bound to the immutable plan");
    }
  } else if (phaseId === null) {
    if (phaseIndex !== 0 || atomicInitialAdmission === null) {
      fail("invalid_input", "authored null-phase attempt requires atomic all-skipped admission authority");
    }
    atomicInitialContext = normalizedSegmentContext(atomicInitialAdmission.context, "admission.context");
    const initialContext = atomicInitialContext;
    if (initialContext.phase.id !== phaseId
      || initialContext.phase.index !== phaseIndex
      || initialContext.phase.occurrence !== phaseOccurrence) {
      fail("invalid_input", "authored null-phase attempt does not match its atomic admission context");
    }
    assertAtomicSegmentSkipAuthorityV1(
      initialContext,
      phasePlan,
      atomicInitialAdmission.sourceTransitionId,
      atomicInitialAdmission.segmentOrdinal,
    );
  } else if (authoredPhase?.id !== phaseId) {
    fail("invalid_input", "initial phase is not bound to the immutable plan");
  }
  if (phasePlan.phases.slice(0, phaseIndex).some((phase) => phase.required)) {
    fail("invalid_input", "attempt cannot skip an authored required phase");
  }
  if (phasePlan.phases.slice(0, phaseIndex).some((phase) => phase.skipEligibilityDigest === null)) {
    fail("invalid_input", "initial phase skip lacks deterministic eligibility authority");
  }
  const remainingRequiredPhaseCount = safeInteger(input.remainingRequiredPhaseCount, "remainingRequiredPhaseCount", MAX_ORDINAL);
  const exactRequiredCount = phasePlan.phases.slice(phaseIndex + 1).filter((phase) => phase.required).length;
  if (remainingRequiredPhaseCount !== exactRequiredCount) fail("invalid_input", "future required phase count is not bound to the immutable plan");
  const idempotencyKey = boundedString(input.idempotencyKey, "idempotencyKey");
  const budget = normalizedAttemptBudget(input.budget);
  const phasePlanDigest = digest(input.phasePlanDigest, "phasePlanDigest");
  if (computeWorkPhasePlanDigestV1(phasePlan) !== phasePlanDigest) fail("invalid_input", "phase plan digest does not match the immutable plan");
  if (atomicInitialContext !== null && atomicInitialContext.phasePlanDigest !== phasePlanDigest) {
    fail("invalid_input", "atomic all-skipped admission context does not match the immutable phase plan");
  }
  if (remainingRequiredPhaseCount === 0 && budget.futurePhaseReserveOutputTokens !== 0) {
    fail("invalid_input", "future phase reserve requires at least one required phase");
  }
  const resumeEnvelope = normalizedResumeEnvelope(input.resumeEnvelope);
  const snapshotDigest = digest(input.snapshotDigest, "snapshotDigest");
  if (resumeEnvelope.snapshotDigest !== snapshotDigest
    || resumeEnvelope.runtime.workspaceId !== workspaceId
    || resumeEnvelope.runtime.workspaceRevision !== input.expectedWorkspaceRevision
    || resumeEnvelope.runtime.deadlineAt <= input.now) {
    fail("invalid_input", "resume envelope does not match attempt authority");
  }
  const payload = Object.freeze({
    version: 1,
    userId: authorityRow.user_id,
    executionId: authorityRow.execution_id,
    attemptId,
    workspaceId,
    workspaceRevision: input.expectedWorkspaceRevision,
    executionCasRevision: input.expectedExecutionCasRevision,
    phaseId,
    phaseIndex,
    phaseOccurrence,
    snapshotDigest,
    remainingRequiredPhaseCount,
    phasePlanDigest,
    phasePlan,
    bindingDigest: digest(input.bindingDigest, "bindingDigest"),
    resumeEnvelopeDigest: resumeEnvelope.envelopeDigest,
    idempotencyKey,
    budget,
  });
  const payloadDigest = canonicalDigest(payload);
  const existing = rawRecovery(db, authorityRow.user_id, authorityRow.execution_id);
  if (existing) {
    if (stringFrom(existing, "payload_digest") !== payloadDigest || stringFrom(existing, "idempotency_key") !== idempotencyKey) {
      fail("idempotency_conflict", "segment attempt already exists with a different payload");
    }
    return Object.freeze({ record: recoveryFromRow(existing), duplicate: true });
  }
  insertRow(db, "agent_work_segment_recovery", {
    user_id: authorityRow.user_id,
    execution_id: authorityRow.execution_id,
    attempt_id: attemptId,
    workspace_id: workspaceId,
    workspace_revision: input.expectedWorkspaceRevision,
    execution_cas_revision: input.expectedExecutionCasRevision,
    recovery_epoch: 0,
    state: "active",
    phase_id: phaseId,
    phase_index: phaseIndex,
    current_segment_id: null,
    initial_required_phase_count: remainingRequiredPhaseCount,
    remaining_required_phase_count: remainingRequiredPhaseCount,
    phase_occurrence: phaseOccurrence,
    next_segment_ordinal: 0,
    snapshot_digest: payload.snapshotDigest,
    phase_plan_digest: payload.phasePlanDigest,
    phase_plan_json: encodeCanonicalPlainData(phasePlan),
    binding_digest: payload.bindingDigest,
    idempotency_key: idempotencyKey,
    resume_envelope_digest: resumeEnvelope.envelopeDigest,
    resume_envelope_json: encodeCanonicalPlainData(resumeEnvelope),
    payload_digest: payloadDigest,
    schema_version: 1,
    record_complete: 1,
    max_segments: budget.maxSegments,
    max_provider_dispatches: budget.maxProviderDispatches,
    max_provider_output_tokens: budget.maxProviderOutputTokens,
    max_output_tokens_per_dispatch: budget.maxOutputTokensPerDispatch,
    max_unsigned_boundaries: budget.maxUnsignedBoundaries,
    max_tool_calls: budget.maxToolCalls,
    max_workspace_operations: budget.maxWorkspaceOperations,
    recovery_reserve_output_tokens: budget.recoveryReserveOutputTokens,
    future_phase_reserve_output_tokens: budget.futurePhaseReserveOutputTokens,
    protected_recovery_reserve_output_tokens: budget.recoveryReserveOutputTokens,
    protected_future_phase_reserve_output_tokens: budget.futurePhaseReserveOutputTokens,
    terminal_close_result: null,
    terminal_close_reason: null,
    terminal_boundary_class: null,
    segment_count: 0,
    provider_dispatches: 0,
    provider_input_tokens: 0,
    provider_output_tokens: 0,
    provider_total_tokens: 0,
    billed_output_tokens: 0,
    tool_calls: 0,
    workspace_operations: 0,
    unsigned_boundaries: 0,
    receive_bytes: 0,
    published_output_bytes: 0,
    created_at: safeInteger(input.now, "now"),
    updated_at: input.now,
  });
  const created = rawRecovery(db, authorityRow.user_id, authorityRow.execution_id);
  if (!created) fail("integrity_error", "segment attempt insert was not observable");
  return Object.freeze({ record: recoveryFromRow(created), duplicate: false });
}

export function admitWorkSegmentV1(input: AdmitWorkSegmentInputV1): WorkSegmentWriteResult<WorkSegmentAdmissionV1> {
  const db = input.db ?? getDb();
  return transaction(db, () => admitWorkSegmentInTransactionV1(db, input));
}

export function admitWorkSegmentInTransactionV1(
  db: Database,
  input: AdmitWorkSegmentInputV1,
): WorkSegmentWriteResult<WorkSegmentAdmissionV1> {
  const authorityRow = authority(db, input, true);
  const attemptId = boundedString(input.attemptId, "attemptId");
  const workspaceId = boundedString(input.workspaceId, "workspaceId");
  const admissionKey = boundedString(input.admissionKey, "admissionKey");
  const phaseId = normalizedNullablePhaseId(input.phaseId, "phaseId");
  const phaseIndex = safeInteger(input.phaseIndex, "phaseIndex", MAX_ORDINAL);
  const phaseOccurrence = safeInteger(input.phaseOccurrence, "phaseOccurrence", MAX_ORDINAL);
  const segmentOrdinal = safeInteger(input.segmentOrdinal, "segmentOrdinal", MAX_ORDINAL);
  const sourceTransitionId = input.sourceTransitionId === null
    ? null
    : boundedString(input.sourceTransitionId, "sourceTransitionId");
  const contextDigest = digest(input.contextDigest, "contextDigest");
  const context = normalizedSegmentContext(input.context);
  if (context.contextDigest !== contextDigest) fail("invalid_input", "context digest does not match exact context");
  const budget = normalizedSegmentBudget(input.budget);
  if (context.phase.id !== phaseId || context.phase.index !== phaseIndex || context.phase.occurrence !== phaseOccurrence
    || context.workspace.id !== workspaceId || context.workspace.revision !== input.expectedWorkspaceRevision
    || encodeCanonicalPlainData(context.segmentBudget) !== encodeCanonicalPlainData(budget)) {
    fail("invalid_input", "exact context does not match segment admission authority");
  }
  if (workspaceId !== authorityRow.workspace_id) fail("stale_workspace", "workspace identity changed");
  if (segmentOrdinal === 0 ? sourceTransitionId !== null : sourceTransitionId === null) {
    fail("invalid_input", "segment source transition is inconsistent with its ordinal");
  }
  const recoveryRow = rawRecovery(db, authorityRow.user_id, authorityRow.execution_id);
  if (!recoveryRow) fail("not_found", "segment attempt was not found");
  const recovery = recoveryFromRow(recoveryRow);
  assertAtomicSegmentSkipAuthorityV1(context, recovery.phasePlan, sourceTransitionId, segmentOrdinal);
  if (context.resumeEnvelopeDigest !== recovery.resumeEnvelopeDigest
    || context.rootSnapshotDigest !== recovery.snapshotDigest
    || context.phasePlanDigest !== recovery.phasePlanDigest
    || context.bindingDigest !== recovery.bindingDigest
    || encodeCanonicalPlainData(context.attemptBudget) !== encodeCanonicalPlainData(recovery.budget)) {
    fail("integrity_error", "segment context does not match the immutable attempt resume authority");
  }
  const payload = Object.freeze({
    version: 1,
    userId: authorityRow.user_id,
    executionId: authorityRow.execution_id,
    attemptId,
    workspaceId,
    workspaceRevision: input.expectedWorkspaceRevision,
    executionCasRevision: input.expectedExecutionCasRevision,
    sourceTransitionId,
    phaseId,
    phaseIndex,
    phaseOccurrence,
    segmentOrdinal,
    admissionKey,
    contextDigest,
    snapshotDigest: recovery.snapshotDigest,
    bindingDigest: recovery.bindingDigest,
    resumeEnvelopeDigest: recovery.resumeEnvelopeDigest,
    budget,
  });
  const payloadDigest = canonicalDigest(payload);
  const segmentId = deterministicId("segment", authorityRow.user_id, authorityRow.execution_id, admissionKey);
  const existing = rawSegment(db, authorityRow.user_id, authorityRow.execution_id, segmentId);
  if (existing) {
    if (stringFrom(existing, "payload_digest") !== payloadDigest) {
      fail("idempotency_conflict", "segment admission key was reused with a different payload");
    }
    return Object.freeze({ record: segmentFromRow(existing), duplicate: true });
  }
  if (
    recovery.state !== "active"
    || recovery.attemptId !== attemptId
    || recovery.workspaceId !== workspaceId
    || recovery.workspaceRevision !== input.expectedWorkspaceRevision
    || recovery.executionCasRevision !== input.expectedExecutionCasRevision
    || recovery.phaseId !== phaseId
    || recovery.phaseIndex !== phaseIndex
    || recovery.phaseOccurrence !== phaseOccurrence
    || recovery.nextSegmentOrdinal !== segmentOrdinal
    || recovery.currentSegmentId !== null
    || input.now < recovery.updatedAt
  ) fail("stale_segment", "segment admission does not match the attempt cursor");
  if (sourceTransitionId) {
    const source = db.query(
      `SELECT transition_id, attempt_id, workspace_id, source_segment_id, transition_kind, phase_plan_digest,
              target_phase_id, target_phase_index, target_phase_occurrence, target_segment_ordinal
         FROM agent_work_segment_transitions
        WHERE user_id = ? AND execution_id = ? AND transition_id = ?`,
    ).get(authorityRow.user_id, authorityRow.execution_id, sourceTransitionId) as Row | null;
    if (
      !source
      || source.target_phase_id !== phaseId
      || source.attempt_id !== attemptId
      || source.workspace_id !== workspaceId
      || source.source_segment_id === segmentId
      || source.transition_kind === "terminal"
      || source.phase_plan_digest !== recovery.phasePlanDigest
      || source.target_phase_index !== phaseIndex
      || source.target_phase_occurrence !== phaseOccurrence
      || source.target_segment_ordinal !== segmentOrdinal
    ) fail("stale_segment", "source transition does not admit this segment");
  }
  enforceAttemptBudget(recovery.usage.segments + 1, recovery.usage, recovery.budget);
  if (
    budget.maxProviderDispatches > recovery.budget.maxProviderDispatches
    || budget.maxProviderOutputTokens > recovery.budget.maxProviderOutputTokens
    || budget.maxOutputTokensPerDispatch > recovery.budget.maxOutputTokensPerDispatch
    || budget.maxUnsignedBoundaries > recovery.budget.maxUnsignedBoundaries
    || budget.maxToolCalls > recovery.budget.maxToolCalls
    || budget.maxWorkspaceOperations > recovery.budget.maxWorkspaceOperations
  ) fail("invalid_input", "segment budget exceeds its independent attempt ceiling");
  insertRow(db, "agent_work_segments", {
    segment_id: segmentId,
    user_id: authorityRow.user_id,
    execution_id: authorityRow.execution_id,
    attempt_id: attemptId,
    workspace_id: workspaceId,
    workspace_revision: input.expectedWorkspaceRevision,
    execution_cas_revision: input.expectedExecutionCasRevision,
    source_transition_id: sourceTransitionId,
    phase_id: phaseId,
    phase_index: phaseIndex,
    phase_occurrence: phaseOccurrence,
    segment_ordinal: segmentOrdinal,
    lifecycle: "admitted",
    admission_key: admissionKey,
    payload_digest: payloadDigest,
    context_digest: contextDigest,
    context_json: encodeCanonicalPlainData(context),
    snapshot_digest: recovery.snapshotDigest,
    binding_digest: recovery.bindingDigest,
    schema_version: 1,
    record_complete: 1,
    max_provider_dispatches: budget.maxProviderDispatches,
    max_provider_output_tokens: budget.maxProviderOutputTokens,
    max_output_tokens_per_dispatch: budget.maxOutputTokensPerDispatch,
    max_unsigned_boundaries: budget.maxUnsignedBoundaries,
    max_tool_calls: budget.maxToolCalls,
    max_workspace_operations: budget.maxWorkspaceOperations,
    provider_dispatches: 0,
    provider_input_tokens: 0,
    provider_output_tokens: 0,
    provider_total_tokens: 0,
    billed_output_tokens: 0,
    tool_calls: 0,
    workspace_operations: 0,
    unsigned_boundaries: 0,
    receive_bytes: 0,
    published_output_bytes: 0,
    boundary_class: null,
    close_result: null,
    closed_workspace_revision: null,
    closed_execution_cas_revision: null,
    close_reason: null,
    closure_digest: null,
    created_at: input.now,
    updated_at: input.now,
    closed_at: null,
  });
  const changed = db.query(
    `UPDATE agent_work_segment_recovery
        SET segment_count = segment_count + 1, current_segment_id = ?, updated_at = ?
      WHERE user_id = ? AND execution_id = ? AND segment_count = ? AND next_segment_ordinal = ?
        AND current_segment_id IS NULL`,
  ).run(segmentId, input.now, authorityRow.user_id, authorityRow.execution_id, recovery.usage.segments, segmentOrdinal).changes;
  if (changed !== 1) fail("stale_segment", "attempt changed during segment admission");
  const created = rawSegment(db, authorityRow.user_id, authorityRow.execution_id, segmentId);
  if (!created) fail("integrity_error", "segment insert was not observable");
  return Object.freeze({ record: segmentFromRow(created), duplicate: false });
}

export function reserveWorkSegmentDispatchV1(
  input: ReserveWorkSegmentDispatchInputV1,
): WorkSegmentWriteResult<WorkSegmentDispatchReservationV1> {
  const db = input.db ?? getDb();
  return transaction(db, () => reserveWorkSegmentDispatchInTransactionV1(db, input));
}

export function reserveWorkSegmentDispatchInTransactionV1(
  db: Database,
  input: ReserveWorkSegmentDispatchInputV1,
): WorkSegmentWriteResult<WorkSegmentDispatchReservationV1> {
  const authorityRow = authority(db, input, true);
  const segmentId = boundedString(input.segmentId, "segmentId");
  const attemptId = boundedString(input.attemptId, "attemptId");
  const workspaceId = boundedString(input.workspaceId, "workspaceId");
  const dispatchOrdinal = safeInteger(input.dispatchOrdinal, "dispatchOrdinal", MAX_COUNTER);
  const idempotencyKey = boundedString(input.idempotencyKey, "idempotencyKey");
  const leaseOwner = boundedString(input.leaseOwner, "leaseOwner");
  const leaseExpiresAt = safeInteger(input.leaseExpiresAt, "leaseExpiresAt");
  const reservedOutputTokens = safeInteger(input.reservedOutputTokens, "reservedOutputTokens", MAX_COUNTER, 1);
  if (!Object.hasOwn(TOOL_MODES, input.toolMode)) fail("invalid_input", "toolMode is invalid");
  if (!Object.hasOwn(DISPATCH_BUDGET_CLASSES, input.budgetClass)) fail("invalid_input", "budgetClass is invalid");
  if (workspaceId !== authorityRow.workspace_id) fail("stale_workspace", "workspace identity changed");
  const payload = Object.freeze({
    version: 1,
    userId: authorityRow.user_id,
    executionId: authorityRow.execution_id,
    attemptId,
    segmentId,
    dispatchOrdinal,
    workspaceId,
    workspaceRevision: input.expectedWorkspaceRevision,
    executionCasRevision: input.expectedExecutionCasRevision,
    idempotencyKey,
    toolMode: input.toolMode,
    budgetClass: input.budgetClass,
    reservedOutputTokens,
    leaseOwner,
    leaseExpiresAt,
    fenceGeneration: 1,
  });
  const payloadDigest = canonicalDigest(payload);
  const dispatchId = deterministicId("dispatch", authorityRow.user_id, authorityRow.execution_id, idempotencyKey);
  const existing = rawDispatch(db, authorityRow.user_id, authorityRow.execution_id, dispatchId);
  if (existing) {
    if (stringFrom(existing, "payload_digest") !== payloadDigest) {
      fail("idempotency_conflict", "dispatch reservation key was reused with a different payload");
    }
    return Object.freeze({ record: dispatchFromRow(existing), duplicate: true });
  }
  if (leaseExpiresAt <= input.now) fail("invalid_input", "dispatch lease must extend beyond reservation time");
  const segmentRow = rawSegment(db, authorityRow.user_id, authorityRow.execution_id, segmentId);
  if (!segmentRow) fail("not_found", "segment was not found");
  const segment = segmentFromRow(segmentRow);
  const recoveryRow = rawRecovery(db, authorityRow.user_id, authorityRow.execution_id);
  if (!recoveryRow) fail("not_found", "segment attempt was not found");
  const recovery = recoveryFromRow(recoveryRow);
  if (
    (segment.lifecycle !== "admitted" && segment.lifecycle !== "running")
    || segment.identity.attemptId !== attemptId
    || segment.workspaceId !== workspaceId
    || recovery.state !== "active"
    || recovery.attemptId !== attemptId
    || recovery.workspaceId !== workspaceId
    || recovery.currentSegmentId !== segmentId
    || input.now < segment.updatedAt
    || input.now < recovery.updatedAt
  ) fail("stale_segment", "segment is not dispatchable");
  assertSettledDispatchEffectsFinalized(db, input.userId, input.executionId, segmentId);
  if (
    reservedOutputTokens > segment.budget.maxOutputTokensPerDispatch
    || reservedOutputTokens > recovery.budget.maxOutputTokensPerDispatch
  ) fail("dispatch_budget_exhausted", "dispatch reservation exceeds the hard per-dispatch output cap");
  const summary = db.query(
    `SELECT COUNT(*) AS dispatch_count,
            COALESCE(SUM(CASE WHEN lifecycle IN ('reserved', 'in_flight') THEN 1 ELSE 0 END), 0) AS unsettled_count,
            COALESCE(SUM(CASE WHEN lifecycle IN ('reserved', 'in_flight') THEN reserved_output_tokens ELSE 0 END), 0) AS unsettled_output
       FROM agent_work_segment_dispatches
      WHERE user_id = ? AND execution_id = ? AND segment_id = ?`,
  ).get(authorityRow.user_id, authorityRow.execution_id, segmentId) as Row;
  const dispatchCount = numberFrom(summary, "dispatch_count");
  const unsettledCount = numberFrom(summary, "unsettled_count");
  const unsettledOutput = numberFrom(summary, "unsettled_output");
  if (dispatchOrdinal !== dispatchCount) fail("stale_segment", "dispatch ordinal is not the next segment dispatch");
  if (
    segment.usage.providerDispatches + unsettledCount + 1 > segment.budget.maxProviderDispatches
    || segment.usage.billedOutputTokens + unsettledOutput + reservedOutputTokens > segment.budget.maxProviderOutputTokens
  ) fail("segment_budget_exhausted", "dispatch reservation exceeds the segment budget");
  const attemptCommittedOutput = recovery.usage.billedOutputTokens + unsettledOutput;
  const ordinaryAvailable = Math.max(0, recovery.budget.maxProviderOutputTokens
    - attemptCommittedOutput
    - recovery.protectedRecoveryReserveOutputTokens
    - recovery.protectedFuturePhaseReserveOutputTokens);
  const recoveryAvailable = Math.max(0, recovery.budget.maxProviderOutputTokens
    - attemptCommittedOutput
    - recovery.protectedFuturePhaseReserveOutputTokens);
  const allowedOutput = input.budgetClass === "normal" ? ordinaryAvailable : recoveryAvailable;
  if (recovery.usage.providerDispatches + unsettledCount + 1 > recovery.budget.maxProviderDispatches) {
    fail("attempt_budget_exhausted", "dispatch reservation exceeds the attempt dispatch ceiling");
  }
  if (reservedOutputTokens > allowedOutput) {
    fail(input.budgetClass === "recovery" ? "recovery_reserve_exhausted" : "future_phase_reserve_exhausted",
      "dispatch reservation would consume protected attempt reserves");
  }
  const ordinaryOutputTokensReserved = Math.min(reservedOutputTokens, ordinaryAvailable);
  const recoveryReserveOutputTokensReserved = input.budgetClass === "recovery"
    ? reservedOutputTokens - ordinaryOutputTokensReserved
    : 0;
  insertRow(db, "agent_work_segment_dispatches", {
    dispatch_id: dispatchId,
    user_id: authorityRow.user_id,
    execution_id: authorityRow.execution_id,
    attempt_id: attemptId,
    segment_id: segmentId,
    workspace_id: workspaceId,
    workspace_revision: input.expectedWorkspaceRevision,
    execution_cas_revision: input.expectedExecutionCasRevision,
    dispatch_ordinal: dispatchOrdinal,
    lifecycle: "reserved",
    tool_mode: input.toolMode,
    budget_class: input.budgetClass,
    reserved_output_tokens: reservedOutputTokens,
    ordinary_output_tokens_reserved: ordinaryOutputTokensReserved,
    recovery_reserve_output_tokens_reserved: recoveryReserveOutputTokensReserved,
    lease_owner: leaseOwner,
    lease_expires_at: leaseExpiresAt,
    fence_generation: 1,
    idempotency_key: idempotencyKey,
    payload_digest: payloadDigest,
    schema_version: 1,
    record_complete: 1,
    settlement_key: null,
    settlement_digest: null,
    interruption_reason: null,
    settled_workspace_revision: null,
    settled_execution_cas_revision: null,
    boundary_class: null,
    provider_input_tokens: null,
    provider_output_tokens: null,
    provider_total_tokens: null,
    billed_output_tokens: null,
    recovery_reserve_output_tokens_consumed: null,
    tool_calls: null,
    workspace_operations: null,
    unsigned_boundaries: null,
    receive_bytes: null,
    published_output_bytes: null,
    created_at: input.now,
    started_at: null,
    settled_at: null,
    updated_at: input.now,
  });
  const created = rawDispatch(db, authorityRow.user_id, authorityRow.execution_id, dispatchId);
  if (!created) fail("integrity_error", "dispatch reservation insert was not observable");
  return Object.freeze({ record: dispatchFromRow(created), duplicate: false });
}

export function startWorkSegmentDispatchV1(input: StartWorkSegmentDispatchInputV1): WorkSegmentDispatchReservationV1 {
  const db = input.db ?? getDb();
  return transaction(db, () => {
    authority(db, input, true);
    const segmentId = boundedString(input.segmentId, "segmentId");
    const dispatchId = boundedString(input.dispatchId, "dispatchId");
    const leaseOwner = boundedString(input.leaseOwner, "leaseOwner");
    const fenceGeneration = safeInteger(input.fenceGeneration, "fenceGeneration", MAX_COUNTER, 1);
    const current = rawDispatch(db, input.userId, input.executionId, dispatchId);
    if (!current || current.segment_id !== segmentId) fail("not_found", "dispatch reservation was not found");
    if (
      current.workspace_revision !== input.expectedWorkspaceRevision
      || current.execution_cas_revision !== input.expectedExecutionCasRevision
    ) fail("stale_execution", "dispatch reservation authority changed");
    if (input.now < numberFrom(current, "updated_at")) fail("stale_segment", "dispatch start time predates its reservation");
    const leaseExpired = numberFrom(current, "lease_expires_at") <= input.now;
    if (current.lifecycle === "in_flight" && current.lease_owner === leaseOwner && current.fence_generation === fenceGeneration) {
      if (leaseExpired) fail("stale_owner", "dispatch lease expired");
      return dispatchFromRow(current);
    }
    if (current.lifecycle !== "reserved") fail("stale_segment", "dispatch is not reserved");
    if (current.lease_owner !== leaseOwner || current.fence_generation !== fenceGeneration || leaseExpired) {
      fail("stale_owner", "dispatch lease changed or expired");
    }
    const changed = db.query(
      `UPDATE agent_work_segment_dispatches
          SET lifecycle = 'in_flight', started_at = ?, updated_at = ?
        WHERE user_id = ? AND execution_id = ? AND dispatch_id = ? AND segment_id = ?
          AND lifecycle = 'reserved' AND lease_owner = ? AND fence_generation = ? AND lease_expires_at > ?`,
    ).run(input.now, input.now, input.userId, input.executionId, dispatchId, segmentId, leaseOwner, fenceGeneration, input.now).changes;
    if (changed !== 1) fail("stale_segment", "dispatch changed before start");
    const segmentChanged = db.query(
      `UPDATE agent_work_segments SET lifecycle = 'running', updated_at = ?
        WHERE user_id = ? AND execution_id = ? AND segment_id = ? AND lifecycle IN ('admitted', 'running')
          AND updated_at <= ?`,
    ).run(input.now, input.userId, input.executionId, segmentId, input.now).changes;
    if (segmentChanged !== 1) fail("stale_segment", "segment changed before dispatch start");
    const started = rawDispatch(db, input.userId, input.executionId, dispatchId);
    if (!started) fail("integrity_error", "started dispatch was not observable");
    return dispatchFromRow(started);
  });
}

function persistSettledDispatchUsage(
  db: Database,
  input: AuthorityInputV1,
  segmentId: string,
  usage: WorkSegmentUsageV1,
  recoveryReserveOutputTokensConsumed: number,
): void {
  const segmentRow = rawSegment(db, input.userId, input.executionId, segmentId);
  const recoveryRow = rawRecovery(db, input.userId, input.executionId);
  if (!segmentRow || !recoveryRow) fail("not_found", "dispatch usage authority was not found");
  const segment = segmentFromRow(segmentRow);
  const recovery = recoveryFromRow(recoveryRow);
  if (
    segment.lifecycle !== "running"
    || recovery.state !== "active"
    || recovery.currentSegmentId !== segmentId
    || segment.workspaceRevision > input.expectedWorkspaceRevision
    || segment.executionCasRevision > input.expectedExecutionCasRevision
    || recovery.workspaceRevision > input.expectedWorkspaceRevision
    || recovery.executionCasRevision > input.expectedExecutionCasRevision
    || input.now < segment.updatedAt
    || input.now < recovery.updatedAt
  ) fail("stale_segment", "dispatch usage authority changed");
  const segmentUsage = addUsage(segment.usage, usage);
  const attemptUsage = addUsage(recovery.usage, usage);
  enforceSegmentBudget(segmentUsage, segment.budget);
  enforceAttemptBudget(recovery.usage.segments, attemptUsage, recovery.budget);
  if (recoveryReserveOutputTokensConsumed > recovery.protectedRecoveryReserveOutputTokens) {
    fail("recovery_reserve_exhausted", "dispatch consumed more than the protected recovery reserve");
  }
  const segmentChanged = db.query(
    `UPDATE agent_work_segments
        SET workspace_revision = ?, execution_cas_revision = ?, provider_dispatches = ?, provider_input_tokens = ?,
            provider_output_tokens = ?, provider_total_tokens = ?, billed_output_tokens = ?, tool_calls = ?,
            workspace_operations = ?, unsigned_boundaries = ?, receive_bytes = ?, published_output_bytes = ?, updated_at = ?
      WHERE user_id = ? AND execution_id = ? AND segment_id = ? AND lifecycle = 'running'
        AND workspace_revision <= ? AND execution_cas_revision <= ? AND updated_at <= ?`,
  ).run(
    input.expectedWorkspaceRevision, input.expectedExecutionCasRevision,
    segmentUsage.providerDispatches, segmentUsage.providerInputTokens, segmentUsage.providerOutputTokens,
    segmentUsage.providerTotalTokens, segmentUsage.billedOutputTokens, segmentUsage.toolCalls,
    segmentUsage.workspaceOperations, segmentUsage.unsignedBoundaries, segmentUsage.receiveBytes,
    segmentUsage.publishedOutputBytes, input.now, input.userId, input.executionId, segmentId,
    input.expectedWorkspaceRevision, input.expectedExecutionCasRevision, input.now,
  ).changes;
  if (segmentChanged !== 1) fail("stale_segment", "segment usage changed during settlement");
  const recoveryChanged = db.query(
    `UPDATE agent_work_segment_recovery
        SET workspace_revision = ?, execution_cas_revision = ?, provider_dispatches = ?, provider_input_tokens = ?,
            provider_output_tokens = ?, provider_total_tokens = ?, billed_output_tokens = ?, tool_calls = ?,
            workspace_operations = ?, unsigned_boundaries = ?, receive_bytes = ?, published_output_bytes = ?,
            protected_recovery_reserve_output_tokens = protected_recovery_reserve_output_tokens - ?, updated_at = ?
      WHERE user_id = ? AND execution_id = ? AND state = 'active' AND current_segment_id = ?
        AND workspace_revision <= ? AND execution_cas_revision <= ?
        AND protected_recovery_reserve_output_tokens >= ? AND updated_at <= ?`,
  ).run(
    input.expectedWorkspaceRevision, input.expectedExecutionCasRevision,
    attemptUsage.providerDispatches, attemptUsage.providerInputTokens, attemptUsage.providerOutputTokens,
    attemptUsage.providerTotalTokens, attemptUsage.billedOutputTokens, attemptUsage.toolCalls,
    attemptUsage.workspaceOperations, attemptUsage.unsignedBoundaries, attemptUsage.receiveBytes,
    attemptUsage.publishedOutputBytes, recoveryReserveOutputTokensConsumed, input.now,
    input.userId, input.executionId, segmentId,
    input.expectedWorkspaceRevision, input.expectedExecutionCasRevision,
    recoveryReserveOutputTokensConsumed, input.now,
  ).changes;
  if (recoveryChanged !== 1) fail("stale_segment", "attempt usage changed during settlement");
}

export function settleWorkSegmentDispatchV1(
  input: SettleWorkSegmentDispatchInputV1,
): WorkSegmentWriteResult<WorkSegmentDispatchReservationV1> {
  const db = input.db ?? getDb();
  return transaction(db, () => settleWorkSegmentDispatchInTransactionV1(db, input));
}

export function settleWorkSegmentDispatchInTransactionV1(
  db: Database,
  input: SettleWorkSegmentDispatchInputV1,
): WorkSegmentWriteResult<WorkSegmentDispatchReservationV1> {
  const authorityRow = authority(db, input, true, false, true, true);
  const segmentId = boundedString(input.segmentId, "segmentId");
  const dispatchId = boundedString(input.dispatchId, "dispatchId");
  const leaseOwner = boundedString(input.leaseOwner, "leaseOwner");
  const settlementKey = boundedString(input.settlementKey, "settlementKey");
  const fenceGeneration = safeInteger(input.fenceGeneration, "fenceGeneration", MAX_COUNTER, 1);
  if (!Object.hasOwn(BOUNDARY_CLASSES, input.boundaryClass)) fail("invalid_input", "boundaryClass is invalid");
  const usage = normalizedSegmentUsage(input.usage, "dispatchUsage");
  if (usage.providerDispatches !== 1) fail("invalid_input", "a dispatch settlement must account for exactly one dispatch");
  const workspaceMutations = normalizedWorkspaceMutations(input.workspaceMutations);
  if (authorityRow.cancellation_terminal_close_grace && workspaceMutations.length > 0) {
    fail("stale_workspace", "post-deadline terminal preparation cannot reserve workspace mutations");
  }
  if (workspaceMutations.length > usage.workspaceOperations) {
    fail("invalid_input", "workspace mutation reservations exceed charged workspace operations");
  }
  if (workspaceMutations.length > 0 && input.boundaryClass !== "tool_action") {
    fail("invalid_input", "workspace mutation reservations require a tool-action boundary");
  }
  const current = rawDispatch(db, input.userId, input.executionId, dispatchId);
  if (!current || current.segment_id !== segmentId) fail("not_found", "dispatch reservation was not found");
  const logicalDispatch = numberFrom(current, "dispatch_ordinal");
  if (workspaceMutations.some((mutation) => (
    mutation.segmentId !== segmentId || mutation.logicalDispatch !== logicalDispatch
  ))) {
    fail("invalid_input", "workspace mutation ownership does not match its durable dispatch");
  }
  if (numberFrom(current, "workspace_revision") !== input.expectedWorkspaceRevision) {
    fail("stale_workspace", "dispatch settlement must precede its workspace mutations");
  }
  if (numberFrom(current, "execution_cas_revision") > input.expectedExecutionCasRevision) {
    fail("stale_execution", "dispatch settlement would regress execution CAS authority");
  }
  const settlementPayload = Object.freeze({
    version: 1,
    userId: input.userId,
    executionId: input.executionId,
    segmentId,
    dispatchId,
    settlementKey,
    boundaryClass: input.boundaryClass,
    usage,
    workspaceMutations,
    settledWorkspaceRevision: input.expectedWorkspaceRevision,
    settledExecutionCasRevision: input.expectedExecutionCasRevision,
  });
  const settlementDigest = canonicalDigest(settlementPayload);
  const reservation = dispatchMutationReservationPayload({
    version: 1,
    kind: "work_dispatch_mutation_reservation",
    userId: input.userId,
    executionId: input.executionId,
    attemptId: stringFrom(current, "attempt_id"),
    workspaceId: stringFrom(current, "workspace_id"),
    segmentId,
    dispatchId,
    fenceGeneration,
    settlementKey,
    providerSettlementDigest: settlementDigest,
    baseWorkspaceRevision: input.expectedWorkspaceRevision,
    mutations: workspaceMutations,
  });
  if (current.lifecycle === "settled") {
    const durableReservation = readDispatchMutationReservationPayload(db, {
      userId: input.userId,
      executionId: input.executionId,
      dispatchId,
    });
    if (
      current.settlement_key !== settlementKey
      || !durableReservation
      || durableReservation.reservationDigest !== reservation.payload.reservationDigest
      || durableReservation.providerSettlementDigest !== settlementDigest
    ) fail("idempotency_conflict", "dispatch settlement differs from the durable settlement");
    if (current.settlement_digest !== settlementDigest) {
      const finalization = rawDispatchEffectPayload(
        db,
        dispatchEffectRecordId("finalization", input.userId, input.executionId, dispatchId),
      ) as Partial<DispatchEffectFinalizationPayloadV1> | null;
      if (
        !finalization
        || finalization.providerSettlementDigest !== settlementDigest
        || finalization.finalizationDigest !== current.settlement_digest
      ) fail("idempotency_conflict", "dispatch settlement digest changed without exact effect finalization");
    }
    return Object.freeze({ record: dispatchFromRow(current), duplicate: true });
  }
  if (current.lifecycle !== "in_flight") fail("stale_segment", "dispatch is not in flight");
  if (input.now < numberFrom(current, "updated_at")) fail("stale_segment", "dispatch settlement time predates dispatch state");
  if (
    current.lease_owner !== leaseOwner
    || current.fence_generation !== fenceGeneration
    || (numberFrom(current, "lease_expires_at") <= input.now
      && !authorityRow.cancellation_terminal_close_grace)
  ) fail("stale_owner", "dispatch lease changed or expired");
  if (usage.billedOutputTokens > numberFrom(current, "reserved_output_tokens")) {
    fail("dispatch_budget_exhausted", "dispatch settlement exceeds its output reservation");
  }
  const recoveryReserveOutputTokensConsumed = Math.max(
    0,
    usage.billedOutputTokens - numberFrom(current, "ordinary_output_tokens_reserved"),
  );
  if (recoveryReserveOutputTokensConsumed > numberFrom(current, "recovery_reserve_output_tokens_reserved")) {
    fail("recovery_reserve_exhausted", "dispatch settlement exceeds its recovery reserve reservation");
  }
  const changed = db.query(
    "UPDATE agent_work_segment_dispatches "
      + "SET lifecycle = 'settled', lease_owner = NULL, lease_expires_at = NULL, "
      + "settlement_key = ?, settlement_digest = ?, interruption_reason = NULL, "
      + "settled_workspace_revision = ?, settled_execution_cas_revision = ?, boundary_class = ?, "
      + "provider_input_tokens = ?, provider_output_tokens = ?, provider_total_tokens = ?, billed_output_tokens = ?, "
      + "recovery_reserve_output_tokens_consumed = ?, tool_calls = ?, workspace_operations = ?, "
      + "unsigned_boundaries = ?, receive_bytes = ?, published_output_bytes = ?, settled_at = ?, updated_at = ? "
      + "WHERE user_id = ? AND execution_id = ? AND dispatch_id = ? AND segment_id = ? "
      + "AND lifecycle = 'in_flight' AND lease_owner = ? AND fence_generation = ? "
      + "AND (lease_expires_at > ? OR ? = 1)",
  ).run(
    settlementKey, settlementDigest, input.expectedWorkspaceRevision, input.expectedExecutionCasRevision,
    input.boundaryClass, usage.providerInputTokens, usage.providerOutputTokens, usage.providerTotalTokens,
    usage.billedOutputTokens, recoveryReserveOutputTokensConsumed, usage.toolCalls, usage.workspaceOperations,
    usage.unsignedBoundaries, usage.receiveBytes, usage.publishedOutputBytes, input.now, input.now,
    input.userId, input.executionId, dispatchId, segmentId, leaseOwner, fenceGeneration, input.now,
    authorityRow.cancellation_terminal_close_grace ? 1 : 0,
  ).changes;
  if (changed !== 1) fail("stale_segment", "dispatch changed before settlement");
  persistSettledDispatchUsage(db, input, segmentId, usage, recoveryReserveOutputTokensConsumed);
  insertDispatchEffectPayload(
    db,
    {
      userId: input.userId,
      chatId: stringFrom(authorityRow, "chat_id"),
      executionId: input.executionId,
      attemptId: reservation.payload.attemptId,
      segmentId,
      dispatchId,
    },
    "reservation",
    reservation.encoded.json,
    reservation.encoded.byteSize,
    input.now,
  );
  if (workspaceMutations.length === 0) {
    const noEffectFinalization = dispatchEffectFinalizationPayload({
      version: 1,
      kind: "work_dispatch_effect_finalization",
      userId: input.userId,
      executionId: input.executionId,
      attemptId: reservation.payload.attemptId,
      workspaceId: reservation.payload.workspaceId,
      segmentId,
      dispatchId,
      fenceGeneration,
      reservationDigest: reservation.payload.reservationDigest,
      providerSettlementDigest: settlementDigest,
      finalizationKey: "no-effects:" + settlementDigest,
      effects: Object.freeze([]),
      nextWorkspaceRevision: input.expectedWorkspaceRevision,
    });
    insertDispatchEffectPayload(
      db,
      {
        userId: input.userId,
        chatId: stringFrom(authorityRow, "chat_id"),
        executionId: input.executionId,
        attemptId: reservation.payload.attemptId,
        segmentId,
        dispatchId,
      },
      "finalization",
      noEffectFinalization.encoded.json,
      noEffectFinalization.encoded.byteSize,
      input.now,
    );
    const marked = db.query(
      "UPDATE agent_work_segment_dispatches SET settlement_digest = ? "
        + "WHERE user_id = ? AND execution_id = ? AND dispatch_id = ? "
        + "AND lifecycle = 'settled' AND settlement_digest = ?",
    ).run(
      noEffectFinalization.payload.finalizationDigest,
      input.userId,
      input.executionId,
      dispatchId,
      settlementDigest,
    ).changes;
    if (marked !== 1) fail("stale_segment", "dispatch changed before no-effect finalization");
  }
  const settled = rawDispatch(db, input.userId, input.executionId, dispatchId);
  if (!settled) fail("integrity_error", "settled dispatch was not observable");
  return Object.freeze({ record: dispatchFromRow(settled), duplicate: false });
}


export function persistWorkSegmentChildAssignmentAuthorityV1(
  input: PersistWorkSegmentChildAssignmentAuthorityInputV1,
): WorkSegmentWriteResult<WorkSegmentChildAssignmentAuthorityV1> {
  const db = input.db ?? getDb();
  return transaction(db, () => {
    const authorityRow = authority(db, input, true, true, true);
    const attemptId = id(input.attemptId, "attemptId");
    const workspaceId = id(input.workspaceId, "workspaceId");
    const segmentId = id(input.segmentId, "segmentId");
    const dispatchId = id(input.dispatchId, "dispatchId");
    const fenceGeneration = safeInteger(input.fenceGeneration, "fenceGeneration", MAX_COUNTER, 1);
    const expectedSettlementDigest = digest(input.expectedSettlementDigest, "expectedSettlementDigest");
    const current = rawDispatch(db, input.userId, input.executionId, dispatchId);
    const base = readDispatchMutationReservationPayload(db, {
      userId: input.userId,
      executionId: input.executionId,
      dispatchId,
    });
    if (!current
      || !base
      || current.lifecycle !== "settled"
      || current.attempt_id !== attemptId
      || current.workspace_id !== workspaceId
      || current.segment_id !== segmentId
      || current.fence_generation !== fenceGeneration
      || base.providerSettlementDigest !== expectedSettlementDigest) {
      fail("stale_segment", "child assignment authority does not match the pending settled dispatch");
    }
    const candidate = dispatchChildAssignmentAuthorityPayload({
      version: 1,
      kind: "work_dispatch_child_assignment_authority",
      userId: input.userId,
      executionId: input.executionId,
      attemptId,
      workspaceId,
      segmentId,
      dispatchId,
      fenceGeneration,
      providerSettlementDigest: expectedSettlementDigest,
      assignmentReservation: input.assignmentReservation,
      assignments: input.assignments,
    });
    if (candidate.payload.assignmentReservation.frameId !== input.executionId
      || candidate.payload.assignmentReservation.segmentId !== segmentId
      || candidate.payload.assignmentReservation.logicalDispatch !== numberFrom(current, "dispatch_ordinal")) {
      fail("invalid_input", "child assignment reservation is not owned by the root dispatch frame");
    }
    const reservation = completeDispatchMutationReservationPayload(db, base);
    const authorizedByOperationKey = new Map(reservation.mutations.map((mutation) => (
      [mutation.operationKey, mutation] as const
    )));
    const claimedReservations = [
      candidate.payload.assignmentReservation,
      ...candidate.payload.assignments.map((assignment) => assignment.settlementReservation),
    ];
    if (claimedReservations.some((claimed) => {
      const authorized = authorizedByOperationKey.get(claimed.operationKey);
      return !authorized
        || authorized.attemptedOperationDigest !== claimed.attemptedOperationDigest
        || authorized.operationKind !== claimed.operationKind
        || authorized.segmentId !== claimed.segmentId
        || authorized.logicalDispatch !== claimed.logicalDispatch
        || authorized.frameId !== claimed.frameId;
    })) fail("integrity_error", "child assignment authority is not contained by the durable reservation set");
    const existing = readDispatchChildAssignmentAuthority(db, base);
    const publicRecord = (payload: DispatchChildAssignmentAuthorityPayloadV1): WorkSegmentChildAssignmentAuthorityV1 => {
      const publicReservation = (
        mutation: DurableWorkspaceMutationReservationV1,
      ): AgenticWorkWorkspaceMutationReservationV1 => {
        const { attemptedOperationDigest: _attemptedOperationDigest, ...reservationFields } = mutation;
        return Object.freeze(reservationFields);
      };
      return Object.freeze({
        version: 1,
        assignmentReservation: publicReservation(payload.assignmentReservation),
        assignments: Object.freeze(payload.assignments.map((assignment) => Object.freeze({
          taskId: assignment.taskId,
          frameId: assignment.frameId,
          settlementReservation: publicReservation(assignment.settlementReservation),
        }))),
        authorityDigest: payload.authorityDigest,
      });
    };
    if (existing) {
      if (existing.authorityDigest !== candidate.payload.authorityDigest) {
        fail("idempotency_conflict", "child assignment authority differs from its durable record");
      }
      return Object.freeze({ record: publicRecord(existing), duplicate: true });
    }
    if (current.settlement_digest !== expectedSettlementDigest
      || readDispatchEffectFinalizationPayload(db, {
        userId: input.userId,
        executionId: input.executionId,
        dispatchId,
      })
      || rawScopedDispatchEffectPayloads(db, input.userId, attemptId, dispatchId).some((raw) => (
        !!raw && typeof raw === "object"
        && (raw as Partial<DispatchOwnerEffectFinalizationPayloadV1>).kind
          === "work_dispatch_owner_effect_finalization"
      ))) fail("stale_segment", "dispatch assignment authority is sealed by effect finalization");
    const preexistingReceipt = claimedReservations.some((reservationEntry) => db.query(
      "SELECT 1 AS present FROM agent_work_workspace_receipts WHERE user_id = ? AND execution_id = ? AND operation_key = ?",
    ).get(input.userId, input.executionId, reservationEntry.operationKey));
    if (preexistingReceipt) {
      fail("stale_segment", "child assignment authority must precede every owned workspace mutation");
    }
    insertScopedDispatchEffectPayload(
      db,
      {
        userId: input.userId,
        chatId: stringFrom(authorityRow, "chat_id"),
        executionId: input.executionId,
        attemptId,
        segmentId,
        dispatchId,
      },
      "child-assignment",
      candidate.payload.assignmentReservation.operationKey,
      candidate.encoded.json,
      candidate.encoded.byteSize,
      input.now,
    );
    return Object.freeze({ record: publicRecord(candidate.payload), duplicate: false });
  });
}

export function appendSettledWorkSegmentDispatchMutationReservationsV1(
  input: AppendSettledWorkSegmentDispatchMutationReservationsInputV1,
): WorkSegmentWriteResult<WorkSegmentWorkspaceMutationReservationAppendV1> {
  const db = input.db ?? getDb();
  return transaction(db, () => {
    const authorityRow = authority(db, input, true, false, true);
    const attemptId = id(input.attemptId, "attemptId");
    const workspaceId = id(input.workspaceId, "workspaceId");
    const segmentId = id(input.segmentId, "segmentId");
    const dispatchId = id(input.dispatchId, "dispatchId");
    const fenceGeneration = safeInteger(input.fenceGeneration, "fenceGeneration", MAX_COUNTER, 1);
    const expectedSettlementDigest = digest(input.expectedSettlementDigest, "expectedSettlementDigest");
    const appendKey = id(input.appendKey, "appendKey");
    const owner = normalizedWorkspaceMutationOwner(input.owner);
    const mutations = normalizedWorkspaceMutations(input.mutations, "mutations");
    if (mutations.length === 0 || mutations.some((mutation) => (
      mutation.segmentId !== owner.segmentId
      || mutation.logicalDispatch !== owner.logicalDispatch
      || mutation.frameId !== owner.frameId
    ))) fail("invalid_input", "reservation append must contain one exact non-empty owner scope");
    const current = rawDispatch(db, input.userId, input.executionId, dispatchId);
    const base = readDispatchMutationReservationPayload(db, {
      userId: input.userId,
      executionId: input.executionId,
      dispatchId,
    });
    if (
      !current
      || !base
      || current.lifecycle !== "settled"
      || current.attempt_id !== attemptId
      || current.workspace_id !== workspaceId
      || current.segment_id !== segmentId
      || current.fence_generation !== fenceGeneration
      || base.providerSettlementDigest !== expectedSettlementDigest
      || owner.segmentId !== segmentId
      || owner.logicalDispatch !== numberFrom(current, "dispatch_ordinal")
    ) fail("stale_segment", "reservation append does not match the pending settled dispatch");
    const appends = readDispatchMutationReservationAppends(db, base);
    const existing = appends.find((append) => append.appendKey === appendKey);
    if (existing) {
      const candidate = dispatchMutationReservationAppendPayload({
        version: 1,
        kind: "work_dispatch_mutation_reservation_append",
        userId: input.userId,
        executionId: input.executionId,
        attemptId,
        workspaceId,
        segmentId,
        dispatchId,
        fenceGeneration,
        providerSettlementDigest: expectedSettlementDigest,
        appendKey,
        appendOrdinal: existing.appendOrdinal,
        owner,
        mutations,
      }).payload;
      if (candidate.appendDigest !== existing.appendDigest) {
        fail("idempotency_conflict", "reservation append key was reused with a different payload");
      }
      return Object.freeze({
        record: Object.freeze({
          version: 1,
          appendKey,
          appendOrdinal: existing.appendOrdinal,
          owner,
          mutations,
          appendDigest: existing.appendDigest,
        }),
        duplicate: true,
      });
    }
    if (current.settlement_digest !== expectedSettlementDigest) {
      fail("stale_segment", "dispatch is no longer pending reservation appends");
    }
    if (rawScopedDispatchEffectPayloads(db, input.userId, attemptId, dispatchId).some((raw) => (
      !!raw && typeof raw === "object"
      && (raw as Partial<DispatchOwnerEffectFinalizationPayloadV1>).kind
        === "work_dispatch_owner_effect_finalization"
    ))) fail("stale_segment", "dispatch reservation set is sealed by owner finalization");
    const operationKeys = new Set([
      ...base.mutations.map((mutation) => mutation.operationKey),
      ...appends.flatMap((append) => append.mutations.map((mutation) => mutation.operationKey)),
    ]);
    if (mutations.some((mutation) => operationKeys.has(mutation.operationKey))) {
      fail("idempotency_conflict", "reservation append reuses a durable operation key");
    }
    if (operationKeys.size + mutations.length > MAX_ID_LIST_ITEMS) {
      fail("invalid_input", "dispatch reservation set exceeds its durable bound");
    }
    const workspaceOperationCharge = mutations.length;
    const segment = rawSegment(db, input.userId, input.executionId, segmentId);
    const recovery = rawRecovery(db, input.userId, input.executionId);
    if (!segment || segment.lifecycle !== "running"
      || segment.workspace_id !== workspaceId
      || !recovery || recovery.state !== "active"
      || recovery.current_segment_id !== segmentId
      || recovery.workspace_id !== workspaceId) {
      fail("stale_segment", "reservation append lost active segment accounting authority");
    }
    const dispatchWorkspaceOperations = numberFrom(current, "workspace_operations");
    const segmentWorkspaceOperations = numberFrom(segment, "workspace_operations");
    const recoveryWorkspaceOperations = numberFrom(recovery, "workspace_operations");
    if (segmentWorkspaceOperations + workspaceOperationCharge > numberFrom(segment, "max_workspace_operations")) {
      fail("segment_budget_exhausted", "reservation append exceeds the segment workspace-operation ceiling");
    }
    if (recoveryWorkspaceOperations + workspaceOperationCharge > numberFrom(recovery, "max_workspace_operations")) {
      fail("attempt_budget_exhausted", "reservation append exceeds the attempt workspace-operation ceiling");
    }
    const dispatchCharged = db.query(
      "UPDATE agent_work_segment_dispatches SET workspace_operations = workspace_operations + ? WHERE user_id = ? AND execution_id = ? AND dispatch_id = ? AND lifecycle = 'settled' AND settlement_digest = ? AND workspace_operations = ?",
    ).run(
      workspaceOperationCharge, input.userId, input.executionId, dispatchId,
      expectedSettlementDigest, dispatchWorkspaceOperations,
    ).changes;
    const segmentCharged = db.query(
      "UPDATE agent_work_segments SET workspace_operations = workspace_operations + ? WHERE user_id = ? AND execution_id = ? AND segment_id = ? AND lifecycle = 'running' AND workspace_operations = ? AND workspace_operations <= max_workspace_operations - ?",
    ).run(
      workspaceOperationCharge, input.userId, input.executionId, segmentId,
      segmentWorkspaceOperations, workspaceOperationCharge,
    ).changes;
    const recoveryCharged = db.query(
      "UPDATE agent_work_segment_recovery SET workspace_operations = workspace_operations + ? WHERE user_id = ? AND execution_id = ? AND state = 'active' AND current_segment_id = ? AND workspace_operations = ? AND workspace_operations <= max_workspace_operations - ?",
    ).run(
      workspaceOperationCharge, input.userId, input.executionId, segmentId,
      recoveryWorkspaceOperations, workspaceOperationCharge,
    ).changes;
    if (dispatchCharged !== 1 || segmentCharged !== 1 || recoveryCharged !== 1) {
      fail("stale_segment", "reservation append accounting changed concurrently");
    }
    const appended = dispatchMutationReservationAppendPayload({
      version: 1,
      kind: "work_dispatch_mutation_reservation_append",
      userId: input.userId,
      executionId: input.executionId,
      attemptId,
      workspaceId,
      segmentId,
      dispatchId,
      fenceGeneration,
      providerSettlementDigest: expectedSettlementDigest,
      appendKey,
      appendOrdinal: appends.length,
      owner,
      mutations,
    });
    insertScopedDispatchEffectPayload(
      db,
      {
        userId: input.userId,
        chatId: stringFrom(authorityRow, "chat_id"),
        executionId: input.executionId,
        attemptId,
        segmentId,
        dispatchId,
      },
      "reservation-append",
      appendKey,
      appended.encoded.json,
      appended.encoded.byteSize,
      input.now,
    );
    return Object.freeze({
      record: Object.freeze({
        version: 1,
        appendKey,
        appendOrdinal: appended.payload.appendOrdinal,
        owner,
        mutations,
        appendDigest: appended.payload.appendDigest,
      }),
      duplicate: false,
    });
  });
}
type WorkspaceMutationOwnerV1 = WorkSegmentWorkspaceMutationOwnerV1;
type OwnedSettledWorkspaceEffectV1 = WorkSettledWorkspaceEffectV1 & WorkspaceMutationOwnerV1;
function sameWorkspaceMutationOwner(
  left: WorkspaceMutationOwnerV1,
  right: WorkspaceMutationOwnerV1,
): boolean {
  return left.segmentId === right.segmentId
    && left.logicalDispatch === right.logicalDispatch
    && left.frameId === right.frameId;
}

function normalizedDispatchMutationEffects(
  db: Database,
  reservation: DispatchMutationReservationPayloadV1,
  owner: WorkSegmentWorkspaceMutationOwnerV1,
  suppliedEffects: readonly WorkSegmentWorkspaceMutationEffectV1[],
  nextWorkspaceRevision: number,
): readonly WorkSegmentWorkspaceMutationEffectV1[] {
  const normalizedOwner = normalizedWorkspaceMutationOwner(owner);
  const ownerMutations = reservation.mutations.filter((mutation) => (
    sameWorkspaceMutationOwner(mutation, normalizedOwner)
  ));
  if (ownerMutations.length === 0) fail("invalid_input", "workspace mutation owner has no durable reservation");
  if (!Array.isArray(suppliedEffects) || suppliedEffects.length !== ownerMutations.length) {
    fail("invalid_input", "workspace mutation effects do not match their ordered owner reservation");
  }
  const receipts = readSettledWorkspaceEffectsV1(
    reservation.userId,
    reservation.executionId,
    reservation.workspaceId,
    reservation.baseWorkspaceRevision,
    nextWorkspaceRevision,
    db,
  ) as readonly OwnedSettledWorkspaceEffectV1[];
  let receiptIndex = 0;
  let cursor = reservation.baseWorkspaceRevision;
  const effects: WorkSegmentWorkspaceMutationEffectV1[] = [];
  const consumeOtherOwnerReceiptsThrough = (target: number): void => {
    if (target < cursor || target > nextWorkspaceRevision) {
      fail("stale_workspace", "workspace mutation effect cursor changed");
    }
    while (cursor < target) {
      const receipt = receipts[receiptIndex];
      if (!receipt || receipt.beforeWorkspaceRevision !== cursor) {
        fail("integrity_error", "workspace receipt chain does not cover an owner effect gap");
      }
      if (sameWorkspaceMutationOwner(receipt, normalizedOwner)) {
        fail("integrity_error", "workspace receipt gap belongs to the finalized owner");
      }
      cursor = receipt.afterWorkspaceRevision;
      receiptIndex += 1;
    }
  };
  for (const [index, mutation] of ownerMutations.entries()) {
    const supplied = suppliedEffects[index];
    if (
      !supplied
      || supplied.version !== 1
      || supplied.operationKey !== mutation.operationKey
      || supplied.operationKind !== mutation.operationKind
      || !sameWorkspaceMutationOwner(supplied, mutation)
      || (supplied.outcome !== "mutated" && supplied.outcome !== "no_op" && supplied.outcome !== "failed")
    ) fail("idempotency_conflict", "workspace mutation effect order, identity, or owner changed");
    const beforeWorkspaceRevision = safeInteger(
      supplied.beforeWorkspaceRevision,
      "effects[" + index + "].beforeWorkspaceRevision",
    );
    const afterWorkspaceRevision = safeInteger(
      supplied.afterWorkspaceRevision,
      "effects[" + index + "].afterWorkspaceRevision",
    );
    consumeOtherOwnerReceiptsThrough(beforeWorkspaceRevision);
    const receipt = db.query(
      "SELECT workspace_id, operation_key, operation_digest, segment_id, logical_dispatch, frame_id, "
        + "before_workspace_revision, after_workspace_revision FROM agent_work_workspace_receipts "
        + "WHERE user_id = ? AND execution_id = ? AND operation_key = ?",
    ).get(reservation.userId, reservation.executionId, mutation.operationKey) as Row | null;
    if (receipt) {
      const receiptEffect: OwnedSettledWorkspaceEffectV1 = Object.freeze({
        version: 1,
        kind: "workspace_operation",
        state: "settled",
        operationKey: id(receipt.operation_key, "receipt.operation_key"),
        operationDigest: digest(receipt.operation_digest, "receipt.operation_digest"),
        segmentId: id(receipt.segment_id, "receipt.segment_id"),
        logicalDispatch: safeInteger(receipt.logical_dispatch, "receipt.logical_dispatch", MAX_COUNTER),
        frameId: id(receipt.frame_id, "receipt.frame_id"),
        beforeWorkspaceRevision: numberFrom(receipt, "before_workspace_revision"),
        afterWorkspaceRevision: numberFrom(receipt, "after_workspace_revision"),
      });
      const chronological = receipts[receiptIndex];
      if (
        receipt.workspace_id !== reservation.workspaceId
        || !sameWorkspaceMutationOwner(receiptEffect, mutation)
        || receiptEffect.beforeWorkspaceRevision !== cursor
        || receiptEffect.afterWorkspaceRevision !== cursor + 1
        || !chronological
        || chronological.operationKey !== receiptEffect.operationKey
        || chronological.operationDigest !== receiptEffect.operationDigest
        || !sameWorkspaceMutationOwner(chronological, receiptEffect)
        || chronological.beforeWorkspaceRevision !== receiptEffect.beforeWorkspaceRevision
        || chronological.afterWorkspaceRevision !== receiptEffect.afterWorkspaceRevision
      ) fail("integrity_error", "workspace mutation receipt is not the exact owned durable revision");
      if (supplied.outcome === "mutated") {
        if (
          supplied.operationDigest !== receiptEffect.operationDigest
          || afterWorkspaceRevision !== receiptEffect.afterWorkspaceRevision
          || supplied.outcomeCode !== null
        ) fail("integrity_error", "workspace mutation effect differs from its exact durable receipt");
      } else if (
        supplied.operationDigest !== null
        || afterWorkspaceRevision !== beforeWorkspaceRevision
      ) fail("invalid_input", "throw-after-commit marker is invalid");
      effects.push(Object.freeze({
        ...mutation,
        outcome: "mutated",
        outcomeCode: null,
        operationDigest: receiptEffect.operationDigest,
        beforeWorkspaceRevision: receiptEffect.beforeWorkspaceRevision,
        afterWorkspaceRevision: receiptEffect.afterWorkspaceRevision,
      }));
      cursor = receiptEffect.afterWorkspaceRevision;
      receiptIndex += 1;
      continue;
    }
    if (
      supplied.outcome === "mutated"
      || supplied.operationDigest !== null
      || afterWorkspaceRevision !== beforeWorkspaceRevision
    ) fail("integrity_error", "claimed workspace mutation has no exact owned durable receipt");
    const outcomeCode = supplied.outcome === "failed"
      ? boundedString(supplied.outcomeCode, "effects[" + index + "].outcomeCode")
      : supplied.outcomeCode;
    if (supplied.outcome === "no_op" && outcomeCode !== null) {
      fail("invalid_input", "no-op workspace mutation cannot carry an error outcome");
    }
    effects.push(Object.freeze({
      ...mutation,
      outcome: supplied.outcome,
      outcomeCode,
      operationDigest: null,
      beforeWorkspaceRevision,
      afterWorkspaceRevision,
    }));
  }
  consumeOtherOwnerReceiptsThrough(nextWorkspaceRevision);
  if (cursor !== nextWorkspaceRevision || receiptIndex !== receipts.length) {
    fail("integrity_error", "workspace receipt chain contains an unbound durable mutation");
  }
  return Object.freeze(effects);
}

function dispatchEffectFinalizationPayload(
  input: Omit<DispatchEffectFinalizationPayloadV1, "effects" | "finalizationDigest"> & {
    readonly effects: readonly WorkSegmentWorkspaceMutationEffectV1[];
  },
): Readonly<{ payload: DispatchEffectFinalizationPayloadV1; encoded: ReturnType<typeof canonicalEffectPayload> }> {
  const effects = Object.freeze(input.effects.map((effect) => Object.freeze({
    ...effect,
    attemptedOperationDigest: canonicalDigest({
      version: 1,
      operationKey: effect.operationKey,
      operationKind: effect.operationKind,
      segmentId: effect.segmentId,
      logicalDispatch: effect.logicalDispatch,
      frameId: effect.frameId,
    }),
  })));
  const withoutDigest = Object.freeze({ ...input, effects });
  const finalizationDigest = canonicalEffectPayload(withoutDigest).digest;
  const payload = Object.freeze({ ...withoutDigest, finalizationDigest });
  return Object.freeze({ payload, encoded: canonicalEffectPayload(payload) });
}

function dispatchOwnerEffectFinalizationPayload(
  input: Omit<DispatchOwnerEffectFinalizationPayloadV1, "effects" | "finalizationDigest"> & {
    readonly effects: readonly WorkSegmentWorkspaceMutationEffectV1[];
  },
): Readonly<{
  payload: DispatchOwnerEffectFinalizationPayloadV1;
  encoded: ReturnType<typeof canonicalEffectPayload>;
}> {
  const effects = Object.freeze(input.effects.map((effect) => Object.freeze({
    ...effect,
    attemptedOperationDigest: canonicalDigest({
      version: 1,
      operationKey: effect.operationKey,
      operationKind: effect.operationKind,
      segmentId: effect.segmentId,
      logicalDispatch: effect.logicalDispatch,
      frameId: effect.frameId,
    }),
  })));
  const withoutDigest = Object.freeze({
    ...input,
    owner: normalizedWorkspaceMutationOwner(input.owner),
    effects,
  });
  const finalizationDigest = canonicalEffectPayload(withoutDigest).digest;
  const payload = Object.freeze({ ...withoutDigest, finalizationDigest });
  return Object.freeze({ payload, encoded: canonicalEffectPayload(payload) });
}

function readDispatchEffectFinalizationPayload(
  db: Database,
  expected: Readonly<{ userId: string; executionId: string; dispatchId: string }>,
): DispatchEffectFinalizationPayloadV1 | null {
  const raw = rawDispatchEffectPayload(
    db,
    dispatchEffectRecordId("finalization", expected.userId, expected.executionId, expected.dispatchId),
  );
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") fail("integrity_error", "dispatch effect finalization is corrupt");
  const value = raw as Partial<DispatchEffectFinalizationPayloadV1>;
  if (
    value.version !== 1
    || value.kind !== "work_dispatch_effect_finalization"
    || value.userId !== expected.userId
    || value.executionId !== expected.executionId
    || value.dispatchId !== expected.dispatchId
    || !Array.isArray(value.effects)
  ) fail("integrity_error", "dispatch effect finalization identity is corrupt");
  const withoutDigest = Object.freeze({
    version: 1 as const,
    kind: "work_dispatch_effect_finalization" as const,
    userId: id(value.userId, "finalization.userId"),
    executionId: id(value.executionId, "finalization.executionId"),
    attemptId: id(value.attemptId, "finalization.attemptId"),
    workspaceId: id(value.workspaceId, "finalization.workspaceId"),
    segmentId: id(value.segmentId, "finalization.segmentId"),
    dispatchId: id(value.dispatchId, "finalization.dispatchId"),
    fenceGeneration: safeInteger(value.fenceGeneration, "finalization.fenceGeneration", MAX_COUNTER, 1),
    reservationDigest: digest(value.reservationDigest, "finalization.reservationDigest"),
    providerSettlementDigest: digest(value.providerSettlementDigest, "finalization.providerSettlementDigest"),
    finalizationKey: id(value.finalizationKey, "finalization.finalizationKey"),
    effects: value.effects,
    nextWorkspaceRevision: safeInteger(value.nextWorkspaceRevision, "finalization.nextWorkspaceRevision"),
  });
  const finalizationDigest = digest(value.finalizationDigest, "finalization.finalizationDigest");
  if (canonicalEffectPayload(withoutDigest).digest !== finalizationDigest) {
    fail("integrity_error", "dispatch effect finalization payload is corrupt");
  }
  return Object.freeze({ ...withoutDigest, finalizationDigest }) as DispatchEffectFinalizationPayloadV1;
}

function readDispatchOwnerEffectFinalizations(
  db: Database,
  reservation: DispatchMutationReservationPayloadV1,
): readonly DispatchOwnerEffectFinalizationPayloadV1[] {
  const seenOwners = new Set<string>();
  const records = rawScopedDispatchEffectPayloads(
    db,
    reservation.userId,
    reservation.attemptId,
    reservation.dispatchId,
  ).filter((raw): raw is Partial<DispatchOwnerEffectFinalizationPayloadV1> => (
    !!raw && typeof raw === "object"
    && (raw as Partial<DispatchOwnerEffectFinalizationPayloadV1>).kind
      === "work_dispatch_owner_effect_finalization"
  )).map((value) => {
    if (
      value.version !== 1
      || value.userId !== reservation.userId
      || value.executionId !== reservation.executionId
      || value.attemptId !== reservation.attemptId
      || value.workspaceId !== reservation.workspaceId
      || value.segmentId !== reservation.segmentId
      || value.dispatchId !== reservation.dispatchId
      || value.fenceGeneration !== reservation.fenceGeneration
      || value.reservationDigest !== reservation.reservationDigest
      || value.providerSettlementDigest !== reservation.providerSettlementDigest
      || !value.owner
      || !Array.isArray(value.effects)
    ) fail("integrity_error", "dispatch owner finalization identity is corrupt");
    const owner = normalizedWorkspaceMutationOwner(value.owner, "ownerFinalization.owner");
    const rebuilt = dispatchOwnerEffectFinalizationPayload({
      version: 1,
      kind: "work_dispatch_owner_effect_finalization",
      userId: reservation.userId,
      executionId: reservation.executionId,
      attemptId: reservation.attemptId,
      workspaceId: reservation.workspaceId,
      segmentId: reservation.segmentId,
      dispatchId: reservation.dispatchId,
      fenceGeneration: reservation.fenceGeneration,
      reservationDigest: reservation.reservationDigest,
      providerSettlementDigest: reservation.providerSettlementDigest,
      owner,
      finalizationKey: id(value.finalizationKey, "ownerFinalization.finalizationKey"),
      effects: value.effects,
      nextWorkspaceRevision: safeInteger(
        value.nextWorkspaceRevision,
        "ownerFinalization.nextWorkspaceRevision",
      ),
    }).payload;
    if (rebuilt.finalizationDigest !== value.finalizationDigest) {
      fail("integrity_error", "dispatch owner finalization digest is corrupt");
    }
    value.effects.forEach((effect, index) => {
      if (effect.attemptedOperationDigest !== rebuilt.effects[index]?.attemptedOperationDigest) {
        fail("integrity_error", "dispatch owner effect identity digest is corrupt");
      }
    });
    const ownerKey = workspaceMutationOwnerKey(owner);
    if (seenOwners.has(ownerKey)) fail("integrity_error", "dispatch owner was finalized more than once");
    seenOwners.add(ownerKey);
    return rebuilt;
  });
  return Object.freeze(records.sort((left, right) => (
    compareUtf8(workspaceMutationOwnerKey(left.owner), workspaceMutationOwnerKey(right.owner))
  )));
}

function normalizedCompleteOwnerEffects(
  db: Database,
  reservation: DispatchMutationReservationPayloadV1,
  ownerFinalizations: readonly DispatchOwnerEffectFinalizationPayloadV1[],
  nextWorkspaceRevision: number,
): readonly WorkSegmentWorkspaceMutationEffectV1[] {
  const requiredOwnerKeys = new Set(reservation.mutations.map((mutation) => (
    workspaceMutationOwnerKey(mutation)
  )));
  if (ownerFinalizations.length !== requiredOwnerKeys.size) {
    fail("stale_segment", "dispatch has unfinalized workspace mutation owners");
  }
  const effectsByOperationKey = new Map<string, WorkSegmentWorkspaceMutationEffectV1>();
  for (const finalization of ownerFinalizations) {
    const ownerKey = workspaceMutationOwnerKey(finalization.owner);
    if (!requiredOwnerKeys.has(ownerKey) || finalization.nextWorkspaceRevision !== nextWorkspaceRevision) {
      fail("integrity_error", "dispatch owner finalization set is inconsistent");
    }
    const effects = normalizedDispatchMutationEffects(
      db,
      reservation,
      finalization.owner,
      finalization.effects,
      nextWorkspaceRevision,
    );
    for (const effect of effects) {
      if (effectsByOperationKey.has(effect.operationKey)) {
        fail("integrity_error", "workspace mutation effect was finalized more than once");
      }
      effectsByOperationKey.set(effect.operationKey, effect);
    }
  }
  return Object.freeze(reservation.mutations.map((mutation) => {
    const effect = effectsByOperationKey.get(mutation.operationKey);
    if (!effect) fail("stale_segment", "workspace mutation effect owner is not finalized");
    return effect;
  }));
}

function assertSettledDispatchEffectsFinalized(
  db: Database,
  userId: string,
  executionId: string,
  segmentId: string,
): void {
  const rows = db.query(
    "SELECT * FROM agent_work_segment_dispatches "
      + "WHERE user_id = ? AND execution_id = ? AND segment_id = ? AND lifecycle = 'settled' "
      + "ORDER BY dispatch_ordinal ASC, dispatch_id ASC",
  ).all(userId, executionId, segmentId) as Row[];
  for (const row of rows) {
    const dispatchId = stringFrom(row, "dispatch_id");
    const baseReservation = readDispatchMutationReservationPayload(db, { userId, executionId, dispatchId });
    const finalization = readDispatchEffectFinalizationPayload(db, { userId, executionId, dispatchId });
    if (!baseReservation || !finalization) {
      fail("stale_segment", "settled dispatch workspace effects are not durably finalized");
    }
    const reservation = completeDispatchMutationReservationPayload(db, baseReservation);
    if (
      reservation.segmentId !== segmentId
      || reservation.attemptId !== row.attempt_id
      || reservation.workspaceId !== row.workspace_id
      || reservation.fenceGeneration !== row.fence_generation
      || reservation.baseWorkspaceRevision !== row.workspace_revision
      || reservation.mutations.some((mutation) => (
        mutation.segmentId !== segmentId || mutation.logicalDispatch !== numberFrom(row, "dispatch_ordinal")
      ))
      || finalization.segmentId !== segmentId
      || finalization.attemptId !== row.attempt_id
      || finalization.workspaceId !== row.workspace_id
      || finalization.fenceGeneration !== row.fence_generation
      || finalization.reservationDigest !== reservation.reservationDigest
      || finalization.providerSettlementDigest !== reservation.providerSettlementDigest
    ) fail("integrity_error", "dispatch effect finalization fence is corrupt");
    const effects = normalizedCompleteOwnerEffects(
      db,
      reservation,
      readDispatchOwnerEffectFinalizations(db, reservation),
      finalization.nextWorkspaceRevision,
    );
    const expected = dispatchEffectFinalizationPayload({
      version: 1,
      kind: "work_dispatch_effect_finalization",
      userId,
      executionId,
      attemptId: finalization.attemptId,
      workspaceId: finalization.workspaceId,
      segmentId,
      dispatchId,
      fenceGeneration: finalization.fenceGeneration,
      reservationDigest: reservation.reservationDigest,
      providerSettlementDigest: reservation.providerSettlementDigest,
      finalizationKey: finalization.finalizationKey,
      effects,
      nextWorkspaceRevision: finalization.nextWorkspaceRevision,
    }).payload;
    if (
      expected.finalizationDigest !== finalization.finalizationDigest
      || row.settlement_digest !== finalization.finalizationDigest
      || row.settled_workspace_revision !== finalization.nextWorkspaceRevision
    ) fail("integrity_error", "dispatch effect finalization digest is corrupt");
  }
}

export function finalizeSettledWorkSegmentDispatchEffectsV1(
  input: FinalizeSettledWorkSegmentDispatchEffectsInputV1,
): WorkSegmentWriteResult<WorkSegmentDispatchReservationV1> {
  const db = input.db ?? getDb();
  return transaction(db, () => finalizeSettledWorkSegmentDispatchEffectsInTransactionV1(db, input));
}

function finalizeSettledWorkSegmentDispatchEffectsInTransactionV1(
  db: Database,
  input: FinalizeSettledWorkSegmentDispatchEffectsInputV1,
): WorkSegmentWriteResult<WorkSegmentDispatchReservationV1> {
  const authorityRow = authority(db, input, true, true, true);
  const attemptId = id(input.attemptId, "attemptId");
  const workspaceId = id(input.workspaceId, "workspaceId");
  const segmentId = id(input.segmentId, "segmentId");
  const dispatchId = id(input.dispatchId, "dispatchId");
  const fenceGeneration = safeInteger(input.fenceGeneration, "fenceGeneration", MAX_COUNTER, 1);
  const expectedSettlementDigest = digest(input.expectedSettlementDigest, "expectedSettlementDigest");
  const owner = normalizedWorkspaceMutationOwner(input.owner);
  const finalizationKey = id(input.finalizationKey, "finalizationKey");
  const nextWorkspaceRevision = safeInteger(input.nextWorkspaceRevision, "nextWorkspaceRevision");
  if (workspaceId !== authorityRow.workspace_id || nextWorkspaceRevision !== input.expectedWorkspaceRevision) {
    fail("stale_workspace", "effect finalization workspace authority changed");
  }
  const current = rawDispatch(db, input.userId, input.executionId, dispatchId);
  if (
    !current
    || current.segment_id !== segmentId
    || current.attempt_id !== attemptId
    || current.workspace_id !== workspaceId
  ) fail("not_found", "settled dispatch was not found");
  if (current.lifecycle !== "settled" || current.fence_generation !== fenceGeneration) {
    fail("stale_segment", "settled dispatch fence changed before effect finalization");
  }
  const live = db.query(
    "SELECT s.lifecycle AS segment_lifecycle, r.state AS recovery_state, r.current_segment_id "
      + "FROM agent_work_segments s JOIN agent_work_segment_recovery r "
      + "ON r.user_id = s.user_id AND r.execution_id = s.execution_id AND r.attempt_id = s.attempt_id "
      + "WHERE s.user_id = ? AND s.execution_id = ? AND s.segment_id = ? AND s.attempt_id = ? AND s.workspace_id = ?",
  ).get(input.userId, input.executionId, segmentId, attemptId, workspaceId) as Row | null;
  if (!live || live.segment_lifecycle !== "running" || live.recovery_state !== "active" || live.current_segment_id !== segmentId) {
    fail("stale_segment", "effect finalization requires the exact active running segment");
  }
  const baseReservation = readDispatchMutationReservationPayload(db, {
    userId: input.userId,
    executionId: input.executionId,
    dispatchId,
  });
  if (!baseReservation) fail("integrity_error", "dispatch mutation reservation is unavailable");
  const reservation = completeDispatchMutationReservationPayload(db, baseReservation);
  if (
    reservation.attemptId !== attemptId
    || reservation.workspaceId !== workspaceId
    || reservation.segmentId !== segmentId
    || reservation.fenceGeneration !== fenceGeneration
    || reservation.providerSettlementDigest !== expectedSettlementDigest
    || owner.segmentId !== segmentId
    || owner.logicalDispatch !== numberFrom(current, "dispatch_ordinal")
    || reservation.mutations.some((mutation) => (
      mutation.segmentId !== segmentId || mutation.logicalDispatch !== numberFrom(current, "dispatch_ordinal")
    ))
  ) fail("integrity_error", "dispatch mutation reservation does not match its settlement fence");
  const effects = normalizedDispatchMutationEffects(db, reservation, owner, input.effects, nextWorkspaceRevision);
  const ownerFinalization = dispatchOwnerEffectFinalizationPayload({
    version: 1,
    kind: "work_dispatch_owner_effect_finalization",
    userId: input.userId,
    executionId: input.executionId,
    attemptId,
    workspaceId,
    segmentId,
    dispatchId,
    fenceGeneration,
    reservationDigest: reservation.reservationDigest,
    providerSettlementDigest: expectedSettlementDigest,
    owner,
    finalizationKey,
    effects,
    nextWorkspaceRevision,
  });
  const ownerKey = workspaceMutationOwnerKey(owner);
  const durableAggregate = readDispatchEffectFinalizationPayload(db, {
    userId: input.userId,
    executionId: input.executionId,
    dispatchId,
  });
  let ownerFinalizations = readDispatchOwnerEffectFinalizations(db, reservation);
  const durableOwner = ownerFinalizations.find((record) => (
    workspaceMutationOwnerKey(record.owner) === ownerKey
  ));
  let duplicate = false;
  if (durableOwner) {
    if (durableOwner.finalizationDigest !== ownerFinalization.payload.finalizationDigest) {
      fail("idempotency_conflict", "owner effect finalization differs from the durable record");
    }
    duplicate = true;
  } else {
    if (durableAggregate) fail("integrity_error", "aggregate finalization is missing a required owner");
    if (
      current.settlement_digest !== expectedSettlementDigest
      || current.settled_workspace_revision !== reservation.baseWorkspaceRevision
      || input.now < numberFrom(current, "updated_at")
    ) fail("stale_segment", "dispatch settlement changed before owner finalization");
    insertScopedDispatchEffectPayload(
      db,
      {
        userId: input.userId,
        chatId: stringFrom(authorityRow, "chat_id"),
        executionId: input.executionId,
        attemptId,
        segmentId,
        dispatchId,
      },
      "owner-finalization",
      ownerKey,
      ownerFinalization.encoded.json,
      ownerFinalization.encoded.byteSize,
      input.now,
    );
    ownerFinalizations = readDispatchOwnerEffectFinalizations(db, reservation);
  }
  const requiredOwnerCount = new Set(reservation.mutations.map((mutation) => (
    workspaceMutationOwnerKey(mutation)
  ))).size;
  if (ownerFinalizations.length < requiredOwnerCount) {
    return Object.freeze({ record: dispatchFromRow(current), duplicate });
  }
  const allEffects = normalizedCompleteOwnerEffects(
    db,
    reservation,
    ownerFinalizations,
    nextWorkspaceRevision,
  );
  const aggregateFinalizationKey = "owner-set:" + canonicalDigest(Object.freeze({
    version: 1,
    ownerFinalizationDigests: ownerFinalizations.map((record) => record.finalizationDigest),
  }));
  const aggregate = dispatchEffectFinalizationPayload({
    version: 1,
    kind: "work_dispatch_effect_finalization",
    userId: input.userId,
    executionId: input.executionId,
    attemptId,
    workspaceId,
    segmentId,
    dispatchId,
    fenceGeneration,
    reservationDigest: reservation.reservationDigest,
    providerSettlementDigest: expectedSettlementDigest,
    finalizationKey: aggregateFinalizationKey,
    effects: allEffects,
    nextWorkspaceRevision,
  });
  if (durableAggregate) {
    if (
      durableAggregate.finalizationDigest !== aggregate.payload.finalizationDigest
      || current.settlement_digest !== durableAggregate.finalizationDigest
      || current.settled_workspace_revision !== nextWorkspaceRevision
    ) fail("idempotency_conflict", "aggregate effect finalization differs from the durable record");
    return Object.freeze({ record: dispatchFromRow(current), duplicate: true });
  }
  insertDispatchEffectPayload(
    db,
    {
      userId: input.userId,
      chatId: stringFrom(authorityRow, "chat_id"),
      executionId: input.executionId,
      attemptId,
      segmentId,
      dispatchId,
    },
    "finalization",
    aggregate.encoded.json,
    aggregate.encoded.byteSize,
    input.now,
  );
  const changed = db.query(
    "UPDATE agent_work_segment_dispatches SET settlement_digest = ?, settled_workspace_revision = ?, "
      + "settled_execution_cas_revision = ?, updated_at = ? "
      + "WHERE user_id = ? AND execution_id = ? AND dispatch_id = ? AND segment_id = ? "
      + "AND lifecycle = 'settled' AND fence_generation = ? AND settlement_digest = ? AND settled_workspace_revision = ?",
  ).run(
    aggregate.payload.finalizationDigest,
    nextWorkspaceRevision,
    input.expectedExecutionCasRevision,
    input.now,
    input.userId,
    input.executionId,
    dispatchId,
    segmentId,
    fenceGeneration,
    expectedSettlementDigest,
    reservation.baseWorkspaceRevision,
  ).changes;
  if (changed !== 1) fail("stale_segment", "dispatch changed before aggregate effect finalization");
  if (authorityRow.execution_workspace_revision !== nextWorkspaceRevision) {
    const projected = db.query(
      "UPDATE agent_turn_executions SET workspace_revision = ?, updated_at = ? "
        + "WHERE id = ? AND user_id = ? AND chat_id = ? AND state = 'WORK' AND workspace_id = ? "
        + "AND cas_owner = ? AND cas_revision = ? AND cas_expires_at > ? AND workspace_revision <= ?",
    ).run(
      nextWorkspaceRevision,
      input.now,
      input.executionId,
      input.userId,
      authorityRow.chat_id,
      workspaceId,
      input.ownerToken,
      input.expectedExecutionCasRevision,
      input.now,
      nextWorkspaceRevision,
    ).changes;
    if (projected !== 1) fail("stale_execution", "execution workspace projection changed before effect finalization");
  }
  const sourceChanged = db.query(
    "UPDATE agent_work_segments SET workspace_revision = ?, execution_cas_revision = ?, updated_at = ? "
      + "WHERE user_id = ? AND execution_id = ? AND segment_id = ? AND attempt_id = ? AND workspace_id = ? "
      + "AND lifecycle = 'running' AND workspace_revision <= ? AND execution_cas_revision <= ?",
  ).run(
    nextWorkspaceRevision,
    input.expectedExecutionCasRevision,
    input.now,
    input.userId,
    input.executionId,
    segmentId,
    attemptId,
    workspaceId,
    nextWorkspaceRevision,
    input.expectedExecutionCasRevision,
  ).changes;
  const recoveryChanged = db.query(
    "UPDATE agent_work_segment_recovery SET workspace_revision = ?, execution_cas_revision = ?, updated_at = ? "
      + "WHERE user_id = ? AND execution_id = ? AND attempt_id = ? AND workspace_id = ? "
      + "AND state = 'active' AND current_segment_id = ? AND workspace_revision <= ? AND execution_cas_revision <= ?",
  ).run(
    nextWorkspaceRevision,
    input.expectedExecutionCasRevision,
    input.now,
    input.userId,
    input.executionId,
    attemptId,
    workspaceId,
    segmentId,
    nextWorkspaceRevision,
    input.expectedExecutionCasRevision,
  ).changes;
  if (sourceChanged !== 1 || recoveryChanged !== 1) {
    fail("stale_segment", "segment recovery changed before effect finalization");
  }
  const finalized = rawDispatch(db, input.userId, input.executionId, dispatchId);
  if (!finalized) fail("integrity_error", "finalized dispatch was not observable");
  return Object.freeze({ record: dispatchFromRow(finalized), duplicate });
}
export function reclaimReservedWorkSegmentDispatchV1(
  input: ReclaimReservedWorkSegmentDispatchInputV1,
): WorkSegmentDispatchReservationV1 {
  const db = input.db ?? getDb();
  return transaction(db, () => {
    authority(db, input, true);
    const segmentId = boundedString(input.segmentId, "segmentId");
    const dispatchId = boundedString(input.dispatchId, "dispatchId");
    const newLeaseOwner = boundedString(input.newLeaseOwner, "newLeaseOwner");
    const newLeaseExpiresAt = safeInteger(input.newLeaseExpiresAt, "newLeaseExpiresAt");
    if (newLeaseExpiresAt <= input.now) fail("invalid_input", "replacement lease must extend beyond reclaim time");
    const current = rawDispatch(db, input.userId, input.executionId, dispatchId);
    if (!current || current.segment_id !== segmentId) fail("not_found", "dispatch reservation was not found");
    if (current.lifecycle !== "reserved") fail("stale_segment", "only an unstarted reservation can be reclaimed");
    if (numberFrom(current, "lease_expires_at") > input.now) fail("stale_owner", "dispatch reservation lease is still active");
    if (
      current.workspace_revision !== input.expectedWorkspaceRevision
      || current.execution_cas_revision !== input.expectedExecutionCasRevision
      || input.now < numberFrom(current, "updated_at")
    ) fail("stale_execution", "dispatch reservation authority changed");
    const fenceGeneration = numberFrom(current, "fence_generation") + 1;
    safeInteger(fenceGeneration, "fenceGeneration", MAX_COUNTER, 1);
    const changed = db.query(
      `UPDATE agent_work_segment_dispatches
          SET lease_owner = ?, lease_expires_at = ?, fence_generation = ?, updated_at = ?
        WHERE user_id = ? AND execution_id = ? AND dispatch_id = ? AND segment_id = ?
          AND lifecycle = 'reserved' AND lease_expires_at <= ? AND fence_generation = ?`,
    ).run(
      newLeaseOwner, newLeaseExpiresAt, fenceGeneration, input.now,
      input.userId, input.executionId, dispatchId, segmentId, input.now, fenceGeneration - 1,
    ).changes;
    if (changed !== 1) fail("stale_segment", "dispatch reservation changed before reclaim");
    const reclaimed = rawDispatch(db, input.userId, input.executionId, dispatchId);
    if (!reclaimed) fail("integrity_error", "reclaimed dispatch was not observable");
    return dispatchFromRow(reclaimed);
  });
}

export function interruptUnsettledWorkSegmentDispatchV1(
  input: InterruptUnsettledWorkSegmentDispatchInputV1,
): WorkSegmentWriteResult<WorkSegmentDispatchReservationV1> {
  const db = input.db ?? getDb();
  return transaction(db, () => {
    authority(db, input, true);
    const segmentId = boundedString(input.segmentId, "segmentId");
    const dispatchId = boundedString(input.dispatchId, "dispatchId");
    const interruptionKey = boundedString(input.interruptionKey, "interruptionKey");
    const reason = boundedString(input.reason, "reason");
    const current = rawDispatch(db, input.userId, input.executionId, dispatchId);
    if (!current || current.segment_id !== segmentId) fail("not_found", "dispatch reservation was not found");
    const interruptionPayload = Object.freeze({
      version: 1,
      userId: input.userId,
      executionId: input.executionId,
      segmentId,
      dispatchId,
      interruptionKey,
      reason,
      boundaryClass: "provider_protocol_failure" as const,
      settledWorkspaceRevision: input.expectedWorkspaceRevision,
      settledExecutionCasRevision: input.expectedExecutionCasRevision,
    });
    const interruptionDigest = canonicalDigest(interruptionPayload);
    if (current.lifecycle === "interrupted") {
      if (current.settlement_digest !== interruptionDigest || current.interruption_reason !== reason) {
        fail("idempotency_conflict", "dispatch interruption differs from the durable interruption");
      }
      return Object.freeze({ record: dispatchFromRow(current), duplicate: true });
    }
    if (current.lifecycle !== "reserved" && current.lifecycle !== "in_flight") {
      fail("stale_segment", "only unsettled provider work can be interrupted");
    }
    if (numberFrom(current, "lease_expires_at") > input.now) fail("stale_owner", "unsettled dispatch lease is still active");
    if (
      current.workspace_revision !== input.expectedWorkspaceRevision
      || current.execution_cas_revision !== input.expectedExecutionCasRevision
      || input.now < numberFrom(current, "updated_at")
    ) fail("stale_execution", "dispatch interruption authority changed");
    const reservedOutputTokens = numberFrom(current, "reserved_output_tokens");
    const ordinaryOutputTokensReserved = numberFrom(current, "ordinary_output_tokens_reserved");
    const recoveryReserveOutputTokensConsumed = Math.max(0, reservedOutputTokens - ordinaryOutputTokensReserved);
    const usage = normalizedSegmentUsage({
      providerDispatches: 1,
      providerInputTokens: 0,
      providerOutputTokens: 0,
      providerTotalTokens: 0,
      billedOutputTokens: reservedOutputTokens,
      toolCalls: 0,
      workspaceOperations: 0,
      unsignedBoundaries: 1,
      receiveBytes: 0,
      publishedOutputBytes: 0,
    }, "interruptedDispatchUsage");
    const fenceGeneration = numberFrom(current, "fence_generation") + 1;
    safeInteger(fenceGeneration, "fenceGeneration", MAX_COUNTER, 1);
    const changed = db.query(
      `UPDATE agent_work_segment_dispatches
          SET lifecycle = 'interrupted', lease_owner = NULL, lease_expires_at = NULL,
              fence_generation = ?, settlement_digest = ?, interruption_reason = ?,
              settled_workspace_revision = ?, settled_execution_cas_revision = ?,
              boundary_class = 'provider_protocol_failure', provider_input_tokens = 0,
              provider_output_tokens = 0, provider_total_tokens = 0, billed_output_tokens = ?,
              recovery_reserve_output_tokens_consumed = ?, tool_calls = 0, workspace_operations = 0,
              unsigned_boundaries = 1, receive_bytes = 0, published_output_bytes = 0,
              settled_at = ?, updated_at = ?
        WHERE user_id = ? AND execution_id = ? AND dispatch_id = ? AND segment_id = ?
          AND lifecycle IN ('reserved', 'in_flight') AND lease_expires_at <= ? AND fence_generation = ?`,
    ).run(
      fenceGeneration, interruptionDigest, reason,
      input.expectedWorkspaceRevision, input.expectedExecutionCasRevision,
      reservedOutputTokens, recoveryReserveOutputTokensConsumed, input.now, input.now,
      input.userId, input.executionId, dispatchId, segmentId, input.now, fenceGeneration - 1,
    ).changes;
    if (changed !== 1) fail("stale_segment", "unsettled dispatch changed before interruption");
    persistSettledDispatchUsage(db, input, segmentId, usage, recoveryReserveOutputTokensConsumed);
    const interrupted = rawDispatch(db, input.userId, input.executionId, dispatchId);
    if (!interrupted) fail("integrity_error", "interrupted dispatch was not observable");
    return Object.freeze({ record: dispatchFromRow(interrupted), duplicate: false });
  });
}

function aggregateSettledDispatches(db: Database, userId: string, executionId: string, segmentId: string): WorkSegmentUsageV1 {
  assertSettledDispatchEffectsFinalized(db, userId, executionId, segmentId);
  const unsettled = db.query(
    `SELECT COUNT(*) AS count FROM agent_work_segment_dispatches
      WHERE user_id = ? AND execution_id = ? AND segment_id = ?
        AND lifecycle NOT IN ('settled', 'interrupted')`,
  ).get(userId, executionId, segmentId) as Row;
  if (numberFrom(unsettled, "count") !== 0) fail("stale_segment", "segment has an unsettled dispatch");
  const rows = db.query(
    `SELECT * FROM agent_work_segment_dispatches
      WHERE user_id = ? AND execution_id = ? AND segment_id = ? ORDER BY dispatch_ordinal`,
  ).all(userId, executionId, segmentId) as Row[];
  return rows.reduce((total, row) => {
    const usage = usageFrom(row, true);
    if (!usage) fail("integrity_error", "settled dispatch usage is missing");
    return addUsage(total, usage);
  }, zeroUsage());
}

interface NormalizedTransitionTargetV1 {
  readonly targetPhaseId: string | null;
  readonly targetPhaseIndex: number | null;
  readonly targetPhaseOccurrence: number | null;
  readonly targetSegmentOrdinal: number | null;
}

function normalizeTransitionTarget(input: CommitWorkSegmentTransitionInputV1): NormalizedTransitionTargetV1 {
  if (!Object.hasOwn(TRANSITION_KINDS, input.transitionKind)) fail("invalid_input", "transitionKind is invalid");
  if (input.transitionKind === "terminal") {
    if (
      input.targetPhaseId !== null
      || input.targetPhaseIndex !== null
      || input.targetPhaseOccurrence !== null
      || input.targetSegmentOrdinal !== null
    ) fail("invalid_input", "terminal transition cannot name a target segment");
    return Object.freeze({ targetPhaseId: null, targetPhaseIndex: null, targetPhaseOccurrence: null, targetSegmentOrdinal: null });
  }
  return Object.freeze({
    targetPhaseId: normalizedNullablePhaseId(input.targetPhaseId, "targetPhaseId"),
    targetPhaseIndex: safeInteger(input.targetPhaseIndex, "targetPhaseIndex", MAX_ORDINAL),
    targetPhaseOccurrence: safeInteger(input.targetPhaseOccurrence, "targetPhaseOccurrence", MAX_ORDINAL),
    targetSegmentOrdinal: safeInteger(input.targetSegmentOrdinal, "targetSegmentOrdinal", MAX_ORDINAL),
  });
}

function validateTransitionSemantics(
  source: WorkSegmentAdmissionV1,
  kind: WorkSegmentTransitionKindV1,
  target: NormalizedTransitionTargetV1,
  closeResult: WorkSegmentRunnerResultV1["kind"],
): void {
  const resultMatches = (kind === "advance" && closeResult === "phase_advanced")
    || (kind === "repeat" && closeResult === "phase_repeated")
    || (kind === "rollover" && closeResult === "same_phase_rollover")
    || (kind === "terminal" && closeResult === "work_complete");
  if (!resultMatches) fail("invalid_input", "transition kind and segment result disagree");
  if (kind === "terminal") return;
  if (target.targetSegmentOrdinal !== source.identity.segmentOrdinal + 1) fail("invalid_input", "transition target ordinal is not contiguous");
  if (kind === "rollover" && (
    target.targetPhaseId !== source.identity.phaseId
    || target.targetPhaseIndex !== source.identity.phaseIndex
    || target.targetPhaseOccurrence !== source.identity.phaseOccurrence
  )) fail("invalid_input", "recovery rollover must retain the authored phase occurrence");
  if (kind === "repeat" && (
    target.targetPhaseId !== source.identity.phaseId
    || target.targetPhaseIndex !== source.identity.phaseIndex
    || target.targetPhaseOccurrence !== source.identity.phaseOccurrence + 1
  )) fail("invalid_input", "authored repeat must increment the phase occurrence");
  if (kind === "advance" && target.targetPhaseIndex! <= source.identity.phaseIndex) {
    fail("invalid_input", "authored advance must strictly increase the phase index");
  }
}

function validateTransitionPlanAuthority(
  recovery: WorkSegmentAttemptRecoveryV1,
  source: WorkSegmentAdmissionV1,
  kind: WorkSegmentTransitionKindV1,
  target: NormalizedTransitionTargetV1,
  remainingRequiredPhaseCount: number,
  phasePlanDigest: string,
): void {
  if (phasePlanDigest !== recovery.phasePlanDigest || computeWorkPhasePlanDigestV1(recovery.phasePlan) !== phasePlanDigest) {
    fail("integrity_error", "transition phase plan authority does not match the durable attempt");
  }
  const phases = recovery.phasePlan.phases;
  const sourceEntry = phases[source.identity.phaseIndex];
  if (phases.length === 0) {
    if (source.identity.phaseId !== null || source.identity.phaseIndex !== 0 || kind === "advance" || kind === "repeat") {
      fail("invalid_input", "built-in WORK has no authored phase transition");
    }
  } else if (source.identity.phaseId === null) {
    if (kind !== "terminal"
      || source.identity.phaseIndex !== 0
      || source.identity.phaseOccurrence !== 0
      || source.identity.segmentOrdinal !== 0
      || source.sourceTransitionId !== null) {
      fail("invalid_input", "authored null-phase source may only terminally close its initial built-in Segment");
    }
    assertAtomicSegmentSkipAuthorityV1(
      source.context,
      recovery.phasePlan,
      source.sourceTransitionId,
      source.identity.segmentOrdinal,
    );
    if (remainingRequiredPhaseCount !== 0) {
      fail("invalid_input", "all-skipped terminal transition retains required phases");
    }
    return;
  } else if (!sourceEntry || sourceEntry.id !== source.identity.phaseId) {
    fail("integrity_error", "source segment is not bound to the immutable phase plan");
  }
  const requireImmediateEdgeWalk = (lastPhaseIndex: number, message: string): void => {
    for (let phaseIndex = source.identity.phaseIndex; phaseIndex < lastPhaseIndex; phaseIndex += 1) {
      const from = phases[phaseIndex];
      const to = phases[phaseIndex + 1];
      if (!from || !to || !from.nextPhaseIds.includes(to.id)) fail("invalid_input", message);
    }
  };
  if (kind === "terminal") {
    if (remainingRequiredPhaseCount !== 0) fail("invalid_input", "terminal transition retains required phases");
    requireImmediateEdgeWalk(phases.length - 1, "terminal path is not allowed by the immutable phase graph");
    if (phases.slice(source.identity.phaseIndex + 1).some((phase) => phase.required || phase.skipEligibilityDigest === null)) {
      fail("invalid_input", "terminal transition skips a phase without deterministic eligibility authority");
    }
    return;
  }
  if (kind === "rollover") {
    if (remainingRequiredPhaseCount !== recovery.remainingRequiredPhaseCount) {
      fail("invalid_input", "rollover cannot alter required phase authority");
    }
    return;
  }
  if (kind === "repeat") {
    if (!sourceEntry || target.targetPhaseOccurrence! > sourceEntry.repeatLimit) {
      fail("invalid_input", "authored repeat exceeds the immutable phase repeat limit");
    }
    if (remainingRequiredPhaseCount !== recovery.remainingRequiredPhaseCount) {
      fail("invalid_input", "repeat cannot alter required phase authority");
    }
    return;
  }
  const targetIndex = target.targetPhaseIndex!;
  const targetEntry = phases[targetIndex];
  if (!targetEntry || targetEntry.id !== target.targetPhaseId || target.targetPhaseOccurrence !== 0) {
    fail("invalid_input", "advance target is not an exact authored phase occurrence");
  }
  requireImmediateEdgeWalk(targetIndex, "advance path is not allowed by the immutable phase graph");
  if (phases.slice(source.identity.phaseIndex + 1, targetIndex).some((phase) => phase.required || phase.skipEligibilityDigest === null)) {
    fail("invalid_input", "advance skips a phase without deterministic eligibility authority");
  }
  const exactRemaining = phases.slice(targetIndex + 1).filter((phase) => phase.required).length;
  if (remainingRequiredPhaseCount !== exactRemaining) {
    fail("invalid_input", "advance future required phase count is not bound to the authored plan");
  }
}

function closeLifecycle(result: WorkSegmentRunnerResultV1["kind"]): WorkSegmentAdmissionV1["lifecycle"] {
  switch (result) {
    case "failed": return "failed";
    case "exhausted": return "exhausted";
    case "cancelled": return "cancelled";
    default: return "closed";
  }
}

function hostWorkspaceHandoffIds(db: Database, userId: string, executionId: string, workspaceId: string): {
  readonly acceptedIds: Omit<WorkHandoffAcceptedIdsV1, "authority">;
  readonly openRequiredIds: readonly string[];
} {
  const ids = (sql: string, field: string): readonly string[] => {
    const rows = db.query(sql).all(userId, executionId, workspaceId) as Array<{ id: string }>;
    if (rows.length > MAX_ID_LIST_ITEMS) fail("segment_budget_exhausted", field + " exceeds the durable handoff bound");
    return normalizedIds(rows.map((row) => row.id), field);
  };
  return Object.freeze({
    acceptedIds: Object.freeze({
      taskIds: ids("SELECT t.task_id AS id FROM agent_workspace_tasks t WHERE t.user_id = ? AND t.turn_id = ? AND t.workspace_id = ? AND t.state = 'completed' AND EXISTS (SELECT 1 FROM agent_workspace_submissions s WHERE s.user_id = t.user_id AND s.turn_id = t.turn_id AND s.workspace_id = t.workspace_id AND s.task_id = t.task_id AND s.state = 'accepted') ORDER BY t.task_id LIMIT 129", "acceptedIds.taskIds"),
      submissionIds: ids("SELECT submission_id AS id FROM agent_workspace_submissions WHERE user_id = ? AND turn_id = ? AND workspace_id = ? AND state = 'accepted' ORDER BY submission_id LIMIT 129", "acceptedIds.submissionIds"),
      findingIds: ids("SELECT record_id AS id FROM agent_workspace_records WHERE user_id = ? AND turn_id = ? AND workspace_id = ? AND kind = 'finding' ORDER BY record_id LIMIT 129", "acceptedIds.findingIds"),
      decisionIds: ids("SELECT record_id AS id FROM agent_workspace_records WHERE user_id = ? AND turn_id = ? AND workspace_id = ? AND kind = 'decision' ORDER BY record_id LIMIT 129", "acceptedIds.decisionIds"),
      artifactIds: ids("SELECT artifact_id AS id FROM agent_workspace_artifacts WHERE user_id = ? AND turn_id = ? AND workspace_id = ? ORDER BY artifact_id LIMIT 129", "acceptedIds.artifactIds"),
    }),
    openRequiredIds: ids("SELECT t.task_id AS id FROM agent_workspace_tasks t WHERE t.user_id = ? AND t.turn_id = ? AND t.workspace_id = ? AND t.required = 1 AND NOT (t.state = 'completed' AND EXISTS (SELECT 1 FROM agent_workspace_submissions s WHERE s.user_id = t.user_id AND s.turn_id = t.turn_id AND s.workspace_id = t.workspace_id AND s.task_id = t.task_id AND s.state = 'accepted')) ORDER BY t.task_id LIMIT 129", "openRequiredIds"),
  });
}

export function commitWorkSegmentTransitionV1(
  input: CommitWorkSegmentTransitionInputV1,
): WorkSegmentWriteResult<WorkPhaseTransitionReceiptV1> {
  const db = input.db ?? getDb();
  return transaction(db, () => commitWorkSegmentTransitionInTransactionV1(db, input));
}

export function commitWorkSegmentTransitionInTransactionV1(
  db: Database,
  input: CommitWorkSegmentTransitionInputV1,
): WorkSegmentWriteResult<WorkPhaseTransitionReceiptV1> {
  const authorityRow = authority(db, input, true, false, input.transitionKind === "terminal");
  const sourceSegmentId = boundedString(input.sourceSegmentId, "sourceSegmentId");
  const attemptId = boundedString(input.attemptId, "attemptId");
  const workspaceId = boundedString(input.workspaceId, "workspaceId");
  const idempotencyKey = boundedString(input.idempotencyKey, "idempotencyKey");
  const phasePlanDigest = digest(input.phasePlanDigest, "phasePlanDigest");
  const transitionDecisionDigest = digest(input.transitionDecisionDigest, "transitionDecisionDigest");
  if (workspaceId !== authorityRow.workspace_id) fail("stale_workspace", "workspace identity changed");
  if (!Object.hasOwn(BOUNDARY_CLASSES, input.boundaryClass)) fail("invalid_input", "boundaryClass is invalid");
  const target = normalizeTransitionTarget(input);
  const usage = normalizedSegmentUsage(input.usage);
  const remainingRequiredPhaseCount = safeInteger(
    input.remainingRequiredPhaseCount,
    "remainingRequiredPhaseCount",
    MAX_ORDINAL,
  );
  const { acceptedIds, openRequiredIds } = hostWorkspaceHandoffIds(
    db,
    authorityRow.user_id,
    authorityRow.execution_id,
    workspaceId,
  );
  const completion = Object.freeze({
    summary: boundedString(input.completion.summary, "completion.summary", MAX_SUMMARY_BYTES),
    unresolvedIds: normalizedIds(input.completion.unresolvedIds, "completion.unresolvedIds"),
    renderGuidance: input.completion.renderGuidance === null
      ? null
      : boundedString(input.completion.renderGuidance, "completion.renderGuidance", MAX_GUIDANCE_BYTES, true),
  });
  const payloadBase = Object.freeze({
    version: 1,
    userId: authorityRow.user_id,
    executionId: authorityRow.execution_id,
    transitionDecisionDigest,
    attemptId,
    workspaceId,
    workspaceRevision: input.expectedWorkspaceRevision,
    executionCasRevision: input.expectedExecutionCasRevision,
    sourceSegmentId,
    idempotencyKey,
    phasePlanDigest,
    transitionKind: input.transitionKind,
    ...target,
    boundaryClass: input.boundaryClass,
    closeResult: input.closeResult,
    remainingRequiredPhaseCount,
    usage,
    acceptedIds,
    openRequiredIds,
    completion,
  });
  const duplicate = rawTransitionByKey(db, authorityRow.user_id, authorityRow.execution_id, idempotencyKey);
  if (duplicate) {
    const duplicatePayloadDigest = canonicalDigest(Object.freeze({
      ...payloadBase,
      releasedFuturePhaseReserveOutputTokens: numberFrom(duplicate, "released_future_phase_reserve_output_tokens"),
    }));
    if (stringFrom(duplicate, "payload_digest") !== duplicatePayloadDigest || duplicate.source_segment_id !== sourceSegmentId) {
      fail("idempotency_conflict", "transition key was reused with a different payload");
    }
    const sourceRow = rawSegment(db, authorityRow.user_id, authorityRow.execution_id, sourceSegmentId);
    if (!sourceRow) fail("integrity_error", "transition source segment is missing");
    return Object.freeze({ record: transitionFromRow(duplicate, segmentFromRow(sourceRow)), duplicate: true });
  }
  const sourceRow = rawSegment(db, authorityRow.user_id, authorityRow.execution_id, sourceSegmentId);
  if (!sourceRow) fail("not_found", "source segment was not found");
  const source = segmentFromRow(sourceRow);
  if (
    source.lifecycle !== "running"
    || source.identity.attemptId !== attemptId
    || source.workspaceId !== workspaceId
  ) fail("stale_segment", "source segment is not running under this attempt");
  const expectedTransitionDecisionDigest = computeWorkTransitionDecisionDigestV1({
    phasePlanDigest,
    source: source.identity,
    transitionKind: input.transitionKind,
    ...target,
  });
  if (transitionDecisionDigest !== expectedTransitionDecisionDigest) {
    fail("invalid_input", "transition decision is not bound to the immutable phase plan and exact segment identities");
  }
  validateTransitionSemantics(source, input.transitionKind, target, input.closeResult);
  const dispatchUsage = aggregateSettledDispatches(db, authorityRow.user_id, authorityRow.execution_id, sourceSegmentId);
  for (const field of [
    "providerDispatches", "providerInputTokens", "providerOutputTokens", "providerTotalTokens",
    "billedOutputTokens", "toolCalls", "workspaceOperations", "unsignedBoundaries", "receiveBytes", "publishedOutputBytes",
  ] as const) {
    if (usage[field] !== dispatchUsage[field] || usage[field] !== source.usage[field]) {
      fail("integrity_error", "segment " + field + " does not match its atomic dispatch ledger");
    }
  }
  const workspaceRevisionDelta = input.expectedWorkspaceRevision - source.workspaceRevision;
  if (workspaceRevisionDelta < 0) {
    fail("integrity_error", "workspace authority regressed below the admitted revision");
  }
  // workspaceOperations counts admitted workspace tool calls, including reads.
  // Exact mutation state is fenced independently by authority()'s workspace CAS;
  // accepted durable IDs and the transition receipt bind the effects that crossed.
  enforceSegmentBudget(usage, source.budget);
  const finalDispatch = db.query(
    `SELECT boundary_class FROM agent_work_segment_dispatches
      WHERE user_id = ? AND execution_id = ? AND segment_id = ?
      ORDER BY dispatch_ordinal DESC LIMIT 1`,
  ).get(authorityRow.user_id, authorityRow.execution_id, sourceSegmentId) as Row | null;
  if (!finalDispatch || nullableStringFrom(finalDispatch, "boundary_class") !== input.boundaryClass) {
    fail("integrity_error", "transition boundary does not match the final durable dispatch boundary");
  }
  const recoveryRow = rawRecovery(db, authorityRow.user_id, authorityRow.execution_id);
  if (!recoveryRow) fail("not_found", "segment attempt was not found");
  const recovery = recoveryFromRow(recoveryRow);
  if (
    recovery.state !== "active"
    || recovery.attemptId !== attemptId
    || recovery.workspaceId !== workspaceId
    || recovery.currentSegmentId !== sourceSegmentId
    || recovery.phaseId !== source.identity.phaseId
    || recovery.phaseIndex !== source.identity.phaseIndex
    || recovery.phaseOccurrence !== source.identity.phaseOccurrence
    || source.snapshotDigest !== recovery.snapshotDigest
    || source.bindingDigest !== recovery.bindingDigest
    || recovery.nextSegmentOrdinal !== source.identity.segmentOrdinal
    || input.now < recovery.updatedAt
  ) fail("stale_segment", "attempt cursor does not match the source segment");
  validateTransitionPlanAuthority(
    recovery,
    source,
    input.transitionKind,
    target,
    remainingRequiredPhaseCount,
    phasePlanDigest,
  );
  if (input.transitionKind === "terminal") {
    if (remainingRequiredPhaseCount !== 0) fail("invalid_input", "terminal transition must release all future phase reserve");
  } else if (input.transitionKind === "repeat" || input.transitionKind === "rollover") {
    if (remainingRequiredPhaseCount !== recovery.remainingRequiredPhaseCount) {
      fail("invalid_input", "repeat and rollover cannot release or reset future phase reserve");
    }
  } else if (remainingRequiredPhaseCount > recovery.remainingRequiredPhaseCount) {
    fail("invalid_input", "authored advance cannot increase remaining required phases");
  }
  if (target.targetSegmentOrdinal !== null && target.targetSegmentOrdinal >= recovery.budget.maxSegments) {
    fail("attempt_budget_exhausted", "transition target exceeds the attempt segment ceiling");
  }
  const protectedFuturePhaseReserveOutputTokens = recovery.initialRequiredPhaseCount === 0
    ? 0
    : Math.ceil(
      recovery.budget.futurePhaseReserveOutputTokens
      * remainingRequiredPhaseCount
      / recovery.initialRequiredPhaseCount,
    );
  if (protectedFuturePhaseReserveOutputTokens > recovery.protectedFuturePhaseReserveOutputTokens) {
    fail("integrity_error", "transition would reset previously released future phase reserve");
  }
  const releasedFuturePhaseReserveOutputTokens = recovery.protectedFuturePhaseReserveOutputTokens
    - protectedFuturePhaseReserveOutputTokens;
  const payloadDigest = canonicalDigest(Object.freeze({
    ...payloadBase,
    releasedFuturePhaseReserveOutputTokens,
  }));
  enforceAttemptBudget(recovery.usage.segments, recovery.usage, recovery.budget);
  const transitionId = deterministicId("transition", authorityRow.user_id, authorityRow.execution_id, idempotencyKey);
  insertRow(db, "agent_work_segment_transitions", {
    transition_id: transitionId,
    user_id: authorityRow.user_id,
    execution_id: authorityRow.execution_id,
    attempt_id: attemptId,
    workspace_id: workspaceId,
    workspace_revision: input.expectedWorkspaceRevision,
    execution_cas_revision: input.expectedExecutionCasRevision,
    source_segment_id: sourceSegmentId,
    transition_kind: input.transitionKind,
    target_phase_id: target.targetPhaseId,
    target_phase_index: target.targetPhaseIndex,
    target_phase_occurrence: target.targetPhaseOccurrence,
    target_segment_ordinal: target.targetSegmentOrdinal,
    remaining_required_phase_count: remainingRequiredPhaseCount,
    released_future_phase_reserve_output_tokens: releasedFuturePhaseReserveOutputTokens,
    idempotency_key: idempotencyKey,
    phase_plan_digest: phasePlanDigest,
    transition_decision_digest: transitionDecisionDigest,
    payload_digest: payloadDigest,
    schema_version: 1,
    record_complete: 1,
    advisory_authority: "model_advisory",
    advisory_summary: completion.summary,
    advisory_unresolved_ids_json: JSON.stringify(completion.unresolvedIds),
    advisory_render_guidance: completion.renderGuidance,
    accepted_ids_authority: "host",
    accepted_task_ids_json: JSON.stringify(acceptedIds.taskIds),
    accepted_submission_ids_json: JSON.stringify(acceptedIds.submissionIds),
    accepted_finding_ids_json: JSON.stringify(acceptedIds.findingIds),
    accepted_decision_ids_json: JSON.stringify(acceptedIds.decisionIds),
    accepted_artifact_ids_json: JSON.stringify(acceptedIds.artifactIds),
    open_required_ids_json: JSON.stringify(openRequiredIds),
    created_at: input.now,
  });
  const lifecycle = closeLifecycle(input.closeResult);
  const segmentChanged = db.query(
    `UPDATE agent_work_segments
        SET lifecycle = ?, boundary_class = ?, close_result = ?, close_reason = ?,
            closed_workspace_revision = ?, closed_execution_cas_revision = ?,
            closure_digest = ?, updated_at = ?, closed_at = ?
      WHERE user_id = ? AND execution_id = ? AND segment_id = ? AND lifecycle = 'running'
        AND workspace_revision <= ? AND execution_cas_revision <= ?`,
  ).run(
    lifecycle, input.boundaryClass, input.closeResult, "transition:" + input.transitionKind,
    input.expectedWorkspaceRevision, input.expectedExecutionCasRevision,
    payloadDigest, input.now, input.now, authorityRow.user_id, authorityRow.execution_id, sourceSegmentId,
    input.expectedWorkspaceRevision, input.expectedExecutionCasRevision,
  ).changes;
  if (segmentChanged !== 1) fail("stale_segment", "source segment changed before closure");
  const terminal = input.transitionKind === "terminal";
  const recoveryChanged = db.query(
    `UPDATE agent_work_segment_recovery
        SET workspace_revision = ?, execution_cas_revision = ?, state = ?, current_segment_id = NULL,
            phase_id = ?, phase_index = ?, phase_occurrence = ?, next_segment_ordinal = ?,
            remaining_required_phase_count = ?, protected_future_phase_reserve_output_tokens = ?,
            terminal_close_result = NULL, terminal_close_reason = NULL, terminal_boundary_class = NULL,
            updated_at = ?
      WHERE user_id = ? AND execution_id = ? AND state = 'active'
        AND current_segment_id = ? AND next_segment_ordinal = ?
        AND workspace_revision <= ? AND execution_cas_revision <= ? AND updated_at <= ?`,
  ).run(
    input.expectedWorkspaceRevision, input.expectedExecutionCasRevision,
    terminal ? "closed" : "active",
    target.targetPhaseId, target.targetPhaseIndex, target.targetPhaseOccurrence,
    target.targetSegmentOrdinal ?? source.identity.segmentOrdinal + 1,
    remainingRequiredPhaseCount, protectedFuturePhaseReserveOutputTokens,
    input.now, authorityRow.user_id, authorityRow.execution_id, sourceSegmentId,
    source.identity.segmentOrdinal, input.expectedWorkspaceRevision, input.expectedExecutionCasRevision, input.now,
  ).changes;
  if (recoveryChanged !== 1) fail("stale_segment", "attempt changed before transition commit");
  const transitionRow = rawTransitionByKey(db, authorityRow.user_id, authorityRow.execution_id, idempotencyKey);
  const closedRow = rawSegment(db, authorityRow.user_id, authorityRow.execution_id, sourceSegmentId);
  if (!transitionRow || !closedRow) fail("integrity_error", "committed transition was not observable");
  return Object.freeze({ record: transitionFromRow(transitionRow, segmentFromRow(closedRow)), duplicate: false });
}
export function commitAndAdmitWorkSegmentTransitionV1(
  input: CommitAndAdmitWorkSegmentTransitionInputV1,
): CommitAndAdmitWorkSegmentTransitionResultV1 {
  if (input.transition.transitionKind === "terminal") fail("invalid_input", "terminal transition cannot admit a successor segment");
  const db = input.transition.db ?? getDb();
  return transaction(db, () => {
    const transition = commitWorkSegmentTransitionInTransactionV1(db, { ...input.transition, db });
    const context = normalizedSegmentContext(input.makeTargetContext(transition.record.handoff), "targetContext");
    const admission = admitWorkSegmentInTransactionV1(db, {
      userId: input.transition.userId,
      executionId: input.transition.executionId,
      ownerToken: input.transition.ownerToken,
      expectedExecutionCasRevision: input.transition.expectedExecutionCasRevision,
      expectedWorkspaceRevision: input.transition.expectedWorkspaceRevision,
      now: input.transition.now,
      db,
      attemptId: input.transition.attemptId,
      workspaceId: input.transition.workspaceId,
      sourceTransitionId: transition.record.transitionId,
      phaseId: input.target.phaseId,
      phaseIndex: input.target.phaseIndex,
      phaseOccurrence: input.target.phaseOccurrence,
      segmentOrdinal: input.target.segmentOrdinal,
      admissionKey: input.target.admissionKey,
      contextDigest: context.contextDigest,
      context,
      budget: input.target.budget,
    });
    return Object.freeze({ transition, admission, context });
  });
}

export function closeWorkSegmentTerminalV1(
  input: CloseWorkSegmentTerminalInputV1,
): WorkSegmentWriteResult<WorkSegmentAttemptRecoveryV1> {
  const db = input.db ?? getDb();
  return transaction(db, () => {
    const authorityRow = authority(db, input, true, false, true, true);
    const attemptId = boundedString(input.attemptId, "attemptId");
    const workspaceId = boundedString(input.workspaceId, "workspaceId");
    const sourceSegmentId = boundedString(input.sourceSegmentId, "sourceSegmentId");
    const idempotencyKey = boundedString(input.idempotencyKey, "idempotencyKey");
    const closeReason = boundedString(input.closeReason, "closeReason");
    if (workspaceId !== authorityRow.workspace_id) fail("stale_workspace", "workspace identity changed");
    if (!(["failed", "exhausted", "cancelled"] as const).includes(input.closeResult)) {
      fail("invalid_input", "terminal close result is invalid");
    }
    if (input.boundaryClass !== null && !Object.hasOwn(BOUNDARY_CLASSES, input.boundaryClass)) {
      fail("invalid_input", "boundaryClass is invalid");
    }
    const usage = normalizedSegmentUsage(input.usage);
    const payload = Object.freeze({
      version: 1,
      userId: authorityRow.user_id,
      executionId: authorityRow.execution_id,
      attemptId,
      workspaceId,
      sourceSegmentId,
      idempotencyKey,
      closeResult: input.closeResult,
      closeReason,
      boundaryClass: input.boundaryClass,
      usage,
      workspaceRevision: input.expectedWorkspaceRevision,
      executionCasRevision: input.expectedExecutionCasRevision,
    });
    const payloadDigest = canonicalDigest(payload);
    const sourceRow = rawSegment(db, authorityRow.user_id, authorityRow.execution_id, sourceSegmentId);
    const recoveryRow = rawRecovery(db, authorityRow.user_id, authorityRow.execution_id);
    if (!sourceRow || !recoveryRow) fail("not_found", "terminal segment attempt was not found");
    const source = segmentFromRow(sourceRow);
    const recovery = recoveryFromRow(recoveryRow);
    if (recovery.state === "closed" && source.lifecycle === closeLifecycle(input.closeResult)) {
      if (
        source.closureDigest !== payloadDigest
        || source.closeResult !== input.closeResult
        || source.closeReason !== closeReason
      ) fail("idempotency_conflict", "terminal close key differs from the durable close");
      return Object.freeze({ record: recovery, duplicate: true });
    }
    if (
      recovery.state !== "active"
      || recovery.attemptId !== attemptId
      || recovery.workspaceId !== workspaceId
      || recovery.currentSegmentId !== sourceSegmentId
      || source.identity.attemptId !== attemptId
      || source.workspaceId !== workspaceId
      || source.lifecycle !== "running"
      || input.now < recovery.updatedAt
      || input.now < source.updatedAt
    ) fail("stale_segment", "terminal close no longer owns the current running segment");
    const dispatchUsage = aggregateSettledDispatches(db, authorityRow.user_id, authorityRow.execution_id, sourceSegmentId);
    for (const field of [
      "providerDispatches", "providerInputTokens", "providerOutputTokens", "providerTotalTokens",
      "billedOutputTokens", "toolCalls", "workspaceOperations", "unsignedBoundaries", "receiveBytes", "publishedOutputBytes",
    ] as const) {
      if (usage[field] !== dispatchUsage[field] || usage[field] !== source.usage[field]) {
        fail("integrity_error", "segment " + field + " does not match its atomic dispatch ledger");
      }
    }
    const finalDispatch = db.query(
      `SELECT boundary_class FROM agent_work_segment_dispatches
        WHERE user_id = ? AND execution_id = ? AND segment_id = ?
        ORDER BY dispatch_ordinal DESC LIMIT 1`,
    ).get(authorityRow.user_id, authorityRow.execution_id, sourceSegmentId) as Row | null;
    const finalBoundary = finalDispatch ? nullableStringFrom(finalDispatch, "boundary_class") : null;
    if (finalBoundary !== input.boundaryClass) {
      fail("integrity_error", "terminal boundary does not match the final durable dispatch boundary");
    }
    const workspaceRevisionDelta = input.expectedWorkspaceRevision - source.workspaceRevision;
    if (workspaceRevisionDelta < 0) {
      fail("integrity_error", "workspace authority regressed below the admitted revision");
    }
    // Read-only workspace operations consume operation budget without advancing
    // the workspace revision. The authority/CAS fence proves the exact revision;
    // usage remains independent provider/tool accounting.
    const segmentChanged = db.query(
      `UPDATE agent_work_segments
          SET lifecycle = ?, boundary_class = ?, close_result = ?, close_reason = ?,
              closed_workspace_revision = ?, closed_execution_cas_revision = ?,
              closure_digest = ?, updated_at = ?, closed_at = ?
        WHERE user_id = ? AND execution_id = ? AND segment_id = ? AND lifecycle = 'running'
          AND workspace_revision <= ? AND execution_cas_revision <= ?`,
    ).run(
      closeLifecycle(input.closeResult), input.boundaryClass, input.closeResult, closeReason,
      input.expectedWorkspaceRevision, input.expectedExecutionCasRevision, payloadDigest,
      input.now, input.now, authorityRow.user_id, authorityRow.execution_id, sourceSegmentId,
      input.expectedWorkspaceRevision, input.expectedExecutionCasRevision,
    ).changes;
    if (segmentChanged !== 1) fail("stale_segment", "source segment changed before terminal close");
    const recoveryChanged = db.query(
      `UPDATE agent_work_segment_recovery
          SET workspace_revision = ?, execution_cas_revision = ?, state = 'closed',
              phase_id = NULL, phase_index = NULL, phase_occurrence = NULL, current_segment_id = NULL,
              next_segment_ordinal = ?, terminal_close_result = ?, terminal_close_reason = ?,
              terminal_boundary_class = ?, updated_at = ?
        WHERE user_id = ? AND execution_id = ? AND state = 'active' AND current_segment_id = ?
          AND workspace_revision <= ? AND execution_cas_revision <= ?`,
    ).run(
      input.expectedWorkspaceRevision, input.expectedExecutionCasRevision,
      source.identity.segmentOrdinal + 1, input.closeResult, closeReason, input.boundaryClass, input.now,
      authorityRow.user_id, authorityRow.execution_id, sourceSegmentId,
      input.expectedWorkspaceRevision, input.expectedExecutionCasRevision,
    ).changes;
    if (recoveryChanged !== 1) fail("stale_segment", "attempt changed before terminal close");
    const closed = rawRecovery(db, authorityRow.user_id, authorityRow.execution_id);
    if (!closed) fail("integrity_error", "terminal close was not observable");
    return Object.freeze({ record: recoveryFromRow(closed), duplicate: false });
  });
}


/** Terminally closes an admitted Segment that provably never reserved provider work. */
export function closeAdmittedWorkSegmentWithoutDispatchTerminalV1(
  input: CloseAdmittedWorkSegmentWithoutDispatchTerminalInputV1,
): WorkSegmentWriteResult<WorkSegmentAttemptRecoveryV1> {
  const db = input.db ?? getDb();
  return transaction(db, () => {
    const authorityRow = authority(db, input, true, false, true, true);
    const attemptId = boundedString(input.attemptId, "attemptId");
    const workspaceId = boundedString(input.workspaceId, "workspaceId");
    const sourceSegmentId = boundedString(input.sourceSegmentId, "sourceSegmentId");
    const idempotencyKey = boundedString(input.idempotencyKey, "idempotencyKey");
    const closeReason = boundedString(input.closeReason, "closeReason");
    if (workspaceId !== authorityRow.workspace_id) fail("stale_workspace", "workspace identity changed");
    if (!(["failed", "exhausted", "cancelled"] as const).includes(input.closeResult)) {
      fail("invalid_input", "terminal close result is invalid");
    }
    const usage = zeroUsage();
    const payload = Object.freeze({
      version: 1,
      closePath: "admitted_without_dispatch",
      userId: authorityRow.user_id,
      executionId: authorityRow.execution_id,
      attemptId,
      workspaceId,
      sourceSegmentId,
      idempotencyKey,
      closeResult: input.closeResult,
      closeReason,
      boundaryClass: null,
      usage,
      workspaceRevision: input.expectedWorkspaceRevision,
      executionCasRevision: input.expectedExecutionCasRevision,
    });
    const payloadDigest = canonicalDigest(payload);
    const sourceRow = rawSegment(db, authorityRow.user_id, authorityRow.execution_id, sourceSegmentId);
    const recoveryRow = rawRecovery(db, authorityRow.user_id, authorityRow.execution_id);
    if (!sourceRow || !recoveryRow) fail("not_found", "terminal segment attempt was not found");
    const source = segmentFromRow(sourceRow);
    const recovery = recoveryFromRow(recoveryRow);
    const dispatchCountRow = db.query(
      `SELECT COUNT(*) AS count FROM agent_work_segment_dispatches
        WHERE user_id = ? AND execution_id = ? AND segment_id = ?`,
    ).get(authorityRow.user_id, authorityRow.execution_id, sourceSegmentId) as Row;
    if (numberFrom(dispatchCountRow, "count") !== 0) {
      fail("stale_segment", "admitted terminal close requires zero dispatch history");
    }
    for (const field of [
      "providerDispatches", "providerInputTokens", "providerOutputTokens", "providerTotalTokens",
      "billedOutputTokens", "toolCalls", "workspaceOperations", "unsignedBoundaries", "receiveBytes", "publishedOutputBytes",
    ] as const) {
      if (source.usage[field] !== 0) fail("integrity_error", "admitted terminal close requires zero segment usage");
    }
    if (recovery.state === "closed" && source.lifecycle === closeLifecycle(input.closeResult)) {
      if (
        source.closureDigest !== payloadDigest
        || source.closeResult !== input.closeResult
        || source.closeReason !== closeReason
        || source.boundaryClass !== null
        || recovery.terminalCloseResult !== input.closeResult
        || recovery.terminalCloseReason !== closeReason
        || recovery.terminalBoundaryClass !== null
      ) fail("idempotency_conflict", "terminal close key differs from the durable close");
      return Object.freeze({ record: recovery, duplicate: true });
    }
    if (
      recovery.state !== "active"
      || recovery.attemptId !== attemptId
      || recovery.workspaceId !== workspaceId
      || recovery.currentSegmentId !== sourceSegmentId
      || recovery.workspaceRevision !== input.expectedWorkspaceRevision
      || recovery.executionCasRevision !== input.expectedExecutionCasRevision
      || recovery.phaseId !== source.identity.phaseId
      || recovery.phaseIndex !== source.identity.phaseIndex
      || recovery.phaseOccurrence !== source.identity.phaseOccurrence
      || recovery.nextSegmentOrdinal !== source.identity.segmentOrdinal
      || source.identity.attemptId !== attemptId
      || source.workspaceId !== workspaceId
      || source.workspaceRevision !== input.expectedWorkspaceRevision
      || source.executionCasRevision !== input.expectedExecutionCasRevision
      || source.lifecycle !== "admitted"
      || source.boundaryClass !== null
      || input.now < recovery.updatedAt
      || input.now < source.updatedAt
    ) fail("stale_segment", "terminal close no longer owns the exact admitted segment");
    const segmentChanged = db.query(
      `UPDATE agent_work_segments
          SET lifecycle = ?, boundary_class = NULL, close_result = ?, close_reason = ?,
              closed_workspace_revision = ?, closed_execution_cas_revision = ?,
              closure_digest = ?, updated_at = ?, closed_at = ?
        WHERE user_id = ? AND execution_id = ? AND segment_id = ? AND lifecycle = 'admitted'
          AND attempt_id = ? AND workspace_id = ? AND workspace_revision = ?
          AND execution_cas_revision = ? AND updated_at <= ?
          AND provider_dispatches = 0 AND provider_input_tokens = 0 AND provider_output_tokens = 0
          AND provider_total_tokens = 0 AND billed_output_tokens = 0 AND tool_calls = 0
          AND workspace_operations = 0 AND unsigned_boundaries = 0 AND receive_bytes = 0
          AND published_output_bytes = 0
          AND NOT EXISTS (
            SELECT 1 FROM agent_work_segment_dispatches d
             WHERE d.user_id = agent_work_segments.user_id
               AND d.execution_id = agent_work_segments.execution_id
               AND d.segment_id = agent_work_segments.segment_id
          )`,
    ).run(
      closeLifecycle(input.closeResult), input.closeResult, closeReason,
      input.expectedWorkspaceRevision, input.expectedExecutionCasRevision, payloadDigest,
      input.now, input.now, authorityRow.user_id, authorityRow.execution_id, sourceSegmentId,
      attemptId, workspaceId, input.expectedWorkspaceRevision, input.expectedExecutionCasRevision, input.now,
    ).changes;
    if (segmentChanged !== 1) fail("stale_segment", "admitted segment changed before terminal close");
    const recoveryChanged = db.query(
      `UPDATE agent_work_segment_recovery
          SET state = 'closed', phase_id = NULL, phase_index = NULL, phase_occurrence = NULL,
              current_segment_id = NULL, next_segment_ordinal = ?, terminal_close_result = ?,
              terminal_close_reason = ?, terminal_boundary_class = NULL, updated_at = ?
        WHERE user_id = ? AND execution_id = ? AND state = 'active' AND current_segment_id = ?
          AND attempt_id = ? AND workspace_id = ? AND workspace_revision = ?
          AND execution_cas_revision = ? AND phase_id IS ? AND phase_index = ?
          AND phase_occurrence = ? AND next_segment_ordinal = ? AND updated_at <= ?`,
    ).run(
      source.identity.segmentOrdinal + 1, input.closeResult, closeReason, input.now,
      authorityRow.user_id, authorityRow.execution_id, sourceSegmentId, attemptId, workspaceId,
      input.expectedWorkspaceRevision, input.expectedExecutionCasRevision, source.identity.phaseId,
      source.identity.phaseIndex, source.identity.phaseOccurrence, source.identity.segmentOrdinal, input.now,
    ).changes;
    if (recoveryChanged !== 1) fail("stale_segment", "attempt changed before admitted terminal close");
    const closed = rawRecovery(db, authorityRow.user_id, authorityRow.execution_id);
    if (!closed) fail("integrity_error", "terminal close was not observable");
    return Object.freeze({ record: recoveryFromRow(closed), duplicate: false });
  });
}

function assertRecoveredSegmentSkipAuthorityV1(
  segment: WorkSegmentAdmissionV1,
  recovery: WorkSegmentAttemptRecoveryV1,
): void {
  if (segment.context.phasePlanDigest !== recovery.phasePlanDigest) {
    fail("integrity_error", "segment skip authority phase plan binding is corrupt");
  }
  try {
    assertAtomicSegmentSkipAuthorityV1(
      segment.context,
      recovery.phasePlan,
      segment.sourceTransitionId,
      segment.identity.segmentOrdinal,
    );
  } catch (error) {
    if (error instanceof AgenticWorkSegmentRepositoryError) {
      fail("integrity_error", "segment skip authority is corrupt");
    }
    throw error;
  }
}

function validateRecoveryChain(chain: WorkSegmentRecoveryChainV1): void {
  const { recovery, segments, transitions, dispatches } = chain;
  if (computeWorkPhasePlanDigestV1(recovery.phasePlan) !== recovery.phasePlanDigest) {
    fail("integrity_error", "recovery phase plan authority is corrupt");
  }
  const expectedNextSegmentOrdinal = recovery.currentSegmentId === null
    ? segments.length
    : Math.max(0, segments.length - 1);
  if (
    recovery.usage.segments !== segments.length
    || recovery.nextSegmentOrdinal !== expectedNextSegmentOrdinal
  ) {
    fail("integrity_error", "recovery segment cursor is corrupt");
  }
  let active: WorkSegmentAdmissionV1 | null = null;
  const transitionsBySource = new Map<string, WorkPhaseTransitionReceiptV1>();
  for (const transition of transitions) {
    const sourceId = transition.handoff.sourceSegment.segmentId;
    if (transitionsBySource.has(sourceId)) fail("integrity_error", "segment has multiple transitions");
    transitionsBySource.set(sourceId, transition);
  }
  for (let ordinal = 0; ordinal < segments.length; ordinal += 1) {
    const segment = segments[ordinal]!;
    if (
      segment.identity.executionId !== recovery.executionId
      || segment.identity.attemptId !== recovery.attemptId
      || segment.workspaceId !== recovery.workspaceId
      || segment.identity.segmentOrdinal !== ordinal
    ) fail("integrity_error", "segment identity chain is corrupt");
    assertRecoveredSegmentSkipAuthorityV1(segment, recovery);
    if (segment.lifecycle === "admitted" || segment.lifecycle === "running") {
      if (active) fail("integrity_error", "multiple active segments are corrupt");
      active = segment;
    }
    const transition = transitionsBySource.get(segment.identity.segmentId);
    const successfullyClosed = segment.lifecycle === "closed";
    if (successfullyClosed !== Boolean(transition)) {
      fail("integrity_error", "segment transition chain is incomplete");
    }
    if (transition) {
      const handoff = transition.handoff;
      if (
        handoff.executionId !== recovery.executionId
        || handoff.attemptId !== recovery.attemptId
        || handoff.sourceSegment.segmentOrdinal !== ordinal
      ) fail("integrity_error", "transition identity chain is corrupt");
      if (handoff.targetSegmentOrdinal !== null) {
        if (handoff.targetSegmentOrdinal !== ordinal + 1) fail("integrity_error", "transition target ordinal is corrupt");
        const target = segments[ordinal + 1];
        if (target && (
          target.identity.phaseId !== handoff.targetPhaseId
          || target.identity.phaseIndex !== handoff.targetPhaseIndex
          || target.identity.phaseOccurrence !== handoff.targetPhaseOccurrence
        )) fail("integrity_error", "admitted segment does not match its transition handoff");
      } else if (ordinal !== segments.length - 1 || recovery.state !== "closed") {
        fail("integrity_error", "terminal transition chain is corrupt");
      }
    }
  }
  if (recovery.currentSegmentId === null) {
    if (active) fail("integrity_error", "active segment lacks the recovery cursor");
  } else if (!active || active.identity.segmentId !== recovery.currentSegmentId || recovery.state !== "active") {
    fail("integrity_error", "recovery current segment is corrupt");
  }
  const dispatchOrdinalBySegment = new Map<string, number>();
  const segmentIds = new Set(segments.map((segment) => segment.identity.segmentId));
  for (const dispatch of dispatches) {
    if (
      dispatch.executionId !== recovery.executionId
      || dispatch.attemptId !== recovery.attemptId
      || dispatch.workspaceId !== recovery.workspaceId
      || !segmentIds.has(dispatch.segmentId)
    ) fail("integrity_error", "dispatch identity chain is corrupt");
    const expectedOrdinal = dispatchOrdinalBySegment.get(dispatch.segmentId) ?? 0;
    if (dispatch.dispatchOrdinal !== expectedOrdinal) fail("integrity_error", "dispatch ordinal chain is corrupt");
    dispatchOrdinalBySegment.set(dispatch.segmentId, expectedOrdinal + 1);
  }
}
export function readWorkSegmentRecoveryChainV1(
  userIdInput: string,
  executionIdInput: string,
  db: Database = getDb(),
): WorkSegmentRecoveryChainV1 | null {
  const userId = boundedString(userIdInput, "userId");
  const executionId = boundedString(executionIdInput, "executionId");
  const recoveryRow = rawRecovery(db, userId, executionId);
  if (!recoveryRow) return null;
  const segmentRows = db.query(
    "SELECT * FROM agent_work_segments WHERE user_id = ? AND execution_id = ? ORDER BY segment_ordinal",
  ).all(userId, executionId) as Row[];
  const segments = Object.freeze(segmentRows.map(segmentFromRow));
  const segmentsById = new Map(segments.map((segment) => [segment.identity.segmentId, segment]));
  const transitionRows = db.query(
    "SELECT * FROM agent_work_segment_transitions WHERE user_id = ? AND execution_id = ? ORDER BY created_at, transition_id",
  ).all(userId, executionId) as Row[];
  const transitions = Object.freeze(transitionRows.map((row) => {
    const source = segmentsById.get(stringFrom(row, "source_segment_id"));
    if (!source) fail("integrity_error", "transition source segment is missing");
    return transitionFromRow(row, source);
  }));
  const dispatches = Object.freeze((db.query(
    "SELECT * FROM agent_work_segment_dispatches WHERE user_id = ? AND execution_id = ? ORDER BY segment_id, dispatch_ordinal",
  ).all(userId, executionId) as Row[]).map(dispatchFromRow));
  const chain = Object.freeze({
    version: 1 as const,
    recovery: recoveryFromRow(recoveryRow),
    segments,
    transitions,
    dispatches,
  });
  validateRecoveryChain(chain);
  return chain;
}

/** Owner-authenticated inspection remains readable after WORK and workspace retention transitions. */
export function readWorkSegmentInspectionChainV1(
  input: WorkSegmentInspectionAuthorityInputV1,
): WorkSegmentRecoveryChainV1 | null {
  const db = input.db ?? getDb();
  const userId = boundedString(input.userId, "userId");
  const chatId = boundedString(input.chatId, "chatId");
  const executionId = boundedString(input.executionId, "executionId");
  const attemptId = boundedString(input.attemptId, "attemptId");
  const workspaceId = boundedString(input.workspaceId, "workspaceId");
  const owner = db.query(
    `SELECT e.user_id, e.id AS execution_id, e.chat_id, e.workspace_id,
            w.workspace_id AS retained_workspace_id, r.attempt_id, r.workspace_id AS recovery_workspace_id
       FROM agent_turn_executions AS e
       JOIN agent_turn_workspaces AS w
         ON w.user_id = e.user_id AND w.execution_id = e.id
       JOIN agent_work_segment_recovery AS r
         ON r.user_id = e.user_id AND r.execution_id = e.id
      WHERE e.user_id = ? AND e.id = ?`,
  ).get(userId, executionId) as Row | null;
  if (!owner) fail("not_found", "execution inspection authority was not found");
  if (
    owner.chat_id !== chatId
    || owner.workspace_id !== workspaceId
    || owner.retained_workspace_id !== workspaceId
    || owner.recovery_workspace_id !== workspaceId
    || owner.attempt_id !== attemptId
  ) fail("stale_execution", "inspection identity does not match the retained execution");
  return readWorkSegmentRecoveryChainV1(userId, executionId, db);
}
export function readSettledWorkspaceEffectsV1(
  userIdValue: string,
  executionIdValue: string,
  workspaceIdValue: string,
  afterRevisionExclusive: number,
  throughRevisionInclusive: number,
  db: Database = getDb(),
): readonly WorkSettledWorkspaceEffectV1[] {
  const userId = id(userIdValue, "userId");
  const executionId = id(executionIdValue, "executionId");
  const workspaceId = id(workspaceIdValue, "workspaceId");
  const before = nonNegative(afterRevisionExclusive, "afterRevisionExclusive");
  const through = nonNegative(throughRevisionInclusive, "throughRevisionInclusive");
  if (through < before) fail("invalid_input", "workspace receipt revision range regresses");
  const rows = db.query(`SELECT operation_key, operation_digest, segment_id, logical_dispatch, frame_id,
      before_workspace_revision, after_workspace_revision
    FROM agent_work_workspace_receipts
    WHERE user_id = ? AND execution_id = ? AND workspace_id = ?
      AND before_workspace_revision >= ? AND after_workspace_revision <= ?
    ORDER BY before_workspace_revision`).all(userId, executionId, workspaceId, before, through) as readonly Record<string, unknown>[];
  let expected = before;
  const effects = rows.map((row): WorkSettledWorkspaceEffectV1 => {
    const effect = Object.freeze({
      version: 1 as const,
      kind: "workspace_operation" as const,
      state: "settled" as const,
      operationKey: id(stringFrom(row, "operation_key"), "operationKey"),
      operationDigest: digest(stringFrom(row, "operation_digest"), "operationDigest"),
      segmentId: id(stringFrom(row, "segment_id"), "segmentId"),
      logicalDispatch: safeInteger(row.logical_dispatch, "logicalDispatch", MAX_COUNTER),
      frameId: id(stringFrom(row, "frame_id"), "frameId"),
      beforeWorkspaceRevision: integerFrom(row, "before_workspace_revision"),
      afterWorkspaceRevision: integerFrom(row, "after_workspace_revision"),
    });
    if (effect.beforeWorkspaceRevision !== expected || effect.afterWorkspaceRevision !== expected + 1) {
      fail("integrity_error", "workspace receipt chain is not exact and contiguous");
    }
    expected = effect.afterWorkspaceRevision;
    return effect;
  });
  if (expected !== through) fail("integrity_error", "workspace receipt chain does not cover the requested revision");
  return Object.freeze(effects);
}

/** Reads the exact durable workspace projection admitted into a fresh segment. */
export function readWorkSegmentWorkspaceAuthorityV1(
  userIdValue: string,
  executionIdValue: string,
  workspaceIdValue: string,
  db: Database = getDb(),
): Readonly<{
  revision: number;
  acceptedRecords: readonly WorkSegmentAcceptedRecordV1[];
  openRequiredIds: readonly string[];
}> {
  const userId = id(userIdValue, "userId");
  const executionId = id(executionIdValue, "executionId");
  const workspaceId = id(workspaceIdValue, "workspaceId");
  const workspace = db.query(`SELECT revision FROM agent_turn_workspaces
    WHERE user_id = ? AND execution_id = ? AND workspace_id = ?`).get(userId, executionId, workspaceId) as Record<string, unknown> | null;
  if (!workspace) fail("stale_workspace", "WORK segment workspace authority is unavailable");

  const rows = db.query(`SELECT accepted_kind, accepted_id, accepted_digest, accepted_summary, task_id,
           task_title, task_description, task_state, task_required, task_summary, task_revision
    FROM (
      SELECT 'task' AS accepted_kind, t.task_id AS accepted_id, NULL AS accepted_digest,
             COALESCE(t.summary, t.title) AS accepted_summary, t.task_id AS task_id,
             t.title AS task_title, t.description AS task_description, t.state AS task_state,
             t.required AS task_required, t.summary AS task_summary, t.revision AS task_revision,
             t.created_at, 0 AS source_order
      FROM agent_workspace_tasks t
      WHERE t.user_id = ? AND t.turn_id = ? AND t.workspace_id = ? AND t.state = 'completed'
        AND EXISTS (
          SELECT 1 FROM agent_workspace_submissions s
          WHERE s.user_id = t.user_id AND s.turn_id = t.turn_id AND s.workspace_id = t.workspace_id
            AND s.task_id = t.task_id AND s.state = 'accepted'
        )
      UNION ALL
      SELECT kind AS accepted_kind, record_id AS accepted_id, digest AS accepted_digest,
             summary AS accepted_summary, task_id,
             NULL, NULL, NULL, NULL, NULL, NULL,
             created_at, 1 AS source_order
      FROM agent_workspace_records
      WHERE user_id = ? AND turn_id = ? AND workspace_id = ? AND kind IN ('finding', 'decision')
      UNION ALL
      SELECT 'submission' AS accepted_kind, submission_id AS accepted_id, result_digest AS accepted_digest,
             summary AS accepted_summary, task_id,
             NULL, NULL, NULL, NULL, NULL, NULL,
             updated_at AS created_at, 2 AS source_order
      FROM agent_workspace_submissions
      WHERE user_id = ? AND turn_id = ? AND workspace_id = ? AND state = 'accepted'
      UNION ALL
      SELECT 'artifact' AS accepted_kind, artifact_id AS accepted_id, blob_digest AS accepted_digest,
             mime_type AS accepted_summary, source_task_id AS task_id,
             NULL, NULL, NULL, NULL, NULL, NULL,
             created_at, 3 AS source_order
      FROM agent_workspace_artifacts
      WHERE user_id = ? AND turn_id = ? AND workspace_id = ?
    )
    ORDER BY created_at, source_order, accepted_id
    LIMIT ?`).all(
      userId, executionId, workspaceId,
      userId, executionId, workspaceId,
      userId, executionId, workspaceId,
      userId, executionId, workspaceId,
      MAX_ID_LIST_ITEMS + 1,
    ) as readonly Record<string, unknown>[];
  if (rows.length > MAX_ID_LIST_ITEMS) {
    fail("segment_budget_exhausted", "workspace accepted record authority exceeds the durable segment bound");
  }
  const acceptedRecords = Object.freeze(rows.map((row): WorkSegmentAcceptedRecordV1 => {
    const kind = stringFrom(row, "accepted_kind") as WorkSegmentAcceptedRecordV1["kind"];
    if (!(kind === "task" || kind === "submission" || kind === "finding" || kind === "decision" || kind === "artifact")) {
      fail("integrity_error", "workspace accepted record kind is invalid");
    }
    const acceptedDigest = kind === "task"
      ? canonicalDigest({
        version: 1,
        kind: "accepted_task",
        id: stringFrom(row, "accepted_id"),
        title: stringFrom(row, "task_title"),
        description: stringFrom(row, "task_description"),
        state: stringFrom(row, "task_state"),
        required: numberFrom(row, "task_required") === 1,
        summary: nullableStringFrom(row, "task_summary"),
        revision: numberFrom(row, "task_revision"),
      })
      : digest(stringFrom(row, "accepted_digest"), "acceptedRecord.digest");
    return Object.freeze({
      kind,
      id: id(stringFrom(row, "accepted_id"), "acceptedRecord.id"),
      digest: acceptedDigest,
      summary: boundedString(stringFrom(row, "accepted_summary"), "acceptedRecord.summary", MAX_SUMMARY_BYTES),
      taskId: nullableStringFrom(row, "task_id"),
    });
  }));
  const openRequiredRows = db.query(`SELECT t.task_id FROM agent_workspace_tasks t
    WHERE t.user_id = ? AND t.turn_id = ? AND t.workspace_id = ? AND t.required = 1
      AND NOT (t.state = 'completed' AND EXISTS (
        SELECT 1 FROM agent_workspace_submissions s
        WHERE s.user_id = t.user_id AND s.turn_id = t.turn_id AND s.workspace_id = t.workspace_id
          AND s.task_id = t.task_id AND s.state = 'accepted'
      ))
    ORDER BY t.created_at, t.task_id
    LIMIT ?`).all(userId, executionId, workspaceId, MAX_ID_LIST_ITEMS + 1) as readonly Record<string, unknown>[];
  if (openRequiredRows.length > MAX_ID_LIST_ITEMS) {
    fail("segment_budget_exhausted", "workspace open required authority exceeds the durable segment bound");
  }
  const openRequiredIds = Object.freeze(openRequiredRows
    .map((row) => id(stringFrom(row, "task_id"), "openRequiredId")));
  return Object.freeze({ revision: integerFrom(workspace, "revision"), acceptedRecords, openRequiredIds });
}
interface StartupCompiledPhaseAuthorityV1 {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly index: number;
  readonly required: boolean;
  readonly instructionRefs: readonly unknown[];
  readonly capabilityRequests: readonly string[];
}

function startupIntegrityRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("integrity_error", field + " is not durable canonical authority");
  }
  return value as Readonly<Record<string, unknown>>;
}

function startupIntegrityArray(value: unknown, field: string, max = MAX_ID_LIST_ITEMS): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    fail("integrity_error", field + " is not a bounded durable collection");
  }
  return value;
}

function startupIntegrityId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES) {
    fail("integrity_error", field + " is not a bounded durable identity");
  }
  return value;
}

function startupIntegrityInteger(value: unknown, field: string, max = MAX_ORDINAL): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    fail("integrity_error", field + " is not a bounded durable integer");
  }
  return value as number;
}

function startupCapabilityDigest(capabilities: readonly string[]): string {
  return canonicalDigest({
    version: 1,
    admittedCapabilities: [...new Set(capabilities)].sort(compareUtf8),
  });
}

function startupCompiledPhaseAuthorityV1(recovery: WorkSegmentAttemptRecoveryV1): Readonly<{
  phases: readonly StartupCompiledPhaseAuthorityV1[];
  loomBlocks: readonly unknown[];
  completionCriteria: readonly string[];
}> {
  const plan = startupIntegrityRecord(recovery.resumeEnvelope.plan, "resume plan");
  if (canonicalDigest(plan) !== recovery.resumeEnvelope.planDigest) {
    fail("integrity_error", "resume plan digest does not match its durable authority");
  }
  const customPhasePlan = startupIntegrityRecord(plan.customPhasePlan, "resume custom phase plan");
  if (!(customPhasePlan.status === "ready" || customPhasePlan.status === "repair_required")) {
    fail("integrity_error", "resume custom phase plan is not executable");
  }
  const rawPhases = startupIntegrityArray(customPhasePlan.phases, "resume custom phases");
  if (rawPhases.length !== recovery.phasePlan.phases.length) {
    fail("integrity_error", "resume custom phases do not match the immutable phase plan");
  }
  const knownCapabilities = new Set([
    "core_retrieval", "workspace_read", "workspace_write", "delegation", "council", "cortex",
  ]);
  const phaseRecords = rawPhases.map((value, index) => {
    const phase = startupIntegrityRecord(value, "resume custom phase " + index);
    if (phase.version !== 1 || phase.index !== index || typeof phase.required !== "boolean"
      || !(phase.sourceStatus === "verified" || phase.sourceStatus === "unverified")) {
      fail("integrity_error", "resume custom phase ordering or source authority is invalid");
    }
    startupIntegrityRecord(phase.enter, "resume custom phase enter");
    startupIntegrityRecord(phase.exit, "resume custom phase exit");
    if (Object.hasOwn(phase, "skip")) startupIntegrityRecord(phase.skip, "resume custom phase skip");
    startupIntegrityInteger(phase.repeatLimit, "resume custom phase repeat limit");
    const id = startupIntegrityId(phase.id, "resume custom phase id");
    startupIntegrityId(phase.label, "resume custom phase label");
    const instructionRefs = startupIntegrityArray(phase.instructionRefs, "resume custom phase instruction refs");
    const nextPhaseIds = startupIntegrityArray(phase.nextPhaseIds, "resume custom phase next ids")
      .map((nextId) => startupIntegrityId(nextId, "resume custom phase next id"));
    const capabilityRequests = startupIntegrityArray(phase.capabilityRequests, "resume custom phase capabilities")
      .map((capability) => startupIntegrityId(capability, "resume custom phase capability"));
    if (new Set(nextPhaseIds).size !== nextPhaseIds.length
      || new Set(capabilityRequests).size !== capabilityRequests.length
      || capabilityRequests.some((capability) => !knownCapabilities.has(capability))) {
      fail("integrity_error", "resume custom phase contains duplicate or unknown authority");
    }
    startupIntegrityArray(phase.sourceIdentity, "resume custom phase source identity");
    return Object.freeze({
      raw: phase,
      id,
      index,
      required: phase.required,
      instructionRefs,
      capabilityRequests: Object.freeze(capabilityRequests),
    });
  });
  const phaseIds = phaseRecords.map((phase) => phase.id);
  if (new Set(phaseIds).size !== phaseIds.length) {
    fail("integrity_error", "resume custom phase identities are not unique");
  }
  const derivedPlan: WorkPhasePlanAuthorityV1 = Object.freeze({
    version: 1,
    phases: Object.freeze(phaseRecords.map((phase, index) => {
      const rawNextIds = phase.raw.nextPhaseIds as readonly string[];
      const nextPhaseIds = Object.freeze([...(rawNextIds.length > 0
        ? new Set(rawNextIds)
        : phaseRecords[index + 1] ? new Set([phaseRecords[index + 1]!.id]) : new Set<string>())].sort(compareUtf8));
      if (nextPhaseIds.some((nextId) => !phaseIds.includes(nextId))) {
        fail("integrity_error", "resume custom phase references an unknown successor");
      }
      return Object.freeze({
        id: phase.id,
        index,
        required: phase.required,
        nextPhaseIds,
        repeatLimit: phase.raw.repeatLimit as number,
        transitionAuthorityDigest: canonicalDigest({
          version: 1,
          id: phase.id,
          index,
          enter: phase.raw.enter,
          exit: phase.raw.exit,
          capabilityRequests: phase.raw.capabilityRequests,
          repeatLimit: phase.raw.repeatLimit,
          nextPhaseIds: phase.raw.nextPhaseIds,
          sourceStatus: phase.raw.sourceStatus,
          sourceIdentity: phase.raw.sourceIdentity,
        }),
        skipEligibilityDigest: Object.hasOwn(phase.raw, "skip")
          ? canonicalDigest({
            version: 1,
            id: phase.id,
            index,
            skip: phase.raw.skip,
            sourceIdentity: phase.raw.sourceIdentity,
          })
          : null,
      });
    })),
  });
  if (canonicalDigest(derivedPlan) !== recovery.phasePlanDigest
    || encodeCanonicalPlainData(derivedPlan) !== encodeCanonicalPlainData(recovery.phasePlan)) {
    fail("integrity_error", "resume custom phases do not derive the immutable phase plan");
  }
  const completionCriteria = Object.freeze(startupIntegrityArray(
    plan.completionCriteriaMessages,
    "resume completion criteria",
    MAX_ORDINAL,
  ).flatMap((value) => {
    const message = startupIntegrityRecord(value, "resume completion criterion");
    return typeof message.content === "string" ? [message.content] : [];
  }));
  return Object.freeze({
    phases: Object.freeze(phaseRecords),
    loomBlocks: startupIntegrityArray(plan.loomBlocks, "resume Loom blocks", MAX_ORDINAL),
    completionCriteria,
  });
}

function startupPhaseInstructionsV1(
  phase: StartupCompiledPhaseAuthorityV1,
  loomBlocks: readonly unknown[],
): readonly string[] {
  const blocks = loomBlocks.map((candidate) => startupIntegrityRecord(candidate, "resume Loom block"));
  const instructions: string[] = [];
  for (const [index, value] of phase.instructionRefs.entries()) {
    const ref = startupIntegrityRecord(value, "resume phase instruction ref " + index);
    if (ref.kind !== "loom_block") fail("integrity_error", "resume phase instruction ref kind is invalid");
    const blockId = startupIntegrityId(ref.blockId, "resume phase instruction block id");
    const presetRevision = startupIntegrityInteger(ref.presetRevision, "resume phase instruction preset revision", MAX_SAFE_INTEGER);
    const blockRevision = startupIntegrityInteger(ref.blockRevision, "resume phase instruction block revision", MAX_SAFE_INTEGER);
    const promptOrder = startupIntegrityInteger(ref.promptOrder, "resume phase instruction prompt order", MAX_SAFE_INTEGER);
    const block = blocks.find((candidate) => {
      const source = startupIntegrityRecord(candidate.source, "resume Loom block source");
      return source.kind === "loom_block"
        && source.blockId === blockId
        && source.presetRevision === presetRevision
        && source.blockRevision === blockRevision
        && source.promptOrder === promptOrder;
    });
    if (!block) {
      if (phase.required) fail("integrity_error", "required resume phase instruction is unavailable");
      continue;
    }
    if (typeof block.content !== "string" || Buffer.byteLength(block.content, "utf8") > MAX_CANONICAL_BYTES) {
      fail("integrity_error", "resume phase instruction content is invalid");
    }
    instructions.push(block.content);
  }
  return Object.freeze(instructions);
}

function committedStartupTargetFromChainV1(chain: WorkSegmentRecoveryChainV1, db: Database): Readonly<{
  source: WorkSegmentAdmissionV1;
  transition: WorkPhaseTransitionReceiptV1;
  context: WorkSegmentContextV1;
}> {
  const recovery = chain.recovery;
  const source = chain.segments.at(-1);
  if (!source || recovery.state !== "active" || recovery.currentSegmentId !== null || source.lifecycle !== "closed") {
    fail("integrity_error", "startup handoff recovery lacks an exact closed source segment");
  }
  const transition = chain.transitions.find(
    (candidate) => candidate.handoff.sourceSegment.segmentId === source.identity.segmentId,
  );
  if (!transition) fail("integrity_error", "startup handoff recovery lacks its committed transition");
  const handoff = transition.handoff;
  if (handoff.transitionKind === "terminal"
    || handoff.targetPhaseIndex === null
    || handoff.targetPhaseOccurrence === null
    || handoff.targetSegmentOrdinal === null
    || handoff.targetPhaseId !== recovery.phaseId
    || handoff.targetPhaseIndex !== recovery.phaseIndex
    || handoff.targetPhaseOccurrence !== recovery.phaseOccurrence
    || handoff.targetSegmentOrdinal !== recovery.nextSegmentOrdinal
    || handoff.targetSegmentOrdinal !== source.identity.segmentOrdinal + 1
    || handoff.sourceWorkspaceRevision !== recovery.workspaceRevision
    || handoff.sourceExecutionCasRevision !== recovery.executionCasRevision
    || source.closedWorkspaceRevision !== recovery.workspaceRevision
    || source.closedExecutionCasRevision !== recovery.executionCasRevision
    || source.context.phasePlanDigest !== recovery.phasePlanDigest) {
    fail("integrity_error", "startup handoff target does not match the durable recovery cursor");
  }
  const workspaceAuthority = readWorkSegmentWorkspaceAuthorityV1(
    recovery.userId,
    recovery.executionId,
    recovery.workspaceId,
    db,
  );
  if (workspaceAuthority.revision !== recovery.workspaceRevision) {
    fail("integrity_error", "startup handoff workspace projection is stale");
  }
  const acceptedIds = (kind: WorkSegmentAcceptedRecordV1["kind"]): readonly string[] =>
    workspaceAuthority.acceptedRecords.filter((record) => record.kind === kind).map((record) => record.id).sort(compareUtf8);
  if (encodeCanonicalPlainData(acceptedIds("task")) !== encodeCanonicalPlainData(handoff.acceptedIds.taskIds)
    || encodeCanonicalPlainData(acceptedIds("submission")) !== encodeCanonicalPlainData(handoff.acceptedIds.submissionIds)
    || encodeCanonicalPlainData(acceptedIds("finding")) !== encodeCanonicalPlainData(handoff.acceptedIds.findingIds)
    || encodeCanonicalPlainData(acceptedIds("decision")) !== encodeCanonicalPlainData(handoff.acceptedIds.decisionIds)
    || encodeCanonicalPlainData(acceptedIds("artifact")) !== encodeCanonicalPlainData(handoff.acceptedIds.artifactIds)
    || encodeCanonicalPlainData([...workspaceAuthority.openRequiredIds].sort(compareUtf8))
      !== encodeCanonicalPlainData(handoff.openRequiredIds)) {
    fail("integrity_error", "startup handoff workspace authority does not match its receipt");
  }
  const compiled = startupCompiledPhaseAuthorityV1(recovery);
  const sourcePhase = source.identity.phaseId === null ? null : compiled.phases[source.identity.phaseIndex];
  const targetPhase = handoff.targetPhaseId === null ? null : compiled.phases[handoff.targetPhaseIndex!];
  if ((source.identity.phaseId === null) !== (compiled.phases.length === 0)
    || (sourcePhase !== null && sourcePhase?.id !== source.identity.phaseId)
    || (handoff.targetPhaseId === null) !== (targetPhase === null)
    || (targetPhase !== null && targetPhase?.id !== handoff.targetPhaseId)) {
    fail("integrity_error", "startup handoff phase identity is absent or inconsistent in the resume plan");
  }
  let instructions = source.context.phase.instructions;
  let completionCriteria = source.context.phase.completionCriteria;
  let admittedCapabilities = source.context.phase.admittedCapabilities;
  let phaseCapabilityDigest = source.context.phaseCapabilityDigest;
  if (sourcePhase && targetPhase) {
    const sourceSpecificInstructions = startupPhaseInstructionsV1(sourcePhase, compiled.loomBlocks);
    if (sourceSpecificInstructions.length > instructions.length
      || sourceSpecificInstructions.some((instruction, index) =>
        instructions[instructions.length - sourceSpecificInstructions.length + index] !== instruction)) {
      fail("integrity_error", "source phase instructions do not match the durable resume plan");
    }
    const globalInstructions = instructions
      .slice(0, instructions.length - sourceSpecificInstructions.length)
      .filter((instruction) => !instruction.startsWith("Host Cortex sidecar context (non-canonical;"));
    instructions = Object.freeze([...globalInstructions, ...startupPhaseInstructionsV1(targetPhase, compiled.loomBlocks)]);
    completionCriteria = compiled.completionCriteria;
    if (encodeCanonicalPlainData(completionCriteria) !== encodeCanonicalPlainData(source.context.phase.completionCriteria)) {
      fail("integrity_error", "resume completion authority does not match the admitted source context");
    }
    const attemptCapabilities = compiled.phases.flatMap((phase) => [...phase.capabilityRequests]);
    if (startupCapabilityDigest(attemptCapabilities) !== source.context.capabilityDigest
      || startupCapabilityDigest(source.context.phase.admittedCapabilities) !== source.context.phaseCapabilityDigest) {
      fail("integrity_error", "source phase capability authority does not match the durable resume plan");
    }
    admittedCapabilities = Object.freeze([...new Set(targetPhase.capabilityRequests)].sort(compareUtf8));
    phaseCapabilityDigest = startupCapabilityDigest(admittedCapabilities);
  }
  const { contextDigest: _sourceContextDigest, ...sourceAuthority } = source.context;
  const withoutDigest: Omit<WorkSegmentContextV1, "contextDigest"> = Object.freeze({
    ...sourceAuthority,
    phaseCapabilityDigest,
    phase: Object.freeze({
      id: handoff.targetPhaseId,
      index: handoff.targetPhaseIndex,
      occurrence: handoff.targetPhaseOccurrence,
      instructions,
      completionCriteria,
      admittedCapabilities,
    }),
    workspace: Object.freeze({
      id: recovery.workspaceId,
      revision: workspaceAuthority.revision,
      acceptedRecords: workspaceAuthority.acceptedRecords,
      openRequiredIds: workspaceAuthority.openRequiredIds,
    }),
    previousHandoff: handoff,
  });
  let context: WorkSegmentContextV1;
  try {
    context = normalizedSegmentContext(Object.freeze({
      ...withoutDigest,
      contextDigest: canonicalDigest(withoutDigest),
    }), "startupTargetContext");
  } catch {
    fail("integrity_error", "startup target context is invalid or exceeds its durable bound");
  }
  return Object.freeze({ source, transition, context });
}

interface WorkCompletionRecoveryAuthorityV1 {
  readonly source: WorkSegmentAdmissionV1;
  readonly transition: WorkPhaseTransitionReceiptV1;
}

function workCompletionRecoveryAuthorityV1(
  chain: WorkSegmentRecoveryChainV1,
  db: Database,
): WorkCompletionRecoveryAuthorityV1 {
  const { recovery } = chain;
  const source = chain.segments.at(-1);
  const transition = source
    ? chain.transitions.find((candidate) => candidate.handoff.sourceSegment.segmentId === source.identity.segmentId)
    : undefined;
  if (
    recovery.state !== "closed"
    || recovery.currentSegmentId !== null
    || recovery.phaseId !== null
    || recovery.phaseIndex !== null
    || recovery.phaseOccurrence !== null
    || recovery.terminalCloseResult !== null
    || recovery.terminalCloseReason !== null
    || recovery.terminalBoundaryClass !== null
    || recovery.remainingRequiredPhaseCount !== 0
    || recovery.protectedFuturePhaseReserveOutputTokens !== 0
    || !source
    || source.lifecycle !== "closed"
    || source.closeResult !== "work_complete"
    || source.closeReason !== "transition:terminal"
    || source.boundaryClass === null
    || source.closedAt === null
    || source.closedWorkspaceRevision !== recovery.workspaceRevision
    || source.workspaceRevision !== recovery.workspaceRevision
    || source.closedExecutionCasRevision === null
    || source.executionCasRevision !== source.closedExecutionCasRevision
    || recovery.nextSegmentOrdinal !== source.identity.segmentOrdinal + 1
    || !transition
    || transition !== chain.transitions.at(-1)
    || transition.handoff.transitionKind !== "terminal"
    || transition.handoff.targetPhaseId !== null
    || transition.handoff.targetPhaseIndex !== null
    || transition.handoff.targetPhaseOccurrence !== null
    || transition.handoff.targetSegmentOrdinal !== null
    || transition.handoff.remainingRequiredPhaseCount !== 0
    || transition.handoff.sourceWorkspaceRevision !== source.closedWorkspaceRevision
    || transition.handoff.sourceExecutionCasRevision !== source.closedExecutionCasRevision
    || transition.handoff.payloadDigest !== source.closureDigest
  ) fail("integrity_error", "closed WORK completion recovery authority is incomplete");
  assertRecoveredSegmentSkipAuthorityV1(source, recovery);
  const dispatches = chain.dispatches.filter((dispatch) => dispatch.segmentId === source.identity.segmentId);
  if (dispatches.length === 0) fail("integrity_error", "closed WORK completion lacks durable dispatch history");
  assertSettledDispatchEffectsFinalized(
    db,
    recovery.userId,
    recovery.executionId,
    source.identity.segmentId,
  );
  let usage = zeroUsage();
  for (const dispatch of dispatches) {
    if (
      (dispatch.lifecycle !== "settled" && dispatch.lifecycle !== "interrupted")
      || dispatch.boundaryClass === null
      || dispatch.usage === null
    ) fail("integrity_error", "closed WORK completion dispatch authority is incomplete");
    usage = addUsage(usage, dispatch.usage);
  }
  for (const field of [
    "providerDispatches", "providerInputTokens", "providerOutputTokens", "providerTotalTokens",
    "billedOutputTokens", "toolCalls", "workspaceOperations", "unsignedBoundaries", "receiveBytes", "publishedOutputBytes",
  ] as const) {
    if (usage[field] !== source.usage[field]) {
      fail("integrity_error", "closed WORK completion usage does not match its dispatch ledger");
    }
  }
  if (dispatches.at(-1)!.boundaryClass !== source.boundaryClass) {
    fail("integrity_error", "closed WORK completion boundary does not match its final dispatch");
  }
  return Object.freeze({ source, transition });
}

function startupWorkRecoveryOwnerTokenV1(
  runtimeEpoch: number,
  userId: string,
  executionId: string,
  previousExecutionCasRevision: number,
  claimedAt: number,
): string {
  return "wso_" + canonicalDigest({
    version: 1,
    epoch: runtimeEpoch,
    userId,
    executionId,
    oldCas: previousExecutionCasRevision,
    now: claimedAt,
  });
}

type StartupChildSettlementOperationArgsV1 = Readonly<{
  userId: string;
  chatId: string;
  turnId: string;
  workspaceId: string;
  actor: "host";
  frameId: string;
  taskId: string;
  assignedFrameId: string;
  state: "failed";
}>;

function startupChildSettlementOperationDigestV1(
  reservation: DispatchMutationReservationPayloadV1,
  settlement: DurableWorkspaceMutationReservationV1,
  operationArgs: StartupChildSettlementOperationArgsV1,
  beforeWorkspaceRevision: number,
  afterWorkspaceRevision: number,
): string {
  return createHash("sha256").update(encodeCanonicalPlainData({
    version: 1,
    executionId: reservation.executionId,
    workspaceId: reservation.workspaceId,
    operationKey: settlement.operationKey,
    operationKind: settlement.operationKind,
    segmentId: settlement.segmentId,
    logicalDispatch: settlement.logicalDispatch,
    frameId: settlement.frameId,
    operationArgs,
    workspaceRevisionBefore: beforeWorkspaceRevision,
    workspaceRevisionAfter: afterWorkspaceRevision,
  }), "utf8").digest("hex");
}

function assertStartupChildSettlementReceiptV1(
  receipt: Row,
  reservation: DispatchMutationReservationPayloadV1,
  settlement: DurableWorkspaceMutationReservationV1,
  operationArgs: StartupChildSettlementOperationArgsV1,
): void {
  const beforeWorkspaceRevision = numberFrom(receipt, "before_workspace_revision");
  const afterWorkspaceRevision = numberFrom(receipt, "after_workspace_revision");
  numberFrom(receipt, "settled_at");
  const expectedDigest = startupChildSettlementOperationDigestV1(
    reservation,
    settlement,
    operationArgs,
    beforeWorkspaceRevision,
    afterWorkspaceRevision,
  );
  if (
    stringFrom(receipt, "workspace_id") !== reservation.workspaceId
    || stringFrom(receipt, "segment_id") !== settlement.segmentId
    || numberFrom(receipt, "logical_dispatch") !== settlement.logicalDispatch
    || stringFrom(receipt, "frame_id") !== settlement.frameId
    || stringFrom(receipt, "operation_digest") !== expectedDigest
    || afterWorkspaceRevision !== beforeWorkspaceRevision + 1
  ) fail("idempotency_conflict", "startup child settlement receipt conflicts with its durable reservation");
}

function settleDurablyAssignedChildrenAtStartupV1(
  db: Database,
  reservation: DispatchMutationReservationPayloadV1,
): ReadonlySet<string> {
  const verifiedNoOps = new Set<string>();
  const settlementMutations = reservation.mutations.filter((mutation) => (
    mutation.operationKind === "settle_child_task"
  ));
  if (settlementMutations.length === 0) return verifiedNoOps;
  const assignmentAuthority = readDispatchChildAssignmentAuthority(db, reservation);
  if (!assignmentAuthority) {
    const assignmentWasMutated = reservation.mutations.some((mutation) => (
      mutation.operationKind === "assign_child_tasks"
      && db.query(
        "SELECT 1 AS present FROM agent_work_workspace_receipts WHERE user_id = ? AND execution_id = ? AND operation_key = ?",
      ).get(reservation.userId, reservation.executionId, mutation.operationKey)
    ));
    if (assignmentWasMutated) {
      fail("integrity_error", "assigned child recovery lacks durable task/frame authority");
    }
    for (const mutation of settlementMutations) verifiedNoOps.add(mutation.operationKey);
    return verifiedNoOps;
  }
  const claimedSettlementKeys = new Set(assignmentAuthority.assignments.map((assignment) => (
    assignment.settlementReservation.operationKey
  )));
  if (assignmentAuthority.assignmentReservation.operationKind !== "assign_child_tasks"
    || !reservation.mutations.some((mutation) => (
      mutation.operationKey === assignmentAuthority.assignmentReservation.operationKey
      && mutation.attemptedOperationDigest === assignmentAuthority.assignmentReservation.attemptedOperationDigest
    ))
    || assignmentAuthority.assignments.some((assignment) => !reservation.mutations.some((mutation) => (
      mutation.operationKey === assignment.settlementReservation.operationKey
      && mutation.attemptedOperationDigest === assignment.settlementReservation.attemptedOperationDigest
    )))) {
    fail("integrity_error", "startup child assignment authority escaped the dispatch reservation set");
  }
  const execution = db.query(
    "SELECT chat_id FROM agent_turn_executions WHERE user_id = ? AND id = ? AND mode = 'agentic' AND state = 'WORK'",
  ).get(reservation.userId, reservation.executionId) as Row | null;
  if (!execution) fail("stale_execution", "startup child settlement execution is unavailable");
  const chatId = id(execution.chat_id, "execution.chat_id");
  const assignmentReceipt = db.query(
    "SELECT 1 AS present FROM agent_work_workspace_receipts WHERE user_id = ? AND execution_id = ? AND operation_key = ?",
  ).get(
    reservation.userId,
    reservation.executionId,
    assignmentAuthority.assignmentReservation.operationKey,
  );
  for (const assignment of assignmentAuthority.assignments) {
    const durableSettlement = assignment.settlementReservation;
    const operationArgs = Object.freeze({
      userId: reservation.userId,
      chatId,
      turnId: reservation.executionId,
      workspaceId: reservation.workspaceId,
      actor: "host" as const,
      frameId: assignment.frameId,
      taskId: assignment.taskId,
      assignedFrameId: assignment.frameId,
      state: "failed" as const,
    });
    const existingReceipt = db.query(
      "SELECT workspace_id, segment_id, logical_dispatch, frame_id, operation_digest, "
        + "before_workspace_revision, after_workspace_revision, settled_at "
        + "FROM agent_work_workspace_receipts WHERE user_id = ? AND execution_id = ? AND operation_key = ?",
    ).get(reservation.userId, reservation.executionId, durableSettlement.operationKey) as Row | null;
    const task = db.query(
      "SELECT state, assigned_frame_id FROM agent_workspace_tasks "
        + "WHERE user_id = ? AND workspace_id = ? AND task_id = ?",
    ).get(reservation.userId, reservation.workspaceId, assignment.taskId) as Row | null;
    if (existingReceipt) {
      assertStartupChildSettlementReceiptV1(existingReceipt, reservation, durableSettlement, operationArgs);
      if (!task || task.assigned_frame_id !== assignment.frameId || task.state !== "failed") {
        fail("integrity_error", "startup child settlement receipt lacks its exact terminal task effect");
      }
      continue;
    }
    if (!task || task.assigned_frame_id !== assignment.frameId) {
      if (assignmentReceipt) {
        fail("integrity_error", "durably assigned child task/frame authority is no longer observable");
      }
      verifiedNoOps.add(durableSettlement.operationKey);
      continue;
    }
    if (task.state === "completed" || task.state === "cancelled" || task.state === "failed") {
      verifiedNoOps.add(durableSettlement.operationKey);
      continue;
    }
    const workspace = db.query(
      "SELECT revision FROM agent_turn_workspaces WHERE user_id = ? AND execution_id = ? AND workspace_id = ? AND state = 'active'",
    ).get(reservation.userId, reservation.executionId, reservation.workspaceId) as Row | null;
    if (!workspace) fail("stale_workspace", "startup child settlement workspace is unavailable");
    const expectedRevision = numberFrom(workspace, "revision");
    const settledAt = Math.floor(Date.now() / 1000);
    const taskChanged = db.query(
      "UPDATE agent_workspace_tasks SET state = 'failed', revision = revision + 1, updated_at = ? "
        + "WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND workspace_id = ? AND task_id = ? "
        + "AND assigned_frame_id = ? AND state NOT IN ('completed', 'cancelled', 'failed')",
    ).run(
      settledAt,
      reservation.userId,
      chatId,
      reservation.executionId,
      reservation.workspaceId,
      assignment.taskId,
      assignment.frameId,
    ).changes;
    if (taskChanged !== 1) fail("stale_workspace", "startup child task changed before terminal settlement");
    const afterWorkspaceRevision = expectedRevision + 1;
    const workspaceChanged = db.query(
      "UPDATE agent_turn_workspaces SET revision = ?, updated_at = ? "
        + "WHERE user_id = ? AND execution_id = ? AND workspace_id = ? AND state = 'active' AND revision = ?",
    ).run(
      afterWorkspaceRevision,
      settledAt,
      reservation.userId,
      reservation.executionId,
      reservation.workspaceId,
      expectedRevision,
    ).changes;
    if (workspaceChanged !== 1) fail("stale_workspace", "startup workspace changed before child settlement receipt");
    const operationDigest = startupChildSettlementOperationDigestV1(
      reservation,
      durableSettlement,
      operationArgs,
      expectedRevision,
      afterWorkspaceRevision,
    );
    const receiptInserted = db.query(
      "INSERT INTO agent_work_workspace_receipts "
        + "(user_id, execution_id, workspace_id, segment_id, logical_dispatch, frame_id, operation_key, "
        + "operation_digest, before_workspace_revision, after_workspace_revision, settled_at) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        + "ON CONFLICT(user_id, execution_id, operation_key) DO NOTHING",
    ).run(
      reservation.userId,
      reservation.executionId,
      reservation.workspaceId,
      durableSettlement.segmentId,
      durableSettlement.logicalDispatch,
      durableSettlement.frameId,
      durableSettlement.operationKey,
      operationDigest,
      expectedRevision,
      afterWorkspaceRevision,
      settledAt,
    ).changes;
    if (receiptInserted === 0) {
      const duplicateReceipt = db.query(
        "SELECT workspace_id, segment_id, logical_dispatch, frame_id, operation_digest, "
          + "before_workspace_revision, after_workspace_revision, settled_at "
          + "FROM agent_work_workspace_receipts WHERE user_id = ? AND execution_id = ? AND operation_key = ?",
      ).get(reservation.userId, reservation.executionId, durableSettlement.operationKey) as Row | null;
      if (!duplicateReceipt) fail("integrity_error", "startup child settlement receipt conflict disappeared");
      assertStartupChildSettlementReceiptV1(duplicateReceipt, reservation, durableSettlement, operationArgs);
    } else if (receiptInserted !== 1) {
      fail("integrity_error", "startup child settlement receipt insert was not singular");
    }
  }
  for (const mutation of settlementMutations) {
    if (!claimedSettlementKeys.has(mutation.operationKey)) verifiedNoOps.add(mutation.operationKey);
  }
  return verifiedNoOps;
}

type StartupDispatchEffectsBackfillInputV1 = Readonly<{
  userId: string;
  executionId: string;
  attemptId: string;
  workspaceId: string;
  segmentId: string;
  ownerToken: string;
  executionCasRevision: number;
  now: number;
}>;

function backfillUnfinalizedDispatchEffectsAtStartupV1(
  db: Database,
  input: StartupDispatchEffectsBackfillInputV1,
): void {
  transaction(db, () => {
    backfillUnfinalizedDispatchEffectsAtStartupInTransactionV1(db, input);
    return true;
  });
}

function backfillUnfinalizedDispatchEffectsAtStartupInTransactionV1(
  db: Database,
  input: StartupDispatchEffectsBackfillInputV1,
): void {
  const rows = db.query(
    "SELECT * FROM agent_work_segment_dispatches "
      + "WHERE user_id = ? AND execution_id = ? AND segment_id = ? AND lifecycle = 'settled' "
      + "ORDER BY dispatch_ordinal ASC, dispatch_id ASC",
  ).all(input.userId, input.executionId, input.segmentId) as Row[];
  const unfinalized = rows.filter((row) => !readDispatchEffectFinalizationPayload(db, {
    userId: input.userId,
    executionId: input.executionId,
    dispatchId: stringFrom(row, "dispatch_id"),
  }));
  if (unfinalized.length > 1 || (unfinalized[0] && unfinalized[0] !== rows.at(-1))) {
    fail("integrity_error", "multiple dispatch cursors lack effect finalization");
  }
  const row = unfinalized[0];
  if (!row) {
    assertSettledDispatchEffectsFinalized(db, input.userId, input.executionId, input.segmentId);
    return;
  }
  const dispatchId = stringFrom(row, "dispatch_id");
  const baseReservation = readDispatchMutationReservationPayload(db, {
    userId: input.userId,
    executionId: input.executionId,
    dispatchId,
  });
  if (!baseReservation) fail("integrity_error", "startup dispatch mutation reservation is unavailable");
  const reservation = completeDispatchMutationReservationPayload(db, baseReservation);
  if (
    reservation.attemptId !== input.attemptId
    || reservation.workspaceId !== input.workspaceId
    || reservation.segmentId !== input.segmentId
    || reservation.fenceGeneration !== row.fence_generation
    || reservation.providerSettlementDigest !== row.settlement_digest
    || reservation.mutations.some((mutation) => (
      mutation.segmentId !== input.segmentId || mutation.logicalDispatch !== numberFrom(row, "dispatch_ordinal")
    ))
  ) fail("integrity_error", "startup dispatch mutation reservation is unavailable or ambiguous");
  if (reservation.mutations.length === 0) {
    fail("integrity_error", "zero-reservation dispatch lacks its atomic finalization");
  }
  const verifiedNoOps = settleDurablyAssignedChildrenAtStartupV1(db, reservation);
  const workspace = db.query(
    "SELECT revision FROM agent_turn_workspaces WHERE user_id = ? AND execution_id = ? AND workspace_id = ? AND state = 'active'",
  ).get(input.userId, input.executionId, input.workspaceId) as Row | null;
  if (!workspace) fail("stale_workspace", "startup workspace authority is unavailable");
  const actualWorkspaceRevision = numberFrom(workspace, "revision");
  const durableOwners = new Map(readDispatchOwnerEffectFinalizations(db, reservation).map((record) => (
    [workspaceMutationOwnerKey(record.owner), record] as const
  )));
  const owners = new Map<string, WorkSegmentWorkspaceMutationOwnerV1>();
  for (const mutation of reservation.mutations) {
    const key = workspaceMutationOwnerKey(mutation);
    if (!owners.has(key)) owners.set(key, normalizedWorkspaceMutationOwner(mutation));
  }
  for (const [ownerKey, owner] of owners) {
    const durableOwner = durableOwners.get(ownerKey);
    let effects: readonly WorkSegmentWorkspaceMutationEffectV1[];
    let finalizationKey: string;
    if (durableOwner) {
      effects = durableOwner.effects;
      finalizationKey = durableOwner.finalizationKey;
    } else {
      let ownerCursor = reservation.baseWorkspaceRevision;
      effects = Object.freeze(reservation.mutations.filter((mutation) => (
        sameWorkspaceMutationOwner(mutation, owner)
      )).map((mutation) => {
        const receipt = db.query(
          "SELECT workspace_id, operation_digest, segment_id, logical_dispatch, frame_id, "
            + "before_workspace_revision, after_workspace_revision FROM agent_work_workspace_receipts "
            + "WHERE user_id = ? AND execution_id = ? AND operation_key = ?",
        ).get(input.userId, input.executionId, mutation.operationKey) as Row | null;
        if (receipt) {
          const beforeWorkspaceRevision = numberFrom(receipt, "before_workspace_revision");
          const afterWorkspaceRevision = numberFrom(receipt, "after_workspace_revision");
          const receiptOwner: WorkspaceMutationOwnerV1 = Object.freeze({
            segmentId: id(receipt.segment_id, "receipt.segment_id"),
            logicalDispatch: safeInteger(receipt.logical_dispatch, "receipt.logical_dispatch", MAX_COUNTER),
            frameId: id(receipt.frame_id, "receipt.frame_id"),
          });
          if (
            receipt.workspace_id !== input.workspaceId
            || !sameWorkspaceMutationOwner(receiptOwner, mutation)
            || beforeWorkspaceRevision < ownerCursor
            || afterWorkspaceRevision !== beforeWorkspaceRevision + 1
            || afterWorkspaceRevision > actualWorkspaceRevision
          ) fail("integrity_error", "startup workspace receipt is not an exact owned dispatch effect");
          ownerCursor = afterWorkspaceRevision;
          return Object.freeze({
            ...mutation,
            outcome: "mutated" as const,
            outcomeCode: null,
            operationDigest: digest(receipt.operation_digest, "receipt.operation_digest"),
            beforeWorkspaceRevision,
            afterWorkspaceRevision,
          });
        }
        if (verifiedNoOps.has(mutation.operationKey)) {
          return Object.freeze({
            ...mutation,
            outcome: "no_op" as const,
            outcomeCode: null,
            operationDigest: null,
            beforeWorkspaceRevision: ownerCursor,
            afterWorkspaceRevision: ownerCursor,
          });
        }
        return Object.freeze({
          ...mutation,
          outcome: "failed" as const,
          outcomeCode: "restart_unobserved_workspace_mutation",
          operationDigest: null,
          beforeWorkspaceRevision: ownerCursor,
          afterWorkspaceRevision: ownerCursor,
        });
      }));
      finalizationKey = "startup-owner:" + ownerKey;
    }
    finalizeSettledWorkSegmentDispatchEffectsInTransactionV1(db, {
      db,
      userId: input.userId,
      executionId: input.executionId,
      ownerToken: input.ownerToken,
      expectedExecutionCasRevision: input.executionCasRevision,
      expectedWorkspaceRevision: actualWorkspaceRevision,
      now: input.now,
      attemptId: input.attemptId,
      workspaceId: input.workspaceId,
      segmentId: input.segmentId,
      dispatchId,
      fenceGeneration: reservation.fenceGeneration,
      expectedSettlementDigest: reservation.providerSettlementDigest,
      owner,
      finalizationKey,
      effects,
      nextWorkspaceRevision: actualWorkspaceRevision,
    });
  }
  assertSettledDispatchEffectsFinalized(db, input.userId, input.executionId, input.segmentId);
}

/** Closes the one stale cursor left when execution terminalization won the final CAS. */
function convergeTerminalExecutionWorkSegmentAtStartupV1(
  db: Database,
  userId: string,
  executionId: string,
  runtimeEpoch: number,
): void {
  transaction(db, () => {
    const recoveryRow = rawRecovery(db, userId, executionId);
    if (!recoveryRow) fail("integrity_error", "terminal startup recovery cursor disappeared");
    const recovery = recoveryFromRow(recoveryRow);
    const segmentId = recovery.currentSegmentId;
    const sourceRow = segmentId === null ? null : rawSegment(db, userId, executionId, segmentId);
    const execution = db.query(`SELECT mode, state, cas_revision, workspace_id, workspace_revision,
        cancel_requested_at, deadline_at, terminal_code, terminal_at, updated_at
      FROM agent_turn_executions WHERE user_id = ? AND id = ?`).get(userId, executionId) as Row | null;
    if (!execution || execution.state !== "CANCELLED") {
      fail("integrity_error", "terminal startup recovery execution authority disappeared");
    }
    const closeResult = "cancelled" as const;
    const source = sourceRow ? segmentFromRow(sourceRow) : null;
    const executionCasRevision = numberFrom(execution, "cas_revision");
    const terminalCode = stringFrom(execution, "terminal_code");
    const terminalAt = numberFrom(execution, "terminal_at");
    const cancelRequestedAt = numberFrom(execution, "cancel_requested_at");
    const deadlineAt = numberFrom(execution, "deadline_at");
    const cancellationCause = cancellationTerminalCause(cancelRequestedAt, deadlineAt);
    const executionUpdatedAt = numberFrom(execution, "updated_at");
    if (
      execution.mode !== "agentic"
      || recovery.state !== "active"
      || segmentId === null
      || cancellationCause.phase !== "CANCELLED"
      || terminalCode !== cancellationCause.reason
      || !source
      || source.lifecycle !== "running"
      || source.identity.attemptId !== recovery.attemptId
      || source.workspaceId !== recovery.workspaceId
      || source.workspaceRevision !== recovery.workspaceRevision
      || source.executionCasRevision !== recovery.executionCasRevision
      || executionCasRevision !== safeInteger(recovery.executionCasRevision + 1, "terminalExecutionCasRevision")
      || execution.workspace_id !== recovery.workspaceId
      || numberFrom(execution, "workspace_revision") !== recovery.workspaceRevision
      || terminalAt > executionUpdatedAt
    ) fail("integrity_error", "terminal startup recovery fence is stale");

    const finalDispatch = db.query(
      `SELECT lifecycle, boundary_class, settled_at, updated_at
        FROM agent_work_segment_dispatches
        WHERE user_id = ? AND execution_id = ? AND segment_id = ?
        ORDER BY dispatch_ordinal DESC LIMIT 1`,
    ).get(userId, executionId, segmentId) as Row | null;
    const boundaryClass = finalDispatch ? nullableStringFrom(finalDispatch, "boundary_class") : null;
    const settledAt = finalDispatch?.settled_at;
    const finalDispatchUpdatedAt = finalDispatch?.updated_at;
    if (
      finalDispatch === null
      || finalDispatch.lifecycle !== "settled"
      || typeof settledAt !== "number"
      || !Number.isSafeInteger(settledAt)
      || typeof finalDispatchUpdatedAt !== "number"
      || !Number.isSafeInteger(finalDispatchUpdatedAt)
      || settledAt > finalDispatchUpdatedAt
      || finalDispatchUpdatedAt > terminalAt
      || boundaryClass === null
      || !Object.hasOwn(BOUNDARY_CLASSES, boundaryClass)
    ) fail("integrity_error", "terminal startup final dispatch is not durably settled before execution terminalization");

    const usage = aggregateSettledDispatches(db, userId, executionId, segmentId);
    for (const field of [
      "providerDispatches", "providerInputTokens", "providerOutputTokens", "providerTotalTokens",
      "billedOutputTokens", "toolCalls", "workspaceOperations", "unsignedBoundaries", "receiveBytes", "publishedOutputBytes",
    ] as const) {
      if (usage[field] !== source.usage[field]) {
        fail("integrity_error", "terminal startup segment " + field + " differs from its dispatch ledger");
      }
    }
    const idempotencyKey = "startup-terminal-authority:" + segmentId + ":" + executionCasRevision;
    const closureDigest = canonicalDigest(Object.freeze({
      version: 1,
      userId,
      executionId,
      attemptId: recovery.attemptId,
      workspaceId: recovery.workspaceId,
      sourceSegmentId: segmentId,
      idempotencyKey,
      closeResult,
      closeReason: terminalCode,
      boundaryClass,
      usage,
      workspaceRevision: recovery.workspaceRevision,
      executionCasRevision,
    }));
    const now = Math.max(Date.now(), terminalAt, executionUpdatedAt, recovery.updatedAt, source.updatedAt);
    const segmentChanged = db.query(`UPDATE agent_work_segments
      SET lifecycle = ?, boundary_class = ?, close_result = ?, close_reason = ?,
          closed_workspace_revision = ?, closed_execution_cas_revision = ?, closure_digest = ?,
          updated_at = ?, closed_at = ?
      WHERE user_id = ? AND execution_id = ? AND segment_id = ? AND lifecycle = 'running'
        AND attempt_id = ? AND workspace_id = ? AND workspace_revision = ? AND execution_cas_revision = ?
        AND updated_at = ?
        AND EXISTS (
          SELECT 1 FROM agent_turn_executions AS e
          WHERE e.user_id = agent_work_segments.user_id AND e.id = agent_work_segments.execution_id
            AND e.mode = 'agentic' AND e.state = ? AND e.cas_revision = ?
            AND e.workspace_id = ? AND e.workspace_revision = ?
            AND e.cancel_requested_at = ? AND e.deadline_at = ?
            AND e.terminal_code = ? AND e.terminal_at = ? AND e.updated_at = ?
        )`).run(
      closeLifecycle(closeResult), boundaryClass, closeResult, terminalCode,
      recovery.workspaceRevision, executionCasRevision, closureDigest, now, terminalAt,
      userId, executionId, segmentId, recovery.attemptId, recovery.workspaceId,
      recovery.workspaceRevision, recovery.executionCasRevision, source.updatedAt,
      execution.state, executionCasRevision, recovery.workspaceId, recovery.workspaceRevision,
      cancelRequestedAt, deadlineAt, terminalCode, terminalAt, executionUpdatedAt,
    ).changes;
    if (segmentChanged !== 1) fail("stale_segment", "terminal startup segment lost its exact fence");
    const recoveryChanged = db.query(`UPDATE agent_work_segment_recovery
      SET execution_cas_revision = ?, recovery_epoch = ?, state = 'closed',
          phase_id = NULL, phase_index = NULL, phase_occurrence = NULL, current_segment_id = NULL,
          next_segment_ordinal = ?, terminal_close_result = ?, terminal_close_reason = ?,
          terminal_boundary_class = ?, updated_at = ?
      WHERE user_id = ? AND execution_id = ? AND state = 'active'
        AND attempt_id = ? AND workspace_id = ? AND workspace_revision = ?
        AND execution_cas_revision = ? AND recovery_epoch = ? AND current_segment_id = ?
        AND next_segment_ordinal = ? AND updated_at = ?`).run(
      executionCasRevision, runtimeEpoch, safeInteger(source.identity.segmentOrdinal + 1, "terminalNextSegmentOrdinal"),
      closeResult, terminalCode, boundaryClass, now,
      userId, executionId, recovery.attemptId, recovery.workspaceId, recovery.workspaceRevision,
      recovery.executionCasRevision, recovery.recoveryEpoch, segmentId,
      recovery.nextSegmentOrdinal, recovery.updatedAt,
    ).changes;
    if (recoveryChanged !== 1) fail("stale_execution", "terminal startup recovery cursor lost its exact fence");
    return true;
  });
}


/** Claims and converges bounded V1 WORK chains before generic turn recovery. */
export function reconcileWorkSegmentRecoveryAtStartupV1(
  db: Database = getDb(),
  runtimeEpoch: number,
  maxRows = 1_024,
): ReconcileWorkSegmentRecoveryResultV1 {
  const epoch = safeInteger(runtimeEpoch, "runtimeEpoch", MAX_SAFE_INTEGER, 1);
  const limit = safeInteger(maxRows, "maxRows");
  if (limit <= 0 || limit > 1_000_000) fail("invalid_input", "maxRows is outside the startup recovery bound");
  const scanNow = Date.now();
  const rows = db.query(`SELECT r.user_id, r.execution_id
    FROM agent_work_segment_recovery AS r
    WHERE (
      r.recovery_epoch <> ?
      OR (
        r.recovery_epoch = ?
        AND EXISTS (
          SELECT 1 FROM agent_turn_executions AS owner
          WHERE owner.user_id = r.user_id AND owner.id = r.execution_id
            AND owner.mode = 'agentic' AND owner.state = 'WORK'
            AND owner.cas_revision = r.execution_cas_revision
            AND (owner.cas_expires_at IS NULL OR owner.cas_expires_at <= ?)
        )
      )
    ) AND (
      r.state = 'active'
      OR (
        r.state = 'closed' AND r.current_segment_id IS NULL
        AND r.phase_id IS NULL AND r.phase_index IS NULL AND r.phase_occurrence IS NULL
        AND r.terminal_close_result IS NULL AND r.terminal_close_reason IS NULL
        AND r.terminal_boundary_class IS NULL AND r.remaining_required_phase_count = 0
        AND r.protected_future_phase_reserve_output_tokens = 0
        AND EXISTS (
          SELECT 1
          FROM agent_turn_executions AS e
          JOIN agent_work_segment_transitions AS t
            ON t.user_id = r.user_id AND t.execution_id = r.execution_id
          JOIN agent_work_segments AS s
            ON s.user_id = t.user_id AND s.execution_id = t.execution_id
           AND s.segment_id = t.source_segment_id
          WHERE e.user_id = r.user_id AND e.id = r.execution_id
            AND e.mode = 'agentic' AND e.state = 'WORK'
            AND e.cas_revision = r.execution_cas_revision
            AND e.workspace_id = r.workspace_id AND e.workspace_revision = r.workspace_revision
            AND t.attempt_id = r.attempt_id AND t.workspace_id = r.workspace_id
            AND t.workspace_revision = r.workspace_revision AND t.transition_kind = 'terminal'
            AND t.target_phase_id IS NULL AND t.target_phase_index IS NULL
            AND t.target_phase_occurrence IS NULL AND t.target_segment_ordinal IS NULL
            AND t.remaining_required_phase_count = 0
            AND s.attempt_id = r.attempt_id AND s.workspace_id = r.workspace_id
            AND s.lifecycle = 'closed' AND s.close_result = 'work_complete'
            AND s.close_reason = 'transition:terminal' AND s.boundary_class IS NOT NULL
            AND s.closed_workspace_revision = r.workspace_revision
            AND s.closed_execution_cas_revision = t.execution_cas_revision
            AND s.closure_digest = t.payload_digest
            AND s.segment_ordinal + 1 = r.next_segment_ordinal
        )
      )
    )
    ORDER BY r.updated_at, r.user_id, r.execution_id LIMIT ?`)
    .all(epoch, epoch, scanNow, limit + 1) as readonly Record<string, unknown>[];
  const page = rows.slice(0, limit);
  let active = 0;
  let closed = 0;
  let queued = 0;
  let reclaimed = 0;
  let fenced = 0;
  let terminalized = 0;
  for (const row of page) {
    const userId = stringFrom(row, "user_id");
    const executionId = stringFrom(row, "execution_id");
    const chain = readWorkSegmentRecoveryChainV1(userId, executionId, db);
    if (!chain) fail("integrity_error", "startup recovery row disappeared during validation");
    if (chain.recovery.state === "closed") {
      const completion = workCompletionRecoveryAuthorityV1(chain, db);
      const execution = db.query(
        "SELECT mode, state, runtime_epoch, cas_revision, cas_owner, cas_expires_at, workspace_id, workspace_revision "
          + "FROM agent_turn_executions WHERE user_id = ? AND id = ?",
      ).get(userId, executionId) as Row | null;
      if (!execution) fail("integrity_error", "closed WORK completion execution fence is stale");
      const executionMode = stringFrom(execution, "mode");
      const executionState = stringFrom(execution, "state");
      const executionRuntimeEpoch = numberFrom(execution, "runtime_epoch");
      const executionCasRevision = numberFrom(execution, "cas_revision");
      const previousOwner = nullableStringFrom(execution, "cas_owner");
      const previousLeaseExpiry = nullableNumberFrom(execution, "cas_expires_at");
      const executionWorkspaceId = nullableStringFrom(execution, "workspace_id");
      const executionWorkspaceRevision = numberFrom(execution, "workspace_revision");
      if (
        executionMode !== "agentic"
        || executionState !== "WORK"
        || executionCasRevision !== chain.recovery.executionCasRevision
        || executionWorkspaceId !== chain.recovery.workspaceId
        || executionWorkspaceRevision !== chain.recovery.workspaceRevision
        || (chain.recovery.recoveryEpoch === epoch && (
          executionRuntimeEpoch !== epoch
          || (previousLeaseExpiry !== null && previousLeaseExpiry > scanNow)
        ))
      ) fail("integrity_error", "closed WORK completion execution fence is stale");
      const oldCas = chain.recovery.executionCasRevision;
      const newCas = safeInteger(oldCas + 1, "startupCompletionExecutionCasRevision");
      const now = Math.max(Date.now(), chain.recovery.updatedAt);
      const ownerToken = startupWorkRecoveryOwnerTokenV1(epoch, userId, executionId, oldCas, now);
      const leaseExpiresAt = safeInteger(now + 300_000, "startupCompletionLeaseExpiresAt");
      transaction(db, () => {
        const executionChanged = db.query(
          "UPDATE agent_turn_executions "
            + "SET cas_owner = ?, cas_expires_at = ?, runtime_epoch = ?, cas_revision = ?, "
            + "phase_revision = phase_revision + 1, updated_at = ? "
            + "WHERE user_id = ? AND id = ? AND mode = 'agentic' AND state = 'WORK' "
            + "AND runtime_epoch = ? AND cas_owner IS ? AND cas_expires_at IS ? AND cas_revision = ? "
            + "AND workspace_id = ? AND workspace_revision = ? AND updated_at <= ?",
        ).run(
          ownerToken, leaseExpiresAt, epoch, newCas, now,
          userId, executionId, executionRuntimeEpoch, previousOwner, previousLeaseExpiry, oldCas,
          chain.recovery.workspaceId, chain.recovery.workspaceRevision, now,
        ).changes;
        if (executionChanged !== 1) fail("stale_execution", "startup completion owner claim lost its exact CAS");
        const recoveryChanged = db.query(`UPDATE agent_work_segment_recovery
          SET execution_cas_revision = ?, recovery_epoch = ?, updated_at = ?
          WHERE user_id = ? AND execution_id = ? AND state = 'closed'
            AND attempt_id = ? AND workspace_id = ? AND workspace_revision = ?
            AND execution_cas_revision = ? AND recovery_epoch = ?
            AND current_segment_id IS NULL AND phase_id IS NULL AND phase_index IS NULL
            AND phase_occurrence IS NULL AND terminal_close_result IS NULL
            AND terminal_close_reason IS NULL AND terminal_boundary_class IS NULL
            AND next_segment_ordinal = ? AND updated_at <= ?`).run(
          newCas, epoch, now, userId, executionId,
          chain.recovery.attemptId, chain.recovery.workspaceId, chain.recovery.workspaceRevision,
          oldCas, chain.recovery.recoveryEpoch, completion.source.identity.segmentOrdinal + 1, now,
        ).changes;
        if (recoveryChanged !== 1) fail("stale_execution", "startup completion recovery CAS rebase failed");
        return true;
      });
      const queuedCompletion = readWorkSegmentRecoveryChainV1(userId, executionId, db);
      if (
        !queuedCompletion
        || queuedCompletion.recovery.state !== "closed"
        || queuedCompletion.recovery.recoveryEpoch !== epoch
        || queuedCompletion.recovery.executionCasRevision !== newCas
        || workCompletionRecoveryAuthorityV1(queuedCompletion, db).transition.transitionId
          !== completion.transition.transitionId
      ) fail("integrity_error", "startup completion claim was not durably observable");
      queued += 1;
      continue;
    }
    if (chain.recovery.state !== "active") fail("integrity_error", "startup recovery state is invalid");
    const expectedCurrentSegmentId = chain.recovery.currentSegmentId;
    const pendingTarget = expectedCurrentSegmentId === null;
    let currentSegmentId = expectedCurrentSegmentId;
    let currentSegment = currentSegmentId
      ? chain.segments.find((segment) => segment.identity.segmentId === currentSegmentId) ?? null
      : null;
    if (!pendingTarget && (!currentSegment || !["admitted", "running"].includes(currentSegment.lifecycle))) {
      fail("integrity_error", "active V1 recovery current segment is not resumable");
    }
    const execution = db.query(
      "SELECT mode, state, runtime_epoch, cas_revision, cas_owner, cas_expires_at, deadline_at, cancel_requested_at, workspace_id, workspace_revision "
        + "FROM agent_turn_executions WHERE user_id = ? AND id = ?",
    ).get(userId, executionId) as Row | null;
    if (!execution) fail("integrity_error", "active V1 recovery execution fence is stale");
    const executionState = stringFrom(execution, "state");
    if (executionState === "CANCELLED") {
      convergeTerminalExecutionWorkSegmentAtStartupV1(db, userId, executionId, epoch);
      terminalized += 1;
      closed += 1;
      continue;
    }
    const executionMode = stringFrom(execution, "mode");
    const executionRuntimeEpoch = numberFrom(execution, "runtime_epoch");
    const executionCasRevision = numberFrom(execution, "cas_revision");
    const previousOwner = nullableStringFrom(execution, "cas_owner");
    const previousLeaseExpiry = nullableNumberFrom(execution, "cas_expires_at");
    const cancelRequestedAt = nullableNumberFrom(execution, "cancel_requested_at");
    const deadlineAt = numberFrom(execution, "deadline_at");
    const executionWorkspaceId = nullableStringFrom(execution, "workspace_id");
    const executionWorkspaceRevision = numberFrom(execution, "workspace_revision");
    if (
      executionMode !== "agentic"
      || executionState !== "WORK"
      || executionCasRevision !== chain.recovery.executionCasRevision
      || executionWorkspaceId !== chain.recovery.workspaceId
      || executionWorkspaceRevision !== chain.recovery.workspaceRevision
      || (chain.recovery.recoveryEpoch === epoch && (
        executionRuntimeEpoch !== epoch
        || (previousLeaseExpiry !== null && previousLeaseExpiry > scanNow)
      ))
    ) fail("integrity_error", "active V1 recovery execution fence is stale");
    const oldCas = chain.recovery.executionCasRevision;
    const newCas = safeInteger(oldCas + 1, "startupExecutionCasRevision");
    const now = Math.max(Date.now(), chain.recovery.updatedAt);
    const ownerToken = startupWorkRecoveryOwnerTokenV1(epoch, userId, executionId, oldCas, now);
    const leaseExpiresAt = safeInteger(now + 300_000, "startupLeaseExpiresAt");
    let currentDispatches = currentSegmentId === null
      ? []
      : chain.dispatches.filter((dispatch) => dispatch.segmentId === currentSegmentId);
    let unsettled = currentDispatches.filter(
      (dispatch) => dispatch.lifecycle === "reserved" || dispatch.lifecycle === "in_flight",
    );
    transaction(db, () => {
      const claimed = db.query(
        "UPDATE agent_turn_executions "
          + "SET cas_owner = ?, cas_expires_at = ?, runtime_epoch = ?, cas_revision = ?, "
          + "phase_revision = phase_revision + 1, updated_at = ? "
          + "WHERE user_id = ? AND id = ? AND mode = 'agentic' AND state = 'WORK' "
          + "AND runtime_epoch = ? AND cas_owner IS ? AND cas_expires_at IS ? AND cas_revision = ? "
          + "AND cancel_requested_at IS ? AND deadline_at = ? "
          + "AND workspace_id = ? AND workspace_revision = ?",
      ).run(
        ownerToken, leaseExpiresAt, epoch, newCas, now,
        userId, executionId, executionRuntimeEpoch, previousOwner, previousLeaseExpiry, oldCas,
        cancelRequestedAt, deadlineAt, chain.recovery.workspaceId, chain.recovery.workspaceRevision,
      ).changes;
      if (claimed !== 1) fail("stale_execution", "startup WORK owner claim lost its exact CAS");
      if (db.query(
        "UPDATE agent_work_segment_recovery SET execution_cas_revision = ?, recovery_epoch = ?, updated_at = ? "
          + "WHERE user_id = ? AND execution_id = ? AND state = 'active' "
          + "AND execution_cas_revision = ? AND recovery_epoch = ? "
          + "AND current_segment_id IS ? AND next_segment_ordinal = ? "
          + "AND workspace_id = ? AND workspace_revision = ?",
      )
        .run(
          newCas, epoch, now, userId, executionId, oldCas, chain.recovery.recoveryEpoch,
          expectedCurrentSegmentId, chain.recovery.nextSegmentOrdinal,
          chain.recovery.workspaceId, chain.recovery.workspaceRevision,
        ).changes !== 1) {
        fail("stale_execution", "startup recovery CAS rebase failed");
      }
      if (pendingTarget) {
        const target = committedStartupTargetFromChainV1(chain, db);
        const handoff = target.transition.handoff;
        const admission = admitWorkSegmentInTransactionV1(db, {
          userId,
          executionId,
          ownerToken,
          expectedExecutionCasRevision: newCas,
          expectedWorkspaceRevision: chain.recovery.workspaceRevision,
          now,
          db,
          attemptId: chain.recovery.attemptId,
          workspaceId: chain.recovery.workspaceId,
          sourceTransitionId: target.transition.transitionId,
          phaseId: handoff.targetPhaseId,
          phaseIndex: handoff.targetPhaseIndex!,
          phaseOccurrence: handoff.targetPhaseOccurrence!,
          segmentOrdinal: handoff.targetSegmentOrdinal!,
          admissionKey: ["work-segment", chain.recovery.attemptId, handoff.targetSegmentOrdinal].join(":"),
          contextDigest: target.context.contextDigest,
          context: target.context,
          budget: target.source.context.segmentBudget,
        });
        if (admission.duplicate) fail("integrity_error", "startup handoff target was already admitted without its cursor");
        currentSegmentId = admission.record.identity.segmentId;
        currentSegment = admission.record;
        currentDispatches = [];
        unsettled = [];
      } else {
        if (db.query(`UPDATE agent_work_segments SET execution_cas_revision = ?, updated_at = ?
          WHERE user_id = ? AND execution_id = ? AND segment_id = ?
            AND lifecycle IN ('admitted', 'running') AND execution_cas_revision = ?`)
          .run(newCas, now, userId, executionId, currentSegmentId, oldCas).changes !== 1) {
          fail("stale_execution", "startup segment CAS rebase failed");
        }
        if (unsettled.length > 0) {
          db.query("UPDATE agent_work_segments SET lifecycle = 'running' WHERE user_id = ? AND execution_id = ? AND segment_id = ? AND lifecycle = 'admitted'")
            .run(userId, executionId, currentSegmentId);
        }
        const dispatchesChanged = db.query(`UPDATE agent_work_segment_dispatches SET execution_cas_revision = ?, updated_at = ?,
            lifecycle = 'in_flight', started_at = COALESCE(started_at, ?),
            lease_expires_at = ?, fence_generation = fence_generation + 1
          WHERE user_id = ? AND execution_id = ? AND segment_id = ?
            AND lifecycle IN ('reserved', 'in_flight') AND execution_cas_revision = ?`)
          .run(newCas, now, now, now, userId, executionId, currentSegmentId, oldCas).changes;
        if (dispatchesChanged !== unsettled.length) fail("stale_execution", "startup dispatch CAS rebase failed");
      }
      return true;
    });
    if (!currentSegmentId || !currentSegment) fail("integrity_error", "startup current segment admission was not observable");
    backfillUnfinalizedDispatchEffectsAtStartupV1(db, {
      userId,
      executionId,
      attemptId: chain.recovery.attemptId,
      workspaceId: chain.recovery.workspaceId,
      segmentId: currentSegmentId,
      ownerToken,
      executionCasRevision: newCas,
      now,
    });
    const cancellationCause = typeof cancelRequestedAt === "number"
      ? cancellationTerminalCause(cancelRequestedAt, deadlineAt as number)
      : null;
    if (currentDispatches.length > 0) {
      for (const dispatch of unsettled) {
        interruptUnsettledWorkSegmentDispatchV1({
          userId, executionId, ownerToken, expectedExecutionCasRevision: newCas,
          expectedWorkspaceRevision: chain.recovery.workspaceRevision, now, db,
          segmentId: currentSegmentId, dispatchId: dispatch.dispatchId,
          interruptionKey: "startup-fence:" + dispatch.dispatchId,
          reason: "startup_unsettled_dispatch_no_replay",
        });
        fenced += 1;
      }
      const refreshed = readWorkSegmentRecoveryChainV1(userId, executionId, db);
      if (!refreshed) fail("integrity_error", "startup recovery chain disappeared after dispatch interruption");
      const source = refreshed.segments.find((segment) => segment.identity.segmentId === currentSegmentId);
      const finalDispatch = refreshed.dispatches
        .filter((dispatch) => dispatch.segmentId === currentSegmentId)
        .at(-1);
      if (!source || !finalDispatch || finalDispatch.boundaryClass === null || finalDispatch.usage === null) {
        fail("integrity_error", "startup durable dispatch terminal state disappeared");
      }
      closeWorkSegmentTerminalV1({
        userId, executionId, ownerToken, expectedExecutionCasRevision: newCas,
        expectedWorkspaceRevision: refreshed.recovery.workspaceRevision, now, db,
        attemptId: refreshed.recovery.attemptId, workspaceId: refreshed.recovery.workspaceId,
        sourceSegmentId: currentSegmentId, idempotencyKey: "startup-terminal:" + currentSegmentId,
        closeResult: cancellationCause?.phase === "CANCELLED" ? "cancelled" : "failed",
        closeReason: cancellationCause?.reason ?? "restart_existing_dispatch_no_replay",
        boundaryClass: finalDispatch.boundaryClass, usage: source.usage,
      });
      terminalized += 1;
      closed += 1;
      continue;
    }
    if (cancellationCause) {
      closeAdmittedWorkSegmentWithoutDispatchTerminalV1({
        userId, executionId, ownerToken, expectedExecutionCasRevision: newCas,
        expectedWorkspaceRevision: chain.recovery.workspaceRevision, now, db,
        attemptId: chain.recovery.attemptId, workspaceId: chain.recovery.workspaceId,
        sourceSegmentId: currentSegmentId, idempotencyKey: "startup-cancellation:" + currentSegmentId,
        closeResult: cancellationCause.phase === "CANCELLED" ? "cancelled" : "failed",
        closeReason: cancellationCause.reason,
      });
      terminalized += 1;
      closed += 1;
      continue;
    }
    if (chain.recovery.resumeEnvelope.runtime.deadlineAt <= now) {
      closeAdmittedWorkSegmentWithoutDispatchTerminalV1({
        userId, executionId, ownerToken, expectedExecutionCasRevision: newCas,
        expectedWorkspaceRevision: chain.recovery.workspaceRevision, now, db,
        attemptId: chain.recovery.attemptId, workspaceId: chain.recovery.workspaceId,
        sourceSegmentId: currentSegmentId, idempotencyKey: "startup-deadline:" + currentSegmentId,
        closeResult: "failed", closeReason: "root_wall_clock_limit_exceeded",
      });
      terminalized += 1;
      closed += 1;
      continue;
    }
    const drainVisible = db.query(
      "SELECT 1 AS present FROM agent_work_segment_recovery AS r "
        + "JOIN agent_turn_executions AS e ON e.user_id = r.user_id AND e.id = r.execution_id "
        + "WHERE r.user_id = ? AND r.execution_id = ? AND r.state = 'active' AND r.recovery_epoch = ? "
        + "AND e.mode = 'agentic' AND e.state = 'WORK' AND e.runtime_epoch = ? "
        + "AND e.cas_revision = r.execution_cas_revision AND e.workspace_id = r.workspace_id "
        + "AND e.workspace_revision = r.workspace_revision AND e.cas_owner LIKE 'wso_%'",
    ).get(userId, executionId, epoch, epoch);
    if (!drainVisible) fail("integrity_error", "startup recovery claim is not visible to the exact drain query");
    active += 1;
    queued += 1;
  }
  return Object.freeze({
    scanned: page.length, active, closed, queued, reclaimed, fenced, terminalized,
    complete: rows.length <= limit,
    healthy: true,
  });
}

/** Internal post-install drain source. Only rows claimed for this runtime epoch are visible. */
export function listQueuedWorkSegmentRecoveriesV1(
  runtimeEpoch: number,
  db: Database = getDb(),
  maxRows = 1_024,
): readonly WorkSegmentRecoveryChainV1[] {
  const epoch = safeInteger(runtimeEpoch, "runtimeEpoch", MAX_SAFE_INTEGER, 1);
  const limit = safeInteger(maxRows, "maxRows");
  if (limit <= 0 || limit > 1_000_000) fail("invalid_input", "maxRows is outside the resume drain bound");
  const identities = db.query(
    "SELECT r.user_id, r.execution_id, e.cas_owner "
      + "FROM agent_work_segment_recovery AS r JOIN agent_turn_executions AS e "
      + "ON e.user_id = r.user_id AND e.id = r.execution_id "
      + "WHERE r.state = 'active' AND r.recovery_epoch = ? "
      + "AND e.mode = 'agentic' AND e.state = 'WORK' AND e.runtime_epoch = ? "
      + "AND e.cas_revision = r.execution_cas_revision AND e.workspace_id = r.workspace_id "
      + "AND e.workspace_revision = r.workspace_revision AND e.cas_owner LIKE 'wso_%' "
      + "ORDER BY r.updated_at, r.user_id, r.execution_id LIMIT ?",
  ).all(epoch, epoch, limit) as readonly Record<string, unknown>[];
  return Object.freeze(identities.map((row) => {
    const userId = stringFrom(row, "user_id");
    const executionId = stringFrom(row, "execution_id");
    const chain = readWorkSegmentRecoveryChainV1(userId, executionId, db);
    if (!chain || chain.recovery.state !== "active" || chain.recovery.recoveryEpoch !== epoch) {
      fail("integrity_error", "queued WORK recovery lost its epoch claim");
    }
    const expectedQueueOwner = startupWorkRecoveryOwnerTokenV1(
      epoch,
      userId,
      executionId,
      safeInteger(chain.recovery.executionCasRevision - 1, "queuedPreviousExecutionCasRevision"),
      chain.recovery.updatedAt,
    );
    if (row.cas_owner !== expectedQueueOwner) {
      fail("integrity_error", "queued WORK recovery owner is not its deterministic startup claim");
    }
    const currentSegmentId = chain.recovery.currentSegmentId;
    const current = currentSegmentId
      ? chain.segments.find((segment) => segment.identity.segmentId === currentSegmentId)
      : null;
    if (!currentSegmentId || !current || !["admitted", "running"].includes(current.lifecycle)) {
      fail("integrity_error", "queued WORK recovery lacks its exact active segment");
    }
    if (chain.dispatches.some((dispatch) => dispatch.segmentId === currentSegmentId)) {
      fail("integrity_error", "queued WORK recovery current segment contains dispatch history");
    }
    return chain;
  }));
}

/** Atomically transfers one queued chain from its startup owner to one drain caller. */
export function claimQueuedWorkSegmentRecoveryV1(
  input: ClaimQueuedWorkSegmentRecoveryInputV1,
): WorkSegmentRecoveryChainV1 | null {
  const db = input.db ?? getDb();
  const userId = id(input.userId, "userId");
  const executionId = id(input.executionId, "executionId");
  const epoch = safeInteger(input.runtimeEpoch, "runtimeEpoch", MAX_SAFE_INTEGER, 1);
  const expectedOwnerToken = id(input.expectedOwnerToken, "expectedOwnerToken");
  const claimOwnerToken = id(input.claimOwnerToken, "claimOwnerToken");
  const expectedCas = safeInteger(input.expectedExecutionCasRevision, "expectedExecutionCasRevision");
  const expectedSegmentId = id(input.expectedSegmentId, "expectedSegmentId");
  const now = safeInteger(input.now, "now");
  if (claimOwnerToken === expectedOwnerToken) fail("invalid_input", "drain claim must rotate the execution owner");
  if (!expectedOwnerToken.startsWith("wso_") || claimOwnerToken.startsWith("wso_")) {
    fail("invalid_input", "drain claim owner classes are invalid");
  }
  return transaction(db, () => {
    const candidate = db.query(`SELECT e.deadline_at, r.updated_at AS recovery_updated_at
      FROM agent_turn_executions AS e
      JOIN agent_work_segment_recovery AS r
        ON r.user_id = e.user_id AND r.execution_id = e.id
      JOIN agent_work_segments AS s
        ON s.user_id = r.user_id AND s.execution_id = r.execution_id AND s.segment_id = r.current_segment_id
      WHERE e.user_id = ? AND e.id = ? AND e.mode = 'agentic' AND e.state = 'WORK'
        AND e.runtime_epoch = ? AND e.cas_owner = ? AND e.cas_revision = ?
        AND e.cas_expires_at > ? AND e.updated_at <= ?
        AND r.state = 'active' AND r.recovery_epoch = ? AND r.execution_cas_revision = ?
        AND r.current_segment_id = ? AND r.updated_at <= ?
        AND r.workspace_id = e.workspace_id AND r.workspace_revision = e.workspace_revision
        AND s.segment_id = ? AND s.lifecycle IN ('admitted', 'running')
        AND s.execution_cas_revision = ? AND s.workspace_id = r.workspace_id
        AND s.workspace_revision = r.workspace_revision AND s.updated_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM agent_work_segment_dispatches AS d
          WHERE d.user_id = s.user_id AND d.execution_id = s.execution_id AND d.segment_id = s.segment_id
        )`).get(
          userId, executionId, epoch, expectedOwnerToken, expectedCas, now, now,
          epoch, expectedCas, expectedSegmentId, now,
          expectedSegmentId, expectedCas, now,
        ) as Row | null;
    if (!candidate) return null;
    if (expectedOwnerToken !== startupWorkRecoveryOwnerTokenV1(
      epoch,
      userId,
      executionId,
      safeInteger(expectedCas - 1, "claimPreviousExecutionCasRevision"),
      numberFrom(candidate, "recovery_updated_at"),
    )) return null;
    const leaseExpiresAt = Math.min(numberFrom(candidate, "deadline_at"), safeInteger(now + 300_000, "claimLeaseExpiresAt"));
    if (leaseExpiresAt <= now) return null;
    const newCas = safeInteger(expectedCas + 1, "claimExecutionCasRevision");
    const executionChanged = db.query(`UPDATE agent_turn_executions
      SET cas_owner = ?, cas_expires_at = ?, cas_revision = ?, phase_revision = phase_revision + 1, updated_at = ?
      WHERE user_id = ? AND id = ? AND mode = 'agentic' AND state = 'WORK'
        AND runtime_epoch = ? AND cas_owner = ? AND cas_revision = ?
        AND cas_expires_at > ? AND updated_at <= ?`).run(
        claimOwnerToken, leaseExpiresAt, newCas, now,
        userId, executionId, epoch, expectedOwnerToken, expectedCas, now, now,
      ).changes;
    if (executionChanged !== 1) return null;
    if (db.query(`UPDATE agent_work_segment_recovery SET execution_cas_revision = ?, updated_at = ?
      WHERE user_id = ? AND execution_id = ? AND state = 'active' AND recovery_epoch = ?
        AND execution_cas_revision = ? AND current_segment_id = ? AND updated_at <= ?`).run(
        newCas, now, userId, executionId, epoch, expectedCas, expectedSegmentId, now,
      ).changes !== 1) fail("stale_execution", "drain claim recovery CAS rebase failed");
    if (db.query(`UPDATE agent_work_segments SET execution_cas_revision = ?, updated_at = ?
      WHERE user_id = ? AND execution_id = ? AND segment_id = ?
        AND lifecycle IN ('admitted', 'running') AND execution_cas_revision = ? AND updated_at <= ?`).run(
        newCas, now, userId, executionId, expectedSegmentId, expectedCas, now,
      ).changes !== 1) fail("stale_execution", "drain claim segment CAS rebase failed");
    const refreshed = readWorkSegmentRecoveryChainV1(userId, executionId, db);
    if (!refreshed || refreshed.recovery.recoveryEpoch !== epoch
      || refreshed.recovery.currentSegmentId !== expectedSegmentId
      || refreshed.recovery.executionCasRevision !== newCas) {
      fail("integrity_error", "drain claim was not durably observable");
    }
    return refreshed;
  });
}

/** Read-only bounded queue of exact closed WORK completions owned by startup. */
export function listQueuedWorkCompletionRecoveriesV1(
  runtimeEpoch: number,
  db: Database = getDb(),
  maxRows = 1_024,
): readonly WorkSegmentRecoveryChainV1[] {
  const epoch = safeInteger(runtimeEpoch, "runtimeEpoch", MAX_SAFE_INTEGER, 1);
  const limit = safeInteger(maxRows, "maxRows");
  if (limit <= 0 || limit > 1_000_000) fail("invalid_input", "maxRows is outside the completion drain bound");
  const identities = db.query(
    "SELECT r.user_id, r.execution_id, e.cas_owner "
      + "FROM agent_work_segment_recovery AS r JOIN agent_turn_executions AS e "
      + "ON e.user_id = r.user_id AND e.id = r.execution_id "
      + "WHERE r.state = 'closed' AND r.recovery_epoch = ? AND r.current_segment_id IS NULL "
      + "AND r.phase_id IS NULL AND r.phase_index IS NULL AND r.phase_occurrence IS NULL "
      + "AND r.terminal_close_result IS NULL AND r.terminal_close_reason IS NULL "
      + "AND r.terminal_boundary_class IS NULL AND r.remaining_required_phase_count = 0 "
      + "AND r.protected_future_phase_reserve_output_tokens = 0 "
      + "AND e.mode = 'agentic' AND e.state = 'WORK' AND e.runtime_epoch = ? "
      + "AND e.cas_revision = r.execution_cas_revision AND e.workspace_id = r.workspace_id "
      + "AND e.workspace_revision = r.workspace_revision AND e.cas_owner LIKE 'wso_%' "
      + "ORDER BY r.updated_at, r.user_id, r.execution_id LIMIT ?",
  ).all(epoch, epoch, limit) as readonly Row[];
  return Object.freeze(identities.map((row) => {
    const userId = stringFrom(row, "user_id");
    const executionId = stringFrom(row, "execution_id");
    const chain = readWorkSegmentRecoveryChainV1(userId, executionId, db);
    if (!chain || chain.recovery.recoveryEpoch !== epoch) {
      fail("integrity_error", "queued WORK completion lost its epoch claim");
    }
    workCompletionRecoveryAuthorityV1(chain, db);
    const expectedOwner = startupWorkRecoveryOwnerTokenV1(
      epoch,
      userId,
      executionId,
      safeInteger(chain.recovery.executionCasRevision - 1, "queuedCompletionPreviousCasRevision"),
      chain.recovery.updatedAt,
    );
    if (row.cas_owner !== expectedOwner) {
      fail("integrity_error", "queued WORK completion owner is not its deterministic startup claim");
    }
    return chain;
  }));
}

/** Atomically transfers one closed completion from startup to one drain caller. */
export function claimQueuedWorkCompletionRecoveryV1(
  input: ClaimQueuedWorkCompletionRecoveryInputV1,
): WorkSegmentRecoveryChainV1 | null {
  const db = input.db ?? getDb();
  const userId = id(input.userId, "userId");
  const executionId = id(input.executionId, "executionId");
  const epoch = safeInteger(input.runtimeEpoch, "runtimeEpoch", MAX_SAFE_INTEGER, 1);
  const expectedOwnerToken = id(input.expectedOwnerToken, "expectedOwnerToken");
  const expectedCas = safeInteger(input.expectedExecutionCasRevision, "expectedExecutionCasRevision");
  const expectedAttemptId = id(input.expectedAttemptId, "expectedAttemptId");
  const expectedWorkspaceId = id(input.expectedWorkspaceId, "expectedWorkspaceId");
  const expectedTransitionId = id(input.expectedTerminalTransitionId, "expectedTerminalTransitionId");
  const claimOwnerToken = id(input.claimOwnerToken, "claimOwnerToken");
  const now = safeInteger(input.now, "now");
  if (
    claimOwnerToken === expectedOwnerToken
    || !expectedOwnerToken.startsWith("wso_")
    || claimOwnerToken.startsWith("wso_")
  ) fail("invalid_input", "completion drain claim owner classes are invalid");
  return transaction(db, () => {
    const candidate = db.query(
      "SELECT r.updated_at AS recovery_updated_at, r.workspace_revision, t.source_segment_id "
        + "FROM agent_turn_executions AS e JOIN agent_work_segment_recovery AS r "
        + "ON r.user_id = e.user_id AND r.execution_id = e.id "
        + "JOIN agent_work_segment_transitions AS t "
        + "ON t.user_id = r.user_id AND t.execution_id = r.execution_id AND t.attempt_id = r.attempt_id "
        + "JOIN agent_work_segments AS s "
        + "ON s.user_id = t.user_id AND s.execution_id = t.execution_id AND s.segment_id = t.source_segment_id "
        + "WHERE e.user_id = ? AND e.id = ? AND e.mode = 'agentic' AND e.state = 'WORK' "
        + "AND e.runtime_epoch = ? AND e.cas_owner = ? AND e.cas_revision = ? "
        + "AND e.cas_expires_at > ? AND e.updated_at <= ? "
        + "AND r.state = 'closed' AND r.recovery_epoch = ? AND r.execution_cas_revision = ? "
        + "AND r.attempt_id = ? AND r.workspace_id = ? AND r.workspace_id = e.workspace_id "
        + "AND r.workspace_revision = e.workspace_revision AND r.current_segment_id IS NULL "
        + "AND r.phase_id IS NULL AND r.phase_index IS NULL AND r.phase_occurrence IS NULL "
        + "AND r.terminal_close_result IS NULL AND r.terminal_close_reason IS NULL "
        + "AND r.terminal_boundary_class IS NULL AND r.remaining_required_phase_count = 0 "
        + "AND r.protected_future_phase_reserve_output_tokens = 0 AND r.updated_at <= ? "
        + "AND t.transition_id = ? AND t.workspace_id = r.workspace_id "
        + "AND t.workspace_revision = r.workspace_revision AND t.transition_kind = 'terminal' "
        + "AND t.target_phase_id IS NULL AND t.target_phase_index IS NULL "
        + "AND t.target_phase_occurrence IS NULL AND t.target_segment_ordinal IS NULL "
        + "AND t.remaining_required_phase_count = 0 "
        + "AND s.attempt_id = r.attempt_id AND s.workspace_id = r.workspace_id "
        + "AND s.lifecycle = 'closed' AND s.close_result = 'work_complete' "
        + "AND s.close_reason = 'transition:terminal' AND s.boundary_class IS NOT NULL "
        + "AND s.closed_workspace_revision = r.workspace_revision "
        + "AND s.closed_execution_cas_revision = t.execution_cas_revision "
        + "AND s.closure_digest = t.payload_digest AND s.segment_ordinal + 1 = r.next_segment_ordinal",
    ).get(
      userId,
      executionId,
      epoch,
      expectedOwnerToken,
      expectedCas,
      now,
      now,
      epoch,
      expectedCas,
      expectedAttemptId,
      expectedWorkspaceId,
      now,
      expectedTransitionId,
    ) as Row | null;
    if (!candidate) return null;
    if (expectedOwnerToken !== startupWorkRecoveryOwnerTokenV1(
      epoch,
      userId,
      executionId,
      safeInteger(expectedCas - 1, "completionClaimPreviousCasRevision"),
      numberFrom(candidate, "recovery_updated_at"),
    )) return null;
    const chain = readWorkSegmentRecoveryChainV1(userId, executionId, db);
    if (!chain) return null;
    const completion = workCompletionRecoveryAuthorityV1(chain, db);
    if (completion.transition.transitionId !== expectedTransitionId) return null;
    const newCas = safeInteger(expectedCas + 1, "completionClaimExecutionCasRevision");
    const leaseExpiresAt = safeInteger(now + 300_000, "completionClaimLeaseExpiresAt");
    const executionChanged = db.query(
      "UPDATE agent_turn_executions SET cas_owner = ?, cas_expires_at = ?, cas_revision = ?, "
        + "phase_revision = phase_revision + 1, updated_at = ? "
        + "WHERE user_id = ? AND id = ? AND mode = 'agentic' AND state = 'WORK' "
        + "AND runtime_epoch = ? AND cas_owner = ? AND cas_revision = ? "
        + "AND cas_expires_at > ? AND workspace_id = ? AND workspace_revision = ? AND updated_at <= ?",
    ).run(
      claimOwnerToken,
      leaseExpiresAt,
      newCas,
      now,
      userId,
      executionId,
      epoch,
      expectedOwnerToken,
      expectedCas,
      now,
      expectedWorkspaceId,
      numberFrom(candidate, "workspace_revision"),
      now,
    ).changes;
    if (executionChanged !== 1) return null;
    const recoveryChanged = db.query(
      "UPDATE agent_work_segment_recovery SET execution_cas_revision = ?, updated_at = ? "
        + "WHERE user_id = ? AND execution_id = ? AND state = 'closed' AND recovery_epoch = ? "
        + "AND execution_cas_revision = ? AND attempt_id = ? AND workspace_id = ? "
        + "AND workspace_revision = ? AND current_segment_id IS NULL "
        + "AND terminal_close_result IS NULL AND terminal_close_reason IS NULL "
        + "AND terminal_boundary_class IS NULL AND updated_at <= ?",
    ).run(
      newCas,
      now,
      userId,
      executionId,
      epoch,
      expectedCas,
      expectedAttemptId,
      expectedWorkspaceId,
      numberFrom(candidate, "workspace_revision"),
      now,
    ).changes;
    if (recoveryChanged !== 1) fail("stale_execution", "completion drain recovery CAS rebase failed");
    const refreshed = readWorkSegmentRecoveryChainV1(userId, executionId, db);
    if (
      !refreshed
      || refreshed.recovery.executionCasRevision !== newCas
      || refreshed.recovery.recoveryEpoch !== epoch
      || workCompletionRecoveryAuthorityV1(refreshed, db).transition.transitionId !== expectedTransitionId
    ) fail("integrity_error", "completion drain claim was not durably observable");
    return refreshed;
  });
}

/**
 * Extends the exact WORK execution owner before the first durable Segment
 * exists, atomically adopting an already-committed workspace revision.
 */
export function renewWorkExecutionOwnerLeaseV1(
  input: RenewWorkExecutionOwnerLeaseInputV1,
): void {
  const db = input.db ?? getDb();
  const epoch = safeInteger(input.runtimeEpoch, "runtimeEpoch", MAX_SAFE_INTEGER, 1);
  const requestedLeaseExpiresAt = safeInteger(input.leaseExpiresAt, "leaseExpiresAt");
  transaction(db, () => {
    const authorityRow = authority(db, input, true, true, true);
    const execution = db.query("SELECT deadline_at FROM agent_turn_executions WHERE user_id = ? AND id = ?")
      .get(authorityRow.user_id, authorityRow.execution_id) as Row | null;
    if (!execution) fail("stale_execution", "WORK execution owner disappeared during renewal");
    const leaseExpiresAt = Math.min(
      numberFrom(execution, "deadline_at"),
      safeInteger(input.now + 300_000, "workOwnerLeaseExpiresAt"),
    );
    if (leaseExpiresAt <= input.now) {
      fail("stale_owner", "WORK owner lease expired before renewal");
    }
    if (requestedLeaseExpiresAt !== leaseExpiresAt) {
      fail("invalid_input", "WORK owner lease renewal must use the bounded root deadline");
    }
    const changed = db.query(`UPDATE agent_turn_executions SET cas_expires_at = ?, workspace_revision = ?
      WHERE user_id = ? AND id = ? AND mode = 'agentic' AND state = 'WORK'
        AND runtime_epoch = ? AND cas_owner = ? AND cas_revision = ? AND workspace_revision <= ?
        AND cas_expires_at > ? AND cas_expires_at <= ? AND deadline_at >= ?`).run(
      leaseExpiresAt,
      input.expectedWorkspaceRevision,
      authorityRow.user_id,
      authorityRow.execution_id,
      epoch,
      input.ownerToken,
      input.expectedExecutionCasRevision,
      input.expectedWorkspaceRevision,
      input.now,
      leaseExpiresAt,
      leaseExpiresAt,
    ).changes;
    if (changed !== 1) fail("stale_owner", "WORK execution owner lease renewal lost its exact fence");
    const recovery = db.query(`SELECT current_segment_id FROM agent_work_segment_recovery
      WHERE user_id = ? AND execution_id = ? AND state = 'active'
        AND execution_cas_revision = ? AND workspace_revision <= ?`).get(
      authorityRow.user_id, authorityRow.execution_id, input.expectedExecutionCasRevision, input.expectedWorkspaceRevision,
    ) as Row | null;
    if (recovery) {
      const currentSegmentId = nullableStringFrom(recovery, "current_segment_id");
      if (currentSegmentId !== null) {
        const segmentChanged = db.query(`UPDATE agent_work_segments SET workspace_revision = ?, updated_at = ?
          WHERE user_id = ? AND execution_id = ? AND segment_id = ?
            AND lifecycle IN ('admitted', 'running') AND execution_cas_revision = ? AND workspace_revision <= ?`).run(
          input.expectedWorkspaceRevision, input.now, authorityRow.user_id, authorityRow.execution_id, currentSegmentId,
          input.expectedExecutionCasRevision, input.expectedWorkspaceRevision,
        ).changes;
        if (segmentChanged !== 1) fail("stale_owner", "WORK segment workspace projection lost its exact fence");
      }
      const recoveryChanged = db.query(`UPDATE agent_work_segment_recovery SET workspace_revision = ?, updated_at = ?
        WHERE user_id = ? AND execution_id = ? AND state = 'active'
          AND execution_cas_revision = ? AND workspace_revision <= ? AND current_segment_id IS ?`).run(
        input.expectedWorkspaceRevision, input.now, authorityRow.user_id, authorityRow.execution_id,
        input.expectedExecutionCasRevision, input.expectedWorkspaceRevision, currentSegmentId,
      ).changes;
      if (recoveryChanged !== 1) fail("stale_owner", "WORK recovery workspace projection lost its exact fence");
    }
    return true;
  });
}

/** Extends only the active WORK execution owner lease under the exact segment fence. */
export function renewWorkSegmentOwnerLeaseV1(
  input: RenewWorkSegmentOwnerLeaseInputV1,
): WorkSegmentRecoveryChainV1 {
  const db = input.db ?? getDb();
  const epoch = safeInteger(input.runtimeEpoch, "runtimeEpoch", MAX_SAFE_INTEGER, 1);
  const currentSegmentId = id(input.currentSegmentId, "currentSegmentId");
  const leaseExpiresAt = safeInteger(input.leaseExpiresAt, "leaseExpiresAt");
  if (leaseExpiresAt <= input.now) fail("stale_owner", "owner lease expired before renewal");
  return transaction(db, () => {
    const authorityRow = authority(db, input, true, false, true);
    const changed = db.query(`UPDATE agent_turn_executions AS e SET cas_expires_at = ?
      WHERE e.user_id = ? AND e.id = ? AND e.mode = 'agentic' AND e.state = 'WORK'
        AND e.runtime_epoch = ? AND e.cas_owner = ? AND e.cas_revision = ?
        AND e.workspace_revision = ? AND e.cas_expires_at > ? AND e.cas_expires_at <= ?
        AND e.deadline_at >= ?
        AND EXISTS (
          SELECT 1 FROM agent_work_segment_recovery AS r
          JOIN agent_work_segments AS s
            ON s.user_id = r.user_id AND s.execution_id = r.execution_id AND s.segment_id = r.current_segment_id
          WHERE r.user_id = e.user_id AND r.execution_id = e.id AND r.state = 'active'
            AND r.execution_cas_revision = e.cas_revision
            AND r.workspace_revision = ? AND r.current_segment_id = ?
            AND s.lifecycle IN ('admitted', 'running') AND s.execution_cas_revision = e.cas_revision
            AND s.workspace_revision = r.workspace_revision
        )`).run(
          leaseExpiresAt,
          authorityRow.user_id, authorityRow.execution_id, epoch, input.ownerToken,
          input.expectedExecutionCasRevision, input.expectedWorkspaceRevision,
          input.now, leaseExpiresAt, leaseExpiresAt,
          input.expectedWorkspaceRevision, currentSegmentId,
        ).changes;
    if (changed !== 1) fail("stale_owner", "WORK owner lease renewal lost its exact fence");
    const refreshed = readWorkSegmentRecoveryChainV1(authorityRow.user_id, authorityRow.execution_id, db);
    if (!refreshed
      || refreshed.recovery.executionCasRevision !== input.expectedExecutionCasRevision
      || refreshed.recovery.currentSegmentId !== currentSegmentId) {
      fail("integrity_error", "WORK owner lease renewal lost segment coherence");
    }
    return refreshed;
  });
}

/** Extends one known in-flight dispatch lease without changing its replay fence. */
export function renewInFlightWorkSegmentDispatchLeaseV1(
  input: RenewInFlightWorkSegmentDispatchLeaseInputV1,
): WorkSegmentDispatchReservationV1 {
  const db = input.db ?? getDb();
  const segmentId = id(input.segmentId, "segmentId");
  const dispatchId = id(input.dispatchId, "dispatchId");
  const leaseOwner = id(input.leaseOwner, "leaseOwner");
  const fenceGeneration = safeInteger(input.fenceGeneration, "fenceGeneration", MAX_COUNTER, 1);
  const requestedLeaseExpiresAt = safeInteger(input.leaseExpiresAt, "leaseExpiresAt");
  return transaction(db, () => {
    const authorityRow = authority(db, input, true);
    const execution = db.query("SELECT deadline_at FROM agent_turn_executions WHERE user_id = ? AND id = ?")
      .get(authorityRow.user_id, authorityRow.execution_id) as Row | null;
    if (!execution) fail("stale_execution", "dispatch renewal execution disappeared");
    const leaseExpiresAt = Math.min(
      numberFrom(execution, "deadline_at"),
      safeInteger(input.now + 120_000, "dispatchLeaseExpiresAt"),
    );
    if (leaseExpiresAt <= input.now) {
      fail("stale_owner", "dispatch lease expired before renewal");
    }
    if (requestedLeaseExpiresAt !== leaseExpiresAt) {
      fail("invalid_input", "dispatch lease renewal must use the bounded root deadline");
    }
    const changed = db.query(`UPDATE agent_work_segment_dispatches AS d
      SET lease_expires_at = ?, updated_at = ?
      WHERE d.user_id = ? AND d.execution_id = ? AND d.segment_id = ? AND d.dispatch_id = ?
        AND d.lifecycle = 'in_flight' AND d.lease_owner = ? AND d.fence_generation = ?
        AND d.execution_cas_revision = ? AND d.workspace_revision = ?
        AND d.lease_expires_at > ? AND d.lease_expires_at <= ? AND d.updated_at <= ?
        AND EXISTS (
          SELECT 1 FROM agent_work_segment_recovery AS r
          JOIN agent_work_segments AS s
            ON s.user_id = r.user_id AND s.execution_id = r.execution_id AND s.segment_id = r.current_segment_id
          WHERE r.user_id = d.user_id AND r.execution_id = d.execution_id AND r.state = 'active'
            AND r.current_segment_id = d.segment_id AND r.execution_cas_revision = d.execution_cas_revision
            AND r.workspace_revision = d.workspace_revision AND s.lifecycle = 'running'
            AND s.execution_cas_revision = d.execution_cas_revision AND s.workspace_revision = d.workspace_revision
        )`).run(
          leaseExpiresAt, input.now,
          authorityRow.user_id, authorityRow.execution_id, segmentId, dispatchId,
          leaseOwner, fenceGeneration, input.expectedExecutionCasRevision, input.expectedWorkspaceRevision,
          input.now, leaseExpiresAt, input.now,
        ).changes;
    if (changed !== 1) fail("stale_owner", "in-flight dispatch lease renewal lost its exact fence");
    const refreshed = rawDispatch(db, authorityRow.user_id, authorityRow.execution_id, dispatchId);
    if (!refreshed) fail("integrity_error", "renewed dispatch was not observable");
    return dispatchFromRow(refreshed);
  });
}
