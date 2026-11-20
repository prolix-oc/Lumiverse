/// <reference types="bun-types" />

/**
 * RUNTIME REGRESSION TESTS — spec task 5.2
 * "Add runtime-level failing regression tests before any fix".
 *
 * These are real assertions (not a printing harness). They drive the REAL
 * store slice (`@/store`), the REAL WebSocket final-success transition order
 * (`fetchLatestMessages -> reconcileMessagesTail -> endStreaming`, verbatim from
 * `frontend/src/ws/useWebSocket.ts`) through the REAL card components
 * (`BubbleMessage` / `MinimalMessage` -> `*Default` chrome -> `MessageContent`
 * -> `useDisplayRegex` -> `ProseHtml` / `IsolatedHtml`).
 *
 * Row keys are replayed verbatim from `MessageList.tsx` (`virtualListItems`):
 *   ['message', message.id, displayMode].join(':')
 *
 * Every committed frame is captured. A frame is recorded
 *   (a) on every MutationObserver batch of the card host and of every island
 *       shadow root (one batch == one commit's DOM effect flush), and
 *   (b) at every explicit transition boundary.
 * Invariants are asserted across ALL frames of the streaming/final phases, not
 * only at start and end states.
 *
 * Invariants (grouped into one test each, per scenario):
 *   A1 streamed-text-never-blanks                  — no empty intermediary
 *   A2 plain-prose-never-disappears                — visible prose never vanishes
 *   A3 unprocessed-macro-source-never-painted      — no raw macro flash
 *   A4 unprocessed-regex-source-never-painted      — no raw display-regex flash
 *   A5 resolved-progress-never-rewinds             — no rewind / older resolved value
 *   A6 resolved-output-never-disappears            — resolved output never falls back
 *   B1 same-source-image-stays-mounted             — element identity, no load/error replay
 *   B2 html-island-does-not-remount                — island host + shadow root + content
 *   B3 message-content-root-stays-mounted          — no renderer remount
 *   B4 owner-card-node-stays-mounted               — no card remount
 *   C1 no-duplicate-card-for-a-message             — no duplicate bubble
 *   C2 exactly-one-stream-owner-card               — stable single stream owner
 *   C3 final-render-equals-authoritative-content   — final == persisted message
 *
 * NO PRODUCTION CODE IS MODIFIED BY THIS FILE. The fix belongs to task 5.5.
 * These tests are EXPECTED TO FAIL on the current tree; the failure pins the
 * first proven broken boundary from task 5.1:
 *   `useDisplayRegex.ts` -> `useDisplayPreprocessedState` terminal fallback
 *   (`return { value: content, ready: false }`) has no per-(chatId, messageId)
 *   continuity carry, so every content change commits UNPREPROCESSED source
 *   until an async round trip lands.
 */

import { afterAll, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

// ── JSDOM environment ─────────────────────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lumiverse.test/',
  pretendToBeVisual: true,
})
const domWindow = dom.window

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class TestIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
}

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  sessionStorage: domWindow.sessionStorage,
  Node: domWindow.Node,
  NodeFilter: domWindow.NodeFilter,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLImageElement: domWindow.HTMLImageElement,
  HTMLDivElement: domWindow.HTMLDivElement,
  HTMLSpanElement: domWindow.HTMLSpanElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  HTMLAudioElement: domWindow.HTMLAudioElement,
  Audio: domWindow.Audio,
  ShadowRoot: domWindow.ShadowRoot,
  DocumentFragment: domWindow.DocumentFragment,
  Event: domWindow.Event,
  EventTarget: domWindow.EventTarget,
  CustomEvent: domWindow.CustomEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  TouchEvent: domWindow.TouchEvent,
  MutationObserver: domWindow.MutationObserver,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: TestIntersectionObserver,
  DOMParser: domWindow.DOMParser,
  Range: domWindow.Range,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
})

Object.assign(domWindow, {
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
  IntersectionObserver: TestIntersectionObserver,
  scrollTo: () => {},
  requestAnimationFrame: (callback: FrameRequestCallback) => domWindow.setTimeout(() => callback(performance.now()), 0),
  cancelAnimationFrame: (id: number) => domWindow.clearTimeout(id),
})
Object.assign(globalThis, {
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
})

const sleep = (ms: number) => new Promise((resolve) => domWindow.setTimeout(resolve, ms))

// ── Controlled backend ────────────────────────────────────────────────────
// /display-preprocess     : server-side macro {{mood}} -> "radiant"
// /regex-scripts/apply    : display script [[b:x]] -> <b data-resolved="1">x</b>
// The presence of the raw markers in a committed frame is direct evidence of
// unprocessed / regressed rendering; `data-resolved` proves the resolved form.
const CHAT_ID = '11111111-1111-4111-8111-111111111111'
const USER_MESSAGE_ID = '33333333-3333-4333-8333-333333333333'
const IMAGE_SRC = '/api/v1/images/44444444-4444-4444-8444-444444444444'
const RAW_MACRO = '{{mood}}'
const RESOLVED_MACRO = 'radiant'
const RAW_REGEX_MARKER = '[[b:'
const PROSE_ANCHOR = 'She turned slowly, smiling.'
const ISLAND_TAIL = 'island tail'

/**
 * Latency is keyed by the REQUESTED CONTENT, not by call order, so a scenario's
 * arrival order is deterministic no matter how the hook coalesces requests.
 * Every resolve stage has a non-zero latency because a real round trip never
 * lands in the same microtask as the store commit that triggered it; a zero
 * latency stub hides the committed intermediate frame behind a race.
 */
type DelayRule = (content: string) => number

const BASE_PREPROCESS_MS = 100
const BASE_APPLY_MS = 40

