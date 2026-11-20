-- Only searchable character fields need to replace the external-content FTS
-- row. Avatar, folder, scope, migration metadata, and timestamp updates should
-- not churn the FTS index.
DROP TRIGGER IF EXISTS characters_fts_update;
DROP TRIGGER IF EXISTS characters_fts_update_after;

CREATE TRIGGER characters_fts_update
BEFORE UPDATE OF name, creator, tags ON characters BEGIN
  INSERT INTO characters_fts(characters_fts, rowid, name, creator, tags)
    VALUES ('delete', old.rowid, old.name, old.creator, old.tags);
END;

CREATE TRIGGER characters_fts_update_after
AFTER UPDATE OF name, creator, tags ON characters BEGIN
  INSERT INTO characters_fts(rowid, name, creator, tags)
    VALUES (new.rowid, new.name, new.creator, new.tags);
END;
