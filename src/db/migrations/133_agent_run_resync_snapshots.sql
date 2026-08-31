-- Short-lived, owner-scoped full-resync snapshots. They freeze the exact
-- public run membership while a bounded cursor walks pages.
CREATE TABLE IF NOT EXISTS agent_run_resync_snapshots (
  snapshot_id TEXT PRIMARY KEY CHECK(length(snapshot_id) BETWEEN 1 AND 256),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  snapshot_sequence INTEGER NOT NULL CHECK(snapshot_sequence >= 0),
  snapshot_at INTEGER NOT NULL CHECK(snapshot_at >= 0),
  total_runs INTEGER NOT NULL CHECK(total_runs >= 0),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_run_resync_snapshots_owner_expiry
  ON agent_run_resync_snapshots(user_id, chat_id, expires_at);

CREATE TABLE IF NOT EXISTS agent_run_resync_snapshot_members (
  snapshot_id TEXT NOT NULL REFERENCES agent_run_resync_snapshots(snapshot_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 256),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  run_json TEXT NOT NULL CHECK(length(run_json) <= 65536 AND json_valid(run_json)),
  PRIMARY KEY (snapshot_id, ordinal),
  UNIQUE (snapshot_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_resync_snapshot_members_key
  ON agent_run_resync_snapshot_members(snapshot_id, updated_at DESC, turn_id DESC);
