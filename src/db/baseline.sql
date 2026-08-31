-- Lumiverse Database Baseline Schema
-- Generated from migrations 001 through 135.
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

CREATE TABLE audio_files (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  original_filename TEXT NOT NULL DEFAULT '',
  mime_type     TEXT NOT NULL DEFAULT '',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
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
, image_id TEXT REFERENCES images(id) ON DELETE SET NULL, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE, deleting INTEGER NOT NULL DEFAULT 0, folder TEXT NOT NULL DEFAULT '', library_scope TEXT NOT NULL DEFAULT 'mine' CHECK(library_scope IN ('mine', 'shared')));

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
  updated_at INTEGER NOT NULL, salience_score REAL DEFAULT NULL, emotional_tags TEXT DEFAULT NULL, entity_ids TEXT DEFAULT NULL, consolidation_id TEXT DEFAULT NULL, message_range_start INTEGER DEFAULT NULL, message_range_end INTEGER DEFAULT NULL, cortex_warmup_signature TEXT DEFAULT NULL, cortex_warmup_completed_at INTEGER DEFAULT NULL,
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

CREATE TABLE "chats" (
  id TEXT PRIMARY KEY,
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE
);

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

CREATE TABLE dream_weaver_messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  tool_name     TEXT,
  status        TEXT,
  supersedes_id TEXT,
  FOREIGN KEY (session_id) REFERENCES dream_weaver_sessions(id) ON DELETE CASCADE
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
  session_number INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  dream_text TEXT NOT NULL DEFAULT '',
  tone TEXT,
  constraints TEXT,
  dislikes TEXT,
  persona_id TEXT,
  connection_id TEXT,
  model TEXT,
  draft TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  workspace_kind TEXT NOT NULL DEFAULT 'character',
  character_id TEXT,
  launch_chat_id TEXT,
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
  scope TEXT NOT NULL DEFAULT 'system',
  UNIQUE(extension_id, permission, scope)
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

CREATE TABLE generation_outbox (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  branch_chat_id TEXT NOT NULL,
  edited_message_id TEXT NOT NULL,
  target_message_id TEXT,
  target_swipe_index INTEGER,
  expected_version INTEGER NOT NULL,
  generation_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('normal', 'swipe')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  terminal_reason TEXT,
  dispatched_at INTEGER,
  completed_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Added by migrations/111_generation_outbox_connection_id.sql. MUST stay the
  -- LAST column: `ALTER TABLE ADD COLUMN` appends at the highest `cid`, and
  -- `src/db/migrate.baseline-sync.test.ts` compares raw `PRAGMA table_info`
  -- output (cid included) between a fresh-from-baseline database and a fully
  -- migrated one.
  connection_id TEXT
);

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

CREATE TABLE illarin_instance (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  illarin_url TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  instance_name TEXT NOT NULL,
  application_name TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  access_token_encrypted TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  access_token_tag TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  refresh_token_tag TEXT NOT NULL,
  last_declaration_json TEXT,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_refresh_at TEXT
);

CREATE TABLE illarin_delivery_receipt (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  content_generation INTEGER NOT NULL,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at TEXT,
  PRIMARY KEY (user_id, delivery_id)
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

CREATE TABLE image_processing_queue (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
  UNIQUE (image_id, kind)
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
, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE, owner_extension_identifier TEXT, owner_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL, owner_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL, byte_size INTEGER NOT NULL DEFAULT 0, skip_thumbnail_processing INTEGER NOT NULL DEFAULT 0);

CREATE TABLE import_consumed_tickets (
  archive_id  TEXT PRIMARY KEY,
  consumed_at INTEGER NOT NULL,
  user_id     TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  uses        INTEGER NOT NULL DEFAULT 1
);

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
, share_usage_stats INTEGER NOT NULL DEFAULT 0, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE);

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
    updated_at INTEGER NOT NULL, fact_extraction_status TEXT DEFAULT 'never', fact_extraction_last_attempt INTEGER, salience_breakdown TEXT DEFAULT '{"mentionComponent":0,"arcComponent":0,"graphComponent":0,"total":0}', last_mention_timestamp INTEGER, recent_mention_count INTEGER DEFAULT 0, confidence TEXT DEFAULT 'confirmed', user_edited_at INTEGER, salience_peak REAL DEFAULT 0.0,
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
    updated_at INTEGER NOT NULL, contradiction_flag TEXT DEFAULT 'none', contradiction_peer_id TEXT, sentiment_range TEXT, superseded_by TEXT, arc_ids TEXT DEFAULT '[]', first_seen_arc_id TEXT, last_seen_arc_id TEXT, last_evidence_timestamp INTEGER, decay_rate REAL DEFAULT 0.05, edge_salience REAL DEFAULT 0.0, label_aliases TEXT DEFAULT '[]', canonical_edge_id TEXT, merged_into TEXT, user_edited_at INTEGER,
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
, swipe_dates TEXT NOT NULL DEFAULT '[]'
, revision INTEGER NOT NULL DEFAULT 1);

CREATE TABLE edit_and_send_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  branch_chat_id TEXT NOT NULL,
  edited_message_id TEXT NOT NULL,
  target_message_id TEXT,
  target_swipe_index INTEGER,
  generation_id TEXT NOT NULL,
  response TEXT NOT NULL,
  cursor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, chat_id, request_id)
);

CREATE TABLE multiplayer_bans (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES multiplayer_rooms(id) ON DELETE CASCADE,
  identity_kind TEXT NOT NULL,                                        -- mirrors participants
  identity_ref  TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  reason        TEXT NOT NULL DEFAULT '',
  banned_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE multiplayer_participants (
  id               TEXT PRIMARY KEY,                                  -- participant id; also the author key stamped on messages.extra.mp
  room_id          TEXT NOT NULL REFERENCES multiplayer_rooms(id) ON DELETE CASCADE,
  role             TEXT NOT NULL DEFAULT 'peer',                      -- 'host' | 'peer'
  identity_kind    TEXT NOT NULL,                                     -- 'user' | 'token'
  identity_ref     TEXT NOT NULL,                                     -- user_id (local account) OR token subject (remote peer)
  display_name     TEXT NOT NULL DEFAULT '',                          -- peer-supplied, validated, UNTRUSTED
  persona_snapshot TEXT NOT NULL DEFAULT '{}',                        -- JSON frozen copy {name, description, pronouns?, avatarUrl?}
  status           TEXT NOT NULL DEFAULT 'active',                    -- 'active' | 'left' | 'kicked'
  joined_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE multiplayer_rooms (
  id                          TEXT PRIMARY KEY,
  chat_id                     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  host_user_id                TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  status                      TEXT NOT NULL DEFAULT 'open',          -- 'open' | 'locked' | 'closed'
  turn_strategy               TEXT NOT NULL DEFAULT 'round_robin',   -- 'round_robin' | 'freeform'
  freeform_deadline           INTEGER,                                -- unixepoch sec; null unless a freeform window is open
  turn_order                  TEXT NOT NULL DEFAULT '[]',            -- JSON array of participant ids (host-managed sequence)
  current_turn_participant_id TEXT,                                   -- round_robin: whose turn (always = turn_order[turn_index])
  turn_index                  INTEGER NOT NULL DEFAULT 0,
  round_counter               INTEGER NOT NULL DEFAULT 0,
  settings                    TEXT NOT NULL DEFAULT '{}',            -- JSON: maxPeers (<=8), freeformWindowSec, ...
  created_at                  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at                  INTEGER NOT NULL DEFAULT (unixepoch())
);

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
, attached_world_book_id TEXT REFERENCES world_books(id) ON DELETE SET NULL, image_id TEXT REFERENCES images(id) ON DELETE SET NULL, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE, title TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '', subjective_pronoun TEXT NOT NULL DEFAULT '', objective_pronoun TEXT NOT NULL DEFAULT '', possessive_pronoun TEXT NOT NULL DEFAULT '', is_narrator INTEGER NOT NULL DEFAULT 0, reflexive_pronoun TEXT NOT NULL DEFAULT '', possessive_pronoun_standalone TEXT NOT NULL DEFAULT '');

CREATE TABLE presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  parameters TEXT NOT NULL DEFAULT '{}',
  prompt_order TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, prompts TEXT NOT NULL DEFAULT '{}', user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE, engine TEXT NOT NULL DEFAULT 'classic', cache_revision INTEGER NOT NULL DEFAULT 0);

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
, folder TEXT NOT NULL DEFAULT '', script_id TEXT NOT NULL DEFAULT '', pack_id TEXT, preset_id TEXT, character_id TEXT, actions TEXT NOT NULL DEFAULT '[]', owner_extension_identifier TEXT);

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

CREATE TABLE sso_providers (
  id                      TEXT PRIMARY KEY,
  provider_kind           TEXT NOT NULL, -- 'authelia' | 'authentik' | 'keycloak' | 'custom_oidc'
  name                    TEXT NOT NULL,
  slug                    TEXT NOT NULL UNIQUE,
  enabled                 INTEGER NOT NULL DEFAULT 0,
  issuer_url              TEXT NOT NULL DEFAULT '',
  discovery_url           TEXT NOT NULL DEFAULT '',
  client_id               TEXT NOT NULL DEFAULT '',
  encrypted_client_secret TEXT,
  client_secret_iv        TEXT,
  client_secret_tag       TEXT,
  scopes                  TEXT NOT NULL DEFAULT '["openid","profile","email"]',
  pkce                    INTEGER NOT NULL DEFAULT 1,
  allow_signup            INTEGER NOT NULL DEFAULT 0,
  metadata                TEXT NOT NULL DEFAULT '{}',
  created_at              INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at              INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE stream_deck_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["characters:read","chats:read"]',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER
);

