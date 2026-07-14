import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { flushSync } from 'react-dom'
import type { SpindleLoomBlockEditorValue, PromptBlockDTO, PromptVariableDefDTO } from 'lumiverse-spindle-types'
import { clearLiveRootsForExtension, registerLiveRoot } from './live-root-registry'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis
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
Object.defineProperty(domWindow, 'event', { configurable: true, value: undefined, writable: true })
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


const generation = 1
const registeredExtensions = new Set<string>()
const unregisterRoots: Array<() => void> = []
const NullComponent = () => null
type MockNumericInputProps = {
  value: number | null
  onChange?: (value: number | null) => void
}
let numericInputProps: MockNumericInputProps | null = null
const MockNumericInput = (props: MockNumericInputProps) => {
  numericInputProps = props
  return null
}
type MockRangeSliderProps = {
  value: number
  onCommit?: (value: number) => void
  onDragValue?: (value: number | null) => void
}
let rangeSliderProps: MockRangeSliderProps | null = null
const MockRangeSlider = (props: MockRangeSliderProps) => {
  rangeSliderProps = props
  return null
}
type MockSearchableSelectProps = {
  multi?: boolean
  value: string | string[]
  onChange?: (value: string | string[]) => void
}
let searchableSelectProps: MockSearchableSelectProps | null = null
const MockSearchableSelect = (props: MockSearchableSelectProps) => {
  searchableSelectProps = props
  return null
}
type MockControlledLoomProps = {
  onChange(blocks: PromptBlockDTO[]): void
  trustedHostFeatures?: boolean
}
let controlledLoomProps: MockControlledLoomProps | null = null
mock.module('@/components/shared/FormComponents', () => ({ TextInput: NullComponent, TextArea: NullComponent }))
mock.module('@/components/shared/FormComponents.module.css', () => ({ default: {} }))
mock.module('@/components/shared/NumericInput', () => ({ default: MockNumericInput }))
mock.module('@/components/shared/NumberStepper', () => ({ default: NullComponent }))
mock.module('@/components/shared/RangeSlider', () => ({ RangeSlider: MockRangeSlider, LabeledRangeSlider: MockRangeSlider }))
mock.module('@/components/shared/Toggle', () => ({ Toggle: NullComponent }))
mock.module('@/components/shared/Badge', () => ({ Badge: NullComponent }))
mock.module('@/components/shared/Spinner', () => ({ Spinner: NullComponent }))
mock.module('@/components/shared/CloseButton', () => ({ CloseButton: NullComponent }))
mock.module('@/components/shared/Pagination', () => ({ default: NullComponent }))
mock.module('@/components/shared/CollapsibleSection', () => ({ default: NullComponent }))
mock.module('@/components/shared/SearchableSelect', () => ({ default: MockSearchableSelect }))
mock.module('@/components/shared/FolderDropdown', () => ({ default: NullComponent }))
mock.module('@/components/panels/connection-manager/ModelCombobox', () => ({ default: NullComponent }))
mock.module('@/api/connections', () => ({ connectionsApi: {} }))
mock.module('@/api/image-gen-connections', () => ({ imageGenConnectionsApi: {} }))
mock.module('@/api/tts-connections', () => ({ ttsConnectionsApi: {} }))
const mockPlacementState = {
  drawerTabs: [] as Array<{ root: HTMLElement; extensionId: string }>,
  characterEditorTabs: [] as Array<{ root: HTMLElement; extensionId: string }>,
  presetEditorTabs: [] as Array<{ root: HTMLElement; extensionId: string }>,
  presetEditorToolbarItems: [] as Array<{ root: HTMLElement; extensionId: string }>,
  floatWidgets: [] as Array<{ root: HTMLElement; extensionId: string }>,
  dockPanels: [] as Array<{ root: HTMLElement; extensionId: string }>,
  appMounts: [] as Array<{ root: HTMLElement; extensionId: string }>,
}
mock.module('@/store', () => ({
  useStore: Object.assign(() => null, { getState: () => mockPlacementState }),
}))
mock.module('@/components/panels/LoomBuilder', () => ({
  ControlledLoomBlockEditor: (props: MockControlledLoomProps) => {
    controlledLoomProps = props
    return createElement('div', { 'data-testid': 'loom-host' })
  },
}))

