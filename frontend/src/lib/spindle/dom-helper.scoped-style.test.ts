/// <reference types="bun-types" />

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'

mock.module('@/store', () => ({
  useStore: {
    getState: () => ({ messages: [] }),
    subscribe: () => () => {},
  },
}))

const jsdom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://localhost/',
})

Object.assign(globalThis, {
  window: jsdom.window,
  document: jsdom.window.document,
  Element: jsdom.window.Element,
  HTMLElement: jsdom.window.HTMLElement,
  HTMLStyleElement: jsdom.window.HTMLStyleElement,
  MutationObserver: jsdom.window.MutationObserver,
  Node: jsdom.window.Node,
  navigator: jsdom.window.navigator,
  localStorage: jsdom.window.localStorage,
})
Object.defineProperty(globalThis, 'CSSScopeRule', {
  configurable: true,
  value: undefined,
  writable: true,
})

const { createDOMHelper, buildScopedStylePrelude } = await import('./dom-helper')
const {
  forgetExtensionIdentity,
  registerExtensionIdentity,
  stampExtensionRoot,
} = await import('./extension-root-stamp')
const {
  register: registerInjection,
  replay,
  unregisterByMessageId,
} = await import('./dom-injection-registry')

const extensionId = '00000000-0000-0000-0000-000000000001'
const foreignExtensionId = '00000000-0000-0000-0000-000000000002'
const identifier = 'lumiverse_suite'
const scopeSelector = `[data-spindle-ext-id="${identifier}"]`

function newHelper(id = extensionId, manifestIdentifier = identifier) {
  return createDOMHelper(id, manifestIdentifier)
}

function cssText(style: HTMLStyleElement): string {
  return Array.from(style.sheet?.cssRules ?? [], (rule) => rule.cssText).join('\n')
}

beforeEach(() => {
  document.body.replaceChildren()
  document.head.querySelectorAll('style').forEach((style) => style.remove())
  forgetExtensionIdentity(extensionId)
  forgetExtensionIdentity(foreignExtensionId)
  registerExtensionIdentity(extensionId, identifier)
  registerExtensionIdentity(foreignExtensionId, 'foreign_suite')
})

describe('scoped extension styles', () => {
  test('builds the exact host-side prelude from the manifest identifier', () => {
    expect(buildScopedStylePrelude(identifier)).toBe(
      '@scope ([data-spindle-ext-id="lumiverse_suite"])',
    )
    expect(buildScopedStylePrelude(identifier)).not.toContain(extensionId)
    expect(() => buildScopedStylePrelude('Lumiverse-Suite')).toThrow('SCOPE_IDENTIFIER_INVALID')
  })

  test('rewrites fallback rules conservatively and keeps foreign roots out', () => {
    const helper = newHelper()
    const ownerRoot = document.createElement('section')
    ownerRoot.className = 'card'
    stampExtensionRoot(ownerRoot, extensionId, 'data-spindle-extension-root')
    const ownerChild = document.createElement('div')
    ownerChild.className = 'card'
    ownerRoot.append(ownerChild)

    const foreignRoot = document.createElement('section')
    foreignRoot.className = 'card'
    stampExtensionRoot(foreignRoot, foreignExtensionId, 'data-spindle-extension-root')
    const outside = document.createElement('div')
    outside.className = 'card'

    const messageRoot = document.createElement('article')
    messageRoot.setAttribute('data-message-id', 'message-1')
    const injectionTarget = document.createElement('div')
    messageRoot.append(injectionTarget)
    document.body.append(ownerRoot, foreignRoot, outside, messageRoot)
    const wrapper = helper.inject(injectionTarget, '<div class="injected-card"></div>')

    const style = document.head.querySelector('style')
    expect(style).toBeNull()
    const remove = helper.addStyle(
      '.card, .injected-card { color: red; } @media (min-width: 1px) { .media-card { color: blue; } } @supports (display: grid) { .supports-card { display: grid; } }',
      { scope: 'root' },
    )
    const scopedStyle = document.head.querySelector('style') as HTMLStyleElement
    const rewritten = cssText(scopedStyle)
    expect(rewritten).toContain(`${scopeSelector}.card`)
    expect(rewritten).toContain(`${scopeSelector} .card`)
    expect(rewritten).toContain(`${scopeSelector}.injected-card`)
    expect(rewritten).toContain(`${scopeSelector} .injected-card`)
    expect(rewritten).toContain(`${scopeSelector}.media-card`)
    expect(rewritten).toContain(`${scopeSelector}.supports-card`)
    expect(ownerRoot.matches(`${scopeSelector}.card`)).toBe(true)
    expect(ownerChild.matches(`${scopeSelector} .card`)).toBe(true)
    expect(foreignRoot.matches(`${scopeSelector}.card`)).toBe(false)
    expect(outside.matches(`${scopeSelector}.card`)).toBe(false)
    expect(wrapper.getAttribute('data-spindle-ext-id')).toBe(identifier)
    expect(wrapper.querySelector('.injected-card')).not.toBeNull()

    remove()
    expect(document.head.querySelector('style')).toBeNull()
    helper.cleanup()
  })

  test('replays a missing injection wrapper with the scope metadata restored', () => {
    const messageRoot = document.createElement('article')
    messageRoot.setAttribute('data-message-id', 'message-replay')
    const target = document.createElement('div')
    messageRoot.append(target)
    document.body.append(messageRoot)

    registerInjection('message-replay', {
      injectionId: 'replay-1',
      extensionId,
      rawHtml: '<span class="replayed-card">replayed</span>',
      relativePath: ':nth-child(1)',
      position: 'beforeend',
      element: null,
    })
    replay('message-replay', messageRoot)

    const wrapper = target.querySelector('[data-spindle-inj-id="replay-1"]')
    expect(wrapper?.getAttribute('data-spindle-ext-id')).toBe(identifier)
    expect(wrapper?.querySelector('.replayed-card')).not.toBeNull()
    unregisterByMessageId('message-replay')
  })

  test('keeps global styles unchanged and strips caller-owned root attributes', () => {
    const helper = newHelper()
    const remove = helper.addStyle('.global-card { color: red; }')
    const style = document.head.querySelector('style') as HTMLStyleElement
    expect(style.textContent).toBe('.global-card { color: red; }')
    expect(style.getAttribute('data-spindle-ext')).toBe(extensionId)

    const created = helper.createElement('div', {
      'data-spindle-ext': foreignExtensionId,
      'data-spindle-extension-root': foreignExtensionId,
      'data-spindle-extension-id': foreignExtensionId,
      'data-spindle-ext-id': 'foreign_suite',
      'data-test': 'kept',
    })
    expect(created.getAttribute('data-spindle-ext')).toBe(extensionId)
    expect(created.getAttribute('data-spindle-extension-root')).toBeNull()
    expect(created.getAttribute('data-spindle-extension-id')).toBeNull()
    expect(created.getAttribute('data-spindle-ext-id')).toBe(identifier)
    expect(created.getAttribute('data-test')).toBe('kept')

    remove()
    helper.cleanup()
  })
})