CREATE TABLE stt_connections (
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

CREATE TABLE weaver_bible (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  spine TEXT NOT NULL DEFAULT '{}',            -- JSON: VEJA + links + contradiction + stance
  status TEXT NOT NULL DEFAULT 'pending',      -- pending|gated|flagged
  gated_at INTEGER, gate TEXT NOT NULL DEFAULT '{}', token_usage TEXT NOT NULL DEFAULT '{}', updated_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES weaver_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE weaver_extraction (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  committed_facts TEXT NOT NULL DEFAULT '[]', -- JSON, slot-tagged
  gaps TEXT NOT NULL DEFAULT '[]',            -- JSON
  edited_at INTEGER NOT NULL DEFAULT (unixepoch()), dynamic_questions TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (session_id) REFERENCES weaver_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE weaver_fields (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',      -- pending|streaming|passed|flagged|stale|manually_edited
  provenance TEXT NOT NULL DEFAULT '{}',       -- JSON: link back to bible
  token_usage TEXT NOT NULL DEFAULT '{}',      -- JSON
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (session_id) REFERENCES weaver_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE weaver_interview_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  slot TEXT NOT NULL,
  axis TEXT NOT NULL DEFAULT '{}',            -- JSON: the spread offered
  response_kind TEXT,                          -- pick|blend|redirect|typed|inferred
  response TEXT NOT NULL DEFAULT '{}',         -- JSON
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (session_id) REFERENCES weaver_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE "weaver_people" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,                   -- the world session
  name TEXT NOT NULL,
  hook TEXT NOT NULL DEFAULT '',              -- the one-line hook
  origin TEXT NOT NULL DEFAULT 'proposed',    -- proposed|manual
  tier TEXT NOT NULL DEFAULT 'unfleshed',     -- unfleshed|extra|named
  interview TEXT NOT NULL DEFAULT '[]',       -- JSON: Named-weave Q&A, provenance-kinded
  npc_entry_id TEXT,                          -- the NPC-book entry once fleshed
  promoted_session_id TEXT,                   -- the character session promotion opened
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (session_id) REFERENCES weaver_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE weaver_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_number INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  seed_type TEXT NOT NULL DEFAULT 'dream',
  seed_text TEXT NOT NULL DEFAULT '',
  seed_provenance TEXT NOT NULL DEFAULT '{}', -- JSON

  -- Studio flow
  stage TEXT NOT NULL DEFAULT 'dream',        -- dream|readback|interview|bible|render|finalize
  status TEXT NOT NULL DEFAULT 'draft',        -- draft|interviewing|bible|rendering|finalized

  -- Generation context
  connection_id TEXT,
  model TEXT,
  persona_id TEXT,

  -- Output (set on finalize)
  character_id TEXT,
  launch_chat_id TEXT, interview_started_at INTEGER, interview_completed_at INTEGER, build_type TEXT NOT NULL DEFAULT 'character', narration_mode TEXT, persona_plan TEXT,
  taste_profile TEXT NOT NULL DEFAULT '{}',

  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL,
  FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
);

CREATE TABLE weaver_taste (
  user_id TEXT PRIMARY KEY,
  profile TEXT NOT NULL DEFAULT '{}',          -- JSON
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
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
, use_regex INTEGER NOT NULL DEFAULT 0, prevent_recursion INTEGER NOT NULL DEFAULT 0, exclude_recursion INTEGER NOT NULL DEFAULT 0, delay_until_recursion INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 10, sticky INTEGER NOT NULL DEFAULT 0, cooldown INTEGER NOT NULL DEFAULT 0, delay INTEGER NOT NULL DEFAULT 0, selective_logic INTEGER NOT NULL DEFAULT 0, use_probability INTEGER NOT NULL DEFAULT 1, vectorized INTEGER NOT NULL DEFAULT 0, vector_index_status TEXT NOT NULL DEFAULT 'not_enabled', vector_indexed_at INTEGER, vector_index_error TEXT, exclude_greeting INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1);

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

CREATE INDEX idx_account_provider_account
  ON account(providerId, accountId);

CREATE INDEX idx_account_userId ON "account"(userId);

CREATE INDEX idx_account_user_provider
  ON account(userId, providerId);

CREATE INDEX idx_audio_files_user ON audio_files(user_id);

CREATE INDEX idx_cc_chat_cortex_warmup
  ON chat_chunks(chat_id, cortex_warmup_signature, created_at);

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

CREATE INDEX idx_characters_user_library_scope
  ON characters(user_id, library_scope);

CREATE INDEX idx_characters_user_library_scope_updated
  ON characters(user_id, library_scope, updated_at DESC);

CREATE INDEX idx_characters_user_source_filename
  ON characters(user_id, json_extract(extensions, '$._lumiverse_source_filename'));
CREATE INDEX idx_characters_user_updated ON characters(user_id, updated_at DESC);

CREATE INDEX idx_chat_chunks_chat ON chat_chunks(chat_id);

CREATE INDEX idx_chat_chunks_end_message ON chat_chunks(end_message_id);

CREATE INDEX idx_chat_chunks_vectorized ON chat_chunks(chat_id, vectorized_at);

CREATE INDEX idx_chats_character_id ON chats(character_id);

CREATE INDEX idx_chats_user_character ON chats(user_id, character_id, updated_at DESC);

CREATE INDEX idx_chats_user_id ON chats(user_id);

CREATE INDEX idx_chats_user_source_filename
  ON chats(user_id, json_extract(metadata, '$._lumiverse_source_filename'));

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

CREATE INDEX idx_dw_sessions_status
  ON dream_weaver_sessions(user_id, status);

CREATE INDEX idx_dw_sessions_user
  ON dream_weaver_sessions(user_id, created_at DESC);

CREATE UNIQUE INDEX idx_dw_sessions_user_number
  ON dream_weaver_sessions(user_id, session_number);

CREATE INDEX idx_dwm_session_seq
  ON dream_weaver_messages(session_id, seq);

CREATE INDEX idx_dwm_session_status
  ON dream_weaver_messages(session_id, status)
  WHERE kind = 'tool_card';

CREATE INDEX idx_extension_grants_scope
  ON extension_grants(extension_id, scope);

CREATE INDEX idx_extensions_install_scope ON extensions(install_scope);

CREATE INDEX idx_extensions_installed_by_user_id ON extensions(installed_by_user_id);

CREATE INDEX idx_generation_outbox_request
  ON generation_outbox(user_id, chat_id, request_id);

CREATE INDEX idx_generation_outbox_status_next
  ON generation_outbox(status, next_attempt_at);

CREATE INDEX idx_global_addons_user ON global_addons(user_id);

CREATE INDEX idx_ict_user_consumed
  ON import_consumed_tickets(user_id, consumed_at DESC);

CREATE INDEX idx_igc_default ON image_gen_connections(user_id, is_default);

CREATE INDEX idx_igc_user ON image_gen_connections(user_id);

CREATE INDEX idx_image_processing_queue_user_created
  ON image_processing_queue(user_id, created_at);

CREATE INDEX idx_images_user_id ON images(user_id);

CREATE INDEX idx_images_user_owner_character
  ON images(user_id, owner_character_id, created_at DESC);

CREATE INDEX idx_images_user_owner_chat
  ON images(user_id, owner_chat_id, created_at DESC);

CREATE INDEX idx_images_user_owner_extension
  ON images(user_id, owner_extension_identifier, created_at DESC);

CREATE UNIQUE INDEX idx_illarin_instance_user_id
ON illarin_instance(user_id);

CREATE INDEX idx_illarin_delivery_receipt_pending
ON illarin_delivery_receipt(user_id, instance_id, acknowledged_at);

CREATE INDEX idx_loom_items_pack_id ON loom_items(pack_id);

CREATE INDEX idx_loom_tools_pack_id ON loom_tools(pack_id);

CREATE INDEX idx_lumia_items_pack_id ON lumia_items(pack_id);

CREATE UNIQUE INDEX idx_lumihub_link_user_id
ON lumihub_link(user_id);

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

CREATE INDEX idx_me_user_edited ON memory_entities(chat_id)
  WHERE user_edited_at IS NOT NULL;

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

CREATE UNIQUE INDEX idx_mp_bans_identity
  ON multiplayer_bans(room_id, identity_kind, identity_ref);

CREATE UNIQUE INDEX idx_mp_participants_identity
  ON multiplayer_participants(room_id, identity_kind, identity_ref);

CREATE INDEX idx_mp_participants_room ON multiplayer_participants(room_id, status);

CREATE UNIQUE INDEX idx_mp_rooms_chat ON multiplayer_rooms(chat_id);

CREATE INDEX idx_mp_rooms_host ON multiplayer_rooms(host_user_id);

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

CREATE INDEX idx_mr_user_edited ON memory_relations(chat_id)
  WHERE user_edited_at IS NOT NULL;

CREATE INDEX idx_ms_chat ON memory_salience(chat_id);

CREATE INDEX idx_ms_chat_score ON memory_salience(chat_id, score DESC);

CREATE INDEX idx_ms_chunk ON memory_salience(chunk_id);

CREATE INDEX idx_packs_user_id ON packs(user_id);

CREATE INDEX idx_packs_user_updated ON packs(user_id, updated_at DESC);

CREATE INDEX idx_personas_attached_wb ON personas(attached_world_book_id);

CREATE INDEX idx_personas_image_id ON personas(image_id);

CREATE INDEX idx_personas_user_id ON personas(user_id);

CREATE INDEX idx_personas_user_source_filename
  ON personas(user_id, json_extract(metadata, '$._lumiverse_source_filename'));

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

CREATE INDEX idx_regex_scripts_extension_owner
  ON regex_scripts(user_id, owner_extension_identifier)
  WHERE owner_extension_identifier IS NOT NULL;

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

CREATE INDEX idx_sso_providers_enabled ON sso_providers(enabled);

CREATE INDEX idx_stream_deck_tokens_user
ON stream_deck_tokens(user_id, created_at DESC);

CREATE INDEX idx_sttc_default ON stt_connections(user_id, is_default);

CREATE INDEX idx_sttc_user ON stt_connections(user_id);

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

CREATE INDEX idx_wbe_world_book_order
  ON world_book_entries(world_book_id, order_value, id);

CREATE INDEX idx_wbe_world_book_vector_index_status
ON world_book_entries(world_book_id, vector_index_status);

CREATE INDEX idx_wbe_world_book_vectorized ON world_book_entries(world_book_id, vectorized);

CREATE INDEX idx_weaver_fields_session ON weaver_fields(session_id, field_name);

CREATE INDEX idx_weaver_people_session ON weaver_people(user_id, session_id);

CREATE INDEX idx_weaver_sessions_status ON weaver_sessions(user_id, status);

CREATE INDEX idx_weaver_sessions_user ON weaver_sessions(user_id, updated_at DESC);

CREATE INDEX idx_weaver_turns_session ON weaver_interview_turns(session_id, seq);

CREATE INDEX idx_world_books_user_id ON world_books(user_id);

CREATE INDEX idx_world_books_user_source_filename
  ON world_books(user_id, json_extract(metadata, '$._lumiverse_source_filename'));

CREATE TRIGGER characters_fts_delete BEFORE DELETE ON characters BEGIN
  INSERT INTO characters_fts(characters_fts, rowid, name, creator, tags)
    VALUES ('delete', old.rowid, old.name, old.creator, old.tags);
END;

CREATE TRIGGER characters_fts_insert AFTER INSERT ON characters BEGIN
  INSERT INTO characters_fts(rowid, name, creator, tags)
    VALUES (new.rowid, new.name, new.creator, new.tags);
END;

CREATE TRIGGER characters_fts_update
BEFORE UPDATE OF name, creator, tags ON characters BEGIN
  INSERT INTO characters_fts(characters_fts, rowid, name, creator, tags)
    VALUES ('delete', old.rowid, old.name, old.creator, old.tags);
END;

CREATE TRIGGER characters_fts_update_after
AFTER UPDATE OF name, creator, tags ON characters BEGIN
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
CREATE TABLE IF NOT EXISTS agent_run_attempts (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  previous_attempt_id TEXT,
  run_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  generation_type TEXT NOT NULL CHECK(generation_type IN ('normal', 'continue', 'regenerate', 'swipe')),
  target_message_id TEXT,
  target_swipe_id INTEGER CHECK(target_swipe_id IS NULL OR target_swipe_id >= 0),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'stopped', 'failed', 'exhausted', 'rejected')),
  reason TEXT NOT NULL DEFAULT 'none' CHECK(length(reason) <= 128),
  terminal INTEGER NOT NULL DEFAULT 0 CHECK(terminal IN (0, 1)),
  started_at INTEGER NOT NULL CHECK(started_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= 0),
  host_correlation_id TEXT NOT NULL CHECK(length(host_correlation_id) BETWEEN 1 AND 256),
  reconciliation_state TEXT NOT NULL DEFAULT 'authoritative' CHECK(reconciliation_state IN ('authoritative', 'reconciling', 'recovered', 'stale')),
  terminal_receipt_json TEXT CHECK(terminal_receipt_json IS NULL OR length(terminal_receipt_json) <= 16384),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version = 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(user_id, attempt_id),
  UNIQUE(user_id, run_id),
  UNIQUE(user_id, host_correlation_id),
  FOREIGN KEY (user_id, previous_attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE SET NULL,
  FOREIGN KEY (target_message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_chat_updated
  ON agent_run_attempts(user_id, chat_id, updated_at DESC, attempt_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_chat_target
  ON agent_run_attempts(user_id, chat_id, target_message_id, target_swipe_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_previous
  ON agent_run_attempts(user_id, previous_attempt_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_terminal
  ON agent_run_attempts(user_id, chat_id, terminal, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_audit_records (
  record_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('transcript', 'turn_session', 'activity', 'marker', 'usage', 'prompt', 'cortex', 'council', 'workspace', 'stop', 'recovery')),
  event_id TEXT,
  causal_parent_id TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
  late INTEGER NOT NULL DEFAULT 0 CHECK(late IN (0, 1)),
  payload_json TEXT NOT NULL CHECK(length(payload_json) <= 131072),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0 AND byte_size <= 131072),
  dedupe_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_audit_attempt_sequence
  ON agent_run_audit_records(user_id, attempt_id, host_sequence, record_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_audit_chat_time
  ON agent_run_audit_records(user_id, chat_id, occurred_at, record_id);

CREATE TABLE IF NOT EXISTS agent_run_turn_session_entries (
  entry_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  entry_kind TEXT NOT NULL CHECK(entry_kind IN ('target', 'input', 'policy', 'condition', 'hook', 'cancellation', 'completion', 'commit', 'terminal', 'retry', 'recovery')),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
  detail_json TEXT NOT NULL CHECK(length(detail_json) <= 65536),
  transcript_links_json TEXT NOT NULL DEFAULT '[]' CHECK(length(transcript_links_json) <= 8192),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, host_sequence, entry_kind)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_turn_session_entries_order
  ON agent_run_turn_session_entries(user_id, attempt_id, host_sequence, entry_id);

CREATE TABLE IF NOT EXISTS agent_run_activity_nodes (
  node_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  parent_node_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('root', 'provider', 'child', 'tool', 'milestone')),
  actor TEXT NOT NULL CHECK(actor IN ('host', 'owner', 'provider', 'agent', 'child', 'tool')),
  phase TEXT NOT NULL CHECK(phase IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal', 'omitted')),
  safe_label TEXT NOT NULL CHECK(length(safe_label) BETWEEN 1 AND 256),
  tool_id TEXT,
  task_id TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  started_at INTEGER NOT NULL CHECK(started_at >= 0),
  ended_at INTEGER CHECK(ended_at IS NULL OR ended_at >= started_at),
  elapsed_ms INTEGER CHECK(elapsed_ms IS NULL OR elapsed_ms >= 0),
  usage_json TEXT CHECK(usage_json IS NULL OR length(usage_json) <= 8192),
  detail_json TEXT CHECK(detail_json IS NULL OR length(detail_json) <= 16384),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_activity_nodes_order
  ON agent_run_activity_nodes(user_id, attempt_id, host_sequence, node_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_activity_nodes_target
  ON agent_run_activity_nodes(user_id, chat_id, attempt_id, kind, host_sequence);

CREATE TABLE IF NOT EXISTS agent_run_inspection_markers (
  marker_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  marker_kind TEXT NOT NULL CHECK(marker_kind IN ('reconnect_gap', 'late_event', 'reordered_event', 'truncated', 'unavailable', 'credentials_withheld', 'other_user_data_withheld', 'recovered_duplicate')),
  scope TEXT NOT NULL CHECK(scope IN ('run', 'activity', 'transcript', 'turn_session', 'usage', 'prompt', 'cortex', 'council', 'workspace')),
  host_sequence INTEGER,
  first_sequence INTEGER,
  last_sequence INTEGER,
  recoverable INTEGER CHECK(recoverable IS NULL OR recoverable IN (0, 1)),
  detail TEXT CHECK(detail IS NULL OR length(detail) <= 2048),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, marker_kind, scope, host_sequence)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_inspection_markers_order
  ON agent_run_inspection_markers(user_id, attempt_id, COALESCE(host_sequence, 0), marker_id);

CREATE TABLE IF NOT EXISTS agent_run_usage_evidence (
  usage_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('provider_reported', 'provisional', 'final', 'recovered_duplicate')),
  actor_id TEXT,
  phase TEXT,
  tool_id TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(total_tokens >= 0),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls >= 0),
  child_invocations INTEGER NOT NULL DEFAULT 0 CHECK(child_invocations >= 0),
  canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, usage_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_usage_attempt
  ON agent_run_usage_evidence(user_id, attempt_id, host_sequence, usage_id);

CREATE TABLE IF NOT EXISTS agent_run_prompt_evidence (
  prompt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 256),
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  destination TEXT NOT NULL CHECK(destination IN ('root_work', 'child_work', 'completion_handoff', 'render', 'council', 'cortex')),
  role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool', 'context', 'policy')),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  included INTEGER NOT NULL CHECK(included IN (0, 1)),
  content TEXT NOT NULL CHECK(length(content) <= 65536),
  content_digest TEXT NOT NULL CHECK(length(content_digest) = 64),
  omission_reason TEXT CHECK(omission_reason IS NULL OR length(omission_reason) <= 512),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, prompt_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_prompt_attempt
  ON agent_run_prompt_evidence(user_id, attempt_id, host_sequence, prompt_id);

CREATE TABLE IF NOT EXISTS agent_run_cortex_receipts (
  receipt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 256),
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  state TEXT NOT NULL CHECK(state IN ('accepted', 'omitted', 'failed', 'cancelled')),
  result_digest TEXT,
  result_count INTEGER NOT NULL DEFAULT 0 CHECK(result_count >= 0),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  reason TEXT CHECK(reason IS NULL OR length(reason) <= 512),
  canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical = 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, receipt_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_cortex_attempt
  ON agent_run_cortex_receipts(user_id, attempt_id, host_sequence, receipt_id);

CREATE TABLE IF NOT EXISTS agent_run_council_receipts (
  receipt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('accepted', 'omitted', 'failed', 'cancelled')),
  member_count INTEGER NOT NULL DEFAULT 0 CHECK(member_count >= 0),
  result_digest TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  reason TEXT CHECK(reason IS NULL OR length(reason) <= 512),
  canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical = 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, receipt_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_council_attempt
  ON agent_run_council_receipts(user_id, attempt_id, host_sequence, receipt_id);

CREATE TABLE IF NOT EXISTS agent_run_workspace_associations (
  association_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision >= 0),
  relation TEXT NOT NULL CHECK(relation IN ('linked', 'published', 'omitted')),
  object_kind TEXT NOT NULL CHECK(object_kind IN ('objective', 'task', 'finding', 'decision', 'question', 'submission', 'artifact', 'publication')),
  object_id TEXT,
  source_revision INTEGER,
  source_deleted INTEGER NOT NULL DEFAULT 0 CHECK(source_deleted IN (0, 1)),
  provenance_digest TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, association_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_workspace_associations_attempt
  ON agent_run_workspace_associations(user_id, attempt_id, host_sequence, association_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_workspace_associations_workspace
  ON agent_run_workspace_associations(user_id, workspace_id, workspace_revision);

CREATE TABLE persistent_workspaces (
  workspace_id TEXT PRIMARY KEY CHECK(length(workspace_id) BETWEEN 1 AND 128),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  objective TEXT NOT NULL DEFAULT '' CHECK(length(objective) <= 65536),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(length(metadata_json) <= 32768 AND json_valid(metadata_json)),
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK(length(progress_json) <= 16384 AND json_valid(progress_json)),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  quota_tasks INTEGER NOT NULL DEFAULT 256 CHECK(quota_tasks BETWEEN 0 AND 256),
  quota_records INTEGER NOT NULL DEFAULT 1024 CHECK(quota_records BETWEEN 0 AND 1024),
  quota_submissions INTEGER NOT NULL DEFAULT 1024 CHECK(quota_submissions BETWEEN 0 AND 1024),
  quota_artifacts INTEGER NOT NULL DEFAULT 256 CHECK(quota_artifacts BETWEEN 0 AND 256),
  quota_publications INTEGER NOT NULL DEFAULT 512 CHECK(quota_publications BETWEEN 0 AND 512),
  quota_bytes INTEGER NOT NULL DEFAULT 4194304 CHECK(quota_bytes BETWEEN 0 AND 4194304),
  task_count INTEGER NOT NULL DEFAULT 0 CHECK(task_count >= 0),
  record_count INTEGER NOT NULL DEFAULT 0 CHECK(record_count >= 0),
  submission_count INTEGER NOT NULL DEFAULT 0 CHECK(submission_count >= 0),
  artifact_count INTEGER NOT NULL DEFAULT 0 CHECK(artifact_count >= 0),
  publication_count INTEGER NOT NULL DEFAULT 0 CHECK(publication_count >= 0),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, workspace_id),
  UNIQUE(user_id, chat_id)
);

CREATE TABLE persistent_workspace_turn_sessions (
  turn_session_id TEXT PRIMARY KEY CHECK(length(turn_session_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 128),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 128),
  execution_id TEXT CHECK(execution_id IS NULL OR length(execution_id) BETWEEN 1 AND 128),
  phase TEXT NOT NULL DEFAULT 'ADMIT' CHECK(phase IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'stopped', 'failed', 'exhausted', 'rejected')),
  reason TEXT NOT NULL DEFAULT 'none' CHECK(length(reason) <= 128),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  terminal_at INTEGER,
  UNIQUE(user_id, turn_id, attempt_id),
  UNIQUE(workspace_id, turn_id, attempt_id),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE persistent_workspace_tasks (
  task_id TEXT PRIMARY KEY CHECK(length(task_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 4096),
  objective TEXT NOT NULL DEFAULT '' CHECK(length(objective) <= 65536),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'active', 'blocked', 'completed', 'cancelled', 'failed')),
  required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0, 1)),
  dependency_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(length(dependency_ids_json) <= 65536 AND json_valid(dependency_ids_json)),
  creator TEXT NOT NULL DEFAULT 'owner' CHECK(creator IN ('host', 'owner')),
  host_admitted INTEGER NOT NULL DEFAULT 0 CHECK(host_admitted IN (0, 1)),
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK(length(progress_json) <= 16384 AND json_valid(progress_json)),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 16384),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count BETWEEN 0 AND 4194304),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, task_id),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  CHECK(
    (creator = 'owner' AND host_admitted = 0 AND required = 0)
    OR (creator = 'host' AND host_admitted = 1)
  )
);

CREATE TABLE persistent_workspace_records (
  record_id TEXT PRIMARY KEY CHECK(length(record_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('finding', 'decision', 'question')),
  content_json TEXT NOT NULL CHECK(length(content_json) <= 65536 AND json_valid(content_json)),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 65536),
  task_id TEXT,
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count BETWEEN 0 AND 4194304),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, record_id),
  UNIQUE(workspace_id, kind, summary),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES persistent_workspace_tasks(task_id) ON DELETE SET NULL,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE persistent_workspace_submissions (
  submission_id TEXT PRIMARY KEY CHECK(length(submission_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  state TEXT NOT NULL DEFAULT 'submitted' CHECK(state IN ('submitted', 'accepted', 'rejected')),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 65536),
  result_digest TEXT NOT NULL CHECK(length(result_digest) = 64 AND result_digest GLOB '[0-9a-fA-F]*'),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count BETWEEN 0 AND 4194304),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, submission_id),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES persistent_workspace_tasks(task_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE persistent_workspace_artifacts (
  artifact_id TEXT PRIMARY KEY CHECK(length(artifact_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  blob_digest TEXT NOT NULL CHECK(length(blob_digest) = 64 AND blob_digest GLOB '[0-9a-fA-F]*'),
  mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 255),
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 0 AND 4194304),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK(length(provenance_json) <= 16384 AND json_valid(provenance_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, artifact_id),
  UNIQUE(workspace_id, blob_digest),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE persistent_workspace_publications (
  publication_id TEXT PRIMARY KEY CHECK(length(publication_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  category TEXT NOT NULL CHECK(category IN ('task', 'finding', 'objective', 'artifact')),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128),
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  source_provenance_json TEXT NOT NULL CHECK(length(source_provenance_json) <= 16384 AND json_valid(source_provenance_json)),
  source_created_at INTEGER NOT NULL CHECK(source_created_at >= 0),
  source_updated_at INTEGER NOT NULL CHECK(source_updated_at >= 0),
  source_deleted_at INTEGER,
  copy_json TEXT NOT NULL CHECK(length(copy_json) <= 131072 AND json_valid(copy_json)),
  copy_digest TEXT NOT NULL CHECK(length(copy_digest) = 64 AND copy_digest GLOB '[0-9a-fA-F]*'),
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 0 AND 4194304),
  published_at INTEGER NOT NULL DEFAULT (unixepoch()),
  published_by TEXT NOT NULL CHECK(length(published_by) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision = 1),
  UNIQUE(workspace_id, category, source_id, source_revision),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_persistent_workspaces_chat ON persistent_workspaces(user_id, chat_id);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_sessions_turn ON persistent_workspace_turn_sessions(user_id, chat_id, turn_id, attempt_id);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_tasks_state ON persistent_workspace_tasks(user_id, chat_id, workspace_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_records_kind ON persistent_workspace_records(user_id, chat_id, workspace_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_submissions_state ON persistent_workspace_submissions(user_id, chat_id, workspace_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_artifacts_digest ON persistent_workspace_artifacts(user_id, chat_id, workspace_id, blob_digest);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_publications_source ON persistent_workspace_publications(user_id, chat_id, workspace_id, category, source_id, source_revision);

CREATE TRIGGER trg_persistent_workspace_publications_immutable_update
BEFORE UPDATE ON persistent_workspace_publications
WHEN NOT (
  NEW.publication_id IS OLD.publication_id
  AND NEW.workspace_id IS OLD.workspace_id
  AND NEW.user_id IS OLD.user_id
  AND NEW.category IS OLD.category
  AND NEW.source_id IS OLD.source_id
  AND NEW.source_revision IS OLD.source_revision
  AND NEW.source_created_at IS OLD.source_created_at
  AND NEW.source_updated_at IS OLD.source_updated_at
  AND NEW.copy_json IS OLD.copy_json
  AND NEW.copy_digest IS OLD.copy_digest
  AND NEW.byte_count IS OLD.byte_count
  AND NEW.published_at IS OLD.published_at
  AND NEW.published_by IS OLD.published_by
  AND NEW.revision IS OLD.revision
  AND (
    (
      OLD.chat_id IS NOT NULL
      AND NEW.chat_id IS NULL
      AND NEW.source_provenance_json IS OLD.source_provenance_json
      AND NEW.source_deleted_at IS OLD.source_deleted_at
    )
    OR (
      NEW.chat_id IS OLD.chat_id
      AND OLD.source_deleted_at IS NULL
      AND NEW.source_deleted_at IS NOT NULL
      AND NEW.source_provenance_json IS NOT OLD.source_provenance_json
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'persistent workspace publications are immutable');
END;
CREATE TRIGGER trg_persistent_workspaces_archive_on_detach
AFTER UPDATE OF chat_id ON persistent_workspaces
WHEN OLD.chat_id IS NOT NULL AND NEW.chat_id IS NULL
BEGIN
  UPDATE persistent_workspaces
     SET state = 'archived',
         revision = revision + 1,
         updated_at = unixepoch()
   WHERE workspace_id = NEW.workspace_id;
END;
CREATE TRIGGER trg_persistent_workspace_detach_children_on_chat_delete
AFTER DELETE ON chats
BEGIN
  UPDATE persistent_workspace_tasks
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_records
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_submissions
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_artifacts
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_publications
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
END;
CREATE TABLE agent_runtime_repair_acknowledgements (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
  preset_revision TEXT NOT NULL CHECK(length(preset_revision) BETWEEN 1 AND 512),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 512),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  acknowledged_at INTEGER NOT NULL CHECK(acknowledged_at >= 0),
  PRIMARY KEY (user_id, preset_id, preset_revision, reason_code)
);

CREATE INDEX idx_agent_runtime_repair_ack_preset_revision
  ON agent_runtime_repair_acknowledgements(user_id, preset_id, preset_revision, acknowledged_at DESC);

CREATE TABLE agent_run_source_deletions (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  previous_attempt_id TEXT CHECK(previous_attempt_id IS NULL OR length(previous_attempt_id) BETWEEN 1 AND 256),
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('chat', 'message', 'swipe')),
  target_message_id TEXT CHECK(target_message_id IS NULL OR length(target_message_id) BETWEEN 1 AND 256),
  target_swipe_id INTEGER CHECK(target_swipe_id IS NULL OR target_swipe_id >= 0),
  run_id TEXT CHECK(run_id IS NULL OR length(run_id) BETWEEN 1 AND 256),
  turn_id TEXT CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 256),
  generation_id TEXT CHECK(generation_id IS NULL OR length(generation_id) BETWEEN 1 AND 256),
  generation_type TEXT CHECK(generation_type IS NULL OR generation_type IN ('normal', 'continue', 'regenerate', 'swipe')),
  lifecycle TEXT CHECK(lifecycle IS NULL OR lifecycle IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT CHECK(status IS NULL OR status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'stopped', 'failed', 'exhausted', 'rejected')),
  terminal INTEGER CHECK(terminal IS NULL OR terminal IN (0, 1)),
  attempt_reason TEXT CHECK(attempt_reason IS NULL OR length(attempt_reason) <= 128),
  started_at INTEGER CHECK(started_at IS NULL OR started_at >= 0),
  updated_at INTEGER CHECK(updated_at IS NULL OR updated_at >= 0),
  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= 0),
  host_correlation_id TEXT CHECK(host_correlation_id IS NULL OR length(host_correlation_id) BETWEEN 1 AND 256),
  reconciliation_state TEXT CHECK(reconciliation_state IS NULL OR reconciliation_state IN ('authoritative', 'reconciling', 'recovered', 'stale')),
  attempt_version INTEGER CHECK(attempt_version IS NULL OR attempt_version >= 1),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  source_deleted_at INTEGER NOT NULL CHECK(source_deleted_at >= 0),
  reason TEXT NOT NULL DEFAULT 'source_deleted' CHECK(reason = 'source_deleted'),
  activity_json TEXT NOT NULL DEFAULT '[]' CHECK(length(activity_json) <= 65536 AND json_valid(activity_json)),
  usage_json TEXT NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0,"totalTokens":0,"toolCalls":0,"childInvocations":0}' CHECK(length(usage_json) <= 4096 AND json_valid(usage_json)),
  PRIMARY KEY(user_id, attempt_id),
  CHECK(target_swipe_id IS NULL OR target_message_id IS NOT NULL),
  CHECK(source_kind = 'chat' OR target_message_id IS NOT NULL),
  CHECK(source_kind <> 'swipe' OR target_swipe_id IS NOT NULL)
);
CREATE TRIGGER trg_agent_run_attempts_reject_source_deleted
BEFORE INSERT ON agent_run_attempts
WHEN EXISTS (
  SELECT 1
    FROM agent_run_source_deletions
   WHERE user_id = NEW.user_id AND attempt_id = NEW.attempt_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent run attempt source was deleted');
END;

CREATE INDEX idx_agent_run_source_deletions_chat
  ON agent_run_source_deletions(user_id, chat_id, source_kind, target_message_id, target_swipe_id);
CREATE INDEX idx_agent_run_source_deletions_attempt
  ON agent_run_source_deletions(user_id, attempt_id);
CREATE TABLE agent_run_source_deletion_workspace (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  association_id TEXT NOT NULL CHECK(length(association_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision >= 0),
  relation TEXT NOT NULL CHECK(relation IN ('linked', 'published', 'omitted')),
  object_kind TEXT NOT NULL CHECK(object_kind IN ('objective', 'task', 'finding', 'decision', 'question', 'submission', 'artifact', 'publication')),
  object_id TEXT CHECK(object_id IS NULL OR length(object_id) BETWEEN 1 AND 256),
  source_revision INTEGER CHECK(source_revision IS NULL OR source_revision >= 0),
  source_deleted INTEGER NOT NULL CHECK(source_deleted IN (0, 1)),
  provenance_digest TEXT CHECK(provenance_digest IS NULL OR length(provenance_digest) = 64),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  PRIMARY KEY(user_id, attempt_id, association_id)
);
CREATE INDEX idx_agent_run_source_deletion_workspace_attempt
  ON agent_run_source_deletion_workspace(user_id, attempt_id, host_sequence, association_id);


-- Final feature bundle step: 113_agent_activity_runs.sql
CREATE TABLE IF NOT EXISTS agent_activity_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  target_message_id TEXT,
  target_swipe_id INTEGER,
  snapshot_json TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0 AND byte_size <= 32768),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, chat_id, generation_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_activity_runs_chat
  ON agent_activity_runs(user_id, chat_id, created_at DESC, id DESC);


-- Final feature bundle step: 114_regex_validation.sql
ALTER TABLE regex_scripts ADD COLUMN validation_error_code TEXT;

CREATE INDEX IF NOT EXISTS idx_regex_scripts_validation_error
  ON regex_scripts(user_id, validation_error_code)
  WHERE validation_error_code IS NOT NULL;

-- SQLite cannot compile JavaScript regular expressions. These guards still
-- reject storage-level size/JSON violations immediately; the service performs
-- the complete validator (including RegExp compilation) before execution and
-- lazily quarantines any legacy row that predates this migration.
CREATE TRIGGER IF NOT EXISTS trg_regex_scripts_validation_insert
AFTER INSERT ON regex_scripts
WHEN NEW.validation_error_code IS NULL
  AND (
    length(CAST(NEW.find_regex AS BLOB)) > 65536
    OR length(CAST(NEW.replace_string AS BLOB)) > 131072
    OR json_valid(NEW.trim_strings) = 0
    OR EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(NEW.trim_strings) THEN NEW.trim_strings ELSE '[]' END)
      WHERE type != 'text'
        OR length(CAST(value AS BLOB)) = 0
        OR length(CAST(value AS BLOB)) > 512
    )
  )
BEGIN
  UPDATE regex_scripts
  SET disabled = 1,
      validation_error_code = CASE
        WHEN length(CAST(NEW.find_regex AS BLOB)) > 65536 THEN 'pattern_too_large'
        WHEN length(CAST(NEW.replace_string AS BLOB)) > 131072 THEN 'replacement_too_large'
        WHEN json_valid(NEW.trim_strings) = 0 THEN 'invalid_input'
        ELSE 'trim_string_invalid'
      END
  WHERE id = NEW.id AND user_id = NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_regex_scripts_validation_update
AFTER UPDATE OF find_regex, replace_string, trim_strings, actions, flags,
  placement, scope, scope_id, target, owner_extension_identifier
ON regex_scripts
WHEN NEW.validation_error_code IS NULL
  AND (
    length(CAST(NEW.find_regex AS BLOB)) > 65536
    OR length(CAST(NEW.replace_string AS BLOB)) > 131072
    OR json_valid(NEW.trim_strings) = 0
    OR EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(NEW.trim_strings) THEN NEW.trim_strings ELSE '[]' END)
      WHERE type != 'text'
        OR length(CAST(value AS BLOB)) = 0
        OR length(CAST(value AS BLOB)) > 512
    )
  )
BEGIN
  UPDATE regex_scripts
  SET disabled = 1,
      validation_error_code = CASE
        WHEN length(CAST(NEW.find_regex AS BLOB)) > 65536 THEN 'pattern_too_large'
        WHEN length(CAST(NEW.replace_string AS BLOB)) > 131072 THEN 'replacement_too_large'
        WHEN json_valid(NEW.trim_strings) = 0 THEN 'invalid_input'
        ELSE 'trim_string_invalid'
      END
  WHERE id = NEW.id AND user_id = NEW.user_id;
END;


-- Final feature bundle step: 115_user_data_import_integrity.sql
-- Durable control plane for recoverable .lvbak imports.
-- Canonical user data is never written until a job has a complete validated
-- staging database and every present file has been installed under its fence.

CREATE TABLE IF NOT EXISTS user_data_imports (
  job_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  archive_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  archive_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (length(manifest_json) <= 16777216),
  staging_path TEXT NOT NULL CHECK (length(staging_path) <= 4096),
  staging_db_path TEXT NOT NULL CHECK (length(staging_db_path) <= 4096),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'validating', 'awaiting_ticket', 'installing', 'ready',
    'committing', 'committed', 'failed', 'cancelled',
    'cancelling', 'cleanup_pending'
  )),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at INTEGER,
  finished_at INTEGER,
  stable_error_code TEXT,
  stable_error TEXT CHECK (stable_error IS NULL OR length(stable_error) <= 4096),
  summary_json TEXT CHECK (summary_json IS NULL OR length(summary_json) <= 16777216)
);

CREATE INDEX IF NOT EXISTS idx_user_data_imports_user_created
  ON user_data_imports(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_data_imports_lease
  ON user_data_imports(state, lease_expires_at);

-- At most one import may be in-flight for an account. Terminal rows remain as
-- the durable idempotency/audit record and do not consume the admission slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_data_imports_one_nonterminal_user
  ON user_data_imports(user_id)
  WHERE state NOT IN ('committed', 'failed', 'cancelled');

CREATE TABLE IF NOT EXISTS user_data_import_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES user_data_imports(job_id) ON DELETE CASCADE,
  archive_path TEXT NOT NULL CHECK (length(archive_path) <= 4096),
  kind TEXT NOT NULL CHECK (kind IN ('file', 'secret', 'vector')),
  staged_path TEXT NOT NULL CHECK (length(staged_path) <= 4096),
  final_path TEXT NOT NULL CHECK (length(final_path) <= 4096),
  sha256 TEXT NOT NULL CHECK (sha256 GLOB '[0-9a-fA-F]*' AND length(sha256) = 64),
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0 AND byte_count <= 8589934592),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  install_token TEXT NOT NULL,
  staged_identity TEXT NOT NULL CHECK (length(staged_identity) <= 4096),
  observed_final_identity TEXT CHECK (observed_final_identity IS NULL OR length(observed_final_identity) <= 4096),
  install_state TEXT NOT NULL CHECK (install_state IN ('pending', 'preexisting', 'created', 'installed', 'removed', 'skipped')),
  omission_policy TEXT CHECK (omission_policy IS NULL OR omission_policy IN ('null_reference', 'skip_dependent_row', 'preserve_absent')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(job_id, archive_path),
  UNIQUE(job_id, install_token)
);

CREATE INDEX IF NOT EXISTS idx_user_data_import_files_job_state
  ON user_data_import_files(job_id, install_state);

CREATE TABLE IF NOT EXISTS user_data_import_receipts (
  receipt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES user_data_imports(job_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  archive_digest TEXT NOT NULL CHECK (length(archive_digest) = 64),
  summary_json TEXT NOT NULL CHECK (length(summary_json) <= 16777216),
  committed_at INTEGER NOT NULL,
  UNIQUE(user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_user_data_import_receipts_user
  ON user_data_import_receipts(user_id, committed_at DESC);


-- Final feature bundle step: 116_agent_config_v2.sql
-- Normalized AgentConfig V2. Legacy metadata is read exactly once here; runtime
-- readers use these tables and never consult metadata.agentConfig.

CREATE UNIQUE INDEX IF NOT EXISTS idx_presets_user_id_id
  ON presets(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_user_id_id
  ON chats(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_profiles_user_id_id
  ON connection_profiles(user_id, id);

CREATE TABLE IF NOT EXISTS preset_agent_configs (
  user_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 2 CHECK (version = 2),
  agents_enabled INTEGER NOT NULL DEFAULT 0 CHECK (agents_enabled IN (0, 1)),
  allowed_modes TEXT NOT NULL DEFAULT '["response"]' CHECK (json_valid(allowed_modes)),
  default_mode TEXT NOT NULL DEFAULT 'response' CHECK (default_mode IN ('response', 'agentic')),
  max_invocations INTEGER NOT NULL DEFAULT 64 CHECK (max_invocations BETWEEN 1 AND 9007199254740991),
  max_tool_calls INTEGER NOT NULL DEFAULT 64 CHECK (max_tool_calls BETWEEN 1 AND 9007199254740991),
  main_tool_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(main_tool_ids)),
  main_lore_scope TEXT NOT NULL DEFAULT 'active' CHECK (main_lore_scope IN ('active', 'all_owned')),
  phase_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(phase_policy_json)),
  cognition_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cognition_policy_json)),
  task_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(task_policy_json)),
  workspace_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(workspace_policy_json)),
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'review_required', 'repair_required')),
  review_code TEXT,
  config_revision INTEGER NOT NULL DEFAULT 1 CHECK (config_revision BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, preset_id),
  FOREIGN KEY (user_id, preset_id) REFERENCES presets(user_id, id) ON DELETE CASCADE
);

