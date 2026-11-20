export const TOKEN_CACHE_MAX_ENTRIES = 2_000

export type TokenCountCacheKey = string

export interface TokenCountValue {
  count: number
  approximate: boolean
  model: string
  contentLength: number
}

type TokenCountCacheListener = () => void

const tokenCountCache = new Map<TokenCountCacheKey, TokenCountValue>()
const tokenCountCacheListeners = new Set<TokenCountCacheListener>()
let tokenCountCacheVersion = 0

/** Return the stable, fixed-width FNV-1a hash for UTF-16 string contents. */
export function fnv1a32(text: string): string {
  if (typeof text !== 'string') {
    throw new TypeError('Token count cache content must be a string')
  }

  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Build a cache key without retaining the content it identifies. */
export function makeTokenCountCacheKey(model: string, content: string): TokenCountCacheKey {
  if (typeof model !== 'string') {
    throw new TypeError('Token count cache model must be a string')
  }

  return `${model}:${content.length}:${fnv1a32(content)}`
}

/** Read and promote a cached record to the most-recently-read position. */
export function getTokenCount(key: TokenCountCacheKey): TokenCountValue | undefined {
  const value = tokenCountCache.get(key)
  if (!value) return undefined

  tokenCountCache.delete(key)
  tokenCountCache.set(key, value)
  return value
}

/** Read a cached record without changing its LRU position. Safe during render. */
export function peekTokenCountByKey(key: TokenCountCacheKey): TokenCountValue | undefined {
  return tokenCountCache.get(key)
}

/** Insert or update a cache record and make it most recently read. */
export function setTokenCount(key: TokenCountCacheKey, value: TokenCountValue): void {
  assertTokenCountCacheKey(key)
  const nextValue = normalizeTokenCountValue(value)
  const previousValue = tokenCountCache.get(key)

  if (previousValue && areTokenCountValuesEqual(previousValue, nextValue)) {
    tokenCountCache.delete(key)
    tokenCountCache.set(key, previousValue)
    return
  }

  tokenCountCache.delete(key)
  tokenCountCache.set(key, nextValue)
  if (tokenCountCache.size > TOKEN_CACHE_MAX_ENTRIES) {
    const leastRecentlyRead = tokenCountCache.keys().next().value
    if (leastRecentlyRead !== undefined) tokenCountCache.delete(leastRecentlyRead)
  }

  publishTokenCountCacheMutation()
}

/** Remove a cache record when present. */
export function deleteTokenCount(key: TokenCountCacheKey): void {
  if (!tokenCountCache.delete(key)) return
  publishTokenCountCacheMutation()
}

/** Promote an existing cache record without notifying subscribers. */
export function touchTokenCount(key: TokenCountCacheKey): void {
  const value = tokenCountCache.get(key)
  if (!value) return

  tokenCountCache.delete(key)
  tokenCountCache.set(key, value)
}

/** Clear every cached record. Repeated clears are no-ops. */
export function clearTokenCountCache(): void {
  if (tokenCountCache.size === 0) return
  tokenCountCache.clear()
  publishTokenCountCacheMutation()
}

/** Subscribe to visible cache mutations. The returned unsubscribe is idempotent. */
export function subscribeTokenCountCache(listener: TokenCountCacheListener): () => void {
  tokenCountCacheListeners.add(listener)
  let subscribed = true

  return () => {
    if (!subscribed) return
    subscribed = false
    tokenCountCacheListeners.delete(listener)
  }
}

/** Return the monotonically increasing external-store snapshot version. */
export function getTokenCountCacheVersion(): number {
  return tokenCountCacheVersion
}

function assertTokenCountCacheKey(key: TokenCountCacheKey): void {
  if (typeof key !== 'string') {
    throw new TypeError('Token count cache key must be a string')
  }
}

function normalizeTokenCountValue(value: TokenCountValue): TokenCountValue {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Token count cache value must be an object')
  }
  if (!Number.isFinite(value.count) || value.count < 0 || !Number.isInteger(value.count)) {
    throw new TypeError('Token count cache count must be a finite non-negative integer')
  }
  if (typeof value.approximate !== 'boolean') {
    throw new TypeError('Token count cache approximate flag must be a boolean')
  }
  if (typeof value.model !== 'string') {
    throw new TypeError('Token count cache model must be a string')
  }
  if (
    !Number.isFinite(value.contentLength) ||
    value.contentLength < 0 ||
    !Number.isInteger(value.contentLength)
  ) {
    throw new TypeError('Token count cache content length must be a finite non-negative integer')
  }

  return Object.freeze({
    count: value.count,
    approximate: value.approximate,
    model: value.model,
    contentLength: value.contentLength,
  }) as TokenCountValue
}

function areTokenCountValuesEqual(left: TokenCountValue, right: TokenCountValue): boolean {
  return (
    left.count === right.count &&
    left.approximate === right.approximate &&
    left.model === right.model &&
    left.contentLength === right.contentLength
  )
}

function publishTokenCountCacheMutation(): void {
  tokenCountCacheVersion += 1
  for (const listener of Array.from(tokenCountCacheListeners)) {
    try {
      listener()
    } catch {
      // A subscriber cannot prevent other external-store subscribers from updating.
    }
  }
}
