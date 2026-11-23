import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { create } from 'zustand'
import { JSDOM } from 'jsdom'
import { closeGuide, guideReaderSession } from '@/lib/guides/reader-session'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://drawer.test', pretendToBeVisual: true })
const globals = globalThis as unknown as Record<string, unknown>
const previous = new Map(['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'ResizeObserver', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globals[key]]))
Object.assign(globals, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} },
})
Object.defineProperty(dom.window, 'innerHeight', { value: 1000 })
dom.window.HTMLElement.prototype.setPointerCapture = () => {}
dom.window.HTMLElement.prototype.hasPointerCapture = () => false
dom.window.HTMLElement.prototype.releasePointerCapture = () => {}

const preloads: string[] = []
let mobileViewport = false
const drawerSettings = () => ({
  side: 'right', tabSize: 'compact', verticalPosition: 15, panelWidthMode: 'default', panelWidthPx: 420,
  showTabLabels: true, hiddenTabIds: [], tabOrder: [], layout: [{ type: 'tab', tabId: 'profile' }, { type: 'tab', tabId: 'connections' }],
})
const useStore = create<any>((set) => ({
  drawerOpen: false, drawerTab: 'profile', settingsLoaded: true, drawerSettings: drawerSettings(),
  drawerTabs: [], extensions: [], hiddenPlacements: [], isGroupChat: false, pendingActiveTabReset: null,
  openDrawer: (id?: string) => set(state => ({ drawerOpen: true, drawerTab: id ?? state.drawerTab })),
  closeDrawer: () => set({ drawerOpen: false }), setDrawerTab: (drawerTab: string) => set({ drawerTab }),
  setSetting: (key: string, value: unknown) => set({ [key]: value }),
  openSettings: () => {}, openModal: (name: string, modalProps = {}) => set({ activeModal: name, modalProps }), clearPendingActiveTabReset: () => {},
}))
mock.module('@/store', () => ({ useStore }))
mock.module('@/hooks/useIsMobile', () => ({ default: () => mobileViewport }))
mock.module('@/hooks/useLongPress', () => ({ useLongPress: ({ onLongPress }: any) => ({
  onContextMenu: (event: MouseEvent) => { event.preventDefault(); onLongPress({ x: 0, y: 0 }) },
}) }))
mock.module('@/components/shared/ContextMenu', () => ({ default: ({ position, items }: any) => position
  ? <div data-testid="drawer-context-menu">{items.map((item: any) => <button key={item.key} onClick={item.onClick}>{item.label}</button>)}</div>
  : null }))
mock.module('./TabPanelContent', () => ({ default: () => null }))
mock.module('./ViewportDrawer.module.css', () => ({ default: new Proxy({}, { get: (_target, key) => key }) }))
mock.module('motion/react', () => ({ motion: { div: 'div' }, AnimatePresence: ({ children }: any) => children }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: any) => options?.defaultValue ?? key }) }))
mock.module('@/lib/i18n/resolveLabel', () => ({ translateDrawerField: (_id: string, _field: string, fallback: string) => fallback }))
mock.module('@/lib/drawer-tab-registry', () => ({
  DRAWER_TABS: ['profile', 'connections'].map(id => ({
    id, tabName: id, shortName: id, tabIcon: () => null, keywords: [],
    guide: id === 'profile' ? { kind: 'builtin', path: 'characters/index.md' } : undefined,
  })),
  adaptExtensionTabs: () => [], sanitizeHiddenDrawerTabIds: (ids: string[]) => ids,
  preloadDrawerTab: (id: string) => { preloads.push(id) },
}))
const { default: ViewportDrawer } = await import('./ViewportDrawer')

beforeEach(() => {
  preloads.length = 0
  mobileViewport = false
  useStore.setState({ drawerOpen: false, drawerTab: 'profile', drawerSettings: drawerSettings(), activeModal: null, modalProps: {} })
})
afterAll(() => {
  mock.restore()
  for (const [key, value] of previous) {
    if (value === undefined) delete globals[key]
    else globals[key] = value
  }
  dom.window.close()
})
function renderDrawer() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<ViewportDrawer />))
  const handle = host.querySelector<HTMLButtonElement>('button.drawerTab')!
  const click = (detail = 1) => handle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail }))
  const pointer = (type: string, y: number, pointerType = 'mouse') => handle.dispatchEvent(new dom.window.PointerEvent(type, {
    bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 1, pointerType, clientX: 10, clientY: y,
  }))
  return { host, handle, click, pointer, close: () => { act(() => root.unmount()); host.remove() } }
}

