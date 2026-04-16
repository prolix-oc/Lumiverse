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
let currentSource: AudioBufferSourceNode | null = null
let queue: ArrayBuffer[] = []
let playing = false
let paused = false
let volume = 0.8
let speed = 1.0

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
  if (currentSource) {
    currentSource.playbackRate.value = speed
  }
}

function playNext(): void {
  if (paused) return

  const data = queue.shift()
  if (!data) {
    playing = false
    currentSource = null
    setActiveId(null)
    onEndCb?.()
    return
  }

  const c = ensureContext()
  c.decodeAudioData(data.slice(0))
    .then((buffer) => {
      if (paused) return

      const source = c.createBufferSource()
      source.buffer = buffer
      source.playbackRate.value = speed
      source.connect(gainNode!)
      source.onended = () => {
        if (currentSource === source) {
          currentSource = null
          playNext()
        }
      }

      currentSource = source
      source.start()
    })
    .catch((err) => {
      onErrorCb?.(err instanceof Error ? err : new Error(String(err)))
      playNext()
    })
}

/**
 * Enqueue audio data for sequential playback.
 * Pass `messageId` to tag this playback so per-message UI can reflect
 * a "this message is playing" state.
 */
export function speak(audioData: ArrayBuffer, messageId?: string): void {
  queue.push(audioData)
  if (messageId !== undefined) {
    setActiveId(messageId)
  }
  if (!playing) {
    playing = true
    paused = false
    onStartCb?.()
    playNext()
  }
}

/** Consume a streaming Response and play audio chunks sequentially. */
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
  queue = []
  paused = false
  if (currentSource) {
    try {
      currentSource.stop()
    } catch {
      // Already stopped
    }
    currentSource = null
  }
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
      if (!currentSource && queue.length > 0) {
        playNext()
      }
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
