-- Add optional user-defined script_id for stable macro references ({{regexInstalled::id}})
ALTER TABLE regex_scripts ADD COLUMN script_id TEXT NOT NULL DEFAULT '';

-- Unique per user when non-empty (multiple empty values are fine)
CREATE UNIQUE INDEX idx_regex_scripts_script_id
  ON regex_scripts(user_id, script_id)
  WHERE script_id != '';
