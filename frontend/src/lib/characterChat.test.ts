import { beforeEach, expect, mock, test } from 'bun:test'
import type { Character } from '@/types/api'

let character = { id: 'char-1', alternate_greetings: [] } as unknown as Character
let chats: { id: string }[] = []
let create: (input: unknown) => Promise<{ id: string }> = async () => ({ id: 'new-chat' })
let picker: { onSelect: (index: number) => Promise<void> } | undefined
const calls: unknown[] = []

mock.module('@/api/characters', () => ({ charactersApi: { get: async () => character } }))
mock.module('@/api/chats', () => ({ chatsApi: {
  listCharacterChats: async () => chats,
  create: (input: unknown) => { calls.push(input); return create(input) },
} }))
mock.module('@/store', () => ({ useStore: { getState: () => ({
  openModal: (id: string, props: typeof picker) => { calls.push(id); picker = props },
}) } }))
mock.module('@/i18n', () => ({ default: { t: (key: string) => key } }))
mock.module('@/lib/toast', () => ({ toast: {
  info: () => 'creation-toast',
  dismiss: (id: string) => { calls.push(`dismiss:${id}`) },
  error: (key: string) => { calls.push(key) },
} }))

const { openCharacterChat, startCharacterChat } = await import('./characterChat')
const navigate = (path: string) => { calls.push(path) }

beforeEach(() => {
  character = { id: 'char-1', alternate_greetings: [] } as unknown as Character
  chats = []
  create = async () => ({ id: 'new-chat' })
  picker = undefined
  calls.length = 0
})

test('latest opens the first server-ordered chat without creating another', async () => {
  chats = [{ id: 'newest-chat' }, { id: 'older-chat' }]
  await openCharacterChat(character.id, 'latest', navigate)
  expect(calls).toEqual(['/chat/newest-chat'])
})

test('latest creates a chat when the character has no chats', async () => {
  await openCharacterChat(character.id, 'latest', navigate)
  expect(calls).toEqual([{ character_id: 'char-1' }, 'dismiss:creation-toast', '/chat/new-chat'])
})

test('new preserves the greeting picker and creates the selected greeting', async () => {
  character.alternate_greetings = ['alternate']
  chats = [{ id: 'existing-chat' }]
  await openCharacterChat(character.id, 'new', navigate)
  expect(calls).toEqual(['greetingPicker'])
  await picker!.onSelect(1)
  expect(calls).toEqual(['greetingPicker', { character_id: 'char-1', greeting_index: 1 }, 'dismiss:creation-toast', '/chat/new-chat'])
})

test('failed creation dismisses the progress toast and rejects without navigating', async () => {
  create = async () => { throw new Error('creation failed') }
  await expect(startCharacterChat(character, navigate)).rejects.toThrow('creation failed')
  expect(calls).toEqual([{ character_id: 'char-1' }, 'dismiss:creation-toast'])
})

test('greeting-picker failures retain the existing UI error handling', async () => {
  character.alternate_greetings = ['alternate']
  create = async () => { throw new Error('creation failed') }
  await startCharacterChat(character, navigate)
  await picker!.onSelect(0)
  expect(calls).toEqual(['greetingPicker', { character_id: 'char-1', greeting_index: 0 }, 'dismiss:creation-toast', 'chat.toast.failedCreateChat'])
})
