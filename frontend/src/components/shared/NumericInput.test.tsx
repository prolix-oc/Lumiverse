import { afterAll, afterEach, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import NumericInput from './NumericInput'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const globals = globalThis as unknown as Record<string, unknown>
const replacements = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true,
}
const originalGlobals = Object.keys(replacements).map(key => [key, globals[key]] as const)
Object.assign(globals, replacements)
const { createRoot } = await import('react-dom/client')
const roots: ReturnType<typeof createRoot>[] = []

function render(value = 10, commitOnBlur = true, allowEmpty = false) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const changes: Array<number | null> = []
  const rerender = (value: number) => act(() => root.render(
    <NumericInput value={value} onChange={next => changes.push(next)} integer commitOnBlur={commitOnBlur} allowEmpty={allowEmpty} />,
  ))
  rerender(value)
  const input = host.querySelector('input')!
  const type = (raw: string) => act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, raw)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const press = (key: string) => act(() => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
  act(() => input.focus())
  return { input, changes, rerender, type, press }
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
})
afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key]
    else globals[key] = value
  }
  dom.window.close()
})

test('existing numeric inputs still publish values during typing', () => {
  const { type, changes } = render(10, false)
  type('12')
  expect(changes).toEqual([12])
})

test('commit mode publishes only on Enter or blur', () => {
  const { input, type, changes, press } = render()
  type('12')
  expect(changes).toEqual([])
  press('Enter')
  expect(changes).toEqual([12])
  expect(document.activeElement === input).toBe(false)
})

test('commit mode rejects empty, fractional, unsafe and out-of-range values', () => {
  const { input, type, changes } = render()
  input.min = '0'
  for (const raw of ['', '1.5', '9007199254740992', '-1']) {
    act(() => input.focus())
    type(raw)
    act(() => input.blur())
    expect(input.value).toBe('10')
  }
  expect(changes).toEqual([])
})

test('commit mode preserves allowEmpty semantics', () => {
  const { input, type, changes } = render(10, true, true)
  type('')
  expect(changes).toEqual([])
  act(() => input.blur())
  expect(input.value).toBe('')
  expect(changes).toEqual([null])
})

test('Escape cancels a draft and restores the latest external value', () => {
  const { input, type, changes, press, rerender } = render()
  type('42')
  rerender(100)
  expect(input.value).toBe('42')
  expect(document.activeElement === input).toBe(true)
  press('Escape')
  expect(input.value).toBe('100')
  expect(changes).toEqual([])
})

test('blurring an untouched input adopts an external update without saving the stale value', () => {
  const { input, changes, rerender } = render()
  rerender(100)
  act(() => input.blur())
  expect(input.value).toBe('100')
  expect(changes).toEqual([])
})

test('a changed draft can be committed after an external update', () => {
  const { input, type, changes, rerender } = render()
  type('42')
  rerender(100)
  act(() => input.blur())
  expect(input.value).toBe('42')
  expect(changes).toEqual([42])
  rerender(42)
  rerender(200)
  expect(input.value).toBe('200')
})
