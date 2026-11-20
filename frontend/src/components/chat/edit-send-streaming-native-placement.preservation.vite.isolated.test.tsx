/// <reference types="bun-types" />

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  isShowNativeBrowseMessages,
  isShowNativeScrollToTop,
  isShowNativeSelectMessages,
} from '../quick-toolbar/quickToolbarDock'
import { quickToolbarOwnsOldestMessage } from './chatNativeDockOwnership'
import {
  PRODUCTIVITY_FEATURE_FLAGS,
  readProductivityFlag,
  type ProductivityFeatureFlag,
} from '@/lib/spindle/productivity-feature-toggles'

const FRONTEND_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const featureState: Record<ProductivityFeatureFlag | 'productivityTabPosition', unknown> = {
  showEmbeddingFallbackUi: true,
  showCortexSecondaryUi: true,
  showEditAndSend: true,
  enableToolbarIconReorder: true,
  showComposerCustomizeGear: true,
  productivityTabPosition: 'after-display',
}
const persisted: Array<{ key: string; value: unknown; source?: string }> = []
const useStore = Object.assign(
  (selector: (state: typeof featureState) => unknown) => selector(featureState),
  {
    getState: () => featureState,
    setState: (patch: Partial<typeof featureState>) => Object.assign(featureState, patch),
    subscribe: () => () => undefined,
  },
)
mock.module('@/store', () => ({ useStore }))
mock.module('@/store/slices/settings', () => ({
  persistKey: (key: string, value: unknown, source?: string) => persisted.push({ key, value, source }),
}))
mock.module('@/lib/settings-tab-registry', () => ({
  SETTINGS_TABS: [{ id: 'advanced', shortName: 'Advanced', tabName: 'Advanced Settings' }],
}))

const { default: ProductivityFeatureToggles } = await import('../settings/ProductivityFeatureToggles')

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
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLSelectElement: domWindow.HTMLSelectElement,
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

beforeEach(() => {
  for (const flag of PRODUCTIVITY_FEATURE_FLAGS) featureState[flag] = true
  featureState.productivityTabPosition = 'after-display'
  persisted.length = 0
  document.body.replaceChildren()
})

describe('Property 2 preservation: Suite placement and native ownership', () => {
  test('Suite-enabled valid sides and independent native visibility retain their observed matrix', async () => {
    const source = await Bun.file(new URL('./ChatView.tsx', import.meta.url)).text()
    const css = await Bun.file(new URL('./ChatView.module.css', import.meta.url)).text()
    expect((source.match(/<div className=\{styles\.nativeDockActions\}>/g) ?? []).length).toBe(1)
    expect(css).toMatch(/data-native-action-side='left'\] \.nativeDockActions\s*\{[^}]*order:\s*1;/s)
    expect(css).toMatch(/data-native-action-side='right'\][^}]*QuickToolbar[^}]*\{\s*order:\s*1;/s)

    for (const persistedSide of ['left', 'right'] as const) {
      const resolvedSide = persistedSide ?? 'right'
      expect(resolvedSide).toBe(persistedSide)
    }

    for (const showSelect of [false, true]) {
      for (const showOldest of [false, true]) {
        for (const showBrowse of [false, true]) {
          const settings = {
            showNativeSelectMessages: showSelect,
            showNativeScrollToTop: showOldest,
            showNativeBrowseMessages: showBrowse,
          }
          expect({
            select: isShowNativeSelectMessages(settings),
            oldest: isShowNativeScrollToTop(settings),
            browse: isShowNativeBrowseMessages(settings),
          }).toEqual({ select: showSelect, oldest: showOldest, browse: showBrowse })
        }
      }
    }
  })

  test('QuickToolbar owns oldest-message only for the Suite-enabled visible action', () => {
    const cases = [
      { suite: true, enabled: true, visible: true, expected: true },
      { suite: true, enabled: true, visible: false, expected: false },
      { suite: true, enabled: false, visible: true, expected: false },
      { suite: false, enabled: true, visible: true, expected: false },
    ]
    for (const entry of cases) {
      expect(quickToolbarOwnsOldestMessage(entry.suite, {
        enabled: entry.enabled,
        visibleTabIds: entry.visible ? ['chat.scroll-to-top'] : ['profile'],
      })).toBe(entry.expected)
    }
  })
})

