import { get, post, put, del, type RequestOptions } from './client'

export interface TokenizerConfig {
  id: string
  name: string
  type: 'openai' | 'huggingface' | 'tiktoken' | 'approximate'
  config: Record<string, any>
  is_built_in: boolean
  created_at: number
  updated_at: number
}

export interface TokenizerModelPattern {
  id: string
  tokenizer_id: string
  pattern: string
  priority: number
  is_built_in: boolean
  created_at: number
  updated_at: number
}

export interface TokenizerTestResult {
  tokenizer_id: string
  tokenizer_name: string
  token_count: number
  char_count: number
  chars_per_token: number
}

export interface PatternTestResult {
  matched: boolean
  tokenizer_id: string | null
  tokenizer_name: string | null
}

// ---- Resolve-from-repo flow ----

export interface ResolvedFile {
  name: string
  url: string
  required: boolean
  present: boolean
}

export interface ResolvedTokenizerSuggestion {
  name: string
  type: TokenizerConfig['type']
  config: Record<string, any>
  pattern: string
  priority: number
}

export type ResolveTokenizerResult =
  | {
      ok: true
      repo: string
      revision: string
      sourceUrl: string
      type: TokenizerConfig['type']
      files: ResolvedFile[]
      suggested: ResolvedTokenizerSuggestion
      warnings: string[]
    }
  | {
      ok: false
      reason: 'unavailable' | 'unsupported' | 'invalid'
      message: string
      files?: ResolvedFile[]
    }

export interface InstallTokenizerInput {
  name: string
  type: string
  config?: Record<string, any>
  pattern?: { pattern: string; priority?: number }
}

/**
 * Parse a tokenizer config's HuggingFace `/resolve/<rev>/<file>` URLs into a
 * compact source description for display (repo, revision, file names). Returns
 * empty fields for package/openai/approximate configs that have no URLs.
 */
export interface HfSource {
  repo: string | null
  revision: string | null
  repoUrl: string | null
  files: string[]
}

export function parseHfSource(config: Record<string, any> | undefined | null): HfSource {
  const urls = [config?.url, config?.configUrl].filter((u): u is string => typeof u === 'string')
  let repo: string | null = null
  let revision: string | null = null
  let repoUrl: string | null = null
  const files: string[] = []
  for (const u of urls) {
    try {
      const parsed = new URL(u)
      const segs = parsed.pathname.split('/').filter(Boolean)
      const ri = segs.indexOf('resolve') // .../<owner>/<repo>/resolve/<rev>/<file...>
      if (ri >= 2) {
        if (!repo) {
          repo = `${segs[ri - 2]}/${segs[ri - 1]}`
          repoUrl = `${parsed.protocol}//${parsed.host}/${segs[ri - 2]}/${segs[ri - 1]}`
        }
        if (!revision && segs[ri + 1]) revision = segs[ri + 1]
        const fname = segs.slice(ri + 2).join('/')
        if (fname) files.push(fname)
      } else {
        files.push(segs[segs.length - 1] || u)
      }
    } catch {
      files.push(u)
    }
  }
  return { repo, revision, repoUrl, files }
}

export type TokenizersApiClient = {
  get: typeof get
  post: typeof post
  put: typeof put
  del: typeof del
}

const defaultTokenizersApiClient: TokenizersApiClient = { get, post, put, del }

export function createTokenizersApi(client: TokenizersApiClient = defaultTokenizersApiClient) {
  return {
    // Configs
    list() {
      return client.get<TokenizerConfig[]>('/tokenizers')
    },
    create(input: { name: string; type: string; config?: Record<string, any> }) {
      return client.post<TokenizerConfig>('/tokenizers', input)
    },
    // Inspect a pasted HuggingFace model URL / slug. Longer timeout than the 30s
    // default: the server downloads + verifies the tokenizer before responding.
    resolve(url: string) {
      return client.post<ResolveTokenizerResult>('/tokenizers/resolve', { url }, { timeout: 60_000 })
    },
    install(input: InstallTokenizerInput) {
      return client.post<{ config: TokenizerConfig; pattern: TokenizerModelPattern | null }>('/tokenizers/install', input)
    },

    // HuggingFace access token (write-only; server returns only a `configured` flag).
    getHfToken() {
      return client.get<{ configured: boolean }>('/tokenizers/hf-token')
    },
    setHfToken(token: string | null) {
      return client.put<{ configured: boolean }>('/tokenizers/hf-token', { token })
    },
    update(id: string, input: Partial<{ name: string; type: string; config: Record<string, any> }>) {
      return client.put<TokenizerConfig>(`/tokenizers/${id}`, input)
    },
    remove(id: string) {
      return client.del<{ deleted: boolean }>(`/tokenizers/${id}`)
    },
    test(tokenizerId: string, text: string) {
      return client.post<TokenizerTestResult>('/tokenizers/test', { tokenizer_id: tokenizerId, text })
    },
    countForModel(modelId: string, text: string, options?: RequestOptions) {
      return client.post<{ token_count: number | null; char_count: number }>(
        '/tokenizers/count',
        { model_id: modelId, text },
        options,
      )
    },
    countForModelBatch(modelId: string, texts: string[]) {
      return client.post<{ results: Array<{ token_count: number | null; char_count: number }> }>('/tokenizers/count-batch', {
        model_id: modelId,
        texts,
      })
    },

    // Patterns
    listPatterns() {
      return client.get<TokenizerModelPattern[]>('/tokenizers/patterns')
    },
    createPattern(input: { tokenizer_id: string; pattern: string; priority?: number }) {
      return client.post<TokenizerModelPattern>('/tokenizers/patterns', input)
    },
    updatePattern(id: string, input: Partial<{ tokenizer_id: string; pattern: string; priority: number }>) {
      return client.put<TokenizerModelPattern>(`/tokenizers/patterns/${id}`, input)
    },
    removePattern(id: string) {
      return client.del<{ deleted: boolean }>(`/tokenizers/patterns/${id}`)
    },
    testPattern(modelId: string) {
      return client.post<PatternTestResult>('/tokenizers/patterns/test', { model_id: modelId })
    },
  }
}

export const tokenizersApi = createTokenizersApi()
