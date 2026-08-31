import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { compareUtf8 } from "../utils/utf8-order";
import { encodeCanonicalPlainData } from "../utils/canonical-plain-data";
import {
  PERSISTENT_WORKSPACE_RECORD_KINDS,
  PERSISTENT_WORKSPACE_TERMINAL_OUTCOMES,
  PERSISTENT_WORKSPACE_TURN_PHASES,
  PERSISTENT_WORKSPACE_TURN_STATUSES,
  WORKSPACE_PUBLICATION_CATEGORIES,
  type CreatePersistentWorkspaceInputV1,
  type CreatePersistentWorkspaceTaskInputV1,
  type CreatePersistentWorkspaceTurnSessionInputV1,
  type DeletePersistentWorkspaceInputV1,
  type DeletePersistentWorkspacePublicationInputV1,
  type EditPersistentWorkspaceInputV1,
  type PersistentWorkspaceHostAuthorityV1,
  type PersistentWorkspaceOwnerScopeV1,
  type PersistentWorkspacePublicationActorV1,
  type PersistentWorkspace,
  type PersistentWorkspaceArtifactV1,
  type PersistentWorkspaceContextV1,
  type PersistentWorkspaceDeletionResultV1,
  type PersistentWorkspaceFindingPublicationCopyV1,
  type PersistentWorkspaceMetadataV1,
  type PersistentWorkspaceObjectivePublicationCopyV1,
  type PersistentWorkspaceProgressV1,
  type PersistentWorkspacePublication,
  type PersistentWorkspacePublicationCopyV1,
  type PersistentWorkspacePublicationProvenanceV1,
  type PersistentWorkspaceQuotaV1,
  type PersistentWorkspaceRecord,
  type PersistentWorkspaceSubmission,
  type WorkspaceRecordV1,
  type PersistentWorkspaceRecordContentV1,
  type PersistentWorkspaceRecordEditV1,
  type PersistentWorkspaceStateV1,
  type PersistentWorkspaceTask,
  type PersistentWorkspaceTaskPublicationCopyV1,
  type PersistentWorkspaceTurnSession,
  type PersistentWorkspaceTurnSessionPageV1,
  type PersistentWorkspaceUsageV1,
  type PublishPersistentWorkspaceSelectionInputV1,
  type UpdatePersistentWorkspaceTurnSessionInputV1,
} from "../types/turn-workspace";
import type { PaginationParams } from "../types/pagination";
import { MAX_LIMIT } from "../types/pagination";
import {
  WORKSPACE_OPERATIONS,
  WORKSPACE_RECORD_KINDS,
  WORKSPACE_SUBMISSION_STATES,
  WORKSPACE_TASK_STATES,
  type TurnWorkspaceV1,
  type WorkspaceArtifactProvenanceV1,
  type WorkspaceArtifactReferenceV1,
  type WorkspaceOperationCapabilitiesV1,
  type WorkspaceOperationKindV1,
  type WorkspaceRecordKindV1,
  type WorkspaceRetentionV1,
  type WorkspaceStateV1,
  type WorkspaceSubmissionV1,
  type WorkspaceTaskStateV1,
  type WorkspaceTaskV1,
  type WorkspaceTaskAcceptanceV1,
  type WorkspaceUsageV1,
} from "../types/turn-workspace";
import { utf8ByteLength } from "./agent-runtime-accounting";
import { ArtifactBlobError, assertArtifactAttachable, assertArtifactBlobAvailable, publishArtifactCommit, releaseArtifactBlobReference, retainArtifactBlobReference, withArtifactDeletionFence } from "./agent-artifact-blobs.service";
import {
  COGNITION_MAX_TASK_TRANSITIONS,
  deriveCognitionOperationalTaskId,
  type CognitionActivationStateV1,
  type CognitionTaskTransition,
  type TaskTemplateV1,
} from "../types/agent-cognition";
import type { AgenticWorkWorkspaceMutationReservationV1 } from "../types/agent-work-segment";
import type {
  CognitionWorkspaceActivationFactoryV1,
  CognitionWorkspaceActivationUpdateV1,
  CognitionWorkspaceCommitResultV1,
  CognitionWorkspaceCompletionFactoryV1,
  CognitionWorkspaceCompletionResultV1,
  CognitionWorkspaceCompletionUpdateV1,
  CognitionWorkspacePhaseFactoryV1,
  CognitionWorkspacePhaseResultV1,
} from "../types/agent-cognition-runtime";
export const PERSISTENT_WORKSPACE_ID_MAX_BYTES = 128;
export const PERSISTENT_WORKSPACE_OBJECTIVE_MAX_BYTES = 65_536;
export const PERSISTENT_WORKSPACE_METADATA_MAX_BYTES = 32_768;
export const PERSISTENT_WORKSPACE_PROGRESS_MAX_BYTES = 16_384;
export const PERSISTENT_WORKSPACE_RECORD_MAX_BYTES = 65_536;
export const PERSISTENT_WORKSPACE_PROVENANCE_MAX_BYTES = 16_384;
export const PERSISTENT_WORKSPACE_COPY_MAX_BYTES = 131_072;
export const PERSISTENT_WORKSPACE_MAX_LABELS = 32;
export const PERSISTENT_WORKSPACE_MAX_TOOL_ACTIVITY = 64;
export const PERSISTENT_WORKSPACE_MAX_DEPENDENCIES = 64;
export const PERSISTENT_WORKSPACE_MAX_TASKS = 256;
export const PERSISTENT_WORKSPACE_MAX_RECORDS = 1_024;
export const PERSISTENT_WORKSPACE_MAX_SUBMISSIONS = 1_024;
export const PERSISTENT_WORKSPACE_MAX_ARTIFACTS = 256;
export const PERSISTENT_WORKSPACE_MAX_PUBLICATIONS = 512;
export const PERSISTENT_WORKSPACE_MAX_SESSION_OFFSET = 100_000;
export const PERSISTENT_WORKSPACE_MAX_BYTES = 4 * 1024 * 1024;

export const WORKSPACE_ID_MAX_BYTES = 128;
export const WORKSPACE_OBJECTIVE_MAX_BYTES = 65_536;
export const WORKSPACE_CONSTRAINT_MAX_BYTES = 8_192;
export const WORKSPACE_CONSTRAINTS_MAX_BYTES = 131_072;
export const WORKSPACE_TASK_TITLE_MAX_BYTES = 4_096;
export const WORKSPACE_TASK_SUMMARY_MAX_BYTES = 65_536;
export const WORKSPACE_RECORD_SUMMARY_MAX_BYTES = 65_536;
export const WORKSPACE_CHILD_SUBMISSION_SUMMARY_MAX_BYTES = 32_768;
export const WORKSPACE_ROOT_SUBMISSION_SUMMARY_MAX_BYTES = 65_536;
export const WORKSPACE_MAX_TASKS = 256;
export const WORKSPACE_MAX_TASK_ASSIGNMENTS = WORKSPACE_MAX_TASKS;
export const WORKSPACE_MAX_RECORDS = 1_024;
export const WORKSPACE_MAX_SUBMISSIONS = 1_024;
export const WORKSPACE_MAX_ARTIFACTS = 256;
export const WORKSPACE_MAX_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_MAX_PAGE_SIZE = 100;
export const WORKSPACE_MAX_DEPENDENCIES = 64;
export const WORKSPACE_MAX_REFERENCE_IDS = 128;
export const WORKSPACE_MAX_OPERATION_BYTES = 131_072;
export const WORKSPACE_MAX_OPERATIONS = 128;
export const WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS = 24 * 60 * 60;
export const WORKSPACE_MAX_TERMINAL_TTL_SECONDS = 30 * 24 * 60 * 60;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[0-9a-fA-F]{64}$/;
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const PRIVATE_KEY = /(?:transcript|carrier|reasoning|credential|secret|raw[_-]?(?:tool|peer)|tool[_-]?(?:argument|args|result)|work[_-]?prose)/i;
const RETENTION = new Set<WorkspaceRetentionV1>(["operational", "turn_terminal", "chat_lifetime"]);
const STATES = new Set<WorkspaceTaskStateV1>(WORKSPACE_TASK_STATES);
const KINDS = new Set<WorkspaceRecordKindV1>(WORKSPACE_RECORD_KINDS);
const OPERATIONS = new Set<WorkspaceOperationKindV1>(WORKSPACE_OPERATIONS);
const PROVENANCE = new Set<WorkspaceArtifactProvenanceV1>(["host", "root", "child"]);
/**
 * Closed public section vocabulary for owner-bound workspace reads.
 * The service remains the authority for authorization and redaction.
 */
export const WORKSPACE_READ_SECTIONS = Object.freeze([
  "objective",
  "constraints",
  "tasks",
  "records",
  "submissions",
  "artifacts",
  "summary",
] as const);
export type WorkspaceReadSection = (typeof WORKSPACE_READ_SECTIONS)[number];
const WORKSPACE_READ_SECTION_SET: ReadonlySet<string> = new Set(WORKSPACE_READ_SECTIONS);

/** Public workspace snapshot returned by every workspace read/mutation. */
export type WorkspaceSnapshotV1 = TurnWorkspaceV1;

interface ActiveFrameCapabilityGrant {
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly frameId: string;
  readonly workspaceExpiresAt: number;
  readonly capabilities: WorkspaceOperationCapabilitiesV1;
  operationsUsed: number;
}

/**
 * Child grants are intentionally process-local, but their lifetime is bounded
 * by the authoritative workspace/turn lifecycle. A grant is never admitted
 * for a terminal or expired workspace and is explicitly removed by the turn
 * terminal transition/recovery hooks below.
 */
const frameCapabilities = new Map<string, ActiveFrameCapabilityGrant>();
let frameCapabilitiesDatabase: Database | null = null;

const TERMINAL_TURN_STATES = new Set([
  "COMMITTED",
  "COMMIT_FAILED",
  "EXHAUSTED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

type WorkspaceActor = "host" | "root" | "child";
export interface WorkspaceFrameContextV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly actor: WorkspaceActor;
  readonly frameId?: string;
  readonly expectedRevision: number;
  readonly capabilities?: WorkspaceOperationCapabilitiesV1;
  readonly fieldCapabilities?: WorkspaceOperationCapabilitiesV1;
}
export interface WorkspaceFrameCapabilityGrantV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly frameId: string;
  readonly capabilities: WorkspaceOperationCapabilitiesV1;
}

export interface CreateWorkspaceInputV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly workspaceId?: string;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly retention: WorkspaceRetentionV1;
  readonly ttlSeconds?: number;
  readonly quota: WorkspaceQuotaInputV1;
  readonly capabilities: WorkspaceOperationCapabilitiesV1;
}

export interface WorkspaceQuotaInputV1 {
  readonly maxTasks: number;
  readonly maxRecords: number;
  readonly maxSubmissions: number;
  readonly maxArtifacts: number;
  readonly maxBytes: number;
}

export interface ReadWorkspaceSectionInputV1 extends WorkspaceFrameContextV1 {
  readonly section: WorkspaceReadSection;
  readonly page: number;
  readonly pageSize: number;
}

export interface CreateWorkspaceTaskInputV1 extends WorkspaceFrameContextV1 {
  readonly taskId?: string;
  readonly title: string;
  readonly objective?: string;
  readonly dependencyIds: readonly string[];
  readonly assignedFrameId: string | null;
  readonly retention?: WorkspaceRetentionV1;
  readonly ttlSeconds?: number;
}

interface CreateWorkspaceTaskRuntimeInputV1 extends CreateWorkspaceTaskInputV1 {
  readonly hostRequired: boolean;
}

export interface UpdateWorkspaceTaskPolicyInputV1 extends WorkspaceFrameContextV1 {
  readonly taskId: string;
  readonly required?: boolean;
  readonly dependencyIds?: readonly string[];
  readonly assignedFrameId?: string | null;
  readonly retention?: WorkspaceRetentionV1;
  readonly ttlSeconds?: number;
}
export interface WorkspaceTaskAssignmentV1 {
  readonly taskId: string;
  readonly frameId: string;
}

/**
 * Host/root-only assignment of already materialized tasks to exact child
 * frames. This is a control-plane operation and is intentionally absent from
 * the model-visible workspace operation vocabulary.
 */
export interface AssignWorkspaceTasksInputV1 extends WorkspaceFrameContextV1 {
  readonly assignments: readonly WorkspaceTaskAssignmentV1[];
}

export interface AssignWorkspaceTasksResultV1 {
  readonly accepted: boolean;
  readonly workspaceRevision: number;
  readonly assignments: readonly WorkspaceTaskAssignmentV1[];
  readonly tasks: readonly WorkspaceTaskV1[];
}


export interface UpdateWorkspaceTaskProgressInputV1 extends WorkspaceFrameContextV1 {
  readonly taskId: string;
  readonly state: WorkspaceTaskStateV1;
  readonly progress?: number;
}

export interface SubmitWorkspaceChildResultInputV1 extends WorkspaceFrameContextV1 {
  readonly taskId: string;
  readonly summary: string;
  readonly resultDigest: string;
  readonly byteCount: number;
  readonly retention?: WorkspaceRetentionV1;
  readonly ttlSeconds?: number;
}
interface SubmitWorkspaceRootResultInputV1 extends WorkspaceFrameContextV1 {
  readonly taskId: string;
  readonly summary: string;
  readonly state: "completed" | "failed";
  readonly retention?: WorkspaceRetentionV1;
  readonly ttlSeconds?: number;
}

interface SettleWorkspaceChildTaskInputV1 extends WorkspaceFrameContextV1 {
  readonly taskId: string;
  readonly assignedFrameId: string;
  readonly state: "cancelled" | "failed";
}


export interface AcceptWorkspaceSubmissionInputV1 extends WorkspaceFrameContextV1 {
  readonly submissionId: string;
  readonly taskId: string;
}

export interface RecordWorkspaceRecordInputV1 extends WorkspaceFrameContextV1 {
  readonly kind: WorkspaceRecordKindV1;
  readonly summary: string;
  readonly digest: string;
  readonly taskId: string | null;
  readonly retention?: WorkspaceRetentionV1;
  readonly ttlSeconds?: number;
}

export interface AttachWorkspaceArtifactInputV1 extends WorkspaceFrameContextV1 {
  readonly artifactId?: string;
  readonly blobDigest: string;
  readonly byteCount: number;
  readonly mimeType: string;
  readonly provenance: WorkspaceArtifactProvenanceV1;
  readonly creatorToken: string;
  readonly taskId: string | null;
  readonly retention?: WorkspaceRetentionV1;
  readonly ttlSeconds?: number;
}

export interface ProposeWorkspacePublicationInputV1 extends WorkspaceFrameContextV1 { readonly artifactId: string; }
export interface PublishWorkspaceArtifactInputV1 extends WorkspaceFrameContextV1 {
  readonly artifactId: string;
  readonly receiptId?: string;
  readonly messageId?: string | null;
  readonly swipeId?: number | null;
}
export interface WorkspaceCompletionMetadataInputV1 extends WorkspaceFrameContextV1 {
  readonly completionCode: string;
  readonly requiredTaskCount?: number;
  readonly acceptedSubmissionCount?: number;
}

export interface WorkspaceSectionPageV1 {
  readonly workspace: WorkspaceSnapshotV1;
  readonly section: WorkspaceReadSection;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly items: readonly unknown[];
}

export interface WorkspaceCompletionGatesV1 {
  readonly workspaceRevision: number;
  readonly accepted: boolean;
  readonly requiredTaskCount: number;
  readonly openRequiredTaskIds: readonly string[];
  readonly pendingSubmissionCount: number;
}

export interface WorkspaceCompletionPreviewV1 {
  readonly accepted: boolean;
  readonly workspaceRevision: number;
}

export interface WorkspaceCompletionPreparedAcceptanceV1 {
  /**
   * Synchronous host-owned acknowledgement. It runs inside the SQLite
   * transaction after the completion gates are re-read and before updateRow.
   */
  readonly prepare: (candidate: WorkspaceCompletionPreviewV1) => boolean;
}

export type WorkspaceErrorCode =
  | "invalid_input" | "not_found" | "forbidden" | "capability_denied" | "stale_revision"
  | "workspace_frozen" | "quota_exceeded" | "dependency_cycle" | "invalid_retention"
  | "invalid_state" | "invalid_id" | "child_confinement" | "duplicate_id"
  | "task_assignment_conflict"
  | "schema_unavailable" | "submission_rejected" | "completion_preparation_failed";

export class TurnWorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly details?: Readonly<Record<string, string | number>>;
  constructor(code: WorkspaceErrorCode, message: string, details?: Record<string, string | number>) {
    super(message);
    this.name = "TurnWorkspaceError";
    this.code = code;
    this.details = details ? Object.freeze({ ...details }) : undefined;
  }
}

function fail(code: WorkspaceErrorCode, message: string, details?: Record<string, string | number>): never {
  throw new TurnWorkspaceError(code, message, details);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function assertKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) if (!keys.has(key)) fail("invalid_input", `${path}.${key} is not permitted`);
}
function assertNoPrivateFields(value: unknown, path = "value", depth = 0): void {
  if (depth > 12) fail("invalid_input", `${path} is too deeply nested`);
  if (Array.isArray(value)) {
    if (value.length > WORKSPACE_MAX_REFERENCE_IDS) fail("quota_exceeded", `${path} contains too many entries`);
    value.forEach((item, index) => assertNoPrivateFields(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) fail("invalid_input", `${path}.${key} is private runtime material`);
    assertNoPrivateFields(child, `${path}.${key}`, depth + 1);
  }
}
function stringValue(value: unknown, path: string, maxBytes: number, nonEmpty = true): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0)) fail("invalid_input", `${path} must be a string`);
  const bytes = utf8ByteLength(value);
  if (bytes > maxBytes) fail("quota_exceeded", `${path} exceeds its UTF-8 byte limit`, { limit: maxBytes, observed: bytes });
  return value;
}
function idValue(value: unknown, path: string): string {
  const id = stringValue(value, path, WORKSPACE_ID_MAX_BYTES);
  if (!SAFE_ID.test(id)) fail("invalid_id", `${path} is not a stable identifier`);
  return id;
}
function cognitionTemplateTaskId(row: WorkspaceRow, templateId: string): string {
  return idValue(deriveCognitionOperationalTaskId(row.turnId, templateId), "cognition.taskId");
}
function cognitionTemplateTransitionId(row: WorkspaceRow, candidate: Record<string, unknown>): string {
  const taskId = rowString(candidate, ["task_id"]);
  if (!taskId) fail("invalid_state", "workspace task transition identifiers are invalid");
  const rawTemplateId = candidate.cognition_template_id;
  if (rawTemplateId === undefined || rawTemplateId === null) return taskId;
  if (typeof rawTemplateId !== "string" || rawTemplateId.length === 0) {
    fail("invalid_state", "cognition task provenance is invalid");
  }
  const templateId = idValue(rawTemplateId, "workspace.cognitionTemplateId");
  if (cognitionTemplateTaskId(row, templateId) !== taskId) {
    fail("invalid_state", "cognition task provenance does not match its operational task ID");
  }
  return templateId;
}
function taskIdentifierTaken(database: Database, taskId: string): boolean {
  return database.query("SELECT 1 AS present FROM agent_workspace_tasks WHERE task_id = ? LIMIT 1").get(taskId) != null;
}
function workspaceHoldsTaskId(row: WorkspaceRow, taskId: string): boolean {
  return listWorkspaceRows("agent_workspace_tasks", row).some((candidate) => rowString(candidate, ["task_id"]) === taskId);
}
function turnScopedTaskId(row: WorkspaceRow, authored: string): string {
  const scoped = `${row.turnId}:${authored}`;
  if (SAFE_ID.test(scoped) && utf8ByteLength(scoped) <= WORKSPACE_ID_MAX_BYTES) return scoped;
  const digest = createHash("sha256").update(scoped, "utf8").digest("hex").slice(0, 24);
  return idValue(`${row.turnId}:${digest}`, "taskId");
}
/**
 * Model-authored task IDs are unique per user globally (`task_id` PK).
 * Reuse across turns is valid; scope the colliding ID to this turn.
 */
function allocateWritableTaskId(row: WorkspaceRow, requested: string | undefined): string {
  const authored = requested === undefined ? crypto.randomUUID() : idValue(requested, "taskId");
  if (workspaceHoldsTaskId(row, authored)) fail("duplicate_id", "task identifier is already in use");
  if (!taskIdentifierTaken(getDb(), authored)) return authored;
  const scoped = turnScopedTaskId(row, authored);
  if (workspaceHoldsTaskId(row, scoped) || taskIdentifierTaken(getDb(), scoped)) {
    fail("duplicate_id", "task identifier is already in use");
  }
  return scoped;
}
function insertWorkspaceTaskRow(database: Database, values: Record<string, unknown>): void {
  try {
    insertRow(database, "agent_workspace_tasks", values, ["task_id", "workspace_id", "turn_id", "user_id", "chat_id", "title", "description", "retention", "expires_at"]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed: agent_workspace_tasks(?:\.task_id)?/i.test(detail)) {
      fail("duplicate_id", "task identifier is already in use");
    }
    throw error;
  }
}
function nullableId(value: unknown, path: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return idValue(value, path);
}
function integer(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail("invalid_input", `${path} must be an integer in [${min}, ${max}]`);
  return value as number;
}
function finiteNumber(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail("invalid_input", `${path} must be a number in [${min}, ${max}]`);
  return value;
}
function identifierList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length > WORKSPACE_MAX_DEPENDENCIES) fail("invalid_input", `${path} must be a bounded identifier array`);
  const seen = new Set<string>();
  const result: string[] = [];
  value.forEach((item, index) => {
    const id = idValue(item, `${path}[${index}]`);
    if (seen.has(id)) fail("invalid_input", `${path} contains duplicate identifiers`);
    seen.add(id);
    result.push(id);
  });
  return Object.freeze(result);
}
function retentionValue(value: unknown, ttlValue: unknown, now = Math.floor(Date.now() / 1000)): { retention: WorkspaceRetentionV1; expiresAt: number } {
  if (typeof value !== "string" || !RETENTION.has(value as WorkspaceRetentionV1)) fail("invalid_retention", "unknown retention policy");
  const retention = value as WorkspaceRetentionV1;
  if (retention === "chat_lifetime") {
    if (ttlValue !== undefined && ttlValue !== null) fail("invalid_retention", "chat-lifetime retention cannot have a TTL");
    return { retention, expiresAt: 0 };
  }
  const maximum = retention === "operational" ? WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS : WORKSPACE_MAX_TERMINAL_TTL_SECONDS;
  return { retention, expiresAt: now + integer(ttlValue, "ttlSeconds", 1, maximum) };
}
function quotaValue(value: unknown): WorkspaceQuotaInputV1 {
  if (value !== undefined && !isRecord(value)) fail("invalid_input", "quota must be an object");
  const source = (value ?? {}) as Record<string, unknown>;
  assertKeys(source, ["maxTasks", "maxRecords", "maxSubmissions", "maxArtifacts", "maxBytes"], "quota");
  return Object.freeze({
    maxTasks: integer(source.maxTasks ?? WORKSPACE_MAX_TASKS, "quota.maxTasks", 0, WORKSPACE_MAX_TASKS),
    maxRecords: integer(source.maxRecords ?? WORKSPACE_MAX_RECORDS, "quota.maxRecords", 0, WORKSPACE_MAX_RECORDS),
    maxSubmissions: integer(source.maxSubmissions ?? WORKSPACE_MAX_SUBMISSIONS, "quota.maxSubmissions", 0, WORKSPACE_MAX_SUBMISSIONS),
    maxArtifacts: integer(source.maxArtifacts ?? WORKSPACE_MAX_ARTIFACTS, "quota.maxArtifacts", 0, WORKSPACE_MAX_ARTIFACTS),
    maxBytes: integer(source.maxBytes ?? WORKSPACE_MAX_BYTES, "quota.maxBytes", 0, WORKSPACE_MAX_BYTES),
  });
}
function capabilityValue(value: unknown, actor: WorkspaceActor): WorkspaceOperationCapabilitiesV1 {
  if (value !== undefined && !isRecord(value)) fail("invalid_input", "capabilities must be an object");
  const source = (value ?? {}) as Record<string, unknown>;
  assertKeys(source, ["revision", "allowed", "maxOperationBytes", "maxOperations"], "capabilities");
  const rawAllowed = source.allowed ?? (actor === "host" || actor === "root" ? [...WORKSPACE_OPERATIONS] : []);
  if (!Array.isArray(rawAllowed)) fail("invalid_input", "capabilities.allowed must be an array");
  const seen = new Set<WorkspaceOperationKindV1>();
  const allowed: WorkspaceOperationKindV1[] = [];
  for (const item of rawAllowed) {
    if (typeof item !== "string" || !OPERATIONS.has(item as WorkspaceOperationKindV1) || seen.has(item as WorkspaceOperationKindV1)) fail("invalid_input", "capabilities.allowed contains an unknown or duplicate operation");
    seen.add(item as WorkspaceOperationKindV1);
    allowed.push(item as WorkspaceOperationKindV1);
  }
  return Object.freeze({
    revision: integer(source.revision ?? 1, "capabilities.revision", 0, Number.MAX_SAFE_INTEGER),
    allowed: Object.freeze(allowed),
    maxOperationBytes: integer(source.maxOperationBytes ?? WORKSPACE_MAX_OPERATION_BYTES, "capabilities.maxOperationBytes", 0, WORKSPACE_MAX_OPERATION_BYTES),
    maxOperations: integer(source.maxOperations ?? WORKSPACE_MAX_OPERATIONS, "capabilities.maxOperations", 0, WORKSPACE_MAX_OPERATIONS),
  });
}
function expectedRevision(value: Record<string, unknown>): number {
  return integer(value.expectedRevision ?? value.revision, "expectedRevision", 0, Number.MAX_SAFE_INTEGER);
}
function contextValue(value: unknown, strict = false): WorkspaceFrameContextV1 {
  if (!isRecord(value)) fail("invalid_input", "workspace context must be an object");
  if (strict) assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities"], "context");
  assertNoPrivateFields(value);
  const actor = value.actor;
  if (actor !== "host" && actor !== "root" && actor !== "child") fail("invalid_input", "context.actor is invalid");
  if (actor === "child" && (value.capabilities !== undefined || value.fieldCapabilities !== undefined)) {
    fail("capability_denied", "child capability grants are host-issued");
  }
  const result: WorkspaceFrameContextV1 = Object.freeze({
    userId: idValue(value.userId, "userId"),
    chatId: idValue(value.chatId, "chatId"),
    turnId: idValue(value.turnId, "turnId"),
    workspaceId: idValue(value.workspaceId, "workspaceId"),
    actor,
    frameId: value.frameId === undefined ? undefined : idValue(value.frameId, "frameId"),
    expectedRevision: expectedRevision(value),
  });
  if (actor === "child" && !result.frameId) fail("child_confinement", "child operations require frameId");
  return result;
}

export function validateWorkspaceCapabilities(value: unknown, actor: WorkspaceActor = "child"): WorkspaceOperationCapabilitiesV1 {
  assertNoPrivateFields(value);
  return capabilityValue(value, actor);
}
export function validateCreateWorkspaceInput(value: unknown, now = Math.floor(Date.now() / 1000)): CreateWorkspaceInputV1 {
  if (!isRecord(value)) fail("invalid_input", "workspace input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "objective", "constraints", "retention", "ttlSeconds", "quota", "capabilities"], "workspace");
  assertNoPrivateFields(value);
  if (!Array.isArray(value.constraints) || value.constraints.length > 256) fail("invalid_input", "constraints must be a bounded array");
  let bytes = 0;
  const constraints: string[] = [];
  value.constraints.forEach((item, index) => {
    const constraint = stringValue(item, `constraints[${index}]`, WORKSPACE_CONSTRAINT_MAX_BYTES);
    bytes += utf8ByteLength(constraint);
    constraints.push(constraint);
  });
  if (bytes > WORKSPACE_CONSTRAINTS_MAX_BYTES) fail("quota_exceeded", "constraints exceed aggregate UTF-8 limit");
  const policy = retentionValue(value.retention, value.ttlSeconds, now);
  return Object.freeze({
    userId: idValue(value.userId, "userId"),
    chatId: idValue(value.chatId, "chatId"),
    turnId: idValue(value.turnId, "turnId"),
    workspaceId: value.workspaceId === undefined ? undefined : idValue(value.workspaceId, "workspaceId"),
    objective: stringValue(value.objective, "objective", WORKSPACE_OBJECTIVE_MAX_BYTES),
    constraints: Object.freeze(constraints),
    retention: policy.retention,
    ttlSeconds: value.ttlSeconds === undefined ? undefined : integer(value.ttlSeconds, "ttlSeconds", 1, policy.retention === "operational" ? WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS : WORKSPACE_MAX_TERMINAL_TTL_SECONDS),
    quota: quotaValue(value.quota),
    capabilities: capabilityValue(value.capabilities, "root"),
  });
}
export function validateReadWorkspaceSectionInput(value: unknown): ReadWorkspaceSectionInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "read input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "section", "page", "pageSize"], "read");
  const section = value.section;
  if (typeof section !== "string" || !WORKSPACE_READ_SECTION_SET.has(section)) fail("invalid_input", "section is invalid");
  return Object.freeze({ ...parsed, section: section as WorkspaceReadSection, page: integer(value.page ?? 0, "page", 0, Number.MAX_SAFE_INTEGER), pageSize: integer(value.pageSize ?? WORKSPACE_MAX_PAGE_SIZE, "pageSize", 1, WORKSPACE_MAX_PAGE_SIZE) });
}
export function validateAssignWorkspaceTasksInput(value: unknown): AssignWorkspaceTasksInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "task assignment input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "assignments"], "taskAssignment");
  if (!Array.isArray(value.assignments) || value.assignments.length === 0) {
    fail("invalid_input", `assignments must contain 1-${WORKSPACE_MAX_TASK_ASSIGNMENTS} entries`);
  }
  if (value.assignments.length > WORKSPACE_MAX_TASK_ASSIGNMENTS) {
    fail("quota_exceeded", `assignments exceed the ${WORKSPACE_MAX_TASK_ASSIGNMENTS}-task assignment quota`);
  }
  const taskIds = new Set<string>();
  const frameIds = new Set<string>();
  const assignments: WorkspaceTaskAssignmentV1[] = [];
  value.assignments.forEach((entry, index) => {
    if (!isRecord(entry)) fail("invalid_input", `assignments[${index}] must be an object`);
    assertKeys(entry, ["taskId", "frameId"], `assignments[${index}]`);
    const taskId = idValue(entry.taskId, `assignments[${index}].taskId`);
    const frameId = idValue(entry.frameId, `assignments[${index}].frameId`);
    if (taskIds.has(taskId) || frameIds.has(frameId)) fail("duplicate_id", "task assignments must contain unique task and frame identifiers");
    taskIds.add(taskId);
    frameIds.add(frameId);
    assignments.push(Object.freeze({ taskId, frameId }));
  });
  return Object.freeze({ ...parsed, assignments: Object.freeze(assignments) });
}
function validateCreateWorkspaceTaskRuntimeInput(value: unknown): CreateWorkspaceTaskRuntimeInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "task input must be an object");
  const hasRequired = Object.prototype.hasOwnProperty.call(value, "required");
  if (parsed.actor !== "host" && hasRequired) {
    if (value.required === true) fail("forbidden", "only the host may create required tasks");
    fail("invalid_input", "required is a host-only task creation field");
  }
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "taskId", "title", "objective", "required", "dependencyIds", "assignedFrameId", "retention", "ttlSeconds"], "task");
  if (value.required !== undefined && typeof value.required !== "boolean") fail("invalid_input", "required must be boolean");
  const policy = value.retention === undefined ? undefined : retentionValue(value.retention, value.ttlSeconds);
  return Object.freeze({
    ...parsed,
    taskId: value.taskId === undefined ? undefined : idValue(value.taskId, "taskId"),
    title: stringValue(value.title, "title", WORKSPACE_TASK_TITLE_MAX_BYTES),
    objective: value.objective === undefined ? undefined : stringValue(value.objective, "objective", WORKSPACE_TASK_SUMMARY_MAX_BYTES),
    hostRequired: parsed.actor === "host" && value.required === true,
    dependencyIds: identifierList(value.dependencyIds ?? [], "dependencyIds"),
    assignedFrameId: nullableId(value.assignedFrameId, "assignedFrameId") ?? null,
    retention: policy?.retention,
    ttlSeconds: value.ttlSeconds === undefined ? undefined : integer(value.ttlSeconds, "ttlSeconds", 1, policy?.retention === "operational" ? WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS : WORKSPACE_MAX_TERMINAL_TTL_SECONDS),
  });
}
export function validateCreateWorkspaceTaskInput(value: unknown): CreateWorkspaceTaskInputV1 {
  const { hostRequired: _hostRequired, ...input } = validateCreateWorkspaceTaskRuntimeInput(value);
  return Object.freeze(input);
}
export function validateUpdateWorkspaceTaskPolicyInput(value: unknown): UpdateWorkspaceTaskPolicyInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "task policy input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "taskId", "required", "dependencyIds", "assignedFrameId", "retention", "ttlSeconds"], "taskPolicy");
  if (value.required !== undefined && typeof value.required !== "boolean") fail("invalid_input", "required must be boolean");
  const policy = value.retention === undefined ? undefined : retentionValue(value.retention, value.ttlSeconds);
  return Object.freeze({ ...parsed, taskId: idValue(value.taskId, "taskId"), required: value.required as boolean | undefined, dependencyIds: value.dependencyIds === undefined ? undefined : identifierList(value.dependencyIds, "dependencyIds"), assignedFrameId: value.assignedFrameId === undefined ? undefined : nullableId(value.assignedFrameId, "assignedFrameId") ?? null, retention: policy?.retention, ttlSeconds: value.ttlSeconds === undefined ? undefined : integer(value.ttlSeconds, "ttlSeconds", 1, policy?.retention === "operational" ? WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS : WORKSPACE_MAX_TERMINAL_TTL_SECONDS) });
}
export function validateUpdateWorkspaceTaskProgressInput(value: unknown): UpdateWorkspaceTaskProgressInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "progress input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "taskId", "state", "progress", "progressPercent", "summary"], "progress");
  if (parsed.actor !== "child") fail("forbidden", "only assigned children update progress");
  if (typeof value.state !== "string" || !STATES.has(value.state as WorkspaceTaskStateV1)) fail("invalid_state", "task state is invalid");
  if (value.state === "completed") fail("invalid_state", "child progress cannot complete a task; submit a child result instead");
  if (value.summary !== undefined) fail("invalid_input", "child progress cannot persist work prose");
  const progress = value.progress !== undefined ? finiteNumber(value.progress, "progress", 0, 1) : value.progressPercent !== undefined ? finiteNumber(value.progressPercent, "progressPercent", 0, 100) / 100 : undefined;
  return Object.freeze({ ...parsed, taskId: idValue(value.taskId, "taskId"), state: value.state as WorkspaceTaskStateV1, progress });
}
export function validateSubmitWorkspaceChildResultInput(value: unknown): SubmitWorkspaceChildResultInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "submission input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "taskId", "summary", "resultDigest", "byteCount", "retention", "ttlSeconds"], "submission");
  if (parsed.actor !== "child") fail("forbidden", "only children submit child results");
  const policy = value.retention === undefined ? undefined : retentionValue(value.retention, value.ttlSeconds);
  const resultDigest = stringValue(value.resultDigest, "resultDigest", 64);
  if (!DIGEST.test(resultDigest)) fail("invalid_input", "resultDigest must be SHA-256");
  return Object.freeze({ ...parsed, taskId: idValue(value.taskId, "taskId"), summary: stringValue(value.summary, "summary", WORKSPACE_CHILD_SUBMISSION_SUMMARY_MAX_BYTES), resultDigest, byteCount: integer(value.byteCount ?? 0, "byteCount", 0, WORKSPACE_MAX_BYTES), retention: policy?.retention, ttlSeconds: value.ttlSeconds === undefined ? undefined : integer(value.ttlSeconds, "ttlSeconds", 1, policy?.retention === "operational" ? WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS : WORKSPACE_MAX_TERMINAL_TTL_SECONDS) });
}
/**
 * Root-owned completion is a separate operation from child submission. It
 * creates an already-accepted submission so required-task completion gates
 * retain one canonical submission invariant.
 */
