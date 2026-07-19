import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import { resolveFfmpegBinary } from "./ffmpeg-binary.service";
import * as chatsSvc from "./chats.service";
import * as settingsSvc from "./settings.service";
import {
  WALLPAPER_LIBRARY_OWNER,
  deleteImage,
  deleteImageIfUnreferenced,
  deleteImagesBulk,
  deleteWallpaperLibraryImage,
  getImage,
  getImageFilePath,
  listImages,
  uploadImage,
} from "./images.service";

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
    owner_extension_identifier TEXT,
    owner_character_id TEXT,
    owner_chat_id TEXT,
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
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
  initImagesTestDb();
  testDataDir = mkdtempSync(join(tmpdir(), "lumiverse-images-test-"));
  env.dataDir = testDataDir;
});

afterEach(() => {
  closeDatabase();
  env.dataDir = originalDataDir;
  if (testDataDir) {
    rmSync(testDataDir, { recursive: true, force: true });
    testDataDir = "";
  }
});

describe("images.service ownership filters", () => {
  test("does not create an image row when a write reports success without creating the file", async () => {
    const writeSpy = spyOn(Bun, "write").mockImplementation(async () => 1);
    try {
      const file = new File([new Uint8Array([0])], "missing.png", { type: "image/png" });

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
    writeFileSync(primaryPath, "primary");
    writeFileSync(hevcPath, "hevc");

    expect(deleteImage("u1", "clip-2")).toBe(true);
    expect(existsSync(primaryPath)).toBe(false);
    expect(existsSync(hevcPath)).toBe(false);
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
