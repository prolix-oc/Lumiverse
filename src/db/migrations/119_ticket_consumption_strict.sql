-- Decryption tickets are one-use capabilities. Normalize the historical
-- advisory counter to a strict invariant while preserving the archive ledger.
-- The owner reference is nullable and set to NULL on account deletion so the
-- global archive tombstone remains permanently replay-blocking.
CREATE TABLE import_consumed_tickets_v2 (
  archive_id  TEXT PRIMARY KEY,
  consumed_at INTEGER NOT NULL,
  user_id     TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  uses        INTEGER NOT NULL DEFAULT 1 CHECK (uses = 1)
);

INSERT INTO import_consumed_tickets_v2 (archive_id, consumed_at, user_id, uses)
SELECT archive_id, consumed_at, user_id, 1
  FROM import_consumed_tickets;

DROP TABLE import_consumed_tickets;
ALTER TABLE import_consumed_tickets_v2 RENAME TO import_consumed_tickets;

CREATE INDEX IF NOT EXISTS idx_ict_user_consumed
  ON import_consumed_tickets(user_id, consumed_at DESC);
