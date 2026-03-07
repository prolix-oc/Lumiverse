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

export async function seedOwner(): Promise<void> {
  const db = getDb();

  const userCount = db.query('SELECT COUNT(*) as count FROM "user"').get() as { count: number } | null;
  if (userCount && userCount.count > 0) {
    console.log("[Auth] Owner already exists, skipping seed.");
    return;
  }

  console.log(`[Auth] Seeding owner account: ${env.ownerUsername}`);

  const nonce = allowCreation();

  try {
    await auth.api.signUpEmail({
      body: {
        email: `${env.ownerUsername}@lumiverse.local`,
        password: env.ownerPassword,
        name: env.ownerUsername,
        username: env.ownerUsername,
        __creationNonce: nonce,
      },
    });
  } catch (err) {
    console.error("[Auth] Failed to seed owner:", err);
    throw err;
  }

  // Set role to owner
  const owner = db
    .query('SELECT id FROM "user" WHERE username = ?')
    .get(env.ownerUsername) as { id: string } | null;

  if (owner) {
    db.run('UPDATE "user" SET role = ? WHERE id = ?', ["owner", owner.id]);
    provisionUserDirectories(owner.id);
    console.log(`[Auth] Owner seeded with id: ${owner.id}`);
  }
}

export function backfillUserIds(): void {
  const db = getDb();

  const owner = db
    .query('SELECT id FROM "user" WHERE role = ? LIMIT 1')
    .get("owner") as { id: string } | null;

  if (!owner) {
    console.log("[Auth] No owner found, skipping backfill.");
    return;
  }

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
