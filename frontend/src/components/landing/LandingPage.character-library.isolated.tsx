import { afterEach, beforeAll, describe, expect, jest, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, forwardRef, useSyncExternalStore, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import landing from '../../i18n/locales/en/landing.json'
import panels from '../../i18n/locales/en/panels.json'
import common from '../../i18n/locales/en/shared.json'

let createRoot: typeof CreateRoot
let LandingPage: () => ReactNode

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis
const syncRequestAnimationFrame = (callback: FrameRequestCallback) => {
  callback(0)
  return 0
}
const syncCancelAnimationFrame = (_handle: number) => {}
Object.assign(domWindow, {
  requestAnimationFrame: syncRequestAnimationFrame,
  cancelAnimationFrame: syncCancelAnimationFrame,
})

Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  DOMRect: domWindow.DOMRect,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })

if (!domWindow.PointerEvent) {
  class TestPointerEvent extends domWindow.MouseEvent {}
  Object.assign(domWindow, { PointerEvent: TestPointerEvent })
  Object.assign(globalThis, { PointerEvent: TestPointerEvent })
}

if (!globalThis.ResizeObserver) {
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: TestResizeObserver })
}

if (!domWindow.HTMLElement.prototype.scrollIntoView) {
  domWindow.HTMLElement.prototype.scrollIntoView = () => {}
}

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Summary = {
  id: string
  name: string
  creator: string
  folder: string
  tags: string[]
  image_id: string | null
  created_at: number
  updated_at: number
  has_alternate_greetings: boolean
  library_scope: 'mine' | 'shared'
}

type SummaryPage = { data: Summary[]; total: number }
type MockFn = ReturnType<typeof jest.fn>

type StoreState = {
  landingPageActiveTab?: unknown
  landingPageChatsDisplayed: number
  landingPageLayoutMode: 'cards' | 'compact'
  landingPageGalleryWidth: 'compact' | 'expanded'
  homepageCharacterLibrarySettings: Record<string, unknown>
  favorites: string[]
  landingHiddenCharacterIds: string[]
  settingsLoaded: boolean
  activeChatId: string | null
  openModal: MockFn
  openSettings: MockFn
  toggleFavorite: MockFn
  setEditingCharacterId: MockFn
  setSetting: MockFn
  logout: MockFn
  user: { id: string; username: string } | null
  extensions: Array<{ id: string; identifier: string; enabled: boolean; has_frontend: boolean }>
  wallpaper: { global?: { image_id?: string | null } }
  profiles: Array<{ id: string; is_default?: boolean; name: string }>
  activeProfileId: string | null
  activeLoomPresetId: string | null
  loomRegistry: Record<string, { name: string }>
  characters: Array<{ id: string; image_id?: string | null }>
  landingRecentChats: null
  setLandingRecentChats: MockFn
  updateCharacter: MockFn
  addCharacter: MockFn
}

const listSummaries = jest.fn()
const listTags = jest.fn()
const getHomepagePreview = jest.fn()
const listRecentGrouped = jest.fn()
const deleteTemporary = jest.fn()
const deleteChat = jest.fn()
const deleteCharacterChats = jest.fn()
const patchMetadata = jest.fn()
const createTemporary = jest.fn()
const createChat = jest.fn()
const branchChat = jest.fn()
const listMessages = jest.fn()
const navigate = jest.fn()

let storeState: StoreState

function defaultHomepageSettings(enabled = true): Record<string, unknown> {
  return {
    enabled,
    thumbnailWidth: 220,
    thumbnailHeight: 280,
    density: 'balanced',
    footerMode: 'balanced',
    visibleMetadata: ['creator', 'tags'],
    tagRows: 1,
    viewMode: 'grid',
    defaultSort: 'recent',
    defaultFilter: 'characters',
    maxVisibleTags: 6,
    showNameBackground: false,
    panelWidth: 420,
    panelImageHeight: 320,
    panelPinned: false,
    lastSelectedCharacterId: null,
  }
}

const storeListeners = new Set<() => void>()

function notifyStore() {
  for (const listener of storeListeners) listener()
}

