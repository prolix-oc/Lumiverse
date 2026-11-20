import { afterEach, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, useEffect, useState } from 'react'
import type { Root } from 'react-dom/client'
import { ConnectionEditorContext, useConnectionEditor } from './useConnectionEditor'
import { useConnectionEditors } from './useConnectionEditors'
import type { ConnectionPlacement } from '@/lib/connectionPlacement'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const expanded: string[] = []
const expand = (id: string) => { expanded.push(id) }
let controller: ReturnType<typeof useConnectionEditors>
const rows = new Map<string, ReturnType<typeof useConnectionEditor>>()
function Row({ id, placement }: { id: string; placement: ConnectionPlacement }) {
  const editor = useConnectionEditor(id, placement)
  useEffect(() => { rows.set(`${placement}/${id}`, editor) }, [id, placement, editor])
  const [draft, setDraft] = useState('unsaved')
  return editor.editing ? <input aria-label={`${placement}/${id}`} value={draft} onChange={event => setDraft(event.target.value)} /> : null
}
function Collection({ ids, recent }: { ids: string[]; recent: string[] }) {
  const current = useConnectionEditors(ids.map(id => ({ id })), recent, expand)
  useEffect(() => { controller = current }, [current])
  return <ConnectionEditorContext.Provider value={current.context}>
    {(['list', 'recent'] as const).map(placement => <section key={placement}>
      {(placement === 'list' ? ids : current.recentIds).filter(id => ids.includes(id)).map(id =>
        <div key={id} ref={node => current.registerEntry(id, placement, node)}><Row id={id} placement={placement} /></div>)}
    </section>)}
    {ids.map(id => <Row key={id} id={id} placement="preview" />)}
  </ConnectionEditorContext.Provider>
}
let root: Root | undefined
let host: HTMLDivElement
async function render(ids = ['one', 'two'], recent = ['one', 'two']) {
  if (!root) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) }
  await act(async () => root!.render(<Collection ids={ids} recent={recent} />))
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove(); root = undefined; rows.clear(); expanded.length = 0
})

test('a duplicate placement reveals the existing draft and previews never become editors', async () => {
  await render()
  await act(async () => rows.get('list/one')!.setEditing(true))
  const original = host.querySelector('input')!
  await act(async () => rows.get('recent/one')!.setEditing(true))
  expect(host.querySelectorAll('input')).toHaveLength(1)
  expect(document.activeElement).toBe(original)
  expect(expanded).toEqual(['one'])
  expect(rows.get('recent/one')!.dragDisabled).toBe(true)
  await act(async () => rows.get('preview/one')!.setEditing(true))
  expect(rows.get('preview/one')!.editing).toBe(false)
  expect(host.querySelector('input')).toBe(original)
})

test('recent order stays stable while editing, then catches up when the draft closes', async () => {
  await render()
  await act(async () => rows.get('recent/two')!.setEditing(true))
  const original = host.querySelector('input')!
  await render(['one', 'two', 'three'], ['three', 'one'])
  expect(controller.recentIds).toEqual(['one', 'two'])
  expect(host.querySelector('input')).toBe(original)
  await act(async () => rows.get('recent/two')!.setEditing(false))
  expect(controller.recentIds).toEqual(['three', 'one'])
})

test('deleting an edited profile releases its recent snapshot without closing other drafts', async () => {
  await render()
  await act(async () => { rows.get('recent/two')!.setEditing(true); rows.get('list/one')!.setEditing(true) })
  await render(['one', 'three'], ['three', 'one'])
  expect(controller.hasEditor('two')).toBe(false)
  expect(controller.hasEditor('one')).toBe(true)
  expect(controller.recentIds).toEqual(['three', 'one'])
})

test('focus after a move does not expand the former folder', async () => {
  await render()
  await act(async () => rows.get('list/one')!.setEditing(true))
  const draft = host.querySelector('input')!
  await act(async () => controller.focusEntry('one', 'list'))
  expect(document.activeElement).toBe(draft)
  expect(expanded).toEqual([])
})
