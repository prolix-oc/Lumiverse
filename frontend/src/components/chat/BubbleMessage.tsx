import { useMessageCard } from '@/hooks/useMessageCard'
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

interface BubbleMessageProps {
  message: Message
  chatId: string
}

function formatMetaDate(timestamp: number) {
  const d = new Date(timestamp * 1000)
  const month = d.toLocaleString('en-US', { month: 'short' })
  const day = d.getDate()
  const time = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  return `${month} ${day}, ${time}`
}

export default function BubbleMessage({ message, chatId }: BubbleMessageProps) {
  const bubbleUserAlign = useStore((s) => s.bubbleUserAlign)
  const {
    isEditing,
    editContent,
    setEditContent,
    editReasoning,
    setEditReasoning,
    showReasoningEditor,
    isUser,
    isLastMessage,
    isActivelyStreaming,
    displayContent,
    reasoning,
    reasoningDuration,
    tokenCount,
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
  const userLeft = isUser && bubbleUserAlign === 'left'

  return (
    <div
      className={clsx(
        styles.card,
        isUser ? styles.user : styles.character,
        userLeft && styles.userLeft,
        isActivelyStreaming && styles.streaming,
        isHidden && styles.hidden,
      )}
      data-message-id={message.id}
    >
      {/* Dissolving avatar background */}
      {avatarUrl && (
        <div className={styles.avatarBg}>
          <img className={styles.avatarBgImg} src={avatarUrl} alt="" />
          <div className={styles.avatarBgScrim} />
        </div>
      )}

      <div className={styles.bubble}>
        {/* Header — avatar + name + meta pill */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.avatar}>
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
                {formatMetaDate(message.send_date)}
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

        {/* Reasoning block — hidden during editing since the edit area shows it inline */}
        {reasoning && !isEditing && (
          <ReasoningBlock
            reasoning={reasoning}
            reasoningDuration={reasoningDuration}
            isStreaming={isActivelyStreaming}
            variant="bubble"
            align={isUser && !userLeft ? 'right' : undefined}
          />
        )}

        {/* Inline attachments — before content for assistant, after for user */}
        {!isUser && message.extra?.attachments && message.extra.attachments.length > 0 && !isEditing && (
          <div className={styles.content}>
            <MessageAttachments attachments={message.extra.attachments} isUser={false} />
          </div>
        )}

        {/* Content */}
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
            />
          ) : isActivelyStreaming ? (
            <StreamingIndicator />
          ) : null}
        </div>

        {/* User attachments render after content so they sit below text on mobile */}
        {isUser && message.extra?.attachments && message.extra.attachments.length > 0 && !isEditing && (
          <div className={styles.content}>
            <MessageAttachments attachments={message.extra.attachments} isUser={true} />
          </div>
        )}

        {/* Swipe controls — always show on assistant messages for navigation */}
        {!isUser && !isEditing && (
          <SwipeControls message={message} chatId={chatId} variant="bubble" />
        )}

        {/* Greeting navigator for first message */}
        {message.index_in_chat === 0 && !isUser && !isEditing && (
          <GreetingNav message={message} chatId={chatId} variant="bubble" />
        )}
      </div>

      {/* Actions — inline pill for bubble mode */}
      {!isEditing && (
        <BubbleActions
          onEdit={handleEdit}
          onDelete={handleDelete}
          onToggleHidden={handleToggleHidden}
          onFork={handleFork}
          isHidden={isHidden}
          content={message.content}
          className={styles.actionsPill}
        />
      )}
    </div>
  )
}
