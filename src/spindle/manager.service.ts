import { getDb } from "../db/connection";
import { env } from "../env";
import type {
  SpindleManifest,
  SpindlePermission,
  ExtensionInfo,
} from "lumiverse-spindle-types";
import { validateIdentifier, isValidPermission } from "lumiverse-spindle-types";
import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  copyFileSync,
  cpSync,
} from "fs";
import { join, resolve, dirname, sep } from "path";
import { getUserExtensionPath } from "../auth/provision";

export type InstallScope = "operator" | "user";

// ─── Paths ───────────────────────────────────────────────────────────────

function extensionsDir(): string {
  return join(env.dataDir, "extensions");
}

function extensionDir(identifier: string): string {
  return join(extensionsDir(), identifier);
}

function repoDir(identifier: string): string {
  return join(extensionDir(identifier), "repo");
}

function storageDir(identifier: string): string {
  return join(extensionDir(identifier), "storage");
}

/** Cross-platform move: tries renameSync, falls back to cpSync+rmSync for cross-device moves. */
function moveSync(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err: any) {
    if (err.code !== "EXDEV") throw err;
    cpSync(from, to, { recursive: true, force: true, errorOnExist: false });
    rmSync(from, { recursive: true, force: true });
  }
}

// ─── Manifest parsing ────────────────────────────────────────────────────

function readManifest(identifier: string): SpindleManifest {
  const repo = repoDir(identifier);
  const candidates = [
    join(repo, "spindle.json"),
    join(repo, "spindlefile"),
    join(repo, "spindlefile.json"),
  ];
  const manifestPath = candidates.find((p) => existsSync(p));
  if (!manifestPath) {
    throw new Error(`spindle manifest not found in ${repo}`);
  }
  const raw = readFileSync(manifestPath, "utf-8");
  const manifest: SpindleManifest = JSON.parse(raw);

  // Validate
  if (!manifest.identifier || !validateIdentifier(manifest.identifier)) {
    throw new Error(
      `Invalid identifier "${manifest.identifier}". Must match /^[a-z][a-z0-9_]*$/`
    );
  }
  if (!manifest.version) throw new Error("Missing version in spindle.json");
  if (!manifest.name) throw new Error("Missing name in spindle.json");
  if (!manifest.author) throw new Error("Missing author in spindle.json");
  if (!manifest.github) {
    (manifest as any).github = `local://${manifest.identifier}`;
  }

  return manifest;
}

function readManifestFromPath(
  manifestPath: string,
  options?: { allowMissingGithub?: boolean }
): SpindleManifest {
  if (!existsSync(manifestPath)) {
    throw new Error(`spindle.json not found at ${manifestPath}`);
  }

  const raw = readFileSync(manifestPath, "utf-8");
  const manifest: SpindleManifest = JSON.parse(raw);

  if (!manifest.identifier || !validateIdentifier(manifest.identifier)) {
    throw new Error(
      `Invalid identifier "${manifest.identifier}". Must match /^[a-z][a-z0-9_]*$/`
    );
  }
  if (!manifest.version) throw new Error("Missing version in spindle.json");
  if (!manifest.name) throw new Error("Missing name in spindle.json");
  if (!manifest.author) throw new Error("Missing author in spindle.json");
  if (!manifest.github) {
    if (options?.allowMissingGithub) {
      (manifest as any).github = `local://${manifest.identifier}`;
    } else {
      throw new Error("Missing github in spindle.json");
    }
  }

  return manifest;
}

function moveRootRepoToNestedRepo(extRootDir: string): void {
  const nestedRepoDir = join(extRootDir, "repo");
  mkdirSync(nestedRepoDir, { recursive: true });

  const entries = readdirSync(extRootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "repo" || entry.name === "storage") continue;

    const from = join(extRootDir, entry.name);
    const to = join(nestedRepoDir, entry.name);

    moveSync(from, to);
  }
}

function ensureRepoLayoutForIdentifier(identifier: string): void {
  const root = extensionDir(identifier);
  const rootManifestPath = join(root, "spindle.json");
  const rootSpindleFilePath = join(root, "spindlefile");
  const rootSpindleFileJsonPath = join(root, "spindlefile.json");
  const nestedManifestPath = join(root, "repo", "spindle.json");
  const nestedSpindleFilePath = join(root, "repo", "spindlefile");
  const nestedSpindleFileJsonPath = join(root, "repo", "spindlefile.json");

  if (
    existsSync(nestedManifestPath) ||
    existsSync(nestedSpindleFilePath) ||
    existsSync(nestedSpindleFileJsonPath)
  ) {
    return;
  }
  if (
    !existsSync(rootManifestPath) &&
    !existsSync(rootSpindleFilePath) &&
    !existsSync(rootSpindleFileJsonPath)
  ) {
    throw new Error(`No spindle.json found for local extension ${identifier}`);
  }

  moveRootRepoToNestedRepo(root);
}

