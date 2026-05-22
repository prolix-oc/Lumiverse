import { useMessageCard } from '@/hooks/useMessageCard'
import { useComponentOverride } from '@/hooks/useComponentOverride'
import BubbleMessageDefault, { type BubbleMessageDefaultProps } from './BubbleMessageDefault'
import { useStore } from '@/store'
import { useCallback, useMemo } from 'react'
import type { Message } from '@/types/api'
import type { MessageOverrideProps } from '@/lib/componentOverrides'
import { copyTextToClipboard } from '@/lib/clipboard'
import styles from './BubbleMessage.module.css'

interface BubbleMessageProps {
  message: Message
  chatId: string
  depth?: number
  isSelectMode?: boolean
  isSelected?: boolean
  onToggleSelect?: (e: React.MouseEvent) => void
}

export default function BubbleMessage({ message, chatId, depth = 0, isSelectMode = false, isSelected = false, onToggleSelect }: BubbleMessageProps) {
  const bubbleUserAlign = useStore((s) => s.bubbleUserAlign)
  const {
    isEditing, editContent, setEditContent, editReasoning, setEditReasoning, showReasoningEditor,
    isUser, isLastMessage, isActivelyStreaming, displayContent, reasoning, reasoningDuration, reasoningStartedAt,
    tokenCount, generationMetrics, avatarUrl, fullAvatarUrl, displayName, macroUserName, isHidden,
    handleEdit, handleSaveEdit, handleCancelEdit, handleDelete, handleToggleHidden, handleFork,
  } = useMessageCard(message, chatId)

  const openModal = useStore((s) => s.openModal)
  const handlePromptBreakdown = useCallback(() => {
    openModal('promptItemizer', { messageId: message.id })
  }, [openModal, message.id])

  const userLeft = isUser && bubbleUserAlign === 'left'

  // ── Build the flattened override props contract ──
  const overrideProps: MessageOverrideProps = useMemo(() => ({
    message: {
      id: message.id,
      index: message.index_in_chat,
      sendDate: message.swipe_dates?.[message.swipe_id] ?? message.send_date,
      isUser,
      displayName,
      avatarUrl,
      isHidden,
      isStreaming: isActivelyStreaming,
      isLastMessage,
      tokenCount: tokenCount ?? null,
    },
    content: {
      raw: displayContent,
      html: '', // Will be populated by the override user via dangerouslySetInnerHTML if needed
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
    message, isUser, displayName, avatarUrl, isHidden, isActivelyStreaming,
    isLastMessage, tokenCount, displayContent, reasoning, reasoningDuration,
    isEditing, editContent, editReasoning, setEditContent, setEditReasoning,
    handleSaveEdit, handleCancelEdit, handleEdit, handleDelete, handleToggleHidden,
    handleFork, handlePromptBreakdown,
  ])

  // ── Default props for the built-in renderer ──
  const defaultProps: BubbleMessageDefaultProps = {
    message, chatId, depth, isSelectMode, isSelected, onToggleSelect,
    isEditing, editContent, setEditContent, editReasoning, setEditReasoning, showReasoningEditor,
    isUser, isActivelyStreaming, displayContent, reasoning, reasoningDuration, reasoningStartedAt,
    tokenCount, generationMetrics, avatarUrl, fullAvatarUrl, displayName, macroUserName, isHidden, userLeft,
    handleEdit, handleSaveEdit, handleCancelEdit, handleDelete, handleToggleHidden,
    handleFork, handlePromptBreakdown,
  }

  return useComponentOverride('BubbleMessage', BubbleMessageDefault, overrideProps, defaultProps)
}
