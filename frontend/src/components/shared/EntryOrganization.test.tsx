import { afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement, createRef, StrictMode } from 'react'
import type { Root } from 'react-dom/client'
import type { WorldBookEntry, WorldBookEntryOrganizationSummary } from '@/types/api'

const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
class ApiError extends Error { constructor(readonly status: number, message: string) { super(message) } }
mock.module('@/api/client', () => ({ ApiError }))
mock.module('./EntryOrganization.module.css', () => ({ default: new Proxy({}, { get: (_, key) => String(key) }) }))
const summary: WorldBookEntryOrganizationSummary = { total: 102, unfiled: 2, folders: [{ name: 'Characters', count: 100 }], tags: [{ name: 'a,b', count: 99 }, { name: 'Villain', count: 2 }] }
const calls: Array<{ bookId: string; input: any }> = []
let writeError: Error | null = null
let reloadError: Error | null = null
let reloads = 0
mock.module('@/api/world-books', () => ({ worldBooksApi: {
  getEntryOrganization: async () => summary,
  bulkEntryAction: async (bookId: string, input: any) => { calls.push({ bookId, input }); if (writeError) throw writeError; return { affected: 1 } },
  entryFolderAction: async (bookId: string, input: any) => { calls.push({ bookId, input }); if (writeError) throw writeError; return { affected: 100 } },
} }))
const { createRoot } = await import('react-dom/client')
const { default: Controls, EntryFolderList } = await import('./EntryOrganizationControls')
const { default: Fields } = await import('./EntryOrganizationFields')
let root: Root | null = null
let host: HTMLDivElement
const rows = [{ id: 'e1', revision: 7, folder: 'Characters', tags: ['Villain'] }] as WorldBookEntry[]
const books = [{ id: 'b1', name: 'Source' }, { id: 'b2', name: 'Target' }] as any
const render = async (component: React.ReactNode) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root!.render(component) })
}
const button = (text: string) => {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text)
  if (!node) throw new Error(`Missing button ${text}`)
  return node
}
const click = async (text: string) => { await act(async () => { button(text).click() }) }
const input = async (label: string, text: string) => {
  const node = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(node, text)
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
const controls = (props = {}) => createElement(Controls, { bookId: 'b1', books, summary, folder: 'Characters', root: false, tags: [], entries: rows, selectedIds: ['e1'], onRoot: () => {}, onTags: () => {}, onReload: async () => { reloads++; if (reloadError) throw reloadError }, ...props })
afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  root = null; document.body.innerHTML = ''; calls.length = 0; writeError = null; reloadError = null; reloads = 0
})

