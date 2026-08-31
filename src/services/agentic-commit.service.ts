import { compareUtf8 } from "../utils/utf8-order";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { bumpChatGenerationRevision, bumpMessageGenerationRevision } from "./chat-generation-revision.service";
import type {
  MacroVariableDeltaV1,
  ChatMetadataDeltaV1,
  InputRevisionKindV1,
  InputRevisionSetV1,
  InputRevisionV1,
  PreparationDeltaV1,
  RegexActionDeltaV1,
  RenderContentV1,
  RenderPreparationResultV1,
  RenderUsageV1,
  SourceMessageDeltaV1,
  WorldInfoStateDeltaV1,
} from "../types/agent-preprocessing";
import {
  assertRenderOutputWithinLimit,
  getEffectiveRenderPreparationLimits,
  RenderPreparationValidationError,
  validateRenderPreparationResultV1,
} from "./agentic-render-preparation-validator";
import type { GenerationTargetV1, TurnExecutionStateV1 } from "../types/turn-execution";
import type {
  WorkspaceArtifactReferenceV1,
  WorkspaceCommitReceiptV1,
  WorkspaceTerminalHandoffV1,
} from "../types/turn-workspace";
import type { AgentActivityNodeV1, AgentActivityUsageV1 } from "../types/agent-runtime";
import {
  beginTurnCommit,
  failTurnCommit,
  finalizeTurnCommit,
  finalizeTurnCommitInTransaction,
} from "./turn-execution.service";
import type { BufferedEvent } from "../ws/bus";
import {
  publishArtifactCommit,
  type ArtifactPublicationInput,
} from "./agent-artifact-blobs.service";
import {
  emitAgentRunProjectionEvent,
  publishAgentRunCommit,
  type AgentRunProjectionInputV2,
} from "./agent-run-projection.service";
export interface AgenticCommitDependenciesV1 {
  readonly beginTurnCommit: typeof beginTurnCommit;
  readonly failTurnCommit: typeof failTurnCommit;
  readonly finalizeTurnCommit: typeof finalizeTurnCommit;
  readonly finalizeTurnCommitInTransaction: typeof finalizeTurnCommitInTransaction;
  readonly publishArtifactCommit: typeof publishArtifactCommit;
  readonly publishAgentRunCommit: typeof publishAgentRunCommit;
  readonly emitProjectionEvent: (event: BufferedEvent, db: Database) => void;
}

export const AGENTIC_COMMIT_DEPENDENCIES_V1: AgenticCommitDependenciesV1 = Object.freeze({
  beginTurnCommit,
  failTurnCommit,
  finalizeTurnCommit,
  finalizeTurnCommitInTransaction,
  publishArtifactCommit,
  publishAgentRunCommit,
  emitProjectionEvent: emitAgentRunProjectionEvent,
});

export type AgenticCommitErrorCode =
  | "invalid_input"
  | "stale_input_revision"
  | "target_conflict"
  | "execution_not_found"
  | "commit_in_progress"
  | "cancelled"
  | "timed_out"
  | "too_late"
  | "unauthorized_delta"
  | "unsupported_delta"
  | "statement_failed"
  | "receipt_conflict"
  | "artifact_publish_failed"
  | "projection_failed";

export class AgenticCommitError extends Error {
  readonly code: AgenticCommitErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: AgenticCommitErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AgenticCommitError";
    this.code = code;
    this.details = details;
  }
}

export interface RevisionValueV1 {
  readonly revision: number | string;
  readonly digest: string;
}

export type InputRevisionReaderV1 = (
  member: InputRevisionV1,
  db?: Database,
) => RevisionValueV1 | InputRevisionV1 | null;

export interface AgenticCompletionV1 {
  readonly summary?: string;
  readonly unresolvedIds?: readonly string[];
  readonly renderGuidance?: string;
}

export interface AgenticMessageCommitV1 {
  readonly name?: string;
  readonly content?: string;
  readonly append?: boolean;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly parentMessageId?: string | null;
  readonly branchId?: string | null;
}

export interface AgenticProviderMetadataV1 {
  readonly adapterId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly finishReason?: string | null;
  readonly [key: string]: unknown;
}


export interface AgenticDeltaAuthorizationV1 {
  readonly authorizeMacroVariableDelta?: (delta: MacroVariableDeltaV1) => boolean;
  readonly authorizeSourceMessageDelta?: (delta: SourceMessageDeltaV1) => boolean;
  readonly authorizeChatMetadataDelta?: (delta: ChatMetadataDeltaV1) => boolean;
  readonly authorizeRegexActionDelta?: (delta: RegexActionDeltaV1) => boolean;
  readonly authorizeWorldInfoStateDelta?: (delta: WorldInfoStateDeltaV1) => boolean;
  readonly applyWorldInfoStateDelta?: (db: Database, delta: WorldInfoStateDeltaV1, metadata?: Record<string, unknown>) => void;
  readonly applyRegexActionDelta?: (db: Database, delta: RegexActionDeltaV1) => void;
}

export interface AgenticCommitInputV1 extends AgenticDeltaAuthorizationV1 {
  readonly dependencies: AgenticCommitDependenciesV1;
  readonly db?: Database;
  readonly executionId: string;
  readonly ownerToken: string;
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly generationId: string;
  readonly commitKey: string;
  readonly idempotencyKey?: string;
  readonly expectedRevision?: number;
  readonly target: GenerationTargetV1;
  /** Durable final-render reservation identity; distinct from isolate requestId. */
  readonly renderReservationId: string;
  readonly renderPreparation: RenderPreparationResultV1;
  /** The complete frozen revision set used by ASSEMBLE and RENDER. */
  readonly inputRevisions: InputRevisionSetV1;
  /** Reads live per-kind revisions; COMMIT supplies its transaction handle for the authoritative fence. */
  readonly revisionReader: InputRevisionReaderV1;
  readonly assemblyPlan?: {
    readonly inputRevisions: InputRevisionSetV1;
    readonly deltas: readonly PreparationDeltaV1[];
  };
  readonly assembleDeltas?: readonly PreparationDeltaV1[];
  readonly message?: AgenticMessageCommitV1;
  readonly providerMetadata?: AgenticProviderMetadataV1;
  readonly completion?: AgenticCompletionV1;
  /** Already-redacted ledger chronology; never contains work prose or payloads. */
  readonly activity?: readonly AgentActivityNodeV1[];
  readonly activityOmittedNodeCount?: number;
  /** Host ledger usage; only toolCalls/childInvocations are projected. */
  readonly activityUsage?: AgentActivityUsageV1;
  readonly artifacts?: readonly WorkspaceArtifactReferenceV1[];
  readonly workspaceId?: string;
  readonly workspaceRevision?: number;
  /** The fixed-point workspace handoff captured before COMMITTING. */
  readonly terminalHandoff: WorkspaceTerminalHandoffV1;
  readonly workspaceUsage?: WorkspaceTerminalHandoffV1["usage"];
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

export interface AgenticPreparedCommitV1 {
  readonly input: AgenticCommitInputV1;
  readonly render: RenderPreparationResultV1;
  readonly assembleDeltas: readonly PreparationDeltaV1[];
  readonly renderDeltas: {
    readonly macroVariableDeltas: readonly MacroVariableDeltaV1[];
    readonly sourceMessageDeltas: readonly SourceMessageDeltaV1[];
    readonly chatMetadataDeltas: readonly ChatMetadataDeltaV1[];
    readonly regexActionDeltas: readonly RegexActionDeltaV1[];
    readonly worldInfoStateDeltas: readonly WorldInfoStateDeltaV1[];
  };
  readonly inputRevisions: InputRevisionSetV1;
}

export interface AgenticCommitResultV1 {
  readonly status: "committed" | "duplicate";
  readonly receipt: WorkspaceCommitReceiptV1;
  readonly terminalHandoff: WorkspaceTerminalHandoffV1;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly projectionSequence?: number;
  readonly projectionRevision?: number;
}

type SqlRow = Record<string, unknown>;
type JsonObject = Record<string, unknown>;
type SqlBinding = string | number | bigint | boolean | null | Uint8Array;
const MAX_SUMMARY_BYTES = 8 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_PROVIDER_METADATA_BYTES = 32 * 1024;
const MAX_REVISION_MEMBERS = 256;
const MAX_DELTA_COUNT = 512;
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_UNRESOLVED_IDS = 256;
const MAX_ACTIVITY_USAGE_COUNT = 1_000_000;
const PRIVATE_KEY = /(?:transcript|carrier|reasoning|credential|secret|password|tool[_-]?(?:arg|argument|result|call|calls)|raw[_-]?(?:prompt|provider|response)|work[_-]?(?:prose|notes|transcript)|private[_-]?(?:body|content|state))/i;
const SAFE_METADATA_KEYS: Record<string, true> = {
  last_generation_id: true,
  last_generation_type: true,
  last_generation_at: true,
  generation_id: true,
  generation_type: true,
  generation_usage: true,
  generation_provider: true,
};
const TARGET_RECONCILIATION_KIND = "target_swipe_reconciliation";
const REQUIRED_INPUT_REVISION_KINDS: readonly InputRevisionKindV1[] = Object.freeze([
  "target",
  "chat",
  "config",
  "slot_binding",
  "settings",
  "macro_variables",
  "cognition_policy",
  "runtime_epoch",
  "readiness",
]);
const KNOWN_INPUT_REVISION_KINDS = new Set<InputRevisionKindV1>([
  "target",
  "chat",
  "message",
  "preset",
  "preset_block",
  "config",
  "slot_binding",
  "connection",
  "endpoint",
  "credential",
  "persona",
  "character",
  "group",
  "world_lore",
  "databank",
  "settings",
  "macro_variables",
  "regex",
  "cognition_policy",
  "runtime_epoch",
  "readiness",
]);
const SAFE_PROVIDER_METADATA_KEYS = new Set([
  "adapterId",
  "provider",
  "model",
  "finishReason",
  "responseId",
  "systemFingerprint",
  "serviceTier",
]);

function asSqlBinding(value: unknown): SqlBinding {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" || value instanceof Uint8Array) return value;
  throw new AgenticCommitError("invalid_input", "unsupported SQLite binding in commit payload");
}

function runSql(db: Database, sql: string, values: readonly unknown[]): void {
  db.query(sql).run(...values.map(asSqlBinding));
}

function nowMilliseconds(now?: () => number): number {
  const value = now ? now() : Date.now();
  return Number.isFinite(value) ? Math.floor(value) : Date.now();
}

function nowSeconds(now?: () => number): number {
  return Math.floor(nowMilliseconds(now) / 1000);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AgenticCommitError("invalid_input", "non-finite commit value");
    return value;
  }
  if (typeof value !== "object") throw new AgenticCommitError("invalid_input", "unsupported commit value");
  if (seen.has(value)) throw new AgenticCommitError("invalid_input", "cyclic commit value");
  seen.add(value);
  if (Array.isArray(value)) {
    const array = value.map((entry) => stableValue(entry, seen));
    seen.delete(value);
    return array;
  }
  const result: JsonObject = {};
  for (const key of Object.keys(value).sort(compareUtf8)) {
    if (PRIVATE_KEY.test(key)) throw new AgenticCommitError("invalid_input", `private field is not commitable: ${key}`);
    result[key] = stableValue((value as JsonObject)[key], seen);
  }
  seen.delete(value);
  return result;
}

