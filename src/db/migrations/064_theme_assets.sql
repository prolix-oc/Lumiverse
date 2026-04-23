CREATE TABLE IF NOT EXISTS theme_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bundle_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  storage_type TEXT NOT NULL,
  image_id TEXT REFERENCES images(id) ON DELETE CASCADE,
  file_name TEXT,
  original_filename TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_theme_assets_user_bundle_slug
  ON theme_assets(user_id, bundle_id, slug);

CREATE INDEX IF NOT EXISTS idx_theme_assets_user_bundle
  ON theme_assets(user_id, bundle_id);

CREATE INDEX IF NOT EXISTS idx_theme_assets_image_id
  ON theme_assets(image_id);
