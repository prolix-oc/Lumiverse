import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { createStore } from 'zustand/vanilla'
import type { ExtensionInfo } from 'lumiverse-spindle-types'
import type { AppStore, DrawerSettings } from '@/types/store'
import { settingsApi } from '@/api/settings'
import { reconcileInstalledExtensionDrawerTabs } from '../extension-drawer-reconciliation'

const extension = (id: string, enabled = false): ExtensionInfo => ({
  id, identifier: 'example', name: 'Example', version: '1', enabled,
  has_frontend: true, has_backend: false, status: 'stopped', author: 'Test',
  description: '', github: '', homepage: '', permissions: [], granted_permissions: [],
  installed_at: 0, updated_at: 0, metadata: {},
})
const oldTab = 'spindle:old-install:tab:main:17'
const currentTab = 'spindle:current-install:tab:main'
let installed: ExtensionInfo[]
let list: () => Promise<{ extensions: ExtensionInfo[]; isPrivileged: boolean }>
let removeFails: boolean
const unload = mock(async (_id: string) => {})
mock.module('@/api/spindle', () => ({ spindleApi: {
  list: () => list(), getManifest: async () => ({}), clearManifestCache() {},
  remove: async () => { if (removeFails) throw new Error('Uninstall failed') },
} }))
mock.module('@/lib/spindle/loader', () => ({
  loadFrontendExtension: async () => {}, unloadFrontendExtension: unload,
}))
mock.module('@/ws/client', () => ({ wsClient: { send() {} } }))
mock.module('@/lib/low-priority-task', () => ({ scheduleLowPriorityTask: (task: () => void) => task() }))
mock.module('@/lib/spindle/browser-scheduler', () => ({ yieldToBrowser: async () => {} }))

const { createSpindleSlice } = await import('./spindle')
const { createGenerationSlice } = await import('./generation')
const { createSettingsSlice, flushSettingsNow, resetSettingsPersistence } = await import('./settings')
const original = { getAll: settingsApi.getAll, putMany: settingsApi.putMany }
let rows: Map<string, unknown>
let drawerWrites: DrawerSettings[]

function store() {
  return createStore<AppStore>((...args) => ({
    ...createGenerationSlice(...args), ...createSettingsSlice(...args), ...createSpindleSlice(...args),
    user: { id: 'alice' },
  } as AppStore))
}

function savedSettings(): DrawerSettings {
  return {
    ...store().getState().drawerSettings,
    side: 'left',
    layout: [{ type: 'folder', id: 'tools', name: 'Tools', children: [oldTab, currentTab, 'profile'] }],
    tabOrder: [oldTab, currentTab, 'profile'], hiddenTabIds: [oldTab, currentTab],
  }
}

beforeEach(() => {
  installed = [extension('current-install')]
  list = async () => ({ extensions: installed, isPrivileged: true })
  removeFails = false
  unload.mockClear()
  drawerWrites = []
  rows = new Map([['drawerSettings', savedSettings()]])
  settingsApi.getAll = async () => [...rows].map(([key, value]) => ({ key, value, updated_at: 1 }))
  settingsApi.putMany = async (batch) => {
    for (const [key, value] of Object.entries(batch)) rows.set(key, value)
    if (batch.drawerSettings) drawerWrites.push(batch.drawerSettings as DrawerSettings)
    return Object.entries(batch).map(([key, value]) => ({ key, value, updated_at: 1 }))
  }
})
afterEach(() => {
  resetSettingsPersistence()
  localStorage.removeItem('__lumiverse_pending_settings')
  settingsApi.getAll = original.getAll
  settingsApi.putMany = original.putMany
})

test('settings loaded first wait for the installed list, then persist cleanup while retaining a disabled extension', async () => {
  const app = store()
  await app.getState().loadSettings()
  expect(app.getState().drawerSettings.hiddenTabIds).toContain(oldTab)
  expect(drawerWrites).toHaveLength(0)

  await app.getState().loadExtensions()
  const cleaned = app.getState().drawerSettings
  expect(cleaned.side).toBe('left')
  expect(cleaned.layout).toEqual([{ type: 'folder', id: 'tools', name: 'Tools', children: [currentTab, 'profile'] }])
  expect(cleaned.tabOrder).toEqual([currentTab, 'profile'])
  expect(cleaned.hiddenTabIds).toEqual([currentTab])
  expect(unload).toHaveBeenCalledWith('current-install')
  await flushSettingsNow()
  expect(drawerWrites).toEqual([cleaned])

  await app.getState().loadExtensions()
  await flushSettingsNow()
  expect(app.getState().drawerSettings).toBe(cleaned)
  expect(drawerWrites).toHaveLength(1)
})

test('extensions loaded first preserve startup settings until the full settings snapshot arrives', async () => {
  const app = store()
  installed = [extension('current-install', true)]
  await app.getState().loadExtensions()
  app.getState().hydrateStartupSettings({ drawerSettings: savedSettings() })
  expect(app.getState().drawerSettings.hiddenTabIds).toContain(oldTab)
  await flushSettingsNow()
  expect(drawerWrites).toHaveLength(0)

  await app.getState().loadSettings()
  expect(app.getState().drawerSettings.hiddenTabIds).toEqual([currentTab])
  await flushSettingsNow()
  expect(drawerWrites).toHaveLength(1)
})

