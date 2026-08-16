/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { StoreApi } from 'zustand'
import type { ConnectionProfile } from '@/types/api'
import type { AppStore, StartupSettings } from '@/types/store'

// Sibling files mock `@/api/client` without BASE_URL and bun freezes that
// export list. Avoid loading ./settings (it named-imports BASE_URL).
const reasoningDefaults = {
  prefix: '<think>\n',
  suffix: '\n</think>',
  autoParse: true,
  apiReasoning: false,
  reasoningEffort: 'auto' as const,
  keepInHistory: 0,
  thinkingDisplay: 'auto' as const,
}

function settingsSliceExports() {
  return {
    REASONING_DEFAULTS: reasoningDefaults,
    clearDirtyKey: () => {},
    persistKey: () => {},
    persistPendingImageGenerationPatch: () => {},
    resetSettingsPersistence: () => {},
    createSettingsSlice: (_set: unknown, get: () => AppStore) => ({
      reasoningSettings: { ...reasoningDefaults },
      hydrateStartupSettings: (settings: StartupSettings) => {
        if (!Object.prototype.hasOwnProperty.call(settings, 'activeProfileId')) return
        const raw = settings.activeProfileId
        get().setActiveProfile(raw == null || raw === '' ? null : String(raw), 'bootstrap_reconcile')
      },
    }),
  }
}

mock.module('./settings', settingsSliceExports)
mock.module('@/store/slices/settings', settingsSliceExports)

const { settingsApi } = await import('@/api/settings')
const { createConnectionsSlice, shouldPersistActiveProfileId } = await import('./connections')
const { createGenerationSlice } = await import('./generation')
const { createSettingsSlice, resetSettingsPersistence } = await import('./settings')

const originalPut = settingsApi.put
const puts: Array<[string, unknown]> = []

function profile(id: string, extras: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id,
    name: id,
    provider: 'openai',
    api_url: 'https://api.openai.com/v1',
    model: 'gpt-test',
    preset_id: null,
    is_default: false,
    has_api_key: false,
    metadata: {},
    created_at: 1,
    updated_at: 1,
    ...extras,
  }
}

function store(): AppStore {
  const state = {} as AppStore
  const set = (value: Partial<AppStore> | ((current: AppStore) => Partial<AppStore>)) => {
    Object.assign(state, typeof value === 'function' ? value(state) : value)
  }
  const get = () => state
  const api = { getState: get, setState: set, subscribe: () => () => {}, getInitialState: get } as StoreApi<AppStore>
  Object.assign(state, createGenerationSlice(set as never, get, api))
  Object.assign(state, createSettingsSlice(set as never, get, api))
  Object.assign(state, createConnectionsSlice(set as never, get, api))
  return state
}

afterEach(() => {
  puts.length = 0
  settingsApi.put = originalPut
  resetSettingsPersistence()
})

describe('connections activeProfileId persistence', () => {
  test('only ConnectionsSlice.setActiveProfile writes activeProfileId', () => {
    settingsApi.put = (async (key, value) => {
      puts.push([key, value])
      return { key, value, updated_at: 1 }
    }) as typeof settingsApi.put
    const app = store()
    app.setProfiles([profile('alpha'), profile('beta')])
    expect(app.activeProfileId).toBeNull()

    app.setActiveProfile('alpha', 'user_selection')
    expect(app.activeProfileId).toBe('alpha')
    expect(puts).toEqual([['activeProfileId', 'alpha']])

    app.setActiveProfile('alpha', 'user_selection')
    expect(puts).toHaveLength(1)

    app.hydrateStartupSettings({ activeProfileId: 'beta' })
    expect(app.activeProfileId).toBe('beta')
    expect(puts).toHaveLength(1)
  })

  test('hydrates activeProfileId before profiles arrive on cold start', () => {
    const app = store()
    app.hydrateStartupSettings({ activeProfileId: 'cold-profile' })
    expect(app.activeProfileId).toBe('cold-profile')
    expect(app.profiles).toEqual([])
    app.setProfiles([profile('cold-profile'), profile('other')])
    expect(app.activeProfileId).toBe('cold-profile')
  })

  test('persists user_selection, deletion, and invalidation but not reconcile reasons', () => {
    settingsApi.put = (async (key, value) => {
      puts.push([key, value])
      return { key, value, updated_at: 1 }
    }) as typeof settingsApi.put
    expect(shouldPersistActiveProfileId('user_selection')).toBe(true)
    expect(shouldPersistActiveProfileId('profile_deleted')).toBe(true)
    expect(shouldPersistActiveProfileId('profile_invalidated')).toBe(true)
    expect(shouldPersistActiveProfileId('bootstrap_reconcile')).toBe(false)
    expect(shouldPersistActiveProfileId('settings_reconcile')).toBe(false)

    const app = store()
    app.setProfiles([profile('keep'), profile('drop')])
    app.setActiveProfile('drop', 'bootstrap_reconcile')
    expect(puts).toEqual([])
    expect(app.activeProfileId).toBe('drop')

    app.setActiveProfile('keep', 'settings_reconcile')
    expect(puts).toEqual([])

    app.setActiveProfile('drop', 'user_selection')
    expect(puts).toEqual([['activeProfileId', 'drop']])

    app.removeProfile('drop')
    expect(app.activeProfileId).toBeNull()
    expect(puts.at(-1)).toEqual(['activeProfileId', null])

    app.setActiveProfile('keep', 'user_selection')
    app.setProfiles([profile('other')])
    expect(app.activeProfileId).toBeNull()
    expect(puts.at(-1)).toEqual(['activeProfileId', null])
  })
})
