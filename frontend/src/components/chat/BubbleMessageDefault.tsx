/**
 * Default BubbleMessage renderer — the original implementation extracted
 * so it can be used as a fallback when a user override crashes or is disabled.
 */
import MessageContent from './MessageContent'
import MessageEditArea from './MessageEditArea'
import MessageAttachments from './MessageAttachments'
import SwipeControls from './SwipeControls'
import GreetingNav from './GreetingNav'
import ReasoningBlock from './ReasoningBlock'
import StreamingIndicator from './StreamingIndicator'
import BubbleActions from './BubbleActions'
import LazyImage from '@/components/shared/LazyImage'
import { useStore } from '@/store'
import type { Message } from '@/types/api'
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

export default function BubbleMessageDefault({
  message, chatId, depth, isSelectMode, isSelected, onToggleSelect,
  isEditing, editContent, setEditContent, editReasoning, setEditReasoning, showReasoningEditor,
  isUser, isActivelyStreaming, displayContent, reasoning, reasoningDuration, reasoningStartedAt,
  tokenCount, avatarUrl, fullAvatarUrl, displayName, macroUserName, isHidden, userLeft,
  handleEdit, handleSaveEdit, handleCancelEdit, handleDelete, handleToggleHidden,
  handleFork, handlePromptBreakdown,
}: BubbleMessageDefaultProps) {
  const openFloatingAvatar = useStore((s) => s.openFloatingAvatar)

  return (
    <div
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
              <span className={styles.metaPill}>
                #{message.index_in_chat}
                <span className={styles.metaDot}>&middot;</span>
                {formatMetaDate(message.swipe_dates?.[message.swipe_id] ?? message.send_date)}
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
              </span>
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
