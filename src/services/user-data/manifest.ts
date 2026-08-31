// Manifest for a Lumiverse user-data archive (.lvbak).
//
// V2 archives made bounded NDJSON records explicit. V3 is written as the
// final ZIP entry and authenticates every preceding entry through sorted
// integrity metadata. V1 and V2 remain readable through bounded compatibility
// paths.

export const ARCHIVE_SCHEMA_VERSION = 3;
export const ARCHIVE_PRODUCER = "lumiverse";

/**
 * Legacy V1/V2 manifests may omit this marker. When present, the marker is
 * bounded to the known formats; only V3 requires the current exact marker.
 * V1/V2 may advertise a smaller record ceiling, never above the hard cap.
 */
export const NDJSON_FORMAT_VERSION = 2;

/** Largest JSON record emitted by the current ZIP64 exporter. */
export const NDJSON_MAX_RECORD_BYTES = 64 * 1024 * 1024;

/** One archive payload entry may not exceed the frozen-file ceiling. */
export const MAX_ARCHIVE_FILE_BYTES = 8 * 1024 * 1024 * 1024;

/** Shared importer/exporter archive-wide ceilings. */
export const MAX_ARCHIVE_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
export const MAX_ARCHIVE_COMPRESSED_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 500_000;
export const MAX_ARCHIVE_TEXT_ENTRIES = 1_024;
export const MAX_ARCHIVE_TOTAL_ROWS = 2_000_000;
export const MAX_ARCHIVE_ROWS_PER_TABLE = 500_000;
export const MAX_ARCHIVE_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_ARCHIVE_SECRET_ENTRIES = 10_000;
export const MAX_ARCHIVE_SECRET_BYTES = 16 * 1024 * 1024;

const SHA256_RE = /^[0-9a-f]{64}$/;


export interface ArchiveEmbeddingConfig {
  provider: string | null;
  model: string | null;
  dimension: number | null;
}

export interface ArchiveSourceIdentity {
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  birthtimeMs?: number;
  /** POSIX mode captured with the frozen source descriptor when available. */
  mode?: number;
}

export interface ArchiveEmbeddingIdentity {
  provider: string | null;
  model: string | null;
  dimension: number | null;
  revision?: string | null;
}

export type ArchiveEntryKind = "database" | "secret" | "file" | "vector";

/** A logical file reference may point at one authenticated payload. */
export interface ArchiveFileAlias {
  /** Canonical path retained by the exporting row/reference. */
  path: string;
  /** Authenticated ZIP entry carrying the bytes for `path`. */
  payloadPath: string;
  /** Requiredness of this logical reference, independent of the payload entry. */
  required: boolean;
}

/** One authenticated, non-manifest ZIP entry in a V3 archive. */
export interface ArchiveEntry {
  path: string;
  kind: ArchiveEntryKind;
  required: boolean;
  bytes: number;
  sha256: string;
  rowCount?: number;
  sourceIdentity?: string | ArchiveSourceIdentity;
}

export interface ArchiveManifest {
  /** Archive format version. */
  schemaVersion: number;
  /** Producer identifier so foreign importers can refuse unrelated zips. */
  producer: typeof ARCHIVE_PRODUCER;
  /** Unix seconds when the archive was generated. */
  exportedAt: number;
  /** Random per-archive identifier and secret-ticket binding key. */
  archiveId: string;
  /** Lumiverse server version that produced the archive, if known. */
  producerVersion: string | null;
  /**
   * Optional for schema-1 compatibility. Format 2 guarantees that
   * every record obeys `ndjsonMaxRecordBytes`.
   */
  ndjsonFormatVersion?: number;
  /** Per-record UTF-8 byte ceiling for format-2 NDJSON entries. */
  ndjsonMaxRecordBytes?: number;
  /** Did the export include LanceDB vectors? */
  includeVectors: boolean;
  /** Embedding config at export time. */
  embeddingConfig: ArchiveEmbeddingConfig;
  /** Frozen owner-scoped canonical source digest bound to included vectors. */
  vectorSourceDigest?: string;
  /** Monotonic source/projection epoch captured with included vectors. */
  vectorProjectionEpoch?: number;
  /** Registry version used to classify and order canonical tables. */
  registryVersion?: number;
  /** Dedicated relational snapshot identity used for the export. */
  snapshotId?: string;
  /** Sorted authenticated entries; absent for V1 and V2 manifests. */
  entries?: readonly ArchiveEntry[];
  /** Logical file paths whose bytes are carried by another authenticated entry. */
  fileAliases?: readonly ArchiveFileAlias[];
  /** Row counts per table and vector source (kept for V1 compatibility). */
  counts: Record<string, number>;
  /** Byte counts per emitted entry, keyed by archive path. */
  byteCounts?: Record<string, number>;
  /** Referenced files absent at export time (V1 compatibility). */
  missingFiles: string[];
  /** Optional refs absent at export time. */
  missingOptionalFiles?: string[];
  /** True when the archive carries encrypted secrets. */
  hasEncryptedSecrets?: boolean;
  /** Embedding identity and authenticated vector payload revision. */
  embeddingIdentity?: string | ArchiveEmbeddingIdentity | null;
  /** Whether optional vector entries were included or need rebuilding. */
  vectorStatus?: "included" | "rebuild_required";
  /** Number of encrypted-secret entries in the archive, when applicable. */
  secretsCount?: number;
}