test('a pending list refresh cannot delete newly restored tab preferences', async () => {
  const app = store()
  await app.getState().loadExtensions()
  let finish!: (value: Awaited<ReturnType<typeof list>>) => void
  list = () => new Promise((resolve) => { finish = resolve })
  const loading = app.getState().loadExtensions()
  await app.getState().loadSettings()
  expect(app.getState().extensionsLoaded).toBe(false)
  expect(app.getState().drawerSettings.hiddenTabIds).toContain(oldTab)
  finish({ extensions: [extension('old-install'), extension('current-install')], isPrivileged: true })
  await loading
  expect(app.getState().drawerSettings.hiddenTabIds).toEqual([oldTab, currentTab])
  await flushSettingsNow()
  expect(drawerWrites).toHaveLength(0)
})

test('an authoritative empty list removes restored extension tabs while keeping the folder', async () => {
  const app = store()
  installed = []
  await app.getState().loadExtensions()
  await app.getState().loadSettings()
  expect(app.getState().drawerSettings.layout).toEqual([{ type: 'folder', id: 'tools', name: 'Tools', children: ['profile'] }])
  expect(app.getState().drawerSettings.hiddenTabIds).toEqual([])
})

test('uninstall prunes saved references and a later settings reload cannot bring them back', async () => {
  const app = store()
  await app.getState().loadSettings()
  await app.getState().loadExtensions()
  await flushSettingsNow()
  drawerWrites = []
  await app.getState().removeExtension('current-install')
  expect(app.getState().drawerSettings.hiddenTabIds).toEqual([])
  await flushSettingsNow()
  expect(drawerWrites).toHaveLength(1)

  rows.set('drawerSettings', savedSettings())
  await app.getState().loadSettings()
  await flushSettingsNow()
  expect(app.getState().drawerSettings.hiddenTabIds).toEqual([])
  expect((rows.get('drawerSettings') as DrawerSettings).hiddenTabIds).toEqual([])
})

test('failed uninstall preserves the installed extension preferences', async () => {
  const app = store()
  await app.getState().loadSettings()
  await app.getState().loadExtensions()
  const before = app.getState().drawerSettings
  removeFails = true
  await expect(app.getState().removeExtension('current-install')).rejects.toThrow('Uninstall failed')
  expect(app.getState().drawerSettings).toBe(before)
})

test('a refreshed list reconciles an extension removed by another client', async () => {
  const app = store()
  await app.getState().loadSettings()
  await app.getState().loadExtensions()
  await flushSettingsNow()
  drawerWrites = []
  installed = []
  await app.getState().loadExtensions()
  expect(app.getState().drawerSettings.hiddenTabIds).toEqual([])
  expect(app.getState().drawerSettings.tabOrder).toEqual(['profile'])
  await flushSettingsNow()
  expect(drawerWrites).toHaveLength(1)
})

test('confirmed uninstall prunes its owner even while an installed-list request is pending', async () => {
  const app = store()
  await app.getState().loadSettings()
  await app.getState().loadExtensions()
  let finish!: (value: Awaited<ReturnType<typeof list>>) => void
  list = () => new Promise((resolve) => { finish = resolve })
  const loading = app.getState().loadExtensions()
  expect(app.getState().extensionsLoaded).toBe(false)
  await app.getState().removeExtension('current-install')
  expect(app.getState().drawerSettings.hiddenTabIds).toEqual([])
  finish({ extensions: [], isPrivileged: true })
  await loading
  await flushSettingsNow()
  expect((rows.get('drawerSettings') as DrawerSettings).tabOrder).toEqual(['profile'])
})

test('a list response from the previous account cannot reconcile the next account', async () => {
  const app = store()
  let finish!: (value: Awaited<ReturnType<typeof list>>) => void
  list = () => new Promise((resolve) => { finish = resolve })
  const loading = app.getState().loadExtensions()
  app.setState({ user: { id: 'bob' } as AppStore['user'] })
  await app.getState().loadSettings()
  finish({ extensions: [], isPrivileged: true })
  await loading
  expect(app.getState().extensionsLoaded).toBe(false)
  expect(app.getState().drawerSettings.hiddenTabIds).toContain(oldTab)
})

test('pending settings recovery persists the reconciled value instead of the old local snapshot', async () => {
  const app = store()
  await app.getState().loadExtensions()
  localStorage.setItem('__lumiverse_pending_settings', JSON.stringify({ drawerSettings: savedSettings() }))
  await app.getState().loadSettings()
  await flushSettingsNow()
  expect((rows.get('drawerSettings') as DrawerSettings).hiddenTabIds).toEqual([currentTab])
  reconcileInstalledExtensionDrawerTabs(app.getState())
  await flushSettingsNow()
  expect(drawerWrites).toHaveLength(1)
})
