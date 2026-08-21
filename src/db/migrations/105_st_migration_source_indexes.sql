-- Keep SillyTavern chat and persona rerun identity lookups index-backed.
CREATE INDEX IF NOT EXISTS idx_chats_user_source_filename
  ON chats(user_id, json_extract(metadata, '$._lumiverse_source_filename'));

CREATE INDEX IF NOT EXISTS idx_personas_user_source_filename
  ON personas(user_id, json_extract(metadata, '$._lumiverse_source_filename'));
