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
  capabilities?: {
    parameters?: Record<string, unknown>
  }
}

export interface ConnectionTestResult {
  success: boolean
  message: string
  provider: string
}

export interface ConnectionModelsResult {
  models: string[]
  model_labels?: Record<string, string>
  provider: string
  error?: string
}

export interface EmbeddingModelsPreviewInput {
  provider?: EmbeddingConfig['provider']
  api_url?: string
  api_key?: string
}

export interface NanoGptUsageWindow {
  used: number
  remaining: number
  percentUsed: number
  resetAt: number | null
}

export interface NanoGptSubscriptionUsage {
  active: boolean
  limits: {
    weeklyInputTokens: number | null
    dailyImages: number | null
  }
  weeklyInputTokens: NanoGptUsageWindow | null
  dailyImages: NanoGptUsageWindow | null
  period: {
    currentPeriodEnd: string | null
  }
  state: string | null
  graceUntil: string | null
}

export interface ConnectionModelsPreviewInput {
  connection_id?: string;
  provider: string;
  api_url?: string;
  metadata?: Record<string, any>;
  api_key?: string;
  output_modalities?: string;
}

export interface PollinationsAuthUrlRequest {
  redirect_url: string;
  models?: string;
  budget?: number;
  expiry?: number;
  permissions?: string;
}

