import { describe, expect, mock, test } from 'bun:test'
import { createStore } from 'zustand/vanilla'
import ts from 'typescript'
import type { ChatSlice } from '@/types/store'
import type { Message } from '@/types/api'

mock.module('@/api/settings', () => ({ settingsApi: { put: async () => undefined } }))
const { createChatSlice } = await import('@/store/slices/chat')
const source = await Bun.file(new URL('./PersonaEditor.tsx', import.meta.url)).text()
const file = ts.createSourceFile('PersonaEditor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let callback = ''
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'handleReattributeChat'
    && node.initializer && ts.isCallExpression(node.initializer)) {
    callback = node.initializer.arguments[0].getText(file)
  }
  ts.forEachChild(node, visit)
}
visit(file)
if (!callback) throw new Error('Reattribution callback not found')
const compiled = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`const invoke = ${callback};`)

function message(id: string, is_user = true): Message {
  return {
    id, chat_id: 'chat', index_in_chat: is_user ? 0 : 1, is_user, name: 'Original', content: 'Original text',
    send_date: 1, swipe_id: 0, swipes: ['Original text'], swipe_dates: [1], extra: { persona_id: 'old' },
    parent_message_id: null, branch_id: null, created_at: 1, revision: 2,
  }
}

function begin() {
  const store = createStore<ChatSlice>()(createChatSlice)
  store.getState().setActiveChat('chat')
  store.getState().setMessages([message('user'), message('assistant', false)], 20)
  let resolve!: () => void, reject!: (error: Error) => void
  const request = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const busy: boolean[] = [], confirmations: boolean[] = [], calls: string[][] = [], errors: unknown[] = []
  const dependencies = {
    activeChatId: 'chat', reattributing: false, persona: { id: 'new', name: 'New persona' },
    messages: store.getState().messages, setMessages: store.getState().setMessages, useStore: store,
    chatsApi: { reattributeUserMessages: (...args: string[]) => { calls.push(args); return request } },
    setReattributing: (value: boolean) => busy.push(value),
    setShowReattributeConfirm: (value: boolean) => confirmations.push(value),
    console: { error: (...args: unknown[]) => errors.push(args) },
  }
  const pending = new Function(...Object.keys(dependencies), `${compiled}; return invoke();`)(...Object.values(dependencies))
  return { store, resolve, reject, pending, busy, confirmations, calls, errors }
}

describe('persona reattribution after an in-flight request', () => {
  test('applies only attribution fields to the latest edited user row', async () => {
    const h = begin()
    const assistant = h.store.getState().messages[1]
    h.store.getState().updateMessage('user', {
      revision: 3, content: 'Edited', swipe_id: 1, swipes: ['Original text', 'Edited'],
      swipe_dates: [1, 2], extra: { persona_id: 'old', preserved: 'new metadata' },
    })
    h.resolve()
    await h.pending
    expect(h.store.getState().messages[0]).toMatchObject({
      revision: 3, content: 'Edited', swipe_id: 1, swipes: ['Original text', 'Edited'],
      swipe_dates: [1, 2], name: 'New persona', extra: { persona_id: 'new', preserved: 'new metadata' },
    })
    expect(h.store.getState().messages[1]).toBe(assistant)
    expect(h.store.getState().totalChatLength).toBe(20)
    expect(h.calls).toEqual([['chat', 'new']])
    expect(h.busy).toEqual([true, false])
    expect(h.confirmations).toEqual([false])
  })

  test('does not restore deleted rows or discard messages received while awaiting', async () => {
    const h = begin()
    h.store.getState().removeMessage('user')
    const added = { ...message('new-assistant', false), index_in_chat: 2 }
    h.store.getState().addMessage(added)
    const current = h.store.getState().messages
    h.resolve()
    await h.pending
    expect(h.store.getState().messages).toEqual(current)
    expect(h.store.getState().messages[1]).toBe(added)
    expect(h.store.getState().totalChatLength).toBe(20)
  })

  test('does not attribute a user row received after the request began', async () => {
    const h = begin()
    const added = { ...message('new-user'), index_in_chat: 2 }
    h.store.getState().addMessage(added)
    h.resolve()
    await h.pending
    expect(h.store.getState().messages[2]).toBe(added)
    expect(h.store.getState().messages[0].extra.persona_id).toBe('new')
  })

  test('leaves another active chat untouched when the request completes', async () => {
    const h = begin()
    h.store.getState().setActiveChat('other')
    h.store.getState().setMessages([{ ...message('other-user'), chat_id: 'other' }], 10)
    const current = h.store.getState()
    h.resolve()
    await h.pending
    expect(h.store.getState()).toBe(current)
    expect(h.busy).toEqual([true, false])
  })

  test('leaves messages unchanged and clears busy state when attribution fails', async () => {
    const h = begin()
    const current = h.store.getState()
    h.reject(new Error('Request failed'))
    await h.pending
    expect(h.store.getState()).toBe(current)
    expect(h.busy).toEqual([true, false])
    expect(h.confirmations).toEqual([])
    expect(h.errors).toHaveLength(1)
  })
})
