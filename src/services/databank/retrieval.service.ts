/**
 * Databank Retrieval Service — Vector search across active banks + result caching.
 *
 * Follows the Memory Cortex warm-cache pattern: pre-flight async search,
 * synchronous cache consumption in the assembly hot path.
 */

import * as embeddingsSvc from "../embeddings.service";
import * as crud from "./databank-crud.service";
import type { DatabankRetrievalResult, DatabankSearchResult } from "./types";

// ─── Cache ────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedResult {
  result: DatabankRetrievalResult;
  cachedAt: number;
}

const resultCache = new Map<string, CachedResult>();

function cacheKey(userId: string, chatId: string, limit: number): string {
  return `${userId}:${chatId}:${limit}`;
}

/**
 * Get cached result for a chat (synchronous, for assembly hot path).
 * Keys include userId so a DB restore that reused chatIds across users (or
 * any future test fixture re-using chat ids) can never serve another user's
 * results from the in-memory cache.
 */
export function getCachedDatabankResult(userId: string, chatId: string, limit: number): DatabankRetrievalResult | null {
  const key = cacheKey(userId, chatId, limit);
  const cached = resultCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
    resultCache.delete(key);
    return null;
  }
  return cached.result;
}

export function clearCache(userId: string, chatId: string): void {
  const prefix = `${userId}:${chatId}:`;
  for (const key of resultCache.keys()) {
    if (key.startsWith(prefix)) resultCache.delete(key);
  }
}

// ─── Search ───────────────────────────────────────────────────

const DEFAULT_HEADER = "[Relevant reference material from the user's knowledge bank]";
const DEFAULT_SEPARATOR = "\n---\n";

/**
 * Search active databanks by vector similarity. Caches result for assembly consumption.
 *
 * `onTiming` (optional) is invoked with sub-phase wall times so the prompt
 * profiler can attribute the cost between the embedding round-trip and the
 * LanceDB hybrid search. The callback fires even when the call aborts or
 * returns early — partial timings still tell us what was waiting.
 */
export async function searchDatabanks(
  userId: string,
  chatId: string,
  databankIds: string[],
  queryText: string,
  limit = 4,
  signal?: AbortSignal,
  onTiming?: (phase: string, ms: number) => void,
): Promise<DatabankRetrievalResult> {
  if (databankIds.length === 0) {
    return { chunks: [], formatted: "", count: 0 };
  }

  // Skip everything — most importantly the query embedding round-trip — when
  // the active banks hold nothing searchable. An attached-but-empty databank
  // would otherwise pay ~500ms to embed a query against zero chunks.
  if (!crud.hasSearchableChunks(userId, databankIds)) {
    return { chunks: [], formatted: "", count: 0 };
  }

  try {
    if (signal?.aborted) return { chunks: [], formatted: "", count: 0 };

    // Embed the query
    const embedStart = performance.now();
    const [queryVector] = await embeddingsSvc.cachedEmbedTexts(userId, [queryText], { signal });
    onTiming?.("databank-embed", performance.now() - embedStart);
    if (signal?.aborted) return { chunks: [], formatted: "", count: 0 };

    // Search LanceDB
    const searchStart = performance.now();
    const raw = await embeddingsSvc.searchDatabankChunks(userId, databankIds, queryVector, limit, queryText, signal);
    onTiming?.("databank-lancedb", performance.now() - searchStart);

    const chunks: DatabankSearchResult[] = raw.map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.metadata?.documentId ?? "",
      databankId: r.metadata?.databankId ?? "",
      documentName: r.metadata?.documentName ?? "Unknown",
      content: r.content,
      score: r.score,
      metadata: r.metadata,
    }));

    const formatted = formatResult(chunks);
    const result: DatabankRetrievalResult = { chunks, formatted, count: chunks.length };

    // Cache for synchronous consumption — but not when the caller aborted.
    // A truncated or abort-interrupted result shouldn't poison the next
    // generation's warm cache.
    if (!signal?.aborted) {
      resultCache.set(cacheKey(userId, chatId, limit), { result, cachedAt: Date.now() });
    }

    return result;
  } catch (err) {
    if (signal?.aborted) return { chunks: [], formatted: "", count: 0 };
    console.warn("[databank] Search failed:", err);
    return { chunks: [], formatted: "", count: 0 };
  }
}

/**
 * Direct vector search (no caching). Used for the /search API endpoint.
 */
export async function searchDirect(
  userId: string,
  databankIds: string[],
  query: string,
  limit = 8,
): Promise<DatabankSearchResult[]> {
  if (databankIds.length === 0) return [];

  const [queryVector] = await embeddingsSvc.cachedEmbedTexts(userId, [query]);
  const raw = await embeddingsSvc.searchDatabankChunks(userId, databankIds, queryVector, limit, query);

  return raw.map((r) => ({
    chunkId: r.chunk_id,
    documentId: r.metadata?.documentId ?? "",
    databankId: r.metadata?.databankId ?? "",
    documentName: r.metadata?.documentName ?? "Unknown",
    content: r.content,
    score: r.score,
    metadata: r.metadata,
  }));
}

function formatResult(chunks: DatabankSearchResult[]): string {
  if (chunks.length === 0) return "";

  const sections = chunks.map((c) => {
    const header = `[Source: ${c.documentName}]`;
    return `${header}\n${c.content}`;
  });

  return `${DEFAULT_HEADER}\n${sections.join(DEFAULT_SEPARATOR)}`;
}
