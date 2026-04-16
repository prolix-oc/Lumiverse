CREATE TABLE IF NOT EXISTS dream_weaver_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),

  -- Input
  dream_text TEXT NOT NULL,
  tone TEXT,
  constraints TEXT,
  dislikes TEXT,
  persona_id TEXT,
  connection_id TEXT,

  -- Generated draft (DW_DRAFT_V1 JSON)
  draft TEXT,

  -- Status
  status TEXT DEFAULT 'draft', -- draft, generating, complete, error

  -- Output
  character_id TEXT,

  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL,
  FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_dw_sessions_user ON dream_weaver_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dw_sessions_status ON dream_weaver_sessions(user_id, status);
