import { get, put, post } from './client'
import type { EmbeddingConfig, ChatMemorySettings, WorldBookReindexResult } from '@/types/api'

export const embeddingsApi = {
  getConfig() {
    return get<EmbeddingConfig>('/embeddings/config')
  },

  updateConfig(input: Partial<EmbeddingConfig> & { api_key?: string | null }) {
    return put<EmbeddingConfig>('/embeddings/config', input)
  },

  testConfig(text?: string) {
    return post<{
      success: boolean
      dimension: number
      applied_dimensions: number
      config: EmbeddingConfig
    }>('/embeddings/test', { text })
  },

  reindexWorldBook(bookId: string) {
    return post<WorldBookReindexResult>(
      `/embeddings/world-books/${encodeURIComponent(bookId)}/reindex`,
      {}
    )
  },

  forceReset() {
    return post<{ success: boolean; deleted: boolean; path: string }>(
      '/embeddings/force-reset',
      {}
    )
  },

  getChatMemorySettings() {
    return get<ChatMemorySettings>('/embeddings/chat-memory-settings')
  },

  updateChatMemorySettings(input: Partial<ChatMemorySettings>) {
    return put<ChatMemorySettings>('/embeddings/chat-memory-settings', input)
  },

  recompileChatMemory(chatId: string) {
    return post<{ success: boolean; totalChunks: number; vectorizedChunks: number; pendingChunks: number }>(
      `/embeddings/chats/${encodeURIComponent(chatId)}/recompile`,
      {}
    )
  },
}
