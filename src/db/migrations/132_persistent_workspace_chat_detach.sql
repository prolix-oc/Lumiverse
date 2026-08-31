-- Keep persistent workspace children readable after their source chat is deleted.
-- Workspaces and turn sessions retain their own FK-driven SET NULL behavior;
-- these child tables intentionally use a trigger because their chat_id is
-- historical provenance rather than a live foreign-key association.
-- Older revisions could leave legacy publication trigger names installed, and
-- migration 125's archive trigger lacked the workspace revision bump.
DROP TRIGGER IF EXISTS persistent_workspace_publications_immutable_update;
DROP TRIGGER IF EXISTS persistent_workspaces_archive_on_detach;
DROP TRIGGER IF EXISTS trg_persistent_workspaces_archive_on_detach;
DROP TRIGGER IF EXISTS persistent_workspace_detach_children_on_chat_delete;

DROP TRIGGER IF EXISTS trg_persistent_workspace_publications_immutable_update;
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
         revision = revision + 1,
         updated_at = unixepoch()
   WHERE workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_persistent_workspace_detach_children_on_chat_delete
AFTER DELETE ON chats
BEGIN
  UPDATE persistent_workspace_tasks
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_records
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_submissions
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_artifacts
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_publications
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
END;
