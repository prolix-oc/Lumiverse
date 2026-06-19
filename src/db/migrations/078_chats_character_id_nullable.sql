-- Make chats.character_id nullable so temporary character-less chats can exist.
-- SQLite cannot drop NOT NULL in place, so rebuild the table. The runner
-- (migrate.ts) executes this file with PRAGMA foreign_keys=OFF: with
-- enforcement on, DROP TABLE chats would run an implicit DELETE that fires
-- ON DELETE CASCADE into messages and every other child table.
CREATE TABLE chats_new (
  id TEXT PRIMARY KEY,
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE
);

INSERT INTO chats_new (id, character_id, name, metadata, created_at, updated_at, user_id)
SELECT id, character_id, name, metadata, created_at, updated_at, user_id FROM chats;

DROP TABLE chats;

ALTER TABLE chats_new RENAME TO chats;

CREATE INDEX idx_chats_character_id ON chats(character_id);
CREATE INDEX idx_chats_user_character ON chats(user_id, character_id, updated_at DESC);
CREATE INDEX idx_chats_user_id ON chats(user_id);
CREATE INDEX idx_chats_user_updated ON chats(user_id, updated_at DESC);
