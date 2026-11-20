-- Better Auth 1.7 scopes account identity by a required issuer plus accountId.
-- Lumiverse preserves the provider-scoped identity used by 1.6: credential
-- rows use local:credential, while validated SSO slugs use a synthetic OAuth
-- namespace. SSO slugs are restricted to lowercase ASCII letters, digits, and
-- hyphens, so their encodeURIComponent representation is the slug itself.

CREATE TABLE "account_better_auth_1_7" (
  id TEXT PRIMARY KEY NOT NULL,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  issuer TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt INTEGER,
  refreshTokenExpiresAt INTEGER,
  scope TEXT,
  password TEXT,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO "account_better_auth_1_7" (
  id, accountId, providerId, issuer, userId, accessToken, refreshToken, idToken,
  accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt
)
SELECT
  id,
  CASE WHEN providerId = 'credential' THEN userId ELSE accountId END,
  providerId,
  CASE
    WHEN providerId = 'credential' THEN 'local:credential'
    WHEN providerId = 'siwe' THEN 'local:siwe'
    ELSE 'local:oauth:' || providerId
  END,
  userId, accessToken, refreshToken, idToken, accessTokenExpiresAt,
  refreshTokenExpiresAt, scope, password, createdAt, updatedAt
FROM "account";

DROP TABLE "account";
ALTER TABLE "account_better_auth_1_7" RENAME TO "account";

CREATE UNIQUE INDEX account_issuer_accountId_uidx
  ON account(issuer, accountId);
CREATE INDEX idx_account_provider_account
  ON account(providerId, accountId);
CREATE INDEX idx_account_userId ON "account"(userId);
CREATE INDEX idx_account_user_provider
  ON account(userId, providerId);
