import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const calls = {
  drag: 0,
  minimize: 0,
  maximize: 0,
  close: 0,
}

mock.module('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    startDragging: async () => { calls.drag += 1 },
    minimize: async () => { calls.minimize += 1 },
    toggleMaximize: async () => { calls.maximize += 1 },
    close: async () => { calls.close += 1 },
  }),
}))
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: () => 'Lumiverse' }),
}))
mock.module('@/hooks/useContextualTitle', () => ({
  useContextualTitle: () => '',
}))

const { default: DesktopPwaTitlebar } = await import('./DesktopPwaTitlebar')

let dom: JSDOM
let root: Root
let host: HTMLDivElement
let previousGlobals: Record<string, unknown>

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  previousGlobals = Object.fromEntries(
    ['window', 'document', 'HTMLElement', 'Element', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']
      .map((key) => [key, Reflect.get(globalThis, key)]),
  )
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.defineProperty(dom.window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  Object.assign(calls, { drag: 0, minimize: 0, maximize: 0, close: 0 })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  dom.window.close()
  for (const [key, value] of Object.entries(previousGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key)
    else Reflect.set(globalThis, key, value)
  }
})

describe('DesktopPwaTitlebar', () => {
  test('starts one drag on the first press and owns double-click maximize once', async () => {
    await act(async () => { root.render(<DesktopPwaTitlebar />) })
    const dragRegion = document.querySelector<HTMLElement>('[data-part="drag-region"]')!

    const firstPress = new dom.window.MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 1,
    })
    dragRegion.dispatchEvent(firstPress)
    expect(firstPress.defaultPrevented).toBe(true)
    expect(calls.drag).toBe(1)

    dragRegion.dispatchEvent(new dom.window.MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 2,
    }))
    dragRegion.dispatchEvent(new dom.window.MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 2,
    }))

    expect(calls.drag).toBe(1)
    expect(calls.maximize).toBe(1)
  })
})
