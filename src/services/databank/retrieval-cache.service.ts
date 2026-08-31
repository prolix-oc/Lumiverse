import type { DatabankRetrievalResult } from "./types";
import { clearResolveCacheForUser } from "./mention-resolve-cache.service";

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 256;

interface CachedResult {
  result: DatabankRetrievalResult;
  cachedAt: number;
  userId: string;
  chatId: string;
  databankIds: string[];
}

const resultCache = new Map<string, CachedResult>();

function pruneResultCache(now: number): void {
  for (const [key, cached] of resultCache) {
    if (now - cached.cachedAt > CACHE_TTL_MS) resultCache.delete(key);
  }

  while (resultCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = resultCache.keys().next().value;
    if (oldestKey === undefined) break;
    resultCache.delete(oldestKey);
  }
}

export function databankCacheKey(
  userId: string,
  chatId: string,
  databankIds: string[],
  queryText: string,
  limit: number,
): string {
  return JSON.stringify([userId, chatId, limit, [...databankIds].sort(), queryText]);
}

export function getCachedDatabankResult(
  userId: string,
  chatId: string,
  databankIds: string[],
  queryText: string,
  limit: number,
): DatabankRetrievalResult | null {
  const key = databankCacheKey(userId, chatId, databankIds, queryText, limit);
  const cached = resultCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
    resultCache.delete(key);
    return null;
  }
  resultCache.delete(key);
  resultCache.set(key, cached);
  return cached.result;
}

export function setCachedDatabankResult(
  userId: string,
  chatId: string,
  databankIds: string[],
  queryText: string,
  limit: number,
  result: DatabankRetrievalResult,
): void {
  const key = databankCacheKey(userId, chatId, databankIds, queryText, limit);
  const now = Date.now();
  resultCache.delete(key);
  pruneResultCache(now);
  resultCache.set(key, {
    result,
    cachedAt: now,
    userId,
    chatId,
    databankIds: [...databankIds],
  });
}

export function clearCache(userId: string, chatId: string): void {
  for (const [key, cached] of resultCache.entries()) {
    if (cached.userId === userId && cached.chatId === chatId) resultCache.delete(key);
  }
}

/** Invalidate every cached query that could contain content from this bank. */
export function invalidateDatabankCache(userId: string, databankId: string): void {
  for (const [key, cached] of resultCache.entries()) {
    if (cached.userId === userId && cached.databankIds.includes(databankId)) {
      resultCache.delete(key);
    }
  }
}

/**
 * Invalidate every native Databank cache after a bank/document mutation.
 * Mention results are keyed by user/chat rather than bank, so clear all of
 * that user's mention resolutions while the retrieval cache stays bank-scoped.
 */
export function invalidateDatabankCaches(userId: string, databankId: string): void {
  invalidateDatabankCache(userId, databankId);
  clearResolveCacheForUser(userId);
}

/** Drop every reconstructable retrieval result. */
export function clearAllDatabankCache(): void {
  resultCache.clear();
}

/** Test-only alias for keeping module-global cache state isolated. */
export const resetDatabankCacheForTests = clearAllDatabankCache;
