import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { WhistleClient } from './client'
import type { WhistleTranscript } from './config'
import type { STTConfig } from '../sttEngine'

mock.module('./capture.worklet.ts?worker&url', () => ({ default: 'capture-test.js' }))
const { WhistleSTTEngine } = await import('./WhistleSTTEngine')

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const originalWorklet = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode')
const originalContext = (window as any).AudioContext
const engines: InstanceType<typeof WhistleSTTEngine>[] = []

class FakeNode {
  connect() {}
  disconnect() {}
  gain = { value: 1 }
  fftSize = 1024
  frequencyBinCount = 512
  getByteFrequencyData(bytes: Uint8Array) { bytes.fill(0) }
}
class FakeContext {
  state = 'running'
  sampleRate = 48000
  destination = new FakeNode()
  audioWorklet = { addModule: async () => {} }
  resume() { return Promise.resolve() }
  close() { this.state = 'closed'; return Promise.resolve() }
  createMediaStreamSource() { return new FakeNode() }
  createAnalyser() { return new FakeNode() }
  createGain() { return new FakeNode() }
  createScriptProcessor() { return new FakeLegacyCapture() }
}
class FakeLegacyCapture extends FakeNode {
  static latest: FakeLegacyCapture
  onaudioprocess: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null = null
  constructor() { super(); FakeLegacyCapture.latest = this }
  audio(pcm: Float32Array) { this.onaudioprocess?.({ inputBuffer: { getChannelData: () => pcm } }) }
}
class FakeCapture extends FakeNode {
  static latest: FakeCapture
  onprocessorerror: (() => void) | null = null
  port = {
    onmessage: null as null | ((event: { data: unknown }) => void),
    postMessage: () => queueMicrotask(() => this.port.onmessage?.({ data: { type: 'stopped' } })),
  }
  constructor() { super(); FakeCapture.latest = this }
  audio(pcm: Float32Array) { this.port.onmessage?.({ data: { type: 'audio', pcm } }) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup(options: { microphone?: () => Promise<unknown>; prepare?: () => Promise<void>; transcribe?: (pcm: Float32Array) => Promise<WhistleTranscript>; config?: Partial<STTConfig>; legacyCapture?: boolean; workletFailure?: boolean; workletLoad?: () => Promise<void> } = {}) {
  let stoppedTracks = 0
  let released = 0
  const track = { stop: () => { stoppedTracks++ }, onended: null }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia: options.microphone || (() => Promise.resolve(stream)) },
  } })
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: options.legacyCapture ? undefined : FakeCapture })
  ;(window as any).AudioContext = class extends FakeContext {
    audioWorklet = { addModule: async () => {
      if (options.workletFailure) throw new Error('Worklet unavailable')
      await options.workletLoad?.()
    } }
  }
  const client = {
    retain: () => () => { released++ }, subscribe: () => () => {},
    prepare: options.prepare || (() => Promise.resolve()),
    transcribe: options.transcribe || (() => Promise.resolve({ text: 'hello', language: 'en', words: [
      { word: 'hello', start: 0, end: 0.1, probability: 1 },
    ] })),
  } as unknown as WhistleClient
  const engine = new WhistleSTTEngine({ provider: 'whistle', language: 'en', continuous: true, interimResults: false, ...options.config }, client)
  engines.push(engine)
  return { engine, stream, stoppedTracks: () => stoppedTracks, released: () => released }
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.destroy()
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else Reflect.deleteProperty(globalThis, 'navigator')
  if (originalWorklet) Object.defineProperty(globalThis, 'AudioWorkletNode', originalWorklet)
  else Reflect.deleteProperty(globalThis, 'AudioWorkletNode')
  ;(window as any).AudioContext = originalContext
})

