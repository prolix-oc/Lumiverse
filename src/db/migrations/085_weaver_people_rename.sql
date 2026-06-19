ALTER TABLE weaver_cast RENAME TO weaver_people;
DROP INDEX IF EXISTS idx_weaver_cast_session;
CREATE INDEX IF NOT EXISTS idx_weaver_people_session ON weaver_people(user_id, session_id);
