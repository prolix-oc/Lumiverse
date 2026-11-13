-- Preserve pre-relay local/direct destinations and their existing payload format.
ALTER TABLE android_push_destinations ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'direct' CHECK(delivery_mode IN ('direct','relay'));
ALTER TABLE android_push_destinations ADD COLUMN package_name TEXT NOT NULL DEFAULT 'chat.lumiverse.prototype';
ALTER TABLE android_push_destinations ADD COLUMN enrollment_id TEXT;
ALTER TABLE android_push_destinations ADD COLUMN relay_url TEXT;
ALTER TABLE android_push_destinations ADD COLUMN relay_credential TEXT;
ALTER TABLE android_push_destinations ADD COLUMN encryption_key TEXT;
ALTER TABLE android_push_destinations ADD COLUMN encryption_key_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_android_push_enrollment ON android_push_destinations(enrollment_id) WHERE enrollment_id IS NOT NULL;
