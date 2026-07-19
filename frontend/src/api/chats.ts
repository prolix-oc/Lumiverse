import { get, post, put, patch, del, upload, type RequestOptions } from './client'
import type {
  Chat, CreateChatInput, CreateGroupChatInput, RecentChat, Message,
  CreateMessageInput, UpdateMessageInput, PaginatedResult,
  GroupedRecentChat, ChatSummary, ChatTreeNode, ChatMessageSearchResult
} from '@/types/api'
import type { RegexActionEffect } from '@/types/regex'

/** Use the user's local date and time so automatically named chats are easy to distinguish. */
export function createTimestampedChatName(now = new Date()): string {
  return now.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}

export const chatsApi = {
  list(params?: { characterId?: string; limit?: number; offset?: number }) {
    return get<PaginatedResult<Chat>>('/chats', params)
  },

  listRecent(params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<RecentChat>>('/chats/recent', params)
  },

  listRecentGrouped(params?: {
    limit?: number
    offset?: number
    search?: string
    sort?: 'name' | 'recent' | 'created'
    direction?: 'asc' | 'desc'
  }) {
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
    return post<Chat>('/chats', {
      ...input,
      name: input.name?.trim() || createTimestampedChatName(),
    })
  },

  /**
   * Disposable character-less, persona-less chat for trying out the current
   * connection profile. Swept by deleteTemporary() when the user returns home.
   * Pass noPreset to test the model raw — generation skips preset blocks,
   * preset parameters, and the active/connection preset fallbacks.
   */
  createTemporary(opts?: { noPreset?: boolean }) {
    return post<Chat>('/chats/temporary', opts?.noPreset ? { no_preset: true } : {})
  },

  deleteTemporary() {
    return del<{ success: boolean; deleted: number }>('/chats/temporary')
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

  /**
   * Toggle one persona add-on for this chat. The server also records toggle
   * recency so competing avatar overrides resolve deterministically.
   */
  setPersonaAddonState(chatId: string, personaId: string, addonId: string, enabled: boolean) {
    return put<Chat>(`/chats/${chatId}/persona-addons/${personaId}/${addonId}`, { enabled })
  },

  delete(id: string) {
    return del<void>(`/chats/${id}`)
  },

  bulkDeleteChats(ids: string[]) {
    return post<{ deleted: string[]; count: number }>('/chats/bulk-delete', { ids })
  },

  exportChat(id: string) {
    return get<{ chat: Chat; messages: Message[] }>(`/chats/${id}/export`)
  },

  deleteCharacterChats(characterId: string) {
    return del<{ success: boolean; deleted: number }>(`/chats/character-chats/${characterId}`)
  },

  createGroup(input: CreateGroupChatInput) {
    return post<Chat>('/chats/group', {
      ...input,
      name: input.name?.trim() || createTimestampedChatName(),
    })
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

  setGroupMemberAlternateFields(chatId: string, characterId: string, selections: Record<string, string | null>) {
    return patch<Chat>(`/chats/${chatId}/members/${characterId}/alternate-fields`, { selections })
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

  branch(chatId: string, messageId: string, name?: string) {
    return post<Chat>(`/chats/${chatId}/branch`, {
      message_id: messageId,
      ...(name?.trim() ? { name: name.trim() } : {}),
    })
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
  list(chatId: string, params?: { limit?: number; offset?: number; tail?: boolean }, options?: RequestOptions) {
    return get<PaginatedResult<Message>>(`/chats/${chatId}/messages`, params, options)
  },

  search(chatId: string, query: string, options?: RequestOptions) {
    return get<ChatMessageSearchResult>(`/chats/${chatId}/messages/search`, { q: query }, options)
  },

  get(chatId: string, messageId: string) {
    return get<Message>(`/chats/${chatId}/messages/${messageId}`)
  },

  create(chatId: string, input: CreateMessageInput) {
    return post<Message>(`/chats/${chatId}/messages`, input)
  },

  claimRegexAction(chatId: string, messageId: string, input: {
    script_id: string
    action_id: string
    instance_id: string
  }) {
    return post<{
      message: Message
      usage: { script_id: string; action_id: string; used_at: number }
      effects?: RegexActionEffect[]
      forked_chat?: Chat
    }>(`/chats/${chatId}/messages/${messageId}/regex-action`, input)
  },

  claimRegexActions(chatId: string, selections: Array<{
    message_id: string
    script_id: string
    action_id: string
    instance_id: string
  }>) {
    return post<{
      messages: Message[]
      usages: Array<{ script_id: string; action_id: string; used_at: number }>
    }>(`/chats/${chatId}/messages/regex-actions/claim`, { selections })
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

  removeAttachment(chatId: string, messageId: string, imageId: string) {
    return del<Message>(`/chats/${chatId}/messages/${messageId}/attachments/${imageId}`)
  },
}
