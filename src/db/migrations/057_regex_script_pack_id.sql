ALTER TABLE regex_scripts ADD COLUMN pack_id TEXT;
CREATE INDEX IF NOT EXISTS idx_regex_scripts_pack ON regex_scripts(pack_id);
