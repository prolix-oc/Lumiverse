import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { uuidv4 } from '../uuid'
import {
  registerSystemAudioSource,
  type SystemAudioAvailability,
  type SystemAudioSource,
  type SystemAudioSourceEndReason,
  type SystemAudioSourceHandlers,
  type SystemAudioSourceStartHints,
  type SystemAudioSourceFrame,
} from './system-audio-source'

/**
 * The desktop client's system-audio adapter, as the web layer sees it.
 *
 * Native code (`desktop/src-tauri/src/system_audio`) listens to the output device, does the analysis, and sends back
 * one small message per frame: little-endian `f32`s `[kind, amplitude, peak, band…]`, with optional channel blocks.
 * Nothing else crosses: no samples,
 * no device names. The page asks for a frame rate, optional stereo analysis, and stop.
 *
 * Efficiency lives on both sides of the boundary. Native analysis runs only at the frame rate somebody asked for, and
 * only while the window is visible and sound is playing. This side adds no copies: frames are read straight out of the
 * IPC buffer, one native session is shared by every extension that listens, and it ends when the last one leaves.
 */

export interface NativeSystemAudioStatus {
  /** This build can hear the output device at all. */
  supported: boolean
  /** The owner switched the feature on in the tray. */
  enabled: boolean
  active: boolean
  /** Absent in older desktop builds. */
  stereoSupported?: boolean
}

/** The native surface, injectable so the adapter can be tested without a Tauri runtime. */
export interface NativeSystemAudioBridge {
  status(): Promise<NativeSystemAudioStatus>
  /** Calls `onStatus` whenever the tray switch or session state changes. Resolves to the unsubscribe function. */
  watch(onStatus: (status: NativeSystemAudioStatus) => void): Promise<() => void>
  /** Begin (or replace) the native session; every message from it goes to `onMessage`. */
  start(maxFps: number, onMessage: (data: unknown) => void, stereo?: boolean): Promise<void>
  stop(): Promise<void>
}

const KIND_FRAME = 0
const KIND_SOURCE_LOST = 1
const KIND_HOST_DISABLED = 2
const KIND_STEREO_FRAME = 3
const HEADER_FLOATS = 3
const BANDS = 64
const CHANNEL_FLOATS = 2 + BANDS
const MONO_FLOATS = 1 + CHANNEL_FLOATS
const STEREO_FLOATS = 1 + 3 * CHANNEL_FLOATS

export function createTauriBridge(): NativeSystemAudioBridge {
  // Scope cleanup to this adapter installation, including a late stop after its device open settles.
  const sessionKey = uuidv4()
  return {
    status: () => invoke<NativeSystemAudioStatus>('desktop_system_audio_status'),
    async watch(onStatus) {
      return listen<NativeSystemAudioStatus>('desktop-system-audio-state', ({ payload }) => onStatus(payload))
    },
    async start(maxFps, onMessage, stereo = false) {
      const events = new Channel<unknown>()
      events.onmessage = onMessage
      await invoke('desktop_system_audio_start', { events, maxFps, sessionKey, stereo })
    },
    stop: () => invoke('desktop_system_audio_stop', { sessionKey }),
  }
}

interface Subscriber {
  handlers: SystemAudioSourceHandlers
  maxFps: number
  stereo: boolean
  ready: boolean
}

