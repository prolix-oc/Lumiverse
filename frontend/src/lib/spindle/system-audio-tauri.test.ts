import { describe, expect, mock, spyOn, test } from 'bun:test'

// The adapter imports the Tauri runtime for its real bridge. These tests inject a fake bridge instead.
const nativeInvocations: Array<{ command: string; args: Record<string, unknown> }> = []
mock.module('@tauri-apps/api/core', () => ({
  Channel: class {},
  invoke: async (command: string, args: Record<string, unknown> = {}) => { nativeInvocations.push({ command, args }) },
}))
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))

const { createTauriBridge, createTauriSystemAudioSource, installTauriSystemAudioSource } = await import('./system-audio-tauri')
const { getSystemAudioSource } = await import('./system-audio-source')
import type { NativeSystemAudioBridge, NativeSystemAudioStatus } from './system-audio-tauri'
import type { SystemAudioSourceEndReason, SystemAudioSourceFrame } from './system-audio-source'

/** Let every queued promise callback run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const READY: NativeSystemAudioStatus = { supported: true, enabled: true, active: false }

test('creating the bridge works in HTTP webviews without crypto.randomUUID', () => {
  const secureOnlyUUID = spyOn(crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('randomUUID is unavailable in an insecure context')
  })
  try {
    expect(createTauriBridge()).toBeDefined()
    expect(secureOnlyUUID).not.toHaveBeenCalled()
  } finally {
    secureOnlyUUID.mockRestore()
  }
})

test('native starts and stops carry an installation key distinct from a newer bridge', async () => {
  nativeInvocations.length = 0
  const old = createTauriBridge()
  const replacement = createTauriBridge()
  await old.start(30, () => {})
  await old.start(5, () => {})
  await replacement.start(10, () => {})
  await old.stop()
  const [first, rateChange, newer, stop] = nativeInvocations
  expect(first.command).toBe('desktop_system_audio_start')
  expect(typeof first.args.sessionKey).toBe('string')
  expect(rateChange.args.sessionKey).toBe(first.args.sessionKey)
  expect(newer.args.sessionKey).not.toBe(first.args.sessionKey)
  expect(stop).toEqual({ command: 'desktop_system_audio_stop', args: { sessionKey: first.args.sessionKey } })
})

/** The wire format native code sends: little-endian f32s [kind, amplitude, peak, band…]. */
function message(kind: number, amplitude = 0, peak = 0, bands: number[] = []): ArrayBuffer {
  return new Float32Array([kind, amplitude, peak, ...bands]).buffer
}

class FakeBridge implements NativeSystemAudioBridge {
  starts: number[] = []
  stereoStarts: boolean[] = []
  stops = 0
  failNextStart: Error | null = null
  statusResult: NativeSystemAudioStatus | Error = READY
  watcher: ((status: NativeSystemAudioStatus) => void) | null = null
  unwatched = 0
  private sinks: Array<(data: unknown) => void> = []

  async status() {
    if (this.statusResult instanceof Error) throw this.statusResult
    return this.statusResult
  }
  async watch(onStatus: (status: NativeSystemAudioStatus) => void) {
    this.watcher = onStatus
    return () => { this.unwatched++ }
  }
  async start(maxFps: number, onMessage: (data: unknown) => void, stereo = false) {
    if (this.failNextStart) {
      const error = this.failNextStart
      this.failNextStart = null
      throw error
    }
    this.starts.push(maxFps)
    this.stereoStarts.push(stereo)
    this.sinks.push(onMessage)
  }
  async stop() { this.stops++ }
  /** Deliver a message on the newest native session's channel. */
  send(data: unknown) { this.sinks[this.sinks.length - 1](data) }
  /** Deliver on an older session's channel (which native code has already replaced). */
  sendOn(index: number, data: unknown) { this.sinks[index](data) }
}

function stereoMessage(): ArrayBuffer {
  return new Float32Array([
    3, 0.5, 0.75, ...new Array(64).fill(0.25),
    0.2, 0.4, ...new Array(64).fill(0.125),
    0.8, 1, ...new Array(64).fill(0.875),
  ]).buffer
}

