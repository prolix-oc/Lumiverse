import { afterEach, expect, test } from 'bun:test'
import type { AppStore } from '@/types/store'
import { settingsApi } from '@/api/settings'
import { createGenerationSlice } from './generation'
import { createSettingsSlice, flushSettingsNow, resetSettingsPersistence } from './settings'

const original = { getAll: settingsApi.getAll, putMany: settingsApi.putMany }
function store(): AppStore {
  const state = {} as AppStore
  const set = (partial: Partial<AppStore> | ((current: AppStore) => Partial<AppStore>)) =>
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  Object.assign(state, createGenerationSlice(set as never, () => state, {} as never))
  Object.assign(state, createSettingsSlice(set as never, () => state, {} as never))
  return state
}
afterEach(() => {
  resetSettingsPersistence()
  localStorage.removeItem('__lumiverse_pending_settings')
  settingsApi.getAll = original.getAll
  settingsApi.putMany = original.putMany
})

test('defaults legacy settings to enabled and preserves an explicit opt-out through startup hydration', () => {
  const app = store()
  expect(app.drawerSettings.duoAlwaysOpen).toBe(true)
  const { duoAlwaysOpen: _legacyOmitted, ...legacy } = app.drawerSettings
  app.hydrateStartupSettings({ drawerSettings: { ...legacy, side: 'left' } })
  expect(app.drawerSettings.duoAlwaysOpen).toBe(true)
  app.hydrateStartupSettings({ drawerSettings: { ...app.drawerSettings, duoAlwaysOpen: false } })
  expect(app.drawerSettings.duoAlwaysOpen).toBe(false)
  expect(app.drawerSettings.side).toBe('left')
})

test('persists both toggle directions alongside the other drawer settings', async () => {
  const rows = new Map<string, unknown>()
  settingsApi.getAll = async () => [...rows].map(([key, value]) => ({ key, value, updated_at: 1 }))
  settingsApi.putMany = async batch => {
    for (const [key, value] of Object.entries(batch)) rows.set(key, value)
    return Object.entries(batch).map(([key, value]) => ({ key, value, updated_at: 1 }))
  }
  const first = store()
  first.setSetting('drawerSettings', { ...first.drawerSettings, side: 'left', duoAlwaysOpen: false })
  await flushSettingsNow()
  const restored = store()
  await restored.loadSettings()
  expect(restored.drawerSettings.duoAlwaysOpen).toBe(false)
  expect(restored.drawerSettings.side).toBe('left')
  restored.setSetting('drawerSettings', { ...restored.drawerSettings, duoAlwaysOpen: true })
  await flushSettingsNow()
  const enabled = store()
  await enabled.loadSettings()
  expect(enabled.drawerSettings.duoAlwaysOpen).toBe(true)
  expect(enabled.drawerSettings.side).toBe('left')
})
