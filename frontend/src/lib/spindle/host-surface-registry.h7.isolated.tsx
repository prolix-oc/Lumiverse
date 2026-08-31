/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider, useNavigate } from 'react-router'
import { JSDOM } from 'jsdom'
import { RouterContextExporter } from '@/lib/router-bridge'

import {
  clearLiveRootsForExtension,
  registerLiveRoot,
} from './live-root-registry'
import {
  getHostSurfaceRenderer,
  hostSurfacePermission,
  listHostSurfaces,
  registerHostSurfaceRenderer,
  validateHostSurfaceEventPayload,
  validateHostSurfaceProps,
} from './host-surface-registry'
import { frontendAuthorityPermission } from './frontend-authority-map'

mock.module('@/store', () => ({ useStore: () => undefined }))
mock.module('@/i18n', () => ({
  default: { t: (key: string) => key, language: 'en' },
  changeUiLanguage: async () => undefined,
}))
const {
  createComponentsHelper,
  destroyAllComponentsForExtension,
} = await import('./components-helper')

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const originalGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  MutationObserver: globalThis.MutationObserver,
}

beforeAll(() => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
  })
})

afterAll(() => {
  Object.assign(globalThis, originalGlobals)
})

const EXTENSION_ID = 'h7-test-extension'

function ownedRoot(generation = 1): { root: HTMLDivElement; unregister: () => void } {
  const root = document.createElement('div')
  root.setAttribute('data-spindle-extension-root', EXTENSION_ID)
  document.body.append(root)
  return {
    root,
    unregister: registerLiveRoot(EXTENSION_ID, root, null, generation),
  }
}

function helper(generation = 1, hasPermission: (permission: string) => boolean = () => false) {
  return createComponentsHelper(
    EXTENSION_ID,
    'h7-test-extension',
    async () => ({ categories: [] }),
    generation,
    { hasPermission },
  )
}

afterEach(async () => {
  destroyAllComponentsForExtension(EXTENSION_ID)
  clearLiveRootsForExtension(EXTENSION_ID)
  document.body.replaceChildren()
  await new Promise<void>(resolve => setTimeout(resolve, 0))
})

