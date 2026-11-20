import { betterAuth } from "better-auth";
import { username, admin, bearer, genericOAuth, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { getDatabasePath, getDb } from "../db/connection";
import { env } from "../env";
import { provisionUserDirectories } from "./provision";
import { seedDefaultPreset } from "./default-preset";
import { requestCookiePolicy } from "./request-cookies";
import { getAllowedHosts, getAllowedOrigins } from "../services/trusted-hosts.service";
import { listEnabledSsoAuthConfigs } from "../services/sso-providers.service";
import {
  DESKTOP_OAUTH_CLIENT_ID,
  DESKTOP_OAUTH_CONFIGURED_ORIGIN,
  DESKTOP_OAUTH_FALLBACK_ORIGIN,
  DESKTOP_OAUTH_RESOURCE,
  DESKTOP_STATUS_SCOPE,
} from "./desktop-oauth";

// ─── Signup gate ────────────────────────────────────────────────────────
// All signups are blocked unless a valid nonce is presented.
// Nonces are single-use, short-lived (10s), cryptographically random, and
// tracked as a small set so concurrent admin-created signups don't race on a
// single slot (the previous single-slot design made one valid nonce unusable
// when two creations were in flight, and burned it on the first failure).

const CREATION_NONCE_TTL_MS = 10_000;
const MAX_OUTSTANDING_NONCES = 16;
const outstandingNonces = new Map<string, number>(); // nonce → expiry

export const CREATION_NONCE_HEADER = "x-lumiverse-creation-nonce";

export function allowCreation(): string {
  // Bound memory: drop expired entries first, then evict oldest if still full.
  const now = Date.now();
  for (const [nonce, expiry] of outstandingNonces) {
    if (now > expiry) outstandingNonces.delete(nonce);
  }
  if (outstandingNonces.size >= MAX_OUTSTANDING_NONCES) {
    const oldest = [...outstandingNonces.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) outstandingNonces.delete(oldest[0]);
  }
  const nonce = crypto.randomUUID();
  outstandingNonces.set(nonce, now + CREATION_NONCE_TTL_MS);
  return nonce;
}

function consumeNonce(expectedNonce: string | null): boolean {
  if (!expectedNonce) return false;
  const expiry = outstandingNonces.get(expectedNonce);
  if (expiry === undefined) return false;
  outstandingNonces.delete(expectedNonce); // single use
  return Date.now() <= expiry;
}

// ─── BetterAuth instance ────────────────────────────────────────────────

let ssoConfigs: ReturnType<typeof listEnabledSsoAuthConfigs> = [];
try {
  ssoConfigs = listEnabledSsoAuthConfigs();
  if (ssoConfigs.length > 0) {
    console.log(`[Auth] Registered ${ssoConfigs.length} owner-configured SSO provider${ssoConfigs.length === 1 ? "" : "s"}.`);
    for (const provider of ssoConfigs) {
      console.log(`[Auth] SSO ${provider.providerId} redirect URI: ${provider.redirectURI}`);
    }
  }
} catch (err) {
  // This can happen in tests that import auth before migrations have run.
  // In production the table exists, so surface it as a warning rather than crash.
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[Auth] Could not load SSO providers at startup: ${message}`);
}

export const auth = betterAuth({
  database: getDb(),
  baseURL: DESKTOP_OAUTH_CONFIGURED_ORIGIN ?? {
    // Better Auth resolves the request host only after it matches this startup
    // snapshot. Operator changes still need a server restart before becoming
    // OAuth issuers, which prevents an in-flight authorization from changing
    // identity underneath the client.
    allowedHosts: [...getAllowedHosts()],
    fallback: DESKTOP_OAUTH_FALLBACK_ORIGIN,
    protocol: "auto",
  },
  basePath: "/api/auth",
  secret: env.authSecret,
  hooks: { before: requestCookiePolicy },
  // Dynamic form so that hosts added via the Operator panel (Host-header
  // allowlist) are also accepted by BetterAuth's origin check. A static array
  // would freeze the env-only baseline at module init, which is why newly
  // added trusted hosts appeared to "revert" on every server restart — the
  // DB-backed hosts were loaded into the middleware's cache but never fed
  // back into BetterAuth.
  trustedOrigins: (request?: Request) => {
    if (env.trustAnyOrigin) {
      const origin = request?.headers.get("origin");
      return origin ? [origin] : [];
    }
    return [...getAllowedOrigins()];
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  // Sessions are sliding: active clients renew after one day and remain
  // signed in for seven days after their latest renewal. requireAuth forwards
  // Better Auth's replacement cookie so the browser lifetime stays aligned
  // with the renewed database row.
  session: {
    expiresIn: 7 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },
  plugins: [
    username({
      usernameNormalization: (u) => u.toLowerCase(),
    }),
    admin({
      defaultRole: "user",
      adminRoles: ["admin", "owner"],
      roles: {
        user: {} as any,
        admin: {} as any,
        owner: {} as any,
      },
    }),
    ...(ssoConfigs.length > 0
      ? [genericOAuth({
          config: ssoConfigs.map((provider) => ({
            providerId: provider.providerId,
            // Account identity is scoped by this stable provider ID. Keep
            // configured aliases distinct even when they share an OIDC issuer.
            clientId: provider.clientId,
            clientSecret: provider.clientSecret,
            discoveryUrl: provider.discoveryUrl,
            redirectURI: provider.redirectURI,
            scopes: provider.scopes,
            pkce: provider.pkce,
            disableImplicitSignUp: true,
            disableSignUp: true,
          })),
        })]
      : []),
    bearer(),
    // Leaving jwt.issuer unset makes it follow Better Auth's validated,
    // request-specific base URL (including /api/auth).
    jwt({ disableSettingJwtHeader: true }),
    oauthProvider({
      loginPage: "/login",
      consentPage: "/oauth/consent",
      scopes: ["openid", "profile", "offline_access", DESKTOP_STATUS_SCOPE],
      // Seed our server-owned resource below. The plugin now defers failed
      // seeds to the first request; Lumiverse must fail startup instead.
      cachedResources: new Set([DESKTOP_OAUTH_RESOURCE]),
      cachedTrustedClients: new Set([DESKTOP_OAUTH_CLIENT_ID]),
      // The only client is installed by migration below. Keeping registration
      // and management closed prevents ordinary accounts from minting their
      // own clients with this server-owned scope.
      allowDynamicClientRegistration: false,
      // Dynamic registration remains disabled by the master switch above.
      // This secondary flag also tells this Better Auth release to advertise
      // token_endpoint_auth_method "none" for the pre-provisioned native
      // public client.
      allowUnauthenticatedClientRegistration: true,
      clientPrivileges: () => false,
      resourcePrivileges: () => false,
      enforcePerClientResources: false,
      grantTypes: ["authorization_code", "refresh_token"],
      accessTokenExpiresIn: 5 * 60,
      refreshTokenExpiresIn: 30 * 24 * 60 * 60,
    }),
  ],
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ssoConfigs.map((provider) => provider.providerId),
      allowDifferentEmails: true,
      disableImplicitLinking: true,
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (_user, ctx) => {
          const expectedNonce = ctx?.headers?.get(CREATION_NONCE_HEADER) ?? null;
          if (!consumeNonce(expectedNonce)) {
            return false;
          }
        },
        after: async (user) => {
          // BetterAuth swallows hook exceptions, so surface directory or
          // preset-seed failures independently instead of dropping the user
          // into a half-provisioned state with no signal in the logs.
          try {
            provisionUserDirectories(user.id);
          } catch (err) {
            console.error(
              `[Auth] Failed to provision directories for user ${user.id}:`,
              err instanceof Error ? err.message : err,
            );
          }
          try {
            seedDefaultPreset(user.id, { setActive: true });
          } catch (err) {
            console.error(
              `[Auth] Failed to seed default preset for user ${user.id}:`,
              err instanceof Error ? err.message : err,
            );
          }
        },
      },
    },
  },
});

// betterAuth() starts initialization eagerly but returns before its plugins
// finish. Make module loading a readiness barrier so startup observes failures
// and completes the OAuth resource seed before enabling background DB writes.
try {
  const context = await auth.$context;
  const resource = await context.adapter.findOne({
    model: "oauthResource",
    where: [{ field: "identifier", value: DESKTOP_OAUTH_RESOURCE }],
  });
  const policy = {
    name: "Lumiverse Desktop API",
    allowedScopes: ["openid", "profile", "offline_access", DESKTOP_STATUS_SCOPE],
    accessTokenTtl: 5 * 60,
    refreshTokenTtl: 30 * 24 * 60 * 60,
    signingAlgorithm: null,
    signingKeyId: null,
    customClaims: null,
    dpopBoundAccessTokensRequired: false,
    disabled: false,
    policyVersion: 1,
    metadata: null,
    updatedAt: new Date(),
  };
  if (resource) {
    await context.adapter.update({
      model: "oauthResource",
      where: [{ field: "identifier", value: DESKTOP_OAUTH_RESOURCE }],
      update: policy,
    });
  } else {
    await context.adapter.create({
      model: "oauthResource",
      data: { ...policy, identifier: DESKTOP_OAUTH_RESOURCE, createdAt: new Date() },
    });
  }
} catch (error) {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) {
    throw new Error(
      `[Auth] Authentication initialization could not acquire the SQLite write lock for ${getDatabasePath()}. `
      + "Close other Lumiverse instances or database tools using this data directory, then restart.",
      { cause: error },
    );
  }
  throw error;
}

export type Auth = typeof auth;
