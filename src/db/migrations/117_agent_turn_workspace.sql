-- Dormant single-turn execution/workspace persistence.
-- Runtime phase execution is intentionally not wired by this migration. Rows are
-- host-owned operational state until a commit receipt publishes an artifact ref.

ALTER TABLE chats
  ADD COLUMN generation_revision INTEGER NOT NULL DEFAULT 0
  CHECK (generation_revision >= 0);

ALTER TABLE messages
  ADD COLUMN generation_revision INTEGER NOT NULL DEFAULT 0
  CHECK (generation_revision >= 0);

CREATE INDEX IF NOT EXISTS idx_chats_generation_revision
  ON chats(id, generation_revision);
CREATE INDEX IF NOT EXISTS idx_messages_generation_revision
  ON messages(chat_id, id, generation_revision);

-- These redundant unique indexes make the ownership edges below enforceable as
-- composite foreign keys, rather than relying on callers to match user_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_user_id_id
  ON chats(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_id_id
  ON messages(chat_id, id);

CREATE TABLE IF NOT EXISTS agent_turn_executions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  branch_id TEXT,
  generation_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('normal', 'continue', 'regenerate', 'swipe')),
  target_message_id TEXT,
  target_swipe_id INTEGER CHECK(target_swipe_id IS NULL OR target_swipe_id >= 0),
  target_message_index INTEGER CHECK(target_message_index IS NULL OR target_message_index >= 0),
  target_swipe_count INTEGER CHECK(target_swipe_count IS NULL OR target_swipe_count >= 1),
  target_chat_revision INTEGER NOT NULL CHECK(target_chat_revision >= 0),
  target_message_revision INTEGER CHECK(target_message_revision IS NULL OR target_message_revision >= 0),
  preset_snapshot_id TEXT,
  config_snapshot_id TEXT,
  config_revision INTEGER NOT NULL DEFAULT 0 CHECK(config_revision >= 0),
  concrete_connection_snapshot_id TEXT,
  concrete_connection_revision INTEGER NOT NULL DEFAULT 0 CHECK(concrete_connection_revision >= 0),
  world_lore_snapshot_id TEXT,
  world_lore_revision INTEGER NOT NULL DEFAULT 0 CHECK(world_lore_revision >= 0),
  mode TEXT NOT NULL CHECK(mode IN ('response', 'agentic')),
  runtime_epoch INTEGER NOT NULL CHECK(runtime_epoch >= 0),
  deadline_at INTEGER NOT NULL CHECK(deadline_at >= 0),
  cancel_requested_at INTEGER,
  state TEXT NOT NULL CHECK(state IN (
    'ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT',
    'COMMITTING', 'COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED',
    'CANCELLED', 'TIMED_OUT'
  )),
  phase_revision INTEGER NOT NULL DEFAULT 0 CHECK(phase_revision >= 0),
  cas_revision INTEGER NOT NULL DEFAULT 0 CHECK(cas_revision >= 0),
  cas_owner TEXT,
  cas_expires_at INTEGER,
  root_ledger_json TEXT NOT NULL CHECK(length(root_ledger_json) <= 131072),
  frame_capabilities_json TEXT NOT NULL CHECK(length(frame_capabilities_json) <= 65536),
  workspace_id TEXT UNIQUE,
  workspace_revision INTEGER NOT NULL DEFAULT 0 CHECK(workspace_revision >= 0),
  commit_key TEXT NOT NULL UNIQUE CHECK(length(commit_key) BETWEEN 1 AND 256),
  final_render_reservations_json TEXT NOT NULL DEFAULT '[]' CHECK(length(final_render_reservations_json) <= 65536),
  final_render_request_count INTEGER NOT NULL DEFAULT 1 CHECK(final_render_request_count = 1),
  final_render_context_bytes INTEGER NOT NULL DEFAULT 0 CHECK(final_render_context_bytes >= 0 AND final_render_context_bytes <= 2147483648),
  final_render_output_bytes INTEGER NOT NULL DEFAULT 0 CHECK(final_render_output_bytes >= 0 AND final_render_output_bytes <= 2147483648),
  final_render_activity_events INTEGER NOT NULL DEFAULT 0 CHECK(final_render_activity_events >= 0 AND final_render_activity_events <= 100000),
  final_render_deadline_at INTEGER NOT NULL DEFAULT 0 CHECK(final_render_deadline_at >= 0),
  terminal_code TEXT CHECK(terminal_code IS NULL OR length(terminal_code) <= 128),
  retention TEXT NOT NULL DEFAULT 'operational' CHECK(retention IN ('operational', 'turn_terminal')),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  terminal_at INTEGER,
  ledger_request_quota INTEGER NOT NULL DEFAULT 1 CHECK(ledger_request_quota >= 0 AND ledger_request_quota <= 100000),
  ledger_output_byte_quota INTEGER NOT NULL DEFAULT 0 CHECK(ledger_output_byte_quota >= 0 AND ledger_output_byte_quota <= 2147483648),
  workspace_byte_quota INTEGER NOT NULL DEFAULT 0 CHECK(workspace_byte_quota >= 0 AND workspace_byte_quota <= 2147483648),
  workspace_item_quota INTEGER NOT NULL DEFAULT 0 CHECK(workspace_item_quota >= 0 AND workspace_item_quota <= 1000000),
  UNIQUE(user_id, id),
  UNIQUE(user_id, chat_id, generation_id),
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, target_message_id) REFERENCES messages(chat_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_turn_executions_active
  ON agent_turn_executions(user_id, state, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_turn_executions_chat
  ON agent_turn_executions(user_id, chat_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_turn_workspaces (
  workspace_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  objective TEXT NOT NULL CHECK(length(objective) <= 65536),
  constraints_json TEXT NOT NULL CHECK(length(constraints_json) <= 131072),
  state TEXT NOT NULL CHECK(state IN ('active', 'frozen', 'expired')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  cas_owner TEXT,
  cas_expires_at INTEGER,
  operation_caps_json TEXT NOT NULL CHECK(length(operation_caps_json) <= 65536),
  field_caps_json TEXT NOT NULL CHECK(length(field_caps_json) <= 65536),
  retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  quota_tasks INTEGER NOT NULL CHECK(quota_tasks >= 0 AND quota_tasks <= 100000),
  quota_records INTEGER NOT NULL CHECK(quota_records >= 0 AND quota_records <= 100000),
  quota_submissions INTEGER NOT NULL CHECK(quota_submissions >= 0 AND quota_submissions <= 100000),
  quota_artifacts INTEGER NOT NULL CHECK(quota_artifacts >= 0 AND quota_artifacts <= 100000),
  quota_bytes INTEGER NOT NULL CHECK(quota_bytes >= 0 AND quota_bytes <= 2147483648),
  task_count INTEGER NOT NULL DEFAULT 0 CHECK(task_count >= 0 AND task_count <= quota_tasks),
  record_count INTEGER NOT NULL DEFAULT 0 CHECK(record_count >= 0 AND record_count <= quota_records),
  submission_count INTEGER NOT NULL DEFAULT 0 CHECK(submission_count >= 0 AND submission_count <= quota_submissions),
  artifact_count INTEGER NOT NULL DEFAULT 0 CHECK(artifact_count >= 0 AND artifact_count <= quota_artifacts),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count >= 0 AND byte_count <= quota_bytes),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  frozen_at INTEGER,
  UNIQUE(user_id, workspace_id),
  UNIQUE(user_id, turn_id),
  UNIQUE(user_id, execution_id),
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (execution_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, execution_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_turn_workspaces_expiry
  ON agent_turn_workspaces(user_id, state, expires_at);

CREATE TABLE IF NOT EXISTS agent_workspace_tasks (
  task_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 4096),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 65536),
  state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'blocked', 'completed', 'cancelled', 'failed')),
  required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0, 1)),
  dependencies_json TEXT NOT NULL DEFAULT '[]' CHECK(length(dependencies_json) <= 65536),
  assigned_frame_id TEXT,
  progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
  summary TEXT CHECK(summary IS NULL OR length(summary) <= 65536),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count >= 0 AND byte_count <= 131072),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  cas_owner TEXT,
  cas_expires_at INTEGER,
  retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, task_id),
  FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_workspace_tasks_state
  ON agent_workspace_tasks(user_id, workspace_id, state, updated_at);