describe('Whistle recorder lifecycle', () => {
  test.each([false, true])('captures early speech while the model is preparing (legacy: %s)', async (legacyCapture) => {
    const preparation = deferred<void>()
    let samples: Float32Array | null = null
    const { engine, stoppedTracks } = setup({
      legacyCapture, prepare: () => preparation.promise,
      transcribe: async (pcm) => {
        samples = pcm
        return { text: 'early speech', language: 'en', words: [
          { word: 'early', start: 0, end: 0.1, probability: 1 },
          { word: 'speech', start: 0.1, end: 0.2, probability: 1 },
        ] }
      },
    })
    const complete = deferred<void>()
    const results: string[] = []
    engine.onResult((result) => results.push(result.text))
    engine.onStop(() => complete.resolve())
    await engine.start()
    expect(engine.isListening()).toBe(true)
    if (legacyCapture) {
      FakeLegacyCapture.latest.audio(new Float32Array(4800).fill(0.2))
      FakeLegacyCapture.latest.audio(new Float32Array(4800).fill(0.4))
    } else {
      FakeCapture.latest.audio(new Float32Array(1600).fill(0.2))
      FakeCapture.latest.audio(new Float32Array(1600).fill(0.4))
    }
    engine.stop()
    await Promise.resolve()
    expect(stoppedTracks()).toBe(1)
    expect(samples).toBeNull()
    expect(results).toEqual([])
    preparation.resolve()
    await complete.promise
    expect(samples!.length).toBe(3200)
    expect(samples![0]).toBeCloseTo(0.2)
    expect(samples![1600]).toBeCloseTo(0.4)
    expect(results).toEqual(['early speech'])
  })

  test('starts fallback capture without waiting for a slow AudioWorklet module', async () => {
    const worklet = deferred<void>()
    const { engine, stoppedTracks } = setup({ workletLoad: () => worklet.promise })
    let frames = 0
    engine.onAudioFrame(() => frames++)
    await engine.start()
    expect(engine.isListening()).toBe(true)
    FakeLegacyCapture.latest.audio(new Float32Array(4800).fill(0.2))
    expect(frames).toBe(1)
    engine.destroy()
    worklet.resolve()
    await Promise.resolve()
    expect(stoppedTracks()).toBe(1)
    expect(engine.isListening()).toBe(false)
  })

  test('releases an active microphone if background model preparation fails', async () => {
    const preparation = deferred<void>()
    const { engine, stoppedTracks, released } = setup({ prepare: () => preparation.promise })
    const errors: string[] = []
    const stopped = deferred<void>()
    engine.onError((error) => errors.push(error.message))
    engine.onStop(() => stopped.resolve())
    await engine.start()
    expect(engine.isListening()).toBe(true)
    preparation.reject(new Error('Download failed'))
    await stopped.promise
    expect(errors).toEqual(['Download failed'])
    expect(stoppedTracks()).toBe(1)
    expect(released()).toBe(1)
    expect(engine.isListening()).toBe(false)
  })

  test('ignores a late preparation error after an empty recording has finished', async () => {
    const preparation = deferred<void>()
    const { engine } = setup({ prepare: () => preparation.promise })
    const errors: string[] = []
    const stopped = deferred<void>()
    engine.onError((error) => errors.push(error.message))
    engine.onStop(() => stopped.resolve())
    await engine.start()
    engine.stop()
    await stopped.promise
    preparation.reject(new Error('Late download failure'))
    await Promise.resolve()
    expect(errors).toEqual([])
  })

  test('settles cancelled startup without waiting for microphone permission', async () => {
    const microphone = deferred<unknown>()
    const { engine, stream, stoppedTracks } = setup({ microphone: () => microphone.promise })
    const starting = engine.start()
    engine.destroy()
    await starting
    expect(engine.isListening()).toBe(false)
    microphone.resolve(stream)
    await Promise.resolve()
    expect(stoppedTracks()).toBe(1)
  })

  test.each(['missing', 'failed'])('captures and flushes every sample when the worklet is %s', async (worklet) => {
    let samples: Float32Array = new Float32Array()
    const { engine, stoppedTracks } = setup({
      legacyCapture: worklet === 'missing', workletFailure: worklet === 'failed',
      transcribe: async (pcm) => { samples = pcm; return { text: 'fallback works', language: 'en', words: [
        { word: 'fallback', start: 0, end: 0.05, probability: 1 },
        { word: 'works', start: 0.05, end: 0.15, probability: 1 },
      ] } },
    })
    const complete = deferred<void>()
    const results: string[] = []
    engine.onResult((result) => results.push(result.text))
    engine.onStop(() => complete.resolve())
    await engine.start()
    expect(engine.isListening()).toBe(true)
    // 150 ms at 48 kHz includes a complete 100 ms frame and a partial final frame.
    FakeLegacyCapture.latest.audio(new Float32Array(7200).fill(0.2))
    engine.stop()
    await complete.promise
    expect(samples.length).toBe(2400)
    expect(samples[2399]).toBeCloseTo(0.2)
    expect(results).toEqual(['fallback works'])
    expect(stoppedTracks()).toBe(1)
    expect(FakeLegacyCapture.latest.onaudioprocess).toBeNull()
  })

  test('auto-submit safely flushes legacy capture after silence inside an audio callback', async () => {
    const { engine, stoppedTracks } = setup({ legacyCapture: true, config: { autoSubmitOnSilence: true } })
    const complete = deferred<void>()
    engine.onStop(() => complete.resolve())
    await engine.start()
    FakeLegacyCapture.latest.audio(new Float32Array(9600).fill(0.2))
    FakeLegacyCapture.latest.audio(new Float32Array(76800))
    await complete.promise
    expect(engine.isListening()).toBe(false)
    expect(stoppedTracks()).toBe(1)
  })

  test('cancellation suppresses an already-dispatched legacy audio callback', async () => {
    let transcriptions = 0
    const { engine, stoppedTracks } = setup({ legacyCapture: true, transcribe: async () => {
      transcriptions++
      return { text: 'late', language: 'en', words: [] }
    } })
    await engine.start()
    const callback = FakeLegacyCapture.latest.onaudioprocess!
    engine.destroy()
    callback({ inputBuffer: { getChannelData: () => new Float32Array(4800) } })
    await Promise.resolve()
    expect(transcriptions).toBe(0)
    expect(stoppedTracks()).toBe(1)
  })

  test('reports denied microphone permission immediately while preparation is pending', async () => {
    const preparation = deferred<void>()
    const { engine, released } = setup({
      microphone: async () => { throw new Error('Microphone permission denied') },
      prepare: () => preparation.promise,
    })
    let message = ''
    engine.onError((error) => { message = error.message })
    await engine.start()
    expect(message).toBe('Microphone permission denied')
    expect(engine.isListening()).toBe(false)
    expect(released()).toBe(1)
    preparation.resolve()
  })

  test('stops a microphone that resolves after initialization has failed', async () => {
    const microphone = deferred<unknown>()
    const { engine, stream, stoppedTracks } = setup({
      microphone: () => microphone.promise, prepare: async () => { throw new Error('Download failed') },
    })
    await engine.start()
    microphone.resolve(stream)
    await Promise.resolve()
    expect(stoppedTracks()).toBe(1)
    expect(engine.isListening()).toBe(false)
  })

  test('cancels while loading and releases microphone resources before preparation completes', async () => {
    const preparation = deferred<void>()
    const { engine, stoppedTracks } = setup({ prepare: () => preparation.promise })
    const starting = engine.start()
    await Promise.resolve()
    engine.destroy()
    preparation.resolve()
    await starting
    expect(stoppedTracks()).toBe(1)
    expect(engine.isListening()).toBe(false)
  })

  test('emits one completed transcript after the worklet flush and releases the microphone', async () => {
    const { engine, stoppedTracks, released } = setup()
    const complete = deferred<void>()
    const results: string[] = []
    engine.onResult((result) => results.push(result.text))
    engine.onStop(() => complete.resolve())
    await engine.start()
    FakeCapture.latest.audio(new Float32Array(1600).fill(0.2))
    engine.stop()
    await complete.promise
    expect(results).toEqual(['hello'])
    expect(stoppedTracks()).toBe(1)
    expect(released()).toBe(1)
  })

  test('suppresses completed inference and stop callbacks after destruction', async () => {
    const inference = deferred<WhistleTranscript>()
    const { engine, stoppedTracks } = setup({ transcribe: () => inference.promise })
    let callbacks = 0
    engine.onResult(() => callbacks++)
    engine.onStop(() => callbacks++)
    await engine.start()
    FakeCapture.latest.audio(new Float32Array(1600).fill(0.2))
    engine.stop()
    await Promise.resolve()
    await Promise.resolve()
    engine.destroy()
    inference.resolve({ text: 'late', language: 'en', words: [] })
    await Promise.resolve()
    await Promise.resolve()
    expect(callbacks).toBe(0)
    expect(stoppedTracks()).toBe(1)
  })

  test('continuous recognition emits silence-delimited utterances and keeps recording', async () => {
    const { engine } = setup()
    const utterance = deferred<void>()
    let stopCallbacks = 0
    engine.onStop(() => stopCallbacks++)
    engine.onResult(() => utterance.resolve())
    await engine.start()
    for (let i = 0; i < 2; i++) FakeCapture.latest.audio(new Float32Array(1600).fill(0.2))
    for (let i = 0; i < 16; i++) FakeCapture.latest.audio(new Float32Array(1600))
    await utterance.promise
    expect(engine.isListening()).toBe(true)
    expect(stopCallbacks).toBe(0)
  })

  test('auto-submit ends continuous recognition after speech and sustained silence', async () => {
    const { engine } = setup({ config: { autoSubmitOnSilence: true } })
    const complete = deferred<void>()
    const results: string[] = []
    engine.onResult((result) => results.push(result.text))
    engine.onStop(() => complete.resolve())
    await engine.start()
    for (let i = 0; i < 2; i++) FakeCapture.latest.audio(new Float32Array(1600).fill(0.2))
    for (let i = 0; i < 16; i++) FakeCapture.latest.audio(new Float32Array(1600))
    await complete.promise
    expect(engine.isListening()).toBe(false)
    expect(results).toEqual(['hello'])
  })
})
