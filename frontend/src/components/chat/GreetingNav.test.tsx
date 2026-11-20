import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { Character, Message } from '@/types/api'

const character = { id: 'speaker', first_mes: 'Opening', alternate_greetings: ['', '', 'Repeated', 'Repeated'], extensions: {} } as Character
const state = {
  activeCharacterId: character.id,
  isGroupChat: false,
  groupCharacterIds: [],
  totalChatLength: 1,
  characters: [character],
}
mock.module('@/store', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }))
mock.module('react-router', () => ({ useNavigate: () => () => {} }))
mock.module('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, values?: { number?: number }) => values?.number ? `${key}:${values.number}` : key,
}) }))
mock.module('@/components/shared/ModalShell', () => ({
  ModalShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { default: GreetingNav } = await import('./GreetingNav')
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  state.activeCharacterId = character.id
  state.isGroupChat = false
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function activeGreeting(content: string, index?: unknown, group = false) {
  state.isGroupChat = group
  if (group) state.activeCharacterId = 'different-speaker'
  const message: Message = {
    id: 'opening', chat_id: 'chat', index_in_chat: 0, is_user: false, name: 'Speaker', content,
    send_date: 0, swipe_id: 0, swipes: [content], swipe_dates: [0], parent_message_id: null, branch_id: null, created_at: 0,
    extra: { greeting: true, greeting_character_id: character.id, greeting_index: index },
  }
  await act(async () => { root.render(<GreetingNav message={message} chatId="chat" />) })
  await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click() })
  return Array.from(host.querySelectorAll('button'))
    .filter((button) => button.textContent?.includes('greetingPicker.active'))
    .map((button) => button.textContent!.match(/greetingPicker\.(?:greetingNumber:\d+|defaultGreeting)/)![0])
}

test('identifies the selected empty duplicate', async () => {
  expect(await activeGreeting('', 2)).toEqual(['greetingPicker.greetingNumber:3'])
})
test('identifies the selected nonempty duplicate', async () => {
  expect(await activeGreeting('Repeated', 4)).toEqual(['greetingPicker.greetingNumber:5'])
})
test('uses the opening message identity for a group member', async () => {
  expect(await activeGreeting('', 2, true)).toEqual(['greetingPicker.greetingNumber:3'])
})
test('retains the default greeting identity', async () => {
  expect(await activeGreeting('Opening', 0)).toEqual(['greetingPicker.defaultGreeting'])
})
test.each([undefined, -1, 99, 1.5, '2', null])('retains content matching without a valid identity: %s', async (index) => {
  expect(await activeGreeting('Repeated', index)).toEqual(['greetingPicker.greetingNumber:4'])
})
test('does not mark an edited or removed source as active', async () => {
  expect(await activeGreeting('Edited opening', 2)).toEqual([])
})
test('matches current content if greeting order or source changed', async () => {
  expect(await activeGreeting('Repeated', 2)).toEqual(['greetingPicker.greetingNumber:4'])
})
