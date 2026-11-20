/**
 * Per-provider capability constants. The single source of branching for both
 * retrieval (lexical leg) and the operator UI. Orchestration reads these flags;
 * it never switches on `store.id`.
 */
import type { ProviderCapabilities } from "./types";

/** LanceDB — embedded, on-disk, manages its own IVF/scalar/FTS indexes. */
export const LANCEDB_CAPABILITIES: ProviderCapabilities = {
  nativeLexical: true,
  requiresUuidIds: false,
  requiresExplicitFlush: false,
  requiresLoadBeforeQuery: false,
  scoreKind: "cosine_distance",
  managesOwnIndexes: true,
  externalService: false,
  supportsOptimize: true,
  dimensionLockedAtCreate: true,
};

/** Qdrant — remote service, UUID/integer point ids only. Dense vector search is
 * implemented; native sparse/BM25 can be added behind this flag later. */
export const QDRANT_CAPABILITIES: ProviderCapabilities = {
  nativeLexical: false,
  requiresUuidIds: true,
  requiresExplicitFlush: false,
  requiresLoadBeforeQuery: false,
  scoreKind: "cosine_similarity",
  managesOwnIndexes: false,
  externalService: true,
  supportsOptimize: false,
  dimensionLockedAtCreate: true,
};

/** Milvus — remote service, VARCHAR primary key. Native BM25 is enabled on
 * compatible servers (2.5+) and remains disabled for older/Lite deployments. */
export const MILVUS_CAPABILITIES: ProviderCapabilities = {
  nativeLexical: false,
  requiresUuidIds: false,
  requiresExplicitFlush: true,
  requiresLoadBeforeQuery: true,
  scoreKind: "cosine_similarity",
  managesOwnIndexes: false,
  externalService: true,
  supportsOptimize: false,
  dimensionLockedAtCreate: true,
};

/** Minimum Milvus version with native BM25 full-text search. */
export const MILVUS_BM25_MIN_VERSION = { major: 2, minor: 5 };

/** Resolve Milvus capabilities from a probed server version string. */
export function milvusCapabilities(version: string | null | undefined): ProviderCapabilities {
  return { ...MILVUS_CAPABILITIES, nativeLexical: milvusSupportsBm25(version) };
}

/** True when the probed Milvus version supports native BM25 full-text (≥ 2.5). */
export function milvusSupportsBm25(version: string | null | undefined): boolean {
  const parsed = parseSemverMajorMinor(version);
  if (!parsed) return false; // Unknown version → assume no BM25 (safe vector-only fallback).
  const { major, minor } = parsed;
  const min = MILVUS_BM25_MIN_VERSION;
  return major > min.major || (major === min.major && minor >= min.minor);
}

function parseSemverMajorMinor(version: string | null | undefined): { major: number; minor: number } | null {
  if (!version) return null;
  const m = version.match(/(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}
