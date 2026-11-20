-- Fix settings table: change PRIMARY KEY from (key) to (key, user_id)
-- so that ON CONFLICT(key, user_id) works correctly for upserts.

CREATE TABLE settings_new (
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  PRIMARY KEY (key, user_id)
);

INSERT INTO settings_new (key, value, updated_at, user_id)
  SELECT key, value, updated_at, user_id FROM settings;

DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

CREATE INDEX IF NOT EXISTS idx_settings_user_id ON settings(user_id);

-- Fix secrets table: change PRIMARY KEY from (key) to (key, user_id)
-- so that ON CONFLICT(key, user_id) works correctly for upserts.

CREATE TABLE secrets_new (
  key TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  PRIMARY KEY (key, user_id)
);

INSERT INTO secrets_new (key, encrypted_value, iv, tag, updated_at, user_id)
  SELECT key, encrypted_value, iv, tag, updated_at, user_id FROM secrets;

DROP TABLE secrets;
ALTER TABLE secrets_new RENAME TO secrets;

CREATE INDEX IF NOT EXISTS idx_secrets_user_id ON secrets(user_id);
