-- Rebuild FTS5 virtual tables with the trigram tokenizer for CJK / Unicode
-- search. The default `unicode61` tokenizer splits on whitespace + punctuation,
-- which means scripts without word boundaries (Chinese, Japanese, Korean,
-- Thai) tokenize the entire phrase as one unbroken token and never match
-- partial-word searches.
--
-- Trigram indexes every 3-character sliding window, so substring matching
-- works naturally across any script. The index is ~2–3× larger than the
-- unicode61 one, but these tables are small so the overhead is negligible.
--
-- DROP + recreate + re-INSERT rebuilds the index from scratch against every
-- existing row, so all previously-created characters and world book entries
-- become retroactively searchable the moment this migration finishes — no
-- separate backfill step required.
--
-- NOTE: trigram cannot match queries shorter than 3 characters. The services
-- fall back to a LIKE scan for 1–2 char queries (e.g. 2-char CJK names).

DROP TRIGGER IF EXISTS characters_fts_insert;
DROP TRIGGER IF EXISTS characters_fts_delete;
DROP TRIGGER IF EXISTS characters_fts_update;
DROP TRIGGER IF EXISTS characters_fts_update_after;
DROP TABLE IF EXISTS characters_fts;

CREATE VIRTUAL TABLE characters_fts USING fts5(
  name, creator, tags,
  content='characters',
  content_rowid='rowid',
  tokenize='trigram'
);

INSERT INTO characters_fts(rowid, name, creator, tags)
  SELECT rowid, name, creator, tags FROM characters;

CREATE TRIGGER characters_fts_insert AFTER INSERT ON characters BEGIN
  INSERT INTO characters_fts(rowid, name, creator, tags)
    VALUES (new.rowid, new.name, new.creator, new.tags);
END;

CREATE TRIGGER characters_fts_delete BEFORE DELETE ON characters BEGIN
  INSERT INTO characters_fts(characters_fts, rowid, name, creator, tags)
    VALUES ('delete', old.rowid, old.name, old.creator, old.tags);
END;

CREATE TRIGGER characters_fts_update BEFORE UPDATE ON characters BEGIN
  INSERT INTO characters_fts(characters_fts, rowid, name, creator, tags)
    VALUES ('delete', old.rowid, old.name, old.creator, old.tags);
END;

CREATE TRIGGER characters_fts_update_after AFTER UPDATE ON characters BEGIN
  INSERT INTO characters_fts(rowid, name, creator, tags)
    VALUES (new.rowid, new.name, new.creator, new.tags);
END;

DROP TRIGGER IF EXISTS world_book_entries_fts_insert;
DROP TRIGGER IF EXISTS world_book_entries_fts_delete;
DROP TRIGGER IF EXISTS world_book_entries_fts_update;
DROP TRIGGER IF EXISTS world_book_entries_fts_update_after;
DROP TABLE IF EXISTS world_book_entries_fts;

CREATE VIRTUAL TABLE world_book_entries_fts USING fts5(
  comment, content, key, keysecondary,
  content='world_book_entries',
  content_rowid='rowid',
  tokenize='trigram'
);

INSERT INTO world_book_entries_fts(rowid, comment, content, key, keysecondary)
  SELECT rowid, comment, content, key, keysecondary FROM world_book_entries;

CREATE TRIGGER world_book_entries_fts_insert AFTER INSERT ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(rowid, comment, content, key, keysecondary)
    VALUES (new.rowid, new.comment, new.content, new.key, new.keysecondary);
END;

CREATE TRIGGER world_book_entries_fts_delete BEFORE DELETE ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(world_book_entries_fts, rowid, comment, content, key, keysecondary)
    VALUES ('delete', old.rowid, old.comment, old.content, old.key, old.keysecondary);
END;

CREATE TRIGGER world_book_entries_fts_update BEFORE UPDATE ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(world_book_entries_fts, rowid, comment, content, key, keysecondary)
    VALUES ('delete', old.rowid, old.comment, old.content, old.key, old.keysecondary);
END;

CREATE TRIGGER world_book_entries_fts_update_after AFTER UPDATE ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(rowid, comment, content, key, keysecondary)
    VALUES (new.rowid, new.comment, new.content, new.key, new.keysecondary);
END;