const netConfig = {
  preprocessDelay: ((): number => BASE_PREPROCESS_MS) as DelayRule,
  applyDelay: ((): number => BASE_APPLY_MS) as DelayRule,
  preprocessCalls: 0,
  applyCalls: 0,
}

function applyDisplayScript(input: string): string {
  return input.replace(/\[\[b:([^\]]+)\]\]/g, '<b data-resolved="1">$1</b>')
}

function preprocessMacros(input: string): string {
  return input.replace(/\{\{mood\}\}/g, RESOLVED_MACRO)
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input)
  const body = init?.body ? JSON.parse(String(init.body)) : undefined

  if (url.includes('/display-preprocess')) {
    netConfig.preprocessCalls += 1
    const requested = String(body?.items?.[0]?.rawContent ?? '')
    const wait = netConfig.preprocessDelay(requested)
    if (wait > 0) await sleep(wait)
    const items = (body?.items ?? []).map((item: any) => ({
      content: preprocessMacros(String(item.rawContent ?? '')),
    }))
    return new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  if (url.includes('/regex-scripts/apply')) {
    netConfig.applyCalls += 1
    const wait = netConfig.applyDelay(String(body?.content ?? ''))
    if (wait > 0) await sleep(wait)
    return new Response(JSON.stringify({ result: applyDisplayScript(String(body?.content ?? '')) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ error: 'not stubbed' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  })
}) as typeof fetch

const DISPLAY_SCRIPT = {
  id: 'display-bold',
  name: 'display bold',
  find_regex: '\\[\\[b:([^\\]]+)\\]\\]',
  replace_string: '<b data-resolved="1">$1</b>',
  flags: 'g',
  target: ['display'],
  placement: ['ai_output', 'user_input'],
  disabled: false,
  scope: 'global',
  scope_id: null,
  min_depth: null,
  max_depth: null,
  trim_strings: [],
  substitute_macros: 'none',
  actions: [],
  metadata: {},
  updated_at: 1,
  created_at: 1,
} as any

function makeMessage(overrides: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: 'x',
    chat_id: CHAT_ID,
    index_in_chat: 0,
    is_user: false,
    name: '',
    content: '',
    send_date: now,
    swipe_id: 0,
    swipes: [''],
    swipe_dates: [now],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: now,
    revision: 1,
    ...overrides,
  } as any
}

// Streamed segments: plain prose, a server macro, a display-regex marker, and
// an HTML island carrying a stable-source image plus shadow text.
// Strictly append-only, matching `rawStreamContent += token` in chat.ts.
const CHUNK_SEGMENTS = [
  PROSE_ANCHOR,
  ` Mood: ${RAW_MACRO}.`,
  ' [[b:important]]',
  `\n\n<div data-island="1"><style>.isl{color:red}</style><img src="${IMAGE_SRC}" alt="scene"><span class="isl">${ISLAND_TAIL}</span></div>`,
]

function chunk(step: number): string {
  return CHUNK_SEGMENTS.slice(0, step + 1).join('')
}

const LAST_STEP = CHUNK_SEGMENTS.length - 1

// ── Frame model ───────────────────────────────────────────────────────────
type Phase = 'idle' | 'staged' | 'streaming' | 'final'

interface Frame {
  seq: number
  label: string
  phase: Phase
  source: 'step' | 'mutation'
  storeIsStreaming: boolean
  storeStreamBuffer: string
  cardIds: string[]
  streamingCardIds: string[]
  ownerCardNode: number | null
  contentRootNode: number | null
  text: string
  hasRawMacro: boolean
  hasResolvedMacro: boolean
  hasRawRegex: boolean
  hasResolvedRegex: boolean
  islandHostNode: number | null
  islandShadowNode: number | null
  islandShadowText: string
  imageNode: number | null
  imageEvents: number
}

interface Violation {
  invariant: string
  frame: number
  label: string
  phase: Phase
  detail: string
}

interface ScenarioResult {
  config: ScenarioConfig
  frames: Frame[]
  authoritativeContent: string
  ownerId: string
  storeTailContent: string
  storeTailSwipeId: number
  storeMessageIds: string[]
}

type Identity = 'stable' | 'swipe'

interface ScenarioConfig {
  id: string
  title: string
  card: 'bubble' | 'minimal'
  withDisplayScripts: boolean
  preprocessDelay: DelayRule
  applyDelay: DelayRule
  identity: Identity
  /** Deferred `fetchLatestMessages` round trip before `reconcileMessagesTail`. */
  deferredFetchMs: number
  /** Replace the message OBJECT (same message id) after this chunk index. */
  replaceMessageObjectAfterChunk: number | null
  /** Persisted row differs from the last streamed chunk by trailing whitespace. */
  savedContentTrimmed: boolean
  finalSettleMs: number
}

const defaultPreprocessDelay: DelayRule = () => BASE_PREPROCESS_MS
const defaultApplyDelay: DelayRule = () => BASE_APPLY_MS

/** Chunk 1's preprocess resolves LONG after chunk 2's and chunk 3's. */
const outOfOrderPreprocessDelay: DelayRule = (content) =>
  content.includes('Mood:') && !content.includes('[[b:') ? 620 : BASE_PREPROCESS_MS

