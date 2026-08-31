/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { StoreApi } from 'zustand'
import type {
  ConnectionProfile,
  ImageGenConnectionProfile,
  SttConnectionProfile,
  TtsConnectionProfile,
} from '@/types/api'
import type { AppStore } from '@/types/store'
import type { CompleteConnectionsOrder } from './connections-order-merge'

const persistedSettings: Array<[string, unknown]> = []

// The slices own the mutation, while settings owns the debounced transport.
// Mock the latter so these order tests can assert that a new profile queues
// the shared persisted order without starting real persistence timers.
mock.module('./settings', () => ({
  REASONING_DEFAULTS: {
    prefix: '<think>\n', suffix: '\n</think>', autoParse: true, apiReasoning: false,
    reasoningEffort: 'auto', keepInHistory: 0, thinkingDisplay: 'auto',
  },
  clearDirtyKey: () => {},
  hasPendingSetting: () => false,
  persistKey: (key: string, value: unknown) => { persistedSettings.push([key, value]) },
  persistPendingImageGenerationPatch: () => {},
}))

const { createConnectionsSlice } = await import('./connections')
const { createGenerationSlice } = await import('./generation')
const { createImageGenConnectionsSlice } = await import('./image-gen-connections')
const { createSttConnectionsSlice } = await import('./stt-connections')
const { createTtsConnectionsSlice } = await import('./tts-connections')

afterEach(() => { persistedSettings.length = 0 })

type ProfileSetterHarness = Pick<
  AppStore,
  | 'connectionsOrder'
  | 'profiles'
  | 'activeProfileId'
  | 'imageGenProfiles'
  | 'imageGenProfilesVersion'
  | 'imageGenProfilesLoaded'
  | 'activeImageGenConnectionId'
  | 'sttProfiles'
  | 'ttsProfiles'
  | 'setProfiles'
  | 'setActiveProfile'
  | 'addProfile'
  | 'setImageGenProfiles'
  | 'addImageGenProfile'
  | 'setSttProfiles'
  | 'addSttProfile'
  | 'setTtsProfiles'
  | 'addTtsProfile'
>

type StoreUpdate =
  | AppStore
  | Partial<AppStore>
  | ((state: AppStore) => AppStore | Partial<AppStore>)

function persistedDragOrder(): CompleteConnectionsOrder {
  return {
    llm: ['llm-third', 'llm-first', 'removed-llm'],
    imageGen: ['image-third', 'image-first', 'removed-image'],
    stt: ['stt-third', 'stt-first', 'removed-stt'],
    tts: ['tts-third', 'tts-first', 'removed-tts'],
  }
}

function createHarness(connectionsOrder: unknown): ProfileSetterHarness {
  const state = {
    connectionsOrder,
    fullSettingsLoaded: false,
    voiceSettings: {
      sttConnectionId: null as string | null,
      ttsConnectionId: null as string | null,
    },
  }
  // Slice creators are typed against the aggregate store; these setters read only fields initialized below.
  const appState = state as unknown as AppStore
  const get: StoreApi<AppStore>['getState'] = () => appState
  const set = (partial: StoreUpdate, _replace?: boolean): void => {
    const patch = typeof partial === 'function' ? partial(appState) : partial
    Object.assign(state, patch)
  }
  const api: StoreApi<AppStore> = {
    getState: get,
    getInitialState: get,
    setState: set,
    subscribe: () => () => {},
  }

  return Object.assign(
    state,
    createGenerationSlice(set, get, api),
    createConnectionsSlice(set, get, api),
    createImageGenConnectionsSlice(set, get, api),
    createSttConnectionsSlice(set, get, api),
    createTtsConnectionsSlice(set, get, api),
  )
}

function llmProfile(id: string): ConnectionProfile {
  return {
    id,
    name: id,
    provider: 'test',
    api_url: 'http://example.test',
    model: 'test-model',
    preset_id: null,
    is_default: false,
    has_api_key: false,
    metadata: {},
    created_at: 0,
    updated_at: 0,
    review_required: false,
    review_code: null,
  }
}

function imageProfile(id: string): ImageGenConnectionProfile {
  return {
    id,
    name: id,
    provider: 'test',
    api_url: 'http://example.test',
    model: 'test-model',
    is_default: false,
    has_api_key: false,
    default_parameters: {},
    metadata: {},
    created_at: 0,
    updated_at: 0,
    review_required: false,
    review_code: null,
  }
}

function sttProfile(id: string): SttConnectionProfile {
  return {
    id,
    name: id,
    provider: 'test',
    api_url: 'http://example.test',
    model: 'test-model',
    is_default: false,
    has_api_key: false,
    default_parameters: {},
    metadata: {},
    created_at: 0,
    updated_at: 0,
    review_required: false,
    review_code: null,
  }
}

