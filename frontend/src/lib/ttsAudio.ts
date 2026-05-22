/**
 * TTS AudioContext playback pipeline.
 *
 * Uses Web Audio API for precise volume/speed control and sequential
 * queue management. Separate from the notification HTMLAudioElement
 * singleton in notificationAudio.ts.
 *
 * Call unlockTTSAudio() during a user gesture (e.g. send button click)
 * to create/resume the AudioContext.
 */

let ctx: AudioContext | null = null
let gainNode: GainNode | null = null
/**
 * Most recently scheduled source. `stop()` and `setTTSSpeed()` poke at it.
 * NOT a "what's playing right now" pointer — once `drainQueue()` schedules
 * a chain of sources, several may be queued on the audio clock at once.
 */
let lastScheduledSource: AudioBufferSourceNode | null = null
/** Live sources scheduled but not yet `onended`. Drives end-of-playback. */
let scheduledSources = new Set<AudioBufferSourceNode>()
/**
 * Pre-decoded buffers waiting to be scheduled. Decoding happens on enqueue
 * so `drainQueue()` can immediately schedule each new buffer at the prior
 * buffer's predicted end-time — sample-accurate gapless playback even
 * across voice changes mid-message.
 */
let queue: AudioBuffer[] = []
let playing = false
let paused = false
let volume = 0.8
let speed = 1.0
/**
 * AudioContext time at which the last-scheduled source will finish. Each
 * new schedule uses `max(currentTime, nextStartTime)` as its start, so
 * back-to-back buffers butt cleanly without overlapping or gapping.
 */
let nextStartTime = 0
/**
 * Generation token for the active playback session. Bumped by `stop()` so
 * any in-flight decode/synth promises that resolve after the stop don't
 * leak into a new session.
 */
let session = 0

let onStartCb: (() => void) | null = null
let onEndCb: (() => void) | null = null
let onErrorCb: ((err: Error) => void) | null = null

/**
 * Id of the message currently owning the playback queue, or null when idle.
 * Bubble action bars subscribe to this to flip their Play button into Stop
 * and to make sure only one message shows the "playing" state at a time.
 */
let activeId: string | null = null
const activeListeners = new Set<() => void>()

function notifyActive(): void {
  activeListeners.forEach((cb) => {
    try { cb() } catch { /* listener failure shouldn't break playback */ }
  })
}

function setActiveId(id: string | null): void {
  if (activeId === id) return
  activeId = id
  notifyActive()
}

export function getActiveMessageId(): string | null {
  return activeId
}

export function subscribeActiveMessage(cb: () => void): () => void {
  activeListeners.add(cb)
  return () => { activeListeners.delete(cb) }
}

function ensureContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    gainNode = ctx.createGain()
    gainNode.gain.value = volume
    gainNode.connect(ctx.destination)
  }
  return ctx
}

/** Tracks whether we've successfully pushed any audio through the context yet. */
let hasPlayedSilentUnlock = false

/**
 * Create/resume the AudioContext AND push a single silent buffer through it.
 *
 * Safari/iOS treat `AudioContext.resume()` alone as insufficient — the context
 * must actually produce output during a user gesture before later automated
 * playback is permitted. Playing a zero-duration silent buffer satisfies that
 * requirement on every browser without being audible.
 *
 * Safe to call repeatedly; the silent-buffer prime only runs once.
 */
export function unlockTTSAudio(): void {
  const c = ensureContext()
  if (c.state === 'suspended') {
    c.resume().catch(() => {})
  }
  if (hasPlayedSilentUnlock) return
  try {
    // 1 frame of silence is enough to prime the context in every browser.
    const buffer = c.createBuffer(1, 1, c.sampleRate)
    const source = c.createBufferSource()
    source.buffer = buffer
    // Route through the gain node so the graph matches real playback.
    source.connect(gainNode ?? c.destination)
    source.start(0)
    hasPlayedSilentUnlock = true
  } catch {
    // If priming fails (rare), leave the flag false so we try again on the next gesture.
  }
}

/**
 * Register one-time document-level listeners that call `unlockTTSAudio()` on
 * the first user interaction anywhere in the app. Covers paths that don't
 * already explicitly unlock (swipe, regenerate, continue, keyboard-only sends
 * that bypass the send button, etc.) and lets auto-play fire even when the
 * user never clicked the Send button.
 *
 * Returns a disposer so callers can remove the listeners early if needed.
 */
