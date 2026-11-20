ALTER TABLE regex_scripts ADD COLUMN character_id TEXT;
CREATE INDEX IF NOT EXISTS idx_regex_scripts_character ON regex_scripts(character_id);
