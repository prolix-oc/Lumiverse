import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { create } from 'zustand'
import { JSDOM } from 'jsdom'
import type { Character, Message } from '@/types/api'

const character = {
  id: 'speaker', name: 'Mira', first_mes: 'Welcome', alternate_greetings: ['Another opening'],
  extensions: { greeting_backgrounds: { 0: 'dawn', 1: 'dusk' } },
} as unknown as Character
const initialState = {
  showGreetingImage: false,
  greetingImagePosition: 'top' as 'top' | 'bottom',
  activeCharacterId: character.id,
  activeChatId: 'chat',
  activeChatMetadata: {} as Record<string, any>,
  characters: [character] as Character[],
}
const store = create(() => initialState)
const getCharacter = mock((_id: string): Promise<Character> => Promise.resolve(character))
mock.module('@/store', () => ({ useStore: store }))
mock.module('@/api/characters', () => ({ charactersApi: { get: getCharacter } }))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
})
const { useGreetingMessageImage } = await import('./useGreetingMessageImage')
let host: HTMLDivElement
let root: Root
const opening = {
  id: 'opening', chat_id: 'chat', index_in_chat: 0, is_user: false,
  content: 'Welcome', extra: { greeting: true, greeting_character_id: character.id, greeting_index: 0 },
} as unknown as Message

function Probe({ message = opening, visible = true }: { message?: Message; visible?: boolean }) {
  const greeting = useGreetingMessageImage(message, message.content, visible)
  return (
    <>
      <div data-image={greeting.image?.url} data-position={greeting.position}>{greeting.content}</div>
      <button type="button" data-image-failure aria-label="Simulate image failure" onClick={greeting.handleImageError} />
      <button type="button" data-image-ready aria-label="Simulate image ready" onClick={greeting.handleImageReady} />
    </>
  )
}

beforeEach(() => {
  store.setState(initialState, true)
  getCharacter.mockReset()
  getCharacter.mockImplementation(() => Promise.resolve(character))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
async function render(message = opening, visible = true) {
  await act(async () => { root.render(<Probe message={message} visible={visible} />) })
  return host.firstElementChild!
}

test('does not fetch or alter content while opted out, including uncached characters', async () => {
  store.setState({ characters: [] })
  const element = await render()
  expect(element.hasAttribute('data-image')).toBe(false)
  expect(element.textContent).toBe(opening.content)
  expect(getCharacter).not.toHaveBeenCalled()
})

test('reacts immediately to opt-in, placement and greeting changes', async () => {
  const element = await render()
  await act(async () => { store.setState({ showGreetingImage: true }) })
  expect(element.getAttribute('data-image')).toEndWith('/images/dawn')
  await act(async () => { store.setState({ greetingImagePosition: 'bottom' }) })
  expect(element.getAttribute('data-position')).toBe('bottom')
  await render({ ...opening, content: 'Another opening', extra: { ...opening.extra, greeting_index: 1 } })
  expect(element.getAttribute('data-image')).toEndWith('/images/dusk')
  await act(async () => { store.setState({ showGreetingImage: false }) })
  expect(element.hasAttribute('data-image')).toBe(false)
})

test('does not fetch art for user messages, later messages, editing or streaming', async () => {
  store.setState({ showGreetingImage: true, characters: [] })
  expect((await render({ ...opening, is_user: true })).hasAttribute('data-image')).toBe(false)
  expect((await render({ ...opening, index_in_chat: 1 })).hasAttribute('data-image')).toBe(false)
  expect((await render(opening, false)).hasAttribute('data-image')).toBe(false)
  expect(getCharacter).not.toHaveBeenCalled()
})

test('uses a group greeting owner instead of the currently active speaker', async () => {
  store.setState({ showGreetingImage: true, activeCharacterId: 'another-speaker' })
  expect((await render()).getAttribute('data-image')).toEndWith('/images/dawn')
  expect(getCharacter).not.toHaveBeenCalled()
})

test('does not attach greeting art to an unmarked first assistant reply', async () => {
  store.setState({ showGreetingImage: true, activeChatMetadata: { activeGreetingIndex: 0 } })
  const generated = {
    id: 'reply', chat_id: 'chat', index_in_chat: 0, is_user: false,
    content: 'Generated opening', extra: {},
  } as unknown as Message
  expect((await render(generated)).hasAttribute('data-image')).toBe(false)
  // Legacy chats without greeting metadata still resolve art from content.
  expect((await render({ ...opening, extra: {} })).getAttribute('data-image')).toEndWith('/images/dawn')
})

test('removes a promoted inline image only from display content', async () => {
  const content = '![Dawn](gallery://dawn)\n\nWelcome'
  store.setState({
    showGreetingImage: true,
    characters: [{ ...character, extensions: { risu_asset_map: { 'gallery://dawn': 'dawn' } } }],
  })
  const message = { ...opening, content }
  expect((await render(message)).textContent).toBe('\n\nWelcome')
  expect(message.content).toBe(content)
  await act(async () => { store.setState({ showGreetingImage: false }) })
  expect(host.textContent).toBe(content)
})

test('restores the inline image when promoted art fails, and strips it after a retry', async () => {
  const content = '![Dawn](gallery://dawn)\n\nWelcome'
  store.setState({
    showGreetingImage: true,
    characters: [{ ...character, extensions: { risu_asset_map: { 'gallery://dawn': 'dawn' } } }],
  })
  const element = await render({ ...opening, content })
  expect(element.textContent).toBe('\n\nWelcome')

  await act(async () => { host.querySelector<HTMLButtonElement>('[data-image-failure]')!.click() })
  expect(element.textContent).toBe(content)

  await act(async () => { host.querySelector<HTMLButtonElement>('[data-image-ready]')!.click() })
  expect(element.textContent).toBe('\n\nWelcome')
})

test('ignores character requests that finish after switching to another greeting owner', async () => {
  const pending = new Map<string, (character: Character) => void>()
  getCharacter.mockImplementation((id) => new Promise((resolve) => { pending.set(id, resolve) }))
  store.setState({ showGreetingImage: true, characters: [] })
  await render()
  const otherMessage = { ...opening, extra: { ...opening.extra, greeting_character_id: 'other' } }
  await render(otherMessage)
  await act(async () => { pending.get(character.id)!(character) })
  expect(host.firstElementChild!.hasAttribute('data-image')).toBe(false)
  await act(async () => { pending.get('other')!({ ...character, id: 'other', extensions: { greeting_backgrounds: { 0: 'other-art' } } }) })
  expect(host.firstElementChild!.getAttribute('data-image')).toEndWith('/images/other-art')
})
