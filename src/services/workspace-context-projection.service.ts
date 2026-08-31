import { createHash } from "node:crypto";
import type {
  WorkspaceArtifactReferenceV1,
  WorkspaceRecordV1,
  WorkspaceSubmissionV1,
  WorkspaceTaskV1,
} from "../types/turn-workspace";
import { getDb } from "../db/connection";
import {
  getTurnWorkspace,
  readTurnWorkspaceSection,
  type WorkspaceReadSection,
  type WorkspaceSectionPageV1,
} from "./turn-workspace.service";

export const WORKSPACE_CONTEXT_RECORD_CLASSES = [
  "accepted_submission",
  "finding",
  "optional_task",
  "artifact",
] as const;
export type WorkspaceContextRecordClass = (typeof WORKSPACE_CONTEXT_RECORD_CLASSES)[number];

export class WorkspaceContextProjectionError extends Error {
  readonly code = "workspace_context_limit_exceeded" as const;
  constructor(message = "The mandatory workspace context exceeds its reserved budget.") {
    super(message);
    this.name = "WorkspaceContextProjectionError";
  }
}

/** Projection-only instruction input; not a persistence record. */
export interface WorkspaceContextInstructionV1 {
  readonly id: string;
  readonly text: string;
  readonly sourceRevision?: number;
}

/** Projection-only task-state input for adapters and focused tests. */
export interface WorkspaceContextTaskSourceV1 {
  readonly id: string;
  readonly state: string;
  readonly text?: string;
  readonly summary?: string | null;
  readonly title?: string;
  readonly objective?: string;
  readonly required?: boolean;
  readonly activated?: boolean;
  readonly sourceRevision?: number;
  readonly revision?: number;
  readonly superseded?: boolean;
  readonly supersededBy?: string | null;
  readonly progress?: number | readonly WorkspaceContextTaskProgressV1[];
  readonly stateHistory?: readonly WorkspaceContextTaskProgressV1[];
}
export interface WorkspaceContextTaskProgressV1 {
  readonly state: string;
  readonly text?: string;
  readonly summary?: string | null;
  readonly sourceRevision?: number;
  readonly revision?: number;
  readonly superseded?: boolean;
  readonly supersededBy?: string | null;
}

export interface WorkspaceContextDecisionSourceV1 {
  readonly id: string;
  readonly text: string;
  readonly accepted?: boolean;
  readonly status?: string;
  readonly sourceRevision?: number;
}
export interface WorkspaceContextQuestionSourceV1 {
  readonly id: string;
  readonly text: string;
  readonly resolved?: boolean;
  readonly status?: string;
  readonly sourceRevision?: number;
}

/** Projection-only evidence. Raw work, reasoning, tools, and carrier fields are never read. */
export interface WorkspaceContextEvidenceSourceV1 {
  readonly id: string;
  readonly class: WorkspaceContextRecordClass;
  readonly text?: string;
  readonly summary?: string | null;
  readonly digest?: string;
  readonly sourceRevision?: number;
  readonly mimeType?: string;
}

export interface WorkspaceContextProjectionInputV1 {
  readonly workspaceRevision: number;
  readonly objective: WorkspaceContextInstructionV1 | string;
  readonly constraints?: readonly (WorkspaceContextInstructionV1 | string)[];
  /** Normalized projection views. */
  readonly requiredTasks?: readonly WorkspaceContextTaskSourceV1[];
  readonly acceptedDecisions?: readonly WorkspaceContextDecisionSourceV1[];
  readonly unresolvedQuestions?: readonly WorkspaceContextQuestionSourceV1[];
  readonly evidence?: readonly WorkspaceContextEvidenceSourceV1[];
  /** Canonical turn-workspace snapshot views. */
  readonly tasks?: readonly WorkspaceTaskV1[];
  readonly records?: readonly WorkspaceRecordV1[];
  readonly submissions?: readonly WorkspaceSubmissionV1[];
  readonly artifacts?: readonly WorkspaceArtifactReferenceV1[];
}

