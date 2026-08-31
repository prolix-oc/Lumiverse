-- Corrective integrity gates for archive, workspace, and publication digest ledgers.
--
-- Migrations 104 and 106 are already present in deployed databases, so
-- their permissive historical GLOB checks cannot be rewritten in place. These
-- triggers provide the same fail-closed invariant for existing schemas while
-- keeping old rows untouched: every SHA-256 value is exactly 64 lowercase
-- hexadecimal bytes. A character class in SQLite GLOB must be paired with a
-- negated whole-string check; `[0-9a-f]*` alone only constrains the first byte.

CREATE TRIGGER IF NOT EXISTS trg_user_data_imports_archive_digest_insert
BEFORE INSERT ON user_data_imports
WHEN typeof(NEW.archive_digest) <> 'text'
  OR length(NEW.archive_digest) <> 64
  OR lower(NEW.archive_digest) <> NEW.archive_digest
  OR NEW.archive_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'archive_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_data_imports_archive_digest_update
BEFORE UPDATE OF archive_digest ON user_data_imports
WHEN typeof(NEW.archive_digest) <> 'text'
  OR length(NEW.archive_digest) <> 64
  OR lower(NEW.archive_digest) <> NEW.archive_digest
  OR NEW.archive_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'archive_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_data_import_files_sha256_insert
BEFORE INSERT ON user_data_import_files
WHEN typeof(NEW.sha256) <> 'text'
  OR length(NEW.sha256) <> 64
  OR lower(NEW.sha256) <> NEW.sha256
  OR NEW.sha256 GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'sha256 must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_data_import_files_sha256_update
BEFORE UPDATE OF sha256 ON user_data_import_files
WHEN typeof(NEW.sha256) <> 'text'
  OR length(NEW.sha256) <> 64
  OR lower(NEW.sha256) <> NEW.sha256
  OR NEW.sha256 GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'sha256 must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_data_import_receipts_archive_digest_insert
BEFORE INSERT ON user_data_import_receipts
WHEN typeof(NEW.archive_digest) <> 'text'
  OR length(NEW.archive_digest) <> 64
  OR lower(NEW.archive_digest) <> NEW.archive_digest
  OR NEW.archive_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'archive_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_data_import_receipts_archive_digest_update
BEFORE UPDATE OF archive_digest ON user_data_import_receipts
WHEN typeof(NEW.archive_digest) <> 'text'
  OR length(NEW.archive_digest) <> 64
  OR lower(NEW.archive_digest) <> NEW.archive_digest
  OR NEW.archive_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'archive_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_workspace_records_digest_insert
BEFORE INSERT ON agent_workspace_records
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_workspace_records_digest_update
BEFORE UPDATE OF digest ON agent_workspace_records
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_workspace_submissions_result_digest_insert
BEFORE INSERT ON agent_workspace_submissions
WHEN typeof(NEW.result_digest) <> 'text'
  OR length(NEW.result_digest) <> 64
  OR lower(NEW.result_digest) <> NEW.result_digest
  OR NEW.result_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'result_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_workspace_submissions_result_digest_update
BEFORE UPDATE OF result_digest ON agent_workspace_submissions
WHEN typeof(NEW.result_digest) <> 'text'
  OR length(NEW.result_digest) <> 64
  OR lower(NEW.result_digest) <> NEW.result_digest
  OR NEW.result_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'result_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_artifact_blobs_digest_insert
BEFORE INSERT ON agent_artifact_blobs
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_artifact_blobs_digest_update
BEFORE UPDATE OF digest ON agent_artifact_blobs
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_artifact_blob_journal_blob_digest_insert
BEFORE INSERT ON agent_artifact_blob_journal
WHEN typeof(NEW.blob_digest) <> 'text'
  OR length(NEW.blob_digest) <> 64
  OR lower(NEW.blob_digest) <> NEW.blob_digest
  OR NEW.blob_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'blob_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_artifact_blob_journal_blob_digest_update
BEFORE UPDATE OF blob_digest ON agent_artifact_blob_journal
WHEN typeof(NEW.blob_digest) <> 'text'
  OR length(NEW.blob_digest) <> 64
  OR lower(NEW.blob_digest) <> NEW.blob_digest
  OR NEW.blob_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'blob_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_artifact_blob_journal_digest_insert
BEFORE INSERT ON agent_artifact_blob_journal
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_artifact_blob_journal_digest_update
BEFORE UPDATE OF digest ON agent_artifact_blob_journal
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_workspace_artifacts_blob_digest_insert
BEFORE INSERT ON agent_workspace_artifacts
WHEN typeof(NEW.blob_digest) <> 'text'
  OR length(NEW.blob_digest) <> 64
  OR lower(NEW.blob_digest) <> NEW.blob_digest
  OR NEW.blob_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'blob_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_workspace_artifacts_blob_digest_update
BEFORE UPDATE OF blob_digest ON agent_workspace_artifacts
WHEN typeof(NEW.blob_digest) <> 'text'
  OR length(NEW.blob_digest) <> 64
  OR lower(NEW.blob_digest) <> NEW.blob_digest
  OR NEW.blob_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'blob_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_turn_commit_receipts_summary_digest_insert
BEFORE INSERT ON agent_turn_commit_receipts
WHEN typeof(NEW.summary_digest) <> 'text'
  OR length(NEW.summary_digest) <> 64
  OR lower(NEW.summary_digest) <> NEW.summary_digest
  OR NEW.summary_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'summary_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_turn_commit_receipts_summary_digest_update
BEFORE UPDATE OF summary_digest ON agent_turn_commit_receipts
WHEN typeof(NEW.summary_digest) <> 'text'
  OR length(NEW.summary_digest) <> 64
  OR lower(NEW.summary_digest) <> NEW.summary_digest
  OR NEW.summary_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'summary_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_published_workspace_artifacts_blob_digest_insert
BEFORE INSERT ON agent_published_workspace_artifacts
WHEN typeof(NEW.blob_digest) <> 'text'
  OR length(NEW.blob_digest) <> 64
  OR lower(NEW.blob_digest) <> NEW.blob_digest
  OR NEW.blob_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'blob_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_published_workspace_artifacts_blob_digest_update
BEFORE UPDATE OF blob_digest ON agent_published_workspace_artifacts
WHEN typeof(NEW.blob_digest) <> 'text'
  OR length(NEW.blob_digest) <> 64
  OR lower(NEW.blob_digest) <> NEW.blob_digest
  OR NEW.blob_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'blob_digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_published_workspace_artifacts_digest_insert
BEFORE INSERT ON agent_published_workspace_artifacts
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_published_workspace_artifacts_digest_update
BEFORE UPDATE OF digest ON agent_published_workspace_artifacts
WHEN typeof(NEW.digest) <> 'text'
  OR length(NEW.digest) <> 64
  OR lower(NEW.digest) <> NEW.digest
  OR NEW.digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'digest must be 64 lowercase hexadecimal characters');
END;

