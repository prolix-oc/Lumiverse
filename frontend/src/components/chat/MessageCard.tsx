import { memo } from 'react'
import { useStore } from '@/store'
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

  if (displayMode === 'bubble') {
    return <BubbleMessage message={message} chatId={chatId} depth={depth} />
  }

  return <MinimalMessage message={message} chatId={chatId} depth={depth} />
})

export default MessageCard
