/// <reference types="bun-types" />

/**
 * RUNTIME REGRESSION TESTS — spec task 5.3
 * "Trace and prove the Edit-and-Send false-setting value chain".
 *
 * These assertions drive ONE continuous runtime chain. Nothing in the chain
 * under test is mocked; the only stubs are the transport seam (a `fetch` that
 * routes the browser's own requests into a real in-memory backend) and the
 * `react-router` surface (recorded, not swallowed, so "navigation is skipped"
 * is an observation rather than an assumption).
 *
 *   1. REAL `ProductivitySettings` checkbox `#quick-branch-edit-and-send`
 *      clicked in JSDOM -> REAL `bindProductivitySetting` -> REAL
 *      `useStore.setState` -> REAL `persistKey('quickToolbarSettings', next,
 *      'user-interaction')`.
 *   2. REAL `PRODUCTIVITY_CONTROL_DEFINITIONS` / `DEFAULT_QUICK_TOOLBAR_SETTINGS`
 *      binding keeps the explicit `false` instead of the `true` default.
 *   3. REAL `flushSettingsNow()` -> captured `PUT /api/v1/settings` body ->
 *      stored in a settings table -> store reset to shipped defaults (page
 *      reload) -> REAL `loadSettings()` (canonical row, compatibility/private
 *      fallback-only row, and stale-mirror variants) -> REAL
 *      `migrateProductivitySetting` + `mergeStoredSetting`.
 *   4. REAL `BubbleMessage` -> `useMessageCard` -> the REAL Edit-and-Send button
 *      in `MessageEditArea` is clicked; request fingerprint mode, preload, and
 *      navigation are observed.
 *   5. REAL `frontend/src/api/chats.ts#editAndSend` -> REAL `post()` -> captured
 *      request body (raw JSON string, not an object literal).
 *   6. REAL `src/routes/chats.routes.ts` Hono handler validates and defaults.
 *   7. REAL `src/services/chats.service.ts#editAndSend` against a real
 *      `bun:sqlite` in-memory database; branch creation, outbox targeting, and
 *      source-row effects are read back out of SQL.
 *
 * Existing object-literal tests seed the store directly with `false`; they
 * cannot observe boundaries 1-3 at all. This file exists to close that gap.
 *
 * NO PRODUCTION CODE IS MODIFIED BY THIS FILE.
 */

import { afterAll, beforeEach, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

import { closeDatabase, getDb, initDatabase } from '../../src/db/connection'
import { chatsRoutes } from '../../src/routes/chats.routes'
import { settingsRoutes } from '../../src/routes/settings.routes'
import {
  getGenerationOutboxByRequest,
  resetEditAndSendDispatcherForTests,
  setEditAndSendStartGeneration,
  type StartEditAndSendGenerationInput,
} from '../../src/services/edit-and-send-dispatcher.service'
import { Hono } from 'hono'

// ── Identities shared by the frontend store and the backend database ──────
const USER_ID = 'user-1'
const CHAT_ID = 'chat-1'
const USER_MESSAGE_ID = 'user-1'
const ASSISTANT_MESSAGE_ID = 'asst-1'
const GREETING_MESSAGE_ID = 'greet'
const QUICK_TOOLBAR_KEY = 'quickToolbarSettings'
const QUICK_TOOLBAR_MIRROR_KEY = 'spindle:lumiverse_suite:quick_toolbar:quickToolbarSettings'

// ── JSDOM environment (must exist before any Vite module is loaded) ───────
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
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLSelectElement: domWindow.HTMLSelectElement,
  HTMLAudioElement: domWindow.HTMLAudioElement,
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

// ── Real backend: in-memory SQLite + the real chats routes ────────────────
function initBackendDb(): void {
  closeDatabase()
  initDatabase(':memory:')
  const db = getDb()

  db.run(`CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '',
    scenario TEXT NOT NULL DEFAULT '',
    first_mes TEXT NOT NULL DEFAULT '',
    mes_example TEXT NOT NULL DEFAULT '',
    creator TEXT NOT NULL DEFAULT '',
    creator_notes TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    post_history_instructions TEXT NOT NULL DEFAULT '',
    avatar_path TEXT,
    image_id TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    alternate_greetings TEXT NOT NULL DEFAULT '[]',
    extensions TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT 1
  )`)
  db.run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    character_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    index_in_chat INTEGER NOT NULL,
    is_user INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    send_date INTEGER NOT NULL,
    swipe_id INTEGER NOT NULL DEFAULT 0,
    swipes TEXT NOT NULL DEFAULT '[]',
    swipe_dates TEXT NOT NULL DEFAULT '[]',
    extra TEXT NOT NULL DEFAULT '{}',
    parent_message_id TEXT,
    branch_id TEXT,
    created_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  )`)
  // The branch-enabled control path preloads the branch through the real
  // `GET /chats/:id` route, which consults the extension registry.
  db.run(`CREATE TABLE extensions (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0
  )`)
  // Same column set as `settings` in `src/db/baseline.sql`, minus the
  // `"user"(id)` foreign key this focused fixture does not create.
  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    user_id TEXT,
    PRIMARY KEY (key, user_id)
  )`)
  db.run(`CREATE TABLE chat_memory_cache (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    settings_key TEXT NOT NULL,
    UNIQUE(chat_id, settings_key)
  )`)
  db.run(`CREATE TABLE edit_and_send_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    branch_chat_id TEXT NOT NULL,
    edited_message_id TEXT NOT NULL,
    target_message_id TEXT,
    target_swipe_index INTEGER,
    generation_id TEXT NOT NULL,
    response TEXT NOT NULL,
    cursor TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, chat_id, request_id)
  )`)
  db.run(`CREATE TABLE generation_outbox (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    branch_chat_id TEXT NOT NULL,
    edited_message_id TEXT NOT NULL,
    target_message_id TEXT,
    target_swipe_index INTEGER,
    expected_version INTEGER NOT NULL,
    generation_id TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL CHECK(mode IN ('normal', 'swipe')),
    status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
    lease_owner TEXT,
    lease_expires_at INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    last_error_code TEXT,
    terminal_reason TEXT,
    dispatched_at INTEGER,
    completed_at INTEGER,
    cancelled_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    -- migrations/111_generation_outbox_connection_id.sql. Hand-written schema
    -- (no migrations run here), so the column is mirrored last to match the
    -- ALTER TABLE append order.
    connection_id TEXT
  )`)
}

