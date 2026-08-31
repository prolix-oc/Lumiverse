// Streaming user-data export.
//
// Export is deliberately split into two phases.  A per-user exclusive barrier
// protects the relational snapshot and source-file identity while referenced
// files are copied to a private staging tree.  The barrier is then released,
// but the dedicated read snapshot remains open while canonical rows stream into
// the ZIP.  Only staged files are ever appended to the archive.

import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  createReadStream,
  createWriteStream,
} from "fs";
import type { WriteStream } from "fs";
import { ZipArchive, type ArchiverError } from "archiver";
import { PassThrough, Writable } from "stream";
import { createHash } from "crypto";
import { join, resolve } from "path";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import { getActiveVectorStore, type CollectionName, type VectorRow, type VectorStore } from "../vector-store";
import { env } from "../../env";
import { getEncryptionKeyBytes } from "../../crypto/init";
import {
  ARCHIVE_CANONICAL_TABLES,
  ARCHIVE_REGISTRY_VERSION,
  getArchiveTableSpec,
  getCanonicalImportOrder,
  SECRET_SETTING_KEY_PATTERNS,
  getArchiveVectorTables,
  buildArchiveOwnerPredicate,
} from "./table-registry";
import {
  fingerprintPrivateDataAndSecretInventory,
  scrubLegacyImageGenerationSettingRow,
  type PrivateDataSecretInventoryEntry,
} from "./private-data";
import { scrubPresetMetadata } from "../agent-config-portability.service";
import {
  cleanupFrozenStaging,
  encodeArchiveOwnerKey,
  archivePathForRef,
  fileIdentityEquals,
  openUserDataReadSnapshot,
  resolveArchiveSourcePath,
  resolveArchivePathWithinRoot,
  stageFrozenFile,
  userDataSnapshotBarrier,
  type FrozenFileDescriptorV1,
  type StagedFrozenFileV1,
  type UserDataProjectionStampV1,
} from "./snapshot";
import {
  createManifest,
  ARCHIVE_SCHEMA_VERSION,
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
  type ArchiveEmbeddingConfig,
  type ArchiveEmbeddingIdentity,
  type ArchiveEntry,
  type ArchiveFileAlias,
  type ArchiveSourceIdentity,
} from "./manifest";
import { encryptSecret } from "./secret-ticket.service";
import { strictestMediaLimit } from "../../types/media-limits";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const YIELD_INTERVAL_ROWS = 1024;
const NDJSON_COMPRESSION = 3;
const NDJSON_FLUSH_BYTES = 256 * 1024;
const BINARY_HIGH_WATER_MARK = 256 * 1024;

const EXPORT_STAGING_PREFIX = ".lvbak-export-";
const EXPORT_STAGING_MARKER = ".lease.json";
const EXPORT_STAGING_LEASE_MS = 60 * 60 * 1000;
const EXPORT_STAGING_HEARTBEAT_MS = 30 * 1000;
const EXPORT_STAGING_SCAN_LIMIT = 256;

interface ExportStagingLeaseV1 {
  readonly version: 1;
  readonly archiveId: string;
  readonly ownerToken: string;
  readonly createdAt: number;
  readonly heartbeatAt: number;
  readonly leaseExpiresAt: number;
}

export interface ExportStagingReconcileResult {
  readonly inspected: number;
  readonly removed: number;
  readonly preserved: number;
  readonly failures: number;
}

function writeExportStagingLease(stagingDir: string, lease: ExportStagingLeaseV1): void {
  const marker = join(stagingDir, EXPORT_STAGING_MARKER);
  const temporary = `${marker}.${lease.ownerToken}.tmp`;
  writeFileSync(temporary, JSON.stringify(lease), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, marker);
}

function createExportStagingLease(archiveId: string): { path: string; lease: ExportStagingLeaseV1 } {
  const path = mkdtempSync(join(env.dataDir, EXPORT_STAGING_PREFIX));
  const now = Date.now();
  const lease: ExportStagingLeaseV1 = {
    version: 1,
    archiveId,
    ownerToken: crypto.randomUUID(),
    createdAt: now,
    heartbeatAt: now,
    leaseExpiresAt: now + EXPORT_STAGING_LEASE_MS,
  };
  try {
    writeExportStagingLease(path, lease);
    return { path, lease };
  } catch (error) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* preserve original error */ }
    throw error;
  }
}

function refreshExportStagingLease(stagingDir: string, lease: ExportStagingLeaseV1): ExportStagingLeaseV1 {
  const now = Date.now();
  const refreshed: ExportStagingLeaseV1 = {
    ...lease,
    heartbeatAt: now,
    leaseExpiresAt: now + EXPORT_STAGING_LEASE_MS,
  };
  writeExportStagingLease(stagingDir, refreshed);
  return refreshed;
}

/**
 * Remove only stale export staging directories that carry our marker. An
 * unmarked/new directory is preserved because it may belong to an export that
 * has not finished writing its marker yet. The bounded scan prevents a
 * corrupted data directory from turning startup into an unbounded walk.
 */
export function reconcileStaleExportStaging(now = Date.now()): ExportStagingReconcileResult {
  if (!existsSync(env.dataDir)) return { inspected: 0, removed: 0, preserved: 0, failures: 0 };
  let names: string[];
  try {
    names = readdirSync(env.dataDir).filter((name) => name.startsWith(EXPORT_STAGING_PREFIX));
  } catch {
    throw new Error("export staging reconciliation could not read the data directory");
  }
  if (names.length > EXPORT_STAGING_SCAN_LIMIT) {
    throw new Error(`export staging reconciliation exceeds ${EXPORT_STAGING_SCAN_LIMIT} directories`);
  }
  let inspected = 0;
  let removed = 0;
  let preserved = 0;
  let failures = 0;
  for (const name of names) {
    const stagingDir = join(env.dataDir, name);
    let stats;
    try {
      stats = statSync(stagingDir);
      if (!stats.isDirectory()) continue;
    } catch {
      failures++;
      continue;
    }
    inspected++;
    let stale = false;
    try {
      const raw = JSON.parse(readFileSync(join(stagingDir, EXPORT_STAGING_MARKER), "utf8")) as Partial<ExportStagingLeaseV1>;
      stale = raw.version === 1
        && typeof raw.ownerToken === "string"
        && typeof raw.archiveId === "string"
        && Number.isFinite(raw.leaseExpiresAt)
        && Number(raw.leaseExpiresAt) <= now;
      if (!stale) {
        preserved++;
        continue;
      }
    } catch {
      // A marker-less directory is removable only after its directory mtime
      // proves that the short marker-write window has elapsed.
      stale = stats.mtimeMs + EXPORT_STAGING_LEASE_MS <= now;
      if (!stale) {
        preserved++;
        continue;
      }
    }
    try {
      rmSync(stagingDir, { recursive: true, force: true });
      removed++;
    } catch {
      failures++;
    }
  }
  const result = { inspected, removed, preserved, failures };
  if (failures > 0) throw new Error("export staging reconciliation failed");
  return result;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExportSecretsContext {
  smk: Uint8Array;
  secretKeys: readonly string[];
  privateDataFingerprint: string;
}

export interface ExportOptions {
  userId: string;
  includeVectors: boolean;
  signal?: AbortSignal;
  producerVersion?: string | null;
  secrets?: ExportSecretsContext;
  archiveId?: string;
}

export function buildExportStream(opts: ExportOptions): ReadableStream<Uint8Array> {
  const localAbort = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) localAbort.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", () => localAbort.abort(opts.signal!.reason), { once: true });
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void runExport({ ...opts, signal: localAbort.signal }, controller).catch((err) => {
        try {
          controller.error(err);
        } catch {
          /* already errored */
        }
      });
    },
    cancel(reason) {
      localAbort.abort(reason ?? new DOMException("Aborted", "AbortError"));
    },
  }, {
    highWaterMark: BINARY_HIGH_WATER_MARK,
    size(chunk) {
      return chunk?.byteLength ?? 0;
    },
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function yieldAndCheck(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function emitProgress(userId: string, payload: Record<string, unknown>): void {
  try {
    eventBus.emit(EventType.USER_EXPORT_PROGRESS, payload, userId);
  } catch {
    /* progress is best-effort */
  }
}

function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

function isSecretSettingKey(key: string): boolean {
  return SECRET_SETTING_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function tableColumns(db: any, table: string): string[] {
  return (db.query(`PRAGMA table_info(${ident(table)})`).all() as { name: string }[]).map((column) => column.name);
}

function specTable(spec: any): string {
  if (!spec || typeof spec.table !== "string" || spec.table.length === 0) throw new Error("archive registry has an invalid table spec");
  return spec.table;
}

function canonicalSpecs(): any[] {
  const order = getCanonicalImportOrder();
  const out: any[] = [];
  const seen = new Set<string>();
  for (const item of order as readonly unknown[]) {
    const table = typeof item === "string" ? item : (item as { table?: unknown })?.table;
    if (typeof table !== "string" || seen.has(table)) continue;
    const spec = getArchiveTableSpec(table) as any;
    if (!spec || spec.kind !== "canonical") continue;
    seen.add(table);
    out.push(spec);
  }
  // The registry's canonical list is authoritative.  This assertion catches
  // an accidentally incomplete order without reintroducing a second order.
  const expected = (ARCHIVE_CANONICAL_TABLES as readonly unknown[])
    .map((item) => (typeof item === "string" ? item : (item as { table?: unknown })?.table))
    .filter((table): table is string => typeof table === "string");
  const expectedSet = new Set(expected);
  if (out.length !== expectedSet.size || out.some((spec) => !expectedSet.has(spec.table))) {
    throw new Error("archive canonical import order does not cover the canonical registry exactly");
  }
  return out;
}


function selectForTable(db: any, spec: any, userId: string): { sql: string; params: unknown[]; columns: string[] } | null {
  const table = specTable(spec);
  const columns = tableColumns(db, table);
  if (columns.length === 0) return null;
  const clauses: string[] = [];
  const params: unknown[] = [];
  const owner = buildArchiveOwnerPredicate(spec, userId, ident(table));
  if (owner) {
    clauses.push(owner.sql);
    params.push(...owner.params);
  }
  let sql = `SELECT ${columns.map(ident).join(", ")} FROM ${ident(table)}`;
  if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
  const primaryKey = Array.isArray(spec.primaryKey) ? spec.primaryKey : [];
  if (primaryKey.length > 0) sql += ` ORDER BY ${primaryKey.map(ident).join(", ")}`;
  return { sql, params, columns };
}

function scrubRow(row: Record<string, unknown>, scrub?: Record<string, unknown>): Record<string, unknown> {
  if (!scrub) return row;
  const out = { ...row };
  for (const [column, value] of Object.entries(scrub)) {
    if (column in out) out[column] = value;
  }
  return out;
}

const PRIVATE_REASONING_KEYS: Readonly<Record<string, true>> = {
  reasoningCarrier: true,
  reasoningCarrierBySwipe: true,
};

function scrubPrivateReasoningCarriers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => scrubPrivateReasoningCarriers(entry));
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (PRIVATE_REASONING_KEYS[key]) continue;
    out[key] = scrubPrivateReasoningCarriers(entry);
  }
  return out;
}

