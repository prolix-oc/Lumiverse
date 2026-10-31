import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { create } from 'zustand'
import { JSDOM } from 'jsdom'

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
  openSettings: () => {}, openModal: () => {}, clearPendingActiveTabReset: () => {},
}))
mock.module('@/store', () => ({ useStore }))
mock.module('@/hooks/useIsMobile', () => ({ default: () => false }))
mock.module('@/hooks/useLongPress', () => ({ useLongPress: () => ({ onContextMenu: () => {} }) }))
mock.module('@/components/shared/GuideViewer', () => ({ GuideViewer: () => null }))
mock.module('@/components/shared/ContextMenu', () => ({ default: () => null }))
mock.module('./TabPanelContent', () => ({ default: () => null }))
mock.module('./ViewportDrawer.module.css', () => ({ default: new Proxy({}, { get: (_target, key) => key }) }))
mock.module('motion/react', () => ({ motion: { div: 'div' }, AnimatePresence: ({ children }: any) => children }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: any) => options?.defaultValue ?? key }) }))
mock.module('@/lib/i18n/resolveLabel', () => ({ translateDrawerField: (_id: string, _field: string, fallback: string) => fallback }))
mock.module('@/lib/drawer-tab-registry', () => ({
  DRAWER_TABS: ['profile', 'connections'].map(id => ({ id, tabName: id, shortName: id, tabIcon: () => null, keywords: [] })),
  adaptExtensionTabs: () => [], sanitizeHiddenDrawerTabIds: (ids: string[]) => ids,
  preloadDrawerTab: (id: string) => { preloads.push(id) },
}))
const { default: ViewportDrawer } = await import('./ViewportDrawer')

beforeEach(() => {
  preloads.length = 0
  useStore.setState({ drawerOpen: false, drawerTab: 'profile', drawerSettings: drawerSettings() })
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
