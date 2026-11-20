import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { flushSync } from 'react-dom'
import { registerLiveRoot } from './live-root-registry'
import type {
  PromptBlockDTO,
  PromptVariableDefDTO,
  SpindleLoomBlockEditorHandle,
  SpindleLoomBlockEditorOptions,
  SpindleLoomBlockEditorValue,
} from 'lumiverse-spindle-types'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis
Object.defineProperty(domWindow, 'event', { configurable: true, value: undefined, writable: true })
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['Element', globalObject.Element],
  ['HTMLElement', globalObject.HTMLElement],
  ['Node', globalObject.Node],
  ['MutationObserver', globalObject.MutationObserver],
  ['requestAnimationFrame', globalObject.requestAnimationFrame],
  ['cancelAnimationFrame', globalObject.cancelAnimationFrame],
  ['IS_REACT_ACT_ENVIRONMENT', globalObject.IS_REACT_ACT_ENVIRONMENT],
])
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>(
  [...originalGlobals.keys()].map((key) => [key, Object.getOwnPropertyDescriptor(globalObject, key)]),
)
Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
})

const NullComponent = () => null
const placementState = {
  drawerTabs: [] as Array<{ root: HTMLElement; extensionId: string }>,
  characterEditorTabs: [],
  presetEditorTabs: [],
  presetEditorToolbarItems: [],
  floatWidgets: [],
  dockPanels: [],
  appMounts: [],
}
type ControlledProps = {
  blocks: PromptBlockDTO[]
  promptVariables: SpindleLoomBlockEditorValue['promptVariableValues']
  onChange(blocks: PromptBlockDTO[]): boolean
  onDraftChange?(blockId: string, updates: Partial<PromptBlockDTO> | null): void
  selectedBlockId?: string | null
  onSelectedBlockChange?(blockId: string | null): void
  onMoveVariable?(sourceBlockId: string, variable: PromptVariableDefDTO, targetBlockId: string): boolean
  trustedHostFeatures?: boolean
}
let controlledProps: ControlledProps | null = null
const unregisterRoots: Array<() => void> = []
const activeHandles = new Set<SpindleLoomBlockEditorHandle>()

mock.module('@/components/shared/FormComponents', () => ({ TextInput: NullComponent, TextArea: NullComponent }))
mock.module('@/components/shared/FormComponents.module.css', () => ({ default: {} }))
mock.module('@/components/shared/NumericInput', () => ({ default: NullComponent }))
mock.module('@/components/shared/NumberStepper', () => ({ default: NullComponent }))
mock.module('@/components/shared/RangeSlider', () => ({
  RangeSlider: NullComponent,
  LabeledRangeSlider: NullComponent,
  DualRangeSlider: NullComponent,
  LabeledDualRangeSlider: NullComponent,
}))
mock.module('@/components/shared/Toggle', () => ({ Toggle: NullComponent }))
mock.module('@/components/shared/Badge', () => ({ Badge: NullComponent }))
mock.module('@/components/shared/Spinner', () => ({ Spinner: NullComponent }))
mock.module('@/components/shared/CloseButton', () => ({ CloseButton: NullComponent }))
mock.module('@/components/shared/Pagination', () => ({ default: NullComponent }))
mock.module('@/components/shared/CollapsibleSection', () => ({ default: NullComponent }))
mock.module('@/components/shared/SearchableSelect', () => ({
  default: NullComponent,
  PORTAL_OWNER_ACTIVE_ATTRIBUTE: 'data-spindle-component-portal-owner-active',
  PORTAL_OWNER_ACTIVITY_EVENT: 'spindle:component-portal-owner-activity',
}))
mock.module('@/components/shared/FolderDropdown', () => ({ default: NullComponent }))
mock.module('@/components/panels/connection-manager/ModelCombobox', () => ({ default: NullComponent }))
mock.module('@/components/panels/LoomBuilder', () => ({
  ControlledLoomBlockEditor: (props: ControlledProps) => {
    controlledProps = props
    return createElement('div', { 'data-testid': 'loom-host' })
  },
}))
mock.module('@/store', () => ({
  useStore: Object.assign(() => null, { getState: () => placementState }),
}))

// Import after mocks so the bridge is tested without the application store or real panel graph.
const { createComponentsHelper } = await import('./components-helper')
const { setPresetEditorController } = await import('./preset-editor-helper')
mock.restore()

