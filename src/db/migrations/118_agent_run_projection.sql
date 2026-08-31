-- Authenticated, status-only Agentic run projection and per-chat event cursor.
-- All rows are operational projections. They are never restored from .lvbak.

CREATE TABLE IF NOT EXISTS agent_run_projections (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  generation_type TEXT NOT NULL CHECK(generation_type IN ('normal', 'continue', 'regenerate', 'swipe')),
  target_message_id TEXT,
  target_swipe_id INTEGER CHECK(target_swipe_id IS NULL OR target_swipe_id >= 0),
  status TEXT NOT NULL CHECK(status IN (
    'ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT',
    'COMMITTING', 'COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED',
    'CANCELLED', 'TIMED_OUT'
  )),
  phase TEXT NOT NULL CHECK(phase IN (
    'ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT',
    'COMMITTING', 'COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED',
    'CANCELLED', 'TIMED_OUT'
  )),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  started_at INTEGER NOT NULL CHECK(started_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) <= 65536),
  terminal_handoff_json TEXT CHECK(terminal_handoff_json IS NULL OR length(terminal_handoff_json) <= 4096),
  omission_json TEXT NOT NULL DEFAULT '{"omittedNodeCount":0,"omittedEventCount":0,"firstOmittedSequence":null,"lastOmittedSequence":null}'
    CHECK(length(omission_json) <= 4096),
  PRIMARY KEY(user_id, turn_id),
  UNIQUE(user_id, chat_id, turn_id),
  UNIQUE(user_id, chat_id, generation_id),
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, target_message_id) REFERENCES messages(chat_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_run_projections_chat_updated
  ON agent_run_projections(user_id, chat_id, updated_at DESC, turn_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_projections_chat_status
  ON agent_run_projections(user_id, chat_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_chat_event_sequences (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(user_id, chat_id),
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_chat_events (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  turn_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  run_revision INTEGER NOT NULL CHECK(run_revision >= 1),
  status TEXT NOT NULL CHECK(status IN (
    'ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT',
    'COMMITTING', 'COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED',
    'CANCELLED', 'TIMED_OUT'
  )),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('snapshot', 'terminal', 'omission')),
  snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) <= 65536),
  terminal_handoff_json TEXT CHECK(terminal_handoff_json IS NULL OR length(terminal_handoff_json) <= 4096),
  omission_json TEXT NOT NULL DEFAULT '{"omittedNodeCount":0,"omittedEventCount":0,"firstOmittedSequence":null,"lastOmittedSequence":null}'
    CHECK(length(omission_json) <= 4096),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(user_id, chat_id, sequence),
  UNIQUE(user_id, chat_id, turn_id, run_revision),
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_run_projections(user_id, turn_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_chat_events_chat_sequence
  ON agent_chat_events(user_id, chat_id, sequence);
CREATE INDEX IF NOT EXISTS idx_agent_chat_events_turn_revision
  ON agent_chat_events(user_id, chat_id, turn_id, run_revision);
