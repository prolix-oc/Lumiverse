/// <reference types="bun-types" />

import { afterAll, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import { closeDatabase, getDb, initDatabase } from '../../src/db/connection'
import { editAndSend, getChat, getMessage, getMessages } from '../../src/services/chats.service'
import { getGenerationOutboxByRequest } from '../../src/services/edit-and-send-dispatcher.service'

type RestorationInput = {
  type: 'restoration'
  file: string
  requiredContractFragmentMissing: boolean
}

type EditAndSendInput = {
  type: 'edit-and-send'
  branchChatOnEditAndSend: boolean
  sourceStateCanChange: boolean
  branchTargetCanUseSourceMessageId: boolean
  branchNavigationCanBeSkipped: boolean
}

type StreamingRenderInput = {
  type: 'streaming-render'
  isStreaming: boolean
  sameImageSourceIsRecreated: boolean
  resolvedContentTemporarilyRegresses: boolean
  latestContentDoesNotFinalize: boolean
}

type NativePlacementInput = {
  type: 'native-placement'
  suiteEnabled: boolean
  resolvedNativeActionSide: string
}

type BugConditionInput = RestorationInput | EditAndSendInput | StreamingRenderInput | NativePlacementInput

type RestorationResult = {
  type: 'restoration'
  namedContractsAreComplete: boolean
  unrelatedFileContentIsUnchanged: boolean
}

type EditAndSendResult = {
  type: 'edit-and-send'
  branchChatId: string
  sourceChatId: string
  sourceChatAfterEqualsBefore: boolean
  sourceMessagesAfterEqualBefore: boolean
  allBranchMessageTargetsBelongToBranch: boolean
  historicalTargetIsCopiedAssistant: boolean
  navigatedChatId: string | null
}

type StreamingRenderResult = {
  type: 'streaming-render'
  sameSrcImageNodeIsPreserved: boolean
  noTransientUnresolvedReplacement: boolean
  finalRenderEqualsLatestResolvedContent: boolean
}

type NativePlacementResult = {
  type: 'native-placement'
  nativeActionSide: string
  nativeControlsRemainOneGroup: boolean
}

type BugConditionResult = RestorationResult | EditAndSendResult | StreamingRenderResult | NativePlacementResult

function isBugCondition(input: BugConditionInput): boolean {
  switch (input.type) {
    case 'restoration':
      return REQUIRED_RESTORATION_FILES.has(input.file) && input.requiredContractFragmentMissing
    case 'edit-and-send':
      return input.branchChatOnEditAndSend
        && (input.sourceStateCanChange
          || input.branchTargetCanUseSourceMessageId
          || input.branchNavigationCanBeSkipped)
    case 'streaming-render':
      return input.isStreaming
        && (input.sameImageSourceIsRecreated
          || input.resolvedContentTemporarilyRegresses
          || input.latestContentDoesNotFinalize)
    case 'native-placement':
      return !input.suiteEnabled && input.resolvedNativeActionSide !== 'right'
    default:
      return assertNever(input)
  }
}

function expectedBehavior(result: BugConditionResult): boolean {
  switch (result.type) {
    case 'restoration':
      return result.namedContractsAreComplete && result.unrelatedFileContentIsUnchanged
    case 'edit-and-send':
      return result.branchChatId !== result.sourceChatId
        && result.sourceChatAfterEqualsBefore
        && result.sourceMessagesAfterEqualBefore
        && result.allBranchMessageTargetsBelongToBranch
        && result.historicalTargetIsCopiedAssistant
        && result.navigatedChatId === result.branchChatId
    case 'streaming-render':
      return result.sameSrcImageNodeIsPreserved
        && result.noTransientUnresolvedReplacement
        && result.finalRenderEqualsLatestResolvedContent
    case 'native-placement':
      return result.nativeActionSide === 'right' && result.nativeControlsRemainOneGroup
    default:
      return assertNever(result)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected property input: ${JSON.stringify(value)}`)
}

const FRONTEND_ROOT = fileURLToPath(new URL('../', import.meta.url))
const REQUIRED_RESTORATION_FILES = new Set([
  'src/types/store.ts',
  'src/lib/uiProductivityDefaults.ts',
  'src/components/settings/ProductivitySettingsModel.ts',
  'src/components/settings/ProductivitySettings.tsx',
  'src/components/settings/ProductivityFeatureToggles.tsx',
  'src/api/chats.ts',
])

const restorationCases: Array<{
  file: string
  bugWasObserved: boolean
  requiredFragments: RegExp[]
  protectedFragments: RegExp[]
}> = [
  {
    file: 'src/types/store.ts',
    bugWasObserved: true,
    requiredFragments: [/editAndSendSide\?: 'left' \| 'right'/, /branchChatOnEditAndSend\?: boolean/],
    protectedFragments: [/nativeDockActionSide\?: 'left' \| 'right'/, /opaqueToolbarBackdrop\?: boolean/],
  },
  {
    file: 'src/lib/uiProductivityDefaults.ts',
    bugWasObserved: true,
    requiredFragments: [/editAndSendSide: 'right'/, /branchChatOnEditAndSend: true/],
    protectedFragments: [/nativeDockActionSide: 'right'/, /opaqueToolbarBackdrop: false/],
  },
  {
    file: 'src/components/settings/ProductivitySettingsModel.ts',
    bugWasObserved: true,
    requiredFragments: [/'editAndSendSide'/, /'branchChatOnEditAndSend'/],
    protectedFragments: [/'nativeDockActionSide'/, /'opaqueToolbarBackdrop'/],
  },
  {
    file: 'src/components/settings/ProductivitySettings.tsx',
    bugWasObserved: true,
    requiredFragments: [/label="Edit and Send position"/, /label="Branch chat when using Edit and Send"/, /editAndSendSide/, /branchChatOnEditAndSend/],
    protectedFragments: [/label="Native chat-top actions"/, /id="quick-opaque-toolbar-backdrop"/],
  },
  {
    file: 'src/components/settings/ProductivityFeatureToggles.tsx',
    bugWasObserved: false,
    requiredFragments: [/import \{ SETTINGS_TABS \} from '@\/lib\/settings-tab-registry'/],
    protectedFragments: [/PRODUCTIVITY_FEATURE_FLAGS\.filter/, /SUITE_FEATURE_FLAGS/],
  },
  {
    file: 'src/api/chats.ts',
    bugWasObserved: true,
    requiredFragments: [/branchChatOnEditAndSend\?: boolean/],
    protectedFragments: [/return post<EditAndSendResult>\(`\/chats\/\$\{chatId\}\/edit-and-send`, input, options\)/, /immediateAssistantId: string \| null/],
  },
]

for (const entry of restorationCases) {
  test(`Property 1 restoration matrix: ${entry.file}`, async () => {
    const source = await Bun.file(resolve(FRONTEND_ROOT, entry.file)).text()
    const input: RestorationInput = {
      type: 'restoration',
      file: entry.file,
      requiredContractFragmentMissing: entry.bugWasObserved,
    }
    const result: RestorationResult = {
      type: 'restoration',
      namedContractsAreComplete: entry.requiredFragments.every((fragment) => fragment.test(source)),
      unrelatedFileContentIsUnchanged: entry.protectedFragments.every((fragment) => fragment.test(source)),
    }

    if (!entry.bugWasObserved) {
      expect(isBugCondition(input)).toBe(false)
      expect(result.namedContractsAreComplete).toBe(true)
      return
    }

    expect(isBugCondition(input)).toBe(true)
    expect(expectedBehavior(result)).toBe(true)
  })
}

const USER = 'property-user'

function initEditAndSendTestDb(): void {
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
    id TEXT PRIMARY KEY, user_id TEXT, character_id TEXT, name TEXT NOT NULL DEFAULT '', metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`)
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, index_in_chat INTEGER NOT NULL, is_user INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', send_date INTEGER NOT NULL, swipe_id INTEGER NOT NULL DEFAULT 0,
    swipes TEXT NOT NULL DEFAULT '[]', swipe_dates TEXT NOT NULL DEFAULT '[]', extra TEXT NOT NULL DEFAULT '{}',
    parent_message_id TEXT, branch_id TEXT, created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
  )`)
  db.run(`CREATE TABLE chat_memory_cache (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, settings_key TEXT NOT NULL,
    source_message_count INTEGER NOT NULL DEFAULT 0, query_preview TEXT NOT NULL DEFAULT '', chunks_json TEXT NOT NULL DEFAULT '[]',
    formatted TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
    settings_source TEXT NOT NULL DEFAULT 'global', chunks_available INTEGER NOT NULL DEFAULT 0,
    chunks_pending INTEGER NOT NULL DEFAULT 0, retrieval_mode TEXT NOT NULL DEFAULT 'empty', created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, UNIQUE(chat_id, settings_key)
  )`)
  db.run(`CREATE TABLE edit_and_send_requests (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL, branch_chat_id TEXT NOT NULL, edited_message_id TEXT NOT NULL,
    target_message_id TEXT, target_swipe_index INTEGER, generation_id TEXT NOT NULL, response TEXT NOT NULL,
    cursor TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (user_id, chat_id, request_id)
  )`)
  db.run(`CREATE TABLE generation_outbox (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id TEXT NOT NULL, chat_id TEXT NOT NULL,
    branch_chat_id TEXT NOT NULL, edited_message_id TEXT NOT NULL, target_message_id TEXT, target_swipe_index INTEGER,
    expected_version INTEGER NOT NULL, generation_id TEXT NOT NULL UNIQUE, mode TEXT NOT NULL CHECK(mode IN ('normal', 'swipe')),
    status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
    lease_owner TEXT, lease_expires_at INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
    last_error_code TEXT, terminal_reason TEXT, dispatched_at INTEGER, completed_at INTEGER, cancelled_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    -- migrations/111_generation_outbox_connection_id.sql. Hand-written schema
    -- (no migrations run here), so the column is mirrored LAST to match the
    -- ALTER TABLE append order.
    connection_id TEXT,
    frontend_session_id TEXT
  )`)
  db.query('INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)').run('property-char', USER, 'Property')
}

function seedChat(id: string): void {
  getDb().query('INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, USER, 'property-char', 'Property chat', '{}', 1, 1)
}

function seedMessage(id: string, chatId: string, content: string, index: number, isUser: boolean): void {
  getDb().query(`INSERT INTO messages (
    id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra,
    parent_message_id, branch_id, created_at, revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, chatId, index, isUser ? 1 : 0, isUser ? 'User' : 'Assistant', content, 100 + index, 0,
      JSON.stringify([content]), JSON.stringify([100 + index]), '{}', null, null, 100 + index, 1)
}

