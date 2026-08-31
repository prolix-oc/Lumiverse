/// <reference types="bun-types" />

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import en from '@/i18n/locales/en/chat.json'
import fr from '@/i18n/locales/fr/chat.json'
import it from '@/i18n/locales/it/chat.json'
import ja from '@/i18n/locales/ja/chat.json'
import zh from '@/i18n/locales/zh/chat.json'
import zhTW from '@/i18n/locales/zh-TW/chat.json'

const localeCatalogues = { en, fr, it, ja, zh, 'zh-TW': zhTW } as const
const requestedKeys: string[] = []
const translations: Record<string, string> = {}
const testI18n = {
  t(key: string | readonly string[]) {
    const normalizedKey = typeof key === 'string' ? key : key[0]
    requestedKeys.push(normalizedKey)
    return translations[normalizedKey] ?? normalizedKey
  },
}

mock.module('@/i18n', () => ({
  default: testI18n,
  UI_LANGUAGE_STORAGE_KEY: 'lumiverse-ui-language',
  initI18n: async () => testI18n,
  ensureLanguageLoaded: async () => {},
  changeUiLanguage: async () => {},
}))
mock.module('@/lib/cssModuleRegistry', () => ({
  CSS_MODULE_REGISTRY: [],
  generateSelector: () => '',
}))
mock.module('@/router', () => ({
  router: {
    navigate: async () => {},
  },
}))
mock.module('@/api/auth', () => ({
  authClient: {
    signIn: { username: async () => ({ data: null, error: null }) },
    signOut: async () => {},
    getSession: async () => ({ data: null }),
  },
  getAuthErrorMessage: () => 'Authentication failed',
  readAuthErrorResponseMeta: async () => null,
}))

// Install module mocks before evaluating useWebSocket's static dependency graph.
const { formatTerminalGenerationError } = await import('./useWebSocket')

beforeEach(() => {
  requestedKeys.length = 0
  for (const key of Object.keys(translations)) delete translations[key]
})

function installTranslations(values: Readonly<Record<string, string>>): void {
  Object.assign(translations, values)
}

describe('terminal generation error formatting', () => {
  test('localizes a known stable public code from the Agent Run catalogue', () => {
    installTranslations({
      'chat.agentRun.errors.provider_request_error': 'Localized provider failure',
    })

    expect(formatTerminalGenerationError({
      errorCode: 'provider_request_error',
    })).toBe('Localized provider failure')
    expect(requestedKeys).toEqual([
      'chat.agentRun.errors.provider_request_error',
    ])
  })

  test('uses the generic Agent Run error for an unknown future code', () => {
    installTranslations({
      'chat.agentRun.errors.unknown': 'Localized safe failure',
    })

    expect(formatTerminalGenerationError({
      errorCode: 'future_agent_error',
    })).toBe('Localized safe failure')
    expect(requestedKeys).toEqual([
      'chat.agentRun.errors.future_agent_error',
      'chat.agentRun.errors.unknown',
    ])
    expect(requestedKeys.some((key) => key.includes('agentRuntime.errors'))).toBeFalse()
    expect(requestedKeys.some((key) => key.includes('agentActivity.errors'))).toBeFalse()
  })

  test('all six locale catalogues provide specific and generic Agent Run errors', () => {
    for (const [locale, catalogue] of Object.entries(localeCatalogues)) {
      const errors = catalogue.agentRun.errors
      expect(errors.provider_request_error, `${locale} provider_request_error`).toBeString()
      expect(errors.provider_request_error.trim(), `${locale} provider_request_error`).not.toBe('')
      expect(errors.unknown, `${locale} unknown`).toBeString()
      expect(errors.unknown.trim(), `${locale} unknown`).not.toBe('')
      expect(errors.provider_request_error, locale).not.toBe(errors.unknown)
    }
  })
})
