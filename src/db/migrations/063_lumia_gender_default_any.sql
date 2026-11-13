ALTER TABLE lumia_items RENAME TO lumia_items_old;

CREATE TABLE lumia_items (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  author_name TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  behavior TEXT NOT NULL DEFAULT '',
  gender_identity INTEGER NOT NULL DEFAULT 3,
  version TEXT NOT NULL DEFAULT '1.0.0',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO lumia_items (
  id,
  pack_id,
  name,
  avatar_url,
  author_name,
  definition,
  personality,
  behavior,
  gender_identity,
  version,
  sort_order,
  created_at,
  updated_at
)
SELECT
  id,
  pack_id,
  name,
  avatar_url,
  author_name,
  definition,
  personality,
  behavior,
  gender_identity,
  version,
  sort_order,
  created_at,
  updated_at
FROM lumia_items_old;

DROP TABLE lumia_items_old;

CREATE INDEX IF NOT EXISTS idx_lumia_items_pack_id ON lumia_items(pack_id);
