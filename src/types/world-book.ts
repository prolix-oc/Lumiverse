export interface WorldBook {
  id: string;
  name: string;
  description: string;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export type WorldBookVectorIndexStatus = "not_enabled" | "pending" | "indexed" | "error";

export interface WorldBookEntry {
  id: string;
  world_book_id: string;
  uid: string;
  key: string[];
  keysecondary: string[];
  content: string;
  comment: string;
  position: number;
  depth: number;
  role: string | null;
  order_value: number;
  selective: boolean;
  constant: boolean;
  disabled: boolean;
  group_name: string;
  group_override: boolean;
  group_weight: number;
  probability: number;
  scan_depth: number | null;
  case_sensitive: boolean;
  match_whole_words: boolean;
  automation_id: string | null;
  use_regex: boolean;
  prevent_recursion: boolean;
  exclude_recursion: boolean;
  delay_until_recursion: boolean;
  priority: number;
  sticky: number;
  cooldown: number;
  delay: number;
  selective_logic: number;
  use_probability: boolean;
  vectorized: boolean;
  vector_index_status: WorldBookVectorIndexStatus;
  vector_indexed_at: number | null;
  vector_index_error: string | null;
  extensions: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface WorldBookVectorSummary {
  total: number;
  enabled: number;
  non_empty: number;
  enabled_non_empty: number;
  not_enabled: number;
  pending: number;
  indexed: number;
  error: number;
}

export interface WorldBookReindexProgress {
  total: number;
  current: number;
  eligible: number;
  indexed: number;
  removed: number;
  skipped_not_enabled: number;
  skipped_disabled_or_empty: number;
  failed: number;
}

export interface WorldBookReindexResult extends WorldBookReindexProgress {}

export interface WorldBookDiagnostics {
  book_id: string;
  chat_id: string;
  attachment_sources: {
    character: boolean;
    persona: boolean;
    global: boolean;
  };
  embeddings: {
    enabled: boolean;
    has_api_key: boolean;
    dimensions: number | null;
    vectorize_world_books: boolean;
    ready: boolean;
  };
  vector_summary: WorldBookVectorSummary;
  query_preview: string;
  eligible_entries: number;
  keyword_hits: Array<{
    entry_id: string;
    comment: string;
  }>;
  vector_hits: Array<{
    entry_id: string;
    comment: string;
    score: number;
    distance: number;
    final_score: number;
    matched_primary_keys: string[];
    matched_secondary_keys: string[];
    matched_comment: string | null;
    score_breakdown: {
      vectorSimilarity: number;
      primaryExact: number;
      primaryPartial: number;
      secondaryExact: number;
      secondaryPartial: number;
      commentExact: number;
      commentPartial: number;
      priority: number;
    };
    search_text_preview: string;
  }>;
  blocker_messages: string[];
  stats: {
    keywordActivated: number;
    vectorActivated: number;
    totalActivated: number;
    totalCandidates: number;
    activatedBeforeBudget: number;
    activatedAfterBudget: number;
    evictedByBudget: number;
    evictedByMinPriority: number;
    estimatedTokens: number;
    recursionPassesUsed: number;
    queryPreview: string;
  };
}

export interface CreateWorldBookInput {
  name: string;
  description?: string;
  metadata?: Record<string, any>;
}

export type UpdateWorldBookInput = Partial<CreateWorldBookInput>;

export interface CreateWorldBookEntryInput {
  key?: string[];
  keysecondary?: string[];
  content?: string;
  comment?: string;
  position?: number;
  depth?: number;
  role?: string;
  order_value?: number;
  selective?: boolean;
  constant?: boolean;
  disabled?: boolean;
  group_name?: string;
  group_override?: boolean;
  group_weight?: number;
  probability?: number;
  scan_depth?: number;
  case_sensitive?: boolean;
  match_whole_words?: boolean;
  automation_id?: string;
  use_regex?: boolean;
  prevent_recursion?: boolean;
  exclude_recursion?: boolean;
  delay_until_recursion?: boolean;
  priority?: number;
  sticky?: number;
  cooldown?: number;
  delay?: number;
  selective_logic?: number;
  use_probability?: boolean;
  vectorized?: boolean;
  extensions?: Record<string, any>;
}

export type UpdateWorldBookEntryInput = CreateWorldBookEntryInput;

// --- World Info Assembly Cache ---

export interface WorldInfoCache {
  before: Array<{ content: string; role: "system" | "user" | "assistant" }>;         // position 0
  after: Array<{ content: string; role: "system" | "user" | "assistant" }>;          // position 1
  anBefore: Array<{ content: string; role: "system" | "user" | "assistant" }>;       // position 2
  anAfter: Array<{ content: string; role: "system" | "user" | "assistant" }>;        // position 3
  depth: Array<{ content: string; depth: number; role: "system" | "user" | "assistant" }>; // position 4
  emBefore: Array<{ content: string; role: "system" | "user" | "assistant" }>;       // position 5
  emAfter: Array<{ content: string; role: "system" | "user" | "assistant" }>;        // position 6
}
