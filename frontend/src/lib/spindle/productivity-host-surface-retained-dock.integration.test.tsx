/// <reference types="bun-types" />

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'

import { clearLiveRootsForExtension, registerLiveRoot } from './live-root-registry'

mock.module('@/i18n', () => ({
  default: { t: (key: string) => key, language: 'en' },
  changeUiLanguage: async () => undefined,
  applyLoginLanguage: async () => undefined,
  changeLoginLanguage: async () => undefined,
}))
mock.module('@/lib/cssModuleRegistry', () => ({
  CSS_MODULE_REGISTRY: [],
  generateSelector: () => '',
}))
// The real store imports Whistle through the Spindle loader. Bun does not
// transform Vite worker URLs, and these host lifecycle tests never start capture.
mock.module('@/lib/whistle/capture.worklet.ts?worker&url', () => ({
  default: '/test-capture-worklet.js',
}))
mock.module('@/components/quick-toolbar/QuickToolbar', () => ({
  QuickToolbar: () => createElement('nav', { 'data-component': 'QuickToolbar', 'data-toolbar-action-scroller': 'ready' }, 'toolbar'),
}))
mock.module('@/components/settings/ProductivitySettings', () => ({
  default: () => null,
}))
mock.module('@/components/chat/PortraitDock', () => ({
  default: () => null,
}))
mock.module('@/components/connections-picker/ConnectionsPicker', () => ({
  ConnectionsPicker: () => null,
}))
mock.module('@/components/lore-indicator/LoreIndicator', () => ({
  default: () => null,
}))
mock.module('@/components/world-book-editor/LorebookHalfScreenEditor', () => ({
  default: () => null,
}))
mock.module('@/components/world-book-editor/LorebookEditorWorkspace', () => ({
  default: () => null,
}))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const originalGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  MutationObserver: globalThis.MutationObserver,
  ResizeObserver: globalThis.ResizeObserver,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
}

Object.defineProperty(dom.window, 'matchMedia', {
  configurable: true,
  value: () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }),
})

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  requestAnimationFrame: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
  cancelAnimationFrame: (id: number) => window.clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
})

const { useStore } = await import('@/store')
const { createComponentsHelper, destroyAllComponentsForExtension } = await import('./components-helper')
const { PRODUCTIVITY_HOST_SURFACES } = await import('./productivity-host-contracts')
const { getLorebookWorkspaceOverlayOpen } = await import('@/lib/lorebookWorkspaceVisibility')
await import('./productivity-host-surface-renderers')

const EXTENSION_ID = 'retained-dock-integration'

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
  })
}

