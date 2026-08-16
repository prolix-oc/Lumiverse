/// <reference types="bun-types" />

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

let rafCalls = 0
const rafImpl = (cb: FrameRequestCallback) => {
  rafCalls += 1
  return 1
}
const cafImpl = (_id: number) => {}

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: rafImpl,
  cancelAnimationFrame: cafImpl,
})
Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: rafImpl })
Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: cafImpl })

const {
  createSpindleMountHost,
  flushDomDecoratorWork,
  getDomDecoratorService,
  resetDomDecoratorServicesForTests,
} = await import('./dom-decorator-service')
const { installSpindleExtensionDiagnostics, readSpindleExtensionCounters } = await import('./extension-diagnostics')

const OWNER = '00000000-0000-0000-0000-000000000014'

afterAll(() => {
  resetDomDecoratorServicesForTests()
})

beforeEach(() => {
  document.body.replaceChildren()
  resetDomDecoratorServicesForTests()
  installSpindleExtensionDiagnostics()
  rafCalls = 0
})

function counters(generation: number) {
  return readSpindleExtensionCounters(OWNER, generation)
}

describe('dom decorator service lifecycle', () => {
  test('registers and unregisters a ref anchor with required scope', () => {
    const service = getDomDecoratorService()
    const host = createSpindleMountHost({ mount: 'chat_toolbar', scope: 'chat:c1:toolbar', owner: OWNER, generation: 1 })
    document.body.append(host)
    expect(() => service.registerAnchor({
      mount: 'chat_toolbar',
      scope: '   ',
      owner: OWNER,
      generation: 1,
      node: host,
    })).toThrow('SPINDLE_DECORATOR_SCOPE_REQUIRED')

    const registration = service.registerAnchor({
      mount: 'chat_toolbar',
      scope: 'chat:c1:toolbar',
      owner: OWNER,
      generation: 1,
      node: host,
    })
    flushDomDecoratorWork()
    expect(registration.scope).toBe('chat:c1:toolbar')
    expect(registration.liveAnchorId).toMatch(/^live-anchor:/)
    expect(host.querySelector('[data-spindle-extension-root]')).toBeTruthy()
    expect(counters(1).registrations).toBe(1)
    expect(counters(1).roots).toBe(1)

    service.unregisterAnchor(host)
    flushDomDecoratorWork()
    expect(service.getRegistration(host)).toBeNull()
    expect(host.querySelector('[data-spindle-extension-root]')).toBeNull()
    expect(counters(1).registrations).toBe(0)
    expect(counters(1).roots).toBe(0)
  })

  test('moves a reused React node from scope A to scope B without stale root', () => {
    const service = getDomDecoratorService()
    const host = createSpindleMountHost({ mount: 'message_footer', scope: 'message:a:footer', owner: OWNER, generation: 1 })
    document.body.append(host)
    service.registerAnchor({
      mount: 'message_footer',
      scope: 'message:a:footer',
      owner: OWNER,
      generation: 1,
      node: host,
    })
    service.registerDecorator({
      mount: 'message_footer',
      owner: OWNER,
      generation: 1,
      html: '<span data-scope-mark="live"></span>',
    })
    flushDomDecoratorWork()
    const rootA = service.getRoot(OWNER, 1, 'message_footer', 'message:a:footer')
    expect(rootA).toBeTruthy()

    host.setAttribute('data-spindle-scope', 'message:b:footer')
    service.registerAnchor({
      mount: 'message_footer',
      scope: 'message:b:footer',
      owner: OWNER,
      generation: 1,
      node: host,
    })
    flushDomDecoratorWork()

    expect(service.getRoot(OWNER, 1, 'message_footer', 'message:a:footer')).toBeNull()
    expect(service.getRoot(OWNER, 1, 'message_footer', 'message:b:footer')).toBeTruthy()
    expect(host.querySelectorAll('[data-spindle-extension-root]')).toHaveLength(1)
    expect(service.getRegistration(host)?.scope).toBe('message:b:footer')
  })

  test('keeps repeated concurrent rows isolated by live-anchor identity', () => {
    const service = getDomDecoratorService()
    const rowA = createSpindleMountHost({ mount: 'world_book_entry_row', scope: 'world-book-entry:1:row', owner: OWNER, generation: 1 })
    const rowB = createSpindleMountHost({ mount: 'world_book_entry_row', scope: 'world-book-entry:2:row', owner: OWNER, generation: 1 })
    document.body.append(rowA, rowB)
    const a = service.registerAnchor({
      mount: 'world_book_entry_row',
      scope: 'world-book-entry:1:row',
      owner: OWNER,
      generation: 1,
      node: rowA,
    })
    const b = service.registerAnchor({
      mount: 'world_book_entry_row',
      scope: 'world-book-entry:2:row',
      owner: OWNER,
      generation: 1,
      node: rowB,
    })
    service.registerDecorator({
      mount: 'world_book_entry_row',
      owner: OWNER,
      generation: 1,
      render: (root, ctx) => {
        root.setAttribute('data-live-id', ctx.liveAnchorId)
      },
    })
    flushDomDecoratorWork()

    expect(a.liveAnchorId).not.toBe(b.liveAnchorId)
    expect(service.getRoot(OWNER, 1, 'world_book_entry_row', 'world-book-entry:1:row')).not.toBe(
      service.getRoot(OWNER, 1, 'world_book_entry_row', 'world-book-entry:2:row'),
    )
    expect(counters(1).roots).toBe(2)
    expect(counters(1).registrations).toBe(2)
  })

  test('recycles virtualized anchors without stale callbacks', () => {
    const service = getDomDecoratorService()
    const host = createSpindleMountHost({ mount: 'message_header', scope: 'message:old:header', owner: OWNER, generation: 1 })
    document.body.append(host)
    const seen: string[] = []
    const disposed: string[] = []
    service.registerDecorator({
      mount: 'message_header',
      owner: OWNER,
      generation: 1,
      render: (_root, ctx) => {
        seen.push(ctx.scope)
        return () => disposed.push(ctx.scope)
      },
    })
    service.registerAnchor({
      mount: 'message_header',
      scope: 'message:old:header',
      owner: OWNER,
      generation: 1,
      node: host,
    })
    flushDomDecoratorWork()
    expect(seen).toEqual(['message:old:header'])

    service.registerAnchor({
      mount: 'message_header',
      scope: 'message:new:header',
      owner: OWNER,
      generation: 1,
      node: host,
    })
    flushDomDecoratorWork()
    expect(disposed).toContain('message:old:header')
    expect(seen).toEqual(['message:old:header', 'message:new:header'])
    expect(service.getRoot(OWNER, 1, 'message_header', 'message:old:header')).toBeNull()
  })

  test('removes a detached portal anchor before replay', () => {
    const service = getDomDecoratorService()
    const portal = createSpindleMountHost({
      mount: 'message_context_menu',
      scope: 'message:msg-1:context-menu',
      owner: OWNER,
      generation: 1,
    })
    document.body.append(portal)
    service.registerAnchor({
      mount: 'message_context_menu',
      scope: 'message:msg-1:context-menu',
      owner: OWNER,
      generation: 1,
      node: portal,
    })
    service.registerDecorator({
      mount: 'message_context_menu',
      owner: OWNER,
      generation: 1,
      html: '<div data-portal="1">menu</div>',
    })
    flushDomDecoratorWork()
    expect(portal.querySelector('[data-portal="1"]')).toBeTruthy()

    service.detachPortal(portal)
    service.replay()
    flushDomDecoratorWork()
    expect(service.getRegistration(portal)).toBeNull()
    expect(portal.querySelector('[data-spindle-extension-root]')).toBeNull()
    expect(portal.querySelector('[data-portal="1"]')).toBeNull()
  })

  test('removes generation resources on unload and creates fresh resources on reload', () => {
    const service = getDomDecoratorService()
    const host = createSpindleMountHost({ mount: 'settings_extensions', scope: 'settings:extensions:general', owner: OWNER, generation: 1 })
    document.body.append(host)
    const first = service.registerAnchor({
      mount: 'settings_extensions',
      scope: 'settings:extensions:general',
      owner: OWNER,
      generation: 1,
      node: host,
    })
    flushDomDecoratorWork()
    service.unloadGeneration(OWNER, 1)
    flushDomDecoratorWork()
    expect(counters(1).roots).toBe(0)
    expect(counters(1).registrations).toBe(0)
    expect(counters(1).callbacks).toBe(0)
    expect(counters(1).injectedNodes).toBe(0)
    expect(host.querySelector('[data-spindle-extension-root]')).toBeNull()

    const second = service.registerAnchor({
      mount: 'settings_extensions',
      scope: 'settings:extensions:general',
      owner: OWNER,
      generation: 2,
      node: host,
    })
    flushDomDecoratorWork()
    expect(second.liveAnchorId).not.toBe(first.liveAnchorId)
    expect(counters(2).registrations).toBe(1)
    expect(counters(2).roots).toBe(1)
    expect(counters(1).roots).toBe(0)
  })

  test('legacy observer fallback does not create duplicate root', () => {
    const service = getDomDecoratorService()
    const host = createSpindleMountHost({
      mount: 'landing_header',
      scope: 'landing:header',
      owner: OWNER,
      generation: 1,
    })
    document.body.append(host)
    service.registerAnchor({
      mount: 'landing_header',
      scope: 'landing:header',
      owner: OWNER,
      generation: 1,
      node: host,
    })
    flushDomDecoratorWork()
    expect(counters(1).roots).toBe(1)
    service.ensureLegacyObserver()
    service.scanLegacyHosts()
    flushDomDecoratorWork()
    expect(host.querySelectorAll('[data-spindle-extension-root]')).toHaveLength(1)
    expect(counters(1).roots).toBe(1)
    expect(counters(1).registrations).toBe(1)
  })

  test('shares one observer per host runtime', () => {
    const runtime = {}
    const first = getDomDecoratorService(runtime)
    const second = getDomDecoratorService(runtime)
    expect(first).toBe(second)
    const host = createSpindleMountHost({ mount: 'landing_footer', scope: 'landing:footer', owner: OWNER, generation: 1 })
    document.body.append(host)
    first.registerAnchor({
      mount: 'landing_footer',
      scope: 'landing:footer',
      owner: OWNER,
      generation: 1,
      node: host,
    })
    first.ensureLegacyObserver()
    second.ensureLegacyObserver()
    flushDomDecoratorWork()
    expect(counters(1).decoratorObservers).toBe(1)
  })

  test('does not create duplicate root for generation mount scope', () => {
    const service = getDomDecoratorService()
    const host = createSpindleMountHost({ mount: 'chat_actions', scope: 'chat:c1:actions', owner: OWNER, generation: 1 })
    document.body.append(host)
    const first = service.registerAnchor({
      mount: 'chat_actions',
      scope: 'chat:c1:actions',
      owner: OWNER,
      generation: 1,
      node: host,
    })
    const again = service.registerAnchor({
      mount: 'chat_actions',
      scope: 'chat:c1:actions',
      owner: OWNER,
      generation: 1,
      node: host,
    })
    service.registerDecorator({
      mount: 'chat_actions',
      owner: OWNER,
      generation: 1,
      html: '<span>one</span>',
    })
    service.registerDecorator({
      mount: 'chat_actions',
      owner: OWNER,
      generation: 1,
      html: '<span>still-one</span>',
    })
    flushDomDecoratorWork()
    expect(again.liveAnchorId).toBe(first.liveAnchorId)
    expect(host.querySelectorAll('[data-spindle-extension-root]')).toHaveLength(1)
    expect(counters(1).roots).toBe(1)
  })

  test('teardown removes all generation roots', () => {
    const service = getDomDecoratorService()
    const a = createSpindleMountHost({ mount: 'chat_top_dock', scope: 'chat:c1:top-dock', owner: OWNER, generation: 7 })
    const b = createSpindleMountHost({ mount: 'chat_bottom_dock', scope: 'chat:c1:bottom-dock', owner: OWNER, generation: 7 })
    document.body.append(a, b)
    service.registerAnchor({ mount: 'chat_top_dock', scope: 'chat:c1:top-dock', owner: OWNER, generation: 7, node: a })
    service.registerAnchor({ mount: 'chat_bottom_dock', scope: 'chat:c1:bottom-dock', owner: OWNER, generation: 7, node: b })
    flushDomDecoratorWork()
    expect(counters(7).roots).toBe(2)
    service.unloadGeneration(OWNER, 7)
    flushDomDecoratorWork()
    expect(counters(7).roots).toBe(0)
    expect(counters(7).registrations).toBe(0)
    expect(document.querySelectorAll('[data-spindle-extension-root]')).toHaveLength(0)
  })

  test('batches mount and teardown to one animation frame', () => {
    const service = getDomDecoratorService()
    const first = createSpindleMountHost({ mount: 'drawer_footer', scope: 'drawer:footer', owner: OWNER, generation: 1 })
    const second = createSpindleMountHost({ mount: 'drawer_header_actions', scope: 'drawer:header-actions', owner: OWNER, generation: 1 })
    document.body.append(first, second)
    rafCalls = 0
    service.registerAnchor({ mount: 'drawer_footer', scope: 'drawer:footer', owner: OWNER, generation: 1, node: first })
    service.registerAnchor({
      mount: 'drawer_header_actions',
      scope: 'drawer:header-actions',
      owner: OWNER,
      generation: 1,
      node: second,
    })
    service.unregisterAnchor(second)
    expect(rafCalls).toBe(1)
    flushDomDecoratorWork()
    expect(first.querySelector('[data-spindle-extension-root]')).toBeTruthy()
    expect(second.querySelector('[data-spindle-extension-root]')).toBeNull()
  })

  test('rejects unsafe HTML/SVG and leaves no extension root after unload', () => {
    const service = getDomDecoratorService()
    const host = createSpindleMountHost({ mount: 'modal_header_actions', scope: 'modal:m1:header-actions', owner: OWNER, generation: 1 })
    document.body.append(host)
    service.registerAnchor({
      mount: 'modal_header_actions',
      scope: 'modal:m1:header-actions',
      owner: OWNER,
      generation: 1,
      node: host,
    })
    service.registerDecorator({
      mount: 'modal_header_actions',
      owner: OWNER,
      generation: 1,
      html: '<script>window.__pwned=1</script><img src="x" onerror="alert(1)"><div data-spindle-extension-root="forged">x</div>',
      svg: '<svg onload="alert(1)"><image href="https://evil.example/x.png"></image></svg>',
    })
    flushDomDecoratorWork()
    expect(host.querySelector('script')).toBeNull()
    expect(host.querySelector('[onload]')).toBeNull()
    expect(host.querySelector('[onerror]')).toBeNull()
    expect(host.querySelector('[data-spindle-extension-root="forged"]')).toBeNull()
    expect(host.querySelector('[data-spindle-extension-root]')?.getAttribute('data-spindle-extension-root')).toBe(OWNER)
    service.unloadGeneration(OWNER, 1)
    flushDomDecoratorWork()
    expect(document.querySelector('[data-spindle-extension-root]')).toBeNull()
    expect(counters(1).roots).toBe(0)
    expect(counters(1).injectedNodes).toBe(0)
  })

  test('clears root metadata callbacks observer entries and injected nodes on portal detach', () => {
    const service = getDomDecoratorService()
    const portal = createSpindleMountHost({
      mount: 'message_context_menu',
      scope: 'message:msg-2:context-menu',
      owner: OWNER,
      generation: 1,
    })
    document.body.append(portal)
    service.registerAnchor({
      mount: 'message_context_menu',
      scope: 'message:msg-2:context-menu',
      owner: OWNER,
      generation: 1,
      node: portal,
    })
    service.registerDecorator({
      mount: 'message_context_menu',
      owner: OWNER,
      generation: 1,
      kind: 'context-action',
      html: '<span data-action="copy">copy</span>',
      render: () => () => {},
    })
    service.ensureLegacyObserver()
    flushDomDecoratorWork()
    expect(counters(1).roots).toBeGreaterThan(0)
    expect(counters(1).injectedNodes).toBeGreaterThan(0)

    service.detachPortal(portal)
    flushDomDecoratorWork()
    expect(service.getRegistration(portal)).toBeNull()
    expect(portal.querySelector('[data-spindle-extension-root]')).toBeNull()
    expect(counters(1).roots).toBe(0)
    expect(counters(1).callbacks).toBe(0)
    expect(counters(1).injectedNodes).toBe(0)
    expect(counters(1).registrations).toBe(0)
  })

  test('clears owner generation resources before reload', () => {
    const service = getDomDecoratorService()
    const host = createSpindleMountHost({ mount: 'command_palette_actions', scope: 'command-palette:actions', owner: OWNER, generation: 8 })
    document.body.append(host)
    service.registerAnchor({
      mount: 'command_palette_actions',
      scope: 'command-palette:actions',
      owner: OWNER,
      generation: 8,
      node: host,
    })
    service.registerDecorator({
      mount: 'command_palette_actions',
      owner: OWNER,
      generation: 8,
      html: '<button data-cmd="x">x</button>',
      render: () => () => {},
    })
    flushDomDecoratorWork()
    expect(counters(8).registrations).toBe(1)

    service.unloadGeneration(OWNER, 8)
    flushDomDecoratorWork()
    expect(counters(8).roots).toBe(0)
    expect(counters(8).callbacks).toBe(0)
    expect(counters(8).injectedNodes).toBe(0)
    expect(counters(8).registrations).toBe(0)
    expect(counters(8).decoratorObservers).toBe(0)

    service.registerAnchor({
      mount: 'command_palette_actions',
      scope: 'command-palette:actions',
      owner: OWNER,
      generation: 9,
      node: host,
    })
    flushDomDecoratorWork()
    expect(counters(9).registrations).toBe(1)
    expect(counters(8).registrations).toBe(0)
  })
})