export function validateSubmitWorkspaceRootResultInput(value: unknown): SubmitWorkspaceRootResultInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "root result input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "taskId", "summary", "state", "retention", "ttlSeconds"], "rootResult");
  if (parsed.actor !== "root" && parsed.actor !== "host") fail("forbidden", "only root/host may submit root results");
  if (value.state !== "completed" && value.state !== "failed") fail("invalid_state", "root result state must be completed or failed");
  const policy = value.retention === undefined ? undefined : retentionValue(value.retention, value.ttlSeconds);
  return Object.freeze({
    ...parsed,
    taskId: idValue(value.taskId, "taskId"),
    summary: stringValue(value.summary, "summary", WORKSPACE_ROOT_SUBMISSION_SUMMARY_MAX_BYTES),
    state: value.state,
    retention: policy?.retention,
    ttlSeconds: value.ttlSeconds === undefined ? undefined : integer(value.ttlSeconds, "ttlSeconds", 1, policy?.retention === "operational" ? WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS : WORKSPACE_MAX_TERMINAL_TTL_SECONDS),
  });
}

function validateSettleWorkspaceChildTaskInput(value: unknown): SettleWorkspaceChildTaskInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "child settlement input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "taskId", "assignedFrameId", "state"], "childSettlement");
  if (parsed.actor !== "host") fail("forbidden", "only the host may settle child failures");
  if (typeof value.state !== "string" || (value.state !== "failed" && value.state !== "cancelled")) {
    fail("invalid_state", "child settlement state must be failed or cancelled");
  }
  return Object.freeze({
    ...parsed,
    taskId: idValue(value.taskId, "taskId"),
    assignedFrameId: idValue(value.assignedFrameId, "assignedFrameId"),
    state: value.state,
  });
}

export function validateAcceptWorkspaceSubmissionInput(value: unknown): AcceptWorkspaceSubmissionInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "submission acceptance input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "submissionId", "taskId"], "acceptSubmission");
  return Object.freeze({
    ...parsed,
    submissionId: idValue(value.submissionId, "submissionId"),
    taskId: idValue(value.taskId, "taskId"),
  });
}
function summaryDigest(summary: string): string { return createHash("sha256").update(summary, "utf8").digest("hex"); }
function rootResultMatches(
  task: WorkspaceTaskV1,
  submission: WorkspaceSubmissionV1 | undefined,
  input: SubmitWorkspaceRootResultInputV1,
): boolean {
  if (input.state === "failed") {
    return task.state === "failed" && submission === undefined && task.summary === input.summary;
  }
  if (!submission || submission.state !== "accepted") return false;
  return task.state === "completed"
    && task.summary === input.summary
    && submission.summary === input.summary
    && submission.resultDigest === summaryDigest(input.summary)
    && submission.byteCount === utf8ByteLength(input.summary);
}

export function validateRecordWorkspaceRecordInput(value: unknown): RecordWorkspaceRecordInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "record input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "kind", "summary", "digest", "taskId", "retention", "ttlSeconds"], "record");
  if (typeof value.kind !== "string" || !KINDS.has(value.kind as WorkspaceRecordKindV1)) fail("invalid_input", "record kind is invalid");
  const summary = stringValue(value.summary, "summary", WORKSPACE_RECORD_SUMMARY_MAX_BYTES);
  const digest = value.digest === undefined ? summaryDigest(summary) : stringValue(value.digest, "digest", 64);
  if (!DIGEST.test(digest)) fail("invalid_input", "record digest must be SHA-256");
  const policy = value.retention === undefined ? undefined : retentionValue(value.retention, value.ttlSeconds);
  return Object.freeze({ ...parsed, kind: value.kind as WorkspaceRecordKindV1, summary, digest, taskId: nullableId(value.taskId, "taskId") ?? null, retention: policy?.retention, ttlSeconds: value.ttlSeconds === undefined ? undefined : integer(value.ttlSeconds, "ttlSeconds", 1, policy?.retention === "operational" ? WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS : WORKSPACE_MAX_TERMINAL_TTL_SECONDS) });
}
export function validateAttachWorkspaceArtifactInput(value: unknown): AttachWorkspaceArtifactInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "artifact input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "artifactId", "blobDigest", "byteCount", "mimeType", "provenance", "creatorToken", "taskId", "retention", "ttlSeconds"], "artifact");
  const blobDigest = stringValue(value.blobDigest, "blobDigest", 64);
  if (!DIGEST.test(blobDigest)) fail("invalid_input", "blobDigest must be SHA-256");
  const mimeType = stringValue(value.mimeType, "mimeType", 255);
  if (!MIME.test(mimeType)) fail("invalid_input", "artifact MIME type is invalid");
  if (typeof value.provenance !== "string" || !PROVENANCE.has(value.provenance as WorkspaceArtifactProvenanceV1)) fail("invalid_input", "artifact provenance is invalid");
  const creatorToken = stringValue(value.creatorToken, "creatorToken", 256);
  const policy = value.retention === undefined ? undefined : retentionValue(value.retention, value.ttlSeconds);
  return Object.freeze({ ...parsed, artifactId: value.artifactId === undefined ? undefined : idValue(value.artifactId, "artifactId"), blobDigest, byteCount: integer(value.byteCount, "byteCount", 0, WORKSPACE_MAX_BYTES), mimeType, provenance: value.provenance as WorkspaceArtifactProvenanceV1, creatorToken, taskId: nullableId(value.taskId, "taskId") ?? null, retention: policy?.retention, ttlSeconds: value.ttlSeconds === undefined ? undefined : integer(value.ttlSeconds, "ttlSeconds", 1, policy?.retention === "operational" ? WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS : WORKSPACE_MAX_TERMINAL_TTL_SECONDS) });
}
export function validateProposeWorkspacePublicationInput(value: unknown): ProposeWorkspacePublicationInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "publication input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "artifactId"], "publication");
  return Object.freeze({ ...parsed, artifactId: idValue(value.artifactId, "artifactId") });
}
export function validatePublishWorkspaceArtifactInput(value: unknown): PublishWorkspaceArtifactInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "publish input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "artifactId", "receiptId", "messageId", "swipeId"], "publish");
  return Object.freeze({ ...parsed, artifactId: idValue(value.artifactId, "artifactId"), receiptId: value.receiptId === undefined ? undefined : idValue(value.receiptId, "receiptId"), messageId: value.messageId === undefined ? undefined : nullableId(value.messageId, "messageId") ?? null, swipeId: value.swipeId === undefined ? undefined : integer(value.swipeId, "swipeId", 0, Number.MAX_SAFE_INTEGER) });
}
export function validateWorkspaceCompletionMetadataInput(value: unknown): WorkspaceCompletionMetadataInputV1 {
  const parsed = contextValue(value);
  if (!isRecord(value)) fail("invalid_input", "completion metadata input must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "actor", "frameId", "expectedRevision", "revision", "capabilities", "fieldCapabilities", "completionCode", "requiredTaskCount", "acceptedSubmissionCount"], "completion");
  return Object.freeze({ ...parsed, completionCode: stringValue(value.completionCode, "completionCode", 128), requiredTaskCount: value.requiredTaskCount === undefined ? undefined : integer(value.requiredTaskCount, "requiredTaskCount", 0, WORKSPACE_MAX_TASKS), acceptedSubmissionCount: value.acceptedSubmissionCount === undefined ? undefined : integer(value.acceptedSubmissionCount, "acceptedSubmissionCount", 0, WORKSPACE_MAX_SUBMISSIONS) });
}

function tableExists(database: Database, table: string): boolean { return !!database.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table); }
function quoteIdentifier(identifier: string): string { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error("unsafe SQL identifier"); return `"${identifier}"`; }
function tableColumns(database: Database, table: string): Set<string> {
  if (!tableExists(database, table)) fail("schema_unavailable", `${table} is unavailable`);
  return new Set((database.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>).map((row) => row.name));
}
type SqlValue = string | number | bigint | boolean | null | Uint8Array;
function sqlValue(value: unknown): SqlValue { if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" || value instanceof Uint8Array) return value; fail("invalid_input", "workspace SQL value is not scalar"); }
function insertRow(database: Database, table: string, values: Record<string, unknown>, required: readonly string[]): void {
  const available = tableColumns(database, table);
  const selected = Object.entries(values).filter(([key, value]) => value !== undefined && available.has(key));
  for (const key of required) if (available.has(key) && !selected.some(([name]) => name === key)) fail("schema_unavailable", `${table}.${key} was not supplied`);
  if (!selected.length) fail("schema_unavailable", `${table} has no writable columns`);
  database.query(`INSERT INTO ${quoteIdentifier(table)} (${selected.map(([key]) => quoteIdentifier(key)).join(", ")}) VALUES (${selected.map(() => "?").join(", ")})`).run(...selected.map(([, value]) => sqlValue(value)));
}
function isPersistentTaskIdentifierConflict(error: unknown): boolean {
  const message = String(error);
  return /unique constraint failed/i.test(message)
    && /persistent_workspace_tasks\.(?:task_id|workspace_id)/i.test(message);
}
function updateRow(database: Database, table: string, values: Record<string, unknown>, where: Record<string, unknown>): number {
  const available = tableColumns(database, table);
  const set = Object.entries(values).filter(([key, value]) => value !== undefined && available.has(key));
  const predicates = Object.entries(where).filter(([key, value]) => value !== undefined && available.has(key));
  if (!set.length || !predicates.length) fail("schema_unavailable", `${table} cannot be updated safely`);
  return database.query(`UPDATE ${quoteIdentifier(table)} SET ${set.map(([key]) => `${quoteIdentifier(key)} = ?`).join(", ")} WHERE ${predicates.map(([key]) => `${quoteIdentifier(key)} = ?`).join(" AND ")}`).run(...set.map(([, value]) => sqlValue(value)), ...predicates.map(([, value]) => sqlValue(value))).changes;
}
function rowString(row: Record<string, unknown>, names: readonly string[], fallback = ""): string { for (const name of names) if (typeof row[name] === "string") return row[name] as string; return fallback; }
function rowNumber(row: Record<string, unknown>, names: readonly string[], fallback = 0): number { for (const name of names) if (typeof row[name] === "number" && Number.isFinite(row[name])) return row[name] as number; return fallback; }
function rowNullableString(row: Record<string, unknown>, names: readonly string[]): string | null { for (const name of names) if (row[name] === null) return null; for (const name of names) if (typeof row[name] === "string") return row[name] as string; return null; }
function jsonArray(value: unknown): string[] { if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string"); if (typeof value !== "string") return []; try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []; } catch { return []; } }
function deepFreeze<T>(value: T): T { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; if (Array.isArray(value)) value.forEach((child) => deepFreeze(child)); else Object.values(value as Record<string, unknown>).forEach((child) => deepFreeze(child)); return Object.freeze(value); }

/**
 * Measure the exact UTF-8 bytes charged for a workspace request. JSON
 * serialization is deliberate: JavaScript string/code-unit length is not a
 * wire-size measure for non-ASCII input.
 */
export function measureWorkspaceOperationBytesV1(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail("invalid_input", "workspace operation request is not serializable");
  }
  if (serialized === undefined) fail("invalid_input", "workspace operation request is not serializable");
  return utf8ByteLength(serialized);
}

interface WorkspaceRow {
  readonly workspaceId: string; readonly turnId: string; readonly executionId: string; readonly userId: string; readonly chatId: string;
  readonly objective: string; readonly constraints: readonly string[]; readonly state: WorkspaceStateV1; readonly revision: number;
  readonly caps: WorkspaceOperationCapabilitiesV1; readonly retention: WorkspaceRetentionV1; readonly expiresAt: number;
  readonly quota: WorkspaceQuotaInputV1; readonly usage: WorkspaceUsageV1; readonly frozenAt: number | null; readonly createdAt: number; readonly updatedAt: number;
  readonly turnActive: boolean;
}
function findWorkspace(workspaceId: string, userId: string, chatId: string, turnId: string): WorkspaceRow | null {
  const database = getDb();
  ensureFrameCapabilityDatabase(database);
  purgeExpiredFrameCapabilities();
  if (!tableExists(database, "agent_turn_workspaces")) return null;
  const raw = database.query("SELECT * FROM agent_turn_workspaces WHERE workspace_id = ? AND user_id = ? AND chat_id = ? AND turn_id = ?").get(workspaceId, userId, chatId, turnId) as Record<string, unknown> | null;
  if (!raw) {
    invalidateFrameCapabilitiesForTurn({ userId, chatId, turnId });
    return null;
  }
  const nowMilliseconds = Date.now();
  const nowSeconds = Math.floor(nowMilliseconds / 1000);
  const expiresAt = rowNumber(raw, ["expires_at"]);
  const persistedState = rowString(raw, ["state"], "active") as WorkspaceStateV1;
  const state = persistedState === "active" && expiresAt > 0 && expiresAt <= nowSeconds ? "expired" : persistedState;
  if (state !== "active" && state !== "frozen" && state !== "expired") fail("invalid_state", "workspace state is invalid");
  if (state !== "active") invalidateFrameCapabilitiesForTurn({ userId, chatId, turnId });
  const executionId = rowString(raw, ["execution_id"], turnId);
  let turnActive = true;
  if (tableExists(database, "agent_turn_executions")) {
    const executionColumns = tableColumns(database, "agent_turn_executions");
    const phaseColumn = executionColumns.has("phase") ? "phase" : "state";
    const cancelColumn = executionColumns.has("cancel_requested_at") ? "cancel_requested_at" : null;
    const deadlineColumn = executionColumns.has("deadline_at") ? "deadline_at" : null;
    const execution = database.query(
      `SELECT ${quoteIdentifier(phaseColumn)} AS phase, ${cancelColumn ? `${quoteIdentifier(cancelColumn)} AS cancel_requested_at` : "NULL AS cancel_requested_at"}, ${deadlineColumn ? `${quoteIdentifier(deadlineColumn)} AS deadline_at` : "0 AS deadline_at"} FROM agent_turn_executions WHERE id = ? AND id = ? AND user_id = ? AND chat_id = ?`,
    ).get(executionId, turnId, userId, chatId) as Record<string, unknown> | null;
    const executionState = rowString(execution ?? {}, ["phase", "state"]);
    const deadlineAt = rowNumber(execution ?? {}, ["deadline_at"]);
    turnActive = !!execution
      && !TERMINAL_TURN_STATES.has(executionState)
      && (execution.cancel_requested_at === null || execution.cancel_requested_at === undefined)
      && (deadlineAt <= 0 || deadlineAt > nowMilliseconds);
    if (!turnActive) invalidateFrameCapabilitiesForTurn({ userId, chatId, turnId });
  }
  let constraints: string[];
  try { const parsed: unknown = JSON.parse(rowString(raw, ["constraints_json"], "[]")); constraints = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []; } catch { fail("invalid_input", "workspace constraints are invalid"); }
  return {
    workspaceId, turnId, executionId, userId, chatId, objective: rowString(raw, ["objective"]), constraints,
    state, revision: rowNumber(raw, ["revision"]), caps: JSON.parse(rowString(raw, ["operation_caps_json"], "{}")) as WorkspaceOperationCapabilitiesV1,
    retention: rowString(raw, ["retention"], "operational") as WorkspaceRetentionV1, expiresAt,
    quota: { maxTasks: rowNumber(raw, ["quota_tasks"]), maxRecords: rowNumber(raw, ["quota_records"]), maxSubmissions: rowNumber(raw, ["quota_submissions"]), maxArtifacts: rowNumber(raw, ["quota_artifacts"]), maxBytes: rowNumber(raw, ["quota_bytes"]) },
    usage: { taskCount: rowNumber(raw, ["task_count"]), recordCount: rowNumber(raw, ["record_count"]), submissionCount: rowNumber(raw, ["submission_count"]), artifactCount: rowNumber(raw, ["artifact_count"]), byteCount: rowNumber(raw, ["byte_count"]) },
    frozenAt: raw.frozen_at === null || raw.frozen_at === undefined ? null : rowNumber(raw, ["frozen_at"]), createdAt: rowNumber(raw, ["created_at"]), updatedAt: rowNumber(raw, ["updated_at"]), turnActive,
  };
}
function requireWorkspace(input: WorkspaceFrameContextV1): WorkspaceRow {
  const row = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
  if (!row) fail("not_found", "workspace was not found");
  if (row.revision !== input.expectedRevision) fail("stale_revision", "workspace revision is stale", { expected: input.expectedRevision, actual: row.revision });
  return row;
}
function requireWritable(input: WorkspaceFrameContextV1): WorkspaceRow {
  const row = requireWorkspace(input);
  if (!row.turnActive || row.state === "frozen" || row.state === "expired" || (row.expiresAt > 0 && row.expiresAt <= Math.floor(Date.now() / 1000))) fail("workspace_frozen", "workspace is not writable");
  return row;
}
function frameCapabilityKey(value: Pick<WorkspaceFrameCapabilityGrantV1, "userId" | "chatId" | "turnId" | "workspaceId" | "frameId">): string {
  return JSON.stringify([value.userId, value.chatId, value.turnId, value.workspaceId, value.frameId]);
}

function ensureFrameCapabilityDatabase(database: Database): void {
  if (frameCapabilitiesDatabase === database) return;
  frameCapabilities.clear();
  frameCapabilitiesDatabase = database;
}

/** Remove all grants tied to one exact authenticated turn authority tuple. */
export function invalidateFrameCapabilitiesForTurn(
  value: Pick<WorkspaceFrameCapabilityGrantV1, "userId" | "chatId" | "turnId">,
): void {
  for (const [key, grant] of frameCapabilities) {
    if (grant.userId === value.userId && grant.chatId === value.chatId && grant.turnId === value.turnId) {
      frameCapabilities.delete(key);
    }
  }
}

/** Purge grants whose workspace TTL has elapsed. */
export function purgeExpiredFrameCapabilities(now = Math.floor(Date.now() / 1000)): void {
  for (const [key, grant] of frameCapabilities) {
    if (grant.workspaceExpiresAt > 0 && grant.workspaceExpiresAt <= now) frameCapabilities.delete(key);
  }
}

/** Narrow observability used by focused lifecycle tests; no grant data escapes. */
export function getActiveFrameCapabilityCountForTests(): number {
  return frameCapabilities.size;
}

function requireCapability(input: WorkspaceFrameContextV1, operation: WorkspaceOperationKindV1, rawRequest: unknown): void {
  if (input.actor === "host" || input.actor === "root") return;
  const frameId = input.frameId;
  if (!frameId) fail("child_confinement", "child operations require frameId");
  const database = getDb();
  ensureFrameCapabilityDatabase(database);
  purgeExpiredFrameCapabilities();
  const key = frameCapabilityKey({
    userId: input.userId,
    chatId: input.chatId,
    turnId: input.turnId,
    workspaceId: input.workspaceId,
    frameId,
  });
  const grant = frameCapabilities.get(key);
  if (!grant) fail("capability_denied", "frame capabilities are not frozen");
  const caps = grant.capabilities;
  if (!caps.allowed.includes(operation)) fail("capability_denied", `frame lacks ${operation} capability`);
  const operationBytes = measureWorkspaceOperationBytesV1(rawRequest);
  if (caps.maxOperationBytes < 1 || operationBytes > caps.maxOperationBytes) {
    fail("capability_denied", "workspace operation exceeds the frame byte budget", {
      limit: caps.maxOperationBytes,
      observed: operationBytes,
    });
  }
  if (caps.maxOperations < 1 || grant.operationsUsed >= caps.maxOperations) {
    fail("capability_denied", "frame operation budget is exhausted", {
      limit: caps.maxOperations,
      observed: grant.operationsUsed + 1,
    });
  }
  // Bun executes these synchronous workspace operations atomically on the
  // event loop. Increment before the protected read/write/action so a
  // concurrent last-operation race admits exactly one attempt.
  grant.operationsUsed += 1;
}
function validateFrameCapabilityGrant(value: unknown): WorkspaceFrameCapabilityGrantV1 {
  if (!isRecord(value)) fail("invalid_input", "frame capability grant must be an object");
  assertKeys(value, ["userId", "chatId", "turnId", "workspaceId", "frameId", "capabilities"], "frameCapabilityGrant");
  assertNoPrivateFields(value);
  return Object.freeze({
    userId: idValue(value.userId, "userId"),
    chatId: idValue(value.chatId, "chatId"),
    turnId: idValue(value.turnId, "turnId"),
    workspaceId: idValue(value.workspaceId, "workspaceId"),
    frameId: idValue(value.frameId, "frameId"),
    capabilities: capabilityValue(value.capabilities, "child"),
  });
}
/**
 * Freeze a host-issued child grant against the complete authority tuple.
 * Child/model input never reaches this function; it can only use a grant
 * already registered by the trusted coordinator.
 */
export function freezeFrameCapabilities(raw: unknown): WorkspaceOperationCapabilitiesV1 {
  const input = validateFrameCapabilityGrant(raw);
  const row = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
  if (!row) fail("not_found", "workspace was not found");
  if (!row.turnActive || row.state !== "active" || row.expiresAt > 0 && row.expiresAt <= Math.floor(Date.now() / 1000)) {
    invalidateFrameCapabilitiesForTurn(input);
    fail("workspace_frozen", "frame capabilities require an active workspace turn");
  }
  const workspaceCaps = capabilityValue(row.caps, "root");
  if (
    input.capabilities.revision > workspaceCaps.revision
    || input.capabilities.maxOperationBytes > workspaceCaps.maxOperationBytes
    || input.capabilities.maxOperations > workspaceCaps.maxOperations
    || input.capabilities.allowed.some((operation) => !workspaceCaps.allowed.includes(operation))
  ) {
    fail("forbidden", "frame capabilities exceed the workspace grant");
  }
  const key = frameCapabilityKey(input);
  const old = frameCapabilities.get(key);
  const encoded = JSON.stringify(input.capabilities);
  if (old !== undefined) {
    if (JSON.stringify(old.capabilities) !== encoded) fail("forbidden", "frame capabilities are already frozen");
    return deepFreeze({ ...old.capabilities });
  }
  frameCapabilities.set(key, {
    userId: input.userId,
    chatId: input.chatId,
    turnId: input.turnId,
    workspaceId: input.workspaceId,
    frameId: input.frameId,
    workspaceExpiresAt: row.expiresAt,
    capabilities: input.capabilities,
    operationsUsed: 0,
  });
  return deepFreeze({ ...input.capabilities });
}
function publicWorkspace(row: WorkspaceRow): WorkspaceSnapshotV1 {
  return deepFreeze({ id: row.workspaceId, turnId: row.turnId, executionId: row.executionId, userId: row.userId, chatId: row.chatId, objective: row.objective, constraints: [...row.constraints], state: row.state, revision: row.revision, quota: { ...row.quota }, usage: { ...row.usage }, retention: row.retention, expiresAt: row.expiresAt, createdAt: row.createdAt, updatedAt: row.updatedAt, frozenAt: row.frozenAt });
}
function listWorkspaceRows(table: string, row: WorkspaceRow): Array<Record<string, unknown>> {
  const database = getDb();
  if (!tableExists(database, table)) fail("schema_unavailable", `${table} is unavailable`);
  return database.query(`SELECT * FROM ${quoteIdentifier(table)} WHERE workspace_id = ? AND user_id = ? AND chat_id = ? AND turn_id = ?`).all(row.workspaceId, row.userId, row.chatId, row.turnId) as Array<Record<string, unknown>>;
}
function serializedTaskFootprintV1(title: string, objective: string, dependencies: readonly string[]): number {
  return utf8ByteLength(title)
    + utf8ByteLength(objective)
    + utf8ByteLength(JSON.stringify(dependencies));
}

function taskFootprintFromRow(raw: Record<string, unknown>): number {
  const base = serializedTaskFootprintV1(
    rowString(raw, ["title"]),
    rowString(raw, ["description", "title"]),
    jsonArray(raw.dependencies_json),
  );
  return base + (rowString(raw, ["state"]) === "failed" ? utf8ByteLength(rowString(raw, ["summary"])) : 0);
}

/**
 * Rebuild usage from the rows that are authoritative for a workspace. The
 * denormalized counters are still updated for fast reads, but admissions must
 * never trust a stale counter after another CAS writer has committed.
 */
function currentWorkspaceUsage(database: Database, row: WorkspaceRow): WorkspaceUsageV1 {
  const rows = (table: string): Array<Record<string, unknown>> => {
    if (!tableExists(database, table)) return [];
    return database.query(
      `SELECT * FROM ${quoteIdentifier(table)}
       WHERE workspace_id = ? AND user_id = ? AND chat_id = ? AND turn_id = ?`,
    ).all(row.workspaceId, row.userId, row.chatId, row.turnId) as Array<Record<string, unknown>>;
  };
  const tasks = rows("agent_workspace_tasks");
  const records = rows("agent_workspace_records");
  const submissions = rows("agent_workspace_submissions");
  const artifacts = rows("agent_workspace_artifacts");
  const rowBytes = (candidate: Record<string, unknown>): number => Math.max(0, rowNumber(candidate, ["byte_count"]));
  const byteCount = tasks.reduce((total, task) => total + taskFootprintFromRow(task), 0)
    + records.reduce((total, record) => total + rowBytes(record), 0)
    + submissions.reduce((total, submission) => total + rowBytes(submission), 0)
    + artifacts.reduce((total, artifact) => total + rowBytes(artifact), 0);
  return {
    taskCount: tasks.length,
    recordCount: records.length,
    submissionCount: submissions.length,
    artifactCount: artifacts.length,
    byteCount,
  };
}

let workspaceMutationCommitBoundaryHookForTests: (() => void) | undefined;

export function setWorkspaceMutationCommitBoundaryHookForTests(hook?: (() => void) | null): void {
  workspaceMutationCommitBoundaryHookForTests = hook ?? undefined;
}

function currentWorkspaceForMutation(row: WorkspaceRow, allowFrozen = false): WorkspaceRow {
  const current = findWorkspace(row.workspaceId, row.userId, row.chatId, row.turnId);
  if (!current || current.revision !== row.revision) fail("stale_revision", "workspace revision changed before mutation");
  const expired = current.state === "expired"
    || (current.expiresAt > 0 && current.expiresAt <= Math.floor(Date.now() / 1000));
  if (!current.turnActive || expired || (current.state !== "active" && !(allowFrozen && current.state === "frozen"))) {
    fail("workspace_frozen", "workspace is not writable");
  }
  return current;
}

function taskFromRow(raw: Record<string, unknown>): WorkspaceTaskV1 {
  const state = rowString(raw, ["state"]) as WorkspaceTaskStateV1;
  if (!STATES.has(state)) fail("invalid_state", "task state is invalid");
  return deepFreeze({
    id: rowString(raw, ["task_id"]),
    workspaceId: rowString(raw, ["workspace_id"]),
    turnId: rowString(raw, ["turn_id"]),
    userId: rowString(raw, ["user_id"]),
    chatId: rowString(raw, ["chat_id"]),
    title: rowString(raw, ["title"]),
    objective: rowString(raw, ["description", "title"]),
    state,
    required: rowNumber(raw, ["required"]) === 1,
    dependencyIds: Object.freeze(jsonArray(raw.dependencies_json)),
    assignedFrameId: rowNullableString(raw, ["assigned_frame_id"]),
    progress: Math.max(0, Math.min(1, rowNumber(raw, ["progress"]))),
    summary: rowNullableString(raw, ["summary"]),
    revision: rowNumber(raw, ["revision"]),
    retention: rowString(raw, ["retention"], "operational") as WorkspaceRetentionV1,
    expiresAt: rowNumber(raw, ["expires_at"]),
    createdAt: rowNumber(raw, ["created_at"]),
    updatedAt: rowNumber(raw, ["updated_at"]),
  });
}
function taskById(row: WorkspaceRow, taskId: string): WorkspaceTaskV1 {
  const found = listWorkspaceRows("agent_workspace_tasks", row).find((candidate) => rowString(candidate, ["task_id"]) === taskId);
  if (!found) fail("not_found", "task was not found");
  return taskFromRow(found);
}
function taskOperationKey(row: WorkspaceRow, taskId: string): string | null {
  const found = listWorkspaceRows("agent_workspace_tasks", row)
    .find((candidate) => rowString(candidate, ["task_id"]) === taskId);
  return found ? rowNullableString(found, ["cas_owner"]) : null;
}
function rootResultPolicyIdentity(input: Pick<SubmitWorkspaceRootResultInputV1, "retention" | "ttlSeconds">): number {
  const retentionCode = input.retention === undefined
    ? 0
    : input.retention === "operational"
      ? 1
      : input.retention === "turn_terminal"
        ? 2
        : 3;
  return retentionCode * (WORKSPACE_MAX_TERMINAL_TTL_SECONDS + 1) + (input.ttlSeconds ?? 0);
}
function taskRootResultPolicyIdentity(row: WorkspaceRow, taskId: string): number | null {
  const found = listWorkspaceRows("agent_workspace_tasks", row)
    .find((candidate) => rowString(candidate, ["task_id"]) === taskId);
  if (!found || !Number.isSafeInteger(found.cas_expires_at)) return null;
  return found.cas_expires_at as number;
}
function rootCognitionResultMatches(
  row: WorkspaceRow,
  task: WorkspaceTaskV1,
  submission: WorkspaceSubmissionV1 | undefined,
  input: SubmitWorkspaceRootResultInputV1,
): boolean {
  if (
    task.state !== input.state
    || task.summary !== input.summary
    || taskRootResultPolicyIdentity(row, task.id) !== rootResultPolicyIdentity(input)
  ) return false;
  if (input.state === "failed") return submission === undefined;
  if (!submission || submission.state !== "accepted") return false;
  return submission.childFrameId === (input.frameId ?? "root")
    && submission.summary === input.summary
    && submission.resultDigest === summaryDigest(input.summary)
    && submission.byteCount === utf8ByteLength(input.summary)
    && submission.retention === (input.retention ?? row.retention);
}


function recordFromRow(raw: Record<string, unknown>): WorkspaceRecordV1 {
  const kind = rowString(raw, ["kind"]) as WorkspaceRecordKindV1;
  if (!KINDS.has(kind)) fail("invalid_input", "record kind is invalid");
  return deepFreeze({ id: rowString(raw, ["record_id"]), workspaceId: rowString(raw, ["workspace_id"]), turnId: rowString(raw, ["turn_id"]), userId: rowString(raw, ["user_id"]), chatId: rowString(raw, ["chat_id"]), kind, summary: rowString(raw, ["summary"]), digest: rowString(raw, ["digest"]), taskId: rowNullableString(raw, ["task_id"]), sourceFrameId: rowNullableString(raw, ["source_frame_id"]), byteCount: rowNumber(raw, ["byte_count"]), revision: rowNumber(raw, ["revision"]), retention: rowString(raw, ["retention"], "operational") as WorkspaceRetentionV1, expiresAt: rowNumber(raw, ["expires_at"]), createdAt: rowNumber(raw, ["created_at"]) });
}
function recordById(row: WorkspaceRow, recordId: string): WorkspaceRecordV1 {
  const found = listWorkspaceRows("agent_workspace_records", row).find((candidate) => rowString(candidate, ["record_id"]) === recordId);
  if (!found) fail("not_found", "record was not found");
  return recordFromRow(found);
}
function submissionFromRow(raw: Record<string, unknown>): WorkspaceSubmissionV1 {
  const state = rowString(raw, ["state"]);
  if (!(WORKSPACE_SUBMISSION_STATES as readonly string[]).includes(state)) fail("invalid_state", "submission state is invalid");
  return deepFreeze({ id: rowString(raw, ["submission_id"]), workspaceId: rowString(raw, ["workspace_id"]), turnId: rowString(raw, ["turn_id"]), taskId: rowString(raw, ["task_id"]), userId: rowString(raw, ["user_id"]), chatId: rowString(raw, ["chat_id"]), childFrameId: rowString(raw, ["child_frame_id"]), state: state as WorkspaceSubmissionV1["state"], summary: rowString(raw, ["summary"]), resultDigest: rowString(raw, ["result_digest"]), byteCount: rowNumber(raw, ["byte_count"]), revision: rowNumber(raw, ["revision"]), retention: rowString(raw, ["retention"], "operational") as WorkspaceRetentionV1, expiresAt: rowNumber(raw, ["expires_at"]), createdAt: rowNumber(raw, ["created_at"]), updatedAt: rowNumber(raw, ["updated_at"]) });
}
function submissionById(row: WorkspaceRow, id: string): WorkspaceSubmissionV1 {
  const found = listWorkspaceRows("agent_workspace_submissions", row).find((candidate) => rowString(candidate, ["submission_id"]) === id);
  if (!found) fail("not_found", "submission was not found");
  return submissionFromRow(found);
}
function submissionTaskForAcceptance(
  row: WorkspaceRow,
  input: AcceptWorkspaceSubmissionInputV1,
  submission: WorkspaceSubmissionV1,
): WorkspaceTaskV1 {
  if (submission.taskId !== input.taskId) {
    fail("invalid_input", "submission does not belong to the authenticated task");
  }
  const task = taskById(row, input.taskId);
  if (task.state !== "completed") {
    fail("invalid_state", "submission task must be completed before acceptance");
  }
  if (!task.assignedFrameId || task.assignedFrameId !== submission.childFrameId) {
    fail("invalid_input", "submission child frame does not match the task assignment");
  }
  return task;
}
function artifactFromRow(raw: Record<string, unknown>): WorkspaceArtifactReferenceV1 {
  const state = rowString(raw, ["publication_state"], "attached") as WorkspaceArtifactReferenceV1["publicationState"];
  if (state !== "attached" && state !== "proposed" && state !== "published") fail("invalid_state", "artifact publication state is invalid");
  let provenance: WorkspaceArtifactProvenanceV1 = "host";
  try { const parsed: unknown = JSON.parse(rowString(raw, ["provenance_json"], "\"host\"")); if (typeof parsed === "string" && PROVENANCE.has(parsed as WorkspaceArtifactProvenanceV1)) provenance = parsed as WorkspaceArtifactProvenanceV1; } catch { /* do not expose malformed provenance */ }
  return deepFreeze({ id: rowString(raw, ["artifact_id"]), workspaceId: rowString(raw, ["workspace_id"]), turnId: rowString(raw, ["turn_id"]), userId: rowString(raw, ["user_id"]), chatId: rowString(raw, ["chat_id"]), blobDigest: rowString(raw, ["blob_digest"]), mimeType: rowString(raw, ["mime_type"]), byteCount: rowNumber(raw, ["byte_count"]), provenance, sourceFrameId: rowNullableString(raw, ["source_frame_id"]), sourceTaskId: rowNullableString(raw, ["source_task_id"]), publicationState: state, retention: rowString(raw, ["retention"], "operational") as WorkspaceRetentionV1, revision: rowNumber(raw, ["revision"]), expiresAt: rowNumber(raw, ["expires_at"]), createdAt: rowNumber(raw, ["created_at"]) });
}
function artifactById(row: WorkspaceRow, artifactId: string): WorkspaceArtifactReferenceV1 {
  const found = listWorkspaceRows("agent_workspace_artifacts", row).find((candidate) => rowString(candidate, ["artifact_id"]) === artifactId);
  if (!found) fail("not_found", "artifact was not found");
  return artifactFromRow(found);
}
function assertAssignedChild(input: WorkspaceFrameContextV1, task: WorkspaceTaskV1): void {
  if (input.actor !== "child" || !input.frameId || task.assignedFrameId !== input.frameId) fail("child_confinement", "child may only mutate its assigned task");
}
function assertAcyclic(row: WorkspaceRow, taskId: string, dependencies: readonly string[]): void {
  if (dependencies.includes(taskId)) fail("dependency_cycle", "task cannot depend on itself");
  const graph = new Map<string, readonly string[]>();
  for (const candidate of listWorkspaceRows("agent_workspace_tasks", row)) graph.set(rowString(candidate, ["task_id"]), jsonArray(candidate.dependencies_json));
  graph.set(taskId, dependencies);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) fail("dependency_cycle", "workspace dependencies must be acyclic");
    if (visited.has(id)) return;
    if (!graph.has(id)) fail("invalid_input", "task dependency does not exist");
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}
function withWritableWorkspaceTransaction<T>(
  row: WorkspaceRow,
  operation: (current: WorkspaceRow) => T,
  allowFrozen = false,
): T {
  workspaceMutationCommitBoundaryHookForTests?.();
  purgeExpiredFrameCapabilities();
  const capabilitiesBefore = new Map(frameCapabilities);
  try {
    return getDb().transaction(() => operation(currentWorkspaceForMutation(row, allowFrozen)))();
  } catch (error) {
    frameCapabilities.clear();
    for (const [key, grant] of capabilitiesBefore) frameCapabilities.set(key, grant);
    // SQLite has rolled back. Re-read each restored authority so a Stop or
    // deadline committed outside this transaction still wins over the snapshot.
    const restoredScopes = new Set<string>();
    for (const grant of capabilitiesBefore.values()) {
      const scope = frameCapabilityKey(grant);
      if (restoredScopes.has(scope)) continue;
      restoredScopes.add(scope);
      try {
        findWorkspace(grant.workspaceId, grant.userId, grant.chatId, grant.turnId);
      } catch {
        invalidateFrameCapabilitiesForTurn(grant);
      }
    }
    throw error;
  }
}

