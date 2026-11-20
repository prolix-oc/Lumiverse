import { wsClient } from './client'
import { sendRoomAction } from './relayClient'
import { EventType } from '@/types/ws-events'
import type { Message } from '@/types/api'

/** Socket submission alone is not proof that the host saved a peer's message. */
export function sendConfirmedRoomMessage(input: {
  chatId: string
  participantId: string
  content: string
  associativeRegexAppend: unknown[]
}, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const unsubscribers: Array<() => void> = []
    const finish = (error?: Error) => {
      clearTimeout(timer)
      for (const unsubscribe of unsubscribers) unsubscribe()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('room_message_unconfirmed')), timeoutMs)
    unsubscribers.push(
      wsClient.on(EventType.MESSAGE_SENT, (payload: { chatId: string; message: Message }) => {
        if (payload.chatId === input.chatId
          && payload.message?.is_user
          && payload.message.extra?.mp?.participantId === input.participantId
          && payload.message.content === input.content.trim()) finish()
      }),
      wsClient.on('ROOM_MESSAGE_REJECTED', () => finish(new Error('room_message_rejected'))),
    )
    try {
      sendRoomAction({
        type: 'room_message',
        content: input.content,
        associative_regex_append: input.associativeRegexAppend,
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error('room_message_unconfirmed'))
    }
  })
}