function seedBackendHistory(): void {
  const db = getDb()
  db.query('INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)').run('char1', USER_ID, 'Alpha')
  db.query(
    'INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(CHAT_ID, USER_ID, 'char1', 'Chat', '{}', 1, 1)
  const insert = db.query(
    `INSERT INTO messages (
      id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id,
      swipes, swipe_dates, extra, parent_message_id, branch_id, created_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
  insert.run(GREETING_MESSAGE_ID, CHAT_ID, 0, 0, 'Assistant', 'Hi', 1, 0, JSON.stringify(['Hi']), JSON.stringify([1]), '{}', null, null, 1)
  insert.run(USER_MESSAGE_ID, CHAT_ID, 1, 1, 'User', 'Hello', 2, 0, JSON.stringify(['Hello']), JSON.stringify([2]), '{}', null, null, 2)
  insert.run(ASSISTANT_MESSAGE_ID, CHAT_ID, 2, 0, 'Assistant', 'There', 3, 0, JSON.stringify(['There']), JSON.stringify([3]), '{}', null, null, 3)
}

const backendApp = new Hono()
backendApp.use('*', async (c, next) => {
  // The frontend tsconfig does not see the backend's `ContextVariableMap`
  // augmentation, so the authenticated-user variable is set through a cast.
  ;(c as unknown as { set: (key: string, value: unknown) => void }).set('userId', USER_ID)
  await next()
})
backendApp.route('/settings', settingsRoutes)
backendApp.route('/chats', chatsRoutes)

const dispatchedGenerations: StartEditAndSendGenerationInput[] = []

// ── Transport seam ────────────────────────────────────────────────────────
// The ONLY stub in the chain. Every `/api/v1/...` request the real frontend
// makes is recorded and forwarded verbatim into the REAL Hono app, so the
// settings persistence/reload hop and the Edit-and-Send hop both run through
// production routes, production services and one real SQLite database.
interface CapturedRequest {
  method: string
  url: string
  rawBody: string | null
}

const captured: CapturedRequest[] = []
const API_PREFIX = '/api/v1'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

globalThis.fetch = (async (input: any, init?: any) => {
  const rawUrl = typeof input === 'string' ? input : String(input?.url ?? input)
  const method = String(init?.method ?? 'GET').toUpperCase()
  const rawBody = init?.body == null ? null : String(init.body)
  const parsed = rawUrl.startsWith('http') ? new URL(rawUrl) : null
  const path = parsed ? parsed.pathname + parsed.search : rawUrl
  captured.push({ method, url: path, rawBody })

  if (path.startsWith(`${API_PREFIX}/`)) {
    return backendApp.request(`http://backend.test${path.slice(API_PREFIX.length)}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: rawBody ?? undefined,
    })
  }

  return json({ error: 'not stubbed', path }, 404)
}) as typeof fetch

// ── Direct settings-row access (evidence, never part of the chain) ─────────
function readSettingRow(key: string): unknown {
  const row = getDb()
    .query('SELECT value FROM settings WHERE key = ? AND user_id = ?')
    .get(key, USER_ID) as { value: string } | null
  return row ? JSON.parse(row.value) : undefined
}

