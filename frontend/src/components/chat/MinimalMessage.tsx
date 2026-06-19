import { useCallback, useMemo } from 'react'
import { useMessageCard } from '@/hooks/useMessageCard'
import { useComponentOverride } from '@/hooks/useComponentOverride'
import MinimalMessageDefault, { type MinimalMessageDefaultProps } from './MinimalMessageDefault'
import MessageContent from './MessageContent'
import ReasoningBlock from './ReasoningBlock'
import MessageAttachments from './MessageAttachments'
import { useStore } from '@/store'
import { copyTextToClipboard } from '@/lib/clipboard'
import type { Message } from '@/types/api'
import type { MessageOverrideProps } from '@/lib/componentOverrides'
import styles from './MinimalMessage.module.css'

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
    isEditing, editContent, setEditContent, editReasoning, setEditReasoning, showReasoningEditor,
    isUser, isLastMessage, isActivelyStreaming, displayContent, reasoning, reasoningDuration, reasoningStartedAt,
    tokenCount, generationMetrics, avatarUrl, fullAvatarUrl, avatar, displayName, macroUserName, isHidden,
    handleEdit, handleSaveEdit, handleCancelEdit, handleDelete, handleToggleHidden, handleFork,
  } = useMessageCard(message, chatId)

  const openModal = useStore((s) => s.openModal)
  const bubbleUseFullAvatar = useStore((s) => s.bubbleUseFullAvatar ?? false)
  const displayAvatarUrl = bubbleUseFullAvatar && fullAvatarUrl ? fullAvatarUrl : avatarUrl
  const handlePromptBreakdown = useCallback(() => {
    openModal('promptItemizer', { messageId: message.id })
  }, [openModal, message.id])

  // ── Build the flattened override props contract ──
  const overrideProps: MessageOverrideProps = useMemo(() => ({
    message: {
      id: message.id,
      index: message.index_in_chat,
      sendDate: message.swipe_dates?.[message.swipe_id] ?? message.send_date,
      isUser,
      displayName,
      initial: (displayName || '').charAt(0).toUpperCase() || '?',
      avatarUrl,
      fullAvatarUrl,
      avatar,
      isHidden,
      isStreaming: isActivelyStreaming,
      isLastMessage,
      tokenCount: tokenCount ?? null,
    },
    content: {
      raw: displayContent,
    },
    reasoning: reasoning ? {
      raw: reasoning,
      duration: reasoningDuration ?? null,
      isStreaming: isActivelyStreaming,
    } : null,
    swipes: {
      current: message.swipe_id + 1,
      total: message.swipes.length,
    },
    attachments: (message.extra?.attachments || []).map((a: any) => ({
      type: a.type,
      imageId: a.image_id,
      mimeType: a.mime_type,
      filename: a.original_filename,
    })),
    editing: Object.freeze({
      active: isEditing,
      content: editContent,
      reasoning: editReasoning,
      setContent: setEditContent,
      setReasoning: setEditReasoning,
      save: handleSaveEdit,
      cancel: handleCancelEdit,
    }),
    actions: Object.freeze({
      copy: () => copyTextToClipboard(message.content).catch(console.error),
      edit: handleEdit,
      delete: handleDelete,
      toggleHidden: handleToggleHidden,
      fork: handleFork,
      promptBreakdown: handlePromptBreakdown,
      swipeLeft: () => {},
      swipeRight: () => {},
    }),
    styles,
  }), [
    message, isUser, displayName, avatarUrl, fullAvatarUrl, displayAvatarUrl, avatar, isHidden, isActivelyStreaming,
    isLastMessage, tokenCount, displayContent, reasoning, reasoningDuration,
    isEditing, editContent, editReasoning, setEditContent, setEditReasoning,
    handleSaveEdit, handleCancelEdit, handleEdit, handleDelete, handleToggleHidden,
    handleFork, handlePromptBreakdown,
  ])

  // ── Host slots: trusted built-in elements an override renders via <Content />,
  //    <Reasoning /> and <Attachments /> tags (full markdown, code highlighting,
  //    macros and interactivity — identical to the default renderer). ──
  const attachments = message.extra?.attachments
  const hostSlots = useMemo(() => ({
    Content: (
      <MessageContent
        content={displayContent}
        isUser={isUser}
        userName={macroUserName}
        isStreaming={isActivelyStreaming}
        messageId={message.id}
        chatId={chatId}
        depth={depth}
      />
    ),
    Reasoning: reasoning ? (
      <ReasoningBlock
        reasoning={reasoning}
        reasoningDuration={reasoningDuration}
        reasoningStartedAt={reasoningStartedAt}
        isStreaming={isActivelyStreaming}
      />
    ) : null,
    Attachments: attachments && attachments.length > 0 ? (
      <MessageAttachments attachments={attachments} isUser={isUser} chatId={chatId} messageId={message.id} />
    ) : null,
  }), [
    displayContent, isUser, macroUserName, isActivelyStreaming, message.id, chatId, depth,
    reasoning, reasoningDuration, reasoningStartedAt, attachments,
  ])

  // ── Default props for the built-in renderer ──
  const defaultProps: MinimalMessageDefaultProps = {
    message, chatId, depth, isSelectMode, isSelected, onToggleSelect,
    isEditing, editContent, setEditContent, editReasoning, setEditReasoning, showReasoningEditor,
    isUser, isActivelyStreaming, displayContent, reasoning, reasoningDuration, reasoningStartedAt,
    tokenCount, generationMetrics, avatarUrl, fullAvatarUrl, displayAvatarUrl, displayName, macroUserName, isHidden,
    handleEdit, handleSaveEdit, handleCancelEdit, handleDelete, handleToggleHidden,
    handleFork, handlePromptBreakdown,
  }

  return useComponentOverride('MinimalMessage', MinimalMessageDefault, overrideProps, defaultProps, hostSlots)
}
