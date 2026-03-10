import { useCallback } from 'react'
import { useStore } from '@/store'
import { useMessageCard } from '@/hooks/useMessageCard'
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
import styles from './MinimalMessage.module.css'
import clsx from 'clsx'

interface MinimalMessageProps {
  message: Message
  chatId: string
}

export default function MinimalMessage({ message, chatId }: MinimalMessageProps) {
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
    avatarUrl,
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
  const handlePromptBreakdown = useCallback(() => {
    openModal('promptItemizer', { messageId: message.id })
  }, [openModal, message.id])

  return (
    <div
      className={clsx(
        styles.card,
        isUser ? styles.user : styles.character,
        isActivelyStreaming && styles.streaming,
        isHidden && styles.hidden,
      )}
      data-message-id={message.id}
    >
      {/* Avatar */}
      <div className={styles.avatar}>
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
        {/* Name */}
        <div className={styles.header}>
          <span className={clsx(styles.name, isUser ? styles.nameUser : styles.nameChar)}>
            {displayName}
          </span>
        </div>

        {/* Reasoning block — hidden during editing since the edit area shows it inline */}
        {reasoning && !isEditing && (
          <ReasoningBlock
            reasoning={reasoning}
            reasoningDuration={reasoningDuration}
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
          />
        ) : isActivelyStreaming ? (
          <StreamingIndicator />
        ) : null}

        {/* User attachments render after content */}
        {isUser && message.extra?.attachments && message.extra.attachments.length > 0 && !isEditing && (
          <MessageAttachments attachments={message.extra.attachments} isUser={true} />
        )}

        {/* Swipe controls */}
        {message.swipes && message.swipes.length > 1 && !isEditing && (
          <SwipeControls message={message} chatId={chatId} />
        )}

        {/* Greeting navigator for first message */}
        {message.index_in_chat === 0 && !isUser && !isEditing && (
          <GreetingNav message={message} chatId={chatId} />
        )}
      </div>

      {/* Actions */}
      {!isEditing && (
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
