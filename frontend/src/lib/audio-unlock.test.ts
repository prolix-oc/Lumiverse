import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'

mock.module('@/api/client', () => ({ BASE_URL: '/api/v1' }))

let dom: JSDOM
let previous: Record<string, PropertyDescriptor | undefined>
let moduleId = 0
const contexts: FakeContext[] = []
const audioElements: FakeAudio[] = []
const disposers: (() => void)[] = []
const soundRequests: { src: string; options?: RequestInit }[] = []

class FakeSource {
  buffer: unknown = null
  playbackRate = { value: 1 }
  onended: (() => void) | null = null
  stopped = false
  disconnected = false
  constructor(private context: FakeContext) {}
  connect() {}
  disconnect() { this.disconnected = true }
  start() {
    if (this.context.failStart) throw new Error('start failed')
    this.context.starts++
  }
  stop() { this.stopped = true }
}

class FakeAudio {
  volume = 1
  currentTime = 0
  played: string[] = []
  constructor(public src = '') { audioElements.push(this) }
  play() { this.played.push(this.src); return Promise.resolve() }
}

class FakeContext {
  state = 'suspended'
  sampleRate = 48000
  currentTime = 0
  destination = {}
  silentBuffers = 0
  resumes = 0
  starts = 0
  closes = 0
  failDecode = false
  failResume = false
  failStart = false
  sources: FakeSource[] = []
  gains: { gain: { value: number }; connect(): void }[] = []
  constructor() { contexts.push(this) }
  createGain() {
    const gain = { gain: { value: 1 }, connect() {} }
    this.gains.push(gain)
    return gain
  }
  createBuffer() { this.silentBuffers++; return { duration: 1 / this.sampleRate } }
  createBufferSource() {
    const source = new FakeSource(this)
    this.sources.push(source)
    return source
  }
  decodeAudioData() { return this.failDecode ? Promise.reject(new Error('decode failed')) : Promise.resolve({ duration: 0.1 }) }
  resume() {
    this.resumes++
    if (this.failResume) return Promise.reject(new Error('resume failed'))
    this.state = 'running'
    return Promise.resolve()
  }
  close() { this.closes++; this.state = 'closed'; return Promise.resolve() }
}

beforeEach(() => {
  dom = new JSDOM('', { url: 'https://lumiverse.example/' })
  previous = Object.fromEntries(['window', 'document', 'Audio', 'AudioContext', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Audio: FakeAudio, AudioContext: FakeContext })
  Object.assign(window, { AudioContext: FakeContext })
  globalThis.fetch = mock(async (src, options) => {
    soundRequests.push({ src: String(src), options })
    return new Response(new Uint8Array([1, 2, 3, 4]))
  }) as unknown as typeof fetch
})

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  dom.window.close()
  for (const [key, descriptor] of Object.entries(previous)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  contexts.length = 0
  audioElements.length = 0
  soundRequests.length = 0
})

async function modules() {
  // Each document owns its own audio singletons, as it does in the app.
  const notificationPath = `./notificationAudio.ts?document=${++moduleId}`
  const ttsPath = `./ttsAudio.ts?document=${moduleId}`
  const notification = await import(notificationPath) as typeof import('./notificationAudio')
  const tts = await import(ttsPath) as typeof import('./ttsAudio')
  disposers.push(() => tts.stop())
  return { notification, tts }
}

function nativeHost(platform: string) {
  if (platform.endsWith('-init')) {
    Object.assign(window, { __LUMIVERSE_MOBILE__: true, __LUMIVERSE_PLATFORM__: platform.replace('-init', '') })
    return
  }
  if (platform === 'android' || platform === 'ios') document.documentElement.dataset.tauriMobile = platform
  else document.documentElement.dataset.tauriDesktop = ''
  document.documentElement.dataset.platform = platform
}

