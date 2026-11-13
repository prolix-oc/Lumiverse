/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from 'bun:test'
import type { AppStore, StartupSettings, ToastPosition } from '@/types/store'
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

describe('toastPosition startup hydration', () => {
  test('applies the startup position together with settingsLoaded', () => {
    const app = store()
    expect(app.toastPosition).toBe('bottom-right')
    expect(app.settingsLoaded).toBe(false)

    app.hydrateStartupSettings({ toastPosition: 'top-left' })

    expect(app.toastPosition).toBe('top-left')
    expect(app.settingsLoaded).toBe(true)
  })

  test('accepts every ToastPosition value', () => {
    const positions: ToastPosition[] = [
      'top-right', 'top-left', 'bottom-right', 'bottom-left', 'top', 'bottom',
    ]
    for (const position of positions) {
      const app = store()
      app.hydrateStartupSettings({ toastPosition: position })
      expect(app.toastPosition).toBe(position)
    }
  })

  test('keeps the default for absent or invalid values', () => {
    const absent = store()
    absent.hydrateStartupSettings({})
    expect(absent.toastPosition).toBe('bottom-right')
    expect(absent.settingsLoaded).toBe(true)

    const invalid: unknown[] = ['bottom-center', '', 42, null, true, ['top'], { position: 'top' }]
    for (const value of invalid) {
      const app = store()
      app.hydrateStartupSettings({ toastPosition: value } as StartupSettings)
      expect(app.toastPosition).toBe('bottom-right')
    }
  })
})
