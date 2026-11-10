/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from 'bun:test'
import type { AppStore } from '@/types/store'
import { createGenerationSlice } from './generation'
import { createSettingsSlice, resetSettingsPersistence } from './settings'

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
})

describe('landingPinFavorites startup hydration', () => {
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