for (const earlierTurns of [0, 1]) {
  test(`Property 1 branch matrix: historical edit with ${earlierTurns} earlier turn(s)`, async () => {
    initEditAndSendTestDb()
    try {
      const chatId = `property-chat-${earlierTurns}`
      seedChat(chatId)
      let index = 0
      seedMessage(`${chatId}-greeting`, chatId, 'Greeting', index++, false)
      for (let turn = 0; turn < earlierTurns; turn++) {
        seedMessage(`${chatId}-earlier-user-${turn}`, chatId, `Earlier ${turn}`, index++, true)
        seedMessage(`${chatId}-earlier-assistant-${turn}`, chatId, `Earlier reply ${turn}`, index++, false)
      }
      const sourceUserId = `${chatId}-selected-user`
      const sourceAssistantId = `${chatId}-source-assistant`
      seedMessage(sourceUserId, chatId, 'Original selected prompt', index++, true)
      seedMessage(sourceAssistantId, chatId, 'Original assistant answer', index++, false)
      seedMessage(`${chatId}-later-user`, chatId, 'Later prompt', index++, true)
      seedMessage(`${chatId}-later-assistant`, chatId, 'Later answer', index++, false)

      const sourceChatBefore = structuredClone(getChat(USER, chatId))
      const sourceMessagesBefore = structuredClone(getMessages(USER, chatId))
      const serviceSource = await Bun.file(resolve(FRONTEND_ROOT, '../src/services/chats.service.ts')).text()
      const cardSource = await Bun.file(resolve(FRONTEND_ROOT, 'src/hooks/useMessageCard.ts')).text()
      const sourceFallbackPresent = serviceSource.includes('created?.idMap.get(source.id) ?? source.id')
        || serviceSource.includes('created?.idMap.get(subsequentAssistant.id) ?? subsequentAssistant.id')
      const navigationCanBeSkipped = !cardSource.includes('if (branchChatOnEditAndSend) navigate(`/chat/${result.branchChatId}`)')

      const operation = editAndSend(USER, chatId, {
        messageId: sourceUserId,
        content: 'Rewritten selected prompt',
        expectedVersion: 1,
        requestId: `property-request-${earlierTurns}`,
        branchChatOnEditAndSend: true,
      })
      if (operation.status !== 'ok') throw new Error(`Expected edit-and-send success, got ${JSON.stringify(operation)}`)

      const branchChatId = operation.payload.branchChatId
      const sourceChatAfter = getChat(USER, chatId)
      const sourceMessagesAfter = getMessages(USER, chatId)
      const editedCopy = getMessage(USER, operation.payload.editedMessageId)
      const assistantCopy = operation.payload.immediateAssistantId
        ? getMessage(USER, operation.payload.immediateAssistantId)
        : null
      const outbox = getGenerationOutboxByRequest(USER, chatId, `property-request-${earlierTurns}`)

      const input: EditAndSendInput = {
        type: 'edit-and-send',
        branchChatOnEditAndSend: true,
        sourceStateCanChange: true,
        branchTargetCanUseSourceMessageId: sourceFallbackPresent,
        branchNavigationCanBeSkipped: navigationCanBeSkipped,
      }
      const result: EditAndSendResult = {
        type: 'edit-and-send',
        branchChatId,
        sourceChatId: chatId,
        sourceChatAfterEqualsBefore: JSON.stringify(sourceChatAfter) === JSON.stringify(sourceChatBefore),
        sourceMessagesAfterEqualBefore: JSON.stringify(sourceMessagesAfter) === JSON.stringify(sourceMessagesBefore),
        allBranchMessageTargetsBelongToBranch: !sourceFallbackPresent
          && editedCopy?.chat_id === branchChatId
          && assistantCopy?.chat_id === branchChatId,
        historicalTargetIsCopiedAssistant: operation.payload.immediateAssistantId !== sourceAssistantId
          && outbox?.target_message_id === operation.payload.immediateAssistantId,
        navigatedChatId: navigationCanBeSkipped ? null : branchChatId,
      }

      expect(isBugCondition(input)).toBe(true)
      expect(expectedBehavior(result)).toBe(true)
    } finally {
      closeDatabase()
    }
  })
}

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
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Node: domWindow.Node,
  NodeFilter: domWindow.NodeFilter,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLImageElement: domWindow.HTMLImageElement,
  ShadowRoot: domWindow.ShadowRoot,
  Event: domWindow.Event,
  EventTarget: domWindow.EventTarget,
  CustomEvent: domWindow.CustomEvent,
  MouseEvent: domWindow.MouseEvent,
  MutationObserver: domWindow.MutationObserver,
  ResizeObserver: TestResizeObserver,
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
  requestAnimationFrame: (callback: FrameRequestCallback) => domWindow.setTimeout(() => callback(performance.now()), 0),
  cancelAnimationFrame: (id: number) => domWindow.clearTimeout(id),
})
Object.assign(globalThis, {
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
})

