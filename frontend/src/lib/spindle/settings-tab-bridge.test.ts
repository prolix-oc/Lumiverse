import { afterEach, describe, expect, test } from 'bun:test'

import type { SettingsTabEntry } from '@/lib/settings-tab-registry'
import {
  getExtensionSettingsTabRegistrations,
  getSettingsTabRootsForView,
  joinExtensionSettingsTabs,
  registerExtensionSettingsTab,
  subscribeExtensionSettingsTabs,
  type SettingsTabRegistrationHandle,
  type SpindleSettingsTabSection,
} from './settings-tab-bridge'

const CORE_TABS: SettingsTabEntry[] = [
  {
    id: 'account',
    shortName: 'Account',
    tabName: 'Account',
    tabDescription: 'Account settings',
    tabIcon: (() => null) as never,
    keywords: ['account'],
    sections: [{ key: 'profile', titleKey: 'account.profile', titleFallback: 'Profile', keywords: ['profile'] }],
    component: () => null,
  },
  {
    id: 'operator',
    shortName: 'Operator',
    tabName: 'Operator',
    tabDescription: 'Operator settings',
    tabIcon: (() => null) as never,
    keywords: ['operator'],
    role: 'owner',
    component: () => null,
  },
]

const handles = new Set<SettingsTabRegistrationHandle>()

function register(
  registrationId: string,
  extensionId: string,
  options: Parameters<typeof registerExtensionSettingsTab>[0]['options'],
): SettingsTabRegistrationHandle {
  const handle = registerExtensionSettingsTab({ registrationId, extensionId, options })
  handles.add(handle)
  return handle
}

function section(key: string): SpindleSettingsTabSection {
  return {
    key,
    titleKey: `extension.settings.${key}`,
    titleFallback: key,
    keywords: [key],
  }
}

afterEach(() => {
  for (const handle of handles) handle.destroy()
  handles.clear()
})