CREATE TABLE IF NOT EXISTS agent_workspace_records (
  record_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('finding', 'decision', 'question')),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 65536),
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest GLOB '[0-9a-fA-F]*'),
  task_id TEXT,
  source_frame_id TEXT,
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 131072),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, record_id),
  UNIQUE(workspace_id, kind, digest),
  FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, task_id) REFERENCES agent_workspace_tasks(user_id, task_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_workspace_records_kind
  ON agent_workspace_records(user_id, workspace_id, kind, created_at);

CREATE TABLE IF NOT EXISTS agent_workspace_submissions (
  submission_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  child_frame_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('submitted', 'accepted', 'rejected')),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 65536),
  result_digest TEXT NOT NULL CHECK(length(result_digest) = 64 AND result_digest GLOB '[0-9a-fA-F]*'),
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 131072),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, submission_id),
  UNIQUE(task_id, child_frame_id),
  FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, task_id) REFERENCES agent_workspace_tasks(user_id, task_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_workspace_submissions_state
  ON agent_workspace_submissions(user_id, workspace_id, state, updated_at);

CREATE TABLE IF NOT EXISTS agent_artifact_blobs (
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest GLOB '[0-9a-fA-F]*'),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 2147483648),
  mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 255),
  storage_path TEXT NOT NULL CHECK(length(storage_path) BETWEEN 1 AND 4096),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK(length(provenance_json) <= 65536),
  published_reference_count INTEGER NOT NULL DEFAULT 0 CHECK(published_reference_count >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  retention TEXT NOT NULL DEFAULT 'operational' CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, digest)
);

