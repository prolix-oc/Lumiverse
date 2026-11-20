ALTER TABLE weaver_bible ADD COLUMN gate TEXT NOT NULL DEFAULT '{}';        -- JSON: WeaverGateVerdict
ALTER TABLE weaver_bible ADD COLUMN token_usage TEXT NOT NULL DEFAULT '{}'; -- JSON: cumulative usage
ALTER TABLE weaver_bible ADD COLUMN updated_at INTEGER;