const SCENARIOS: ScenarioConfig[] = [
  {
    id: 'S1',
    title: 'BubbleMessage — production order, stable identity, saved row trimmed',
    card: 'bubble',
    withDisplayScripts: true,
    preprocessDelay: defaultPreprocessDelay,
    applyDelay: defaultApplyDelay,
    identity: 'stable',
    deferredFetchMs: 0,
    replaceMessageObjectAfterChunk: null,
    savedContentTrimmed: true,
    finalSettleMs: 600,
  },
  {
    id: 'S2',
    title: 'MinimalMessage — production order, stable identity, saved row trimmed',
    card: 'minimal',
    withDisplayScripts: true,
    preprocessDelay: defaultPreprocessDelay,
    applyDelay: defaultApplyDelay,
    identity: 'stable',
    deferredFetchMs: 0,
    replaceMessageObjectAfterChunk: null,
    savedContentTrimmed: true,
    finalSettleMs: 600,
  },
  {
    id: 'S3',
    title: 'BubbleMessage — delayed and OUT-OF-ORDER display preprocessing',
    card: 'bubble',
    withDisplayScripts: true,
    preprocessDelay: outOfOrderPreprocessDelay,
    applyDelay: defaultApplyDelay,
    identity: 'stable',
    deferredFetchMs: 0,
    replaceMessageObjectAfterChunk: null,
    savedContentTrimmed: true,
    finalSettleMs: 1600,
  },
  {
    id: 'S4',
    title: 'BubbleMessage — delayed display-regex application',
    card: 'bubble',
    withDisplayScripts: true,
    preprocessDelay: defaultPreprocessDelay,
    applyDelay: () => 260,
    identity: 'stable',
    deferredFetchMs: 0,
    replaceMessageObjectAfterChunk: null,
    savedContentTrimmed: true,
    finalSettleMs: 1600,
  },
  {
    id: 'S5',
    title: 'BubbleMessage — deferred fetchLatestMessages before reconcile+endStreaming',
    card: 'bubble',
    withDisplayScripts: true,
    preprocessDelay: defaultPreprocessDelay,
    applyDelay: defaultApplyDelay,
    identity: 'stable',
    deferredFetchMs: 150,
    replaceMessageObjectAfterChunk: null,
    savedContentTrimmed: true,
    finalSettleMs: 800,
  },
  {
    id: 'S6',
    title: 'BubbleMessage — message-object replacement with the SAME message id mid-stream',
    card: 'bubble',
    withDisplayScripts: true,
    preprocessDelay: defaultPreprocessDelay,
    applyDelay: defaultApplyDelay,
    identity: 'stable',
    deferredFetchMs: 0,
    replaceMessageObjectAfterChunk: 1,
    savedContentTrimmed: true,
    finalSettleMs: 600,
  },
  {
    id: 'S7',
    title: 'BubbleMessage — swipe identity (streamingSwipeId) finalization',
    card: 'bubble',
    withDisplayScripts: true,
    preprocessDelay: defaultPreprocessDelay,
    applyDelay: defaultApplyDelay,
    identity: 'swipe',
    deferredFetchMs: 0,
    replaceMessageObjectAfterChunk: null,
    savedContentTrimmed: true,
    finalSettleMs: 600,
  },
  {
    id: 'S8',
    title: 'BubbleMessage — ZERO display-regex scripts (isolates the preprocess boundary)',
    card: 'bubble',
    withDisplayScripts: false,
    preprocessDelay: defaultPreprocessDelay,
    applyDelay: defaultApplyDelay,
    identity: 'stable',
    deferredFetchMs: 0,
    replaceMessageObjectAfterChunk: null,
    savedContentTrimmed: true,
    finalSettleMs: 600,
  },
]

function assistantIdFor(index: number): string {
  return `2222222${index}-2222-4222-8222-222222222222`
}

// ── Vite runtime ──────────────────────────────────────────────────────────
interface Runtime {
  server: Awaited<ReturnType<typeof createServer>>
  useStore: any
  BubbleMessage: any
  MinimalMessage: any
  resetDisplayRegexCaches: () => void
  React: typeof import('react')
  createRoot: typeof import('react-dom/client')['createRoot']
}

let runtimePromise: Promise<Runtime> | null = null

async function createRuntime(): Promise<Runtime> {
  const server = await createServer({
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    resolve: {
      alias: [{
        find: /^react-router$/,
        replacement: fileURLToPath(new URL('./streaming-continuity.5-2.router-stub.ts', import.meta.url)),
      }],
    },
  })

  const i18nModule = await server.ssrLoadModule('/src/i18n/index.ts') as { initI18n: () => Promise<unknown> }
  await i18nModule.initI18n()

  const storeModule = await server.ssrLoadModule('/src/store/index.ts') as { useStore: any }
  const bubbleModule = await server.ssrLoadModule('/src/components/chat/BubbleMessage.tsx') as { default: any }
  const minimalModule = await server.ssrLoadModule('/src/components/chat/MinimalMessage.tsx') as { default: any }
  const displayRegexModule = await server.ssrLoadModule('/src/hooks/useDisplayRegex.ts') as {
    resetDisplayRegexCachesForTests: () => void
  }

  const React = await import('react')
  const { createRoot } = await import('react-dom/client')

  return {
    server,
    useStore: storeModule.useStore,
    BubbleMessage: bubbleModule.default,
    MinimalMessage: minimalModule.default,
    resetDisplayRegexCaches: displayRegexModule.resetDisplayRegexCachesForTests,
    React,
    createRoot,
  }
}

function getRuntime(): Promise<Runtime> {
  runtimePromise ??= createRuntime()
  return runtimePromise
}

afterAll(async () => {
  if (!runtimePromise) return
  const runtime = await runtimePromise.catch(() => null)
  await runtime?.server.close()
})

// ── Scenario driver ───────────────────────────────────────────────────────
const scenarioCache = new Map<string, Promise<ScenarioResult>>()

function runScenario(config: ScenarioConfig): Promise<ScenarioResult> {
  let cached = scenarioCache.get(config.id)
  if (!cached) {
    cached = driveScenario(config)
    scenarioCache.set(config.id, cached)
  }
  return cached
}

