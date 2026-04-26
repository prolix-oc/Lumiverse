import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState, type ReactNode, type TouchEvent, type WheelEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useChunkedMessages } from '@/hooks/useChunkedMessages'
import { useStore } from '@/store'
import { getCharacterAvatarThumbUrlById, getCharacterAvatarLargeUrlById, getPersonaAvatarThumbUrlById, getPersonaAvatarLargeUrlById } from '@/lib/avatarUrls'
import { imagesApi } from '@/api/images'
import MessageCard from './MessageCard'
import MessageContent from './MessageContent'
import ReasoningBlock from './ReasoningBlock'
import StreamingIndicator from './StreamingIndicator'
import GroupChatProgressBar from './GroupChatProgressBar'
import GroupChatMemberBar from './GroupChatMemberBar'
import LazyImage from '@/components/shared/LazyImage'
import type { Message } from '@/types/api'
import styles from './MessageList.module.css'
import bubbleStyles from './BubbleMessage.module.css'

interface MessageListProps {
  messages: Message[]
  chatId: string
  isStreaming: boolean
}

const TOP_LOAD_THRESHOLD = 96
const CHAT_SCROLL_TO_BOTTOM_EVENT = 'lumiverse:chat-scroll-bottom'
const MIN_MEASURED_ROW_HEIGHT = 32
const MAX_ESTIMATED_ROW_HEIGHT = 900
const MOBILE_MOMENTUM_SETTLE_MS = 260

function clampEstimate(value: number) {
  return Math.max(MIN_MEASURED_ROW_HEIGHT, Math.min(MAX_ESTIMATED_ROW_HEIGHT, value))
}

