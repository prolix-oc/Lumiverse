import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { Preset, PresetRegistryItem, UpdatePresetInput } from '@/types/api'
import type { PromptBlock, PromptVariableDef, PromptVariableValues } from '@/lib/loom/types'

const presetId = 'preset-prompt-variable-regression'
const privatePresetId = 'preset-private-occurrence-regression'
const firstVariable: PromptVariableDef = {
  id: 'tone-first',
  name: 'tone',
  label: 'Tone',
  type: 'text',
  defaultValue: '',
}
const legacyDuplicateVariable: PromptVariableDef = {
  id: 'tone-second',
  name: 'tone',
  label: 'Tone (legacy duplicate)',
  type: 'text',
  defaultValue: '',
}
const validRenamedVariable: PromptVariableDef = {
  ...legacyDuplicateVariable,
  name: 'voice',
  label: 'Voice',
}
const chatBlock: PromptBlock = {
  id: 'chat',
  name: 'Chat',
  content: 'Hello',
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
  variables: [firstVariable, legacyDuplicateVariable],
}
const persistedPreset: Preset = {
  id: presetId,
  name: 'Prompt variable regression',
  provider: 'loom',
  parameters: {},
  prompt_order: [chatBlock],
  prompts: {},
  metadata: {
    promptVariables: { chat: { tone: 'legacy value' } },
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
  updated_at: 1,
}

const events: string[] = []
const updateCalls: Array<{ id: string; input: UpdatePresetInput }> = []
let resolvePersist: (() => void) | null = null
let pendingPersist: Promise<void> | null = null
let holdRegistryRefresh = false
let resolveRegistryRefresh: (() => void) | null = null
let pendingRegistryRefresh: Promise<void> | null = null

const storeState = {
  activeLoomPresetId: presetId,
  loomRegistry: { [presetId]: { name: persistedPreset.name, blockCount: 1, updatedAt: 1, isDefault: false } },
  setActiveLoomPreset: (_id: string | null) => {},
  setLoomRegistry: (_registry: Record<string, unknown>) => {},
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
    if (id !== presetId && id !== privatePresetId) throw new Error(`unexpected preset id: ${id}`)
    return structuredClone(persistedPreset)
  },
  update: async (id: string, input: UpdatePresetInput): Promise<Preset> => {
    updateCalls.push({ id, input: structuredClone(input) })
    events.push('persist:start')
    const persistGate = new Promise<void>((resolve) => { resolvePersist = resolve })
    pendingPersist = persistGate
    await persistGate
    events.push('persist:end')
    return {
      ...structuredClone(persistedPreset),
      ...input,
      id,
      parameters: input.parameters ?? persistedPreset.parameters,
      prompt_order: input.prompt_order ?? persistedPreset.prompt_order,
      prompts: input.prompts ?? persistedPreset.prompts,
      metadata: input.metadata ?? persistedPreset.metadata,
      updated_at: 2,
      cache_revision: 2,
    }
  },
  listRegistry: async (): Promise<{ data: PresetRegistryItem[]; total: number }> => {
    events.push('registry:refresh')
    if (holdRegistryRefresh) {
      const refreshGate = new Promise<void>((resolve) => { resolveRegistryRefresh = resolve })
      pendingRegistryRefresh = refreshGate
      await refreshGate
    }
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

// The hook must load after the store/API seams are installed; a static import would retain production modules.
const { useLoomBuilder } = await import('./useLoomBuilder')
mock.restore()

interface LoomBuilderTestSurface {
  activePreset: { blocks: PromptBlock[]; promptVariables: Record<string, Record<string, string>> } | null
  updateBlock(blockId: string, updates: Partial<PromptBlock>): boolean
  saveLoomValue(
    blocks: PromptBlock[],
    promptVariables: PromptVariableValues,
    privateBlockChange?: {
      blockId: string
      occurrence?: number
      patch: Partial<Pick<PromptBlock, 'sealed' | 'sealedKey' | 'sealedSource' | 'sealedOriginPresetId' | 'sealedOriginVersion' | 'sealedSha256'>>
    },
  ): Promise<void>
}

let hookSurface: LoomBuilderTestSurface
const mountedRoots = new Set<Root>()
let renderCount = 0
// Test harness intentionally performs non-reactive assignments to module-level
// test state so the suite can inspect hook outputs. This is safe only in tests.
/* eslint-disable react-compiler/react-compiler */
function HookHarness() {
  renderCount += 1
  hookSurface = useLoomBuilder() as unknown as LoomBuilderTestSurface
  return null
}
/* eslint-enable react-compiler/react-compiler */

async function renderHook(): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const client = await import('react-dom/client')
  const root = client.createRoot(host)
  mountedRoots.add(root)
  await act(async () => {
    root.render(createElement(HookHarness))
    await Promise.resolve()
    await Promise.resolve()
  })
  return { host, root }
}
function unmountRoot(root: Root): void {
  if (!mountedRoots.has(root)) return
  act(() => root.unmount())
  mountedRoots.delete(root)
}


afterEach(async () => {
  for (const root of [...mountedRoots]) unmountRoot(root)
  expect(mountedRoots.size).toBe(0)
  await act(async () => {
    resolvePersist?.()
    if (pendingPersist) await pendingPersist
    await Promise.resolve()
    await Promise.resolve()
    resolveRegistryRefresh?.()
    if (pendingRegistryRefresh) await pendingRegistryRefresh
    await Promise.resolve()
    await Promise.resolve()
  })
  resolvePersist = null
  pendingPersist = null
  resolveRegistryRefresh = null
  pendingRegistryRefresh = null
  holdRegistryRefresh = false
  events.length = 0
  updateCalls.length = 0
  document.body.replaceChildren()
})

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
})

