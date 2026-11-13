-- Performance indexes for paginated list endpoints
CREATE INDEX IF NOT EXISTS idx_characters_user_updated ON characters(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_user_updated ON chats(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_personas_user_updated ON personas(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_presets_user_updated ON presets(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_connection_profiles_user_updated ON connection_profiles(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_packs_user_updated ON packs(user_id, updated_at DESC);

-- Covering index for getLastAssistantMessage()
CREATE INDEX IF NOT EXISTS idx_messages_last_assistant ON messages(chat_id, is_user, index_in_chat DESC);

-- Chats filtered by character
CREATE INDEX IF NOT EXISTS idx_chats_user_character ON chats(user_id, character_id, updated_at DESC);

-- UPSERT support for settings and secrets
CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_key_user ON settings(key, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_secrets_key_user ON secrets(key, user_id);
