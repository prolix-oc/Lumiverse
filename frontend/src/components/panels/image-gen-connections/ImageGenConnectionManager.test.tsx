import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import { create } from 'zustand'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type {
  ImageGenConnectionProfile,
  ImageGenProviderInfo,
  PaginatedResult,
} from '@/types/api'

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  localStorage: { configurable: true, value: dom.window.localStorage },
  sessionStorage: { configurable: true, value: dom.window.sessionStorage },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  HTMLButtonElement: { configurable: true, value: dom.window.HTMLButtonElement },
  Node: { configurable: true, value: dom.window.Node },
  Event: { configurable: true, value: dom.window.Event },
  MouseEvent: { configurable: true, value: dom.window.MouseEvent },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
})

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

type TestStore = {
  imageGenProfiles: ImageGenConnectionProfile[]
  imageGenProfilesLoaded: boolean
  imageGenProfilesVersion: number
  imageGenProviders: ImageGenProviderInfo[]
  activeImageGenConnectionId: string | null
  imageGeneration: { activeImageGenConnectionId: string | null }
  connectionsOrder: { imageGen: string[] }
  setImageGenProfiles: (profiles: ImageGenConnectionProfile[], expectedVersion?: number) => void
  addImageGenProfile: (profile: ImageGenConnectionProfile) => void
  updateImageGenProfile: (id: string, profile: Partial<ImageGenConnectionProfile>) => void
  removeImageGenProfile: (id: string) => void
  applyImageGenProfileOrder: (orderedIds: string[]) => void
  setActiveImageGenConnection: (id: string | null) => void
  setImageGenProviders: (providers: ImageGenProviderInfo[]) => void
  setSetting: (key: string, value: unknown) => void
}

const persistedActiveConnectionIds: Array<string | null> = []

function resolveActiveConnection(
  profiles: ImageGenConnectionProfile[],
  selectedId: string | null,
): string | null {
  if (selectedId && profiles.some((item) => item.id === selectedId)) return selectedId
  return profiles.find((item) => item.is_default)?.id ?? null
}

const useTestStore = create<TestStore>((set, get) => ({
  imageGenProfiles: [],
  imageGenProfilesLoaded: false,
  imageGenProfilesVersion: 0,
  imageGenProviders: [],
  activeImageGenConnectionId: null,
  imageGeneration: { activeImageGenConnectionId: null },
  connectionsOrder: { imageGen: [] },
  setImageGenProfiles: (profiles, expectedVersion) => {
    const state = get()
    if (expectedVersion !== undefined && expectedVersion !== state.imageGenProfilesVersion) return

    const activeImageGenConnectionId = resolveActiveConnection(
      profiles,
      state.imageGeneration.activeImageGenConnectionId,
    )
    set({
      imageGenProfiles: profiles,
      imageGenProfilesLoaded: true,
      imageGenProfilesVersion: state.imageGenProfilesVersion + 1,
      activeImageGenConnectionId,
      imageGeneration: { activeImageGenConnectionId },
    })
    if (activeImageGenConnectionId !== state.imageGeneration.activeImageGenConnectionId) {
      persistedActiveConnectionIds.push(activeImageGenConnectionId)
    }
  },
  addImageGenProfile: (profile) => set((state) => ({
    imageGenProfiles: [...state.imageGenProfiles, profile],
    imageGenProfilesVersion: state.imageGenProfilesVersion + 1,
    connectionsOrder: {
      imageGen: [...state.connectionsOrder.imageGen, profile.id],
    },
  })),
  updateImageGenProfile: (id, profile) => set((state) => ({
    imageGenProfiles: state.imageGenProfiles.map((item) => (
      item.id === id ? { ...item, ...profile } : item
    )),
    imageGenProfilesVersion: state.imageGenProfilesVersion + 1,
  })),
  removeImageGenProfile: (id) => set((state) => ({
    imageGenProfiles: state.imageGenProfiles.filter((item) => item.id !== id),
    imageGenProfilesVersion: state.imageGenProfilesVersion + 1,
  })),
  applyImageGenProfileOrder: (orderedIds) => set((state) => ({
    imageGenProfiles: orderedIds
      .map((id) => state.imageGenProfiles.find((item) => item.id === id))
      .filter((item): item is ImageGenConnectionProfile => item !== undefined),
    imageGenProfilesVersion: state.imageGenProfilesVersion + 1,
  })),
  setActiveImageGenConnection: (id) => set(() => {
    persistedActiveConnectionIds.push(id)
    return {
      activeImageGenConnectionId: id,
      imageGeneration: { activeImageGenConnectionId: id },
    }
  }),
  setImageGenProviders: (providers) => set({ imageGenProviders: providers }),
  setSetting: () => {},
}))

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function profile(id: string, isDefault = false): ImageGenConnectionProfile {
  return {
    id,
    name: id,
    provider: 'swarmui',
    api_url: `http://${id}.example.test`,
    model: '',
    is_default: isDefault,
    has_api_key: false,
    default_parameters: {},
    metadata: {},
    created_at: 1,
    updated_at: 1,
  }
}

