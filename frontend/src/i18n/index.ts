import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import {
  I18N_NAMESPACES,
  type I18nNamespace,
  fallbackLanguagesFor,
  loadLanguageBundles,
} from './resources'

export const UI_LANGUAGE_STORAGE_KEY = 'lumiverse-ui-language'

const SUPPORTED = ['en', 'zh', 'zh-TW', 'ja', 'fr'] as const

/** Longest first so `dreamWeaver` wins over shorter prefixes. */
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

function detectInitialLanguage(): string {
  try {
    const stored = localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)
    if (stored && SUPPORTED.includes(stored as (typeof SUPPORTED)[number])) return stored
  } catch {
    /* ignore */
  }
  const nav = navigator.language || 'en'
  if (nav === 'zh-TW' || nav.startsWith('zh-TW')) return 'zh-TW'
  if (nav.startsWith('zh')) return 'zh'
  if (nav.startsWith('ja')) return 'ja'
  if (nav.startsWith('fr')) return 'fr'
  return 'en'
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
      const lng = detectInitialLanguage()
      const resources = await fetchResourcesFor(lng)

      await i18n
        .use(LanguageDetector)
        .use(initReactI18next)
        .init({
          resources,
          lng,
          fallbackLng: {
            'zh-TW': ['zh', 'en'],
            zh: ['en'],
            ja: ['en'],
            fr: ['en'],
            default: ['en'],
          },
          supportedLngs: [...SUPPORTED],
          nonExplicitSupportedLngs: true,
          load: 'currentOnly',
          defaultNS: 'common',
          ns: [...I18N_NAMESPACES],
          interpolation: { escapeValue: false },
          detection: {
            order: ['localStorage', 'navigator'],
            lookupLocalStorage: UI_LANGUAGE_STORAGE_KEY,
            caches: ['localStorage'],
          },
        })

      return i18n
    })()
  }
  return initPromise
}

export async function changeUiLanguage(code: string): Promise<void> {
  await ensureLanguageLoaded(code)
  await i18n.changeLanguage(code)
  try {
    localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, code)
  } catch {
    /* ignore quota errors */
  }
}

export default i18n
