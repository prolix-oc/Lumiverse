CREATE TABLE IF NOT EXISTS agent_runtime_repair_acknowledgements (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
  preset_revision TEXT NOT NULL CHECK(length(preset_revision) BETWEEN 1 AND 512),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 512),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  acknowledged_at INTEGER NOT NULL CHECK(acknowledged_at >= 0),
  PRIMARY KEY (user_id, preset_id, preset_revision, reason_code)
);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_repair_ack_preset_revision
  ON agent_runtime_repair_acknowledgements(user_id, preset_id, preset_revision, acknowledged_at DESC);
