-- Steers often contain world-specific names and facts. Keep them with the
-- Weaver session that established them instead of reusing them user-wide.
ALTER TABLE weaver_sessions
ADD COLUMN taste_profile TEXT NOT NULL DEFAULT '{}';
