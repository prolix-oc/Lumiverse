-- Add branch tracking to extensions
ALTER TABLE extensions ADD COLUMN branch TEXT DEFAULT NULL;
