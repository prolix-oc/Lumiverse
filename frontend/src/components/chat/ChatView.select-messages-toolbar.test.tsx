import { afterAll, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type Plugin } from 'vite'
import { isShowNativeSelectMessages } from '../quick-toolbar/quickToolbarDock'
import { quickToolbarOwnsOldestMessage } from './chatNativeDockOwnership'

const FRONTEND_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const VIRTUAL_PREFIX = '\0chat-view-placement-test:'

const childStub = (testId: string) => `
  import { createElement } from 'react'
  export default function Stub() {
    return createElement('div', { 'data-testid': '${testId}' })
  }
`

const moduleSources: Record<string, string> = {
  '@/store': `
    const readState = () => globalThis.__CHAT_VIEW_PLACEMENT_TEST_STATE__
    export const useStore = Object.assign(
      (selector) => selector(readState()),
      {
        getState: readState,
        setState: (patch) => Object.assign(readState(), patch),
        subscribe: () => () => undefined,
      },
    )
  `,
  'react-i18next': `
    export const useTranslation = () => ({ t: (key) => key })
  `,
  'react-router': `
    export const useNavigate = () => () => undefined
    export const useParams = () => ({ chatId: 'chat-test' })
  `,
  '@/router': `export const router = { navigate: () => undefined }`,
  '@/lib/toast': `export const toast = { error() {}, success() {}, info() {} }`,
  '@/api/chats': `export const chatsApi = {}; export const messagesApi = {}`,
  '@/api/memory-cortex': `export const memoryCortexApi = {}`,
  '@/api/generate': `export const generateApi = {}`,
  '@/api/loadouts': `export const loadoutsApi = {}`,
  '@/lib/generation-recovery': `export const recoverPooledGeneration = () => undefined`,
  '@/api/characters': `export const charactersApi = {}`,
  '@/api/packs': `export const packsApi = {}`,
  '@/api/expressions': `export const expressionsApi = {}`,
  '@/store/slices/personas': `export const personaToastName = () => ''`,
  '@/lib/chatPersonaSelection': `
    export const CHAT_PERSONA_METADATA_KEY = 'persona'
    export const resolveChatPersonaSelection = () => null
    export const setPersistedChatPersonaId = () => undefined
  `,
  '@/components/shared/WallpaperLayer': childStub('wallpaper-layer'),
  '@/hooks/useSwipeKeyboard': `export default function useSwipeKeyboard() {}`,
  '@/hooks/useEditKeyboard': `export default function useEditKeyboard() {}`,
  '@/hooks/useIsMobile': `export default function useIsMobile() { return false }`,
  '@/hooks/useCouncilProfiles': `export const resolveCouncilForChat = async () => null`,
  '@/lib/chatDisplaySettle': `
    export const CHAT_REVEAL_SETTLE_CAP_MS = 0
    export const getChatDisplaySettleDiagnostics = () => ({})
  `,
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
  '../quick-toolbar/QuickToolbar': `
    import { createElement } from 'react'
    export function QuickToolbar() {
      return createElement(
        'div',
        { 'data-testid': 'quick-toolbar' },
        createElement('button', { type: 'button', 'data-toolbar-action': 'chat.scroll-to-top' }, 'QuickToolbar oldest'),
      )
    }
  `,
  './chatDockerActionCatalog': `export const registerChatDockerActionOwners = () => () => undefined`,
  '@/ws/client': `export const wsClient = { on: () => () => undefined }`,
  '@/ws/events': `export const EventType = {}`,
  '@/lib/landingPageSnapshot': `export const markLandingPageChatReturn = () => undefined; export const peekLandingPageSnapshot = () => null`,
  '@/lib/imageDecodeCache': `export const holdImagesForTransition = () => undefined`,
  '@/lib/chatNavigationSnapshot': `export const takeChatNavigationSnapshot = () => null`,
}

const aliasedModuleSources = Object.keys(moduleSources)
  .filter((source) => source.startsWith('@/'))
  .map((source) => ({
    source,
    resolved: resolve(FRONTEND_ROOT, 'src', source.slice(2)).replaceAll('\\', '/').toLowerCase(),
  }))