describe('optional stereo analysis', () => {
  test('native requests carry the explicit mode', async () => {
    nativeInvocations.length = 0
    const bridge = createTauriBridge()
    await bridge.start(15, () => {}, true)
    expect(nativeInvocations[0].args.stereo).toBe(true)
  })

  test('older native builds reject stereo before changing a shared mono session', async () => {
    const { source, bridge, listener } = setup()
    const mono = listener()
    await source.start(mono.handlers, { maxFps: 30 })
    await expect(source.start(listener().handlers, { maxFps: 30, stereo: true })).rejects.toMatchObject({ name: 'NotSupportedError' })
    expect(bridge.starts).toEqual([30])
    bridge.send(message(0, 1, 1, [1]))
    expect(mono.frames).toHaveLength(1)
  })

  test('one shared capture upgrades and downgrades when stereo listeners join and leave', async () => {
    const { source, bridge } = setup({ ...READY, stereoSupported: true })
    const monoFrames: SystemAudioSourceFrame[] = []
    const stereoFrames: SystemAudioSourceFrame[] = []
    const handlers = (frames: SystemAudioSourceFrame[]) => ({ onFrame: (frame: SystemAudioSourceFrame) => frames.push(frame), onEnd() {} })
    const mono = await source.start(handlers(monoFrames), { maxFps: 30 })
    const pending = source.start(handlers(stereoFrames), { maxFps: 10, stereo: true })
    // The old capture can deliver while the new subscriber waits for its upgrade.
    bridge.send(message(0, 0.5, 0.75, [0.25]))
    expect(monoFrames).toHaveLength(1)
    expect(stereoFrames).toHaveLength(0)
    const stereo = await pending
    expect(bridge.starts).toEqual([30, 30])
    expect(bridge.stereoStarts).toEqual([false, true])
    const buffer = stereoMessage()
    bridge.send(buffer)
    const combined = monoFrames.at(-1)!
    const split = stereoFrames[0]
    expect(Object.keys(combined).sort()).toEqual(['amplitude', 'frequencies', 'peak'])
    expect(Array.from(combined.frequencies)).toEqual(new Array(64).fill(0.25))
    expect(split.stereo!.left.amplitude).toBeCloseTo(0.2)
    expect(split.stereo!.right.peak).toBe(1)
    expect(Array.from(split.stereo!.left.frequencies)).toEqual(new Array(64).fill(0.125))
    expect(Array.from(split.stereo!.right.frequencies)).toEqual(new Array(64).fill(0.875))
    expect((split.stereo!.left.frequencies as Float32Array).buffer).toBe(buffer)
    stereo.stop()
    await flush()
    expect(bridge.stereoStarts).toEqual([false, true, false])
    const before = monoFrames.length
    bridge.sendOn(1, stereoMessage())
    expect(monoFrames).toHaveLength(before)
    bridge.send(message(0, 1, 1, [1]))
    expect(monoFrames).toHaveLength(before + 1)
    mono.stop()
    await flush()
    expect(bridge.stops).toBe(1)
  })

  test('stereo capture remains enabled until the last stereo subscriber stops', async () => {
    const { source, bridge, listener } = setup({ ...READY, stereoSupported: true })
    await source.start(listener().handlers, { maxFps: 30 })
    const first = await source.start(listener().handlers, { maxFps: 30, stereo: true })
    const second = await source.start(listener().handlers, { maxFps: 30, stereo: true })
    first.stop()
    await flush()
    expect(bridge.stereoStarts).toEqual([false, true])
    second.stop()
    await flush()
    expect(bridge.stereoStarts).toEqual([false, true, false])
  })

  test('truncated or oversized stereo frames cannot be interpreted as mono bands', async () => {
    const { source, bridge } = setup({ ...READY, stereoSupported: true })
    const frames: SystemAudioSourceFrame[] = []
    await source.start({ onFrame: frame => frames.push(frame), onEnd() {} }, { maxFps: 30, stereo: true })
    bridge.send(stereoMessage().slice(0, -4))
    bridge.send(new Float32Array(200).fill(3).buffer)
    expect(frames).toHaveLength(0)
    bridge.send(stereoMessage())
    expect(frames).toHaveLength(1)
  })

  test('a capture that unexpectedly sends mono ends stereo consumers explicitly', async () => {
    const { source, bridge, listener } = setup({ ...READY, stereoSupported: true })
    const stereo = listener()
    await source.start(stereo.handlers, { maxFps: 30, stereo: true })
    bridge.send(message(0, 1, 1, [1]))
    expect(stereo.frames).toHaveLength(0)
    expect(stereo.ends).toEqual(['source-lost'])
  })
})

