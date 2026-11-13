import type {
  SpindleSystemAudioAPI,
  SpindleSystemAudioAvailability,
  SpindleSystemAudioEndReason,
  SpindleSystemAudioFrame,
  SpindleSystemAudioSession,
  SpindleSystemAudioStartOptions,
} from 'lumiverse-spindle-types'
import type { SystemAudioSource, SystemAudioSourceFrame, SystemAudioSourceHandle } from './system-audio-source'

export const SYSTEM_AUDIO_BANDS = { min: 8, max: 64, fallback: 32 } as const
export const SYSTEM_AUDIO_FPS = { min: 1, max: 30, fallback: 30 } as const

const START_MEMBER = 'ctx.systemAudio.start'

export interface FrontendSystemAudioDependencies {
  assertActive(): void
  requirePermission(permission: string, member: string): void
  onTeardown(handler: () => void): () => void
  getSource(): SystemAudioSource | null
  /**
   * Host-owned consent check. Resolves true for an explicit or remembered approval; any prompt is worded by the
   * host. Resolves false when the user declines, has paused starts, or when `signal` aborts.
   */
  requestConsent(signal: AbortSignal): Promise<boolean>
  /** Host-owned indicator that stays on screen while analysis runs. `stop` ends the session. Returns its remover. */
  showIndicator(stop: () => void): () => void
  now?(): number
}

const clamp01 = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Bring a source's spectrum to exactly `bands` values in 0 – 1. Fewer source bands are interpolated; more are
 * grouped, keeping each group's loudest value so a narrow peak is not averaged away.
 */
export function resampleBands(source: ArrayLike<number>, bands: number): number[] {
  const out = new Array<number>(bands).fill(0)
  const n = source.length
  if (n === 0) return out
  if (n === bands) {
    for (let i = 0; i < bands; i++) out[i] = clamp01(source[i])
    return out
  }
  if (n > bands) {
    for (let i = 0; i < bands; i++) {
      const from = Math.floor((i * n) / bands)
      const to = Math.max(from + 1, Math.floor(((i + 1) * n) / bands))
      let peak = 0
      for (let k = from; k < to && k < n; k++) peak = Math.max(peak, clamp01(source[k]))
      out[i] = peak
    }
    return out
  }
  for (let i = 0; i < bands; i++) {
    const at = bands === 1 ? 0 : (i * (n - 1)) / (bands - 1)
    const lo = Math.floor(at)
    const hi = Math.min(n - 1, lo + 1)
    const t = at - lo
    out[i] = clamp01(source[lo]) * (1 - t) + clamp01(source[hi]) * t
  }
  return out
}

const abortError = () => new DOMException('System audio session cancelled', 'AbortError')

interface ActiveSession {
  bands: number
  stereo: boolean
  minGapMs: number
  lastAt: number
  started: boolean
  finished: boolean
  handle: SystemAudioSourceHandle | null
  removeIndicator: (() => void) | null
  /** Stops listening to the extension's own AbortSignal. */
  detach: (() => void) | null
  abort: AbortController
  onFrame(frame: SpindleSystemAudioFrame): void
  onEnd?(reason: SpindleSystemAudioEndReason): void
}

/**
 * `ctx.systemAudio`: a spectrum and levels of what the device is playing, for visualisers and reactive effects.
 *
 * - `isAvailable()` is free and never prompts.
 * - `start()` needs `system_audio` and host-owned consent (prompted or explicitly remembered), shows a host-owned
 *   indicator while it runs, and delivers analysis only (rebinned, clamped, rate-limited), never samples.
 * - One session per extension. Revoking the permission, unloading the extension, aborting, the indicator's Stop,
 *   or the source going away all end it at once.
 */
