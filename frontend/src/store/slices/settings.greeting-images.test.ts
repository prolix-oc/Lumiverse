/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from 'bun:test'
import type { AppStore, StartupSettings } from '@/types/store'
import { settingsApi } from '@/api/settings'
import { createGenerationSlice } from './generation'
import { createSettingsSlice, DATA_KEYS, flushSettingsNow, resetSettingsPersistence } from './settings'

const original = { getAll: settingsApi.getAll, putMany: settingsApi.putMany }

function store(): AppStore {
  const state = {} as AppStore
  const set = (value: Partial<AppStore> | ((current: AppStore) => Partial<AppStore>)) =>
    Object.assign(state, typeof value === 'function' ? value(state) : value)
  const get = () => state
  Object.assign(state, createGenerationSlice(set as never, get, {} as never))
  Object.assign(state, createSettingsSlice(set as never, get, {} as never))
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
  settingsApi.getAll = original.getAll
  settingsApi.putMany = original.putMany
})

describe('greeting image preferences', () => {
  test('starts disabled and places artwork above the greeting when enabled', () => {
    const app = store()
    expect(DATA_KEYS.has('showGreetingImage')).toBe(true)
    expect(DATA_KEYS.has('greetingImagePosition')).toBe(true)
    expect(app.showGreetingImage).toBe(false)
    expect(app.greetingImagePosition).toBe('top')
  })

  test('persists opt-in and placement, retaining placement while disabled', async () => {
    const rows = new Map<string, unknown>()
    database(rows)
    const first = store()
    first.setSetting('showGreetingImage', true)
    first.setSetting('greetingImagePosition', 'bottom')
    await flushSettingsNow()

    const restored = store()
    await restored.loadSettings()
    expect(restored.showGreetingImage).toBe(true)
    expect(restored.greetingImagePosition).toBe('bottom')

    restored.setSetting('showGreetingImage', false)
    await flushSettingsNow()
    const disabled = store()
    await disabled.loadSettings()
    expect(disabled.showGreetingImage).toBe(false)
    expect(disabled.greetingImagePosition).toBe('bottom')
  })

  test('applies startup preferences before the full settings load without writing them', async () => {
    const rows = new Map<string, unknown>()
    database(rows)
    const app = store()
    app.hydrateStartupSettings({ showGreetingImage: true, greetingImagePosition: 'bottom' })
    expect(app.showGreetingImage).toBe(true)
    expect(app.greetingImagePosition).toBe('bottom')
    await flushSettingsNow()
    expect(rows.size).toBe(0)
  })

  test('rejects invalid startup and saved values so malformed preferences cannot opt in', async () => {
    for (const [showGreetingImage, greetingImagePosition] of [
      ['true', 'middle'], [1, null], [null, 0], [{ enabled: true }, ['top']],
    ]) {
      const app = store()
      app.hydrateStartupSettings({ showGreetingImage, greetingImagePosition } as unknown as StartupSettings)
      expect(app.showGreetingImage).toBe(false)
      expect(app.greetingImagePosition).toBe('top')

      database(new Map<string, unknown>([['showGreetingImage', showGreetingImage], ['greetingImagePosition', greetingImagePosition]]))
      await app.loadSettings()
      expect(app.showGreetingImage).toBe(false)
      expect(app.greetingImagePosition).toBe('top')
    }
  })

  test('ignores malformed recovery values and preserves valid account preferences', async () => {
    const rows = new Map<string, unknown>([['showGreetingImage', false], ['greetingImagePosition', 'bottom']])
    database(rows)
    localStorage.setItem('__lumiverse_pending_settings', JSON.stringify({ showGreetingImage: 'true', greetingImagePosition: 'middle' }))
    const app = store()
    await app.loadSettings()
    await flushSettingsNow()
    expect(app.showGreetingImage).toBe(false)
    expect(app.greetingImagePosition).toBe('bottom')
    expect(rows.get('showGreetingImage')).toBe(false)
    expect(rows.get('greetingImagePosition')).toBe('bottom')
  })

  test('keeps explicit settings changes made while account settings are loading', async () => {
    const rows = [{ key: 'showGreetingImage', value: false, updated_at: 1 }, { key: 'greetingImagePosition', value: 'top', updated_at: 1 }]
    let resolveRows!: (value: typeof rows) => void
    settingsApi.getAll = () => new Promise(resolve => { resolveRows = resolve })
    const app = store()
    const loading = app.loadSettings()
    app.setSetting('showGreetingImage', true)
    app.setSetting('greetingImagePosition', 'bottom')
    resolveRows(rows)
    await loading
    expect(app.showGreetingImage).toBe(true)
    expect(app.greetingImagePosition).toBe('bottom')
  })

  test('automatic reconciliation during loading does not outrank account preferences', async () => {
    const rows = [{ key: 'showGreetingImage', value: false, updated_at: 1 }, { key: 'greetingImagePosition', value: 'top', updated_at: 1 }]
    let resolveRows!: (value: typeof rows) => void
    settingsApi.getAll = () => new Promise(resolve => { resolveRows = resolve })
    const app = store()
    const loading = app.loadSettings()
    app.setSetting('showGreetingImage', true, 'automatic-sync')
    app.setSetting('greetingImagePosition', 'bottom', 'automatic-sync')
    resolveRows(rows)
    await loading
    expect(app.showGreetingImage).toBe(false)
    expect(app.greetingImagePosition).toBe('top')
  })
})
