import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { AppStore } from '@/types/store'

type TestState = Record<string, unknown>

let state: TestState
let listeners: Array<(next: TestState, previous: TestState) => void>
const teardown: Array<() => void> = []

function resetState(): void {
  state = {
    activeModal: 'chat-settings',
    modalProps: { secret: 'must not escape' },
    drawerOpen: true,
    drawerTab: 'characters',
    settingsModalOpen: false,
    settingsActiveView: 'general',
    activeChatId: 'chat-1',
    activeCharacterId: 'character-1',
    activeChatAvatarId: 'avatar-1',
    messages: [{ id: 'message-1', content: 'hello' }],
    favorites: ['character-1'],
    filterTab: 'all',
    sortField: 'name',
    sortDirection: 'asc',
    viewMode: 'grid',
    editingCharacterId: 'character-2',
    profiles: [{
      id: 'profile-1',
      name: 'Main',
      provider: 'openai',
      api_url: '',
      model: 'gpt-test',
      preset_id: null,
      is_default: true,
      has_api_key: true,
      metadata: { label: 'safe' },
      created_at: 1,
      updated_at: 1,
      api_key: 'secret-must-not-escape',
    }],
    activeProfileId: 'profile-1',
    activatedWorldInfo: [{
      id: 'entry-1',
      comment: 'activation',
      keys: ['dragon'],
      source: 'keyword',
      activationType: 'keyword',
      activationOrder: 0,
      firstTriggeredForBook: true,
      estimatedTokens: 12,
      priority: 0,
      position: 0,
      depth: 0,
      preventRecursion: false,
      bookId: 'book-1',
      bookName: 'Book',
    }],
    activeLoomPresetId: 'loom-1',
    activePersonaId: 'persona-1',
    testSetting: { nested: true },
  }
  listeners = []
  teardown.splice(0)
}

resetState()

const mockedUseStore = {
  getState: () => state as unknown as AppStore,
  subscribe(listener: (next: AppStore, previous?: AppStore) => void) {
    const tracked = listener as unknown as (next: TestState, previous: TestState) => void
    listeners.push(tracked)
    return () => {
      const index = listeners.indexOf(tracked)
      if (index !== -1) listeners.splice(index, 1)
    }
  },
}
mock.module('@/store', () => ({ useStore: mockedUseStore }))

const { createStateSelectors } = await import('./state-selectors')

function update(patch: TestState): void {
  const previous = state
  state = { ...state, ...patch }
  for (const listener of [...listeners]) listener(state, previous)
}

function createSelectors(granted: readonly string[] = []) {
  return createStateSelectors({
    store: mockedUseStore,
    assertActive: () => {},
    grantedPermissions: () => granted,
    resolveAuthority: (id) => ({ permission: id === 'characters.editingId' ? 'characters' : null }),
    onTeardown: (handler) => {
      teardown.push(handler)
      return () => {
        const index = teardown.indexOf(handler)
        if (index !== -1) teardown.splice(index, 1)
      }
    },
    settingIds: ['testSetting'],
  })
}

afterEach(() => {
  for (const handler of [...teardown]) handler()
  resetState()
})

