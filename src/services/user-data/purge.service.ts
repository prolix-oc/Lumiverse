// Full user wipe — the destructive counterpart to export.service. Removes
// every SQLite row, LanceDB vector, and on-disk artifact a user owns, then
// drops the auth rows themselves. The archive registry is the single source
// of truth for ownership, deletion order, and file references.
//
// Ordering:
//   1. Stop runtime work touching the user (generations, MCP, Spindle).
//   2. Snapshot file paths from rows we're about to delete.
//   3. Delete LanceDB vectors (separate store; can't participate in SQL txn).
//   4. Single SQLite transaction: delete every registry-owned row.
//   5. After commit, unlink files and remove per-user directory trees.

import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { isAbsolute, join, relative, resolve } from "path";
import { getDb } from "../../db/connection";
import { env } from "../../env";
import { getUserBaseDir } from "../../auth/provision";
import {
  withArtifactUserDeletionFence,
  withArtifactUserDeletionFenceSync,
} from "../agent-artifact-blobs.service";
import { withUserDataExport, withUserDataExportSync } from "./snapshot";
import { deleteUserVectors } from "../embeddings.service";
import { getMcpClientManager } from "../mcp-client-manager";
import { stopUserGenerations } from "../generate.service";
import * as spindleLifecycle from "../../spindle/lifecycle";
import {
  ARCHIVE_TABLE_REGISTRY,
  getArchiveDeleteOrder,
  getArchiveTableSpec,
  buildArchiveOwnerPredicate,
  type ArchiveTableSpecV2,
} from "./table-registry";

export interface PurgeReport {
  deletedRows: Record<string, number>;
  deletedFiles: number;
  missingFiles: number;
}
const PURGE_INTENT_DIR = ".purge-intents";
const PURGE_INTENT_VERSION = 1;
const MAX_PURGE_INTENTS = 256;

type PurgeIntent = {
  readonly version: 1;
  readonly userDigest: string;
};

function digestPurgeIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function purgeIntentDirectory(): string {
  return resolve(env.dataDir, PURGE_INTENT_DIR);
}

function purgeIntentPath(userId: string): string {
  return join(purgeIntentDirectory(), `${digestPurgeIdentity(userId)}.json`);
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function syncDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe purge directory: ${path}`);
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

}
function writePurgeIntent(userId: string): void {
  const directory = purgeIntentDirectory();
  mkdirSync(directory, { recursive: true });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Purge intent directory is unsafe");
  const path = purgeIntentPath(userId);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const intent: PurgeIntent = { version: PURGE_INTENT_VERSION, userDigest: digestPurgeIdentity(userId) };
  const fd = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(intent));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporaryPath, path);
  syncDirectory(directory);
}
function removePurgeIntent(userId: string): void {
  const path = purgeIntentPath(userId);
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  if (lstatIfPresent(purgeIntentDirectory())) syncDirectory(purgeIntentDirectory());
}

function parsePurgeIntent(path: string): PurgeIntent {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Purge intent is corrupt: ${path}`);
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    (raw as { version?: unknown }).version !== PURGE_INTENT_VERSION ||
    !/^[0-9a-f]{64}$/.test(String((raw as { userDigest?: unknown }).userDigest ?? ""))
  ) {
    throw new Error(`Purge intent is invalid: ${path}`);
  }
  return raw as PurgeIntent;
}

function findArtifactRootForDigest(userDigest: string): string | null {
  const parent = resolve(env.dataDir, "agent-artifacts");
  const parentStat = lstatIfPresent(parent);
  if (!parentStat) return null;
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Artifact root is unsafe");
  const matches: string[] = [];
  for (const name of readdirSync(parent)) {
    const child = resolve(parent, name);
    const childRelative = relative(parent, child);
    if (!childRelative || isAbsolute(childRelative) || childRelative === ".." || childRelative.startsWith(`..${"/"}`)) {
      throw new Error(`Artifact root escaped its parent: ${child}`);
    }
    const childStat = lstatSync(child);
    if (childStat.isSymbolicLink()) throw new Error(`Refusing symlinked artifact user root: ${child}`);
    if (digestPurgeIdentity(name) === userDigest) {
      if (!childStat.isDirectory()) throw new Error(`Artifact user root is not a directory: ${child}`);
      matches.push(child);
    }
  }
  if (matches.length > 1) throw new Error("Multiple artifact roots match one purge intent");
  return matches[0] ?? null;
}

