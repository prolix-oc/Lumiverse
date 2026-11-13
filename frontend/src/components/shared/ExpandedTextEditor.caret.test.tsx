import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement, useState } from 'react'
import type { Root } from 'react-dom/client'

mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('@/store', () => ({ useStore: (selector: (state: object) => unknown) => selector({}) }))
mock.module('@/api/macros', () => ({ getMacroCatalog: () => Promise.resolve({ categories: [] }) }))
mock.module('@/lib/loom/service', () => ({ getAvailableMacros: () => [] }))
mock.module('@/components/chat/MessageContent', () => ({ default: () => createElement('div', null, 'preview') }))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
const globals = globalThis as unknown as Record<string, unknown>
let touchOnly = true
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0
const replacements = {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Event: dom.window.Event,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  ResizeObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame },
  cancelAnimationFrame: (id: number) => { frames.delete(id) },
  IS_REACT_ACT_ENVIRONMENT: true,
}
const originals = Object.fromEntries(Object.keys(replacements).map(key => [key, globals[key]]))
Object.assign(globals, replacements)
window.matchMedia = ((media: string) => ({ matches: touchOnly && media === '(any-hover: none)' })) as typeof window.matchMedia
const viewport = new dom.window.EventTarget()
Object.defineProperty(window, 'visualViewport', { value: viewport })

const { createRoot } = await import('react-dom/client')
const { default: ExpandedTextEditor } = await import('./ExpandedTextEditor')
mock.restore()

let root: Root
let container: HTMLDivElement
const initialValue = 'alpha beta gamma\nsecond line\nlast line'
function Harness({ highlighted = true }: { highlighted?: boolean }) {
  const [value, setValue] = useState(initialValue)
  return createElement(ExpandedTextEditor, {
    value, onChange: setValue, onClose: () => {}, title: 'Editor', macros: [], markdownOnly: highlighted,
  })
}
async function mount(highlighted = true) {
  await act(async () => root.render(createElement(Harness, { highlighted })))
  return document.querySelector('textarea')!
}
async function flushFrames() {
  await act(async () => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
  })
}
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)
  expect(button).toBeTruthy()
  await act(async () => button!.click())
}
function input(element: HTMLInputElement | HTMLTextAreaElement, value: string, caret = value.length) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.setSelectionRange(caret, caret)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  touchOnly = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  frames.clear()
  mock.restore()
})
afterAll(() => {
  Object.assign(globals, originals)
  dom.window.close()
})

