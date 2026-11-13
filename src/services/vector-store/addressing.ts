/**
 * Shared, provider-agnostic addressing + fusion logic. Everything here is pure
 * (no SDK imports) and is the single home for the row identity, collection
 * selection, structured-filter builders, score normalization, RRF/MMR fusion,
 * and adaptive storage batching that used to live inline in
 * `embeddings.service.ts`. Providers translate the structured filters into their
 * own dialect; orchestration calls the fusion helpers.
 */
import type {
  CollectionName,
  ProviderCapabilities,
  SourceType,
  VectorFilter,
  VectorHit,
} from "./types";

// ---------------------------------------------------------------------------
// Constants (moved verbatim from embeddings.service.ts)
// ---------------------------------------------------------------------------

/** Cap on how many source ids we inline into a scoping filter. Above this the
 *  builder returns `null` and the caller widens the query + post-filters
 *  client-side (preserves the historical `filterWasScoped` behavior). */
export const MAX_SOURCE_FILTER_IDS = 250;

/** Reciprocal Rank Fusion smoothing constant. */
export const RRF_K = 60;

/** Clip for the query text fed to a lexical leg (BM25 tokenizers get no useful
 *  signal from very long fuzzy queries, and it stresses native tokenizers). */
export const FTS_QUERY_MAX_CHARS = 4096;

const EMBEDDINGS_COLLECTION: CollectionName = "embeddings";
const WORLD_BOOK_COLLECTION: CollectionName = "embeddings_world_books";

// ---------------------------------------------------------------------------
// Identity + collection selection
// ---------------------------------------------------------------------------

/** Canonical composite row id. Stable across providers. */
export function rowId(userId: string, sourceType: string, sourceId: string, chunkIndex: number): string {
  return `${userId}:${sourceType}:${sourceId}:${chunkIndex}`;
}

/** World-book entries live in their own collection; everything else shares `embeddings`. */
export function collectionForSourceType(sourceType: string): CollectionName {
  return sourceType === "world_book_entry" ? WORLD_BOOK_COLLECTION : EMBEDDINGS_COLLECTION;
}

/** Collection a batch of rows belongs to (mirrors the old `tableNameForRows`). */
export function selectCollection(rows: Array<{ source_type: string }>): CollectionName {
  if (rows.length > 0 && rows.every((r) => r.source_type === "world_book_entry")) {
    return WORLD_BOOK_COLLECTION;
  }
  return EMBEDDINGS_COLLECTION;
}

// ---------------------------------------------------------------------------
// Structured filter builders (replace inline SQL `where()` assembly)
// ---------------------------------------------------------------------------

export function eq(field: string, value: string | number): VectorFilter {
  return { op: "eq", field, value };
}

export function inSet(field: string, values: Array<string | number>): VectorFilter {
  return { op: "in", field, values };
}

export function notInSet(field: string, values: Array<string | number>): VectorFilter {
  return { op: "nin", field, values };
}

/**
 * Combine clauses into a single AND, dropping `null`s (a dropped over-cap
 * source filter). Returns the lone clause when only one survives; an empty
 * `and` (no clauses) means "match all".
 */
export function andFilter(parts: Array<VectorFilter | null | undefined>): VectorFilter {
  const clauses = parts.filter((p): p is VectorFilter => p != null);
  if (clauses.length === 1) return clauses[0];
  return { op: "and", clauses };
}

/** `user_id = … AND source_type = … AND owner_id = …` — the universal scope. */
export function ownerScope(userId: string, sourceType: SourceType, ownerId: string): VectorFilter {
  return andFilter([eq("user_id", userId), eq("source_type", sourceType), eq("owner_id", ownerId)]);
}

/** Like {@link ownerScope} but for several owners (e.g. multi-databank search). */
export function ownersScope(userId: string, sourceType: SourceType, ownerIds: string[]): VectorFilter {
  return andFilter([eq("user_id", userId), eq("source_type", sourceType), inSet("owner_id", ownerIds)]);
}

