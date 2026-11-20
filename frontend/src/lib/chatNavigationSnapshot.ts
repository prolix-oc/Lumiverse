import type { Chat, Message, PaginatedResult } from '@/types/api'
import { chatsApi, messagesApi } from '@/api/chats'

export interface ChatNavigationSnapshot {
  chat: Chat
  messagePage: Pick<PaginatedResult<Message>, 'data' | 'total'>
}

const snapshots = new Map<string, ChatNavigationSnapshot>()

/**
 * Stage an already-loaded chat so a route change can replace the active chat
 * atomically in its layout effect instead of painting an empty message list
 * while the normal chat-open requests are in flight.
 */
export function stageChatNavigationSnapshot(snapshot: ChatNavigationSnapshot): void {
  snapshots.set(snapshot.chat.id, snapshot)
}

export async function preloadChatNavigationSnapshot(chat: Chat, messageLimit: number): Promise<void> {
  const messagePage = await messagesApi.list(chat.id, { limit: messageLimit, tail: true })
  stageChatNavigationSnapshot({ chat, messagePage })
}

export async function preloadChatNavigationSnapshotById(chatId: string, messageLimit: number): Promise<void> {
  const [chat, messagePage] = await Promise.all([
    chatsApi.get(chatId, { messages: false }),
    messagesApi.list(chatId, { limit: messageLimit, tail: true }),
  ])
  stageChatNavigationSnapshot({ chat, messagePage })
}

/** Consume-once: the normal ChatView load remains authoritative after first paint. */
export function takeChatNavigationSnapshot(chatId: string): ChatNavigationSnapshot | null {
  const snapshot = snapshots.get(chatId) ?? null
  snapshots.delete(chatId)
  return snapshot
}

export function clearChatNavigationSnapshots(): void {
  snapshots.clear()
}
