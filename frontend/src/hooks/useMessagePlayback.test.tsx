import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { create } from 'zustand'
import { JSDOM } from 'jsdom'
import type { AppStore, VoiceSettings } from '@/types/store'
import type { Message, TtsConnectionProfile } from '@/types/api'
import type { UseMessagePlaybackResult } from './useMessagePlayback'

const defaultProfile: TtsConnectionProfile = {
  id: 'default', name: 'Default voice', provider: 'openai_tts', voice: 'alloy',
  model: 'tts-1', api_url: '', is_default: true, has_api_key: true,
  default_parameters: {}, metadata: {}, created_at: 1, updated_at: 1,
}
const settings: VoiceSettings = {
  sttProvider: 'webspeech', sttLanguage: 'en-US', sttContinuous: false,
  sttInterimResults: true, sttAutoSubmitOnSilence: false, sttShowMicButton: true,
  sttConnectionId: null, ttsEnabled: true, ttsConnectionId: null,
  ttsAutoPlay: true, ttsSpeed: 1, ttsVolume: 1,
  speechDetectionRules: { asterisked: 'thought', quoted: 'speech', undecorated: 'narration' },
  narrationVoice: null,
}
const content = 'Alice smiled. "Hello there." *I hope they reply.*'
const message = { id: 'message', chat_id: 'chat', content, name: 'Alice', is_user: false, swipe_id: 0, extra: {} } as Message
const useStore = create<AppStore>(() => ({} as AppStore))
mock.module('@/store', () => ({ useStore }))
mock.module('@/api/chats', () => ({ messagesApi: {} }))
mock.module('@/api/client', () => ({ BASE_URL: '/api/v1', upload: async () => undefined }))

let activeMessageId: string | null = null
mock.module('@/lib/ttsAudio', () => ({
  getActiveMessageId: () => activeMessageId,
  subscribeActiveMessage: () => () => {},
  stop: () => { activeMessageId = null },
  speak: () => {},
  speakSegments: (_segments: unknown, id: string) => { activeMessageId = id },
  setTTSVolume: () => {}, setTTSSpeed: () => {}, unlockTTSAudio: () => {},
}))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
})
const { useMessagePlayback } = await import('./useMessagePlayback')
const { synthesizeSaveAndAutoPlay, planMessagePlayback } = await import('@/lib/ttsMessagePlayback')
const originalFetch = globalThis.fetch
let requests: Array<{ path: string; body: any }> = []
let root: Root | null = null
let host: HTMLDivElement | null = null
let playback: UseMessagePlaybackResult

function Probe() {
  const controller = useMessagePlayback(message.id, content, message.name, false)
  useEffect(() => { playback = controller }, [controller])
  return <button disabled={!controller.canPlay} onClick={controller.toggle}>Read message</button>
}

function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<Probe />))
  return host.querySelector('button')!
}

