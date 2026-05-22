// Manifest for a Lumiverse user-data archive (.lvbak).
//
// The manifest is the first entry written into the archive and the first
// entry read on import. It pins the schema version so the importer can
// reject obviously-incompatible archives, and carries the embedding config
// snapshot used to decide whether to restore LanceDB vectors verbatim or
// queue re-vectorization.

export const ARCHIVE_SCHEMA_VERSION = 1;

export const ARCHIVE_PRODUCER = "lumiverse";

export interface ArchiveEmbeddingConfig {
  provider: string | null;
  model: string | null;
  dimension: number | null;
}

export interface ArchiveManifest {
  /** Bumped when the on-disk archive layout changes incompatibly. */
  schemaVersion: number;
  /** Producer identifier so foreign importers can refuse unrelated zips. */
  producer: typeof ARCHIVE_PRODUCER;
  /** Unix seconds when the archive was generated. */
  exportedAt: number;
  /**
   * Random per-archive identifier; useful for telemetry and de-duplication.
   * Also doubles as the binding key for the decryption ticket protocol.
   */
  archiveId: string;
  /** Lumiverse server version that produced the archive, if known. */
  producerVersion: string | null;
  /** Did the export include LanceDB vectors? */
  includeVectors: boolean;
  /**
   * Embedding config at the moment of export. The importer compares against
   * the importer's current config; mismatch means vectors are dropped and
   * background re-vectorization is queued.
   */
  embeddingConfig: ArchiveEmbeddingConfig;
  /** Row counts per table — purely informational, used for progress UI. */
  counts: Record<string, number>;
  /** Names of files that were referenced but missing on disk at export time. */
  missingFiles: string[];
  /**
   * True when the archive carries a `secrets/encrypted.ndjson` blob that
   * requires a decryption ticket to restore. False / absent for archives
   * exported without the "Include API keys" opt-in.
   */
  hasEncryptedSecrets?: boolean;
  /** Number of encrypted-secret entries in the archive, when applicable. */
  secretsCount?: number;
}

export function createManifest(input: {
  archiveId: string;
  includeVectors: boolean;
  embeddingConfig: ArchiveEmbeddingConfig;
  producerVersion: string | null;
  counts: Record<string, number>;
  missingFiles: string[];
  hasEncryptedSecrets?: boolean;
  secretsCount?: number;
}): ArchiveManifest {
  return {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    producer: ARCHIVE_PRODUCER,
    exportedAt: Math.floor(Date.now() / 1000),
    archiveId: input.archiveId,
    producerVersion: input.producerVersion,
    includeVectors: input.includeVectors,
    embeddingConfig: input.embeddingConfig,
    counts: input.counts,
    missingFiles: input.missingFiles,
    hasEncryptedSecrets: !!input.hasEncryptedSecrets,
    secretsCount: input.secretsCount ?? 0,
  };
}

/** Parse and shape-check a manifest blob read from an archive. */
export function parseManifest(raw: unknown): ArchiveManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error("manifest.json is malformed (not an object)");
  }
  const m = raw as Record<string, any>;
  if (m.producer !== ARCHIVE_PRODUCER) {
    throw new Error(
      `archive producer is ${JSON.stringify(m.producer)}, expected "${ARCHIVE_PRODUCER}"`,
    );
  }
  const schemaVersion = Number(m.schemaVersion);
  if (!Number.isFinite(schemaVersion) || schemaVersion < 1) {
    throw new Error(`unsupported schemaVersion: ${m.schemaVersion}`);
  }
  if (schemaVersion > ARCHIVE_SCHEMA_VERSION) {
    throw new Error(
      `archive schemaVersion ${schemaVersion} is newer than this server supports (${ARCHIVE_SCHEMA_VERSION})`,
    );
  }
  const includeVectors = !!m.includeVectors;
  const embeddingConfig = (m.embeddingConfig ?? {
    provider: null,
    model: null,
    dimension: null,
  }) as ArchiveEmbeddingConfig;
  const counts = (m.counts ?? {}) as Record<string, number>;
  const missingFiles = Array.isArray(m.missingFiles) ? (m.missingFiles as string[]) : [];

  return {
    schemaVersion,
    producer: ARCHIVE_PRODUCER,
    exportedAt: Number(m.exportedAt) || 0,
    archiveId: String(m.archiveId || ""),
    producerVersion: m.producerVersion ?? null,
    includeVectors,
    embeddingConfig,
    counts,
    missingFiles,
    hasEncryptedSecrets: !!m.hasEncryptedSecrets,
    secretsCount: Number(m.secretsCount) || 0,
  };
}

export function embeddingConfigsMatch(
  a: ArchiveEmbeddingConfig | null | undefined,
  b: ArchiveEmbeddingConfig | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.dimension === b.dimension &&
    a.dimension !== null
  );
}
