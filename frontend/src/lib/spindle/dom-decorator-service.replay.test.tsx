/// <reference types="bun-types" />

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => dom.window.clearTimeout(id),
})

const {
  createSpindleMountHost,
  flushDomDecoratorWork,
  getDomDecoratorService,
  resetDomDecoratorServicesForTests,
} = await import('./dom-decorator-service')
const { installSpindleExtensionDiagnostics, readSpindleExtensionCounters } = await import('./extension-diagnostics')

const OWNER = '00000000-0000-0000-0000-000000000012'
const GENERATION = 3

afterAll(() => {
  resetDomDecoratorServicesForTests()
})

beforeEach(() => {
  document.body.replaceChildren()
  resetDomDecoratorServicesForTests()
  installSpindleExtensionDiagnostics()
})

describe('dom decorator service replay', () => {
  test('replays repeated and virtualized mount anchors by stable key', () => {
    const service = getDomDecoratorService()
    const first = createSpindleMountHost({
      mount: 'message_footer',
      scope: 'message:msg-a:footer',
      owner: OWNER,
      generation: GENERATION,
    })
    const second = createSpindleMountHost({
      mount: 'message_footer',
      scope: 'message:msg-b:footer',
      owner: OWNER,
      generation: GENERATION,
    })
    document.body.append(first, second)

    service.registerAnchor({
      mount: 'message_footer',
      scope: 'message:msg-a:footer',
      owner: OWNER,
      generation: GENERATION,
      node: first,
    })
    service.registerAnchor({
      mount: 'message_footer',
      scope: 'message:msg-b:footer',
      owner: OWNER,
      generation: GENERATION,
      node: second,
    })
    service.registerDecorator({
      mount: 'message_footer',
      owner: OWNER,
      generation: GENERATION,
      kind: 'badge',
      html: '<span data-replay-mark="live">badge</span>',
    })
    flushDomDecoratorWork()

    expect(first.querySelector('[data-replay-mark="live"]')).toBeTruthy()
    expect(second.querySelector('[data-replay-mark="live"]')).toBeTruthy()
    expect(first.querySelector('[data-spindle-extension-root]')).not.toBe(second.querySelector('[data-spindle-extension-root]'))

    service.unregisterAnchor(first)
    first.remove()
    flushDomDecoratorWork()
    expect(document.querySelector('[data-spindle-scope="message:msg-a:footer"] [data-replay-mark="live"]')).toBeNull()

    const remounted = createSpindleMountHost({
      mount: 'message_footer',
      scope: 'message:msg-a:footer',
      owner: OWNER,
      generation: GENERATION,
    })
    document.body.append(remounted)
    service.registerAnchor({
      mount: 'message_footer',
      scope: 'message:msg-a:footer',
      owner: OWNER,
      generation: GENERATION,
      node: remounted,
    })
    flushDomDecoratorWork()

    expect(remounted.querySelector('[data-replay-mark="live"]')?.textContent).toBe('badge')
    expect(second.querySelector('[data-replay-mark="live"]')?.textContent).toBe('badge')
    expect(readSpindleExtensionCounters(OWNER, GENERATION).registrations).toBe(2)
  })

  test('replays message_header by message id', () => {
    const service = getDomDecoratorService()
    const host = createSpindleMountHost({
      mount: 'message_header',
      scope: 'message:msg-9:header',
      owner: OWNER,
      generation: GENERATION,
    })
    document.body.append(host)
    service.registerAnchor({
      mount: 'message_header',
      scope: 'message:msg-9:header',
      owner: OWNER,
      generation: GENERATION,
      node: host,
    })
    service.registerDecorator({
      mount: 'message_header',
      owner: OWNER,
      generation: GENERATION,
      html: '<em data-header="msg-9">h</em>',
    })
    flushDomDecoratorWork()
    expect(host.querySelector('[data-header="msg-9"]')).toBeTruthy()
  })
})