async function clickAndFlush(button: HTMLButtonElement) {
  await act(async () => {
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  activeMessageId = null
  requests = []
  useStore.setState({
    voiceSettings: { ...settings }, ttsProfiles: [{ ...defaultProfile }],
    characters: [{ id: 'alice', name: 'Alice', extensions: {} }] as AppStore['characters'],
    isGroupChat: false, groupCharacterIds: [], activeCharacterId: 'alice',
    activeChatMetadata: {}, activeChatId: 'chat', messages: [{ ...message }],
    updateMessage: (id, patch) => useStore.setState((state) => ({
      messages: state.messages.map((candidate) => candidate.id === id ? { ...candidate, ...patch } : candidate),
    })),
  })
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ path: url, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    if (url.endsWith('/save-message-audio')) {
      return Response.json({ message: { ...message, extra: { attachments: [{ type: 'audio', image_id: 'audio', swipe_id: 0 }] } } })
    }
    if (url.endsWith('/stream')) {
      return new Response('event: audio\ndata: {"kind":"bytes","mimeType":"audio/wav","base64":"AQID"}\n\nevent: done\ndata: {}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } })
  }) as typeof fetch
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  globalThis.fetch = originalFetch
})

describe('message TTS button with default connection', () => {
  test('click sends all narration, dialogue, and thoughts without chat voice settings', async () => {
    const button = mount()
    expect(button.disabled).toBe(false)
    await clickAndFlush(button)
    expect(requests[0]).toEqual({
      path: '/api/v1/tts/synthesize',
      body: { connectionId: 'default', text: 'Alice smiled. Hello there. I hope they reply.', parameters: { speed: 1 } },
    })
    expect(requests).toHaveLength(2)
    expect(requests[1].path).toBe('/api/v1/tts/save-message-audio')
    // Omitting the voice lets the backend inherit the profile's saved alloy voice.
    expect(requests[0].body.voice).toBeUndefined()
  })

  test('the default profile also determines the streaming transport', async () => {
    useStore.setState({ ttsProfiles: [{ ...defaultProfile, provider: 'google_tts', voice: 'Kore' }] })
    await clickAndFlush(mount())
    expect(requests[0].path).toBe('/api/v1/tts/synthesize/stream')
    expect(requests[0].body.connectionId).toBe('default')
    expect(requests[1].path).toBe('/api/v1/tts/save-message-audio')
  })

  test.each([
    { provider: 'google_tts', model: 'gemini-3.8-flash-tts' },
    { provider: 'google_vertex_tts', model: 'gemini-3.1-flash-tts-preview' },
    { provider: 'openrouter_tts', model: 'google/gemini-3.8-flash-tts' },
  ])('$provider sends future cues and trailing dialogue in the character voice', ({ provider, model }) => {
    useStore.setState({
      ttsProfiles: [{ ...defaultProfile, provider, model, voice: 'Kore' }],
      activeChatMetadata: { voiceOverrides: {
        characters: { alice: { connectionId: 'default', voice: 'Kore' } },
        narrator: { connectionId: 'narrator', voice: 'Puck' },
      } },
    })
    const plan = planMessagePlayback({
      messageName: 'Alice', messageIsUser: false,
      messageContent: '<div><font color="red"><span>"First sentence." "Like a delivery guy. <brand new cue> Still talking."</span></font></div>',
    })
    expect(plan).toEqual([{
      text: 'First sentence. Like a delivery guy. <brand new cue> Still talking.',
      voice: { connectionId: 'default', voice: 'Kore', parameters: undefined },
    }])
  })

  test('plain TTS strips cues while keeping the rest of the message', () => {
    expect(planMessagePlayback({
      messageName: 'Alice', messageIsUser: false,
      messageContent: '"Before <giggle> after the cue."',
    })).toEqual([{ text: 'Before after the cue.', voice: { connectionId: 'default', voice: '' } }])
  })

  test('preserves cues only for Gemini when speech and narration use different providers', () => {
    useStore.setState({
      ttsProfiles: [
        { ...defaultProfile, provider: 'google_tts', model: 'gemini-3.8-flash-tts', voice: 'Kore' },
        { ...defaultProfile, id: 'narrator', is_default: false },
      ],
      activeChatMetadata: { voiceOverrides: {
        characters: { alice: { connectionId: 'default', voice: 'Kore' } },
        narrator: { connectionId: 'narrator', voice: 'alloy' },
      } },
    })
    expect(planMessagePlayback({
      messageName: 'Alice', messageIsUser: false,
      messageContent: 'Narration <new cue> continues. "Dialogue <giggle> continues."',
    })).toEqual([
      { text: 'Narration continues.', voice: { connectionId: 'narrator', voice: 'alloy', parameters: undefined } },
      { text: 'Dialogue <giggle> continues.', voice: { connectionId: 'default', voice: 'Kore', parameters: undefined } },
    ])
  })

  test('a narrator override does not require a speech override', async () => {
    useStore.setState({ activeChatMetadata: { voiceOverrides: { narrator: { connectionId: 'narrator', voice: 'Kore' } } } })
    await clickAndFlush(mount())
    expect(requests.slice(0, 2).map((request) => request.body)).toEqual([
      { connectionId: 'narrator', voice: 'Kore', text: 'Alice smiled.', parameters: { speed: 1 } },
      { connectionId: 'default', text: 'Hello there. I hope they reply.', parameters: { speed: 1 } },
    ])
  })

  test('character overrides allow playback even when there is no global connection', async () => {
    useStore.setState({
      ttsProfiles: [],
      activeChatMetadata: { voiceOverrides: { characters: { alice: { connectionId: 'character', voice: 'Puck' } } } },
    })
    const button = mount()
    expect(button.disabled).toBe(false)
    await clickAndFlush(button)
    expect(requests[0].body.connectionId).toBe('character')
    expect(requests[0].body.voice).toBe('Puck')
  })

  test('regeneration uses the default connection without chat voice settings', async () => {
    useStore.setState({ messages: [{ ...message, extra: { attachments: [{
      type: 'audio', image_id: 'old', swipe_id: 0, mime_type: 'audio/mpeg', original_filename: 'old.mp3',
    }] } }] })
    await clickAndFlush(mount())
    expect(playback.regenModalOpen).toBe(true)
    expect(requests).toHaveLength(0)
    await act(async () => {
      playback.confirmRegen()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(requests[0].body.connectionId).toBe('default')
    expect(requests[1].path).toBe('/api/v1/tts/save-message-audio')
  })

  test('auto-play uses the same fallback as the message button', async () => {
    expect(await synthesizeSaveAndAutoPlay({ messageId: message.id, messageName: message.name, messageContent: content, messageIsUser: false })).toBe(true)
    expect(requests[0].body.connectionId).toBe('default')
    expect(requests[0].body.text).toBe('Alice smiled. Hello there. I hope they reply.')
  })

  test('without a voice, no requests are sent and the button is unavailable', async () => {
    useStore.setState({ ttsProfiles: [] })
    expect(mount().disabled).toBe(true)
    expect(planMessagePlayback({ messageName: message.name, messageContent: content, messageIsUser: false })).toEqual([])
    expect(requests).toHaveLength(0)
  })

  test('disabling TTS still disables the button', () => {
    useStore.setState({ voiceSettings: { ...settings, ttsEnabled: false } })
    expect(mount().disabled).toBe(true)
  })
})