export interface PollinationsAuthUrlResponse {
  auth_url: string;
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

export interface ImageGenConnectionModelsPreviewInput {
  connection_id?: string;
  provider: string;
  api_url?: string;
  api_key?: string;
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
  /** When set, the UI fetches models from GET /image-gen-connections/:id/models/:modelSubtype */
  modelSubtype?: string;
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

// ---- STT Connection ----
export interface SttConnectionProfile {
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

export interface CreateSttConnectionInput {
  name: string;
  provider: string;
  api_url?: string;
  model?: string;
  is_default?: boolean;
  default_parameters?: Record<string, any>;
  metadata?: Record<string, any>;
  api_key?: string;
}

export type UpdateSttConnectionInput = Partial<CreateSttConnectionInput>;

export interface SttConnectionTestResult {
  success: boolean;
  message: string;
  provider: string;
}

export interface SttConnectionModelsResult {
  models: Array<{ id: string; label: string }>;
  provider: string;
  error?: string;
}

export interface SttProviderCapabilities {
  apiKeyRequired: boolean;
  modelListStyle: 'static';
  staticModels: Array<{ id: string; label: string }>;
  defaultUrl: string;
}

export interface SttProviderInfo {
  id: string;
  name: string;
  capabilities: SttProviderCapabilities;
}

// ---- TTS Connection ----
export interface TtsConnectionProfile {
  id: string;
  name: string;
  provider: string;
  api_url: string;
  model: string;
  voice: string;
  is_default: boolean;
  has_api_key: boolean;
  default_parameters: Record<string, any>;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreateTtsConnectionInput {
  name: string;
  provider: string;
  api_url?: string;
  model?: string;
  voice?: string;
  is_default?: boolean;
  default_parameters?: Record<string, any>;
  metadata?: Record<string, any>;
  api_key?: string;
}

export type UpdateTtsConnectionInput = Partial<CreateTtsConnectionInput>;

export interface TtsConnectionTestResult {
  success: boolean;
  message: string;
  provider: string;
}

export interface TtsConnectionModelsResult {
  models: Array<{ id: string; label: string }>;
  provider: string;
  error?: string;
}

export interface TtsVoice {
  id: string;
  name: string;
  language?: string;
  gender?: string;
  previewUrl?: string;
}

export interface TtsConnectionVoicesResult {
  voices: TtsVoice[];
  provider: string;
  error?: string;
}

export interface TtsConnectionVoicesPreviewInput {
  connection_id?: string;
  provider: string;
  api_url?: string;
  api_key?: string;
}

export interface TtsParameterSchema {
  type: 'number' | 'integer' | 'boolean' | 'string' | 'select';
  default?: any;
  min?: number;
  max?: number;
  step?: number;
  description: string;
  required?: boolean;
  options?: Array<{ id: string; label: string }>;
  group?: string;
}

export interface TtsProviderCapabilities {
  parameters: Record<string, TtsParameterSchema>;
  apiKeyRequired: boolean;
  voiceListStyle: 'static' | 'dynamic';
  staticVoices?: TtsVoice[];
  modelListStyle: 'static' | 'dynamic';
  staticModels?: Array<{ id: string; label: string }>;
  supportsStreaming: boolean;
  supportedFormats: string[];
  defaultUrl: string;
  defaultFormat: string;
}

export interface TtsProviderInfo {
  id: string;
  name: string;
  capabilities: TtsProviderCapabilities;
}

// ---- Persona ----
export interface PersonaAddon {
  id: string
  label: string
  content: string
  enabled: boolean
  sort_order: number
}

export interface GlobalAddon {
  id: string
  label: string
  content: string
  sort_order: number
  metadata: Record<string, any>
  created_at: number
  updated_at: number
}

export interface AttachedGlobalAddon {
  id: string
  enabled: boolean
}

export interface CharacterPersonaBinding {
  personaId: string
  addonStates?: Record<string, boolean>
}

export interface Persona {
  id: string;
  name: string;
  title: string;
  description: string;
  subjective_pronoun: string;
  objective_pronoun: string;
  possessive_pronoun: string;
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
  subjective_pronoun?: string;
  objective_pronoun?: string;
  possessive_pronoun?: string;
  folder?: string;
  is_default?: boolean;
  attached_world_book_id?: string;
  metadata?: Record<string, any>;
}

export type UpdatePersonaInput = Partial<CreatePersonaInput>;

export interface RenamePersonaFolderResponse {
  updated: Persona[];
  count: number;
}

export interface DeletePersonaFolderResponse {
  updated: Persona[];
  count: number;
}

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

export interface TagLibraryImportResult {
  tagDefinitions: number;
  characterMappings: number;
  matchedCharacters: number;
  updatedCharacters: number;
  unchangedCharacters: number;
  unmatchedMappings: number;
  addedTags: number;
  matchedBy: {
    source_filename: number;
    image_original_filename: number;
    normalized_name: number;
  };
  unmatchedFilenames: string[];
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

export interface ThemeAsset {
  id: string;
  bundle_id: string;
  slug: string;
  storage_type: 'image' | 'file';
  image_id: string | null;
  file_name: string | null;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  tags: string[];
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
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
  outlet_name: string | null;
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
      priority: number;
      broadPenalty: number;
      focusMissPenalty: number;
    };
    search_text_preview: string;
    rerank_rank: number | null;
    final_outcome_code:
      | 'injected_vector'
      | 'already_keyword'
      | 'blocked_by_group'
      | 'blocked_by_min_priority'
      | 'blocked_by_max_entries'
      | 'blocked_by_token_budget'
      | 'deduplicated'
      | 'blocked_during_final_assembly'
      | 'trimmed_by_top_k'
      | 'rejected_by_rerank_cutoff'
      | 'rejected_by_similarity_threshold';
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
      priority: number;
      broadPenalty: number;
      focusMissPenalty: number;
    };
    search_text_preview: string;
    rerank_rank: number | null;
    final_outcome_code:
      | 'injected_vector'
      | 'already_keyword'
      | 'blocked_by_group'
      | 'blocked_by_min_priority'
      | 'blocked_by_max_entries'
      | 'blocked_by_token_budget'
      | 'deduplicated'
      | 'blocked_during_final_assembly'
      | 'trimmed_by_top_k'
      | 'rejected_by_rerank_cutoff'
      | 'rejected_by_similarity_threshold';
    final_outcome_label: string;
    final_outcome_reason: string;
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
  outlet_name?: string | null;
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

export interface DuplicateWorldBookEntryInput {
  target_book_id?: string | null;
}

export interface ReorderWorldBookEntriesInput {
  ordered_ids: string[];
}

export interface WorldBookEntryBulkDeleteInput {
  action: 'delete';
  entry_ids: string[];
}

export interface WorldBookEntryBulkMoveInput {
  action: 'move';
  entry_ids: string[];
  target_book_id: string;
}

export interface WorldBookEntryBulkRenumberInput {
  action: 'renumber';
  entry_ids: string[];
  start?: number | null;
  step?: number;
  direction?: 'asc' | 'desc';
}

export interface WorldBookEntryBulkAddKeywordInput {
  action: 'add_keyword';
  entry_ids: string[];
  keyword: string;
  target?: 'primary' | 'secondary';
}

export type WorldBookEntryBulkActionInput =
  | WorldBookEntryBulkDeleteInput
  | WorldBookEntryBulkMoveInput
  | WorldBookEntryBulkRenumberInput
  | WorldBookEntryBulkAddKeywordInput;

export interface WorldBookEntryBulkActionResult {
  action: WorldBookEntryBulkActionInput['action'];
  affected: number;
  target_book_id?: string;
}

export interface EmbeddingConfig {
  enabled: boolean;
  provider: 'openai-compatible' | 'openai' | 'openrouter' | 'electronhub' | 'bananabread' | 'nanogpt';
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
  request_timeout: number;
  has_api_key: boolean;
  /** True when the server owner has enabled a shared embedding config and the
   *  current user is a non-owner inheriting it. The form should be read-only
   *  and the config is not user-editable while this flag is set. */
  inherited?: boolean;
}

export interface ChatMemorySettings {
  autoWarmup: boolean
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
  gender_identity: 0 | 1 | 2 | 3;
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
  gender_identity?: 0 | 1 | 2 | 3;
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
