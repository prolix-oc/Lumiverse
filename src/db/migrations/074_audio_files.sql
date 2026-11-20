-- Persistent audio storage for TTS-generated message audio. A separate table
-- from `images` so the on-disk layout and serving path stay specialized
-- (`data/audio/` + `/api/v1/audio/:id`) without polluting the image pipeline
-- (sharp metadata, thumbnail tiers, gallery references, etc.). Referenced
-- from message `extra.attachments[]` via the polymorphic `image_id` field
-- (already documented as a generic blob FK in src/types/message.ts).

CREATE TABLE audio_files (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  original_filename TEXT NOT NULL DEFAULT '',
  mime_type     TEXT NOT NULL DEFAULT '',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_audio_files_user ON audio_files(user_id);