export interface WorkspaceContextProjectionLimitsV1 {
  readonly reservedBytes: number;
}

export type WorkspaceContextMandatoryRecordKind =
  | "objective"
  | "constraint"
  | "required_task"
  | "accepted_decision"
  | "unresolved_question";

export interface WorkspaceContextProjectionRecordV1 {
  readonly kind: WorkspaceContextMandatoryRecordKind | WorkspaceContextRecordClass;
  readonly id: string;
  readonly text: string;
  readonly sourceRevision: number;
  readonly taskState?: string;
}

export interface WorkspaceContextOmissionIndexV1 {
  readonly class: WorkspaceContextRecordClass;
  readonly omittedCount: number;
  readonly firstOmittedCursor: string | null;
}

export interface WorkspaceContextProjectionV1 {
  readonly version: 1;
  readonly sourceWorkspaceRevision: number;
  readonly mandatory: readonly WorkspaceContextProjectionRecordV1[];
  readonly optional: readonly WorkspaceContextProjectionRecordV1[];
  readonly omissions: readonly WorkspaceContextOmissionIndexV1[];
  readonly literal: string;
  readonly utf8Bytes: number;
}
/**
 * Authenticated owner-bound read coordinates. `expectedRevision` is the
 * persisted row revision and is always checked. `sourceWorkspaceRevision`
 * may name the immediately prospective acceptance revision while the caller
 * holds the surrounding workspace transaction.
 */
export interface WorkspaceContextProjectionWorkspaceRequestV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly sourceWorkspaceRevision?: number;
}

export class WorkspaceContextProjectionSnapshotError extends Error {
  readonly code = "workspace_context_snapshot_limit_exceeded" as const;
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceContextProjectionSnapshotError";
  }
}

const WORKSPACE_CONTEXT_SNAPSHOT_PAGE_SIZE = 100;
const WORKSPACE_CONTEXT_SNAPSHOT_MAX_ROWS = 1024;


const encoder = new TextEncoder();
const classOrder = new Map<WorkspaceContextRecordClass, number>(
  WORKSPACE_CONTEXT_RECORD_CLASSES.map((recordClass, index) => [recordClass, index]),
);