function hasSettingRow(key: string): boolean {
  return readSettingRow(key) !== undefined
}

function writeSettingRow(key: string, value: unknown): void {
  getDb().query(
    `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), USER_ID, 1)
}

function deleteSettingRow(key: string): void {
  getDb().query('DELETE FROM settings WHERE key = ? AND user_id = ?').run(key, USER_ID)
}

// ── Vite runtime holding the REAL frontend module graph ───────────────────
interface Runtime {
  server: Awaited<ReturnType<typeof createServer>>
  useStore: any
  ProductivitySettings: any
  BubbleMessage: any
  defaults: any
  settingsModule: any
  productivityModel: any
  routerStub: { navigateCalls: unknown[][]; resetNavigateCalls: () => void }
  clearChatNavigationSnapshots: () => void
  React: typeof import('react')
  createRoot: typeof import('react-dom/client')['createRoot']
}

let runtimePromise: Promise<Runtime> | null = null

async function createRuntime(): Promise<Runtime> {
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    resolve: {
      alias: [{
        find: /^react-router$/,
        // The stub stays under `frontend/src` because the Vite server rooted at
        // `frontend/` also loads it by `/src/...` path below; the alias must
        // resolve to that same absolute file so both routes share one instance.
        replacement: fileURLToPath(new URL(
          '../src/components/settings/edit-and-send-false-chain.5-3.router-stub.ts',
          import.meta.url,
        )),
      }],
    },
  })

  const i18nModule = await server.ssrLoadModule('/src/i18n/index.ts') as { initI18n: () => Promise<unknown> }
  await i18nModule.initI18n()

  const storeModule = await server.ssrLoadModule('/src/store/index.ts') as { useStore: any }
  const productivitySettings = await server.ssrLoadModule('/src/components/settings/ProductivitySettings.tsx') as { default: any }
  const bubbleModule = await server.ssrLoadModule('/src/components/chat/BubbleMessage.tsx') as { default: any }
  const defaultsModule = await server.ssrLoadModule('/src/lib/uiProductivityDefaults.ts')
  const settingsModule = await server.ssrLoadModule('/src/store/slices/settings.ts')
  const productivityModel = await server.ssrLoadModule('/src/components/settings/ProductivitySettingsModel.ts')
  const routerStub = await server.ssrLoadModule('/src/components/settings/edit-and-send-false-chain.5-3.router-stub.ts') as {
    navigateCalls: unknown[][]
    resetNavigateCalls: () => void
  }
  const snapshotModule = await server.ssrLoadModule('/src/lib/chatNavigationSnapshot.ts') as {
    clearChatNavigationSnapshots: () => void
  }

  const React = await import('react')
  const { createRoot } = await import('react-dom/client')

  return {
    server,
    useStore: storeModule.useStore,
    ProductivitySettings: productivitySettings.default,
    BubbleMessage: bubbleModule.default,
    defaults: defaultsModule,
    settingsModule,
    productivityModel,
    routerStub,
    clearChatNavigationSnapshots: snapshotModule.clearChatNavigationSnapshots,
    React,
    createRoot,
  }
}

function getRuntime(): Promise<Runtime> {
  runtimePromise ??= createRuntime()
  return runtimePromise
}

// Warm the Vite/React/i18n graph before any hook runs: booting it inside
// `beforeEach` exceeds the default hook timeout and leaves `act()` mid-flight.
const warmRuntime = await getRuntime()

afterAll(async () => {
  if (runtimePromise) {
    const runtime = await runtimePromise.catch(() => null)
    await runtime?.server.close()
  }
  resetEditAndSendDispatcherForTests()
  closeDatabase()
})

// ── Store scaffolding ─────────────────────────────────────────────────────
function makeFrontendMessage(overrides: Record<string, unknown>) {
  return {
    id: 'x',
    chat_id: CHAT_ID,
    index_in_chat: 0,
    is_user: false,
    name: '',
    content: '',
    send_date: 1,
    swipe_id: 0,
    swipes: [''],
    swipe_dates: [1],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: 1,
    revision: 1,
    ...overrides,
  } as any
}

const frontendUserMessage = makeFrontendMessage({
  id: USER_MESSAGE_ID,
  index_in_chat: 1,
  is_user: true,
  name: 'User',
  content: 'Hello',
  swipes: ['Hello'],
  revision: 1,
})

const frontendAssistantMessage = makeFrontendMessage({
  id: ASSISTANT_MESSAGE_ID,
  index_in_chat: 2,
  name: 'Assistant',
  content: 'There',
  swipes: ['There'],
  revision: 1,
})

const SUITE_EXTENSIONS = [{
  id: 'lumiverse_suite',
  identifier: 'lumiverse_suite',
  enabled: true,
  has_frontend: true,
}]

async function resetFrontendStore(runtime: Runtime): Promise<void> {
  const { useStore, React } = runtime
  await React.act(async () => {
    useStore.setState({
      user: { id: USER_ID },
      extensions: SUITE_EXTENSIONS,
      showEditAndSend: true,
      activeChatId: CHAT_ID,
      activeCharacterId: null,
      activeChatMetadata: null,
      activeChatAvatarId: null,
      characters: [],
      personas: [],
      profiles: [],
      messages: [frontendUserMessage, frontendAssistantMessage],
      totalChatLength: 3,
      isStreaming: false,
      streamingContent: '',
      streamingReasoning: '',
      activeGenerationId: null,
      regeneratingMessageId: null,
      streamingSwipeId: null,
      streamingGenerationType: null,
      regexScripts: [],
      messagesPerPage: 50,
      chatDisplayMode: 'bubble',
      messageSelectMode: false,
      componentOverrides: {},
      editingMessageId: null,
      messageEditDraft: null,
      settingsLoaded: true,
      fullSettingsLoaded: true,
      quickToolbarSettings: { ...runtime.defaults.DEFAULT_QUICK_TOOLBAR_SETTINGS },
    })
  })
}

/**
 * Full page-reload simulation: the store returns to its shipped defaults (so a
 * surviving in-memory `false` cannot be mistaken for a persisted one) and the
 * REAL `loadSettings()` rehydrates from the settings table written by the real
 * flush.
 */
async function simulateReload(runtime: Runtime): Promise<void> {
  const { useStore, React, defaults } = runtime
  await React.act(async () => {
    useStore.setState({
      quickToolbarSettings: { ...defaults.DEFAULT_QUICK_TOOLBAR_SETTINGS },
      settingsLoaded: false,
      fullSettingsLoaded: false,
    })
  })
  expect(useStore.getState().quickToolbarSettings.branchChatOnEditAndSend).toBe(true)
  await React.act(async () => {
    await useStore.getState().loadSettings()
  })
}

interface RenderHandle {
  host: HTMLElement
  unmount: () => Promise<void>
}

async function renderComponent(runtime: Runtime, element: unknown): Promise<RenderHandle> {
  const { React, createRoot } = runtime
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await React.act(async () => { root.render(element as any) })
  await React.act(async () => { await sleep(60) })
  return {
    host,
    unmount: async () => {
      await React.act(async () => { root.unmount() })
      host.remove()
    },
  }
}

/** Toggle the REAL settings checkbox and persist through the REAL flush. */
async function toggleBranchCheckboxOff(runtime: Runtime): Promise<{
  checkedBefore: boolean
  checkedAfter: boolean
  storeAfterClick: unknown
  putBodies: string[]
}> {
  const { React, useStore } = runtime
  const handle = await renderComponent(
    runtime,
    React.createElement(runtime.ProductivitySettings, null),
  )
  const checkbox = handle.host.querySelector<HTMLInputElement>('#quick-branch-edit-and-send')
  expect(checkbox).not.toBeNull()
  const checkedBefore = checkbox!.checked

  captured.length = 0
  await React.act(async () => {
    checkbox!.click()
    await sleep(0)
  })
  const storeAfterClick = useStore.getState().quickToolbarSettings.branchChatOnEditAndSend
  const checkedAfter = handle.host.querySelector<HTMLInputElement>('#quick-branch-edit-and-send')!.checked

  await React.act(async () => {
    await runtime.settingsModule.flushSettingsNow()
    await sleep(10)
  })
  const putBodies = captured
    .filter((entry) => entry.method === 'PUT' && entry.url === '/api/v1/settings')
    .map((entry) => entry.rawBody ?? '')

  await handle.unmount()
  return { checkedBefore, checkedAfter, storeAfterClick, putBodies }
}

interface ClickOutcome {
  editAndSendRequests: CapturedRequest[]
  preloadRequests: CapturedRequest[]
  navigateCalls: unknown[][]
}

/** Open the real edit draft and mount a real `BubbleMessage` for it. */
async function mountEditingCard(
  runtime: Runtime,
  content: string,
  message: Record<string, unknown> = frontendUserMessage,
): Promise<RenderHandle & { clickEditAndSend: () => Promise<ClickOutcome> }> {
  const { React, useStore } = runtime
  const openDraft = async () => {
    await React.act(async () => {
      useStore.getState().beginMessageEdit({
        chatId: CHAT_ID,
        messageId: USER_MESSAGE_ID,
        messageOffset: 1,
        messageIndexInChat: 1,
        content,
        reasoning: '',
        showReasoningEditor: false,
        hadReasoning: false,
      })
    })
  }
  await openDraft()

  const handle = await renderComponent(
    runtime,
    React.createElement(runtime.BubbleMessage, {
      message,
      chatId: CHAT_ID,
      depth: 1,
    }),
  )

  const clickEditAndSend = async (): Promise<ClickOutcome> => {
    if (useStore.getState().editingMessageId !== USER_MESSAGE_ID) {
      await openDraft()
      await React.act(async () => { await sleep(20) })
    }
    const button = handle.host.querySelector<HTMLButtonElement>('[data-edit-and-send-action="true"]')
    expect(button).not.toBeNull()
    expect(button!.disabled).toBe(false)

    captured.length = 0
    runtime.routerStub.resetNavigateCalls()
    runtime.clearChatNavigationSnapshots()

    await React.act(async () => {
      button!.click()
      await sleep(250)
    })

    return {
      editAndSendRequests: captured.filter((entry) => entry.url.endsWith('/edit-and-send')),
      preloadRequests: captured.filter((entry) => (
        entry.method === 'GET' && entry.url.startsWith('/api/v1/chats/')
      )),
      navigateCalls: runtime.routerStub.navigateCalls.map((call) => [...call]),
    }
  }

  return { ...handle, clickEditAndSend }
}

/** Flip the real settings checkbox while leaving any mounted card in place. */
async function setBranchCheckbox(runtime: Runtime, next: boolean): Promise<void> {
  const { React } = runtime
  const panel = await renderComponent(runtime, React.createElement(runtime.ProductivitySettings, null))
  const checkbox = panel.host.querySelector<HTMLInputElement>('#quick-branch-edit-and-send')
  expect(checkbox).not.toBeNull()
  if (checkbox!.checked !== next) {
    await React.act(async () => { checkbox!.click(); await sleep(0) })
  }
  await React.act(async () => {
    await runtime.settingsModule.flushSettingsNow()
    await sleep(10)
  })
  await panel.unmount()
}

function chatRowCount(): number {
  return Number((getDb().query('SELECT COUNT(*) AS n FROM chats').get() as { n: number }).n)
}

function messageRow(id: string) {
  return getDb().query(
    'SELECT id, chat_id, index_in_chat, is_user, content, swipes, swipe_id, revision FROM messages WHERE id = ?',
  ).get(id) as Record<string, unknown> | null
}

beforeEach(async () => {
  initBackendDb()
  seedBackendHistory()
  resetEditAndSendDispatcherForTests()
  dispatchedGenerations.length = 0
  setEditAndSendStartGeneration(async (input) => {
    dispatchedGenerations.push(input)
    return { generationId: input.generationId, status: 'streaming' }
  })

  captured.length = 0
  try { domWindow.localStorage.clear() } catch { /* storage optional */ }
  document.body.replaceChildren()

  const runtime = warmRuntime
  await resetFrontendStore(runtime)
  runtime.routerStub.resetNavigateCalls()
  runtime.clearChatNavigationSnapshots()
})

// ─────────────────────────────────────────────────────────────────────────
// Boundaries 1 + 2: settings UI -> model/default binding -> store -> persistKey
// ─────────────────────────────────────────────────────────────────────────
test('B1+B2: the real checkbox emits an explicit false that the model/default binding keeps', async () => {
  const runtime = await getRuntime()

  // Boundary 2 (static half): the control is declared and the default is `true`,
  // so an explicit `false` is the only thing that can distinguish "user turned
  // it off" from "never set".
  expect(runtime.productivityModel.PRODUCTIVITY_CONTROL_DEFINITIONS.quickToolbarSettings)
    .toContain('branchChatOnEditAndSend')
  expect(runtime.defaults.DEFAULT_QUICK_TOOLBAR_SETTINGS.branchChatOnEditAndSend).toBe(true)
  expect(runtime.productivityModel.bindProductivitySetting(
    runtime.defaults.DEFAULT_QUICK_TOOLBAR_SETTINGS,
    { branchChatOnEditAndSend: false },
  ).branchChatOnEditAndSend).toBe(false)

  const result = await toggleBranchCheckboxOff(runtime)

  expect(result.checkedBefore).toBe(true)
  expect(result.checkedAfter).toBe(false)
  // Not falsy — explicitly the boolean `false`, never `undefined`.
  expect(result.storeAfterClick).toBe(false)

  // Boundary 1 end: `persistKey` queued the value and the real debounced flush
  // wrote it. Both the canonical row and its compatibility mirror carry `false`.
  expect(result.putBodies.length).toBeGreaterThan(0)
  const merged = result.putBodies.reduce<Record<string, any>>(
    (acc, body) => Object.assign(acc, JSON.parse(body)),
    {},
  )
  expect(Object.prototype.hasOwnProperty.call(merged, QUICK_TOOLBAR_KEY)).toBe(true)
  expect(merged[QUICK_TOOLBAR_KEY].branchChatOnEditAndSend).toBe(false)
  expect(merged[QUICK_TOOLBAR_MIRROR_KEY].branchChatOnEditAndSend).toBe(false)

  // The write is a merge, not a replacement: unrelated settings survive.
  expect(merged[QUICK_TOOLBAR_KEY].editAndSendSide).toBe('right')
  expect(merged[QUICK_TOOLBAR_KEY].nativeDockActionSide).toBe('right')
  expect(merged[QUICK_TOOLBAR_KEY].enabled).toBe(true)

  // The row committed by the REAL settings service must physically contain the
  // key. An omitted property is indistinguishable from the `true` default once
  // `mergeStoredSetting` backfills it.
  const persisted = readSettingRow(QUICK_TOOLBAR_KEY) as Record<string, unknown>
  expect(Object.prototype.hasOwnProperty.call(persisted, 'branchChatOnEditAndSend')).toBe(true)
  expect(persisted.branchChatOnEditAndSend).toBe(false)
  expect((readSettingRow(QUICK_TOOLBAR_MIRROR_KEY) as Record<string, unknown>).branchChatOnEditAndSend).toBe(false)
})

// ─────────────────────────────────────────────────────────────────────────
// Boundary 3: canonical load, fallback promotion, stale mirror, migration
// ─────────────────────────────────────────────────────────────────────────
test('B3: a reload from the canonical persisted row rehydrates false', async () => {
  const runtime = await getRuntime()
  await toggleBranchCheckboxOff(runtime)
  await simulateReload(runtime)

  const quick = runtime.useStore.getState().quickToolbarSettings
  expect(quick.branchChatOnEditAndSend).toBe(false)
  // The default merge still backfills everything else it should.
  expect(quick.editAndSendSide).toBe('right')
  expect(quick.nativeDockActionSide).toBe('right')
  expect(runtime.useStore.getState().fullSettingsLoaded).toBe(true)
})

test('B3: a reload from ONLY the compatibility/private fallback row rehydrates false', async () => {
  const runtime = await getRuntime()
  await toggleBranchCheckboxOff(runtime)

  // Legacy host shape: the canonical row was never written, only the suite's
  // namespaced mirror. The promotion path must not lose the explicit false.
  const mirror = readSettingRow(QUICK_TOOLBAR_MIRROR_KEY) as Record<string, unknown>
  expect(mirror.branchChatOnEditAndSend).toBe(false)
  deleteSettingRow(QUICK_TOOLBAR_KEY)
  expect(hasSettingRow(QUICK_TOOLBAR_KEY)).toBe(false)

  await simulateReload(runtime)
  expect(runtime.useStore.getState().quickToolbarSettings.branchChatOnEditAndSend).toBe(false)
})

test('B3: a stale compatibility row claiming true cannot override the canonical false', async () => {
  const runtime = await getRuntime()
  await toggleBranchCheckboxOff(runtime)

  writeSettingRow(QUICK_TOOLBAR_MIRROR_KEY, {
    ...(readSettingRow(QUICK_TOOLBAR_KEY) as Record<string, unknown>),
    branchChatOnEditAndSend: true,
  })

  await simulateReload(runtime)
  expect(runtime.useStore.getState().quickToolbarSettings.branchChatOnEditAndSend).toBe(false)
})

test('B3: a stored row that also triggers migration still rehydrates false', async () => {
  const runtime = await getRuntime()
  await toggleBranchCheckboxOff(runtime)

  // `migrateProductivitySetting` rewrites this row (stale V2 geometry marker).
  // The rewrite must copy the explicit false through.
  writeSettingRow(QUICK_TOOLBAR_KEY, {
    ...(readSettingRow(QUICK_TOOLBAR_KEY) as Record<string, unknown>),
    variant: 'v2-settings-adjacent',
    v2ViewportGeometryVersion: 1,
    rect: { x: 554, y: 18, width: 763, height: 64 },
  })
  const migrated = runtime.defaults.migrateProductivitySetting(
    QUICK_TOOLBAR_KEY,
    readSettingRow(QUICK_TOOLBAR_KEY),
  )
  expect(migrated.branchChatOnEditAndSend).toBe(false)
  expect(migrated.rect).toEqual({ x: 554, y: 18, width: 0, height: 0 })

  await simulateReload(runtime)
  expect(runtime.useStore.getState().quickToolbarSettings.branchChatOnEditAndSend).toBe(false)
})

/**
 * NEGATIVE CONTROL. The tests above only mean something if this harness can
 * actually observe a lost `false`. Drop the property from every persisted row —
 * the exact "omitted property / default merge" failure mode task 5.3 names — and
 * the whole chain must flip to branching. If this test ever starts reporting
 * `false`, the harness has stopped measuring the boundary.
 */
test('negative control: dropping the property from the persisted rows DOES flip the chain to true', async () => {
  const runtime = await getRuntime()
  await toggleBranchCheckboxOff(runtime)

  for (const key of [QUICK_TOOLBAR_KEY, QUICK_TOOLBAR_MIRROR_KEY]) {
    const row = { ...(readSettingRow(key) as Record<string, unknown>) }
    delete row.branchChatOnEditAndSend
    writeSettingRow(key, row)
    expect(Object.prototype.hasOwnProperty.call(readSettingRow(key), 'branchChatOnEditAndSend')).toBe(false)
  }

  await simulateReload(runtime)
  expect(runtime.useStore.getState().quickToolbarSettings.branchChatOnEditAndSend).toBe(true)

  const card = await mountEditingCard(runtime, 'Dropped property')
  const observed = await card.clickEditAndSend()
  await card.unmount()
  const body = JSON.parse(observed.editAndSendRequests[0]!.rawBody!)
  expect(body.branchChatOnEditAndSend).toBe(true)
  expect(chatRowCount()).toBe(2)
  expect(observed.navigateCalls).toHaveLength(1)
})

// ─────────────────────────────────────────────────────────────────────────
// Boundaries 4 + 5 + 6 + 7: rendered card -> API -> route -> service -> SQL
// ─────────────────────────────────────────────────────────────────────────
test('B4-B7: after a reload, the real Edit-and-Send button sends false and edits in place', async () => {
  const runtime = await getRuntime()
  await toggleBranchCheckboxOff(runtime)
  await simulateReload(runtime)
  expect(runtime.useStore.getState().quickToolbarSettings.branchChatOnEditAndSend).toBe(false)

  const chatsBefore = chatRowCount()
  const sourceAssistantBefore = messageRow(ASSISTANT_MESSAGE_ID)

  const card = await mountEditingCard(runtime, 'Hello in place')
  const observed = await card.clickEditAndSend()
  await card.unmount()

  // Boundary 5: exactly one request, carrying the explicit field unchanged in
  // the raw serialized body.
  expect(observed.editAndSendRequests).toHaveLength(1)
  const request = observed.editAndSendRequests[0]!
  expect(request.method).toBe('POST')
  expect(request.url).toBe(`/api/v1/chats/${CHAT_ID}/edit-and-send`)
  if (process.env.TRACE_5_3 === '1') {
    console.log('[5.3 trace] store.quickToolbarSettings.branchChatOnEditAndSend =',
      runtime.useStore.getState().quickToolbarSettings.branchChatOnEditAndSend)
    console.log('[5.3 trace] persisted canonical row =',
      JSON.stringify((readSettingRow(QUICK_TOOLBAR_KEY) as Record<string, unknown>).branchChatOnEditAndSend))
    console.log('[5.3 trace] persisted mirror row =',
      JSON.stringify((readSettingRow(QUICK_TOOLBAR_MIRROR_KEY) as Record<string, unknown>).branchChatOnEditAndSend))
    console.log('[5.3 trace] POST', request.url, request.rawBody)
  }
  expect(request.rawBody).toContain('"branchChatOnEditAndSend":false')
  const body = JSON.parse(request.rawBody!)
  expect(body).toEqual({
    messageId: USER_MESSAGE_ID,
    content: 'Hello in place',
    expectedVersion: 1,
    requestId: expect.any(String),
    branchChatOnEditAndSend: false,
  })

  // Boundary 4: no branch preload, no branch navigation.
  expect(observed.preloadRequests).toEqual([])
  expect(observed.navigateCalls).toEqual([])
  expect(runtime.useStore.getState().editingMessageId).toBeNull()
  expect(runtime.useStore.getState().messageEditDraft).toBeNull()

  // Boundaries 6 + 7: the route accepted boolean false, the service defaulted
  // nothing, and only the in-place path executed.
  expect(chatRowCount()).toBe(chatsBefore)
  expect(messageRow(USER_MESSAGE_ID)).toEqual({
    id: USER_MESSAGE_ID,
    chat_id: CHAT_ID,
    index_in_chat: 1,
    is_user: 1,
    content: 'Hello in place',
    swipes: JSON.stringify(['Hello in place']),
    swipe_id: 0,
    revision: 2,
  })
  expect(messageRow(ASSISTANT_MESSAGE_ID)).toEqual(sourceAssistantBefore)
  expect(getDb().query('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 3 })

  const outbox = getGenerationOutboxByRequest(USER_ID, CHAT_ID, body.requestId)
  if (process.env.TRACE_5_3 === '1') {
    console.log('[5.3 trace] chats rows =', chatRowCount(), 'messages rows =',
      JSON.stringify(getDb().query('SELECT COUNT(*) AS n FROM messages').get()))
    console.log('[5.3 trace] source user row =', JSON.stringify(messageRow(USER_MESSAGE_ID)))
    console.log('[5.3 trace] source assistant row =', JSON.stringify(messageRow(ASSISTANT_MESSAGE_ID)))
    console.log('[5.3 trace] outbox =', JSON.stringify({
      chat_id: outbox?.chat_id,
      branch_chat_id: outbox?.branch_chat_id,
      edited_message_id: outbox?.edited_message_id,
      target_message_id: outbox?.target_message_id,
      target_swipe_index: outbox?.target_swipe_index,
      mode: outbox?.mode,
    }))
    console.log('[5.3 trace] preloadRequests =', JSON.stringify(observed.preloadRequests),
      'navigateCalls =', JSON.stringify(observed.navigateCalls))
  }
  expect(outbox).toMatchObject({
    request_id: body.requestId,
    user_id: USER_ID,
    chat_id: CHAT_ID,
    branch_chat_id: CHAT_ID,
    edited_message_id: USER_MESSAGE_ID,
    target_message_id: ASSISTANT_MESSAGE_ID,
    target_swipe_index: 1,
    expected_version: 1,
    mode: 'swipe',
  })
  expect(dispatchedGenerations).toEqual([{
    userId: USER_ID,
    chat_id: CHAT_ID,
    generationId: outbox!.generation_id,
    generation_type: 'swipe',
    message_id: ASSISTANT_MESSAGE_ID,
  }])
})

test('B4: the request fingerprint carries the mode across retries on one mounted card', async () => {
  const runtime = await getRuntime()
  await toggleBranchCheckboxOff(runtime)
  await simulateReload(runtime)

  // A deliberately stale expectedVersion makes the backend reject the request,
  // so `editAndSendRequestRef` is retained and the fingerprint decision becomes
  // observable across retries on the SAME mounted card.
  const staleMessage = { ...frontendUserMessage, revision: 99 }
  const card = await mountEditingCard(runtime, 'Same content', staleMessage)

  const first = await card.clickEditAndSend()
  const firstBody = JSON.parse(first.editAndSendRequests[0]!.rawBody!)
  expect(firstBody.branchChatOnEditAndSend).toBe(false)
  expect(firstBody.expectedVersion).toBe(99)

  // Identical inputs -> identical fingerprint -> the same durable requestId.
  const retry = await card.clickEditAndSend()
  const retryBody = JSON.parse(retry.editAndSendRequests[0]!.rawBody!)
  expect(retryBody.branchChatOnEditAndSend).toBe(false)
  expect(retryBody.requestId).toBe(firstBody.requestId)

  // Only the mode changes -> the fingerprint must change -> a new requestId, so
  // the backend cannot replay the branch-disabled payload for a branch request.
  await setBranchCheckbox(runtime, true)
  expect(runtime.useStore.getState().quickToolbarSettings.branchChatOnEditAndSend).toBe(true)
  const flipped = await card.clickEditAndSend()
  const flippedBody = JSON.parse(flipped.editAndSendRequests[0]!.rawBody!)
  expect(flippedBody.branchChatOnEditAndSend).toBe(true)
  expect(flippedBody.content).toBe(firstBody.content)
  expect(flippedBody.expectedVersion).toBe(firstBody.expectedVersion)
  expect(flippedBody.requestId).not.toBe(firstBody.requestId)

  await card.unmount()

  // Nothing committed: every attempt was rejected on the stale revision.
  expect(chatRowCount()).toBe(1)
  expect(messageRow(USER_MESSAGE_ID)!.content).toBe('Hello')
  expect(messageRow(USER_MESSAGE_ID)!.revision).toBe(1)
})

test('preservation: with the shipped default the real button still branches, preloads and navigates', async () => {
  const runtime = await getRuntime()
  // No persisted row at all: the established `true` default must survive.
  await simulateReload(runtime)
  expect(runtime.useStore.getState().quickToolbarSettings.branchChatOnEditAndSend).toBe(true)

  const card = await mountEditingCard(runtime, 'Hello in a branch')
  const observed = await card.clickEditAndSend()
  await card.unmount()

  expect(observed.editAndSendRequests).toHaveLength(1)
  const body = JSON.parse(observed.editAndSendRequests[0]!.rawBody!)
  expect(body.branchChatOnEditAndSend).toBe(true)

  const branchOutbox = getGenerationOutboxByRequest(USER_ID, CHAT_ID, body.requestId)
  expect(branchOutbox).not.toBeNull()
  expect(branchOutbox!.branch_chat_id).not.toBe(CHAT_ID)
  expect(branchOutbox!.target_message_id).not.toBe(ASSISTANT_MESSAGE_ID)
  expect(chatRowCount()).toBe(2)
  // The branch-enabled path must not touch the source rows.
  expect(messageRow(USER_MESSAGE_ID)!.content).toBe('Hello')
  expect(messageRow(USER_MESSAGE_ID)!.revision).toBe(1)
  expect(messageRow(ASSISTANT_MESSAGE_ID)!.content).toBe('There')

  expect(observed.preloadRequests.length).toBeGreaterThan(0)
  expect(observed.navigateCalls).toEqual([[`/chat/${branchOutbox!.branch_chat_id}`]])
})
