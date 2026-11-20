import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import { resolveChatPersonaSelection, setPersistedChatPersonaId, CHAT_PERSONA_METADATA_KEY } from '@/lib/chatPersonaSelection'

const source = await Bun.file(new URL('./ChatView.tsx', import.meta.url)).text()
const file = ts.createSourceFile('ChatView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let effect = ''
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect'
    && node.arguments[0]?.getText(file).includes('const loadChat = async')) {
    effect = node.arguments[0].getText(file)
  }
  ts.forEachChild(node, visit)
}
visit(file)
if (!effect) throw new Error('Chat loading effect not found')
const compiled = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`const effect = ${effect};`)
const persona = (id: string, is_default = false) => ({ id, name: id, is_default })

async function openChat(metadata: Record<string, unknown> = {}, initial: Record<string, unknown> = {}) {
  const listeners = new Set<() => void>()
  const selected: unknown[] = [], patches: unknown[] = [], errors: unknown[] = []
  let finished = false
  const state: Record<string, any> = {
    activeChatId: 'chat', messagesPerPage: 50, characters: [{ id: 'character', tags: ['tag'] }],
    chatHeads: [], personas: [], personasLoaded: false, fullSettingsLoaded: false,
    activePersonaId: null, characterPersonaBindings: {}, personaTagBindings: {},
    setActiveCharacter() {}, setActiveChatDisplayOwner() {}, setActiveChatName() {},
    setActiveChatLoadedCharacterIds(ids: string[]) { state.activeChatLoadedCharacterIds = ids },
    setActiveChatMetadata(value: unknown) { state.activeChatMetadata = value },
    clearGroupChat() {}, clearGroupExpressions() {}, clearMultiCharacterExpressions() {},
    setActivePersona(id: unknown) { selected.push(id); state.activePersonaId = id; emit() },
    updateCharacter(id: string, character: unknown) { state.characters = [...state.characters.filter((item: any) => item.id !== id), character] },
    ...initial,
  }
  function emit() { for (const listener of [...listeners]) listener() }
  const deps = {
    chatId: 'chat', useStore: { getState: () => state, subscribe: (fn: () => void) => {
      listeners.add(fn); return () => { listeners.delete(fn) }
    } },
    chatsApi: { open: async () => ({ chat: { character_id: 'character', metadata }, messages: { data: [{ id: 'message' }], total: 1 }, characters: [{ id: 'character', tags: ['tag'] }] }), patchMetadata: async (...args: unknown[]) => { patches.push(args) } },
    messagesApi: { list: async () => ({ data: [{ id: 'message' }], total: 1 }) },
    setActiveChat() {}, setMessages() {}, recoverPooledGeneration: async () => {},
    generateApi: { acknowledge: async () => {} }, loadoutsApi: { resolve: async () => { finished = true; return {} } },
    resolveCouncilForChat: async () => { throw new Error('No binding') },
    resolveChatPersonaSelection, setPersistedChatPersonaId, CHAT_PERSONA_METADATA_KEY,
    personaToastName: (value: { name: string }) => value.name, t: (key: string) => key,
    toast: { info() {} }, console: { error: (...args: unknown[]) => errors.push(args) },
  }
  const close = new Function(...Object.keys(deps), `${compiled}; return effect();`)(...Object.values(deps))
  for (let i = 0; i < 20 && !finished && !errors.length; i++) await Promise.resolve()
  expect(errors).toEqual([])
  expect(finished).toBe(true)
  return { state, selected, patches, close, listeners, update: (patch: Record<string, unknown>) => { Object.assign(state, patch); emit() } }
}

