-- The admin plugin has always declared this optional field. Newer Better Auth
-- validates the schema before serving auth requests, including ordinary login.
ALTER TABLE "session" ADD COLUMN impersonatedBy TEXT;
