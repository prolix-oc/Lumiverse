import { acquireIOSMediaImage, type IOSMediaLease } from './ios-media-cache'

/**
 * Short-lived image decode coordinator for virtualized lists.
 *
 * Compressed storage belongs to the browser HTTP cache or the optional iOS
 * media cache; decoded bitmap eviction belongs to the browser. Keeping detached
 * HTMLImageElements in JavaScript pins their decoded pixels and prevents the
 * browser from responding to memory pressure.
 *
 * We only retain:
 *   - images while a near-viewport predecode is in flight; and
 *   - a tightly bounded, expiring route-transition bridge; and
 *   - a small LRU of URL/timestamp metadata to suppress spinner flicker when a
 *     virtualized row remounts shortly after it was decoded.
 */

const MAX_RECENTLY_DECODED = 500
const RECENTLY_DECODED_TTL_MS = 2 * 60 * 1000
const MAX_PREFETCH_QUEUE = 48
const DEFAULT_PREFETCH_CONCURRENCY = 4
const MAX_PREFETCH_CONCURRENCY = 6
const MAX_TRANSITION_HELD_IMAGES = 8
const TRANSITION_HOLD_MS = 4_000

const recentlyDecoded = new Map<string, number>()
const pending = new Map<string, Promise<boolean>>()
const subscribers = new Map<string, Set<() => void>>()
const queued = new Set<string>()
const transitionHeld = new Map<string, {
  image: HTMLImageElement
  timer: ReturnType<typeof setTimeout>
  lease?: IOSMediaLease | null
}>()
let prefetchQueue: string[] = []
let activePrefetches = 0
let prefetchConcurrency = DEFAULT_PREFETCH_CONCURRENCY
let cacheGeneration = 0

function releaseTransitionImage(src: string) {
  const held = transitionHeld.get(src)
  if (!held) return
  clearTimeout(held.timer)
  held.image.onload = null
  held.image.onerror = null
  held.lease?.release()
  transitionHeld.delete(src)
}

function notify(src: string) {
  const callbacks = subscribers.get(src)
  if (!callbacks) return
  subscribers.delete(src)
  for (const callback of callbacks) callback()
}

function pruneRecentlyDecoded(now: number) {
  for (const [src, decodedAt] of recentlyDecoded) {
    if (now - decodedAt <= RECENTLY_DECODED_TTL_MS) break
    recentlyDecoded.delete(src)
  }

  while (recentlyDecoded.size > MAX_RECENTLY_DECODED) {
    const oldest = recentlyDecoded.keys().next().value as string | undefined
    if (oldest === undefined) break
    recentlyDecoded.delete(oldest)
  }
}

/** Record a successful decode without retaining the bitmap itself. */
export function rememberImageDecoded(src: string): void {
  if (!src) return
  const now = Date.now()
  recentlyDecoded.delete(src)
  recentlyDecoded.set(src, now)
  pruneRecentlyDecoded(now)
  notify(src)
}

/**
 * Whether an image decoded recently enough that a remounted row should avoid
 * flashing its loading spinner. This is a presentation hint, not a bitmap
 * cache: the browser remains free to evict the actual decoded pixels.
 */
export function isImageDecoded(src: string): boolean {
  const decodedAt = recentlyDecoded.get(src)
  if (decodedAt === undefined) return false

  const now = Date.now()
  if (now - decodedAt > RECENTLY_DECODED_TTL_MS) {
    recentlyDecoded.delete(src)
    return false
  }

  recentlyDecoded.delete(src)
  recentlyDecoded.set(src, now)
  return true
}

function decodeImage(src: string): Promise<boolean> {
  if (isImageDecoded(src)) return Promise.resolve(true)

  const inflight = pending.get(src)
  if (inflight) return inflight

  const generation = cacheGeneration
  const image = new Image()
  image.decoding = 'async'
  const lease = acquireIOSMediaImage(src)
  const start = (url: string) => {
    if (generation !== cacheGeneration) return Promise.reject(new Error('Image prefetch expired'))
    image.src = url
    return typeof image.decode === 'function' ? image.decode() : new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('Image failed to load'))
      })
  }
  const decode = lease ? lease.ready.then(start) : start(src)

  const task = decode
    .then(() => {
      if (generation !== cacheGeneration) return false
      rememberImageDecoded(src)
      return true
    })
    .catch(() => false)
    .finally(() => {
      image.onload = null
      image.onerror = null
      lease?.release()
      if (pending.get(src) === task) pending.delete(src)
      notify(src)
    })

  pending.set(src, task)
  return task
}

