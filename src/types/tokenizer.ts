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
  extensionId?: string;
  extensionName?: string;
}

export interface TokenCountResult {
  total_tokens: number;
  breakdown: TokenCountBreakdownEntry[];
  tokenizer_id: string | null;
  tokenizer_name: string | null;
}

// ---- Resolve-from-repo flow ----

/** A tokenizer file we looked for in a repo and whether it was present. */
export interface ResolvedFile {
  name: string;
  url: string;
  required: boolean;
  present: boolean;
}

/** Tokenizer config + an auto-suggested name and model-match rule. */
export interface ResolvedTokenizerSuggestion {
  name: string;
  type: TokenizerType;
  config: Record<string, any>;
  pattern: string;
  priority: number;
}

/** Result of resolving a pasted model URL / `owner/repo` slug. */
export type ResolveTokenizerResult =
  | {
      ok: true;
      repo: string;
      revision: string;
      sourceUrl: string;
      type: TokenizerType;
      files: ResolvedFile[];
      suggested: ResolvedTokenizerSuggestion;
      warnings: string[];
    }
  | {
      ok: false;
      reason: "unavailable" | "unsupported" | "invalid";
      message: string;
      /** Files we did detect, when the failure is "unsupported" (loaded but broke). */
      files?: ResolvedFile[];
    };

/** Body for POST /tokenizers/install — create a config and (optionally) a match rule atomically. */
export interface InstallTokenizerInput {
  name: string;
  type: TokenizerType;
  config?: Record<string, any>;
  pattern?: { pattern: string; priority?: number };
}
