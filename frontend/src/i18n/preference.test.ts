import { afterAll, beforeEach, expect, mock, test } from 'bun:test'

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

mock.module('@/i18n/resources', () => ({
  I18N_NAMESPACES: ['common'],
  fallbackLanguagesFor: (code: string) => code === 'en' ? ['en'] : [code, 'en'],
  loadLanguageBundles: async (code: string, add: (code: string, ns: string, data: object) => void) => {
    add(code, 'common', { greeting: code === 'fr' ? 'Bonjour' : 'Hello' })
  },
}))

const {
  default: i18n, initI18n, changeUiLanguage, UI_LANGUAGE_STORAGE_KEY,
  LOGIN_LANGUAGE_STORAGE_KEY, readLoginLanguage, applyLoginLanguage, changeLoginLanguage,
} = await import('./index')

beforeEach(() => {
  localStorage.removeItem(LOGIN_LANGUAGE_STORAGE_KEY)
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, value: { language: 'fr-FR', languages: ['fr-FR'] },
  })
})

afterAll(() => {
  mock.restore()
  localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
  localStorage.removeItem(LOGIN_LANGUAGE_STORAGE_KEY)
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else Reflect.deleteProperty(globalThis, 'navigator')
})

test('a French device starts in English until Settings explicitly saves another language', async () => {
  localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
  await initI18n()
  expect(i18n.language).toBe('en')
  expect(i18n.t('greeting')).toBe('Hello')
  expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBeNull()

  await changeUiLanguage('fr')
  expect(i18n.language).toBe('fr')
  expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('fr')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { language: 'de-DE', languages: ['de-DE'] },
  })
  expect(i18n.language).toBe('fr')
  expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('fr')
})

test('the login screen detects the visitor language independently of the account cache', async () => {
  localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'ko')
  expect(readLoginLanguage()).toBe('fr')
  await applyLoginLanguage(() => true)
  expect(i18n.language).toBe('fr')
  expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('ko')
  expect(localStorage.getItem(LOGIN_LANGUAGE_STORAGE_KEY)).toBeNull()
})

test('the login screen detects Korean device language', () => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, value: { language: 'ko-KR', languages: ['ko-KR'] },
  })
  expect(readLoginLanguage()).toBe('ko')
})

test('an explicit login language survives device changes and does not edit the account cache', async () => {
  localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'ko')
  await changeLoginLanguage('fr', () => true)
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, value: { language: 'de-DE', languages: ['de-DE'] },
  })
  expect(readLoginLanguage()).toBe('fr')
  expect(localStorage.getItem(LOGIN_LANGUAGE_STORAGE_KEY)).toBe('fr')
  expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('ko')
})

test('unsupported device languages fall through to a supported preference', () => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, value: { language: 'es-ES', languages: ['es-ES', 'zh-Hant-TW'] },
  })
  expect(readLoginLanguage()).toBe('zh-TW')
})

test('a login request that becomes stale cannot change the active account interface', async () => {
  await changeUiLanguage('en')
  await applyLoginLanguage(() => false)
  expect(i18n.language).toBe('en')
})
