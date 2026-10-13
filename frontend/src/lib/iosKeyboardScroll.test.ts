import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createComposerTouchFocusHandlers, focusComposerOnTouchEnd, installIOSKeyboardScrollGuard } from './iosKeyboardScroll'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const originalWindow = globalThis.window
globalThis.window = dom.window as unknown as Window & typeof globalThis
const viewport = Object.assign(new dom.window.EventTarget(), { offsetTop: 0, scale: 1 })
Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
Object.defineProperty(window, 'scrollX', { configurable: true, writable: true, value: 0 })
Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 })
const scrollCalls: ScrollToOptions[] = []
window.scrollTo = ((options: ScrollToOptions) => {
  scrollCalls.push(options)
  Object.assign(window, { scrollX: options.left, scrollY: options.top })
}) as typeof window.scrollTo

let textarea: HTMLTextAreaElement
let focusCalls: FocusOptions[]
let uninstall: (() => void) | undefined
beforeEach(() => {
  dom.window.document.documentElement.setAttribute('data-ios-pwa', '')
  textarea = dom.window.document.createElement('textarea')
  textarea.value = 'A draft with a selection'
  dom.window.document.body.append(textarea)
  const nativeFocus = textarea.focus.bind(textarea)
  focusCalls = []
  textarea.focus = options => { focusCalls.push(options); nativeFocus(options) }
  textarea.addEventListener('touchend', event => focusComposerOnTouchEnd(event as never))
  scrollCalls.length = 0
  Object.assign(window, { scrollX: 0, scrollY: 0 })
  viewport.offsetTop = 0
  viewport.scale = 1
})
afterEach(() => {
  uninstall?.()
  uninstall = undefined
  dom.window.document.body.replaceChildren()
})
afterAll(() => {
  globalThis.window = originalWindow
  dom.window.close()
})

function touchEnd({ touches = 0, changedTouches = 1, cancelable = true, prevented = false } = {}) {
  const event = new dom.window.Event('touchend', { bubbles: true, cancelable })
  Object.assign(event, { touches: { length: touches }, changedTouches: { length: changedTouches } })
  if (prevented) event.preventDefault()
  textarea.dispatchEvent(event)
  return event
}

describe('iOS PWA composer touch focus', () => {
  test('focuses synchronously with scroll prevention before the native touch default', () => {
    textarea.setSelectionRange(2, 7)
    const event = touchEnd()
    expect(event.defaultPrevented).toBe(true)
    expect(dom.window.document.activeElement).toBe(textarea)
    expect(focusCalls).toEqual([{ preventScroll: true }])
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 7])
  })

  test('leaves subsequent touches to native caret placement, selection and paste', () => {
    textarea.focus()
    focusCalls.length = 0
    textarea.setSelectionRange(3, 8)
    expect(touchEnd().defaultPrevented).toBe(false)
    expect(focusCalls).toEqual([])
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 8])
  })

  test('leaves browser tabs and other platforms on their native focus path', () => {
    dom.window.document.documentElement.removeAttribute('data-ios-pwa')
    expect(touchEnd().defaultPrevented).toBe(false)
    expect(focusCalls).toEqual([])
  })

  test('does not steal a canceled gesture, an uncancelable event or a multitouch gesture', () => {
    touchEnd({ prevented: true })
    touchEnd({ cancelable: false })
    touchEnd({ touches: 1 })
    touchEnd({ changedTouches: 2 })
    expect(focusCalls).toEqual([])
  })

  test('does not open the keyboard for disabled or read-only composers', () => {
    textarea.disabled = true
    expect(touchEnd().defaultPrevented).toBe(false)
    textarea.disabled = false
    textarea.readOnly = true
    expect(touchEnd().defaultPrevented).toBe(false)
    expect(focusCalls).toEqual([])
  })
})

