import { get, post, put, del } from './client'
import type {
  Chat, CreateChatInput, CreateGroupChatInput, RecentChat, Message,
  CreateMessageInput, UpdateMessageInput, PaginatedResult,
  GroupedRecentChat, ChatSummary, ChatTreeNode
} from '@/types/api'

export const chatsApi = {
  list(params?: { characterId?: string; limit?: number; offset?: number }) {
    return get<PaginatedResult<Chat>>('/chats', params)
  },

  listRecent(params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<RecentChat>>('/chats/recent', params)
  },

  listRecentGrouped(params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<GroupedRecentChat>>('/chats/recent-grouped', params)
  },

  listCharacterChats(characterId: string) {
    return get<ChatSummary[]>('/chats/character-chats/' + characterId)
  },

  get(id: string) {
    return get<Chat>(`/chats/${id}`)
  },

  create(input: CreateChatInput) {
    return post<Chat>('/chats', input)
  },

  update(id: string, input: Partial<{ name: string; metadata: Record<string, any> }>) {
    return put<Chat>(`/chats/${id}`, input)
  },

  delete(id: string) {
    return del<void>(`/chats/${id}`)
  },

  createGroup(input: CreateGroupChatInput) {
    return post<Chat>('/chats/group', input)
  },

  reattributeUserMessages(chatId: string, personaId: string) {
    return post<{ success: true; updated: number; persona_id: string; persona_name: string }>(
      `/chats/${chatId}/reattribute-user-messages`,
      { persona_id: personaId }
    )
  },

  branch(chatId: string, messageId: string) {
    return post<Chat>(`/chats/${chatId}/branch`, { message_id: messageId })
  },

  getTree(chatId: string) {
    return get<ChatTreeNode>(`/chats/${chatId}/tree`)
  },

  importChat(characterId: string, exportData: { chat: any; messages: any[] }) {
    return post<{ chat_id: string; name: string; message_count: number }>('/chats/import', {
      character_id: characterId,
      chat: exportData.chat,
      messages: exportData.messages,
    })
  },
}

export const messagesApi = {
  list(chatId: string, params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<Message>>(`/chats/${chatId}/messages`, params)
  },

  get(chatId: string, messageId: string) {
    return get<Message>(`/chats/${chatId}/messages/${messageId}`)
  },

  create(chatId: string, input: CreateMessageInput) {
    return post<Message>(`/chats/${chatId}/messages`, input)
  },

  update(chatId: string, messageId: string, input: UpdateMessageInput) {
    return put<Message>(`/chats/${chatId}/messages/${messageId}`, input)
  },

  delete(chatId: string, messageId: string) {
    return del<void>(`/chats/${chatId}/messages/${messageId}`)
  },

  swipe(chatId: string, messageId: string, direction: 'left' | 'right') {
    return post<Message>(`/chats/${chatId}/messages/${messageId}/swipe`, { direction })
  },

  deleteSwipe(chatId: string, messageId: string, swipeIdx: number) {
    return del<Message>(`/chats/${chatId}/messages/${messageId}/swipe/${swipeIdx}`)
  },
}
