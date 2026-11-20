-- 126: Durable reverse image references, populated incrementally by the DB subprocess.
-- Native triggers record invalidations for all writers, including imports and extensions.
-- Do not trust negative lookups until every source is backfilled and dirty rows are refreshed.
CREATE TABLE image_references (
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  PRIMARY KEY (source_type, source_id, image_id)
) WITHOUT ROWID;
CREATE INDEX idx_image_references_lookup ON image_references(user_id, image_id);
CREATE TABLE image_reference_dirty (
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (source_type, source_id)
) WITHOUT ROWID;
CREATE INDEX idx_image_reference_dirty_user ON image_reference_dirty(user_id);
CREATE TABLE image_reference_index_state (
  source_type TEXT PRIMARY KEY,
  last_id TEXT,
  last_user_id TEXT,
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1))
);
INSERT INTO image_reference_index_state(source_type) VALUES
  ('characters'), ('personas'), ('presets'), ('chats'), ('messages'), ('settings');
CREATE INDEX idx_character_gallery_image_reference ON character_gallery(user_id, image_id);
CREATE INDEX idx_characters_image_reference ON characters(user_id, image_id) WHERE deleting = 0;
CREATE INDEX idx_personas_image_reference ON personas(user_id, image_id);
CREATE INDEX idx_theme_assets_image_reference ON theme_assets(user_id, image_id);

CREATE TRIGGER image_refs_characters_insert AFTER INSERT ON characters
BEGIN
  DELETE FROM image_references WHERE source_type = 'characters' AND source_id = NEW.id;
  INSERT INTO image_reference_dirty(source_type, source_id, user_id)
    VALUES ('characters', NEW.id, COALESCE(NEW.user_id, ''))
    ON CONFLICT(source_type, source_id) DO UPDATE SET user_id = excluded.user_id;
END;
CREATE TRIGGER image_refs_characters_update AFTER UPDATE OF id, user_id, deleting, extensions, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, alternate_greetings ON characters
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.deleting IS NOT OLD.deleting OR NEW.extensions IS NOT OLD.extensions OR NEW.description IS NOT OLD.description OR NEW.personality IS NOT OLD.personality OR NEW.scenario IS NOT OLD.scenario OR NEW.first_mes IS NOT OLD.first_mes OR NEW.mes_example IS NOT OLD.mes_example OR NEW.creator_notes IS NOT OLD.creator_notes OR NEW.system_prompt IS NOT OLD.system_prompt OR NEW.post_history_instructions IS NOT OLD.post_history_instructions OR NEW.alternate_greetings IS NOT OLD.alternate_greetings
BEGIN
  DELETE FROM image_references WHERE source_type = 'characters' AND source_id = OLD.id;
  DELETE FROM image_reference_dirty WHERE source_type = 'characters' AND source_id = OLD.id;
  INSERT INTO image_reference_dirty(source_type, source_id, user_id)
    VALUES ('characters', NEW.id, COALESCE(NEW.user_id, ''))
    ON CONFLICT(source_type, source_id) DO UPDATE SET user_id = excluded.user_id;
END;
CREATE TRIGGER image_refs_characters_delete AFTER DELETE ON characters
BEGIN
  DELETE FROM image_references WHERE source_type = 'characters' AND source_id = OLD.id;
  DELETE FROM image_reference_dirty WHERE source_type = 'characters' AND source_id = OLD.id;
END;

CREATE TRIGGER image_refs_personas_insert AFTER INSERT ON personas
BEGIN
  DELETE FROM image_references WHERE source_type = 'personas' AND source_id = NEW.id;
  INSERT INTO image_reference_dirty(source_type, source_id, user_id)
    VALUES ('personas', NEW.id, COALESCE(NEW.user_id, ''))
    ON CONFLICT(source_type, source_id) DO UPDATE SET user_id = excluded.user_id;
