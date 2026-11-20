CREATE TABLE weaver_cast (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,                   -- the world session
  name TEXT NOT NULL,
  hook TEXT NOT NULL DEFAULT '',              -- the one-line hook
  origin TEXT NOT NULL DEFAULT 'proposed',    -- proposed|manual
  tier TEXT NOT NULL DEFAULT 'unfleshed',     -- unfleshed|extra|named
  interview TEXT NOT NULL DEFAULT '[]',       -- JSON: Named-weave Q&A, provenance-kinded
  npc_entry_id TEXT,                          -- the NPC-book entry once fleshed
  promoted_session_id TEXT,                   -- the character session promotion opened
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (session_id) REFERENCES weaver_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_weaver_cast_session ON weaver_cast(user_id, session_id);
