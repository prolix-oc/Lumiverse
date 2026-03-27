import { join, resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { hashPassword } from "../crypto/password";
import { getDb } from "../db/connection";
import { env } from "../env";
import { provisionUserDirectories } from "./provision";
import {
  ownerCredentialsExist,
  readOwnerCredentials,
  writeOwnerCredentials,
} from "../crypto/credentials";

const CONTENT_TABLES = [
  "characters",
  "chats",
  "personas",
  "world_books",
  "presets",
  "connection_profiles",
  "images",
  "secrets",
  "settings",
];

/**
 * Cached ID of the first-created user (user 0). Populated at startup by
 * seedOwner() and used by enforceFirstUserOwner() for O(1) runtime checks.
 */
let firstUserId: string | null = null;

/** Returns the cached first-user ID, or null if not yet resolved. */
export function getFirstUserId(): string | null {
  return firstUserId;
}

/**
 * Seed the owner account directly into BetterAuth's tables.
 * Bypasses signUpEmail() so a plaintext password is never needed at runtime —
 * only the pre-hashed value from the credentials file is used.
 */
function seedOwnerDirectly(db: ReturnType<typeof getDb>, username: string, passwordHash: string): string {
  const userId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const email = `${username}@lumiverse.local`;

  db.run(
    `INSERT INTO "user" (id, name, email, emailVerified, username, displayUsername, role, createdAt, updatedAt)
     VALUES (?, ?, ?, 1, ?, ?, 'owner', ?, ?)`,
    [userId, username, email, username, username, now, now]
  );

  db.run(
    `INSERT INTO "account" (id, accountId, providerId, userId, password, createdAt, updatedAt)
     VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
    [accountId, userId, userId, passwordHash, now, now]
  );

  return userId;
}

/**
 * Strip a key from the .env file. Removes the line entirely, plus any
 * immediately preceding comment line that describes it.
 */
function stripEnvKey(envPath: string, key: string): boolean {
  if (!existsSync(envPath)) return false;

  const original = readFileSync(envPath, "utf-8");
  const lines = original.split("\n");
  const filtered: string[] = [];
  let stripped = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match "KEY=..." or "KEY =" (with optional whitespace)
    if (line.match(new RegExp(`^\\s*${key}\\s*=`))) {
      // Also remove a preceding comment if it references this key
      if (filtered.length > 0 && filtered[filtered.length - 1].match(/^\s*#/)) {
        filtered.pop();
      }
      stripped = true;
      continue;
    }
    filtered.push(line);
  }

  if (stripped) {
    // Clean up double blank lines left behind
    const cleaned = filtered.join("\n").replace(/\n{3,}/g, "\n\n");
    writeFileSync(envPath, cleaned);
  }

  return stripped;
}

/**
 * If OWNER_PASSWORD is in the env (legacy install) but no credentials file
 * exists, hash the password, write the credentials file, and strip it
 * from .env.
 */
async function migrateOwnerPassword(credentialsPath: string): Promise<boolean> {
  if (!env.ownerPassword) {
    return false;
  }

  const envPath = resolve(process.cwd(), ".env");

  // Already migrated — just clean up .env if the key is still lingering
  if (ownerCredentialsExist(credentialsPath)) {
    if (stripEnvKey(envPath, "OWNER_PASSWORD")) {
      console.log("[Auth] Removed lingering OWNER_PASSWORD from .env (already migrated).");
    }
    return false;
  }

  console.log("[Auth] Migrating OWNER_PASSWORD to owner.credentials...");
  const hash = await hashPassword(env.ownerPassword);
  writeOwnerCredentials(credentialsPath, env.ownerUsername, hash);

  if (stripEnvKey(envPath, "OWNER_PASSWORD")) {
    console.log("[Auth] Removed OWNER_PASSWORD from .env file.");
  }

  console.log("[Auth] Migration complete. Credentials stored in data/owner.credentials.");
  return true;
}

/**
 * Strip secrets from .env that are now handled by data/ files:
 *  - ENCRYPTION_KEY  → stored in data/lumiverse.identity
 *  - AUTH_SECRET     → derived from identity key at startup
 *  - OWNER_PASSWORD  → stored hashed in data/owner.credentials
 */
function cleanupLegacyEnvSecrets(): void {
  const envPath = resolve(process.cwd(), ".env");
  const identityPath = join(env.dataDir, "lumiverse.identity");

  // Only strip encryption/auth keys if the identity file exists (proves migration is done)
  if (!existsSync(identityPath)) return;

  const stripped: string[] = [];

  // Check the raw process.env values — env.authSecret may have been derived
  // at runtime by initIdentity(), so we can't rely on it to detect a .env entry.
  if (process.env.ENCRYPTION_KEY && stripEnvKey(envPath, "ENCRYPTION_KEY")) {
    stripped.push("ENCRYPTION_KEY");
  }
  if (process.env.AUTH_SECRET && stripEnvKey(envPath, "AUTH_SECRET")) {
    stripped.push("AUTH_SECRET");
  }

  if (stripped.length > 0) {
    console.log(`[Auth] Removed legacy secrets from .env: ${stripped.join(", ")}`);
    console.log("[Auth] These are now managed by data/lumiverse.identity.");
  }
}

export async function seedOwner(): Promise<void> {
  const db = getDb();
  const credentialsPath = join(env.dataDir, "owner.credentials");

  // Migrate legacy secrets from .env → data/ files
  await migrateOwnerPassword(credentialsPath);
  cleanupLegacyEnvSecrets();

  const userCount = db.query('SELECT COUNT(*) as count FROM "user"').get() as { count: number } | null;
  if (userCount && userCount.count > 0) {
    // Users exist — skip initial seed but still enforce the owner role below.
  } else {
    // First run: create the owner account from the credentials file.
    if (!ownerCredentialsExist(credentialsPath)) {
      console.error("");
      console.error("[Auth] No owner credentials found and no users exist.");
      console.error(`[Auth] Expected credentials at: ${credentialsPath}`);
      console.error(`[Auth] DATA_DIR: ${env.dataDir}`);
      console.error("[Auth] Run the setup wizard first:  bun run setup");
      console.error("[Auth] Or set OWNER_PASSWORD in your environment (Docker/Termux).");
      console.error("");
      process.exit(1);
    }

    let creds;
    try {
      creds = readOwnerCredentials(credentialsPath);
    } catch (err) {
      console.error(`[Auth] Credentials file exists but could not be read: ${err}`);
      console.error("[Auth] The file may be corrupted. Run: bun run reset-password");
      process.exit(1);
    }
    console.log(`[Auth] Seeding owner account: ${creds.username}`);

    try {
      const userId = seedOwnerDirectly(db, creds.username, creds.passwordHash);
      provisionUserDirectories(userId);
    } catch (err) {
      console.error("[Auth] Failed to seed owner:", err);
      throw err;
    }
  }

  // Always ensure the designated owner has role = "owner".
  // The UPDATE is a separate step — if the process crashed between the
  // INSERT and this UPDATE on a previous run, the owner would be stuck
  // as "user" forever since the count-guard above would skip re-seeding.
  //
  // Lookup chain (most specific → broadest):
  //   1. Exact username match (from credentials file or env fallback)
  //   2. Case-insensitive username match
  //   3. First-created user (user 0) — guaranteed owner for single-user installs
  type UserRow = { id: string; role: string; username: string };

  const ownerUsername = ownerCredentialsExist(credentialsPath)
    ? readOwnerCredentials(credentialsPath).username
    : env.ownerUsername;

  let owner: UserRow | null = db
    .query('SELECT id, role, username FROM "user" WHERE username = ?')
    .get(ownerUsername) as UserRow | null;

  if (!owner) {
    owner = db
      .query('SELECT id, role, username FROM "user" WHERE LOWER(username) = LOWER(?)')
      .get(ownerUsername) as UserRow | null;
    if (owner) {
      console.log(`[Auth] Owner matched via case-insensitive lookup: "${owner.username}" (expected: "${ownerUsername}")`);
    }
  }

  if (!owner) {
    // Fallback: the very first user created is the instance owner.
    owner = db
      .query('SELECT id, role, username FROM "user" ORDER BY createdAt ASC LIMIT 1')
      .get() as UserRow | null;
    if (owner) {
      console.log(`[Auth] Owner resolved via first-user fallback: "${owner.username}" (id: ${owner.id})`);
    }
  }

  if (owner) {
    firstUserId = owner.id;
    if (owner.role !== "owner") {
      db.run('UPDATE "user" SET role = ? WHERE id = ?', ["owner", owner.id]);
      console.log(`[Auth] Promoted "${owner.username}" to owner role (was "${owner.role}")`);
    }
    provisionUserDirectories(owner.id);
  } else {
    console.error("[Auth] No users exist after seeding — this should never happen");
  }
}

export function backfillUserIds(): void {
  const db = getDb();

  // Prefer the cached first-user ID (set by seedOwner), fall back to role
  // lookup, then to first-created user. This ensures backfill works even if
  // the role column was somehow not updated.
  let ownerId = firstUserId;
  if (!ownerId) {
    const row = db
      .query('SELECT id FROM "user" WHERE role = ? LIMIT 1')
      .get("owner") as { id: string } | null;
    ownerId = row?.id ?? null;
  }
  if (!ownerId) {
    const row = db
      .query('SELECT id FROM "user" ORDER BY createdAt ASC LIMIT 1')
      .get() as { id: string } | null;
    ownerId = row?.id ?? null;
  }

  if (!ownerId) {
    console.log("[Auth] No users found, skipping backfill.");
    return;
  }

  const owner = { id: ownerId };

  let totalBackfilled = 0;

  for (const table of CONTENT_TABLES) {
    try {
      // Check if user_id column exists
      const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      const hasUserIdCol = cols.some((c) => c.name === "user_id");
      if (!hasUserIdCol) continue;

      const result = db.run(
        `UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`,
        [owner.id]
      );
      if (result.changes > 0) {
        totalBackfilled += result.changes;
        console.log(`[Auth] Backfilled ${result.changes} rows in ${table}`);
      }
    } catch {
      // Table may not exist yet
    }
  }

  if (totalBackfilled > 0) {
    console.log(`[Auth] Total backfilled: ${totalBackfilled} rows`);
  }
}
