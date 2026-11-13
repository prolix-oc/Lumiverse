DROP TABLE IF EXISTS weaver_work_log;
DROP TABLE IF EXISTS weaver_trials;
DROP TABLE IF EXISTS weaver_proposals;
DROP TABLE IF EXISTS weaver_project_state;
DROP TABLE IF EXISTS weaver_projects;
DROP TABLE IF EXISTS weaver_package_drafts;
DROP TABLE IF EXISTS weaver_sources;
DROP TABLE IF EXISTS weaver_messages;

DROP TABLE IF EXISTS weaver_fields;
DROP TABLE IF EXISTS weaver_bible;
DROP TABLE IF EXISTS weaver_taste;
DROP TABLE IF EXISTS weaver_interview_turns;
DROP TABLE IF EXISTS weaver_extraction;
DROP TABLE IF EXISTS weaver_sessions;

CREATE TABLE weaver_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_number INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  seed_type TEXT NOT NULL DEFAULT 'dream',
  seed_text TEXT NOT NULL DEFAULT '',
  seed_provenance TEXT NOT NULL DEFAULT '{}', -- JSON

  -- Studio flow
  stage TEXT NOT NULL DEFAULT 'dream',        -- dream|readback|interview|bible|render|finalize
  status TEXT NOT NULL DEFAULT 'draft',        -- draft|interviewing|bible|rendering|finalized

  -- Generation context
  connection_id TEXT,
  model TEXT,
  persona_id TEXT,

  -- Output (set on finalize)
  character_id TEXT,
  launch_chat_id TEXT,

  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL,
  FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_weaver_sessions_user ON weaver_sessions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_weaver_sessions_status ON weaver_sessions(user_id, status);

CREATE TABLE weaver_extraction (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  committed_facts TEXT NOT NULL DEFAULT '[]', -- JSON, slot-tagged
  gaps TEXT NOT NULL DEFAULT '[]',            -- JSON
  edited_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (session_id) REFERENCES weaver_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE weaver_interview_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  slot TEXT NOT NULL,
  axis TEXT NOT NULL DEFAULT '{}',            -- JSON: the spread offered
  response_kind TEXT,                          -- pick|blend|redirect|typed|inferred
  response TEXT NOT NULL DEFAULT '{}',         -- JSON
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (session_id) REFERENCES weaver_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_weaver_turns_session ON weaver_interview_turns(session_id, seq);

CREATE TABLE weaver_taste (
  user_id TEXT PRIMARY KEY,
  profile TEXT NOT NULL DEFAULT '{}',          -- JSON
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE weaver_bible (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  spine TEXT NOT NULL DEFAULT '{}',            -- JSON: VEJA + links + contradiction + stance
  status TEXT NOT NULL DEFAULT 'pending',      -- pending|gated|flagged
  gated_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES weaver_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE weaver_fields (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',      -- pending|streaming|passed|flagged|stale|manually_edited
  provenance TEXT NOT NULL DEFAULT '{}',       -- JSON: link back to bible
  token_usage TEXT NOT NULL DEFAULT '{}',      -- JSON
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (session_id) REFERENCES weaver_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_weaver_fields_session ON weaver_fields(session_id, field_name);
