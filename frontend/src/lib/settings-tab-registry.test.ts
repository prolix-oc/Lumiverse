import { afterAll, describe, expect, mock, test } from 'bun:test'
import frSettings from '@/i18n/locales/fr/settings.json'

function resolveLocaleValue(value: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    return Reflect.get(current, segment)
  }, value)
}

mock.module('@/i18n', () => {
  const i18n = {
    t: (key: string, options?: { ns?: string; defaultValue?: string }) => {
      const translated = options?.ns === 'settings' ? resolveLocaleValue(frSettings, key) : undefined
      return typeof translated === 'string' ? translated : options?.defaultValue ?? key
    },
  }
  return {
    default: i18n,
    initI18n: async () => i18n,
    ensureLanguageLoaded: async () => undefined,
    changeUiLanguage: async () => undefined,
  }
})
mock.module('@/store', () => ({ useStore: () => undefined }))
const { SETTINGS_TABS, settingsRegistryToCommands } = await import('./settings-tab-registry')
const settingsEntries = SETTINGS_TABS.filter((entry) => entry.id === 'agentRuntime')

afterAll(() => {
  mock.restore()
})

describe('settings command palette localization', () => {
  test('uses translated Agent Runtime labels and descriptions', () => {
    const commands = settingsRegistryToCommands(settingsEntries)
    const agentRuntime = commands.find((command) => command.id === 'settings-agentRuntime')

    expect(agentRuntime?.label).toBe(frSettings.tabs.agentRuntime.tabName)
    expect(agentRuntime?.description).toBe(frSettings.tabs.agentRuntime.tabDescription)
    expect(agentRuntime?.label).not.toBe('Agent Runtime')
  })
})