function mockedSourceKey(source: string): string | null {
  if (source in moduleSources) return source
  const normalized = source.replaceAll('\\', '/').replace(/^\/@fs\//, '').toLowerCase()
  return aliasedModuleSources.find(({ resolved }) => (
    normalized === resolved
    || normalized === `${resolved}.ts`
    || normalized === `${resolved}.tsx`
    || normalized === `${resolved}/index.ts`
    || normalized === `${resolved}/index.tsx`
  ))?.source ?? null
}

const placementMocks: Plugin = {
  name: 'chat-view-placement-test-mocks',
  enforce: 'pre',
  resolveId(source) {
    const mocked = mockedSourceKey(source)
    return mocked ? `${VIRTUAL_PREFIX}${mocked}` : null
  },
  load(id) {
    return id.startsWith(VIRTUAL_PREFIX) ? moduleSources[id.slice(VIRTUAL_PREFIX.length)] : null
  },
}

const server = await createServer({
  root: FRONTEND_ROOT,
  configFile: false,
  appType: 'custom',
  logLevel: 'silent',
  plugins: [placementMocks],
  resolve: { alias: { '@': resolve(FRONTEND_ROOT, 'src') } },
  ssr: { noExternal: ['react-i18next', 'react-router'] },
  server: { middlewareMode: true },
})
const { default: ChatView } = await server.ssrLoadModule('/src/components/chat/ChatView.tsx') as {
  default: () => unknown
}

type PersistedSide = 'left' | 'right' | undefined | 'legacy-left'
type Visibility = {
  select: boolean
  oldest: boolean
  browse: boolean
}

const persistedSides: Array<{ name: string; value: PersistedSide }> = [
  { name: 'left', value: 'left' },
  { name: 'right', value: 'right' },
  { name: 'absent', value: undefined },
  { name: 'invalid legacy', value: 'legacy-left' },
]
const visibilityMatrix: Visibility[] = []
for (const select of [false, true]) {
  for (const oldest of [false, true]) {
    for (const browse of [false, true]) visibilityMatrix.push({ select, oldest, browse })
  }
}

function createState(
  suiteEnabled: boolean,
  persistedSide: PersistedSide,
  visibility: Visibility,
  quickToolbarOwnsOldest = false,
): Record<string, unknown> {
  const quickToolbarSettings: Record<string, unknown> = {
    quickToolbarPlacement: 'chat_top_dock',
    enabled: true,
    visibleTabIds: quickToolbarOwnsOldest ? ['chat.scroll-to-top'] : [],
    showNativeSelectMessages: visibility.select,
    showNativeScrollToTop: visibility.oldest,
    showNativeBrowseMessages: visibility.browse,
  }
  if (persistedSide !== undefined) quickToolbarSettings.nativeDockActionSide = persistedSide

  return {
    setActiveChat: () => undefined,
    setMessages: () => undefined,
    messages: [],
    agentActivityRunsByGeneration: {},
    agentRunProvisionalByKey: {},
    agentRunTerminalByTarget: {},
    agentRunSyncByChat: {},
    chatHeads: [],
    activeGenerationId: null,
    isStreaming: false,
    activeChatId: 'chat-test',
    messageEditDraft: null,
    resumeMessageEdit: () => undefined,
    totalChatLength: 3,
    portraitPanelOpen: false,
    togglePortraitPanel: () => undefined,
    portraitPanelSide: 'none',
    extensions: suiteEnabled
      ? [{ id: 'suite-test', identifier: 'lumiverse_suite', enabled: true, has_frontend: true }]
      : [],
    quickToolbarSettings,
    sceneBackground: null,
    imageGeneration: {},
    wallpaper: { global: null },
    useCharacterBackground: false,
    chatWidthMode: 'full',
    chatContentMaxWidth: 1200,
    messageSelectMode: false,
    setMessageSelectMode: () => undefined,
    activeModal: null,
    commandPaletteOpen: false,
    clearGroupChat: () => undefined,
    activeChatWallpaper: null,
    activeCharacterId: null,
    characters: [],
    activeChatMetadata: null,
    bubbleDisableHover: false,
    bubbleHideAvatarBg: false,
    bubbleOpacity: 1,
  }
}

function renderChatView(state: Record<string, unknown>): Document {
  ;(globalThis as typeof globalThis & { __CHAT_VIEW_PLACEMENT_TEST_STATE__: Record<string, unknown> })
    .__CHAT_VIEW_PLACEMENT_TEST_STATE__ = state
  const markup = renderToStaticMarkup(createElement(ChatView as never))
  return new JSDOM(`<!doctype html><html><body>${markup}</body></html>`).window.document
}

function nativeLabels(group: Element): string[] {
  return Array.from(group.querySelectorAll('button')).map((button) => button.getAttribute('aria-label') ?? '')
}

function expectCompleteToolbarAttributes(toolbar: Element, expectedSide: 'left' | 'right'): void {
  expect(toolbar.getAttribute('data-spindle-mount')).toBe('chat_top_dock')
  expect(toolbar.getAttribute('data-spindle-scope')).toBe('chat:chat-test:top-dock')
  expect(toolbar.getAttribute('data-dock-request')).toBe('strip')
  expect(toolbar.getAttribute('data-native-action-side')).toBe(expectedSide)
  expect(toolbar.hasAttribute('data-native-dock-side')).toBe(false)
}

describe('ChatView native select-messages toolbar', () => {
  test('isShowNativeSelectMessages stays on unless explicitly false', () => {
    expect(isShowNativeSelectMessages(undefined)).toBe(true)
    expect(isShowNativeSelectMessages({})).toBe(true)
    expect(isShowNativeSelectMessages({ showNativeSelectMessages: true })).toBe(true)
    expect(isShowNativeSelectMessages({ showNativeSelectMessages: false })).toBe(false)
  })

  test('ChatView restores native controls without mounting the Suite toolbar', async () => {
    const source = await Bun.file(resolve(import.meta.dir, 'ChatView.tsx')).text()

    expect(source).toContain("import { hasEnabledFrontendExtension } from '@/lib/spindle/frontend-extension-availability'")
    expect(source).toContain("const suiteExtensionEnabled = useStore((s) => hasEnabledFrontendExtension(s.extensions, 'lumiverse_suite'))")
    expect(source).toContain('ListChecks')
    // Settings exposes the native flags with and without the Suite, so an absent
    // Suite no longer has to force them on for them to stay reachable.
    expect(source).toContain('const showNativeSelectMessages = isShowNativeSelectMessages(quickToolbarSettings)')
    expect(source).toContain('const showNativeScrollToTop = isShowNativeScrollToTop(quickToolbarSettings)')
    expect(source).toContain('const showNativeBrowseMessages = isShowNativeBrowseMessages(quickToolbarSettings)')
    expect(source).toContain("const dockQuickToolbar = suiteExtensionEnabled && quickToolbarPlacement === 'chat_top_dock'")
    expect(source).toContain('{dockQuickToolbar && <QuickToolbar />}')
    // The native group owns the top strip unconditionally now. The old hidden=
    // gate is what let the oldest-message action end up with no owner at all.
    expect(source).not.toContain('hidden={suiteExtensionEnabled && !(dockQuickToolbar || keepFloatingDockHost)}')
    expect(source).toMatch(/aria-pressed=\{messageSelectMode\}/)
    expect(source).toMatch(/\{messageSelectMode && <MessageSelectBar chatId=\{chatId\} \/>\}/)

    const nativeButton = source.match(
      /\{showNativeSelectMessages && \([\s\S]*?<ListChecks size=\{14\} \/>[\s\S]*?<\/button>\s*\)\}/,
    )?.[0] ?? ''
    expect(nativeButton).toContain('aria-pressed={messageSelectMode}')
    expect(nativeButton).toContain('ListChecks')
    expect(nativeButton).not.toContain('MessageSelectBar')

    const selectBarIndex = source.indexOf('{messageSelectMode && <MessageSelectBar chatId={chatId} />}')
    const gateIndex = source.indexOf('{showNativeSelectMessages && (')
    expect(selectBarIndex).toBeGreaterThan(gateIndex)
    expect(source.slice(gateIndex, selectBarIndex)).toContain('</button>')
  })

  test('elects exactly one oldest-message owner and restores native ownership by default', () => {
    expect(quickToolbarOwnsOldestMessage(false, {
      enabled: true,
      visibleTabIds: ['chat.scroll-to-top'],
    })).toBe(false)
    expect(quickToolbarOwnsOldestMessage(true, undefined)).toBe(false)
    expect(quickToolbarOwnsOldestMessage(true, {
      enabled: false,
      visibleTabIds: ['chat.scroll-to-top'],
    })).toBe(false)
    expect(quickToolbarOwnsOldestMessage(true, {
      enabled: true,
      visibleTabIds: ['chat.scroll-to-top'],
    })).toBe(true)
  })

  test('renders the Suite availability, persisted side, and independent native visibility matrix', () => {
    for (const suiteEnabled of [false, true]) {
      for (const persistedSide of persistedSides) {
        for (const visibility of visibilityMatrix) {
          const document = renderChatView(createState(suiteEnabled, persistedSide.value, visibility))
          const toolbar = document.querySelector<HTMLElement>('[data-spindle-mount="chat_top_dock"]')
          expect(toolbar).not.toBeNull()

          const expectedSide = suiteEnabled && persistedSide.value === 'left' ? 'left' : 'right'
          expectCompleteToolbarAttributes(toolbar!, expectedSide)

          const nativeGroups = document.querySelectorAll('div[class*="nativeDockActions"]')
          expect(nativeGroups.length).toBe(1)
          const nativeGroup = nativeGroups[0]
          expect(nativeGroup.parentElement).toBe(toolbar)

          const expectedLabels = [
            visibility.select && 'chatView.selectMessages',
            visibility.oldest && 'scrollToTop',
            visibility.browse && 'messageNavigator.open',
          ].filter((label): label is string => Boolean(label))
          expect(nativeLabels(nativeGroup)).toEqual(expectedLabels)

          const select = nativeGroup.querySelector('[aria-label="chatView.selectMessages"]')
          expect(Boolean(select)).toBe(visibility.select)
          if (select) {
            expect(select.getAttribute('title')).toBe('chatView.selectMessages')
            expect(select.getAttribute('aria-pressed')).toBe('false')
          }

          const oldest = nativeGroup.querySelector('[aria-label="scrollToTop"]')
          expect(Boolean(oldest)).toBe(visibility.oldest)
          if (oldest) {
            expect(oldest.getAttribute('title')).toBe('scrollToTop')
            expect(oldest.getAttribute('data-toolbar-action')).toBe('chat.scroll-to-top')
            expect(oldest.hasAttribute('disabled')).toBe(false)
          }

          const browse = nativeGroup.querySelector('[aria-label="messageNavigator.open"]')
          expect(Boolean(browse)).toBe(visibility.browse)
          if (browse) expect(browse.getAttribute('title')).toBe('messageNavigator.open')

          const quickToolbar = toolbar!.querySelector(':scope > [data-testid="quick-toolbar"]')
          expect(Boolean(quickToolbar)).toBe(suiteEnabled)
          expect(Array.from(toolbar!.children)).toEqual(
            suiteEnabled ? [nativeGroup, quickToolbar] : [nativeGroup],
          )
        }
      }
    }
  })

  test('renders exactly one oldest-message action and preserves native/QuickToolbar ordering', () => {
    const allVisible = { select: true, oldest: true, browse: true }
    for (const suiteEnabled of [false, true]) {
      for (const persistedSide of persistedSides) {
        const document = renderChatView(createState(suiteEnabled, persistedSide.value, allVisible, true))
        const toolbar = document.querySelector('[data-spindle-mount="chat_top_dock"]')!
        const nativeGroup = document.querySelector('div[class*="nativeDockActions"]')!
        const quickToolbar = toolbar.querySelector(':scope > [data-testid="quick-toolbar"]')
        const nativeOldest = nativeGroup.querySelectorAll('[data-toolbar-action="chat.scroll-to-top"]')
        const toolbarOldest = quickToolbar?.querySelectorAll('[data-toolbar-action="chat.scroll-to-top"]') ?? []

        expect(nativeLabels(nativeGroup)).toEqual(
          suiteEnabled
            ? ['chatView.selectMessages', 'messageNavigator.open']
            : ['chatView.selectMessages', 'scrollToTop', 'messageNavigator.open'],
        )
        expect(nativeOldest.length).toBe(suiteEnabled ? 0 : 1)
        expect(toolbarOldest.length).toBe(suiteEnabled ? 1 : 0)
        expect(nativeOldest.length + toolbarOldest.length).toBe(1)
        expect(Array.from(toolbar.children)).toEqual(
          suiteEnabled ? [nativeGroup, quickToolbar] : [nativeGroup],
        )
      }
    }
  })

  test('InputArea removes the Suite connection picker and gear when the Suite is unavailable', async () => {
    const source = await Bun.file(resolve(import.meta.dir, 'InputArea.tsx')).text()

    expect(source).toContain("const hasLumiverseSuite = useStore((state) => hasEnabledFrontendExtension(state.extensions, 'lumiverse_suite'))")
    expect(source).toMatch(/connectionsPicker:\s*hasLumiverseSuite\s*\?\s*\(\(\)\s*=>/)
    expect(source).toContain('enableReorder={hasLumiverseSuite && enableToolbarIconReorder}')
    expect(source).toMatch(/\{hasLumiverseSuite && showComposerCustomizeGear && \(/)
    expect(source).toMatch(/\{hasLumiverseSuite && customizeOpen && \(/)
  })
})

afterAll(async () => {
  delete (globalThis as typeof globalThis & { __CHAT_VIEW_PLACEMENT_TEST_STATE__?: Record<string, unknown> })
    .__CHAT_VIEW_PLACEMENT_TEST_STATE__
  await server.close()
})