test('Property 1 streaming matrix: same-src image survives isolated finalization', async () => {
  const server = await createServer({
    root: FRONTEND_ROOT,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  const host = document.createElement('div')
  document.body.append(host)

  try {
    const module = await server.ssrLoadModule('/src/components/chat/MessageContent.tsx') as {
      IsolatedHtml: (props: { html: string; isStreaming: boolean }) => unknown
    }
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(host)
    const imageSrc = '/api/v1/images/property-stable-image'

    await act(async () => {
      root.render(createElement(module.IsolatedHtml as never, {
        html: `<div><img src="${imageSrc}"><span>resolved chunk one</span></div>`,
        isStreaming: true,
      } as never))
    })
    const islandHost = host.querySelector('[data-lumiverse-html-island]') as HTMLElement
    const initialImage = islandHost.shadowRoot?.querySelector('img') ?? null

    await act(async () => {
      root.render(createElement(module.IsolatedHtml as never, {
        html: `<div><img src="${imageSrc}"><span>latest finalized chunk</span></div>`,
        isStreaming: false,
      } as never))
    })
    const finalImage = islandHost.shadowRoot?.querySelector('img') ?? null
    const input: StreamingRenderInput = {
      type: 'streaming-render',
      isStreaming: true,
      sameImageSourceIsRecreated: true,
      resolvedContentTemporarilyRegresses: false,
      latestContentDoesNotFinalize: false,
    }
    const result: StreamingRenderResult = {
      type: 'streaming-render',
      sameSrcImageNodeIsPreserved: initialImage !== null && finalImage === initialImage,
      noTransientUnresolvedReplacement: true,
      finalRenderEqualsLatestResolvedContent: islandHost.shadowRoot?.textContent?.includes('latest finalized chunk') === true,
    }

    await act(async () => root.unmount())
    expect(isBugCondition(input)).toBe(true)
    expect(expectedBehavior(result)).toBe(true)
  } finally {
    host.remove()
    await server.close()
  }
}, 30_000)

const pendingRegexResults = new Map<string, (value: { result: string; touchedVars: Set<string>; cacheable: boolean }) => void>()
const applyDisplayRegexTiered = mock((content: string) => new Promise<{ result: string; touchedVars: Set<string>; cacheable: boolean }>((resolveResult) => {
  pendingRegexResults.set(content, resolveResult)
}))
const hookStoreState = {
  regexScripts: [{
    id: 'property-regex',
    name: 'Property regex',
    target: ['display'],
    disabled: false,
    scope: 'global',
    scope_id: null,
    find_regex: 'chunk',
    replace_string: 'resolved',
    flags: 'g',
    placement: ['ai_output'],
    min_depth: null,
    max_depth: null,
    trim_strings: [],
    substitute_macros: 'none',
    metadata: {},
    updated_at: 1,
  }],
  activeCharacterId: 'property-char',
  activeGroupCharacterId: null,
  activeChatId: 'property-stream-chat',
  activePersonaId: null,
  messages: [{ id: 'property-stream-message', is_user: false, content: 'chunk one' }],
}
mock.module('@/store', () => ({ useStore: (selector: (state: typeof hookStoreState) => unknown) => selector(hookStoreState) }))
mock.module('@/lib/chatDisplaySettle', () => ({ trackInitialDisplayResolve: <T,>(promise: Promise<T>) => promise }))
mock.module('@/lib/regex/pipeline', () => ({
  applyDisplayRegexTiered,
  canApplyDisplayRegexInWorker: () => true,
}))
mock.module('@/api/macros', () => ({ resolveMacrosBatch: async ({ templates }: { templates: Record<string, string> }) => ({ resolved: templates }) }))
mock.module('@/lib/spindle/display-resolver-registry', () => ({
  isDisplayChatOwned: () => true,
  getDisplayResolverForChat: () => ({
    resolveBody: async ({ content }: { content: string }) => ({ content, cacheable: true }),
    resolveTemplates: async ({ templates }: { templates: Record<string, string> }) => ({ resolved: templates }),
  }),
}))
mock.module('@/api/regex', () => ({ regexApi: { reportPerformance: async () => undefined } }))
mock.module('@/lib/toast', () => ({ toast: { warning: () => undefined } }))
mock.module('@/i18n', () => ({ default: { t: (key: string) => key } }))

test('Property 1 streaming matrix: pending same-message resolutions never expose unresolved content', async () => {
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const {
    resetDisplayRegexCachesForTests,
    useDisplayRegex,
  } = await import('../src/hooks/useDisplayRegex')

  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  function Harness({ content, isStreaming }: { content: string; isStreaming: boolean }) {
    const rendered = useDisplayRegex(content, false, 0, undefined, {
      chatId: 'property-stream-chat',
      messageId: 'property-stream-message',
      role: 'assistant',
    }, isStreaming)
    return createElement('output', null, rendered)
  }
  const readRendered = () => host.textContent ?? ''
  const flushUntilPending = async (content: string) => {
    for (let attempt = 0; attempt < 20 && !pendingRegexResults.has(content); attempt++) {
      await act(async () => {
        await Promise.resolve()
        await new Promise<void>((resolveTimer) => domWindow.setTimeout(resolveTimer, 0))
      })
    }
    if (!pendingRegexResults.has(content)) throw new Error(`Resolver did not start for ${content}`)
  }

  try {
    await act(async () => { root.render(createElement(Harness, { content: 'chunk one', isStreaming: true })) })
    await flushUntilPending('chunk one')
    await act(async () => {
      pendingRegexResults.get('chunk one')?.({ result: 'resolved one', touchedVars: new Set(), cacheable: true })
      await Promise.resolve()
    })

    await act(async () => { root.render(createElement(Harness, { content: 'chunk two', isStreaming: true })) })
    await flushUntilPending('chunk two')
    const pendingStreamingRender = readRendered()
    await act(async () => {
      pendingRegexResults.get('chunk two')?.({ result: 'resolved two', touchedVars: new Set(), cacheable: true })
      await Promise.resolve()
    })

    await act(async () => { root.render(createElement(Harness, { content: 'chunk final', isStreaming: false })) })
    await flushUntilPending('chunk final')
    const pendingFinalRender = readRendered()
    await act(async () => {
      pendingRegexResults.get('chunk final')?.({ result: 'resolved final', touchedVars: new Set(), cacheable: true })
      await Promise.resolve()
    })
    const finalRender = readRendered()
    const noTransientFallback = pendingStreamingRender === 'resolved one' && pendingFinalRender === 'resolved two'
    const input: StreamingRenderInput = {
      type: 'streaming-render',
      isStreaming: true,
      sameImageSourceIsRecreated: false,
      resolvedContentTemporarilyRegresses: !noTransientFallback,
      latestContentDoesNotFinalize: finalRender !== 'resolved final',
    }
    const result: StreamingRenderResult = {
      type: 'streaming-render',
      sameSrcImageNodeIsPreserved: true,
      noTransientUnresolvedReplacement: noTransientFallback,
      finalRenderEqualsLatestResolvedContent: finalRender === 'resolved final',
    }

    expect(isBugCondition(input)).toBe(false)
    expect(expectedBehavior(result)).toBe(true)
  } finally {
    await act(async () => root.unmount())
    host.remove()
    resetDisplayRegexCachesForTests()
    pendingRegexResults.clear()
  }
})

test('Property 1 native-placement matrix: Suite-disabled persisted left resolves right as one group', async () => {
  const source = await Bun.file(resolve(FRONTEND_ROOT, 'src/components/chat/ChatView.tsx')).text()
  const suiteEnabled = false
  const persistedSide = 'left'
  // ChatView now removes the Suite-only data attribute entirely when the
  // extension is unavailable. The core toolbar's CSS default is right-aligned,
  // so model the effective side rather than expecting the old `&&` guard.
  const hasSuiteGuard = /const nativeDockActionSide = suiteExtensionEnabled[\s\S]*?: undefined/.test(source)
  const resolvedNativeActionSide = hasSuiteGuard
    ? (suiteEnabled && persistedSide === 'left' ? 'left' : 'right')
    : persistedSide
  const input: NativePlacementInput = {
    type: 'native-placement',
    suiteEnabled,
    resolvedNativeActionSide,
  }
  const result: NativePlacementResult = {
    type: 'native-placement',
    nativeActionSide: resolvedNativeActionSide,
    nativeControlsRemainOneGroup: (source.match(/<div className=\{styles\.nativeDockActions\}>/g) ?? []).length === 1,
  }

  expect(isBugCondition(input)).toBe(false)
  expect(expectedBehavior(result)).toBe(true)
})

afterAll(() => {
  closeDatabase()
  dom.window.close()
})
