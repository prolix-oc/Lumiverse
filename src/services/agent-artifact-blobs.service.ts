import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import type { Stats } from "node:fs";
import { mkdir, open, link, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AgentArtifactBlobJournalV1,
  AgentArtifactBlobV1,
  PublishedWorkspaceArtifactV1,
  WorkspaceArtifactProvenanceV1,
  WorkspaceArtifactReferenceV1,
  WorkspaceCommitReceiptV1,
  WorkspaceRetentionV1,
} from "../types/turn-workspace";
import { env } from "../env";
import { getDb } from "../db/connection";
import { withUserDataMutation, withUserDataMutationSync } from "./user-data/snapshot";

export type ArtifactRetention = WorkspaceRetentionV1;
export type ArtifactProvenance = WorkspaceArtifactProvenanceV1;
export type ArtifactBlobRecord = AgentArtifactBlobV1;
export type ArtifactJournalRecord = AgentArtifactBlobJournalV1;
export type ArtifactWorkspaceReference = WorkspaceArtifactReferenceV1;
export type ArtifactCommitRecord = WorkspaceCommitReceiptV1;
export type ArtifactPublishedRecord = PublishedWorkspaceArtifactV1;

export type ArtifactBlobProvenanceV1 = WorkspaceArtifactProvenanceV1;


export interface ArtifactBlobLimits {
  readonly maxArtifactBytes: number;
  readonly maxTurnBytes: number;
  readonly maxUserBytes: number;
  readonly maxUserBlobs: number;
  readonly maxMimeBytes: number;
  readonly maxProvenanceBytes: number;
  readonly maxCleanupRows: number;
  readonly maxCleanupBytes: number;
}

export const DEFAULT_ARTIFACT_BLOB_LIMITS: ArtifactBlobLimits = Object.freeze({
  maxArtifactBytes: 8 * 1024 * 1024,
  maxTurnBytes: 64 * 1024 * 1024,
  maxUserBytes: 512 * 1024 * 1024,
  maxUserBlobs: 1_024,
  maxMimeBytes: 128,
  maxProvenanceBytes: 4_096,
  maxCleanupRows: 128,
  maxCleanupBytes: 64 * 1024 * 1024,
});

export type ArtifactBlobErrorCode =
  | "artifact_schema_unavailable"
  | "artifact_invalid_user"
  | "artifact_invalid_turn"
  | "artifact_invalid_digest"
  | "artifact_digest_mismatch"
  | "artifact_digest_conflict"
  | "artifact_invalid_mime"
  | "artifact_invalid_provenance"
  | "artifact_provenance_too_large"
  | "artifact_size_limit_exceeded"
  | "artifact_turn_quota_exceeded"
  | "artifact_user_quota_exceeded"
  | "artifact_fence_lost"
  | "artifact_cancelled"
  | "artifact_creator_conflict"
  | "artifact_not_found"
  | "artifact_unauthorized"
  | "artifact_commit_conflict"
  | "artifact_commit_invalid"
  | "artifact_file_missing"
  | "artifact_file_mismatch";

export class ArtifactBlobError extends Error {
  readonly code: ArtifactBlobErrorCode;
  readonly details?: Readonly<Record<string, string | number>>;

  constructor(code: ArtifactBlobErrorCode, message: string, details?: Record<string, string | number>) {
    super(message);
    this.name = "ArtifactBlobError";
    this.code = code;
    this.details = details ? Object.freeze({ ...details }) : undefined;
  }
}

export interface ArtifactBlobWriteInput {
  readonly userId: string;
  readonly turnId: string;
  readonly workspaceId?: string;
  readonly bytes: Uint8Array | ArrayBuffer;
  readonly digest?: string;
  readonly mimeType: string;
  readonly provenance: ArtifactBlobProvenanceV1;
  readonly retention?: ArtifactRetention;
  readonly expiresAt?: number | null;
  /** The execution owner/fence generation frozen for this operation. */
  readonly fence: string | number;
  /** Optional stable token supplied by the execution owner for retries. */
  readonly creatorToken?: string;
  readonly signal?: AbortSignal;
  /** Checked before filesystem work, after linking, and before the journal result. */
  readonly assertFence: () => void;
}

export interface ArtifactBlobHandle {
  readonly digest: string;
  readonly userId: string;
  readonly turnId: string;
  readonly workspaceId?: string;
  readonly byteCount: number;
  readonly mimeType: string;
  readonly storagePath: string;
  readonly journalId: string;
  readonly creatorToken: string;
  readonly createdByThisOperation: boolean;
  readonly retention: ArtifactRetention;
  readonly expiresAt: number | null;
}

export interface ArtifactPublicationInput {
  readonly digest: string;
  readonly byteCount: number;
  readonly mimeType: string;
  readonly provenance: ArtifactBlobProvenanceV1;
  readonly retention: ArtifactRetention;
  readonly messageId: string | null;
  readonly swipeId: number | null;
  /** Host-authorized workspace row proving publication ownership. */
  readonly workspaceArtifactId: string;
}
export interface ArtifactAttachableInput {
  readonly userId: string;
  readonly turnId: string;
  readonly digest: string;
  readonly byteCount: number;
  readonly mimeType: string;
  readonly creatorToken: string;
  readonly assertFence: () => void;
  /** Internal capability: only the module-issued token may skip its own fence probe. */
  readonly deletionFence?: symbol;
}
export interface ArtifactBlobAvailabilityInput {
  readonly userId: string;
  readonly digest: string;
  readonly byteCount: number;
  readonly mimeType: string;
}

export interface ArtifactPublishInput {
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly executionId?: string;
  readonly workspaceId?: string;
  readonly commitKey: string;
  readonly receiptId: string;
  readonly idempotencyKey?: string;
  readonly targetMessageId: string | null;
  readonly targetSwipeId: number | null;
  readonly refs: readonly ArtifactPublicationInput[];
  readonly fence?: string | number;
  readonly assertFence: () => void;
}

export interface ArtifactCommitReceipt {
  readonly receiptId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly commitKey: string;
  readonly duplicate: boolean;
  readonly artifactCount: number;
  readonly byteCount: number;
  readonly digests: readonly string[];
  readonly committedAt: number;
}

export interface ArtifactReconcileResult {
  readonly inspected: number;
  readonly retained: number;
  readonly removed: number;
  readonly stale: number;
  readonly quarantined: number;
  readonly bytesRemoved: number;
  /** Users whose durable journal rows were skipped behind a lifecycle fence. */
  readonly pendingUsers?: number;
  /** True only when no user retry or bounded global continuation remains. */
  readonly healthy?: boolean;
  readonly pendingOverflow?: boolean;
  /** True while a bounded global pass has durable continuation work. */
  readonly pendingGlobal?: boolean;
}

export interface ArtifactCleanupResult {
  readonly inspected: number;
  readonly removed: number;
  readonly skippedReferenced: number;
  readonly skippedShared: number;
  readonly quarantined: number;
  readonly bytesRemoved: number;
}

export interface ArtifactBlobStoreOptions {
  readonly db?: Database;
  readonly rootDir?: string;
  readonly limits?: Partial<ArtifactBlobLimits>;
  readonly now?: () => number;
}

type SqlRow = Record<string, unknown>;
type FileIdentity = {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
};
type JournalMarker = {
  readonly before: string | null;
  readonly after?: string | null;
  readonly createdByUs: boolean;
  readonly deleting?: boolean;
};

type JournalRow = {
  readonly id: string;
  readonly digest: string;
  readonly userId: string;
  readonly turnId: string;
  readonly creatorToken: string;
  readonly fence: string;
  readonly stagedPath: string;
  readonly finalPath: string;
  readonly state: "pending" | "installed" | "removed";
  readonly observedIdentity: string | null;
  readonly byteCount: number;
};

const DIGEST_RE = /^[0-9a-f]{64}$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*[a-z0-9!#$&^_.+-]+\s*=\s*[a-z0-9!#$&^_.+-]+)*$/i;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const RETENTIONS: Record<ArtifactRetention, true> = {
  operational: true,
  turn_terminal: true,
  chat_lifetime: true,
};
const PROVENANCE_KINDS: Record<WorkspaceArtifactProvenanceV1, true> = {
  host: true,
  root: true,
  child: true,
};
const DEFAULT_ROOT_NAME = "agent-artifacts";

/**
 * Every operation that can observe or mutate user-owned artifact bytes first
 * enters this per-user lifecycle fence. Account purge takes the exclusive
 * deletion side and keeps it until both the SQL outcome and root cleanup are
 * durable; new work is rejected once deletion starts. The user scope is
 * intentionally acquired before the narrower digest fence everywhere.
 */
type ArtifactUserLifecycleFenceState = {
  active: number;
  deleting: boolean;
  waiters: Array<() => void>;
};
const artifactUserLifecycleFences = new Map<string, ArtifactUserLifecycleFenceState>();
const MAX_PENDING_RECONCILE_USERS = 256;
type PendingArtifactReconcile = { attempts: number; lastAttemptAt: number };
const pendingArtifactReconciles = new Map<string, PendingArtifactReconcile>();
let pendingArtifactReconcileOverflow = false;
/**
 * The journal rows themselves are the durable continuation record for a
 * bounded global pass. This process-local latch/cursor is bound to the active
 * database authority and keeps readiness closed until a later global pass
 * observes that no eligible rows remain beyond its cap.
 */
let pendingArtifactReconcileGlobal = false;
let pendingArtifactReconcileGlobalCursor: string | undefined;
let pendingArtifactReconcileGlobalDb: Database | undefined;
let artifactReconcileRetryTimer: ReturnType<typeof setTimeout> | undefined;
let artifactReconcileRetryStore: ArtifactBlobStore | undefined;

function markArtifactReconcilePending(userId: string): void {
  if (!pendingArtifactReconciles.has(userId) && pendingArtifactReconciles.size >= MAX_PENDING_RECONCILE_USERS) {
    pendingArtifactReconcileOverflow = true;
    return;
  }
  const current = pendingArtifactReconciles.get(userId);
  pendingArtifactReconciles.set(userId, {
    attempts: current?.attempts ?? 0,
    lastAttemptAt: current?.lastAttemptAt ?? 0,
  });
}

function scheduleArtifactReconcileRetry(userId: string): void {
  const pending = pendingArtifactReconciles.get(userId);
  if (!pending || artifactReconcileRetryTimer) return;
  const delayMs = Math.min(30_000, 25 * (2 ** Math.min(pending.attempts, 10)));
  artifactReconcileRetryTimer = setTimeout(() => {
    artifactReconcileRetryTimer = undefined;
    const store = artifactReconcileRetryStore;
    if (!store) return;
    void store.reconcilePendingUsers().catch(() => {
      // Durable journal rows remain pending; the next fence release retries.
    });
  }, delayMs);
  artifactReconcileRetryTimer.unref?.();
}

export interface ArtifactReconcileStatus {
  readonly pendingUsers: number;
  readonly pendingOverflow: boolean;
  readonly pendingGlobal: boolean;
  readonly healthy: boolean;
}

export function getArtifactReconcileStatus(): ArtifactReconcileStatus {
  return {
    pendingUsers: pendingArtifactReconciles.size,
    pendingOverflow: pendingArtifactReconcileOverflow,
    pendingGlobal: pendingArtifactReconcileGlobal,
    healthy: pendingArtifactReconciles.size === 0 && !pendingArtifactReconcileOverflow && !pendingArtifactReconcileGlobal,
  };
}

/** Return whether the active database still owns a bounded global continuation. */
export function hasPendingArtifactReconcileGlobal(db?: Database): boolean {
  return pendingArtifactReconcileGlobal && (db === undefined || pendingArtifactReconcileGlobalDb === db);
}

function userLifecycleState(userId: string): ArtifactUserLifecycleFenceState {
  let state = artifactUserLifecycleFences.get(userId);
  if (!state) {
    state = { active: 0, deleting: false, waiters: [] };
    artifactUserLifecycleFences.set(userId, state);
  }
  return state;
}

function acquireArtifactUserOperation(userId: string): () => void {
  const safeUserId = assertSafeId(userId, "artifact_invalid_user", "User id");
  const state = userLifecycleState(safeUserId);
  if (state.deleting) throw new ArtifactBlobError("artifact_fence_lost", "Artifact user lifecycle is being deleted");
  state.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active = Math.max(0, state.active - 1);
    if (state.deleting && state.active === 0) {
      const waiters = state.waiters.splice(0);
      for (const resolve of waiters) resolve();
    } else if (!state.deleting && state.active === 0) {
      artifactUserLifecycleFences.delete(safeUserId);
    }
  };
}

function beginArtifactUserDeletion(userId: string): () => void {
  const safeUserId = assertSafeId(userId, "artifact_invalid_user", "User id");
  const state = userLifecycleState(safeUserId);
  state.deleting = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.deleting = false;
    scheduleArtifactReconcileRetry(safeUserId);
    if (state.active === 0) artifactUserLifecycleFences.delete(safeUserId);
  };
}

async function waitForArtifactUserOperations(userId: string): Promise<void> {
  const state = userLifecycleState(userId);
  if (state.active === 0) return;
  await new Promise<void>((resolve) => state.waiters.push(resolve));
}

/**
 * Account deletion's async exclusive fence. It waits for an already-running
 * stage/attach/publication/cleanup operation, but rejects all later work.
 */
export async function withArtifactUserDeletionFence<T>(userId: string, operation: () => T | Promise<T>): Promise<T> {
  const safeUserId = assertSafeId(userId, "artifact_invalid_user", "User id");
  const releaseDeletion = beginArtifactUserDeletion(safeUserId);
  try {
    await waitForArtifactUserOperations(safeUserId);
    return await operation();
  } finally {
    releaseDeletion();
  }
}

/** Startup recovery runs synchronously before serving requests. */
export function withArtifactUserDeletionFenceSync<T>(userId: string, operation: () => T): T {
  const safeUserId = assertSafeId(userId, "artifact_invalid_user", "User id");
  const releaseDeletion = beginArtifactUserDeletion(safeUserId);
  try {
    const state = userLifecycleState(safeUserId);
    if (state.active !== 0) throw new ArtifactBlobError("artifact_fence_lost", "Artifact operations are still active for this user");
    return operation();
  } finally {
    releaseDeletion();
  }
}

/**
 * A deletion fence is deliberately process-wide and keyed by the authenticated
 * owner plus content digest. Filesystem cleanup is asynchronous, while
 * attachment/publication are synchronous SQLite operations; the synchronous
 * probe below makes those operations fail closed while cleanup owns the key.
 * The journal's deleting marker remains the crash/restart half of this fence.
 */
