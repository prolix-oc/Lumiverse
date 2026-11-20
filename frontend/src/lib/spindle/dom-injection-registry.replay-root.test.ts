/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from 'bun:test'
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
  MutationObserver: jsdom.window.MutationObserver,
  Node: jsdom.window.Node,
  navigator: jsdom.window.navigator,
  localStorage: jsdom.window.localStorage,
})

const { createDOMHelper } = await import('./dom-helper')
const { _resetInjectionRegistry, replay } = await import('./dom-injection-registry')

const extensionId = '00000000-0000-0000-0000-000000000001'
const messageId = 'message-row-replay'

/** The chat list's shape: a virtual row and the bubble card inside it both carry the message id. */
function mountRow(): { row: HTMLElement; card: HTMLElement } {
  const row = document.createElement('div')
  row.setAttribute('data-message-id', messageId)
  row.setAttribute('data-virtual-index', '0')
  const card = document.createElement('div')
  card.setAttribute('data-message-id', messageId)
  card.innerHTML = '<div class="bubble"><div class="content"></div></div>'
  row.appendChild(card)
  document.body.appendChild(row)
  return { row, card }
}

/** The bubble remounts inside the same row (React re-creates the card). */
function remountCard(row: HTMLElement, card: HTMLElement): HTMLElement {
  const fresh = card.cloneNode(true) as HTMLElement
  // A real remount renders only React's own markup — no extension wrappers.
  for (const injected of Array.from(fresh.querySelectorAll('[data-spindle-inj-id]'))) injected.remove()
  card.replaceWith(fresh)
  return fresh
}

describe('dom.inject replay root', () => {
  afterEach(() => {
    _resetInjectionRegistry()
    document.body.innerHTML = ''
  })

  test('an injection into the list row stays in the row when the bubble remounts', () => {
    const helper = createDOMHelper(extensionId, 'replay_root_test')
    const { row, card } = mountRow()
    // findMessageElement returns the first match in document order: the row.
    const target = helper.findMessageElement(messageId)!
    expect(target).toBe(row)
    const wrapper = helper.inject(target, '<div class="chips">chips</div>', 'beforeend')
    expect(wrapper.parentElement).toBe(row)

    const fresh = remountCard(row, card)
    replay(messageId, fresh)

    expect(wrapper.parentElement).toBe(row)
    expect(fresh.contains(wrapper)).toBe(false)
  })

  test('the row and its injections remount together', () => {
    const helper = createDOMHelper(extensionId, 'replay_root_test')
    const first = mountRow()
    const wrapper = helper.inject(first.row, '<div class="chips">chips</div>', 'beforeend')

    first.row.remove()
    const second = mountRow()
    replay(messageId, second.card)

    expect(wrapper.parentElement).toBe(second.row)
    expect(second.card.contains(wrapper)).toBe(false)
  })

  test('an injection inside the bubble still replays inside the bubble', () => {
    const helper = createDOMHelper(extensionId, 'replay_root_test')
    const { row, card } = mountRow()
    const wrapper = helper.inject(card.querySelector('.content')!, '<span>inline</span>', 'beforeend')

    const fresh = remountCard(row, card)
    replay(messageId, fresh)

    expect(wrapper.parentElement).toBe(fresh.querySelector('.content'))
  })
})
