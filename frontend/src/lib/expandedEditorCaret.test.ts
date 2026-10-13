import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { getExpandedEditorCaretRect, installExpandedEditorCaretReveal, revealExpandedEditorCaret } from './expandedEditorCaret'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
let resize: () => void = () => {}
let disconnected = false
const globals = globalThis as unknown as Record<string, unknown>
const replacements = {
  window: dom.window,
  document: dom.window.document,
  NodeFilter: dom.window.NodeFilter,
  ResizeObserver: class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect() { disconnected = true }
  },
}
const originals = Object.fromEntries(Object.keys(replacements).map(key => [key, globals[key]]))
Object.assign(globals, replacements)
window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId }
window.cancelAnimationFrame = id => { frames.delete(id) }
const viewport = Object.assign(new dom.window.EventTarget(), { height: 400, offsetTop: 0 })
Object.defineProperty(window, 'visualViewport', { value: viewport })
function flush() {
  const pending = [...frames.values()]
  frames.clear()
  for (const callback of pending) callback(0)
}
function rect(top: number, height: number) {
  return new dom.window.DOMRect(0, top, 300, height) as DOMRect
}

let textarea: HTMLTextAreaElement
let mirror: HTMLPreElement
let scale = 1
let fieldHeight = 600
let fieldTop = () => 100
let caretOffset = 530
let rangeOffset = -1
let rangeText = ''
let uninstall: (() => void) | undefined
// jsdom does not lay out text. Supply Range geometry here; the browser check
// separately exercises the real wrapping, font scaling, and caret rectangles.
dom.window.Range.prototype.getBoundingClientRect = function () {
  rangeOffset = this.startOffset
  rangeText = this.startContainer.textContent ?? ''
  return rect(fieldTop() + (caretOffset - mirror.scrollTop) * scale, 20 * scale)
}
beforeEach(() => {
  textarea = document.createElement('textarea')
  mirror = document.createElement('pre')
  textarea.value = 'first second last'
  mirror.append('first ', Object.assign(document.createElement('span'), { textContent: 'second' }), ' last\n')
  document.body.append(textarea, mirror)
  scale = 1
  fieldHeight = 600
  fieldTop = () => 100
  caretOffset = 530
  viewport.height = 400
  viewport.offsetTop = 0
  disconnected = false
  textarea.getBoundingClientRect = () => rect(fieldTop(), fieldHeight * scale)
  Object.defineProperty(textarea, 'offsetHeight', { get: () => fieldHeight })
  textarea.setSelectionRange(8, 8)
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

describe('expanded editor caret visibility', () => {
  test('reveals an occluded caret, not the bottom of the field', () => {
    revealExpandedEditorCaret(textarea, mirror)
    expect(textarea.scrollTop).toBe(262)
    expect(mirror.scrollTop).toBe(262)
    expect(getExpandedEditorCaretRect(textarea, mirror)!.bottom).toBe(388)
    expect(textarea.selectionStart).toBe(8)
  })

  test('does nothing once native scrolling has already revealed the caret', () => {
    textarea.scrollTop = 300
    revealExpandedEditorCaret(textarea, mirror)
    expect(textarea.scrollTop).toBe(300)
    expect(mirror.scrollTop).toBe(300)
  })

  test('converts measured pixels to scroll units at fractional UI scale', () => {
    scale = 1.25
    revealExpandedEditorCaret(textarea, mirror)
    expect(getExpandedEditorCaretRect(textarea, mirror)!.bottom).toBe(385)
    expect(textarea.scrollTop).toBe(322)
  })

  test('accounts for visual viewport panning and an editor smaller than the viewport', () => {
    viewport.offsetTop = 50
    fieldHeight = 200
    revealExpandedEditorCaret(textarea, mirror)
    expect(getExpandedEditorCaretRect(textarea, mirror)!.bottom).toBe(288)
  })

  test('resolves selection offsets across highlight tokens and backward selections', () => {
    textarea.setSelectionRange(6, 15, 'backward')
    getExpandedEditorCaretRect(textarea, mirror)
    expect(rangeText).toBe('second')
    expect(rangeOffset).toBe(0)
    textarea.setSelectionRange(6, 15, 'forward')
    getExpandedEditorCaretRect(textarea, mirror)
    expect(rangeText).toBe(' last\n')
    expect(rangeOffset).toBe(3)
  })

  function scrollContainer() {
    const container = document.createElement('div')
    document.body.append(container)
    container.append(textarea, mirror)
    container.getBoundingClientRect = () => rect(0, 800 * scale)
    Object.defineProperty(container, 'offsetHeight', { value: 800 })
    return container
  }

  test('leaves the list alone when the caret is visible in a partly clipped field', () => {
    const container = scrollContainer()
    caretOffset = 20
    revealExpandedEditorCaret(textarea, mirror, { getScrollContainer: () => container })
    expect(container.scrollTop).toBe(0)
    expect(textarea.scrollTop).toBe(0)
  })

  test('uses internal scrolling before moving the surrounding list', () => {
    const container = scrollContainer()
    revealExpandedEditorCaret(textarea, mirror, { getScrollContainer: () => container })
    expect(container.scrollTop).toBe(0)
    expect(textarea.scrollTop).toBe(262)
  })

  test('moves only the remaining caret occlusion when native scrolling clamps', () => {
    const container = scrollContainer()
    scale = 1.25
    fieldHeight = 200
    caretOffset = 170
    fieldTop = () => 350 - container.scrollTop * scale
    // A short value fills this field, so its native scrollTop cannot increase.
    Object.defineProperty(textarea, 'scrollTop', { get: () => 0, set() {} })
    revealExpandedEditorCaret(textarea, mirror, { getScrollContainer: () => container })
    expect(container.scrollTop).toBe(162)
    expect(getExpandedEditorCaretRect(textarea, mirror)!.bottom).toBe(385)
    expect(textarea.selectionStart).toBe(8)
  })

  test('adopts manual list scrolling and still handles a new textarea selection', () => {
    const container = scrollContainer()
    fieldTop = () => 100 - container.scrollTop
    uninstall = installExpandedEditorCaretReveal(textarea, mirror, { getScrollContainer: () => container })
    textarea.focus()
    flush()
    container.scrollTop = 80
    textarea.scrollTop = 0
    container.dispatchEvent(new dom.window.Event('scroll'))
    viewport.dispatchEvent(new dom.window.Event('resize'))
    resize()
    flush()
    expect(container.scrollTop).toBe(80)
    expect(textarea.scrollTop).toBe(0)
    // Also respect scrolling between a duplicate notification and its frame.
    viewport.dispatchEvent(new dom.window.Event('resize'))
    container.scrollTop = 100
    container.dispatchEvent(new dom.window.Event('scroll'))
    flush()
    expect(container.scrollTop).toBe(100)
    expect(textarea.scrollTop).toBe(0)
    textarea.setSelectionRange(10, 10)
    textarea.dispatchEvent(new dom.window.Event('selectionchange'))
    flush()
    expect(getExpandedEditorCaretRect(textarea, mirror)!.bottom).toBe(388)
    expect(container.scrollTop).toBe(100)
  })

  test('rechecks visibility on refocus after a manual reading scroll', () => {
    uninstall = installExpandedEditorCaretReveal(textarea, mirror)
    textarea.focus()
    flush()
    textarea.scrollTop = 0
    textarea.blur()
    textarea.focus()
    flush()
    expect(textarea.scrollTop).toBe(262)
  })

  test('keeps a pending selection reveal when the list scrolls in the same frame', () => {
    const container = scrollContainer()
    fieldTop = () => 100 - container.scrollTop
    uninstall = installExpandedEditorCaretReveal(textarea, mirror, { getScrollContainer: () => container })
    textarea.focus()
    flush()
    textarea.setSelectionRange(10, 10)
    textarea.dispatchEvent(new dom.window.Event('selectionchange'))
    textarea.scrollTop = 0
    container.scrollTop = 80
    container.dispatchEvent(new dom.window.Event('scroll'))
    flush()
    expect(getExpandedEditorCaretRect(textarea, mirror)!.bottom).toBe(388)
  })

  test('keeps a real keyboard resize observable during a concurrent list scroll', () => {
    const container = scrollContainer()
    fieldTop = () => 100 - container.scrollTop
    uninstall = installExpandedEditorCaretReveal(textarea, mirror, { getScrollContainer: () => container })
    textarea.focus()
    flush()
    viewport.height = 350
    viewport.dispatchEvent(new dom.window.Event('resize'))
    textarea.scrollTop = 0
    container.scrollTop = 80
    container.dispatchEvent(new dom.window.Event('scroll'))
    flush()
    expect(getExpandedEditorCaretRect(textarea, mirror)!.bottom).toBe(338)
  })

  test('uses actual post-layout height when the keyboard resizes the editor', () => {
    uninstall = installExpandedEditorCaretReveal(textarea, mirror)
    viewport.height = 800
    textarea.focus()
    flush()
    expect(textarea.scrollTop).toBe(0)
    viewport.height = 400
    viewport.dispatchEvent(new dom.window.Event('resize'))
    fieldHeight = 280
    resize()
    expect(frames.size).toBe(1)
    flush()
    expect(getExpandedEditorCaretRect(textarea, mirror)!.bottom).toBe(368)
  })

  test('reveals a new selection while focused but does not fight manual scrolling', () => {
    uninstall = installExpandedEditorCaretReveal(textarea, mirror)
    textarea.focus()
    document.dispatchEvent(new dom.window.Event('selectionchange'))
    flush()
    textarea.scrollTop = 0
    textarea.dispatchEvent(new dom.window.Event('scroll'))
    document.dispatchEvent(new dom.window.Event('selectionchange'))
    expect(frames.size).toBe(0)
    // Late duplicate geometry notifications must not undo a manual scroll.
    resize()
    viewport.dispatchEvent(new dom.window.Event('resize'))
    flush()
    expect(textarea.scrollTop).toBe(0)
    textarea.setSelectionRange(10, 10)
    document.dispatchEvent(new dom.window.Event('selectionchange'))
    flush()
    expect(textarea.scrollTop).toBe(262)
  })

  test('defers to the IME during composition and reveals on completion', () => {
    uninstall = installExpandedEditorCaretReveal(textarea, mirror)
    textarea.focus()
    textarea.dispatchEvent(new dom.window.CompositionEvent('compositionstart'))
    resize()
    flush()
    expect(textarea.scrollTop).toBe(0)
    textarea.dispatchEvent(new dom.window.CompositionEvent('compositionend'))
    flush()
    expect(textarea.scrollTop).toBe(262)
  })

  test('does not act on stale focus and cleans up pending resize work', () => {
    uninstall = installExpandedEditorCaretReveal(textarea, mirror)
    textarea.focus()
    textarea.blur()
    flush()
    expect(textarea.scrollTop).toBe(0)
    textarea.focus()
    uninstall()
    uninstall = undefined
    expect(frames.size).toBe(0)
    expect(disconnected).toBe(true)
    viewport.dispatchEvent(new dom.window.Event('resize'))
    expect(frames.size).toBe(0)
  })
})
