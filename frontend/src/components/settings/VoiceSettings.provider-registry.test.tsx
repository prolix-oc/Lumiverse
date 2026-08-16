import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { JSDOM } from 'jsdom'
import {
  applyVoiceProviderRegistryEvent,
  listVoiceProviders,
  resetVoiceProviderProjection,
} from '@/api/voice'
import { FRONTEND_PROVIDER_SCOPE, type ProviderRegistryChangedPayload } from '@/ws/provider-registry-projection'

const voiceSettings = {
  sttProvider: 'webspeech' as const,
  sttLanguage: 'en-US',
  sttContinuous: false,
  sttInterimResults: true,
  sttAutoSubmitOnSilence: false,
  sttShowMicButton: true,
  sttConnectionId: null,
  ttsEnabled: true,
  ttsConnectionId: null,
  ttsAutoPlay: false,
  ttsSpeed: 1.0,
  ttsVolume: 0.8,
  speechDetectionRules: {
    asterisked: 'skip' as const,
    quoted: 'speech' as const,
    undecorated: 'narration' as const,
  },
  narrationVoice: null,
}

const storeState = {
  voiceSettings,
  setVoiceSettings: (patch: Record<string, unknown>) => {
    Object.assign(voiceSettings, patch)
  },
  sttProfiles: [],
  setSttProviders: () => undefined,
  ttsProfiles: [],
  setTtsProviders: () => undefined,
  addToast: () => undefined,
  openDrawer: () => undefined,
}

const useStore = Object.assign(
  (selector: (value: typeof storeState) => unknown) => selector(storeState),
  { getState: () => storeState },
)

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test/' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  Event: dom.window.Event,
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

