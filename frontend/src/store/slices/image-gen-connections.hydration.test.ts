/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from 'bun:test'
import type { AppStore, ImageGenSettings } from '@/types/store'
import { settingsApi } from '@/api/settings'
import { createGenerationSlice } from './generation'
import { createImageGenConnectionsSlice } from './image-gen-connections'
import {
  createSettingsSlice,
  flushSettings,
  hasUnsavedSettings,
  flushSettingsNow,
  persistKey,
  setSettingsPersistenceScope,
  resetSettingsPersistence,
} from './settings'

const PENDING_SETTINGS_KEY = '__lumiverse_pending_settings'
const PENDING_IMAGE_GENERATION_PATCH_KEY = '__lumiverse_pending_image_generation_patch'
const originalSettingsApi = {
  getAll: settingsApi.getAll,
  put: settingsApi.put,
  putMany: settingsApi.putMany,
}

type Write =
  | { kind: 'put'; key: string; value: unknown }
  | { kind: 'putMany'; value: Record<string, unknown> }

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function installLocalStorage() {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, String(value)) },
      removeItem: (key: string) => { values.delete(key) },
      clear: () => { values.clear() },
    },
  })
  return values
}

function createStore(): AppStore {
  const state = {} as AppStore
  const set = (partial: Partial<AppStore> | ((current: AppStore) => Partial<AppStore>)) => {
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  }
  const get = () => state
  const api = {} as never

  Object.assign(state, createGenerationSlice(set as never, get, api))
  Object.assign(state, createSettingsSlice(set as never, get, api))
  Object.assign(state, createImageGenConnectionsSlice(set as never, get, api))
  return state
}

function pendingImageGeneration(store: AppStore): ImageGenSettings {
  return {
    ...store.imageGeneration,
    activeImageGenConnectionId: 'missing-image-connection',
    loraPresets: [{
      id: 'preset-1',
      name: 'Preserved preset',
      loras: [{ lora_name: 'styles/ink.safetensors', weight_model: 0.8, weight_clip: 0.7 }],
    }],
    activeLoraPresetId: 'preset-1',
  }
}

function mockSettings(imageGeneration: ImageGenSettings, writes: Write[]) {
  settingsApi.getAll = async () => [{ key: 'imageGeneration', value: imageGeneration, updated_at: 1 }]
  settingsApi.put = async (key, value) => {
    writes.push({ kind: 'put', key, value })
    return { key, value, updated_at: 1 }
  }
  settingsApi.putMany = async (value) => {
    writes.push({ kind: 'putMany', value })
    return Object.entries(value).map(([key, setting]) => ({ key, value: setting, updated_at: 1 }))
  }
}

async function settlePersistence() {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  resetSettingsPersistence()
  settingsApi.getAll = originalSettingsApi.getAll
  settingsApi.put = originalSettingsApi.put
  settingsApi.putMany = originalSettingsApi.putMany
  delete (globalThis as { localStorage?: Storage }).localStorage
})