-- Explicit review acknowledgement is separate from repair state; imported rows
-- cannot regain authority merely by being copied.
ALTER TABLE preset_agent_configs ADD COLUMN review_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (review_acknowledged IN (0, 1));
ALTER TABLE preset_agent_configs ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json));

ALTER TABLE preset_agent_configs ADD COLUMN binding_revision INTEGER NOT NULL DEFAULT 1 CHECK (binding_revision BETWEEN 1 AND 9007199254740991);

CREATE TABLE IF NOT EXISTS preset_agent_connection_slots (
  user_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  slot_id TEXT NOT NULL CHECK (slot_id GLOB '[a-z]*' AND length(slot_id) <= 128),
  label TEXT NOT NULL CHECK (length(label) <= 80),
  required_capabilities TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_capabilities)),
  slot_revision INTEGER NOT NULL DEFAULT 1 CHECK (slot_revision BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, preset_id, slot_id),
  FOREIGN KEY (user_id, preset_id) REFERENCES preset_agent_configs(user_id, preset_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS preset_agent_profiles (
  user_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) <= 80),
  system_prompt TEXT NOT NULL CHECK (length(CAST(system_prompt AS BLOB)) <= 32768),
  connection_ref_kind TEXT NOT NULL CHECK (connection_ref_kind IN ('inherit_main', 'slot')),
  slot_id TEXT,
  tool_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tool_ids)),
  workspace_capabilities TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(workspace_capabilities)),
  lore_scope TEXT NOT NULL CHECK (lore_scope IN ('active', 'all_owned')),
  allow_main_delegation INTEGER NOT NULL CHECK (allow_main_delegation IN (0, 1)),
  failure_policy TEXT NOT NULL CHECK (failure_policy IN ('required', 'optional')),
  stream_activity INTEGER NOT NULL CHECK (stream_activity IN (0, 1)),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 64 AND 8192),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms >= 5000 AND timeout_ms % 1000 = 0),
  profile_revision INTEGER NOT NULL DEFAULT 1 CHECK (profile_revision BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, preset_id, profile_id),
  FOREIGN KEY (user_id, preset_id) REFERENCES preset_agent_configs(user_id, preset_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, preset_id, slot_id) REFERENCES preset_agent_connection_slots(user_id, preset_id, slot_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS preset_agent_slot_bindings (
  user_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  connection_id TEXT,
  binding_revision INTEGER NOT NULL DEFAULT 1 CHECK (binding_revision BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'review_required', 'repair_required')),
  review_code TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, preset_id, slot_id),
  FOREIGN KEY (user_id, preset_id, slot_id) REFERENCES preset_agent_connection_slots(user_id, preset_id, slot_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, connection_id) REFERENCES connection_profiles(user_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS chat_agent_mode_overrides (
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  mode TEXT CHECK (mode IS NULL OR mode IN ('response', 'agentic')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'review_required', 'repair_required')),
  review_code TEXT,
  review_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (review_acknowledged IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, chat_id),
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE
);

DROP TABLE IF EXISTS temp._agent_config_v1_validation;
CREATE TEMP TABLE _agent_config_v1_validation AS
WITH preset_json AS (
  SELECT p.*,
    CASE WHEN json_valid(p.metadata) THEN 1 ELSE 0 END AS metadata_valid,
    CASE WHEN json_valid(p.metadata) THEN p.metadata ELSE '{}' END AS metadata_json,
    CASE WHEN json_valid(p.metadata)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(p.metadata) AS metadata_field
        GROUP BY metadata_field.key
        HAVING COUNT(*) > 1
      )
      THEN 1 ELSE 0 END AS metadata_keys_unique
  FROM presets AS p
), legacy AS (
  SELECT user_id, id AS preset_id,
    CASE WHEN metadata_valid = 0 OR json_type(metadata_json, '$.agentConfig') IS NOT NULL THEN 1 ELSE 0 END AS has_config,
    metadata_valid,
    metadata_keys_unique,
    CASE WHEN json_type(metadata_json, '$.agentConfig') = 'object'
      THEN json_extract(metadata_json, '$.agentConfig') ELSE '{}' END AS config_json
  FROM preset_json
), shaped AS (
  SELECT *,
    CASE WHEN json_type(config_json, '$.profiles') = 'array'
      THEN json_extract(config_json, '$.profiles') ELSE '[]' END AS profiles_json,
    CASE WHEN json_type(config_json, '$.mainToolIds') = 'array'
      THEN json_extract(config_json, '$.mainToolIds') ELSE '[]' END AS main_tools_json
  FROM legacy
), profile_validity AS (
  SELECT shaped.*,
    NOT EXISTS (
      SELECT 1
      FROM json_each(profiles_json) AS profile
      WHERE COALESCE(NOT (
        profile.type = 'object'
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(CASE WHEN profile.type = 'object' THEN profile.value ELSE '{}' END) AS profile_field
          GROUP BY profile_field.key
          HAVING COUNT(*) > 1
        )
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.id') ELSE NULL END = 'text'
        AND CASE WHEN profile.type = 'object' THEN length(json_extract(profile.value, '$.id')) ELSE NULL END BETWEEN 1 AND 64
        AND CASE WHEN profile.type = 'object' THEN substr(json_extract(profile.value, '$.id'), 1, 1) ELSE NULL END GLOB '[a-z]'
        AND CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.id') ELSE NULL END NOT GLOB '*[^a-z0-9_]*'
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.name') ELSE NULL END = 'text'
        AND CASE WHEN profile.type = 'object' THEN length(json_extract(profile.value, '$.name')) ELSE NULL END <= 80
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.systemPrompt') ELSE NULL END = 'text'
        AND CASE WHEN profile.type = 'object' THEN length(CAST(json_extract(profile.value, '$.systemPrompt') AS BLOB)) ELSE NULL END <= 32768
        AND EXISTS (
          SELECT 1
          FROM json_each(CASE WHEN profile.type = 'object' THEN profile.value ELSE '{}' END) AS required
          WHERE required.key = 'connectionProfileId'
        )
        AND (
          CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.connectionProfileId') ELSE NULL END = 'null'
          OR (
            CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.connectionProfileId') ELSE NULL END = 'text'
            AND CASE WHEN profile.type = 'object' THEN length(json_extract(profile.value, '$.connectionProfileId')) ELSE NULL END BETWEEN 1 AND 512
          )
        )
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.toolIds') ELSE NULL END = 'array'
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(
            CASE
              WHEN profile.type = 'object'
                AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.toolIds') ELSE NULL END = 'array'
              THEN json_extract(profile.value, '$.toolIds')
              ELSE '[]'
            END
          ) AS tool
          WHERE tool.type <> 'text'
            OR tool.value NOT IN (
              'lore_list_books', 'lore_get_book', 'lore_list_entries',
              'lore_get_entry', 'lore_search_entries', 'chat_search_history'
            )
        )
        AND NOT EXISTS (
          SELECT tool.value
          FROM json_each(
            CASE
              WHEN profile.type = 'object'
                AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.toolIds') ELSE NULL END = 'array'
              THEN json_extract(profile.value, '$.toolIds')
              ELSE '[]'
            END
          ) AS tool
          GROUP BY tool.value
          HAVING COUNT(*) > 1
        )
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.loreScope') ELSE NULL END = 'text'
        AND CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.loreScope') ELSE NULL END IN ('active', 'all_owned')
        AND (
          CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.loreScope') ELSE NULL END <> 'all_owned'
          OR EXISTS (
            SELECT 1
            FROM json_each(
              CASE
                WHEN profile.type = 'object'
                  AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.toolIds') ELSE NULL END = 'array'
                THEN json_extract(profile.value, '$.toolIds')
                ELSE '[]'
              END
            ) AS tool
            WHERE tool.value IN (
              'lore_list_books', 'lore_get_book', 'lore_list_entries',
              'lore_get_entry', 'lore_search_entries'
            )
          )
        )
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.allowMainDelegation') ELSE NULL END IN ('true', 'false')
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.failurePolicy') ELSE NULL END = 'text'
        AND CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.failurePolicy') ELSE NULL END IN ('required', 'optional')
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.streamActivity') ELSE NULL END IN ('true', 'false')
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.maxOutputTokens') ELSE NULL END = 'integer'
        AND CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.maxOutputTokens') ELSE NULL END BETWEEN 64 AND 8192
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.timeoutMs') ELSE NULL END = 'integer'
        AND CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.timeoutMs') ELSE NULL END >= 5000
        AND CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.timeoutMs') ELSE NULL END <= 9007199254740991
        AND CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.timeoutMs') ELSE NULL END % 1000 = 0
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(CASE WHEN profile.type = 'object' THEN profile.value ELSE '{}' END) AS field
          WHERE field.key NOT IN (
            'id', 'name', 'systemPrompt', 'connectionProfileId', 'toolIds',
            'loreScope', 'allowMainDelegation', 'failurePolicy',
            'streamActivity', 'maxOutputTokens', 'timeoutMs'
          )
        )
      ), 1)
    ) AS profiles_valid,
    NOT EXISTS (
      SELECT CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.id') ELSE NULL END
      FROM json_each(profiles_json) AS profile
      GROUP BY CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.id') ELSE NULL END
      HAVING COUNT(*) > 1
    ) AS profile_ids_unique
  FROM shaped
), validated AS (
  SELECT *,
    CASE WHEN has_config = 1
      AND metadata_valid = 1
      AND metadata_keys_unique = 1
      AND json_type(config_json, '$.version') = 'integer'
      AND json_extract(config_json, '$.version') = 1
      AND json_type(config_json, '$.enabled') IN ('true', 'false')
      AND (
        json_type(config_json, '$.maxInvocations') IS NULL
        OR (
          json_type(config_json, '$.maxInvocations') = 'integer'
          AND json_extract(config_json, '$.maxInvocations') >= 1
          AND json_extract(config_json, '$.maxInvocations') <= 9007199254740991
        )
      )
      AND (
        json_type(config_json, '$.maxToolCalls') IS NULL
        OR (
          json_type(config_json, '$.maxToolCalls') = 'integer'
          AND json_extract(config_json, '$.maxToolCalls') >= 1
          AND json_extract(config_json, '$.maxToolCalls') <= 9007199254740991
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(config_json) AS config_field
        GROUP BY config_field.key
        HAVING COUNT(*) > 1
      )
      AND json_type(config_json, '$.mainToolIds') = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(config_json) AS field
        WHERE field.key NOT IN (
          'version', 'enabled', 'maxInvocations', 'maxToolCalls',
          'mainToolIds', 'mainLoreScope', 'profiles'
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(main_tools_json) AS tool
        WHERE tool.type <> 'text'
          OR tool.value NOT IN (
            'lore_list_books', 'lore_get_book', 'lore_list_entries',
            'lore_get_entry', 'lore_search_entries', 'chat_search_history'
          )
      )
      AND NOT EXISTS (
        SELECT value FROM json_each(main_tools_json)
        GROUP BY value
        HAVING COUNT(*) > 1
      )
      AND json_type(config_json, '$.mainLoreScope') = 'text'
      AND json_extract(config_json, '$.mainLoreScope') IN ('active', 'all_owned')
      AND (
        json_extract(config_json, '$.mainLoreScope') <> 'all_owned'
        OR EXISTS (
          SELECT 1 FROM json_each(main_tools_json) AS tool
          WHERE tool.value IN (
            'lore_list_books', 'lore_get_book', 'lore_list_entries',
            'lore_get_entry', 'lore_search_entries'
          )
        )
      )
      AND json_type(config_json, '$.profiles') = 'array'
      AND json_array_length(profiles_json) <= 16
      AND profiles_valid
      AND profile_ids_unique
      THEN 1 ELSE 0 END AS structurally_valid
  FROM profile_validity
)
SELECT v.user_id, v.preset_id, v.has_config, v.config_json, v.profiles_json,
  v.main_tools_json, v.structurally_valid,
  CASE WHEN v.structurally_valid = 1 AND EXISTS (
    SELECT 1
    FROM json_each(v.profiles_json) AS profile
    LEFT JOIN connection_profiles AS cp
      ON cp.user_id = v.user_id
     AND cp.id = json_extract(profile.value, '$.connectionProfileId')
    WHERE json_type(profile.value, '$.connectionProfileId') = 'text'
      AND (
        cp.id IS NULL
        OR json_valid(cp.metadata) = 0
        OR json_extract(cp.metadata, '$.__lumiverse_import_review_required') = 1
        OR json_extract(cp.metadata, '$.__lumiverse_import_review_code') IS NOT NULL
      )
  ) THEN 1 ELSE 0 END AS foreign_binding
FROM validated AS v;

-- One normalized row exists for each owned preset, including presets without a
-- legacy config. Structural failures are inert and marked for repair; foreign
-- direct bindings are inert and marked for review.
INSERT OR IGNORE INTO preset_agent_configs (
  user_id, preset_id, version, agents_enabled, allowed_modes, default_mode,
  max_invocations, max_tool_calls, main_tool_ids, main_lore_scope, state,
  review_code, config_revision, created_at, updated_at
)
SELECT
  p.user_id,
  p.id,
  2,
  CASE WHEN v.structurally_valid = 1
        AND json_extract(v.config_json, '$.enabled') = 1
        AND v.foreign_binding = 0
       THEN 1 ELSE 0 END,
  '["response"]',
  'response',
  CASE WHEN json_type(v.config_json, '$.maxInvocations') = 'integer'
        AND json_extract(v.config_json, '$.maxInvocations') BETWEEN 1 AND 9007199254740991
       THEN json_extract(v.config_json, '$.maxInvocations') ELSE 64 END,
  CASE WHEN json_type(v.config_json, '$.maxToolCalls') = 'integer'
        AND json_extract(v.config_json, '$.maxToolCalls') BETWEEN 1 AND 9007199254740991
       THEN json_extract(v.config_json, '$.maxToolCalls') ELSE 64 END,
  CASE WHEN v.structurally_valid = 1 THEN v.main_tools_json ELSE '[]' END,
  CASE WHEN v.structurally_valid = 1
        AND json_extract(v.config_json, '$.mainLoreScope') IN ('active', 'all_owned')
       THEN json_extract(v.config_json, '$.mainLoreScope') ELSE 'active' END,
  CASE
    WHEN v.has_config = 0 THEN 'ready'
    WHEN v.structurally_valid = 0 THEN 'repair_required'
    WHEN v.foreign_binding = 1 THEN 'review_required'
    ELSE 'ready'
  END,
  CASE
    WHEN v.structurally_valid = 0 AND v.has_config = 1 THEN 'invalid_legacy_config'
    WHEN v.foreign_binding = 1 THEN 'foreign_connection'
    ELSE NULL
  END,
  1,
  COALESCE(p.created_at, unixepoch()),
  COALESCE(p.updated_at, unixepoch())
FROM presets AS p
JOIN _agent_config_v1_validation AS v
  ON v.user_id = p.user_id AND v.preset_id = p.id
WHERE p.user_id IS NOT NULL;

-- Legacy direct profile references become deterministic authored slots. Local
-- ownership is retained only in the separate binding table.
INSERT OR IGNORE INTO preset_agent_connection_slots (user_id, preset_id, slot_id, label, required_capabilities)
SELECT
  p.user_id,
  p.id,
  'profile/' || json_extract(profile.value, '$.id'),
  COALESCE(json_extract(profile.value, '$.name'), json_extract(profile.value, '$.id')),
  '["generation"]'
FROM presets AS p
JOIN preset_agent_configs AS c ON c.user_id = p.user_id AND c.preset_id = p.id
JOIN _agent_config_v1_validation AS v ON v.user_id = p.user_id AND v.preset_id = p.id
JOIN json_each(CASE WHEN json_type(v.config_json, '$.profiles') = 'array'
                   THEN v.profiles_json ELSE '[]' END) AS profile
WHERE v.structurally_valid = 1
  AND c.state IN ('ready', 'review_required')
  AND json_type(profile.value, '$.id') = 'text'
  AND json_extract(profile.value, '$.connectionProfileId') IS NOT NULL;

INSERT OR IGNORE INTO preset_agent_profiles (
  user_id, preset_id, profile_id, name, system_prompt, connection_ref_kind, slot_id,
  tool_ids, lore_scope, allow_main_delegation, failure_policy, stream_activity,
  max_output_tokens, timeout_ms
)
SELECT
  p.user_id,
  p.id,
  json_extract(profile.value, '$.id'),
  COALESCE(json_extract(profile.value, '$.name'), json_extract(profile.value, '$.id')),
  COALESCE(json_extract(profile.value, '$.systemPrompt'), ''),
  CASE WHEN json_extract(profile.value, '$.connectionProfileId') IS NULL THEN 'inherit_main' ELSE 'slot' END,
  CASE WHEN json_extract(profile.value, '$.connectionProfileId') IS NULL THEN NULL ELSE 'profile/' || json_extract(profile.value, '$.id') END,
  CASE WHEN json_type(json_extract(profile.value, '$.toolIds')) = 'array' THEN json_extract(profile.value, '$.toolIds') ELSE '[]' END,
  CASE WHEN json_extract(profile.value, '$.loreScope') IN ('active', 'all_owned') THEN json_extract(profile.value, '$.loreScope') ELSE 'active' END,
  CASE WHEN json_extract(profile.value, '$.allowMainDelegation') = 1 THEN 1 ELSE 0 END,
  CASE WHEN json_extract(profile.value, '$.failurePolicy') = 'required' THEN 'required' ELSE 'optional' END,
  CASE WHEN json_extract(profile.value, '$.streamActivity') = 1 THEN 1 ELSE 0 END,
  CASE WHEN json_type(json_extract(profile.value, '$.maxOutputTokens')) = 'integer'
         AND json_extract(profile.value, '$.maxOutputTokens') BETWEEN 64 AND 8192
       THEN json_extract(profile.value, '$.maxOutputTokens') ELSE 64 END,
  CASE WHEN json_type(json_extract(profile.value, '$.timeoutMs')) = 'integer'
         AND json_extract(profile.value, '$.timeoutMs') >= 5000
         AND json_extract(profile.value, '$.timeoutMs') % 1000 = 0
       THEN json_extract(profile.value, '$.timeoutMs') ELSE 5000 END
FROM presets AS p
JOIN preset_agent_configs AS c ON c.user_id = p.user_id AND c.preset_id = p.id
JOIN _agent_config_v1_validation AS v ON v.user_id = p.user_id AND v.preset_id = p.id
JOIN json_each(v.profiles_json) AS profile
WHERE v.structurally_valid = 1
  AND c.state IN ('ready', 'review_required')
  AND json_type(profile.value, '$.id') = 'text'
  AND json_extract(profile.value, '$.id') GLOB '[a-z]*';

INSERT OR IGNORE INTO preset_agent_slot_bindings (
  user_id, preset_id, slot_id, connection_id, binding_revision, state, review_code
)
SELECT
  p.user_id,
  p.id,
  'profile/' || json_extract(profile.value, '$.id'),
  cp.id,
  1,
  'ready',
  NULL
FROM presets AS p
JOIN preset_agent_configs AS c ON c.user_id = p.user_id AND c.preset_id = p.id
JOIN _agent_config_v1_validation AS v ON v.user_id = p.user_id AND v.preset_id = p.id
JOIN json_each(v.profiles_json) AS profile
JOIN connection_profiles AS cp
  ON cp.id = json_extract(profile.value, '$.connectionProfileId')
 AND cp.user_id = p.user_id
 AND json_valid(cp.metadata) = 1
 AND COALESCE(json_extract(cp.metadata, '$.__lumiverse_import_review_required'), 0) <> 1
 AND json_extract(cp.metadata, '$.__lumiverse_import_review_code') IS NULL
WHERE v.structurally_valid = 1
  AND c.state IN ('ready', 'review_required')
  AND json_type(profile.value, '$.id') = 'text'
  AND json_extract(profile.value, '$.connectionProfileId') IS NOT NULL;

INSERT OR IGNORE INTO preset_agent_slot_bindings (
  user_id, preset_id, slot_id, connection_id, binding_revision, state, review_code
)
SELECT
  p.user_id,
  p.id,
  'profile/' || json_extract(profile.value, '$.id'),
  NULL,
  1,
  'review_required',
  'foreign_connection'
FROM presets AS p
JOIN preset_agent_configs AS c ON c.user_id = p.user_id AND c.preset_id = p.id
JOIN _agent_config_v1_validation AS v ON v.user_id = p.user_id AND v.preset_id = p.id
JOIN json_each(v.profiles_json) AS profile
LEFT JOIN connection_profiles AS cp
  ON cp.id = json_extract(profile.value, '$.connectionProfileId')
 AND cp.user_id = p.user_id
WHERE v.structurally_valid = 1
  AND c.state = 'review_required'
  AND json_type(profile.value, '$.id') = 'text'
  AND json_extract(profile.value, '$.connectionProfileId') IS NOT NULL
  AND (
    cp.id IS NULL
    OR json_valid(cp.metadata) = 0
    OR json_extract(cp.metadata, '$.__lumiverse_import_review_required') = 1
    OR json_extract(cp.metadata, '$.__lumiverse_import_review_code') IS NOT NULL
  );

-- Reserved metadata is import-only. Keep ordinary Loom metadata but remove every
-- executable V1 config marker after the normalized row has been populated.
UPDATE presets
SET metadata = json_remove(metadata, '$.agentConfig', '$.agentConfigReviewRequired', '$.agentConfigReview')
WHERE json_valid(metadata)
  AND (json_type(metadata, '$.agentConfig') IS NOT NULL
    OR json_type(metadata, '$.agentConfigReviewRequired') IS NOT NULL
    OR json_type(metadata, '$.agentConfigReview') IS NOT NULL);

DROP TABLE _agent_config_v1_validation;
CREATE INDEX IF NOT EXISTS idx_preset_agent_configs_user_state
  ON preset_agent_configs(user_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_preset_agent_profiles_preset
  ON preset_agent_profiles(user_id, preset_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_preset_agent_slots_preset
  ON preset_agent_connection_slots(user_id, preset_id, slot_id);
CREATE INDEX IF NOT EXISTS idx_preset_agent_bindings_connection
  ON preset_agent_slot_bindings(user_id, connection_id);
CREATE INDEX IF NOT EXISTS idx_chat_agent_mode_overrides_user
  ON chat_agent_mode_overrides(user_id, updated_at DESC);


-- Final feature bundle step: 117_agent_turn_workspace.sql
-- Dormant single-turn execution/workspace persistence.
-- Runtime phase execution is intentionally not wired by this migration. Rows are
-- host-owned operational state until a commit receipt publishes an artifact ref.

ALTER TABLE chats
  ADD COLUMN generation_revision INTEGER NOT NULL DEFAULT 0
  CHECK (generation_revision >= 0);

ALTER TABLE messages
  ADD COLUMN generation_revision INTEGER NOT NULL DEFAULT 0
  CHECK (generation_revision >= 0);

CREATE INDEX IF NOT EXISTS idx_chats_generation_revision
  ON chats(id, generation_revision);
CREATE INDEX IF NOT EXISTS idx_messages_generation_revision
  ON messages(chat_id, id, generation_revision);

-- These redundant unique indexes make the ownership edges below enforceable as
-- composite foreign keys, rather than relying on callers to match user_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_user_id_id
  ON chats(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_id_id
  ON messages(chat_id, id);

CREATE TABLE IF NOT EXISTS agent_turn_executions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  branch_id TEXT,
  generation_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('normal', 'continue', 'regenerate', 'swipe')),
  target_message_id TEXT,
  target_swipe_id INTEGER CHECK(target_swipe_id IS NULL OR target_swipe_id >= 0),
  target_message_index INTEGER CHECK(target_message_index IS NULL OR target_message_index >= 0),
  target_swipe_count INTEGER CHECK(target_swipe_count IS NULL OR target_swipe_count >= 1),
  target_chat_revision INTEGER NOT NULL CHECK(target_chat_revision >= 0),
  target_message_revision INTEGER CHECK(target_message_revision IS NULL OR target_message_revision >= 0),
  preset_snapshot_id TEXT,
  config_snapshot_id TEXT,
  config_revision INTEGER NOT NULL DEFAULT 0 CHECK(config_revision >= 0),
  concrete_connection_snapshot_id TEXT,
  concrete_connection_revision INTEGER NOT NULL DEFAULT 0 CHECK(concrete_connection_revision >= 0),
  world_lore_snapshot_id TEXT,
  world_lore_revision INTEGER NOT NULL DEFAULT 0 CHECK(world_lore_revision >= 0),
  mode TEXT NOT NULL CHECK(mode IN ('response', 'agentic')),
  runtime_epoch INTEGER NOT NULL CHECK(runtime_epoch >= 0),
  deadline_at INTEGER NOT NULL CHECK(deadline_at >= 0),
  cancel_requested_at INTEGER,
  state TEXT NOT NULL CHECK(state IN (
    'ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT',
    'COMMITTING', 'COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED',
    'CANCELLED', 'TIMED_OUT'
  )),
  phase_revision INTEGER NOT NULL DEFAULT 0 CHECK(phase_revision >= 0),
  cas_revision INTEGER NOT NULL DEFAULT 0 CHECK(cas_revision >= 0),
  cas_owner TEXT,
  cas_expires_at INTEGER,
  root_ledger_json TEXT NOT NULL CHECK(length(root_ledger_json) <= 131072),
  frame_capabilities_json TEXT NOT NULL CHECK(length(frame_capabilities_json) <= 65536),
  workspace_id TEXT UNIQUE,
  workspace_revision INTEGER NOT NULL DEFAULT 0 CHECK(workspace_revision >= 0),
  commit_key TEXT NOT NULL UNIQUE CHECK(length(commit_key) BETWEEN 1 AND 256),
  final_render_reservations_json TEXT NOT NULL DEFAULT '[]' CHECK(length(final_render_reservations_json) <= 65536),
  final_render_request_count INTEGER NOT NULL DEFAULT 1 CHECK(final_render_request_count = 1),
  final_render_context_bytes INTEGER NOT NULL DEFAULT 0 CHECK(final_render_context_bytes >= 0 AND final_render_context_bytes <= 2147483648),
  final_render_output_bytes INTEGER NOT NULL DEFAULT 0 CHECK(final_render_output_bytes >= 0 AND final_render_output_bytes <= 2147483648),
  final_render_activity_events INTEGER NOT NULL DEFAULT 0 CHECK(final_render_activity_events >= 0 AND final_render_activity_events <= 100000),
  final_render_deadline_at INTEGER NOT NULL DEFAULT 0 CHECK(final_render_deadline_at >= 0),
  terminal_code TEXT CHECK(terminal_code IS NULL OR length(terminal_code) <= 128),
  retention TEXT NOT NULL DEFAULT 'operational' CHECK(retention IN ('operational', 'turn_terminal')),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  terminal_at INTEGER,
  ledger_request_quota INTEGER NOT NULL DEFAULT 1 CHECK(ledger_request_quota >= 0 AND ledger_request_quota <= 100000),
  ledger_output_byte_quota INTEGER NOT NULL DEFAULT 0 CHECK(ledger_output_byte_quota >= 0 AND ledger_output_byte_quota <= 2147483648),
  workspace_byte_quota INTEGER NOT NULL DEFAULT 0 CHECK(workspace_byte_quota >= 0 AND workspace_byte_quota <= 2147483648),
  workspace_item_quota INTEGER NOT NULL DEFAULT 0 CHECK(workspace_item_quota >= 0 AND workspace_item_quota <= 1000000),
  UNIQUE(user_id, id),
  UNIQUE(user_id, chat_id, generation_id),
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, target_message_id) REFERENCES messages(chat_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_turn_executions_active
  ON agent_turn_executions(user_id, state, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_turn_executions_chat
  ON agent_turn_executions(user_id, chat_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_turn_workspaces (
  workspace_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  objective TEXT NOT NULL CHECK(length(objective) <= 65536),
  constraints_json TEXT NOT NULL CHECK(length(constraints_json) <= 131072),
  state TEXT NOT NULL CHECK(state IN ('active', 'frozen', 'expired')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  cas_owner TEXT,
  cas_expires_at INTEGER,
  operation_caps_json TEXT NOT NULL CHECK(length(operation_caps_json) <= 65536),
  field_caps_json TEXT NOT NULL CHECK(length(field_caps_json) <= 65536),
  retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  quota_tasks INTEGER NOT NULL CHECK(quota_tasks >= 0 AND quota_tasks <= 100000),
  quota_records INTEGER NOT NULL CHECK(quota_records >= 0 AND quota_records <= 100000),
  quota_submissions INTEGER NOT NULL CHECK(quota_submissions >= 0 AND quota_submissions <= 100000),
  quota_artifacts INTEGER NOT NULL CHECK(quota_artifacts >= 0 AND quota_artifacts <= 100000),
  quota_bytes INTEGER NOT NULL CHECK(quota_bytes >= 0 AND quota_bytes <= 2147483648),
  task_count INTEGER NOT NULL DEFAULT 0 CHECK(task_count >= 0 AND task_count <= quota_tasks),
  record_count INTEGER NOT NULL DEFAULT 0 CHECK(record_count >= 0 AND record_count <= quota_records),
  submission_count INTEGER NOT NULL DEFAULT 0 CHECK(submission_count >= 0 AND submission_count <= quota_submissions),
  artifact_count INTEGER NOT NULL DEFAULT 0 CHECK(artifact_count >= 0 AND artifact_count <= quota_artifacts),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count >= 0 AND byte_count <= quota_bytes),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  frozen_at INTEGER,
  UNIQUE(user_id, workspace_id),
  UNIQUE(user_id, turn_id),
  UNIQUE(user_id, execution_id),
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (execution_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, execution_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_turn_workspaces_expiry
  ON agent_turn_workspaces(user_id, state, expires_at);

CREATE TABLE IF NOT EXISTS agent_workspace_tasks (
  task_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 4096),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 65536),
  state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'blocked', 'completed', 'cancelled', 'failed')),
  required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0, 1)),
  dependencies_json TEXT NOT NULL DEFAULT '[]' CHECK(length(dependencies_json) <= 65536),
  assigned_frame_id TEXT,
  progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
  summary TEXT CHECK(summary IS NULL OR length(summary) <= 65536),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count >= 0 AND byte_count <= 131072),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  cas_owner TEXT,
  cas_expires_at INTEGER,
  retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, task_id),
  FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_workspace_tasks_state
  ON agent_workspace_tasks(user_id, workspace_id, state, updated_at);

