import { useState, useCallback, useLayoutEffect, useMemo, useRef, useEffect } from 'react'
import { messagesApi } from '@/api/chats'
import { useStore } from '@/store'
import type { Message } from '@/types/api'

const MAX_DOM_MESSAGES = 500

export function useChunkedMessages(messages: Message[], chatId?: string | null) {
  const messagesPerPage = useStore((s) => s.messagesPerPage) || 50
  const [displayCount, setDisplayCount] = useState(messagesPerPage)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const loadingRef = useRef(false)
  const prevLengthRef = useRef(0)
  const prevChatIdRef = useRef(chatId)
  const justPrependedRef = useRef(false)

  const totalChatLength = useStore((s) => s.totalChatLength)
  const prependMessages = useStore((s) => s.prependMessages)

  useLayoutEffect(() => {
    if (chatId !== prevChatIdRef.current) {
      prevChatIdRef.current = chatId
      setDisplayCount(messagesPerPage)
      prevLengthRef.current = messages.length
    }
  }, [chatId, messages.length, messagesPerPage])

  useEffect(() => {
    const currentLength = messages.length
    if (currentLength < prevLengthRef.current - 10) {
      setDisplayCount(messagesPerPage)
    }
    prevLengthRef.current = currentLength
  }, [messages.length, messagesPerPage])

  const visibleMessages = useMemo(() => {
    const start = Math.max(0, messages.length - displayCount)
    return messages.slice(start).filter((m) => !m.extra?._loom_inject)
  }, [messages, displayCount])

  // There are more messages to show: either in-memory or on the server
  const hasMore = useMemo(
    () => messages.length > displayCount || messages.length < totalChatLength,
    [messages.length, displayCount, totalChatLength]
  )

  const loadMore = useCallback(() => {
    if (loadingRef.current) return
    loadingRef.current = true

    // If we have more in-memory messages to reveal, just expand the display window
    if (messages.length > displayCount) {
      setDisplayCount((prev) => Math.min(prev + messagesPerPage, MAX_DOM_MESSAGES))
      setTimeout(() => { loadingRef.current = false }, 100)
      return
    }

    // Otherwise fetch older messages from the server
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
        // Expand display count to show the newly loaded messages
        setDisplayCount((prev) => Math.min(prev + result.data.length, MAX_DOM_MESSAGES))
      })
      .catch((err) => {
        console.error('[useChunkedMessages] Failed to load older messages:', err)
      })
      .finally(() => {
        setLoadingOlder(false)
        setTimeout(() => { loadingRef.current = false }, 100)
      })
  }, [chatId, messages, displayCount, totalChatLength, prependMessages, messagesPerPage])

  const resetToBottom = useCallback(() => {
    setDisplayCount(messagesPerPage)
  }, [messagesPerPage])

  return {
    visibleMessages,
    hasMore,
    loadMore,
    loadingOlder,
    resetToBottom,
    justPrependedRef,
    totalCount: totalChatLength,
    displayCount: Math.min(displayCount, messages.length),
  }
}
