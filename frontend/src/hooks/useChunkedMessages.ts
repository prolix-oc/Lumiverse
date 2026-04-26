import { useState, useCallback, useLayoutEffect, useEffect, useMemo, useRef } from 'react'
import { messagesApi } from '@/api/chats'
import { useStore } from '@/store'
import type { Message } from '@/types/api'

export function useChunkedMessages(messages: Message[], chatId?: string | null) {
  const messagesPerPage = useStore((s) => s.messagesPerPage) || 50
  const [loadingOlder, setLoadingOlder] = useState(false)
  const loadingRef = useRef(false)
  const prefetchingRef = useRef(false)
  const prefetchedBatchRef = useRef<{ chatId: string; oldestLoaded: number; data: Message[] } | null>(null)
  const prevChatIdRef = useRef(chatId)
  const justPrependedRef = useRef(false)
  const [isCoarsePointer, setIsCoarsePointer] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  )

  const totalChatLength = useStore((s) => s.totalChatLength)
  const prependMessages = useStore((s) => s.prependMessages)
  const historyBatchSize = isCoarsePointer ? Math.min(messagesPerPage * 2, 200) : messagesPerPage

  useEffect(() => {
    if (typeof window === 'undefined') return

    const mediaQuery = window.matchMedia('(pointer: coarse)')
    const update = () => setIsCoarsePointer(mediaQuery.matches)
    update()

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', update)
      return () => mediaQuery.removeEventListener('change', update)
    }

    mediaQuery.addListener(update)
    return () => mediaQuery.removeListener(update)
  }, [])

  useLayoutEffect(() => {
    if (chatId !== prevChatIdRef.current) {
      prevChatIdRef.current = chatId
      prefetchedBatchRef.current = null
      prefetchingRef.current = false
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

  const getOlderRequest = useCallback(() => {
    if (!chatId || messages.length >= totalChatLength) return null

    const oldestLoaded = messages.length > 0 ? messages[0].index_in_chat : 0
    const offset = Math.max(0, oldestLoaded - historyBatchSize)
    const limit = oldestLoaded - offset
    if (limit <= 0) return null

    return { oldestLoaded, offset, limit }
  }, [chatId, messages, totalChatLength, historyBatchSize])

  const applyOlderBatch = useCallback((olderMessages: Message[]) => {
    if (olderMessages.length === 0) return
    justPrependedRef.current = true
    prependMessages(olderMessages)
  }, [prependMessages])

  const prefetchOlder = useCallback(() => {
    if (loadingRef.current || prefetchingRef.current) return

    const request = getOlderRequest()
    if (!request || !chatId) return

    const cached = prefetchedBatchRef.current
    if (cached && cached.chatId === chatId && cached.oldestLoaded === request.oldestLoaded) return

    prefetchingRef.current = true
    messagesApi
      .list(chatId, { limit: request.limit, offset: request.offset })
      .then((result) => {
        prefetchedBatchRef.current = {
          chatId,
          oldestLoaded: request.oldestLoaded,
          data: result.data,
        }
      })
      .catch((err) => {
        console.error('[useChunkedMessages] Failed to prefetch older messages:', err)
      })
      .finally(() => {
        prefetchingRef.current = false
      })
  }, [chatId, getOlderRequest])

  const loadMore = useCallback(() => {
    if (loadingRef.current) return
    loadingRef.current = true

    const request = getOlderRequest()
    if (!chatId || !request) {
      loadingRef.current = false
      return
    }

    const cached = prefetchedBatchRef.current
    if (cached && cached.chatId === chatId && cached.oldestLoaded === request.oldestLoaded) {
      prefetchedBatchRef.current = null
      applyOlderBatch(cached.data)
      setTimeout(() => {
        loadingRef.current = false
        prefetchOlder()
      }, 0)
      return
    }

    setLoadingOlder(true)
    messagesApi
      .list(chatId, { limit: request.limit, offset: request.offset })
      .then((result) => {
        prefetchedBatchRef.current = null
        applyOlderBatch(result.data)
      })
      .catch((err) => {
        console.error('[useChunkedMessages] Failed to load older messages:', err)
      })
      .finally(() => {
        setLoadingOlder(false)
        setTimeout(() => {
          loadingRef.current = false
          prefetchOlder()
        }, 100)
      })
  }, [applyOlderBatch, chatId, getOlderRequest, prefetchOlder])

  useEffect(() => {
    if (!hasMore) return
    prefetchOlder()
  }, [hasMore, prefetchOlder, messages.length])

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
