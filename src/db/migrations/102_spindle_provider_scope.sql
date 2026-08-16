-- Scope existing extension grants so provider identity can be host-derived
-- as system | operator:<id> | user:<authenticatedSubject>.
ALTER TABLE extension_grants ADD COLUMN scope TEXT NOT NULL DEFAULT 'system';

UPDATE extension_grants
SET scope = COALESCE((
  SELECT CASE
    WHEN e.install_scope = 'user'
      AND e.installed_by_user_id IS NOT NULL
      AND trim(e.installed_by_user_id) != ''
      THEN 'user:' || e.installed_by_user_id
    WHEN e.install_scope = 'operator'
      AND e.installed_by_user_id IS NOT NULL
      AND trim(e.installed_by_user_id) != ''
      THEN 'operator:' || e.installed_by_user_id
    ELSE 'system'
  END
  FROM extensions e
  WHERE e.id = extension_grants.extension_id
), 'system');

CREATE INDEX IF NOT EXISTS idx_extension_grants_scope
  ON extension_grants(extension_id, scope);
