import { beforeEach, describe, expect, mock, test } from 'bun:test'

const get = mock((..._args: unknown[]) => Promise.resolve(undefined))
const put = mock((..._args: unknown[]) => Promise.resolve(undefined))
const post = mock((..._args: unknown[]) => Promise.resolve(undefined))

mock.module('./client', () => ({
  del: mock(),
  get,
  post,
  put,
}))

const {
  EMBEDDING_ERROR_CODES,
  areProfileDimensionsCompatible,
  buildEmbeddingConfigUpdate,
  embeddingsApi,
  isUsableProfileId,
  redactEmbeddingErrorMessage,
  selectFallbackChain,
} = await import('./embeddings')

const PRIMARY_ID = '11111111-1111-4111-8111-111111111111'
const FALLBACK_ID = '22222222-2222-4222-8222-222222222222'
const INCOMPAT_ID = '33333333-3333-4333-8333-333333333333'

const cfg = {
  enabled: true,
  provider: 'openai-compatible' as const,
  api_url: 'https://primary.test/v1/embeddings',
  model: 'text-embedding-3-small',
  dimensions: 1536,
  send_dimensions: false,
  retrieval_top_k: 4,
  hybrid_weight_mode: 'balanced' as const,
  preferred_context_size: 6,
  batch_size: 50,
  similarity_threshold: 0,
  rerank_cutoff: 0,
  vectorize_world_books: true,
  vectorize_chat_messages: false,
  vectorize_chat_documents: true,
  chat_memory_mode: 'balanced' as const,
  request_timeout: 120,
  has_api_key: true,
  connectionProfiles: [
    {
      id: PRIMARY_ID,
      provider: 'openai-compatible',
      model: 'text-embedding-3-small',
      api_url: 'https://primary.test/v1/embeddings',
      dimensions: 1536,
      enabled: true,
      hasSecret: true,
    },
    {
      id: FALLBACK_ID,
      provider: 'future-vendor',
      model: 'embed-x',
      api_url: 'https://fallback.test/v1/embeddings',
      dimensions: 1536,
      enabled: true,
      hasSecret: false,
      vertex_region: 'us-central1',
      vertex_project: 'proj',
    },
    {
      id: INCOMPAT_ID,
      provider: 'openai',
      model: 'other',
      api_url: 'https://other.test/v1/embeddings',
      dimensions: 768,
      enabled: true,
      hasSecret: false,
    },
  ],
  primaryProfileId: PRIMARY_ID,
  fallbackProfileIds: [INCOMPAT_ID, FALLBACK_ID],
}

describe('embeddings API connection profiles', () => {
  beforeEach(() => {
    get.mockClear()
    put.mockClear()
    post.mockClear()
  })

  test('getConfig and updateConfig use the embeddings config routes', async () => {
    get.mockResolvedValueOnce(cfg)
    put.mockResolvedValueOnce(cfg)

    await expect(embeddingsApi.getConfig()).resolves.toEqual(cfg)
    expect(get).toHaveBeenCalledWith('/embeddings/config')

    const payload = buildEmbeddingConfigUpdate(cfg, { [PRIMARY_ID]: 'sk-new' })
    await embeddingsApi.updateConfig(payload)
    expect(put).toHaveBeenCalledWith('/embeddings/config', payload)
    expect(JSON.stringify(payload)).not.toContain('embedding-profile/')
    expect(JSON.stringify(payload)).not.toContain('hasSecret')
    expect(payload.connectionProfiles?.[0]).toEqual(expect.objectContaining({
      id: PRIMARY_ID,
      api_key: 'sk-new',
    }))
  })

  test('selectFallbackChain preserves unknown providers and skips incompatible dimensions', () => {
    const chain = selectFallbackChain(cfg)
    expect(chain.map((profile) => profile.id)).toEqual([PRIMARY_ID, FALLBACK_ID])
    expect(chain[1]?.provider).toBe('future-vendor')
    expect(areProfileDimensionsCompatible({ dimensions: 1536 }, { dimensions: 768 })).toBe(false)
  })

  test('rejects a literal default profile id', () => {
    expect(isUsableProfileId('default')).toBe(false)
    expect(isUsableProfileId(PRIMARY_ID)).toBe(true)
  })

  test('redacts secret refs from fallback error copy', () => {
    const message = redactEmbeddingErrorMessage(
      'failed Bearer sk-live at embedding-profile/11111111-1111-4111-8111-111111111111/apiKey',
      ['sk-live'],
    )
    expect(message).not.toContain('sk-live')
    expect(message).not.toContain('embedding-profile/')
    expect(message).toContain('[redacted]')
    expect(EMBEDDING_ERROR_CODES.PROVIDER_UNAVAILABLE).toBe('embedding_provider_unavailable')
    expect(EMBEDDING_ERROR_CODES.FALLBACK_EXHAUSTED).toBe('embedding_fallback_exhausted')
  })
})
