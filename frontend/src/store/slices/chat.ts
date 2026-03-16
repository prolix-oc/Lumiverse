import type { StateCreator } from 'zustand'
import type { ChatSlice } from '@/types/store'
import type { Message } from '@/types/api'
import { settingsApi } from '@/api/settings'

export const createChatSlice: StateCreator<ChatSlice> = (set, get) => {
  // Tracks recently ended generation IDs, so that a late `startStreaming()`
  // call (e.g. from an HTTP response arriving after the WS GENERATION_ENDED
  // event in sidecar-council mode) doesn't restart a zombie streaming state.
  // We track a small set rather than a single ID because during rapid
  // stop→regenerate cycles, multiple generations may end in quick succession.
  const endedGenerationIds = new Set<string>()

  // ── Throttled streaming buffers ──────────────────────────────────────
  // Tokens accumulate here at full WS throughput (no React re-renders).
  // A timer flushes to Zustand at a capped rate (~30fps), so expensive
  // downstream rendering (markdown, OOC parsing, DOM walks) runs at most
  // once per interval instead of per-token. 32ms ≈ 30fps — smooth enough
  // for text streaming while halving render overhead vs. RAF at 60fps.
  let rawStreamContent = ''
  let rawStreamReasoning = ''
  let streamFlushTimer = 0
  let lastFlushTime = 0
  const STREAM_FLUSH_INTERVAL = 32

  function scheduleStreamFlush() {
    if (streamFlushTimer) return
    const elapsed = performance.now() - lastFlushTime
    const delay = Math.max(0, STREAM_FLUSH_INTERVAL - elapsed)
    streamFlushTimer = window.setTimeout(() => {
      streamFlushTimer = 0
      lastFlushTime = performance.now()
      set({
        streamingContent: rawStreamContent,
        streamingReasoning: rawStreamReasoning,
      })
    }, delay) as unknown as number
  }

  function cancelStreamFlush() {
    if (streamFlushTimer) {
      clearTimeout(streamFlushTimer)
      streamFlushTimer = 0
    }
  }

  function sortMessagesByPosition(messages: Message[]): Message[] {
    return [...messages].sort((a, b) => {
      if (a.index_in_chat !== b.index_in_chat) return a.index_in_chat - b.index_in_chat
      if (a.send_date !== b.send_date) return a.send_date - b.send_date
      if (a.created_at !== b.created_at) return a.created_at - b.created_at
      return a.id.localeCompare(b.id)
    })
  }

  return {
    activeChatId: null,
    activeCharacterId: null,
    activeChatWallpaper: null,
    messages: [],
    isStreaming: false,
    streamingContent: '',
    streamingReasoning: '',
    streamingError: null,
    activeGenerationId: null,
    regeneratingMessageId: null,
    streamingGenerationType: null,
    totalChatLength: 0,

    setActiveChat: (chatId, characterId = null) => {
      endedGenerationIds.clear()
      set({
        activeChatId: chatId,
        activeCharacterId: characterId,
        activeChatWallpaper: null,
        messages: [],
        isStreaming: false,
        streamingContent: '',
        streamingReasoning: '',
        streamingError: null,
        activeGenerationId: null,
        regeneratingMessageId: null,
        streamingGenerationType: null,
      })
      settingsApi.put('activeChatId', chatId).catch(() => {})
    },

    setActiveChatWallpaper: (wallpaper) => set({ activeChatWallpaper: wallpaper }),

    setMessages: (messages, total?) =>
      set({ messages: sortMessagesByPosition(messages), totalChatLength: total ?? messages.length }),

    prependMessages: (olderMessages) =>
      set((state) => {
        const existingIds = new Set(state.messages.map((m) => m.id))
        const unique = olderMessages.filter((m) => !existingIds.has(m.id))
        if (unique.length === 0) return state
        return { messages: sortMessagesByPosition([...unique, ...state.messages]) }
      }),

    addMessage: (message) =>
      set((state) => {
        const byId = state.messages.findIndex((m) => m.id === message.id)
        if (byId !== -1) {
          const messages = [...state.messages]
          messages[byId] = message
          return { messages: sortMessagesByPosition(messages) }
        }

        const messages = sortMessagesByPosition([...state.messages, message])
        return { messages, totalChatLength: messages.length }
      }),

    updateMessage: (id, updates) =>
      set((state) => {
        let idx = -1
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (state.messages[i].id === id) {
            idx = i
            break
          }
        }
        if (idx === -1) return { messages: state.messages }
        const messages = [...state.messages]
        messages[idx] = { ...messages[idx], ...updates }
        return { messages }
      }),

    removeMessage: (id) =>
      set((state) => {
        let idx = -1
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (state.messages[i].id === id) {
            idx = i
            break
          }
        }
        if (idx === -1) return { messages: state.messages }
        const messages = state.messages.filter((_m, i) => i !== idx)
        return { messages, totalChatLength: messages.length }
      }),

    beginStreaming: (regeneratingMessageId, generationType) => {
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      set({
        isStreaming: true,
        streamingContent: '',
        streamingReasoning: '',
        streamingError: null,
        activeGenerationId: null,
        regeneratingMessageId: regeneratingMessageId ?? null,
        streamingGenerationType: generationType ?? null,
      })
    },

    setRegeneratingMessageId: (messageId) => {
      set({ regeneratingMessageId: messageId })
    },

    startStreaming: (generationId, regeneratingMessageId) => {
      // Guard: don't restart a generation that already completed (race condition
      // in sidecar-council mode where GENERATION_ENDED arrives before the HTTP
      // response that triggers this call from InputArea).
      if (endedGenerationIds.has(generationId)) return
      // Guard: don't reset content for a generation that's already streaming
      // (WS GENERATION_STARTED may arrive slightly before the HTTP response).
      if (generationId === get().activeGenerationId) return

      const current = get()
      // If we're already in an optimistic streaming state (beginStreaming was
      // called), just wire up the generation ID without resetting buffers —
      // tokens may have already started arriving via WS.
      if (current.isStreaming && !current.activeGenerationId) {
        set({
          activeGenerationId: generationId,
          regeneratingMessageId: regeneratingMessageId ?? current.regeneratingMessageId,
        })
        return
      }

      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      set({
        isStreaming: true,
        streamingContent: '',
        streamingReasoning: '',
        streamingError: null,
        activeGenerationId: generationId,
        regeneratingMessageId: regeneratingMessageId ?? null,
      })
    },

    appendStreamToken: (token) => {
      // CoT detection (reasoning prefix/suffix separation) is now handled
      // server-side in generate.service.ts. The backend emits pre-separated
      // tokens: regular content tokens here, reasoning tokens via
      // appendStreamReasoning. This avoids duplicating the state machine.
      rawStreamContent += token
      scheduleStreamFlush()
    },

    appendStreamReasoning: (token) => {
      rawStreamReasoning += token
      scheduleStreamFlush()
    },

    endStreaming: () => {
      const id = get().activeGenerationId
      if (id) endedGenerationIds.add(id)
      // Cap the set size to prevent unbounded growth
      if (endedGenerationIds.size > 20) {
        const first = endedGenerationIds.values().next().value
        if (first) endedGenerationIds.delete(first)
      }
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      set({ isStreaming: false, streamingContent: '', streamingReasoning: '', streamingError: null, activeGenerationId: null, regeneratingMessageId: null, streamingGenerationType: null })
    },

    stopStreaming: () => {
      const id = get().activeGenerationId
      if (id) endedGenerationIds.add(id)
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      set({ isStreaming: false, streamingContent: '', streamingReasoning: '', streamingError: null, activeGenerationId: null, regeneratingMessageId: null, streamingGenerationType: null })
    },

    setStreamingError: (error) => {
      const id = get().activeGenerationId
      if (id) endedGenerationIds.add(id)
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      set({ streamingError: error, isStreaming: false, activeGenerationId: null, regeneratingMessageId: null, streamingGenerationType: null })
    },

    markGenerationEnded: (generationId) => {
      endedGenerationIds.add(generationId)
      if (endedGenerationIds.size > 20) {
        const first = endedGenerationIds.values().next().value
        if (first) endedGenerationIds.delete(first)
      }
    },
  }
}
