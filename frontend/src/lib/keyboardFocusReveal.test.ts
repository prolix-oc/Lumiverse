import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { installKeyboardFocusReveal, revealKeyboardFocus } from './keyboardFocusReveal'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const globals = globalThis as unknown as Record<string, unknown>
const replacements = {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
}
const originals = Object.fromEntries(Object.keys(replacements).map(key => [key, globals[key]]))
Object.assign(globals, replacements)

const viewport = Object.assign(new dom.window.EventTarget(), { height: 400, offsetTop: 0 })
Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
let frameId = 0
const frames = new Map<number, FrameRequestCallback>()
window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId }
window.cancelAnimationFrame = id => { frames.delete(id) }
function flushFrames() {
  const pending = [...frames.values()]
  frames.clear()
  for (const callback of pending) callback(0)
}

function setRect(element: HTMLElement, top: number, height: number) {
  element.getBoundingClientRect = () => ({
    top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON() {},
  })
}

let container: HTMLDivElement
let target: HTMLTextAreaElement
let uninstall: (() => void) | undefined
beforeEach(() => {
  container = document.createElement('div')
  container.style.overflowY = 'auto'
  setRect(container, 0, 800)
  Object.defineProperty(container, 'offsetHeight', { configurable: true, value: 800 })
  target = document.createElement('textarea')
  container.append(target)
  document.body.append(container)
  viewport.height = 400
  viewport.offsetTop = 0
})
afterEach(() => {
  uninstall?.()
  uninstall = undefined
  document.body.replaceChildren()
  frames.clear()
})
afterAll(() => {
  Object.assign(globals, originals)
  dom.window.close()
})

describe('keyboard focus reveal', () => {
  test('does not confuse a document-height editor with a caret at its bottom', () => {
    setRect(target, 80, 6000)
    container.scrollTop = 200
    revealKeyboardFocus(target)
    expect(container.scrollTop).toBe(200)
  })

  test('reveals a small field below the keyboard, but leaves visible fields alone', () => {
    setRect(target, 450, 40)
    revealKeyboardFocus(target)
    expect(container.scrollTop).toBe(108)
    setRect(target, 200, 40)
    revealKeyboardFocus(target)
    expect(container.scrollTop).toBe(108)
  })

  test('reveals a field above the visible region without bottom-aligning it', () => {
    setRect(target, -30, 40)
    container.scrollTop = 100
    revealKeyboardFocus(target)
    expect(container.scrollTop).toBe(58)
  })

  test('converts scroll deltas to local units under fractional UI zoom', () => {
    Object.defineProperty(container, 'offsetHeight', { value: 640 })
    setRect(target, 450, 40)
    revealKeyboardFocus(target)
    expect(container.scrollTop).toBe(108 / 1.25)
  })

  test('accounts for a panned visual viewport', () => {
    viewport.offsetTop = 100
    setRect(target, 450, 40)
    revealKeyboardFocus(target)
    expect(container.scrollTop).toBe(8)
  })

  test('leaves self-positioned composers alone', () => {
    container.dataset.component = 'InputArea'
    setRect(target, 450, 40)
    revealKeyboardFocus(target)
    expect(container.scrollTop).toBe(0)
  })

  test('follows viewport resizing without a keyboard-animation timeout', () => {
    uninstall = installKeyboardFocusReveal()
    viewport.height = 800
    setRect(target, 450, 40)
    target.focus()
    flushFrames()
    expect(container.scrollTop).toBe(0)
    viewport.height = 400
    viewport.dispatchEvent(new dom.window.Event('resize'))
    window.dispatchEvent(new dom.window.Event('resize'))
    expect(frames.size).toBe(1)
    flushFrames()
    expect(container.scrollTop).toBe(108)
  })

  test('does not act on a blurred or removed editor', () => {
    uninstall = installKeyboardFocusReveal()
    setRect(target, 450, 40)
    target.focus()
    target.remove()
    flushFrames()
    expect(container.scrollTop).toBe(0)
  })

  test('uses current focus when moving between controls before a frame', () => {
    uninstall = installKeyboardFocusReveal()
    setRect(target, 450, 40)
    target.focus()
    const next = document.createElement('input')
    container.append(next)
    setRect(next, 200, 30)
    next.focus()
    flushFrames()
    expect(container.scrollTop).toBe(0)
  })

  test('uninstall cancels pending work and removes listeners', () => {
    const stop = installKeyboardFocusReveal()
    target.focus()
    expect(frames.size).toBe(1)
    stop()
    expect(frames.size).toBe(0)
    viewport.dispatchEvent(new dom.window.Event('resize'))
    expect(frames.size).toBe(0)
  })
})
