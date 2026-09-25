CREATE TABLE IF NOT EXISTS decision_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'jev',
  gateway TEXT NOT NULL,
  protocol TEXT NOT NULL,
  api_url TEXT NOT NULL,
  model TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  has_api_key INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_connections_user ON decision_connections(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_connections_default ON decision_connections(user_id) WHERE is_default = 1;