describe('Quick Toolbar retained dock host lifecycle', () => {
  beforeEach(() => {
    useStore.setState({ extensions: [{ id: EXTENSION_ID, identifier: 'lumiverse_suite', enabled: true, has_frontend: true }] as any })
  })
  afterEach(async () => {
    destroyAllComponentsForExtension(EXTENSION_ID)
    clearLiveRootsForExtension(EXTENSION_ID)
    document.body.replaceChildren()
    await flush()
  })

  afterAll(() => Object.assign(globalThis, originalGlobals))

  test('keeps the mounted host root through floating and docked request transitions', async () => {
    const dock = document.createElement('div')
    dock.setAttribute('data-spindle-mount', 'chat_top_dock')
    dock.setAttribute('data-dock-request', 'strip')
    const root = document.createElement('div')
    root.setAttribute('data-spindle-extension-root', EXTENSION_ID)
    dock.append(root)
    document.body.append(dock)
    const unregister = registerLiveRoot(EXTENSION_ID, root, null, 1)
    const helper = createComponentsHelper(EXTENSION_ID, 'retained-dock-integration', async () => ({ categories: [] }), 1)

    const original = useStore.getState().quickToolbarSettings
    let handle: ReturnType<typeof helper.mountHostSurface>
    await act(async () => {
      useStore.setState({ quickToolbarSettings: { ...original, quickToolbarPlacement: 'floating', hideInChatTopDock: false } })
      handle = helper.mountHostSurface(root, 'quick_toolbar.workspace', {
        contractVersion: 1,
        ownerToken: EXTENSION_ID,
        generation: 1,
        capabilities: [],
        state: { enabled: true, variant: 'v1-free' },
      })
      for (let index = 0; index < 5; index += 1) await Promise.resolve()
    })

    expect(root.getAttribute('data-dock-request')).toBe('strip')
    const surface = root.querySelector('[data-spindle-host-surface="quick_toolbar.workspace"]')
    expect(surface).not.toBeNull()
    let workspace = surface?.querySelector<HTMLElement>('[data-surface-id="quick_toolbar.workspace"]')
    expect(workspace).not.toBeNull()
    expect(workspace?.getAttribute('data-lifecycle')).toBe('workspace')
    expect(surface?.querySelector('[data-toolbar-action-scroller="ready"]')).not.toBeNull()

    const installed = useStore.getState().extensions
    await act(async () => { useStore.setState({ extensions: [] }) })
    expect(surface?.querySelector('[data-surface-id]')).toBeNull()
    expect(root.hasAttribute('data-dock-request')).toBe(false)
    await act(async () => { useStore.setState({ extensions: installed }) })
    expect(surface?.querySelector('[data-toolbar-action-scroller="ready"]')).not.toBeNull()
    workspace = surface?.querySelector<HTMLElement>('[data-surface-id="quick_toolbar.workspace"]')

    await act(async () => {
      useStore.setState({ quickToolbarSettings: { ...original, quickToolbarPlacement: 'chat_top_dock', hideInChatTopDock: false } })
      for (let index = 0; index < 5; index += 1) await Promise.resolve()
    })
    expect(root.getAttribute('data-dock-request')).toBe('strip')
    expect(root.querySelector('[data-spindle-host-surface="quick_toolbar.workspace"]') === surface).toBe(true)
    expect(surface?.querySelector('[data-surface-id="quick_toolbar.workspace"]')).not.toBeNull()
    expect(surface?.querySelector('[data-toolbar-action-scroller="ready"]')).toBeNull()
    expect(workspace?.children).toHaveLength(0)
    expect(surface?.querySelector('[data-component="QuickToolbar"]')).toBeNull()
    await act(async () => {
      useStore.setState({ quickToolbarSettings: { ...original, quickToolbarPlacement: 'floating', hideInChatTopDock: true } })
      for (let index = 0; index < 5; index += 1) await Promise.resolve()
    })
    expect(root.getAttribute('data-dock-request')).toBe('floating')
    expect(root.querySelector('[data-spindle-host-surface="quick_toolbar.workspace"]') === surface).toBe(true)
    expect(surface?.querySelector('[data-surface-id="quick_toolbar.workspace"]')).not.toBeNull()

    await act(async () => {
      handle!.destroy()
      unregister()
      useStore.setState({ quickToolbarSettings: original })
      for (let index = 0; index < 5; index += 1) await Promise.resolve()
    })
  })

  test('every retained Suite host surface stays unmounted without an enabled frontend', async () => {
    const root = document.createElement('div')
    root.setAttribute('data-spindle-extension-root', EXTENSION_ID)
    document.body.append(root)
    const unregister = registerLiveRoot(EXTENSION_ID, root, null, 1)
    const helper = createComponentsHelper(EXTENSION_ID, 'retained-dock-integration', async () => ({ categories: [] }), 1, { hasPermission: () => true })
    const installed = useStore.getState().extensions[0]
    const originalSettings = useStore.getState().quickToolbarSettings
    const previousOverflow = document.body.style.overflow

    for (const extensions of [[], [{ ...installed, enabled: false }], [{ ...installed, has_frontend: false }]]) {
      await act(async () => { useStore.setState({ extensions }) })
      for (const surfaceId of PRODUCTIVITY_HOST_SURFACES) {
        let handle: ReturnType<typeof helper.mountHostSurface>
        await act(async () => {
          handle = helper.mountHostSurface(root, surfaceId, {
            contractVersion: 1, ownerToken: EXTENSION_ID, generation: 1, capabilities: [],
            state: { open: true, bookId: 'book', entryId: null, invocationId: null },
          })
        })
        expect(root.textContent).toBe('')
        expect(root.querySelector('[data-surface-id]')).toBeNull()
        expect(root.hasAttribute('data-dock-request')).toBe(false)
        expect(document.body.style.overflow).toBe(previousOverflow)
        expect(getLorebookWorkspaceOverlayOpen()).toBe(false)
        await act(async () => { handle!.destroy() })
      }
    }
    expect(useStore.getState().quickToolbarSettings).toBe(originalSettings)
    unregister()
  })
})
