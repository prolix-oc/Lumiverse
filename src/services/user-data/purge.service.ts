// Full user wipe — the destructive counterpart to export.service. Removes
// every SQLite row, LanceDB vector, and on-disk artifact a user owns, then
// drops the auth rows themselves. Tables are walked through TABLE_REGISTRY
// so any new user-owned table picked up by export/import is also covered
// here without a second source of truth.
//
// Ordering:
//   1. Stop runtime work touching the user (generations, MCP, Spindle).
//   2. Snapshot file paths from rows we're about to delete.
//   3. Delete LanceDB rows (separate store; can't participate in the SQL txn).
//   4. Single SQLite transaction: delete every user-owned row, then the auth
//      rows. FK cascades fan out from there.
//   5. After commit, unlink files and remove per-user directory trees.

import { existsSync, rmSync, unlinkSync } from "fs";
import { join } from "path";
import { getDb } from "../../db/connection";
import { env } from "../../env";
import { getUserBaseDir } from "../../auth/provision";
import { deleteUserVectors } from "../embeddings.service";
import { getMcpClientManager } from "../mcp-client-manager";
import { stopUserGenerations } from "../generate.service";
import * as spindleLifecycle from "../../spindle/lifecycle";
import {
  TABLE_REGISTRY,
  VIA_CHAT_TABLES,
  VIA_WORLD_BOOK_TABLES,
  VAULT_TABLES,
  VIA_VAULT_TABLES,
  type TableSpec,
} from "./table-registry";

export interface PurgeReport {
  deletedRows: Record<string, number>;
  deletedFiles: number;
  missingFiles: number;
}

/**
 * Permanently delete a user and every artifact they own. Throws if the user
 * doesn't exist. Idempotent against partial prior runs — re-running on the
 * same id is safe.
 */
export async function purgeUser(userId: string): Promise<PurgeReport> {
  const db = getDb();
  const exists = db
    .query('SELECT 1 AS x FROM "user" WHERE id = ?')
    .get(userId) as { x: number } | null;
  if (!exists) {
    throw new Error(`User not found: ${userId}`);
  }

  // ── 1) Stop live work touching the user. Best-effort; failures here must
  //    not block the SQL wipe, otherwise a stuck extension would make the
  //    account undeletable.
  try {
    stopUserGenerations(userId);
  } catch (err) {
    console.warn(`[purge] stopUserGenerations failed for ${userId}:`, err);
  }
  try {
    await getMcpClientManager().disconnectAll(userId);
  } catch (err) {
    console.warn(`[purge] mcp disconnectAll failed for ${userId}:`, err);
  }
  await stopUserExtensions(userId);

  // ── 2) Collect file paths before the rows that name them are gone.
  const filePaths = collectUserFilePaths(userId);

  // ── 3) LanceDB lives outside SQLite; wipe vectors before the SQL txn so
  //    a successful SQL commit isn't paired with orphaned vectors.
  await deleteUserVectors(userId);

  // ── 4) SQL wipe. One transaction; FK cascades handle children.
  const deletedRows = performSqlWipe(userId);

  // ── 5) Filesystem. Run after commit — if the transaction had thrown we'd
  //    still want the files around for forensic recovery.
  let deletedFiles = 0;
  let missingFiles = 0;
  for (const path of filePaths) {
    try {
      if (existsSync(path)) {
        unlinkSync(path);
        deletedFiles++;
      } else {
        missingFiles++;
      }
    } catch (err) {
      console.warn(`[purge] failed to unlink ${path}:`, err);
    }
  }

  for (const dir of perUserDirectories(userId)) {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn(`[purge] failed to remove ${dir}:`, err);
    }
  }

  return { deletedRows, deletedFiles, missingFiles };
}

// ---------------------------------------------------------------------------
// Runtime cleanup
// ---------------------------------------------------------------------------

