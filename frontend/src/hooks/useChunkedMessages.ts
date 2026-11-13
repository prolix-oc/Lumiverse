import { useState, useCallback, useLayoutEffect, useEffect, useMemo, useRef } from 'react'
import { messagesApi } from '@/api/chats'
import { useStore } from '@/store'
import type { Message } from '@/types/api'
import { createHistoryPageLoader, getHistoryBoundary } from '@/lib/history-page-loader'
import { wsClient } from '@/ws/client'
import { EventType } from '@/types/ws-events'

export function useChunkedMessages(messages: Message[], chatId?: string | null) {
  const messagesPerPage = useStore((s) => s.messagesPerPage) || 50
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [historyExhausted, setHistoryExhausted] = useState(false)
  const loadingRef = useRef<symbol | null>(null)
  const pageLoader = useRef(createHistoryPageLoader<Awaited<ReturnType<typeof messagesApi.before>>>())
  const navigation = useRef(0)
  const [displayReady, setDisplayReady] = useState(false)
  const [historyRevision, setHistoryRevision] = useState(0)
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
    const loader = pageLoader.current
    navigation.current++
    loader.reset()
    loadingRef.current = null
    setLoadingOlder(false)
    setHistoryExhausted(false)
    setDisplayReady(false)
    justPrependedRef.current = false
    return () => { loadingRef.current = null; loader.reset() }
  }, [chatId])

  useEffect(() => {
    const invalidate = (payload: { chatId: string }) => {
      if (payload.chatId !== chatId) return
      navigation.current++
      pageLoader.current.reset()
      loadingRef.current = null
      setLoadingOlder(false)
      setHistoryExhausted(false)
      setHistoryRevision((revision) => revision + 1)
    }
    const off = [EventType.MESSAGE_EDITED, EventType.MESSAGE_DELETED, EventType.MESSAGE_SWIPED]
      .map((event) => wsClient.on(event, invalidate))
    return () => { for (const unsubscribe of off) unsubscribe() }
  }, [chatId])

  useEffect(() => {
    const populated = (event: Event) => {
      if ((event as CustomEvent).detail?.chatId === chatId) setDisplayReady(true)
    }
    window.addEventListener('lumiverse:chat-items-populated', populated)
    return () => window.removeEventListener('lumiverse:chat-items-populated', populated)
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

  const boundary = useMemo(() => getHistoryBoundary(messages), [messages])
  const getOlderRequest = useCallback(() => {
    if (!chatId || !boundary || historyExhausted || messages.length >= totalChatLength) return null
    const cursor = { index: boundary.index_in_chat, id: boundary.id }
    const key = JSON.stringify([chatId, cursor.index, cursor.id, historyBatchSize, totalChatLength, historyRevision])
    return { key, cursor }
  }, [chatId, boundary, historyExhausted, messages.length, totalChatLength, historyBatchSize, historyRevision])

  const readOlder = useCallback(() => {
    const request = getOlderRequest()
    if (!request || !chatId) return Promise.resolve(undefined)
    return pageLoader.current.load(request.key,
      (signal) => messagesApi.before(chatId, request.cursor, historyBatchSize, { signal }))
  }, [chatId, getOlderRequest, historyBatchSize])

  const loadMore = useCallback(() => {
    if (loadingRef.current || !getOlderRequest()) return
    const operation = Symbol()
    const epoch = navigation.current
    const requestedBoundaryId = boundary?.id
    const requestedTotal = totalChatLength
    loadingRef.current = operation
    setLoadingOlder(true)
    // readOlder joins the exact pending prefetch, including its eventual failure.
    void readOlder().then((page) => {
      if (!page || navigation.current !== epoch || loadingRef.current !== operation) return
      const current = useStore.getState()
      if (current.activeChatId !== chatId || getHistoryBoundary(current.messages)?.id !== requestedBoundaryId || current.totalChatLength !== requestedTotal) {
        pageLoader.current.reset()
        return
      }
      const existingIds = new Set(useStore.getState().messages.map((message) => message.id))
      const progressed = page.data.some((message) => !existingIds.has(message.id))
      setHistoryExhausted(!page.has_more || !progressed)
      if (progressed) {
        justPrependedRef.current = true
        prependMessages(page.data)
      }
      pageLoader.current.reset()
    }).catch((error) => {
      console.error('[useChunkedMessages] Failed to load older messages:', error)
    }).finally(() => {
      if (loadingRef.current !== operation) return
      loadingRef.current = null
      setLoadingOlder(false)
    })
  }, [getOlderRequest, readOlder, prependMessages, boundary?.id, totalChatLength, chatId])

  useEffect(() => {
    if (!hasMore || !displayReady) return
    void readOlder().catch((error) => {
      console.error('[useChunkedMessages] Failed to prefetch older messages:', error)
    })
  }, [hasMore, displayReady, readOlder])

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
