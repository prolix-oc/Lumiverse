import { describe, expect, test } from 'bun:test'
import { clampInt, createFrontendSystemAudioAPI, resampleBands, type FrontendSystemAudioDependencies } from './system-audio-api'
import {
  getSystemAudioSource,
  registerSystemAudioSource,
  type SystemAudioAvailability,
  type SystemAudioSource,
  type SystemAudioSourceFrame,
  type SystemAudioSourceHandlers,
  type SystemAudioSourceStartHints,
} from './system-audio-source'
import type { SpindleSystemAudioEndReason, SpindleSystemAudioFrame } from 'lumiverse-spindle-types'

/** A source the test drives by hand. */
class FakeSource implements SystemAudioSource {
  status: SystemAudioAvailability = { available: true }
  starts = 0
  stops = 0
  hints: Array<SystemAudioSourceStartHints | undefined> = []
  failStart: Error | null = null
  handlers!: SystemAudioSourceHandlers
  availability() { return this.status }
  async start(handlers: SystemAudioSourceHandlers, hints?: SystemAudioSourceStartHints) {
    this.starts++
    this.hints.push(hints)
    if (this.failStart) throw this.failStart
    this.handlers = handlers
    return { stop: () => { this.stops++ } }
  }
  frame(frame: Partial<SystemAudioSourceFrame> = {}) {
    this.handlers.onFrame({ amplitude: 0.5, peak: 0.8, frequencies: [0, 0.5, 1], ...frame })
  }
}

/** A source whose startup can remain pending after its session is cancelled. */
class PendingSource extends FakeSource {
  private markStarting!: () => void
  readonly starting = new Promise<void>((resolve) => { this.markStarting = resolve })
  resolveStart!: () => void
  rejectStart!: (error: Error) => void

  override async start(handlers: SystemAudioSourceHandlers) {
    this.starts++
    this.handlers = handlers
    const pending = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve
      this.rejectStart = reject
    })
    this.markStarting()
    await pending
    return { stop: () => { this.stops++ } }
  }
}

