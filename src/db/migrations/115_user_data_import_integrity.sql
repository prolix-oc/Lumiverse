-- Durable control plane for recoverable .lvbak imports.
-- Canonical user data is never written until a job has a complete validated
-- staging database and every present file has been installed under its fence.

CREATE TABLE IF NOT EXISTS user_data_imports (
  job_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  archive_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  archive_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (length(manifest_json) <= 16777216),
  staging_path TEXT NOT NULL CHECK (length(staging_path) <= 4096),
  staging_db_path TEXT NOT NULL CHECK (length(staging_db_path) <= 4096),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'validating', 'awaiting_ticket', 'installing', 'ready',
    'committing', 'committed', 'failed', 'cancelled',
    'cancelling', 'cleanup_pending'
  )),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at INTEGER,
  finished_at INTEGER,
  stable_error_code TEXT,
  stable_error TEXT CHECK (stable_error IS NULL OR length(stable_error) <= 4096),
  summary_json TEXT CHECK (summary_json IS NULL OR length(summary_json) <= 16777216)
);

CREATE INDEX IF NOT EXISTS idx_user_data_imports_user_created
  ON user_data_imports(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_data_imports_lease
  ON user_data_imports(state, lease_expires_at);

-- At most one import may be in-flight for an account. Terminal rows remain as
-- the durable idempotency/audit record and do not consume the admission slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_data_imports_one_nonterminal_user
  ON user_data_imports(user_id)
  WHERE state NOT IN ('committed', 'failed', 'cancelled');

CREATE TABLE IF NOT EXISTS user_data_import_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES user_data_imports(job_id) ON DELETE CASCADE,
  archive_path TEXT NOT NULL CHECK (length(archive_path) <= 4096),
  kind TEXT NOT NULL CHECK (kind IN ('file', 'secret', 'vector')),
  staged_path TEXT NOT NULL CHECK (length(staged_path) <= 4096),
  final_path TEXT NOT NULL CHECK (length(final_path) <= 4096),
  sha256 TEXT NOT NULL CHECK (sha256 GLOB '[0-9a-fA-F]*' AND length(sha256) = 64),
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0 AND byte_count <= 8589934592),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  install_token TEXT NOT NULL,
  staged_identity TEXT NOT NULL CHECK (length(staged_identity) <= 4096),
  observed_final_identity TEXT CHECK (observed_final_identity IS NULL OR length(observed_final_identity) <= 4096),
  install_state TEXT NOT NULL CHECK (install_state IN ('pending', 'preexisting', 'created', 'installed', 'removed', 'skipped')),
  omission_policy TEXT CHECK (omission_policy IS NULL OR omission_policy IN ('null_reference', 'skip_dependent_row', 'preserve_absent')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(job_id, archive_path),
  UNIQUE(job_id, install_token)
);

CREATE INDEX IF NOT EXISTS idx_user_data_import_files_job_state
  ON user_data_import_files(job_id, install_state);

CREATE TABLE IF NOT EXISTS user_data_import_receipts (
  receipt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES user_data_imports(job_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  archive_digest TEXT NOT NULL CHECK (length(archive_digest) = 64),
  summary_json TEXT NOT NULL CHECK (length(summary_json) <= 16777216),
  committed_at INTEGER NOT NULL,
  UNIQUE(user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_user_data_import_receipts_user
  ON user_data_import_receipts(user_id, committed_at DESC);
