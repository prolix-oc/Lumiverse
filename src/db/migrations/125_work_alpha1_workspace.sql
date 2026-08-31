CREATE TABLE IF NOT EXISTS persistent_workspaces (
  workspace_id TEXT PRIMARY KEY CHECK(length(workspace_id) BETWEEN 1 AND 128),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  objective TEXT NOT NULL DEFAULT '' CHECK(length(objective) <= 65536),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(length(metadata_json) <= 32768 AND json_valid(metadata_json)),
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK(length(progress_json) <= 16384 AND json_valid(progress_json)),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  quota_tasks INTEGER NOT NULL DEFAULT 256 CHECK(quota_tasks BETWEEN 0 AND 256),
  quota_records INTEGER NOT NULL DEFAULT 1024 CHECK(quota_records BETWEEN 0 AND 1024),
  quota_submissions INTEGER NOT NULL DEFAULT 1024 CHECK(quota_submissions BETWEEN 0 AND 1024),
  quota_artifacts INTEGER NOT NULL DEFAULT 256 CHECK(quota_artifacts BETWEEN 0 AND 256),
  quota_publications INTEGER NOT NULL DEFAULT 512 CHECK(quota_publications BETWEEN 0 AND 512),
  quota_bytes INTEGER NOT NULL DEFAULT 4194304 CHECK(quota_bytes BETWEEN 0 AND 4194304),
  task_count INTEGER NOT NULL DEFAULT 0 CHECK(task_count >= 0),
  record_count INTEGER NOT NULL DEFAULT 0 CHECK(record_count >= 0),
  submission_count INTEGER NOT NULL DEFAULT 0 CHECK(submission_count >= 0),
  artifact_count INTEGER NOT NULL DEFAULT 0 CHECK(artifact_count >= 0),
  publication_count INTEGER NOT NULL DEFAULT 0 CHECK(publication_count >= 0),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, workspace_id),
  UNIQUE(user_id, chat_id)
);

CREATE TABLE IF NOT EXISTS persistent_workspace_turn_sessions (
  turn_session_id TEXT PRIMARY KEY CHECK(length(turn_session_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS persistent_workspace_tasks (
  task_id TEXT PRIMARY KEY CHECK(length(task_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 4096),
  objective TEXT NOT NULL DEFAULT '' CHECK(length(objective) <= 65536),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'active', 'blocked', 'completed', 'cancelled', 'failed')),
  required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0, 1)),
  dependency_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(length(dependency_ids_json) <= 65536 AND json_valid(dependency_ids_json)),
  creator TEXT NOT NULL DEFAULT 'owner' CHECK(creator IN ('host', 'owner')),
  host_admitted INTEGER NOT NULL DEFAULT 0 CHECK(host_admitted IN (0, 1)),
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK(length(progress_json) <= 16384 AND json_valid(progress_json)),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 16384),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count BETWEEN 0 AND 4194304),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, task_id),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  CHECK(
    (creator = 'owner' AND host_admitted = 0 AND required = 0)
    OR (creator = 'host' AND host_admitted = 1)
  )
);

