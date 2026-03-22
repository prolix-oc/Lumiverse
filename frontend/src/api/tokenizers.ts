import { get, post, put, del } from './client'

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

export const tokenizersApi = {
  // Configs
  list() {
    return get<TokenizerConfig[]>('/tokenizers')
  },
  create(input: { name: string; type: string; config?: Record<string, any> }) {
    return post<TokenizerConfig>('/tokenizers', input)
  },
  update(id: string, input: Partial<{ name: string; type: string; config: Record<string, any> }>) {
    return put<TokenizerConfig>(`/tokenizers/${id}`, input)
  },
  remove(id: string) {
    return del<{ deleted: boolean }>(`/tokenizers/${id}`)
  },
  test(tokenizerId: string, text: string) {
    return post<TokenizerTestResult>('/tokenizers/test', { tokenizer_id: tokenizerId, text })
  },

  // Patterns
  listPatterns() {
    return get<TokenizerModelPattern[]>('/tokenizers/patterns')
  },
  createPattern(input: { tokenizer_id: string; pattern: string; priority?: number }) {
    return post<TokenizerModelPattern>('/tokenizers/patterns', input)
  },
  updatePattern(id: string, input: Partial<{ tokenizer_id: string; pattern: string; priority: number }>) {
    return put<TokenizerModelPattern>(`/tokenizers/patterns/${id}`, input)
  },
  removePattern(id: string) {
    return del<{ deleted: boolean }>(`/tokenizers/patterns/${id}`)
  },
  testPattern(modelId: string) {
    return post<PatternTestResult>('/tokenizers/patterns/test', { model_id: modelId })
  },
}