export interface CreateManifestInput {
  archiveId: string;
  includeVectors: boolean;
  embeddingConfig: ArchiveEmbeddingConfig;
  producerVersion: string | null;
  counts: Record<string, number>;
  byteCounts?: Record<string, number>;
  missingFiles: string[];
  missingOptionalFiles?: string[];
  hasEncryptedSecrets?: boolean;
  secretsCount?: number;
  registryVersion?: number;
  snapshotId?: string;
  entries?: readonly ArchiveEntry[];
  fileAliases?: readonly ArchiveFileAlias[];
  vectorSourceDigest?: string;
  vectorProjectionEpoch?: number;
  embeddingIdentity?: string | ArchiveEmbeddingIdentity | null;
  vectorStatus?: "included" | "rebuild_required";
}

/**
 * Build a manifest while retaining the old fields consumed by V1/V2 importers.
 * V3 callers pass the authenticated ledger fields; all maps and lists are
 * copied and sorted so the JSON bytes are deterministic apart from the
 * timestamp.
 */
export function createManifest(input: CreateManifestInput): ArchiveManifest {
  const hasV3 = input.entries !== undefined;
  const entries = hasV3
    ? normalizeEntries(
        (input.entries ?? []).slice().sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        ),
      )
    : undefined;
  const fileAliases = hasV3
    ? normalizeFileAliases(
        (input.fileAliases ?? []).slice().sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : a.payloadPath < b.payloadPath ? -1 : 1,
        ),
        true,
      )
    : undefined;
  const missingFiles = normalizeStringList(input.missingFiles);
  const missingOptionalFiles = normalizeStringList(input.missingOptionalFiles ?? []);
  const counts = normalizeCounts(sortNumericRecord(input.counts), hasV3);
  const byteCounts = hasV3
    ? normalizeCounts(sortNumericRecord(requireNumericRecord(input.byteCounts, "byteCounts")), true)
    : undefined;
  let vectorSourceDigest: string | undefined;
  let vectorProjectionEpoch: number | undefined;
  if (hasV3) {
    assertPositiveInteger(input.registryVersion, "registryVersion");
    if (input.embeddingIdentity === undefined) {
      throw new Error("embeddingIdentity is required for V3 manifests");
    }
    if (input.vectorStatus === undefined) {
      throw new Error("vectorStatus is required for V3 manifests");
    }
    if (input.vectorStatus === "included") {
      vectorSourceDigest = requireSha256(input.vectorSourceDigest, "vectorSourceDigest");
      vectorProjectionEpoch = requireNonNegativeInteger(input.vectorProjectionEpoch, "vectorProjectionEpoch");
    }
  }
  return {
    schemaVersion: hasV3 ? ARCHIVE_SCHEMA_VERSION : 1,
    producer: ARCHIVE_PRODUCER,
    exportedAt: Math.floor(Date.now() / 1000),
    archiveId: input.archiveId,
    producerVersion: input.producerVersion,
    ndjsonFormatVersion: NDJSON_FORMAT_VERSION,
    ndjsonMaxRecordBytes: NDJSON_MAX_RECORD_BYTES,
    includeVectors: input.includeVectors,
    embeddingConfig: normalizeEmbeddingConfig(input.embeddingConfig),
    ...(hasV3
      ? { embeddingIdentity: parseEmbeddingIdentity(input.embeddingIdentity) }
      : {}),
    ...(hasV3 ? { vectorStatus: parseVectorStatus(input.vectorStatus) } : {}),
    ...(hasV3 && input.vectorStatus === "included"
      ? { vectorSourceDigest, vectorProjectionEpoch }
      : {}),
    ...(hasV3
      ? {
          registryVersion: input.registryVersion,
          snapshotId: input.snapshotId,
          entries,
          fileAliases,
          byteCounts,
          missingOptionalFiles,
        }
      : {}),
    counts,
    missingFiles,
    hasEncryptedSecrets: !!input.hasEncryptedSecrets,
    secretsCount: input.secretsCount ?? 0,
  };
}

