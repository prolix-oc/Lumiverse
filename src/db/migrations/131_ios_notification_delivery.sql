-- Existing destinations retain their direct delivery until the app re-enrolls.
ALTER TABLE ios_push_destinations ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'direct' CHECK(delivery_mode IN ('direct', 'relay'));
ALTER TABLE ios_push_destinations ADD COLUMN relay_credential TEXT;
ALTER TABLE ios_push_destinations ADD COLUMN encryption_key TEXT;
ALTER TABLE ios_push_destinations ADD COLUMN encryption_key_id TEXT;
ALTER TABLE ios_live_activities ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'direct' CHECK(delivery_mode IN ('direct', 'relay'));
ALTER TABLE ios_live_activities ADD COLUMN relay_credential TEXT;
