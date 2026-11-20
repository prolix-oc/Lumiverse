-- Account-scoped, resumable bundle jobs. Archive paths are derived from job IDs.
CREATE TABLE cl_migration_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  preview TEXT NOT NULL,
  progress TEXT NOT NULL DEFAULT '{}',
  report TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_cl_migration_jobs_user ON cl_migration_jobs(user_id, created_at DESC);

CREATE TABLE cl_migration_items (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, source_id, kind, source_key)
);