function setup(status: NativeSystemAudioStatus = READY) {
  const bridge = new FakeBridge()
  const { source, update } = createTauriSystemAudioSource(bridge, status)
  const listener = () => {
    const frames: Array<{ amplitude: number; peak: number; frequencies: number[] }> = []
    const ends: SystemAudioSourceEndReason[] = []
    return {
      frames,
      ends,
      handlers: {
        // Copy, as the real API does: `frequencies` is only valid during the call.
        onFrame: (frame: { amplitude: number; peak: number; frequencies: ArrayLike<number> }) =>
          frames.push({ amplitude: frame.amplitude, peak: frame.peak, frequencies: Array.from(frame.frequencies) }),
        onEnd: (reason: SystemAudioSourceEndReason) => ends.push(reason),
      },
    }
  }
  return { bridge, source, update, listener }
}

describe('availability', () => {
  test('maps the native status to the three states extensions can see', () => {
    const { source, update } = setup({ supported: false, enabled: false, active: false })
    expect(source.availability()).toEqual({ available: false, reason: 'unsupported' })
    update({ supported: true, enabled: false, active: false })
    expect(source.availability()).toEqual({ available: false, reason: 'disabled' })
    update(READY)
    expect(source.availability()).toEqual({ available: true })
  })
})

describe('a session', () => {
  test('starts native analysis at the requested rate and decodes frames without copying them', async () => {
    const { bridge, source, listener } = setup()
    const a = listener()
    await source.start(a.handlers, { maxFps: 24 })
    expect(bridge.starts).toEqual([24])

    bridge.send(message(0, 0.5, 0.75, [0.25, 0.5, 1]))
    expect(a.frames).toEqual([{ amplitude: 0.5, peak: 0.75, frequencies: [0.25, 0.5, 1] }])
  })

  test('defaults to 30 fps and clamps what a caller asks for', async () => {
    const { bridge, source, listener } = setup()
    await source.start(listener().handlers)
    await source.start(listener().handlers, { maxFps: 1000 })
    await source.start(listener().handlers, { maxFps: -5 })
    expect(bridge.starts).toEqual([30])
  })

  test('stopping the only listener stops native analysis', async () => {
    const { bridge, source, listener } = setup()
    const handle = await source.start(listener().handlers, { maxFps: 10 })
    handle.stop()
    await flush()
    expect(bridge.stops).toBe(1)
    handle.stop() // idempotent
    await flush()
    expect(bridge.stops).toBe(1)
  })

  test('the native stop failing does not throw out of stop()', async () => {
    const { bridge, source, listener } = setup()
    bridge.stop = async () => { throw new Error('gone') }
    const handle = await source.start(listener().handlers)
    expect(() => handle.stop()).not.toThrow()
    await flush()
  })

  test('a failed native start rejects and leaves nothing behind', async () => {
    const { bridge, source, listener } = setup()
    bridge.failNextStart = new Error('System audio is turned off in the Lumiverse desktop client')
    const a = listener()
    await expect(source.start(a.handlers, { maxFps: 10 })).rejects.toThrow('turned off')
    // Nothing is retained: the next start begins fresh and only the new listener hears frames.
    const b = listener()
    await source.start(b.handlers, { maxFps: 10 })
    bridge.send(message(0, 1, 1, [1]))
    expect(a.frames).toEqual([])
    expect(b.frames.length).toBe(1)
  })
})

