import { getDb } from "../db/connection";
import { env } from "../env";
import { auth, allowCreation } from "./index";
import { provisionUserDirectories } from "./provision";

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

export async function seedOwner(): Promise<void> {
  const db = getDb();

  const userCount = db.query('SELECT COUNT(*) as count FROM "user"').get() as { count: number } | null;
  if (userCount && userCount.count > 0) {
    // Users exist — skip initial seed but still enforce the owner role below.
  } else {
    // First run: create the owner account.
    console.log(`[Auth] Seeding owner account: ${env.ownerUsername}`);

    allowCreation();

    try {
      await auth.api.signUpEmail({
        body: {
          email: `${env.ownerUsername}@lumiverse.local`,
          password: env.ownerPassword,
          name: env.ownerUsername,
          username: env.ownerUsername,
        },
      });
    } catch (err) {
      console.error("[Auth] Failed to seed owner:", err);
      throw err;
    }
  }

  // Always ensure the designated owner has role = "owner".
  // signUpEmail() creates users with role = "user" (admin plugin default).
  // The UPDATE is a separate step — if the process crashed between the
  // INSERT and this UPDATE on a previous run, the owner would be stuck
  // as "user" forever since the count-guard above would skip re-seeding.
  //
  // Lookup chain (most specific → broadest):
  //   1. Exact username match
  //   2. Case-insensitive username match (BetterAuth normalizes usernames)
  //   3. First-created user (user 0) — guaranteed owner for single-user installs
  type UserRow = { id: string; role: string; username: string };

  let owner: UserRow | null = db
    .query('SELECT id, role, username FROM "user" WHERE username = ?')
    .get(env.ownerUsername) as UserRow | null;

  if (!owner) {
    owner = db
      .query('SELECT id, role, username FROM "user" WHERE LOWER(username) = LOWER(?)')
      .get(env.ownerUsername) as UserRow | null;
    if (owner) {
      console.log(`[Auth] Owner matched via case-insensitive lookup: "${owner.username}" (env: "${env.ownerUsername}")`);
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