const provider: ImageGenProviderInfo = {
  id: 'swarmui',
  name: 'SwarmUI',
  capabilities: {
    parameters: {},
    apiKeyRequired: false,
    modelListStyle: 'dynamic',
    defaultUrl: 'http://swarm.example.test',
  },
}

let listRequest: Deferred<PaginatedResult<ImageGenConnectionProfile>> | null = null
let listRequestCount = 0
let providerRequestCount = 0

function TestDndContext({ children }: { children: ReactNode }) {
  return <>{children}</>
}

function TestSortableContext({ children }: { children: ReactNode }) {
  return <>{children}</>
}

function testArrayMove<T>(items: T[], from: number, to: number): T[] {
  const next = items.slice()
  const [item] = next.splice(from, 1)
  if (item === undefined) return items
  next.splice(to, 0, item)
  return next
}

function TestImageGenConnectionItem({
  profile: itemProfile,
  isActive,
  onSelect,
}: {
  profile: ImageGenConnectionProfile
  isActive: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-profile-id={itemProfile.id}
      data-active-profile={isActive ? itemProfile.id : undefined}
      onClick={onSelect}
    >
      {itemProfile.name}
    </button>
  )
}

// These browser-dependent modules must load only after JSDOM and the API
// substitutes below are installed; static imports would retain production modules.
mock.module('@/store', () => ({ useStore: useTestStore }))

mock.module('@/api/listAllConnections', () => ({
  listAllConnections: () => {
    if (!listRequest) throw new Error('Test list request was not prepared')
    listRequestCount += 1
    return listRequest.promise
  },
}))

mock.module('@/api/image-gen-connections', () => ({
  imageGenConnectionsApi: {
    providers: async () => {
      providerRequestCount += 1
      return { providers: [provider] }
    },
  },
}))

// Intentionally NOT mocking 'react-i18next' here. The test asserts that
// `host.textContent` does not contain specific translation keys (e.g.
// 'imageGenConnectionManager.loading'); a real i18next instance returns
// the key itself as a fallback when no translation is loaded, which is
// exactly the behaviour the assertions depend on. The previous mock
// (`{ useTranslation: () => ({ t: key => key }) }`) was redundant AND
// leaked into other test files: bun:test's `mock.module` is global and
// provides only the listed exports, which broke later tests that import
// `I18nextProvider` / `initReactI18next` from 'react-i18next' (e.g.
// CharacterLoraTab.test.tsx).

mock.module('lucide-react', () => ({
  Plus: () => null,
}))

mock.module('@dnd-kit/core', () => ({
  DndContext: TestDndContext,
  closestCenter: () => null,
}))

mock.module('@dnd-kit/sortable', () => ({
  SortableContext: TestSortableContext,
  verticalListSortingStrategy: () => null,
  arrayMove: testArrayMove,
}))

