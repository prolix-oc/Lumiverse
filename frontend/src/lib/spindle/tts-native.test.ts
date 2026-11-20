import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { create } from 'zustand'
import { JSDOM } from 'jsdom'
import type { AppStore, VoiceSettings } from '@/types/store'
import type { Message, TtsConnectionProfile } from '@/types/api'

const useStore = create<AppStore>(() => ({} as AppStore))
mock.module('@/store', () => ({ useStore }))
mock.module('@/api/client', () => ({ BASE_URL: '/api/v1', upload: async () => undefined }))
const { createNativeTTSAPI } = await import('./tts-native')
const audio = await import('../ttsAudio')

class FakeContext {
  state = 'running'
  sampleRate = 48000
  currentTime = 0
  destination = {}
  createGain() { return { gain: { value: 1 }, connect() {} } }
  createBuffer() { return { duration: 0.01 } }
  createBufferSource() {
    return { buffer: null, playbackRate: { value: 1 }, onended: null as (() => void) | null, connect() {},
      start() { setTimeout(() => this.onended?.(), 0) }, stop() {} }
  }
  decodeAudioData() { return Promise.resolve({ duration: 0.01 }) }
}
class FakeAudio extends EventTarget {
  paused = false
  ended = false
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
}
const originalFetch = globalThis.fetch
const previous = Object.fromEntries(['window', 'document', 'AudioContext'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
let dom: JSDOM
let bridge: ReturnType<typeof createNativeTTSAPI>
let untrack: (() => void) | undefined
let mediaGranted: boolean
const profile: TtsConnectionProfile = {
  id: 'tts', name: 'Voice', provider: 'openai_tts', voice: 'alloy', model: 'tts-1', api_url: '',
  is_default: true, has_api_key: true, default_parameters: {}, metadata: {}, created_at: 1, updated_at: 1,
}
const message = { id: 'message', chat_id: 'chat', name: 'Alice', is_user: false, swipe_id: 0,
  content: '"One." Narration. "Two." More narration. "Three."', extra: {} } as Message
beforeEach(() => {
  dom = new JSDOM('', { url: 'https://lumiverse.example/' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, AudioContext: FakeContext })
  document.documentElement.dataset.tauriDesktop = ''
  useStore.setState({
    voiceSettings: { ttsEnabled: true, ttsConnectionId: 'tts', ttsSpeed: 1, ttsVolume: 0.8,
      speechDetectionRules: { asterisked: 'thought', quoted: 'speech', undecorated: 'narration' },
      narrationVoice: { connectionId: 'tts', voice: 'nova' } } as VoiceSettings,
    ttsProfiles: [{ ...profile }], characters: [], isGroupChat: false, activeCharacterId: null,
    activeChatId: 'chat', activeChatMetadata: {}, messages: [{ ...message }], updateMessage() {},
  })
  mediaGranted = true
  bridge = createNativeTTSAPI({ assertActive() {}, requirePermission(permission) {
    if (!mediaGranted) throw new Error(`PERMISSION_DENIED:${permission}`)
  }, onTeardown: () => () => {} })
})
afterEach(async () => {
  bridge.dispose()
  audio.stopAllTTSPlayback()
  untrack?.()
  untrack = undefined
  await Bun.sleep(0)
  globalThis.fetch = originalFetch
  dom.window.close()
  for (const [key, descriptor] of Object.entries(previous)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

test.each(['text', 'message', 'saved'] as const)('%s speak preempts a playing saved-message element', async (kind) => {
  const el = new FakeAudio()
  untrack = audio.trackTTSAudioElement(el as unknown as HTMLMediaElement)
  el.dispatchEvent(new Event('play'))
  if (kind === 'saved') useStore.setState({ messages: [{ ...message, extra: { attachments: [{ type: 'audio', image_id: 'saved', swipe_id: 0, mime_type: 'audio/mpeg', original_filename: 'speech.mp3' }] } }] })
  globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch
  const spoken = bridge.api.speak(kind === 'text' ? { text: 'Hello' } : { messageId: 'message' })
  expect(el.paused).toBe(true)
  bridge.api.stop()
  await spoken
})

test.each(['text', 'message', 'saved'] as const)('extension %s speech works with chat TTS disabled without changing chat settings', async (kind) => {
  useStore.setState({ voiceSettings: { ...useStore.getState().voiceSettings, ttsEnabled: false } })
  if (kind === 'saved') useStore.setState({ messages: [{ ...message, extra: { attachments: [{ type: 'audio', image_id: 'saved', swipe_id: 0,
    mime_type: 'audio/mpeg', original_filename: 'speech.mp3' }] } }] })
  const paths: string[] = []
  globalThis.fetch = (async (url: string) => {
    paths.push(url)
    return url.endsWith('/save-message-audio') ? Response.json({ message }) : new Response(new Uint8Array([1, 2, 3]))
  }) as typeof fetch
  if (kind === 'text') await bridge.api.speak({ text: 'A brief companion reply.' }, { connectionId: 'tts' })
  else await bridge.api.speak({ messageId: message.id })
  expect(paths.length).toBeGreaterThan(0)
  expect(bridge.api.isSpeaking()).toBe(false)
  expect(useStore.getState().voiceSettings.ttsEnabled).toBe(false)
})

test('chat reading remains disabled and Media authorization still gates extension speech', async () => {
  useStore.setState({ voiceSettings: { ...useStore.getState().voiceSettings, ttsEnabled: false } })
  let requests = 0
  globalThis.fetch = (async () => { requests++; return new Response(new Uint8Array([1, 2, 3])) }) as unknown as typeof fetch
  const { startMessageTtsPlaybackSession, synthesizeSaveAndAutoPlay } = await import('../ttsMessagePlayback')
  const input = { messageId: message.id, messageName: message.name, messageContent: message.content, messageIsUser: message.is_user }
  expect(startMessageTtsPlaybackSession(input)).toBeNull()
  expect(await synthesizeSaveAndAutoPlay(input)).toBe(false)
  mediaGranted = false
  await expect(bridge.api.speak({ text: 'Not authorized' }, { connectionId: 'tts' })).rejects.toThrow('PERMISSION_DENIED:media')
  await expect(bridge.api.speak({ messageId: message.id })).rejects.toThrow('PERMISSION_DENIED:media')
  expect(requests).toBe(0)
  expect(bridge.api.isSpeaking()).toBe(false)
})

test.each([false, true])('message speak reports provider failures (streaming: %s)', async (streaming) => {
  useStore.setState({ ttsProfiles: [{ ...profile, default_parameters: { use_streaming_endpoint: streaming } }] })
  globalThis.fetch = (async () => new Response('Provider unavailable', { status: 500 })) as unknown as typeof fetch
  await expect(bridge.api.speak({ messageId: 'message' })).rejects.toThrow('Provider unavailable')
  expect(bridge.api.isSpeaking()).toBe(false)
})

test.each([false, true])('stopping message speech aborts requests and prevents queued synthesis and persistence (streaming: %s)', async (streaming) => {
  useStore.setState({ ttsProfiles: [{ ...profile, default_parameters: { use_streaming_endpoint: streaming } }] })
  const signals: AbortSignal[] = []
  const paths: string[] = []
  globalThis.fetch = ((url: string, init: RequestInit) => {
    paths.push(url)
    signals.push(init.signal!)
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
  }) as typeof fetch
  const spoken = bridge.api.speak({ messageId: 'message' })
  expect(paths).toHaveLength(streaming ? 1 : 3)
  bridge.api.stop()
  await spoken
  await Bun.sleep(0)
  expect(signals.every(signal => signal?.aborted)).toBe(true)
  expect(paths).toHaveLength(streaming ? 1 : 3)
  expect(paths.some(path => path.endsWith('/save-message-audio'))).toBe(false)
})

test('stop cancels chat auto-play while it is still synthesizing', async () => {
  const { synthesizeSaveAndAutoPlay } = await import('../ttsMessagePlayback')
  const signals: AbortSignal[] = []
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    signals.push(init.signal!)
    return new Promise<Response>((resolve, reject) => {
      // The deadline lets the original implementation finish instead of hanging the test.
      const timeout = setTimeout(() => resolve(new Response(new Uint8Array([1, 2, 3]))), 50)
      init.signal?.addEventListener('abort', () => { clearTimeout(timeout); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
    })
  }) as typeof fetch
  const pending = synthesizeSaveAndAutoPlay({ messageId: message.id, messageName: message.name,
    messageContent: message.content, messageIsUser: message.is_user })
  bridge.api.stop()
  expect(await pending).toBe(false)
  expect(signals).toHaveLength(3)
  expect(signals.every(signal => signal?.aborted)).toBe(true)
})

test('saved audio load failures reject speak without a synthesis request', async () => {
  useStore.setState({ messages: [{ ...message, extra: { attachments: [{ type: 'audio', image_id: 'saved', swipe_id: 0,
    mime_type: 'audio/mpeg', original_filename: 'speech.mp3' }] } }] })
  const paths: string[] = []
  globalThis.fetch = (async (url: string) => { paths.push(url); return new Response('', { status: 404 }) }) as typeof fetch
  await expect(bridge.api.speak({ messageId: message.id })).rejects.toThrow('TTS_AUDIO_LOAD_FAILED: 404')
  expect(paths).toEqual(['/api/v1/audio/saved'])
})

test('native validation leaves current playback intact', async () => {
  const el = new FakeAudio()
  untrack = audio.trackTTSAudioElement(el as unknown as HTMLMediaElement)
  useStore.setState({ voiceSettings: { ...useStore.getState().voiceSettings, ttsEnabled: false } })
  await expect(bridge.api.speak({ messageId: 'missing' })).rejects.toThrow('TTS_MESSAGE_NOT_FOUND')
  await expect(bridge.api.speak({ text: 'Hello' }, { connectionId: 'missing' })).rejects.toThrow('TTS_CONNECTION_NOT_FOUND')
  expect(el.paused).toBe(false)
})
