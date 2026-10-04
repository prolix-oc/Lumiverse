import type { StateCreator } from 'zustand'
import type { ChatSlice } from '@/types/store'
import type { Message } from '@/types/api'
import { settingsApi } from '@/api/settings'
import { preserveNewerMessageRevisions, reconcileMessageTail } from '@/store/messageTailReconciliation'

export const createChatSlice: StateCreator<ChatSlice> = (set, get) => {
  const LOCAL_STREAM_PLACEHOLDER_PREFIX = '__stream_placeholder_'
  const LOCAL_REGEN_PLACEHOLDER_PREFIX = '__regen_placeholder_'

  // Tracks recently ended generation IDs, so that a late `startStreaming()`
  // call (e.g. from an HTTP response arriving after the WS GENERATION_ENDED
  // event in sidecar-council mode) doesn't restart a zombie streaming state.
  // We track a small set rather than a single ID because during rapid
  // stop→regenerate cycles, multiple generations may end in quick succession.
  const endedGenerationIds = new Map<string, boolean>()
  // A newer generation can start and finish before an older refresh resolves.
  let generationEpoch = 0

  function rememberGenerationEnded(id: string, completed: boolean) {
    endedGenerationIds.set(id, completed)
    if (endedGenerationIds.size > 20) {
      const first = endedGenerationIds.keys().next().value
      if (first) endedGenerationIds.delete(first)
    }
  }

  // ── Throttled streaming buffers ──────────────────────────────────────
  // Tokens accumulate here at full WS throughput (no React re-renders).
  // A timer flushes to Zustand at a capped rate (~30fps), so expensive
  // downstream rendering (markdown, OOC parsing, DOM walks) runs at most
  // once per interval instead of per-token. 32ms ≈ 30fps — smooth enough
  // for text streaming while halving render overhead vs. RAF at 60fps.
  let rawStreamContent = ''
  let rawStreamReasoning = ''
  let reasoningStartedAt = 0
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

  function isLocalStreamingPlaceholderId(id: string | null | undefined) {
    return !!id && (
      id.startsWith(LOCAL_STREAM_PLACEHOLDER_PREFIX)
      || id.startsWith(LOCAL_REGEN_PLACEHOLDER_PREFIX)
    )
  }

  function shouldUseLocalStreamPlaceholder(generationType: string | null | undefined) {
    return generationType !== 'continue' && generationType !== 'impersonate_draft'
  }

  function createLocalStreamPlaceholder(state: ChatSlice): Message | null {
    if (!state.activeChatId) return null

    const lastMessage = state.messages[state.messages.length - 1]
    const now = Math.floor(Date.now() / 1000)

    return {
      id: `${LOCAL_STREAM_PLACEHOLDER_PREFIX}${Date.now()}`,
      chat_id: state.activeChatId,
      index_in_chat: (lastMessage?.index_in_chat ?? -1) + 1,
      is_user: false,
      name: '',
      content: '',
      send_date: now,
      swipe_id: 0,
      swipes: [''],
      swipe_dates: [now],
      extra: {},
      parent_message_id: null,
      branch_id: null,
      created_at: now,
    }
  }

  function reconcileStreamingSwipe(state: ChatSlice, messages: Message[]): Message[] {
    const swipeId = state.streamingSwipeId
    if (
      !state.isStreaming ||
      (state.streamingGenerationType !== 'swipe' && state.streamingGenerationType !== 'regenerate') ||
      !state.regeneratingMessageId ||
      swipeId == null
    ) return messages

    const index = messages.findIndex((message) => message.id === state.regeneratingMessageId)
    if (index < 0 || messages[index].swipes.length > swipeId) return messages

    // The server confirms this slot before publishing the stream anchor. A
    // snapshot without it predates staging. Keep the current message (including
    // any intentional navigation) when we already have the slot; otherwise
    // recover the missing slot even if MESSAGE_SWIPED was missed entirely.
    const current = state.messages.find((message) => message.id === state.regeneratingMessageId)
    const message = messages[index]
    const missing = swipeId - message.swipes.length + 1
    const next = [...messages]
    next[index] = current && current.swipes.length > swipeId ? current : {
      ...message,
      swipes: [...message.swipes, ...Array<string>(missing).fill('')],
      swipe_dates: [...message.swipe_dates, ...Array<number>(missing).fill(Math.floor(Date.now() / 1000))],
      swipe_id: swipeId,
      content: '',
    }
    return next
  }

  return {
    activeChatId: null,
    activeCharacterId: null,
    activeChatDisplayOwner: null,
    activeChatName: null,
    activeChatWallpaper: null,
    activeChatAvatarId: null,
    activeChatMetadata: null,
    messages: [],
    isStreaming: false,
    streamingNavigationPaused: false,
    streamingContent: '',
    streamingReasoning: '',
    streamingReasoningDuration: null,
    streamingReasoningStartedAt: null,
    streamingError: null,
    activeGenerationId: null,
    regeneratingMessageId: null,
    streamingSwipeId: null,
    streamingGenerationType: null,
    lastCompletedGenerationType: null,
    unseenSwipes: {},
    totalChatLength: 0,
    impersonateDraftContent: null,
    landingRecentChats: null,

    setLandingRecentChats: (result) => set({ landingRecentChats: result }),

    setActiveChat: (chatId, characterId = null, hydration) => {
      generationEpoch++
      // A throttled token flush can still be queued when ChatView unmounts.
      // Cancel it and clear the closure-owned buffers before resetting the
      // public state; otherwise that timer can fire on the landing page and
      // restore streaming content for a chat that is no longer active.
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      reasoningStartedAt = 0
      endedGenerationIds.clear()
      const metadata = hydration?.metadata ?? null
      const groupAvatar = metadata?.group === true && characterId
        ? metadata.group_active_avatar_ids?.[characterId]
        : undefined
      const avatarId = typeof groupAvatar === 'string'
        ? groupAvatar
        : metadata?.group === true
          ? null
          : typeof metadata?.active_avatar_id === 'string'
            ? metadata.active_avatar_id
            : null
      set({
        activeChatId: chatId,
        activeCharacterId: characterId,
        activeChatDisplayOwner: hydration?.displayOwner ?? null,
        activeChatName: hydration?.name ?? null,
        activeChatWallpaper: hydration?.wallpaper ?? null,
        activeChatAvatarId: avatarId,
        activeChatMetadata: metadata,
        messages: hydration?.messages ?? [],
        isStreaming: false,
        streamingNavigationPaused: false,
        streamingContent: '',
        streamingReasoning: '',
        streamingReasoningDuration: null,
        streamingReasoningStartedAt: null,
        streamingError: null,
        activeGenerationId: null,
        regeneratingMessageId: null,
        streamingSwipeId: null,
        streamingGenerationType: null,
        unseenSwipes: {},
        totalChatLength: hydration?.total ?? 0,
        messageSelectMode: false,
        selectedMessageIds: [],
      })
      // Clear expression state so stale expressions from the previous character don't linger
      ;(get() as any).setActiveExpression?.(null, null, null)
      ;(get() as any).clearMultiCharacterExpressions?.()
      // Clear lore activation state so entries from the previous chat are not shown
      // while the new chat waits for its first generation event.
      ;(get() as any).clearActivatedWorldInfo?.()
      // Clear any pending message edit from the previous chat
      ;(get() as any).setEditingMessageId?.(null)
      // Load the new active character's connection bind (memoized per character)
      ;(get() as any).hydrateActiveCharacterConnection?.(characterId)
      settingsApi.put('activeChatId', chatId).catch(() => {})
    },

    setActiveChatWallpaper: (wallpaper) => set({ activeChatWallpaper: wallpaper }),

    setActiveChatAvatarId: (imageId) => set({ activeChatAvatarId: imageId }),

    setActiveChatMetadata: (metadata) => set((state) => {
      const groupAvatar = metadata?.group === true && state.activeCharacterId
        ? metadata.group_active_avatar_ids?.[state.activeCharacterId]
        : undefined
      const avatarId = typeof groupAvatar === 'string'
        ? groupAvatar
        : metadata?.group === true
          ? null
          : typeof metadata?.active_avatar_id === 'string'
            ? metadata.active_avatar_id
            : null
      return { activeChatMetadata: metadata, activeChatAvatarId: avatarId }
    }),

    setActiveChatDisplayOwner: (owner) => set({ activeChatDisplayOwner: owner }),

    setActiveChatName: (name) => set({ activeChatName: name }),

    setMessages: (messages, total?) =>
      set((state) => {
        const nextMessages = reconcileStreamingSwipe(state, preserveNewerMessageRevisions(state.messages, messages))

        return {
          messages: sortMessagesByPosition(nextMessages),
          totalChatLength: total ?? nextMessages.length,
        }
      }),

    reconcileMessagesTail: (page) =>
      set((state) => ({
        messages: sortMessagesByPosition(reconcileStreamingSwipe(state, reconcileMessageTail(
          state.messages,
          state.totalChatLength,
          page,
        ))),
        totalChatLength: page.total,
      })),

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
        return { messages, totalChatLength: state.totalChatLength + 1 }
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
        const unseenSwipes = id in state.unseenSwipes
          ? Object.fromEntries(Object.entries(state.unseenSwipes).filter(([k]) => k !== id))
          : state.unseenSwipes
        return { messages, totalChatLength: Math.max(0, state.totalChatLength - 1), unseenSwipes }
      }),

    beginStreaming: (regeneratingMessageId, generationType) => {
      generationEpoch++
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      reasoningStartedAt = 0

      const current = get()
      let nextRegeneratingMessageId = regeneratingMessageId ?? null
      let nextMessages = current.messages
      let nextTotalChatLength = current.totalChatLength

      if (!nextRegeneratingMessageId && shouldUseLocalStreamPlaceholder(generationType)) {
        const placeholder = createLocalStreamPlaceholder(current)
        if (placeholder) {
          nextRegeneratingMessageId = placeholder.id
          nextMessages = sortMessagesByPosition([...current.messages, placeholder])
          nextTotalChatLength = current.totalChatLength + 1
        }
      }

      set({
        messages: nextMessages,
        totalChatLength: nextTotalChatLength,
        isStreaming: true,
        streamingNavigationPaused: false,
        streamingContent: '',
        streamingReasoning: '',
        streamingReasoningDuration: null,
        streamingReasoningStartedAt: null,
        streamingError: null,
        activeGenerationId: null,
        regeneratingMessageId: nextRegeneratingMessageId,
        streamingSwipeId: null,
        streamingGenerationType: generationType ?? null,
      })
    },

    setRegeneratingMessageId: (messageId) => {
      set({ regeneratingMessageId: messageId })
    },

    startStreaming: (generationId, regeneratingMessageId, generationType) => {
      // Guard: don't restart a generation that already completed (race condition
      // in sidecar-council mode where GENERATION_ENDED arrives before the HTTP
      // response that triggers this call from InputArea).
      if (endedGenerationIds.has(generationId)) return
      // Guard: don't reset content for a generation that's already streaming
      // (WS GENERATION_STARTED may arrive slightly before the HTTP response).
      if (generationId === get().activeGenerationId) return

      const current = get()

      const resolvedGenerationType = generationType ?? current.streamingGenerationType
      const resolvedRegeneratingMessageId = regeneratingMessageId ?? current.regeneratingMessageId

      // If we're already in an optimistic streaming state (beginStreaming was
      // called), just wire up the generation ID without resetting buffers —
      // tokens may have already started arriving via WS.
      if (current.isStreaming && !current.activeGenerationId) {
        set({
          activeGenerationId: generationId,
          regeneratingMessageId: resolvedRegeneratingMessageId,
          streamingGenerationType: resolvedGenerationType ?? null,
        })
        return
      }

      generationEpoch++
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      reasoningStartedAt = 0

      let nextRegeneratingMessageId = resolvedRegeneratingMessageId ?? null
      let nextMessages = current.messages
      let nextTotalChatLength = current.totalChatLength

      if (!nextRegeneratingMessageId && shouldUseLocalStreamPlaceholder(resolvedGenerationType)) {
        const placeholder = createLocalStreamPlaceholder(current)
        if (placeholder) {
          nextRegeneratingMessageId = placeholder.id
          nextMessages = sortMessagesByPosition([...current.messages, placeholder])
          nextTotalChatLength = current.totalChatLength + 1
        }
      }

      set({
        messages: nextMessages,
        totalChatLength: nextTotalChatLength,
        isStreaming: true,
        streamingNavigationPaused: false,
        streamingContent: '',
        streamingReasoning: '',
        streamingReasoningDuration: null,
        streamingReasoningStartedAt: null,
        streamingError: null,
        activeGenerationId: generationId,
        regeneratingMessageId: nextRegeneratingMessageId,
        streamingSwipeId: null,
        streamingGenerationType: resolvedGenerationType ?? null,
      })
    },

    setStreamingSwipeId: (swipeId) => {
      set((state) => ({
        streamingSwipeId: swipeId,
        messages: reconcileStreamingSwipe({ ...state, streamingSwipeId: swipeId }, state.messages),
      }))
    },

    pauseStreamingForNavigation: () => {
      if (!get().isStreaming) return
      // Commit the newest private-buffer frame, then stop the queued flush.
      // The UI keeps rendering this snapshot through the exit animation while
      // the generation itself continues in the backend/chat head.
      cancelStreamFlush()
      set({
        streamingContent: rawStreamContent,
        streamingReasoning: rawStreamReasoning,
        streamingNavigationPaused: true,
      })
    },

    setUnseenSwipe: (messageId, swipeId) => {
      set((state) => {
        if (state.unseenSwipes[messageId] === swipeId) return state
        return { unseenSwipes: { ...state.unseenSwipes, [messageId]: swipeId } }
      })
    },

    clearUnseenSwipe: (messageId) => {
      set((state) => {
        if (!(messageId in state.unseenSwipes)) return state
        const unseenSwipes = { ...state.unseenSwipes }
        delete unseenSwipes[messageId]
        return { unseenSwipes }
      })
    },

    reconcileStreamContent: (content, offset) => {
      if (get().streamingNavigationPaused) return
      // Apply a pool snapshot (offset 0 = full) or a delta (offset = char
      // position where `content` begins). The pool buffer is append-only
      // within a generation, so a candidate that doesn't extend what's already
      // rendered is a stale snapshot (tokens arrived over WS during the poll's
      // round-trip) — applying it would rewind or hole the visible text.
      if (offset > rawStreamContent.length) return
      const candidate = rawStreamContent.slice(0, offset) + content
      if (candidate.length < rawStreamContent.length) return
      rawStreamContent = candidate
      set({ streamingContent: candidate })
    },

    reconcileStreamReasoning: (reasoning, offset) => {
      if (get().streamingNavigationPaused) return
      if (offset > rawStreamReasoning.length) return
      const candidate = rawStreamReasoning.slice(0, offset) + reasoning
      if (candidate.length < rawStreamReasoning.length) return
      rawStreamReasoning = candidate
      set({ streamingReasoning: candidate })
    },

    getStreamBuffers: () => ({ content: rawStreamContent, reasoning: rawStreamReasoning }),

    setStreamingReasoningStartedAt: (ts) => {
      // Also restore the closure variable so appendStreamToken can finalize
      // the duration when the first content token arrives after recovery.
      reasoningStartedAt = ts ?? 0
      set({ streamingReasoningStartedAt: ts })
    },

    appendStreamToken: (token, offset) => {
      if (get().streamingNavigationPaused) return 'stale'
      // CoT detection (reasoning prefix/suffix separation) is now handled
      // server-side in generate.service.ts. The backend emits pre-separated
      // tokens: regular content tokens here, reasoning tokens via
      // appendStreamReasoning. This avoids duplicating the state machine.
      if (reasoningStartedAt && !get().streamingReasoningDuration) {
        set({ streamingReasoningDuration: Date.now() - reasoningStartedAt })
      }
      if (offset != null) {
        const localLen = rawStreamContent.length
        // Segment starts beyond our buffer — we missed tokens (subscription
        // race after reconnect, events dropped while hidden). Don't append out
        // of place; the caller re-polls the authoritative pool.
        if (offset > localLen) return 'gap'
        if (offset < localLen) {
          // Overlaps content we already hold (recovery snapshot raced the live
          // stream). Slice off exactly the overlap; drop if fully covered.
          const overlap = localLen - offset
          if (token.length <= overlap) return 'stale'
          token = token.slice(overlap)
        }
      }
      rawStreamContent += token
      scheduleStreamFlush()
      return 'appended'
    },

    appendStreamReasoning: (token, offset) => {
      if (get().streamingNavigationPaused) return 'stale'
      if (!reasoningStartedAt) {
        reasoningStartedAt = Date.now()
        // Keep the render-facing timestamp in sync with the private duration
        // clock. Otherwise it can retain a previous chat's recovery timestamp
        // until the next pool poll corrects it.
        set({ streamingReasoningStartedAt: reasoningStartedAt })
      }
      if (offset != null) {
        const localLen = rawStreamReasoning.length
        if (offset > localLen) return 'gap'
        if (offset < localLen) {
          const overlap = localLen - offset
          if (token.length <= overlap) return 'stale'
          token = token.slice(overlap)
        }
      }
      rawStreamReasoning += token
      scheduleStreamFlush()
      return 'appended'
    },

    endStreaming: (message) => {
      const id = get().activeGenerationId
      if (id && !endedGenerationIds.has(id)) rememberGenerationEnded(id, true)
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      reasoningStartedAt = 0
      // Preserve the generation type before clearing — auto-summarization
      // needs to know what kind of generation just finished.
      set((state) => ({
        ...(message ? { messages: state.messages.map((current) => current.id === message.id
          ? preserveNewerMessageRevisions([current], [message])[0] : current) } : {}),
        isStreaming: false, streamingNavigationPaused: false, streamingContent: '', streamingReasoning: '', streamingReasoningDuration: null, streamingReasoningStartedAt: null, streamingError: null, activeGenerationId: null, regeneratingMessageId: null, streamingSwipeId: null,
        lastCompletedGenerationType: !state.isStreaming || (id && endedGenerationIds.get(id) === false)
          ? state.lastCompletedGenerationType : state.streamingGenerationType,
        streamingGenerationType: null,
      }))
    },

    stopStreaming: () => {
      const id = get().activeGenerationId
      if (id) rememberGenerationEnded(id, false)
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      reasoningStartedAt = 0
      set((state) => {
        const shouldRemovePlaceholder = isLocalStreamingPlaceholderId(state.regeneratingMessageId)
        return {
          ...(shouldRemovePlaceholder
            ? {
                messages: state.messages.filter((message) => message.id !== state.regeneratingMessageId),
                totalChatLength: Math.max(0, state.totalChatLength - 1),
              }
            : {}),
          isStreaming: false,
          streamingNavigationPaused: false,
          streamingContent: '',
          streamingReasoning: '',
          streamingReasoningDuration: null,
          streamingReasoningStartedAt: null,
          streamingError: null,
          activeGenerationId: null,
          regeneratingMessageId: null,
          streamingSwipeId: null,
          streamingGenerationType: null,
        }
      })
    },

    setStreamingError: (error) => {
      const id = get().activeGenerationId
      if (id) rememberGenerationEnded(id, false)
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      reasoningStartedAt = 0
      set((state) => {
        const shouldRemovePlaceholder = isLocalStreamingPlaceholderId(state.regeneratingMessageId)
        return {
          ...(shouldRemovePlaceholder
            ? {
                messages: state.messages.filter((message) => message.id !== state.regeneratingMessageId),
                totalChatLength: Math.max(0, state.totalChatLength - 1),
              }
            : {}),
          streamingError: error,
          isStreaming: false,
          streamingNavigationPaused: false,
          streamingContent: '',
          streamingReasoning: '',
          streamingReasoningDuration: null,
          streamingReasoningStartedAt: null,
          activeGenerationId: null,
          regeneratingMessageId: null,
          streamingSwipeId: null,
          streamingGenerationType: null,
        }
      })
    },

    markGenerationEnded: (generationId, completed = true) => {
      rememberGenerationEnded(generationId, completed)
      if (get().isStreaming && !get().activeGenerationId) set({ activeGenerationId: generationId })
    },
    hasGenerationEnded: (generationId) => endedGenerationIds.has(generationId),
    getGenerationEpoch: () => generationEpoch,

    setImpersonateDraftContent: (content) => set({ impersonateDraftContent: content }),

    // Message selection mode for bulk operations
    messageSelectMode: false,
    selectedMessageIds: [],

    setMessageSelectMode: (enabled) => set({ messageSelectMode: enabled, selectedMessageIds: [] }),

    toggleMessageSelect: (id) => set((state) => {
      const ids = state.selectedMessageIds
      const idx = ids.indexOf(id)
      if (idx >= 0) {
        return { selectedMessageIds: ids.filter((_, i) => i !== idx) }
      }
      return { selectedMessageIds: [...ids, id] }
    }),

    selectAllMessages: () => set((state) => ({
      selectedMessageIds: state.messages.map((m) => m.id),
    })),

    clearMessageSelection: () => set({ selectedMessageIds: [] }),

    selectMessageRange: (fromId, toId) => set((state) => {
      const fromIdx = state.messages.findIndex((m) => m.id === fromId)
      const toIdx = state.messages.findIndex((m) => m.id === toId)
      if (fromIdx < 0 || toIdx < 0) return state
      const start = Math.min(fromIdx, toIdx)
      const end = Math.max(fromIdx, toIdx)
      const rangeIds = state.messages.slice(start, end + 1).map((m) => m.id)
      // Merge with existing selection (union)
      const merged = new Set([...state.selectedMessageIds, ...rangeIds])
      return { selectedMessageIds: [...merged] }
    }),
  }
}
