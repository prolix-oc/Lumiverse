-- Cortex retrieval performance indexes

-- Recent-vectorized fallback queries and recency scans
CREATE INDEX IF NOT EXISTS idx_cc_chat_created_desc
  ON chat_chunks(chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cc_chat_vectorized_created_desc
  ON chat_chunks(chat_id, created_at DESC)
  WHERE vectorized_at IS NOT NULL;

-- Active-entity lookup and alias/name fallback scans ordered by mention frequency
CREATE INDEX IF NOT EXISTS idx_me_chat_mentions_desc
  ON memory_entities(chat_id, mention_count DESC);

CREATE INDEX IF NOT EXISTS idx_me_chat_active_mentions_desc
  ON memory_entities(chat_id, mention_count DESC)
  WHERE status != 'inactive';

-- Relation fan-out during entity context assembly, ordered by strongest edges first
CREATE INDEX IF NOT EXISTS idx_mr_active_source_salience
  ON memory_relations(chat_id, source_entity_id, edge_salience DESC, strength DESC)
  WHERE status = 'active' AND superseded_by IS NULL AND merged_into IS NULL AND contradiction_flag != 'suspect';

CREATE INDEX IF NOT EXISTS idx_mr_active_target_salience
  ON memory_relations(chat_id, target_entity_id, edge_salience DESC, strength DESC)
  WHERE status = 'active' AND superseded_by IS NULL AND merged_into IS NULL AND contradiction_flag != 'suspect';
