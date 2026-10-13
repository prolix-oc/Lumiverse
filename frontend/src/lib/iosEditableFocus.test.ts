import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { installIOSEditableFocusScrollPrevention } from './iosEditableFocus'

const dom = new JSDOM('<!doctype html><html data-ios-pwa><body></body></html>')
const globals = globalThis as unknown as Record<string, unknown>
const replacements = {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
}
const originals = Object.fromEntries(Object.keys(replacements).map(key => [key, globals[key]]))
Object.assign(globals, replacements)
const viewport = { scale: 1 }
Object.defineProperty(window, 'visualViewport', { value: viewport })
let stop: () => void
let field: HTMLTextAreaElement
let calls: (FocusOptions | undefined)[]
beforeEach(() => {
  document.documentElement.setAttribute('data-ios-pwa', '')
  viewport.scale = 1
  field = document.createElement('textarea')
  field.value = 'A long editable message with a selection'
  document.body.append(field)
  calls = []
  const nativeFocus = field.focus.bind(field)
  field.focus = options => { calls.push(options); nativeFocus(options) }
  stop = installIOSEditableFocusScrollPrevention()
})
afterEach(() => { stop(); document.body.replaceChildren() })
afterAll(() => { Object.assign(globals, originals); dom.window.close() })
function mouse(type: string, target: HTMLElement = field, options: MouseEventInit = {}) {
  const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event)
  return event
}

describe('iOS editable focus scroll prevention', () => {
  test('focuses before the native mousedown default and leaves caret placement available', () => {
    field.setSelectionRange(5, 12, 'backward')
    const down = mouse('mousedown')
    expect(document.activeElement).toBe(field)
    expect(calls).toEqual([{ preventScroll: true }])
    expect(down.defaultPrevented).toBe(false)
    expect([field.selectionStart, field.selectionEnd, field.selectionDirection]).toEqual([5, 12, 'backward'])
    // Emulate the native caret placement following the uncanceled mousedown.
    field.setSelectionRange(8, 8)
    expect(mouse('click').defaultPrevented).toBe(false)
    expect(field.selectionStart).toBe(8)
    expect(calls.at(-1)).toEqual({ preventScroll: true })
  })

  test('keeps focus and the new caret when a focused control is clicked again', () => {
    field.focus({ preventScroll: true })
    calls.length = 0
    field.setSelectionRange(6, 14)
    expect(mouse('mousedown').defaultPrevented).toBe(false)
    expect(calls).toEqual([])
    mouse('click')
    expect([field.selectionStart, field.selectionEnd]).toEqual([6, 14])
    expect(calls).toEqual([{ preventScroll: true }])
  })

  test('updates reveal options on native or programmatic focus without recursion', () => {
    field.setSelectionRange(2, 7)
    field.focus()
    expect(calls).toEqual([undefined, { preventScroll: true }])
    expect(document.activeElement).toBe(field)
    expect([field.selectionStart, field.selectionEnd]).toEqual([2, 7])
  })

  test('does not focus while scrolling or dragging a selection by touch', () => {
    for (const type of ['touchstart', 'touchmove', 'touchend']) {
      const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
      field.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(calls).toEqual([])
  })

  test('supports text inputs and editable descendants but leaves native pickers alone', () => {
    const input = document.createElement('input')
    document.body.append(input)
    mouse('mousedown', input)
    expect(document.activeElement).toBe(input)
    input.blur()
    for (const type of ['checkbox', 'radio', 'range', 'file', 'date', 'color']) {
      input.type = type
      mouse('mousedown', input)
      expect(document.activeElement).not.toBe(input)
    }
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    const child = document.createElement('span')
    editor.append(child)
    document.body.append(editor)
    Object.defineProperty(editor, 'isContentEditable', { value: true })
    Object.defineProperty(child, 'isContentEditable', { value: true })
    mouse('mousedown', child)
    expect(document.activeElement).toBe(editor)
  })

  test('protects fields that already own caret revealing, including expanded editors', () => {
    field.setAttribute('data-keyboard-caret-managed', 'true')
    mouse('mousedown')
    expect(calls).toEqual([{ preventScroll: true }])
  })

  test('keeps self-positioned composers on their existing focus path', () => {
    const composer = document.createElement('div')
    composer.dataset.component = 'InputArea'
    document.body.append(composer)
    composer.append(field)
    mouse('mousedown')
    field.focus()
    mouse('click')
    expect(calls).toEqual([undefined])
  })

  test('does not take disabled, readonly, canceled or secondary clicks', () => {
    field.readOnly = true
    mouse('mousedown')
    field.readOnly = false
    field.disabled = true
    mouse('mousedown')
    field.disabled = false
    const down = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
    down.preventDefault()
    field.dispatchEvent(down)
    mouse('mousedown', field, { button: 2 })
    expect(calls).toEqual([])
  })

  test('leaves browser tabs and magnified viewport panning alone', () => {
    document.documentElement.removeAttribute('data-ios-pwa')
    mouse('mousedown')
    expect(calls).toEqual([])
    document.documentElement.setAttribute('data-ios-pwa', '')
    viewport.scale = 2
    mouse('mousedown')
    expect(calls).toEqual([])
  })

  test('uninstall removes all focus and click listeners', () => {
    stop()
    mouse('mousedown')
    field.focus()
    mouse('click')
    expect(calls).toEqual([undefined])
  })
})