function ttsProfile(id: string): TtsConnectionProfile {
  return {
    id,
    name: id,
    provider: 'test',
    api_url: 'http://example.test',
    model: 'test-model',
    voice: 'test-voice',
    is_default: false,
    has_api_key: false,
    default_parameters: {},
    metadata: {},
    created_at: 0,
    updated_at: 0,
    review_required: false,
    review_code: null,
  }
}

function profileIds(profiles: readonly { id: string }[]): string[] {
  return profiles.map((profile) => profile.id)
}

describe('profile replacement ordering', () => {
  test('keeps LLM manager refreshes in persisted drag order and appends new profiles in backend order', () => {
    const store = createHarness(persistedDragOrder())
    store.profiles = [llmProfile('llm-third'), llmProfile('llm-first')]

    store.setProfiles([
      llmProfile('llm-first'),
      llmProfile('llm-new-first'),
      llmProfile('llm-new-second'),
      llmProfile('llm-third'),
    ])

    expect(profileIds(store.profiles)).toEqual(['llm-third', 'llm-first', 'llm-new-first', 'llm-new-second'])
    expect(store.connectionsOrder).toEqual(persistedDragOrder())
  })

  test('adds new LLM profiles at the top and reconciles duplicate deliveries', () => {
    const store = createHarness(persistedDragOrder())
    store.profiles = [llmProfile('llm-first')]

    store.addProfile({ ...llmProfile('llm-copy'), name: 'WebSocket copy' })
    store.addProfile({ ...llmProfile('llm-copy'), name: 'REST copy' })

    expect(profileIds(store.profiles)).toEqual(['llm-copy', 'llm-first'])
    expect(store.profiles[0]?.name).toBe('REST copy')
    expect(store.connectionsOrder.llm).toEqual([
      'llm-copy',
      'llm-third',
      'llm-first',
      'removed-llm',
    ])
    expect(persistedSettings).toEqual([['connectionsOrder', store.connectionsOrder]])
  })

  test('adds new image, STT, and TTS profiles at the top and persists the shared order', () => {
    const store = createHarness(persistedDragOrder())
    store.imageGenProfiles = [imageProfile('image-first')]
    store.sttProfiles = [sttProfile('stt-first')]
    store.ttsProfiles = [ttsProfile('tts-first')]

    store.addImageGenProfile(imageProfile('image-new'))
    store.addSttProfile(sttProfile('stt-new'))
    store.addTtsProfile(ttsProfile('tts-new'))

    expect(profileIds(store.imageGenProfiles)).toEqual(['image-new', 'image-first'])
    expect(profileIds(store.sttProfiles)).toEqual(['stt-new', 'stt-first'])
    expect(profileIds(store.ttsProfiles)).toEqual(['tts-new', 'tts-first'])
    expect(store.connectionsOrder).toEqual({
      llm: ['llm-third', 'llm-first', 'removed-llm'],
      imageGen: ['image-new', 'image-third', 'image-first', 'removed-image'],
      stt: ['stt-new', 'stt-third', 'stt-first', 'removed-stt'],
      tts: ['tts-new', 'tts-third', 'tts-first', 'removed-tts'],
    })
    expect(persistedSettings).toHaveLength(3)
    expect(persistedSettings.at(-1)).toEqual(['connectionsOrder', store.connectionsOrder])
  })
  test('never activates unknown or review-required LLM profile IDs', () => {
    const store = createHarness(persistedDragOrder())
    store.profiles = [
      llmProfile('llm-ready'),
      { ...llmProfile('llm-review'), review_required: true },
    ]

    store.setActiveProfile('missing')
    expect(store.activeProfileId).toBeNull()

    store.setActiveProfile('llm-review')
    expect(store.activeProfileId).toBeNull()
  })
  test('keeps image manager refreshes in persisted drag order and appends new profiles in backend order', () => {
    const store = createHarness(persistedDragOrder())
    store.imageGenProfiles = [imageProfile('image-third'), imageProfile('image-first')]
    const initialVersion = store.imageGenProfilesVersion

    store.setImageGenProfiles([
      imageProfile('image-first'),
      imageProfile('image-new-first'),
      imageProfile('image-new-second'),
      imageProfile('image-third'),
    ])

    expect(profileIds(store.imageGenProfiles)).toEqual([
      'image-third',
      'image-first',
      'image-new-first',
      'image-new-second',
    ])
    expect(store.imageGenProfilesVersion).toBe(initialVersion + 1)
    expect(store.connectionsOrder).toEqual(persistedDragOrder())
  })

  test('accepts matching image profile versions and ignores stale refreshes after local mutations', () => {
    const store = createHarness(persistedDragOrder())
    const acceptedVersion = store.imageGenProfilesVersion

    store.setImageGenProfiles([
      imageProfile('image-first'),
      imageProfile('image-new-first'),
      imageProfile('image-new-second'),
      imageProfile('image-third'),
    ], acceptedVersion)
    expect(profileIds(store.imageGenProfiles)).toEqual([
      'image-third',
      'image-first',
      'image-new-first',
      'image-new-second',
    ])
    expect(store.imageGenProfilesVersion).toBe(acceptedVersion + 1)
    const staleVersion = store.imageGenProfilesVersion

    store.addImageGenProfile(imageProfile('image-local'))
    expect(profileIds(store.imageGenProfiles)).toEqual([
      'image-local',
      'image-third',
      'image-first',
      'image-new-first',
      'image-new-second',
    ])
    const profilesBeforeStaleRefresh = profileIds(store.imageGenProfiles)
    const versionBeforeStaleRefresh = store.imageGenProfilesVersion
    const loadedBeforeStaleRefresh = store.imageGenProfilesLoaded
    const activeConnectionBeforeStaleRefresh = store.activeImageGenConnectionId

    store.setImageGenProfiles([imageProfile('image-stale')], staleVersion)

    expect(profileIds(store.imageGenProfiles)).toEqual(profilesBeforeStaleRefresh)
    expect(store.imageGenProfilesVersion).toBe(versionBeforeStaleRefresh)
    expect(store.imageGenProfilesLoaded).toBe(loadedBeforeStaleRefresh)
    expect(store.activeImageGenConnectionId).toBe(activeConnectionBeforeStaleRefresh)
    store.setImageGenProfiles([
      imageProfile('image-first'),
      imageProfile('image-versionless-first'),
      imageProfile('image-versionless-second'),
      imageProfile('image-third'),
    ])
    expect(profileIds(store.imageGenProfiles)).toEqual([
      'image-third',
      'image-first',
      'image-versionless-first',
      'image-versionless-second',
    ])
    expect(store.imageGenProfilesVersion).toBe(versionBeforeStaleRefresh + 1)
  })

  test('keeps STT manager refreshes in persisted drag order and appends new profiles in backend order', () => {
    const store = createHarness(persistedDragOrder())
    store.sttProfiles = [sttProfile('stt-third'), sttProfile('stt-first')]

    store.setSttProfiles([
      sttProfile('stt-first'),
      sttProfile('stt-new-first'),
      sttProfile('stt-new-second'),
      sttProfile('stt-third'),
    ])

    expect(profileIds(store.sttProfiles)).toEqual(['stt-third', 'stt-first', 'stt-new-first', 'stt-new-second'])
    expect(store.connectionsOrder).toEqual(persistedDragOrder())
  })

  test('keeps TTS manager refreshes in persisted drag order and appends new profiles in backend order', () => {
    const store = createHarness(persistedDragOrder())
    store.ttsProfiles = [ttsProfile('tts-third'), ttsProfile('tts-first')]

    store.setTtsProfiles([
      ttsProfile('tts-first'),
      ttsProfile('tts-new-first'),
      ttsProfile('tts-new-second'),
      ttsProfile('tts-third'),
    ])

    expect(profileIds(store.ttsProfiles)).toEqual(['tts-third', 'tts-first', 'tts-new-first', 'tts-new-second'])
    expect(store.connectionsOrder).toEqual(persistedDragOrder())
  })

  test('normalizes malformed persisted order before raw profile replacements', () => {
    const store = createHarness({
      llm: ['llm-third', 'llm-third', '', 42],
      imageGen: null,
      stt: 'not-an-array',
      tts: ['tts-third', 'tts-third', '', false],
    })

    store.setProfiles([
      llmProfile('llm-first'),
      llmProfile('llm-new-first'),
      llmProfile('llm-new-second'),
      llmProfile('llm-third'),
    ])
    store.setImageGenProfiles([
      imageProfile('image-first'),
      imageProfile('image-new-first'),
      imageProfile('image-new-second'),
      imageProfile('image-third'),
    ])
    store.setSttProfiles([
      sttProfile('stt-first'),
      sttProfile('stt-new-first'),
      sttProfile('stt-new-second'),
      sttProfile('stt-third'),
    ])
    store.setTtsProfiles([
      ttsProfile('tts-first'),
      ttsProfile('tts-new-first'),
      ttsProfile('tts-new-second'),
      ttsProfile('tts-third'),
    ])

    expect(profileIds(store.profiles)).toEqual(['llm-third', 'llm-first', 'llm-new-first', 'llm-new-second'])
    expect(profileIds(store.imageGenProfiles)).toEqual([
      'image-first',
      'image-new-first',
      'image-new-second',
      'image-third',
    ])
    expect(profileIds(store.sttProfiles)).toEqual([
      'stt-first',
      'stt-new-first',
      'stt-new-second',
      'stt-third',
    ])
    expect(profileIds(store.ttsProfiles)).toEqual(['tts-third', 'tts-first', 'tts-new-first', 'tts-new-second'])
  })
})