/** `source_id IN (…)`, or `null` when the set exceeds {@link MAX_SOURCE_FILTER_IDS}. */
export function sourceIdsIn(ids: Iterable<string> | null | undefined): VectorFilter | null {
  const arr = ids ? [...ids] : [];
  if (arr.length === 0 || arr.length > MAX_SOURCE_FILTER_IDS) return null;
  return inSet("source_id", arr);
}

/** `source_id NOT IN (…)`, or `null` when the set exceeds {@link MAX_SOURCE_FILTER_IDS}. */
export function sourceIdsNotIn(ids: Iterable<string> | null | undefined): VectorFilter | null {
  const arr = ids ? [...ids] : [];
  if (arr.length === 0 || arr.length > MAX_SOURCE_FILTER_IDS) return null;
  return notInSet("source_id", arr);
}

/** `id IN (…)`. No cardinality cap — callers chunk large id sets themselves. */
export function idsIn(ids: string[]): VectorFilter {
  return inSet("id", ids);
}

// ---------------------------------------------------------------------------
// Score normalization (the single seam)
// ---------------------------------------------------------------------------

/**
 * Normalize a provider's raw score into canonical cosine similarity (higher =
 * better). LanceDB returns cosine *distance*; Qdrant/Milvus return similarity.
 * Intentionally not clamped, so the inverse (`distanceFromSimilarity`) keeps the
 * historical [0, 2] distance range that consumers tuned thresholds against.
 */
export function toSimilarity(raw: number, scoreKind: ProviderCapabilities["scoreKind"]): number {
  return scoreKind === "cosine_distance" ? 1 - raw : raw;
}

/**
 * Inverse of {@link toSimilarity}, used by the `embeddings.service.ts` adapter
 * to rebuild the distance-shaped public return contract. A lexical-only hit
 * (`similarity == null`) has no vector distance → `+Infinity` (sorts last),
 * preserving the world-book ordering semantics.
 */
export function distanceFromSimilarity(similarity: number | null): number {
  return similarity == null ? Number.POSITIVE_INFINITY : 1 - similarity;
}

// ---------------------------------------------------------------------------
// Fusion: RRF + MMR (moved from embeddings.service.ts, retyped onto VectorHit)
// ---------------------------------------------------------------------------

/**
 * Reciprocal Rank Fusion: merge two ranked hit lists (dense vector + lexical)
 * into one ranking using rank position only (`Σ 1/(k + rank_i)` per
 * appearance). Vector-leg hits are inserted first so they win ties and their
 * `similarity` is retained; a hit present in both legs also picks up the
 * lexical leg's `lexicalScore`. Empty legs short-circuit (free graceful
 * degradation when a provider has no lexical leg).
 */