describe('image connection hydration', () => {
  test('defers a bridged image setting until the profile list is authoritative', async () => {
    const storage = installLocalStorage()
    const store = createStore()
    const pending = pendingImageGeneration(store)
    const writes: Write[] = []
    mockSettings(pending, writes)
    storage.set(PENDING_SETTINGS_KEY, JSON.stringify({ imageGeneration: pending }))

    await store.loadSettings()

    expect(store.fullSettingsLoaded).toBe(true)
    expect(store.imageGenProfilesLoaded).toBe(false)
    expect(store.imageGeneration.activeImageGenConnectionId).toBe('missing-image-connection')
    expect(writes).toEqual([])
    expect(storage.get(PENDING_SETTINGS_KEY)).not.toBeNull()

    store.setImageGenProfiles([])
    await flushSettingsNow()
    await settlePersistence()

    expect(store.activeImageGenConnectionId).toBeNull()
    expect(writes).toEqual([{
      kind: 'putMany',
      value: { imageGeneration: { ...pending, activeImageGenConnectionId: null } },
    }])
    expect(storage.get(PENDING_SETTINGS_KEY)).toBeUndefined()
  })

  test('reconciles and flushes a bridged image setting after profiles load first', async () => {
    const storage = installLocalStorage()
    const store = createStore()
    const pending = pendingImageGeneration(store)
    const writes: Write[] = []
    mockSettings(pending, writes)
    storage.set(PENDING_SETTINGS_KEY, JSON.stringify({ imageGeneration: pending }))

    store.setImageGenProfiles([])
    await store.loadSettings()
    await flushSettingsNow()
    await settlePersistence()

    expect(store.fullSettingsLoaded).toBe(true)
    expect(store.activeImageGenConnectionId).toBeNull()
    expect(writes).toEqual([{
      kind: 'putMany',
      value: { imageGeneration: { ...pending, activeImageGenConnectionId: null } },
    }])
    expect(storage.get(PENDING_SETTINGS_KEY)).toBeUndefined()
  })

  test('serializes active-connection and later LoRA edits through one batch', async () => {
    installLocalStorage()
    const store = createStore()
    const writes: Write[] = []
    mockSettings(store.imageGeneration, writes)
    await store.loadSettings()

    store.setActiveImageGenConnection('connection-a')
    store.setImageGenSettings({ loraStrengthScale: 0.5 })
    await flushSettingsNow()
    await settlePersistence()

    expect(writes).toEqual([{
      kind: 'putMany',
      value: {
        imageGeneration: expect.objectContaining({
          activeImageGenConnectionId: 'connection-a',
          loraStrengthScale: 0.5,
        }),
      },
    }])
  })

  test('keeps a complete post-start image edit over a stale settings response', async () => {
    const storage = installLocalStorage()
    const store = createStore()
    store.fullSettingsLoaded = true

    const staleImageGeneration: ImageGenSettings = {
      ...store.imageGeneration,
      activeImageGenConnectionId: 'stale-connection',
      customPrompt: 'stale prompt',
      loraPresets: [{
        id: 'stale-preset',
        name: 'Stale preset',
        loras: [{ lora_name: 'styles/stale.safetensors', weight_model: 0.2, weight_clip: 0.1 }],
      }],
      activeLoraPresetId: 'stale-preset',
      bypassActiveLoraPreset: false,
      loraStrengthScale: 0.2,
    }
    const response = createDeferred<Array<{ key: string; value: ImageGenSettings; updated_at: number }>>()
    let requested = false
    settingsApi.getAll = () => {
      requested = true
      return response.promise
    }

    const loading = store.loadSettings()
    expect(requested).toBe(true)
    expect(storage.get(PENDING_SETTINGS_KEY)).toBeUndefined()

    const newerLoras = [{
      id: 'newer-preset',
      name: 'Newer preset',
      loras: [{ lora_name: 'styles/newer.safetensors', weight_model: 0.8, weight_clip: 0.6 }],
    }]
    store.setImageGenSettings({
      activeImageGenConnectionId: 'newer-connection',
      customPrompt: 'newer prompt',
      loraPresets: newerLoras,
      activeLoraPresetId: 'newer-preset',
      bypassActiveLoraPreset: true,
      loraStrengthScale: 0.8,
    })
    const newerImageGeneration = store.imageGeneration

    response.resolve([{ key: 'imageGeneration', value: staleImageGeneration, updated_at: 1 }])
    await loading

    expect(store.settingsLoaded).toBe(true)
    expect(store.activeImageGenConnectionId).toBe('newer-connection')
    expect(store.imageGeneration).toBe(newerImageGeneration)
    expect(store.imageGeneration).toEqual(expect.objectContaining({
      customPrompt: 'newer prompt',
      loraPresets: newerLoras,
      activeLoraPresetId: 'newer-preset',
      bypassActiveLoraPreset: true,
      loraStrengthScale: 0.8,
    }))
  })

  test('rebases pre-hydration profile selection and LoRA edits over the full server row', async () => {
    const storage = installLocalStorage()
    const firstStore = createStore()
    const userLoras = [{
      id: 'user-preset',
      name: 'User preset',
      loras: [{ lora_name: 'styles/user.safetensors', weight_model: 0.75, weight_clip: 0.5 }],
    }]
    firstStore.addImageGenProfile({ id: 'new-default-connection', is_default: true } as any)
    expect(firstStore.activeImageGenConnectionId).toBe('new-default-connection')
    expect(firstStore.pendingImageGenerationPatch).toEqual({
      activeImageGenConnectionId: 'new-default-connection',
    })
    expect(JSON.parse(storage.get(PENDING_IMAGE_GENERATION_PATCH_KEY)!)).toEqual({
      activeImageGenConnectionId: 'new-default-connection',
    })
    firstStore.setActiveImageGenConnection('user-selected-connection')

    firstStore.setImageGenSettings({
      loraPresets: userLoras,
      activeLoraPresetId: 'user-preset',
    })

    expect(JSON.parse(storage.get(PENDING_IMAGE_GENERATION_PATCH_KEY)!)).toEqual({
      activeImageGenConnectionId: 'user-selected-connection',
      loraPresets: userLoras,
      activeLoraPresetId: 'user-preset',
    })

    const store = createStore()
    const writes: Write[] = []
    const server = {
      ...pendingImageGeneration(store),
      customPrompt: 'server prompt survives',
      loraPresets: [{
        id: 'server-preset',
        name: 'Server preset',
        loras: [{ lora_name: 'styles/server.safetensors', weight_model: 1, weight_clip: 1 }],
      }],
      activeLoraPresetId: 'server-preset',
    }
    mockSettings(server, writes)

    await store.loadSettings()

    expect(store.imageGeneration.activeImageGenConnectionId).toBe('user-selected-connection')
    expect(store.imageGeneration.customPrompt).toBe('server prompt survives')
    expect(store.imageGeneration.loraPresets).toEqual(userLoras)
    expect(store.imageGeneration.activeLoraPresetId).toBe('user-preset')
    await flushSettingsNow()
    await settlePersistence()

    expect((writes[0] as Extract<Write, { kind: 'putMany' }>).value.imageGeneration).toEqual(
      expect.objectContaining({
        activeImageGenConnectionId: 'user-selected-connection',
        customPrompt: 'server prompt survives',
        loraPresets: userLoras,
        activeLoraPresetId: 'user-preset',
      }),
    )
    expect(storage.get(PENDING_IMAGE_GENERATION_PATCH_KEY)).toBeUndefined()
  })

  test('applies a newer partial image bridge over an older full bridge', async () => {
    const storage = installLocalStorage()
    const store = createStore()
    const olderLoras = [{
      id: 'older',
      name: 'Older',
      loras: [{ lora_name: 'styles/older.safetensors', weight_model: 1, weight_clip: 1 }],
    }]
    const newerLoras = [{
      id: 'newer',
      name: 'Newer',
      loras: [{ lora_name: 'styles/newer.safetensors', weight_model: 0.4, weight_clip: 0.8 }],
    }]
    storage.set(PENDING_SETTINGS_KEY, JSON.stringify({
      imageGeneration: {
        ...store.imageGeneration,
        loraPresets: olderLoras,
        activeLoraPresetId: 'older',
      },
    }))
    store.setImageGenSettings({ loraPresets: newerLoras, activeLoraPresetId: 'newer' })
    const writes: Write[] = []
    mockSettings(store.imageGeneration, writes)

    await store.loadSettings()

    expect(store.imageGeneration.loraPresets).toEqual(newerLoras)
    expect(store.imageGeneration.activeLoraPresetId).toBe('newer')
  })

  test('merges an unload bridge with unrelated dirty settings', () => {
    const storage = installLocalStorage()
    const store = createStore()
    const pending = pendingImageGeneration(store)
    storage.set(PENDING_SETTINGS_KEY, JSON.stringify({ imageGeneration: pending }))

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    try {
      persistKey('theme', { accent: '#123456' })
      flushSettings()
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(JSON.parse(storage.get(PENDING_SETTINGS_KEY)!)).toEqual({
      imageGeneration: pending,
      theme: { accent: '#123456' },
    })
  })


  test('does not read a pre-hydration image patch from another user scope', async () => {
    const storage = installLocalStorage()
    setSettingsPersistenceScope('user-a')
    const firstStore = createStore()
    firstStore.setImageGenSettings({
      loraPresets: [{
        id: 'user-a-preset',
        name: 'User A preset',
        loras: [],
      }],
    })
    expect(storage.get(`${PENDING_IMAGE_GENERATION_PATCH_KEY}:user-a`)).not.toBeNull()

    setSettingsPersistenceScope('user-b')
    const store = createStore()
    const writes: Write[] = []
    mockSettings({ ...store.imageGeneration, loraPresets: [] }, writes)
    await store.loadSettings()

    expect(store.imageGeneration.loraPresets).toEqual([])
    expect(storage.get(`${PENDING_IMAGE_GENERATION_PATCH_KEY}:user-b`)).toBeUndefined()

    setSettingsPersistenceScope('user-a')
    resetSettingsPersistence()
  })

  test('preserves a scoped debounced image setting across logout and same-user reauthentication', async () => {
    const storage = installLocalStorage()
    setSettingsPersistenceScope('user-a')
    const firstStore = createStore()
    firstStore.fullSettingsLoaded = true
    firstStore.setImageGenSettings({ loraStrengthScale: 0.5 })

    resetSettingsPersistence()

    expect(JSON.parse(storage.get(`${PENDING_SETTINGS_KEY}:user-a`)!)).toEqual({
      imageGeneration: expect.objectContaining({ loraStrengthScale: 0.5 }),
    })

    setSettingsPersistenceScope('user-a')
    const reauthenticatedStore = createStore()
    const writes: Write[] = []
    mockSettings(reauthenticatedStore.imageGeneration, writes)
    await reauthenticatedStore.loadSettings()

    expect(reauthenticatedStore.imageGeneration.loraStrengthScale).toBe(0.5)
  })

  test('lets a post-hydration image setting supersede its older partial bridge on reset', async () => {
    const storage = installLocalStorage()
    setSettingsPersistenceScope('user-a')
    const store = createStore()
    const firstLoras = [{
      id: 'first',
      name: 'First',
      loras: [{ lora_name: 'styles/first.safetensors', weight_model: 1, weight_clip: 1 }],
    }]
    const latestLoras = [{
      id: 'latest',
      name: 'Latest',
      loras: [{ lora_name: 'styles/latest.safetensors', weight_model: 0.6, weight_clip: 0.4 }],
    }]
    store.setImageGenSettings({ loraPresets: firstLoras, activeLoraPresetId: 'first' })
    const serverImage = {
      ...store.imageGeneration,
      loraPresets: [],
      activeLoraPresetId: null,
    }
    const writes: Write[] = []
    mockSettings(serverImage, writes)
    await store.loadSettings()
    store.setImageGenSettings({ loraPresets: latestLoras, activeLoraPresetId: 'latest' })

    resetSettingsPersistence()

    expect(storage.get(`${PENDING_IMAGE_GENERATION_PATCH_KEY}:user-a`)).toBeUndefined()
    expect(JSON.parse(storage.get(`${PENDING_SETTINGS_KEY}:user-a`)!).imageGeneration).toEqual(
      expect.objectContaining({
        loraPresets: latestLoras,
        activeLoraPresetId: 'latest',
      }),
    )

    setSettingsPersistenceScope('user-a')
    const reauthenticatedStore = createStore()
    mockSettings(serverImage, [])
    await reauthenticatedStore.loadSettings()

    expect(reauthenticatedStore.imageGeneration.loraPresets).toEqual(latestLoras)
    expect(reauthenticatedStore.imageGeneration.activeLoraPresetId).toBe('latest')
  })

  test('promotes the latest hydrated image setting over its partial bridge on unload', async () => {
    const storage = installLocalStorage()
    setSettingsPersistenceScope('user-a')
    const store = createStore()
    store.setImageGenSettings({ loraStrengthScale: 0.2 })
    const serverImage = {
      ...store.imageGeneration,
      loraStrengthScale: 0.1,
    }
    mockSettings(serverImage, [])
    await store.loadSettings()
    store.setImageGenSettings({ loraStrengthScale: 0.8 })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    try {
      flushSettings()
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(storage.get(`${PENDING_IMAGE_GENERATION_PATCH_KEY}:user-a`)).toBeUndefined()
    expect(JSON.parse(storage.get(`${PENDING_SETTINGS_KEY}:user-a`)!).imageGeneration).toEqual(
      expect.objectContaining({ loraStrengthScale: 0.8 }),
    )

    resetSettingsPersistence()
    setSettingsPersistenceScope('user-a')
    const reauthenticatedStore = createStore()
    mockSettings(serverImage, [])
    await reauthenticatedStore.loadSettings()

    expect(reauthenticatedStore.imageGeneration.loraStrengthScale).toBe(0.8)
  })

  test('retains a partial bridge when promoting a full image setting fails', () => {
    const storage = installLocalStorage()
    setSettingsPersistenceScope('user-a')
    const store = createStore()
    store.setImageGenSettings({ loraStrengthScale: 0.2 })
    const patchKey = `${PENDING_IMAGE_GENERATION_PATCH_KEY}:user-a`
    const originalPatch = storage.get(patchKey)
    store.fullSettingsLoaded = true
    store.setImageGenSettings({ loraStrengthScale: 0.8 })
    const local = globalThis.localStorage as unknown as {
      setItem: (key: string, value: string) => void
    }
    const originalSetItem = local.setItem
    local.setItem = (key, value) => {
      if (key === `${PENDING_SETTINGS_KEY}:user-a`) throw new Error('storage full')
      originalSetItem(key, value)
    }
    try {
      resetSettingsPersistence()
    } finally {
      local.setItem = originalSetItem
    }

    expect(storage.get(patchKey)).toBe(originalPatch)
    expect(storage.get(`${PENDING_SETTINGS_KEY}:user-a`)).toBeUndefined()
  })
  test('releases an old scoped persistence promise while retaining its in-flight batch', async () => {
    const storage = installLocalStorage()
    setSettingsPersistenceScope('user-a')
    const store = createStore()
    const writes: Write[] = []
    const inFlight = createDeferred<void>()
    settingsApi.putMany = async (value) => {
      writes.push({ kind: 'putMany', value })
      await inFlight.promise
      return Object.entries(value).map(([key, setting]) => ({ key, value: setting, updated_at: 1 }))
    }
    store.fullSettingsLoaded = true
    store.setImageGenSettings({ loraStrengthScale: 0.5 })

    const flushing = flushSettingsNow()
    expect(hasUnsavedSettings()).toBe(true)
    resetSettingsPersistence()
    expect(hasUnsavedSettings()).toBe(false)
    expect(JSON.parse(storage.get(`${PENDING_SETTINGS_KEY}:user-a`)!)).toEqual({
      imageGeneration: expect.objectContaining({ loraStrengthScale: 0.5 }),
    })

    inFlight.resolve()
    await flushing
    expect(writes).toHaveLength(1)
    expect(hasUnsavedSettings()).toBe(false)
  })

  test('rejects a stale profile response after a local profile mutation', () => {
    installLocalStorage()
    const store = createStore()
    const expectedVersion = store.imageGenProfilesVersion
    store.addImageGenProfile({ id: 'local-profile', is_default: false } as any)

    store.setImageGenProfiles([], expectedVersion)

    expect(store.imageGenProfiles.map((profile) => profile.id)).toEqual(['local-profile'])
  })

  test('persists a later authoritative profile refresh that removes the active profile', async () => {
    installLocalStorage()
    const store = createStore()
    const writes: Write[] = []
    const active = { id: 'connection-a', is_default: true } as any
    mockSettings({ ...store.imageGeneration, activeImageGenConnectionId: 'connection-a' }, writes)
    store.setImageGenProfiles([active])
    await store.loadSettings()
    await flushSettingsNow()
    writes.length = 0

    store.setImageGenProfiles([])
    await flushSettingsNow()
    await settlePersistence()

    expect(store.activeImageGenConnectionId).toBeNull()
    expect(writes).toEqual([{
      kind: 'putMany',
      value: {
        imageGeneration: expect.objectContaining({ activeImageGenConnectionId: null }),
      },
    }])
  })
})
