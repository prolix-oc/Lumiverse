import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { PromptBlock, PromptVariableValues } from '@/lib/loom/types'

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
  ['MutationObserver', globalObject.MutationObserver],
  ['Event', globalObject.Event],
  ['HTMLInputElement', globalObject.HTMLInputElement],
  ['HTMLSelectElement', globalObject.HTMLSelectElement],
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
  Event: domWindow.Event,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLSelectElement: domWindow.HTMLSelectElement,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
})

const NullComponent = () => null
const translation = (key: string) => key
let resolverCalls = 0
const mountedRoots = new Set<Root>()
const MockToggle = Object.assign(NullComponent, {
  Checkbox: ({ label }: { label?: ReactNode }) => createElement('label', null, label),
})

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: translation, i18n: { language: 'en' } }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => createElement('span', null, i18nKey),
  I18nextProvider: ({ children }: { children?: ReactNode }) => children ?? null,
}))
mock.module('@/i18n', () => ({ default: { t: translation, language: 'en' } }))
mock.module('@/api/macros', () => ({
  resolveMacros: async () => {
    resolverCalls += 1
    return { text: 'resolved', diagnostics: [] }
  },
  resolveMacrosBatch: async () => ({ resolved: {} }),
  getMacroCatalog: async () => ({ categories: [] }),
}))
mock.module('@/hooks/useLoomBuilder', () => ({ useLoomBuilder: () => ({}) }))
mock.module('@/hooks/usePresetProfiles', () => ({ usePresetProfiles: () => ({}) }))
mock.module('@/lib/i18n/loomOptionLabels', () => ({
  useLoomOptionLabels: () => ({ injectionTriggerTypes: [], injectionTriggerLabel: () => '' }),
}))
mock.module('@/components/shared/ExpandedTextEditor', () => ({
  default: NullComponent,
  ExpandableTextarea: NullComponent,
}))
mock.module('@/components/shared/ModalShell', () => ({ ModalShell: NullComponent }))
mock.module('@/components/shared/RangeSlider', () => ({
  RangeSlider: NullComponent,
  LabeledRangeSlider: NullComponent,
}))
mock.module('@/components/shared/PromptVariablesModal', () => ({ PromptVariablesModal: NullComponent }))
mock.module('./PromptVariablesEditor', () => ({ VariablesEditor: NullComponent }))
mock.module('@/components/shared/ConfirmationModal', () => ({ default: NullComponent }))
mock.module('@/components/shared/NumberStepper', () => ({ default: NullComponent }))
mock.module('@/components/shared/PanelFadeIn', () => ({ default: NullComponent }))
mock.module('@/components/shared/Toggle', () => ({ Toggle: MockToggle }))
mock.module('@/lib/toast', () => ({ toast: {} }))
mock.module('@/components/spindle/SpindlePresetEditorTabContent', () => ({ default: NullComponent }))
mock.module('@/components/spindle/SpindlePresetEditorToolbarItem', () => ({ default: NullComponent }))
mock.module('./LoomBuilder.module.css', () => ({ default: {} }))

// A static import would evaluate LoomBuilder before Bun installs the dependency mocks above.
const { BlockEditor, ControlledLoomBlockEditor } = await import('./LoomBuilder')
mock.restore()

const promptVariables: PromptVariableValues = {}

function block(overrides: Partial<PromptBlock> = {}): PromptBlock {
  return {
    id: 'public-block',
    name: 'Public block',
    content: 'Hello {{user}}',
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

function renderBlockEditor(
  trustedHostFeatures: boolean | undefined,
  onSave: (updates: Partial<PromptBlock>) => void,
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(createElement(BlockEditor, {
      block: block(),
      blocks: [block()],
      promptVariables,
      onSave,
      onBack: () => {},
      availableMacros: [],
      compact: true,
      ...(trustedHostFeatures === undefined ? {} : { trustedHostFeatures }),
    }))
  })
  mountedRoots.add(root)
  return { container, root }
}
function renderControlled(
  blocks: PromptBlock[],
  onChange: (next: PromptBlock[]) => boolean,
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(createElement(ControlledLoomBlockEditor, {
      blocks,
      promptVariables,
      onChange,
      availableMacros: [],
      compact: true,
      trustedHostFeatures: false,
    }))
  })
  mountedRoots.add(root)
  return { container, root }
}
function labeledSelect(container: HTMLDivElement, labelText: string): HTMLSelectElement {
  const label = [...container.querySelectorAll('label')].find((entry) => entry.textContent === labelText)
  expect(label).not.toBeNull()
  const select = label?.parentElement?.querySelector<HTMLSelectElement>('select')
  expect(select).not.toBeNull()
  return select!
}

function labeledInput(container: HTMLDivElement, labelText: string): HTMLInputElement {
  const label = [...container.querySelectorAll('label')].find((entry) => entry.textContent === labelText)
  expect(label).not.toBeNull()
  const input = label?.parentElement?.querySelector<HTMLInputElement>('input')
  expect(input).not.toBeNull()
  return input!
}

