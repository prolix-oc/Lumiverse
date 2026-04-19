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

function cacheKey(userId: string, chatId: string): string {
  return `${userId}:${chatId}`;
}

/**
 * Get cached result for a chat (synchronous, for assembly hot path).
 * Keys include userId so a DB restore that reused chatIds across users (or
 * any future test fixture re-using chat ids) can never serve another user's
 * results from the in-memory cache.
 */
export function getCachedDatabankResult(userId: string, chatId: string): DatabankRetrievalResult | null {
  const cached = resultCache.get(cacheKey(userId, chatId));
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
    resultCache.delete(cacheKey(userId, chatId));
    return null;
  }
  return cached.result;
}

export function clearCache(userId: string, chatId: string): void {
  resultCache.delete(cacheKey(userId, chatId));
}

// ─── Search ───────────────────────────────────────────────────

const DEFAULT_HEADER = "[Relevant reference material from the user's knowledge bank]";
const DEFAULT_SEPARATOR = "\n---\n";

/**
 * Search active databanks by vector similarity. Caches result for assembly consumption.
 */
export async function searchDatabanks(
  userId: string,
  chatId: string,
  databankIds: string[],
  queryText: string,
  limit = 4,
  signal?: AbortSignal,
): Promise<DatabankRetrievalResult> {
  if (databankIds.length === 0) {
    return { chunks: [], formatted: "", count: 0 };
  }

  try {
    if (signal?.aborted) return { chunks: [], formatted: "", count: 0 };

    // Embed the query
    const [queryVector] = await embeddingsSvc.cachedEmbedTexts(userId, [queryText], { signal });
    if (signal?.aborted) return { chunks: [], formatted: "", count: 0 };

    // Search LanceDB
    const raw = await embeddingsSvc.searchDatabankChunks(userId, databankIds, queryVector, limit, queryText, signal);

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
      resultCache.set(cacheKey(userId, chatId), { result, cachedAt: Date.now() });
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
