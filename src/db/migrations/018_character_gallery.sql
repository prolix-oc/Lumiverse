CREATE TABLE IF NOT EXISTS character_gallery (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  image_id      TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  caption       TEXT DEFAULT '',
  sort_order    INTEGER DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_character_gallery_lookup
  ON character_gallery(user_id, character_id);
