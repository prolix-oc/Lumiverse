import { get, put, post, type RequestOptions } from './client'
import type { EmbeddingConfig, ChatMemorySettings, WorldBookReindexResult, ConnectionModelsResult, EmbeddingModelsPreviewInput } from '@/types/api'
import {
  createProviderRegistryProjection,
  FRONTEND_PROVIDER_SCOPE,
  type ProviderRegistryChangedPayload,
  type ProviderRegistryEntry,
} from '@/ws/provider-registry-projection'

/** Embedding operations can be slow (external API + vector DB writes). */
const LONG: RequestOptions = { timeout: 60_000 }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const EMBEDDING_ERROR_CODES = {
  PROVIDER_UNAVAILABLE: 'embedding_provider_unavailable',
  FALLBACK_EXHAUSTED: 'embedding_fallback_exhausted',
} as const

export interface EmbeddingConnectionProfile {
  id: string
  provider: string
  model: string
  api_url: string
  dimensions: number | null
  enabled: boolean
  vertex_region?: string
  vertex_project?: string
  hasSecret?: boolean
}

export interface EmbeddingConfigWithProfiles extends EmbeddingConfig {
  connectionProfiles?: EmbeddingConnectionProfile[]
  primaryProfileId?: string | null
  fallbackProfileIds?: string[]
}

export function isUsableProfileId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id)
}