CREATE TABLE IF NOT EXISTS persistent_workspace_records (
  record_id TEXT PRIMARY KEY CHECK(length(record_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('finding', 'decision', 'question')),
  content_json TEXT NOT NULL CHECK(length(content_json) <= 65536 AND json_valid(content_json)),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 65536),
  task_id TEXT,
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count BETWEEN 0 AND 4194304),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, record_id),
  UNIQUE(workspace_id, kind, summary),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES persistent_workspace_tasks(task_id) ON DELETE SET NULL,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS persistent_workspace_submissions (
  submission_id TEXT PRIMARY KEY CHECK(length(submission_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  state TEXT NOT NULL DEFAULT 'submitted' CHECK(state IN ('submitted', 'accepted', 'rejected')),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 65536),
  result_digest TEXT NOT NULL CHECK(length(result_digest) = 64 AND result_digest GLOB '[0-9a-fA-F]*'),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count BETWEEN 0 AND 4194304),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, submission_id),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES persistent_workspace_tasks(task_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS persistent_workspace_artifacts (
  artifact_id TEXT PRIMARY KEY CHECK(length(artifact_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  blob_digest TEXT NOT NULL CHECK(length(blob_digest) = 64 AND blob_digest GLOB '[0-9a-fA-F]*'),
  mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 255),
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 0 AND 4194304),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK(length(provenance_json) <= 16384 AND json_valid(provenance_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, artifact_id),
  UNIQUE(workspace_id, blob_digest),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS persistent_workspace_publications (
  publication_id TEXT PRIMARY KEY CHECK(length(publication_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  category TEXT NOT NULL CHECK(category IN ('task', 'finding', 'objective', 'artifact')),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128),
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  source_provenance_json TEXT NOT NULL CHECK(length(source_provenance_json) <= 16384 AND json_valid(source_provenance_json)),
  source_created_at INTEGER NOT NULL CHECK(source_created_at >= 0),
  source_updated_at INTEGER NOT NULL CHECK(source_updated_at >= 0),
  source_deleted_at INTEGER,
  copy_json TEXT NOT NULL CHECK(length(copy_json) <= 131072 AND json_valid(copy_json)),
  copy_digest TEXT NOT NULL CHECK(length(copy_digest) = 64 AND copy_digest GLOB '[0-9a-fA-F]*'),
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 0 AND 4194304),
  published_at INTEGER NOT NULL DEFAULT (unixepoch()),
  published_by TEXT NOT NULL CHECK(length(published_by) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision = 1),
  UNIQUE(workspace_id, category, source_id, source_revision),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_persistent_workspaces_chat ON persistent_workspaces(user_id, chat_id);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_sessions_turn ON persistent_workspace_turn_sessions(user_id, chat_id, turn_id, attempt_id);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_tasks_state ON persistent_workspace_tasks(user_id, chat_id, workspace_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_records_kind ON persistent_workspace_records(user_id, chat_id, workspace_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_submissions_state ON persistent_workspace_submissions(user_id, chat_id, workspace_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_artifacts_digest ON persistent_workspace_artifacts(user_id, chat_id, workspace_id, blob_digest);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_publications_source ON persistent_workspace_publications(user_id, chat_id, workspace_id, category, source_id, source_revision);

CREATE TRIGGER IF NOT EXISTS trg_persistent_workspace_publications_immutable_update
BEFORE UPDATE ON persistent_workspace_publications
WHEN NOT (
  NEW.publication_id IS OLD.publication_id
  AND NEW.workspace_id IS OLD.workspace_id
  AND NEW.user_id IS OLD.user_id
  AND NEW.category IS OLD.category
  AND NEW.source_id IS OLD.source_id
  AND NEW.source_revision IS OLD.source_revision
  AND NEW.source_created_at IS OLD.source_created_at
  AND NEW.source_updated_at IS OLD.source_updated_at
  AND NEW.copy_json IS OLD.copy_json
  AND NEW.copy_digest IS OLD.copy_digest
  AND NEW.byte_count IS OLD.byte_count
  AND NEW.published_at IS OLD.published_at
  AND NEW.published_by IS OLD.published_by
  AND NEW.revision IS OLD.revision
  AND (
    (
      OLD.chat_id IS NOT NULL
      AND NEW.chat_id IS NULL
      AND NEW.source_provenance_json IS OLD.source_provenance_json
      AND NEW.source_deleted_at IS OLD.source_deleted_at
    )
    OR (
      NEW.chat_id IS OLD.chat_id
      AND OLD.source_deleted_at IS NULL
      AND NEW.source_deleted_at IS NOT NULL
      AND NEW.source_provenance_json IS NOT OLD.source_provenance_json
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'persistent workspace publications are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_persistent_workspaces_archive_on_detach
AFTER UPDATE OF chat_id ON persistent_workspaces
WHEN OLD.chat_id IS NOT NULL AND NEW.chat_id IS NULL
BEGIN
  UPDATE persistent_workspaces
     SET state = 'archived',
         updated_at = unixepoch()
   WHERE workspace_id = NEW.workspace_id;
END;

-- Stage the exact deterministic legacy projection before any backfill.
-- Bun swallows an intermediate constraint error, so the failed unique-index
-- build is immediately followed by a missing-index assertion that propagates
-- before any persistent workspace/session/publication backfill.
DROP TABLE IF EXISTS temp.persistent_workspace_migration_projection;
DROP TABLE IF EXISTS temp.persistent_workspace_migration_collision;
DROP TABLE IF EXISTS temp.persistent_workspace_migration_guard;
CREATE TEMP TABLE persistent_workspace_migration_projection (
  workspace_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  quota_tasks INTEGER NOT NULL,
  quota_records INTEGER NOT NULL,
  quota_submissions INTEGER NOT NULL,
  quota_artifacts INTEGER NOT NULL,
  quota_publications INTEGER NOT NULL,
  quota_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO persistent_workspace_migration_projection (
  workspace_id, user_id, chat_id, objective, state, revision,
  quota_tasks, quota_records, quota_submissions, quota_artifacts, quota_publications,
  quota_bytes, created_at, updated_at
)
SELECT old.workspace_id, old.user_id, old.chat_id, old.objective,
       CASE old.state WHEN 'active' THEN 'active' ELSE 'archived' END,
       old.revision, old.quota_tasks, old.quota_records, old.quota_submissions,
       old.quota_artifacts, 512, old.quota_bytes, old.created_at, old.updated_at
  FROM agent_turn_workspaces AS old
 WHERE old.workspace_id = (
   SELECT MIN(candidate.workspace_id)
     FROM agent_turn_workspaces AS candidate
    WHERE candidate.user_id = old.user_id
      AND candidate.chat_id = old.chat_id
 );
CREATE TEMP TABLE persistent_workspace_migration_guard (
  valid INTEGER PRIMARY KEY CHECK(valid = 1)
);
INSERT INTO persistent_workspace_migration_guard (valid)
SELECT 1
  FROM temp.persistent_workspace_migration_projection
 LIMIT 1;
CREATE TEMP TABLE persistent_workspace_migration_collision (
  collision INTEGER
);
INSERT INTO persistent_workspace_migration_collision (collision)
SELECT 1
  FROM temp.persistent_workspace_migration_projection AS projection
  JOIN persistent_workspaces AS existing
    ON existing.workspace_id = projection.workspace_id
 WHERE NOT (
   existing.user_id IS projection.user_id
   AND existing.chat_id IS projection.chat_id
   AND existing.objective IS projection.objective
 )
 LIMIT 1;
INSERT INTO persistent_workspace_migration_collision (collision)
SELECT collision
  FROM persistent_workspace_migration_collision;
CREATE UNIQUE INDEX persistent_workspace_migration_collision_guard
  ON persistent_workspace_migration_collision(collision);
DROP INDEX persistent_workspace_migration_collision_guard;
DROP TABLE temp.persistent_workspace_migration_collision;
DROP TABLE temp.persistent_workspace_migration_guard;
INSERT INTO persistent_workspaces (
  workspace_id, user_id, chat_id, objective, metadata_json, progress_json, state, revision,
  quota_tasks, quota_records, quota_submissions, quota_artifacts, quota_publications, quota_bytes,
  created_at, updated_at
)
SELECT projection.workspace_id, projection.user_id, projection.chat_id, projection.objective, '{}', '{}',
       projection.state, projection.revision, projection.quota_tasks, projection.quota_records,
       projection.quota_submissions, projection.quota_artifacts, projection.quota_publications,
       projection.quota_bytes, projection.created_at, projection.updated_at
  FROM temp.persistent_workspace_migration_projection AS projection
 WHERE NOT EXISTS (
   SELECT 1 FROM persistent_workspaces AS existing
    WHERE existing.workspace_id = projection.workspace_id
      AND existing.user_id = projection.user_id
      AND existing.chat_id IS projection.chat_id
      AND existing.objective IS projection.objective
 );
DROP TABLE temp.persistent_workspace_migration_projection;

INSERT INTO persistent_workspace_turn_sessions (
  turn_session_id, workspace_id, user_id, chat_id, turn_id, attempt_id, execution_id,
  phase, status, outcome, reason, revision, created_at, updated_at, terminal_at
)
SELECT old.workspace_id, stable.workspace_id, old.user_id, old.chat_id, old.turn_id,
       execution.id, execution.id,
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
         WHEN execution.state IN ('COMMITTED', 'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT') THEN 'terminal'
         WHEN execution.cancel_requested_at IS NOT NULL THEN 'cancelling'
         WHEN execution.state = 'PREPARE_COMMIT' THEN 'waiting'
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
         WHEN execution.state = 'CANCELLED' THEN 'cancelled'
         WHEN execution.state = 'TIMED_OUT' THEN 'timed_out'
         WHEN execution.state = 'EXHAUSTED' THEN 'exhausted'
         WHEN execution.state = 'FAILED' THEN 'failed'
         WHEN execution.state = 'COMMIT_FAILED' THEN 'commit_failed'
         ELSE 'none'
       END,
       execution.phase_revision, execution.created_at, execution.updated_at, execution.terminal_at
  FROM agent_turn_workspaces AS old
  JOIN agent_turn_executions AS execution
    ON execution.id = old.execution_id
   AND execution.user_id = old.user_id
   AND execution.chat_id = old.chat_id
  JOIN persistent_workspaces AS stable
    ON stable.user_id = old.user_id AND stable.chat_id = old.chat_id
 WHERE NOT EXISTS (
   SELECT 1 FROM persistent_workspace_turn_sessions AS existing
    WHERE existing.turn_session_id = old.workspace_id
      AND existing.workspace_id = stable.workspace_id
      AND existing.user_id = old.user_id
      AND existing.chat_id IS old.chat_id
      AND existing.turn_id = old.turn_id
      AND existing.attempt_id = execution.id
      AND existing.execution_id IS execution.id
 );


INSERT INTO persistent_workspace_publications (
  publication_id, workspace_id, user_id, chat_id, category, source_id, source_revision,
  source_provenance_json, source_created_at, source_updated_at, source_deleted_at, copy_json,
  copy_digest, byte_count, published_at, published_by, revision
)
SELECT old.published_artifact_id, stable.workspace_id, old.user_id, old.chat_id, 'artifact', old.source_artifact_id, 1,
       json_object(
         'workspaceId', stable.workspace_id,
         'turnSessionId', session.turn_session_id,
         'attemptId', session.attempt_id,
         'executionId', session.execution_id,
         'sourceChatId', old.chat_id,
         'creator', 'migration:106',
         'capturedAt', old.created_at
       ),
       old.created_at, old.created_at, NULL,
       json_object('category', 'artifact', 'id', old.source_artifact_id, 'blobDigest', old.blob_digest, 'mimeType', old.mime_type, 'byteCount', old.byte_count, 'provenance', 'migration:106'),
       old.digest, old.byte_count, old.created_at, 'migration:106', 1
  FROM agent_published_workspace_artifacts AS old
  JOIN persistent_workspaces AS stable
    ON stable.user_id = old.user_id AND stable.chat_id = old.chat_id
  LEFT JOIN agent_workspace_artifacts AS source
    ON source.artifact_id = old.source_artifact_id
   AND source.user_id = old.user_id
   AND source.chat_id = old.chat_id
  LEFT JOIN persistent_workspace_turn_sessions AS session
    ON session.turn_session_id = source.workspace_id
   AND session.workspace_id = stable.workspace_id
   AND session.user_id = old.user_id
 WHERE NOT EXISTS (
   SELECT 1 FROM persistent_workspace_publications AS existing
    WHERE existing.publication_id = old.published_artifact_id
      AND existing.workspace_id = stable.workspace_id
      AND existing.user_id = old.user_id
      AND existing.chat_id IS old.chat_id
      AND existing.category = 'artifact'
      AND existing.source_id = old.source_artifact_id
      AND existing.source_revision = 1
      AND existing.source_provenance_json IS json_object(
        'workspaceId', stable.workspace_id,
        'turnSessionId', session.turn_session_id,
        'attemptId', session.attempt_id,
        'executionId', session.execution_id,
        'sourceChatId', old.chat_id,
        'creator', 'migration:106',
        'capturedAt', old.created_at
      )
 );

UPDATE persistent_workspaces AS workspace
   SET task_count = (SELECT COUNT(*) FROM persistent_workspace_tasks WHERE workspace_id = workspace.workspace_id),
       record_count = (SELECT COUNT(*) FROM persistent_workspace_records WHERE workspace_id = workspace.workspace_id),
       submission_count = (SELECT COUNT(*) FROM persistent_workspace_submissions WHERE workspace_id = workspace.workspace_id),
       artifact_count = (SELECT COUNT(*) FROM persistent_workspace_artifacts WHERE workspace_id = workspace.workspace_id),
       publication_count = (SELECT COUNT(*) FROM persistent_workspace_publications WHERE workspace_id = workspace.workspace_id),
       byte_count = COALESCE((SELECT SUM(byte_count) FROM persistent_workspace_tasks WHERE workspace_id = workspace.workspace_id), 0)
                  + COALESCE((SELECT SUM(byte_count) FROM persistent_workspace_records WHERE workspace_id = workspace.workspace_id), 0)
                  + COALESCE((SELECT SUM(byte_count) FROM persistent_workspace_submissions WHERE workspace_id = workspace.workspace_id), 0)
                  + COALESCE((SELECT SUM(byte_count) FROM persistent_workspace_artifacts WHERE workspace_id = workspace.workspace_id), 0)
                  + COALESCE((SELECT SUM(byte_count) FROM persistent_workspace_publications WHERE workspace_id = workspace.workspace_id), 0);
-- Migration 117 used a pre-alpha operational task/submission vocabulary.
-- Rebuild those tables under the canonical workspace states while preserving
-- all retained operational rows and their ownership edges.
DROP INDEX IF EXISTS idx_agent_workspace_tasks_state;
DROP INDEX IF EXISTS idx_agent_workspace_records_kind;
DROP INDEX IF EXISTS idx_agent_workspace_submissions_state;
DROP INDEX IF EXISTS idx_agent_workspace_artifacts_publication;

ALTER TABLE agent_workspace_records RENAME TO agent_workspace_records_legacy_115;
ALTER TABLE agent_workspace_submissions RENAME TO agent_workspace_submissions_legacy_115;
ALTER TABLE agent_workspace_artifacts RENAME TO agent_workspace_artifacts_legacy_115;
ALTER TABLE agent_workspace_tasks RENAME TO agent_workspace_tasks_legacy_115;

CREATE TABLE agent_workspace_tasks (
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
  byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 131072),
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

INSERT INTO agent_workspace_tasks (
  task_id, workspace_id, turn_id, user_id, chat_id, title, description, state,
  required, dependencies_json, assigned_frame_id, progress, summary, byte_count,
  revision, cas_owner, cas_expires_at, retention, expires_at, created_at, updated_at
)
SELECT
  task_id, workspace_id, turn_id, user_id, chat_id, title, description,
  CASE state WHEN 'submitted' THEN 'completed' ELSE state END,
  required, dependencies_json, assigned_frame_id, progress, summary, byte_count,
  revision, cas_owner, cas_expires_at, retention, expires_at, created_at, updated_at
FROM agent_workspace_tasks_legacy_115;

CREATE TABLE agent_workspace_records (
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

INSERT INTO agent_workspace_records (
  record_id, workspace_id, turn_id, user_id, chat_id, kind, summary, digest,
  task_id, source_frame_id, byte_count, revision, retention, expires_at, created_at
)
SELECT
  record_id, workspace_id, turn_id, user_id, chat_id, kind, summary, digest,
  task_id, source_frame_id, byte_count, revision, retention, expires_at, created_at
FROM agent_workspace_records_legacy_115;

CREATE TABLE agent_workspace_submissions (
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

INSERT INTO agent_workspace_submissions (
  submission_id, task_id, workspace_id, turn_id, user_id, chat_id, child_frame_id,
  state, summary, result_digest, byte_count, revision, retention, expires_at,
  created_at, updated_at
)
SELECT
  submission_id, task_id, workspace_id, turn_id, user_id, chat_id, child_frame_id,
  CASE state WHEN 'proposed' THEN 'submitted' ELSE state END,
  summary, result_digest, byte_count, revision, retention, expires_at,
  created_at, updated_at
FROM agent_workspace_submissions_legacy_115;

CREATE TABLE agent_workspace_artifacts (
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

INSERT INTO agent_workspace_artifacts (
  artifact_id, workspace_id, turn_id, user_id, chat_id, blob_digest, mime_type,
  byte_count, provenance_json, source_frame_id, source_task_id, publication_state,
  retention, revision, expires_at, created_at, updated_at
)
SELECT
  artifact_id, workspace_id, turn_id, user_id, chat_id, blob_digest, mime_type,
  byte_count, provenance_json, source_frame_id, source_task_id, publication_state,
  retention, revision, expires_at, created_at, updated_at
FROM agent_workspace_artifacts_legacy_115;

DROP TABLE agent_workspace_records_legacy_115;
DROP TABLE agent_workspace_submissions_legacy_115;
DROP TABLE agent_workspace_artifacts_legacy_115;
DROP TABLE agent_workspace_tasks_legacy_115;

CREATE INDEX IF NOT EXISTS idx_agent_workspace_tasks_state
  ON agent_workspace_tasks(user_id, workspace_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_workspace_records_kind
  ON agent_workspace_records(user_id, workspace_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_workspace_submissions_state
  ON agent_workspace_submissions(user_id, workspace_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_workspace_artifacts_publication
  ON agent_workspace_artifacts(user_id, workspace_id, publication_state, updated_at);