async function driveScenario(config: ScenarioConfig): Promise<ScenarioResult> {
  const runtime = await getRuntime()
  const { useStore, React, createRoot } = runtime
  const { act, createElement } = React
  const Card = config.card === 'bubble' ? runtime.BubbleMessage : runtime.MinimalMessage
  const displayMode = config.card === 'bubble' ? 'bubble' : 'minimal'
  const scenarioIndex = SCENARIOS.findIndex((entry) => entry.id === config.id)
  const ownerId = assistantIdFor(scenarioIndex)

  netConfig.preprocessDelay = config.preprocessDelay
  netConfig.applyDelay = config.applyDelay
  netConfig.preprocessCalls = 0
  netConfig.applyCalls = 0
  runtime.resetDisplayRegexCaches()

  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)

  // ── identity registry ────────────────────────────────────────────────
  const nodeIds = new Map<object, number>()
  let nodeCounter = 0
  const identity = (node: object | null | undefined): number | null => {
    if (!node) return null
    let id = nodeIds.get(node)
    if (id === undefined) {
      id = ++nodeCounter
      nodeIds.set(node, id)
    }
    return id
  }

  // ── frame recorder ───────────────────────────────────────────────────
  const frames: Frame[] = []
  let phase: Phase = 'idle'
  let label = 'init'
  let recording = false
  let lastSignature = ''
  const observedShadows = new Set<ShadowRoot>()
  const imageEventCounts = new Map<Element, number>()

  const observer = new MutationObserver(() => { capture('mutation') })

  function observeShadow(shadow: ShadowRoot) {
    if (observedShadows.has(shadow)) return
    observedShadows.add(shadow)
    observer.observe(shadow as unknown as Node, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    })
  }

  function trackImage(img: Element) {
    if (imageEventCounts.has(img)) return
    imageEventCounts.set(img, 0)
    const bump = () => imageEventCounts.set(img, (imageEventCounts.get(img) ?? 0) + 1)
    img.addEventListener('load', bump)
    img.addEventListener('error', bump)
  }

  function collectText(rootNode: Element | ShadowRoot | null): string {
    if (!rootNode) return ''
    let text = rootNode.textContent ?? ''
    const scope = rootNode as Element
    const islands = scope.querySelectorAll?.('[data-lumiverse-html-island]') ?? []
    for (const island of Array.from(islands) as Element[]) {
      const shadow = (island as HTMLElement).shadowRoot
      if (shadow) {
        observeShadow(shadow)
        text += ` ${shadow.textContent ?? ''}`
      }
    }
    return text
  }

  function capture(source: 'step' | 'mutation') {
    if (!recording) return
    const state = useStore.getState()
    const cards = Array.from(
      host.querySelectorAll<HTMLElement>('[data-component="BubbleMessage"], [data-component="MinimalMessage"]'),
    )
    const cardIds = cards.map((card) => card.dataset.messageId ?? '?')
    const streamingCardIds = cards
      .filter((card) => card.dataset.part === 'streaming')
      .map((card) => card.dataset.messageId ?? '?')
    const ownerCards = cards.filter((card) => card.dataset.messageId === ownerId)
    const ownerCard = ownerCards[ownerCards.length - 1] ?? null
    const contentRoot = ownerCard?.querySelector<HTMLElement>('[data-component="MessageContent"]') ?? null
    const islandHost = contentRoot?.querySelector<HTMLElement>('[data-lumiverse-html-island]') ?? null
    const islandShadow = islandHost?.shadowRoot ?? null
    if (islandShadow) observeShadow(islandShadow)

    const rawText = collectText(contentRoot)
    const text = rawText.replace(/\s+/g, ' ').trim()
    const image = (islandShadow?.querySelector(`img[src="${IMAGE_SRC}"]`)
      ?? contentRoot?.querySelector(`img[src="${IMAGE_SRC}"]`)
      ?? null) as Element | null
    if (image) trackImage(image)

    const resolvedRegexNode = contentRoot?.querySelector('b[data-resolved]')
      ?? islandShadow?.querySelector('b[data-resolved]')
      ?? null

    const frame: Frame = {
      seq: frames.length,
      label,
      phase,
      source,
      storeIsStreaming: !!state.isStreaming,
      storeStreamBuffer: String(state.streamingContent ?? ''),
      cardIds,
      streamingCardIds,
      ownerCardNode: identity(ownerCard),
      contentRootNode: identity(contentRoot),
      text,
      hasRawMacro: text.includes(RAW_MACRO),
      hasResolvedMacro: text.includes(RESOLVED_MACRO),
      hasRawRegex: text.includes(RAW_REGEX_MARKER),
      hasResolvedRegex: !!resolvedRegexNode,
      islandHostNode: identity(islandHost),
      islandShadowNode: identity(islandShadow),
      islandShadowText: (islandShadow?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      imageNode: identity(image),
      imageEvents: image ? (imageEventCounts.get(image) ?? 0) : 0,
    }

    const signature = JSON.stringify([
      frame.phase, frame.storeIsStreaming, frame.cardIds, frame.streamingCardIds,
      frame.ownerCardNode, frame.contentRootNode, frame.text, frame.hasResolvedRegex,
      frame.islandHostNode, frame.islandShadowNode, frame.islandShadowText,
      frame.imageNode, frame.imageEvents,
    ])
    if (source === 'mutation' && signature === lastSignature) return
    lastSignature = signature
    frames.push(frame)
  }

  const settle = async (ms: number) => {
    await act(async () => { await sleep(ms) })
  }
  /**
   * Labels describe the WINDOW a frame was committed in. `enter` is called
   * before the transition that opens the window, so mutation-sourced frames
   * carry the window they actually happened in; `mark` additionally records an
   * explicit boundary frame.
   */
  const enter = (next: string) => { label = next }
  const mark = (next: string) => { label = next; capture('step') }

  // ── store reset ──────────────────────────────────────────────────────
  const userMessage = makeMessage({
    id: USER_MESSAGE_ID,
    index_in_chat: 0,
    is_user: true,
    name: 'User',
    content: 'Tell me.',
    swipes: ['Tell me.'],
  })

  const swipeZeroContent = `Swipe one with Mood: ${RAW_MACRO}. [[b:one]]`
  const initialMessages = config.identity === 'swipe'
    ? [userMessage, makeMessage({
        id: ownerId,
        index_in_chat: 1,
        name: 'Assistant',
        content: swipeZeroContent,
        swipes: [swipeZeroContent],
        swipe_id: 0,
      })]
    : [userMessage]

  await act(async () => {
    useStore.setState({
      activeChatId: CHAT_ID,
      activeCharacterId: null,
      activeChatMetadata: null,
      activeChatAvatarId: null,
      messages: initialMessages,
      totalChatLength: initialMessages.length,
      isStreaming: false,
      streamingContent: '',
      streamingReasoning: '',
      activeGenerationId: null,
      regeneratingMessageId: null,
      streamingSwipeId: null,
      streamingGenerationType: null,
      regexScripts: config.withDisplayScripts ? [DISPLAY_SCRIPT] : [],
      messagesPerPage: 50,
      chatDisplayMode: displayMode,
      messageSelectMode: false,
      componentOverrides: {},
    })
  })

  function CardList() {
    const messages = useStore((s: any) => s.messages)
    return createElement(
      'div',
      { 'data-test-list': '1' },
      messages.map((message: any, index: number) =>
        createElement(Card, {
          // Verbatim MessageList row key formula.
          key: ['message', message.id, displayMode].join(':'),
          message,
          chatId: CHAT_ID,
          depth: messages.length - 1 - index,
        }),
      ),
    )
  }

  await act(async () => { root.render(createElement(CardList, null)) })
  await settle(360)

  observer.observe(host, { childList: true, subtree: true, characterData: true, attributes: true })
  recording = true
  mark('idle')

  const genId = `gen-5-2-${config.id}`

  // ── streaming target setup ───────────────────────────────────────────
  phase = 'staged'
  if (config.identity === 'swipe') {
    await act(async () => { useStore.getState().beginStreaming(ownerId, 'swipe') })
    await settle(320)
    mark('beginStreaming(swipe)')
    await act(async () => {
      const state = useStore.getState()
      state.updateMessage(ownerId, {
        swipes: [swipeZeroContent, ''],
        swipe_dates: [initialMessages[1]!.swipe_dates[0], initialMessages[1]!.swipe_dates[0]],
        swipe_id: 1,
        content: '',
      })
      state.setStreamingSwipeId(1)
      state.startStreaming(genId, ownerId, 'swipe')
    })
    await settle(320)
    mark('swipe staged (swipe 1 empty)')
  } else {
    await act(async () => {
      const state = useStore.getState()
      state.addMessage(makeMessage({ id: ownerId, index_in_chat: 1, name: 'Assistant' }))
      state.beginStreaming(ownerId, 'normal')
      state.startStreaming(genId)
    })
    await settle(320)
    mark('streaming target ready')
  }

  // ── token stream ─────────────────────────────────────────────────────
  phase = 'streaming'
  const streamed = (step: number) => (config.savedContentTrimmed ? `${chunk(step)}\n` : chunk(step))

  for (let step = 0; step <= LAST_STEP; step += 1) {
    const next = streamed(step)
    enter(`chunk ${step} token -> flush commit window`)
    await act(async () => {
      const state = useStore.getState()
      const already = state.getStreamBuffers().content
      if (next.startsWith(already)) state.appendStreamToken(next.slice(already.length))
      else state.reconcileStreamContent(next, 0)
    })
    // 32ms scheduleStreamFlush + React commit, no async resolve window.
    await settle(45)
    mark(`chunk ${step} flush commit [SYNC FRAME]`)
    enter(`chunk ${step} async resolve window`)
    await settle(320)
    mark(`chunk ${step} settled`)

    if (config.replaceMessageObjectAfterChunk === step) {
      enter('message-object replacement (same id) commit window')
      await act(async () => {
        const state = useStore.getState()
        // New object identity, identical message id (MESSAGE_EDITED / peer
        // reconcile shape). setMessages is the real store action.
        state.setMessages(
          state.messages.map((message: any) => ({ ...message, extra: { ...(message.extra ?? {}) } })),
          state.totalChatLength,
        )
      })
      await settle(45)
      mark('message-object replacement (same id) [SYNC FRAME]')
      enter('message-object replacement async window')
      await settle(320)
      mark('message-object replacement settled')
    }
  }

  // ── final reconciliation (verbatim useWebSocket success ordering) ─────
  phase = 'final'
  const authoritativeContent = chunk(LAST_STEP)
  const authoritative = config.identity === 'swipe'
    ? makeMessage({
        id: ownerId,
        index_in_chat: 1,
        name: 'Assistant',
        content: authoritativeContent,
        swipes: [swipeZeroContent, authoritativeContent],
        swipe_dates: [initialMessages[1]!.swipe_dates[0], initialMessages[1]!.swipe_dates[0]],
        swipe_id: 1,
      })
    : makeMessage({
        id: ownerId,
        index_in_chat: 1,
        name: 'Assistant',
        content: authoritativeContent,
        swipes: [authoritativeContent],
      })

  const page = { data: [userMessage, authoritative], total: 2, offset: 0 }

  enter(config.deferredFetchMs > 0
    ? 'deferred fetchLatestMessages -> reconcile+endStreaming window'
    : 'reconcile+endStreaming commit window')
  await act(async () => {
    if (config.deferredFetchMs > 0) {
      // Deferred fetchLatestMessages: the awaited network round trip lets React
      // commit and paint while the stream buffer is still owned.
      await new Promise((resolve) => domWindow.setTimeout(resolve, config.deferredFetchMs))
    }
    useStore.getState().reconcileMessagesTail(page)
    useStore.getState().endStreaming()
  })
  mark('reconcile+endStreaming [SYNC FRAME]')
  enter('post-finalization microtask/raf window (+20ms)')
  await settle(20)
  mark('+20ms after reconcile')
  enter('post-finalization coalescing window (+80ms)')
  await settle(60)
  mark('+80ms after reconcile')
  enter('post-finalization settle window')
  await settle(config.finalSettleMs)
  mark('settled final')

  const finalState = useStore.getState()
  const tail = finalState.messages[finalState.messages.length - 1]

  recording = false
  observer.disconnect()
  await act(async () => { root.unmount() })
  host.remove()

  return {
    config,
    frames,
    authoritativeContent,
    ownerId,
    storeTailContent: String(tail?.content ?? ''),
    storeTailSwipeId: Number(tail?.swipe_id ?? -1),
    storeMessageIds: finalState.messages.map((m: any) => String(m.id)),
  }
}

