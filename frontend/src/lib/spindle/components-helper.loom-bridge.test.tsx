import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { registerLiveRoot } from './live-root-registry'
import type {
  PromptBlockDTO,
  SpindleLoomBlockEditorHandle,
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
])
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
}
let controlledProps: ControlledProps | null = null
const unregisterRoots: Array<() => void> = []
const activeHandles = new Set<SpindleLoomBlockEditorHandle>()

mock.module('@/components/shared/FormComponents', () => ({ TextInput: NullComponent, TextArea: NullComponent }))
mock.module('@/components/shared/FormComponents.module.css', () => ({ default: {} }))
mock.module('@/components/shared/NumericInput', () => ({ default: NullComponent }))
mock.module('@/components/shared/NumberStepper', () => ({ default: NullComponent }))
mock.module('@/components/shared/RangeSlider', () => ({ RangeSlider: NullComponent, LabeledRangeSlider: NullComponent }))
mock.module('@/components/shared/Toggle', () => ({ Toggle: NullComponent }))
mock.module('@/components/shared/Badge', () => ({ Badge: NullComponent }))
mock.module('@/components/shared/Spinner', () => ({ Spinner: NullComponent }))
mock.module('@/components/shared/CloseButton', () => ({ CloseButton: NullComponent }))
mock.module('@/components/shared/Pagination', () => ({ default: NullComponent }))
mock.module('@/components/shared/CollapsibleSection', () => ({ default: NullComponent }))
mock.module('@/components/shared/SearchableSelect', () => ({ default: NullComponent }))
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
): SpindleLoomBlockEditorHandle {
  const handle = createComponentsHelper(extensionId, extensionId, async () => ({ categories: [] }))
    .mountLoomBlockEditor(ownedRoot(extensionId, `${extensionId}-target`), { value: initial, onChange })
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
  controlledProps = null
})
afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
})

describe('Loom component bridge state transitions', () => {
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

  test('rolls back a callback throw when no reentrant update supersedes the commit', () => {
    const initial = value({ blocks: [block('before')] })
    const handle = mount('loom-bridge-rollback', initial, () => {
      throw new Error('consumer rejected edit')
    })

    expect(controlledProps?.onChange([block('candidate')])).toBe(false)
    expect(handle.getValue()).toEqual(initial)
    handle.destroy()
  })

  test('keeps a synchronous handle.update winner when the callback then throws', () => {
    const initial = value({ blocks: [block('before')] })
    const replacement = value({ blocks: [block('replacement')] })
    let handle!: SpindleLoomBlockEditorHandle
    handle = mount('loom-bridge-reentrant-update', initial, () => {
      handle.update({ value: replacement })
      throw new Error('consumer rejected candidate after update')
    })

    expect(controlledProps?.onChange([block('candidate')])).toBe(false)
    expect(handle.getValue().blocks[0]?.id).toBe('replacement')
    replacement.blocks[0]!.content = 'caller mutation'
    expect(handle.getValue().blocks[0]?.content).toBe('replacement')
    handle.destroy()
  })
})