export function createTauriSystemAudioSource(
  bridge: NativeSystemAudioBridge,
  initial: NativeSystemAudioStatus,
) {
  let status = initial
  const subscribers = new Set<Subscriber>()
  /** Frame rate of the native session now running, 0 when none. */
  let runningFps = 0
  let runningStereo = false
  /** Bumped whenever a session is replaced or ended, so a message from an old channel is ignored. */
  let generation = 0
  let queue: Promise<void> = Promise.resolve()
  let disposed = false
  let starting = false
  let disposal: Promise<void> | undefined

  const endAll = (reason: SystemAudioSourceEndReason) => {
    generation++
    runningFps = 0
    runningStereo = false
    const ending = [...subscribers]
    subscribers.clear()
    for (const subscriber of ending) {
      try { subscriber.handlers.onEnd(reason) } catch (error) { console.error('[Spindle] System audio onEnd failed', error) }
    }
  }

  const receive = (own: number, expectedStereo: boolean) => (data: unknown) => {
    if (own !== generation || !(data instanceof ArrayBuffer) || data.byteLength % 4 !== 0) return
    const values = new Float32Array(data)
    if (values.length < HEADER_FLOATS) return
    switch (values[0]) {
      case KIND_FRAME:
      case KIND_STEREO_FRAME: {
        const stereo = values[0] === KIND_STEREO_FRAME
        if (stereo && values.length !== STEREO_FLOATS) return
        if (stereo !== expectedStereo) {
          if (expectedStereo) endAll('source-lost')
          return
        }
        // `frequencies` is a view into the IPC buffer: the API copies what it keeps before the next message.
        const frame: SystemAudioSourceFrame = {
          amplitude: values[1], peak: values[2], frequencies: values.subarray(HEADER_FLOATS, stereo ? MONO_FLOATS : undefined),
        }
        const channel = (offset: number) => ({
          amplitude: values[offset], peak: values[offset + 1], frequencies: values.subarray(offset + 2, offset + CHANNEL_FLOATS),
        })
        const separated = stereo ? { ...frame, stereo: { left: channel(MONO_FLOATS), right: channel(MONO_FLOATS + CHANNEL_FLOATS) } } : null
        for (const subscriber of [...subscribers]) {
          if (!subscribers.has(subscriber) || !subscriber.ready) continue
          if (subscriber.stereo && !separated) { endAll('source-lost'); return }
          try { subscriber.handlers.onFrame(subscriber.stereo ? separated! : frame) } catch (error) { console.error('[Spindle] System audio onFrame failed', error) }
        }
        return
      }
      case KIND_SOURCE_LOST: return endAll('source-lost')
      case KIND_HOST_DISABLED: return endAll('host-disabled')
    }
  }

  /** Make the native session match what the subscribers need: none, or one at the fastest rate anyone asked for. */
  const reconcile = async () => {
    if (disposed) return
    const wanted = Math.max(0, ...[...subscribers].map((subscriber) => subscriber.maxFps))
    const wantedStereo = [...subscribers].some((subscriber) => subscriber.stereo)
    if (wanted === 0) {
      if (runningFps === 0) return
      generation++
      runningFps = 0
      runningStereo = false
      await bridge.stop()
      return
    }
    if (wanted === runningFps && wantedStereo === runningStereo) return
    // Native `start` replaces the session when the rate or stereo demand changes in either direction.
    const own = ++generation
    runningFps = 0
    runningStereo = wantedStereo
    starting = true
    try {
      await bridge.start(wanted, receive(own, wantedStereo), wantedStereo)
      if (own === generation) runningFps = wanted
    } catch (error) {
      if (own === generation) endAll('source-lost')
      throw error
    } finally {
      starting = false
    }
  }

  /** One reconcile at a time, so two extensions starting together cannot interleave their native calls. */
  const sync = () => {
    const run = queue.then(reconcile)
    queue = run.catch(() => {})
    return run
  }

  const source: SystemAudioSource = {
    availability(): SystemAudioAvailability {
      if (disposed) return { available: false, reason: 'disabled' }
      if (!status.supported) return { available: false, reason: 'unsupported' }
      const stereo = status.stereoSupported === true ? { stereoSupported: true } : {}
      return status.enabled ? { available: true, ...stereo } : { available: false, reason: 'disabled', ...stereo }
    },
    async start(handlers, hints?: SystemAudioSourceStartHints) {
      if (disposed) throw new DOMException('System audio adapter was disposed', 'AbortError')
      if (hints?.stereo === true && status.stereoSupported !== true) {
        throw new DOMException('This desktop build does not support stereo analysis', 'NotSupportedError')
      }
      const subscriber: Subscriber = { handlers, maxFps: Math.min(30, Math.max(1, Math.round(hints?.maxFps ?? 30))), stereo: hints?.stereo === true, ready: false }
      subscribers.add(subscriber)
      try {
        await sync()
        if (disposed) throw new DOMException('System audio adapter was disposed', 'AbortError')
        if (!subscribers.has(subscriber)) throw new DOMException('System audio source ended during startup', 'AbortError')
        subscriber.ready = true
      } catch (error) {
        subscribers.delete(subscriber)
        throw error
      }
      return {
        stop() {
          if (subscribers.delete(subscriber)) void sync().catch(() => {})
        },
      }
    },
  }

  return {
    source,
    dispose(): Promise<void> {
      if (disposed) return disposal ?? Promise.resolve()
      disposed = true
      const pending = starting
      endAll('source-lost')
      const stop = () => bridge.stop().catch((error) => console.warn('[system-audio] Could not stop native capture', error))
      const stopped = stop()
      // Cancel immediately, then release a handle that might finish opening after the first native stop.
      // The real bridge's session key prevents this late cleanup from stopping a new installation's capture.
      disposal = pending ? queue.then(() => stopped).then(stop) : stopped
      return disposal
    },
    /** The tray changed the switch or the session state. */
    update(next: NativeSystemAudioStatus) {
      if (disposed) return
      status = next
    },
  }
}

/**
 * Register the adapter if this is the primary desktop frontend and the build can hear the output device. Returns its
 * cleanup. Anywhere else (a browser, a floating widget window, an unsupported OS) nothing is registered, which is what
 * makes `isAvailable()` say `unsupported`.
 */
export async function installTauriSystemAudioSource(
  bridge: NativeSystemAudioBridge = createTauriBridge(),
): Promise<() => void> {
  let initial: NativeSystemAudioStatus
  try {
    initial = await bridge.status()
  } catch {
    return () => {}
  }
  if (!initial?.supported) return () => {}

  const { source, update, dispose } = createTauriSystemAudioSource(bridge, initial)
  const unregister = registerSystemAudioSource(source)
  let unwatch: (() => void) | null = null
  let disposed = false
  void bridge
    .watch(update)
    .then((stop) => (disposed ? stop() : (unwatch = stop)))
    .catch((error) => console.warn('[system-audio] Could not watch the native switch', error))
  return () => {
    if (disposed) return
    disposed = true
    unwatch?.()
    unregister()
    void dispose()
  }
}
