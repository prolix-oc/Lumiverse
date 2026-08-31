-- Keep authored cognition template identity separate from the turn-scoped
-- operational task identifier. NULL is reserved for ordinary workspace tasks.
ALTER TABLE agent_workspace_tasks
  ADD COLUMN cognition_template_id TEXT
    CHECK(cognition_template_id IS NULL OR length(cognition_template_id) BETWEEN 1 AND 128);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workspace_tasks_cognition_template
  ON agent_workspace_tasks(workspace_id, cognition_template_id)
  WHERE cognition_template_id IS NOT NULL;
