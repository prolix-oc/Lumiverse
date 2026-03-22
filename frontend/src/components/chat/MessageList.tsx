import { useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react'
import { useChunkedMessages } from '@/hooks/useChunkedMessages'
import { useStore } from '@/store'
import { charactersApi } from '@/api/characters'
import { personasApi } from '@/api/personas'
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

export default function MessageList({ messages, chatId, isStreaming }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)
  const rafRef = useRef<number>(0)
  const { visibleMessages, hasMore, loadMore, loadingOlder, justPrependedRef } = useChunkedMessages(messages, chatId)
  const lastScrollHeightRef = useRef(0)
  const streamingContent = useStore((s) => s.streamingContent)
  const streamingReasoning = useStore((s) => s.streamingReasoning)
  const streamingError = useStore((s) => s.streamingError)
  const regeneratingMessageId = useStore((s) => s.regeneratingMessageId)
  const autoParse = useStore((s) => s.reasoningSettings.autoParse)
  const displayMode = useStore((s) => s.chatSheldDisplayMode)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const personas = useStore((s) => s.personas)
  const streamingGenerationType = useStore((s) => s.streamingGenerationType)
  const isImpersonateStream = streamingGenerationType === 'impersonate'

  // The store's appendStreamToken state machine already separates reasoning
  // from content during streaming. Skip the redundant per-frame regex scan
  // that was re-extracting <think> tags from already-clean streamingContent.
  const streamDisplay = streamingContent
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const activeGroupCharacterId = useStore((s) => s.activeGroupCharacterId)
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
  const avatarUrl = isImpersonateStream
    ? (activePersonaId ? personasApi.avatarUrl(activePersonaId) : null)
    : (streamCharacterId ? charactersApi.avatarUrl(streamCharacterId) : null)

  // Intersection observer for loading more
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasMore) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadMore()
      },
      { root: scrollRef.current, rootMargin: '200px' }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loadMore])

  // Track if user is near bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const threshold = 150
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  }, [])

  // Scroll anchoring: when older messages are prepended, adjust scrollTop so
  // the user's viewport stays on the same content instead of jumping to the top.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    if (justPrependedRef.current) {
      justPrependedRef.current = false
      const heightDiff = el.scrollHeight - lastScrollHeightRef.current
      if (heightDiff > 0 && lastScrollHeightRef.current > 0) {
        el.scrollTop += heightDiff
      }
    }

    lastScrollHeightRef.current = el.scrollHeight
  })

  // RAF-batched auto-scroll during streaming
  useEffect(() => {
    if (!isNearBottomRef.current) return

    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) {
        el.scrollTop = el.scrollHeight
      }
    })

    return () => cancelAnimationFrame(rafRef.current)
  }, [messages.length, streamingContent])

  // Scroll to bottom on chat change
  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [chatId])

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
  }, [visibleMessages.length, glassEnabled])

  return (
    <div className={styles.list} ref={scrollRef} onScroll={handleScroll} data-chat-scroll="true">
      {isGroupChat && <GroupChatMemberBar chatId={chatId} />}
      {hasMore && <div ref={sentinelRef} className={styles.sentinel} />}
      {loadingOlder && (
        <div className={styles.loadingOlder}>Loading older messages...</div>
      )}
      {visibleMessages.map((message, i) => (
        <MessageCard
          key={`${message.id}:${message.index_in_chat}`}
          message={message}
          chatId={chatId}
          depth={visibleMessages.length - 1 - i}
        />
      ))}

      {/* Group chat progress bar during nudge loop */}
      {isGroupChat && isNudgeLoopActive && <GroupChatProgressBar />}

      {/* Streaming message bubble — shows tokens as they arrive (only for new messages, not regeneration) */}
      {isStreaming && !regeneratingMessageId && (streamDisplay || !streamingError) && (() => {
        const bubbleName = isImpersonateStream ? userName : streamDisplayName
        const bubbleStyleClass = isImpersonateStream ? bubbleStyles.user : bubbleStyles.character
        const nameStyleClass = isImpersonateStream ? bubbleStyles.nameUser : bubbleStyles.nameChar
        return (
          <div className={`${bubbleStyles.card} ${bubbleStyleClass} ${bubbleStyles.streaming}`} data-in-viewport>
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
                  isStreaming
                  variant="bubble"
                  align={isImpersonateStream ? 'right' : undefined}
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
