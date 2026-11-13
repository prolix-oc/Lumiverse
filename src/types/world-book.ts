export interface WorldBook {
  id: string;
  name: string;
  description: string;
  folder: string;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export type WorldBookVectorIndexStatus = "not_enabled" | "pending" | "indexed" | "error";

export interface WorldBookEntry {
  folder: string;
  tags: string[];
  id: string;
  world_book_id: string;
  uid: string;
  outlet_name: string | null;
  wi_marker: string | null;
  wi_marker_side: "before" | "after" | null;
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
  /** Exclude the synthetic character greeting from this entry's lexical activation scan. */
  exclude_greeting: boolean;
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
  revision: number;
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
    chat: boolean;
  };
  embeddings: {
    enabled: boolean;
    has_api_key: boolean;
    dimensions: number | null;
    vectorize_world_books: boolean;
    similarity_threshold: number;
    rerank_cutoff: number;
    ready: boolean;
  };
  vector_summary: WorldBookVectorSummary;
  query_preview: string;
  query_scope: {
    configured_scan_depth: number | null;
    visible_messages_available: number;
    vector_messages_selected: number;
    max_tokens: number;
    token_truncated: boolean;
  };
  lexical_query_previews: Array<{
    kind: "anchors" | "mixed" | "topical";
    text: string;
  }>;
  eligible_entries: number;
  retrieval: {
    top_k: number;
    hits_before_threshold: number;
    hits_after_threshold: number;
    threshold_rejected: number;
    hits_after_rerank_cutoff: number;
    rerank_rejected: number;
    timings_ms: {
      query_build: number;
      query_embed: number;
      search: number;
      ranking: number;
      merge: number;
      total: number;
    };
  };
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
    lexical_candidate_score: number | null;
    matched_primary_keys: string[];
    matched_secondary_keys: string[];
    matched_comment: string | null;
    score_breakdown: {
      vectorSimilarity: number;
      lexicalContentBoost: number;
      primaryExact: number;
      primaryPartial: number;
      secondaryExact: number;
      secondaryPartial: number;
      commentExact: number;
      commentPartial: number;
      focusBoost: number;
      supportingContextBoost: number;
      priority: number;
      broadPenalty: number;
      focusMissPenalty: number;
    };
    search_text_preview: string;
    rerank_rank: number | null;
    final_outcome_code:
      | "injected_vector"
      | "already_keyword"
      | "blocked_by_group"
      | "blocked_by_min_priority"
      | "blocked_by_max_entries"
      | "blocked_by_token_budget"
      | "deduplicated"
      | "blocked_during_final_assembly"
      | "trimmed_by_top_k"
      | "rejected_by_rerank_cutoff"
      | "rejected_by_similarity_threshold";
    final_outcome_label: string;
    final_outcome_reason: string;
  }>;
  vector_trace: Array<{
    entry_id: string;
    comment: string;
    score: number;
    distance: number;
    final_score: number;
    lexical_candidate_score: number | null;
    matched_primary_keys: string[];
    matched_secondary_keys: string[];
    matched_comment: string | null;
    score_breakdown: {
      vectorSimilarity: number;
      lexicalContentBoost: number;
      primaryExact: number;
      primaryPartial: number;
      secondaryExact: number;
      secondaryPartial: number;
      commentExact: number;
      commentPartial: number;
      focusBoost: number;
      supportingContextBoost: number;
      priority: number;
      broadPenalty: number;
      focusMissPenalty: number;
    };
    search_text_preview: string;
    rerank_rank: number | null;
    final_outcome_code:
      | "injected_vector"
      | "already_keyword"
      | "blocked_by_group"
      | "blocked_by_min_priority"
      | "blocked_by_max_entries"
      | "blocked_by_token_budget"
      | "deduplicated"
      | "blocked_during_final_assembly"
      | "trimmed_by_top_k"
      | "rejected_by_rerank_cutoff"
      | "rejected_by_similarity_threshold";
    final_outcome_label: string;
    final_outcome_reason: string;
  }>;
  blocker_messages: string[];
  deduplication?: {
    removed_count: number;
    removed: Array<{
      removed_entry_id: string;
      removed_entry_comment: string;
      kept_entry_id: string;
      kept_entry_comment: string;
      tier: "exact" | "near-exact" | "fuzzy";
      similarity?: number;
    }>;
  };
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
    deduplicated: number;
    queryPreview: string;
  };
}

export interface CreateWorldBookInput {
  name: string;
  description?: string;
  folder?: string;
  metadata?: Record<string, any>;
}

export type UpdateWorldBookInput = Partial<CreateWorldBookInput>;

