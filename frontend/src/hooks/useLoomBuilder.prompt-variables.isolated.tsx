import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { Preset, PresetRegistryItem, UpdatePresetInput } from '@/types/api'
import type { PresetDuplicateResult } from '@/api/presets'
import type { PromptBlock, PromptVariableDef, PromptVariableValues } from '@/lib/loom/types'
import type { LoomBlockOccurrence } from './useLoomBuilder'

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
  engine: 'classic',
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
const sealedDescriptor = {
  hubPresetId: 'hub-preset',
  hubPresetVersion: '7',
  blocks: [{ key: 'private-system', sha256: 'a'.repeat(64) }],
}
const descriptorOnlyImportPayload = {
  name: 'Descriptor-only sealed import',
  engine: 'classic',
  blocks: [{
    ...chatBlock,
    id: 'private-system',
    name: 'Private system',
    content: '{{presetBlock::private-system}}',
    variables: [],
    sealed: true,
    sealedSource: 'lumihub' as const,
    sealedKey: 'private-system',
  }],
  portableSealedPreset: sealedDescriptor,
}
const importedSealedPreset: Preset = {
  ...structuredClone(persistedPreset),
  id: 'imported-sealed',
  name: descriptorOnlyImportPayload.name,
  prompt_order: descriptorOnlyImportPayload.blocks,
  metadata: { portableSealedPreset: sealedDescriptor },
  cache_revision: 0,
}
const legacyGraphImportPayload = {
  name: 'Legacy graph import',
  engine: 'classic',
  blocks: [{ ...chatBlock, variables: [] }],
  agentConfig: { profiles: [] },
  agentTaskTemplates: [{ id: 'legacy-task', required: true, label: 'Legacy task' }],
}
const plainImportPayload = {
  name: 'Plain import',
  engine: 'classic',
  blocks: [{ ...chatBlock, variables: [] }],
}
const sealedBlockWithoutDescriptorImportPayload = {
  ...plainImportPayload,
  blocks: [{
    ...plainImportPayload.blocks[0],
    id: 'private-system',
    name: 'Private system',
    content: 'secret sealed text',
    sealed: true,
    sealedKey: 'private-system',
  }],
}
const lumihubBlockWithMalformedDescriptorImportPayload = {
  ...plainImportPayload,
  blocks: [{
    ...plainImportPayload.blocks[0],
    id: 'private-system',
    name: 'Private system',
    content: 'secret sealed text',
    sealedSource: 'lumihub' as const,
    sealedKey: 'private-system',
  }],
  portableSealedPreset: {
    ...sealedDescriptor,
    blocks: [{ key: 'private-system', sha256: 'not-a-digest' }],
  },
}
const descriptorWithStrippedSealedFlagsImportPayload = {
  ...plainImportPayload,
  blocks: [{
    ...plainImportPayload.blocks[0],
    id: 'private-system',
    name: 'Private system',
    content: 'plaintext that must not escape',
    sealedKey: 'private-system',
  }],
  portableSealedPreset: sealedDescriptor,
}
const descriptorWithExtraKeyImportPayload = {
  ...descriptorOnlyImportPayload,
  portableSealedPreset: {
    ...sealedDescriptor,
    blocks: [
      ...sealedDescriptor.blocks,
      { key: 'extra-key', sha256: 'b'.repeat(64) },
    ],
  },
}
const descriptorWithDifferentKeyImportPayload = {
  ...descriptorOnlyImportPayload,
  portableSealedPreset: {
    ...sealedDescriptor,
    blocks: [{ key: 'different-key', sha256: 'a'.repeat(64) }],
  },
}

const validPortableRegex = [{ name: 'Portable regex', find_regex: 'x', replace_string: 'y' }]
const dualRegexImportPayload = {
  ...plainImportPayload,
  extensions: { regex_scripts: validPortableRegex },
  regex_scripts: validPortableRegex,
}
const malformedRegexImportPayload = {
  ...plainImportPayload,
  extensions: { regex_scripts: 'not-an-array' },
}