// At document start the wrappers expose window flags before DOMContentLoaded
// installs the HTML attributes. Audio must skip priming in both phases.
const platforms = ['android', 'ios', 'android-init', 'ios-init', 'macos', 'windows', 'linux']

test.each(platforms)('%s never plays silent unlock audio on startup, touch, or Send', async platform => {
  nativeHost(platform)
  const { notification, tts } = await modules()
  disposers.push(notification.installNotificationAudioPrimer(), tts.installTTSAudioPrimer())
  document.dispatchEvent(new dom.window.Event('pointerdown'))
  document.dispatchEvent(new dom.window.Event('touchstart'))
  document.dispatchEvent(new dom.window.Event('keydown'))
  expect(await notification.unlockNotificationAudio()).toBe(true)
  tts.unlockTTSAudio()
  expect(audioElements).toHaveLength(0)
  expect(contexts).toHaveLength(0)
})

test('primers installed before mobile identification do not play silence once the wrapper is identified', async () => {
  const { notification, tts } = await modules()
  disposers.push(notification.installNotificationAudioPrimer(), tts.installTTSAudioPrimer())
  nativeHost('ios-init')
  document.dispatchEvent(new dom.window.Event('touchstart'))
  await Bun.sleep(0)
  expect(audioElements).toHaveLength(0)
  expect(contexts).toHaveLength(0)
})

test.each(['macos', 'windows', 'linux'])('%s plays requested notification sounds without a preceding unlock', async platform => {
  nativeHost(platform)
  const { notification } = await modules()
  notification.playNotificationPing()
  notification.playNotificationPing(123)
  expect(audioElements).toHaveLength(1)
  expect(audioElements[0]!.played).toEqual(['/message-received.mp3', '/api/v1/notification-sounds/completion?v=123'])
  expect(contexts).toHaveLength(0)
})

test.each(['android', 'ios', 'android-init', 'ios-init'])('%s plays default and custom pings without media elements or a preceding gesture', async platform => {
  nativeHost(platform)
  const { notification } = await modules()
  await notification.playNotificationSound()
  await notification.playNotificationSound(123)
  expect(audioElements).toHaveLength(0)
  expect(soundRequests.map(request => request.src)).toEqual(['/message-received.mp3', '/api/v1/notification-sounds/completion?v=123'])
  expect(soundRequests.every(request => request.options?.credentials === 'include')).toBe(true)
  expect(contexts).toHaveLength(2)
  for (const context of contexts) {
    expect(context.silentBuffers).toBe(0)
    expect(context.starts).toBe(1)
    expect(context.resumes).toBe(1)
    expect(context.gains[0]!.gain.value).toBe(0.5)
  }
  expect(contexts[0]!.closes).toBe(1)
  expect(contexts[0]!.sources[0]!.stopped).toBe(true)
  contexts[1]!.sources[0]!.onended!()
  expect(contexts[1]!.closes).toBe(1)
  expect(contexts[1]!.sources[0]!.disconnected).toBe(true)
})

test.each(['decode', 'resume', 'start'])('mobile %s failures release audio output and can be retried', async failure => {
  nativeHost('ios')
  Object.assign(window, { AudioContext: class extends FakeContext {
    constructor() {
      super()
      this.failDecode = failure === 'decode'
      this.failResume = failure === 'resume'
      this.failStart = failure === 'start'
    }
  } })
  const { notification } = await modules()
  await expect(notification.playNotificationSound()).rejects.toThrow(`${failure} failed`)
  expect(contexts[0]!.closes).toBe(1)
  Object.assign(window, { AudioContext: FakeContext })
  await notification.playNotificationSound()
  expect(contexts[1]!.starts).toBe(1)
  expect(audioElements).toHaveLength(0)
})

test('mobile notification fetch failures stay quiet and previews expose the error', async () => {
  nativeHost('android')
  globalThis.fetch = mock(async () => new Response(null, { status: 404 })) as unknown as typeof fetch
  const { notification } = await modules()
  notification.playNotificationPing()
  await Bun.sleep(0)
  await expect(notification.playNotificationSound(123)).rejects.toThrow('404')
  expect(contexts).toHaveLength(0)
  expect(audioElements).toHaveLength(0)
})

