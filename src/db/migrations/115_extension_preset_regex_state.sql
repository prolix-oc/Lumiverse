-- Extension-owned preset links are lifecycle-only from this version onward.
-- Preserve the enablement that the old preset restore snapshot held before
-- activation stops managing these rows, then remove their IDs from the snapshot.

UPDATE regex_scripts AS script
SET disabled = CASE
  WHEN EXISTS (
    SELECT 1
    FROM settings AS setting
    WHERE setting.user_id = script.user_id
      AND setting.key = 'presetRegexEnabled:' || script.preset_id
      AND json_valid(setting.value)
      AND json_type(setting.value) = 'array'
  ) THEN CASE
    WHEN EXISTS (
      SELECT 1
      FROM settings AS setting,
           json_each(setting.value) AS enabled
      WHERE setting.user_id = script.user_id
        AND setting.key = 'presetRegexEnabled:' || script.preset_id
        AND json_valid(setting.value)
        AND json_type(setting.value) = 'array'
        AND enabled.type = 'text'
        AND enabled.value = script.id
    ) THEN 0
    ELSE 1
  END
  ELSE disabled
END
WHERE owner_extension_identifier IS NOT NULL
  AND preset_id IS NOT NULL;

UPDATE settings AS setting
SET value = (
  SELECT COALESCE(json_group_array(enabled.value), '[]')
  FROM json_each(setting.value) AS enabled
  WHERE enabled.type = 'text'
    AND NOT EXISTS (
      SELECT 1
      FROM regex_scripts AS script
      WHERE script.user_id = setting.user_id
        AND script.preset_id = substr(setting.key, length('presetRegexEnabled:') + 1)
        AND script.owner_extension_identifier IS NOT NULL
        AND script.id = enabled.value
    )
)
WHERE key LIKE 'presetRegexEnabled:%'
  AND json_valid(value)
  AND json_type(value) = 'array';
