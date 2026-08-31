import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type {
  AgenticRuntimeEditorProjection,
  SaveAgenticRuntimeEditorResult,
} from '@/api/agentic-runtime'
import type { AgentConfigV2, LoomPreset, PromptBlock } from '@/lib/loom/types'
import type { Preset, PresetRegistryItem } from '@/types/api'
import { getRuntimeAuthorityRevision } from '@/lib/agentRuntimeSelection'

const presetId = 'preset-agentic-runtime-reload'

function block(id: string, content: string): PromptBlock {
  return {
    id,
    name: id,
    content,
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
    variables: [],
  }
}

const storeState = {
  activeLoomPresetId: presetId as string | null,
  loomRegistry: {
    [presetId]: { name: 'Atomic reload', blockCount: 1, updatedAt: 1, isDefault: false },
  },
  setActiveLoomPreset: (id: string | null) => {
    storeState.activeLoomPresetId = id
  },
  setLoomRegistry: (_registry: Record<string, unknown>) => {},
  activeProfileId: null,
  profiles: [],
  providers: [],
}
const useStoreMock = Object.assign(
  <T,>(selector: (state: typeof storeState) => T): T => selector(storeState),
  { getState: () => storeState },
)

mock.module('@/store', () => ({ useStore: useStoreMock }))
mock.module('@/api/macros', () => ({
  getMacroCatalog: async () => ({ categories: [] }),
  resolveMacros: async () => ({ text: 'resolved', diagnostics: [] }),
  resolveMacrosBatch: async () => ({ resolved: {} }),
}))
mock.module('@/i18n', () => ({ default: { t: (key: string) => key, language: 'en' } }))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals: Record<string, unknown> = {
  window: globalObject.window,
  document: globalObject.document,
  navigator: globalObject.navigator,
  Node: globalObject.Node,
  Element: globalObject.Element,
  HTMLElement: globalObject.HTMLElement,
  SVGElement: globalObject.SVGElement,
  IS_REACT_ACT_ENVIRONMENT: globalObject.IS_REACT_ACT_ENVIRONMENT,
}
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

// The hook must load after its store and API collaborators are isolated above.
const { createDefaultAgentConfigV2, createAgentProfileV2 } = await import('@/lib/loom/agenticRuntime')
const { useLoomBuilder } = await import('./useLoomBuilder')
mock.restore()

function config(profileName: string): AgentConfigV2 {
  return {
    ...createDefaultAgentConfigV2(),
    profiles: [createAgentProfileV2(profileName, [])],
  }
}

const oldConfig = config('Old analyst')
const latestConfig = config('Latest analyst')
const oldBlock = block('old-block', 'old prompt')
const latestBlock = block('latest-block', 'latest prompt')

function wirePreset(
  promptOrder: PromptBlock[],
  agentConfig: AgentConfigV2,
  presetRevision: number,
  configRevision: number,
): Preset {
  return {
    id: presetId,
    name: 'Atomic reload',
    provider: 'loom',
    engine: 'classic',
    parameters: {},
    prompt_order: promptOrder,
    prompts: {},
    metadata: {},
    created_at: 1,
    updated_at: presetRevision,
    cache_revision: presetRevision,
    agent_config: agentConfig,
    agent_config_revision: configRevision,
    agent_config_review: null,
    agent_slot_bindings: {},
    agent_task_templates: [],
  }
}

const initialPreset = wirePreset([oldBlock], oldConfig, 1, 1)
const latestPreset = wirePreset([latestBlock], latestConfig, 2, 3)

const hostCeilings = {
  childAdmissions: 0,
  aggregateToolCalls: 0,
  logicalProviderRequests: 0,
  physicalDispatchAttempts: 0,
  childOutputTokens: 0,
  workAttemptOutputTokens: 0,
  workAttemptProviderDispatches: 0,
  workAttemptUnsignedBoundaries: 0,
  workAttemptToolCalls: 0,
  workAttemptWorkspaceOperations: 0,
  workSegmentOutputTokens: 0,
  workSegmentProviderDispatches: 0,
  workSegmentUnsignedBoundaries: 0,
  workSegmentToolCalls: 0,
  workSegmentWorkspaceOperations: 0,
  workDispatchOutputTokens: 0,
  workRecoveryReserveOutputTokens: 0,
  workFuturePhaseReserveOutputTokens: 0,
  rootWallClockMs: 0,
  activityEvents: 0,
  activityBytes: 0,
  lifecycleLogRecords: 0,
  activeRootsPerUser: 0,
  activeRootsProcess: 0,
  providerDispatchesPerUser: 0,
  providerDispatchesProcess: 0,
  toolExecutionsPerUser: 0,
  toolExecutionsProcess: 0,
}