function mutateWorkspace(row: WorkspaceRow, operation: () => void, allowFrozen = false): number {
  withWritableWorkspaceTransaction(row, operation, allowFrozen);
  return row.revision + 1;
}
function casWorkspace(row: WorkspaceRow, values: Record<string, unknown>): void {
  const changed = updateRow(getDb(), "agent_turn_workspaces", { ...values, revision: row.revision + 1, updated_at: values.updated_at ?? Math.floor(Date.now() / 1000) }, { workspace_id: row.workspaceId, turn_id: row.turnId, execution_id: row.executionId, user_id: row.userId, chat_id: row.chatId, revision: row.revision });
  if (changed !== 1) fail("stale_revision", "workspace revision is stale");
}
export interface TurnWorkspaceMutationReceiptV1 {
  readonly operationKey: string;
  readonly segmentId: string;
  readonly logicalDispatch: number;
  readonly frameId: string;
  readonly operationDigest: string;
  readonly beforeWorkspaceRevision: number;
  readonly afterWorkspaceRevision: number;
}

function workspaceMutationReservationV1(
  raw: AgenticWorkWorkspaceMutationReservationV1,
): AgenticWorkWorkspaceMutationReservationV1 {
  if (!raw || raw.version !== 1) fail("invalid_input", "workspace mutation reservation version is invalid");
  const operationKind = raw.operationKind;
  if (
    typeof operationKind !== "string"
    || (!OPERATIONS.has(operationKind as WorkspaceOperationKindV1)
      && operationKind !== "assign_child_tasks"
      && operationKind !== "settle_child_task")
  ) {
    fail("invalid_input", "workspace mutation reservation operation kind is invalid");
  }
  return Object.freeze({
    version: 1,
    operationKey: stringValue(raw.operationKey, "reservation.operationKey", 256),
    operationKind,
    segmentId: idValue(raw.segmentId, "reservation.segmentId"),
    logicalDispatch: integer(raw.logicalDispatch, "reservation.logicalDispatch", 0, 2_147_483_648),
    frameId: idValue(raw.frameId, "reservation.frameId"),
  });
}

function requireWorkspaceMutationOriginV1(
  database: Database,
  userId: string,
  executionId: string,
  reservation: AgenticWorkWorkspaceMutationReservationV1,
): void {
  const origin = database.query("SELECT 1 AS present FROM agent_work_segment_dispatches WHERE user_id = ? AND execution_id = ? AND segment_id = ? AND dispatch_ordinal = ?")
    .get(userId, executionId, reservation.segmentId, reservation.logicalDispatch);
  if (!origin) fail("invalid_state", "workspace mutation reservation has no exact durable dispatch origin");
}

function workspaceMutationReceiptV1(
  raw: Record<string, unknown>,
  reservation: AgenticWorkWorkspaceMutationReservationV1,
): TurnWorkspaceMutationReceiptV1 {
  const segmentId = idValue(raw.segment_id, "receipt.segmentId");
  const logicalDispatch = integer(raw.logical_dispatch, "receipt.logicalDispatch", 0, 2_147_483_648);
  const frameId = idValue(raw.frame_id, "receipt.frameId");
  if (
    segmentId !== reservation.segmentId
    || logicalDispatch !== reservation.logicalDispatch
    || frameId !== reservation.frameId
  ) {
    fail("invalid_state", "workspace operation identity is already bound to another durable owner");
  }
  return Object.freeze({
    operationKey: reservation.operationKey,
    segmentId,
    logicalDispatch,
    frameId,
    operationDigest: stringValue(raw.operation_digest, "receipt.operationDigest", 64),
    beforeWorkspaceRevision: integer(raw.before_workspace_revision, "receipt.beforeWorkspaceRevision", 0, Number.MAX_SAFE_INTEGER),
    afterWorkspaceRevision: integer(raw.after_workspace_revision, "receipt.afterWorkspaceRevision", 0, Number.MAX_SAFE_INTEGER),
  });
}

/**
 * Executes one authenticated turn-workspace mutation and records its exact CAS
 * effect in the same SQLite transaction. The digest is derived here from the
 * accepted host operation envelope; callers cannot attest a receipt digest.
 */
export function commitTurnWorkspaceMutationWithReceiptV1<T>(input: Readonly<{
  userId: string;
  executionId: string;
  workspaceId: string;
  expectedRevision: number;
  reservation: AgenticWorkWorkspaceMutationReservationV1;
  operationArgs: Readonly<Record<string, unknown>>;
}>, mutation: () => T): Readonly<{ result: T | null; receipt: TurnWorkspaceMutationReceiptV1 | null }> {
  const database = getDb();
  const reservation = workspaceMutationReservationV1(input.reservation);
  const { expectedRevision: _expectedRevision, revision: _revision, ...canonicalOperationArgs } = input.operationArgs;
  if (canonicalOperationArgs.frameId !== reservation.frameId) {
    fail("invalid_input", "workspace mutation reservation frame does not match the authenticated mutation frame");
  }
  let committed: Readonly<{ result: T | null; receipt: TurnWorkspaceMutationReceiptV1 | null }> | undefined;
  database.transaction(() => {
    requireWorkspaceMutationOriginV1(database, input.userId, input.executionId, reservation);
    const prior = database.query("SELECT workspace_id, segment_id, logical_dispatch, frame_id, operation_digest, before_workspace_revision, after_workspace_revision FROM agent_work_workspace_receipts WHERE user_id = ? AND execution_id = ? AND operation_key = ?")
      .get(input.userId, input.executionId, reservation.operationKey) as Record<string, unknown> | null;
    if (prior) {
      const receipt = workspaceMutationReceiptV1(prior, reservation);
      const expectedDigest = createHash("sha256").update(encodeCanonicalPlainData({
        version: 1,
        executionId: input.executionId,
        workspaceId: input.workspaceId,
        operationKey: reservation.operationKey,
        operationKind: reservation.operationKind,
        segmentId: reservation.segmentId,
        logicalDispatch: reservation.logicalDispatch,
        frameId: reservation.frameId,
        operationArgs: canonicalOperationArgs,
        workspaceRevisionBefore: receipt.beforeWorkspaceRevision,
        workspaceRevisionAfter: receipt.afterWorkspaceRevision,
      }), "utf8").digest("hex");
      if (
        prior.workspace_id !== input.workspaceId
        || receipt.operationDigest !== expectedDigest
        || receipt.afterWorkspaceRevision !== receipt.beforeWorkspaceRevision + 1
      ) {
        fail("invalid_state", "workspace operation identity is already bound to another mutation");
      }
      committed = Object.freeze({ result: null, receipt });
      return;
    }
    const before = database.query("SELECT workspace_id, revision FROM agent_turn_workspaces WHERE user_id = ? AND execution_id = ? AND workspace_id = ?")
      .get(input.userId, input.executionId, input.workspaceId) as Record<string, unknown> | null;
    if (!before || before.revision !== input.expectedRevision) fail("stale_revision", "workspace revision changed before receipted mutation");
    const result = mutation();
    const after = database.query("SELECT revision FROM agent_turn_workspaces WHERE user_id = ? AND execution_id = ? AND workspace_id = ?")
      .get(input.userId, input.executionId, input.workspaceId) as Record<string, unknown> | null;
    if (!after || typeof after.revision !== "number"
      || (after.revision !== input.expectedRevision && after.revision !== input.expectedRevision + 1)) {
      fail("stale_revision", "workspace mutation did not commit an exact contiguous CAS revision");
    }
    if (after.revision === input.expectedRevision) {
      committed = Object.freeze({ result, receipt: null });
      return;
    }
    const operationDigest = createHash("sha256").update(encodeCanonicalPlainData({
      version: 1,
      executionId: input.executionId,
      workspaceId: input.workspaceId,
      operationKey: reservation.operationKey,
      operationKind: reservation.operationKind,
      segmentId: reservation.segmentId,
      logicalDispatch: reservation.logicalDispatch,
      frameId: reservation.frameId,
      operationArgs: canonicalOperationArgs,
      workspaceRevisionBefore: input.expectedRevision,
      workspaceRevisionAfter: after.revision,
    }), "utf8").digest("hex");
    insertRow(database, "agent_work_workspace_receipts", {
      user_id: input.userId,
      execution_id: input.executionId,
      workspace_id: input.workspaceId,
      segment_id: reservation.segmentId,
      logical_dispatch: reservation.logicalDispatch,
      frame_id: reservation.frameId,
      operation_key: reservation.operationKey,
      operation_digest: operationDigest,
      before_workspace_revision: input.expectedRevision,
      after_workspace_revision: after.revision,
      settled_at: Math.floor(Date.now() / 1000),
    }, ["user_id", "execution_id", "workspace_id", "segment_id", "logical_dispatch", "frame_id", "operation_key", "operation_digest"]);
    committed = Object.freeze({
      result,
      receipt: Object.freeze({
        operationKey: reservation.operationKey,
        segmentId: reservation.segmentId,
        logicalDispatch: reservation.logicalDispatch,
        frameId: reservation.frameId,
        operationDigest,
        beforeWorkspaceRevision: input.expectedRevision,
        afterWorkspaceRevision: after.revision,
      }),
    });
  })();
  if (!committed) fail("invalid_state", "workspace receipted mutation did not commit");
  return committed;
}

export function createTurnWorkspace(raw: unknown): WorkspaceSnapshotV1 {
  const input = validateCreateWorkspaceInput(raw);
  const database = getDb();
  if (!tableExists(database, "agent_turn_workspaces")) fail("schema_unavailable", "workspace schema is unavailable");
  if (tableExists(database, "agent_turn_executions") && !database.query("SELECT 1 AS present FROM agent_turn_executions WHERE id = ? AND user_id = ? AND chat_id = ?").get(input.turnId, input.userId, input.chatId)) fail("not_found", "turn execution was not found");
  const workspaceId = input.workspaceId ?? crypto.randomUUID();
  idValue(workspaceId, "workspaceId");
  if (findWorkspace(workspaceId, input.userId, input.chatId, input.turnId)) fail("duplicate_id", "workspace identifier is already in use");
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = input.retention === "chat_lifetime" ? 0 : now + (input.ttlSeconds ?? 0);
  database.transaction(() => {
    insertRow(database, "agent_turn_workspaces", {
      workspace_id: workspaceId, turn_id: input.turnId, execution_id: input.turnId, user_id: input.userId, chat_id: input.chatId,
      objective: input.objective, constraints_json: JSON.stringify(input.constraints), state: "active", revision: 0, cas_owner: null, cas_expires_at: null,
      operation_caps_json: JSON.stringify(input.capabilities), field_caps_json: JSON.stringify(input.capabilities), retention: input.retention, expires_at: expiresAt,
      quota_tasks: input.quota.maxTasks, quota_records: input.quota.maxRecords, quota_submissions: input.quota.maxSubmissions, quota_artifacts: input.quota.maxArtifacts, quota_bytes: input.quota.maxBytes,
      task_count: 0, record_count: 0, submission_count: 0, artifact_count: 0, byte_count: 0, created_at: now, updated_at: now, frozen_at: null,
    }, ["workspace_id", "turn_id", "execution_id", "user_id", "chat_id"]);
    if (tableExists(database, "agent_turn_executions") && updateRow(database, "agent_turn_executions", { workspace_id: workspaceId, workspace_revision: 0, updated_at: now }, { id: input.turnId, user_id: input.userId, chat_id: input.chatId }) !== 1) fail("stale_revision", "turn execution changed while creating workspace");
  })();
  return getTurnWorkspace({ userId: input.userId, chatId: input.chatId, turnId: input.turnId, workspaceId, actor: "root", expectedRevision: 0 });
}
export function getTurnWorkspace(raw: unknown): WorkspaceSnapshotV1 {
  return publicWorkspace(requireWorkspace(contextValue(raw, true)));
}

/**
 * Read the persisted workspace CAS revision without supplying an expected
 * revision. This is used only after an operation whose response omitted its
 * public revision; callers must use the returned value verbatim rather than
 * deriving a revision from an in-memory counter.
 */
export function getCurrentWorkspaceRevisionV1(raw: unknown): number {
  if (!isRecord(raw)) fail("invalid_input", "workspace identity must be an object");
  assertKeys(raw, ["userId", "chatId", "turnId", "workspaceId"], "workspaceIdentity");
  assertNoPrivateFields(raw);
  const userId = idValue(raw.userId, "userId");
  const chatId = idValue(raw.chatId, "chatId");
  const turnId = idValue(raw.turnId, "turnId");
  const workspaceId = idValue(raw.workspaceId, "workspaceId");
  const row = findWorkspace(workspaceId, userId, chatId, turnId);
  if (!row) fail("not_found", "workspace was not found");
  if (!Number.isSafeInteger(row.revision) || row.revision < 0) fail("invalid_state", "workspace revision is malformed");
  return row.revision;
}
export function readTurnWorkspaceSection(raw: unknown): WorkspaceSectionPageV1 {
  const input = validateReadWorkspaceSectionInput(raw);
  const row = requireWorkspace(input);
  requireCapability(input, input.page > 0 ? "read_page" : "read_section", raw);
  const workspace = publicWorkspace(row);
  if (input.section === "objective") return { workspace, section: input.section, page: input.page, pageSize: input.pageSize, total: 1, items: [{ objective: workspace.objective }] };
  if (input.section === "constraints") return { workspace, section: input.section, page: input.page, pageSize: input.pageSize, total: workspace.constraints.length, items: workspace.constraints.slice(input.page * input.pageSize, (input.page + 1) * input.pageSize).map((constraint: string) => ({ constraint })) };
  if (input.section === "summary") return { workspace, section: input.section, page: input.page, pageSize: input.pageSize, total: 1, items: [{ usage: workspace.usage, state: workspace.state, revision: workspace.revision }] };
  const table = input.section === "tasks" ? "agent_workspace_tasks" : input.section === "records" ? "agent_workspace_records" : input.section === "submissions" ? "agent_workspace_submissions" : "agent_workspace_artifacts";
  const rows = listWorkspaceRows(table, row);
  const items = rows.map((candidate) => input.section === "tasks" ? taskFromRow(candidate) : input.section === "records" ? recordFromRow(candidate) : input.section === "submissions" ? submissionFromRow(candidate) : artifactFromRow(candidate));
  return { workspace, section: input.section, page: input.page, pageSize: input.pageSize, total: items.length, items: items.slice(input.page * input.pageSize, (input.page + 1) * input.pageSize) };
}
export function createWorkspaceTask(raw: unknown): WorkspaceTaskV1 {
  const input = validateCreateWorkspaceTaskRuntimeInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "create_task", raw);
  if (input.actor === "child") fail("forbidden", "children cannot create tasks");

  let taskId = "";
  const objective = input.objective ?? input.title;
  const dependenciesJson = JSON.stringify(input.dependencyIds);
  const byteCount = serializedTaskFootprintV1(input.title, objective, input.dependencyIds);
  const now = Math.floor(Date.now() / 1000);
  const policy = input.retention === undefined
    ? { retention: row.retention, expiresAt: row.expiresAt }
    : retentionValue(input.retention, input.ttlSeconds, now);
  mutateWorkspace(row, () => {
    const current = currentWorkspaceForMutation(row);
    taskId = allocateWritableTaskId(current, input.taskId);
    const usage = currentWorkspaceUsage(getDb(), current);
    if (usage.taskCount >= current.quota.maxTasks) {
      fail("quota_exceeded", "task quota exceeded", { limit: current.quota.maxTasks, observed: usage.taskCount + 1 });
    }
    if (usage.byteCount + byteCount > current.quota.maxBytes) fail("quota_exceeded", "workspace byte quota exceeded");
    assertAcyclic(current, taskId, input.dependencyIds);
    insertWorkspaceTaskRow(getDb(), {
      task_id: taskId,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      title: input.title,
      description: objective,
      state: "active",
      required: input.hostRequired ? 1 : 0,
      dependencies_json: dependenciesJson,
      assigned_frame_id: input.assignedFrameId,
      progress: 0,
      summary: null,
      byte_count: byteCount,
      revision: 0,
      cas_owner: null,
      cas_expires_at: null,
      retention: policy.retention,
      expires_at: policy.expiresAt,
      created_at: now,
      updated_at: now,
    });
    casWorkspace(current, {
      task_count: usage.taskCount + 1,
      record_count: usage.recordCount,
      submission_count: usage.submissionCount,
      artifact_count: usage.artifactCount,
      byte_count: usage.byteCount + byteCount,
      updated_at: now,
    });
  });
  return taskById(row, taskId);
}
/**
 * Assign already materialized cognition tasks to host-generated child frames.
 * This control-plane operation deliberately is not part of WORK's model-visible
 * operation vocabulary. Validation happens for the complete batch before any
 * row is updated; the workspace CAS and task updates share one transaction.
 */
export function assignChildTasks(raw: unknown): AssignWorkspaceTasksResultV1 {
  const input = validateAssignWorkspaceTasksInput(raw);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root assign child tasks");
  requireCapability(input, "create_task", raw);
  const initial = requireWritable(input);
  let committedRevision = -1;
  let assignedIds: readonly string[] = [];
  const database = getDb();
  withWritableWorkspaceTransaction(initial, (row) => {
    const taskRows = listWorkspaceRows("agent_workspace_tasks", row);
    const tasksById = new Map(taskRows.map((candidate) => {
      const task = taskFromRow(candidate);
      return [task.id, task] as const;
    }));
    const submissionsByTask = new Map<string, Set<string>>();
    for (const candidate of listWorkspaceRows("agent_workspace_submissions", row)) {
      const taskId = rowString(candidate, ["task_id"]);
      const state = rowString(candidate, ["state"]);
      const states = submissionsByTask.get(taskId) ?? new Set<string>();
      states.add(state);
      submissionsByTask.set(taskId, states);
    }
    const now = Math.floor(Date.now() / 1000);
    const assignments: Array<{ task: WorkspaceTaskV1; frameId: string }> = [];
    for (const assignment of input.assignments) {
      const task = tasksById.get(assignment.taskId);
      if (!task) fail("not_found", `task ${assignment.taskId} was not found`);
      if (task.state !== "pending" && task.state !== "active") fail("invalid_state", `task ${task.id} is not open`);
      if (task.expiresAt > 0 && task.expiresAt <= now) fail("invalid_state", `task ${task.id} has expired`);
      if (task.assignedFrameId !== null) fail("task_assignment_conflict", `task ${task.id} is already assigned`);
      const frameOwner = taskRows.find((candidate) => rowNullableString(candidate, ["assigned_frame_id"]) === assignment.frameId);
      if (frameOwner && rowString(frameOwner, ["task_id"]) !== task.id) fail("task_assignment_conflict", `frame ${assignment.frameId} is already assigned`);
      assertAcyclic(row, task.id, task.dependencyIds);
      for (const dependencyId of task.dependencyIds) {
        const dependency = tasksById.get(dependencyId);
        if (!dependency) fail("invalid_input", `task ${task.id} dependency ${dependencyId} does not exist`);
        const dependencyStates = submissionsByTask.get(dependency.id);
        if (dependency.state !== "completed" || !dependencyStates?.has("accepted")) {
          fail("dependency_cycle", `task ${task.id} dependency ${dependency.id} is not accepted`);
        }
      }
      assignments.push({ task, frameId: assignment.frameId });
    }
    for (const { task, frameId } of assignments) {
      if (updateRow(database, "agent_workspace_tasks", {
        assigned_frame_id: frameId,
        revision: task.revision + 1,
        updated_at: now,
      }, {
        task_id: task.id,
        workspace_id: row.workspaceId,
        turn_id: row.turnId,
        user_id: row.userId,
        chat_id: row.chatId,
        revision: task.revision,
      }) !== 1) fail("stale_revision", `task ${task.id} changed during assignment`);
    }
    casWorkspace(row, { updated_at: now });
    committedRevision = row.revision + 1;
    assignedIds = Object.freeze(assignments.map(({ task }) => task.id));
  });
  if (committedRevision < 0 || initial.revision !== input.expectedRevision) fail("stale_revision", "workspace assignment did not commit");
  const committed = requireWorkspace({ ...input, expectedRevision: committedRevision });
  const taskByIdAfterCommit = new Map(listWorkspaceRows("agent_workspace_tasks", committed).map((candidate) => {
    const task = taskFromRow(candidate);
    return [task.id, task] as const;
  }));
  const committedTasks = Object.freeze(assignedIds.map((taskId) => {
    const task = taskByIdAfterCommit.get(taskId);
    if (!task) fail("not_found", `assigned task ${taskId} disappeared`);
    if (!task.assignedFrameId) fail("invalid_state", `assigned task ${taskId} has no frame`);
    return task;
  }));
  return Object.freeze({
    accepted: true,
    workspaceRevision: committedRevision,
    assignments: Object.freeze(committedTasks.map((task) => ({
      taskId: task.id,
      frameId: task.assignedFrameId!,
    }))),
    tasks: committedTasks,
  });
}

/** Descriptive alias for callers that name the control-plane operation. */
export const assignWorkspaceTaskFrames = assignChildTasks;
export function updateWorkspaceTaskPolicy(raw: unknown): WorkspaceTaskV1 {
  const input = validateUpdateWorkspaceTaskPolicyInput(raw);
  const row = requireWritable(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root change task policy");
  requireCapability(input, "create_task", raw);
  const task = taskById(row, input.taskId);
  mutateWorkspace(row, () => {
    const current = currentWorkspaceForMutation(row);
    const currentTask = taskById(current, task.id);
    if (currentTask.revision !== task.revision) fail("stale_revision", "task revision is stale");
    const dependencies = input.dependencyIds ?? currentTask.dependencyIds;
    assertAcyclic(current, currentTask.id, dependencies);
    const oldByteCount = serializedTaskFootprintV1(currentTask.title, currentTask.objective, currentTask.dependencyIds);
    const newByteCount = serializedTaskFootprintV1(currentTask.title, currentTask.objective, dependencies);
    const usage = currentWorkspaceUsage(getDb(), current);
    const nextByteCount = usage.byteCount - oldByteCount + newByteCount;
    if (nextByteCount > current.quota.maxBytes) fail("quota_exceeded", "workspace byte quota exceeded");
    const now = Math.floor(Date.now() / 1000);
    const values: Record<string, unknown> = {
      byte_count: newByteCount,
      updated_at: now,
      revision: currentTask.revision + 1,
    };
    if (input.required !== undefined) values.required = input.required ? 1 : 0;
    if (input.dependencyIds !== undefined) values.dependencies_json = JSON.stringify(dependencies);
    if (input.assignedFrameId !== undefined) values.assigned_frame_id = input.assignedFrameId;
    if (input.retention !== undefined) {
      const policy = retentionValue(input.retention, input.ttlSeconds, now);
      values.retention = policy.retention;
      values.expires_at = policy.expiresAt;
    }
    if (updateRow(getDb(), "agent_workspace_tasks", values, {
      task_id: currentTask.id,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      revision: currentTask.revision,
    }) !== 1) fail("stale_revision", "task revision is stale");
    casWorkspace(current, {
      task_count: usage.taskCount,
      record_count: usage.recordCount,
      submission_count: usage.submissionCount,
      artifact_count: usage.artifactCount,
      byte_count: nextByteCount,
      updated_at: now,
    });
  });
  return taskById(row, task.id);
}
export function updateWorkspaceTaskProgress(raw: unknown): WorkspaceTaskV1 {
  const input = validateUpdateWorkspaceTaskProgressInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "update_assigned_progress", raw);
  const task = taskById(row, input.taskId);
  assertAssignedChild(input, task);
  if (task.state === "completed" || task.state === "cancelled" || task.state === "failed") {
    fail("task_assignment_conflict", "terminal task cannot receive progress updates");
  }
  mutateWorkspace(row, () => {
    const current = currentWorkspaceForMutation(row);
    const currentTask = taskById(current, task.id);
    assertAssignedChild(input, currentTask);
    if (currentTask.state === "completed" || currentTask.state === "cancelled" || currentTask.state === "failed") {
      fail("task_assignment_conflict", "terminal task cannot receive progress updates");
    }
    if (current.revision !== row.revision) fail("stale_revision", "workspace revision changed before task progress");
    if (currentTask.revision !== task.revision) fail("stale_revision", "task revision is stale");
    const now = Math.floor(Date.now() / 1000);
    if (updateRow(getDb(), "agent_workspace_tasks", { state: input.state, progress: input.progress, revision: currentTask.revision + 1, updated_at: now }, { task_id: currentTask.id, workspace_id: current.workspaceId, turn_id: current.turnId, user_id: current.userId, chat_id: current.chatId, revision: currentTask.revision }) !== 1) fail("stale_revision", "task revision is stale");
    casWorkspace(current, { updated_at: now });
  });
  return taskById(row, task.id);
}
export function submitWorkspaceChildResult(raw: unknown): WorkspaceTaskV1 {
  const input = validateSubmitWorkspaceChildResultInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "submit_child_result", raw);
  const task = taskById(row, input.taskId);
  assertAssignedChild(input, task);
  if (task.state === "completed" || task.state === "cancelled" || task.state === "failed") {
    if (
      task.state === "completed"
      && listWorkspaceRows("agent_workspace_submissions", row).some((candidate) => rowString(candidate, ["task_id"]) === task.id)
    ) {
      fail("submission_rejected", "task already has a submitted result");
    }
    fail("task_assignment_conflict", "terminal task cannot receive a child result");
  }
  const submissionBytes = input.byteCount + utf8ByteLength(input.summary);
  const submissionId = crypto.randomUUID();
  mutateWorkspace(row, () => {
    const current = currentWorkspaceForMutation(row);
    const currentTask = taskById(current, task.id);
    if (currentTask.revision !== task.revision) fail("stale_revision", "task revision is stale");
    assertAssignedChild(input, currentTask);
    if (currentTask.state === "completed" || currentTask.state === "cancelled" || currentTask.state === "failed") {
      if (
        currentTask.state === "completed"
        && listWorkspaceRows("agent_workspace_submissions", current).some((candidate) => rowString(candidate, ["task_id"]) === currentTask.id)
      ) {
        fail("submission_rejected", "task already has a submitted result");
      }
      fail("task_assignment_conflict", "terminal task cannot receive a child result");
    }
    const usage = currentWorkspaceUsage(getDb(), current);
    if (usage.submissionCount >= current.quota.maxSubmissions || usage.byteCount + submissionBytes > current.quota.maxBytes) {
      fail("quota_exceeded", "submission quota exceeded");
    }
    const now = Math.floor(Date.now() / 1000);
    const policy = input.retention === undefined
      ? { retention: current.retention, expiresAt: current.expiresAt }
      : retentionValue(input.retention, input.ttlSeconds, now);
    insertRow(getDb(), "agent_workspace_submissions", {
      submission_id: submissionId,
      task_id: currentTask.id,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      child_frame_id: input.frameId,
      state: "submitted",
      summary: input.summary,
      result_digest: input.resultDigest,
      byte_count: submissionBytes,
      revision: 0,
      retention: policy.retention,
      expires_at: policy.expiresAt,
      created_at: now,
      updated_at: now,
    }, ["submission_id", "task_id", "workspace_id", "turn_id", "user_id", "chat_id", "child_frame_id", "state", "summary", "result_digest", "byte_count", "retention", "expires_at"]);
    if (updateRow(getDb(), "agent_workspace_tasks", {
      state: "completed",
      progress: 1,
      revision: currentTask.revision + 1,
      updated_at: now,
    }, {
      task_id: currentTask.id,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      revision: currentTask.revision,
    }) !== 1) fail("stale_revision", "task revision is stale");
    casWorkspace(current, {
      task_count: usage.taskCount,
      record_count: usage.recordCount,
      submission_count: usage.submissionCount + 1,
      artifact_count: usage.artifactCount,
      byte_count: usage.byteCount + submissionBytes,
      updated_at: now,
    });
  });
  return taskById(row, task.id);
}
/**
 * Root-owned task settlement. Completed results create an already-accepted
 * submission; failed results mark the unassigned root task failed without a
 * submission so recovery phases can observe the truthful terminal state.
 */
export function submitWorkspaceRootResult(raw: unknown): WorkspaceTaskV1 {
  const input = validateSubmitWorkspaceRootResultInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "submit_root_result", raw);
  const task = taskById(row, input.taskId);
  if (task.assignedFrameId !== null) {
    fail("child_confinement", "root may not settle a child-assigned task");
  }
  const existingSubmission = listWorkspaceRows("agent_workspace_submissions", row)
    .find((candidate) => rowString(candidate, ["task_id"]) === task.id);

  if (
    rootResultMatches(
      task,
      existingSubmission ? submissionFromRow(existingSubmission) : undefined,
      input,
    )
  ) {
    return task;
  }
  if (task.state === "completed" || task.state === "cancelled" || task.state === "failed") {
    fail("task_assignment_conflict", "terminal task cannot receive a different root result");
  }

  if (existingSubmission) {
    fail("submission_rejected", "task already has a submitted result");
  }
  const submissionBytes = input.state === "completed" ? utf8ByteLength(input.summary) : 0;
  const submissionId = input.state === "completed" ? crypto.randomUUID() : undefined;
  mutateWorkspace(row, () => {
    const current = currentWorkspaceForMutation(row);
    const currentTask = taskById(current, task.id);
    const currentSubmission = listWorkspaceRows("agent_workspace_submissions", current)
      .find((candidate) => rowString(candidate, ["task_id"]) === currentTask.id);
    if (currentTask.assignedFrameId !== null) {
      fail("child_confinement", "root may not settle a child-assigned task");
    }
    if (
      rootResultMatches(
        currentTask,
        currentSubmission ? submissionFromRow(currentSubmission) : undefined,
        input,
      )
    ) return;
    if (currentTask.state === "completed" || currentTask.state === "cancelled" || currentTask.state === "failed") {
      fail("task_assignment_conflict", "terminal task cannot receive a different root result");
    }
    if (currentSubmission) fail("submission_rejected", "task already has a submitted result");
    if (current.revision !== row.revision) fail("stale_revision", "workspace revision changed before mutation");
    if (currentTask.revision !== task.revision) fail("stale_revision", "task revision is stale");

    const now = Math.floor(Date.now() / 1000);
    if (input.state === "failed") {
      const usage = currentWorkspaceUsage(getDb(), current);
      const summaryBytes = utf8ByteLength(input.summary);
      if (usage.byteCount + summaryBytes > current.quota.maxBytes) {
        fail("quota_exceeded", "workspace byte quota exceeded");
      }
      if (updateRow(getDb(), "agent_workspace_tasks", {
        state: "failed",
        summary: input.summary,
        revision: currentTask.revision + 1,
        updated_at: now,
      }, {
        task_id: currentTask.id,
        workspace_id: current.workspaceId,
        turn_id: current.turnId,
        user_id: current.userId,
        chat_id: current.chatId,
        revision: currentTask.revision,
      }) !== 1) fail("stale_revision", "task revision is stale");
      casWorkspace(current, {
        task_count: usage.taskCount,
        record_count: usage.recordCount,
        submission_count: usage.submissionCount,
        artifact_count: usage.artifactCount,
        byte_count: usage.byteCount + summaryBytes,
        updated_at: now,
      });
      return;
    }
    const usage = currentWorkspaceUsage(getDb(), current);
    if (usage.submissionCount >= current.quota.maxSubmissions || usage.byteCount + submissionBytes > current.quota.maxBytes) {
      fail("quota_exceeded", "submission quota exceeded");
    }
    const policy = input.retention === undefined
      ? { retention: current.retention, expiresAt: current.expiresAt }
      : retentionValue(input.retention, input.ttlSeconds, now);
    insertRow(getDb(), "agent_workspace_submissions", {
      submission_id: submissionId!,
      task_id: currentTask.id,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      // The schema predates root submissions; this field records the
      // authenticated root frame and is never treated as child authority.
      child_frame_id: input.frameId ?? "root",
      state: "accepted",
      summary: input.summary,
      result_digest: summaryDigest(input.summary),
      byte_count: submissionBytes,
      revision: 0,
      retention: policy.retention,
      expires_at: policy.expiresAt,
      created_at: now,
      updated_at: now,
    }, ["submission_id", "task_id", "workspace_id", "turn_id", "user_id", "chat_id", "child_frame_id", "state", "summary", "result_digest", "byte_count", "retention", "expires_at"]);
    if (updateRow(getDb(), "agent_workspace_tasks", {
      state: "completed",
      progress: 1,
      summary: input.summary,
      revision: currentTask.revision + 1,
      updated_at: now,
    }, {
      task_id: currentTask.id,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      revision: currentTask.revision,
    }) !== 1) fail("stale_revision", "task revision is stale");
    casWorkspace(current, {
      task_count: usage.taskCount,
      record_count: usage.recordCount,
      submission_count: usage.submissionCount + 1,
      artifact_count: usage.artifactCount,
      byte_count: usage.byteCount + submissionBytes,
      updated_at: now,
    });
  });
  return taskById(row, task.id);
}

/** Host-only, assignment-bound settlement for child cancellation/failure. */
export function settleWorkspaceChildTask(raw: unknown): WorkspaceTaskV1 {
  const input = validateSettleWorkspaceChildTaskInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "update_assigned_progress", raw);
  const task = taskById(row, input.taskId);
  if (task.assignedFrameId !== input.assignedFrameId) {
    fail("child_confinement", "child settlement does not match the assigned frame");
  }
  if (task.state === input.state) {
    if (taskOperationKey(row, task.id) !== null) {
      fail("task_assignment_conflict", "cognition settlement requires its committed operation key");
    }
    return task;
  }
  if (task.state === "completed" || task.state === "cancelled" || task.state === "failed") {
    fail("task_assignment_conflict", "terminal task cannot be downgraded by child settlement");
  }
  mutateWorkspace(row, () => {
    const current = currentWorkspaceForMutation(row);
    const currentTask = taskById(current, task.id);
    if (currentTask.assignedFrameId !== input.assignedFrameId) {
      fail("child_confinement", "child settlement does not match the assigned frame");
    }
    if (currentTask.state === input.state) {
      if (taskOperationKey(current, currentTask.id) !== null) {
        fail("task_assignment_conflict", "cognition settlement requires its committed operation key");
      }
      return;
    }
    if (currentTask.state === "completed" || currentTask.state === "cancelled" || currentTask.state === "failed") {
      fail("task_assignment_conflict", "terminal task cannot be downgraded by child settlement");
    }
    if (current.revision !== row.revision) fail("stale_revision", "workspace revision changed before child settlement");
    if (currentTask.revision !== task.revision) fail("stale_revision", "task revision is stale");
    const now = Math.floor(Date.now() / 1000);
    if (updateRow(getDb(), "agent_workspace_tasks", {
      state: input.state,
      revision: currentTask.revision + 1,
      updated_at: now,
    }, {
      task_id: currentTask.id,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      revision: currentTask.revision,
    }) !== 1) fail("stale_revision", "task revision is stale");
    casWorkspace(current, { updated_at: now });
  });
  return taskById(row, task.id);
}

