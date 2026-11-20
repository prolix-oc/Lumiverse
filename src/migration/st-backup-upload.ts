import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { env } from "../env";
import {
  ArchiveValidationError,
  extractSelectedZipEntries,
  persistUploadedArchive,
} from "../services/user-data/import.service";
import { scanSTData, type STDataCounts } from "./st-reader";

const USER_DATA_DIRECTORIES = new Set([
  "characters",
  "chats",
  "groups",
  "group chats",
  "worlds",
  "User Avatars",
]);
const USER_DATA_FILES = new Set(["settings.json", "secrets.json"]);
const STAGED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export type StBackupUploadErrorCode = "busy" | "invalid_layout";

export class StBackupUploadError extends Error {
  constructor(public code: StBackupUploadErrorCode, message: string) {
    super(message);
    this.name = "StBackupUploadError";
  }
}

export interface StagedStBackup {
  uploadId: string;
  callerUserId: string;
  fileName: string;
  dataDir: string;
  rootDir: string;
  createdAt: number;
  counts: STDataCounts;
}

export interface StBackupUploadResult {
  uploadId: string;
  fileName: string;
  counts: STDataCounts;
}

const stagedUploads = new Map<string, StagedStBackup>();
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let activeUploadId: string | null = null;

function removeRoot(rootDir: string): void {
  try {
    if (existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[st-migration] could not remove staged ZIP directory ${rootDir}:`, err);
  }
}

function removeStagedRecord(upload: StagedStBackup): void {
  stagedUploads.delete(upload.uploadId);
  const timer = expiryTimers.get(upload.uploadId);
  if (timer) clearTimeout(timer);
  expiryTimers.delete(upload.uploadId);
  removeRoot(upload.rootDir);
}

function scheduleExpiry(upload: StagedStBackup): void {
  const timer = setTimeout(() => {
    const current = stagedUploads.get(upload.uploadId);
    if (current) removeStagedRecord(current);
  }, STAGED_UPLOAD_TTL_MS);
  timer.unref?.();
  expiryTimers.set(upload.uploadId, timer);
}

function pruneExpiredUploads(now = Date.now()): void {
  for (const upload of stagedUploads.values()) {
    if (now - upload.createdAt > STAGED_UPLOAD_TTL_MS) removeStagedRecord(upload);
  }
}

function normalizeFileName(value: string | undefined): string {
  const trimmed = value?.trim() || "sillytavern-backup.zip";
  return trimmed.replace(/[\x00-\x1f]/g, "").slice(0, 255) || "sillytavern-backup.zip";
}

interface SelectedStEntry {
  outputPath: string;
  userRoot: string;
  topLevelName: string;
}

function selectStUserEntry(rawName: string): SelectedStEntry | null {
  if (
    !rawName ||
    rawName.length > 4096 ||
    /[\x00-\x1f]/.test(rawName) ||
    rawName.includes("\\") ||
    /^([a-zA-Z]:|\/)/.test(rawName)
  ) {
    throw new ArchiveValidationError("not_zip", `unsafe ZIP entry path: ${rawName}`);
  }

  const isDirectory = rawName.endsWith("/");
  const path = isDirectory ? rawName.slice(0, -1) : rawName;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ArchiveValidationError("not_zip", `unsafe ZIP entry path: ${rawName}`);
  }
  if (segments[0] === "__MACOSX") return null;

  let dataIndex = -1;
  for (let i = 0; i < Math.min(segments.length, 4); i++) {
    const segment = segments[i];
    if (!USER_DATA_DIRECTORIES.has(segment) && !USER_DATA_FILES.has(segment)) continue;
    // Supported archive shapes:
    //   characters/...                       (web user backup)
    //   default-user/characters/...          (wrapped user backup)
    //   data/default-user/characters/...     (full ST layout)
    //   SillyTavern/data/user/characters/... (wrapped full ST layout)
    if (i <= 1 || (i >= 2 && segments[i - 2] === "data")) dataIndex = i;
    break;
  }
  if (dataIndex < 0) return null;

  const topLevelName = segments[dataIndex];
  if (USER_DATA_FILES.has(topLevelName)) {
    if (dataIndex !== segments.length - 1) return null;
    if (isDirectory) {
      throw new ArchiveValidationError("not_zip", `ZIP contains a directory where ${topLevelName} should be a file`);
    }
  }
  if (
    USER_DATA_DIRECTORIES.has(topLevelName) &&
    dataIndex === segments.length - 1 &&
    !isDirectory
  ) {
    throw new ArchiveValidationError("not_zip", `ZIP contains a file where ${topLevelName}/ should be a directory`);
  }
  const userRoot = segments.slice(0, dataIndex).join("/");
  return {
    outputPath: `${segments.join("/")}${isDirectory ? "/" : ""}`,
    userRoot,
    topLevelName,
  };
}

function resolveInside(baseDir: string, relativePath: string): string {
  const base = resolve(baseDir);
  const candidate = relativePath ? resolve(base, relativePath) : base;
  if (candidate !== base && !candidate.startsWith(base + sep)) {
    throw new StBackupUploadError("invalid_layout", "SillyTavern backup root escapes staging directory");
  }
  return candidate;
}

export async function stageStBackupArchive(options: {
  callerUserId: string;
  body: ReadableStream<Uint8Array>;
  declaredSize: number | null;
  fileName?: string;
}): Promise<StBackupUploadResult> {
  pruneExpiredUploads();
  if (activeUploadId !== null) {
    throw new StBackupUploadError("busy", "another SillyTavern backup is currently being processed");
  }

  const uploadId = crypto.randomUUID();
  activeUploadId = uploadId;
  let rootDir = join(env.dataDir, "imports", options.callerUserId, uploadId);
  try {
    // Keep only one unclaimed staged backup per caller.
    for (const upload of stagedUploads.values()) {
      if (upload.callerUserId === options.callerUserId) removeStagedRecord(upload);
    }

    const persisted = await persistUploadedArchive(
      options.callerUserId,
      options.body,
      options.declaredSize,
      uploadId,
    );
    rootDir = dirname(persisted.path);
    const extractionDir = join(rootDir, "st-data");
    mkdirSync(extractionDir, { recursive: true });

    const candidateRoots = new Set<string>();
    let selectedRoot = "";
    await extractSelectedZipEntries({
      archivePath: persisted.path,
      destinationDir: extractionDir,
      selectEntry(name) {
        const selected = selectStUserEntry(name);
        if (!selected) return null;
        if (selected.topLevelName === "characters") candidateRoots.add(selected.userRoot);
        return selected.outputPath;
      },
      validateSelection() {
        if (candidateRoots.size === 0) {
          throw new StBackupUploadError(
            "invalid_layout",
            "ZIP does not contain a SillyTavern user folder with characters/",
          );
        }
        if (candidateRoots.size > 1) {
          throw new StBackupUploadError(
            "invalid_layout",
            "ZIP contains more than one possible SillyTavern user folder",
          );
        }
        selectedRoot = candidateRoots.values().next().value ?? "";
      },
    });

    try { unlinkSync(persisted.path); } catch { /* extraction is already complete */ }
    const dataDir = resolveInside(extractionDir, selectedRoot);
    const charactersDir = join(dataDir, "characters");
    if (!existsSync(charactersDir)) mkdirSync(charactersDir, { recursive: true });
    const counts = await scanSTData(dataDir);
    const staged: StagedStBackup = {
      uploadId,
      callerUserId: options.callerUserId,
      fileName: normalizeFileName(options.fileName),
      dataDir,
      rootDir,
      createdAt: Date.now(),
      counts,
    };
    stagedUploads.set(uploadId, staged);
    scheduleExpiry(staged);
    return { uploadId, fileName: staged.fileName, counts };
  } catch (err) {
    removeRoot(rootDir);
    throw err;
  } finally {
    if (activeUploadId === uploadId) activeUploadId = null;
  }
}

export function getStagedStBackup(uploadId: string, callerUserId: string): StagedStBackup | null {
  pruneExpiredUploads();
  const upload = stagedUploads.get(uploadId);
  if (!upload || upload.callerUserId !== callerUserId) return null;
  return upload;
}

/** Remove a staged backup from the registry while leaving its files available to the caller. */
export function claimStagedStBackup(uploadId: string, callerUserId: string): StagedStBackup | null {
  const upload = getStagedStBackup(uploadId, callerUserId);
  if (!upload) return null;
  stagedUploads.delete(uploadId);
  const timer = expiryTimers.get(uploadId);
  if (timer) clearTimeout(timer);
  expiryTimers.delete(uploadId);
  return upload;
}

export function discardStagedStBackup(uploadId: string, callerUserId: string): boolean {
  const upload = getStagedStBackup(uploadId, callerUserId);
  if (!upload) return false;
  removeStagedRecord(upload);
  return true;
}

export function cleanupClaimedStBackup(upload: StagedStBackup): void {
  removeRoot(upload.rootDir);
}

/** Test-only state reset; staged production uploads are otherwise TTL- or lifecycle-cleaned. */
export function resetStBackupUploadState(): void {
  for (const upload of stagedUploads.values()) removeRoot(upload.rootDir);
  stagedUploads.clear();
  for (const timer of expiryTimers.values()) clearTimeout(timer);
  expiryTimers.clear();
  activeUploadId = null;
}
