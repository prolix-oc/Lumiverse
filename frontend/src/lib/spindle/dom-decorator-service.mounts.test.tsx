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
Object.defineProperty(dom.window, 'requestAnimationFrame', {
  configurable: true,
  value: globalThis.requestAnimationFrame,
})
Object.defineProperty(dom.window, 'cancelAnimationFrame', {
  configurable: true,
  value: globalThis.cancelAnimationFrame,
})

const {
  CANONICAL_MOUNT_PLACEMENTS,
  createSpindleMountHost,
  flushDomDecoratorWork,
  getDomDecoratorService,
  resetDomDecoratorServicesForTests,
} = await import('./dom-decorator-service')
const { installSpindleExtensionDiagnostics } = await import('./extension-diagnostics')
const { registerExtensionIdentity } = await import('./extension-root-stamp')

const OWNER = '00000000-0000-0000-0000-000000000011'
const GENERATION = 1

afterAll(() => {
  resetDomDecoratorServicesForTests()
})

beforeEach(() => {
  document.body.replaceChildren()
  resetDomDecoratorServicesForTests()
  installSpindleExtensionDiagnostics()
  registerExtensionIdentity(OWNER, 'lumiverse_suite')
})

describe('dom decorator service mounts', () => {
  test('publishes 58 canonical mount literals', () => {
    expect(CANONICAL_MOUNT_PLACEMENTS).toHaveLength(58)
  })

  for (const record of CANONICAL_MOUNT_PLACEMENTS) {
    test(`mounts ${record.literal}`, () => {
      const scope = record.scopeTemplate
        .replace('${chatId}', 'chat-1')
        .replace('${message.id}', 'msg-1')
        .replace('${messageId}', 'msg-1')
        .replace('${tab.id}', 'tab-1')
        .replace('${characterId}', 'char-1')
        .replace('${character.id}', 'char-1')
        .replace('${presetId}', 'preset-1')
        .replace('${personaId}', 'persona-1')
        .replace('${bookId}', 'book-1')
        .replace('${entry.id}', 'entry-1')
        .replace('${entryId}', 'entry-1')
        .replace('${activeTabId}', 'general')
        .replace('${sectionId}', 'section-1')
        .replace('${cardId}', 'card-1')
        .replace('${modalId}', 'modal-1')
      const host = createSpindleMountHost({
        mount: record.literal,
        scope,
        owner: OWNER,
        generation: GENERATION,
      })
      document.body.append(host)
      const service = getDomDecoratorService()
      const registration = service.registerAnchor({
        mount: record.literal,
        scope,
        owner: OWNER,
        generation: GENERATION,
        node: host,
      })
      service.registerDecorator({
        mount: record.literal,
        owner: OWNER,
        generation: GENERATION,
        kind: 'badge',
        html: `<span data-mount-probe="${record.literal}">ok</span>`,
      })
      flushDomDecoratorWork()

      expect(registration.mount).toBe(record.literal)
      expect(registration.scope).toBe(scope)
      expect(registration.liveAnchorId).toBeTruthy()
      const root = host.querySelector('[data-spindle-extension-root]')
      expect(root).toBeTruthy()
      expect(root?.getAttribute('data-spindle-extension-root')).toBe(OWNER)
      expect(host.querySelector(`[data-mount-probe="${record.literal}"]`)?.textContent).toBe('ok')
    })
  }
})
