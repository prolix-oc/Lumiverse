
CREATE TABLE IF NOT EXISTS agent_run_attempts (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  previous_attempt_id TEXT,
  run_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  generation_type TEXT NOT NULL CHECK(generation_type IN ('normal', 'continue', 'regenerate', 'swipe')),
  target_message_id TEXT,
  target_swipe_id INTEGER CHECK(target_swipe_id IS NULL OR target_swipe_id >= 0),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'stopped', 'failed', 'exhausted', 'rejected')),
  reason TEXT NOT NULL DEFAULT 'none' CHECK(length(reason) <= 128),
  terminal INTEGER NOT NULL DEFAULT 0 CHECK(terminal IN (0, 1)),
  started_at INTEGER NOT NULL CHECK(started_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= 0),
  host_correlation_id TEXT NOT NULL CHECK(length(host_correlation_id) BETWEEN 1 AND 256),
  reconciliation_state TEXT NOT NULL DEFAULT 'authoritative' CHECK(reconciliation_state IN ('authoritative', 'reconciling', 'recovered', 'stale')),
  terminal_receipt_json TEXT CHECK(terminal_receipt_json IS NULL OR length(terminal_receipt_json) <= 16384),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version = 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(user_id, attempt_id),
  UNIQUE(user_id, run_id),
  UNIQUE(user_id, host_correlation_id),
  FOREIGN KEY (user_id, previous_attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE SET NULL,
  FOREIGN KEY (target_message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_chat_updated
  ON agent_run_attempts(user_id, chat_id, updated_at DESC, attempt_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_chat_target
  ON agent_run_attempts(user_id, chat_id, target_message_id, target_swipe_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_previous
  ON agent_run_attempts(user_id, previous_attempt_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_terminal
  ON agent_run_attempts(user_id, chat_id, terminal, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_audit_records (
  record_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('transcript', 'turn_session', 'activity', 'marker', 'usage', 'prompt', 'cortex', 'council', 'workspace', 'stop', 'recovery')),
  event_id TEXT,
  causal_parent_id TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
  late INTEGER NOT NULL DEFAULT 0 CHECK(late IN (0, 1)),
  payload_json TEXT NOT NULL CHECK(length(payload_json) <= 131072),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0 AND byte_size <= 131072),
  dedupe_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_audit_attempt_sequence
  ON agent_run_audit_records(user_id, attempt_id, host_sequence, record_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_audit_chat_time
  ON agent_run_audit_records(user_id, chat_id, occurred_at, record_id);

CREATE TABLE IF NOT EXISTS agent_run_turn_session_entries (
  entry_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  entry_kind TEXT NOT NULL CHECK(entry_kind IN ('target', 'input', 'policy', 'condition', 'hook', 'cancellation', 'completion', 'commit', 'terminal', 'retry', 'recovery')),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
  detail_json TEXT NOT NULL CHECK(length(detail_json) <= 65536),
  transcript_links_json TEXT NOT NULL DEFAULT '[]' CHECK(length(transcript_links_json) <= 8192),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, host_sequence, entry_kind)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_turn_session_entries_order
  ON agent_run_turn_session_entries(user_id, attempt_id, host_sequence, entry_id);

CREATE TABLE IF NOT EXISTS agent_run_activity_nodes (
  node_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  parent_node_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('root', 'provider', 'child', 'tool', 'milestone')),
  actor TEXT NOT NULL CHECK(actor IN ('host', 'owner', 'provider', 'agent', 'child', 'tool')),
  phase TEXT NOT NULL CHECK(phase IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal', 'omitted')),
  safe_label TEXT NOT NULL CHECK(length(safe_label) BETWEEN 1 AND 256),
  tool_id TEXT,
  task_id TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  started_at INTEGER NOT NULL CHECK(started_at >= 0),
  ended_at INTEGER CHECK(ended_at IS NULL OR ended_at >= started_at),
  elapsed_ms INTEGER CHECK(elapsed_ms IS NULL OR elapsed_ms >= 0),
  usage_json TEXT CHECK(usage_json IS NULL OR length(usage_json) <= 8192),
  detail_json TEXT CHECK(detail_json IS NULL OR length(detail_json) <= 16384),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_activity_nodes_order
  ON agent_run_activity_nodes(user_id, attempt_id, host_sequence, node_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_activity_nodes_target
  ON agent_run_activity_nodes(user_id, chat_id, attempt_id, kind, host_sequence);

CREATE TABLE IF NOT EXISTS agent_run_inspection_markers (
  marker_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  marker_kind TEXT NOT NULL CHECK(marker_kind IN ('reconnect_gap', 'late_event', 'reordered_event', 'truncated', 'unavailable', 'credentials_withheld', 'other_user_data_withheld', 'recovered_duplicate')),
  scope TEXT NOT NULL CHECK(scope IN ('run', 'activity', 'transcript', 'turn_session', 'usage', 'prompt', 'cortex', 'council', 'workspace')),
  host_sequence INTEGER,
  first_sequence INTEGER,
  last_sequence INTEGER,
  recoverable INTEGER CHECK(recoverable IS NULL OR recoverable IN (0, 1)),
  detail TEXT CHECK(detail IS NULL OR length(detail) <= 2048),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, marker_kind, scope, host_sequence)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_inspection_markers_order
  ON agent_run_inspection_markers(user_id, attempt_id, COALESCE(host_sequence, 0), marker_id);

CREATE TABLE IF NOT EXISTS agent_run_usage_evidence (
  usage_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('provider_reported', 'provisional', 'final', 'recovered_duplicate')),
  actor_id TEXT,
  phase TEXT,
  tool_id TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(total_tokens >= 0),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls >= 0),
  child_invocations INTEGER NOT NULL DEFAULT 0 CHECK(child_invocations >= 0),
  canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, usage_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_usage_attempt
  ON agent_run_usage_evidence(user_id, attempt_id, host_sequence, usage_id);

CREATE TABLE IF NOT EXISTS agent_run_prompt_evidence (
  prompt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 256),
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  destination TEXT NOT NULL CHECK(destination IN ('root_work', 'child_work', 'completion_handoff', 'render', 'council', 'cortex')),
  role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool', 'context', 'policy')),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  included INTEGER NOT NULL CHECK(included IN (0, 1)),
  content TEXT NOT NULL CHECK(length(content) <= 65536),
  content_digest TEXT NOT NULL CHECK(length(content_digest) = 64),
  omission_reason TEXT CHECK(omission_reason IS NULL OR length(omission_reason) <= 512),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, prompt_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_prompt_attempt
  ON agent_run_prompt_evidence(user_id, attempt_id, host_sequence, prompt_id);

CREATE TABLE IF NOT EXISTS agent_run_cortex_receipts (
  receipt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 256),
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  state TEXT NOT NULL CHECK(state IN ('accepted', 'omitted', 'failed', 'cancelled')),
  result_digest TEXT,
  result_count INTEGER NOT NULL DEFAULT 0 CHECK(result_count >= 0),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  reason TEXT CHECK(reason IS NULL OR length(reason) <= 512),
  canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical = 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, receipt_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_cortex_attempt
  ON agent_run_cortex_receipts(user_id, attempt_id, host_sequence, receipt_id);

CREATE TABLE IF NOT EXISTS agent_run_council_receipts (
  receipt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('accepted', 'omitted', 'failed', 'cancelled')),
  member_count INTEGER NOT NULL DEFAULT 0 CHECK(member_count >= 0),
  result_digest TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  reason TEXT CHECK(reason IS NULL OR length(reason) <= 512),
  canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical = 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, receipt_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_council_attempt
  ON agent_run_council_receipts(user_id, attempt_id, host_sequence, receipt_id);

CREATE TABLE IF NOT EXISTS agent_run_workspace_associations (
  association_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision >= 0),
  relation TEXT NOT NULL CHECK(relation IN ('linked', 'published', 'omitted')),
  object_kind TEXT NOT NULL CHECK(object_kind IN ('objective', 'task', 'finding', 'decision', 'question', 'submission', 'artifact', 'publication')),
  object_id TEXT,
  source_revision INTEGER,
  source_deleted INTEGER NOT NULL DEFAULT 0 CHECK(source_deleted IN (0, 1)),
  provenance_digest TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, association_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_workspace_associations_attempt
  ON agent_run_workspace_associations(user_id, attempt_id, host_sequence, association_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_workspace_associations_workspace
  ON agent_run_workspace_associations(user_id, workspace_id, workspace_revision);
-- Existing executions already carry the canonical attempt target and lifecycle.
-- Seed inspection attempts without inventing retry lineage or pending work.
INSERT OR IGNORE INTO agent_run_attempts (
  user_id, chat_id, attempt_id, previous_attempt_id, run_id, turn_id,
  generation_id, generation_type, target_message_id, target_swipe_id,
  lifecycle, status, outcome, reason, terminal, started_at, updated_at,
  terminal_at, host_correlation_id, reconciliation_state, terminal_receipt_json,
  created_at
)
SELECT
  execution.user_id,
  execution.chat_id,
  execution.id,
  NULL,
  execution.id,
  execution.id,
  execution.generation_id,
  execution.target_kind,
  execution.target_message_id,
  execution.target_swipe_id,
  CASE execution.state
    WHEN 'ASSEMBLE' THEN 'ASSEMBLE'
    WHEN 'WORK' THEN 'WORK'
    WHEN 'COMPLETE' THEN 'PREPARE_COMMIT'
    WHEN 'RENDER' THEN 'RENDER'
    WHEN 'PREPARE_COMMIT' THEN 'COMMIT'
    WHEN 'COMMITTING' THEN 'COMMIT'
    ELSE 'TERMINAL'
  END,
  CASE
    WHEN execution.state IN ('COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
      THEN 'terminal'
    WHEN execution.cancel_requested_at IS NOT NULL THEN 'cancelling'
    WHEN execution.state IN ('COMPLETE', 'PREPARE_COMMIT') THEN 'waiting'
    ELSE 'running'
  END,
  CASE
    WHEN execution.state = 'COMMITTED' THEN 'completed'
    WHEN execution.state = 'CANCELLED' THEN 'stopped'
    WHEN execution.state = 'TIMED_OUT' THEN 'failed'
    WHEN execution.state = 'EXHAUSTED' THEN 'exhausted'
    WHEN execution.state IN ('COMMIT_FAILED', 'FAILED')
      AND lower(COALESCE(execution.terminal_code, '')) IN ('cancelled', 'canceled', 'stopped', 'user_stop', 'accepted_cancellation', 'agentic_cancelled')
      THEN 'stopped'
    WHEN execution.state IN ('COMMIT_FAILED', 'FAILED')
      AND lower(COALESCE(execution.terminal_code, '')) <> 'root_wall_clock_limit_exceeded'
      AND (
        lower(COALESCE(execution.terminal_code, '')) IN ('exhausted', 'budget_exhausted', 'budget_exceeded', 'limit_exceeded', 'agentic_work_exhausted')
        OR lower(COALESCE(execution.terminal_code, '')) LIKE '%_limit_exceeded'
        OR lower(COALESCE(execution.terminal_code, '')) LIKE '%_budget_exhausted'
        OR lower(COALESCE(execution.terminal_code, '')) LIKE '%_budget_exceeded'
      ) THEN 'exhausted'
    WHEN execution.state IN ('COMMIT_FAILED', 'FAILED') THEN 'failed'
    ELSE NULL
  END,
  CASE
    WHEN execution.state IN ('COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
      AND length(COALESCE(execution.terminal_code, '')) BETWEEN 1 AND 128 THEN execution.terminal_code
    WHEN execution.state = 'TIMED_OUT' THEN 'timed_out'
    WHEN execution.state = 'CANCELLED' THEN 'cancelled'
    WHEN execution.state = 'EXHAUSTED' THEN 'exhausted'
    WHEN execution.state = 'FAILED' THEN 'failed'
    WHEN execution.state = 'COMMIT_FAILED' THEN 'commit_failed'
    ELSE 'none'
  END,
  CASE
    WHEN execution.state IN ('COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
      THEN 1
    ELSE 0
  END,
  execution.created_at,
  execution.updated_at,
  execution.terminal_at,
  'migration:116:' || execution.id,
  'recovered',
  NULL,
  execution.created_at
FROM agent_turn_executions AS execution;
