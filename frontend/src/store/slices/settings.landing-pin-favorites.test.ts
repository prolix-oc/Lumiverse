/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from 'bun:test'
import type { AppStore } from '@/types/store'
import { settingsApi } from '@/api/settings'
import { createGenerationSlice } from './generation'
import { createSettingsSlice, flushSettingsNow, resetSettingsPersistence } from './settings'

const original = { getAll: settingsApi.getAll, putMany: settingsApi.putMany }

function database(rows: Map<string, unknown>) {
  settingsApi.getAll = async () => [...rows].map(([key, value]) => ({ key, value, updated_at: 1 }))
  settingsApi.putMany = async values => {
    for (const [key, value] of Object.entries(values)) rows.set(key, value)
    return Object.entries(values).map(([key, value]) => ({ key, value, updated_at: 1 }))
  }
}

function store(): AppStore {
  const state = {} as AppStore
  const set = (value: Partial<AppStore> | ((current: AppStore) => Partial<AppStore>)) =>
    Object.assign(state, typeof value === 'function' ? value(state) : value)
  const get = () => state
  Object.assign(state, createGenerationSlice(set as never, get, {} as never))
  Object.assign(state, createSettingsSlice(set as never, get, {} as never))
  return state
}

afterEach(() => {
  resetSettingsPersistence()
  localStorage.removeItem('__lumiverse_pending_settings')
  Object.assign(settingsApi, original)
})

describe('landingPinFavorites startup hydration', () => {
  test('full hydration rejects malformed saved and recovery values consistently with startup', async () => {
    for (const invalid of ['false', 0, 1, null, {}, []]) {
      resetSettingsPersistence()
      database(new Map([['landingPinFavorites', invalid]]))
      const app = store()
      await app.loadSettings()
      expect(app.landingPinFavorites).toBe(true)
    }
    database(new Map([['landingPinFavorites', false]]))
    localStorage.setItem('__lumiverse_pending_settings', JSON.stringify({ landingPinFavorites: 'false' }))
    const app = store()
    await app.loadSettings()
    expect(app.landingPinFavorites).toBe(false)
  })

  test('both values persist and reload without changing favorites', async () => {
    const rows = new Map<string, unknown>([['favorites', ['favorite-character']]])
    database(rows)
    for (const value of [false, true]) {
      const app = store()
      await app.loadSettings()
      app.setSetting('landingPinFavorites', value)
      await flushSettingsNow()
      const restored = store()
      await restored.loadSettings()
      expect(restored.landingPinFavorites).toBe(value)
      expect(restored.favorites).toEqual(['favorite-character'])
      expect(rows.get('landingPinFavorites')).toBe(value)
    }
  })

  test('defaults to true and hydrates boolean values only', () => {
    const app = store()
    expect(app.landingPinFavorites).toBe(true)

    app.hydrateStartupSettings({ landingPinFavorites: false })
    expect(app.landingPinFavorites).toBe(false)

    const on = store()
    on.hydrateStartupSettings({ landingPinFavorites: true })
    expect(on.landingPinFavorites).toBe(true)

    const absent = store()
    absent.hydrateStartupSettings({})
    expect(absent.landingPinFavorites).toBe(true)
    expect(absent.settingsLoaded).toBe(true)

    const invalid = store()
    invalid.hydrateStartupSettings({ landingPinFavorites: 'false' } as unknown as Parameters<typeof invalid.hydrateStartupSettings>[0])
    expect(invalid.landingPinFavorites).toBe(true)
  })
})
