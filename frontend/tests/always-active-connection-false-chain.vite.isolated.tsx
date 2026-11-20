/// <reference types="bun-types" />

/**
 * RUNTIME REGRESSION TESTS — spec task 3.19 of
 * `edit-and-send-generation-401-unauthorized`.
 *
 * "The false-value persistence chain end to end" for the new Productivity
 * setting `editAndSendAlwaysUseActiveConnection` (default `false`).
 *
 * Object-literal tests that seed the store directly to `false` are NOT
 * sufficient evidence for this chain — the sibling spec established that
 * standard and it applies here. One continuous runtime chain is driven instead:
 *
 *   1. The REAL `ProductivitySettings` checkbox
 *      `#quick-edit-and-send-always-active-connection` is clicked in JSDOM
 *      (on, then off) -> REAL `bindProductivitySetting` -> REAL
 *      `useStore.setState` -> REAL `persistKey('quickToolbarSettings', next,
 *      'user-interaction')`.
 *   2. REAL debounced `flushSettingsNow()` -> REAL `PUT /api/v1/settings` ->
 *      REAL `settings.service` -> one real in-memory `bun:sqlite` database.
 *      Both the CANONICAL row and the namespaced compatibility mirror must
 *      physically contain `editAndSendAlwaysUseActiveConnection: false`.
 *   3. A page reload (store reset to shipped defaults) -> REAL `loadSettings()`
 *      -> REAL `migrateProductivitySetting` + `mergeStoredSetting`: the checkbox
 *      renders UNTICKED and the store still holds an explicit `false`, not an
 *      absent key.
 *   4. The REAL backend dispatch-time read then resolves the BOUND profile for
 *      an Edit-and-Send on a chat carrying a live `connection_profile_id`
 *      binding — the same database row the frontend just wrote.
 *
 * The only stub in the chain is the transport seam (a `fetch` that routes the
 * browser's own requests into the real Hono app) plus the `react-router` surface
 * (the sibling's stub, reused by alias). Prompt assembly is stubbed so nothing
 * reaches a provider; connection identity is never stubbed.
 *
 * NO PRODUCTION CODE IS MODIFIED BY THIS FILE, and neither sibling harness file
 * is modified.
 */

