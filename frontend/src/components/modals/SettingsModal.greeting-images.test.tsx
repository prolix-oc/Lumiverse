import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import settings from '@/i18n/locales/en/settings.json'
import common from '@/i18n/locales/en/common.json'
import shared from '@/i18n/locales/en/shared.json'
import chat from '@/i18n/locales/en/chat.json'

const matchMedia = window.matchMedia
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
dom.window.matchMedia = matchMedia
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Event: dom.window.Event,
  localStorage: dom.window.localStorage,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
})

await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { settings, common, shared, chat } },
  interpolation: { escapeValue: false },
})
// The production locale loader uses Vite's import.meta.glob; use the same
// English translations directly when exercising the actual settings UI in Bun.
mock.module('@/i18n', () => ({
  default: i18n,
  UI_LANGUAGE_STORAGE_KEY: 'lumiverse-ui-language',
  ensureLanguageLoaded: async () => {},
  applyLoginLanguage: async () => {},
  changeLoginLanguage: (language: string) => i18n.changeLanguage(language),
  changeUiLanguage: (language: string) => i18n.changeLanguage(language),
}))
mock.module('@/lib/cssModuleRegistry', () => ({ CSS_MODULE_REGISTRY: [], generateSelector: () => '' }))
mock.module('@/lib/whistle/capture.worklet.ts?worker&url', () => ({ default: '/test-capture-worklet.js' }))
const { useStore } = await import('@/store')
const { resetSettingsPersistence } = await import('@/store/slices/settings')
const { default: SettingsModal } = await import('./SettingsModal')
const setSetting = useStore.getState().setSetting
const settingChanges = mock(setSetting)
const root = createRoot(document.getElementById('root')!)

afterEach(() => resetSettingsPersistence())
afterAll(async () => {
  await act(async () => root.unmount())
  useStore.setState({ setSetting })
  dom.window.close()
})

test('Chat settings opt in to greeting art and retain the selected placement when disabled', async () => {
  useStore.setState({
    settingsActiveView: 'chat',
    showGreetingImage: false,
    greetingImagePosition: 'top',
    setSetting: settingChanges,
  })
  await act(async () => root.render(<SettingsModal onClose={() => {}} />))

  const checkbox = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find(label => label.textContent?.includes('Show greeting images'))
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  expect(checkbox).toBeDefined()
  expect(checkbox!.checked).toBe(false)
  expect(document.querySelector('[aria-labelledby="greeting-image-position-label"]')).toBeNull()
  expect(settingChanges).not.toHaveBeenCalled()

  await act(async () => checkbox!.click())
  expect(settingChanges.mock.calls.at(-1)).toEqual(['showGreetingImage', true])
  expect(useStore.getState().showGreetingImage).toBe(true)

  const placementButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[aria-labelledby="greeting-image-position-label"] button')]
    .find(button => button.textContent === text)!
  expect(placementButton('Top of message').getAttribute('aria-pressed')).toBe('true')
  expect(placementButton('Bottom of message').getAttribute('aria-pressed')).toBe('false')

  await act(async () => placementButton('Bottom of message').click())
  expect(settingChanges.mock.calls.at(-1)).toEqual(['greetingImagePosition', 'bottom'])
  expect(useStore.getState().greetingImagePosition).toBe('bottom')
  expect(placementButton('Bottom of message').getAttribute('aria-pressed')).toBe('true')
  expect(placementButton('Top of message').getAttribute('aria-pressed')).toBe('false')

  await act(async () => placementButton('Top of message').click())
  expect(settingChanges.mock.calls.at(-1)).toEqual(['greetingImagePosition', 'top'])
  expect(useStore.getState().greetingImagePosition).toBe('top')
  await act(async () => placementButton('Bottom of message').click())

  await act(async () => checkbox!.click())
  expect(settingChanges.mock.calls.at(-1)).toEqual(['showGreetingImage', false])
  expect(useStore.getState().showGreetingImage).toBe(false)
  expect(document.querySelector('[aria-labelledby="greeting-image-position-label"]')).toBeNull()
  expect(useStore.getState().greetingImagePosition).toBe('bottom')

  await act(async () => checkbox!.click())
  expect(placementButton('Bottom of message').getAttribute('aria-pressed')).toBe('true')
  expect(useStore.getState().greetingImagePosition).toBe('bottom')
})

test('Quick Replies retains the open editor across category changes and resets when settings close', async () => {
  await act(async () => root.render(null))
  useStore.setState({
    settingsActiveView: 'quickReplies',
    quickReplySets: [{ id: 'set', name: 'Fixture set', enabled: true, color: null,
      replies: [{ id: 'reply', label: 'Reply', message: 'Saved message' }] }],
  })
  await act(async () => root.render(<SettingsModal onClose={() => {}} />))
  const edit = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Edit')!
  await act(async () => edit.click())
  const editor = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Message"]')!
  expect(editor).not.toBeNull()
  editor.scrollTop = 42
  await act(async () => useStore.setState({ settingsActiveView: 'chat' }))
  expect(editor.closest<HTMLElement>('[style*="display: none"]')).not.toBeNull()
  await act(async () => useStore.setState({ settingsActiveView: 'quickReplies' }))
  expect(document.querySelector('textarea[placeholder="Message"]')).toBe(editor)
  expect(editor.scrollTop).toBe(42)
  expect(editor.value).toBe('Saved message')
  await act(async () => root.render(null))
  await act(async () => root.render(<SettingsModal onClose={() => {}} />))
  expect(document.querySelector('textarea[placeholder="Message"]')).toBeNull()
})
