ALTER TABLE characters ADD COLUMN library_scope TEXT NOT NULL DEFAULT 'mine' CHECK(library_scope IN ('mine', 'shared'));

CREATE INDEX idx_characters_user_library_scope
  ON characters(user_id, library_scope);

CREATE INDEX idx_characters_user_library_scope_updated
  ON characters(user_id, library_scope, updated_at DESC);
