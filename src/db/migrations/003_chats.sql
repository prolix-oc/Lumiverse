CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_chats_character_id ON chats(character_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  index_in_chat INTEGER NOT NULL,
  is_user INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  send_date INTEGER NOT NULL DEFAULT (unixepoch()),
  swipe_id INTEGER NOT NULL DEFAULT 0,
  swipes TEXT NOT NULL DEFAULT '[]',
  extra TEXT NOT NULL DEFAULT '{}',
  parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  branch_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat_index ON messages(chat_id, index_in_chat);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_message_id);