describe('several extensions', () => {
  test('lowers the native rate when the fastest listener leaves and ignores the old channel', async () => {
    const { bridge, source, listener } = setup()
    const slow = listener()
    await source.start(slow.handlers, { maxFps: 5 })
    const fast = await source.start(listener().handlers, { maxFps: 30 })
    fast.stop()
    await flush()
    expect(bridge.starts).toEqual([5, 30, 5])
    bridge.sendOn(1, message(0, 1, 1, [1]))
    expect(slow.frames).toEqual([])
    bridge.send(message(0, 0.5, 0.5, [0.5]))
    expect(slow.frames.length).toBe(1)
  })
  test('share one native session at the fastest rate and all receive frames', async () => {
    const { bridge, source, listener } = setup()
    const slow = listener()
    const fast = listener()
    await source.start(slow.handlers, { maxFps: 10 })
    await source.start(fast.handlers, { maxFps: 30 })
    // The second listener needed more, so the session was replaced once at the higher rate.
    expect(bridge.starts).toEqual([10, 30])

    bridge.send(message(0, 0.2, 0.4, [0.1]))
    expect(slow.frames.length).toBe(1)
    expect(fast.frames.length).toBe(1)
  })

  test('a slower listener joining a faster session does not restart it', async () => {
    const { bridge, source, listener } = setup()
    await source.start(listener().handlers, { maxFps: 30 })
    await source.start(listener().handlers, { maxFps: 5 })
    expect(bridge.starts).toEqual([30])
  })

  test('native analysis continues until the last listener leaves', async () => {
    const { bridge, source, listener } = setup()
    const first = await source.start(listener().handlers, { maxFps: 30 })
    const second = await source.start(listener().handlers, { maxFps: 30 })
    first.stop()
    await flush()
    expect(bridge.stops).toBe(0)
    second.stop()
    await flush()
    expect(bridge.stops).toBe(1)
  })

  test('concurrent starts never interleave their native calls', async () => {
    const { bridge, source, listener } = setup()
    const order: string[] = []
    const original = bridge.start.bind(bridge)
    bridge.start = async (fps, sink) => {
      order.push(`begin ${fps}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      await original(fps, sink)
      order.push(`end ${fps}`)
    }
    await Promise.all([source.start(listener().handlers, { maxFps: 10 }), source.start(listener().handlers, { maxFps: 20 })])
    // Both were registered before the first native call, so one start at the faster rate serves them both.
    expect(order).toEqual(['begin 20', 'end 20'])
    // A later, faster listener is a separate call and must wait for nothing: it simply replaces the session.
    await source.start(listener().handlers, { maxFps: 30 })
    expect(order).toEqual(['begin 20', 'end 20', 'begin 30', 'end 30'])
  })

  test('frames from a replaced native session are ignored', async () => {
    const { bridge, source, listener } = setup()
    const a = listener()
    await source.start(a.handlers, { maxFps: 10 })
    await source.start(listener().handlers, { maxFps: 30 })
    bridge.sendOn(0, message(0, 1, 1, [1])) // the first, now-replaced session's channel
    expect(a.frames).toEqual([])
    bridge.sendOn(1, message(0, 0.5, 0.5, [0.5]))
    expect(a.frames.length).toBe(1)
  })
})

describe('ending', () => {
  test.each([
    [1, 'source-lost'],
    [2, 'host-disabled'],
  ] as const)('native kind %i ends every listener with %s and frees the session', async (kind, reason) => {
    const { bridge, source, listener } = setup()
    const a = listener()
    const b = listener()
    await source.start(a.handlers, { maxFps: 30 })
    await source.start(b.handlers, { maxFps: 30 })
    bridge.send(message(kind))
    expect(a.ends).toEqual([reason])
    expect(b.ends).toEqual([reason])

    // Later frames are ignored, and a fresh start opens a new native session.
    bridge.send(message(0, 1, 1, [1]))
    expect(a.frames).toEqual([])
    await source.start(listener().handlers, { maxFps: 30 })
    expect(bridge.starts.length).toBe(2)
  })

  test('a failing onEnd does not stop the others hearing about it', async () => {
    const { bridge, source, listener } = setup()
    const quiet = listener()
    await source.start({ onFrame() {}, onEnd() { throw new Error('boom') } }, { maxFps: 30 })
    await source.start(quiet.handlers, { maxFps: 30 })
    bridge.send(message(1))
    expect(quiet.ends).toEqual(['source-lost'])
  })

  test('a replacement that fails ends the listeners it would have served', async () => {
    const { bridge, source, listener } = setup()
    const a = listener()
    await source.start(a.handlers, { maxFps: 10 })
    bridge.failNextStart = new Error('device busy')
    await expect(source.start(listener().handlers, { maxFps: 30 })).rejects.toThrow('device busy')
    expect(a.ends).toEqual(['source-lost'])
  })
})

describe('untrusted input', () => {
  test.each([
    ['a string', 'hello'],
    ['null', null],
    ['a plain array', [0, 1, 2, 3]],
    ['a typed array rather than its buffer', new Float32Array([0, 1, 1, 1])],
    ['a buffer that is not a whole number of floats', new ArrayBuffer(15)],
    ['a buffer shorter than the header', new Float32Array([0, 1]).buffer],
    ['an unknown kind', message(7, 1, 1, [1])],
  ])('ignores %s', async (_name, data) => {
    const { bridge, source, listener } = setup()
    const a = listener()
    await source.start(a.handlers, { maxFps: 30 })
    bridge.send(data)
    expect(a.frames).toEqual([])
    expect(a.ends).toEqual([])
  })
})

describe('installing', () => {
  test('uninstall stops active capture, ends subscribers, and rejects retained start calls', async () => {
    const bridge = new FakeBridge()
    const uninstall = await installTauriSystemAudioSource(bridge)
    const retained = getSystemAudioSource()!
    const frames: unknown[] = []
    const ends: SystemAudioSourceEndReason[] = []
    await retained.start({ onFrame: (frame) => frames.push(frame), onEnd: (reason) => ends.push(reason) })
    uninstall()
    uninstall()
    await flush()
    expect(bridge.stops).toBe(1)
    expect(ends).toEqual(['source-lost'])
    bridge.send(message(0, 1, 1, [1]))
    expect(frames).toEqual([])
    expect(getSystemAudioSource()).toBeNull()
    await expect(retained.start({ onFrame() {}, onEnd() {} })).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('uninstall cancels pending startup and stops its late native handle', async () => {
    const bridge = new FakeBridge()
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const original = bridge.start.bind(bridge)
    bridge.start = async (fps, sink) => { await pending; await original(fps, sink) }
    const uninstall = await installTauriSystemAudioSource(bridge)
    const ends: SystemAudioSourceEndReason[] = []
    const startup = getSystemAudioSource()!.start({ onFrame() {}, onEnd: (reason) => ends.push(reason) })
    const rejected = startup.catch((error: unknown) => error)
    await flush()
    uninstall()
    expect(bridge.stops).toBe(1)
    expect(ends).toEqual(['source-lost'])
    release()
    expect(await rejected).toMatchObject({ name: 'AbortError' })
    await flush()
    expect(bridge.stops).toBe(2)
  })

  test('disposal before queued startup prevents opening the device', async () => {
    const bridge = new FakeBridge()
    const { source, dispose } = createTauriSystemAudioSource(bridge, READY)
    const startup = source.start({ onFrame() {}, onEnd() {} })
    const rejected = startup.catch((error: unknown) => error)
    await dispose()
    expect(await rejected).toMatchObject({ name: 'AbortError' })
    expect(bridge.starts).toEqual([])
    expect(bridge.stops).toBe(1)
  })
  test('registers the source when the build can hear the output device', async () => {
    const bridge = new FakeBridge()
    const uninstall = await installTauriSystemAudioSource(bridge)
    const registered = getSystemAudioSource()
    expect(registered?.availability()).toEqual({ available: true })

    // The tray switch reaches the registered source through the watcher.
    await flush()
    bridge.watcher!({ supported: true, enabled: false, active: false })
    expect(registered?.availability()).toEqual({ available: false, reason: 'disabled' })

    uninstall()
    expect(getSystemAudioSource()).toBeNull()
    expect(bridge.unwatched).toBe(1)
  })

  test('registers nothing on an unsupported OS', async () => {
    const bridge = new FakeBridge()
    bridge.statusResult = { supported: false, enabled: false, active: false }
    await installTauriSystemAudioSource(bridge)
    expect(getSystemAudioSource()).toBeNull()
  })

  test('registers nothing when native code refuses the question (a window with no grant)', async () => {
    const bridge = new FakeBridge()
    bridge.statusResult = new Error('command not allowed')
    await installTauriSystemAudioSource(bridge)
    expect(getSystemAudioSource()).toBeNull()
  })
})
