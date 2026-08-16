-- Edit-and-send: message OCC revision, durable request log, generation outbox.
-- Post-baseline. The runner records this filename in _migrations so it runs once.

ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS edit_and_send_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  branch_chat_id TEXT NOT NULL,
  edited_message_id TEXT NOT NULL,
  target_message_id TEXT,
  target_swipe_index INTEGER,
  generation_id TEXT NOT NULL,
  response TEXT NOT NULL,
  cursor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, chat_id, request_id)
);

CREATE TABLE IF NOT EXISTS generation_outbox (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  branch_chat_id TEXT NOT NULL,
  edited_message_id TEXT NOT NULL,
  target_message_id TEXT,
  target_swipe_index INTEGER,
  expected_version INTEGER NOT NULL,
  generation_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('normal', 'swipe')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  terminal_reason TEXT,
  dispatched_at INTEGER,
  completed_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_generation_outbox_status_next
  ON generation_outbox(status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_generation_outbox_request
  ON generation_outbox(user_id, chat_id, request_id);
