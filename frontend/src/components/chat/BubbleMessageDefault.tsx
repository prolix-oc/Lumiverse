/**
 * Default BubbleMessage renderer — the original implementation extracted
 * so it can be used as a fallback when a user override crashes or is disabled.
 */
import { useRef, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import MessageContent from './MessageContent'
import MessageEditArea from './MessageEditArea'
import MessageAttachments from './MessageAttachments'
import SwipeControls from './SwipeControls'
import GreetingNav from './GreetingNav'
import ReasoningBlock from './ReasoningBlock'
import StreamingIndicator from './StreamingIndicator'
import BubbleActions from './BubbleActions'
import LazyImage from '@/components/shared/LazyImage'
import useSwipeAction from '@/hooks/useSwipeAction'
import useSwipeGesture from '@/hooks/useSwipeGesture'
import { useStore } from '@/store'
import type { Message } from '@/types/api'
import type { GenerationMetrics } from '@/types/ws-events'
import styles from './BubbleMessage.module.css'
import clsx from 'clsx'

export interface BubbleMessageDefaultProps {
  message: Message
  chatId: string
  depth: number
  isSelectMode: boolean
  isSelected: boolean
  onToggleSelect?: (e: React.MouseEvent) => void
  // Pre-computed from useMessageCard
  isEditing: boolean
  editContent: string
  setEditContent: (s: string) => void
  editReasoning: string
  setEditReasoning: (s: string) => void
  showReasoningEditor: boolean
  isUser: boolean
  isActivelyStreaming: boolean
  displayContent: string
  reasoning: string | undefined
  reasoningDuration: number | undefined
  reasoningStartedAt: number | undefined
  tokenCount: number | undefined
  generationMetrics: GenerationMetrics | undefined
  avatarUrl: string | null
  fullAvatarUrl: string | null
  displayName: string
  macroUserName: string
  isHidden: boolean
  userLeft: boolean
  handleEdit: () => void
  handleSaveEdit: () => void
  handleCancelEdit: () => void
  handleDelete: () => void
  handleToggleHidden: () => void
  handleFork: () => void
  handlePromptBreakdown: () => void
}

function formatMetaDate(timestamp: number) {
  const d = new Date(timestamp * 1000)
  const month = d.toLocaleString('en-US', { month: 'short' })
  const day = d.getDate()
  const time = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  return `${month} ${day}, ${time}`
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function MetaPill({ index, timestamp, tokenCount, isHidden, isUser, generationMetrics, showTokenCount }: {
  index: number
  timestamp: number
  tokenCount: number | undefined
  isHidden: boolean
  isUser: boolean
  generationMetrics: GenerationMetrics | undefined
  showTokenCount: boolean
}) {
  const pillRef = useRef<HTMLSpanElement>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const hasStreamingDetails = !isUser && generationMetrics?.wasStreaming && (generationMetrics.ttft != null || generationMetrics.tps != null)

  const handleMouseEnter = useCallback(() => {
    if (!hasStreamingDetails || !pillRef.current) return
    const rect = pillRef.current.getBoundingClientRect()
    setTooltipPos({ x: rect.left, y: rect.top })
  }, [hasStreamingDetails])

  const handleMouseLeave = useCallback(() => {
    setTooltipPos(null)
  }, [])

  return (
    <span
      ref={pillRef}
      className={styles.metaPill}
      onMouseEnter={hasStreamingDetails ? handleMouseEnter : undefined}
      onMouseLeave={hasStreamingDetails ? handleMouseLeave : undefined}
    >
      <span className={styles.metaSegment}>#{index}</span>
      <span className={styles.metaSegment}>
        <span className={styles.metaDot}>&middot;</span>
        {formatMetaDate(timestamp)}
      </span>
      {showTokenCount && tokenCount != null && (
        <span className={styles.metaSegment}>
          <span className={styles.metaDot}>&middot;</span>
          {tokenCount}t
        </span>
      )}
      {isHidden && (
        <span className={styles.metaSegment}>
          <span className={styles.metaDot}>&middot;</span>
          <span className={styles.hiddenBadge}>Hidden</span>
        </span>
      )}
      {tooltipPos && hasStreamingDetails && createPortal(
        <span
          className={styles.metaPillTooltip}
          style={{ position: 'fixed', left: tooltipPos.x, top: tooltipPos.y - 6, transform: 'translateY(-100%)' }}
        >
          {generationMetrics!.ttft != null && (
            <span className={styles.tooltipRow}>
              <span className={styles.tooltipLabel}>First token</span>
              <span className={styles.tooltipValue}>{formatMs(generationMetrics!.ttft)}</span>
            </span>
          )}
          {generationMetrics!.tps != null && (
            <span className={styles.tooltipRow}>
              <span className={styles.tooltipLabel}>Speed</span>
              <span className={styles.tooltipValue}>{generationMetrics!.tps} tok/s</span>
            </span>
          )}
        </span>,
        document.body
      )}
    </span>
  )
}

export default function BubbleMessageDefault({
  message, chatId, depth, isSelectMode, isSelected, onToggleSelect,
  isEditing, editContent, setEditContent, editReasoning, setEditReasoning, showReasoningEditor,
  isUser, isActivelyStreaming, displayContent, reasoning, reasoningDuration, reasoningStartedAt,
  tokenCount, generationMetrics, avatarUrl, fullAvatarUrl, displayName, macroUserName, isHidden, userLeft,
  handleEdit, handleSaveEdit, handleCancelEdit, handleDelete, handleToggleHidden,
  handleFork, handlePromptBreakdown,
}: BubbleMessageDefaultProps) {
  const openFloatingAvatar = useStore((s) => s.openFloatingAvatar)
  const swipeGesturesEnabled = useStore((s) => s.swipeGesturesEnabled)
  const showMessageTokenCount = useStore((s) => s.showMessageTokenCount ?? true)
  const cardRef = useRef<HTMLDivElement>(null)
  const { handleSwipe } = useSwipeAction(message, chatId)
  const onSwipeLeft = useCallback(() => handleSwipe('left'), [handleSwipe])
  const onSwipeRight = useCallback(() => handleSwipe('right'), [handleSwipe])

  useSwipeGesture(cardRef, {
    enabled: swipeGesturesEnabled && !isUser && !isEditing && !isSelectMode,
    onSwipeLeft,
    onSwipeRight,
  })

  return (
    <div
      ref={cardRef}
      className={clsx(
        styles.card,
        isUser ? styles.user : styles.character,
        userLeft && styles.userLeft,
        isActivelyStreaming && styles.streaming,
        isHidden && styles.hidden,
        isSelectMode && isSelected && styles.selected,
        isSelectMode && styles.selectMode,
      )}
      data-component="BubbleMessage"
      data-part={isUser ? 'user' : isActivelyStreaming ? 'streaming' : 'character'}
      data-message-id={message.id}
      onClick={isSelectMode ? onToggleSelect : undefined}
    >
      {avatarUrl && (
        <div className={styles.avatarBg}>
          <img className={styles.avatarBgImg} src={avatarUrl} alt="" />
          <div className={styles.avatarBgScrim} />
        </div>
      )}

      <div className={styles.bubble}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div
              className={styles.avatar}
              style={fullAvatarUrl ? { cursor: 'pointer' } : undefined}
              onClick={fullAvatarUrl ? (e) => { e.stopPropagation(); openFloatingAvatar(fullAvatarUrl, displayName) } : undefined}
            >
              {avatarUrl ? (
                <LazyImage
                  src={avatarUrl}
                  alt={displayName}
                  fallback={
                    <div className={styles.avatarFallback}>
                      {displayName?.[0]?.toUpperCase() || '?'}
                    </div>
                  }
                />
              ) : (
                <div className={styles.avatarFallback}>
                  {displayName?.[0]?.toUpperCase() || '?'}
                </div>
              )}
            </div>
            <div className={styles.metaWrap}>
              <span className={clsx(styles.name, isUser ? styles.nameUser : styles.nameChar)}>
                {displayName}
              </span>
              <MetaPill
                index={message.index_in_chat}
                timestamp={message.swipe_dates?.[message.swipe_id] ?? message.send_date}
                tokenCount={tokenCount}
                isHidden={isHidden}
                isUser={isUser}
                generationMetrics={generationMetrics}
                showTokenCount={showMessageTokenCount}
              />
            </div>
          </div>
        </div>

        {reasoning && !isEditing && (
          <ReasoningBlock
            reasoning={reasoning}
            reasoningDuration={reasoningDuration}
            reasoningStartedAt={reasoningStartedAt}
            isStreaming={isActivelyStreaming}
            variant="bubble"
            align={isUser && !userLeft ? 'right' : undefined}
          />
        )}

        {!isUser && message.extra?.attachments && message.extra.attachments.length > 0 && !isEditing && (
          <div className={styles.content}>
            <MessageAttachments attachments={message.extra.attachments} isUser={false} />
          </div>
        )}

        <div className={styles.content}>
          {isEditing ? (
            <MessageEditArea
              editContent={editContent}
              onChangeContent={setEditContent}
              onSave={handleSaveEdit}
              onCancel={handleCancelEdit}
              editReasoning={showReasoningEditor ? editReasoning : undefined}
              onChangeReasoning={showReasoningEditor ? setEditReasoning : undefined}
            />
          ) : displayContent ? (
            <MessageContent
              content={displayContent}
              isUser={isUser}
              userName={macroUserName}
              isStreaming={isActivelyStreaming}
              messageId={message.id}
              chatId={chatId}
              depth={depth}
            />
          ) : isActivelyStreaming ? (
            <StreamingIndicator />
          ) : null}
        </div>

        {isUser && message.extra?.attachments && message.extra.attachments.length > 0 && !isEditing && (
          <div className={styles.content}>
            <MessageAttachments attachments={message.extra.attachments} isUser={true} />
          </div>
        )}

        {!isUser && !isEditing && (
          <SwipeControls message={message} chatId={chatId} variant="bubble" />
        )}

        {message.index_in_chat === 0 && !isUser && !isEditing && (
          <GreetingNav message={message} chatId={chatId} variant="bubble" />
        )}
      </div>

      {!isEditing && !isSelectMode && (
        <BubbleActions
          onEdit={handleEdit}
          onDelete={handleDelete}
          onToggleHidden={handleToggleHidden}
          onFork={handleFork}
          onPromptBreakdown={!isUser ? handlePromptBreakdown : undefined}
          isHidden={isHidden}
          content={message.content}
          className={styles.actionsPill}
        />
      )}
    </div>
  )
}