/** Parse and strictly validate a V1, V2, or V3 manifest blob. */
export function parseManifest(raw: unknown): ArchiveManifest {
  const m = asRecord(raw, "manifest.json");
  if (m.producer !== ARCHIVE_PRODUCER) {
    throw new Error(
      `archive producer is ${JSON.stringify(m.producer)}, expected "${ARCHIVE_PRODUCER}"`,
    );
  }
  const schemaVersion = requireInteger(m.schemaVersion, "schemaVersion");
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== ARCHIVE_SCHEMA_VERSION) {
    throw new Error(`unsupported schemaVersion: ${m.schemaVersion}`);
  }

  const common = parseCommonManifest(m, schemaVersion);
  if (schemaVersion === ARCHIVE_SCHEMA_VERSION) {
    if (common.ndjsonFormatVersion !== NDJSON_FORMAT_VERSION) {
      throw new Error(
        `archive schemaVersion ${schemaVersion} requires ndjsonFormatVersion ${NDJSON_FORMAT_VERSION}`,
      );
    }
    if (common.ndjsonMaxRecordBytes !== NDJSON_MAX_RECORD_BYTES) {
      throw new Error(
        `archive schemaVersion ${schemaVersion} requires ndjsonMaxRecordBytes ${NDJSON_MAX_RECORD_BYTES}`,
      );
    }
  }
  if (schemaVersion <= 2) {
    // Legacy exporters may omit these markers, but an advertised value is
    // still bounded so the reader can never be widened by archive metadata.
    if (
      common.ndjsonFormatVersion !== undefined
      && (common.ndjsonFormatVersion < 1 || common.ndjsonFormatVersion > NDJSON_FORMAT_VERSION)
    ) {
      throw new Error(`archive schemaVersion ${schemaVersion} has an unsupported ndjsonFormatVersion`);
    }
    if (
      common.ndjsonMaxRecordBytes !== undefined
      && common.ndjsonMaxRecordBytes > NDJSON_MAX_RECORD_BYTES
    ) {
      throw new Error(
        `archive schemaVersion ${schemaVersion} advertises an NDJSON limit above ${NDJSON_MAX_RECORD_BYTES}`,
      );
    }
    // V1 and V2 deliberately have no integrity ledger. Keep parsing strict so
    // legacy archives cannot enter the ownership/graph validator ambiguously.
    rejectV2OnlyFields(m, [
      "entries",
      "vectorSourceDigest",
      "vectorProjectionEpoch",
      "registryVersion",
      "snapshotId",
      "fileAliases",
      "byteCounts",
      "missingOptionalFiles",
      "vectorStatus",
      "embeddingIdentity",
    ]);
    return {
      ...common,
      schemaVersion,
    };
  }

  const registryVersion = requirePositiveInteger(m.registryVersion, "registryVersion");
  const snapshotId = requireNonEmptyString(m.snapshotId, "snapshotId");
  const entries = normalizeEntries(requireArray(m.entries, "entries"));
  const fileAliases = normalizeFileAliases(requireArray(m.fileAliases, "fileAliases"), true);
  const byteCounts = normalizeCounts(m.byteCounts, true);
  const missingOptionalFiles = normalizeStringList(requireArray(m.missingOptionalFiles, "missingOptionalFiles"));
  if (m.embeddingIdentity === undefined) {
    throw new Error("V3 manifest is missing embeddingIdentity");
  }
  if (m.vectorStatus === undefined) {
    throw new Error("V3 manifest is missing vectorStatus");
  }
  const vectorStatus = parseVectorStatus(m.vectorStatus);
  const vectorSourceDigest = vectorStatus === "included"
    ? requireSha256(m.vectorSourceDigest, "vectorSourceDigest")
    : undefined;
  const vectorProjectionEpoch = vectorStatus === "included"
    ? requireNonNegativeInteger(m.vectorProjectionEpoch, "vectorProjectionEpoch")
    : undefined;
  return {
    ...common,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    registryVersion,
    snapshotId,
    entries,
    fileAliases,
    byteCounts,
    missingOptionalFiles,
    embeddingIdentity: parseEmbeddingIdentity(m.embeddingIdentity),
    vectorStatus,
    ...(vectorStatus === "included" ? { vectorSourceDigest, vectorProjectionEpoch } : {}),
  };
}