CREATE TABLE IF NOT EXISTS agent_workspace_records (
  record_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('finding', 'decision', 'question')),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 65536),
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest GLOB '[0-9a-fA-F]*'),
  task_id TEXT,
  source_frame_id TEXT,
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 131072),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, record_id),
  UNIQUE(workspace_id, kind, digest),
  FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, task_id) REFERENCES agent_workspace_tasks(user_id, task_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_workspace_records_kind
  ON agent_workspace_records(user_id, workspace_id, kind, created_at);

CREATE TABLE IF NOT EXISTS agent_workspace_submissions (
  submission_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  child_frame_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('submitted', 'accepted', 'rejected')),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 65536),
  result_digest TEXT NOT NULL CHECK(length(result_digest) = 64 AND result_digest GLOB '[0-9a-fA-F]*'),
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 131072),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, submission_id),
  UNIQUE(task_id, child_frame_id),
  FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, task_id) REFERENCES agent_workspace_tasks(user_id, task_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_workspace_submissions_state
  ON agent_workspace_submissions(user_id, workspace_id, state, updated_at);

CREATE TABLE IF NOT EXISTS agent_artifact_blobs (
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest GLOB '[0-9a-fA-F]*'),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 2147483648),
  mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 255),
  storage_path TEXT NOT NULL CHECK(length(storage_path) BETWEEN 1 AND 4096),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK(length(provenance_json) <= 65536),
  published_reference_count INTEGER NOT NULL DEFAULT 0 CHECK(published_reference_count >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  retention TEXT NOT NULL DEFAULT 'operational' CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, digest)
);

CREATE INDEX IF NOT EXISTS idx_agent_artifact_blobs_expiry
  ON agent_artifact_blobs(user_id, retention, expires_at);

CREATE TABLE IF NOT EXISTS agent_artifact_blob_journal (
  journal_id TEXT PRIMARY KEY,
  blob_digest TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  creator_token TEXT NOT NULL CHECK(length(creator_token) BETWEEN 1 AND 256),
  fence_generation INTEGER NOT NULL CHECK(fence_generation >= 0),
  staged_path TEXT NOT NULL CHECK(length(staged_path) BETWEEN 1 AND 4096),
  final_path TEXT NOT NULL CHECK(length(final_path) BETWEEN 1 AND 4096),
  state TEXT NOT NULL CHECK(state IN ('pending', 'installed', 'removed')),
  observed_identity TEXT CHECK(observed_identity IS NULL OR length(observed_identity) <= 4096),
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 2147483648),
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest GLOB '[0-9a-fA-F]*'),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, turn_id, blob_digest),
  UNIQUE(creator_token),
  FOREIGN KEY (user_id, blob_digest) REFERENCES agent_artifact_blobs(user_id, digest) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_artifact_blob_journal_state
  ON agent_artifact_blob_journal(user_id, state, updated_at);