// ── Invariant helpers ─────────────────────────────────────────────────────
function streamFrames(result: ScenarioResult): Frame[] {
  return result.frames.filter((frame) => frame.phase === 'streaming' || frame.phase === 'final')
}

function violation(invariant: string, frame: Frame, detail: string): Violation {
  return { invariant, frame: frame.seq, label: frame.label, phase: frame.phase, detail }
}

/**
 * How many leading streamed segments are visible IN THEIR FINAL RESOLVED FORM.
 * Lagging behind the newest token is legitimate (the value may not be resolved
 * yet); going BACKWARDS is a rewind / older-resolved-value swap / raw flash.
 */
function resolvedProgress(frame: Frame, withDisplayScripts: boolean): number {
  const segments = [
    frame.text.includes(PROSE_ANCHOR),
    frame.text.includes(`Mood: ${RESOLVED_MACRO}.`),
    withDisplayScripts ? frame.hasResolvedRegex : frame.text.includes('[[b:important]]'),
    frame.islandShadowText.includes(ISLAND_TAIL),
  ]
  let count = 0
  for (const present of segments) {
    if (!present) break
    count += 1
  }
  return count
}

/**
 * Group A — the currently streaming portion must stay continuously correct.
 * These are the invariants the 5.1 trace proved broken at the
 * `useDisplayPreprocessedState` terminal fallback.
 */