type ArtifactDeletionFenceState = {
  held: boolean;
  waiters: Array<() => void>;
};
const ARTIFACT_DELETION_FENCE = Symbol("artifact-deletion-fence");

const artifactDeletionFences = new Map<string, ArtifactDeletionFenceState>();

function artifactFenceKey(userId: string, digest: string): string {
  return `${userId}\u0000${digest}`;
}

function releaseArtifactDeletionFence(userId: string, digest: string): void {
  const key = artifactFenceKey(userId, digest);
  const state = artifactDeletionFences.get(key);
  if (!state) return;
  const next = state.waiters.shift();
  if (next) {
    next();
    return;
  }
  state.held = false;
  artifactDeletionFences.delete(key);
  if (pendingArtifactReconciles.has(userId)) scheduleArtifactReconcileRetry(userId);
}

async function acquireArtifactDeletionFence(userId: string, digest: string): Promise<() => void> {
  const releaseUserFence = acquireArtifactUserOperation(userId);
  const key = artifactFenceKey(userId, digest);
  let state = artifactDeletionFences.get(key);
  if (!state) {
    state = { held: false, waiters: [] };
    artifactDeletionFences.set(key, state);
  }
  if (!state.held) {
    state.held = true;
    return () => {
      releaseArtifactDeletionFence(userId, digest);
      releaseUserFence();
    };
  }
  try {
    await new Promise<void>((resolve) => state!.waiters.push(resolve));
    return () => {
      releaseArtifactDeletionFence(userId, digest);
      releaseUserFence();
    };
  } catch (error) {
    releaseUserFence();
    throw error;
  }
}

function assertArtifactDeletionFenceAvailable(userId: string, digest: string): void {
  const userState = artifactUserLifecycleFences.get(userId);
  if (userState?.deleting || artifactDeletionFences.get(artifactFenceKey(userId, digest))?.held) {
    throw new ArtifactBlobError("artifact_fence_lost", "Artifact is being reconciled or deleted");
  }
}
function acquireArtifactDeletionFenceSync(userId: string, digest: string): () => void {
  const releaseUserFence = acquireArtifactUserOperation(userId);
  const key = artifactFenceKey(userId, digest);
  const state = artifactDeletionFences.get(key);
  if (state?.held) {
    releaseUserFence();
    throw new ArtifactBlobError("artifact_fence_lost", "Artifact is being reconciled or deleted");
  }
  artifactDeletionFences.set(key, { held: true, waiters: state?.waiters ?? [] });
  return () => {
    releaseArtifactDeletionFence(userId, digest);
    releaseUserFence();
  };
}
export function withArtifactDeletionFence<T>(userId: string, digest: string, operation: (deletionFence: symbol) => T): T {
  const release = acquireArtifactDeletionFenceSync(userId, digest);
  try {

    return operation(ARTIFACT_DELETION_FENCE);
  } finally {
    release();
  }
}
function isArtifactLifecycleBusy(error: unknown): boolean {
  return error instanceof ArtifactBlobError && error.code === "artifact_fence_lost";
}
function hashFileSync(path: string, expectedBytes: number): string {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > DEFAULT_ARTIFACT_BLOB_LIMITS.maxArtifactBytes) {
    throw new ArtifactBlobError("artifact_size_limit_exceeded", "Artifact file exceeds the configured byte limit");
  }
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new ArtifactBlobError("artifact_file_missing", "Artifact file is unavailable");
  }
  if (bytes.byteLength !== expectedBytes) throw new ArtifactBlobError("artifact_file_mismatch", "Artifact file size does not match its metadata");
  return digestBytes(bytes);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeBytes(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  if (bytes instanceof Uint8Array) return new Uint8Array(bytes);
  return new Uint8Array(bytes.slice(0));
}

function normalizeDigest(value: string | undefined, bytes: Uint8Array): string {
  const computed = digestBytes(bytes);
  if (value !== undefined && (!DIGEST_RE.test(value) || value.toLowerCase() !== computed)) {
    throw new ArtifactBlobError("artifact_digest_mismatch", "Artifact digest does not match its bytes");
  }
  return computed;
}
function assertSafeId(value: string, code: ArtifactBlobErrorCode, label: string): string {
  if (typeof value !== "string" || byteLength(value) > 256 || !SAFE_ID_RE.test(value)) {
    throw new ArtifactBlobError(code, `${label} is invalid`);
  }
  return value;
}
function assertArtifactUserRow(db: Database, userId: string): void {
  try {
    const row = db.query('SELECT 1 AS present FROM "user" WHERE id = ? LIMIT 1').get(userId) as { present?: unknown } | null;
    if (!row) throw new ArtifactBlobError("artifact_invalid_user", "Artifact owner no longer exists");
  } catch (error) {
    if (error instanceof ArtifactBlobError) throw error;
    throw new ArtifactBlobError("artifact_schema_unavailable", "Artifact owner storage is unavailable");
  }
}

function normalizeMime(value: string, maxBytes: number): string {
  const mime = value.trim().toLowerCase();
  if (byteLength(mime) > maxBytes || !MIME_RE.test(mime)) {
    throw new ArtifactBlobError("artifact_invalid_mime", "Artifact MIME type is invalid or too large");
  }
  return mime;
}

function assertRetention(value: ArtifactRetention | undefined): ArtifactRetention {
  const retention = value ?? "turn_terminal";
  if (!RETENTIONS[retention]) throw new ArtifactBlobError("artifact_invalid_provenance", "Artifact retention is invalid");
  return retention;
}

function validateProvenance(
  input: ArtifactBlobProvenanceV1,
  maxBytes: number,
): ArtifactBlobProvenanceV1 {
  if (typeof input !== "string" || !PROVENANCE_KINDS[input as WorkspaceArtifactProvenanceV1]) {
    throw new ArtifactBlobError("artifact_invalid_provenance", "Artifact provenance kind is invalid");
  }
  const encoded = JSON.stringify(input);
  if (byteLength(encoded) > maxBytes) {
    throw new ArtifactBlobError("artifact_provenance_too_large", "Artifact provenance exceeds its byte limit");
  }
  return input;
}

function parseMarker(value: string | null): JournalMarker {
  if (!value) return { before: null, createdByUs: false };
  try {
    const parsed = JSON.parse(value) as Partial<JournalMarker>;
    return {
      before: typeof parsed.before === "string" ? parsed.before : null,
      after: typeof parsed.after === "string" ? parsed.after : null,
      createdByUs: parsed.createdByUs === true,
      deleting: parsed.deleting === true,
    };
  } catch {
    return { before: null, createdByUs: false };
  }
}

function encodeMarker(marker: JournalMarker): string {
  return JSON.stringify(marker);
}

function identityString(identity: FileIdentity): string {
  return `${identity.dev}:${identity.ino}:${identity.size}:${Math.trunc(identity.mtimeMs * 1000)}`;
}

