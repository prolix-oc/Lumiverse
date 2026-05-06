import { useState, useCallback, useLayoutEffect, useEffect, useMemo, useRef } from 'react'
import { messagesApi } from '@/api/chats'
import { useStore } from '@/store'
import type { Message } from '@/types/api'

export function useChunkedMessages(messages: Message[], chatId?: string | null) {
  const messagesPerPage = useStore((s) => s.messagesPerPage) || 50
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [historyExhausted, setHistoryExhausted] = useState(false)
  const loadingRef = useRef(false)
  const prefetchingRef = useRef(false)
  const prefetchedBatchRef = useRef<{ chatId: string; loadedCount: number; data: Message[] } | null>(null)
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
      setHistoryExhausted(false)
    }
  }, [chatId])

  useEffect(() => {
    setHistoryExhausted(false)
  }, [totalChatLength])

  const visibleMessages = useMemo(() => {
    return messages.filter((m) => !m.extra?._loom_inject)
  }, [messages])

  // With DOM virtualization in MessageList, keep all loaded messages available
  // in-memory and only page additional history from the server as needed.
  const hasMore = useMemo(
    () => !historyExhausted && messages.length < totalChatLength,
    [historyExhausted, messages.length, totalChatLength]
  )

  const getOlderRequest = useCallback(() => {
    if (!chatId || historyExhausted || messages.length >= totalChatLength) return null

    const loadedCount = messages.length
    const remainingBeforeLoadedWindow = Math.max(0, totalChatLength - loadedCount)
    const offset = Math.max(0, remainingBeforeLoadedWindow - historyBatchSize)
    const limit = remainingBeforeLoadedWindow - offset
    if (limit <= 0) return null

    return { loadedCount, offset, limit }
  }, [chatId, historyExhausted, messages.length, totalChatLength, historyBatchSize])

  const applyOlderBatch = useCallback((olderMessages: Message[]) => {
    const existingIds = new Set(messages.map((m) => m.id))
    const hasNewMessages = olderMessages.some((message) => !existingIds.has(message.id))
    if (!hasNewMessages) {
      setHistoryExhausted(true)
      return false
    }
    justPrependedRef.current = true
    prependMessages(olderMessages)
    return true
  }, [messages, prependMessages])

  const prefetchOlder = useCallback(() => {
    if (loadingRef.current || prefetchingRef.current) return

    const request = getOlderRequest()
    if (!request || !chatId) return

    const cached = prefetchedBatchRef.current
    if (cached && cached.chatId === chatId && cached.loadedCount === request.loadedCount) return

    prefetchingRef.current = true
    messagesApi
      .list(chatId, { limit: request.limit, offset: request.offset })
      .then((result) => {
        prefetchedBatchRef.current = {
          chatId,
          loadedCount: request.loadedCount,
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
    if (cached && cached.chatId === chatId && cached.loadedCount === request.loadedCount) {
      prefetchedBatchRef.current = null
      const didProgress = applyOlderBatch(cached.data)
      setTimeout(() => {
        loadingRef.current = false
        if (didProgress) prefetchOlder()
      }, 0)
      return
    }

    setLoadingOlder(true)
    let didProgress = false
    messagesApi
      .list(chatId, { limit: request.limit, offset: request.offset })
      .then((result) => {
        prefetchedBatchRef.current = null
        didProgress = applyOlderBatch(result.data)
      })
      .catch((err) => {
        console.error('[useChunkedMessages] Failed to load older messages:', err)
      })
      .finally(() => {
        setLoadingOlder(false)
        setTimeout(() => {
          loadingRef.current = false
          if (didProgress) prefetchOlder()
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
