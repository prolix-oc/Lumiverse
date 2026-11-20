import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, StrictMode } from 'react'
import type { Root } from 'react-dom/client'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.example/widget/character/lumi' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
let id = 'lumi', reads = 0, starts = 0
let load: () => Promise<any> = async () => ({ id: 'lumi', alternate_greetings: ['Hello'] })
const navigations: string[] = []
const navigate = (path: string) => { navigations.push(path) }
mock.module('react-router', () => ({ useParams: () => ({ id }), useNavigate: () => navigate }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, options: { defaultValue: string }) => options.defaultValue }) }))
mock.module('@/api/characters', () => ({ charactersApi: { get: async () => { reads++; return load() } } }))
mock.module('@/lib/characterChat', () => ({ startCharacterChat: async (character: { id: string }, next: (path: string) => void) => {
  expect(character.id).toBe(id); starts++; next('/chat/created')
} }))
const Page = (await import('./WidgetCharacterPage')).default
let root: Root
beforeEach(async () => {
  id = 'lumi'; reads = 0; starts = 0; navigations.length = 0
  load = async () => ({ id: 'lumi', alternate_greetings: ['Hello'] })
  root = (await import('react-dom/client')).createRoot(document.body.appendChild(document.createElement('div')))
})
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren() })
afterAll(() => { mock.restore(); dom.window.close() })

test('a no-chat widget tap invokes the existing greeting/chat flow once under Strict Mode', async () => {
  await act(async () => { root.render(<StrictMode><Page /></StrictMode>) })
  expect(starts).toBe(1); expect(navigations).toEqual(['/chat/created'])
});
test('a late character response after leaving the route cannot create a chat', async () => {
  let resolve!: (value: any) => void
  load = () => new Promise(done => { resolve = done })
  await act(async () => { root.render(<Page />) })
  await act(async () => { root.render(null) })
  await act(async () => { resolve({ id: 'lumi' }) })
  expect(starts).toBe(0); expect(navigations).toEqual([])
});
test('invalid and unreadable characters never create chats', async () => {
  id = '../outside'
  await act(async () => { root.render(<Page />) })
  expect(reads).toBe(0); expect(starts).toBe(0)
  id = 'missing'; load = async () => { throw new Error('not found') }
  await act(async () => { root.render(<Page />) })
  expect(starts).toBe(0); expect(document.body.textContent).toContain('unavailable')
});
