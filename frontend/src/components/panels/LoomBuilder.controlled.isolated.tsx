import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { PromptBlock, PromptVariableDef, PromptVariableValues } from '@/lib/loom/types'

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
const resolverRequests: Array<Record<string, unknown>> = []
const mountedRoots = new Set<Root>()
const MockToggle = Object.assign(NullComponent, {
  Checkbox: ({ label }: { label?: ReactNode }) => createElement('label', null, label),
})


const mainLoomState: Record<string, unknown> = {}
const mainStoreState = {
  presetEditorTabs: [],
  presetEditorToolbarItems: [],
  addToast: () => {},
  activeChatId: null,
  activeCharacterId: null,
  activePersonaId: 'preview-persona',
  activeProfileId: 'preview-connection',
  isGroupChat: false,
  user: null,
  breakdownCache: {},
  messages: [],
  openModal: () => {},
}
const mockedStore = Object.assign(
  (selector: (state: typeof mainStoreState) => unknown) => selector(mainStoreState),
  { getState: () => mainStoreState },
)
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: translation, i18n: { language: 'en' } }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => createElement('span', null, i18nKey),
  I18nextProvider: ({ children }: { children?: ReactNode }) => children ?? null,
}))
mock.module('@/i18n', () => ({ default: { t: translation, language: 'en' } }))
mock.module('@/api/macros', () => ({
  resolveMacros: async (request: Record<string, unknown>) => {
    resolverCalls += 1
    resolverRequests.push(request)
    return { text: 'resolved', diagnostics: [] }
  },
  resolveMacrosBatch: async () => ({ resolved: {} }),
  getMacroCatalog: async () => ({ categories: [] }),
}))
mock.module('@/store', () => ({ useStore: mockedStore }))
mock.module('@/hooks/useLoomBuilder', () => ({ useLoomBuilder: () => mainLoomState }))
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
const MockVariablesEditor = ({
  variables,
  onChange,
}: {
  variables: PromptVariableDef[]
  onChange: (variables: PromptVariableDef[]) => void
}) => createElement(
  'div',
  { 'data-testid': 'controlled-prompt-variables' },
  variables.map((variable, index) => {
    const updateName = (event: { currentTarget: { value: string } }) => {
      onChange(variables.map((current, currentIndex) => (
        currentIndex === index ? { ...current, name: event.currentTarget.value } : current
      )))
    }
    return createElement('input', {
      key: variable.id,
      'aria-label': `prompt-variable-${index}-name`,
      value: variable.name,
      onInput: updateName,
      onChange: updateName,
    })
  }),
)
mock.module('./PromptVariablesEditor', () => ({ VariablesEditor: MockVariablesEditor }))
mock.module('@/components/shared/ConfirmationModal', () => ({ default: NullComponent }))
mock.module('@/components/shared/NumberStepper', () => ({ default: NullComponent }))
mock.module('@/components/shared/PanelFadeIn', () => ({
  default: ({ children }: { children?: ReactNode }) => children ?? null,
}))
mock.module('@/components/shared/Toggle', () => ({ Toggle: MockToggle }))
mock.module('@/lib/toast', () => ({ toast: {} }))
mock.module('@/components/spindle/SpindlePresetEditorTabContent', () => ({ default: NullComponent }))
mock.module('@/components/spindle/SpindlePresetEditorToolbarItem', () => ({ default: NullComponent }))
mock.module('./LoomBuilder.module.css', () => ({ default: {} }))

// A static import would evaluate LoomBuilder before Bun installs the dependency mocks above.
const { default: LoomBuilder, BlockEditor, ControlledLoomBlockEditor } = await import('./LoomBuilder')
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
function changedBlock(name = 'Changed block'): PromptBlock {
  return block({
    name,
    role: 'system',
    content: 'Hello {{user}}',
    position: 'pre_history',
    depth: 0,
    isLocked: false,
    injectionTrigger: [],
    characterTagTrigger: undefined,
    categoryMode: null,
    variables: undefined,
  })
}
function changedRoleBlock(role: PromptBlock['role'] = 'assistant'): PromptBlock {
  return block({
    role,
    characterTagTrigger: undefined,
    categoryMode: null,
    variables: undefined,
  })
}