// The helper is imported after mocks so this test keeps the bridge boundary
// isolated from the application store and the real component dependency graph.
const { createComponentsHelper: createComponentsHelperRaw } = await import('./components-helper')
// Restore the module system so the @/store mock does not leak into other
// test files.  The imported helper retains its captured mocked references.
mock.restore()

const activeHandles = new Set<{ destroy(): void }>()
function createComponentsHelper(...args: Parameters<typeof createComponentsHelperRaw>) {
  const helper = createComponentsHelperRaw(...args)
  return new Proxy(helper, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function' || !String(property).startsWith('mount')) return value
      return (...mountArgs: unknown[]) => {
        const result = value(...mountArgs)
        if (
          result
          && typeof result === 'object'
          && 'destroy' in result
          && typeof result.destroy === 'function'
        ) {
          const handle = result as { destroy(): void }
          const destroy = handle.destroy.bind(handle)
          handle.destroy = () => {
            try { destroy() } finally { activeHandles.delete(handle) }
          }
          activeHandles.add(handle)
        }
        return result
      }
    },
  })
}

afterAll(async () => {
  await act(async () => {})
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
    expect(globalObject[key]).toBe(value)
    expect(Object.getOwnPropertyDescriptor(globalObject, key)).toEqual(originalDescriptors.get(key))
  }
})

afterEach(() => {
  let cleanupError: unknown
  act(() => {
    for (const handle of [...activeHandles]) {
      try { handle.destroy() } catch (error) { cleanupError ??= error }
    }
  })
  for (const unregister of unregisterRoots.splice(0)) unregister()
  for (const extensionId of registeredExtensions) clearLiveRootsForExtension(extensionId, generation)
  registeredExtensions.clear()
  document.body.replaceChildren()
  mockPlacementState.drawerTabs.length = 0
  mockPlacementState.characterEditorTabs.length = 0
  mockPlacementState.presetEditorTabs.length = 0
  mockPlacementState.floatWidgets.length = 0
  mockPlacementState.dockPanels.length = 0
  mockPlacementState.appMounts.length = 0
  controlledLoomProps = null
  numericInputProps = null
  rangeSliderProps = null
  searchableSelectProps = null
  expect(activeHandles.size).toBe(0)
  if (cleanupError) throw cleanupError
})