function createStoreState(landingPageActiveTab: unknown = 'characters', enabled = true): StoreState {
  const setSetting = jest.fn((key: string, value: unknown) => {
    if (key === 'landingPageActiveTab') {
      storeState = { ...storeState, landingPageActiveTab: value }
    }
    if (key === 'landingPageGalleryWidth') {
      storeState = { ...storeState, landingPageGalleryWidth: value as 'compact' | 'expanded' }
    }
    if (key === 'homepageCharacterLibrarySettings' && value && typeof value === 'object') {
      storeState = {
        ...storeState,
        homepageCharacterLibrarySettings: value as Record<string, unknown>,
      }
    }
    notifyStore()
  })
  return {
    landingPageActiveTab,
    landingPageChatsDisplayed: 12,
    landingPageLayoutMode: 'cards',
    landingPageGalleryWidth: 'compact',
    homepageCharacterLibrarySettings: defaultHomepageSettings(enabled),
    favorites: [],
    landingHiddenCharacterIds: [],
    settingsLoaded: true,
    activeChatId: null,
    openModal: jest.fn(),
    openSettings: jest.fn(),
    toggleFavorite: jest.fn(),
    setEditingCharacterId: jest.fn(),
    setSetting,
    logout: jest.fn(),
    user: { id: 'test-user-id', username: 'test-user' },
    extensions: [{ id: 'suite-id', identifier: 'lumiverse_suite', enabled: true, has_frontend: true }],
    wallpaper: { global: null },
    profiles: [],
    activeProfileId: null,
    activeLoomPresetId: null,
    loomRegistry: {},
    characters: [],
    landingRecentChats: null,
    setLandingRecentChats: jest.fn(),
    updateCharacter: jest.fn(),
    addCharacter: jest.fn(),
  }
}

const useStore = Object.assign(
  (selector: (state: StoreState) => unknown) => selector(useSyncExternalStore(
    (listener) => {
      storeListeners.add(listener)
      return () => { storeListeners.delete(listener) }
    },
    () => storeState,
    () => storeState,
  )),
  { getState: () => storeState },
)

