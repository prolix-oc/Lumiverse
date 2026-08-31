ALTER TABLE persistent_workspace_turn_sessions
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0);