function ownedRoot(extensionId: string, id: string): HTMLElement {
  const root = document.createElement('section')
  root.setAttribute('data-spindle-extension-root', extensionId)
  registeredExtensions.add(extensionId)
  unregisterRoots.push(registerLiveRoot(extensionId, root, 'ui_panels', generation))
  root.id = id
  document.body.append(root)
  mockPlacementState.drawerTabs.push({ root, extensionId })
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

describe('public component bridge lifecycle and ownership', () => {
  test('filters string targets by current extension ownership before ambiguity checks', () => {
    const first = ownedRoot('bridge-owner-a', 'same-target')
    const second = ownedRoot('bridge-owner-b', 'same-target')
    const helper = createComponentsHelper('bridge-owner-a', 'bridge-owner-a', async () => ({ categories: [] }), generation)
    const handle = helper.mountTextInput('#same-target', { value: 'owned' })
    const otherHandle = createComponentsHelper('bridge-owner-b', 'bridge-owner-b', async () => ({ categories: [] }), generation).mountTextInput('#same-target', { value: 'other' })

    expect(handle.element).toBe(first)
    expect(otherHandle.element).toBe(second)
    handle.destroy()
    otherHandle.destroy()
    ownedRoot('bridge-owner-a', 'ambiguous-target')
    ownedRoot('bridge-owner-a', 'ambiguous-target')
    expect(() => helper.mountTextInput('#ambiguous-target', { value: 'ambiguous' }))
      .toThrow('components.mount*(): target selector is ambiguous: #ambiguous-target')
  })

  test('returns destroy and shares one stable closed-handle error across operations', async () => {
    const root = ownedRoot('bridge-lifecycle', 'lifecycle-target')
    const handle = createComponentsHelper('bridge-lifecycle', 'bridge-lifecycle', async () => ({ categories: [] }), generation).mountLoomBlockEditor(root, { value: value() })

    expect(typeof handle.destroy).toBe('function')
    handle.destroy()
    handle.destroy()

    let updateError: unknown
    try {
      handle.update({ compact: true })
    } catch (error) {
      updateError = error
    }
    let getError: unknown
    try {
      handle.getValue()
    } catch (error) {
      getError = error
    }
    expect(updateError).toBeInstanceOf(Error)
    expect(updateError).toBe(getError)
    await expect(handle.refreshMacros()).rejects.toBe(updateError)
  })

  test('closes mounts when their owned ancestor is removed', async () => {
    const root = ownedRoot('bridge-removal', 'removal-target')
    const handle = createComponentsHelper('bridge-removal', 'bridge-removal', async () => ({ categories: [] }), generation).mountTextInput(root, { value: 'before' })
    root.remove()
    await Promise.resolve()
    await Promise.resolve()
    expect(() => handle.getValue()).toThrow('COMPONENT_DESTROYED')
  })

  test('closes mounts when their registered placement root is detached', async () => {
    const root = ownedRoot('bridge-detached', 'detached-target')
    const handle = createComponentsHelper('bridge-detached', 'bridge-detached', async () => ({ categories: [] }), generation).mountTextInput(root, { value: 'before' })
    root.remove()
    await Promise.resolve()
    await Promise.resolve()
    expect(() => handle.getValue()).toThrow('COMPONENT_DESTROYED')
    handle.destroy()
  })

  test('rejects non-enumerable and symbol fields without mutating the mount', () => {
    const root = ownedRoot('bridge-validation', 'validation-target')
    const malformed = block('malformed') as unknown as Record<string, unknown>
    Object.defineProperty(malformed, 'secret', { value: true, enumerable: false })
    const helper = createComponentsHelper('bridge-validation', 'bridge-validation', async () => ({ categories: [] }), generation)

    expect(() => helper.mountLoomBlockEditor(root, {
      value: value({ blocks: [malformed as unknown as PromptBlockDTO] }),
    })).toThrow('field "secret" must be an enumerable data property')

    const symbolBlock = block('symbol') as unknown as Record<string | symbol, unknown>
    symbolBlock[Symbol('secret')] = true
    expect(() => helper.mountLoomBlockEditor(root, {
      value: value({ blocks: [symbolBlock as unknown as PromptBlockDTO] }),
    })).toThrow('symbol fields are not allowed')

    const knownNonEnumerable = block('known-non-enumerable', { marker: 'category', categoryMode: 'radio' }) as unknown as Record<string, unknown>
    Object.defineProperty(knownNonEnumerable, 'categoryMode', { value: 'radio', enumerable: false })
    expect(() => helper.mountLoomBlockEditor(root, {
      value: value({ blocks: [knownNonEnumerable as unknown as PromptBlockDTO] }),
    })).toThrow('field "categoryMode"')
    expect(root.childNodes).toHaveLength(0)
  })

  test('rejects non-enumerable prompt-value buckets and keys before cloning', () => {
    const root = ownedRoot('bridge-prompt-values', 'prompt-values-target')
    const helper = createComponentsHelper('bridge-prompt-values', 'bridge-prompt-values', async () => ({ categories: [] }), generation)
    const variables: PromptVariableDefDTO[] = [{
      id: 'tone',
      name: 'tone',
      label: 'Tone',
      type: 'text',
      defaultValue: '',
    }]
    const hiddenValue = { tone: 'valid' }
    Object.defineProperty(hiddenValue, 'tone', { value: 'valid', enumerable: false })
    const hiddenKey = { one: hiddenValue } as SpindleLoomBlockEditorValue['promptVariableValues']
    Object.defineProperty(hiddenKey, 'one', { value: hiddenValue, enumerable: false })

    expect(() => helper.mountLoomBlockEditor(root, {
      value: value({
        blocks: [block('one', { variables })],
        promptVariableValues: hiddenKey,
      }),
    })).toThrow('enumerable data property')
    expect(root.childNodes).toHaveLength(0)
  })

  test('rejects accessor variable fields before reading their values', () => {
    const root = ownedRoot('bridge-variable-accessor', 'variable-accessor-target')
    const helper = createComponentsHelper('bridge-variable-accessor', 'bridge-variable-accessor', async () => ({ categories: [] }), generation)
    let getterCalls = 0
    const variable = {
      id: 'tone',
      name: 'tone',
      label: 'Tone',
      defaultValue: '',
    } as Record<string, unknown>
    Object.defineProperty(variable, 'type', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'text'
      },
    })

    expect(() => helper.mountLoomBlockEditor(root, {
      value: value({ blocks: [block('one', { variables: [variable as unknown as PromptVariableDefDTO] })] }),
    })).toThrow('enumerable data property')
    expect(getterCalls).toBe(0)
    expect(root.childNodes).toHaveLength(0)

    const inheritedDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'type')
    getterCalls = 0
    Object.defineProperty(Object.prototype, 'type', {
      configurable: true,
      enumerable: false,
      get() {
        getterCalls += 1
        return 'text'
      },
    })
    try {
      const inheritedVariable = {
        id: 'inherited-tone',
        name: 'tone',
        label: 'Tone',
        defaultValue: '',
      }
      expect(() => helper.mountLoomBlockEditor(root, {
        value: value({ blocks: [block('inherited', { variables: [inheritedVariable as unknown as PromptVariableDefDTO] })] }),
      })).toThrow('.type')
      expect(getterCalls).toBe(0)
    } finally {
      if (inheritedDescriptor) Object.defineProperty(Object.prototype, 'type', inheritedDescriptor)
      else delete (Object.prototype as Record<string, unknown>).type
    }
  })

  test('retained Loom state stays isolated from later prototype pollution', () => {
    const root = ownedRoot('bridge-retained-state', 'retained-state-target')
    const handle = createComponentsHelper('bridge-retained-state', 'bridge-retained-state', async () => ({ categories: [] }), generation).mountLoomBlockEditor(root, { value: value() })
    const inheritedDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'variables')
    let getterCalls = 0
    Object.defineProperty(Object.prototype, 'variables', {
      configurable: true,
      enumerable: false,
      get() {
        getterCalls += 1
        return []
      },
    })
    try {
      expect(handle.getValue().blocks[0]?.variables).toBeUndefined()
      expect(getterCalls).toBe(0)
    } finally {
      if (inheritedDescriptor) Object.defineProperty(Object.prototype, 'variables', inheritedDescriptor)
      else delete (Object.prototype as Record<string, unknown>).variables
      handle.destroy()
    }
  })

  test('retained Loom category state ignores later categoryMode pollution', () => {
    const root = ownedRoot('bridge-retained-category', 'retained-category-target')
    const handle = createComponentsHelper('bridge-retained-category', 'bridge-retained-category', async () => ({ categories: [] }), generation).mountLoomBlockEditor(root, { value: value() })
    const inheritedDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'categoryMode')
    let getterCalls = 0
    Object.defineProperty(Object.prototype, 'categoryMode', {
      configurable: true,
      enumerable: false,
      get() {
        getterCalls += 1
        return 'radio'
      },
    })
    try {
      expect(handle.getValue().blocks[0]?.categoryMode).toBeUndefined()
      expect(getterCalls).toBe(0)
    } finally {
      if (inheritedDescriptor) Object.defineProperty(Object.prototype, 'categoryMode', inheritedDescriptor)
      else delete (Object.prototype as Record<string, unknown>).categoryMode
      handle.destroy()
    }
  })

  test('rejects sparse arrays and out-of-range numeric array properties before normalization', () => {
    const root = ownedRoot('bridge-array-validation', 'array-validation-target')
    const helper = createComponentsHelper('bridge-array-validation', 'bridge-array-validation', async () => ({ categories: [] }), generation)
    const sparseBlocks: PromptBlockDTO[] = []
    sparseBlocks.length = 1
    expect(() => helper.mountLoomBlockEditor(root, {
      value: value({ blocks: sparseBlocks }),
    })).toThrow('sparse array')

    const customPrototypeBlocks = [block('custom-prototype')]
    Object.setPrototypeOf(customPrototypeBlocks, {
      get forEach() {
        throw new Error('custom array getter should not run')
      },
    })
    expect(() => helper.mountLoomBlockEditor(root, {
      value: value({ blocks: customPrototypeBlocks }),
    })).toThrow('prototype is not allowed')

    const malformed = block('array-property')
    Object.defineProperty(malformed.injectionTrigger, '4294967295', {
      value: 'unknown',
      enumerable: false,
    })
    expect(() => helper.mountLoomBlockEditor(root, {
      value: value({ blocks: [malformed] }),
    })).toThrow('unknown field "4294967295"')
    expect(root.childNodes).toHaveLength(0)
  })

  test('rejects duplicate variable names before mounting', () => {
    const root = ownedRoot('bridge-duplicate-vars', 'duplicate-target')
    const duplicateVariables: PromptVariableDefDTO[] = [
      { id: 'first', name: 'tone', label: 'Tone', type: 'text', defaultValue: 'first' },
      { id: 'second', name: 'tone', label: 'Tone shadow', type: 'text', defaultValue: 'second' },
    ]
    const helper = createComponentsHelper('bridge-duplicate-vars', 'bridge-duplicate-vars', async () => ({ categories: [] }), generation)

    expect(() => helper.mountLoomBlockEditor(root, {
      value: value({ blocks: [block('one', { variables: duplicateVariables })] }),
    })).toThrow('duplicate name')
    expect(root.childNodes).toHaveLength(0)
  })

  test('commits valid value updates through detached clones', () => {
    const root = ownedRoot('bridge-valid-update', 'valid-update-target')
    const handle = createComponentsHelper(
      'bridge-valid-update',
      'bridge-valid-update',
      async () => ({ categories: [] }),
      generation,
    ).mountLoomBlockEditor(root, { value: value() })
    const replacement = value({ blocks: [block('replacement')] })

    handle.update({ value: replacement })
    replacement.blocks[0]!.content = 'caller mutation'
    const snapshot = handle.getValue()

    expect(snapshot.blocks[0]?.id).toBe('replacement')
    expect(snapshot.blocks[0]?.content).toBe('replacement')
    snapshot.blocks[0]!.content = 'snapshot mutation'
    expect(handle.getValue().blocks[0]?.content).toBe('replacement')
    handle.destroy()
  })

  test('detaches MultiSelect arrays across initial input, patches, callbacks, and snapshots', () => {
    const initial = ['initial']
    const patched = ['patched']
    const selected = ['selected']
    const callbackValues: string[][] = []
    const root = ownedRoot('bridge-multiselect-clones', 'multiselect-target')
    const handle = createComponentsHelper(
      'bridge-multiselect-clones',
      'bridge-multiselect-clones',
      async () => ({ categories: [] }),
      generation,
    ).mountMultiSelect(root, {
      value: initial,
      onChange(next) {
        callbackValues.push(next)
        next.push('callback mutation')
      },
    })

    initial.push('caller mutation')
    expect(handle.getValue()).toEqual(['initial'])

    handle.update({ value: patched })
    patched.push('caller mutation')
    expect(handle.getValue()).toEqual(['patched'])

    expect(searchableSelectProps?.multi).toBe(true)
    searchableSelectProps?.onChange?.(selected)
    expect(selected).toEqual(['selected'])
    expect(callbackValues).toEqual([['selected', 'callback mutation']])
    expect(handle.getValue()).toEqual(['selected'])

    callbackValues[0]!.push('later callback mutation')
    expect(handle.getValue()).toEqual(['selected'])
    const snapshot = handle.getValue()
    snapshot.push('snapshot mutation')
    expect(handle.getValue()).toEqual(['selected'])
    handle.destroy()
  })

  test('reconciles prompt values when native edits remove or change their definitions', () => {
    const root = ownedRoot('bridge-native-change', 'native-change-target')
    const tone: PromptVariableDefDTO = {
      id: 'tone',
      name: 'tone',
      label: 'Tone',
      type: 'text',
      defaultValue: '',
    }
    const toneAsSwitch: PromptVariableDefDTO = {
      id: 'tone',
      name: 'tone',
      label: 'Tone',
      type: 'switch',
      defaultValue: 0,
    }
    const choice: PromptVariableDefDTO = {
      id: 'choice',
      name: 'choice',
      label: 'Choice',
      type: 'select',
      defaultValue: 'legacy',
      options: [{ id: 'legacy', label: 'Legacy', value: 'legacy' }],
    }
    const changedChoice: PromptVariableDefDTO = {
      id: 'choice',
      name: 'choice',
      label: 'Choice',
      type: 'select',
      defaultValue: 'current',
      options: [{ id: 'current', label: 'Current', value: 'current' }],
    }
    const range: PromptVariableDefDTO = {
      id: 'range',
      name: 'range',
      label: 'Range',
      type: 'slider',
      defaultValue: 5,
      min: 0,
      max: 10,
    }
    const narrowedRange: PromptVariableDefDTO = {
      ...range,
      defaultValue: 2,
      max: 5,
    }
    const stable: PromptVariableDefDTO = {
      id: 'stable',
      name: 'stable',
      label: 'Stable',
      type: 'text',
      defaultValue: '',
    }
    const obsolete: PromptVariableDefDTO = {
      id: 'obsolete',
      name: 'obsolete',
      label: 'Obsolete',
      type: 'text',
      defaultValue: '',
    }
    let emitted: SpindleLoomBlockEditorValue | undefined
    const handle = createComponentsHelper(
      'bridge-native-change',
      'bridge-native-change',
      async () => ({ categories: [] }),
      generation,
    ).mountLoomBlockEditor(root, {
      value: value({
        blocks: [
          block('removed', { variables: [obsolete] }),
          block('kept', { variables: [tone, choice, range, stable, obsolete] }),
        ],
        promptVariableValues: {
          removed: { obsolete: 'drop block' },
          kept: {
            tone: 'drop changed type',
            choice: 'legacy',
            range: 8,
            stable: 'preserve',
            obsolete: 'drop variable',
          },
        },
      }),
      onChange: (next) => {
        emitted = next
      },
    })

    expect(controlledLoomProps?.trustedHostFeatures).toBe(false)
    controlledLoomProps!.onChange([
      block('kept', { variables: [toneAsSwitch, changedChoice, narrowedRange, stable] }),
    ])

    const expectedValues = { kept: { stable: 'preserve' } }
    expect(handle.getValue().promptVariableValues).toEqual(expectedValues)
    expect(emitted?.promptVariableValues).toEqual(expectedValues)
    handle.destroy()
  })

  test('serializes refreshes, rejects queued work on destroy, and ignores late settlement', async () => {
    const root = ownedRoot('bridge-refresh', 'refresh-target')
    const resolvers: Array<(catalog: { categories: [] }) => void> = []
    let providerCalls = 0
    const provider = () => {
      providerCalls += 1
      return new Promise<{ categories: [] }>((resolve) => {
        resolvers.push(resolve)
      })
    }
    const handle = createComponentsHelper('bridge-refresh', 'bridge-refresh', provider, generation).mountLoomBlockEditor(root, {
      value: value(),
    })
    const first = handle.refreshMacros()
    const second = handle.refreshMacros()
    await Promise.resolve()
    await Promise.resolve()
    expect(providerCalls).toBe(1)

    resolvers.shift()!({ categories: [] })
    await first
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(providerCalls).toBe(2)
    handle.destroy()

    let closedError: unknown
    try {
      handle.getValue()
    } catch (error) {
      closedError = error
    }
    await expect(second).rejects.toBe(closedError)
    resolvers.shift()!({ categories: [] })
    await Promise.resolve()
    await expect(handle.refreshMacros()).rejects.toBe(closedError)
  })
  test('mounts a component inside an owned live root without ui_panels permission', () => {
    const root = document.createElement('section')
    root.setAttribute('data-spindle-extension-root', 'permission-free-component')
    const target = document.createElement('div')
    root.append(target)
    document.body.append(root)
    registeredExtensions.add('permission-free-component')
    unregisterRoots.push(registerLiveRoot('permission-free-component', root, null, generation))

    const handle = createComponentsHelper(
      'permission-free-component',
      'permission-free-component',
      async () => ({ categories: [] }),
      generation,
    ).mountTextInput(target, { value: 'free' })

    expect(handle.getValue()).toBe('free')
    handle.destroy()
  })

  test('rejects nested foreign roots and never crosses a nearer stale generation boundary', () => {
    const outer = document.createElement('section')
    outer.setAttribute('data-spindle-extension-root', 'nested-owner')
    const foreign = document.createElement('section')
    foreign.setAttribute('data-spindle-extension-root', 'other-owner')
    const stale = document.createElement('section')
    stale.setAttribute('data-spindle-extension-root', 'nested-owner')
    const foreignTarget = document.createElement('div')
    const staleTarget = document.createElement('div')
    foreign.append(foreignTarget)
    stale.append(staleTarget)
    outer.append(foreign, stale)
    document.body.append(outer)
    registeredExtensions.add('nested-owner')
    registeredExtensions.add('other-owner')
    unregisterRoots.push(registerLiveRoot('nested-owner', outer, null, generation))
    unregisterRoots.push(registerLiveRoot('other-owner', foreign, null, generation))
    unregisterRoots.push(registerLiveRoot('nested-owner', stale, null, generation - 1))

    const helper = createComponentsHelper(
      'nested-owner',
      'nested-owner',
      async () => ({ categories: [] }),
      generation,
    )
    expect(() => helper.mountTextInput(foreignTarget, { value: 'foreign' })).toThrow(/owned by the current extension/)
    expect(() => helper.mountTextInput(staleTarget, { value: 'stale' })).toThrow(/target not found|registered placement/)
  })

  test('performs one portal query for one observer batch containing multiple mounts', async () => {
    const root = ownedRoot('portal-batch', 'portal-batch-root')
    const firstTarget = document.createElement('div')
    const secondTarget = document.createElement('div')
    root.append(firstTarget, secondTarget)
    const helper = createComponentsHelper('portal-batch', 'portal-batch', async () => ({ categories: [] }), generation)
    const first = helper.mountTextInput(firstTarget, { value: 'first' })
    const second = helper.mountTextInput(secondTarget, { value: 'second' })

    const originalQuerySelectorAll = document.body.querySelectorAll.bind(document.body)
    let portalQueries = 0
    document.body.querySelectorAll = ((selector: string) => {
      if (selector === '[data-spindle-component-portal]') portalQueries += 1
      return originalQuerySelectorAll(selector)
    }) as typeof document.body.querySelectorAll
    try {
      document.body.append(
        document.createElement('span'),
        document.createElement('span'),
        document.createElement('span'),
      )
      await Promise.resolve()
      await Promise.resolve()
      expect(portalQueries).toBe(1)
    } finally {
      document.body.querySelectorAll = originalQuerySelectorAll as typeof document.body.querySelectorAll
      first.destroy()
      second.destroy()
    }
  })
  test('commits callback-free scalar edits through the handle without snapping back', () => {
    const root = ownedRoot('bridge-callback-free-scalar', 'callback-free-scalar-target')
    const handle = createComponentsHelper(
      'bridge-callback-free-scalar',
      'bridge-callback-free-scalar',
      async () => ({ categories: [] }),
      generation,
    ).mountNumericInput(root, { value: 2, min: 0, max: 10 })

    expect(numericInputProps?.value).toBe(2)
    flushSync(() => numericInputProps?.onChange?.(7))
    expect(handle.getValue()).toBe(7)

    flushSync(() => handle.update({ disabled: true }))
    expect(numericInputProps?.value).toBe(7)
    expect(handle.getValue()).toBe(7)
    handle.destroy()
  })

  test('commits callback-free range edits through the handle without snapping back', () => {
    const root = ownedRoot('bridge-callback-free-range', 'callback-free-range-target')
    const handle = createComponentsHelper(
      'bridge-callback-free-range',
      'bridge-callback-free-range',
      async () => ({ categories: [] }),
      generation,
    ).mountRangeSlider(root, { value: 25, min: 0, max: 100, step: 1 })

    expect(rangeSliderProps?.value).toBe(25)
    flushSync(() => rangeSliderProps?.onCommit?.(60))
    expect(handle.getValue()).toBe(60)

    flushSync(() => handle.update({ disabled: true }))
    expect(rangeSliderProps?.value).toBe(60)
    expect(handle.getValue()).toBe(60)
    handle.destroy()
  })

  test('commits callback-free select edits through the handle without snapping back', () => {
    const root = ownedRoot('bridge-callback-free-select', 'callback-free-select-target')
    const handle = createComponentsHelper(
      'bridge-callback-free-select',
      'bridge-callback-free-select',
      async () => ({ categories: [] }),
      generation,
    ).mountSelect(root, {
      value: 'first',
      options: [
        { value: 'first', label: 'First' },
        { value: 'second', label: 'Second' },
      ],
    })

    expect(searchableSelectProps?.value).toBe('first')
    flushSync(() => searchableSelectProps?.onChange?.('second'))
    expect(handle.getValue()).toBe('second')

    flushSync(() => handle.update({ placeholder: 'Choose one' }))
    expect(searchableSelectProps?.value).toBe('second')
    expect(handle.getValue()).toBe('second')
    handle.destroy()
  })

})