describe('useLoomBuilder prompt-variable structure persistence', () => {
  test('repairs a legacy duplicate-name schema atomically and rejects a newly duplicate proposal', async () => {
    const { host, root } = await renderHook()
    try {
      let repaired = false
      await act(async () => {
        repaired = hookSurface.updateBlock('chat', {
          variables: [firstVariable, validRenamedVariable],
        })
      })

      expect(repaired).toBe(true)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(updateCalls).toHaveLength(1)
      expect(events).toEqual(['persist:start'])
      expect(updateCalls[0]?.input.prompt_order?.[0]?.variables).toEqual([
        firstVariable,
        validRenamedVariable,
      ])
      expect(updateCalls[0]?.input.metadata?.promptVariables).toEqual({
        chat: { tone: 'legacy value' },
      })

      await act(async () => {
        resolvePersist?.()
        resolvePersist = null
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(events).toEqual(['persist:start', 'persist:end', 'registry:refresh'])

      let duplicateProposal = false
      await act(async () => {
        duplicateProposal = hookSurface.updateBlock('chat', {
          variables: [firstVariable, { ...validRenamedVariable, name: 'tone' }],
        })
      })
      expect(duplicateProposal).toBe(false)
      expect(updateCalls).toHaveLength(1)
      expect(hookSurface.activePreset?.blocks[0]?.variables).toEqual([
        firstVariable,
        validRenamedVariable,
      ])
      expect(hookSurface.activePreset?.promptVariables).toEqual({
        chat: { tone: 'legacy value' },
      })
    } finally {
      unmountRoot(root)
      host.remove()
    }
  })
  test('unmounts while persistence is pending before releasing the write gate', async () => {
    const { host, root } = await renderHook()
    let updated = false
    await act(async () => {
      updated = hookSurface.updateBlock('chat', {
        variables: [firstVariable, { ...validRenamedVariable, label: 'pending update' }],
      })
    })
    expect(updated).toBe(true)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(events).toEqual(['persist:start'])

    unmountRoot(root)
    expect(mountedRoots.size).toBe(0)
    const renderCountAtUnmount = renderCount
    const persistence = pendingPersist
    await act(async () => {
      resolvePersist?.()
      resolvePersist = null
      if (persistence) await persistence
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(renderCount).toBe(renderCountAtUnmount)
    expect(updateCalls).toHaveLength(1)
    expect(events).toEqual(['persist:start', 'persist:end', 'registry:refresh'])
    host.remove()
  })
  test('does not settle successful persistence until shared registry refresh settles after unmount', async () => {
    const { host, root } = await renderHook()
    holdRegistryRefresh = true
    try {
      const blocks = structuredClone(hookSurface.activePreset?.blocks ?? [])
      let settled = false
      let persistence!: Promise<void>
      await act(async () => {
        persistence = hookSurface.saveLoomValue(blocks, { chat: { tone: 'saved value' } })
          .then(() => { settled = true })
        await Promise.resolve()
      })

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(events).toEqual(['persist:start'])

      const persistGate = pendingPersist
      await act(async () => {
        resolvePersist?.()
        resolvePersist = null
        if (persistGate) await persistGate
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(events).toEqual(['persist:start', 'persist:end', 'registry:refresh'])
      expect(settled).toBe(false)

      unmountRoot(root)
      expect(mountedRoots.size).toBe(0)
      await act(async () => {
        await Promise.resolve()
      })
      expect(settled).toBe(false)

      resolveRegistryRefresh?.()
      resolveRegistryRefresh = null
      await act(async () => {
        await persistence
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(settled).toBe(true)
      expect(events).toEqual(['persist:start', 'persist:end', 'registry:refresh'])
    } finally {
      host.remove()
    }
  })
  test('applies private block changes to an exact duplicate occurrence and rejects ambiguity', async () => {
    const originalPresetId = persistedPreset.id
    const originalActivePresetId = storeState.activeLoomPresetId
    const originalPromptOrder = persistedPreset.prompt_order
    const originalMetadata = persistedPreset.metadata
    let host: HTMLDivElement | null = null
    let root: Root | null = null
    try {
      storeState.activeLoomPresetId = privatePresetId
      persistedPreset.id = privatePresetId
      persistedPreset.prompt_order = [
      {
        ...chatBlock,
        id: 'duplicate',
        name: 'First duplicate',
        variables: [firstVariable],
        sealed: true,
        sealedKey: 'first-key',
        sealedSource: 'lumihub',
        sealedOriginPresetId: 'first-origin',
        sealedOriginVersion: 'v1',
        sealedSha256: 'first-sha',
      },
      {
        ...chatBlock,
        id: 'unique',
        name: 'Unique block',
        variables: [firstVariable],
        sealed: true,
        sealedKey: 'unique-key',
        sealedSource: 'lumihub',
        sealedOriginPresetId: 'unique-origin',
        sealedOriginVersion: 'v1',
        sealedSha256: 'unique-sha',
      },
      {
        ...chatBlock,
        id: 'duplicate',
        name: 'Second duplicate',
        variables: [firstVariable],
        sealed: true,
        sealedKey: 'second-key',
        sealedSource: 'lumihub',
        sealedOriginPresetId: 'second-origin',
        sealedOriginVersion: 'v2',
        sealedSha256: 'second-sha',
      },
    ]
    persistedPreset.metadata = {
      promptVariables: {
        duplicate: { tone: 'duplicate value' },
        unique: { tone: 'unique value' },
      },
    };
    ({ host, root } = await renderHook())
      const initialBlocks = structuredClone(hookSurface.activePreset?.blocks ?? [])
      let uniqueSave!: Promise<void>
      await act(async () => {
        uniqueSave = hookSurface.saveLoomValue(
          initialBlocks,
          { duplicate: { tone: 'duplicate value' }, unique: { tone: 'unique value' } },
          { blockId: 'unique', patch: { sealedKey: 'unique-updated' } },
        )
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(updateCalls).toHaveLength(1)
      const uniqueInput = updateCalls[0]!.input.prompt_order!
      expect(Reflect.get(uniqueInput[0]!, 'sealedKey')).toBe('first-key')
      expect(Reflect.get(uniqueInput[1]!, 'sealedKey')).toBe('unique-updated')
      expect(Reflect.get(uniqueInput[2]!, 'sealedKey')).toBe('second-key')
      const uniquePersist = pendingPersist
      await act(async () => {
        resolvePersist?.()
        resolvePersist = null
        if (uniquePersist) await uniquePersist
        await Promise.resolve()
        await Promise.resolve()
      })
      const uniqueRegistry = pendingRegistryRefresh
      await act(async () => {
        resolveRegistryRefresh?.()
        resolveRegistryRefresh = null
        if (uniqueRegistry) await uniqueRegistry
        await uniqueSave
      })

      let duplicateSave!: Promise<void>
      await act(async () => {
        duplicateSave = hookSurface.saveLoomValue(
          structuredClone(hookSurface.activePreset?.blocks ?? []),
          { duplicate: { tone: 'duplicate value' }, unique: { tone: 'unique value' } },
          { blockId: 'duplicate', occurrence: 1, patch: { sealedKey: 'second-updated' } },
        )
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(updateCalls).toHaveLength(2)
      const duplicateInput = updateCalls[1]!.input.prompt_order!
      expect(Reflect.get(duplicateInput[0]!, 'sealedKey')).toBe('first-key')
      expect(Reflect.get(duplicateInput[1]!, 'sealedKey')).toBe('unique-updated')
      expect(Reflect.get(duplicateInput[2]!, 'sealedKey')).toBe('second-updated')
      const duplicatePersist = pendingPersist
      await act(async () => {
        resolvePersist?.()
        resolvePersist = null
        if (duplicatePersist) await duplicatePersist
        await Promise.resolve()
        await Promise.resolve()
      })
      const duplicateRegistry = pendingRegistryRefresh
      await act(async () => {
        resolveRegistryRefresh?.()
        resolveRegistryRefresh = null
        if (duplicateRegistry) await duplicateRegistry
        await duplicateSave
      })

      const beforeAmbiguousPreset = structuredClone(hookSurface.activePreset)
      const ambiguousInputBlocks = structuredClone(hookSurface.activePreset?.blocks ?? [])
      const ambiguousInputValues = {
        duplicate: { tone: 'duplicate value' },
        unique: { tone: 'unique value' },
      }
      const beforeAmbiguousInputBlocks = structuredClone(ambiguousInputBlocks)
      const beforeAmbiguousInputValues = structuredClone(ambiguousInputValues)
      await expect(hookSurface.saveLoomValue(
        ambiguousInputBlocks,
        ambiguousInputValues,
        { blockId: 'duplicate', patch: { sealedKey: 'must-not-apply' } },
      )).rejects.toThrow('LOOM_AMBIGUOUS_BLOCK_OCCURRENCE')
      expect(updateCalls).toHaveLength(2)
      expect(ambiguousInputBlocks).toEqual(beforeAmbiguousInputBlocks)
      expect(ambiguousInputValues).toEqual(beforeAmbiguousInputValues)
      expect(hookSurface.activePreset).toEqual(beforeAmbiguousPreset)
    } finally {
      if (root) unmountRoot(root)
      host?.remove()
      persistedPreset.id = originalPresetId
      storeState.activeLoomPresetId = originalActivePresetId
      persistedPreset.prompt_order = originalPromptOrder
      persistedPreset.metadata = originalMetadata
    }
  })
})
