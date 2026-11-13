import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { DEFAULT_UI_LANGUAGE, UI_LANGUAGES, isUiLanguage } from './languages'
import {
  I18N_NAMESPACES,
  type I18nNamespace,
  fallbackLanguagesFor,
  loadLanguageBundles,
} from './resources'

export const UI_LANGUAGE_STORAGE_KEY = 'lumiverse-ui-language'
export const LOGIN_LANGUAGE_STORAGE_KEY = 'lumiverse-login-language'

/** Public auth screens have their own device preference, independent of any account. */
export function readLoginLanguage(): string {
  try {
    const stored = localStorage.getItem(LOGIN_LANGUAGE_STORAGE_KEY)
    if (isUiLanguage(stored)) return stored
  } catch { /* Browser storage may be unavailable. */ }
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    const locale = language?.replaceAll('_', '-').toLowerCase() ?? ''
    if (/^zh-(tw|hk|mo|hant)(-|$)/.test(locale)) return 'zh-TW'
    const base = locale.split('-')[0]
    if (isUiLanguage(base)) return base
  }
  return DEFAULT_UI_LANGUAGE
}

/** Longest first so a longer namespace wins over a shorter prefix of it. */
const NAMESPACES_BY_LENGTH = [...I18N_NAMESPACES].sort((a, b) => b.length - a.length)

/**
 * Legacy call sites use `common.toast.foo` instead of `common:toast.foo` or `toast.foo` + ns.
 * Map `namespace.rest` → i18n.t('rest', { ns: 'namespace' }).
 */
function resolveDottedNamespaceKey(key: string): { ns: I18nNamespace; subKey: string } | null {
  for (const ns of NAMESPACES_BY_LENGTH) {
    if (key.startsWith(`${ns}.`)) {
      return { ns, subKey: key.slice(ns.length + 1) }
    }
  }
  return null
}

const i18nT = i18n.t.bind(i18n)
i18n.t = ((key, options) => {
  if (typeof key === 'string' && !key.includes(':')) {
    const opts = options && typeof options === 'object' ? options : undefined
    if (!opts?.ns) {
      const resolved = resolveDottedNamespaceKey(key)
      if (resolved) {
        return i18nT(resolved.subKey, { ...opts, ns: resolved.ns })
      }
    }
  }
  return i18nT(key, options)
}) as typeof i18n.t

type ResourceStore = Record<string, Partial<Record<I18nNamespace, Record<string, unknown>>>>

function readInitialLanguage(): string {
  if (window.location.pathname === '/login') return readLoginLanguage()
  try {
    const stored = localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)
    if (isUiLanguage(stored)) return stored
  } catch {
    /* ignore */
  }
  // Device-language detection must never replace the app's saved choice.
  return DEFAULT_UI_LANGUAGE
}

async function fetchResourcesFor(lng: string): Promise<ResourceStore> {
  const store: ResourceStore = {}
  const stash = (code: string, ns: I18nNamespace, data: Record<string, unknown>) => {
    if (!store[code]) store[code] = {}
    store[code][ns] = data
  }
  for (const code of fallbackLanguagesFor(lng)) {
    await loadLanguageBundles(code, stash)
  }
  return store
}

/** Load locale chunks; safe before or after i18n.init(). */
export async function ensureLanguageLoaded(lng: string): Promise<void> {
  if (!i18n.isInitialized) {
    console.warn('[i18n] ensureLanguageLoaded called before init — use initI18n()')
    return
  }

  for (const code of fallbackLanguagesFor(lng)) {
    await loadLanguageBundles(code, (c, ns, data) => {
      if (!i18n.hasResourceBundle(c, ns)) {
        i18n.addResourceBundle(c, ns, data, true, true)
      }
    })
  }
}

let initPromise: Promise<typeof i18n> | null = null

export function initI18n(): Promise<typeof i18n> {
  if (!initPromise) {
    initPromise = (async () => {
      const lng = readInitialLanguage()
      const resources = await fetchResourcesFor(lng)

      await i18n
        .use(initReactI18next)
        .init({
          resources,
          lng,
          fallbackLng: {
            'zh-TW': ['zh', 'en'],
            zh: ['en'],
            ja: ['en'],
            fr: ['en'],
            it: ['en'],
            de: ['en'],
            ko: ['en'],
            default: ['en'],
          },
          supportedLngs: [...UI_LANGUAGES],
          nonExplicitSupportedLngs: true,
          load: 'currentOnly',
          defaultNS: 'common',
          ns: [...I18N_NAMESPACES],
          interpolation: { escapeValue: false },
        })

      return i18n
    })()
  }
  return initPromise
}

async function applyLanguage(code: string, isCurrent: () => boolean): Promise<boolean> {
  if (!isUiLanguage(code)) return false
  await ensureLanguageLoaded(code)
  // Locale chunks can finish after another selection or an account change.
  if (!isCurrent()) return false
  await i18n.changeLanguage(code)
  return true
}

export async function changeUiLanguage(code: string, isCurrent: () => boolean = () => true): Promise<void> {
  if (!await applyLanguage(code, isCurrent)) return
  try {
    localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, code)
  } catch {
    /* ignore quota errors */
  }
}

let loginLanguageRequest = 0

export async function applyLoginLanguage(isCurrent: () => boolean): Promise<void> {
  const request = ++loginLanguageRequest
  await applyLanguage(readLoginLanguage(), () => request === loginLanguageRequest && isCurrent())
}

export async function changeLoginLanguage(code: string, isCurrent: () => boolean): Promise<void> {
  if (!isUiLanguage(code)) return
  const request = ++loginLanguageRequest
  try {
    localStorage.setItem(LOGIN_LANGUAGE_STORAGE_KEY, code)
  } catch { /* The selection can still be applied for the current screen. */ }
  await applyLanguage(code, () => request === loginLanguageRequest && isCurrent())
}

export default i18n
