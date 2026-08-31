// Streaming user-data import.
//
// Reads a .lvbak (ZIP) archive entry-by-entry, validates each entry, and
// applies it to the importing user's account. Database rows use
// "INSERT OR IGNORE" — re-imports of the same archive are non-destructive,
// keeping pre-existing data untouched.
//
// The import runs as a background job; the HTTP route returns a jobId and
// progress flows over the WebSocket EventBus.

import { createInflateRaw, inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  decryptSecret,
  verifyTicket,
  lookupConsumedTicket,
  TicketError,
  TICKET_ALGORITHM,
  TICKET_CLOCK_SKEW_SECONDS,
  TICKET_KIND,
  TICKET_MAX_AGE_SECONDS,
  TICKET_VERSION,
  type DecryptionTicket,
  type EncryptedSecretEntry,
} from "./secret-ticket.service";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  lstatSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import { lstat as lstatAsync, open as openAsync, unlink as unlinkAsync } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import {
  getDb,
  getDbGeneration,
  isDatabaseGenerationCancellation,
  runWithDbGeneration,
} from "../../db/connection";
import { env } from "../../env";
import { getEncryptionKeyBytes } from "../../crypto/init";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import { detectAudioFormat } from "../notification-sounds.service";
import { strictestMediaLimit, type MediaPolicy } from "../../types/media-limits";
import {
  queueChunkVectorization,
  queueWorldBookEntryVectorization,
} from "../vectorization-queue.service";
import type { CollectionName, VectorRow } from "../vector-store/types";
import { rowId } from "../vector-store/addressing";
import * as embeddingsService from "../embeddings.service";
import { trackChatChunkMaintenance } from "../chat-chunk-maintenance.service";
import { validateSafeMediaFile } from "./media-validation";
import {
  parseManifest,
  NDJSON_FORMAT_VERSION,
  NDJSON_MAX_RECORD_BYTES,
  MAX_ARCHIVE_FILE_BYTES,
  MAX_ARCHIVE_TOTAL_BYTES,
  MAX_ARCHIVE_COMPRESSED_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_TEXT_ENTRIES,
  MAX_ARCHIVE_TOTAL_ROWS,
  MAX_ARCHIVE_ROWS_PER_TABLE,
  MAX_ARCHIVE_MANIFEST_BYTES,
  MAX_ARCHIVE_SECRET_ENTRIES,
  MAX_ARCHIVE_SECRET_BYTES,
  type ArchiveEntry,
  type ArchiveFileAlias,
  type ArchiveManifest,
} from "./manifest";
import {
  ARCHIVE_REGISTRY_VERSION,
  ARCHIVE_CANONICAL_TABLES,
  getArchiveTableSpec,
  getArchiveVectorTables,
  getCanonicalImportOrder,
  buildArchiveOwnerPredicate,
  assertArchiveRegistryCoverage,
  isSecretSettingKey,
} from "./table-registry";
import { markImportedConnectionForReview } from "../connection-authority";

import { resolveArchivePathWithinRoot } from "./snapshot";
import { scrubArchiveRowPrivateData } from "./export.service";
import { sanitizeEntry, safeJoin, type SanitizedEntry } from "./sanitize";
import { scrubLegacyImageGenerationSettingRow } from "./private-data";
import {
  migrateParsedLegacyAgentConfigV1,
  parseLegacyAgentConfigV1,
  type LegacyAgentConfigV1,
} from "../../types/agents";
import {
  materializePortableSealedPresetImport,
  parsePortableSealedPresetDescriptor,
  parseSealedPresetManifest,
  type PortableSealedPresetDescriptor,
  type PortableSealedPresetResolver,
} from "../../lumihub/sealed-presets";
import {
  prepareForeignAgentConfig,
  scrubPresetMetadata,
  writePresetAgentConfigWithDb,
} from "../agent-config-portability.service";

// ---------------------------------------------------------------------------
// Tunables / safety caps
// ---------------------------------------------------------------------------

/** Reject archives whose total decompressed size exceeds this cap. */
export const MAX_DECOMPRESSED_BYTES = MAX_ARCHIVE_TOTAL_BYTES;

/** Keep a small reserve for SQLite journals and normal server operation. */
const IMPORT_DISK_HEADROOM_BYTES = 64 * 1024 * 1024;

/** Reject archives over this compressed size at upload time. */
export const MAX_COMPRESSED_BYTES = MAX_ARCHIVE_COMPRESSED_BYTES;

/**
 * ZIP32 archives and format-1 ZIP64 archives predate a trustworthy record
 * size contract. Accept their historical large rows up to the same bounded
 * ceiling enforced by the current exporter.
 */
const LEGACY_MAX_NDJSON_LINE_BYTES = NDJSON_MAX_RECORD_BYTES;

/** Read compressed archive data in fixed-size windows during extraction. */
const ARCHIVE_READ_BYTES = 64 * 1024;

/** Bound each zlib output allocation during archive extraction. */
const INFLATE_OUTPUT_BYTES = 64 * 1024;

/** Text entries are table-shaped metadata; there should never be thousands. */
const MAX_TEXT_ENTRIES = MAX_ARCHIVE_TEXT_ENTRIES;
/** Reject archives with more than this many entries. */
const MAX_ENTRIES = MAX_ARCHIVE_ENTRIES;

/** Maximum canonical rows retained in one staging database. */
export const MAX_STAGED_ROWS = MAX_ARCHIVE_TOTAL_ROWS;
const YIELD_INTERVAL_MS = 0;
export const MAX_ROWS_PER_TABLE = MAX_ARCHIVE_ROWS_PER_TABLE;
const MAX_STAGE_BYTES = MAX_ARCHIVE_TOTAL_BYTES;
/** Conservative extra SQLite pages/index/journal budget over NDJSON bytes. */
const STAGING_SQLITE_COPY_MULTIPLIER = 2;
const STAGING_SQLITE_FIXED_BYTES = 16 * 1024 * 1024;
const IMPORT_LEASE_SECONDS = 300;
/** Yield and renew the import fence at bounded byte intervals for large file I/O. */
const HASH_YIELD_BYTES = 1024 * 1024;
const COPY_HEARTBEAT_BYTES = 1024 * 1024;
const IMPORT_FILE_OPERATION_DEADLINE_MS = IMPORT_LEASE_SECONDS * 1_000;
/** Bound startup waiting for a non-expired lease before readiness fails closed. */
export const IMPORT_STARTUP_RECONCILIATION_DEADLINE_MS = 5_000;
/** Maximum import-control rows inspected by one startup reconciliation pass. */
export const MAX_IMPORT_STARTUP_RECONCILIATION_ROWS = 64;
const MAX_GLOBAL_IMPORTS = 1;
const MAX_SECRET_ENTRIES = MAX_ARCHIVE_SECRET_ENTRIES;
const MAX_SECRET_BYTES = MAX_ARCHIVE_SECRET_BYTES;
const MAX_SECRET_KEY_BYTES = 4 * 1024;

/**
 * Bound the memory retained while proving that rollback targets are not live
 * references. Overflow fails closed and leaves files for manual recovery.
 */
const MAX_LIVE_FILE_REFERENCES = 1_000_000;

/** Bound projection table-key bytes retained in durable rebuild intent. */
const MAX_VECTOR_PROJECTION_KEY_BYTES = 1 * 1024;

/** Per-table counters exposed in import status and durable receipts. */
interface ImportTableSummary {
  imported: number;
  skipped: number;
}

/**
 * Live import status keeps table counters at the top level. A committed
 * receipt is replayed with its durable envelope so idempotent retries receive
 * the exact persisted summary.
 */
type ImportProgressSummary = Record<string, ImportTableSummary> & {
  vectors?: VectorProjectionIntent;
};

interface ImportReceiptSummary {
  tables: Record<string, ImportTableSummary>;
  files: Record<string, number>;
  secrets: ImportTableSummary;
  vectors?: VectorProjectionIntent;
}

type ImportSummary = ImportProgressSummary | ImportReceiptSummary;

function requireImportProgressSummary(summary: ImportSummary): ImportProgressSummary {
  if (Object.hasOwn(summary, "tables") || Object.hasOwn(summary, "files")) {
    throw new Error("committed import summary is immutable");
  }
  return summary as ImportProgressSummary;
}

/** Apply DB rows in batches of this size. */
export type ImportJobStatus =
  | "queued"
  | "awaiting_ticket"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "cancelling"
  | "cleanup_pending";

export type ImportCancellationResult = boolean | "too_late" | "cleanup_pending";

type TicketGateResolution = "open" | "accepted" | "skipped" | "cancelled";
type TicketGateValue = { ticket: DecryptionTicket; smk: Uint8Array };
export interface ImportJob {
  jobId: string;
  userId: string;
  archiveId: string;
  status: ImportJobStatus;
  archivePath: string;
  startedAt: number;
  finishedAt: number | null;
  manifest: ArchiveManifest | null;
  /** {table: {imported, skipped}}. Updated as the job progresses. */
  summary: ImportSummary;
  fileSummary: Record<string, number>;
  /** Most recent error message if status === 'failed'. */
  error: string | null;
  /** Durable public failure code from stable_error_code, when present. */
  errorCode?: string | null;
  /** Abort controller — exposed for cancel endpoint. */
  abort: AbortController;
  ticketGate?: Promise<TicketGateValue | null>;
  ticketResolver?: (value: TicketGateValue | null) => void;
  /** Accepted ticket value held only until the worker's terminal cleanup. */
  acceptedTicket?: TicketGateValue;
  /**
   * In-memory CAS for the user-facing gate. The durable ticket ledger is the
   * global one-use authority; this state prevents duplicate submit/skip
   * requests from reopening a resolved local gate.
   */
  ticketGateState: TicketGateResolution;
  /** Authenticated user that submitted the in-memory ticket gate value. */
  ticketSubmittedBy?: string;
  archiveSecretKeys?: string[];
  ticketReused?: boolean;
  secretsRestored?: number;
  /** Identity proof captured with the upload digest so the worker does not re-hash the archive. */
  archiveIdentity?: FileIdentity;
  /** Durable idempotency identity. */
  idempotencyKey: string;
  archiveDigest: string;
  leaseOwner: string;
  leaseGeneration: number;
  stagingDbPath: string | null;
  /** Resolves only after the worker has completed rollback and terminal cleanup. */
  completion?: Promise<void>;
  /** Internal resolver for completion; never exposed over an API. */
  resolveCompletion?: () => void;
  commitStarted: boolean;
}

type ImportControlState =
  | "queued"
  | "validating"
  | "awaiting_ticket"
  | "installing"
  | "ready"
  | "committing"
  | "committed"
  | "failed"
  | "cancelled"
  | "cancelling"
  | "cleanup_pending";

export interface ImportRecoveryResult {
  readonly inspected: number;
  readonly recovered: number;
  readonly deferred: number;
  readonly failed: number;
  /** False when another bounded pass is required to settle durable work. */
  readonly complete: boolean;
  /** False when work was deferred, failed, or remains beyond this pass. */
  readonly healthy: boolean;
}

interface ImportControlRow {
  job_id: string;
  user_id: string;
  archive_id: string;
  idempotency_key: string;
  archive_digest: string;
  manifest_json: string;
  staging_path: string;
  staging_db_path: string;
  state: ImportControlState;
  lease_owner: string | null;
  lease_expires_at: number | null;
  lease_generation: number;
  projection_pending: number;
  created_at?: number;
  updated_at?: number;
  started_at?: number | null;
  finished_at?: number | null;
  stable_error_code?: string | null;
  stable_error?: string | null;
  summary_json: string | null;
}

interface ImportFileRow {
  id: number;
  job_id: string;
  user_id?: string;
  archive_path: string;
  kind: "file" | "secret" | "vector";
  staged_path: string;
  final_path: string;
  sha256: string;
  byte_count: number;
  required: number;
  install_token: string;
  staged_identity: string;
  observed_final_identity: string | null;
  omission_policy?: FileOmissionPolicy | null;
  install_state: "pending" | "preexisting" | "created" | "installed" | "removed" | "skipped";
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}
class PersistedUploadProof {
  readonly kind = "persisted-upload";
  constructor(
    readonly archivePath: string,
    readonly archiveDigest: string,
    readonly byteCount: number,
    readonly identity: FileIdentity,
  ) {}
}

function samePersistedUploadIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

export interface PersistedUploadedArchive {
  readonly path: string;
  readonly jobId: string;
  readonly archiveDigest: string;
  readonly byteCount: number;
  /** Opaque server proof consumed by startImport; never accepted from clients. */
  readonly proof: unknown;
}


interface JournaledImportFile extends ImportFileRow {
  user_id: string;
}

const TERMINAL_IMPORT_STATES = new Set<ImportControlState>([
  "committed",
  "failed",
  "cancelled",
]);



export interface ImportStagingPathV1 {
  readonly userId: string;
  readonly jobId: string;
  readonly stagingPath: string;
}

function isSafeImportPathSegment(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\");
}

/**
 * Validate the only staging path that startup reconciliation may remove.
 * Lexical equality prevents alternate/traversal spellings; the archive path
 * resolver additionally rejects a symlinked parent or staging directory that
 * escapes the registered imports root.
 */
export function isOwnedImportStagingPath(
  input: ImportStagingPathV1,
  importsRoot: string = join(env.dataDir, "imports"),
): boolean {
  if (
    !isSafeImportPathSegment(input?.userId)
    || !isSafeImportPathSegment(input?.jobId)
    || typeof input?.stagingPath !== "string"
    || typeof importsRoot !== "string"
  ) return false;
  try {
    const root = resolve(importsRoot);
    const expected = join(root, input.userId, input.jobId, "staging");
    if (input.stagingPath !== expected) return false;
    const candidate = resolve(input.stagingPath);
    try {
      if (lstatSync(candidate).isSymbolicLink()) return false;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) return false;
    }
    resolveArchivePathWithinRoot(candidate, root);
    return true;
  } catch {
    return false;
  }
}
/**
 * Delete only the archive created by this upload reservation. Receipt replay
 * must not leave the newly uploaded duplicate on disk, but must never accept
 * an arbitrary caller-supplied path for deletion.
 */
function removeOwnedImportArchive(userId: string, jobId: string, archivePath: string): boolean {
  if (
    !isSafeImportPathSegment(userId)
    || !isSafeImportPathSegment(jobId)
    || typeof archivePath !== "string"
  ) return false;
  let root: string;
  try {
    root = resolve(join(env.dataDir, "imports"));
  } catch {
    return false;
  }
  const expectedArchive = join(root, userId, jobId, "archive.lvbak");
  const expectedStaging = join(root, userId, jobId, "staging");
  try {
    resolveArchivePathWithinRoot(expectedArchive, root);
  } catch {
    return false;
  }

  const readPath = (path: string): "present" | "absent" | "error" => {
    try {
      lstatSync(path);
      return "present";
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return "absent";
      return "error";
    }
  };

  const archiveState = readPath(expectedArchive);
  const stagingState = readPath(expectedStaging);
  if (archiveState === "error" || stagingState === "error") return false;
  if (stagingState === "present" && !isOwnedImportStagingPath({
    userId,
    jobId,
    stagingPath: expectedStaging,
  }, root)) return false;

  // The caller-supplied archivePath is never itself deleted: a legitimate
  // same-digest retry may retain a synthetic/recovery location outside this
  // job's owned upload tree, and an arbitrary caller path must never broaden
  // deletion. Cleanup stays confined to the canonical owned paths below so
  // receipt replay cannot strand the newly uploaded duplicate while the
  // replayed summary is still returned.
  if (archiveState === "present") {
    try {
      if (lstatSync(expectedArchive).isSymbolicLink()) return false;
      unlinkSync(expectedArchive);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") return false;
    }
  }
  if (stagingState === "present") {
    try {
      rmSync(expectedStaging, { recursive: true, force: true });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") return false;
    }
  }
  return true;
}

function ownedImportArchivePath(userId: string, jobId: string): string {
  return join(env.dataDir, "imports", userId, jobId, "archive.lvbak");
}

function cleanupOwnedImportArchive(row: ImportControlRow): boolean {
  if (
    row.staging_path !== ""
    && !isOwnedImportStagingPath({
      userId: row.user_id,
      jobId: row.job_id,
      stagingPath: row.staging_path,
    })
  ) return false;
  return removeOwnedImportArchive(row.user_id, row.job_id, ownedImportArchivePath(row.user_id, row.job_id));
}

function cleanupTerminalImportStaging(
  job: ImportJob,
  expectedState: Extract<ImportControlState, "committed" | "failed" | "cancelled">,
  db: Database = getDb(),
): boolean {
  let removed = false;
  db.transaction(() => {
    const current = readImportControl(job.jobId, db);
    if (
      !current
      || current.lease_owner !== job.leaseOwner
      || current.lease_generation !== job.leaseGeneration
      || current.state !== expectedState
    ) return;
    if (!cleanupOwnedImportArchive(current)) return;
    const cleared = db.query(
      `UPDATE user_data_imports
          SET staging_path = '', staging_db_path = '', updated_at = ?
        WHERE job_id = ? AND lease_owner = ? AND lease_generation = ? AND state = ?`,
    ).run(nowSeconds(), job.jobId, job.leaseOwner, job.leaseGeneration, expectedState);
    removed = cleared.changes === 1;
  })();
  return removed;
}

function markImportManualRecovery(db: Database, row: ImportControlRow): void {
  try {
    db.query(
      `UPDATE user_data_imports
          SET stable_error_code = 'manual_recovery_required',
              stable_error = 'startup left an untrusted staging path for manual recovery',
              updated_at = ?
        WHERE job_id = ?`,
    ).run(nowSeconds(), row.job_id);
  } catch {
    // The durable state remains authoritative even if this diagnostic update
    // cannot be recorded; startup must never broaden filesystem deletion.
  }
  const jobLabel = row.job_id.replace(/[^\x20-\x7e]/gi, "?").slice(0, 256);
  console.warn(`[startup] Import staging cleanup skipped; manual recovery required for job ${jobLabel}`);
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function readImportControl(jobId: string, db: Database = getDb()): ImportControlRow | null {
  return db.query("SELECT * FROM user_data_imports WHERE job_id = ?").get(jobId) as ImportControlRow | null;
}

function assertCurrentFence(job: ImportJob, db: Database = getDb()): void {
  const row = readImportControl(job.jobId, db);
  const now = nowSeconds();
  if (
    !row
    || row.lease_owner !== job.leaseOwner
    || row.lease_generation !== job.leaseGeneration
    || (row.lease_expires_at !== null && row.lease_expires_at <= now)
    || row.state === "failed"
    || row.state === "cancelled"
    || row.state === "cleanup_pending"
  ) {
    throw new Error("import lease fence lost");
  }
}

function renewImportLease(job: ImportJob, db: Database = getDb()): void {
  const now = nowSeconds();
  const result = db.query(
    `UPDATE user_data_imports
       SET lease_expires_at = ?, updated_at = ?
     WHERE job_id = ? AND lease_owner = ? AND lease_generation = ?
       AND (lease_expires_at IS NULL OR lease_expires_at > ?)
       AND state NOT IN ('failed','cancelled','cleanup_pending')`,
  ).run(now + IMPORT_LEASE_SECONDS, now, job.jobId, job.leaseOwner, job.leaseGeneration, now);
  if (result.changes !== 1) throw new Error("import lease fence lost");
}
const IMPORT_LEASE_HEARTBEAT_MS = Math.max(1_000, Math.floor((IMPORT_LEASE_SECONDS * 1_000) / 3));

/**
 * Keep validation and the ticket gate fenced. A valid ticket can wait longer
 * than the lease duration, but a stopped heartbeat must abort rather than
 * allowing a stale owner to reach COMMITTING.
 */
function startImportLeaseHeartbeat(job: ImportJob): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    const controlState = readImportControl(job.jobId)?.state;
    if (stopped || job.commitStarted || (controlState && TERMINAL_IMPORT_STATES.has(controlState))) {
      return;
    }
    try {
      renewImportLease(job);
      assertCurrentFence(job);
    } catch {
      if (!job.abort.signal.aborted) job.abort.abort(new Error("import lease fence lost"));
    }
  }, IMPORT_LEASE_HEARTBEAT_MS);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function transitionImport(
  job: ImportJob,
  next: ImportControlState,
  allowed: readonly ImportControlState[],
  db: Database = getDb(),
): void {
  const now = nowSeconds();
  const result = db.query(
    `UPDATE user_data_imports
        SET state = ?, updated_at = ?, started_at = CASE WHEN ? = 'validating' THEN COALESCE(started_at, ?) ELSE started_at END,
            finished_at = CASE WHEN ? IN ('committed','failed','cancelled') THEN COALESCE(finished_at, ?) ELSE finished_at END
      WHERE job_id = ? AND lease_owner = ? AND lease_generation = ?
        AND (lease_expires_at IS NULL OR lease_expires_at > ?)
        AND state IN (${allowed.map(() => "?").join(",")})`,
  ).run(
    next,
    now,
    next,
    now,
    next,
    now,
    job.jobId,
    job.leaseOwner,
    job.leaseGeneration,
    now,
    ...allowed,
  );
  if (result.changes !== 1) throw new Error("import lease fence lost");
}
function beginImportCommit(job: ImportJob, db: Database): void {
  if (job.abort.signal.aborted) throw job.abort.signal.reason ?? new Error("import cancelled");
  const now = nowSeconds();
  const result = db.query(
    `UPDATE user_data_imports
        SET state = 'committing', lease_expires_at = ?, updated_at = ?
      WHERE job_id = ? AND lease_owner = ? AND lease_generation = ?
        AND (lease_expires_at IS NULL OR lease_expires_at > ?)
        AND state IN ('installing','ready')`,
  ).run(
    now + IMPORT_LEASE_SECONDS,
    now,
    job.jobId,
    job.leaseOwner,
    job.leaseGeneration,
    now,
  );
  if (result.changes !== 1) throw new Error("import lease fence lost");
  job.commitStarted = true;
}
function setImportError(job: ImportJob, code: string, message: string): void {
  const db = getDb();
  const now = nowSeconds();
  db.query(
    `UPDATE user_data_imports
        SET state = 'failed', stable_error_code = ?, stable_error = ?, updated_at = ?, finished_at = ?
      WHERE job_id = ? AND lease_owner = ? AND lease_generation = ?
        AND (lease_expires_at IS NULL OR lease_expires_at > ?)`,
  ).run(code, message.slice(0, 4096), now, now, job.jobId, job.leaseOwner, job.leaseGeneration, now);
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${sortedJson(child)}`)
    .join(",")}}`;
}
function stableLegacyArchiveIdentity(archiveDigest: string): string {
  return `legacy-v1:${createHash("sha256")
    .update(`lumiverse:lvbak:v1:${archiveDigest}`, "utf8")
    .digest("hex")}`;
}


const JOBS: Map<string, ImportJob> = new Map();
const USER_RUNNING: Map<string, string> = new Map(); // userId -> jobId
const USER_UPLOAD_RESERVATIONS: Map<string, string> = new Map();
let globalImportSlot: string | null = null;

/** Terminal projections stay addressable briefly for polling, while durable
 * control rows and receipts remain the long-lived idempotency authority. */
export const IMPORT_JOB_MEMORY_RETENTION_SECONDS = 15 * 60;

function statusFromImportControl(state: ImportControlState): ImportJobStatus {
  switch (state) {
    case "queued": return "queued";
    case "awaiting_ticket": return "awaiting_ticket";
    case "committed": return "complete";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "cancelling":
    case "cleanup_pending": return "cleanup_pending";
    default: return "running";
  }
}

const DURABLE_ARCHIVE_IDENTITY_FIELD = "__archiveIdentity";

function serializeDurableManifest(
  manifest: ArchiveManifest | null,
  archiveIdentity?: FileIdentity,
): string {
  const value: Record<string, unknown> = manifest && typeof manifest === "object"
    ? { ...(manifest as unknown as Record<string, unknown>) }
    : {};
  if (archiveIdentity) value[DURABLE_ARCHIVE_IDENTITY_FIELD] = archiveIdentity;
  return JSON.stringify(value);
}

function hydrateDurableImportJob(row: ImportControlRow, db: Database): ImportJob {
  const receiptRow = db.query(
    "SELECT summary_json FROM user_data_import_receipts WHERE job_id = ?",
  ).get(row.job_id) as { summary_json?: string } | null;
  const summaryText = receiptRow?.summary_json || row.summary_json;
  let summary: ImportSummary = {};
  let fileSummary: Record<string, number> = {};
  if (summaryText) {
    try {
      const parsed = parseImportSummary(summaryText) as ImportReceiptSummary;
      ({ summary, fileSummary } = publicImportSummaries(parsed));
    } catch {
      // A malformed historical summary must not make the status endpoint fail.
      // The durable state remains useful for recovery without exposing the
      // internal receipt envelope.
    }
  }
  let manifest: ArchiveManifest | null = null;
  let archiveIdentity: FileIdentity | undefined;
  try {
    const parsed = JSON.parse(row.manifest_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const durable = parsed as Record<string, unknown>;
      const encodedIdentity = durable[DURABLE_ARCHIVE_IDENTITY_FIELD];
      if (encodedIdentity !== undefined) {
        const decoded = parseFileIdentity(JSON.stringify(encodedIdentity));
        if (decoded) archiveIdentity = decoded;
        delete durable[DURABLE_ARCHIVE_IDENTITY_FIELD];
      }
      manifest = durable as unknown as ArchiveManifest;
    }
  } catch {
    // A validating/failed row may legitimately have only the "{}" placeholder.
  }
  return {
    jobId: row.job_id,
    userId: row.user_id,
    archiveId: row.archive_id,
    status: statusFromImportControl(row.state),
    archivePath: row.staging_path ? join(dirname(row.staging_path), "archive.lvbak") : "",
    startedAt: row.started_at ?? row.created_at ?? 0,
    finishedAt: row.finished_at ?? null,
    manifest,
    summary,
    fileSummary,
    error: row.state === "failed" && row.stable_error ? "import failed" : null,
    errorCode: row.stable_error_code ?? null,
    abort: new AbortController(),
    ticketGateState: "open",
    idempotencyKey: row.idempotency_key,
    archiveDigest: row.archive_digest,
    archiveIdentity,
    leaseOwner: row.lease_owner || `recovered:${row.job_id}`,
    leaseGeneration: row.lease_generation,
    stagingDbPath: row.staging_db_path || null,
    commitStarted: row.state === "committing" || row.state === "committed",
  };
}

export function pruneTerminalImportJobs(now = nowSeconds()): number {
  let removed = 0;
  for (const [jobId, job] of JOBS) {
    if (
      (job.status === "complete" || job.status === "failed" || job.status === "cancelled")
      && job.finishedAt !== null
      && job.finishedAt + IMPORT_JOB_MEMORY_RETENTION_SECONDS <= now
    ) {
      zeroizeTicketValue(job.acceptedTicket);
      job.acceptedTicket = undefined;
      clearTicketGate(job);
      releaseJobAdmission(job);
      JOBS.delete(jobId);
      removed++;
    }
  }
  return removed;
}

const importJobCleanupTimer = setInterval(
  () => pruneTerminalImportJobs(),
  Math.max(1_000, Math.floor(IMPORT_JOB_MEMORY_RETENTION_SECONDS * 1_000 / 2)),
);
if (typeof (importJobCleanupTimer as { unref?: () => void }).unref === "function") {
  (importJobCleanupTimer as { unref: () => void }).unref();
}

function releaseJobAdmission(job: ImportJob): void {
  if (USER_RUNNING.get(job.userId) === job.jobId) USER_RUNNING.delete(job.userId);
  if (USER_UPLOAD_RESERVATIONS.get(job.userId) === job.jobId) USER_UPLOAD_RESERVATIONS.delete(job.userId);
  releaseGlobalImportSlot(job.jobId);
}

export function getJob(jobId: string): ImportJob | undefined {
  pruneTerminalImportJobs();
  const inMemory = JOBS.get(jobId);
  if (inMemory) return inMemory;
  try {
    const row = readImportControl(jobId);
    return row ? hydrateDurableImportJob(row, getDb()) : undefined;

  } catch {
    return undefined;
  }
}

function parkImportForTicket(job: ImportJob, db: Database = getDb()): void {
  const now = nowSeconds();
  const parked = db.query(
    `UPDATE user_data_imports
        SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE job_id = ? AND lease_owner = ? AND lease_generation = ?
        AND state = 'awaiting_ticket'
        AND (lease_expires_at IS NULL OR lease_expires_at > ?)`,
  ).run(now, job.jobId, job.leaseOwner, job.leaseGeneration, now);
  if (parked.changes !== 1) throw new Error("import lease fence lost");
  releaseJobAdmission(job);
}

/** Clear a parked lease after a failed post-reacquisition assertion. */
function clearParkedImportLeaseAfterFailure(job: ImportJob, db: Database = getDb()): boolean {
  const cleared = db.query(
    `UPDATE user_data_imports
        SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE job_id = ? AND lease_owner = ? AND lease_generation = ?
        AND state = 'awaiting_ticket'`,
  ).run(nowSeconds(), job.jobId, job.leaseOwner, job.leaseGeneration);
  return cleared.changes === 1;
}

function reacquireParkedImport(job: ImportJob, db: Database = getDb()): void {
  pruneTerminalImportJobs();
  if (globalImportSlot !== null && globalImportSlot !== job.jobId) {
    throw new Error("global import capacity exhausted");
  }
  const now = nowSeconds();
  const leaseOwner = `job:${crypto.randomUUID()}`;
  const leaseGeneration = job.leaseGeneration + 1;
  db.transaction(() => {
    const active = db.query(
      `SELECT COUNT(*) AS count FROM user_data_imports
        WHERE job_id <> ?
          AND (
            state NOT IN ('committed','failed','cancelled','awaiting_ticket')
            OR (
              state = 'awaiting_ticket'
              AND lease_owner IS NOT NULL
              AND (lease_expires_at IS NULL OR lease_expires_at > ?)
            )
          )`,
    ).get(job.jobId, now) as { count: number };
    if (active.count >= MAX_GLOBAL_IMPORTS) throw new Error("global import capacity exhausted");
    const userActive = db.query(
      `SELECT COUNT(*) AS count FROM user_data_imports
        WHERE user_id = ? AND job_id <> ?
          AND (
            state NOT IN ('committed','failed','cancelled','awaiting_ticket')
            OR (
              state = 'awaiting_ticket'
              AND lease_owner IS NOT NULL
              AND (lease_expires_at IS NULL OR lease_expires_at > ?)
            )
          )`,
    ).get(job.userId, job.jobId, now) as { count: number };
    if (userActive.count > 0) throw new Error("an import is already running for this user");
    const reacquired = db.query(
      `UPDATE user_data_imports
          SET lease_owner = ?, lease_generation = ?, lease_expires_at = ?, updated_at = ?
        WHERE job_id = ? AND user_id = ? AND lease_owner IS NULL
          AND lease_expires_at IS NULL AND state = 'awaiting_ticket'`,
    ).run(leaseOwner, leaseGeneration, now + IMPORT_LEASE_SECONDS, now, job.jobId, job.userId);
    if (reacquired.changes !== 1) throw new Error("import lease fence lost");
  })();
  job.leaseOwner = leaseOwner;
  job.leaseGeneration = leaseGeneration;
  USER_RUNNING.set(job.userId, job.jobId);
  globalImportSlot = job.jobId;
}

export function listJobsForUser(userId: string): ImportJob[] {
  pruneTerminalImportJobs();
  return [...JOBS.values()].filter((j) => j.userId === userId);
}

export function isUserImportRunning(userId: string): boolean {
  pruneTerminalImportJobs();
  if (USER_RUNNING.has(userId) || USER_UPLOAD_RESERVATIONS.has(userId)) return true;
  try {
    const row = getDb().query(
      `SELECT 1 AS active
         FROM user_data_imports
        WHERE user_id = ?
          AND (
            state NOT IN ('committed','failed','cancelled','awaiting_ticket')
            OR (
              state = 'awaiting_ticket'
              AND lease_owner IS NOT NULL
              AND (lease_expires_at IS NULL OR lease_expires_at > ?)
            )
          )
        LIMIT 1`,
    ).get(userId, nowSeconds()) as { active: number } | null;
    return !!row;
  } catch {
    return false;
  }
}
/**
 * Reserve the single import lifecycle slot before the request body is read.
 * Without this, async handlers can both pass a status check and stage
 * multi-gigabyte archives concurrently before either one creates a job.
 */
export function reserveImportUpload(userId: string): string | null {
  const db = getDb();
  if (isUserImportRunning(userId) || globalImportSlot !== null) return null;
  const jobId = crypto.randomUUID();
  const owner = `upload:${crypto.randomUUID()}`;
  const now = nowSeconds();
  try {
    db.transaction(() => {
      const active = db.query(
        `SELECT COUNT(*) AS count
           FROM user_data_imports
          WHERE (
            state NOT IN ('committed','failed','cancelled','awaiting_ticket')
            OR (
              state = 'awaiting_ticket'
              AND lease_owner IS NOT NULL
              AND (lease_expires_at IS NULL OR lease_expires_at > ?)
            )
          )`,
      ).get(now) as { count: number };
      if (active.count >= MAX_GLOBAL_IMPORTS) throw new Error("global import capacity exhausted");
      db.query(
        `INSERT INTO user_data_imports
          (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
           staging_path,staging_db_path,state,lease_owner,lease_expires_at,
           lease_generation,created_at,updated_at)
         VALUES (?,? ,?, ?, ?, '{}', ?, ?, 'queued', ?, ?, 0, ?, ?)`,
      ).run(
        jobId,
        userId,
        `pending:${jobId}`,
        jobId,
        "0".repeat(64),
        join(env.dataDir, "imports", userId, jobId, "staging"),
        join(env.dataDir, "imports", userId, jobId, "staging", "staging.sqlite"),
        owner,
        now + IMPORT_LEASE_SECONDS,
        now,
        now,
        );
    })();
  } catch {
    return null;
  }
  USER_UPLOAD_RESERVATIONS.set(userId, jobId);
  globalImportSlot = jobId;
  return jobId;
}

export function releaseImportUpload(userId: string, jobId: string): void {
  if (USER_UPLOAD_RESERVATIONS.get(userId) === jobId) USER_UPLOAD_RESERVATIONS.delete(userId);
  if (globalImportSlot === jobId) globalImportSlot = null;
  try {
    const db = getDb();
    db.query("DELETE FROM user_data_imports WHERE job_id = ? AND state = 'queued'").run(jobId);
  } catch {
    /* The upload route still removes its archive; reconciliation handles a retained row. */
  }
}

/** Transfer a successful upload reservation into its background job. */
function claimImportReservation(userId: string, jobId: string): void {
  if (USER_UPLOAD_RESERVATIONS.get(userId) === jobId) USER_UPLOAD_RESERVATIONS.delete(userId);
}

function releaseGlobalImportSlot(jobId: string): void {
  if (globalImportSlot === jobId) globalImportSlot = null;
}

function cancellationDeadlineAt(control: ImportControlRow | null): number {
  const operationDeadline = Date.now() + IMPORT_FILE_OPERATION_DEADLINE_MS;
  const leaseDeadline = control?.lease_expires_at;
  if (leaseDeadline === null || leaseDeadline === undefined || !Number.isFinite(leaseDeadline)) {
    return operationDeadline;
  }
  return Math.min(operationDeadline, leaseDeadline * 1_000);
}

async function waitForImportCompletion(job: ImportJob, deadlineAt: number): Promise<boolean> {
  const completion = job.completion;
  if (!completion) return true;
  const remaining = deadlineAt - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return false;
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), remaining);
  });
  const completed = await Promise.race([
    completion.then(() => true),
    timeout,
  ]);
  clearTimeout(timer);
  return completed;
}
function cancellationCompletionResult(job: ImportJob): ImportCancellationResult {
  if (job.status === "cancelled") return true;
  if (job.status === "complete") return "too_late";
  const state = readImportControl(job.jobId)?.state;
  if (state === "committing" || state === "committed") return "too_late";
  return "cleanup_pending";
}

function persistCancellationPending(
  job: ImportJob,
  db: Database = getDb(),
): void {
  db.query(
    `UPDATE user_data_imports
        SET state = 'cleanup_pending', stable_error_code = 'cleanup_pending',
            stable_error = 'import cancellation cleanup is pending', updated_at = ?, finished_at = NULL
      WHERE job_id = ? AND user_id = ? AND lease_owner = ? AND lease_generation = ?
        AND state IN ('cancelling','cleanup_pending')`,
  ).run(nowSeconds(), job.jobId, job.userId, job.leaseOwner, job.leaseGeneration);
  job.status = "cleanup_pending";
  job.finishedAt = null;
}

export async function cancelJob(jobId: string): Promise<ImportCancellationResult> {
  const job = getJob(jobId);
  if (!job) return false;
  let control = readImportControl(jobId);
  if (job.commitStarted || control?.state === "committing" || control?.state === "committed") {
    return "too_late";
  }
  if (control?.state === "cleanup_pending" || job.status === "cleanup_pending") {
    return "cleanup_pending";
  }
  if (control?.state === "cancelling" || job.status === "cancelling") {
    const completed = await waitForImportCompletion(job, cancellationDeadlineAt(control));
    if (!completed) {
      persistCancellationPending(job);
      releaseJobAdmission(job);
      return "cleanup_pending";
    }
    return cancellationCompletionResult(job);
  }
  if (job.status !== "running" && job.status !== "queued" && job.status !== "awaiting_ticket") return false;
  const now = nowSeconds();
  const db = getDb();
  const ownerlessParked = control?.state === "awaiting_ticket" && control.lease_owner === null;
  let cancellationOwner = job.leaseOwner;
  let cancellationGeneration = job.leaseGeneration;
  if (ownerlessParked) {
    // A restarted parked gate has no worker to perform its finally block.
    // Acquire a fresh fence before changing state so cleanup and a concurrent
    // ticket action cannot race on an ownerless row.
    cancellationOwner = `cancel:${crypto.randomUUID()}`;
    cancellationGeneration = job.leaseGeneration + 1;
    const acquired = db.query(
      `UPDATE user_data_imports
          SET lease_owner = ?, lease_generation = ?, lease_expires_at = ?, updated_at = ?
        WHERE job_id = ? AND user_id = ? AND lease_owner IS NULL
          AND lease_expires_at IS NULL AND lease_generation = ? AND state = 'awaiting_ticket'`,
    ).run(
      cancellationOwner,
      cancellationGeneration,
      now + IMPORT_LEASE_SECONDS,
      now,
      job.jobId,
      job.userId,
      job.leaseGeneration,
    );
    if (acquired.changes !== 1) {
      const state = readImportControl(jobId)?.state;
      return state === "committing" || state === "committed" ? "too_late" : state === "cleanup_pending" ? "cleanup_pending" : false;
    }
    job.leaseOwner = cancellationOwner;
    job.leaseGeneration = cancellationGeneration;
    control = readImportControl(jobId);
  }
  const cancelling = db.query(
    `UPDATE user_data_imports
        SET state = 'cancelling', stable_error_code = 'cancelling',
            stable_error = 'import cancellation is in progress', updated_at = ?, finished_at = NULL
      WHERE job_id = ? AND user_id = ? AND lease_owner = ? AND lease_generation = ?
        AND (lease_expires_at IS NULL OR lease_expires_at > ?)
        AND state IN ('queued','validating','awaiting_ticket','installing','ready')`,
  ).run(
    now,
    job.jobId,
    job.userId,
    cancellationOwner,
    cancellationGeneration,
    now,
  );
  if (cancelling.changes !== 1) {
    const state = readImportControl(jobId)?.state;
    return state === "committing" || state === "committed"
      ? "too_late"
      : state === "cleanup_pending" || state === "cancelling"
        ? "cleanup_pending"
        : false;
  }
  // Public status remains nonterminal while the worker owns rollback.
  job.status = "cleanup_pending";
  clearTicketGate(job);
  try {
    job.abort.abort(new Error("import cancelled"));
  } catch {
    /* ignore */
  }

  if (!ownerlessParked && JOBS.has(jobId) && job.completion) {
    const completed = await waitForImportCompletion(job, cancellationDeadlineAt(control));
    if (!completed) {
      persistCancellationPending(job, db);
      releaseJobAdmission(job);
      return "cleanup_pending";
    }
    releaseJobAdmission(job);
    return cancellationCompletionResult(job);
  }

  // Hydrated jobs have no worker finally block. Roll back only creator-proven
  // files, then remove only the owned staging tree; an incomplete proof leaves
  // a durable retry/manual-recovery state for startup reconciliation.
  let rollbackSettled = true;
  try {
    await rollbackCreatedFiles(job.jobId, {
      leaseOwner: cancellationOwner,
      leaseGeneration: cancellationGeneration,
    });
  } catch {
    rollbackSettled = false;
  }
  let unsettled = true;
  try {
    unsettled = hasUnsettledFileJournal(job.jobId, db);
  } catch {
    unsettled = true;
  }
  if (!rollbackSettled || unsettled) {
    persistCancellationPending(job, db);
    releaseJobAdmission(job);
    return "cleanup_pending";
  }
  const settled = db.query(
    `UPDATE user_data_imports SET state = 'cancelled', stable_error_code = 'cancelled',
        stable_error = 'import cancelled by user', updated_at = ?, finished_at = ?
      WHERE job_id = ? AND user_id = ? AND lease_owner = ? AND lease_generation = ?
        AND state = 'cancelling'`,
  ).run(nowSeconds(), nowSeconds(), job.jobId, job.userId, cancellationOwner, cancellationGeneration);
  if (settled.changes !== 1) {
    control = readImportControl(jobId);
    if (control?.state === "cleanup_pending") {
      job.status = "cleanup_pending";
      releaseJobAdmission(job);
      return "cleanup_pending";
    }
    return "too_late";
  }
  job.status = "cancelled";
  job.finishedAt = nowSeconds();
  const current = readImportControl(job.jobId, db);
  const stagingNeeded = Boolean(current?.staging_path || current?.staging_db_path);
  if (stagingNeeded && !cleanupTerminalImportStaging(job, "cancelled", db)) {
    persistCancellationPending(job, db);
    releaseJobAdmission(job);
    return "cleanup_pending";
  }
  releaseJobAdmission(job);
  return true;
}

/**
 * Owner-scoped cancellation result for HTTP callers. Cancellation is awaited
 * through creator-proof filesystem cleanup before this result is returned, so
 * callers never observe a terminal response while cleanup is still running.
 */
export type ImportCancellationStatus = "cancelled" | "cleanup_pending" | "too_late" | "not_found";

export async function cancelImportForUser(userId: string, jobId: string): Promise<ImportCancellationStatus> {
  const job = getJob(jobId);
  if (!job || job.userId !== userId) return "not_found";
  const result = await cancelJob(jobId);
  if (result === "too_late") return "too_late";
  if (result === "cleanup_pending") return "cleanup_pending";
  if (result === true) return "cancelled";
  return "too_late";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Errors thrown while staging or verifying an uploaded archive. The HTTP
 * route maps these onto specific 4xx codes (415 for the wrong format, 422
 * for a wrong/incompatible manifest, 413 for size).
 */
export class ArchiveValidationError extends Error {
  constructor(
    public code: "not_zip" | "size" | "no_manifest" | "bad_manifest" | "upload_timeout" | "upload_aborted",
    message: string,
  ) {
    super(message);
    this.name = "ArchiveValidationError";
  }
}

export class ArchiveIdempotencyError extends Error {
  readonly code = "archive_identity_mismatch" as const;

  constructor() {
    super("archive identity does not match the existing import receipt");
    this.name = "ArchiveIdempotencyError";
  }
}

/** ZIP local-file-header magic: "PK\x03\x04" — every valid ZIP starts here. */
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

function startsWithZipMagic(prefix: Uint8Array): boolean {
  if (prefix.byteLength < 4) return false;
  return (
    prefix[0] === ZIP_MAGIC[0] &&
    prefix[1] === ZIP_MAGIC[1] &&
    prefix[2] === ZIP_MAGIC[2] &&
    prefix[3] === ZIP_MAGIC[3]
  );
}

export const MAX_IMPORT_UPLOAD_WALL_MS = 30 * 60 * 1000;
export const MAX_IMPORT_UPLOAD_IDLE_MS = 30 * 1000;

export interface PersistUploadedArchiveOptions {
  /** The request's abort signal. */
  signal?: AbortSignal;
  /**
   * Host-computed absolute wall deadline. Values above the host ceiling are
   * clamped; tests may provide a shorter deadline.
   */
  wallDeadlineAt?: number;
  /**
   * Host-computed idle deadline. Values above the host ceiling are clamped;
   * tests may provide a shorter deadline.
   */
  idleDeadlineMs?: number;
}

type UploadAbortCode = "upload_timeout" | "upload_aborted";

function uploadFailure(code: UploadAbortCode): ArchiveValidationError {
  return new ArchiveValidationError(
    code,
    code === "upload_timeout" ? "archive upload timed out" : "archive upload was cancelled",
  );
}

function uploadDeadline(
  options: PersistUploadedArchiveOptions | undefined,
): { signal?: AbortSignal; wallDeadlineAt: number; idleDeadlineMs: number } {
  const startedAt = Date.now();
  const maxWallDeadline = startedAt + MAX_IMPORT_UPLOAD_WALL_MS;
  const requestedWall = Number.isFinite(options?.wallDeadlineAt)
    ? Number(options?.wallDeadlineAt)
    : maxWallDeadline;
  const wallDeadlineAt = Math.min(maxWallDeadline, requestedWall);
  const requestedIdle = Number.isFinite(options?.idleDeadlineMs)
    ? Number(options?.idleDeadlineMs)
    : MAX_IMPORT_UPLOAD_IDLE_MS;
  const idleDeadlineMs = Math.max(1, Math.min(MAX_IMPORT_UPLOAD_IDLE_MS, requestedIdle));
  return { signal: options?.signal, wallDeadlineAt, idleDeadlineMs };
}

/**
 * Exactly what this runtime's reader yields. Deriving it from the reader keeps
 * the timeout wrapper assignable across lib variants, where a done result may
 * carry an optional rather than a required `undefined` value.
 */
type UploadReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

async function readUploadChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  control: { signal?: AbortSignal; wallDeadlineAt: number; idleDeadlineMs: number },
): Promise<UploadReadResult> {
  if (control.signal?.aborted) throw uploadFailure("upload_aborted");
  const remainingWall = control.wallDeadlineAt - Date.now();
  if (remainingWall <= 0) throw uploadFailure("upload_timeout");

  const readPromise = reader.read();
  // A timeout or abort may win the race and cancel this read later.
  readPromise.catch(() => {});
  return new Promise<UploadReadResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      control.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(uploadFailure("upload_aborted"));
    };
    const timeoutMs = Math.max(1, Math.min(control.idleDeadlineMs, remainingWall));
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(uploadFailure("upload_timeout"));
    }, timeoutMs);
    control.signal?.addEventListener("abort", onAbort, { once: true });
    if (control.signal?.aborted) {
      onAbort();
      return;
    }
    readPromise.then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (Date.now() >= control.wallDeadlineAt) {
          reject(uploadFailure("upload_timeout"));
        } else {
          resolve(result);
        }
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Stream an HTTP request body into a temp archive under the user's import
 * directory, returning the archive path. Each request chunk is synchronously
 * committed before the next is read, so slow storage cannot turn Bun's file
 * writer into an unbounded native queue. The first 4 bytes are inspected
 * mid-stream — anything that isn't a ZIP is rejected and the partial file is
 * deleted before any further bytes are committed.
 */
export async function persistUploadedArchive(
  userId: string,
  body: ReadableStream<Uint8Array>,
  declaredSize: number | null,
  jobId: string = crypto.randomUUID(),
  options?: PersistUploadedArchiveOptions,
): Promise<PersistedUploadedArchive> {
  const control = uploadDeadline(options);
  if (control.signal?.aborted) throw uploadFailure("upload_aborted");
  if (Date.now() >= control.wallDeadlineAt) throw uploadFailure("upload_timeout");
  if (declaredSize !== null && declaredSize > MAX_COMPRESSED_BYTES) {
    throw new ArchiveValidationError(
      "size",
      `archive exceeds ${MAX_COMPRESSED_BYTES / (1024 * 1024 * 1024)} GB cap`,
    );
  }
  const dir = join(env.dataDir, "imports", userId, jobId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "archive.lvbak");

  // Avoid Bun.FileSink for this failure-sensitive path. A synchronous fd
  // write provides backpressure at the request-reader boundary and has no
  // intermediate runtime-owned queue to grow under slow Android storage.
  let fd = -1;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let fdClosed = false;
  const closeFd = (ignoreError = false) => {
    if (fdClosed || fd < 0) return;
    fdClosed = true;
    try {
      closeSync(fd);
    } catch (err) {
      if (!ignoreError) throw err;
    }
  };
  const cleanup = () => {
    // Cleanup runs while another validation/write error is already in flight;
    // don't replace that useful error with a secondary close failure.
    closeFd(true);
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  };

  try {
    fd = openSync(path, "w");
    reader = body.getReader();
    const header = new Uint8Array(4);
    let headerBytes = 0;
    let magicChecked = false;
    let total = 0;

    const assertUploadOpen = () => {
      if (control.signal?.aborted) throw uploadFailure("upload_aborted");
      if (Date.now() >= control.wallDeadlineAt) throw uploadFailure("upload_timeout");
    };
    const writeChunk = (chunk: Uint8Array) => {
      assertUploadOpen();
      if (chunk.byteLength === 0) return;
      if (total + chunk.byteLength > MAX_COMPRESSED_BYTES) {
        throw new ArchiveValidationError(
          "size",
          `archive exceeds compressed size cap (${total + chunk.byteLength} bytes)`,
        );
      }
      writeAllSync(fd, chunk);
      total += chunk.byteLength;
    };

    while (true) {
      const { value, done } = await readUploadChunk(reader, control);
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      // Accumulate only the four magic bytes. The previous implementation
      // copied the *entire* first stream chunk into a new Uint8Array; some Bun
      // builds can deliver a very large first chunk for a known-length body,
      // temporarily doubling an already-large archive in memory.
      if (!magicChecked) {
        const take = Math.min(4 - headerBytes, value.byteLength);
        header.set(value.subarray(0, take), headerBytes);
        headerBytes += take;
        if (headerBytes < 4) continue;

        if (!startsWithZipMagic(header)) {
          throw new ArchiveValidationError(
            "not_zip",
            "Uploaded file is not a ZIP archive (missing PK\\x03\\x04 header).",
          );
        }

        magicChecked = true;
        writeChunk(header);
        writeChunk(value.subarray(take));
        continue;
      }

      writeChunk(value);
    }

    // Body ended before we had 4 bytes — treat as invalid.
    if (!magicChecked) {
      throw new ArchiveValidationError("not_zip", "Upload is empty or shorter than a ZIP header.");
    }

    assertUploadOpen();
    closeFd();
  } catch (err) {
    // Stop accepting network data immediately on validation/write/abort
    // failure, then remove the partial archive after its fd has actually
    // closed. Abort/timeout errors are normalized so callers never expose a
    // request stream's path or platform-specific exception.
    const normalized = control.signal?.aborted
      ? uploadFailure("upload_aborted")
      : err instanceof ArchiveValidationError
        ? err
        : Date.now() >= control.wallDeadlineAt
          ? uploadFailure("upload_timeout")
          : err;
    try {
      const cancellation = reader?.cancel(normalized);
      cancellation?.catch(() => {});
    } catch {
      /* ignore */
    }
    cleanup();
    throw normalized;
  } finally {
    try {
      reader?.releaseLock();
    } catch {
      /* ignore */
    }
  }

  if (control.signal?.aborted) {
    cleanup();
    throw uploadFailure("upload_aborted");
  }
  if (Date.now() >= control.wallDeadlineAt) {
    cleanup();
    throw uploadFailure("upload_timeout");
  }
  const initialStat = statSync(path);
  if (initialStat.size > MAX_COMPRESSED_BYTES) {
    cleanup();
    throw new ArchiveValidationError(
      "size",
      `archive exceeds compressed size cap (${initialStat.size} bytes)`,
    );
  }
  const beforeHash = fileIdentity(path);
  let archiveDigest: string;
  try {
    archiveDigest = await sha256File(path, control.signal, control.wallDeadlineAt);
  } catch (error) {
    cleanup();
    throw error;
  }
  const afterHash = fileIdentity(path);
  if (!samePersistedUploadIdentity(beforeHash, afterHash)) {
    cleanup();
    throw new ArchiveIdempotencyError();
  }
  // The upload reservation is durable before this point. When the caller
  // reserved a control row, bind the completed bytes, digest, and inode proof
  // to that row before returning. A failed CAS must reject the upload rather
  // than leave a queued row whose restart path has no trustworthy identity.
  let controlDb: Database | null = null;
  try {
    controlDb = getDb();
  } catch {
    // The low-level helper is also used without a database by upload-stream
    // tests and tooling; startImport performs the durable admission CAS.
  }
  if (controlDb) {
    // A global DB can exist without the import schema (partially migrated
    // in-memory databases in unrelated tests); absence is not an error here
    // for the same reason a missing database is not.
    const controlTable = controlDb.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_data_imports'",
    ).get();
    if (!controlTable) {
      controlDb = null;
    }
  }
  if (controlDb) {
    const control = controlDb.query(
      `SELECT state, lease_owner, lease_expires_at
         FROM user_data_imports
        WHERE job_id = ? AND user_id = ?`,
    ).get(jobId, userId) as {
      state?: string;
      lease_owner?: string | null;
      lease_expires_at?: number | null;
    } | null;
    if (control) {
      const now = nowSeconds();
      if (
        control.state !== "queued"
        || typeof control.lease_owner !== "string"
        || !control.lease_owner.startsWith("upload:")
        || (control.lease_expires_at !== null
          && control.lease_expires_at !== undefined
          && control.lease_expires_at <= now)
      ) {
        cleanup();
        throw new Error("import upload reservation is no longer available");
      }
      const persisted = controlDb.query(
        `UPDATE user_data_imports
            SET archive_digest = ?, manifest_json = ?, updated_at = ?
          WHERE job_id = ? AND user_id = ? AND state = 'queued'
            AND lease_owner = ? AND (lease_expires_at IS NULL OR lease_expires_at > ?)`,
      ).run(
        archiveDigest,
        serializeDurableManifest(null, afterHash),
        now,
        jobId,
        userId,
        control.lease_owner,
        now,
      );
      if (persisted.changes !== 1) {
        cleanup();
        throw new Error("import upload reservation was lost");
      }
    }
  }
  return {
    path,
    jobId,
    archiveDigest,
    byteCount: afterHash.size,
    proof: Object.freeze(new PersistedUploadProof(
      path,
      archiveDigest,
      afterHash.size,
      Object.freeze({ ...afterHash }),
    )),
  };
}

/**
 * Cap on the manifest entry's decompressed size. New-format manifests are
 * < 4 KB (counts + missing-files were moved to a trailer), but legacy
 * archives embed those inline — a long missingFiles list on a corrupted
 * library can push the manifest into the MB range, so we leave a roomy
 * ceiling and still reject anything obviously absurd.
 */
const MAX_MANIFEST_BYTES = MAX_ARCHIVE_MANIFEST_BYTES;

/** Optional trailer and secret index are metadata, never bulk payloads. */
const MAX_MANIFEST_STATS_BYTES = MAX_ARCHIVE_MANIFEST_BYTES;
const MAX_SECRETS_INDEX_BYTES = MAX_ARCHIVE_SECRET_BYTES;

/** A manifest should never be larger compressed than this. */
const MAX_MANIFEST_COMPRESSED_BYTES = 32 * 1024 * 1024;

// ─── ZIP central-directory primitives ──────────────────────────────────
//
// Every ZIP file ends with an End-of-Central-Directory (EOCD) record, which
// names the offset and size of the central directory — a table of every
// entry's name, compression, and absolute offset in the file. Reading just
// the tail of the archive lets us locate `manifest.json` in O(1) regardless
// of where it sits in the file, which matters for legacy archives (manifest
// last) and 2+ GB exports.
//
// ZIP64 (used when an archive crosses 2³²−1 bytes, has more than 65535
// entries, or has an individual entry > 4 GB) augments the EOCD with a
// "ZIP64 End of Central Directory Locator" (sig 0x07064b50, 20 bytes,
// sitting immediately before the standard EOCD) and a "ZIP64 End of
// Central Directory Record" (sig 0x06064b50, 56 bytes) at the offset
// named by the locator. Those two records carry the true 64-bit
// cdSize, cdOffset, and totalEntries values. ZIP64-aware writers also
// store per-entry 64-bit overrides in the central directory's "extra
// field" (tag 0x0001); we honour those below when the standard 32-bit
// fields are the 0xFFFFFFFF / 0xFFFF sentinels.

const CDH_SIG = 0x02014b50;  // "PK\x01\x02"
const LFH_SIG = 0x04034b50;  // "PK\x03\x04"
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50; // "PK\x06\x07"
const ZIP64_EOCD_RECORD_SIG = 0x06064b50; // "PK\x06\x06"
const ZIP64_EXTRA_TAG = 0x0001;
const EOCD_MIN_BYTES = 22;
const ZIP64_EOCD_LOCATOR_BYTES = 20;
const ZIP64_EOCD_RECORD_BYTES = 56;
const ZIP_COMMENT_MAX = 65535;
/** Bounded read window used while scanning a potentially huge central directory. */
const CENTRAL_DIRECTORY_READ_BYTES = 256 * 1024;
const MAX_ARCHIVE_PATH_BYTES = 4096;
const MAX_ARCHIVE_PATH_DEPTH = 64;
const MAX_ARCHIVE_PATH_SEGMENT_BYTES = 255;

function assertZipEntryNameBounds(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new ArchiveValidationError("not_zip", "central directory entry has an empty name");
  }
  if (Buffer.byteLength(name, "utf8") > MAX_ARCHIVE_PATH_BYTES) {
    throw new ArchiveValidationError("size", "central directory entry name exceeds the path byte limit");
  }
  const segments = name.replaceAll("\\", "/").split("/");
  if (segments.length > MAX_ARCHIVE_PATH_DEPTH) {
    throw new ArchiveValidationError("size", "central directory entry path is too deep");
  }
  if (segments.some((segment) => Buffer.byteLength(segment, "utf8") > MAX_ARCHIVE_PATH_SEGMENT_BYTES)) {
    throw new ArchiveValidationError("size", "central directory path segment exceeds the byte limit");
  }
}

function assertZipEntrySizeBounds(file: Bun.BunFile, entry: CentralDirEntry): void {
  if (
    !isSafeZipNumber(entry.compressedSize)
    || !isSafeZipNumber(entry.uncompressedSize)
    || !isSafeZipNumber(entry.localHeaderOffset)
  ) {
    throw new ArchiveValidationError("not_zip", "central directory contains unsafe ZIP64 values");
  }
  if (entry.compressedSize > MAX_COMPRESSED_BYTES) {
    throw new ArchiveValidationError("size", `${entry.name} exceeds the compressed-size limit`);
  }
  if (entry.uncompressedSize > MAX_ARCHIVE_FILE_BYTES) {
    throw new ArchiveValidationError("size", `${entry.name} exceeds the uncompressed-size limit`);
  }
  if (file.size < 30 || entry.localHeaderOffset > file.size - 30) {
    throw new ArchiveValidationError("not_zip", `local file header is truncated for ${entry.name}`);
  }
}

function assertZipCompressedSizeBound(compressedSize: number, name: string): void {
  if (!isSafeZipNumber(compressedSize) || compressedSize > MAX_COMPRESSED_BYTES) {
    throw new ArchiveValidationError("size", `${name} exceeds the compressed-size limit`);
  }
}


interface CentralDirEntry {
  name: string;
  flags: number;
  compression: number;        // 0 = store, 8 = deflate
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}
interface CentralDirectoryInfo {
  readonly size: number;
  readonly cdOffset: number;
  readonly cdSize: number;
  readonly totalEntries: number;
}

/**
 * Walk a central-directory-header (or local-file-header) extra field and
 * return the first ZIP64 block (tag 0x0001) as a typed view, or null if no
 * such block is present. Each extra block is: 2-byte tag, 2-byte size,
 * `size` bytes of payload. Blocks are concatenated back-to-back.
 */
function readZip64Extra(
  extra: Uint8Array,
  extraOffset: number,
  extraLen: number,
): DataView | null {
  let pos = extraOffset;
  const end = extraOffset + extraLen;
  while (pos + 4 <= end) {
    const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
    const tag = view.getUint16(pos, true);
    const size = view.getUint16(pos + 2, true);
    if (pos + 4 + size > end) return null;
    if (tag === ZIP64_EXTRA_TAG) {
      return new DataView(extra.buffer, extra.byteOffset + pos + 4, size);
    }
    pos += 4 + size;
  }
  return null;
}

async function readBytes(file: Bun.BunFile, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function isSafeZipNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Yield central-directory records in fixed-size windows. The carry buffer is
 * at most one maximum-size record, so callers can inspect every entry without
 * retaining the directory or a list of archive metadata in memory.
 */
async function* scanCentralDirectory(
  file: Bun.BunFile,
  cdOffset: number,
  cdSize: number,
  totalEntries: number,
): AsyncGenerator<CentralDirEntry> {
  if (
    !isSafeZipNumber(cdOffset)
    || !isSafeZipNumber(cdSize)
    || !isSafeZipNumber(totalEntries)
    || cdOffset > file.size
    || cdSize > file.size - cdOffset
  ) {
    throw new ArchiveValidationError("not_zip", "central directory range is outside the archive");
  }
  const decoder = new TextDecoder();
  let fetched = 0;
  let entriesRead = 0;
  let pending = new Uint8Array(0);

  while (fetched < cdSize) {
    const readSize = Math.min(CENTRAL_DIRECTORY_READ_BYTES, cdSize - fetched);
    const chunk = await readBytes(
      file,
      cdOffset + fetched,
      cdOffset + fetched + readSize,
    );
    if (chunk.byteLength !== readSize) {
      throw new ArchiveValidationError("not_zip", "central directory is truncated");
    }
    fetched += chunk.byteLength;

    let data: Uint8Array;
    if (pending.byteLength === 0) {
      data = chunk;
    } else {
      // A CD record is bounded by its three uint16 length fields, so this
      // carry buffer stays below ~192 KB regardless of total archive size.
      data = new Uint8Array(pending.byteLength + chunk.byteLength);
      data.set(pending, 0);
      data.set(chunk, pending.byteLength);
    }

    let pos = 0;
    while (pos + 46 <= data.byteLength) {
      if (entriesRead >= totalEntries) {
        throw new ArchiveValidationError(
          "not_zip",
          "central directory contains entries beyond its declared count",
        );
      }
      const view = new DataView(data.buffer, data.byteOffset + pos);
      if (view.getUint32(0, true) !== CDH_SIG) {
        throw new ArchiveValidationError(
          "not_zip",
          `central directory header signature invalid at entry ${entriesRead}`,
        );
      }

      const flags = view.getUint16(8, true);
      const compression = view.getUint16(10, true);
      const crc32 = view.getUint32(16, true);
      let compressedSize = view.getUint32(20, true);
      let uncompressedSize = view.getUint32(24, true);
      const nameLen = view.getUint16(28, true);
      const extraLen = view.getUint16(30, true);
      const commentLen = view.getUint16(32, true);
      let localHeaderOffset = view.getUint32(42, true);
      const recordSize = 46 + nameLen + extraLen + commentLen;
      if (pos + recordSize > data.byteLength) break;

      const name = decoder.decode(data.subarray(pos + 46, pos + 46 + nameLen));
      if (
        extraLen > 0 &&
        (uncompressedSize === 0xffffffff ||
          compressedSize === 0xffffffff ||
          localHeaderOffset === 0xffffffff)
      ) {
        const zip64 = readZip64Extra(data, pos + 46 + nameLen, extraLen);
        if (!zip64) {
          throw new ArchiveValidationError(
            "not_zip",
            `ZIP64 extra field missing or truncated for ${name || `entry ${entriesRead}`}`,
          );
        }
        let cursor = 0;
        if (uncompressedSize === 0xffffffff) {
          if (cursor + 8 > zip64.byteLength) {
            throw new ArchiveValidationError("not_zip", "ZIP64 uncompressed size is truncated");
          }
          uncompressedSize = Number(zip64.getBigUint64(cursor, true));
          cursor += 8;
        }
        if (compressedSize === 0xffffffff) {
          if (cursor + 8 > zip64.byteLength) {
            throw new ArchiveValidationError("not_zip", "ZIP64 compressed size is truncated");
          }
          compressedSize = Number(zip64.getBigUint64(cursor, true));
          cursor += 8;
        }
        if (localHeaderOffset === 0xffffffff) {
          if (cursor + 8 > zip64.byteLength) {
            throw new ArchiveValidationError("not_zip", "ZIP64 local-header offset is truncated");
          }
          localHeaderOffset = Number(zip64.getBigUint64(cursor, true));
        }
      }

      if (
        !isSafeZipNumber(compressedSize) ||
        !isSafeZipNumber(uncompressedSize) ||
        !isSafeZipNumber(localHeaderOffset)
      ) {
        throw new ArchiveValidationError("not_zip", "central directory contains unsafe ZIP64 values");
      }
      const parsedEntry: CentralDirEntry = {
        name,
        flags,
        compression,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      };
      assertZipEntryNameBounds(parsedEntry.name);
      assertZipEntrySizeBounds(file, parsedEntry);
      entriesRead++;
      yield parsedEntry;
      pos += recordSize;
    }

    // The central-directory byte range is authoritative. Any bytes left after
    // the declared records are hidden entries/padding and must be rejected.
    if (pos < data.byteLength && (entriesRead >= totalEntries || fetched === cdSize)) {
      throw new ArchiveValidationError(
        "not_zip",
        "central directory contains trailing bytes beyond its declared entries",
      );
    }
    // Copy only the partial record at the page boundary. Do not retain the
    // full page (or the entire central directory) through a subarray view.
    pending = data.slice(pos);
  }

  if (fetched !== cdSize || pending.byteLength !== 0) {
    throw new ArchiveValidationError("not_zip", "central directory size is not exact");
  }
  if (entriesRead !== totalEntries) {
    throw new ArchiveValidationError(
      "not_zip",
      `central directory entry count mismatch (declared ${totalEntries}, parsed ${entriesRead})`,
    );
  }

}

/** Find only manifest.json while preserving the bounded central-directory scan. */
async function findManifestInCentralDirectory(
  file: Bun.BunFile,
  cdOffset: number,
  cdSize: number,
  totalEntries: number,
): Promise<CentralDirEntry | null> {
  let manifest: CentralDirEntry | null = null;
  for await (const entry of scanCentralDirectory(file, cdOffset, cdSize, totalEntries)) {
    if (entry.name === "manifest.json") manifest = entry;
  }
  return manifest;
}

/** Locate and validate the central directory without reading it as one blob. */
async function locateCentralDirectory(file: Bun.BunFile): Promise<CentralDirectoryInfo> {
  const size = file.size;
  if (size < EOCD_MIN_BYTES) {
    throw new ArchiveValidationError("not_zip", "archive is too small to contain a ZIP EOCD record");
  }

  const tailWindow = Math.min(size, EOCD_MIN_BYTES + ZIP_COMMENT_MAX);
  const tail = await readBytes(file, size - tailWindow, size);
  let eocdOffsetInTail = -1;
  for (let i = tail.length - EOCD_MIN_BYTES; i >= 0; i--) {
    if (
      tail[i] === 0x50 &&
      tail[i + 1] === 0x4b &&
      tail[i + 2] === 0x05 &&
      tail[i + 3] === 0x06
    ) {
      // A signature may occur inside the ZIP comment. Only accept a record
      // whose declared comment length lands exactly at end-of-file.
      const candidate = new DataView(tail.buffer, tail.byteOffset + i, EOCD_MIN_BYTES);
      if (i + EOCD_MIN_BYTES + candidate.getUint16(20, true) === tail.byteLength) {
        eocdOffsetInTail = i;
        break;
      }
    }
  }
  if (eocdOffsetInTail < 0) {
    throw new ArchiveValidationError("not_zip", "ZIP End-of-Central-Directory record not found");
  }

  const eocdFileOffset = size - tailWindow + eocdOffsetInTail;
  const eocd = new DataView(tail.buffer, tail.byteOffset + eocdOffsetInTail, EOCD_MIN_BYTES);
  let totalEntries = eocd.getUint16(10, true);
  let cdSize = eocd.getUint32(12, true);
  let cdOffset = eocd.getUint32(16, true);
  const eocdNeedsZip64 =
    cdSize === 0xffffffff || cdOffset === 0xffffffff || totalEntries === 0xffff;
  let centralDirectoryEnd = eocdFileOffset;
  if (eocdNeedsZip64) {
    if (eocdFileOffset < ZIP64_EOCD_LOCATOR_BYTES) {
      throw new ArchiveValidationError("not_zip", "ZIP64 End-of-Central-Directory locator truncated");
    }
    const locatorFileOffset = eocdFileOffset - ZIP64_EOCD_LOCATOR_BYTES;
    let locatorView: DataView;
    if (locatorFileOffset >= size - tailWindow) {
      const localOff = locatorFileOffset - (size - tailWindow);
      locatorView = new DataView(tail.buffer, tail.byteOffset + localOff, ZIP64_EOCD_LOCATOR_BYTES);
    } else {
      const locatorBytes = await readBytes(file, locatorFileOffset, locatorFileOffset + ZIP64_EOCD_LOCATOR_BYTES);
      if (locatorBytes.byteLength !== ZIP64_EOCD_LOCATOR_BYTES) {
        throw new ArchiveValidationError("not_zip", "ZIP64 EOCD locator truncated");
      }
      locatorView = new DataView(locatorBytes.buffer, locatorBytes.byteOffset, ZIP64_EOCD_LOCATOR_BYTES);
    }
    if (locatorView.getUint32(0, true) !== ZIP64_EOCD_LOCATOR_SIG) {
      throw new ArchiveValidationError("not_zip", "ZIP64 EOCD sentinel detected but locator not found");
    }
    const zip64EocdOffset = Number(locatorView.getBigUint64(8, true));
    if (
      !isSafeZipNumber(zip64EocdOffset)
      || zip64EocdOffset > size - ZIP64_EOCD_RECORD_BYTES
      || zip64EocdOffset + ZIP64_EOCD_RECORD_BYTES !== locatorFileOffset
    ) {
      throw new ArchiveValidationError("not_zip", "ZIP64 EOCD record chain is not contiguous");
    }
    const zip64EocdBytes = await readBytes(
      file,
      zip64EocdOffset,
      zip64EocdOffset + ZIP64_EOCD_RECORD_BYTES,
    );
    if (zip64EocdBytes.byteLength !== ZIP64_EOCD_RECORD_BYTES) {
      throw new ArchiveValidationError("not_zip", "ZIP64 EOCD record truncated");
    }
    const zip64Eocd = new DataView(zip64EocdBytes.buffer, zip64EocdBytes.byteOffset, ZIP64_EOCD_RECORD_BYTES);
    if (zip64Eocd.getUint32(0, true) !== ZIP64_EOCD_RECORD_SIG) {
      throw new ArchiveValidationError("not_zip", "ZIP64 EOCD record signature invalid");
    }
    const zip64RecordSize = Number(zip64Eocd.getBigUint64(4, true));
    if (!isSafeZipNumber(zip64RecordSize) || zip64RecordSize !== ZIP64_EOCD_RECORD_BYTES - 12) {
      throw new ArchiveValidationError("not_zip", "ZIP64 EOCD extensible data is not supported");
    }
    totalEntries = Number(zip64Eocd.getBigUint64(32, true));
    cdSize = Number(zip64Eocd.getBigUint64(40, true));
    cdOffset = Number(zip64Eocd.getBigUint64(48, true));
    centralDirectoryEnd = zip64EocdOffset;
  }

  if (!isSafeZipNumber(totalEntries) || !isSafeZipNumber(cdSize) || !isSafeZipNumber(cdOffset)) {
    throw new ArchiveValidationError("not_zip", "ZIP central directory contains unsafe 64-bit values");
  }
  if (!isSafeZipNumber(centralDirectoryEnd)) {
    throw new ArchiveValidationError("not_zip", "ZIP central directory end offset is unsafe");
  }
  if (totalEntries > MAX_ENTRIES) {
    throw new ArchiveValidationError("size", `archive contains too many entries (>${MAX_ENTRIES})`);
  }
  if (cdSize > size || cdOffset > size - cdSize) {
    throw new ArchiveValidationError("not_zip", "central directory extends past end of file");
  }
  if (cdOffset + cdSize !== centralDirectoryEnd) {
    throw new ArchiveValidationError(
      "not_zip",
      "central directory contains trailing bytes beyond its declared range",
    );
  }
  return { size, cdOffset, cdSize, totalEntries };
}

/**
 * Fast-path verifier: parses the ZIP central directory, finds manifest.json,
 * reads only its bytes, and parses the manifest. Memory stays bounded to the
 * tail window, one central-directory page, and the manifest bytes regardless
 * of total archive size. Throws ArchiveValidationError if the archive's
 * central directory can't be located or manifest.json is absent.
 *
 * Supports ZIP64 (PPAPP 6.2): when the standard EOCD reports 0xFFFFFFFF /
 * 0xFFFF sentinels, we read the ZIP64 EOCD locator sitting immediately
 * before the EOCD and the ZIP64 EOCD record it points to, and resolve the
 * real 64-bit cdSize / cdOffset / totalEntries. Per-entry 64-bit overrides
 * in the central directory's extra field (tag 0x0001) are honoured when
 * the standard 32-bit fields are the 0xFFFFFFFF sentinel.
 */
export async function verifyArchiveFast(archivePath: string): Promise<ArchiveManifest> {
  const file = Bun.file(archivePath);
  const { size, cdOffset, cdSize, totalEntries } = await locateCentralDirectory(file);

  const manifestEntry = await findManifestInCentralDirectory(
    file,
    cdOffset,
    cdSize,
    totalEntries,
  );
  if (!manifestEntry) {
    throw new ArchiveValidationError("no_manifest", "archive central directory has no manifest.json");
  }
  if (manifestEntry.uncompressedSize > MAX_MANIFEST_BYTES) {
    throw new ArchiveValidationError(
      "bad_manifest",
      `manifest.json declares ${manifestEntry.uncompressedSize} bytes (cap ${MAX_MANIFEST_BYTES})`,
    );
  }
  if (manifestEntry.compressedSize > MAX_MANIFEST_COMPRESSED_BYTES) {
    throw new ArchiveValidationError(
      "bad_manifest",
      `manifest.json declares ${manifestEntry.compressedSize} compressed bytes (cap ${MAX_MANIFEST_COMPRESSED_BYTES})`,
    );
  }
  if (manifestEntry.compression !== 0 && manifestEntry.compression !== 8) {
    throw new ArchiveValidationError(
      "bad_manifest",
      `manifest.json uses unsupported compression method ${manifestEntry.compression}`,
    );
  }

  // Read the local file header to find where the manifest's compressed data
  // actually starts (the LFH may carry extra fields the CDH doesn't mirror).
  const lfhHeader = await readBytes(
    file,
    manifestEntry.localHeaderOffset,
    manifestEntry.localHeaderOffset + 30,
  );
  if (lfhHeader.length < 30) {
    throw new ArchiveValidationError("bad_manifest", "manifest local file header truncated");
  }
  const lfhView = new DataView(lfhHeader.buffer, lfhHeader.byteOffset);
  if (lfhView.getUint32(0, true) !== LFH_SIG) {
    throw new ArchiveValidationError("bad_manifest", "manifest local file header signature invalid");
  }
  const lfhNameLen = lfhView.getUint16(26, true);
  const lfhExtraLen = lfhView.getUint16(28, true);
  const dataStart = manifestEntry.localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
  const dataEnd = dataStart + manifestEntry.compressedSize;
  if (dataEnd > size) {
    throw new ArchiveValidationError("bad_manifest", "manifest data extends past end of file");
  }
  const compressed = await readBytes(file, dataStart, dataEnd);
  let bytes: Uint8Array;
  try {
    bytes =
      manifestEntry.compression === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: MAX_MANIFEST_BYTES });
  } catch (err) {
    throw new ArchiveValidationError(
      "bad_manifest",
      `manifest.json decompression failed: ${(err as Error).message}`,
    );
  }
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new ArchiveValidationError(
      "bad_manifest",
      `manifest.json decompressed to ${bytes.byteLength} bytes (cap ${MAX_MANIFEST_BYTES})`,
    );
  }
  try {
    const text = new TextDecoder().decode(bytes);
    return parseManifest(JSON.parse(text));
  } catch (err) {
    throw new ArchiveValidationError(
      "bad_manifest",
      `manifest.json parse failed: ${(err as Error).message}`,
    );
  }
}

/**
 * Compatibility entry point retained for callers and tests. The previous
 * fallback fed arbitrary archive chunks through fflate, whose output allocation
 * is not bounded by the input window. The ZIP64-aware central-directory
 * verifier above handles Lumiverse archives directly, so malformed or exotic
 * archives now fail closed instead of entering an unbounded fallback path.
 */
export async function verifyArchive(archivePath: string): Promise<ArchiveManifest> {
  return verifyArchiveFast(archivePath);
}

/**
 * Start a background import job after proving the archive identity. Upload
 * routes may provide the opaque proof returned by persistUploadedArchive;
 * direct callers must pay the bounded asynchronous hash/stat cost themselves.
 * Receipt replay is intentionally resolved before any active-slot rejection.
 */
export async function startImport(opts: {
  userId: string;
  archivePath: string;
  jobId: string;
  archiveId?: string;
  archiveDigest?: string;
  archiveBytes?: number;
  uploadProof?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<ImportJob> {
  const db = getDb();
  pruneTerminalImportJobs();

  let suppliedDigest: string;
  let archiveByteCount: number;
  let archiveIdentity: FileIdentity;
  if (opts.uploadProof !== undefined) {
    if (!(opts.uploadProof instanceof PersistedUploadProof)
      || opts.uploadProof.archivePath !== opts.archivePath
      || opts.archiveDigest?.toLowerCase() !== opts.uploadProof.archiveDigest
      || opts.archiveBytes !== opts.uploadProof.byteCount
      || !/^[0-9a-f]{64}$/.test(opts.uploadProof.archiveDigest)
      || !Number.isSafeInteger(opts.uploadProof.byteCount)
      || opts.uploadProof.byteCount < 0) {
      throw new ArchiveIdempotencyError();
    }
    let currentIdentity: FileIdentity;
    try {
      currentIdentity = fileIdentity(opts.archivePath);
    } catch {
      throw new ArchiveIdempotencyError();
    }
    if (!samePersistedUploadIdentity(currentIdentity, opts.uploadProof.identity)) {
      throw new ArchiveIdempotencyError();
    }
    suppliedDigest = opts.uploadProof.archiveDigest;
    archiveByteCount = opts.uploadProof.byteCount;
    archiveIdentity = currentIdentity;
  } else {
    const beforeHash = fileIdentity(opts.archivePath);
    const digestDeadline = Number.isFinite(opts.deadlineAt)
      ? Number(opts.deadlineAt)
      : Date.now() + MAX_IMPORT_UPLOAD_WALL_MS;
    suppliedDigest = await sha256File(opts.archivePath, opts.signal, digestDeadline);
    const afterHash = fileIdentity(opts.archivePath);
    if (!samePersistedUploadIdentity(beforeHash, afterHash)) {
      throw new ArchiveIdempotencyError();
    }
    archiveByteCount = afterHash.size;
    archiveIdentity = afterHash;
  }
  if (!Number.isSafeInteger(archiveByteCount) || archiveByteCount < 0) {
    throw new ArchiveIdempotencyError();
  }
  if (opts.archiveDigest !== undefined && !/^[0-9a-f]{64}$/.test(opts.archiveDigest.toLowerCase())) {
    throw new ArchiveIdempotencyError();
  }
  const suppliedArchiveId = opts.archiveId;
  const archiveId = suppliedArchiveId === "" && suppliedDigest
    ? stableLegacyArchiveIdentity(suppliedDigest)
    : suppliedArchiveId || `pending:${opts.jobId}`;
  if (archiveId.length === 0 || archiveId.length > 4096) throw new ArchiveIdempotencyError();
  const idempotencyKey = opts.idempotencyKey || archiveId;
  let priorReceipt = db.query(
    `SELECT archive_digest, summary_json FROM user_data_import_receipts
      WHERE user_id = ? AND idempotency_key = ?`,
  ).get(opts.userId, idempotencyKey) as { archive_digest: string; summary_json: string } | null;
  if (!priorReceipt && suppliedDigest) {
    // The digest is the archive identity even when a caller chooses a fresh
    // internal idempotency key. This keeps direct/restarted retries from
    // reopening canonical data under a different archive label.
    priorReceipt = db.query(
      `SELECT archive_digest, summary_json FROM user_data_import_receipts
        WHERE user_id = ? AND archive_digest = ?
        ORDER BY committed_at DESC LIMIT 1`,
    ).get(opts.userId, suppliedDigest) as { archive_digest: string; summary_json: string } | null;
  }
  if (priorReceipt) {
    if (!suppliedDigest || priorReceipt.archive_digest.toLowerCase() !== suppliedDigest) {
      throw new ArchiveIdempotencyError();
    }
    if (existsSync(opts.archivePath) && !removeOwnedImportArchive(opts.userId, opts.jobId, opts.archivePath)) {
      throw new Error("duplicate import archive cleanup failed");
    }
    const receiptSummary = parseImportSummary(priorReceipt.summary_json) as ImportReceiptSummary;
    const publicSummary = publicImportSummaries(receiptSummary);
    const duplicate: ImportJob = {
      jobId: opts.jobId,
      userId: opts.userId,
      archiveId,
      idempotencyKey,
      status: "complete",
      archivePath: opts.archivePath,
      startedAt: nowSeconds(),
      finishedAt: nowSeconds(),
      manifest: null,
      summary: publicSummary.summary,
      fileSummary: publicSummary.fileSummary,
      error: null,
      abort: new AbortController(),
      ticketGateState: "open",
      archiveIdentity,
      archiveDigest: priorReceipt.archive_digest,
      leaseOwner: `replay:${opts.jobId}`,
      leaseGeneration: 0,
      stagingDbPath: null,
      commitStarted: false,
    };
    JOBS.set(duplicate.jobId, duplicate);
    try { db.query("DELETE FROM user_data_imports WHERE job_id = ? AND state = 'queued'").run(opts.jobId); } catch {}
    claimImportReservation(opts.userId, opts.jobId);
    releaseGlobalImportSlot(opts.jobId);
    return duplicate;
  }

  // Durable leases are the admission authority after receipt replay. This
  // covers a restarted process whose in-memory maps are empty, including an
  // encrypted job that is still leased while awaiting its ticket.
  const admissionNow = nowSeconds();
  const durableUserActive = db.query(
    `SELECT 1 AS active
       FROM user_data_imports
      WHERE user_id = ? AND job_id <> ?
        AND (
          state NOT IN ('committed','failed','cancelled','awaiting_ticket')
          OR (
            state = 'awaiting_ticket'
            AND lease_owner IS NOT NULL
            AND (lease_expires_at IS NULL OR lease_expires_at > ?)
          )
        )
      LIMIT 1`,
  ).get(opts.userId, opts.jobId, admissionNow) as { active?: number } | null;
  if (durableUserActive?.active === 1) {
    throw new Error("an import is already running for this user");
  }
  const durableGlobalActive = db.query(
    `SELECT COUNT(*) AS count
       FROM user_data_imports
      WHERE job_id <> ?
        AND (
          state NOT IN ('committed','failed','cancelled','awaiting_ticket')
          OR (
            state = 'awaiting_ticket'
            AND lease_owner IS NOT NULL
            AND (lease_expires_at IS NULL OR lease_expires_at > ?)
          )
        )`,
  ).get(opts.jobId, admissionNow) as { count: number };
  if (durableGlobalActive.count >= MAX_GLOBAL_IMPORTS) {
    throw new Error("global import capacity exhausted");
  }

  const existingJobId = USER_RUNNING.get(opts.userId);
  const reservation = USER_UPLOAD_RESERVATIONS.get(opts.userId);
  if (
    existingJobId
    || (reservation !== undefined && reservation !== opts.jobId)
    || (globalImportSlot !== null && globalImportSlot !== opts.jobId)
  ) {
    throw new Error("an import is already running for this user");
  }

  const existing = readImportControl(opts.jobId, db);
  let leaseOwner = existing?.lease_owner || `job:${crypto.randomUUID()}`;
  let leaseGeneration = existing?.lease_generation ?? 0;
  const now = nowSeconds();
  const durableDigest = suppliedDigest || "0".repeat(64);
  const durableManifest = serializeDurableManifest(null, archiveIdentity);
  if (!existing) {
    const active = db.query(
      `SELECT COUNT(*) AS count
         FROM user_data_imports
        WHERE (
          state NOT IN ('committed','failed','cancelled','awaiting_ticket')
          OR (
            state = 'awaiting_ticket'
            AND lease_owner IS NOT NULL
            AND (lease_expires_at IS NULL OR lease_expires_at > ?)
          )
        )`,
    ).get(now) as { count: number };
    if (active.count >= MAX_GLOBAL_IMPORTS) throw new Error("global import capacity exhausted");
    db.query(
      `INSERT INTO user_data_imports
       (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
        staging_path,staging_db_path,state,lease_owner,lease_expires_at,
        lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?)`,
    ).run(
      opts.jobId,
      opts.userId,
      archiveId,
      idempotencyKey,
      durableDigest,
      durableManifest,
      join(dirname(opts.archivePath), "staging"),
      join(dirname(opts.archivePath), "staging", "staging.sqlite"),
      leaseOwner,
      now + IMPORT_LEASE_SECONDS,
      now,
      now,
    );
  } else {
    if (existing.user_id !== opts.userId || TERMINAL_IMPORT_STATES.has(existing.state)) {
      throw new Error("import job identity is not available");
    }
    if (
      existing.archive_digest
      && existing.archive_digest !== "0".repeat(64)
      && existing.archive_digest.toLowerCase() !== durableDigest
    ) {
      throw new ArchiveIdempotencyError();
    }
    const parkedForTicket = existing.state === "awaiting_ticket"
      && existing.lease_owner === null
      && existing.lease_expires_at === null;
    const expired = existing.lease_expires_at !== null && existing.lease_expires_at <= now;
    const stagingPath = join(dirname(opts.archivePath), "staging");
    const stagingDbPath = join(stagingPath, "staging.sqlite");
    if (parkedForTicket) {
      leaseOwner = `job:${crypto.randomUUID()}`;
      leaseGeneration = existing.lease_generation + 1;
      const resumed = db.query(
        `UPDATE user_data_imports
            SET state = 'queued', archive_id = ?, idempotency_key = ?, archive_digest = ?, manifest_json = ?,
                staging_path = ?, staging_db_path = ?, lease_owner = ?, lease_generation = ?,
                lease_expires_at = ?, updated_at = ?
          WHERE job_id = ? AND user_id = ? AND state = 'awaiting_ticket'
            AND lease_owner IS NULL AND lease_expires_at IS NULL AND lease_generation = ?`,
      ).run(
        archiveId,
        idempotencyKey,
        durableDigest,
        durableManifest,
        stagingPath,
        stagingDbPath,
        leaseOwner,
        leaseGeneration,
        now + IMPORT_LEASE_SECONDS,
        now,
        opts.jobId,
        opts.userId,
        existing.lease_generation,
      );
      if (resumed.changes !== 1) throw new Error("import lease fence lost");
    } else if (expired) {
      leaseOwner = `job:${crypto.randomUUID()}`;
      leaseGeneration = existing.lease_generation + 1;
      const takeover = db.query(
        `UPDATE user_data_imports
            SET archive_id = ?, idempotency_key = ?, archive_digest = ?, manifest_json = ?,
                staging_path = ?, staging_db_path = ?, lease_owner = ?, lease_generation = ?, lease_expires_at = ?,
                updated_at = ?
          WHERE job_id = ? AND user_id = ? AND lease_generation = ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            AND state NOT IN ('committed','failed','cancelled')`,
      ).run(
        archiveId,
        idempotencyKey,
        durableDigest,
        durableManifest,
        stagingPath,
        stagingDbPath,
        leaseOwner,
        leaseGeneration,
        now + IMPORT_LEASE_SECONDS,
        now,
        opts.jobId,
        opts.userId,
        existing.lease_generation,
        now,
      );
      if (takeover.changes !== 1) throw new Error("import lease fence lost");
    } else if (existing.lease_owner) {
      const uploadReservation =
        existing.state === "queued"
        && existing.lease_owner.startsWith("upload:")
        && USER_UPLOAD_RESERVATIONS.get(opts.userId) === opts.jobId;
      if (!uploadReservation) {
        throw new Error("import job is already leased");
      }
      const previousOwner = existing.lease_owner;
      leaseOwner = `job:${crypto.randomUUID()}`;
      leaseGeneration = existing.lease_generation + 1;
      const updated = db.query(
        `UPDATE user_data_imports
            SET archive_id = ?, idempotency_key = ?, archive_digest = ?, manifest_json = ?,
                staging_path = ?, staging_db_path = ?, lease_owner = ?, lease_generation = ?,
                updated_at = ?, lease_expires_at = ?
          WHERE job_id = ? AND user_id = ? AND lease_owner = ? AND lease_generation = ?
            AND (lease_expires_at IS NULL OR lease_expires_at > ?)
            AND state = 'queued'`,
      ).run(
        archiveId,
        idempotencyKey,
        durableDigest,
        durableManifest,
        stagingPath,
        stagingDbPath,
        leaseOwner,
        leaseGeneration,
        now,
        now + IMPORT_LEASE_SECONDS,
        opts.jobId,
        opts.userId,
        previousOwner,
        existing.lease_generation,
        now,
      );
      if (updated.changes !== 1) throw new Error("import lease fence lost");
    } else {
      const updated = db.query(
        `UPDATE user_data_imports
            SET archive_id = ?, idempotency_key = ?, archive_digest = ?, manifest_json = ?,
                staging_path = ?, staging_db_path = ?, lease_owner = ?, updated_at = ?, lease_expires_at = ?
          WHERE job_id = ? AND user_id = ? AND lease_owner IS NULL AND lease_expires_at IS NULL
            AND lease_generation = ? AND state = 'awaiting_ticket'`,
      ).run(
        archiveId,
        idempotencyKey,
        durableDigest,
        durableManifest,
        stagingPath,
        stagingDbPath,
        now,
        now + IMPORT_LEASE_SECONDS,
        opts.jobId,
        opts.userId,
      );
      if (updated.changes !== 1) throw new Error("import lease fence lost");
    }
  }

  let ticketResolver: (v: { ticket: DecryptionTicket; smk: Uint8Array } | null) => void = () => {};
  const ticketGate = new Promise<{ ticket: DecryptionTicket; smk: Uint8Array } | null>(
    (resolve) => { ticketResolver = resolve; },
  );
  let completionResolver: () => void = () => {};
  const completion = new Promise<void>((resolve) => {
    completionResolver = resolve;
  });
  const job: ImportJob = {
    jobId: opts.jobId,
    userId: opts.userId,
    archiveId,
    idempotencyKey,
    status: "queued",
    archivePath: opts.archivePath,
    startedAt: now,
    finishedAt: null,
    manifest: null,
    summary: {},
    fileSummary: {},
    error: null,
    abort: new AbortController(),
    ticketGate,
    ticketResolver,
    ticketGateState: "open",
    ticketReused: false,
    secretsRestored: 0,
    archiveIdentity,
    archiveDigest: durableDigest,
    leaseOwner,
    leaseGeneration,
    stagingDbPath: join(dirname(opts.archivePath), "staging", "staging.sqlite"),
    completion,
    resolveCompletion: completionResolver,
    commitStarted: false,
  };
  JOBS.set(job.jobId, job);
  USER_RUNNING.set(job.userId, job.jobId);
  globalImportSlot = job.jobId;
  claimImportReservation(job.userId, job.jobId);
  void runImportJob(job).catch((err) => {
    console.error("[user-data import] uncaught:", err);
  });
  return job;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(job: ImportJob, type: EventType, payload: Record<string, any>): void {
  try {
    eventBus.emit(type, { jobId: job.jobId, ...payload }, job.userId);
  } catch {
    /* progress is best-effort */
  }
}

async function yieldAndCheck(signal: AbortSignal): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, YIELD_INTERVAL_MS));
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Staged entry metadata
//
// Text entries are few and retained in memory for topological application.
// Potentially numerous binary descriptors are journaled to disk instead.
// ---------------------------------------------------------------------------

interface BufferedTextEntry {
  kind: "text";
  table: string;
  origin: "database" | "lancedb";
  // Stored on disk to keep memory bounded.
  stagingPath: string;
  byteSize: number;
}

interface BufferedBinaryEntry {
  kind: "binary";
  bucket: NonNullable<SanitizedEntry["bucket"]>;
  inner: string;
  /** Row-bound destination path after archivePath normalization (artifacts). */
  destinationInner?: string;
  stagingPath: string;
  byteSize: number;
}
function cloneLogicalBinaryEntry(source: BufferedBinaryEntry, archivePath: string): BufferedBinaryEntry {
  const descriptor = sanitizeEntry(archivePath);
  if (descriptor.kind !== "files" || descriptor.bucket === undefined) {
    throw new Error(`binary file path is not canonical: ${archivePath}`);
  }
  return {
    ...source,
    bucket: descriptor.bucket,
    inner: descriptor.inner,
    destinationInner: undefined,
  };
}

interface ImportBuffer {
  entries: BufferedTextEntry[];
  /** Canonical payload paths observed in the ZIP central directory. */
  payloadPaths: Set<string>;
  binaryJournalPath: string;
  binaryEntryCount: number;
  manifest: ArchiveManifest | null;
  totalDecompressed: number;
  entryCount: number;
  stagingDir: string;
}
function legacyManifestSchemaVersion(buf: ImportBuffer): number | null {
  if (buf.manifest) return buf.manifest.schemaVersion;
  const manifestEntry = buf.entries.find((entry) => entry.table === "__manifest__");
  if (!manifestEntry) return null;
  try {
    const raw = JSON.parse(readCappedTextFile(manifestEntry.stagingPath, MAX_MANIFEST_BYTES, "manifest.json"));
    return parseManifest(raw).schemaVersion;
  } catch {
    return null;
  }
}

/** Write a complete Uint8Array even if the OS performs a short write. */
function writeAllSync(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = writeSync(fd, chunk, offset, chunk.byteLength - offset);
    if (written <= 0) throw new Error("archive staging write made no progress");
    offset += written;
  }
}

// ZIP uses the IEEE CRC-32 polynomial. Keep the running state inverted so
// chunks can be fed to it without allocating one concatenated entry buffer.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function updateCrc32(state: number, bytes: Uint8Array): number {
  let next = state;
  for (const byte of bytes) {
    next = (CRC32_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8)) >>> 0;
  }
  return next;
}

function finishCrc32(state: number): number {
  return (state ^ 0xffffffff) >>> 0;
}

const NDJSON_NEWLINE = new Uint8Array([0x0a]);

/**
 * Repair a narrow, known failure mode in pre-ZIP64 exports.
 *
 * The old fflate async writer occasionally duplicated portions of an NDJSON
 * stream while retaining the size and CRC of the intended stream. Every
 * affected Lumiverse table is ID-keyed, so retaining the first raw line for
 * each ID recreates the original byte stream. We only accept the repair when
 * it reproduces both pieces of ZIP metadata exactly; malformed or unrelated
 * archives continue through the normal validation failure.
 */
function crc32FileRange(path: string, offset: number, length: number, signal: AbortSignal): number {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0) return -1;
  const fd = openSync(path, "r");
  const buffer = new Uint8Array(ARCHIVE_READ_BYTES);
  let position = offset;
  let remaining = length;
  let state = 0xffffffff;
  try {
    while (remaining > 0) {
      if (signal.aborted) throw signal.reason ?? new Error("import cancelled");
      const wanted = Math.min(buffer.byteLength, remaining);
      const read = readSync(fd, buffer, 0, wanted, position);
      if (read !== wanted) return -1;
      state = updateCrc32(state, buffer.subarray(0, read));
      position += read;
      remaining -= read;
    }
    return finishCrc32(state);
  } finally {
    closeSync(fd);
  }
}

async function recoverLegacyDuplicatedNdjson(
  stagingPath: string,
  expectedSize: number,
  expectedCrc32: number,
  signal: AbortSignal,
): Promise<number | null> {
  // The compatibility repair is intentionally narrower than accepting a
  // CRC-mismatched entry. It is valid only when the malformed payload is an
  // integral number of exact copies of the central-directory payload and each
  // copy independently carries the recorded CRC32.
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) return null;
  const actualSize = statSync(stagingPath).size;
  if (actualSize <= expectedSize || actualSize % expectedSize !== 0) return null;
  const segmentCount = actualSize / expectedSize;
  if (!Number.isSafeInteger(segmentCount) || segmentCount > 32) return null;
  for (let segment = 0; segment < segmentCount; segment++) {
    const segmentCrc = crc32FileRange(stagingPath, segment * expectedSize, expectedSize, signal);
    if (segmentCrc !== expectedCrc32) return null;
  }
  const repairedPath = `${stagingPath}.recovered`;
  const readBuffer = new Uint8Array(ARCHIVE_READ_BYTES);
  const decoder = new TextDecoder();
  const seenIds = new Set<string>();
  const fragments: Uint8Array[] = [];
  let lineBytes = 0;
  let retainedBytes = 0;
  let crcState = 0xffffffff;
  let inputFd: number | null = null;
  let outputFd: number | null = null;
  let repaired = false;

  const appendFragment = (fragment: Uint8Array): boolean => {
    if (fragment.byteLength === 0) return true;
    if (lineBytes + fragment.byteLength > LEGACY_MAX_NDJSON_LINE_BYTES) return false;
    // The read buffer is reused, so retain a bounded copy for this line.
    fragments.push(fragment.slice());
    lineBytes += fragment.byteLength;
    return true;
  };

  const consumeLine = (): boolean => {
    if (lineBytes === 0) return false;
    const line = new Uint8Array(lineBytes);
    let offset = 0;
    for (const fragment of fragments) {
      line.set(fragment, offset);
      offset += fragment.byteLength;
    }
    fragments.length = 0;
    lineBytes = 0;

    let id: unknown;
    try {
      id = JSON.parse(decoder.decode(line))?.id;
    } catch {
      return false;
    }
    if (typeof id !== "string" || id.length === 0) return false;
    if (seenIds.has(id)) return true;
    seenIds.add(id);
    writeAllSync(outputFd!, line);
    writeAllSync(outputFd!, NDJSON_NEWLINE);
    crcState = updateCrc32(crcState, line);
    crcState = updateCrc32(crcState, NDJSON_NEWLINE);
    retainedBytes += line.byteLength + NDJSON_NEWLINE.byteLength;
    return true;
  };

  try {
    try {
      unlinkSync(repairedPath);
    } catch {
      /* no leftover repair file */
    }
    inputFd = openSync(stagingPath, "r");
    outputFd = openSync(repairedPath, "w");
    let position = 0;
    let bytesSinceYield = 0;

    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("import cancelled");
      const read = readSync(inputFd, readBuffer, 0, readBuffer.byteLength, position);
      if (read <= 0) break;
      position += read;
      bytesSinceYield += read;

      let start = 0;
      for (let i = 0; i < read; i++) {
        if (readBuffer[i] !== 0x0a) continue;
        if (!appendFragment(readBuffer.subarray(start, i)) || !consumeLine()) return null;
        start = i + 1;
      }
      if (!appendFragment(readBuffer.subarray(start, read))) return null;

      if (bytesSinceYield >= 4 * 1024 * 1024) {
        bytesSinceYield = 0;
        await yieldAndCheck(signal);
      }
    }

    // Lumiverse's exporter writes a newline after every NDJSON object. A
    // trailing partial line is not eligible for the compatibility repair.
    if (lineBytes !== 0) return null;
    if (retainedBytes !== expectedSize || finishCrc32(crcState) !== expectedCrc32) return null;

    closeSync(outputFd);
    outputFd = null;
    closeSync(inputFd);
    inputFd = null;
    renameSync(repairedPath, stagingPath);
    repaired = true;
    return retainedBytes;
  } finally {
    if (outputFd !== null) closeSync(outputFd);
    if (inputFd !== null) closeSync(inputFd);
    if (!repaired) {
      try {
        unlinkSync(repairedPath);
      } catch {
        /* no repair artifact to remove */
      }
    }
  }
}

function readExactSync(fd: number, position: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(fd, out, offset, length - offset, position + offset);
    if (read <= 0) throw new ArchiveValidationError("not_zip", "archive is truncated");
    offset += read;
  }
  return out;
}

function readCappedTextFile(path: string, maxBytes: number, label: string): string {
  const size = statSync(path).size;
  if (size > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  const fd = openSync(path, "r");
  try {
    return new TextDecoder().decode(readExactSync(fd, 0, size));
  } finally {
    closeSync(fd);
  }
}

function validateSecretIndex(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_SECRET_ENTRIES) {
    throw new Error("secret index exceeds entry cap");
  }
  const keys = raw as unknown[];
  const seen = new Set<string>();
  let bytes = 0;
  for (const key of keys) {
    if (typeof key !== "string") throw new Error("secret index is malformed");
    const keyBytes = Buffer.byteLength(key, "utf8");
    if (keyBytes > MAX_SECRET_KEY_BYTES || keyBytes > MAX_SECRET_BYTES - bytes) {
      throw new Error("secret index exceeds byte cap");
    }
    bytes += keyBytes;
    if (seen.has(key)) throw new Error("secret index has duplicate keys");
    seen.add(key);
  }
  return keys as string[];
}

function entryTextLimit(entry: BufferedTextEntry): number | null {
  switch (entry.table) {
    case "__manifest__":
      return MAX_MANIFEST_BYTES;
    case "__manifest_stats__":
      return MAX_MANIFEST_STATS_BYTES;
    case "__secrets_index__":
      return MAX_SECRETS_INDEX_BYTES;
    default:
      return null;
  }
}

function assertExtractionDiskCapacity(
  stagingDir: string,
  stagedBytes: number,
  binaryBytes: number,
  stagingSqliteBytes: number,
): void {
  try {
    const fs = statfsSync(stagingDir);
    // Binary files are staged first and copied into their final locations
    // before staging is removed, so their bytes are briefly present twice.
    // Canonical NDJSON is then materialized into a second SQLite copy; budget
    // that copy before extraction starts rather than discovering ENOSPC after
    // the archive has already consumed the disk.
    const required =
      BigInt(stagedBytes)
      + BigInt(binaryBytes)
      + BigInt(stagingSqliteBytes)
      + BigInt(IMPORT_DISK_HEADROOM_BYTES);
    const available = BigInt(fs.bavail) * BigInt(fs.bsize);
    if (available < required) {
      throw new Error(
        `insufficient free disk for import (need ${required} bytes, have ${available} bytes)`,
      );
    }
  } catch (err) {
    // The capacity error is actionable; an unsupported statfs implementation
    // should not prevent an otherwise-valid import from attempting its normal
    // write-time ENOSPC handling.
    if (err instanceof Error && err.message.startsWith("insufficient free disk")) {
      throw err;
    }
    console.warn("[user-data import] unable to preflight free disk space:", err);
  }
}

const LIVE_COMMIT_HEADROOM_BYTES = 256 * 1024 * 1024;
const LIVE_COMMIT_STAGED_MULTIPLIER = 2n;

type FilesystemCapacity = {
  bavail: number;
  bsize: number;
};
type FilesystemCapacityHook = (path: string) => FilesystemCapacity;
type StagingFootprintHook = (stageDb: Database) => bigint | null;
let filesystemCapacityHook: FilesystemCapacityHook | null = null;
let stagingFootprintHook: StagingFootprintHook | null = null;
type TicketZeroizationHook = (smk: Uint8Array) => void;
let ticketZeroizationHook: TicketZeroizationHook | null = null;
let portableSealedPresetResolverOverride: PortableSealedPresetResolver | null = null;
const zeroizedTicketValues = new WeakSet<object>();

function zeroizeTicketValue(value: TicketGateValue | null | undefined): void {
  if (!value || zeroizedTicketValues.has(value)) return;
  zeroizedTicketValues.add(value);
  try {
    value.smk.fill(0);
  } catch {
    /* ignore an already detached buffer */
  }
  // The verified ticket is a private copy. Clear its key-bearing strings
  // before dropping the gate reference; the caller's raw JSON is not retained.
  value.ticket.keyB64 = "";
  value.ticket.secretsHash = "";
  value.ticket.archiveId = "";
  value.ticket.issuerInstance = "";
  try {
    ticketZeroizationHook?.(value.smk);
  } catch {
    /* test instrumentation cannot affect import cleanup */
  }
}

function clearTicketGate(job: ImportJob): void {
  const resolver = job.ticketResolver;
  job.ticketResolver = undefined;
  job.ticketGate = undefined;
  if (job.ticketGateState === "open") {
    job.ticketGateState = "cancelled";
    try {
      resolver?.(null);
    } catch {
      /* an already-settled gate cannot be reopened */
    }
  }
}

function readFilesystemCapacity(path: string): FilesystemCapacity {
  if (filesystemCapacityHook) return filesystemCapacityHook(path);
  const fs = statfsSync(path);
  return { bavail: Number(fs.bavail), bsize: Number(fs.bsize) };
}


/**
 * Reserve the validated staged SQLite footprint for both the future live
 * database and its rollback/WAL copy before COMMIT. Existing database bytes
 * are already excluded from statfs free space and are intentionally ignored.
 */
function assertLiveCommitDiskCapacity(stageDb: Database): void {
  const stagedBytes = stagingFootprintHook?.(stageDb) ?? (() => {
    const pageCountRow = stageDb.query("PRAGMA page_count").get() as
      | { page_count?: unknown }
      | null;
    const pageSizeRow = stageDb.query("PRAGMA page_size").get() as
      | { page_size?: unknown }
      | null;
    const pageCount = pageCountRow?.page_count;
    const pageSize = pageSizeRow?.page_size;
    if (
      typeof pageCount !== "number"
      || !Number.isSafeInteger(pageCount)
      || pageCount <= 0
      || typeof pageSize !== "number"
      || !Number.isSafeInteger(pageSize)
      || pageSize <= 0
    ) {
      throw new Error("unable to estimate validated staging database size");
    }
    return BigInt(pageCount) * BigInt(pageSize);
  })();
  if (stagedBytes === null || stagedBytes < 0n) {
    throw new Error("unable to estimate validated staging database size");
  }
  if (stagedBytes > BigInt(MAX_STAGE_BYTES)) {
    throw new Error(`validated staging database exceeds ${MAX_STAGE_BYTES} bytes`);
  }

  const required = stagedBytes * LIVE_COMMIT_STAGED_MULTIPLIER + BigInt(LIVE_COMMIT_HEADROOM_BYTES);
  const maxRequired = BigInt(MAX_STAGE_BYTES) * LIVE_COMMIT_STAGED_MULTIPLIER + BigInt(LIVE_COMMIT_HEADROOM_BYTES);
  if (required > maxRequired) {
    throw new Error("live import commit capacity estimate overflow");
  }
  const capacity = readFilesystemCapacity(env.dataDir);
  if (
    !Number.isSafeInteger(capacity.bavail)
    || capacity.bavail < 0
    || !Number.isSafeInteger(capacity.bsize)
    || capacity.bsize <= 0
  ) {
    throw new Error("unable to determine live database free space");
  }
  const available = BigInt(capacity.bavail) * BigInt(capacity.bsize);
  if (available < required) {
    throw new Error(
      `insufficient free disk for live import commit (need ${required} bytes, have ${available} bytes)`,
    );
  }
}

/** Return the exact compressed-data range for one central-directory entry. */
function getLocalDataOffset(
  archiveFd: number,
  archiveSize: number,
  entry: CentralDirEntry,
): number {
  assertZipCompressedSizeBound(entry.compressedSize, entry.name);
  if (!isSafeZipNumber(entry.localHeaderOffset)) {
    throw new ArchiveValidationError("not_zip", `local file header offset is unsafe for ${entry.name}`);
  }
  if ((entry.flags & 0x1) !== 0) {
    throw new ArchiveValidationError("not_zip", `encrypted ZIP entries are not supported (${entry.name})`);
  }
  if (entry.compression !== 0 && entry.compression !== 8) {
    throw new ArchiveValidationError("not_zip", `unsupported ZIP compression method ${entry.compression}`);
  }
  if (entry.localHeaderOffset > archiveSize - 30) {
    throw new ArchiveValidationError("not_zip", `local file header is truncated for ${entry.name}`);
  }
  const header = readExactSync(archiveFd, entry.localHeaderOffset, 30);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, true) !== LFH_SIG) {
    throw new ArchiveValidationError("not_zip", `local file header signature invalid for ${entry.name}`);
  }
  const localFlags = view.getUint16(6, true);
  const localCompression = view.getUint16(8, true);
  if ((localFlags & 0x1) !== 0 || localCompression !== entry.compression) {
    throw new ArchiveValidationError("not_zip", `local file header disagrees with directory for ${entry.name}`);
  }
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  if (!isSafeZipNumber(dataStart) || dataStart > archiveSize - entry.compressedSize) {
    throw new ArchiveValidationError("not_zip", `entry data extends past end of archive (${entry.name})`);
  }
  const localName = new TextDecoder().decode(readExactSync(archiveFd, entry.localHeaderOffset + 30, nameLen));
  if (localName !== entry.name) {
    throw new ArchiveValidationError("not_zip", `local file name disagrees with directory for ${entry.name}`);
  }
  return dataStart;
}

async function copyStoredEntry(
  archiveFd: number,
  dataStart: number,
  compressedSize: number,
  onChunk: (chunk: Uint8Array) => void,
  signal: AbortSignal,
): Promise<void> {
  assertZipCompressedSizeBound(compressedSize, "stored ZIP entry");
  if (!isSafeZipNumber(dataStart)) {
    throw new ArchiveValidationError("not_zip", "stored ZIP entry data offset is unsafe");
  }
  const buffer = new Uint8Array(ARCHIVE_READ_BYTES);
  let offset = 0;
  let bytesSinceYield = 0;
  while (offset < compressedSize) {
    if (signal.aborted) throw signal.reason ?? new Error("import cancelled");
    const wanted = Math.min(buffer.byteLength, compressedSize - offset);
    const read = readSync(archiveFd, buffer, 0, wanted, dataStart + offset);
    if (read <= 0) throw new ArchiveValidationError("not_zip", "archive entry is truncated");
    onChunk(buffer.subarray(0, read));
    offset += read;
    bytesSinceYield += read;
    if (bytesSinceYield >= 4 * 1024 * 1024) {
      bytesSinceYield = 0;
      await yieldAndCheck(signal);
    }
  }
}

async function inflateEntry(
  archivePath: string,
  dataStart: number,
  compressedSize: number,
  onChunk: (chunk: Uint8Array) => void,
  signal: AbortSignal,
): Promise<void> {
  assertZipCompressedSizeBound(compressedSize, "deflated ZIP entry");
  if (!isSafeZipNumber(dataStart)) {
    throw new ArchiveValidationError("not_zip", "deflated ZIP entry data offset is unsafe");
  }
  if (compressedSize === 0) {
    // Empty entries are valid when their central-directory output size is
    // also zero; the caller validates that exact size after this returns.
    return;
  }
  const source = createReadStream(archivePath, {
    start: dataStart,
    end: dataStart + compressedSize - 1,
    highWaterMark: ARCHIVE_READ_BYTES,
  });
  const inflater = createInflateRaw({ chunkSize: INFLATE_OUTPUT_BYTES });
  source.pipe(inflater);
  try {
    for await (const chunk of inflater) {
      if (signal.aborted) throw signal.reason ?? new Error("import cancelled");
      onChunk(chunk as Uint8Array);
    }
  } finally {
    source.destroy();
    inflater.destroy();
  }
}

// ---------------------------------------------------------------------------
// Phase 1: extract archive into staging
// ---------------------------------------------------------------------------

async function extractArchive(job: ImportJob): Promise<ImportBuffer> {
  const stagingDir = join(dirname(job.archivePath), "staging");
  ensureDir(stagingDir);
  const binaryJournalPath = join(stagingDir, "binary-entries.ndjson");

  const buf: ImportBuffer = {
    entries: [],
    payloadPaths: new Set<string>(),
    binaryJournalPath,
    binaryEntryCount: 0,
    manifest: null,
    totalDecompressed: 0,
    entryCount: 0,
    stagingDir,
  };

  // Read the manifest before staging payloads; every V1/V2/V3 archive then
  // follows the bounded CRC-checked extraction and ownership/graph pipeline.
  const verifiedManifest = await verifyArchiveFast(job.archivePath);
  const archive = Bun.file(job.archivePath);
  const { size: archiveSize, cdOffset, cdSize, totalEntries } = await locateCentralDirectory(archive);
  let lastCentralEntryName: string | null = null;
  let statsEntry: BufferedTextEntry | null = null;
  let declaredDecompressedBytes = 0;
  let declaredBinaryBytes = 0;
  let declaredCanonicalDatabaseBytes = 0;
  for await (const entry of scanCentralDirectory(archive, cdOffset, cdSize, totalEntries)) {

    // Validate every name before allocating any staging files, and reject a
    // declared expansion beyond both the global and per-entry caps before
    // decompression begins.
    const descriptor = sanitizeEntry(entry.name);
    if (verifiedManifest.schemaVersion >= 2 && descriptor.kind === "manifest" && descriptor.inner === "manifest-stats.json") {
      throw new ArchiveValidationError("bad_manifest", "V2+ archives cannot contain unauthenticated manifest-stats.json");
    }

    const canonicalPath = descriptor.kind === "manifest"
      ? descriptor.inner
      : descriptor.kind === "database"
        ? `database/${descriptor.table}.ndjson`
        : descriptor.kind === "lancedb"
          ? `lancedb/${descriptor.table}.ndjson`
          : descriptor.kind === "secrets"
            ? `secrets/${descriptor.inner}`
            : `files/${descriptor.bucket}/${descriptor.inner}`;
    lastCentralEntryName = canonicalPath;
    if (buf.payloadPaths.has(canonicalPath)) {
      throw new ArchiveValidationError("bad_manifest", `duplicate archive entry name: ${canonicalPath}`);
    }
    buf.payloadPaths.add(canonicalPath);
    if (entry.uncompressedSize > MAX_ARCHIVE_FILE_BYTES) {
      throw new ArchiveValidationError(
        "size",
        `${canonicalPath} exceeds ${MAX_ARCHIVE_FILE_BYTES} bytes`,
      );
    }
    if (entry.uncompressedSize > MAX_DECOMPRESSED_BYTES - declaredDecompressedBytes) {
      throw new Error(`archive exceeds decompressed size cap (${MAX_DECOMPRESSED_BYTES} bytes)`);
    }
    declaredDecompressedBytes += entry.uncompressedSize;
    if (descriptor.kind === "files") declaredBinaryBytes += entry.uncompressedSize;
    if (descriptor.kind === "database") {
      declaredCanonicalDatabaseBytes += entry.uncompressedSize;
    }
  }
  const stagingSqliteBytes = STAGING_SQLITE_FIXED_BYTES
    + declaredCanonicalDatabaseBytes * STAGING_SQLITE_COPY_MULTIPLIER;
  if (
    !Number.isSafeInteger(stagingSqliteBytes)
    || stagingSqliteBytes < 0
    || declaredDecompressedBytes > MAX_STAGE_BYTES - stagingSqliteBytes
  ) {
    throw new ArchiveValidationError(
      "size",
      `archive staging footprint exceeds ${MAX_STAGE_BYTES} bytes including SQLite overhead`,
    );
  }
  assertExtractionDiskCapacity(stagingDir, declaredDecompressedBytes, declaredBinaryBytes, stagingSqliteBytes);

  const archiveFd = openSync(job.archivePath, "r");
  const journalFd = openSync(binaryJournalPath, "w");
  const encoder = new TextEncoder();

  try {
    for await (const centralEntry of scanCentralDirectory(archive, cdOffset, cdSize, totalEntries)) {
      if (job.abort.signal.aborted) {
        throw job.abort.signal.reason ?? new Error("import cancelled");
      }
      const descriptor = sanitizeEntry(centralEntry.name);
      buf.entryCount++;

      const stagingPath = join(stagingDir, `${buf.entryCount.toString(36)}.bin`);
      let entry: BufferedTextEntry | BufferedBinaryEntry;
      switch (descriptor.kind) {
        case "manifest":
          entry = {
            kind: "text",
            table: descriptor.inner === "manifest-stats.json" ? "__manifest_stats__" : "__manifest__",
            origin: "database",
            stagingPath,
            byteSize: 0,
          };
          break;
        case "database":
        case "lancedb":
          entry = {
            kind: "text",
            table: descriptor.table ?? "manifest",
            origin: descriptor.kind === "lancedb" ? "lancedb" : "database",
            stagingPath,
            byteSize: 0,
          };
          break;
        case "secrets":
          entry = {
            kind: "text",
            table: descriptor.inner === "encrypted.ndjson" ? "__secrets_encrypted__" : "__secrets_index__",
            origin: "database",
            stagingPath,
            byteSize: 0,
          };
          break;
        case "files":
          entry = {
            kind: "binary",
            bucket: descriptor.bucket!,
            inner: descriptor.inner,
            stagingPath,
            byteSize: 0,
          };
          break;
      }

      const textLimit = entry.kind === "text" ? entryTextLimit(entry) : null;
      const recordLimit =
        entry.kind === "text" && textLimit === null
          ? ndjsonLineLimitForManifest(verifiedManifest)
          : null;
      if (textLimit !== null && centralEntry.uncompressedSize > textLimit) {
        throw new Error(`${centralEntry.name} exceeds ${textLimit} bytes`);
      }
      if (entry.kind === "text" && buf.entries.length >= MAX_TEXT_ENTRIES) {
        throw new Error(`archive contains too many text entries (>${MAX_TEXT_ENTRIES})`);
      }

      const dataStart = getLocalDataOffset(archiveFd, archiveSize, centralEntry);
      const stagingFd = openSync(stagingPath, "w");
      let crcState = 0xffffffff;
      let recordBytes = 0;
      try {
        const onChunk = (chunk: Uint8Array) => {
          if (buf.totalDecompressed + chunk.byteLength > MAX_DECOMPRESSED_BYTES) {
            throw new Error(`archive exceeds decompressed size cap (${MAX_DECOMPRESSED_BYTES} bytes)`);
          }
          if (textLimit !== null && entry.byteSize + chunk.byteLength > textLimit) {
            throw new Error(`${centralEntry.name} exceeds ${textLimit} bytes`);
          }
          if (recordLimit !== null) {
            let segmentStart = 0;
            for (let offset = 0; offset < chunk.byteLength; offset++) {
              if (chunk[offset] !== 0x0a) continue;
              const segmentBytes = offset - segmentStart;
              if (recordBytes > recordLimit - segmentBytes) {
                throw new Error(`NDJSON line exceeds ${recordLimit} bytes`);
              }
              recordBytes = 0;
              segmentStart = offset + 1;
            }
            const trailingBytes = chunk.byteLength - segmentStart;
            if (recordBytes > recordLimit - trailingBytes) {
              throw new Error(`NDJSON line exceeds ${recordLimit} bytes`);
            }
            recordBytes += trailingBytes;
          }
          writeAllSync(stagingFd, chunk);
          crcState = updateCrc32(crcState, chunk);
          entry.byteSize += chunk.byteLength;
          buf.totalDecompressed += chunk.byteLength;
        };
        if (centralEntry.compression === 0) {
          await copyStoredEntry(
            archiveFd,
            dataStart,
            centralEntry.compressedSize,
            onChunk,
            job.abort.signal,
          );
        } else {
          await inflateEntry(
            job.archivePath,
            dataStart,
            centralEntry.compressedSize,
            onChunk,
            job.abort.signal,
          );
        }
      } finally {
        closeSync(stagingFd);
      }

      let actualByteSize = entry.byteSize;
      let actualCrc32 = finishCrc32(crcState);
      const needsLegacyRepair = actualByteSize !== centralEntry.uncompressedSize || actualCrc32 !== centralEntry.crc32;
      if (
        needsLegacyRepair
        && entry.kind === "text"
        && centralEntry.name.startsWith("database/")
        && centralEntry.name.endsWith(".ndjson")
        && legacyManifestSchemaVersion(buf) === 1
      ) {
        const repairedSize = await recoverLegacyDuplicatedNdjson(
          stagingPath,
          centralEntry.uncompressedSize,
          centralEntry.crc32,
          job.abort.signal,
        );
        if (repairedSize !== null) {
          actualByteSize = repairedSize;
          actualCrc32 = centralEntry.crc32;
          entry.byteSize = repairedSize;
        }
      }
      if (actualByteSize !== centralEntry.uncompressedSize) {
        throw new ArchiveValidationError(
          "not_zip",
          `entry size disagrees with central directory (${centralEntry.name}; declared ${centralEntry.uncompressedSize}, extracted ${actualByteSize})`,
        );
      }
      if (actualCrc32 !== centralEntry.crc32) {
        throw new ArchiveValidationError(
          "not_zip",
          `entry CRC32 disagrees with central directory (${centralEntry.name})`,
        );
      }
      if (entry.kind === "binary") {
        writeAllSync(journalFd, encoder.encode(`${JSON.stringify(entry)}\n`));
        buf.binaryEntryCount++;
      } else {
        buf.entries.push(entry);
        if (entry.table === "__manifest_stats__") statsEntry = entry;
      }

      if ((buf.entryCount & 15) === 0) await yieldAndCheck(job.abort.signal);
    }
  } finally {
    closeSync(journalFd);
    closeSync(archiveFd);
  }

  // Find and parse the manifest. If absent the archive is invalid.
  const manifestEntry = buf.entries.find((e) => e.table === "__manifest__");
  if (!manifestEntry) {
    throw new Error("archive is missing manifest.json");
  }
  const manifestText = readCappedTextFile(manifestEntry.stagingPath, MAX_MANIFEST_BYTES, "manifest.json");
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${(err as Error).message}`);
  }
  buf.manifest = parseManifest(raw);
  if (buf.manifest.schemaVersion === 3 && lastCentralEntryName !== "manifest.json") {
    throw new ArchiveValidationError("bad_manifest", "V3 manifest.json must be the final ZIP central-directory entry");
  }

  // Only V1 may carry the unauthenticated compatibility trailer. V2+
  // manifests are closed ledgers and reject manifest-stats.json outright.
  if (statsEntry && buf.manifest.schemaVersion >= 2) {
    throw new ArchiveValidationError("bad_manifest", "V2+ archives cannot contain unauthenticated manifest-stats.json");
  }
  if (statsEntry) {
    try {
      const statsText = readCappedTextFile(
        statsEntry.stagingPath,
        MAX_MANIFEST_STATS_BYTES,
        "manifest-stats.json",
      );
      const stats = JSON.parse(statsText) as {
        counts?: Record<string, number>;
        missingFiles?: string[];
      };
      if (stats?.counts) buf.manifest.counts = stats.counts;
      if (Array.isArray(stats?.missingFiles)) buf.manifest.missingFiles = stats.missingFiles;
    } catch {
      /* trailer is optional; ignore parse failure */
    }
  }

  return buf;
}

// ---------------------------------------------------------------------------
// Phase 2: apply database rows in topological order
// ---------------------------------------------------------------------------


/**
 * V3 archives negotiate the exact enforced record ceiling explicitly. V1/V2
 * may omit the marker or advertise a smaller positive ceiling, while the
 * hard compatibility ceiling remains bounded at 64 MiB.
 */
function ndjsonLineLimitForManifest(manifest: ArchiveManifest | null): number {
  if (
    manifest
    && manifest.schemaVersion <= 2
    && manifest.ndjsonMaxRecordBytes !== undefined
  ) {
    return manifest.ndjsonMaxRecordBytes;
  }
  if (
    (manifest?.schemaVersion ?? 0) >= 2
    && manifest?.ndjsonFormatVersion === NDJSON_FORMAT_VERSION
    && manifest.ndjsonMaxRecordBytes !== undefined
  ) {
    return manifest.ndjsonMaxRecordBytes;
  }
  return LEGACY_MAX_NDJSON_LINE_BYTES;
}


/**
 * Deep-merge an imported settings.value JSON onto an existing one. Designed
 * for "container" settings like `imageGeneration` where the value is a flat
 * config object with one or more id-keyed arrays nested inside (e.g.
 * `promptPresets`). The merge rules:
 *
 *   - Top-level scalar fields: existing wins (preserves the target user's
 *     explicit choices like activeImageGenConnectionId, fade times, etc.).
 *   - Top-level fields missing on the target: restored from the imported value.
 *   - Top-level arrays whose elements all carry an `id` string: union by id,
 *     existing items preserved verbatim, imported items appended in their
 *     archive order.
 *   - Non-object values (strings, numbers, plain arrays, scalars at top): the
 *     existing value wins.
 *
 * The merge is intentionally non-destructive on the target. A user who set
 * up image-gen on the target before importing keeps their connection ID,
 * thresholds, etc., but gains all of the prompt presets they previously
 * authored on the source instance — so persona/character bindings that
 * reference those preset IDs resolve cleanly instead of 404'ing.
 */
function defineOwnSettingField(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function mergeSettingValue(existingValue: unknown, importedValue: unknown): unknown {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  // An id-shaped array: every element is an object carrying an `id` string.
  // The "shape" gets inferred from the imported side (which definitely has
  // contents) — that way an EMPTY existing array (e.g. promptPresets: []
  // auto-written by getImageGenSettings before the user has authored any
  // presets) still picks up the imported items instead of winning by being
  // a no-op array.
  const isIdArray = (v: unknown): v is Array<Record<string, unknown>> =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => x && typeof x === "object" && typeof (x as any).id === "string");
  const isIdArrayOrEmpty = (v: unknown): v is Array<Record<string, unknown>> =>
    Array.isArray(v) &&
    v.every((x) => x && typeof x === "object" && typeof (x as any).id === "string");

  if (!isPlainObject(existingValue) || !isPlainObject(importedValue)) {
    return existingValue;
  }

  // Object.hasOwn is part of the merge contract. Inherited Object.prototype
  // fields such as __proto__ and constructor do not count as destination
  // values, and every write uses a data property on a null-prototype target.
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, existingField] of Object.entries(existingValue)) {
    defineOwnSettingField(result, key, existingField);
  }
  for (const [key, importedField] of Object.entries(importedValue)) {
    const hasExistingField = Object.hasOwn(existingValue, key);
    const existingField = hasExistingField ? existingValue[key] : undefined;
    if (!hasExistingField || existingField === undefined || existingField === null) {
      defineOwnSettingField(result, key, importedField);
      continue;
    }
    // Merge an id-keyed array if the imported side actually has shape (so
    // we can tell it's meant to be id-merged), and the existing side is
    // either also an id-array or an empty array we can union into.
    if (isIdArray(importedField) && isIdArrayOrEmpty(existingField)) {
      const seen = new Set<string>();
      const merged: Array<Record<string, unknown>> = [];
      for (const item of existingField) {
        const id = String(item.id);
        if (!seen.has(id)) {
          merged.push(item);
          seen.add(id);
        }
      }
      for (const item of importedField) {
        const id = String(item.id);
        if (!seen.has(id)) {
          merged.push(item);
          seen.add(id);
        }
      }
      defineOwnSettingField(result, key, merged);
      continue;
    }
    // Default: existing wins for this field.
  }
  return result;
}

/**
 * Settings have a composite PK (key, user_id) and the `value` column is a
 * TEXT-encoded JSON blob. INSERT OR IGNORE on conflict means a target row
 * that the app auto-populates (e.g. `imageGeneration` on first image-gen
 * access) silently swallows the imported value — losing nested data like
 * the `promptPresets` array. We handle settings explicitly: parse both
 * sides, deep-merge with `mergeSettingValue`, and UPSERT.
 */
type FileOmissionPolicy = "null_reference" | "skip_dependent_row" | "preserve_absent";

interface StagedFilePlan {
  required: boolean;
  omissionPolicy: FileOmissionPolicy | null;
  missing: boolean;
  restoredPath: string | null;
}

interface StagedArchive {
  dbPath: string;
  db: Database;
  files: BufferedBinaryEntry[];
  vectorEntries: BufferedTextEntry[];
  secretIndex: string[];
  secretEntry: BufferedTextEntry | null;
  rowCounts: Record<string, number>;
  filePlans: Map<string, StagedFilePlan>;
}

interface PreparedSecret {
  key: string;
  encrypted_value: string;
  iv: string;
  tag: string;
}

function getTableColumnsFrom(db: Database, table: string): Array<{ name: string; type: string; notnull: number; dflt_value: unknown }> {
  return db.query(`PRAGMA table_info(${ident(table)})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }>;
}

function sqliteTableExists(db: Database, table: string): boolean {
  return !!db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function registryKind(spec: unknown): string {
  return typeof spec === "object" && spec !== null && typeof (spec as any).kind === "string"
    ? (spec as any).kind
    : "unknown";
}

function registryKeys(spec: unknown): string[][] {
  if (!spec || typeof spec !== "object") return [];
  const value = spec as any;
  const keys: string[][] = [];
  if (Array.isArray(value.primaryKey) && value.primaryKey.every((x: unknown) => typeof x === "string")) keys.push(value.primaryKey);
  if (Array.isArray(value.uniqueKeys)) {
    for (const key of value.uniqueKeys) if (Array.isArray(key) && key.every((x) => typeof x === "string")) keys.push(key);
  }
  return keys;
}

function normalizeRepairCodedRegexRow(
  table: string,
  normalized: Record<string, unknown>,
  columns: ReadonlySet<string>,
): void {
  if (table !== "regex_scripts") return;
  const code = normalized.validation_error_code;
  if (typeof code !== "string" || code.trim().length === 0) return;
  if (!columns.has("disabled")) {
    throw new Error("repair-coded regex row has no disabled column");
  }
  // A repair-coded row is retained for user repair, but it is never executable.
  normalized.disabled = 1;
}

function registryOwner(spec: unknown): any {
  return spec && typeof spec === "object" ? (spec as any).owner : null;
}

function registryParentEdges(spec: unknown): any[] {
  const edges = spec && typeof spec === "object" ? (spec as any).parentEdges : null;
  return Array.isArray(edges) ? edges : [];
}

function registryMergePolicy(spec: unknown): "upsert" | "insert_only" | "rebuild" | "discard" {
  const policy = spec && typeof spec === "object" ? (spec as any).mergePolicy : null;
  if (
    policy === "upsert"
    || policy === "insert_only"
    || policy === "rebuild"
    || policy === "discard"
  ) {
    return policy;
  }
  throw new Error("archive registry merge policy is malformed");
}

const MAX_SQL_REAL = Number.MAX_SAFE_INTEGER;
const MAX_SQL_BLOB_BYTES = Math.min(MAX_ARCHIVE_FILE_BYTES, NDJSON_MAX_RECORD_BYTES);
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function sqliteStorageClass(type: string): "integer" | "real" | "text" | "blob" | "numeric" {
  const upper = type.trim().toUpperCase();
  if (upper.includes("INT")) return "integer";
  if (upper.includes("CHAR") || upper.includes("CLOB") || upper.includes("TEXT")) return "text";
  if (upper.includes("BLOB") || upper.length === 0) return "blob";
  if (upper.includes("REAL") || upper.includes("FLOA") || upper.includes("DOUB")) return "real";
  return "numeric";
}

function decodeArchiveBlob(value: string): Uint8Array {
  const maxEncodedBytes = Math.ceil(MAX_SQL_BLOB_BYTES / 3) * 4;
  if (value.length > maxEncodedBytes || value.length % 4 !== 0 || !BASE64_RE.test(value)) {
    throw new Error("blob column contains a non-canonical base64 encoding");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > MAX_SQL_BLOB_BYTES || decoded.toString("base64") !== value) {
    throw new Error("blob column contains a non-canonical base64 encoding");
  }
  return decoded;
}

function normalizeSqlValue(value: unknown, type: string): unknown {
  if (value === null) return null;
  const storageClass = sqliteStorageClass(type);
  if (storageClass === "integer") {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (!Number.isSafeInteger(value)) throw new Error("integer column contains an unsafe integer");
    return value;
  }
  if (storageClass === "real") {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_SQL_REAL) {
      throw new Error("real column contains an out-of-range number");
    }
    return value;
  }
  if (storageClass === "text") {
    if (typeof value !== "string") throw new Error("text column contains a non-string value");
    return value;
  }
  if (storageClass === "blob") {
    if (typeof value !== "string") throw new Error("blob column contains a non-string encoding");
    return decodeArchiveBlob(value);
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_SQL_REAL) {
    throw new Error("numeric column contains an out-of-range number");
  }
  return value;
}
function sqlBinding(value: unknown): SQLQueryBindings {
  if (value === undefined) return null;
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "bigint"
    || typeof value === "boolean"
    || value instanceof Uint8Array
  ) return value;
  throw new Error("unsupported SQLite binding");
}
function systemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
function defaultSqlValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  let literal = String(value).trim();
  while (literal.startsWith("(") && literal.endsWith(")")) literal = literal.slice(1, -1).trim();
  if (/^null$/i.test(literal)) return null;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(literal)) return Number(literal);
  if (literal.startsWith("'") && literal.endsWith("'")) return literal.slice(1, -1).replace(/''/g, "'");
  if (literal.startsWith("\"") && literal.endsWith("\"")) return literal.slice(1, -1).replace(/""/g, "\"");
  if (/^unixepoch\(\)$/i.test(literal)) return nowSeconds();
  if (/^current_timestamp$/i.test(literal)) return new Date().toISOString().slice(0, 19).replace("T", " ");
  if (/^current_date$/i.test(literal)) return new Date().toISOString().slice(0, 10);
  if (/^current_time$/i.test(literal)) return new Date().toISOString().slice(11, 19);
  throw new Error(`unsupported SQLite default expression: ${literal}`);
}

function createStagedTable(stage: Database, live: Database, table: string): Array<{ name: string; type: string; notnull: number; dflt_value: unknown }> {
  const columns = getTableColumnsFrom(live, table);
  if (columns.length === 0) throw new Error(`table ${table} has no columns`);
  const definitions = columns.map((column) => {
    const declared = column.type.trim() || "BLOB";
    const name = ident(column.name);
    const storageClass = sqliteStorageClass(declared);
    const check = storageClass === "integer"
      ? `(${name} IS NULL OR (typeof(${name}) = 'integer' AND abs(${name}) <= ${MAX_SQL_REAL}))`
      : storageClass === "real"
        ? `(${name} IS NULL OR (typeof(${name}) IN ('real', 'integer') AND abs(${name}) <= ${MAX_SQL_REAL}))`
        : storageClass === "text"
          ? `(${name} IS NULL OR typeof(${name}) = 'text')`
          : storageClass === "blob"
            ? `(${name} IS NULL OR typeof(${name}) = 'blob')`
            : `(${name} IS NULL OR (typeof(${name}) IN ('integer', 'real') AND abs(${name}) <= ${MAX_SQL_REAL}))`;
    return `${name} ${declared}${column.notnull ? " NOT NULL" : ""} CHECK ${check}`;
  });
  stage.run(`CREATE TABLE ${ident(table)} (${definitions.join(", ")})`);
  const spec = getArchiveTableSpec(table);
  let index = 0;
  for (const key of registryKeys(spec)) {
    if (key.length === 0 || key.some((column) => !columns.some((c) => c.name === column))) throw new Error(`registry key for ${table} is not present in SQLite schema`);
    stage.run(`CREATE UNIQUE INDEX ${ident(`idx_stage_${table}_${index++}`)} ON ${ident(table)} (${key.map(ident).join(", ")})`);
  }
  return columns;
}

const IMPORT_VALIDATION_BATCH_ROWS = 256;
const IMPORT_VALIDATION_BATCH_BYTES = 4 * 1024 * 1024;
/** Vector rows are derived and never enter live storage, but their archive
 * representation is still parsed under a much smaller bounded contract. */
const MAX_VECTOR_DIMENSION = 16_384;
const MAX_VECTOR_ROW_BYTES = 8 * 1024 * 1024;
const MAX_VECTOR_STRING_BYTES = 1 * 1024 * 1024;
const MAX_VECTOR_ID_BYTES = 4 * 1024;
const MAX_VECTOR_DECODED_BYTES = 512 * 1024 * 1024;
const MAX_VECTOR_BATCH_BYTES = 4 * 1024 * 1024;
const SUPPORTED_VECTOR_PROVIDERS = new Set([
  "openai-compatible",
  "openai",
  "openrouter",
  "electronhub",
  "bananabread",
  "nanogpt",
  "google_vertex",
]);

type VectorArchiveContext = {
  userId: string;
  sourceOwner: string;
  expectedDimension: number | null;
};

type ValidatedVectorArchiveRow = {
  dimension: number;
  decodedBytes: number;
};
function boundedUtf8(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vector ${label} is malformed`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) throw new Error(`vector ${label} exceeds ${maxBytes} bytes`);
  return value;
}

function validateVectorArchiveRowShape(
  row: Record<string, unknown>,
  context: VectorArchiveContext,
  seenIds?: Set<string>,
): ValidatedVectorArchiveRow {
  const userId = boundedUtf8(row.user_id, "user_id", MAX_VECTOR_ID_BYTES);
  const sourceType = boundedUtf8(row.source_type, "source_type", MAX_VECTOR_ID_BYTES);
  const sourceId = boundedUtf8(row.source_id, "source_id", MAX_VECTOR_ID_BYTES);
  boundedUtf8(row.owner_id, "owner_id", MAX_VECTOR_ID_BYTES);
  const id = boundedUtf8(row.id, "id", MAX_VECTOR_ID_BYTES);
  const chunkIndex = row.chunk_index;
  if (!Number.isSafeInteger(chunkIndex) || Number(chunkIndex) < 0 || Number(chunkIndex) > MAX_VECTOR_DIMENSION) {
    throw new Error("vector chunk_index is out of range");
  }
  const allowedSourceTypes = new Set([
    "chat_chunk",
    "world_book_entry",
    "vault_chunk",
    "databank",
    "memory_consolidation",
    "memory_vector",
  ]);
  if (!allowedSourceTypes.has(sourceType)) throw new Error(`vector source_type is unsupported: ${sourceType}`);
  if (userId !== context.sourceOwner) throw new Error("vector row is owned by another user");
  const expectedId = `${context.sourceOwner}:${sourceType}:${sourceId}:${chunkIndex}`;
  if (id !== expectedId) throw new Error("vector row id does not match its owner and source");
  if (seenIds?.has(id)) throw new Error(`duplicate vector row id: ${id}`);
  seenIds?.add(id);

  const content = boundedUtf8(row.content, "content", MAX_VECTOR_STRING_BYTES);
  const metadata = boundedUtf8(row.metadata_json, "metadata_json", MAX_VECTOR_STRING_BYTES);
  try {
    const parsed = JSON.parse(metadata);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("metadata must be an object");
    }
  } catch {
    throw new Error("vector metadata_json is malformed");
  }
  if (!Number.isSafeInteger(row.updated_at) || Number(row.updated_at) < 0) {
    throw new Error("vector updated_at is out of range");
  }
  if (!Array.isArray(row.vector)) throw new Error("vector payload is not an array");
  const dimension = row.vector.length;
  if (dimension <= 0 || dimension > MAX_VECTOR_DIMENSION) throw new Error("vector dimension exceeds cap");
  if (context.expectedDimension !== null && dimension !== context.expectedDimension) {
    throw new Error("vector dimension does not match embedding identity");
  }
  for (const value of row.vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("vector contains a non-finite element");
    }
  }
  const decodedBytes = dimension * Float32Array.BYTES_PER_ELEMENT;
  const rowBytes = checkedValidationBytes(row);
  if (rowBytes > MAX_VECTOR_ROW_BYTES) throw new Error("vector row exceeds byte cap");
  if (rowBytes > MAX_VECTOR_BATCH_BYTES) throw new Error("vector batch byte cap exceeded");
  if (decodedBytes > MAX_VECTOR_DECODED_BYTES) throw new Error("vector decoded bytes exceed cap");
  // Keep these references live so a future compiler cannot accidentally
  // optimize away the bounded string accounting above.
  void content;
  return { dimension, decodedBytes };
}
const MAX_LEGACY_VECTOR_B64_BYTES = 4 * Math.ceil((MAX_VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT) / 3) + 4;

function validateLegacyVectorArchiveRow(
  row: Record<string, unknown>,
  expectedDimension: number | null,
): { dimension: number; decodedBytes: number } {
  const id = boundedUtf8(row.id, "id", MAX_VECTOR_ID_BYTES);
  const sourceType = boundedUtf8(row.source_type, "source_type", MAX_VECTOR_ID_BYTES);
  const sourceId = boundedUtf8(row.source_id, "source_id", MAX_VECTOR_ID_BYTES);
  const ownerId = boundedUtf8(row.owner_id, "owner_id", MAX_VECTOR_ID_BYTES);
  if (!id || !sourceId || !ownerId) throw new Error("legacy vector identity is malformed");
  if (!["chat_chunk", "world_book_entry", "vault_chunk", "databank"].includes(sourceType)) {
    throw new Error(`legacy vector source_type is unsupported: ${sourceType}`);
  }
  const chunkIndex = row.chunk_index;
  if (!Number.isSafeInteger(chunkIndex) || Number(chunkIndex) < 0 || Number(chunkIndex) > MAX_VECTOR_DIMENSION) {
    throw new Error("legacy vector chunk_index is out of range");
  }
  const content = boundedUtf8(row.content, "content", MAX_VECTOR_STRING_BYTES);
  const metadata = boundedUtf8(row.metadata_json, "metadata_json", MAX_VECTOR_STRING_BYTES);
  try {
    const parsed = JSON.parse(metadata);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("metadata must be an object");
    }
  } catch {
    throw new Error("legacy vector metadata_json is malformed");
  }
  void content;
  const encoded = boundedUtf8(row.vector_b64, "vector_b64", MAX_LEGACY_VECTOR_B64_BYTES);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw new Error("legacy vector_b64 is not valid base64");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 0 || decoded.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("legacy vector_b64 has invalid byte length");
  }
  const dimension = decoded.length / Float32Array.BYTES_PER_ELEMENT;
  if (dimension <= 0 || dimension > MAX_VECTOR_DIMENSION) {
    throw new Error("legacy vector dimension exceeds cap");
  }
  if (expectedDimension !== null && dimension !== expectedDimension) {
    throw new Error("legacy vector dimension does not match embedding identity");
  }
  for (let offset = 0; offset < decoded.length; offset += Float32Array.BYTES_PER_ELEMENT) {
    if (!Number.isFinite(decoded.readFloatLE(offset))) {
      throw new Error("legacy vector contains a non-finite element");
    }
  }
  const rowBytes = checkedValidationBytes(row);
  if (rowBytes > MAX_VECTOR_ROW_BYTES) throw new Error("legacy vector row exceeds byte cap");
  if (rowBytes > MAX_VECTOR_BATCH_BYTES) throw new Error("legacy vector batch byte cap exceeded");
  return { dimension, decodedBytes: decoded.byteLength };
}
function assertVectorCanonicalSource(
  stage: Database,
  sourceType: string,
  sourceId: string,
  ownerId: string,
  sourceOwner?: string,
): void {
  const ownerTable = sourceType === "world_book_entry"
    ? "world_books"
    : sourceType === "vault_chunk"
      ? "cortex_vaults"
      : sourceType === "databank"
        ? "databanks"
        : "chats";
  if (!sqliteTableExists(stage, ownerTable)) throw new Error(`vector owner table is unavailable: ${ownerTable}`);
  if (!stage.query(`SELECT 1 FROM ${ident(ownerTable)} WHERE id = ?`).get(ownerId)) {
    throw new Error("vector owner is not a staged canonical row");
  }
  if (sourceOwner !== undefined) {
    const owner = stage.query(
      `SELECT user_id FROM ${ident(ownerTable)} WHERE id = ?`,
    ).get(ownerId) as { user_id?: unknown } | null;
    if (!owner || owner.user_id !== sourceOwner) {
      throw new Error("vector owner is not owned by the archive user");
    }
  }
  const sourceTable = sourceType === "chat_chunk"
    ? "chat_chunks"
    : sourceType === "world_book_entry"
      ? "world_book_entries"
      : sourceType === "vault_chunk"
        ? "cortex_vault_chunks"
        : sourceType === "databank"
          ? "databank_chunks"
          : sourceType === "memory_consolidation" || sourceType === "memory_vector"
            ? "memory_consolidations"
            : null;
  const parentColumn = sourceType === "chat_chunk"
    ? "chat_id"
    : sourceType === "world_book_entry"
      ? "world_book_id"
      : sourceType === "vault_chunk"
        ? "vault_id"
        : sourceType === "databank"
          ? "databank_id"
          : sourceTable
            ? "chat_id"
            : null;
  if (!sourceTable || !parentColumn || !sqliteTableExists(stage, sourceTable)) {
    throw new Error("vector source table is not present in the staged canonical archive");
  }
  {
    const source = stage.query(
      `SELECT ${ident(parentColumn)} AS owner_id FROM ${ident(sourceTable)} WHERE id = ?`,
    ).get(sourceId) as { owner_id?: unknown } | null;
    if (!source || source.owner_id !== ownerId) {
      throw new Error("vector source ID is not owned by its staged canonical owner");
    }
  }
}


function validateVectorArchiveIdentity(
  manifest: ArchiveManifest,
  vectorEntriesPresent: boolean,
): number | null {
  if (!vectorEntriesPresent || manifest.schemaVersion < 3) return null;
  const config = manifest.embeddingConfig;
  if (
    !config
    || typeof config.provider !== "string"
    || !SUPPORTED_VECTOR_PROVIDERS.has(config.provider)
    || typeof config.model !== "string"
    || config.model.trim().length === 0
  ) {
    throw new Error("vector embedding identity is unsupported");
  }
  const configDimension = config.dimension;
  if (
    configDimension !== null
    && (!Number.isSafeInteger(configDimension) || configDimension <= 0 || configDimension > MAX_VECTOR_DIMENSION)
  ) {
    throw new Error("vector embedding dimension is unsupported");
  }
  if (manifest.embeddingIdentity && typeof manifest.embeddingIdentity === "object") {
    const identity = manifest.embeddingIdentity;
    if (
      identity.provider !== null && identity.provider !== config.provider
      || identity.model !== null && identity.model !== config.model
      || identity.dimension !== null && identity.dimension !== configDimension
    ) {
      throw new Error("vector embedding identity does not match its configuration");
    }
  }
  return configDimension;
}

async function validateAndDiscardVectorEntries(
  job: ImportJob,
  manifest: ArchiveManifest,
  entries: readonly BufferedTextEntry[],
  stage: Database,
  sourceOwner: string | null,
): Promise<void> {
  if (entries.length === 0) return;
  const legacy = manifest.schemaVersion === 1;
  if (!legacy && !sourceOwner) throw new Error("vector archive has no canonical owner");
  const expectedDimension = validateVectorArchiveIdentity(manifest, true);
  const context: VectorArchiveContext = {
    userId: job.userId,
    sourceOwner: sourceOwner ?? "",
    expectedDimension,
  };
  const seenIds = new Set<string>();
  let totalRows = 0;
  let inferredDimension = expectedDimension;
  let decodedBytes = 0;
  let batchBytes = 0;
  const state = createValidationYieldState();
  for (const entry of entries) {
    if (!getArchiveVectorTables().includes(entry.table)) {
      throw new Error(`vector table is not importable: ${entry.table}`);
    }
    let rows = 0;
    for await (const raw of readNdjsonEntries(entry.stagingPath, job.abort.signal, validationDeadlineForJob(job), job)) {
      checkImportBudget(job.abort.signal, validationDeadlineForJob(job));
      if (rows >= MAX_ROWS_PER_TABLE || totalRows >= MAX_STAGED_ROWS) {
        throw new Error(`vector row count exceeds cap: ${entry.table}`);
      }
      let validated: ValidatedVectorArchiveRow;
      if (legacy) {
        try {
          validated = validateLegacyVectorArchiveRow(raw, inferredDimension);
        } catch {
          // Legacy V1 rows have no authenticated tenant binding and are never
          // restored. A validly checksummed optional entry degrades to rebuild.
          rows++;
          totalRows++;
          const malformedBytes = checkedValidationBytes(raw);
          batchBytes += malformedBytes;
          await yieldValidationBatch(
            job.abort.signal,
            validationDeadlineForJob(job),
            job,
            state,
            malformedBytes,
            Number.POSITIVE_INFINITY,
          );
          if (batchBytes >= MAX_VECTOR_BATCH_BYTES) {
            batchBytes = 0;
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            checkImportBudget(job.abort.signal, validationDeadlineForJob(job));
          }
          continue;
        }
      } else {
        validated = validateVectorArchiveRowShape(raw, {
          ...context,
          expectedDimension: inferredDimension,
        }, seenIds);
        assertVectorCanonicalSource(
          stage,
          String(raw.source_type),
          String(raw.source_id),
          String(raw.owner_id),
          sourceOwner!,
        );
      }
      if (inferredDimension === null) inferredDimension = validated.dimension;
      if (decodedBytes > MAX_VECTOR_DECODED_BYTES - validated.decodedBytes) {
        throw new Error("vector decoded bytes exceed cap");
      }
      decodedBytes += validated.decodedBytes;
      const rowBytes = checkedValidationBytes(raw);
      batchBytes += rowBytes;
      rows++;
      totalRows++;
      await yieldValidationBatch(
        job.abort.signal,
        validationDeadlineForJob(job),
        job,
        state,
        rowBytes,
        Number.POSITIVE_INFINITY,
      );
      if (batchBytes >= MAX_VECTOR_BATCH_BYTES) {
        batchBytes = 0;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        checkImportBudget(job.abort.signal, validationDeadlineForJob(job));
      }
    }
  }
  // No vector row or payload is retained in the staged relational database;
  // post-receipt rebuilds are the only projection path.
}
const IMPORT_VALIDATION_BATCH_MS = 25;
const IMPORT_VALIDATION_WALL_MS = 30 * 60 * 1_000;

interface ValidationYieldState {
  rows: number;
  bytes: number;
  startedAt: number;
}

function validationDeadlineForJob(job: ImportJob): number {
  if (!Number.isFinite(job.startedAt) || job.startedAt <= 0) {
    throw new Error("import validation start time is invalid");
  }
  return job.startedAt * 1_000 + IMPORT_VALIDATION_WALL_MS;
}

function createValidationYieldState(): ValidationYieldState {
  return { rows: 0, bytes: 0, startedAt: Date.now() };
}

function checkedValidationBytes(value: unknown): number {
  const serialized = JSON.stringify(value, (_key, nested) => (
    typeof nested === "bigint" ? nested.toString() : nested
  ));
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
}

async function yieldValidationBatch(
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
  job: ImportJob | undefined,
  state: ValidationYieldState,
  bytes: number,
  rowLimit = IMPORT_VALIDATION_BATCH_ROWS,
): Promise<void> {
  checkImportBudget(signal, deadlineAt);
  state.rows++;
  state.bytes += Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
  const shouldYield = state.rows >= rowLimit
    || state.bytes >= IMPORT_VALIDATION_BATCH_BYTES
    || Date.now() - state.startedAt >= IMPORT_VALIDATION_BATCH_MS;
  if (!shouldYield) return;
  state.rows = 0;
  state.bytes = 0;
  state.startedAt = Date.now();
  if (job) {
    renewImportLease(job);
    assertCurrentFence(job);
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  checkImportBudget(signal, deadlineAt);
  if (job) assertCurrentFence(job);
}
function checkImportBudget(signal?: AbortSignal, deadlineAt?: number): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  if (deadlineAt !== undefined && (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt)) {
    throw new Error("import validation deadline exceeded");
  }
}
const SEALED_PRESET_PLACEHOLDER_RE = /^\{\{(?:presetBlock|pblock)::([^}]+)\}\}$/;
const SEALED_PRESET_PLACEHOLDER_ENVELOPE_RE = /^\{\{(?:presetBlock|pblock)::[^}]*\}\}$/;
const SEALED_PRESET_METADATA_HINT_RE = /(?:portableSealedPreset|_lumiverse_sealed_preset|sealedPreset)/;
const SEALED_PRESET_PROMPT_HINT_RE = /(?:"sealed"\s*:|"sealedSource"\s*:|"sealedKey"\s*:|"sealedOriginPresetId"\s*:|"sealedOriginVersion"\s*:|"sealedSha256"\s*:|presetBlock|pblock)/;
const SEALED_PRESET_BLOCK_MARKER_KEYS = [
  "sealed",
  "sealedKey",
  "sealedSource",
  "sealedOriginPresetId",
  "sealedOriginVersion",
  "sealedSha256",
] as const;

function sealedPresetImportError(message: string): Error {
  return new Error(`sealed preset ${message}`);
}

function isSealedPresetPlaceholder(value: unknown): value is string {
  return typeof value === "string"
    && SEALED_PRESET_PLACEHOLDER_ENVELOPE_RE.test(value.trim());
}

function sealedPresetPlaceholder(value: unknown): string | null {
  if (!isSealedPresetPlaceholder(value)) return null;
  const match = value.trim().match(SEALED_PRESET_PLACEHOLDER_RE);
  return match?.[1]?.trim() || null;
}

function hasSealedPresetBlockMarker(block: Record<string, unknown>): boolean {
  return block.sealed === true
    || block.sealed === 1
    || block.sealed === "true"
    || block.sealedSource === "lumihub"
    || SEALED_PRESET_BLOCK_MARKER_KEYS.some((key) => Object.hasOwn(block, key))
    || isSealedPresetPlaceholder(block.content);
}
function isCanonicalSealedPresetBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.sealed === true
    || value.sealedSource === "lumihub"
    || Object.hasOwn(value, "sealedSource")
    || (Object.hasOwn(value, "sealed") && value.sealed !== false)
    || sealedPresetPlaceholder(value.content) !== null;
}
function hasSealedPresetMetadataCarrier(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    Object.hasOwn(value, "portableSealedPreset")
    || Object.hasOwn(value, "_lumiverse_sealed_preset")
    || Object.hasOwn(value, "sealedPreset")
  ) {
    return true;
  }
  const compatibility = isRecord(value.compatibility) && isRecord(value.compatibility.lumiverse)
    ? value.compatibility.lumiverse
    : null;
  return compatibility !== null && Object.hasOwn(compatibility, "sealedPreset");
}

function descriptorBlocksEqual(
  left: PortableSealedPresetDescriptor,
  right: PortableSealedPresetDescriptor,
): boolean {
  if (left.hubPresetId !== right.hubPresetId || left.hubPresetVersion !== right.hubPresetVersion) return false;
  if (left.blocks.length !== right.blocks.length) return false;
  const rightByKey = new Map(right.blocks.map((block) => [block.key, block.sha256]));
  return left.blocks.every((block) => rightByKey.get(block.key) === block.sha256);
}

type ImportSealedPresetManifest = {
  version: string | null;
  blocks: Array<{ key: string; sha256: string }>;
};

function parseImportSealedPresetManifest(value: unknown): ImportSealedPresetManifest {
  const manifest = parseSealedPresetManifest(value);
  if (!Array.isArray(manifest.blocks)) {
    throw sealedPresetImportError("manifest normalization returned no blocks");
  }
  const blocks = manifest.blocks.map((block) => {
    if (typeof block.key !== "string" || typeof block.sha256 !== "string") {
      throw sealedPresetImportError("manifest normalization returned an invalid block");
    }
    return { key: block.key, sha256: block.sha256 };
  });
  if (manifest.version !== null && manifest.version !== undefined && typeof manifest.version !== "string") {
    throw sealedPresetImportError("manifest normalization returned an invalid version");
  }
  return { version: manifest.version ?? null, blocks };
}

function readSealedMetadataText(
  metadata: Record<string, unknown>,
  key: string,
  allowNull: boolean,
): string | null {
  if (!Object.hasOwn(metadata, key)) return null;
  const raw = metadata[key];
  if (allowNull && (raw === null || raw === undefined)) return null;
  if (typeof raw !== "string" || !raw.trim()) {
    throw sealedPresetImportError(`metadata ${key} must be a non-empty string`);
  }
  return raw.trim();
}

function collectSealedBlockText(
  promptOrder: readonly unknown[],
  key: "sealedOriginPresetId" | "sealedOriginVersion",
  allowNull: boolean,
): Set<string> {
  const values = new Set<string>();
  for (const value of promptOrder) {
    if (!isRecord(value) || !Object.hasOwn(value, key)) continue;
    const raw = value[key];
    if (allowNull && (raw === null || raw === undefined)) continue;
    if (typeof raw !== "string" || !raw.trim()) {
      throw sealedPresetImportError(`block ${key} must be a non-empty string`);
    }
    values.add(raw.trim());
  }
  return values;
}

type SealedPresetDescriptorPlan = {
  promptOrder: unknown[];
  metadata: Record<string, unknown>;
};

function readLinkedCarrierString(
  block: Record<string, unknown>,
  key: "sealedKey" | "sealedOriginPresetId" | "sealedOriginVersion" | "sealedSha256",
  required: boolean,
): string | null {
  if (!Object.hasOwn(block, key)) {
    if (required) throw sealedPresetImportError(`linked stash block is missing ${key}`);
    return null;
  }
  const raw = block[key];
  if (typeof raw !== "string" || !raw.trim()) {
    throw sealedPresetImportError(`linked stash block ${key} must be a non-empty string`);
  }
  const value = raw.trim();
  if (key === "sealedSha256" && !/^[a-f0-9]{64}$/i.test(value)) {
    throw sealedPresetImportError("linked stash block sealedSha256 must be a SHA-256 digest");
  }
  return key === "sealedSha256" ? value.toLowerCase() : value;
}

function validateSealedPresetLinkedCarriers(promptOrder: readonly unknown[]): void {
  for (const value of promptOrder) {
    if (!isRecord(value) || !Object.hasOwn(value, "stashId")) continue;
    if (value.stashId === null || value.stashId === undefined) continue;
    if (typeof value.stashId !== "string" || !value.stashId.trim()) {
      throw sealedPresetImportError("preset linked stashId must be a non-empty string");
    }
    if (!isCanonicalSealedPresetBlock(value)) continue;

    const placeholderKey = sealedPresetPlaceholder(value.content);
    if (isSealedPresetPlaceholder(value.content) && !placeholderKey) {
      throw sealedPresetImportError("linked stash block has an empty placeholder key");
    }
    const sealedKey = readLinkedCarrierString(value, "sealedKey", false);
    if (sealedKey && placeholderKey && sealedKey !== placeholderKey) {
      throw sealedPresetImportError("linked stash block key conflicts with its placeholder");
    }
    if (!(sealedKey ?? placeholderKey)) {
      throw sealedPresetImportError("linked stash block is missing its key");
    }
    readLinkedCarrierString(value, "sealedOriginPresetId", true);
    readLinkedCarrierString(value, "sealedOriginVersion", true);
    readLinkedCarrierString(value, "sealedSha256", true);
  }
}
function promptValueHasSealedHint(value: unknown): boolean {
  if (isRecord(value)) return hasSealedPresetBlockMarker(value);
  if (isSealedPresetPlaceholder(value)) return true;
  return Array.isArray(value) && value.some((entry) => (
    (isRecord(entry) && hasSealedPresetBlockMarker(entry))
    || isSealedPresetPlaceholder(entry)
  ));
}


function parsePresetJsonColumnSafely(value: unknown, column: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw sealedPresetImportError(`${column} is not valid JSON`);
  }
}

/**
 * Convert all legacy sealed metadata carriers to the canonical portable
 * descriptor shape before invoking the shared LumiHub materializer. This
 * routine only handles carrier discovery and consistency; descriptor shape,
 * key, digest, and block materialization validation remain canonical-helper
 * responsibilities.
 */
async function prepareSealedPresetRow(
  job: ImportJob,
  row: Record<string, unknown>,
): Promise<SealedPresetDescriptorPlan | null> {
  const rawPromptOrder = row.prompt_order;
  const rawMetadata = row.metadata;
  const promptHint = typeof rawPromptOrder === "string" && SEALED_PRESET_PROMPT_HINT_RE.test(rawPromptOrder);
  const metadataHint = typeof rawMetadata === "string" && SEALED_PRESET_METADATA_HINT_RE.test(rawMetadata);

  let promptOrder: unknown = undefined;
  let metadata: unknown = undefined;
  let promptParseError: unknown = null;
  let metadataParseError: unknown = null;
  try {
    promptOrder = parsePresetJsonColumnSafely(rawPromptOrder, "prompt_order");
  } catch (error) {
    promptParseError = error;
  }
  try {
    metadata = parsePresetJsonColumnSafely(rawMetadata, "metadata");
  } catch (error) {
    metadataParseError = error;
  }
  const parsedPromptHint = promptParseError === null && promptValueHasSealedHint(promptOrder);
  const parsedMetadataHint = metadataParseError === null && hasSealedPresetMetadataCarrier(metadata);
  if (promptParseError !== null || metadataParseError !== null) {
    if (promptHint || metadataHint || parsedPromptHint || parsedMetadataHint) {
      throw promptParseError ?? metadataParseError;
    }
    return null;
  }
  if (!Array.isArray(promptOrder)) {
    if (promptHint || metadataHint || parsedPromptHint || parsedMetadataHint) {
      throw sealedPresetImportError("prompt_order must be an array");
    }
    return null;
  }
  if (!isRecord(metadata)) {
    if (promptHint || metadataHint || parsedPromptHint || parsedMetadataHint) {
      throw sealedPresetImportError("metadata must be an object");
    }
    return null;
  }

  const hasBlockMarkers = promptOrder.some((value) => (
    (isRecord(value) && hasSealedPresetBlockMarker(value))
    || isSealedPresetPlaceholder(value)
  ));
  const hasIgnoredSealedMarkers = promptOrder.some((value) => (
    isRecord(value)
      ? hasSealedPresetBlockMarker(value) && !isCanonicalSealedPresetBlock(value)
      : isSealedPresetPlaceholder(value)
  ));
  if (hasIgnoredSealedMarkers) {
    throw sealedPresetImportError("prompt_order contains an invalid sealed marker");
  }
  const hasPortableCarrier = Object.hasOwn(metadata, "portableSealedPreset");
  const legacyManifestValues: unknown[] = [];
  if (Object.hasOwn(metadata, "_lumiverse_sealed_preset") && metadata._lumiverse_sealed_preset !== null) {
    legacyManifestValues.push(metadata._lumiverse_sealed_preset);
  }
  if (Object.hasOwn(metadata, "sealedPreset") && metadata.sealedPreset !== null) {
    legacyManifestValues.push(metadata.sealedPreset);
  }
  const compatibility = isRecord(metadata.compatibility) && isRecord(metadata.compatibility.lumiverse)
    ? metadata.compatibility.lumiverse
    : null;
  if (compatibility && Object.hasOwn(compatibility, "sealedPreset") && compatibility.sealedPreset !== null) {
    legacyManifestValues.push(compatibility.sealedPreset);
  }
  const hasExplicitNullLegacyManifest = (
    (Object.hasOwn(metadata, "_lumiverse_sealed_preset") && metadata._lumiverse_sealed_preset === null)
    || (Object.hasOwn(metadata, "sealedPreset") && metadata.sealedPreset === null)
    || (compatibility !== null && Object.hasOwn(compatibility, "sealedPreset") && compatibility.sealedPreset === null)
  );
  if (hasExplicitNullLegacyManifest && (hasPortableCarrier || hasBlockMarkers)) {
    throw sealedPresetImportError("metadata contains an explicit null legacy manifest");
  }
  const hasDescriptorCarrier = hasPortableCarrier || legacyManifestValues.length > 0;
  if (!hasBlockMarkers && !hasDescriptorCarrier) return null;

  const portableCandidates: PortableSealedPresetDescriptor[] = [];
  if (hasPortableCarrier) {
    portableCandidates.push(parsePortableSealedPresetDescriptor(metadata.portableSealedPreset));
  }
  const legacyCandidates = legacyManifestValues.map((value) => ({
    manifest: parseImportSealedPresetManifest(value),
  }));
  const firstPortable = portableCandidates[0] ?? null;
  const firstLegacy = legacyCandidates[0]?.manifest ?? null;
  if (
    !hasBlockMarkers
    && !hasPortableCarrier
    && legacyCandidates.length > 0
    && legacyCandidates.every(({ manifest }) => manifest.blocks.length === 0)
  ) {
    // An empty legacy manifest is ordinary metadata emitted by older exports.
    return null;
  }
  for (const candidate of portableCandidates.slice(1)) {
    if (!descriptorBlocksEqual(firstPortable!, candidate)) {
      throw sealedPresetImportError("metadata contains conflicting portable descriptors");
    }
  }
  for (const candidate of legacyCandidates.slice(1)) {
    if (
      firstLegacy
      && (
        (firstLegacy.version !== null && candidate.manifest.version !== null && firstLegacy.version !== candidate.manifest.version)
        || firstLegacy.blocks.length !== candidate.manifest.blocks.length
        || firstLegacy.blocks.some((block) => candidate.manifest.blocks.find(
          (other) => other.key === block.key && other.sha256 === block.sha256,
        ) === undefined)
      )
    ) {
      throw sealedPresetImportError("metadata contains conflicting sealed manifests");
    }
  }
  const legacyVersions = new Set(
    legacyCandidates
      .map(({ manifest }) => manifest.version)
      .filter((version): version is string => typeof version === "string"),
  );
  if (legacyVersions.size > 1) {
    throw sealedPresetImportError("metadata contains conflicting sealed manifest versions");
  }

  const metadataHubPresetId = readSealedMetadataText(metadata, "_lumiverse_lumihub_id", false);
  const metadataVersion = readSealedMetadataText(metadata, "_lumiverse_preset_version", true);
  const blockHubPresetIds = collectSealedBlockText(promptOrder, "sealedOriginPresetId", false);
  const blockVersions = collectSealedBlockText(promptOrder, "sealedOriginVersion", true);
  const manifestVersion = [...legacyVersions][0] ?? null;
  const hubPresetId = firstPortable?.hubPresetId
    ?? metadataHubPresetId
    ?? [...blockHubPresetIds][0]
    ?? null;
  const hubPresetVersion = firstPortable?.hubPresetVersion
    ?? metadataVersion
    ?? manifestVersion
    ?? [...blockVersions][0]
    ?? null;
  if (!hubPresetId || !hubPresetVersion) {
    throw sealedPresetImportError("descriptor is missing its Hub preset identity or version");
  }
  if (
    (metadataHubPresetId && metadataHubPresetId !== hubPresetId)
    || (metadataVersion && metadataVersion !== hubPresetVersion)
    || [...blockHubPresetIds].some((value) => value !== hubPresetId)
    || [...blockVersions].some((value) => value !== hubPresetVersion)
    || (manifestVersion && manifestVersion !== hubPresetVersion)
  ) {
    throw sealedPresetImportError("metadata and block origins are inconsistent");
  }

  const legacyBlocks = firstLegacy?.blocks ?? [];
  const descriptorBlocks = firstPortable?.blocks ?? legacyBlocks;
  if (descriptorBlocks.length === 0) {
    throw sealedPresetImportError("descriptor has no blocks");
  }
  const descriptor = parsePortableSealedPresetDescriptor({
    hubPresetId,
    hubPresetVersion,
    blocks: descriptorBlocks,
  });
  if (firstPortable && !descriptorBlocksEqual(firstPortable, descriptor)) {
    throw sealedPresetImportError("portable descriptor normalization changed its value");
  }
  if (firstLegacy) {
    const normalizedLegacy = parsePortableSealedPresetDescriptor({
      hubPresetId,
      hubPresetVersion,
      blocks: legacyBlocks,
    });
    if (!descriptorBlocksEqual(descriptor, normalizedLegacy)) {
      throw sealedPresetImportError("portable descriptor and legacy manifest are inconsistent");
    }
  }
  if (!hasBlockMarkers) {
    // A descriptor without a corresponding sealed block must never silently
    // become ordinary prompt content; the canonical helper reports the same
    // incomplete-descriptor failure after this preflight returns.
    throw sealedPresetImportError("descriptor has no matching sealed prompt blocks");
  }

  const canonicalMetadata: Record<string, unknown> = {
    ...metadata,
    portableSealedPreset: descriptor,
  };
  const materialized = await materializePortableSealedPresetImport(
    job.userId,
    {
      prompt_order: promptOrder,
      metadata: canonicalMetadata,
    },
    portableSealedPresetResolverOverride ?? undefined,
  );
  if (!Array.isArray(materialized.prompt_order) || !isRecord(materialized.metadata)) {
    throw sealedPresetImportError("materializer returned an invalid preset");
  }
  validateSealedPresetLinkedCarriers(materialized.prompt_order);
  return {
    promptOrder: materialized.prompt_order,
    metadata: materialized.metadata,
  };
}

/**
 * Resolve every staged sealed preset before file journals or the relational
 * apply transaction can mutate the live database. Rows are updated only in
 * the private staging database; a later row failure therefore leaves the
 * destination untouched.
 */
async function prepareStagedSealedPresets(job: ImportJob, stage: StagedArchive): Promise<void> {
  if (!sqliteTableExists(stage.db, "presets")) return;
  const deadlineAt = validationDeadlineForJob(job);
  const state = createValidationYieldState();
  for (const row of stage.db.query("SELECT id, prompt_order, metadata FROM presets").iterate() as Iterable<Record<string, unknown>>) {
    await yieldValidationBatch(
      job.abort.signal,
      deadlineAt,
      job,
      state,
      checkedValidationBytes(row.prompt_order) + checkedValidationBytes(row.metadata),
    );
    const prepared = await prepareSealedPresetRow(job, row);
    checkImportBudget(job.abort.signal, deadlineAt);
    if (!prepared) continue;
    if (typeof row.id !== "string" || row.id.length === 0) {
      throw sealedPresetImportError("preset row id is malformed");
    }
    const promptOrder = JSON.stringify(prepared.promptOrder);
    const metadata = JSON.stringify(prepared.metadata);
    if (promptOrder === row.prompt_order && metadata === row.metadata) continue;
    const updated = stage.db.query(
      "UPDATE presets SET prompt_order = ?, metadata = ? WHERE id = ?",
    ).run(promptOrder, metadata, row.id);
    if (updated.changes !== 1) throw new Error("staged sealed preset row was not updated");
  }
}



export type FileHashHeartbeat = () => void;

/**
 * Hash a file without monopolizing the event loop. Every bounded read checks
 * cancellation/deadline before and after hashing; the heartbeat renews and
 * fences the owning import before each cooperative yield and before returning.
 */
export async function sha256File(
  path: string,
  signal?: AbortSignal,
  deadlineAt?: number,
  heartbeat?: FileHashHeartbeat,
): Promise<string> {
  const hash = createHash("sha256");
  checkImportBudget(signal, deadlineAt);
  heartbeat?.();
  checkImportBudget(signal, deadlineAt);
  const fd = openSync(path, "r");
  const buffer = new Uint8Array(ARCHIVE_READ_BYTES);
  let position = 0;
  let bytesSinceYield = 0;
  try {
    while (true) {
      checkImportBudget(signal, deadlineAt);
      const read = readSync(fd, buffer, 0, buffer.byteLength, position);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
      bytesSinceYield += read;
      checkImportBudget(signal, deadlineAt);
      if (bytesSinceYield < HASH_YIELD_BYTES) continue;
      heartbeat?.();
      checkImportBudget(signal, deadlineAt);
      await new Promise<void>((resolve) => setTimeout(resolve, YIELD_INTERVAL_MS));
      checkImportBudget(signal, deadlineAt);
      bytesSinceYield = 0;
    }
  } finally {
    closeSync(fd);
  }
  heartbeat?.();
  checkImportBudget(signal, deadlineAt);
  return hash.digest("hex");
}


function* readNdjsonEntriesSync(
  path: string,
  maxLineBytes: number,
  signal?: AbortSignal,
  deadlineAt?: number,
): Generator<Record<string, any>> {
  const fd = openSync(path, "r");
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(ARCHIVE_READ_BYTES);
  const fragments: Uint8Array[] = [];
  let lineBytes = 0;
  let position = 0;
  const consume = (): Record<string, any> | null => {
    checkImportBudget(signal, deadlineAt);
    if (lineBytes === 0) return null;
    const bytes = new Uint8Array(lineBytes);
    let offset = 0;
    for (const fragment of fragments) {
      bytes.set(fragment, offset);
      offset += fragment.byteLength;
    }
    fragments.length = 0;
    lineBytes = 0;
    const line = decoder.decode(bytes);
    if (line.trim().length === 0) return null;
    const row = JSON.parse(line);
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("NDJSON row must be an object");
    return row as Record<string, any>;
  };
  const append = (chunk: Uint8Array) => {
    checkImportBudget(signal, deadlineAt);
    if (chunk.byteLength === 0) return;
    lineBytes += chunk.byteLength;
    if (lineBytes > maxLineBytes) throw new Error(`NDJSON line exceeds ${maxLineBytes} bytes`);
    fragments.push(chunk.slice());
  };
  try {
    while (true) {
      checkImportBudget(signal, deadlineAt);
      const read = readSync(fd, buffer, 0, buffer.byteLength, position);
      if (read <= 0) break;
      position += read;
      let start = 0;
      for (let i = 0; i < read; i++) {
        if (buffer[i] !== 0x0a) continue;
        append(buffer.subarray(start, i));
        const row = consume();
        if (row) yield row;
        start = i + 1;
      }
      append(buffer.subarray(start, read));
    }
    const row = consume();
    if (row) yield row;
  } finally {
    closeSync(fd);
  }
}

async function* readNdjsonEntries(
  path: string,
  signal?: AbortSignal,
  deadlineAt?: number,
  job?: ImportJob,
): AsyncGenerator<Record<string, any>> {
  const state = createValidationYieldState();
  for (const row of readNdjsonEntriesSync(path, LEGACY_MAX_NDJSON_LINE_BYTES, signal, deadlineAt)) {
    await yieldValidationBatch(signal, deadlineAt, job, state, checkedValidationBytes(row));
    yield row;
  }
}


async function validateManifestEntries(
  manifest: ArchiveManifest,
  buf: ImportBuffer,
  signal?: AbortSignal,
  deadlineAt?: number,
  heartbeat?: FileHashHeartbeat,
  job?: ImportJob,
): Promise<void> {
  checkImportBudget(signal, deadlineAt);
  const version = manifest.schemaVersion;
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new Error(`unsupported archive schema version ${version}`);
  }
  // V1 and V2 intentionally have no authenticated ledger. Their payloads
  // still pass the bounded extraction and ownership/graph validation path.
  if (version !== 3) return;
  if (manifest.registryVersion !== ARCHIVE_REGISTRY_VERSION) {
    throw new Error("archive registry version is not supported");
  }
  const expected = manifest.entries;
  if (!expected) throw new Error("V3 manifest entries are missing");
  if (!manifest.byteCounts) throw new Error("V3 manifest byteCounts are missing");
  const missingOptional = new Set(manifest.missingOptionalFiles ?? []);

  const actual = new Map<string, BufferedTextEntry | BufferedBinaryEntry>();
  const addActual = (path: string, entry: BufferedTextEntry | BufferedBinaryEntry): void => {
    if (actual.has(path)) throw new Error(`duplicate archive payload entry: ${path}`);
    actual.set(path, entry);
  };
  for (const entry of buf.entries) {
    if (entry.table === "__manifest__" || entry.table === "__manifest_stats__") continue;
    const path = entry.origin === "lancedb"
      ? `lancedb/${entry.table}.ndjson`
      : entry.table === "__secrets_index__"
        ? "secrets/index.json"
        : entry.table === "__secrets_encrypted__"
          ? "secrets/encrypted.ndjson"
          : `database/${entry.table}.ndjson`;
    addActual(path, entry);
  }
  for await (const raw of readNdjsonEntries(buf.binaryJournalPath, signal, deadlineAt, job)) {
    if (
      !raw
      || raw.kind !== "binary"
      || typeof raw.bucket !== "string"
      || typeof raw.inner !== "string"
      || typeof raw.stagingPath !== "string"
      || !Number.isSafeInteger(raw.byteSize)
      || raw.byteSize < 0
    ) {
      throw new Error("binary entry journal is malformed");
    }
    const entry = raw as unknown as BufferedBinaryEntry;
    addActual(`files/${entry.bucket}/${entry.inner}`, entry);
  }

  let vectorRowsTotal = 0;
  const expectedByPath = new Map<string, ArchiveEntry>();
  const expectedState = createValidationYieldState();
  for (const entry of expected) {
    await yieldValidationBatch(signal, deadlineAt, job, expectedState, checkedValidationBytes(entry));
    if (expectedByPath.has(entry.path)) throw new Error(`duplicate manifest entry: ${entry.path}`);
    expectedByPath.set(entry.path, entry);
    const staged = actual.get(entry.path);
    if (!staged) throw new Error(`manifest entry is absent from archive: ${entry.path}`);
    const kind = entry.path.startsWith("database/") ? "database"
      : entry.path.startsWith("lancedb/") ? "vector"
        : entry.path.startsWith("secrets/") ? "secret"
          : entry.path.startsWith("files/") ? "file" : "unknown";
    if (entry.kind !== kind) throw new Error(`manifest entry kind mismatch: ${entry.path}`);
    if (
      entry.kind === "file"
      && (
        !entry.sourceIdentity
        || typeof entry.sourceIdentity === "string"
        || entry.sourceIdentity.size !== entry.bytes
      )
    ) {
      throw new Error(`file source identity size does not match ledger bytes: ${entry.path}`);
    }
    if (entry.kind === "vector" && (!manifest.includeVectors || manifest.vectorStatus === "rebuild_required")) {
      throw new Error(`vector entry is not enabled by the archive manifest: ${entry.path}`);
    }
    if (entry.kind === "vector") {
      const vectorTable = entry.path.slice("lancedb/".length).replace(/\.ndjson$/u, "");
      if (!getArchiveVectorTables().includes(vectorTable)) {
        throw new Error(`vector table is not importable: ${entry.path}`);
      }
    }
    if (!Object.hasOwn(manifest.byteCounts, entry.path)) {
      throw new Error(`manifest byte count is missing: ${entry.path}`);
    }
    const declaredBytes = manifest.byteCounts[entry.path];
    if (
      entry.bytes > MAX_ARCHIVE_FILE_BYTES
      || declaredBytes > MAX_ARCHIVE_FILE_BYTES
      || staged.byteSize > MAX_ARCHIVE_FILE_BYTES
    ) {
      throw new Error(`${entry.path} exceeds ${MAX_ARCHIVE_FILE_BYTES} bytes`);
    }
    if (declaredBytes !== entry.bytes) {
      throw new Error(`manifest byte count disagrees with entry: ${entry.path}`);
    }
    if (staged.byteSize !== entry.bytes) {
      throw new Error(`manifest byte count mismatch: ${entry.path}`);
    }
    if (await sha256File(staged.stagingPath, signal, deadlineAt, heartbeat) !== entry.sha256.toLowerCase()) {
      throw new Error(`manifest entry SHA-256 mismatch: ${entry.path}`);
    }
    if (entry.kind === "database") {
      const table = entry.path.slice("database/".length).replace(/\.ndjson$/u, "");
      const spec = getArchiveTableSpec(table);
      if (!spec || spec.kind !== "canonical") {
        throw new Error(`database payload is not a canonical table: ${table}`);
      }
      if (!entry.required) throw new Error(`canonical table payload must be required: ${table}`);
      if (entry.rowCount === undefined) throw new Error(`canonical table row count is missing: ${table}`);
      let rows = 0;
      for await (const _row of readNdjsonEntries(staged.stagingPath, signal, deadlineAt, job)) {
        if (rows >= MAX_ROWS_PER_TABLE || rows >= MAX_STAGED_ROWS) {
          throw new Error(`canonical row count exceeds cap: ${table}`);
        }
        rows++;
      }
      if (rows !== entry.rowCount) throw new Error(`canonical table row count mismatch: ${table}`);
      const manifestCount = manifest.counts[table];
      if (!Number.isSafeInteger(manifestCount) || manifestCount !== rows) {
        throw new Error(`canonical table manifest count mismatch: ${table}`);
      }
    } else if (entry.kind === "vector" || entry.kind === "secret") {
      let rows = 0;
      for await (const _row of readNdjsonEntries(staged.stagingPath, signal, deadlineAt, job)) {
        if (rows >= MAX_ROWS_PER_TABLE || (entry.kind === "vector" && rows >= MAX_STAGED_ROWS)) {
          throw new Error(`${entry.kind} row count exceeds cap: ${entry.path}`);
        }
        rows++;
        if (entry.kind === "vector") {
          vectorRowsTotal++;
          if (vectorRowsTotal > MAX_STAGED_ROWS) throw new Error("vector row count exceeds aggregate cap");
        }
      }
      if (entry.rowCount !== undefined && rows !== entry.rowCount) {
        throw new Error(`entry row count mismatch: ${entry.path}`);
      }
      if (entry.kind === "vector") {
        const vectorTable = entry.path.slice("lancedb/".length).replace(/\.ndjson$/u, "");
        if (
          Object.hasOwn(manifest.counts, vectorTable)
          && (!Number.isSafeInteger(manifest.counts[vectorTable]) || manifest.counts[vectorTable] !== rows)
        ) {
          throw new Error(`vector manifest count mismatch: ${entry.path}`);
        }
      }
    }
  }
  for (const path of Object.keys(manifest.byteCounts)) {
    if (!expectedByPath.has(path)) throw new Error(`manifest byte count has undeclared entry: ${path}`);
  }
  const aliases = manifest.fileAliases ?? [];
  const aliasByPath = new Map<string, ArchiveFileAlias>();
  for (const alias of aliases) {
    if (aliasByPath.has(alias.path)) throw new Error(`duplicate manifest file alias: ${alias.path}`);
    const logical = sanitizeEntry(alias.path);
    const payload = sanitizeEntry(alias.payloadPath);
    if (
      logical.kind !== "files"
      || payload.kind !== "files"
      || logical.bucket === undefined
      || payload.bucket === undefined
      || archiveFileSafeClass(logical.bucket) !== archiveFileSafeClass(payload.bucket)
      || alias.path === alias.payloadPath
    ) {
      throw new Error(`manifest file alias is not canonical: ${alias.path}`);
    }
    const payloadEntry = expectedByPath.get(alias.payloadPath);
    if (!payloadEntry || payloadEntry.kind !== "file" || !actual.has(alias.payloadPath)) {
      throw new Error(`manifest file alias payload is absent: ${alias.path}`);
    }
    if (actual.has(alias.path) || expectedByPath.has(alias.path)) {
      throw new Error(`manifest file alias collides with payload: ${alias.path}`);
    }
    aliasByPath.set(alias.path, alias);
  }
  for (const path of missingOptional) {
    const descriptor = sanitizeEntry(path);
    if (
      descriptor.kind !== "files"
      || expectedByPath.has(path)
      || actual.has(path)
      || aliasByPath.has(path)
    ) {
      throw new Error(`optional file omission conflicts with an archive entry: ${path}`);
    }
  }


  for (const spec of ARCHIVE_CANONICAL_TABLES) {
    const path = `database/${spec.table}.ndjson`;
    const entry = expectedByPath.get(path);
    if (!entry) throw new Error(`canonical table payload is missing: ${spec.table}`);
    if (entry.kind !== "database" || !entry.required) {
      throw new Error(`canonical table payload is not required: ${spec.table}`);
    }
    if (!actual.has(path)) throw new Error(`canonical table payload is absent: ${spec.table}`);
  }
  for (const path of actual.keys()) {
    if (!expectedByPath.has(path)) throw new Error(`archive entry is not declared by V3 manifest: ${path}`);
  }
}

async function validateParentEdges(
  stage: Database,
  stagedTables: Set<string>,
  table: string,
  spec: unknown,
  sourceOwner: string | null,
  archiveSchemaVersion: number,
  signal?: AbortSignal,
  deadlineAt?: number,
  job?: ImportJob,
): Promise<void> {
  const tableColumns = new Set(
    (stage.query(`PRAGMA table_info(${ident(table)})`).all() as { name: string }[]).map((column) => column.name),
  );
  const validationState = createValidationYieldState();
  for (const edge of registryParentEdges(spec)) {
    if (!edge || typeof edge.column !== "string" || typeof edge.parentTable !== "string") {
      throw new Error(`invalid parent edge declaration for ${table}`);
    }
    const childColumns = Array.isArray(edge.columns) ? edge.columns : [edge.column];
    const parentColumns = Array.isArray(edge.parentColumns)
      ? edge.parentColumns
      : [typeof edge.parentColumn === "string" ? edge.parentColumn : "id"];
    if (
      childColumns.length === 0
      || childColumns.length !== parentColumns.length
      || childColumns.some((column: unknown) => typeof column !== "string")
      || parentColumns.some((column: unknown) => typeof column !== "string")
    ) {
      throw new Error(`invalid parent edge declaration for ${table}`);
    }
    const missingChildColumn = childColumns.find((column: string) => !tableColumns.has(column));
    if (missingChildColumn !== undefined) {
      if (edge.nullable) continue;
      throw new Error(`required parent column ${table}.${missingChildColumn} is missing`);
    }
    const childSelect = childColumns.map((column: string) => ident(column)).join(", ");
    const childRows = stage.query(`SELECT ${childSelect} FROM ${ident(table)}`).iterate() as Iterable<Record<string, unknown>>;
    const edgeLabel = `${table}.${childColumns.join(",")}`;
    const checkNullability = (values: readonly unknown[]): "absent" | "present" => {
      const nullCount = values.filter((value) => value === null || value === undefined).length;
      if (nullCount === values.length) {
        if (!edge.nullable) throw new Error(`non-null parent edge ${edgeLabel} is null`);
        return "absent";
      }
      if (nullCount > 0) throw new Error(`partial nullable parent edge ${edgeLabel} is malformed`);
      return "present";
    };
    const nullReference = (values: readonly unknown[], reason: string): void => {
      if (
        archiveSchemaVersion !== 1
        || edge.nullable !== true
        || edge.onMissing !== "null_reference"
      ) {
        throw new Error(reason);
      }
      const where = childColumns.map((column: string) => `${ident(column)} = ?`).join(" AND ");
      stage.query(
        `UPDATE ${ident(table)} SET ${childColumns.map((column: string) => `${ident(column)} = NULL`).join(", ")} WHERE ${where}`,
      ).run(...values.map(sqlBinding));
    };
    const parentSpec = getArchiveTableSpec(edge.parentTable);
    if (!parentSpec) throw new Error(`unknown parent table ${edge.parentTable}`);
    if (edge.parentTable === "user") {
      if (childColumns.length !== 1) throw new Error(`user parent edge ${edgeLabel} is composite`);
      for (const row of childRows) {
        await yieldValidationBatch(signal, deadlineAt, job, validationState, checkedValidationBytes(row));
        const values = [row[childColumns[0]]];
        if (checkNullability(values) === "present") {
          const value = values[0];
          if (typeof value !== "string" || sourceOwner === null || value !== sourceOwner) {
            throw new Error(`cross-user parent edge ${edgeLabel}`);
          }
        }
      }
      continue;
    }
    if (parentSpec.kind === "forbidden" || parentSpec.kind === "operational") {
      for (const row of childRows) {
        await yieldValidationBatch(signal, deadlineAt, job, validationState, checkedValidationBytes(row));
        const values = childColumns.map((column: string) => row[column]);
        if (checkNullability(values) === "present") {
          nullReference(values, `forbidden parent edge ${edgeLabel} is not importable`);
        }
      }
      continue;
    }
    if (!stagedTables.has(edge.parentTable)) {
      for (const row of childRows) {
        await yieldValidationBatch(signal, deadlineAt, job, validationState, checkedValidationBytes(row));
        const values = childColumns.map((column: string) => row[column]);
        if (checkNullability(values) === "present") {
          nullReference(values, `required parent ${edge.parentTable} is absent from archive`);
        }
      }
      continue;
    }
    const where = parentColumns.map((column: string) => `${ident(column)} = ?`).join(" AND ");
    const lookup = stage.prepare(`SELECT 1 FROM ${ident(edge.parentTable)} WHERE ${where} LIMIT 1`);
    for (const row of childRows) {
      await yieldValidationBatch(signal, deadlineAt, job, validationState, checkedValidationBytes(row));
      const values = childColumns.map((column: string) => row[column]);
      if (checkNullability(values) === "present" && !lookup.get(...values.map(sqlBinding))) {
        nullReference(values, `missing parent edge ${edgeLabel}`);
      }
    }
  }
}
async function validateStagedOwners(
  stage: Database,
  stagedTables: Set<string>,
  sourceOwner: string | null,
  signal?: AbortSignal,
  deadlineAt?: number,
  job?: ImportJob,
): Promise<void> {
  const validationState = createValidationYieldState();
  for (const table of stagedTables) {
    await yieldValidationBatch(signal, deadlineAt, job, validationState, checkedValidationBytes(table));
    const spec = getArchiveTableSpec(table);
    if (!spec || spec.kind !== "canonical") throw new Error(`staged table is not canonical: ${table}`);
    const owner = registryOwner(spec);
    if (!owner || owner.kind === "none") throw new Error(`canonical table has no owner derivation: ${table}`);
    const columns = getTableColumnsFrom(stage, table).map((column) => column.name);
    const key = registryKeys(spec)[0] ?? [];
    if (key.length === 0 || key.some((column) => !columns.includes(column))) {
      throw new Error(`staged table has no usable owner key: ${table}`);
    }
    const rows = stage.query(
      `SELECT ${key.map(ident).join(", ")} FROM ${ident(table)}`,
    ).iterate() as Iterable<Record<string, unknown>>;
    if (sourceOwner === null) {
      if (stage.query(`SELECT 1 FROM ${ident(table)} LIMIT 1`).get()) {
        throw new Error(`staged table has rows but no archive owner: ${table}`);
      }
      continue;
    }
    const ownerPredicate = buildArchiveOwnerPredicate(spec, sourceOwner, ident(table));
    if (!ownerPredicate) throw new Error(`canonical table owner predicate is empty: ${table}`);
    const keyWhere = key.map((column) => `${ident(column)} = ?`).join(" AND ");
    const lookup = stage.prepare(
      `SELECT 1 FROM ${ident(table)} AS ${ident(table)} WHERE ${keyWhere} AND (${ownerPredicate.sql}) LIMIT 1`,
    );
    for (const row of rows) {
      await yieldValidationBatch(signal, deadlineAt, job, validationState, checkedValidationBytes(row));
      const keyValues = key.map((column) => sqlBinding(row[column]));
      if (!lookup.get(...keyValues, ...ownerPredicate.params)) {
        throw new Error(`staged row owner predicate failed: ${table}`);
      }
    }
  }
}
 


async function materializeValidatedArchive(job: ImportJob, buf: ImportBuffer): Promise<StagedArchive> {
  const live = getDb();
  assertArchiveRegistryCoverage(live);
  if (!buf.manifest) throw new Error("manifest is required before staging");
  ensureDir(buf.stagingDir);
  const dbPath = join(buf.stagingDir, "staging.sqlite");
  try { unlinkSync(dbPath); } catch {}
  // Validate the closed archive ledger before allocating the SQLite staging
  // database; malformed rows/aliases must not consume staging pages.
  const validationDeadlineAt = validationDeadlineForJob(job);
  const hashHeartbeat: FileHashHeartbeat = () => {
    renewImportLease(job);
    assertCurrentFence(job);
  };
  await validateManifestEntries(
    buf.manifest,
    buf,
    job.abort.signal,
    validationDeadlineAt,
    hashHeartbeat,
    job,
  );
  const stage = new Database(dbPath);
  stage.run("PRAGMA foreign_keys = ON");
  stage.run("CREATE TABLE __import_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const rowCounts: Record<string, number> = {};
  const stagedTables = new Set<string>();
  let totalRows = 0;
  let sourceOwner: string | null = null;
  for (const entry of buf.entries) {
    if (entry.kind === "text" && entry.origin === "lancedb" && !getArchiveVectorTables().includes(entry.table)) {
      throw new Error(`vector table is not importable: ${entry.table}`);
    }
  }
  for (const entry of buf.entries) {
    if (entry.kind !== "text" || entry.origin !== "database") continue;
    if (entry.table === "__manifest__" || entry.table === "__manifest_stats__" || entry.table === "__secrets_index__" || entry.table === "__secrets_encrypted__") continue;
    const spec = getArchiveTableSpec(entry.table) as any;
    if (!spec || registryKind(spec) !== "canonical") throw new Error(`table is not importable: ${entry.table}`);
    if (stagedTables.has(entry.table)) throw new Error(`duplicate database table: ${entry.table}`);
    const columns = createStagedTable(stage, live, entry.table);
    const byName = new Map(columns.map((column) => [column.name, column]));
    const insert = stage.prepare(
      `INSERT INTO ${ident(entry.table)} (${columns.map((c) => ident(c.name)).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    );
    let tableRows = 0;
    const rowState = createValidationYieldState();
    for await (const raw of readNdjsonEntries(
      entry.stagingPath,
      job.abort.signal,
      validationDeadlineAt,
      job,
    )) {
      if (tableRows >= MAX_ROWS_PER_TABLE || totalRows >= MAX_STAGED_ROWS) {
        throw new Error("archive row count exceeds cap");
      }
      await yieldValidationBatch(
        job.abort.signal,
        validationDeadlineAt,
        job,
        rowState,
        checkedValidationBytes(raw),
      );
      tableRows++;
      totalRows++;
      // Older archives could carry provider-private reasoning carriers in
      // messages.extra or plaintext legacy image-generation credentials.
      // Scrub both before validation and staging so neither can re-enter live
      // data. Malformed private containers throw and reject the whole import.
      const privateDataRow = entry.table === "settings"
        ? scrubLegacyImageGenerationSettingRow(raw)
        : raw;
      const archiveRow = entry.table === "messages"
        ? scrubArchiveRowPrivateData(privateDataRow)
        : privateDataRow;
      for (const key of Object.keys(archiveRow)) if (!byName.has(key)) throw new Error(`unknown column ${entry.table}.${key}`);
      for (const column of columns) {
        if (archiveRow[column.name] === undefined && column.notnull && column.dflt_value === null) {
          throw new Error(`missing required column ${entry.table}.${column.name}`);
        }
      }
      const normalized: Record<string, any> = {};
      for (const column of columns) {
        normalized[column.name] = archiveRow[column.name] === undefined
          ? defaultSqlValue(column.dflt_value)
          : normalizeSqlValue(archiveRow[column.name], column.type);
      }
      normalizeRepairCodedRegexRow(
        entry.table,
        normalized,
        new Set(columns.map((column) => column.name)),
      );
      if (entry.table === "settings" && typeof normalized.key === "string" && isSecretSettingKey(normalized.key)) {
        throw new Error(`secret setting key is not allowed: ${normalized.key}`);
      }
      const owner = registryOwner(spec);
      if (
        (owner?.kind === "direct" || owner?.kind === "predicate")
        && typeof owner.column === "string"
      ) {
        const value = normalized[owner.column];
        if (typeof value !== "string" || value.length === 0) throw new Error(`owner value is malformed in ${entry.table}`);
        if (sourceOwner === null) sourceOwner = value;
        else if (sourceOwner !== value) throw new Error("archive contains multiple owner identities");
      }
      insert.run(...columns.map((column) => sqlBinding(normalized[column.name])));
    }
    stagedTables.add(entry.table);
    rowCounts[entry.table] = tableRows;
  }
  await validateStagedOwners(stage, stagedTables, sourceOwner, job.abort.signal, validationDeadlineAt, job);


  const files: BufferedBinaryEntry[] = [];
  const filePaths = new Set<string>();
  const legacyInvalidAudioPaths = new Set<string>();
  for await (const raw of readNdjsonEntries(
    buf.binaryJournalPath,
    job.abort.signal,
    validationDeadlineAt,
    job,
  )) {
    if (
      raw.kind !== "binary" || typeof raw.bucket !== "string" || typeof raw.inner !== "string"
      || typeof raw.stagingPath !== "string" || !Number.isSafeInteger(raw.byteSize) || raw.byteSize < 0
    ) throw new Error("binary entry journal is malformed");
    const archivePath = `files/${raw.bucket}/${raw.inner}`;
    if (raw.bucket === "audio" || raw.bucket === "notification-sounds") {
      try {
        assertAudioPayload(raw.stagingPath, archivePath);
      } catch (error) {
        // V1/V2 archives did not carry a closed media ledger.  An invalid
        // legacy audio payload is quarantined with its dependent row rather
        // than being written as executable/media state.  V3 remains strict.
        if (buf.manifest.schemaVersion === 3) throw error;
        legacyInvalidAudioPaths.add(archivePath);
        continue;
      }
    }
    const sanitized = sanitizeEntry(archivePath);
    if (sanitized.kind !== "files" || sanitized.bucket !== raw.bucket || sanitized.inner !== raw.inner) {
      throw new Error(`binary entry descriptor is not canonical: ${archivePath}`);
    }
    if (filePaths.has(archivePath)) throw new Error(`duplicate binary entry: ${archivePath}`);
    filePaths.add(archivePath);
    files.push(raw as BufferedBinaryEntry);
    if (files.length > MAX_ENTRIES) throw new Error("too many file entries");
  }

  // The V3 manifest is the closed ledger for every payload. Files without a
  // canonical row are limited to the descriptor-only notification sound
  // record emitted by the read snapshot; all other buckets must be bound to a
  // registry file reference below.
  const manifestEntries = new Map(
    (buf.manifest.entries ?? []).map((entry) => [entry.path, entry] as const),
  );
  const fileAliases = new Map<string, ArchiveFileAlias>(
    (buf.manifest.fileAliases ?? []).map((alias) => [alias.path, alias] as const),
  );
  const missingOptional = new Set(buf.manifest.missingOptionalFiles ?? []);
  const fileByPath = new Map<string, BufferedBinaryEntry>();
  for (const entry of files) fileByPath.set(`files/${entry.bucket}/${entry.inner}`, entry);
  const installFiles = new Map<string, BufferedBinaryEntry>();
  const expectedPaths = new Set<string>();
  const mappedPaths = new Map<string, string>();
  const filePlans = new Map<string, StagedFilePlan>();
  const fileMappings: Array<Record<string, unknown>> = [];
  for (const spec of ARCHIVE_CANONICAL_TABLES) {
    if (!stagedTables.has(spec.table) || spec.fileRefs.length === 0) continue;
    const keyColumns = registryKeys(spec)[0] || [];
    if (keyColumns.length === 0) throw new Error(`file-bearing table has no primary key: ${spec.table}`);
    const rows = stage.query(`SELECT * FROM ${ident(spec.table)}`).iterate() as Iterable<Record<string, any>>;
    for (const row of rows) {
      let skipRow = false;
      for (const ref of spec.fileRefs) {
        if (typeof ref.applies === "function" && !ref.applies(row)) continue;
        const resolved = typeof ref.resolve === "function" ? ref.resolve(row, env.dataDir) : [];
        const paths = Array.isArray(resolved) ? resolved : [];
        if (paths.length === 0) {
          if (ref.required) throw new Error(`required file reference is absent from ${spec.table}`);
          continue;
        }
        for (const sourcePath of paths) {
          const rawInner = typeof ref.archivePath === "function"
            ? ref.archivePath(row, sourcePath)
            : sourcePath.split(/[\\/]/).pop();
          if (typeof rawInner !== "string" || !rawInner || rawInner.includes("..")) {
            throw new Error(`file reference path is malformed in ${spec.table}`);
          }
          const archivePath = `files/${ref.bucket}/${rawInner}`;
          sanitizeEntry(archivePath);
          const alias = fileAliases.get(archivePath);
          const payloadPath = alias?.payloadPath ?? archivePath;
          if (alias) {
            const logical = sanitizeEntry(archivePath);
            const payload = sanitizeEntry(payloadPath);
            if (
              logical.kind !== "files"
              || payload.kind !== "files"
              || archiveFileSafeClass(logical.bucket ?? "") !== archiveFileSafeClass(payload.bucket ?? "")
            ) {
              throw new Error(`file alias crosses logical media classes: ${archivePath}`);
            }
          }
          const payloadEntry = fileByPath.get(payloadPath);
          const fileEntry = payloadEntry ? cloneLogicalBinaryEntry(payloadEntry, archivePath) : undefined;
          const legacyInvalidAudio = buf.manifest.schemaVersion !== 3
            && ref.bucket === "audio"
            && (legacyInvalidAudioPaths.has(archivePath) || legacyInvalidAudioPaths.has(payloadPath));
          if (!fileEntry) {
            if (ref.required && !legacyInvalidAudio) throw new Error(`required file is missing from archive: ${archivePath}`);
            if (buf.manifest.schemaVersion === 3 && !missingOptional.has(archivePath)) {
              throw new Error(`optional file omission is not declared: ${archivePath}`);
            }
            if (legacyInvalidAudio) {
              skipRow = true;
            } else if (ref.onMissing === "null_reference") {
              if (!ref.pathColumn) throw new Error(`missing file cannot null reference: ${archivePath}`);
              row[ref.pathColumn] = null;
            } else if (ref.onMissing === "skip_dependent_row") {
              skipRow = true;
            }
            if (!filePlans.has(archivePath)) {
              filePlans.set(archivePath, {
                required: false,
                omissionPolicy: legacyInvalidAudio ? "skip_dependent_row" : (ref.onMissing === "abort" ? null : ref.onMissing),
                missing: true,
                restoredPath: null,
              });
            }
            expectedPaths.add(archivePath);
            continue;
          }
          assertArchiveFileRefBytes(ref, fileEntry, archivePath);
          validateLogicalFilePayload(ref, row, fileEntry, archivePath);
          const payloadLedger = manifestEntries.get(payloadPath);
          const ledger = manifestEntries.get(archivePath) ?? payloadLedger;
          const ledgerRequired = alias?.required ?? ledger?.required;
          if (buf.manifest.schemaVersion === 3 && (!ledger || ledgerRequired !== ref.required)) {
            throw new Error(`file requiredness does not match registry: ${archivePath}`);
          }
          if (ref.bytesColumn !== undefined && row[ref.bytesColumn] !== null && Number(row[ref.bytesColumn]) !== fileEntry.byteSize) {
            throw new Error(`file byte count does not match ${spec.table}.${ref.bytesColumn}: ${archivePath}`);
          }
          const digest = ledger?.sha256.toLowerCase()
            ?? await sha256File(fileEntry.stagingPath, job.abort.signal, validationDeadlineAt, hashHeartbeat);
          const mappedDigest = mappedPaths.get(archivePath);
          if (mappedDigest !== undefined && mappedDigest !== digest) {
            throw new Error(`file alias maps to conflicting payloads: ${archivePath}`);
          }
          mappedPaths.set(archivePath, digest);
          expectedPaths.add(archivePath);
          if (payloadPath !== archivePath) expectedPaths.add(payloadPath);
          installFiles.set(archivePath, fileEntry);
          let restoredPath = fileEntry.inner;
          if (ref.bucket === "theme-assets") {
            const prefix = `${String(row.bundle_id)}/`;
            if (!restoredPath.startsWith(prefix)) throw new Error(`theme asset path is outside its bundle: ${archivePath}`);
            restoredPath = restoredPath.slice(prefix.length);
          }
          let artifactBinding: Record<string, unknown> | null = null;
          if (ref.bucket === "artifacts") {
            const chatId = row.chat_id;
            const storagePath = row.storage_path;
            const ownerId = row.user_id;
            const mimeType = row.mime_type;
            if (
              typeof chatId !== "string" || chatId.length === 0
              || typeof storagePath !== "string" || storagePath.length === 0
              || typeof ownerId !== "string" || ownerId.length === 0
              || typeof mimeType !== "string"
              || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)
              || new TextEncoder().encode(mimeType).byteLength > 255
            ) {
              throw new Error(`published artifact descriptor is malformed: ${archivePath}`);
            }
            const prefix = `${chatId}/`;
            if (!restoredPath.startsWith(prefix)) throw new Error(`artifact path is outside its chat: ${archivePath}`);
            restoredPath = restoredPath.slice(prefix.length);
            if (restoredPath !== storagePath) throw new Error(`artifact storage path does not match its row: ${archivePath}`);
            const byteCount = Number(row.byte_count);
            if (!Number.isSafeInteger(byteCount) || byteCount < 0 || byteCount !== fileEntry.byteSize) {
              throw new Error(`artifact byte count does not match its row: ${archivePath}`);
            }
            const stagedDigest = await sha256File(fileEntry.stagingPath, job.abort.signal, validationDeadlineAt, hashHeartbeat);
            const blobDigest = row.blob_digest;
            const rowDigest = row.digest;
            if (
              typeof blobDigest !== "string"
              || !/^[0-9a-f]{64}$/i.test(blobDigest)
              || typeof rowDigest !== "string"
              || !/^[0-9a-f]{64}$/i.test(rowDigest)
              || blobDigest.toLowerCase() !== stagedDigest
              || rowDigest.toLowerCase() !== stagedDigest
            ) {
              throw new Error(`published artifact digest does not match its bytes: ${archivePath}`);
            }
            if (
              buf.manifest.schemaVersion === 3
              && (!ledger || ledger.kind !== "file" || ledgerRequired !== ref.required
                || ledger.bytes !== fileEntry.byteSize || ledger.sha256.toLowerCase() !== stagedDigest)
            ) {
              throw new Error(`artifact manifest digest does not match its row: ${archivePath}`);
            }
            if (stagedDigest !== digest) {
              throw new Error(`artifact payload digest changed during staging: ${archivePath}`);
            }
            fileEntry.destinationInner = restoredPath;
            artifactBinding = {
              owner: { table: spec.table, key: ownerId },
              descriptor: {
                kind: "published_artifact",
                ownerTable: spec.table,
                ownerKey: ownerId,
                rowKey: Object.fromEntries(keyColumns.map((column) => [column, row[column]])),
                path: restoredPath,
              },
              mimeType,
              bytes: byteCount,
              sha256: digest,
            };
          }
          const priorPlan = filePlans.get(archivePath);
          if (
            priorPlan
            && (!priorPlan.missing && priorPlan.restoredPath !== restoredPath
              || priorPlan.required !== ref.required)
          ) {
            throw new Error(`file maps to conflicting canonical destinations: ${archivePath}`);
          }
          if (!priorPlan) {
            filePlans.set(archivePath, {
              required: ref.required,
              omissionPolicy: ref.onMissing === "abort" ? null : ref.onMissing,
              missing: false,
              restoredPath,
            });
          }
          if (ref.pathColumn) row[ref.pathColumn] = restoredPath;
          const fileMapping: Record<string, unknown> = {
            archivePath,
            bucket: ref.bucket,
            table: spec.table,
            key: Object.fromEntries(keyColumns.map((column) => [column, row[column]])),
            pathColumn: ref.pathColumn || null,
            restoredPath,
          };
          if (artifactBinding) Object.assign(fileMapping, artifactBinding);
          fileMappings.push(fileMapping);
        }
      }
      const keyValues = keyColumns.map((column) => row[column]);
      const where = keyColumns.map((column) => `${ident(column)} = ?`).join(" AND ");
      if (skipRow) {
        stage.query(`DELETE FROM ${ident(spec.table)} WHERE ${where}`).run(...keyValues.map(sqlBinding));
      } else {
        const changedColumns = spec.fileRefs.map((ref) => ref.pathColumn).filter((column): column is string => typeof column === "string");
        const uniqueColumns = [...new Set(changedColumns)];
        if (uniqueColumns.length > 0) {
          stage.query(`UPDATE ${ident(spec.table)} SET ${uniqueColumns.map((column) => `${ident(column)} = ?`).join(", ")} WHERE ${where}`)
            .run(...uniqueColumns.map((column) => sqlBinding(row[column])), ...keyValues.map(sqlBinding));
        }
      }
    }
  }
  const notificationSoundPath = /^files\/notification-sounds\/completion\.(?:mp3|wav|ogg|aac|m4a)$/;
  if (buf.manifest.schemaVersion <= 2) {
    // V1/V2 have no canonical row or authenticated file ledger for the
    // account-scoped completion sound. Treat the allowlisted descriptor as a
    // legacy optional file, while retaining extraction CRC and audio checks.
    for (const [archivePath, fileEntry] of fileByPath) {
      if (fileEntry.bucket !== "notification-sounds") continue;
      const descriptor = sanitizeEntry(archivePath);
      if (
        descriptor.kind !== "files"
        || descriptor.bucket !== "notification-sounds"
        || !notificationSoundPath.test(archivePath)
      ) {
        throw new Error(`legacy notification sound path is not allowed: ${archivePath}`);
      }
      assertAudioPayload(fileEntry.stagingPath, archivePath);
      assertArchiveFileRefBytes({ bucket: "notification-sounds", mediaPolicy: "notification_audio" }, fileEntry, archivePath);
      if (filePlans.has(archivePath)) {
        throw new Error(`duplicate legacy notification sound plan: ${archivePath}`);
      }
      filePlans.set(archivePath, {
        required: false,
        omissionPolicy: "preserve_absent",
        missing: false,
        restoredPath: descriptor.inner,
      });
      fileMappings.push({
        archivePath,
        bucket: fileEntry.bucket,
        table: "notification_sounds",
        key: { user_id: job.userId },
        owner: { table: "notification_sounds", key: job.userId },
        descriptor: {
          kind: "notification_sound",
          ownerTable: "notification_sounds",
          ownerKey: job.userId,
          path: descriptor.inner,
        },
        pathColumn: null,
        restoredPath: descriptor.inner,
        bytes: fileEntry.byteSize,
      });
    }
  }
  if (buf.manifest.schemaVersion === 3) {
    for (const [archivePath, fileEntry] of fileByPath) {
      if (fileEntry.bucket !== "notification-sounds") continue;
      const descriptor = sanitizeEntry(archivePath);
      if (
        descriptor.kind !== "files"
        || descriptor.bucket !== "notification-sounds"
        || !notificationSoundPath.test(archivePath)
      ) {
        throw new Error(`descriptor-only file is not an allowed notification sound: ${archivePath}`);
      }
      assertArchiveFileRefBytes({ bucket: "notification-sounds", mediaPolicy: "notification_audio" }, fileEntry, archivePath);
      const ledger = manifestEntries.get(archivePath);
      if (!ledger || ledger.kind !== "file" || ledger.required) {
        throw new Error(`notification sound is not declared as an optional V3 file: ${archivePath}`);
      }
      const sourceIdentity = ledger.sourceIdentity;
      if (
        !sourceIdentity
        || typeof sourceIdentity === "string"
        || sourceIdentity.size !== fileEntry.byteSize
      ) {
        throw new Error(`notification sound source identity does not match staged bytes: ${archivePath}`);
      }
      const digest = await sha256File(fileEntry.stagingPath, job.abort.signal, validationDeadlineAt, hashHeartbeat);
      if (ledger.bytes !== fileEntry.byteSize || ledger.sha256.toLowerCase() !== digest) {
        throw new Error(`notification sound descriptor digest mismatch: ${archivePath}`);
      }
      expectedPaths.add(archivePath);
      const mappedDigest = mappedPaths.get(archivePath);
      if (mappedDigest !== undefined && mappedDigest !== digest) {
        throw new Error(`file maps to conflicting payloads: ${archivePath}`);
      }
      mappedPaths.set(archivePath, digest);
      const priorPlan = filePlans.get(archivePath);
      if (
        priorPlan
        && (!priorPlan.missing && priorPlan.restoredPath !== descriptor.inner
          || priorPlan.required)
      ) {
        throw new Error(`file maps to conflicting notification sound destinations: ${archivePath}`);
      }
      if (!priorPlan) {
        filePlans.set(archivePath, {
          required: false,
          omissionPolicy: "preserve_absent",
          missing: false,
          restoredPath: descriptor.inner,
        });
      }
      installFiles.set(archivePath, cloneLogicalBinaryEntry(fileEntry, archivePath));
      fileMappings.push({
        archivePath,
        bucket: fileEntry.bucket,
        table: "notification_sounds",
        key: { user_id: job.userId },
        owner: { table: "notification_sounds", key: job.userId },
        descriptor: {
          kind: "notification_sound",
          ownerTable: "notification_sounds",
          ownerKey: job.userId,
          path: descriptor.inner,
        },
        pathColumn: null,
        restoredPath: descriptor.inner,
        bytes: fileEntry.byteSize,
        sha256: digest,
        sourceIdentity,
      });
    }
    // Aliased descriptor-only notification sounds still need a concrete
    // installed destination. Reuse staged bytes only within the audio class.
    for (const [archivePath, alias] of fileAliases) {
      if (!notificationSoundPath.test(archivePath)) continue;
      const logical = sanitizeEntry(archivePath);
      const payload = sanitizeEntry(alias.payloadPath);
      if (
        logical.kind !== "files"
        || logical.bucket !== "notification-sounds"
        || payload.kind !== "files"
        || archiveFileSafeClass(logical.bucket) !== archiveFileSafeClass(payload.bucket ?? "")
        || (payload.bucket !== "notification-sounds" && payload.bucket !== "audio")
      ) {
        throw new Error(`notification sound alias crosses media classes: ${archivePath}`);
      }
      const payloadEntry = fileByPath.get(alias.payloadPath);
      if (!payloadEntry) throw new Error(`notification sound alias payload is absent: ${archivePath}`);
      assertArchiveFileRefBytes({ bucket: "notification-sounds", mediaPolicy: "notification_audio" }, payloadEntry, archivePath);
      assertAudioPayload(payloadEntry.stagingPath, alias.payloadPath);
      const ledger = manifestEntries.get(alias.payloadPath);
      const sourceIdentity = ledger?.sourceIdentity;
      const digest = await sha256File(payloadEntry.stagingPath, job.abort.signal, validationDeadlineAt, hashHeartbeat);
      if (
        !ledger
        || ledger.kind !== "file"
        || !sourceIdentity
        || typeof sourceIdentity === "string"
        || sourceIdentity.size !== payloadEntry.byteSize
        || ledger.bytes !== payloadEntry.byteSize
        || ledger.sha256.toLowerCase() !== digest
      ) {
        throw new Error(`notification sound alias digest mismatch: ${archivePath}`);
      }
      const priorPlan = filePlans.get(archivePath);
      if (priorPlan && (!priorPlan.missing && priorPlan.restoredPath !== logical.inner || priorPlan.required)) {
        throw new Error(`file maps to conflicting notification sound destinations: ${archivePath}`);
      }
      expectedPaths.add(alias.payloadPath);
      expectedPaths.add(archivePath);
      mappedPaths.set(archivePath, digest);
      filePlans.set(archivePath, {
        required: false,
        omissionPolicy: "preserve_absent",
        missing: false,
        restoredPath: logical.inner,
      });
      const logicalEntry = cloneLogicalBinaryEntry(payloadEntry, archivePath);
      installFiles.set(archivePath, logicalEntry);
      fileMappings.push({
        archivePath,
        bucket: "notification-sounds",
        table: "notification_sounds",
        key: { user_id: job.userId },
        owner: { table: "notification_sounds", key: job.userId },
        descriptor: {
          kind: "notification_sound",
          ownerTable: "notification_sounds",
          ownerKey: job.userId,
          path: logical.inner,
        },
        pathColumn: null,
        restoredPath: logical.inner,
        bytes: payloadEntry.byteSize,
        sha256: digest,
        sourceIdentity,
      });
    }
    for (const missingPath of missingOptional) {
      if (expectedPaths.has(missingPath)) continue;
      const descriptor = sanitizeEntry(missingPath);
      if (
        descriptor.kind !== "files"
        || descriptor.bucket !== "notification-sounds"
        || !notificationSoundPath.test(missingPath)
        || manifestEntries.has(missingPath)
      ) {
        throw new Error(`optional file omission is not registry-declared: ${missingPath}`);
      }
      expectedPaths.add(missingPath);
      filePlans.set(missingPath, {
        required: false,
        omissionPolicy: "preserve_absent",
        missing: true,
        restoredPath: null,
      });
      fileMappings.push({
        archivePath: missingPath,
        bucket: "notification-sounds",
        table: "notification_sounds",
        key: { user_id: job.userId },
        owner: { table: "notification_sounds", key: job.userId },
        descriptor: {
          kind: "notification_sound",
          ownerTable: "notification_sounds",
          ownerKey: job.userId,
          path: descriptor.inner,
        },
        restoredPath: null,
        missing: true,
      });
    }
  }
  // V1/V2 archives predate the closed file-reference ledger and may contain
  // legacy binary entries without a canonical row. V3 is closed: every
  // binary entry must be declared by a registry-owned file reference or the
  // descriptor-only notification-sound record above.
  if (buf.manifest.schemaVersion === 3) {
    for (const path of fileByPath.keys()) {
      if (!expectedPaths.has(path)) throw new Error(`file is not referenced by canonical row: ${path}`);
    }
  }
  if (buf.manifest.schemaVersion === 3) {
    for (const missingPath of missingOptional) {
      if (!filePlans.has(missingPath)) {
        throw new Error(`optional file omission is not registry-declared: ${missingPath}`);
      }
    }
  }
  if (fileMappings.length > MAX_ENTRIES) throw new Error("file reference mapping exceeds cap");
  for (const table of stagedTables) {
    await validateParentEdges(
      stage,
      stagedTables,
      table,
      getArchiveTableSpec(table),
      sourceOwner,
      buf.manifest.schemaVersion,
      job.abort.signal,
      validationDeadlineAt,
      job,
    );
  }

  const secretIndexEntry = buf.entries.find((entry) => entry.table === "__secrets_index__") || null;
  const secretEntry = buf.entries.find((entry) => entry.table === "__secrets_encrypted__") || null;
  let secretIndex: string[] = [];
  if (secretIndexEntry) {
    const parsed = JSON.parse(readCappedTextFile(secretIndexEntry.stagingPath, MAX_SECRETS_INDEX_BYTES, "secrets/index.json"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("secret index is malformed");
    }
    const keys = "keys" in parsed ? parsed.keys : undefined;
    secretIndex = validateSecretIndex(keys);
  }
  if (Boolean((buf.manifest as any).hasEncryptedSecrets) !== (secretEntry !== null)) throw new Error("manifest encrypted-secret flag does not match archive");
  if (secretEntry) {
    const keys = new Set<string>();
    let bytes = 0;
    for await (const raw of readNdjsonEntries(
      secretEntry.stagingPath,
      job.abort.signal,
      validationDeadlineAt,
      job,
    )) {
      if (typeof raw.key !== "string" || typeof raw.iv !== "string" || typeof raw.tag !== "string" || typeof raw.ciphertext !== "string") throw new Error("encrypted secret row is malformed");
      if (keys.has(raw.key)) throw new Error(`duplicate encrypted secret key: ${raw.key}`);
      keys.add(raw.key);
      const rowBytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
      if (rowBytes > MAX_SECRET_BYTES || bytes > MAX_SECRET_BYTES - rowBytes) throw new Error("secret payload exceeds cap");
      bytes += rowBytes;
      if (keys.size > MAX_SECRET_ENTRIES) throw new Error("secret payload exceeds cap");
    }
    if (keys.size !== secretIndex.length || secretIndex.some((key) => !keys.has(key))) throw new Error("secret index does not match encrypted secret rows");
  }
  const mappingJson = JSON.stringify(fileMappings);
  if (mappingJson.length > 16 * 1024 * 1024) throw new Error("file reference metadata exceeds cap");
  stage.query("INSERT INTO __import_meta (key,value) VALUES (?,?)").run("source_owner", sourceOwner || "");
  stage.query("INSERT INTO __import_meta (key,value) VALUES (?,?)").run("file_refs", mappingJson);
  const vectorEntries = buf.entries.filter(
    (entry) => entry.kind === "text" && entry.origin === "lancedb",
  );
  await validateAndDiscardVectorEntries(job, buf.manifest, vectorEntries, stage, sourceOwner);

  stage.close();
  const filesToInstall = buf.manifest.schemaVersion === 3 ? [...installFiles.values()] : files;
  return {
    dbPath,
    db: new Database(dbPath),
    files: filesToInstall,
    vectorEntries,
    secretIndex,
    secretEntry,
    rowCounts,
    filePlans,
  };
}

function fileDestination(userId: string, entry: BufferedBinaryEntry): string {
  const destinationInner = entry.destinationInner ?? entry.inner;
  switch (entry.bucket) {
    case "images":
    case "thumbnails": return safeJoin(join(env.dataDir, "images"), destinationInner);
    case "avatars": return safeJoin(join(env.dataDir, "avatars"), destinationInner);
    case "databank": return safeJoin(join(env.dataDir, "databank", userId), destinationInner);
    case "theme-assets": return safeJoin(join(env.dataDir, "theme-assets", userId), destinationInner);
    case "audio": return safeJoin(join(env.dataDir, "audio"), destinationInner);
    case "notification-sounds": return safeJoin(join(env.dataDir, "notification-sounds", userId), destinationInner);
    case "artifacts": return safeJoin(join(env.dataDir, "agent-artifacts", userId), destinationInner);
    default: throw new Error(`unsupported file bucket ${String(entry.bucket)}`);
  }
}

function fileIdentity(path: string): FileIdentity {
  const stat = statSync(path);
  return { dev: Number(stat.dev), ino: Number(stat.ino), size: stat.size, mtimeMs: stat.mtimeMs };
}

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

type DirectorySyncHook = (path: string) => void;
let directorySyncHook: DirectorySyncHook | null = null;

function isUnsupportedDirectoryFsyncError(error: unknown): boolean {
  const code = systemErrorCode(error);
  if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS") return true;
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES");
}

function syncDirectory(path: string): void {
  try {
    if (directorySyncHook) {
      directorySyncHook(path);
      return;
    }
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) {
    // Windows has no durable directory-fsync primitive; file fsync plus the
    // atomic no-replace install above is the platform-equivalent guarantee.
    if (isUnsupportedDirectoryFsyncError(error)) return;
    throw error;
  }
}
async function syncDirectoryAsync(path: string): Promise<void> {
  try {
    if (directorySyncHook) {
      directorySyncHook(path);
      return;
    }
    const handle = await openAsync(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isUnsupportedDirectoryFsyncError(error)) return;
    throw error;
  }
}
function assertAudioPayload(path: string, archivePath: string): void {
  const extension = archivePath.slice(archivePath.lastIndexOf(".")).toLowerCase();
  const fd = openSync(path, "r");
  const head = new Uint8Array(16);
  let readBytes = 0;
  try {
    readBytes = readSync(fd, head, 0, head.byteLength, 0);
  } finally {
    closeSync(fd);
  }
  const detected = readBytes >= 12 ? detectAudioFormat(head) : null;
  const webm = readBytes >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  const flac = readBytes >= 4 && head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43;
  const valid = extension === ".webm"
    ? webm
    : extension === ".flac"
      ? flac
      : extension === ".bin"
        ? !!detected || webm || flac
        : detected?.extension === extension;
  if (!valid) throw new Error(`audio content does not match extension: ${archivePath}`);
}
function archiveFileSafeClass(bucket: string): "image" | "audio" | "document" | "theme" | "artifact" | null {
  switch (bucket) {
    case "images":
    case "thumbnails":
    case "avatars":
      return "image";
    case "audio":
    case "notification-sounds":
      return "audio";
    case "databank":
      return "document";
    case "theme-assets":
      return "theme";
    case "artifacts":
      return "artifact";
    default:
      return null;
  }
}
function archiveFileRefMaxBytes(ref: { bucket: string; maxBytes?: unknown; mediaPolicy: MediaPolicy }): number {
  return strictestMediaLimit(ref.bucket, ref.maxBytes, ref.mediaPolicy) ?? MAX_ARCHIVE_FILE_BYTES;
}

function assertArchiveFileRefBytes(
  ref: { bucket: string; maxBytes?: unknown; mediaPolicy: MediaPolicy },
  fileEntry: { byteSize: number },
  archivePath: string,
): void {
  const maxBytes = archiveFileRefMaxBytes(ref);
  if (!Number.isSafeInteger(fileEntry.byteSize) || fileEntry.byteSize < 0 || fileEntry.byteSize > maxBytes) {
    throw new Error(`${archivePath} exceeds its ${ref.bucket} file cap (${maxBytes} bytes)`);
  }
}
function validateLogicalFilePayload(
  ref: { bucket: string; mediaPolicy: MediaPolicy },
  row: Record<string, unknown>,
  fileEntry: BufferedBinaryEntry,
  archivePath: string,
): void {
  if (ref.bucket === "audio" || ref.bucket === "notification-sounds") {
    assertAudioPayload(fileEntry.stagingPath, archivePath);
    return;
  }
  const bucket = ref.bucket === "images" || ref.bucket === "thumbnails" || ref.bucket === "avatars" || ref.bucket === "theme-assets" || ref.bucket === "databank"
    ? ref.bucket
    : "artifacts";
  const expectedMimeType = ref.bucket === "thumbnails"
    ? "image/webp"
    : typeof row.mime_type === "string" && row.mime_type.length > 0
      ? row.mime_type
      : null;
  validateSafeMediaFile(fileEntry.stagingPath, {
    filename: archivePath,
    bucket,
    mediaPolicy: ref.mediaPolicy,
    expectedMimeType,
    allowExtensionlessArtifact: ref.bucket === "artifacts",
  });
}

function fileManifestEntry(manifest: ArchiveManifest, path: string): ArchiveEntry | null {
  return manifest.entries?.find((entry) => entry.path === path) ?? null;
}

function rewriteStagedFileReference(stage: StagedArchive, archivePath: string, value: string): void {
  const metadata = stage.db.query("SELECT value FROM __import_meta WHERE key = 'file_refs'").get() as { value: string } | null;
  if (!metadata) throw new Error(`file reference metadata is missing for ${archivePath}`);
  let mappings: Array<Record<string, unknown>>;
  try {
    mappings = JSON.parse(metadata.value) as Array<Record<string, unknown>>;
  } catch {
    throw new Error(`file reference metadata is malformed for ${archivePath}`);
  }
  const matches = mappings.filter(
    (mapping) => mapping.archivePath === archivePath && typeof mapping.pathColumn === "string",
  );
  if (matches.length === 0) throw new Error(`file reference path cannot be rewritten safely: ${archivePath}`);
  let rewritten = 0;
  for (const mapping of matches) {
    const table = typeof mapping.table === "string" ? mapping.table : "";
    const pathColumn = typeof mapping.pathColumn === "string" ? mapping.pathColumn : "";
    const key = mapping.key;
    if (!table || !pathColumn || !key || typeof key !== "object" || Array.isArray(key)) {
      throw new Error(`file reference metadata is incomplete for ${archivePath}`);
    }
    const keyValues = Object.entries(key as Record<string, unknown>);
    if (keyValues.length === 0 || keyValues.some(([, keyValue]) => keyValue === undefined || keyValue === null)) {
      throw new Error(`file reference key is incomplete for ${archivePath}`);
    }
    const where = keyValues.map(([column]) => `${ident(column)} = ?`).join(" AND ");
    const result = stage.db.query(
      `UPDATE ${ident(table)} SET ${ident(pathColumn)} = ? WHERE ${where}`,
    ).run(value, ...keyValues.map(([, keyValue]) => sqlBinding(keyValue)));
    if (result.changes !== 1) throw new Error(`file reference row cannot be rewritten safely: ${archivePath}`);
    rewritten++;
  }
  if (rewritten !== matches.length) throw new Error(`file reference rewrite is incomplete: ${archivePath}`);
}

function contentAddressedFilePath(
  job: Pick<ImportJob, "jobId">,
  entry: BufferedBinaryEntry,
  digest: string,
  creatorToken: string,
): { destinationInner: string; rowPath: string } {
  if (!/^[0-9a-f-]{36}$/i.test(creatorToken)) {
    throw new Error("file journal creator token is malformed");
  }
  const originalName = basename(entry.inner).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "blob";
  const marker = `.lv-import/${job.jobId}-${creatorToken}-${digest}-${originalName}`;
  if (entry.bucket === "theme-assets") {
    const bundle = entry.inner.split("/")[0];
    return { destinationInner: `${bundle}/${marker}`, rowPath: marker };
  }
  return { destinationInner: marker, rowPath: marker };
}

interface CopyNoReplaceOptions {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  readonly heartbeat?: FileHashHeartbeat;
}

async function copyNoReplace(
  sourcePath: string,
  destinationPath: string,
  onCreated?: (identity: FileIdentity) => void,
  writeChunk: (fd: number, chunk: Uint8Array) => void = writeAllSync,
  options: CopyNoReplaceOptions = {},
): Promise<boolean> {
  let sourceFd: number | null = null;
  let destinationFd: number | null = null;
  let createdByUs = false;
  let completed = false;
  let failed = false;
  let failure: unknown;
  try {
    checkImportBudget(options.signal, options.deadlineAt);
    destinationFd = openSync(destinationPath, "wx");
    createdByUs = true;
    onCreated?.(fileIdentity(destinationPath));
    checkImportBudget(options.signal, options.deadlineAt);
    sourceFd = openSync(sourcePath, "r");
    const buffer = new Uint8Array(ARCHIVE_READ_BYTES);
    let position = 0;
    let bytesSinceHeartbeat = 0;
    while (true) {
      checkImportBudget(options.signal, options.deadlineAt);
      const read = readSync(sourceFd, buffer, 0, buffer.byteLength, position);
      if (read <= 0) break;
      writeChunk(destinationFd, buffer.subarray(0, read));
      checkImportBudget(options.signal, options.deadlineAt);
      position += read;
      bytesSinceHeartbeat += read;
      checkImportBudget(options.signal, options.deadlineAt);
      if (bytesSinceHeartbeat < COPY_HEARTBEAT_BYTES) continue;
      options.heartbeat?.();
      await new Promise<void>((resolve) => setTimeout(resolve, YIELD_INTERVAL_MS));
      checkImportBudget(options.signal, options.deadlineAt);
      bytesSinceHeartbeat = 0;
    }
    options.heartbeat?.();
    checkImportBudget(options.signal, options.deadlineAt);
    fsyncSync(destinationFd);
    options.heartbeat?.();
    checkImportBudget(options.signal, options.deadlineAt);
    completed = true;
  } catch (error) {
    if (!createdByUs && systemErrorCode(error) === "EEXIST") return false;
    failed = true;
    failure = error;
  } finally {
    // The destination must be closed before cleanup. This is required on
    // Windows, where unlinking an open handle fails and a swallowed cleanup
    // error would leave a retry-blocking partial content-addressed file.
    if (sourceFd !== null) closeSync(sourceFd);
    if (destinationFd !== null) closeSync(destinationFd);
  }
  if (failed || !completed) {
    if (createdByUs) {
      try {
        unlinkSync(destinationPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [failure, cleanupError],
          `unable to remove failed import copy: ${destinationPath}`,
        );
      }
    }
    throw failure;
  }
  return true;
}

function parseFileIdentity(value: string | null | undefined): FileIdentity | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Partial<FileIdentity>;
    const dev = parsed.dev;
    const ino = parsed.ino;
    const size = parsed.size;
    const mtimeMs = parsed.mtimeMs;
    if (
      typeof dev !== "number" || !Number.isSafeInteger(dev) || dev < 0
      || typeof ino !== "number" || !Number.isSafeInteger(ino) || ino < 0
      || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0
      || typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs) || mtimeMs < 0
    ) return null;
    return { dev, ino, size, mtimeMs };
  } catch {
    return null;
  }
}

function journalIdentityHasToken(value: string | null | undefined, token: string): boolean {
  if (!token || typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value) as { creatorToken?: unknown };
    return parsed && typeof parsed === "object" && parsed.creatorToken === token;
  } catch {
    return false;
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function canonicalJournalFinalPath(row: JournaledImportFile): string | null {
  if (!row.final_path || !row.user_id || !/^[0-9a-f]{64}$/i.test(row.sha256)) return null;
  try {
    const descriptor = sanitizeEntry(row.archive_path);
    if (descriptor.kind !== "files" || !descriptor.bucket || !descriptor.inner) return null;
    const entry: BufferedBinaryEntry = {
      kind: "binary",
      bucket: descriptor.bucket,
      inner: descriptor.inner,
      stagingPath: "",
      byteSize: row.byte_count,
    };
    const finalPath = resolve(row.final_path);
    const candidates = [fileDestination(row.user_id, entry)];
    // Published artifacts store chat-relative storage_path values in their
    // canonical row, while the archive path carries the chat prefix.
    if (entry.bucket === "artifacts") {
      const separator = entry.inner.indexOf("/");
      if (separator > 0) {
        entry.destinationInner = entry.inner.slice(separator + 1);
        candidates.push(fileDestination(row.user_id, entry));
      }
    }
    const fallback = contentAddressedFilePath(
      { jobId: row.job_id },
      entry,
      row.sha256.toLowerCase(),
      row.install_token,
    );
    entry.destinationInner = fallback.destinationInner;
    candidates.push(fileDestination(row.user_id, entry));
    return candidates.find((candidate) => resolve(candidate) === finalPath) || null;
  } catch {
    return null;
  }
}

interface LiveFileReferenceIndex {
  readonly paths: Set<string>;
  readonly complete: boolean;
  readonly scannedRows: number;
  readonly scannedReferences: number;
}

/**
 * Resolve every canonical file reference once before rollback. A previous
 * implementation repeated this full registry scan for every journal row,
 * making recovery O(files * live rows). If the bounded index cannot be
 * complete, rollback fails closed and leaves the target for reconciliation.
 */
function buildLiveFileReferenceIndex(db: Database = getDb()): LiveFileReferenceIndex {
  const paths = new Set<string>();
  let scannedRows = 0;
  let scannedReferences = 0;
  for (const spec of ARCHIVE_CANONICAL_TABLES) {
    if (!sqliteTableExists(db, spec.table)) continue;
    let columns: string[];
    try {
      columns = getTableColumnsFrom(db, spec.table).map((column) => column.name);
    } catch {
      return { paths, complete: false, scannedRows, scannedReferences };
    }
    const refs = spec.fileRefs.filter((ref) => ref.pathColumn && columns.includes(ref.pathColumn));
    if (refs.length === 0) continue;
    let rows: Iterable<Record<string, unknown>>;
    try {
      rows = db.query(`SELECT * FROM ${ident(spec.table)}`).iterate() as Iterable<Record<string, unknown>>;
    } catch {
      return { paths, complete: false, scannedRows, scannedReferences };
    }
    for (const row of rows) {
      scannedRows++;
      for (const ref of refs) {
        let resolved: string[];
        try {
          resolved = typeof ref.resolve === "function"
            ? ref.resolve(row as Record<string, any>, env.dataDir)
            : [];
        } catch {
          // A malformed row makes the complete live-reference proof unknown.
          return { paths, complete: false, scannedRows, scannedReferences };
        }
        for (const path of resolved) {
          scannedReferences++;
          let normalized: string;
          try {
            normalized = resolve(path);
          } catch {
            return { paths, complete: false, scannedRows, scannedReferences };
          }
          if (!paths.has(normalized) && paths.size >= MAX_LIVE_FILE_REFERENCES) {
            return { paths, complete: false, scannedRows, scannedReferences };
          }
          paths.add(normalized);
        }
      }
    }
  }
  return { paths, complete: true, scannedRows, scannedReferences };
}

function liveFileReferenceExists(finalPath: string, index: LiveFileReferenceIndex): boolean {
  let target: string;
  try {
    target = resolve(finalPath);
  } catch {
    return true;
  }
  // An incomplete proof must never authorize deletion.
  return !index.complete || index.paths.has(target);
}

interface ImportRollbackFence {
  readonly leaseOwner: string;
  readonly leaseGeneration: number;
}

async function rollbackCreatedFiles(
  jobId: string,
  fence: ImportRollbackFence,
  liveReferences?: LiveFileReferenceIndex,
  deadlineAt = Date.now() + IMPORT_FILE_OPERATION_DEADLINE_MS,
): Promise<void> {
  const db = getDb();
  const snapshot = db.transaction(() => {
    const now = nowSeconds();
    const locked = db.query(
      `UPDATE user_data_imports
          SET updated_at = ?
        WHERE job_id = ? AND lease_owner = ? AND lease_generation = ?
          AND state <> 'committed'
          AND (state IN ('failed','cancelled') OR lease_expires_at IS NULL OR lease_expires_at > ?)`,
    ).run(now, jobId, fence.leaseOwner, fence.leaseGeneration, now);
    if (locked.changes !== 1) return null;
    const rows = db.query(
      `SELECT f.*, i.user_id
         FROM user_data_import_files f
         JOIN user_data_imports i ON i.job_id = f.job_id
        WHERE f.job_id = ? AND f.install_state IN ('pending','created')
          AND i.lease_owner = ? AND i.lease_generation = ? AND i.state <> 'committed'`,
    ).all(jobId, fence.leaseOwner, fence.leaseGeneration) as JournaledImportFile[];
    return {
      rows,
      referenceIndex: liveReferences ?? buildLiveFileReferenceIndex(db),
    };
  })() as { rows: JournaledImportFile[]; referenceIndex: LiveFileReferenceIndex } | null;
  if (!snapshot || snapshot.rows.length === 0) return;
  const assertRecoveryFence = (): void => {
    if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) {
      throw new Error("import recovery deadline exceeded");
    }
    const currentFence = db.query(
      "SELECT lease_owner, lease_generation, state FROM user_data_imports WHERE job_id = ?",
    ).get(jobId) as { lease_owner?: string | null; lease_generation?: number; state?: string } | null;
    if (
      currentFence?.lease_owner !== fence.leaseOwner
      || currentFence.lease_generation !== fence.leaseGeneration
      || currentFence.state === "committed"
    ) {
      throw new Error("import lease fence lost");
    }
  };
  let rowsSinceYield = 0;
  let bytesSinceYield = 0;
  for (const row of snapshot.rows) {
    assertRecoveryFence();
    rowsSinceYield++;
    if (rowsSinceYield > 64 || bytesSinceYield >= 1024 * 1024) {
      rowsSinceYield = 0;
      bytesSinceYield = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, YIELD_INTERVAL_MS));
      assertRecoveryFence();
    }
    if (
      !row.install_token
      || !journalIdentityHasToken(row.staged_identity, row.install_token)
    ) continue;
    const canonical = canonicalJournalFinalPath(row);
    if (!canonical || resolve(canonical) !== resolve(row.final_path)) continue;
    if (liveFileReferenceExists(row.final_path, snapshot.referenceIndex)) continue;
    const markRemoved = (): void => {
      db.query(
        `UPDATE user_data_import_files
            SET install_state = 'removed', updated_at = ?
          WHERE id = ? AND job_id = ? AND install_token = ?
            AND install_state IN ('pending','created')
            AND EXISTS (
              SELECT 1 FROM user_data_imports i
               WHERE i.job_id = user_data_import_files.job_id
                 AND i.job_id = ? AND i.lease_owner = ?
                 AND i.lease_generation = ? AND i.state <> 'committed'
            )`,
      ).run(
        nowSeconds(),
        row.id,
        jobId,
        row.install_token,
        jobId,
        fence.leaseOwner,
        fence.leaseGeneration,
      );
    };
    let finalStat: Awaited<ReturnType<typeof lstatAsync>> | null = null;
    try {
      finalStat = await lstatAsync(row.final_path);
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT") {
        assertRecoveryFence();
        markRemoved();
      }
      continue;
    }
    if (!finalStat.isFile()) continue;
    bytesSinceYield += finalStat.size;
    const current: FileIdentity = {
      dev: Number(finalStat.dev),
      ino: Number(finalStat.ino),
      size: finalStat.size,
      mtimeMs: finalStat.mtimeMs,
    };
    const staged = parseFileIdentity(row.staged_identity);
    const observed = parseFileIdentity(row.observed_final_identity);
    // Pending hard-link journals prove creation only when the destination
    // still aliases the immutable staged inode. EXDEV fallback journals record
    // their destination inode before bytes are copied; that proof remains
    // sufficient to remove a crash-retained partial file, even when its
    // size/digest does not match the intended payload.
    const creatorProof = row.install_state === "pending"
      ? staged !== null && sameFileIdentity(current, staged)
      : observed !== null && current.dev === observed.dev && current.ino === observed.ino;
    if (!creatorProof) continue;
    try {
      assertRecoveryFence();
      await unlinkAsync(row.final_path);
      await syncDirectoryAsync(dirname(row.final_path));
      assertRecoveryFence();
      markRemoved();
    } catch (error) {
      if (
        error instanceof Error
        && (error.message === "import recovery deadline exceeded" || error.message === "import lease fence lost")
      ) throw error;
      // A malformed or raced filesystem entry remains journaled for the next
      // recovery pass; never infer creator ownership after an unlink failure.
    }
  }
}

async function assertInstalledFileJournalIntact(
  jobId: string,
  db: Database = getDb(),
  signal?: AbortSignal,
  deadlineAt?: number,
  heartbeat?: FileHashHeartbeat,
): Promise<void> {
  const rows = db.query(
    `SELECT f.*, i.user_id
       FROM user_data_import_files f
       JOIN user_data_imports i ON i.job_id = f.job_id
      WHERE f.job_id = ? AND f.install_state IN ('created', 'preexisting')`,
  ).all(jobId) as JournaledImportFile[];
  for (const row of rows) {
    const canonical = canonicalJournalFinalPath(row);
    const observed = parseFileIdentity(row.observed_final_identity);
    if (
      !canonical
      || resolve(canonical) !== resolve(row.final_path)
      || !observed
      || !existsSync(row.final_path)
    ) {
      throw new Error(`installed file journal is incomplete: ${row.archive_path}`);
    }
    const current = fileIdentity(row.final_path);
    if (
      !sameFileIdentity(current, observed)
      || current.size !== row.byte_count
      || await sha256File(row.final_path, signal, deadlineAt, heartbeat) !== row.sha256.toLowerCase()
    ) {
      throw new Error(`installed file changed before relational commit: ${row.archive_path}`);
    }
  }
}

async function installValidatedFiles(job: ImportJob, stage: StagedArchive): Promise<void> {
  const db = getDb();
  const manifest = job.manifest;
  if (!manifest) throw new Error("archive manifest is missing");
  transitionImport(job, "installing", ["validating", "awaiting_ticket", "ready"]);
  for (const [archivePath, plan] of stage.filePlans) {
    if (!plan.missing) continue;
    if (plan.required) throw new Error(`required file omission reached installation: ${archivePath}`);
    const now = nowSeconds();
    db.query(
      `INSERT INTO user_data_import_files
       (job_id,archive_path,kind,staged_path,final_path,sha256,byte_count,required,install_token,
        staged_identity,observed_final_identity,omission_policy,install_state,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'skipped',?,?)`,
    ).run(
      job.jobId,
      archivePath,
      "file",
      "",
      "",
      "0".repeat(64),
      0,
      0,
      crypto.randomUUID(),
      "{}",
      null,
      plan.omissionPolicy,
      now,
      now,
    );
  }
  for (const entry of stage.files) {
    if (job.abort.signal.aborted) throw job.abort.signal.reason ?? new Error("import cancelled");
    const archivePath = `files/${entry.bucket}/${entry.inner}`;
    const plan = stage.filePlans.get(archivePath);
    if (!plan || plan.missing) {
      if (manifest.schemaVersion === 3) throw new Error(`file has no registry installation plan: ${archivePath}`);
      throw new Error(`legacy file has no canonical installation plan: ${archivePath}`);
    }
    const fileDeadlineAt = Date.now() + IMPORT_FILE_OPERATION_DEADLINE_MS;
    const fileHeartbeat: FileHashHeartbeat = () => {
      renewImportLease(job, db);
      assertCurrentFence(job, db);
    };
    fileHeartbeat();
    const digest = await sha256File(entry.stagingPath, job.abort.signal, fileDeadlineAt, fileHeartbeat);
    const byteCount = statSync(entry.stagingPath).size;
    if (byteCount > MAX_ARCHIVE_FILE_BYTES) {
      throw new Error(`${archivePath} exceeds ${MAX_ARCHIVE_FILE_BYTES} bytes`);
    }
    const alias = manifest.fileAliases?.find((candidate) => candidate.path === archivePath);
    const payloadPath = alias?.payloadPath ?? archivePath;
    const manifestEntry = fileManifestEntry(manifest, payloadPath);
    const manifestRequired = alias?.required ?? manifestEntry?.required;
    if (
      manifestEntry
      && (manifestEntry.bytes !== byteCount || manifestEntry.sha256.toLowerCase() !== digest)
    ) throw new Error(`file manifest digest mismatch: ${archivePath}`);
    if (manifest.schemaVersion === 3 && (!manifestEntry || manifestRequired !== plan.required)) {
      throw new Error(`file requiredness does not match registry: ${archivePath}`);
    }
    let finalPath = fileDestination(job.userId, entry);
    ensureDir(dirname(finalPath));
    const staged = fileIdentity(entry.stagingPath);
    const token = crypto.randomUUID();
    db.query(
      `INSERT INTO user_data_import_files
       (job_id,archive_path,kind,staged_path,final_path,sha256,byte_count,required,install_token,
        staged_identity,observed_final_identity,omission_policy,install_state,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?,?)`,
    ).run(
      job.jobId,
      archivePath,
      "file",
      entry.stagingPath,
      finalPath,
      digest,
      byteCount,
      plan.required ? 1 : 0,
      token,
      JSON.stringify({ ...staged, creatorToken: token }),
      null,
      plan.omissionPolicy,
      nowSeconds(),
      nowSeconds(),
    );
    let created = false;
    let creatorFinalIdentity: FileIdentity | null = null;
    const markInstalledFile = (state: "created" | "preexisting", identity: FileIdentity): void => {
      const marked = db.query(
        `UPDATE user_data_import_files
            SET observed_final_identity = ?, install_state = ?, updated_at = ?
          WHERE job_id = ? AND install_token = ? AND install_state = 'pending'
            AND EXISTS (
              SELECT 1 FROM user_data_imports i
               WHERE i.job_id = user_data_import_files.job_id
                 AND i.job_id = ? AND i.lease_owner = ?
                 AND i.lease_generation = ? AND i.state <> 'committed'
            )`,
      ).run(
        JSON.stringify(identity),
        state,
        nowSeconds(),
        job.jobId,
        token,
        job.jobId,
        job.leaseOwner,
        job.leaseGeneration,
      );
      if (marked.changes !== 1) throw new Error("import lease fence lost before file journal state");
    };
    try {
      const journal = db.query(
        `SELECT f.*, i.user_id
           FROM user_data_import_files f
           JOIN user_data_imports i ON i.job_id = f.job_id
          WHERE f.job_id = ? AND f.archive_path = ?`,
      ).get(job.jobId, archivePath) as JournaledImportFile | null;
      if (!journal || journal.install_token !== token || !canonicalJournalFinalPath(journal)) {
        throw new Error(`file journal ownership is malformed: ${archivePath}`);
      }
      const expectedStaged = parseFileIdentity(journal.staged_identity);
      if (!expectedStaged || !sameFileIdentity(staged, expectedStaged)) {
        throw new Error(`staged file identity changed before install: ${archivePath}`);
      }
      if (await sha256File(entry.stagingPath, job.abort.signal, fileDeadlineAt, fileHeartbeat) !== journal.sha256 || staged.size !== journal.byte_count) {
        throw new Error(`staged file digest changed before install: ${archivePath}`);
      }
      syncFile(entry.stagingPath);
      try {
        linkSync(entry.stagingPath, finalPath);
        created = true;
        const creatorIdentity = fileIdentity(finalPath);
        creatorFinalIdentity = creatorIdentity;
        markInstalledFile("created", creatorIdentity);
      } catch (err) {
        const errorCode = systemErrorCode(err);
        if (errorCode === "EEXIST") {
          if (!lstatSync(finalPath).isFile() || await sha256File(finalPath, job.abort.signal, fileDeadlineAt, fileHeartbeat) !== digest) {
            throw new Error(`pre-existing file digest mismatch: ${archivePath}`);
          }
          const preexistingIdentity = fileIdentity(finalPath);
          markInstalledFile("preexisting", preexistingIdentity);
          creatorFinalIdentity = null;
        } else if (errorCode === "EXDEV" || errorCode === "EPERM" || errorCode === "ENOTSUP") {
          const fallback = contentAddressedFilePath(job, entry, digest, token);
          rewriteStagedFileReference(stage, archivePath, fallback.rowPath);
          entry.destinationInner = fallback.destinationInner;
          plan.restoredPath = fallback.rowPath;
          finalPath = fileDestination(job.userId, entry);
          ensureDir(dirname(finalPath));
          db.query(
            "UPDATE user_data_import_files SET final_path = ? WHERE job_id = ? AND install_token = ? AND install_state = 'pending'",
          ).run(finalPath, job.jobId, token);
          if (existsSync(finalPath)) {
            if (!lstatSync(finalPath).isFile() || await sha256File(finalPath, job.abort.signal, fileDeadlineAt, fileHeartbeat) !== digest) {
              throw new Error(`content-addressed destination digest mismatch: ${archivePath}`);
            }
            const preexistingIdentity = fileIdentity(finalPath);
            markInstalledFile("preexisting", preexistingIdentity);
            creatorFinalIdentity = null;
          } else {
            created = await copyNoReplace(
              entry.stagingPath,
              finalPath,
              (creatorIdentity) => {
                assertCurrentFence(job, db);
                markInstalledFile("created", creatorIdentity);
              },
              writeAllSync,
              { signal: job.abort.signal, deadlineAt: fileDeadlineAt, heartbeat: fileHeartbeat },
            );
            if (!created) {
              if (!lstatSync(finalPath).isFile() || await sha256File(finalPath, job.abort.signal, fileDeadlineAt, fileHeartbeat) !== digest) {
                throw new Error(`content-addressed destination digest mismatch: ${archivePath}`);
              }
              const preexistingIdentity = fileIdentity(finalPath);
              markInstalledFile("preexisting", preexistingIdentity);
              creatorFinalIdentity = null;
            } else {
              creatorFinalIdentity = fileIdentity(finalPath);
            }
          }
        } else {
          throw err;
        }
      }
      syncDirectory(dirname(finalPath));
      assertCurrentFence(job, db);
      const observed = fileIdentity(finalPath);
      if (observed.size !== byteCount || await sha256File(finalPath, job.abort.signal, fileDeadlineAt, fileHeartbeat) !== digest) {
        throw new Error(`installed file digest or size changed before journal success: ${archivePath}`);
      }
      if (created && (!creatorFinalIdentity || !sameFileIdentity(observed, creatorFinalIdentity))) {
        throw new Error(`installed file creator proof changed before journal success: ${archivePath}`);
      }
      const updated = db.query(
        "UPDATE user_data_import_files SET observed_final_identity = ?, install_state = ?, updated_at = ? WHERE job_id = ? AND install_token = ? AND install_state IN ('pending','created','preexisting')",
      ).run(JSON.stringify(observed), created ? "created" : "preexisting", nowSeconds(), job.jobId, token);
      if (updated.changes !== 1) throw new Error("import lease fence lost");
      if (created) job.fileSummary[entry.bucket] = (job.fileSummary[entry.bucket] || 0) + 1;
    } catch (err) {
      // This is still before the relational receipt. Roll back only journaled
      // files whose creator proof, canonical path, digest, and no-live-ref
      // checks all pass; unrelated/shared files remain untouched.
      try {
        await rollbackCreatedFiles(job.jobId, {
          leaseOwner: job.leaseOwner,
          leaseGeneration: job.leaseGeneration,
        });
      } catch {}
      throw err;
    }
  }
}
function hasUnsettledFileJournal(jobId: string, db: Database = getDb()): boolean {
  const row = db.query(
    "SELECT 1 AS present FROM user_data_import_files WHERE job_id = ? AND install_state IN ('pending','created') LIMIT 1",
  ).get(jobId) as { present?: number } | null;
  return row?.present === 1;
}

/**
 * A receipt makes the relational commit authoritative. Reconcile legacy
 * `pending`/`created`/`preexisting` rows only after rechecking the exact final
 * path, digest, and observed identity; then settle them to the single
 * post-commit state used by cleanup.
 */
async function settleCommittedFileJournals(
  jobId: string,
  db: Database = getDb(),
  deadlineAt = Date.now() + IMPORT_FILE_OPERATION_DEADLINE_MS,
): Promise<boolean> {
  const hashHeartbeat: FileHashHeartbeat = () => {
    if (Date.now() >= deadlineAt) throw new Error("import recovery deadline exceeded");
  };
  const rows = db.query(
    `SELECT f.*, i.user_id
       FROM user_data_import_files f
       JOIN user_data_imports i ON i.job_id = f.job_id
      WHERE f.job_id = ? AND f.install_state IN ('pending','created','preexisting')`,
  ).all(jobId) as JournaledImportFile[];
  for (const row of rows) {
    try {
      const canonical = canonicalJournalFinalPath(row);
      if (
        !canonical
        || resolve(canonical) !== resolve(row.final_path)
        || !journalIdentityHasToken(row.staged_identity, row.install_token)
        || !existsSync(row.final_path)
        || !lstatSync(row.final_path).isFile()
      ) return false;
      const observed = parseFileIdentity(row.observed_final_identity);
      const current = fileIdentity(row.final_path);
      if (
        (observed && !sameFileIdentity(current, observed))
        || current.size !== row.byte_count
        || await sha256File(row.final_path, undefined, deadlineAt, hashHeartbeat) !== row.sha256.toLowerCase()
      ) return false;
      const updated = db.query(
        `UPDATE user_data_import_files
            SET observed_final_identity = ?, install_state = 'installed', updated_at = ?
          WHERE id = ? AND job_id = ? AND install_token = ?
            AND install_state IN ('pending','created','preexisting')`,
      ).run(JSON.stringify(current), nowSeconds(), row.id, jobId, row.install_token);
      if (updated.changes !== 1) return false;
    } catch {
      return false;
    }
  }
  return !hasUnsettledFileJournal(jobId, db);
}

function authorityResetRow(
  table: string,
  row: Record<string, any>,
  spec: unknown,
): Record<string, any> {
  const out = { ...row };
  const reset = spec && typeof spec === "object" ? (spec as any).authorityReset : null;
  if (reset && typeof reset === "object") for (const [column, value] of Object.entries(reset)) if (Object.hasOwn(out, column)) out[column] = value;
  const resetKind = typeof reset === "string" ? reset : null;
  const forceReview = resetKind === "review_required"
    || /^preset_agent_/i.test(table)
    || /^chat_agent_/i.test(table);
  if (/^images$/i.test(table)) {
    // Public image-generation access is server authority, never portable
    // archive data. Clear both the explicit marker and the legacy filename
    // hint so restored rows cannot become unauthenticated results.
    if (Object.hasOwn(out, "public_provenance")) out.public_provenance = null;
    if (typeof out.original_filename === "string" && /^image-gen-/i.test(out.original_filename)) {
      out.original_filename = "";
    }
  }
  const importedConnectionTable = /^(connection_profiles|image_gen_connections|tts_connections|stt_connections)$/i.test(table);
  if (importedConnectionTable && Object.hasOwn(out, "metadata")) {
    let metadata: Record<string, unknown> = {};
    if (typeof out.metadata === "string") {
      try {
        const parsed = JSON.parse(out.metadata);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
      } catch {
        // A malformed imported metadata payload is still inert; replace it with
        // the explicit review marker rather than exposing it to runtime.
      }
    } else if (out.metadata && typeof out.metadata === "object" && !Array.isArray(out.metadata)) {
      metadata = out.metadata as Record<string, unknown>;
    }
    out.metadata = JSON.stringify(markImportedConnectionForReview(metadata));
  }
  const forceDisabled = resetKind === "disabled"
    || forceReview
    || /^extensions$/i.test(table);
  if (Object.hasOwn(out, "has_api_key")) out.has_api_key = 0;
  if (forceDisabled || /connection/i.test(table)) {
    for (const column of ["enabled", "is_enabled", "is_active", "active", "agents_enabled", "granted", "is_granted"]) {
      if (!Object.hasOwn(out, column)) continue;
      out[column] = typeof out[column] === "boolean" ? false : 0;
    }
  }
  if (forceReview) {
    for (const column of ["review_state", "state"]) {
      if (Object.hasOwn(out, column)) out[column] = "review_required";
    }
    if (Object.hasOwn(out, "review_acknowledged")) out.review_acknowledged = 0;
  }
  if (forceReview && Object.hasOwn(out, "review_code")) out.review_code = "foreign_import";
  if (forceReview) {
    // Imported authority must remain inert, but its revision must stay writable.
    // A foreign MAX_SAFE_INTEGER revision would make the first local repair
    // overflow the schema check before the user can acknowledge it.
    for (const column of ["revision", "config_revision", "binding_revision"]) {
      if (Object.hasOwn(out, column)) out[column] = 1;
    }
  }
  if (/^preset_agent_configs$/i.test(table) && Object.hasOwn(out, "config_json")) {
    try {
      const config = typeof out.config_json === "string" ? JSON.parse(out.config_json) : out.config_json;
      if (config && typeof config === "object" && !Array.isArray(config)) {
        (config as Record<string, unknown>).reviewAcknowledgements = [];
        out.config_json = JSON.stringify(config);
      } else {
        out.config_json = "{}";
      }
    } catch {
      out.config_json = "{}";
    }
  }
  if (Object.hasOwn(out, "allowed_modes") && forceReview) out.allowed_modes = "[\"response\"]";
  if (Object.hasOwn(out, "default_mode") && forceReview) out.default_mode = "response";
  if (/^chat_agent_mode_overrides$/i.test(table) && Object.hasOwn(out, "mode")) out.mode = null;
  if (/^preset_agent_slot_bindings$/i.test(table)) {
    if (Object.hasOwn(out, "connection_id")) out.connection_id = null;
    if (Object.hasOwn(out, "state")) out.state = "review_required";
    if (Object.hasOwn(out, "review_code")) out.review_code = "foreign_import";
  }
  if (/^extensions$/i.test(table) && Object.hasOwn(out, "enabled")) out.enabled = 0;
  if (/^world_book_entries$/i.test(table)) {
    const vectorized = out.vectorized === true || out.vectorized === 1;
    if (Object.hasOwn(out, "vector_index_status")) out.vector_index_status = vectorized ? "pending" : "not_enabled";
    if (Object.hasOwn(out, "vector_indexed_at")) out.vector_indexed_at = null;
    if (Object.hasOwn(out, "vector_index_error")) out.vector_index_error = null;
  }
  return out;
}
export function stripImportedLegacyPresetMetadataV1(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("preset metadata is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("preset metadata must be a plain object");
  }
  const metadata = parsed as Record<string, unknown>;
  if (Object.hasOwn(metadata, "agentConfig")) {
    parseLegacyAgentConfigV1(metadata.agentConfig);
  }
  return JSON.stringify(scrubPresetMetadata(metadata));
}

interface ImportedLegacyAgentConfigV1 {
  presetId: string;
  config: LegacyAgentConfigV1;
}

function collectImportedLegacyAgentConfigs(stage: StagedArchive): ImportedLegacyAgentConfigV1[] {
  if (!sqliteTableExists(stage.db, "presets")) return [];
  const hasNormalizedConfigs = sqliteTableExists(stage.db, "preset_agent_configs");
  const collected: ImportedLegacyAgentConfigV1[] = [];
  for (const row of stage.db.query("SELECT id, user_id, metadata FROM presets").iterate() as Iterable<Record<string, unknown>>) {
    if (typeof row.id !== "string" || typeof row.metadata !== "string") continue;
    let metadata: unknown;
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      throw new Error("preset metadata is not valid JSON");
    }
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      throw new Error("preset metadata must be a plain object");
    }
    if (!Object.hasOwn(metadata, "agentConfig")) continue;
    if (hasNormalizedConfigs && stage.db.query(
      "SELECT 1 FROM preset_agent_configs WHERE user_id = ? AND preset_id = ? LIMIT 1",
    ).get(String(row.user_id ?? ""), row.id)) continue;
    collected.push({
      presetId: row.id,
      config: parseLegacyAgentConfigV1((metadata as Record<string, unknown>).agentConfig),
    });
  }
  return collected;
}

function rewriteOwner(
  table: string,
  row: Record<string, any>,
  spec: unknown,
  userId: string,
): Record<string, any> {
  const out = authorityResetRow(table, row, spec);
  if (/^presets$/i.test(table) && typeof out.metadata === "string") {
    out.metadata = stripImportedLegacyPresetMetadataV1(out.metadata);
  }
  const owner = registryOwner(spec);
  if (owner?.kind === "direct" && typeof owner.column === "string" && Object.hasOwn(out, owner.column)) out[owner.column] = userId;
  if (Object.hasOwn(out, "installed_by_user_id")) out.installed_by_user_id = userId;
  if (Object.hasOwn(out, "user_id")) out.user_id = userId;
  return out;
}

async function encryptImportedSecret(plaintext: string): Promise<{ encrypted: string; iv: string; tag: string }> {
  const key = await crypto.subtle.importKey("raw", getEncryptionKeyBytes() as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
  return { encrypted: Buffer.from(combined.slice(0, -16)).toString("base64"), iv: Buffer.from(iv).toString("base64"), tag: Buffer.from(combined.slice(-16)).toString("base64") };
}

async function prepareSecrets(
  stage: StagedArchive,
  ticket: { ticket: DecryptionTicket; smk: Uint8Array } | null,
  signal: AbortSignal,
): Promise<PreparedSecret[]> {
  if (!stage.secretEntry || !ticket) return [];
  const validatedIndex = validateSecretIndex(stage.secretIndex);
  const expectedKeys = new Set(validatedIndex);
  const seenKeys = new Set<string>();
  const prepared: PreparedSecret[] = [];
  let plaintextBytes = 0;
  for (const raw of readNdjsonEntriesSync(stage.secretEntry.stagingPath, NDJSON_MAX_RECORD_BYTES)) {
    if (signal.aborted) throw signal.reason ?? new Error("import cancelled");
    const entry = raw as Partial<EncryptedSecretEntry>;
    if (
      typeof entry.key !== "string"
      || typeof entry.iv !== "string"
      || typeof entry.tag !== "string"
      || typeof entry.ciphertext !== "string"
      || !expectedKeys.has(entry.key)
      || seenKeys.has(entry.key)
    ) {
      throw new Error("encrypted secret rows do not match the exact secret index");
    }
    if (seenKeys.size >= MAX_SECRET_ENTRIES) throw new Error("secret payload exceeds cap");
    seenKeys.add(entry.key);
    let plaintext = "";
    try {
      plaintext = await decryptSecret(ticket.smk, entry as EncryptedSecretEntry);
      const decodedBytes = Buffer.byteLength(plaintext, "utf8");
      if (decodedBytes > MAX_SECRET_BYTES || plaintextBytes > MAX_SECRET_BYTES - decodedBytes) {
        throw new Error("decrypted secret payload exceeds cap");
      }
      plaintextBytes += decodedBytes;
      if (signal.aborted) throw signal.reason ?? new Error("import cancelled");
      const encrypted = await encryptImportedSecret(plaintext);
      if (signal.aborted) throw signal.reason ?? new Error("import cancelled");
      prepared.push({ key: entry.key, encrypted_value: encrypted.encrypted, iv: encrypted.iv, tag: encrypted.tag });
    } finally {
      plaintext = "";
    }
  }
  if (seenKeys.size !== expectedKeys.size) {
    throw new Error("encrypted secret rows do not match the exact secret index");
  }
  return prepared;
}
type VectorRebuildSource = "chat_chunks" | "databank_chunks" | "memory_vectors" | "world_book_vectors";
interface VectorRebuildProgress {
  cursor: string | null;
  pending: boolean;
  queued: number;
  queueCursor?: string | null;
  queuePending?: boolean;
}
type VectorRebuildProgressMap = Record<VectorRebuildSource, VectorRebuildProgress>;

interface VectorProjectionIntent {
  imported: number;
  skipped: number;
  sourceRows: number;
  sourceIdentities: Record<string, string>;
  vectorIdentities: Record<string, string>;
  rebuildRequired: boolean;
  projectionPending: boolean;
  rebuildProgress?: VectorRebuildProgressMap;
  queued?: number;
  recoveryError?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImportTableSummary(value: unknown): value is ImportTableSummary {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.imported)
    && Number.isSafeInteger(value.skipped)
    && Number(value.imported) >= 0
    && Number(value.skipped) >= 0;
}

function isVectorProjectionIntent(value: unknown): value is VectorProjectionIntent {
  if (!isRecord(value) || !isImportTableSummary(value)) return false;
  if (
    !Number.isSafeInteger(value.sourceRows)
    || Number(value.sourceRows) < 0
    || !isRecord(value.sourceIdentities)
    || !isRecord(value.vectorIdentities)
    || typeof value.rebuildRequired !== "boolean"
    || typeof value.projectionPending !== "boolean"
  ) return false;
  for (const identities of [value.sourceIdentities, value.vectorIdentities]) {
    for (const digest of Object.values(identities)) {
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return false;
    }
  }
  if (value.rebuildProgress !== undefined) {
    if (!isRecord(value.rebuildProgress)) return false;
    const allowedSources = new Set<VectorRebuildSource>([
      "chat_chunks",
      "databank_chunks",
      "memory_vectors",
      "world_book_vectors",
    ]);
    const entries = Object.entries(value.rebuildProgress);
    if (entries.some(([key]) => !allowedSources.has(key as VectorRebuildSource))) return false;
    for (const [key, raw] of entries) {
      if (!isRecord(raw)) return false;
      if (
        (raw.cursor !== null && typeof raw.cursor !== "string")
        || typeof raw.pending !== "boolean"
        || !Number.isSafeInteger(raw.queued)
        || Number(raw.queued) < 0
        || (raw.queueCursor !== undefined && raw.queueCursor !== null && typeof raw.queueCursor !== "string")
        || (raw.queuePending !== undefined && typeof raw.queuePending !== "boolean")
      ) return false;
      if (Buffer.byteLength(key, "utf8") > MAX_VECTOR_PROJECTION_KEY_BYTES) return false;
    }
  }
  if (value.queued !== undefined && (!Number.isSafeInteger(value.queued) || Number(value.queued) < 0)) return false;
  if (value.recoveryError !== undefined && typeof value.recoveryError !== "string") return false;
  return true;
}

function parseImportSummary(raw: string): ImportSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("stored import summary is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("stored import summary is malformed");
  const allowedKeys: Record<string, true> = { tables: true, files: true, secrets: true, vectors: true };
  if (Object.keys(parsed).some((key) => allowedKeys[key] !== true)) {
    throw new Error("stored import summary has unknown fields");
  }

  const rawTables = parsed.tables;
  if (!isRecord(rawTables)) throw new Error("stored import summary has no tables");
  const tables: Record<string, ImportTableSummary> = {};
  for (const [key, value] of Object.entries(rawTables)) {
    if (key === "vectors" || !isImportTableSummary(value)) {
      throw new Error(`stored import summary has malformed table: ${key}`);
    }
    tables[key] = value;
  }

  const rawFiles = parsed.files;
  if (!isRecord(rawFiles)) throw new Error("stored import summary has no files");
  const files: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawFiles)) {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_ENTRIES) {
      throw new Error(`stored import summary has malformed file count: ${key}`);
    }
    files[key] = Number(value);
  }

  if (!isImportTableSummary(parsed.secrets)) {
    throw new Error("stored import summary has malformed secrets");
  }
  const vectors = parsed.vectors;
  if (vectors !== undefined && !isVectorProjectionIntent(vectors)) {
    throw new Error("stored import summary has malformed vectors");
  }
  return {
    tables,
    files,
    secrets: parsed.secrets,
    ...(vectors !== undefined ? { vectors } : {}),
  } as unknown as ImportSummary;
}
/**
 * Convert the durable receipt envelope into the public status shape. The
 * receipt's `tables`/`files` wrapper is an internal persistence format and
 * must never leak through status, websocket, or idempotent replay APIs.
 */
function publicImportSummaries(receipt: ImportReceiptSummary): {
  summary: ImportProgressSummary;
  fileSummary: Record<string, number>;
} {
  const summary = {
    ...receipt.tables,
    ...(receipt.vectors ? { vectors: receipt.vectors } : {}),
  } as ImportProgressSummary;
  return {
    summary,
    fileSummary: { ...receipt.files },
  };
}

const VECTOR_REBUILD_SOURCE_TABLES = new Set([
  "chats",
  "messages",
  "databank_documents",
  "memory_consolidations",
  "world_book_entries",
]);

async function buildVectorProjectionIntent(
  stage: StagedArchive,
  signal?: AbortSignal,
  deadlineAt?: number,
  heartbeat?: FileHashHeartbeat,
): Promise<VectorProjectionIntent | null> {
  const sourceIdentities: Record<string, string> = {};
  let sourceRows = 0;
  for (const spec of ARCHIVE_CANONICAL_TABLES) {
    checkImportBudget(signal, deadlineAt);
    const count = stage.rowCounts[spec.table] || 0;
    if ((!spec.lancedb && !VECTOR_REBUILD_SOURCE_TABLES.has(spec.table)) || count === 0) continue;
    if (count > MAX_ROWS_PER_TABLE || sourceRows > MAX_STAGED_ROWS - count) {
      throw new Error(`vector source row count exceeds cap: ${spec.table}`);
    }
    const digest = createHash("sha256");
    for (const row of stage.db.query(`SELECT * FROM ${ident(spec.table)}`).iterate() as Iterable<Record<string, unknown>>) {
      checkImportBudget(signal, deadlineAt);
      digest.update(sortedJson(row));
      digest.update("\n");
    }
    sourceIdentities[spec.table] = digest.digest("hex");
    sourceRows += count;
  }
  const vectorIdentities: Record<string, string> = {};
  for (const entry of stage.vectorEntries) {
    checkImportBudget(signal, deadlineAt);
    vectorIdentities[entry.table] = await sha256File(entry.stagingPath, signal, deadlineAt, heartbeat);
  }
  if (sourceRows === 0 && Object.keys(vectorIdentities).length === 0) return null;
  const sourceCount = (table: string): number => stage.rowCounts[table] || 0;
  const rebuildProgress: VectorRebuildProgressMap = {
    chat_chunks: {
      cursor: null,
      pending: sourceCount("chats") > 0 || sourceCount("messages") > 0,
      queued: 0,
      queueCursor: null,
      queuePending: sourceCount("chats") > 0 || sourceCount("messages") > 0,
    },
    databank_chunks: { cursor: null, pending: sourceCount("databank_documents") > 0, queued: 0 },
    memory_vectors: { cursor: null, pending: sourceCount("memory_consolidations") > 0, queued: 0 },
    world_book_vectors: { cursor: null, pending: sourceCount("world_book_entries") > 0, queued: 0 },
  };
  return {
    imported: 0,
    skipped: stage.vectorEntries.length,
    sourceRows,
    sourceIdentities,
    vectorIdentities,
    rebuildRequired: true,
    projectionPending: Object.values(rebuildProgress).some((state) => state.pending || state.queuePending === true),
    rebuildProgress,
  };
}







function persistVectorSummary(
  job: ImportJob,
  vectors: VectorProjectionIntent,
): void {
  const progressSummary = requireImportProgressSummary(job.summary);
  progressSummary.vectors = vectors;
  const tables: Record<string, ImportTableSummary> = {};
  for (const [key, value] of Object.entries(progressSummary)) {
    if (key === "vectors") continue;
    if (!isImportTableSummary(value)) throw new Error(`import summary has malformed table: ${key}`);
    tables[key] = value;
  }
  const encoded = sortedJson({
    tables,
    files: job.fileSummary,
    secrets: { imported: job.secretsRestored || 0, skipped: 0 },
    vectors,
  });
  const db = getDb();
  db.transaction(() => {
    db.query("UPDATE user_data_import_receipts SET summary_json = ? WHERE job_id = ?").run(encoded, job.jobId);
    db.query("UPDATE user_data_imports SET summary_json = ?, projection_pending = ?, updated_at = ? WHERE job_id = ? AND state = 'committed'")
      .run(encoded, vectors.projectionPending ? 1 : 0, nowSeconds(), job.jobId);
  })();
}
function strictVectorIdentityRevision(manifest: ArchiveManifest, intent: VectorProjectionIntent): string | null {
  if (manifest.vectorStatus !== "included" || manifest.entries === undefined) return null;
  if (!manifest.embeddingIdentity || typeof manifest.embeddingIdentity !== "object") return null;
  const revision = manifest.embeddingIdentity.revision;
  if (typeof revision !== "string" || !/^[0-9a-f]{64}$/u.test(revision)) return null;
  const config = manifest.embeddingConfig;
  const baseRevision = createHash("sha256")
    .update(JSON.stringify({
      provider: config.provider,
      model: config.model,
      dimension: config.dimension,
    }))
    .digest("hex");
  if (
    typeof manifest.vectorSourceDigest !== "string"
    || !Number.isSafeInteger(manifest.vectorProjectionEpoch)
    || Number(manifest.vectorProjectionEpoch) < 0
  ) return null;
  const digest = createHash("sha256").update(baseRevision);
  digest.update(`\u0000source\u0000${manifest.vectorSourceDigest}\u0000${manifest.vectorProjectionEpoch}`);
  for (const table of Object.keys(intent.vectorIdentities).sort()) {
    digest.update(`\u0000${table}\u0000${intent.vectorIdentities[table]}\u0000${manifest.counts[table] ?? 0}`);
  }
  return digest.digest("hex") === revision ? revision : null;
}

async function currentVectorIdentityMatches(
  job: ImportJob,
  manifest: ArchiveManifest,
  intent: VectorProjectionIntent,
  sourceDigest: string,
): Promise<boolean> {
  if (strictVectorIdentityRevision(manifest, intent) === null) return false;
  if (
    manifest.vectorSourceDigest !== sourceDigest
    || !Number.isSafeInteger(manifest.vectorProjectionEpoch)
    || Number(manifest.vectorProjectionEpoch) < 0
  ) return false;
  try {
    const current = await embeddingsService.getEmbeddingConfig(job.userId);
    const config = manifest.embeddingConfig;
    const currentDimension = Number.isSafeInteger(current.dimensions) ? Number(current.dimensions) : null;
    return current.provider === config.provider
      && current.model === config.model
      && currentDimension === config.dimension;
  } catch {
    return false;
  }
}

async function restoreIncludedVectorRows(
  job: ImportJob,
  stage: StagedArchive,
  manifest: ArchiveManifest,
  intent: VectorProjectionIntent,
  sourceDigest: string,
): Promise<number | null> {
  if (!(await currentVectorIdentityMatches(job, manifest, intent, sourceDigest))) return null;
  const sourceOwnerRow = stage.db.query("SELECT value FROM __import_meta WHERE key = 'source_owner'").get() as { value?: unknown } | null;
  const sourceOwner = typeof sourceOwnerRow?.value === "string" && sourceOwnerRow.value.length > 0
    ? sourceOwnerRow.value
    : null;
  if (!sourceOwner) return null;
  const expectedDimension = validateVectorArchiveIdentity(manifest, true);
  const seenIds = new Set<string>();
  let imported = 0;
  let totalRows = 0;
  let decodedBytes = 0;
  for (const entry of stage.vectorEntries) {
    const collection: CollectionName = entry.table === "embeddings_world_books"
      ? "embeddings_world_books"
      : entry.table === "embeddings"
        ? "embeddings"
        : (() => { throw new Error(`vector table is not importable: ${entry.table}`); })();
    let entryRows = 0;
    const rows: VectorRow[] = [];
    let bytes = 0;
    const flush = async (): Promise<void> => {
      if (rows.length === 0) return;
      await embeddingsService.restoreArchivedVectorRows(job.userId, collection, rows.splice(0, rows.length));
      bytes = 0;
    };
    for await (const raw of readNdjsonEntries(entry.stagingPath, job.abort.signal, validationDeadlineForJob(job), job)) {
      if (entryRows >= MAX_ROWS_PER_TABLE || totalRows >= MAX_STAGED_ROWS) {
        throw new Error(`vector row count exceeds cap: ${entry.table}`);
      }
      checkImportBudget(job.abort.signal, validationDeadlineForJob(job));
      const validated = validateVectorArchiveRowShape(raw, {
        userId: job.userId,
        sourceOwner,
        expectedDimension,
      }, seenIds);
      assertVectorCanonicalSource(
        stage.db,
        String(raw.source_type),
        String(raw.source_id),
        String(raw.owner_id),
        sourceOwner,
      );
      if (decodedBytes > MAX_VECTOR_DECODED_BYTES - validated.decodedBytes) {
        throw new Error("vector decoded bytes exceed cap");
      }
      decodedBytes += validated.decodedBytes;
      rows.push({
        id: rowId(job.userId, String(raw.source_type), String(raw.source_id), Number(raw.chunk_index)),
        user_id: job.userId,
        source_type: String(raw.source_type),
        source_id: String(raw.source_id),
        owner_id: String(raw.owner_id),
        chunk_index: Number(raw.chunk_index),
        content: String(raw.content),
        vector: raw.vector as number[],
        metadata_json: String(raw.metadata_json),
        updated_at: Number(raw.updated_at),
      });
      const rowBytes = checkedValidationBytes(raw);
      bytes += rowBytes;
      entryRows++;
      totalRows++;
      imported++;

      if (bytes >= MAX_VECTOR_BATCH_BYTES) await flush();
    }
    await flush();
    const expectedRows = manifest.counts[entry.table];
    if (!Number.isSafeInteger(expectedRows) || expectedRows !== entryRows) {
      throw new Error(`vector manifest count mismatch: ${entry.table}`);
    }
  }
  return imported;
}
async function computeVectorSourceDigest(
  stage: StagedArchive,
  signal?: AbortSignal,
  deadlineAt?: number,
  heartbeat?: FileHashHeartbeat,
): Promise<string> {
  const digest = createHash("sha256");
  const specs = ARCHIVE_CANONICAL_TABLES
    .filter((spec) => spec.lancedb || VECTOR_REBUILD_SOURCE_TABLES.has(spec.table))
    .slice()
    .sort((left, right) => left.table.localeCompare(right.table));
  for (const spec of specs) {
    checkImportBudget(signal, deadlineAt);
    if ((stage.rowCounts[spec.table] || 0) === 0) continue;
    digest.update(`${spec.table}\n`);
    for (const row of stage.db.query(`SELECT * FROM ${ident(spec.table)}`).iterate() as Iterable<Record<string, unknown>>) {
      checkImportBudget(signal, deadlineAt);
      heartbeat?.();
      const normalized = { ...row };
      if (Object.hasOwn(normalized, "user_id")) normalized.user_id = "<archive-owner>";
      digest.update(sortedJson(normalized));
      digest.update("\n");
    }
  }
  return digest.digest("hex");
}

async function projectDerivedVectorsAfterReceipt(job: ImportJob, stage: StagedArchive): Promise<void> {
  const vectorDeadlineAt = Date.now() + IMPORT_FILE_OPERATION_DEADLINE_MS;
  const intent = await buildVectorProjectionIntent(
    stage,
    job.abort.signal,
    vectorDeadlineAt,
    () => {
      renewImportLease(job);
      assertCurrentFence(job);
    },
  );
  if (!intent) return;
  const manifest = job.manifest;
  const sourceDigest = manifest?.vectorStatus === "included"
    ? await computeVectorSourceDigest(
      stage,
      job.abort.signal,
      vectorDeadlineAt,
      () => {
        renewImportLease(job);
        assertCurrentFence(job);
      },
    )
    : null;
  let restored: number | null = null;
  let restoreError = false;
  if (manifest && sourceDigest !== null) {
    try {
      restored = await restoreIncludedVectorRows(job, stage, manifest, intent, sourceDigest);
    } catch {
      restoreError = true;
    }
  }
  const expectedRows = manifest
    ? stage.vectorEntries.reduce((sum, entry) => sum + (manifest.counts[entry.table] ?? 0), 0)
    : 0;
  if (restored !== null && restored === expectedRows) {
    const completeProgress: VectorRebuildProgressMap = Object.fromEntries(
      Object.entries(intent.rebuildProgress ?? {}).map(([key, progress]) => [
        key,
        { ...progress, pending: false, queuePending: false, queued: 0 },
      ]),
    ) as VectorRebuildProgressMap;
    persistVectorSummary(job, {
      ...intent,
      imported: restored,
      skipped: 0,
      rebuildRequired: false,
      projectionPending: false,
      rebuildProgress: completeProgress,
      queued: 0,
      recoveryError: undefined,
    });
    return;
  }
  const scheduled = scheduleDerivedVectorProjectionSyncDetailed(job.userId, intent.rebuildProgress);
  persistVectorSummary(job, {
    ...intent,
    imported: 0,
    skipped: stage.vectorEntries.length,
    rebuildRequired: true,
    projectionPending: !scheduled.complete || scheduled.memoryUnavailable,
    rebuildProgress: scheduled.progress,
    queued: scheduled.queued,
    recoveryError: scheduled.memoryUnavailable
      ? "memory vector projection unavailable"
      : restoreError
        ? "archived vector projection failed; canonical rebuild required"
        : "archived vector identity unavailable; canonical rebuild required",
  });
}

const MAX_RECEIPT_SUMMARY_BYTES = 1 * 1024 * 1024;
const MAX_PROJECTION_IDENTITY_TABLES = 32;
const PROJECTION_DIGEST = /^[0-9a-f]{64}$/;

function parseReceiptSummaryForProjection(raw: string): Record<string, unknown> | null {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_RECEIPT_SUMMARY_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const summary = parsed as Record<string, unknown>;
  let normalizedSummary = summary;
  const rawTables = summary.tables;
  const nestedVectors = rawTables && typeof rawTables === "object" && !Array.isArray(rawTables)
    ? (rawTables as Record<string, unknown>).vectors
    : undefined;
  const vectors = summary.vectors ?? nestedVectors;
  if (vectors === undefined) return summary;
  if (!vectors || typeof vectors !== "object" || Array.isArray(vectors)) return null;
  const vectorRecord = vectors as Record<string, unknown>;
  if (nestedVectors !== undefined && summary.vectors === undefined) {
    const tables = { ...(rawTables as Record<string, unknown>) };
    delete tables.vectors;
    normalizedSummary = { ...summary, tables, vectors };
  }
  if (vectorRecord.projectionPending !== true) return normalizedSummary;
  const allowedKeys = new Set([
    "imported",
    "skipped",
    "sourceRows",
    "sourceIdentities",
    "vectorIdentities",
    "rebuildRequired",
    "projectionPending",
    "rebuildProgress",
    "queued",
    "recoveryError",
  ]);
  if (Object.keys(vectorRecord).some((key) => !allowedKeys.has(key))) return null;
  if (
    vectorRecord.imported !== 0
    || typeof vectorRecord.skipped !== "number"
    || !Number.isSafeInteger(vectorRecord.skipped)
    || vectorRecord.skipped < 0
    || vectorRecord.skipped > MAX_ENTRIES
    || typeof vectorRecord.sourceRows !== "number"
    || !Number.isSafeInteger(vectorRecord.sourceRows)
    || vectorRecord.sourceRows < 0
    || vectorRecord.sourceRows > MAX_STAGED_ROWS
    || vectorRecord.rebuildRequired !== true
  ) return null;
  for (const key of ["sourceIdentities", "vectorIdentities"] as const) {
    const identities = vectorRecord[key];
    if (!identities || typeof identities !== "object" || Array.isArray(identities)) return null;
    const entries = Object.entries(identities as Record<string, unknown>);
    if (entries.length > MAX_PROJECTION_IDENTITY_TABLES) return null;
    const validRebuildSource = new Set(["chats", "messages", "databank_documents", "memory_consolidations"]);
    for (const [table, digest] of entries) {
      const validSourceTable = ARCHIVE_CANONICAL_TABLES.some((spec) => spec.table === table && !!spec.lancedb)
        || validRebuildSource.has(table);
      const validVectorTable = getArchiveVectorTables().includes(table);
      if ((key === "sourceIdentities" ? !validSourceTable : !validVectorTable)) return null;
      if (typeof digest !== "string" || !PROJECTION_DIGEST.test(digest)) return null;
    }
  }
  const rawProgress = vectorRecord.rebuildProgress;
  if (rawProgress !== undefined) {
    if (!rawProgress || typeof rawProgress !== "object" || Array.isArray(rawProgress)) return null;
    const allowedSources = new Set(["chat_chunks", "databank_chunks", "memory_vectors", "world_book_vectors"]);
    const progressEntries = Object.entries(rawProgress as Record<string, unknown>);
    if (progressEntries.length > allowedSources.size) return null;
    for (const [source, rawState] of progressEntries) {
      if (!allowedSources.has(source) || !rawState || typeof rawState !== "object" || Array.isArray(rawState)) return null;
      const state = rawState as Record<string, unknown>;
      if (
        (state.cursor !== null && typeof state.cursor !== "string")
        || typeof state.pending !== "boolean"
        || typeof state.queued !== "number"
        || !Number.isSafeInteger(state.queued)
        || state.queued < 0
        || (state.queueCursor !== undefined && state.queueCursor !== null && typeof state.queueCursor !== "string")
        || (state.queuePending !== undefined && typeof state.queuePending !== "boolean")
      ) return null;
    }
  }
  if (
    vectorRecord.queued !== undefined
    && (
      typeof vectorRecord.queued !== "number"
      || !Number.isSafeInteger(vectorRecord.queued)
      || vectorRecord.queued < 0
      || vectorRecord.queued > MAX_STAGED_ROWS
    )
  ) return null;
  if (
    vectorRecord.recoveryError !== undefined
    && (
      typeof vectorRecord.recoveryError !== "string"
      || vectorRecord.recoveryError.length > 1_024
    )
  ) return null;
  return normalizedSummary;
}

const VECTOR_REBUILD_PAGE_SIZE = 500;
const VECTOR_REBUILD_SOURCES: readonly VectorRebuildSource[] = [
  "chat_chunks",
  "databank_chunks",
  "memory_vectors",
  "world_book_vectors",
];

function emptyVectorRebuildProgress(): VectorRebuildProgressMap {
  return {
    chat_chunks: { cursor: null, pending: true, queued: 0, queueCursor: null, queuePending: true },
    databank_chunks: { cursor: null, pending: true, queued: 0 },
    memory_vectors: { cursor: null, pending: true, queued: 0 },
    world_book_vectors: { cursor: null, pending: true, queued: 0 },
  };
}

function copyVectorRebuildProgress(value: unknown): VectorRebuildProgressMap {
  const fallback = emptyVectorRebuildProgress();
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const input = value as Record<string, unknown>;
  for (const source of VECTOR_REBUILD_SOURCES) {
    const raw = input[source];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const state = raw as Record<string, unknown>;
    fallback[source] = {
      cursor: typeof state.cursor === "string" ? state.cursor : null,
      pending: state.pending === true,
      queued: Number.isSafeInteger(state.queued) && Number(state.queued) >= 0 ? Number(state.queued) : 0,
      ...(state.queueCursor === null || typeof state.queueCursor === "string" ? { queueCursor: state.queueCursor as string | null } : {}),
      ...(typeof state.queuePending === "boolean" ? { queuePending: state.queuePending } : {}),
    };
  }
  return fallback;
}

function databankDocumentSourceExists(userId: string, filePath: string): boolean {
  if (filePath.length === 0) return false;
  try {
    // Mirrors parseDocument()'s databank upload-directory resolution.
    return existsSync(join(env.dataDir, "databank", userId, filePath));
  } catch {
    return false;
  }
}

function markDatabankDocumentRebuildBlocked(db: Database, documentId: string, userId: string): void {
  try {
    db.query(
      `UPDATE databank_documents
          SET status = 'error', error_message = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`,
    ).run("source file missing; vector rebuild required", nowSeconds(), documentId, userId);
  } catch {
    // Paging must continue; the receipt stays rebuild-required and the next
    // reconciliation re-attempts this document.
  }
}

interface VectorProjectionSchedule {
  queued: number;
  progress: VectorRebuildProgressMap;
  complete: boolean;
  memoryUnavailable: boolean;
}

function scheduleDerivedVectorProjectionSyncDetailed(
  userId: string,
  priorProgress?: unknown,
): VectorProjectionSchedule {
  const generation = getDbGeneration();
  const db = getDb();
  const progress = copyVectorRebuildProgress(priorProgress);
  let queued = 0;
  let memoryUnavailable = false;

  const page = <T extends { id: string }>(
    state: VectorRebuildProgress,
    query: string,
    args: SQLQueryBindings[],
    onRow: (row: T) => void,
  ): T[] => {
    const rows = db.query(query).all(...args, VECTOR_REBUILD_PAGE_SIZE) as T[];
    if (rows.length === 0) {
      state.pending = false;
      return rows;
    }
    for (const row of rows) onRow(row);
    state.cursor = rows[rows.length - 1]!.id;
    state.pending = rows.length >= VECTOR_REBUILD_PAGE_SIZE;
    return rows;
  };
  const pageQuery = (base: string, cursor: string | null): { sql: string; args: SQLQueryBindings[] } => cursor
    ? { sql: `${base} AND id > ? ORDER BY id ASC LIMIT ?`, args: [userId, cursor] }
    : { sql: `${base} ORDER BY id ASC LIMIT ?`, args: [userId] };

  const chatState = progress.chat_chunks;
  const chatBase = `SELECT c.id
      FROM chats c
     WHERE c.user_id = ?`;
  const chatPage = pageQuery(chatBase, chatState.cursor);
  const chats = chatState.pending
    ? page<{ id: string }>(chatState, chatPage.sql.replaceAll("id > ?", "c.id > ?"), chatPage.args, (chat) => {
      const exists = db.query("SELECT 1 FROM chat_chunks WHERE chat_id = ? LIMIT 1").get(chat.id);
      if (!exists) {
        const admission = runWithDbGeneration(generation, async () => {
          const { rebuildChatChunks } = await import("../chats.service");
          await rebuildChatChunks(userId, chat.id);
        });
        void trackChatChunkMaintenance(chat.id, admission, generation);
        void admission.catch((err) => {
          if (!isDatabaseGenerationCancellation(err)) {
            console.error(`[user-data-import] Chat chunk rebuild failed for ${chat.id}:`, err);
          }
        });
        queued++;
        chatState.queued++;
      }
    })
    : [];

  const queueCursor = chatState.queueCursor ?? null;
  const pendingChatQuery = chatState.queuePending === false
    ? []
    : queueCursor
      ? db.query(
        `SELECT cc.id, cc.chat_id
           FROM chat_chunks cc
           JOIN chats c ON c.id = cc.chat_id
          WHERE c.user_id = ? AND cc.vectorized_at IS NULL AND cc.id > ?
          ORDER BY cc.id ASC LIMIT ?`,
      ).all(userId, queueCursor, VECTOR_REBUILD_PAGE_SIZE) as Array<{ id: string; chat_id: string }>
      : db.query(
        `SELECT cc.id, cc.chat_id
           FROM chat_chunks cc
           JOIN chats c ON c.id = cc.chat_id
          WHERE c.user_id = ? AND cc.vectorized_at IS NULL
          ORDER BY cc.id ASC LIMIT ?`,
      ).all(userId, VECTOR_REBUILD_PAGE_SIZE) as Array<{ id: string; chat_id: string }>;
  if (pendingChatQuery.length > 0) {
    for (const row of pendingChatQuery) {
      queueChunkVectorization(userId, row.chat_id, row.id, 2);
      queued++;
      chatState.queued++;
    }
    chatState.queueCursor = pendingChatQuery[pendingChatQuery.length - 1]!.id;
    // A short page means every currently unvectorized chunk has been queued;
    // only a full page can hide further rows, so the queue scan ends here and
    // the durable projection leaves its pending state.
    chatState.queuePending = pendingChatQuery.length >= VECTOR_REBUILD_PAGE_SIZE;
  } else {
    const remaining = db.query(
      `SELECT 1
         FROM chat_chunks cc
         JOIN chats c ON c.id = cc.chat_id
        WHERE c.user_id = ? AND cc.vectorized_at IS NULL
        LIMIT 1`,
    ).get(userId);
    if (remaining) {
      chatState.queueCursor = null;
      chatState.queuePending = true;
    } else {
      chatState.queuePending = false;
    }
  }
  if (chats.length === 0 && !chatState.queuePending) chatState.pending = false;

  const databankState = progress.databank_chunks;
  const documentsQuery = pageQuery(
    `SELECT id, file_path FROM databank_documents WHERE user_id = ?`,
    databankState.cursor,
  );
  if (databankState.pending) {
    page<{ id: string; file_path: unknown }>(
      databankState,
      documentsQuery.sql,
      documentsQuery.args,
      (document) => {
        const filePath = typeof document.file_path === "string" ? document.file_path : "";
        if (!databankDocumentSourceExists(userId, filePath)) {
          markDatabankDocumentRebuildBlocked(db, document.id, userId);
          return;
        }
        void runWithDbGeneration(generation, async () => {
          const { processDocument } = await import("../databank/vectorization.service");
          await processDocument(userId, document.id);
        }).catch(() => {});
        queued++;
        databankState.queued++;
      },
    );
  }

  const memoryState = progress.memory_vectors;
  const memoryQuery = pageQuery(
    `SELECT mc.id
       FROM memory_consolidations mc
       JOIN chats c ON c.id = mc.chat_id
      WHERE c.user_id = ?`,
    memoryState.cursor,
  );
  const memoryRows = memoryState.pending
    ? page<{ id: string }>(
      memoryState,
      memoryQuery.sql.replaceAll("id > ?", "mc.id > ?").replace("ORDER BY id", "ORDER BY mc.id"),
      memoryQuery.args,
      () => {},
    )
    : [];
  if (memoryRows.length > 0 || memoryState.cursor !== null) {
    // No live memory-vector writer exists. Keep this source pending after
    // every bounded page so restart reconciliation never claims completion.
    memoryUnavailable = true;
    memoryState.pending = true;
  }
  if (memoryRows.length > 0) {
    db.query(
      `UPDATE memory_consolidations
          SET vectorized_at = NULL, vector_model = NULL
        WHERE id IN (${memoryRows.map(() => "?").join(",")})`,
    ).run(...memoryRows.map((row) => row.id));
  }
  const worldState = progress.world_book_vectors;
  const worldQuery = pageQuery(
    `SELECT wbe.id
       FROM world_book_entries wbe
       JOIN world_books wb ON wb.id = wbe.world_book_id
      WHERE wb.user_id = ? AND wbe.vectorized = 1
        AND wbe.disabled = 0 AND length(trim(wbe.content)) > 0`,
    worldState.cursor,
  );
  if (worldState.pending) {
    page<{ id: string }>(
      worldState,
      worldQuery.sql.replaceAll("id > ?", "wbe.id > ?").replace("ORDER BY id", "ORDER BY wbe.id"),
      worldQuery.args,
      (row) => {
        db.query(
          "UPDATE world_book_entries SET vector_index_status = 'pending', vector_indexed_at = NULL, vector_index_error = NULL WHERE id = ?",
        ).run(row.id);
        queueWorldBookEntryVectorization(userId, row.id, 2, true);
        queued++;
        worldState.queued++;
      },
    );
  }
  const complete = VECTOR_REBUILD_SOURCES.every((source) => {
    const state = progress[source];
    return !state.pending && state.queuePending !== true;
  });
  return { queued, progress, complete, memoryUnavailable };
}

function reconcileDerivedVectorProjection(jobId: string, userId: string, receiptSummary: string): void {
  const summary = parseReceiptSummaryForProjection(receiptSummary);
  if (!summary) return;
  const vectors = summary.vectors;
  if (!vectors || typeof vectors !== "object" || (vectors as Record<string, unknown>).projectionPending !== true) return;
  const db = getDb();
  try {
    const vectorRecord = vectors as Record<string, unknown>;
    const scheduled = scheduleDerivedVectorProjectionSyncDetailed(userId, vectorRecord.rebuildProgress);
    const projectionPending = !scheduled.complete || scheduled.memoryUnavailable;
    const recoveryError = scheduled.memoryUnavailable
      ? "memory vector projection unavailable"
      : projectionPending
        ? "derived vector rebuild remains pending"
        : undefined;
    const next = {
      ...summary,
      vectors: {
        ...vectorRecord,
        queued: scheduled.queued,

        rebuildProgress: scheduled.progress,
        projectionPending,
        ...(recoveryError ? { recoveryError } : {}),
      },
    };
    const encoded = sortedJson(next);
    db.transaction(() => {
      db.query("UPDATE user_data_import_receipts SET summary_json = ? WHERE job_id = ?").run(encoded, jobId);
      db.query("UPDATE user_data_imports SET summary_json = ?, projection_pending = ?, updated_at = ? WHERE job_id = ? AND state = 'committed'")
        .run(encoded, projectionPending ? 1 : 0, nowSeconds(), jobId);
    })();
  } catch (error) {
    const next = {
      ...summary,
      vectors: {
        ...(vectors as Record<string, unknown>),
        projectionPending: true,
        recoveryError: String((error as Error)?.message || error).slice(0, 1024),
      },
    };
    try {
      const encoded = sortedJson(next);
      db.query("UPDATE user_data_import_receipts SET summary_json = ? WHERE job_id = ?").run(encoded, jobId);
      db.query("UPDATE user_data_imports SET summary_json = ?, projection_pending = 1, updated_at = ? WHERE job_id = ? AND state = 'committed'")
        .run(encoded, nowSeconds(), jobId);
    } catch {}
  }
}

function scheduleDerivedVectorProjectionSync(userId: string): number {
  return scheduleDerivedVectorProjectionSyncDetailed(userId).queued;
}

function sqliteValueEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
    return true;
  }
  if (typeof left === "object" && typeof right === "object") {
    try { return sortedJson(left) === sortedJson(right); } catch { return false; }
  }
  return false;
}

function canonicalRowsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  columns: readonly string[],
): boolean {
  return columns.every((column) => sqliteValueEqual(left[column], right[column]));
}

function findExistingCanonicalRow(
  db: Database,
  table: string,
  spec: unknown,
  row: Record<string, unknown>,
  columns: readonly string[],
): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  const primaryKey = (registryKeys(spec)[0] ?? []).filter((column) => columns.includes(column));
  for (const key of registryKeys(spec)) {
    if (key.length === 0 || key.some((column) => !columns.includes(column) || row[column] === undefined || row[column] === null)) continue;
    const where = key.map((column) => `${ident(column)} = ?`).join(" AND ");
    const candidate = db.query(`SELECT * FROM ${ident(table)} WHERE ${where} LIMIT 1`).get(...key.map((column) => sqlBinding(row[column]))) as Record<string, unknown> | null;
    if (!candidate) continue;
    if (
      found
      && primaryKey.length > 0
      && primaryKey.some((column) => !sqliteValueEqual(found?.[column], candidate[column]))
    ) {
      throw new Error(`canonical unique-key conflict in ${table}`);
    }
    found = candidate;
  }
  return found;
}

interface CanonicalInsertStatement {
  run(...bindings: SQLQueryBindings[]): unknown;
}

function mergeCanonicalImportRow(
  db: Database,
  table: string,
  spec: unknown,
  row: Record<string, unknown>,
  columns: readonly string[],
  insert: CanonicalInsertStatement,
): "imported" | "skipped" {
  const mergePolicy = registryMergePolicy(spec);
  if (mergePolicy === "discard") return "skipped";
  const existing = findExistingCanonicalRow(db, table, spec, row, columns);
  if (!existing) {
    insert.run(...columns.map((column) => sqlBinding(row[column])));
    return "imported";
  }
  const keys = registryKeys(spec);
  const primaryKey = keys[0] ?? [];
  if (
    primaryKey.length === 0
    || primaryKey.some((column) => !sqliteValueEqual(existing[column], row[column]))
  ) {
    throw new Error(`canonical unique-key conflict in ${table}`);
  }
  const equal = canonicalRowsEqual(existing, row, columns);
  if (mergePolicy === "insert_only") {
    if (!equal) throw new Error(`insert-only canonical row conflicts with existing ${table} key`);
    return "skipped";
  }
  if (mergePolicy === "rebuild") {
    throw new Error(`rebuild merge policy is not valid for canonical table ${table}`);
  }
  if (equal) return "skipped";
  const keyColumns = new Set(keys.flat());
  const mutableColumns = columns.filter((column) => !keyColumns.has(column));
  if (mutableColumns.length === 0) {
    throw new Error(`upsert canonical row has no mutable columns: ${table}`);
  }
  const where = primaryKey.map((column) => `${ident(column)} = ?`).join(" AND ");
  db.query(
    `UPDATE ${ident(table)}
        SET ${mutableColumns.map((column) => `${ident(column)} = ?`).join(", ")}
      WHERE ${where}`,
  ).run(
    ...mutableColumns.map((column) => sqlBinding(row[column])),
    ...primaryKey.map((column) => sqlBinding(existing[column])),
  );
  const after = db.query(`SELECT * FROM ${ident(table)} WHERE ${where} LIMIT 1`)
    .get(...primaryKey.map((column) => sqlBinding(existing[column]))) as Record<string, unknown> | null;
  if (!after || !canonicalRowsEqual(after, row, columns)) {
    throw new Error(`upsert canonical row was not updated: ${table}`);
  }
  return "imported";
}

function ticketBindingHashSync(archiveId: string, secretKeys: readonly string[]): string {
  return createHash("sha256")
    .update(`${archiveId}|${TICKET_ALGORITHM}|${[...secretKeys].sort().join("\n")}`)
    .digest("hex");
}

function assertTicketUsableBeforeSecretPreparation(
  job: ImportJob,
  stage: StagedArchive,
  ticketResult: TicketGateValue | null,
): void {
  if (!ticketResult) return;
  const ticket = ticketResult.ticket;
  if (job.ticketSubmittedBy !== job.userId) {
    throw new TicketError("binding_mismatch", "ticket submitter does not own this import");
  }
  if (
    ticket.kind !== TICKET_KIND
    || ticket.version !== TICKET_VERSION
    || ticket.issuer !== "lumiverse"
    || typeof ticket.issuerInstance !== "string"
    || ticket.issuerInstance.trim().length === 0
    || ticket.issuerInstance.length > 256
    || ticket.algorithm !== TICKET_ALGORITHM
    || typeof ticket.keyB64 !== "string"
    || ticket.keyB64.length === 0
  ) {
    throw new TicketError("malformed", "ticket fields changed before secret preparation");
  }
  const now = nowSeconds();
  if (
    !Number.isSafeInteger(ticket.issuedAt)
    || ticket.issuedAt > now + TICKET_CLOCK_SKEW_SECONDS
    || now - ticket.issuedAt > TICKET_MAX_AGE_SECONDS
  ) {
    throw new TicketError("stale", "ticket is expired or issued in the future");
  }
  if (ticket.archiveId !== job.archiveId) {
    throw new TicketError("archive_mismatch", "ticket archive binding changed before secret preparation");
  }
  const expectedHash = ticketBindingHashSync(ticket.archiveId, stage.secretIndex);
  if (
    typeof ticket.secretsHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(ticket.secretsHash)
    || ticket.secretsHash !== expectedHash
  ) {
    throw new TicketError("binding_mismatch", "ticket secret binding changed before secret preparation");
  }
  if (lookupConsumedTicket(ticket.archiveId)) {
    throw new TicketError("replayed", "ticket has already been consumed");
  }
}

/**
 * Revalidate the ticket and consume its one-use tombstone inside the same
 * synchronous transaction as canonical rows, re-encrypted secrets, and the
 * receipt. No await may be introduced here: the transaction snapshot must
 * cover the binding checks and the insert together.
 */
function consumeTicketForCommit(
  db: Database,
  job: ImportJob,
  stage: StagedArchive,
  ticketResult: { ticket: DecryptionTicket; smk: Uint8Array } | null,
): void {
  if (!ticketResult) return;
  const ticket = ticketResult.ticket;
  if (job.ticketSubmittedBy !== job.userId) {
    throw new TicketError("binding_mismatch", "ticket submitter does not own this import");
  }
  if (
    ticket.kind !== TICKET_KIND
    || ticket.version !== TICKET_VERSION
    || ticket.issuer !== "lumiverse"
    || typeof ticket.issuerInstance !== "string"
    || ticket.issuerInstance.trim().length === 0
    || ticket.issuerInstance.length > 256
    || ticket.algorithm !== TICKET_ALGORITHM
    || typeof ticket.keyB64 !== "string"
    || ticket.keyB64.length === 0
  ) {
    throw new TicketError("malformed", "ticket fields changed before commit");
  }
  const now = nowSeconds();
  if (
    !Number.isSafeInteger(ticket.issuedAt)
    || ticket.issuedAt > now + TICKET_CLOCK_SKEW_SECONDS
    || now - ticket.issuedAt > TICKET_MAX_AGE_SECONDS
  ) {
    throw new TicketError("stale", "ticket is expired or issued in the future");
  }
  if (ticket.archiveId !== job.archiveId) {
    throw new TicketError("archive_mismatch", "ticket archive binding changed before commit");
  }
  const expectedHash = ticketBindingHashSync(ticket.archiveId, stage.secretIndex);
  if (!/^[0-9a-f]{64}$/u.test(ticket.secretsHash) || ticket.secretsHash !== expectedHash) {
    throw new TicketError("binding_mismatch", "ticket secret binding changed before commit");
  }
  const control = db.query(
    `SELECT user_id, archive_id, archive_digest, lease_owner, lease_generation, state
       FROM user_data_imports
      WHERE job_id = ?`,
  ).get(job.jobId) as {
    user_id?: unknown;
    archive_id?: unknown;
    archive_digest?: unknown;
    lease_owner?: unknown;
    lease_generation?: unknown;
    state?: unknown;
  } | null;
  if (
    !control
    || control.user_id !== job.userId
    || control.archive_id !== job.archiveId
    || control.archive_digest !== job.archiveDigest
    || control.lease_owner !== job.leaseOwner
    || control.lease_generation !== job.leaseGeneration
    || control.state !== "committing"
  ) {
    throw new Error("import lease fence lost");
  }
  const existing = db.query(
    "SELECT archive_id FROM import_consumed_tickets WHERE archive_id = ?",
  ).get(ticket.archiveId);
  if (existing) {
    throw new TicketError("replayed", "ticket has already been consumed");
  }
  const inserted = db.query(
    `INSERT INTO import_consumed_tickets (archive_id, consumed_at, user_id, uses)
       VALUES (?, ?, ?, 1)
     ON CONFLICT(archive_id) DO NOTHING`,
  ).run(ticket.archiveId, now, job.userId);
  if (inserted.changes !== 1) {
    throw new TicketError("replayed", "ticket has already been consumed");
  }
}

async function applyStagedArchive(job: ImportJob, stage: StagedArchive, ticketResult: { ticket: DecryptionTicket; smk: Uint8Array } | null): Promise<void> {
  if (job.abort.signal.aborted) throw job.abort.signal.reason ?? new Error("import cancelled");
  const db = getDb();
  assertTicketUsableBeforeSecretPreparation(job, stage, ticketResult);
  const progressSummary = requireImportProgressSummary(job.summary);
  let preparedSecrets: PreparedSecret[];
  try {
    preparedSecrets = await prepareSecrets(stage, ticketResult, job.abort.signal);
  const legacyAgentConfigs = collectImportedLegacyAgentConfigs(stage);
  if (job.abort.signal.aborted) throw job.abort.signal.reason ?? new Error("import cancelled");
  // Persist only bounded source/vector identities in the receipt summary
  // before COMMIT. Startup can then retry derived projection after a crash.
  const vectorDeadlineAt = Date.now() + IMPORT_FILE_OPERATION_DEADLINE_MS;
  const vectorIntent = await buildVectorProjectionIntent(
    stage,
    job.abort.signal,
    vectorDeadlineAt,
    () => {
      renewImportLease(job, db);
      assertCurrentFence(job, db);
    },
  );
  if (vectorIntent) progressSummary.vectors = vectorIntent;
  if (job.abort.signal.aborted) throw job.abort.signal.reason ?? new Error("import cancelled");
  // Files and their creator-proof journal rows are complete before this
  // transaction. The CAS transition below fences cancellation atomically.
  renewImportLease(job, db);
  assertCurrentFence(job, db);
  const journalDeadlineAt = Date.now() + IMPORT_FILE_OPERATION_DEADLINE_MS;
  await assertInstalledFileJournalIntact(
    job.jobId,
    db,
    job.abort.signal,
    journalDeadlineAt,
    () => {
      renewImportLease(job, db);
      assertCurrentFence(job, db);
    },
  );
  assertLiveCommitDiskCapacity(stage.db);
  beginImportCommit(job, db);
  db.run("PRAGMA defer_foreign_keys = ON");
  const importedPresetIds = new Set<string>();
  let committedReceiptSummary: ImportReceiptSummary | null = null;
  db.transaction(() => {
    assertCurrentFence(job, db);
    consumeTicketForCommit(db, job, stage, ticketResult);
    for (const table of getCanonicalImportOrder()) {
      if (!sqliteTableExists(stage.db, table)) continue;
      const spec = getArchiveTableSpec(table) as any;
      const columns = getTableColumnsFrom(db, table).map((column) => column.name);
      const insert = db.prepare(`INSERT INTO ${ident(table)} (${columns.map(ident).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      for (const raw of stage.db.query(`SELECT * FROM ${ident(table)}`).iterate() as Iterable<Record<string, any>>) {
        const row = rewriteOwner(table, raw, spec, job.userId);
        let imported = false;
        let skipped = false;
        if (table === "settings") {
          const value = typeof row.value === "string" ? row.value : JSON.stringify(row.value);
          const existing = db.query("SELECT value FROM settings WHERE key = ? AND user_id = ?").get(row.key, job.userId) as { value: string } | null;
          if (!existing) {
            insert.run(...columns.map((column) => sqlBinding(column === "user_id" ? job.userId : column === "value" ? value : row[column])));
            imported = true;
          } else {
            const existingValue = (() => { try { return JSON.parse(existing.value); } catch { return existing.value; } })();
            const importedValue = (() => { try { return JSON.parse(value); } catch { return value; } })();
            const merged = JSON.stringify(mergeSettingValue(existingValue, importedValue));
            if (merged !== existing.value) {
              db.query("UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND user_id = ?")
                .run(merged, nowSeconds(), row.key, job.userId);
              imported = true;
            } else {
              skipped = true;
            }
          }
        } else {
          const result = mergeCanonicalImportRow(db, table, spec, row, columns, insert);
          imported = result === "imported";
          skipped = result === "skipped";
        }
        const current = progressSummary[table] || { imported: 0, skipped: 0 };
        if (imported) current.imported++;
        if (skipped) current.skipped++;
        progressSummary[table] = current;
        if (table === "presets" && imported && typeof row.id === "string") importedPresetIds.add(row.id);
      }
    }
    for (const legacy of legacyAgentConfigs) {
      if (!importedPresetIds.has(legacy.presetId)) continue;
      if (db.query(
        "SELECT 1 FROM preset_agent_configs WHERE user_id = ? AND preset_id = ? LIMIT 1",
      ).get(job.userId, legacy.presetId)) continue;
      const migrated = migrateParsedLegacyAgentConfigV1(legacy.config, () => false);
      const prepared = prepareForeignAgentConfig(migrated.config);
      writePresetAgentConfigWithDb(db, job.userId, legacy.presetId, {
        config: prepared.config,
        bindings: prepared.config.connectionSlots.map((slot) => ({
          slotId: slot.id,
          connectionId: null,
        })),
        review: prepared.review,
      });
      const current = progressSummary.preset_agent_configs || { imported: 0, skipped: 0 };
      current.imported++;
      progressSummary.preset_agent_configs = current;
    }
    // A canonical AgentConfig can contain slots without a binding child (for
    // example, after a foreign export or an interrupted local repair). Preserve
    // that absence as an explicit inert tombstone instead of letting the slot
    // appear executable after restore.
    if (sqliteTableExists(stage.db, "preset_agent_connection_slots")
      && sqliteTableExists(db, "preset_agent_slot_bindings")) {
      const hasStagedBindings = sqliteTableExists(stage.db, "preset_agent_slot_bindings");
      const bindingColumns = getTableColumnsFrom(db, "preset_agent_slot_bindings").map((column) => column.name);
      const bindingInsert = db.prepare(
        `INSERT INTO preset_agent_slot_bindings (${bindingColumns.map(ident).join(",")}) VALUES (${bindingColumns.map(() => "?").join(",")})`,
      );
      const bindingUpdate = db.prepare(
        `UPDATE preset_agent_slot_bindings
            SET connection_id = NULL, binding_revision = ?, state = 'review_required',
                review_code = 'foreign_import', updated_at = ?
          WHERE user_id = ? AND preset_id = ? AND slot_id = ?`,
      );
      for (const slot of stage.db.query("SELECT user_id, preset_id, slot_id FROM preset_agent_connection_slots").iterate() as Iterable<Record<string, unknown>>) {
        const presetId = String(slot.preset_id ?? "");
        const slotId = String(slot.slot_id ?? "");
        if (!presetId || !slotId) continue;
        // An explicit staged row has already gone through the regular
        // authority-reset path. Only synthesize when the archive omitted it.
        if (hasStagedBindings && stage.db.query(
          "SELECT 1 FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ? AND slot_id = ? LIMIT 1",
        ).get(String(slot.user_id ?? ""), presetId, slotId)) continue;
        const existing = db.query(
          "SELECT binding_revision FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ? AND slot_id = ?",
        ).get(job.userId, presetId, slotId) as { binding_revision?: unknown } | null;
        const config = db.query(
          "SELECT binding_revision FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
        ).get(job.userId, presetId) as { binding_revision?: unknown } | null;
        const revisions = [existing?.binding_revision, config?.binding_revision]
          .map((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : 1);
        const revision = Math.max(1, ...revisions);
        if (existing) {
          bindingUpdate.run(revision, nowSeconds(), job.userId, presetId, slotId);
        } else {
          const tombstone: Record<string, unknown> = {
            user_id: job.userId,
            preset_id: presetId,
            slot_id: slotId,
            connection_id: null,
            binding_revision: revision,
            state: "review_required",
            review_code: "foreign_import",
            updated_at: nowSeconds(),
          };
          bindingInsert.run(...bindingColumns.map((column) => sqlBinding(tombstone[column])));
        }
        const current = progressSummary.preset_agent_slot_bindings || { imported: 0, skipped: 0 };
        current.imported++;
        progressSummary.preset_agent_slot_bindings = current;
      }
    }
    if (preparedSecrets.length > 0 && sqliteTableExists(db, "secrets")) {
      // Ticket success intentionally replaces same-owner values. It never
      // restores grants, activation, or any other authority-bearing row.
      const insert = db.prepare(`INSERT INTO secrets (key,encrypted_value,iv,tag,user_id,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(key,user_id) DO UPDATE SET encrypted_value=excluded.encrypted_value,iv=excluded.iv,tag=excluded.tag,updated_at=excluded.updated_at`);
      for (const secret of preparedSecrets) insert.run(secret.key, secret.encrypted_value, secret.iv, secret.tag, job.userId, nowSeconds());
      job.secretsRestored = preparedSecrets.length;
    }
    const tableSummary: Record<string, ImportTableSummary> = {};
    for (const [key, value] of Object.entries(progressSummary)) {
      if (key === "vectors") continue;
      if (!isImportTableSummary(value)) throw new Error(`import summary has malformed table: ${key}`);
      tableSummary[key] = value;
    }
    const projectionValue = progressSummary.vectors;
    const projectionIntent = projectionValue === undefined
      ? undefined
      : isVectorProjectionIntent(projectionValue)
        ? projectionValue
        : (() => { throw new Error("import summary has malformed vectors"); })();
    const projectionPending = projectionIntent?.projectionPending === true ? 1 : 0;
    const summary = sortedJson({
      tables: tableSummary,
      files: job.fileSummary,
      secrets: { imported: job.secretsRestored || 0, skipped: 0 },
      ...(projectionIntent ? { vectors: projectionIntent } : {}),
    });
    const parsedReceiptSummary = parseImportSummary(summary);
    if (!("tables" in parsedReceiptSummary) || !("files" in parsedReceiptSummary)) {
      throw new Error("import receipt summary is not an envelope");
    }
    committedReceiptSummary = parsedReceiptSummary as ImportReceiptSummary;
    db.query("INSERT INTO user_data_import_receipts (receipt_id,job_id,user_id,idempotency_key,archive_digest,summary_json,committed_at) VALUES (?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), job.jobId, job.userId, job.idempotencyKey, job.archiveDigest, summary, nowSeconds());
    // The receipt and settled journal are one synchronous relational commit.
    // A restart therefore sees only `installed`, never an ambiguous
    // `created`/`preexisting` state for a committed import.
    db.query(
      "UPDATE user_data_import_files SET install_state = 'installed', updated_at = ? WHERE job_id = ? AND install_state IN ('created','preexisting')",
    ).run(nowSeconds(), job.jobId);
    const updated = db.query("UPDATE user_data_imports SET summary_json = ?, projection_pending = ?, state = 'committed', updated_at = ?, finished_at = ? WHERE job_id = ? AND lease_owner = ? AND lease_generation = ?")
      .run(summary, projectionPending, nowSeconds(), nowSeconds(), job.jobId, job.leaseOwner, job.leaseGeneration);
    if (updated.changes !== 1) throw new Error("import lease fence lost");
  })();
  if (committedReceiptSummary) {
    const publicSummary = publicImportSummaries(committedReceiptSummary);
    job.summary = publicSummary.summary;
    job.fileSummary = publicSummary.fileSummary;
  }
  } finally {
    zeroizeTicketValue(ticketResult);
  }
}

/**
 * Rebuild the in-memory ticket gate after a process restart. The durable row
 * remains ownerless while waiting; the POST action alone reacquires it through
 * startImport(), which revalidates and restages the retained archive before
 * parking it again with a fresh fence.
 */
async function reloadParkedImportForAction(jobId: string): Promise<ImportJob> {
  const durable = readImportControl(jobId);
  if (
    !durable
    || durable.state !== "awaiting_ticket"
    || durable.lease_owner !== null
    || durable.lease_expires_at !== null
  ) {
    throw new TicketError("replayed", "ticket gate is no longer available");
  }
  const archivePath = join(dirname(durable.staging_path), "archive.lvbak");
  let started = JOBS.get(jobId);
  if (!started) {
    try {
      started = await startImport({
        userId: durable.user_id,
        archivePath,
        jobId,
        archiveId: durable.archive_id,
        archiveDigest: durable.archive_digest === "0".repeat(64) ? undefined : durable.archive_digest,
        idempotencyKey: durable.idempotency_key,
      });
    } catch (error) {
      // A concurrent process may have won the durable CAS and be doing the
      // same restaging work. Reuse its in-process projection if available;
      // otherwise preserve the original conflict for a retry response.
      started = JOBS.get(jobId);
      if (!started) throw error;
    }
  }
  const deadline = Date.now() + IMPORT_LEASE_SECONDS * 1_000;
  while (Date.now() < deadline) {
    const current = JOBS.get(jobId);
    if (current?.status === "awaiting_ticket" && current.ticketGate && current.ticketResolver) {
      return current;
    }
    if (
      current
      && (current.status === "complete" || current.status === "failed" || current.status === "cancelled")
    ) {
      throw new Error(`import job is not awaiting a ticket (status: ${current.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new TicketError("replayed", "ticket gate did not become available");
}

/** Submit a validated decryption ticket to a parked import gate. */
export async function submitTicket(
  jobId: string,
  rawTicket: unknown,
): Promise<{ accepted: true }> {
  const job = JOBS.get(jobId) ?? await reloadParkedImportForAction(jobId);
  if (job.ticketGateState !== "open") {
    throw new TicketError("replayed", "ticket gate has already been resolved");
  }
  if (job.status !== "awaiting_ticket") {
    throw new Error(`import job is not awaiting a ticket (status: ${job.status})`);
  }
  if (!job.ticketGate || !job.ticketResolver) {
    throw new TicketError("replayed", "ticket gate is unavailable");
  }
  if (job.abort.signal.aborted) throw new Error("import cancelled");
  const manifest = job.manifest;
  const ticketArchiveId = manifest?.archiveId || job.archiveId;
  if (!ticketArchiveId) throw new Error("job has no manifest yet");
  const archiveSecretKeys = job.archiveSecretKeys || [];

  let verified: TicketGateValue | null = null;
  try {
    try {
      verified = await verifyTicket(rawTicket, ticketArchiveId, archiveSecretKeys);
    } catch (err) {
      if (err instanceof TicketError) throw err;
      throw new TicketError("malformed", String((err as Error).message ?? err));
    }

    if (lookupConsumedTicket(ticketArchiveId)) {
      throw new TicketError("replayed", "ticket has already been consumed");
    }
    // Verification may yield while the parked job remains lease-free. Recheck
    // the gate, then reacquire the durable fence without consuming the ticket.
    if (job.ticketGateState !== "open") {
      throw new TicketError("replayed", "ticket gate has already been resolved");
    }
    if (job.abort.signal.aborted) throw new Error("import cancelled");
    try {
      reacquireParkedImport(job);
      assertCurrentFence(job);
      if (job.abort.signal.aborted) throw new Error("import cancelled");
    } catch (error) {
      let reparked = false;
      try {
        parkImportForTicket(job);
        reparked = true;
      } catch {
        try {
          reparked = clearParkedImportLeaseAfterFailure(job);
        } catch {
          reparked = false;
        }
        if (reparked) releaseJobAdmission(job);
        else {
          clearTicketGate(job);
          releaseJobAdmission(job);
        }
      }
      throw error;
    }

    // JS execution is synchronous from here through the resolver call, making
    // this state assignment the single local CAS against skip/duplicate calls.
    if (job.ticketGateState !== "open") {
      throw new TicketError("replayed", "ticket gate has already been resolved");
    }
    const acceptedTicket = verified;
    if (!acceptedTicket) {
      throw new TicketError("malformed", "ticket verification returned no ticket");
    }
    job.ticketSubmittedBy = job.userId;
    job.ticketGateState = "accepted";
    job.ticketReused = false;
    job.acceptedTicket = acceptedTicket;
    const resolveTicket = job.ticketResolver;
    job.ticketResolver = undefined;
    job.ticketGate = undefined;
    resolveTicket?.(acceptedTicket);
    return { accepted: true };
  } catch (error) {
    // Reacquisition, cancellation, or a duplicate submit can fail after
    // verifyTicket has allocated the SMK but before the worker owns it.
    // Never leave that private key reachable through a rejected request.
    if (verified) zeroizeTicketValue(verified);
    throw error;
  }
}

/** Resolve the gate with no ticket — proceed without restoring secrets. */
export async function skipTicket(jobId: string): Promise<boolean> {
  const job = JOBS.get(jobId) ?? await reloadParkedImportForAction(jobId);
  if (!job) return false;
  if (job.ticketGateState !== "open") {
    throw new TicketError("replayed", "ticket gate has already been resolved");
  }
  if (job.status !== "awaiting_ticket") return false;
  if (!job.ticketGate || !job.ticketResolver) {
    throw new TicketError("replayed", "ticket gate is unavailable");
  }
  if (job.abort.signal.aborted) {
    throw new TicketError("replayed", "ticket gate is closed");
  }
  try {
    reacquireParkedImport(job);
    assertCurrentFence(job);
    if (job.abort.signal.aborted) throw new Error("import cancelled");
  } catch (error) {
    let cleared = false;
    try {
      cleared = clearParkedImportLeaseAfterFailure(job);
    } catch {
      cleared = false;
    }
    const parked = readImportControl(job.jobId);
    if (
      !cleared
      && (!parked || parked.state !== "awaiting_ticket" || parked.lease_owner !== null)
    ) {
      clearTicketGate(job);
    }
    releaseJobAdmission(job);
    throw error;
  }
  if (job.ticketGateState !== "open") {
    throw new TicketError("replayed", "ticket gate has already been resolved");
  }
  job.ticketGateState = "skipped";
  const resolveTicket = job.ticketResolver;
  job.ticketResolver = undefined;
  job.ticketGate = undefined;
  resolveTicket?.(null);
  return true;
}

async function awaitTicketGate(
  job: ImportJob,
): Promise<{ ticket: DecryptionTicket; smk: Uint8Array } | null> {
  const gate = job.ticketGate;
  if (!gate) throw new Error("import ticket gate is unavailable");
  return new Promise<{ ticket: DecryptionTicket; smk: Uint8Array } | null>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      job.abort.signal.removeEventListener("abort", onAbort);
    };
    const resolveGate = (value: { ticket: DecryptionTicket; smk: Uint8Array } | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectGate = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      rejectGate(job.abort.signal.reason ?? new Error("import cancelled"));
    };
    job.abort.signal.addEventListener("abort", onAbort, { once: true });
    gate.then(resolveGate, rejectGate);
  });
}

async function runImportJob(job: ImportJob): Promise<void> {
  job.status = "running";

  emit(job, EventType.USER_IMPORT_PROGRESS, { phase: "start" });
  let stopLeaseHeartbeat = startImportLeaseHeartbeat(job);
  let stage: StagedArchive | null = null;
  let buf: ImportBuffer | null = null;
  let ticketResult: { ticket: DecryptionTicket; smk: Uint8Array } | null = null;
  try {
    transitionImport(job, "validating", ["queued"]);
    if (job.archiveIdentity && !samePersistedUploadIdentity(fileIdentity(job.archivePath), job.archiveIdentity)) {
      throw new ArchiveIdempotencyError();
    }
    buf = await extractArchive(job);
    const manifest = buf.manifest;
    if (!manifest) throw new Error("archive manifest is missing");
    const archiveHashDeadlineAt = Date.now() + IMPORT_FILE_OPERATION_DEADLINE_MS;
    const archiveHashHeartbeat: FileHashHeartbeat = () => {
      renewImportLease(job);
      assertCurrentFence(job);
    };
    const actualArchiveDigest = await sha256File(
      job.archivePath,
      job.abort.signal,
      archiveHashDeadlineAt,
      archiveHashHeartbeat,
    );
    if (job.archiveDigest !== "0".repeat(64) && job.archiveDigest !== actualArchiveDigest) {
      throw new ArchiveIdempotencyError();
    }
    if (job.archiveIdentity && !samePersistedUploadIdentity(fileIdentity(job.archivePath), job.archiveIdentity)) {
      throw new ArchiveIdempotencyError();
    }
    const effectiveArchiveId = manifest.archiveId || stableLegacyArchiveIdentity(actualArchiveDigest);
    if (!job.archiveId.startsWith("pending:") && job.archiveId !== effectiveArchiveId) {
      throw new ArchiveIdempotencyError();
    }
    if (job.idempotencyKey === `pending:${job.jobId}`) {
      job.idempotencyKey = effectiveArchiveId;
    }
    job.archiveId = effectiveArchiveId;
    job.archiveDigest = actualArchiveDigest;
    job.manifest = manifest;
    assertCurrentFence(job);
    const archiveMetadataNow = nowSeconds();
    const archiveMetadata = getDb().query(
      `UPDATE user_data_imports
          SET archive_id = ?, idempotency_key = ?, archive_digest = ?, manifest_json = ?, staging_path = ?, staging_db_path = ?, updated_at = ?
        WHERE job_id = ? AND lease_owner = ? AND lease_generation = ?
          AND (lease_expires_at IS NULL OR lease_expires_at > ?)
          AND state = 'validating'`,
    ).run(
      job.archiveId,
      job.idempotencyKey,
      job.archiveDigest,
      serializeDurableManifest(manifest, job.archiveIdentity),
      buf.stagingDir,
      join(buf.stagingDir, "staging.sqlite"),
      archiveMetadataNow,
      job.jobId,
      job.leaseOwner,
      job.leaseGeneration,
      archiveMetadataNow,
    );
    if (archiveMetadata.changes !== 1) throw new Error("import lease fence lost");
    emit(job, EventType.USER_IMPORT_PROGRESS, { phase: "extracted", entries: buf.entryCount });
    stage = await materializeValidatedArchive(job, buf);
    job.stagingDbPath = stage.dbPath;
    job.archiveSecretKeys = stage.secretIndex;
    await prepareStagedSealedPresets(job, stage);
    transitionImport(job, "ready", ["validating"]);


    if (manifest.hasEncryptedSecrets) {
      transitionImport(job, "awaiting_ticket", ["ready"]);
      job.status = "awaiting_ticket";
      emit(job, EventType.USER_IMPORT_PROGRESS, { phase: "awaiting_ticket", secretsCount: stage.secretIndex.length });
      stopLeaseHeartbeat();
      parkImportForTicket(job);
      ticketResult = await awaitTicketGate(job);
      stopLeaseHeartbeat = startImportLeaseHeartbeat(job);
      assertCurrentFence(job);
      transitionImport(job, "ready", ["awaiting_ticket"]);
      job.status = "running";
      emit(job, EventType.USER_IMPORT_PROGRESS, { phase: ticketResult ? "ticket_accepted" : "ticket_skipped", ticketReused: job.ticketReused ?? false });
    }

    await installValidatedFiles(job, stage);
    await applyStagedArchive(job, stage, ticketResult);
    await projectDerivedVectorsAfterReceipt(job, stage);
    job.status = "complete";
    job.finishedAt = nowSeconds();
    emit(job, EventType.USER_IMPORT_COMPLETE, { summary: job.summary, fileSummary: job.fileSummary });
  } catch (err: unknown) {
    const cancelled = job.abort.signal.aborted;
    const receipt = (() => {
      try {
        return getDb().query("SELECT summary_json FROM user_data_import_receipts WHERE job_id = ?").get(job.jobId) as { summary_json: string } | null;
      } catch {
        return null;
      }
    })();
    if (receipt) {
      job.status = "complete";
      try {
        const parsed = parseImportSummary(receipt.summary_json) as ImportReceiptSummary;
        const publicSummary = publicImportSummaries(parsed);
        job.summary = publicSummary.summary;
        job.fileSummary = publicSummary.fileSummary;
      } catch {}
      job.finishedAt = nowSeconds();
    } else {
      let rollbackSettled = true;
      try {
        await rollbackCreatedFiles(job.jobId, {
          leaseOwner: job.leaseOwner,
          leaseGeneration: job.leaseGeneration,
        });
      } catch {
        rollbackSettled = false;
      }
      let unsettledJournal = true;
      try {
        unsettledJournal = hasUnsettledFileJournal(job.jobId);
      } catch {
        unsettledJournal = true;
      }
      const cleanupPending = cancelled && (!rollbackSettled || unsettledJournal);
      job.status = cancelled ? (cleanupPending ? "cleanup_pending" : "cancelled") : "failed";
      const errorMessage = err instanceof Error ? err.message : typeof err === "string" ? err : "import failed";
      job.error = cancelled ? null : errorMessage;
      try {
        if (cancelled) {
          const durableState = cleanupPending ? "cleanup_pending" : "cancelled";
          const durableCode = cleanupPending ? "cleanup_pending" : "cancelled";
          getDb().query(
            `UPDATE user_data_imports SET state = ?, stable_error_code = ?,
                stable_error = COALESCE(stable_error, ?), updated_at = ?, finished_at = ?
              WHERE job_id = ? AND lease_owner = ? AND lease_generation = ?
                AND state IN ('cancelling','cancelled')`,
          ).run(
            durableState,
            durableCode,
            cleanupPending ? "import cancellation cleanup is pending" : "import cancelled by user",
            nowSeconds(),
            cleanupPending ? null : nowSeconds(),
            job.jobId,
            job.leaseOwner,
            job.leaseGeneration,
          );
        } else {
          const stableCode = err instanceof TicketError
            ? `ticket_${err.code}`
            : "integrity_failure";
          setImportError(job, stableCode, job.error || "import failed");
        }
      } catch {}
      if (!cleanupPending) job.finishedAt = nowSeconds();
      emit(job, EventType.USER_IMPORT_FAILED, { error: job.error, cancelled, cleanupPending });
    }
  } finally {
    zeroizeTicketValue(ticketResult);
    zeroizeTicketValue(job.acceptedTicket);
    ticketResult = null;
    job.acceptedTicket = undefined;
    clearTicketGate(job);
    stopLeaseHeartbeat();
    try { stage?.db.close(); } catch {}
    releaseJobAdmission(job);
    try {
      const control = readImportControl(job.jobId);
      const retainForReconcile = hasUnsettledFileJournal(job.jobId);
      const expectedState: Extract<ImportControlState, "committed" | "failed" | "cancelled"> =
        job.status === "complete"
          ? "committed"
          : job.status === "failed"
            ? "failed"
            : "cancelled";
      if (
        control
        && !retainForReconcile
        && job.status !== "cleanup_pending"
        && (job.status === "complete" || job.status === "failed" || job.status === "cancelled")
      ) {
        const stagingRemoved = cleanupTerminalImportStaging(job, expectedState);
        if (!stagingRemoved) {
          const current = readImportControl(job.jobId);
          if (
            current
            && current.lease_owner === job.leaseOwner
            && current.lease_generation === job.leaseGeneration
            && current.state === expectedState
          ) {
            markImportManualRecovery(getDb(), current);
          }
        }
      }
    } catch {}
    const resolveCompletion = job.resolveCompletion;
    job.resolveCompletion = undefined;
    try { resolveCompletion?.(); } catch {}
  }
}

/**
 * Reconcile only the durable import control plane. A receipt proves that the
 * relational transaction committed; without one this function can remove
 * only fenced, identity-matching files created by the job and never writes
 * canonical rows.
 */
export async function reconcileUserDataImports(): Promise<ImportRecoveryResult> {
  const db = getDb();
  const startupDeadlineAt = Date.now() + IMPORT_STARTUP_RECONCILIATION_DEADLINE_MS;
  // File hashing/copying must share the startup deadline. The previous
  // per-row lease-sized budget allowed a single journal to hold readiness open
  // for minutes even though the pass itself was intended to be bounded.
  const recoveryDeadlineAt = startupDeadlineAt;
  assertArchiveRegistryCoverage(db);

  const result = {
    inspected: 0,
    recovered: 0,
    deferred: 0,
    failed: 0,
  };
  const selectionNow = nowSeconds();
  const eligible = `
    (
      (
        state NOT IN ('committed', 'failed', 'cancelled')
        AND NOT (
          state = 'awaiting_ticket'
          AND lease_owner IS NULL
          AND lease_expires_at IS NULL
        )
      )
      OR staging_path <> ''
      OR staging_db_path <> ''
      OR projection_pending = 1
      OR EXISTS (
        SELECT 1
          FROM user_data_import_files f
         WHERE f.job_id = user_data_imports.job_id
           AND f.install_state IN ('pending', 'created')
      )
    )
  `;
  const rows = db.query(
    `SELECT job_id, user_id, archive_id, idempotency_key, archive_digest,
            manifest_json, staging_path, staging_db_path, state, lease_owner,
            lease_expires_at, lease_generation, projection_pending, created_at,
            updated_at, started_at, finished_at, stable_error_code, stable_error,
            summary_json
       FROM user_data_imports
      WHERE ${eligible}
      ORDER BY CASE
        WHEN lease_expires_at IS NOT NULL AND lease_expires_at > ? THEN 1
        ELSE 0
      END, CASE
        WHEN EXISTS (
          SELECT 1
            FROM user_data_import_files f
           WHERE f.job_id = user_data_imports.job_id
             AND f.install_state IN ('pending', 'created')
        ) THEN 0
        WHEN staging_path <> '' OR staging_db_path <> '' OR projection_pending = 1 THEN 1
        ELSE 2
      END, job_id ASC
      LIMIT ?`,
  ).all(selectionNow, MAX_IMPORT_STARTUP_RECONCILIATION_ROWS + 1) as ImportControlRow[];
  const rowsToInspect = Math.min(rows.length, MAX_IMPORT_STARTUP_RECONCILIATION_ROWS);
  const hasContinuation = rows.length > rowsToInspect;

  const deferRemaining = (count: number): void => {
    result.deferred += Math.max(0, count);
  };
  const sleepUntilLeaseExpiry = async (
    row: ImportControlRow,
  ): Promise<ImportControlRow | null> => {
    let current = row;
    while (current.lease_expires_at !== null && current.lease_expires_at > nowSeconds()) {
      const remainingMs = startupDeadlineAt - Date.now();
      if (remainingMs <= 0) return null;
      const waitMs = Math.min(
        remainingMs,
        Math.max(1, current.lease_expires_at * 1_000 - Date.now()),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      if (Date.now() >= startupDeadlineAt) return null;
      const refreshed = readImportControl(current.job_id, db);
      if (!refreshed) return null;
      current = refreshed;
    }
    return current;
  };

  for (let rowIndex = 0; rowIndex < rowsToInspect; rowIndex++) {
    result.inspected++;
    if (Date.now() >= startupDeadlineAt) {
      deferRemaining(rowsToInspect - rowIndex);
      break;
    }
    let row = rows[rowIndex]!;
    const liveJob = JOBS.get(row.job_id);
    if (
      liveJob
      && (
        liveJob.status === "running"
        || liveJob.status === "queued"
        || liveJob.status === "awaiting_ticket"
      )
    ) {
      result.deferred++;
      continue;
    }
    try {
      const receipt = db.query(
        "SELECT summary_json FROM user_data_import_receipts WHERE job_id = ?",
      ).get(row.job_id) as { summary_json: string } | null;
      if (receipt) {
        // Receipt replay is projection/cleanup-only: canonical rows are never
        // reopened. Rebuild bounded derived work before settling file journals.
        reconcileDerivedVectorProjection(row.job_id, row.user_id, receipt.summary_json);
        const updatedReceipt = db.query(
          "SELECT summary_json FROM user_data_import_receipts WHERE job_id = ?",
        ).get(row.job_id) as { summary_json: string } | null;
        const recoveredSummary = updatedReceipt?.summary_json || receipt.summary_json;
        const recoveredProjection = parseReceiptSummaryForProjection(recoveredSummary);
        const recoveredVectors = recoveredProjection?.vectors;
        const recoveredPendingValue = recoveredVectors
          && typeof recoveredVectors === "object"
          ? (recoveredVectors as Record<string, unknown>).projectionPending
          : undefined;
        const projectionPending = typeof recoveredPendingValue === "boolean"
          ? (recoveredPendingValue ? 1 : 0)
          : row.projection_pending;
        db.query(
          `UPDATE user_data_imports
              SET state = 'committed', summary_json = ?, projection_pending = ?,
                  updated_at = ?, finished_at = COALESCE(finished_at, ?)
            WHERE job_id = ?`,
        ).run(
          recoveredSummary,
          projectionPending,
          nowSeconds(),
          nowSeconds(),
          row.job_id,
        );
        const journalsSettled = await settleCommittedFileJournals(
          row.job_id,
          db,
          recoveryDeadlineAt,
        );
        const stagingRemoved = journalsSettled && cleanupOwnedImportArchive(row);
        if (stagingRemoved) {
          db.query(
            "UPDATE user_data_imports SET staging_path = '', staging_db_path = '', updated_at = ? WHERE job_id = ?",
          ).run(nowSeconds(), row.job_id);
        } else {
          markImportManualRecovery(db, row);
        }
        if (projectionPending !== 0 || !journalsSettled || !stagingRemoved) {
          result.deferred++;
        } else {
          result.recovered++;
        }
        continue;
      }
      if (row.state === "failed" || row.state === "cancelled") {
        if (row.lease_owner) {
          try {
            await rollbackCreatedFiles(row.job_id, {
              leaseOwner: row.lease_owner,
              leaseGeneration: row.lease_generation,
            }, undefined, recoveryDeadlineAt);
          } catch {}
        }
        const journalsRemain = hasUnsettledFileJournal(row.job_id, db);
        const stagingRemoved = !journalsRemain && cleanupOwnedImportArchive(row);
        if (stagingRemoved) {
          db.query(
            "UPDATE user_data_imports SET staging_path = '', staging_db_path = '', updated_at = ? WHERE job_id = ?",
          ).run(nowSeconds(), row.job_id);
          result.recovered++;
        } else {
          markImportManualRecovery(db, row);
          result.deferred++;
        }
        continue;
      }
      if (row.state === "awaiting_ticket" && row.lease_owner === null && row.lease_expires_at === null) {
        // A parked ticket gate is intentionally ownerless and has no live
        // process to recover. Leave it durable until the ticket POST reacquires
        // a fence and rebuilds the in-memory continuation.
        result.deferred++;
        continue;
      }
      if (row.lease_expires_at !== null && row.lease_expires_at > nowSeconds()) {
        const refreshed = await sleepUntilLeaseExpiry(row);
        if (!refreshed) {
          result.deferred++;
          continue;
        }
        row = refreshed;
        if (
          row.lease_expires_at !== null
          && row.lease_expires_at > nowSeconds()
        ) {
          result.deferred++;
          continue;
        }
      }
      if (Date.now() >= startupDeadlineAt) {
        result.deferred++;
        continue;
      }
      const now = nowSeconds();
      const takeoverOwner = `reconcile:${crypto.randomUUID()}`;
      const takeover = db.query(
        `UPDATE user_data_imports
            SET lease_owner = ?, lease_generation = lease_generation + 1,
                lease_expires_at = ?, updated_at = ?
          WHERE job_id = ? AND lease_generation = ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            AND state NOT IN ('committed','failed','cancelled')`,
      ).run(
        takeoverOwner,
        now + IMPORT_LEASE_SECONDS,
        now,
        row.job_id,
        row.lease_generation,
        now,
      );
      if (takeover.changes !== 1) {
        result.deferred++;
        continue;
      }
      const recoveryJob = {
        jobId: row.job_id,
        userId: row.user_id,
        leaseOwner: takeoverOwner,
        leaseGeneration: row.lease_generation + 1,
      } as ImportJob;
      let rollbackSettled = true;
      try {
        await rollbackCreatedFiles(
          recoveryJob.jobId,
          {
            leaseOwner: recoveryJob.leaseOwner,
            leaseGeneration: recoveryJob.leaseGeneration,
          },
          undefined,
          recoveryDeadlineAt,
        );
      } catch {
        rollbackSettled = false;
      }
      const journalsRemain = (() => {
        try {
          return hasUnsettledFileJournal(recoveryJob.jobId, db);
        } catch {
          return true;
        }
      })();
      const cleanupState = row.state === "cleanup_pending" || row.state === "cancelling";
      const stagingNeeded = Boolean(row.staging_path || row.staging_db_path);
      const stagingRemoved = !journalsRemain
        && (!stagingNeeded || cleanupOwnedImportArchive(row));
      if (cleanupState) {
        if (!rollbackSettled || journalsRemain || !stagingRemoved) {
          db.query(
            `UPDATE user_data_imports
                SET state = 'cleanup_pending', stable_error_code = 'cleanup_pending',
                    stable_error = 'import cancellation cleanup is pending',
                    lease_expires_at = ?, updated_at = ?, finished_at = NULL
              WHERE job_id = ? AND lease_owner = ? AND lease_generation = ?
                AND state IN ('cancelling','cleanup_pending')`,
          ).run(
            nowSeconds() + IMPORT_LEASE_SECONDS,
            nowSeconds(),
            row.job_id,
            takeoverOwner,
            row.lease_generation + 1,
          );
          result.deferred++;
        } else {
          db.query(
            `UPDATE user_data_imports
                SET state = 'cancelled', stable_error_code = 'cancelled',
                    stable_error = 'import cancelled by user',
                    staging_path = '', staging_db_path = '',
                    updated_at = ?, finished_at = ?
              WHERE job_id = ? AND lease_owner = ? AND lease_generation = ?
                AND state IN ('cancelling','cleanup_pending')`,
          ).run(
            nowSeconds(),
            nowSeconds(),
            row.job_id,
            takeoverOwner,
            row.lease_generation + 1,
          );
          result.recovered++;
        }
        continue;
      }
      db.query(
        `UPDATE user_data_imports
            SET state = 'failed', stable_error_code = 'process_interrupted',
                stable_error = 'import process interrupted before relational commit',
                staging_path = CASE WHEN ? = 1 THEN '' ELSE staging_path END,
                staging_db_path = CASE WHEN ? = 1 THEN '' ELSE staging_db_path END,
                updated_at = ?, finished_at = ?
          WHERE job_id = ? AND lease_owner = ? AND lease_generation = ?
            AND state NOT IN ('committed','cancelled')`,
      ).run(
        stagingRemoved ? 1 : 0,
        stagingRemoved ? 1 : 0,
        nowSeconds(),
        nowSeconds(),
        row.job_id,
        takeoverOwner,
        row.lease_generation + 1,
      );
      if (!stagingRemoved) {
        markImportManualRecovery(db, row);
        result.deferred++;
      } else {
        result.recovered++;
      }
    } catch {
      result.failed++;
      // A failed recovery attempt must not strand a fresh live lease. Keep the
      // durable row eligible for the next bounded pass and preserve any staged
      // evidence for retry/manual recovery.
      try {
        db.query(
          `UPDATE user_data_imports
              SET lease_expires_at = ?, updated_at = ?
            WHERE job_id = ? AND lease_owner LIKE 'reconcile:%'`,
        ).run(nowSeconds() - 1, nowSeconds(), row.job_id);
      } catch {}
    }
  }

  const complete = !hasContinuation
    && result.deferred === 0
    && result.failed === 0;
  return {
    ...result,
    complete,
    healthy: complete,
  };
}
function validateManifestEntriesForTest(
  manifest: ArchiveManifest,
  input: Pick<ImportBuffer, "entries" | "binaryJournalPath">,
): Promise<void> {
  return validateManifestEntries(manifest, {
    entries: input.entries,
    payloadPaths: new Set(),
    binaryJournalPath: input.binaryJournalPath,
    manifest,
    totalDecompressed: 0,
    entryCount: input.entries.length,
    binaryEntryCount: 0,
    stagingDir: dirname(input.binaryJournalPath),
  });
}
function setDirectorySyncHook(hook: DirectorySyncHook | null): void {
  directorySyncHook = hook;
}

function forgetInMemoryJobForRestart(jobId: string): void {
  const job = JOBS.get(jobId);
  if (!job) return;
  zeroizeTicketValue(job.acceptedTicket);
  job.acceptedTicket = undefined;
  clearTicketGate(job);
  JOBS.delete(jobId);
  if (USER_RUNNING.get(job.userId) === jobId) USER_RUNNING.delete(job.userId);
  if (USER_UPLOAD_RESERVATIONS.get(job.userId) === jobId) USER_UPLOAD_RESERVATIONS.delete(job.userId);
  releaseGlobalImportSlot(jobId);
}

function setFilesystemCapacityHook(hook: FilesystemCapacityHook | null): void {
  filesystemCapacityHook = hook;
}

function setStagingFootprintHook(hook: StagingFootprintHook | null): void {
  stagingFootprintHook = hook;
}
function setTicketZeroizationHook(hook: TicketZeroizationHook | null): void {
  ticketZeroizationHook = hook;
}
function setPortableSealedPresetResolverOverride(
  resolver: PortableSealedPresetResolver | null,
): void {
  portableSealedPresetResolverOverride = resolver;
}

export const __test__ = {
  authorityResetRow,
  forgetInMemoryJobForRestart,
  syncDirectory,
  copyNoReplace,
  setDirectorySyncHook,
  assertAudioPayload,
  readNdjsonEntriesSync,
  validateManifestEntries: validateManifestEntriesForTest,
  assertInstalledFileJournalIntact,
  settleCommittedFileJournals,
  renewImportLease,
  buildLiveFileReferenceIndex,
  liveFileReferenceExists,
  rollbackCreatedFiles,
  cleanupTerminalImportStaging,
  parkImportForTicket,
  reacquireParkedImport,
  stripImportedLegacyPresetMetadataV1,
  scheduleDerivedVectorProjectionSync,
  normalizeSqlValue,
  createStagedTable,
  validateSecretIndex,
  assertLiveCommitDiskCapacity,
  setFilesystemCapacityHook,
  setTicketZeroizationHook,
  setPortableSealedPresetResolverOverride,
  setStagingFootprintHook,
  validateVectorArchiveRowShape,
  validateVectorArchiveIdentity,
  assertVectorCanonicalSource,
  validateLegacyVectorArchiveRow,
  computeVectorSourceDigest,
  maxVectorDimension: MAX_VECTOR_DIMENSION,
  maxVectorRowBytes: MAX_VECTOR_ROW_BYTES,
  maxVectorDecodedBytes: MAX_VECTOR_DECODED_BYTES,
  maxVectorBatchBytes: MAX_VECTOR_BATCH_BYTES,
  maxVectorIdBytes: MAX_VECTOR_ID_BYTES,
  maxVectorRowsPerTable: MAX_ROWS_PER_TABLE,
  maxSqlReal: MAX_SQL_REAL,
  maxSqlBlobBytes: MAX_SQL_BLOB_BYTES,
  mergeCanonicalImportRow,
};