function setup(overrides: Partial<FrontendSystemAudioDependencies> & { source?: FakeSource | null; approve?: boolean } = {}) {
  const source = overrides.source === undefined ? new FakeSource() : overrides.source
  const granted = new Set(['system_audio'])
  let clock = 1000
  const state = { consents: 0, indicators: 0, stopFromIndicator: null as null | (() => void), torn: [] as Array<() => void>, active: true }
  const deps: FrontendSystemAudioDependencies = {
    assertActive() { if (!state.active) throw new Error('SPINDLE_FRONTEND_INACTIVE') },
    requirePermission(permission, member) {
      if (!granted.has(permission)) throw new Error(`PERMISSION_DENIED:${permission} - ${member} requires the ${permission} permission`)
    },
    onTeardown(handler) { state.torn.push(handler); return () => {} },
    getSource: () => source,
    requestConsent: async () => { state.consents++; return overrides.approve ?? true },
    showIndicator(stop) {
      state.indicators++
      state.stopFromIndicator = stop
      return () => { state.indicators--; state.stopFromIndicator = null }
    },
    now: () => clock,
    ...overrides,
  }
  const made = createFrontendSystemAudioAPI(deps)
  return {
    ...made, source, granted, state,
    advance: (ms: number) => { clock += ms },
    teardown: () => state.torn.forEach((handler) => handler()),
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('resampleBands', () => {
  test('keeps an exact-size spectrum and clamps junk to 0 – 1', () => {
    expect(resampleBands([0, 0.5, 2, -1, Number.NaN], 5)).toEqual([0, 0.5, 1, 0, 0])
  })
  test('groups a longer spectrum by its loudest value so a narrow peak survives', () => {
    expect(resampleBands([0, 1, 0, 0, 0, 0, 0, 0], 4)).toEqual([1, 0, 0, 0])
  })
  test('interpolates a shorter spectrum from end to end', () => {
    expect(resampleBands([0, 1], 3)).toEqual([0, 0.5, 1])
  })
  test('an empty spectrum is silence of the requested length', () => {
    expect(resampleBands([], 4)).toEqual([0, 0, 0, 0])
  })
})

describe('clampInt', () => {
  test('rounds, clamps and falls back on anything that is not a finite number', () => {
    expect(clampInt(12.6, 8, 64, 32)).toBe(13)
    expect(clampInt(1, 8, 64, 32)).toBe(8)
    expect(clampInt(1000, 8, 64, 32)).toBe(64)
    expect(clampInt(Number.NaN, 8, 64, 32)).toBe(32)
    expect(clampInt('40', 8, 64, 32)).toBe(32)
    expect(clampInt(undefined, 8, 64, 32)).toBe(32)
  })
})

describe('source registry', () => {
  test('is empty until a native adapter registers, and unregisters only itself', () => {
    expect(getSystemAudioSource()).toBeNull()
    const a = new FakeSource()
    const b = new FakeSource()
    const offA = registerSystemAudioSource(a)
    expect(getSystemAudioSource()).toBe(a)
    const offB = registerSystemAudioSource(b)
    offA() // a stale handle must not remove the newer adapter
    expect(getSystemAudioSource()).toBe(b)
    offB()
    expect(getSystemAudioSource()).toBeNull()
  })
})

describe('isAvailable', () => {
  test('is unsupported without an adapter, without needing the permission or prompting', () => {
    const t = setup({ source: null })
    t.granted.clear()
    expect(t.api.isAvailable()).toEqual({ available: false, unavailableReason: 'unsupported' })
    expect(t.state.consents).toBe(0)
  })
  test('reports an adapter that exists but is switched off', () => {
    const source = new FakeSource()
    source.status = { available: false, reason: 'disabled' }
    expect(setup({ source }).api.isAvailable()).toEqual({ available: false, unavailableReason: 'disabled' })
  })
  test('reports an available adapter', () => {
    expect(setup().api.isAvailable()).toEqual({ available: true })
  })
  test('reports stereo capability even while the native switch is disabled', () => {
    const source = new FakeSource()
    source.status = { available: false, reason: 'disabled', stereoSupported: true }
    expect(setup({ source }).api.isAvailable()).toEqual({ available: false, unavailableReason: 'disabled', stereoSupported: true })
  })
})

describe('start: authorisation and consent', () => {
  test('unsupported stereo fails before prompting and leaves mono available', async () => {
    const t = setup()
    await expect(t.api.start({ stereo: true, onFrame() {} }).ready).rejects.toMatchObject({ name: 'NotSupportedError' })
    expect(t.state.consents).toBe(0)
    expect(t.source!.starts).toBe(0)
    await t.api.start({ onFrame() {} }).ready
    expect(t.source!.starts).toBe(1)
  })
  test('rejects an invalid stereo mode without prompting', () => {
    const t = setup()
    expect(() => t.api.start({ stereo: 'true' as never, onFrame() {} })).toThrow('SYSTEM_AUDIO_STEREO_INVALID')
    expect(t.state.consents).toBe(0)
  })
  test('requires the system_audio permission, before anything else happens', () => {
    const t = setup()
    t.granted.clear()
    expect(() => t.api.start({ onFrame() {} })).toThrow('PERMISSION_DENIED:system_audio')
    expect(t.state.consents).toBe(0)
    expect(t.source!.starts).toBe(0)
  })
  test('needs a frame callback', () => {
    expect(() => setup().api.start({} as never)).toThrow('SYSTEM_AUDIO_FRAME_CALLBACK_REQUIRED')
  })
  test('rejects with NotSupportedError, never prompting, when no adapter exists', async () => {
    const t = setup({ source: null })
    await expect(t.api.start({ onFrame() {} }).ready).rejects.toMatchObject({ name: 'NotSupportedError' })
    expect(t.state.consents).toBe(0)
  })
  test('a declined prompt rejects with NotAllowedError and never touches the device', async () => {
    const t = setup({ approve: false })
    const ended: SpindleSystemAudioEndReason[] = []
    await expect(t.api.start({ onFrame() {}, onEnd: (reason) => ended.push(reason) }).ready).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(t.source!.starts).toBe(0)
    expect(t.state.indicators).toBe(0)
    expect(ended).toEqual([])
    // ...and the slot is free again.
    expect(() => t.api.start({ onFrame() {} })).not.toThrow()
  })
  test('checks host consent on every start', async () => {
    const t = setup()
    const first = t.api.start({ onFrame() {} })
    await first.ready
    first.stop()
    await t.api.start({ onFrame() {} }).ready
    expect(t.state.consents).toBe(2)
  })
  test('the permission being revoked while the prompt is open stops it before the device is touched', async () => {
    let release!: (approved: boolean) => void
    const t = setup({ requestConsent: () => new Promise<boolean>((resolve) => { release = resolve }) })
    const session = t.api.start({ onFrame() {} })
    t.granted.clear()
    release(true)
    await expect(session.ready).rejects.toThrow('PERMISSION_DENIED:system_audio')
    expect(t.source!.starts).toBe(0)
  })
  test('only one session per extension', async () => {
    const t = setup()
    const first = t.api.start({ onFrame() {} })
    expect(() => t.api.start({ onFrame() {} })).toThrow('SYSTEM_AUDIO_BUSY')
    await first.ready
    expect(() => t.api.start({ onFrame() {} })).toThrow('SYSTEM_AUDIO_BUSY')
    first.stop()
    expect(() => t.api.start({ onFrame() {} })).not.toThrow()
  })
  test('a source that fails to start frees the slot and shows no indicator', async () => {
    const source = new FakeSource()
    source.failStart = new Error('device gone')
    const t = setup({ source })
    await expect(t.api.start({ onFrame() {} }).ready).rejects.toThrow('device gone')
    expect(t.state.indicators).toBe(0)
    source.failStart = null
    await expect(t.api.start({ onFrame() {} }).ready).resolves.toBeUndefined()
  })
})

describe('start: frames', () => {
  async function running(options: { bands?: number; maxFps?: number; stereo?: boolean } = {}) {
    const t = setup()
    if (options.stereo) t.source!.status = { available: true, stereoSupported: true }
    const frames: SpindleSystemAudioFrame[] = []
    const ended: SpindleSystemAudioEndReason[] = []
    const session = t.api.start({ ...options, onFrame: (frame) => frames.push(frame), onEnd: (reason) => ended.push(reason) })
    await session.ready
    return { t, frames, ended, session }
  }

  test('delivers analysis only, rebinned to the requested band count', async () => {
    const { t, frames } = await running({ bands: 8 })
    t.source!.frame({ frequencies: [0, 1] })
    expect(Object.keys(frames[0]).sort()).toEqual(['amplitude', 'frequencies', 'peak'])
    expect(frames[0].frequencies).toHaveLength(8)
    expect(frames[0].frequencies[0]).toBe(0)
    expect(frames[0].frequencies[7]).toBe(1)
  })
  test('stereo is copied, rebinned and sanitised independently while combined output is preserved', async () => {
    const { t, frames } = await running({ stereo: true, bands: 8, maxFps: 12 })
    expect(t.source!.hints).toEqual([{ maxFps: 12, stereo: true }])
    const left = new Float32Array([0, 1])
    const right = new Float32Array([1, 0])
    t.source!.frame({ stereo: {
      left: { amplitude: Number.NaN, peak: 7, frequencies: left },
      right: { amplitude: -1, peak: 0.5, frequencies: right },
    } })
    const frame = frames[0]
    expect(Object.keys(frame).sort()).toEqual(['amplitude', 'frequencies', 'peak', 'stereo'])
    expect(frame.amplitude).toBe(0.5)
    expect(frame.stereo!.left.amplitude).toBe(0)
    expect(frame.stereo!.left.peak).toBe(1)
    expect(frame.stereo!.right.amplitude).toBe(0)
    expect(frame.stereo!.right.peak).toBe(0.5)
    expect(frame.stereo!.left.frequencies).toHaveLength(8)
    expect(frame.stereo!.right.frequencies).toHaveLength(8)
    expect(frame.stereo!.left.frequencies[7]).toBe(1)
    expect(frame.stereo!.right.frequencies[7]).toBe(0)
    left.fill(0)
    right.fill(0)
    expect(frame.stereo!.left.frequencies[7]).toBe(1)
  })
  test('mono subscribers receive the original shape even from a stereo-capable source', async () => {
    const { t, frames } = await running()
    t.source!.frame({ stereo: { left: { amplitude: 1, peak: 1, frequencies: [1] }, right: { amplitude: 0, peak: 0, frequencies: [0] } } })
    expect(Object.keys(frames[0]).sort()).toEqual(['amplitude', 'frequencies', 'peak'])
  })
  test('missing stereo analysis ends a stereo session instead of silently returning mono', async () => {
    const { t, frames, ended } = await running({ stereo: true })
    t.source!.frame()
    expect(frames).toHaveLength(0)
    expect(ended).toEqual(['source-lost'])
    expect(t.source!.stops).toBe(1)
  })
  test('defaults to 32 bands and clamps the request to 8 – 64', async () => {
    const a = await running()
    a.t.source!.frame()
    expect(a.frames[0].frequencies).toHaveLength(32)
    const b = await running({ bands: 1 })
    b.t.source!.frame()
    expect(b.frames[0].frequencies).toHaveLength(8)
    const c = await running({ bands: 5000 })
    c.t.source!.frame()
    expect(c.frames[0].frequencies).toHaveLength(64)
  })
  test('tells the source the frame rate, so it does no more work than the extension will use', async () => {
    const a = await running({ maxFps: 12 })
    expect(a.t.source!.hints).toEqual([{ maxFps: 12 }])
    const b = await running()
    expect(b.t.source!.hints).toEqual([{ maxFps: 30 }])
    const c = await running({ maxFps: 9000 })
    expect(c.t.source!.hints).toEqual([{ maxFps: 30 }])
  })
  test('accepts a typed-array view, as a transport buffer delivers it', async () => {
    const { t, frames } = await running({ bands: 8 })
    const buffer = new Float32Array([9, 0.5, 0.5, 0, 1]) // a header the view skips, then two bands
    t.source!.frame({ frequencies: buffer.subarray(3) })
    expect(frames[0].frequencies).toHaveLength(8)
    expect(frames[0].frequencies[0]).toBe(0)
    expect(frames[0].frequencies[7]).toBe(1)
    expect(Array.isArray(frames[0].frequencies)).toBe(true) // a plain copy, not the transport's memory
  })
  test('sanitises levels from the source', async () => {
    const { t, frames } = await running()
    t.source!.frame({ amplitude: Number.NaN, peak: 7 })
    expect(frames[0].amplitude).toBe(0)
    expect(frames[0].peak).toBe(1)
  })
  test('is rate-limited to maxFps (default 30) however fast the source sends', async () => {
    const { t, frames } = await running({ maxFps: 10 })
    for (let i = 0; i < 100; i++) {
      t.source!.frame()
      t.advance(5) // 200 fps from the source
    }
    expect(frames.length).toBeGreaterThanOrEqual(4)
    expect(frames.length).toBeLessThanOrEqual(6) // 500 ms at 10 fps
    const fast = await running()
    for (let i = 0; i < 100; i++) {
      fast.t.source!.frame()
      fast.t.advance(5)
    }
    expect(fast.frames.length).toBeLessThanOrEqual(16) // never above 30 fps: 500 ms
  })
  test('a throwing frame callback does not stop the session', async () => {
    const t = setup()
    let calls = 0
    const log = console.error
    console.error = () => {} // the host logs the extension's error; keep the test output clean
    try {
      const session = t.api.start({ onFrame() { calls++; throw new Error('extension bug') } })
      await session.ready
      t.source!.frame()
      t.advance(100)
      t.source!.frame()
    } finally {
      console.error = log
    }
    expect(calls).toBe(2)
  })
  test('shows the host indicator while it runs and removes it on stop(), which releases the device', async () => {
    const { t, session } = await running()
    expect(t.state.indicators).toBe(1)
    session.stop()
    session.stop() // safe to repeat
    expect(t.state.indicators).toBe(0)
    expect(t.source!.stops).toBe(1)
  })
})

describe('start: how a session ends', () => {
  async function running() {
    const t = setup()
    const frames: SpindleSystemAudioFrame[] = []
    const ended: SpindleSystemAudioEndReason[] = []
    const session = t.api.start({ onFrame: (frame) => frames.push(frame), onEnd: (reason) => ended.push(reason) })
    await session.ready
    return { t, frames, ended, session }
  }

  test('the indicator’s Stop button ends it with user-stopped', async () => {
    const { t, ended } = await running()
    t.state.stopFromIndicator!()
    expect(ended).toEqual(['user-stopped'])
    expect(t.source!.stops).toBe(1)
    expect(t.state.indicators).toBe(0)
  })
  test('revoking the permission ends it with revoked and no further frames arrive', async () => {
    const { t, frames, ended } = await running()
    t.revoke()
    expect(ended).toEqual(['revoked'])
    expect(t.source!.stops).toBe(1)
    t.source!.frame()
    expect(frames).toHaveLength(0)
  })
  test('a frame that arrives after the grant was withdrawn ends it rather than leaking', async () => {
    const { t, frames, ended } = await running()
    t.granted.clear()
    t.source!.frame()
    expect(frames).toHaveLength(0)
    expect(ended).toEqual(['revoked'])
    expect(t.source!.stops).toBe(1)
  })
  test('the source going away is reported with its own reason', async () => {
    const { t, ended } = await running()
    t.source!.handlers.onEnd('source-lost')
    expect(ended).toEqual(['source-lost'])
    expect(t.state.indicators).toBe(0)
    t.source!.handlers.onEnd('host-disabled') // already over: reported once
    expect(ended).toEqual(['source-lost'])
  })
  test('unloading the extension stops the device quietly', async () => {
    const { t, ended } = await running()
    t.teardown()
    expect(t.source!.stops).toBe(1)
    expect(t.state.indicators).toBe(0)
    expect(ended).toEqual([])
    expect(() => t.api.isAvailable()).toThrow('SPINDLE_FRONTEND_INACTIVE')
    expect(() => t.api.start({ onFrame() {} })).toThrow('SPINDLE_FRONTEND_INACTIVE')
  })
  test('an AbortSignal that is already aborted never prompts', async () => {
    const t = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(t.api.start({ onFrame() {}, signal: controller.signal }).ready).rejects.toMatchObject({ name: 'AbortError' })
    expect(t.state.consents).toBe(0)
  })
  test('aborting while the prompt is open cancels the prompt and never starts the device', async () => {
    let aborted = false
    const t = setup({
      requestConsent: (signal) => new Promise<boolean>((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; resolve(false) })
      }),
    })
    const controller = new AbortController()
    const session = t.api.start({ onFrame() {}, signal: controller.signal })
    controller.abort()
    await expect(session.ready).rejects.toMatchObject({ name: 'AbortError' })
    expect(aborted).toBe(true)
    expect(t.source!.starts).toBe(0)
    expect(t.state.indicators).toBe(0)
  })
  test('aborting a running session stops the device', async () => {
    const t = setup()
    const controller = new AbortController()
    const session = t.api.start({ onFrame() {}, signal: controller.signal })
    await session.ready
    controller.abort()
    await flush()
    expect(t.source!.stops).toBe(1)
    expect(t.state.indicators).toBe(0)
  })
  for (const cancellation of ['stop', 'abort', 'revoke', 'unload', 'dispose'] as const) {
    test(`${cancellation} rejects ready before pending device startup settles and releases a late handle`, async () => {
      const source = new PendingSource()
      const t = setup({ source })
      const controller = new AbortController()
      const frames: SpindleSystemAudioFrame[] = []
      const ended: SpindleSystemAudioEndReason[] = []
      const session = t.api.start({
        signal: controller.signal,
        onFrame: (frame) => frames.push(frame),
        onEnd: (reason) => ended.push(reason),
      })
      let readyError: unknown
      void session.ready.catch((error) => { readyError = error })
      await source.starting
      switch (cancellation) {
        case 'stop': session.stop(); break
        case 'abort': controller.abort(); break
        case 'revoke': t.revoke(); break
        case 'unload': t.teardown(); break
        case 'dispose': t.dispose(); break
      }
      await flush()
      expect(readyError).toBeInstanceOf(DOMException)
      expect(readyError).toMatchObject({ name: 'AbortError' })
      expect(source.stops).toBe(0)
      source.frame()
      expect(frames).toHaveLength(0)
      source.resolveStart()
      await flush()
      expect(source.stops).toBe(1)
      expect(t.state.indicators).toBe(0)
      expect(ended).toHaveLength(0)
    })
  }

  test('a device startup failure after cancellation preserves AbortError', async () => {
    const source = new PendingSource()
    const t = setup({ source })
    const session = t.api.start({ onFrame() {} })
    await source.starting
    session.stop()
    source.rejectStart(new Error('device startup failed'))
    await expect(session.ready).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    expect(source.stops).toBe(0)
    expect(t.state.indicators).toBe(0)
  })

  test('a late startup handle is stopped without ending a replacement session', async () => {
    const oldSource = new PendingSource()
    let source: FakeSource = oldSource
    const t = setup({ getSource: () => source })
    const oldSession = t.api.start({ onFrame() {} })
    await oldSource.starting
    oldSession.stop()
    source = new FakeSource()
    const frames: SpindleSystemAudioFrame[] = []
    const session = t.api.start({ onFrame: (frame) => frames.push(frame) })
    await session.ready
    oldSource.resolveStart()
    await flush()
    expect(oldSource.stops).toBe(1)
    expect(source.stops).toBe(0)
    expect(t.state.indicators).toBe(1)
    source.frame()
    expect(frames).toHaveLength(1)
    session.stop()
    expect(source.stops).toBe(1)
    expect(t.state.indicators).toBe(0)
  })
})