function checkContentContinuity(result: ScenarioResult): Violation[] {
  const violations: Violation[] = []
  const list = streamFrames(result)

  let sawText = false
  let firstNonEmptySeq: number | null = null
  let sawAnchor = false
  let sawResolvedMacro = false
  let sawResolvedRegex = false
  let maxProgress = 0

  for (const frame of list) {
    // A5 — the resolved render may lag the newest token, never move backwards.
    const progress = resolvedProgress(frame, result.config.withDisplayScripts)
    if (progress < maxProgress) {
      violations.push(violation('A5 resolved-progress-never-rewinds', frame,
        `visible resolved segments fell from ${maxProgress} to ${progress}; visible text: ${JSON.stringify(frame.text.slice(0, 140))}`))
    } else {
      maxProgress = progress
    }

    // A1 — the visible streamed portion never blanks once it exists.
    if (frame.text.length > 0) {
      sawText = true
      firstNonEmptySeq ??= frame.seq
    } else if (sawText) {
      violations.push(violation('A1 streamed-text-never-blanks', frame,
        'visible streamed text became empty after it had been rendered'))
    }

    // A2 — already-visible plain prose never disappears or rewinds.
    if (frame.text.includes(PROSE_ANCHOR)) sawAnchor = true
    else if (sawAnchor) {
      violations.push(violation('A2 plain-prose-never-disappears', frame,
        `prose anchor "${PROSE_ANCHOR}" vanished; visible text: ${JSON.stringify(frame.text.slice(0, 120))}`))
    }

    // A3 — unprocessed macro source is never painted. `useDisplayRegex` documents
    // raw text as acceptable only "on a first render with no cache"; once this
    // message has committed any non-empty render, the previously resolved value
    // is what must stay on screen until the newer value resolves.
    const afterFirstRender = firstNonEmptySeq !== null && frame.seq > firstNonEmptySeq
    if (afterFirstRender && frame.hasRawMacro) {
      violations.push(violation('A3 unprocessed-macro-source-never-painted', frame,
        `raw ${RAW_MACRO} committed after the message had already rendered; visible text: ${JSON.stringify(frame.text.slice(0, 140))}`))
    }

    // A4 — unprocessed display-regex source is never painted.
    if (result.config.withDisplayScripts && afterFirstRender && frame.hasRawRegex) {
      violations.push(violation('A4 unprocessed-regex-source-never-painted', frame,
        `raw ${RAW_REGEX_MARKER} committed after the message had already rendered; visible text: ${JSON.stringify(frame.text.slice(0, 140))}`))
    }

    // A6 — an already resolved value never disappears or swaps back.
    if (frame.hasResolvedMacro) sawResolvedMacro = true
    else if (sawResolvedMacro) {
      violations.push(violation('A6 resolved-output-never-disappears', frame,
        `resolved macro "${RESOLVED_MACRO}" disappeared; visible text: ${JSON.stringify(frame.text.slice(0, 140))}`))
    }
    if (result.config.withDisplayScripts) {
      if (frame.hasResolvedRegex) sawResolvedRegex = true
      else if (sawResolvedRegex) {
        violations.push(violation('A6 resolved-output-never-disappears', frame,
          'resolved <b data-resolved> node disappeared after it had been rendered'))
      }
    }
  }

  return violations
}

