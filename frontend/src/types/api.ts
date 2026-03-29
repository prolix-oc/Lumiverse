// ---- Character ----
export interface Character {
  id: string;
  name: string;
  avatar_path: string | null;
  image_id: string | null;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  tags: string[];
  alternate_greetings: string[];
  talkativeness: number; // 0.0–1.0, default 0.5
  extensions: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreateCharacterInput {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator?: string;
  creator_notes?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  tags?: string[];
  alternate_greetings?: string[];
  talkativeness?: number;
  extensions?: Record<string, any>;
}

export type UpdateCharacterInput = Partial<CreateCharacterInput>;

export interface CharacterSummary {
  id: string;
  name: string;
  creator: string;
  tags: string[];
  image_id: string | null;
  created_at: number;
  updated_at: number;
  has_alternate_greetings: boolean;
}

export interface TagCount {
  tag: string;
  count: number;
}

// ---- Chat ----
export interface Chat {
  id: string;
  character_id: string;
  name: string;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreateChatInput {
  character_id: string;
  name?: string;
  metadata?: Record<string, any>;
  greeting_index?: number;
}

export interface RecentChat {
  id: string;
  character_id: string;
  name: string;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
  character_name: string;
  character_avatar_path: string | null;
  character_image_id: string | null;
}

export interface GroupedRecentChat {
  character_id: string;
  character_name: string;
  character_avatar_path: string | null;
  character_image_id: string | null;
  latest_chat_id: string;
  latest_chat_name: string;
  updated_at: number;
  chat_count: number;
  is_group: boolean;
  group_character_ids?: string[];
  group_name?: string;
}

export interface ChatSummary {
  id: string;
  name: string;
  message_count: number;
  created_at: number;
  updated_at: number;
}

// ---- Chat Branch Tree ----
export interface ChatTreeNode {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  branch_at_message: string | null;
  branch_message_index: number | null;
  branch_message_preview: string | null;
  children: ChatTreeNode[];
}

// ---- Group Chat ----
export interface CreateGroupChatInput {
  character_ids: string[];
  name?: string;
  greeting_character_id?: string;
  greeting_index?: number;
}

export interface GroupChatMetadata {
  group: true;
  character_ids: string[];
  talkativeness_overrides?: Record<string, number>;
  concatenation_mode?: boolean;
}

// ---- Message Attachment ----
export interface MessageAttachment {
  type: "image" | "audio";
  image_id: string;
  mime_type: string;
  original_filename: string;
  width?: number;
  height?: number;
}

// ---- Message ----
export interface MessageExtra {
  persona_id?: string;
  /** Set by the backend prompt assembler when a user_append or assistant_append
   *  Loom block injects content into this message. Messages with this tag are
   *  hidden from the chat list but still included in prompt assembly. */
  _loom_inject?: import('@/lib/loom/types').LoomInjectTag;
  _loom_block_id?: string;
  attachments?: MessageAttachment[];
  [key: string]: any;
}

export interface Message {
  id: string;
  chat_id: string;
  index_in_chat: number;
  is_user: boolean;
  name: string;
  content: string;
  send_date: number;
  swipe_id: number;
  swipes: string[];
  swipe_dates: number[];
  extra: MessageExtra;
  parent_message_id: string | null;
  branch_id: string | null;
  created_at: number;
}

export interface CreateMessageInput {
  is_user: boolean;
  name: string;
  content: string;
  extra?: Record<string, any>;
  parent_message_id?: string;
  branch_id?: string;
}

export interface UpdateMessageInput {
  content?: string;
  name?: string;
  extra?: Record<string, any>;
}

// ---- Connection Profile ----
export interface ConnectionProfile {
  id: string;
  name: string;
  provider: string;
  api_url: string;
  model: string;
  preset_id: string | null;
  is_default: boolean;
  has_api_key: boolean;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreateConnectionProfileInput {
  name: string;
  provider: string;
  api_url?: string;
  api_key?: string;
  model?: string;
  preset_id?: string;
  is_default?: boolean;
  metadata?: Record<string, any>;
}

export type UpdateConnectionProfileInput = Partial<CreateConnectionProfileInput>;

export interface ProviderInfo {
  id: string
  name: string
  default_url: string
}

export interface ConnectionTestResult {
  success: boolean
  message: string
  provider: string
}

export interface ConnectionModelsResult {
  models: string[]
  /** Map of model ID → human-readable display name (when available). */
  model_labels?: Record<string, string>
  provider: string
  error?: string
}

// ---- Image Gen Connection Profile ----
export interface ImageGenConnectionProfile {
  id: string;
  name: string;
  provider: string;
  api_url: string;
  model: string;
  is_default: boolean;
  has_api_key: boolean;
  default_parameters: Record<string, any>;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreateImageGenConnectionInput {
  name: string;
  provider: string;
  api_url?: string;
  model?: string;
  is_default?: boolean;
  default_parameters?: Record<string, any>;
  metadata?: Record<string, any>;
  api_key?: string;
}

export type UpdateImageGenConnectionInput = Partial<CreateImageGenConnectionInput>;

export interface ImageGenConnectionTestResult {
  success: boolean;
  message: string;
  provider: string;
}

export interface ImageGenConnectionModelsResult {
  models: Array<{ id: string; label: string }>;
  provider: string;
  error?: string;
}

export interface ImageGenParameterSchema {
  type: 'number' | 'integer' | 'boolean' | 'string' | 'select' | 'image_array';
  default?: any;
  min?: number;
  max?: number;
  step?: number;
  description: string;
  required?: boolean;
  options?: Array<{ id: string; label: string }>;
  group?: string;
}

export interface ImageGenProviderCapabilities {
  parameters: Record<string, ImageGenParameterSchema>;
  apiKeyRequired: boolean;
  modelListStyle: 'static' | 'dynamic' | 'google';
  staticModels?: Array<{ id: string; label: string }>;
  defaultUrl: string;
}

export interface ImageGenProviderInfo {
  id: string;
  name: string;
  capabilities: ImageGenProviderCapabilities;
}

// ---- Persona ----
export interface PersonaAddon {
  id: string
  label: string
  content: string
  enabled: boolean
  sort_order: number
}

export interface Persona {
  id: string;
  name: string;
  title: string;
  description: string;
  avatar_path: string | null;
  image_id: string | null;
  attached_world_book_id: string | null;
  folder: string;
  is_default: boolean;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreatePersonaInput {
  name: string;
  title?: string;
  description?: string;
  folder?: string;
  is_default?: boolean;
  attached_world_book_id?: string;
  metadata?: Record<string, any>;
}

export type UpdatePersonaInput = Partial<CreatePersonaInput>;

// ---- Preset ----
export interface Preset {
  id: string;
  name: string;
  provider: string;
  parameters: Record<string, any>;
  prompt_order: any[];
  prompts: Record<string, any>;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreatePresetInput {
  name: string;
  provider: string;
  parameters?: Record<string, any>;
  prompt_order?: any[];
  prompts?: Record<string, any>;
  metadata?: Record<string, any>;
}

export type UpdatePresetInput = Partial<CreatePresetInput>;

export interface PresetRegistryItem {
  id: string;
  name: string;
  provider: string;
  block_count: number;
  updated_at: number;
}

// ---- Character Gallery ----
export interface CharacterGalleryItem {
  id: string;
  image_id: string;
  caption: string;
  sort_order: number;
  created_at: number;
  width: number | null;
  height: number | null;
  mime_type: string;
}

// ---- Image ----
export interface Image {
  id: string;
  filename: string;
  original_filename: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  has_thumbnail: boolean;
  created_at: number;
}

// ---- World Book ----
export interface WorldBook {
  id: string;
  name: string;
  description: string;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export type WorldBookVectorIndexStatus = 'not_enabled' | 'pending' | 'indexed' | 'error'

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

export interface WorldBookReindexResult extends WorldBookReindexProgress {
  success?: boolean;
}

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
  eligible_entries: number;
  retrieval: {
    top_k: number;
    hits_before_threshold: number;
    hits_after_threshold: number;
    threshold_rejected: number;
    hits_after_rerank_cutoff: number;
    rerank_rejected: number;
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
      primaryExact: number;
      primaryPartial: number;
      secondaryExact: number;
      secondaryPartial: number;
      commentExact: number;
      commentPartial: number;
      focusBoost: number;
      priority: number;
      broadPenalty: number;
      focusMissPenalty: number;
    };
    search_text_preview: string;
  }>;
  blocker_messages: string[];
  stats: WorldInfoStats;
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

export interface EmbeddingConfig {
  enabled: boolean;
  provider: 'openai-compatible' | 'openai' | 'openrouter' | 'electronhub' | 'nanogpt';
  api_url: string;
  model: string;
  dimensions: number | null;
  send_dimensions: boolean;
  retrieval_top_k: number;
  hybrid_weight_mode: 'keyword_first' | 'balanced' | 'vector_first';
  preferred_context_size: number;
  batch_size: number;
  similarity_threshold: number;
  rerank_cutoff: number;
  vectorize_world_books: boolean;
  vectorize_chat_messages: boolean;
  vectorize_chat_documents: boolean;
  chat_memory_mode: 'conservative' | 'balanced' | 'aggressive';
  has_api_key: boolean;
}

export interface ChatMemorySettings {
  chunkTargetTokens: number
  chunkMaxTokens: number
  chunkOverlapTokens: number
  exclusionWindow: number
  queryContextSize: number
  retrievalTopK: number
  similarityThreshold: number
  queryStrategy: 'recent_messages' | 'last_user_message' | 'weighted_recent'
  queryMaxTokens: number
  memoryHeaderTemplate: string
  chunkTemplate: string
  chunkSeparator: string
  splitOnSceneBreaks: boolean
  splitOnTimeGapMinutes: number
  maxMessagesPerChunk: number
  quickMode: 'conservative' | 'balanced' | 'aggressive' | null
}

export interface WorldInfoSettings {
  globalScanDepth: number | null;
  maxRecursionPasses: number;
  maxActivatedEntries: number;
  maxTokenBudget: number;
  minPriority: number;
}

export interface WorldInfoStats {
  totalCandidates: number;
  activatedBeforeBudget: number;
  activatedAfterBudget: number;
  evictedByBudget: number;
  evictedByMinPriority: number;
  estimatedTokens: number;
  recursionPassesUsed: number;
  keywordActivated: number;
  vectorActivated: number;
  totalActivated: number;
  queryPreview: string;
}

export interface ActivatedWorldInfoEntry {
  id: string;
  comment: string;
  keys: string[];
  source: 'keyword' | 'vector';
  score?: number;
  bookSource?: 'character' | 'persona' | 'chat' | 'global';
  bookId?: string;
}

export type UpdateWorldBookEntryInput = CreateWorldBookEntryInput;

// ---- Pack ----
export interface Pack {
  id: string;
  user_id: string;
  name: string;
  author: string;
  cover_url: string | null;
  version: string;
  is_custom: boolean;
  source_url: string | null;
  extras: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface LumiaItem {
  id: string;
  pack_id: string;
  name: string;
  avatar_url: string | null;
  author_name: string;
  definition: string;
  personality: string;
  behavior: string;
  gender_identity: 0 | 1 | 2;
  version: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export type LoomItemCategory = 'narrative_style' | 'loom_utility' | 'retrofit';

export interface LoomItem {
  id: string;
  pack_id: string;
  name: string;
  content: string;
  category: LoomItemCategory;
  author_name: string;
  version: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface LoomTool {
  id: string;
  pack_id: string;
  tool_name: string;
  display_name: string;
  description: string;
  prompt: string;
  input_schema: Record<string, any>;
  result_variable: string;
  store_in_deliberation: boolean;
  author_name: string;
  version: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface PackWithItems extends Pack {
  lumia_items: LumiaItem[];
  loom_items: LoomItem[];
  loom_tools: LoomTool[];
}

export interface CreatePackInput {
  name: string;
  author?: string;
  cover_url?: string;
  version?: string;
  is_custom?: boolean;
  source_url?: string;
  extras?: Record<string, any>;
}

export type UpdatePackInput = Partial<CreatePackInput>;

export interface CreateLumiaItemInput {
  name: string;
  avatar_url?: string;
  author_name?: string;
  definition?: string;
  personality?: string;
  behavior?: string;
  gender_identity?: 0 | 1 | 2;
  version?: string;
  sort_order?: number;
}

export type UpdateLumiaItemInput = Partial<CreateLumiaItemInput>;

export interface CreateLoomItemInput {
  name: string;
  content?: string;
  category?: LoomItemCategory;
  author_name?: string;
  version?: string;
  sort_order?: number;
}

export type UpdateLoomItemInput = Partial<CreateLoomItemInput>;

export interface CreateLoomToolInput {
  tool_name: string;
  display_name?: string;
  description?: string;
  prompt?: string;
  input_schema?: Record<string, any>;
  result_variable?: string;
  store_in_deliberation?: boolean;
  author_name?: string;
  version?: string;
  sort_order?: number;
}

export type UpdateLoomToolInput = Partial<CreateLoomToolInput>;

// ---- Import / Batch ----
export interface ImportResult {
  character: Character
  message?: string
}

export interface BulkImportResultItem {
  filename: string
  success: boolean
  character?: Character
  lorebook?: { name: string; entryCount: number }
  error?: string
  skipped?: boolean
}

export interface BulkImportResult {
  results: BulkImportResultItem[]
  summary: { total: number; imported: number; skipped: number; failed: number }
}

export interface BatchDeleteResult {
  deleted: string[]
  failed: string[]
}

export interface LumiModule {
  key: string;
  name: string;
  enabled: boolean;
  prompt: string;
}


export interface LumiPipeline {
  key: string;
  name: string;
  enabled: boolean;
  modules: LumiModule[];
}

export interface LumiSidecarConfig {
  connectionProfileId: string | null;
  model: string | null;
  temperature: number;
  topP: number;
  maxTokensPerModule: number;
  contextWindow: number;
}

export interface BlockGroupConfig {
  name: string;
  mode: 'radio' | 'checkbox';
  order: number;
  collapsed?: boolean;
}

export interface LumiPresetMetadata {
  pipelines: LumiPipeline[];
  sidecar: LumiSidecarConfig;
  blockGroups?: BlockGroupConfig[];
}

export interface LumiFileFormat {
  version: 2;
  name: string;
  provider: string;
  pipelines: LumiPipeline[];
  sidecar: LumiSidecarConfig;
  blockGroups?: BlockGroupConfig[];
  parameters: Record<string, any>;
  prompts: Record<string, any>;
  prompt_order: any[];
}

// ---- Pagination ----
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}
