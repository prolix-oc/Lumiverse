-- Add folder (organizational grouping) to world_books
ALTER TABLE world_books ADD COLUMN folder TEXT NOT NULL DEFAULT '';
