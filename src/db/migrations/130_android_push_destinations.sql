CREATE TABLE IF NOT EXISTS android_push_destinations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL CHECK (transport IN ('local', 'fcm')),
  device_token TEXT,
  project_id TEXT,
  server_origin TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT 'Lumiverse Android',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  registered_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_android_push_user ON android_push_destinations(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_android_push_token ON android_push_destinations(device_token) WHERE device_token IS NOT NULL;
