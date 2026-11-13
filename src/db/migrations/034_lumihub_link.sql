CREATE TABLE IF NOT EXISTS lumihub_link (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  lumihub_url TEXT NOT NULL,
  ws_url TEXT NOT NULL,
  instance_name TEXT NOT NULL DEFAULT 'My Lumiverse',
  link_token_encrypted TEXT NOT NULL,
  link_token_iv TEXT NOT NULL,
  link_token_tag TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_connected_at TEXT
);
