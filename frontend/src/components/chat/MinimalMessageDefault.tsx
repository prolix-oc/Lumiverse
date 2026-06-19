/**
 * Default MinimalMessage renderer — the original implementation extracted
 * so it can be used as a fallback when a user override crashes or is disabled.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { Copy, Pencil, Trash2, EyeOff, Eye, BarChart3, Volume2, Square } from 'lucide-react'
import { IconGitFork } from '@tabler/icons-react'
import { useStore } from '@/store'
import { useLongPress } from '@/hooks/useLongPress'
import { useMessagePlayback } from '@/hooks/useMessagePlayback'
import useSwipeAction from '@/hooks/useSwipeAction'
import useSwipeGesture from '@/hooks/useSwipeGesture'
import { copyTextToClipboard, getSelectionTextWithin } from '@/lib/clipboard'
import { replay as replaySpindleInjections } from '@/lib/spindle/dom-injection-registry'
import MessageContent from './MessageContent'
import MessageEditArea from './MessageEditArea'
import MessageAttachments from './MessageAttachments'
import MessageAudioSlot from './MessageAudioSlot'
import MessageActions from './MessageActions'
import SwipeControls from './SwipeControls'
import GreetingNav from './GreetingNav'
import ReasoningBlock from './ReasoningBlock'
import StreamingIndicator from './StreamingIndicator'
import LazyImage from '@/components/shared/LazyImage'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import type { Message } from '@/types/api'
import type { GenerationMetrics } from '@/types/ws-events'
import styles from './MinimalMessage.module.css'
import clsx from 'clsx'

export interface MinimalMessageDefaultProps {
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
  displayAvatarUrl: string | null
  displayName: string
  macroUserName: string
  isHidden: boolean
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
  const { t } = useTranslation('chat')
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
          <span className={styles.hiddenBadge}>{t('messageMeta.hidden')}</span>
        </span>
      )}
      {tooltipPos && hasGenerationDetails && createPortal(
        <span
          className={styles.metaPillTooltip}
          style={{ position: 'fixed', left: tooltipPos.x, top: tooltipPos.y - 6, transform: 'translateY(-100%)' }}
        >
          {generationMetrics!.model && (
            <span className={styles.tooltipRow}>
              <span className={styles.tooltipLabel}>{t('messageMeta.model')}</span>
              <span className={styles.tooltipValue}>{generationMetrics!.model}</span>
            </span>
          )}
          {generationMetrics!.provider && (
            <span className={styles.tooltipRow}>
              <span className={styles.tooltipLabel}>{t('messageMeta.provider')}</span>
              <span className={styles.tooltipValue}>{generationMetrics!.provider}</span>
            </span>
          )}
          {generationMetrics!.ttft != null && (
            <span className={styles.tooltipRow}>
              <span className={styles.tooltipLabel}>{t('messageMeta.firstToken')}</span>
              <span className={styles.tooltipValue}>{formatMs(generationMetrics!.ttft)}</span>
            </span>
          )}
          {generationMetrics!.tps != null && (
            <span className={styles.tooltipRow}>
              <span className={styles.tooltipLabel}>{t('messageMeta.speed')}</span>
              <span className={styles.tooltipValue}>{t('messageMeta.tokPerSec', { count: generationMetrics!.tps })}</span>
            </span>
          )}
        </span>,
        document.body
      )}
    </span>
  )
}

export default function MinimalMessageDefault({
  message, chatId, depth, isSelectMode, isSelected, onToggleSelect,
  isEditing, editContent, setEditContent, editReasoning, setEditReasoning, showReasoningEditor,
  isUser, isActivelyStreaming, displayContent, reasoning, reasoningDuration, reasoningStartedAt,
  tokenCount, generationMetrics, avatarUrl, fullAvatarUrl, displayAvatarUrl, displayName, macroUserName, isHidden,
  handleEdit, handleSaveEdit, handleCancelEdit, handleDelete, handleToggleHidden,
  handleFork, handlePromptBreakdown,
}: MinimalMessageDefaultProps) {
  const { t } = useTranslation('chat')
  const { t: tc } = useTranslation('common')
  const openFloatingAvatar = useStore((s) => s.openFloatingAvatar)
  const swipeGesturesEnabled = useStore((s) => s.swipeGesturesEnabled)
  const showMessageTokenCount = useStore((s) => s.showMessageTokenCount ?? true)
  const messageContextMenuEnabled = useStore((s) => s.messageContextMenuEnabled ?? true)
  // Keep a MessageAudioSlot wrapper mounted on every assistant bubble
  // when TTS is enabled, OR whenever an audio attachment already exists.
  // See BubbleMessageDefault for the full rationale.
  const ttsEnabled = useStore((s) => s.voiceSettings.ttsEnabled)
  // Audio is per-swipe: see BubbleMessageDefault for the full rationale.
  const audioAttachment = useMemo(() => {
    const attachments = message.extra?.attachments ?? []
    return attachments.find((a: any) =>
      a && a.type === 'audio' && (a.swipe_id === undefined || a.swipe_id === message.swipe_id),
    ) ?? null
  }, [message.extra?.attachments, message.swipe_id])
  const renderAudioSlot = !isEditing && (ttsEnabled || !!audioAttachment) && !message.is_user
  const isHighlighted = useStore((s) => s.highlightedMessageId === message.id)

  const cardRef = useRef<HTMLDivElement>(null)

  // Replay any Spindle extension DOM that was registered against this
  // message id but lost when the chat virtualizer unmounted the row. See
  // dom-injection-registry.ts for the full mechanism. useLayoutEffect so
  // the injection lands in the same paint as the bubble's mount.
  useLayoutEffect(() => {
    if (!cardRef.current) return
    replaySpindleInjections(message.id, cardRef.current)
  }, [message.id])

  const [contextMenuPos, setContextMenuPos] = useState<ContextMenuPos | null>(null)
  const { handleSwipe } = useSwipeAction(message, chatId)
  const onSwipeLeft = useCallback(() => handleSwipe('left'), [handleSwipe])
  const onSwipeRight = useCallback(() => handleSwipe('right'), [handleSwipe])
  const {
    canPlay,
    isPlaying,
    hasSavedAudio,
    isGenerating,
    toggle: togglePlayback,
    regenModalOpen,
    confirmRegen,
    cancelRegen,
    requestDelete,
    deleteModalOpen,
    confirmDelete,
    cancelDelete,
  } = useMessagePlayback(message.id, message.content, message.name, message.is_user)
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
      label: tc('actions.copy'),
      icon: <Copy size={14} />,
      onClick: () => contextAction(handleCopy),
    },
    {
      key: 'edit',
      label: tc('actions.edit'),
      icon: <Pencil size={14} />,
      onClick: () => contextAction(handleEdit),
    },
    ...(canPlay ? [{
      key: 'play',
      label: isGenerating
        ? t('messageActions.cancelTtsGeneration')
        : isPlaying
          ? t('messageActions.stopPlayback')
          : hasSavedAudio
            ? t('messageActions.regenerateTtsAudio')
            : t('messageActions.playTts'),
      icon: (isGenerating || isPlaying) ? <Square size={14} /> : <Volume2 size={14} />,
      onClick: () => contextAction(togglePlayback),
    }] satisfies ContextMenuEntry[] : []),
    {
      key: 'toggle-hidden',
      label: isHidden ? t('messageActions.unhideFromAi') : t('messageActions.hideFromAi'),
      icon: isHidden ? <Eye size={14} /> : <EyeOff size={14} />,
      active: isHidden,
      onClick: () => contextAction(handleToggleHidden),
    },
    {
      key: 'fork',
      label: t('messageActions.fork'),
      icon: <IconGitFork size={14} />,
      onClick: () => contextAction(handleFork),
    },
    ...(!isUser ? [{
      key: 'prompt-breakdown',
      label: t('messageActions.promptBreakdown'),
      icon: <BarChart3 size={14} />,
      onClick: () => contextAction(handlePromptBreakdown),
    }] satisfies ContextMenuEntry[] : []),
    { key: 'delete-divider', type: 'divider' },
    {
      key: 'delete',
      label: tc('actions.delete'),
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => contextAction(handleDelete),
    },
  ], [
    canPlay, contextAction, handleCopy, handleDelete, handleEdit, handleFork,
    handlePromptBreakdown, handleToggleHidden, hasSavedAudio, isGenerating, isHidden, isPlaying, isUser,
    togglePlayback, t, tc,
  ])

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
        isHighlighted && styles.highlight,
      )}
      data-message-id={message.id}
      onClick={isSelectMode ? onToggleSelect : undefined}
      onContextMenu={handleContextMenu}
      onTouchStart={canOpenContextMenu ? longPress.onTouchStart : undefined}
      onTouchMove={canOpenContextMenu ? longPress.onTouchMove : undefined}
      onTouchEnd={canOpenContextMenu ? longPress.onTouchEnd : undefined}
    >
      {/* Avatar */}
      <div
        className={styles.avatar}
        style={fullAvatarUrl ? { cursor: 'pointer' } : undefined}
        onClick={fullAvatarUrl ? (e) => { e.stopPropagation(); openFloatingAvatar(fullAvatarUrl, displayName) } : undefined}
      >
        <LazyImage
          src={displayAvatarUrl}
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
            showTokenCount={showMessageTokenCount}
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

        {/* Inline image attachments — before content for assistant. */}
        {!isUser && message.extra?.attachments && message.extra.attachments.length > 0 && !isEditing && (
          <MessageAttachments attachments={message.extra.attachments} isUser={false} chatId={chatId} messageId={message.id} />
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
          <MessageAttachments attachments={message.extra.attachments} isUser={true} chatId={chatId} messageId={message.id} />
        )}

        {/* Audio slot — always-mounted when TTS is on (or audio exists)
            so its grid-template-rows: 0fr ↔ 1fr transition has somewhere
            to animate from. Renders zero-height when no audio, transitions
            smoothly when audio attaches/detaches. */}
        {renderAudioSlot && (
          <MessageAudioSlot
            audio={audioAttachment}
            messageId={message.id}
            isUser={isUser}
            onDelete={hasSavedAudio ? requestDelete : undefined}
          />
        )}

        {/* Swipe controls — assistant messages only, except the greeting (index 0),
            which uses the GreetingNav picker below instead. */}
        {!isUser && !isEditing && message.index_in_chat !== 0 && (
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
            onPlay={canPlay ? togglePlayback : undefined}
            isPlaying={isPlaying}
            isGenerating={isGenerating}
            hasSavedAudio={hasSavedAudio}
            isUser={isUser}
            isHidden={isHidden}
            content={message.content}
          />
        </div>
      )}

      <ContextMenu position={contextMenuPos} items={contextMenuItems} onClose={closeContextMenu} />

      <ConfirmationModal
        isOpen={regenModalOpen}
        onCancel={cancelRegen}
        onConfirm={confirmRegen}
        title="Regenerate TTS audio?"
        message="This will replace the saved audio attached to this message with a new TTS synthesis. The current recording will be deleted."
        confirmText="Regenerate"
        cancelText="Keep current"
        variant="warning"
      />

      <ConfirmationModal
        isOpen={deleteModalOpen}
        onCancel={cancelDelete}
        onConfirm={confirmDelete}
        title="Delete saved audio?"
        message="This removes the TTS recording attached to this message swipe. Other swipes' recordings are unaffected. You can always regenerate it later."
        confirmText="Delete"
        cancelText="Keep"
        variant="danger"
      />
    </div>
  )
}
