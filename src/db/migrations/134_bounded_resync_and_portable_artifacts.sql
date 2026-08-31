-- Bound resync retention metadata and keep canonical artifact paths portable.
ALTER TABLE agent_run_resync_snapshots
  ADD COLUMN omitted_runs INTEGER NOT NULL DEFAULT 0 CHECK(omitted_runs >= 0);
-- Collapse pre-fix duplicate snapshots before enforcing exact-watermark reuse.
DELETE FROM agent_run_resync_snapshot_members
 WHERE snapshot_id IN (
   SELECT snapshot_id
     FROM (
       SELECT snapshot_id,
              ROW_NUMBER() OVER (
                PARTITION BY user_id, chat_id, snapshot_sequence
                ORDER BY created_at DESC, snapshot_id DESC
              ) AS duplicate_ordinal
         FROM agent_run_resync_snapshots
     )
    WHERE duplicate_ordinal > 1
 );
DELETE FROM agent_run_resync_snapshots
 WHERE snapshot_id IN (
   SELECT snapshot_id
     FROM (
       SELECT snapshot_id,
              ROW_NUMBER() OVER (
                PARTITION BY user_id, chat_id, snapshot_sequence
                ORDER BY created_at DESC, snapshot_id DESC
              ) AS duplicate_ordinal
         FROM agent_run_resync_snapshots
     )
    WHERE duplicate_ordinal > 1
 );
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_resync_snapshots_watermark
  ON agent_run_resync_snapshots(user_id, chat_id, snapshot_sequence);

-- Native publications created before this migration copied an absolute
-- operational blob path. Their deterministic canonical path is digest-owned.
UPDATE agent_published_workspace_artifacts
   SET storage_path = lower(blob_digest) || '.blob'
 WHERE storage_path LIKE '/%'
    OR storage_path GLOB '[A-Za-z]:*'
    OR storage_path LIKE '%\%'
    OR storage_path = '..'
    OR storage_path LIKE '../%'
    OR storage_path LIKE '%/../%'
    OR storage_path LIKE '%/..'
    OR storage_path = '.'
    OR storage_path LIKE './%'
    OR storage_path LIKE '%/./%'
    OR storage_path LIKE '%/.'
    OR storage_path LIKE '%//%'
    OR storage_path LIKE '%/'
    OR storage_path GLOB '*[^A-Za-z0-9._/-]*';

CREATE TRIGGER IF NOT EXISTS trg_agent_published_artifact_relative_path_insert
BEFORE INSERT ON agent_published_workspace_artifacts
WHEN NEW.storage_path LIKE '/%'
  OR NEW.storage_path GLOB '[A-Za-z]:*'
  OR NEW.storage_path LIKE '%\%'
  OR NEW.storage_path = '..' OR NEW.storage_path LIKE '../%'
  OR NEW.storage_path LIKE '%/../%' OR NEW.storage_path LIKE '%/..'
  OR NEW.storage_path = '.' OR NEW.storage_path LIKE './%'
  OR NEW.storage_path LIKE '%/./%' OR NEW.storage_path LIKE '%/.'
  OR NEW.storage_path LIKE '%//%' OR NEW.storage_path LIKE '%/'
  OR NEW.storage_path GLOB '*[^A-Za-z0-9._/-]*'
BEGIN
  SELECT RAISE(ABORT, 'published artifact storage_path must be portable and owner-relative');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_published_artifact_relative_path_update
BEFORE UPDATE OF storage_path ON agent_published_workspace_artifacts
WHEN NEW.storage_path LIKE '/%'
  OR NEW.storage_path GLOB '[A-Za-z]:*'
  OR NEW.storage_path LIKE '%\%'
  OR NEW.storage_path = '..' OR NEW.storage_path LIKE '../%'
  OR NEW.storage_path LIKE '%/../%' OR NEW.storage_path LIKE '%/..'
  OR NEW.storage_path = '.' OR NEW.storage_path LIKE './%'
  OR NEW.storage_path LIKE '%/./%' OR NEW.storage_path LIKE '%/.'
  OR NEW.storage_path LIKE '%//%' OR NEW.storage_path LIKE '%/'
  OR NEW.storage_path GLOB '*[^A-Za-z0-9._/-]*'
BEGIN
  SELECT RAISE(ABORT, 'published artifact storage_path must be portable and owner-relative');
END;
