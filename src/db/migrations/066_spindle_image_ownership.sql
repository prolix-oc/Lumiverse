ALTER TABLE images ADD COLUMN owner_extension_identifier TEXT;
ALTER TABLE images ADD COLUMN owner_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL;
ALTER TABLE images ADD COLUMN owner_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_images_user_owner_extension
  ON images(user_id, owner_extension_identifier, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_images_user_owner_character
  ON images(user_id, owner_character_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_images_user_owner_chat
  ON images(user_id, owner_chat_id, created_at DESC);
