ALTER TABLE regex_scripts ADD COLUMN owner_extension_identifier TEXT;

CREATE INDEX IF NOT EXISTS idx_regex_scripts_extension_owner
  ON regex_scripts(user_id, owner_extension_identifier)
  WHERE owner_extension_identifier IS NOT NULL;