CREATE INDEX IF NOT EXISTS idx_agent_artifact_blobs_expiry
  ON agent_artifact_blobs(user_id, retention, expires_at);

CREATE TABLE IF NOT EXISTS agent_artifact_blob_journal (
  journal_id TEXT PRIMARY KEY,
  blob_digest TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  creator_token TEXT NOT NULL CHECK(length(creator_token) BETWEEN 1 AND 256),
  fence_generation INTEGER NOT NULL CHECK(fence_generation >= 0),
  staged_path TEXT NOT NULL CHECK(length(staged_path) BETWEEN 1 AND 4096),
  final_path TEXT NOT NULL CHECK(length(final_path) BETWEEN 1 AND 4096),
  state TEXT NOT NULL CHECK(state IN ('pending', 'installed', 'removed')),
  observed_identity TEXT CHECK(observed_identity IS NULL OR length(observed_identity) <= 4096),
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 2147483648),
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest GLOB '[0-9a-fA-F]*'),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, turn_id, blob_digest),
  UNIQUE(creator_token),
  FOREIGN KEY (user_id, blob_digest) REFERENCES agent_artifact_blobs(user_id, digest) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_artifact_blob_journal_state
  ON agent_artifact_blob_journal(user_id, state, updated_at);

CREATE TABLE IF NOT EXISTS agent_workspace_artifacts (
  artifact_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  blob_digest TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 255),
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 2147483648),
  provenance_json TEXT NOT NULL CHECK(length(provenance_json) <= 65536),
  source_frame_id TEXT,
  source_task_id TEXT,
  publication_state TEXT NOT NULL CHECK(publication_state IN ('attached', 'proposed', 'published')),
  retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, artifact_id),
  UNIQUE(workspace_id, blob_digest),
  FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, source_task_id) REFERENCES agent_workspace_tasks(user_id, task_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_workspace_artifacts_publication
  ON agent_workspace_artifacts(user_id, workspace_id, publication_state, updated_at);

CREATE TABLE IF NOT EXISTS agent_turn_commit_receipts (
  receipt_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  commit_key TEXT NOT NULL CHECK(length(commit_key) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  state TEXT NOT NULL DEFAULT 'committed' CHECK(state IN ('committed')),
  summary_digest TEXT NOT NULL CHECK(length(summary_digest) = 64 AND summary_digest GLOB '[0-9a-fA-F]*'),
  summary_json TEXT NOT NULL CHECK(length(summary_json) <= 131072),
  message_id TEXT,
  swipe_id INTEGER CHECK(swipe_id IS NULL OR swipe_id >= 0),
  artifact_ref_count INTEGER NOT NULL DEFAULT 0 CHECK(artifact_ref_count >= 0),
  committed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(turn_id),
  UNIQUE(execution_id),
  UNIQUE(user_id, commit_key),
  UNIQUE(user_id, idempotency_key),
  FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (execution_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, message_id) REFERENCES messages(chat_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_turn_commit_receipts_user_time
  ON agent_turn_commit_receipts(user_id, committed_at DESC);

CREATE TABLE IF NOT EXISTS agent_published_workspace_artifacts (
  published_artifact_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL,
  blob_digest TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id TEXT,
  swipe_id INTEGER CHECK(swipe_id IS NULL OR swipe_id >= 0),
  storage_path TEXT NOT NULL CHECK(length(storage_path) BETWEEN 1 AND 4096),
  mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 255),
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 2147483648),
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest GLOB '[0-9a-fA-F]*'),
  retention TEXT NOT NULL DEFAULT 'chat_lifetime' CHECK(retention = 'chat_lifetime'),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, published_artifact_id),
  UNIQUE(user_id, chat_id, message_id, swipe_id, blob_digest),
  -- receipt/source/blob IDs are provenance only. Their operational rows are
  -- intentionally absent from account archives, so publication is self-contained
  -- and can be restored without recreating an operational turn.
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, message_id) REFERENCES messages(chat_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_published_workspace_artifacts_chat
  ON agent_published_workspace_artifacts(user_id, chat_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_agent_published_workspace_artifacts_refcount_delete
AFTER DELETE ON agent_published_workspace_artifacts
BEGIN
  UPDATE agent_artifact_blobs
  SET published_reference_count = MAX(0, published_reference_count - 1),
      updated_at = unixepoch()
  WHERE user_id = OLD.user_id
    AND digest = OLD.blob_digest;
END;
