export type TokenizerType = 'openai' | 'huggingface' | 'tiktoken' | 'approximate';

export interface TokenizerConfig {
  id: string;
  name: string;
  type: TokenizerType;
  config: Record<string, any>;
  is_built_in: boolean;
  created_at: number;
  updated_at: number;
}

export interface TokenizerModelPattern {
  id: string;
  tokenizer_id: string;
  pattern: string;
  priority: number;
  is_built_in: boolean;
  created_at: number;
  updated_at: number;
}

export interface CreateTokenizerConfigInput {
  id?: string;
  name: string;
  type: TokenizerType;
  config?: Record<string, any>;
}

export interface CreateTokenizerModelPatternInput {
  id?: string;
  tokenizer_id: string;
  pattern: string;
  priority?: number;
}

export interface TokenizerTestResult {
  tokenizer_id: string;
  tokenizer_name: string;
  token_count: number;
  char_count: number;
  chars_per_token: number;
}

export interface TokenCountBreakdownEntry {
  name: string;
  type: string;
  tokens: number;
  role?: string;
  blockId?: string;
}

export interface TokenCountResult {
  total_tokens: number;
  breakdown: TokenCountBreakdownEntry[];
  tokenizer_id: string | null;
  tokenizer_name: string | null;
}
