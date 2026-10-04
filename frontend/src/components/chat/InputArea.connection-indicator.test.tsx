/// <reference types="bun-types" />

// Behavioral DOM tests for the InputArea connection indicator. The trigger
// button and the connections popover are rendered through the REAL InputArea
// component (interactive react-dom/client root in jsdom), then asserted on
// the resulting markup — replacing the previous readFileSync + regex source
// greps, which were brittle and non-behavioral.
//
// The component only reaches the DOM through a sizeable module graph, so the
// harness follows the InputArea.action-bar-reorder.test.tsx recipe: jsdom
// browser globals installed before any component import, mock.module for the
// pieces that cannot load under bun (@/store → i18n → import.meta.glob,
// vite CSS modules), and a per-test mutable store state object.
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { ConnectionProfile } from '@/types/api'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lumiverse.test/',
  pretendToBeVisual: true,
})
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: TestResizeObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: ((cb: FrameRequestCallback) =>
    dom.window.requestAnimationFrame((t) => cb(t))) as typeof requestAnimationFrame,
  cancelAnimationFrame: ((id: number) =>
    dom.window.cancelAnimationFrame(id)) as typeof cancelAnimationFrame,
})
Object.assign(dom.window, {
  matchMedia: () => ({
    matches: false,
    media: '',
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
  ResizeObserver: TestResizeObserver,
})

const cssProxy = new Proxy({}, { get: (_target, key) => String(key) })
mock.module('./InputArea.module.css', () => ({ default: cssProxy }))
// Deterministic translations: keys verbatim, {{name}} interpolation visible.
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) =>
      opts?.name !== undefined ? `${key}:${opts.name}` : key,
  }),
}))
mock.module('react-router', () => ({
  useNavigate: () => () => undefined,
  useParams: () => ({ chatId: 'chat-test' }),
}))
mock.module('@/components/quick-toolbar/useQuickToolbarActions', () => ({
  useQuickToolbarActions: () => ({ actionById: new Map() }),
}))
mock.module('@/lib/dndUiScale', () => ({
  useScaledSortableStyle: () => ({ setNodeRef: () => undefined, style: {} }),
}))
// `@/lib/commands` transitively imports the i18n resource registry
// (import.meta.glob — vite-only). InputArea's graph only needs COMMANDS as an
// array to search; an empty one renders no QT extras, which these tests do
// not exercise. Deeper transitive importers (formatRelativeTime, loom
// preset-recovery, regex pipeline, …) all reach for the i18n singleton's
// default export; a key-returning stand-in keeps them deterministic without
// loading the vite-only locale glob registry.
mock.module('@/lib/commands', () => ({ COMMANDS: [] }))
mock.module('@/i18n', () => ({
  default: { t: (key: string) => key },
}))

// Mutable per-test store state; the mock factory closes over the binding.
let storeState: Record<string, unknown> = {}
mock.module('@/store', () => {
  const useStore = ((selector: (state: Record<string, unknown>) => unknown) =>
    selector(storeState)) as unknown as typeof import('@/store').useStore
  useStore.getState = () => storeState as unknown as ReturnType<typeof useStore.getState>
  useStore.subscribe = () => (() => undefined) as unknown as ReturnType<typeof useStore.subscribe>
  return { useStore }
})

// Both app modules are imported dynamically AFTER the mocks: statically
// importing the hook would evaluate the real '@/store' (i18n → CSS module
// registries → import.meta.glob) before any mock.module call runs.
const { default: InputArea } = await import('./InputArea')
const { resolveEffectiveChatConnection } = await import('@/hooks/useEffectiveChatConnection')

let createRoot: typeof CreateRoot
let root: Root | null = null
beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
})

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    root = null
  }
  document.body.replaceChildren()
  localStorage.clear()
})

function profile(id: string): ConnectionProfile {
  return {
    id,
    name: `Profile ${id}`,
    provider: 'openai',
    api_url: '',
    model: 'gpt-test',
    preset_id: null,
    is_default: false,
    has_api_key: false,
    metadata: {},
    created_at: 1,
    updated_at: 1,
  }
}

const noop = () => undefined