function parseCommonManifest(
  m: Record<string, unknown>,
  schemaVersion: number,
): Omit<ArchiveManifest, "schemaVersion" | "entries" | "registryVersion" | "snapshotId"> {
  const legacy = schemaVersion <= 2;
  const exportedAt = m.exportedAt === undefined && legacy
    ? 0
    : requireFiniteNumber(m.exportedAt, "exportedAt");
  const archiveId = m.archiveId === undefined && legacy
    ? ""
    : requireNonEmptyString(m.archiveId, "archiveId");
  const producerVersion =
    m.producerVersion === undefined && legacy
      ? null
      : m.producerVersion === null
        ? null
        : requireString(m.producerVersion, "producerVersion");
  const ndjsonFormatVersion =
    m.ndjsonFormatVersion === undefined
      ? undefined
      : requirePositiveInteger(m.ndjsonFormatVersion, "ndjsonFormatVersion");
  const ndjsonMaxRecordBytes =
    m.ndjsonMaxRecordBytes === undefined
      ? undefined
      : requirePositiveInteger(m.ndjsonMaxRecordBytes, "ndjsonMaxRecordBytes");
  const includeVectors =
    m.includeVectors === undefined && legacy
      ? false
      : requireBoolean(m.includeVectors, "includeVectors");
  const embeddingConfig =
    m.embeddingConfig === undefined && legacy
      ? { provider: null, model: null, dimension: null }
      : parseEmbeddingConfig(m.embeddingConfig);
  const counts =
    m.counts === undefined && legacy
      ? {}
      : normalizeCounts(m.counts, schemaVersion >= 3);
  const missingFiles =
    m.missingFiles === undefined && legacy
      ? []
      : normalizeStringList(requireArray(m.missingFiles, "missingFiles"));
  const hasEncryptedSecrets =
    m.hasEncryptedSecrets === undefined ? undefined : requireBoolean(m.hasEncryptedSecrets, "hasEncryptedSecrets");
  const secretsCount =
    m.secretsCount === undefined ? undefined : requireNonNegativeInteger(m.secretsCount, "secretsCount");
  const vectorStatus = m.vectorStatus === undefined ? undefined : parseVectorStatus(m.vectorStatus);
  return {
    producer: ARCHIVE_PRODUCER,
    exportedAt,
    archiveId,
    producerVersion,
    ...(ndjsonFormatVersion === undefined ? {} : { ndjsonFormatVersion }),
    ...(ndjsonMaxRecordBytes === undefined ? {} : { ndjsonMaxRecordBytes }),
    includeVectors,
    embeddingConfig,
    counts,
    missingFiles,
    ...(vectorStatus === undefined ? {} : { vectorStatus }),
    ...(hasEncryptedSecrets === undefined ? {} : { hasEncryptedSecrets }),
    ...(secretsCount === undefined ? {} : { secretsCount }),
  };
}

