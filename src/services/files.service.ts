import { env } from "../env";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { join, extname, resolve, sep } from "path";
import { withUserDataMutation } from "./user-data/snapshot";

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
async function saveUploadUnsafe(file: File, userId: string, subdir: string = "uploads"): Promise<string> {
  const dir = join(env.dataDir, subdir, userId);
  ensureDir(dir);

  const ext = extname(file.name) || ".bin";
  const filename = `${crypto.randomUUID()}${ext}`;
  const filepath = join(dir, filename);

  await Bun.write(filepath, file);
  return filename;
}

export async function saveUpload(file: File, userId: string, subdir: string = "uploads"): Promise<string> {
  return withUserDataMutation(userId, () => saveUploadUnsafe(file, userId, subdir));
}

async function saveAvatarUnsafe(file: File): Promise<string> {
  const dir = join(env.dataDir, "avatars");
  ensureDir(dir);

  const ext = extname(file.name) || ".bin";
  const filename = `${crypto.randomUUID()}${ext}`;
  const filepath = join(dir, filename);

  await Bun.write(filepath, file);
  return filename;
}

export async function saveAvatar(file: File, userId: string): Promise<string> {
  return withUserDataMutation(userId, () => saveAvatarUnsafe(file));
}

/** Get avatar file path (global, not user-scoped) */
export async function getAvatarPath(filename: string): Promise<string | null> {
  const base = resolve(env.dataDir, "avatars");
  const filepath = resolve(base, filename);
  if (!filepath.startsWith(base + sep) && filepath !== base) return null;
  if (!(await Bun.file(filepath).exists())) return null;
  return filepath;
}
async function deleteAvatarUnsafe(filename: string): Promise<boolean> {
  const base = resolve(env.dataDir, "avatars");
  const filepath = resolve(base, filename);
  if (!filepath.startsWith(base + sep) && filepath !== base) return false;
  if (!(await Bun.file(filepath).exists())) return false;
  unlinkSync(filepath);
  return true;
}

export async function deleteAvatar(filename: string, userId: string): Promise<boolean> {
  return withUserDataMutation(userId, () => deleteAvatarUnsafe(filename));
}
export async function getFilePath(userId: string, filename: string, subdir: string = "uploads"): Promise<string | null> {
  const scopedBase = resolve(env.dataDir, subdir, userId);
  const scopedPath = resolve(scopedBase, filename);
  if (
    (scopedPath.startsWith(scopedBase + sep) || scopedPath === scopedBase) &&
    (await Bun.file(scopedPath).exists())
  ) {
    return scopedPath;
  }

  const legacyBase = resolve(env.dataDir, subdir);
  const legacyPath = resolve(legacyBase, filename);
  if (!legacyPath.startsWith(legacyBase + sep) && legacyPath !== legacyBase) return null;
  if (!(await Bun.file(legacyPath).exists())) return null;
  return legacyPath;
}

async function deleteFileUnsafe(userId: string, filename: string, subdir: string = "uploads"): Promise<boolean> {
  const scopedBase = resolve(env.dataDir, subdir, userId);
  const scopedPath = resolve(scopedBase, filename);
  if (
    (scopedPath.startsWith(scopedBase + sep) || scopedPath === scopedBase) &&
    (await Bun.file(scopedPath).exists())
  ) {
    unlinkSync(scopedPath);
    return true;
  }

  const legacyBase = resolve(env.dataDir, subdir);
  const legacyPath = resolve(legacyBase, filename);
  if (!legacyPath.startsWith(legacyBase + sep) && legacyPath !== legacyBase) return false;
  if (!(await Bun.file(legacyPath).exists())) return false;
  unlinkSync(legacyPath);
  return true;
}

export async function deleteFile(userId: string, filename: string, subdir: string = "uploads"): Promise<boolean> {
  return withUserDataMutation(userId, () => deleteFileUnsafe(userId, filename, subdir));
}
