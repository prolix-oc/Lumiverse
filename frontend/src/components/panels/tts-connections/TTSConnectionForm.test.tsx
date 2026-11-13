import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type { CreateTtsConnectionInput, TtsConnectionProfile, TtsProviderInfo } from '@/types/api'
import { FishAudioTtsProvider } from '../../../../../src/tts/providers/fish-audio'

const modelComboboxProps: Array<Record<string, any>> = []
const voicePreviewInputs: Array<Record<string, any>> = []
const voicePreviewOptions: Array<{ signal?: AbortSignal } | undefined> = []
let libraryProps: Record<string, any> | undefined
mock.module('@/components/modals/VoiceLibraryModal', () => ({
  default: (props: Record<string, any>) => {
    libraryProps = props
    return <button onClick={() => { props.onSelect({ id: 'community-voice', name: 'Community narrator' }); props.onClose() }}>Choose library voice</button>
  },
}))
let previewVoicesImpl = async (_input: Record<string, any>) => ({ voices: [] })

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
})
dom.window.matchMedia = () => ({
  matches: false,
  media: '',
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}) as any

const t = (key: string, opts?: any) => opts?.file ? `${key}${opts.file}` : key
// Folder save/cancel behavior is exercised with real managers in the browser test.
mock.module('@/components/panels/connection-manager/ConnectionFolderField', () => ({
  default: () => null,
  useConnectionFolderDraft: () => ({ value: '', onChange: () => {} }),
}))
mock.module('@/hooks/useConnectionLibrary', () => ({ saveConnectionFolder: () => {} }))
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t }),
  Trans: ({ children }: { children?: unknown }) => children ?? null,
  I18nextProvider: ({ children }: { children?: unknown }) => children ?? null,
  initReactI18next: { type: '3rdParty', init() {} },
}))
mock.module('@/i18n', () => ({
  default: { t },
  changeLanguage: async () => {},
  changeUiLanguage: async () => {},
  ensureLanguageLoaded: async () => {},
  initI18n: async () => ({ t }),
  UI_LANGUAGE_STORAGE_KEY: 'lumiverse-ui-language',
  language: 'en',
}))
mock.module('../connection-manager/ModelCombobox', () => ({
  default: (props: Record<string, any>) => {
    modelComboboxProps.push(props)
    return null
  },
}))
mock.module('@/api/tts-connections', () => ({
  ttsConnectionsApi: {
    previewModels: async () => ({ models: [] }),
    previewVoices: async (input: Record<string, any>, options?: { signal?: AbortSignal }) => {
      voicePreviewInputs.push(input)
      voicePreviewOptions.push(options)
      return previewVoicesImpl(input)
    },
  },
}))

let Form: typeof import('./TTSConnectionForm').default
let createRoot: typeof CreateRoot
let root: Root | undefined
let container: HTMLDivElement
let saved: CreateTtsConnectionInput[]
const providers: TtsProviderInfo[] = [
  {
    id: 'openai_tts',
    name: 'OpenAI TTS',
    capabilities: { parameters: {}, apiKeyRequired: true, modelListStyle: 'static', voiceListStyle: 'static', defaultUrl: 'https://api.openai.com/v1', defaultFormat: 'mp3', supportsStreaming: true, supportedFormats: ['mp3'] },
  },
  {
    id: 'google_vertex_tts',
    name: 'Google Vertex TTS',
    capabilities: { parameters: {}, apiKeyRequired: true, modelListStyle: 'dynamic', voiceListStyle: 'static', defaultUrl: 'https://aiplatform.googleapis.com', defaultFormat: 'wav', supportsStreaming: false, supportedFormats: ['wav'] },
  },
  {
    id: 'openvox_tts',
    name: 'OpenVox TTS',
    capabilities: { parameters: {}, apiKeyRequired: false, modelListStyle: 'dynamic', voiceListStyle: 'dynamic', defaultUrl: 'http://127.0.0.1:8000/v1', defaultFormat: 'wav', supportsStreaming: false, supportedFormats: ['wav'] },
  },
]

beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  Form = (await import('./TTSConnectionForm')).default
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  container?.remove()
  modelComboboxProps.length = 0
  voicePreviewInputs.length = 0
  voicePreviewOptions.length = 0
  previewVoicesImpl = async () => ({ voices: [] })
})

