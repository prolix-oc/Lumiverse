-- Lookup support for SSO provider account links stored in BetterAuth's account table.

CREATE INDEX IF NOT EXISTS idx_account_provider_account
  ON account(providerId, accountId);

CREATE INDEX IF NOT EXISTS idx_account_user_provider
  ON account(userId, providerId);