test('the real drawer handle opens and closes when preload handlers are attached', () => {
  const p = renderDrawer()
  try {
    act(() => { p.pointer('pointerdown', 100); p.pointer('pointerup', 100); p.click() })
    expect(useStore.getState().drawerOpen).toBe(true)
    expect(preloads).toContain('profile')
    act(() => { p.click() })
    expect(useStore.getState().drawerOpen).toBe(false)
  } finally { p.close() }
})

test('keyboard activation and panel selection retain the real navigation handlers', () => {
  const p = renderDrawer()
  try {
    act(() => { p.handle.focus(); p.click(0) })
    expect(useStore.getState().drawerOpen).toBe(true)
    act(() => { p.host.querySelector<HTMLButtonElement>('[data-tab-id="connections"]')!.click() })
    expect(useStore.getState().drawerTab).toBe('connections')
    expect(preloads).toContain('connections')
    act(() => { p.click(0) })
    expect(useStore.getState().drawerOpen).toBe(false)
    act(() => { p.click(0) })
    expect(useStore.getState().drawerOpen).toBe(true)
    expect(useStore.getState().drawerTab).toBe('connections')
  } finally { p.close() }
})

test('touch dragging suppresses its click while the next tap still opens the drawer', () => {
  const p = renderDrawer()
  try {
    act(() => { p.pointer('pointerdown', 100, 'touch'); p.pointer('pointermove', 300, 'touch') })
    act(() => { p.pointer('pointerup', 300, 'touch'); p.click() })
    expect(useStore.getState().drawerSettings.verticalPosition).toBe(35)
    expect(useStore.getState().drawerOpen).toBe(false)
    act(() => { p.pointer('pointerdown', 300, 'touch'); p.pointer('pointerup', 300, 'touch'); p.click() })
    expect(useStore.getState().drawerOpen).toBe(true)
  } finally { p.close() }
})

test('opens a contextual guide that survives switching drawer tabs', () => {
  const p = renderDrawer()
  try {
    act(() => { p.click(0) })
    const guideButton = p.host.querySelector<HTMLButtonElement>('button.guideButton')!
    act(() => { guideButton.click() })
    expect(guideReaderSession.getState().request?.guide).toEqual({
      kind: 'builtin', path: 'characters/index.md',
    })
    act(() => { p.host.querySelector<HTMLButtonElement>('[data-tab-id="connections"]')!.click() })
    expect(useStore.getState().drawerTab).toBe('connections')
    expect(guideReaderSession.getState().isOpen).toBe(true)
  } finally {
    closeGuide()
    p.close()
  }
})


const folderSettings = () => ({
  ...drawerSettings(),
  layout: [
    { type: 'folder', id: 'folder-one', name: 'Everyday', icon: 'folder', children: ['profile'] },
    { type: 'folder', id: 'folder-two', name: 'Utilities', icon: 'folder', children: ['connections'] },
  ],
})

test('folder expansion survives choosing a child and reopening the drawer', () => {
  useStore.setState({ drawerSettings: folderSettings() })
  const p = renderDrawer()
  try {
    const folder = p.host.querySelector<HTMLButtonElement>('button.folderTabBtn')!
    expect(folder.getAttribute('aria-expanded')).toBe('false')
    act(() => { folder.click() })
    expect(folder.getAttribute('aria-expanded')).toBe('true')
    expect(p.host.querySelectorAll('.folderChildren [data-tab-id="profile"]').length).toBe(1)
    act(() => { p.host.querySelector<HTMLButtonElement>('.folderChildren [data-tab-id="profile"]')!.click() })
    expect(useStore.getState().drawerTab).toBe('profile')
    expect(folder.getAttribute('aria-expanded')).toBe('true')
    act(() => { p.click() })
    act(() => { p.click() })
    expect(folder.getAttribute('aria-expanded')).toBe('true')
    act(() => { folder.click() })
    expect(folder.getAttribute('aria-expanded')).toBe('false')
  } finally { p.close() }
})

test('multiple folder groups remain expanded until individually toggled', () => {
  useStore.setState({ drawerSettings: folderSettings() })
  const p = renderDrawer()
  try {
    const [first, second] = Array.from(p.host.querySelectorAll<HTMLButtonElement>('button.folderTabBtn'))
    act(() => { first.click() })
    act(() => { second.click() })
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(second.getAttribute('aria-expanded')).toBe('true')
    act(() => { first.click() })
    expect(first.getAttribute('aria-expanded')).toBe('false')
    expect(second.getAttribute('aria-expanded')).toBe('true')
  } finally { p.close() }
})

