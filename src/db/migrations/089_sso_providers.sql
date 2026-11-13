-- Owner-managed OpenID Connect providers for instance SSO.

CREATE TABLE IF NOT EXISTS sso_providers (
  id                      TEXT PRIMARY KEY,
  provider_kind           TEXT NOT NULL, -- 'authelia' | 'authentik' | 'keycloak' | 'custom_oidc'
  name                    TEXT NOT NULL,
  slug                    TEXT NOT NULL UNIQUE,
  enabled                 INTEGER NOT NULL DEFAULT 0,
  issuer_url              TEXT NOT NULL DEFAULT '',
  discovery_url           TEXT NOT NULL DEFAULT '',
  client_id               TEXT NOT NULL DEFAULT '',
  encrypted_client_secret TEXT,
  client_secret_iv        TEXT,
  client_secret_tag       TEXT,
  scopes                  TEXT NOT NULL DEFAULT '["openid","profile","email"]',
  pkce                    INTEGER NOT NULL DEFAULT 1,
  allow_signup            INTEGER NOT NULL DEFAULT 0,
  metadata                TEXT NOT NULL DEFAULT '{}',
  created_at              INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at              INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_sso_providers_enabled ON sso_providers(enabled);