mock.module('@/store', () => ({ useStore }))
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}))
mock.module('@/api/stt-connections', () => ({
  sttConnectionsApi: { providers: async () => ({ providers: [] }) },
}))
mock.module('@/api/tts-connections', () => ({
  ttsConnectionsApi: { providers: async () => ({ providers: [] }) },
}))
mock.module('@/components/shared/Toggle', () => ({
  Toggle: { Checkbox: () => createElement('div') },
}))
mock.module('@/components/shared/ConnectionSelect', () => ({
  default: () => createElement('div'),
}))
mock.module('@/components/shared/VoicePicker', () => ({
  default: () => createElement('div'),
}))
mock.module('@/lib/ttsAudio', () => ({
  speak: () => undefined,
  speakSegments: () => undefined,
  stop: () => undefined,
  setTTSVolume: () => undefined,
  setTTSSpeed: () => undefined,
  isSpeaking: () => false,
}))
mock.module('@/lib/qwenTts', () => ({
  formatTtsConnectionVoiceLabel: () => '',
}))
mock.module('@/lib/ttsSynthesis', () => ({
  synthesizeTtsSegments: async () => [],
}))
mock.module('@/lib/sttEngine', () => ({
  isWebSpeechAvailable: () => true,
}))
mock.module('lucide-react', () => ({
  Volume2: () => createElement('span'),
  Mic: () => createElement('span'),
  Play: () => createElement('span'),
  ExternalLink: () => createElement('span'),
}))
mock.module('./VoiceSettings.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))
mock.module('clsx', () => ({ default: (...args: unknown[]) => args.filter(Boolean).join(' ') }))

const { default: VoiceSettings } = await import('./VoiceSettings')

function event(
  partial: Partial<ProviderRegistryChangedPayload> & Pick<ProviderRegistryChangedPayload, 'action'>,
): ProviderRegistryChangedPayload {
  return {
    userId: 'local',
    scope: FRONTEND_PROVIDER_SCOPE,
    generation: 1,
    revision: 1,
    payload: { id: 'prov-1', kind: 'tts' },
    ...partial,
  }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('VoiceSettings provider registry', () => {
  let root: Root | null = null
  let host: HTMLDivElement | null = null

  afterEach(() => {
    act(() => { root?.unmount() })
    host?.remove()
    root = null
    host = null
    resetVoiceProviderProjection()
  })

  function mount() {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root!.render(createElement(VoiceSettings))
    })
  }

  test('emits scoped provider_changed add remove and change after registry commit', async () => {
    mount()
    act(() => {
      applyVoiceProviderRegistryEvent(event({
        action: 'add',
        payload: { id: 'ext-tts', kind: 'tts', name: 'Ext TTS' },
      }))
    })
    await flush()
    expect(host?.querySelector('[data-registry-provider="ext-tts"]')).not.toBeNull()

    act(() => {
      applyVoiceProviderRegistryEvent(event({
        action: 'change',
        revision: 2,
        payload: { id: 'ext-tts', kind: 'tts', name: 'Renamed TTS' },
      }))
    })
    await flush()
    expect(host?.querySelector('[data-registry-provider="ext-tts"]')?.textContent).toContain('Renamed TTS')

    act(() => {
      applyVoiceProviderRegistryEvent(event({
        action: 'remove',
        revision: 3,
        payload: { id: 'ext-tts', kind: 'tts' },
      }))
    })
    await flush()
    expect(host?.querySelector('[data-registry-provider="ext-tts"]')).toBeNull()
  })

  test('removes embedding TTS STT and sidecar options after unload without page reload', async () => {
    mount()
    act(() => {
      applyVoiceProviderRegistryEvent(event({
        action: 'add',
        payload: { id: 'live-tts', kind: 'tts' },
      }))
      applyVoiceProviderRegistryEvent(event({
        action: 'add',
        revision: 2,
        payload: { id: 'live-stt', kind: 'stt' },
      }))
    })
    await flush()
    expect(host?.querySelector('[data-registry-provider="live-tts"]')).not.toBeNull()
    expect(host?.querySelector('[data-registry-provider="live-stt"]')).not.toBeNull()

    act(() => {
      applyVoiceProviderRegistryEvent(event({
        action: 'remove',
        revision: 3,
        payload: { id: 'live-tts' },
      }))
      applyVoiceProviderRegistryEvent(event({
        action: 'remove',
        revision: 4,
        payload: { id: 'live-stt' },
      }))
    })
    await flush()
    expect(host?.querySelector('[data-registry-provider="live-tts"]')).toBeNull()
    expect(host?.querySelector('[data-registry-provider="live-stt"]')).toBeNull()
    expect(listVoiceProviders().tts.some((row) => row.id === 'live-tts')).toBe(false)
    expect(listVoiceProviders().stt.some((row) => row.id === 'live-stt')).toBe(false)
  })

  test('renders unavailable and timeout fallback', async () => {
    mount()
    act(() => {
      applyVoiceProviderRegistryEvent(event({
        action: 'add',
        payload: { id: 'down-tts', kind: 'tts', status: 'unavailable' },
      }))
      applyVoiceProviderRegistryEvent(event({
        action: 'add',
        revision: 2,
        payload: { id: 'slow-stt', kind: 'stt', availability: 'timeout' },
      }))
    })
    await flush()
    expect(host?.querySelector('[data-registry-provider="down-tts"] [data-provider-fallback="unavailable"]')).not.toBeNull()
    expect(host?.querySelector('[data-registry-provider="slow-stt"] [data-provider-fallback="timeout"]')).not.toBeNull()
  })

  test('denied registration is not visible to consumers', async () => {
    mount()
    act(() => {
      applyVoiceProviderRegistryEvent(event({
        action: 'add',
        payload: { id: 'denied-tts', kind: 'tts', denied: true },
      }))
      applyVoiceProviderRegistryEvent(event({
        action: 'add',
        revision: 2,
        userId: 'intruder',
        payload: { id: 'foreign-stt', kind: 'stt' },
      }))
    })
    await flush()
    expect(host?.querySelector('[data-registry-provider="denied-tts"]')).toBeNull()
    expect(host?.querySelector('[data-registry-provider="foreign-stt"]')).toBeNull()
  })

  test('provider failure is isolated', async () => {
    mount()
    const poison = { id: 'broken-tts', kind: 'tts' } as Record<string, unknown>
    Object.defineProperty(poison, 'name', {
      enumerable: true,
      get() { throw new Error('tts boom') },
    })
    act(() => {
      applyVoiceProviderRegistryEvent(event({
        action: 'add',
        payload: { id: 'good-tts', kind: 'tts', name: 'Good TTS' },
      }))
      applyVoiceProviderRegistryEvent(event({
        action: 'add',
        revision: 2,
        payload: poison,
      }))
    })
    await flush()
    expect(host?.querySelector('[data-registry-provider="good-tts"]')).not.toBeNull()
    expect(host?.querySelector('[data-registry-provider="broken-tts"]')).toBeNull()
  })
})