END;
CREATE TRIGGER image_refs_personas_update AFTER UPDATE OF id, user_id, metadata ON personas
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.metadata IS NOT OLD.metadata
BEGIN
  DELETE FROM image_references WHERE source_type = 'personas' AND source_id = OLD.id;
  DELETE FROM image_reference_dirty WHERE source_type = 'personas' AND source_id = OLD.id;
  INSERT INTO image_reference_dirty(source_type, source_id, user_id)
    VALUES ('personas', NEW.id, COALESCE(NEW.user_id, ''))
    ON CONFLICT(source_type, source_id) DO UPDATE SET user_id = excluded.user_id;
END;
CREATE TRIGGER image_refs_personas_delete AFTER DELETE ON personas
BEGIN
  DELETE FROM image_references WHERE source_type = 'personas' AND source_id = OLD.id;
  DELETE FROM image_reference_dirty WHERE source_type = 'personas' AND source_id = OLD.id;
END;

CREATE TRIGGER image_refs_presets_insert AFTER INSERT ON presets
BEGIN
  DELETE FROM image_references WHERE source_type = 'presets' AND source_id = NEW.id;
  INSERT INTO image_reference_dirty(source_type, source_id, user_id)
    VALUES ('presets', NEW.id, COALESCE(NEW.user_id, ''))
    ON CONFLICT(source_type, source_id) DO UPDATE SET user_id = excluded.user_id;
END;
CREATE TRIGGER image_refs_presets_update AFTER UPDATE OF id, user_id, metadata ON presets
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.metadata IS NOT OLD.metadata
BEGIN
  DELETE FROM image_references WHERE source_type = 'presets' AND source_id = OLD.id;
  DELETE FROM image_reference_dirty WHERE source_type = 'presets' AND source_id = OLD.id;
  INSERT INTO image_reference_dirty(source_type, source_id, user_id)
    VALUES ('presets', NEW.id, COALESCE(NEW.user_id, ''))
    ON CONFLICT(source_type, source_id) DO UPDATE SET user_id = excluded.user_id;
END;
CREATE TRIGGER image_refs_presets_delete AFTER DELETE ON presets
BEGIN
  DELETE FROM image_references WHERE source_type = 'presets' AND source_id = OLD.id;
  DELETE FROM image_reference_dirty WHERE source_type = 'presets' AND source_id = OLD.id;
END;

CREATE TRIGGER image_refs_chats_insert AFTER INSERT ON chats
BEGIN
  DELETE FROM image_references WHERE source_type = 'chats' AND source_id = NEW.id;
  INSERT INTO image_reference_dirty(source_type, source_id, user_id)
    VALUES ('chats', NEW.id, COALESCE(NEW.user_id, ''))
    ON CONFLICT(source_type, source_id) DO UPDATE SET user_id = excluded.user_id;
  INSERT INTO image_reference_dirty(source_type, source_id, user_id)
    SELECT 'messages', id, COALESCE(NEW.user_id, '') FROM messages WHERE chat_id = NEW.id
    ON CONFLICT(source_type, source_id) DO UPDATE SET user_id = excluded.user_id;
END;
CREATE TRIGGER image_refs_chats_update AFTER UPDATE OF id, user_id, metadata ON chats
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.metadata IS NOT OLD.metadata
BEGIN
  DELETE FROM image_references WHERE source_type = 'chats' AND source_id = OLD.id;
  DELETE FROM image_reference_dirty WHERE source_type = 'chats' AND source_id = OLD.id;
  INSERT INTO image_reference_dirty(source_type, source_id, user_id)
    VALUES ('chats', NEW.id, COALESCE(NEW.user_id, ''))
    ON CONFLICT(source_type, source_id) DO UPDATE SET user_id = excluded.user_id;
  INSERT INTO image_reference_dirty(source_type, source_id, user_id)
    SELECT 'messages', id, COALESCE(NEW.user_id, '') FROM messages
    WHERE chat_id IN (OLD.id, NEW.id) AND (NEW.user_id IS NOT OLD.user_id OR NEW.id IS NOT OLD.id)
    ON CONFLICT(source_type, source_id) DO UPDATE SET user_id = excluded.user_id;
