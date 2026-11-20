/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from 'bun:test'
import type { AppStore, StartupSettings } from '@/types/store'
import { createGenerationSlice } from './generation'
import { createSettingsSlice, DATA_KEYS, resetSettingsPersistence } from './settings'

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

describe('default impersonation mode startup hydration', () => {
  test('starts as one-liner and accepts every supported account default', () => {
    const app = store()
    expect(DATA_KEYS.has('defaultImpersonationMode')).toBe(true)
    expect(app.defaultImpersonationMode).toBe('oneliner')

    for (const mode of ['prompts', 'preset', 'oneliner'] as const) {
      app.hydrateStartupSettings({ defaultImpersonationMode: mode })
      expect(app.defaultImpersonationMode).toBe(mode)
    }
  })

  test('keeps the safe default for absent or invalid values', () => {
    for (const value of [undefined, 'invalid', '', 42, null, true]) {
      const app = store()
      app.hydrateStartupSettings({ defaultImpersonationMode: value } as StartupSettings)
      expect(app.defaultImpersonationMode).toBe('oneliner')
    }
  })
})
