CREATE TABLE extensions (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  author TEXT NOT NULL,
  description TEXT DEFAULT '',
  github TEXT NOT NULL,
  homepage TEXT DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  installed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata TEXT DEFAULT '{}'
);

CREATE TABLE extension_grants (
  id TEXT PRIMARY KEY,
  extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(extension_id, permission)
);
