-- SillyTavern migration deduplicates cards by their source filename stored in
-- extensions. Without this expression index every lookup scans the user's
-- growing character library, making a large import quadratic.
CREATE INDEX IF NOT EXISTS idx_characters_user_source_filename
  ON characters(user_id, json_extract(extensions, '$._lumiverse_source_filename'));
