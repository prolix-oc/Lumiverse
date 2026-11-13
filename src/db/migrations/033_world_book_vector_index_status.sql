ALTER TABLE world_book_entries ADD COLUMN vector_index_status TEXT NOT NULL DEFAULT 'not_enabled';
ALTER TABLE world_book_entries ADD COLUMN vector_indexed_at INTEGER;
ALTER TABLE world_book_entries ADD COLUMN vector_index_error TEXT;

UPDATE world_book_entries
SET vector_index_status = CASE
  WHEN vectorized = 1 THEN 'pending'
  ELSE 'not_enabled'
END
WHERE vector_index_status IS NULL OR vector_index_status = '';

CREATE INDEX IF NOT EXISTS idx_wbe_world_book_vector_index_status
ON world_book_entries(world_book_id, vector_index_status);
