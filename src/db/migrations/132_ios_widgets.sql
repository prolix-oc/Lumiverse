CREATE TABLE ios_widget_registrations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(user_id, device_id)
);
CREATE INDEX idx_ios_widget_registrations_expiry ON ios_widget_registrations(expires_at);