function installStoreState(connection: {
  profiles: ConnectionProfile[]
  activeProfileId: string | null
  activeChatMetadata: Record<string, unknown> | null
  activeCharacterConnectionId: string | null
}): void {
  storeState = {
    // Composer / toolbar surfaces (Suite off → native connections button).
    messageSelectMode: false,
    selectedMessageIds: [],
    extensions: [],
    // Generation-adjacent state read at render.
    isStreaming: false,
    editingMessageId: null,
    activeChatId: 'chat-test',
    activeGenerationId: null,
    chatHeads: [],
    activeCharacterId: null,
    activeGroupCharacterId: null,
    inputBarEnterToSend: true,
    saveDraftInput: true,
    voiceSettings: {},
    activePersonaId: null,
    getActivePresetForGeneration: () => null,
    activeLoomPresetId: null,
    loomRegistry: [],
    regenFeedback: { enabled: false },
    councilSettings: { toolsSettings: {} },
    guidedGenerations: [],
    quickReplySets: [],
    personas: [],
    recentPersonaIds: [],
    characterPersonaBindings: {},
    personaTagBindings: {},
    messages: [],
    mpRoomId: null,
    mpIsHost: false,
    isGroupChat: connection.activeChatMetadata?.group === true,
    groupCharacterIds: [],
    mutedCharacterIds: [],
    characters: [],
    expressionDisplay: null,
    impersonateDraftContent: null,
    streamingContent: null,
    streamingGenerationType: null,
    // Effective-connection inputs (the system under test).
    ...connection,
    // Store actions the component may reach for.
    setActiveProfile: noop,
    setActivePersona: noop,
    addMessage: noop,
    updateMessage: noop,
    beginStreaming: noop,
    startStreaming: noop,
    stopStreaming: noop,
    setStreamingError: noop,
    openModal: noop,
    openDrawer: noop,
    setSetting: noop,
    setActiveChatMetadata: noop,
    setMentionQueue: noop,
    setExpressionDisplay: noop,
    setImpersonateDraftContent: noop,
    updateCharacter: noop,
    updatePersona: noop,
  }
}

/** Render InputArea and open the connections popover; returns its document. */
async function renderInputAreaWithPopover(connection: {
  profiles: ConnectionProfile[]
  activeProfileId: string | null
  activeChatMetadata: Record<string, unknown> | null
  activeCharacterConnectionId: string | null
}): Promise<{
  trigger: HTMLButtonElement
  popover: Element
}> {
  installStoreState(connection)
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<InputArea chatId="chat-test" />)
    await Promise.resolve()
  })

  const trigger = document.querySelector<HTMLButtonElement>('button[title^="input.switchConnection"]')
  expect(trigger).toBeTruthy()
  await act(async () => {
    trigger!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })

  const popover = document.querySelector('[class="popover"]')
  expect(popover).toBeTruthy()
  return { trigger: trigger!, popover: popover! }
}

function connectionRow(popover: Element, name: string): HTMLButtonElement {
  const row = [...popover.querySelectorAll<HTMLButtonElement>('button.popRowBtn')]
    .find((button) => button.textContent?.includes(name))
  expect(row).toBeTruthy()
  return row!
}

describe('InputArea connection indicator — resolver inputs', () => {
  // Pure-resolver cases kept from the previous file: they pin the ladder the
  // DOM tests below render through.
  const BASE = {
    profiles: [profile('pinned'), profile('charbound'), profile('active')],
    activeProfileId: 'active',
  }

  test('chat pin wins over the character bind', () => {
    const result = resolveEffectiveChatConnection({
      ...BASE,
      activeChatMetadata: { connection_profile_id: 'pinned' },
      activeCharacterConnectionId: 'charbound',
    })
    expect(result.effectiveConnectionId).toBe('pinned')
    expect(result.overrideSource).toBe('chat')
    expect(result.profile?.name).toBe('Profile pinned')
  })

  test('character bind in a solo chat is the override', () => {
    const result = resolveEffectiveChatConnection({
      ...BASE,
      activeChatMetadata: null,
      activeCharacterConnectionId: 'charbound',
    })
    expect(result.effectiveConnectionId).toBe('charbound')
    expect(result.overrideSource).toBe('character')
  })

  test('group chats suppress the character override', () => {
    const result = resolveEffectiveChatConnection({
      ...BASE,
      activeChatMetadata: { group: true },
      activeCharacterConnectionId: 'charbound',
    })
    expect(result.effectiveConnectionId).toBe('active')
    expect(result.overrideSource).toBeNull()
  })
})