async function render(element: React.ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(element)
  })
}

function ttsProfile(overrides: Partial<TtsConnectionProfile> = {}): TtsConnectionProfile {
  return {
    id: 'p1',
    name: 'Vertex Voice',
    provider: 'google_vertex_tts',
    api_url: '',
    model: 'gemini-3.1-flash-tts-preview',
    voice: 'Kore',
    is_default: false,
    has_api_key: true,
    default_parameters: {},
    metadata: { vertex_region: 'europe-west1', sa_file_name: 'test-key.json' },
    created_at: 100,
    updated_at: 100,
    ...overrides,
  }
}

test('exposes service account JSON file input and region for Google Vertex TTS', async () => {
  saved = []
  await render(
    <Form
      providers={providers}
      profile={ttsProfile()}
      onSave={(input) => saved.push(input)}
      onCancel={() => {}}
    />
  )

  // Service account JSON file upload button and hidden file input should exist
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
  expect(fileInput).toBeTruthy()
  expect(fileInput.getAttribute('accept')).toBe('.json,application/json')

  // Region dropdown should have europe-west1 selected
  const selects = Array.from(container.querySelectorAll('select')) as HTMLSelectElement[]
  const regionSelect = selects.find((s) => Array.from(s.options).some((o) => o.value === 'us-central1'))
  expect(regionSelect).toBeTruthy()
  expect(regionSelect?.value).toBe('europe-west1')

  // Normal API Key and API URL fields should be hidden for vertex
  const textInputs = Array.from(container.querySelectorAll('input[type="text"], input[type="password"]')) as HTMLInputElement[]
  const passwordInput = textInputs.find((i) => i.type === 'password')
  expect(passwordInput).toBeUndefined()

  // Save preserves vertex_region in metadata and leaves api_url undefined
  const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('save'))
  expect(saveBtn).toBeTruthy()
  act(() => {
    saveBtn?.click()
  })

  expect(saved.length).toBe(1)
  expect(saved[0].provider).toBe('google_vertex_tts')
  expect(saved[0].api_url).toBeUndefined()
  expect(saved[0].metadata?.vertex_region).toBe('europe-west1')
  expect(saved[0].metadata?.sa_file_name).toBe('test-key.json')
})

test('the ElevenLabs library uses draft credentials and saves its selected voice ID', async () => {
  saved = []
  const eleven = { ...providers[0], id: 'elevenlabs', name: 'ElevenLabs', capabilities: { ...providers[0].capabilities, voiceListStyle: 'dynamic' as const, supportsVoiceLibrary: true } }
  await render(<Form providers={[eleven]} profile={ttsProfile({ provider: 'elevenlabs', api_url: 'https://proxy.example', voice: '', metadata: {} })} onSave={(input) => saved.push(input)} onCancel={() => {}} />)
  const key = container.querySelector<HTMLInputElement>('input[type="password"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(key, 'draft-key')
    key.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  const open = [...container.querySelectorAll('button')].find((button) => button.textContent === 'shared:voicePicker.voiceLibrary')!
  await act(async () => { open.click(); await Bun.sleep(10) })
  expect(libraryProps?.connection).toMatchObject({ connection_id: 'p1', provider: 'elevenlabs', api_url: 'https://proxy.example', api_key: 'draft-key' })
  const choose = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Choose library voice')!
  await act(async () => choose.click())
  const save = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('save'))!
  await act(async () => save.click())
  expect(saved[0]?.voice).toBe('community-voice')
})

test('renders standard API key and API url inputs for other providers', async () => {
  saved = []
  await render(
    <Form
      providers={providers}
      profile={{
        id: 'o1',
        name: 'OpenAI Voice',
        provider: 'openai_tts',
        api_url: 'https://api.openai.com/v1',
        model: 'tts-1',
        voice: 'alloy',
        is_default: false,
        has_api_key: true,
        default_parameters: {},
        metadata: {},
        created_at: 100,
        updated_at: 100,
      }}
      onSave={(input) => saved.push(input)}
      onCancel={() => {}}
    />
  )

  // No file input should exist
  const fileInput = container.querySelector('input[type="file"]')
  expect(fileInput).toBeNull()

  // Password input should exist
  const passwordInput = container.querySelector('input[type="password"]')
  expect(passwordInput).toBeTruthy()
})

