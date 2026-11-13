import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { MemoryRouter } from 'react-router'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import en from '@/i18n/locales/en/auth.json'
import de from '@/i18n/locales/de/auth.json'
import fr from '@/i18n/locales/fr/auth.json'
import it from '@/i18n/locales/it/auth.json'
import ja from '@/i18n/locales/ja/auth.json'
import ko from '@/i18n/locales/ko/auth.json'
import zh from '@/i18n/locales/zh/auth.json'
import zhTW from '@/i18n/locales/zh-TW/auth.json'

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/login' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  IS_REACT_ACT_ENVIRONMENT: true,
})
window.matchMedia = (media) => ({
  media, matches: false, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent: () => true,
})
HTMLElement.prototype.scrollIntoView = () => {}

const login = mock(async () => {})
const state = {
  login,
  authError: null,
  isAuthenticated: false,
  isAuthLoading: false,
  checkSession: async () => {},
}
mock.module('@/store', () => ({
  useStore: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state }),
}))
mock.module('@/hooks/useUiLanguage', () => ({ useUiLanguage: () => {} }))
mock.module('@/i18n', () => ({
  changeLoginLanguage: async (code: string, isCurrent: () => boolean) => {
    if (isCurrent()) await i18n.changeLanguage(code)
  },
}))
mock.module('@/api/sso-providers', () => ({ ssoProvidersApi: { loginOptions: async () => [] } }))
mock.module('@/lib/ssoPopup', () => ({ startSsoPopup: async () => ({ ok: true }) }))

const { default: LoginPage } = await import('./LoginPage')
const { createRoot } = await import('react-dom/client')
const i18n = createInstance()
const translatedLocales = { de, fr, it, ja, ko, zh, 'zh-TW': zhTW }
const resources = Object.fromEntries(
  Object.entries({ en, ...translatedLocales }).map(([lng, auth]) => [lng, { auth }]),
)
await i18n.init({ lng: 'en', fallbackLng: 'en', resources })

beforeEach(async () => {
  login.mockClear()
  await i18n.changeLanguage('en')
})

afterAll(() => dom.window.close())

async function renderLogin() {
  const container = document.getElementById('root')!
  const testRoot = createRoot(container)
  await act(async () => {
    testRoot.render(<I18nextProvider i18n={i18n}><MemoryRouter><LoginPage /></MemoryRouter></I18nextProvider>)
  })
  return testRoot
}

test('recovery opens and closes without submitting the login form', async () => {
  const testRoot = await renderLogin()
  try {
    const details = document.querySelector('details')!
    const summary = details.querySelector('summary')!
    expect(summary.textContent).toBe('Forgot your password?')
    expect(details.open).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)

    await act(async () => summary.click())
    expect(details.open).toBe(true)
    expect(details.querySelector('code')!.textContent).toBe('bun run reset-password')
    expect(details.querySelectorAll('li')).toHaveLength(4)
    expect(details.textContent).toContain('machine running Lumiverse')
    expect(details.textContent).toContain('package.json and data/')
    expect(details.textContent).toContain('at least 8 characters')
    expect(details.textContent).toContain('Existing sessions for that account will be signed out')
    expect(details.textContent).toContain('contact your administrator')
    expect(details.textContent).toContain('sign-in provider')
    expect(document.querySelector('input[autocomplete="current-password"]')).not.toBeNull()

    await act(async () => summary.click())
    expect(details.open).toBe(false)
    expect(login).not.toHaveBeenCalled()
  } finally {
    await act(async () => testRoot.unmount())
  }
})

test.each(Object.entries(translatedLocales))('recovery instructions use %s translations', async (lng, auth) => {
  await i18n.changeLanguage(lng)
  const testRoot = await renderLogin()
  try {
    const details = document.querySelector('details')!
    expect(details.querySelector('summary')!.textContent).toBe(auth.forgotPassword)
    for (const translation of Object.values(auth.passwordRecovery)) {
      expect(details.textContent).toContain(translation)
    }
    expect(details.textContent).not.toContain(en.passwordRecovery.ownerOnly)
    expect(details.textContent).not.toContain('passwordRecovery.')
    expect(details.querySelector('code')!.textContent).toBe('bun run reset-password')
  } finally {
    await act(async () => testRoot.unmount())
  }
})

test('the displayed command invokes the existing owner reset script', async () => {
  const pkg = await Bun.file(new URL('../../../../package.json', import.meta.url)).json()
  expect(pkg.scripts['reset-password']).toBe('bun run scripts/reset-password.ts')
  expect(await Bun.file(new URL('../../../../scripts/reset-password.ts', import.meta.url)).exists()).toBe(true)
})

test('visitors can translate password recovery before signing in', async () => {
  const testRoot = await renderLogin()
  try {
    const select = document.querySelector<HTMLSelectElement>('#lumiverse-login-language')!
    expect([...select.options].map(option => option.textContent)).toContain('Français')
    await act(async () => {
      select.value = 'fr'
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    const details = document.querySelector('details')!
    expect(details.querySelector('summary')!.textContent).toBe(fr.forgotPassword)
    expect(details.textContent).toContain(fr.passwordRecovery.otherAccounts)
    expect(login).not.toHaveBeenCalled()
  } finally {
    await act(async () => testRoot.unmount())
  }
})
