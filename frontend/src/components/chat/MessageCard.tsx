import { memo, useCallback } from 'react'
import { useStore } from '@/store'
import useIsMobile from '@/hooks/useIsMobile'
import BubbleMessage from './BubbleMessage'
import MinimalMessage from './MinimalMessage'
import type { Message } from '@/types/api'

interface MessageCardProps {
  message: Message
  chatId: string
  depth?: number
}

const MessageCard = memo(function MessageCard({ message, chatId, depth = 0 }: MessageCardProps) {
  const displayMode = useStore((s) => s.chatSheldDisplayMode)
  const messageSelectMode = useStore((s) => s.messageSelectMode)
  const selectedMessageIds = useStore((s) => s.selectedMessageIds)
  const toggleMessageSelect = useStore((s) => s.toggleMessageSelect)
  const selectMessageRange = useStore((s) => s.selectMessageRange)
  const isMobile = useIsMobile()

  const isSelected = messageSelectMode && selectedMessageIds.includes(message.id)

  const handleSelectClick = useCallback((e: React.MouseEvent) => {
    if (!messageSelectMode) return

    const useRangeSelect = e.shiftKey || (isMobile && selectedMessageIds.length === 1 && !isSelected)
    if (useRangeSelect && selectedMessageIds.length > 0) {
      const lastSelected = selectedMessageIds[selectedMessageIds.length - 1]
      selectMessageRange(lastSelected, message.id)
    } else {
      toggleMessageSelect(message.id)
    }
  }, [messageSelectMode, message.id, selectedMessageIds, toggleMessageSelect, selectMessageRange, isMobile, isSelected])

  if (displayMode === 'bubble') {
    return (
      <BubbleMessage
        message={message}
        chatId={chatId}
        depth={depth}
        isSelectMode={messageSelectMode}
        isSelected={isSelected}
        onToggleSelect={handleSelectClick}
      />
    )
  }

  return (
    <MinimalMessage
      message={message}
      chatId={chatId}
      depth={depth}
      isSelectMode={messageSelectMode}
      isSelected={isSelected}
      onToggleSelect={handleSelectClick}
    />
  )
})

export default MessageCard