function stableJson(value: unknown, limit: number, message: string): string {
  const json = JSON.stringify(stableValue(value));
  if (byteLength(json) > limit) throw new AgenticCommitError("invalid_input", message);
  return json;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value, 128 * 1024, "digest input exceeds limit")).digest("hex");
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > 512) throw new AgenticCommitError("invalid_input", `${name} is malformed`);
  return value;
}

function executionHasRenderReservation(execution: SqlRow, reservationId: string): boolean {
  const raw = execution.final_render_reservations_json;
  if (typeof raw !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.some((entry) => isJsonObject(entry) && entry.id === reservationId);
  } catch {
    return false;
  }
}
function tableExists(db: Database, table: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table);
}

function tableColumns(db: Database, table: string): Set<string> {
  if (!tableExists(db, table)) return new Set<string>();
  return new Set((db.query(`PRAGMA table_info(\"${table}\")`).all() as Array<{ name: string }>).map((row) => row.name));
}

function parseObject(row: SqlRow | null, key: string): JsonObject {
  const raw = row?.[key];
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function parseDates(row: SqlRow, count: number, now: number): number[] {
  const raw = row.swipe_dates;
  const dates: number[] = [];
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) dates.push(...parsed.filter((entry): entry is number => Number.isSafeInteger(entry)));
    } catch { /* pad below */ }
  }
  while (dates.length < count) dates.push(now);
  return dates.slice(0, count);
}


function parseStrings(row: SqlRow, key: string, fallback: string[]): string[] {
  const raw = row[key];
  if (typeof raw !== "string") return [...fallback];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? [...parsed] : [...fallback];
  } catch {
    return [...fallback];
  }
}

function validateTarget(target: GenerationTargetV1): void {
  if (!target || typeof target !== "object") throw new AgenticCommitError("invalid_input", "target is required");
  if (!["normal", "continue", "regenerate", "swipe"].includes(target.target)) throw new AgenticCommitError("invalid_input", "unsupported target");
  identifier(target.chatId, "target.chatId");
  if (target.branchId !== null && typeof target.branchId !== "string") throw new AgenticCommitError("invalid_input", "target.branchId is malformed");
  if (target.messageId !== null && typeof target.messageId !== "string") throw new AgenticCommitError("invalid_input", "target.messageId is malformed");
  if (target.swipeId !== null && (!Number.isSafeInteger(target.swipeId) || target.swipeId < 0)) throw new AgenticCommitError("invalid_input", "target.swipeId is malformed");
  if (target.messageIndex !== null && (!Number.isSafeInteger(target.messageIndex) || target.messageIndex < 0)) throw new AgenticCommitError("invalid_input", "target.messageIndex is malformed");
  if (target.swipeCount !== null && (!Number.isSafeInteger(target.swipeCount) || target.swipeCount < 1)) throw new AgenticCommitError("invalid_input", "target.swipeCount is malformed");
  if (!Number.isSafeInteger(target.chatGenerationRevision) || target.chatGenerationRevision < 0) throw new AgenticCommitError("invalid_input", "target chat revision is malformed");
  if (target.messageGenerationRevision !== null && (!Number.isSafeInteger(target.messageGenerationRevision) || target.messageGenerationRevision < 0)) throw new AgenticCommitError("invalid_input", "target message revision is malformed");
  if (target.target === "normal") {
    if (target.messageId !== null || target.swipeId !== null || target.messageIndex !== null || target.swipeCount !== null || target.messageGenerationRevision !== null) {
      throw new AgenticCommitError("target_conflict", "normal target cannot carry message or swipe identity");
    }
    return;
  }
  if (!target.messageId || target.messageIndex === null || target.swipeCount === null || target.swipeId === null) {
    throw new AgenticCommitError("target_conflict", "non-normal target requires a complete message and swipe identity");
  }
}

function validateRevisionSet(set: InputRevisionSetV1): InputRevisionSetV1 {
  if (!set || set.version !== 1 || !Array.isArray(set.revisions) || set.revisions.length === 0 || set.revisions.length > MAX_REVISION_MEMBERS || typeof set.digest !== "string") throw new AgenticCommitError("invalid_input", "input revision set is malformed");
  const members = new Set<string>();
  const kinds = new Set<InputRevisionKindV1>();
  for (const member of set.revisions) {
    if (!member || typeof member !== "object") throw new AgenticCommitError("invalid_input", "input revision member is malformed");
    if (!KNOWN_INPUT_REVISION_KINDS.has(member.kind)) throw new AgenticCommitError("invalid_input", `unknown input revision kind: ${String(member.kind)}`);
    identifier(member.kind, "revision.kind");
    identifier(member.id, "revision.id");
    if ((typeof member.revision !== "string" && typeof member.revision !== "number") || (typeof member.revision === "number" && !Number.isSafeInteger(member.revision))) throw new AgenticCommitError("invalid_input", "revision value is malformed");
    identifier(member.digest, "revision.digest");
    const key = `${member.kind}\u0000${member.id}`;
    if (members.has(key)) throw new AgenticCommitError("invalid_input", "duplicate input revision member");
    members.add(key);
    kinds.add(member.kind);
  }
  for (const kind of REQUIRED_INPUT_REVISION_KINDS) {
    if (!kinds.has(kind)) throw new AgenticCommitError("invalid_input", `input revision set is missing ${kind}`);
  }
  if (byteLength(set.digest) > 256) throw new AgenticCommitError("invalid_input", "revision set digest is malformed");
  if (set.digest !== sha256(set.revisions)) throw new AgenticCommitError("invalid_input", "input revision set digest does not match members");
  return set;
}

function revisionEqual(expected: InputRevisionV1, current: RevisionValueV1 | InputRevisionV1): boolean {
  if ("kind" in current && (current.kind !== expected.kind || current.id !== expected.id)) return false;
  return expected.revision === current.revision && expected.digest === current.digest;
}
function revisionSetMember(set: InputRevisionSetV1, kind: InputRevisionKindV1, id?: string): InputRevisionV1 | undefined {
  return set.revisions.find((candidate) => candidate.kind === kind && (id === undefined || candidate.id === id))
    ?? set.revisions.find((candidate) => candidate.kind === kind);
}

function logExpectedLiveMember(entry: {
  readonly kind: string;
  readonly id?: string;
  readonly expected: unknown;
  readonly live: unknown;
  readonly member: unknown;
  readonly expectedDigest?: string;
  readonly liveDigest?: string;
  readonly memberDigest?: string;
}): void {
  const payload: Record<string, unknown> = {
    kind: entry.kind,
    id: entry.id,
    expected: entry.expected,
    live: entry.live,
    member: entry.member,
  };
  if (typeof entry.expectedDigest === "string") payload.expectedDigest = entry.expectedDigest;
  if (typeof entry.liveDigest === "string") payload.liveDigest = entry.liveDigest;
  if (typeof entry.memberDigest === "string") payload.memberDigest = entry.memberDigest;
  console.error("[agentic] expected-vs-live-vs-member", payload);
}


function recheckInputRevisions(input: AgenticCommitInputV1, set: InputRevisionSetV1, db: Database): void {
  if (!input.revisionReader) {
    throw new AgenticCommitError("invalid_input", "host input revision reader is required");
  }
  const mismatches: Array<Record<string, unknown>> = [];
  for (const member of set.revisions) {
    let current: RevisionValueV1 | InputRevisionV1 | null = null;
    try {
      current = input.revisionReader(member, db);
    } catch {
      current = null;
    }
    const live = current && "revision" in current ? current.revision : null;
    if (!current || !revisionEqual(member, current)) {
      logExpectedLiveMember({
        kind: member.kind,
        id: member.id,
        expected: member.revision,
        live,
        member: member.revision,
        expectedDigest: typeof member.digest === "string" ? member.digest : undefined,
        liveDigest: current && "digest" in current && typeof current.digest === "string" ? current.digest : undefined,
        memberDigest: typeof member.digest === "string" ? member.digest : undefined,
      });
      mismatches.push({ kind: member.kind, id: member.id, expected: member.revision, live, member: member.revision });
    }
  }
  if (mismatches.length > 0) {
    throw new AgenticCommitError("stale_input_revision", "one or more input revisions changed", { mismatches });
  }
}



function renderText(content: RenderContentV1): { text: string; media: Array<Record<string, string>> } {
  if (!content || typeof content !== "object") throw new AgenticCommitError("invalid_input", "render content is malformed");
  if (content.kind === "text") {
    if (typeof content.text !== "string") throw new AgenticCommitError("invalid_input", "render text is missing");
    return { text: content.text, media: [] };
  }
  if (content.kind !== "parts" || !Array.isArray(content.parts)) throw new AgenticCommitError("invalid_input", "render content parts are malformed");
  let text = "";
  const media: Array<Record<string, string>> = [];
  for (const part of content.parts) {
    if (part.kind === "text") {
      if (typeof part.text !== "string") throw new AgenticCommitError("invalid_input", "render text part is malformed");
      text += part.text;
    } else if (part.kind === "media") {
      if (typeof part.mediaKind !== "string" || typeof part.mimeType !== "string" || typeof part.reference !== "string") throw new AgenticCommitError("invalid_input", "render media part is malformed");
      media.push({ kind: part.mediaKind, mimeType: part.mimeType, reference: part.reference, ...(part.altText ? { altText: part.altText } : {}) });
    } else {
      throw new AgenticCommitError("invalid_input", "unknown render content part");
    }
  }
  return { text, media };
}

function validateRender(input: AgenticCommitInputV1): RenderPreparationResultV1 {
  const limits = getEffectiveRenderPreparationLimits();
  let render: RenderPreparationResultV1;
  try {
    render = validateRenderPreparationResultV1(input.renderPreparation, limits);
    assertRenderOutputWithinLimit(renderText(render.content).text, limits);
    stableJson(render.usage, MAX_METADATA_BYTES, "usage metadata exceeds commit limit");
    if (input.providerMetadata !== undefined) stableJson(safeProviderMetadata(input.providerMetadata), MAX_PROVIDER_METADATA_BYTES, "provider metadata exceeds commit limit");
    const lists: readonly unknown[] = [render.macroVariableDeltas, render.sourceMessageDeltas, render.chatMetadataDeltas, render.regexActionDeltas, render.worldInfoStateDeltas];
    if (lists.some((list) => !Array.isArray(list) || list.length > MAX_DELTA_COUNT)) throw new AgenticCommitError("invalid_input", "render delta list exceeds limit");
  } catch (error) {
    if (error instanceof AgenticCommitError) throw error;
    if (error instanceof RenderPreparationValidationError) throw new AgenticCommitError("invalid_input", error.message);
    throw new AgenticCommitError("invalid_input", "render preparation result is malformed");
  }
  if (render.reasoning !== undefined) throw new AgenticCommitError("invalid_input", "render reasoning cannot cross the commit boundary");
  const renderTurnId = (render as RenderPreparationResultV1 & { readonly turnId?: string }).turnId;
  if (render.requestId.length === 0 || (renderTurnId !== undefined && renderTurnId !== input.turnId)) throw new AgenticCommitError("invalid_input", "render result does not belong to this turn");
  return render;
}

