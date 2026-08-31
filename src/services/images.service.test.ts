import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync, statSync } from "fs";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import { resolveFfmpegBinary } from "./ffmpeg-binary.service";
import * as chatsSvc from "./chats.service";
import { SERVER_IMAGE_GENERATION_PROVENANCE } from "./image-provenance";
import * as settingsSvc from "./settings.service";
import {
  WALLPAPER_LIBRARY_OWNER,
  deleteImage,
  deleteImageIfUnreferenced,
  deleteImagesBulk,
  deleteWallpaperLibraryImage,
  discardImageProcessingQueue,
  getDeferredImageProcessingStatus,
  getImage,
  getImageFilePath,
  getImageProcessingRecovery,
  getPublicImageFile,
  listImages,
  rebuildAllThumbnails,
  recoverImageProcessingQueue,
  resetDeferredImageProcessingForTests,
  saveImageFromDataUrl,
  uploadImage,
  uploadImageDeferred,
  uploadImages,
  uploadOptimizedWebpImage,
  waitForDeferredImageProcessing,
} from "./images.service";
import { recordImageProcessingJob } from "./image-processing-queue";
import { deriveWorkerBudget, setWorkerBudgetOverride } from "../utils/cpu-budget";
import { applySharpSettings } from "./sharp-settings.service";
import { readImageMetadata } from "../utils/image-pipeline";

const originalDataDir = env.dataDir;
let testDataDir = "";

function unlinkError(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated unlink failure, unlink '${path}'`), {
    code,
    path,
    syscall: "unlink",
  });
}

function initImagesTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");

  getDb().run(`CREATE TABLE images (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    filename TEXT NOT NULL,
    original_filename TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    byte_size INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    has_thumbnail INTEGER NOT NULL DEFAULT 0,
    skip_thumbnail_processing INTEGER NOT NULL DEFAULT 0,
    owner_extension_identifier TEXT,
    owner_character_id TEXT,
    owner_chat_id TEXT,
    public_provenance TEXT,
    created_at INTEGER NOT NULL
  )`);

  getDb().run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (key, user_id)
  )`);

  getDb().run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    character_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

function seedImage(
  id: string,
  createdAt: number,
  options?: {
    owner_extension_identifier?: string;
    owner_character_id?: string;
    owner_chat_id?: string;
    filename?: string;
    original_filename?: string;
    mime_type?: string;
    public_provenance?: string;
  },
): void {
  getDb()
    .query(
      `INSERT INTO images (
        id,
        user_id,
        filename,
        original_filename,
        mime_type,
        byte_size,
        width,
        height,
        has_thumbnail,
        owner_extension_identifier,
        owner_character_id,
        owner_chat_id,
        public_provenance,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      "u1",
      options?.filename ?? `${id}.png`,
      options?.original_filename ?? `${id}.png`,
      options?.mime_type ?? "image/png",
      4096,
      100,
      100,
      1,
      options?.owner_extension_identifier ?? null,
      options?.owner_character_id ?? null,
      options?.owner_chat_id ?? null,
      options?.public_provenance ?? null,
      createdAt,
    );
}

function seedSetting(key: string, value: unknown, updatedAt = 100): void {
  getDb()
    .query("INSERT INTO settings (key, value, updated_at, user_id) VALUES (?, ?, ?, ?)")
    .run(key, JSON.stringify(value), updatedAt, "u1");
}

function seedChat(id: string, metadata: Record<string, unknown>, updatedAt = 100): void {
  getDb()
    .query(
      `INSERT INTO chats (
        id,
        user_id,
        character_id,
        name,
        metadata,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, "u1", "char-1", "Test Chat", JSON.stringify(metadata), updatedAt, updatedAt);
}

beforeEach(() => {
  resetDeferredImageProcessingForTests();
  setWorkerBudgetOverride(null);
  applySharpSettings({});
  initImagesTestDb();
  testDataDir = mkdtempSync(join(tmpdir(), "lumiverse-images-test-"));
  env.dataDir = testDataDir;
});

afterEach(() => {
  resetDeferredImageProcessingForTests();
  setWorkerBudgetOverride(null);
  applySharpSettings({});
  closeDatabase();
  env.dataDir = originalDataDir;
  if (testDataDir) {
    rmSync(testDataDir, { recursive: true, force: true });
    testDataDir = "";
  }
});
describe("images.service public results", () => {
  test("does not treat a filename prefix as public provenance", async () => {
    seedImage("spoofed", 100, {
      filename: "spoofed.png",
      original_filename: "image-gen-spoof.png",
    });
    const imagesDir = join(env.dataDir, "images");
    mkdirSync(imagesDir, { recursive: true });
    writeFileSync(join(imagesDir, "spoofed.png"), Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));

    await expect(getPublicImageFile("spoofed")).resolves.toBeNull();
  });

  test("serves only server-provenanced valid media with a canonical type", async () => {
    seedImage("generated", 100, {
      filename: "generated.png",
      original_filename: "image-gen-test.png",
      public_provenance: SERVER_IMAGE_GENERATION_PROVENANCE,
    });
    const imagesDir = join(env.dataDir, "images");
    mkdirSync(imagesDir, { recursive: true });
    writeFileSync(join(imagesDir, "generated.png"), Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));

    await expect(getPublicImageFile("generated")).resolves.toEqual({
      filepath: join(imagesDir, "generated.png"),
      contentType: "image/png",
    });
  });

  test("rejects active HTML bytes even when provenance is present", async () => {
    seedImage("active", 100, {
      filename: "active.html",
      original_filename: "image-gen-active.html",
      mime_type: "text/html",
      public_provenance: SERVER_IMAGE_GENERATION_PROVENANCE,
    });
    const imagesDir = join(env.dataDir, "images");
    mkdirSync(imagesDir, { recursive: true });
    writeFileSync(join(imagesDir, "active.html"), "<!doctype html><script>alert(1)</script>");

    await expect(getPublicImageFile("active")).resolves.toBeNull();
  });

});

