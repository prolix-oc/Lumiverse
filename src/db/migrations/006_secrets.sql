CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  encrypted_value TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