describe('InputArea connection indicator — rendered trigger and popover', () => {
  test('chat pin: Pin badge on the trigger, chat hint, effective row highlighted and badged', async () => {
    const { trigger, popover } = await renderInputAreaWithPopover({
      profiles: [profile('pinned'), profile('charbound'), profile('active')],
      activeProfileId: 'active',
      activeChatMetadata: { connection_profile_id: 'pinned' },
      activeCharacterConnectionId: 'charbound',
    })

    // Trigger: bound-state class, chat-bound tooltip, and a Pin mini-badge.
    expect(trigger.classList.contains('actionBtnHasSelection')).toBe(true)
    expect(trigger.getAttribute('title')).toBe('input.switchConnectionChatBound:Profile pinned')
    const triggerBadge = trigger.querySelector('span[class="badge"]')
    expect(triggerBadge).toBeTruthy()
    expect(triggerBadge!.querySelector('svg.lucide-pin')).toBeTruthy()
    expect(triggerBadge!.querySelector('svg.lucide-link2')).toBeNull()

    // Popover: the CHAT hint names the pinned profile.
    const hint = popover.querySelector('[class="popBindHint"]')
    expect(hint?.textContent).toBe('quickMenu.connectionBindHint:Profile pinned')

    // The effective (pinned) row is highlighted and badged Chat — not Active.
    const pinnedRow = connectionRow(popover, 'Profile pinned')
    const activeRow = connectionRow(popover, 'Profile active')
    expect(pinnedRow.classList.contains('popRowBtnActive')).toBe(true)
    expect(pinnedRow.querySelector('span.popState')?.textContent)
      .toBe('quickMenu.connectionBindBadgeChat')
    expect(activeRow.classList.contains('popRowBtnActive')).toBe(false)
    expect(activeRow.querySelector('span.popState')).toBeNull()
  })

  test('character bind: Link2 badge on the trigger, character hint, char badge', async () => {
    const { trigger, popover } = await renderInputAreaWithPopover({
      profiles: [profile('pinned'), profile('charbound'), profile('active')],
      activeProfileId: 'active',
      activeChatMetadata: null,
      activeCharacterConnectionId: 'charbound',
    })

    expect(trigger.classList.contains('actionBtnHasSelection')).toBe(true)
    expect(trigger.getAttribute('title')).toBe('input.switchConnectionCharBound:Profile charbound')
    const triggerBadge = trigger.querySelector('span[class="badge"]')
    expect(triggerBadge).toBeTruthy()
    expect(triggerBadge!.querySelector('svg.lucide-link2[width="9"]')).toBeTruthy()
    expect(triggerBadge!.querySelector('svg.lucide-pin')).toBeNull()

    // The CHARACTER hint variant — not the chat-pin wording.
    const hint = popover.querySelector('[class="popBindHint"]')
    expect(hint?.textContent).toBe('quickMenu.connectionBindHintCharacter:Profile charbound')

    const boundRow = connectionRow(popover, 'Profile charbound')
    const activeRow = connectionRow(popover, 'Profile active')
    expect(boundRow.classList.contains('popRowBtnActive')).toBe(true)
    expect(boundRow.querySelector('span.popState')?.textContent)
      .toBe('quickMenu.connectionBindBadgeChar')
    expect(activeRow.classList.contains('popRowBtnActive')).toBe(false)
  })

  test('no override: no badge or hint anywhere, active row highlighted', async () => {
    const { trigger, popover } = await renderInputAreaWithPopover({
      profiles: [profile('pinned'), profile('charbound'), profile('active')],
      activeProfileId: 'active',
      activeChatMetadata: null,
      activeCharacterConnectionId: null,
    })

    expect(trigger.classList.contains('actionBtnHasSelection')).toBe(false)
    expect(trigger.getAttribute('title')).toBe('input.switchConnectionActive:Profile active')
    expect(trigger.querySelector('span[class="badge"]')).toBeNull()

    expect(popover.querySelector('[class="popBindHint"]')).toBeNull()
    const activeRow = connectionRow(popover, 'Profile active')
    const pinnedRow = connectionRow(popover, 'Profile pinned')
    expect(activeRow.classList.contains('popRowBtnActive')).toBe(true)
    expect(activeRow.querySelector('span.popState')).toBeNull()
    expect(pinnedRow.classList.contains('popRowBtnActive')).toBe(false)
  })
})