function configureMainLoomState(): void {
  const mainBlock = block({ id: 'main-block', name: 'Main block' })
  Object.assign(mainLoomState, {
    registry: { 'main-preset': { name: 'Main preset', blockCount: 1 } },
    activePresetId: 'main-preset',
    activePreset: {
      id: 'main-preset',
      name: 'Main preset',
      description: '',
      coverUrl: null,
      presetVersion: null,
      lumihubMeta: null,
      passthroughMetadata: {},
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
      blocks: [mainBlock],
      source: null,
      isDefault: false,
      samplerOverrides: {},
      customBody: {},
      promptBehavior: {},
      completionSettings: {},
      advancedSettings: {},
      modelProfiles: {},
      lastProfileKey: null,
      promptVariables: {},
    },
    isLoading: false,
    availableMacros: [],
    refreshMacros: () => {},
    connectionProfile: null,
    refreshConnectionProfile: () => {},
    SAMPLER_PARAMS: [],
    createPreset: () => {},
    selectPreset: () => {},
    saveBlocks: () => {},
    deletePreset: () => {},
    duplicatePreset: () => {},
    renamePreset: () => {},
    addBlock: () => {},
    removeBlock: () => {},
    updateBlock: () => true,
    toggleBlock: () => {},
    saveSamplerOverrides: () => {},
    saveCustomBody: () => {},
    savePromptBehavior: () => {},
    saveCompletionSettings: () => {},
    saveAdvancedSettings: () => {},
    savePromptVariableValues: () => {},
    updatePresetDraft: () => {},
    flushPresetDraft: () => {},
    importFromFile: async () => {},
    importFromST: async () => {},
    exportInternal: () => null,
    exportLegacy: () => null,
  })
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
  onChange: (next: PromptBlock[]) => void,
  trustedHostFeatures?: boolean,
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
      ...(trustedHostFeatures === undefined ? {} : { trustedHostFeatures }),
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

function editRole(container: HTMLDivElement, role: PromptBlock['role']): void {
  const select = labeledSelect(container, 'blockEditor.role')
  const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLSelectElement.prototype, 'value')!.set!
  flushSync(() => {
    setter.call(select, role)
    select.dispatchEvent(new domWindow.Event('change', { bubbles: true }))
  })
}
function assertReopenedCommittedRole(
  container: HTMLDivElement,
  root: Root,
  committed: PromptBlock[],
): void {
  flushSync(() => {
    root.render(createElement(ControlledLoomBlockEditor, {
      blocks: committed,
      promptVariables,
      onChange: () => {},
      availableMacros: [],
      compact: true,
    }))
  })
  flushSync(() => container.querySelector<HTMLButtonElement>('button[title="actions.edit"]')!.click())
  expect(labeledSelect(container, 'blockEditor.role').value).toBe('assistant')
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
  resolverRequests.length = 0
})
afterAll(async () => {
  await act(async () => {})
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

  test('ControlledLoomBlockEditor defaults omitted trusted host features to deny', () => {
    const { container, root } = renderControlled([block()], () => {})
    flushSync(() => container.querySelector<HTMLButtonElement>('button[title="actions.edit"]')!.click())

    expect(container.textContent).not.toContain('blockEditor.preview')
    expect(container.textContent).not.toContain('blockEditor.sealedBlockTitle')
    unmountRoot(root)
  })

  test('defaults BlockEditor trusted host features to deny', () => {
    let saved: Partial<PromptBlock> | undefined
    const { container, root } = renderBlockEditor(undefined, (updates) => {
      saved = updates
    })

    expect(container.textContent).not.toContain('blockEditor.preview')
    expect(container.textContent).not.toContain('blockEditor.sealedBlockTitle')
    flushSync(() => saveButton(container).click())
    for (const key of ['sealed', 'sealedKey', 'sealedSource', 'sealedOriginPresetId', 'sealedOriginVersion', 'sealedSha256']) {
      expect(Object.prototype.hasOwnProperty.call(saved, key)).toBe(false)
    }
    unmountRoot(root)
  })

  test('allows the trusted editor callsite to opt into trusted host features explicitly', () => {
    const { container, root } = renderBlockEditor(true, () => {})

    expect(container.textContent).toContain('blockEditor.preview')
    expect(container.textContent).toContain('blockEditor.sealedBlockTitle')
    unmountRoot(root)
  })

  test('resolves a block preview with the active connection and persona', async () => {
    const { container, root } = renderBlockEditor(true, () => {})
    const previewButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('blockEditor.preview'))
    expect(previewButton).toBeDefined()

    flushSync(() => previewButton!.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550))
    })

    expect(resolverCalls).toBe(1)
    expect(resolverRequests[0]).toMatchObject({
      template: 'Hello {{user}}',
      connection_id: 'preview-connection',
      persona_id: 'preview-persona',
    })
    unmountRoot(root)
  })

  test('Main LoomBuilder explicitly opts into trusted host features', () => {
    configureMainLoomState()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    flushSync(() => root.render(createElement(LoomBuilder, { compact: true })))
    mountedRoots.add(root)

    const editButton = container.querySelector<HTMLButtonElement>('button[title="actions.edit"]')
    expect(editButton).not.toBeNull()
    flushSync(() => editButton!.click())
    expect(container.textContent).toContain('blockEditor.preview')
    expect(container.textContent).toContain('blockEditor.sealedBlockTitle')
    unmountRoot(root)
  })

  test('commits the exact changed payload when the callback returns without a value', () => {
    const current = block()
    let emitted: PromptBlock[] | undefined
    let callbacks = 0
    const { container, root } = renderControlled([current], (next) => {
      callbacks += 1
      emitted = next
    })
    flushSync(() => container.querySelector<HTMLButtonElement>('button[title="actions.edit"]')!.click())
    editRole(container, 'assistant')
    flushSync(() => saveButton(container).click())

    expect(callbacks).toBe(1)
    expect(emitted).toEqual([changedRoleBlock()])
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('button[title="actions.edit"]')).not.toBeNull()
    assertReopenedCommittedRole(container, root, emitted!)
    unmountRoot(root)
  })

  test('commits the exact changed payload when the callback throws and logs the failure', () => {
    const failure = new Error('consumer rejected edit')
    let emitted: PromptBlock[] | undefined
    const logged: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { logged.push(args) }
    try {
      const current = block()
      const { container, root } = renderControlled([current], (next) => {
        emitted = next
        throw failure
      })
      flushSync(() => container.querySelector<HTMLButtonElement>('button[title="actions.edit"]')!.click())
      editRole(container, 'assistant')
      flushSync(() => saveButton(container).click())

      expect(emitted).toEqual([changedRoleBlock()])
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(container.querySelector('button[title="actions.edit"]')).not.toBeNull()
      assertReopenedCommittedRole(container, root, emitted!)
      expect(logged).toContainEqual(['[Spindle] Loom onChange callback failed', failure])
      unmountRoot(root)
    } finally {
      console.error = originalError
    }
  })

  test('commits the exact changed payload when an async callback resolves false', async () => {
    let emitted: PromptBlock[] | undefined
    const { container, root } = renderControlled([block()], (next) => {
      emitted = next
      return Promise.resolve(false)
    })
    flushSync(() => container.querySelector<HTMLButtonElement>('button[title="actions.edit"]')!.click())
    editRole(container, 'assistant')
    flushSync(() => saveButton(container).click())
    await Promise.resolve()

    expect(emitted).toEqual([changedRoleBlock()])
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('button[title="actions.edit"]')).not.toBeNull()
    assertReopenedCommittedRole(container, root, emitted!)
    unmountRoot(root)
  })

  test('commits the exact changed payload and logs an async callback rejection', async () => {
    const failure = new Error('async consumer rejected edit')
    let emitted: PromptBlock[] | undefined
    const logged: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { logged.push(args) }
    try {
      const { container, root } = renderControlled([block()], (next) => {
        emitted = next
        return Promise.reject(failure)
      })
      flushSync(() => container.querySelector<HTMLButtonElement>('button[title="actions.edit"]')!.click())
      editRole(container, 'assistant')
      flushSync(() => saveButton(container).click())
      await Promise.resolve()
      await Promise.resolve()

      expect(emitted).toEqual([changedRoleBlock()])
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(container.querySelector('button[title="actions.edit"]')).not.toBeNull()
      assertReopenedCommittedRole(container, root, emitted!)
      expect(logged).toContainEqual(['[Spindle] Loom onChange callback failed', failure])
      unmountRoot(root)
    } finally {
      console.error = originalError
    }
  })
  test('keeps the committed block and editor open when a duplicate variable schema is rejected, then closes after acceptance', () => {
    const current = block({
      variables: [
        { id: 'tone', name: 'tone', label: 'Tone', type: 'text', defaultValue: 'warm' },
        { id: 'style', name: 'style', label: 'Style', type: 'text', defaultValue: 'plain' },
      ],
    })
    let committed = [current]
    let callbackCalls = 0
    const { container, root } = renderControlled(committed, (next) => {
      callbackCalls += 1
      const names = (next[0]?.variables ?? []).map((variable) => variable.name.trim())
      if (new Set(names).size !== names.length) return false
      committed = next
      return true
    })

    flushSync(() => container.querySelector<HTMLButtonElement>('button[title="actions.edit"]')!.click())
    const variableName = container.querySelector<HTMLInputElement>('input[aria-label="prompt-variable-1-name"]')
    expect(variableName).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, 'value')!.set!
    flushSync(() => {
      setter.call(variableName, 'tone')
      variableName!.dispatchEvent(new domWindow.Event('input', { bubbles: true }))
    })
    flushSync(() => saveButton(container).click())

    expect(callbackCalls).toBe(1)
    expect(committed).toEqual([current])
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('blockEditor.validationFailed')
    expect(container.querySelector('button[title="blockEditor.backToList"]')).not.toBeNull()

    flushSync(() => {
      setter.call(variableName, 'style')
      variableName!.dispatchEvent(new domWindow.Event('input', { bubbles: true }))
    })
    flushSync(() => saveButton(container).click())

    expect(callbackCalls).toBe(2)
    expect(committed[0]?.variables?.map((variable) => variable.name)).toEqual(['tone', 'style'])
    expect(container.querySelector('button[title="blockEditor.backToList"]')).toBeNull()
    expect(container.querySelector('button[title="actions.edit"]')).not.toBeNull()
    unmountRoot(root)
  })

  test('passes a deeply detached payload to a successful callback across edited and untouched blocks', () => {
    const edited = block({
      id: 'edited-block',
      name: 'Edited block',
      injectionTrigger: ['onPrompt'],
      characterTagTrigger: ['hero'],
      variables: [{
        id: 'edited-choice',
        name: 'editedChoice',
        label: 'Edited choice',
        type: 'select',
        defaultValue: 'one',
        options: [
          { id: 'one', label: 'One', value: 'one' },
          { id: 'two', label: 'Two', value: 'two' },
        ],
      }],
    })
    const untouched = block({
      id: 'untouched-block',
      name: 'Untouched block',
      content: 'Untouched {{value}}',
      injectionTrigger: ['onSend'],
      characterTagTrigger: ['villain'],
      variables: [{
        id: 'untouched-choice',
        name: 'untouchedChoice',
        label: 'Untouched choice',
        type: 'select',
        defaultValue: 'alpha',
        options: [{ id: 'alpha', label: 'Alpha', value: 'alpha' }],
      }],
    })
    const current = [edited, untouched]
    const beforeCallback = structuredClone(current)
    let emitted: PromptBlock[] | undefined
    const { container, root } = renderControlled(current, (next) => {
      emitted = next
      const editedCandidate = next[0]!
      const untouchedCandidate = next[1]!
      const editedVariable = editedCandidate.variables?.[0]
      const untouchedVariable = untouchedCandidate.variables?.[0]
      if (editedVariable?.type !== 'select' || untouchedVariable?.type !== 'select') {
        throw new Error('expected select variables in callback candidate')
      }
      editedCandidate.name = 'consumer-mutated edited block'
      editedCandidate.injectionTrigger.push('consumer-edited-trigger')
      editedCandidate.characterTagTrigger?.push('consumer-edited-tag')
      editedVariable.name = 'consumer-mutated edited variable'
      editedVariable.options[0]!.label = 'consumer-mutated edited option'
      untouchedCandidate.name = 'consumer-mutated untouched block'
      untouchedCandidate.injectionTrigger.push('consumer-untouched-trigger')
      untouchedCandidate.characterTagTrigger?.push('consumer-untouched-tag')
      untouchedVariable.options[0]!.value = 'consumer-mutated untouched option'
      return true
    })
    flushSync(() => container.querySelector<HTMLButtonElement>('button[title="actions.edit"]')!.click())
    editRole(container, 'assistant')
    flushSync(() => saveButton(container).click())

    const editedCandidate = emitted?.[0]
    const untouchedCandidate = emitted?.[1]
    expect(emitted).toHaveLength(2)
    expect(editedCandidate?.role).toBe('assistant')
    expect(untouchedCandidate?.role).toBe('system')
    expect(editedCandidate?.name).toBe('consumer-mutated edited block')
    expect(editedCandidate?.injectionTrigger).toContain('consumer-edited-trigger')
    expect(editedCandidate?.characterTagTrigger).toContain('consumer-edited-tag')
    expect(editedCandidate?.variables?.[0]).toMatchObject({ name: 'consumer-mutated edited variable' })
    expect(editedCandidate?.variables?.[0]?.type).toBe('select')
    if (editedCandidate?.variables?.[0]?.type === 'select') {
      expect(editedCandidate.variables[0].options[0]).toMatchObject({ label: 'consumer-mutated edited option' })
    }
    expect(untouchedCandidate?.name).toBe('consumer-mutated untouched block')
    expect(untouchedCandidate?.injectionTrigger).toContain('consumer-untouched-trigger')
    expect(untouchedCandidate?.characterTagTrigger).toContain('consumer-untouched-tag')
    expect(untouchedCandidate?.variables?.[0]).toMatchObject({
      options: [{ value: 'consumer-mutated untouched option' }],
    })
    expect(editedCandidate).not.toBe(edited)
    expect(untouchedCandidate).not.toBe(untouched)
    expect(editedCandidate?.variables).not.toBe(edited.variables)
    expect(untouchedCandidate?.variables).not.toBe(untouched.variables)
    expect(editedCandidate?.injectionTrigger).not.toBe(edited.injectionTrigger)
    expect(editedCandidate?.characterTagTrigger).not.toBe(edited.characterTagTrigger)
    expect(untouchedCandidate?.injectionTrigger).not.toBe(untouched.injectionTrigger)
    expect(untouchedCandidate?.characterTagTrigger).not.toBe(untouched.characterTagTrigger)
    expect(editedCandidate?.variables?.[0]).not.toBe(edited.variables?.[0])
    expect(untouchedCandidate?.variables?.[0]).not.toBe(untouched.variables?.[0])
    expect(editedCandidate?.variables?.[0]?.type).toBe('select')
    expect(untouchedCandidate?.variables?.[0]?.type).toBe('select')
    if (editedCandidate?.variables?.[0]?.type === 'select' && edited.variables?.[0]?.type === 'select') {
      expect(editedCandidate.variables[0].options).not.toBe(edited.variables[0].options)
    }
    if (untouchedCandidate?.variables?.[0]?.type === 'select' && untouched.variables?.[0]?.type === 'select') {
      expect(untouchedCandidate.variables[0].options).not.toBe(untouched.variables[0].options)
    }
    expect(current).toEqual(beforeCallback)
    expect(container.querySelector('button[title="actions.edit"]')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    unmountRoot(root)
  })
})
