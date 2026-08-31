-- Public image-generation responses require server-owned provenance. Archive
-- rows never carry this authority; imports explicitly clear the column.
ALTER TABLE images
  ADD COLUMN public_provenance TEXT
    CHECK(public_provenance IS NULL OR public_provenance = 'server_image_generation_v1');
