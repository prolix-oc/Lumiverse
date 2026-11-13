import React from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, useStore } from 'zustand'
import type { ChatSlice } from '@/types/store'
import type { Message } from '@/types/api'
import { createChatSlice } from '@/store/slices/chat'
import { executeSwipe } from '@/hooks/useSwipeAction'
import SwipeControls from '@/components/chat/SwipeControls'
import useSwipeKeyboard from '@/hooks/useSwipeKeyboard'

const store = createStore<ChatSlice>()(createChatSlice)
export const useFixtureStore = Object.assign((selector: (state: ChatSlice) => unknown) => useStore(store, selector), {
  getState: store.getState, setState: store.setState, subscribe: store.subscribe,
})
const original: Message = { id: 'reply', chat_id: 'chat', index_in_chat: 0, name: 'Assistant', is_user: false,
  content: 'Keep reading this response while a new swipe generates.', swipes: ['Keep reading this response while a new swipe generates.'], swipe_id: 0,
  swipe_dates: [1], extra: { reasoning: 'Saved reasoning' }, send_date: 1, created_at: 1, parent_message_id: null, branch_id: null }
let target = 1
let generation = 0
let selections: number[] = []

export async function start(input: { background_swipe?: boolean }) {
  const current = store.getState().messages[0]
  target = current.swipes.length
  const staged = { ...current, swipes: [...current.swipes, ''], swipe_dates: [...current.swipe_dates, 2],
    swipe_id: input.background_swipe ? current.swipe_id : target, content: input.background_swipe ? current.content : '' }
  store.getState().updateMessage(current.id, staged)
  const generationId = `generation-${++generation}`
  store.getState().startStreaming(generationId, current.id, 'swipe')
  store.getState().setStreamingSwipeId(target, input.background_swipe === true)
  return { generationId }
}

export async function swipe(_chat: string, _message: string, direction: 'left' | 'right') {
  const current = store.getState().messages[0]
  const index = current.swipe_id + (direction === 'left' ? -1 : 1)
  store.getState().updateMessage(current.id, { ...current, swipe_id: index, content: current.swipes[index] || '' })
}

function reset() {
  store.getState().setActiveChat('chat')
  store.getState().setMessages([original])
  store.setState({ activeProfileId: 'mock', activePersonaId: null, getActivePresetForGeneration: () => null,
    regenFeedback: { enabled: false }, openModal: () => undefined, swipeGesturesEnabled: true } as never)
  selections = []
}
reset()
store.subscribe(state => { selections.push(state.messages[0]?.swipe_id ?? -1) })

function App() {
  useSwipeKeyboard()
  const message = useStore(store, state => state.messages[0])
  const streaming = useStore(store, state => state.isStreaming)
  const index = useStore(store, state => state.streamingSwipeId)
  const content = useStore(store, state => state.streamingContent)
  // Controlled viewer: the real store and swipe controls drive selection.
  const visible = streaming && (index == null || index === message.swipe_id) ? content || message.content : message.content
  return <main>
    <h1>Background swipe diagnostics</h1>
    <article aria-label="Selected reply" tabIndex={0}>{visible}</article>
    <SwipeControls message={message} chatId="chat" />
    <textarea aria-label="Draft message" />
    <button disabled={streaming} onClick={() => void executeSwipe(message, 'chat', 'right', { background: true })}>Generate swipe in background</button>
    <p role="status">{streaming ? 'Generating another swipe' : 'Ready'}</p>
  </main>
}

Object.assign(window, { backgroundSwipeFixture: {
  reset,
  token: () => store.getState().reconcileStreamContent('A newly generated response.', 0),
  complete() {
    const current = store.getState().messages[0]
    const swipes = [...current.swipes]; swipes[target] = 'A newly generated response.'
    store.getState().updateMessage(current.id, { ...current, swipes, content: swipes[current.swipe_id]! })
    store.getState().endStreaming()
    store.setState({ unseenSwipes: { [current.id]: target } })
  },
  selections: () => selections,
} })
createRoot(document.getElementById('root')!).render(<App />)