export function installTTSAudioPrimer(): () => void {
  if (typeof document === 'undefined') return () => {}

  const events: (keyof DocumentEventMap)[] = ['pointerdown', 'keydown', 'touchstart']
  let disposed = false

  const handler = () => {
    if (disposed) return
    unlockTTSAudio()
    dispose()
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const e of events) document.removeEventListener(e, handler, true)
  }

  // Capture phase so extensions or portals that stopPropagation don't swallow us.
  // Passive so we never block scrolling on touchstart.
  for (const e of events) {
    document.addEventListener(e, handler, { capture: true, passive: true })
  }

  return dispose
}

export function setTTSVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v))
  if (gainNode) {
    gainNode.gain.value = volume
  }
}

export function setTTSSpeed(s: number): void {
  speed = Math.max(0.25, Math.min(4, s))
  // Apply to every already-scheduled source so the speed change takes
  // effect across the whole queue, not just whatever's playing right now.
  // The prediction of `nextStartTime` was computed against the old speed,
  // so a small overlap or gap is possible at the next transition — bounded
  // and inaudible at typical (0.5–2x) speed steps.
  for (const src of scheduledSources) {
    src.playbackRate.value = speed
  }
}

/**
 * Schedule every buffer currently in `queue` against `nextStartTime`. Each
 * source is started immediately on the audio clock, so consecutive buffers
 * play sample-accurately back-to-back without waiting on JS `onended`
 * dispatch (which can spike to 16ms+ under load).
 */
function drainQueue(): void {
  if (paused) return
  const c = ensureContext()
  while (queue.length > 0) {
    const buffer = queue.shift()!
    const source = c.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = speed
    source.connect(gainNode!)

    scheduledSources.add(source)
    source.onended = () => {
      scheduledSources.delete(source)
      // End-of-playback fires when nothing is scheduled, the queue is empty,
      // and no producer is still feeding us. `playing` is the producer-side
      // flag — callers (`speak`, `speakSegments`) set it true on first push
      // and clear it themselves when they know no more buffers are coming.
      if (scheduledSources.size === 0 && queue.length === 0 && !pendingProducers) {
        playing = false
        nextStartTime = 0
        lastScheduledSource = null
        setActiveId(null)
        onEndCb?.()
      }
    }

    const now = c.currentTime
    const startAt = Math.max(now, nextStartTime)
    // playbackRate compresses or stretches the buffer's wall-clock duration,
    // so divide to predict the actual end time on the audio clock.
    const dur = buffer.duration / (speed || 1)
    nextStartTime = startAt + dur
    lastScheduledSource = source
    source.start(startAt)
  }
}

/**
 * Number of producers (in-flight decode chains, pending segment slots) that
 * still expect to push buffers. End-of-playback is suppressed while > 0 so
 * a brief queue-empty window between segments doesn't fire `onEndCb` early.
 */
let pendingProducers = 0

/**
 * Internal: decode an ArrayBuffer to an AudioBuffer.
 */
async function decodeArrayBuffer(audioData: ArrayBuffer): Promise<AudioBuffer> {
  const c = ensureContext()
  // decodeAudioData detaches the input on some browsers — slice() gives it a
  // private copy so callers can keep their original ArrayBuffer.
  return await c.decodeAudioData(audioData.slice(0))
}

function startPlaybackSession(): void {
  if (!playing) {
    playing = true
    paused = false
    nextStartTime = 0
    onStartCb?.()
  }
}

/**
 * Chain of in-flight decode operations. Decoded buffers are pushed to the
 * playback queue in chain order so back-to-back `speak()` calls preserve
 * caller order even when individual decodes race.
 */
let decodeChain: Promise<void> = Promise.resolve()

/**
 * Enqueue raw audio bytes for sequential playback.
 * Pass `messageId` to tag this playback so per-message UI can reflect
 * a "this message is playing" state.
 *
 * Decoding happens off the playback path. Every successfully-decoded buffer
 * is immediately scheduled against the previous one's end time, giving
 * sample-accurate gapless transitions.
 */
export function speak(audioData: ArrayBuffer, messageId?: string): void {
  if (messageId !== undefined) {
    setActiveId(messageId)
  }
  startPlaybackSession()
  pendingProducers++
  const mySession = session
  decodeChain = decodeChain.then(async () => {
    if (mySession !== session) {
      pendingProducers--
      return
    }
    try {
      const buffer = await decodeArrayBuffer(audioData)
      if (mySession !== session) {
        pendingProducers--
        return
      }
      queue.push(buffer)
      pendingProducers--
      drainQueue()
    } catch (err) {
      pendingProducers--
      onErrorCb?.(err instanceof Error ? err : new Error(String(err)))
      // If we were the last in-flight producer and nothing is queued/playing,
      // fire end so listeners reset.
      maybeFireEnd()
    }
  })
}