import { afterAll, beforeEach, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import { Hono } from 'hono'

import { closeDatabase, getDb, initDatabase } from '../../src/db/connection'
import { chatsRoutes } from '../../src/routes/chats.routes'
import { settingsRoutes } from '../../src/routes/settings.routes'
import * as chatsSvc from '../../src/services/chats.service'
import * as chatBackground from '../../src/services/chat-background.service'
import * as councilProfilesSvc from '../../src/services/council/council-profiles.service'
import * as pool from '../../src/services/generation-pool.service'
import * as generateSvc from '../../src/services/generate.service'
import {
  dispatchEditAndSendRequest,
  resetEditAndSendDispatcherForTests,
  setEditAndSendStartGeneration,
} from '../../src/services/edit-and-send-dispatcher.service'

const USER_ID = 'user-1'
const CHAT_ID = 'chat-1'
const USER_MESSAGE_ID = 'user-1'
const ASSISTANT_MESSAGE_ID = 'asst-1'
const GREETING_MESSAGE_ID = 'greet'
const QUICK_TOOLBAR_KEY = 'quickToolbarSettings'
const QUICK_TOOLBAR_MIRROR_KEY = 'spindle:lumiverse_suite:quick_toolbar:quickToolbarSettings'
const CHECKBOX_ID = '#quick-edit-and-send-always-active-connection'

const ACTIVE_PROFILE = 'chain-active'
const BOUND_PROFILE = 'chain-bound'
const BINDING_MODEL_OVERRIDE = 'binding-model-override'

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

// ── Real backend: in-memory SQLite + the real routes ──────────────────────
function initBackendDb(): void {
  closeDatabase()
  initDatabase(':memory:')
  const db = getDb()

  db.run(`CREATE TABLE characters (
    id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '', scenario TEXT NOT NULL DEFAULT '', first_mes TEXT NOT NULL DEFAULT '',
    mes_example TEXT NOT NULL DEFAULT '', creator TEXT NOT NULL DEFAULT '', creator_notes TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '', post_history_instructions TEXT NOT NULL DEFAULT '', avatar_path TEXT,
    image_id TEXT, tags TEXT NOT NULL DEFAULT '[]', alternate_greetings TEXT NOT NULL DEFAULT '[]',
    extensions TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1
  )`)
  db.run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY, user_id TEXT, character_id TEXT, name TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`)
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, index_in_chat INTEGER NOT NULL, is_user INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', send_date INTEGER NOT NULL,
    swipe_id INTEGER NOT NULL DEFAULT 0, swipes TEXT NOT NULL DEFAULT '[]', swipe_dates TEXT NOT NULL DEFAULT '[]',
    extra TEXT NOT NULL DEFAULT '{}', parent_message_id TEXT, branch_id TEXT, created_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  )`)
  db.run(`CREATE TABLE extensions (
    id TEXT PRIMARY KEY, identifier TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0
  )`)
  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    user_id TEXT, PRIMARY KEY (key, user_id)
  )`)
  db.run(`CREATE TABLE chat_memory_cache (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, settings_key TEXT NOT NULL,
    UNIQUE(chat_id, settings_key)
  )`)
  db.run(`CREATE TABLE edit_and_send_requests (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL, branch_chat_id TEXT NOT NULL, edited_message_id TEXT NOT NULL,
    target_message_id TEXT, target_swipe_index INTEGER, generation_id TEXT NOT NULL, response TEXT NOT NULL,
    cursor TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE (user_id, chat_id, request_id)
  )`)
  db.run(`CREATE TABLE generation_outbox (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id TEXT NOT NULL, chat_id TEXT NOT NULL,
    branch_chat_id TEXT NOT NULL, edited_message_id TEXT NOT NULL, target_message_id TEXT,
    target_swipe_index INTEGER, expected_version INTEGER NOT NULL, generation_id TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL CHECK(mode IN ('normal', 'swipe')),
    status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
    lease_owner TEXT, lease_expires_at INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
    last_error_code TEXT, terminal_reason TEXT, dispatched_at INTEGER, completed_at INTEGER, cancelled_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    -- migrations/111_generation_outbox_connection_id.sql. Hand-written schema
    -- (no migrations run here), so the column is mirrored LAST to match the
    -- ALTER TABLE append order.
    connection_id TEXT
  )`)
  // Needed by the backend half of the chain (boundary 4). Keyless `custom`
  // profiles, so the credential preflight is not what this harness exercises.
  db.run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, api_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '', preset_id TEXT, is_default INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1,
    has_api_key INTEGER NOT NULL DEFAULT 0, user_id TEXT
  )`)
  db.run(`CREATE TABLE secrets (
    key TEXT NOT NULL, encrypted_value TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL,
    user_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, user_id)
  )`)
}

