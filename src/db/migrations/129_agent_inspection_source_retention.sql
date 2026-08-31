CREATE TABLE IF NOT EXISTS agent_run_source_deletions (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  previous_attempt_id TEXT CHECK(previous_attempt_id IS NULL OR length(previous_attempt_id) BETWEEN 1 AND 256),
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('chat', 'message', 'swipe')),
  target_message_id TEXT CHECK(target_message_id IS NULL OR length(target_message_id) BETWEEN 1 AND 256),
  target_swipe_id INTEGER CHECK(target_swipe_id IS NULL OR target_swipe_id >= 0),
  run_id TEXT CHECK(run_id IS NULL OR length(run_id) BETWEEN 1 AND 256),
  turn_id TEXT CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 256),
  generation_id TEXT CHECK(generation_id IS NULL OR length(generation_id) BETWEEN 1 AND 256),
  generation_type TEXT CHECK(generation_type IS NULL OR generation_type IN ('normal', 'continue', 'regenerate', 'swipe')),
  lifecycle TEXT CHECK(lifecycle IS NULL OR lifecycle IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT CHECK(status IS NULL OR status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'stopped', 'failed', 'exhausted', 'rejected')),
  terminal INTEGER CHECK(terminal IS NULL OR terminal IN (0, 1)),
  attempt_reason TEXT CHECK(attempt_reason IS NULL OR length(attempt_reason) <= 128),
  started_at INTEGER CHECK(started_at IS NULL OR started_at >= 0),
  updated_at INTEGER CHECK(updated_at IS NULL OR updated_at >= 0),
  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= 0),
  host_correlation_id TEXT CHECK(host_correlation_id IS NULL OR length(host_correlation_id) BETWEEN 1 AND 256),
  reconciliation_state TEXT CHECK(reconciliation_state IS NULL OR reconciliation_state IN ('authoritative', 'reconciling', 'recovered', 'stale')),
  attempt_version INTEGER CHECK(attempt_version IS NULL OR attempt_version >= 1),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  source_deleted_at INTEGER NOT NULL CHECK(source_deleted_at >= 0),
  reason TEXT NOT NULL DEFAULT 'source_deleted' CHECK(reason = 'source_deleted'),
  activity_json TEXT NOT NULL DEFAULT '[]' CHECK(length(activity_json) <= 65536 AND json_valid(activity_json)),
  usage_json TEXT NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0,"totalTokens":0,"toolCalls":0,"childInvocations":0}' CHECK(length(usage_json) <= 4096 AND json_valid(usage_json)),
  PRIMARY KEY(user_id, attempt_id),
  CHECK(target_swipe_id IS NULL OR target_message_id IS NOT NULL),
  CHECK(source_kind = 'chat' OR target_message_id IS NOT NULL),
  CHECK(source_kind <> 'swipe' OR target_swipe_id IS NOT NULL)
);
-- A deleted source owns its attempt ID permanently. Reject late writers even
-- when they arrive without a target message after the source row is gone.
CREATE TRIGGER IF NOT EXISTS trg_agent_run_attempts_reject_source_deleted
BEFORE INSERT ON agent_run_attempts
WHEN EXISTS (
  SELECT 1
    FROM agent_run_source_deletions
   WHERE user_id = NEW.user_id AND attempt_id = NEW.attempt_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent run attempt source was deleted');
END;


CREATE INDEX IF NOT EXISTS idx_agent_run_source_deletions_chat
  ON agent_run_source_deletions(user_id, chat_id, source_kind, target_message_id, target_swipe_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_source_deletions_attempt
  ON agent_run_source_deletions(user_id, attempt_id);
CREATE TABLE IF NOT EXISTS agent_run_source_deletion_workspace (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  association_id TEXT NOT NULL CHECK(length(association_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision >= 0),
  relation TEXT NOT NULL CHECK(relation IN ('linked', 'published', 'omitted')),
  object_kind TEXT NOT NULL CHECK(object_kind IN ('objective', 'task', 'finding', 'decision', 'question', 'submission', 'artifact', 'publication')),
  object_id TEXT CHECK(object_id IS NULL OR length(object_id) BETWEEN 1 AND 256),
  source_revision INTEGER CHECK(source_revision IS NULL OR source_revision >= 0),
  source_deleted INTEGER NOT NULL CHECK(source_deleted IN (0, 1)),
  provenance_digest TEXT CHECK(provenance_digest IS NULL OR length(provenance_digest) = 64),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  PRIMARY KEY(user_id, attempt_id, association_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_source_deletion_workspace_attempt
  ON agent_run_source_deletion_workspace(user_id, attempt_id, host_sequence, association_id);
