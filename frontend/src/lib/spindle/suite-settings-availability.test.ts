import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const openSettings = mock(() => undefined)
const installed = { id: 'suite', identifier: 'lumiverse_suite', enabled: true, has_frontend: true }
const other = { id: 'other', identifier: 'other_extension', enabled: true, has_frontend: true }
const state = { extensions: [installed, other], user: { role: 'user' }, openSettings }
mock.module('@/store', () => ({ useStore: { getState: () => state } }))
mock.module('@/i18n', () => ({ default: { t: (_key: string, options: { defaultValue: string }) => options.defaultValue } }))

const { registerExtensionSettingsTab, unregisterExtensionSettingsTabsByExtension } = await import('./settings-tab-bridge')
const { getVisibleSettingsTabs, getSettingsSearchIndex, settingsRegistryToCommands } = await import('@/lib/settings-tab-registry')

beforeEach(() => {
  state.extensions = [installed, other]
  openSettings.mockClear()
  registerExtensionSettingsTab({ registrationId: 'suite-productivity', extensionId: 'suite', options: {
    id: 'productivity', title: 'Suite Productivity', keywords: ['suite-only'],
    sections: [{ key: 'toolbar', titleKey: 'suite.toolbar', titleFallback: 'Suite toolbar', keywords: ['toolbar'] }],
  } })
  registerExtensionSettingsTab({ registrationId: 'other-settings', extensionId: 'other', options: {
    id: 'other-settings', title: 'Other extension settings',
  } })
})

afterEach(() => {
  unregisterExtensionSettingsTabsByExtension('suite')
  unregisterExtensionSettingsTabsByExtension('other')
})

describe('retained Suite settings registrations', () => {
  test('navigation and search drop unavailable Suite tabs while preserving native and other extension settings', () => {
    expect(getVisibleSettingsTabs().some((tab) => tab.id === 'productivity')).toBe(true)
    expect(getSettingsSearchIndex().some((entry) => entry.title === 'Suite toolbar')).toBe(true)
    for (const extensions of [[other], [{ ...installed, enabled: false }, other], [{ ...installed, has_frontend: false }, other]]) {
      state.extensions = extensions
      const tabs = getVisibleSettingsTabs()
      expect(tabs.some((tab) => tab.id === 'productivity')).toBe(false)
      expect(tabs.some((tab) => tab.id === 'display')).toBe(true)
      expect(tabs.some((tab) => tab.id === 'other-settings')).toBe(true)
      expect(getSettingsSearchIndex().some((entry) => entry.tabId === 'productivity')).toBe(false)
    }
  })

  test('a command captured before Suite removal cannot open its retained settings tab', () => {
    const command = settingsRegistryToCommands(getVisibleSettingsTabs()).find((entry) => entry.id === 'settings-productivity')!
    state.extensions = [other]
    command.run(() => undefined)
    expect(openSettings).not.toHaveBeenCalled()
    state.extensions = [installed, other]
    command.run(() => undefined)
    expect(openSettings).toHaveBeenCalledTimes(1)
  })
});
