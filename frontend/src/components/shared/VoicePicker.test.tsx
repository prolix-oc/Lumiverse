import { afterEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { TtsVoice, VoiceRef } from '@/types/api'

const voices: TtsVoice[] = [
  { id: 'Kore', name: 'Kore', gender: 'feminine', description: 'Firm, assured delivery.', language: 'en-US' },
  { id: 'Algieba', name: 'Algieba', gender: 'masculine', description: 'Smooth, flowing delivery.', language: 'en-US' },
]
const store = {
  ttsProfiles: [{ id: 'gemini', provider: 'google_tts', updated_at: 1 }],
  ttsProviders: [{ id: 'google_tts', capabilities: { staticVoices: voices } }],
}
let fetchedVoices: TtsVoice[] = []
mock.module('@/store', () => ({
  useStore: (selector: (state: typeof store) => unknown) => selector(store),
}))
mock.module('@/api/tts-connections', () => ({
  ttsConnectionsApi: { voices: async () => ({ voices: fetchedVoices }) },
}))
mock.module('./ConnectionSelect', () => ({ default: () => null }))
mock.module('@/components/modals/VoiceLibraryModal', () => ({
  default: ({ onSelect, onClose }: { onSelect: (voice: TtsVoice) => void; onClose: () => void }) => <button onClick={() => { onSelect({ id: 'community-id', name: 'Community voice' }); onClose() }}>Choose library voice</button>,
}))
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
  requestAnimationFrame: { configurable: true, value: dom.window.requestAnimationFrame.bind(dom.window) },
  cancelAnimationFrame: { configurable: true, value: dom.window.cancelAnimationFrame.bind(dom.window) },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
})
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const VoicePicker = (await import('./VoicePicker')).default
let root: Root | undefined
let container: HTMLDivElement

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  container?.remove()
  fetchedVoices = []
  store.ttsProviders[0].capabilities.staticVoices = voices
  store.ttsProfiles[0].provider = 'google_tts'
  store.ttsProviders[0].id = 'google_tts'
  delete (store.ttsProviders[0].capabilities as Record<string, unknown>).supportsVoiceLibrary
})

test.each(['static', 'fetched'])('shows gender and tone from %s voices and selects the API voice ID', async (source) => {
  if (source === 'fetched') {
    fetchedVoices = voices
    store.ttsProviders[0].capabilities.staticVoices = []
  }
  const selected: VoiceRef = { connectionId: 'gemini', voice: 'Kore', parameters: { speed: 0.8 } }
  const changes: Array<VoiceRef | null> = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<VoicePicker value={selected} onChange={(next) => changes.push(next)} />)
  })

  const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!
  expect(trigger.textContent).toContain('Kore (Female)')
  expect(trigger.textContent).toContain('Firm, assured delivery.')
  await act(async () => trigger.click())

  const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
  const maleVoice = options.find((option) => option.textContent?.includes('Algieba (Male)'))
  expect(maleVoice?.textContent).toContain('Smooth, flowing delivery.')
  expect(maleVoice?.textContent).toContain('en-US')
  await act(async () => maleVoice!.click())
  expect(changes).toEqual([{ ...selected, voice: 'Algieba' }])
})

test('library selection preserves the connection and per-voice parameters', async () => {
  store.ttsProfiles[0].provider = 'elevenlabs'
  store.ttsProviders[0].id = 'elevenlabs'
  Object.assign(store.ttsProviders[0].capabilities, { supportsVoiceLibrary: true })
  const selected: VoiceRef = { connectionId: 'gemini', voice: '', parameters: { speed: 0.8 } }
  const changes: Array<VoiceRef | null> = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<VoicePicker value={selected} onChange={(next) => changes.push(next)} />))
  const open = [...container.querySelectorAll('button')].find((button) => button.textContent === 'voiceLibrary')!
  await act(async () => { open.click(); await Bun.sleep(10) })
  const choose = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Choose library voice')!
  await act(async () => choose.click())
  expect(changes).toEqual([{ ...selected, voice: 'community-id' }])
})
