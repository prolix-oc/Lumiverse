import { afterAll, describe, expect, mock, test } from 'bun:test'

mock.module('./whistle/WhistleSTTEngine', () => ({ WhistleSTTEngine: class {} }))
let response!: (value: { text: string }) => void
let signal: AbortSignal | undefined
mock.module('@/api/stt', () => ({ sttApi: {
  transcribe(_audio: Blob, options: { signal: AbortSignal }) {
    signal = options.signal
    return new Promise<{ text: string }>((resolve) => { response = resolve })
  },
} }))

const original = new Map(['window', 'navigator', 'MediaRecorder'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
let stopped = 0
let permission!: (stream: MediaStream) => void
const stream = { getTracks: () => [{ stop() { stopped++ } }] } as unknown as MediaStream
class Recorder {
  static isTypeSupported() { return true }
  state = 'inactive'
  ondataavailable!: (event: { data: Blob }) => void
  onstop!: () => Promise<void>
  completion: Promise<void> | undefined
  constructor(_stream: MediaStream, _options: unknown) {}
  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['audio']) })
    this.completion = this.onstop?.()
  }
}
Object.defineProperties(globalThis, {
  window: { configurable: true, value: {} },
  navigator: { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise<MediaStream>((resolve) => { permission = resolve }) } } },
  MediaRecorder: { configurable: true, value: Recorder },
})
afterAll(() => {
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})
const { createSTTEngine } = await import('./sttEngine')
const config = { provider: 'connection' as const, language: 'en', continuous: true, interimResults: true, connectionId: 'connection' }

describe('connection capture cleanup', () => {
  test('cancelling a pending microphone request releases its late stream', async () => {
    stopped = 0
    const engine = createSTTEngine(config)
    const startup = engine.start()
    engine.destroy(); permission(stream); await startup
    expect(stopped).toBe(1); expect(engine.isListening()).toBe(false)
  })

  test('stop releases the microphone before inference and cancellation suppresses a late response', async () => {
    stopped = 0; let results = 0; let errors = 0
    const engine = createSTTEngine(config)
    engine.onResult(() => { results++ }); engine.onError(() => { errors++ })
    const startup = engine.start(); permission(stream); await startup
    engine.stop()
    expect(stopped).toBe(1)
    engine.destroy(); expect(signal?.aborted).toBe(true)
    response({ text: 'late transcript' }); await Promise.resolve(); await Promise.resolve()
    expect(results).toBe(0); expect(errors).toBe(0); expect(engine.isListening()).toBe(false)
  })
})