CREATE TABLE IF NOT EXISTS agent_workspace_artifacts (
  artifact_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  blob_digest TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 255),
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 2147483648),
  provenance_json TEXT NOT NULL CHECK(length(provenance_json) <= 65536),
  source_frame_id TEXT,
  source_task_id TEXT,
  publication_state TEXT NOT NULL CHECK(publication_state IN ('attached', 'proposed', 'published')),
  retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, artifact_id),
  UNIQUE(workspace_id, blob_digest),
  FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, source_task_id) REFERENCES agent_workspace_tasks(user_id, task_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_workspace_artifacts_publication
  ON agent_workspace_artifacts(user_id, workspace_id, publication_state, updated_at);

CREATE TABLE IF NOT EXISTS agent_turn_commit_receipts (
  receipt_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  commit_key TEXT NOT NULL CHECK(length(commit_key) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  state TEXT NOT NULL DEFAULT 'committed' CHECK(state IN ('committed')),
  summary_digest TEXT NOT NULL CHECK(length(summary_digest) = 64 AND summary_digest GLOB '[0-9a-fA-F]*'),
  summary_json TEXT NOT NULL CHECK(length(summary_json) <= 131072),
  message_id TEXT,
  swipe_id INTEGER CHECK(swipe_id IS NULL OR swipe_id >= 0),
  artifact_ref_count INTEGER NOT NULL DEFAULT 0 CHECK(artifact_ref_count >= 0),
  committed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(turn_id),
  UNIQUE(execution_id),
  UNIQUE(user_id, commit_key),
  UNIQUE(user_id, idempotency_key),
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (execution_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, message_id) REFERENCES messages(chat_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_turn_commit_receipts_user_time
  ON agent_turn_commit_receipts(user_id, committed_at DESC);

CREATE TABLE IF NOT EXISTS agent_published_workspace_artifacts (
  published_artifact_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL,
  blob_digest TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id TEXT,
  swipe_id INTEGER CHECK(swipe_id IS NULL OR swipe_id >= 0),
  storage_path TEXT NOT NULL CHECK(length(storage_path) BETWEEN 1 AND 4096),
  mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 255),
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 2147483648),
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest GLOB '[0-9a-fA-F]*'),
  retention TEXT NOT NULL DEFAULT 'chat_lifetime' CHECK(retention = 'chat_lifetime'),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, published_artifact_id),
  UNIQUE(user_id, chat_id, message_id, swipe_id, blob_digest),
  -- receipt/source/blob IDs are provenance only. Their operational rows are
  -- intentionally absent from account archives, so publication is self-contained
  -- and can be restored without recreating an operational turn.
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, message_id) REFERENCES messages(chat_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_published_workspace_artifacts_chat
  ON agent_published_workspace_artifacts(user_id, chat_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_agent_published_workspace_artifacts_refcount_delete
AFTER DELETE ON agent_published_workspace_artifacts
BEGIN
  UPDATE agent_artifact_blobs
  SET published_reference_count = MAX(0, published_reference_count - 1),
      updated_at = unixepoch()
  WHERE user_id = OLD.user_id
    AND digest = OLD.blob_digest;
END;


-- Final feature bundle step: 118_agent_run_projection.sql
-- Authenticated, status-only Agentic run projection and per-chat event cursor.
-- All rows are operational projections. They are never restored from .lvbak.

CREATE TABLE IF NOT EXISTS agent_run_projections (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  generation_type TEXT NOT NULL CHECK(generation_type IN ('normal', 'continue', 'regenerate', 'swipe')),
  target_message_id TEXT,
  target_swipe_id INTEGER CHECK(target_swipe_id IS NULL OR target_swipe_id >= 0),
  status TEXT NOT NULL CHECK(status IN (
    'ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT',
    'COMMITTING', 'COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED',
    'CANCELLED', 'TIMED_OUT'
  )),
  phase TEXT NOT NULL CHECK(phase IN (
    'ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT',
    'COMMITTING', 'COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED',
    'CANCELLED', 'TIMED_OUT'
  )),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  started_at INTEGER NOT NULL CHECK(started_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) <= 65536),
  terminal_handoff_json TEXT CHECK(terminal_handoff_json IS NULL OR length(terminal_handoff_json) <= 4096),
  omission_json TEXT NOT NULL DEFAULT '{"omittedNodeCount":0,"omittedEventCount":0,"firstOmittedSequence":null,"lastOmittedSequence":null}'
    CHECK(length(omission_json) <= 4096),
  PRIMARY KEY(user_id, turn_id),
  UNIQUE(user_id, chat_id, turn_id),
  UNIQUE(user_id, chat_id, generation_id),
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, target_message_id) REFERENCES messages(chat_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_run_projections_chat_updated
  ON agent_run_projections(user_id, chat_id, updated_at DESC, turn_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_projections_chat_status
  ON agent_run_projections(user_id, chat_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_chat_event_sequences (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(user_id, chat_id),
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_chat_events (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  turn_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  run_revision INTEGER NOT NULL CHECK(run_revision >= 1),
  status TEXT NOT NULL CHECK(status IN (
    'ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT',
    'COMMITTING', 'COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED',
    'CANCELLED', 'TIMED_OUT'
  )),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('snapshot', 'terminal', 'omission')),
  snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) <= 65536),
  terminal_handoff_json TEXT CHECK(terminal_handoff_json IS NULL OR length(terminal_handoff_json) <= 4096),
  omission_json TEXT NOT NULL DEFAULT '{"omittedNodeCount":0,"omittedEventCount":0,"firstOmittedSequence":null,"lastOmittedSequence":null}'
    CHECK(length(omission_json) <= 4096),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(user_id, chat_id, sequence),
  UNIQUE(user_id, chat_id, turn_id, run_revision),
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_run_projections(user_id, turn_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_chat_events_chat_sequence
  ON agent_chat_events(user_id, chat_id, sequence);
CREATE INDEX IF NOT EXISTS idx_agent_chat_events_turn_revision
  ON agent_chat_events(user_id, chat_id, turn_id, run_revision);


-- Final feature bundle step: 119_ticket_consumption_strict.sql
-- Decryption tickets are one-use capabilities. Normalize the historical
-- advisory counter to a strict invariant while preserving the archive ledger.
-- The owner reference is nullable and set to NULL on account deletion so the
-- global archive tombstone remains permanently replay-blocking.
CREATE TABLE import_consumed_tickets_v2 (
  archive_id  TEXT PRIMARY KEY,
  consumed_at INTEGER NOT NULL,
  user_id     TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  uses        INTEGER NOT NULL DEFAULT 1 CHECK (uses = 1)
);

INSERT INTO import_consumed_tickets_v2 (archive_id, consumed_at, user_id, uses)
SELECT archive_id, consumed_at, user_id, 1
  FROM import_consumed_tickets;

DROP TABLE import_consumed_tickets;
ALTER TABLE import_consumed_tickets_v2 RENAME TO import_consumed_tickets;

CREATE INDEX IF NOT EXISTS idx_ict_user_consumed
  ON import_consumed_tickets(user_id, consumed_at DESC);


-- Final feature bundle step: 120_agent_run_projection_outbox.sql
-- Durable terminal projection outbox delivery state.
-- Events remain public-schema compatible; delivery metadata is operational and
-- never restored from account archives.
ALTER TABLE agent_chat_events
  ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending'
    CHECK(delivery_state IN ('pending', 'leased', 'delivered'));

ALTER TABLE agent_chat_events
  ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0
    CHECK(delivery_attempts >= 0 AND delivery_attempts <= 100000);

ALTER TABLE agent_chat_events
  ADD COLUMN delivery_lease_token TEXT
    CHECK(delivery_lease_token IS NULL OR length(delivery_lease_token) BETWEEN 1 AND 256);

ALTER TABLE agent_chat_events
  ADD COLUMN delivery_lease_expires_at INTEGER
    CHECK(delivery_lease_expires_at IS NULL OR delivery_lease_expires_at >= 0);

ALTER TABLE agent_chat_events
  ADD COLUMN delivered_at INTEGER
    CHECK(delivered_at IS NULL OR delivered_at >= 0);

CREATE INDEX IF NOT EXISTS idx_agent_chat_events_terminal_delivery
  ON agent_chat_events(event_kind, delivery_state, delivery_lease_expires_at, sequence);
CREATE INDEX IF NOT EXISTS idx_agent_chat_events_delivery_cleanup
  ON agent_chat_events(user_id, chat_id, delivered_at, sequence);


-- Final feature bundle step: 121_archive_digest_constraints.sql
-- Corrective integrity gates for archive, workspace, and publication digest ledgers.
--
-- Migrations 104 and 106 are already present in deployed databases, so
-- their permissive historical GLOB checks cannot be rewritten in place. These
-- triggers provide the same fail-closed invariant for existing schemas while
-- keeping old rows untouched: every SHA-256 value is exactly 64 lowercase
-- hexadecimal bytes. A character class in SQLite GLOB must be paired with a
-- negated whole-string check; `[0-9a-f]*` alone only constrains the first byte.

CREATE TRIGGER IF NOT EXISTS trg_user_data_imports_archive_digest_insert
BEFORE INSERT ON user_data_imports
WHEN typeof(NEW.archive_digest) <> 'text'
  OR length(NEW.archive_digest) <> 64
  OR lower(NEW.archive_digest) <> NEW.archive_digest
  OR NEW.archive_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'archive_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_data_imports_archive_digest_update
BEFORE UPDATE OF archive_digest ON user_data_imports
WHEN typeof(NEW.archive_digest) <> 'text'
  OR length(NEW.archive_digest) <> 64
  OR lower(NEW.archive_digest) <> NEW.archive_digest
  OR NEW.archive_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'archive_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_data_import_files_sha256_insert
BEFORE INSERT ON user_data_import_files
WHEN typeof(NEW.sha256) <> 'text'
  OR length(NEW.sha256) <> 64
  OR lower(NEW.sha256) <> NEW.sha256
  OR NEW.sha256 GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'sha256 must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_data_import_files_sha256_update
BEFORE UPDATE OF sha256 ON user_data_import_files
WHEN typeof(NEW.sha256) <> 'text'
  OR length(NEW.sha256) <> 64
  OR lower(NEW.sha256) <> NEW.sha256
  OR NEW.sha256 GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'sha256 must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_data_import_receipts_archive_digest_insert
BEFORE INSERT ON user_data_import_receipts
WHEN typeof(NEW.archive_digest) <> 'text'
  OR length(NEW.archive_digest) <> 64
  OR lower(NEW.archive_digest) <> NEW.archive_digest
  OR NEW.archive_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'archive_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_data_import_receipts_archive_digest_update
BEFORE UPDATE OF archive_digest ON user_data_import_receipts
WHEN typeof(NEW.archive_digest) <> 'text'
  OR length(NEW.archive_digest) <> 64
  OR lower(NEW.archive_digest) <> NEW.archive_digest
  OR NEW.archive_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'archive_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_workspace_records_digest_insert
BEFORE INSERT ON agent_workspace_records
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_workspace_records_digest_update
BEFORE UPDATE OF digest ON agent_workspace_records
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_workspace_submissions_result_digest_insert
BEFORE INSERT ON agent_workspace_submissions
WHEN typeof(NEW.result_digest) <> 'text'
  OR length(NEW.result_digest) <> 64
  OR lower(NEW.result_digest) <> NEW.result_digest
  OR NEW.result_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'result_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_workspace_submissions_result_digest_update
BEFORE UPDATE OF result_digest ON agent_workspace_submissions
WHEN typeof(NEW.result_digest) <> 'text'
  OR length(NEW.result_digest) <> 64
  OR lower(NEW.result_digest) <> NEW.result_digest
  OR NEW.result_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'result_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_artifact_blobs_digest_insert
BEFORE INSERT ON agent_artifact_blobs
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_artifact_blobs_digest_update
BEFORE UPDATE OF digest ON agent_artifact_blobs
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_artifact_blob_journal_blob_digest_insert
BEFORE INSERT ON agent_artifact_blob_journal
WHEN typeof(NEW.blob_digest) <> 'text'
  OR length(NEW.blob_digest) <> 64
  OR lower(NEW.blob_digest) <> NEW.blob_digest
  OR NEW.blob_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'blob_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_artifact_blob_journal_blob_digest_update
BEFORE UPDATE OF blob_digest ON agent_artifact_blob_journal
WHEN typeof(NEW.blob_digest) <> 'text'
  OR length(NEW.blob_digest) <> 64
  OR lower(NEW.blob_digest) <> NEW.blob_digest
  OR NEW.blob_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'blob_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_artifact_blob_journal_digest_insert
BEFORE INSERT ON agent_artifact_blob_journal
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_artifact_blob_journal_digest_update
BEFORE UPDATE OF digest ON agent_artifact_blob_journal
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_workspace_artifacts_blob_digest_insert
BEFORE INSERT ON agent_workspace_artifacts
WHEN typeof(NEW.blob_digest) <> 'text'
  OR length(NEW.blob_digest) <> 64
  OR lower(NEW.blob_digest) <> NEW.blob_digest
  OR NEW.blob_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'blob_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_workspace_artifacts_blob_digest_update
BEFORE UPDATE OF blob_digest ON agent_workspace_artifacts
WHEN typeof(NEW.blob_digest) <> 'text'
  OR length(NEW.blob_digest) <> 64
  OR lower(NEW.blob_digest) <> NEW.blob_digest
  OR NEW.blob_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'blob_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_turn_commit_receipts_summary_digest_insert
BEFORE INSERT ON agent_turn_commit_receipts
WHEN typeof(NEW.summary_digest) <> 'text'
  OR length(NEW.summary_digest) <> 64
  OR lower(NEW.summary_digest) <> NEW.summary_digest
  OR NEW.summary_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'summary_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_turn_commit_receipts_summary_digest_update
BEFORE UPDATE OF summary_digest ON agent_turn_commit_receipts
WHEN typeof(NEW.summary_digest) <> 'text'
  OR length(NEW.summary_digest) <> 64
  OR lower(NEW.summary_digest) <> NEW.summary_digest
  OR NEW.summary_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'summary_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_published_workspace_artifacts_blob_digest_insert
BEFORE INSERT ON agent_published_workspace_artifacts
WHEN typeof(NEW.blob_digest) <> 'text'
  OR length(NEW.blob_digest) <> 64
  OR lower(NEW.blob_digest) <> NEW.blob_digest
  OR NEW.blob_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'blob_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_published_workspace_artifacts_blob_digest_update
BEFORE UPDATE OF blob_digest ON agent_published_workspace_artifacts
WHEN typeof(NEW.blob_digest) <> 'text'
  OR length(NEW.blob_digest) <> 64
  OR lower(NEW.blob_digest) <> NEW.blob_digest
  OR NEW.blob_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'blob_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_published_workspace_artifacts_digest_insert
BEFORE INSERT ON agent_published_workspace_artifacts
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_published_workspace_artifacts_digest_update
BEFORE UPDATE OF digest ON agent_published_workspace_artifacts
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;



-- Final feature bundle step: 122_ticket_consumption_account_delete.sql
-- Preserve one-use decryption-ticket tombstones after the owning account is
-- deleted. The archive id remains globally unique forever; user_id is only
-- nullable audit metadata and must not cascade-delete the tombstone.
CREATE TABLE import_consumed_tickets_v3 (
  archive_id  TEXT PRIMARY KEY NOT NULL,
  consumed_at INTEGER NOT NULL,
  user_id     TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  uses        INTEGER NOT NULL DEFAULT 1 CHECK (uses = 1)
);

INSERT INTO import_consumed_tickets_v3 (archive_id, consumed_at, user_id, uses)
SELECT archive_id, consumed_at, user_id, 1
  FROM import_consumed_tickets;

DROP TABLE import_consumed_tickets;
ALTER TABLE import_consumed_tickets_v3 RENAME TO import_consumed_tickets;

CREATE INDEX IF NOT EXISTS idx_ict_user_consumed
  ON import_consumed_tickets(user_id, consumed_at DESC);


-- Final feature bundle step: 123_image_public_provenance.sql
-- Public image-generation responses require server-owned provenance. Archive
-- rows never carry this authority; imports explicitly clear the column.
ALTER TABLE images
  ADD COLUMN public_provenance TEXT
    CHECK(public_provenance IS NULL OR public_provenance = 'server_image_generation_v1');


-- Final feature bundle step: 124_user_data_import_projection_pending.sql
-- Keep derived-vector recovery durable after an import's staging tree is removed.
-- The detailed cursor remains in the receipt summary; this flag is the
-- bounded startup-recovery selector and is cleared only after projection
-- reconciliation confirms every source page is complete.
ALTER TABLE user_data_imports
  ADD COLUMN projection_pending INTEGER NOT NULL DEFAULT 0
  CHECK (projection_pending IN (0, 1));

UPDATE user_data_imports AS i
   SET projection_pending = CASE
     WHEN json_valid(COALESCE(
       (SELECT r.summary_json
          FROM user_data_import_receipts AS r
         WHERE r.job_id = i.job_id),
       i.summary_json
     )) = 1
       AND json_extract(COALESCE(
         (SELECT r.summary_json
            FROM user_data_import_receipts AS r
           WHERE r.job_id = i.job_id),
         i.summary_json
       ), '$.vectors.projectionPending') = 1
     THEN 1
     ELSE 0
   END
 WHERE i.summary_json IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM user_data_import_receipts AS r WHERE r.job_id = i.job_id
    );

CREATE INDEX IF NOT EXISTS idx_user_data_imports_projection_pending
  ON user_data_imports(projection_pending, updated_at)
  WHERE state = 'committed' AND projection_pending = 1;


-- Final feature bundle step: 125_work_alpha1_workspace.sql
CREATE TABLE IF NOT EXISTS persistent_workspaces (
  workspace_id TEXT PRIMARY KEY CHECK(length(workspace_id) BETWEEN 1 AND 128),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  objective TEXT NOT NULL DEFAULT '' CHECK(length(objective) <= 65536),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(length(metadata_json) <= 32768 AND json_valid(metadata_json)),
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK(length(progress_json) <= 16384 AND json_valid(progress_json)),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  quota_tasks INTEGER NOT NULL DEFAULT 256 CHECK(quota_tasks BETWEEN 0 AND 256),
  quota_records INTEGER NOT NULL DEFAULT 1024 CHECK(quota_records BETWEEN 0 AND 1024),
  quota_submissions INTEGER NOT NULL DEFAULT 1024 CHECK(quota_submissions BETWEEN 0 AND 1024),
  quota_artifacts INTEGER NOT NULL DEFAULT 256 CHECK(quota_artifacts BETWEEN 0 AND 256),
  quota_publications INTEGER NOT NULL DEFAULT 512 CHECK(quota_publications BETWEEN 0 AND 512),
  quota_bytes INTEGER NOT NULL DEFAULT 4194304 CHECK(quota_bytes BETWEEN 0 AND 4194304),
  task_count INTEGER NOT NULL DEFAULT 0 CHECK(task_count >= 0),
  record_count INTEGER NOT NULL DEFAULT 0 CHECK(record_count >= 0),
  submission_count INTEGER NOT NULL DEFAULT 0 CHECK(submission_count >= 0),
  artifact_count INTEGER NOT NULL DEFAULT 0 CHECK(artifact_count >= 0),
  publication_count INTEGER NOT NULL DEFAULT 0 CHECK(publication_count >= 0),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, workspace_id),
  UNIQUE(user_id, chat_id)
);

CREATE TABLE IF NOT EXISTS persistent_workspace_turn_sessions (
  turn_session_id TEXT PRIMARY KEY CHECK(length(turn_session_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 128),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 128),
  execution_id TEXT CHECK(execution_id IS NULL OR length(execution_id) BETWEEN 1 AND 128),
  phase TEXT NOT NULL DEFAULT 'ADMIT' CHECK(phase IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'stopped', 'failed', 'exhausted', 'rejected')),
  reason TEXT NOT NULL DEFAULT 'none' CHECK(length(reason) <= 128),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  terminal_at INTEGER,
  UNIQUE(user_id, turn_id, attempt_id),
  UNIQUE(workspace_id, turn_id, attempt_id),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS persistent_workspace_tasks (
  task_id TEXT PRIMARY KEY CHECK(length(task_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 4096),
  objective TEXT NOT NULL DEFAULT '' CHECK(length(objective) <= 65536),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'active', 'blocked', 'completed', 'cancelled', 'failed')),
  required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0, 1)),
  dependency_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(length(dependency_ids_json) <= 65536 AND json_valid(dependency_ids_json)),
  creator TEXT NOT NULL DEFAULT 'owner' CHECK(creator IN ('host', 'owner')),
  host_admitted INTEGER NOT NULL DEFAULT 0 CHECK(host_admitted IN (0, 1)),
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK(length(progress_json) <= 16384 AND json_valid(progress_json)),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 16384),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count BETWEEN 0 AND 4194304),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, task_id),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  CHECK(
    (creator = 'owner' AND host_admitted = 0 AND required = 0)
    OR (creator = 'host' AND host_admitted = 1)
  )
);

CREATE TABLE IF NOT EXISTS persistent_workspace_records (
  record_id TEXT PRIMARY KEY CHECK(length(record_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('finding', 'decision', 'question')),
  content_json TEXT NOT NULL CHECK(length(content_json) <= 65536 AND json_valid(content_json)),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 65536),
  task_id TEXT,
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count BETWEEN 0 AND 4194304),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, record_id),
  UNIQUE(workspace_id, kind, summary),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES persistent_workspace_tasks(task_id) ON DELETE SET NULL,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS persistent_workspace_submissions (
  submission_id TEXT PRIMARY KEY CHECK(length(submission_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  state TEXT NOT NULL DEFAULT 'submitted' CHECK(state IN ('submitted', 'accepted', 'rejected')),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 65536),
  result_digest TEXT NOT NULL CHECK(length(result_digest) = 64 AND result_digest GLOB '[0-9a-fA-F]*'),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count BETWEEN 0 AND 4194304),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, submission_id),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES persistent_workspace_tasks(task_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS persistent_workspace_artifacts (
  artifact_id TEXT PRIMARY KEY CHECK(length(artifact_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  blob_digest TEXT NOT NULL CHECK(length(blob_digest) = 64 AND blob_digest GLOB '[0-9a-fA-F]*'),
  mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 255),
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 0 AND 4194304),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK(length(provenance_json) <= 16384 AND json_valid(provenance_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, artifact_id),
  UNIQUE(workspace_id, blob_digest),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS persistent_workspace_publications (
  publication_id TEXT PRIMARY KEY CHECK(length(publication_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  category TEXT NOT NULL CHECK(category IN ('task', 'finding', 'objective', 'artifact')),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128),
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  source_provenance_json TEXT NOT NULL CHECK(length(source_provenance_json) <= 16384 AND json_valid(source_provenance_json)),
  source_created_at INTEGER NOT NULL CHECK(source_created_at >= 0),
  source_updated_at INTEGER NOT NULL CHECK(source_updated_at >= 0),
  source_deleted_at INTEGER,
  copy_json TEXT NOT NULL CHECK(length(copy_json) <= 131072 AND json_valid(copy_json)),
  copy_digest TEXT NOT NULL CHECK(length(copy_digest) = 64 AND copy_digest GLOB '[0-9a-fA-F]*'),
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 0 AND 4194304),
  published_at INTEGER NOT NULL DEFAULT (unixepoch()),
  published_by TEXT NOT NULL CHECK(length(published_by) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision = 1),
  UNIQUE(workspace_id, category, source_id, source_revision),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_persistent_workspaces_chat ON persistent_workspaces(user_id, chat_id);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_sessions_turn ON persistent_workspace_turn_sessions(user_id, chat_id, turn_id, attempt_id);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_tasks_state ON persistent_workspace_tasks(user_id, chat_id, workspace_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_records_kind ON persistent_workspace_records(user_id, chat_id, workspace_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_submissions_state ON persistent_workspace_submissions(user_id, chat_id, workspace_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_artifacts_digest ON persistent_workspace_artifacts(user_id, chat_id, workspace_id, blob_digest);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_publications_source ON persistent_workspace_publications(user_id, chat_id, workspace_id, category, source_id, source_revision);

CREATE TRIGGER IF NOT EXISTS trg_persistent_workspace_publications_immutable_update
BEFORE UPDATE ON persistent_workspace_publications
WHEN NOT (
  NEW.publication_id IS OLD.publication_id
  AND NEW.workspace_id IS OLD.workspace_id
  AND NEW.user_id IS OLD.user_id
  AND NEW.category IS OLD.category
  AND NEW.source_id IS OLD.source_id
  AND NEW.source_revision IS OLD.source_revision
  AND NEW.source_created_at IS OLD.source_created_at
  AND NEW.source_updated_at IS OLD.source_updated_at
  AND NEW.copy_json IS OLD.copy_json
  AND NEW.copy_digest IS OLD.copy_digest
  AND NEW.byte_count IS OLD.byte_count
  AND NEW.published_at IS OLD.published_at
  AND NEW.published_by IS OLD.published_by
  AND NEW.revision IS OLD.revision
  AND (
    (
      OLD.chat_id IS NOT NULL
      AND NEW.chat_id IS NULL
      AND NEW.source_provenance_json IS OLD.source_provenance_json
      AND NEW.source_deleted_at IS OLD.source_deleted_at
    )
    OR (
      NEW.chat_id IS OLD.chat_id
      AND OLD.source_deleted_at IS NULL
      AND NEW.source_deleted_at IS NOT NULL
      AND NEW.source_provenance_json IS NOT OLD.source_provenance_json
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'persistent workspace publications are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_persistent_workspaces_archive_on_detach
AFTER UPDATE OF chat_id ON persistent_workspaces
WHEN OLD.chat_id IS NOT NULL AND NEW.chat_id IS NULL
BEGIN
  UPDATE persistent_workspaces
     SET state = 'archived',
         updated_at = unixepoch()
   WHERE workspace_id = NEW.workspace_id;
END;

-- Stage the exact deterministic legacy projection before any backfill.
-- Bun swallows an intermediate constraint error, so the failed unique-index
-- build is immediately followed by a missing-index assertion that propagates
-- before any persistent workspace/session/publication backfill.
DROP TABLE IF EXISTS temp.persistent_workspace_migration_projection;
DROP TABLE IF EXISTS temp.persistent_workspace_migration_collision;
DROP TABLE IF EXISTS temp.persistent_workspace_migration_guard;
CREATE TEMP TABLE persistent_workspace_migration_projection (
  workspace_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  quota_tasks INTEGER NOT NULL,
  quota_records INTEGER NOT NULL,
  quota_submissions INTEGER NOT NULL,
  quota_artifacts INTEGER NOT NULL,
  quota_publications INTEGER NOT NULL,
  quota_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO persistent_workspace_migration_projection (
  workspace_id, user_id, chat_id, objective, state, revision,
  quota_tasks, quota_records, quota_submissions, quota_artifacts, quota_publications,
  quota_bytes, created_at, updated_at
)
SELECT old.workspace_id, old.user_id, old.chat_id, old.objective,
       CASE old.state WHEN 'active' THEN 'active' ELSE 'archived' END,
       old.revision, old.quota_tasks, old.quota_records, old.quota_submissions,
       old.quota_artifacts, 512, old.quota_bytes, old.created_at, old.updated_at
  FROM agent_turn_workspaces AS old
 WHERE old.workspace_id = (
   SELECT MIN(candidate.workspace_id)
     FROM agent_turn_workspaces AS candidate
    WHERE candidate.user_id = old.user_id
      AND candidate.chat_id = old.chat_id
 );
CREATE TEMP TABLE persistent_workspace_migration_guard (
  valid INTEGER PRIMARY KEY CHECK(valid = 1)
);
INSERT INTO persistent_workspace_migration_guard (valid)
SELECT 1
  FROM temp.persistent_workspace_migration_projection
 LIMIT 1;
CREATE TEMP TABLE persistent_workspace_migration_collision (
  collision INTEGER
);
INSERT INTO persistent_workspace_migration_collision (collision)
SELECT 1
  FROM temp.persistent_workspace_migration_projection AS projection
  JOIN persistent_workspaces AS existing
    ON existing.workspace_id = projection.workspace_id
 WHERE NOT (
   existing.user_id IS projection.user_id
   AND existing.chat_id IS projection.chat_id
   AND existing.objective IS projection.objective
 )
 LIMIT 1;
INSERT INTO persistent_workspace_migration_collision (collision)
SELECT collision
  FROM persistent_workspace_migration_collision;
CREATE UNIQUE INDEX persistent_workspace_migration_collision_guard
  ON persistent_workspace_migration_collision(collision);
DROP INDEX persistent_workspace_migration_collision_guard;
DROP TABLE temp.persistent_workspace_migration_collision;
DROP TABLE temp.persistent_workspace_migration_guard;
INSERT INTO persistent_workspaces (
  workspace_id, user_id, chat_id, objective, metadata_json, progress_json, state, revision,
  quota_tasks, quota_records, quota_submissions, quota_artifacts, quota_publications, quota_bytes,
  created_at, updated_at
)
SELECT projection.workspace_id, projection.user_id, projection.chat_id, projection.objective, '{}', '{}',
       projection.state, projection.revision, projection.quota_tasks, projection.quota_records,
       projection.quota_submissions, projection.quota_artifacts, projection.quota_publications,
       projection.quota_bytes, projection.created_at, projection.updated_at
  FROM temp.persistent_workspace_migration_projection AS projection
 WHERE NOT EXISTS (
   SELECT 1 FROM persistent_workspaces AS existing
    WHERE existing.workspace_id = projection.workspace_id
      AND existing.user_id = projection.user_id
      AND existing.chat_id IS projection.chat_id
      AND existing.objective IS projection.objective
 );
DROP TABLE temp.persistent_workspace_migration_projection;

INSERT INTO persistent_workspace_turn_sessions (
  turn_session_id, workspace_id, user_id, chat_id, turn_id, attempt_id, execution_id,
  phase, status, outcome, reason, revision, created_at, updated_at, terminal_at
)
SELECT old.workspace_id, stable.workspace_id, old.user_id, old.chat_id, old.turn_id,
       execution.id, execution.id,
       CASE execution.state
         WHEN 'ASSEMBLE' THEN 'ASSEMBLE'
         WHEN 'WORK' THEN 'WORK'
         WHEN 'COMPLETE' THEN 'PREPARE_COMMIT'
         WHEN 'RENDER' THEN 'RENDER'
         WHEN 'PREPARE_COMMIT' THEN 'COMMIT'
         WHEN 'COMMITTING' THEN 'COMMIT'
         ELSE 'TERMINAL'
       END,
       CASE
         WHEN execution.state IN ('COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT') THEN 'terminal'
         WHEN execution.cancel_requested_at IS NOT NULL THEN 'cancelling'
         WHEN execution.state = 'PREPARE_COMMIT' THEN 'waiting'
         ELSE 'running'
       END,
       CASE
         WHEN execution.state = 'COMMITTED' THEN 'completed'
         WHEN execution.state = 'CANCELLED' THEN 'stopped'
         WHEN execution.state = 'TIMED_OUT' THEN 'failed'
         WHEN execution.state = 'EXHAUSTED' THEN 'exhausted'
         WHEN execution.state IN ('COMMIT_FAILED', 'FAILED')
           AND lower(COALESCE(execution.terminal_code, '')) IN ('cancelled', 'canceled', 'stopped', 'user_stop', 'accepted_cancellation', 'agentic_cancelled')
           THEN 'stopped'
         WHEN execution.state IN ('COMMIT_FAILED', 'FAILED')
           AND lower(COALESCE(execution.terminal_code, '')) <> 'root_wall_clock_limit_exceeded'
           AND (
             lower(COALESCE(execution.terminal_code, '')) IN ('exhausted', 'budget_exhausted', 'budget_exceeded', 'limit_exceeded', 'agentic_work_exhausted')
             OR lower(COALESCE(execution.terminal_code, '')) LIKE '%_limit_exceeded'
             OR lower(COALESCE(execution.terminal_code, '')) LIKE '%_budget_exhausted'
             OR lower(COALESCE(execution.terminal_code, '')) LIKE '%_budget_exceeded'
           ) THEN 'exhausted'
         WHEN execution.state IN ('COMMIT_FAILED', 'FAILED') THEN 'failed'
         ELSE NULL
       END,
       CASE
         WHEN execution.state IN ('COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
           AND length(COALESCE(execution.terminal_code, '')) BETWEEN 1 AND 128 THEN execution.terminal_code
         WHEN execution.state = 'CANCELLED' THEN 'cancelled'
         WHEN execution.state = 'TIMED_OUT' THEN 'timed_out'
         WHEN execution.state = 'EXHAUSTED' THEN 'exhausted'
         WHEN execution.state = 'FAILED' THEN 'failed'
         WHEN execution.state = 'COMMIT_FAILED' THEN 'commit_failed'
         ELSE 'none'
       END,
       execution.phase_revision, execution.created_at, execution.updated_at, execution.terminal_at
  FROM agent_turn_workspaces AS old
  JOIN agent_turn_executions AS execution
    ON execution.id = old.execution_id
   AND execution.user_id = old.user_id
   AND execution.chat_id = old.chat_id
  JOIN persistent_workspaces AS stable
    ON stable.user_id = old.user_id AND stable.chat_id = old.chat_id
 WHERE NOT EXISTS (
   SELECT 1 FROM persistent_workspace_turn_sessions AS existing
    WHERE existing.turn_session_id = old.workspace_id
      AND existing.workspace_id = stable.workspace_id
      AND existing.user_id = old.user_id
      AND existing.chat_id IS old.chat_id
      AND existing.turn_id = old.turn_id
      AND existing.attempt_id = execution.id
      AND existing.execution_id IS execution.id
 );


INSERT INTO persistent_workspace_publications (
  publication_id, workspace_id, user_id, chat_id, category, source_id, source_revision,
  source_provenance_json, source_created_at, source_updated_at, source_deleted_at, copy_json,
  copy_digest, byte_count, published_at, published_by, revision
)
SELECT old.published_artifact_id, stable.workspace_id, old.user_id, old.chat_id, 'artifact', old.source_artifact_id, 1,
       json_object(
         'workspaceId', stable.workspace_id,
         'turnSessionId', session.turn_session_id,
         'attemptId', session.attempt_id,
         'executionId', session.execution_id,
         'sourceChatId', old.chat_id,
         'creator', 'migration:106',
         'capturedAt', old.created_at
       ),
       old.created_at, old.created_at, NULL,
       json_object('category', 'artifact', 'id', old.source_artifact_id, 'blobDigest', old.blob_digest, 'mimeType', old.mime_type, 'byteCount', old.byte_count, 'provenance', 'migration:106'),
       old.digest, old.byte_count, old.created_at, 'migration:106', 1
  FROM agent_published_workspace_artifacts AS old
  JOIN persistent_workspaces AS stable
    ON stable.user_id = old.user_id AND stable.chat_id = old.chat_id
  LEFT JOIN agent_workspace_artifacts AS source
    ON source.artifact_id = old.source_artifact_id
   AND source.user_id = old.user_id
   AND source.chat_id = old.chat_id
  LEFT JOIN persistent_workspace_turn_sessions AS session
    ON session.turn_session_id = source.workspace_id
   AND session.workspace_id = stable.workspace_id
   AND session.user_id = old.user_id
 WHERE NOT EXISTS (
   SELECT 1 FROM persistent_workspace_publications AS existing
    WHERE existing.publication_id = old.published_artifact_id
      AND existing.workspace_id = stable.workspace_id
      AND existing.user_id = old.user_id
      AND existing.chat_id IS old.chat_id
      AND existing.category = 'artifact'
      AND existing.source_id = old.source_artifact_id
      AND existing.source_revision = 1
      AND existing.source_provenance_json IS json_object(
        'workspaceId', stable.workspace_id,
        'turnSessionId', session.turn_session_id,
        'attemptId', session.attempt_id,
        'executionId', session.execution_id,
        'sourceChatId', old.chat_id,
        'creator', 'migration:106',
        'capturedAt', old.created_at
      )
 );

UPDATE persistent_workspaces AS workspace
   SET task_count = (SELECT COUNT(*) FROM persistent_workspace_tasks WHERE workspace_id = workspace.workspace_id),
       record_count = (SELECT COUNT(*) FROM persistent_workspace_records WHERE workspace_id = workspace.workspace_id),
       submission_count = (SELECT COUNT(*) FROM persistent_workspace_submissions WHERE workspace_id = workspace.workspace_id),
       artifact_count = (SELECT COUNT(*) FROM persistent_workspace_artifacts WHERE workspace_id = workspace.workspace_id),
       publication_count = (SELECT COUNT(*) FROM persistent_workspace_publications WHERE workspace_id = workspace.workspace_id),
       byte_count = COALESCE((SELECT SUM(byte_count) FROM persistent_workspace_tasks WHERE workspace_id = workspace.workspace_id), 0)
                  + COALESCE((SELECT SUM(byte_count) FROM persistent_workspace_records WHERE workspace_id = workspace.workspace_id), 0)
                  + COALESCE((SELECT SUM(byte_count) FROM persistent_workspace_submissions WHERE workspace_id = workspace.workspace_id), 0)
                  + COALESCE((SELECT SUM(byte_count) FROM persistent_workspace_artifacts WHERE workspace_id = workspace.workspace_id), 0)
                  + COALESCE((SELECT SUM(byte_count) FROM persistent_workspace_publications WHERE workspace_id = workspace.workspace_id), 0);
-- Migration 117 used a pre-alpha operational task/submission vocabulary.
-- Rebuild those tables under the canonical workspace states while preserving
-- all retained operational rows and their ownership edges.
DROP INDEX IF EXISTS idx_agent_workspace_tasks_state;
DROP INDEX IF EXISTS idx_agent_workspace_records_kind;
DROP INDEX IF EXISTS idx_agent_workspace_submissions_state;
DROP INDEX IF EXISTS idx_agent_workspace_artifacts_publication;

ALTER TABLE agent_workspace_records RENAME TO agent_workspace_records_legacy_115;
ALTER TABLE agent_workspace_submissions RENAME TO agent_workspace_submissions_legacy_115;
ALTER TABLE agent_workspace_artifacts RENAME TO agent_workspace_artifacts_legacy_115;
ALTER TABLE agent_workspace_tasks RENAME TO agent_workspace_tasks_legacy_115;

CREATE TABLE agent_workspace_tasks (
  task_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 4096),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 65536),
  state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'blocked', 'completed', 'cancelled', 'failed')),
  required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0, 1)),
  dependencies_json TEXT NOT NULL DEFAULT '[]' CHECK(length(dependencies_json) <= 65536),
  assigned_frame_id TEXT,
  progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
  summary TEXT CHECK(summary IS NULL OR length(summary) <= 65536),
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 131072),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  cas_owner TEXT,
  cas_expires_at INTEGER,
  retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, task_id),
  FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE
);

INSERT INTO agent_workspace_tasks (
  task_id, workspace_id, turn_id, user_id, chat_id, title, description, state,
  required, dependencies_json, assigned_frame_id, progress, summary, byte_count,
  revision, cas_owner, cas_expires_at, retention, expires_at, created_at, updated_at
)
SELECT
  task_id, workspace_id, turn_id, user_id, chat_id, title, description,
  CASE state WHEN 'submitted' THEN 'completed' ELSE state END,
  required, dependencies_json, assigned_frame_id, progress, summary, byte_count,
  revision, cas_owner, cas_expires_at, retention, expires_at, created_at, updated_at
FROM agent_workspace_tasks_legacy_115;

CREATE TABLE agent_workspace_records (
  record_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('finding', 'decision', 'question')),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 65536),
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest GLOB '[0-9a-fA-F]*'),
  task_id TEXT,
  source_frame_id TEXT,
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 131072),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, record_id),
  UNIQUE(workspace_id, kind, digest),
  FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, task_id) REFERENCES agent_workspace_tasks(user_id, task_id) ON DELETE RESTRICT
);