export function createFrontendSystemAudioAPI(deps: FrontendSystemAudioDependencies) {
  let disposed = false
  let current: ActiveSession | null = null
  const now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))

  const authorize = () => {
    deps.assertActive()
    if (disposed) throw new Error('SPINDLE_FRONTEND_INACTIVE: system audio API has been disposed')
    deps.requirePermission('system_audio', START_MEMBER)
  }

  /** End a session. `reason` is reported to `onEnd` only if analysis had started; null means the extension asked. */
  const finish = (session: ActiveSession, reason: SpindleSystemAudioEndReason | null) => {
    if (session.finished) return
    session.finished = true
    if (current === session) current = null
    session.abort.abort()
    try { session.handle?.stop() } catch (error) { console.error('[Spindle] System audio source failed to stop', error) }
    session.handle = null
    session.removeIndicator?.()
    session.removeIndicator = null
    session.detach?.()
    session.detach = null
    if (reason && session.started) {
      try { session.onEnd?.(reason) } catch (error) { console.error('[Spindle] System audio onEnd failed', error) }
    }
  }

  const deliver = (session: ActiveSession, raw: SystemAudioSourceFrame) => {
    if (session.finished) return
    const at = now()
    if (at - session.lastAt < session.minGapMs) return
    session.lastAt = at
    try { authorize() } catch { finish(session, 'revoked'); return }
    if (session.stereo && !raw.stereo) { finish(session, 'source-lost'); return }
    const frame: SpindleSystemAudioFrame = {
      amplitude: clamp01(raw.amplitude),
      peak: clamp01(raw.peak),
      frequencies: resampleBands(raw.frequencies ?? [], session.bands),
    }
    if (session.stereo && raw.stereo) {
      const channel = (value: typeof raw.stereo.left) => ({
        amplitude: clamp01(value.amplitude),
        peak: clamp01(value.peak),
        frequencies: resampleBands(value.frequencies ?? [], session.bands),
      })
      frame.stereo = { left: channel(raw.stereo.left), right: channel(raw.stereo.right) }
    }
    try { session.onFrame(frame) } catch (error) { console.error('[Spindle] System audio onFrame failed', error) }
  }

  const isAvailable = (): SpindleSystemAudioAvailability => {
    deps.assertActive()
    if (disposed) throw new Error('SPINDLE_FRONTEND_INACTIVE: system audio API has been disposed')
    const source = deps.getSource()
    if (!source) return { available: false, unavailableReason: 'unsupported' }
    const status = source.availability()
    // (`in`, not `.available`: this project compiles without strictNullChecks, which turns off that narrowing)
    const stereo = status.stereoSupported === true ? { stereoSupported: true } : {}
    return 'reason' in status ? { available: false, unavailableReason: status.reason, ...stereo } : { available: true, ...stereo }
  }

  const start = (options: SpindleSystemAudioStartOptions): SpindleSystemAudioSession => {
    authorize()
    if (!options || typeof options.onFrame !== 'function') {
      throw new TypeError('SYSTEM_AUDIO_FRAME_CALLBACK_REQUIRED: start() needs an onFrame function')
    }
    if (options.stereo !== undefined && typeof options.stereo !== 'boolean') {
      throw new TypeError('SYSTEM_AUDIO_STEREO_INVALID: stereo must be a boolean')
    }
    if (current) throw new Error('SYSTEM_AUDIO_BUSY: one system audio session per extension; stop() the running one first')
    const fps = clampInt(options.maxFps, SYSTEM_AUDIO_FPS.min, SYSTEM_AUDIO_FPS.max, SYSTEM_AUDIO_FPS.fallback)
    const session: ActiveSession = {
      bands: clampInt(options.bands, SYSTEM_AUDIO_BANDS.min, SYSTEM_AUDIO_BANDS.max, SYSTEM_AUDIO_BANDS.fallback),
      stereo: options.stereo === true,
      minGapMs: 1000 / fps,
      lastAt: -Infinity,
      started: false,
      finished: false,
      handle: null,
      removeIndicator: null,
      detach: null,
      abort: new AbortController(),
      onFrame: options.onFrame,
      onEnd: options.onEnd,
    }
    const signal = options.signal
    if (signal?.aborted) {
      const rejected = Promise.reject(abortError())
      rejected.catch(() => {})
      return Object.freeze({ ready: rejected, stop() {} })
    }
    current = session
    const cancelled = new Promise<never>((_resolve, reject) => {
      session.abort.signal.addEventListener('abort', () => reject(abortError()), { once: true })
    })
    const onAbort = () => finish(session, null)
    signal?.addEventListener('abort', onAbort, { once: true })
    session.detach = () => signal?.removeEventListener('abort', onAbort)

    const startup = (async () => {
      const source = deps.getSource()
      const status = source?.availability()
      if (!source || !status?.available) throw new DOMException('System audio is not available here', 'NotSupportedError')
      if (session.stereo && status.stereoSupported !== true) {
        throw new DOMException('Stereo analysis needs an updated Lumiverse desktop client', 'NotSupportedError')
      }
      const approved = await deps.requestConsent(session.abort.signal)
      if (session.finished) throw abortError()
      if (!approved) throw new DOMException('The user did not allow system audio analysis', 'NotAllowedError')
      authorize() // the permission may have been revoked while the prompt was open
      const handle = await source.start(
        {
          onFrame: (frame) => deliver(session, frame),
          onEnd: (reason) => finish(session, reason),
        },
        { maxFps: fps, ...(session.stereo ? { stereo: true } : {}) },
      )
      if (session.finished) {
        handle.stop()
        throw abortError()
      }
      session.handle = handle
      session.started = true
      session.removeIndicator = deps.showIndicator(() => finish(session, 'user-stopped'))
    })()
    // Cancellation must settle ready even if native startup stays pending. Keep observing startup so a late
    // handle is stopped above and a late failure is handled without replacing the cancellation error.
    const ready = Promise.race([startup, cancelled])
    // Whatever went wrong, free the slot. This also marks the rejection handled, so an extension that ignores
    // `ready` does not raise an unhandled rejection.
    ready.catch(() => finish(session, null))

    return Object.freeze({ ready, stop: () => finish(session, null) })
  }

  const unsubscribe = deps.onTeardown(() => {
    disposed = true
    if (current) finish(current, null)
  })

  return {
    api: Object.freeze({ isAvailable, start }) as SpindleSystemAudioAPI,
    /** The permission was revoked: end the running session and tell the extension why. */
    revoke() {
      if (current) finish(current, 'revoked')
    },
    /** The user stopped analysis: retained approval must not restart it until the host allows requests again. */
    pause() {
      if (current) finish(current, 'user-stopped')
    },
    dispose() {
      unsubscribe()
      disposed = true
      if (current) finish(current, null)
    },
  }
}