describe('composer tap recognition', () => {
  const touch = (y = 20, identifier = 1) => ({ identifier, clientX: 10, clientY: y })
  const gesture = (target: HTMLTextAreaElement, points = [touch()]) => ({
    currentTarget: target,
    touches: points,
    changedTouches: points,
    cancelable: true,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
  })

  test('accepts a tap with a small amount of finger movement', () => {
    const handlers = createComposerTouchFocusHandlers()
    handlers.onTouchStart(gesture(textarea))
    handlers.onTouchMove(gesture(textarea, [touch(24)]))
    const end = gesture(textarea, [touch(25)])
    end.touches = []
    handlers.onTouchEnd(end)
    expect(end.defaultPrevented).toBe(true)
    expect(focusCalls).toEqual([{ preventScroll: true }])
  })

  test('does not focus after scrolling, even if the finger returns to its starting point', () => {
    const handlers = createComposerTouchFocusHandlers()
    handlers.onTouchStart(gesture(textarea))
    handlers.onTouchMove(gesture(textarea, [touch(70)]))
    const end = gesture(textarea)
    end.touches = []
    handlers.onTouchEnd(end)
    expect(end.defaultPrevented).toBe(false)
    expect(focusCalls).toEqual([])
  })

  test('does not focus after a canceled or multitouch gesture', () => {
    const handlers = createComposerTouchFocusHandlers()
    const end = gesture(textarea)
    end.touches = []
    handlers.onTouchStart(gesture(textarea))
    handlers.onTouchCancel()
    handlers.onTouchEnd(end)
    handlers.onTouchStart(gesture(textarea))
    handlers.onTouchStart(gesture(textarea, [touch(), touch(25, 2)]))
    handlers.onTouchEnd(end)
    expect(focusCalls).toEqual([])
  })

  test('does not focus when touchend arrives without a matching touchstart', () => {
    const handlers = createComposerTouchFocusHandlers()
    const end = gesture(textarea)
    end.touches = []
    handlers.onTouchEnd(end)
    handlers.onTouchStart(gesture(textarea))
    end.changedTouches = [touch(20, 2)]
    handlers.onTouchEnd(end)
    expect(focusCalls).toEqual([])
  })
})

describe('iOS document scroll recovery', () => {
  test('does not reset a stationary document for transient or stale viewport offsets', () => {
    uninstall = installIOSKeyboardScrollGuard()
    for (const offset of [0, 40, 180, 100, 24, 0]) {
      viewport.offsetTop = offset
      viewport.dispatchEvent(new dom.window.Event('scroll'))
      window.dispatchEvent(new dom.window.Event('scroll'))
    }
    expect(scrollCalls).toEqual([])
  })

  test('resets actual document scrolling once, without a follow-up reset loop', () => {
    uninstall = installIOSKeyboardScrollGuard()
    Object.assign(window, { scrollX: 5, scrollY: 160 })
    viewport.offsetTop = 160
    viewport.dispatchEvent(new dom.window.Event('scroll'))
    window.dispatchEvent(new dom.window.Event('scroll'))
    viewport.dispatchEvent(new dom.window.Event('scroll'))
    expect(scrollCalls).toEqual([{ left: 0, top: 0, behavior: 'instant' }])
  })

  test('recovers document scrolling even when visualViewport does not emit a scroll event', () => {
    uninstall = installIOSKeyboardScrollGuard()
    Object.assign(window, { scrollY: 120 })
    window.dispatchEvent(new dom.window.Event('scroll'))
    expect(scrollCalls).toHaveLength(1)
    expect(window.scrollY).toBe(0)
  })

  test('does not fight panning while pinch zoomed', () => {
    uninstall = installIOSKeyboardScrollGuard()
    viewport.scale = 2
    Object.assign(window, { scrollY: 120 })
    viewport.dispatchEvent(new dom.window.Event('scroll'))
    window.dispatchEvent(new dom.window.Event('scroll'))
    expect(scrollCalls).toEqual([])
    expect(window.scrollY).toBe(120)
  })

  test('uninstall removes both scroll listeners', () => {
    installIOSKeyboardScrollGuard()()
    Object.assign(window, { scrollY: 120 })
    viewport.dispatchEvent(new dom.window.Event('scroll'))
    window.dispatchEvent(new dom.window.Event('scroll'))
    expect(scrollCalls).toEqual([])
  })
})
