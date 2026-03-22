import { env } from "../env";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { join, extname, resolve, sep } from "path";

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export async function saveUpload(file: File, userId: string, subdir: string = "uploads"): Promise<string> {
  const dir = join(env.dataDir, subdir, userId);
  ensureDir(dir);

  const ext = extname(file.name) || ".bin";
  const filename = `${crypto.randomUUID()}${ext}`;
  const filepath = join(dir, filename);

  await Bun.write(filepath, file);
  return filename;
}

export async function saveAvatar(file: File): Promise<string> {
  // Avatars remain global (not user-scoped) — they're referenced by characters/personas
  const dir = join(env.dataDir, "avatars");
  ensureDir(dir);

  const ext = extname(file.name) || ".bin";
  const filename = `${crypto.randomUUID()}${ext}`;
  const filepath = join(dir, filename);

  await Bun.write(filepath, file);
  return filename;
}

/** Get avatar file path (global, not user-scoped) */
export function getAvatarPath(filename: string): string | null {
  const base = resolve(env.dataDir, "avatars");
  const filepath = resolve(base, filename);
  if (!filepath.startsWith(base + sep) && filepath !== base) return null;
  if (!existsSync(filepath)) return null;
  return filepath;
}

/** Delete avatar file (global, not user-scoped) */
export function deleteAvatar(filename: string): boolean {
  const base = resolve(env.dataDir, "avatars");
  const filepath = resolve(base, filename);
  if (!filepath.startsWith(base + sep) && filepath !== base) return false;
  if (!existsSync(filepath)) return false;
  unlinkSync(filepath);
  return true;
}

export function getFilePath(userId: string, filename: string, subdir: string = "uploads"): string | null {
  // Try user-scoped path first
  const scopedBase = resolve(env.dataDir, subdir, userId);
  const scopedPath = resolve(scopedBase, filename);
  if (
    (scopedPath.startsWith(scopedBase + sep) || scopedPath === scopedBase) &&
    existsSync(scopedPath)
  ) {
    return scopedPath;
  }

  // Fall back to legacy flat path for pre-migration files
  const legacyBase = resolve(env.dataDir, subdir);
  const legacyPath = resolve(legacyBase, filename);
  if (!legacyPath.startsWith(legacyBase + sep) && legacyPath !== legacyBase) return null;
  if (!existsSync(legacyPath)) return null;
  return legacyPath;
}

export function deleteFile(userId: string, filename: string, subdir: string = "uploads"): boolean {
  // Try user-scoped path first
  const scopedBase = resolve(env.dataDir, subdir, userId);
  const scopedPath = resolve(scopedBase, filename);
  if (
    (scopedPath.startsWith(scopedBase + sep) || scopedPath === scopedBase) &&
    existsSync(scopedPath)
  ) {
    unlinkSync(scopedPath);
    return true;
  }

  // Fall back to legacy flat path
  const legacyBase = resolve(env.dataDir, subdir);
  const legacyPath = resolve(legacyBase, filename);
  if (!legacyPath.startsWith(legacyBase + sep) && legacyPath !== legacyBase) return false;
  if (!existsSync(legacyPath)) return false;
  unlinkSync(legacyPath);
  return true;
}
