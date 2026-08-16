import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

import { createSuite, type SuiteHostContext, type SuiteModule } from '../src/suite'
import type {
  SpindleHostSurfaceHandle,
  SpindleSettingsTabHandle,
} from '../src/shared/public-sdk'
import { createHomepageLibraryModule } from '../src/modules/homepage_library'
import { createLorebookTokenCountsModule } from '../src/modules/lorebook_token_counts'
import { defaultHomepageLibrarySettings } from '../src/modules/homepage_library/types'

let dom: JSDOM

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>')
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
  })
})

afterEach(() => {
  dom.window.close()
})

describe('suite public SDK consumer', () => {
  test('registers and unloads provider through public handles in a host-provided scoped root', async () => {
    const scopedRoot = document.createElement('section')
    document.body.append(scopedRoot)
    const destroyed = {
      settingsTab: 0,
      hostSurface: 0,
      decorator: 0,
      module: 0,
    }
    const mountedTargets: Element[] = []
    const decoratorTargets: string[] = []

    const settingsTab: SpindleSettingsTabHandle = {
      id: 'productivity',
      root: scopedRoot,
      update() {},
      destroy() { destroyed.settingsTab += 1 },
    }
    const surfaceHandle = (): SpindleHostSurfaceHandle => ({
      update() {},
      destroy() { destroyed.hostSurface += 1 },
      on() { return () => undefined },
    })

    const values = new Map<string, unknown>([
      ['homepage_library:homepageLibrarySettings', defaultHomepageLibrarySettings()],
      ['lorebook_token_counts:enabled', true],
    ])

    const ctx = {
      host: {
        descriptorVersion: 1 as const,
        lumiverseVersion: 'test',
        capabilities: {},
        extensionInstallationId: 'public-sdk-consumer',
        surfaces: {
          list: () => [],
          subscribe: () => () => undefined,
          invoke: async () => undefined,
          registerDeepLinkTarget: () => () => undefined,
        },
      },
      ui: {
        mount: () => scopedRoot,
        registerSettingsTab: () => settingsTab,
        registerInputBarAction: () => ({ destroy() {} }),
        registerDrawerTab: () => ({ root: scopedRoot, tabId: 'x', setTitle() {}, setShortName() {}, setBadge() {}, activate() {}, destroy() {}, onActivate: () => () => undefined }),
        createFloatWidget: () => ({ root: scopedRoot, destroy() {} }),
        mountApp: () => ({ root: scopedRoot, destroy() {} }),
        geometry: {
          getUiScale: () => 1,
          toLayoutPx: (value: number) => value,
          layoutViewportSize: () => ({ width: 1280, height: 800 }),
          layoutElementRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0, toJSON() { return {} } }) as DOMRect,
          createResizeController: () => ({ destroy() {} }),
        },
      },
      components: {
        mountHostSurface: (target: Element) => {
          mountedTargets.push(target)
          expect(scopedRoot.contains(target) || target === scopedRoot).toBe(true)
          return surfaceHandle()
        },
      },
      registerDomDecorator: (options: { target: string; decorate: (element: HTMLElement) => void | (() => void) }) => {
        decoratorTargets.push(options.target)
        return { destroy() { destroyed.decorator += 1 } }
      },
      onTeardown: (handler: () => void) => {
        void handler
        return () => undefined
      },
      settings: {
        get: async <T>(key: string) => values.get(key) as T | undefined,
        set: async () => undefined,
        remove: async () => undefined,
        watch: () => () => undefined,
        core: {
          get: (key: string) => key === 'homepageCharacterLibrarySettings'
            ? defaultHomepageLibrarySettings()
            : undefined,
          watch: () => () => undefined,
          list: () => [],
          isReady: () => true,
        },
      },
      worldBooks: {
        entries: {
          list: async () => ({ data: [], total: 0 }),
        },
      },
      tokens: {
        countText: async () => ({ token_count: 0, char_count: 0 }),
      },
      dom: {
        addStyle: () => () => undefined,
      },
    } as unknown as SuiteHostContext

    const frontend: Pick<SpindleFrontendContext, 'host' | 'ui' | 'components'> = ctx
    expect(frontend.host.extensionInstallationId).toBe('public-sdk-consumer')

    const tracker: SuiteModule = {
      id: 'quick_toolbar',
      start() {},
      stop() { destroyed.module += 1 },
    }

    const suite = createSuite(ctx, [
      { module: createHomepageLibraryModule(), enabled: true },
      { module: createLorebookTokenCountsModule(), enabled: true },
      { module: tracker, enabled: true },
    ])

    await suite.start()
    expect(mountedTargets.length).toBeGreaterThan(0)
    for (const target of mountedTargets) {
      expect(scopedRoot === target || scopedRoot.contains(target)).toBe(true)
    }
    expect(decoratorTargets).toContain('[data-world-book-entry-row]')

    await suite.stop()
    expect(destroyed.settingsTab).toBe(1)
    expect(destroyed.hostSurface).toBeGreaterThan(0)
    expect(destroyed.decorator).toBe(1)
    expect(destroyed.module).toBe(1)
    expect(scopedRoot.querySelector('[data-homepage-character-library-root]')).toBeNull()
  })
})
