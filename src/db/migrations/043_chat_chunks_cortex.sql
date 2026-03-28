-- Memory Cortex: Extend chat_chunks with cortex metadata
ALTER TABLE chat_chunks ADD COLUMN salience_score REAL DEFAULT NULL;
ALTER TABLE chat_chunks ADD COLUMN emotional_tags TEXT DEFAULT NULL;
ALTER TABLE chat_chunks ADD COLUMN entity_ids TEXT DEFAULT NULL;
ALTER TABLE chat_chunks ADD COLUMN consolidation_id TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_cc_consolidation ON chat_chunks(consolidation_id);
CREATE INDEX IF NOT EXISTS idx_cc_chat_salience ON chat_chunks(chat_id, salience_score DESC);
