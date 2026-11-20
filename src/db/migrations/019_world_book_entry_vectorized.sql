ALTER TABLE world_book_entries ADD COLUMN vectorized INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_wbe_world_book_vectorized ON world_book_entries(world_book_id, vectorized);
