-- Track manual edits to Memory Cortex relations so cortex rebuilds don't
-- clobber them. Rows with user_edited_at set are kept (with derived
-- counters reset) instead of being deleted by clearDerivedCortexData.
--
-- Endpoint-safety workaround: when a rebuild encounters a user-edited
-- relation whose source or target entity no longer exists (because the
-- user deleted that entity outside of this relation's lifecycle), the
-- relation is downgraded to status='superseded' rather than preserved
-- with a dangling reference. The user can then re-link it explicitly.

ALTER TABLE memory_relations ADD COLUMN user_edited_at INTEGER;

CREATE INDEX idx_mr_user_edited ON memory_relations(chat_id)
  WHERE user_edited_at IS NOT NULL;