function insertExtensionFromManifest(manifest: SpindleManifest): void {
  const db = getDb();
  const existing = db
    .query("SELECT id FROM extensions WHERE identifier = ?")
    .get(manifest.identifier) as { id: string } | null;
  if (existing) return;

  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO extensions (id, identifier, name, version, author, description, github, homepage, permissions, enabled, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '{}')`,
    [
      id,
      manifest.identifier,
      manifest.name,
      manifest.version,
      manifest.author,
      manifest.description || "",
      manifest.github,
      manifest.homepage || "",
      JSON.stringify(manifest.permissions || []),
    ]
  );
}

// Permissions that require explicit admin approval before granting
export const PRIVILEGED_PERMISSIONS = new Set([
  "cors_proxy",
  "generation",
  "interceptor",
  "context_handler",
  "characters",
  "chats",
  "world_books",
]);

function grantRequestedPermissionsByDefault(
  identifier: string,
  permissions: readonly string[] | undefined
): void {
  const requested = Array.isArray(permissions) ? permissions : [];
  for (const perm of requested) {
    if (PRIVILEGED_PERMISSIONS.has(perm)) continue;
    grantPermission(identifier, perm);
  }
}

/**
 * Reconcile extension_grants with the current manifest permissions:
 * - Ensure every non-privileged manifest permission has a grant row
 * - Only auto-grant privileged permissions if they are genuinely new
 *   (not in previousPermissions) — existing privileged perms require manual approval
 * - Revoke grants for permissions no longer declared in the manifest
 */
function syncPermissionGrants(
  identifier: string,
  manifestPermissions: readonly string[],
  previousPermissions: readonly string[]
): void {
  const manifestSet = new Set(manifestPermissions);
  const previousSet = new Set(previousPermissions);
  const granted: Set<string> = new Set(getGrantedPermissions(identifier));

  // Ensure all manifest permissions are granted appropriately
  for (const perm of manifestPermissions) {
    if (granted.has(perm)) continue; // already granted

    if (PRIVILEGED_PERMISSIONS.has(perm)) {
      // Only auto-grant privileged perms that are genuinely new to the manifest
      // (not just missing from extension_grants while already declared)
      if (!previousSet.has(perm)) {
        // New privileged permission — skip, requires manual admin approval
      }
      // If it was in previousPermissions but grant is missing, it was
      // intentionally revoked by an admin — don't re-grant
    } else {
      // Non-privileged: always ensure granted
      grantPermission(identifier, perm);
    }
  }

  // Revoke grants for permissions removed from the manifest
  for (const perm of granted) {
    if (!manifestSet.has(perm)) {
      revokePermission(identifier, perm);
    }
  }
}

/**
 * Re-read spindle.json from disk and sync the DB row + permission grants
 * if anything has changed. Safe to call on every start — no-ops when the
 * manifest matches what the DB already has.
 */
export function syncManifestToDb(identifier: string): void {
  let manifest: SpindleManifest;
  try {
    manifest = readManifest(identifier);
  } catch {
    // If manifest can't be read (e.g. repo missing), skip sync silently
    return;
  }

  const db = getDb();
  const row = db
    .query("SELECT name, version, author, description, github, homepage, permissions FROM extensions WHERE identifier = ?")
    .get(identifier) as {
      name: string; version: string; author: string; description: string;
      github: string; homepage: string; permissions: string;
    } | null;
  if (!row) return;

  const dbPermissions: string[] = JSON.parse(row.permissions || "[]");
  const manifestPermissions = manifest.permissions || [];

  // Check if the extensions row needs updating
  const metadataChanged =
    row.name !== manifest.name ||
    row.version !== manifest.version ||
    row.author !== manifest.author ||
    (row.description || "") !== (manifest.description || "") ||
    row.github !== manifest.github ||
    (row.homepage || "") !== (manifest.homepage || "");
  const permissionsChanged =
    JSON.stringify(dbPermissions) !== JSON.stringify(manifestPermissions);

  if (metadataChanged || permissionsChanged) {
    db.run(
      `UPDATE extensions SET name = ?, version = ?, author = ?, description = ?,
       github = ?, homepage = ?, permissions = ?, updated_at = unixepoch()
       WHERE identifier = ?`,
      [
        manifest.name,
        manifest.version,
        manifest.author,
        manifest.description || "",
        manifest.github,
        manifest.homepage || "",
        JSON.stringify(manifestPermissions),
        identifier,
      ]
    );
  }

  // Always reconcile grants against the manifest — even when the permissions
  // column hasn't changed, the extension_grants table may be out of sync
  // (e.g. manual DB edits, interrupted previous sync, etc.)
  syncPermissionGrants(identifier, manifestPermissions, dbPermissions);
}

function resolveWithin(base: string, requestedPath: string, label: string): string {
  const baseAbs = resolve(base);
  const resolved = resolve(baseAbs, requestedPath);
  const inside = resolved === baseAbs || resolved.startsWith(`${baseAbs}${sep}`);
  if (!inside) {
    throw new Error(`Path traversal detected in ${label}: ${requestedPath}`);
  }
  return resolved;
}

function applyStorageSeeds(identifier: string, manifest: SpindleManifest): void {
  const seeds = Array.isArray(manifest.storage_seed_files)
    ? manifest.storage_seed_files
    : [];
  if (seeds.length === 0) return;

  const repo = repoDir(identifier);
  const storage = storageDir(identifier);
  mkdirSync(storage, { recursive: true });

  for (const seed of seeds) {
    if (!seed || typeof seed !== "object") continue;
    const from = typeof seed.from === "string" ? seed.from.trim() : "";
    if (!from) continue;
    const to = typeof seed.to === "string" && seed.to.trim() ? seed.to.trim() : from;
    const overwrite = seed.overwrite === true;
    const required = seed.required === true;

    const sourcePath = resolveWithin(repo, from, "storage_seed_files.from");
    const targetPath = resolveWithin(storage, to, "storage_seed_files.to");

    if (!existsSync(sourcePath)) {
      if (required) {
        throw new Error(`Required seed source missing: ${from}`);
      }
      continue;
    }

    const srcStat = statSync(sourcePath);
    if (srcStat.isDirectory()) {
      if (existsSync(targetPath) && !overwrite) {
        continue;
      }
      mkdirSync(dirname(targetPath), { recursive: true });
      cpSync(sourcePath, targetPath, {
        recursive: true,
        force: overwrite,
        errorOnExist: false,
      });
      continue;
    }

    if (!srcStat.isFile()) continue;
    if (existsSync(targetPath) && !overwrite) continue;
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

// ─── Build ───────────────────────────────────────────────────────────────

export async function buildExtension(identifier: string): Promise<void> {
  const repo = repoDir(identifier);
  const manifest = readManifest(identifier);

  const backendEntry = manifest.entry_backend || "dist/backend.js";
  const frontendEntry = manifest.entry_frontend || "dist/frontend.js";

  // Always install dependencies first if package.json exists
  const pkgJson = join(repo, "package.json");
  if (existsSync(pkgJson)) {
    const install = Bun.spawnSync({
      cmd: ["bun", "install"],
      cwd: repo,
    });
    if (install.exitCode !== 0) {
      throw new Error(
        `Dependency install failed: ${install.stderr.toString()}`
      );
    }
  }

  // If the repo ships pre-built dist/ (files tracked in git), skip build entirely
  const distDir = join(repo, "dist");
  if (existsSync(distDir)) {
    const lsFiles = Bun.spawnSync({
      cmd: ["git", "ls-files", "dist"],
      cwd: repo,
    });
    if (lsFiles.exitCode === 0 && lsFiles.stdout.toString().trim().length > 0) {
      return;
    }
  }

  // Look for src/ to build from
  const srcDir = join(repo, "src");
  if (!existsSync(srcDir)) return;

  const buildDistDir = join(repo, "dist");
  const backendOut = resolveWithin(repo, backendEntry, "entry_backend");
  const frontendOut = resolveWithin(repo, frontendEntry, "entry_frontend");

  mkdirSync(buildDistDir, { recursive: true });

  // Determine what needs building
  const backendSrc = join(srcDir, "backend.ts");
  const frontendSrc = join(srcDir, "frontend.ts");
  const needsBackendBuild = existsSync(backendSrc) && !existsSync(backendOut);
  const needsFrontendBuild = existsSync(frontendSrc) && !existsSync(frontendOut);

  // Build backend entry if source exists
  if (needsBackendBuild) {
    const proc = Bun.spawnSync({
      cmd: [
        "bun",
        "build",
        "src/backend.ts",
        "--outfile",
        backendEntry,
        "--target",
        "bun",
      ],
      cwd: repo,
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `Backend build failed: ${proc.stderr.toString()}`
      );
    }
  }

  // Build frontend entry if source exists
  if (needsFrontendBuild) {
    const proc = Bun.spawnSync({
      cmd: [
        "bun",
        "build",
        "src/frontend.ts",
        "--outfile",
        frontendEntry,
        "--target",
        "browser",
      ],
      cwd: repo,
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `Frontend build failed: ${proc.stderr.toString()}`
      );
    }
  }
}

// ─── Install ─────────────────────────────────────────────────────────────

export async function install(
  githubUrl: string,
  options?: { installScope?: InstallScope; installedByUserId?: string | null; branch?: string | null }
): Promise<ExtensionInfo> {
  const baseDir = extensionsDir();
  mkdirSync(baseDir, { recursive: true });
  const installScope: InstallScope = options?.installScope === "user" ? "user" : "operator";
  const installedByUserId =
    options?.installedByUserId && options.installedByUserId.trim()
      ? options.installedByUserId.trim()
      : null;
  const branch = options?.branch && options.branch.trim() ? options.branch.trim() : null;

  // Clone to a temp dir first so we can read the manifest
  const tempDir = join(baseDir, `_temp_${Date.now()}`);
  const cloneCmd = ["git", "clone", "--depth", "1"];
  if (branch) {
    cloneCmd.push("--branch", branch);
  }
  cloneCmd.push(githubUrl, tempDir);
  const cloneProc = Bun.spawnSync({
    cmd: cloneCmd,
  });
  if (cloneProc.exitCode !== 0) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`git clone failed: ${cloneProc.stderr.toString()}`);
  }

  // Read manifest from cloned repo
  const manifestPath = join(tempDir, "spindle.json");
  if (!existsSync(manifestPath)) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error("No spindle.json found in repository");
  }

  const raw = readFileSync(manifestPath, "utf-8");
  const manifest: SpindleManifest = JSON.parse(raw);

  if (!manifest.identifier || !validateIdentifier(manifest.identifier)) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(
      `Invalid identifier "${manifest.identifier}". Must match /^[a-z][a-z0-9_]*$/`
    );
  }

  // Check if already installed
  const db = getDb();
  const existing = db
    .query("SELECT id FROM extensions WHERE identifier = ?")
    .get(manifest.identifier);
  if (existing) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`Extension "${manifest.identifier}" is already installed`);
  }

  // Move temp dir to final location
  const extDir = extensionDir(manifest.identifier);
  const finalRepo = repoDir(manifest.identifier);
  mkdirSync(extDir, { recursive: true });

  // Move temp to repo dir
  try {
    moveSync(tempDir, finalRepo);
  } catch (err: any) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`Failed to move cloned repo to extension directory: ${err.message}`);
  }

  // Create storage dir
  mkdirSync(storageDir(manifest.identifier), { recursive: true });

  // Build if needed
  await buildExtension(manifest.identifier);
  applyStorageSeeds(manifest.identifier, manifest);

  // Insert into DB
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO extensions (
      id, identifier, name, version, author, description, github, homepage,
      permissions, enabled, metadata, install_scope, installed_by_user_id, branch
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '{}', ?, ?, ?)`,
    [
      id,
      manifest.identifier,
      manifest.name,
      manifest.version,
      manifest.author,
      manifest.description || "",
      manifest.github,
      manifest.homepage || "",
      JSON.stringify(manifest.permissions || []),
      installScope,
      installedByUserId,
      branch,
    ]
  );

  return getExtension(id)!;
}