const latestEditor: AgenticRuntimeEditorProjection = {
  presetId,
  presetRevision: 2,
  configRevision: 3,
  config: latestConfig,
  review: null,
  slotBindings: {},
  taskTemplates: [],
  reviewAcknowledgements: [],
  hostCeilings,
}
const latestPair: SaveAgenticRuntimeEditorResult = {
  preset: latestPreset,
  editor: latestEditor,
}
let saveEditorResult: SaveAgenticRuntimeEditorResult = latestPair

let presetGetCalls = 0
let resolveMatched: ((result: SaveAgenticRuntimeEditorResult) => void) | null = null
let rejectMatched: ((error: Error) => void) | null = null

const registryItem: PresetRegistryItem = {
  id: presetId,
  name: 'Atomic reload',
  provider: 'loom',
  block_count: 1,
  updated_at: 2,
}
const presetsApiMock = {
  get: async (id: string): Promise<Preset> => {
    if (id !== presetId) throw new Error(`unexpected preset id: ${id}`)
    presetGetCalls += 1
    return initialPreset
  },
  update: async () => initialPreset,
  listRegistry: async () => ({ data: [registryItem], total: 1 }),
}
const runtimeApiMock = {
  getMatchedEditor: async (id: string): Promise<SaveAgenticRuntimeEditorResult> => {
    if (id !== presetId) throw new Error(`unexpected preset id: ${id}`)
    return new Promise<SaveAgenticRuntimeEditorResult>((resolve, reject) => {
      resolveMatched = resolve
      rejectMatched = reject
    })
  },
  saveEditor: async (): Promise<SaveAgenticRuntimeEditorResult> => saveEditorResult,
}
const injectedPresetsApi = presetsApiMock as unknown as Parameters<typeof useLoomBuilder>[0]['presetsApi']
const injectedRuntimeApi = runtimeApiMock as unknown as Parameters<typeof useLoomBuilder>[0]['agenticRuntimeApi']

interface LoomBuilderTestSurface {
  activePreset: LoomPreset | null
  reloadActivePreset(): Promise<SaveAgenticRuntimeEditorResult>
  saveAgenticRuntime: ReturnType<typeof useLoomBuilder>['saveAgenticRuntime']
}
let hookSurface: LoomBuilderTestSurface
/* eslint-disable react-compiler/react-compiler */
function HookHarness() {
  hookSurface = useLoomBuilder({
    presetsApi: injectedPresetsApi,
    agenticRuntimeApi: injectedRuntimeApi,
  })
  return null
}
/* eslint-enable react-compiler/react-compiler */

async function mountHook(): Promise<{ root: Root; host: HTMLDivElement }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  // React DOM must load after this isolated harness installs its DOM globals.
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(HookHarness))
    for (let attempt = 0; attempt < 8 && !hookSurface?.activePreset; attempt += 1) {
      await Promise.resolve()
    }
  })
  expect(hookSurface.activePreset?.id).toBe(presetId)
  return { root, host }
}

beforeEach(() => {
  storeState.activeLoomPresetId = presetId
  presetGetCalls = 0
  resolveMatched = null
  rejectMatched = null
  saveEditorResult = latestPair
})

afterEach(async () => {
  rejectMatched?.(new Error('test cleanup'))
  resolveMatched = null
  rejectMatched = null
  document.body.replaceChildren()
  await Promise.resolve()
})

afterAll(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
})