/** Reconcile account artifact roots whose SQL deletion committed before a crash. */
export function reconcilePurgeCleanupIntents(): void {
  const directory = purgeIntentDirectory();
  const stat = lstatIfPresent(directory);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Purge intent directory is unsafe");
  const entries = readdirSync(directory);
  if (entries.length > MAX_PURGE_INTENTS) throw new Error("Too many purge intents");
  for (const name of entries) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) throw new Error(`Unexpected purge intent: ${name}`);
    const path = resolve(directory, name);
    const intentStat = lstatSync(path);
    if (intentStat.isSymbolicLink() || !intentStat.isFile()) throw new Error(`Purge intent path is unsafe: ${path}`);
    const intent = parsePurgeIntent(path);
    if (name.slice(0, -5) !== intent.userDigest) throw new Error(`Purge intent digest mismatch: ${path}`);
    const root = findArtifactRootForDigest(intent.userDigest);
    if (!root) {
      unlinkSync(path);
      continue;
    }
    const parent = resolve(env.dataDir, "agent-artifacts");
    const userId = root.slice(parent.length + 1);
    const userExists = getDb().query('SELECT 1 AS x FROM "user" WHERE id = ? LIMIT 1').get(userId);
    withUserDataExportSync(userId, () => withArtifactUserDeletionFenceSync(userId, () => {
      assertArtifactTreeSafe(root);
      removeArtifactTree(root);
      unlinkSync(path);
    }));
  }
  syncDirectory(directory);
}


/**
 * Permanently delete a user and every artifact they own. Throws if the user
 * doesn't exist. Idempotent against partial prior runs — re-running on the
 * same id is safe.
 */
export async function purgeUser(userId: string): Promise<PurgeReport> {
  const exists = getDb()
    .query('SELECT 1 AS x FROM "user" WHERE id = ?')
    .get(userId) as { x: number } | null;
  if (!exists) {
    throw new Error(`User not found: ${userId}`);
  }

  // Stop live work touching the user before taking the exclusive user-data
  // lease. Best-effort; a stuck extension must not make the account
  // undeletable. Durable cancellation awaits in-flight turns, and those turns
  // may already be queued on this user's barrier: awaiting them while holding
  // the exclusive lease would deadlock the purge against its own victims.
  try {
    await stopUserGenerations(userId);
  } catch (err) {
    console.warn(`[purge] stopUserGenerations failed for ${userId}:`, err);
  }
  try {
    await getMcpClientManager().disconnectAll(userId);
  } catch (err) {
    console.warn(`[purge] mcp disconnectAll failed for ${userId}:`, err);
  }
  await stopUserExtensions(userId);

  return await withUserDataExport(userId, async () => {
    // Re-verify ownership under the lease: another purge may have completed
    // while this call waited, and the row must exist for the wipe to be exact.
    const owned = getDb()
      .query('SELECT 1 AS x FROM "user" WHERE id = ?')
      .get(userId) as { x: number } | null;
    if (!owned) {
      throw new Error(`User not found: ${userId}`);
    }
    return await withArtifactUserDeletionFence(userId, async () => {

  const artifactDirectory = getArtifactUserDirectory(userId);
  assertArtifactTreeSafe(artifactDirectory);
  const filePaths = collectUserFilePaths(userId);
  writePurgeIntent(userId);

  // LanceDB lives outside SQLite; wipe vectors before the SQL transaction so a
  // successful SQL commit is not paired with user-owned vectors.
  await deleteUserVectors(userId);

  const deletedRows = performSqlWipe(userId);

  // Filesystem cleanup runs after commit. If the transaction throws, files stay
  // available for recovery and the caller receives the transaction error.
  let deletedFiles = 0;
  let missingFiles = 0;
  let cleanupFailure: unknown;
  for (const path of filePaths) {
    try {
      if (existsSync(path)) {
        unlinkSync(path);
      } else {
        missingFiles++;
      }
    } catch (err) {
      console.warn(`[purge] failed to unlink ${path}:`, err);
      if (!isContainedPath(artifactDirectory, path)) cleanupFailure ??= err;
    }
  }

  for (const dir of perUserDirectories(userId)) {
    if (resolve(dir) === artifactDirectory) {
      const result = removeArtifactTree(artifactDirectory);
      deletedFiles += result.deletedFiles;
      missingFiles += result.missingFiles;
      continue;
    }
    try {
      const stat = lstatIfPresent(dir);
      if (!stat) continue;
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Refusing to remove unsafe user directory: ${dir}`);
      }
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[purge] failed to remove ${dir}:`, err);
      cleanupFailure ??= err;
    }
  }

  if (cleanupFailure) throw new Error("User purge filesystem cleanup is incomplete", { cause: cleanupFailure });
  removePurgeIntent(userId);
  return { deletedRows, deletedFiles, missingFiles };
    });
  });
}

async function stopUserExtensions(userId: string): Promise<void> {
  let ids: string[] = [];
  try {
    ids = (
      getDb()
        .query(
          `SELECT id FROM extensions
           WHERE install_scope = 'user' AND installed_by_user_id = ?`,
        )
        .all(userId) as { id: string }[]
    ).map((row) => row.id);
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
  ).map((column) => column.name);
}