export function reciprocalRankFusion(vectorHits: VectorHit[], lexicalHits: VectorHit[]): VectorHit[] {
  if (vectorHits.length === 0 && lexicalHits.length === 0) return [];
  if (lexicalHits.length === 0) return vectorHits;
  if (vectorHits.length === 0) return lexicalHits;

  const scores = new Map<string, number>();
  const hitById = new Map<string, VectorHit>();

  for (let i = 0; i < vectorHits.length; i++) {
    const hit = vectorHits[i];
    const id = String(hit.source_id);
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    hitById.set(id, hit);
  }
  for (let i = 0; i < lexicalHits.length; i++) {
    const hit = lexicalHits[i];
    const id = String(hit.source_id);
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    const existing = hitById.get(id);
    if (existing) {
      // Carry the lexical score onto the vector-leg hit we keep.
      if (existing.lexicalScore == null && hit.lexicalScore != null) existing.lexicalScore = hit.lexicalScore;
    } else {
      hitById.set(id, hit);
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const out: VectorHit[] = [];
  for (const [id] of ranked) {
    const hit = hitById.get(id);
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * Maximal Marginal Relevance: iteratively pick hits that are relevant to the
 * query but diverse from already-selected hits. `lambda` trades relevance
 * (1.0) vs diversity (0.0); 0.7 suits chat memory. Relevance reads canonical
 * `similarity` directly (a lexical-only hit, `similarity == null`, contributes
 * no relevance and is chosen on diversity alone). Hits without a fetched vector
 * are excluded from the diversity loop, matching the historical behavior.
 */
export function mmrSelect(candidates: VectorHit[], queryVector: number[], k: number, lambda = 0.7): VectorHit[] {
  void queryVector; // relevance comes from the precomputed similarity, not a re-scored query distance.
  const withVectors = candidates.filter((c) => c.vector !== null);
  if (withVectors.length <= k || withVectors.length === 0) {
    return candidates.slice(0, k);
  }

  const selected: VectorHit[] = [];
  const remaining = new Set(withVectors.map((_, i) => i));

  for (let i = 0; i < k && remaining.size > 0; i++) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (const idx of remaining) {
      const candidate = withVectors[idx];
      const relevance = candidate.similarity ?? 0;

      let maxSimToSelected = 0;
      if (selected.length > 0) {
        for (const sel of selected) {
          if (sel.vector && candidate.vector) {
            const sim = cosineSimilarity(candidate.vector, sel.vector);
            if (sim > maxSimToSelected) maxSimToSelected = sim;
          }
        }
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSimToSelected;
      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      selected.push(withVectors[bestIdx]);
      remaining.delete(bestIdx);
    }
  }

  return selected;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Adaptive storage batching (generalized from mergeInsertRowsInBatches)
// ---------------------------------------------------------------------------

/**
 * Retryable-by-halving classifier for STORAGE (upsert) errors. Union of the
 * historical `isRetryableBatchError` + `isRetryableMergeInsertError` patterns
 * (so the LanceDB path stays byte-for-byte) plus external-provider transport
 * limits (Qdrant timeouts, Milvus/gRPC `RESOURCE_EXHAUSTED` / oversized message).
 */
export function isRetryableStorageError(err: Error): boolean {
  const m = err.message;
  if (/timed out|abort/i.test(m)) return true;
  if (/too large to process|physical batch size|increase.*batch.*size/i.test(m)) return true;
  if (/exceeds.*context|context.*exceed/i.test(m)) return true;
  if (/\(413\)|\(500\)|\(503\)/.test(m)) return true;
  if (/resources? exhausted|failed to allocate|hashjoininput/i.test(m)) return true;
  if (/RESOURCE_EXHAUSTED|message larger than max|received message larger/i.test(m)) return true;
  return false;
}

/**
 * Process `items` in batches of `initialBatchSize`, halving a batch on a
 * retryable error down to size 1. At size 1 (or a non-retryable error) the
 * error is rethrown unless `onItemFailed` is supplied, in which case it is
 * invoked and processing continues. Mirrors the old `mergeInsertRowsInBatches`.
 */
export async function adaptiveStorageBatch<T>(
  items: T[],
  initialBatchSize: number,
  processBatch: (batch: T[]) => Promise<void>,
  opts: {
    label: string;
    isRetryable?: (err: Error) => boolean;
    onItemFailed?: (batch: T[], err: Error) => void;
  },
): Promise<void> {
  const isRetryable = opts.isRetryable ?? isRetryableStorageError;
  const run = async (batch: T[], currentSize: number): Promise<void> => {
    try {
      await processBatch(batch);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (isRetryable(error) && currentSize > 1) {
        const half = Math.max(1, Math.floor(currentSize / 2));
        console.warn(
          `[vector-store] ${opts.label}: batch of ${batch.length} failed (${error.message}); retrying in sub-batches of ${half}`,
        );
        for (let i = 0; i < batch.length; i += half) {
          await run(batch.slice(i, i + half), half);
        }
        return;
      }
      if (opts.onItemFailed) {
        opts.onItemFailed(batch, error);
        return;
      }
      throw error;
    }
  };

  for (let i = 0; i < items.length; i += initialBatchSize) {
    await run(items.slice(i, i + initialBatchSize), initialBatchSize);
  }
}
