-- FTS5 virtual table for character search (name, creator, tags)
CREATE VIRTUAL TABLE IF NOT EXISTS characters_fts USING fts5(
  name, creator, tags,
  content='characters',
  content_rowid='rowid'
);

-- Populate from existing data
INSERT INTO characters_fts(rowid, name, creator, tags)
  SELECT rowid, name, creator, tags FROM characters;

-- Keep FTS in sync on INSERT
CREATE TRIGGER characters_fts_insert AFTER INSERT ON characters BEGIN
  INSERT INTO characters_fts(rowid, name, creator, tags)
    VALUES (new.rowid, new.name, new.creator, new.tags);
END;

-- Keep FTS in sync on DELETE
CREATE TRIGGER characters_fts_delete BEFORE DELETE ON characters BEGIN
  INSERT INTO characters_fts(characters_fts, rowid, name, creator, tags)
    VALUES ('delete', old.rowid, old.name, old.creator, old.tags);
END;

-- Keep FTS in sync on UPDATE (delete old, insert new)
CREATE TRIGGER characters_fts_update BEFORE UPDATE ON characters BEGIN
  INSERT INTO characters_fts(characters_fts, rowid, name, creator, tags)
    VALUES ('delete', old.rowid, old.name, old.creator, old.tags);
END;

CREATE TRIGGER characters_fts_update_after AFTER UPDATE ON characters BEGIN
  INSERT INTO characters_fts(rowid, name, creator, tags)
    VALUES (new.rowid, new.name, new.creator, new.tags);
END;
