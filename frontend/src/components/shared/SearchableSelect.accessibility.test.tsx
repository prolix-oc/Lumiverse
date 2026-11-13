import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act, createElement, useState } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import shared from '@/i18n/locales/en/shared.json'
import type { SearchableSelectOption } from './SearchableSelect'

mock.module('./SearchableSelect.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
  Node: dom.window.Node, navigator: dom.window.navigator,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
})
dom.window.HTMLElement.prototype.scrollIntoView = () => {}

const i18n = createInstance()
let createRoot: typeof import('react-dom/client').createRoot
let SearchableSelect: typeof import('./SearchableSelect').default
let root: Root | null = null
let host: HTMLDivElement | null = null
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { shared } } })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: SearchableSelect } = await import('./SearchableSelect'))
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const books: SearchableSelectOption[] = [
  { value: 'alpha', label: 'Alpha', group: 'Worlds' },
  { value: 'disabled', label: 'Unavailable', group: 'Worlds', disabled: true },
  { value: 'beta', label: 'Beta', group: 'Worlds' },
]

async function renderPicker(props: Record<string, unknown> = {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  function Picker() {
    const [selected, setSelected] = useState<string[]>([])
    return createElement(SearchableSelect, {
      multi: true, value: selected, onChange: setSelected, options: books,
      ariaLabel: 'Add lorebooks to this chat', ...props,
    } as Parameters<typeof SearchableSelect>[0])
  }
  act(() => root!.render(createElement(I18nextProvider, { i18n }, createElement(Picker))))
  const trigger = host.querySelector('button')!
  trigger.focus()
  act(() => trigger.click())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
  return trigger
}

function press(target: HTMLElement, key: string, shiftKey = false) {
  const event = new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  act(() => target.dispatchEvent(event))
  return event
}
function option(name: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
    .find(node => node.textContent?.replace('✓', '').trim() === name)!
}

describe('SearchableSelect screen reader and keyboard behavior', () => {
  test('recent shortcuts retain canonical options and have distinct keyboard positions', async () => {
    await renderPicker({ recentValues: ['beta', 'missing', 'beta'] })
    const recent = document.querySelector('[role="group"][aria-label="Recently Used"]')!
    expect(recent.querySelectorAll('[role="option"]').length).toBe(1)
    expect(document.querySelector('[role="group"][aria-label="Worlds"]')!.querySelectorAll('[role="option"]').length).toBe(3)
    expect(document.activeElement === option('Beta')).toBe(true)
    press(option('Beta'), 'ArrowDown')
    expect(document.activeElement === option('Alpha')).toBe(true)
    press(option('Alpha'), 'ArrowDown')
    expect(document.activeElement?.textContent?.trim()).toBe('Beta')
    expect(recent.contains(document.activeElement)).toBe(false)
  })

  test('honors saved folder order including Uncategorized and searches folder names', async () => {
    await renderPicker({
      forceSearch: true, groupOrder: ['', 'Zebra', 'Alpha'],
      options: [
        { value: 'a', label: 'First', group: 'Alpha' },
        { value: 'z', label: 'Second', group: 'Zebra' },
        { value: 'u', label: 'Third' },
      ],
    })
    expect(Array.from(document.querySelectorAll('[role="group"]')).map(node => node.getAttribute('aria-label')))
      .toEqual(['Uncategorized', 'Zebra', 'Alpha'])
    const input = document.querySelector('input')!
    act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'zebra')
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    expect(Array.from(document.querySelectorAll('[role="option"]')).map(node => node.textContent?.trim()))
      .toEqual(['Second'])
  })

  for (const portal of [false, true]) {
    test(`names the list, exposes groups, and moves option focus (portal=${portal})`, async () => {
      const trigger = await renderPicker({ portal })
      const list = document.querySelector('[role="listbox"]')!
      expect(trigger.getAttribute('aria-controls')).toBe(list.id)
      expect(list.getAttribute('aria-label')).toBe('Add lorebooks to this chat')
      expect(list.getAttribute('aria-multiselectable')).toBe('true')
      expect(list.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Worlds')
      expect(document.activeElement === option('Alpha')).toBe(true)
      press(option('Alpha'), 'ArrowDown')
      expect(document.activeElement === option('Beta')).toBe(true)
      press(option('Beta'), 'ArrowDown')
      expect(document.activeElement === option('Beta')).toBe(true)
      press(option('Beta'), 'Home')
      expect(document.activeElement === option('Alpha')).toBe(true)
      press(option('Alpha'), 'End')
      expect(document.activeElement === option('Beta')).toBe(true)
      press(option('Beta'), 'ArrowUp')
      expect(document.activeElement === option('Alpha')).toBe(true)
      expect(list.querySelectorAll('[tabindex="0"]').length).toBe(1)
      act(() => option('Alpha').click())
      expect(option('Alpha').getAttribute('aria-selected')).toBe('true')
      expect(option('Alpha').querySelector('.optionCheck')?.getAttribute('aria-hidden')).toBe('true')
      act(() => option('Alpha').click())
      expect(option('Alpha').getAttribute('aria-selected')).toBe('false')
      press(option('Alpha'), 'Escape')
      expect(document.querySelector('[role="listbox"]')).toBeNull()
      expect(document.activeElement === trigger).toBe(true)
    })
  }

  test('keeps search and paging controls outside the list and preserves text editing', async () => {
    const loadMore = mock(() => {})
    await renderPicker({ portal: true, forceSearch: true, hasMore: true, onLoadMore: loadMore })
    const input = document.querySelector<HTMLInputElement>('input')!
    const list = document.querySelector('[role="listbox"]')!
    const paging = document.querySelector<HTMLButtonElement>('.loadMore')!
    expect(list.contains(input)).toBe(false)
    expect(list.contains(paging)).toBe(false)
    expect(document.activeElement === input).toBe(true)
    expect(press(input, 'Home').defaultPrevented).toBe(false)
    press(input, 'ArrowDown')
    expect(document.activeElement === option('Alpha')).toBe(true)
    act(() => paging.focus())
    expect(press(paging, 'Enter').defaultPrevented).toBe(false)
    act(() => paging.click())
    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  test('includes the clear choice in keyboard navigation and restores focus on selection', async () => {
    const onChange = mock(() => {})
    const trigger = await renderPicker({ multi: false, value: 'beta', onChange, clearable: true, clearLabel: 'None' })
    expect(document.activeElement === option('Beta')).toBe(true)
    press(option('Beta'), 'Home')
    expect(document.activeElement === option('None')).toBe(true)
    expect(option('None').getAttribute('aria-selected')).toBe('false')
    act(() => option('None').click())
    expect(onChange).toHaveBeenCalledWith('')
    expect(document.activeElement === trigger).toBe(true)
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  test('gives an empty list focus and exposes its message as status outside the list', async () => {
    const trigger = await renderPicker({ options: [], emptyMessage: 'No lorebooks available' })
    const list = document.querySelector('[role="listbox"]')!
    expect(document.activeElement === list).toBe(true)
    const status = document.querySelector('[role="status"]')!
    expect(status.textContent).toBe('No lorebooks available')
    expect(list.contains(status)).toBe(false)
    press(list as HTMLElement, 'Escape')
    expect(document.activeElement === trigger).toBe(true)
  })

  test('returns from a body portal to its trigger when leaving with Shift+Tab', async () => {
    const trigger = await renderPicker({ portal: true })
    const event = press(option('Alpha'), 'Tab', true)
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement === trigger).toBe(true)
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  test('explicitly advances from a body portal to the control after its trigger', async () => {
    const trigger = await renderPicker({ portal: true })
    const after = document.createElement('button')
    after.textContent = 'After picker'
    host!.appendChild(after)
    // JSDOM has no layout; expose only these two controls as visible.
    for (const control of [trigger, after]) {
      control.getClientRects = () => [{ width: 20, height: 20 }] as unknown as DOMRectList
    }
    const event = press(option('Alpha'), 'Tab')
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement === after).toBe(true)
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })
})


test('loads once near the scroll boundary and retains a keyboard-accessible retry button', async () => {
  let loads = 0
  await renderPicker({ hasMore: true, loadMoreOnScroll: true, onLoadMore: () => { loads++ } })
  const list = document.querySelector('[role="listbox"]')! as HTMLElement
  Object.defineProperties(list, { clientHeight: { value: 200 }, scrollHeight: { value: 600 }, scrollTop: { value: 300, writable: true } })
  act(() => list.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })))
  expect(loads).toBe(0)
  list.scrollTop = 350
  act(() => list.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })))
  act(() => list.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })))
  expect(loads).toBe(1)
  const more = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Load more')!
  expect(more.disabled).toBe(false)
  act(() => more.click())
  expect(loads).toBe(2)
})

test('incremental select does not automatically load while busy', async () => {
  let loads = 0
  await renderPicker({ hasMore: true, loading: true, loadMoreOnScroll: true, onLoadMore: () => { loads++ } })
  const list = document.querySelector('[role="listbox"]')!
  Object.defineProperties(list, { clientHeight: { value: 200 }, scrollHeight: { value: 200 }, scrollTop: { value: 0 } })
  act(() => list.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })))
  expect(loads).toBe(0)
  expect(Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Loading…')?.disabled).toBe(true)
})


test('scroll pagination is opt-in for existing picker consumers', async () => {
  let loads = 0
  await renderPicker({ hasMore: true, onLoadMore: () => { loads++ } })
  const list = document.querySelector('[role="listbox"]')!
  Object.defineProperties(list, { clientHeight: { value: 200 }, scrollHeight: { value: 200 }, scrollTop: { value: 0 } })
  act(() => list.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })))
  expect(loads).toBe(0)
  const more = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Load more')!
  act(() => more.click())
  expect(loads).toBe(1)
})