describe('expanded editor native caret ownership', () => {
  test('does not focus or pre-position the mobile caret on opening', async () => {
    const setSelection = spyOn(HTMLTextAreaElement.prototype, 'setSelectionRange')
    const textarea = await mount()
    expect(document.activeElement).not.toBe(textarea)
    expect(setSelection).not.toHaveBeenCalled()
  })

  test('retains desktop autofocus and initial selection', async () => {
    touchOnly = false
    const textarea = await mount()
    expect(document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe(initialValue.length)
  })

  test('does not rewrite a middle-of-text selection on keyboard viewport events', async () => {
    const textarea = await mount()
    await act(async () => {
      textarea.focus()
      textarea.setSelectionRange(6, 6)
      textarea.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientY: 650 }))
    })
    const setSelection = spyOn(textarea, 'setSelectionRange')
    textarea.scrollTop = 120
    window.dispatchEvent(new Event('resize'))
    viewport.dispatchEvent(new Event('resize'))
    viewport.dispatchEvent(new Event('scroll'))
    await flushFrames()
    expect(textarea.selectionStart).toBe(6)
    expect(setSelection).not.toHaveBeenCalled()
  })

  test('mirrors native scrolling without changing selection', async () => {
    const textarea = await mount()
    textarea.setSelectionRange(6, 6)
    textarea.scrollTop = 75
    textarea.scrollLeft = 4
    await act(async () => textarea.dispatchEvent(new Event('scroll')))
    const pre = document.querySelector('pre')!
    expect(pre.scrollTop).toBe(75)
    expect(pre.scrollLeft).toBe(4)
    expect(textarea.selectionStart).toBe(6)
  })

  test('does not replay selection on native typing or IME composition', async () => {
    const textarea = await mount()
    await act(async () => {
      textarea.focus()
      textarea.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }))
      input(textarea, 'alpha 日本 beta gamma', 8)
    })
    const setSelection = spyOn(textarea, 'setSelectionRange')
    await act(async () => textarea.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true })))
    expect(textarea.value).toBe('alpha 日本 beta gamma')
    expect(textarea.selectionStart).toBe(8)
    expect(setSelection).not.toHaveBeenCalled()
  })

  test('keeps the same textarea and caret when find highlighting is enabled or cleared', async () => {
    const textarea = await mount(false)
    textarea.setSelectionRange(6, 6)
    await click('find')
    await flushFrames()
    const find = document.querySelector('input[aria-label="find"]') as HTMLInputElement
    await act(async () => input(find, 'beta'))
    expect(document.querySelector('textarea')).toBe(textarea)
    expect(textarea.selectionStart).toBe(6)
    expect(document.querySelector('mark')?.textContent).toBe('beta')
    await click('clearFind')
    expect(document.querySelector('textarea')).toBe(textarea)
    expect(textarea.selectionStart).toBe(6)
  })

  test('still restores the caret for explicit Tab insertion', async () => {
    const textarea = await mount()
    await act(async () => {
      textarea.focus()
      textarea.setSelectionRange(6, 10)
      textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    })
    expect(textarea.value).toBe('alpha \t gamma\nsecond line\nlast line')
    expect(textarea.selectionStart).toBe(7)
    expect(document.activeElement).toBe(textarea)
  })

  test('find replacement applies selection without stealing input focus', async () => {
    const textarea = await mount()
    await click('findAndReplace')
    await flushFrames()
    const find = document.querySelector('input[aria-label="find"]') as HTMLInputElement
    const replacement = document.querySelector('input[aria-label="replaceWith"]') as HTMLInputElement
    await act(async () => input(find, 'beta'))
    await act(async () => { replacement.focus(); input(replacement, 'new') })
    await click('replace')
    expect(textarea.value).toBe('alpha new gamma\nsecond line\nlast line')
    expect(textarea.selectionStart).toBe(9)
    expect(document.activeElement).toBe(replacement)
  })

  test('identical replacement consumes its selection without waiting for a value change', async () => {
    const textarea = await mount()
    await click('findAndReplace')
    await flushFrames()
    const find = document.querySelector('input[aria-label="find"]') as HTMLInputElement
    const replacement = document.querySelector('input[aria-label="replaceWith"]') as HTMLInputElement
    await act(async () => input(find, 'beta'))
    await act(async () => input(replacement, 'beta'))
    await click('replace')
    expect(textarea.value).toBe(initialValue)
    expect(textarea.selectionStart).toBe(6)
    expect(textarea.selectionEnd).toBe(10)
    await act(async () => { textarea.focus(); input(textarea, 'al!pha beta gamma', 3) })
    expect(textarea.selectionStart).toBe(3)
  })

  test('returning from preview preserves selection without opening a mobile keyboard', async () => {
    const textarea = await mount()
    await act(async () => { textarea.focus(); textarea.setSelectionRange(6, 10) })
    const focus = spyOn(textarea, 'focus')
    await click('previewMarkdown')
    await click('editMarkdown')
    const restored = document.querySelector('textarea')!
    expect(restored).toBe(textarea)
    expect(restored.selectionStart).toBe(6)
    expect(restored.selectionEnd).toBe(10)
    // jsdom does not blur elements hidden by CSS; test that returning does
    // not call focus rather than simulating browser focus visibility rules.
    expect(focus).not.toHaveBeenCalled()
  })
})