mock.module('@/store', () => ({ useStore }))
mock.module('react-router', () => ({ useNavigate: () => navigate }))
mock.module('@/api/characters', () => ({
  charactersApi: {
    listSummaries,
    listTags,
    getHomepagePreview,
  },
}))
mock.module('@/api/chats', () => ({
  chatsApi: {
    listRecentGrouped,
    deleteTemporary,
    delete: deleteChat,
    deleteCharacterChats,
    patchMetadata,
    createTemporary,
    create: createChat,
    branch: branchChat,
  },
  messagesApi: { list: listMessages },
}))
mock.module('@/api/images', () => ({ imagesApi: { largeUrl: (id: string) => `/images/${id}` } }))
mock.module('@/ws/client', () => ({ wsClient: { on: jest.fn(() => () => {}) } }))
mock.module('@/ws/events', () => ({ EventType: { CHAT_DELETED: 'chat-deleted' } }))
mock.module('@/hooks/useScrollGate', () => ({ useScrollGate: jest.fn() }))
mock.module('@/hooks/useCharacterTheme', () => ({ warmCharacterPalette: jest.fn() }))
mock.module('@/hooks/useLongPress', () => ({ useLongPress: () => ({}) }))
mock.module('@/lib/imageDecodeCache', () => ({
  holdImagesForTransition: jest.fn(),
  prefetchImages: jest.fn(),
}))
mock.module('@/lib/uiScale', () => ({
  measureLayoutHeight: () => 0,
  renderedPxToLayoutPx: (value: number) => value,
}))
mock.module('@/lib/avatarUrls', () => ({
  getCharacterAvatarLargeUrlById: () => '/avatar.png',
  getCharacterAvatarThumbUrlById: () => '/avatar-thumb.png',
}))
mock.module('@/lib/formatRelativeTime', () => ({ formatRelativeTime: () => 'just now' }))
mock.module('@/lib/tagColors', () => ({ getTagColorVar: () => '128,128,128' }))
mock.module('@/lib/uiProductivityDefaults', () => ({
  PRODUCTIVITY_DEFAULTS: { homepageCharacterLibrarySettings: defaultHomepageSettings(true) },
}))
mock.module('@/lib/deviceRotation', () => ({
  doesDeviceRotationNeedPermission: () => false,
  isDeviceRotationSupported: () => false,
  requestDeviceRotationPermission: async () => ({ state: 'denied' }),
  subscribeDeviceRotation: () => () => {},
}))
mock.module('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

mock.module('@/components/shared/Spinner', () => ({
  Spinner: () => <span role="status" aria-label="Loading" />,
}))
mock.module('@/components/shared/ContextMenu', () => ({ default: () => null }))
mock.module('@/components/shared/SearchField', () => ({
  default: ({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) => (
    <input aria-label={placeholder} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}))
mock.module('@/components/shared/SortControl', () => ({
  SortControl: ({ title, value }: { title: string; value: string }) => (
    <button type="button" aria-label={title}>{value}</button>
  ),
}))
mock.module('@/components/shared/LazyImage', () => ({
  default: ({ src, alt, fallback }: { src: string; alt: string; fallback?: ReactNode }) => src ? <img src={src} alt={alt} /> : fallback ?? null,
}))
mock.module('@/components/shared/FormComponents', () => ({
  Button: ({ children, onClick, disabled, title, className }: { children?: ReactNode; onClick?: () => void; disabled?: boolean; title?: string; className?: string }) => (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={className}>{children}</button>
  ),
}))

const Icon = () => null
mock.module('lucide-react', () => ({
  MessageSquarePlus: Icon,
  MessageSquare: Icon,
  Trash2: Icon,
  Users: Icon,
  LogOut: Icon,
  FlaskConical: Icon,
  Gamepad2: Icon,
  Compass: Icon,
  EyeOff: Icon,
  Star: Icon,
  Pencil: Icon,
  Copy: Icon,
  GitBranch: Icon,
  Maximize2: Icon,
  Minimize2: Icon,
  BookOpen: Icon,
  Edit3: Icon,
  Pin: Icon,
  PinOff: Icon,
  Search: Icon,
  Settings: Icon,
  X: Icon,
  ArrowLeft: Icon,
}))

const MotionDiv = forwardRef<HTMLDivElement, Record<string, any>>((props, ref) => {
  const { initial: _initial, animate: _animate, exit: _exit, variants: _variants, transition: _transition, ...domProps } = props
  return <div ref={ref} {...domProps} />
})
mock.module('motion/react', () => ({
  motion: { div: MotionDiv },
  AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))

mock.module('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => count > 0 ? [{ index: 0, key: 'row-0', start: 0, end: 100, size: 100, lane: 0 }] : [],
    getTotalSize: () => count * 100,
    measure: jest.fn(),
    containerRef: jest.fn(),
    measureElement: jest.fn(),
  }),
}))
mock.module('./LandingPage.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))
mock.module('./HomepageCharacterLibrary.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

const TestObserverInstances: TestIntersectionObserver[] = []
class TestIntersectionObserver {
  private disconnected = false
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    TestObserverInstances.push(this)
  }
  observe() {}
  disconnect() { this.disconnected = true }
  trigger() {
    if (this.disconnected) return
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}
Object.assign(globalThis, { IntersectionObserver: TestIntersectionObserver })
Object.assign(domWindow, { IntersectionObserver: TestIntersectionObserver })

const englishI18n = createInstance()
const mountedRoots: Array<{ root: Root; host: HTMLDivElement }> = []

function summary(id: string, name: string, library_scope: 'mine' | 'shared' = 'mine'): Summary {
  return {
    id,
    name,
    creator: 'Test creator',
    folder: '',
    tags: [],
    image_id: null,
    created_at: 1,
    updated_at: 1,
    has_alternate_greetings: false,
    library_scope,
  }
}

function recentChat(id: string, name: string) {
  return {
    ...summary(id, name),
    latest_chat_id: `chat-${id}`,
    latest_chat_name: 'Recent chat',
    character_id: id,
    character_name: name,
    character_image_id: null,
    updated_at: 1,
    is_group: false,
    chat_count: 1,
  }
}

function page(data: Summary[], total = data.length): SummaryPage {
  return { data, total }
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
  })
}