export function acceptWorkspaceSubmission(raw: unknown): WorkspaceSubmissionV1 {
  const input = validateAcceptWorkspaceSubmissionInput(raw);
  const row = requireWritable(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root accept submissions");
  const submission = submissionById(row, input.submissionId);
  submissionTaskForAcceptance(row, input, submission);
  if (submission.state === "accepted") return submission;
  if (submission.state === "rejected") fail("submission_rejected", "rejected submissions cannot be accepted");
  mutateWorkspace(row, () => {
    const current = currentWorkspaceForMutation(row);
    const currentSubmission = submissionById(current, input.submissionId);
    const currentTask = submissionTaskForAcceptance(current, input, currentSubmission);
    const now = Math.floor(Date.now() / 1000);
    if (updateRow(getDb(), "agent_workspace_submissions", { state: "accepted", revision: currentSubmission.revision + 1, updated_at: now }, { submission_id: currentSubmission.id, workspace_id: current.workspaceId, turn_id: current.turnId, user_id: current.userId, chat_id: current.chatId, revision: currentSubmission.revision }) !== 1) fail("stale_revision", "submission revision is stale");
    if (updateRow(getDb(), "agent_workspace_tasks", { summary: currentSubmission.summary, revision: currentTask.revision + 1, updated_at: now }, { task_id: currentTask.id, workspace_id: current.workspaceId, turn_id: current.turnId, user_id: current.userId, chat_id: current.chatId, revision: currentTask.revision }) !== 1) fail("stale_revision", "task revision is stale");
    casWorkspace(current, { updated_at: now });
  });
  return submissionById(row, input.submissionId);
}
export function recordWorkspaceRecord(raw: unknown): WorkspaceRecordV1 {
  const input = validateRecordWorkspaceRecordInput(raw);
  const row = requireWritable(input);
  requireCapability(input, input.kind === "finding" ? "record_finding" : input.kind === "decision" ? "record_decision" : "record_question", raw);
  const byteCount = utf8ByteLength(input.summary);
  const recordId = crypto.randomUUID();
  mutateWorkspace(row, () => {
    const current = currentWorkspaceForMutation(row);
    const linkedTask = input.taskId ? taskById(current, input.taskId) : undefined;
    if (input.actor === "child") {
      if (!linkedTask) fail("child_confinement", "child records must name an assigned task");
      assertAssignedChild(input, linkedTask);
    }
    const usage = currentWorkspaceUsage(getDb(), current);
    if (usage.recordCount >= current.quota.maxRecords || usage.byteCount + byteCount > current.quota.maxBytes) {
      fail("quota_exceeded", "workspace record quota exceeded");
    }
    if (listWorkspaceRows("agent_workspace_records", current).some((candidate) => rowString(candidate, ["kind"]) === input.kind && rowString(candidate, ["digest"]) === input.digest)) {
      fail("duplicate_id", "record digest is already present");
    }
    const now = Math.floor(Date.now() / 1000);
    const policy = input.retention === undefined
      ? { retention: current.retention, expiresAt: current.expiresAt }
      : retentionValue(input.retention, input.ttlSeconds, now);
    insertRow(getDb(), "agent_workspace_records", {
      record_id: recordId,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      kind: input.kind,
      summary: input.summary,
      digest: input.digest,
      task_id: input.taskId,
      source_frame_id: input.frameId,
      byte_count: byteCount,
      revision: 0,
      retention: policy.retention,
      expires_at: policy.expiresAt,
      created_at: now,
    }, ["record_id", "workspace_id", "turn_id", "user_id", "chat_id", "kind", "summary", "digest", "byte_count", "retention", "expires_at"]);
    casWorkspace(current, {
      task_count: usage.taskCount,
      record_count: usage.recordCount + 1,
      submission_count: usage.submissionCount,
      artifact_count: usage.artifactCount,
      byte_count: usage.byteCount + byteCount,
      updated_at: now,
    });
  });
  return recordById(row, recordId);
}
export function attachWorkspaceArtifactReference(raw: unknown): WorkspaceArtifactReferenceV1 {
  const input = validateAttachWorkspaceArtifactInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "attach_artifact", raw);
  if (input.actor === "child") {
    if (!input.taskId) fail("child_confinement", "child artifacts must name an assigned task");
    assertAssignedChild(input, taskById(row, input.taskId));
    if (input.provenance !== "child") fail("child_confinement", "child artifacts must carry child provenance");
  }
  const database = getDb();
  const artifactId = input.artifactId ?? crypto.randomUUID();
  idValue(artifactId, "artifactId");
  withArtifactDeletionFence(input.userId, input.blobDigest, (deletionFence) => {
    mutateWorkspace(row, () => {
      const current = currentWorkspaceForMutation(row);
      if (input.actor === "child") {
        if (!input.taskId) fail("child_confinement", "child artifacts must name an assigned task");
        assertAssignedChild(input, taskById(current, input.taskId));
      }
      const usage = currentWorkspaceUsage(database, current);
      if (usage.artifactCount >= current.quota.maxArtifacts || usage.byteCount + input.byteCount > current.quota.maxBytes) {
        fail("quota_exceeded", "workspace artifact quota exceeded");
      }
      if (listWorkspaceRows("agent_workspace_artifacts", current).some((candidate) => rowString(candidate, ["artifact_id"]) === artifactId || rowString(candidate, ["blob_digest"]) === input.blobDigest)) {
        fail("duplicate_id", "artifact reference is already attached");
      }
      const assertFence = (): void => {
        currentWorkspaceForMutation(current);
      };
      try {
        assertArtifactAttachable(database, {
          userId: current.userId,
          turnId: current.turnId,
          digest: input.blobDigest,
          byteCount: input.byteCount,
          mimeType: input.mimeType,
          assertFence,
          deletionFence,
          creatorToken: input.creatorToken,
        });
      } catch (error) {
        if (error instanceof TurnWorkspaceError) throw error;
        if (error instanceof ArtifactBlobError && error.code === "artifact_file_mismatch") fail("invalid_input", error.message);
        fail("not_found", error instanceof Error ? error.message : "artifact blob is not attachable");
      }
      const now = Math.floor(Date.now() / 1000);
      const policy = input.retention === undefined
        ? { retention: current.retention, expiresAt: current.expiresAt }
        : retentionValue(input.retention, input.ttlSeconds, now);
      insertRow(database, "agent_workspace_artifacts", {
        artifact_id: artifactId,
        workspace_id: current.workspaceId,
        turn_id: current.turnId,
        user_id: current.userId,
        chat_id: current.chatId,
        blob_digest: input.blobDigest,
        mime_type: input.mimeType,
        byte_count: input.byteCount,
        provenance_json: JSON.stringify(input.provenance),
        source_frame_id: input.frameId,
        source_task_id: input.taskId,
        publication_state: "attached",
        retention: policy.retention,
        revision: 0,
        expires_at: policy.expiresAt,
        created_at: now,
        updated_at: now,
      }, ["artifact_id", "workspace_id", "turn_id", "user_id", "chat_id", "blob_digest", "mime_type", "byte_count", "provenance_json", "publication_state", "retention", "expires_at"]);
      casWorkspace(current, {
        task_count: usage.taskCount,
        record_count: usage.recordCount,
        submission_count: usage.submissionCount,
        artifact_count: usage.artifactCount + 1,
        byte_count: usage.byteCount + input.byteCount,
        updated_at: now,
      });
    });
  });
  return artifactById(row, artifactId);
}
export function proposeWorkspacePublication(raw: unknown): WorkspaceArtifactReferenceV1 {
  const input = validateProposeWorkspacePublicationInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "propose_publication", raw);
  const artifact = artifactById(row, input.artifactId);
  if (artifact.publicationState === "published") return artifact;
  mutateWorkspace(row, () => {
    if (updateRow(getDb(), "agent_workspace_artifacts", { publication_state: "proposed", revision: artifact.revision + 1, updated_at: Math.floor(Date.now() / 1000) }, { artifact_id: artifact.id, workspace_id: row.workspaceId, turn_id: row.turnId, user_id: row.userId, chat_id: row.chatId, revision: artifact.revision }) !== 1) fail("stale_revision", "artifact revision is stale");
    casWorkspace(row, { updated_at: Math.floor(Date.now() / 1000) });
  });
  return artifactById(row, artifact.id);
}
export function publishWorkspaceArtifact(raw: unknown): WorkspaceArtifactReferenceV1 {
  const input = validatePublishWorkspaceArtifactInput(raw);
  const row = requireWorkspace(input);
  if (row.state !== "frozen") fail("forbidden", "workspace must be frozen before publication");
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root publish artifacts");
  const receiptId = input.receiptId;
  if (!receiptId) fail("forbidden", "a committed receipt is required for artifact publication");
  const database = getDb();
  if (!tableExists(database, "agent_turn_commit_receipts")) {
    fail("forbidden", "committed receipt storage is unavailable");
  }
  const receipt = database.query(
    "SELECT commit_key, message_id, swipe_id FROM agent_turn_commit_receipts WHERE receipt_id = ? AND state = 'committed' AND turn_id = ? AND execution_id = ? AND workspace_id = ? AND user_id = ? AND chat_id = ? LIMIT 1",
  ).get(receiptId, row.turnId, row.executionId, row.workspaceId, row.userId, row.chatId) as { commit_key?: unknown; message_id?: unknown; swipe_id?: unknown } | null;
  if (!receipt || typeof receipt.commit_key !== "string" || receipt.commit_key.length === 0) {
    fail("forbidden", "publication receipt is not valid for this workspace");
  }
  const messageId = input.messageId === undefined
    ? (receipt.message_id == null ? null : String(receipt.message_id))
    : input.messageId;
  const swipeId = input.swipeId === undefined
    ? (receipt.swipe_id == null ? null : Number(receipt.swipe_id))
    : input.swipeId;
  if ((receipt.message_id == null ? messageId !== null : messageId !== String(receipt.message_id))
    || (receipt.swipe_id == null ? swipeId !== null : swipeId !== Number(receipt.swipe_id))) {
    fail("forbidden", "publication target does not match its committed receipt");
  }
  const artifact = artifactById(row, input.artifactId);
  if (artifact.publicationState !== "published") fail("forbidden", "artifact publication must be performed by the canonical commit coordinator");
  return withArtifactDeletionFence(row.userId, artifact.blobDigest, (deletionFence) => {
    const creator = database.query(
      "SELECT creator_token FROM agent_artifact_blob_journal WHERE user_id = ? AND turn_id = ? AND blob_digest = ? AND state = 'installed' LIMIT 1",
    ).get(row.userId, row.turnId, artifact.blobDigest) as { creator_token?: unknown } | null;
    if (!creator || typeof creator.creator_token !== "string" || creator.creator_token.length === 0) {
      fail("forbidden", "published artifact creator proof is unavailable");
    }
    try {
      assertArtifactAttachable(database, {
        userId: row.userId,
        turnId: row.turnId,
        digest: artifact.blobDigest,
        byteCount: artifact.byteCount,
        mimeType: artifact.mimeType,
        assertFence: () => {
          const latest = findWorkspace(row.workspaceId, row.userId, row.chatId, row.turnId);
          if (!latest || latest.revision !== row.revision) fail("stale_revision", "workspace revision changed while checking artifact");
        },
        deletionFence,
        creatorToken: creator.creator_token,
      });
    } catch (error) {
      if (error instanceof TurnWorkspaceError) throw error;
      fail("forbidden", "published artifact bytes are unavailable");
    }
    const existing = database.query(
      "SELECT receipt_id, message_id, swipe_id FROM agent_published_workspace_artifacts WHERE user_id = ? AND chat_id = ? AND source_artifact_id = ? AND blob_digest = ? LIMIT 1",
    ).get(row.userId, row.chatId, artifact.id, artifact.blobDigest) as { receipt_id?: unknown; message_id?: unknown; swipe_id?: unknown } | null;
    if (!existing
      || String(existing.receipt_id) !== receiptId
      || (existing.message_id == null ? messageId !== null : String(existing.message_id) !== messageId)
      || (existing.swipe_id == null ? swipeId !== null : Number(existing.swipe_id) !== swipeId)) {
      fail("forbidden", "published artifact reference does not match its committed receipt");
    }
    return artifact;
    });
}
export function freezeTurnWorkspace(raw: unknown): WorkspaceSnapshotV1 {
  const input = contextValue(raw, true);
  const row = requireWritable(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root freeze workspaces");
  const next = mutateWorkspace(row, () => casWorkspace(row, { state: "frozen", frozen_at: Math.floor(Date.now() / 1000), updated_at: Math.floor(Date.now() / 1000) }));
  return getTurnWorkspace({ ...input, expectedRevision: next });
}
export function setWorkspaceCompletionMetadata(raw: unknown): WorkspaceSnapshotV1 {
  const input = validateWorkspaceCompletionMetadataInput(raw);
  const row = requireWorkspace(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root set completion metadata");
  if (row.state !== "frozen") fail("forbidden", "completion metadata requires a frozen workspace");
  const next = mutateWorkspace(row, () => {
    if (tableExists(getDb(), "agent_turn_executions")) updateRow(getDb(), "agent_turn_executions", { terminal_code: input.completionCode, updated_at: Math.floor(Date.now() / 1000) }, { id: row.executionId, user_id: row.userId, chat_id: row.chatId });
    casWorkspace(row, { updated_at: Math.floor(Date.now() / 1000) });
  }, true);
  return getTurnWorkspace({ ...input, expectedRevision: next });
}
function hasAcceptedSubmissionForTask(
  taskId: string,
  submissions: readonly WorkspaceSubmissionV1[],
): boolean {
  if (taskId.length === 0) return false;
  return submissions.some((submission) => submission.taskId === taskId && submission.state === "accepted");
}

function hasAcceptedSubmissionRow(
  taskId: string,
  submissions: readonly Record<string, unknown>[],
): boolean {
  if (taskId.length === 0) return false;
  return submissions.some((submission) =>
    rowString(submission, ["task_id"]) === taskId
    && rowString(submission, ["state"]) === "accepted"
  );
}

function taskCompletionAccepted(
  task: WorkspaceTaskV1,
  submissions: readonly WorkspaceSubmissionV1[],
): boolean {
  return task.state === "completed" && hasAcceptedSubmissionForTask(task.id, submissions);
}

function taskRowCompletionAccepted(
  task: Record<string, unknown>,
  submissions: readonly Record<string, unknown>[],
): boolean {
  return rowString(task, ["state"]) === "completed"
    && hasAcceptedSubmissionRow(rowString(task, ["task_id"]), submissions);
}

export function listRequiredOpenWorkspaceTasks(raw: unknown): readonly WorkspaceTaskV1[] {
  const input = contextValue(raw, true);
  const row = requireWorkspace(input);
  requireCapability(input, "read_section", raw);
  const submissions = listWorkspaceRows("agent_workspace_submissions", row).map(submissionFromRow);
  return listWorkspaceRows("agent_workspace_tasks", row)
    .map(taskFromRow)
    .filter((task) => task.required && !taskCompletionAccepted(task, submissions));
}
export interface WorkspaceTaskTransitionSnapshotV1 {
  readonly workspaceRevision: number;
  readonly taskTransitions: Readonly<Record<string, CognitionTaskTransition>>;
}

/**
 * Return only the canonical state of every turn-workspace task. Cognition
 * materializations are keyed by their stored authored template ID; ordinary
 * workspace tasks retain their operational ID. This is a host-authorized
 * predicate input, never a model-visible task inventory.
 */
export function listWorkspaceTaskTransitionsV1(raw: unknown): WorkspaceTaskTransitionSnapshotV1 {
  const input = contextValue(raw, true);
  const row = requireWorkspace(input);
  requireCapability(input, "read_section", raw);
  const taskRows = listWorkspaceRows("agent_workspace_tasks", row);
  if (taskRows.length > COGNITION_MAX_TASK_TRANSITIONS) {
    fail("quota_exceeded", "workspace task transition count exceeds the cognition limit");
  }
  const tasks = taskRows
    .map((candidate) => {
      const operationalId = rowString(candidate, ["task_id"]);
      return {
        id: cognitionTemplateTransitionId(row, candidate),
        operationalId,
        state: rowString(candidate, ["state"]),
      };
    })
    .sort((left, right) =>
      left.id < right.id ? -1
        : left.id > right.id ? 1
          : left.operationalId < right.operationalId ? -1
            : left.operationalId > right.operationalId ? 1
              : 0,
    );
  const taskTransitions: Record<string, CognitionTaskTransition> = Object.create(null);
  for (const task of tasks) {
    if (!task.id || Object.prototype.hasOwnProperty.call(taskTransitions, task.id)) {
      fail("invalid_state", "workspace task transition identifiers are invalid");
    }
    if (!STATES.has(task.state as WorkspaceTaskStateV1)) {
      fail("invalid_state", "workspace task transition state is invalid");
    }
    taskTransitions[task.id] = task.state as CognitionTaskTransition;
  }
  return deepFreeze({
    workspaceRevision: row.revision,
    taskTransitions,
  });
}

export function listWorkspaceTaskAcceptanceV1(raw: unknown): readonly WorkspaceTaskAcceptanceV1[] {
  const input = contextValue(raw, true);
  const row = requireWorkspace(input);
  const database = getDb();
  let items: WorkspaceTaskAcceptanceV1[] | undefined;
  database.transaction(() => {
    const current = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
    if (!current || current.revision !== row.revision) {
      fail("stale_revision", "workspace changed while reading task acceptance");
    }
    if (!tableExists(database, "agent_workspace_tasks")) {
      fail("schema_unavailable", "agent_workspace_tasks is unavailable");
    }
    const submissionsAvailable = tableExists(database, "agent_workspace_submissions");
    const taskTable = quoteIdentifier("agent_workspace_tasks");
    const submissionTable = quoteIdentifier("agent_workspace_submissions");
    const sql = submissionsAvailable
      ? `SELECT t.*, CASE WHEN t.state = 'completed' AND EXISTS (
           SELECT 1 FROM ${submissionTable} s
           WHERE s.workspace_id = t.workspace_id
             AND s.user_id = t.user_id
             AND s.chat_id = t.chat_id
             AND s.turn_id = t.turn_id
             AND s.task_id = t.task_id
             AND s.state = 'accepted'
         ) THEN 1 ELSE 0 END AS completion_accepted
         FROM ${taskTable} t
         WHERE t.workspace_id = ? AND t.user_id = ? AND t.chat_id = ? AND t.turn_id = ?`
      : `SELECT t.*, 0 AS completion_accepted
         FROM ${taskTable} t
         WHERE t.workspace_id = ? AND t.user_id = ? AND t.chat_id = ? AND t.turn_id = ?`;
    const taskRows = database.query(sql).all(
      current.workspaceId,
      current.userId,
      current.chatId,
      current.turnId,
    ) as Array<Record<string, unknown>>;
    items = taskRows.map((candidate) => {
      const task = taskFromRow(candidate);
      const rawTemplateId = candidate.cognition_template_id;
      const templateId = rawTemplateId === undefined || rawTemplateId === null
        ? null
        : cognitionTemplateTransitionId(current, candidate);
      return Object.freeze({
        id: task.id,
        templateId,
        required: task.required,
        state: task.state,
        completionAccepted: task.state === "completed" && Number(candidate.completion_accepted) === 1,
      });
    });
  })();
  if (!items) fail("stale_revision", "task acceptance snapshot did not complete");
  return Object.freeze(items);
}


function planWorkspaceCompletion(
  row: WorkspaceRow,
  tasks: readonly WorkspaceTaskV1[],
  submissions: readonly WorkspaceSubmissionV1[],
): WorkspaceCompletionGatesV1 {
  const open = tasks.filter((task) => task.required && !taskCompletionAccepted(task, submissions));
  const pending = submissions.filter((submission) => submission.state === "submitted");
  return Object.freeze({
    workspaceRevision: row.revision,
    accepted: row.state !== "expired" && open.length === 0 && pending.length === 0,
    requiredTaskCount: tasks.filter((task) => task.required).length,
    openRequiredTaskIds: Object.freeze(open.map((task) => task.id)),
    pendingSubmissionCount: pending.length,
  });
}

export function getWorkspaceCompletionGatesV1(raw: unknown): WorkspaceCompletionGatesV1 {
  const input = contextValue(raw, true);
  const row = requireWorkspace(input);
  const database = getDb();
  let gates: WorkspaceCompletionGatesV1 | undefined;
  database.transaction(() => {
    const current = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
    if (!current || current.revision !== row.revision) fail("stale_revision", "workspace changed while reading completion gates");
    gates = planWorkspaceCompletion(
      current,
      listWorkspaceRows("agent_workspace_tasks", current).map(taskFromRow),
      listWorkspaceRows("agent_workspace_submissions", current).map(submissionFromRow),
    );
  })();
  if (!gates) fail("stale_revision", "completion gate snapshot did not complete");
  return gates;
}

export function previewWorkspaceForCompletionV1(raw: unknown): WorkspaceCompletionPreviewV1 {
  const input = contextValue(raw, true);
  const row = requireWorkspace(input);
  const database = getDb();
  let result: WorkspaceCompletionPreviewV1 | undefined;
  database.transaction(() => {
    const current = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
    if (!current || current.revision !== row.revision) fail("stale_revision", "workspace changed before completion preview");
    const gates = planWorkspaceCompletion(
      current,
      listWorkspaceRows("agent_workspace_tasks", current).map(taskFromRow),
      listWorkspaceRows("agent_workspace_submissions", current).map(submissionFromRow),
    );
    result = Object.freeze({
      accepted: gates.accepted,
      workspaceRevision: gates.accepted ? current.revision + 1 : current.revision,
    });
  })();
  if (!result) fail("stale_revision", "completion preview transaction did not complete");
  return result;
}

export function freezeWorkspaceForCompletionV1(
  raw: unknown,
  preparedAcceptance?: WorkspaceCompletionPreparedAcceptanceV1,
): WorkspaceCompletionPreviewV1 {
  const input = contextValue(raw, true);
  const row = requireWritable(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root freeze workspaces");
  const database = getDb();
  let result: WorkspaceCompletionPreviewV1 | undefined;
  withWritableWorkspaceTransaction(row, (current) => {
    const gates = planWorkspaceCompletion(
      current,
      listWorkspaceRows("agent_workspace_tasks", current).map(taskFromRow),
      listWorkspaceRows("agent_workspace_submissions", current).map(submissionFromRow),
    );
    const candidate = Object.freeze({
      accepted: gates.accepted,
      workspaceRevision: gates.accepted ? current.revision + 1 : current.revision,
    });
    if (preparedAcceptance) {
      try {
        if (preparedAcceptance.prepare(candidate) !== true) {
          fail("completion_preparation_failed", "Completion handoff was not acknowledged");
        }
      } catch (error) {
        if (error instanceof TurnWorkspaceError) throw error;
        fail("completion_preparation_failed", "Completion handoff preparation failed");
      }
    }
    if (!candidate.accepted) {
      result = candidate;
      return;
    }
    currentWorkspaceForMutation(current);
    const now = Math.floor(Date.now() / 1000);
    if (updateRow(database, "agent_turn_workspaces", {
      state: "frozen",
      frozen_at: now,
      revision: candidate.workspaceRevision,
      updated_at: now,
    }, {
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      execution_id: current.executionId,
      user_id: current.userId,
      chat_id: current.chatId,
      revision: current.revision,
    }) !== 1) fail("stale_revision", "workspace changed during completion freeze");
    result = candidate;
  });
  if (!result) fail("stale_revision", "completion freeze transaction did not complete");
  return result;
}
function cognitionTaskState(transition: CognitionTaskTransition): WorkspaceTaskStateV1 {
  if ((WORKSPACE_TASK_STATES as readonly string[]).includes(transition)) return transition;
  fail("invalid_state", "cognition progress state is invalid");
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function requireCognitionTemplateMetadata(database: Database): void {
  if (!tableColumns(database, "agent_workspace_tasks").has("cognition_template_id")) {
    fail("schema_unavailable", "agent_workspace_tasks.cognition_template_id is unavailable");
  }
}


export interface CognitionMaterializationPlanV1 {
  readonly templates: readonly TaskTemplateV1[];
  readonly ids: readonly string[];
  readonly taskCount: number;
  readonly byteCount: number;
}
function planCognitionTemplates(
  row: WorkspaceRow,
  templates: readonly TaskTemplateV1[],
  rows: readonly Record<string, unknown>[],
): CognitionMaterializationPlanV1 {
  const database = getDb();
  if (templates.length > 0) requireCognitionTemplateMetadata(database);
  const usage = currentWorkspaceUsage(database, row);
  const existing = new Map(rows.map((candidate) => [rowString(candidate, ["task_id"]), candidate] as const));
  const inserted: TaskTemplateV1[] = [];
  let bytesAdded = 0;
  for (const template of templates) {
    const templateId = idValue(template.id, "cognition.templateId");
    const authoredCollision = existing.get(templateId);
    if (authoredCollision) {
      fail("duplicate_id", `cognition template ${templateId} conflicts with an existing workspace task`);
    }
    const taskId = cognitionTemplateTaskId(row, templateId);
    const provenanceCollision = rows.find((candidate) =>
      candidate.cognition_template_id === templateId
      && rowString(candidate, ["task_id"]) !== taskId,
    );
    if (provenanceCollision) {
      fail("duplicate_id", `cognition template ${templateId} conflicts with an existing workspace task`);
    }
    const dependencyIds = Object.freeze((template.dependencies ?? []).map((dependency, index) =>
      cognitionTemplateTaskId(row, idValue(dependency, `cognition.dependencies[${index}]`)),
    ));
    const title = template.label ?? taskId;
    const objective = template.description ?? title;
    const previous = existing.get(taskId);
    if (previous) {
      if (previous.cognition_template_id !== templateId) {
        fail("duplicate_id", `cognition task ${taskId} conflicts with an existing workspace task`);
      }
      const previousTitle = rowString(previous, ["title"]);
      const previousDescription = rowString(previous, ["description"]);
      const previousDependencies = jsonArray(previous.dependencies_json);
      if (
        rowNumber(previous, ["required"]) !== (template.required ? 1 : 0)
        || previousTitle !== title
        || previousDescription !== objective
        || !sameIds(previousDependencies, dependencyIds)
      ) {
        fail("duplicate_id", `cognition task ${taskId} conflicts with an existing workspace task`);
      }
      continue;
    }
    const dependencyJson = JSON.stringify(dependencyIds);
    const byteCount = utf8ByteLength(title) + utf8ByteLength(objective) + utf8ByteLength(dependencyJson);
    if (usage.taskCount + inserted.length + 1 > row.quota.maxTasks) fail("quota_exceeded", "cognition task quota exceeded");
    if (usage.byteCount + bytesAdded + byteCount > row.quota.maxBytes) fail("quota_exceeded", "cognition task byte quota exceeded");
    inserted.push(template);
    existing.set(taskId, { task_id: taskId, cognition_template_id: templateId, required: template.required ? 1 : 0, title, description: objective, dependencies_json: dependencyJson });
    bytesAdded += byteCount;
  }
  return Object.freeze({
    templates: Object.freeze([...inserted]),
    ids: Object.freeze(inserted.map((template) => cognitionTemplateTaskId(row, idValue(template.id, "cognition.templateId")))),
    taskCount: inserted.length,
    byteCount: bytesAdded,
  });
}

function materializeCognitionTemplates(
  database: Database,
  row: WorkspaceRow,
  templates: readonly TaskTemplateV1[],
  now: number,
  planned?: CognitionMaterializationPlanV1,
): CognitionMaterializationPlanV1 {
  if (templates.length > 0) requireCognitionTemplateMetadata(database);
  const plan = planned ?? planCognitionTemplates(
    row,
    templates,
    listWorkspaceRows("agent_workspace_tasks", row),
  );
  if (!sameIds(plan.ids, planCognitionTemplates(row, templates, listWorkspaceRows("agent_workspace_tasks", row)).ids)) {
    fail("stale_revision", "cognition task materialization plan changed before commit");
  }
  for (const template of plan.templates) {
    const templateId = idValue(template.id, "cognition.templateId");
    const taskId = cognitionTemplateTaskId(row, templateId);
    const dependencyIds = Object.freeze((template.dependencies ?? []).map((dependency, index) =>
      cognitionTemplateTaskId(row, idValue(dependency, `cognition.dependencies[${index}]`)),
    ));
    const title = template.label ?? taskId;
    const objective = template.description ?? title;
    insertRow(database, "agent_workspace_tasks", {
      task_id: taskId,
      cognition_template_id: templateId,
      workspace_id: row.workspaceId,
      turn_id: row.turnId,
      user_id: row.userId,
      chat_id: row.chatId,
      title,
      description: objective,
      state: "active",
      required: template.required ? 1 : 0,
      dependencies_json: JSON.stringify(dependencyIds),
      assigned_frame_id: null,
      progress: 0,
      summary: null,
      byte_count: utf8ByteLength(title) + utf8ByteLength(objective) + utf8ByteLength(JSON.stringify(dependencyIds)),
      revision: 0,
      cas_owner: null,
      cas_expires_at: null,
      retention: row.retention,
      expires_at: row.expiresAt,
      created_at: now,
      updated_at: now,
    }, ["task_id", "cognition_template_id", "workspace_id", "turn_id", "user_id", "chat_id", "title", "description", "retention", "expires_at"]);
  }
  return plan;
}

function persistCognitionWorkspaceReceipt(
  database: Database,
  row: WorkspaceRow,
  update: CognitionWorkspaceActivationUpdateV1,
  reservation: AgenticWorkWorkspaceMutationReservationV1,
  nextRevision: number,
  now: number,
): TurnWorkspaceMutationReceiptV1 {
  requireWorkspaceMutationOriginV1(database, row.userId, row.executionId, reservation);
  const operationDigest = createHash("sha256").update(encodeCanonicalPlainData({
    version: 1,
    executionId: row.executionId,
    workspaceId: row.workspaceId,
    operationKey: reservation.operationKey,
    operationKind: reservation.operationKind,
    segmentId: reservation.segmentId,
    logicalDispatch: reservation.logicalDispatch,
    frameId: reservation.frameId,
    taskId: update.taskId,
    transition: update.transition,
    state: update.state,
    activation: update.activation,
    materializeTemplates: update.materializeTemplates,
    workspaceRevisionBefore: row.revision,
    workspaceRevisionAfter: nextRevision,
  }), "utf8").digest("hex");
  const existing = database.query("SELECT workspace_id, segment_id, logical_dispatch, frame_id, operation_digest, before_workspace_revision, after_workspace_revision FROM agent_work_workspace_receipts WHERE user_id = ? AND execution_id = ? AND operation_key = ?")
    .get(row.userId, row.executionId, reservation.operationKey) as Record<string, unknown> | null;
  if (existing) {
    const receipt = workspaceMutationReceiptV1(existing, reservation);
    const exact = existing.workspace_id === row.workspaceId
      && receipt.operationDigest === operationDigest
      && receipt.beforeWorkspaceRevision === row.revision
      && receipt.afterWorkspaceRevision === nextRevision;
    if (!exact) fail("invalid_state", "workspace operation identity is already bound to another mutation");
    return receipt;
  }
  insertRow(database, "agent_work_workspace_receipts", {
    user_id: row.userId,
    execution_id: row.executionId,
    workspace_id: row.workspaceId,
    segment_id: reservation.segmentId,
    logical_dispatch: reservation.logicalDispatch,
    frame_id: reservation.frameId,
    operation_key: reservation.operationKey,
    operation_digest: operationDigest,
    before_workspace_revision: row.revision,
    after_workspace_revision: nextRevision,
    settled_at: now,
  }, ["user_id", "execution_id", "workspace_id", "segment_id", "logical_dispatch", "frame_id", "operation_key", "operation_digest"]);
  return Object.freeze({
    operationKey: reservation.operationKey,
    segmentId: reservation.segmentId,
    logicalDispatch: reservation.logicalDispatch,
    frameId: reservation.frameId,
    operationDigest,
    beforeWorkspaceRevision: row.revision,
    afterWorkspaceRevision: nextRevision,
  });
}

function requireCognitionWorkspaceReceipt(
  database: Database,
  row: WorkspaceRow,
  rawReservation: AgenticWorkWorkspaceMutationReservationV1,
): TurnWorkspaceMutationReceiptV1 {
  const reservation = workspaceMutationReservationV1(rawReservation);
  requireWorkspaceMutationOriginV1(database, row.userId, row.executionId, reservation);
  const raw = database.query("SELECT workspace_id, segment_id, logical_dispatch, frame_id, operation_digest, before_workspace_revision, after_workspace_revision FROM agent_work_workspace_receipts WHERE user_id = ? AND execution_id = ? AND operation_key = ?")
    .get(row.userId, row.executionId, reservation.operationKey) as Record<string, unknown> | null;
  if (!raw || raw.workspace_id !== row.workspaceId) {
    fail("invalid_state", "committed cognition mutation has no exact durable workspace receipt");
  }
  const receipt = workspaceMutationReceiptV1(raw, reservation);
  if (receipt.afterWorkspaceRevision !== row.revision || !/^[0-9a-f]{64}$/.test(receipt.operationDigest)) {
    fail("invalid_state", "committed cognition mutation has no exact durable workspace receipt");
  }
  return receipt;
}

function cognitionWorkspaceReceiptFields(
  receipt: TurnWorkspaceMutationReceiptV1,
): Pick<CognitionWorkspaceCommitResultV1, "operationKey" | "segmentId" | "logicalDispatch" | "frameId" | "operationDigest"> {
  return Object.freeze({
    operationKey: receipt.operationKey,
    segmentId: receipt.segmentId,
    logicalDispatch: receipt.logicalDispatch,
    frameId: receipt.frameId,
    operationDigest: receipt.operationDigest,
  });
}
function cognitionMutationReservationV1(
  update: CognitionWorkspaceActivationUpdateV1,
  expectedFrameId: string | undefined,
  expectedOperationKind: AgenticWorkWorkspaceMutationReservationV1["operationKind"],
): AgenticWorkWorkspaceMutationReservationV1 {
  const reservation = workspaceMutationReservationV1(update.reservation);
  if (!expectedFrameId || reservation.frameId !== expectedFrameId) {
    fail("invalid_input", "cognition mutation reservation frame does not match the authenticated mutation frame");
  }
  if (reservation.operationKind !== expectedOperationKind) {
    fail("invalid_input", "cognition mutation reservation does not match the authenticated operation");
  }
  return reservation;
}

function cognitionUpdateValues(
  row: WorkspaceRow,
  update: CognitionWorkspaceActivationUpdateV1,
  now: number,
  expectedFrameId: string | undefined,
  expectedOperationKind: AgenticWorkWorkspaceMutationReservationV1["operationKind"],
): { readonly state: CognitionActivationStateV1; readonly materializedTaskIds: readonly string[]; readonly revision: number; readonly receipt: TurnWorkspaceMutationReceiptV1 } {
  if (update.state.workspaceRevision !== row.revision + 1) fail("stale_revision", "cognition activation revision does not match workspace CAS");
  if (update.activation.state.workspaceRevision !== row.revision) fail("stale_revision", "cognition activation observed a stale workspace revision");
  const reservation = cognitionMutationReservationV1(update, expectedFrameId, expectedOperationKind);
  const database = getDb();
  const usage = currentWorkspaceUsage(database, row);
  const materialized = materializeCognitionTemplates(database, row, update.materializeTemplates, now);
  const nextRevision = row.revision + 1;
  const changed = updateRow(database, "agent_turn_workspaces", {
    task_count: usage.taskCount + materialized.taskCount,
    record_count: usage.recordCount,
    submission_count: usage.submissionCount,
    artifact_count: usage.artifactCount,
    byte_count: usage.byteCount + materialized.byteCount,
    revision: nextRevision,
    updated_at: now,
  }, {
    workspace_id: row.workspaceId,
    turn_id: row.turnId,
    execution_id: row.executionId,
    user_id: row.userId,
    chat_id: row.chatId,
    revision: row.revision,
  });
  if (changed !== 1) fail("stale_revision", "workspace revision changed during cognition activation");
  const receipt = persistCognitionWorkspaceReceipt(database, row, update, reservation, nextRevision, now);
  return Object.freeze({ state: update.state, materializedTaskIds: materialized.ids, revision: nextRevision, receipt });
}

function requireCognitionWorkspaceUpdate(
  row: WorkspaceRow,
  update: CognitionWorkspaceActivationUpdateV1,
): void {
  if (update.taskId.length === 0 || update.transition.length === 0) fail("invalid_input", "cognition transition is incomplete");
  if (update.activation.state.workspaceRevision !== row.revision) fail("stale_revision", "cognition activation observed a stale workspace revision");
}

function cognitionActivationUpdate(
  row: WorkspaceRow,
  factory: CognitionWorkspaceActivationFactoryV1,
): CognitionWorkspaceActivationUpdateV1 {
  if (factory.state.workspaceRevision !== row.revision) fail("stale_revision", "cognition factory state is stale for workspace CAS");
  return factory.update(factory.state);
}

/**
 * Persist a phase-entry cognition activation under the workspace owner/revision
 * fence. The factory is pure; no runtime state is published until this
 * transaction commits.
 */
export function activateWorkspaceCognitionAtPhase(
  raw: unknown,
  factory: CognitionWorkspacePhaseFactoryV1,
): CognitionWorkspacePhaseResultV1 {
  const input = contextValue(raw, true);
  const row = requireWritable(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root activate cognition phases");
  if (factory.state.workspaceRevision !== row.revision) fail("stale_revision", "cognition phase state is stale for workspace CAS");
  const database = getDb();
  let result: CognitionWorkspacePhaseResultV1 | undefined;
  withWritableWorkspaceTransaction(row, (current) => {
    const update = factory.update(factory.state);
    const now = Math.floor(Date.now() / 1000);
    const usage = currentWorkspaceUsage(database, current);
    const materialized = materializeCognitionTemplates(database, current, update.materializeTemplates, now);
    const nextRevision = current.revision + 1;
    const changed = updateRow(database, "agent_turn_workspaces", {
      task_count: usage.taskCount + materialized.taskCount,
      record_count: usage.recordCount,
      submission_count: usage.submissionCount,
      artifact_count: usage.artifactCount,
      byte_count: usage.byteCount + materialized.byteCount,
      revision: nextRevision,
      updated_at: now,
    }, {
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      execution_id: current.executionId,
      user_id: current.userId,
      chat_id: current.chatId,
      revision: current.revision,
    });
    if (changed !== 1) fail("stale_revision", "workspace revision changed during cognition phase activation");
    result = Object.freeze({
      workspaceRevision: nextRevision,
      state: update.state,
      activation: update.activation,
      materializedTaskIds: materialized.ids,
    });
  });
  if (!result) fail("stale_revision", "cognition phase activation transaction did not commit");
  return result;
}

function cognitionCompletionUpdate(
  row: WorkspaceRow,
  factory: CognitionWorkspaceCompletionFactoryV1,
): CognitionWorkspaceCompletionUpdateV1 {
  if (factory.state.workspaceRevision !== row.revision) fail("stale_revision", "cognition completion factory state is stale for workspace CAS");
  return factory.update(factory.state);
}

export interface CognitionWorkspaceCompletionPreviewV1 {
  readonly candidate: CognitionWorkspaceCompletionResultV1;
  readonly materialization: CognitionMaterializationPlanV1;
}

function planCognitionCompletion(
  row: WorkspaceRow,
  update: CognitionWorkspaceCompletionUpdateV1,
  tasks: readonly Record<string, unknown>[],
  submissions: readonly Record<string, unknown>[],
): CognitionWorkspaceCompletionPreviewV1 {
  const materialization = planCognitionTemplates(row, update.materializeTemplates, tasks);
  const taskRows = [
    ...tasks,
    ...materialization.templates.map((template) => ({
      task_id: cognitionTemplateTaskId(row, idValue(template.id, "cognition.templateId")),
      required: template.required ? 1 : 0,
      state: "active",
    })),
  ];
  const openRequiredTaskIds = taskRows
    .filter((task) => rowNumber(task, ["required"]) === 1 && !taskRowCompletionAccepted(task, submissions))
    .map((task) => rowString(task, ["task_id"]))
    .sort();
  const pendingSubmissions = submissions.filter((submission) => rowString(submission, ["state"]) === "submitted");
  const blockingRequiredTaskIds = Object.freeze([...new Set([...openRequiredTaskIds, ...update.blockingRequiredTaskIds])]);
  const accepted = update.accepted && blockingRequiredTaskIds.length === 0 && pendingSubmissions.length === 0;
  const nextRevision = row.revision + 1;
  return Object.freeze({
    materialization,
    candidate: Object.freeze({
      workspaceRevision: nextRevision,
      state: Object.freeze({ ...update.state, workspaceRevision: nextRevision }),
      activation: update.activation,
      accepted,
      blockingRequiredTaskIds,
      materializedTaskIds: materialization.ids,
    }),
  });
}

/**
 * Read-only completion preview. It uses the same materialization/gate planner
 * as the committing freeze path and performs no workspace mutation.
 */
export function previewWorkspaceCompletionWithCognition(
  raw: unknown,
  factory: CognitionWorkspaceCompletionFactoryV1,
): CognitionWorkspaceCompletionPreviewV1 {
  const input = contextValue(raw, true);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root preview workspaces");
  const database = getDb();
  let preview: CognitionWorkspaceCompletionPreviewV1 | undefined;
  database.transaction(() => {
    const current = findWorkspace(input.workspaceId, input.userId, input.chatId, input.turnId);
    if (!current || current.revision !== input.expectedRevision) fail("stale_revision", "workspace revision changed before cognition completion preview");
    const update = cognitionCompletionUpdate(current, factory);
    preview = planCognitionCompletion(
      current,
      update,
      listWorkspaceRows("agent_workspace_tasks", current),
      listWorkspaceRows("agent_workspace_submissions", current),
    );
  })();
  if (!preview) fail("stale_revision", "cognition completion preview did not complete");
  return preview;
}

export interface CognitionWorkspacePreparedAcceptanceV1 {
  /**
   * Build the private handoff from the exact transaction candidate. This runs
   * synchronously after cognition task materialization and before updateRow.
   */
  readonly prepare: (
    candidate: CognitionWorkspaceCompletionResultV1,
  ) => {
    readonly candidate: CognitionWorkspaceCompletionResultV1;
    readonly bundle: unknown;
  };
}

function freezePreparedValue<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) value.forEach((entry) => freezePreparedValue(entry));
    else Object.values(value as Record<string, unknown>).forEach((entry) => freezePreparedValue(entry));
    Object.freeze(value);
  }
  return value;
}

function clonePreparedValue<T>(value: T): T {
  try {
    return freezePreparedValue(structuredClone(value));
  } catch {
    fail("completion_preparation_failed", "Completion handoff bundle is not cloneable");
  }
}


export function createWorkspaceTaskWithCognition(
  raw: unknown,
  factory: CognitionWorkspaceActivationFactoryV1,
): CognitionWorkspaceCommitResultV1 {
  const input = validateCreateWorkspaceTaskRuntimeInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "create_task", raw);
  if (input.actor === "child") fail("forbidden", "children cannot create tasks");
  const now = Math.floor(Date.now() / 1000);
  const policy = input.retention === undefined ? { retention: row.retention, expiresAt: row.expiresAt } : retentionValue(input.retention, input.ttlSeconds, now);
  const objective = input.objective ?? input.title;
  const byteCount = utf8ByteLength(input.title) + utf8ByteLength(objective) + utf8ByteLength(JSON.stringify(input.dependencyIds));
  const database = getDb();
  let result: CognitionWorkspaceCommitResultV1 | undefined;
  withWritableWorkspaceTransaction(row, (current) => {
    const taskId = allocateWritableTaskId(current, input.taskId);
    assertAcyclic(current, taskId, input.dependencyIds);
    const usage = currentWorkspaceUsage(database, current);
    if (usage.taskCount >= current.quota.maxTasks) {
      fail("quota_exceeded", "task quota exceeded", { limit: current.quota.maxTasks, observed: usage.taskCount + 1 });
    }
    if (usage.byteCount + byteCount > current.quota.maxBytes) fail("quota_exceeded", "workspace byte quota exceeded");
    insertWorkspaceTaskRow(database, {
      task_id: taskId,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      title: input.title,
      description: objective,
      state: "active",
      required: input.hostRequired ? 1 : 0,
      dependencies_json: JSON.stringify(input.dependencyIds),
      assigned_frame_id: input.assignedFrameId,
      progress: 0,
      summary: null,
      byte_count: byteCount,
      revision: 0,
      cas_owner: null,
      cas_expires_at: null,
      retention: policy.retention,
      expires_at: policy.expiresAt,
      created_at: now,
      updated_at: now,
    });
    const update = cognitionActivationUpdate(current, factory);
    const committed = cognitionUpdateValues(current, update, now, input.frameId, "create_task");
    result = Object.freeze({
      workspaceRevision: committed.revision,
      state: committed.state,
      activation: update.activation,
      materializedTaskIds: committed.materializedTaskIds,
      taskId,
      transition: update.transition,
      ...cognitionWorkspaceReceiptFields(committed.receipt),
    });
  });
  if (!result) fail("stale_revision", "cognition task creation transaction did not commit");
  return result;
}

export function updateWorkspaceTaskProgressWithCognition(
  raw: unknown,
  factory: CognitionWorkspaceActivationFactoryV1,
): CognitionWorkspaceCommitResultV1 {
  const input = validateUpdateWorkspaceTaskProgressInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "update_assigned_progress", raw);
  const task = taskById(row, input.taskId);
  assertAssignedChild(input, task);
  if (task.state === "completed" || task.state === "cancelled" || task.state === "failed") {
    fail("task_assignment_conflict", "terminal task cannot receive progress updates");
  }
  const database = getDb();
  let result: CognitionWorkspaceCommitResultV1 | undefined;
  withWritableWorkspaceTransaction(row, (current) => {
    const currentTask = taskById(current, task.id);
    assertAssignedChild(input, currentTask);
    if (currentTask.state === "completed" || currentTask.state === "cancelled" || currentTask.state === "failed") {
      fail("task_assignment_conflict", "terminal task cannot receive progress updates");
    }
    if (current.revision !== row.revision) fail("stale_revision", "workspace revision changed before cognition transition");
    if (currentTask.revision !== task.revision) fail("stale_revision", "task revision is stale");
    const now = Math.floor(Date.now() / 1000);
    const update = cognitionActivationUpdate(current, factory);
    if (update.taskId !== currentTask.id) fail("invalid_input", "cognition transition task does not match persisted task");
    requireCognitionWorkspaceUpdate(current, update);
    const nextTaskState = cognitionTaskState(update.transition);
    if (updateRow(database, "agent_workspace_tasks", {
      state: nextTaskState,
      progress: input.progress ?? currentTask.progress,
      revision: currentTask.revision + 1,
      updated_at: now,
    }, {
      task_id: currentTask.id,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      revision: currentTask.revision,
    }) !== 1) fail("stale_revision", "task revision changed before cognition transition");
    const committed = cognitionUpdateValues(current, update, now, input.frameId, "update_assigned_progress");
    result = Object.freeze({
      workspaceRevision: committed.revision,
      state: committed.state,
      activation: update.activation,
      materializedTaskIds: committed.materializedTaskIds,
      taskId: update.taskId,
      transition: update.transition,
      ...cognitionWorkspaceReceiptFields(committed.receipt),
    });
  });
  if (!result) fail("stale_revision", "cognition workspace transaction did not commit");
  return result;
}

