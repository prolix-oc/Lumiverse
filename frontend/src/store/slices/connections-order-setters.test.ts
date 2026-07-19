/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import type { StoreApi } from 'zustand'
import type {
  ConnectionProfile,
  ImageGenConnectionProfile,
  SttConnectionProfile,
  TtsConnectionProfile,
} from '@/types/api'
import type { AppStore } from '@/types/store'
import { createConnectionsSlice } from './connections'
import type { CompleteConnectionsOrder } from './connections-order-merge'
import { createGenerationSlice } from './generation'
import { createImageGenConnectionsSlice } from './image-gen-connections'
import { createSttConnectionsSlice } from './stt-connections'
import { createTtsConnectionsSlice } from './tts-connections'

type ProfileSetterHarness = Pick<
  AppStore,
  | 'connectionsOrder'
  | 'profiles'
  | 'imageGenProfiles'
  | 'imageGenProfilesVersion'
  | 'imageGenProfilesLoaded'
  | 'activeImageGenConnectionId'
  | 'sttProfiles'
  | 'ttsProfiles'
  | 'setProfiles'
  | 'setImageGenProfiles'
  | 'addImageGenProfile'
  | 'setSttProfiles'
  | 'setTtsProfiles'
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
  const state = { connectionsOrder, fullSettingsLoaded: false }
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
      'image-third',
      'image-first',
      'image-new-first',
      'image-new-second',
      'image-local',
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