function saveButton(container: HTMLDivElement): HTMLButtonElement {
  const backButton = container.querySelector<HTMLButtonElement>('button[title="blockEditor.backToList"]')
  expect(backButton).not.toBeNull()
  const toolbar = backButton?.parentElement
  expect(toolbar).not.toBeNull()
  const matches = [...toolbar!.querySelectorAll<HTMLButtonElement>('button')].filter((button) => {
    const accessibleName = button.getAttribute('aria-label')
      ?? button.getAttribute('title')
      ?? button.textContent?.replace(/\s+/g, ' ').trim()
    return accessibleName === 'blockEditor.save'
  })
  expect(matches).toHaveLength(1)
  return matches[0]!
}
function unmountRoot(root: Root): void {
  if (!mountedRoots.has(root)) return
  flushSync(() => root.unmount())
  mountedRoots.delete(root)
}



afterEach(() => {
  for (const root of [...mountedRoots]) unmountRoot(root)
  expect(mountedRoots.size).toBe(0)
  document.body.replaceChildren()
  resolverCalls = 0
})
afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
})

describe('controlled Loom editor trust boundary', () => {
  test('public mode omits contextual and sealed controls, resolver calls, and sealed save fields', () => {
    let saved: Partial<PromptBlock> | undefined
    const { container, root } = renderBlockEditor(false, (updates) => {
      saved = updates
    })
    expect(container.textContent).not.toContain('blockEditor.preview')
    expect(container.textContent).not.toContain('blockEditor.sealedBlockTitle')
    expect(resolverCalls).toBe(0)

    flushSync(() => saveButton(container).click())

    for (const key of [
      'sealed',
      'sealedKey',
      'sealedSource',
      'sealedOriginPresetId',
      'sealedOriginVersion',
      'sealedSha256',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(saved, key)).toBe(false)
    }
    unmountRoot(root)
  })

  test('keeps an invalid role select edit open with a localized validation alert', () => {
    let callbacks = 0
    const { container, root } = renderControlled([block()], () => {
      callbacks += 1
      return false
    })
    flushSync(() => container.querySelector<HTMLButtonElement>('button[title="actions.edit"]')!.click())

    const roleSelect = labeledSelect(container, 'blockEditor.role')
    const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLSelectElement.prototype, 'value')!.set!
    setter.call(roleSelect, 'invalid-role')
    roleSelect.dispatchEvent(new domWindow.Event('change', { bubbles: true }))
    flushSync(() => saveButton(container).click())

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('blockEditor.validationFailed')
    expect(callbacks).toBe(1)
    expect(container.querySelector('button[title="actions.edit"]')).toBeNull()
    expect(saveButton(container)).not.toBeNull()
    unmountRoot(root)
  })

  test('rejects enabling radio mode while multiple children are enabled', () => {
    let callbacks = 0
    const category = block({ id: 'category', marker: 'category', categoryMode: null })
    const first = block({ id: 'first', group: 'category' })
    const second = block({ id: 'second', group: 'category' })
    const { container, root } = renderControlled([category, first, second], () => {
      callbacks += 1
      return false
    })
    flushSync(() => container.querySelector<HTMLButtonElement>('button[title="actions.edit"]')!.click())

    const categoryMode = labeledSelect(container, 'blockEditor.categoryMode')
    const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLSelectElement.prototype, 'value')!.set!
    setter.call(categoryMode, 'radio')
    categoryMode.dispatchEvent(new domWindow.Event('change', { bubbles: true }))
    flushSync(() => saveButton(container).click())

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('blockEditor.validationFailed')
    expect(callbacks).toBe(1)
    expect(saveButton(container)).not.toBeNull()
    unmountRoot(root)
  })

  test('leaves the prior value on callback failure and reports the validation alert', () => {
    const current = block()
    let callbacks = 0
    const { container, root } = renderControlled([current], () => {
      callbacks += 1
      throw new Error('consumer rejected edit')
    })
    flushSync(() => container.querySelector<HTMLButtonElement>('button[title="actions.edit"]')!.click())
    const nameInput = labeledInput(container, 'blockEditor.name')
    const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, 'value')!.set!
    setter.call(nameInput, 'Rejected name')
    nameInput.dispatchEvent(new domWindow.Event('input', { bubbles: true }))
    nameInput.dispatchEvent(new domWindow.Event('change', { bubbles: true }))
    flushSync(() => saveButton(container).click())

    expect(callbacks).toBe(1)
    expect(current.name).toBe('Public block')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('blockEditor.validationFailed')
    expect(saveButton(container)).not.toBeNull()
    unmountRoot(root)
  })

  test('passes a detached clone to a successful callback and closes the editor', () => {
    const current = block()
    let emitted: PromptBlock[] | undefined
    const { container, root } = renderControlled([current], (next) => {
      emitted = next
      return true
    })
    flushSync(() => container.querySelector<HTMLButtonElement>('button[title="actions.edit"]')!.click())
    flushSync(() => saveButton(container).click())

    expect(emitted?.[0]?.name).toBe('Public block')
    expect(emitted?.[0]).not.toBe(current)
    emitted![0]!.name = 'mutated by consumer'
    expect(current.name).toBe('Public block')
    expect(container.querySelector('button[title="actions.edit"]')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    unmountRoot(root)
  })
})