mock.module('../connection-manager/useConnectionDragAndDrop', () => ({
  useConnectionSensors: () => [],
  useVerticalSortModifier: () => () => null,
}))

mock.module('./ImageGenConnectionForm', () => ({
  default: () => null,
}))

mock.module('./ImageGenConnectionItem', () => ({
  default: TestImageGenConnectionItem,
}))

mock.module('@/components/shared/ConfirmationModal', () => ({
  default: () => null,
}))

let createRoot: typeof CreateRoot
let ImageGenConnectionManager: () => ReactNode
const mountedRoots: Array<{ root: Root; host: HTMLDivElement }> = []

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mountManager(): Promise<HTMLDivElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mountedRoots.push({ root, host })

  await act(async () => {
    root.render(<ImageGenConnectionManager />)
    await Promise.resolve()
  })

  return host
}

function resetStore() {
  useTestStore.setState({
    imageGenProfiles: [],
    imageGenProfilesLoaded: false,
    imageGenProfilesVersion: 0,
    imageGenProviders: [],
    activeImageGenConnectionId: null,
    imageGeneration: { activeImageGenConnectionId: null },
    connectionsOrder: { imageGen: [] },
  })
  persistedActiveConnectionIds.length = 0
}

beforeAll(async () => {
  // Dynamic import is intentional: JSDOM and Bun module mocks must exist first.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: ImageGenConnectionManager } = await import('./ImageGenConnectionManager'))
})

afterEach(async () => {
  const roots = mountedRoots.splice(0)
  await act(async () => {
    for (const { root } of roots) root.unmount()
  })
  resetStore()
  listRequest = null
  listRequestCount = 0
  providerRequestCount = 0
  document.body.replaceChildren()
})

describe('ImageGenConnectionManager background refresh', () => {
  test('does not let a stale cached refresh replace a locally selected profile or persist its fallback', async () => {
    const cached = profile('cached', true)
    const local = profile('local-selected')
    const staleFallback = profile('stale-fallback', true)
    listRequest = createDeferred<PaginatedResult<ImageGenConnectionProfile>>()

    useTestStore.setState({
      imageGenProfiles: [cached],
      imageGenProfilesLoaded: true,
      imageGenProfilesVersion: 41,
      imageGenProviders: [provider],
      activeImageGenConnectionId: cached.id,
      imageGeneration: { activeImageGenConnectionId: cached.id },
      connectionsOrder: { imageGen: [cached.id] },
    })

    const host = await mountManager()
    await flushEffects()

    expect(listRequestCount).toBe(1)
    expect(providerRequestCount).toBe(1)
    expect(host.textContent).toContain(cached.id)
    expect(host.textContent).not.toContain('imageGenConnectionManager.loading')

    await act(async () => {
      useTestStore.getState().addImageGenProfile(local)
      await Promise.resolve()
    })

    const localButton = host.querySelector<HTMLButtonElement>('[data-profile-id="local-selected"]')
    expect(localButton).not.toBeNull()
    if (!localButton) throw new Error('Local profile selection control was not rendered')

    await act(async () => {
      localButton.click()
      await Promise.resolve()
    })

    expect(useTestStore.getState().activeImageGenConnectionId).toBe(local.id)
    expect(host.querySelector('[data-active-profile="local-selected"]')).not.toBeNull()

    await act(async () => {
      listRequest?.resolve({
        data: [staleFallback],
        total: 1,
        limit: 1,
        offset: 0,
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useTestStore.getState().imageGenProfiles.map((item) => item.id)).toEqual([cached.id, local.id])
    expect(useTestStore.getState().activeImageGenConnectionId).toBe(local.id)
    expect(useTestStore.getState().imageGeneration.activeImageGenConnectionId).toBe(local.id)
    expect(host.querySelector('[data-active-profile="local-selected"]')).not.toBeNull()
    expect(persistedActiveConnectionIds).toEqual([local.id])
  })
})
