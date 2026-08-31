import { expect, mock, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { act } from 'react'
import { JSDOM } from 'jsdom'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import type { Root } from 'react-dom/client'
import en from '@/i18n/locales/en/common.json'
import fr from '@/i18n/locales/fr/common.json'
import it from '@/i18n/locales/it/common.json'
import ja from '@/i18n/locales/ja/common.json'
import zh from '@/i18n/locales/zh/common.json'
import zhTW from '@/i18n/locales/zh-TW/common.json'

mock.module('@/i18n', () => ({
  changeUiLanguage: async () => undefined,
}))

const SUPPORTED_LOCALES = [
  ['en', en],
  ['zh', zh],
  ['zh-TW', zhTW],
  ['ja', ja],
  ['fr', fr],
  ['it', it],
] as const

async function createLocaleInstance(language: string): Promise<I18nInstance> {
  const instance = createInstance()
  await instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LOCALES.map(([code]) => code),
    nonExplicitSupportedLngs: true,
    load: 'currentOnly',
    defaultNS: 'common',
    ns: ['common'],
    resources: Object.fromEntries(SUPPORTED_LOCALES.map(([code, common]) => [code, { common }])),
    interpolation: { escapeValue: false },
  })
  return instance
}

test('Settings language selector follows current and persisted locale across close, reopen, and reload', async () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousElement = globalThis.Element
  const previousHTMLElement = globalThis.HTMLElement
  const previousNode = globalThis.Node
  const previousEvent = globalThis.Event
  const previousNavigator = globalThis.navigator
  const runtime = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = runtime.IS_REACT_ACT_ENVIRONMENT
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })
  const domWindow = dom.window as unknown as Window & typeof globalThis
  Object.assign(globalThis, {
    window: domWindow,
    document: domWindow.document,
    Element: domWindow.Element,
    HTMLElement: domWindow.HTMLElement,
    Node: domWindow.Node,
    Event: domWindow.Event,
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: domWindow.navigator,
  })
  runtime.IS_REACT_ACT_ENVIRONMENT = true

  let activeRoot: Root | null = null
  let activeContainer: HTMLDivElement | null = null
  try {
    const { createRoot } = await import('react-dom/client')
    const { default: LanguageSwitcher } = await import('./LanguageSwitcher')

    const mount = async (instance: I18nInstance) => {
      const container = document.createElement('div')
      document.body.append(container)
      const root = createRoot(container)
      activeRoot = root
      activeContainer = container
      await act(async () => {
        root.render(
          <I18nextProvider i18n={instance}>
            <LanguageSwitcher />
          </I18nextProvider>,
        )
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      })
      return {
        select: container.querySelector<HTMLSelectElement>('#lumiverse-ui-language'),
        label: container.querySelector<HTMLLabelElement>('label[for="lumiverse-ui-language"]'),
      }
    }

    const closeSettings = async () => {
      if (activeRoot) {
        await act(async () => {
          activeRoot?.unmount()
        })
      }
      activeContainer?.remove()
      activeRoot = null
      activeContainer = null
    }

    for (const [locale, common] of SUPPORTED_LOCALES) {
      domWindow.localStorage.clear()
      const current = await createLocaleInstance(locale)

      let mounted = await mount(current)
      expect(mounted.select?.value, `${locale} initial selection`).toBe(locale)
      expect(mounted.label?.textContent, `${locale} rendered content`).toBe(common.language.label)

      await closeSettings()
      mounted = await mount(current)
      expect(mounted.select?.value, `${locale} close/reopen selection`).toBe(locale)
      expect(mounted.label?.textContent, `${locale} close/reopen content`).toBe(common.language.label)

      await closeSettings()
      domWindow.localStorage.setItem('lumiverse-ui-language', locale)
      const reloaded = await createLocaleInstance(domWindow.localStorage.getItem('lumiverse-ui-language') ?? 'en')
      mounted = await mount(reloaded)
      expect(mounted.select?.value, `${locale} reload selection`).toBe(locale)
      expect(mounted.label?.textContent, `${locale} reload content`).toBe(common.language.label)
      await closeSettings()
    }

    domWindow.localStorage.setItem('lumiverse-ui-language', 'unknown-locale')
    const unknown = await createLocaleInstance(domWindow.localStorage.getItem('lumiverse-ui-language') ?? 'en')
    const fallback = await mount(unknown)
    expect(fallback.select?.value).toBe('en')
    expect(fallback.label?.textContent).toBe(en.language.label)
  } finally {
    if (activeRoot) {
      await act(async () => {
        activeRoot?.unmount()
      })
    }
    activeContainer?.remove()
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      Element: previousElement,
      HTMLElement: previousHTMLElement,
      Node: previousNode,
      Event: previousEvent,
    })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: previousNavigator,
    })
    if (previousActEnvironment === undefined) delete runtime.IS_REACT_ACT_ENVIRONMENT
    else runtime.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})
