import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { env } from "../../env";
import { __testing, reconcileStaleExportStaging, scrubArchiveRowPrivateData } from "./export.service";
import { freezeFileDescriptor } from "./snapshot";
import { strictestMediaLimit } from "../../types/media-limits";

const originalDataDir = env.dataDir;
const temporaryRoots: string[] = [];

afterEach(() => {
  env.dataDir = originalDataDir;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("portable archive row privacy", () => {
  test("removes private reasoning carriers from rows and nested message extra", () => {
    const scrubbed = scrubArchiveRowPrivateData({
      id: "message-1",
      reasoningCarrier: { type: "reasoning_content", content: "private" },
      reasoningCarrierBySwipe: [{ type: "thinking_blocks", blocks: ["private"] }],
      extra: JSON.stringify({
        visible: "retain",
        reasoningCarrier: { type: "reasoning_details", details: [{ text: "private" }] },
        nested: {
          reasoningCarrierBySwipe: [{ type: "reasoning_content", content: "private" }],
          visible: true,
        },
        list: [{ reasoningCarrier: { content: "private" }, value: 7 }],
      }),
    });

    expect(scrubbed).not.toHaveProperty("reasoningCarrier");
    expect(scrubbed).not.toHaveProperty("reasoningCarrierBySwipe");
    expect(scrubbed).toHaveProperty("id", "message-1");
    const extra = JSON.parse(String(scrubbed.extra)) as Record<string, unknown>;
    expect(extra).toEqual({
      visible: "retain",
      nested: { visible: true },
      list: [{ value: 7 }],
    });
  });
});
describe("export staging startup reconciliation", () => {
  test("removes expired leases but preserves live leases", () => {
    const root = mkdtempSync(join(tmpdir(), "lumiverse-export-reconcile-"));
    temporaryRoots.push(root);
    env.dataDir = root;
    const stale = join(root, ".lvbak-export-stale");
    const live = join(root, ".lvbak-export-live");
    mkdirSync(stale);
    mkdirSync(live);
    writeFileSync(join(stale, ".lease.json"), JSON.stringify({
      version: 1,
      archiveId: "archive-stale",
      ownerToken: "owner-stale",
      createdAt: 0,
      heartbeatAt: 0,
      leaseExpiresAt: 999,
    }));
    writeFileSync(join(live, ".lease.json"), JSON.stringify({
      version: 1,
      archiveId: "archive-live",
      ownerToken: "owner-live",
      createdAt: 1_000,
      heartbeatAt: 1_500,
      leaseExpiresAt: 3_000,
    }));

    expect(reconcileStaleExportStaging(2_000)).toEqual({
      inspected: 2,
      removed: 1,
      preserved: 1,
      failures: 0,
    });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  test("fails closed when the staging scan cannot read the data directory", () => {
    const root = mkdtempSync(join(tmpdir(), "lumiverse-export-reconcile-scan-"));
    temporaryRoots.push(root);
    const dataPath = join(root, "not-a-directory");
    writeFileSync(dataPath, "not a directory");
    env.dataDir = dataPath;
    expect(() => reconcileStaleExportStaging(2_000)).toThrow(/could not read/);
  });
});
describe("bounded archive file staging", () => {
  test("stages one physical file for multiple logical owner aliases", async () => {
    const root = mkdtempSync(join(tmpdir(), "lumiverse-export-alias-"));
    temporaryRoots.push(root);
    const source = join(root, "shared.bin");
    writeFileSync(source, "shared payload");
    const descriptor = await freezeFileDescriptor({
      kind: "audio",
      ownerTable: "audio_files",
      ownerKey: "audio-1",
      path: source,
      required: false,
      allowedRoot: root,
    });
    const aliasDescriptor = Object.freeze({
      ...descriptor,
      ownerTable: "audio_files",
      ownerKey: "audio-2",
      owner: Object.freeze({ table: "audio_files", key: "audio-2" }),
      required: true,
    });
    const stagingDir = join(root, "stage");
    const staged = await __testing.stageArchiveFiles(
      { files: [descriptor, aliasDescriptor] },
      [
        {
          sourcePath: source,
          archivePath: "files/audio/audio-1.bin",
          required: false,
          ownerTable: "audio_files",
          allowedRoot: root,
          ownerKey: "audio-1",
          maxBytes: descriptor.bytes + 1,
        },
        {
          sourcePath: source,
          archivePath: "files/audio/audio-2.bin",
          required: true,
          ownerTable: "audio_files",
          allowedRoot: root,
          ownerKey: "audio-2",
          maxBytes: descriptor.bytes,
        },
      ],
      stagingDir,
      [],
      [],
    );
    expect(staged).toHaveLength(2);
    expect(staged[0]?.stagedPath).toBe(staged[1]?.stagedPath);
    expect(staged[0]?.required).toBe(false);
    expect(staged[1]?.required).toBe(true);
    expect(readdirSync(stagingDir)).toHaveLength(1);
  });

  test("enforces unique-file count and byte caps with cleanup at cap plus one", async () => {
    const root = mkdtempSync(join(tmpdir(), "lumiverse-export-stage-cap-"));
    temporaryRoots.push(root);
    const files = ["aa", "b", "c"].map((content, index) => {
      const path = join(root, `file-${index}.bin`);
      writeFileSync(path, content);
      return path;
    });
    const descriptors = await Promise.all(files.map((path, index) => freezeFileDescriptor({
      kind: "audio",
      ownerTable: "audio_files",
      ownerKey: `audio-${index}`,
      path,
      required: true,
      allowedRoot: root,
    })));
    const refs = files.map((sourcePath, index) => ({
      sourcePath,
      archivePath: `files/audio/file-${index}.bin`,
      required: true,
      ownerTable: "audio_files",
      allowedRoot: root,
      ownerKey: `audio-${index}`,
    }));
    const exactCountDir = join(root, "stage-count-exact");
    const exactCount = await __testing.stageArchiveFiles(
      { files: descriptors.slice(0, 2) },
      refs.slice(0, 2),
      exactCountDir,
      [],
      [],
      undefined,
      { maxFiles: 2, maxBytes: 3 },
    );
    expect(exactCount).toHaveLength(2);
    expect(readdirSync(exactCountDir)).toHaveLength(2);

    const overflowDir = join(root, "stage-count-overflow");
    await expect(__testing.stageArchiveFiles(
      { files: descriptors },
      refs,
      overflowDir,
      [],
      [],
      undefined,
      { maxFiles: 2, maxBytes: 99 },
    )).rejects.toThrow(/too many staged files/);
    expect(existsSync(overflowDir)).toBe(false);

    const byteOverflowDir = join(root, "stage-byte-overflow");
    await expect(__testing.stageArchiveFiles(
      { files: descriptors },
      refs,
      byteOverflowDir,
      [],
      [],
      undefined,
      { maxFiles: 99, maxBytes: 3 },
    )).rejects.toThrow(/staged archive files exceed/);
    expect(existsSync(byteOverflowDir)).toBe(false);
    const perReferenceOverflowDir = join(root, "stage-reference-overflow");
    await expect(__testing.stageArchiveFiles(
      { files: descriptors.slice(0, 1) },
      [{ ...refs[0], maxBytes: 1 }],
      perReferenceOverflowDir,
      [],
      [],
    )).rejects.toThrow(/reference limit/);
    expect(existsSync(perReferenceOverflowDir)).toBe(false);
  });
  test("uses the closed media policy instead of the storage bucket for size caps", () => {
    const ordinaryImageCapPlusOne = 50 * 1024 * 1024 + 1;
    const wallpaperPayload = 200 * 1024 * 1024;
    expect(strictestMediaLimit("images", ordinaryImageCapPlusOne, "image")).toBe(50 * 1024 * 1024);
    expect(strictestMediaLimit("images", wallpaperPayload, "image_or_video")).toBe(wallpaperPayload);
  });
});
