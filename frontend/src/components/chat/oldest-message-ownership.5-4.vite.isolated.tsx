/// <reference types="bun-types" />

/**
 * RUNTIME REGRESSION TESTS — spec task 5.4
 * "Resolve the oldest-message render-gate/ownership defect from rendered evidence".
 *
 * Everything under test is REAL and RENDERED:
 *
 *   - real `frontend/src/components/chat/ChatView.tsx` (native dock group,
 *     `quickToolbarOwnsOldestMessage` gate, `isShowNativeScrollToTop`,
 *     `totalChatLength`),
 *   - real `frontend/src/components/quick-toolbar/QuickToolbar.tsx` mounted the
 *     two ways production mounts it: docked as a ChatView child, and floating
 *     through the real `quick_toolbar.workspace` host surface,
 *   - real `useQuickToolbarActions` visible-id normalization,
 *   - real `chatDockerActionCatalog` owner registration (so a rendered owner can
 *     be proven to actually navigate),
 *   - real store, real i18n, real component-override registry.
 *
 * The only stubs are transport seams: `fetch` (routed to fixture payloads) and
 * the `react-router` surface (navigation RECORDED, not swallowed).
 *
 * The pre-fix defect these assertions expose: ownership is decided from the RAW
 * persisted `quickToolbarSettings` (`quickToolbarOwnsOldestMessage`) while the
 * QuickToolbar action is only actually rendered when the toolbar is mounted AND
 * its normalized/measured action list really contains `chat.scroll-to-top`. When
 * those disagree, an eligible chat renders ZERO working owners.
 *
 * NOTE: assertions read rendered DOM only. No source-string checks.
 */

