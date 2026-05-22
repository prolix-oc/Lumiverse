-- Track manual edits to Memory Cortex entities so cortex rebuilds don't
-- clobber them. Rows with user_edited_at set are kept (with derived
-- counters reset) instead of being deleted by clearDerivedCortexData, and
-- live ingestion's upsertEntity preserves curated fields (name, type,
-- aliases, description, facts) when this column is non-NULL.

ALTER TABLE memory_entities ADD COLUMN user_edited_at INTEGER;

CREATE INDEX idx_me_user_edited ON memory_entities(chat_id)
  WHERE user_edited_at IS NOT NULL;