function ownedRoot(extensionId: string, id: string): HTMLElement {
  const root = document.createElement('section')
  root.setAttribute('data-spindle-extension-root', extensionId)
  root.id = id
  document.body.append(root)
  unregisterRoots.push(registerLiveRoot(extensionId, root, null, 0))
  placementState.drawerTabs.push({ root, extensionId })
  return root
}

function block(id: string, overrides: Partial<PromptBlockDTO> = {}): PromptBlockDTO {
  return {
    id,
    name: id,
    content: id,
    role: 'system',
    enabled: true,
    position: 'pre_history',
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
    categoryMode: null,
    ...overrides,
  }
}

function value(overrides: Partial<SpindleLoomBlockEditorValue> = {}): SpindleLoomBlockEditorValue {
  return {
    blocks: [block('one')],
    promptVariableValues: {},
    ...overrides,
  }
}
function mount(
  extensionId: string,
  initial: SpindleLoomBlockEditorValue,
  onChange?: (next: SpindleLoomBlockEditorValue) => void,
  options: Omit<SpindleLoomBlockEditorOptions, 'value' | 'onChange'> = {},
  withPresetPermission = false,
): SpindleLoomBlockEditorHandle {
  const handle = createComponentsHelper(
    extensionId,
    extensionId,
    async () => ({ categories: [] }),
    undefined,
    withPresetPermission ? { hasPermission: (permission) => permission === 'presets' } : {},
  ).mountLoomBlockEditor(ownedRoot(extensionId, `${extensionId}-target`), { value: initial, onChange, ...options })
  const destroy = handle.destroy
  handle.destroy = () => {
    destroy()
    expect(() => handle.getValue()).toThrow('COMPONENT_DESTROYED')
    activeHandles.delete(handle)
  }
  activeHandles.add(handle)
  return handle
}

afterEach(() => {
  for (const handle of [...activeHandles]) handle.destroy()
  expect(activeHandles.size).toBe(0)
  for (const unregister of unregisterRoots.splice(0)) unregister()
  document.body.replaceChildren()
  placementState.drawerTabs.length = 0
  placementState.characterEditorTabs.length = 0
  placementState.presetEditorTabs.length = 0
  placementState.presetEditorToolbarItems.length = 0
  placementState.floatWidgets.length = 0
  placementState.dockPanels.length = 0
  placementState.appMounts.length = 0
  controlledProps = null
  setPresetEditorController(null)
})
afterAll(async () => {
  try {
    await act(async () => {})
  } finally {
    for (const [key, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalObject, key, descriptor)
      else delete globalObject[key]
    }
  }
})