export function scrubArchiveRowPrivateData(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (PRIVATE_REASONING_KEYS[key]) continue;
    if (key === "extra" && typeof value === "string") {
      try {
        out[key] = JSON.stringify(scrubPrivateReasoningCarriers(JSON.parse(value)));
      } catch {
        out[key] = value;
      }
      continue;
    }
    out[key] = scrubPrivateReasoningCarriers(value);
  }
  return out;
}
/** Strip obsolete Agentic metadata aliases before writing a V2 backup row. */
function scrubPresetMetadataForExport(value: unknown): unknown {
  const wasString = typeof value === "string";
  let parsed: unknown = value;
  if (wasString) {
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return value;
  const scrubbed = scrubPresetMetadata(parsed);
  return wasString ? JSON.stringify(scrubbed) : scrubbed;
}
const SEALED_PRESET_METADATA_KEY = "_lumiverse_sealed_preset";
const PORTABLE_SEALED_PRESET_METADATA_KEY = "portableSealedPreset";
const SEALED_PRESET_ID_METADATA_KEY = "_lumiverse_lumihub_id";
const SEALED_PRESET_VERSION_METADATA_KEY = "_lumiverse_preset_version";
const SEALED_PRESET_PLACEHOLDER_RE = /^\{\{(?:presetBlock|pblock)::([^}]+)\}\}$/;

type CanonicalSealedManifest = {
  version: string | null;
  blocks: Array<{ key: string; sha256: string }>;
};
type PortableSealedPresetDescriptor = {
  hubPresetId: string;
  hubPresetVersion: string;
  blocks: Array<{ key: string; sha256: string }>;
};

interface SealedPromptBlockDescriptor {
  key: string;
  hubPresetId: string;
  version: string;
  sha256: string;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readJsonColumn(value: unknown, column: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`presets.${column} is not valid JSON`);
  }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readSealedBlockKey(value: unknown, label: string): string | null {
  const key = readNonEmptyString(value);
  if (key && !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new Error(`sealed preset ${label} contains an invalid block key`);
  }
  return key;
}

function readSha256(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value.trim())) {
    throw new Error(`sealed preset ${label} must be a 64-character hexadecimal SHA-256 digest`);
  }
  return value.trim().toLowerCase();
}

