-- FTS5 virtual table for world book entry search (comment, content, keys)
CREATE VIRTUAL TABLE IF NOT EXISTS world_book_entries_fts USING fts5(
  comment, content, key, keysecondary,
  content='world_book_entries',
  content_rowid='rowid'
);

-- Populate from existing data
INSERT INTO world_book_entries_fts(rowid, comment, content, key, keysecondary)
  SELECT rowid, comment, content, key, keysecondary FROM world_book_entries;

-- Keep FTS in sync on INSERT
CREATE TRIGGER world_book_entries_fts_insert AFTER INSERT ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(rowid, comment, content, key, keysecondary)
    VALUES (new.rowid, new.comment, new.content, new.key, new.keysecondary);
END;

-- Keep FTS in sync on DELETE
CREATE TRIGGER world_book_entries_fts_delete BEFORE DELETE ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(world_book_entries_fts, rowid, comment, content, key, keysecondary)
    VALUES ('delete', old.rowid, old.comment, old.content, old.key, old.keysecondary);
END;

-- Keep FTS in sync on UPDATE (delete old, insert new)
CREATE TRIGGER world_book_entries_fts_update BEFORE UPDATE ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(world_book_entries_fts, rowid, comment, content, key, keysecondary)
    VALUES ('delete', old.rowid, old.comment, old.content, old.key, old.keysecondary);
END;

CREATE TRIGGER world_book_entries_fts_update_after AFTER UPDATE ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(rowid, comment, content, key, keysecondary)
    VALUES (new.rowid, new.comment, new.content, new.key, new.keysecondary);
END;
