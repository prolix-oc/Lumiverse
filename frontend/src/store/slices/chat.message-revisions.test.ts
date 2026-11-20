import { describe, expect, mock, test } from 'bun:test'
import { createStore } from 'zustand/vanilla'
import type { ChatSlice } from '@/types/store'
import type { Message } from '@/types/api'

mock.module('@/api/settings', () => ({ settingsApi: { put: async () => undefined } }))
const { createChatSlice } = await import('./chat')

function message(revision?: number, content = 'Original'): Message {
  return {
    id: 'assistant', chat_id: 'chat', index_in_chat: 0, is_user: false, name: 'Assistant',
    content, send_date: 1, swipe_id: 0, swipes: [content], swipe_dates: [1], extra: {},
    parent_message_id: null, branch_id: null, created_at: 1, revision,
  }
}

describe('message snapshot revision ordering', () => {
  for (const method of ['setMessages', 'reconcileMessagesTail'] as const) {
    function apply(state: ChatSlice, incoming: Message[]) {
      if (method === 'setMessages') state.setMessages(incoming, incoming.length)
      else state.reconcileMessagesTail({ data: incoming, total: incoming.length, offset: 0 })
    }

    test(`${method} retains an edit delivered after the snapshot was read`, () => {
      const store = createStore<ChatSlice>()(createChatSlice)
      const old = message(2)
      store.getState().setMessages([old])
      store.getState().startStreaming('generation', old.id, 'normal')
      const edited = { ...message(3, 'Original with appended status'), extra: { tokenCount: 5 } }
      store.getState().updateMessage(old.id, edited)
      const current = store.getState().messages[0]

      apply(store.getState(), [old])
      store.getState().endStreaming()

      expect(store.getState().messages[0]).toBe(current)
      expect(store.getState().messages[0]).toEqual(edited)
      expect(store.getState().isStreaming).toBe(false)
    })

    test(`${method} retains newer content and swipe state together`, () => {
      const store = createStore<ChatSlice>()(createChatSlice)
      const old = message(2)
      const edited = { ...message(3, 'Alternate'), swipe_id: 1, swipes: ['Original', 'Alternate'], swipe_dates: [1, 2] }
      store.getState().setMessages([edited])
      apply(store.getState(), [old])
      expect(store.getState().messages[0]).toBe(edited)
    })

    test.each([[2, 3], [3, 3], [undefined, 3], [3, undefined], [undefined, undefined]])(
      `${method} accepts current or unversioned snapshots (%s -> %s)`, (currentRevision, incomingRevision) => {
        const store = createStore<ChatSlice>()(createChatSlice)
        store.getState().setMessages([message(currentRevision)])
        const incoming = message(incomingRevision, 'Fresh')
        apply(store.getState(), [incoming])
        expect(store.getState().messages[0]).toBe(incoming)
      },
    )

    test(`${method} still removes missing rows and admits new messages`, () => {
      const store = createStore<ChatSlice>()(createChatSlice)
      store.getState().setMessages([message(3)])
      const incoming = { ...message(1), id: 'new' }
      apply(store.getState(), [incoming])
      expect(store.getState().messages).toEqual([incoming])
    })
  }
})