describe('H7 host-surface registry', () => {
  test('exposes exactly the canonical static allowlist and permissions', () => {
    expect(listHostSurfaces().map((surface) => surface.id)).toEqual([
      'provider_icon',
      'world_book_entry_editor',
      'world_book_entry_table',
      'character_card',
      'character_library_grid',
      'character_preview_panel',
      'homepage_character_library',
      'token_count_button',
      'productivity.settings.workspace',
      'quick_toolbar.workspace',
      'connections_picker.launcher',
      'connections_picker.panel',
      'activated_lore.indicator',
      'activated_lore.panel',
      'portrait_dock.workspace',
      'lorebook.half.action',
      'lorebook.half.workspace',
      'lorebook.enhanced.action',
      'lorebook.enhanced.workspace',
    ])
    for (const surface of listHostSurfaces()) {
      expect(surface.permission).toBe(frontendAuthorityPermission('host_surface', surface.id))
      expect(hostSurfacePermission(surface.id)).toBe(surface.permission)
    }
  })

  test('accepts valid JSON props and rejects executable, DOM, React, and custom-prototype values', () => {
    expect(validateHostSurfaceProps('provider_icon', { provider: 'openai', size: 24 })).toEqual({
      provider: 'openai',
      size: 24,
    })
    expect(() => validateHostSurfaceProps('provider_icon', { provider: () => 'openai' })).toThrow('JSON value required')
    expect(() => validateHostSurfaceProps('provider_icon', { provider: Number.NaN })).toThrow('finite number required')
    expect(() => validateHostSurfaceProps('provider_icon', { provider: Object.create({}) })).toThrow('custom prototype')
    expect(() => validateHostSurfaceProps('provider_icon', { provider: createElement('span') as unknown as string }))
      .toThrow(/symbol keys|JSON value required/)
    expect(() => validateHostSurfaceProps('provider_icon', { provider: 'openai', extra: true })).toThrow('unknown prop')
    expect(validateHostSurfaceProps('character_library_grid', {
      characters: [{ id: 'character-1', name: 'One' }],
    })).toEqual({ characters: [{ id: 'character-1', name: 'One' }] })
    expect(() => validateHostSurfaceProps('character_library_grid', {
      characters: Array.from({ length: 101 }, (_, index) => ({ id: `character-${index}` })),
    })).toThrow('item limit exceeded')
    expect(() => validateHostSurfaceProps('character_library_grid', {
      characters: ['character-1'],
    })).toThrow('plain object array required')

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => validateHostSurfaceEventPayload(cyclic)).toThrow('cyclic value')

    const domNode = document.createElement('div')
    expect(() => validateHostSurfaceProps('character_card', { characterId: domNode as unknown as string })).toThrow('unsupported object')
  })

  test('keeps event payloads JSON-only', () => {
    expect(validateHostSurfaceEventPayload({ selected: 'character-1' })).toEqual({ selected: 'character-1' })
    expect(() => validateHostSurfaceEventPayload(() => {})).toThrow('JSON value required')
    expect(() => validateHostSurfaceEventPayload({ value: Number.POSITIVE_INFINITY })).toThrow('finite number required')
  })

  test('fails closed on unavailable renderers and gated rows', () => {
    const surfaceHelper = helper()
    const { root } = ownedRoot()
    expect(() => surfaceHelper.mountHostSurface(root, 'provider_icon', { provider: 'openai' }))
      .toThrow('HOST_SURFACE_UNAVAILABLE')
    expect(() => surfaceHelper.mountHostSurface(root, 'world_book_entry_editor', {
      bookId: 'book',
      entryId: 'entry',
    })).toThrow('PERMISSION_DENIED:world_books')
  })

  test('uses owned roots, handle events, and generation teardown', () => {
    let emitSelect: (() => void) | undefined
    registerHostSurfaceRenderer('provider_icon', (_props, context) => {
      emitSelect = () => context.emit('select', { provider: 'openai' })
      return createElement(
        'button',
        { onClick: () => context.emit('select', { provider: 'openai' }) },
        'provider',
      )
    })

    expect(getHostSurfaceRenderer('provider_icon')).toBeDefined()
    const { root, unregister } = ownedRoot()
    const surfaceHelper = helper()
    const handle = surfaceHelper.mountHostSurface(root, 'provider_icon', { provider: 'openai' })
    const events: unknown[] = []
    const unsubscribe = handle.on('select', (payload) => events.push(payload))
    emitSelect?.()

    const foreign = document.createElement('div')
    foreign.setAttribute('data-spindle-extension-root', 'foreign-extension')
    document.body.append(foreign)
    expect(() => surfaceHelper.mountHostSurface(foreign, 'provider_icon', { provider: 'openai' }))
      .toThrow('current extension')

    handle.update({ provider: 'anthropic' })
    handle.destroy()
    unsubscribe()
    expect(() => handle.update({ provider: 'openai' })).toThrow('HOST_SURFACE_DESTROYED')
    unregister()

    const second = ownedRoot()
    const secondHandle = helper().mountHostSurface(second.root, 'provider_icon', { provider: 'openai' })
    destroyAllComponentsForExtension(EXTENSION_ID)
    expect(() => secondHandle.update({ provider: 'openai' })).toThrow('HOST_SURFACE_DESTROYED')
    second.unregister()

    expect(events).toEqual([{ provider: 'openai' }])
  })

  test('keeps launcher and panel surfaces isolated when they share an anchor', () => {
    registerHostSurfaceRenderer('connections_picker.launcher', () => createElement('button', {}, 'launcher'))
    registerHostSurfaceRenderer('connections_picker.panel', () => createElement('section', {}, 'panel'))
    const { root } = ownedRoot()
    const surfaceHelper = helper(1, permission => permission === 'generation')
    const launcher = surfaceHelper.mountHostSurface(root, 'connections_picker.launcher', {
      contractVersion: 1,
      ownerToken: EXTENSION_ID,
      generation: 1,
      capabilities: ['open'],
      state: { enabled: true, variant: 'A' },
    })
    const panel = surfaceHelper.mountHostSurface(root, 'connections_picker.panel', {
      contractVersion: 1,
      ownerToken: EXTENSION_ID,
      generation: 1,
      capabilities: ['close'],
      state: { enabled: true, variant: 'A', open: true },
    })

    expect(root.querySelectorAll('[data-spindle-host-surface]')).toHaveLength(2)
    expect(root.textContent).toContain('launcher')
    expect(root.textContent).toContain('panel')

    panel.destroy()
    expect(root.textContent).toContain('launcher')
    expect(root.textContent).not.toContain('panel')
    launcher.destroy()
    expect(root.querySelectorAll('[data-spindle-host-surface]')).toHaveLength(0)
  })

  test('keeps dock surfaces isolated when Quick Toolbar and Portrait Dock share an anchor', () => {
    registerHostSurfaceRenderer('quick_toolbar.workspace', () => createElement('div', {}, 'quick-toolbar'))
    registerHostSurfaceRenderer('portrait_dock.workspace', () => createElement('div', {}, 'portrait-dock'))
    const { root } = ownedRoot()
    const surfaceHelper = helper(1, permission => permission === 'ui_panels')
    const quickToolbar = surfaceHelper.mountHostSurface(root, 'quick_toolbar.workspace', {
      contractVersion: 1,
      ownerToken: EXTENSION_ID,
      generation: 1,
      capabilities: [],
      state: { enabled: true, variant: 'v1-free' },
    })
    const portraitDock = surfaceHelper.mountHostSurface(root, 'portrait_dock.workspace', {
      contractVersion: 1,
      ownerToken: EXTENSION_ID,
      generation: 1,
      capabilities: [],
      state: { enabled: true, mode: 'side-right' },
    })

    expect(root.textContent).toContain('quick-toolbar')
    expect(root.textContent).toContain('portrait-dock')
    portraitDock.destroy()
    expect(root.textContent).toContain('quick-toolbar')
    quickToolbar.destroy()
  })

  test('bridges router context into detached host-surface roots', async () => {
    function NavigatingSurface() {
      const navigate = useNavigate()
      return createElement('button', { onClick: () => navigate('/characters') }, 'route-ready')
    }

    const appRoot = document.createElement('div')
    document.body.append(appRoot)
    let app: Root | undefined
    const router = createMemoryRouter([
      { path: '/', element: createElement(RouterContextExporter) },
      { path: '/characters', element: createElement(RouterContextExporter) },
    ], { initialEntries: ['/'] })

    try {
      app = createRoot(appRoot)
      app.render(createElement(RouterProvider, { router }))
      await new Promise<void>(resolve => setTimeout(resolve, 0))

      registerHostSurfaceRenderer('homepage_character_library', () => createElement(NavigatingSurface))
      const { root } = ownedRoot()
      const surface = helper().mountHostSurface(root, 'homepage_character_library', {})
      await new Promise<void>(resolve => setTimeout(resolve, 0))

      const button = root.querySelector<HTMLButtonElement>('button')
      expect(button?.textContent).toBe('route-ready')
      button?.click()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(router.state.location.pathname).toBe('/characters')
      surface.destroy()
    } finally {
      app?.unmount()
    }
  })
})
