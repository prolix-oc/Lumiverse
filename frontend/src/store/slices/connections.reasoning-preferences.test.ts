import { applyOrganizationEdits } from '../../../../src/shared/connection-organization-edits'
/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ConnectionProfile } from '@/types/api'
import type { AppStore, ReasoningSettings } from '@/types/store'
import { settingsApi } from '@/api/settings'
import { createConnectionsSlice } from './connections'
import { createGenerationSlice } from './generation'
import { createSettingsSlice, flushSettingsNow, REASONING_DEFAULTS, resetSettingsPersistence } from './settings'

const originalFetch = globalThis.fetch
const originalApi = { ...settingsApi }
let rows: Map<string, unknown>

function profile(id: string, extras: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id,
    name: id,
    provider: 'openai',
    api_url: 'https://api.openai.com/v1',
    model: 'test-model',
    preset_id: null,
    is_default: false,
    has_api_key: false,
    metadata: {},
    created_at: 1,
    updated_at: 1,
    ...extras,
  }
}

const preferred: ReasoningSettings = {
  ...REASONING_DEFAULTS,
  apiReasoning: true,
  reasoningEffort: 'max',
  prefix: '<thinking>',
  suffix: '</thinking>',
  keepInHistory: -1,
  thinkingDisplay: 'summarized',
  clearThinking: false,
  replayThoughtSignatures: true,
  customBody: { enabled: true, rawJson: '{"temperature":0.5}' },
}
const bound: ReasoningSettings = { ...REASONING_DEFAULTS, apiReasoning: true, reasoningEffort: 'low' }
const profiles = [
  profile('unbound'),
  profile('bound', { metadata: { reasoningBindings: { settings: bound } } }),
  profile('other-bound', { metadata: { reasoningBindings: { settings: { ...bound, reasoningEffort: 'medium' } } } }),
  profile('google', { provider: 'google', model: 'gemini-test' }),
  profile('moonshot', { provider: 'moonshot', model: 'kimi-test' }),
]

function store(): AppStore {
  const state = {} as AppStore
  const set = (patch: Partial<AppStore> | ((current: AppStore) => Partial<AppStore>)) => {
    Object.assign(state, typeof patch === 'function' ? patch(state) : patch)
  }
  const get = () => state
  Object.assign(state, createGenerationSlice(set as never, get, {} as never))
  Object.assign(state, createSettingsSlice(set as never, get, {} as never))
  Object.assign(state, createConnectionsSlice(set as never, get, {} as never))
  state.setProfiles(profiles)
  return state
}

beforeEach(() => {
  rows = new Map()
  globalThis.fetch = (async (_input, init) => {
    const next = applyOrganizationEdits(Object.fromEntries(rows), JSON.parse(String(init?.body)))
    for (const [key, value] of Object.entries(next)) rows.set(key, value)
    return Response.json(next)
  }) as typeof fetch
  settingsApi.getAll = async () => [...rows].map(([key, value]) => ({ key, value, updated_at: 1 }))
  settingsApi.put = async (key, value) => {
    rows.set(key, value)
    return { key, value, updated_at: 1 }
  }
  settingsApi.putMany = async (values) => {
    for (const [key, value] of Object.entries(values)) rows.set(key, value)
    return Object.entries(values).map(([key, value]) => ({ key, value, updated_at: 1 }))
  }
})

afterEach(async () => {
  await flushSettingsNow()
  resetSettingsPersistence()
  Object.assign(settingsApi, originalApi)
  globalThis.fetch = originalFetch
})