function revisionSetFor(input: AgenticCommitInputV1): InputRevisionSetV1 {
  const renderSet = validateRevisionSet(input.renderPreparation.inputRevisions);
  const selected = validateRevisionSet(input.inputRevisions);
  if (selected.digest !== renderSet.digest) throw new AgenticCommitError("stale_input_revision", "commit revision set differs from render revision set");
  if (input.assemblyPlan && validateRevisionSet(input.assemblyPlan.inputRevisions).digest !== renderSet.digest) throw new AgenticCommitError("stale_input_revision", "assembly and render revision sets differ");
  return selected;
}

function validateCompletionAndHandoff(input: AgenticCommitInputV1): void {
  const completion = input.completion;
  if (completion !== undefined && !isJsonObject(completion)) throw new AgenticCommitError("invalid_input", "completion is malformed");
  const summary = completion?.summary ?? "";
  if (typeof summary !== "string" || byteLength(summary) > MAX_SUMMARY_BYTES) throw new AgenticCommitError("invalid_input", "completion summary exceeds limit");
  const unresolvedIds = completion?.unresolvedIds ?? [];
  if (!Array.isArray(unresolvedIds) || unresolvedIds.length > MAX_UNRESOLVED_IDS) throw new AgenticCommitError("invalid_input", "unresolved id list exceeds limit");
  for (const id of unresolvedIds) identifier(id, "completion.unresolvedId");
  const renderGuidance = completion?.renderGuidance ?? "";
  if (typeof renderGuidance !== "string" || byteLength(renderGuidance) > MAX_SUMMARY_BYTES) throw new AgenticCommitError("invalid_input", "render guidance exceeds limit");
  stableJson({ summary, unresolvedIds, renderGuidance }, MAX_METADATA_BYTES, "completion exceeds commit limit");
  if (input.providerMetadata !== undefined) stableJson(safeProviderMetadata(input.providerMetadata), MAX_PROVIDER_METADATA_BYTES, "provider metadata exceeds commit limit");
  if (input.workspaceId !== undefined) identifier(input.workspaceId, "workspaceId");
  if (input.workspaceRevision !== undefined && (!Number.isSafeInteger(input.workspaceRevision) || input.workspaceRevision < 0)) throw new AgenticCommitError("invalid_input", "workspace revision is malformed");
  const handoff = input.terminalHandoff;
  if (!handoff || !isJsonObject(handoff)) throw new AgenticCommitError("invalid_input", "terminal workspace handoff is required");
  identifier(handoff.workspaceId, "terminalHandoff.workspaceId");
  if (input.workspaceId !== undefined && handoff.workspaceId !== input.workspaceId) throw new AgenticCommitError("target_conflict", "terminal handoff workspace does not match commit");
  if (handoff.state !== "frozen") throw new AgenticCommitError("target_conflict", "terminal workspace handoff is not frozen");
  if (!Number.isSafeInteger(handoff.revision) || handoff.revision < 0) throw new AgenticCommitError("invalid_input", "terminal handoff revision is malformed");
  if (input.workspaceRevision !== undefined && handoff.revision !== input.workspaceRevision) throw new AgenticCommitError("stale_input_revision", "terminal handoff revision differs from commit workspace revision");
  if (typeof handoff.executionState !== "string" || handoff.executionState.length === 0) throw new AgenticCommitError("invalid_input", "terminal handoff execution state is malformed");
  const usage = handoff.usage;
  if (!usage || !isJsonObject(usage)) throw new AgenticCommitError("invalid_input", "terminal handoff usage is malformed");
  for (const key of ["taskCount", "recordCount", "submissionCount", "artifactCount", "byteCount"] as const) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new AgenticCommitError("invalid_input", `terminal handoff ${key} is malformed`);
  }
  if (!Array.isArray(handoff.finalRenderReservations)) throw new AgenticCommitError("invalid_input", "terminal handoff render reservations are malformed");
  stableJson(handoff, MAX_METADATA_BYTES, "terminal handoff exceeds commit limit");
  if (input.workspaceUsage !== undefined) {
    stableJson(input.workspaceUsage, MAX_METADATA_BYTES, "workspace usage exceeds commit limit");
    if (stableJson(input.workspaceUsage, MAX_METADATA_BYTES, "workspace usage exceeds commit limit") !== stableJson(usage, MAX_METADATA_BYTES, "terminal handoff usage exceeds commit limit")) {
      throw new AgenticCommitError("target_conflict", "workspace usage does not match terminal handoff");
    }
  }
}

function validateAssemblyDeltas(deltas: readonly PreparationDeltaV1[]): void {
  if (!Array.isArray(deltas)) throw new AgenticCommitError("invalid_input", "assembly delta list is malformed");
  const allowed = new Set(["macro_variable", "world_info_state", "source_message", "chat_metadata", "regex_action"]);
  for (const delta of deltas) {
    if (!isJsonObject(delta)) throw new AgenticCommitError("invalid_input", "assembly delta is malformed");
    const kind = deltaKind(delta);
    if (!kind || !allowed.has(kind)) throw new AgenticCommitError("invalid_input", "assembly delta kind is unsupported");
    stableJson(delta, MAX_METADATA_BYTES, "assembly delta exceeds commit limit");
  }
}
function validateDeltaUniqueness(
  assembleDeltas: readonly PreparationDeltaV1[],
  render: RenderPreparationResultV1,
): void {
  const seen = new Set<string>();
  const all: readonly unknown[] = [
    ...assembleDeltas,
    ...render.macroVariableDeltas,
    ...render.sourceMessageDeltas,
    ...render.chatMetadataDeltas,
    ...render.regexActionDeltas,
    ...render.worldInfoStateDeltas,
  ];
  for (const delta of all) {
    const digest = sha256(delta);
    if (seen.has(digest)) throw new AgenticCommitError("invalid_input", "duplicate commit delta");
    seen.add(digest);
  }
}
function boundedActivityCount(value: unknown, name: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_ACTIVITY_USAGE_COUNT) {
    throw new AgenticCommitError("invalid_input", `${name} is malformed`);
  }
  return value;
}

function validateActivityUsage(usage: AgentActivityUsageV1 | undefined): void {
  if (usage === undefined) return;
  if (!isJsonObject(usage)) throw new AgenticCommitError("invalid_input", "activity usage is malformed");
  boundedActivityCount(usage.toolCalls, "activityUsage.toolCalls");
  boundedActivityCount(usage.childInvocations, "activityUsage.childInvocations");
}

function projectionActivityCounts(input: AgenticCommitInputV1): { readonly toolCalls: number; readonly childInvocations: number } {
  return {
    toolCalls: boundedActivityCount(input.activityUsage?.toolCalls, "activityUsage.toolCalls"),
    childInvocations: boundedActivityCount(input.activityUsage?.childInvocations, "activityUsage.childInvocations"),
  };
}



export function prepareAgenticCommitV1(input: AgenticCommitInputV1): AgenticPreparedCommitV1 {
  identifier(input.executionId, "executionId");
  identifier(input.ownerToken, "ownerToken");
  identifier(input.userId, "userId");
  identifier(input.chatId, "chatId");
  identifier(input.turnId, "turnId");
  identifier(input.generationId, "generationId");
  identifier(input.commitKey, "commitKey");
  identifier(input.renderReservationId, "renderReservationId");
  if (byteLength(input.commitKey) > 256) throw new AgenticCommitError("invalid_input", "commitKey exceeds receipt limit");
  if (input.idempotencyKey !== undefined) {
    identifier(input.idempotencyKey, "idempotencyKey");
    if (byteLength(input.idempotencyKey) > 256) throw new AgenticCommitError("invalid_input", "idempotencyKey exceeds receipt limit");
  }
  validateTarget(input.target);
  validateCompletionAndHandoff(input);
  const render = validateRender(input);
  const assembleDeltas = input.assembleDeltas ?? input.assemblyPlan?.deltas ?? [];
  if (assembleDeltas.length > MAX_DELTA_COUNT) throw new AgenticCommitError("invalid_input", "assembly delta list exceeds limit");
  validateAssemblyDeltas(assembleDeltas);
  validateActivityUsage(input.activityUsage);
  validateDeltaUniqueness(assembleDeltas, render);
  validateArtifactReferences(input);
  return Object.freeze({
    input,
    render,
    assembleDeltas: Object.freeze([...assembleDeltas]),
    renderDeltas: Object.freeze({
      macroVariableDeltas: Object.freeze([...render.macroVariableDeltas]),
      sourceMessageDeltas: Object.freeze([...render.sourceMessageDeltas]),
      chatMetadataDeltas: Object.freeze([...render.chatMetadataDeltas]),
      regexActionDeltas: Object.freeze([...render.regexActionDeltas]),
      worldInfoStateDeltas: Object.freeze([...render.worldInfoStateDeltas]),
    }),
    inputRevisions: revisionSetFor(input),
  });
}

function ownedChat(db: Database, input: AgenticCommitInputV1): SqlRow {
  const row = db.query("SELECT * FROM chats WHERE id = ? AND user_id = ? LIMIT 1").get(input.chatId, input.userId) as SqlRow | null;
  if (!row) throw new AgenticCommitError("target_conflict", "chat or owner not found");
  return row;
}