const fishProvider: TtsProviderInfo = {
  id: 'fish_audio', name: 'Fish Audio', capabilities: new FishAudioTtsProvider().capabilities,
}

async function renderFish(default_parameters: Record<string, any> = {}, model = 's2.1-pro') {
  saved = []
  await render(<Form providers={[fishProvider]} profile={ttsProfile({
    provider: 'fish_audio', model, name: 'Fish voice', metadata: {}, default_parameters,
  })} onSave={(input) => saved.push(input)} onCancel={() => {}} />)
}

function saveButton() {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'ttsConnectionForm.save')!
}

async function expandFish(group: string) {
  await act(async () => {
    Array.from(container.querySelectorAll('button')).find((button) => button.textContent === `ttsConnectionForm.fishGroups.${group}`)!.click()
  })
}

test('Fish settings preserve saved zero/false values and omit untouched defaults', async () => {
  await renderFish({ temperature: 0, top_p: 0, normalize_loudness: false, normalize: false })
  const loudness = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((field) => field.closest('label')?.textContent?.includes('Normalize loudness'))!
  expect(loudness.checked).toBe(false)
  await expandFish('generation')
  const normalize = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((field) => field.closest('label')?.textContent?.includes('Normalize numbers and text'))!
  expect(normalize.checked).toBe(false)
  await act(async () => saveButton().click())
  expect(saved[0].default_parameters).toEqual({ temperature: 0, top_p: 0, normalize_loudness: false, normalize: false })
})

