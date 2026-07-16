import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { Preset, PresetRegistryItem, UpdatePresetInput } from '@/types/api'
import type { PromptBlock } from '@/lib/loom/types'

const presetId = 'preset-delete-regression'
const deletedBlock: PromptBlock = {
  id: 'deleted-block',
  name: 'Deleted block',
  content: 'remove me',
  role: 'system',
  enabled: true,
  position: 'pre_history',
  depth: 0,
  marker: null,
  isLocked: false,
  color: null,
  injectionTrigger: [],
  characterTagTrigger: [],
  group: null,
  categoryMode: null,
  variables: [{ id: 'deleted-answer', name: 'answer', label: 'Answer', type: 'text', defaultValue: '' }],
}
const remainingBlock: PromptBlock = {
  id: 'remaining-block',
  name: 'Remaining block',
  content: 'keep me',
  role: 'system',
  enabled: true,
  position: 'pre_history',
  depth: 0,
  marker: null,
  isLocked: false,
  color: null,
  injectionTrigger: [],
  characterTagTrigger: [],
  group: 'deleted-block',
  categoryMode: null,
  variables: [{ id: 'remaining-answer', name: 'answer', label: 'Answer', type: 'text', defaultValue: '' }],
}
const persistedPreset: Preset = {
  id: presetId,
  name: 'Delete regression',
  provider: 'loom',
  parameters: {},
  prompt_order: [deletedBlock, remainingBlock],
  prompts: {},
  metadata: {
    description: '',
    promptVariables: {
      'deleted-block': { answer: 'discard me' },
      'remaining-block': { answer: 'keep me' },
    },
  },
  created_at: 1,
  updated_at: 1,
  cache_revision: 1,
}
const registryItem: PresetRegistryItem = {
  id: presetId,
  name: persistedPreset.name,
  provider: 'loom',
  block_count: 1,
  updated_at: 2,
}

const events: string[] = []
const updateCalls: Array<{ id: string; input: UpdatePresetInput }> = []
let resolvePersist: (() => void) | null = null
let resolveRegistry: (() => void) | null = null
let registryUpdates: Array<Record<string, unknown>> = []

const storeState = {
  activeLoomPresetId: presetId,
  loomRegistry: { [presetId]: { name: persistedPreset.name, blockCount: 2, updatedAt: 1, isDefault: false } },
  setActiveLoomPreset: (_id: string | null) => {},
  setLoomRegistry: (registry: Record<string, unknown>) => {
    registryUpdates.push(registry)
  },
  activeProfileId: null,
  profiles: [],
  providers: [],
}
const useStoreMock = Object.assign(
  <T,>(selector: (state: typeof storeState) => T): T => selector(storeState),
  { getState: () => storeState },
)

const presetsApiMock = {
  get: async (id: string): Promise<Preset> => {
    if (id !== presetId) throw new Error(`unexpected preset id: ${id}`)
    return persistedPreset
  },
  update: async (id: string, input: UpdatePresetInput): Promise<Preset> => {
    updateCalls.push({ id, input })
    events.push('persist:start')
    await new Promise<void>((resolve) => { resolvePersist = resolve })
    events.push('persist:end')
    return {
      ...persistedPreset,
      ...input,
      id,
      provider: 'loom',
      parameters: input.parameters ?? persistedPreset.parameters,
      prompt_order: input.prompt_order ?? persistedPreset.prompt_order,
      prompts: input.prompts ?? persistedPreset.prompts,
      metadata: input.metadata ?? persistedPreset.metadata,
      updated_at: 2,
      cache_revision: 2,
    }
  },
  listRegistry: async (): Promise<{ data: PresetRegistryItem[]; total: number }> => {
    events.push('registry:start')
    await new Promise<void>((resolve) => { resolveRegistry = resolve })
    events.push('registry:end')
    return { data: [registryItem], total: 1 }
  },
}

mock.module('@/store', () => ({ useStore: useStoreMock }))
mock.module('@/api/presets', () => ({ presetsApi: presetsApiMock }))
mock.module('@/api/macros', () => ({
  getMacroCatalog: async () => ({ categories: [] }),
  resolveMacros: async () => ({ text: 'resolved', diagnostics: [] }),
  resolveMacrosBatch: async () => ({ resolved: {} }),
}))
mock.module('@/i18n', () => ({ default: { t: (key: string) => key, language: 'en' } }))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['navigator', globalObject.navigator],
  ['Node', globalObject.Node],
  ['Element', globalObject.Element],
  ['HTMLElement', globalObject.HTMLElement],
  ['SVGElement', globalObject.SVGElement],
  ['IS_REACT_ACT_ENVIRONMENT', globalObject.IS_REACT_ACT_ENVIRONMENT],
])
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  SVGElement: dom.window.SVGElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})

// The hook must load after the store/API seams are installed; static import would retain production modules.
const { useLoomBuilder } = await import('./useLoomBuilder')
mock.restore()

interface LoomBuilderTestSurface {
  removeBlock(blockId: string): Promise<void>
}

let hookSurface: LoomBuilderTestSurface
function HookHarness() {
  hookSurface = useLoomBuilder()
  return null
}


async function waitForEvent(event: string): Promise<void> {
  for (let attempt = 0; attempt < 8 && !events.includes(event); attempt += 1) {
    await Promise.resolve()
  }
}

afterEach(async () => {
  await act(async () => {
    resolvePersist?.()
    resolveRegistry?.()
    await Promise.resolve()
    await Promise.resolve()
  })
  resolvePersist = null
  resolveRegistry = null
  events.length = 0
  updateCalls.length = 0
  registryUpdates.length = 0
  document.body.replaceChildren()
})
afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
})

describe('useLoomBuilder removeBlock persistence', () => {
  test('persists reconciled blocks once and refreshes the registry before resolving', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    let root: Root | null = null
    let deletion: Promise<void> | null = null
    try {
      const client = await import('react-dom/client')
      root = client.createRoot(host)
      await act(async () => {
        root?.render(createElement(HookHarness))
        await Promise.resolve()
        await Promise.resolve()
      })

      let deletionResolved = false
      await act(async () => {
        deletion = hookSurface.removeBlock('deleted-block').then(() => {
          deletionResolved = true
        })
        await Promise.resolve()
      })
      await waitForEvent('persist:start')

      expect(updateCalls).toHaveLength(1)
      expect(updateCalls[0]?.id).toBe(presetId)
      expect(updateCalls[0]?.input.prompt_order).toEqual([
        { ...remainingBlock, group: null },
      ])
      expect(updateCalls[0]?.input.metadata?.promptVariables).toEqual({
        'remaining-block': { answer: 'keep me' },
      })
      expect(events).toEqual(['persist:start'])

      await act(async () => {
        resolvePersist?.()
        await Promise.resolve()
        await Promise.resolve()
      })
      await waitForEvent('registry:start')
      expect(events).toEqual(['persist:start', 'persist:end', 'registry:start'])
      expect(deletionResolved).toBe(false)

      await act(async () => {
        resolveRegistry?.()
        await deletion
      })
      expect(deletionResolved).toBe(true)
      expect(updateCalls).toHaveLength(1)
      expect(events).toEqual(['persist:start', 'persist:end', 'registry:start', 'registry:end'])
      expect(registryUpdates).toHaveLength(1)
      expect(registryUpdates[0]).toMatchObject({
        [presetId]: { blockCount: 1 },
      })
    } finally {
      await act(async () => {
        resolvePersist?.()
        resolveRegistry?.()
        root?.unmount()
        await Promise.resolve()
      })
      if (deletion) await deletion.catch(() => {})
      host.remove()
    }
  })
})