function ownedMessage(db: Database, input: AgenticCommitInputV1, messageId: string): SqlRow {
  const row = db.query("SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ? AND m.chat_id = ? AND c.user_id = ? LIMIT 1").get(messageId, input.chatId, input.userId) as SqlRow | null;
  if (!row) throw new AgenticCommitError("target_conflict", "target message or owner not found");
  return row;
}
function assertExecutionBinding(db: Database, input: AgenticCommitInputV1): void {
  if (!tableExists(db, "agent_turn_executions")) throw new AgenticCommitError("execution_not_found", "turn execution is unavailable");
  const execution = db.query("SELECT * FROM agent_turn_executions WHERE id = ? LIMIT 1").get(input.executionId) as SqlRow | null;
  if (!execution) throw new AgenticCommitError("execution_not_found", "turn execution is unavailable");
  const same = (left: unknown, right: unknown): boolean => (left === undefined || left === null ? null : left) === (right === undefined ? null : right);
  if (
    execution.user_id !== input.userId ||
    input.target.chatId !== input.chatId ||
    execution.chat_id !== input.chatId ||
    execution.generation_id !== input.generationId ||
    execution.commit_key !== input.commitKey ||
    execution.mode !== "agentic" ||
    execution.target_kind !== input.target.target ||
    execution.target_chat_revision !== input.target.chatGenerationRevision ||
    !same(execution.branch_id, input.target.branchId) ||
    !same(execution.target_message_id, input.target.messageId) ||
    !same(execution.target_swipe_id, input.target.swipeId) ||
    !same(execution.target_swipe_count, input.target.swipeCount) ||
    !executionHasRenderReservation(execution, input.renderReservationId) ||
    !same(execution.target_message_revision, input.target.messageGenerationRevision) ||
    (input.workspaceId !== undefined && !same(execution.workspace_id, input.workspaceId)) ||
    !same(execution.workspace_id, input.terminalHandoff.workspaceId)
  ) {
    throw new AgenticCommitError("target_conflict", "turn execution target binding does not match commit");
  }
  const chat = db.query("SELECT generation_revision FROM chats WHERE id = ? AND user_id = ? LIMIT 1").get(input.chatId, input.userId) as { generation_revision?: number } | null;
  if (!chat || Number(chat.generation_revision) !== input.target.chatGenerationRevision) {
    const member = revisionSetMember(input.inputRevisions, "chat", input.chatId);
    logExpectedLiveMember({
      kind: "chat",
      id: input.chatId,
      expected: input.target.chatGenerationRevision,
      live: chat ? Number(chat.generation_revision) : null,
      member: member?.revision ?? null,
      memberDigest: typeof member?.digest === "string" ? member.digest : undefined,
    });
    throw new AgenticCommitError("stale_input_revision", "chat generation revision changed before commit");
  }
  if (input.target.messageId !== null) {
    const message = db.query("SELECT generation_revision FROM messages WHERE id = ? AND chat_id = ? LIMIT 1").get(input.target.messageId, input.chatId) as { generation_revision?: number } | null;
    if (!message || Number(message.generation_revision) !== input.target.messageGenerationRevision) {
      const member = revisionSetMember(input.inputRevisions, "message", input.target.messageId);
      logExpectedLiveMember({
        kind: "message",
        id: input.target.messageId,
        expected: input.target.messageGenerationRevision,
        live: message ? Number(message.generation_revision) : null,
        member: member?.revision ?? null,
        memberDigest: typeof member?.digest === "string" ? member.digest : undefined,
      });
      throw new AgenticCommitError("stale_input_revision", "message generation revision changed before commit");
    }
  }
  const workspaceId = execution.workspace_id;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) throw new AgenticCommitError("target_conflict", "turn workspace is unavailable");
  const workspace = db.query("SELECT state, revision, execution_id, turn_id, user_id, chat_id, task_count, record_count, submission_count, artifact_count, byte_count FROM agent_turn_workspaces WHERE workspace_id = ? LIMIT 1").get(workspaceId) as SqlRow | null;
  if (!workspace || workspace.execution_id !== input.executionId || workspace.turn_id !== input.turnId || workspace.user_id !== input.userId || workspace.chat_id !== input.chatId) {
    throw new AgenticCommitError("target_conflict", "turn workspace binding does not match commit");
  }
  if (workspace.state !== "frozen") throw new AgenticCommitError("target_conflict", "turn workspace is not frozen");
  if (input.workspaceId !== undefined && input.workspaceId !== workspaceId) throw new AgenticCommitError("target_conflict", "workspace id does not match execution");
  if (input.workspaceRevision !== undefined && Number(workspace.revision) !== input.workspaceRevision) {
    throw new AgenticCommitError("stale_input_revision", "workspace revision changed before commit");
  }
  if (input.terminalHandoff.revision !== Number(workspace.revision)) {
    throw new AgenticCommitError("stale_input_revision", "terminal handoff workspace revision is stale");
  }
  const workspaceUsage: WorkspaceTerminalHandoffV1["usage"] = {
    taskCount: Number(workspace.task_count),
    recordCount: Number(workspace.record_count),
    submissionCount: Number(workspace.submission_count),
    artifactCount: Number(workspace.artifact_count),
    byteCount: Number(workspace.byte_count),
  };
  if (stableJson(workspaceUsage, MAX_METADATA_BYTES, "workspace usage exceeds commit limit") !== stableJson(input.terminalHandoff.usage, MAX_METADATA_BYTES, "terminal handoff usage exceeds commit limit")) {
    throw new AgenticCommitError("stale_input_revision", "workspace usage changed before commit");
  }
}
function safeProviderMetadata(provider: AgenticProviderMetadataV1): JsonObject {
  if (!isJsonObject(provider)) throw new AgenticCommitError("invalid_input", "provider metadata must be an object");
  for (const key of Object.keys(provider)) {
    if (!SAFE_PROVIDER_METADATA_KEYS.has(key)) throw new AgenticCommitError("invalid_input", `provider metadata key is not commitable: ${key}`);
  }
  const safe = stableValue(provider);
  if (!isJsonObject(safe)) throw new AgenticCommitError("invalid_input", "provider metadata must be an object");
  return safe;
}
function resolveExecutionWorkspaceId(db: Database, input: AgenticCommitInputV1): string {
  if (input.workspaceId !== undefined) return input.workspaceId;
  const row = db.query("SELECT workspace_id FROM agent_turn_executions WHERE id = ? AND user_id = ? AND chat_id = ? LIMIT 1").get(input.executionId, input.userId, input.chatId) as { workspace_id?: string | null } | null;
  return typeof row?.workspace_id === "string" ? row.workspace_id : "";
}
function workspaceRow(db: Database, input: AgenticCommitInputV1, workspaceId?: string): SqlRow | null {
  const id = workspaceId ?? input.workspaceId;
  if (typeof id !== "string" || id.length === 0 || !tableExists(db, "agent_turn_workspaces")) return null;
  return db.query("SELECT * FROM agent_turn_workspaces WHERE workspace_id = ? AND execution_id = ? AND turn_id = ? AND user_id = ? AND chat_id = ? LIMIT 1").get(id, input.executionId, input.turnId, input.userId, input.chatId) as SqlRow | null;
}

function applyUsageExtra(extra: JsonObject, swipeCount: number, swipeId: number, usage: RenderUsageV1, provider: AgenticProviderMetadataV1 | undefined, media: Array<Record<string, string>>, activeSwipeId = swipeId): JsonObject {
  const output = { ...extra };
  delete output.reasoning;
  delete output.reasoningBySwipe;
  delete output.reasoningCarrier;
  delete output.reasoningCarrierBySwipe;
  delete output.work;
  delete output.transcript;
  delete output.toolArguments;
  delete output.toolResults;
  const usages = Array.isArray(output.usageBySwipe) ? [...output.usageBySwipe] : [];
  while (usages.length < swipeCount) usages.push(null);
  usages[swipeId] = { ...usage };
  output.usageBySwipe = usages;
  if (activeSwipeId === swipeId) output.usage = { ...usage };
  if (activeSwipeId === swipeId && provider !== undefined) {
    const safeProvider = safeProviderMetadata(provider);
    output.provider = safeProvider;
    output.providerMetadata = safeProvider;
  }
  if (activeSwipeId === swipeId && media.length > 0) output.renderedMedia = media;
  stableJson(output, MAX_METADATA_BYTES, "message metadata exceeds commit limit");
  return output;
}
interface CommitRevisionTracker {
  readonly messages: Map<string, string>;
  readonly chats: Set<string>;
  /** Delta source revisions checked against the pre-commit state. */
  readonly deltas: Map<string, string>;
  /** Chat metadata is flushed once after every ordered metadata/world delta. */
  metadataDirty: boolean;
}

function createCommitRevisionTracker(): CommitRevisionTracker {
  return { messages: new Map<string, string>(), chats: new Set<string>(), deltas: new Map<string, string>(), metadataDirty: false };
}

function markMessageRevision(tracker: CommitRevisionTracker, messageId: string, chatId: string): void {
  tracker.messages.set(messageId, chatId);
}

function markChatRevision(tracker: CommitRevisionTracker, chatId: string): void {
  tracker.chats.add(chatId);
}

function flushCommitRevisionBumps(db: Database, tracker: CommitRevisionTracker): void {
  for (const [messageId, chatId] of tracker.messages) {
    if (bumpMessageGenerationRevision(db, messageId, chatId) === null) {
      throw new AgenticCommitError("target_conflict", "message disappeared before generation revision bump");
    }
  }
  for (const chatId of tracker.chats) {
    if (bumpChatGenerationRevision(db, chatId) === null) {
      throw new AgenticCommitError("target_conflict", "chat disappeared before generation revision bump");
    }
  }
}
function validateArtifactReferences(input: AgenticCommitInputV1): void {
  const artifacts = input.artifacts ?? [];
  if (!Array.isArray(artifacts) || artifacts.length > MAX_DELTA_COUNT) throw new AgenticCommitError("invalid_input", "artifact reference list exceeds limit");
  const seenArtifactIds = new Set<string>();
  for (const raw of artifacts) {
    const value = stableValue(raw);
    if (!isJsonObject(value)) throw new AgenticCommitError("invalid_input", "artifact reference is malformed");
    const ref = value as Partial<WorkspaceArtifactReferenceV1>;
    if (
      typeof ref.id !== "string" ||
      typeof ref.workspaceId !== "string" ||
      typeof ref.turnId !== "string" ||
      typeof ref.userId !== "string" ||
      typeof ref.chatId !== "string" ||
      typeof ref.blobDigest !== "string" ||
      !/^[a-fA-F0-9]{64}$/.test(ref.blobDigest) ||
      (ref.sourceFrameId !== null && typeof ref.sourceFrameId !== "string") ||
      (ref.sourceTaskId !== null && typeof ref.sourceTaskId !== "string") ||
      typeof ref.mimeType !== "string" ||
      byteLength(ref.mimeType) > 512 ||
      typeof ref.byteCount !== "number" ||
      !Number.isSafeInteger(ref.byteCount) ||
      ref.byteCount < 0 ||
      !["host", "root", "child"].includes(String(ref.provenance)) ||
      !["attached", "proposed", "published"].includes(String(ref.publicationState)) ||
      ref.retention !== "chat_lifetime" ||
      typeof ref.revision !== "number" ||
      !Number.isSafeInteger(ref.revision) ||
      ref.revision < 0 ||
      typeof ref.expiresAt !== "number" ||
      !Number.isSafeInteger(ref.expiresAt) ||
      ref.expiresAt < 0 ||
      typeof ref.createdAt !== "number" ||
      !Number.isSafeInteger(ref.createdAt) ||
      ref.createdAt < 0
    ) throw new AgenticCommitError("invalid_input", "artifact reference is malformed");
    identifier(ref.id, "artifact.id");
    if (seenArtifactIds.has(ref.id)) throw new AgenticCommitError("invalid_input", "duplicate artifact reference");
    seenArtifactIds.add(ref.id);
    identifier(ref.workspaceId, "artifact.workspaceId");
    identifier(ref.turnId, "artifact.turnId");
    identifier(ref.userId, "artifact.userId");
    identifier(ref.chatId, "artifact.chatId");
    if (ref.sourceFrameId !== null && ref.sourceFrameId !== undefined) identifier(ref.sourceFrameId, "artifact.sourceFrameId");
    if (ref.sourceTaskId !== null && ref.sourceTaskId !== undefined) identifier(ref.sourceTaskId, "artifact.sourceTaskId");
    if (ref.userId !== input.userId || ref.chatId !== input.chatId || ref.turnId !== input.turnId || (input.workspaceId !== undefined && ref.workspaceId !== input.workspaceId)) {
      throw new AgenticCommitError("target_conflict", "artifact reference ownership does not match commit");
    }
    stableJson(value, MAX_METADATA_BYTES, "artifact reference exceeds commit limit");
  }
}