async function stopUserExtensions(userId: string): Promise<void> {
  // User-scoped extensions live in the runningExtensions map keyed by id.
  // The DB row has install_scope='user' AND installed_by_user_id=userId;
  // both must match to avoid touching operator-installed extensions.
  let ids: string[] = [];
  try {
    ids = (
      getDb()
        .query(
          `SELECT id FROM extensions
           WHERE install_scope = 'user' AND installed_by_user_id = ?`,
        )
        .all(userId) as { id: string }[]
    ).map((r) => r.id);
  } catch (err) {
    console.warn(`[purge] failed to enumerate user extensions for ${userId}:`, err);
    return;
  }
  for (const id of ids) {
    try {
      await spindleLifecycle.stopExtension(id);
    } catch (err) {
      console.warn(`[purge] stopExtension ${id} failed:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// File path collection
// ---------------------------------------------------------------------------

function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

function getTableColumns(table: string): string[] {
  return (
    getDb()
      .query(`PRAGMA table_info(${ident(table)})`)
      .all() as { name: string }[]
  ).map((c) => c.name);
}

/**
 * Walk every registry table that declares fileRefs, resolve the absolute on-
 * disk paths for the user's rows, and de-dupe. Mirrors the file-collection
 * walk in export.service so a file referenced by an exported row is the same
 * file we'll unlink on purge.
 */
function collectUserFilePaths(userId: string): string[] {
  const seen = new Set<string>();
  for (const spec of TABLE_REGISTRY) {
    if (!spec.fileRefs || spec.fileRefs.length === 0) continue;
    const cols = getTableColumns(spec.table);
    if (cols.length === 0) continue;

    const wheres: string[] = [];
    const params: any[] = [];
    switch (spec.ownership) {
      case "user":
        wheres.push(`${ident(spec.table)}.user_id = ?`);
        params.push(userId);
        break;
      case "via_installer":
        wheres.push(`${ident(spec.table)}.installed_by_user_id = ?`);
        params.push(userId);
        break;
      default:
        // fileRefs are only declared on user-owned or installer-owned tables
        // today; bail rather than guess.
        continue;
    }
    if (spec.extraWhere) wheres.push(spec.extraWhere);

    const sql =
      `SELECT ${cols.map(ident).join(", ")} FROM ${ident(spec.table)} ` +
      `WHERE ${wheres.join(" AND ")}`;
    let rows: any[] = [];
    try {
      rows = getDb().prepare(sql).all(...params) as any[];
    } catch (err) {
      console.warn(`[purge] file-ref query failed for ${spec.table}:`, err);
      continue;
    }
    for (const row of rows) {
      for (const ref of spec.fileRefs) {
        for (const abs of ref.resolve(row, env.dataDir)) {
          if (!seen.has(abs)) seen.add(abs);
        }
      }
    }
  }

  // Image thumbnails: the registry only knows the v2 suffix; sweep legacy
  // names too so an old-tier-thumbnail orphan doesn't survive.
  try {
    const imgs = getDb()
      .query("SELECT id FROM images WHERE user_id = ?")
      .all(userId) as { id: string }[];
    const dir = join(env.dataDir, "images");
    for (const img of imgs) {
      for (const suffix of ["_thumb_sm.webp", "_thumb_lg.webp"]) {
        seen.add(join(dir, `${img.id}${suffix}`));
      }
    }
  } catch (err) {
    console.warn(`[purge] legacy thumbnail sweep failed:`, err);
  }

  return [...seen];
}

function perUserDirectories(userId: string): string[] {
  // Every per-user file tree outside of data/images and data/avatars (which
  // are content-addressed and handled via fileRefs above).
  return [
    getUserBaseDir(userId),
    join(env.dataDir, "databank", userId),
    join(env.dataDir, "theme-assets", userId),
    join(env.dataDir, "notification-sounds", userId),
    join(env.dataDir, "imports", userId),
  ];
}

// ---------------------------------------------------------------------------
// SQL wipe
// ---------------------------------------------------------------------------

function buildDelete(spec: TableSpec): { sql: string; params: any[] } | null {
  const t = ident(spec.table);
  switch (spec.ownership) {
    case "user":
      return { sql: `DELETE FROM ${t} WHERE user_id = ?`, params: [] };
    case "via_chat":
      return {
        sql: `DELETE FROM ${t} WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?)`,
        params: [],
      };
    case "via_pack":
      return {
        sql: `DELETE FROM ${t} WHERE pack_id IN (SELECT id FROM packs WHERE user_id = ?)`,
        params: [],
      };
    case "via_vault":
      return {
        sql: `DELETE FROM ${t} WHERE vault_id IN (SELECT id FROM cortex_vaults WHERE user_id = ?)`,
        params: [],
      };
    case "via_session":
      return {
        sql: `DELETE FROM ${t} WHERE session_id IN (SELECT id FROM dream_weaver_sessions WHERE user_id = ?)`,
        params: [],
      };
    case "via_document":
      return {
        sql: `DELETE FROM ${t} WHERE document_id IN (SELECT id FROM databank_documents WHERE user_id = ?)`,
        params: [],
      };
    case "via_installer": {
      // Only purge user-installed extensions; operator-installed rows remain
      // even though the row's FK would cascade them — but the FK is on
      // installed_by_user_id, and operator rows have it as NULL, so the
      // cascade is a no-op for them. The extraWhere keeps this explicit.
      const where = spec.extraWhere
        ? `installed_by_user_id = ? AND (${spec.extraWhere})`
        : `installed_by_user_id = ?`;
      return { sql: `DELETE FROM ${t} WHERE ${where}`, params: [] };
    }
    default:
      return null;
  }
}

function performSqlWipe(userId: string): Record<string, number> {
  const db = getDb();
  const counts: Record<string, number> = {};

  // Run the explicit deletes inside a single transaction so a mid-wipe crash
  // doesn't leave the user half-deleted.
  const tx = db.transaction(() => {
    // 4a) Child rows reachable through joins. Run BEFORE the parent deletes
    //     so the IN(SELECT …) sub-queries still see the parent ids. (FK
    //     cascades would catch most of these anyway, but doing them
    //     explicitly avoids order-of-cascade subtleties and makes the row
    //     counts honest in the report.)
    for (const tbl of VIA_CHAT_TABLES) {
      counts[tbl] = (counts[tbl] || 0) + runDelete(
        db,
        `DELETE FROM ${ident(tbl)} WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?)`,
        userId,
      );
    }
    for (const tbl of VIA_WORLD_BOOK_TABLES) {
      counts[tbl] = (counts[tbl] || 0) + runDelete(
        db,
        `DELETE FROM ${ident(tbl)} WHERE world_book_id IN (SELECT id FROM world_books WHERE user_id = ?)`,
        userId,
      );
    }
    for (const tbl of VIA_VAULT_TABLES) {
      counts[tbl] = (counts[tbl] || 0) + runDelete(
        db,
        `DELETE FROM ${ident(tbl)} WHERE vault_id IN (SELECT id FROM cortex_vaults WHERE user_id = ?)`,
        userId,
      );
    }

    // 4b) Vault parents (no FK to user, so cascade wouldn't reach them).
    for (const tbl of VAULT_TABLES) {
      counts[tbl] = (counts[tbl] || 0) + runDelete(
        db,
        `DELETE FROM ${ident(tbl)} WHERE user_id = ?`,
        userId,
      );
    }

    // 4c) Walk the registry — covers both the cascading and non-cascading
    //     user-owned tables. The cascading ones become no-ops if the user
    //     cascade has already fired children, which is fine.
    for (const spec of TABLE_REGISTRY) {
      const built = buildDelete(spec);
      if (!built) continue;
      counts[spec.table] = (counts[spec.table] || 0) + runDelete(
        db,
        built.sql,
        userId,
        ...built.params,
      );
    }

    // 4d) Tables excluded from export/import but still user-scoped. Today
    //     that's just push_subscriptions (device-bound).
    counts["push_subscriptions"] = runDelete(
      db,
      "DELETE FROM push_subscriptions WHERE user_id = ?",
      userId,
    );

    // 4e) Auth + secrets + the user row. secrets and settings cascade off
    //     user, but the explicit deletes give us honest counts in the
    //     report and survive an accidental FK pragma flip.
    counts["secrets"] = runDelete(
      db,
      'DELETE FROM "secrets" WHERE user_id = ?',
      userId,
    );
    counts["settings"] = runDelete(
      db,
      'DELETE FROM "settings" WHERE user_id = ?',
      userId,
    );
    counts["session"] = runDelete(
      db,
      'DELETE FROM "session" WHERE userId = ?',
      userId,
    );
    counts["account"] = runDelete(
      db,
      'DELETE FROM "account" WHERE userId = ?',
      userId,
    );
    counts["user"] = runDelete(
      db,
      'DELETE FROM "user" WHERE id = ?',
      userId,
    );
  });
  tx();

  return counts;
}

function runDelete(db: ReturnType<typeof getDb>, sql: string, ...params: any[]): number {
  // Intentionally not catching — failures inside the transaction must
  // propagate so bun:sqlite rolls back instead of partially committing.
  const res = db.prepare(sql).run(...params);
  return Number(res.changes ?? 0);
}

