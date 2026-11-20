import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { create } from 'zustand'
import { JSDOM } from 'jsdom'

// Run the actual organizer and layout model against a minimal DOM/store so
// collapsed folders, focused edits, and new folders cannot drift apart.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://drawer.test', pretendToBeVisual: true })
const globals = globalThis as unknown as Record<string, unknown>
const previous = new Map(['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'ResizeObserver', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globals[key]]))
Object.assign(globals, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} },
})

// Initialize React DOM after the fixture DOM so it detects native input events.
const { createRoot } = await import('react-dom/client')

const makeSettings = () => ({
  layout: [
    { type: 'folder', id: 'folder-one', name: 'Everyday', icon: 'folder', children: ['profile'] },
    { type: 'folder', id: 'folder-two', name: 'Utilities', icon: 'folder', children: ['connections'] },
  ],
  hiddenTabIds: [], tabOrder: ['profile', 'connections'],
})
const useStore = create<any>((set) => ({
  drawerSettings: makeSettings(), drawerTabs: [], extensions: [], modalProps: {},
  closeModal: () => {},
  setSetting: (key: string, value: unknown) => set({ [key]: value }),
}))
mock.module('@/store', () => ({ useStore }))
mock.module('@/components/shared/ModalShell', () => ({ ModalShell: ({ children }: any) => <div>{children}</div> }))
mock.module('@/components/shared/CloseButton', () => ({ CloseButton: () => null }))
mock.module('@/components/shared/Toggle', () => ({ Toggle: { Switch: () => null } }))
mock.module('@/components/modals/ConfigureDrawerTabsModal.module.css', () => ({ default: new Proxy({}, { get: (_target, key) => key }) }))
mock.module('./ConfigureDrawerTabsModal.module.css', () => ({ default: new Proxy({}, { get: (_target, key) => key }) }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: any) => options?.defaultValue ?? key }) }))
mock.module('@/i18n', () => ({ default: { t: (key: string, options?: any) => options?.defaultValue ?? key } }))
mock.module('@/lib/drawer-tab-registry', () => ({
  DRAWER_TABS: ['profile', 'connections'].map(id => ({ id, tabName: id, tabIcon: () => null })),
  adaptExtensionTabs: () => [], isDrawerTabCore: () => false, sanitizeHiddenDrawerTabIds: (ids: string[]) => ids,
}))
mock.module('@/lib/drawer-folder-icons', () => ({ DRAWER_FOLDER_ICON_OPTIONS: [], DrawerFolderIcon: () => null }))
mock.module('@/lib/spindle/frontend-extension-availability', () => ({ filterEnabledFrontendContributions: () => [] }))
const { default: ConfigureDrawerTabsModal } = await import('./ConfigureDrawerTabsModal')

beforeEach(() => { useStore.setState({ drawerSettings: makeSettings(), modalProps: {} }) })
afterAll(() => {
  mock.restore()
  for (const [key, value] of previous) {
    if (value === undefined) delete globals[key]
    else globals[key] = value
  }
  dom.window.close()
})

function renderModal(modalProps: Record<string, unknown> = {}) {
  useStore.setState({ modalProps })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<ConfigureDrawerTabsModal />))
  return { host, close: () => { act(() => root.unmount()); host.remove() } }
}

test('sidebar editor starts with all folder children collapsed', () => {
  const modal = renderModal()
  try {
    const folders = modal.host.querySelectorAll<HTMLElement>('[data-drawer-layout-kind="folder"]')
    expect(folders).toHaveLength(2)
    expect(modal.host.querySelectorAll('.folderChildren')).toHaveLength(0)
    const toggle = folders[0].querySelector<HTMLButtonElement>('button.folderExpandButton')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    act(() => { toggle.click() })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(folders[0].querySelectorAll('[data-drawer-tab-id="profile"]')).toHaveLength(1)
    act(() => { toggle.click() })
    expect(modal.host.querySelectorAll('.folderChildren')).toHaveLength(0)
  } finally { modal.close() }
})

test('customize folder expands and focuses exactly the requested folder', () => {
  const modal = renderModal({ focusFolderId: 'folder-two' })
  try {
    const first = modal.host.querySelector<HTMLElement>('[data-drawer-folder-id="folder-one"]')!
    const second = modal.host.querySelector<HTMLElement>('[data-drawer-folder-id="folder-two"]')!
    expect(first.querySelector('.folderChildren')).toBeNull()
    expect(second.querySelector('.folderChildren')).not.toBeNull()
    const name = second.querySelector<HTMLInputElement>('input.nameInput')!
    expect(document.activeElement).toBe(name)
    expect(name.selectionStart).toBe(0)
    expect(name.selectionEnd).toBe(name.value.length)
  } finally { modal.close() }
})

test('adding a new folder opens it for editing without expanding older folders', () => {
  const modal = renderModal()
  try {
    const add = Array.from(modal.host.querySelectorAll<HTMLButtonElement>('button.addButton'))
      .find(button => button.textContent?.includes('Add Folder'))!
    act(() => { add.click() })
    const folders = modal.host.querySelectorAll<HTMLElement>('[data-drawer-layout-kind="folder"]')
    expect(folders).toHaveLength(3)
    expect(folders[0].querySelector('.folderChildren')).toBeNull()
    expect(folders[1].querySelector('.folderChildren')).toBeNull()
    expect(folders[2].querySelector('.folderChildren')).not.toBeNull()
    const name = folders[2].querySelector<HTMLInputElement>('input.nameInput')!
    expect(document.activeElement).toBe(name)
  } finally { modal.close() }
})