function boundedMessageExtra(value: unknown): JsonObject {
  if (value === undefined) return {};
  const extra = stableValue(value);
  if (!isJsonObject(extra)) throw new AgenticCommitError("invalid_input", "message metadata must be an object");
  return extra;
}
const PROTECTED_MESSAGE_EXTRA_KEYS = new Set([
  "usage",
  "usageBySwipe",
  "provider",
  "providerMetadata",
  "renderedMedia",
  "reasoning",
  "reasoningBySwipe",
  "reasoningCarrier",
  "reasoningCarrierBySwipe",
  "work",
  "transcript",
  "toolArguments",
  "toolResults",
  "toolCalls",
  "tool_calls",
  "providerCarrier",
  "provider_carrier",
  "responseCarrier",
  "response_carrier",
]);

function mergeMessageExtra(target: JsonObject, value: unknown): void {
  const extra = boundedMessageExtra(value);
  for (const [key, entry] of Object.entries(extra)) {
    if (PROTECTED_MESSAGE_EXTRA_KEYS.has(key)) throw new AgenticCommitError("invalid_input", `message metadata key is host-owned: ${key}`);
    target[key] = entry;
  }
}


function applyMessage(
  db: Database,
  input: AgenticCommitInputV1,
  render: RenderPreparationResultV1,
  now: number,
  tracker: CommitRevisionTracker,
  reservedMessageId?: string,
): { messageId: string; swipeId: number } {
  const messageInput = input.message;
  if (messageInput?.name !== undefined && byteLength(messageInput.name) > 512) throw new AgenticCommitError("invalid_input", "message name exceeds limit");
  if (messageInput?.parentMessageId !== undefined && messageInput.parentMessageId !== null) identifier(messageInput.parentMessageId, "message.parentMessageId");
  if (messageInput?.branchId !== undefined && messageInput.branchId !== null) identifier(messageInput.branchId, "message.branchId");
  if (messageInput?.append !== undefined && typeof messageInput.append !== "boolean") throw new AgenticCommitError("invalid_input", "message append flag is malformed");
  const output = renderText(render.content);
  const supplied = messageInput?.content;
  if (supplied !== undefined && typeof supplied !== "string") throw new AgenticCommitError("invalid_input", "message content is malformed");
  if (supplied !== undefined && supplied !== output.text) throw new AgenticCommitError("invalid_input", "message content must match prepared render");
  if (messageInput?.branchId !== undefined && messageInput.branchId !== input.target.branchId) throw new AgenticCommitError("target_conflict", "message branch does not match frozen target");
  const generated = output.text;
  if (byteLength(generated) > MAX_CONTENT_BYTES) throw new AgenticCommitError("invalid_input", "message content exceeds limit");
  if (input.target.target === "normal") {
    const max = db.query("SELECT COALESCE(MAX(index_in_chat), -1) AS max_index FROM messages WHERE chat_id = ?").get(input.chatId) as { max_index?: number } | null;
    const id = reservedMessageId ?? crypto.randomUUID();
    const index = (typeof max?.max_index === "number" ? max.max_index : -1) + 1;
    if (messageInput?.parentMessageId) ownedMessage(db, input, messageInput.parentMessageId);
    const extra = applyUsageExtra({}, 1, 0, render.usage, input.providerMetadata, output.media);
    mergeMessageExtra(extra, input.message?.extra);
    const columns = tableColumns(db, "messages");
    const values: unknown[] = [id, input.chatId, index, 0, input.message?.name ?? "", generated, now, 0, JSON.stringify([generated]), JSON.stringify([now]), JSON.stringify(extra), input.message?.parentMessageId ?? null, input.target.branchId, now];
    const names = ["id", "chat_id", "index_in_chat", "is_user", "name", "content", "send_date", "swipe_id", "swipes", "swipe_dates", "extra", "parent_message_id", "branch_id", "created_at"];
    if (columns.has("generation_revision")) { names.push("generation_revision"); values.push(0); }
    const activeNames = names.filter((name) => columns.has(name));
    runSql(db, `INSERT INTO messages (${activeNames.join(", ")}) VALUES (${activeNames.map(() => "?").join(", ")})`, activeNames.map((name) => values[names.indexOf(name)]));
    markMessageRevision(tracker, id, input.chatId);
    markChatRevision(tracker, input.chatId);
    return { messageId: id, swipeId: 0 };
  }

  const targetId = input.target.messageId!;
  const row = ownedMessage(db, input, targetId);
  const currentContent = typeof row.content === "string" ? row.content : "";
  const swipes = parseStrings(row, "swipes", [currentContent]);
  if (swipes.length === 0) swipes.push("");
  const swipeId = input.target.swipeId ?? (typeof row.swipe_id === "number" ? row.swipe_id : 0);
  if (!Number.isSafeInteger(swipeId) || swipeId < 0) throw new AgenticCommitError("target_conflict", "target swipe is malformed");
  const appendsSwipe = (input.target.target === "regenerate" || input.target.target === "swipe") && swipeId === swipes.length;
  if (input.target.target === "continue") {
    if (swipeId >= swipes.length) throw new AgenticCommitError("target_conflict", "continue swipe does not exist");
    swipes[swipeId] = input.message?.append === false ? generated : `${swipes[swipeId]}${generated}`;
  } else if (appendsSwipe) {
    swipes.push(generated);
  } else {
    if (swipeId >= swipes.length) throw new AgenticCommitError("target_conflict", "target swipe does not exist");
    swipes[swipeId] = generated;
  }
  const storedActiveSwipe = typeof row.swipe_id === "number" ? row.swipe_id : 0;
  if (storedActiveSwipe < 0 || storedActiveSwipe >= swipes.length) throw new AgenticCommitError("target_conflict", "stored active swipe is malformed");
  // The bound target is the authoritative swipe for every non-normal turn.
  // Persisting the generated content into one swipe while leaving another
  // active makes the durable message and terminal handoff disagree.
  const activeSwipe = swipeId;
  const extra = applyUsageExtra(parseObject(row, "extra"), swipes.length, swipeId, render.usage, input.providerMetadata, output.media, activeSwipe);
  mergeMessageExtra(extra, input.message?.extra);
  stableJson(extra, MAX_METADATA_BYTES, "message metadata exceeds commit limit");
  const fields = ["swipes = ?", "swipe_dates = ?", "swipe_id = ?", "content = ?", "extra = ?"];
  const swipeDates = parseDates(row, swipes.length, now);
  swipeDates[swipeId] = now;
  const values: unknown[] = [JSON.stringify(swipes), JSON.stringify(swipeDates), activeSwipe, swipes[activeSwipe], JSON.stringify(extra)];
  runSql(db, `UPDATE messages SET ${fields.join(", ")} WHERE id = ? AND chat_id = ?`, [...values, targetId, input.chatId]);
  const changes = db.query("SELECT changes() AS changes").get() as { changes?: number } | null;
  if (Number(changes?.changes ?? 0) !== 1) throw new AgenticCommitError("target_conflict", "target message changed before commit");
  markMessageRevision(tracker, targetId, input.chatId);
  markChatRevision(tracker, input.chatId);
  return { messageId: targetId, swipeId };
}

function applyMetadata(db: Database, input: AgenticCommitInputV1, delta: ChatMetadataDeltaV1, metadata: JsonObject, now: number, tracker: CommitRevisionTracker): void {
  if (!input.authorizeChatMetadataDelta?.(delta) && !SAFE_METADATA_KEYS[delta.key]) throw new AgenticCommitError("unauthorized_delta", `chat metadata delta is not authorized: ${delta.key}`);
  identifier(delta.key, "metadata key");
  if (!["set", "delete"].includes(delta.operation)) throw new AgenticCommitError("invalid_input", "chat metadata operation is malformed");
  if (delta.value !== undefined && delta.value !== null && !["string", "number", "boolean"].includes(typeof delta.value)) throw new AgenticCommitError("invalid_input", "chat metadata value is malformed");
  if (delta.operation === "delete") delete metadata[delta.key]; else metadata[delta.key] = delta.value ?? null;
  tracker.metadataDirty = true;
}