INSERT INTO agent_workspace_records (
  record_id, workspace_id, turn_id, user_id, chat_id, kind, summary, digest,
  task_id, source_frame_id, byte_count, revision, retention, expires_at, created_at
)
SELECT
  record_id, workspace_id, turn_id, user_id, chat_id, kind, summary, digest,
  task_id, source_frame_id, byte_count, revision, retention, expires_at, created_at
FROM agent_workspace_records_legacy_115;

CREATE TABLE agent_workspace_submissions (
  submission_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  child_frame_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('submitted', 'accepted', 'rejected')),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 65536),
  result_digest TEXT NOT NULL CHECK(length(result_digest) = 64 AND result_digest GLOB '[0-9a-fA-F]*'),
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 131072),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, submission_id),
  UNIQUE(task_id, child_frame_id),
  FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, task_id) REFERENCES agent_workspace_tasks(user_id, task_id) ON DELETE CASCADE
);

INSERT INTO agent_workspace_submissions (
  submission_id, task_id, workspace_id, turn_id, user_id, chat_id, child_frame_id,
  state, summary, result_digest, byte_count, revision, retention, expires_at,
  created_at, updated_at
)
SELECT
  submission_id, task_id, workspace_id, turn_id, user_id, chat_id, child_frame_id,
  CASE state WHEN 'proposed' THEN 'submitted' ELSE state END,
  summary, result_digest, byte_count, revision, retention, expires_at,
  created_at, updated_at
FROM agent_workspace_submissions_legacy_115;

CREATE TABLE agent_workspace_artifacts (
  artifact_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  blob_digest TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 255),
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 2147483648),
  provenance_json TEXT NOT NULL CHECK(length(provenance_json) <= 65536),
  source_frame_id TEXT,
  source_task_id TEXT,
  publication_state TEXT NOT NULL CHECK(publication_state IN ('attached', 'proposed', 'published')),
  retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, artifact_id),
  UNIQUE(workspace_id, blob_digest),
  FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, source_task_id) REFERENCES agent_workspace_tasks(user_id, task_id) ON DELETE RESTRICT
);

INSERT INTO agent_workspace_artifacts (
  artifact_id, workspace_id, turn_id, user_id, chat_id, blob_digest, mime_type,
  byte_count, provenance_json, source_frame_id, source_task_id, publication_state,
  retention, revision, expires_at, created_at, updated_at
)
SELECT
  artifact_id, workspace_id, turn_id, user_id, chat_id, blob_digest, mime_type,
  byte_count, provenance_json, source_frame_id, source_task_id, publication_state,
  retention, revision, expires_at, created_at, updated_at
FROM agent_workspace_artifacts_legacy_115;

DROP TABLE agent_workspace_records_legacy_115;
DROP TABLE agent_workspace_submissions_legacy_115;
DROP TABLE agent_workspace_artifacts_legacy_115;
DROP TABLE agent_workspace_tasks_legacy_115;

