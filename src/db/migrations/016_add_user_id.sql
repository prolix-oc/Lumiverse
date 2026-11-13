-- Add user_id column to all user-scoped content tables

ALTER TABLE characters ADD COLUMN user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_characters_user_id ON characters(user_id);

ALTER TABLE chats ADD COLUMN user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_chats_user_id ON chats(user_id);

ALTER TABLE personas ADD COLUMN user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_personas_user_id ON personas(user_id);

ALTER TABLE world_books ADD COLUMN user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_world_books_user_id ON world_books(user_id);

ALTER TABLE presets ADD COLUMN user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_presets_user_id ON presets(user_id);

ALTER TABLE connection_profiles ADD COLUMN user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_connection_profiles_user_id ON connection_profiles(user_id);

ALTER TABLE images ADD COLUMN user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_images_user_id ON images(user_id);

ALTER TABLE secrets ADD COLUMN user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_secrets_user_id ON secrets(user_id);

ALTER TABLE settings ADD COLUMN user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_settings_user_id ON settings(user_id);
