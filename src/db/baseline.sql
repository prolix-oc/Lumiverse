-- Lumiverse Database Baseline Schema
-- Generated from migrations 001 through 065.
-- Fresh databases bootstrap from this file instead of replaying the full
-- migration stack. All squashed migration names are recorded in _migrations
-- so the runner treats them as already applied.

CREATE TABLE "account" (
  id TEXT PRIMARY KEY NOT NULL,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt INTEGER,
  refreshTokenExpiresAt INTEGER,
  scope TEXT,
  password TEXT,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE character_gallery (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  image_id      TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  caption       TEXT DEFAULT '',
  sort_order    INTEGER DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_path TEXT,
  description TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  scenario TEXT NOT NULL DEFAULT '',
  first_mes TEXT NOT NULL DEFAULT '',
  mes_example TEXT NOT NULL DEFAULT '',
  creator TEXT NOT NULL DEFAULT '',
  creator_notes TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  post_history_instructions TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  alternate_greetings TEXT NOT NULL DEFAULT '[]',
  extensions TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, image_id TEXT REFERENCES images(id) ON DELETE SET NULL, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE);

CREATE VIRTUAL TABLE characters_fts USING fts5(
  name, creator, tags,
  content='characters',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TABLE chat_chunks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  start_message_id TEXT NOT NULL,
  end_message_id TEXT NOT NULL,
  message_ids TEXT NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  vectorized_at INTEGER,
  vector_model TEXT,
  retrieval_count INTEGER DEFAULT 0,
  last_retrieved_at INTEGER,
  avg_similarity_score REAL,
  has_dialogue INTEGER DEFAULT 1,
  has_action INTEGER DEFAULT 0,
  message_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, salience_score REAL DEFAULT NULL, emotional_tags TEXT DEFAULT NULL, entity_ids TEXT DEFAULT NULL, consolidation_id TEXT DEFAULT NULL, message_range_start INTEGER DEFAULT NULL, message_range_end INTEGER DEFAULT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE chat_memory_cache (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  settings_key TEXT NOT NULL,
  source_message_count INTEGER NOT NULL DEFAULT 0,
  query_preview TEXT NOT NULL DEFAULT '',
  chunks_json TEXT NOT NULL DEFAULT '[]',
  formatted TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  settings_source TEXT NOT NULL DEFAULT 'global',
  chunks_available INTEGER NOT NULL DEFAULT 0,
  chunks_pending INTEGER NOT NULL DEFAULT 0,
  retrieval_mode TEXT NOT NULL DEFAULT 'empty',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(chat_id, settings_key)
);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE);

CREATE TABLE connection_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  api_url TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  preset_id TEXT REFERENCES presets(id) ON DELETE SET NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, has_api_key INTEGER NOT NULL DEFAULT 0, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE);