function readManifestBlocks(
  value: unknown,
  label: string,
  allowEmpty = false,
): Array<{ key: string; sha256: string }> {
  if (!Array.isArray(value) || value.length > 200 || (!allowEmpty && value.length === 0)) {
    throw new Error(`sealed preset ${label}.blocks must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  const blocks: Array<{ key: string; sha256: string }> = [];
  const byKey = new Map<string, string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new Error(`sealed preset ${label}.blocks entries must be objects`);
    }
    const key = readSealedBlockKey(entry.key, `${label}.key`);
    if (!key) throw new Error(`sealed preset ${label} contains a block without a key`);
    const sha256 = readSha256(entry.sha256, `${label}.${key}`);
    if (!sha256) throw new Error(`sealed preset ${label}.${key} is missing its digest`);
    if (byKey.has(key)) {
      if (byKey.get(key) !== sha256) {
        throw new Error(`sealed preset ${label} contains conflicting digests for ${key}`);
      }
      throw new Error(`sealed preset ${label} contains duplicate block key ${key}`);
    }
    byKey.set(key, sha256);
    blocks.push({ key, sha256 });
  }
  return blocks;
}

function readSealedManifest(value: unknown, label: string): CanonicalSealedManifest {
  if (!isRecord(value)) {
    throw new Error(`sealed preset ${label} must be an object`);
  }
  if (
    value.version !== undefined
    && value.version !== null
    && (typeof value.version !== "string" || !value.version.trim())
  ) {
    throw new Error(`sealed preset ${label}.version must be a non-empty string when present`);
  }
  return {
    version: readNonEmptyString(value.version),
    blocks: readManifestBlocks(value.blocks, label, true),
  };
}

function readPortableSealedPresetDescriptor(
  value: unknown,
  label: string,
): PortableSealedPresetDescriptor {
  if (!isRecord(value)) {
    throw new Error(`sealed preset ${label} must be an object`);
  }
  const hubPresetId = readNonEmptyString(value.hubPresetId);
  if (!hubPresetId) throw new Error(`sealed preset ${label}.hubPresetId is required`);
  const hubPresetVersion = readNonEmptyString(value.hubPresetVersion);
  if (!hubPresetVersion) throw new Error(`sealed preset ${label}.hubPresetVersion is required`);
  return {
    hubPresetId,
    hubPresetVersion,
    blocks: readManifestBlocks(value.blocks, label),
  };
}

function sealedManifestEqual(
  left: CanonicalSealedManifest,
  right: CanonicalSealedManifest,
): boolean {
  if (left.version && right.version && left.version !== right.version) return false;
  const normalize = (manifest: CanonicalSealedManifest) =>
    manifest.blocks.map((block) => `${block.key}:${block.sha256}`).sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function portableDescriptorEqual(
  left: PortableSealedPresetDescriptor,
  right: PortableSealedPresetDescriptor,
): boolean {
  if (left.hubPresetId !== right.hubPresetId || left.hubPresetVersion !== right.hubPresetVersion) {
    return false;
  }
  const normalize = (descriptor: PortableSealedPresetDescriptor) =>
    descriptor.blocks.map((block) => `${block.key}:${block.sha256}`).sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function extractSealedPlaceholder(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(SEALED_PRESET_PLACEHOLDER_RE);
  return match?.[1]?.trim() || null;
}

function hasSealedBlockMarker(block: Record<string, any>): boolean {
  return (Object.hasOwn(block, "sealed") && block.sealed !== false)
    || Object.hasOwn(block, "sealedSource")
    || Object.hasOwn(block, "sealedKey")
    || Object.hasOwn(block, "sealedOriginPresetId")
    || Object.hasOwn(block, "sealedOriginVersion")
    || Object.hasOwn(block, "sealedSha256")
    || extractSealedPlaceholder(block.content) !== null;
}

function metadataSealedDescriptorCandidates(metadata: Record<string, any>): Array<{
  label: string;
  value: unknown;
  portable: boolean;
}> {
  const candidates: Array<{ label: string; value: unknown; portable: boolean }> = [];
  if (Object.hasOwn(metadata, PORTABLE_SEALED_PRESET_METADATA_KEY)) {
    candidates.push({
      label: PORTABLE_SEALED_PRESET_METADATA_KEY,
      value: metadata[PORTABLE_SEALED_PRESET_METADATA_KEY],
      portable: true,
    });
  }
  // Installer-created ordinary LumiHub presets persist this legacy field as
  // null when they have no private blocks. Treat that explicit absence as
  // “no descriptor”, while still rejecting any non-null malformed manifest.
  if (Object.hasOwn(metadata, SEALED_PRESET_METADATA_KEY)
    && metadata[SEALED_PRESET_METADATA_KEY] != null) {
    candidates.push({ label: SEALED_PRESET_METADATA_KEY, value: metadata[SEALED_PRESET_METADATA_KEY], portable: false });
  }
  if (Object.hasOwn(metadata, "sealedPreset") && metadata.sealedPreset != null) {
    candidates.push({ label: "sealedPreset", value: metadata.sealedPreset, portable: false });
  }
  const compatibility = isRecord(metadata.compatibility) ? metadata.compatibility : null;
  const lumiverse = compatibility && isRecord(compatibility.lumiverse)
    ? compatibility.lumiverse
    : null;
  if (lumiverse && Object.hasOwn(lumiverse, "sealedPreset") && lumiverse.sealedPreset != null) {
    candidates.push({
      label: "compatibility.lumiverse.sealedPreset",
      value: lumiverse.sealedPreset,
      portable: false,
    });
  }
  return candidates;
}

function getMetadataHubPresetId(metadata: Record<string, any>): string | null {
  if (!Object.hasOwn(metadata, SEALED_PRESET_ID_METADATA_KEY)) return null;
  const value = metadata[SEALED_PRESET_ID_METADATA_KEY];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`sealed preset metadata ${SEALED_PRESET_ID_METADATA_KEY} is required`);
  }
  return value.trim();
}

function getMetadataPresetVersion(metadata: Record<string, any>): string | null {
  if (!Object.hasOwn(metadata, SEALED_PRESET_VERSION_METADATA_KEY)) return null;
  const value = metadata[SEALED_PRESET_VERSION_METADATA_KEY];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`sealed preset metadata ${SEALED_PRESET_VERSION_METADATA_KEY} must be a non-empty string`);
  }
  return value.trim();
}

function canonicalizeSealedPresetRow(raw: Record<string, any>): Record<string, any> {
  const promptOrder = readJsonColumn(raw.prompt_order, "prompt_order");
  const metadataValue = readJsonColumn(raw.metadata, "metadata");
  if (!Array.isArray(promptOrder)) {
    throw new Error("presets.prompt_order must be an array when it contains sealed blocks");
  }
  if (!isRecord(metadataValue)) {
    throw new Error("presets.metadata must be an object when prompt_order contains sealed blocks");
  }
  const metadata = metadataValue;
  const candidates = metadataSealedDescriptorCandidates(metadata);
  let portableDescriptor: PortableSealedPresetDescriptor | null = null;
  let manifest: CanonicalSealedManifest | null = null;
  for (const candidate of candidates) {
    if (candidate.portable) {
      const next = readPortableSealedPresetDescriptor(candidate.value, candidate.label);
      if (portableDescriptor && !portableDescriptorEqual(portableDescriptor, next)) {
        throw new Error("sealed preset metadata contains inconsistent portable descriptors");
      }
      portableDescriptor = next;
      continue;
    }
    const next = readSealedManifest(candidate.value, candidate.label);
    if (manifest === null) {
      manifest = next;
      continue;
    }
    if (!sealedManifestEqual(manifest, next)) {
      throw new Error("sealed preset metadata contains inconsistent manifests");
    }
    if (manifest.version === null && next.version !== null) {
      manifest = { version: next.version, blocks: manifest.blocks };
    }
  }

  const metadataHubPresetId = getMetadataHubPresetId(metadata);
  const metadataVersion = getMetadataPresetVersion(metadata);
  if (portableDescriptor && metadataHubPresetId && portableDescriptor.hubPresetId !== metadataHubPresetId) {
    throw new Error("sealed preset metadata contains conflicting Hub preset ids");
  }
  if (portableDescriptor && metadataVersion && portableDescriptor.hubPresetVersion !== metadataVersion) {
    throw new Error("sealed preset metadata contains conflicting preset versions");
  }
  if (portableDescriptor && manifest) {
    const portableManifest: CanonicalSealedManifest = {
      version: portableDescriptor.hubPresetVersion,
      blocks: portableDescriptor.blocks,
    };
    if (!sealedManifestEqual(portableManifest, manifest)) {
      throw new Error("sealed preset metadata contains inconsistent manifests");
    }
  }
  if (manifest && metadataVersion && manifest.version && manifest.version !== metadataVersion) {
    throw new Error("sealed preset metadata contains conflicting preset versions");
  }

  const manifestByKey = new Map<string, string>(
    (portableDescriptor?.blocks ?? manifest?.blocks ?? []).map((block) => [block.key, block.sha256]),
  );
  const declaredManifestKeys = new Set(manifestByKey.keys());
  const redactedKeys = new Set<string>();
  const descriptors: SealedPromptBlockDescriptor[] = [];
  const redactedBlocks = promptOrder.map((rawBlock) => {
    if (!isRecord(rawBlock)) return rawBlock;
    const placeholderKey = readSealedBlockKey(
      extractSealedPlaceholder(rawBlock.content),
      "prompt block placeholder",
    );
    const sealedKey = readSealedBlockKey(rawBlock.sealedKey, "prompt block sealedKey");
    const key = sealedKey ?? placeholderKey;
    const hasMarker = hasSealedBlockMarker(rawBlock)
      || (key !== null && manifestByKey.has(key));
    if (!hasMarker) return rawBlock;
    if (Object.hasOwn(rawBlock, "sealed") && rawBlock.sealed !== true) {
      throw new Error(`sealed preset block ${key ?? "<unknown>"} has an invalid sealed flag`);
    }
    if (Object.hasOwn(rawBlock, "sealedSource") && rawBlock.sealedSource !== "lumihub") {
      throw new Error(`sealed preset block ${key ?? "<unknown>"} has an invalid sealed source`);
    }
    if (
      Object.hasOwn(rawBlock, "sealedOriginPresetId")
      && !readNonEmptyString(rawBlock.sealedOriginPresetId)
    ) {
      throw new Error(`sealed preset block ${key ?? "<unknown>"} has an invalid Hub preset id`);
    }
    if (
      Object.hasOwn(rawBlock, "sealedOriginVersion")
      && !readNonEmptyString(rawBlock.sealedOriginVersion)
    ) {
      throw new Error(`sealed preset block ${key ?? "<unknown>"} has an invalid preset version`);
    }
    if (Object.hasOwn(rawBlock, "sealedSha256") && !readSha256(rawBlock.sealedSha256, `${key ?? "<unknown>"}.sealedSha256`)) {
      throw new Error(`sealed preset block ${key ?? "<unknown>"} has an invalid digest`);
    }
    if (!key) {
      throw new Error("sealed preset block is missing its manifest key");
    }
    if (sealedKey && placeholderKey && sealedKey !== placeholderKey) {
      throw new Error(`sealed preset block ${key} has a conflicting placeholder key`);
    }

    const blockHubPresetId = readNonEmptyString(rawBlock.sealedOriginPresetId);
    const hubPresetId = blockHubPresetId
      ?? portableDescriptor?.hubPresetId
      ?? metadataHubPresetId;
    if (!hubPresetId) {
      throw new Error(`sealed preset block ${key} is missing its Hub preset id`);
    }
    if (blockHubPresetId && metadataHubPresetId && blockHubPresetId !== metadataHubPresetId) {
      throw new Error(`sealed preset block ${key} has a conflicting Hub preset id`);
    }
    if (blockHubPresetId && portableDescriptor && blockHubPresetId !== portableDescriptor.hubPresetId) {
      throw new Error(`sealed preset block ${key} has a conflicting Hub preset id`);
    }

    const blockVersion = readNonEmptyString(rawBlock.sealedOriginVersion);
    const version = blockVersion
      ?? portableDescriptor?.hubPresetVersion
      ?? metadataVersion
      ?? manifest?.version
      ?? null;
    if (!version) {
      throw new Error(`sealed preset block ${key} is missing its preset version`);
    }
    if (blockVersion && metadataVersion && blockVersion !== metadataVersion) {
      throw new Error(`sealed preset block ${key} has a conflicting preset version`);
    }
    if (blockVersion && portableDescriptor && blockVersion !== portableDescriptor.hubPresetVersion) {
      throw new Error(`sealed preset block ${key} has a conflicting preset version`);
    }
    if (manifest && manifest.version && manifest.version !== version) {
      throw new Error(`sealed preset block ${key} has a conflicting manifest version`);
    }

    const blockSha256 = readSha256(rawBlock.sealedSha256, `${key}.sealedSha256`);
    const manifestSha256 = manifestByKey.get(key);
    const sha256 = blockSha256 ?? manifestSha256;
    if (!sha256) {
      throw new Error(`sealed preset block ${key} is missing its manifest digest`);
    }
    if (blockSha256 && manifestSha256 && blockSha256 !== manifestSha256) {
      throw new Error(`sealed preset block ${key} has a conflicting manifest digest`);
    }
    if (redactedKeys.has(key)) {
      throw new Error(`sealed preset contains duplicate prompt block key: ${key}`);
    }
    const descriptor = { key, hubPresetId, version, sha256 };
    descriptors.push(descriptor);
    redactedKeys.add(key);
    manifestByKey.set(key, sha256);

    return {
      ...rawBlock,
      content: `{{presetBlock::${key}}}`,
      sealed: true,
      sealedKey: key,
      sealedSource: "lumihub",
      sealedOriginPresetId: hubPresetId,
      sealedOriginVersion: version,
      sealedSha256: sha256,
    };
  });

  const hasSealedMetadata = candidates.length > 0;
  if (descriptors.length === 0 && !hasSealedMetadata) {
    return raw;
  }
  if (descriptors.length === 0 && !portableDescriptor && !manifest) {
    throw new Error("sealed preset metadata is missing its descriptor");
  }
  if (hasSealedMetadata && manifestByKey.size === 0) {
    if (!portableDescriptor && manifest && manifest.blocks.length === 0 && descriptors.length === 0) {
      return raw;
    }
    throw new Error("sealed preset metadata contains no manifest blocks");
  }

  // A valid descriptor is authoritative even if a block's flags were lost.
  // If it names blocks but none can be identified, fail closed instead of
  // exporting a potentially materialized prompt as an ordinary block.
  if ((portableDescriptor || manifest) && descriptors.length === 0) {
    throw new Error("sealed preset descriptor has no matching prompt blocks");
  }
  const missingDescriptorKeys = [...declaredManifestKeys].filter((key) => !redactedKeys.has(key));
  if (missingDescriptorKeys.length > 0) {
    throw new Error(
      `sealed preset descriptor has unredacted prompt blocks: ${missingDescriptorKeys.join(", ")}`,
    );
  }

  const descriptorHubIds = new Set(descriptors.map((descriptor) => descriptor.hubPresetId));
  if (portableDescriptor) descriptorHubIds.add(portableDescriptor.hubPresetId);
  if (metadataHubPresetId) descriptorHubIds.add(metadataHubPresetId);
  if (descriptorHubIds.size !== 1) {
    throw new Error("sealed preset metadata contains conflicting Hub preset ids");
  }
  const descriptorVersions = new Set(descriptors.map((descriptor) => descriptor.version));
  if (portableDescriptor) descriptorVersions.add(portableDescriptor.hubPresetVersion);
  if (metadataVersion) descriptorVersions.add(metadataVersion);
  if (manifest?.version) descriptorVersions.add(manifest.version);
  if (descriptorVersions.size !== 1) {
    throw new Error("sealed preset metadata contains conflicting preset versions");
  }

  const canonicalHubPresetId = [...descriptorHubIds][0]!;
  const canonicalVersion = [...descriptorVersions][0]!;
  const canonicalBlocks = [...manifestByKey.entries()].map(([key, sha256]) => ({ key, sha256 }));
  if (canonicalBlocks.length === 0) {
    throw new Error("sealed preset metadata contains no manifest blocks");
  }
  const canonicalManifest: CanonicalSealedManifest = {
    version: canonicalVersion,
    blocks: canonicalBlocks,
  };
  const canonicalPortableDescriptor: PortableSealedPresetDescriptor = {
    hubPresetId: canonicalHubPresetId,
    hubPresetVersion: canonicalVersion,
    blocks: canonicalBlocks,
  };

  const canonicalMetadata: Record<string, any> = {
    ...metadata,
    [SEALED_PRESET_ID_METADATA_KEY]: canonicalHubPresetId,
    [SEALED_PRESET_VERSION_METADATA_KEY]: canonicalVersion,
    [SEALED_PRESET_METADATA_KEY]: canonicalManifest,
    [PORTABLE_SEALED_PRESET_METADATA_KEY]: canonicalPortableDescriptor,
  };
  if (Object.hasOwn(canonicalMetadata, "sealedPreset")) {
    canonicalMetadata.sealedPreset = canonicalManifest;
  }
  const compatibility = isRecord(canonicalMetadata.compatibility)
    ? canonicalMetadata.compatibility
    : null;
  const lumiverse = compatibility && isRecord(compatibility.lumiverse)
    ? compatibility.lumiverse
    : null;
  if (lumiverse && Object.hasOwn(lumiverse, "sealedPreset")) {
    canonicalMetadata.compatibility = {
      ...compatibility,
      lumiverse: { ...lumiverse, sealedPreset: canonicalManifest },
    };
  }

  return {
    ...raw,
    prompt_order: JSON.stringify(redactedBlocks),
    metadata: JSON.stringify(canonicalMetadata),
  };
}

function serializePresetRowForExport(raw: Record<string, any>): Record<string, any> {
  let promptOrder: unknown;
  try {
    promptOrder = readJsonColumn(raw.prompt_order, "prompt_order");
  } catch (err) {
    const metadataText = typeof raw.metadata === "string" ? raw.metadata : "";
    const promptOrderText = typeof raw.prompt_order === "string" ? raw.prompt_order : "";
    if (
      !/(?:portableSealedPreset|_lumiverse_sealed_preset|sealedPreset)/i.test(metadataText)
      && !/(?:sealed|lumihub|presetBlock|pblock)/i.test(promptOrderText)
    ) {
      return raw;
    }
    throw err;
  }
  const metadataText = typeof raw.metadata === "string" ? raw.metadata : "";
  const metadata = typeof raw.metadata === "string" ? (() => {
    try {
      return JSON.parse(raw.metadata);
    } catch {
      return null;
    }
  })() : raw.metadata;
  const isOrdinaryLegacyManifest = (value: unknown): boolean =>
    value == null
    || (isRecord(value) && Array.isArray(value.blocks) && value.blocks.length === 0);
  const hasMetadataSealedHint = isRecord(metadata)
    && (
      Object.hasOwn(metadata, PORTABLE_SEALED_PRESET_METADATA_KEY)
      || (Object.hasOwn(metadata, SEALED_PRESET_METADATA_KEY)
        && !isOrdinaryLegacyManifest(metadata[SEALED_PRESET_METADATA_KEY]))
      || (Object.hasOwn(metadata, "sealedPreset")
        && !isOrdinaryLegacyManifest(metadata.sealedPreset))
      || (isRecord(metadata.compatibility)
        && isRecord(metadata.compatibility.lumiverse)
        && Object.hasOwn(metadata.compatibility.lumiverse, "sealedPreset")
        && !isOrdinaryLegacyManifest(metadata.compatibility.lumiverse.sealedPreset))
    );
  const hasTextMetadataSealedHint = !isRecord(metadata)
    && /(?:portableSealedPreset|_lumiverse_sealed_preset|sealedPreset)/i.test(metadataText);
  const hasBlockSealedHint = (Array.isArray(promptOrder)
    && promptOrder.some((block) => isRecord(block) && hasSealedBlockMarker(block)))
    || (isRecord(promptOrder) && hasSealedBlockMarker(promptOrder));
  if (!hasMetadataSealedHint && !hasTextMetadataSealedHint && !hasBlockSealedHint) return raw;
  return canonicalizeSealedPresetRow(raw);
}

function ownerKey(spec: any, row: Record<string, unknown>): string {
  return encodeArchiveOwnerKey(spec, row);
}

function descriptorKey(path: string, ownerTable: string, ownerKeyValue: string): string {
  return `${path}\u0000${ownerTable}\u0000${ownerKeyValue}`;
}

function descriptorMismatch(
  phase: "source_changed_before_snapshot" | "source_changed_during_staging",
  ref: Pick<PendingFileRef, "sourcePath">,
): Error {
  return new Error(`${phase}: ${ref.sourcePath}`);
}
function frozenSourceKey(descriptor: FrozenFileDescriptorV1): string {
  const identity = descriptor.sourceIdentity;
  return [
    descriptor.path,
    descriptor.sourceRoot,
    identity.device,
    identity.inode,
    identity.size,
    identity.mtimeMs,
    identity.ctimeMs,
    identity.birthtimeMs,
    identity.mode,
    descriptor.bytes,
    descriptor.sha256,
  ].join("\u0000");
}

function sourcePathIsAbsent(sourcePath: string, allowedRoot: string): boolean {
  try {
    resolveArchivePathWithinRoot(sourcePath, allowedRoot);
    lstatSync(sourcePath);
    return false;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}
function refRequired(ref: { required?: boolean; onMissing?: string }): boolean {
  return ref.required === true || ref.onMissing === "abort";
}

function refPaths(ref: any, row: Record<string, unknown>): string[] {
  const resolved = typeof ref.resolve === "function" ? ref.resolve(row, env.dataDir) : [];
  const values = Array.isArray(resolved) ? resolved : [resolved];
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}


interface PendingFileRef {
  sourcePath: string;
  archivePath: string;
  required: boolean;
  ownerTable: string;
  allowedRoot: string;
  ownerKey: string;
  maxBytes?: number;
}

type DescriptorBinding = Pick<FrozenFileDescriptorV1, "ownerTable" | "ownerKey" | "path" | "sourceRoot">;
type PendingDescriptorBinding = Pick<PendingFileRef, "sourcePath" | "ownerTable" | "ownerKey" | "allowedRoot">;

function assertFrozenFileDescriptorBinding(
  descriptor: DescriptorBinding,
  ref: PendingDescriptorBinding,
  phase: "source_changed_before_snapshot" | "source_changed_during_staging",
): void {
  if (
    descriptor.ownerTable !== ref.ownerTable
    || descriptor.ownerKey !== ref.ownerKey
    || descriptor.path !== ref.sourcePath
    || descriptor.sourceRoot !== ref.allowedRoot
  ) {
    throw descriptorMismatch(phase, ref);
  }
}

interface StagedArchiveFile {
  descriptor: FrozenFileDescriptorV1;
  stagedPath: string;
  archivePath: string;
  required: boolean;
}

async function collectFileRefs(snapshotDb: any, specs: readonly any[], userId: string, signal?: AbortSignal): Promise<PendingFileRef[]> {
  const refs: PendingFileRef[] = [];
  for (const spec of specs) {
    if (!Array.isArray(spec.fileRefs) || spec.fileRefs.length === 0) continue;
    const built = selectForTable(snapshotDb, spec, userId);
    if (!built) continue;
    const statement = snapshotDb.prepare(built.sql);
    let rows = 0;
    for (const row of statement.iterate(...built.params) as Iterable<Record<string, unknown>>) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted");
      for (const ref of spec.fileRefs) {
        if (typeof ref.applies === "function" && !ref.applies(row)) continue;
        for (const sourcePath of refPaths(ref, row)) {
          const resolution = resolveArchiveSourcePath({
            sourcePath,
            bucket: ref.bucket,
            row,
            dataDir: env.dataDir,
            userId,
          });
          const archivePath = archivePathForRef(ref, row, resolution.path);
          // Multiple canonical rows may intentionally reference one payload.
          // Keep every descriptor binding for snapshot validation; the
          // archive payload is deduplicated after staging.
          if (refs.length >= MAX_ARCHIVE_ENTRIES) {
            throw new Error(`archive contains too many entries (>${MAX_ARCHIVE_ENTRIES})`);
          }
          const maxBytes = strictestMediaLimit(ref.bucket, ref.maxBytes, ref.mediaPolicy);
          if (maxBytes === null) {
            throw new Error(`archive registry has no media limit for ${String(ref.bucket)}`);
          }
          refs.push({
            sourcePath: resolution.path,
            archivePath,
            required: refRequired(ref),
            ownerTable: spec.table,
            allowedRoot: resolution.allowedRoot,
            ownerKey: ownerKey(spec, row),
            maxBytes,
          });
        }
      }
      rows++;
      if (rows % YIELD_INTERVAL_ROWS === 0) await yieldAndCheck(signal);
    }
  }
  return refs;
}
function appendNotificationSoundRefs(
  refs: PendingFileRef[],
  descriptors: readonly FrozenFileDescriptorV1[],
  userId: string,
): void {
  const archiveRefs = new Map<string, PendingFileRef>();
  for (const ref of refs) archiveRefs.set(ref.archivePath, ref);
  const expectedRoot = resolve(env.dataDir, "notification-sounds", userId);
  for (const descriptor of descriptors) {
    if (descriptor.kind !== "notification_sound") continue;
    const archivePath = descriptor.archivePath;
    const validOwner =
      descriptor.ownerTable === "notification_sounds"
      && descriptor.ownerKey === userId
      && descriptor.owner?.table === "notification_sounds"
      && descriptor.owner?.key === userId;
    if (
      !validOwner
      || typeof archivePath !== "string"
      || !/^files\/notification-sounds\/completion\.(?:mp3|wav|ogg|aac|m4a)$/u.test(archivePath)
      || descriptor.sourceRoot !== expectedRoot
    ) {
      throw new Error(`source_changed_before_snapshot: ${descriptor.path}`);
    }
    let sourcePath: string;
    try {
      sourcePath = resolveArchivePathWithinRoot(descriptor.path, expectedRoot);
    } catch {
      throw new Error(`source_changed_before_snapshot: ${descriptor.path}`);
    }
    if (sourcePath !== descriptor.path) {
      throw new Error(`source_changed_before_snapshot: ${descriptor.path}`);
    }
    const existing = archiveRefs.get(archivePath);
    if (existing) {
      if (
        existing.sourcePath !== descriptor.path
        || existing.ownerTable !== descriptor.ownerTable
        || existing.ownerKey !== descriptor.ownerKey
      ) {
        throw new Error(`duplicate archive entry: ${archivePath}`);
      }
      continue;
    }
    const ref: PendingFileRef = {
      sourcePath: descriptor.path,
      archivePath,
      required: descriptor.required,
      ownerTable: descriptor.ownerTable,
      allowedRoot: descriptor.sourceRoot,
      ownerKey: descriptor.ownerKey,
      maxBytes: strictestMediaLimit("notification-sounds", undefined, "notification_audio") ?? MAX_ARCHIVE_FILE_BYTES,
    };
    if (refs.length >= MAX_ARCHIVE_ENTRIES) {
      throw new Error(`archive contains too many entries (>${MAX_ARCHIVE_ENTRIES})`);
    }
    refs.push(ref);
  }
}
interface ArchiveStagingLimitsV1 {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}



async function stageArchiveFiles(
  snapshot: any,
  refs: readonly PendingFileRef[],
  stagingDir: string,
  missingFiles: string[],
  missingOptionalFiles: string[],
  signal?: AbortSignal,
  limits?: ArchiveStagingLimitsV1,
): Promise<StagedArchiveFile[]> {
  const descriptors = new Map<string, FrozenFileDescriptorV1>();
  const descriptorPaths = new Set<string>();
  for (const descriptor of (snapshot.files ?? []) as FrozenFileDescriptorV1[]) {
    if (typeof descriptor.path !== "string") continue;
    descriptorPaths.add(descriptor.path);
    descriptors.set(descriptorKey(descriptor.path, descriptor.ownerTable, descriptor.ownerKey), descriptor);
  }
  const staged: StagedArchiveFile[] = [];
  const missingPaths = new Set<string>();
  const stagedBySource = new Map<string, StagedArchiveFile>();
  const maxStagedFiles = Math.min(MAX_ARCHIVE_ENTRIES, limits?.maxFiles ?? MAX_ARCHIVE_ENTRIES);
  const maxStagedBytes = Math.min(MAX_ARCHIVE_TOTAL_BYTES, limits?.maxBytes ?? MAX_ARCHIVE_TOTAL_BYTES);
  if (
    !Number.isSafeInteger(maxStagedFiles)
    || maxStagedFiles < 0
    || !Number.isSafeInteger(maxStagedBytes)
    || maxStagedBytes < 0
  ) {
    throw new RangeError("archive staging limits must be non-negative safe integers");
  }
  let stagedFileCount = 0;
  let stagedFileBytes = 0;
  try {
    for (const ref of refs) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const sourcePath = resolveArchivePathWithinRoot(ref.sourcePath, ref.allowedRoot);
      const descriptor = descriptors.get(descriptorKey(sourcePath, ref.ownerTable, ref.ownerKey));
      if (!descriptor) {
        if (descriptorPaths.has(sourcePath) || !sourcePathIsAbsent(sourcePath, ref.allowedRoot)) {
          throw descriptorMismatch("source_changed_before_snapshot", ref);
        }
        if (ref.required) throw new Error(`required export file is missing from snapshot: ${sourcePath}`);
        if (missingPaths.add(ref.archivePath)) {
          missingFiles.push(ref.archivePath);
          missingOptionalFiles.push(ref.archivePath);
        }
        continue;
      }
      assertFrozenFileDescriptorBinding(descriptor, { ...ref, sourcePath }, "source_changed_before_snapshot");
      const refMaxBytes = ref.maxBytes ?? MAX_ARCHIVE_FILE_BYTES;
      if (!Number.isSafeInteger(refMaxBytes) || refMaxBytes < 0) {
        throw new Error(`invalid archive file limit for ${ref.archivePath}`);
      }
      if (descriptor.bytes > refMaxBytes) {
        throw new Error(`archive file exceeds its reference limit: ${ref.archivePath}`);
      }
      const sourceKey = frozenSourceKey(descriptor);
      const prior = stagedBySource.get(sourceKey);
      if (prior) {
        if (
          !existsSync(prior.stagedPath)
          || prior.descriptor.bytes !== descriptor.bytes
          || prior.descriptor.sha256 !== descriptor.sha256
          || !fileIdentityEquals(prior.descriptor.sourceIdentity, descriptor.sourceIdentity)
        ) {
          throw descriptorMismatch("source_changed_during_staging", ref);
        }
        staged.push({ descriptor, stagedPath: prior.stagedPath, archivePath: ref.archivePath, required: ref.required });
        continue;
      }
      if (stagedFileCount >= maxStagedFiles) {
        throw new Error(`archive contains too many staged files (>${maxStagedFiles})`);
      }
      if (descriptor.bytes > maxStagedBytes - stagedFileBytes) {
        throw new Error(`staged archive files exceed ${maxStagedBytes} bytes`);
      }
      let stagedResult: StagedFrozenFileV1;
      try {
        stagedResult = await stageFrozenFile(descriptor, stagingDir, { signal, maxBytes: refMaxBytes });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        throw new Error(`source_changed_during_staging: ${ref.sourcePath}`, { cause: error });
      }
      const stagedDescriptor = stagedResult.descriptor;
      assertFrozenFileDescriptorBinding(stagedDescriptor, { ...ref, sourcePath }, "source_changed_during_staging");
      if (
        stagedResult.bytes !== descriptor.bytes
        || stagedResult.sha256 !== descriptor.sha256
        || !fileIdentityEquals(stagedResult.sourceIdentity, descriptor.sourceIdentity)
      ) {
        throw descriptorMismatch("source_changed_during_staging", ref);
      }
      const stagedPath = stagedResult.stagedPath;
      if (!stagedPath || !existsSync(stagedPath)) {
        throw descriptorMismatch("source_changed_during_staging", ref);
      }
      if (stagedResult.bytes > maxStagedBytes - stagedFileBytes) {
        throw new Error(`staged archive files exceed ${maxStagedBytes} bytes`);
      }
      const stagedFile: StagedArchiveFile = {
        descriptor: stagedDescriptor,
        stagedPath,
        archivePath: ref.archivePath,
        required: ref.required,
      };
      stagedBySource.set(sourceKey, stagedFile);
      stagedFileCount++;
      stagedFileBytes += stagedResult.bytes;
      staged.push(stagedFile);
    }
    return staged;
  } catch (error) {
    await cleanupFrozenStaging(stagingDir).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Authenticated ZIP entries
// ---------------------------------------------------------------------------

interface EntryWriter {
  write(value: Record<string, unknown>): Promise<void>;
  close(): Promise<ArchiveEntry>;
  abort(): void;
}

class EntryLedger {
  readonly entries: ArchiveEntry[] = [];
  private readonly names = new Set<string>();
  private totalBytes = 0;
  private textEntries = 0;

  get bytes(): number {
    return this.totalBytes;
  }

  canFit(additionalBytes: number): boolean {
    return Number.isSafeInteger(additionalBytes)
      && additionalBytes >= 0
      && this.totalBytes <= MAX_ARCHIVE_TOTAL_BYTES - additionalBytes;
  }
  get textCount(): number {
    return this.textEntries;
  }

  reserve(path: string): void {
    if (!path || path === "manifest.json" || this.names.has(path)) throw new Error(`duplicate archive entry: ${path}`);
    if (this.names.size >= MAX_ARCHIVE_ENTRIES) {
      throw new Error(`archive contains too many entries (>${MAX_ARCHIVE_ENTRIES})`);
    }
    this.names.add(path);
  }

  add(entry: ArchiveEntry): void {
    if (!this.names.has(entry.path)) throw new Error(`archive entry was not reserved: ${entry.path}`);
    if (entry.kind !== "file" && this.textEntries >= MAX_ARCHIVE_TEXT_ENTRIES) {
      throw new Error(`archive contains too many text entries (>${MAX_ARCHIVE_TEXT_ENTRIES})`);
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || this.totalBytes > MAX_ARCHIVE_TOTAL_BYTES - entry.bytes) {
      throw new Error(`archive exceeds decompressed size cap (${MAX_ARCHIVE_TOTAL_BYTES} bytes)`);
    }
    this.entries.push(entry);
    this.totalBytes += entry.bytes;
    if (entry.kind !== "file") this.textEntries++;
  }
}

function openNdjsonEntry(
  archive: ZipArchive,
  ledger: EntryLedger,
  archivePath: string,
  kind: ArchiveEntry["kind"],
  required: boolean,
  sourceIdentity?: string | ArchiveSourceIdentity,
): EntryWriter {
  ledger.reserve(archivePath);
  const stream = new PassThrough({ highWaterMark: NDJSON_FLUSH_BYTES });
  archive.append(stream, { name: archivePath, store: kind !== "database" });
  const encoder = new TextEncoder();
  const hash = createHash("sha256");
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let rowCount = 0;
  let byteCount = 0;
  let closed = false;

  const waitForDrain = (): Promise<void> => new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanup = (): void => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const onDrain = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error(`archive entry closed before draining: ${archivePath}`));
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
  });

  const flush = async (final: boolean): Promise<void> => {
    if (pendingBytes === 0) {
      if (final) stream.end();
      return;
    }
    const chunk = pending.length === 1
      ? pending[0]
      : (() => {
          const combined = new Uint8Array(pendingBytes);
          let offset = 0;
          for (const part of pending) {
            combined.set(part, offset);
            offset += part.byteLength;
          }
          return combined;
        })();
    pending.length = 0;
    pendingBytes = 0;
    if (!stream.write(chunk)) await waitForDrain();
    if (final) stream.end();
  };

  return {
    async write(value) {
      if (closed) throw new Error(`archive entry already closed: ${archivePath}`);
      const json = JSON.stringify(value);
      const recordBytes = Buffer.byteLength(json, "utf8");
      if (recordBytes > NDJSON_MAX_RECORD_BYTES) {
        throw new Error(
          `NDJSON record in ${archivePath} is ${recordBytes} bytes; ` +
            `the portable archive limit is ${NDJSON_MAX_RECORD_BYTES} bytes`,
        );
      }
      const bytes = encoder.encode(`${json}\n`);
      if (byteCount > MAX_ARCHIVE_FILE_BYTES - bytes.byteLength) {
        throw new Error(`${archivePath} exceeds ${MAX_ARCHIVE_FILE_BYTES} bytes`);
      }
      if (!ledger.canFit(byteCount + bytes.byteLength)) {
        throw new Error(`archive exceeds decompressed size cap (${MAX_ARCHIVE_TOTAL_BYTES} bytes)`);
      }
      hash.update(bytes);
      byteCount += bytes.byteLength;
      pending.push(bytes);
      pendingBytes += bytes.byteLength;
      rowCount++;
      if (pendingBytes >= NDJSON_FLUSH_BYTES) await flush(false);
    },
    async close() {
      if (closed) throw new Error(`archive entry already closed: ${archivePath}`);
      closed = true;
      await flush(true);
      const entry: ArchiveEntry = {
        path: archivePath,
        kind,
        required,
        bytes: byteCount,
        sha256: hash.digest("hex"),
        ...(kind === "database" || kind === "secret" || kind === "vector" ? { rowCount } : {}),
        ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
      };
      ledger.add(entry);
      return entry;
    },
    abort() {
      if (closed) return;
      closed = true;
      pending.length = 0;
      pendingBytes = 0;
      // End the source so Archiver's internal stream observes completion;
      // destroying only this PassThrough can leave an appended entry open.
      stream.end();
    },
  };
}

async function streamStagedFile(
  archive: ZipArchive,
  ledger: EntryLedger,
  file: StagedArchiveFile,
  signal?: AbortSignal,
): Promise<ArchiveEntry> {
  if (
    !Number.isSafeInteger(file.descriptor.bytes)
    || file.descriptor.bytes < 0
    || file.descriptor.bytes > MAX_ARCHIVE_FILE_BYTES
  ) {
    throw new Error(`${file.archivePath} exceeds ${MAX_ARCHIVE_FILE_BYTES} bytes`);
  }
  ledger.reserve(file.archivePath);
  if (!ledger.canFit(file.descriptor.bytes)) {
    throw new Error(`archive exceeds decompressed size cap (${MAX_ARCHIVE_TOTAL_BYTES} bytes)`);
  }
  const output = new PassThrough({ highWaterMark: BINARY_HIGH_WATER_MARK });
  archive.append(output, { name: file.archivePath, store: true });
  const hash = createHash("sha256");
  const waitForDrain = (): Promise<void> => new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanup = (): void => {
      output.off("drain", onDrain);
      output.off("error", onError);
      output.off("close", onClose);
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const onDrain = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error(`archive file closed before draining: ${file.archivePath}`));
    output.once("drain", onDrain);
    output.once("error", onError);
    output.once("close", onClose);
  });
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(file.stagedPath, { highWaterMark: BINARY_HIGH_WATER_MARK })) {
      if (chunk === undefined || chunk === null) {
        throw new Error(`staged file stream ended without a chunk: ${file.archivePath}`);
      }
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted");
      const value = typeof chunk === "string"
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
          ? chunk
          : Buffer.from(chunk);
      if (bytes > MAX_ARCHIVE_FILE_BYTES - value.byteLength) {
        throw new Error(`${file.archivePath} exceeds ${MAX_ARCHIVE_FILE_BYTES} bytes`);
      }
      hash.update(value);
      bytes += value.byteLength;
      if (!output.write(value)) await waitForDrain();
    }
    output.end();
  } catch (error) {
    output.destroy(error as Error);
    throw error;
  }
  const sha256 = hash.digest("hex");
  if (bytes !== file.descriptor.bytes || sha256 !== file.descriptor.sha256) {
    throw new Error(`staged file identity changed: ${file.archivePath}`);
  }
  const entry: ArchiveEntry = {
    path: file.archivePath,
    kind: "file",
    required: file.required,
    bytes,
    sha256,
    sourceIdentity: file.descriptor.sourceIdentity as ArchiveSourceIdentity,
  };
  ledger.add(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

let encryptionKeyPromise: Promise<CryptoKey> | null = null;
async function sourceEncryptionKey(): Promise<CryptoKey> {
  if (!encryptionKeyPromise) {
    const raw = getEncryptionKeyBytes();
    encryptionKeyPromise = crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["decrypt"]);
  }
  return encryptionKeyPromise;
}

async function decryptSourceSecret(row: Record<string, unknown>): Promise<string> {
  const key = await sourceEncryptionKey();
  const encrypted = new Uint8Array(Buffer.from(String(row.encrypted_value), "base64"));
  const iv = new Uint8Array(Buffer.from(String(row.iv), "base64"));
  const tag = new Uint8Array(Buffer.from(String(row.tag), "base64"));
  const combined = new Uint8Array(encrypted.byteLength + tag.byteLength);
  combined.set(encrypted);
  combined.set(tag, encrypted.byteLength);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
  return new TextDecoder().decode(plain);
}

async function exportSecrets(
  snapshotDb: any,
  archive: ZipArchive,
  ledger: EntryLedger,
  opts: ExportOptions,
  signal?: AbortSignal,
): Promise<{ exported: number }> {
  if (!opts.secrets) return { exported: 0 };
  const context = opts.secrets;
  const selectedKeys = [...context.secretKeys];
  const seenKeys = new Set<string>();
  for (const key of selectedKeys) {
    if (typeof key !== "string" || key.length === 0 || seenKeys.has(key)) {
      throw new Error(`invalid or duplicate selected secret key: ${String(key)}`);
    }
    seenKeys.add(key);
  }
  if (selectedKeys.length > MAX_ARCHIVE_SECRET_ENTRIES) {
    throw new Error(`secret payload exceeds cap (${MAX_ARCHIVE_SECRET_ENTRIES} entries)`);
  }
  let secretBytes = 0;

  // Stream the encrypted rows first. The index is appended only after every
  // selected key has been found, decrypted, and re-encrypted successfully, so
  // an emitted index can never advertise rows that were skipped.
  let blob: EntryWriter | null = null;
  let index: EntryWriter | null = null;
  try {
    blob = openNdjsonEntry(archive, ledger, "secrets/encrypted.ndjson", "secret", true);
    const exportedKeys: string[] = [];
    const getRow = snapshotDb.prepare("SELECT encrypted_value, iv, tag FROM secrets WHERE key = ? AND user_id = ?");
    for (const key of selectedKeys) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const row = getRow.get(key, opts.userId) as Record<string, unknown> | null;
      if (!row) throw new Error(`selected secret is missing from snapshot: ${key}`);
      let plaintext: string;
      try {
        plaintext = await decryptSourceSecret(row);
      } catch (error) {
        throw new Error(`selected secret cannot be decrypted: ${key}`, { cause: error });
      }
      const encrypted = await encryptSecret(context.smk, key, plaintext);
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const payload = {
        key: encrypted.key,
        iv: encrypted.iv,
        tag: encrypted.tag,
        ciphertext: encrypted.ciphertext,
      };
      const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      if (secretBytes > MAX_ARCHIVE_SECRET_BYTES - payloadBytes) {
        throw new Error(`secret payload exceeds cap (${MAX_ARCHIVE_SECRET_BYTES} bytes)`);
      }
      await blob.write(payload);
      secretBytes += payloadBytes;
      exportedKeys.push(key);
    }
    await blob.close();

    index = openNdjsonEntry(archive, ledger, "secrets/index.json", "secret", true);
    const indexPayload = { version: 1, archiveId: opts.archiveId, keys: exportedKeys };
    if (Buffer.byteLength(JSON.stringify(indexPayload), "utf8") > MAX_ARCHIVE_SECRET_BYTES) {
      throw new Error(`secret index exceeds cap (${MAX_ARCHIVE_SECRET_BYTES} bytes)`);
    }
    await index.write(indexPayload);
    await index.close();
    return { exported: exportedKeys.length };
  } catch (error) {
    blob?.abort();
    index?.abort();
    throw error;
  }
}
function assertSnapshotSecretSelection(snapshotDb: any, userId: string, selectedKeys: readonly string[]): void {
  const rows = snapshotDb
    .query("SELECT key FROM secrets WHERE user_id = ? ORDER BY key")
    .all(userId) as Array<{ key?: unknown }>;
  const actual = rows.map((row) => row.key).filter((key): key is string => typeof key === "string");
  const expected = [...selectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("secret set changed between export preparation and snapshot");
  }
}

function snapshotPrivateDataFingerprint(snapshotDb: any, userId: string): string {
  const settingRow = snapshotDb
    .query("SELECT value FROM settings WHERE key = 'imageGeneration' AND user_id = ?")
    .get(userId) as { value?: unknown } | null;
  let imageGenerationSetting: unknown = undefined;
  if (settingRow) {
    if (typeof settingRow.value !== "string") {
      throw new Error("imageGeneration settings value is not JSON text");
    }
    try {
      imageGenerationSetting = JSON.parse(settingRow.value);
    } catch {
      throw new Error("imageGeneration settings value is malformed JSON");
    }
  }
  const inventory = snapshotDb
    .query(
      "SELECT key, encrypted_value, iv, tag, updated_at FROM secrets WHERE user_id = ? ORDER BY key",
    )
    .all(userId) as PrivateDataSecretInventoryEntry[];
  return fingerprintPrivateDataAndSecretInventory(imageGenerationSetting, inventory);
}

const LANCEDB_DUMP_TABLES = getArchiveVectorTables();

// ---------------------------------------------------------------------------
const VECTOR_MAX_DIMENSION = 16_384;
const VECTOR_SOURCE_TYPES = new Set([
  "chat_chunk",
  "world_book_entry",
  "vault_chunk",
  "databank",
  "memory_consolidation",
  "memory_vector",
]);

interface StableVectorSnapshot {
  readonly rows: VectorRow[];
  readonly digest: string;
  readonly bytes: number;
}

interface VectorProjectionProof {
  readonly sourceDigest: string;
  readonly projection: UserDataProjectionStampV1;
}

interface StagedVectorDump {
  readonly table: CollectionName;
  readonly stagedPath: string;
  readonly rows: number;
  readonly bytes: number;
  readonly sha256: string;
}

function normalizeVectorRow(row: unknown, userId: string, expectedDimension: number | null): VectorRow | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const value = row as Record<string, unknown>;
  const id = value.id;
  const user_id = value.user_id;
  const source_type = value.source_type;
  const source_id = value.source_id;
  const owner_id = value.owner_id;
  const chunk_index = value.chunk_index;
  const content = value.content;
  const metadata_json = value.metadata_json;
  const updated_at = value.updated_at;
  if (
    typeof id !== "string"
    || typeof user_id !== "string"
    || user_id !== userId
    || typeof source_type !== "string"
    || !VECTOR_SOURCE_TYPES.has(source_type)
    || typeof source_id !== "string"
    || source_id.length === 0
    || typeof owner_id !== "string"
    || owner_id.length === 0
    || !Number.isSafeInteger(chunk_index)
    || Number(chunk_index) < 0
    || typeof content !== "string"
    || content.length === 0
    || typeof metadata_json !== "string"
    || metadata_json.length === 0
    || !Number.isSafeInteger(updated_at)
    || Number(updated_at) < 0
    || !Array.isArray(value.vector)
    || value.vector.length === 0
    || value.vector.length > VECTOR_MAX_DIMENSION
  ) {
    return null;
  }
  const vector = value.vector.map((entry) => typeof entry === "number" && Number.isFinite(entry) ? entry : Number.NaN);
  if (vector.some((entry) => !Number.isFinite(entry))) return null;
  if (expectedDimension !== null && vector.length !== expectedDimension) return null;
  try {
    const metadata = JSON.parse(metadata_json) as unknown;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  } catch {
    return null;
  }
  const expectedId = `${userId}:${source_type}:${source_id}:${chunk_index}`;
  if (id !== expectedId) return null;
  const normalized: VectorRow = {
    id,
    user_id,
    source_type,
    source_id,
    owner_id,
    chunk_index: Number(chunk_index),
    content,
    vector,
    metadata_json,
    updated_at: Number(updated_at),
  };
  const recordBytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  if (!Number.isSafeInteger(recordBytes) || recordBytes > NDJSON_MAX_RECORD_BYTES) return null;
  return normalized;
}

function digestVectorRows(rows: VectorRow[]): { digest: string; bytes: number } | null {
  rows.sort((left, right) => left.id.localeCompare(right.id));
  for (let index = 1; index < rows.length; index++) {
    if (rows[index - 1]!.id === rows[index]!.id) return null;
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for (const row of rows) {
    const line = `${JSON.stringify(row)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (!Number.isSafeInteger(lineBytes) || lineBytes > NDJSON_MAX_RECORD_BYTES || bytes > MAX_ARCHIVE_FILE_BYTES - lineBytes) {
      return null;
    }
    hash.update(line, "utf8");
    bytes += lineBytes;
  }
  return { digest: hash.digest("hex"), bytes };
}

async function readStableVectorSnapshot(
  store: VectorStore,
  table: CollectionName,
  userId: string,
  expectedDimension: number | null,
  signal?: AbortSignal,
): Promise<StableVectorSnapshot | null> {
  const filter = { op: "eq", field: "user_id", value: userId } as const;
  const readOnce = async (): Promise<StableVectorSnapshot | null> => {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const count = await store.countRows(table, filter);
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_ARCHIVE_ROWS_PER_TABLE) return null;
    const rawRows = await store.getRowsByFilter(table, filter, count + 1);
    if (rawRows.length !== count || rawRows.length > MAX_ARCHIVE_ROWS_PER_TABLE) return null;
    const rows: VectorRow[] = [];
    for (const rawRow of rawRows) {
      const row = normalizeVectorRow(rawRow, userId, expectedDimension);
      if (!row) return null;
      rows.push(row);
    }
    const digest = digestVectorRows(rows);
    if (!digest) return null;
    return { rows, digest: digest.digest, bytes: digest.bytes };
  };
  try {
    const first = await readOnce();
    if (!first) return null;
    const second = await readOnce();
    if (!second || second.rows.length !== first.rows.length || second.digest !== first.digest || second.bytes !== first.bytes) {
      return null;
    }
    return first;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return null;
  }
}

function waitForVectorDrain(stream: WriteStream): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const onDrain = (): void => {
      stream.off("error", onError);
      resolvePromise();
    };
    const onError = (error: Error): void => {
      stream.off("drain", onDrain);
      rejectPromise(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

function waitForVectorFinish(stream: WriteStream): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const onFinish = (): void => {
      stream.off("error", onError);
      resolvePromise();
    };
    const onError = (error: Error): void => {
      stream.off("finish", onFinish);
      rejectPromise(error);
    };
    stream.once("finish", onFinish);
    stream.once("error", onError);
  });
}

