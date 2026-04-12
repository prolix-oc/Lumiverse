import { useCallback, useRef, useState } from 'react'
import { useStore } from '@/store'
import { useMessageCard } from '@/hooks/useMessageCard'
import useSwipeAction from '@/hooks/useSwipeAction'
import useSwipeGesture from '@/hooks/useSwipeGesture'
import MessageContent from './MessageContent'
import MessageEditArea from './MessageEditArea'
import MessageAttachments from './MessageAttachments'
import MessageActions from './MessageActions'
import SwipeControls from './SwipeControls'
import GreetingNav from './GreetingNav'
import ReasoningBlock from './ReasoningBlock'
import StreamingIndicator from './StreamingIndicator'
import LazyImage from '@/components/shared/LazyImage'
import type { Message } from '@/types/api'
import type { GenerationMetrics } from '@/types/ws-events'
import styles from './MinimalMessage.module.css'
import clsx from 'clsx'

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

function MetaPill({ index, timestamp, tokenCount, isHidden, isUser, generationMetrics }: {
  index: number
  timestamp: number
  tokenCount: number | undefined
  isHidden: boolean
  isUser: boolean
  generationMetrics: GenerationMetrics | undefined
}) {
  const [showTooltip, setShowTooltip] = useState(false)
  const hasStreamingDetails = !isUser && generationMetrics?.wasStreaming && (generationMetrics.ttft != null || generationMetrics.tps != null)

  return (
    <span
      className={styles.metaPill}
      onMouseEnter={hasStreamingDetails ? () => setShowTooltip(true) : undefined}
      onMouseLeave={hasStreamingDetails ? () => setShowTooltip(false) : undefined}
    >
      #{index}
      <span className={styles.metaDot}>&middot;</span>
      {formatMetaDate(timestamp)}
      {tokenCount != null && (
        <>
          <span className={styles.metaDot}>&middot;</span>
          {tokenCount}t
        </>
      )}
      {isHidden && (
        <>
          <span className={styles.metaDot}>&middot;</span>
          <span className={styles.hiddenBadge}>Hidden</span>
        </>
      )}
      {showTooltip && hasStreamingDetails && (
        <span className={styles.metaPillTooltip}>
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
        </span>
      )}
    </span>
  )
}

interface MinimalMessageProps {
  message: Message
  chatId: string
  depth?: number
  isSelectMode?: boolean
  isSelected?: boolean
  onToggleSelect?: (e: React.MouseEvent) => void
}

export default function MinimalMessage({ message, chatId, depth = 0, isSelectMode = false, isSelected = false, onToggleSelect }: MinimalMessageProps) {
  const {
    isEditing,
    editContent,
    setEditContent,
    editReasoning,
    setEditReasoning,
    showReasoningEditor,
    isUser,
    isActivelyStreaming,
    displayContent,
    reasoning,
    reasoningDuration,
    reasoningStartedAt,
    tokenCount,
    generationMetrics,
    avatarUrl,
    fullAvatarUrl,
    displayName,
    macroUserName,
    isHidden,
    handleEdit,
    handleSaveEdit,
    handleCancelEdit,
    handleDelete,
    handleToggleHidden,
    handleFork,
  } = useMessageCard(message, chatId)

  const openModal = useStore((s) => s.openModal)
  const openFloatingAvatar = useStore((s) => s.openFloatingAvatar)
  const swipeGesturesEnabled = useStore((s) => s.swipeGesturesEnabled)
  const handlePromptBreakdown = useCallback(() => {
    openModal('promptItemizer', { messageId: message.id })
  }, [openModal, message.id])

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
      data-component="MinimalMessage"
      data-part={isUser ? 'user' : 'character'}
      className={clsx(
        styles.card,
        isUser ? styles.user : styles.character,
        isActivelyStreaming && styles.streaming,
        isHidden && styles.hidden,
        isSelectMode && isSelected && styles.selected,
        isSelectMode && styles.selectMode,
      )}
      data-message-id={message.id}
      onClick={isSelectMode ? onToggleSelect : undefined}
    >
      {/* Avatar */}
      <div
        className={styles.avatar}
        style={fullAvatarUrl ? { cursor: 'pointer' } : undefined}
        onClick={fullAvatarUrl ? (e) => { e.stopPropagation(); openFloatingAvatar(fullAvatarUrl, displayName) } : undefined}
      >
        <LazyImage
          src={avatarUrl}
          alt={displayName}
          fallback={
            <div className={styles.avatarFallback}>
              {displayName?.[0]?.toUpperCase() || '?'}
            </div>
          }
        />
      </div>

      <div className={styles.bubble}>
        {/* Name + meta pill */}
        <div className={styles.header}>
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
          />
        </div>

        {/* Reasoning block — hidden during editing since the edit area shows it inline */}
        {reasoning && !isEditing && (
          <ReasoningBlock
            reasoning={reasoning}
            reasoningDuration={reasoningDuration}
            reasoningStartedAt={reasoningStartedAt}
            isStreaming={isActivelyStreaming}
          />
        )}

        {/* Inline attachments — before content for assistant */}
        {!isUser && message.extra?.attachments && message.extra.attachments.length > 0 && !isEditing && (
          <MessageAttachments attachments={message.extra.attachments} isUser={false} />
        )}

        {/* Content */}
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

        {/* User attachments render after content */}
        {isUser && message.extra?.attachments && message.extra.attachments.length > 0 && !isEditing && (
          <MessageAttachments attachments={message.extra.attachments} isUser={true} />
        )}

        {/* Swipe controls — always show on assistant messages for navigation */}
        {!isUser && !isEditing && (
          <SwipeControls message={message} chatId={chatId} />
        )}

        {/* Greeting navigator for first message */}
        {message.index_in_chat === 0 && !isUser && !isEditing && (
          <GreetingNav message={message} chatId={chatId} />
        )}
      </div>

      {/* Actions (hidden in select mode) */}
      {!isEditing && !isSelectMode && (
        <div className={styles.actionsWrap}>
          <MessageActions
            onEdit={handleEdit}
            onDelete={handleDelete}
            onToggleHidden={handleToggleHidden}
            onFork={handleFork}
            onPromptBreakdown={!isUser ? handlePromptBreakdown : undefined}
            isUser={isUser}
            isHidden={isHidden}
            content={message.content}
          />
        </div>
      )}
    </div>
  )
}
