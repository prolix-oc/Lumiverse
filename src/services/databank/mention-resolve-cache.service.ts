import type { ResolvedMention } from "./types";

const RESOLVE_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedResolve {
  result: ResolvedMention[];
  cachedAt: number;
}

// The one mention-resolution cache. Keeping its storage separate lets mutation
// boundaries invalidate it without introducing a CRUD → resolver import cycle.
const resolveCache = new Map<string, CachedResolve>();
const userCacheVersions = new Map<string, number>();
const chatCacheVersions = new Map<string, number>();

function chatCacheKey(userId: string, chatId: string): string {
  return `${userId}:${chatId}`;
}

export function getResolveCache(key: string): ResolvedMention[] | null {
  const cached = resolveCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > RESOLVE_CACHE_TTL_MS) {
    resolveCache.delete(key);
    return null;
  }
  return cached.result;
}

export function getResolveCacheVersion(userId: string, chatId: string): string {
  return `${userCacheVersions.get(userId) ?? 0}:${chatCacheVersions.get(chatCacheKey(userId, chatId)) ?? 0}`;
}

export function setResolveCache(
  key: string,
  result: ResolvedMention[],
  userId: string,
  chatId: string,
  version: string,
): void {
  if (getResolveCacheVersion(userId, chatId) !== version) return;
  resolveCache.set(key, { result, cachedAt: Date.now() });
}

/** Drop cached resolutions for a user+chat. */
export function clearResolveCache(userId: string, chatId: string): void {
  const prefix = `${userId}:${chatId}:`;
  for (const key of resolveCache.keys()) {
    if (key.startsWith(prefix)) resolveCache.delete(key);
  }
  const scope = chatCacheKey(userId, chatId);
  chatCacheVersions.set(scope, (chatCacheVersions.get(scope) ?? 0) + 1);
}

/** Drop every cached resolution for a user after any document/bank mutation. */
export function clearResolveCacheForUser(userId: string): void {
  const prefix = `${userId}:`;
  for (const key of resolveCache.keys()) {
    if (key.startsWith(prefix)) resolveCache.delete(key);
  }
  userCacheVersions.set(userId, (userCacheVersions.get(userId) ?? 0) + 1);
}
