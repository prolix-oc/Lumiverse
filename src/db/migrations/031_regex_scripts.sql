CREATE TABLE IF NOT EXISTS regex_scripts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  find_regex TEXT NOT NULL,
  replace_string TEXT NOT NULL DEFAULT '',
  flags TEXT NOT NULL DEFAULT 'gi',
  placement TEXT NOT NULL DEFAULT '["ai_output"]',
  scope TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT,
  target TEXT NOT NULL DEFAULT 'response',
  min_depth INTEGER,
  max_depth INTEGER,
  trim_strings TEXT NOT NULL DEFAULT '[]',
  run_on_edit INTEGER NOT NULL DEFAULT 0,
  substitute_macros TEXT NOT NULL DEFAULT 'none',
  disabled INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_regex_scripts_user_sort
  ON regex_scripts(user_id, sort_order ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_regex_scripts_scope
  ON regex_scripts(user_id, scope, scope_id);