const events: string[] = []
const duplicateCalls: Array<{ id: string; name?: string }> = []
const updateCalls: Array<{ id: string; input: UpdatePresetInput }> = []
const createCalls: unknown[] = []
const portableImportCalls: unknown[] = []
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
      engine: input.engine ?? persistedPreset.engine,
      parameters: input.parameters ?? persistedPreset.parameters,
      prompt_order: input.prompt_order ?? persistedPreset.prompt_order,
      prompts: input.prompts ?? persistedPreset.prompts,
      metadata: input.metadata ?? persistedPreset.metadata,
      updated_at: 2,
      cache_revision: 2,
    }
  },
  create: async (input: unknown): Promise<Preset> => {
    createCalls.push(structuredClone(input))
    throw new Error('ordinary preset create must not be called for sealed imports')
  },
  importPortable: async (input: unknown): Promise<{ preset: Preset }> => {
    portableImportCalls.push(structuredClone(input))
    return { preset: structuredClone(importedSealedPreset) }
  },
  importPortableAgentConfig: async (): Promise<{ preset: Preset }> => {
    throw new Error('legacy portable config import is not expected for this fixture')
  },
  duplicate: async (id: string, name?: string): Promise<PresetDuplicateResult> => {
    duplicateCalls.push({ id, name })
    return {
      preset: {
        ...structuredClone(persistedPreset),
        id: 'preset-duplicate',
        name: name ?? 'Prompt variable regression copy',
        cache_revision: 0,
      },
      agent_config: null,
      agent_config_review: null,
      copiedRegexScriptIds: ['regex-copy'],
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
// The hook receives its API seam explicitly so this focused harness cannot
// replace the shared presets module for tests that exercise the real API.
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
const { useLoomBuilder, remapCategorySnapshotsForReorder } = await import('./useLoomBuilder')
const injectedPresetsApi = presetsApiMock as unknown as Parameters<typeof useLoomBuilder>[0]['presetsApi']
mock.restore()

interface LoomBuilderTestSurface {
  activePreset: { blocks: PromptBlock[]; promptVariables: Record<string, Record<string, string>> } | null
  applyRuntimeBlockProfile(
    presetId: string,
    blockStates: Record<string, boolean> | null,
    promptVariables?: PromptVariableValues,
  ): void
  updateBlock(target: LoomBlockOccurrence, updates: Partial<PromptBlock>): boolean
  addBlock(block: PromptBlock, index?: number): void
  movePromptVariable(source: LoomBlockOccurrence, variable: PromptVariableDef, target: LoomBlockOccurrence): boolean
  toggleCategoryChildren(target: LoomBlockOccurrence): void
  duplicatePreset(presetId: string, newName: string): Promise<{ id: string; name: string }>
  saveLoomValue(
    blocks: PromptBlock[],
    promptVariables: PromptVariableValues,
  ): Promise<void>
  importFromFile(payload: unknown, fileName?: string): Promise<unknown>
}

let hookSurface: LoomBuilderTestSurface
const mountedRoots = new Set<Root>()
let renderCount = 0
// Test harness intentionally performs non-reactive assignments to module-level
// test state so the suite can inspect hook outputs. This is safe only in tests.
/* eslint-disable react-compiler/react-compiler */
function HookHarness() {
  renderCount += 1
  hookSurface = useLoomBuilder({ presetsApi: injectedPresetsApi }) as unknown as LoomBuilderTestSurface
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
  duplicateCalls.length = 0
  createCalls.length = 0
  portableImportCalls.length = 0
  document.body.replaceChildren()
})

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
})

