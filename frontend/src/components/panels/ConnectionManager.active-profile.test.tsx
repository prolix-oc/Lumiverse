import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ConnectionProfile } from '@/types/api'

const setActiveCalls: Array<string | null> = []

function profile(id: string): ConnectionProfile {
  return {
    id,
    name: id,
    provider: 'openai',
    api_url: '',
    model: 'gpt-test',
    preset_id: null,
    is_default: false,
    has_api_key: false,
    review_required: false,
    review_code: null,
    metadata: {},
    created_at: 1,
    updated_at: 1,
  }
}

const state = {
  profiles: [profile('alpha'), profile('beta')],
  providers: [{ id: 'openai', name: 'OpenAI', default_url: 'https://api.openai.com/v1' }],
  activeProfileId: 'alpha' as string | null,
  connectionsOrder: { llm: ['alpha', 'beta'], imageGen: [], stt: [], tts: [] },
  setProfiles(profiles: ConnectionProfile[]) {
    state.profiles = profiles
  },
  addProfile() {},
  updateProfile() {},
  removeProfile(id: string) {
    state.profiles = state.profiles.filter((item) => item.id !== id)
    if (state.activeProfileId === id) state.activeProfileId = null
  },
  setActiveProfile(id: string | null) {
    state.activeProfileId = id
    setActiveCalls.push(id)
  },
  setProviders() {},
  applyProfileOrder() {},
  setSetting() {},
}

const useStore = Object.assign(
  <T,>(selector: (value: typeof state) => T): T => selector(state),
  { getState: () => state },
)

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://lumiverse.test/' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  sessionStorage: dom.window.sessionStorage,
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

mock.module('@/store', () => ({ useStore }))
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: { name?: string }) => opts?.name ? `${key}:${opts.name}` : key }),
}))
mock.module('@/api/connections', () => ({
  connectionsApi: {
    providers: async () => ({ providers: state.providers }),
    delete: async () => undefined,
    create: async (input: ConnectionProfile) => input,
    duplicate: async (id: string) => profile(`${id}-copy`),
  },
}))
mock.module('@/api/listAllConnections', () => ({
  listAllConnections: async () => ({ data: state.profiles, total: state.profiles.length }),
}))
mock.module('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children?: ReactNode }) => <>{children}</>,
  closestCenter: () => null,
}))
mock.module('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children?: ReactNode }) => <>{children}</>,
  verticalListSortingStrategy: () => null,
  arrayMove: <T,>(items: T[]) => items,
}))
mock.module('./connection-manager/ConnectionForm', () => ({
  default: () => <div data-testid="connection-form" />,
}))
mock.module('./connection-manager/ConnectionItem', () => ({
  default: ({
    profile: item,
    isActive,
    onSelect,
  }: {
    profile: ConnectionProfile
    isActive: boolean
    onSelect: () => void
  }) => (
    <button type="button" data-profile-id={item.id} data-active={String(isActive)} onClick={onSelect}>
      {item.name}
    </button>
  ),
}))
mock.module('./connection-manager/useConnectionDragAndDrop', () => ({
  useConnectionSensors: () => [],
  useVerticalSortModifier: () => [],
}))
mock.module('@/components/shared/ConfirmationModal', () => ({
  default: () => null,
}))

const { default: ConnectionManager } = await import('./ConnectionManager')

let root: Root

beforeAll(() => {
  root = createRoot(document.getElementById('root')!)
})

afterEach(async () => {
  setActiveCalls.length = 0
  state.activeProfileId = 'alpha'
  state.profiles = [profile('alpha'), profile('beta')]
  await act(async () => {
    root.render(<div />)
  })
})

describe('ConnectionManager active profile', () => {
  test('persists a newly selected profile and treats an active-profile click as a no-op', async () => {
    await act(async () => {
      root.render(<ConnectionManager />)
    })
    const alpha = document.querySelector<HTMLButtonElement>('[data-profile-id="alpha"]')
    const beta = document.querySelector<HTMLButtonElement>('[data-profile-id="beta"]')
    expect(alpha?.dataset.active).toBe('true')
    expect(beta?.dataset.active).toBe('false')

    await act(async () => {
      beta!.click()
    })
    expect(setActiveCalls).toEqual(['beta'])
    expect(state.activeProfileId).toBe('beta')

    await act(async () => {
      root.render(<ConnectionManager />)
    })
    const betaAgain = document.querySelector<HTMLButtonElement>('[data-profile-id="beta"]')
    await act(async () => {
      betaAgain!.click()
    })
    expect(setActiveCalls).toEqual(['beta'])
    expect(state.activeProfileId).toBe('beta')
  })
})
