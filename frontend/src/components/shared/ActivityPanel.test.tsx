import { afterAll, afterEach, expect, test } from 'bun:test'
import { act, useEffect, useState } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { ActivityPanel } from './ActivityPanel'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})
let root: Root
let host: HTMLDivElement
const lifecycle: string[] = []
function SettingsPanel({ name }: { name: string }) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    lifecycle.push(`start:${name}`)
    return () => { lifecycle.push(`stop:${name}`) }
  }, [name])
  return <section data-panel={name}>
    <button onClick={() => setCount((value) => value + 1)}>{count}</button>
    <textarea defaultValue="draft" />
  </section>
}
function Settings({ active }: { active: string }) {
  return <>
    <ActivityPanel active={active === 'display'}><SettingsPanel name="display" /></ActivityPanel>
    <ActivityPanel active={active === 'chat'}><SettingsPanel name="chat" /></ActivityPanel>
  </>
}
async function show(active: string) { await act(async () => root.render(<Settings active={active} />)) }
async function mount(active: string) {
  host = document.createElement('div')
  document.body.append(host)
  root = (await import('react-dom/client')).createRoot(host)
  await show(active)
}
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  host?.remove()
  lifecycle.length = 0
})
afterAll(() => dom.window.close())

test('does not render an unvisited category, and starts its effects on first visit', async () => {
  await mount('display')
  expect(host.querySelector('[data-panel="chat"]')).toBeNull()
  expect(lifecycle).toEqual(['start:display'])
  await show('chat')
  expect(host.querySelector('[data-panel="chat"]')).not.toBeNull()
  expect(lifecycle).toEqual(['start:display', 'stop:display', 'start:chat'])
})

test('preserves React state, DOM drafts, and scroll while pausing hidden effects', async () => {
  await mount('display')
  const panel = host.querySelector<HTMLElement>('[data-panel="display"]')!
  const textarea = panel.querySelector('textarea')!
  textarea.value = 'unsaved draft'
  panel.scrollTop = 180
  act(() => panel.querySelector('button')!.click())
  await show('chat')
  expect(panel.style.display).toBe('none')
  expect(lifecycle).toContain('stop:display')
  await show('display')
  expect(host.querySelector('[data-panel="display"]') === panel).toBe(true)
  expect(panel.style.display).not.toBe('none')
  expect(panel.querySelector('button')!.textContent).toBe('1')
  expect(textarea.value).toBe('unsaved draft')
  expect(panel.scrollTop).toBe(180)
  expect(lifecycle).toEqual(['start:display', 'stop:display', 'start:chat', 'stop:chat', 'start:display'])
})

test('unmounting the settings session cleans up and discards retained drafts', async () => {
  await mount('display')
  host.querySelector('textarea')!.value = 'private draft'
  await show('chat')
  await act(async () => root.render(null))
  expect(host.childElementCount).toBe(0)
  expect(lifecycle).toEqual(['start:display', 'stop:display', 'start:chat', 'stop:chat'])
  await show('display')
  expect(host.querySelector('textarea')!.value).toBe('draft')
})
