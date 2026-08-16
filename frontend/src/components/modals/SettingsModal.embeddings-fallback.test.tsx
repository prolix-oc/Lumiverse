import { beforeEach, describe, expect, mock, test } from 'bun:test'

const get = mock((..._args: unknown[]) => Promise.resolve(undefined))
const put = mock((..._args: unknown[]) => Promise.resolve(undefined))
const post = mock((..._args: unknown[]) => Promise.resolve(undefined))

mock.module('@/api/client', () => ({
  del: mock(),
  get,
  post,
  put,
}))

const {
  buildEmbeddingConfigUpdate,
  embeddingsApi,
  isUsableProfileId,
  redactEmbeddingErrorMessage,
  selectFallbackChain,
} = await import('@/api/embeddings')

const PRIMARY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FALLBACK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const VERTEX_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function sampleConfig() {
  return {
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
        provider: 'openai',
        model: 'text-embedding-3-small',
        api_url: 'https://fallback.test/v1/embeddings',
        dimensions: 768,
        enabled: true,
        hasSecret: false,
      },
      {
        id: VERTEX_ID,
        provider: 'google_vertex',
        model: 'text-embedding-004',
        api_url: 'https://aiplatform.googleapis.com',
        dimensions: 1536,
        enabled: true,
        hasSecret: true,
        vertex_region: 'europe-west4',
        vertex_project: 'lv-embed',
      },
    ],
    primaryProfileId: PRIMARY_ID,
    fallbackProfileIds: [FALLBACK_ID, VERTEX_ID],
  }
}

describe('SettingsModal embeddings fallback helpers', () => {
  beforeEach(() => {
    get.mockClear()
    put.mockClear()
    post.mockClear()
  })

  test('settings region would save dedicated profiles and ordered fallback without secret refs', async () => {
    const cfg = sampleConfig()
    const payload = buildEmbeddingConfigUpdate(cfg, { [VERTEX_ID]: 'sa-json' })
    put.mockResolvedValueOnce({ ...cfg, ...payload })

    await embeddingsApi.updateConfig(payload)

    expect(put).toHaveBeenCalledTimes(1)
    const sent = put.mock.calls[0]?.[1] as ReturnType<typeof buildEmbeddingConfigUpdate>
    expect(put.mock.calls[0]?.[0]).toBe('/embeddings/config')
    expect(sent.primaryProfileId).toBe(PRIMARY_ID)
    expect(sent.fallbackProfileIds).toEqual([FALLBACK_ID, VERTEX_ID])
    expect(sent.connectionProfiles?.map((profile) => profile.provider)).toEqual([
      'openai-compatible',
      'openai',
      'google_vertex',
    ])
    expect(sent.connectionProfiles?.find((profile) => profile.id === VERTEX_ID)).toEqual(
      expect.objectContaining({
        vertex_region: 'europe-west4',
        vertex_project: 'lv-embed',
        api_key: 'sa-json',
      }),
    )
    expect(JSON.stringify(sent)).not.toContain('embedding-profile/')
    expect(JSON.stringify(sent)).not.toContain('hasSecret')
  })

  test('fallback picker skips incompatible dimensions and keeps Vertex as a valid next hop', () => {
    const chain = selectFallbackChain(sampleConfig())
    expect(chain.map((profile) => profile.id)).toEqual([PRIMARY_ID, VERTEX_ID])
    expect(chain[1]?.provider).toBe('google_vertex')
  })

  test('settings UI must not invent a literal default profile id', () => {
    expect(isUsableProfileId('default')).toBe(false)
    expect(isUsableProfileId(PRIMARY_ID)).toBe(true)
  })

  test('settings error banner redacts leaked provider secrets', () => {
    const shown = redactEmbeddingErrorMessage(
      'embedding_fallback_exhausted: Bearer secret-token embedding-profile/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/apiKey',
      ['secret-token'],
    )
    expect(shown).not.toContain('secret-token')
    expect(shown).not.toContain('embedding-profile/')
  })
})
