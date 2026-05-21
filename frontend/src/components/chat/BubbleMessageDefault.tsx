/**
 * Default BubbleMessage renderer — the original implementation extracted
 * so it can be used as a fallback when a user override crashes or is disabled.
 */
import { useRef, useCallback, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Pencil, Trash2, EyeOff, Eye, BarChart3, Volume2, Square } from 'lucide-react'
import { IconGitFork } from '@tabler/icons-react'
import MessageContent from './MessageContent'
import MessageEditArea from './MessageEditArea'
import MessageAttachments from './MessageAttachments'
import SwipeControls from './SwipeControls'
import GreetingNav from './GreetingNav'
import ReasoningBlock from './ReasoningBlock'
import StreamingIndicator from './StreamingIndicator'
import BubbleActions from './BubbleActions'
import LazyImage from '@/components/shared/LazyImage'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import useSwipeAction from '@/hooks/useSwipeAction'
import useSwipeGesture from '@/hooks/useSwipeGesture'
import { useLongPress } from '@/hooks/useLongPress'
import { useMessagePlayback } from '@/hooks/useMessagePlayback'
import { copyTextToClipboard, getSelectionTextWithin } from '@/lib/clipboard'
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
  const hasGenerationDetails = !isUser && !!generationMetrics && (
    generationMetrics.ttft != null
    || generationMetrics.tps != null
    || !!generationMetrics.model
    || !!generationMetrics.provider
  )

  const handleMouseEnter = useCallback(() => {
    if (!hasGenerationDetails || !pillRef.current) return
    const rect = pillRef.current.getBoundingClientRect()
    setTooltipPos({ x: rect.left, y: rect.top })
  }, [hasGenerationDetails])

  const handleMouseLeave = useCallback(() => {
    setTooltipPos(null)
  }, [])

  return (
    <span
      ref={pillRef}
      className={styles.metaPill}
      onMouseEnter={hasGenerationDetails ? handleMouseEnter : undefined}
      onMouseLeave={hasGenerationDetails ? handleMouseLeave : undefined}
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
      {tooltipPos && hasGenerationDetails && createPortal(
        <span
          className={styles.metaPillTooltip}
          style={{ position: 'fixed', left: tooltipPos.x, top: tooltipPos.y - 6, transform: 'translateY(-100%)' }}
        >
          {generationMetrics!.model && (
            <span className={styles.tooltipRow}>
              <span className={styles.tooltipLabel}>Model</span>
              <span className={styles.tooltipValue}>{generationMetrics!.model}</span>
            </span>
          )}
          {generationMetrics!.provider && (
            <span className={styles.tooltipRow}>
              <span className={styles.tooltipLabel}>Provider</span>
              <span className={styles.tooltipValue}>{generationMetrics!.provider}</span>
            </span>
          )}
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
  const messageContextMenuEnabled = useStore((s) => s.messageContextMenuEnabled ?? true)
  const isHighlighted = useStore((s) => s.highlightedMessageId === message.id)
  const cardRef = useRef<HTMLDivElement>(null)
  const [contextMenuPos, setContextMenuPos] = useState<ContextMenuPos | null>(null)
  const { handleSwipe } = useSwipeAction(message, chatId)
  const onSwipeLeft = useCallback(() => handleSwipe('left'), [handleSwipe])
  const onSwipeRight = useCallback(() => handleSwipe('right'), [handleSwipe])
  const { canPlay, isPlaying, toggle: togglePlayback } = useMessagePlayback(message.id, message.content)
  const canOpenContextMenu = !isEditing && !isSelectMode && messageContextMenuEnabled

  const closeContextMenu = useCallback(() => setContextMenuPos(null), [])

  const contextAction = useCallback((action: () => void) => {
    closeContextMenu()
    action()
  }, [closeContextMenu])

  const handleCopy = useCallback(() => {
    const selected = getSelectionTextWithin(cardRef.current)
    copyTextToClipboard(selected || message.content).catch(console.error)
  }, [message.content])

  const longPress = useLongPress({
    onLongPress: (pos) => {
      if (canOpenContextMenu) setContextMenuPos(pos)
    },
  })

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!canOpenContextMenu) return
    longPress.onContextMenu(e)
  }, [canOpenContextMenu, longPress])

  const contextMenuItems: ContextMenuEntry[] = useMemo(() => [
    {
      key: 'copy',
      label: 'Copy',
      icon: <Copy size={14} />,
      onClick: () => contextAction(handleCopy),
    },
    {
      key: 'edit',
      label: 'Edit',
      icon: <Pencil size={14} />,
      onClick: () => contextAction(handleEdit),
    },
    ...(canPlay ? [{
      key: 'play',
      label: isPlaying ? 'Stop playback' : 'Play with TTS',
      icon: isPlaying ? <Square size={14} /> : <Volume2 size={14} />,
      onClick: () => contextAction(togglePlayback),
    }] satisfies ContextMenuEntry[] : []),
    {
      key: 'toggle-hidden',
      label: isHidden ? 'Unhide from AI context' : 'Hide from AI context',
      icon: isHidden ? <Eye size={14} /> : <EyeOff size={14} />,
      active: isHidden,
      onClick: () => contextAction(handleToggleHidden),
    },
    {
      key: 'fork',
      label: 'Fork chat here',
      icon: <IconGitFork size={14} />,
      onClick: () => contextAction(handleFork),
    },
    ...(!isUser ? [{
      key: 'prompt-breakdown',
      label: 'Prompt breakdown',
      icon: <BarChart3 size={14} />,
      onClick: () => contextAction(handlePromptBreakdown),
    }] satisfies ContextMenuEntry[] : []),
    { key: 'delete-divider', type: 'divider' },
    {
      key: 'delete',
      label: 'Delete',
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => contextAction(handleDelete),
    },
  ], [
    canPlay, contextAction, handleCopy, handleDelete, handleEdit, handleFork,
    handlePromptBreakdown, handleToggleHidden, isHidden, isPlaying, isUser,
    togglePlayback,
  ])

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
        isHighlighted && styles.highlight,
      )}
      data-component="BubbleMessage"
      data-part={isUser ? 'user' : isActivelyStreaming ? 'streaming' : 'character'}
      data-message-id={message.id}
      onClick={isSelectMode ? onToggleSelect : undefined}
      onContextMenu={handleContextMenu}
      onTouchStart={canOpenContextMenu ? longPress.onTouchStart : undefined}
      onTouchMove={canOpenContextMenu ? longPress.onTouchMove : undefined}
      onTouchEnd={canOpenContextMenu ? longPress.onTouchEnd : undefined}
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

        {!isUser && !isEditing && message.index_in_chat !== 0 && (
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
          onPlay={canPlay ? togglePlayback : undefined}
          isPlaying={isPlaying}
          isHidden={isHidden}
          content={message.content}
          className={styles.actionsPill}
        />
      )}

      <ContextMenu position={contextMenuPos} items={contextMenuItems} onClose={closeContextMenu} />
    </div>
  )
}
