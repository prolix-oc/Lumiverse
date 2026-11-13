ALTER TABLE personas ADD COLUMN attached_world_book_id TEXT REFERENCES world_books(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_personas_attached_wb ON personas(attached_world_book_id);