// ─── Update ──────────────────────────────────────────────────────────────

export async function update(identifier: string): Promise<ExtensionInfo> {
  const repo = repoDir(identifier);
  if (!existsSync(repo)) {
    throw new Error(`Extension repo not found: ${identifier}`);
  }

  // Clean build artifacts and installed dependencies so git pull succeeds
  Bun.spawnSync({ cmd: ["git", "checkout", "."], cwd: repo });
  Bun.spawnSync({ cmd: ["git", "clean", "-fd"], cwd: repo });

  const pullProc = Bun.spawnSync({
    cmd: ["git", "pull"],
    cwd: repo,
  });
  if (pullProc.exitCode !== 0) {
    throw new Error(`git pull failed: ${pullProc.stderr.toString()}`);
  }

  // Re-read manifest
  const manifest = readManifest(identifier);

  const db = getDb();
  const existing = db
    .query("SELECT permissions FROM extensions WHERE identifier = ?")
    .get(identifier) as { permissions: string } | null;
  const existingPermissions = existing
    ? (JSON.parse(existing.permissions || "[]") as string[])
    : [];
  const existingPermissionSet = new Set(existingPermissions);

  // Rebuild — only delete dist/ if it was locally built (not tracked in git).
  // Repos that ship pre-built dist/ should have those files preserved.
  const srcDir = join(repo, "src");
  const hasBuildableSrc =
    existsSync(srcDir) &&
    (existsSync(join(srcDir, "backend.ts")) || existsSync(join(srcDir, "frontend.ts")));

  if (hasBuildableSrc) {
    const distDir = join(repo, "dist");
    if (existsSync(distDir)) {
      const lsFiles = Bun.spawnSync({
        cmd: ["git", "ls-files", "dist"],
        cwd: repo,
      });
      const distIsTracked = lsFiles.exitCode === 0 && lsFiles.stdout.toString().trim().length > 0;
      if (!distIsTracked) {
        rmSync(distDir, { recursive: true });
      }
    }
  }
  await buildExtension(identifier);
  applyStorageSeeds(identifier, manifest);

  // Update DB
  db.run(
    `UPDATE extensions SET name = ?, version = ?, author = ?, description = ?,
     github = ?, homepage = ?, permissions = ?, updated_at = unixepoch()
     WHERE identifier = ?`,
    [
      manifest.name,
      manifest.version,
      manifest.author,
      manifest.description || "",
      manifest.github,
      manifest.homepage || "",
      JSON.stringify(manifest.permissions || []),
      identifier,
    ]
  );

  syncPermissionGrants(
    identifier,
    manifest.permissions || [],
    existingPermissions
  );

  return getExtensionByIdentifier(identifier)!;
}