test('folder expansion retains the canonical Spindle anchor and its mounted content', () => {
  useStore.setState({ drawerSettings: folderSettings() })
  const p = renderDrawer()
  try {
    const folder = p.host.querySelector<HTMLButtonElement>('button.folderTabBtn')!
    const anchor = p.host.querySelector('[data-spindle-scope="drawer-tab:profile"]')!
    const widget = document.createElement('input')
    widget.value = 'Unsaved extension state'
    anchor.append(widget)
    for (let i = 0; i < 2; i++) {
      act(() => { folder.click() })
      expect(p.host.querySelector('[data-spindle-scope="drawer-tab:profile"]')).toBe(anchor)
      expect(widget.isConnected).toBe(true)
      expect(widget.value).toBe('Unsaved extension state')
    }
  } finally { p.close() }
})

test('a trailing folder keeps a distinct root-end drop boundary even when expanded', () => {
  useStore.setState({ drawerSettings: folderSettings() })
  const p = renderDrawer()
  try {
    const folder = p.host.querySelectorAll<HTMLButtonElement>('button.folderTabBtn')[1]
    act(() => { folder.click() })
    const rail = p.host.querySelector<HTMLElement>('.tabList')!
    const lastFolder = rail.querySelectorAll<HTMLElement>('[data-drawer-folder-slot]')[1]
    const end = rail.querySelector<HTMLElement>('[data-drawer-edge-drop="drawer-layout:root-end"]')!
    expect(lastFolder.nextElementSibling).toBe(end)
    expect(lastFolder.querySelector('.folderChildren')).not.toBeNull()
    expect(end.classList.contains('sidebarEdgeDropEnd')).toBe(true)
    expect(end.closest('[data-drawer-folder-slot]')).toBeNull()
  } finally { p.close() }
})

