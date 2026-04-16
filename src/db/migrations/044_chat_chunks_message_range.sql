-- Memory Cortex: Denormalize message ranges onto chat_chunks for fast retrieval
-- Avoids expensive json_each subqueries during retrieval scoring
ALTER TABLE chat_chunks ADD COLUMN message_range_start INTEGER DEFAULT NULL;
ALTER TABLE chat_chunks ADD COLUMN message_range_end INTEGER DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_cc_chat_range ON chat_chunks(chat_id, message_range_start, message_range_end);