/** Start one immediate predecode. Returns true for a recent metadata hit. */
export function prefetchImage(src: string): boolean {
  if (!src) return false
  if (isImageDecoded(src)) return true
  void decodeImage(src)
  return false
}

function pumpPrefetchQueue() {
  while (activePrefetches < prefetchConcurrency && prefetchQueue.length > 0) {
    const src = prefetchQueue.shift()
    if (!src) continue
    queued.delete(src)
    if (isImageDecoded(src) || pending.has(src)) continue

    activePrefetches += 1
    void decodeImage(src).finally(() => {
      activePrefetches = Math.max(0, activePrefetches - 1)
      pumpPrefetchQueue()
    })
  }
}

/**
 * Predecode images near the viewport. New ranges are placed ahead of stale
 * queued work, the queue is bounded, and concurrency is global so several
 * components cannot create unbounded overlapping decode batches.
 */
export function prefetchImages(srcs: string[], concurrency = DEFAULT_PREFETCH_CONCURRENCY): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return

  prefetchConcurrency = Math.max(1, Math.min(MAX_PREFETCH_CONCURRENCY, Math.floor(concurrency)))

  const next: string[] = []
  for (const src of srcs) {
    if (!src || queued.has(src) || pending.has(src) || isImageDecoded(src)) continue
    queued.add(src)
    next.push(src)
  }

  // The newest viewport range is more useful than work queued by an older
  // scroll position, while preserving the caller's ordering within the range.
  prefetchQueue = [...next, ...prefetchQueue]
  if (prefetchQueue.length > MAX_PREFETCH_QUEUE) {
    const dropped = prefetchQueue.splice(MAX_PREFETCH_QUEUE)
    for (const src of dropped) queued.delete(src)
  }

  pumpPrefetchQueue()
}

/**
 * Keep a small decoded-image bridge alive across one route transition.
 *
 * This intentionally differs from the normal prefetch path: holding the
 * HTMLImageElement briefly prevents WebKit/Blink from evicting its decoded
 * surface between the chat unmount and the landing card's first paint.
 */
export function holdImagesForTransition(srcs: string[], holdMs = TRANSITION_HOLD_MS): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  if (typeof Image === 'undefined') {
    prefetchImages(srcs)
    return
  }

  const unique = [...new Set(srcs.filter(Boolean))].slice(0, MAX_TRANSITION_HELD_IMAGES)
  for (const src of unique) {
    releaseTransitionImage(src)

    while (transitionHeld.size >= MAX_TRANSITION_HELD_IMAGES) {
      const oldest = transitionHeld.keys().next().value as string | undefined
      if (!oldest) break
      releaseTransitionImage(oldest)
    }

    const generation = cacheGeneration
    const image = new Image()
    image.decoding = 'async'
    if ('fetchPriority' in image) image.fetchPriority = 'high'
    const lease = acquireIOSMediaImage(src)
    const start = (url: string) => {
      // A transition may have expired while its cache lookup was pending.
      if (generation !== cacheGeneration || transitionHeld.get(src)?.image !== image) return Promise.reject(new Error('Transition expired'))
      image.src = url
      return typeof image.decode === 'function' ? image.decode() : new Promise<void>((resolve, reject) => {
          image.onload = () => resolve()
          image.onerror = () => reject(new Error('Image failed to load'))
        })
    }

    const timer = setTimeout(() => releaseTransitionImage(src), Math.max(250, holdMs))
    transitionHeld.set(src, { image, timer, lease })
    const decode = lease ? lease.ready.then(start) : start(src)
    void decode.then(() => {
      if (generation === cacheGeneration) rememberImageDecoded(src)
    }).catch(() => {})
  }
}

/** Subscribe to completion of an in-flight near-viewport decode. */
export function onImageDecoded(src: string, callback: () => void): () => void {
  if (isImageDecoded(src)) {
    callback()
    return () => {}
  }

  if (!subscribers.has(src)) subscribers.set(src, new Set())
  subscribers.get(src)!.add(callback)
  return () => {
    const callbacks = subscribers.get(src)
    if (!callbacks) return
    callbacks.delete(callback)
    if (callbacks.size === 0) subscribers.delete(src)
  }
}

/** Clear lightweight state and disregard any decode that finishes afterward. */
export function clearImageCache(): void {
  cacheGeneration += 1
  recentlyDecoded.clear()
  subscribers.clear()
  pending.clear()
  queued.clear()
  for (const src of [...transitionHeld.keys()]) releaseTransitionImage(src)
  prefetchQueue = []
}
