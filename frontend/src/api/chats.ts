import { get, post, put, patch, del, upload } from './client'
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

  listGroupChats(params?: { characterIds?: string[] }) {
    return get<ChatSummary[]>('/chats/group-chats', params?.characterIds?.length
      ? { character_ids: params.characterIds.join(',') }
      : undefined)
  },

  get(id: string, params?: { messages?: boolean }) {
    return get<Chat>(`/chats/${id}`, params)
  },

  create(input: CreateChatInput) {
    return post<Chat>('/chats', input)
  },

  update(id: string, input: Partial<{ name: string; metadata: Record<string, any> }>) {
    return put<Chat>(`/chats/${id}`, input)
  },

  /**
   * Atomic partial merge of chat metadata. Use this for chat-scoped UI
   * controls (alternate field selector, world book attachments, author's
   * note, etc.) so concurrent server-side writers can't clobber the keys
   * the user just changed. Pass `null` for a key to delete it.
   */
  patchMetadata(id: string, partial: Record<string, any>) {
    return patch<Chat>(`/chats/${id}/metadata`, partial)
  },

  delete(id: string) {
    return del<void>(`/chats/${id}`)
  },

  createGroup(input: CreateGroupChatInput) {
    return post<Chat>('/chats/group', input)
  },

  convertToGroup(id: string) {
    return post<Chat>(`/chats/${id}/convert-to-group`, {})
  },

  muteCharacter(chatId: string, characterId: string) {
    return post<Chat>(`/chats/${chatId}/mute/${characterId}`, {})
  },

  unmuteCharacter(chatId: string, characterId: string) {
    return post<Chat>(`/chats/${chatId}/unmute/${characterId}`, {})
  },

  addMember(chatId: string, characterId: string, options?: { skip_greeting?: boolean; greeting_index?: number }) {
    return post<Chat>(`/chats/${chatId}/members/${characterId}`, options || {})
  },

  removeMember(chatId: string, characterId: string) {
    return del<void>(`/chats/${chatId}/members/${characterId}`)
  },

  reattributeUserMessages(chatId: string, personaId: string) {
    return post<{ success: true; updated: number; persona_id: string; persona_name: string }>(
      `/chats/${chatId}/reattribute-user-messages`,
      { persona_id: personaId }
    )
  },

  reattributeAll() {
    return post<{ success: true; chats_updated: number; messages_updated: number; message?: string }>(
      '/chats/reattribute-all'
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

  importFromSt(characterId: string, file: File) {
    const fd = new FormData()
    fd.append('character_id', characterId)
    fd.append('file', file)
    return upload<{ chat_id: string; name: string; message_count: number }>('/chats/import-st', fd)
  },

  importGroupFromSt(characterIds: string[], file: File, greetingCharacterId?: string) {
    const fd = new FormData()
    for (const characterId of characterIds) fd.append('character_ids', characterId)
    if (greetingCharacterId) fd.append('greeting_character_id', greetingCharacterId)
    fd.append('file', file)
    return upload<{ chat_id: string; name: string; message_count: number; speaker_name_fallback_count: number }>('/chats/import-st-group', fd)
  },
}

export const messagesApi = {
  list(chatId: string, params?: { limit?: number; offset?: number; tail?: boolean }) {
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

  bulkHide(chatId: string, messageIds: string[], hidden: boolean) {
    return post<{ success: true; updated: number; messages: Message[] }>(
      `/chats/${chatId}/messages/bulk-hide`,
      { message_ids: messageIds, hidden }
    )
  },

  bulkDelete(chatId: string, messageIds: string[]) {
    return post<{ success: true; deleted: number }>(
      `/chats/${chatId}/messages/bulk-delete`,
      { message_ids: messageIds }
    )
  },
}