describe('chat persona initialization', () => {
  test('waits for both settings and the complete persona list without delaying chat loading', async () => {
    const h = await openChat()
    expect(h.selected).toEqual([])
    h.update({ fullSettingsLoaded: true })
    expect(h.selected).toEqual([])
    h.update({ personas: [persona('default', true)], personasLoaded: true })
    expect(h.selected).toEqual(['default'])
    expect(h.listeners.size).toBe(0)
    h.close()
  })

  test('waits for saved bindings instead of selecting the default early', async () => {
    const h = await openChat({}, { personas: [persona('default', true), persona('bound')], personasLoaded: true })
    expect(h.selected).toEqual([])
    h.update({ fullSettingsLoaded: true, characterPersonaBindings: { character: { personaId: 'bound', addonStates: { addon: true } } } })
    expect(h.selected).toEqual(['bound'])
    expect(h.state.activeChatMetadata.persona_addon_states).toEqual({ bound: { addon: true } })
    h.close()
  })

  test('does not clear an explicit selection while the list is incomplete', async () => {
    const h = await openChat({ active_persona_id: 'saved' }, { personas: [persona('default', true)], fullSettingsLoaded: true })
    expect(h.patches).toEqual([])
    expect(h.selected).toEqual([])
    h.update({ personas: [persona('default', true), persona('saved')], personasLoaded: true })
    expect(h.selected).toEqual(['saved'])
    expect(h.patches).toEqual([])
    h.close()
  })

  test('uses an explicit chat choice made while startup is pending', async () => {
    const h = await openChat()
    h.update({ activeChatMetadata: { active_persona_id: 'chosen' }, personas: [persona('default', true), persona('chosen')], personasLoaded: true, fullSettingsLoaded: true })
    expect(h.selected).toEqual(['chosen'])
    h.close()
  })

  test('cancels the pending selection when the chat closes', async () => {
    const h = await openChat()
    h.close()
    h.update({ personas: [persona('default', true)], personasLoaded: true, fullSettingsLoaded: true })
    expect(h.selected).toEqual([])
    expect(h.listeners.size).toBe(0)
  })

  test('does not apply a pending selection to a different active chat', async () => {
    const h = await openChat()
    h.update({ activeChatId: 'other', personas: [persona('default', true)], personasLoaded: true, fullSettingsLoaded: true })
    expect(h.selected).toEqual([])
    expect(h.listeners.size).toBe(0)
    h.close()
  })

  test('temporary chats leave the current persona alone', async () => {
    const h = await openChat({ temporary: true }, { activePersonaId: 'existing', personas: [persona('default', true)], personasLoaded: true, fullSettingsLoaded: true })
    expect(h.selected).toEqual([])
    expect(h.listeners.size).toBe(0)
    h.close()
  })

  test('applies a delayed tag binding without replacing per-chat add-on choices', async () => {
    const h = await openChat({ persona_addon_states: { tagged: { addon: false } } })
    h.update({ personas: [persona('default', true), persona('tagged')], personasLoaded: true,
      fullSettingsLoaded: true, personaTagBindings: { tagged: { tags: ['tag'], mode: 'any', addonStates: { addon: true } } } })
    expect(h.selected).toEqual(['tagged'])
    expect(h.state.activeChatMetadata.persona_addon_states).toEqual({ tagged: { addon: false } })
    expect(h.patches).toEqual([])
    h.close()
  })

  test('clears a stale explicit persona only after the full list is available', async () => {
    const h = await openChat({ active_persona_id: 'removed', retained: true })
    h.update({ personas: [persona('default', true)], personasLoaded: true, fullSettingsLoaded: true })
    expect(h.selected).toEqual(['default'])
    expect(h.patches).toEqual([['chat', { active_persona_id: null }]])
    expect(h.state.activeChatMetadata).toEqual({ retained: true })
    h.close()
  })

  test('a ready chat resolves once and does not override later manual choices', async () => {
    const h = await openChat({}, { personas: [persona('default', true)], personasLoaded: true, fullSettingsLoaded: true })
    expect(h.selected).toEqual(['default'])
    h.update({ activePersonaId: 'manual' })
    expect(h.state.activePersonaId).toBe('manual')
    expect(h.listeners.size).toBe(0)
    h.close()
  })
})
