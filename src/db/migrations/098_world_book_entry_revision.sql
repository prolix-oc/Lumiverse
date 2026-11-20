-- Add a monotonic, non-user-visible revision for world book entry cache/concurrency checks.
-- The migration runner records applied filenames in _migrations, so this file is
-- executed once per database. Migration 086 adds weaver_sessions.narration_mode
-- only and does not define this column.
ALTER TABLE world_book_entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
