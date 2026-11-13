import { beforeEach, expect, mock, test } from 'bun:test'
import { createStore } from 'zustand/vanilla'
import { JSDOM } from 'jsdom'
import type { ExtensionInfo } from 'lumiverse-spindle-types'
import type { SpindleSlice } from '@/types/store'

const dom = new JSDOM('', { url: 'http://localhost/' })
Object.assign(globalThis, { window: dom.window, CustomEvent: dom.window.CustomEvent })
let failed = false
let extension: ExtensionInfo
mock.module('@/api/spindle', () => ({ spindleApi: {
  setPermissions: async () => { if (failed) throw new Error('Request failed'); return { granted: [] } },
  remove: async () => { if (failed) throw new Error('Request failed') },
  clearManifestCache() {},
  list: async () => ({ extensions: [extension], isPrivileged: true }),
} }))
mock.module('@/lib/spindle/loader', () => ({ loadFrontendExtension: async () => {}, unloadFrontendExtension: async () => {} }))
mock.module('@/ws/client', () => ({ wsClient: { send() {} } }))
mock.module('@/lib/low-priority-task', () => ({ scheduleLowPriorityTask: (task: () => void) => task() }))
mock.module('@/lib/spindle/browser-scheduler', () => ({ yieldToBrowser: async () => {} }))
const { createSpindleSlice } = await import('./spindle')
const { systemAudioConsent } = await import('@/lib/spindle/system-audio-consent')
let nextId = 0

beforeEach(() => {
  failed = false
  extension = {
    id: `removed-audio-${++nextId}`, identifier: 'visualizer', name: 'Visualizer', version: '1',
    enabled: false, has_frontend: true, has_backend: false, status: 'stopped',
    author: 'Test', description: '', github: '', homepage: '', permissions: ['system_audio'],
    granted_permissions: ['system_audio'], installed_at: 0, updated_at: 0, metadata: {},
  }
})

function setup() {
  const store = createStore<SpindleSlice & { user: { id: string } }>((...args) => ({
    ...createSpindleSlice(...args), user: { id: 'alice' },
  }))
  store.setState({ extensions: [extension] })
  systemAudioConsent.remember('alice', extension.id)
  systemAudioConsent.remember('bob', extension.id)
  return store
}

test('revoking permission for an unloaded extension clears only the current account approval', async () => {
  const store = setup()
  await store.getState().revokePermission(extension.id, 'system_audio')
  expect(systemAudioConsent.read('alice', extension.id).remembered).toBe(false)
  expect(systemAudioConsent.read('bob', extension.id).remembered).toBe(true)
})

test('uninstalling clears consent even when the extension has no live frontend', async () => {
  const store = setup()
  await store.getState().removeExtension(extension.id)
  expect(systemAudioConsent.read('alice', extension.id).remembered).toBe(false)
  expect(store.getState().extensions).toHaveLength(0)
})

test('loading a list with revoked permission clears stale approval before frontend hydration', async () => {
  const store = setup()
  extension = { ...extension, granted_permissions: [] }
  await store.getState().loadExtensions()
  expect(systemAudioConsent.read('alice', extension.id).remembered).toBe(false)
  expect(systemAudioConsent.read('bob', extension.id).remembered).toBe(true)
})

test('failed permission or uninstall requests retain the existing approval', async () => {
  const store = setup()
  failed = true
  await expect(store.getState().revokePermission(extension.id, 'system_audio')).rejects.toThrow('Request failed')
  await expect(store.getState().removeExtension(extension.id)).rejects.toThrow('Request failed')
  expect(systemAudioConsent.read('alice', extension.id).remembered).toBe(true)
})