export function submitWorkspaceChildResultWithCognition(
  raw: unknown,
  factory: CognitionWorkspaceActivationFactoryV1,
): CognitionWorkspaceCommitResultV1 {
  const input = validateSubmitWorkspaceChildResultInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "submit_child_result", raw);
  const task = taskById(row, input.taskId);
  assertAssignedChild(input, task);
  if (task.state === "completed" || task.state === "cancelled" || task.state === "failed") {
    if (
      task.state === "completed"
      && listWorkspaceRows("agent_workspace_submissions", row).some((candidate) => rowString(candidate, ["task_id"]) === task.id)
    ) {
      fail("submission_rejected", "task already has a submitted result");
    }
    fail("task_assignment_conflict", "terminal task cannot receive a child result");
  }
  const submissionBytes = input.byteCount + utf8ByteLength(input.summary);
  const database = getDb();
  let result: CognitionWorkspaceCommitResultV1 | undefined;
  withWritableWorkspaceTransaction(row, (current) => {
    const currentTask = taskById(current, task.id);
    if (currentTask.revision !== task.revision) fail("stale_revision", "task revision is stale");
    assertAssignedChild(input, currentTask);
    if (currentTask.state === "completed" || currentTask.state === "cancelled" || currentTask.state === "failed") {
      if (
        currentTask.state === "completed"
        && listWorkspaceRows("agent_workspace_submissions", current).some((candidate) => rowString(candidate, ["task_id"]) === currentTask.id)
      ) {
        fail("submission_rejected", "task already has a submitted result");
      }
      fail("task_assignment_conflict", "terminal task cannot receive a child result");
    }
    const usage = currentWorkspaceUsage(database, current);
    if (usage.submissionCount >= current.quota.maxSubmissions || usage.byteCount + submissionBytes > current.quota.maxBytes) {
      fail("quota_exceeded", "submission quota exceeded");
    }
    const now = Math.floor(Date.now() / 1000);
    const policy = input.retention === undefined ? { retention: current.retention, expiresAt: current.expiresAt } : retentionValue(input.retention, input.ttlSeconds, now);
    insertRow(database, "agent_workspace_submissions", {
      submission_id: crypto.randomUUID(),
      task_id: task.id,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      child_frame_id: input.frameId,
      state: "submitted",
      summary: input.summary,
      result_digest: input.resultDigest,
      byte_count: submissionBytes,
      revision: 0,
      retention: policy.retention,
      expires_at: policy.expiresAt,
      created_at: now,
      updated_at: now,
    }, ["submission_id", "task_id", "workspace_id", "turn_id", "user_id", "chat_id", "child_frame_id", "state", "summary", "result_digest", "byte_count", "retention", "expires_at"]);
    if (updateRow(database, "agent_workspace_tasks", { state: "completed", progress: 1, revision: task.revision + 1, updated_at: now }, { task_id: task.id, workspace_id: current.workspaceId, turn_id: current.turnId, user_id: current.userId, chat_id: current.chatId, revision: task.revision }) !== 1) fail("stale_revision", "task revision changed before cognition submission");
    const update = cognitionActivationUpdate(current, factory);
    if (update.taskId !== task.id) fail("invalid_input", "cognition submission task does not match persisted task");
    requireCognitionWorkspaceUpdate(current, update);
    const committed = cognitionUpdateValues(current, update, now, input.frameId, "submit_child_result");
    result = Object.freeze({
      workspaceRevision: committed.revision,
      state: committed.state,
      activation: update.activation,
      materializedTaskIds: committed.materializedTaskIds,
      taskId: update.taskId,
      transition: update.transition,
      ...cognitionWorkspaceReceiptFields(committed.receipt),
    });
  });
  if (!result) fail("stale_revision", "cognition submission transaction did not commit");
  return result;
}
export function submitWorkspaceRootResultWithCognition(
  raw: unknown,
  factory: CognitionWorkspaceActivationFactoryV1,
): CognitionWorkspaceCommitResultV1 {
  const input = validateSubmitWorkspaceRootResultInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "submit_root_result", raw);
  const database = getDb();
  const task = taskById(row, input.taskId);
  if (task.assignedFrameId !== null) fail("child_confinement", "root may not settle a child-assigned task");
  const existingSubmission = listWorkspaceRows("agent_workspace_submissions", row)
    .find((candidate) => rowString(candidate, ["task_id"]) === task.id);
  if (task.state === "completed" || task.state === "cancelled" || task.state === "failed") {
    if (!rootCognitionResultMatches(row, task, existingSubmission ? submissionFromRow(existingSubmission) : undefined, input)) {
      fail("task_assignment_conflict", "terminal task cannot receive a different root result");
    }
    const update = cognitionActivationUpdate(row, factory);
    if (update.taskId !== task.id) fail("invalid_input", "cognition root replay task does not match persisted task");
    if (update.transition !== input.state) fail("invalid_state", "cognition root replay transition does not match persisted task");
    const reservation = cognitionMutationReservationV1(update, input.frameId, "submit_root_result");
    if (taskOperationKey(row, task.id) !== reservation.operationKey) {
      fail("task_assignment_conflict", "terminal cognition root operation key does not match the committed result");
    }
    requireCognitionWorkspaceUpdate(row, update);
    const receipt = requireCognitionWorkspaceReceipt(database, row, reservation);
    return Object.freeze({
      workspaceRevision: row.revision,
      state: factory.state,
      activation: update.activation,
      materializedTaskIds: Object.freeze([]),
      taskId: update.taskId,
      transition: update.transition,
      ...cognitionWorkspaceReceiptFields(receipt),
    });
  }
  const submissionBytes = input.state === "completed" ? utf8ByteLength(input.summary) : 0;
  let result: CognitionWorkspaceCommitResultV1 | undefined;
  withWritableWorkspaceTransaction(row, (current) => {
    const currentTask = taskById(current, task.id);
    if (currentTask.assignedFrameId !== null) fail("child_confinement", "root may not settle a child-assigned task");
    const currentSubmission = listWorkspaceRows("agent_workspace_submissions", current)
      .find((candidate) => rowString(candidate, ["task_id"]) === currentTask.id);
    if (currentTask.state === "completed" || currentTask.state === "cancelled" || currentTask.state === "failed") {
      if (!rootCognitionResultMatches(current, currentTask, currentSubmission ? submissionFromRow(currentSubmission) : undefined, input)) {
        fail("task_assignment_conflict", "terminal task cannot receive a different root result");
      }
      const replay = cognitionActivationUpdate(current, factory);
      if (replay.taskId !== currentTask.id) fail("invalid_input", "cognition root replay task does not match persisted task");
      if (replay.transition !== input.state) fail("invalid_state", "cognition root replay transition does not match persisted task");
      const replayReservation = cognitionMutationReservationV1(replay, input.frameId, "submit_root_result");
      if (taskOperationKey(current, currentTask.id) !== replayReservation.operationKey) {
        fail("task_assignment_conflict", "terminal cognition root operation key does not match the committed result");
      }
      requireCognitionWorkspaceUpdate(current, replay);
      const receipt = requireCognitionWorkspaceReceipt(database, current, replayReservation);
      result = Object.freeze({
        workspaceRevision: current.revision,
        state: factory.state,
        activation: replay.activation,
        materializedTaskIds: Object.freeze([]),
        taskId: replay.taskId,
        transition: replay.transition,
        ...cognitionWorkspaceReceiptFields(receipt),
      });
      return;
    }
    if (currentTask.revision !== task.revision) fail("stale_revision", "task revision is stale");
    if (currentSubmission) fail("submission_rejected", "task already has a submitted result");
    const update = cognitionActivationUpdate(current, factory);
    if (update.taskId !== currentTask.id) fail("invalid_input", "cognition root result task does not match persisted task");
    if (update.transition !== input.state) fail("invalid_state", "cognition root result transition does not match requested state");
    const reservation = cognitionMutationReservationV1(update, input.frameId, "submit_root_result");
    requireCognitionWorkspaceUpdate(current, update);
    const previousOperationKey = taskOperationKey(current, currentTask.id);
    if (previousOperationKey !== null && previousOperationKey !== reservation.operationKey) {
      fail("task_assignment_conflict", "cognition root operation identity is already committed");
    }
    const now = Math.floor(Date.now() / 1000);
    if (input.state === "failed") {
      const usage = currentWorkspaceUsage(database, current);
      const summaryBytes = utf8ByteLength(input.summary);
      if (usage.byteCount + summaryBytes > current.quota.maxBytes) {
        fail("quota_exceeded", "workspace byte quota exceeded");
      }
      if (updateRow(database, "agent_workspace_tasks", {
        state: "failed",
        summary: input.summary,
        cas_owner: reservation.operationKey,
        cas_expires_at: rootResultPolicyIdentity(input),
        revision: currentTask.revision + 1,
        updated_at: now,
      }, {
        task_id: currentTask.id,
        workspace_id: current.workspaceId,
        turn_id: current.turnId,
        user_id: current.userId,
        chat_id: current.chatId,
        revision: currentTask.revision,
      }) !== 1) fail("stale_revision", "task revision changed before cognition root result");
    } else {
      const usage = currentWorkspaceUsage(database, current);
      if (usage.submissionCount >= current.quota.maxSubmissions || usage.byteCount + submissionBytes > current.quota.maxBytes) {
        fail("quota_exceeded", "submission quota exceeded");
      }
      const policy = input.retention === undefined ? { retention: current.retention, expiresAt: current.expiresAt } : retentionValue(input.retention, input.ttlSeconds, now);
      insertRow(database, "agent_workspace_submissions", {
        submission_id: crypto.randomUUID(),
        task_id: currentTask.id,
        workspace_id: current.workspaceId,
        turn_id: current.turnId,
        user_id: current.userId,
        chat_id: current.chatId,
        child_frame_id: input.frameId ?? "root",
        state: "accepted",
        summary: input.summary,
        result_digest: summaryDigest(input.summary),
        byte_count: submissionBytes,
        revision: 0,
        retention: policy.retention,
        expires_at: policy.expiresAt,
        created_at: now,
        updated_at: now,
      }, ["submission_id", "task_id", "workspace_id", "turn_id", "user_id", "chat_id", "child_frame_id", "state", "summary", "result_digest", "byte_count", "retention", "expires_at"]);
      if (updateRow(database, "agent_workspace_tasks", {
        state: "completed",
        progress: 1,
        summary: input.summary,
        cas_owner: reservation.operationKey,
        cas_expires_at: rootResultPolicyIdentity(input),
        revision: currentTask.revision + 1,
        updated_at: now,
      }, {
        task_id: currentTask.id,
        workspace_id: current.workspaceId,
        turn_id: current.turnId,
        user_id: current.userId,
        chat_id: current.chatId,
        revision: currentTask.revision,
      }) !== 1) fail("stale_revision", "task revision changed before cognition root result");
    }
    const committed = cognitionUpdateValues(current, update, now, input.frameId, "submit_root_result");
    result = Object.freeze({
      workspaceRevision: committed.revision,
      state: committed.state,
      activation: update.activation,
      materializedTaskIds: committed.materializedTaskIds,
      taskId: update.taskId,
      transition: update.transition,
      ...cognitionWorkspaceReceiptFields(committed.receipt),
    });
  });
  if (!result) fail("stale_revision", "cognition root result transaction did not commit");
  return result;
}

export function settleWorkspaceChildTaskWithCognition(
  raw: unknown,
  factory: CognitionWorkspaceActivationFactoryV1,
): CognitionWorkspaceCommitResultV1 {
  const input = validateSettleWorkspaceChildTaskInput(raw);
  const row = requireWritable(input);
  requireCapability(input, "update_assigned_progress", raw);
  const database = getDb();
  const task = taskById(row, input.taskId);
  if (task.assignedFrameId !== input.assignedFrameId) {
    fail("child_confinement", "child settlement does not match the assigned frame");
  }
  if (task.state === "completed" || task.state === "cancelled" || task.state === "failed") {
    if (task.state !== input.state) {
      fail("task_assignment_conflict", "terminal task cannot be downgraded by child settlement");
    }
    const update = cognitionActivationUpdate(row, factory);
    if (update.taskId !== task.id) fail("invalid_input", "cognition child settlement task does not match persisted task");
    if (update.transition !== input.state) fail("invalid_state", "cognition child settlement transition does not match persisted task");
    const reservation = cognitionMutationReservationV1(update, input.frameId, "settle_child_task");
    if (taskOperationKey(row, task.id) !== reservation.operationKey) {
      fail("task_assignment_conflict", "terminal task settlement operation key does not match the committed settlement");
    }
    requireCognitionWorkspaceUpdate(row, update);
    const receipt = requireCognitionWorkspaceReceipt(database, row, reservation);
    return Object.freeze({
      workspaceRevision: row.revision,
      state: factory.state,
      activation: update.activation,
      materializedTaskIds: Object.freeze([]),
      taskId: update.taskId,
      transition: update.transition,
      ...cognitionWorkspaceReceiptFields(receipt),
    });
  }

  let result: CognitionWorkspaceCommitResultV1 | undefined;
  withWritableWorkspaceTransaction(row, (current) => {
    const currentTask = taskById(current, task.id);
    if (currentTask.assignedFrameId !== input.assignedFrameId) fail("child_confinement", "child settlement does not match the assigned frame");
    if (currentTask.state === "completed" || currentTask.state === "cancelled" || currentTask.state === "failed") {
      if (currentTask.state !== input.state) {
        fail("task_assignment_conflict", "terminal task cannot be downgraded by child settlement");
      }
      const update = cognitionActivationUpdate(current, factory);
      if (update.taskId !== currentTask.id) fail("invalid_input", "cognition child settlement task does not match persisted task");
      if (update.transition !== input.state) fail("invalid_state", "cognition child settlement transition does not match persisted task");
      const reservation = cognitionMutationReservationV1(update, input.frameId, "settle_child_task");
      if (taskOperationKey(current, currentTask.id) !== reservation.operationKey) {
        fail("task_assignment_conflict", "terminal task settlement operation key does not match the committed settlement");
      }
      requireCognitionWorkspaceUpdate(current, update);
      const receipt = requireCognitionWorkspaceReceipt(database, current, reservation);
      result = Object.freeze({
        workspaceRevision: current.revision,
        state: factory.state,
        activation: update.activation,
        materializedTaskIds: Object.freeze([]),
        taskId: update.taskId,
        transition: update.transition,
        ...cognitionWorkspaceReceiptFields(receipt),
      });
      return;
    }
    if (current.revision !== row.revision) fail("stale_revision", "workspace revision changed before child settlement");
    if (currentTask.revision !== task.revision) fail("stale_revision", "task revision is stale");
    const update = cognitionActivationUpdate(current, factory);
    if (update.taskId !== currentTask.id) fail("invalid_input", "cognition child settlement task does not match persisted task");
    const reservation = cognitionMutationReservationV1(update, input.frameId, "settle_child_task");
    if (update.transition !== input.state) fail("invalid_state", "cognition child settlement transition does not match persisted task");
    requireCognitionWorkspaceUpdate(current, update);
    const now = Math.floor(Date.now() / 1000);
    // Workspace task CAS ownership is otherwise unused by this service. Keep
    // the committed cognition settlement key in the durable task row so a
    // later service call cannot accept a new key from terminal state alone.
    const previousOperationKey = taskOperationKey(current, currentTask.id);
    if (previousOperationKey !== null && previousOperationKey !== reservation.operationKey) {
      fail("task_assignment_conflict", "task settlement operation identity is already committed");
    }
    if (updateRow(database, "agent_workspace_tasks", {
      state: input.state,
      cas_owner: reservation.operationKey,
      revision: currentTask.revision + 1,
      updated_at: now,
    }, {
      task_id: currentTask.id,
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      user_id: current.userId,
      chat_id: current.chatId,
      revision: currentTask.revision,
    }) !== 1) fail("stale_revision", "task revision changed before child settlement");
    const committed = cognitionUpdateValues(current, update, now, input.frameId, "settle_child_task");
    result = Object.freeze({
      workspaceRevision: committed.revision,
      state: committed.state,
      activation: update.activation,
      materializedTaskIds: committed.materializedTaskIds,
      taskId: update.taskId,
      transition: update.transition,
      ...cognitionWorkspaceReceiptFields(committed.receipt),
    });
  });
  if (!result) fail("stale_revision", "cognition child settlement transaction did not commit");
  return result;
}



export function acceptWorkspaceSubmissionWithCognition(
  raw: unknown,
  factory: CognitionWorkspaceActivationFactoryV1,
): CognitionWorkspaceCommitResultV1 {
  const input = validateAcceptWorkspaceSubmissionInput(raw);
  const row = requireWritable(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root accept submissions");
  const submission = submissionById(row, input.submissionId);
  submissionTaskForAcceptance(row, input, submission);
  if (submission.state === "rejected") fail("submission_rejected", "rejected submissions cannot be accepted");
  const database = getDb();
  let result: CognitionWorkspaceCommitResultV1 | undefined;
  withWritableWorkspaceTransaction(row, (current) => {
    const currentSubmission = submissionById(current, input.submissionId);
    const currentTask = submissionTaskForAcceptance(current, input, currentSubmission);
    const now = Math.floor(Date.now() / 1000);
    if (currentSubmission.state !== "accepted" && updateRow(database, "agent_workspace_submissions", { state: "accepted", revision: currentSubmission.revision + 1, updated_at: now }, { submission_id: currentSubmission.id, workspace_id: current.workspaceId, turn_id: current.turnId, user_id: current.userId, chat_id: current.chatId, revision: currentSubmission.revision }) !== 1) fail("stale_revision", "submission revision changed before cognition acceptance");
    if (currentSubmission.state !== "accepted" && updateRow(database, "agent_workspace_tasks", { summary: currentSubmission.summary, revision: currentTask.revision + 1, updated_at: now }, { task_id: currentTask.id, workspace_id: current.workspaceId, turn_id: current.turnId, user_id: current.userId, chat_id: current.chatId, revision: currentTask.revision }) !== 1) fail("stale_revision", "task revision changed before cognition acceptance");
    const update = cognitionActivationUpdate(current, factory);
    if (update.taskId !== currentSubmission.taskId) fail("invalid_input", "cognition acceptance task does not match persisted submission task");
    requireCognitionWorkspaceUpdate(current, update);
    const committed = cognitionUpdateValues(current, update, now, input.frameId, "accept_submission");
    result = Object.freeze({
      workspaceRevision: committed.revision,
      state: committed.state,
      activation: update.activation,
      materializedTaskIds: committed.materializedTaskIds,
      taskId: update.taskId,
      transition: update.transition,
      ...cognitionWorkspaceReceiptFields(committed.receipt),
    });
  });
  if (!result) fail("stale_revision", "cognition acceptance transaction did not commit");
  return result;
}

function completionCandidateMatches(
  expected: CognitionWorkspaceCompletionResultV1,
  actual: CognitionWorkspaceCompletionResultV1,
): boolean {
  try {
    return expected.workspaceRevision === actual.workspaceRevision
      && expected.accepted === actual.accepted
      && JSON.stringify(expected.state) === JSON.stringify(actual.state)
      && JSON.stringify(expected.activation) === JSON.stringify(actual.activation)
      && JSON.stringify(expected.blockingRequiredTaskIds) === JSON.stringify(actual.blockingRequiredTaskIds)
      && JSON.stringify(expected.materializedTaskIds) === JSON.stringify(actual.materializedTaskIds);
  } catch {
    return false;
  }
}


export function freezeWorkspaceForCompletionWithCognition(
  raw: unknown,
  factory: CognitionWorkspaceCompletionFactoryV1,
  preparedAcceptance?: CognitionWorkspacePreparedAcceptanceV1,
): CognitionWorkspaceCompletionResultV1 {
  const input = contextValue(raw, true);
  const row = requireWritable(input);
  if (input.actor !== "host" && input.actor !== "root") fail("forbidden", "only host/root freeze workspaces");
  const database = getDb();
  let result: CognitionWorkspaceCompletionResultV1 | undefined;
  withWritableWorkspaceTransaction(row, (current) => {
    const update = cognitionCompletionUpdate(current, factory);
    if (update.state.workspaceRevision !== current.revision + 1) fail("stale_revision", "cognition completion revision does not match workspace CAS");
    const preview = planCognitionCompletion(
      current,
      update,
      listWorkspaceRows("agent_workspace_tasks", current),
      listWorkspaceRows("agent_workspace_submissions", current),
    );
    const candidate = preview.candidate;
    const now = Math.floor(Date.now() / 1000);
    const usage = currentWorkspaceUsage(database, current);
    const materialized = materializeCognitionTemplates(
      database,
      current,
      update.materializeTemplates,
      now,
      preview.materialization,
    );
    if (!sameIds(materialized.ids, candidate.materializedTaskIds)) fail("stale_revision", "cognition completion materialization changed before commit");
    let acknowledgedBundle: unknown;
    if (candidate.accepted && preparedAcceptance) {
      try {
        const prepared = preparedAcceptance.prepare(candidate);
        if (!prepared || !completionCandidateMatches(prepared.candidate, candidate)) {
          fail("completion_preparation_failed", "Prepared completion candidate no longer matches the workspace CAS");
        }
        acknowledgedBundle = clonePreparedValue(prepared.bundle);
      } catch (error) {
        if (error instanceof TurnWorkspaceError) throw error;
        fail("completion_preparation_failed", "Completion handoff preparation failed");
      }
    }
    currentWorkspaceForMutation(current);
    if (updateRow(database, "agent_turn_workspaces", {
      state: candidate.accepted ? "frozen" : "active",
      frozen_at: candidate.accepted ? now : null,
      task_count: usage.taskCount + materialized.taskCount,
      record_count: usage.recordCount,
      submission_count: usage.submissionCount,
      artifact_count: usage.artifactCount,
      byte_count: usage.byteCount + materialized.byteCount,
      revision: candidate.workspaceRevision,
      updated_at: now,
    }, {
      workspace_id: current.workspaceId,
      turn_id: current.turnId,
      execution_id: current.executionId,
      user_id: current.userId,
      chat_id: current.chatId,
      revision: current.revision,
    }) !== 1) fail("stale_revision", "workspace changed during cognition completion");
    result = Object.freeze({
      ...candidate,
      ...(candidate.accepted && preparedAcceptance ? {
        preparedAcceptance: Object.freeze({
          candidate,
          bundle: acknowledgedBundle,
        }),
      } : {}),
    });
  });
  if (!result) fail("stale_revision", "cognition completion transaction did not commit");
  return result;
}
 
type PersistentWorkspaceRow = {
  readonly id: string;
  readonly userId: string;
  readonly chatId: string | null;
  readonly objective: string;
  readonly metadata: PersistentWorkspaceMetadataV1;
  readonly progress: PersistentWorkspaceProgressV1;
  readonly state: PersistentWorkspaceStateV1;
  readonly revision: number;
  readonly quota: PersistentWorkspaceQuotaV1;
  readonly usage: PersistentWorkspaceUsageV1;
  readonly createdAt: number;
  readonly updatedAt: number;
};

const persistentWorkspaceHostAuthorityBrand = Symbol("persistent-workspace-host-authority");
const persistentWorkspaceHostAuthorities = new WeakSet<object>();

/**
 * Mint a process-local host authority. The symbol is not exported and the
 * WeakSet identity check rejects JSON clones or caller-shaped DTOs.
 */
export function createPersistentWorkspaceHostAuthority(): PersistentWorkspaceHostAuthorityV1 {
  const authority = Object.freeze({ [persistentWorkspaceHostAuthorityBrand]: true });
  persistentWorkspaceHostAuthorities.add(authority);
  return authority as unknown as PersistentWorkspaceHostAuthorityV1;
}

function isPersistentWorkspaceHostAuthority(value: unknown): value is PersistentWorkspaceHostAuthorityV1 {
  return value !== null
    && typeof value === "object"
    && persistentWorkspaceHostAuthorities.has(value);
}

function requirePersistentWorkspaceHostAuthority(value: unknown): PersistentWorkspaceHostAuthorityV1 {
  if (!isPersistentWorkspaceHostAuthority(value)) {
    persistentFail("forbidden", "persistent workspace host authority is invalid");
  }
  return value;
}

function persistentFail(code: WorkspaceErrorCode, message: string, details?: Record<string, string | number>): never {
  return fail(code, message, details);
}

function persistentString(value: unknown, path: string, maxBytes: number, optional = false): string {
  if (value === undefined && optional) return "";
  return stringValue(value, path, maxBytes, !optional);
}

function persistentJson(value: unknown, path: string, maxBytes: number): string {
  assertNoPrivateFields(value, path);
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    persistentFail("invalid_input", `${path} is not serializable`);
  }
  if (encoded === undefined) persistentFail("invalid_input", `${path} is not serializable`);
  if (utf8ByteLength(encoded) > maxBytes) {
    persistentFail("quota_exceeded", `${path} exceeds its UTF-8 byte limit`, { limit: maxBytes, observed: utf8ByteLength(encoded) });
  }
  return encoded;
}

function persistentParsedJson<T>(value: unknown, path: string, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") persistentFail("invalid_state", `${path} is malformed`);
  try {
    return JSON.parse(value) as T;
  } catch {
    persistentFail("invalid_state", `${path} is malformed`);
  }
}

function persistentAllowed(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  assertKeys(value, allowed, path);
  assertNoPrivateFields(value, path);
}