describe('useLoomBuilder prompt-variable structure persistence', () => {
  test('applies and clears profile block states without persisting the shared preset', async () => {
    const { host, root } = await renderHook()
    try {
      expect(hookSurface.activePreset?.blocks[0]?.enabled).toBe(true)

      await act(async () => {
        hookSurface.applyRuntimeBlockProfile(presetId, { chat: false }, {})
      })
      expect(hookSurface.activePreset?.blocks[0]?.enabled).toBe(false)
      expect(hookSurface.activePreset?.promptVariables).toEqual({ chat: { tone: 'legacy value' } })

      await act(async () => {
        hookSurface.applyRuntimeBlockProfile(presetId, { chat: false }, { chat: { profileOnly: 'scoped' } })
      })
      expect(hookSurface.activePreset?.promptVariables).toEqual({
        chat: { tone: 'legacy value', profileOnly: 'scoped' },
      })


      await act(async () => {
        hookSurface.applyRuntimeBlockProfile(presetId, { chat: false }, { chat: { tone: 'scoped' } })
      })
      expect(hookSurface.activePreset?.blocks[0]?.enabled).toBe(false)
      expect(hookSurface.activePreset?.promptVariables).toEqual({ chat: { tone: 'scoped' } })
      expect(updateCalls).toHaveLength(0)

      await act(async () => {
        hookSurface.applyRuntimeBlockProfile(presetId, null)
      })
      expect(hookSurface.activePreset?.blocks[0]?.enabled).toBe(true)
      expect(updateCalls).toHaveLength(0)
    } finally {
      unmountRoot(root)
      host.remove()
    }
  })
  test('duplicates through the authenticated preset API without a local create/marshal path', async () => {
    const { host, root } = await renderHook()
    try {
      let duplicated!: { id: string; name: string }
      await act(async () => {
        duplicated = await hookSurface.duplicatePreset(presetId, 'Cognition copy')
      })

      expect(duplicated).toMatchObject({ id: 'preset-duplicate', name: 'Cognition copy' })
      expect(duplicateCalls).toEqual([{ id: presetId, name: 'Cognition copy' }])
      expect(updateCalls).toHaveLength(0)
    } finally {
      unmountRoot(root)
      host.remove()
    }
  })
  test('routes descriptor-only sealed Loom imports through transactional portable import', async () => {
    const { host, root } = await renderHook()
    try {
      let imported!: unknown
      await act(async () => {
        imported = await hookSurface.importFromFile(descriptorOnlyImportPayload, 'sealed.json')
      })

      expect(imported).toMatchObject({ id: 'imported-sealed' })
      expect(createCalls).toHaveLength(0)
      expect(portableImportCalls).toHaveLength(1)
      expect(portableImportCalls[0]).toMatchObject({
        preset: {
          prompt_order: [{ content: '{{presetBlock::private-system}}', sealed: true, sealedSource: 'lumihub' }],
          metadata: { portableSealedPreset: sealedDescriptor },
        },
        agentRuntime: {
          version: 1,
          agentConfig: null,
          taskTemplates: [],
        },
      })
    } finally {
      unmountRoot(root)
      host.remove()
    }
  })
  test('rejects sealed descriptor mismatches before any persistence', async () => {
    const { host, root } = await renderHook()
    try {
      for (const payload of [
        sealedBlockWithoutDescriptorImportPayload,
        lumihubBlockWithMalformedDescriptorImportPayload,
        descriptorWithStrippedSealedFlagsImportPayload,
        descriptorWithExtraKeyImportPayload,
        descriptorWithDifferentKeyImportPayload,
      ]) {
        let failure: unknown
        await act(async () => {
          try {
            await hookSurface.importFromFile(payload, 'sealed-invalid.json')
          } catch (error) {
            failure = error
          }
        })
        expect(failure).toMatchObject({ code: 'LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE' })
      }
      expect(createCalls).toHaveLength(0)
      expect(portableImportCalls).toHaveLength(0)
    } finally {
      unmountRoot(root)
      host.remove()
    }
  })

  test('rejects legacy task graphs before partial agent-config import or persistence', async () => {
    const { host, root } = await renderHook()
    try {
      let failure: unknown
      await act(async () => {
        try {
          await hookSurface.importFromFile(legacyGraphImportPayload, 'legacy-graph.json')
        } catch (error) {
          failure = error
        }
      })
      expect(failure).toMatchObject({ code: 'AGENT_RUNTIME_PORTABLE_INVALID' })
      expect(createCalls).toHaveLength(0)
      expect(portableImportCalls).toHaveLength(0)
    } finally {
      unmountRoot(root)
      host.remove()
    }
  })

  test('rejects ambiguous or malformed regex sources before any persistence', async () => {
    const { host, root } = await renderHook()
    try {
      for (const payload of [dualRegexImportPayload, malformedRegexImportPayload]) {
        let failure: unknown
        await act(async () => {
          try {
            await hookSurface.importFromFile(payload, 'regex.json')
          } catch (error) {
            failure = error
          }
        })
        expect(failure).toMatchObject({ code: 'AGENT_RUNTIME_PORTABLE_REGEX_INVALID' })
      }
      expect(createCalls).toHaveLength(0)
      expect(portableImportCalls).toHaveLength(0)
    } finally {
      unmountRoot(root)
      host.remove()
    }
  })



  test('repairs a legacy duplicate-name schema atomically and rejects a newly duplicate proposal', async () => {
    const { host, root } = await renderHook()
    try {
      let repaired = false
      await act(async () => {
        repaired = hookSurface.updateBlock({ blockId: 'chat', promptOrder: 0 }, {
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
        duplicateProposal = hookSurface.updateBlock({ blockId: 'chat', promptOrder: 0 }, {
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
  test('saves a reordered duplicate while repairing its legacy sibling by reserving the exact occurrence', async () => {
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
          name: 'Legacy occurrence',
          variables: [firstVariable, legacyDuplicateVariable],
        },
        {
          ...chatBlock,
          id: 'duplicate',
          name: 'Exact occurrence',
          variables: [validRenamedVariable],
        },
      ]
      persistedPreset.metadata = {
        promptVariables: { duplicate: { tone: 'legacy value', voice: 'exact value' } },
      }
      ;({ host, root } = await renderHook())

      const currentBlocks = hookSurface.activePreset?.blocks
      if (!currentBlocks?.[0] || !currentBlocks[1]) throw new Error('expected duplicate fixture blocks')
      const reordered = [
        { ...currentBlocks[1] },
        {
          ...currentBlocks[0],
          name: 'Repaired occurrence',
          variables: [firstVariable, validRenamedVariable],
        },
      ]
      const promptVariables = {
        duplicate: { tone: 'legacy value', voice: 'exact value' },
      }
      let saveFailure: unknown
      let save: Promise<void> | null = null
      await act(async () => {
        save = hookSurface.saveLoomValue(reordered, promptVariables).catch((error) => {
          saveFailure = error
        })
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(saveFailure).toBeUndefined()
      expect(updateCalls).toHaveLength(1)
      expect(updateCalls[0]?.input.prompt_order?.map((block) => ({
        name: block.name,
        variables: block.variables,
      }))).toEqual([
        { name: 'Exact occurrence', variables: [validRenamedVariable] },
        { name: 'Repaired occurrence', variables: [firstVariable, validRenamedVariable] },
      ])
      expect(updateCalls[0]?.input.metadata?.promptVariables).toEqual(promptVariables)

      const persist = pendingPersist
      await act(async () => {
        resolvePersist?.()
        resolvePersist = null
        if (persist) await persist
        if (save) await save
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(saveFailure).toBeUndefined()
      expect(events).toEqual(['persist:start', 'persist:end', 'registry:refresh'])
    } finally {
      if (root) unmountRoot(root)
      host?.remove()
      persistedPreset.id = originalPresetId
      storeState.activeLoomPresetId = originalActivePresetId
      persistedPreset.prompt_order = originalPromptOrder
      persistedPreset.metadata = originalMetadata
    }
  })
  test('moves a variable definition and its value bucket to another block', async () => {
    // Later tests mutate the shared fixture; restore the pristine shape so
    // assertions here (and in the tests that follow) see a known baseline.
    persistedPreset.prompt_order = [chatBlock]
    persistedPreset.metadata = { promptVariables: { chat: { tone: 'legacy value' } } }
    // Each persisted write blocks on its own gate; drain chained writes so
    // nothing leaks into the tests that follow.
    const drain = async () => {
      const baseline = events.length
      for (let i = 0; i < 20; i++) {
        resolvePersist?.()
        resolvePersist = null
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        if (events.length > baseline && events[events.length - 1] === 'registry:refresh') break
      }
    }
    const { host, root } = await renderHook()
    try {
      await act(async () => {
        hookSurface.updateBlock({ blockId: 'chat', promptOrder: 0 }, { variables: [firstVariable, validRenamedVariable] })
        await drain()
      })
      const styleBlock: PromptBlock = {
        ...chatBlock,
        id: 'style',
        name: 'Style',
        variables: [],
      }
      await act(async () => {
        hookSurface.addBlock(styleBlock)
        await drain()
      })
      updateCalls.length = 0

      // Moving a def with no stored value only relocates the definition.
      let moved = false
      await act(async () => {
        moved = hookSurface.movePromptVariable({ blockId: 'chat', promptOrder: 0 }, validRenamedVariable, { blockId: 'style', promptOrder: 1 })
        await drain()
      })
      expect(moved).toBe(true)
      expect(updateCalls).toHaveLength(1)
      const chatAfterVoiceMove = updateCalls[0]?.input.prompt_order?.find((b) => b.id === 'chat')
      const styleAfterVoiceMove = updateCalls[0]?.input.prompt_order?.find((b) => b.id === 'style')
      expect(chatAfterVoiceMove?.variables).toEqual([firstVariable])
      expect(styleAfterVoiceMove?.variables).toEqual([validRenamedVariable])
      expect(updateCalls[0]?.input.metadata?.promptVariables).toEqual({
        chat: { tone: 'legacy value' },
      })

      // Moving a def with a stored value carries the bucket along.
      updateCalls.length = 0
      moved = false
      await act(async () => {
        moved = hookSurface.movePromptVariable({ blockId: 'chat', promptOrder: 0 }, firstVariable, { blockId: 'style', promptOrder: 1 })
        await drain()
      })
      expect(moved).toBe(true)
      expect(updateCalls).toHaveLength(1)
      const chatAfterToneMove = updateCalls[0]?.input.prompt_order?.find((b) => b.id === 'chat')
      const styleAfterToneMove = updateCalls[0]?.input.prompt_order?.find((b) => b.id === 'style')
      expect(chatAfterToneMove?.variables).toEqual([])
      expect(styleAfterToneMove?.variables).toEqual([validRenamedVariable, firstVariable])
      // The empty source bucket is pruned by marshal-time cleanup.
      expect(updateCalls[0]?.input.metadata?.promptVariables).toEqual({
        style: { tone: 'legacy value' },
      })

      // A target that already defines the name refuses the move.
      updateCalls.length = 0
      let rejected = true
      await act(async () => {
        rejected = hookSurface.movePromptVariable({ blockId: 'chat', promptOrder: 0 }, firstVariable, { blockId: 'style', promptOrder: 1 })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(rejected).toBe(false)
      expect(updateCalls).toHaveLength(0)
    } finally {
      unmountRoot(root)
      host.remove()
    }
  })

  test('rejects moving a variable to a same-ID sibling occurrence before mutation', async () => {
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
        { ...chatBlock, id: 'duplicate', name: 'Exact source', variables: [firstVariable] },
        { ...chatBlock, id: 'duplicate', name: 'Same-ID sibling', variables: [] },
      ]
      persistedPreset.metadata = { promptVariables: { duplicate: { tone: 'keep me' } } }
      ;({ host, root } = await renderHook())

      let moved = true
      await act(async () => {
        moved = hookSurface.movePromptVariable(
          { blockId: 'duplicate', promptOrder: 0 },
          firstVariable,
          { blockId: 'duplicate', promptOrder: 1 },
        )
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(moved).toBe(false)
      expect(updateCalls).toHaveLength(0)
    } finally {
      if (root) unmountRoot(root)
      host?.remove()
      persistedPreset.id = originalPresetId
      storeState.activeLoomPresetId = originalActivePresetId
      persistedPreset.prompt_order = originalPromptOrder
      persistedPreset.metadata = originalMetadata
    }
  })

  test('unmounts while persistence is pending before releasing the write gate', async () => {
    const { host, root } = await renderHook()
    let updated = false
    await act(async () => {
      updated = hookSurface.updateBlock({ blockId: 'chat', promptOrder: 0 }, {
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

  test('restores each duplicate child occurrence after reordering a disabled category', async () => {
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
          id: 'category',
          name: 'Category',
          marker: 'category',
          categoryMode: 'checkbox',
          variables: undefined,
        },
        { ...chatBlock, id: 'duplicate-child', name: 'Enabled duplicate', enabled: true, group: 'category', variables: undefined },
        { ...chatBlock, id: 'duplicate-child', name: 'Disabled duplicate', enabled: false, group: 'category', variables: undefined },
      ]
      persistedPreset.metadata = { promptVariables: {} }
      ;({ host, root } = await renderHook())

      await act(async () => {
        hookSurface.toggleCategoryChildren({ blockId: 'category', promptOrder: 0 })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(updateCalls).toHaveLength(1)
      const disabled = updateCalls[0]!.input.prompt_order!
      expect(disabled[0]?.savedChildEnabled).toEqual({
        '["duplicate-child",1]': true,
        '["duplicate-child",2]': false,
      })
      expect(disabled.slice(1).map((block) => block.enabled)).toEqual([false, false])

      const firstPersist = pendingPersist
      await act(async () => {
        resolvePersist?.()
        resolvePersist = null
        if (firstPersist) await firstPersist
        await Promise.resolve()
        await Promise.resolve()
      })

      const reordered = remapCategorySnapshotsForReorder(disabled, [
        { block: { ...disabled[0]! }, source: { blockId: 'category', promptOrder: 0 } },
        { block: { ...disabled[2]! }, source: { blockId: 'duplicate-child', promptOrder: 2 } },
        { block: { ...disabled[1]! }, source: { blockId: 'duplicate-child', promptOrder: 1 } },
      ])
      expect(reordered.map((block) => block.name)).toEqual([
        'Category',
        'Disabled duplicate',
        'Enabled duplicate',
      ])
      expect(reordered[0]?.savedChildEnabled).toEqual({
        '["duplicate-child",1]': false,
        '["duplicate-child",2]': true,
      })

      let reorderSave: Promise<void> | null = null
      await act(async () => {
        reorderSave = hookSurface.saveLoomValue(reordered, {})
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(updateCalls).toHaveLength(2)
      const secondPersist = pendingPersist
      await act(async () => {
        resolvePersist?.()
        resolvePersist = null
        if (secondPersist) await secondPersist
        if (reorderSave) await reorderSave
        await Promise.resolve()
        await Promise.resolve()
      })

      await act(async () => {
        hookSurface.toggleCategoryChildren({ blockId: 'category', promptOrder: 0 })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(updateCalls).toHaveLength(3)
      const restored = updateCalls[2]!.input.prompt_order!
      expect(restored[0]?.savedChildEnabled).toBeUndefined()
      expect(restored.slice(1).map((block) => [block.name, block.enabled])).toEqual([
        ['Disabled duplicate', false],
        ['Enabled duplicate', true],
      ])

      const thirdPersist = pendingPersist
      await act(async () => {
        resolvePersist?.()
        resolvePersist = null
        if (thirdPersist) await thirdPersist
      })
    } finally {
      if (root) unmountRoot(root)
      host?.remove()
      persistedPreset.id = originalPresetId
      storeState.activeLoomPresetId = originalActivePresetId
      persistedPreset.prompt_order = originalPromptOrder
      persistedPreset.metadata = originalMetadata
    }
  })

  test('restores a unique-ID mixed legacy category snapshot on first re-enable', async () => {
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
          id: 'legacy-category',
          marker: 'category',
          categoryMode: 'checkbox',
          enabled: false,
          savedChildEnabled: { first: true, second: false },
          variables: undefined,
        },
        { ...chatBlock, id: 'first', name: 'First', enabled: false, group: 'legacy-category', variables: undefined },
        { ...chatBlock, id: 'second', name: 'Second', enabled: false, group: 'legacy-category', variables: undefined },
      ]
      persistedPreset.metadata = { promptVariables: {} }
      ;({ host, root } = await renderHook())
      expect(hookSurface.activePreset?.blocks[0]?.savedChildEnabled).toEqual({
        '["first",1]': true,
        '["second",2]': false,
      })

      await act(async () => {
        hookSurface.toggleCategoryChildren({ blockId: 'legacy-category', promptOrder: 0 })
        await Promise.resolve()
        await Promise.resolve()
      })

      const restored = updateCalls[0]!.input.prompt_order!
      expect(restored[0]?.savedChildEnabled).toBeUndefined()
      expect(restored.slice(1).map((block) => [block.id, block.enabled])).toEqual([
        ['first', true],
        ['second', false],
      ])

      const persist = pendingPersist
      await act(async () => {
        resolvePersist?.()
        resolvePersist = null
        if (persist) await persist
      })
    } finally {
      if (root) unmountRoot(root)
      host?.remove()
      persistedPreset.id = originalPresetId
      storeState.activeLoomPresetId = originalActivePresetId
      persistedPreset.prompt_order = originalPromptOrder
      persistedPreset.metadata = originalMetadata
    }
  })

  test('applies an ambiguous duplicate-ID legacy snapshot as its prior ID-wide value', async () => {
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
          id: 'legacy-category',
          marker: 'category',
          categoryMode: 'checkbox',
          enabled: false,
          savedChildEnabled: { duplicate: true },
          variables: undefined,
        },
        { ...chatBlock, id: 'duplicate', name: 'First duplicate', enabled: false, group: 'legacy-category', variables: undefined },
        { ...chatBlock, id: 'duplicate', name: 'Second duplicate', enabled: false, group: 'legacy-category', variables: undefined },
      ]
      persistedPreset.metadata = { promptVariables: {} }
      ;({ host, root } = await renderHook())
      expect(hookSurface.activePreset?.blocks[0]?.savedChildEnabled).toEqual({
        '["duplicate",1]': true,
        '["duplicate",2]': true,
      })

      await act(async () => {
        hookSurface.toggleCategoryChildren({ blockId: 'legacy-category', promptOrder: 0 })
        await Promise.resolve()
        await Promise.resolve()
      })

      const restored = updateCalls[0]!.input.prompt_order!
      expect(restored[0]?.savedChildEnabled).toBeUndefined()
      expect(restored.slice(1).map((block) => [block.name, block.enabled])).toEqual([
        ['First duplicate', true],
        ['Second duplicate', true],
      ])

      const persist = pendingPersist
      await act(async () => {
        resolvePersist?.()
        resolvePersist = null
        if (persist) await persist
      })
    } finally {
      if (root) unmountRoot(root)
      host?.remove()
      persistedPreset.id = originalPresetId
      storeState.activeLoomPresetId = originalActivePresetId
      persistedPreset.prompt_order = originalPromptOrder
      persistedPreset.metadata = originalMetadata
    }
  })

  test('drops removed snapshot coordinates without assigning them to inserted duplicates', () => {
    const sourceBlocks: PromptBlock[] = [
      {
        ...chatBlock,
        id: 'category',
        marker: 'category',
        categoryMode: 'checkbox',
        enabled: false,
        savedChildEnabled: {
          '["duplicate-child",1]': true,
          '["duplicate-child",2]': false,
        },
      },
      { ...chatBlock, id: 'duplicate-child', name: 'Removed duplicate', enabled: false, group: 'category' },
      { ...chatBlock, id: 'duplicate-child', name: 'Retained duplicate', enabled: false, group: 'category' },
    ]
    const insertedDuplicate = {
      ...chatBlock,
      id: 'duplicate-child',
      name: 'Inserted duplicate',
      enabled: false,
      group: 'category',
    }

    const reordered = remapCategorySnapshotsForReorder(sourceBlocks, [
      { block: { ...sourceBlocks[0]! }, source: { blockId: 'category', promptOrder: 0 } },
      { block: { ...sourceBlocks[2]! }, source: { blockId: 'duplicate-child', promptOrder: 2 } },
      { block: insertedDuplicate, source: null },
    ])

    expect(reordered[0]?.savedChildEnabled).toEqual({
      '["duplicate-child",1]': false,
    })
  })

  test('updates only the exact duplicate block coordinate and rejects a mismatched coordinate', async () => {
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
        { ...chatBlock, id: 'duplicate', name: 'First duplicate', sealed: true, sealedKey: 'first-key' },
        { ...chatBlock, id: 'unique', name: 'Unique block', sealed: true, sealedKey: 'unique-key' },
        { ...chatBlock, id: 'duplicate', name: 'Second duplicate', sealed: true, sealedKey: 'second-key' },
      ]
      persistedPreset.metadata = {
        promptVariables: {
          duplicate: { tone: 'duplicate value' },
          unique: { tone: 'unique value' },
        },
      }
      ;({ host, root } = await renderHook())

      let accepted = false
      await act(async () => {
        accepted = hookSurface.updateBlock(
          { blockId: 'duplicate', promptOrder: 2 },
          { sealedKey: 'second-updated' },
        )
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(accepted).toBe(true)
      expect(updateCalls).toHaveLength(1)
      const persistedBlocks = updateCalls[0]!.input.prompt_order!
      expect(Reflect.get(persistedBlocks[0]!, 'sealedKey')).toBe('first-key')
      expect(Reflect.get(persistedBlocks[1]!, 'sealedKey')).toBe('unique-key')
      expect(Reflect.get(persistedBlocks[2]!, 'sealedKey')).toBe('second-updated')

      await act(async () => {
        resolvePersist?.()
        resolvePersist = null
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(hookSurface.updateBlock(
        { blockId: 'duplicate', promptOrder: 1 },
        { sealedKey: 'must-not-apply' },
      )).toBe(false)
      expect(updateCalls).toHaveLength(1)
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