CREATE TABLE cortex_chat_links (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  chat_id         TEXT NOT NULL,
  link_type       TEXT NOT NULL CHECK(link_type IN ('vault', 'interlink')),
  vault_id        TEXT,
  target_chat_id  TEXT,
  label           TEXT DEFAULT '',
  enabled         INTEGER DEFAULT 1,
  priority        INTEGER DEFAULT 0,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id) REFERENCES cortex_vaults(id) ON DELETE CASCADE,
  FOREIGN KEY (target_chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE cortex_vault_chunks (
  id                  TEXT PRIMARY KEY,
  vault_id            TEXT NOT NULL,
  source_chunk_id     TEXT NOT NULL,
  content             TEXT NOT NULL,
  salience_score      REAL,
  emotional_tags      TEXT DEFAULT '[]',
  entity_names        TEXT DEFAULT '[]',
  source_created_at   INTEGER NOT NULL,
  copied_at           INTEGER NOT NULL,
  FOREIGN KEY (vault_id) REFERENCES cortex_vaults(id) ON DELETE CASCADE
);

CREATE TABLE cortex_vault_entities (
  id                TEXT PRIMARY KEY,
  vault_id          TEXT NOT NULL,
  name              TEXT NOT NULL,
  entity_type       TEXT NOT NULL,
  aliases           TEXT DEFAULT '[]',
  description       TEXT DEFAULT '',
  status            TEXT DEFAULT 'active',
  facts             TEXT DEFAULT '[]',
  emotional_valence TEXT DEFAULT '{}',
  salience_avg      REAL DEFAULT 0.0,
  FOREIGN KEY (vault_id) REFERENCES cortex_vaults(id) ON DELETE CASCADE
);

CREATE TABLE cortex_vault_relations (
  id                  TEXT PRIMARY KEY,
  vault_id            TEXT NOT NULL,
  source_entity_name  TEXT NOT NULL,
  target_entity_name  TEXT NOT NULL,
  relation_type       TEXT NOT NULL,
  relation_label      TEXT,
  strength            REAL DEFAULT 0.5,
  sentiment           REAL DEFAULT 0.0,
  status              TEXT DEFAULT 'active',
  FOREIGN KEY (vault_id) REFERENCES cortex_vaults(id) ON DELETE CASCADE
);

CREATE TABLE cortex_vaults (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  source_chat_id  TEXT,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  entity_count    INTEGER DEFAULT 0,
  relation_count  INTEGER DEFAULT 0,
  created_at      INTEGER NOT NULL, chunk_count INTEGER DEFAULT 0,
  FOREIGN KEY (source_chat_id) REFERENCES chats(id) ON DELETE SET NULL
);

CREATE TABLE databank_chunks (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL,
  databank_id   TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL,
  content       TEXT NOT NULL,
  token_count   INTEGER NOT NULL DEFAULT 0,
  vectorized_at INTEGER,
  vector_model  TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES databank_documents(id) ON DELETE CASCADE,
  FOREIGN KEY (databank_id) REFERENCES databanks(id) ON DELETE CASCADE
);

CREATE TABLE databank_documents (
  id            TEXT PRIMARY KEY,
  databank_id   TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT '',
  file_size     INTEGER NOT NULL DEFAULT 0,
  content_hash  TEXT NOT NULL DEFAULT '',
  total_chunks  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'ready', 'error')),
  error_message TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (databank_id) REFERENCES databanks(id) ON DELETE CASCADE
);

CREATE TABLE databanks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scope       TEXT NOT NULL CHECK(scope IN ('global', 'character', 'chat')),
  scope_id    TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE dream_weaver_saved_prompts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  negative_prompt TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE dream_weaver_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),

  dream_text TEXT NOT NULL,
  tone TEXT,
  constraints TEXT,
  dislikes TEXT,
  persona_id TEXT,
  connection_id TEXT,
  model TEXT,

  draft TEXT,

  status TEXT DEFAULT 'draft',

  character_id TEXT,

  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL,
  FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
);

CREATE TABLE extension_grants (
  id TEXT PRIMARY KEY,
  extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(extension_id, permission)
);

CREATE TABLE extensions (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  author TEXT NOT NULL,
  description TEXT DEFAULT '',
  github TEXT NOT NULL,
  homepage TEXT DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  installed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata TEXT DEFAULT '{}'
, install_scope TEXT NOT NULL DEFAULT 'operator', installed_by_user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE, branch TEXT DEFAULT NULL);

CREATE TABLE global_addons (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE image_gen_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  api_url TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  has_api_key INTEGER NOT NULL DEFAULT 0,
  default_parameters TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  original_filename TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  width INTEGER,
  height INTEGER,
  has_thumbnail INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE);

