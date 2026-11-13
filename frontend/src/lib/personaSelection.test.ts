import { beforeEach, expect, mock, test } from 'bun:test'

let save: () => Promise<void> = async () => {}
const notices: string[] = []
const state = {
  activeChatId: 'chat-1' as string | null,
  activeChatMetadata: { active_persona_id: 'persona-1', other: 'kept' } as Record<string, unknown> | null,
  activePersonaId: 'persona-1' as string | null,
  activeCharacterId: null,
  characters: [],
  personas: [{ id: 'persona-1', name: 'Ann' }, { id: 'persona-2', name: 'Bea' }],
  characterPersonaBindings: {},
  personaTagBindings: {},
  setActiveChatMetadata(metadata: Record<string, unknown> | null) { state.activeChatMetadata = metadata },
  setActivePersona(id: string | null) { state.activePersonaId = id },
}

mock.module('@/store', () => ({ useStore: { getState: () => state } }))
mock.module('@/api/chats', () => ({ chatsApi: { patchMetadata: () => save() } }))
mock.module('@/i18n', () => ({ default: { t: (key: string) => key } }))
mock.module('@/lib/toast', () => ({ toast: {
  info: (message: string) => { notices.push(message) },
  error: (message: string) => { notices.push(message) },
} }))

const { selectPersona } = await import('./personaSelection')

beforeEach(() => {
  state.activeChatId = 'chat-1'
  state.activeChatMetadata = { active_persona_id: 'persona-1', other: 'kept' }
  state.activePersonaId = 'persona-1'
  save = async () => {}
  notices.length = 0
})

test('a saved-chat selection remains pending until persistence finishes', async () => {
  let finish!: () => void
  save = () => new Promise<void>((resolve) => { finish = resolve })
  const pending = selectPersona('persona-2')
  expect(pending).toBeInstanceOf(Promise)
  expect(state.activePersonaId).toBe('persona-2')
  expect(notices).toEqual([])
  finish()
  await pending
  expect(notices).toEqual(['personaManager.toast.switchedToPersona'])
})

test('a failed saved-chat selection rejects and restores only its persona field', async () => {
  let fail!: (error: Error) => void
  save = () => new Promise<void>((_, reject) => { fail = reject })
  const pending = selectPersona('persona-2')
  state.activeChatMetadata = { ...state.activeChatMetadata, wallpaper: 'new-wallpaper' }
  fail(new Error('save failed'))
  await expect(pending).rejects.toThrow('save failed')
  expect(state.activePersonaId).toBe('persona-1')
  expect(state.activeChatMetadata).toEqual({ active_persona_id: 'persona-1', other: 'kept', wallpaper: 'new-wallpaper' })
})

test('a failed selection cannot overwrite a chat opened while it was saving', async () => {
  let fail!: (error: Error) => void
  save = () => new Promise<void>((_, reject) => { fail = reject })
  const pending = selectPersona('persona-2')
  state.activeChatId = 'chat-2'
  state.activeChatMetadata = { active_persona_id: 'persona-2', other: 'chat-2' }
  state.activePersonaId = 'persona-2'
  fail(new Error('save failed'))
  await expect(pending).rejects.toThrow('save failed')
  expect(state.activePersonaId).toBe('persona-2')
  expect(state.activeChatMetadata).toEqual({ active_persona_id: 'persona-2', other: 'chat-2' })
})

test('the persona manager can still deactivate the global selection', async () => {
  state.activeChatId = null
  await selectPersona(null)
  expect(state.activePersonaId).toBeNull()
  expect(notices).toEqual(['personaManager.toast.personaDeactivated'])
})

test('an older failure cannot roll back a newer successful selection in the same chat', async () => {
  let fail!: (error: Error) => void
  save = () => new Promise<void>((_, reject) => { fail = reject })
  const previous = selectPersona('persona-2')
  save = async () => {}
  await selectPersona('persona-1')
  fail(new Error('older save failed'))
  await expect(previous).rejects.toThrow('older save failed')
  expect(state.activePersonaId).toBe('persona-1')
  expect(state.activeChatMetadata?.active_persona_id).toBe('persona-1')
})
