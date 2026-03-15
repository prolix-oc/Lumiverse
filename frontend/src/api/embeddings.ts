import { get, put, post } from './client'
import type { EmbeddingConfig } from '@/types/api'

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
    return post<{ success: boolean; indexed: number; removed: number; total: number }>(
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
}
