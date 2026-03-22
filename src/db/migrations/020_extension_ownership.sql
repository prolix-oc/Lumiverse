ALTER TABLE extensions ADD COLUMN install_scope TEXT NOT NULL DEFAULT 'operator';
ALTER TABLE extensions ADD COLUMN installed_by_user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_extensions_install_scope ON extensions(install_scope);
CREATE INDEX IF NOT EXISTS idx_extensions_installed_by_user_id ON extensions(installed_by_user_id);

UPDATE extensions
SET install_scope = 'operator'
WHERE install_scope IS NULL OR trim(install_scope) = '';