function readIdentity(path: string): FileIdentity | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return { dev: Number(stat.dev), ino: Number(stat.ino), size: Number(stat.size), mtimeMs: Number(stat.mtimeMs) };
  } catch {
    return null;
  }
}
function isSymlinkPath(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isPathInside(root: string, path: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const rel = relative(resolvedRoot, resolvedPath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safePath(root: string, path: string): string {
  const resolved = resolve(path);
  if (!isPathInside(root, resolved)) throw new ArtifactBlobError("artifact_creator_conflict", "Artifact path escaped the blob store");
  return resolved;
}
async function ensureArtifactDirectory(path: string): Promise<void> {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path);
    stat = lstatSync(path);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ArtifactBlobError("artifact_creator_conflict", "Artifact directory must not be a symlink");
  }
}


function tableColumns(db: Database, table: string): Set<string> {
  try {
    const rows = db.query(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

function requireTable(db: Database, table: string): Set<string> {
  const columns = tableColumns(db, table);
  if (columns.size === 0) throw new ArtifactBlobError("artifact_schema_unavailable", `Artifact table ${table} is unavailable`);
  return columns;
}

function pickColumn(columns: Set<string>, candidates: readonly string[], table: string): string {
  const found = candidates.find((candidate) => columns.has(candidate));
  if (!found) throw new ArtifactBlobError("artifact_schema_unavailable", `Artifact table ${table} is missing a required column`);
  return found;
}

function q(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function selectAlias(columns: Set<string>, candidates: readonly string[], alias: string, table: string): string {
  const column = pickColumn(columns, candidates, table);
  return `${q(column)} AS ${q(alias)}`;
}

function isSqlBinding(value: unknown): value is SQLQueryBindings {
  return value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "bigint"
    || typeof value === "boolean"
    || value instanceof Uint8Array;
}

function paramsForInsert(payload: Record<string, unknown>): { readonly columns: string; readonly placeholders: string; readonly values: SQLQueryBindings[] } {
  const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
  const values = entries.map(([, value]) => {
    if (!isSqlBinding(value)) throw new ArtifactBlobError("artifact_commit_invalid", "Artifact metadata contains an unsupported SQLite value");
    return value;
  });
  return {
    columns: entries.map(([key]) => q(key)).join(", "),
    placeholders: entries.map(() => "?").join(", "),
    values,
  };
}

function changes(result: unknown): number {
  if (result && typeof result === "object" && "changes" in result) return Number((result as { changes?: number }).changes ?? 0);
  return 0;
}

function nowSeconds(now: () => number): number {
  return Math.floor(now() / 1000);
}

function throwFence(input: { readonly signal?: AbortSignal; readonly assertFence: () => void }): void {
  if (input.signal?.aborted) throw new ArtifactBlobError("artifact_cancelled", "Artifact operation was cancelled");
  try {
    input.assertFence();
  } catch (error) {
    if (error instanceof ArtifactBlobError) throw error;
    throw new ArtifactBlobError("artifact_fence_lost", "Artifact operation lost its execution fence");
  }
}


export class ArtifactBlobStore {
  readonly rootDir: string;
  readonly limits: ArtifactBlobLimits;
  private readonly dbOverride?: Database;
  private readonly now: () => number;

  constructor(options: ArtifactBlobStoreOptions = {}) {
    this.dbOverride = options.db;
    this.rootDir = resolve(options.rootDir ?? join(env.dataDir, DEFAULT_ROOT_NAME));
    this.limits = Object.freeze({ ...DEFAULT_ARTIFACT_BLOB_LIMITS, ...options.limits });
    this.now = options.now ?? (() => Date.now());
    artifactReconcileRetryStore = this;
  }

  private get db(): Database {
    return this.dbOverride ?? getDb();
  }
  async reconcilePendingUsers(): Promise<void> {
    const users = [...pendingArtifactReconciles.keys()];
    for (const userId of users) {
      const pending = pendingArtifactReconciles.get(userId);
      if (!pending) continue;
      pendingArtifactReconciles.set(userId, { attempts: pending.attempts + 1, lastAttemptAt: Date.now() });
      try {
        await this.reconcile({ userId });
      } catch {
        // Durable journal rows remain pending; retry on the next bounded pass.
      }
      if (pendingArtifactReconciles.has(userId)) scheduleArtifactReconcileRetry(userId);
    }
  }


  private async ensureRoot(userId: string, turnId: string): Promise<{ readonly userRoot: string; readonly stageRoot: string }> {
    const safeUser = assertSafeId(userId, "artifact_invalid_user", "User id");
    const safeTurn = assertSafeId(turnId, "artifact_invalid_turn", "Turn id");
    const userRoot = safePath(this.rootDir, join(this.rootDir, safeUser));
    const stageRoot = safePath(userRoot, join(userRoot, ".staging", safeTurn));
    await ensureArtifactDirectory(this.rootDir);
    await ensureArtifactDirectory(userRoot);
    await ensureArtifactDirectory(join(userRoot, ".staging"));
    await ensureArtifactDirectory(stageRoot);
    return { userRoot, stageRoot };
  }

  private readJournal(digest: string, userId: string, turnId: string): JournalRow | null {
    const db = this.db;
    const columns = requireTable(db, "agent_artifact_blob_journal");
    const digestColumn = pickColumn(columns, ["blob_digest", "digest", "artifact_digest"], "agent_artifact_blob_journal");
    const userColumn = pickColumn(columns, ["user_id", "owner_id"], "agent_artifact_blob_journal");
    const turnColumn = pickColumn(columns, ["turn_id", "execution_id"], "agent_artifact_blob_journal");
    const idColumn = pickColumn(columns, ["id", "journal_id"], "agent_artifact_blob_journal");
    const tokenColumn = pickColumn(columns, ["creator_token", "creator_id"], "agent_artifact_blob_journal");
    const fenceColumn = pickColumn(columns, ["fence", "lease_generation", "fence_generation"], "agent_artifact_blob_journal");
    const stagedColumn = pickColumn(columns, ["staged_path", "stage_path"], "agent_artifact_blob_journal");
    const finalColumn = pickColumn(columns, ["final_path", "storage_path"], "agent_artifact_blob_journal");
    const stateColumn = pickColumn(columns, ["state", "install_state"], "agent_artifact_blob_journal");
    const observedColumn = pickColumn(columns, ["observed_identity", "final_identity", "identity"], "agent_artifact_blob_journal");
    const bytesColumn = pickColumn(columns, ["byte_count", "bytes"], "agent_artifact_blob_journal");
    const row = db.query(
      `SELECT ${selectAlias(columns, [idColumn], "id", "agent_artifact_blob_journal")},
              ${selectAlias(columns, [digestColumn], "digest", "agent_artifact_blob_journal")},
              ${selectAlias(columns, [userColumn], "user_id", "agent_artifact_blob_journal")},
              ${selectAlias(columns, [turnColumn], "turn_id", "agent_artifact_blob_journal")},
              ${selectAlias(columns, [tokenColumn], "creator_token", "agent_artifact_blob_journal")},
              ${selectAlias(columns, [fenceColumn], "fence", "agent_artifact_blob_journal")},
              ${selectAlias(columns, [stagedColumn], "staged_path", "agent_artifact_blob_journal")},
              ${selectAlias(columns, [finalColumn], "final_path", "agent_artifact_blob_journal")},
              ${selectAlias(columns, [stateColumn], "state", "agent_artifact_blob_journal")},
              ${selectAlias(columns, [observedColumn], "observed_identity", "agent_artifact_blob_journal")},
              ${selectAlias(columns, [bytesColumn], "byte_count", "agent_artifact_blob_journal")}
         FROM agent_artifact_blob_journal
        WHERE ${q(digestColumn)} = ? AND ${q(userColumn)} = ? AND ${q(turnColumn)} = ?
        LIMIT 1`,
    ).get(digest, userId, turnId) as SqlRow | null;
    if (!row) return null;
    return {
      id: String(row.id),
      digest: String(row.digest),
      userId: String(row.user_id),
      turnId: String(row.turn_id),
      creatorToken: String(row.creator_token),
      fence: String(row.fence),
      stagedPath: String(row.staged_path),
      finalPath: String(row.final_path),
      state: String(row.state) as JournalRow["state"],
      observedIdentity: row.observed_identity == null ? null : String(row.observed_identity),
      byteCount: Number(row.byte_count),
    };
  }

  private insertJournal(input: {
    readonly id: string;
    readonly digest: string;
    readonly userId: string;
    readonly turnId: string;
    readonly creatorToken: string;
    readonly fence: string;
    readonly stagedPath: string;
    readonly finalPath: string;
    readonly byteCount: number;
    readonly marker: JournalMarker;
  }): void {
    const db = this.db;
    const columns = requireTable(db, "agent_artifact_blob_journal");
    const digestColumn = pickColumn(columns, ["blob_digest", "digest", "artifact_digest"], "agent_artifact_blob_journal");
    const userColumn = pickColumn(columns, ["user_id", "owner_id"], "agent_artifact_blob_journal");
    const turnColumn = pickColumn(columns, ["turn_id", "execution_id"], "agent_artifact_blob_journal");
    const idColumn = pickColumn(columns, ["id", "journal_id"], "agent_artifact_blob_journal");
    const tokenColumn = pickColumn(columns, ["creator_token", "creator_id"], "agent_artifact_blob_journal");
    const fenceColumn = pickColumn(columns, ["fence", "lease_generation", "fence_generation"], "agent_artifact_blob_journal");
    const stagedColumn = pickColumn(columns, ["staged_path", "stage_path"], "agent_artifact_blob_journal");
    const finalColumn = pickColumn(columns, ["final_path", "storage_path"], "agent_artifact_blob_journal");
    const stateColumn = pickColumn(columns, ["state", "install_state"], "agent_artifact_blob_journal");
    const observedColumn = pickColumn(columns, ["observed_identity", "final_identity", "identity"], "agent_artifact_blob_journal");
    const bytesColumn = pickColumn(columns, ["byte_count", "bytes"], "agent_artifact_blob_journal");
    const createdColumn = columns.has("created_at") ? "created_at" : undefined;
    const updatedColumn = columns.has("updated_at") ? "updated_at" : undefined;
    const payload: Record<string, unknown> = {
      [idColumn]: input.id,
      [digestColumn]: input.digest,
      ...(columns.has("digest") && digestColumn !== "digest" ? { digest: input.digest } : {}),
      [userColumn]: input.userId,
      [turnColumn]: input.turnId,
      [tokenColumn]: input.creatorToken,
      [fenceColumn]: input.fence,
      [stagedColumn]: input.stagedPath,
      [finalColumn]: input.finalPath,
      [stateColumn]: "pending",
      [observedColumn]: encodeMarker(input.marker),
      [bytesColumn]: input.byteCount,
      ...(createdColumn ? { [createdColumn]: nowSeconds(this.now) } : {}),
      ...(updatedColumn ? { [updatedColumn]: nowSeconds(this.now) } : {}),
    };
    const params = paramsForInsert(payload);
    try {
      db.query(`INSERT INTO agent_artifact_blob_journal (${params.columns}) VALUES (${params.placeholders})`).run(...params.values);
    } catch (error) {
      throw new ArtifactBlobError("artifact_commit_conflict", error instanceof Error ? error.message : "Artifact journal insert failed");
    }
  }

  private updateJournal(journal: JournalRow, state: JournalRow["state"], marker: JournalMarker): void {
    const db = this.db;
    const columns = requireTable(db, "agent_artifact_blob_journal");
    const idColumn = pickColumn(columns, ["id", "journal_id"], "agent_artifact_blob_journal");
    const stateColumn = pickColumn(columns, ["state", "install_state"], "agent_artifact_blob_journal");
    const observedColumn = pickColumn(columns, ["observed_identity", "final_identity", "identity"], "agent_artifact_blob_journal");
    const updatedColumn = columns.has("updated_at") ? "updated_at" : undefined;
    const updates = [`${q(stateColumn)} = ?`, `${q(observedColumn)} = ?`];
    const values: SQLQueryBindings[] = [state, encodeMarker(marker)];
    if (updatedColumn) {
      updates.push(`${q(updatedColumn)} = ?`);
      values.push(nowSeconds(this.now));
    }
    values.push(journal.id);
    db.query(`UPDATE agent_artifact_blob_journal SET ${updates.join(", ")} WHERE ${q(idColumn)} = ?`).run(...values);
  }

  private async removePath(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
  private isOwnedPath(userId: string, path: string): boolean {
    if (!SAFE_ID_RE.test(userId)) return false;
    const userRoot = resolve(this.rootDir, userId);
    const resolvedPath = resolve(path);
    const relativePath = relative(userRoot, resolvedPath);
    if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return false;
    const directories = [this.rootDir, userRoot];
    for (const segment of relativePath.split(sep)) directories.push(join(directories[directories.length - 1]!, segment));
    for (let index = 0; index < directories.length; index++) {
      let stat: Stats;
      try {
        stat = lstatSync(directories[index]!);
      } catch (error) {
        // A missing leaf inside the owner's validated directory chain is an
        // already-completed removal (e.g. the staged file unlinked right after
        // linking, or a crash before the final link); missing ancestors mean
        // the path never existed under this owner.
        if (index === directories.length - 1 && (error as NodeJS.ErrnoException)?.code === "ENOENT") break;
        return false;
      }
      if (stat.isSymbolicLink()) return false;
      if (index < directories.length - 1 && !stat.isDirectory()) return false;
    }
    return true;
  }
  private async removeOwnedPath(userId: string, path: string): Promise<boolean> {
    if (!this.isOwnedPath(userId, path)) return false;
    await this.removePath(path);
    return true;
  }

  private async hashFile(path: string, expectedBytes: number): Promise<string> {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > this.limits.maxArtifactBytes) {
      throw new ArtifactBlobError("artifact_size_limit_exceeded", "Artifact file exceeds the configured byte limit");
    }
    const file = Bun.file(path);
    if (!(await file.exists()) || file.size !== expectedBytes) throw new ArtifactBlobError("artifact_file_mismatch", "Artifact file size does not match its journal");
    return digestBytes(new Uint8Array(await file.arrayBuffer()));
  }

  private blobRow(digest: string, userId: string): SqlRow | null {
    const db = this.db;
    const columns = requireTable(db, "agent_artifact_blobs");
    const digestColumn = pickColumn(columns, ["digest", "blob_digest"], "agent_artifact_blobs");
    const userColumn = pickColumn(columns, ["user_id", "owner_id"], "agent_artifact_blobs");
    return db.query(`SELECT * FROM agent_artifact_blobs WHERE ${q(digestColumn)} = ? AND ${q(userColumn)} = ? LIMIT 1`).get(digest, userId) as SqlRow | null;
  }

  private insertBlob(input: {
    readonly digest: string;
    readonly userId: string;
    readonly byteCount: number;
    readonly mimeType: string;
    readonly storagePath: string;
    readonly provenance: ArtifactBlobProvenanceV1;
    readonly retention: ArtifactRetention;
    readonly expiresAt: number | null;
    readonly mergeExisting?: boolean;
  }): boolean {
    const db = this.db;
    const columns = requireTable(db, "agent_artifact_blobs");
    const digestColumn = pickColumn(columns, ["digest", "blob_digest"], "agent_artifact_blobs");
    const userColumn = pickColumn(columns, ["user_id", "owner_id"], "agent_artifact_blobs");
    const bytesColumn = pickColumn(columns, ["byte_count", "bytes"], "agent_artifact_blobs");
    const mimeColumn = pickColumn(columns, ["mime_type", "mime"], "agent_artifact_blobs");
    const pathColumn = pickColumn(columns, ["storage_path", "final_path", "path"], "agent_artifact_blobs");
    const provenanceColumn = pickColumn(columns, ["provenance_json", "provenance"], "agent_artifact_blobs");
    const refColumn = pickColumn(columns, ["published_reference_count", "ref_count", "reference_count"], "agent_artifact_blobs");
    const retentionColumn = columns.has("retention") ? "retention" : undefined;
    const revisionColumn = columns.has("revision") ? "revision" : undefined;
    const createdColumn = columns.has("created_at") ? "created_at" : undefined;
    const updatedColumn = columns.has("updated_at") ? "updated_at" : undefined;
    const expiresColumn = columns.has("expires_at") ? "expires_at" : undefined;
    const payload: Record<string, unknown> = {
      [digestColumn]: input.digest,
      [userColumn]: input.userId,
      [bytesColumn]: input.byteCount,
      [mimeColumn]: input.mimeType,
      [pathColumn]: input.storagePath,
      [provenanceColumn]: JSON.stringify(input.provenance),
      [refColumn]: 0,
      ...(retentionColumn ? { [retentionColumn]: input.retention } : {}),
      ...(revisionColumn ? { [revisionColumn]: 1 } : {}),
      ...(createdColumn ? { [createdColumn]: nowSeconds(this.now) } : {}),
      ...(updatedColumn ? { [updatedColumn]: nowSeconds(this.now) } : {}),
      ...(expiresColumn ? { [expiresColumn]: input.expiresAt } : {}),
    };
    const params = paramsForInsert(payload);
    try {
      db.query(`INSERT INTO agent_artifact_blobs (${params.columns}) VALUES (${params.placeholders})`).run(...params.values);
      return true;
    } catch (error) {
      if (!/unique constraint failed/i.test(String(error))) throw error;
      const existing = this.blobRow(input.digest, input.userId);
      if (!existing) throw error;
      if (String(existing[userColumn]) !== input.userId || Number(existing[bytesColumn]) !== input.byteCount || String(existing[mimeColumn]) !== input.mimeType || String(existing[pathColumn]) !== input.storagePath) {
        throw new ArtifactBlobError("artifact_digest_conflict", "Digest already belongs to different artifact metadata");
      }
      const retentionRank: Record<ArtifactRetention, number> = { operational: 0, turn_terminal: 1, chat_lifetime: 2 };
      const existingRetention = String(existing[retentionColumn ?? "retention"] ?? "operational") as ArtifactRetention;
      const effectiveRetention = retentionRank[existingRetention] >= retentionRank[input.retention] ? existingRetention : input.retention;
      const updates: string[] = [];
      const values: SQLQueryBindings[] = [];
      if (retentionColumn) {
        updates.push(`${q(retentionColumn)} = ?`);
        values.push(effectiveRetention);
      }
      if (expiresColumn) {
        const existingExpiresAt = existing[expiresColumn];
        const mergedExpiresAt = existingExpiresAt == null || input.expiresAt == null ? null : Math.max(Number(existingExpiresAt), input.expiresAt);
        updates.push(`${q(expiresColumn)} = ?`);
        values.push(mergedExpiresAt);
      }
      if (updatedColumn) {
        updates.push(`${q(updatedColumn)} = ?`);
        values.push(nowSeconds(this.now));
      }
      if (updates.length > 0 && input.mergeExisting !== false) {
        values.push(input.digest, input.userId);
        db.query(`UPDATE agent_artifact_blobs SET ${updates.join(", ")} WHERE ${q(digestColumn)} = ? AND ${q(userColumn)} = ?`).run(...values);
      }
      return false;
    }
  }

  private enforceQuota(userId: string, turnId: string, digest: string, byteCount: number, deduped: boolean): void {
    const journalColumns = requireTable(this.db, "agent_artifact_blob_journal");
    const journalDigest = pickColumn(journalColumns, ["blob_digest", "digest", "artifact_digest"], "agent_artifact_blob_journal");
    const journalUser = pickColumn(journalColumns, ["user_id", "owner_id"], "agent_artifact_blob_journal");
    const journalTurn = pickColumn(journalColumns, ["turn_id", "execution_id"], "agent_artifact_blob_journal");
    const journalState = pickColumn(journalColumns, ["state", "install_state"], "agent_artifact_blob_journal");
    const journalBytes = pickColumn(journalColumns, ["byte_count", "bytes"], "agent_artifact_blob_journal");
    const sameDigest = this.db.query(`SELECT COALESCE(SUM(${q(journalBytes)}), 0) AS bytes FROM agent_artifact_blob_journal WHERE ${q(journalDigest)} = ? AND ${q(journalUser)} = ? AND ${q(journalTurn)} = ? AND ${q(journalState)} != 'removed'`).get(digest, userId, turnId) as { bytes?: number };
    if (Number(sameDigest.bytes ?? 0) > 0) return;
    if (!deduped) {
      const blobColumns = requireTable(this.db, "agent_artifact_blobs");
      const userColumn = pickColumn(blobColumns, ["user_id", "owner_id"], "agent_artifact_blobs");
      const bytesColumn = pickColumn(blobColumns, ["byte_count", "bytes"], "agent_artifact_blobs");
      const userStats = this.db.query(`SELECT COALESCE(SUM(${q(bytesColumn)}), 0) AS bytes, COUNT(*) AS count FROM agent_artifact_blobs WHERE ${q(userColumn)} = ?`).get(userId) as { bytes?: number; count?: number };
      if (Number(userStats.bytes ?? 0) + byteCount > this.limits.maxUserBytes || Number(userStats.count ?? 0) >= this.limits.maxUserBlobs) {
        throw new ArtifactBlobError("artifact_user_quota_exceeded", "Artifact user quota exceeded");
      }
    }
    const turnStats = this.db.query(`SELECT COALESCE(SUM(${q(journalBytes)}), 0) AS bytes FROM agent_artifact_blob_journal WHERE ${q(journalUser)} = ? AND ${q(journalTurn)} = ? AND ${q(journalState)} != 'removed'`).get(userId, turnId) as { bytes?: number };
    if (Number(turnStats.bytes ?? 0) + byteCount > this.limits.maxTurnBytes) {
      throw new ArtifactBlobError("artifact_turn_quota_exceeded", "Artifact turn quota exceeded");
    }
  }

  async stageArtifact(input: ArtifactBlobWriteInput): Promise<ArtifactBlobHandle> {
    return withUserDataMutation(input.userId, () => this.stageArtifactWithinBarrier(input));
  }

  private async stageArtifactWithinBarrier(input: ArtifactBlobWriteInput): Promise<ArtifactBlobHandle> {
    if (this.db.inTransaction) throw new ArtifactBlobError("artifact_commit_invalid", "Artifact staging cannot run inside a caller-owned transaction");
    const userId = assertSafeId(input.userId, "artifact_invalid_user", "User id");
    const turnId = assertSafeId(input.turnId, "artifact_invalid_turn", "Turn id");
    const bytes = normalizeBytes(input.bytes);
    if (bytes.byteLength > this.limits.maxArtifactBytes) throw new ArtifactBlobError("artifact_size_limit_exceeded", "Artifact exceeds the per-artifact byte limit");
    const digest = normalizeDigest(input.digest, bytes);
    const releaseDeletionFence = await acquireArtifactDeletionFence(userId, digest);
    try {
    assertArtifactUserRow(this.db, userId);
    const mimeType = normalizeMime(input.mimeType, this.limits.maxMimeBytes);
    const retention = assertRetention(input.retention);
    const requestedExpiresAt = input.expiresAt;
    const expiresAt = requestedExpiresAt === undefined || requestedExpiresAt === null
      ? nowSeconds(this.now) + (retention === "chat_lifetime" ? 30 * 24 * 60 * 60 : 24 * 60 * 60)
      : requestedExpiresAt;
    if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) throw new ArtifactBlobError("artifact_invalid_provenance", "Artifact expiry is invalid");
    const provenance = validateProvenance(input.provenance, this.limits.maxProvenanceBytes);
    const creatorToken = input.creatorToken ?? crypto.randomUUID();
    assertSafeId(creatorToken, "artifact_creator_conflict", "Artifact creator token");
    const fenceGeneration = String(input.fence);
    const numericFenceGeneration = Number(fenceGeneration);
    if (!Number.isSafeInteger(numericFenceGeneration) || numericFenceGeneration < 0) throw new ArtifactBlobError("artifact_fence_lost", "Artifact fence is invalid");
    const existingBlob = this.blobRow(digest, userId);
    const existingJournal = this.readJournal(digest, userId, turnId);
    if (this.journalsForDigest(userId, digest).some((journal) => parseMarker(journal.observedIdentity).deleting)) {
      throw new ArtifactBlobError("artifact_fence_lost", "Artifact installation is being reconciled");
    }
    throwFence(input);
    const { userRoot, stageRoot } = await this.ensureRoot(userId, turnId);
    const finalPath = safePath(userRoot, join(userRoot, `${digest}.blob`));
    if (isSymlinkPath(finalPath)) throw new ArtifactBlobError("artifact_digest_conflict", "Artifact destination must be a regular file");
    const stagedPath = safePath(stageRoot, join(stageRoot, `${digest}.${creatorToken}.part`));
    const before = readIdentity(finalPath);
    const beforeMarker = before ? identityString(before) : null;
    let createdBlob = false;
    let journal = existingJournal;
    let journalCreated = false;
    const insertRows = (): void => {
      this.enforceQuota(userId, turnId, digest, bytes.byteLength, Boolean(existingBlob));
      createdBlob = this.insertBlob({ digest, userId, byteCount: bytes.byteLength, mimeType, storagePath: finalPath, provenance, retention, expiresAt, mergeExisting: false });
      if (journal && journal.creatorToken !== creatorToken && (input.creatorToken !== undefined || journal.state !== "installed" || before === null)) {
        throw new ArtifactBlobError("artifact_creator_conflict", "Artifact retry is owned by another creator");
      }
      if (!journal) {
        const id = crypto.randomUUID();
        this.insertJournal({ id, digest, userId, turnId, creatorToken, fence: fenceGeneration, stagedPath, finalPath, byteCount: bytes.byteLength, marker: { before: beforeMarker, createdByUs: false } });
        journal = { id, digest, userId, turnId, creatorToken, fence: fenceGeneration, stagedPath, finalPath, state: "pending", observedIdentity: encodeMarker({ before: beforeMarker, createdByUs: false }), byteCount: bytes.byteLength };
        journalCreated = true;
      } else if (journal.byteCount !== bytes.byteLength || (journal.state !== "installed" && (journal.creatorToken !== creatorToken || journal.fence !== fenceGeneration))) {
        throw new ArtifactBlobError("artifact_creator_conflict", "Artifact retry metadata does not match the journal");
      }
    };
    const inCallerTransaction = this.db.inTransaction;
    try {
      if (inCallerTransaction) insertRows();
      else this.db.transaction(insertRows)();
    } catch (error) {
      if (!inCallerTransaction) {
        if (journalCreated && journal) this.deleteJournal(journal);
        if (createdBlob) this.deleteUnreferencedBlob(digest, userId);
      }
      throw error;
    }
    if (journal === null) throw new ArtifactBlobError("artifact_schema_unavailable", "Artifact journal was not created");
    let activeJournal: JournalRow = journal;

    if (activeJournal.state === "installed" && readIdentity(finalPath)) {
      const actualDigest = await this.hashFile(finalPath, bytes.byteLength);
      if (actualDigest !== digest) throw new ArtifactBlobError("artifact_digest_conflict", "Installed artifact bytes do not match the digest");
      throwFence(input);
      this.insertBlob({ digest, userId, byteCount: bytes.byteLength, mimeType, storagePath: finalPath, provenance, retention, expiresAt });
      return { digest, userId, turnId, workspaceId: input.workspaceId, byteCount: bytes.byteLength, mimeType, storagePath: finalPath, journalId: activeJournal.id, creatorToken: activeJournal.creatorToken, createdByThisOperation: false, retention, expiresAt };
    }

    if (before) {
      const actualDigest = await this.hashFile(finalPath, bytes.byteLength);
      if (actualDigest !== digest) {
        if (!existingBlob) {
          const marker = parseMarker(activeJournal.observedIdentity);
          this.updateJournal(activeJournal, "removed", { ...marker, after: beforeMarker });
          this.deleteJournal(activeJournal);
          this.deleteUnreferencedBlob(digest, userId);
        }
        await this.removePath(stagedPath);
        throw new ArtifactBlobError("artifact_digest_conflict", "A destination file has the same content-addressed path but different bytes");
      }
      throwFence(input);
      const destinationIdentity = identityString(before);
      const previousMarker = parseMarker(activeJournal.observedIdentity);
      const creatorOwned = previousMarker.before === null && previousMarker.createdByUs && previousMarker.after === destinationIdentity;
      const marker: JournalMarker = { before: creatorOwned ? null : beforeMarker, after: destinationIdentity, createdByUs: creatorOwned };
      this.updateJournal(activeJournal, "installed", marker);
      activeJournal = { ...activeJournal, state: "installed", observedIdentity: encodeMarker(marker) };
      this.insertBlob({ digest, userId, byteCount: bytes.byteLength, mimeType, storagePath: finalPath, provenance, retention, expiresAt });
      return { digest, userId, turnId, workspaceId: input.workspaceId, byteCount: bytes.byteLength, mimeType, storagePath: finalPath, journalId: activeJournal.id, creatorToken: activeJournal.creatorToken, createdByThisOperation: creatorOwned, retention, expiresAt };
    }

    await mkdir(dirname(stagedPath), { recursive: true });
    let handle: FileHandle;
    try {
      handle = await open(stagedPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST" || !existingJournal || existingJournal.creatorToken !== creatorToken) {
        throw new ArtifactBlobError("artifact_creator_conflict", "Staged artifact path is already occupied");
      }
      const existingIdentity = readIdentity(stagedPath);
      const existingMarker = parseMarker(existingJournal.observedIdentity);
      if (!existingIdentity || existingMarker.after !== identityString(existingIdentity)) {
        throw new ArtifactBlobError("artifact_creator_conflict", "Staged artifact identity is not owned by this creator");
      }
      await this.removePath(stagedPath);
      try {
        handle = await open(stagedPath, "wx");
      } catch {
        throw new ArtifactBlobError("artifact_creator_conflict", "Staged artifact path changed during retry");
      }
    }
    try {
      await handle.write(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const writtenDigest = await this.hashFile(stagedPath, bytes.byteLength);
    if (writtenDigest !== digest) {
      await this.removePath(stagedPath);
      throw new ArtifactBlobError("artifact_digest_mismatch", "Staged artifact bytes do not match the digest");
    }
    throwFence(input);
    const stagedIdentity = readIdentity(stagedPath);
    if (!stagedIdentity) throw new ArtifactBlobError("artifact_file_missing", "Staged artifact disappeared before installation");
    const pendingMarker: JournalMarker = { before: beforeMarker, after: identityString(stagedIdentity), createdByUs: beforeMarker === null };
    this.updateJournal(activeJournal, "pending", pendingMarker);
    activeJournal = { ...activeJournal, observedIdentity: encodeMarker(pendingMarker) };
    let createdByThisOperation = false;
    try {
      await link(stagedPath, finalPath);
      createdByThisOperation = true;
      await this.removePath(stagedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const actualDigest = await this.hashFile(finalPath, bytes.byteLength);
      await this.removePath(stagedPath);
      if (actualDigest !== digest) throw new ArtifactBlobError("artifact_digest_conflict", "Destination appeared with different bytes");
    }
    const after = readIdentity(finalPath);
    if (!after) throw new ArtifactBlobError("artifact_file_missing", "Artifact destination disappeared after installation");
    throwFence(input);
    const marker: JournalMarker = { before: beforeMarker, after: identityString(after), createdByUs: createdByThisOperation };
    this.updateJournal(activeJournal, "installed", marker);
    return { digest, userId, turnId, workspaceId: input.workspaceId, byteCount: bytes.byteLength, mimeType, storagePath: finalPath, journalId: activeJournal.id, creatorToken: activeJournal.creatorToken, createdByThisOperation, retention, expiresAt };
    } finally {
      releaseDeletionFence();
    }
  }

  async reconcile(options: { readonly assertFence?: () => void; readonly maxRows?: number; readonly userId?: string } = {}): Promise<ArtifactReconcileResult> {
    const db = this.db;
    if (!options.userId && pendingArtifactReconcileGlobalDb !== db) {
      pendingArtifactReconcileGlobalDb = db;
      pendingArtifactReconcileGlobal = false;
      pendingArtifactReconcileGlobalCursor = undefined;
    }
    const columns = requireTable(db, "agent_artifact_blob_journal");
    const digestColumn = pickColumn(columns, ["blob_digest", "digest", "artifact_digest"], "agent_artifact_blob_journal");
    const userColumn = pickColumn(columns, ["user_id", "owner_id"], "agent_artifact_blob_journal");
    const turnColumn = pickColumn(columns, ["turn_id", "execution_id"], "agent_artifact_blob_journal");
    const idColumn = pickColumn(columns, ["id", "journal_id"], "agent_artifact_blob_journal");
    const tokenColumn = pickColumn(columns, ["creator_token", "creator_id"], "agent_artifact_blob_journal");
    const fenceColumn = pickColumn(columns, ["fence", "lease_generation", "fence_generation"], "agent_artifact_blob_journal");
    const stagedColumn = pickColumn(columns, ["staged_path", "stage_path"], "agent_artifact_blob_journal");
    const finalColumn = pickColumn(columns, ["final_path", "storage_path"], "agent_artifact_blob_journal");
    const stateColumn = pickColumn(columns, ["state", "install_state"], "agent_artifact_blob_journal");
    const observedColumn = pickColumn(columns, ["observed_identity", "final_identity", "identity"], "agent_artifact_blob_journal");
    const bytesColumn = pickColumn(columns, ["byte_count", "bytes"], "agent_artifact_blob_journal");
    const configuredMaxRows = options.maxRows ?? this.limits.maxCleanupRows;
    const maxRows = Number.isFinite(configuredMaxRows) ? Math.max(0, Math.floor(configuredMaxRows)) : this.limits.maxCleanupRows;
    const scanPredicates: string[] = [];
    const scanParams: SQLQueryBindings[] = [];
    if (options.userId) {
      scanPredicates.push(`${q(userColumn)} = ?`);
      scanParams.push(options.userId);
    } else if (pendingArtifactReconcileGlobalCursor !== undefined) {
      scanPredicates.push(`${q(idColumn)} > ?`);
      scanParams.push(pendingArtifactReconcileGlobalCursor);
    }
    const scanWhere = scanPredicates.length > 0 ? ` WHERE ${scanPredicates.join(" AND ")}` : "";
    const rows = db.query(
      `SELECT ${selectAlias(columns, [idColumn], "id", "agent_artifact_blob_journal")}, ${selectAlias(columns, [digestColumn], "digest", "agent_artifact_blob_journal")}, ${selectAlias(columns, [userColumn], "user_id", "agent_artifact_blob_journal")}, ${selectAlias(columns, [turnColumn], "turn_id", "agent_artifact_blob_journal")}, ${selectAlias(columns, [tokenColumn], "creator_token", "agent_artifact_blob_journal")}, ${selectAlias(columns, [fenceColumn], "fence", "agent_artifact_blob_journal")}, ${selectAlias(columns, [stagedColumn], "staged_path", "agent_artifact_blob_journal")}, ${selectAlias(columns, [finalColumn], "final_path", "agent_artifact_blob_journal")}, ${selectAlias(columns, [stateColumn], "state", "agent_artifact_blob_journal")}, ${selectAlias(columns, [observedColumn], "observed_identity", "agent_artifact_blob_journal")}, ${selectAlias(columns, [bytesColumn], "byte_count", "agent_artifact_blob_journal")} FROM agent_artifact_blob_journal${scanWhere} ORDER BY ${q(idColumn)} LIMIT ?`,
    ).all(...scanParams, maxRows + 1) as SqlRow[];
    const rowsToInspect = Math.min(rows.length, maxRows);
    const hasRowsBeyondCap = rows.length > rowsToInspect;
    const continuationPredicates: string[] = [];
    const continuationParams: SQLQueryBindings[] = [];
    if (hasRowsBeyondCap && rowsToInspect > 0) {
      continuationPredicates.push(`${q(idColumn)} > ?`);
      continuationParams.push(String(rows[rowsToInspect - 1]?.id));
    }
    if (options.userId) {
      continuationPredicates.push(`${q(userColumn)} = ?`);
      continuationParams.push(options.userId);
    }
    const continuationWhere = continuationPredicates.length > 0 ? ` WHERE ${continuationPredicates.join(" AND ")}` : "";
    const hasContinuation = hasRowsBeyondCap && db.query(
      `SELECT 1 AS present FROM agent_artifact_blob_journal${continuationWhere} LIMIT 1`,
    ).get(...continuationParams) !== null;
    let removed = 0;
    let retained = 0;
    let stale = 0;
    let quarantined = 0;
    let bytesRemoved = 0;
    const busyUsers = new Set<string>();
    let globalScanDeferred = false;
    let inspected = 0;
    const deferGlobalScan = (): boolean => {
      if (options.userId) return false;
      globalScanDeferred = true;
      return true;
    };
    for (let rowIndex = 0; rowIndex < rowsToInspect; rowIndex++) {
      const raw = rows[rowIndex]!;
      inspected++;
      try {
        options.assertFence?.();
      } catch {
        stale++;
        if (deferGlobalScan()) break;
        continue;
      }
      const row: JournalRow = {
        id: String(raw.id), digest: String(raw.digest), userId: String(raw.user_id), turnId: String(raw.turn_id), creatorToken: String(raw.creator_token), fence: String(raw.fence), stagedPath: String(raw.staged_path), finalPath: String(raw.final_path), state: String(raw.state) as JournalRow["state"], observedIdentity: raw.observed_identity == null ? null : String(raw.observed_identity), byteCount: Number(raw.byte_count),
      };
      if (row.state === "removed") {
        let releaseRemovedFence: (() => void) | undefined;
        try {
          releaseRemovedFence = await acquireArtifactDeletionFence(row.userId, row.digest);
        } catch (error) {
          if (isArtifactLifecycleBusy(error)) {
            busyUsers.add(row.userId);
            markArtifactReconcilePending(row.userId);
            if (deferGlobalScan()) break;
            continue;
          }
          throw error;
        }
        try {
          if (this.publishedReferenceCount(row.userId, row.digest) === 0 && this.workspaceReferenceCount(row.userId, row.digest) === 0) {
            this.deleteUnreferencedBlob(row.digest, row.userId);
          }
        } finally {
          releaseRemovedFence?.();
        }
        continue;
      }
      let releaseDeletionFence: (() => void) | undefined;
      try {
        releaseDeletionFence = await acquireArtifactDeletionFence(row.userId, row.digest);
      } catch (error) {
        if (isArtifactLifecycleBusy(error)) {
          busyUsers.add(row.userId);
          markArtifactReconcilePending(row.userId);
          if (deferGlobalScan()) break;
          continue;
        }
        throw error;
      }
      const currentFence = (): boolean => {
        try {
          options.assertFence?.();
          return true;
        } catch {
          stale++;
          return false;
        }
      };
      try {
      const safeFinal = this.isOwnedPath(row.userId, row.finalPath);
      if (!safeFinal) {
        retained++;
        quarantined++;
        continue;
      }
      const marker = parseMarker(row.observedIdentity);
      const published = this.publishedReferenceCount(row.userId, row.digest);
      const workspaceReferences = this.workspaceReferenceCount(row.userId, row.digest);
      if (published > 0 || workspaceReferences > 0) {
        const protectedFinal = readIdentity(row.finalPath);
        let finalMatches = false;
        if (protectedFinal && protectedFinal.size === row.byteCount) {
          try { finalMatches = await this.hashFile(row.finalPath, row.byteCount) === row.digest; } catch { finalMatches = false; }
        }
        if (!protectedFinal || !finalMatches) {
          retained++;
          quarantined++;
          continue;
        }
        retained++;
        if (row.state !== "installed" || marker.deleting) {
          if (!currentFence()) {
            retained++;
            if (deferGlobalScan()) break;
            continue;
          }
          this.updateJournal(row, "installed", { ...marker, after: identityString(protectedFinal), deleting: false });
        }
        if (!(await this.removeOwnedPath(row.userId, row.stagedPath))) quarantined++;
        continue;
      }
      let journalClaimed = false;
      const final = readIdentity(row.finalPath);

      const activeJournals = this.journalsForDigest(row.userId, row.digest).filter((journal) => journal.state !== "removed");
      const hasOtherActiveJournal = activeJournals.some((journal) => journal.id !== row.id);
      const canRemoveFinal = !hasOtherActiveJournal && marker.before === null && marker.createdByUs && final && final.size === row.byteCount;
      let digestMatches = false;
      if (canRemoveFinal) {
        try { digestMatches = await this.hashFile(row.finalPath, row.byteCount) === row.digest; } catch { digestMatches = false; }
      }
      if (canRemoveFinal && digestMatches && marker.after === identityString(final!)) {
        if (!currentFence()) {
          retained++;
          if (deferGlobalScan()) break;
          continue;
        }
        const deletionAlreadyClaimed = marker.deleting && marker.createdByUs && marker.before === null && marker.after === identityString(final!);
        if (!deletionAlreadyClaimed && !this.claimJournalForRemoval(row)) {
          retained++;
          if (deferGlobalScan()) break;
          if (!(await this.removeOwnedPath(row.userId, row.stagedPath))) quarantined++;
          continue;
        }
        journalClaimed = true;
        const claimedFinal = readIdentity(row.finalPath);
        if (!claimedFinal || identityString(claimedFinal) !== identityString(final!)) {
          retained++;
          quarantined++;
          if (deferGlobalScan()) break;
          continue;
        }
        if (!currentFence()) {
          retained++;
          if (deferGlobalScan()) break;
          continue;
        }
        if (!(await this.removeOwnedPath(row.userId, row.finalPath))) {
          retained++;
          quarantined++;
          if (deferGlobalScan()) break;
          continue;
        }
        if (!currentFence()) {
          retained++;
          if (deferGlobalScan()) break;
          continue;
        }
        removed++;
        bytesRemoved += row.byteCount;
      } else if (final) {
        // A present destination that is not the journaled creator-owned inode
        // is shared or externally replaced; never delete its DB/file pair.
        retained++;
        quarantined++;
        if (!(await this.removeOwnedPath(row.userId, row.stagedPath))) quarantined++;
        continue;
      }
      if (!journalClaimed) {
        const deletionAlreadyClaimed = marker.deleting && marker.createdByUs && marker.before === null && marker.after !== null;
        if (!deletionAlreadyClaimed && !currentFence()) {
          retained++;
          quarantined++;
          if (deferGlobalScan()) break;
          continue;
        }
        if (!deletionAlreadyClaimed && !this.claimJournalForRemoval(row)) {
          retained++;
          quarantined++;
          if (deferGlobalScan()) break;
          continue;
        }
        journalClaimed = true;
      }
      if (!currentFence()) {
        retained++;
        if (deferGlobalScan()) break;
        continue;
      }
      if (!(await this.removeOwnedPath(row.userId, row.stagedPath))) {
        retained++;
        quarantined++;
        if (deferGlobalScan()) break;
        continue;
      }
      if (!currentFence()) {
        retained++;
        if (deferGlobalScan()) break;
        continue;
      }
      this.updateJournal(row, "removed", { ...marker, deleting: false, after: final ? identityString(final) : marker.after });
      this.deleteUnreferencedBlob(row.digest, row.userId);
      } finally {
        releaseDeletionFence?.();
      }
    }
    if (options.userId && !busyUsers.has(options.userId)) {
      const remaining = db.query(`SELECT COUNT(*) AS count FROM agent_artifact_blob_journal WHERE ${q(userColumn)} = ?`).get(options.userId) as { count?: number } | null;
      if (Number(remaining?.count ?? 0) <= rowsToInspect) pendingArtifactReconciles.delete(options.userId);
    }
    if (!options.userId) {
      if (globalScanDeferred) {
        pendingArtifactReconcileGlobal = true;
      } else if (hasContinuation && rowsToInspect > 0) {
        pendingArtifactReconcileGlobal = true;
        pendingArtifactReconcileGlobalCursor = String(rows[rowsToInspect - 1]!.id);
      } else if (!hasContinuation) {
        pendingArtifactReconcileGlobal = false;
        pendingArtifactReconcileGlobalCursor = undefined;
      } else {
        pendingArtifactReconcileGlobal = true;
      }
    }
    const pending = getArtifactReconcileStatus();
    return {
      inspected,
      retained,
      removed,
      stale,
      quarantined,
      bytesRemoved,
      pendingUsers: pending.pendingUsers,
      pendingOverflow: pending.pendingOverflow,
      pendingGlobal: pending.pendingGlobal,
      healthy: pending.healthy,
    };
  }

  private publishedReferenceCount(userId: string, digest: string): number {
    const db = this.db;
    const columns = tableColumns(db, "agent_published_workspace_artifacts");
    let count = 0;
    if (columns.size > 0) {
      const userColumn = pickColumn(columns, ["user_id", "owner_id"], "agent_published_workspace_artifacts");
      const digestColumn = pickColumn(columns, ["blob_digest", "digest"], "agent_published_workspace_artifacts");
      const row = db.query(`SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts WHERE ${q(userColumn)} = ? AND ${q(digestColumn)} = ?`).get(userId, digest) as { count?: number };
      count += Number(row?.count ?? 0);
    }
    return count + persistentPublicationArtifactReferenceCount(db, userId, digest);
  }
  private workspaceReferenceCount(userId: string, digest: string): number {
    const db = this.db;
    const columns = tableColumns(db, "agent_workspace_artifacts");
    let count = 0;
    if (columns.size > 0) {
      const userColumn = pickColumn(columns, ["user_id", "owner_id"], "agent_workspace_artifacts");
      const digestColumn = pickColumn(columns, ["blob_digest", "digest"], "agent_workspace_artifacts");
      const row = db.query(`SELECT COUNT(*) AS count FROM agent_workspace_artifacts WHERE ${q(userColumn)} = ? AND ${q(digestColumn)} = ?`).get(userId, digest) as { count?: number };
      count += Number(row?.count ?? 0);
    }
    return count + persistentArtifactReferenceCount(db, userId, digest);
  }
  private deleteJournal(journal: JournalRow): void {
    const columns = requireTable(this.db, "agent_artifact_blob_journal");
    const idColumn = pickColumn(columns, ["id", "journal_id"], "agent_artifact_blob_journal");
    this.db.query(`DELETE FROM agent_artifact_blob_journal WHERE ${q(idColumn)} = ?`).run(journal.id);
  }

  private deleteUnreferencedBlob(digest: string, userId: string): void {
    const db = this.db;
    const columns = requireTable(db, "agent_artifact_blobs");
    const digestColumn = pickColumn(columns, ["digest", "blob_digest"], "agent_artifact_blobs");
    const userColumn = pickColumn(columns, ["user_id", "owner_id"], "agent_artifact_blobs");
    const refColumn = pickColumn(columns, ["published_reference_count", "ref_count", "reference_count"], "agent_artifact_blobs");
    if (this.publishedReferenceCount(userId, digest) > 0 || this.workspaceReferenceCount(userId, digest) > 0) return;
    const journalColumns = tableColumns(db, "agent_artifact_blob_journal");
    if (journalColumns.size > 0) {
      const journalDigest = pickColumn(journalColumns, ["blob_digest", "digest", "artifact_digest"], "agent_artifact_blob_journal");
      const journalUser = pickColumn(journalColumns, ["user_id", "owner_id"], "agent_artifact_blob_journal");
      const journalState = pickColumn(journalColumns, ["state", "install_state"], "agent_artifact_blob_journal");
      const active = db.query(`SELECT COUNT(*) AS count FROM agent_artifact_blob_journal WHERE ${q(journalDigest)} = ? AND ${q(journalUser)} = ? AND ${q(journalState)} != 'removed'`).get(digest, userId) as { count?: number };
      if (Number(active?.count ?? 0) > 0) return;
      db.query(`DELETE FROM agent_artifact_blob_journal WHERE ${q(journalDigest)} = ? AND ${q(journalUser)} = ? AND ${q(journalState)} = 'removed'`).run(digest, userId);
    }
    db.query(`DELETE FROM agent_artifact_blobs WHERE ${q(digestColumn)} = ? AND ${q(userColumn)} = ? AND ${q(refColumn)} = 0`).run(digest, userId);
  }
  private claimJournalForRemoval(journal: JournalRow): boolean {
    const columns = requireTable(this.db, "agent_artifact_blob_journal");
    const idColumn = pickColumn(columns, ["id", "journal_id"], "agent_artifact_blob_journal");
    const stateColumn = pickColumn(columns, ["state", "install_state"], "agent_artifact_blob_journal");
    const observedColumn = pickColumn(columns, ["observed_identity", "final_identity", "identity"], "agent_artifact_blob_journal");
    const fenceColumn = pickColumn(columns, ["fence", "lease_generation", "fence_generation"], "agent_artifact_blob_journal");
    const updatedColumn = columns.has("updated_at") ? "updated_at" : undefined;
    const marker = parseMarker(journal.observedIdentity);
    const updates = [`${q(observedColumn)} = ?`];
    const values: SQLQueryBindings[] = [encodeMarker({ ...marker, deleting: true })];
    if (updatedColumn) {
      updates.push(`${q(updatedColumn)} = ?`);
      values.push(nowSeconds(this.now));
    }
    values.push(journal.id, journal.observedIdentity, journal.fence);
    const blobColumns = requireTable(this.db, "agent_artifact_blobs");
    const blobDigestColumn = pickColumn(blobColumns, ["digest", "blob_digest"], "agent_artifact_blobs");
    const blobUserColumn = pickColumn(blobColumns, ["user_id", "owner_id"], "agent_artifact_blobs");
    const blobRefColumn = pickColumn(blobColumns, ["published_reference_count", "ref_count", "reference_count"], "agent_artifact_blobs");
    const guards = [`EXISTS (SELECT 1 FROM agent_artifact_blobs WHERE ${q(blobDigestColumn)} = ? AND ${q(blobUserColumn)} = ? AND ${q(blobRefColumn)} = 0)`];
    values.push(journal.digest, journal.userId);
    const publishedColumns = tableColumns(this.db, "agent_published_workspace_artifacts");
    if (publishedColumns.size > 0) {
      const publishedDigestColumn = pickColumn(publishedColumns, ["blob_digest", "digest"], "agent_published_workspace_artifacts");
      const publishedUserColumn = pickColumn(publishedColumns, ["user_id", "owner_id"], "agent_published_workspace_artifacts");
      guards.push(`NOT EXISTS (SELECT 1 FROM agent_published_workspace_artifacts WHERE ${q(publishedDigestColumn)} = ? AND ${q(publishedUserColumn)} = ?)`);
      values.push(journal.digest, journal.userId);
    }
    const workspaceColumns = tableColumns(this.db, "agent_workspace_artifacts");
    if (workspaceColumns.size > 0) {
      const workspaceDigestColumn = pickColumn(workspaceColumns, ["blob_digest", "digest"], "agent_workspace_artifacts");
      const workspaceUserColumn = pickColumn(workspaceColumns, ["user_id", "owner_id"], "agent_workspace_artifacts");
      guards.push(`NOT EXISTS (SELECT 1 FROM agent_workspace_artifacts WHERE ${q(workspaceDigestColumn)} = ? AND ${q(workspaceUserColumn)} = ?)`);
      values.push(journal.digest, journal.userId);
    }
    const persistentArtifactColumns = tableColumns(this.db, "persistent_workspace_artifacts");
    if (persistentArtifactColumns.size > 0) {
      const persistentDigestColumn = pickColumn(persistentArtifactColumns, ["blob_digest", "digest"], "persistent_workspace_artifacts");
      const persistentUserColumn = pickColumn(persistentArtifactColumns, ["user_id", "owner_id"], "persistent_workspace_artifacts");
      guards.push(`NOT EXISTS (SELECT 1 FROM persistent_workspace_artifacts WHERE ${q(persistentDigestColumn)} = ? AND ${q(persistentUserColumn)} = ?)`);
      values.push(journal.digest, journal.userId);
    }
    const persistentPublicationColumns = tableColumns(this.db, "persistent_workspace_publications");
    if (persistentPublicationColumns.size > 0
      && persistentPublicationColumns.has("category")
      && persistentPublicationColumns.has("copy_json")) {
      const persistentPublicationUserColumn = pickColumn(persistentPublicationColumns, ["user_id", "owner_id"], "persistent_workspace_publications");
      guards.push(`NOT EXISTS (
        SELECT 1 FROM persistent_workspace_publications
         WHERE ${q(persistentPublicationUserColumn)} = ?
           AND ${q("category")} = 'artifact'
           AND CASE WHEN json_valid(${q("copy_json")}) THEN json_extract(${q("copy_json")}, '$.blobDigest') END = ?
      )`);
      values.push(journal.userId, journal.digest);
    }
    const result = this.db.query(
      `UPDATE agent_artifact_blob_journal SET ${updates.join(", ")} WHERE ${q(idColumn)} = ? AND ${q(stateColumn)} IN ('pending', 'installed') AND ${q(observedColumn)} IS ? AND ${q(fenceColumn)} = ? AND ${guards.join(" AND ")}`,
    ).run(...values);
    return changes(result) > 0;
  }
  async cleanup(options: { readonly now?: number; readonly maxRows?: number; readonly maxBytes?: number } = {}): Promise<ArtifactCleanupResult> {
    const db = this.db;
    const columns = requireTable(db, "agent_artifact_blobs");
    const digestColumn = pickColumn(columns, ["digest", "blob_digest"], "agent_artifact_blobs");
    const userColumn = pickColumn(columns, ["user_id", "owner_id"], "agent_artifact_blobs");
    const bytesColumn = pickColumn(columns, ["byte_count", "bytes"], "agent_artifact_blobs");
    const pathColumn = pickColumn(columns, ["storage_path", "final_path", "path"], "agent_artifact_blobs");
    const refColumn = pickColumn(columns, ["published_reference_count", "ref_count", "reference_count"], "agent_artifact_blobs");
    const expiresColumn = columns.has("expires_at") ? "expires_at" : undefined;
    const createdColumn = columns.has("created_at") ? "created_at" : undefined;
    const predicate = expiresColumn ? `(${q(expiresColumn)} IS NOT NULL AND ${q(expiresColumn)} <= ?)` : "1 = 0";
    const order = createdColumn ? `ORDER BY ${q(createdColumn)} ASC` : `ORDER BY ${q(digestColumn)} ASC`;
    const cleanupParams: SQLQueryBindings[] = expiresColumn
      ? [options.now ?? nowSeconds(this.now), options.maxRows ?? this.limits.maxCleanupRows]
      : [options.maxRows ?? this.limits.maxCleanupRows];
    const rows = db.query(`SELECT * FROM agent_artifact_blobs WHERE ${q(refColumn)} = 0 AND ${predicate} ${order} LIMIT ?`).all(...cleanupParams) as SqlRow[];
    let removed = 0;
    let skippedReferenced = 0;
    let skippedShared = 0;
    let quarantined = 0;
    let bytesRemoved = 0;
    const maxBytes = options.maxBytes ?? this.limits.maxCleanupBytes;
    for (const row of rows) {
      const digest = String(row[digestColumn]);
      const userId = String(row[userColumn]);
      const bytes = Number(row[bytesColumn]);
      let releaseDeletionFence: (() => void) | undefined;
      try {
        releaseDeletionFence = await acquireArtifactDeletionFence(userId, digest);
      } catch (error) {
        if (isArtifactLifecycleBusy(error)) {
          skippedShared++;
          continue;
        }
        throw error;
      }
      try {
      if (bytesRemoved + bytes > maxBytes) break;
      if (this.publishedReferenceCount(userId, digest) > 0 || this.workspaceReferenceCount(userId, digest) > 0 || Number(row[refColumn]) > 0) { skippedReferenced++; continue; }
      const journals = this.journalsForDigest(userId, digest);
      const path = String(row[pathColumn]);
      const ownerJournal = journals.find((journal) => {
        if (journal.state !== "installed" && journal.state !== "pending") return false;
        const marker = parseMarker(journal.observedIdentity);
        const final = readIdentity(String(row[pathColumn]));
        return journal.finalPath === path && marker.createdByUs && marker.before === null && final && marker.after === identityString(final);
      });
      if (!ownerJournal) { skippedShared++; quarantined++; continue; }
      const activeJournals = journals.filter((journal) => journal.state !== "removed");
      if (activeJournals.length !== 1 || activeJournals[0]?.id !== ownerJournal.id) {
        skippedShared++;
        quarantined++;
        continue;
      }
      if (!this.isOwnedPath(userId, path)) { skippedShared++; quarantined++; continue; }
      const identity = readIdentity(path);
      if (!identity || identity.size !== bytes) { skippedShared++; quarantined++; continue; }
      let matches = false;
      try { matches = await this.hashFile(path, bytes) === digest; } catch { matches = false; }
      if (!matches) { skippedShared++; quarantined++; continue; }
      const currentBlob = this.blobRow(digest, userId);
      if (this.publishedReferenceCount(userId, digest) > 0
        || this.workspaceReferenceCount(userId, digest) > 0
        || Number(currentBlob?.[refColumn] ?? 0) > 0) {
        skippedReferenced++;
        continue;
      }
      if (!this.claimJournalForRemoval(ownerJournal)) { skippedReferenced++; continue; }
      const claimedIdentity = readIdentity(path);
      if (!claimedIdentity || identityString(claimedIdentity) !== identityString(identity)) { quarantined++; continue; }
      if (!(await this.removeOwnedPath(userId, path))) { quarantined++; continue; }
      this.updateJournal(ownerJournal, "removed", { ...parseMarker(ownerJournal.observedIdentity), after: identityString(claimedIdentity), deleting: false });
      this.deleteUnreferencedBlob(digest, userId);
      removed++;
      bytesRemoved += bytes;
      } finally {
        releaseDeletionFence?.();
      }
    }
    return { inspected: rows.length, removed, skippedReferenced, skippedShared, quarantined, bytesRemoved };
  }

  private journalsForDigest(userId: string, digest: string): JournalRow[] {
    const columns = requireTable(this.db, "agent_artifact_blob_journal");
    const digestColumn = pickColumn(columns, ["blob_digest", "digest", "artifact_digest"], "agent_artifact_blob_journal");
    const userColumn = pickColumn(columns, ["user_id", "owner_id"], "agent_artifact_blob_journal");
    const rows = this.db.query(`SELECT * FROM agent_artifact_blob_journal WHERE ${q(digestColumn)} = ? AND ${q(userColumn)} = ?`).all(digest, userId) as SqlRow[];
    return rows.map((row) => ({
      id: String(row[pickColumn(columns, ["id", "journal_id"], "agent_artifact_blob_journal")]),
      digest: String(row[digestColumn]),
      userId: String(row[userColumn]),
      turnId: String(row[pickColumn(columns, ["turn_id", "execution_id"], "agent_artifact_blob_journal")]),
      creatorToken: String(row[pickColumn(columns, ["creator_token", "creator_id"], "agent_artifact_blob_journal")]),
      fence: String(row[pickColumn(columns, ["fence", "lease_generation", "fence_generation"], "agent_artifact_blob_journal")]),
      stagedPath: String(row[pickColumn(columns, ["staged_path", "stage_path"], "agent_artifact_blob_journal")]),
      finalPath: String(row[pickColumn(columns, ["final_path", "storage_path"], "agent_artifact_blob_journal")]),
      state: String(row[pickColumn(columns, ["state", "install_state"], "agent_artifact_blob_journal")]) as JournalRow["state"],
      observedIdentity: row[pickColumn(columns, ["observed_identity", "final_identity", "identity"], "agent_artifact_blob_journal")] == null ? null : String(row[pickColumn(columns, ["observed_identity", "final_identity", "identity"], "agent_artifact_blob_journal")]),
      byteCount: Number(row[pickColumn(columns, ["byte_count", "bytes"], "agent_artifact_blob_journal")]),
    }));
  }

  async persistArtifact(input: ArtifactBlobWriteInput): Promise<ArtifactBlobHandle> {
    return this.stageArtifact(input);
  }
}
export function assertArtifactBlobAvailable(db: Database, input: ArtifactBlobAvailabilityInput): void {
  const userId = assertSafeId(input.userId, "artifact_invalid_user", "User id");
  if (!DIGEST_RE.test(input.digest) || !Number.isSafeInteger(input.byteCount) || input.byteCount < 0 || !MIME_RE.test(input.mimeType)) {
    throw new ArtifactBlobError("artifact_file_mismatch", "Artifact publication metadata is invalid");
  }
  const blobColumns = requireTable(db, "agent_artifact_blobs");
  const blobDigest = pickColumn(blobColumns, ["digest", "blob_digest"], "agent_artifact_blobs");
  const blobUser = pickColumn(blobColumns, ["user_id", "owner_id"], "agent_artifact_blobs");
  const blobBytes = pickColumn(blobColumns, ["byte_count", "bytes"], "agent_artifact_blobs");
  const blobMime = pickColumn(blobColumns, ["mime_type", "mime"], "agent_artifact_blobs");
  const blobPath = pickColumn(blobColumns, ["storage_path", "final_path", "path"], "agent_artifact_blobs");
  const blob = db.query(
    `SELECT ${q(blobBytes)} AS byte_count, ${q(blobMime)} AS mime_type, ${q(blobPath)} AS storage_path
       FROM agent_artifact_blobs
      WHERE ${q(blobDigest)} = ? AND ${q(blobUser)} = ? LIMIT 1`,
  ).get(input.digest, userId) as SqlRow | null;
  if (!blob) throw new ArtifactBlobError("artifact_not_found", "Artifact blob is not available");
  const storagePath = String(blob.storage_path ?? "");
  if (Number(blob.byte_count) !== input.byteCount || String(blob.mime_type) !== input.mimeType) {
    throw new ArtifactBlobError("artifact_file_mismatch", "Artifact publication metadata does not match the immutable blob");
  }
  const identity = readIdentity(storagePath);
  if (!identity) throw new ArtifactBlobError("artifact_file_missing", "Artifact file is unavailable");
  if (identity.size !== input.byteCount || hashFileSync(storagePath, input.byteCount) !== input.digest) {
    throw new ArtifactBlobError("artifact_file_mismatch", "Artifact bytes do not match the immutable blob");
  }
  const journalColumns = requireTable(db, "agent_artifact_blob_journal");
  const journalDigest = pickColumn(journalColumns, ["blob_digest", "digest", "artifact_digest"], "agent_artifact_blob_journal");
  const journalUser = pickColumn(journalColumns, ["user_id", "owner_id"], "agent_artifact_blob_journal");
  const journalState = pickColumn(journalColumns, ["state", "install_state"], "agent_artifact_blob_journal");
  const journalFinal = pickColumn(journalColumns, ["final_path", "storage_path"], "agent_artifact_blob_journal");
  const journalObserved = pickColumn(journalColumns, ["observed_identity", "final_identity", "identity"], "agent_artifact_blob_journal");
  const journals = db.query(
    `SELECT ${q(journalFinal)} AS final_path, ${q(journalObserved)} AS observed_identity
       FROM agent_artifact_blob_journal
      WHERE ${q(journalDigest)} = ? AND ${q(journalUser)} = ? AND ${q(journalState)} = 'installed'`,
  ).all(input.digest, userId) as SqlRow[];
  const identityValue = identityString(identity);
  if (!journals.some((row) => String(row.final_path ?? "") === storagePath
    && parseMarker(row.observed_identity == null ? null : String(row.observed_identity)).after === identityValue
    && !parseMarker(row.observed_identity == null ? null : String(row.observed_identity)).deleting)) {
    throw new ArtifactBlobError("artifact_not_found", "Artifact installation is not available");
  }
}
export function assertArtifactAttachable(db: Database, input: ArtifactAttachableInput): void {
  const userId = assertSafeId(input.userId, "artifact_invalid_user", "User id");
  const turnId = assertSafeId(input.turnId, "artifact_invalid_turn", "Turn id");
  const creatorToken = assertSafeId(input.creatorToken, "artifact_unauthorized", "Artifact creator token");
  if (!DIGEST_RE.test(input.digest) || !Number.isSafeInteger(input.byteCount) || input.byteCount < 0 || !MIME_RE.test(input.mimeType)) {
    throw new ArtifactBlobError("artifact_file_mismatch", "Artifact attachment metadata is invalid");
  }
  if (input.deletionFence !== ARTIFACT_DELETION_FENCE) assertArtifactDeletionFenceAvailable(userId, input.digest);
  throwFence({ assertFence: input.assertFence });
  const blobColumns = requireTable(db, "agent_artifact_blobs");
  const blobDigest = pickColumn(blobColumns, ["digest", "blob_digest"], "agent_artifact_blobs");
  const blobUser = pickColumn(blobColumns, ["user_id", "owner_id"], "agent_artifact_blobs");
  const blobBytes = pickColumn(blobColumns, ["byte_count", "bytes"], "agent_artifact_blobs");
  const blobMime = pickColumn(blobColumns, ["mime_type", "mime"], "agent_artifact_blobs");
  const blobPath = pickColumn(blobColumns, ["storage_path", "final_path", "path"], "agent_artifact_blobs");
  const blob = db.query(`SELECT ${q(blobBytes)} AS byte_count, ${q(blobMime)} AS mime_type, ${q(blobPath)} AS storage_path FROM agent_artifact_blobs WHERE ${q(blobDigest)} = ? AND ${q(blobUser)} = ? LIMIT 1`).get(input.digest, userId) as SqlRow | null;
  if (!blob) throw new ArtifactBlobError("artifact_not_found", "Artifact blob is not available");
  if (Number(blob.byte_count) !== input.byteCount || String(blob.mime_type) !== input.mimeType) {
    throw new ArtifactBlobError("artifact_file_mismatch", "Artifact attachment metadata does not match the immutable blob");
  }
  const journalColumns = requireTable(db, "agent_artifact_blob_journal");
  const journalDigest = pickColumn(journalColumns, ["blob_digest", "digest", "artifact_digest"], "agent_artifact_blob_journal");
  const journalUser = pickColumn(journalColumns, ["user_id", "owner_id"], "agent_artifact_blob_journal");
  const journalTurn = pickColumn(journalColumns, ["turn_id", "execution_id"], "agent_artifact_blob_journal");
  const journalState = pickColumn(journalColumns, ["state", "install_state"], "agent_artifact_blob_journal");
  const journalCreator = pickColumn(journalColumns, ["creator_token", "creator_id"], "agent_artifact_blob_journal");
  const journalObserved = pickColumn(journalColumns, ["observed_identity", "final_identity", "identity"], "agent_artifact_blob_journal");
  const deletingJournals = db.query(`SELECT ${q(journalObserved)} AS observed_identity FROM agent_artifact_blob_journal WHERE ${q(journalDigest)} = ? AND ${q(journalUser)} = ? AND ${q(journalState)} IN ('pending', 'installed')`).all(input.digest, userId) as SqlRow[];
  if (deletingJournals.some((row) => parseMarker(row.observed_identity == null ? null : String(row.observed_identity)).deleting)) {
    throw new ArtifactBlobError("artifact_fence_lost", "Artifact is being reconciled or deleted");
  }
  const journalFinal = pickColumn(journalColumns, ["final_path", "storage_path"], "agent_artifact_blob_journal");
  const journal = db.query(`SELECT ${q(journalState)} AS state, ${q(journalCreator)} AS creator_token, ${q(journalObserved)} AS observed_identity, ${q(journalFinal)} AS final_path FROM agent_artifact_blob_journal WHERE ${q(journalDigest)} = ? AND ${q(journalUser)} = ? AND ${q(journalTurn)} = ? LIMIT 1`).get(input.digest, userId, turnId) as SqlRow | null;
  if (!journal || String(journal.state) !== "installed") {
    throw new ArtifactBlobError("artifact_not_found", "Artifact blob is not available");
  }
  if (String(journal.creator_token) !== creatorToken) {
    throw new ArtifactBlobError("artifact_unauthorized", "Artifact creator proof does not match the installed journal");
  }
  const marker = parseMarker(journal.observed_identity == null ? null : String(journal.observed_identity));
  if (marker.deleting === true) throw new ArtifactBlobError("artifact_fence_lost", "Artifact is being reconciled or deleted");
  const finalPath = String(journal.final_path ?? "");
  const blobPathValue = String(blob.storage_path ?? "");
  const identity = readIdentity(finalPath);
  if (!identity) throw new ArtifactBlobError("artifact_file_missing", "Artifact file is unavailable");
  if (finalPath !== blobPathValue || identity.size !== input.byteCount || marker.after !== identityString(identity) || hashFileSync(finalPath, input.byteCount) !== input.digest) {
    throw new ArtifactBlobError("artifact_file_mismatch", "Artifact bytes do not match the immutable journal");
  }
  if (input.deletionFence !== ARTIFACT_DELETION_FENCE) assertArtifactDeletionFenceAvailable(userId, input.digest);
  throwFence({ assertFence: input.assertFence });
}
function ensureWorkspaceArtifactAuthorized(db: Database, input: ArtifactPublishInput, ref: ArtifactPublicationInput): void {
  if (typeof ref.workspaceArtifactId !== "string" || ref.workspaceArtifactId.length === 0) throw new ArtifactBlobError("artifact_unauthorized", "Workspace artifact is required for publication");
  const table = "agent_workspace_artifacts";
  const columns = requireTable(db, table);
  const idColumn = pickColumn(columns, ["artifact_id", "id"], table);
  const userColumn = pickColumn(columns, ["user_id", "owner_id"], table);
  const chatColumn = pickColumn(columns, ["chat_id"], table);
  const turnColumn = pickColumn(columns, ["turn_id", "execution_id"], table);
  const workspaceColumn = pickColumn(columns, ["workspace_id"], table);
  const digestColumn = pickColumn(columns, ["blob_digest", "digest"], table);
  const stateColumn = pickColumn(columns, ["publication_state", "state"], table);
  const row = db.query(`SELECT ${q(userColumn)} AS user_id, ${q(chatColumn)} AS chat_id, ${q(turnColumn)} AS turn_id, ${q(workspaceColumn)} AS workspace_id, ${q(digestColumn)} AS blob_digest, ${q(stateColumn)} AS publication_state FROM ${table} WHERE ${q(idColumn)} = ? LIMIT 1`).get(ref.workspaceArtifactId) as SqlRow | null;
  if (!row || row.user_id !== input.userId || row.chat_id !== input.chatId || row.turn_id !== input.turnId || row.blob_digest !== ref.digest || (input.workspaceId !== undefined && row.workspace_id !== input.workspaceId) || String(row.publication_state) !== "proposed") {
    throw new ArtifactBlobError("artifact_unauthorized", "Workspace artifact is not authorized for publication");
  }
}

function validatePublicationRef(ref: ArtifactPublicationInput): void {
  if (!DIGEST_RE.test(ref.digest) || !Number.isSafeInteger(ref.byteCount) || ref.byteCount < 0 || !MIME_RE.test(ref.mimeType)) {
    throw new ArtifactBlobError("artifact_commit_invalid", "Artifact publication reference is invalid");
  }
  validateProvenance(ref.provenance, DEFAULT_ARTIFACT_BLOB_LIMITS.maxProvenanceBytes);
  if (ref.retention !== "chat_lifetime") throw new ArtifactBlobError("artifact_commit_invalid", "Only chat-lifetime artifacts may be published");
  if (ref.swipeId !== null && (!Number.isSafeInteger(ref.swipeId) || ref.swipeId < 0)) throw new ArtifactBlobError("artifact_commit_invalid", "Artifact publication swipe is invalid");
}

function ensureChatOwner(db: Database, userId: string, chatId: string): void {
  const columns = tableColumns(db, "chats");
  if (columns.size === 0) return;
  const idColumn = pickColumn(columns, ["id", "chat_id"], "chats");
  const userColumn = pickColumn(columns, ["user_id", "owner_id"], "chats");
  const row = db.query(`SELECT ${q(userColumn)} AS user_id FROM chats WHERE ${q(idColumn)} = ? LIMIT 1`).get(chatId) as { user_id?: string } | null;
  if (!row || row.user_id !== userId) throw new ArtifactBlobError("artifact_unauthorized", "Chat is not owned by the authenticated user");
}
function persistentArtifactReferenceCount(db: Database, userId: string, digest: string): number {
  const table = "persistent_workspace_artifacts";
  const columns = tableColumns(db, table);
  if (columns.size === 0) return 0;
  const userColumn = pickColumn(columns, ["user_id", "owner_id"], table);
  const digestColumn = pickColumn(columns, ["blob_digest", "digest"], table);
  const row = db.query(
    `SELECT COUNT(*) AS count FROM ${q(table)} WHERE ${q(userColumn)} = ? AND ${q(digestColumn)} = ?`,
  ).get(userId, digest) as { count?: number };
  return Number(row?.count ?? 0);
}

/**
 * Persistent publication copies intentionally store their artifact digest in
 * copy_json rather than taking a foreign key to the operational blob. Parse
 * the copy and compare the digest as a value, never as a substring.
 */
function persistentPublicationArtifactReferenceCount(db: Database, userId: string, digest: string): number {
  const table = "persistent_workspace_publications";
  const columns = tableColumns(db, table);
  if (columns.size === 0 || !columns.has("category") || !columns.has("copy_json")) return 0;
  const userColumn = pickColumn(columns, ["user_id", "owner_id"], table);
  const rows = db.query(
    `SELECT ${q("copy_json")} AS copy_json FROM ${q(table)}
      WHERE ${q(userColumn)} = ? AND ${q("category")} = 'artifact'`,
  ).all(userId) as Array<{ copy_json?: unknown }>;
  let count = 0;
  for (const row of rows) {
    if (typeof row.copy_json !== "string") continue;
    try {
      const copy = JSON.parse(row.copy_json) as unknown;
      if (copy !== null && typeof copy === "object" && !Array.isArray(copy)
        && (copy as Record<string, unknown>).blobDigest === digest) {
        count++;
      }
    } catch {
      // A malformed immutable row cannot prove a reference to these bytes.
    }
  }
  return count;
}

export function retainArtifactBlobReference(db: Database, digest: string, userId: string): void {
  if (!DIGEST_RE.test(digest)) throw new ArtifactBlobError("artifact_invalid_digest", "Artifact digest is invalid");
  assertSafeId(userId, "artifact_invalid_user", "User id");
  const columns = requireTable(db, "agent_artifact_blobs");
  const digestColumn = pickColumn(columns, ["digest", "blob_digest"], "agent_artifact_blobs");
  const userColumn = pickColumn(columns, ["user_id", "owner_id"], "agent_artifact_blobs");
  const refColumn = pickColumn(columns, ["published_reference_count", "ref_count", "reference_count"], "agent_artifact_blobs");
  const result = db.query(
    `UPDATE agent_artifact_blobs SET ${q(refColumn)} = ${q(refColumn)} + 1
      WHERE ${q(digestColumn)} = ? AND ${q(userColumn)} = ?`,
  ).run(digest, userId);
  if (changes(result) !== 1) throw new ArtifactBlobError("artifact_not_found", "Artifact blob is unavailable");
}

export function releaseArtifactBlobReference(db: Database, digest: string, userId: string): void {
  if (!DIGEST_RE.test(digest)) throw new ArtifactBlobError("artifact_invalid_digest", "Artifact digest is invalid");
  assertSafeId(userId, "artifact_invalid_user", "User id");
  const columns = tableColumns(db, "agent_artifact_blobs");
  if (columns.size === 0) return;
  const digestColumn = pickColumn(columns, ["digest", "blob_digest"], "agent_artifact_blobs");
  const userColumn = pickColumn(columns, ["user_id", "owner_id"], "agent_artifact_blobs");
  const refColumn = pickColumn(columns, ["published_reference_count", "ref_count", "reference_count"], "agent_artifact_blobs");
  db.query(
    `UPDATE agent_artifact_blobs SET ${q(refColumn)} = MAX(0, ${q(refColumn)} - 1)
      WHERE ${q(digestColumn)} = ? AND ${q(userColumn)} = ?`,
  ).run(digest, userId);
}



function insertPublishedReference(db: Database, input: ArtifactPublishInput, ref: ArtifactPublicationInput, receiptId: string, committedAt: number): boolean {
  const table = "agent_published_workspace_artifacts";
  const columns = requireTable(db, table);
  const idColumn = pickColumn(columns, ["published_artifact_id", "id"], table);
  const sourceColumn = pickColumn(columns, ["source_artifact_id", "workspace_artifact_id"], table);
  const userColumn = pickColumn(columns, ["user_id", "owner_id"], table);
  const chatColumn = pickColumn(columns, ["chat_id"], table);
  const messageColumn = pickColumn(columns, ["message_id", "target_message_id"], table);
  const swipeColumn = pickColumn(columns, ["swipe_id", "target_swipe_id"], table);
  const digestColumn = pickColumn(columns, ["blob_digest", "digest"], table);
  const bytesColumn = pickColumn(columns, ["byte_count", "bytes"], table);
  const mimeColumn = pickColumn(columns, ["mime_type", "mime"], table);
  const pathColumn = pickColumn(columns, ["storage_path", "final_path", "path"], table);
  const receiptColumn = pickColumn(columns, ["receipt_id", "commit_receipt_id"], table);
  const retentionColumn = pickColumn(columns, ["retention"], table);
  const revisionColumn = columns.has("revision") ? "revision" : undefined;
  const createdColumn = columns.has("created_at") ? "created_at" : undefined;
  const blobColumns = requireTable(db, "agent_artifact_blobs");
  const blobDigestColumn = pickColumn(blobColumns, ["digest", "blob_digest"], "agent_artifact_blobs");
  const blobUserColumn = pickColumn(blobColumns, ["user_id", "owner_id"], "agent_artifact_blobs");
  const blobBytesColumn = pickColumn(blobColumns, ["byte_count", "bytes"], "agent_artifact_blobs");
  const blobPathColumn = pickColumn(blobColumns, ["storage_path", "final_path", "path"], "agent_artifact_blobs");
  const blob = db.query(`SELECT ${q(blobPathColumn)} AS storage_path, ${q(blobBytesColumn)} AS byte_count FROM agent_artifact_blobs WHERE ${q(blobDigestColumn)} = ? AND ${q(blobUserColumn)} = ? LIMIT 1`).get(ref.digest, input.userId) as { storage_path?: string; byte_count?: number } | null;
  if (!blob?.storage_path) throw new ArtifactBlobError("artifact_file_missing", "Artifact storage path is unavailable");
  const journalColumns = requireTable(db, "agent_artifact_blob_journal");
  const journalDigestColumn = pickColumn(journalColumns, ["blob_digest", "digest", "artifact_digest"], "agent_artifact_blob_journal");
  const journalUserColumn = pickColumn(journalColumns, ["user_id", "owner_id"], "agent_artifact_blob_journal");
  const journalTurnColumn = pickColumn(journalColumns, ["turn_id", "execution_id"], "agent_artifact_blob_journal");
  const journalStateColumn = pickColumn(journalColumns, ["state", "install_state"], "agent_artifact_blob_journal");
  const journalFinalColumn = pickColumn(journalColumns, ["final_path", "storage_path"], "agent_artifact_blob_journal");
  const journalObservedColumn = pickColumn(journalColumns, ["observed_identity", "final_identity", "identity"], "agent_artifact_blob_journal");
  const deletingJournals = db.query(`SELECT ${q(journalObservedColumn)} AS observed_identity FROM agent_artifact_blob_journal WHERE ${q(journalDigestColumn)} = ? AND ${q(journalUserColumn)} = ? AND ${q(journalStateColumn)} IN ('pending', 'installed')`).all(ref.digest, input.userId) as SqlRow[];
  if (deletingJournals.some((row) => parseMarker(row.observed_identity == null ? null : String(row.observed_identity)).deleting)) {
    throw new ArtifactBlobError("artifact_fence_lost", "Artifact is being reconciled or deleted");
  }
  const journal = db.query(`SELECT ${q(journalStateColumn)} AS state, ${q(journalFinalColumn)} AS final_path, ${q(journalObservedColumn)} AS observed_identity FROM agent_artifact_blob_journal WHERE ${q(journalUserColumn)} = ? AND ${q(journalTurnColumn)} = ? AND ${q(journalDigestColumn)} = ? LIMIT 1`).get(input.userId, input.turnId, ref.digest) as { state?: unknown; final_path?: unknown; observed_identity?: unknown } | null;
  if (!journal || String(journal.state) !== "installed") {
    throw new ArtifactBlobError("artifact_unauthorized", "Artifact was not installed by this turn");
  }
  const marker = parseMarker(journal.observed_identity == null ? null : String(journal.observed_identity));
  if (marker.deleting) throw new ArtifactBlobError("artifact_fence_lost", "Artifact is being reconciled or deleted");
  const finalPath = String(journal.final_path ?? "");
  const blobPath = String(blob.storage_path);
  const identity = readIdentity(finalPath);
  if (!identity) throw new ArtifactBlobError("artifact_file_missing", "Artifact file is unavailable");
  if (finalPath !== blobPath || Number(blob.byte_count) !== ref.byteCount || identity.size !== ref.byteCount || marker.after !== identityString(identity) || hashFileSync(finalPath, ref.byteCount) !== ref.digest) {
    throw new ArtifactBlobError("artifact_file_mismatch", "Artifact bytes do not match the immutable journal");
  }
  // Blob/journal paths are operational absolute paths. Canonical publication
  // rows are portable owner-relative references and must never inherit them.
  const canonicalStoragePath = `${ref.digest}.blob`;
  const associateReceipt = (): void => {
    db.query(`UPDATE ${table} SET ${q(receiptColumn)} = ?, ${q(pathColumn)} = ? WHERE ${q(userColumn)} = ? AND ${q(chatColumn)} = ? AND ${q(messageColumn)} IS ? AND ${q(swipeColumn)} IS ? AND ${q(digestColumn)} = ?`).run(receiptId, canonicalStoragePath, input.userId, input.chatId, ref.messageId, ref.swipeId, ref.digest);
  };
  const existing = db.query(`SELECT 1 FROM ${table} WHERE ${q(userColumn)} = ? AND ${q(chatColumn)} = ? AND ${q(messageColumn)} IS ? AND ${q(swipeColumn)} IS ? AND ${q(digestColumn)} = ? LIMIT 1`).get(input.userId, input.chatId, ref.messageId, ref.swipeId, ref.digest);
  if (existing) {
    associateReceipt();
    return false;
  }
  const payload: Record<string, unknown> = {
    [idColumn]: crypto.randomUUID(),
    [sourceColumn]: ref.workspaceArtifactId ?? ref.digest,
    [userColumn]: input.userId,
    [chatColumn]: input.chatId,
    [messageColumn]: ref.messageId,
    [swipeColumn]: ref.swipeId,
    [digestColumn]: ref.digest,
    ...(columns.has("digest") && digestColumn !== "digest" ? { digest: ref.digest } : {}),
    [pathColumn]: canonicalStoragePath,
    [bytesColumn]: ref.byteCount,
    [mimeColumn]: ref.mimeType,
    [retentionColumn]: "chat_lifetime",
    [receiptColumn]: receiptId,
    ...(revisionColumn ? { [revisionColumn]: 1 } : {}),
    ...(createdColumn ? { [createdColumn]: committedAt } : {}),
  };
  const params = paramsForInsert(payload);
  try {
    const result = db.query(`INSERT INTO ${table} (${params.columns}) VALUES (${params.placeholders})`).run(...params.values);
    return changes(result) > 0;
  } catch (error) {
    if (/unique constraint failed/i.test(String(error))) {
      const duplicate = db.query(`SELECT 1 FROM ${table} WHERE ${q(userColumn)} = ? AND ${q(chatColumn)} = ? AND ${q(messageColumn)} IS ? AND ${q(swipeColumn)} IS ? AND ${q(digestColumn)} = ? LIMIT 1`).get(input.userId, input.chatId, ref.messageId, ref.swipeId, ref.digest);
      if (duplicate) {
        associateReceipt();
        return false;
      }
    }
    throw error;
  }
}

function markWorkspaceArtifactPublished(db: Database, input: ArtifactPublishInput, ref: ArtifactPublicationInput): void {
  const table = "agent_workspace_artifacts";
  const columns = requireTable(db, table);
  const idColumn = pickColumn(columns, ["artifact_id", "id"], table);
  const userColumn = pickColumn(columns, ["user_id", "owner_id"], table);
  const chatColumn = pickColumn(columns, ["chat_id"], table);
  const turnColumn = pickColumn(columns, ["turn_id", "execution_id"], table);
  const workspaceColumn = pickColumn(columns, ["workspace_id"], table);
  const digestColumn = pickColumn(columns, ["blob_digest", "digest"], table);
  const stateColumn = pickColumn(columns, ["publication_state", "state"], table);
  const revisionColumn = columns.has("revision") ? "revision" : undefined;
  const updatedColumn = columns.has("updated_at") ? "updated_at" : undefined;
  const updates = [`${q(stateColumn)} = 'published'`];
  const values: SQLQueryBindings[] = [];
  if (revisionColumn) updates.push(`${q(revisionColumn)} = ${q(revisionColumn)} + 1`);
  if (updatedColumn) {
    updates.push(`${q(updatedColumn)} = ?`);
    values.push(Math.floor(Date.now() / 1000));
  }
  const predicates = [
    `${q(idColumn)} = ?`,
    `${q(userColumn)} = ?`,
    `${q(chatColumn)} = ?`,
    `${q(turnColumn)} = ?`,
    `${q(digestColumn)} = ?`,
    `${q(stateColumn)} = 'proposed'`,
  ];
  const bindings: SQLQueryBindings[] = [ref.workspaceArtifactId, input.userId, input.chatId, input.turnId, ref.digest];
  if (input.workspaceId !== undefined) {
    predicates.splice(3, 0, `${q(workspaceColumn)} = ?`);
    bindings.splice(3, 0, input.workspaceId);
  }
  const result = db.query(`UPDATE ${table} SET ${updates.join(", ")} WHERE ${predicates.join(" AND ")}`).run(...values, ...bindings);
  if (changes(result) === 1) return;
  const existing = db.query(`SELECT ${q(stateColumn)} AS publication_state FROM ${table} WHERE ${q(idColumn)} = ? AND ${q(userColumn)} = ? AND ${q(chatColumn)} = ? AND ${q(turnColumn)} = ? AND ${q(digestColumn)} = ? LIMIT 1`).get(ref.workspaceArtifactId, input.userId, input.chatId, input.turnId, ref.digest) as { publication_state?: unknown } | null;
  if (existing?.publication_state !== "published") throw new ArtifactBlobError("artifact_unauthorized", "Workspace artifact publication state changed");
}

function updateBlobRefCount(db: Database, digest: string, userId: string): void {
  const columns = requireTable(db, "agent_artifact_blobs");
  const digestColumn = pickColumn(columns, ["digest", "blob_digest"], "agent_artifact_blobs");
  const userColumn = pickColumn(columns, ["user_id", "owner_id"], "agent_artifact_blobs");
  const refColumn = pickColumn(columns, ["published_reference_count", "ref_count", "reference_count"], "agent_artifact_blobs");
  const result = db.query(`UPDATE agent_artifact_blobs SET ${q(refColumn)} = ${q(refColumn)} + 1 WHERE ${q(digestColumn)} = ? AND ${q(userColumn)} = ?`).run(digest, userId);
  if (changes(result) !== 1) throw new ArtifactBlobError("artifact_not_found", "Artifact blob is unavailable");
}


/**
 * Publishes only relational references inside the caller-owned COMMIT
 * transaction. Artifact bytes are already immutable and installed by
 * stageArtifact; this function intentionally performs no transaction
 * boundary, receipt write, filesystem write, rename, link, or copy.
 */
export function publishArtifactCommit(db: Database, input: ArtifactPublishInput): ArtifactCommitReceipt {
  return withUserDataMutationSync(input.userId, () => publishArtifactCommitWithinBarrier(db, input));
}

function publishArtifactCommitWithinBarrier(db: Database, input: ArtifactPublishInput): ArtifactCommitReceipt {
  if (!db.inTransaction) throw new ArtifactBlobError("artifact_commit_invalid", "Artifact publication requires the caller-owned COMMIT transaction");
  assertSafeId(input.userId, "artifact_invalid_user", "User id");
  assertSafeId(input.chatId, "artifact_invalid_turn", "Chat id");
  assertSafeId(input.turnId, "artifact_invalid_turn", "Turn id");
  if (!input.commitKey || byteLength(input.commitKey) > 256) throw new ArtifactBlobError("artifact_commit_invalid", "Commit key is invalid");
  if (input.targetSwipeId !== null && (!Number.isSafeInteger(input.targetSwipeId) || input.targetSwipeId < 0)) throw new ArtifactBlobError("artifact_commit_invalid", "Target swipe is invalid");
  for (const ref of input.refs) validatePublicationRef(ref);
  ensureChatOwner(db, input.userId, input.chatId);
  throwFence(input);
  const committedAt = Math.floor(Date.now() / 1000);
  throwFence(input);
  const receiptId = input.receiptId;
  const summaryDigests = [...new Set(input.refs.map((ref) => ref.digest))].sort();
  let insertedCount = 0;
  for (const ref of input.refs) {
    const releaseDeletionFence = acquireArtifactDeletionFenceSync(input.userId, ref.digest);
    try {
      if (ref.messageId !== input.targetMessageId || ref.swipeId !== input.targetSwipeId) {
        throw new ArtifactBlobError("artifact_commit_invalid", "Artifact publication target does not match the commit target");
      }
      ensureWorkspaceArtifactAuthorized(db, input, ref);
      const blobColumns = requireTable(db, "agent_artifact_blobs");
      const digestColumn = pickColumn(blobColumns, ["digest", "blob_digest"], "agent_artifact_blobs");
      const userColumn = pickColumn(blobColumns, ["user_id", "owner_id"], "agent_artifact_blobs");
      const bytesColumn = pickColumn(blobColumns, ["byte_count", "bytes"], "agent_artifact_blobs");
      const mimeColumn = pickColumn(blobColumns, ["mime_type", "mime"], "agent_artifact_blobs");
      const blob = db.query(`SELECT * FROM agent_artifact_blobs WHERE ${q(digestColumn)} = ? AND ${q(userColumn)} = ? LIMIT 1`).get(ref.digest, input.userId) as SqlRow | null;
      if (!blob || String(blob[userColumn]) !== input.userId || Number(blob[bytesColumn]) !== ref.byteCount || String(blob[mimeColumn]) !== ref.mimeType) throw new ArtifactBlobError("artifact_unauthorized", "Artifact publication is not authorized");
      const storageColumn = pickColumn(blobColumns, ["storage_path", "final_path", "path"], "agent_artifact_blobs");
      const storagePath = String(blob[storageColumn] ?? "");
      const finalIdentity = storagePath ? readIdentity(storagePath) : null;
      if (!finalIdentity || finalIdentity.size !== ref.byteCount) throw new ArtifactBlobError("artifact_file_missing", "Artifact bytes are unavailable");
      let finalBytes: Uint8Array;
      try {
        finalBytes = new Uint8Array(readFileSync(storagePath));
      } catch {
        throw new ArtifactBlobError("artifact_file_missing", "Artifact bytes are unavailable");
      }
      if (finalBytes.byteLength !== ref.byteCount || digestBytes(finalBytes) !== ref.digest) throw new ArtifactBlobError("artifact_file_mismatch", "Artifact bytes changed before publication");
      const journalColumns = requireTable(db, "agent_artifact_blob_journal");
      const journalDigest = pickColumn(journalColumns, ["blob_digest", "digest", "artifact_digest"], "agent_artifact_blob_journal");
      const journalUser = pickColumn(journalColumns, ["user_id", "owner_id"], "agent_artifact_blob_journal");
      const journalTurn = pickColumn(journalColumns, ["turn_id", "execution_id"], "agent_artifact_blob_journal");
      const journalState = pickColumn(journalColumns, ["state", "install_state"], "agent_artifact_blob_journal");
      const journal = db.query(`SELECT 1 FROM agent_artifact_blob_journal WHERE ${q(journalDigest)} = ? AND ${q(journalUser)} = ? AND ${q(journalTurn)} = ? AND ${q(journalState)} = 'installed' LIMIT 1`).get(ref.digest, input.userId, input.turnId);
      if (!journal) throw new ArtifactBlobError("artifact_unauthorized", "Artifact installation is not complete");
      const inserted = insertPublishedReference(db, input, ref, receiptId, committedAt);
      markWorkspaceArtifactPublished(db, input, ref);
      if (inserted) {
        insertedCount++;
        updateBlobRefCount(db, ref.digest, input.userId);
      }
    } finally {
      releaseDeletionFence();
    }
  }
  return { receiptId, userId: input.userId, chatId: input.chatId, turnId: input.turnId, commitKey: input.commitKey, duplicate: input.refs.length > 0 && insertedCount === 0, artifactCount: input.refs.length, byteCount: input.refs.reduce((sum, ref) => sum + ref.byteCount, 0), digests: summaryDigests, committedAt };
}

let defaultStore: ArtifactBlobStore | undefined;

export function getAgentArtifactBlobStore(options?: ArtifactBlobStoreOptions): ArtifactBlobStore {
  if (options) return new ArtifactBlobStore(options);
  return (defaultStore ??= new ArtifactBlobStore());
}

export async function persistArtifactBlob(input: ArtifactBlobWriteInput, options?: ArtifactBlobStoreOptions): Promise<ArtifactBlobHandle> {
  return getAgentArtifactBlobStore(options).stageArtifact(input);
}

export async function reconcileAgentArtifactBlobs(options?: ArtifactBlobStoreOptions & { readonly assertFence?: () => void; readonly maxRows?: number; readonly userId?: string }): Promise<ArtifactReconcileResult> {
  const store = getAgentArtifactBlobStore(options);
  return store.reconcile(options);
}

export async function cleanupAgentArtifactBlobs(options?: ArtifactBlobStoreOptions & { readonly now?: number; readonly maxRows?: number; readonly maxBytes?: number }): Promise<ArtifactCleanupResult> {
  const store = getAgentArtifactBlobStore(options);
  return store.cleanup(options);
}

/** Test-only helper that keeps canonical bytes immutable while exposing a digest. */
export function artifactDigest(bytes: Uint8Array | ArrayBuffer): string {
  return digestBytes(normalizeBytes(bytes));
}

/** Test-only helper for asserting a staged path remains inside the store. */
export function isArtifactPathInside(root: string, path: string): boolean {
  return isPathInside(resolve(root), resolve(path));
}
