-- Better Auth OAuth 2.1 Provider + JWT signing schema. The desktop client is
-- public (no secret), native, PKCE-only, and restricted to the read-only
-- desktop status capability configured in src/auth/index.ts.

CREATE TABLE IF NOT EXISTS "jwks" (
  id TEXT PRIMARY KEY NOT NULL,
  publicKey TEXT NOT NULL,
  privateKey TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER,
  alg TEXT,
  crv TEXT
);

CREATE TABLE IF NOT EXISTS "oauthClient" (
  id TEXT PRIMARY KEY NOT NULL,
  clientId TEXT NOT NULL UNIQUE,
  clientSecret TEXT,
  clientDiscoveryId TEXT,
  disabled INTEGER DEFAULT 0,
  skipConsent INTEGER,
  enableEndSession INTEGER,
  subjectType TEXT,
  scopes TEXT,
  clientCredentialsScopes TEXT DEFAULT '[]',
  userId TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  createdAt INTEGER,
  updatedAt INTEGER,
  name TEXT,
  uri TEXT,
  icon TEXT,
  contacts TEXT,
  tos TEXT,
  policy TEXT,
  softwareId TEXT,
  softwareVersion TEXT,
  softwareStatement TEXT,
  redirectUris TEXT NOT NULL,
  postLogoutRedirectUris TEXT,
  backchannelLogoutUri TEXT,
  backchannelLogoutSessionRequired INTEGER,
  tokenEndpointAuthMethod TEXT,
  applicationType TEXT,
  jwks TEXT,
  jwksUri TEXT,
  grantTypes TEXT,
  responseTypes TEXT,
  requirePKCE INTEGER,
  dpopBoundAccessTokens INTEGER DEFAULT 0,
  referenceId TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_client_user ON "oauthClient"(userId);

CREATE TABLE IF NOT EXISTS "oauthResource" (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  accessTokenTtl INTEGER,
  refreshTokenTtl INTEGER,
  signingAlgorithm TEXT,
  signingKeyId TEXT,
  allowedScopes TEXT,
  customClaims TEXT,
  dpopBoundAccessTokensRequired INTEGER DEFAULT 0,
  disabled INTEGER DEFAULT 0,
  createdAt INTEGER,
  updatedAt INTEGER,
  policyVersion INTEGER DEFAULT 1,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS "oauthClientResource" (
  id TEXT PRIMARY KEY NOT NULL,
  clientId TEXT NOT NULL REFERENCES "oauthClient"(clientId) ON DELETE CASCADE,
  resourceId TEXT NOT NULL REFERENCES "oauthResource"(identifier) ON DELETE CASCADE,
  metadata TEXT,
  createdAt INTEGER,
  UNIQUE(clientId, resourceId)
);

CREATE INDEX IF NOT EXISTS idx_oauth_client_resource_client ON "oauthClientResource"(clientId);
CREATE INDEX IF NOT EXISTS idx_oauth_client_resource_resource ON "oauthClientResource"(resourceId);

CREATE TABLE IF NOT EXISTS "oauthRefreshToken" (
  id TEXT PRIMARY KEY NOT NULL,
  token TEXT NOT NULL UNIQUE,
  clientId TEXT NOT NULL REFERENCES "oauthClient"(clientId) ON DELETE CASCADE,
  sessionId TEXT REFERENCES "session"(id) ON DELETE SET NULL,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  referenceId TEXT,
  authorizationCodeId TEXT,
  resources TEXT,
  requestedUserInfoClaims TEXT,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  revoked INTEGER,
  rotatedAt INTEGER,
  rotationReplayResponse TEXT,
  rotationReplayExpiresAt INTEGER,
  authTime INTEGER,
  confirmation TEXT,
  scopes TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_client ON "oauthRefreshToken"(clientId);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_session ON "oauthRefreshToken"(sessionId);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON "oauthRefreshToken"(userId);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_code ON "oauthRefreshToken"(authorizationCodeId);

CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
  id TEXT PRIMARY KEY NOT NULL,
  token TEXT UNIQUE,
  clientId TEXT NOT NULL REFERENCES "oauthClient"(clientId) ON DELETE CASCADE,
  sessionId TEXT REFERENCES "session"(id) ON DELETE SET NULL,
  userId TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  referenceId TEXT,
  authorizationCodeId TEXT,
  resources TEXT,
  requestedUserInfoClaims TEXT,
  refreshId TEXT REFERENCES "oauthRefreshToken"(id) ON DELETE CASCADE,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  revoked INTEGER,
  confirmation TEXT,
  scopes TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_access_client ON "oauthAccessToken"(clientId);
CREATE INDEX IF NOT EXISTS idx_oauth_access_session ON "oauthAccessToken"(sessionId);
CREATE INDEX IF NOT EXISTS idx_oauth_access_user ON "oauthAccessToken"(userId);
CREATE INDEX IF NOT EXISTS idx_oauth_access_code ON "oauthAccessToken"(authorizationCodeId);
CREATE INDEX IF NOT EXISTS idx_oauth_access_refresh ON "oauthAccessToken"(refreshId);

CREATE TABLE IF NOT EXISTS "oauthConsent" (
  id TEXT PRIMARY KEY NOT NULL,
  clientId TEXT NOT NULL REFERENCES "oauthClient"(clientId) ON DELETE CASCADE,
  userId TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  referenceId TEXT,
  resources TEXT,
  requestedUserInfoClaims TEXT,
  scopes TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_consent_client ON "oauthConsent"(clientId);
CREATE INDEX IF NOT EXISTS idx_oauth_consent_user ON "oauthConsent"(userId);

CREATE TABLE IF NOT EXISTS "oauthClientAssertion" (
  id TEXT PRIMARY KEY NOT NULL,
  expiresAt INTEGER NOT NULL
);

INSERT INTO "oauthClient" (
  id, clientId, disabled, skipConsent, enableEndSession, scopes,
  clientCredentialsScopes, createdAt, updatedAt, name, redirectUris,
  tokenEndpointAuthMethod, applicationType, grantTypes, responseTypes,
  requirePKCE, dpopBoundAccessTokens
) VALUES (
  'lumiverse-desktop',
  'lumiverse-desktop',
  0,
  1,
  0,
  '["openid","profile","offline_access","desktop:instance-status:read"]',
  '[]',
  unixepoch(),
  unixepoch(),
  'Lumiverse Desktop',
  '["http://127.0.0.1/callback"]',
  'none',
  'native',
  '["authorization_code","refresh_token"]',
  '["code"]',
  1,
  0
) ON CONFLICT(clientId) DO UPDATE SET
  disabled = 0,
  skipConsent = 1,
  scopes = excluded.scopes,
  redirectUris = excluded.redirectUris,
  tokenEndpointAuthMethod = 'none',
  applicationType = 'native',
  grantTypes = excluded.grantTypes,
  responseTypes = excluded.responseTypes,
  requirePKCE = 1,
  updatedAt = unixepoch();
