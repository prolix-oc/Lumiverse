import { betterAuth } from "better-auth";
import { username, admin, bearer } from "better-auth/plugins";
import { getDb } from "../db/connection";
import { env } from "../env";
import { provisionUserDirectories } from "./provision";

// ─── Signup gate ────────────────────────────────────────────────────────
// All signups are blocked unless a valid nonce is presented.
// Nonces are single-use, short-lived (10s), and cryptographically random.

let creationNonce: string | null = null;
let creationNonceExpiry = 0;
// Race-condition guard: prevents two concurrent user-creation requests from
// both passing the nonce check (audit M-02 / auth race-condition finding).
let _creationLock = false;

export function allowCreation(): string {
  creationNonce = crypto.randomUUID();
  creationNonceExpiry = Date.now() + 10_000;
  return creationNonce;
}

/**
 * Execute `fn` while holding the single-use nonce creation lock.
 * Throws if another creation is already in progress, preventing the race
 * condition where two concurrent POST /users requests both call allowCreation()
 * and overwrite each other's nonce.
 */
export async function withCreationNonce<T>(fn: () => Promise<T>): Promise<T> {
  if (_creationLock) {
    throw new Error("User creation already in progress — try again");
  }
  _creationLock = true;
  creationNonce = crypto.randomUUID();
  creationNonceExpiry = Date.now() + 10_000;
  try {
    return await fn();
  } finally {
    creationNonce = null;
    _creationLock = false;
  }
}

function consumeNonce(): boolean {
  if (!creationNonce) return false;
  if (Date.now() > creationNonceExpiry) {
    creationNonce = null;
    return false;
  }
  creationNonce = null; // single use
  return true;
}

// ─── BetterAuth instance ────────────────────────────────────────────────

export const auth = betterAuth({
  database: getDb(),
  baseURL: process.env.AUTH_BASE_URL || `http://localhost:${env.port}`,
  basePath: "/api/auth",
  secret: env.authSecret,
  trustedOrigins: env.trustAnyOrigin
    ? (request?: Request) => {
        const origin = request?.headers.get("origin");
        return origin ? [origin] : [];
      }
    : env.trustedOrigins,
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
    bearer(),
  ],
  databaseHooks: {
    user: {
      create: {
        before: async () => {
          if (!consumeNonce()) {
            return false;
          }
        },
        after: async (user) => {
          provisionUserDirectories(user.id);
        },
      },
    },
  },
});

export type Auth = typeof auth;