/** Walk every registry file ref and resolve the absolute paths to unlink. */
function collectUserFilePaths(userId: string): string[] {
  const seen = new Set<string>();
  for (const spec of ARCHIVE_TABLE_REGISTRY) {
    if (spec.fileRefs.length === 0) continue;
    const columns = getTableColumns(spec.table);
    const predicate = buildArchiveOwnerPredicate(spec, userId, ident(spec.table));
    if (!predicate) continue;
    const sql =
      `SELECT ${columns.map(ident).join(", ")} FROM ${ident(spec.table)} ` +
      `WHERE ${predicate.sql}`;
    let rows: Record<string, any>[] = [];
    try {
      rows = getDb().prepare(sql).all(...predicate.params) as Record<string, any>[];
    } catch (err) {
      console.warn(`[purge] file-ref query failed for ${spec.table}:`, err);
      continue;
    }
    for (const row of rows) {
      for (const ref of spec.fileRefs) {
        if (ref.applies && !ref.applies(row)) continue;
        for (const absolutePath of ref.resolve(row, env.dataDir)) {
          seen.add(absolutePath);
        }
      }
    }
  }
  // Sweep legacy names too so an old-tier-thumbnail orphan doesn't survive.
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
  return [
    getUserBaseDir(userId),
    getArtifactUserDirectory(userId),
    join(env.dataDir, "databank", userId),
    join(env.dataDir, "theme-assets", userId),
    join(env.dataDir, "notification-sounds", userId),
    join(env.dataDir, "imports", userId),
  ];
}

type ArtifactTreeCleanupResult = {
  deletedFiles: number;
  missingFiles: number;
};

function getArtifactUserDirectory(userId: string): string {
  const root = resolve(env.dataDir, "agent-artifacts");
  const candidate = resolve(root, userId);
  const relativePath = relative(root, candidate);
  if (!relativePath || isAbsolute(relativePath) || relativePath.startsWith(`..${"/"}`) || relativePath === "..") {
    throw new Error(`Unsafe artifact directory for user: ${userId}`);
  }
  return candidate;
}

function isContainedPath(root: string, path: string): boolean {
  const childRelative = relative(resolve(root), resolve(path));
  return childRelative === "" || (!isAbsolute(childRelative) && childRelative !== ".." && !childRelative.startsWith(`..${"/"}`));
}

function assertArtifactTreeSafe(root: string): void {
  if (!lstatIfPresent(root)) return;
  const visit = (path: string, isRoot: boolean): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to purge symlinked artifact path: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) {
        const child = resolve(path, name);
        const childRelative = relative(root, child);
        if (!childRelative || isAbsolute(childRelative) || childRelative === ".." || childRelative.startsWith(`..${"/"}`)) {
          throw new Error(`Artifact path escaped its user root: ${child}`);
        }
        visit(child, false);
      }
      return;
    }
    if (isRoot || !stat.isFile()) throw new Error(`Refusing to purge non-file artifact path: ${path}`);
  };
  visit(root, true);
}

function removeArtifactTree(root: string): ArtifactTreeCleanupResult {
  if (!lstatIfPresent(root)) return { deletedFiles: 0, missingFiles: 0 };
  assertArtifactTreeSafe(root);
  let deletedFiles = 0;
  let missingFiles = 0;
  const remove = (path: string, isRoot: boolean): void => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missingFiles++;
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing to purge symlinked artifact path: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) remove(resolve(path, name), false);
      rmdirSync(path);
      return;
    }
    if (isRoot || !stat.isFile()) throw new Error(`Refusing to purge non-file artifact path: ${path}`);
    unlinkSync(path);
    deletedFiles++;
  };
  remove(root, true);
  return { deletedFiles, missingFiles };
}

function buildDelete(spec: ArchiveTableSpecV2, userId: string): { sql: string; params: any[] } | null {
  const predicate = buildArchiveOwnerPredicate(spec, userId, ident(spec.table));
  if (!predicate) return null;
  return {
    sql: `DELETE FROM ${ident(spec.table)} WHERE ${predicate.sql}`,
    params: predicate.params,
  };
}

function performSqlWipe(userId: string): Record<string, number> {
  const db = getDb();
  const counts: Record<string, number> = {};
  const tx = db.transaction(() => {
    // The registry's delete order is the reverse of its validated parent-first
    // order. It includes canonical, derived, operational, and forbidden rows;
    // rows without an owner predicate are intentionally left untouched.
    for (const table of getArchiveDeleteOrder()) {
      const spec = getArchiveTableSpec(table);
      if (!spec) throw new Error(`Archive delete order references unknown table: ${table}`);
      const built = buildDelete(spec, userId);
      if (!built) continue;
      counts[spec.table] = runDelete(db, built.sql, ...built.params);
    }
  });
  tx();
  return counts;
}

function runDelete(db: ReturnType<typeof getDb>, sql: string, ...params: any[]): number {
  const result = db.prepare(sql).run(...params);
  return Number(result.changes ?? 0);
}
