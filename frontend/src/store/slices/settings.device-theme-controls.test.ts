import { afterEach, expect, test } from 'bun:test'
import type { AppStore } from '@/types/store'
import { settingsApi } from '@/api/settings'
import { DEFAULT_THEME } from '@/theme/presets'
import { activeDeviceThemeControls, setDeviceThemeControlsEnabled, updateDeviceThemeControls, useDeviceThemeControls } from '@/lib/deviceThemeControls'
import { createSettingsSlice, flushSettingsNow, resetSettingsPersistence, setSettingsPersistenceScope } from './settings'
import { createGenerationSlice } from './generation'

const original = { getAll: settingsApi.getAll, putMany: settingsApi.putMany }
const userId = 'device-theme-controls-regression'
function store(): AppStore {
  const state = {} as AppStore
  const set = (partial: Partial<AppStore> | ((current: AppStore) => Partial<AppStore>)) => Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  Object.assign(state, createGenerationSlice(set as never, () => state, {} as never))
  Object.assign(state, createSettingsSlice(set as never, () => state, {} as never))
  return state
}
afterEach(() => {
  resetSettingsPersistence()
  localStorage.removeItem(`lumiverse.device-theme-controls:${userId}`)
  settingsApi.getAll = original.getAll
  settingsApi.putMany = original.putMany
})

test('settings hydration and saved-theme application preserve local controls without syncing them', async () => {
  const rows = new Map<string, unknown>([['theme', { ...DEFAULT_THEME, uiScale: 1.1 }]])
  const writes: Record<string, unknown>[] = []
  settingsApi.getAll = async () => [...rows].map(([key, value]) => ({ key, value, updated_at: 1 }))
  settingsApi.putMany = async (batch) => {
    writes.push(batch)
    for (const [key, value] of Object.entries(batch)) rows.set(key, value)
    return Object.entries(batch).map(([key, value]) => ({ key, value, updated_at: 1 }))
  }
  setSettingsPersistenceScope(userId)
  const app = store()
  app.hydrateStartupSettings({ theme: { ...DEFAULT_THEME, uiScale: 1.1 } })
  setDeviceThemeControlsEnabled(true, app.theme)
  updateDeviceThemeControls({ uiScale: 0.75, fontScale: 0.9 }, app.theme)
  await app.loadSettings()
  expect(app.theme?.uiScale).toBe(1.1)
  expect(activeDeviceThemeControls(useDeviceThemeControls.getState())?.uiScale).toBe(0.75)
  expect(writes.some(batch => 'theme' in batch)).toBe(false)
  app.addSavedTheme({ kind: 'config', name: 'Authored theme', theme: app.theme! })
  const saved = app.savedThemes[0]
  app.setTheme({ ...DEFAULT_THEME, uiScale: 1.4 })
  app.applySavedTheme(saved.id)
  expect(app.theme?.uiScale).toBe(1.1)
  expect(activeDeviceThemeControls(useDeviceThemeControls.getState())?.uiScale).toBe(0.75)
  await app.updateSavedTheme(saved.id)
  await flushSettingsNow()
  expect(JSON.stringify(rows.get('savedThemes'))).toContain('"uiScale":1.1')
  expect([...rows.keys()].some(key => key.includes('device-theme-controls'))).toBe(false)
  resetSettingsPersistence()
  expect(activeDeviceThemeControls(useDeviceThemeControls.getState())).toBeNull()
  setSettingsPersistenceScope(userId)
  expect(activeDeviceThemeControls(useDeviceThemeControls.getState())?.uiScale).toBe(0.75)
})