CREATE INDEX IF NOT EXISTS idx_agent_workspace_tasks_state
  ON agent_workspace_tasks(user_id, workspace_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_workspace_records_kind
  ON agent_workspace_records(user_id, workspace_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_workspace_submissions_state
  ON agent_workspace_submissions(user_id, workspace_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_workspace_artifacts_publication
  ON agent_workspace_artifacts(user_id, workspace_id, publication_state, updated_at);


-- Final feature bundle step: 126_work_alpha1_inspection.sql

CREATE TABLE IF NOT EXISTS agent_run_attempts (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  previous_attempt_id TEXT,
  run_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  generation_type TEXT NOT NULL CHECK(generation_type IN ('normal', 'continue', 'regenerate', 'swipe')),
  target_message_id TEXT,
  target_swipe_id INTEGER CHECK(target_swipe_id IS NULL OR target_swipe_id >= 0),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'stopped', 'failed', 'exhausted', 'rejected')),
  reason TEXT NOT NULL DEFAULT 'none' CHECK(length(reason) <= 128),
  terminal INTEGER NOT NULL DEFAULT 0 CHECK(terminal IN (0, 1)),
  started_at INTEGER NOT NULL CHECK(started_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= 0),
  host_correlation_id TEXT NOT NULL CHECK(length(host_correlation_id) BETWEEN 1 AND 256),
  reconciliation_state TEXT NOT NULL DEFAULT 'authoritative' CHECK(reconciliation_state IN ('authoritative', 'reconciling', 'recovered', 'stale')),
  terminal_receipt_json TEXT CHECK(terminal_receipt_json IS NULL OR length(terminal_receipt_json) <= 16384),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version = 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(user_id, attempt_id),
  UNIQUE(user_id, run_id),
  UNIQUE(user_id, host_correlation_id),
  FOREIGN KEY (user_id, previous_attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE SET NULL,
  FOREIGN KEY (target_message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_chat_updated
  ON agent_run_attempts(user_id, chat_id, updated_at DESC, attempt_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_chat_target
  ON agent_run_attempts(user_id, chat_id, target_message_id, target_swipe_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_previous
  ON agent_run_attempts(user_id, previous_attempt_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_terminal
  ON agent_run_attempts(user_id, chat_id, terminal, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_audit_records (
  record_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('transcript', 'turn_session', 'activity', 'marker', 'usage', 'prompt', 'cortex', 'council', 'workspace', 'stop', 'recovery')),
  event_id TEXT,
  causal_parent_id TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
  late INTEGER NOT NULL DEFAULT 0 CHECK(late IN (0, 1)),
  payload_json TEXT NOT NULL CHECK(length(payload_json) <= 131072),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0 AND byte_size <= 131072),
  dedupe_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_audit_attempt_sequence
  ON agent_run_audit_records(user_id, attempt_id, host_sequence, record_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_audit_chat_time
  ON agent_run_audit_records(user_id, chat_id, occurred_at, record_id);

CREATE TABLE IF NOT EXISTS agent_run_turn_session_entries (
  entry_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  entry_kind TEXT NOT NULL CHECK(entry_kind IN ('target', 'input', 'policy', 'condition', 'hook', 'cancellation', 'completion', 'commit', 'terminal', 'retry', 'recovery')),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
  detail_json TEXT NOT NULL CHECK(length(detail_json) <= 65536),
  transcript_links_json TEXT NOT NULL DEFAULT '[]' CHECK(length(transcript_links_json) <= 8192),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, host_sequence, entry_kind)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_turn_session_entries_order
  ON agent_run_turn_session_entries(user_id, attempt_id, host_sequence, entry_id);

CREATE TABLE IF NOT EXISTS agent_run_activity_nodes (
  node_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  parent_node_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('root', 'provider', 'child', 'tool', 'milestone')),
  actor TEXT NOT NULL CHECK(actor IN ('host', 'owner', 'provider', 'agent', 'child', 'tool')),
  phase TEXT NOT NULL CHECK(phase IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal', 'omitted')),
  safe_label TEXT NOT NULL CHECK(length(safe_label) BETWEEN 1 AND 256),
  tool_id TEXT,
  task_id TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  started_at INTEGER NOT NULL CHECK(started_at >= 0),
  ended_at INTEGER CHECK(ended_at IS NULL OR ended_at >= started_at),
  elapsed_ms INTEGER CHECK(elapsed_ms IS NULL OR elapsed_ms >= 0),
  usage_json TEXT CHECK(usage_json IS NULL OR length(usage_json) <= 8192),
  detail_json TEXT CHECK(detail_json IS NULL OR length(detail_json) <= 16384),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_activity_nodes_order
  ON agent_run_activity_nodes(user_id, attempt_id, host_sequence, node_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_activity_nodes_target
  ON agent_run_activity_nodes(user_id, chat_id, attempt_id, kind, host_sequence);

CREATE TABLE IF NOT EXISTS agent_run_inspection_markers (
  marker_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  marker_kind TEXT NOT NULL CHECK(marker_kind IN ('reconnect_gap', 'late_event', 'reordered_event', 'truncated', 'unavailable', 'credentials_withheld', 'other_user_data_withheld', 'recovered_duplicate')),
  scope TEXT NOT NULL CHECK(scope IN ('run', 'activity', 'transcript', 'turn_session', 'usage', 'prompt', 'cortex', 'council', 'workspace')),
  host_sequence INTEGER,
  first_sequence INTEGER,
  last_sequence INTEGER,
  recoverable INTEGER CHECK(recoverable IS NULL OR recoverable IN (0, 1)),
  detail TEXT CHECK(detail IS NULL OR length(detail) <= 2048),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, marker_kind, scope, host_sequence)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_inspection_markers_order
  ON agent_run_inspection_markers(user_id, attempt_id, COALESCE(host_sequence, 0), marker_id);

CREATE TABLE IF NOT EXISTS agent_run_usage_evidence (
  usage_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('provider_reported', 'provisional', 'final', 'recovered_duplicate')),
  actor_id TEXT,
  phase TEXT,
  tool_id TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(total_tokens >= 0),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls >= 0),
  child_invocations INTEGER NOT NULL DEFAULT 0 CHECK(child_invocations >= 0),
  canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, usage_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_usage_attempt
  ON agent_run_usage_evidence(user_id, attempt_id, host_sequence, usage_id);

CREATE TABLE IF NOT EXISTS agent_run_prompt_evidence (
  prompt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 256),
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  destination TEXT NOT NULL CHECK(destination IN ('root_work', 'child_work', 'completion_handoff', 'render', 'council', 'cortex')),
  role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool', 'context', 'policy')),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  included INTEGER NOT NULL CHECK(included IN (0, 1)),
  content TEXT NOT NULL CHECK(length(content) <= 65536),
  content_digest TEXT NOT NULL CHECK(length(content_digest) = 64),
  omission_reason TEXT CHECK(omission_reason IS NULL OR length(omission_reason) <= 512),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, prompt_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_prompt_attempt
  ON agent_run_prompt_evidence(user_id, attempt_id, host_sequence, prompt_id);

CREATE TABLE IF NOT EXISTS agent_run_cortex_receipts (
  receipt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 256),
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  state TEXT NOT NULL CHECK(state IN ('accepted', 'omitted', 'failed', 'cancelled')),
  result_digest TEXT,
  result_count INTEGER NOT NULL DEFAULT 0 CHECK(result_count >= 0),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  reason TEXT CHECK(reason IS NULL OR length(reason) <= 512),
  canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical = 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, receipt_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_cortex_attempt
  ON agent_run_cortex_receipts(user_id, attempt_id, host_sequence, receipt_id);

CREATE TABLE IF NOT EXISTS agent_run_council_receipts (
  receipt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('accepted', 'omitted', 'failed', 'cancelled')),
  member_count INTEGER NOT NULL DEFAULT 0 CHECK(member_count >= 0),
  result_digest TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  reason TEXT CHECK(reason IS NULL OR length(reason) <= 512),
  canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical = 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, receipt_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_council_attempt
  ON agent_run_council_receipts(user_id, attempt_id, host_sequence, receipt_id);

CREATE TABLE IF NOT EXISTS agent_run_workspace_associations (
  association_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision >= 0),
  relation TEXT NOT NULL CHECK(relation IN ('linked', 'published', 'omitted')),
  object_kind TEXT NOT NULL CHECK(object_kind IN ('objective', 'task', 'finding', 'decision', 'question', 'submission', 'artifact', 'publication')),
  object_id TEXT,
  source_revision INTEGER,
  source_deleted INTEGER NOT NULL DEFAULT 0 CHECK(source_deleted IN (0, 1)),
  provenance_digest TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, association_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_workspace_associations_attempt
  ON agent_run_workspace_associations(user_id, attempt_id, host_sequence, association_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_workspace_associations_workspace
  ON agent_run_workspace_associations(user_id, workspace_id, workspace_revision);
-- Existing executions already carry the canonical attempt target and lifecycle.
-- Seed inspection attempts without inventing retry lineage or pending work.
INSERT OR IGNORE INTO agent_run_attempts (
  user_id, chat_id, attempt_id, previous_attempt_id, run_id, turn_id,
  generation_id, generation_type, target_message_id, target_swipe_id,
  lifecycle, status, outcome, reason, terminal, started_at, updated_at,
  terminal_at, host_correlation_id, reconciliation_state, terminal_receipt_json,
  created_at
)
SELECT
  execution.user_id,
  execution.chat_id,
  execution.id,
  NULL,
  execution.id,
  execution.id,
  execution.generation_id,
  execution.target_kind,
  execution.target_message_id,
  execution.target_swipe_id,
  CASE execution.state
    WHEN 'ASSEMBLE' THEN 'ASSEMBLE'
    WHEN 'WORK' THEN 'WORK'
    WHEN 'COMPLETE' THEN 'PREPARE_COMMIT'
    WHEN 'RENDER' THEN 'RENDER'
    WHEN 'PREPARE_COMMIT' THEN 'COMMIT'
    WHEN 'COMMITTING' THEN 'COMMIT'
    ELSE 'TERMINAL'
  END,
  CASE
    WHEN execution.state IN ('COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
      THEN 'terminal'
    WHEN execution.cancel_requested_at IS NOT NULL THEN 'cancelling'
    WHEN execution.state IN ('COMPLETE', 'PREPARE_COMMIT') THEN 'waiting'
    ELSE 'running'
  END,
  CASE
    WHEN execution.state = 'COMMITTED' THEN 'completed'
    WHEN execution.state = 'CANCELLED' THEN 'stopped'
    WHEN execution.state = 'TIMED_OUT' THEN 'failed'
    WHEN execution.state = 'EXHAUSTED' THEN 'exhausted'
    WHEN execution.state IN ('COMMIT_FAILED', 'FAILED')
      AND lower(COALESCE(execution.terminal_code, '')) IN ('cancelled', 'canceled', 'stopped', 'user_stop', 'accepted_cancellation', 'agentic_cancelled')
      THEN 'stopped'
    WHEN execution.state IN ('COMMIT_FAILED', 'FAILED')
      AND lower(COALESCE(execution.terminal_code, '')) <> 'root_wall_clock_limit_exceeded'
      AND (
        lower(COALESCE(execution.terminal_code, '')) IN ('exhausted', 'budget_exhausted', 'budget_exceeded', 'limit_exceeded', 'agentic_work_exhausted')
        OR lower(COALESCE(execution.terminal_code, '')) LIKE '%_limit_exceeded'
        OR lower(COALESCE(execution.terminal_code, '')) LIKE '%_budget_exhausted'
        OR lower(COALESCE(execution.terminal_code, '')) LIKE '%_budget_exceeded'
      ) THEN 'exhausted'
    WHEN execution.state IN ('COMMIT_FAILED', 'FAILED') THEN 'failed'
    ELSE NULL
  END,
  CASE
    WHEN execution.state IN ('COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
      AND length(COALESCE(execution.terminal_code, '')) BETWEEN 1 AND 128 THEN execution.terminal_code
    WHEN execution.state = 'TIMED_OUT' THEN 'timed_out'
    WHEN execution.state = 'CANCELLED' THEN 'cancelled'
    WHEN execution.state = 'EXHAUSTED' THEN 'exhausted'
    WHEN execution.state = 'FAILED' THEN 'failed'
    WHEN execution.state = 'COMMIT_FAILED' THEN 'commit_failed'
    ELSE 'none'
  END,
  CASE
    WHEN execution.state IN ('COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
      THEN 1
    ELSE 0
  END,
  execution.created_at,
  execution.updated_at,
  execution.terminal_at,
  'migration:116:' || execution.id,
  'recovered',
  NULL,
  execution.created_at
FROM agent_turn_executions AS execution;


-- Final feature bundle step: 127_agent_runtime_repair_acknowledgements.sql
CREATE TABLE IF NOT EXISTS agent_runtime_repair_acknowledgements (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
  preset_revision TEXT NOT NULL CHECK(length(preset_revision) BETWEEN 1 AND 512),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 512),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  acknowledged_at INTEGER NOT NULL CHECK(acknowledged_at >= 0),
  PRIMARY KEY (user_id, preset_id, preset_revision, reason_code)
);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_repair_ack_preset_revision
  ON agent_runtime_repair_acknowledgements(user_id, preset_id, preset_revision, acknowledged_at DESC);


-- Final feature bundle step: 129_agent_inspection_source_retention.sql
CREATE TABLE IF NOT EXISTS agent_run_source_deletions (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  previous_attempt_id TEXT CHECK(previous_attempt_id IS NULL OR length(previous_attempt_id) BETWEEN 1 AND 256),
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('chat', 'message', 'swipe')),
  target_message_id TEXT CHECK(target_message_id IS NULL OR length(target_message_id) BETWEEN 1 AND 256),
  target_swipe_id INTEGER CHECK(target_swipe_id IS NULL OR target_swipe_id >= 0),
  run_id TEXT CHECK(run_id IS NULL OR length(run_id) BETWEEN 1 AND 256),
  turn_id TEXT CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 256),
  generation_id TEXT CHECK(generation_id IS NULL OR length(generation_id) BETWEEN 1 AND 256),
  generation_type TEXT CHECK(generation_type IS NULL OR generation_type IN ('normal', 'continue', 'regenerate', 'swipe')),
  lifecycle TEXT CHECK(lifecycle IS NULL OR lifecycle IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT CHECK(status IS NULL OR status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'stopped', 'failed', 'exhausted', 'rejected')),
  terminal INTEGER CHECK(terminal IS NULL OR terminal IN (0, 1)),
  attempt_reason TEXT CHECK(attempt_reason IS NULL OR length(attempt_reason) <= 128),
  started_at INTEGER CHECK(started_at IS NULL OR started_at >= 0),
  updated_at INTEGER CHECK(updated_at IS NULL OR updated_at >= 0),
  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= 0),
  host_correlation_id TEXT CHECK(host_correlation_id IS NULL OR length(host_correlation_id) BETWEEN 1 AND 256),
  reconciliation_state TEXT CHECK(reconciliation_state IS NULL OR reconciliation_state IN ('authoritative', 'reconciling', 'recovered', 'stale')),
  attempt_version INTEGER CHECK(attempt_version IS NULL OR attempt_version >= 1),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  source_deleted_at INTEGER NOT NULL CHECK(source_deleted_at >= 0),
  reason TEXT NOT NULL DEFAULT 'source_deleted' CHECK(reason = 'source_deleted'),
  activity_json TEXT NOT NULL DEFAULT '[]' CHECK(length(activity_json) <= 65536 AND json_valid(activity_json)),
  usage_json TEXT NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0,"totalTokens":0,"toolCalls":0,"childInvocations":0}' CHECK(length(usage_json) <= 4096 AND json_valid(usage_json)),
  PRIMARY KEY(user_id, attempt_id),
  CHECK(target_swipe_id IS NULL OR target_message_id IS NOT NULL),
  CHECK(source_kind = 'chat' OR target_message_id IS NOT NULL),
  CHECK(source_kind <> 'swipe' OR target_swipe_id IS NOT NULL)
);
-- A deleted source owns its attempt ID permanently. Reject late writers even
-- when they arrive without a target message after the source row is gone.
CREATE TRIGGER IF NOT EXISTS trg_agent_run_attempts_reject_source_deleted
BEFORE INSERT ON agent_run_attempts
WHEN EXISTS (
  SELECT 1
    FROM agent_run_source_deletions
   WHERE user_id = NEW.user_id AND attempt_id = NEW.attempt_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent run attempt source was deleted');
END;


CREATE INDEX IF NOT EXISTS idx_agent_run_source_deletions_chat
  ON agent_run_source_deletions(user_id, chat_id, source_kind, target_message_id, target_swipe_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_source_deletions_attempt
  ON agent_run_source_deletions(user_id, attempt_id);
CREATE TABLE IF NOT EXISTS agent_run_source_deletion_workspace (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  association_id TEXT NOT NULL CHECK(length(association_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision >= 0),
  relation TEXT NOT NULL CHECK(relation IN ('linked', 'published', 'omitted')),
  object_kind TEXT NOT NULL CHECK(object_kind IN ('objective', 'task', 'finding', 'decision', 'question', 'submission', 'artifact', 'publication')),
  object_id TEXT CHECK(object_id IS NULL OR length(object_id) BETWEEN 1 AND 256),
  source_revision INTEGER CHECK(source_revision IS NULL OR source_revision >= 0),
  source_deleted INTEGER NOT NULL CHECK(source_deleted IN (0, 1)),
  provenance_digest TEXT CHECK(provenance_digest IS NULL OR length(provenance_digest) = 64),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  PRIMARY KEY(user_id, attempt_id, association_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_source_deletion_workspace_attempt
  ON agent_run_source_deletion_workspace(user_id, attempt_id, host_sequence, association_id);


-- Final feature bundle step: 130_cognition_task_provenance.sql
-- Keep authored cognition template identity separate from the turn-scoped
-- operational task identifier. NULL is reserved for ordinary workspace tasks.
ALTER TABLE agent_workspace_tasks
  ADD COLUMN cognition_template_id TEXT
    CHECK(cognition_template_id IS NULL OR length(cognition_template_id) BETWEEN 1 AND 128);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workspace_tasks_cognition_template
  ON agent_workspace_tasks(workspace_id, cognition_template_id)
  WHERE cognition_template_id IS NOT NULL;


-- Final feature bundle step: 131_persistent_workspace_session_detach.sql
-- Preserve persistent turn-session audit rows when their owner chat is deleted.
-- SQLite cannot alter a column's foreign-key action or nullability in place,
-- so rebuild only this table. The migration runner disables foreign-key
-- enforcement for this file while dependent child tables remain in place.
CREATE TABLE persistent_workspace_turn_sessions_new (
  turn_session_id TEXT PRIMARY KEY CHECK(length(turn_session_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 128),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 128),
  execution_id TEXT CHECK(execution_id IS NULL OR length(execution_id) BETWEEN 1 AND 128),
  phase TEXT NOT NULL DEFAULT 'ADMIT' CHECK(phase IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'stopped', 'failed', 'exhausted', 'rejected')),
  reason TEXT NOT NULL DEFAULT 'none' CHECK(length(reason) <= 128),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  terminal_at INTEGER,
  UNIQUE(user_id, turn_id, attempt_id),
  UNIQUE(workspace_id, turn_id, attempt_id),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

INSERT INTO persistent_workspace_turn_sessions_new (
  turn_session_id, workspace_id, user_id, chat_id, turn_id, attempt_id,
  execution_id, phase, status, outcome, reason, revision, created_at,
  updated_at, terminal_at
)
SELECT
  turn_session_id, workspace_id, user_id, chat_id, turn_id, attempt_id,
  execution_id, phase, status, outcome, reason, revision, created_at,
  updated_at, terminal_at
FROM persistent_workspace_turn_sessions;

DROP TABLE persistent_workspace_turn_sessions;
ALTER TABLE persistent_workspace_turn_sessions_new RENAME TO persistent_workspace_turn_sessions;

CREATE INDEX IF NOT EXISTS idx_persistent_workspace_sessions_turn
  ON persistent_workspace_turn_sessions(user_id, chat_id, turn_id, attempt_id);


-- Final feature bundle step: 132_persistent_workspace_chat_detach.sql
-- Keep persistent workspace children readable after their source chat is deleted.
-- Workspaces and turn sessions retain their own FK-driven SET NULL behavior;
-- these child tables intentionally use a trigger because their chat_id is
-- historical provenance rather than a live foreign-key association.
-- Older revisions could leave legacy publication trigger names installed, and
-- migration 125's archive trigger lacked the workspace revision bump.
DROP TRIGGER IF EXISTS persistent_workspace_publications_immutable_update;
DROP TRIGGER IF EXISTS persistent_workspaces_archive_on_detach;
DROP TRIGGER IF EXISTS trg_persistent_workspaces_archive_on_detach;
DROP TRIGGER IF EXISTS persistent_workspace_detach_children_on_chat_delete;

DROP TRIGGER IF EXISTS trg_persistent_workspace_publications_immutable_update;
CREATE TRIGGER IF NOT EXISTS trg_persistent_workspace_publications_immutable_update
BEFORE UPDATE ON persistent_workspace_publications
WHEN NOT (
  NEW.publication_id IS OLD.publication_id
  AND NEW.workspace_id IS OLD.workspace_id
  AND NEW.user_id IS OLD.user_id
  AND NEW.category IS OLD.category
  AND NEW.source_id IS OLD.source_id
  AND NEW.source_revision IS OLD.source_revision
  AND NEW.source_created_at IS OLD.source_created_at
  AND NEW.source_updated_at IS OLD.source_updated_at
  AND NEW.copy_json IS OLD.copy_json
  AND NEW.copy_digest IS OLD.copy_digest
  AND NEW.byte_count IS OLD.byte_count
  AND NEW.published_at IS OLD.published_at
  AND NEW.published_by IS OLD.published_by
  AND NEW.revision IS OLD.revision
  AND (
    (
      OLD.chat_id IS NOT NULL
      AND NEW.chat_id IS NULL
      AND NEW.source_provenance_json IS OLD.source_provenance_json
      AND NEW.source_deleted_at IS OLD.source_deleted_at
    )
    OR (
      NEW.chat_id IS OLD.chat_id
      AND OLD.source_deleted_at IS NULL
      AND NEW.source_deleted_at IS NOT NULL
      AND NEW.source_provenance_json IS NOT OLD.source_provenance_json
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'persistent workspace publications are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_persistent_workspaces_archive_on_detach
AFTER UPDATE OF chat_id ON persistent_workspaces
WHEN OLD.chat_id IS NOT NULL AND NEW.chat_id IS NULL
BEGIN
  UPDATE persistent_workspaces
     SET state = 'archived',
         revision = revision + 1,
         updated_at = unixepoch()
   WHERE workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_persistent_workspace_detach_children_on_chat_delete
AFTER DELETE ON chats
BEGIN
  UPDATE persistent_workspace_tasks
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_records
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_submissions
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_artifacts
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_publications
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
END;


-- Final feature bundle step: 133_agent_run_resync_snapshots.sql
-- Short-lived, owner-scoped full-resync snapshots. They freeze the exact
-- public run membership while a bounded cursor walks pages.
CREATE TABLE IF NOT EXISTS agent_run_resync_snapshots (
  snapshot_id TEXT PRIMARY KEY CHECK(length(snapshot_id) BETWEEN 1 AND 256),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  snapshot_sequence INTEGER NOT NULL CHECK(snapshot_sequence >= 0),
  snapshot_at INTEGER NOT NULL CHECK(snapshot_at >= 0),
  total_runs INTEGER NOT NULL CHECK(total_runs >= 0),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  omitted_runs INTEGER NOT NULL DEFAULT 0 CHECK(omitted_runs >= 0),
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_run_resync_snapshots_owner_expiry
  ON agent_run_resync_snapshots(user_id, chat_id, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_resync_snapshots_watermark
  ON agent_run_resync_snapshots(user_id, chat_id, snapshot_sequence);

CREATE TABLE IF NOT EXISTS agent_run_resync_snapshot_members (
  snapshot_id TEXT NOT NULL REFERENCES agent_run_resync_snapshots(snapshot_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 256),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  run_json TEXT NOT NULL CHECK(length(run_json) <= 65536 AND json_valid(run_json)),
  PRIMARY KEY (snapshot_id, ordinal),
  UNIQUE (snapshot_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_resync_snapshot_members_key
  ON agent_run_resync_snapshot_members(snapshot_id, updated_at DESC, turn_id DESC);

-- Final feature bundle step: 134_bounded_resync_and_portable_artifacts.sql
-- Canonical paths are portable owner-relative references; host paths stay operational.
CREATE TRIGGER IF NOT EXISTS trg_agent_published_artifact_relative_path_insert
BEFORE INSERT ON agent_published_workspace_artifacts
WHEN NEW.storage_path LIKE '/%'
  OR NEW.storage_path GLOB '[A-Za-z]:*'
  OR NEW.storage_path LIKE '%\%'
  OR NEW.storage_path = '..' OR NEW.storage_path LIKE '../%'
  OR NEW.storage_path LIKE '%/../%' OR NEW.storage_path LIKE '%/..'
  OR NEW.storage_path = '.' OR NEW.storage_path LIKE './%'
  OR NEW.storage_path LIKE '%/./%' OR NEW.storage_path LIKE '%/.'
  OR NEW.storage_path LIKE '%//%' OR NEW.storage_path LIKE '%/'
  OR NEW.storage_path GLOB '*[^A-Za-z0-9._/-]*'
BEGIN
  SELECT RAISE(ABORT, 'published artifact storage_path must be portable and owner-relative');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_published_artifact_relative_path_update
BEFORE UPDATE OF storage_path ON agent_published_workspace_artifacts
WHEN NEW.storage_path LIKE '/%'
  OR NEW.storage_path GLOB '[A-Za-z]:*'
  OR NEW.storage_path LIKE '%\%'
  OR NEW.storage_path = '..' OR NEW.storage_path LIKE '../%'
  OR NEW.storage_path LIKE '%/../%' OR NEW.storage_path LIKE '%/..'
  OR NEW.storage_path = '.' OR NEW.storage_path LIKE './%'
  OR NEW.storage_path LIKE '%/./%' OR NEW.storage_path LIKE '%/.'
  OR NEW.storage_path LIKE '%//%' OR NEW.storage_path LIKE '%/'
  OR NEW.storage_path GLOB '*[^A-Za-z0-9._/-]*'
BEGIN
  SELECT RAISE(ABORT, 'published artifact storage_path must be portable and owner-relative');
END;

-- Final feature bundle step: 135_agent_work_segments.sql
-- Durable V1 state for bounded WORK segments. Historical executions are not backfilled.
-- Provider transcripts, reasoning, carriers, tool arguments/results, and external effects are absent by design.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_attempts_execution_identity
  ON agent_run_attempts(user_id, turn_id, attempt_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_turn_workspaces_execution_identity
  ON agent_turn_workspaces(user_id, execution_id, workspace_id);

CREATE TABLE IF NOT EXISTS agent_work_segment_recovery (
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 256),
  execution_id TEXT NOT NULL CHECK(length(execution_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision BETWEEN 0 AND 9007199254740991),
  execution_cas_revision INTEGER NOT NULL CHECK(execution_cas_revision BETWEEN 0 AND 9007199254740991),
  recovery_epoch INTEGER NOT NULL DEFAULT 0 CHECK(recovery_epoch BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('active', 'closed')),
  phase_id TEXT CHECK(phase_id IS NULL OR length(phase_id) BETWEEN 1 AND 256),
  phase_index INTEGER CHECK(phase_index IS NULL OR phase_index BETWEEN 0 AND 1000000),
  phase_occurrence INTEGER CHECK(phase_occurrence IS NULL OR phase_occurrence BETWEEN 0 AND 1000000),
  next_segment_ordinal INTEGER NOT NULL CHECK(next_segment_ordinal BETWEEN 0 AND 1000000),
  current_segment_id TEXT CHECK(current_segment_id IS NULL OR length(current_segment_id) BETWEEN 1 AND 256),
  remaining_required_phase_count INTEGER NOT NULL CHECK(remaining_required_phase_count BETWEEN 0 AND 1000000),
  initial_required_phase_count INTEGER NOT NULL CHECK(initial_required_phase_count BETWEEN 0 AND 1000000),
  snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*'),
  phase_plan_digest TEXT NOT NULL CHECK(length(phase_plan_digest) = 64 AND phase_plan_digest NOT GLOB '*[^0-9a-f]*'),
  phase_plan_json TEXT NOT NULL CHECK(length(phase_plan_json) BETWEEN 25 AND 65536 AND json_valid(phase_plan_json) AND json_type(phase_plan_json) = 'object'),
  binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64 AND binding_digest NOT GLOB '*[^0-9a-f]*'),
  resume_envelope_digest TEXT NOT NULL CHECK(length(resume_envelope_digest) = 64 AND resume_envelope_digest NOT GLOB '*[^0-9a-f]*'),
  resume_envelope_json TEXT NOT NULL CHECK(length(resume_envelope_json) BETWEEN 256 AND 8388608 AND json_valid(resume_envelope_json) AND json_type(resume_envelope_json) = 'object'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  record_complete INTEGER NOT NULL DEFAULT 1 CHECK(record_complete = 1),

  max_segments INTEGER NOT NULL CHECK(max_segments BETWEEN 1 AND 1000000),
  max_provider_dispatches INTEGER NOT NULL CHECK(max_provider_dispatches BETWEEN 1 AND 2147483648),
  max_provider_output_tokens INTEGER NOT NULL CHECK(max_provider_output_tokens BETWEEN 1 AND 2147483648),
  max_output_tokens_per_dispatch INTEGER NOT NULL CHECK(max_output_tokens_per_dispatch BETWEEN 1 AND 2147483648),
  max_unsigned_boundaries INTEGER NOT NULL CHECK(max_unsigned_boundaries BETWEEN 0 AND 2147483648),
  max_tool_calls INTEGER NOT NULL CHECK(max_tool_calls BETWEEN 0 AND 2147483648),
  max_workspace_operations INTEGER NOT NULL CHECK(max_workspace_operations BETWEEN 0 AND 2147483648),
  recovery_reserve_output_tokens INTEGER NOT NULL CHECK(recovery_reserve_output_tokens BETWEEN 0 AND 2147483648),
  future_phase_reserve_output_tokens INTEGER NOT NULL CHECK(future_phase_reserve_output_tokens BETWEEN 0 AND 2147483648),
  protected_recovery_reserve_output_tokens INTEGER NOT NULL CHECK(protected_recovery_reserve_output_tokens BETWEEN 0 AND 2147483648),
  protected_future_phase_reserve_output_tokens INTEGER NOT NULL CHECK(protected_future_phase_reserve_output_tokens BETWEEN 0 AND 2147483648),
  terminal_close_result TEXT CHECK(terminal_close_result IS NULL OR terminal_close_result IN ('failed', 'exhausted', 'cancelled')),
  terminal_close_reason TEXT CHECK(terminal_close_reason IS NULL OR length(terminal_close_reason) BETWEEN 1 AND 256),
  terminal_boundary_class TEXT CHECK(terminal_boundary_class IS NULL OR terminal_boundary_class IN (
    'tool_action', 'tool_free_stop', 'reasoning_only_stop', 'reasoning_only_length',
    'empty_provider_response', 'provider_protocol_failure'
  )),

  segment_count INTEGER NOT NULL DEFAULT 0 CHECK(segment_count BETWEEN 0 AND 1000000),
  provider_dispatches INTEGER NOT NULL DEFAULT 0 CHECK(provider_dispatches BETWEEN 0 AND 2147483648),
  provider_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(provider_input_tokens BETWEEN 0 AND 9007199254740991),
  provider_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(provider_output_tokens BETWEEN 0 AND 2147483648),
  provider_total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(provider_total_tokens BETWEEN 0 AND 9007199254740991),
  billed_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(billed_output_tokens BETWEEN 0 AND 2147483648),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls BETWEEN 0 AND 2147483648),
  workspace_operations INTEGER NOT NULL DEFAULT 0 CHECK(workspace_operations BETWEEN 0 AND 2147483648),
  unsigned_boundaries INTEGER NOT NULL DEFAULT 0 CHECK(unsigned_boundaries BETWEEN 0 AND 2147483648),
  receive_bytes INTEGER NOT NULL DEFAULT 0 CHECK(receive_bytes BETWEEN 0 AND 9007199254740991),
  published_output_bytes INTEGER NOT NULL DEFAULT 0 CHECK(published_output_bytes BETWEEN 0 AND 9007199254740991),

  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (user_id, execution_id),
  UNIQUE (user_id, idempotency_key),
  UNIQUE (user_id, execution_id, attempt_id, workspace_id),
  CHECK(
    (state = 'active' AND phase_index IS NOT NULL AND phase_occurrence IS NOT NULL)
    OR (state = 'closed' AND phase_id IS NULL AND phase_index IS NULL AND phase_occurrence IS NULL)
  ),
  CHECK(recovery_reserve_output_tokens + future_phase_reserve_output_tokens <= max_provider_output_tokens),
  CHECK(max_output_tokens_per_dispatch <= max_provider_output_tokens),
  CHECK(protected_recovery_reserve_output_tokens <= recovery_reserve_output_tokens),
  CHECK(protected_future_phase_reserve_output_tokens <= future_phase_reserve_output_tokens),
  CHECK(protected_recovery_reserve_output_tokens + protected_future_phase_reserve_output_tokens <= max_provider_output_tokens),
  CHECK(remaining_required_phase_count <= initial_required_phase_count),
  CHECK(initial_required_phase_count > 0 OR future_phase_reserve_output_tokens = 0),
  CHECK((state = 'active') OR current_segment_id IS NULL),
  CHECK((terminal_close_result IS NULL AND terminal_close_reason IS NULL AND terminal_boundary_class IS NULL)
    OR (state = 'closed' AND terminal_close_result IS NOT NULL AND terminal_close_reason IS NOT NULL)),
  CHECK(next_segment_ordinal < max_segments OR state = 'closed'),
  CHECK(segment_count <= max_segments),
  CHECK(provider_dispatches <= max_provider_dispatches),
  CHECK(provider_output_tokens <= max_provider_output_tokens),
  CHECK(billed_output_tokens <= max_provider_output_tokens),
  CHECK(unsigned_boundaries <= max_unsigned_boundaries),
  CHECK(tool_calls <= max_tool_calls),
  CHECK(workspace_operations <= max_workspace_operations),
  CHECK(provider_total_tokens >= provider_input_tokens AND provider_total_tokens >= provider_output_tokens),
  CHECK(billed_output_tokens >= provider_output_tokens),
  FOREIGN KEY (user_id, execution_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, execution_id, attempt_id)
    REFERENCES agent_run_attempts(user_id, turn_id, attempt_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, execution_id, workspace_id)
    REFERENCES agent_turn_workspaces(user_id, execution_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_work_segments (
  segment_id TEXT PRIMARY KEY CHECK(length(segment_id) BETWEEN 1 AND 256),
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 256),
  execution_id TEXT NOT NULL CHECK(length(execution_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision BETWEEN 0 AND 9007199254740991),
  execution_cas_revision INTEGER NOT NULL CHECK(execution_cas_revision BETWEEN 0 AND 9007199254740991),
  source_transition_id TEXT CHECK(source_transition_id IS NULL OR length(source_transition_id) BETWEEN 1 AND 256),
  phase_id TEXT CHECK(phase_id IS NULL OR length(phase_id) BETWEEN 1 AND 256),
  phase_index INTEGER NOT NULL CHECK(phase_index BETWEEN 0 AND 1000000),
  phase_occurrence INTEGER NOT NULL CHECK(phase_occurrence BETWEEN 0 AND 1000000),
  segment_ordinal INTEGER NOT NULL CHECK(segment_ordinal BETWEEN 0 AND 1000000),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('admitted', 'running', 'closed', 'interrupted', 'failed', 'exhausted', 'cancelled')),
  admission_key TEXT NOT NULL CHECK(length(admission_key) BETWEEN 1 AND 256),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  context_digest TEXT NOT NULL CHECK(length(context_digest) = 64 AND context_digest NOT GLOB '*[^0-9a-f]*'),
  context_json TEXT NOT NULL CHECK(length(context_json) BETWEEN 64 AND 1048576 AND json_valid(context_json) AND json_type(context_json) = 'object'),
  snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*'),
  binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64 AND binding_digest NOT GLOB '*[^0-9a-f]*'),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  record_complete INTEGER NOT NULL DEFAULT 1 CHECK(record_complete = 1),

  max_provider_dispatches INTEGER NOT NULL CHECK(max_provider_dispatches BETWEEN 1 AND 2147483648),
  max_provider_output_tokens INTEGER NOT NULL CHECK(max_provider_output_tokens BETWEEN 1 AND 2147483648),
  max_output_tokens_per_dispatch INTEGER NOT NULL CHECK(max_output_tokens_per_dispatch BETWEEN 1 AND 2147483648),
  max_unsigned_boundaries INTEGER NOT NULL CHECK(max_unsigned_boundaries BETWEEN 0 AND 2147483648),
  max_tool_calls INTEGER NOT NULL CHECK(max_tool_calls BETWEEN 0 AND 2147483648),
  max_workspace_operations INTEGER NOT NULL CHECK(max_workspace_operations BETWEEN 0 AND 2147483648),

  provider_dispatches INTEGER NOT NULL DEFAULT 0 CHECK(provider_dispatches BETWEEN 0 AND 2147483648),
  provider_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(provider_input_tokens BETWEEN 0 AND 9007199254740991),
  provider_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(provider_output_tokens BETWEEN 0 AND 2147483648),
  provider_total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(provider_total_tokens BETWEEN 0 AND 9007199254740991),
  billed_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(billed_output_tokens BETWEEN 0 AND 2147483648),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls BETWEEN 0 AND 2147483648),
  workspace_operations INTEGER NOT NULL DEFAULT 0 CHECK(workspace_operations BETWEEN 0 AND 2147483648),
  unsigned_boundaries INTEGER NOT NULL DEFAULT 0 CHECK(unsigned_boundaries BETWEEN 0 AND 2147483648),
  receive_bytes INTEGER NOT NULL DEFAULT 0 CHECK(receive_bytes BETWEEN 0 AND 9007199254740991),
  published_output_bytes INTEGER NOT NULL DEFAULT 0 CHECK(published_output_bytes BETWEEN 0 AND 9007199254740991),

  boundary_class TEXT CHECK(boundary_class IS NULL OR boundary_class IN (
    'tool_action', 'tool_free_stop', 'reasoning_only_stop', 'reasoning_only_length',
    'empty_provider_response', 'provider_protocol_failure'
  )),
  close_result TEXT CHECK(close_result IS NULL OR close_result IN (
    'phase_advanced', 'phase_repeated', 'same_phase_rollover', 'work_complete',
    'failed', 'exhausted', 'cancelled'
  )),
  closed_workspace_revision INTEGER CHECK(closed_workspace_revision IS NULL OR closed_workspace_revision BETWEEN 0 AND 9007199254740991),
  closed_execution_cas_revision INTEGER CHECK(closed_execution_cas_revision IS NULL OR closed_execution_cas_revision BETWEEN 0 AND 9007199254740991),
  closure_digest TEXT CHECK(closure_digest IS NULL OR (length(closure_digest) = 64 AND closure_digest NOT GLOB '*[^0-9a-f]*')),
  close_reason TEXT CHECK(close_reason IS NULL OR length(close_reason) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991),
  closed_at INTEGER CHECK(closed_at IS NULL OR closed_at BETWEEN 0 AND 9007199254740991),
  CHECK(max_output_tokens_per_dispatch <= max_provider_output_tokens),

  UNIQUE (user_id, execution_id, segment_id),
  UNIQUE (user_id, execution_id, segment_id, attempt_id, workspace_id),
  UNIQUE (user_id, execution_id, segment_ordinal),
  UNIQUE (user_id, execution_id, admission_key),
  CHECK(phase_occurrence <= segment_ordinal),
  CHECK(
    (segment_ordinal = 0 AND source_transition_id IS NULL)
    OR (segment_ordinal > 0 AND source_transition_id IS NOT NULL)
  ),
  CHECK(provider_dispatches <= max_provider_dispatches),
  CHECK(provider_output_tokens <= max_provider_output_tokens),
  CHECK(billed_output_tokens <= max_provider_output_tokens),
  CHECK(unsigned_boundaries <= max_unsigned_boundaries),
  CHECK(tool_calls <= max_tool_calls),
  CHECK(workspace_operations <= max_workspace_operations),
  CHECK(provider_total_tokens >= provider_input_tokens AND provider_total_tokens >= provider_output_tokens),
  CHECK(billed_output_tokens >= provider_output_tokens),
  CHECK(
    (lifecycle IN ('admitted', 'running') AND close_result IS NULL AND close_reason IS NULL
      AND closed_workspace_revision IS NULL AND closed_execution_cas_revision IS NULL
      AND closure_digest IS NULL AND closed_at IS NULL)
    OR (lifecycle IN ('closed', 'interrupted', 'failed', 'exhausted', 'cancelled') AND close_result IS NOT NULL
      AND close_reason IS NOT NULL AND closed_workspace_revision IS NOT NULL
      AND closed_execution_cas_revision IS NOT NULL AND closure_digest IS NOT NULL AND closed_at IS NOT NULL)
  ),
  FOREIGN KEY (user_id, execution_id, attempt_id, workspace_id)
    REFERENCES agent_work_segment_recovery(user_id, execution_id, attempt_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, execution_id, source_transition_id)
    REFERENCES agent_work_segment_transitions(user_id, execution_id, transition_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_work_segment_transitions (
  transition_id TEXT PRIMARY KEY CHECK(length(transition_id) BETWEEN 1 AND 256),
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 256),
  execution_id TEXT NOT NULL CHECK(length(execution_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision BETWEEN 0 AND 9007199254740991),
  execution_cas_revision INTEGER NOT NULL CHECK(execution_cas_revision BETWEEN 0 AND 9007199254740991),
  source_segment_id TEXT NOT NULL CHECK(length(source_segment_id) BETWEEN 1 AND 256),
  transition_kind TEXT NOT NULL CHECK(transition_kind IN ('advance', 'repeat', 'rollover', 'terminal')),
  target_phase_id TEXT CHECK(target_phase_id IS NULL OR length(target_phase_id) BETWEEN 1 AND 256),
  target_phase_index INTEGER CHECK(target_phase_index IS NULL OR target_phase_index BETWEEN 0 AND 1000000),
  target_phase_occurrence INTEGER CHECK(target_phase_occurrence IS NULL OR target_phase_occurrence BETWEEN 0 AND 1000000),
  target_segment_ordinal INTEGER CHECK(target_segment_ordinal IS NULL OR target_segment_ordinal BETWEEN 0 AND 1000000),
  remaining_required_phase_count INTEGER NOT NULL CHECK(remaining_required_phase_count BETWEEN 0 AND 1000000),
  released_future_phase_reserve_output_tokens INTEGER NOT NULL CHECK(released_future_phase_reserve_output_tokens BETWEEN 0 AND 2147483648),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  phase_plan_digest TEXT NOT NULL CHECK(length(phase_plan_digest) = 64 AND phase_plan_digest NOT GLOB '*[^0-9a-f]*'),
  transition_decision_digest TEXT NOT NULL CHECK(length(transition_decision_digest) = 64 AND transition_decision_digest NOT GLOB '*[^0-9a-f]*'),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  record_complete INTEGER NOT NULL DEFAULT 1 CHECK(record_complete = 1),

  advisory_authority TEXT NOT NULL DEFAULT 'model_advisory' CHECK(advisory_authority = 'model_advisory'),
  advisory_summary TEXT NOT NULL CHECK(length(advisory_summary) BETWEEN 1 AND 16384),
  advisory_unresolved_ids_json TEXT NOT NULL CHECK(
    length(advisory_unresolved_ids_json) BETWEEN 2 AND 65536
    AND json_valid(advisory_unresolved_ids_json)
    AND json_type(advisory_unresolved_ids_json) = 'array'
  ),
  advisory_render_guidance TEXT CHECK(advisory_render_guidance IS NULL OR length(advisory_render_guidance) <= 8192),
  accepted_ids_authority TEXT NOT NULL DEFAULT 'host' CHECK(accepted_ids_authority = 'host'),
  accepted_task_ids_json TEXT NOT NULL CHECK(length(accepted_task_ids_json) BETWEEN 2 AND 65536 AND json_valid(accepted_task_ids_json) AND json_type(accepted_task_ids_json) = 'array'),
  accepted_submission_ids_json TEXT NOT NULL CHECK(length(accepted_submission_ids_json) BETWEEN 2 AND 65536 AND json_valid(accepted_submission_ids_json) AND json_type(accepted_submission_ids_json) = 'array'),
  accepted_finding_ids_json TEXT NOT NULL CHECK(length(accepted_finding_ids_json) BETWEEN 2 AND 65536 AND json_valid(accepted_finding_ids_json) AND json_type(accepted_finding_ids_json) = 'array'),
  accepted_decision_ids_json TEXT NOT NULL CHECK(length(accepted_decision_ids_json) BETWEEN 2 AND 65536 AND json_valid(accepted_decision_ids_json) AND json_type(accepted_decision_ids_json) = 'array'),
  accepted_artifact_ids_json TEXT NOT NULL CHECK(length(accepted_artifact_ids_json) BETWEEN 2 AND 65536 AND json_valid(accepted_artifact_ids_json) AND json_type(accepted_artifact_ids_json) = 'array'),
  open_required_ids_json TEXT NOT NULL CHECK(length(open_required_ids_json) BETWEEN 2 AND 65536 AND json_valid(open_required_ids_json) AND json_type(open_required_ids_json) = 'array'),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),

  UNIQUE (user_id, execution_id, transition_id),
  UNIQUE (user_id, execution_id, source_segment_id),
  UNIQUE (user_id, execution_id, idempotency_key),
  CHECK(
    (transition_kind = 'terminal' AND target_phase_id IS NULL AND target_phase_index IS NULL
      AND target_phase_occurrence IS NULL AND target_segment_ordinal IS NULL)
    OR (transition_kind <> 'terminal' AND target_phase_index IS NOT NULL
      AND target_phase_occurrence IS NOT NULL AND target_segment_ordinal IS NOT NULL)
  ),
  FOREIGN KEY (user_id, execution_id, attempt_id, workspace_id)
    REFERENCES agent_work_segment_recovery(user_id, execution_id, attempt_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, execution_id, source_segment_id, attempt_id, workspace_id)
    REFERENCES agent_work_segments(user_id, execution_id, segment_id, attempt_id, workspace_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS agent_work_segment_dispatches (
  dispatch_id TEXT PRIMARY KEY CHECK(length(dispatch_id) BETWEEN 1 AND 256),
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 256),
  execution_id TEXT NOT NULL CHECK(length(execution_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  segment_id TEXT NOT NULL CHECK(length(segment_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision BETWEEN 0 AND 9007199254740991),
  execution_cas_revision INTEGER NOT NULL CHECK(execution_cas_revision BETWEEN 0 AND 9007199254740991),
  dispatch_ordinal INTEGER NOT NULL CHECK(dispatch_ordinal BETWEEN 0 AND 2147483648),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('reserved', 'in_flight', 'settled', 'interrupted')),
  tool_mode TEXT NOT NULL CHECK(tool_mode IN ('ordinary', 'required')),
  budget_class TEXT NOT NULL CHECK(budget_class IN ('normal', 'recovery')),
  reserved_output_tokens INTEGER NOT NULL CHECK(reserved_output_tokens BETWEEN 1 AND 2147483648),
  ordinary_output_tokens_reserved INTEGER NOT NULL CHECK(ordinary_output_tokens_reserved BETWEEN 0 AND 2147483648),
  recovery_reserve_output_tokens_reserved INTEGER NOT NULL CHECK(recovery_reserve_output_tokens_reserved BETWEEN 0 AND 2147483648),
  lease_owner TEXT CHECK(lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 256),
  lease_expires_at INTEGER CHECK(lease_expires_at IS NULL OR lease_expires_at BETWEEN 0 AND 9007199254740991),
  fence_generation INTEGER NOT NULL CHECK(fence_generation BETWEEN 1 AND 2147483648),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  record_complete INTEGER NOT NULL DEFAULT 1 CHECK(record_complete = 1),

  settlement_key TEXT CHECK(settlement_key IS NULL OR length(settlement_key) BETWEEN 1 AND 256),
  settlement_digest TEXT CHECK(settlement_digest IS NULL OR (length(settlement_digest) = 64 AND settlement_digest NOT GLOB '*[^0-9a-f]*')),
  interruption_reason TEXT CHECK(interruption_reason IS NULL OR length(interruption_reason) BETWEEN 1 AND 256),
  settled_workspace_revision INTEGER CHECK(settled_workspace_revision IS NULL OR settled_workspace_revision BETWEEN 0 AND 9007199254740991),
  settled_execution_cas_revision INTEGER CHECK(settled_execution_cas_revision IS NULL OR settled_execution_cas_revision BETWEEN 0 AND 9007199254740991),
  boundary_class TEXT CHECK(boundary_class IS NULL OR boundary_class IN (
    'tool_action', 'tool_free_stop', 'reasoning_only_stop', 'reasoning_only_length',
    'empty_provider_response', 'provider_protocol_failure'
  )),
  provider_input_tokens INTEGER CHECK(provider_input_tokens IS NULL OR provider_input_tokens BETWEEN 0 AND 9007199254740991),
  provider_output_tokens INTEGER CHECK(provider_output_tokens IS NULL OR provider_output_tokens BETWEEN 0 AND 2147483648),
  provider_total_tokens INTEGER CHECK(provider_total_tokens IS NULL OR provider_total_tokens BETWEEN 0 AND 9007199254740991),
  billed_output_tokens INTEGER CHECK(billed_output_tokens IS NULL OR billed_output_tokens BETWEEN 0 AND 2147483648),
  recovery_reserve_output_tokens_consumed INTEGER CHECK(recovery_reserve_output_tokens_consumed IS NULL OR recovery_reserve_output_tokens_consumed BETWEEN 0 AND 2147483648),
  tool_calls INTEGER CHECK(tool_calls IS NULL OR tool_calls BETWEEN 0 AND 2147483648),
  workspace_operations INTEGER CHECK(workspace_operations IS NULL OR workspace_operations BETWEEN 0 AND 2147483648),
  unsigned_boundaries INTEGER CHECK(unsigned_boundaries IS NULL OR unsigned_boundaries BETWEEN 0 AND 2147483648),
  receive_bytes INTEGER CHECK(receive_bytes IS NULL OR receive_bytes BETWEEN 0 AND 9007199254740991),
  published_output_bytes INTEGER CHECK(published_output_bytes IS NULL OR published_output_bytes BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  started_at INTEGER CHECK(started_at IS NULL OR started_at BETWEEN 0 AND 9007199254740991),
  settled_at INTEGER CHECK(settled_at IS NULL OR settled_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991),

  UNIQUE (user_id, execution_id, dispatch_id),
  UNIQUE (user_id, execution_id, segment_id, dispatch_ordinal),
  UNIQUE (user_id, execution_id, idempotency_key),
  UNIQUE (user_id, execution_id, settlement_key),
  CHECK(ordinary_output_tokens_reserved + recovery_reserve_output_tokens_reserved = reserved_output_tokens),
  CHECK((budget_class = 'normal' AND recovery_reserve_output_tokens_reserved = 0) OR budget_class = 'recovery'),
  CHECK(recovery_reserve_output_tokens_consumed IS NULL OR recovery_reserve_output_tokens_consumed <= recovery_reserve_output_tokens_reserved),
  CHECK(
    (provider_input_tokens IS NULL AND provider_output_tokens IS NULL AND provider_total_tokens IS NULL
      AND billed_output_tokens IS NULL AND recovery_reserve_output_tokens_consumed IS NULL
      AND tool_calls IS NULL AND workspace_operations IS NULL AND unsigned_boundaries IS NULL
      AND receive_bytes IS NULL AND published_output_bytes IS NULL)
    OR (provider_input_tokens IS NOT NULL AND provider_output_tokens IS NOT NULL AND provider_total_tokens IS NOT NULL
      AND billed_output_tokens IS NOT NULL AND recovery_reserve_output_tokens_consumed IS NOT NULL
      AND tool_calls IS NOT NULL AND workspace_operations IS NOT NULL AND unsigned_boundaries IS NOT NULL
      AND receive_bytes IS NOT NULL AND published_output_bytes IS NOT NULL)
  ),
  CHECK(
    provider_total_tokens IS NULL
    OR (provider_total_tokens >= provider_input_tokens AND provider_total_tokens >= provider_output_tokens
      AND billed_output_tokens >= provider_output_tokens AND billed_output_tokens <= reserved_output_tokens
      AND provider_output_tokens <= reserved_output_tokens)
  ),
  CHECK(
    (lifecycle = 'reserved' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
      AND started_at IS NULL AND settled_at IS NULL AND settlement_key IS NULL AND settlement_digest IS NULL
      AND interruption_reason IS NULL AND settled_workspace_revision IS NULL
      AND settled_execution_cas_revision IS NULL AND boundary_class IS NULL AND provider_input_tokens IS NULL)
    OR (lifecycle = 'in_flight' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
      AND started_at IS NOT NULL AND settled_at IS NULL AND settlement_key IS NULL AND settlement_digest IS NULL
      AND interruption_reason IS NULL AND settled_workspace_revision IS NULL
      AND settled_execution_cas_revision IS NULL AND boundary_class IS NULL AND provider_input_tokens IS NULL)
    OR (lifecycle = 'settled' AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND started_at IS NOT NULL AND settled_at IS NOT NULL AND settlement_key IS NOT NULL AND settlement_digest IS NOT NULL
      AND interruption_reason IS NULL AND settled_workspace_revision IS NOT NULL
      AND settled_execution_cas_revision IS NOT NULL AND boundary_class IS NOT NULL AND provider_input_tokens IS NOT NULL)
    OR (lifecycle = 'interrupted' AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND started_at IS NOT NULL AND settled_at IS NOT NULL AND settlement_key IS NULL AND settlement_digest IS NOT NULL
      AND interruption_reason IS NOT NULL AND settled_workspace_revision IS NOT NULL
      AND settled_execution_cas_revision IS NOT NULL AND boundary_class IS NOT NULL AND provider_input_tokens IS NOT NULL)
  ),
  FOREIGN KEY (user_id, execution_id, attempt_id, workspace_id)
    REFERENCES agent_work_segment_recovery(user_id, execution_id, attempt_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, execution_id, segment_id, attempt_id, workspace_id)
    REFERENCES agent_work_segments(user_id, execution_id, segment_id, attempt_id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_work_segments_execution
  ON agent_work_segments(user_id, execution_id, segment_ordinal);
CREATE INDEX IF NOT EXISTS idx_agent_work_segment_transitions_execution
  ON agent_work_segment_transitions(user_id, execution_id, created_at, transition_id);
CREATE INDEX IF NOT EXISTS idx_agent_work_segment_dispatches_segment
  ON agent_work_segment_dispatches(user_id, execution_id, segment_id, dispatch_ordinal);
CREATE INDEX IF NOT EXISTS idx_agent_work_segment_dispatches_lease
  ON agent_work_segment_dispatches(lifecycle, lease_expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_work_segments_one_active
  ON agent_work_segments(user_id, execution_id)
  WHERE lifecycle IN ('admitted', 'running');

CREATE TABLE IF NOT EXISTS agent_work_workspace_receipts (
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 256),
  execution_id TEXT NOT NULL CHECK(length(execution_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  segment_id TEXT NOT NULL CHECK(length(segment_id) BETWEEN 1 AND 256),
  logical_dispatch INTEGER NOT NULL CHECK(logical_dispatch BETWEEN 0 AND 2147483648),
  frame_id TEXT NOT NULL CHECK(length(frame_id) BETWEEN 1 AND 256),
  operation_key TEXT NOT NULL CHECK(length(operation_key) BETWEEN 1 AND 256),
  operation_digest TEXT NOT NULL CHECK(length(operation_digest) = 64 AND operation_digest NOT GLOB '*[^0-9a-f]*'),
  before_workspace_revision INTEGER NOT NULL CHECK(before_workspace_revision BETWEEN 0 AND 9007199254740991),
  after_workspace_revision INTEGER NOT NULL CHECK(after_workspace_revision = before_workspace_revision + 1),
  settled_at INTEGER NOT NULL CHECK(settled_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (user_id, execution_id, operation_key),
  UNIQUE (user_id, execution_id, before_workspace_revision),
  UNIQUE (user_id, execution_id, after_workspace_revision),
  FOREIGN KEY (user_id, execution_id, workspace_id)
    REFERENCES agent_turn_workspaces(user_id, execution_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, execution_id, segment_id, logical_dispatch)
    REFERENCES agent_work_segment_dispatches(user_id, execution_id, segment_id, dispatch_ordinal) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_work_workspace_receipts_dispatch
  ON agent_work_workspace_receipts(user_id, execution_id, segment_id, logical_dispatch, settled_at, operation_key);