describe('native entry organization interactions', () => {
  test('folder navigation uses book-wide counts and distinguishes All from Unfiled', async () => {
    const selected: Array<string | undefined> = []
    await render(createElement(EntryFolderList, { summary, onOpen: value => selected.push(value) }))
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')]
    await act(async () => { buttons[0]!.click(); buttons[1]!.click(); buttons[2]!.click() })
    expect(selected).toEqual([undefined, '', 'Characters'])
    expect(host.textContent).toContain('100')
    expect(buttons.every(node => node.classList.contains('folderRow'))).toBe(true)
    expect(buttons.every(node => node.querySelectorAll('svg[aria-hidden="true"]').length === 2)).toBe(true)
    expect(buttons.map(node => node.querySelector('span')?.textContent)).toEqual(['All entries', 'Unfiled', 'Characters'])
  })
  test('empty organization chrome is hidden but moving an entry can still create the first folder', async () => {
    const ref = createRef<import('./EntryOrganizationControls').EntryOrganizationHandle>()
    await render(controls({ ref, summary: { total: 1, unfiled: 1, folders: [], tags: [] }, folder: undefined, root: false, hideSelectionActions: true }))
    expect(host.querySelector<HTMLElement>('.controls')!.hidden).toBe(true)
    expect(host.querySelector('.navigatorHeader')).toBeNull()
    await act(async () => { ref.current!.openMove(['e1'], '') })
    await input('Destination folder', 'Characters'); await click('Move')
    expect(calls[0]!.input).toMatchObject({ action: 'move', target_folder: 'Characters', entry_ids: ['e1'] })
  })
  test('tag filter preserves comma spelling and appends to all-of selection', async () => {
    const selected: string[][] = []
    await render(controls({ tags: ['Villain'], onTags: (value: string[]) => selected.push(value) }))
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Filter entry tags"]')!
    await act(async () => { select.value = 'a,b'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
    expect(selected).toEqual([['Villain', 'a,b']])
  })
  test('a removed tag remains clearable in a folderless book', async () => {
    const selected: string[][] = []
    await render(controls({ summary: { total: 1, unfiled: 1, folders: [], tags: [] }, folder: undefined, tags: ['Villain'], hideSelectionActions: true, onTags: (value: string[]) => selected.push(value) }))
    expect(host.querySelector<HTMLElement>('.controls')!.hidden).toBe(false)
    await click('Villain ×')
    expect(selected).toEqual([[]])
  })
  test('same-book move sends an explicit Unfiled folder and expected entry revision', async () => {
    await render(controls()); await click('Move selected…'); await input('Destination folder', '   '); await click('Move')
    expect(calls).toEqual([{ bookId: 'b1', input: { action: 'move', entry_ids: ['e1'], target_book_id: 'b1', target_folder: '', expected_revisions: { e1: 7 } } }])
    expect(reloads).toBe(1); expect(document.querySelector('dialog')).toBeNull()
  })
  test('live selection changes cannot silently change an open move or its revision preconditions', async () => {
    await render(controls()); await click('Move selected…')
    await act(async () => { root!.render(controls({ entries: [{ ...rows[0], revision: 8 }, { id: 'e2', revision: 3 }] as WorldBookEntry[], selectedIds: ['e2'] })) })
    await click('Move')
    expect(calls[0]!.input.entry_ids).toEqual(['e1'])
    expect(calls[0]!.input.expected_revisions).toEqual({ e1: 7 })
  })
  test('consolidated selection actions retain revision snapshots and restore focus to the toolbar', async () => {
    const ref = createRef<import('./EntryOrganizationControls').EntryOrganizationHandle>()
    await render(controls({ ref, hideSelectionActions: true }))
    expect([...document.querySelectorAll('button')].some(node => node.textContent === 'Add tags…')).toBe(false)
    const source = document.createElement('button'); document.body.append(source)
    await act(async () => { ref.current!.openTags!('add_tags', ['e1'], source) })
    await input('Bulk tag', ' a,b '); await click('Apply tags')
    expect(calls[0]!.input).toEqual({ action: 'add_tags', entry_ids: ['e1'], tags: ['a,b'], expected_revisions: { e1: 7 } })
    expect(document.activeElement).toBe(source)
  })
  test('row context move uses the same dialog with only the requested entry', async () => {
    const ref = createRef<{ openMove(ids: string[], folder: string): void }>()
    await render(controls({ ref, selectedIds: [] }))
    await act(async () => { ref.current!.openMove(['e1'], 'Characters') })
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Destination folder"]')!.value).toBe('Characters')
    const target = document.querySelector<HTMLSelectElement>('select[aria-label="Destination lorebook"]')!
    await act(async () => { target.value = 'b2'; target.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
    await input('Destination folder', 'New folder'); await click('Move')
    expect(calls[0]!.input).toEqual({ action: 'move', entry_ids: ['e1'], expected_revisions: { e1: 7 }, target_book_id: 'b2', target_folder: 'New folder' })
  })
  test('whole-folder remove does not enumerate entries and explicitly promises unfiling', async () => {
    await render(controls()); await click('Remove folder')
    expect(document.querySelector('dialog')!.textContent).toContain('Entries will remain in this lorebook and become Unfiled.')
    await act(async () => { document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!.click() })
    expect(calls[0]!.input).toMatchObject({ action: 'remove', folder: 'Characters' })
    expect(calls[0]!.input.entry_ids).toBeUndefined()
  })
  test('rename trim and merge work while mounted under StrictMode', async () => {
    await render(createElement(StrictMode, null, controls())); await click('Rename folder'); await input('New folder name', ' Locations '); await click('Rename')
    expect(calls[0]!.input).toMatchObject({ action: 'rename', folder: 'Characters', target_folder: 'Locations' })
    expect(document.querySelector('dialog')).toBeNull()
  })
  test('additive tag action keeps the tag as a single value, rather than splitting commas', async () => {
    await render(controls()); await click('Add tags…'); await input('Bulk tag', ' a,b '); await click('Apply tags')
    expect(calls[0]!.input).toEqual({ action: 'add_tags', entry_ids: ['e1'], tags: ['a,b'], expected_revisions: { e1: 7 } })
  })
  test('stale revision rejection retains the dialog and requires reload before retry', async () => {
    writeError = new ApiError(409, 'Entry changed')
    await render(controls()); await click('Move selected…'); await click('Move')
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Entry changed')
    expect(button('Move').disabled).toBe(true)
    writeError = null; await click('Reload entries'); expect(button('Move').disabled).toBe(false)
    await click('Move'); expect(calls.length).toBe(2)
  })
  test('acknowledged write followed by failed reload cannot be repeated by closing the dialog', async () => {
    reloadError = new Error('offline')
    await render(controls()); await click('Move selected…'); await click('Move')
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Changes were saved')
    await click('Cancel'); expect(button('Move selected…').disabled).toBe(true)
    expect(calls.length).toBe(1)
    reloadError = null; await click('Reload entries'); expect(button('Move selected…').disabled).toBe(false)
  })
  test('lost write reply requires reconciliation without claiming success', async () => {
    writeError = new Error('connection lost')
    await render(controls()); await click('Move selected…'); await click('Move')
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('may have been saved')
    expect(button('Move').disabled).toBe(true)
    expect(reloads).toBe(0)
  })
  test('invalid rename is a definite rejection and retains the form for correction', async () => {
    writeError = new ApiError(400, 'Invalid folder')
    await render(controls()); await click('Rename folder'); await input('New folder name', 'Target'); await click('Rename')
    expect(button('Rename').disabled).toBe(false); expect(calls.length).toBe(1)
  })
  test('editor tag removal is sparse and leaves folder untouched', async () => {
    const edits: any[] = []
    await render(createElement(Fields, { bookId: 'b1', folder: 'Characters', tags: ['a,b', 'Villain'], onChange: value => edits.push(value) }))
    await click('a,b ×'); expect(edits).toEqual([{ tags: ['Villain'] }])
    expect(document.querySelector('datalist')!.textContent).toBe('')
    expect(document.querySelector('option[value="Characters"]')).not.toBeNull()
  })
})