test('customize folder context action targets its own folder', () => {
  useStore.setState({ drawerSettings: folderSettings() })
  const p = renderDrawer()
  try {
    const second = p.host.querySelectorAll<HTMLButtonElement>('button.folderTabBtn')[1]
    act(() => { second.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    const action = Array.from(p.host.querySelectorAll<HTMLButtonElement>('[data-testid="drawer-context-menu"] button'))
      .find(button => button.textContent === 'Customize Folder')
    expect(action).toBeDefined()
    act(() => { action!.click() })
    expect(useStore.getState().activeModal).toBe('configureTabs')
    expect(useStore.getState().modalProps).toEqual({ focusFolderId: 'folder-two' })
  } finally { p.close() }
})


test('sidebar folders have a single frame and no duplicate folder or chevron chrome', () => {
  useStore.setState({ drawerSettings: folderSettings() })
  const p = renderDrawer()
  try {
    const folder = p.host.querySelector<HTMLButtonElement>('button.folderTabBtn')!
    expect(folder.getAttribute('aria-expanded')).toBe('false')
    expect(folder.querySelector('.folderBadge, .folderChevron')).toBeNull()
    // A folder renders just its configured icon, not an additional badge glyph.
    expect(folder.querySelectorAll('svg').length).toBeLessThanOrEqual(1)
    act(() => { folder.click() })
    expect(folder.closest('.folderSlot')?.classList.contains('folderSlotOpen')).toBe(true)
    const children = folder.closest('.folderSlot')!.querySelector('.folderChildren')!
    expect(children.querySelectorAll('.folderChildSlot')).toHaveLength(1)
    expect(children.querySelector('.folderBadge, .folderChevron')).toBeNull()
    expect(children.querySelector('.tabBtn')?.classList.contains('tabBtnLabeled')).toBe(true)
  } finally { p.close() }
})


test('mobile Arrange Mode reserves long-press context events for dragging, then restores the menu on Done', () => {
  mobileViewport = true
  useStore.setState({ drawerSettings: folderSettings() })
  const p = renderDrawer()
  try {
    const folder = p.host.querySelector<HTMLButtonElement>('button.folderTabBtn')!
    const menu = () => p.host.querySelector('[data-testid="drawer-context-menu"]')
    const context = (target: Element) => {
      const event = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      act(() => { target.dispatchEvent(event) })
      return event
    }

    // Normal mobile long press still opens the actions, including Arrange.
    context(folder)
    expect(menu()).not.toBeNull()
    const arrange = Array.from(p.host.querySelectorAll<HTMLButtonElement>('[data-testid="drawer-context-menu"] button'))
      .find(button => button.textContent === 'Arrange sidebar icons')!
    act(() => { arrange.click() })
    expect(menu()).toBeNull()
    expect(p.host.querySelector('.sidebarOrganizing')).not.toBeNull()
    expect(p.host.querySelectorAll('.tabDragEnabled').length).toBeGreaterThan(0)

    // Native contextmenu events should be prevented for every draggable target.
    // The folder and its children have separate event handlers.
    const secondFolder = p.host.querySelectorAll<HTMLButtonElement>('button.folderTabBtn')[1]
    const folderDragWrapper = folder.closest('[data-drawer-drag-id]')!
    for (const target of [folder, secondFolder, folderDragWrapper]) {
      const event = context(target)
      expect(event.defaultPrevented).toBe(true)
      expect(menu()).toBeNull()
    }
    act(() => { folder.click() })
    const inside = p.host.querySelector<HTMLButtonElement>('.folderChildren [data-tab-id="profile"]')!
    expect(context(inside).defaultPrevented).toBe(true)
    expect(menu()).toBeNull()

    // A user can leave Arrange Mode without needing the blocked context menu.
    const done = p.host.querySelector<HTMLButtonElement>('button.organizeDone')
    act(() => { done!.click() })
    expect(p.host.querySelector('.sidebarOrganizing')).toBeNull()
    context(folder)
    expect(menu()).not.toBeNull()
  } finally { p.close() }
})

test('mobile Arrange Mode pointer moves a real tab and persists the reordered layout', () => {
  mobileViewport = true
  const p = renderDrawer()
  const originalHitTest = document.elementFromPoint
  try {
    const profileButton = p.host.querySelector<HTMLButtonElement>('[data-tab-id="profile"]')!
    const profile = profileButton.closest<HTMLElement>('[data-drawer-drag-id]')!
    const connections = p.host.querySelector<HTMLElement>('[data-tab-id="connections"]')!.closest<HTMLElement>('[data-drawer-drag-id]')!
    const rail = p.host.querySelector<HTMLElement>('.tabList')!
    const rect = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 60, height: 60, x: left, y: 0, toJSON: () => {} })
    rail.getBoundingClientRect = () => rect(0, 200)
    profile.getBoundingClientRect = () => rect(0, 52)
    connections.getBoundingClientRect = () => rect(55, 52)
    document.elementFromPoint = (x: number) => x > 52 ? connections : rail
    const fire = (type: string, x: number) => profileButton.dispatchEvent(new dom.window.PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, isPrimary: true,
      pointerId: 7, pointerType: 'touch', clientX: x, clientY: 24,
    }))

    // Opening Arrange Mode doesn't navigate, and the icon follows the pointer.
    act(() => { profileButton.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    const arrange = Array.from(p.host.querySelectorAll<HTMLButtonElement>('[data-testid="drawer-context-menu"] button'))
      .find(button => button.textContent === 'Arrange sidebar icons')!
    act(() => { arrange.click() })
    act(() => { fire('pointerdown', 25); fire('pointermove', 96) })
    expect(profile.style.translate).not.toBe('')
    expect(profile.classList.contains('tabDragActive')).toBe(true)
    act(() => { fire('pointerup', 96) })
    expect(profile.style.translate).toBe('')
    expect((useStore.getState().drawerSettings.layout as any[]).map(item => item.tabId)).toEqual(['connections', 'profile'])
    expect(useStore.getState().drawerTab).toBe('profile')
  } finally {
    document.elementFromPoint = originalHitTest
    p.close()
  }
})

