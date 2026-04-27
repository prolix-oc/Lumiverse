CREATE TABLE IF NOT EXISTS dream_weaver_messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  tool_name     TEXT,
  status        TEXT,
  supersedes_id TEXT,
  FOREIGN KEY (session_id) REFERENCES dream_weaver_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dwm_session_seq
  ON dream_weaver_messages(session_id, seq);

CREATE INDEX IF NOT EXISTS idx_dwm_session_status
  ON dream_weaver_messages(session_id, status)
  WHERE kind = 'tool_card';

ALTER TABLE dream_weaver_sessions DROP COLUMN draft;
ALTER TABLE dream_weaver_sessions DROP COLUMN soul_state;
ALTER TABLE dream_weaver_sessions DROP COLUMN world_state;
ALTER TABLE dream_weaver_sessions DROP COLUMN soul_revision;
ALTER TABLE dream_weaver_sessions DROP COLUMN world_source_revision;

UPDATE dream_weaver_sessions
   SET status = 'legacy_closed'
 WHERE status NOT IN ('finalized', 'legacy_closed')
   AND NOT EXISTS (
     SELECT 1 FROM dream_weaver_messages m WHERE m.session_id = dream_weaver_sessions.id
   );