async function mountLanding() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mountedRoots.push({ root, host })
  await act(async () => {
    root.render(<I18nextProvider i18n={englishI18n}><LandingPage /></I18nextProvider>)
    await Promise.resolve()
  })
  return host
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

function tab(host: HTMLDivElement, name: 'Chats' | 'Characters') {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button[role="tab"]')).find(
    (candidate) => candidate.textContent?.trim() === name,
  )
}

function charactersMount(host: HTMLDivElement) {
  return host.querySelector<HTMLElement>('[data-spindle-mount="landing_characters"]')!
}

function appendReadySuiteRoot(host: HTMLDivElement) {
  const root = document.createElement('section')
  root.dataset.homepageCharacterLibraryRoot = 'true'
  root.dataset.homepageCharacterLibraryReady = 'true'
  root.dataset.component = 'HomepageCharacterLibrary'
  root.dataset.spindleExtId = 'lumiverse_suite'
  root.textContent = 'Character Library'
  charactersMount(host).append(root)
  return root
}

function button(host: HTMLDivElement, name: string) {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name,
  )
}

function buttonMatching(host: HTMLDivElement, pattern: RegExp) {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((candidate) => pattern.test(candidate.textContent ?? ''))
}

function countExactText(host: HTMLDivElement, value: string) {
  const walker = document.createTreeWalker(host, domWindow.NodeFilter.SHOW_TEXT)
  let count = 0
  let current: Node | null
  while ((current = walker.nextNode())) {
    if (current.nodeValue?.trim() === value) count += 1
  }
  return count
}

