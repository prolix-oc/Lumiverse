-- Preserve persistent turn-session audit rows when their owner chat is deleted.
-- SQLite cannot alter a column's foreign-key action or nullability in place,
-- so rebuild only this table. The migration runner disables foreign-key
-- enforcement for this file while dependent child tables remain in place.
CREATE TABLE persistent_workspace_turn_sessions_new (
  turn_session_id TEXT PRIMARY KEY CHECK(length(turn_session_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 128),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 128),
  execution_id TEXT CHECK(execution_id IS NULL OR length(execution_id) BETWEEN 1 AND 128),
  phase TEXT NOT NULL DEFAULT 'ADMIT' CHECK(phase IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'stopped', 'failed', 'exhausted', 'rejected')),
  reason TEXT NOT NULL DEFAULT 'none' CHECK(length(reason) <= 128),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  terminal_at INTEGER,
  UNIQUE(user_id, turn_id, attempt_id),
  UNIQUE(workspace_id, turn_id, attempt_id),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

INSERT INTO persistent_workspace_turn_sessions_new (
  turn_session_id, workspace_id, user_id, chat_id, turn_id, attempt_id,
  execution_id, phase, status, outcome, reason, revision, created_at,
  updated_at, terminal_at
)
SELECT
  turn_session_id, workspace_id, user_id, chat_id, turn_id, attempt_id,
  execution_id, phase, status, outcome, reason, revision, created_at,
  updated_at, terminal_at
FROM persistent_workspace_turn_sessions;

DROP TABLE persistent_workspace_turn_sessions;
ALTER TABLE persistent_workspace_turn_sessions_new RENAME TO persistent_workspace_turn_sessions;

CREATE INDEX IF NOT EXISTS idx_persistent_workspace_sessions_turn
  ON persistent_workspace_turn_sessions(user_id, chat_id, turn_id, attempt_id);