// ─── Remove ──────────────────────────────────────────────────────────────

export function remove(identifier: string): void {
  const db = getDb();
  const ext = db
    .query("SELECT id FROM extensions WHERE identifier = ?")
    .get(identifier) as { id: string } | null;

  if (!ext) throw new Error(`Extension not found: ${identifier}`);

  db.run("DELETE FROM extensions WHERE id = ?", [ext.id]);

  const dir = extensionDir(identifier);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Enable / Disable ────────────────────────────────────────────────────

export function enable(identifier: string): void {
  const db = getDb();
  const result = db.run(
    "UPDATE extensions SET enabled = 1, updated_at = unixepoch() WHERE identifier = ?",
    [identifier]
  );
  if (result.changes === 0) throw new Error(`Extension not found: ${identifier}`);

  // Grant non-privileged requested permissions on first enable
  const row = db
    .query("SELECT permissions FROM extensions WHERE identifier = ?")
    .get(identifier) as { permissions: string } | null;
  if (row) {
    const requested = JSON.parse(row.permissions || "[]") as string[];
    grantRequestedPermissionsByDefault(identifier, requested);
  }
}

export function disable(identifier: string): void {
  const db = getDb();
  const result = db.run(
    "UPDATE extensions SET enabled = 0, updated_at = unixepoch() WHERE identifier = ?",
    [identifier]
  );
  if (result.changes === 0) throw new Error(`Extension not found: ${identifier}`);
}

// ─── Permissions ─────────────────────────────────────────────────────────

export function grantPermission(
  identifier: string,
  permission: string
): void {
  if (!isValidPermission(permission)) {
    throw new Error(`Invalid permission: ${permission}`);
  }

  const db = getDb();
  const ext = db
    .query("SELECT id FROM extensions WHERE identifier = ?")
    .get(identifier) as { id: string } | null;
  if (!ext) throw new Error(`Extension not found: ${identifier}`);

  db.run(
    `INSERT OR IGNORE INTO extension_grants (id, extension_id, permission) VALUES (?, ?, ?)`,
    [crypto.randomUUID(), ext.id, permission]
  );
}

export function revokePermission(
  identifier: string,
  permission: string
): void {
  const db = getDb();
  const ext = db
    .query("SELECT id FROM extensions WHERE identifier = ?")
    .get(identifier) as { id: string } | null;
  if (!ext) throw new Error(`Extension not found: ${identifier}`);

  db.run(
    "DELETE FROM extension_grants WHERE extension_id = ? AND permission = ?",
    [ext.id, permission]
  );
}

export function getGrantedPermissions(identifier: string): SpindlePermission[] {
  const db = getDb();
  const ext = db
    .query("SELECT id FROM extensions WHERE identifier = ?")
    .get(identifier) as { id: string } | null;
  if (!ext) return [];

  const rows = db
    .query("SELECT permission FROM extension_grants WHERE extension_id = ?")
    .all(ext.id) as { permission: string }[];

  return rows.map((r) => r.permission as SpindlePermission);
}

export function hasPermission(
  identifier: string,
  permission: SpindlePermission
): boolean {
  return getGrantedPermissions(identifier).includes(permission);
}

// ─── Queries ─────────────────────────────────────────────────────────────

export function list(): ExtensionInfo[] {
  const db = getDb();
  const rows = db.query("SELECT * FROM extensions ORDER BY installed_at DESC").all() as any[];
  return rows.map(rowToExtensionInfo);
}

export function listForUser(userId: string, role: string | null | undefined): ExtensionInfo[] {
  if (role === "owner" || role === "admin") {
    return list();
  }

  const db = getDb();
  const rows = db
    .query(
      `SELECT * FROM extensions
       WHERE install_scope = 'operator' OR installed_by_user_id = ?
       ORDER BY installed_at DESC`
    )
    .all(userId) as any[];

  return rows.map(rowToExtensionInfo);
}

export function getExtension(id: string): ExtensionInfo | null {
  const db = getDb();
  const row = db.query("SELECT * FROM extensions WHERE id = ?").get(id) as any;
  return row ? rowToExtensionInfo(row) : null;
}

export function getExtensionForUser(
  id: string,
  userId: string,
  role: string | null | undefined
): ExtensionInfo | null {
  if (role === "owner" || role === "admin") {
    return getExtension(id);
  }

  const db = getDb();
  const row = db
    .query(
      `SELECT * FROM extensions
       WHERE id = ? AND (install_scope = 'operator' OR installed_by_user_id = ?)`
    )
    .get(id, userId) as any;

  return row ? rowToExtensionInfo(row) : null;
}

export function canManageExtension(
  extension: ExtensionInfo,
  userId: string,
  role: string | null | undefined
): boolean {
  if (role === "owner" || role === "admin") return true;
  const metadata = (extension.metadata || {}) as Record<string, unknown>;
  return (
    metadata.install_scope === "user" &&
    typeof metadata.installed_by_user_id === "string" &&
    metadata.installed_by_user_id === userId
  );
}

export function getExtensionByIdentifier(
  identifier: string
): ExtensionInfo | null {
  const db = getDb();
  const row = db
    .query("SELECT * FROM extensions WHERE identifier = ?")
    .get(identifier) as any;
  return row ? rowToExtensionInfo(row) : null;
}

export function getManifest(identifier: string): SpindleManifest {
  return readManifest(identifier);
}

export function getEnabledExtensions(): ExtensionInfo[] {
  const db = getDb();
  const rows = db
    .query("SELECT * FROM extensions WHERE enabled = 1")
    .all() as any[];
  return rows.map(rowToExtensionInfo);
}

export function getFrontendBundlePath(identifier: string): string | null {
  const manifest = readManifest(identifier);
  const entry = manifest.entry_frontend || "dist/frontend.js";
  const repo = repoDir(identifier);
  const bundlePath = resolveWithin(repo, entry, "entry_frontend");
  return existsSync(bundlePath) ? bundlePath : null;
}

export function getBackendEntryPath(identifier: string): string | null {
  const manifest = readManifest(identifier);
  const entry = manifest.entry_backend || "dist/backend.js";
  const repo = repoDir(identifier);
  const entryPath = resolveWithin(repo, entry, "entry_backend");
  return existsSync(entryPath) ? entryPath : null;
}

export function getStoragePath(identifier: string): string {
  const dir = storageDir(identifier);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getStoragePathForExtension(extension: ExtensionInfo): string {
  const metadata = (extension.metadata || {}) as Record<string, unknown>;
  const scope = metadata.install_scope;
  const owner = metadata.installed_by_user_id;

  if (scope === "user" && typeof owner === "string" && owner.trim()) {
    return getUserExtensionStoragePath(extension.identifier, owner);
  }

  return getStoragePath(extension.identifier);
}

export function getUserExtensionStoragePath(identifier: string, userId: string): string {
  const dir = getUserExtensionPath(userId, identifier);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function importLocalExtensions(): Promise<{
  imported: ExtensionInfo[];
  skipped: Array<{ identifier?: string; path: string; reason: string }>;
}> {
  const base = extensionsDir();
  mkdirSync(base, { recursive: true });

  const imported: ExtensionInfo[] = [];
  const skipped: Array<{ identifier?: string; path: string; reason: string }> = [];

  const dirs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !name.startsWith("_temp_"));

  for (const dirName of dirs) {
    const candidateRoot = join(base, dirName);

    try {
      const nestedManifestPath = join(candidateRoot, "repo", "spindle.json");
      const nestedSpindleFilePath = join(candidateRoot, "repo", "spindlefile");
      const nestedSpindleFileJsonPath = join(candidateRoot, "repo", "spindlefile.json");
      const rootManifestPath = join(candidateRoot, "spindle.json");
      const rootSpindleFilePath = join(candidateRoot, "spindlefile");
      const rootSpindleFileJsonPath = join(candidateRoot, "spindlefile.json");

      let manifestPath: string | null = null;
      if (existsSync(nestedManifestPath)) manifestPath = nestedManifestPath;
      else if (existsSync(nestedSpindleFilePath)) manifestPath = nestedSpindleFilePath;
      else if (existsSync(nestedSpindleFileJsonPath)) manifestPath = nestedSpindleFileJsonPath;
      else if (existsSync(rootManifestPath)) manifestPath = rootManifestPath;
      else if (existsSync(rootSpindleFilePath)) manifestPath = rootSpindleFilePath;
      else if (existsSync(rootSpindleFileJsonPath)) manifestPath = rootSpindleFileJsonPath;
      else {
        skipped.push({
          path: candidateRoot,
          reason: "No spindle manifest found (spindle.json/spindlefile)",
        });
        continue;
      }

      const manifest = readManifestFromPath(manifestPath, {
        allowMissingGithub: true,
      });

      // If user dropped the repo directly under extensions/<folder>, normalize layout
      if (
        manifestPath === rootManifestPath ||
        manifestPath === rootSpindleFilePath ||
        manifestPath === rootSpindleFileJsonPath
      ) {
        const desiredRoot = extensionDir(manifest.identifier);

        // If folder name differs from manifest identifier, move folder first
        if (candidateRoot !== desiredRoot) {
          if (existsSync(desiredRoot)) {
            throw new Error(
              `Target directory already exists for identifier ${manifest.identifier}`
            );
          }
          moveSync(candidateRoot, desiredRoot);
        }

        ensureRepoLayoutForIdentifier(manifest.identifier);
      } else {
        // Already nested layout, but ensure root directory matches identifier if needed
        const desiredRoot = extensionDir(manifest.identifier);
        if (candidateRoot !== desiredRoot) {
          if (existsSync(desiredRoot)) {
            throw new Error(
              `Target directory already exists for identifier ${manifest.identifier}`
            );
          }
          moveSync(candidateRoot, desiredRoot);
        }
      }

      mkdirSync(storageDir(manifest.identifier), { recursive: true });
      await buildExtension(manifest.identifier);
      applyStorageSeeds(manifest.identifier, manifest);
      insertExtensionFromManifest(manifest);

      const ext = getExtensionByIdentifier(manifest.identifier);
      if (ext) imported.push(ext);
    } catch (err: any) {
      skipped.push({
        path: candidateRoot,
        reason: err?.message || "Unknown error",
      });
    }
  }

  return { imported, skipped };
}

// ─── Branch Management ────────────────────────────────────────────────────

/** List remote branches from a GitHub URL (pre-install discovery). */
export function listRemoteBranches(githubUrl: string): string[] {
  const proc = Bun.spawnSync({
    cmd: ["git", "ls-remote", "--heads", githubUrl],
    timeout: 15_000,
  });
  if (proc.exitCode !== 0) {
    throw new Error(`Failed to list remote branches: ${proc.stderr.toString()}`);
  }
  const output = proc.stdout.toString().trim();
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => line.replace(/^.*refs\/heads\//, ""))
    .filter(Boolean);
}

/** List branches for an already-installed extension by querying its remote. */
export function getBranches(identifier: string): { current: string | null; branches: string[] } {
  const repo = repoDir(identifier);
  if (!existsSync(repo)) {
    throw new Error(`Extension repo not found: ${identifier}`);
  }

  // Get current branch
  const headProc = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    cwd: repo,
  });
  const current = headProc.exitCode === 0 ? headProc.stdout.toString().trim() : null;

  // List remote branches
  const proc = Bun.spawnSync({
    cmd: ["git", "ls-remote", "--heads", "origin"],
    cwd: repo,
    timeout: 15_000,
  });
  if (proc.exitCode !== 0) {
    return { current, branches: current ? [current] : [] };
  }
  const output = proc.stdout.toString().trim();
  const branches = output
    ? output
        .split("\n")
        .map((line) => line.replace(/^.*refs\/heads\//, ""))
        .filter(Boolean)
    : [];

  return { current, branches };
}

/** Switch an installed extension to a different branch, rebuild, and update DB. */
export async function switchBranch(
  identifier: string,
  branch: string
): Promise<ExtensionInfo> {
  const repo = repoDir(identifier);
  if (!existsSync(repo)) {
    throw new Error(`Extension repo not found: ${identifier}`);
  }

  // Clean working tree
  Bun.spawnSync({ cmd: ["git", "checkout", "."], cwd: repo });
  Bun.spawnSync({ cmd: ["git", "clean", "-fd"], cwd: repo });

  // Widen the fetch refspec — shallow/single-branch clones only track one branch
  Bun.spawnSync({
    cmd: ["git", "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
    cwd: repo,
  });

  // Fetch the target branch (--depth=1 to keep it shallow)
  const fetchProc = Bun.spawnSync({
    cmd: ["git", "fetch", "--depth", "1", "origin", branch],
    cwd: repo,
    timeout: 30_000,
  });
  if (fetchProc.exitCode !== 0) {
    throw new Error(`git fetch failed: ${fetchProc.stderr.toString()}`);
  }

  // Checkout the branch
  const checkoutProc = Bun.spawnSync({
    cmd: ["git", "checkout", "-B", branch, `origin/${branch}`],
    cwd: repo,
  });
  if (checkoutProc.exitCode !== 0) {
    throw new Error(`git checkout failed: ${checkoutProc.stderr.toString()}`);
  }

  // Re-read manifest
  const manifest = readManifest(identifier);

  const db = getDb();
  const existing = db
    .query("SELECT permissions FROM extensions WHERE identifier = ?")
    .get(identifier) as { permissions: string } | null;
  const existingPermissions = existing
    ? (JSON.parse(existing.permissions || "[]") as string[])
    : [];

  // Rebuild — only delete dist/ if it was locally built (not tracked in git).
  // Repos that ship pre-built dist/ should have those files preserved.
  const srcDir = join(repo, "src");
  const hasBuildableSrc =
    existsSync(srcDir) &&
    (existsSync(join(srcDir, "backend.ts")) || existsSync(join(srcDir, "frontend.ts")));

  if (hasBuildableSrc) {
    const distDir = join(repo, "dist");
    if (existsSync(distDir)) {
      const lsFiles = Bun.spawnSync({
        cmd: ["git", "ls-files", "dist"],
        cwd: repo,
      });
      const distIsTracked = lsFiles.exitCode === 0 && lsFiles.stdout.toString().trim().length > 0;
      if (!distIsTracked) {
        rmSync(distDir, { recursive: true });
      }
    }
  }
  await buildExtension(identifier);
  applyStorageSeeds(identifier, manifest);

  // Update DB
  db.run(
    `UPDATE extensions SET name = ?, version = ?, author = ?, description = ?,
     github = ?, homepage = ?, permissions = ?, branch = ?, updated_at = unixepoch()
     WHERE identifier = ?`,
    [
      manifest.name,
      manifest.version,
      manifest.author,
      manifest.description || "",
      manifest.github,
      manifest.homepage || "",
      JSON.stringify(manifest.permissions || []),
      branch,
      identifier,
    ]
  );

  syncPermissionGrants(
    identifier,
    manifest.permissions || [],
    existingPermissions
  );

  return getExtensionByIdentifier(identifier)!;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function rowToExtensionInfo(row: any): ExtensionInfo {
  const identifier = row.identifier;
  const permissions: SpindlePermission[] = JSON.parse(row.permissions || "[]");
  const granted = getGrantedPermissions(identifier);

  let hasFrontend = false;
  let hasBackend = false;
  try {
    hasFrontend = getFrontendBundlePath(identifier) !== null;
    hasBackend = getBackendEntryPath(identifier) !== null;
  } catch {
    // Extension files may not exist
  }

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata || "{}") || {};
  } catch {
    metadata = {};
  }

  metadata.install_scope = row.install_scope || "operator";
  metadata.installed_by_user_id = row.installed_by_user_id || null;
  metadata.branch = row.branch || null;

  return {
    id: row.id,
    identifier,
    name: row.name,
    version: row.version,
    author: row.author,
    description: row.description || "",
    github: row.github,
    homepage: row.homepage || "",
    permissions,
    granted_permissions: granted,
    enabled: row.enabled === 1,
    installed_at: row.installed_at,
    updated_at: row.updated_at,
    has_frontend: hasFrontend,
    has_backend: hasBackend,
    status: row.enabled === 1 ? "stopped" : "stopped", // Updated by lifecycle
    metadata,
  };
}
