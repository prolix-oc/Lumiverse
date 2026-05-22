CREATE TABLE IF NOT EXISTS stt_connections (
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

CREATE INDEX IF NOT EXISTS idx_sttc_user ON stt_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_sttc_default ON stt_connections(user_id, is_default);
