import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: CharacterTagInput } = await import('./CharacterTagInput')
let host: HTMLDivElement, root: Root
const onAdd = mock(() => {})
const library = [{ tag: 'Fantasy', count: 3 }, { tag: 'Romance', count: 2 }, { tag: 'Already assigned', count: 1 }]
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); onAdd.mockClear()
  act(() => root.render(<CharacterTagInput allTags={library} tags={['Already assigned']} onAdd={onAdd} placeholder="Add tag" />))
})
afterEach(() => { act(() => root.unmount()); host.remove() })
const input = () => host.querySelector('input')!
const options = () => [...host.querySelectorAll('[role="option"]')]
function focus() { act(() => input().focus()) }
function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
function key(value: string) { act(() => input().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true }))) }

describe('Character tag suggestions', () => {
  test('focus shows library tags, excludes assigned tags, and filters without changing original spelling', () => {
    expect(options()).toHaveLength(0); focus()
    expect(options().map(el => el.textContent)).toEqual(['Fantasy', 'Romance'])
    type('  FANT  '); expect(options().map(el => el.textContent)).toEqual(['Fantasy'])
    act(() => (options()[0] as HTMLButtonElement).click())
    expect(onAdd).toHaveBeenCalledWith('Fantasy'); expect(input().value).toBe(''); expect(options()).toHaveLength(0)
    act(() => input().click()); expect(options()).toHaveLength(2)
  })
  test('arrow navigation and Enter select an existing tag; Escape closes without adding', () => {
    focus(); key('ArrowDown'); key('ArrowDown')
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[1].id)
    key('Enter'); expect(onAdd).toHaveBeenCalledWith('Romance')
    key('ArrowUp'); key('Escape'); expect(options()).toHaveLength(0); expect(onAdd).toHaveBeenCalledTimes(1)
  })
  test('free text Enter and plus preserve new-tag creation and prevent duplicates', () => {
    focus(); type('  New tag  '); key('Enter'); expect(onAdd).toHaveBeenCalledWith('New tag')
    type('Another'); act(() => host.querySelector('button')!.click()); expect(onAdd).toHaveBeenCalledWith('Another')
    type('Already assigned'); key('Enter'); expect(onAdd).toHaveBeenCalledTimes(2)
  })
  test('blur dismisses suggestions and empty library still accepts a new tag', () => {
    focus(); act(() => input().blur()); expect(options()).toHaveLength(0)
    act(() => root.render(<CharacterTagInput allTags={[]} tags={[]} onAdd={onAdd} placeholder="Add tag" />))
    focus(); type('First tag'); key('Enter'); expect(onAdd).toHaveBeenCalledWith('First tag')
  })
})