describe('useLoomBuilder agentic runtime reload', () => {
  test('publishes neither half until the exact preset/editor pair resolves', async () => {
    const { root, host } = await mountHook()
    let reload: Promise<SaveAgenticRuntimeEditorResult> | null = null
    try {
      await act(async () => {
        reload = hookSurface.reloadActivePreset()
        await Promise.resolve()
      })

      expect(presetGetCalls).toBe(1)
      expect(hookSurface.activePreset?.blocks).toEqual([oldBlock])
      expect(hookSurface.activePreset?.agentConfig?.profiles[0]?.name).toBe('Old analyst')

      await act(async () => {
        resolveMatched?.(latestPair)
        await reload
      })

      expect(await reload).toEqual(latestPair)
      expect(presetGetCalls).toBe(1)
      expect(hookSurface.activePreset?.blocks).toEqual([latestBlock])
      expect(hookSurface.activePreset?.agentConfig?.profiles[0]?.name).toBe('Latest analyst')
      expect(hookSurface.activePreset?.cacheRevision).toBe(2)
      expect(hookSurface.activePreset?.agentConfigRevision).toBe(3)
    } finally {
      await act(async () => {
        root.unmount()
        await Promise.resolve()
      })
      host.remove()
    }
  })

  test('commits runtime authority after the atomic editor save', async () => {
    const { root, host } = await mountHook()
    const before = getRuntimeAuthorityRevision()
    try {
      await act(async () => {
        await hookSurface.saveAgenticRuntime({
          config: oldConfig,
          slotBindings: {},
          taskTemplates: [],
          reviewAcknowledgements: [],
        }, [oldBlock], {
          presetId,
          presetRevision: 1,
          configRevision: 1,
        }, () => true)
      })

      expect(getRuntimeAuthorityRevision()).toBe(before + 1)
    } finally {
      await act(async () => {
        root.unmount()
        await Promise.resolve()
      })
      host.remove()
    }
  })

  test('does not invalidate runtime authority for an exact editor save no-op', async () => {
    saveEditorResult = {
      preset: initialPreset,
      editor: { ...latestEditor, presetRevision: 1, configRevision: 1, config: oldConfig },
    }
    const { root, host } = await mountHook()
    const before = getRuntimeAuthorityRevision()
    try {
      await act(async () => {
        await hookSurface.saveAgenticRuntime({
          config: oldConfig,
          slotBindings: {},
          taskTemplates: [],
          reviewAcknowledgements: [],
        }, [oldBlock], { presetId, presetRevision: 1, configRevision: 1 }, () => true)
      })
      expect(getRuntimeAuthorityRevision()).toBe(before)
    } finally {
      await act(async () => { root.unmount(); await Promise.resolve() })
      host.remove()
    }
  })

  test('invalidates runtime authority once for a config-only editor save', async () => {
    saveEditorResult = {
      preset: wirePreset([oldBlock], latestConfig, 1, 2),
      editor: { ...latestEditor, presetRevision: 1, configRevision: 2, config: latestConfig },
    }
    const { root, host } = await mountHook()
    const before = getRuntimeAuthorityRevision()
    try {
      await act(async () => {
        await hookSurface.saveAgenticRuntime({
          config: latestConfig,
          slotBindings: {},
          taskTemplates: [],
          reviewAcknowledgements: [],
        }, [oldBlock], { presetId, presetRevision: 1, configRevision: 1 }, () => true)
      })
      expect(getRuntimeAuthorityRevision()).toBe(before + 1)
    } finally {
      await act(async () => { root.unmount(); await Promise.resolve() })
      host.remove()
    }
  })
  test('preserves the current preset when matched reload fails', async () => {
    const { root, host } = await mountHook()
    let reload: Promise<SaveAgenticRuntimeEditorResult> | null = null
    try {
      await act(async () => {
        reload = hookSurface.reloadActivePreset()
        await Promise.resolve()
      })
      rejectMatched?.(new Error('matched pair unavailable'))
      await expect(reload).rejects.toThrow('matched pair unavailable')

      expect(hookSurface.activePreset?.blocks).toEqual([oldBlock])
      expect(hookSurface.activePreset?.agentConfig?.profiles[0]?.name).toBe('Old analyst')
      expect(presetGetCalls).toBe(1)
    } finally {
      await act(async () => {
        root.unmount()
        await Promise.resolve()
      })
      host.remove()
    }
  })

  test('does not publish a matched completion after the active preset changes', async () => {
    const { root, host } = await mountHook()
    let reload: Promise<SaveAgenticRuntimeEditorResult> | null = null
    try {
      await act(async () => {
        reload = hookSurface.reloadActivePreset()
        await Promise.resolve()
      })
      storeState.activeLoomPresetId = 'another-preset'
      resolveMatched?.(latestPair)
      await expect(reload).rejects.toThrow('No active preset')

      expect(hookSurface.activePreset?.blocks).toEqual([oldBlock])
      expect(hookSurface.activePreset?.agentConfig?.profiles[0]?.name).toBe('Old analyst')
    } finally {
      storeState.activeLoomPresetId = presetId
      await act(async () => {
        root.unmount()
        await Promise.resolve()
      })
      host.remove()
    }
  })
})
