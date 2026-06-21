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

  resetVectorStore() {
    return post<{ success: boolean; deleted: boolean; path: string }>(
      '/embeddings/force-reset',
      {},
      LONG,
    )
  },

  getVectorStoreConfig() {
    return get<VectorStoreConfigStatus>('/embeddings/vector-store/config')
  },

  updateVectorStoreConfig(input: UpdateVectorStoreConfigInput) {
    return put<VectorStoreConfigStatus>('/embeddings/vector-store/config', input)
  },

  testVectorStore(input: UpdateVectorStoreConfigInput) {
    return post<VectorStoreTestResult>('/embeddings/vector-store/test', input, LONG)
  },

  switchVectorStore(input: UpdateVectorStoreConfigInput) {
    return post<VectorStoreSwitchResult>('/embeddings/vector-store/switch', input, LONG)
  },
}

export type VectorStoreProviderId = 'lancedb' | 'qdrant' | 'milvus'
export type VectorStoreTuningProfile = 'balanced' | 'low_latency' | 'low_memory' | 'bulk_reindex'

export interface QdrantConnectionConfig {
  url: string
  https?: boolean
  collectionPrefix?: string
  checkCompatibility?: boolean
}

export interface MilvusConnectionConfig {
  address: string
  ssl?: boolean
  database?: string
  username?: string
  transport?: 'grpc' | 'http'
}

export interface VectorStoreConfigStatus {
  provider: VectorStoreProviderId
  tuningProfile?: VectorStoreTuningProfile
  qdrant?: QdrantConnectionConfig
  milvus?: MilvusConnectionConfig
  managedByEnv: boolean
  qdrantHasApiKey: boolean
  milvusHasPassword: boolean
}

export interface UpdateVectorStoreConfigInput {
  provider?: VectorStoreProviderId
  tuningProfile?: VectorStoreTuningProfile
  qdrant?: Partial<QdrantConnectionConfig>
  milvus?: Partial<MilvusConnectionConfig>
  qdrant_api_key?: string | null
  milvus_password?: string | null
}

export interface VectorStoreTestResult {
  ok: boolean
  provider: VectorStoreProviderId
  error?: string
}

export interface VectorStoreSwitchResult extends VectorStoreConfigStatus {
  reindexScheduled: boolean
}

export interface VectorStoreHealth {
  provider?: VectorStoreProviderId
  capabilities?: VectorStoreCapabilities
  exists: boolean
  rowCount: number
  vectorIndexReady: boolean
  scalarIndexReady: boolean
  ftsIndexReady: boolean
  unindexedRowEstimate: number
  lastIndexRebuildAt: number
  indexes: Array<{ name: string; type?: string }>
  tables?: Record<string, {
    exists: boolean
    rowCount: number
    vectorIndexReady: boolean
    scalarIndexReady: boolean
    ftsIndexReady: boolean
    unindexedRowEstimate: number
    lastIndexRebuildAt: number
    indexes: Array<{ name: string; type?: string }>
    dimension?: number | null
  }>
}

export interface VectorStoreCapabilities {
  nativeLexical: boolean
  requiresUuidIds: boolean
  requiresExplicitFlush: boolean
  requiresLoadBeforeQuery: boolean
  scoreKind: 'cosine_distance' | 'cosine_similarity'
  managesOwnIndexes: boolean
  externalService: boolean
  supportsOptimize: boolean
  dimensionLockedAtCreate: boolean
}