/**
 * Multi-segment playback. Accepts a list of synthesis promises that resolve
 * to raw audio bytes, in PLAYBACK ORDER. The function preserves order even
 * when individual promises resolve out-of-order (parallel TTS calls of
 * varying length), by holding a pending-slots map and flushing into the
 * queue in strict index order as each prior slot lands.
 *
 * Decoded buffers feed the same scheduled queue as `speak()`, so transitions
 * across voices remain gapless.
 */
export function speakSegments(
  segments: Array<Promise<ArrayBuffer | null>>,
  messageId?: string,
): void {
  if (segments.length === 0) return
  if (messageId !== undefined) {
    setActiveId(messageId)
  }
  startPlaybackSession()

  // One producer slot per segment — drops to 0 as each slot is flushed
  // (whether with audio or with a null/skip).
  pendingProducers += segments.length

  const mySession = session
  const pending = new Map<number, AudioBuffer | null>()
  let nextIndex = 0

  const flush = () => {
    while (pending.has(nextIndex)) {
      const buf = pending.get(nextIndex)!
      pending.delete(nextIndex)
      nextIndex++
      pendingProducers--
      if (buf) queue.push(buf)
    }
    drainQueue()
    maybeFireEnd()
  }

  segments.forEach((p, i) => {
    p.then(async (data) => {
      if (mySession !== session) return
      if (!data) {
        pending.set(i, null)
        flush()
        return
      }
      try {
        const buffer = await decodeArrayBuffer(data)
        if (mySession !== session) return
        pending.set(i, buffer)
        flush()
      } catch (err) {
        onErrorCb?.(err instanceof Error ? err : new Error(String(err)))
        pending.set(i, null)
        flush()
      }
    }).catch((err) => {
      if (mySession !== session) return
      onErrorCb?.(err instanceof Error ? err : new Error(String(err)))
      pending.set(i, null)
      flush()
    })
  })
}

/**
 * Fire `onEnd` if no source is scheduled, the queue is empty, and no
 * producer is still in-flight. Used when a producer rejects with nothing
 * pushed — we'd otherwise hang in `playing=true` forever.
 */
function maybeFireEnd(): void {
  if (
    playing
    && scheduledSources.size === 0
    && queue.length === 0
    && pendingProducers === 0
  ) {
    playing = false
    nextStartTime = 0
    lastScheduledSource = null
    setActiveId(null)
    onEndCb?.()
  }
}

/** Consume a streaming Response and play it as a single buffer. */
export async function speakStream(response: Response): Promise<void> {
  if (!response.body) {
    throw new Error('No response body for streaming TTS')
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalLength = 0

  // Accumulate all chunks then play as a single buffer
  // (AudioContext.decodeAudioData needs a complete audio file)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      totalLength += value.length
    }
  } finally {
    reader.cancel().catch(() => {})
  }

  // Concatenate into single ArrayBuffer
  const combined = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }

  speak(combined.buffer)
}

/** Stop all playback and clear the queue. */
export function stop(): void {
  // Bump the session so any in-flight decodes / pending-slot writes from
  // parallel synth promises drop their results silently.
  session++
  queue = []
  paused = false
  nextStartTime = 0
  pendingProducers = 0
  // Stop every still-live source. We snapshot first because each `.stop()`
  // synchronously fires `onended`, which mutates the set.
  const live = Array.from(scheduledSources)
  scheduledSources = new Set()
  for (const src of live) {
    src.onended = null
    try { src.stop() } catch { /* already stopped */ }
  }
  lastScheduledSource = null
  playing = false
  setActiveId(null)
}

/** Pause playback by suspending the AudioContext. */
export function pause(): void {
  if (ctx && playing) {
    paused = true
    ctx.suspend()
  }
}

/** Resume playback after pause. */
export function resume(): void {
  if (ctx && paused) {
    paused = false
    ctx.resume().then(() => {
      // Any buffers that piled up while paused get scheduled now.
      drainQueue()
    })
  }
}

export function isSpeaking(): boolean {
  return playing
}

export function onTTSEvent(event: 'start' | 'end' | 'error', cb: (() => void) | ((err: Error) => void)): void {
  if (event === 'start') onStartCb = cb as () => void
  else if (event === 'end') onEndCb = cb as () => void
  else if (event === 'error') onErrorCb = cb as (err: Error) => void
}
