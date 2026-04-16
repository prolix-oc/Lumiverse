import { useState, useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { messagesApi } from '@/api/chats'
import { useStore } from '@/store'
import type { Message } from '@/types/api'

export function useChunkedMessages(messages: Message[], chatId?: string | null) {
  const messagesPerPage = useStore((s) => s.messagesPerPage) || 50
  const [loadingOlder, setLoadingOlder] = useState(false)
  const loadingRef = useRef(false)
  const prevChatIdRef = useRef(chatId)
  const justPrependedRef = useRef(false)

  const totalChatLength = useStore((s) => s.totalChatLength)
  const prependMessages = useStore((s) => s.prependMessages)

  useLayoutEffect(() => {
    if (chatId !== prevChatIdRef.current) {
      prevChatIdRef.current = chatId
    }
  }, [chatId])

  const visibleMessages = useMemo(() => {
    return messages.filter((m) => !m.extra?._loom_inject)
  }, [messages])

  // With DOM virtualization in MessageList, keep all loaded messages available
  // in-memory and only page additional history from the server as needed.
  const hasMore = useMemo(
    () => messages.length < totalChatLength,
    [messages.length, totalChatLength]
  )

  const loadMore = useCallback(() => {
    if (loadingRef.current) return
    loadingRef.current = true

    if (!chatId || messages.length >= totalChatLength) {
      loadingRef.current = false
      return
    }

    // Calculate the offset for the next batch of older messages
    const oldestLoaded = messages.length > 0 ? messages[0].index_in_chat : 0
    const offset = Math.max(0, oldestLoaded - messagesPerPage)
    const limit = oldestLoaded - offset

    if (limit <= 0) {
      loadingRef.current = false
      return
    }

    setLoadingOlder(true)
    messagesApi
      .list(chatId, { limit, offset })
      .then((result) => {
        justPrependedRef.current = true
        prependMessages(result.data)
      })
      .catch((err) => {
        console.error('[useChunkedMessages] Failed to load older messages:', err)
      })
      .finally(() => {
        setLoadingOlder(false)
        setTimeout(() => { loadingRef.current = false }, 100)
      })
  }, [chatId, messages, totalChatLength, prependMessages, messagesPerPage])

  const resetToBottom = useCallback(() => {
    justPrependedRef.current = false
  }, [])

  return {
    visibleMessages,
    hasMore,
    loadMore,
    loadingOlder,
    resetToBottom,
    justPrependedRef,
    totalCount: totalChatLength,
    displayCount: messages.length,
  }
}
