CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  original_filename TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  width INTEGER,
  height INTEGER,
  has_thumbnail INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

ALTER TABLE characters ADD COLUMN image_id TEXT REFERENCES images(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_characters_image_id ON characters(image_id);

ALTER TABLE personas ADD COLUMN image_id TEXT REFERENCES images(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_personas_image_id ON personas(image_id);
