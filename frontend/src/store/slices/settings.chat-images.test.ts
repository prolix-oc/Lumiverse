import { afterEach, expect, test } from 'bun:test'
import type { AppStore } from '@/types/store'
import { settingsApi } from '@/api/settings'
import { createGenerationSlice } from './generation'
import { createSettingsSlice, DATA_KEYS, flushSettingsNow, resetSettingsPersistence } from './settings'
import { chatImagePresentationStyle } from '@/lib/chatImagePresentation'

const original = { getAll: settingsApi.getAll, putMany: settingsApi.putMany }
function store(): AppStore {
  const state = {} as AppStore
  const set = (value: Partial<AppStore> | ((s: AppStore) => Partial<AppStore>)) => Object.assign(state, typeof value === 'function' ? value(state) : value)
  const get = () => state
  Object.assign(state, createGenerationSlice(set as never, get, {} as never), createSettingsSlice(set as never, get, {} as never))
  return state
}
function database(rows: Map<string, unknown>) {
  settingsApi.getAll = async () => [...rows].map(([key, value]) => ({ key, value, updated_at: 1 }))
  settingsApi.putMany = async values => {
    for (const [key, value] of Object.entries(values)) rows.set(key, value)
    return Object.entries(values).map(([key, value]) => ({ key, value, updated_at: 1 }))
  }
}
afterEach(() => {
  resetSettingsPersistence()
  localStorage.removeItem('__lumiverse_pending_settings')
  Object.assign(settingsApi, original)
})

test('defaults leave existing image sizing and inline placement untouched', () => {
  const app = store()
  expect(DATA_KEYS.has('chatImageSize')).toBe(true)
  expect(DATA_KEYS.has('chatImageAlignment')).toBe(true)
  expect(app.chatImageSize).toBe('default')
  expect(app.chatImageAlignment).toBe('left')
  expect(DATA_KEYS.has('chatImageTargets')).toBe(true)
  expect(app.chatImageTargets).toEqual({ markdown: true, html: true, attachments: true })
  expect(chatImagePresentationStyle(app.chatImageSize, app.chatImageAlignment)).toEqual({})
})

test('all presets and alignments persist through the real settings pipeline', async () => {
  const rows = new Map<string, unknown>()
  database(rows)
  for (const size of ['100', '75', '50', 'default'] as const) {
    for (const alignment of ['left', 'center', 'right'] as const) {
      const app = store()
      await app.loadSettings()
      app.setSetting('chatImageSize', size)
      app.setSetting('chatImageAlignment', alignment)
      await flushSettingsNow()
      const restored = store()
      await restored.loadSettings()
      expect(restored.chatImageSize).toBe(size)
      expect(restored.chatImageAlignment).toBe(alignment)
    }
  }
})

test('invalid stored and recovery values cannot become CSS dimensions', async () => {
  const rows = new Map<string, unknown>([['chatImageSize', '75'], ['chatImageAlignment', 'right']])
  database(rows)
  localStorage.setItem('__lumiverse_pending_settings', JSON.stringify({ chatImageSize: '900%', chatImageAlignment: 'middle' }))
  const app = store()
  await app.loadSettings()
  expect(app.chatImageSize).toBe('75')
  expect(app.chatImageAlignment).toBe('right')
  resetSettingsPersistence()
  localStorage.removeItem('__lumiverse_pending_settings')
  for (const invalid of [null, 75, {}, ['50'], '75%', 'auto']) {
    rows.set('chatImageSize', invalid)
    rows.set('chatImageAlignment', invalid)
    const restored = store()
    await restored.loadSettings()
    expect(restored.chatImageSize).toBe('default')
    expect(restored.chatImageAlignment).toBe('left')
  }
})

test('a preference changed during account loading wins over the stale response', async () => {
  let resolve!: (rows: Awaited<ReturnType<typeof settingsApi.getAll>>) => void
  settingsApi.getAll = () => new Promise(done => { resolve = done })
  const app = store()
  const loading = app.loadSettings()
  app.setSetting('chatImageSize', '50')
  app.setSetting('chatImageAlignment', 'center')
  app.setSetting('chatImageTargets', { markdown: false, html: true, attachments: false })
  resolve([{ key: 'chatImageSize', value: '100', updated_at: 1 }, { key: 'chatImageAlignment', value: 'left', updated_at: 1 }, { key: 'chatImageTargets', value: { markdown: true, html: true, attachments: true }, updated_at: 1 }])
  await loading
  expect(app.chatImageSize).toBe('50')
  expect(app.chatImageAlignment).toBe('center')
  expect(app.chatImageTargets).toEqual({ markdown: false, html: true, attachments: false })
})


test('every target combination persists independently without losing size or alignment', async () => {
  const rows = new Map<string, unknown>([['chatImageSize', '75'], ['chatImageAlignment', 'center']])
  database(rows)
  const app = store()
  await app.loadSettings()
  expect(app.chatImageTargets).toEqual({ markdown: true, html: true, attachments: true })
  for (let mask = 0; mask < 8; mask++) {
    const targets = { markdown: !!(mask & 1), html: !!(mask & 2), attachments: !!(mask & 4) }
    app.setSetting('chatImageTargets', targets)
    await flushSettingsNow()
    const restored = store()
    await restored.loadSettings()
    expect(restored.chatImageTargets).toEqual(targets)
    expect(restored.chatImageSize).toBe('75')
    expect(restored.chatImageAlignment).toBe('center')
  }
})

test('malformed target preferences cannot partially disable image types', async () => {
  for (const value of [null, [], {}, { markdown: false }, { markdown: false, html: 'false', attachments: true }]) {
    resetSettingsPersistence()
    database(new Map([['chatImageTargets', value]]))
    const app = store()
    await app.loadSettings()
    expect(app.chatImageTargets).toEqual({ markdown: true, html: true, attachments: true })
  }
  const saved = { markdown: false, html: true, attachments: false }
  database(new Map([['chatImageTargets', saved]]))
  localStorage.setItem('__lumiverse_pending_settings', JSON.stringify({ chatImageTargets: { markdown: 'false' } }))
  const app = store()
  await app.loadSettings()
  expect(app.chatImageTargets).toEqual(saved)
})