describe('Loom component bridge state transitions', () => {
  test('enables native variable moves only for one preset-bound editor with presets permission', async () => {
    const blocks = [
      block('one', { variables: [{ id: 'tone-id', name: 'tone', label: 'Tone', type: 'text', defaultValue: '' }] }),
      block('two', { variables: [] }),
    ]
    const moves: Array<[string, string, string]> = []
    setPresetEditorController({
      getState: () => ({
        open: true,
        presetId: 'preset',
        activeTabId: 'preset',
        preset: {
          id: 'preset',
          name: 'Preset',
          blocks,
          parameters: {},
          prompts: {},
          metadata: {},
          createdAt: 0,
          updatedAt: 0,
        },
      }),
      getPromptVariableValues: () => ({}),
      setActiveTab() {},
      updatePreset() {},
      movePromptVariable(sourceBlockId, variable, targetBlockId) {
        moves.push([sourceBlockId, variable.name, targetBlockId])
        return true
      },
      async flush() {},
    })

    const handle = mount(
      'loom-native-move',
      value({ blocks }),
      undefined,
      { selectedBlockId: 'one' },
      true,
    )
    await act(async () => {})

    expect(typeof controlledProps?.onMoveVariable).toBe('function')
    const variable = blocks[0]!.variables![0]!
    expect(controlledProps!.onMoveVariable!('one', variable, 'two')).toBe(true)
    expect(moves).toEqual([['one', 'tone', 'two']])

    const noPermission = mount(
      'loom-native-move-no-permission',
      value({ blocks }),
      undefined,
      { selectedBlockId: 'one' },
    )
    await act(async () => {})
    expect(controlledProps?.onMoveVariable).toBeUndefined()
    noPermission.destroy()

    const dormantSecond = mount(
      'loom-native-move',
      value({ blocks }),
      undefined,
      { selectedBlockId: null },
      true,
    )
    await act(async () => {})
    expect(controlledProps?.onMoveVariable).toBeUndefined()

    handle.update({ selectedBlockId: 'one' })
    await act(async () => {})
    expect(typeof controlledProps?.onMoveVariable).toBe('function')

    dormantSecond.update({ selectedBlockId: 'two' })
    await act(async () => {})
    expect(controlledProps?.onMoveVariable).toBeUndefined()

    handle.update({ selectedBlockId: 'one' })
    await act(async () => {})
    expect(controlledProps?.onMoveVariable).toBeUndefined()

    dormantSecond.update({ selectedBlockId: null })
    await act(async () => {})
    handle.update({ selectedBlockId: 'one' })
    await act(async () => {})
    expect(typeof controlledProps?.onMoveVariable).toBe('function')
  })

  test('normalizes radio edits before committing and emitting the value', () => {
    const initialBlocks = [
      block('category', { marker: 'category', categoryMode: 'radio' }),
      block('first', { group: 'category', enabled: true }),
      block('second', { group: 'category', enabled: false }),
    ]
    let emitted: SpindleLoomBlockEditorValue | undefined
    const handle = mount('loom-radio-normalization', value({ blocks: initialBlocks }), (next) => {
      emitted = next
    })

    const editedBlocks = [
      initialBlocks[0]!,
      { ...initialBlocks[1]!, enabled: false },
      { ...initialBlocks[2]!, enabled: true },
    ]
    expect(controlledProps?.onChange(editedBlocks)).toBe(true)
    expect(emitted?.blocks.filter((entry) => entry.group === 'category' && entry.enabled).map((entry) => entry.id))
      .toEqual(['second'])
    expect(handle.getValue().blocks.filter((entry) => entry.group === 'category' && entry.enabled).map((entry) => entry.id))
      .toEqual(['second'])
    handle.destroy()
  })

  test('onChange observes its committed value before a callback update wins', () => {
    const initial = value({ blocks: [block('before')] })
    const replacement = value({ blocks: [block('replacement')] })
    let observed: SpindleLoomBlockEditorValue | undefined
    let handle!: SpindleLoomBlockEditorHandle
    handle = mount('loom-bridge-synchronous-value', initial, () => {
      observed = handle.getValue()
      handle.update({ value: replacement })
    })

    expect(controlledProps?.onChange([block('candidate')])).toBe(true)
    expect(observed?.blocks[0]?.id).toBe('candidate')
    expect(handle.getValue().blocks[0]?.id).toBe('replacement')
    handle.destroy()
  })

  test('commits callback-free edits', () => {
    const initial = value({ blocks: [block('before')] })
    const handle = mount('loom-bridge-callback-free', initial)
    expect(controlledProps?.trustedHostFeatures).toBe(false)

    expect(controlledProps?.onChange([block('candidate')])).toBe(true)
    expect(handle.getValue().blocks[0]?.id).toBe('candidate')
    handle.destroy()
  })

  test('forwards controlled selection and native selection callbacks', () => {
    const selected: Array<string | null> = []
    const handle = mount('loom-bridge-selection', value({ blocks: [block('one'), block('two')] }), undefined, {
      selectedBlockId: 'two',
      onSelectedBlockChange: (blockId) => { selected.push(blockId) },
    })

    expect(controlledProps?.selectedBlockId).toBe('two')
    controlledProps?.onSelectedBlockChange?.(null)
    expect(selected).toEqual([null])

    flushSync(() => handle.update({ selectedBlockId: 'one' }))
    expect(controlledProps?.selectedBlockId).toBe('one')
    expect(handle.getValue().blocks.map((entry) => entry.id)).toEqual(['one', 'two'])
    handle.destroy()
  })

  test('publishes detached validated drafts without committing bridge value', () => {
    const drafts: Array<SpindleLoomBlockEditorValue | null> = []
    const initial = value({ blocks: [block('one', { content: 'committed' })] })
    const handle = mount('loom-bridge-draft', initial, undefined, {
      onDraftChange: (next) => { drafts.push(next) },
    })

    controlledProps?.onDraftChange?.('one', { content: 'draft' })
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.blocks[0]?.content).toBe('draft')
    expect(handle.getValue().blocks[0]?.content).toBe('committed')

    drafts[0]!.blocks[0]!.content = 'consumer mutation'
    expect(handle.getValue().blocks[0]?.content).toBe('committed')

    controlledProps?.onDraftChange?.('one', null)
    expect(drafts[1]).toBeNull()
    handle.destroy()
  })

  test('commits the exact value when a synchronous callback returns false', () => {
    const candidate = value({ blocks: [block('candidate')] })
    let emitted: SpindleLoomBlockEditorValue | undefined
    const handle = mount('loom-bridge-sync-false', value({ blocks: [block('before')] }), (next) => {
      emitted = next
      return false
    })

    expect(controlledProps?.onChange(candidate.blocks)).toBe(true)
    expect(emitted).toEqual(candidate)
    expect(handle.getValue()).toEqual(candidate)
    handle.destroy()
  })
  test('commits the exact value through a synchronous callback throw and logs the failure', () => {
    const candidate = value({ blocks: [block('candidate')] })
    const failure = new Error('consumer rejected edit')
    let emitted: SpindleLoomBlockEditorValue | undefined
    const logged: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { logged.push(args) }
    try {
      const handle = mount('loom-bridge-sync-throw', value({ blocks: [block('before')] }), (next) => {
        emitted = next
        throw failure
      })
      expect(controlledProps?.onChange(candidate.blocks)).toBe(true)
      expect(emitted).toEqual(candidate)
      expect(handle.getValue()).toEqual(candidate)
      expect(logged).toContainEqual(['[Spindle] Loom onChange callback failed', failure])
      handle.destroy()
    } finally {
      console.error = originalError
    }
  })

  test('commits the exact value when an async callback resolves false', async () => {
    const candidate = value({ blocks: [block('candidate')] })
    let emitted: SpindleLoomBlockEditorValue | undefined
    const handle = mount('loom-bridge-async-false', value({ blocks: [block('before')] }), (next) => {
      emitted = next
      return Promise.resolve(false)
    })

    expect(controlledProps?.onChange(candidate.blocks)).toBe(true)
    await Promise.resolve()
    expect(emitted).toEqual(candidate)
    expect(handle.getValue()).toEqual(candidate)
    handle.destroy()
  })

  test('commits the exact value and logs an async callback rejection', async () => {
    const candidate = value({ blocks: [block('candidate')] })
    const failure = new Error('async consumer rejected edit')
    let emitted: SpindleLoomBlockEditorValue | undefined
    const logged: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { logged.push(args) }
    try {
      const handle = mount('loom-bridge-async-rejection', value({ blocks: [block('before')] }), (next) => {
        emitted = next
        return Promise.reject(failure)
      })
      expect(controlledProps?.onChange(candidate.blocks)).toBe(true)
      await Promise.resolve()
      await Promise.resolve()
      expect(emitted).toEqual(candidate)
      expect(handle.getValue()).toEqual(candidate)
      expect(logged).toContainEqual(['[Spindle] Loom onChange callback failed', failure])
      handle.destroy()
    } finally {
      console.error = originalError
    }
  })

  test('keeps a synchronous handle.update winner when the callback then throws', () => {
    const initial = value({ blocks: [block('before')] })
    const replacement = value({ blocks: [block('replacement')] })
    const failure = new Error('consumer rejected candidate after update')
    const logged: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { logged.push(args) }
    try {
      let handle!: SpindleLoomBlockEditorHandle
      handle = mount('loom-bridge-reentrant-update', initial, () => {
        handle.update({ value: replacement })
        throw failure
      })
      expect(controlledProps?.onChange([block('candidate')])).toBe(true)
      expect(handle.getValue().blocks[0]?.id).toBe('replacement')
      replacement.blocks[0]!.content = 'caller mutation'
      expect(handle.getValue().blocks[0]?.content).toBe('replacement')
      expect(logged).toContainEqual(['[Spindle] Loom onChange callback failed', failure])
      handle.destroy()
    } finally {
      console.error = originalError
    }
  })
  test('keeps callback values and getValue snapshots detached from live state', () => {
    let emitted: SpindleLoomBlockEditorValue | undefined
    const handle = mount('loom-bridge-detached-snapshots', value({ blocks: [block('before')] }), (next) => {
      emitted = next
      return false
    })

    expect(controlledProps?.onChange([block('candidate')])).toBe(true)
    emitted!.blocks[0]!.content = 'callback mutation'
    expect(handle.getValue().blocks[0]?.content).toBe('candidate')
    const snapshot = handle.getValue()
    snapshot.blocks[0]!.content = 'snapshot mutation'
    expect(handle.getValue().blocks[0]?.content).toBe('candidate')
    handle.destroy()
  })
})