async function stageVectorSnapshot(
  snapshot: StableVectorSnapshot,
  table: CollectionName,
  stagingDir: string,
  signal?: AbortSignal,
): Promise<StagedVectorDump> {
  const vectorDir = join(stagingDir, "vectors");
  mkdirSync(vectorDir, { recursive: true });
  const stagedPath = join(vectorDir, `${table}.ndjson`);
  const output = createWriteStream(stagedPath, { flags: "wx", mode: 0o600 });
  try {
    let bytes = 0;
    for (const row of snapshot.rows) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const line = Buffer.from(`${JSON.stringify(row)}\n`, "utf8");
      if (bytes > MAX_ARCHIVE_FILE_BYTES - line.byteLength) {
        throw new Error(`lancedb/${table}.ndjson exceeds ${MAX_ARCHIVE_FILE_BYTES} bytes`);
      }
      bytes += line.byteLength;
      if (!output.write(line)) await waitForVectorDrain(output);
    }
    output.end();
    await waitForVectorFinish(output);
    if (bytes !== snapshot.bytes) throw new Error(`lancedb/${table}.ndjson changed while staging`);
    return { table, stagedPath, rows: snapshot.rows.length, bytes, sha256: snapshot.digest };
  } catch (error) {
    output.destroy();
    rmSync(stagedPath, { force: true });
    throw error;
  }
}

