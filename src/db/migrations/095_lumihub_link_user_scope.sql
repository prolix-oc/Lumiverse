-- LumiHub links belong to the user who authorized them. Backfill the legacy
-- instance-wide row to the first-created user (the historical install target).
ALTER TABLE lumihub_link ADD COLUMN user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;

UPDATE lumihub_link
SET user_id = (SELECT id FROM "user" ORDER BY createdAt ASC LIMIT 1)
WHERE user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lumihub_link_user_id
ON lumihub_link(user_id);