/** Store Connection fields needed to snapshot an embedding profile. */
export interface EmbeddingConnectionSource {
  id: string
  provider: string
  model?: string
  api_url?: string
  has_api_key?: boolean
  metadata?: Record<string, unknown> | null
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalPositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return null
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Ordered unique usable ids: primary first, then fallbacks. */
export function selectedEmbeddingProfileIds(cfg: {
  primaryProfileId?: string | null
  fallbackProfileIds?: string[] | null
}): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const push = (id: unknown) => {
    if (!isUsableProfileId(id) || seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  push(cfg.primaryProfileId)
  for (const id of cfg.fallbackProfileIds ?? []) push(id)
  return ids
}

/**
 * Project selected Connections into PUT-compatible embedding snapshots.
 * Prefers live store rows (id + provider/model/url/dims). Keeps a prior
 * snapshot only when that id is still selected but missing from the slice.
 */
export function projectConnectionProfiles(
  connections: EmbeddingConnectionSource[],
  selectedIds: string[],
  previous: EmbeddingConnectionProfile[] | null | undefined = [],
): EmbeddingConnectionProfile[] {
  const byId = new Map(connections.map((connection) => [connection.id, connection]))
  const prevById = new Map((previous ?? []).map((profile) => [profile.id, profile]))
  const snapshots: EmbeddingConnectionProfile[] = []
  const seen = new Set<string>()

  for (const id of selectedIds) {
    if (!isUsableProfileId(id) || seen.has(id)) continue
    const connection = byId.get(id)
    const prev = prevById.get(id)
    if (connection) {
      const meta = metadataRecord(connection.metadata)
      const snapshot: EmbeddingConnectionProfile = {
        id: connection.id,
        provider: connection.provider,
        model: connection.model ?? prev?.model ?? '',
        api_url: connection.api_url ?? prev?.api_url ?? '',
        dimensions: optionalPositiveInt(meta.dimensions) ?? prev?.dimensions ?? null,
        enabled: prev?.enabled ?? true,
      }
      const vertex_region = optionalTrimmedString(meta.vertex_region) ?? prev?.vertex_region
      const vertex_project = optionalTrimmedString(meta.vertex_project) ?? prev?.vertex_project
      if (vertex_region) snapshot.vertex_region = vertex_region
      if (vertex_project) snapshot.vertex_project = vertex_project
      snapshots.push(snapshot)
      seen.add(id)
      continue
    }
    if (prev) {
      snapshots.push({
        ...prev,
        enabled: prev.enabled ?? true,
      })
      seen.add(id)
    }
  }

  return snapshots
}

export function areProfileDimensionsCompatible(
  primary: Pick<EmbeddingConnectionProfile, 'dimensions'> | null | undefined,
  candidate: Pick<EmbeddingConnectionProfile, 'dimensions'>,
): boolean {
  if (!primary) return true
  if (primary.dimensions == null || candidate.dimensions == null) return true
  return primary.dimensions === candidate.dimensions
}

/** Ordered enabled profiles: primary first, then fallbacks. Skips dim mismatches. */
export function selectFallbackChain(cfg: {
  connectionProfiles?: EmbeddingConnectionProfile[] | null
  primaryProfileId?: string | null
  fallbackProfileIds?: string[] | null
}): EmbeddingConnectionProfile[] {
  const profiles = Array.isArray(cfg.connectionProfiles) ? cfg.connectionProfiles : []
  const byId = new Map(profiles.map((profile) => [profile.id, profile]))
  const chain: EmbeddingConnectionProfile[] = []
  const seen = new Set<string>()

  const push = (profile: EmbeddingConnectionProfile | undefined, requireCompatWith?: EmbeddingConnectionProfile) => {
    if (!profile || !profile.enabled || seen.has(profile.id)) return
    if (requireCompatWith && !areProfileDimensionsCompatible(requireCompatWith, profile)) return
    seen.add(profile.id)
    chain.push(profile)
  }

  const primary = (cfg.primaryProfileId && byId.get(cfg.primaryProfileId)) || profiles[0]
  push(primary)

  const fallbackIds = Array.isArray(cfg.fallbackProfileIds) ? cfg.fallbackProfileIds : []
  for (const id of fallbackIds) {
    push(byId.get(id), chain[0])
  }

  return chain
}

export function redactEmbeddingErrorMessage(message: string, secrets: Array<string | null | undefined> = []): string {
  let next = message.replace(/embedding-profile\/[^\s"'\\]+/gi, '[redacted]')
  for (const secret of secrets) {
    if (secret && secret.length > 0) next = next.split(secret).join('[redacted]')
  }
  return next.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
}

/** Build a PUT /config payload. Never includes secret refs or secret values unless typed. */
export function buildEmbeddingConfigUpdate(
  cfg: EmbeddingConfigWithProfiles,
  apiKeys: Record<string, string | undefined> = {},
): Partial<EmbeddingConfigWithProfiles> & { api_key?: string | null; connectionProfiles?: Array<EmbeddingConnectionProfile & { api_key?: string }> } {
  const connectionProfiles = (cfg.connectionProfiles ?? []).map((profile) => {
    const { hasSecret: _hasSecret, ...rest } = profile
    const api_key = apiKeys[profile.id]
    return api_key ? { ...rest, api_key } : rest
  })
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    api_url: cfg.api_url,
    model: cfg.model,
    dimensions: cfg.dimensions,
    send_dimensions: cfg.send_dimensions,
    retrieval_top_k: cfg.retrieval_top_k,
    hybrid_weight_mode: cfg.hybrid_weight_mode,
    preferred_context_size: cfg.preferred_context_size,
    batch_size: cfg.batch_size,
    similarity_threshold: cfg.similarity_threshold,
    rerank_cutoff: cfg.rerank_cutoff,
    vectorize_world_books: cfg.vectorize_world_books,
    vectorize_chat_messages: cfg.vectorize_chat_messages,
    vectorize_chat_documents: cfg.vectorize_chat_documents,
    chat_memory_mode: cfg.chat_memory_mode,
    request_timeout: cfg.request_timeout,
    connectionProfiles,
    primaryProfileId: cfg.primaryProfileId ?? null,
    fallbackProfileIds: cfg.fallbackProfileIds ?? [],
  }
}

export type EmbeddingDriverSource = 'builtin' | 'registry'
export type EmbeddingDriverStatus = 'ok' | 'unavailable' | 'timeout'

export interface EmbeddingDriverOption {
  id: string
  kind: 'embedding'
  name: string
  source: EmbeddingDriverSource
  status: EmbeddingDriverStatus
}

const BUILTIN_EMBEDDING_DRIVERS: EmbeddingDriverOption[] = [
  'openai-compatible',
  'openai',
  'openrouter',
  'electronhub',
  'bananabread',
  'nanogpt',
  'google_vertex',
].map((id) => ({ id, kind: 'embedding', name: id, source: 'builtin', status: 'ok' }))

const embeddingListeners = new Set<() => void>()
let embeddingProjection = createProviderRegistryProjection({
  authorizedUserId: 'local',
  authorizedScope: FRONTEND_PROVIDER_SCOPE,
})

function embeddingEntryDenied(entry: ProviderRegistryEntry): boolean {
  return entry.denied === true || entry.visible === false || entry.status === 'denied'
}

function embeddingEntryStatus(entry: ProviderRegistryEntry): EmbeddingDriverStatus {
  if (entry.status === 'timeout' || entry.availability === 'timeout') return 'timeout'
  if (entry.status === 'unavailable' || entry.availability === 'unavailable') return 'unavailable'
  return 'ok'
}

export function resetEmbeddingProviderProjection(userId = 'local'): void {
  embeddingProjection = createProviderRegistryProjection({
    authorizedUserId: userId,
    authorizedScope: FRONTEND_PROVIDER_SCOPE,
  })
}

export function applyEmbeddingProviderRegistryEvent(
  event: ProviderRegistryChangedPayload,
): 'applied' | 'queued' | 'ignored' {
  try {
    const result = embeddingProjection.applyEvent(event)
    if (result === 'applied') {
      for (const listener of embeddingListeners) listener()
    }
    return result
  } catch {
    return 'ignored'
  }
}

export function subscribeEmbeddingProviders(listener: () => void): () => void {
  embeddingListeners.add(listener)
  return () => { embeddingListeners.delete(listener) }
}

export function resolveEmbeddingProviderVisibility(entry: Pick<ProviderRegistryEntry, 'status' | 'availability'>): EmbeddingDriverStatus | null {
  if (entry.status === 'timeout' || entry.availability === 'timeout') return 'timeout'
  if (entry.status === 'unavailable' || entry.availability === 'unavailable') return 'unavailable'
  if (entry.status === 'ok' || entry.availability === 'ok') return 'ok'
  return null
}

/** Built-in embedding engines plus the live frontend registry projection. */
export function listEmbeddingDrivers(): EmbeddingDriverOption[] {
  const extras: EmbeddingDriverOption[] = []
  for (const entry of embeddingProjection.list()) {
    try {
      if (entry.kind != null && entry.kind !== 'embedding') continue
      if (embeddingEntryDenied(entry)) continue
      extras.push({
        id: entry.id,
        kind: 'embedding',
        name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
        source: 'registry',
        status: embeddingEntryStatus(entry),
      })
    } catch {
      // Isolated: one bad registry row cannot hide the built-ins.
    }
  }
  return [...BUILTIN_EMBEDDING_DRIVERS, ...extras]
}

export const embeddingsApi = {
  getConfig() {
    return get<EmbeddingConfigWithProfiles>('/embeddings/config')
  },

  providers() {
    return get<{ providers: EmbeddingDriverOption[] }>('/embeddings/providers')
  },

  updateConfig(input: Partial<EmbeddingConfigWithProfiles> & { api_key?: string | null }) {
    return put<EmbeddingConfigWithProfiles>('/embeddings/config', input)
  },

  previewModels(input: EmbeddingModelsPreviewInput) {
    return post<ConnectionModelsResult>('/embeddings/models/preview', input)
  },

  testConfig(text?: string) {
    return post<{
      success: boolean
      dimension: number
      applied_dimensions: number
      config: EmbeddingConfigWithProfiles
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
  connectTimeoutMs?: number
  requestTimeoutMs?: number
}

export interface MilvusHybridSearchConfig {
  candidateMultiplier?: number
  candidateCap?: number
}

export interface VectorStoreConfigStatus {
  provider: VectorStoreProviderId
  tuningProfile?: VectorStoreTuningProfile
  qdrant?: QdrantConnectionConfig
  milvus?: MilvusConnectionConfig
  milvusHybridSearch?: MilvusHybridSearchConfig
  managedByEnv: boolean
  qdrantHasApiKey: boolean
  milvusHasPassword: boolean
}

export interface UpdateVectorStoreConfigInput {
  provider?: VectorStoreProviderId
  tuningProfile?: VectorStoreTuningProfile
  qdrant?: Partial<QdrantConnectionConfig>
  milvus?: Partial<MilvusConnectionConfig>
  milvusHybridSearch?: Partial<MilvusHybridSearchConfig>
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
