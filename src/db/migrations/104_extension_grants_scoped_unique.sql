-- Scoped extension grants: replace UNIQUE(extension_id, permission) with
-- UNIQUE(extension_id, permission, scope) via table rebuild so the same
-- permission can be granted to one extension across distinct scopes
-- (system | operator:<id> | user:<subject>).

CREATE TABLE extension_grants_new (
  id TEXT PRIMARY KEY,
  extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  scope TEXT NOT NULL DEFAULT 'system',
  UNIQUE(extension_id, permission, scope)
);

INSERT INTO extension_grants_new (id, extension_id, permission, granted_at, scope)
SELECT id, extension_id, permission, granted_at, COALESCE(scope, 'system')
FROM extension_grants;

DROP TABLE extension_grants;
ALTER TABLE extension_grants_new RENAME TO extension_grants;

CREATE INDEX IF NOT EXISTS idx_extension_grants_scope
  ON extension_grants(extension_id, scope);
