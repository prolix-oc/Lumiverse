import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import type { ExtensionInfo } from 'lumiverse-spindle-types'
import type { ExtensionUpdateInfo } from '@/types/spindle-updates'
import type { SpindleSlice } from '@/types/store'
import panels from '../../i18n/locales/en/panels.json'
import germanPanels from '../../i18n/locales/de/panels.json'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MouseEvent: dom.window.MouseEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })

const fixture: ExtensionInfo = {
  id: 'active', identifier: 'active', name: 'Active Toolkit', version: '1.0.0', author: 'Author',
  description: '', github: '', homepage: '', permissions: [], granted_permissions: [],
  enabled: true, installed_at: 0, updated_at: 0, has_frontend: false, has_backend: true,
  status: 'running', metadata: {},
}
const fixtures = [fixture, { ...fixture, id: 'inactive', name: 'Inactive Realm', enabled: false, status: 'stopped' as const }]
type TestStore = SpindleSlice & {
  user: null
  spindleSettings: { extensionUpdateToastDisabled: Record<string, boolean> }
}
let store: UseBoundStore<StoreApi<TestStore>>
function update(extensionId: string): ExtensionUpdateInfo {
  return { extensionId, identifier: extensionId, name: extensionId, currentVersion: '1.0.0', branch: 'main', localCommit: 'old', remoteCommit: 'new' }
}
mock.module('@/store', () => ({ useStore: store }))
mock.module('@/api/spindle', () => ({ spindleApi: {
  enable: async () => {},
  disable: async () => {},
  update: async (id: string) => ({ ...store.getState().extensions.find(extension => extension.id === id)!, version: '2.0.0' }),
  clearManifestCache: () => {},
} }))
mock.module('@/ws/client', () => ({ wsClient: { send: () => {} } }))
mock.module('@/lib/spindle/extension-mount-points', () => ({
  loadFrontendExtension: async () => {},
  unloadFrontendExtension: async () => {},
  getExtensionMountPointsVersion: () => 0,
  hasExtensionMountPoint: () => false,
  subscribeExtensionMountPoints: () => () => {},
}))
mock.module('@/components/spindle/SpindleUIControlPanel', () => ({ default: () => null }))
mock.module('./SpindleSettings', () => ({ default: () => null }))

let createRoot: typeof CreateRoot
let SpindlePanel: () => ReactNode
let root: Root | undefined
let container: HTMLDivElement
const i18n = createInstance()

beforeAll(async () => {
  const { createSpindleSlice } = await import('@/store/slices/spindle')
  store = create<TestStore>((...args) => ({
    ...createSpindleSlice(...args),
    extensions: fixtures,
    spindlePrivileged: true,
    user: null,
    spindleSettings: { extensionUpdateToastDisabled: {} },
    setExtensionOperationStatus: () => {},
  }))
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { panels }, de: { panels: germanPanels } }, interpolation: { escapeValue: false } })
  createRoot = (await import('react-dom/client')).createRoot
  SpindlePanel = (await import('./SpindlePanel')).default
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  container?.remove()
  dom.window.localStorage.clear()
  store.setState({ extensions: fixtures, extensionUpdates: [] })
  await i18n.changeLanguage('en')
})
async function renderPanel() {
  dom.window.localStorage.setItem('lumiverse:spindle:extension-panel-preferences', JSON.stringify({ sortMode: 'manual', viewMode: 'list', manualOrder: ['active', 'inactive'] }))
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<I18nextProvider i18n={i18n}><SpindlePanel /></I18nextProvider>))
}
function filterButton(filter: string) {
  return [...container.querySelectorAll<HTMLButtonElement>(`[aria-label="${i18n.t('spindlePanel.statusFilter.label', { ns: 'panels' })}"] button`)]
    .find(button => button.textContent?.startsWith(filter))!
}
async function click(button: HTMLButtonElement) {
  await act(async () => button.click())
}

test('filter controls select the correct list, retain installed counts, and suspend manual dragging', async () => {
  await renderPanel()
  expect(filterButton('All').getAttribute('aria-pressed')).toBe('true')
  expect(container.querySelectorAll('[title="Disable"], [title="Enable"]')).toHaveLength(2)
  expect(container.querySelectorAll('[aria-label^="Drag "]')).toHaveLength(2)
  await click(filterButton('Active'))
  expect(filterButton('Active').getAttribute('aria-pressed')).toBe('true')
  expect(filterButton('Active').textContent).toBe('Active 1')
  expect(container.textContent).toContain('Active Toolkit')
  expect(container.textContent).not.toContain('Inactive Realm')
  expect(container.querySelectorAll('[aria-label^="Drag "]')).toHaveLength(0)
  expect(container.textContent).toContain('Installed (2)')
  await click(filterButton('Inactive'))
  expect(container.textContent).toContain('Inactive Realm')
  expect(container.textContent).not.toContain('Active Toolkit')
  await click(filterButton('All'))
  expect(container.querySelectorAll('[aria-label^="Drag "]')).toHaveLength(2)
})

