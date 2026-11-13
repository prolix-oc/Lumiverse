-- Better Auth 1.7.3+ restores the provider/account identity used before 1.7.
-- Drop only the obsolete issuer constraint: account IDs, password hashes,
-- provider tokens, user links, sessions, and desktop OAuth state stay intact.
-- ALTER TABLE avoids rebuilding the account table or disabling foreign keys.
DROP INDEX IF EXISTS account_issuer_accountId_uidx;
ALTER TABLE "account" DROP COLUMN issuer;

CREATE UNIQUE INDEX account_provider_accountId_uidx
  ON "account"(providerId, accountId);