function persistentMetadata(value: unknown, path: string, partial: boolean): PersistentWorkspaceMetadataV1 {
  if (value !== undefined && !isRecord(value)) persistentFail("invalid_input", `${path} must be an object`);
  const source = (value ?? {}) as Record<string, unknown>;
  persistentAllowed(source, ["title", "summary", "labels", "ownerNote"], path);
  const labelsValue = source.labels;
  let labels: readonly string[] = [];
  if (labelsValue !== undefined) {
    if (!Array.isArray(labelsValue) || labelsValue.length > PERSISTENT_WORKSPACE_MAX_LABELS) {
      persistentFail("invalid_input", `${path}.labels must be a bounded array`);
    }
    labels = Object.freeze(labelsValue.map((label, index) => persistentString(label, `${path}.labels[${index}]`, 256)));
  }
  const result: PersistentWorkspaceMetadataV1 = Object.freeze({
    title: source.title === undefined && partial ? "" : persistentString(source.title ?? "", `${path}.title`, 4_096, true),
    summary: source.summary === undefined && partial ? "" : persistentString(source.summary ?? "", `${path}.summary`, 16_384, true),
    labels,
    ownerNote: source.ownerNote === undefined && partial ? "" : persistentString(source.ownerNote ?? "", `${path}.ownerNote`, 16_384, true),
  });
  persistentJson(result, path, PERSISTENT_WORKSPACE_METADATA_MAX_BYTES);
  return result;
}

function persistentProgress(value: unknown, path: string, partial: boolean, now: number): PersistentWorkspaceProgressV1 {
  if (value !== undefined && !isRecord(value)) persistentFail("invalid_input", `${path} must be an object`);
  const source = (value ?? {}) as Record<string, unknown>;
  persistentAllowed(source, ["state", "percent", "summary", "updatedAt"], path);
  const state = source.state === undefined && partial ? "not_started" : source.state ?? "not_started";
  if (typeof state !== "string" || !["not_started", "in_progress", "blocked", "completed"].includes(state)) {
    persistentFail("invalid_input", `${path}.state is invalid`);
  }
  const percent = source.percent === undefined && partial ? 0 : finiteNumber(source.percent ?? 0, `${path}.percent`, 0, 1);
  const summary = source.summary === undefined && partial ? "" : persistentString(source.summary ?? "", `${path}.summary`, 16_384, true);
  const updatedAt = source.updatedAt === undefined ? now : integer(source.updatedAt, `${path}.updatedAt`, 0, Number.MAX_SAFE_INTEGER);
  const result: PersistentWorkspaceProgressV1 = Object.freeze({
    state: state as PersistentWorkspaceProgressV1["state"],
    percent,
    summary,
    updatedAt,
  });
  persistentJson(result, path, PERSISTENT_WORKSPACE_PROGRESS_MAX_BYTES);
  return result;
}

function persistentQuota(value: unknown): PersistentWorkspaceQuotaV1 {
  if (value !== undefined && !isRecord(value)) persistentFail("invalid_input", "quota must be an object");
  const source = (value ?? {}) as Record<string, unknown>;
  persistentAllowed(source, ["maxTasks", "maxRecords", "maxSubmissions", "maxArtifacts", "maxPublications", "maxBytes"], "quota");
  return Object.freeze({
    maxTasks: integer(source.maxTasks ?? PERSISTENT_WORKSPACE_MAX_TASKS, "quota.maxTasks", 0, PERSISTENT_WORKSPACE_MAX_TASKS),
    maxRecords: integer(source.maxRecords ?? PERSISTENT_WORKSPACE_MAX_RECORDS, "quota.maxRecords", 0, PERSISTENT_WORKSPACE_MAX_RECORDS),
    maxSubmissions: integer(source.maxSubmissions ?? PERSISTENT_WORKSPACE_MAX_SUBMISSIONS, "quota.maxSubmissions", 0, PERSISTENT_WORKSPACE_MAX_SUBMISSIONS),
    maxArtifacts: integer(source.maxArtifacts ?? PERSISTENT_WORKSPACE_MAX_ARTIFACTS, "quota.maxArtifacts", 0, PERSISTENT_WORKSPACE_MAX_ARTIFACTS),
    maxPublications: integer(source.maxPublications ?? PERSISTENT_WORKSPACE_MAX_PUBLICATIONS, "quota.maxPublications", 0, PERSISTENT_WORKSPACE_MAX_PUBLICATIONS),
    maxBytes: integer(source.maxBytes ?? PERSISTENT_WORKSPACE_MAX_BYTES, "quota.maxBytes", 0, PERSISTENT_WORKSPACE_MAX_BYTES),
  });
}

function persistentContext(value: unknown, path: string, requireRevision = true): PersistentWorkspaceContextV1 {
  if (!isRecord(value)) persistentFail("invalid_input", `${path} must be an object`);
  return Object.freeze({
    userId: idValue(value.userId, `${path}.userId`),
    chatId: value.chatId === null ? null : idValue(value.chatId, `${path}.chatId`),
    workspaceId: idValue(value.workspaceId, `${path}.workspaceId`),
    expectedRevision: requireRevision ? integer(value.expectedRevision, `${path}.expectedRevision`, 0, Number.MAX_SAFE_INTEGER) : 0,
  });
}

function validateCreatePersistentWorkspace(value: unknown): CreatePersistentWorkspaceInputV1 {
  if (!isRecord(value)) persistentFail("invalid_input", "persistent workspace input must be an object");
  persistentAllowed(value, ["userId", "chatId", "workspaceId", "objective", "metadata", "progress", "quota"], "persistentWorkspace");
  const now = Math.floor(Date.now() / 1000);
  const metadata = persistentMetadata(value.metadata, "metadata", true);
  const progress = persistentProgress(value.progress, "progress", true, now);
  return Object.freeze({
    userId: idValue(value.userId, "userId"),
    chatId: idValue(value.chatId, "chatId"),
    workspaceId: value.workspaceId === undefined ? undefined : idValue(value.workspaceId, "workspaceId"),
    objective: value.objective === undefined ? "" : persistentString(value.objective, "objective", PERSISTENT_WORKSPACE_OBJECTIVE_MAX_BYTES, true),
    metadata: Object.freeze(metadata),
    progress: Object.freeze(progress),
    quota: Object.freeze(persistentQuota(value.quota)),
  });
}

function validateCreatePersistentTurnSession(value: unknown): CreatePersistentWorkspaceTurnSessionInputV1 {
  if (!isRecord(value)) persistentFail("invalid_input", "turn session input must be an object");
  persistentAllowed(value, ["userId", "chatId", "workspaceId", "turnSessionId", "turnId", "attemptId", "executionId", "expectedRevision"], "turnSession");
  return Object.freeze({
    userId: idValue(value.userId, "turnSession.userId"),
    chatId: idValue(value.chatId, "turnSession.chatId"),
    workspaceId: idValue(value.workspaceId, "turnSession.workspaceId"),
    turnSessionId: value.turnSessionId === undefined ? undefined : idValue(value.turnSessionId, "turnSession.turnSessionId"),
    turnId: idValue(value.turnId, "turnSession.turnId"),
    attemptId: idValue(value.attemptId, "turnSession.attemptId"),
    executionId: value.executionId === undefined ? undefined : value.executionId === null ? null : idValue(value.executionId, "turnSession.executionId"),
    expectedRevision: value.expectedRevision === undefined ? undefined : integer(value.expectedRevision, "turnSession.expectedRevision", 0, Number.MAX_SAFE_INTEGER),
  });
}

function validatePersistentEdit(value: unknown): EditPersistentWorkspaceInputV1 {
  const context = persistentContext(value, "persistentEdit");
  if (!isRecord(value)) persistentFail("invalid_input", "persistent edit input must be an object");
  persistentAllowed(value, ["userId", "chatId", "workspaceId", "expectedRevision", "objective", "metadata", "progress", "record"], "persistentEdit");
  const now = Math.floor(Date.now() / 1000);
  if (value.objective !== undefined) persistentString(value.objective, "objective", PERSISTENT_WORKSPACE_OBJECTIVE_MAX_BYTES, true);
  const metadata = value.metadata === undefined ? undefined : persistentMetadata(value.metadata, "metadata", true);
  const progress = value.progress === undefined ? undefined : persistentProgress(value.progress, "progress", true, now);
  let record: PersistentWorkspaceRecordEditV1 | undefined;
  if (value.record !== undefined) {
    if (!isRecord(value.record)) persistentFail("invalid_input", "record must be an object");
    persistentAllowed(value.record, ["kind", "summary", "evidenceIds", "provenance", "taskId", "turnSessionId"], "record");
    if (typeof value.record.kind !== "string" || !(PERSISTENT_WORKSPACE_RECORD_KINDS as readonly string[]).includes(value.record.kind)) persistentFail("invalid_input", "record.kind is invalid");
    const evidence = value.record.evidenceIds ?? [];
    if (!Array.isArray(evidence) || evidence.length > WORKSPACE_MAX_REFERENCE_IDS) persistentFail("invalid_input", "record.evidenceIds is invalid");
    record = Object.freeze({
      kind: value.record.kind as PersistentWorkspaceRecordEditV1["kind"],
      summary: persistentString(value.record.summary, "record.summary", PERSISTENT_WORKSPACE_RECORD_MAX_BYTES),
      evidenceIds: Object.freeze(evidence.map((item, index) => idValue(item, `record.evidenceIds[${index}]`))),
      provenance: value.record.provenance === undefined || value.record.provenance === null ? null : persistentString(value.record.provenance, "record.provenance", PERSISTENT_WORKSPACE_PROVENANCE_MAX_BYTES),
      taskId: value.record.taskId === undefined || value.record.taskId === null ? null : idValue(value.record.taskId, "record.taskId"),
      turnSessionId: value.record.turnSessionId === undefined || value.record.turnSessionId === null ? null : idValue(value.record.turnSessionId, "record.turnSessionId"),
    });
    persistentJson(record, "record", PERSISTENT_WORKSPACE_RECORD_MAX_BYTES);
  }
  return Object.freeze({ ...context, objective: value.objective as string | undefined, metadata, progress, record });
}

type PersistentWorkspaceTaskDraft = {
  readonly id?: string;
  readonly turnSessionId: string | null;
  readonly title: string;
  readonly objective: string;
  readonly state: WorkspaceTaskStateV1;
  readonly required: boolean;
  readonly dependencyIds: readonly string[];
};

function validatePersistentTaskDraft(value: unknown, path: string, allowContext: boolean): PersistentWorkspaceTaskDraft {
  if (!isRecord(value)) persistentFail("invalid_input", `${path} must be an object`);
  const allowed = allowContext
    ? ["userId", "chatId", "workspaceId", "expectedRevision", "id", "turnSessionId", "title", "objective", "state", "required", "dependencyIds"]
    : ["id", "turnSessionId", "title", "objective", "state", "required", "dependencyIds"];
  persistentAllowed(value, allowed, path);
  const dependencies = identifierList(value.dependencyIds ?? [], `${path}.dependencyIds`);
  if (dependencies.length > PERSISTENT_WORKSPACE_MAX_DEPENDENCIES) persistentFail("quota_exceeded", "dependency closure exceeds its limit");
  const state = value.state ?? "pending";
  if (typeof state !== "string" || !(WORKSPACE_TASK_STATES as readonly string[]).includes(state)) persistentFail("invalid_state", `${path}.state is invalid`);
  const required = value.required ?? false;
  if (typeof required !== "boolean") persistentFail("invalid_input", `${path}.required must be boolean`);
  return Object.freeze({
    id: value.id === undefined ? undefined : idValue(value.id, `${path}.id`),
    turnSessionId: value.turnSessionId === undefined || value.turnSessionId === null ? null : idValue(value.turnSessionId, `${path}.turnSessionId`),
    title: persistentString(value.title, `${path}.title`, WORKSPACE_TASK_TITLE_MAX_BYTES),
    objective: value.objective === undefined ? "" : persistentString(value.objective, `${path}.objective`, PERSISTENT_WORKSPACE_OBJECTIVE_MAX_BYTES, true),
    state: state as WorkspaceTaskStateV1,
    required,
    dependencyIds: dependencies,
  });
}

function validatePersistentTaskRequest(value: unknown): PersistentWorkspaceContextV1 & PersistentWorkspaceTaskDraft {
  const context = persistentContext(value, "persistentTask");
  const draft = validatePersistentTaskDraft(value, "persistentTask", true);
  return Object.freeze({ ...context, ...draft });
}

function validatePersistentPublication(value: unknown): PublishPersistentWorkspaceSelectionInputV1 {
  const context = persistentContext(value, "persistentPublication");
  if (!isRecord(value)) persistentFail("invalid_input", "publication input must be an object");
  persistentAllowed(value, ["userId", "chatId", "workspaceId", "expectedRevision", "category", "sourceId", "sourceRevision", "sourceDigest"], "persistentPublication");
  if (typeof value.category !== "string" || !(WORKSPACE_PUBLICATION_CATEGORIES as readonly string[]).includes(value.category)) persistentFail("invalid_input", "publication.category is invalid");
  let sourceDigest: string | undefined;
  if (value.sourceDigest !== undefined) {
    sourceDigest = persistentString(value.sourceDigest, "publication.sourceDigest", 64);
    if (!DIGEST.test(sourceDigest)) persistentFail("invalid_input", "publication.sourceDigest is invalid");
  }
  return Object.freeze({
    ...context,
    category: value.category as PublishPersistentWorkspaceSelectionInputV1["category"],
    sourceId: idValue(value.sourceId, "publication.sourceId"),
    sourceRevision: value.sourceRevision === undefined ? undefined : integer(value.sourceRevision, "publication.sourceRevision", 0, Number.MAX_SAFE_INTEGER),
    sourceDigest,
  });
}

function validateDeletePersistentWorkspacePublication(value: unknown): DeletePersistentWorkspacePublicationInputV1 {
  const context = persistentContext(value, "persistentPublicationDelete");
  if (!isRecord(value)) persistentFail("invalid_input", "publication deletion input must be an object");
  persistentAllowed(value, ["userId", "chatId", "workspaceId", "expectedRevision", "publicationId"], "persistentPublicationDelete");
  return Object.freeze({ ...context, publicationId: idValue(value.publicationId, "persistentPublicationDelete.publicationId") });
}

function validateDeletePersistentWorkspace(value: unknown): DeletePersistentWorkspaceInputV1 {
  const context = persistentContext(value, "persistentWorkspaceDelete");
  if (!isRecord(value)) persistentFail("invalid_input", "workspace deletion input must be an object");
  persistentAllowed(value, ["userId", "chatId", "workspaceId", "expectedRevision"], "persistentWorkspaceDelete");
  return Object.freeze(context);
}
 
function persistentRows(table: string, workspace: PersistentWorkspaceRow): Array<Record<string, unknown>> {
  const database = getDb();
  if (!tableExists(database, table)) persistentFail("schema_unavailable", `${table} is unavailable`);
  return database.query(
    `SELECT * FROM ${quoteIdentifier(table)}
      WHERE workspace_id = ? AND user_id = ?
      ORDER BY created_at ASC, rowid ASC`,
  ).all(workspace.id, workspace.userId) as Array<Record<string, unknown>>;
}

function persistentWorkspaceFromRow(raw: Record<string, unknown>): PersistentWorkspaceRow {
  const now = Math.floor(Date.now() / 1000);
  const state = rowString(raw, ["state"], "active") as PersistentWorkspaceStateV1;
  if (state !== "active" && state !== "archived") persistentFail("invalid_state", "persistent workspace state is invalid");
  const metadataParsed = persistentParsedJson<Record<string, unknown>>(raw.metadata_json, "metadata", {});
  const progressParsed = persistentParsedJson<Record<string, unknown>>(raw.progress_json, "progress", {});
  const metadata = persistentMetadata(metadataParsed, "metadata", false);
  const progress = persistentProgress(progressParsed, "progress", false, now);
  const quota: PersistentWorkspaceQuotaV1 = Object.freeze({
    maxTasks: rowNumber(raw, ["quota_tasks"], PERSISTENT_WORKSPACE_MAX_TASKS),
    maxRecords: rowNumber(raw, ["quota_records"], PERSISTENT_WORKSPACE_MAX_RECORDS),
    maxSubmissions: rowNumber(raw, ["quota_submissions"], PERSISTENT_WORKSPACE_MAX_SUBMISSIONS),
    maxArtifacts: rowNumber(raw, ["quota_artifacts"], PERSISTENT_WORKSPACE_MAX_ARTIFACTS),
    maxPublications: rowNumber(raw, ["quota_publications"], PERSISTENT_WORKSPACE_MAX_PUBLICATIONS),
    maxBytes: rowNumber(raw, ["quota_bytes"], PERSISTENT_WORKSPACE_MAX_BYTES),
  });
  return {
    id: rowString(raw, ["workspace_id"]),
    userId: rowString(raw, ["user_id"]),
    chatId: rowNullableString(raw, ["chat_id"]),
    objective: rowString(raw, ["objective"]),
    metadata,
    progress,
    state,
    revision: rowNumber(raw, ["revision"]),
    quota,
    usage: {
      taskCount: rowNumber(raw, ["task_count"]),
      recordCount: rowNumber(raw, ["record_count"]),
      submissionCount: rowNumber(raw, ["submission_count"]),
      artifactCount: rowNumber(raw, ["artifact_count"]),
      publicationCount: rowNumber(raw, ["publication_count"]),
      byteCount: rowNumber(raw, ["byte_count"]),
    },
    createdAt: rowNumber(raw, ["created_at"], now),
    updatedAt: rowNumber(raw, ["updated_at"], now),
  };
}

function persistentWorkspaceSnapshot(workspace: PersistentWorkspaceRow): PersistentWorkspace {
  return deepFreeze({
    version: 1,
    id: workspace.id,
    userId: workspace.userId,
    chatId: workspace.chatId,
    objective: workspace.objective,
    metadata: workspace.metadata,
    progress: workspace.progress,
    state: workspace.state,
    revision: workspace.revision,
    quota: workspace.quota,
    usage: workspace.usage,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  });
}

