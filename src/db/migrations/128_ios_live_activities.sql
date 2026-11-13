CREATE TABLE ios_live_activities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  server_origin TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  activity_id TEXT,
  push_token TEXT,
  token_registered_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  desired_phase TEXT NOT NULL,
  delivered_phase TEXT,
  last_timestamp INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  ended_at INTEGER,
  UNIQUE(user_id, device_id, bundle_id, environment, generation_id)
);
CREATE INDEX idx_ios_live_activities_generation ON ios_live_activities(user_id, generation_id);
CREATE INDEX idx_ios_live_activities_expiry ON ios_live_activities(expires_at);

-- Removing/transferring an alert destination also revokes activities on that installation.
CREATE TRIGGER revoke_ios_destination_activities AFTER DELETE ON ios_push_destinations BEGIN
  DELETE FROM ios_live_activities WHERE user_id = OLD.user_id AND device_id = OLD.device_id
    AND bundle_id = OLD.bundle_id AND environment = OLD.environment;
END;
