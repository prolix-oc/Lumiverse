-- Preserve one-use decryption-ticket tombstones after the owning account is
-- deleted. The archive id remains globally unique forever; user_id is only
-- nullable audit metadata and must not cascade-delete the tombstone.
CREATE TABLE import_consumed_tickets_v3 (
  archive_id  TEXT PRIMARY KEY NOT NULL,
  consumed_at INTEGER NOT NULL,
  user_id     TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  uses        INTEGER NOT NULL DEFAULT 1 CHECK (uses = 1)
);

INSERT INTO import_consumed_tickets_v3 (archive_id, consumed_at, user_id, uses)
SELECT archive_id, consumed_at, user_id, 1
  FROM import_consumed_tickets;

DROP TABLE import_consumed_tickets;
ALTER TABLE import_consumed_tickets_v3 RENAME TO import_consumed_tickets;

CREATE INDEX IF NOT EXISTS idx_ict_user_consumed
  ON import_consumed_tickets(user_id, consumed_at DESC);