test('mobile Arrange Mode overlapping two tabs for 700 ms makes a folder', async () => {
  mobileViewport = true
  const p = renderDrawer()
  const originalHitTest = document.elementFromPoint
  try {
    const profileButton = p.host.querySelector<HTMLButtonElement>('[data-tab-id="profile"]')!
    const profile = profileButton.closest<HTMLElement>('[data-drawer-drag-id]')!
    const connections = p.host.querySelector<HTMLElement>('[data-tab-id="connections"]')!.closest<HTMLElement>('[data-drawer-drag-id]')!
    const rail = p.host.querySelector<HTMLElement>('.tabList')!
    const rect = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 60, height: 60, x: left, y: 0, toJSON: () => {} })
    rail.getBoundingClientRect = () => rect(0, 200)
    profile.getBoundingClientRect = () => rect(0, 52)
    connections.getBoundingClientRect = () => rect(55, 52)
    document.elementFromPoint = (x: number) => x > 52 ? connections : rail
    const fire = (type: string, x: number) => profileButton.dispatchEvent(new dom.window.PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, isPrimary: true,
      pointerId: 7, pointerType: 'touch', clientX: x, clientY: 24,
    }))

    act(() => { profileButton.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    const arrange = Array.from(p.host.querySelectorAll<HTMLButtonElement>('[data-testid="drawer-context-menu"] button'))
      .find(button => button.textContent === 'Arrange sidebar icons')!
    act(() => { arrange.click() })
    act(() => { fire('pointerdown', 25); fire('pointermove', 80) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 740)) })
    expect(connections.dataset.drawerDropReady).toBe('true')
    act(() => { fire('pointerup', 80) })
    const savedLayout = useStore.getState().drawerSettings.layout as any[]
    expect(savedLayout.some(item => item.type === 'folder' && item.children.includes('profile') && item.children.includes('connections'))).toBe(true)
  } finally {
    document.elementFromPoint = originalHitTest
    p.close()
  }
})


test('an expanded folder followed by a divider exposes distinct root insertion targets in Arrange Mode', () => {
  mobileViewport = true
  useStore.setState({ drawerSettings: {
    ...drawerSettings(),
    layout: [
      { type: 'folder', id: 'last-folder', name: 'Last', icon: 'folder', children: ['profile'] },
      { type: 'divider', id: 'extensions', label: 'Extensions' },
      { type: 'tab', tabId: 'connections' },
    ],
  } })
  const p = renderDrawer()
  const originalHitTest = document.elementFromPoint
  try {
    const folder = p.host.querySelector<HTMLButtonElement>('.folderTabBtn')!
    act(() => { folder.click() })
    const profileButton = p.host.querySelector<HTMLButtonElement>('.folderChildren [data-tab-id="profile"]')!
    const source = profileButton.closest<HTMLElement>('[data-drawer-drag-id]')!
    const divider = p.host.querySelector<HTMLElement>('[data-drawer-divider]')!
    const before = divider.querySelector<HTMLElement>('[data-drawer-divider-drop="drawer-layout:divider-drop:before:extensions"]')!
    const after = divider.querySelector<HTMLElement>('[data-drawer-divider-drop="drawer-layout:divider-drop:after:extensions"]')!
    expect(before).not.toBeNull()
    expect(after).not.toBeNull()
    expect(divider.previousElementSibling?.getAttribute('data-drawer-folder-slot')).not.toBeNull()

    const rail = p.host.querySelector<HTMLElement>('.tabList')!
    const rect = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 60, height: 60, x: left, y: 0, toJSON: () => {} })
    rail.getBoundingClientRect = () => rect(0, 250)
    source.getBoundingClientRect = () => rect(0, 50)
    // Realistic geometry: divider spans just 28px high, but the finger
    // moves horizontally at y=44 in the much taller expanded folder.
    // Native elementFromPoint misses the divider halves in this case.
    divider.getBoundingClientRect = () => ({ ...rect(130, 24), height: 28, bottom: 28 })
    document.elementFromPoint = () => rail
    const fire = (type: string, x: number) => profileButton.dispatchEvent(new dom.window.PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, isPrimary: true,
      pointerId: 12, pointerType: 'touch', clientX: x, clientY: 44,
    }))
    act(() => { profileButton.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    const arrange = Array.from(p.host.querySelectorAll<HTMLButtonElement>('[data-testid="drawer-context-menu"] button'))
      .find(button => button.textContent === 'Arrange sidebar icons')!
    act(() => { arrange.click() })
    act(() => { fire('pointerdown', 25); fire('pointermove', 135) })
    expect(divider.classList.contains('tabDividerTargetBefore')).toBe(true)
    act(() => { fire('pointerup', 135) })
    expect((useStore.getState().drawerSettings.layout as any[]).map(item => item.type === 'tab' ? item.tabId : item.type))
      .toEqual(['folder', 'profile', 'divider', 'connections'])
    expect(source.style.translate).toBe('')
  } finally {
    document.elementFromPoint = originalHitTest
    p.close()
  }
})
