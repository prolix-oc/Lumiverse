CREATE TABLE IF NOT EXISTS ios_push_destinations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_token TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  server_origin TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'Lumiverse iOS',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  registered_at INTEGER NOT NULL,
  UNIQUE (device_token, bundle_id, environment),
  UNIQUE (user_id, device_id, bundle_id, environment)
);
CREATE INDEX IF NOT EXISTS idx_ios_push_user ON ios_push_destinations(user_id);
