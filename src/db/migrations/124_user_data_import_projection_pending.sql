-- Keep derived-vector recovery durable after an import's staging tree is removed.
-- The detailed cursor remains in the receipt summary; this flag is the
-- bounded startup-recovery selector and is cleared only after projection
-- reconciliation confirms every source page is complete.
ALTER TABLE user_data_imports
  ADD COLUMN projection_pending INTEGER NOT NULL DEFAULT 0
  CHECK (projection_pending IN (0, 1));

UPDATE user_data_imports AS i
   SET projection_pending = CASE
     WHEN json_valid(COALESCE(
       (SELECT r.summary_json
          FROM user_data_import_receipts AS r
         WHERE r.job_id = i.job_id),
       i.summary_json
     )) = 1
       AND json_extract(COALESCE(
         (SELECT r.summary_json
            FROM user_data_import_receipts AS r
           WHERE r.job_id = i.job_id),
         i.summary_json
       ), '$.vectors.projectionPending') = 1
     THEN 1
     ELSE 0
   END
 WHERE i.summary_json IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM user_data_import_receipts AS r WHERE r.job_id = i.job_id
    );

CREATE INDEX IF NOT EXISTS idx_user_data_imports_projection_pending
  ON user_data_imports(projection_pending, updated_at)
  WHERE state = 'committed' AND projection_pending = 1;