function applyMacro(db: Database, input: AgenticCommitInputV1, delta: MacroVariableDeltaV1, metadata: JsonObject, now: number, tracker: CommitRevisionTracker): void {
  if (!input.authorizeMacroVariableDelta || !input.authorizeMacroVariableDelta(delta)) throw new AgenticCommitError("unauthorized_delta", "macro variable delta is not authorized");
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(delta.key)) throw new AgenticCommitError("invalid_input", "macro variable key is malformed");
  if (!["local", "global", "chat"].includes(delta.scope)) throw new AgenticCommitError("invalid_input", "macro variable scope is malformed");
  if (!["set", "delete"].includes(delta.operation)) throw new AgenticCommitError("invalid_input", "macro variable operation is malformed");
  if (delta.value !== undefined && (typeof delta.value !== "string" || byteLength(delta.value) > MAX_METADATA_BYTES)) throw new AgenticCommitError("invalid_input", "macro variable value exceeds limit");
  if (delta.operation === "set" && typeof delta.value !== "string") throw new AgenticCommitError("invalid_input", "macro variable set requires a string");
  if (delta.scope === "local") throw new AgenticCommitError("unsupported_delta", "local macro variables have no durable commit route");
  if (delta.scope === "chat") {
    const values = isJsonObject(metadata.chat_variables) ? { ...metadata.chat_variables } : {};
    if (delta.operation === "delete") delete values[delta.key]; else values[delta.key] = delta.value;
    metadata.chat_variables = values;
    tracker.metadataDirty = true;
    return;
  }
  const row = db.query("SELECT value FROM settings WHERE key = ? AND user_id = ? LIMIT 1").get("macro_variables_global", input.userId) as { value?: string } | null;
  let global: JsonObject = {};
  if (typeof row?.value === "string") {
    try {
      const parsed: unknown = JSON.parse(row.value);
      if (isJsonObject(parsed)) global = { ...parsed };
    } catch {
      throw new AgenticCommitError("target_conflict", "global macro variable state is malformed");
    }
  }
  if (delta.operation === "delete") delete global[delta.key]; else global[delta.key] = delta.value;
  const serialized = stableJson(global, MAX_METADATA_BYTES, "global macro variables exceed limit");
  runSql(db, `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, ["macro_variables_global", serialized, input.userId, now]);
}

function applySource(db: Database, input: AgenticCommitInputV1, delta: SourceMessageDeltaV1, now: number, tracker: CommitRevisionTracker): void {
  if (!input.authorizeSourceMessageDelta || !input.authorizeSourceMessageDelta(delta)) throw new AgenticCommitError("unauthorized_delta", "source message delta is not authorized");
  identifier(delta.sourceMessageId, "sourceMessageId");
  if (!["create", "update", "delete"].includes(delta.operation)) throw new AgenticCommitError("invalid_input", "source message operation is malformed");
  if (delta.role !== undefined && !["system", "user", "assistant", "tool"].includes(delta.role)) throw new AgenticCommitError("invalid_input", "source message role is malformed");
  if (delta.content !== undefined && (typeof delta.content !== "string" || byteLength(delta.content) > MAX_CONTENT_BYTES)) throw new AgenticCommitError("invalid_input", "source message content exceeds limit");
  const existing = db.query("SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ? AND m.chat_id = ? AND c.user_id = ? LIMIT 1").get(delta.sourceMessageId, input.chatId, input.userId) as SqlRow | null;
  if (delta.operation === "create") {
    if (existing || typeof delta.content !== "string") throw new AgenticCommitError("target_conflict", "source message create is invalid");
    const max = db.query("SELECT COALESCE(MAX(index_in_chat), -1) AS max_index FROM messages WHERE chat_id = ?").get(input.chatId) as { max_index?: number } | null;
    const index = (typeof max?.max_index === "number" ? max.max_index : -1) + 1;
    const isUser = delta.role === "user" ? 1 : 0;
    runSql(db, "INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, parent_message_id, branch_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '{}', NULL, NULL, ?)", [delta.sourceMessageId, input.chatId, index, isUser, delta.role ?? "user", delta.content, now, JSON.stringify([delta.content]), JSON.stringify([now]), now]);
    markMessageRevision(tracker, delta.sourceMessageId, input.chatId);
    markChatRevision(tracker, input.chatId);
    return;
  }
  if (!existing) throw new AgenticCommitError("unauthorized_delta", "source message does not belong to this chat");
  if (delta.operation === "delete") {
    runSql(db, "DELETE FROM messages WHERE id = ? AND chat_id = ?", [delta.sourceMessageId, input.chatId]);
    markChatRevision(tracker, input.chatId);
    return;
  }
  if (typeof delta.content !== "string") throw new AgenticCommitError("invalid_input", "source message update requires content");
  const swipes = parseStrings(existing, "swipes", [typeof existing.content === "string" ? existing.content : ""]);
  const active = typeof existing.swipe_id === "number" ? existing.swipe_id : 0;
  if (active < 0 || active >= swipes.length) throw new AgenticCommitError("target_conflict", "source message swipe is malformed");
  swipes[active] = delta.content;
  runSql(db, "UPDATE messages SET content = ?, swipes = ?, swipe_dates = ? WHERE id = ? AND chat_id = ?", [delta.content, JSON.stringify(swipes), JSON.stringify(parseDates(existing, swipes.length, now)), delta.sourceMessageId, input.chatId]);
  markMessageRevision(tracker, delta.sourceMessageId, input.chatId);
  markChatRevision(tracker, input.chatId);
}

function deltaKind(value: unknown): string | null {
  if (!isJsonObject(value)) return null;
  if (typeof value.kind === "string") return value.kind;
  if (typeof value.targetKind === "string") return TARGET_RECONCILIATION_KIND;
  if (typeof value.sourceMessageId === "string") return "source_message";
  if (typeof value.scriptId === "string") return "regex_action";
  if (typeof value.entryId === "string") return "world_info_state";
  if (typeof value.scope === "string" && typeof value.key === "string") return "macro_variable";
  if (typeof value.key === "string") return "chat_metadata";
  return null;
}
function targetReconciliationKey(target: GenerationTargetV1): string {
  if (target.target === "normal") return "generated_message";
  if (target.target === "continue") return `message:${target.messageId}:continue`;
  return `message:${target.messageId}:swipe:${target.swipeId}`;
}

function isTargetReconciliationDelta(input: AgenticCommitInputV1, delta: ChatMetadataDeltaV1): boolean {
  return delta.kind === "chat_metadata" && delta.key === targetReconciliationKey(input.target);
}
function assertDeltaExpectedRevision(
  input: AgenticCommitInputV1,
  db: Database,
  delta: unknown,
  kind: InputRevisionKindV1,
  id: string | undefined,
  tracker: CommitRevisionTracker,
): void {
  if (!isJsonObject(delta)) throw new AgenticCommitError("invalid_input", "commit delta is malformed");
  const expected = delta.expectedRevision;
  if (expected === undefined) return;
  if (typeof expected !== "number" && typeof expected !== "string") {
    throw new AgenticCommitError("invalid_input", "delta expected revision is malformed");
  }
  const member = revisionSetMember(input.inputRevisions, kind, id);
  if (!member || !input.revisionReader) {
    logExpectedLiveMember({
      kind,
      id,
      expected,
      live: null,
      member: member?.revision ?? null,
      memberDigest: typeof member?.digest === "string" ? member.digest : undefined,
    });
    throw new AgenticCommitError("stale_input_revision", "delta revision source is unavailable", { kind, id });
  }
  const sourceKey = `${member.kind}:${member.id}`;
  const cachedExpectedRevision = tracker.deltas.get(sourceKey);
  if (cachedExpectedRevision !== undefined) {
    if (cachedExpectedRevision !== String(expected)) {
      logExpectedLiveMember({
        kind,
        id,
        expected,
        live: null,
        member: member.revision,
        memberDigest: typeof member.digest === "string" ? member.digest : undefined,
      });
      throw new AgenticCommitError("stale_input_revision", "deltas for one source disagree on expected revision", { kind, id });
    }
    return;
  }
  let current: RevisionValueV1 | InputRevisionV1 | null = null;
  try {
    current = input.revisionReader(member, db);
  } catch {
    current = null;
  }
  if (!current || String(current.revision) !== String(expected)) {
    logExpectedLiveMember({
      kind,
      id,
      expected,
      live: current && "revision" in current ? current.revision : null,
      member: member.revision,
      liveDigest: current && "digest" in current && typeof current.digest === "string" ? current.digest : undefined,
      memberDigest: typeof member.digest === "string" ? member.digest : undefined,
    });
    throw new AgenticCommitError("stale_input_revision", "delta expected revision changed", { kind, id });
  }
  tracker.deltas.set(sourceKey, String(expected));
}


function applyDeltas(db: Database, input: AgenticCommitInputV1, prepared: AgenticPreparedCommitV1, now: number, tracker: CommitRevisionTracker): void {
  const metadata = parseObject(ownedChat(db, input), "metadata");
  const deltas: readonly unknown[] = [
    ...prepared.assembleDeltas,
    ...prepared.renderDeltas.macroVariableDeltas,
    ...prepared.renderDeltas.sourceMessageDeltas,
    ...prepared.renderDeltas.chatMetadataDeltas,
    ...prepared.renderDeltas.regexActionDeltas,
    ...prepared.renderDeltas.worldInfoStateDeltas,
  ];
  if (deltas.length > MAX_DELTA_COUNT * 2) throw new AgenticCommitError("invalid_input", "commit delta count exceeds limit");
  for (const raw of deltas) {
    const kind = deltaKind(raw);
    if (!kind) throw new AgenticCommitError("invalid_input", "commit delta is malformed");
    if (kind === TARGET_RECONCILIATION_KIND) continue;
    if (kind === "chat_metadata" && isTargetReconciliationDelta(input, raw as ChatMetadataDeltaV1)) continue;
    switch (kind) {
      case "macro_variable":
        assertDeltaExpectedRevision(input, db, raw, "macro_variables", undefined, tracker);
        break;
      case "source_message":
        assertDeltaExpectedRevision(input, db, raw, "message", (raw as SourceMessageDeltaV1).sourceMessageId, tracker);
        break;
      case "chat_metadata":
        assertDeltaExpectedRevision(input, db, raw, "chat", input.chatId, tracker);
        break;
      case "regex_action":
        assertDeltaExpectedRevision(input, db, raw, "regex", (raw as RegexActionDeltaV1).scriptId, tracker);
        break;
      case "world_info_state":
        assertDeltaExpectedRevision(input, db, raw, "world_lore", (raw as WorldInfoStateDeltaV1).entryId, tracker);
        break;
    }
    switch (kind) {
      case "macro_variable": applyMacro(db, input, raw as unknown as MacroVariableDeltaV1, metadata, now, tracker); break;
      case "source_message": applySource(db, input, raw as unknown as SourceMessageDeltaV1, now, tracker); break;
      case "chat_metadata": applyMetadata(db, input, raw as unknown as ChatMetadataDeltaV1, metadata, now, tracker); break;
      case "regex_action": {
        const delta = raw as unknown as RegexActionDeltaV1;
        if (!input.authorizeRegexActionDelta?.(delta)) throw new AgenticCommitError("unauthorized_delta", "regex action delta is not authorized");
        if (!input.applyRegexActionDelta) throw new AgenticCommitError("unsupported_delta", "regex action application is unavailable");
        input.applyRegexActionDelta(db, delta);
        break;
      }
      case "world_info_state": {
        const delta = raw as unknown as WorldInfoStateDeltaV1;
        if (!input.authorizeWorldInfoStateDelta?.(delta)) throw new AgenticCommitError("unauthorized_delta", "world-info state delta is not authorized");
        if (!input.applyWorldInfoStateDelta) throw new AgenticCommitError("unsupported_delta", "world-info state application is unavailable");
        const beforeMetadata = stableJson(metadata, MAX_METADATA_BYTES, "chat metadata exceeds commit limit");
        input.applyWorldInfoStateDelta(db, delta, metadata);
        const afterMetadata = stableJson(metadata, MAX_METADATA_BYTES, "chat metadata exceeds commit limit");
        if (afterMetadata !== beforeMetadata) tracker.metadataDirty = true;
        break;
      }
      default: throw new AgenticCommitError("invalid_input", `unsupported commit delta: ${kind}`);
    }
  }
  if (tracker.metadataDirty) {
    runSql(db, "UPDATE chats SET metadata = ?, updated_at = ? WHERE id = ? AND user_id = ?", [
      stableJson(metadata, MAX_METADATA_BYTES, "chat metadata exceeds commit limit"),
      now,
      input.chatId,
      input.userId,
    ]);
    const changes = db.query("SELECT changes() AS changes").get() as { changes?: number } | null;
    if (Number(changes?.changes ?? 0) !== 1) throw new AgenticCommitError("target_conflict", "chat metadata changed before commit");
    markChatRevision(tracker, input.chatId);
  }
}

function buildHandoff(
  input: AgenticCommitInputV1,
  resolvedWorkspaceId = input.workspaceId ?? input.terminalHandoff.workspaceId,
  workspace?: SqlRow | null,
): WorkspaceTerminalHandoffV1 {
  const revision = Number(workspace?.revision ?? input.terminalHandoff.revision);
  return stableValue({
    ...input.terminalHandoff,
    workspaceId: resolvedWorkspaceId,
    state: "frozen",
    revision,
    executionState: "COMMITTED" as TurnExecutionStateV1,
    usage: input.terminalHandoff.usage,
  }) as WorkspaceTerminalHandoffV1;
}

function buildReceipt(input: AgenticCommitInputV1, handoff: WorkspaceTerminalHandoffV1, messageId: string | null, swipeId: number | null, now: number): WorkspaceCommitReceiptV1 {
  const summary = input.completion?.summary ?? "";
  if (byteLength(summary) > MAX_SUMMARY_BYTES) throw new AgenticCommitError("invalid_input", "completion summary exceeds limit");
  if ((input.completion?.unresolvedIds?.length ?? 0) > MAX_UNRESOLVED_IDS) throw new AgenticCommitError("invalid_input", "unresolved id list exceeds limit");
  const artifactRefCount = input.artifacts?.length ?? 0;
  return {
    id: crypto.randomUUID(),
    turnId: input.turnId,
    executionId: input.executionId,
    workspaceId: handoff.workspaceId,
    userId: input.userId,
    chatId: input.chatId,
    commitKey: input.commitKey,
    idempotencyKey: input.idempotencyKey ?? input.commitKey,
    state: "committed",
    summaryDigest: sha256({ summary, unresolvedIds: input.completion?.unresolvedIds ?? [] }),
    summary,
    messageId,
    swipeId,
    artifactRefCount,
    committedAt: now,
  };
}

function receiptSummaryText(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "string") return parsed;
    if (isJsonObject(parsed) && typeof parsed.summary === "string") return parsed.summary;
  } catch {
    // Legacy rows may store the bounded summary as plain text.
  }
  return value;
}

function receiptFromRow(row: SqlRow | null): WorkspaceCommitReceiptV1 | null {
  if (!row) return null;
  const raw = typeof row.receipt_json === "string" ? row.receipt_json : null;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isJsonObject(parsed) && parsed.state === "committed") {
        const id = typeof parsed.id === "string" ? parsed.id : null;
        const turnId = typeof parsed.turnId === "string" ? parsed.turnId : null;
        const executionId = typeof parsed.executionId === "string" ? parsed.executionId : null;
        const workspaceId = typeof parsed.workspaceId === "string" ? parsed.workspaceId : null;
        const userId = typeof parsed.userId === "string" ? parsed.userId : null;
        const chatId = typeof parsed.chatId === "string" ? parsed.chatId : null;
        const commitKey = typeof parsed.commitKey === "string" ? parsed.commitKey : null;
        const idempotencyKey = typeof parsed.idempotencyKey === "string" ? parsed.idempotencyKey : commitKey;
        if (id && turnId && executionId && workspaceId && userId && chatId && commitKey && idempotencyKey) {
          return {
            id,
            turnId,
            executionId,
            workspaceId,
            userId,
            chatId,
            commitKey,
            idempotencyKey,
            state: "committed",
            summaryDigest: typeof parsed.summaryDigest === "string" ? parsed.summaryDigest : "",
            // Pick only the public completion summary. renderGuidance and any
            // unknown receipt fields are deliberately discarded on read.
            summary: receiptSummaryText(parsed.summary),
            messageId: typeof parsed.messageId === "string" ? parsed.messageId : null,
            swipeId: typeof parsed.swipeId === "number" ? parsed.swipeId : null,
            artifactRefCount: typeof parsed.artifactRefCount === "number" ? parsed.artifactRefCount : 0,
            committedAt: typeof parsed.committedAt === "number" ? parsed.committedAt : 0,
          };
        }
      }
    } catch { /* use columns below */ }
  }
  const receiptId = typeof row.id === "string" ? row.id : typeof row.receipt_id === "string" ? row.receipt_id : null;
  const required = ["turn_id", "execution_id", "workspace_id", "user_id", "chat_id", "commit_key"];
  if (!receiptId || required.some((key) => typeof row[key] !== "string")) return null;
  return {
    id: receiptId,
    turnId: row.turn_id as string,
    executionId: row.execution_id as string,
    workspaceId: row.workspace_id as string,
    userId: row.user_id as string,
    chatId: row.chat_id as string,
    commitKey: row.commit_key as string,
    idempotencyKey: typeof row.idempotency_key === "string" ? row.idempotency_key : row.commit_key as string,
    state: "committed",
    summaryDigest: typeof row.summary_digest === "string" ? row.summary_digest : "",
    summary: receiptSummaryText(row.summary_json ?? row.summary),
    messageId: typeof row.message_id === "string" ? row.message_id : null,
    swipeId: typeof row.swipe_id === "number" ? row.swipe_id : null,
    artifactRefCount: typeof row.artifact_ref_count === "number" ? row.artifact_ref_count : 0,
    committedAt: typeof row.committed_at === "number" ? row.committed_at : Number(row.created_at ?? 0),
  };
}

function assertDuplicateIdentity(db: Database, input: AgenticCommitInputV1, receipt: WorkspaceCommitReceiptV1, key: string): void {
  if (
    receipt.userId !== input.userId
    || receipt.turnId !== input.turnId
    || receipt.executionId !== input.executionId
    || receipt.chatId !== input.chatId
    || receipt.commitKey !== input.commitKey
    || receipt.idempotencyKey !== key
    || (input.workspaceId !== undefined && receipt.workspaceId !== input.workspaceId)
  ) {
    throw new AgenticCommitError("receipt_conflict", "commit idempotency key belongs to another turn");
  }
  const execution = db.query("SELECT * FROM agent_turn_executions WHERE id = ? AND user_id = ? LIMIT 1").get(input.executionId, input.userId) as SqlRow | null;
  if (!execution) throw new AgenticCommitError("receipt_conflict", "commit receipt execution is unavailable");
  const same = (stored: unknown, expected: unknown): boolean => (
    stored === undefined || stored === null
      ? expected === null || expected === undefined
      : String(stored) === String(expected)
  );
  if (
    !same(execution.user_id, input.userId)
    || !same(execution.chat_id, input.chatId)
    || !same(execution.generation_id, input.generationId)
    || !same(execution.commit_key, input.commitKey)
    || !same(execution.workspace_id, receipt.workspaceId)
    || (execution.target_kind !== undefined && !same(execution.target_kind, input.target.target))
    || (execution.target_message_id !== undefined && !same(execution.target_message_id, input.target.messageId))
    || (execution.target_swipe_id !== undefined && !same(execution.target_swipe_id, input.target.swipeId))
    || (execution.branch_id !== undefined && !same(execution.branch_id, input.target.branchId))
  ) {
    throw new AgenticCommitError("receipt_conflict", "commit receipt identity does not match the immutable execution");
  }
}

function canonicalDuplicateHandoff(
  db: Database,
  input: AgenticCommitInputV1,
  receipt: WorkspaceCommitReceiptV1,
): WorkspaceTerminalHandoffV1 {
  const workspace = workspaceRow(db, input, receipt.workspaceId);
  if (!workspace || workspace.user_id !== input.userId || workspace.chat_id !== input.chatId || workspace.execution_id !== input.executionId) {
    throw new AgenticCommitError("receipt_conflict", "commit receipt workspace is unavailable");
  }
  const revision = Number(workspace.revision);
  const usageValues = ["task_count", "record_count", "submission_count", "artifact_count", "byte_count"].map((key) => Number(workspace[key]));
  if (!Number.isSafeInteger(revision) || revision < 0 || usageValues.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new AgenticCommitError("receipt_conflict", "commit receipt workspace state is malformed");
  }
  const state = workspace.state === "expired" ? "expired" : workspace.state === "frozen" ? "frozen" : null;
  if (!state) throw new AgenticCommitError("receipt_conflict", "commit receipt workspace is not terminal");
  return stableValue({
    workspaceId: receipt.workspaceId,
    state,
    revision,
    executionState: "COMMITTED" as TurnExecutionStateV1,
    usage: {
      taskCount: usageValues[0],
      recordCount: usageValues[1],
      submissionCount: usageValues[2],
      artifactCount: usageValues[3],
      byteCount: usageValues[4],
    },
    // Terminalization releases every reservation. Never echo a retry payload.
    finalRenderReservations: [],
  }) as WorkspaceTerminalHandoffV1;
}

function findReceipt(db: Database, input: AgenticCommitInputV1): WorkspaceCommitReceiptV1 | null {
  if (!tableExists(db, "agent_turn_commit_receipts")) return null;
  const key = input.idempotencyKey ?? input.commitKey;
  const columns = tableColumns(db, "agent_turn_commit_receipts");
  const keyColumn = columns.has("idempotency_key") ? "idempotency_key" : columns.has("commit_key") ? "commit_key" : null;
  if (!keyColumn) return null;
  const receipt = receiptFromRow(
    db.query(`SELECT * FROM agent_turn_commit_receipts WHERE user_id = ? AND ${keyColumn} = ? LIMIT 1`).get(input.userId, key) as SqlRow | null,
  );
  if (!receipt) return null;
  assertDuplicateIdentity(db, input, receipt, key);
  return receipt;
}

function updateChatRevision(db: Database, input: AgenticCommitInputV1, now: number, tracker: CommitRevisionTracker): void {
  runSql(db, "UPDATE chats SET updated_at = ? WHERE id = ? AND user_id = ?", [now, input.chatId, input.userId]);
  const changes = db.query("SELECT changes() AS changes").get() as { changes?: number } | null;
  if (Number(changes?.changes ?? 0) !== 1) throw new AgenticCommitError("target_conflict", "chat changed before commit");
  markChatRevision(tracker, input.chatId);
}
function turnExecutionInput(input: AgenticCommitInputV1): Parameters<typeof beginTurnCommit>[0] {
  return {
    executionId: input.executionId,
    ownerToken: input.ownerToken,
    expectedRevision: input.expectedRevision,
    db: input.db,
  };
}

function beginGate(input: AgenticCommitInputV1): void {
  try {
    const result = input.dependencies.beginTurnCommit(turnExecutionInput(input));
    if (result.execution.phase === "CANCELLED") throw new AgenticCommitError("cancelled", "turn was cancelled before commit gate");
    if (result.execution.phase === "TIMED_OUT") throw new AgenticCommitError("timed_out", "turn timed out before commit gate");
    if (result.execution.phase === "COMMITTED") throw new AgenticCommitError("receipt_conflict", "commit already completed");
  } catch (error) {
    let code = "";
    if (error instanceof Error && "code" in error && typeof error.code === "string") code = error.code;
    if (code === "cancelled") throw new AgenticCommitError("cancelled", "turn was cancelled before commit gate");
    if (code === "deadline_exceeded") throw new AgenticCommitError("timed_out", "turn timed out before commit gate");
    if (code === "execution_not_found") throw new AgenticCommitError("execution_not_found", "turn execution was not found");
    if (error instanceof AgenticCommitError) throw error;
    throw new AgenticCommitError("statement_failed", "commit gate failed");
  }
}

function receiptSummary(input: AgenticCommitInputV1): unknown {
  return {
    summary: input.completion?.summary ?? "",
    unresolvedIds: input.completion?.unresolvedIds ?? [],
  };
}

function artifactRefs(input: AgenticCommitInputV1, messageId: string | null, swipeId: number | null): readonly ArtifactPublicationInput[] {
  return (input.artifacts ?? []).map((artifact) => ({
    digest: artifact.blobDigest,
    byteCount: artifact.byteCount,
    mimeType: artifact.mimeType,
    provenance: artifact.provenance,
    retention: artifact.retention,
    messageId,
    swipeId,
    workspaceArtifactId: artifact.id,
  }));
}

function projectionInput(
  input: AgenticCommitInputV1,
  messageId: string | null,
  swipeId: number | null,
  usage: RenderUsageV1,
): AgentRunProjectionInputV2 {
  const activityCounts = projectionActivityCounts(input);
  const projectionUsage = {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    toolCalls: activityCounts.toolCalls,
    childInvocations: activityCounts.childInvocations,
  };
  return {
    userId: input.userId,
    chatId: input.chatId,
    turnId: input.turnId,
    generationId: input.generationId,
    generationType: input.target.target,
    activity: input.activity,
    omission: input.activityOmittedNodeCount === undefined
      ? undefined
      : { omittedNodeCount: input.activityOmittedNodeCount },
    status: "COMMITTED",
    targetMessageId: input.target.messageId,
    targetSwipeId: input.target.swipeId,
    usage: projectionUsage,
    terminalHandoff: {
      version: 2,
      committed: true,
      messageId,
      swipeId,
      messageRevision: messageId === null ? null : (input.target.messageGenerationRevision ?? 0) + 1,
      swipeRevision: swipeId === null ? null : (input.target.messageGenerationRevision ?? 0) + 1,
    },
    compatibilitySnapshot: {
      generationId: input.generationId,
      targetMessageId: messageId,
      targetSwipeId: swipeId,
      status: "COMMITTED",
      usage: projectionUsage,
    },
  };
}

function checkBeforeGate(input: AgenticCommitInputV1): void {
  if (input.signal?.aborted) throw new AgenticCommitError("cancelled", "commit was cancelled before commit gate");
  if (input.deadlineAt !== undefined && input.deadlineAt > 0 && nowMilliseconds(input.now) >= Math.floor(input.deadlineAt)) throw new AgenticCommitError("timed_out", "commit deadline elapsed before commit gate");
}
/**
 * Acquire SQLite's write reservation before the authoritative revision reads.
 * A deferred transaction otherwise permits another writer to advance a
 * revision between the read fence and the first delta/message mutation.
 */
function acquireCommitWriteFence(db: Database, input: AgenticCommitInputV1): void {
  if (!tableExists(db, "agent_turn_executions")) {
    throw new AgenticCommitError("execution_not_found", "turn execution is unavailable");
  }
  const columns = tableColumns(db, "agent_turn_executions");
  const stateColumn = columns.has("phase") ? "phase" : columns.has("state") ? "state" : null;
  const ownerColumn = columns.has("cas_owner") ? "cas_owner" : columns.has("owner_token") ? "owner_token" : null;
  const revisionColumn = columns.has("cas_revision") ? "cas_revision" : columns.has("revision") ? "revision" : null;
  const updatedColumn = columns.has("updated_at") ? "updated_at" : null;
  if (!stateColumn || !ownerColumn || !revisionColumn || !updatedColumn) {
    throw new AgenticCommitError("statement_failed", "turn execution write fence is unavailable");
  }
  const execution = db.query(
    `SELECT ${stateColumn} AS phase, ${ownerColumn} AS owner, ${revisionColumn} AS revision
       FROM agent_turn_executions WHERE id = ? AND user_id = ? LIMIT 1`,
  ).get(input.executionId, input.userId) as { phase?: unknown; owner?: unknown; revision?: unknown } | null;
  if (!execution || execution.phase !== "COMMITTING" || execution.owner !== input.ownerToken) {
    throw new AgenticCommitError("target_conflict", "turn execution changed before authoritative commit fence");
  }
  const executionRevision = Number(execution.revision);
  if (!Number.isSafeInteger(executionRevision) || executionRevision < 0) {
    throw new AgenticCommitError("target_conflict", "turn execution revision is invalid");
  }
  const result = db.query(
    `UPDATE agent_turn_executions
        SET ${updatedColumn} = ${updatedColumn}
      WHERE id = ? AND user_id = ? AND ${stateColumn} = 'COMMITTING'
        AND ${ownerColumn} = ? AND ${revisionColumn} = ?`,
  ).run(input.executionId, input.userId, input.ownerToken, executionRevision);
  if (result.changes !== 1) {
    throw new AgenticCommitError("target_conflict", "turn execution changed before authoritative commit fence");
  }
}


export function commitAgenticTurnV1(input: AgenticCommitInputV1): AgenticCommitResultV1 {
  const db = input.db ?? getDb();
  // Idempotent retries are authenticated by the immutable receipt identity only.
  // Do this lookup before render/revision validation: a successful commit has
  // legitimately advanced target revisions and released its render reservation.
  const existing = findReceipt(db, input);
  if (existing) {
    return {
      status: "duplicate",
      receipt: existing,
      terminalHandoff: canonicalDuplicateHandoff(db, input, existing),
      messageId: existing.messageId,
      swipeId: existing.swipeId,
    };
  }
  const prepared = prepareAgenticCommitV1(input);
  assertExecutionBinding(db, input);
  recheckInputRevisions(input, prepared.inputRevisions, db);
  checkBeforeGate(input);
  beginGate(input);
  const now = nowSeconds(input.now);
  const handoff = buildHandoff(input, resolveExecutionWorkspaceId(db, input), workspaceRow(db, input, resolveExecutionWorkspaceId(db, input)));
  const artifacts = input.artifacts ?? [];
  const reservedMessageId = input.target.target === "normal" ? crypto.randomUUID() : undefined;
  const plannedMessageId = reservedMessageId ?? input.target.messageId;
  const plannedSwipeId = input.target.target === "normal" ? 0 : input.target.swipeId;
  const draftReceipt = buildReceipt(input, handoff, plannedMessageId, plannedSwipeId, now);
  type CommitTransactionValue = {
    readonly messageId: string | null;
    readonly swipeId: number | null;
    readonly projectionSequence: number;
    readonly projectionRevision: number;
    readonly projectionEvent: BufferedEvent;
  };
  let committed: { readonly duplicate: boolean; readonly receipt: { readonly createdAt: number }; readonly value?: CommitTransactionValue } | undefined;
  try {
    committed = db.transaction(() => input.dependencies.finalizeTurnCommitInTransaction(db, {
      executionId: input.executionId,
      ownerToken: input.ownerToken,
      receiptId: draftReceipt.id,
      workspaceId: draftReceipt.workspaceId,
      idempotencyKey: draftReceipt.idempotencyKey,
      summary: receiptSummary(input),
      messageId: draftReceipt.messageId,
      swipeId: draftReceipt.swipeId,
      artifactRefCount: artifacts.length,
      apply: (transactionDb) => {
        acquireCommitWriteFence(transactionDb, input);
        assertExecutionBinding(transactionDb, input);
        recheckInputRevisions(input, prepared.inputRevisions, transactionDb);
        const revisions = createCommitRevisionTracker();
        const message = applyMessage(transactionDb, input, prepared.render, now, revisions, reservedMessageId);
        applyDeltas(transactionDb, input, prepared, now, revisions);
        updateChatRevision(transactionDb, input, now, revisions);
        if (artifacts.length > 0) {
          assertExecutionBinding(transactionDb, input);
          try {
            input.dependencies.publishArtifactCommit(transactionDb, {
              userId: input.userId,
              chatId: input.chatId,
              turnId: input.turnId,
              executionId: input.executionId,
              workspaceId: draftReceipt.workspaceId,
              commitKey: input.commitKey,
              receiptId: draftReceipt.id,
              idempotencyKey: draftReceipt.idempotencyKey,
              targetMessageId: message.messageId,
              targetSwipeId: message.swipeId,
              refs: artifactRefs(input, message.messageId, message.swipeId),
              assertFence: () => assertExecutionBinding(transactionDb, input),
            });
            assertExecutionBinding(transactionDb, input);
          } catch {
            throw new AgenticCommitError("artifact_publish_failed", "artifact publication failed");
          }
        }
        let projection: ReturnType<typeof publishAgentRunCommit>;
        try {
          projection = input.dependencies.publishAgentRunCommit(transactionDb, projectionInput(
            input,
            message.messageId,
            message.swipeId,
            prepared.render.usage,
          ));
        } catch {
          throw new AgenticCommitError("projection_failed", "terminal projection failed");
        }
        if (!projection.event) throw new AgenticCommitError("projection_failed", "terminal projection event is missing");
        flushCommitRevisionBumps(transactionDb, revisions);
        return {
          messageId: message.messageId,
          swipeId: message.swipeId,
          projectionSequence: projection.sequence,
          projectionRevision: projection.revision,
          projectionEvent: projection.event,
        };
      },
    })).immediate();
  } catch (error) {
    try {
      input.dependencies.failTurnCommit({
        executionId: input.executionId,
        ownerToken: input.ownerToken,
        reason: error instanceof AgenticCommitError ? error.code : "commit_failed",
        db,
      });
    } catch { /* startup reconciliation owns a lost fence */ }
    if (error instanceof AgenticCommitError) throw error;
    throw new AgenticCommitError("statement_failed", "Agentic commit transaction rolled back");
  }
  if (!committed) throw new AgenticCommitError("statement_failed", "commit transaction produced no result");
  if (committed.duplicate) {
    const duplicate = findReceipt(db, input);
    if (!duplicate) throw new AgenticCommitError("receipt_conflict", "duplicate commit receipt is unavailable");
    return {
      status: "duplicate",
      receipt: duplicate,
      terminalHandoff: canonicalDuplicateHandoff(db, input, duplicate),
      messageId: duplicate.messageId,
      swipeId: duplicate.swipeId,
    };
  }
  if (!committed.value) throw new AgenticCommitError("statement_failed", "commit transaction produced no result");
  input.dependencies.emitProjectionEvent(committed.value.projectionEvent, db);
  const receipt = findReceipt(db, input);
  if (!receipt) throw new AgenticCommitError("receipt_conflict", "commit receipt is unavailable after transaction");
  const committedHandoff = canonicalDuplicateHandoff(db, input, receipt);
  return {
    status: "committed",
    receipt,
    terminalHandoff: committedHandoff,
    messageId: committed.value.messageId,
    swipeId: committed.value.swipeId,
    projectionSequence: committed.value.projectionSequence,
    projectionRevision: committed.value.projectionRevision,
  };
}

export function reconcileAgenticCommitReceipt(
  input: Pick<AgenticCommitInputV1, "db" | "executionId" | "ownerToken" | "commitKey"> & { readonly dependencies: AgenticCommitDependenciesV1 },
): WorkspaceCommitReceiptV1 | null {
  const db = input.db ?? getDb();
  if (!tableExists(db, "agent_turn_commit_receipts")) return null;
  const row = db.query("SELECT * FROM agent_turn_commit_receipts WHERE execution_id = ? AND commit_key = ? LIMIT 1").get(input.executionId, input.commitKey) as SqlRow | null;
  const receipt = receiptFromRow(row);
  if (!receipt) return null;
  input.dependencies.finalizeTurnCommit({
    executionId: input.executionId,
    ownerToken: input.ownerToken,
    receiptId: receipt.id,
    workspaceId: receipt.workspaceId,
    idempotencyKey: receipt.idempotencyKey,
    messageId: receipt.messageId,
    swipeId: receipt.swipeId,
    artifactRefCount: receipt.artifactRefCount,
    db,
  });
  return receipt;
}