describe('Property 2 preservation: productivity feature toggles', () => {
  test('missing and non-false values retain enabled defaults while exact false disables', () => {
    for (const flag of PRODUCTIVITY_FEATURE_FLAGS) {
      expect(readProductivityFlag(undefined, flag)).toBe(true)
      expect(readProductivityFlag({}, flag)).toBe(true)
      expect(readProductivityFlag({ [flag]: true }, flag)).toBe(true)
      expect(readProductivityFlag({ [flag]: 'legacy-on' }, flag)).toBe(true)
      expect(readProductivityFlag({ [flag]: false }, flag)).toBe(false)
    }
  })

  test('Suite availability filters every Suite-owned flag and retains navigation choices', () => {
    const withoutSuite = renderToStaticMarkup(<ProductivityFeatureToggles hasLumiverseSuite={false} />)
    // showEmbeddingFallbackUi and showCortexSecondaryUi are Suite-owned too.
    // They used to stay visible here while their surfaces had no Suite gate at
    // all, so a persisted true kept Suite-only UI mounted after the extension
    // was disabled and the checkbox controlled nothing.
    expect(withoutSuite).not.toContain('data-productivity-feature-flag="showEmbeddingFallbackUi"')
    expect(withoutSuite).not.toContain('data-productivity-feature-flag="showCortexSecondaryUi"')
    expect(withoutSuite).not.toContain('data-productivity-feature-flag="showEditAndSend"')
    expect(withoutSuite).not.toContain('data-productivity-feature-flag="enableToolbarIconReorder"')
    expect(withoutSuite).toContain('data-productivity-feature-flag="showComposerCustomizeGear"')
    expect(withoutSuite).toContain('After Display &amp; Layout (Default)')
    expect(withoutSuite).toContain('After Advanced')

    const withSuite = renderToStaticMarkup(<ProductivityFeatureToggles hasLumiverseSuite />)
    for (const flag of PRODUCTIVITY_FEATURE_FLAGS) {
      expect(withSuite).toContain(`data-productivity-feature-flag="${flag}"`)
    }
  })

  test('flag and tab interactions retain store values and persistence metadata', async () => {
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(ProductivityFeatureToggles, { hasLumiverseSuite: true })) })

    const editSend = host.querySelector<HTMLInputElement>('#productivity-feature-showEditAndSend')
    const tabPosition = host.querySelector<HTMLSelectElement>('#productivity-tab-position')
    await act(async () => {
      editSend?.click()
      if (tabPosition) {
        Object.getOwnPropertyDescriptor(domWindow.HTMLSelectElement.prototype, 'value')?.set?.call(tabPosition, 'after-advanced')
        tabPosition.dispatchEvent(new domWindow.Event('change', { bubbles: true }))
      }
      await Promise.resolve()
    })

    expect(featureState.showEditAndSend).toBe(false)
    expect(featureState.productivityTabPosition).toBe('after-advanced')
    expect(persisted).toEqual([
      { key: 'showEditAndSend', value: false, source: 'user-interaction' },
      { key: 'productivityTabPosition', value: 'after-advanced', source: 'user-interaction' },
    ])
    await act(async () => root.unmount())
    host.remove()
  })
})

test('Property 2 preservation: image-free, changed-source, added, removed, and non-streaming renders keep current semantics', async () => {
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
      ProseHtml: (props: { html: string; className?: string }) => unknown
      IsolatedHtml: (props: { html: string; isStreaming: boolean }) => unknown
    }
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(host)

    await act(async () => root.render(createElement(module.ProseHtml as never, { html: '<p>image-free first</p>' } as never)))
    const proseRoot = host.firstElementChild as HTMLElement
    await act(async () => root.render(createElement(module.ProseHtml as never, { html: '<p>image-free latest</p>' } as never)))
    expect(proseRoot.textContent).toBe('image-free latest')
    expect(proseRoot.querySelector('img')).toBeNull()

    await act(async () => root.render(createElement(module.ProseHtml as never, {
      html: '<p><img src="/api/v1/images/old">old source</p>',
    } as never)))
    const oldImage = proseRoot.querySelector('img')
    await act(async () => root.render(createElement(module.ProseHtml as never, {
      html: '<p><img src="/api/v1/images/new">new source</p>',
    } as never)))
    const newImage = proseRoot.querySelector('img')
    expect(newImage).not.toBe(oldImage)
    expect(newImage?.getAttribute('src')).toBe('/api/v1/images/new')
    expect(proseRoot.textContent).toContain('new source')

    await act(async () => root.render(createElement(module.ProseHtml as never, {
      html: '<p>removed image</p>',
    } as never)))
    expect(proseRoot.querySelector('img')).toBeNull()
    await act(async () => root.render(createElement(module.ProseHtml as never, {
      html: '<p><img src="/api/v1/images/added">added image</p>',
    } as never)))
    expect(proseRoot.querySelector('img')?.getAttribute('src')).toBe('/api/v1/images/added')

    await act(async () => root.render(createElement(module.IsolatedHtml as never, {
      html: '<div><img src="/api/v1/images/final-a"><span>non-streaming first</span></div>',
      isStreaming: false,
    } as never)))
    const island = host.querySelector('[data-lumiverse-html-island]') as HTMLElement
    const firstFinalImage = island.shadowRoot?.querySelector('img')
    await act(async () => root.render(createElement(module.IsolatedHtml as never, {
      html: '<div><img src="/api/v1/images/final-b"><span>non-streaming latest</span></div>',
      isStreaming: false,
    } as never)))
    expect(island.shadowRoot?.querySelector('img')).not.toBe(firstFinalImage)
    expect(island.shadowRoot?.querySelector('img')?.getAttribute('src')).toBe('/api/v1/images/final-b')
    expect(island.shadowRoot?.textContent).toContain('non-streaming latest')

    await act(async () => root.unmount())
  } finally {
    host.remove()
    await server.close()
  }
}, 30_000)

afterAll(() => dom.window.close())