export function compareUtf8Ids(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.byteLength - b.byteLength;
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function revision(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Workspace source revision is invalid.");
  return value;
}
function workspaceRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Workspace revision is invalid.");
  return value;
}
function reservedBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Workspace context budget is invalid.");
  return value;
}
function id(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("Workspace context IDs must be non-empty.");
  return value;
}
function text(value: string | null | undefined, fallback?: string | null): string {
  const result = value ?? fallback ?? "";
  if (typeof result !== "string") throw new TypeError("Workspace context text must be a string.");
  return result;
}
function shorthandConstraintId(value: string): string {
  return `constraint-${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
function frozenRecord(record: WorkspaceContextProjectionRecordV1): WorkspaceContextProjectionRecordV1 {
  return Object.freeze({
    kind: record.kind,
    id: record.id,
    text: record.text,
    sourceRevision: record.sourceRevision,
    ...(record.taskState === undefined ? {} : { taskState: record.taskState }),
  });
}
function renderRecord(record: WorkspaceContextProjectionRecordV1): string {
  const state = record.taskState === undefined ? "" : ` state=${JSON.stringify(record.taskState)}`;
  return `${record.kind} ${JSON.stringify(record.id)}${state}: ${JSON.stringify(record.text)}\n`;
}

export type WorkspaceContextProjectionSurfaceV1 = "work" | "render";
export interface WorkspaceContextProjectionValidationOptionsV1 {
  readonly surface: WorkspaceContextProjectionSurfaceV1;
  readonly expectedRevision?: number;
  readonly maxUtf8Bytes: number;
}

const WORKSPACE_CONTEXT_PROJECTION_MAX_RECORDS = WORKSPACE_CONTEXT_SNAPSHOT_MAX_ROWS * 8;
const MANDATORY_WORKSPACE_CONTEXT_KINDS = new Set<WorkspaceContextProjectionRecordV1["kind"]>([
  "objective",
  "constraint",
  "required_task",
  "accepted_decision",
  "unresolved_question",
]);
const OPTIONAL_WORKSPACE_CONTEXT_KINDS = new Set<WorkspaceContextRecordClass>(
  WORKSPACE_CONTEXT_RECORD_CLASSES,
);
const RENDER_WORKSPACE_CONTEXT_KINDS = new Set<WorkspaceContextRecordClass>([
  "accepted_submission",
  "finding",
]);

function projectionObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactProjectionKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new TypeError(`${label} contains unknown or missing fields.`);
  }
}

function validateProjectionRecord(
  value: unknown,
  allowedKinds: ReadonlySet<WorkspaceContextProjectionRecordV1["kind"]>,
  label: string,
): WorkspaceContextProjectionRecordV1 {
  const record = projectionObject(value, label);
  const allowedKeys = record.taskState === undefined
    ? ["kind", "id", "text", "sourceRevision"]
    : ["kind", "id", "text", "sourceRevision", "taskState"];
  exactProjectionKeys(record, allowedKeys, label);
  if (
    typeof record.kind !== "string"
    || !allowedKinds.has(record.kind as WorkspaceContextProjectionRecordV1["kind"])
    || typeof record.id !== "string"
    || record.id.length === 0
    || typeof record.text !== "string"
    || !Number.isSafeInteger(record.sourceRevision)
    || (record.sourceRevision as number) < 0
    || (record.taskState !== undefined && (
      record.kind !== "required_task"
      || typeof record.taskState !== "string"
    ))
  ) {
    throw new TypeError(`${label} is malformed.`);
  }
  return frozenRecord({
    kind: record.kind as WorkspaceContextProjectionRecordV1["kind"],
    id: record.id,
    text: record.text,
    sourceRevision: record.sourceRevision as number,
    ...(record.taskState === undefined ? {} : { taskState: record.taskState as string }),
  });
}

function validateProjectionOmission(
  value: unknown,
  expectedClass: WorkspaceContextRecordClass,
  label: string,
): WorkspaceContextOmissionIndexV1 {
  const omission = projectionObject(value, label);
  exactProjectionKeys(omission, ["class", "omittedCount", "firstOmittedCursor"], label);
  if (
    omission.class !== expectedClass
    || !Number.isSafeInteger(omission.omittedCount)
    || (omission.omittedCount as number) < 0
    || (
      omission.firstOmittedCursor !== null
      && (
        typeof omission.firstOmittedCursor !== "string"
        || omission.firstOmittedCursor.length === 0
        || utf8ByteLength(omission.firstOmittedCursor) > 512
      )
    )
  ) {
    throw new TypeError(`${label} is malformed.`);
  }
  return Object.freeze({
    class: expectedClass,
    omittedCount: omission.omittedCount as number,
    firstOmittedCursor: omission.firstOmittedCursor as string | null,
  });
}

/**
 * Validate and clone an injected projection before it can become provider
 * input. The literal must be the exact deterministic rendering of the
 * admitted records; callers cannot smuggle a second private prompt carrier.
 */
export function validateWorkspaceContextProjectionV1(
  value: unknown,
  options: WorkspaceContextProjectionValidationOptionsV1,
): WorkspaceContextProjectionV1 {
  if (
    !Number.isSafeInteger(options.maxUtf8Bytes)
    || options.maxUtf8Bytes < 0
    || (
      options.expectedRevision !== undefined
      && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0)
    )
  ) {
    throw new TypeError("Workspace projection validation limits are invalid.");
  }
  const projection = projectionObject(value, "workspace projection");
  exactProjectionKeys(
    projection,
    ["version", "sourceWorkspaceRevision", "mandatory", "optional", "omissions", "literal", "utf8Bytes"],
    "workspace projection",
  );
  if (
    projection.version !== 1
    || !Number.isSafeInteger(projection.sourceWorkspaceRevision)
    || (projection.sourceWorkspaceRevision as number) < 0
    || (
      options.expectedRevision !== undefined
      && projection.sourceWorkspaceRevision !== options.expectedRevision
    )
    || !Array.isArray(projection.mandatory)
    || !Array.isArray(projection.optional)
    || !Array.isArray(projection.omissions)
    || typeof projection.literal !== "string"
    || !Number.isSafeInteger(projection.utf8Bytes)
  ) {
    throw new TypeError("Workspace projection envelope is malformed.");
  }
  if (
    projection.mandatory.length > WORKSPACE_CONTEXT_PROJECTION_MAX_RECORDS
    || projection.optional.length > WORKSPACE_CONTEXT_PROJECTION_MAX_RECORDS
    || projection.mandatory.length + projection.optional.length > WORKSPACE_CONTEXT_PROJECTION_MAX_RECORDS
  ) {
    throw new TypeError("Workspace projection contains too many records.");
  }
  if (options.surface === "render" && projection.mandatory.length !== 0) {
    throw new TypeError("RENDER workspace projection cannot contain mandatory WORK records.");
  }
  const mandatory = projection.mandatory.map((record, index) =>
    validateProjectionRecord(record, MANDATORY_WORKSPACE_CONTEXT_KINDS, `mandatory[${index}]`));
  const optionalKinds = options.surface === "render"
    ? RENDER_WORKSPACE_CONTEXT_KINDS
    : OPTIONAL_WORKSPACE_CONTEXT_KINDS;
  const optional = projection.optional.map((record, index) =>
    validateProjectionRecord(record, optionalKinds, `optional[${index}]`));
  for (let index = 1; index < mandatory.length; index += 1) {
    if (compareMandatory(mandatory[index - 1]!, mandatory[index]!) > 0) {
      throw new TypeError("Workspace mandatory records are not canonically ordered.");
    }
  }
  for (let index = 1; index < optional.length; index += 1) {
    const left = optional[index - 1]!;
    const right = optional[index]!;
    if (compareOptional(
      { ...left, class: left.kind as WorkspaceContextRecordClass },
      { ...right, class: right.kind as WorkspaceContextRecordClass },
    ) > 0) {
      throw new TypeError("Workspace optional records are not canonically ordered.");
    }
  }
  const expectedOmissionClasses = options.surface === "render"
    ? ["accepted_submission", "finding"] as const
    : WORKSPACE_CONTEXT_RECORD_CLASSES;
  if (projection.omissions.length !== expectedOmissionClasses.length) {
    throw new TypeError("Workspace omission index is incomplete.");
  }
  const omissions = projection.omissions.map((entry, index) =>
    validateProjectionOmission(entry, expectedOmissionClasses[index]!, `omissions[${index}]`));
  const literal = [...mandatory, ...optional].map(renderRecord).join("");
  const literalBytes = utf8ByteLength(literal);
  if (
    projection.literal !== literal
    || projection.utf8Bytes !== literalBytes
    || literalBytes > options.maxUtf8Bytes
  ) {
    throw new TypeError("Workspace projection literal or byte count is invalid.");
  }
  return Object.freeze({
    version: 1,
    sourceWorkspaceRevision: projection.sourceWorkspaceRevision as number,
    mandatory: Object.freeze(mandatory),
    optional: Object.freeze(optional),
    omissions: Object.freeze(omissions),
    literal,
    utf8Bytes: literalBytes,
  });
}
function compareMandatory(
  left: WorkspaceContextProjectionRecordV1,
  right: WorkspaceContextProjectionRecordV1,
): number {
  const order: Record<WorkspaceContextProjectionRecordV1["kind"], number> = {
    objective: 0,
    constraint: 1,
    required_task: 2,
    accepted_decision: 3,
    unresolved_question: 4,
    accepted_submission: 5,
    finding: 6,
    optional_task: 7,
    artifact: 8,
  };
  return order[left.kind] - order[right.kind] ||
    compareUtf8Ids(left.id, right.id) ||
    compareUtf8Ids(left.text, right.text) ||
    compareUtf8Ids(left.taskState ?? "", right.taskState ?? "") ||
    (right.sourceRevision - left.sourceRevision);
}
function compareOptional(
  left: WorkspaceContextProjectionRecordV1 & { class: WorkspaceContextRecordClass },
  right: WorkspaceContextProjectionRecordV1 & { class: WorkspaceContextRecordClass },
): number {
  return (
    (classOrder.get(left.class)! - classOrder.get(right.class)!) ||
    (right.sourceRevision - left.sourceRevision) ||
    compareUtf8Ids(left.id, right.id) ||
    compareUtf8Ids(left.text, right.text)
  );
}
function digestFor(evidence: WorkspaceContextEvidenceSourceV1): string {
  if (evidence.digest) return evidence.digest;
  return createHash("sha256").update(text(evidence.text, evidence.summary), "utf8").digest("hex");
}

function taskRevision(task: WorkspaceContextTaskSourceV1): number {
  return revision(task.sourceRevision ?? task.revision);
}
function taskText(task: WorkspaceContextTaskSourceV1): string {
  return text(task.text, task.summary ?? task.title ?? task.objective);
}
function taskProgressEntries(task: WorkspaceContextTaskSourceV1): WorkspaceContextTaskProgressV1[] {
  const entries: WorkspaceContextTaskProgressV1[] = [];
  if (Array.isArray(task.progress)) entries.push(...task.progress);
  if (task.stateHistory) entries.push(...task.stateHistory);
  return entries.filter((entry) => !entry.superseded && !entry.supersededBy);
}
function currentTask(task: WorkspaceContextTaskSourceV1): WorkspaceContextProjectionRecordV1 | null {
  if (task.superseded || task.supersededBy || task.required === false || task.activated === false) return null;
  const latest = taskProgressEntries(task).sort(
    (left, right) =>
      revision(right.sourceRevision ?? right.revision) - revision(left.sourceRevision ?? left.revision) ||
      compareUtf8Ids(left.state, right.state) ||
      compareUtf8Ids(text(left.text, left.summary), text(right.text, right.summary)),
  )[0];
  return {
    kind: "required_task",
    id: id(task.id),
    text: latest ? text(latest.text, latest.summary) : taskText(task),
    sourceRevision: latest ? revision(latest.sourceRevision ?? latest.revision) : taskRevision(task),
    taskState: latest?.state ?? task.state,
  };
}
function currentTasks(tasks: readonly WorkspaceContextTaskSourceV1[]): WorkspaceContextProjectionRecordV1[] {
  const groups = new Map<string, WorkspaceContextProjectionRecordV1>();
  for (const task of tasks) {
    const candidate = currentTask(task);
    if (!candidate) continue;
    const previous = groups.get(candidate.id);
    if (!previous || candidate.sourceRevision > previous.sourceRevision ||
      (candidate.sourceRevision === previous.sourceRevision && compareMandatory(candidate, previous) < 0)) {
      groups.set(candidate.id, candidate);
    }
  }
  return [...groups.values()];
}
function normalizedTasks(input: WorkspaceContextProjectionInputV1): WorkspaceContextTaskSourceV1[] {
  if (input.requiredTasks) return [...input.requiredTasks];
  return (input.tasks ?? []).map((task) => ({
    id: task.id,
    state: task.state,
    title: task.title,
    objective: task.objective,
    required: task.required,
    summary: task.summary,
    progress: task.progress,
    revision: task.revision,
  }));
}

function canonicalEvidence(input: WorkspaceContextProjectionInputV1): WorkspaceContextEvidenceSourceV1[] {
  if (input.evidence) return [...input.evidence];
  const result: WorkspaceContextEvidenceSourceV1[] = [];
  for (const record of input.records ?? []) {
    if (record.retention === "operational") continue;
    if (record.kind === "finding") {
      result.push({ id: record.id, class: "finding", summary: record.summary, digest: record.digest, sourceRevision: record.revision });
    }
  }
  for (const task of input.tasks ?? []) {
    if (task.required || task.retention === "operational") continue;
    result.push({ id: task.id, class: "optional_task", summary: task.summary ?? task.objective ?? task.title, sourceRevision: task.revision });
  }
  for (const submission of input.submissions ?? []) {
    if (submission.state !== "accepted" || submission.retention === "operational") continue;
    result.push({ id: submission.id, class: "accepted_submission", summary: submission.summary, digest: submission.resultDigest, sourceRevision: submission.revision });
  }
  for (const artifact of input.artifacts ?? []) {
    if (artifact.retention === "operational") continue;
    result.push({ id: artifact.id, class: "artifact", summary: artifact.mimeType, digest: artifact.blobDigest, mimeType: artifact.mimeType, sourceRevision: artifact.revision });
  }
  return result;
}
function canonicalDecisions(input: WorkspaceContextProjectionInputV1): WorkspaceContextDecisionSourceV1[] {
  if (input.acceptedDecisions) return [...input.acceptedDecisions];
  return (input.records ?? [])
    .filter((record) => record.retention !== "operational" && record.kind === "decision")
    .map((record) => ({ id: record.id, text: record.summary, accepted: true, sourceRevision: record.revision }));
}
function canonicalQuestions(input: WorkspaceContextProjectionInputV1): WorkspaceContextQuestionSourceV1[] {
  if (input.unresolvedQuestions) return [...input.unresolvedQuestions];
  return (input.records ?? [])
    .filter((record) => record.retention !== "operational" && record.kind === "question")
    .map((record) => ({ id: record.id, text: record.summary, resolved: false, sourceRevision: record.revision }));
}
function omission(
  recordClass: WorkspaceContextRecordClass,
  records: readonly (WorkspaceContextProjectionRecordV1 & { class: WorkspaceContextRecordClass })[],
): WorkspaceContextOmissionIndexV1 {
  return Object.freeze({
    class: recordClass,
    omittedCount: records.length,
    firstOmittedCursor: records[0]?.id ?? null,
  });
}

/** Build the bounded, literal provider projection from one frozen workspace read snapshot. */
export function buildWorkspaceContextProjectionV1(
  input: WorkspaceContextProjectionInputV1,
  limits: WorkspaceContextProjectionLimitsV1,
): WorkspaceContextProjectionV1 {
  const sourceWorkspaceRevision = workspaceRevision(input.workspaceRevision);
  const budget = reservedBytes(limits.reservedBytes);
  const objective = typeof input.objective === "string"
    ? { kind: "objective" as const, id: "objective", text: input.objective, sourceRevision: 0 }
    : { kind: "objective" as const, id: id(input.objective.id), text: text(input.objective.text), sourceRevision: revision(input.objective.sourceRevision) };
  const constraints = (input.constraints ?? []).map((constraint) => frozenRecord(
    typeof constraint === "string"
      ? { kind: "constraint", id: shorthandConstraintId(constraint), text: constraint, sourceRevision: 0 }
      : { kind: "constraint", id: id(constraint.id), text: text(constraint.text), sourceRevision: revision(constraint.sourceRevision) },
  ));
  const normalizedTaskSources = normalizedTasks(input);
  const mandatory = [
    frozenRecord(objective),
    ...constraints,
    ...currentTasks(normalizedTaskSources),
    ...canonicalDecisions(input)
      .filter((decision) => decision.accepted === true || decision.status === "accepted")
      .map((decision) => frozenRecord({ kind: "accepted_decision", id: id(decision.id), text: text(decision.text), sourceRevision: revision(decision.sourceRevision) })),
    ...canonicalQuestions(input)
      .filter((question) => question.resolved !== true && question.status !== "resolved")
      .map((question) => frozenRecord({ kind: "unresolved_question", id: id(question.id), text: text(question.text), sourceRevision: revision(question.sourceRevision) })),
  ].sort(compareMandatory);
  const mandatoryLiteral = mandatory.map(renderRecord).join("");
  const mandatoryBytes = utf8ByteLength(mandatoryLiteral);
  if (mandatoryBytes > budget) throw new WorkspaceContextProjectionError(
    `Mandatory workspace context requires ${mandatoryBytes} UTF-8 bytes; reserved ${budget}.`,
  );

  const candidates = canonicalEvidence(input)
    .map((evidence) => {
      if (!classOrder.has(evidence.class)) throw new TypeError(`Unsupported workspace context class: ${String(evidence.class)}.`);
      return {
        class: evidence.class,
        digest: digestFor(evidence),
        record: frozenRecord({
          kind: evidence.class,
          id: id(evidence.id),
          text: text(evidence.text, evidence.summary ?? evidence.mimeType),
          sourceRevision: revision(evidence.sourceRevision),
        }),
      };
    })
    .sort((left, right) => compareOptional({ ...left.record, class: left.class }, { ...right.record, class: right.class }));
  const seen = new Set<string>();
  const optionalCandidates: Array<WorkspaceContextProjectionRecordV1 & { class: WorkspaceContextRecordClass; digest: string }> = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.digest)) continue;
    seen.add(candidate.digest);
    optionalCandidates.push({ ...candidate.record, class: candidate.class, digest: candidate.digest });
  }
  const omitted = new Map<WorkspaceContextRecordClass, Array<WorkspaceContextProjectionRecordV1 & { class: WorkspaceContextRecordClass }>>(
    WORKSPACE_CONTEXT_RECORD_CLASSES.map((recordClass) => [recordClass, []]),
  );
  const optional: WorkspaceContextProjectionRecordV1[] = [];
  let optionalBytes = 0;
  let cut = false;
  for (const candidate of optionalCandidates) {
    const bytes = utf8ByteLength(renderRecord(candidate));
    if (!cut && mandatoryBytes + optionalBytes + bytes <= budget) {
      optional.push(frozenRecord(candidate));
      optionalBytes += bytes;
    } else {
      cut = true;
      omitted.get(candidate.class)!.push(candidate);
    }
  }
  const literal = `${mandatoryLiteral}${optional.map(renderRecord).join("")}`;
  return Object.freeze({
    version: 1,
    sourceWorkspaceRevision,
    mandatory: Object.freeze(mandatory),
    optional: Object.freeze(optional),
    omissions: Object.freeze(WORKSPACE_CONTEXT_RECORD_CLASSES.map((recordClass) => omission(recordClass, omitted.get(recordClass)!))),
    literal,
    utf8Bytes: utf8ByteLength(literal),
  });
}

const RENDER_WORKSPACE_CONTEXT_CLASSES: ReadonlySet<WorkspaceContextRecordClass> = new Set([
  "accepted_submission",
  "finding",
]);

/**
 * Narrow a validated WORK projection to the only workspace material permitted
 * to cross into tools-disabled RENDER. Completion summary/guidance travels in
 * the separate host-accepted completion handoff.
 */
export function projectRenderWorkspaceContextV1(
  projection: WorkspaceContextProjectionV1,
): WorkspaceContextProjectionV1 {
  const optional = projection.optional
    .filter((record) =>
      record.kind === "accepted_submission"
      || record.kind === "finding")
    .map(frozenRecord);
  const omissions = projection.omissions
    .filter((entry) => RENDER_WORKSPACE_CONTEXT_CLASSES.has(entry.class))
    .map((entry) => Object.freeze({ ...entry }));
  const literal = optional.map(renderRecord).join("");
  return Object.freeze({
    version: 1,
    sourceWorkspaceRevision: projection.sourceWorkspaceRevision,
    mandatory: Object.freeze([]),
    optional: Object.freeze(optional),
    omissions: Object.freeze(omissions),
    literal,
    utf8Bytes: utf8ByteLength(literal),
  });
}
function readFrozenWorkspaceCollection<T>(
  request: WorkspaceContextProjectionWorkspaceRequestV1,
  section: Exclude<WorkspaceReadSection, "objective" | "constraints" | "summary">,
): readonly T[] {
  const context = {
    userId: request.userId,
    chatId: request.chatId,
    turnId: request.turnId,
    workspaceId: request.workspaceId,
    actor: "host" as const,
    expectedRevision: request.expectedRevision,
  };
  const rows: T[] = [];
  let total: number | undefined;
  let page = 0;
  while (true) {
    const result: WorkspaceSectionPageV1 = readTurnWorkspaceSection({
      ...context,
      section,
      page,
      pageSize: WORKSPACE_CONTEXT_SNAPSHOT_PAGE_SIZE,
    });
    if (result.workspace.revision !== request.expectedRevision) {
      throw new WorkspaceContextProjectionSnapshotError("workspace revision changed during projection snapshot");
    }
    if (total === undefined) total = result.total;
    if (result.total !== total) {
      throw new WorkspaceContextProjectionSnapshotError("workspace collection changed during projection snapshot");
    }
    if (total > WORKSPACE_CONTEXT_SNAPSHOT_MAX_ROWS) {
      throw new WorkspaceContextProjectionSnapshotError(`${section} exceeds the projection snapshot row limit`);
    }
    rows.push(...(result.items as readonly T[]));
    if (rows.length >= total) break;
    if (result.items.length === 0 || page >= Math.ceil(WORKSPACE_CONTEXT_SNAPSHOT_MAX_ROWS / WORKSPACE_CONTEXT_SNAPSHOT_PAGE_SIZE)) {
      throw new WorkspaceContextProjectionSnapshotError(`${section} pagination did not converge`);
    }
    page += 1;
  }
  return Object.freeze(rows);
}

/**
 * Read and project one owner-bound workspace revision. The read transaction
 * holds a SQLite snapshot while every bounded section page is fetched, so
 * objective, tasks, records, submissions, and artifacts cannot be mixed
 * across revisions. TurnWorkspaceService remains the authority for ownership,
 * revision checks, row redaction, and canonical domain DTOs.
 */
export function buildWorkspaceContextProjectionFromWorkspaceV1(
  request: WorkspaceContextProjectionWorkspaceRequestV1,
  limits: WorkspaceContextProjectionLimitsV1,
): WorkspaceContextProjectionV1 {
  return getDb().transaction(() => {
    const context = {
      userId: request.userId,
      chatId: request.chatId,
      turnId: request.turnId,
      workspaceId: request.workspaceId,
      actor: "host" as const,
      expectedRevision: request.expectedRevision,
    };
    const workspace = getTurnWorkspace(context);
    const sourceWorkspaceRevision = request.sourceWorkspaceRevision ?? workspace.revision;
    if (
      sourceWorkspaceRevision !== workspace.revision
      && sourceWorkspaceRevision !== workspace.revision + 1
    ) {
      throw new WorkspaceContextProjectionSnapshotError("projection source revision is not current or immediately prospective");
    }
    const input = Object.freeze({
      workspaceRevision: sourceWorkspaceRevision,
      objective: workspace.objective,
      constraints: Object.freeze([...workspace.constraints]),
      tasks: readFrozenWorkspaceCollection<WorkspaceTaskV1>(request, "tasks"),
      records: readFrozenWorkspaceCollection<WorkspaceRecordV1>(request, "records"),
      submissions: readFrozenWorkspaceCollection<WorkspaceSubmissionV1>(request, "submissions"),
      artifacts: readFrozenWorkspaceCollection<WorkspaceArtifactReferenceV1>(request, "artifacts"),
    }) satisfies WorkspaceContextProjectionInputV1;
    return buildWorkspaceContextProjectionV1(input, limits);
  })();
}


export function serializeWorkspaceContextProjectionV1(projection: WorkspaceContextProjectionV1): Uint8Array {
  return encoder.encode(JSON.stringify({
    version: projection.version,
    sourceWorkspaceRevision: projection.sourceWorkspaceRevision,
    mandatory: projection.mandatory,
    optional: projection.optional,
    omissions: projection.omissions,
    literal: projection.literal,
    utf8Bytes: projection.utf8Bytes,
  }));
}