describe('unbound reasoning preferences', () => {
  test('captures legacy unbound settings and restores them after multiple bound connections', async () => {
    const app = store()
    app.reasoningSettings = { ...preferred }
    app.setActiveProfile('bound')
    expect(app.reasoningSettings).toEqual(bound)
    expect(app.unboundReasoningSettings).toEqual(preferred)

    app.setActiveProfile('other-bound')
    app.setSetting('reasoningSettings', { ...bound, reasoningEffort: 'high' })
    expect(app.unboundReasoningSettings).toEqual(preferred)

    app.setActiveProfile('unbound')
    expect(app.reasoningSettings).toEqual(preferred)
    await flushSettingsNow()
    expect(rows.get('unboundReasoningSettings')).toEqual(preferred)
    expect(rows.get('reasoningSettings')).toEqual(preferred)
  })

  test('updates the preference on unbound edits, including disabling reasoning', async () => {
    const app = store()
    app.setActiveProfile('unbound')
    app.setSetting('reasoningSettings', preferred)
    app.setActiveProfile('bound')
    app.setActiveProfile('unbound')
    expect(app.reasoningSettings).toEqual(preferred)

    const disabled = { ...preferred, apiReasoning: false, reasoningEffort: 'auto' as const }
    app.setSetting('reasoningSettings', disabled)
    app.setActiveProfile('bound')
    app.setActiveProfile('unbound')
    expect(app.reasoningSettings).toEqual(disabled)
    await flushSettingsNow()
    expect(rows.get('unboundReasoningSettings')).toEqual(disabled)
  })

  test('normalizes for each provider without losing the preferred effort when editing other fields', () => {
    const app = store()
    app.setActiveProfile('unbound')
    app.setSetting('reasoningSettings', preferred)
    app.setActiveProfile('google')
    expect(app.reasoningSettings.reasoningEffort).toBe('high')
    expect(app.unboundReasoningSettings).toEqual(preferred)

    app.setSetting('reasoningSettings', { ...app.reasoningSettings, keepInHistory: 3 })
    app.setActiveProfile('moonshot')
    expect(app.reasoningSettings.apiReasoning).toBe(true)
    expect(app.reasoningSettings.reasoningEffort).toBe('auto')
    app.setActiveProfile('bound')
    app.setActiveProfile('unbound')
    expect(app.reasoningSettings).toEqual({ ...preferred, keepInHistory: 3 })
  })

  test('restores a saved preference after reloading while a bound connection is selected', async () => {
    const app = store()
    app.setSetting('reasoningSettings', preferred)
    app.setActiveProfile('bound')
    await flushSettingsNow()
    resetSettingsPersistence()

    const restored = store()
    restored.hydrateStartupSettings({ activeProfileId: 'bound' })
    await flushSettingsNow()
    expect(rows.get('unboundReasoningSettings')).toEqual(preferred)
    await restored.loadSettings()
    expect(restored.reasoningSettings).toEqual(bound)
    expect(restored.unboundReasoningSettings).toEqual(preferred)
    restored.setActiveProfile('unbound')
    expect(restored.reasoningSettings).toEqual(preferred)
  })

  test('restores defaults for an existing bound connection with no saved unbound preference', async () => {
    rows.set('activeProfileId', 'bound')
    rows.set('reasoningSettings', bound)
    const app = store()
    await app.loadSettings()
    expect(app.unboundReasoningSettings).toBeNull()
    app.setActiveProfile('unbound')
    expect(app.reasoningSettings).toEqual(REASONING_DEFAULTS)
  })

  test('removing the active bound profile restores the preference', () => {
    const app = store()
    app.setSetting('reasoningSettings', preferred)
    app.setActiveProfile('bound')
    app.removeProfile('bound')
    expect(app.activeProfileId).toBeNull()
    expect(app.reasoningSettings).toEqual(preferred)
  })

  test('invalidating a bound profile restores the preference after its metadata is removed', () => {
    const app = store()
    app.setSetting('reasoningSettings', preferred)
    app.setActiveProfile('bound')
    app.setProfiles([profile('unbound')])
    expect(app.activeProfileId).toBeNull()
    expect(app.reasoningSettings).toEqual(preferred)
  })

  test('clearing the selection preserves effort levels without applying a generic provider scale', () => {
    const app = store()
    const xhigh = { ...preferred, reasoningEffort: 'xhigh' as const }
    app.setSetting('reasoningSettings', xhigh)
    app.setActiveProfile('bound')
    app.setActiveProfile(null)
    expect(app.reasoningSettings).toEqual(xhigh)
  })

  test('a settings reload does not capture incoming bound settings as a legacy unbound preference', async () => {
    const app = store()
    app.hydrateStartupSettings({ activeProfileId: 'unbound' })
    app.fullSettingsLoaded = true
    rows.set('activeProfileId', 'bound')
    rows.set('reasoningSettings', bound)
    await app.loadSettings()
    expect(app.unboundReasoningSettings).toBeNull()
    app.setActiveProfile('unbound')
    expect(app.reasoningSettings).toEqual(REASONING_DEFAULTS)
  })

  test('serializes a connection switch after an in-flight unbound edit', async () => {
    const app = store()
    app.setSetting('reasoningSettings', preferred)
    const putMany = settingsApi.putMany
    let release!: () => void
    const delayed = new Promise<void>((resolve) => { release = resolve })
    let writes = 0
    settingsApi.putMany = async (values) => {
      if (++writes === 1) await delayed
      return putMany(values)
    }
    const saving = flushSettingsNow()
    app.setActiveProfile('bound')
    expect(app.reasoningSettings).toEqual(bound)
    release()
    await saving
    await flushSettingsNow()
    expect(rows.get('reasoningSettings')).toEqual(bound)
    expect(rows.get('unboundReasoningSettings')).toEqual(preferred)
  })
})
