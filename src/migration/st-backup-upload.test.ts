import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { env } from "../env";
import { ArchiveValidationError } from "../services/user-data/import.service";
import {
  StBackupUploadError,
  claimStagedStBackup,
  cleanupClaimedStBackup,
  getStagedStBackup,
  resetStBackupUploadState,
  stageStBackupArchive,
} from "./st-backup-upload";

const CALLER_ID = "st-backup-test-owner";

function bodyFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function stage(files: Record<string, Uint8Array>) {
  const bytes = zipSync(files);
  return stageStBackupArchive({
    callerUserId: CALLER_ID,
    body: bodyFrom(bytes),
    declaredSize: bytes.byteLength,
    fileName: "default-user.zip",
  });
}

describe("SillyTavern web backup staging", () => {
  let workDir = "";
  let originalDataDir = "";

  beforeEach(() => {
    originalDataDir = env.dataDir;
    workDir = mkdtempSync(join(tmpdir(), "st-backup-upload-"));
    env.dataDir = workDir;
    resetStBackupUploadState();
  });

  afterEach(() => {
    resetStBackupUploadState();
    env.dataDir = originalDataDir;
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  test("stages a flat ST user-folder backup and extracts only migration inputs", async () => {
    const result = await stage({
      "characters/Alice.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      "chats/Alice/First.jsonl": strToU8("{}\n"),
      "worlds/Example.json": strToU8('{"name":"Example","entries":{}}'),
      "settings.json": strToU8('{"power_user":{"personas":{}}}'),
      "thumbnails/avatar/Alice.png": new Uint8Array([1, 2, 3]),
    });

    expect(result).toMatchObject({
      fileName: "default-user.zip",
      counts: { characters: 1, chatDirs: 1, totalChatFiles: 1, worldBooks: 1 },
    });
    const staged = getStagedStBackup(result.uploadId, CALLER_ID)!;
    expect(existsSync(join(staged.dataDir, "characters", "Alice.png"))).toBe(true);
    expect(existsSync(join(staged.dataDir, "thumbnails"))).toBe(false);

    const claimed = claimStagedStBackup(result.uploadId, CALLER_ID)!;
    expect(getStagedStBackup(result.uploadId, CALLER_ID)).toBeNull();
    cleanupClaimedStBackup(claimed);
    expect(existsSync(claimed.rootDir)).toBe(false);
  });

  test("recognizes a backup wrapped in a user directory", async () => {
    const result = await stage({
      "default-user/characters/Alice.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      "default-user/worlds/Example.json": strToU8('{"name":"Example","entries":{}}'),
    });

    const staged = getStagedStBackup(result.uploadId, CALLER_ID)!;
    expect(staged.dataDir.endsWith(join("st-data", "default-user"))).toBe(true);
    expect(result.counts.characters).toBe(1);
    expect(result.counts.worldBooks).toBe(1);
  });

  test("rejects traversal paths before extraction", async () => {
    let error: unknown;
    try {
      await stage({
        "characters/Alice.png": new Uint8Array([1]),
        "../characters/evil.png": new Uint8Array([2]),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ArchiveValidationError);
    expect((error as ArchiveValidationError).message).toContain("unsafe ZIP entry path");
  });

  test("rejects archives with multiple possible ST user roots", async () => {
    let error: unknown;
    try {
      await stage({
        "one/characters/Alice.png": new Uint8Array([1]),
        "two/characters/Bob.png": new Uint8Array([2]),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(StBackupUploadError);
    expect((error as StBackupUploadError).code).toBe("invalid_layout");
  });
});