/**
 * Group B — DOM identity continuity of the streamed subtree.
 * Same-source images, the island host, and its shadow root must stay mounted.
 */
function checkIdentityContinuity(result: ScenarioResult): Violation[] {
  const violations: Violation[] = []
  const list = streamFrames(result)

  let firstImage: number | null = null
  let firstIslandHost: number | null = null
  let firstShadow: number | null = null
  let firstContentRoot: number | null = null
  let firstOwnerCard: number | null = null
  let sawIslandText = false
  let imageEvents = 0

  for (const frame of list) {
    if (frame.ownerCardNode !== null) {
      if (firstOwnerCard === null) firstOwnerCard = frame.ownerCardNode
      else if (frame.ownerCardNode !== firstOwnerCard) {
        violations.push(violation('B4 owner-card-node-stays-mounted', frame,
          `card DOM node for ${result.ownerId} was replaced (#${firstOwnerCard} -> #${frame.ownerCardNode})`))
        firstOwnerCard = frame.ownerCardNode
      }
    }

    if (frame.contentRootNode !== null) {
      if (firstContentRoot === null) firstContentRoot = frame.contentRootNode
      else if (frame.contentRootNode !== firstContentRoot) {
        violations.push(violation('B3 message-content-root-stays-mounted', frame,
          `MessageContent root remounted (#${firstContentRoot} -> #${frame.contentRootNode})`))
        firstContentRoot = frame.contentRootNode
      }
    }

    if (frame.imageNode !== null) {
      if (firstImage === null) {
        firstImage = frame.imageNode
        imageEvents = frame.imageEvents
      } else if (frame.imageNode !== firstImage) {
        violations.push(violation('B1 same-source-image-stays-mounted', frame,
          `img[src=${IMAGE_SRC}] element identity changed (#${firstImage} -> #${frame.imageNode})`))
        firstImage = frame.imageNode
      } else if (frame.imageEvents > imageEvents) {
        violations.push(violation('B1 same-source-image-stays-mounted', frame,
          `preserved image replayed ${frame.imageEvents - imageEvents} load/error event(s)`))
        imageEvents = frame.imageEvents
      }
    } else if (firstImage !== null) {
      violations.push(violation('B1 same-source-image-stays-mounted', frame,
        `img[src=${IMAGE_SRC}] disappeared from the rendered card`))
    }

    if (frame.islandHostNode !== null) {
      if (firstIslandHost === null) firstIslandHost = frame.islandHostNode
      else if (frame.islandHostNode !== firstIslandHost) {
        violations.push(violation('B2 html-island-does-not-remount', frame,
          `island host element replaced (#${firstIslandHost} -> #${frame.islandHostNode})`))
        firstIslandHost = frame.islandHostNode
      }
      if (frame.islandShadowNode !== null) {
        if (firstShadow === null) firstShadow = frame.islandShadowNode
        else if (frame.islandShadowNode !== firstShadow) {
          violations.push(violation('B2 html-island-does-not-remount', frame,
            `island shadow root replaced (#${firstShadow} -> #${frame.islandShadowNode})`))
          firstShadow = frame.islandShadowNode
        }
      }
      if (frame.islandShadowText.includes(ISLAND_TAIL)) sawIslandText = true
      else if (sawIslandText) {
        violations.push(violation('B2 html-island-does-not-remount', frame,
          `island shadow content lost "${ISLAND_TAIL}"; shadow text: ${JSON.stringify(frame.islandShadowText.slice(0, 100))}`))
      }
    } else if (firstIslandHost !== null) {
      violations.push(violation('B2 html-island-does-not-remount', frame,
        'island host disappeared from the rendered card'))
    }
  }

  return violations
}

/**
 * Group C — stream ownership, absence of duplicates, and final authority.
 */
function checkOwnershipAndFinality(result: ScenarioResult): Violation[] {
  const violations: Violation[] = []
  const list = streamFrames(result)

  for (const frame of list) {
    const seen = new Set<string>()
    for (const id of frame.cardIds) {
      if (seen.has(id)) {
        violations.push(violation('C1 no-duplicate-card-for-a-message', frame,
          `message id ${id} rendered by ${frame.cardIds.filter((v) => v === id).length} cards`))
        break
      }
      seen.add(id)
    }

    if (frame.storeIsStreaming) {
      if (frame.streamingCardIds.length !== 1) {
        violations.push(violation('C2 exactly-one-stream-owner-card', frame,
          `${frame.streamingCardIds.length} cards report data-part="streaming" (${JSON.stringify(frame.streamingCardIds)})`))
      } else if (frame.streamingCardIds[0] !== result.ownerId) {
        violations.push(violation('C2 exactly-one-stream-owner-card', frame,
          `stream owner card is ${frame.streamingCardIds[0]}, expected ${result.ownerId}`))
      }
    }
  }

  const final = list[list.length - 1]
  if (!final) {
    violations.push({
      invariant: 'C3 final-render-equals-authoritative-content',
      frame: -1,
      label: 'settled final',
      phase: 'final',
      detail: 'no committed frame was recorded',
    })
    return violations
  }

  const requiredFragments = [PROSE_ANCHOR, `Mood: ${RESOLVED_MACRO}.`, 'important', ISLAND_TAIL]
  for (const fragment of requiredFragments) {
    if (!final.text.includes(fragment)) {
      violations.push(violation('C3 final-render-equals-authoritative-content', final,
        `final rendered content is missing ${JSON.stringify(fragment)}; visible text: ${JSON.stringify(final.text.slice(0, 200))}`))
    }
  }
  if (final.hasRawMacro) {
    violations.push(violation('C3 final-render-equals-authoritative-content', final,
      `final rendered content still shows raw ${RAW_MACRO}`))
  }
  // With zero display-regex scripts the `[[b:…]]` marker is not a script target,
  // so its literal text is the correct authoritative rendering.
  if (result.config.withDisplayScripts) {
    if (final.hasRawRegex) {
      violations.push(violation('C3 final-render-equals-authoritative-content', final,
        `final rendered content still shows raw ${RAW_REGEX_MARKER}`))
    }
    if (!final.hasResolvedRegex) {
      violations.push(violation('C3 final-render-equals-authoritative-content', final,
        'final rendered content has no resolved <b data-resolved> node'))
    }
  }
  if (result.config.identity === 'swipe' && final.text.includes('Swipe one')) {
    violations.push(violation('C3 final-render-equals-authoritative-content', final,
      'final rendered content shows the previous swipe instead of the streamed swipe'))
  }
  if (result.storeTailContent !== result.authoritativeContent) {
    violations.push(violation('C3 final-render-equals-authoritative-content', final,
      `store tail content is not the authoritative row (${JSON.stringify(result.storeTailContent.slice(0, 80))})`))
  }
  if (new Set(result.storeMessageIds).size !== result.storeMessageIds.length) {
    violations.push(violation('C1 no-duplicate-card-for-a-message', final,
      `store holds duplicate message ids: ${JSON.stringify(result.storeMessageIds)}`))
  }

  return violations
}

