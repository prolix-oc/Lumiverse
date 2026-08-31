ALTER TABLE regex_scripts ADD COLUMN validation_error_code TEXT;

CREATE INDEX IF NOT EXISTS idx_regex_scripts_validation_error
  ON regex_scripts(user_id, validation_error_code)
  WHERE validation_error_code IS NOT NULL;

-- SQLite cannot compile JavaScript regular expressions. These guards still
-- reject storage-level size/JSON violations immediately; the service performs
-- the complete validator (including RegExp compilation) before execution and
-- lazily quarantines any legacy row that predates this migration.
CREATE TRIGGER IF NOT EXISTS trg_regex_scripts_validation_insert
AFTER INSERT ON regex_scripts
WHEN NEW.validation_error_code IS NULL
  AND (
    length(CAST(NEW.find_regex AS BLOB)) > 65536
    OR length(CAST(NEW.replace_string AS BLOB)) > 131072
    OR json_valid(NEW.trim_strings) = 0
    OR EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(NEW.trim_strings) THEN NEW.trim_strings ELSE '[]' END)
      WHERE type != 'text'
        OR length(CAST(value AS BLOB)) = 0
        OR length(CAST(value AS BLOB)) > 512
    )
  )
BEGIN
  UPDATE regex_scripts
  SET disabled = 1,
      validation_error_code = CASE
        WHEN length(CAST(NEW.find_regex AS BLOB)) > 65536 THEN 'pattern_too_large'
        WHEN length(CAST(NEW.replace_string AS BLOB)) > 131072 THEN 'replacement_too_large'
        WHEN json_valid(NEW.trim_strings) = 0 THEN 'invalid_input'
        ELSE 'trim_string_invalid'
      END
  WHERE id = NEW.id AND user_id = NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_regex_scripts_validation_update
AFTER UPDATE OF find_regex, replace_string, trim_strings, actions, flags,
  placement, scope, scope_id, target, owner_extension_identifier
ON regex_scripts
WHEN NEW.validation_error_code IS NULL
  AND (
    length(CAST(NEW.find_regex AS BLOB)) > 65536
    OR length(CAST(NEW.replace_string AS BLOB)) > 131072
    OR json_valid(NEW.trim_strings) = 0
    OR EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(NEW.trim_strings) THEN NEW.trim_strings ELSE '[]' END)
      WHERE type != 'text'
        OR length(CAST(value AS BLOB)) = 0
        OR length(CAST(value AS BLOB)) > 512
    )
  )
BEGIN
  UPDATE regex_scripts
  SET disabled = 1,
      validation_error_code = CASE
        WHEN length(CAST(NEW.find_regex AS BLOB)) > 65536 THEN 'pattern_too_large'
        WHEN length(CAST(NEW.replace_string AS BLOB)) > 131072 THEN 'replacement_too_large'
        WHEN json_valid(NEW.trim_strings) = 0 THEN 'invalid_input'
        ELSE 'trim_string_invalid'
      END
  WHERE id = NEW.id AND user_id = NEW.user_id;
END;
