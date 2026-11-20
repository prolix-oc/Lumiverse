import { afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

mock.module('./SearchableSelect.module.css', () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}))
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; count?: number }) => {
      const fixed: Record<string, string> = {
        uncategorized: 'Uncategorized',
        clear: 'None',
        clearSearch: 'Clear search',
        placeholder: 'Select…',
        searchPlaceholder: 'Search…',
        emptyMessage: 'No options available',
        noResultsMessage: 'No matches',
      }
      return fixed[key] ?? opts?.defaultValue ?? key
    },
  }),
}))
mock.module('lucide-react', () => ({ ChevronDown: () => null, Search: () => null, X: () => null }))

// DOM globals must exist before react-dom/client is imported, or React's event
// system binds to the preload's stub document and dispatched keys never land.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lumiverse.test/',
  pretendToBeVisual: true,
})
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {}
Object.assign(globalThis as unknown as Record<string, unknown>, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  KeyboardEvent: dom.window.KeyboardEvent,
  navigator: dom.window.navigator,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => { cb(0); return 1 },
  cancelAnimationFrame: () => {},
  IS_REACT_ACT_ENVIRONMENT: true,
})

const { createRoot } = await import('react-dom/client')
const { default: SearchableSelect } = await import('./SearchableSelect')
mock.restore()

const BOOKS = [
  { value: 'b1', label: 'Babel Campaign (June 1998)' },
  { value: 'b2', label: 'Sunnydale Lore', sublabel: 'imported' },
  { value: 'b3', label: 'Disabled Book', disabled: true },
]

describe('SearchableSelect option naming', () => {
  let root: Root | null = null
  let host: HTMLDivElement | null = null

  afterEach(() => {
    act(() => { root?.unmount() })
    host?.remove()
    root = null
    host = null
    document.body.innerHTML = ''
  })

  function render(props: Record<string, unknown> = {}) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root!.render(createElement(SearchableSelect as never, {
        options: BOOKS,
        forceSearch: true,
        multi: true,
        value: [],
        onChange: () => {},
        ...props,
      }))
    })
  }

  const trigger = () => document.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement
  const options = () => Array.from(document.querySelectorAll('[role="option"]')) as HTMLElement[]
  const open = () => { act(() => { trigger().click() }) }
  const press = (key: string, from?: HTMLElement) => {
    act(() => {
      (from ?? (document.activeElement as HTMLElement) ?? trigger())
        .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }

  test('every option carries its own accessible name', () => {
    render()
    open()
    // Name from content is not enough here: the label sits inside a wrapper
    // element, which leaves role="option" with an empty computed name.
    for (const option of options()) {
      expect(option.getAttribute('aria-label')).toBeTruthy()
    }
    expect(options().map((o) => o.getAttribute('aria-label'))).toEqual([
      'Babel Campaign (June 1998)',
      'Sunnydale Lore, imported',
      'Disabled Book',
    ])
  })

  test('the sublabel is part of the name, not a separate stop', () => {
    render()
    open()
    const withSublabel = options()[1]!
    expect(withSublabel.getAttribute('aria-label')).toBe('Sunnydale Lore, imported')
  })

  test('arrow keys move focus onto a named option', () => {
    render()
    open()
    press('ArrowDown')
    const focused = document.activeElement as HTMLElement
    expect(focused.getAttribute('role')).toBe('option')
    // The whole point: whatever the arrows land on can be announced.
    expect(focused.getAttribute('aria-label')).toBe('Babel Campaign (June 1998)')

    press('ArrowDown')
    expect((document.activeElement as HTMLElement).getAttribute('aria-label'))
      .toBe('Sunnydale Lore, imported')
  })

  test('the clearable row is named too', () => {
    render({ multi: false, value: 'b1', onChange: () => {}, clearable: true })
    open()
    expect(options()[0]!.getAttribute('aria-label')).toBe('None')
  })
})
