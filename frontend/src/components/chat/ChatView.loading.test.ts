import { expect, mock, test } from 'bun:test'
import ts from 'typescript'

// Execute the actual load effect with controlled IO, including cancellation
// between awaits, without mounting unrelated editors and extension surfaces.
const source = await Bun.file(new URL('./ChatView.tsx', import.meta.url)).text()
const file = ts.createSourceFile('ChatView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let effect = ''
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect'
    && node.arguments[0]?.getText(file).includes('const loadChat = async')) effect = node.arguments[0].getText(file)
  ts.forEachChild(node, visit)
}
visit(file)
if (!effect) throw new Error('Chat loading effect missing')
const compiled = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`const effect = ${effect}`)
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const response = (metadata = {}, characters = [{ id: 'character', name: 'Fresh', tags: [] }]) => ({
  chat: { id: 'A', character_id: 'character', name: 'Chat', metadata: { temporary: true, ...metadata } },
  messages: { data: [{ id: 'message', content: 'Saved' }], total: 1 }, characters,
})
function start(initial = {}, read = Promise.resolve(response()), recovery = Promise.resolve(), shared?: Record<string, any>) {
  const errors: unknown[] = []
  const state: Record<string, any> = shared ?? {
    activeChatId: 'A', characters: [], messages: [], activeChatMetadata: null, messagesPerPage: 50, chatHeads: [],
    setActiveCharacter(id: string) { state.activeCharacterId = id },
    setActiveChatDisplayOwner() {}, setActiveChatName() {},
    setActiveChatLoadedCharacterIds(ids: string[]) { state.activeChatLoadedCharacterIds = ids },
    setActiveChatMetadata(value: unknown) { state.activeChatMetadata = value },
    updateCharacter(id: string, character: unknown) { state.characters = [...state.characters.filter((item: any) => item.id !== id), character] },
    setGroupChat(group: boolean, ids: string[]) { state.group = group; state.groupIds = ids },
    clearGroupChat() {}, clearGroupExpressions() {}, clearMultiCharacterExpressions() {},
    ...initial,
  }
  const open = mock((_id: string, _limit: number, _options: unknown) => read)
  const legacyGet = mock(() => { throw new Error('Duplicate metadata request') })
  const characterGet = mock(async (id: string) => ({ id, name: 'Fallback' }))
  const acknowledge = mock(async () => {})
  const loadout = mock(async () => ({}))
  const deps = {
    chatId: 'A', useStore: { getState: () => state }, chatsApi: { open, get: legacyGet },
    charactersApi: { get: characterGet },
    setActiveChat: mock(), setMessages(data: unknown, total: number) { state.messages = data; state.total = total },
    recoverPooledGeneration: () => recovery, generateApi: { acknowledge }, loadoutsApi: { resolve: loadout },
    resolveCouncilForChat: async () => { throw new Error('No council binding') },
    console: { error: (...args: unknown[]) => errors.push(args) },
  }
  const close = new Function(...Object.keys(deps), `${compiled}; return effect()`)(...Object.values(deps))
  return { state, open, legacyGet, characterGet, acknowledge, loadout, close, errors }
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve() }

test.each([false, true])('solo open uses one core request and refreshes a character (cached=%s)', async (cached) => {
  const h = start({ characters: cached ? [{ id: 'character', name: 'Old' }] : [] })
  await settle()
  expect(h.errors).toEqual([])
  expect(h.open).toHaveBeenCalledTimes(1)
  expect(h.characterGet).not.toHaveBeenCalled()
  expect(h.legacyGet).not.toHaveBeenCalled()
  expect(h.state.characters[0].name).toBe('Fresh')
  expect(h.state.messages).toEqual([{ id: 'message', content: 'Saved' }])
  h.close()
  expect((h.open.mock.calls[0][2] as { signal: AbortSignal }).signal.aborted).toBe(true)
})

test('group open publishes all fresh members without per-member HTTP reads', async () => {
  const h = start({}, Promise.resolve(response({ group: true, character_ids: ['character', 'member'] }, [
    { id: 'character', name: 'Fresh', tags: [] }, { id: 'member', name: 'Member', tags: [] },
  ])))
  await settle()
  expect(h.errors).toEqual([])
  expect(h.state.groupIds).toEqual(['character', 'member'])
  expect(h.state.characters).toHaveLength(2)
  expect(h.characterGet).not.toHaveBeenCalled()
  expect(h.open).toHaveBeenCalledTimes(1)
  h.close()
})

test('opening snapshots preserve newer metadata and character edits received over WS', async () => {
  const pending = deferred<ReturnType<typeof response>>()
  const h = start({ characters: [{ id: 'character', name: 'Cached' }] }, pending.promise)
  h.state.setActiveChatMetadata({ temporary: true, persona_addon_states: { persona: { addon: false } } })
  h.state.updateCharacter('character', { id: 'character', name: 'Edited during load' })
  pending.resolve(response())
  await settle()
  expect(h.errors).toEqual([])
  expect(h.state.activeChatMetadata.persona_addon_states).toEqual({ persona: { addon: false } })
  expect(h.state.characters[0].name).toBe('Edited during load')
  h.close()
})

test('an old A → B → A response cannot overwrite the return visit', async () => {
  const pending = deferred<ReturnType<typeof response>>()
  const first = start({}, pending.promise)
  first.state.activeChatId = 'B'; first.close()
  first.state.activeChatId = 'A'
  const current = start({}, Promise.resolve(response({}, [{ id: 'character', name: 'Return visit', tags: [] }])), Promise.resolve(), first.state)
  await settle()
  pending.resolve(response({}, [{ id: 'character', name: 'Old visit', tags: [] }]))
  await settle()
  expect(current.state.characters[0].name).toBe('Return visit')
  expect(first.acknowledge).not.toHaveBeenCalled()
  expect(first.errors).toEqual([])
  current.close()
})

test('leaving during recovery prevents acknowledgement and settings work from the old load', async () => {
  const pending = deferred<void>()
  const h = start({}, Promise.resolve(response()), pending.promise)
  await settle(); h.close(); pending.resolve()
  await settle()
  expect(h.acknowledge).not.toHaveBeenCalled()
  expect(h.loadout).not.toHaveBeenCalled()
  expect(h.errors).toEqual([])
})

test('multiplayer peers use room hydration without owner requests', async () => {
  const h = start({ mpRoomId: 'room', mpIsHost: false, mpChatId: 'A' })
  await settle()
  expect(h.open).not.toHaveBeenCalled()
  expect(h.characterGet).not.toHaveBeenCalled()
  h.close()
})
