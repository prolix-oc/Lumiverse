-- Crash leftovers for deferred thumbnail work. Rows are inserted when a job
-- is queued and deleted when it finishes. Startup never auto-runs them.
CREATE TABLE IF NOT EXISTS image_processing_queue (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
  UNIQUE (image_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_image_processing_queue_user_created
  ON image_processing_queue(user_id, created_at);