export interface CreateWorldBookEntryInput {
  folder?: string;
  tags?: string[];
  outlet_name?: string | null;
  wi_marker?: string | null;
  wi_marker_side?: "before" | "after" | null;
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
  /** Exclude the synthetic character greeting from this entry's lexical activation scan. */
  exclude_greeting?: boolean;
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

export type UpdateWorldBookEntryInput = CreateWorldBookEntryInput & {
  expected_revision?: number;
};

export interface DuplicateWorldBookEntryInput {
  target_book_id?: string | null;
  expected_revision?: number;
}

export interface ReorderWorldBookEntriesInput {
  ordered_ids: string[];
  expected_revisions?: Record<string, number>;
}

interface WorldBookEntryBulkBaseInput {
  entry_ids: string[];
  expected_revisions?: Record<string, number>;
}

export interface WorldBookEntryBulkDeleteInput extends WorldBookEntryBulkBaseInput {
  action: "delete";
}

export interface WorldBookEntryBulkMoveInput extends WorldBookEntryBulkBaseInput {
  action: "move";
  target_book_id: string;
  target_folder?: string;
}

export interface WorldBookEntryBulkRenumberInput extends WorldBookEntryBulkBaseInput {
  action: "renumber";
  start?: number | null;
  step?: number;
  direction?: "asc" | "desc";
}

export interface WorldBookEntryBulkAddKeywordInput extends WorldBookEntryBulkBaseInput {
  action: "add_keyword";
  keyword: string;
  target?: "primary" | "secondary";
}

export interface WorldBookEntryBulkSetPositionInput extends WorldBookEntryBulkBaseInput {
  action: "set_position";
  position: number;
  depth?: number;
}

export interface WorldBookEntryBulkSetActivationInput extends WorldBookEntryBulkBaseInput {
  action: "set_activation";
  activation: "trigger" | "constant" | "vector";
}

export interface WorldBookEntryBulkSetTriggerInput extends WorldBookEntryBulkBaseInput {
  action: "set_trigger";
}

export interface WorldBookEntryBulkSetPriorityInput extends WorldBookEntryBulkBaseInput {
  action: "set_priority";
  priority: number;
}

export interface WorldBookEntryBulkSetDepthInput extends WorldBookEntryBulkBaseInput {
  action: "set_depth";
  depth: number;
}

export interface WorldBookEntryBulkSetEnabledInput extends WorldBookEntryBulkBaseInput {
  action: "set_enabled";
  enabled: boolean;
}

export interface WorldBookEntryBulkSetFieldsInput extends WorldBookEntryBulkBaseInput {
  action: "set_fields";
  fields: Partial<CreateWorldBookEntryInput>;
}

export interface WorldBookEntryBulkCopyInput extends WorldBookEntryBulkBaseInput {
  action: "copy";
  target_book_id: string;
}

export interface WorldBookEntryBulkTagsInput {
  action: "add_tags" | "remove_tags";
  entry_ids: string[];
  tags: string[];
  expected_revisions?: Record<string, number>;
}

export interface WorldBookEntryFolderActionInput {
  action: "rename" | "remove" | "move";
  folder: string;
  target_folder?: string;
  target_book_id?: string;
}

export interface WorldBookEntryOrganizationSummary {
  total: number;
  unfiled: number;
  folders: Array<{ name: string; count: number }>;
  tags: Array<{ name: string; count: number }>;
}

export type WorldBookEntryBulkActionInput =
  | WorldBookEntryBulkTagsInput
  | WorldBookEntryBulkDeleteInput
  | WorldBookEntryBulkMoveInput
  | WorldBookEntryBulkRenumberInput
  | WorldBookEntryBulkAddKeywordInput
  | WorldBookEntryBulkSetPositionInput
  | WorldBookEntryBulkSetActivationInput
  | WorldBookEntryBulkSetTriggerInput
  | WorldBookEntryBulkSetPriorityInput
  | WorldBookEntryBulkSetDepthInput
  | WorldBookEntryBulkSetEnabledInput
  | WorldBookEntryBulkSetFieldsInput
  | WorldBookEntryBulkCopyInput;

export interface WorldBookEntryBulkActionResult {
  action: WorldBookEntryBulkActionInput["action"];
  affected: number;
  target_book_id?: string;
}

export interface WorldBookEntryConflict {
  id: string;
  current: WorldBookEntry | null;
}

export interface WorldBookEntryConflictPayload {
  error: "world_book_entry_conflict";
  code: "WORLD_BOOK_ENTRY_CONFLICT";
  conflicts: WorldBookEntryConflict[];
}

// --- World Info Assembly Cache ---

export interface WorldInfoCache {
  before: Array<{ content: string; role: "system" | "user" | "assistant"; entryLabel: string }>;         // position 0
  after: Array<{ content: string; role: "system" | "user" | "assistant"; entryLabel: string }>;          // position 1
  anBefore: Array<{ content: string; role: "system" | "user" | "assistant"; entryLabel: string }>;       // position 2
  anAfter: Array<{ content: string; role: "system" | "user" | "assistant"; entryLabel: string }>;        // position 3
  depth: Array<{ content: string; depth: number; role: "system" | "user" | "assistant"; entryLabel: string }>; // position 4
  emBefore: Array<{ content: string; role: "system" | "user" | "assistant"; entryLabel: string }>;       // position 5
  emAfter: Array<{ content: string; role: "system" | "user" | "assistant"; entryLabel: string }>;        // position 6
  atMarker: Array<{ content: string; role: "system" | "user" | "assistant"; entryLabel: string }>;       // position 7
  pinnedMarkers: Array<{ content: string; role: "system" | "user" | "assistant"; entryLabel: string; marker: string; side: "before" | "after" }>;
}
