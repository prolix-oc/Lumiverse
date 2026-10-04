/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { StoreApi } from 'zustand'
import type { ConnectionProfile } from '@/types/api'
import type { AppStore, StartupSettings } from '@/types/store'
import { ApiError } from '@/api/client'

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

const bindGetCalls: string[] = []
let nextBindResult: { connection_id: string | null } | Error = { connection_id: null }
// Hold the next GET in flight until the test releases it — used to interleave
// a write while a hydration fetch is pending.
let holdNextBindGet = false
let resolveHeldBindGet: (() => void) | null = null

mock.module('@/api/character-connection-binds', () => ({
  characterConnectionBindsApi: {
    get: async (characterId: string) => {
      bindGetCalls.push(characterId)
      if (holdNextBindGet) {
        holdNextBindGet = false
        await new Promise<void>((resolve) => { resolveHeldBindGet = resolve })
      }
      if (nextBindResult instanceof Error) throw nextBindResult
      return nextBindResult
    },
    put: async (_characterId: string, connectionId: string | null) => ({ connection_id: connectionId }),
  },
}))

const { createConnectionsSlice, resetCharacterConnectionBindHydration } = await import('./connections')
const { createGenerationSlice } = await import('./generation')
const { createSettingsSlice, resetSettingsPersistence } = await import('./settings')

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

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  bindGetCalls.length = 0
  nextBindResult = { connection_id: null }
  holdNextBindGet = false
  resolveHeldBindGet = null
  resetSettingsPersistence()
  resetCharacterConnectionBindHydration()
})

describe('activeCharacterConnectionId hydration', () => {
  test('fetches the bind for the active character and memoizes per character', async () => {
    const app = store()
    app.activeCharacterId = 'char-1'
    nextBindResult = { connection_id: 'alpha' }

    app.hydrateActiveCharacterConnection('char-1')
    expect(app.activeCharacterConnectionId).toBeNull()
    await flush()
    expect(app.activeCharacterConnectionId).toBe('alpha')
    expect(bindGetCalls).toEqual(['char-1'])

    // The usual chat-open sequence calls hydration twice (setActiveChat +
    // setActiveCharacter) — only one fetch may leave.
    app.hydrateActiveCharacterConnection('char-1')
    await flush()
    expect(bindGetCalls).toEqual(['char-1'])
    expect(app.activeCharacterConnectionId).toBe('alpha')

    // Switching characters refetches and drops the old bind immediately.
    nextBindResult = { connection_id: 'beta' }
    app.activeCharacterId = 'char-2'
    app.hydrateActiveCharacterConnection('char-2')
    expect(app.activeCharacterConnectionId).toBeNull()
    await flush()
    expect(app.activeCharacterConnectionId).toBe('beta')
    expect(bindGetCalls).toEqual(['char-1', 'char-2'])
  })

  test('a stale response for a previous character is discarded', async () => {
    const app = store()
    app.activeCharacterId = 'char-1'
    nextBindResult = { connection_id: 'alpha' }

    app.hydrateActiveCharacterConnection('char-1')
    app.activeCharacterId = 'char-2'
    await flush()
    expect(app.activeCharacterConnectionId).toBeNull()
    expect(bindGetCalls).toEqual(['char-1'])
  })

  test('null character id clears the bind without fetching', async () => {
    const app = store()
    app.setActiveCharacterConnection('alpha')
    app.hydrateActiveCharacterConnection(null)
    await flush()
    expect(app.activeCharacterConnectionId).toBeNull()
    expect(bindGetCalls).toEqual([])
  })

  test('404 (unknown character) resolves to null and keeps the memo', async () => {
    const app = store()
    app.activeCharacterId = 'char-gone'
    app.setActiveCharacterConnection('alpha')
    nextBindResult = new ApiError(404, 'Not Found')

    app.hydrateActiveCharacterConnection('char-gone')
    await flush()
    expect(app.activeCharacterConnectionId).toBeNull()

    app.hydrateActiveCharacterConnection('char-gone')
    await flush()
    expect(bindGetCalls).toEqual(['char-gone'])
  })

  test('other errors keep the value and clear the memo so the next call retries', async () => {
    const app = store()
    app.activeCharacterId = 'char-1'
    nextBindResult = new ApiError(500, 'Server Error')

    app.hydrateActiveCharacterConnection('char-1')
    await flush()
    expect(app.activeCharacterConnectionId).toBeNull()

    app.hydrateActiveCharacterConnection('char-1')
    await flush()
    expect(bindGetCalls).toEqual(['char-1', 'char-1'])
  })

  test('force bypasses the memo (WS reconnect resync)', async () => {
    const app = store()
    app.activeCharacterId = 'char-1'
    nextBindResult = { connection_id: 'alpha' }

    app.hydrateActiveCharacterConnection('char-1')
    await flush()
    expect(bindGetCalls).toEqual(['char-1'])

    nextBindResult = { connection_id: 'beta' }
    app.hydrateActiveCharacterConnection('char-1', { force: true })
    await flush()
    expect(bindGetCalls).toEqual(['char-1', 'char-1'])
    expect(app.activeCharacterConnectionId).toBe('beta')
  })

  test('setActiveCharacterConnection writes the field (WS CHARACTER_CONNECTION_BIND_CHANGED path)', () => {
    const app = store()
    expect(app.activeCharacterConnectionId).toBeNull()
    app.setActiveCharacterConnection('alpha')
    expect(app.activeCharacterConnectionId).toBe('alpha')
    app.setActiveCharacterConnection(null)
    expect(app.activeCharacterConnectionId).toBeNull()
  })

  test('a write landing while the GET is in flight is not clobbered by its response', async () => {
    const app = store()
    app.activeCharacterId = 'char-1'
    holdNextBindGet = true
    nextBindResult = { connection_id: 'alpha' }

    app.hydrateActiveCharacterConnection('char-1')
    await flush()
    // The GET is still pending when a WS/local write lands for the same
    // character — the write is fresher and must win over the response.
    app.setActiveCharacterConnection('omega')
    expect(app.activeCharacterConnectionId).toBe('omega')

    resolveHeldBindGet!()
    await flush()
    expect(app.activeCharacterConnectionId).toBe('omega')
  })

  test('a write landing while a 404 GET is in flight is not reset to null', async () => {
    const app = store()
    app.activeCharacterId = 'char-1'
    holdNextBindGet = true
    nextBindResult = new ApiError(404, 'Not Found')

    app.hydrateActiveCharacterConnection('char-1')
    await flush()
    app.setActiveCharacterConnection('omega')

    resolveHeldBindGet!()
    await flush()
    expect(app.activeCharacterConnectionId).toBe('omega')
  })

  test('a write-free GET still hydrates normally (sequence guard does not over-fire)', async () => {
    const app = store()
    app.activeCharacterId = 'char-1'
    nextBindResult = { connection_id: 'alpha' }

    app.hydrateActiveCharacterConnection('char-1')
    await flush()
    expect(app.activeCharacterConnectionId).toBe('alpha')
  })
})
