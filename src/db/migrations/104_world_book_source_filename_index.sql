-- Keep SillyTavern world-book rerun identity lookups index-backed.
CREATE INDEX IF NOT EXISTS idx_world_books_user_source_filename
  ON world_books(user_id, json_extract(metadata, '$._lumiverse_source_filename'));