function seedBackendHistory(): void {
  const db = getDb()
  db.query('INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)').run('char1', USER_ID, 'Alpha')
  db.query(
    'INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    CHAT_ID,
    USER_ID,
    'char1',
    'Chat',
    // The live chat-scoped binding whose authority the OFF setting must preserve.
    JSON.stringify({
      temporary: true,
      no_preset: true,
      connection_profile_id: BOUND_PROFILE,
      connection_model: BINDING_MODEL_OVERRIDE,
    }),
    1,
    1,
  )
  const insert = db.query(
    `INSERT INTO messages (
      id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id,
      swipes, swipe_dates, extra, parent_message_id, branch_id, created_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insert.run(GREETING_MESSAGE_ID, CHAT_ID, 0, 0, 'Assistant', 'Hi', 1, 0, JSON.stringify(['Hi']), JSON.stringify([1]), '{}', null, null, 1, 1)
  insert.run(USER_MESSAGE_ID, CHAT_ID, 1, 1, 'User', 'Hello', 2, 0, JSON.stringify(['Hello']), JSON.stringify([2]), '{}', null, null, 2, 2)
  insert.run(ASSISTANT_MESSAGE_ID, CHAT_ID, 2, 0, 'Assistant', 'There', 3, 0, JSON.stringify(['There']), JSON.stringify([3]), '{}', null, null, 3, 1)

  const insertProfile = db.query(
    `INSERT INTO connection_profiles
       (id, name, provider, api_url, model, preset_id, is_default, metadata, created_at, updated_at, has_api_key, user_id)
     VALUES (?, ?, 'custom', 'http://127.0.0.1:1234/v1', ?, NULL, ?, '{}', 1, 1, 0, ?)`,
  )
  insertProfile.run(ACTIVE_PROFILE, ACTIVE_PROFILE, 'model-active', 0, USER_ID)
  insertProfile.run(BOUND_PROFILE, BOUND_PROFILE, 'model-bound', 1, USER_ID)
  // The user's active profile is NOT the bound one, so "which profile resolved"
  // is an observable answer rather than a coincidence.
  db.query(
    `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, 1)
     ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value`,
  ).run('activeProfileId', JSON.stringify(ACTIVE_PROFILE), USER_ID)
}

const backendApp = new Hono()
backendApp.use('*', async (c, next) => {
  ;(c as unknown as { set: (key: string, value: unknown) => void }).set('userId', USER_ID)
  await next()
})
backendApp.route('/settings', settingsRoutes)
backendApp.route('/chats', chatsRoutes)

// ── Transport seam ────────────────────────────────────────────────────────
interface CapturedRequest {
  method: string
  url: string
  rawBody: string | null
}

const captured: CapturedRequest[] = []
const API_PREFIX = '/api/v1'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
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

// ── Vite runtime holding the REAL frontend module graph ───────────────────
interface Runtime {
  server: Awaited<ReturnType<typeof createServer>>
  useStore: any
  ProductivitySettings: any
  defaults: any
  settingsModule: any
  productivityModel: any
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
        // The sibling's stub, reused by alias. Neither sibling file is modified.
        // The stub stays under `frontend/src` because the Vite server rooted at
        // `frontend/` also loads it by `/src/...` path; the alias must resolve to
        // that same absolute file so both routes share one module instance.
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
  const defaultsModule = await server.ssrLoadModule('/src/lib/uiProductivityDefaults.ts')
  const settingsModule = await server.ssrLoadModule('/src/store/slices/settings.ts')
  const productivityModel = await server.ssrLoadModule('/src/components/settings/ProductivitySettingsModel.ts')

  const React = await import('react')
  const { createRoot } = await import('react-dom/client')

  return {
    server,
    useStore: storeModule.useStore,
    ProductivitySettings: productivitySettings.default,
    defaults: defaultsModule,
    settingsModule,
    productivityModel,
    React,
    createRoot,
  }
}

function getRuntime(): Promise<Runtime> {
  runtimePromise ??= createRuntime()
  return runtimePromise
}

const warmRuntime = await getRuntime()

afterAll(async () => {
  if (runtimePromise) {
    const runtime = await runtimePromise.catch(() => null)
    await runtime?.server.close()
  }
  resetEditAndSendDispatcherForTests()
  closeDatabase()
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
      activeChatId: CHAT_ID,
      activeCharacterId: null,
      activeChatMetadata: null,
      characters: [],
      personas: [],
      profiles: [],
      messages: [],
      componentOverrides: {},
      settingsLoaded: true,
      fullSettingsLoaded: true,
      quickToolbarSettings: { ...runtime.defaults.DEFAULT_QUICK_TOOLBAR_SETTINGS },
    })
  })
}

interface RenderHandle {
  host: HTMLElement
  unmount: () => Promise<void>
}

async function renderSettingsPanel(runtime: Runtime): Promise<RenderHandle> {
  const { React, createRoot } = runtime
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await React.act(async () => { root.render(React.createElement(runtime.ProductivitySettings, null) as any) })
  await React.act(async () => { await sleep(60) })
  return {
    host,
    unmount: async () => {
      await React.act(async () => { root.unmount() })
      host.remove()
    },
  }
}

/**
 * Tick the REAL checkbox on and then off, letting the REAL debounced `putMany`
 * flush after each click.
 */
async function tickOnThenOff(runtime: Runtime): Promise<{
  checkedInitially: boolean
  checkedAfterOn: boolean
  storeAfterOn: unknown
  checkedAfterOff: boolean
  storeAfterOff: unknown
  putBodies: string[]
}> {
  const { React, useStore } = runtime
  const handle = await renderSettingsPanel(runtime)
  const read = () => handle.host.querySelector<HTMLInputElement>(CHECKBOX_ID)!
  expect(handle.host.querySelector<HTMLInputElement>(CHECKBOX_ID)).not.toBeNull()

  const checkedInitially = read().checked
  captured.length = 0

  await React.act(async () => { read().click(); await sleep(0) })
  const checkedAfterOn = read().checked
  const storeAfterOn = useStore.getState().quickToolbarSettings.editAndSendAlwaysUseActiveConnection
  await React.act(async () => { await runtime.settingsModule.flushSettingsNow(); await sleep(10) })

  await React.act(async () => { read().click(); await sleep(0) })
  const checkedAfterOff = read().checked
  const storeAfterOff = useStore.getState().quickToolbarSettings.editAndSendAlwaysUseActiveConnection
  await React.act(async () => { await runtime.settingsModule.flushSettingsNow(); await sleep(10) })

  const putBodies = captured
    .filter((entry) => entry.method === 'PUT' && entry.url === '/api/v1/settings')
    .map((entry) => entry.rawBody ?? '')

  await handle.unmount()
  return { checkedInitially, checkedAfterOn, storeAfterOn, checkedAfterOff, storeAfterOff, putBodies }
}

/**
 * Full page-reload simulation: the store returns to its shipped defaults, then
 * the REAL `loadSettings()` rehydrates from the rows the real flush wrote.
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
  await React.act(async () => { await useStore.getState().loadSettings() })
}

/**
 * Run an Edit-and-Send through the real service + real dispatcher and report
 * which connection the REAL dispatch-time read and resolution ladder settled on.
 * The seam delegates to the real `startGeneration`, forwarding the options the
 * dispatcher handed it.
 */
async function editAndSendResolvedConnection(requestId: string): Promise<{
  connectionId: string | undefined
  model: string | undefined
  status: string | undefined
}> {
  const restore: Array<{ mockRestore: () => void }> = []
  const { spyOn } = await import('bun:test')
  restore.push(spyOn(chatBackground, 'abortChatBackground').mockResolvedValue(undefined))
  restore.push(spyOn(councilProfilesSvc, 'resolveProfile').mockImplementation(() => {
    throw new Error('skip-assembly')
  }))

  const observed: Array<{ connectionId: string | undefined; model: string | undefined }> = []
  setEditAndSendStartGeneration(async (input, options) => {
    await generateSvc.startGeneration(input as never, options).catch(() => { /* stubbed assembly */ })
    observed.push({
      connectionId: (input as { connection_id?: string }).connection_id,
      model: pool.getPoolEntry(input.generationId)?.model,
    })
    return { generationId: input.generationId, status: 'streaming' }
  })

  const committed = chatsSvc.editAndSend(USER_ID, CHAT_ID, {
    messageId: USER_MESSAGE_ID,
    content: 'rewritten',
    expectedVersion: 2,
    requestId,
    // In-place, so the binding under test stays on the dispatch target.
    branchChatOnEditAndSend: false,
  })
  expect(committed.status).toBe('ok')
  const row = await dispatchEditAndSendRequest(USER_ID, CHAT_ID, requestId)

  generateSvc.stopAllGenerations()
  pool.clearAllPoolEntries()
  for (const spy of restore) spy.mockRestore()

  return { ...observed[0]!, status: row?.status }
}

beforeEach(async () => {
  initBackendDb()
  seedBackendHistory()
  resetEditAndSendDispatcherForTests()
  captured.length = 0
  try { domWindow.localStorage.clear() } catch { /* storage optional */ }
  document.body.replaceChildren()
  await resetFrontendStore(warmRuntime)
})

// ─────────────────────────────────────────────────────────────────────────
// Boundaries 1 + 2: the real checkbox -> store -> persistKey -> both rows
// ─────────────────────────────────────────────────────────────────────────
test('B1+B2: ticking the real checkbox on then off persists an explicit false to BOTH rows', async () => {
  const runtime = await getRuntime()

  // The static half of the declaration: the control is registered and the
  // shipped default is `false`, so only a stored `true` can enable the override.
  expect(runtime.productivityModel.PRODUCTIVITY_CONTROL_DEFINITIONS.quickToolbarSettings)
    .toContain('editAndSendAlwaysUseActiveConnection')
  expect(runtime.defaults.DEFAULT_QUICK_TOOLBAR_SETTINGS.editAndSendAlwaysUseActiveConnection).toBe(false)
  // `bindProductivitySetting` is a plain spread, so an explicit `false`
  // overwrites rather than being skipped.
  expect(runtime.productivityModel.bindProductivitySetting(
    { ...runtime.defaults.DEFAULT_QUICK_TOOLBAR_SETTINGS, editAndSendAlwaysUseActiveConnection: true },
    { editAndSendAlwaysUseActiveConnection: false },
  ).editAndSendAlwaysUseActiveConnection).toBe(false)

  const result = await tickOnThenOff(runtime)

  // `checked={... === true}`, not `!== false`: a user who has never seen the
  // control sees it UNTICKED.
  expect(result.checkedInitially).toBe(false)
  expect(result.checkedAfterOn).toBe(true)
  expect(result.storeAfterOn).toBe(true)
  expect(result.checkedAfterOff).toBe(false)
  // Not falsy — explicitly the boolean `false`, never `undefined`.
  expect(result.storeAfterOff).toBe(false)

  expect(result.putBodies.length).toBeGreaterThan(0)
  const merged = result.putBodies.reduce<Record<string, any>>(
    (acc, body) => Object.assign(acc, JSON.parse(body)),
    {},
  )
  expect(merged[QUICK_TOOLBAR_KEY].editAndSendAlwaysUseActiveConnection).toBe(false)
  expect(merged[QUICK_TOOLBAR_MIRROR_KEY].editAndSendAlwaysUseActiveConnection).toBe(false)

  // The canonical row and the namespaced mirror must PHYSICALLY contain the key.
  // An omitted property is indistinguishable from "never set".
  const canonical = readSettingRow(QUICK_TOOLBAR_KEY) as Record<string, unknown>
  const mirror = readSettingRow(QUICK_TOOLBAR_MIRROR_KEY) as Record<string, unknown>
  expect(Object.prototype.hasOwnProperty.call(canonical, 'editAndSendAlwaysUseActiveConnection')).toBe(true)
  expect(canonical.editAndSendAlwaysUseActiveConnection).toBe(false)
  expect(Object.prototype.hasOwnProperty.call(mirror, 'editAndSendAlwaysUseActiveConnection')).toBe(true)
  expect(mirror.editAndSendAlwaysUseActiveConnection).toBe(false)

  // Every other member survives the round trip, `branchChatOnEditAndSend`
  // included — it must still be `true`.
  expect(canonical.branchChatOnEditAndSend).toBe(true)
  expect(canonical.editAndSendSide).toBe('right')
  expect(canonical.nativeDockActionSide).toBe('right')
  expect(canonical.enabled).toBe(true)
})

// ─────────────────────────────────────────────────────────────────────────
// Boundary 3: reload -> unticked checkbox, explicit false still in the store
// ─────────────────────────────────────────────────────────────────────────
test('B3: after a reload the checkbox renders unticked and the store holds an explicit false', async () => {
  const runtime = await getRuntime()
  await tickOnThenOff(runtime)
  await simulateReload(runtime)

  const quick = runtime.useStore.getState().quickToolbarSettings
  expect(Object.prototype.hasOwnProperty.call(quick, 'editAndSendAlwaysUseActiveConnection')).toBe(true)
  expect(quick.editAndSendAlwaysUseActiveConnection).toBe(false)
  // The sibling's setting keeps its `true` default and every other member is
  // backfilled as before.
  expect(quick.branchChatOnEditAndSend).toBe(true)
  expect(quick.editAndSendSide).toBe('right')
  expect(quick.nativeDockActionSide).toBe('right')
  expect(runtime.useStore.getState().fullSettingsLoaded).toBe(true)

  const handle = await renderSettingsPanel(runtime)
  expect(handle.host.querySelector<HTMLInputElement>(CHECKBOX_ID)!.checked).toBe(false)
  // The sibling checkbox is still ticked: the two settings are independent.
  expect(handle.host.querySelector<HTMLInputElement>('#quick-branch-edit-and-send')!.checked).toBe(true)
  await handle.unmount()
})

// ─────────────────────────────────────────────────────────────────────────
// Boundary 4: the backend dispatch-time read of that same persisted false
// ─────────────────────────────────────────────────────────────────────────
test('B4: with the persisted false, Edit-and-Send on a pinned chat resolves the BOUND profile', async () => {
  const runtime = await getRuntime()
  await tickOnThenOff(runtime)
  await simulateReload(runtime)

  const resolved = await editAndSendResolvedConnection('chain-off-request')
  expect(resolved).toEqual({
    connectionId: BOUND_PROFILE,
    model: BINDING_MODEL_OVERRIDE,
    status: 'running',
  })
})

test('B4 control: with a persisted true, the same chat resolves the ACTIVE profile instead', async () => {
  // The other half of the evidence: the OFF result above is a consequence of the
  // stored `false`, not of the harness being unable to override a binding.
  const runtime = await getRuntime()
  const handle = await renderSettingsPanel(runtime)
  await runtime.React.act(async () => {
    handle.host.querySelector<HTMLInputElement>(CHECKBOX_ID)!.click()
    await sleep(0)
  })
  await runtime.React.act(async () => {
    await runtime.settingsModule.flushSettingsNow()
    await sleep(10)
  })
  await handle.unmount()
  expect((readSettingRow(QUICK_TOOLBAR_KEY) as Record<string, unknown>).editAndSendAlwaysUseActiveConnection).toBe(true)

  const resolved = await editAndSendResolvedConnection('chain-on-request')
  expect(resolved).toEqual({
    connectionId: ACTIVE_PROFILE,
    model: 'model-active',
    status: 'running',
  })
})