function removeStagedVectorDumps(staged: readonly StagedVectorDump[]): void {
  for (const entry of staged) rmSync(entry.stagedPath, { force: true });
}

async function exportLancedbVectors(
  userId: string,
  archive: ZipArchive,
  ledger: EntryLedger,
  embeddingIdentity: ArchiveEmbeddingIdentity,
  proof: VectorProjectionProof,
  stagingDir: string,
  signal?: AbortSignal,
  onProgress?: (table: string, count: number) => void,
): Promise<{
  counts: Record<string, number>;
  status: "included" | "rebuild_required";
  identityRevision?: string;
  vectorSourceDigest?: string;
  vectorProjectionEpoch?: number;
}> {
  const rebuild = (): { counts: Record<string, number>; status: "rebuild_required" } => ({ counts: {}, status: "rebuild_required" });
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const proofMatches = (stamp: UserDataProjectionStampV1): boolean =>
    stamp.sourceEpoch === proof.projection.sourceEpoch
    && stamp.projectedSourceEpoch === proof.projection.sourceEpoch
    && stamp.projectedSourceDigest === proof.sourceDigest;
  if (!proofMatches(userDataSnapshotBarrier.getProjectionStamp(userId))) return rebuild();
  if (
    embeddingIdentity.provider === null
    || embeddingIdentity.model === null
    || embeddingIdentity.dimension === null
    || !Number.isSafeInteger(embeddingIdentity.dimension)
    || embeddingIdentity.dimension <= 0
  ) {
    return rebuild();
  }
  let store: VectorStore;
  try {
    store = await getActiveVectorStore();
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return rebuild();
  }
  if (store.id !== "lancedb") return rebuild();
  const staged: StagedVectorDump[] = [];
  try {
    let totalRows = 0;
    let totalBytes = 0;
    for (const rawTable of LANCEDB_DUMP_TABLES) {
      if (rawTable !== "embeddings" && rawTable !== "embeddings_world_books") {
        removeStagedVectorDumps(staged);
        return rebuild();
      }
      const table = rawTable as CollectionName;
      const snapshot = await readStableVectorSnapshot(store, table, userId, embeddingIdentity.dimension, signal);
      if (!snapshot) {
        removeStagedVectorDumps(staged);
        return rebuild();
      }
      totalRows += snapshot.rows.length;
      totalBytes += snapshot.bytes;
      if (totalRows > MAX_ARCHIVE_TOTAL_ROWS || totalBytes > MAX_ARCHIVE_TOTAL_BYTES) {
        removeStagedVectorDumps(staged);
        return rebuild();
      }
      staged.push(await stageVectorSnapshot(snapshot, table, stagingDir, signal));
    }
    if (!proofMatches(userDataSnapshotBarrier.getProjectionStamp(userId))) {
      removeStagedVectorDumps(staged);
      return rebuild();
    }
    const identityHash = createHash("sha256");
    identityHash.update(embeddingIdentity.revision ?? "");
    identityHash.update(`\u0000source\u0000${proof.sourceDigest}\u0000${proof.projection.sourceEpoch}`);
    for (const entry of staged) identityHash.update(`\u0000${entry.table}\u0000${entry.sha256}\u0000${entry.rows}`);
    for (const entry of staged) {
      const archivePath = `lancedb/${entry.table}.ndjson`;
      if (!ledger.canFit(entry.bytes)) {
        removeStagedVectorDumps(staged);
        return rebuild();
      }
      ledger.reserve(archivePath);
      archive.append(createReadStream(entry.stagedPath, { highWaterMark: BINARY_HIGH_WATER_MARK }), { name: archivePath, store: true });
      ledger.add({
        path: archivePath,
        kind: "vector",
        required: false,
        bytes: entry.bytes,
        sha256: entry.sha256,
        rowCount: entry.rows,
      });
      onProgress?.(entry.table, entry.rows);
    }
    return {
      counts: Object.fromEntries(staged.map((entry) => [entry.table, entry.rows])),
      status: "included",
      identityRevision: identityHash.digest("hex"),
      vectorSourceDigest: proof.sourceDigest,
      vectorProjectionEpoch: proof.projection.sourceEpoch,
    };
  } catch (error) {
    removeStagedVectorDumps(staged);
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    return rebuild();
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function runExport(
  opts: ExportOptions,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
  const { userId, includeVectors, signal } = opts;
  const archiveId = opts.archiveId || crypto.randomUUID();
  const missingFiles: string[] = [];
  const missingOptionalFiles: string[] = [];
  const counts: Record<string, number> = {};
  let totalRows = 0;
  const byteCounts: Record<string, number> = {};
  const ledger = new EntryLedger();
  const staging = createExportStagingLease(archiveId);
  const stagingDir = staging.path;
  let snapshot: any = null;
  let compressedBytes = 0;
  let stagedFiles: StagedArchiveFile[] = [];
  let fatalErr: unknown = null;
  let archive: ZipArchive | null = null;
  let stagingLease = staging.lease;
  let stagingLeaseFailure: Error | null = null;
  const stagingLeaseTimer = setInterval(() => {
    try {
      stagingLease = refreshExportStagingLease(stagingDir, stagingLease);
    } catch (error) {
      stagingLeaseFailure = error instanceof Error ? error : new Error(String(error));
      fatalErr ??= stagingLeaseFailure;
      try { controller.error(stagingLeaseFailure); } catch { /* already errored */ }
      try { archive?.abort?.(); } catch { /* already aborted */ }
    }
  }, EXPORT_STAGING_HEARTBEAT_MS);
  const assertStagingLease = (): void => {
    if (stagingLeaseFailure) throw stagingLeaseFailure;
  };

  try {
    const specs = canonicalSpecs();
    // `withExclusive` ends before streaming, but after every source file has
    // been staged. The snapshot/transaction itself stays open below.
    await userDataSnapshotBarrier.withExclusive(userId, async () => {
      snapshot = await openUserDataReadSnapshot(userId);
      if (opts.secrets) {
        assertSnapshotSecretSelection(snapshot.db, userId, opts.secrets.secretKeys);
        const actualFingerprint = snapshotPrivateDataFingerprint(snapshot.db, userId);
        if (actualFingerprint !== opts.secrets.privateDataFingerprint) {
          throw new Error("private data changed between export preparation and snapshot");
        }
      }
      const pending = await collectFileRefs(snapshot.db, specs, userId, signal);
      // Notification sounds are the sole descriptor-only class. All other
      // descriptors must be reached through a canonical registry file ref.
      appendNotificationSoundRefs(pending, snapshot.files ?? [], userId);
      stagedFiles = await stageArchiveFiles(snapshot, pending, stagingDir, missingFiles, missingOptionalFiles, signal);
    }, signal);
    assertStagingLease();

    if (!snapshot?.db) throw new Error("user-data read snapshot did not expose a database");
    const embeddingConfig = readEmbeddingConfig(snapshot.db, userId);
    let embeddingIdentity: ArchiveEmbeddingIdentity = {
      ...embeddingConfig,
      revision: createHash("sha256")
        .update(JSON.stringify(embeddingConfig))
        .digest("hex"),
    };

    archive = new ZipArchive({ zlib: { level: NDJSON_COMPRESSION }, forceZip64: true });
    archive.on("warning", (error: ArchiverError) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      fatalErr = error;
      try {
        controller.error(error);
      } catch {
        /* already errored */
      }
    });
    archive.on("error", (error: ArchiverError) => {
      fatalErr = error;
      try {
        controller.error(error);
      } catch {
        /* already errored */
      }
    });
    const sink = makeControllerSink(controller, signal, (bytes) => {
      if (compressedBytes > MAX_ARCHIVE_COMPRESSED_BYTES - bytes) {
        throw new Error(`archive exceeds compressed size cap (${MAX_ARCHIVE_COMPRESSED_BYTES} bytes)`);
      }
      compressedBytes += bytes;
    });
    sink.on("error", (error: Error) => {
      fatalErr ??= error;
      try {
        controller.error(error);
      } catch {
        /* already errored */
      }
      try {
        archive?.abort?.();
      } catch {
        /* already aborted */
      }
    });
    archive.pipe(sink);
    emitProgress(userId, { phase: "start", archiveId, includeVectors });

    for (const spec of specs) {
      const table = specTable(spec);
      const built = selectForTable(snapshot.db, spec, userId);
      if (!built) continue;
      const entry = openNdjsonEntry(archive, ledger, `database/${table}.ndjson`, "database", true);
      const statement = snapshot.db.prepare(built.sql);
      let rowsOut = 0;
      emitProgress(userId, { phase: "table_start", table });
      for (const raw of statement.iterate(...built.params) as Iterable<Record<string, unknown>>) {
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        if (table === "settings" && isSecretSettingKey(String(raw.key ?? ""))) continue;
        let exportRow: Record<string, unknown> = raw;
        if (table === "presets") {
          const serialized = serializePresetRowForExport(raw);
          exportRow = Object.hasOwn(serialized, "metadata")
            ? { ...serialized, metadata: scrubPresetMetadataForExport(serialized.metadata) }
            : serialized;
        }
        if (rowsOut >= MAX_ARCHIVE_ROWS_PER_TABLE || totalRows >= MAX_ARCHIVE_TOTAL_ROWS) {
          throw new Error(`archive row count exceeds cap: ${table}`);
        }
        const scrubbedRow = scrubRow(exportRow, spec.scrubColumns);
        const portableRow = table === "settings"
          ? scrubLegacyImageGenerationSettingRow(scrubbedRow)
          : scrubbedRow;
        await entry.write(scrubArchiveRowPrivateData(portableRow));
        rowsOut++;
        totalRows++;
        if (rowsOut % YIELD_INTERVAL_ROWS === 0) await yieldAndCheck(signal);
      }
      assertStagingLease();
      const metadata = await entry.close();
      counts[table] = rowsOut;
      byteCounts[metadata.path] = metadata.bytes;
      emitProgress(userId, { phase: "table_done", table, processed: rowsOut });
    }

    const sortedStagedFiles = stagedFiles.slice().sort((a, b) => a.archivePath < b.archivePath ? -1 : a.archivePath > b.archivePath ? 1 : 0);
    const files: StagedArchiveFile[] = [];
    const fileAliases: ArchiveFileAlias[] = [];
    const payloadByDigest = new Map<string, StagedArchiveFile>();
    const archivePathFiles = new Map<string, StagedArchiveFile>();
    const archivePathDigests = new Map<string, string>();
    for (const file of sortedStagedFiles) {
      const digestKey = `${file.descriptor.bytes}:${file.descriptor.sha256}`;
      const priorDigest = archivePathDigests.get(file.archivePath);
      if (priorDigest !== undefined) {
        if (priorDigest !== digestKey) throw new Error(`duplicate archive entry changed bytes: ${file.archivePath}`);
        const priorFile = archivePathFiles.get(file.archivePath);
        if (priorFile && priorFile.required !== file.required) {
          throw new Error(`duplicate archive entry changed requiredness: ${file.archivePath}`);
        }
        continue;
      }
      archivePathDigests.set(file.archivePath, digestKey);
      archivePathFiles.set(file.archivePath, file);
      const payload = payloadByDigest.get(digestKey);
      if (payload) {
        // Keep the payload entry's requiredness bound to its own logical path.
        // The alias carries the later reference's independent requirement.
        fileAliases.push({
          path: file.archivePath,
          payloadPath: payload.archivePath,
          required: file.required,
        });
        continue;
      }
      payloadByDigest.set(digestKey, file);
      files.push(file);
    }
    emitProgress(userId, { phase: "files", total: files.length });
    let filesDone = 0;
    for (const file of files) {
      const metadata = await streamStagedFile(archive, ledger, file, signal);
      byteCounts[metadata.path] = metadata.bytes;
      assertStagingLease();
      filesDone++;
      if ((filesDone & 31) === 0) await yieldAndCheck(signal);
    }
    emitProgress(userId, { phase: "files_done", processed: filesDone });

    let vectorStatus: "included" | "rebuild_required" = "rebuild_required";
    let vectorSourceDigest: string | undefined;
    let vectorProjectionEpoch: number | undefined;
    if (includeVectors) {
      emitProgress(userId, { phase: "lancedb_start" });
      const proof: VectorProjectionProof = {
        sourceDigest: snapshot.sourceDigest,
        projection: snapshot.projection,
      };
      const vectors = await userDataSnapshotBarrier.withExclusive(userId, (barrierSignal) =>
        exportLancedbVectors(
          userId,
          archive!,
          ledger,
          embeddingIdentity,
          proof,
          stagingDir,
          barrierSignal,
          (table, processed) => {
            emitProgress(userId, { phase: "lancedb", table, processed });
          },
        ),
        signal,
      );
      if (vectors.identityRevision) embeddingIdentity = { ...embeddingIdentity, revision: vectors.identityRevision };
      vectorStatus = vectors.status;
      vectorSourceDigest = vectors.vectorSourceDigest;
      vectorProjectionEpoch = vectors.vectorProjectionEpoch;
      for (const [key, value] of Object.entries(vectors.counts)) counts[key] = value;
      for (const entry of ledger.entries.filter((value) => value.kind === "vector")) {
        byteCounts[entry.path] = entry.bytes;
      }
      emitProgress(userId, { phase: "lancedb_done", status: vectorStatus });
    }

    if (opts.secrets) {
      emitProgress(userId, { phase: "secrets_start" });
      const secrets = await exportSecrets(snapshot.db, archive, ledger, { ...opts, archiveId }, signal);
      counts["secrets"] = secrets.exported;
      for (const entry of ledger.entries.filter((value) => value.kind === "secret")) byteCounts[entry.path] = entry.bytes;
      emitProgress(userId, { phase: "secrets_done", exported: secrets.exported });
    }
    assertStagingLease();

    const manifest = createManifest({
      archiveId,
      includeVectors,
      embeddingConfig,
      embeddingIdentity,
      vectorSourceDigest,
      vectorProjectionEpoch,
      producerVersion: opts.producerVersion ?? null,
      counts,
      byteCounts,
      missingFiles,
      missingOptionalFiles,
      hasEncryptedSecrets: !!opts.secrets,
      secretsCount: opts.secrets?.secretKeys.length ?? 0,
      registryVersion: ARCHIVE_REGISTRY_VERSION,
      snapshotId: snapshot.snapshotId,
      entries: ledger.entries.slice().sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      fileAliases,
      vectorStatus,
    });
    const manifestJson = JSON.stringify(manifest, null, 2);
    const manifestBytes = Buffer.byteLength(manifestJson, "utf8");
    if (ledger.entries.length >= MAX_ARCHIVE_ENTRIES || ledger.textCount >= MAX_ARCHIVE_TEXT_ENTRIES) {
      throw new Error(`archive contains too many entries (>${MAX_ARCHIVE_ENTRIES})`);
    }
    if (manifestBytes > MAX_ARCHIVE_MANIFEST_BYTES) {
      throw new Error(`manifest.json exceeds ${MAX_ARCHIVE_MANIFEST_BYTES} bytes`);
    }
    if (ledger.bytes > MAX_ARCHIVE_TOTAL_BYTES - manifestBytes) {
      throw new Error(`archive exceeds decompressed size cap (${MAX_ARCHIVE_TOTAL_BYTES} bytes)`);
    }
    // This is deliberately the final append. V3 import authenticates every
    // preceding ZIP entry against this complete ledger.
    archive.append(manifestJson, { name: "manifest.json", store: true });
    await archive.finalize();
    if (fatalErr) throw fatalErr;
    emitProgress(userId, { phase: "complete", archiveId, schemaVersion: ARCHIVE_SCHEMA_VERSION });
  } catch (error) {
    // Signal failure before aborting the ZIP. Archiver may invoke the sink's
    // final callback while aborting; if that closes the Web stream first, the
    // caller would observe a false successful/usable archive.
    fatalErr ??= error;
    try {
      controller.error(error);
    } catch {
      /* an archive error may have already errored the controller */
    }
    throw error;
  } finally {
    clearInterval(stagingLeaseTimer);
    try {
      archive?.abort?.();
    } catch {
      /* already finalized */
    }
    try {
      snapshot?.close?.();
    } catch {
      /* cleanup must not mask the export error */
    }
    try {
      await cleanupFrozenStaging(stagingDir);
    } catch {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

function makeControllerSink(
  controller: ReadableStreamDefaultController<Uint8Array>,
  signal?: AbortSignal,
  onBytes?: (bytes: number) => void,
): Writable {
  return new Writable({
    // Hold each callback until the Web-stream queue has capacity. This keeps
    // Archiver's pipe backpressured even when the caller does not read yet.
    highWaterMark: 1,
    async write(chunk, _encoding, callback) {
      try {
        const value = chunk instanceof Uint8Array
          ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : new Uint8Array(0);
        onBytes?.(value.byteLength);
        for (let offset = 0; offset < value.byteLength; offset += BINARY_HIGH_WATER_MARK) {
          while (controller.desiredSize !== null && controller.desiredSize <= 0) {
            if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
            await new Promise<void>((resolve) => setTimeout(resolve, 4));
          }
          if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
          const end = Math.min(offset + BINARY_HIGH_WATER_MARK, value.byteLength);
          controller.enqueue(value.subarray(offset, end));
        }
        callback();
      } catch (error) {
        // abort()/controller.error() can race a final buffered ZIP chunk.
        // Once the Web stream is already closed, do not surface a second
        // sink error that masks the original export failure.
        if (error instanceof TypeError && /already closed|closed/u.test(error.message)) {
          callback();
          return;
        }
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    final(callback) {
      try {
        controller.close();
      } catch {
        /* already closed */
      }
      callback();
    },
  });
}

function readEmbeddingConfig(db: any, userId: string): ArchiveEmbeddingConfig {
  try {
    const row = db.query("SELECT value FROM settings WHERE user_id = ? AND key = ?").get(userId, "embeddingConfig") as { value?: unknown } | null;
    const raw = typeof row?.value === "string" ? JSON.parse(row.value) : row?.value;
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const dimension = value.dimension ?? value.dimensions;
    return {
      provider: typeof value.provider === "string" ? value.provider : null,
      model: typeof value.model === "string" ? value.model : null,
      dimension: typeof dimension === "number" && Number.isFinite(dimension) ? dimension : null,
    };
  } catch {
    return { provider: null, model: null, dimension: null };
  }
}
/** Narrow test hook for exercising bounded staged-file admission without ZIP setup. */
export const __testing = {
  stageArchiveFiles,
};
