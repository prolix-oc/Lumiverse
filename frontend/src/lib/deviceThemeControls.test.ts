import { afterEach, beforeEach, expect, test } from 'bun:test'
import { DEFAULT_THEME } from '@/theme/presets'
import { createThemePack, decodeThemePackArchive, encodeThemePackArchive } from './themePack'
import {
  activeDeviceThemeControls, resetDeviceThemeControls, resolveDeviceTheme,
  setDeviceThemeControlsEnabled, setDeviceThemeControlsScope, themeControls,
  updateDeviceThemeControls, useDeviceThemeControls,
} from './deviceThemeControls'

const storage = new Map<string, string>()
const originalStorage = globalThis.localStorage
beforeEach(() => {
  storage.clear()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
  } })
  setDeviceThemeControlsScope('alice')
})
afterEach(() => {
  setDeviceThemeControlsScope(null)
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage })
})

const active = () => activeDeviceThemeControls(useDeviceThemeControls.getState())

test('seeds from the theme and keeps device edits separate from authored theme data', () => {
  const theme = { ...DEFAULT_THEME, fontScale: 1.2, uiScale: 1.1 }
  setDeviceThemeControlsEnabled(true, theme)
  expect(active()).toEqual(themeControls(theme))
  updateDeviceThemeControls({ fontScale: 0.9, uiScale: 0.75, enableGlass: false }, theme)
  expect(resolveDeviceTheme(theme, active())).toMatchObject({ fontScale: 0.9, uiScale: 0.75, enableGlass: false })
  expect(theme).toMatchObject({ fontScale: 1.2, uiScale: 1.1 })
  // Server refreshes and preset changes cannot replace device values.
  expect(resolveDeviceTheme({ ...theme, uiScale: 1.5 }, active()).uiScale).toBe(0.75)
  expect([...storage.keys()]).toEqual(['lumiverse.device-theme-controls:alice'])
})

test('reloads synchronously, isolates accounts, and remembers disabled device values', () => {
  setDeviceThemeControlsEnabled(true, DEFAULT_THEME)
  updateDeviceThemeControls({ uiScale: 0.75 }, DEFAULT_THEME)
  setDeviceThemeControlsScope('bob')
  expect(active()).toBeNull()
  setDeviceThemeControlsEnabled(true, { ...DEFAULT_THEME, uiScale: 1.2 })
  setDeviceThemeControlsScope('alice')
  expect(active()?.uiScale).toBe(0.75)
  setDeviceThemeControlsEnabled(false, DEFAULT_THEME)
  expect(resolveDeviceTheme(DEFAULT_THEME, active())).toBe(DEFAULT_THEME)
  setDeviceThemeControlsScope(null)
  expect(active()).toBeNull()
  setDeviceThemeControlsScope('alice')
  expect(active()).toBeNull()
  setDeviceThemeControlsEnabled(true, DEFAULT_THEME)
  expect(active()?.uiScale).toBe(0.75)
})

test('a different device starts from theme values and reset explicitly adopts the current theme', () => {
  setDeviceThemeControlsEnabled(true, DEFAULT_THEME)
  updateDeviceThemeControls({ uiScale: 0.75 }, DEFAULT_THEME)
  storage.clear() // An independent browser has no device snapshot.
  setDeviceThemeControlsScope(null)
  setDeviceThemeControlsScope('alice')
  expect(active()).toBeNull()
  const theme = { ...DEFAULT_THEME, uiScale: 1.1 }
  setDeviceThemeControlsEnabled(true, theme)
  expect(active()?.uiScale).toBe(1.1)
  resetDeviceThemeControls({ ...theme, uiScale: 0.8 })
  expect(active()?.uiScale).toBe(0.8)
})

test('rejects corrupt snapshots and normalizes malformed scales', () => {
  for (const value of ['{', 'null', '{"version":2,"enabled":true,"controls":{}}', '{"version":1,"controls":[]}']) {
    storage.set('lumiverse.device-theme-controls:bob', value)
    setDeviceThemeControlsScope('bob')
    expect(active()).toBeNull()
    setDeviceThemeControlsScope('alice')
  }
  expect(themeControls({ uiScale: 4, fontScale: NaN, radiusScale: -2 })).toMatchObject({
    uiScale: 1.5, fontScale: DEFAULT_THEME.fontScale, radiusScale: 0.5,
  })
})

test('storage failures keep controls functional in memory, and unauthenticated writes do nothing', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('blocked') } })
  setDeviceThemeControlsScope('blocked')
  setDeviceThemeControlsEnabled(true, DEFAULT_THEME)
  updateDeviceThemeControls({ uiScale: 0.8 }, DEFAULT_THEME)
  setDeviceThemeControlsScope('blocked') // Repeated scope selection cannot discard session edits.
  expect(active()?.uiScale).toBe(0.8)
  setDeviceThemeControlsScope(null)
  setDeviceThemeControlsEnabled(true, DEFAULT_THEME)
  expect(active()).toBeNull()
})

test('theme archives retain authored controls until device values are explicitly copied into the theme', () => {
  const theme = { ...DEFAULT_THEME, uiScale: 1.1 }
  setDeviceThemeControlsEnabled(true, theme)
  updateDeviceThemeControls({ uiScale: 0.75, fontScale: 0.9 }, theme)
  const roundTrip = (config: typeof theme) => decodeThemePackArchive(encodeThemePackArchive(createThemePack(
    config, { css: '', enabled: false, revision: 0, bundleId: null }, {}, [],
  )))
  const authored = roundTrip(theme)
  expect(authored.error).toBeUndefined()
  expect(authored.pack?.theme?.uiScale).toBe(1.1)
  const copied = { ...theme, ...active()! }
  const baked = roundTrip(copied)
  expect(baked.error).toBeUndefined()
  expect(baked.pack?.theme).toMatchObject({ uiScale: 0.75, fontScale: 0.9 })
  // An imported archive supplies defaults without overwriting existing local preferences.
  expect(resolveDeviceTheme(authored.pack!.theme, active()).uiScale).toBe(0.75)
})
