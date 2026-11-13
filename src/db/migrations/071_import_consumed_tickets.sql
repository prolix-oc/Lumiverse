-- Tracks decryption tickets that have been consumed during user-data imports.
-- Used for advisory replay detection — the import endpoint surfaces a warning
-- when a ticket is re-used (a backup of a backup, restoring twice, etc.) but
-- never blocks on it; archival use is a deliberate first-class workflow.
--
-- archive_id mirrors manifest.archiveId from the .lvbak archive (a UUID
-- generated at export prepare time). One row per consumed ticket, forever.

CREATE TABLE IF NOT EXISTS import_consumed_tickets (
  archive_id  TEXT PRIMARY KEY,
  consumed_at INTEGER NOT NULL,
  user_id     TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  uses        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_ict_user_consumed
  ON import_consumed_tickets(user_id, consumed_at DESC);
