import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import type { PromptBlockDTO, SpindleLoomBlockEditorHandle, SpindleLoomBlockEditorValue } from 'lumiverse-spindle-types'
import { registerLiveRoot } from './live-root-registry'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis
Object.defineProperty(domWindow, 'event', { configurable: true, value: undefined, writable: true })
Object.defineProperty(domWindow, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }),
})
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['Element', globalObject.Element],
  ['HTMLElement', globalObject.HTMLElement],
  ['Node', globalObject.Node],
  ['Event', globalObject.Event],
  ['HTMLInputElement', globalObject.HTMLInputElement],
  ['HTMLSelectElement', globalObject.HTMLSelectElement],
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
  Event: domWindow.Event,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLSelectElement: domWindow.HTMLSelectElement,
  MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
})

const NullComponent = () => null
const translation = (key: string) => key
const placementState = {
  drawerTabs: [] as Array<{ root: HTMLElement; extensionId: string }>,
  characterEditorTabs: [],
  presetEditorTabs: [],
  presetEditorToolbarItems: [],
  floatWidgets: [],
  dockPanels: [],
  appMounts: [],
}
const unregisterRoots: Array<() => void> = []
const activeHandles = new Set<SpindleLoomBlockEditorHandle>()

const MockButton = ({
  children,
  onClick,
  title,
  type = 'button',
}: {
  children?: ReactNode
  onClick?: () => void
  title?: string
  type?: 'button' | 'submit' | 'reset'
}) => createElement('button', { onClick, title, type }, children)
const MockCheckbox = ({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
}) => createElement(
  'label',
  null,
  createElement('input', {
    type: 'checkbox',
    checked,
    onChange: (event: { currentTarget: { checked: boolean } }) => onChange(event.currentTarget.checked),
  }),
  label,
)

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: translation, i18n: { language: 'en' } }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => createElement('span', null, i18nKey),
}))
mock.module('@/i18n', () => ({ default: { t: translation, language: 'en' } }))
mock.module('@/api/macros', () => ({
  resolveMacros: async () => ({ text: 'resolved', diagnostics: [] }),
  resolveMacrosBatch: async () => ({ resolved: {} }),
  getMacroCatalog: async () => ({ categories: [] }),
}))
mock.module('@/store', () => ({
  useStore: Object.assign(() => null, { getState: () => placementState }),
}))
mock.module('@/hooks/useLoomBuilder', () => ({ useLoomBuilder: () => ({}) }))
mock.module('@/hooks/usePresetProfiles', () => ({
  usePresetProfiles: () => ({
    hasDefaults: false,
    hasChatBinding: false,
    hasCharacterBinding: false,
    hasConnectionBinding: false,
    characterBindingEnabled: false,
    activeSource: 'none',
    activeBinding: null,
    resolvedPresetId: 'main-preset',
    isResolved: true,
    isLoading: false,
    defaults: null,
    chatBinding: null,
    characterBinding: null,
    connectionBinding: null,
    activeChatId: null,
    activeCharacterId: null,
    activeProfileId: null,
    captureDefaults: () => {},
    clearDefaults: () => {},
    selectResolvedPreset: () => null,
    bindToChat: () => {},
    unbindChat: () => {},
    bindToCharacter: () => {},
    unbindCharacter: () => {},
    bindToConnection: () => {},
    unbindConnection: () => {},
  }),
}))
mock.module('@/lib/i18n/loomOptionLabels', () => ({
  useLoomOptionLabels: () => ({
    injectionTriggerTypes: [],
    injectionTriggerLabel: () => '',
    addableMarkers: [],
    markerLabel: () => '',
    markerSectionLabel: () => '',
  }),
}))
mock.module('@/components/shared/FormComponents', () => ({
  TextInput: NullComponent,
  TextArea: NullComponent,
  Button: MockButton,
}))
mock.module('@/components/shared/FormComponents.module.css', () => ({ default: {} }))
mock.module('@/components/shared/ExpandedTextEditor', () => ({ default: NullComponent, ExpandableTextarea: NullComponent }))
mock.module('@/components/shared/ModalShell', () => ({ ModalShell: NullComponent }))
mock.module('@/components/shared/RangeSlider', () => ({ RangeSlider: NullComponent, LabeledRangeSlider: NullComponent }))
mock.module('@/components/shared/PromptVariablesModal', () => ({ PromptVariablesModal: NullComponent }))
mock.module('./PromptVariablesEditor', () => ({ VariablesEditor: NullComponent }))
mock.module('@/components/shared/ConfirmationModal', () => ({ default: NullComponent }))
mock.module('@/components/shared/NumberStepper', () => ({ default: NullComponent }))
mock.module('@/components/shared/PanelFadeIn', () => ({ default: NullComponent }))
mock.module('@/components/shared/Toggle', () => ({ Toggle: { Checkbox: MockCheckbox, Switch: MockCheckbox } }))
mock.module('@/lib/toast', () => ({ toast: {} }))
mock.module('@/components/spindle/SpindlePresetEditorTabContent', () => ({ default: NullComponent }))
mock.module('@/components/spindle/SpindlePresetEditorToolbarItem', () => ({ default: NullComponent }))
mock.module('./LoomBuilder.module.css', () => ({ default: {} }))