CREATE TABLE loom_items (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'narrative_style',
  author_name TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0.0',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE loom_tools (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  input_schema TEXT NOT NULL DEFAULT '{}',
  result_variable TEXT NOT NULL DEFAULT '',
  store_in_deliberation INTEGER NOT NULL DEFAULT 0,
  author_name TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0.0',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE lumia_items (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  author_name TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  behavior TEXT NOT NULL DEFAULT '',
  gender_identity INTEGER NOT NULL DEFAULT 3,
  version TEXT NOT NULL DEFAULT '1.0.0',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE lumihub_link (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  lumihub_url TEXT NOT NULL,
  ws_url TEXT NOT NULL,
  instance_name TEXT NOT NULL DEFAULT 'My Lumiverse',
  link_token_encrypted TEXT NOT NULL,
  link_token_iv TEXT NOT NULL,
  link_token_tag TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_connected_at TEXT
);

CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  transport_type TEXT NOT NULL DEFAULT 'streamable_http',
  url TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL DEFAULT '',
  args TEXT NOT NULL DEFAULT '[]',
  env TEXT NOT NULL DEFAULT '{}',
  has_headers INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  auto_connect INTEGER NOT NULL DEFAULT 1,
  metadata TEXT NOT NULL DEFAULT '{}',
  last_connected_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE memory_consolidations (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    tier INTEGER NOT NULL DEFAULT 1,
    title TEXT,
    summary TEXT NOT NULL,
    source_chunk_ids TEXT DEFAULT '[]',
    source_consolidation_ids TEXT DEFAULT '[]',
    entity_ids TEXT DEFAULT '[]',
    message_range_start INTEGER,
    message_range_end INTEGER,
    time_range_start INTEGER,
    time_range_end INTEGER,
    salience_avg REAL DEFAULT 0.0,
    emotional_tags TEXT DEFAULT '[]',
    token_count INTEGER DEFAULT 0,
    vectorized_at INTEGER,
    vector_model TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE memory_entities (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'character',
    aliases TEXT DEFAULT '[]',
    description TEXT DEFAULT '',
    first_seen_chunk_id TEXT,
    last_seen_chunk_id TEXT,
    first_seen_at INTEGER,
    last_seen_at INTEGER,
    mention_count INTEGER DEFAULT 0,
    salience_avg REAL DEFAULT 0.0,
    status TEXT DEFAULT 'active',
    status_changed_at INTEGER,
    facts TEXT DEFAULT '[]',
    emotional_valence TEXT DEFAULT '{}',
    metadata TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, fact_extraction_status TEXT DEFAULT 'never', fact_extraction_last_attempt INTEGER, salience_breakdown TEXT DEFAULT '{"mentionComponent":0,"arcComponent":0,"graphComponent":0,"total":0}', last_mention_timestamp INTEGER, recent_mention_count INTEGER DEFAULT 0, confidence TEXT DEFAULT 'confirmed',
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE memory_font_colors (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    entity_id TEXT,
    hex_color TEXT NOT NULL,
    usage_type TEXT DEFAULT 'unknown',
    confidence REAL DEFAULT 0.0,
    sample_count INTEGER DEFAULT 0,
    sample_excerpt TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (entity_id) REFERENCES memory_entities(id) ON DELETE SET NULL
);

CREATE TABLE memory_mentions (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    role TEXT DEFAULT 'present',
    excerpt TEXT,
    sentiment REAL DEFAULT 0.0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES memory_entities(id) ON DELETE CASCADE,
    FOREIGN KEY (chunk_id) REFERENCES chat_chunks(id) ON DELETE CASCADE
);

CREATE TABLE memory_relations (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    relation_label TEXT,
    strength REAL DEFAULT 0.5,
    sentiment REAL DEFAULT 0.0,
    evidence_chunk_ids TEXT DEFAULT '[]',
    first_established_at INTEGER,
    last_reinforced_at INTEGER,
    status TEXT DEFAULT 'active',
    metadata TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, contradiction_flag TEXT DEFAULT 'none', contradiction_peer_id TEXT, sentiment_range TEXT, superseded_by TEXT, arc_ids TEXT DEFAULT '[]', first_seen_arc_id TEXT, last_seen_arc_id TEXT, last_evidence_timestamp INTEGER, decay_rate REAL DEFAULT 0.05, edge_salience REAL DEFAULT 0.0, label_aliases TEXT DEFAULT '[]', canonical_edge_id TEXT, merged_into TEXT,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (source_entity_id) REFERENCES memory_entities(id) ON DELETE CASCADE,
    FOREIGN KEY (target_entity_id) REFERENCES memory_entities(id) ON DELETE CASCADE
);

CREATE TABLE memory_salience (
    id TEXT PRIMARY KEY,
    chunk_id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0.0,
    score_source TEXT DEFAULT 'heuristic',
    emotional_tags TEXT DEFAULT '[]',
    status_changes TEXT DEFAULT '[]',
    narrative_flags TEXT DEFAULT '[]',
    has_dialogue INTEGER DEFAULT 0,
    has_action INTEGER DEFAULT 0,
    has_internal_thought INTEGER DEFAULT 0,
    word_count INTEGER DEFAULT 0,
    scored_at INTEGER NOT NULL,
    scored_by TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (chunk_id) REFERENCES chat_chunks(id) ON DELETE CASCADE
);

CREATE TABLE message_breakdowns (
  message_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  index_in_chat INTEGER NOT NULL,
  is_user INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  send_date INTEGER NOT NULL DEFAULT (unixepoch()),
  swipe_id INTEGER NOT NULL DEFAULT 0,
  swipes TEXT NOT NULL DEFAULT '[]',
  extra TEXT NOT NULL DEFAULT '{}',
  parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  branch_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
, swipe_dates TEXT NOT NULL DEFAULT '[]');

CREATE TABLE packs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  cover_url TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0',
  is_custom INTEGER NOT NULL DEFAULT 1,
  source_url TEXT,
  extras TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  avatar_path TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, attached_world_book_id TEXT REFERENCES world_books(id) ON DELETE SET NULL, image_id TEXT REFERENCES images(id) ON DELETE SET NULL, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE, title TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '', subjective_pronoun TEXT NOT NULL DEFAULT '', objective_pronoun TEXT NOT NULL DEFAULT '', possessive_pronoun TEXT NOT NULL DEFAULT '');

CREATE TABLE presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  parameters TEXT NOT NULL DEFAULT '{}',
  prompt_order TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, prompts TEXT NOT NULL DEFAULT '{}', user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE, engine TEXT NOT NULL DEFAULT 'classic');

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE query_vector_cache (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  query_text TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  hit_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE regex_scripts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  find_regex TEXT NOT NULL,
  replace_string TEXT NOT NULL DEFAULT '',
  flags TEXT NOT NULL DEFAULT 'gi',
  placement TEXT NOT NULL DEFAULT '["ai_output"]',
  scope TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT,
  target TEXT NOT NULL DEFAULT 'response',
  min_depth INTEGER,
  max_depth INTEGER,
  trim_strings TEXT NOT NULL DEFAULT '[]',
  run_on_edit INTEGER NOT NULL DEFAULT 0,
  substitute_macros TEXT NOT NULL DEFAULT 'none',
  disabled INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, folder TEXT NOT NULL DEFAULT '', script_id TEXT NOT NULL DEFAULT '', pack_id TEXT, preset_id TEXT, character_id TEXT);

CREATE TABLE "secrets" (
  key TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  PRIMARY KEY (key, user_id)
);

CREATE TABLE "session" (
  id TEXT PRIMARY KEY NOT NULL,
  expiresAt INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch()),
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE "settings" (
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  PRIMARY KEY (key, user_id)
);

CREATE TABLE theme_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bundle_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  storage_type TEXT NOT NULL,
  image_id TEXT REFERENCES images(id) ON DELETE CASCADE,
  file_name TEXT,
  original_filename TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE tokenizer_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  is_built_in INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE tokenizer_model_patterns (
  id TEXT PRIMARY KEY,
  tokenizer_id TEXT NOT NULL REFERENCES tokenizer_configs(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  is_built_in INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE tts_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  api_url TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  voice TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  has_api_key INTEGER NOT NULL DEFAULT 0,
  default_parameters TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE "user" (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch()),
  username TEXT UNIQUE,
  displayUsername TEXT,
  role TEXT DEFAULT 'user',
  banned INTEGER DEFAULT 0,
  banReason TEXT,
  banExpires INTEGER
);

CREATE TABLE "verification" (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER DEFAULT (unixepoch()),
  updatedAt INTEGER DEFAULT (unixepoch())
);

CREATE TABLE world_book_entries (
  id TEXT PRIMARY KEY,
  world_book_id TEXT NOT NULL REFERENCES world_books(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '[]',
  keysecondary TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 4,
  role TEXT,
  order_value INTEGER NOT NULL DEFAULT 100,
  selective INTEGER NOT NULL DEFAULT 0,
  constant INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  group_name TEXT NOT NULL DEFAULT '',
  group_override INTEGER NOT NULL DEFAULT 0,
  group_weight INTEGER NOT NULL DEFAULT 100,
  probability INTEGER NOT NULL DEFAULT 100,
  scan_depth INTEGER,
  case_sensitive INTEGER NOT NULL DEFAULT 0,
  match_whole_words INTEGER NOT NULL DEFAULT 0,
  automation_id TEXT,
  extensions TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, use_regex INTEGER NOT NULL DEFAULT 0, prevent_recursion INTEGER NOT NULL DEFAULT 0, exclude_recursion INTEGER NOT NULL DEFAULT 0, delay_until_recursion INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 10, sticky INTEGER NOT NULL DEFAULT 0, cooldown INTEGER NOT NULL DEFAULT 0, delay INTEGER NOT NULL DEFAULT 0, selective_logic INTEGER NOT NULL DEFAULT 0, use_probability INTEGER NOT NULL DEFAULT 1, vectorized INTEGER NOT NULL DEFAULT 0, vector_index_status TEXT NOT NULL DEFAULT 'not_enabled', vector_indexed_at INTEGER, vector_index_error TEXT);

CREATE VIRTUAL TABLE world_book_entries_fts USING fts5(
  comment, content, key, keysecondary,
  content='world_book_entries',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TABLE world_books (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE, folder TEXT NOT NULL DEFAULT '');

CREATE INDEX idx_account_userId ON "account"(userId);

CREATE INDEX idx_cc_chat_created_desc
  ON chat_chunks(chat_id, created_at DESC);

CREATE INDEX idx_cc_chat_range ON chat_chunks(chat_id, message_range_start, message_range_end);

CREATE INDEX idx_cc_chat_salience ON chat_chunks(chat_id, salience_score DESC);

CREATE INDEX idx_cc_chat_vectorized_created_desc
  ON chat_chunks(chat_id, created_at DESC)
  WHERE vectorized_at IS NOT NULL;

CREATE INDEX idx_cc_consolidation ON chat_chunks(consolidation_id);

CREATE INDEX idx_ccl_chat ON cortex_chat_links(chat_id);

CREATE INDEX idx_ccl_user ON cortex_chat_links(user_id);

CREATE INDEX idx_character_gallery_lookup
  ON character_gallery(user_id, character_id);

CREATE INDEX idx_characters_image_id ON characters(image_id);

CREATE INDEX idx_characters_user_id ON characters(user_id);

CREATE INDEX idx_characters_user_updated ON characters(user_id, updated_at DESC);

CREATE INDEX idx_chat_chunks_chat ON chat_chunks(chat_id);

CREATE INDEX idx_chat_chunks_end_message ON chat_chunks(end_message_id);

CREATE INDEX idx_chat_chunks_vectorized ON chat_chunks(chat_id, vectorized_at);

CREATE INDEX idx_chats_character_id ON chats(character_id);

CREATE INDEX idx_chats_user_character ON chats(user_id, character_id, updated_at DESC);

CREATE INDEX idx_chats_user_id ON chats(user_id);

CREATE INDEX idx_chats_user_updated ON chats(user_id, updated_at DESC);

CREATE INDEX idx_cmc_chat_updated ON chat_memory_cache(chat_id, updated_at DESC);

CREATE INDEX idx_cmc_user_chat ON chat_memory_cache(user_id, chat_id);

CREATE INDEX idx_connection_profiles_user_id ON connection_profiles(user_id);

CREATE INDEX idx_connection_profiles_user_updated ON connection_profiles(user_id, updated_at DESC);

CREATE INDEX idx_cortex_vaults_user ON cortex_vaults(user_id);

CREATE INDEX idx_cvc_salience ON cortex_vault_chunks(vault_id, salience_score DESC);

CREATE INDEX idx_cvc_vault ON cortex_vault_chunks(vault_id);

CREATE INDEX idx_cve_vault ON cortex_vault_entities(vault_id);

CREATE INDEX idx_cvr_vault ON cortex_vault_relations(vault_id);

CREATE INDEX idx_databank_chunks_bank ON databank_chunks(databank_id);

CREATE INDEX idx_databank_chunks_doc ON databank_chunks(document_id);

CREATE INDEX idx_databank_chunks_user ON databank_chunks(user_id);

CREATE INDEX idx_databank_docs_bank ON databank_documents(databank_id);

CREATE INDEX idx_databank_docs_slug ON databank_documents(user_id, slug);

CREATE INDEX idx_databank_docs_user ON databank_documents(user_id);

CREATE INDEX idx_databanks_scope ON databanks(user_id, scope, scope_id);

CREATE INDEX idx_databanks_user ON databanks(user_id);

CREATE INDEX idx_dw_saved_prompts_user
  ON dream_weaver_saved_prompts(user_id, updated_at DESC);

CREATE INDEX idx_dw_sessions_status ON dream_weaver_sessions(user_id, status);

CREATE INDEX idx_dw_sessions_user ON dream_weaver_sessions(user_id, created_at DESC);

CREATE INDEX idx_extensions_install_scope ON extensions(install_scope);

CREATE INDEX idx_extensions_installed_by_user_id ON extensions(installed_by_user_id);

CREATE INDEX idx_global_addons_user ON global_addons(user_id);

CREATE INDEX idx_igc_default ON image_gen_connections(user_id, is_default);

CREATE INDEX idx_igc_user ON image_gen_connections(user_id);

CREATE INDEX idx_images_user_id ON images(user_id);

CREATE INDEX idx_loom_items_pack_id ON loom_items(pack_id);

CREATE INDEX idx_loom_tools_pack_id ON loom_tools(pack_id);

CREATE INDEX idx_lumia_items_pack_id ON lumia_items(pack_id);

CREATE INDEX idx_mc_chat_range ON memory_consolidations(chat_id, message_range_start, message_range_end);

CREATE INDEX idx_mc_chat_tier ON memory_consolidations(chat_id, tier);

CREATE INDEX idx_mc_vectorized ON memory_consolidations(chat_id, vectorized_at);

CREATE INDEX idx_mcp_servers_enabled ON mcp_servers(user_id, is_enabled);

CREATE INDEX idx_mcp_servers_user ON mcp_servers(user_id);

CREATE INDEX idx_me_chat ON memory_entities(chat_id);

CREATE INDEX idx_me_chat_active_mentions_desc
  ON memory_entities(chat_id, mention_count DESC)
  WHERE status != 'inactive';

CREATE INDEX idx_me_chat_mentions_desc
  ON memory_entities(chat_id, mention_count DESC);

CREATE INDEX idx_me_chat_name ON memory_entities(chat_id, name COLLATE NOCASE);

CREATE INDEX idx_me_chat_type ON memory_entities(chat_id, entity_type);

CREATE INDEX idx_me_confidence ON memory_entities(chat_id, confidence);

CREATE INDEX idx_me_fact_status ON memory_entities(chat_id, fact_extraction_status, salience_avg);

CREATE INDEX idx_me_status ON memory_entities(chat_id, status);

CREATE INDEX idx_message_breakdowns_chat ON message_breakdowns(chat_id);

CREATE INDEX idx_message_breakdowns_user ON message_breakdowns(user_id);

CREATE INDEX idx_messages_chat_id ON messages(chat_id);

CREATE INDEX idx_messages_chat_index ON messages(chat_id, index_in_chat);

CREATE INDEX idx_messages_last_assistant ON messages(chat_id, is_user, index_in_chat DESC);

CREATE INDEX idx_messages_parent ON messages(parent_message_id);

CREATE INDEX idx_mfc_chat ON memory_font_colors(chat_id);

CREATE INDEX idx_mfc_chat_color ON memory_font_colors(chat_id, hex_color);

CREATE INDEX idx_mfc_entity ON memory_font_colors(entity_id);

CREATE INDEX idx_mm_chat_entity ON memory_mentions(chat_id, entity_id);

CREATE INDEX idx_mm_chunk ON memory_mentions(chunk_id);

CREATE INDEX idx_mm_entity ON memory_mentions(entity_id);

CREATE UNIQUE INDEX idx_mm_entity_chunk ON memory_mentions(entity_id, chunk_id);

CREATE INDEX idx_mr_active_source_salience
  ON memory_relations(chat_id, source_entity_id, edge_salience DESC, strength DESC)
  WHERE status = 'active' AND superseded_by IS NULL AND merged_into IS NULL AND contradiction_flag != 'suspect';

CREATE INDEX idx_mr_active_target_salience
  ON memory_relations(chat_id, target_entity_id, edge_salience DESC, strength DESC)
  WHERE status = 'active' AND superseded_by IS NULL AND merged_into IS NULL AND contradiction_flag != 'suspect';

CREATE INDEX idx_mr_chat ON memory_relations(chat_id);

CREATE INDEX idx_mr_contradiction ON memory_relations(chat_id, contradiction_flag);

CREATE INDEX idx_mr_edge_salience ON memory_relations(chat_id, edge_salience);

CREATE INDEX idx_mr_merged ON memory_relations(merged_into);

CREATE UNIQUE INDEX idx_mr_pair_type ON memory_relations(source_entity_id, target_entity_id, relation_type);

CREATE INDEX idx_mr_source ON memory_relations(source_entity_id);

CREATE INDEX idx_mr_target ON memory_relations(target_entity_id);

CREATE INDEX idx_ms_chat ON memory_salience(chat_id);

CREATE INDEX idx_ms_chat_score ON memory_salience(chat_id, score DESC);

CREATE INDEX idx_ms_chunk ON memory_salience(chunk_id);

CREATE INDEX idx_packs_user_id ON packs(user_id);

CREATE INDEX idx_packs_user_updated ON packs(user_id, updated_at DESC);

CREATE INDEX idx_personas_attached_wb ON personas(attached_world_book_id);

CREATE INDEX idx_personas_image_id ON personas(image_id);

CREATE INDEX idx_personas_user_id ON personas(user_id);

CREATE INDEX idx_personas_user_updated ON personas(user_id, updated_at DESC);

CREATE INDEX idx_presets_user_id ON presets(user_id);

CREATE INDEX idx_presets_user_updated ON presets(user_id, updated_at DESC);

CREATE UNIQUE INDEX idx_push_subs_endpoint
  ON push_subscriptions(user_id, endpoint);

CREATE INDEX idx_push_subs_user
  ON push_subscriptions(user_id);

CREATE INDEX idx_query_cache_chat_hash ON query_vector_cache(chat_id, query_hash);

CREATE UNIQUE INDEX idx_query_cache_chat_hash_unique ON query_vector_cache(chat_id, query_hash);

CREATE INDEX idx_query_cache_expires ON query_vector_cache(expires_at);

CREATE INDEX idx_regex_scripts_character ON regex_scripts(character_id);

CREATE INDEX idx_regex_scripts_pack ON regex_scripts(pack_id);

CREATE INDEX idx_regex_scripts_preset ON regex_scripts(preset_id);

CREATE INDEX idx_regex_scripts_scope
  ON regex_scripts(user_id, scope, scope_id);

CREATE UNIQUE INDEX idx_regex_scripts_script_id
  ON regex_scripts(user_id, script_id)
  WHERE script_id != '';

CREATE INDEX idx_regex_scripts_user_sort
  ON regex_scripts(user_id, sort_order ASC, created_at ASC);

CREATE INDEX idx_secrets_user_id ON secrets(user_id);

CREATE INDEX idx_session_token ON "session"(token);

CREATE INDEX idx_session_userId ON "session"(userId);

CREATE INDEX idx_settings_user_id ON settings(user_id);

CREATE INDEX idx_theme_assets_image_id
  ON theme_assets(image_id);

CREATE INDEX idx_theme_assets_user_bundle
  ON theme_assets(user_id, bundle_id);

CREATE UNIQUE INDEX idx_theme_assets_user_bundle_slug
  ON theme_assets(user_id, bundle_id, slug);

CREATE INDEX idx_tokenizer_model_patterns_priority ON tokenizer_model_patterns(priority DESC);

CREATE INDEX idx_tokenizer_model_patterns_tokenizer ON tokenizer_model_patterns(tokenizer_id);

CREATE INDEX idx_ttsc_default ON tts_connections(user_id, is_default);

CREATE INDEX idx_ttsc_user ON tts_connections(user_id);

CREATE INDEX idx_wbe_world_book_id ON world_book_entries(world_book_id);

CREATE INDEX idx_wbe_world_book_vector_index_status
ON world_book_entries(world_book_id, vector_index_status);

CREATE INDEX idx_wbe_world_book_vectorized ON world_book_entries(world_book_id, vectorized);

CREATE INDEX idx_world_books_user_id ON world_books(user_id);

CREATE TRIGGER characters_fts_delete BEFORE DELETE ON characters BEGIN
  INSERT INTO characters_fts(characters_fts, rowid, name, creator, tags)
    VALUES ('delete', old.rowid, old.name, old.creator, old.tags);
END;

CREATE TRIGGER characters_fts_insert AFTER INSERT ON characters BEGIN
  INSERT INTO characters_fts(rowid, name, creator, tags)
    VALUES (new.rowid, new.name, new.creator, new.tags);
END;

CREATE TRIGGER characters_fts_update BEFORE UPDATE ON characters BEGIN
  INSERT INTO characters_fts(characters_fts, rowid, name, creator, tags)
    VALUES ('delete', old.rowid, old.name, old.creator, old.tags);
END;

CREATE TRIGGER characters_fts_update_after AFTER UPDATE ON characters BEGIN
  INSERT INTO characters_fts(rowid, name, creator, tags)
    VALUES (new.rowid, new.name, new.creator, new.tags);
END;

CREATE TRIGGER world_book_entries_fts_delete BEFORE DELETE ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(world_book_entries_fts, rowid, comment, content, key, keysecondary)
    VALUES ('delete', old.rowid, old.comment, old.content, old.key, old.keysecondary);
END;

CREATE TRIGGER world_book_entries_fts_insert AFTER INSERT ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(rowid, comment, content, key, keysecondary)
    VALUES (new.rowid, new.comment, new.content, new.key, new.keysecondary);
END;

CREATE TRIGGER world_book_entries_fts_update BEFORE UPDATE ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(world_book_entries_fts, rowid, comment, content, key, keysecondary)
    VALUES ('delete', old.rowid, old.comment, old.content, old.key, old.keysecondary);
END;

CREATE TRIGGER world_book_entries_fts_update_after AFTER UPDATE ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(rowid, comment, content, key, keysecondary)
    VALUES (new.rowid, new.comment, new.content, new.key, new.keysecondary);
END;
