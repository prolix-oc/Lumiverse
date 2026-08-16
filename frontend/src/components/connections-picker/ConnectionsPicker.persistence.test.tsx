import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ConnectionProfile } from '@/types/api'
import { DEFAULT_CONNECTIONS_PICKER_SETTINGS } from '@/lib/uiProductivityDefaults'

const modelsCalls: Array<{ id: string; cacheBust: boolean }> = []
const setActiveCalls: Array<string | null> = []
const settingPatches: Array<Record<string, unknown>> = []
type ModelsResult = { models: string[]; model_labels: Record<string, string> }

let modelsImpl = async (_id: string, _cacheBust: boolean): Promise<ModelsResult> => ({
  models: ['gpt-4', 'gpt-4o-mini', 'claude-3'],
  model_labels: { 'gpt-4': 'GPT 4' },
})

function profile(id: string, model = 'gpt-4'): ConnectionProfile {
  return {
    id,
    name: id,
    provider: 'openai',
    api_url: '',
    model,
    preset_id: null,
    is_default: false,
    has_api_key: false,
    metadata: {},
    created_at: 1,
    updated_at: 1,
  }
}

const state = {
  connectionsPickerSettings: {
    ...DEFAULT_CONNECTIONS_PICKER_SETTINGS,
    variant: 'split' as const,
    modelLayout: 'grid' as 'grid' | 'list',
    enabled: true,
    showSearch: true,
    positionInitialized: true,
  },
  profiles: [profile('alpha'), profile('beta')],
  activeProfileId: 'alpha' as string | null,
  setActiveProfile(id: string | null) {
    state.activeProfileId = id
    setActiveCalls.push(id)
  },
  updateProfile(id: string, updates: Partial<ConnectionProfile>) {
    state.profiles = state.profiles.map((item) => item.id === id ? { ...item, ...updates } : item)
  },
  setProfiles(profiles: ConnectionProfile[]) {
    state.profiles = profiles
  },
  setSetting(key: string, value: unknown) {
    if (key === 'connectionsPickerSettings') {
      state.connectionsPickerSettings = value as typeof state.connectionsPickerSettings
      settingPatches.push(value as Record<string, unknown>)
    }
  },
  openDrawer() {},
}

const useStore = Object.assign(
  <T,>(selector: (value: typeof state) => T): T => selector(state),
  {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => Object.assign(state, partial),
  },
)

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test/' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

mock.module('@/store', () => ({ useStore }))
mock.module('@/api/connections', () => ({
  connectionsApi: {
    models: async (id: string) => {
      modelsCalls.push({ id, cacheBust: false })
      return modelsImpl(id, false)
    },
    update: async (id: string, input: Partial<ConnectionProfile>) => {
      const current = state.profiles.find((item) => item.id === id)!
      return { ...current, ...input }
    },
  },
}))
mock.module('@/api/client', () => ({
  get: async (path: string, params?: Record<string, unknown>) => {
    const id = path.split('/')[2] ?? ''
    modelsCalls.push({ id, cacheBust: Boolean(params?._ts) })
    return modelsImpl(id, Boolean(params?._ts))
  },
}))
mock.module('@/components/shared/ResizablePanelFrame', () => ({
  ResizablePanelFrame: ({ children, toolbar }: { children?: ReactNode; toolbar?: ReactNode }) => (
    <div>
      {toolbar}
      {children}
    </div>
  ),
}))

const { ConnectionsPicker, filterModelsForQuery, shouldApplyModelsResponse } = await import('./ConnectionsPicker')

let root: Root
let host: HTMLDivElement

beforeAll(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  modelsCalls.length = 0
  setActiveCalls.length = 0
  settingPatches.length = 0
  state.activeProfileId = 'alpha'
  state.profiles = [profile('alpha'), profile('beta')]
  state.connectionsPickerSettings = {
    ...DEFAULT_CONNECTIONS_PICKER_SETTINGS,
    variant: 'split',
    modelLayout: 'grid',
    enabled: true,
    showSearch: true,
    positionInitialized: true,
  }
  modelsImpl = async () => ({
    models: ['gpt-4', 'gpt-4o-mini', 'claude-3'],
    model_labels: { 'gpt-4': 'GPT 4' },
  })
  await act(async () => {
    root.render(<div />)
  })
})

