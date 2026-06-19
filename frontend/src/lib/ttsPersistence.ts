/**
 * Module-level registry that links a freshly-persisted TTS audio attachment
 * to the MessageAudioPlayer that's about to mount for it. Two responsibilities:
 *
 *   1. Signal the player to play its load-in animation (so the audio control
 *      doesn't pop in mid-chat and shove existing content).
 *   2. Optionally, after the animation completes, trigger playback through
 *      that player — used by the auto-play flow so the persistent player is
 *      the playback source for fresh generations (not the ephemeral
 *      in-memory engine).
 *
 * Markers expire after EXPIRATION_MS so a stale entry can't trigger a
 * surprise playback when the user navigates back to a chat they left during
 * synthesis. Consumption (mount-time) caches the result for a short window
 * so React StrictMode's double-invocation of useState initializers (and any
 * legitimate fast unmount→remount) gets the same marker on every call.
 */

export interface FreshAttachmentMarker {
  /** When true, the player auto-plays after its load-in animation finishes. */
  autoPlay: boolean
  /** Wall time (ms) when the marker was set; used for staleness pruning. */
  markedAt: number
}

const EXPIRATION_MS = 10_000

/**
 * After a marker is consumed, we keep it in a parallel cache for this many
 * ms so repeated consume() calls return the same value. This handles two
 * cases:
 *   • React StrictMode in dev double-invokes useState initializers,
 *     including ones whose factory call has side effects like ours. Without
 *     this window the second invocation gets null and the player's initial
 *     state ends up wrong (no animation, no auto-play on the regen flow).
 *   • A legitimate fast unmount→remount of the player (e.g. due to a
 *     parent re-key) shouldn't lose the marker either.
 */
const RECONSUME_WINDOW_MS = 500

interface ConsumedEntry {
  marker: FreshAttachmentMarker
  consumedAt: number
}

const markers = new Map<string, FreshAttachmentMarker>()
const recentlyConsumed = new Map<string, ConsumedEntry>()

export function markFreshlyAttached(
  messageId: string,
  opts: { autoPlay: boolean },
): void {
  markers.set(messageId, { autoPlay: opts.autoPlay, markedAt: Date.now() })
  // Clear any stale "recently consumed" entry for this id so a brand-new
  // marker isn't shadowed by the previous one's reconsume window.
  recentlyConsumed.delete(messageId)
}

/**
 * Read the marker for a message. Returns null when no marker is present or
 * it has expired.
 *
 * Idempotent within RECONSUME_WINDOW_MS: the first call removes the marker
 * from the active registry and stores it in recentlyConsumed; subsequent
 * calls for the same id within the window return that cached marker so
 * StrictMode replays and remount races don't lose it. After the window
 * passes, the entry is dropped from recentlyConsumed and further calls
 * return null.
 */
export function consumeFreshMarker(messageId: string): FreshAttachmentMarker | null {
  const now = Date.now()

  // 1. Recently-consumed cache hit — same caller (or StrictMode replay) is
  //    asking again, return the same marker.
  const recent = recentlyConsumed.get(messageId)
  if (recent && now - recent.consumedAt < RECONSUME_WINDOW_MS) {
    return recent.marker
  }
  if (recent) {
    // Window expired; clear it so future markers aren't shadowed.
    recentlyConsumed.delete(messageId)
  }

  // 2. Fresh consumption from the active registry.
  const marker = markers.get(messageId)
  if (!marker) return null
  markers.delete(messageId)

  if (now - marker.markedAt > EXPIRATION_MS) return null

  recentlyConsumed.set(messageId, { marker, consumedAt: now })
  // Schedule cleanup so the cache doesn't grow unbounded. The check inside
  // guards against deleting a newer entry written by markFreshlyAttached.
  setTimeout(() => {
    const cur = recentlyConsumed.get(messageId)
    if (cur && cur.consumedAt === now) recentlyConsumed.delete(messageId)
  }, RECONSUME_WINDOW_MS + 100)

  return marker
}

/** Test helper — clear all markers (active and recently-consumed). */
export function _resetFreshMarkers(): void {
  markers.clear()
  recentlyConsumed.clear()
}

// ─────────────────────────────────────────────────────────────────────────
// Regenerating registry — tracks which message ids currently have a
// save-first TTS regen in flight. The MessageAudioPlayer subscribes to
// this so it can pause + render a "regenerating" overlay without needing
// the parent to strip the attachment from the store (which would unmount
// the player and cause the row-height jump the chat virtualizer
// translates into a visible scroll shift).
//
// The set is mutated from useMessagePlayback.confirmRegen, and observed
// via useIsRegenerating in MessageAudioPlayer. Subscribers are notified
// synchronously after every set mutation so useSyncExternalStore stays
// consistent without extra render passes.

const regeneratingIds = new Set<string>()
const regeneratingListeners = new Set<() => void>()

function notifyRegeneratingListeners(): void {
  // Snapshot before iterating so a listener that re-subscribes during the
  // notification doesn't interfere with the current pass.
  for (const listener of Array.from(regeneratingListeners)) {
    try { listener() } catch (err) { console.warn('[ttsPersistence] regenerating listener threw:', err) }
  }
}

export function markRegenerating(messageId: string): void {
  if (regeneratingIds.has(messageId)) return
  regeneratingIds.add(messageId)
  notifyRegeneratingListeners()
}

export function clearRegenerating(messageId: string): void {
  if (!regeneratingIds.has(messageId)) return
  regeneratingIds.delete(messageId)
  notifyRegeneratingListeners()
}

export function isRegenerating(messageId: string): boolean {
  return regeneratingIds.has(messageId)
}

/**
 * Subscribe to regenerating-set changes. Returns the unsubscribe function.
 * Matches the useSyncExternalStore subscribe contract — the callback fires
 * any time the set mutates so React can re-render whichever components are
 * watching their own messageId.
 */
export function subscribeRegenerating(callback: () => void): () => void {
  regeneratingListeners.add(callback)
  return () => { regeneratingListeners.delete(callback) }
}