END;
CREATE TRIGGER image_refs_chats_delete AFTER DELETE ON chats
BEGIN
  DELETE FROM image_references WHERE source_type = 'chats' AND source_id = OLD.id;
  DELETE FROM image_reference_dirty WHERE source_type = 'chats' AND source_id = OLD.id;
END;

CREATE TRIGGER image_refs_messages_insert AFTER INSERT ON messages
BEGIN
  DELETE FROM image_references WHERE source_type = 'messages' AND source_id = NEW.id;
  INSERT INTO image_reference_dirty(source_type, source_id, user_id)
    VALUES ('messages', NEW.id, COALESCE((SELECT user_id FROM chats WHERE id = NEW.chat_id), ''))
    ON CONFLICT(source_type, source_id) DO UPDATE SET user_id = excluded.user_id;
END;
CREATE TRIGGER image_refs_messages_update AFTER UPDATE OF id, chat_id, extra, swipes, content ON messages
WHEN NEW.id IS NOT OLD.id OR NEW.chat_id IS NOT OLD.chat_id OR NEW.extra IS NOT OLD.extra OR NEW.swipes IS NOT OLD.swipes OR NEW.content IS NOT OLD.content
BEGIN
  DELETE FROM image_references WHERE source_type = 'messages' AND source_id = OLD.id;
  DELETE FROM image_reference_dirty WHERE source_type = 'messages' AND source_id = OLD.id;
  INSERT INTO image_reference_dirty(source_type, source_id, user_id)
    VALUES ('messages', NEW.id, COALESCE((SELECT user_id FROM chats WHERE id = NEW.chat_id), ''))
    ON CONFLICT(source_type, source_id) DO UPDATE SET user_id = excluded.user_id;
END;
CREATE TRIGGER image_refs_messages_delete AFTER DELETE ON messages
BEGIN
  DELETE FROM image_references WHERE source_type = 'messages' AND source_id = OLD.id;
  DELETE FROM image_reference_dirty WHERE source_type = 'messages' AND source_id = OLD.id;
END;

CREATE TRIGGER image_refs_settings_insert AFTER INSERT ON settings
BEGIN
  DELETE FROM image_references WHERE source_type = 'settings' AND source_id = json_array(NEW.key, NEW.user_id);
  INSERT INTO image_reference_dirty(source_type, source_id, user_id)
    VALUES ('settings', json_array(NEW.key, NEW.user_id), COALESCE(NEW.user_id, ''))
    ON CONFLICT(source_type, source_id) DO UPDATE SET user_id = excluded.user_id;
END;
CREATE TRIGGER image_refs_settings_update AFTER UPDATE OF key, user_id, value ON settings
WHEN NEW.key IS NOT OLD.key OR NEW.user_id IS NOT OLD.user_id OR NEW.value IS NOT OLD.value
BEGIN
  DELETE FROM image_references WHERE source_type = 'settings' AND source_id = json_array(OLD.key, OLD.user_id);
  DELETE FROM image_reference_dirty WHERE source_type = 'settings' AND source_id = json_array(OLD.key, OLD.user_id);
  INSERT INTO image_reference_dirty(source_type, source_id, user_id)
    VALUES ('settings', json_array(NEW.key, NEW.user_id), COALESCE(NEW.user_id, ''))
    ON CONFLICT(source_type, source_id) DO UPDATE SET user_id = excluded.user_id;
END;
CREATE TRIGGER image_refs_settings_delete AFTER DELETE ON settings
BEGIN
  DELETE FROM image_references WHERE source_type = 'settings' AND source_id = json_array(OLD.key, OLD.user_id);
  DELETE FROM image_reference_dirty WHERE source_type = 'settings' AND source_id = json_array(OLD.key, OLD.user_id);
END;