async function renderPicker() {
  await act(async () => {
    root.render(<ConnectionsPicker open onClose={() => undefined} />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

describe('ConnectionsPicker persistence', () => {
  test('cold-starts from hydrated activeProfileId and persists picker-local selection', async () => {
    await renderPicker()
    const portal = document.querySelector('[data-component="ConnectionsPicker"]')
    expect(portal).not.toBeNull()
    expect(document.querySelector('[data-profile-id="alpha"]')?.getAttribute('data-profile-active')).toBe('true')

    const beta = document.querySelector<HTMLButtonElement>('[data-profile-id="beta"] button')
      ?? [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('beta'))
    expect(beta).toBeTruthy()
    await act(async () => {
      beta!.click()
    })
    expect(setActiveCalls).toEqual(['beta'])
    expect(state.activeProfileId).toBe('beta')
  })

  test('persists grid and list modelLayout', async () => {
    await renderPicker()
    const listButton = document.querySelector<HTMLButtonElement>('[aria-label="List layout"]')
    expect(listButton).toBeTruthy()
    await act(async () => {
      listButton!.click()
    })
    expect(state.connectionsPickerSettings.modelLayout).toBe('list')
    await renderPicker()
    expect(document.querySelector('[data-model-layout="list"]')).not.toBeNull()

    const gridButton = document.querySelector<HTMLButtonElement>('[aria-label="Grid layout"]')
    await act(async () => {
      gridButton!.click()
    })
    expect(state.connectionsPickerSettings.modelLayout).toBe('grid')
    await renderPicker()
    expect(document.querySelector('[data-model-layout="grid"]')).not.toBeNull()
  })

  test('live search filters models for the selected profile', async () => {
    await renderPicker()
    expect(document.querySelector('[data-visible-models]')?.getAttribute('data-visible-models')).toContain('gpt-4o-mini')
    expect(document.querySelector('input[placeholder*="Search"]')).toBeTruthy()
    expect(filterModelsForQuery(
      ['gpt-4', 'gpt-4o-mini', 'claude-3'],
      { 'gpt-4': 'GPT 4' },
      'claude',
    )).toEqual(['claude-3'])
    expect(filterModelsForQuery(
      ['gpt-4', 'gpt-4o-mini', 'claude-3'],
      { 'gpt-4': 'GPT 4' },
      'gpt 4',
    )).toEqual(['gpt-4'])
  })

  test('refresh cache-busts and ignores stale or deleted responses', async () => {
    const first = Promise.withResolvers<ModelsResult>()
    const second = Promise.withResolvers<ModelsResult>()
    const queue = [first, second]
    modelsImpl = async () => {
      const next = queue.shift()
      if (!next) throw new Error('unexpected extra models request')
      return next.promise
    }
    await renderPicker()
    expect(document.querySelector('[data-models-loading="true"]')).not.toBeNull()

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Refresh models"]')!.click()
    })

    await act(async () => {
      first.resolve({ models: ['stale-model'], model_labels: {} })
      await Promise.resolve()
    })
    expect(document.body.textContent).not.toContain('stale-model')

    await act(async () => {
      second.resolve({ models: ['fresh-model'], model_labels: {} })
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('fresh-model')
    expect(modelsCalls.some((call) => call.cacheBust)).toBe(true)

    expect(shouldApplyModelsResponse({
      requestId: 1,
      currentRequestId: 2,
      requestedProfileId: 'alpha',
      selectedProfileId: 'alpha',
      profiles: [{ id: 'alpha' }],
    })).toBe(false)
    expect(shouldApplyModelsResponse({
      requestId: 2,
      currentRequestId: 2,
      requestedProfileId: 'alpha',
      selectedProfileId: 'alpha',
      profiles: [{ id: 'beta' }],
    })).toBe(false)
    expect(shouldApplyModelsResponse({
      requestId: 2,
      currentRequestId: 2,
      requestedProfileId: 'alpha',
      selectedProfileId: 'alpha',
      profiles: [{ id: 'alpha' }],
    })).toBe(true)
  })

  test('model pick does not remount the grid or restart the spinner', async () => {
    await renderPicker()
    const before = modelsCalls.filter((call) => !call.cacheBust).length
    expect(document.querySelector('[data-models-loading="true"]')).toBeNull()
    const modelButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('gpt-4o-mini'))
    expect(modelButton).toBeTruthy()
    await act(async () => {
      modelButton!.click()
      await Promise.resolve()
    })
    expect(document.querySelector('[data-models-loading="true"]')).toBeNull()
    expect(modelsCalls.filter((call) => !call.cacheBust).length).toBe(before)
  })
})
