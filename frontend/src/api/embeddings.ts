import { get, put, post, type RequestOptions } from './client'
import type { EmbeddingConfig, ChatMemorySettings, WorldBookReindexResult, ConnectionModelsResult, EmbeddingModelsPreviewInput } from '@/types/api'

/** Embedding operations can be slow (external API + vector DB writes). */
const LONG: RequestOptions = { timeout: 60_000 }

export const embeddingsApi = {
  getConfig() {
    return get<EmbeddingConfig>('/embeddings/config')
  },

  updateConfig(input: Partial<EmbeddingConfig> & { api_key?: string | null }) {
    return put<EmbeddingConfig>('/embeddings/config', input)
  },

  previewModels(input: EmbeddingModelsPreviewInput) {
    return post<ConnectionModelsResult>('/embeddings/models/preview', input)
  },

  testConfig(text?: string) {
    return post<{
      success: boolean
      dimension: number
      applied_dimensions: number
      config: EmbeddingConfig
    }>('/embeddings/test', { text }, LONG)
  },

  reindexWorldBook(bookId: string) {
    return post<WorldBookReindexResult>(
      `/embeddings/world-books/${encodeURIComponent(bookId)}/reindex`,
      {},
      LONG,
    )
  },

  forceReset() {
    return post<{ success: boolean; deleted: boolean; path: string }>(
      '/embeddings/force-reset',
      {},
      LONG,
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
      {},
      LONG,
    )
  },

  getHealth() {
    return get<VectorStoreHealth>('/embeddings/health')
  },

  optimize() {
    return post<{ success: boolean }>('/embeddings/optimize', {}, LONG)
  },
}

export interface VectorStoreHealth {
  exists: boolean
  rowCount: number
  vectorIndexReady: boolean
  scalarIndexReady: boolean
  ftsIndexReady: boolean
  unindexedRowEstimate: number
  lastIndexRebuildAt: number
  indexes: Array<{ name: string; type?: string }>
}