test('toggling the last active extension updates counts and shows an actionable empty state', async () => {
  await renderPanel()
  await click(filterButton('Active'))
  await click(container.querySelector<HTMLButtonElement>('[title="Disable"]')!)
  expect(filterButton('Active').textContent).toBe('Active 0')
  expect(filterButton('Inactive').textContent).toBe('Inactive 2')
  expect(container.textContent).toContain('No active extensions.')
  const showAll = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Show all extensions')!
  await click(showAll)
  expect(filterButton('All').getAttribute('aria-pressed')).toBe('true')
  expect(container.querySelectorAll('[title="Enable"]')).toHaveLength(2)
})

test('search combines with activity in card view and Show all clears both controls', async () => {
  await renderPanel()
  await click(container.querySelector<HTMLButtonElement>('[title="Card view"]')!)
  await click(filterButton('Inactive'))
  const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
    setValue.call(search, 'Toolkit')
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  expect(container.textContent).toContain('No extensions match this search and filter.')
  const showAll = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Show all extensions')!
  await click(showAll)
  expect(search.value).toBe('')
  expect(filterButton('All').getAttribute('aria-pressed')).toBe('true')
  expect(container.textContent).toContain('Active Toolkit')
  expect(container.textContent).toContain('Inactive Realm')
})

test('Updates follows supplied notices without an extra activity filter and ignores stale or repeated notices', async () => {
  store.setState({ extensionUpdates: [update('active'), update('inactive'), update('uninstalled'), update('active')] })
  await renderPanel()
  expect(filterButton('Updates').textContent).toBe('Updates 2')
  await click(filterButton('Updates'))
  expect(filterButton('Updates').getAttribute('aria-pressed')).toBe('true')
  expect(container.textContent).toContain('Active Toolkit')
  expect(container.textContent).toContain('Inactive Realm')
  expect(container.querySelectorAll('[aria-label^="Drag "]')).toHaveLength(0)
  await click(filterButton('All'))
  expect(container.querySelectorAll('[aria-label^="Drag "]')).toHaveLength(2)
})

test('Updates responds to update-check results and clears after the last update completes', async () => {
  await renderPanel()
  await click(filterButton('Updates'))
  expect(container.textContent).toContain('No extension updates available.')
  await act(async () => store.setState({ extensionUpdates: [update('active')] }))
  expect(filterButton('Updates').textContent).toBe('Updates 1')
  expect(container.textContent).toContain('Active Toolkit')
  expect(container.textContent).not.toContain('Inactive Realm')
  await click(container.querySelector<HTMLButtonElement>('[title="Card view"]')!)
  const updateButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Update')!
  await click(updateButton)
  expect(filterButton('Updates').textContent).toBe('Updates 0')
  expect(container.textContent).toContain('No extension updates available.')
  expect(filterButton('Updates').getAttribute('aria-pressed')).toBe('true')
})

test('the real store clears a detected update on disable and waits for a new snapshot after enable', async () => {
  store.getState().setExtensionUpdates([update('active')])
  await renderPanel()
  await click(filterButton('Updates'))
  await click(container.querySelector<HTMLButtonElement>('[title="Disable"]')!)
  expect(filterButton('Updates').textContent).toBe('Updates 0')
  expect(container.textContent).toContain('No extension updates available.')
  expect(store.getState().extensions.find(extension => extension.id === 'active')?.enabled).toBe(false)

  await click(filterButton('Inactive'))
  await click(container.querySelector<HTMLButtonElement>('[title="Enable"]')!)
  await click(filterButton('Updates'))
  expect(filterButton('Updates').textContent).toBe('Updates 0')
  await act(async () => store.getState().setExtensionUpdates([update('active')]))
  expect(filterButton('Updates').textContent).toBe('Updates 1')
  expect(container.textContent).toContain('Active Toolkit')
})

test('German filter labels, reordering hint, and empty results render from the German bundle', async () => {
  await i18n.changeLanguage('de')
  store.setState({ extensions: [fixture] })
  await renderPanel()
  expect(filterButton('Alle').textContent).toBe('Alle 1')
  expect(filterButton('Aktiv').textContent).toBe('Aktiv 1')
  expect(filterButton('Inaktiv').textContent).toBe('Inaktiv 0')
  expect(filterButton('Aktualisierungen').textContent).toBe('Aktualisierungen 0')
  await click(filterButton('Inaktiv'))
  expect(container.textContent).toContain(germanPanels.spindlePanel.statusFilter.noInactive)
  expect(container.textContent).toContain(germanPanels.spindlePanel.statusFilter.clearToReorder)
  const showAll = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === germanPanels.spindlePanel.statusFilter.showAll)!
  await click(showAll)
  expect(filterButton('Alle').getAttribute('aria-pressed')).toBe('true')
  await click(filterButton('Aktualisierungen'))
  expect(container.textContent).toContain(germanPanels.spindlePanel.statusFilter.noUpdatable)
  expect(container.textContent).not.toContain('spindlePanel.statusFilter.')
})
