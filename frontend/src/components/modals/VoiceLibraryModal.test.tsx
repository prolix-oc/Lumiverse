import { afterEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import shared from '@/i18n/locales/en/shared.json'
import type { TtsVoiceLibraryOptions, TtsVoiceLibraryResult } from '@/types/api'

const translate = (key: string, values?: Record<string, unknown>) => {
  let label = (shared.voiceLibrary as Record<string, string>)[key] ?? key
  for (const [name, value] of Object.entries(values || {})) label = label.replaceAll(`{{${name}}}`, String(value))
  return label
}
const plainTranslate = (key: string) => key
mock.module('react-i18next', () => ({ useTranslation: (_ns: string, options?: { keyPrefix?: string }) => ({ t: options?.keyPrefix === 'voiceLibrary' ? translate : plainTranslate }) }))
const response = (name = 'Alita', more = true): TtsVoiceLibraryResult => ({ provider: 'elevenlabs', voices: [{ id: name, name, gender: 'female', description: 'Calm narration', previewUrl: '/preview.mp3', rate: 2 }], has_more: more, total_count: 21 })
const voiceLibrary = mock((_input: unknown, _options?: unknown): Promise<TtsVoiceLibraryResult> => Promise.resolve(response()))
mock.module('@/api/tts-connections', () => ({ ttsConnectionsApi: { voiceLibrary } }))
mock.module('@/components/chat/MessageAudioPlayer', () => ({ default: ({ src }: { src: string }) => <audio src={src} /> }))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
})
const VoiceLibraryModal = (await import('./VoiceLibraryModal')).default
const { ModalShell } = await import('@/components/shared/ModalShell')
const connection = { connection_id: 'eleven', provider: 'elevenlabs' }
let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  voiceLibrary.mockReset()
  voiceLibrary.mockImplementation(async () => response())
})
async function mount(onSelect = (_voice: unknown) => {}, onClose = () => {}, parentClose = () => {}) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<><ModalShell isOpen onClose={parentClose}>Settings draft</ModalShell><VoiceLibraryModal connection={connection} onSelect={onSelect} onClose={onClose} /></>))
  await settle()
}
async function settle() { await act(async () => { await Bun.sleep(330) }) }
function button(label: string) { return document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)! }

test('browses pages, previews the existing audio control and selects the library ID', async () => {
  const selected: unknown[] = []
  let closed = 0
  await mount((voice) => selected.push(voice), () => closed++)
  expect(voiceLibrary.mock.calls[0][0]).toMatchObject({ ...connection, page: 0, page_size: 20, sort: 'trending' })
  expect(document.body.textContent).toContain('2× credits')
  await act(async () => button('Preview Alita').click())
  expect(document.querySelector('audio')?.getAttribute('src')).toBe('/preview.mp3')
  voiceLibrary.mockResolvedValueOnce(response('Next voice', false))
  await act(async () => button('nextPage').click())
  await settle()
  expect(voiceLibrary.mock.calls.at(-1)?.[0]).toMatchObject({ page: 1 })
  expect(button('nextPage').disabled).toBe(true)
  expect(document.querySelector('audio')).toBeNull()
  await act(async () => button('Use Next voice').click())
  expect(selected).toMatchObject([{ id: 'Next voice' }])
  expect(closed).toBe(1)
})

test('filter changes discard superseded requests and reset to the first page', async () => {
  let resolveOld!: (result: TtsVoiceLibraryResult) => void
  voiceLibrary.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
  await mount()
  const oldSignal = (voiceLibrary.mock.calls[0][1] as { signal: AbortSignal }).signal
  const gender = document.querySelector<HTMLSelectElement>('[aria-label="Gender"]')!
  voiceLibrary.mockResolvedValueOnce(response('Filtered', false))
  await act(async () => { gender.value = 'female'; gender.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
  expect(oldSignal.aborted).toBe(true)
  await settle()
  expect(voiceLibrary.mock.calls.at(-1)?.[0]).toMatchObject({ page: 0, gender: 'female' })
  await act(async () => resolveOld(response('Stale')))
  expect(document.body.textContent).toContain('Filtered')
  expect(document.body.textContent).not.toContain('Stale')
})

test('provider errors can be retried and Escape dismisses only the library', async () => {
  let libraryClosed = 0
  let parentClosed = 0
  voiceLibrary.mockResolvedValueOnce({ provider: 'elevenlabs', voices: [], has_more: false, error: 'ElevenLabs voice library failed (429): Try later' })
  await mount(undefined, () => libraryClosed++, () => parentClosed++)
  expect(document.body.textContent).toContain('Try later')
  const retry = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === 'Retry')!
  await act(async () => retry.click())
  await settle()
  expect(document.body.textContent).toContain('Alita')
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(libraryClosed).toBe(1)
  expect(parentClosed).toBe(0)
})
