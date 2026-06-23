/**
 * Global image decode cache for virtualized lists.
 *
 * When the virtualizer recycles a row, React unmounts the old `<img>` and
 * mounts a new one. Even if the bytes are in the HTTP cache, the browser must
 * re-decode the image — which takes 1-3 frames for large avatars, causing a
 * visible spinner flash during fast scrolling.
 *
 * This module pre-decodes images via `new Image()` + `.decode()` and retains
 * the HTMLImageElement, which keeps the decoded bitmap alive in the browser's
 * image cache. When the virtualizer's `<img>` element picks up the same src,
 * it paints synchronously from the decoded bitmap without re-decoding.
 */

const MAX_CACHE_SIZE = 400

/** Map of src -> settled HTMLImageElement (decoded bitmap retained). */
const cache = new Map<string, HTMLImageElement>()

/** Set of srcs currently being decoded. */
const pending = new Set<string>()

/** Subscribers waiting for a specific src to finish decoding. */
const subscribers = new Map<string, Set<() => void>>()

function notify(src: string) {
  const subs = subscribers.get(src)
  if (!subs) return
  subscribers.delete(src)
  for (const fn of subs) fn()
}

/**
 * Pre-decode an image and cache the result. Safe to call repeatedly — if the
 * src is already cached or pending, this is a no-op.
 *
 * Returns true if the image was already decoded (cache hit).
 */
export function prefetchImage(src: string): boolean {
  if (!src) return false
  if (cache.has(src)) {
    // Move to end (most-recently-used) for LRU eviction
    const img = cache.get(src)!
    cache.delete(src)
    cache.set(src, img)
    return true
  }
  if (pending.has(src)) return false

  pending.add(src)

  // Evict oldest entry if we're at capacity
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest !== undefined) cache.delete(oldest)
  }

  const img = new Image()
  img.decoding = 'async'

  img.onload = () => {
    pending.delete(src)
    cache.set(src, img)
    notify(src)
  }
  img.onerror = () => {
    pending.delete(src)
    // Don't cache errors — allow retry on next attempt
    notify(src)
  }

  img.src = src

  return false
}

/**
 * Pre-decode multiple images. Caps concurrency to avoid overwhelming the
 * network with simultaneous decodes on cold start.
 */
export function prefetchImages(srcs: string[], concurrency = 6): void {
  let index = 0
  let active = 0

  const next = () => {
    while (active < concurrency && index < srcs.length) {
      const src = srcs[index++]
      if (!src || cache.has(src) || pending.has(src)) continue
      active++
      const onDone = () => {
        active--
        next()
      }
      // prefetchImage fires onload/onerror asynchronously
      const wasCached = prefetchImage(src)
      if (wasCached) {
        active--
        next()
      } else {
        // Subscribe to know when it finishes
        if (!subscribers.has(src)) subscribers.set(src, new Set())
        subscribers.get(src)!.add(onDone)
      }
    }
  }

  next()
}

/** Check if a src is decoded and cached. */
export function isImageDecoded(src: string): boolean {
  return cache.has(src)
}

/**
 * Wait for a src to finish decoding. Calls `cb` immediately if already cached.
 * Returns an unsubscribe function.
 */
export function onImageDecoded(src: string, cb: () => void): () => void {
  if (cache.has(src)) {
    cb()
    return () => {}
  }
  if (!subscribers.has(src)) subscribers.set(src, new Set())
  subscribers.get(src)!.add(cb)
  return () => {
    const subs = subscribers.get(src)
    if (subs) {
      subs.delete(cb)
      if (subs.size === 0) subscribers.delete(src)
    }
  }
}

/** Clear the cache (e.g. on logout). */
export function clearImageCache(): void {
  cache.clear()
  pending.clear()
  subscribers.clear()
}