describe('Spindle settings tab bridge', () => {
  test('mounts only roots owned by the active tab, including native Extensions', () => {
    const extensionsRoot = {} as HTMLElement
    const productivityRoot = {} as HTMLElement
    const anotherRoot = {} as HTMLElement
    const settingsTabs = [
      { tabId: 'extensions', root: extensionsRoot },
      { tabId: 'productivity', root: productivityRoot },
      { tabId: 'another', root: anotherRoot },
    ]

    expect(getSettingsTabRootsForView(settingsTabs, 'extensions')).toEqual([extensionsRoot])
    expect(getSettingsTabRootsForView(settingsTabs, 'productivity')).toEqual([productivityRoot])
    expect(getSettingsTabRootsForView(settingsTabs, 'another')).toEqual([anotherRoot])
  })

  test('is additive when no extension has registered a settings tab', () => {
    const joined = joinExtensionSettingsTabs(CORE_TABS)

    expect(joined).toEqual(CORE_TABS)
    expect(joined).not.toBe(CORE_TABS)
    expect(joined[0]).toBe(CORE_TABS[0])
  })

  test('uses one navigation entry and deterministic body/search order for shared ids', () => {
    register('shared-first', 'extension.alpha', {
      id: 'shared-settings',
      title: 'Alpha settings',
      shortName: 'Alpha',
      iconSvg: '<svg data-owner="alpha" />',
      description: 'Alpha extension settings',
      keywords: ['alpha'],
      sections: [section('alpha')],
      order: 20,
    })
    register('shared-second', 'extension.beta', {
      id: 'shared-settings',
      title: 'Beta settings',
      shortName: 'Beta',
      description: 'Beta extension settings',
      keywords: ['beta'],
      sections: [section('beta')],
      order: 10,
    })

    const joined = joinExtensionSettingsTabs([])

    expect(joined).toHaveLength(1)
    expect(joined[0]).toMatchObject({
      id: 'shared-settings',
      shortName: 'Alpha',
      tabName: 'Alpha settings',
      tabDescription: 'Alpha extension settings',
      iconSvg: '<svg data-owner="alpha" />',
      keywords: ['beta', 'alpha'],
    })
    expect(joined[0]?.sections?.map(({ key }) => key)).toEqual(['beta', 'alpha'])
    expect(getExtensionSettingsTabRegistrations('shared-settings').map(({ registrationId }) => registrationId))
      .toEqual(['shared-second', 'shared-first'])
  })

  test('preserves core metadata, role, and sections while appending extension content', () => {
    const coreTab = CORE_TABS[0]!
    register('claimed-account', 'extension.claimant', {
      id: coreTab.id,
      title: 'Claimed account',
      shortName: 'Claimed',
      description: 'Replaces account metadata',
      keywords: ['claimed'],
      sections: [section('claimed')],
    })

    const [joined] = joinExtensionSettingsTabs([coreTab], 'member', CORE_TABS)

    expect(joined).toMatchObject({
      id: coreTab.id,
      shortName: coreTab.shortName,
      tabName: coreTab.tabName,
      tabDescription: coreTab.tabDescription,
      tabIcon: coreTab.tabIcon,
      component: coreTab.component,
      keywords: ['account', 'claimed'],
      sections: [
        ...coreTab.sections!,
        section('claimed'),
      ],
    })
    expect(joined?.role).toBe(coreTab.role)
  })

  test('does not revive a role-hidden core tab through an extension claim', () => {
    register('claimed-operator', 'extension.member', { id: 'operator', title: 'Injected operator' })

    expect(joinExtensionSettingsTabs([], 'member', CORE_TABS)).toEqual([])
    expect(joinExtensionSettingsTabs([CORE_TABS[0]!], 'member', CORE_TABS).map((tab) => tab.id)).toEqual(['account'])
  })

  test('enforces four registrations per extension and thirty-two globally', () => {
    for (let index = 0; index < 4; index += 1) {
      register(`same-extension-${index}`, 'extension.capped', { id: `same-extension-tab-${index}` })
    }
    expect(() => registerExtensionSettingsTab({
      registrationId: 'same-extension-4',
      extensionId: 'extension.capped',
      options: { id: 'same-extension-tab-4' },
    })).toThrow('SETTINGS_TAB_LIMIT_PER_EXTENSION:4')

    for (let index = 0; index < 28; index += 1) {
      register(`global-${index}`, `extension.global-${index}`, { id: `global-tab-${index}` })
    }
    expect(() => registerExtensionSettingsTab({
      registrationId: 'global-overflow',
      extensionId: 'extension.global-overflow',
      options: { id: 'global-overflow-tab' },
    })).toThrow('SETTINGS_TAB_LIMIT_GLOBAL:32')
  })

  test('activation and registry subscriptions stop after idempotent destroy', () => {
    let notifications = 0
    let activations = 0
    const unsubscribe = subscribeExtensionSettingsTabs(() => { notifications += 1 })
    const handle = register('disposable', 'extension.disposable', { id: 'disposable-tab', title: 'Initial title' })
    const unlisten = handle.onActivate(() => { activations += 1 })

    handle.activate()
    expect(activations).toBe(1)
    expect(notifications).toBe(1)

    unsubscribe()
    unlisten()
    handle.setTitle('Updated title')
    handle.destroy()
    handle.destroy()

    expect(notifications).toBe(1)
    expect(getExtensionSettingsTabRegistrations('disposable-tab')).toEqual([])
  })

  test('positions productivity tab behind display by default and respects custom position', () => {
    register('prod-test', 'extension.productivity', { id: 'productivity', title: 'UI Productivity', shortName: 'Productivity' })
    const tabs: SettingsTabEntry[] = [
      { id: 'account', shortName: 'Account', tabName: 'Account', tabDescription: 'Account', tabIcon: (() => null) as never, keywords: [], component: () => null },
      { id: 'display', shortName: 'Display', tabName: 'Display', tabDescription: 'Display', tabIcon: (() => null) as never, keywords: [], component: () => null },
      { id: 'chat', shortName: 'Chat', tabName: 'Chat', tabDescription: 'Chat', tabIcon: (() => null) as never, keywords: [], component: () => null },
      { id: 'extensions', shortName: 'Extensions', tabName: 'Extensions', tabDescription: 'Extensions', tabIcon: (() => null) as never, keywords: [], component: () => null },
    ]

    // Default: after display
    const defaultJoined = joinExtensionSettingsTabs(tabs)
    expect(defaultJoined.map((t) => t.id)).toEqual(['account', 'display', 'productivity', 'chat', 'extensions'])

    // Top
    const topJoined = joinExtensionSettingsTabs(tabs, undefined, tabs, undefined, 'top')
    expect(topJoined.map((t) => t.id)).toEqual(['productivity', 'account', 'display', 'chat', 'extensions'])

    // After Chat
    const chatJoined = joinExtensionSettingsTabs(tabs, undefined, tabs, undefined, 'after-chat')
    expect(chatJoined.map((t) => t.id)).toEqual(['account', 'display', 'chat', 'productivity', 'extensions'])

    // Bottom
    const bottomJoined = joinExtensionSettingsTabs(tabs, undefined, tabs, undefined, 'bottom')
    expect(bottomJoined.map((t) => t.id)).toEqual(['account', 'display', 'chat', 'extensions', 'productivity'])
  })

  test('positions generic spindle extension settings tabs by requested position', () => {
    register('ext-pos-1', 'ext.one', { id: 'ext-one', title: 'Extension One', position: 'after-account' })
    register('ext-pos-2', 'ext.two', { id: 'ext-two', title: 'Extension Two', position: 'before-chat' })
    register('ext-pos-3', 'ext.three', { id: 'ext-three', title: 'Extension Three', position: 'top' })
    register('ext-pos-4', 'ext.four', { id: 'ext-four', title: 'Extension Four', position: 'bottom' })

    const tabs: SettingsTabEntry[] = [
      { id: 'account', shortName: 'Account', tabName: 'Account', tabDescription: 'Account', tabIcon: (() => null) as never, keywords: [], component: () => null },
      { id: 'display', shortName: 'Display', tabName: 'Display', tabDescription: 'Display', tabIcon: (() => null) as never, keywords: [], component: () => null },
      { id: 'chat', shortName: 'Chat', tabName: 'Chat', tabDescription: 'Chat', tabIcon: (() => null) as never, keywords: [], component: () => null },
    ]

    const joined = joinExtensionSettingsTabs(tabs)
    expect(joined.map((t) => t.id)).toEqual([
      'ext-three',
      'account',
      'ext-one',
      'display',
      'ext-two',
      'chat',
      'ext-four',
    ])
  })
})