async function settleDeferred<T>(deferred: Deferred<T>, value: T) {
  await act(async () => {
    deferred.resolve(value)
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeAll(async () => {
  await englishI18n.use(initReactI18next).init({
    resources: { en: { landing, panels, common } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })

  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: LandingPage } = await import('./LandingPage'))
})

afterEach(async () => {
  const roots = mountedRoots.splice(0)
  await act(async () => {
    for (const { root } of roots) root.unmount()
  })
  document.body.replaceChildren()
  TestObserverInstances.splice(0)
  listSummaries.mockReset()
  listTags.mockReset()
  getHomepagePreview.mockReset()
  listRecentGrouped.mockReset()
  deleteTemporary.mockReset()
  deleteChat.mockReset()
  deleteCharacterChats.mockReset()
  patchMetadata.mockReset()
  createTemporary.mockReset()
  createChat.mockReset()
  branchChat.mockReset()
  listMessages.mockReset()
  navigate.mockReset()
  storeState = createStoreState()
})

describe('LandingPage character library', () => {
  test('uses the landing scroller for resized gallery pagination and de-duplicates observer entries', async () => {
    storeState = createStoreState('chats', false)
    const nextPage = createDeferred<SummaryPage>()
    listRecentGrouped
      .mockResolvedValueOnce(page([recentChat('character-1', 'Ava')], 2))
      .mockReturnValueOnce(nextPage.promise)
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    await flush()

    const observer = TestObserverInstances.at(-1)
    expect(observer?.options.root).toBe(host.querySelector('[data-component="LandingPage"]'))

    await act(async () => {
      observer?.trigger()
      observer?.trigger()
      await Promise.resolve()
    })
    expect(listRecentGrouped).toHaveBeenCalledTimes(2)

    await settleDeferred(nextPage, page([recentChat('character-2', 'Bea')], 2))
    expect(listRecentGrouped).toHaveBeenCalledTimes(2)
  })

  test('keeps the recent-chat gallery compact by default and can expand it', async () => {
    storeState = createStoreState('chats', false)
    listRecentGrouped.mockResolvedValue(page([]))
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    await flush()

    const widthButton = host.querySelector<HTMLButtonElement>('[aria-label="Expand gallery to full width"]')
    expect(widthButton?.getAttribute('aria-pressed')).toBe('false')

    await act(async () => widthButton?.click())

    expect(storeState.landingPageGalleryWidth).toBe('expanded')
    expect(storeState.setSetting).toHaveBeenLastCalledWith('landingPageGalleryWidth', 'expanded')
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Use compact gallery width"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  test('shows only native Chats before and after the suite surface is disabled', async () => {
    storeState = createStoreState('characters')
    listRecentGrouped.mockResolvedValue(page([]))
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    await flush()

    expect(host.querySelectorAll('button[role="tab"]')).toHaveLength(0)
    expect(tab(host, 'Characters')).toBeUndefined()
    expect(tab(host, 'Chats')).toBeUndefined()
    expect(host.textContent).toContain('No recent chats')
    expect(listSummaries).not.toHaveBeenCalled()

    const root = appendReadySuiteRoot(host)
    await flush()
    root.remove()
    await flush()

    expect(host.querySelectorAll('button[role="tab"]')).toHaveLength(0)
    expect(tab(host, 'Characters')).toBeUndefined()
    expect(tab(host, 'Chats')).toBeUndefined()
    expect(host.textContent).toContain('No recent chats')
  })

  test('adds Characters and selects it first when one suite root becomes ready', async () => {
    storeState = createStoreState('chats')
    listRecentGrouped.mockResolvedValue(page([]))
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    await flush()

    expect(tab(host, 'Chats')).toBeUndefined()
    expect(host.textContent).toContain('No recent chats')
    expect(listSummaries).not.toHaveBeenCalled()

    appendReadySuiteRoot(host)
    await flush()

    expect(tab(host, 'Characters')?.getAttribute('aria-selected')).toBe('true')
    expect(tab(host, 'Chats')?.getAttribute('aria-selected')).toBe('false')
    expect(charactersMount(host).querySelectorAll('[data-homepage-character-library-root]')).toHaveLength(1)
    expect(charactersMount(host).querySelectorAll('[data-component="HomepageCharacterLibrary"]')).toHaveLength(1)
    expect(listSummaries).not.toHaveBeenCalled()
    expect(listRecentGrouped).toHaveBeenCalledTimes(1)
    expect(storeState.setSetting).not.toHaveBeenCalled()
  })

  test('returns to native Chats when the suite root is removed', async () => {
    storeState = createStoreState('chats')
    listRecentGrouped.mockResolvedValue(page([]))
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    const root = appendReadySuiteRoot(host)
    await flush()
    expect(tab(host, 'Characters')?.getAttribute('aria-selected')).toBe('true')

    root.remove()
    await flush()

    expect(tab(host, 'Characters')).toBeUndefined()
    expect(tab(host, 'Chats')).toBeUndefined()
    expect(host.textContent).toContain('No recent chats')
    expect(listSummaries).not.toHaveBeenCalled()
  })

  test('re-adding the suite root activates once per ready transition and preserves Chats', async () => {
    storeState = createStoreState('chats')
    listRecentGrouped.mockResolvedValue(page([]))
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    await flush()

    const firstRoot = appendReadySuiteRoot(host)
    await flush()
    expect(storeState.setSetting).not.toHaveBeenCalled()
    firstRoot.append(document.createElement('span'))
    await flush()
    expect(storeState.setSetting).not.toHaveBeenCalled()

    firstRoot.remove()
    await flush()
    expect(tab(host, 'Chats')).toBeUndefined()
    expect(host.textContent).toContain('No recent chats')

    appendReadySuiteRoot(host)
    await flush()

    expect(tab(host, 'Characters')?.getAttribute('aria-selected')).toBe('true')
    expect(storeState.setSetting).not.toHaveBeenCalled()
    expect(charactersMount(host).querySelectorAll('[data-homepage-character-library-root]')).toHaveLength(1)
    expect(listRecentGrouped).toHaveBeenCalledTimes(1)
    expect(listSummaries).not.toHaveBeenCalled()
  })
})

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
