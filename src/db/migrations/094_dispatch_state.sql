-- Per-user dispatch authority state. The opaque effective revision is derived by
-- the host service from this state plus every effective dispatch input.
CREATE TABLE IF NOT EXISTS dispatch_state (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  base_token TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  descriptor_digest TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (length(base_token) >= 32),
  CHECK (descriptor_digest = '' OR (length(descriptor_digest) = 64 AND descriptor_digest NOT GLOB '*[^0-9a-f]*'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_state_base_token
  ON dispatch_state(base_token);

CREATE INDEX IF NOT EXISTS idx_dispatch_state_updated
  ON dispatch_state(updated_at DESC);

-- Existing users receive one state row. This is safe to replay after a partial
-- deployment or when a caller has already initialized its row.
INSERT OR IGNORE INTO dispatch_state (
  user_id,
  base_token,
  generation,
  revision,
  descriptor_digest,
  created_at,
  updated_at
)
SELECT
  id,
  lower(hex(randomblob(16))),
  1,
  0,
  '',
  unixepoch(),
  unixepoch()
FROM "user";