// This child suite intentionally loads the known component graph after installing
// Bun mocks, so the bridge renders the production ControlledLoomBlockEditor export.
const { createComponentsHelper } = await import('./components-helper')
mock.restore()

function ownedRoot(extensionId: string): HTMLElement {
  const root = document.createElement('section')
  root.setAttribute('data-spindle-extension-root', extensionId)
  document.body.append(root)
  unregisterRoots.push(registerLiveRoot(extensionId, root, null, 0))
  placementState.drawerTabs.push({ root, extensionId })
  return root
}

function block(id: string, overrides: Partial<PromptBlockDTO> = {}): PromptBlockDTO {
  return {
    id,
    name: id,
    content: `content for ${id}`,
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

function value(blocks: PromptBlockDTO[] = [block('bridge-block')]): SpindleLoomBlockEditorValue {
  return { blocks, promptVariableValues: {} }
}

function mount(
  extensionId: string,
  initial: SpindleLoomBlockEditorValue,
  onChange: (next: SpindleLoomBlockEditorValue) => void,
): { handle: SpindleLoomBlockEditorHandle; target: HTMLElement } {
  const target = ownedRoot(extensionId)
  const handle = createComponentsHelper(extensionId, extensionId, async () => ({ categories: [] }))
    .mountLoomBlockEditor(target, { value: initial, onChange })
  activeHandles.add(handle)
  return { handle, target }
}

afterEach(() => {
  for (const handle of [...activeHandles]) handle.destroy()
  activeHandles.clear()
  for (const unregister of unregisterRoots.splice(0)) unregister()
  document.body.replaceChildren()
  placementState.drawerTabs.length = 0
  placementState.characterEditorTabs.length = 0
  placementState.presetEditorTabs.length = 0
  placementState.presetEditorToolbarItems.length = 0
  placementState.floatWidgets.length = 0
  placementState.dockPanels.length = 0
  placementState.appMounts.length = 0
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

describe('real Loom component bridge integration', () => {
  test('renders the production editor, updates in place, keeps public controls untrusted, and tears down callbacks', () => {
    const events: string[] = []
    let emitted: SpindleLoomBlockEditorValue | undefined
    let handle!: SpindleLoomBlockEditorHandle
    const mounted = mount('real-loom-bridge', value(), (next) => {
      events.push(`callback:${handle.getValue().blocks[0]?.role}`)
      emitted = next
    })
    handle = mounted.handle
    const target = mounted.target
    const ownedRoots = () => document.querySelectorAll<HTMLElement>('[data-spindle-extension-root="real-loom-bridge"]')
    const renderedRoot = target.firstElementChild
    expect(renderedRoot).not.toBeNull()
    expect(target.children).toHaveLength(1)

    expect(target.textContent).toContain('bridge-block')
    expect(ownedRoots()).toHaveLength(1)
    expect(target.textContent).not.toContain('blockEditor.preview')
    expect(target.textContent).not.toContain('blockEditor.sealedBlockTitle')
    expect(target.querySelector('input[spellcheck="false"]')).toBeNull()

    flushSync(() => handle.update({ value: value([block('updated-block')]) }))
    expect(handle.getValue().blocks[0]?.id).toBe('updated-block')
    expect(target.textContent).toContain('updated-block')
    expect(target).toBe(ownedRoots()[0])
    expect(ownedRoots()).toHaveLength(1)
    expect(target.firstElementChild).toBe(renderedRoot)
    expect(target.children).toHaveLength(1)
    expect(target.textContent).not.toContain('blockEditor.preview')
    expect(target.textContent).not.toContain('blockEditor.sealedBlockTitle')
    expect(target.querySelector('input[spellcheck="false"]')).toBeNull()

    const editButton = target.querySelector<HTMLButtonElement>('button[title="actions.edit"]')
    expect(editButton).not.toBeNull()
    flushSync(() => editButton!.click())
    expect(target.textContent).not.toContain('blockEditor.preview')
    expect(target.textContent).not.toContain('blockEditor.sealedBlockTitle')
    expect(target.querySelector('input[spellcheck="false"]')).toBeNull()

    const roleSelect = target.querySelector<HTMLSelectElement>('select')
    expect(roleSelect).not.toBeNull()
    const setSelectValue = Object.getOwnPropertyDescriptor(domWindow.HTMLSelectElement.prototype, 'value')!.set!
    flushSync(() => {
      setSelectValue.call(roleSelect, 'assistant')
      roleSelect!.dispatchEvent(new domWindow.Event('change', { bubbles: true }))
    })
    const saveButton = [...target.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('blockEditor.save'))
    expect(saveButton).not.toBeUndefined()
    flushSync(() => saveButton!.click())

    expect(emitted?.blocks[0]?.role).toBe('assistant')
    expect(events).toEqual(['callback:assistant'])
    expect(target.textContent).toContain('assistant')

    handle.destroy()
    expect(target.textContent).toBe('')
    const callbackCount = events.length
    editButton!.click()
    expect(events).toHaveLength(callbackCount)
    expect(() => handle.update({ value: value([block('after-destroy')]) })).toThrow('COMPONENT_DESTROYED')
    expect(events).toHaveLength(callbackCount)
  })
})