test('a slow earlier mobile ping cannot play over a newer ping', async () => {
  nativeHost('android')
  let resolveEarlier!: (value: Response) => void
  const delayed = new Promise<Response>(resolve => { resolveEarlier = resolve })
  globalThis.fetch = mock((src) => String(src).includes('?v=')
    ? Promise.resolve(new Response(new Uint8Array([1])))
    : delayed) as unknown as typeof fetch
  const { notification } = await modules()
  const earlier = notification.playNotificationSound()
  await notification.playNotificationSound(123)
  resolveEarlier(new Response(new Uint8Array([2])))
  await earlier
  expect(contexts).toHaveLength(1)
  expect(contexts[0]!.starts).toBe(1)
  expect(contexts[0]!.closes).toBe(0)
})

test('mobile Web Audio supports the Safari prefix and never falls back to media playback', async () => {
  nativeHost('ios')
  Object.assign(window, { AudioContext: undefined, webkitAudioContext: FakeContext })
  const { notification } = await modules()
  await notification.playNotificationSound()
  expect(contexts[0]!.starts).toBe(1)
  Object.assign(window, { webkitAudioContext: undefined })
  await expect(notification.playNotificationSound()).rejects.toThrow('not supported')
  expect(contexts[0]!.closes).toBe(1)
  expect(audioElements).toHaveLength(0)
})

test('mobile pings finish without closing or changing active TTS audio', async () => {
  nativeHost('ios')
  const { notification, tts } = await modules()
  tts.speak(new ArrayBuffer(4), 'message')
  await Bun.sleep(0)
  await notification.playNotificationSound()
  contexts[1]!.sources[0]!.onended!()
  expect(contexts[1]!.closes).toBe(1)
  expect(contexts[0]!.state).toBe('running')
  expect(contexts[0]!.gains[0]!.gain.value).toBe(0.8)
  expect(tts.getActiveMessageId()).toBe('message')
})

test.each(platforms)('%s lazily starts real TTS and resumes after interruption without a dummy buffer', async platform => {
  nativeHost(platform)
  const { tts } = await modules()
  tts.speak(new ArrayBuffer(4), 'message')
  await Bun.sleep(0)
  expect(contexts).toHaveLength(1)
  expect(contexts[0]!.silentBuffers).toBe(0)
  expect(contexts[0]!.starts).toBe(1)
  expect(contexts[0]!.resumes).toBe(1)
  expect(tts.getActiveMessageId()).toBe('message')
  contexts[0]!.state = 'interrupted'
  tts.speak(new ArrayBuffer(4), 'message')
  await Bun.sleep(0)
  expect(contexts[0]!.starts).toBe(2)
  expect(contexts[0]!.resumes).toBe(2)
  expect(contexts[0]!.silentBuffers).toBe(0)
})

test('browser sessions retain gesture-based primers and only play notifications after unlocking', async () => {
  const { notification, tts } = await modules()
  notification.playNotificationPing()
  expect(audioElements).toHaveLength(0)
  disposers.push(notification.installNotificationAudioPrimer(), tts.installTTSAudioPrimer())
  expect(contexts).toHaveLength(0)
  document.dispatchEvent(new dom.window.Event('pointerdown'))
  await Bun.sleep(0)
  expect(audioElements[0]!.played).toEqual(['/silence.mp3'])
  expect(contexts[0]!.silentBuffers).toBe(1)
  expect(contexts[0]!.starts).toBe(1)
  notification.playNotificationPing()
  document.dispatchEvent(new dom.window.Event('keydown'))
  expect(audioElements[0]!.played).toEqual(['/silence.mp3', '/message-received.mp3'])
  expect(contexts[0]!.silentBuffers).toBe(1)
})
