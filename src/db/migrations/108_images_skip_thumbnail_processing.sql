ALTER TABLE images
  ADD COLUMN skip_thumbnail_processing INTEGER NOT NULL DEFAULT 0;
