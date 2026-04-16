ALTER TABLE regex_scripts ADD COLUMN preset_id TEXT;
CREATE INDEX IF NOT EXISTS idx_regex_scripts_preset ON regex_scripts(preset_id);
