import MessageContent from '@/components/chat/MessageContent'
import { useEffect, useState } from 'react'
import { messagesApi } from '@/api/chats'
import type { Message } from '@/types/api'
import { useStore } from '@/store'
import { registerHostSurfaceRenderer } from './host-surface-registry'

export interface MessagePreviewProps {
  chatId: string
  messageId: string
  swipeIndex?: number
  start?: number
  end?: number
}

/** Render a canonical active-chat source range through the native display path. */
export function MessagePreview({ chatId, messageId, swipeIndex, start = 0, end }: MessagePreviewProps) {
  const activeChatId = useStore((state) => state.activeChatId)
  const messages = useStore((state) => state.messages)
  const personaName = useStore((state) => state.personas.find((persona) => persona.id === state.activePersonaId)?.name ?? 'User')
  const index = messages.findIndex((message) => message.id === messageId)
  const message = messages[index]
  const selectedSwipe = swipeIndex ?? message?.swipe_id ?? 0
  const storedSource = message?.swipes?.[selectedSwipe] ?? (selectedSwipe === message?.swipe_id ? message.content : undefined)
  const needsHydration = activeChatId === chatId && message?.chat_id === chatId && storedSource === undefined && selectedSwipe < message.swipes.length
  const [hydrated, setHydrated] = useState<{ reference: Message; value: Message | null } | null>(null)
  useEffect(() => {
    if (!needsHydration || !message) return
    let cancelled = false
    void messagesApi.get(chatId, messageId).then((value) => {
      if (!cancelled) setHydrated({ reference: message, value: value.id === messageId && value.chat_id === chatId ? value : null })
    }).catch(() => { if (!cancelled) setHydrated({ reference: message, value: null }) })
    return () => { cancelled = true }
  }, [needsHydration, message, chatId, messageId, selectedSwipe])
  if (activeChatId !== chatId || !message || message.chat_id !== chatId) return <p role="status">Message preview unavailable.</p>
  if (needsHydration && hydrated?.reference !== message) return <p role="status">Loading message preview...</p>
  const source = storedSource ?? (hydrated?.reference === message ? hydrated.value?.swipes[selectedSwipe] : undefined)
  if (typeof source !== 'string' || start > source.length || (end !== undefined && (end > source.length || end < start))) {
    return <p role="status">Message preview source is no longer available.</p>
  }
  return (
    <MessageContent
      key={`${chatId}:${messageId}:${selectedSwipe}:${start}:${end ?? ''}`}
      content={source.slice(start, end)}
      chatId={chatId}
      messageId={messageId}
      swipeIndex={selectedSwipe}
      presetContext={message.extra?.spindle_metadata?.preset_contexts?.[selectedSwipe]}
      isUser={message.is_user}
      userName={(message.is_user ? message.name : messages.slice(0, index).reverse().find((candidate) => candidate.is_user)?.name) || personaName}
      depth={messages.length - index - 1}
      readOnly
    />
  )
}

const unregisterRenderer = registerHostSurfaceRenderer('message_preview', (props) => <MessagePreview {...props as unknown as MessagePreviewProps} />)
if (import.meta.hot) import.meta.hot.dispose(unregisterRenderer)
