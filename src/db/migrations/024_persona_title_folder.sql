-- Add title (short description) and folder (organizational grouping) to personas
ALTER TABLE personas ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE personas ADD COLUMN folder TEXT NOT NULL DEFAULT '';