test('Fish output controls switch bitrates and clear incompatible sample rates', async () => {
  await renderFish({ sample_rate: '44100', mp3_bitrate: '192' })
  await expandFish('audio')
  const format = container.querySelector<HTMLSelectElement>('select[aria-label="Output format"]')!
  expect(Array.from(format.options).find((option) => option.value === 'pcm')?.disabled).toBe(true)
  await act(async () => {
    format.value = 'opus'
    format.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  expect(container.querySelector('select[aria-label="MP3 bitrate"]')).toBeNull()
  expect(container.querySelector('select[aria-label="Opus bitrate"]')).toBeTruthy()
  const sampleRate = container.querySelector<HTMLSelectElement>('select[aria-label="Sample rate"]')!
  expect(Array.from(sampleRate.options).map((option) => option.value)).toEqual(['', '48000'])
  expect(sampleRate.value).toBe('')
  await act(async () => saveButton().click())
  expect(saved[0].default_parameters).toEqual({ format: 'opus', mp3_bitrate: '192' })
})

test('Fish model changes hide unsupported controls without losing saved settings', async () => {
  await renderFish({ normalize_loudness: false })
  const model = [...modelComboboxProps].reverse().find((props) => props.refreshKey?.endsWith(':models'))!
  await act(async () => model.onChange('drama-3-preview'))
  expect(container.querySelector('textarea[aria-label="Voice direction"]')).toBeTruthy()
  expect(container.textContent).not.toContain('Normalize loudness')
  await act(async () => model.onChange('s1'))
  expect(container.querySelector('textarea[aria-label="Voice direction"]')).toBeNull()
  await act(async () => saveButton().click())
  expect(saved[0].default_parameters?.normalize_loudness).toBe(false)
})

test('Fish settings save edited directions, toggles, and numeric inputs', async () => {
  await renderFish()
  const direction = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Voice direction"]')!
  const volume = container.querySelector<HTMLInputElement>('input[aria-label="Volume"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(direction, 'quiet and hesitant')
    direction.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(volume, '2.5')
    volume.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  const loudness = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((field) => field.closest('label')?.textContent?.includes('Normalize loudness'))!
  await act(async () => loudness.click())
  await act(async () => saveButton().click())
  expect(saved[0].default_parameters).toEqual({ voice_direction: 'quiet and hesitant', volume: 2.5, normalize_loudness: false })
})

test('Fish dictionary references require both fields and settings can reset', async () => {
  await renderFish({ pronunciation_dictionary_id: 'cast_names', temperature: 0.8, unrelated: true })
  expect(saveButton().disabled).toBe(true)
  await expandFish('pronunciation')
  expect(container.textContent).toContain('ttsConnectionForm.fishDictionaryIncomplete')
  const version = container.querySelector<HTMLInputElement>('input[aria-label="Dictionary version"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(version, 'published-2')
    version.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  expect(saveButton().disabled).toBe(false)
  await act(async () => {
    Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'ttsConnectionForm.fishReset')!.click()
  })
  await act(async () => saveButton().click())
  expect(saved[0].default_parameters).toEqual({ unrelated: true })
})

test.each(['google_tts', 'google_vertex_tts'])('shows gender and tone for %s voices and saves the API voice ID', async (providerId) => {
  saved = []
  const googleProvider: TtsProviderInfo = {
    ...providers[1],
    id: providerId,
    capabilities: {
      ...providers[1].capabilities,
      staticVoices: [
        { id: 'Kore', name: 'Kore', gender: 'feminine', description: 'Firm, assured delivery.', language: 'en-US' },
        { id: 'Algieba', name: 'Algieba', gender: 'masculine', description: 'Smooth, flowing delivery.', language: 'en-US' },
      ],
    },
  }
  await render(
    <Form
      providers={[googleProvider]}
      profile={ttsProfile({ provider: providerId })}
      onSave={(input) => saved.push(input)}
      onCancel={() => {}}
    />
  )

  const voiceCombobox = [...modelComboboxProps].reverse().find((props) => props.refreshKey?.endsWith(':voices'))
  expect(voiceCombobox?.models).toEqual(['Kore', 'Algieba'])
  expect(voiceCombobox?.modelLabels.Kore).toBe('Kore (Female) — Firm, assured delivery. · en-US')
  expect(voiceCombobox?.modelLabels.Algieba).toBe('Algieba (Male) — Smooth, flowing delivery. · en-US')

  await act(async () => voiceCombobox!.onChange('Algieba'))
  const saveBtn = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('save'))
  act(() => saveBtn!.click())
  expect(saved[0].voice).toBe('Algieba')
})

test.each([
  { provider: 'google_tts', model: 'gemini-3.8-flash-tts', style: 'soft, conversational' },
  { provider: 'google_tts', model: 'gemini-3.8-flash-tts', style: '' },
  { provider: 'google_vertex_tts', model: 'gemini-3.8-flash-lite-tts', style: 'soft, conversational' },
  { provider: 'google_vertex_tts', model: 'gemini-3.8-flash-lite-tts', style: '' },
  { provider: 'openrouter_tts', model: 'google/gemini-3.8-flash-tts', style: 'soft, conversational' },
  { provider: 'openrouter_tts', model: 'google/gemini-3.8-flash-tts', style: '' },
])('saves edited or explicitly blank Gemini speech style (%j)', async ({ provider, model, style }) => {
  saved = []
  const defaultStyle = 'casual, relaxed conversation'
  const styledProvider: TtsProviderInfo = {
    ...providers[1], id: provider,
    capabilities: { ...providers[1].capabilities, parameters: {
      speech_style: { type: 'string', default: defaultStyle, description: 'Delivery style' },
    } },
  }
  await render(<Form
    providers={[...providers.filter((candidate) => candidate.id !== provider), styledProvider]}
    profile={ttsProfile({ provider, model })}
    onSave={(input) => saved.push(input)}
    onCancel={() => {}}
  />)
  const field = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="ttsConnectionForm.geminiSpeechStyle"]')!
  expect(field).toBeTruthy()
  expect(field.value).toBe(defaultStyle)
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, style)
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  act(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('save'))!.click())
  expect(saved[0].default_parameters?.speech_style).toBe(style)
})

test('hides speech style for older Gemini models', async () => {
  await render(<Form providers={providers} profile={ttsProfile()} onSave={() => {}} onCancel={() => {}} />)
  expect(container.querySelector('textarea[aria-label="ttsConnectionForm.geminiSpeechStyle"]')).toBeNull()
})