function isSafeArchivePath(path: string): boolean {
  return !path.startsWith("/")
    && /^[A-Za-z0-9._/-]+$/.test(path)
    && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function normalizeEntries(raw: readonly unknown[]): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let previous = "";
  for (const value of raw) {
    const entry = asRecord(value, "manifest entry");
    const path = requireNonEmptyString(entry.path, "entry.path");
    if (path === "manifest.json" || !isSafeArchivePath(path)) {
      throw new Error(`invalid archive entry path: ${path}`);
    }
    if (seen.has(path)) throw new Error(`duplicate archive entry: ${path}`);
    if (path < previous) throw new Error("manifest entries are not sorted by path");
    previous = path;
    seen.add(path);
    const kind = entry.kind;
    if (kind !== "database" && kind !== "secret" && kind !== "file" && kind !== "vector") {
      throw new Error(`invalid archive entry kind for ${path}`);
    }
    const bytes = requireNonNegativeInteger(entry.bytes, `${path}.bytes`);
    if (bytes > MAX_ARCHIVE_FILE_BYTES) {
      throw new Error(`${path}.bytes exceeds ${MAX_ARCHIVE_FILE_BYTES} bytes`);
    }
    const normalized: ArchiveEntry = {
      path,
      kind,
      required: requireBoolean(entry.required, `${path}.required`),
      bytes,
      sha256: requireSha256(entry.sha256, `${path}.sha256`),
    };
    if (entry.rowCount !== undefined) {
      normalized.rowCount = requireNonNegativeInteger(entry.rowCount, `${path}.rowCount`);
    }
    if (entry.sourceIdentity !== undefined) {
      normalized.sourceIdentity = parseSourceIdentity(entry.sourceIdentity, `${path}.sourceIdentity`);
    }
    if (
      kind === "file"
      && (
        !normalized.sourceIdentity
        || typeof normalized.sourceIdentity === "string"
        || normalized.sourceIdentity.size !== bytes
      )
    ) {
      throw new Error(`${path}.sourceIdentity.size must equal bytes`);
    }
    out.push(normalized);
  }
  return out;
}

function normalizeFileAliases(
  raw: readonly unknown[],
  requireSorted = false,
): ArchiveFileAlias[] {
  const out: ArchiveFileAlias[] = [];
  const seen = new Set<string>();
  let previousPath = "";
  let previousPayloadPath = "";
  for (const value of raw) {
    const entry = asRecord(value, "file alias");
    const path = requireNonEmptyString(entry.path, "file alias.path");
    const payloadPath = requireNonEmptyString(entry.payloadPath, "file alias.payloadPath");
    if (!isSafeArchivePath(path) || !path.startsWith("files/")) {
      throw new Error(`invalid file alias path: ${path}`);
    }
    if (!isSafeArchivePath(payloadPath) || !payloadPath.startsWith("files/")) {
      throw new Error(`invalid file alias payload path: ${payloadPath}`);
    }
    if (path === payloadPath) throw new Error(`file alias points at itself: ${path}`);
    if (seen.has(path)) throw new Error(`duplicate file alias: ${path}`);
    if (
      requireSorted
      && (
        path < previousPath
        || (path === previousPath && payloadPath < previousPayloadPath)
      )
    ) {
      throw new Error("manifest file aliases are not sorted");
    }
    previousPath = path;
    previousPayloadPath = payloadPath;
    seen.add(path);
    out.push({
      path,
      payloadPath,
      required: requireBoolean(entry.required, `${path}.required`),
    });
  }
  return requireSorted
    ? out
    : out.sort((a, b) =>
        a.path < b.path
          ? -1
          : a.path > b.path
            ? 1
            : a.payloadPath < b.payloadPath
              ? -1
              : 1,
      );
}

function requireNumericRecord(raw: Record<string, number> | undefined, label: string): Record<string, number> {
  if (raw === undefined) throw new Error(`${label} is required for V3 manifests`);
  return raw;
}

