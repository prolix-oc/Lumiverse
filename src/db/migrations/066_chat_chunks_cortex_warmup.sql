-- Memory Cortex: Track per-chunk warmup completion for resumable auto-warmup
ALTER TABLE chat_chunks ADD COLUMN cortex_warmup_signature TEXT DEFAULT NULL;
ALTER TABLE chat_chunks ADD COLUMN cortex_warmup_completed_at INTEGER DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_cc_chat_cortex_warmup
  ON chat_chunks(chat_id, cortex_warmup_signature, created_at);
