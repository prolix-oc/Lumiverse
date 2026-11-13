import { describe, expect, spyOn, test } from 'bun:test'
import { createFrontendTTSAPI } from './tts-api'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  let session = 0
  let engine = false
  let element = false
  let active = true
  let granted = true
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of [...listeners]) listener() }
  const starts: unknown[] = []
  const cancels: number[] = []
  const synth = new Map<number, ReturnType<typeof deferred>>()
  const teardown: Array<() => void> = []
  const bridge = createFrontendTTSAPI({
    assertActive() { if (!active) throw new Error('SPINDLE_FRONTEND_INACTIVE') },
    requirePermission(permission) { expect(permission).toBe('media'); if (!granted) throw new Error('PERMISSION_DENIED:media') },
    onTeardown(cb) { teardown.push(cb); return () => {} },
    isSpeaking: () => engine || element,
    isEngineSpeaking: () => engine,
    getSession: () => session,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    start(input, options) {
      starts.push({ input, options })
      session++; engine = true; notify()
      const own = session
      const done = deferred()
      synth.set(own, done)
      return { session: own, synthesized: done.promise, cancel: () => cancels.push(own) }
    },
    stopEngine() { session++; engine = false; notify() },
    stopAll() { session++; engine = false; element = false; notify() },
  })
  return {
    tts: bridge.api, bridge, starts, cancels, synth, teardown, listeners,
    end() { engine = false; notify() },
    playElement(value: boolean) { element = value; notify() },
    hostStart() { session++; engine = true; notify() },
    setActive(value: boolean) { active = value },
    setGranted(value: boolean) { granted = value },
    get session() { return session },
  }
}

const settled = async (promise: Promise<unknown>) => {
  let state = 'pending'
  promise.then(() => { state = 'resolved' }, () => { state = 'rejected' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return state
}

describe('ctx.tts bridge', () => {
  test('speak resolves when its playback ends and reports a synthesis failure', async () => {
    const f = fixture()
    const spoken = f.tts.speak({ text: 'Opening world books.' }, { connectionId: 'tts-1' })
    expect(f.starts).toEqual([{ input: { text: 'Opening world books.' }, options: { connectionId: 'tts-1' } }])
    expect(f.tts.isSpeaking()).toBe(true)
    f.synth.get(1)!.resolve()
    expect(await settled(spoken)).toBe('pending')
    f.end()
    await expect(spoken).resolves.toBeUndefined()

    const failed = f.tts.speak({ text: 'Hello' })
    f.synth.get(2)!.reject(new Error('TTS provider said no'))
    f.end()
    await expect(failed).rejects.toThrow('TTS provider said no')
  })

  test('stop and a newer playback end speak early, cancel synthesis and drop its errors', async () => {
    const f = fixture()
    const first = f.tts.speak({ messageId: 'message-1' })
    const second = f.tts.speak({ text: 'Newer' })
    await expect(first).resolves.toBeUndefined()
    expect(f.cancels).toEqual([1])
    f.tts.stop()
    f.synth.get(2)!.reject(new Error('aborted'))
    await expect(second).resolves.toBeUndefined()
    expect(f.cancels).toEqual([1, 2])

    // Host playback (e.g. the user presses Play) also ends an extension's speak.
    const third = f.tts.speak({ text: 'Third' })
    f.hostStart()
    await expect(third).resolves.toBeUndefined()
  })

  test('speak and stop need media; bad input fails before playback', async () => {
    const f = fixture()
    await expect(f.tts.speak({ text: ' ' })).rejects.toThrow('TTS_INPUT_INVALID')
    await expect(f.tts.speak({ text: 'a', messageId: 'b' } as never)).rejects.toThrow('TTS_INPUT_INVALID')
    await expect(f.tts.speak({ text: ' ', messageId: 'b' } as never)).rejects.toThrow('TTS_INPUT_INVALID')
    await expect(f.tts.speak(null as never)).rejects.toThrow('TTS_INPUT_INVALID')
    await expect(f.tts.speak({ text: 'Hello' }, { connectionId: '' })).rejects.toThrow('TTS_INPUT_INVALID')
    await expect(f.tts.speak({ messageId: 'message-1' } as never, { connectionId: 'tts-1' })).rejects.toThrow('connectionId applies to text only')
    f.setGranted(false)
    await expect(f.tts.speak({ text: 'Hello' })).rejects.toThrow('PERMISSION_DENIED:media')
    expect(() => f.tts.stop()).toThrow('PERMISSION_DENIED:media')
    expect(f.starts).toHaveLength(0)
    expect(f.tts.isSpeaking()).toBe(false)
    expect(() => f.tts.subscribe(() => {})()).not.toThrow()
  })

  test('subscribe reports every host playback change once, including saved message audio', async () => {
    const f = fixture()
    const seen: boolean[] = []
    const unsubscribe = f.tts.subscribe((speaking) => { seen.push(speaking) })
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    f.tts.subscribe(() => { throw new Error('listener bug') })
    f.hostStart()
    f.hostStart()
    f.end()
    f.playElement(true)
    f.hostStart()
    f.end()
    f.playElement(false)
    expect(seen).toEqual([true, false, true, false])
    expect(consoleError).toHaveBeenCalledTimes(4)
    consoleError.mockRestore()
    unsubscribe()
    f.hostStart()
    expect(seen).toEqual([true, false, true, false])
  })

  test('media revoke and teardown stop only playback this extension started', async () => {
    const f = fixture()
    f.hostStart()
    f.bridge.revoke()
    expect(f.tts.isSpeaking()).toBe(true)

    const spoken = f.tts.speak({ text: 'Mine' })
    f.bridge.revoke()
    await expect(spoken).resolves.toBeUndefined()
    expect(f.tts.isSpeaking()).toBe(false)

    const pending = f.tts.speak({ text: 'Unload me' })
    f.tts.subscribe(() => {})
    f.teardown.forEach((cb) => cb())
    await expect(pending).resolves.toBeUndefined()
    expect(f.listeners.size).toBe(0)
    expect(() => f.tts.isSpeaking()).toThrow('SPINDLE_FRONTEND_INACTIVE')
  })

  test('revocation preserves a replacement playback owned by the host', async () => {
    const f = fixture()
    const spoken = f.tts.speak({ text: 'Mine' })
    f.hostStart()
    f.bridge.revoke()
    expect(f.tts.isSpeaking()).toBe(true)
    await spoken
    expect(f.cancels).toEqual([1])
    f.end()
  })
})
