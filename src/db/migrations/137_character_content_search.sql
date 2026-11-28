-- Full-content search keeps the existing compact metadata FTS index intact.
-- Store only normalized alternate text: standard fields remain external content.
-- The FTS source view joins ordinary tables; json_each must not appear inside
-- an external-content view read internally by FTS5 (SQLITE_PREPARE_NO_VTAB).
CREATE TABLE character_search_text (
  character_id TEXT PRIMARY KEY NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  greetings TEXT NOT NULL DEFAULT '',
  variants TEXT NOT NULL DEFAULT ''
);

CREATE VIEW character_search_projection AS
SELECT c.id AS character_id,
  COALESCE((SELECT group_concat(value, char(10))
    FROM json_each(c.alternate_greetings) WHERE type = 'text'), '') AS greetings,
  COALESCE((SELECT group_concat(
      CASE WHEN json_type(document, '$.label') = 'text' THEN json_extract(document, '$.label') ELSE '' END
      || char(10) ||
      CASE WHEN json_type(document, '$.content') = 'text' THEN json_extract(document, '$.content') ELSE '' END,
      char(10))
    FROM (
      SELECT CASE WHEN v.type = 'object' THEN v.value ELSE '{}' END AS document
      FROM json_each(c.extensions, '$.alternate_fields') f
      JOIN json_each(CASE WHEN f.type = 'array' THEN f.value ELSE '[]' END) v
      WHERE f.key IN ('description', 'personality', 'scenario') AND v.type = 'object'
    )), '') AS variants
FROM characters c;

CREATE VIEW character_search_content AS
SELECT c.rowid AS rowid, c.id AS character_id,
  c.name, c.creator, c.tags, c.description, c.personality, c.scenario, c.first_mes, c.mes_example, c.creator_notes, c.system_prompt, c.post_history_instructions,
  t.greetings, t.variants
FROM characters c JOIN character_search_text t ON t.character_id = c.id;

CREATE VIRTUAL TABLE characters_content_fts USING fts5(
  name, creator, tags, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, greetings, variants,
  content='character_search_content',
  content_rowid='rowid',
  tokenize='trigram'
);

-- One transactional backfill at upgrade; a failed migration rolls back in full.
INSERT INTO character_search_text(character_id, greetings, variants)
  SELECT character_id, greetings, variants FROM character_search_projection;
INSERT INTO characters_content_fts(characters_content_fts) VALUES('rebuild');

CREATE TRIGGER characters_content_fts_insert AFTER INSERT ON characters BEGIN
  INSERT INTO character_search_text(character_id, greetings, variants)
    SELECT character_id, greetings, variants FROM character_search_projection WHERE character_id = new.id;
  INSERT INTO characters_content_fts(rowid, name, creator, tags, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, greetings, variants)
    SELECT rowid, name, creator, tags, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, greetings, variants FROM character_search_content WHERE character_id = new.id;
END;

CREATE TRIGGER characters_content_fts_delete BEFORE DELETE ON characters BEGIN
  INSERT INTO characters_content_fts(characters_content_fts, rowid, name, creator, tags, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, greetings, variants)
    SELECT 'delete', rowid, name, creator, tags, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, greetings, variants FROM character_search_content WHERE character_id = old.id;
  DELETE FROM character_search_text WHERE character_id = old.id;
END;

CREATE TRIGGER characters_content_fts_update BEFORE UPDATE OF name, creator, tags, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, alternate_greetings, extensions ON characters
WHEN old.name IS NOT new.name
  OR old.creator IS NOT new.creator
  OR old.tags IS NOT new.tags
  OR old.description IS NOT new.description
  OR old.personality IS NOT new.personality
  OR old.scenario IS NOT new.scenario
  OR old.first_mes IS NOT new.first_mes
  OR old.mes_example IS NOT new.mes_example
  OR old.creator_notes IS NOT new.creator_notes
  OR old.system_prompt IS NOT new.system_prompt
  OR old.post_history_instructions IS NOT new.post_history_instructions
  OR old.alternate_greetings IS NOT new.alternate_greetings
  OR json_extract(old.extensions, '$.alternate_fields') IS NOT json_extract(new.extensions, '$.alternate_fields')
BEGIN
  INSERT INTO characters_content_fts(characters_content_fts, rowid, name, creator, tags, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, greetings, variants)
    SELECT 'delete', rowid, name, creator, tags, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, greetings, variants FROM character_search_content WHERE character_id = old.id;
END;

CREATE TRIGGER characters_content_fts_update_after AFTER UPDATE OF name, creator, tags, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, alternate_greetings, extensions ON characters
WHEN old.name IS NOT new.name
  OR old.creator IS NOT new.creator
  OR old.tags IS NOT new.tags
  OR old.description IS NOT new.description
  OR old.personality IS NOT new.personality
  OR old.scenario IS NOT new.scenario
  OR old.first_mes IS NOT new.first_mes
  OR old.mes_example IS NOT new.mes_example
  OR old.creator_notes IS NOT new.creator_notes
  OR old.system_prompt IS NOT new.system_prompt
  OR old.post_history_instructions IS NOT new.post_history_instructions
  OR old.alternate_greetings IS NOT new.alternate_greetings
  OR json_extract(old.extensions, '$.alternate_fields') IS NOT json_extract(new.extensions, '$.alternate_fields')
BEGIN
  UPDATE character_search_text SET
    greetings = CASE WHEN old.alternate_greetings IS NOT new.alternate_greetings
      THEN (SELECT greetings FROM character_search_projection WHERE character_id = new.id) ELSE greetings END,
    variants = CASE WHEN json_extract(old.extensions, '$.alternate_fields') IS NOT json_extract(new.extensions, '$.alternate_fields')
      THEN (SELECT variants FROM character_search_projection WHERE character_id = new.id) ELSE variants END
    WHERE character_id = new.id;
  INSERT INTO characters_content_fts(rowid, name, creator, tags, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, greetings, variants)
    SELECT rowid, name, creator, tags, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, greetings, variants FROM character_search_content WHERE character_id = new.id;
END;
