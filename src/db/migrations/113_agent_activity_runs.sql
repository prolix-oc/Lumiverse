CREATE TABLE IF NOT EXISTS agent_activity_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  target_message_id TEXT,
  target_swipe_id INTEGER,
  snapshot_json TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0 AND byte_size <= 32768),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, chat_id, generation_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_activity_runs_chat
  ON agent_activity_runs(user_id, chat_id, created_at DESC, id DESC);
