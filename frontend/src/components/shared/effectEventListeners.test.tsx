import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { ModalShell as ModalShellType } from './ModalShell'
import type ContextMenuType from './ContextMenu'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
})
const cssProxy = new Proxy({}, { get: (_target, key) => String(key) })
mock.module('./ModalShell.module.css', () => ({ default: cssProxy }))
mock.module('./ContextMenu.module.css', () => ({ default: cssProxy }))
let ModalShell: typeof ModalShellType
let ContextMenu: typeof ContextMenuType
let root: Root
let host: HTMLDivElement
beforeAll(async () => {
  ModalShell = (await import('./ModalShell')).ModalShell
  ContextMenu = (await import('./ContextMenu')).default
})
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  host?.remove()
  mock.restore()
})
afterAll(() => dom.window.close())
async function mount(node: ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = (await import('react-dom/client')).createRoot(host)
  await act(async () => root.render(node))
}
function escape() {
  act(() => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
}

test('modal Escape reads updated props without releasing the scroll lock or replacing its listener', async () => {
  const closed: string[] = []
  await mount(<ModalShell isOpen onClose={() => closed.push('old')}>Content</ModalShell>)
  const add = spyOn(document, 'addEventListener')
  const remove = spyOn(document, 'removeEventListener')
  await act(async () => root.render(<ModalShell isOpen closeOnEscape={false} onClose={() => closed.push('new')}>Content</ModalShell>))
  escape()
  expect(closed).toEqual([])
  await act(async () => root.render(<ModalShell isOpen onClose={() => closed.push('new')}>Content</ModalShell>))
  escape()
  expect(closed).toEqual(['new'])
  expect(document.body.style.overflow).toBe('hidden')
  expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0)
  expect(remove.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0)
  await act(async () => root.render(<ModalShell isOpen={false} onClose={() => {}}>Content</ModalShell>))
  expect(document.body.style.overflow).toBe('')
  expect(remove.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1)
})

test('closing a voice-library shell keeps its parent open and the page locked', async () => {
  const closed: string[] = []
  document.body.style.overflow = 'clip'
  const parent = <ModalShell key="parent" isOpen onClose={() => closed.push('parent')}>Voice settings</ModalShell>
  await mount(parent)
  await act(async () => root.render(<>{parent}<ModalShell key="library" isOpen onClose={() => closed.push('library')}>Library</ModalShell></>))
  escape()
  expect(closed).toEqual(['library'])
  await act(async () => root.render(parent))
  expect(document.body.style.overflow).toBe('hidden')
  escape()
  expect(closed).toEqual(['library', 'parent'])
  await act(async () => root.render(null))
  expect(document.body.style.overflow).toBe('clip')
  document.body.style.overflow = ''
})

test('context-menu callback updates keep the original touch guard and latest dismissal callback', async () => {
  let now = 0
  spyOn(performance, 'now').mockImplementation(() => now)
  const closed: string[] = []
  const position = { x: 20, y: 30 }
  await mount(<ContextMenu position={position} items={[]} onClose={() => closed.push('old')} />)
  now = 100
  await act(async () => root.render(<ContextMenu position={position} items={[]} onClose={() => closed.push('new')} />))
  act(() => document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })))
  expect(closed).toEqual([])
  now = 151
  act(() => document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })))
  expect(closed).toEqual(['new'])
  escape()
  expect(closed).toEqual(['new', 'new'])
  await act(async () => root.render(<ContextMenu position={null} items={[]} onClose={() => closed.push('hidden')} />))
  escape()
  expect(closed).toHaveLength(2)
})

test('opening another menu dismisses the existing menu using its latest committed callback', async () => {
  const closed: string[] = []
  const firstPosition = { x: 10, y: 20 }
  const first = (name: string) => <ContextMenu key="first" position={firstPosition} items={[]} onClose={() => closed.push(name)} />
  await mount(first('old'))
  await act(async () => root.render(first('new')))
  await act(async () => root.render(<>{first('new')}<ContextMenu key="second" position={{ x: 30, y: 40 }} items={[]} onClose={() => {}} /></>))
  expect(closed).toEqual(['new'])
})