function persistentWorkspaceUsage(
  workspace: PersistentWorkspaceRow,
  database: Database = getDb(),
): PersistentWorkspaceUsageV1 {
  const requiredTables = [
    "persistent_workspace_tasks",
    "persistent_workspace_records",
    "persistent_workspace_submissions",
    "persistent_workspace_artifacts",
    "persistent_workspace_publications",
  ] as const;
  for (const table of requiredTables) {
    if (!tableExists(database, table)) persistentFail("schema_unavailable", `${table} is unavailable`);
  }
  const count = (table: (typeof requiredTables)[number]): number => {
    const row = database.query(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}
        WHERE workspace_id = ? AND user_id = ?`,
    ).get(workspace.id, workspace.userId) as Record<string, unknown> | null;
    return rowNumber(row ?? {}, ["count"]);
  };
  const bytes = (table: (typeof requiredTables)[number], columns: readonly string[]): number => {
    const expression = columns.map((column) => `COALESCE(${quoteIdentifier(column)}, 0)`).join(" + ");
    const row = database.query(
      `SELECT COALESCE(SUM(${expression}), 0) AS bytes FROM ${quoteIdentifier(table)}
        WHERE workspace_id = ? AND user_id = ?`,
    ).get(workspace.id, workspace.userId) as Record<string, unknown> | null;
    return rowNumber(row ?? {}, ["bytes"]);
  };
  return Object.freeze({
    taskCount: count("persistent_workspace_tasks"),
    recordCount: count("persistent_workspace_records"),
    submissionCount: count("persistent_workspace_submissions"),
    artifactCount: count("persistent_workspace_artifacts"),
    publicationCount: count("persistent_workspace_publications"),
    byteCount: bytes("persistent_workspace_tasks", ["byte_count"])
      + bytes("persistent_workspace_records", ["byte_count"])
      + bytes("persistent_workspace_submissions", ["byte_count"])
      + bytes("persistent_workspace_artifacts", ["byte_count"])
      + bytes("persistent_workspace_publications", ["byte_count"]),
  });
}
function persistentRefreshedWorkspace(
  workspace: PersistentWorkspaceRow,
  database: Database = getDb(),
): PersistentWorkspaceRow {
  const raw = database.query(
    "SELECT * FROM persistent_workspaces WHERE workspace_id = ? AND user_id = ?",
  ).get(workspace.id, workspace.userId) as Record<string, unknown> | null;
  if (!raw) persistentFail("not_found", "persistent workspace was not found");
  const current = persistentWorkspaceFromRow(raw);
  const usage = persistentWorkspaceUsage(current, database);
  return { ...current, usage };
}
 
function persistentChatOwnerExists(userId: string, chatId: string): boolean {
  const database = getDb();
  if (!tableExists(database, "chats")) persistentFail("schema_unavailable", "chats is unavailable");
  const columns = tableColumns(database, "chats");
  if (!columns.has("user_id")) persistentFail("schema_unavailable", "chats.user_id is unavailable");
  return database.query("SELECT 1 AS present FROM chats WHERE id = ? AND user_id = ? LIMIT 1").get(chatId, userId) !== null;
}


/**
 * Migration 125 intentionally stores attempt_id as a logical association:
 * migration 126 owns the durable attempt table and runs later. Once that
 * table exists, new workspace sessions must still prove the complete
 * owner/chat/turn/attempt tuple before they can be created.
 */
function persistentAttemptMatches(
  database: Database,
  userId: string,
  chatId: string,
  turnId: string,
  attemptId: string,
): boolean {
  if (!tableExists(database, "agent_run_attempts")) {
    persistentFail("schema_unavailable", "turn attempt schema is unavailable");
  }
  return database.query(
    `SELECT 1 AS present
       FROM agent_run_attempts
      WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND attempt_id = ?
      LIMIT 1`,
  ).get(userId, chatId, turnId, attemptId) !== null;
}

function findPersistentWorkspace(userId: string, chatId: string | null, workspaceId?: string): PersistentWorkspaceRow | null {
  const database = getDb();
  if (!tableExists(database, "persistent_workspaces")) return null;
  const raw = workspaceId === undefined
    ? chatId === null
      ? null
      : database.query("SELECT * FROM persistent_workspaces WHERE user_id = ? AND chat_id = ? LIMIT 1").get(userId, chatId) as Record<string, unknown> | null
    : database.query("SELECT * FROM persistent_workspaces WHERE workspace_id = ? AND user_id = ? LIMIT 1").get(workspaceId, userId) as Record<string, unknown> | null;
  if (!raw) return null;
  const attachedChatId = rowNullableString(raw, ["chat_id"]);
  if (attachedChatId !== null && attachedChatId !== chatId) return null;
  return persistentRefreshedWorkspace(persistentWorkspaceFromRow(raw));
}

function requirePersistentWorkspace(context: PersistentWorkspaceContextV1): PersistentWorkspaceRow {
  const workspace = findPersistentWorkspace(context.userId, context.chatId, context.workspaceId);
  if (!workspace) persistentFail("not_found", "persistent workspace was not found");
  if (workspace.revision !== context.expectedRevision) {
    persistentFail("stale_revision", "persistent workspace revision is stale", { expected: context.expectedRevision, actual: workspace.revision });
  }
  return workspace;
}

/**
 * Publication reads are scoped by the durable owner/workspace identity. The
 * source chat is historical provenance and may already be detached/tombstoned,
 * so this path deliberately does not call persistentChatOwnerExists().
 */
function findPersistentPublicationWorkspace(context: PersistentWorkspaceContextV1): PersistentWorkspaceRow | null {
  const database = getDb();
  if (!tableExists(database, "persistent_workspaces")) return null;
  const raw = database.query(
    "SELECT * FROM persistent_workspaces WHERE workspace_id = ? AND user_id = ? LIMIT 1",
  ).get(context.workspaceId, context.userId) as Record<string, unknown> | null;
  if (!raw) return null;
  const workspace = persistentRefreshedWorkspace(persistentWorkspaceFromRow(raw));
  if (workspace.chatId !== null && workspace.chatId !== context.chatId) {
    persistentFail("not_found", "persistent workspace is not associated with this chat");
  }
  return workspace;
}

function requirePersistentPublicationWorkspace(context: PersistentWorkspaceContextV1): PersistentWorkspaceRow {
  const workspace = findPersistentPublicationWorkspace(context);
  if (!workspace) persistentFail("not_found", "persistent workspace was not found");
  if (workspace.revision !== context.expectedRevision) {
    persistentFail("stale_revision", "persistent workspace revision is stale", { expected: context.expectedRevision, actual: workspace.revision });
  }
  return workspace;
}

/**
 * Writable mutations normally require an exact workspace CAS revision.
 * Publication replay defers that check until after it has looked for the
 * exact immutable copy, while retaining the same owner/chat/state fence.
 */
function persistentWritableWorkspace(
  context: PersistentWorkspaceContextV1,
  revisionCheck: "required" | "deferred" = "required",
): PersistentWorkspaceRow & { readonly chatId: string } {
  const workspace = revisionCheck === "deferred"
    ? findPersistentWorkspace(context.userId, context.chatId, context.workspaceId)
    : requirePersistentWorkspace(context);
  if (!workspace) persistentFail("not_found", "persistent workspace was not found");
  if (workspace.chatId === null || context.chatId === null || workspace.chatId !== context.chatId || !persistentChatOwnerExists(context.userId, context.chatId)) {
    persistentFail("not_found", "persistent workspace is detached from a live owner chat");
  }
  if (workspace.state !== "active") persistentFail("workspace_frozen", "persistent workspace is archived");
  return workspace as PersistentWorkspaceRow & { readonly chatId: string };
}

function persistentCommitWorkspace(workspace: PersistentWorkspaceRow, values: Record<string, unknown> = {}, now = Math.floor(Date.now() / 1000)): number {
  const usage = persistentWorkspaceUsage(workspace);
  const database = getDb();
  const changed = workspace.chatId === null
    ? database.query(
      `UPDATE persistent_workspaces SET ${Object.keys({
        ...values,
        task_count: usage.taskCount,
        record_count: usage.recordCount,
        submission_count: usage.submissionCount,
        artifact_count: usage.artifactCount,
        publication_count: usage.publicationCount,
        byte_count: usage.byteCount,
        revision: workspace.revision + 1,
        updated_at: now,
      }).map((key) => `${quoteIdentifier(key)} = ?`).join(", ")}
       WHERE workspace_id = ? AND user_id = ? AND chat_id IS NULL AND revision = ?`,
    ).run(
      ...Object.values({
        ...values,
        task_count: usage.taskCount,
        record_count: usage.recordCount,
        submission_count: usage.submissionCount,
        artifact_count: usage.artifactCount,
        publication_count: usage.publicationCount,
        byte_count: usage.byteCount,
        revision: workspace.revision + 1,
        updated_at: now,
      }).map(sqlValue),
      workspace.id,
      workspace.userId,
      workspace.revision,
    ).changes
    : updateRow(database, "persistent_workspaces", {
      ...values,
      task_count: usage.taskCount,
      record_count: usage.recordCount,
      submission_count: usage.submissionCount,
      artifact_count: usage.artifactCount,
      publication_count: usage.publicationCount,
      byte_count: usage.byteCount,
      revision: workspace.revision + 1,
      updated_at: now,
    }, {
      workspace_id: workspace.id,
      user_id: workspace.userId,
      chat_id: workspace.chatId,
      revision: workspace.revision,
    });
  if (changed !== 1) persistentFail("stale_revision", "persistent workspace changed during mutation");
  return workspace.revision + 1;
}
function persistentDependencyIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > PERSISTENT_WORKSPACE_ID_MAX_BYTES || !SAFE_ID.test(value)) {
    persistentFail("invalid_state", `${path} is not a bounded dependency identifier`);
  }
  return value;
}

function persistentDependencyIds(value: unknown, path: string): readonly string[] {
  if (typeof value !== "string" || value.length === 0) {
    persistentFail("invalid_state", `${path} must be a persisted JSON dependency array`);
  }
  const parsed = persistentParsedJson<unknown>(value, path, []);
  if (!Array.isArray(parsed) || parsed.length > PERSISTENT_WORKSPACE_MAX_DEPENDENCIES) {
    persistentFail("invalid_state", `${path} must be a bounded dependency array`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  parsed.forEach((entry, index) => {
    const id = persistentDependencyIdentifier(entry, `${path}[${index}]`);
    if (seen.has(id)) persistentFail("invalid_state", `${path} contains duplicate identifiers`);
    seen.add(id);
    result.push(id);
  });
  return Object.freeze(result);
}


function persistentTaskFromRow(raw: Record<string, unknown>): PersistentWorkspaceTask {
  const state = rowString(raw, ["state"], "pending") as WorkspaceTaskStateV1;
  if (!(WORKSPACE_TASK_STATES as readonly string[]).includes(state)) persistentFail("invalid_state", "persistent task state is invalid");
  const now = Math.floor(Date.now() / 1000);
  const progress = persistentProgress(persistentParsedJson(raw.progress_json, "task.progress", {}), "task.progress", false, now);
  const creator = rowString(raw, ["creator"], "owner");
  if (creator !== "host" && creator !== "owner") persistentFail("invalid_state", "persistent task creator is invalid");
  const dependencyIds = persistentDependencyIds(raw.dependency_ids_json, "task.dependencies");
  return deepFreeze({
    version: 1,
    id: rowString(raw, ["task_id"]),
    workspaceId: rowString(raw, ["workspace_id"]),
    turnSessionId: rowNullableString(raw, ["turn_session_id"]),
    userId: rowString(raw, ["user_id"]),
    chatId: rowNullableString(raw, ["chat_id"]),
    title: rowString(raw, ["title"]),
    objective: rowString(raw, ["objective"]),
    state,
    required: rowNumber(raw, ["required"]) === 1,
    dependencyIds,
    creator,
    hostAdmitted: rowNumber(raw, ["host_admitted"]) === 1,
    progress,
    summary: rowString(raw, ["summary"]),
    revision: rowNumber(raw, ["revision"]),
    createdAt: rowNumber(raw, ["created_at"]),
    updatedAt: rowNumber(raw, ["updated_at"]),
  });
}
 
function materializePersistentWorkspaceTask(
  workspace: PersistentWorkspaceRow & { readonly chatId: string },
  input: PersistentWorkspaceTaskDraft,
  creator: "host" | "owner",
  hostAdmitted: boolean,
): PersistentWorkspaceTask {
  const taskId = input.id ?? crypto.randomUUID();
  idValue(taskId, "task.id");
  const database = getDb();
  if (database.query("SELECT 1 AS present FROM persistent_workspace_tasks WHERE task_id = ? LIMIT 1").get(taskId)) {
    persistentFail("duplicate_id", "persistent task identifier is already in use");
  }
  const turnSessionId = input.turnSessionId ?? null;
  const dependencyIds = input.dependencyIds ?? [];
  if (turnSessionId !== null) {
    const session = database.query(
      "SELECT 1 AS present FROM persistent_workspace_turn_sessions WHERE turn_session_id = ? AND workspace_id = ? AND user_id = ? AND chat_id = ? LIMIT 1",
    ).get(turnSessionId, workspace.id, workspace.userId, workspace.chatId);
    if (!session) persistentFail("not_found", "task turn session was not found");
  }
  persistentAssertDependencies(workspace, taskId, dependencyIds);
  const usage = persistentWorkspaceUsage(workspace);
  const progress = persistentProgress(undefined, "task.progress", false, Math.floor(Date.now() / 1000));
  const byteCount = utf8ByteLength(input.title) + utf8ByteLength(input.objective) + utf8ByteLength(JSON.stringify(dependencyIds)) + utf8ByteLength(JSON.stringify(progress));
  if (usage.taskCount >= workspace.quota.maxTasks || usage.byteCount + byteCount > workspace.quota.maxBytes) persistentFail("quota_exceeded", "persistent workspace task quota exceeded");
  const now = Math.floor(Date.now() / 1000);
  try {
    database.transaction(() => {
      insertRow(database, "persistent_workspace_tasks", {
        task_id: taskId,
        workspace_id: workspace.id,
        turn_session_id: turnSessionId,
        user_id: workspace.userId,
        chat_id: workspace.chatId,
        title: input.title,
        objective: input.objective,
        state: input.state,
        required: input.required ? 1 : 0,
        dependency_ids_json: JSON.stringify(dependencyIds),
        creator,
        host_admitted: hostAdmitted ? 1 : 0,
        progress_json: JSON.stringify(progress),
        summary: "",
        byte_count: byteCount,
        revision: 0,
        created_at: now,
        updated_at: now,
      }, ["task_id", "workspace_id", "user_id", "chat_id", "title", "objective", "state", "dependency_ids_json", "creator", "host_admitted", "progress_json", "revision"]);
      persistentCommitWorkspace(workspace, {}, now);
    })();
  } catch (error) {
    if (isPersistentTaskIdentifierConflict(error)) {
      persistentFail("duplicate_id", "persistent task identifier is already in use");
    }
    throw error;
  }
  const refreshed = persistentRefreshedWorkspace(workspace);
  return persistentTaskById(refreshed, taskId);
}

export function createPersistentWorkspaceTask(
  ownerScopeRaw: unknown,
  raw: unknown,
): PersistentWorkspaceTask {
  const ownerScope = persistentContext(ownerScopeRaw, "persistentOwnerScope") as PersistentWorkspaceOwnerScopeV1;
  const input = validatePersistentTaskDraft(raw, "persistentTask", false);
  if (input.required) persistentFail("forbidden", "owner ad-hoc tasks cannot be required");
  const workspace = persistentWritableWorkspace(ownerScope);
  return materializePersistentWorkspaceTask(workspace, input, "owner", false);
}

export function createPersistentWorkspaceHostTask(
  authorityRaw: unknown,
  raw: unknown,
): PersistentWorkspaceTask {
  requirePersistentWorkspaceHostAuthority(authorityRaw);
  const input = validatePersistentTaskRequest(raw);
  const workspace = persistentWritableWorkspace(input);
  return materializePersistentWorkspaceTask(workspace, input, "host", true);
}

export function listPersistentWorkspaceTasks(raw: unknown): readonly PersistentWorkspaceTask[] {
  const workspace = requirePersistentWorkspace(persistentContext(raw, "persistentTasks"));
  const rows = persistentRows("persistent_workspace_tasks", workspace);
  persistentDependencyGraph(rows);
  return Object.freeze(rows.map(persistentTaskFromRow));
}

function mergePersistentMetadata(current: PersistentWorkspaceMetadataV1, patch: unknown): PersistentWorkspaceMetadataV1 {
  if (!isRecord(patch)) return current;
  return persistentMetadata({
    title: patch.title === undefined ? current.title : patch.title,
    summary: patch.summary === undefined ? current.summary : patch.summary,
    labels: patch.labels === undefined ? current.labels : patch.labels,
    ownerNote: patch.ownerNote === undefined ? current.ownerNote : patch.ownerNote,
  }, "metadata", false);
}

function mergePersistentProgress(current: PersistentWorkspaceProgressV1, patch: unknown, now: number): PersistentWorkspaceProgressV1 {
  if (!isRecord(patch)) return current;
  return persistentProgress({
    state: patch.state === undefined ? current.state : patch.state,
    percent: patch.percent === undefined ? current.percent : patch.percent,
    summary: patch.summary === undefined ? current.summary : patch.summary,
    updatedAt: now,
  }, "progress", false, now);
}

export function editPersistentWorkspace(raw: unknown): PersistentWorkspace {
  const input = validatePersistentEdit(raw);
  if (input.objective === undefined && input.metadata === undefined && input.progress === undefined && input.record === undefined) persistentFail("invalid_input", "persistent edit has no changes");
  const workspace = persistentWritableWorkspace(input);
  const database = getDb();
  const now = Math.floor(Date.now() / 1000);
  const rawInput = raw as Record<string, unknown>;
  const metadata = input.metadata === undefined ? workspace.metadata : mergePersistentMetadata(workspace.metadata, rawInput.metadata);
  const progress = input.progress === undefined ? workspace.progress : mergePersistentProgress(workspace.progress, rawInput.progress, now);
  database.transaction(() => {
    if (input.record) {
      const record = input.record;
      if (record.taskId != null) persistentTaskById(workspace, record.taskId);
      if (record.turnSessionId != null) {
        const session = database.query(
          "SELECT 1 AS present FROM persistent_workspace_turn_sessions WHERE turn_session_id = ? AND workspace_id = ? AND user_id = ? AND chat_id = ? LIMIT 1",
        ).get(record.turnSessionId, workspace.id, workspace.userId, workspace.chatId);
        if (!session) persistentFail("not_found", "record turn session was not found");
      }
      const usage = persistentWorkspaceUsage(workspace);
      const content: PersistentWorkspaceRecordContentV1 = Object.freeze({
        summary: record.summary,
        evidenceIds: record.evidenceIds ?? [],
        provenance: record.provenance ?? null,
      });
      const contentJson = persistentJson(content, "record.content", PERSISTENT_WORKSPACE_RECORD_MAX_BYTES);
      const byteCount = utf8ByteLength(contentJson);
      if (usage.recordCount >= workspace.quota.maxRecords || usage.byteCount + byteCount > workspace.quota.maxBytes) persistentFail("quota_exceeded", "persistent workspace record quota exceeded");
      insertRow(database, "persistent_workspace_records", {
        record_id: crypto.randomUUID(),
        workspace_id: workspace.id,
        turn_session_id: record.turnSessionId,
        user_id: workspace.userId,
        chat_id: workspace.chatId,
        kind: record.kind,
        content_json: contentJson,
        summary: record.summary,
        task_id: record.taskId,
        byte_count: byteCount,
        revision: 1,
        created_at: now,
        updated_at: now,
      }, ["record_id", "workspace_id", "user_id", "chat_id", "kind", "content_json", "summary", "byte_count", "revision"]);
    }
    persistentCommitWorkspace(workspace, {
      ...(input.objective === undefined ? {} : { objective: input.objective }),
      ...(input.metadata === undefined ? {} : { metadata_json: JSON.stringify(metadata) }),
      ...(input.progress === undefined ? {} : { progress_json: JSON.stringify(progress) }),
    }, now);
  })();
  const refreshed = persistentRefreshedWorkspace(workspace);
  return persistentWorkspaceSnapshot(refreshed);
}

export function listPersistentWorkspaceRecords(raw: unknown): readonly PersistentWorkspaceRecord[] {
  const workspace = requirePersistentWorkspace(persistentContext(raw, "persistentRecords"));
  return Object.freeze(persistentRows("persistent_workspace_records", workspace).map(persistentRecordFromRow));
}
export function listPersistentWorkspaceSubmissions(raw: unknown): readonly PersistentWorkspaceSubmission[] {
  const workspace = requirePersistentWorkspace(persistentContext(raw, "persistentSubmissions"));
  return Object.freeze(persistentRows("persistent_workspace_submissions", workspace).map(persistentSubmissionFromRow));
}


export function listPersistentWorkspaceArtifacts(raw: unknown): readonly PersistentWorkspaceArtifactV1[] {
  const workspace = requirePersistentWorkspace(persistentContext(raw, "persistentArtifacts"));
  return Object.freeze(persistentRows("persistent_workspace_artifacts", workspace).map(persistentArtifactFromRow));
}

function persistentRecordFromRow(raw: Record<string, unknown>): PersistentWorkspaceRecord {
  const kind = rowString(raw, ["kind"]) as PersistentWorkspaceRecord["kind"];
  if (!(PERSISTENT_WORKSPACE_RECORD_KINDS as readonly string[]).includes(kind)) persistentFail("invalid_state", "persistent record kind is invalid");
  const content = persistentParsedJson<PersistentWorkspaceRecordContentV1>(raw.content_json, "record.content", {
    summary: rowString(raw, ["summary"]),
    evidenceIds: [],
    provenance: null,
  });
  return deepFreeze({
    version: 1,
    id: rowString(raw, ["record_id"]),
    workspaceId: rowString(raw, ["workspace_id"]),
    turnSessionId: rowNullableString(raw, ["turn_session_id"]),
    userId: rowString(raw, ["user_id"]),
    chatId: rowNullableString(raw, ["chat_id"]),
    kind,
    content,
    taskId: rowNullableString(raw, ["task_id"]),
    revision: rowNumber(raw, ["revision"]),
    createdAt: rowNumber(raw, ["created_at"]),
    updatedAt: rowNumber(raw, ["updated_at"]),
  });
}

function persistentSubmissionFromRow(raw: Record<string, unknown>): PersistentWorkspaceSubmission {
  const state = rowString(raw, ["state"], "submitted") as PersistentWorkspaceSubmission["state"];
  if (!(WORKSPACE_SUBMISSION_STATES as readonly string[]).includes(state)) persistentFail("invalid_state", "persistent submission state is invalid");
  return deepFreeze({
    version: 1,
    id: rowString(raw, ["submission_id"]),
    workspaceId: rowString(raw, ["workspace_id"]),
    turnSessionId: rowNullableString(raw, ["turn_session_id"]),
    taskId: rowString(raw, ["task_id"]),
    userId: rowString(raw, ["user_id"]),
    chatId: rowNullableString(raw, ["chat_id"]),
    state,
    summary: rowString(raw, ["summary"]),
    resultDigest: rowString(raw, ["result_digest"]),
    revision: rowNumber(raw, ["revision"]),
    createdAt: rowNumber(raw, ["created_at"]),
    updatedAt: rowNumber(raw, ["updated_at"]),
  });
}

function persistentSessionFromRow(raw: Record<string, unknown>): PersistentWorkspaceTurnSession {
  const phase = rowString(raw, ["phase"], "ADMIT") as PersistentWorkspaceTurnSession["phase"];
  const status = rowString(raw, ["status"], "pending") as PersistentWorkspaceTurnSession["status"];
  const outcomeValue = rowNullableString(raw, ["outcome"]);
  if (!(PERSISTENT_WORKSPACE_TURN_PHASES as readonly string[]).includes(phase)) persistentFail("invalid_state", "turn session phase is invalid");
  if (!(PERSISTENT_WORKSPACE_TURN_STATUSES as readonly string[]).includes(status)) persistentFail("invalid_state", "turn session status is invalid");
  if (outcomeValue !== null && !(PERSISTENT_WORKSPACE_TERMINAL_OUTCOMES as readonly string[]).includes(outcomeValue)) persistentFail("invalid_state", "turn session outcome is invalid");
  return deepFreeze({
    version: 1,
    id: rowString(raw, ["turn_session_id"]),
    workspaceId: rowString(raw, ["workspace_id"]),
    userId: rowString(raw, ["user_id"]),
    chatId: rowNullableString(raw, ["chat_id"]),
    turnId: rowString(raw, ["turn_id"]),
    attemptId: rowString(raw, ["attempt_id"]),
    executionId: rowNullableString(raw, ["execution_id"]),
    phase,
    status,
    outcome: outcomeValue as PersistentWorkspaceTurnSession["outcome"],
    revision: rowNumber(raw, ["revision"]),
    createdAt: rowNumber(raw, ["created_at"]),
    updatedAt: rowNumber(raw, ["updated_at"]),
    terminalAt: raw.terminal_at === null || raw.terminal_at === undefined ? null : rowNumber(raw, ["terminal_at"]),
  });
}

/** Host recovery lookup; returns only the exact active/durable execution binding. */
export function getPersistentWorkspaceTurnSessionByExecutionV1(raw: unknown): PersistentWorkspaceTurnSession | null {
  if (!isRecord(raw)) persistentFail("invalid_input", "persistent session identity must be an object");
  persistentAllowed(raw, ["userId", "executionId"], "persistentSessionByExecution");
  const userId = idValue(raw.userId, "persistentSessionByExecution.userId");
  const executionId = idValue(raw.executionId, "persistentSessionByExecution.executionId");
  const row = getDb().query(
    "SELECT * FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ? LIMIT 1",
  ).get(userId, executionId) as Record<string, unknown> | null;
  return row ? persistentSessionFromRow(row) : null;
}

function persistentArtifactFromRow(raw: Record<string, unknown>): PersistentWorkspaceArtifactV1 {
  return deepFreeze({
    version: 1,
    id: rowString(raw, ["artifact_id"]),
    workspaceId: rowString(raw, ["workspace_id"]),
    turnSessionId: rowNullableString(raw, ["turn_session_id"]),
    userId: rowString(raw, ["user_id"]),
    chatId: rowNullableString(raw, ["chat_id"]),
    blobDigest: rowString(raw, ["blob_digest"]),
    mimeType: rowString(raw, ["mime_type"]),
    byteCount: rowNumber(raw, ["byte_count"]),
    provenance: rowString(raw, ["provenance_json"], "{}"),
    revision: rowNumber(raw, ["revision"]),
    createdAt: rowNumber(raw, ["created_at"]),
    updatedAt: rowNumber(raw, ["updated_at"]),
  });
}
function createPersistentWorkspaceTurnSession(raw: unknown): PersistentWorkspaceTurnSession {
  const input = validateCreatePersistentTurnSession(raw);
  const found = findPersistentWorkspace(input.userId, input.chatId, input.workspaceId);
  if (!found) persistentFail("not_found", "persistent workspace was not found");
  const expectedRevision = input.expectedRevision ?? found.revision;
  const workspace = persistentWritableWorkspace({
    userId: input.userId,
    chatId: input.chatId,
    workspaceId: input.workspaceId,
    expectedRevision,
  });
  const database = getDb();
  const existingByTurn = database.query(
    `SELECT * FROM persistent_workspace_turn_sessions
      WHERE user_id = ? AND turn_id = ? AND attempt_id = ?
      LIMIT 1`,
  ).get(workspace.userId, input.turnId, input.attemptId) as Record<string, unknown> | null;
  const existingBySessionId = input.turnSessionId === undefined
    ? null
    : database.query(
      `SELECT * FROM persistent_workspace_turn_sessions
        WHERE turn_session_id = ?
        LIMIT 1`,
    ).get(input.turnSessionId) as Record<string, unknown> | null;
  const existingCandidates = [existingByTurn, existingBySessionId].filter(
    (candidate): candidate is Record<string, unknown> => candidate !== null,
  );
  if (existingCandidates.length > 0) {
    const matches = existingCandidates.every((candidate) => (
      input.turnSessionId !== undefined
      && input.executionId !== undefined
      && rowString(candidate, ["turn_session_id"]) === input.turnSessionId
      && rowString(candidate, ["workspace_id"]) === workspace.id
      && rowString(candidate, ["user_id"]) === workspace.userId
      && rowNullableString(candidate, ["chat_id"]) === workspace.chatId
      && rowString(candidate, ["turn_id"]) === input.turnId
      && rowString(candidate, ["attempt_id"]) === input.attemptId
      && rowNullableString(candidate, ["execution_id"]) === input.executionId
    ));
    if (!matches) persistentFail("task_assignment_conflict", "turn session identity conflicts with an existing session");
    return persistentSessionFromRow(existingByTurn ?? existingBySessionId!);
  }
  if (!persistentAttemptMatches(database, workspace.userId, input.chatId, input.turnId, input.attemptId)) {
    persistentFail("not_found", "turn attempt was not found for this owner and chat");
  }
  const turnSessionId = input.turnSessionId ?? crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  database.transaction(() => {
    insertRow(database, "persistent_workspace_turn_sessions", {
      turn_session_id: turnSessionId,
      workspace_id: workspace.id,
      user_id: workspace.userId,
      chat_id: workspace.chatId,
      turn_id: input.turnId,
      attempt_id: input.attemptId,
      execution_id: input.executionId ?? null,
      phase: "ADMIT",
      status: "pending",
      outcome: null,
      revision: 0,
      created_at: now,
      updated_at: now,
      terminal_at: null,
    }, ["turn_session_id", "workspace_id", "user_id", "chat_id", "turn_id", "attempt_id"]);
  })();
  const created = database.query(
    "SELECT * FROM persistent_workspace_turn_sessions WHERE turn_session_id = ? AND workspace_id = ? AND user_id = ? AND chat_id = ?",
  ).get(turnSessionId, workspace.id, workspace.userId, workspace.chatId) as Record<string, unknown> | null;
  if (!created) persistentFail("not_found", "turn session was not created");
  return persistentSessionFromRow(created);
}
/**
 * Host-only turn-session admission. The authority is process-minted and
 * identity-bound; no serialized or caller-shaped value can authorize a write.
 */
export function createPersistentWorkspaceHostTurnSession(
  authorityRaw: unknown,
  raw: unknown,
): PersistentWorkspaceTurnSession {
  requirePersistentWorkspaceHostAuthority(authorityRaw);
  return createPersistentWorkspaceTurnSession(raw);
}

/**
 * Host-only turn-session transition. This owner/workspace/session CAS remains
 * usable after source-chat deletion; owner-facing routes have no access to it.
 */
export function updatePersistentWorkspaceHostTurnSession(
  authorityRaw: unknown,
  raw: unknown,
): PersistentWorkspaceTurnSession {
  return updatePersistentWorkspaceHostTurnSessionInTransaction(getDb(), authorityRaw, raw);
}

/**
 * Transaction-aware host transition used when the Turn Session must converge
 * with its execution, inspection attempt, and Agent Run projection atomically.
 */
export function updatePersistentWorkspaceHostTurnSessionInTransaction(
  database: Database,
  authorityRaw: unknown,
  raw: unknown,
): PersistentWorkspaceTurnSession {
  requirePersistentWorkspaceHostAuthority(authorityRaw);
  return updatePersistentWorkspaceTurnSession(database, raw);
}

/**
 * Host admission resolves the one durable workspace attached to a live chat.
 * Existing workspaces are returned unchanged, preserving identity across
 * turns; the authority is deliberately separate from model/client input.
 */
export function ensurePersistentWorkspaceHost(
  authorityRaw: unknown,
  raw: unknown,
): PersistentWorkspace {
  requirePersistentWorkspaceHostAuthority(authorityRaw);
  return createPersistentWorkspace(raw);
}

/**
 * Resolve or create the stable owner workspace for a live chat. Callers should
 * build the identity fields from authenticated server state, not request-body
 * claims.
 */
export function ensurePersistentWorkspaceForChat(raw: unknown): PersistentWorkspace {
  return createPersistentWorkspace(raw);
}

/** Read a stable workspace by owner and ID, including detached workspaces. */
export function getPersistentWorkspaceById(raw: unknown): PersistentWorkspace {
  if (!isRecord(raw)) persistentFail("invalid_input", "persistent workspace identity must be an object");
  persistentAllowed(raw, ["userId", "workspaceId"], "persistentWorkspaceById");
  const userId = idValue(raw.userId, "persistentWorkspaceById.userId");
  const workspaceId = idValue(raw.workspaceId, "persistentWorkspaceById.workspaceId");
  const database = getDb();
  if (!tableExists(database, "persistent_workspaces")) {
    persistentFail("schema_unavailable", "persistent workspace schema is unavailable");
  }
  const row = database.query(
    "SELECT * FROM persistent_workspaces WHERE workspace_id = ? AND user_id = ? LIMIT 1",
  ).get(workspaceId, userId) as Record<string, unknown> | null;
  if (!row) persistentFail("not_found", "persistent workspace was not found");
  return persistentWorkspaceSnapshot(persistentRefreshedWorkspace(persistentWorkspaceFromRow(row)));
}

 
export function createPersistentWorkspace(raw: unknown): PersistentWorkspace {
  const input = validateCreatePersistentWorkspace(raw);
  const database = getDb();
  if (!tableExists(database, "persistent_workspaces")) persistentFail("schema_unavailable", "persistent workspace schema is unavailable");
  if (!persistentChatOwnerExists(input.userId, input.chatId)) persistentFail("not_found", "chat was not found for this owner");
  const existing = findPersistentWorkspace(input.userId, input.chatId);
  if (existing) {
    if (input.workspaceId !== undefined && input.workspaceId !== existing.id) persistentFail("duplicate_id", "chat already has a persistent workspace");
    return persistentWorkspaceSnapshot(existing);
  }
  const workspaceId = input.workspaceId ?? crypto.randomUUID();
  idValue(workspaceId, "workspaceId");
  const now = Math.floor(Date.now() / 1000);
  const metadata = persistentMetadata(input.metadata, "metadata", false);
  const progress = persistentProgress(input.progress, "progress", false, now);
  const quota = persistentQuota(input.quota);
  database.transaction(() => {
    insertRow(database, "persistent_workspaces", {
      workspace_id: workspaceId,
      user_id: input.userId,
      chat_id: input.chatId,
      objective: input.objective ?? "",
      metadata_json: JSON.stringify(metadata),
      progress_json: JSON.stringify(progress),
      state: "active",
      revision: 0,
      quota_tasks: quota.maxTasks,
      quota_records: quota.maxRecords,
      quota_submissions: quota.maxSubmissions,
      quota_artifacts: quota.maxArtifacts,
      quota_publications: quota.maxPublications,
      quota_bytes: quota.maxBytes,
      task_count: 0,
      record_count: 0,
      submission_count: 0,
      artifact_count: 0,
      publication_count: 0,
      byte_count: 0,
      created_at: now,
      updated_at: now,
    }, ["workspace_id", "user_id", "chat_id"]);
  })();
  const created = findPersistentWorkspace(input.userId, input.chatId, workspaceId);
  if (!created) persistentFail("not_found", "persistent workspace was not created");
  return persistentWorkspaceSnapshot(created);
}

export function getPersistentWorkspace(raw: unknown): PersistentWorkspace {
  const context = persistentContext(raw, "persistentWorkspace");
  return persistentWorkspaceSnapshot(requirePersistentWorkspace(context));
}

export function getPersistentWorkspaceForChat(raw: unknown): PersistentWorkspace {
  if (!isRecord(raw)) persistentFail("invalid_input", "persistent chat identity must be an object");
  persistentAllowed(raw, ["userId", "chatId"], "persistentChat");
  const userId = idValue(raw.userId, "persistentChat.userId");
  const chatId = idValue(raw.chatId, "persistentChat.chatId");
  if (!persistentChatOwnerExists(userId, chatId)) persistentFail("not_found", "chat was not found for this owner");
  const workspace = findPersistentWorkspace(userId, chatId);
  if (!workspace) persistentFail("not_found", "persistent workspace was not found");
  return persistentWorkspaceSnapshot(workspace);
}


function validatePersistentWorkspaceTurnSessionPagination(pagination: PaginationParams): PaginationParams {
  if (
    !Number.isSafeInteger(pagination.limit)
    || pagination.limit < 1
    || pagination.limit > MAX_LIMIT
    || !Number.isSafeInteger(pagination.offset)
    || pagination.offset < 0
    || pagination.offset > PERSISTENT_WORKSPACE_MAX_SESSION_OFFSET
  ) {
    persistentFail("invalid_input", "persistent turn session pagination is invalid");
  }
  return pagination;
}

export function listPersistentWorkspaceTurnSessions(
  raw: unknown,
  pagination: PaginationParams,
): PersistentWorkspaceTurnSessionPageV1 {
  const boundedPagination = validatePersistentWorkspaceTurnSessionPagination(pagination);
  const context = persistentContext(raw, "persistentTurnSessions");
  const workspace = requirePersistentWorkspace(context);
  const database = getDb();
  const rows = database.query(
    `SELECT * FROM persistent_workspace_turn_sessions
      WHERE workspace_id = ? AND user_id = ?
      ORDER BY created_at ASC, rowid ASC
      LIMIT ? OFFSET ?`,
  ).all(workspace.id, workspace.userId, boundedPagination.limit, boundedPagination.offset) as Array<Record<string, unknown>>;
  const count = database.query(
    `SELECT COUNT(*) AS count
       FROM persistent_workspace_turn_sessions
      WHERE workspace_id = ? AND user_id = ?`,
  ).get(workspace.id, workspace.userId) as { count: number } | null;
  return Object.freeze({
    data: rows.map(persistentSessionFromRow),
    total: count?.count ?? 0,
    limit: boundedPagination.limit,
    offset: boundedPagination.offset,
  });
}

type PersistentWorkspaceHostTurnSessionUpdateV1 = Omit<UpdatePersistentWorkspaceTurnSessionInputV1, "chatId">;

function validatePersistentSessionUpdate(value: unknown): PersistentWorkspaceHostTurnSessionUpdateV1 {
  if (!isRecord(value)) persistentFail("invalid_input", "turn session update must be an object");
  persistentAllowed(value, ["userId", "workspaceId", "expectedRevision", "turnSessionId", "phase", "status", "outcome"], "persistentTurnSessionUpdate");
  if (value.phase !== undefined && (typeof value.phase !== "string" || !(PERSISTENT_WORKSPACE_TURN_PHASES as readonly string[]).includes(value.phase))) persistentFail("invalid_input", "turn session phase is invalid");
  if (value.status !== undefined && (typeof value.status !== "string" || !(PERSISTENT_WORKSPACE_TURN_STATUSES as readonly string[]).includes(value.status))) persistentFail("invalid_input", "turn session status is invalid");
  if (value.outcome !== undefined && value.outcome !== null && (typeof value.outcome !== "string" || !(PERSISTENT_WORKSPACE_TERMINAL_OUTCOMES as readonly string[]).includes(value.outcome))) persistentFail("invalid_input", "turn session outcome is invalid");
  return Object.freeze({
    userId: idValue(value.userId, "persistentTurnSessionUpdate.userId"),
    workspaceId: idValue(value.workspaceId, "persistentTurnSessionUpdate.workspaceId"),
    expectedRevision: integer(value.expectedRevision, "persistentTurnSessionUpdate.expectedRevision", 0, Number.MAX_SAFE_INTEGER),
    turnSessionId: idValue(value.turnSessionId, "turnSessionId"),
    phase: value.phase as PersistentWorkspaceHostTurnSessionUpdateV1["phase"],
    status: value.status as PersistentWorkspaceHostTurnSessionUpdateV1["status"],
    outcome: value.outcome as PersistentWorkspaceHostTurnSessionUpdateV1["outcome"],
  });
}

function updatePersistentWorkspaceTurnSession(
  database: Database,
  raw: unknown,
): PersistentWorkspaceTurnSession {
  const input = validatePersistentSessionUpdate(raw);
  const workspaceRaw = database.query(
    "SELECT * FROM persistent_workspaces WHERE workspace_id = ? AND user_id = ? LIMIT 1",
  ).get(input.workspaceId, input.userId) as Record<string, unknown> | null;
  if (!workspaceRaw) persistentFail("not_found", "persistent workspace was not found");
  const workspace = persistentRefreshedWorkspace(persistentWorkspaceFromRow(workspaceRaw), database);
  const current = database.query(
    `SELECT * FROM persistent_workspace_turn_sessions
      WHERE turn_session_id = ? AND workspace_id = ? AND user_id = ? LIMIT 1`,
  ).get(input.turnSessionId, workspace.id, workspace.userId) as Record<string, unknown> | null;
  if (!current) persistentFail("not_found", "turn session was not found");
  const session = persistentSessionFromRow(current);
  const phaseOrder = new Map<string, number>(PERSISTENT_WORKSPACE_TURN_PHASES.map((phase, index) => [phase, index]));
  const phase = input.phase ?? session.phase;
  if ((phaseOrder.get(phase) ?? -1) < (phaseOrder.get(session.phase) ?? -1)) persistentFail("invalid_state", "turn session phase cannot move backwards");
  const status = input.status ?? session.status;
  const outcome = input.outcome === undefined ? session.outcome : input.outcome;
  if (session.phase === "TERMINAL" || session.status === "terminal") {
    if (phase !== session.phase || status !== session.status || outcome !== session.outcome) {
      persistentFail("invalid_state", "terminal turn session is immutable");
    }
    return session;
  }
  if (workspace.revision !== input.expectedRevision) {
    persistentFail("stale_revision", "persistent workspace revision is stale", { expected: input.expectedRevision, actual: workspace.revision });
  }
  if (status === "terminal" && phase !== "TERMINAL") persistentFail("invalid_state", "terminal status requires TERMINAL phase");
  if (phase === "TERMINAL" && status !== "terminal") persistentFail("invalid_state", "TERMINAL phase requires terminal status");
  if (phase === "TERMINAL" && !outcome) persistentFail("invalid_state", "TERMINAL phase requires an outcome");
  if (phase !== "TERMINAL" && outcome) persistentFail("invalid_state", "nonterminal session cannot have an outcome");
  const now = Math.floor(Date.now() / 1000);
  const changed = database.query(
    `UPDATE persistent_workspace_turn_sessions
        SET phase = ?, status = ?, outcome = ?, revision = ?, updated_at = ?, terminal_at = ?
      WHERE turn_session_id = ? AND workspace_id = ? AND user_id = ? AND revision = ?
        AND EXISTS (
          SELECT 1 FROM persistent_workspaces
           WHERE workspace_id = ? AND user_id = ? AND revision = ?
        )`,
  ).run(
    phase,
    status,
    outcome,
    session.revision + 1,
    now,
    phase === "TERMINAL" ? now : null,
    session.id,
    workspace.id,
    workspace.userId,
    session.revision,
    workspace.id,
    workspace.userId,
    input.expectedRevision,
  ).changes;
  if (changed !== 1) persistentFail("stale_revision", "turn session revision is stale");
  const next = database.query(
    "SELECT * FROM persistent_workspace_turn_sessions WHERE turn_session_id = ? AND workspace_id = ? AND user_id = ? LIMIT 1",
  ).get(session.id, workspace.id, workspace.userId) as Record<string, unknown> | null;
  if (!next) persistentFail("not_found", "turn session disappeared");
  return persistentSessionFromRow(next);
}

function persistentTaskById(workspace: PersistentWorkspaceRow, taskId: string): PersistentWorkspaceTask {
  const row = getDb().query(
    `SELECT * FROM persistent_workspace_tasks
      WHERE task_id = ? AND workspace_id = ? AND user_id = ? LIMIT 1`,
  ).get(taskId, workspace.id, workspace.userId) as Record<string, unknown> | null;
  if (!row) persistentFail("not_found", "persistent task was not found");
  return persistentTaskFromRow(row);
}

function persistentDependencyGraph(rows: readonly Record<string, unknown>[]): Map<string, readonly string[]> {
  const graph = new Map<string, readonly string[]>();
  rows.forEach((row) => graph.set(rowString(row, ["task_id"]), persistentDependencyIds(row.dependency_ids_json, "task.dependencies")));
  for (const [taskId, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (!graph.has(dependency)) persistentFail("invalid_state", `task ${taskId} references missing dependency ${dependency}`);
    }
  }
  return graph;
}

function persistentAssertDependencies(workspace: PersistentWorkspaceRow, taskId: string, dependencyIds: readonly string[]): void {
  const graph = persistentDependencyGraph(persistentRows("persistent_workspace_tasks", workspace));
  graph.set(taskId, dependencyIds);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) persistentFail("dependency_cycle", "persistent workspace task dependencies must be acyclic");
    if (visited.has(id)) return;
    if (!graph.has(id)) persistentFail("invalid_input", `task dependency ${id} does not exist`);
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  visit(taskId);
}

export function getPersistentWorkspaceDependencyClosure(raw: unknown): readonly PersistentWorkspaceTask[] {
  if (!isRecord(raw)) persistentFail("invalid_input", "dependency closure input must be an object");
  persistentAllowed(raw, ["userId", "chatId", "workspaceId", "expectedRevision", "rootTaskIds"], "dependencyClosure");
  const workspace = requirePersistentWorkspace(persistentContext(raw, "dependencyClosure"));
  if (!Array.isArray(raw.rootTaskIds) || raw.rootTaskIds.length === 0 || raw.rootTaskIds.length > PERSISTENT_WORKSPACE_MAX_TASKS) persistentFail("invalid_input", "rootTaskIds must be a bounded non-empty array");
  const rows = persistentRows("persistent_workspace_tasks", workspace);
  const graph = persistentDependencyGraph(rows);
  const byId = new Map(rows.map((row) => [rowString(row, ["task_id"]), row] as const));
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const row = byId.get(id);
    if (!row) persistentFail("not_found", `task ${id} was not found`);
    visited.add(id);
    const dependencies = [...(graph.get(id) ?? [])];
    dependencies.sort(compareUtf8);
    for (const dependency of dependencies) visit(dependency);
    ordered.push(id);
  };
  for (const root of raw.rootTaskIds) {
    visit(persistentDependencyIdentifier(root, "rootTaskIds"));
  }
  return Object.freeze(ordered.map((id) => persistentTaskFromRow(byId.get(id)!)));
}

 
type PersistentPublicationSelectionV1 = {
  readonly copy: PersistentWorkspacePublicationCopyV1;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly sourceDigest: string;
  readonly sourceCreatedAt: number;
  readonly sourceUpdatedAt: number;
  readonly sourceTurnSessionId: string;
  readonly sourceAttemptId: string;
  readonly sourceExecutionId: string | null;
  readonly sourceChatId: string | null;
  readonly sourceMessageId: string | null;
  readonly sourceSwipeId: number | null;
};

type PersistentPublicationSessionV1 = {
  readonly id: string;
  readonly userId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly executionId: string | null;
  readonly chatId: string | null;
};

function publicationDigest(value: unknown, path: string): string {
  assertNoPrivateFields(value, path);
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    persistentFail("invalid_input", `${path} is not serializable`);
  }
  if (encoded === undefined) persistentFail("invalid_input", `${path} is not serializable`);
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

function nullableRowNumber(row: Record<string, unknown>, names: readonly string[]): number | null {
  for (const name of names) {
    if (row[name] === null || row[name] === undefined) return null;
    if (typeof row[name] === "number" && Number.isSafeInteger(row[name])) return row[name] as number;
  }
  return null;
}

function publicationSourceDigest(raw: Record<string, unknown>, copy: PersistentWorkspacePublicationCopyV1): string {
  const provenanceValue = persistentParsedJson<Record<string, unknown>>(raw.source_provenance_json, "publication.provenance", {});
  const candidate = provenanceValue.sourceDigest;
  if (typeof candidate === "string" && DIGEST.test(candidate)) return candidate;
  if (copy.category === "artifact" && DIGEST.test(copy.blobDigest)) return copy.blobDigest;
  return publicationDigest(copy, "publication.copy");
}

function publicationSessionForTurn(
  workspace: PersistentWorkspaceRow,
  input: PublishPersistentWorkspaceSelectionInputV1,
  turnId: string,
  executionId?: string,
): PersistentPublicationSessionV1 {
  const database = getDb();
  if (!tableExists(database, "persistent_workspace_turn_sessions")) {
    persistentFail("schema_unavailable", "persistent turn-session schema is unavailable");
  }
  const sourceChatId = workspace.chatId ?? input.chatId;
  const rows = database.query(
    `SELECT * FROM persistent_workspace_turn_sessions
      WHERE workspace_id = ? AND user_id = ? AND turn_id = ?
      ORDER BY CASE WHEN chat_id IS ? THEN 0 ELSE 1 END, created_at ASC, rowid ASC`,
  ).all(workspace.id, workspace.userId, turnId, sourceChatId) as Array<Record<string, unknown>>;
  const candidateRows = executionId === undefined
    ? rows
    : rows.filter((row) => rowString(row, ["execution_id"]) === executionId);
  if (candidateRows.length === 0) persistentFail("not_found", "source turn session was not found for this workspace");
  const exactRows = candidateRows.filter((row) => rowNullableString(row, ["chat_id"]) === sourceChatId);
  const selected = exactRows.length === 1 ? exactRows[0] : exactRows.length > 1 ? null : candidateRows.length === 1 ? candidateRows[0] : null;
  if (!selected) persistentFail("invalid_state", "source turn session association is ambiguous");
  const id = idValue(rowString(selected, ["turn_session_id"]), "publication.turnSessionId");
  const attemptId = idValue(rowString(selected, ["attempt_id"]), "publication.attemptId");
  const associatedTurnId = idValue(rowString(selected, ["turn_id"]), "publication.turnId");
  if (associatedTurnId !== turnId) persistentFail("not_found", "source turn session does not match the selected source");
  const chatId = rowNullableString(selected, ["chat_id"]);
  if (sourceChatId !== null && chatId !== null && chatId !== sourceChatId) {
    persistentFail("forbidden", "source turn session chat does not match the owner chat");
  }
  const associatedExecutionId = rowNullableString(selected, ["execution_id"]);
  return Object.freeze({ id, userId: workspace.userId, turnId: associatedTurnId, attemptId, executionId: associatedExecutionId, chatId });
}
function publicationSourceExecutionLinks(
  session: PersistentPublicationSessionV1,
  sourceChatId: string | null,
): { readonly messageId: string | null; readonly swipeId: number | null } {
  const database = getDb();
  const chatId = sourceChatId ?? session.chatId;
  let row: Record<string, unknown> | null = null;
  if (tableExists(database, "agent_run_attempts")) {
    row = database.query(
      `SELECT target_message_id, target_swipe_id
         FROM agent_run_attempts
        WHERE user_id = ? AND attempt_id = ? AND turn_id = ? AND chat_id IS ?
        LIMIT 1`,
    ).get(session.userId, session.attemptId, session.turnId, chatId) as Record<string, unknown> | null;
  }
  if (!row && session.executionId !== null && session.executionId === session.turnId && tableExists(database, "agent_turn_executions")) {
    row = database.query(
      `SELECT target_message_id, target_swipe_id
         FROM agent_turn_executions
        WHERE id = ? AND user_id = ? AND chat_id IS ?
        LIMIT 1`,
    ).get(session.executionId, session.userId, chatId) as Record<string, unknown> | null;
  }
  return {
    messageId: rowNullableString(row ?? {}, ["target_message_id"]),
    swipeId: nullableRowNumber(row ?? {}, ["target_swipe_id"]),
  };
}


function operationalSourceRevisionTimestamp(table: string): string {
  switch (table) {
    case "agent_turn_workspaces":
    case "agent_workspace_tasks":
    case "agent_workspace_artifacts":
      return "source.updated_at";
    case "agent_workspace_records":
      // Findings/records are immutable operational rows and only carry
      // created_at; use that real timestamp for deterministic source choice.
      return "source.created_at";
    default:
      persistentFail("schema_unavailable", `${table} source revision timestamp is unavailable`);
  }
}

function assertPublicationSourceDigest(
  input: PublishPersistentWorkspaceSelectionInputV1,
  actual: string,
): void {
  if (input.sourceDigest !== undefined && input.sourceDigest !== actual) {
    persistentFail("stale_revision", "publication source digest is stale");
  }
}

function operationalSourceRows(
  table: string,
  workspace: PersistentWorkspaceRow,
  input: PublishPersistentWorkspaceSelectionInputV1,
  where: string,
  values: readonly unknown[],
): Array<Record<string, unknown>> {
  const database = getDb();
  if (!tableExists(database, table)) persistentFail("schema_unavailable", `${table} is unavailable`);
  const sourceRevisionTimestamp = operationalSourceRevisionTimestamp(table);
  const sourceChatId = workspace.chatId ?? input.chatId;
  if (sourceChatId === null) return [];
  const executionPredicate = table === "agent_turn_workspaces" ? " AND session.execution_id = source.execution_id" : "";
  const bindings: SqlValue[] = [workspace.userId, sourceChatId, ...values, workspace.id].map(sqlValue);
  return database.query(
    `SELECT source.* FROM ${quoteIdentifier(table)} AS source
      WHERE source.user_id = ? AND source.chat_id = ? AND ${where}
        AND EXISTS (
          SELECT 1
            FROM persistent_workspace_turn_sessions AS session
           WHERE session.workspace_id = ?
             AND session.user_id = source.user_id
             AND session.turn_id = source.turn_id
             AND (session.chat_id = source.chat_id OR session.chat_id IS NULL)
             ${executionPredicate}
        )
      ORDER BY ${sourceRevisionTimestamp} DESC, source.created_at DESC, source.rowid ASC
      LIMIT 2`,
  ).all(...bindings) as Array<Record<string, unknown>>;
}



function publicationTaskState(raw: unknown): WorkspaceTaskStateV1 {
  if (raw === "active") return "active";
  if (raw === "blocked") return "blocked";
  if (raw === "completed") return "completed";
  persistentFail("invalid_state", "operational task state is invalid");
}

function publicationTaskProgressState(raw: unknown): PersistentWorkspaceProgressV1["state"] {
  if (raw === "blocked") return "blocked";
  if (raw === "completed") return "completed";
  if (raw === "active") return "in_progress";
  persistentFail("invalid_state", "operational task state is invalid");
}

function persistentPublicationCopy(
  workspace: PersistentWorkspaceRow,
  input: PublishPersistentWorkspaceSelectionInputV1,
): PersistentPublicationSelectionV1 {
  if (input.category === "objective") {
    const sourceRows = operationalSourceRows("agent_turn_workspaces", workspace, input, "source.workspace_id = ?", [input.sourceId]);
    if (sourceRows.length !== 1) persistentFail("not_found", "objective source was not found");
    const source = sourceRows[0];
    if (!source) persistentFail("not_found", "objective source was not found");
    const sourceWorkspaceId = idValue(rowString(source, ["workspace_id"]), "publication.objective.workspaceId");
    const turnId = idValue(rowString(source, ["turn_id"]), "publication.objective.turnId");
    const executionId = idValue(rowString(source, ["execution_id"]), "publication.objective.executionId");
    const session = publicationSessionForTurn(workspace, input, turnId, executionId);
    const objective = persistentString(rowString(source, ["objective"]), "publication.objective", PERSISTENT_WORKSPACE_OBJECTIVE_MAX_BYTES, true);
    const constraints = persistentParsedJson<unknown[]>(source.constraints_json, "publication.objective.constraints", []);
    if (!Array.isArray(constraints) || constraints.length > WORKSPACE_MAX_REFERENCE_IDS) persistentFail("invalid_state", "objective constraints are malformed");
    constraints.forEach((constraint, index) => persistentString(constraint, `publication.objective.constraints[${index}]`, WORKSPACE_CONSTRAINT_MAX_BYTES));
    const sourceRevision = integer(rowNumber(source, ["revision"]), "publication.objective.sourceRevision", 0, Number.MAX_SAFE_INTEGER);
    const sourceDigest = publicationDigest({ objective, constraints }, "publication.objective");
    assertPublicationSourceDigest(input, sourceDigest);
    if (input.sourceRevision !== undefined && input.sourceRevision !== sourceRevision) persistentFail("stale_revision", "objective source revision is stale");
    const sourceChatId = rowNullableString(source, ["chat_id"]);
    const links = publicationSourceExecutionLinks(session, sourceChatId);
    return {
      sourceId: sourceWorkspaceId,
      copy: { category: "objective", id: sourceWorkspaceId, objective, metadata: persistentMetadata(undefined, "publication.objective.metadata", false) },
      sourceRevision,
      sourceDigest,
      sourceCreatedAt: integer(rowNumber(source, ["created_at"]), "publication.objective.createdAt", 0, Number.MAX_SAFE_INTEGER),
      sourceUpdatedAt: integer(rowNumber(source, ["updated_at"]), "publication.objective.updatedAt", 0, Number.MAX_SAFE_INTEGER),
      sourceTurnSessionId: session.id,
      sourceAttemptId: session.attemptId,
      sourceExecutionId: session.executionId,
      sourceChatId,
      sourceMessageId: links.messageId,
      sourceSwipeId: links.swipeId,
    };
  }
  if (input.category === "task") {
    const source = operationalSourceRows("agent_workspace_tasks", workspace, input, "task_id = ?", [input.sourceId])[0];
    if (!source) persistentFail("not_found", "task source was not found");
    const turnId = idValue(rowString(source, ["turn_id"]), "publication.task.turnId");
    const session = publicationSessionForTurn(workspace, input, turnId);
    const title = persistentString(rowString(source, ["title"]), "publication.task.title", WORKSPACE_TASK_TITLE_MAX_BYTES);
    const objective = persistentString(rowString(source, ["description", "title"]), "publication.task.objective", PERSISTENT_WORKSPACE_OBJECTIVE_MAX_BYTES, true);
    const storedState = rowString(source, ["state"]);
    const state = publicationTaskState(storedState);
    const progressPercent = finiteNumber(rowNumber(source, ["progress"]), "publication.task.progress", 0, 1);
    const summary = persistentString(rowString(source, ["summary"]), "publication.task.summary", WORKSPACE_TASK_SUMMARY_MAX_BYTES, true);
    const progressSummary = persistentString(summary, "publication.task.progress.summary", PERSISTENT_WORKSPACE_PROGRESS_MAX_BYTES, true);
    const dependencyIds = identifierList(persistentParsedJson<unknown[]>(source.dependencies_json, "publication.task.dependencies", []), "publication.task.dependencies");
    if (dependencyIds.length > PERSISTENT_WORKSPACE_MAX_DEPENDENCIES) persistentFail("quota_exceeded", "publication task dependencies exceed their limit");
    const sourceRevision = integer(rowNumber(source, ["revision"]), "publication.task.sourceRevision", 0, Number.MAX_SAFE_INTEGER);
    const sourceDigest = publicationDigest({ title, objective, state: storedState, required: rowNumber(source, ["required"]) === 1, dependencyIds, progress: progressPercent, summary }, "publication.task");
    assertPublicationSourceDigest(input, sourceDigest);
    if (input.sourceRevision !== undefined && input.sourceRevision !== sourceRevision) persistentFail("stale_revision", "task source revision is stale");
    const sourceUpdatedAt = integer(rowNumber(source, ["updated_at"]), "publication.task.updatedAt", 0, Number.MAX_SAFE_INTEGER);
    const progress = persistentProgress({ state: publicationTaskProgressState(storedState), percent: progressPercent, summary: progressSummary, updatedAt: sourceUpdatedAt }, "publication.task.progress", false, sourceUpdatedAt);
    const sourceChatId = rowNullableString(source, ["chat_id"]);
    const links = publicationSourceExecutionLinks(session, sourceChatId);
    return {
      sourceId: input.sourceId,
      copy: { category: "task", id: input.sourceId, title, objective, state, required: rowNumber(source, ["required"]) === 1, dependencyIds, progress, summary },
      sourceRevision,
      sourceDigest,
      sourceCreatedAt: integer(rowNumber(source, ["created_at"]), "publication.task.createdAt", 0, Number.MAX_SAFE_INTEGER),
      sourceUpdatedAt,
      sourceTurnSessionId: session.id,
      sourceAttemptId: session.attemptId,
      sourceExecutionId: session.executionId,
      sourceChatId,
      sourceMessageId: links.messageId,
      sourceSwipeId: links.swipeId,
    };
  }
  if (input.category === "finding") {
    const source = operationalSourceRows("agent_workspace_records", workspace, input, "record_id = ? AND kind = 'finding'", [input.sourceId])[0];
    if (!source) persistentFail("not_found", "finding source was not found");
    const turnId = idValue(rowString(source, ["turn_id"]), "publication.finding.turnId");
    const session = publicationSessionForTurn(workspace, input, turnId);
    const summary = persistentString(rowString(source, ["summary"]), "publication.finding.summary", PERSISTENT_WORKSPACE_RECORD_MAX_BYTES);
    const taskIdValue = rowNullableString(source, ["task_id"]);
    const taskId = taskIdValue === null ? null : idValue(taskIdValue, "publication.finding.taskId");
    if (taskId !== null && !operationalSourceRows("agent_workspace_tasks", workspace, input, "task_id = ? AND turn_id = ?", [taskId, turnId])[0]) persistentFail("not_found", "finding task association was not found");
    const sourceFrameId = rowNullableString(source, ["source_frame_id"]);
    const provenance = sourceFrameId === null ? null : persistentString(sourceFrameId, "publication.finding.provenance", PERSISTENT_WORKSPACE_PROVENANCE_MAX_BYTES);
    const sourceDigestCandidate = rowString(source, ["digest"]);
    const sourceDigest = DIGEST.test(sourceDigestCandidate) ? sourceDigestCandidate : publicationDigest({ summary, taskId, provenance }, "publication.finding");
    assertPublicationSourceDigest(input, sourceDigest);
    const sourceRevision = integer(rowNumber(source, ["revision"]), "publication.finding.sourceRevision", 0, Number.MAX_SAFE_INTEGER);
    if (input.sourceRevision !== undefined && input.sourceRevision !== sourceRevision) persistentFail("stale_revision", "finding source revision is stale");
    const sourceChatId = rowNullableString(source, ["chat_id"]);
    const links = publicationSourceExecutionLinks(session, sourceChatId);
    const content: PersistentWorkspaceRecordContentV1 = Object.freeze({ summary, evidenceIds: [], provenance });
    return {
      sourceId: input.sourceId,
      copy: { category: "finding", id: input.sourceId, content, taskId },
      sourceRevision,
      sourceDigest,
      sourceCreatedAt: integer(rowNumber(source, ["created_at"]), "publication.finding.createdAt", 0, Number.MAX_SAFE_INTEGER),
      sourceUpdatedAt: integer(rowNumber(source, ["created_at", "updated_at"]), "publication.finding.updatedAt", 0, Number.MAX_SAFE_INTEGER),
      sourceTurnSessionId: session.id,
      sourceAttemptId: session.attemptId,
      sourceExecutionId: session.executionId,
      sourceChatId,
      sourceMessageId: links.messageId,
      sourceSwipeId: links.swipeId,
    };
  }
  const source = operationalSourceRows("agent_workspace_artifacts", workspace, input, "artifact_id = ?", [input.sourceId])[0];
  if (!source) persistentFail("not_found", "artifact source was not found");
  const turnId = idValue(rowString(source, ["turn_id"]), "publication.artifact.turnId");
  const session = publicationSessionForTurn(workspace, input, turnId);
  const blobDigest = persistentString(rowString(source, ["blob_digest"]), "publication.artifact.blobDigest", 64);
  if (!DIGEST.test(blobDigest)) persistentFail("invalid_state", "artifact source digest is invalid");
  const mimeType = persistentString(rowString(source, ["mime_type"]), "publication.artifact.mimeType", 255);
  if (!MIME.test(mimeType)) persistentFail("invalid_input", "artifact source MIME type is invalid");
  const byteCount = integer(rowNumber(source, ["byte_count"]), "publication.artifact.byteCount", 0, 2_147_483_648);
  const provenanceRaw = persistentString(rowString(source, ["provenance_json"], "{}"), "publication.artifact.provenance", PERSISTENT_WORKSPACE_PROVENANCE_MAX_BYTES, true);
  let provenanceParsed: unknown;
  try { provenanceParsed = JSON.parse(provenanceRaw); } catch { persistentFail("invalid_state", "artifact source provenance is malformed"); }
  assertNoPrivateFields(provenanceParsed, "publication.artifact.provenance");
  const sourceDigest = blobDigest;
  assertPublicationSourceDigest(input, sourceDigest);
  const sourceRevision = integer(rowNumber(source, ["revision"]), "publication.artifact.sourceRevision", 0, Number.MAX_SAFE_INTEGER);
  if (input.sourceRevision !== undefined && input.sourceRevision !== sourceRevision) persistentFail("stale_revision", "artifact source revision is stale");
  const sourceChatId = rowNullableString(source, ["chat_id"]);
  const links = publicationSourceExecutionLinks(session, sourceChatId);
  return {
    sourceId: input.sourceId,
    copy: { category: "artifact", id: input.sourceId, blobDigest, mimeType, byteCount, provenance: provenanceRaw },
    sourceRevision,
    sourceDigest,
    sourceCreatedAt: integer(rowNumber(source, ["created_at"]), "publication.artifact.createdAt", 0, Number.MAX_SAFE_INTEGER),
    sourceUpdatedAt: integer(rowNumber(source, ["updated_at"]), "publication.artifact.updatedAt", 0, Number.MAX_SAFE_INTEGER),
    sourceTurnSessionId: session.id,
    sourceAttemptId: session.attemptId,
    sourceExecutionId: session.executionId,
    sourceChatId,
    sourceMessageId: links.messageId,
    sourceSwipeId: links.swipeId,
  };
}

function persistentSourceExists(workspace: PersistentWorkspaceRow, category: string, sourceId: string, provenance: PersistentWorkspacePublicationProvenanceV1): boolean {
  const database = getDb();
  if (!provenance.turnSessionId || !provenance.sourceChatId) return false;
  const ownerId = idValue(workspace.userId, "publication.workspace.userId");
  const workspaceId = idValue(workspace.id, "publication.workspaceId");
  const sourceIdValue = idValue(sourceId, "publication.sourceId");
  const sourceChatId = idValue(provenance.sourceChatId, "publication.sourceChatId");
  if (!tableExists(database, "persistent_workspace_turn_sessions")) {
    persistentFail("schema_unavailable", "persistent turn-session schema is unavailable");
  }
  if (provenance.sourceMessageId !== null) {
    if (!tableExists(database, "messages")) persistentFail("schema_unavailable", "message schema is unavailable");
    const sourceMessage = database.query(
      "SELECT swipes FROM messages WHERE id = ? AND chat_id = ? LIMIT 1",
    ).get(provenance.sourceMessageId, sourceChatId) as Record<string, unknown> | null;
    if (!sourceMessage) return false;
    if (provenance.sourceSwipeId !== null) {
      const swipes = jsonArray(sourceMessage.swipes);
      if (provenance.sourceSwipeId < 0 || provenance.sourceSwipeId >= swipes.length) return false;
    }
  }
  const session = database.query(
    "SELECT turn_id, chat_id FROM persistent_workspace_turn_sessions WHERE turn_session_id = ? AND workspace_id = ? AND user_id = ? LIMIT 1",
  ).get(provenance.turnSessionId, workspaceId, ownerId) as Record<string, unknown> | null;
  if (!session) return false;
  const sessionChatId = rowNullableString(session, ["chat_id"]);
  if (sessionChatId !== null && sessionChatId !== sourceChatId) return false;
  const sourceTurnId = idValue(rowString(session, ["turn_id"]), "publication.sourceTurnId");
  const scope = [ownerId, sourceChatId, sourceTurnId] as const;
  if (category === "objective") {
    if (!tableExists(database, "agent_turn_workspaces")) persistentFail("schema_unavailable", "turn workspace schema is unavailable");
    return database.query(
      "SELECT 1 FROM agent_turn_workspaces WHERE workspace_id = ? AND user_id = ? AND chat_id = ? AND turn_id = ? LIMIT 1",
    ).get(sourceIdValue, ...scope) !== null;
  }
  const table = category === "task" ? "agent_workspace_tasks" : category === "finding" ? "agent_workspace_records" : category === "artifact" ? "agent_workspace_artifacts" : "";
  if (!table) persistentFail("invalid_state", "publication category is invalid");
  if (!tableExists(database, table)) persistentFail("schema_unavailable", `${table} schema is unavailable`);
  const idColumn = category === "task" ? "task_id" : category === "finding" ? "record_id" : "artifact_id";
  const kind = category === "finding" ? " AND kind = 'finding'" : "";
  return database.query(
    `SELECT 1 FROM ${quoteIdentifier(table)}
      WHERE ${quoteIdentifier(idColumn)} = ? AND user_id = ? AND chat_id = ? AND turn_id = ?${kind}
      LIMIT 1`,
  ).get(sourceIdValue, ...scope) !== null;
}
function persistPublicationSourceDeletion(
  raw: Record<string, unknown>,
  workspace: PersistentWorkspaceRow,
  provenance: PersistentWorkspacePublicationProvenanceV1,
  sourceDeletedAt: number,
): Record<string, unknown> {
  const database = getDb();
  const publicationId = rowString(raw, ["publication_id"]);
  const sourceProvenanceJson = rowString(raw, ["source_provenance_json"]);
  const stampedProvenance = Object.freeze({ ...provenance, sourceDeletedAt });
  const stampedProvenanceJson = persistentJson(stampedProvenance, "publication.provenance", PERSISTENT_WORKSPACE_PROVENANCE_MAX_BYTES);
  database.transaction(() => {
    database.query(
      `UPDATE persistent_workspace_publications
          SET source_deleted_at = ?, source_provenance_json = ?
        WHERE publication_id = ? AND workspace_id = ? AND user_id = ?
          AND source_deleted_at IS NULL
          AND source_provenance_json = ?`,
    ).run(sourceDeletedAt, stampedProvenanceJson, publicationId, workspace.id, workspace.userId, sourceProvenanceJson);
  })();
  const refreshed = database.query(
    "SELECT * FROM persistent_workspace_publications WHERE publication_id = ? AND workspace_id = ? AND user_id = ? LIMIT 1",
  ).get(publicationId, workspace.id, workspace.userId) as Record<string, unknown> | null;
  if (!refreshed) persistentFail("not_found", "persistent publication disappeared while recording source deletion");
  if (refreshed.source_deleted_at === null || refreshed.source_deleted_at === undefined) {
    persistentFail("stale_revision", "persistent publication source deletion marker was not persisted");
  }
  return refreshed;
}


function persistentPublicationFromRow(raw: Record<string, unknown>, workspace: PersistentWorkspaceRow): PersistentWorkspacePublication {
  const category = rowString(raw, ["category"]) as PersistentWorkspacePublication["category"];
  if (!(WORKSPACE_PUBLICATION_CATEGORIES as readonly string[]).includes(category)) persistentFail("invalid_state", "publication category is invalid");
  const copy = persistentParsedJson<PersistentWorkspacePublicationCopyV1>(raw.copy_json, "publication.copy", {} as PersistentWorkspacePublicationCopyV1);
  if (!isRecord(copy) || copy.category !== category) persistentFail("invalid_state", "publication copy category is invalid");
  persistentJson(copy, "publication.copy", PERSISTENT_WORKSPACE_COPY_MAX_BYTES);
  const sourceDigest = publicationSourceDigest(raw, copy);
  const sourceId = rowString(raw, ["source_id"]);
  const provenanceValue = persistentParsedJson<Record<string, unknown>>(raw.source_provenance_json, "publication.provenance", {});
  const provenanceSourceDeletedAt = typeof provenanceValue.sourceDeletedAt === "number" ? provenanceValue.sourceDeletedAt : null;
  const provenance: PersistentWorkspacePublicationProvenanceV1 = Object.freeze({
    workspaceId: typeof provenanceValue.workspaceId === "string" ? provenanceValue.workspaceId : workspace.id,
    turnSessionId: typeof provenanceValue.turnSessionId === "string" ? provenanceValue.turnSessionId : null,
    attemptId: typeof provenanceValue.attemptId === "string" ? provenanceValue.attemptId : null,
    executionId: typeof provenanceValue.executionId === "string" ? provenanceValue.executionId : null,
    sourceDigest,
    sourceChatId: typeof provenanceValue.sourceChatId === "string" ? provenanceValue.sourceChatId : rowNullableString(raw, ["chat_id"]),
    sourceMessageId: typeof provenanceValue.sourceMessageId === "string" ? provenanceValue.sourceMessageId : null,
    sourceSwipeId: typeof provenanceValue.sourceSwipeId === "number" ? provenanceValue.sourceSwipeId : null,
    sourceDeletedAt: provenanceSourceDeletedAt,
    creator: typeof provenanceValue.creator === "string" ? provenanceValue.creator : rowString(raw, ["published_by"]),
    capturedAt: typeof provenanceValue.capturedAt === "number" ? provenanceValue.capturedAt : rowNumber(raw, ["published_at"]),
  });
  const present = persistentSourceExists(workspace, category, sourceId, provenance);
  const recordedSourceDeletedAt = raw.source_deleted_at === null || raw.source_deleted_at === undefined
    ? null
    : rowNumber(raw, ["source_deleted_at"]);
  if (!present && recordedSourceDeletedAt === null && provenance.sourceDeletedAt === null) {
    const stamped = persistPublicationSourceDeletion(raw, workspace, provenance, Math.floor(Date.now() / 1000));
    return persistentPublicationFromRow(stamped, workspace);
  }
  const sourceDeletedAt = recordedSourceDeletedAt ?? provenance.sourceDeletedAt ?? null;
  const safeProvenance = sourceDeletedAt === provenance.sourceDeletedAt
    ? provenance
    : Object.freeze({ ...provenance, sourceDeletedAt });
  return deepFreeze({
    version: 1,
    id: rowString(raw, ["publication_id"]),
    workspaceId: rowString(raw, ["workspace_id"]),
    userId: rowString(raw, ["user_id"]),
    chatId: rowNullableString(raw, ["chat_id"]),
    category,
    sourceId,
    sourceRevision: rowNumber(raw, ["source_revision"]),
    sourceDigest,
    sourceProvenance: safeProvenance,
    sourceCreatedAt: rowNumber(raw, ["source_created_at"]),
    sourceUpdatedAt: rowNumber(raw, ["source_updated_at"]),
    sourceDeletedAt,
    sourceStatus: present ? "present" : "deleted",
    copy,
    copyDigest: rowString(raw, ["copy_digest"]),
    publishedAt: rowNumber(raw, ["published_at"]),
    publishedBy: rowString(raw, ["published_by"]),
    revision: 1,
  });
}

function persistentPublicationRowsForSource(workspace: PersistentWorkspaceRow, category: string, sourceId: string, sourceRevision?: number): Array<Record<string, unknown>> {
  const database = getDb();
  if (!tableExists(database, "persistent_workspace_publications")) persistentFail("schema_unavailable", "persistent publication schema is unavailable");
  const revisionPredicate = sourceRevision === undefined ? "" : " AND source_revision = ?";
  const values = sourceRevision === undefined ? [workspace.id, workspace.userId, category, sourceId] : [workspace.id, workspace.userId, category, sourceId, sourceRevision];
  return database.query(`SELECT * FROM persistent_workspace_publications WHERE workspace_id = ? AND user_id = ? AND category = ? AND source_id = ?${revisionPredicate} ORDER BY published_at ASC, rowid ASC`).all(...values) as Array<Record<string, unknown>>;
}

function assertIdempotentPublicationDigest(input: PublishPersistentWorkspaceSelectionInputV1, row: Record<string, unknown>): void {
  if (input.sourceDigest === undefined) return;
  const copy = persistentParsedJson<PersistentWorkspacePublicationCopyV1>(row.copy_json, "publication.copy", {} as PersistentWorkspacePublicationCopyV1);
  if (input.sourceDigest !== publicationSourceDigest(row, copy)) persistentFail("stale_revision", "publication source digest is stale");
}


function persistentPublicationSelectionFromRow(raw: Record<string, unknown>): PersistentPublicationSelectionV1 {
  const copy = persistentParsedJson<PersistentWorkspacePublicationCopyV1>(raw.copy_json, "publication.copy", {} as PersistentWorkspacePublicationCopyV1);
  if (!isRecord(copy) || !(WORKSPACE_PUBLICATION_CATEGORIES as readonly string[]).includes(copy.category)) {
    persistentFail("invalid_state", "publication copy category is invalid");
  }
  persistentJson(copy, "publication.copy", PERSISTENT_WORKSPACE_COPY_MAX_BYTES);
  const provenance = persistentParsedJson<Record<string, unknown>>(raw.source_provenance_json, "publication.provenance", {});
  const sourceExecutionId = provenance.executionId === null || provenance.executionId === undefined
    ? null
    : idValue(provenance.executionId, "publication.provenance.executionId");
  const sourceSwipeId = provenance.sourceSwipeId === null || provenance.sourceSwipeId === undefined
    ? null
    : integer(provenance.sourceSwipeId, "publication.provenance.sourceSwipeId", 0, Number.MAX_SAFE_INTEGER);
  return {
    sourceId: idValue(rowString(raw, ["source_id"]), "publication.sourceId"),
    copy,
    sourceRevision: integer(rowNumber(raw, ["source_revision"], -1), "publication.sourceRevision", 0, Number.MAX_SAFE_INTEGER),
    sourceDigest: publicationSourceDigest(raw, copy),
    sourceCreatedAt: integer(rowNumber(raw, ["source_created_at"], -1), "publication.sourceCreatedAt", 0, Number.MAX_SAFE_INTEGER),
    sourceUpdatedAt: integer(rowNumber(raw, ["source_updated_at"], -1), "publication.sourceUpdatedAt", 0, Number.MAX_SAFE_INTEGER),
    sourceTurnSessionId: idValue(provenance.turnSessionId, "publication.provenance.turnSessionId"),
    sourceAttemptId: idValue(provenance.attemptId, "publication.provenance.attemptId"),
    sourceExecutionId,
    sourceChatId: typeof provenance.sourceChatId === "string" ? provenance.sourceChatId : rowNullableString(raw, ["chat_id"]),
    sourceMessageId: typeof provenance.sourceMessageId === "string" ? provenance.sourceMessageId : null,
    sourceSwipeId,
  };
}

function assertPublicationRowMatchesSelection(
  selection: PersistentPublicationSelectionV1,
  row: Record<string, unknown>,
): void {
  assertPublicationSelectionCurrent(selection, persistentPublicationSelectionFromRow(row));
}

function persistentPublicationSelectionDigest(selection: PersistentPublicationSelectionV1): string {
  return publicationDigest(selection, "publication.selection");
}

function assertPublicationSelectionCurrent(
  expected: PersistentPublicationSelectionV1,
  actual: PersistentPublicationSelectionV1,
  expectedDigest = persistentPublicationSelectionDigest(expected),
): void {
  if (persistentPublicationSelectionDigest(actual) !== expectedDigest) {
    persistentFail("stale_revision", "publication source changed during publication");
  }
}

function persistentArtifactPublicationDigest(row: Record<string, unknown>): string | null {
  if (rowString(row, ["category"]) !== "artifact") return null;
  const copy = persistentParsedJson<PersistentWorkspacePublicationCopyV1>(row.copy_json, "publication.copy", {} as PersistentWorkspacePublicationCopyV1);
  if (!isRecord(copy) || copy.category !== "artifact" || typeof copy.blobDigest !== "string" || !DIGEST.test(copy.blobDigest)) {
    persistentFail("invalid_state", "persistent artifact publication copy is malformed");
  }
  return copy.blobDigest;
}

function withPersistentArtifactDeletionFences<T>(
  userId: string,
  digests: readonly string[],
  operation: () => T,
): T {
  const uniqueDigests = [...new Set(digests)].sort();
  const enter = (index: number): T => {
    if (index >= uniqueDigests.length) return operation();
    return withArtifactDeletionFence(userId, uniqueDigests[index]!, () => enter(index + 1));
  };
  return enter(0);
}

export function deletePersistentWorkspacePublication(raw: unknown): PersistentWorkspace {
  const input = validateDeletePersistentWorkspacePublication(raw);
  const workspace = requirePersistentPublicationWorkspace(input);
  const database = getDb();
  const row = database.query(
    "SELECT * FROM persistent_workspace_publications WHERE publication_id = ? AND workspace_id = ? AND user_id = ? LIMIT 1",
  ).get(input.publicationId, workspace.id, workspace.userId) as Record<string, unknown> | null;
  if (!row) persistentFail("not_found", "persistent publication was not found");
  const digest = persistentArtifactPublicationDigest(row);
  const now = Math.floor(Date.now() / 1000);
  const deleted = withPersistentArtifactDeletionFences(workspace.userId, digest === null ? [] : [digest], () => database.transaction(() => {
    const current = findPersistentPublicationWorkspace(input);
    if (!current || current.revision !== input.expectedRevision) {
      persistentFail("stale_revision", "persistent workspace changed during publication deletion");
    }
    const result = database.query(
      "DELETE FROM persistent_workspace_publications WHERE publication_id = ? AND workspace_id = ? AND user_id = ?",
    ).run(input.publicationId, current.id, current.userId);
    if (result.changes !== 1) persistentFail("not_found", "persistent publication was not found");
    if (digest !== null) releaseArtifactBlobReference(database, digest, current.userId);
    persistentCommitWorkspace(current, {}, now);
    return persistentWorkspaceSnapshot(persistentRefreshedWorkspace(current));
  })());
  return deleted;
}

export function deletePersistentWorkspace(raw: unknown): PersistentWorkspaceDeletionResultV1 {
  const input = validateDeletePersistentWorkspace(raw);
  const workspace = requirePersistentPublicationWorkspace(input);
  const database = getDb();
  const rows = database.query(
    "SELECT category, copy_json FROM persistent_workspace_publications WHERE workspace_id = ? AND user_id = ?",
  ).all(workspace.id, workspace.userId) as Array<Record<string, unknown>>;
  const digests = rows.map(persistentArtifactPublicationDigest).filter((digest): digest is string => digest !== null);
  const publicationCount = rows.length;
  const workspaceId = workspace.id;
  const userId = workspace.userId;
  const expectedRevision = input.expectedRevision;
  return withPersistentArtifactDeletionFences(userId, digests, () => database.transaction(() => {
    const current = database.query(
      "SELECT revision FROM persistent_workspaces WHERE workspace_id = ? AND user_id = ? LIMIT 1",
    ).get(workspaceId, userId) as Record<string, unknown> | null;
    if (!current || rowNumber(current, ["revision"]) !== expectedRevision) {
      persistentFail("stale_revision", "persistent workspace changed during workspace deletion");
    }
    database.query(
      "DELETE FROM persistent_workspaces WHERE workspace_id = ? AND user_id = ?",
    ).run(workspaceId, userId);
    if (database.query(
      "SELECT 1 AS present FROM persistent_workspaces WHERE workspace_id = ? AND user_id = ? LIMIT 1",
    ).get(workspaceId, userId) !== null) {
      persistentFail("stale_revision", "persistent workspace could not be deleted");
    }
    for (const digest of digests) releaseArtifactBlobReference(database, digest, userId);
    return Object.freeze({ workspaceId, deleted: true as const, publicationCount });
  })());
}

function validatePersistentPublicationActor(value: unknown): PersistentWorkspacePublicationActorV1 {
  if (!isRecord(value)) persistentFail("forbidden", "authenticated publication actor is required");
  if (value.kind === "owner") {
    return Object.freeze({ kind: "owner", userId: idValue(value.userId, "publication.actor.userId") });
  }
  if (value.kind === "host") {
    return Object.freeze({ kind: "host", authority: requirePersistentWorkspaceHostAuthority(value.authority) });
  }
  persistentFail("forbidden", "publication actor is invalid");
}

export function publishPersistentWorkspaceSelection(
  actorRaw: unknown,
  raw?: unknown,
): PersistentWorkspacePublication {
  let actorValue = actorRaw;
  let selectionRaw = raw;
  if (raw === undefined) {
    if (!isRecord(actorRaw) || !Object.hasOwn(actorRaw, "actor")) persistentFail("forbidden", "authenticated publication actor is required");
    actorValue = actorRaw.actor;
    const { actor: _actor, ...selection } = actorRaw;
    selectionRaw = selection;
  }
  const actor = validatePersistentPublicationActor(actorValue);
  const input = validatePersistentPublication(selectionRaw);
  if (actor.kind === "owner" && actor.userId !== input.userId) {
    persistentFail("forbidden", "publication owner actor does not match workspace owner");
  }
  const publishedBy = actor.kind === "owner" ? `owner:${actor.userId}` : "host";
  const context = persistentContext(input, "persistentPublication");
  const workspace = persistentWritableWorkspace(context, "deferred");
  const canonicalSourceId = input.sourceId;
  // An omitted revision means "publish the current operational source", not
  // "replay whichever immutable copy happens to exist for this source ID".
  // Resolve that source before consulting idempotency so an update cannot be
  // mistaken for an already-published historical revision.
  const resolvedSelection = input.sourceRevision === undefined
    ? persistentPublicationCopy(workspace, input)
    : null;
  const resolvedSourceRevision = resolvedSelection?.sourceRevision ?? input.sourceRevision;
  const existing = resolvedSourceRevision === undefined
    ? null
    : persistentPublicationRowsForSource(workspace, input.category, canonicalSourceId, resolvedSourceRevision)[0] ?? null;
  if (existing && !resolvedSelection) {
    assertIdempotentPublicationDigest(input, existing);
    return persistentPublicationFromRow(existing, persistentRefreshedWorkspace(workspace));
  }
  if (!existing && workspace.revision !== input.expectedRevision) persistentFail("stale_revision", "persistent workspace revision is stale", { expected: input.expectedRevision, actual: workspace.revision });
  const selected = resolvedSelection ?? persistentPublicationCopy(workspace, input);
  const copyJson = persistentJson(selected.copy, "publication.copy", PERSISTENT_WORKSPACE_COPY_MAX_BYTES);
  const provenance: PersistentWorkspacePublicationProvenanceV1 = Object.freeze({
    workspaceId: workspace.id,
    turnSessionId: selected.sourceTurnSessionId,
    attemptId: selected.sourceAttemptId,
    executionId: selected.sourceExecutionId,
    sourceDigest: selected.sourceDigest,
    sourceChatId: selected.sourceChatId,
    sourceMessageId: selected.sourceMessageId,
    sourceSwipeId: selected.sourceSwipeId,
    sourceDeletedAt: null,
    creator: publishedBy,
    capturedAt: Math.floor(Date.now() / 1000),
  });
  const provenanceJson = persistentJson(provenance, "publication.provenance", PERSISTENT_WORKSPACE_PROVENANCE_MAX_BYTES);
  const publicationBytes = utf8ByteLength(copyJson) + utf8ByteLength(provenanceJson);
  const copyDigest = createHash("sha256").update(copyJson, "utf8").digest("hex");
  const publicationId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  let concurrent: Record<string, unknown> | null = null;
  const database = getDb();
  const artifactCopy = selected.copy.category === "artifact" ? selected.copy : undefined;
  const selectedDigest = persistentPublicationSelectionDigest(selected);
  const commitPublication = (): void => {
    database.transaction(() => {
      concurrent = persistentPublicationRowsForSource(workspace, input.category, selected.sourceId, selected.sourceRevision)[0] ?? null;
      const current = findPersistentPublicationWorkspace(context);
      if (!current) persistentFail("stale_revision", "persistent workspace changed during publication");
      if (resolvedSelection || !concurrent) {
        const currentSelection = persistentPublicationCopy(current, input);
        assertPublicationSelectionCurrent(selected, currentSelection, selectedDigest);
      }
      if (concurrent) {
        assertPublicationRowMatchesSelection(selected, concurrent);
        return;
      }
      if (current.revision !== input.expectedRevision) persistentFail("stale_revision", "persistent workspace changed during publication");
      const usage = persistentWorkspaceUsage(current);
      if (usage.publicationCount >= current.quota.maxPublications || usage.byteCount + publicationBytes > current.quota.maxBytes) persistentFail("quota_exceeded", "persistent workspace publication quota exceeded");
      if (artifactCopy) {
        assertArtifactBlobAvailable(database, {
          userId: current.userId,
          digest: artifactCopy.blobDigest,
          byteCount: artifactCopy.byteCount,
          mimeType: artifactCopy.mimeType,
        });
      }
      insertRow(database, "persistent_workspace_publications", {
        publication_id: publicationId,
        workspace_id: current.id,
        user_id: current.userId,
        chat_id: current.chatId,
        category: input.category,
        source_id: selected.sourceId,
        source_revision: selected.sourceRevision,
        source_provenance_json: provenanceJson,
        source_created_at: selected.sourceCreatedAt,
        source_updated_at: selected.sourceUpdatedAt,
        source_deleted_at: null,
        copy_json: copyJson,
        copy_digest: copyDigest,
        byte_count: publicationBytes,
        published_at: now,
        published_by: publishedBy,
        revision: 1,
      }, ["publication_id", "workspace_id", "user_id", "chat_id", "category", "source_id", "source_revision", "source_provenance_json", "source_created_at", "source_updated_at", "copy_json", "copy_digest", "byte_count", "published_at", "published_by", "revision"]);
      const committedSelection = persistentPublicationCopy(current, input);
      assertPublicationSelectionCurrent(selected, committedSelection, selectedDigest);
      if (artifactCopy) retainArtifactBlobReference(database, artifactCopy.blobDigest, current.userId);
      persistentCommitWorkspace(current, {}, now);
    })();
  };
  if (artifactCopy) {
    withArtifactDeletionFence(workspace.userId, artifactCopy.blobDigest, () => commitPublication());
  } else {
    commitPublication();
  }
  if (concurrent) {
    assertPublicationRowMatchesSelection(selected, concurrent);
    assertIdempotentPublicationDigest(input, concurrent);
    return persistentPublicationFromRow(concurrent, persistentRefreshedWorkspace(workspace));
  }
  const saved = database.query("SELECT * FROM persistent_workspace_publications WHERE publication_id = ? AND workspace_id = ? AND user_id = ? LIMIT 1").get(publicationId, workspace.id, workspace.userId) as Record<string, unknown> | null;
  if (!saved) persistentFail("not_found", "persistent publication was not created");
  return persistentPublicationFromRow(saved, persistentRefreshedWorkspace(workspace));
}


export function listPersistentWorkspacePublications(raw: unknown): readonly PersistentWorkspacePublication[] {
  const workspace = requirePersistentPublicationWorkspace(persistentContext(raw, "persistentPublications"));
  const rows = getDb().query("SELECT * FROM persistent_workspace_publications WHERE workspace_id = ? AND user_id = ? ORDER BY published_at ASC, rowid ASC").all(workspace.id, workspace.userId) as Array<Record<string, unknown>>;
  return Object.freeze(rows.map((row) => persistentPublicationFromRow(row, workspace)));
}
