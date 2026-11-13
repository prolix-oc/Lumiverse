CREATE TABLE spindle_live_activities (
  id TEXT PRIMARY KEY,
  extension_id TEXT REFERENCES extensions(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  activity_key TEXT NOT NULL,
  extension_name TEXT NOT NULL,
  content_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE(extension_id, user_id, activity_key)
);
CREATE INDEX idx_spindle_live_activities_user ON spindle_live_activities(user_id, expires_at);
CREATE TABLE spindle_live_activity_clients (
  destination_id TEXT PRIMARY KEY REFERENCES ios_push_destinations(id) ON DELETE CASCADE,
  seen_at INTEGER NOT NULL
);
CREATE TABLE spindle_live_activity_devices (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES spindle_live_activities(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL REFERENCES ios_push_destinations(id) ON DELETE CASCADE,
  credential_hash TEXT NOT NULL,
  native_activity_id TEXT,
  token_epoch TEXT NOT NULL DEFAULT '',
  token_registered_at INTEGER NOT NULL DEFAULT 0,
  push_token TEXT,
  relay_credential TEXT,
  delivered_revision INTEGER NOT NULL DEFAULT 0,
  last_timestamp INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(activity_id, destination_id)
);
