-- Add user_id to message_breakdowns for per-user scoping
ALTER TABLE message_breakdowns ADD COLUMN user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;

-- Backfill user_id from the chats table
UPDATE message_breakdowns
SET user_id = (
  SELECT c.user_id FROM chats c WHERE c.id = message_breakdowns.chat_id
)
WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_message_breakdowns_user ON message_breakdowns(user_id);
