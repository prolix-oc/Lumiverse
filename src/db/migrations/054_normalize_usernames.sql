-- Normalize existing usernames to lowercase for case-insensitive login.
-- Preserves original casing in displayUsername for display purposes.

UPDATE "user"
SET displayUsername = CASE WHEN displayUsername IS NULL THEN username ELSE displayUsername END,
    username = LOWER(username)
WHERE username != LOWER(username);
