import { betterAuth } from "better-auth";
import { username, admin, bearer, genericOAuth } from "better-auth/plugins";
import { getDb } from "../db/connection";
import { env } from "../env";
import { provisionUserDirectories } from "./provision";
import { seedDefaultPreset } from "./default-preset";
import { getAllowedOrigins } from "../services/trusted-hosts.service";
import { listEnabledSsoAuthConfigs } from "../services/sso-providers.service";

// ─── Signup gate ────────────────────────────────────────────────────────
// All signups are blocked unless a valid nonce is presented.
// Nonces are single-use, short-lived (10s), and cryptographically random.

let creationNonce: string | null = null;
let creationNonceExpiry = 0;

export const CREATION_NONCE_HEADER = "x-lumiverse-creation-nonce";

export function allowCreation(): string {
  creationNonce = crypto.randomUUID();
  creationNonceExpiry = Date.now() + 10_000;
  return creationNonce;
}

function consumeNonce(expectedNonce: string | null): boolean {
  if (!creationNonce) return false;
  if (Date.now() > creationNonceExpiry) {
    creationNonce = null;
    return false;
  }
  if (creationNonce !== expectedNonce) return false;
  creationNonce = null; // single use
  return true;
}

// ─── BetterAuth instance ────────────────────────────────────────────────

const ssoConfigs = listEnabledSsoAuthConfigs();
if (ssoConfigs.length > 0) {
  console.log(`[Auth] Registered ${ssoConfigs.length} owner-configured SSO provider${ssoConfigs.length === 1 ? "" : "s"}.`);
  for (const provider of ssoConfigs) {
    console.log(`[Auth] SSO ${provider.providerId} redirect URI: ${provider.redirectURI}`);
  }
}

export const auth = betterAuth({
  database: getDb(),
  baseURL: process.env.AUTH_BASE_URL || `http://localhost:${env.port}`,
  basePath: "/api/auth",
  secret: env.authSecret,
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
          // BetterAuth swallows hook exceptions, so a failed directory
          // provision used to leave the operator without any signal that
          // the user couldn't write to disk. Surface the failure to the
          // log instead of silently dropping it.
          try {
            provisionUserDirectories(user.id);
            seedDefaultPreset(user.id);
          } catch (err) {
            console.error(
              `[Auth] Failed to provision user ${user.id}:`,
              err instanceof Error ? err.message : err,
            );
          }
        },
      },
    },
  },
});

export type Auth = typeof auth;