export default function MessageList({ messages, chatId, isStreaming }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const isPinnedRef = useRef(true)
  const isProgrammaticScrollRef = useRef(false)
  const topLoadArmedRef = useRef(true)
  const touchYRef = useRef<number | null>(null)
  const { visibleMessages, hasMore, loadMore, loadingOlder, justPrependedRef } = useChunkedMessages(messages, chatId)
  const lastScrollHeightRef = useRef(0)
  const measuredRowHeightsRef = useRef<Map<string, number>>(new Map())
  const averageMeasuredHeightRef = useRef<number | null>(null)
  const isPrependingRef = useRef(false)
  const suppressNextPinUpdateRef = useRef(false)
  const touchMomentumHoldRef = useRef(false)
  const touchMomentumTimerRef = useRef<number | null>(null)
  const [isCoarsePointer, setIsCoarsePointer] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  )

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

  // Re-arm top-pagination on chat switch.
  useEffect(() => {
    topLoadArmedRef.current = true
    measuredRowHeightsRef.current = new Map()
    averageMeasuredHeightRef.current = null
  }, [chatId])
  const streamingContent = useStore((s) => s.streamingContent)
  const streamingReasoning = useStore((s) => s.streamingReasoning)
  const streamingReasoningDuration = useStore((s) => s.streamingReasoningDuration)
  const streamingReasoningStartedAt = useStore((s) => s.streamingReasoningStartedAt)
  const streamingError = useStore((s) => s.streamingError)
  const regeneratingMessageId = useStore((s) => s.regeneratingMessageId)
  const autoParse = useStore((s) => s.reasoningSettings.autoParse)
  const displayMode = useStore((s) => s.chatSheldDisplayMode)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const personas = useStore((s) => s.personas)
  const streamingGenerationType = useStore((s) => s.streamingGenerationType)
  const bubbleUserAlign = useStore((s) => s.bubbleUserAlign)
  const isImpersonateStream = streamingGenerationType === 'impersonate'
  const impersonateUserLeft = isImpersonateStream && bubbleUserAlign === 'left'

  // The store's appendStreamToken state machine already separates reasoning
  // from content during streaming. Skip the redundant per-frame regex scan
  // that was re-extracting <think> tags from already-clean streamingContent.
  const streamDisplay = streamingContent
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const activeGroupCharacterId = useStore((s) => s.activeGroupCharacterId)
  const activeChatAvatarId = useStore((s) => s.activeChatAvatarId)
  const isNudgeLoopActive = useStore((s) => s.isNudgeLoopActive)

  // For streaming, use the group's active character if in a group chat
  const streamCharacterId = isGroupChat && activeGroupCharacterId ? activeGroupCharacterId : activeCharacterId
  const streamCharacter = streamCharacterId ? characters.find((c) => c.id === streamCharacterId) : null
  const activeCharacter = activeCharacterId ? characters.find((c) => c.id === activeCharacterId) : null
  const streamDisplayName = useMemo(() => {
    const characterName = (streamCharacter?.name || activeCharacter?.name || '').trim()
    if (characterName) return characterName

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.is_user) continue
      const candidate = (m.name || '').trim()
      if (candidate && !/^assistant$/i.test(candidate)) return candidate
    }

    return 'Assistant'
  }, [streamCharacter?.name, activeCharacter?.name, messages])
  const activePersona = personas.find((p) => p.id === activePersonaId)
  const userName = activePersona?.name ?? 'User'
  const isBubble = displayMode === 'bubble'
  const getCharAvatar = isBubble ? getCharacterAvatarLargeUrlById : getCharacterAvatarThumbUrlById
  const getPersonaAvatar = isBubble ? getPersonaAvatarLargeUrlById : getPersonaAvatarThumbUrlById
  const getImgUrl = isBubble ? imagesApi.largeUrl : imagesApi.smallUrl
  const estimateSize = isBubble ? 260 : 180

  useEffect(() => {
    measuredRowHeightsRef.current = new Map()
    averageMeasuredHeightRef.current = null
    rowVirtualizer.measure()
  }, [displayMode, isCoarsePointer])

  useEffect(() => {
    return () => {
      if (touchMomentumTimerRef.current != null) {
        window.clearTimeout(touchMomentumTimerRef.current)
      }
    }
  }, [])

  const estimateMessageSize = useCallback((message: Message) => {
    const measured = measuredRowHeightsRef.current.get(message.id)
    if (measured) return measured

    const el = scrollRef.current
    const width = Math.max(240, el?.clientWidth ?? 720)
    const isCompactWidth = width <= 768
    const isPhoneWidth = width <= 480
    const bubbleInset = isPhoneWidth ? 20 : isCompactWidth ? 28 : 48
    const bubbleWidth = isBubble ? Math.max(180, width - bubbleInset) : width * (isCompactWidth ? 0.9 : 0.82)
    const charsPerLine = Math.max(24, Math.floor(bubbleWidth / 7.2))
    const content = message.swipes?.[message.swipe_id] ?? message.content ?? ''
    const explicitLines = content.split('\n').length
    const wrappedLines = Math.ceil(content.length / charsPerLine)
    const lineCount = Math.max(1, explicitLines, wrappedLines)
    const codeBlockCount = (content.match(/```/g)?.length ?? 0) / 2
    const imageCount = message.extra?.attachments?.filter((a) => a.type === 'image').length ?? 0
    const audioCount = message.extra?.attachments?.filter((a) => a.type === 'audio').length ?? 0
    const base = isBubble ? (isPhoneWidth ? 88 : isCompactWidth ? 96 : 104) : 76
    const lineHeight = 23
    const mediaHeight = imageCount > 0 ? (isPhoneWidth ? 190 : isCompactWidth ? 220 : 250) : 0
    const audioHeight = audioCount * 58
    const codeHeight = codeBlockCount * 44
    const contentEstimate = base + lineCount * lineHeight + mediaHeight + audioHeight + codeHeight
    const average = averageMeasuredHeightRef.current

    // Blend content heuristics with the measured chat average so unknown rows
    // near the loaded tail don't all start from the same poor fixed estimate.
    return clampEstimate(average ? (contentEstimate * 0.7 + average * 0.3) : contentEstimate)
  }, [isBubble])

  const rangeExtractor = useCallback((range: { startIndex: number; endIndex: number; count: number }) => {
    const extraBefore = isCoarsePointer ? 18 : 0
    const extraAfter = isCoarsePointer ? 6 : 0
    const start = Math.max(0, range.startIndex - extraBefore)
    const end = Math.min(range.count - 1, range.endIndex + extraAfter)
    const indexes: number[] = []

    for (let index = start; index <= end; index++) {
      indexes.push(index)
    }

    return indexes
  }, [isCoarsePointer])

  const getItemKey = useCallback(
    (index: number) => {
      const message = visibleMessages[index]
      return message ? message.id : index
    },
    [visibleMessages]
  )

  const rowVirtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const message = visibleMessages[index]
      return message ? estimateMessageSize(message) : estimateSize
    },
    overscan: 12,
    getItemKey,
    rangeExtractor,
    useAnimationFrameWithResizeObserver: true,
    measureElement: (element, entry) => {
      const size = entry?.borderBoxSize?.[0]?.blockSize
      const measured = size ?? element.getBoundingClientRect().height
      const messageId = element.getAttribute('data-message-id')
      if (messageId && measured >= MIN_MEASURED_ROW_HEIGHT) {
        measuredRowHeightsRef.current.set(messageId, measured)
        const values = Array.from(measuredRowHeightsRef.current.values())
        const sample = values.slice(-80)
        averageMeasuredHeightRef.current = sample.reduce((sum, value) => sum + value, 0) / sample.length
      }
      return measured
    },
  })

  useLayoutEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
      const scrollOffset = rowVirtualizer.scrollOffset ?? scrollRef.current?.scrollTop ?? 0
      return item.end < scrollOffset
    }

    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined
    }
  }, [rowVirtualizer])

  const virtualItems = rowVirtualizer.getVirtualItems()

  // Gate that keeps the keyboard/safe-zone repin from fighting the unified
  // scroll guard while streaming is active.
  const isStreamingRef = useRef(isStreaming)
  useEffect(() => {
    isStreamingRef.current = isStreaming
  }, [isStreaming])

  const scrollToHistoryBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current
    if (!el || visibleMessages.length === 0) return

    isPinnedRef.current = true
    isProgrammaticScrollRef.current = true
    rowVirtualizer.scrollToIndex(visibleMessages.length - 1, { align: 'end', behavior })

    requestAnimationFrame(() => {
      const latest = scrollRef.current
      if (!latest) return
      isProgrammaticScrollRef.current = true
      latest.scrollTop = latest.scrollHeight - latest.clientHeight
    })
  }, [rowVirtualizer, visibleMessages.length])

  const avatarUrl = isImpersonateStream
    ? getPersonaAvatar(activePersonaId, activePersona?.image_id ?? null)
    : (activeChatAvatarId && streamCharacterId === activeCharacterId)
      ? getImgUrl(activeChatAvatarId)
      : getCharAvatar(streamCharacterId, streamCharacter?.image_id ?? null)

  const PIN_THRESHOLD = 80
  const UNPIN_THRESHOLD = 120

  const updatePinState = (scrollTop: number, scrollHeight: number, clientHeight: number) => {
    const distance = scrollHeight - scrollTop - clientHeight
    if (isPinnedRef.current) {
      if (distance > UNPIN_THRESHOLD) {
        isPinnedRef.current = false
      }
    } else {
      if (distance < PIN_THRESHOLD) {
        isPinnedRef.current = true
      }
    }
  }

  // Track if user is near bottom — only update pin state for user-initiated
  // scrolls so that programmatic auto-scrolls don't fight user intent.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    if (isProgrammaticScrollRef.current) {
      isProgrammaticScrollRef.current = false
      return
    }

    if (!suppressNextPinUpdateRef.current) {
      updatePinState(el.scrollTop, el.scrollHeight, el.clientHeight)
    }
    suppressNextPinUpdateRef.current = false

    if (el.scrollTop > TOP_LOAD_THRESHOLD) {
      topLoadArmedRef.current = true
    }

    if (el.scrollTop <= TOP_LOAD_THRESHOLD && topLoadArmedRef.current && hasMore && !loadingOlder) {
      topLoadArmedRef.current = false
      loadMore()
    }
  }, [hasMore, loadingOlder, loadMore])

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < -30) {
      isPinnedRef.current = false
      suppressNextPinUpdateRef.current = true
    }
  }, [])

  const handleTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (touchMomentumTimerRef.current != null) {
      window.clearTimeout(touchMomentumTimerRef.current)
      touchMomentumTimerRef.current = null
    }
    touchMomentumHoldRef.current = true
    touchYRef.current = event.touches[0]?.clientY ?? null
  }, [])

  const handleTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const previousY = touchYRef.current
    const nextY = event.touches[0]?.clientY ?? null
    if (previousY != null && nextY != null && nextY > previousY + 10) {
      isPinnedRef.current = false
      suppressNextPinUpdateRef.current = true
    }
    touchYRef.current = nextY
  }, [])

  const releaseTouchMomentumHold = useCallback(() => {
    if (touchMomentumTimerRef.current != null) {
      window.clearTimeout(touchMomentumTimerRef.current)
    }
    touchMomentumTimerRef.current = window.setTimeout(() => {
      touchMomentumHoldRef.current = false
      touchMomentumTimerRef.current = null
    }, MOBILE_MOMENTUM_SETTLE_MS)
  }, [])

  // Scroll anchoring: when older messages are prepended, adjust scrollTop so
  // the user's viewport stays on the same content instead of jumping to the top.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    if (justPrependedRef.current) {
      isPrependingRef.current = true
      justPrependedRef.current = false
      const heightDiff = el.scrollHeight - lastScrollHeightRef.current
      if (heightDiff > 0 && lastScrollHeightRef.current > 0) {
        isProgrammaticScrollRef.current = true
        el.scrollTop += heightDiff
      }
      isPrependingRef.current = false
    }

    lastScrollHeightRef.current = el.scrollHeight

    if (el.scrollTop > TOP_LOAD_THRESHOLD) {
      topLoadArmedRef.current = true
    }

    // If the viewport is still effectively unfilled after prepending a page,
    // fetch one more page without waiting for another user scroll.
    if (!loadingOlder && hasMore && el.scrollHeight <= el.clientHeight + TOP_LOAD_THRESHOLD) {
      topLoadArmedRef.current = false
      requestAnimationFrame(() => {
        loadMore()
      })
    }
  }, [virtualItems, justPrependedRef, hasMore, loadingOlder, loadMore])

  // Unified scroll guard: watches scrollHeight changes caused by streaming
  // tokens, extension mounts, lazy image loads, or virtual row resizing.
  // When pinned we follow the bottom; when floating we compensate so the
  // viewport stays locked to the same reading position.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    let pendingRaf = 0
    let lastSH = el.scrollHeight
    let lastST = el.scrollTop

    const apply = () => {
      pendingRaf = 0
      const latest = scrollRef.current
      if (!latest) return
      if (justPrependedRef.current || isPrependingRef.current) return

      const newSH = latest.scrollHeight
      const newST = latest.scrollTop
      const heightDelta = newSH - lastSH
      const scrollTopDelta = newST - lastST

      lastSH = newSH
      lastST = newST

      if (heightDelta === 0) return

      // If scrollTop already moved by roughly the height change, something
      // else (e.g. the virtualizer's shouldAdjustScrollPositionOnItemSizeChange)
      // handled it — don't double-compensate.
      if (Math.abs(scrollTopDelta - heightDelta) < 2) return

      if (isPinnedRef.current) {
        isProgrammaticScrollRef.current = true
        latest.scrollTop = latest.scrollHeight - latest.clientHeight
      } else if (heightDelta > 0 && !(isCoarsePointer && touchMomentumHoldRef.current)) {
        // Only compensate for growth. Shrinkage is either handled by the
        // virtualizer or is minor enough to ignore.
        isProgrammaticScrollRef.current = true
        latest.scrollTop += heightDelta
      }
    }

    const mo = new MutationObserver(() => {
      if (pendingRaf) return
      pendingRaf = requestAnimationFrame(apply)
    })

    mo.observe(el, { childList: true, subtree: true, characterData: true })

    return () => {
      mo.disconnect()
      if (pendingRaf) cancelAnimationFrame(pendingRaf)
    }
  }, [isCoarsePointer])

  // Re-pin to bottom when the input safe-zone changes — keyboard opening on
  // mobile/iOS PWA grows --lcs-input-safe-zone. Without this, the last
  // message would stay behind the newly-raised input bar.
  useEffect(() => {
    const el = scrollRef.current
    const parent = el?.parentElement
    if (!el || !parent) return

    const settleTimers: number[] = []
    const clearSettleTimers = () => {
      while (settleTimers.length) {
        window.clearTimeout(settleTimers.shift())
      }
    }

    const pinToBottom = () => {
      if (!isPinnedRef.current) return
      const latest = scrollRef.current
      if (!latest) return
      isProgrammaticScrollRef.current = true
      latest.scrollTop = latest.scrollHeight - latest.clientHeight
    }

    // iOS keyboard animation (~250-350ms) fires multiple visualViewport
    // resize events. A single rAF-pin can land mid-animation, so we pin
    // immediately AND schedule settling retries to catch the final layout
    // once the keyboard and safe-zone have settled. Skipped while streaming
    // — the unified scroll guard already handles content growth.
    const repinIfAnchored = () => {
      if (isStreamingRef.current) return
      if (!isPinnedRef.current) return
      requestAnimationFrame(pinToBottom)
      clearSettleTimers()
      settleTimers.push(window.setTimeout(pinToBottom, 180))
      settleTimers.push(window.setTimeout(pinToBottom, 420))
    }

    const mo = new MutationObserver(repinIfAnchored)
    mo.observe(parent, { attributes: true, attributeFilter: ['style'] })

    const vv = window.visualViewport
    vv?.addEventListener('resize', repinIfAnchored)
    vv?.addEventListener('scroll', repinIfAnchored)

    return () => {
      mo.disconnect()
      vv?.removeEventListener('resize', repinIfAnchored)
      vv?.removeEventListener('scroll', repinIfAnchored)
      clearSettleTimers()
    }
  }, [])

  // Scroll to bottom on chat change — always pin when switching chats
  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      isPinnedRef.current = true
      isProgrammaticScrollRef.current = true
      el.scrollTop = el.scrollHeight - el.clientHeight
    }
  }, [chatId])

  useEffect(() => {
    const handleScrollToBottom = () => scrollToHistoryBottom('smooth')
    window.addEventListener(CHAT_SCROLL_TO_BOTTOM_EVENT, handleScrollToBottom)
    return () => window.removeEventListener(CHAT_SCROLL_TO_BOTTOM_EVENT, handleScrollToBottom)
  }, [scrollToHistoryBottom])

  return (
    <div
      data-component="MessageList"
      className={styles.list}
      ref={scrollRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={releaseTouchMomentumHold}
      onTouchCancel={releaseTouchMomentumHold}
      data-chat-scroll="true"
    >
      {isGroupChat && <GroupChatMemberBar chatId={chatId} />}
      {loadingOlder && (
        <div className={styles.loadingOlder}>Loading older messages...</div>
      )}
      <div
        className={styles.virtualSpace}
        style={{ height: rowVirtualizer.getTotalSize() }}
      >
        {virtualItems.map((virtualRow) => {
          const message = visibleMessages[virtualRow.index]
          if (!message) return null

          return (
            <VirtualRow
              key={virtualRow.key}
              index={virtualRow.index}
              messageId={message.id}
              start={virtualRow.start}
              measureElement={rowVirtualizer.measureElement}
            >
              <MessageCard
                message={message}
                chatId={chatId}
                depth={visibleMessages.length - 1 - virtualRow.index}
              />
            </VirtualRow>
          )
        })}
      </div>

      {/* Group chat progress bar during nudge loop */}
      {isGroupChat && isNudgeLoopActive && <GroupChatProgressBar />}

      {/* Streaming message bubble — shows tokens as they arrive (only for new messages, not regeneration or continue) */}
      {isStreaming && !regeneratingMessageId && streamingGenerationType !== 'continue' && (streamDisplay || !streamingError) && (() => {
        const bubbleName = isImpersonateStream ? userName : streamDisplayName
        const bubbleStyleClass = isImpersonateStream ? bubbleStyles.user : bubbleStyles.character
        const nameStyleClass = isImpersonateStream ? bubbleStyles.nameUser : bubbleStyles.nameChar
        return (
          <div className={`${bubbleStyles.card} ${bubbleStyleClass} ${impersonateUserLeft ? bubbleStyles.userLeft : ''} ${bubbleStyles.streaming}`}>
            <div className={bubbleStyles.bubble}>
              <div className={bubbleStyles.header}>
                <div className={bubbleStyles.headerLeft}>
                  <div className={bubbleStyles.avatar}>
                    {avatarUrl ? (
                      <LazyImage
                        src={avatarUrl}
                        alt={bubbleName}
                        fallback={
                          <div className={bubbleStyles.avatarFallback}>
                            {bubbleName?.[0]?.toUpperCase() || '?'}
                          </div>
                        }
                      />
                    ) : (
                      <div className={bubbleStyles.avatarFallback}>
                        {bubbleName?.[0]?.toUpperCase() || '?'}
                      </div>
                    )}
                  </div>
                  <div className={bubbleStyles.metaWrap}>
                    <span className={`${bubbleStyles.name} ${nameStyleClass}`}>
                      {bubbleName}
                    </span>
                  </div>
                </div>
              </div>
              {streamingReasoning && (
                <ReasoningBlock
                  reasoning={streamingReasoning}
                  reasoningDuration={streamingReasoningDuration ?? undefined}
                  reasoningStartedAt={streamingReasoningStartedAt}
                  isStreaming
                  variant="bubble"
                  align={isImpersonateStream && !impersonateUserLeft ? 'right' : undefined}
                />
              )}
              <div className={bubbleStyles.content}>
                {streamDisplay ? (
                  <MessageContent
                    content={streamDisplay}
                    isUser={isImpersonateStream}
                    userName={userName}
                    isStreaming
                    chatId={chatId}
                  />
                ) : (
                  <StreamingIndicator />
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Generation error display */}
      {streamingError && (
        <div className={styles.errorBubble}>
          <span className={styles.errorLabel}>Generation failed:</span> {streamingError}
        </div>
      )}

      <div data-spindle-mount="message_footer" />
      <div ref={bottomRef} />
    </div>
  )
}

interface VirtualRowProps {
  index: number
  messageId: string
  start: number
  measureElement: (el: Element | null) => void
  children: ReactNode
}

function VirtualRow({ index, messageId, start, measureElement, children }: VirtualRowProps) {
  return (
    <div
      ref={measureElement}
      data-index={index}
      data-message-id={messageId}
      className={styles.virtualRow}
      style={{ transform: `translateY(${start}px)` }}
    >
      {children}
    </div>
  )
}