function sortNumericRecord(raw: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(raw).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function normalizeCounts(raw: unknown, requireSorted = false): Record<string, number> {
  const obj = asRecord(raw, "counts");
  const out: Record<string, number> = {};
  let previous = "";
  for (const [key, value] of Object.entries(obj)) {
    if (!key) throw new Error("counts contains an empty key");
    if (requireSorted && key < previous) throw new Error("manifest counts are not sorted");
    previous = key;
    const normalized = requireNonNegativeInteger(value, `counts.${key}`);
    if (normalized > MAX_ARCHIVE_FILE_BYTES) {
      throw new Error(`counts.${key} exceeds ${MAX_ARCHIVE_FILE_BYTES} bytes`);
    }
    out[key] = normalized;
  }
  return requireSorted
    ? out
    : Object.fromEntries(
        Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
}

function normalizeStringList(raw: readonly unknown[]): string[] {
  const out = raw.map((value, index) => requireNonEmptyString(value, `list[${index}]`));
  const unique = [...new Set(out)].sort();
  if (unique.length !== out.length) throw new Error("manifest string list contains duplicates");
  return unique;
}

function normalizeEmbeddingConfig(raw: ArchiveEmbeddingConfig): ArchiveEmbeddingConfig {
  return parseEmbeddingConfig(raw);
}

function parseEmbeddingConfig(raw: unknown): ArchiveEmbeddingConfig {
  const obj = asRecord(raw, "embeddingConfig");
  const provider = obj.provider === null ? null : requireString(obj.provider, "embeddingConfig.provider");
  const model = obj.model === null ? null : requireString(obj.model, "embeddingConfig.model");
  const dimension = obj.dimension === null ? null : requirePositiveInteger(obj.dimension, "embeddingConfig.dimension");
  return { provider, model, dimension };
}

function parseVectorStatus(value: unknown): "included" | "rebuild_required" {
  if (value !== "included" && value !== "rebuild_required") {
    throw new Error("vectorStatus must be included or rebuild_required");
  }
  return value;
}

function parseSourceIdentity(raw: unknown, label: string): string | ArchiveSourceIdentity {
  if (typeof raw === "string") return requireNonEmptyString(raw, label);
  const obj = asRecord(raw, label);
  const identity: ArchiveSourceIdentity = {
    device: requireNonNegativeInteger(obj.device, `${label}.device`),
    inode: requireNonNegativeInteger(obj.inode, `${label}.inode`),
    size: requireNonNegativeInteger(obj.size, `${label}.size`),
    mtimeMs: requireFiniteNumber(obj.mtimeMs, `${label}.mtimeMs`),
  };
  if (obj.ctimeMs !== undefined) identity.ctimeMs = requireFiniteNumber(obj.ctimeMs, `${label}.ctimeMs`);
  if (obj.birthtimeMs !== undefined) identity.birthtimeMs = requireFiniteNumber(obj.birthtimeMs, `${label}.birthtimeMs`);
  if (obj.mode !== undefined) identity.mode = requireNonNegativeInteger(obj.mode, `${label}.mode`);
  return identity;
}

function parseEmbeddingIdentity(raw: unknown): string | ArchiveEmbeddingIdentity | null {
  if (raw === null || typeof raw === "string") return raw === null ? null : requireNonEmptyString(raw, "embeddingIdentity");
  const obj = asRecord(raw, "embeddingIdentity");
  const identity: ArchiveEmbeddingIdentity = {
    provider: obj.provider === null ? null : requireString(obj.provider, "embeddingIdentity.provider"),
    model: obj.model === null ? null : requireString(obj.model, "embeddingIdentity.model"),
    dimension: obj.dimension === null ? null : requirePositiveInteger(obj.dimension, "embeddingIdentity.dimension"),
  };
  if (obj.revision !== undefined) identity.revision = obj.revision === null ? null : requireNonEmptyString(obj.revision, "embeddingIdentity.revision");
  return identity;
}

function rejectV2OnlyFields(m: Record<string, unknown>, names: readonly string[]): void {
  for (const name of names) {
    if (m[name] !== undefined) throw new Error(`V1 manifest contains V2 field: ${name}`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (text.length === 0) throw new Error(`${label} must not be empty`);
  return text;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function requireInteger(value: unknown, label: string): number {
  const number = requireFiniteNumber(value, label);
  if (!Number.isInteger(number)) throw new Error(`${label} must be an integer`);
  return number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const number = requireInteger(value, label);
  if (number < 0) throw new Error(`${label} must be non-negative`);
  return number;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const number = requireInteger(value, label);
  if (number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  requirePositiveInteger(value, label);
}

function requireSha256(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!SHA256_RE.test(text)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return text;
}

export function embeddingConfigsMatch(
  a: ArchiveEmbeddingConfig | null | undefined,
  b: ArchiveEmbeddingConfig | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.provider === b.provider && a.model === b.model && a.dimension === b.dimension && a.dimension !== null;
}