describe("images.service ownership filters", () => {
  test("does not create an image row when a write reports success without creating the file", async () => {
    const writeSpy = spyOn(Bun, "write").mockImplementation(async () => 1);
    try {
      const file = new File([
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ], "missing.png", { type: "image/png" });

      await expect(uploadImage("u1", file)).rejects.toThrow("Image file was not created");
      const count = getDb().query("SELECT COUNT(*) AS count FROM images").get() as { count: number };
      expect(count.count).toBe(0);
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("lists only extension-owned images and returns specificity-aware URLs", () => {
    seedImage("img-1", 300, { owner_extension_identifier: "ext.gallery", owner_chat_id: "chat-1" });
    seedImage("img-2", 200, { owner_extension_identifier: "ext.gallery", owner_character_id: "char-1" });
    seedImage("img-3", 100, { owner_extension_identifier: "ext.other" });

    const result = listImages("u1", {
      owner_extension_identifier: "ext.gallery",
      specificity: "sm",
    });

    expect(result.total).toBe(2);
    expect(result.data.map((image) => image.id)).toEqual(["img-1", "img-2"]);
    expect(result.data[0].url).toBe("/api/v1/images/img-1?size=sm");
    expect(result.data[0].specificity).toBe("sm");
    expect(result.data[1].owner_character_id).toBe("char-1");
  });

  test("applies owner filters to single-image lookups", () => {
    seedImage("img-1", 100, {
      owner_extension_identifier: "ext.gallery",
      owner_character_id: "char-1",
      owner_chat_id: "chat-1",
    });

    const match = getImage("u1", "img-1", {
      owner_extension_identifier: "ext.gallery",
      owner_character_id: "char-1",
      specificity: "lg",
    });
    const mismatch = getImage("u1", "img-1", {
      owner_extension_identifier: "ext.other",
    });

    expect(match?.url).toBe("/api/v1/images/img-1?size=lg");
    expect(match?.owner_chat_id).toBe("chat-1");
    expect(mismatch).toBeNull();
  });

  test("treats wallpaper-library images as long-term references", () => {
    seedImage("img-1", 100, { owner_extension_identifier: WALLPAPER_LIBRARY_OWNER });

    const deleted = deleteImageIfUnreferenced("u1", "img-1");

    expect(deleted).toBe(false);
    expect(getImage("u1", "img-1")).not.toBeNull();
  });

  test("treats locally stored preset covers as image references", () => {
    seedImage("img-1", 100);
    getDb().run(`CREATE TABLE presets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    )`);
    getDb().query("INSERT INTO presets (id, user_id, metadata) VALUES (?, ?, ?)").run(
      "preset-1",
      "u1",
      JSON.stringify({ coverUrl: "/api/v1/images/img-1" }),
    );

    expect(deleteImageIfUnreferenced("u1", "img-1")).toBe(false);
    expect(getImage("u1", "img-1")).not.toBeNull();
  });

  test("deletes wallpaper-library images and clears global plus chat assignments", () => {
    seedImage("img-1", 100, { owner_extension_identifier: WALLPAPER_LIBRARY_OWNER });
    seedImage("img-2", 90, { owner_extension_identifier: WALLPAPER_LIBRARY_OWNER });
    seedSetting("wallpaper", {
      global: { image_id: "img-1", type: "image" },
      opacity: 0.35,
      fit: "cover",
      blur: 2,
    });
    seedChat("chat-1", {
      wallpaper: { image_id: "img-1", type: "image" },
      topic: "keep me",
    });
    seedChat("chat-2", {
      wallpaper: { image_id: "img-2", type: "image" },
      topic: "leave me alone",
    });

    const deleted = deleteWallpaperLibraryImage("u1", "img-1");

    expect(deleted).toBe(true);
    expect(getImage("u1", "img-1")).toBeNull();
    expect(settingsSvc.getSetting("u1", "wallpaper")?.value).toEqual({
      global: null,
      opacity: 0.35,
      fit: "cover",
      blur: 2,
    });
    expect(chatsSvc.getChat("u1", "chat-1")?.metadata).toEqual({
      wallpaper: null,
      topic: "keep me",
    });
    expect(chatsSvc.getChat("u1", "chat-2")?.metadata).toEqual({
      wallpaper: { image_id: "img-2", type: "image" },
      topic: "leave me alone",
    });
  });

  test("does not delete non-wallpaper images through the wallpaper delete path", () => {
    seedImage("img-1", 100);

    const deleted = deleteWallpaperLibraryImage("u1", "img-1");

    expect(deleted).toBe(false);
    expect(getImage("u1", "img-1")).not.toBeNull();
  });

  test("resolves hevc sidecar paths for video wallpapers", async () => {
    seedImage("clip-1", 100, {
      filename: "clip-1.mp4",
      original_filename: "clip-1.mp4",
      mime_type: "video/mp4",
    });

    const imagesDir = join(env.dataDir, "images");
    mkdirSync(imagesDir, { recursive: true });
    const primaryPath = join(imagesDir, "clip-1.mp4");
    const hevcPath = join(imagesDir, "clip-1_hevc.mp4");
    writeFileSync(primaryPath, "primary");
    writeFileSync(hevcPath, "hevc");

    await expect(getImageFilePath("u1", "clip-1", undefined, "hevc")).resolves.toBe(hevcPath);
    await expect(getImageFilePath("u1", "clip-1", undefined, "h264")).resolves.toBe(primaryPath);
  });

  test("derives poster thumbnails for legacy video wallpapers when a tier is requested", async () => {
    const ffmpeg = await resolveFfmpegBinary();
    if (!ffmpeg) return;

    seedImage("clip-legacy", 100, {
      filename: "clip-legacy.mp4",
      original_filename: "clip-legacy.mov",
      mime_type: "video/mp4",
    });

    const imagesDir = join(env.dataDir, "images");
    mkdirSync(imagesDir, { recursive: true });
    const primaryPath = join(imagesDir, "clip-legacy.mp4");
    const expectedThumbPath = join(imagesDir, "clip-legacy_thumb_lg_v2.webp");
    const generator = Bun.spawn([
      ffmpeg,
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=32x32:d=0.2",
      "-an",
      "-c:v",
      "mpeg4",
      "-y",
      primaryPath,
    ], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await generator.exited).toBe(0);

    await expect(getImageFilePath("u1", "clip-legacy", "lg")).resolves.toBe(expectedThumbPath);
    expect(existsSync(expectedThumbPath)).toBe(true);
    expect(getImage("u1", "clip-legacy")?.has_thumbnail).toBe(true);
  });

  test("deletes sidecar video variants with the primary image", () => {
    seedImage("clip-2", 100, {
      filename: "clip-2.mp4",
      original_filename: "clip-2.mp4",
      mime_type: "video/mp4",
    });

    const imagesDir = join(env.dataDir, "images");
    mkdirSync(imagesDir, { recursive: true });
    const primaryPath = join(imagesDir, "clip-2.mp4");
    const hevcPath = join(imagesDir, "clip-2_hevc.mp4");
    const avifThumbPath = join(imagesDir, "clip-2_thumb_sm_v2.avif");
    writeFileSync(primaryPath, "primary");
    writeFileSync(hevcPath, "hevc");
    writeFileSync(avifThumbPath, "avif-thumb");

    expect(deleteImage("u1", "clip-2")).toBe(true);
    expect(existsSync(primaryPath)).toBe(false);
    expect(existsSync(hevcPath)).toBe(false);
    expect(existsSync(avifThumbPath)).toBe(false);
  });

  test("keeps the image row when deleting its files fails", () => {
    seedImage("undeletable", 100);
    const imagesDir = join(env.dataDir, "images");
    mkdirSync(join(imagesDir, "undeletable.png"), { recursive: true });

    expect(() => deleteImage("u1", "undeletable")).toThrow("Could not delete 1 image file");
    expect(getImage("u1", "undeletable")).not.toBeNull();
  });

  test("keeps bulk-deletion rows when deleting their files fails", async () => {
    seedImage("bulk-undeletable", 100);
    const imagesDir = join(env.dataDir, "images");
    mkdirSync(join(imagesDir, "bulk-undeletable.png"), { recursive: true });

    await expect(deleteImagesBulk("u1", ["bulk-undeletable"])).rejects.toThrow("Could not delete 1 image file");
    expect(getImage("u1", "bulk-undeletable")).not.toBeNull();
  });

  test("ignores a reported EPERM when the image path is already gone", async () => {
    seedImage("gone-after-unlink", 100);
    const primaryPath = join(env.dataDir, "images", "gone-after-unlink.png");
    mkdirSync(join(env.dataDir, "images"), { recursive: true });
    writeFileSync(primaryPath, "image");

    const unlinkSpy = spyOn(fsPromises, "unlink").mockImplementation(async (path) => {
      rmSync(path);
      throw unlinkError("EPERM", String(path));
    });
    try {
      await expect(deleteImagesBulk("u1", ["gone-after-unlink"])).resolves.toBe(1);
      expect(unlinkSpy).toHaveBeenCalledTimes(1);
      expect(getImage("u1", "gone-after-unlink")).toBeNull();
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  test("retries transient EPERM when deleting an image synchronously", () => {
    seedImage("retry-sync", 100);
    const primaryPath = join(env.dataDir, "images", "retry-sync.png");
    mkdirSync(join(env.dataDir, "images"), { recursive: true });
    writeFileSync(primaryPath, "image");

    let attempts = 0;
    const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation((path) => {
      attempts++;
      if (attempts === 1) throw unlinkError("EPERM", String(path));
      rmSync(path);
    });
    const sleepSpy = spyOn(Bun, "sleepSync").mockImplementation(() => {});
    try {
      expect(deleteImage("u1", "retry-sync")).toBe(true);
      expect(attempts).toBe(2);
      expect(sleepSpy).toHaveBeenCalledTimes(1);
      expect(getImage("u1", "retry-sync")).toBeNull();
    } finally {
      sleepSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
  });

  test("keeps the image row after transient unlink retries are exhausted", async () => {
    seedImage("retry-exhausted", 100);
    const primaryPath = join(env.dataDir, "images", "retry-exhausted.png");
    mkdirSync(join(env.dataDir, "images"), { recursive: true });
    writeFileSync(primaryPath, "image");

    const unlinkSpy = spyOn(fsPromises, "unlink").mockImplementation(async (path) => {
      throw unlinkError("EPERM", String(path));
    });
    const sleepSpy = spyOn(Bun, "sleep").mockImplementation(async () => {});
    try {
      await expect(deleteImagesBulk("u1", ["retry-exhausted"])).rejects.toThrow("Could not delete 1 image file");
      expect(unlinkSpy).toHaveBeenCalledTimes(6);
      expect(sleepSpy).toHaveBeenCalledTimes(5);
      expect(existsSync(primaryPath)).toBe(true);
      expect(getImage("u1", "retry-exhausted")).not.toBeNull();
    } finally {
      sleepSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
  });

  test("emits wallpaper video upload progress through transcoding and finalize stages", async () => {
    const ffmpeg = await resolveFfmpegBinary();
    if (!ffmpeg) return;

    const workdir = mkdtempSync(join(tmpdir(), "lumiverse-images-upload-progress-"));
    try {
      const inputPath = join(workdir, "input.mov");
      const generator = Bun.spawn([
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=16x16:d=0.2",
        "-an",
        "-c:v",
        "mpeg4",
        "-y",
        inputPath,
      ], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await generator.exited).toBe(0);

      const bytes = await Bun.file(inputPath).bytes();
      const file = new File([bytes], "input.mov", { type: "video/quicktime" });
      const phases: string[] = [];
      const codecs: string[] = [];
      const phasePercents: Array<number | undefined> = [];

      const image = await uploadImage("u1", file, {
        owner_extension_identifier: WALLPAPER_LIBRARY_OWNER,
        transcode_video_codec: "h264",
        sidecar_video_codecs: ["hevc"],
        strip_audio: true,
        on_progress: (progress) => {
          phases.push(progress.phase);
          if (progress.codec) codecs.push(progress.codec);
          phasePercents.push(progress.phaseProgressPct);
        },
      });

      expect(image.mime_type).toBe("video/mp4");
      const uniquePhases = phases.filter((phase, index) => phase !== phases[index - 1]);
      expect(uniquePhases).toEqual([
        "received",
        "transcoding_primary",
        "transcoding_variant",
        "extracting_poster",
        "finalizing",
        "completed",
      ]);
      const uniqueCodecs = codecs.filter((codec, index) => codec !== codecs[index - 1]);
      expect(uniqueCodecs).toEqual(["h264", "hevc"]);
      expect(phasePercents.some((value) => value === 100)).toBe(true);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe("deferred image processing", () => {
  const ONE_BY_ONE_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==",
    "base64",
  );

  test("single deferred uploads infer MIME, preserve ownership, and finish queued processing", async () => {
    mkdirSync(join(testDataDir, "images"), { recursive: true });
    const file = new File([ONE_BY_ONE_PNG], "embedded.png");

    const image = await uploadImageDeferred("u1", file, { owner_character_id: "char-1" });

    expect(image.mime_type).toBe("image/png");
    expect(image.owner_character_id).toBe("char-1");
    await waitForDeferredImageProcessing();
    expect(getImage("u1", image.id)).toMatchObject({
      width: 1,
      height: 1,
      has_thumbnail: true,
      owner_character_id: "char-1",
    });
  });

  test("single deferred uploads recognize supported image extensions when MIME is absent", async () => {
    mkdirSync(join(testDataDir, "images"), { recursive: true });
    const image = await uploadImageDeferred("u1", new File([ONE_BY_ONE_PNG], "embedded.apng"));

    expect(image.mime_type).toBe("image/apng");
    await waitForDeferredImageProcessing();
    expect(getImage("u1", image.id)).toMatchObject({ width: 1, height: 1, has_thumbnail: true });
  });

  test("uses Sharp AVIF thumbnails when the operator codec is enabled", async () => {
    applySharpSettings({ thumbnailCodec: "avif", avifQuality: 54 });
    mkdirSync(join(testDataDir, "images"), { recursive: true });
    const image = await uploadImageDeferred("u1", new File([ONE_BY_ONE_PNG], "embedded.png"));

    await waitForDeferredImageProcessing();
    const avifSmPath = join(testDataDir, "images", `${image.id}_thumb_sm_v2.avif`);
    const avifLgPath = join(testDataDir, "images", `${image.id}_thumb_lg_v2.avif`);
    expect(existsSync(avifSmPath)).toBe(true);
    expect(existsSync(avifLgPath)).toBe(true);
    expect(existsSync(join(testDataDir, "images", `${image.id}_thumb_sm_v2.webp`))).toBe(false);
    expect(await readImageMetadata(avifSmPath)).toMatchObject({ format: "avif" });
    expect(await getImageFilePath("u1", image.id, "sm")).toBe(avifSmPath);

    applySharpSettings({ thumbnailCodec: "webp", webpQuality: 80 });
    const webpSmPath = join(testDataDir, "images", `${image.id}_thumb_sm_v2.webp`);
    expect(await getImageFilePath("u1", image.id, "sm")).toBe(webpSmPath);
    expect(existsSync(webpSmPath)).toBe(true);

    applySharpSettings({ thumbnailCodec: "avif", avifQuality: 54 });
    await rebuildAllThumbnails("u1");
    expect(existsSync(webpSmPath)).toBe(false);
    expect(existsSync(avifSmPath)).toBe(true);
  });

  test("thumbnail processing opt-outs survive lazy reads and rebuilds", async () => {
    mkdirSync(join(testDataDir, "images"), { recursive: true });
    const image = await uploadImageDeferred(
      "u1",
      new File([ONE_BY_ONE_PNG], "baked.png", { type: "image/png" }),
      { skip_thumbnail_processing: true },
    );
    const originalPath = join(testDataDir, "images", image.filename);
    const smPath = join(testDataDir, "images", `${image.id}_thumb_sm_v2.webp`);
    const lgPath = join(testDataDir, "images", `${image.id}_thumb_lg_v2.webp`);

    await waitForDeferredImageProcessing();
    expect(getDeferredImageProcessingStatus().total).toBe(0);
    expect(getImage("u1", image.id)).toMatchObject({
      width: null,
      height: null,
      has_thumbnail: false,
      skip_thumbnail_processing: true,
    });
    expect(await getImageFilePath("u1", image.id, "sm")).toBe(originalPath);
    expect(existsSync(smPath)).toBe(false);

    expect(await rebuildAllThumbnails("u1")).toEqual({
      total: 1,
      current: 1,
      generated: 0,
      skipped: 1,
      failed: 0,
    });
    expect(existsSync(smPath)).toBe(false);
    expect(existsSync(lgPath)).toBe(false);
  });

  test("ordinary uploadImage calls use deferred processing", async () => {
    mkdirSync(join(testDataDir, "images"), { recursive: true });
    const image = await uploadImage(
      "u1",
      new File([ONE_BY_ONE_PNG], "avatar.png", { type: "image/png" }),
      { owner_character_id: "char-1" },
    );

    await waitForDeferredImageProcessing();
    expect(getImage("u1", image.id)).toMatchObject({
      width: 1,
      height: 1,
      has_thumbnail: true,
      owner_character_id: "char-1",
    });
  });

  test("data URL and optimized WebP uploads finish through the deferred queue", async () => {
    mkdirSync(join(testDataDir, "images"), { recursive: true });
    const dataUrlImage = await saveImageFromDataUrl(
      "u1",
      `data:image/png;base64,${ONE_BY_ONE_PNG.toString("base64")}`,
      "generated.png",
    );
    const webpImage = await uploadOptimizedWebpImage(
      "u1",
      new File([ONE_BY_ONE_PNG], "layer.png", { type: "image/png" }),
      { owner_character_id: "char-1" },
    );

    await waitForDeferredImageProcessing();
    expect(getImage("u1", dataUrlImage.id)).toMatchObject({ width: 1, height: 1, has_thumbnail: true });
    expect(getImage("u1", webpImage.id)).toMatchObject({
      width: 1,
      height: 1,
      has_thumbnail: true,
      mime_type: "image/webp",
      owner_character_id: "char-1",
    });
  });

  test("waitForDeferredImageProcessing drains queued thumbnail work", async () => {
    setWorkerBudgetOverride(deriveWorkerBudget(2));
    mkdirSync(join(testDataDir, "images"), { recursive: true });
    const results = await uploadImages("u1", [
      { data: ONE_BY_ONE_PNG, filename: "a.png", mime_type: "image/png" },
      { data: ONE_BY_ONE_PNG, filename: "b.png", mime_type: "image/png" },
    ], { deferProcessing: true });
    expect(results.every((row) => row.image)).toBe(true);
    await waitForDeferredImageProcessing();
    const thumbs = getDb().query("SELECT COUNT(*) AS count FROM images WHERE has_thumbnail = 1").get() as { count: number };
    expect(thumbs.count).toBe(2);
  });

  test("reports processed and remaining counts until drain completes", async () => {
    setWorkerBudgetOverride(deriveWorkerBudget(2));
    mkdirSync(join(testDataDir, "images"), { recursive: true });
    await uploadImages("u1", [
      { data: ONE_BY_ONE_PNG, filename: "a.png", mime_type: "image/png" },
      { data: ONE_BY_ONE_PNG, filename: "b.png", mime_type: "image/png" },
    ], { deferProcessing: true });
    const mid = getDeferredImageProcessingStatus();
    expect(mid.total).toBe(2);
    expect(mid.processed + mid.remaining).toBe(2);
    await waitForDeferredImageProcessing();
    expect(getDeferredImageProcessingStatus()).toEqual({
      processed: 2,
      remaining: 0,
      total: 2,
      active: 0,
      queued: 0,
    });
  });

  test("repeated uploads append to one processing queue", async () => {
    setWorkerBudgetOverride(deriveWorkerBudget(2));
    mkdirSync(join(testDataDir, "images"), { recursive: true });

    await uploadImages("u1", [
      { data: ONE_BY_ONE_PNG, filename: "a.png", mime_type: "image/png" },
      { data: ONE_BY_ONE_PNG, filename: "b.png", mime_type: "image/png" },
      { data: ONE_BY_ONE_PNG, filename: "c.png", mime_type: "image/png" },
    ], { deferProcessing: true });

    const status = getDeferredImageProcessingStatus();
    expect(status.total).toBe(3);
    expect(status.processed + status.remaining).toBe(3);
    expect(status.active).toBeLessThanOrEqual(1);
    await waitForDeferredImageProcessing();
    expect(getDeferredImageProcessingStatus().processed).toBe(3);
  });

  test("rebuildAllThumbnails drains through the deferred Sharp queue", async () => {
    setWorkerBudgetOverride(deriveWorkerBudget(2));
    mkdirSync(join(testDataDir, "images"), { recursive: true });
    const uploaded = await uploadImages("u1", [
      { data: ONE_BY_ONE_PNG, filename: "a.png", mime_type: "image/png" },
      { data: ONE_BY_ONE_PNG, filename: "b.png", mime_type: "image/png" },
    ], { deferProcessing: true });
    await waitForDeferredImageProcessing();
    const first = uploaded[0]?.image;
    if (!first) throw new Error("expected uploaded image");
    unlinkSync(join(testDataDir, "images", `${first.id}_thumb_sm_v2.webp`));

    const ticks: number[] = [];
    const result = await rebuildAllThumbnails("u1", {
      onProgress: (progress) => ticks.push(progress.current),
    });
    expect(result).toEqual({
      total: 2,
      current: 2,
      generated: 2,
      skipped: 0,
      failed: 0,
    });
    expect(ticks.at(-1)).toBe(2);
    expect(getDeferredImageProcessingStatus()).toMatchObject({
      processed: 2,
      remaining: 0,
      total: 2,
    });
    expect(existsSync(join(testDataDir, "images", `${first.id}_thumb_sm_v2.webp`))).toBe(true);
  });

  test("rebuildAllThumbnails wipes existing thumbs then reattributes them", async () => {
    setWorkerBudgetOverride(deriveWorkerBudget(2));
    mkdirSync(join(testDataDir, "images"), { recursive: true });
    const uploaded = await uploadImages("u1", [
      { data: ONE_BY_ONE_PNG, filename: "a.png", mime_type: "image/png" },
    ], { deferProcessing: true });
    await waitForDeferredImageProcessing();
    const image = uploaded[0]?.image;
    if (!image) throw new Error("expected uploaded image");
    const smPath = join(testDataDir, "images", `${image.id}_thumb_sm_v2.webp`);
    const stalePath = join(testDataDir, "images", `${image.id}_thumb_sm.webp`);
    writeFileSync(stalePath, "stale-legacy-thumb");
    const before = existsSync(smPath) ? statSync(smPath).mtimeMs : 0;
    getDb().query("UPDATE images SET has_thumbnail = 1 WHERE id = ?").run(image.id);

    const result = await rebuildAllThumbnails("u1");
    expect(result).toMatchObject({ total: 1, generated: 1, skipped: 0, failed: 0 });
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(smPath)).toBe(true);
    expect(statSync(smPath).mtimeMs).toBeGreaterThanOrEqual(before);
    expect(getDb().query("SELECT has_thumbnail AS flag FROM images WHERE id = ?").get(image.id)).toEqual({ flag: 1 });
  });

  test("does not auto-run leftover rows and recover starts them", async () => {
    setWorkerBudgetOverride(deriveWorkerBudget(2));
    mkdirSync(join(testDataDir, "images"), { recursive: true });
    const uploaded = await uploadImages("u1", [
      { data: ONE_BY_ONE_PNG, filename: "a.png", mime_type: "image/png" },
    ], { deferProcessing: true });
    await waitForDeferredImageProcessing();
    const image = uploaded[0]?.image;
    if (!image) throw new Error("expected uploaded image");
    unlinkSync(join(testDataDir, "images", `${image.id}_thumb_sm_v2.webp`));
    recordImageProcessingJob("u1", image.id, "process");

    expect(getImageProcessingRecovery()).toEqual({
      pending: 1,
      process: 1,
      rebuild: 0,
    });
    expect(existsSync(join(testDataDir, "images", `${image.id}_thumb_sm_v2.webp`))).toBe(false);

    recoverImageProcessingQueue();
    await waitForDeferredImageProcessing();
    expect(existsSync(join(testDataDir, "images", `${image.id}_thumb_sm_v2.webp`))).toBe(true);
    expect(getImageProcessingRecovery().pending).toBe(0);
  });

  test("discard leftover rows without starting them", async () => {
    setWorkerBudgetOverride(deriveWorkerBudget(2));
    mkdirSync(join(testDataDir, "images"), { recursive: true });
    const uploaded = await uploadImages("u1", [
      { data: ONE_BY_ONE_PNG, filename: "a.png", mime_type: "image/png" },
    ], { deferProcessing: true });
    await waitForDeferredImageProcessing();
    const image = uploaded[0]?.image;
    if (!image) throw new Error("expected uploaded image");
    recordImageProcessingJob("u1", image.id, "rebuild");
    expect(getImageProcessingRecovery().pending).toBe(1);
    expect(discardImageProcessingQueue()).toEqual({ pending: 0, process: 0, rebuild: 0 });
    expect(getImageProcessingRecovery().pending).toBe(0);
  });

  test("recovery discards stale processing jobs for opted-out assets", async () => {
    mkdirSync(join(testDataDir, "images"), { recursive: true });
    const image = await uploadImageDeferred(
      "u1",
      new File([ONE_BY_ONE_PNG], "baked.png", { type: "image/png" }),
      { skip_thumbnail_processing: true },
    );
    recordImageProcessingJob("u1", image.id, "process");

    expect(getImageProcessingRecovery().pending).toBe(1);
    expect(recoverImageProcessingQueue()).toEqual({ pending: 0, process: 0, rebuild: 0 });
    await waitForDeferredImageProcessing();
    expect(existsSync(join(testDataDir, "images", `${image.id}_thumb_sm_v2.webp`))).toBe(false);
    expect(existsSync(join(testDataDir, "images", `${image.id}_thumb_lg_v2.webp`))).toBe(false);
  });
});