test('allows disabling streaming for Google Vertex TTS', async () => {
  saved = []
  await render(
    <Form
      providers={providers}
      profile={ttsProfile()}
      onSave={(input) => saved.push(input)}
      onCancel={() => {}}
    />
  )

  const streamCheckbox = container.querySelector('input[type="checkbox"]:not([checked="false"])') as HTMLInputElement
  const checkboxes = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]
  // One is setDefault, one is streaming
  const streamingToggle = checkboxes.find((c) => c.closest('label')?.textContent?.includes('qwenUseStreaming') || c.parentElement?.textContent?.includes('qwenUseStreaming'))
  expect(streamingToggle).toBeTruthy()
  expect(streamingToggle?.checked).toBe(true)

  act(() => {
    streamingToggle?.click()
  })

  const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('save'))
  act(() => {
    saveBtn?.click()
  })

  expect(saved.length).toBe(1)
  expect(saved[0].default_parameters?.use_streaming_endpoint).toBe(false)
})

test('passes the selected OpenVox model when loading voices', async () => {
  await render(
    <Form
      providers={providers}
      profile={ttsProfile({
        id: 'openvox-1',
        name: 'Local OpenVox',
        provider: 'openvox_tts',
        api_url: 'http://127.0.0.1:8000/v1',
        model: 'kokoro',
        voice: '',
        has_api_key: false,
        metadata: {},
      })}
      onSave={() => {}}
      onCancel={() => {}}
    />
  )

  await act(async () => {
    await Promise.resolve()
  })

  expect(voicePreviewInputs.some((input) => (
    input.provider === 'openvox_tts' && input.model === 'kokoro'
  ))).toBe(true)

  const voiceCombobox = modelComboboxProps.find((props) => props.refreshKey?.endsWith(':kokoro:voices'))
  expect(voiceCombobox).toBeTruthy()
  expect(voiceCombobox.disabled).toBe(false)
})

test('keeps the newest OpenVox voice result when model requests finish out of order', async () => {
  const requests: Array<{
    input: Record<string, any>
    gate: ReturnType<typeof deferred<{ voices: Array<{ id: string; name: string }> }>>
  }> = []
  previewVoicesImpl = (input) => {
    const gate = deferred<{ voices: Array<{ id: string; name: string }> }>()
    requests.push({ input, gate })
    return gate.promise
  }

  await render(
    <Form
      providers={providers}
      profile={ttsProfile({
        id: 'openvox-race',
        name: 'Local OpenVox',
        provider: 'openvox_tts',
        api_url: 'http://127.0.0.1:8000/v1',
        model: 'model-a',
        voice: '',
        has_api_key: false,
        metadata: {},
      })}
      onSave={() => {}}
      onCancel={() => {}}
    />
  )

  expect(requests).toHaveLength(1)
  expect(requests[0]!.input.model).toBe('model-a')

  const modelCombobox = [...modelComboboxProps]
    .reverse()
    .find((props) => props.refreshKey?.endsWith(':models'))
  expect(modelCombobox).toBeTruthy()

  await act(async () => {
    modelCombobox!.onChange('model-b')
    await Promise.resolve()
  })

  expect(requests).toHaveLength(2)
  expect(requests[1]!.input.model).toBe('model-b')
  expect(voicePreviewOptions[0]?.signal?.aborted).toBe(true)
  expect(voicePreviewOptions[1]?.signal?.aborted).toBe(false)

  await act(async () => {
    requests[1]!.gate.resolve({ voices: [{ id: 'voice-b', name: 'Voice B' }] })
    await Promise.resolve()
  })

  let currentVoiceCombobox = [...modelComboboxProps]
    .reverse()
    .find((props) => props.refreshKey?.endsWith(':model-b:voices'))
  expect(currentVoiceCombobox?.models).toEqual(['voice-b'])
  expect(currentVoiceCombobox?.loading).toBe(false)

  await act(async () => {
    requests[0]!.gate.resolve({ voices: [{ id: 'voice-a', name: 'Voice A' }] })
    await Promise.resolve()
  })

  currentVoiceCombobox = [...modelComboboxProps]
    .reverse()
    .find((props) => props.refreshKey?.endsWith(':model-b:voices'))
  expect(currentVoiceCombobox?.models).toEqual(['voice-b'])
  expect(currentVoiceCombobox?.loading).toBe(false)
})