import { afterAll, beforeEach, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { createServer, type Plugin } from 'vite'

const CHAT_ID = 'chat-1'
const OLDEST_ACTION = 'chat.scroll-to-top'

// ── JSDOM environment (must exist before any Vite module is loaded) ───────
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lumiverse.test/chat/chat-1',
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
  location: domWindow.location,
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
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLSelectElement: domWindow.HTMLSelectElement,
  HTMLAudioElement: domWindow.HTMLAudioElement,
  HTMLVideoElement: domWindow.HTMLVideoElement,
  Audio: domWindow.Audio,
  ShadowRoot: domWindow.ShadowRoot,
  DocumentFragment: domWindow.DocumentFragment,
  Event: domWindow.Event,
  EventTarget: domWindow.EventTarget,
  CustomEvent: domWindow.CustomEvent,
  MouseEvent: domWindow.MouseEvent,
  PointerEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  TouchEvent: domWindow.TouchEvent,
  MutationObserver: domWindow.MutationObserver,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: TestIntersectionObserver,
  DOMParser: domWindow.DOMParser,
  Range: domWindow.Range,
  WebSocket: class {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 0
    close() {}
    send() {}
    addEventListener() {}
    removeEventListener() {}
  },
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

// ── Transport seam ────────────────────────────────────────────────────────
interface CapturedRequest {
  method: string
  url: string
}

const captured: CapturedRequest[] = []

/** Total/window are matrix inputs: the real store learns them via `setMessages`. */
let messagePage: { data: unknown[]; total: number } = { data: [], total: 0 }

function makeMessage(index: number, isUser: boolean) {
  return {
    id: `m-${index}`,
    chat_id: CHAT_ID,
    index_in_chat: index,
    is_user: isUser ? 1 : 0,
    name: isUser ? 'User' : 'Assistant',
    content: `message ${index}`,
    send_date: index + 1,
    swipe_id: 0,
    swipes: [`message ${index}`],
    swipe_dates: [index + 1],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: index + 1,
    revision: 1,
  }
}

/**
 * `total` is the authoritative chat length; `windowSize` is the loaded tail
 * page, so the paginated-window dimension is a real store state, not a fake.
 */
function setMessageWindow(total: number, windowSize = Math.min(total, 3)): void {
  const start = Math.max(0, total - windowSize)
  messagePage = {
    data: Array.from({ length: windowSize }, (_, offset) => makeMessage(start + offset, (start + offset) % 2 === 1)),
    total,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

globalThis.fetch = (async (input: any, init?: any) => {
  const rawUrl = typeof input === 'string' ? input : String(input?.url ?? input)
  const method = String(init?.method ?? 'GET').toUpperCase()
  const parsed = rawUrl.startsWith('http') ? new URL(rawUrl) : null
  const path = parsed ? parsed.pathname + parsed.search : rawUrl
  captured.push({ method, url: path })

  if (method === 'GET' && /\/chats\/[^/]+\/messages/.test(path)) {
    const search = parsed?.searchParams
    if (search?.get('limit') === '1' && search?.get('offset') === '0') {
      // The oldest-message navigation probe: page 0, one row.
      const oldest = messagePage.total > 0 ? makeMessage(0, false) : null
      return json({ data: oldest ? [oldest] : [], total: messagePage.total })
    }
    return json(messagePage)
  }
  if (method === 'GET' && /\/chats\/[^/]+$/.test(path)) {
    return json({
      id: CHAT_ID,
      name: 'Chat',
      character_id: null,
      character_display_owner: null,
      metadata: {},
      created_at: 1,
      updated_at: 1,
    })
  }
  if (path.includes('/memory-cortex')) return json({ status: 'idle', phase: 'complete', pendingJobs: 0 })
  if (path.includes('/loadouts')) return json({ loadout: null })
  if (path.includes('/settings')) return json({})
  return json({}, 200)
}) as typeof fetch

// ── Vite runtime holding the REAL frontend module graph ───────────────────
interface Runtime {
  server: Awaited<ReturnType<typeof createServer>>
  useStore: any
  ChatView: any
  HostSurfaceRenderer: any
  overrides: any
  defaults: any
  toolbarActions: any
  React: typeof import('react')
  createRoot: typeof import('react-dom/client')['createRoot']
  routerStub: { navigateCalls: unknown[][]; resetNavigateCalls: () => void }
}

/**
 * The chat body is NOT the behaviour under test. Every module that owns the
 * oldest-message decision stays real (`ChatView`, `QuickToolbar`,
 * `useQuickToolbarActions`, `chatDockerActionCatalog`, `chatNativeDockOwnership`,
 * `quickToolbarDock`, the store, the API layer, i18n, the host-surface
 * contracts). Only the unrelated chat-body siblings are replaced by inert
 * markers, so message virtualization/composer layout cannot dominate the run.
 */
const VIRTUAL_PREFIX = '\0oldest-message-ownership-5-4:'
const childStub = (testId: string) => `
  import { createElement } from 'react'
  function Stub() { return createElement('div', { 'data-testid': '${testId}' }) }
  export default Stub
  export const ChatFindBar = Stub
`
const stubbedModules: Record<string, string> = {
  './MessageList': childStub('message-list'),
  './MessageSelectBar': childStub('message-select-bar'),
  './InputArea': childStub('input-area'),
  './ChatFindBar': childStub('chat-find-bar'),
  './ScrollToBottom': childStub('scroll-to-bottom'),
  './MessageNavigator': childStub('message-navigator'),
  './CouncilPill': childStub('council-pill'),
  './PortraitPanel': childStub('portrait-panel'),
  './expressions/ExpressionDisplay': childStub('expression-display'),
  './FloatingAvatarViewer': childStub('floating-avatar-viewer'),
  '@/components/shared/WallpaperLayer': childStub('wallpaper-layer'),
}

const chatBodyStubs: Plugin = {
  name: 'oldest-message-ownership-5-4-stubs',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !importer.includes('ChatView.tsx')) {
      if (source !== '@/components/shared/WallpaperLayer') return null
    }
    return source in stubbedModules ? `${VIRTUAL_PREFIX}${source}` : null
  },
  load(id) {
    return id.startsWith(VIRTUAL_PREFIX) ? stubbedModules[id.slice(VIRTUAL_PREFIX.length)] : null
  },
}

async function createRuntime(): Promise<Runtime> {
  const server = await createServer({
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    plugins: [chatBodyStubs],
    resolve: {
      alias: [{
        find: /^react-router$/,
        replacement: fileURLToPath(new URL('./oldest-message-ownership.5-4.router-stub.ts', import.meta.url)),
      }],
    },
  })

  const i18nModule = await server.ssrLoadModule('/src/i18n/index.ts') as { initI18n: () => Promise<unknown> }
  await i18nModule.initI18n()

  const storeModule = await server.ssrLoadModule('/src/store/index.ts') as { useStore: any }
  const chatViewModule = await server.ssrLoadModule('/src/components/chat/ChatView.tsx') as { default: any }
  const hostContracts = await server.ssrLoadModule('/src/lib/spindle/productivity-host-contracts.tsx')
  const overrides = await server.ssrLoadModule('/src/lib/spindle/component-override-registry.tsx')
  const defaults = await server.ssrLoadModule('/src/lib/uiProductivityDefaults.ts')
  const toolbarActions = await server.ssrLoadModule('/src/components/quick-toolbar/useQuickToolbarActions.ts')
  const routerStub = await server.ssrLoadModule('/src/components/chat/oldest-message-ownership.5-4.router-stub.ts') as {
    navigateCalls: unknown[][]
    resetNavigateCalls: () => void
  }

  const React = await import('react')
  const { createRoot } = await import('react-dom/client')

  return {
    server,
    useStore: storeModule.useStore,
    ChatView: chatViewModule.default,
    HostSurfaceRenderer: (hostContracts as any).ProductivityHostSurfaceRenderer,
    overrides,
    defaults,
    toolbarActions,
    React,
    createRoot,
    routerStub,
  }
}

const runtime = await createRuntime()

afterAll(async () => {
  await runtime.server.close()
})

// ── Matrix inputs ─────────────────────────────────────────────────────────
type HostMode = 'docked' | 'floating-host' | 'floating-absent'
type VisibleIdsMode = 'raw-includes-oldest' | 'shipped-default-normalized' | 'empty-normalized'

interface Cell {
  suiteEnabled: boolean
  toolbarEnabled: boolean
  host: HostMode
  visibleIds: VisibleIdsMode
  showNativeScrollToTop: boolean
  totalChatLength: number
  /** Rendered occupancy of the QuickToolbar host component. */
  override: 'none' | 'replace-without-oldest' | 'replace-with-oldest'
  overlayOpen?: boolean
  nativeDockActionSide?: 'left' | 'right'
}

const SUITE_EXTENSIONS = [{
  id: 'lumiverse_suite',
  identifier: 'lumiverse_suite',
  enabled: true,
  has_frontend: true,
}]

function visibleTabIdsFor(mode: VisibleIdsMode, defaults: any): string[] {
  if (mode === 'raw-includes-oldest') return ['profile', OLDEST_ACTION, 'settings']
  if (mode === 'empty-normalized') return []
  return [...defaults.DEFAULT_QUICK_TOOLBAR_SETTINGS.visibleTabIds]
}

function describeCell(cell: Cell): string {
  return [
    `suite=${cell.suiteEnabled}`,
    `toolbarEnabled=${cell.toolbarEnabled}`,
    `host=${cell.host}`,
    `visibleIds=${cell.visibleIds}`,
    `showNativeOldest=${cell.showNativeScrollToTop}`,
    `total=${cell.totalChatLength}`,
    `override=${cell.override}`,
    `overlay=${cell.overlayOpen === true}`,
  ].join(' ')
}

interface Evidence {
  nativeGroups: number
  nativeOldest: number
  quickToolbarOldest: number
  dockRequest: string | null
  nativeActionSide: string | null
  quickToolbarMounted: boolean
  fillTopDock: string | null
}

function readEvidence(): Evidence {
  const doc = domWindow.document
  const dock = doc.querySelector('[data-spindle-mount="chat_top_dock"]')
  const nativeGroups = doc.querySelectorAll('div[class*="nativeDockActions"]')
  const nativeGroup = nativeGroups[0] ?? null
  const allOldest = Array.from(doc.querySelectorAll(`[data-toolbar-action="${OLDEST_ACTION}"]`))
  const nativeOldest = allOldest.filter((node) => nativeGroup?.contains(node))
  const quickToolbar = doc.querySelector('[data-component="QuickToolbar"]')
  return {
    nativeGroups: nativeGroups.length,
    nativeOldest: nativeOldest.length,
    quickToolbarOldest: allOldest.length - nativeOldest.length,
    dockRequest: dock?.getAttribute('data-dock-request') ?? null,
    nativeActionSide: dock?.getAttribute('data-native-action-side') ?? null,
    quickToolbarMounted: Boolean(quickToolbar) || Boolean(doc.querySelector('[data-testid="override-toolbar"]')),
    fillTopDock: quickToolbar?.getAttribute('data-fill-top-dock') ?? null,
  }
}

function soleOldestOwner(): HTMLElement | null {
  const nodes = Array.from(
    domWindow.document.querySelectorAll<HTMLElement>(`[data-toolbar-action="${OLDEST_ACTION}"]`),
  )
  return nodes.length === 1 ? nodes[0] : null
}

let activeRoot: { unmount: () => void } | null = null
let overrideHandle: { destroy: () => void } | null = null

async function unmountCell(): Promise<void> {
  const { React } = runtime
  if (activeRoot) {
    const root = activeRoot
    activeRoot = null
    await React.act(async () => { root.unmount() })
  }
  overrideHandle?.destroy()
  overrideHandle = null
  domWindow.document.body.replaceChildren()
}

async function renderCell(cell: Cell): Promise<Evidence> {
  const { React, createRoot, useStore, defaults } = runtime
  await unmountCell()

  setMessageWindow(cell.totalChatLength)

  if (cell.override !== 'none') {
    overrideHandle = runtime.overrides.registerComponentOverride({
      host: 'QuickToolbar',
      owner: 'test-extension',
      generation: 1,
      mode: 'replace',
      component: () => React.createElement(
        'div',
        { 'data-testid': 'override-toolbar' },
        cell.override === 'replace-with-oldest'
          ? React.createElement(
            'button',
            { type: 'button', 'data-toolbar-action': OLDEST_ACTION },
            'override oldest',
          )
          : React.createElement('button', { type: 'button', 'data-toolbar-action': 'chat.new' }, 'override other'),
      ),
    })
  }

  const quickToolbarSettings = {
    ...defaults.DEFAULT_QUICK_TOOLBAR_SETTINGS,
    enabled: cell.toolbarEnabled,
    quickToolbarPlacement: cell.host === 'docked' ? 'chat_top_dock' : 'floating',
    visibleTabIds: visibleTabIdsFor(cell.visibleIds, defaults),
    iconOrder: visibleTabIdsFor(cell.visibleIds, defaults),
    showNativeScrollToTop: cell.showNativeScrollToTop,
    nativeDockActionSide: cell.nativeDockActionSide ?? 'right',
    hideWhenOverlaid: cell.overlayOpen === true,
  }

  await React.act(async () => {
    useStore.setState({
      user: { id: 'user-1' },
      extensions: cell.suiteEnabled ? SUITE_EXTENSIONS : [],
      activeChatId: CHAT_ID,
      activeCharacterId: null,
      characters: [],
      messages: [],
      totalChatLength: 0,
      isStreaming: false,
      messageSelectMode: false,
      messageEditDraft: null,
      editingMessageId: null,
      activeModal: cell.overlayOpen === true ? 'characterCard' : null,
      drawerOpen: false,
      settingsModalOpen: false,
      settingsLoaded: true,
      fullSettingsLoaded: true,
      messagesPerPage: 3,
      quickToolbarSettings,
    })
  })

  const host = domWindow.document.createElement('div')
  domWindow.document.body.append(host)
  const root = createRoot(host)
  activeRoot = root

  const tree = React.createElement(
    React.Fragment,
    null,
    React.createElement(runtime.ChatView, null),
    // Production only ever mounts the floating toolbar through the Suite's own
    // host surface, so an absent Suite means an absent host.
    cell.host === 'floating-host' && cell.suiteEnabled
      ? React.createElement(runtime.HostSurfaceRenderer, {
        key: 'quick-toolbar-host',
        surfaceId: 'quick_toolbar.workspace',
        props: { ownerToken: 'test-extension', generation: 1, contractVersion: 1, capabilities: [] },
        context: { emit: () => undefined } as never,
      })
      : null,
  )

  await React.act(async () => { root.render(tree) })
  await React.act(async () => { await sleep(120) })
  await React.act(async () => { await sleep(60) })

  return readEvidence()
}

beforeEach(() => {
  captured.length = 0
  runtime.routerStub.resetNavigateCalls()
})

/**
 * A rendered owner is only an owner if pressing it actually reaches the real
 * oldest-message navigation (`messagesApi.list(chatId, {limit: 1, offset: 0})`
 * followed by a find-target hand-off). Returns a failure reason or null.
 */
async function proveOwnerWorks(): Promise<string | null> {
  const owner = soleOldestOwner()
  if (!owner) return 'NO_SOLE_OWNER'
  if (owner.hasAttribute('disabled')) return 'OWNER_DISABLED'
  captured.length = 0
  await runtime.React.act(async () => {
    owner.click()
    await sleep(120)
  })
  const probe = captured.find((entry) => (
    entry.method === 'GET'
    && entry.url.includes(`/chats/${CHAT_ID}/messages`)
    && entry.url.includes('limit=1')
    && entry.url.includes('offset=0')
  ))
  return probe ? null : `OWNER_INERT(seen=${JSON.stringify(captured.map((entry) => entry.url))})`
}

// ─────────────────────────────────────────────────────────────────────────
// The core matrix: Suite x host x visible-id normalization x native visibility
// ─────────────────────────────────────────────────────────────────────────
test('every eligible chat renders exactly one working oldest-message owner', async () => {
  const failures: string[] = []
  const hosts: HostMode[] = ['docked', 'floating-host', 'floating-absent']
  const visibleModes: VisibleIdsMode[] = ['raw-includes-oldest', 'shipped-default-normalized', 'empty-normalized']

  for (const suiteEnabled of [false, true]) {
    for (const host of hosts) {
      for (const visibleIds of visibleModes) {
        for (const showNativeScrollToTop of [true, false]) {
          const cell: Cell = {
            suiteEnabled,
            toolbarEnabled: true,
            host,
            visibleIds,
            showNativeScrollToTop,
            totalChatLength: 12,
            override: 'none',
          }
          const evidence = await renderCell(cell)
          const owners = evidence.nativeOldest + evidence.quickToolbarOldest

          // Preserved contracts, asserted on every cell.
          expect(evidence.nativeGroups).toBe(1)
          expect(evidence.dockRequest).toBe('strip')
          expect(evidence.nativeActionSide).toBe(suiteEnabled ? 'right' : null)

          // Duplicates are always a failure.
          if (owners > 1) failures.push(`DUPLICATE(${owners}) ${describeCell(cell)}`)

          if (showNativeScrollToTop) {
            // Eligible: >1 message and the user has not hidden the action.
            if (owners !== 1) failures.push(`OWNERS=${owners} ${describeCell(cell)}`)
            else {
              const inert = await proveOwnerWorks()
              if (inert) failures.push(`${inert} ${describeCell(cell)}`)
            }
          } else {
            // The user hid the native control: never render it there.
            if (evidence.nativeOldest !== 0) failures.push(`NATIVE_WHILE_HIDDEN ${describeCell(cell)}`)
          }
        }
      }
    }
  }

  expect(failures).toEqual([])
}, 240_000)

// ─────────────────────────────────────────────────────────────────────────
// totalChatLength eligibility, including paginated windows
// ─────────────────────────────────────────────────────────────────────────
test('oldest-message eligibility follows totalChatLength across paginated windows', async () => {
  const failures: string[] = []
  for (const host of ['docked', 'floating-host', 'floating-absent'] as HostMode[]) {
    for (const totalChatLength of [0, 1, 12]) {
      const cell: Cell = {
        suiteEnabled: true,
        toolbarEnabled: true,
        host,
        visibleIds: 'raw-includes-oldest',
        showNativeScrollToTop: true,
        totalChatLength,
        override: 'none',
      }
      const evidence = await renderCell(cell)
      const owners = evidence.nativeOldest + evidence.quickToolbarOldest

      // The loaded window is smaller than the chat for the paginated case.
      expect(runtime.useStore.getState().totalChatLength).toBe(totalChatLength)
      expect(runtime.useStore.getState().messages.length).toBeLessThanOrEqual(3)

      if (owners > 1) failures.push(`DUPLICATE(${owners}) ${describeCell(cell)}`)
      if (totalChatLength > 1 && owners !== 1) failures.push(`OWNERS=${owners} ${describeCell(cell)}`)
      if (totalChatLength <= 1 && evidence.nativeOldest !== 0) {
        failures.push(`NATIVE_WITHOUT_HISTORY ${describeCell(cell)}`)
      }
    }
  }
  expect(failures).toEqual([])
}, 180_000)

// ─────────────────────────────────────────────────────────────────────────
// Toolbar disabled, overlay-hidden float, and extension override occupancy
// ─────────────────────────────────────────────────────────────────────────
test('native ownership survives a disabled, hidden, or overridden QuickToolbar', async () => {
  const failures: string[] = []
  const cells: Cell[] = [
    // Toolbar switched off entirely: nothing can render the toolbar action.
    {
      suiteEnabled: true,
      toolbarEnabled: false,
      host: 'docked',
      visibleIds: 'raw-includes-oldest',
      showNativeScrollToTop: true,
      totalChatLength: 12,
      override: 'none',
    },
    {
      suiteEnabled: true,
      toolbarEnabled: false,
      host: 'floating-host',
      visibleIds: 'raw-includes-oldest',
      showNativeScrollToTop: true,
      totalChatLength: 12,
      override: 'none',
    },
    // Floating toolbar hidden behind an open overlay.
    {
      suiteEnabled: true,
      toolbarEnabled: true,
      host: 'floating-host',
      visibleIds: 'raw-includes-oldest',
      showNativeScrollToTop: true,
      totalChatLength: 12,
      override: 'none',
      overlayOpen: true,
    },
    // An extension replaced the QuickToolbar and does not render the action.
    {
      suiteEnabled: true,
      toolbarEnabled: true,
      host: 'docked',
      visibleIds: 'raw-includes-oldest',
      showNativeScrollToTop: true,
      totalChatLength: 12,
      override: 'replace-without-oldest',
    },
    // ...and one that does: then the native control must stand down.
    {
      suiteEnabled: true,
      toolbarEnabled: true,
      host: 'docked',
      visibleIds: 'raw-includes-oldest',
      showNativeScrollToTop: true,
      totalChatLength: 12,
      override: 'replace-with-oldest',
    },
  ]

  for (const cell of cells) {
    const evidence = await renderCell(cell)
    const owners = evidence.nativeOldest + evidence.quickToolbarOldest
    expect(evidence.nativeGroups).toBe(1)
    if (owners !== 1) failures.push(`OWNERS=${owners} ${describeCell(cell)}`)
    if (cell.override === 'replace-with-oldest' && evidence.nativeOldest !== 0) {
      failures.push(`DUPLICATE_WITH_OVERRIDE ${describeCell(cell)}`)
    }
  }

  expect(failures).toEqual([])
}, 180_000)

// ─────────────────────────────────────────────────────────────────────────
// Preserved: Suite-disabled native alignment, single native group, dock contracts
// ─────────────────────────────────────────────────────────────────────────
test('Suite-disabled placement drops the Suite side contract and keeps its dock contract', async () => {
  const suiteDisabledLeft = await renderCell({
    suiteEnabled: false,
    toolbarEnabled: true,
    host: 'docked',
    visibleIds: 'raw-includes-oldest',
    showNativeScrollToTop: true,
    totalChatLength: 12,
    override: 'none',
    nativeDockActionSide: 'left',
  })
  expect(suiteDisabledLeft.nativeGroups).toBe(1)
  expect(suiteDisabledLeft.nativeActionSide).toBeNull()
  expect(suiteDisabledLeft.dockRequest).toBe('strip')
  expect(suiteDisabledLeft.quickToolbarMounted).toBe(false)

  const suiteEnabledLeft = await renderCell({
    suiteEnabled: true,
    toolbarEnabled: true,
    host: 'docked',
    visibleIds: 'raw-includes-oldest',
    showNativeScrollToTop: true,
    totalChatLength: 12,
    override: 'none',
    nativeDockActionSide: 'left',
  })
  expect(suiteEnabledLeft.nativeGroups).toBe(1)
  expect(suiteEnabledLeft.nativeActionSide).toBe('left')
  expect(suiteEnabledLeft.dockRequest).toBe('strip')
  expect(suiteEnabledLeft.quickToolbarMounted).toBe(true)
  // Docked stretch contract: fill-top-dock stays on for the docked toolbar.
  expect(suiteEnabledLeft.fillTopDock).toBe('1')
}, 120_000)

afterAll(async () => {
  await unmountCell()
})
