import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { create } from 'zustand'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const globals = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
})

const useStore = create<{
  isAuthenticated: boolean
  user: { id: string }
  uiLanguage: string | null
  setSetting: (key: string, language: string) => void
}>(set => ({
  isAuthenticated: true,
  user: { id: 'owner' },
  uiLanguage: null,
  setSetting: (_key, language) => set({ uiLanguage: language }),
}))
mock.module('@/store', () => ({ useStore }))

// The actual resource module uses Vite's import.meta.glob. Exercise real i18next
// with small locale bundles and controllable chunk loading instead.
let loading: Promise<void> | undefined
mock.module('@/i18n/resources', () => ({
  I18N_NAMESPACES: ['common'],
  fallbackLanguagesFor: (code: string) => code === 'en' ? ['en'] : [code, 'en'],
  loadLanguageBundles: async (code: string, add: (code: string, ns: string, data: object) => void) => {
    await loading
    add(code, 'common', { greeting: code === 'fr' ? 'Bonjour' : 'Hello' })
  },
}))
const { default: i18n, initI18n, UI_LANGUAGE_STORAGE_KEY, LOGIN_LANGUAGE_STORAGE_KEY } = await import('@/i18n')
const { useUiLanguage } = await import('./useUiLanguage')
const { default: LanguageSwitcher } = await import('@/components/shared/LanguageSwitcher')
localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'fr')
await initI18n()

let root: Root
let container: HTMLDivElement
function Probe() { useUiLanguage(); return null }
const render = async () => { await act(async () => root.render(<Probe />)) }
const update = async (patch: Partial<ReturnType<typeof useStore.getState>>) => {
  await act(async () => { useStore.setState(patch) })
}

beforeEach(async () => {
  loading = undefined
  localStorage.removeItem(LOGIN_LANGUAGE_STORAGE_KEY)
  useStore.setState({ isAuthenticated: true, user: { id: 'owner' }, uiLanguage: null })
  await i18n.changeLanguage('fr')
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()) })
afterAll(() => {
  mock.restore()
  dom.window.close()
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

test('account English overrides the French device cache after hydration', async () => {
  await render()
  expect(i18n.language).toBe('fr')
  await update({ uiLanguage: 'en' })
  expect(i18n.language).toBe('en')
  expect(i18n.t('greeting')).toBe('Hello')
  expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('en')
})

test('the language selector updates the account preference and the interface', async () => {
  await act(async () => root.render(<><Probe /><LanguageSwitcher /></>))
  const select = container.querySelector<HTMLSelectElement>('select')!
  expect(useStore.getState().uiLanguage).toBeNull()
  await act(async () => {
    select.value = 'en'
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  expect(useStore.getState().uiLanguage).toBe('en')
  expect(i18n.language).toBe('en')
})

test('the cached language remains while the account preference is still loading', async () => {
  await render()
  expect(i18n.language).toBe('fr')
  expect(useStore.getState().uiLanguage).toBeNull()
})

test('a chunk completing after an account change cannot apply the old preference', async () => {
  let release!: () => void
  loading = new Promise(resolve => { release = resolve })
  await render()
  await update({ uiLanguage: 'en' })
  await update({ user: { id: 'other' }, uiLanguage: null })
  await act(async () => { release(); await Promise.resolve() })
  expect(i18n.language).toBe('fr')
})

test('switching accounts applies each saved language without changing the login preference', async () => {
  localStorage.setItem(LOGIN_LANGUAGE_STORAGE_KEY, 'ko')
  useStore.setState({ uiLanguage: 'en' })
  await render()
  expect(i18n.language).toBe('en')
  await update({ user: { id: 'other' }, uiLanguage: 'fr' })
  expect(i18n.language).toBe('fr')
  expect(useStore.getState().uiLanguage).toBe('fr')
  await update({ user: { id: 'owner' }, uiLanguage: 'en' })
  expect(i18n.language).toBe('en')
  expect(useStore.getState().uiLanguage).toBe('en')
  expect(localStorage.getItem(LOGIN_LANGUAGE_STORAGE_KEY)).toBe('ko')
})

test('a slower earlier selection cannot overwrite the latest selection', async () => {
  let release!: () => void
  loading = new Promise(resolve => { release = resolve })
  await render()
  await update({ uiLanguage: 'en' })
  loading = undefined
  await update({ uiLanguage: 'fr' })
  await act(async () => { release(); await Promise.resolve() })
  expect(i18n.language).toBe('fr')
})

test('signed-out visitors use the login preference without changing the account cache', async () => {
  localStorage.setItem(LOGIN_LANGUAGE_STORAGE_KEY, 'fr')
  localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'ko')
  useStore.setState({ isAuthenticated: false })
  await render()
  expect(i18n.language).toBe('fr')
  expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('ko')
  expect(useStore.getState().uiLanguage).toBeNull()
})

test('signing in overrides the login language with the saved account preference', async () => {
  localStorage.setItem(LOGIN_LANGUAGE_STORAGE_KEY, 'fr')
  useStore.setState({ isAuthenticated: false })
  await render()
  await update({ isAuthenticated: true, uiLanguage: 'en' })
  expect(i18n.language).toBe('en')
  expect(localStorage.getItem(LOGIN_LANGUAGE_STORAGE_KEY)).toBe('fr')
})

test('a pending login locale cannot replace the account language after sign-in', async () => {
  localStorage.setItem(LOGIN_LANGUAGE_STORAGE_KEY, 'fr')
  let release!: () => void
  loading = new Promise(resolve => { release = resolve })
  useStore.setState({ isAuthenticated: false })
  await render()
  loading = undefined
  await update({ isAuthenticated: true, uiLanguage: 'en' })
  await act(async () => { release(); await Promise.resolve() })
  expect(i18n.language).toBe('en')
  expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('en')
})
