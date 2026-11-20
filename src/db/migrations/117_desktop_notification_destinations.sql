CREATE TABLE IF NOT EXISTS desktop_notification_destinations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'Lumiverse Desktop',
  platform TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_desktop_notification_user_device
  ON desktop_notification_destinations(user_id, device_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_desktop_notification_token
  ON desktop_notification_destinations(token_hash);

CREATE INDEX IF NOT EXISTS idx_desktop_notification_user
  ON desktop_notification_destinations(user_id, created_at DESC);
