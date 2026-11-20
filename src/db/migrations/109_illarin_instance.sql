-- Illarin linked-instance credentials: one row per user installation.
-- Access and refresh tokens are AES-GCM encrypted at rest. This table is
-- excluded from export/import via EXCLUDED_TABLES in
-- src/services/user-data/table-registry.ts — credentials never leave the box.
CREATE TABLE IF NOT EXISTS illarin_instance (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  illarin_url TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  instance_name TEXT NOT NULL,
  application_name TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  access_token_encrypted TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  access_token_tag TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  refresh_token_tag TEXT NOT NULL,
  last_declaration_json TEXT,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_refresh_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_illarin_instance_user_id
ON illarin_instance(user_id);
