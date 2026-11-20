CREATE TABLE IF NOT EXISTS deletion_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('accepted', 'completed', 'failed', 'unknown')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deletion_operations_entity ON deletion_operations(user_id, entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_deletion_operations_updated ON deletion_operations(status, updated_at);
