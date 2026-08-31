import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'
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

const { act, createElement, useEffect, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')

const NullComponent = () => null
const translation = (key: string) => key
let resolverCalls = 0
const resolverRequests: Array<Record<string, unknown>> = []
const mountedRoots = new Set<Root>()
let agentPanelMountCount = 0
let agentPanelUnmountCount = 0
let agentPanelForceDirty = false
const toastRequests: Array<{ type: string; message: string }> = []
const MockToggle = Object.assign(NullComponent, {
  Checkbox: ({ label }: { label?: ReactNode }) => createElement('label', null, label),
})
function MockAgenticRuntimePanel({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const [draft, setDraft] = useState('')
  useEffect(() => {
    agentPanelMountCount += 1
    if (agentPanelForceDirty) onDirtyChange(true)
    return () => {
      agentPanelUnmountCount += 1
      onDirtyChange(false)
    }
  }, [onDirtyChange])
  const updateDraft = (event: { currentTarget: { value: string } }) => {
    setDraft(event.currentTarget.value)
    onDirtyChange(true)
  }
  return createElement(
    'div',
    null,
    createElement('input', {
      'aria-label': 'agent-config-draft',
      value: draft,
      onInput: updateDraft,
      onChange: updateDraft,
    }),
    createElement('button', {
      type: 'button',
      'data-testid': 'agent-config-mark-dirty',
      onClick: () => onDirtyChange(true),
    }, 'mark dirty'),
    createElement('button', {
      type: 'button',
      'data-testid': 'agent-config-clear-dirty',
      onClick: () => onDirtyChange(false),
    }, 'clear dirty'),
  )
}


const mainLoomState: Record<string, unknown> = {}
const mainPresetProfilesState = {
  isResolved: true,
  resolvedPresetId: 'main-preset',
}
const mainStoreState = {
  presetEditorTabs: [],
  presetEditorToolbarItems: [],
  addToast: (toast: { type: string; message: string }) => {
    toastRequests.push(toast)
  },
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
mock.module('@/hooks/useLoomBuilder', () => ({
  useLoomBuilder: () => mainLoomState,
  canMovePromptVariableBetweenOccurrences: (
    source: { blockId: string; promptOrder: number },
    target: { blockId: string; promptOrder: number },
  ) => source.promptOrder !== target.promptOrder && source.blockId !== target.blockId,
  encodeLoomBlockOccurrence: (target: { blockId: string; promptOrder: number }) => (
    JSON.stringify([target.blockId, target.promptOrder])
  ),
  decodeLoomBlockOccurrence: (value: unknown) => {
    if (typeof value !== 'string') return null
    try {
      const parsed = JSON.parse(value) as unknown
      if (!Array.isArray(parsed) || parsed.length !== 2) return null
      const [blockId, promptOrder] = parsed
      if (typeof blockId !== 'string' || blockId.length === 0) return null
      if (!Number.isSafeInteger(promptOrder) || promptOrder < 0) return null
      return { blockId, promptOrder }
    } catch {
      return null
    }
  },
  getLoomBlockAtOccurrence: (blocks: readonly { id: string }[], target: { blockId: string; promptOrder: number }) => {
    const block = blocks[target.promptOrder]
    return block?.id === target.blockId ? block : null
  },
  remapCategorySnapshotsForReorder: (
    sourceBlocks: PromptBlock[],
    reorderedEntries: readonly {
      block: PromptBlock
      source: { blockId: string; promptOrder: number } | null
    }[],
  ) => {
    const encode = (target: { blockId: string; promptOrder: number }) => (
      JSON.stringify([target.blockId, target.promptOrder])
    )
    const getAt = (blocks: readonly PromptBlock[], target: { blockId: string; promptOrder: number }) => {
      if (!Number.isSafeInteger(target.promptOrder) || target.promptOrder < 0) return null
      const block = blocks[target.promptOrder]
      return block?.id === target.blockId ? block : null
    }
    const groups: Array<{ categoryBlock: PromptBlock | null; children: PromptBlock[] }> = []
    let current: { categoryBlock: PromptBlock | null; children: PromptBlock[] } = {
      categoryBlock: null,
      children: [],
    }
    for (const block of sourceBlocks) {
      if (block.marker === 'category') {
        if (current.categoryBlock || current.children.length > 0) groups.push(current)
        current = { categoryBlock: block, children: [] }
      } else {
        if (block.group !== undefined && block.group !== (current.categoryBlock?.id ?? null)) {
          if (current.categoryBlock || current.children.length > 0) groups.push(current)
          current = { categoryBlock: null, children: [] }
        }
        current.children.push(block)
      }
    }
    if (current.categoryBlock || current.children.length > 0) groups.push(current)

    const replacements = new Map<PromptBlock, Record<string, boolean>>()
    for (const group of groups) {
      const category = group.categoryBlock
      const snapshot = category?.savedChildEnabled
      if (!category || !snapshot) continue
      const children = new Set(group.children)
      const canonical: Record<string, boolean> = {}
      for (let promptOrder = 0; promptOrder < sourceBlocks.length; promptOrder += 1) {
        const child = sourceBlocks[promptOrder]!
        if (!children.has(child)) continue
        const coordinateKey = encode({ blockId: child.id, promptOrder })
        if (Object.hasOwn(snapshot, coordinateKey)) canonical[coordinateKey] = snapshot[coordinateKey] === true
        else if (Object.hasOwn(snapshot, child.id)) canonical[coordinateKey] = snapshot[child.id] === true
      }
      const keys = Object.keys(snapshot)
      const same = keys.length === Object.keys(canonical).length
        && keys.every((key) => Object.hasOwn(canonical, key) && snapshot[key] === canonical[key])
      if (!same) replacements.set(category, canonical)
    }
    const canonicalSourceBlocks = replacements.size
      ? sourceBlocks.map((block) => {
        const savedChildEnabled = replacements.get(block)
        return savedChildEnabled ? { ...block, savedChildEnabled } : block
      })
      : sourceBlocks
    const targetBySource = new Map<string, { blockId: string; promptOrder: number }>()
    for (let promptOrder = 0; promptOrder < reorderedEntries.length; promptOrder += 1) {
      const entry = reorderedEntries[promptOrder]!
      if (!entry.source) continue
      const sourceBlock = getAt(canonicalSourceBlocks, entry.source)
      if (!sourceBlock || sourceBlock.id !== entry.block.id) continue
      targetBySource.set(encode(entry.source), { blockId: entry.block.id, promptOrder })
    }
    return reorderedEntries.map((entry) => {
      if (!entry.source) return entry.block
      const sourceBlock = getAt(canonicalSourceBlocks, entry.source)
      if (!sourceBlock?.savedChildEnabled) return entry.block
      const savedChildEnabled: Record<string, boolean> = {}
      for (const [sourceKey, enabled] of Object.entries(sourceBlock.savedChildEnabled)) {
        const target = targetBySource.get(sourceKey)
        if (target) savedChildEnabled[encode(target)] = enabled
      }
      return { ...entry.block, savedChildEnabled }
    })
  },
}))
mock.module('@/hooks/usePresetProfiles', () => ({
  usePresetProfiles: () => ({
    hasDefaults: false,
    hasChatBinding: false,
    hasCharacterBinding: false,
    hasConnectionBinding: false,
    characterBindingEnabled: false,
    activeSource: 'none',
    activeBinding: null,
    resolvedPresetId: mainPresetProfilesState.resolvedPresetId,
    isResolved: mainPresetProfilesState.isResolved,
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
mock.module('@/components/shared/ModalShell', () => ({
  ModalShell: ({ isOpen, children }: { isOpen: boolean; children?: ReactNode }) => (
    isOpen ? createElement('div', { 'data-testid': 'modal-shell' }, children) : null
  ),
}))
mock.module('@/components/shared/RangeSlider', () => ({
  RangeSlider: NullComponent,
  LabeledRangeSlider: NullComponent,
}))
mock.module('@/components/shared/PromptVariablesModal', () => ({
  PromptVariablesModal: ({ isOpen }: { isOpen: boolean }) => isOpen
    ? createElement('div', { 'data-testid': 'prompt-variables-modal' })
    : null,
}))
const MockVariablesEditor = ({
  variables,
  onChange,
  moveTargets,
  onMoveToBlock,
}: {
  variables: PromptVariableDef[]
  onChange: (variables: PromptVariableDef[]) => void
  moveTargets?: Array<{ id: string; name: string }>
  onMoveToBlock?: (variableId: string, targetBlockId: string) => void
}) => createElement(
  'div',
  { 'data-testid': 'controlled-prompt-variables' },
  ...variables.map((variable, index) => {
    const updateName = (event: { currentTarget: { value: string } }) => {
      onChange(variables.map((current, currentIndex) => (
        currentIndex === index ? { ...current, name: event.currentTarget.value } : current
      )))
    }
    return createElement('input', {
      key: variable.id,
      'aria-label': 'prompt-variable-' + index + '-name',
      value: variable.name,
      onInput: updateName,
      onChange: updateName,
    })
  }),
  ...(moveTargets ?? []).map((target) => createElement('button', {
    key: target.id,
    type: 'button',
    'data-testid': 'prompt-variable-move-target',
    onClick: () => onMoveToBlock?.(variables[0]?.id ?? '', target.id),
  }, target.name)),
)

mock.module('./PromptVariablesEditor', () => ({ VariablesEditor: MockVariablesEditor }))
mock.module('@/components/shared/ConfirmationModal', () => ({
  default: ({
    isOpen,
    title,
    onConfirm,
    confirmText,
  }: {
    isOpen: boolean
    title?: string
    onConfirm?: () => void
    confirmText?: string
  }) => (
    isOpen ? createElement(
      'div',
      { 'data-testid': 'confirmation-modal' },
      title,
      onConfirm ? createElement('button', {
        type: 'button',
        'data-testid': 'confirmation-confirm',
        onClick: onConfirm,
      }, confirmText ?? 'confirm') : null,
    ) : null
  ),
}))
mock.module('@/components/shared/NumberStepper', () => ({ default: NullComponent }))
mock.module('@/components/shared/PanelFadeIn', () => ({
  default: ({ children }: { children?: ReactNode }) => children ?? null,
}))
mock.module('@/components/shared/Toggle', () => ({ Toggle: MockToggle }))
mock.module('@/lib/toast', () => ({
  toast: {
    error: (message: string) => {
      toastRequests.push({ type: 'error', message })
    },
  },
}))
mock.module('@/components/spindle/SpindlePresetEditorTabContent', () => ({ default: NullComponent }))
mock.module('@/components/spindle/SpindlePresetEditorToolbarItem', () => ({ default: NullComponent }))
mock.module('./AgenticRuntimePanel', () => ({ default: MockAgenticRuntimePanel }))
mock.module('./LoomBuilder.module.css', () => ({ default: {} }))

// A static import would evaluate LoomBuilder before Bun installs the dependency mocks above.
const { default: LoomBuilder, BlockEditor, ControlledLoomBlockEditor } = await import('./LoomBuilder')
const { remapCategorySnapshotsForReorder: remapCategorySnapshotsForReorderMock } = await import('@/hooks/useLoomBuilder')
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

function configureMainLoomState(withPromptVariable = false): void {
  const mainBlock = block({
    id: 'main-block',
    name: 'Main block',
    ...(withPromptVariable
      ? { variables: [{ id: 'tone', name: 'tone', label: 'Tone', type: 'text' as const, defaultValue: 'warm' }] }
      : {}),
  })
  mainPresetProfilesState.isResolved = true
  mainPresetProfilesState.resolvedPresetId = 'main-preset'
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
    bulkDeletePresets: async () => [],
    bulkExportPresets: async () => 0,
    duplicatePreset: () => {},
    renamePreset: () => {},
    addBlock: () => {},
    removeBlock: () => {},
    updateBlock: () => true,
    toggleBlock: () => {},
    toggleCategoryChildren: () => {},
    movePromptVariable: () => false,
    saveSamplerOverrides: () => {},
    savePromptBehavior: () => {},
    saveCompletionSettings: () => {},
    saveAdvancedSettings: () => {},
    savePromptVariableValues: () => {},
    applyRuntimeBlockProfile: () => {},
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
      blockOccurrence: { blockId: block().id, promptOrder: 0 },
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
  agentPanelMountCount = 0
  agentPanelUnmountCount = 0
  agentPanelForceDirty = false
  toastRequests.length = 0
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

  test('edits only the selected duplicate block occurrence', () => {
    const blocks = [
      { ...block(), id: 'duplicate', name: 'First occurrence', role: 'system' as const },
      { ...block(), id: 'duplicate', name: 'Second occurrence', role: 'user' as const },
    ]
    let committed: PromptBlock[] | null = null
    const { container, root } = renderControlled(blocks, (next) => { committed = next })
    const editButtons = container.querySelectorAll<HTMLButtonElement>('button[title="actions.edit"]')
    expect(editButtons).toHaveLength(2)
    flushSync(() => editButtons[1].click())
    editRole(container, 'assistant')
    flushSync(() => saveButton(container).click())

    expect(committed?.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: 'First occurrence', role: 'system' },
      { name: 'Second occurrence', role: 'assistant' },
    ])
    unmountRoot(root)
  })

  test('offers distinct-ID move targets but hides a same-ID sibling of the exact source occurrence', () => {
    const movingVariable: PromptVariableDef = {
      id: 'moving-variable',
      name: 'tone',
      label: 'Tone',
      type: 'text',
      defaultValue: '',
    }
    const blocks = [
      block({ id: 'duplicate', name: 'Same-ID sibling', variables: [] }),
      block({ id: 'duplicate', name: 'Exact source', variables: [movingVariable] }),
      block({ id: 'distinct', name: 'Distinct target', variables: [] }),
    ]
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    mountedRoots.add(root)
    flushSync(() => {
      root.render(createElement(BlockEditor, {
        block: blocks[1]!,
        blockOccurrence: { blockId: 'duplicate', promptOrder: 1 },
        blocks,
        promptVariables,
        onSave: () => {},
        onBack: () => {},
        availableMacros: [],
        compact: true,
        onMoveVariable: () => true,
      }))
    })

    const visibleTargets = [...container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="prompt-variable-move-target"]',
    )].map((button) => button.textContent)
    expect(visibleTargets).toEqual(['Distinct target'])
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

  test('dispatches duplicate row toggles and modal deletion by exact coordinate', () => {
    configureMainLoomState()
    const preset = mainLoomState.activePreset as { blocks: PromptBlock[] }
    preset.blocks = [
      { ...block(), id: 'duplicate', name: 'First duplicate' },
      { ...block(), id: 'duplicate', name: 'Second duplicate' },
    ]
    const toggles: unknown[] = []
    const deletions: unknown[] = []
    mainLoomState.toggleBlock = (target: unknown) => { toggles.push(target) }
    mainLoomState.removeBlock = async (target: unknown) => { deletions.push(target) }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    flushSync(() => root.render(createElement(LoomBuilder)))
    mountedRoots.add(root)

    const toggleButtons = container.querySelectorAll<HTMLButtonElement>('button[title="block.disable"]')
    expect(toggleButtons).toHaveLength(2)
    flushSync(() => toggleButtons[1].click())
    expect(toggles).toEqual([{ blockId: 'duplicate', promptOrder: 1 }])
    const deleteButtons = container.querySelectorAll<HTMLButtonElement>('button[title="actions.delete"]')
    expect(deleteButtons).toHaveLength(2)
    flushSync(() => deleteButtons[1].click())
    const confirmButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'actions.delete')
    expect(confirmButton).toBeDefined()
    flushSync(() => confirmButton!.click())
    expect(deletions).toEqual([{ blockId: 'duplicate', promptOrder: 1 }])
    unmountRoot(root)
  })

  test('keeps the Agents & Tools draft mounted and guards dirty outer tab switches', () => {
    configureMainLoomState()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    flushSync(() => root.render(createElement(LoomBuilder, { compact: true })))
    mountedRoots.add(root)

    const runtimeTab = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'editorTabs.agenticRuntime')
    const presetTab = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'editorTabs.preset')
    expect(runtimeTab).toBeDefined()
    expect(presetTab).toBeDefined()
    flushSync(() => runtimeTab!.click())

    const draftInput = container.querySelector<HTMLInputElement>('input[aria-label="agent-config-draft"]')
    expect(draftInput).not.toBeNull()
    const valueSetter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, 'value')!.set!
    flushSync(() => {
      valueSetter.call(draftInput, 'Unsaved profile prompt')
      draftInput!.dispatchEvent(new domWindow.Event('input', { bubbles: true }))
    })

    flushSync(() => presetTab!.click())
    expect(runtimeTab?.getAttribute('aria-selected')).toBe('true')
    expect(toastRequests.at(-1)).toEqual({
      type: 'warning',
      message: 'agenticRuntime.navigation.saveBeforePresetAction',
    })
    expect(draftInput?.value).toBe('Unsaved profile prompt')
    expect(draftInput?.closest<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(false)

    mainLoomState.activePreset = {
      ...(mainLoomState.activePreset as Record<string, unknown>),
      cacheRevision: 2,
    }
    flushSync(() => root.render(createElement(LoomBuilder, { compact: true })))
    expect(draftInput?.value).toBe('Unsaved profile prompt')
    expect(agentPanelMountCount).toBe(1)

    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="agent-config-clear-dirty"]')!.click())
    flushSync(() => presetTab!.click())
    expect(presetTab?.getAttribute('aria-selected')).toBe('true')
    expect(draftInput?.closest<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(true)
    flushSync(() => runtimeTab!.click())
    expect(draftInput?.value).toBe('Unsaved profile prompt')
    expect(agentPanelMountCount).toBe(1)

    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs).toHaveLength(2)
    expect(tabs.every((tab) => tab.id && tab.getAttribute('aria-controls'))).toBe(true)
    for (const tab of tabs) {
      const panel = container.querySelector<HTMLElement>(`#${tab.getAttribute('aria-controls')}`)
      expect(panel).not.toBeNull()
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id)
    }
    const activeTab = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')
    expect(activeTab?.tabIndex).toBe(0)
    const inactiveTab = tabs.find((tab) => tab !== activeTab)
    expect(inactiveTab?.tabIndex).toBe(-1)
    flushSync(() => {
      inactiveTab!.focus()
      inactiveTab!.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(document.activeElement).toBe(tabs[0])
    flushSync(() => tabs[0]!.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(document.activeElement).toBe(tabs[1])
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')

    unmountRoot(root)
    expect(agentPanelUnmountCount).toBe(1)
  })

  test('blocks preset replacement and portable actions while the agent draft is dirty', () => {
    configureMainLoomState()
    let selectCalls = 0
    let createCalls = 0
    let duplicateCalls = 0
    let deleteCalls = 0
    let exportCalls = 0
    let legacyExportCalls = 0
    Object.assign(mainLoomState, {
      registry: {
        'main-preset': { name: 'Main preset', blockCount: 1 },
        'other-preset': { name: 'Other preset', blockCount: 0 },
      },
      selectPreset: () => { selectCalls += 1 },
      createPreset: () => { createCalls += 1 },
      duplicatePreset: () => { duplicateCalls += 1 },
      deletePreset: () => { deleteCalls += 1 },
      exportInternal: () => {
        exportCalls += 1
        return null
      },
      exportLegacy: () => {
        legacyExportCalls += 1
        return null
      },
    })

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    flushSync(() => root.render(createElement(LoomBuilder, { compact: true })))
    mountedRoots.add(root)

    const buttonWithText = (text: string): HTMLButtonElement => {
      const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((candidate) => candidate.textContent === text)
      expect(button).toBeDefined()
      return button!
    }
    const openPresetMenu = () => {
      const menuButton = container.querySelector<HTMLButtonElement>('button[title="preset.moreOptions"]')
      expect(menuButton).not.toBeNull()
      flushSync(() => menuButton!.click())
    }
    const clearDirty = () => {
      flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="agent-config-clear-dirty"]')!.click())
    }
    const markDirty = () => {
      flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="agent-config-mark-dirty"]')!.click())
    }
    const returnToPresetTab = () => {
      clearDirty()
      flushSync(() => buttonWithText('editorTabs.preset').click())
    }
    const prepareBlockedAction = () => {
      returnToPresetTab()
      markDirty()
    }
    const expectBlockedAndReturned = () => {
      expect(buttonWithText('editorTabs.agenticRuntime').getAttribute('aria-selected')).toBe('true')
      expect(toastRequests.at(-1)).toEqual({
        type: 'warning',
        message: 'agenticRuntime.navigation.saveBeforePresetAction',
      })
    }

    flushSync(() => buttonWithText('editorTabs.agenticRuntime').click())
    const draftInput = container.querySelector<HTMLInputElement>('input[aria-label="agent-config-draft"]')!
    const valueSetter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, 'value')!.set!
    flushSync(() => {
      valueSetter.call(draftInput, 'Dirty draft')
      draftInput.dispatchEvent(new domWindow.Event('input', { bubbles: true }))
    })

    returnToPresetTab()
    markDirty()
    const presetSelect = container.querySelector<HTMLSelectElement>('select')
    expect(presetSelect).not.toBeNull()
    const selectValueSetter = Object.getOwnPropertyDescriptor(
      domWindow.HTMLSelectElement.prototype,
      'value',
    )!.set!
    flushSync(() => {
      selectValueSetter.call(presetSelect, 'other-preset')
      presetSelect!.dispatchEvent(new domWindow.Event('change', { bubbles: true }))
    })
    expect(selectCalls).toBe(0)
    expectBlockedAndReturned()

    prepareBlockedAction()
    openPresetMenu()
    flushSync(() => buttonWithText('preset.newPreset').click())
    const nameInput = container.querySelector<HTMLInputElement>('input[placeholder="preset.namePlaceholder"]')
    expect(nameInput).not.toBeNull()
    flushSync(() => {
      valueSetter.call(nameInput, 'Blocked preset')
      nameInput!.dispatchEvent(new domWindow.Event('input', { bubbles: true }))
      nameInput!.dispatchEvent(new domWindow.Event('change', { bubbles: true }))
    })
    flushSync(() => buttonWithText('preset.create').click())
    expect(createCalls).toBe(0)
    expectBlockedAndReturned()

    prepareBlockedAction()
    openPresetMenu()
    flushSync(() => buttonWithText('preset.duplicate').click())
    expect(duplicateCalls).toBe(0)
    expectBlockedAndReturned()

    prepareBlockedAction()
    openPresetMenu()
    flushSync(() => buttonWithText('actions.delete').click())
    expect(deleteCalls).toBe(0)
    expect(container.querySelector('[data-testid="confirmation-modal"]')).toBeNull()
    expectBlockedAndReturned()

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(fileInput).not.toBeNull()
    let filePickerClicks = 0
    fileInput?.addEventListener('click', () => { filePickerClicks += 1 })
    prepareBlockedAction()
    openPresetMenu()
    flushSync(() => buttonWithText('preset.importLoomJson').click())
    expect(filePickerClicks).toBe(0)
    expectBlockedAndReturned()

    prepareBlockedAction()
    openPresetMenu()
    flushSync(() => buttonWithText('preset.exportLoomJson').click())
    expect(exportCalls).toBe(0)
    expectBlockedAndReturned()

    prepareBlockedAction()
    openPresetMenu()
    flushSync(() => buttonWithText('preset.exportLegacy').click())
    expect(legacyExportCalls).toBe(0)
    expect(container.querySelector('[data-testid="confirmation-modal"]')).toBeNull()
    expectBlockedAndReturned()

    expect(draftInput.value).toBe('Dirty draft')
    expect(agentPanelMountCount).toBe(1)
    unmountRoot(root)
  })
  test('keeps legacy export confirmation open and reports sealed export failures', () => {
    configureMainLoomState()
    let exportCalls = 0
    Object.assign(mainLoomState, {
      exportLegacy: () => {
        exportCalls += 1
        throw new Error('LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE')
      },
    })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    flushSync(() => root.render(createElement(LoomBuilder, { compact: true })))
    mountedRoots.add(root)

    const menuButton = container.querySelector<HTMLButtonElement>('button[title="preset.moreOptions"]')
    expect(menuButton).not.toBeNull()
    flushSync(() => menuButton!.click())
    const exportButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'preset.exportLegacy')
    expect(exportButton).toBeDefined()
    flushSync(() => exportButton!.click())
    expect(container.querySelector('[data-testid="confirmation-modal"]')).not.toBeNull()

    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="confirmation-confirm"]')!.click())
    expect(exportCalls).toBe(1)
    expect(container.querySelector('[data-testid="confirmation-modal"]')).not.toBeNull()
    expect(toastRequests.at(-1)).toEqual({
      type: 'error',
      message: 'toast.portableErrors.LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE',
    })
    unmountRoot(root)
  })

  test('opens prompt variables while the profile cache is still resolving', () => {
    configureMainLoomState(true)
    mainPresetProfilesState.isResolved = false
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    flushSync(() => root.render(createElement(LoomBuilder, { compact: true })))
    mountedRoots.add(root)

    const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((entry) => entry.textContent?.includes('actions.configureVariables'))
    expect(button).toBeDefined()
    expect(button?.disabled).toBe(false)
    flushSync(() => button!.click())
    expect(container.querySelector('[data-testid="prompt-variables-modal"]')).not.toBeNull()
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
  test('remaps saved category state by exact source occurrence during reorder', () => {
    const sourceBlocks = [
      block({
        id: 'category',
        marker: 'category',
        savedChildEnabled: {
          '["alpha",1]': false,
          '["beta",2]': true,
        },
      }),
      block({ id: 'alpha', group: 'category' }),
      block({ id: 'beta', group: 'category' }),
    ]
    const reorderedEntries = [
      { block: sourceBlocks[2]!, source: { blockId: 'beta', promptOrder: 2 } },
      { block: sourceBlocks[1]!, source: { blockId: 'alpha', promptOrder: 1 } },
      { block: sourceBlocks[0]!, source: { blockId: 'category', promptOrder: 0 } },
    ]

    const reordered = remapCategorySnapshotsForReorderMock(sourceBlocks, reorderedEntries)

    expect(reordered[2]?.savedChildEnabled).toEqual({
      '["alpha",1]': false,
      '["beta",0]': true,
    })
    expect(reordered[2]?.savedChildEnabled).not.toBe(sourceBlocks[0]!.savedChildEnabled)
    expect(sourceBlocks[0]!.savedChildEnabled).toEqual({
      '["alpha",1]': false,
      '["beta",2]': true,
    })
  })
})