// ── Reporting ─────────────────────────────────────────────────────────────
function report(result: ScenarioResult, group: string, violations: Violation[]) {
  const header = `\n### ${result.config.id} [${group}] ${result.config.title}`
  if (violations.length === 0) {
    console.log(`${header}\n  no violations across ${streamFrames(result).length} committed frames`)
    if (!dumpedTimelines.has(result.config.id)) {
      dumpedTimelines.add(result.config.id)
      dumpFrames(result, new Set())
    }
    return
  }
  console.log(`${header}\n  ${violations.length} violation(s) across ${streamFrames(result).length} committed frames`)
  const byInvariant = new Map<string, Violation[]>()
  for (const entry of violations) {
    const bucket = byInvariant.get(entry.invariant) ?? []
    bucket.push(entry)
    byInvariant.set(entry.invariant, bucket)
  }
  for (const [invariant, entries] of byInvariant) {
    console.log(`  - ${invariant}: ${entries.length} frame(s)`)
    for (const entry of entries.slice(0, 6)) {
      console.log(`      frame#${entry.frame} [${entry.phase}] "${entry.label}" :: ${entry.detail}`)
    }
    if (entries.length > 6) console.log(`      … ${entries.length - 6} more`)
  }
  if (!dumpedTimelines.has(result.config.id)) {
    dumpedTimelines.add(result.config.id)
    dumpFrames(result, new Set(violations.map((entry) => entry.frame)))
  }
}

const dumpedTimelines = new Set<string>()

function pad(value: unknown, width: number): string {
  const text = value === undefined || value === null ? '' : String(value)
  const clipped = text.length > width ? `${text.slice(0, width - 1)}…` : text
  return clipped.padEnd(width)
}

/** Committed-frame timeline. `!` marks a frame that violated an invariant. */
function dumpFrames(result: ScenarioResult, offending: Set<number>) {
  const columns: Array<[string, number]> = [
    ['#', 4], ['!', 1], ['phase', 9], ['src', 8], ['window', 44], ['streaming', 9],
    ['macro', 8], ['regex', 8], ['island', 6], ['img', 4], ['visible text', 62],
  ]
  console.log(`  committed-frame timeline (${result.frames.length} frames):`)
  console.log(`    ${columns.map(([name, width]) => pad(name, width)).join(' | ')}`)
  for (const frame of result.frames) {
    const macro = frame.hasRawMacro ? 'RAW' : frame.hasResolvedMacro ? 'resolved' : '-'
    const regex = frame.hasRawRegex ? 'RAW' : frame.hasResolvedRegex ? 'resolved' : '-'
    const row = [
      frame.seq,
      offending.has(frame.seq) ? '!' : ' ',
      frame.phase,
      frame.source,
      frame.label,
      frame.storeIsStreaming ? 'yes' : 'no',
      macro,
      regex,
      frame.islandShadowNode === null ? '-' : `sh#${frame.islandShadowNode}`,
      frame.imageNode === null ? '-' : `#${frame.imageNode}`,
      frame.text,
    ]
    console.log(`    ${row.map((value, index) => pad(value, columns[index]![1])).join(' | ')}`)
  }
}

function assertNoViolations(result: ScenarioResult, group: string, violations: Violation[]) {
  report(result, group, violations)
  expect(violations.map((entry) => `${entry.invariant} @frame#${entry.frame} "${entry.label}" :: ${entry.detail}`))
    .toEqual([])
}

// ── Tests ─────────────────────────────────────────────────────────────────
const TEST_TIMEOUT = 240_000

for (const config of SCENARIOS) {
  test(`${config.id} content continuity — ${config.title}`, async () => {
    const result = await runScenario(config)
    assertNoViolations(result, 'A content continuity', checkContentContinuity(result))
  }, TEST_TIMEOUT)

  test(`${config.id} DOM identity continuity — ${config.title}`, async () => {
    const result = await runScenario(config)
    assertNoViolations(result, 'B identity continuity', checkIdentityContinuity(result))
  }, TEST_TIMEOUT)

  test(`${config.id} ownership and final authority — ${config.title}`, async () => {
    const result = await runScenario(config)
    assertNoViolations(result, 'C ownership + finality', checkOwnershipAndFinality(result))
  }, TEST_TIMEOUT)
}
