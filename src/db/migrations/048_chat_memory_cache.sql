CREATE TABLE IF NOT EXISTS chat_memory_cache (
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

CREATE INDEX IF NOT EXISTS idx_cmc_chat_updated ON chat_memory_cache(chat_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cmc_user_chat ON chat_memory_cache(user_id, chat_id);
