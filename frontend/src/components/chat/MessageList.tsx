import { useRef, useState, useEffect, useLayoutEffect, useCallback, useMemo } from 'react'
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

export default function MessageList({ messages, chatId, isStreaming }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)
  const isProgrammaticScrollRef = useRef(false)
  const topLoadArmedRef = useRef(true)
  const rafRef = useRef<number>(0)
  const { visibleMessages, hasMore, loadMore, loadingOlder, justPrependedRef } = useChunkedMessages(messages, chatId)
  const lastScrollHeightRef = useRef(0)
  const [revealed, setRevealed] = useState(false)
  const prevChatIdRef = useRef(chatId)

  // Fade-in on chat switch: reset revealed when chat changes, reveal once messages arrive
  useEffect(() => {
    if (chatId !== prevChatIdRef.current) {
      prevChatIdRef.current = chatId
      setRevealed(false)
      topLoadArmedRef.current = true
    }
  }, [chatId])

  useEffect(() => {
    if (!revealed && visibleMessages.length > 0) {
      // Use rAF to ensure the DOM has rendered before triggering the transition
      requestAnimationFrame(() => setRevealed(true))
    }
  }, [revealed, visibleMessages.length])
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

  const getItemKey = useCallback(
    (index: number) => {
      const message = visibleMessages[index]
      return message ? `${message.id}:${message.index_in_chat}` : index
    },
    [visibleMessages]
  )

  const rowVirtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan: 6,
    getItemKey,
  })

  const virtualItems = rowVirtualizer.getVirtualItems()
  const rangeKey = `${virtualItems[0]?.index ?? -1}:${virtualItems[virtualItems.length - 1]?.index ?? -1}`

  // While streaming, the `streamingContent`-deps RAF pin (below) is the sole
  // authority on scroll position. The virtualTotalSize layout-effect and the
  // MutationObserver/visualViewport triple-pin get routed through this ref so
  // they no-op during generation — their overlapping scrollTop writes on top
  // of the RAF pin are what produced the "jumping" stream on iOS PWA.
  const isStreamingRef = useRef(isStreaming)
  useEffect(() => {
    isStreamingRef.current = isStreaming
  }, [isStreaming])

  const scrollToHistoryBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current
    if (!el || visibleMessages.length === 0) return

    isNearBottomRef.current = true
    isProgrammaticScrollRef.current = true
    rowVirtualizer.scrollToIndex(visibleMessages.length - 1, { align: 'end', behavior })

    requestAnimationFrame(() => {
      const latest = scrollRef.current
      if (!latest) return
      isProgrammaticScrollRef.current = true
      latest.scrollTop = latest.scrollHeight
    })
  }, [rowVirtualizer, visibleMessages.length])

  const avatarUrl = isImpersonateStream
    ? getPersonaAvatar(activePersonaId, activePersona?.image_id ?? null)
    : (activeChatAvatarId && streamCharacterId === activeCharacterId)
      ? getImgUrl(activeChatAvatarId)
      : getCharAvatar(streamCharacterId, streamCharacter?.image_id ?? null)

  // Track if user is near bottom — only update pin state for user-initiated
  // scrolls so that programmatic auto-scrolls don't fight user intent.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    if (isProgrammaticScrollRef.current) {
      isProgrammaticScrollRef.current = false
      return
    }

    const threshold = 30
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold

    if (el.scrollTop > TOP_LOAD_THRESHOLD) {
      topLoadArmedRef.current = true
    }

    if (el.scrollTop <= TOP_LOAD_THRESHOLD && topLoadArmedRef.current && hasMore && !loadingOlder) {
      topLoadArmedRef.current = false
      loadMore()
    }
  }, [hasMore, loadingOlder, loadMore])

  // Scroll anchoring: when older messages are prepended, adjust scrollTop so
  // the user's viewport stays on the same content instead of jumping to the top.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    if (justPrependedRef.current) {
      justPrependedRef.current = false
      const heightDiff = el.scrollHeight - lastScrollHeightRef.current
      if (heightDiff > 0 && lastScrollHeightRef.current > 0) {
        isProgrammaticScrollRef.current = true
        el.scrollTop += heightDiff
      }
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

  // RAF-batched auto-scroll during streaming — skipped when user scrolls up
  useEffect(() => {
    if (!isNearBottomRef.current) return

    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) {
        isProgrammaticScrollRef.current = true
        el.scrollTop = el.scrollHeight
      }
    })

    return () => cancelAnimationFrame(rafRef.current)
  }, [messages.length, streamingContent])

  // The virtualizer renders each row at estimateSize first and measures its
  // real height asynchronously via ResizeObserver. When the measured height
  // exceeds the estimate (common for long messages), totalSize grows after
  // the pin-to-bottom effect above already ran — leaving the tail of the
  // last message behind the input bar. Re-pin whenever the virtual total
  // size changes while the user is anchored to the bottom. Skipped during
  // active streaming — the streamingContent RAF pin already handles that
  // cadence, and lazy markdown/image measures mid-stream would otherwise
  // double-pin on top of the RAF writes.
  const virtualTotalSize = rowVirtualizer.getTotalSize()
  useLayoutEffect(() => {
    if (isStreamingRef.current) return
    if (!isNearBottomRef.current) return
    const el = scrollRef.current
    if (!el) return
    isProgrammaticScrollRef.current = true
    el.scrollTop = el.scrollHeight - el.clientHeight
  }, [virtualTotalSize])

  // Re-pin to bottom when the input safe-zone changes — keyboard opening on
  // mobile/iOS PWA grows --lcs-input-safe-zone (set as inline style on the
  // parent chatColumnInner by InputArea's ResizeObserver). Without this, the
  // last message would stay behind the newly-raised input bar. Also covers
  // textarea auto-grow and any other input-driven safe-zone changes.
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
      if (!isNearBottomRef.current) return
      const latest = scrollRef.current
      if (!latest) return
      isProgrammaticScrollRef.current = true
      latest.scrollTop = latest.scrollHeight - latest.clientHeight
    }

    // iOS keyboard animation (~250-350ms) fires multiple visualViewport
    // resize events. A single rAF-pin can land mid-animation, so we pin
    // immediately AND schedule settling retries to catch the final layout
    // once the keyboard and safe-zone have settled. Skipped while streaming
    // — the 32ms streamingContent RAF pin already holds the viewport at the
    // bottom, and stacking the 180/420ms timer pins on top of rapid content
    // growth produced the visible stepping on iOS PWA.
    const repinIfAnchored = () => {
      if (isStreamingRef.current) return
      if (!isNearBottomRef.current) return
      requestAnimationFrame(pinToBottom)
      clearSettleTimers()
      settleTimers.push(window.setTimeout(pinToBottom, 180))
      settleTimers.push(window.setTimeout(pinToBottom, 420))
    }

    // Inline-style mutations on chatColumnInner carry --lcs-input-safe-zone
    // updates (set by InputArea's ResizeObserver + visualViewport listener).
    const mo = new MutationObserver(repinIfAnchored)
    mo.observe(parent, { attributes: true, attributeFilter: ['style'] })

    // visualViewport resize catches the keyboard directly, in case the
    // safe-zone lands at the same computed value (e.g., the keyboard's
    // inset already equals the default fallback).
    const vv = window.visualViewport
    vv?.addEventListener('resize', repinIfAnchored)
    // visualViewport scroll fires on iOS when the page offsets itself to
    // keep the focused input in view — another moment worth re-pinning.
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
      isNearBottomRef.current = true
      isProgrammaticScrollRef.current = true
      el.scrollTop = el.scrollHeight
    }
  }, [chatId])

  useEffect(() => {
    const handleScrollToBottom = () => scrollToHistoryBottom('smooth')
    window.addEventListener(CHAT_SCROLL_TO_BOTTOM_EVENT, handleScrollToBottom)
    return () => window.removeEventListener(CHAT_SCROLL_TO_BOTTOM_EVENT, handleScrollToBottom)
  }, [scrollToHistoryBottom])

  // Viewport observer — gate expensive effects (box-shadow, backdrop-filter) to visible cards.
  // When glass is disabled, skip the observer entirely — the backdrop-filter rules won't apply
  // via CSS (gated behind [data-glass]), and the box-shadow alone isn't expensive enough to
  // warrant the constant attribute toggling that causes layout thrash during scroll.
  const glassEnabled = useStore((s) => s.theme?.enableGlass ?? true)

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    // When glass is off, mark all cards as in-viewport statically (for box-shadow)
    // and skip the observer to avoid scroll-time DOM mutations.
    const cards = container.querySelectorAll('[data-message-id]')
    if (!glassEnabled) {
      cards.forEach((card) => card.setAttribute('data-in-viewport', ''))
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.setAttribute('data-in-viewport', '')
          } else {
            entry.target.removeAttribute('data-in-viewport')
          }
        }
      },
      { root: container, rootMargin: '200px' }
    )

    cards.forEach((card) => observer.observe(card))

    return () => observer.disconnect()
  }, [glassEnabled, rangeKey])

  return (
    <div data-component="MessageList" className={`${styles.list} ${revealed ? styles.listRevealed : styles.listHidden}`} ref={scrollRef} onScroll={handleScroll} data-chat-scroll="true">
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
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              className={styles.virtualRow}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <MessageCard
                message={message}
                chatId={chatId}
                depth={visibleMessages.length - 1 - virtualRow.index}
              />
            </div>
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
          <div className={`${bubbleStyles.card} ${bubbleStyleClass} ${impersonateUserLeft ? bubbleStyles.userLeft : ''} ${bubbleStyles.streaming}`} data-in-viewport>
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
