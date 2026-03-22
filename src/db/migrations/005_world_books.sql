CREATE TABLE IF NOT EXISTS world_books (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS world_book_entries (
  id TEXT PRIMARY KEY,
  world_book_id TEXT NOT NULL REFERENCES world_books(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '[]',
  keysecondary TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 4,
  role TEXT,
  order_value INTEGER NOT NULL DEFAULT 100,
  selective INTEGER NOT NULL DEFAULT 0,
  constant INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  group_name TEXT NOT NULL DEFAULT '',
  group_override INTEGER NOT NULL DEFAULT 0,
  group_weight INTEGER NOT NULL DEFAULT 100,
  probability INTEGER NOT NULL DEFAULT 100,
  scan_depth INTEGER,
  case_sensitive INTEGER NOT NULL DEFAULT 0,
  match_whole_words INTEGER NOT NULL DEFAULT 0,
  automation_id TEXT,
  extensions TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_wbe_world_book_id ON world_book_entries(world_book_id);