describe('H2 state selector registry', () => {
  test('publishes the exact phase-one selector ids and setting seam', () => {
    const selectors = createSelectors()
    expect(selectors.list().map((item) => item.id)).toEqual([
      'ui.activeModal',
      'ui.drawer',
      'ui.settings',
      'ui.layout',
      'chat.active',
      'chat.messageCount',
      'characters.favorites',
      'characters.browser',
      'characters.editingId',
      'connections.active',
      'connections.profiles',
      'worldInfo.activated',
      'worldInfo.selectedEntryId',
      'loom.activePresetId',
      'persona.activeId',
      'setting:testSetting',
    ])
    expect(selectors.list().find((item) => item.id === 'characters.editingId')?.permission).toBe('characters')
  })

  test('returns cloned, redacted projections', () => {
    const selectors = createSelectors()
    const favorites = selectors.get<string[]>('characters.favorites')
    favorites.push('caller-mutation')
    expect(state.favorites).toEqual(['character-1'])

    const profiles = selectors.get<Array<Record<string, unknown>>>('connections.profiles')
    profiles[0]!.metadata = { corrupted: true }
    expect((state.profiles as Array<Record<string, unknown>>)[0]!.metadata).toEqual({ label: 'safe' })
    expect(profiles[0]).not.toHaveProperty('api_key')

    expect(selectors.get<{ activeModal: string | null }>('ui.activeModal')).toEqual({ activeModal: 'chat-settings' })
    expect(selectors.get<{ activeModal: string | null }>('ui.activeModal')).not.toHaveProperty('modalProps')
    expect(selectors.get<unknown[]>('worldInfo.activated')).toEqual([{
      id: 'entry-1',
      comment: 'activation',
      keys: ['dragon'],
      source: 'keyword',
      bookId: 'book-1',
      bookName: 'Book',
    }])
  })

  test('gates protected selectors and rejects unknown selectors', () => {
    const selectors = createSelectors()
    expect(() => selectors.get('characters.editingId')).toThrow('PERMISSION_DENIED:characters')
    expect(() => selectors.get('selector.nope')).toThrow('SELECTOR_UNKNOWN:selector.nope')

    const granted = createSelectors(['characters'])
    expect(granted.get<string | null>('characters.editingId')).toBe('character-2')
  })

  test('coalesces equal values and clones every subscription delivery per subscriber', () => {
    const selectors = createSelectors()
    const first: Array<Record<string, unknown>> = []
    const second: Array<Record<string, unknown>> = []
    const unsubscribeFirst = selectors.subscribe('ui.drawer', (value) => first.push(value as Record<string, unknown>))
    const unsubscribeSecond = selectors.subscribe('ui.drawer', (value) => second.push(value as Record<string, unknown>))

    update({ drawerOpen: true })
    expect(first).toHaveLength(0)
    update({ drawerOpen: false })
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0]).not.toBe(second[0])
    first[0]!.open = 'caller-mutation'
    expect(second[0]!.open).toBe(false)

    unsubscribeFirst()
    unsubscribeSecond()
    expect(listeners).toHaveLength(0)
  })

  test('publishes ui.layout on viewport and UI-scale signals and tears listeners down', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const originalComputedStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
    const originalMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
    const viewport = new EventTarget()
    const fakeWindow = new EventTarget() as EventTarget & { visualViewport: EventTarget; innerWidth: number; innerHeight: number }
    fakeWindow.visualViewport = viewport
    fakeWindow.innerWidth = 1000
    fakeWindow.innerHeight = 900
    let bodyHeight = 900
    let uiScale = 1
    let observerCallback: MutationCallback | undefined
    let disconnects = 0
    const root = {}
    const body = {
      getBoundingClientRect: () => ({ width: 1000, height: bodyHeight }),
    }
    class TestMutationObserver {
      constructor(callback: MutationCallback) { observerCallback = callback }
      observe() {}
      disconnect() { disconnects += 1 }
    }

    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        documentElement: root,
        querySelector: (selector: string) => selector === '.body' ? body : null,
      },
    })
    Object.defineProperty(globalThis, 'getComputedStyle', {
      configurable: true,
      value: () => ({ getPropertyValue: () => String(uiScale) }),
    })
    Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: TestMutationObserver })

    try {
      const selectors = createSelectors()
      const values: Array<{ chatRowHeight: number; uiScale: number }> = []
      const unsubscribe = selectors.subscribe('ui.layout', value => values.push(value as { chatRowHeight: number; uiScale: number }))

      fakeWindow.dispatchEvent(new Event('resize'))
      expect(values).toHaveLength(0)
      bodyHeight = 800
      fakeWindow.dispatchEvent(new Event('resize'))
      expect(values.at(-1)).toMatchObject({ chatRowHeight: 800, uiScale: 1 })
      uiScale = 2
      observerCallback?.([], {} as MutationObserver)
      expect(values.at(-1)).toMatchObject({ chatRowHeight: 400, uiScale: 2 })

      unsubscribe()
      bodyHeight = 700
      fakeWindow.dispatchEvent(new Event('resize'))
      expect(values).toHaveLength(2)
      expect(disconnects).toBe(1)
    } finally {
      for (const [name, descriptor] of [
        ['window', originalWindow],
        ['document', originalDocument],
        ['getComputedStyle', originalComputedStyle],
        ['MutationObserver', originalMutationObserver],
      ] as const) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
  })

  test('stops protected subscriptions on permission revocation and teardown', () => {
    const granted = ['characters']
    const selectors = createSelectors(granted)
    let calls = 0
    selectors.subscribe('characters.editingId', () => { calls += 1 })
    expect(listeners).toHaveLength(1)
    selectors.revokePermissions(['characters'])
    expect(listeners).toHaveLength(0)
    update({ editingCharacterId: 'character-3' })
    expect(calls).toBe(0)
    granted.splice(0)
    expect(() => selectors.get('characters.editingId')).toThrow('PERMISSION_DENIED:characters')

    selectors.dispose()
    expect(listeners).toHaveLength(0)
  })

  test('fails closed when a selector value cannot be structured-cloned', () => {
    const selectors = createSelectors()
    update({ favorites: [() => 'not cloneable'] })
    expect(() => selectors.get('characters.favorites')).toThrow()
  })
})
