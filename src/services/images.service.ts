import sharp from "sharp";
import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { env } from "../env";
import type { Image } from "../types/image";
import { mkdirSync, existsSync, unlinkSync, readFileSync } from "fs";
import { join, extname } from "path";

const IMAGES_DIR = "images";

const DEFAULT_SMALL_SIZE = 300;
const DEFAULT_LARGE_SIZE = 700;
const WEBP_QUALITY = 80;

export type ThumbTier = "sm" | "lg";

export interface ThumbnailSettings {
  smallSize: number;
  largeSize: number;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function getImagesDir(): string {
  const dir = join(env.dataDir, IMAGES_DIR);
  ensureDir(dir);
  return dir;
}

function rowToImage(row: any): Image {
  return {
    ...row,
    has_thumbnail: !!row.has_thumbnail,
    width: row.width ?? null,
    height: row.height ?? null,
  };
}

/** Read thumbnail size settings from the DB. Returns defaults if not set. */
export function getThumbnailSettings(userId: string): ThumbnailSettings {
  const row = getDb()
    .query("SELECT value FROM settings WHERE key = 'thumbnailSettings' AND user_id = ?")
    .get(userId) as any;
  if (row) {
    try {
      const parsed = JSON.parse(row.value);
      return {
        smallSize: Math.max(100, Math.min(600, parsed.smallSize ?? DEFAULT_SMALL_SIZE)),
        largeSize: Math.max(400, Math.min(1200, parsed.largeSize ?? DEFAULT_LARGE_SIZE)),
      };
    } catch {}
  }
  return { smallSize: DEFAULT_SMALL_SIZE, largeSize: DEFAULT_LARGE_SIZE };
}

function thumbSuffix(tier: ThumbTier): string {
  return `_thumb_${tier}.webp`;
}

async function generateThumbnail(
  sourceBuffer: Buffer,
  outputPath: string,
  size: number
): Promise<boolean> {
  try {
    await sharp(sourceBuffer)
      .resize(size, size, { fit: "cover" })
      .webp({ quality: WEBP_QUALITY })
      .toFile(outputPath);
    return true;
  } catch {
    return false;
  }
}

export async function uploadImage(userId: string, file: File): Promise<Image> {
  const id = crypto.randomUUID();
  const ext = extname(file.name) || ".bin";
  const filename = `${id}${ext}`;
  const dir = getImagesDir();
  const filepath = join(dir, filename);

  const buffer = Buffer.from(await file.arrayBuffer());
  await Bun.write(filepath, buffer);

  let width: number | null = null;
  let height: number | null = null;
  let hasThumbnail = false;

  try {
    const metadata = await sharp(buffer).metadata();
    width = metadata.width ?? null;
    height = metadata.height ?? null;

    const sizes = getThumbnailSettings(userId);
    const [smOk, lgOk] = await Promise.all([
      generateThumbnail(buffer, join(dir, `${id}${thumbSuffix("sm")}`), sizes.smallSize),
      generateThumbnail(buffer, join(dir, `${id}${thumbSuffix("lg")}`), sizes.largeSize),
    ]);
    hasThumbnail = smOk || lgOk;
  } catch {
    // Non-image file or sharp failure — skip thumbnails
  }

  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query(
      `INSERT INTO images (id, user_id, filename, original_filename, mime_type, width, height, has_thumbnail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, userId, filename, file.name, file.type || "", width, height, hasThumbnail ? 1 : 0, now);

  const image = getImage(userId, id)!;
  eventBus.emit(EventType.IMAGE_UPLOADED, { image }, userId);
  return image;
}

/**
 * Save an image from a base64 data URL (e.g. from image generation).
 * Creates the image record, generates thumbnails, and returns the Image entity.
 */
export async function saveImageFromDataUrl(
  userId: string,
  dataUrl: string,
  originalFilename?: string
): Promise<Image> {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid data URL format");

  const mimeType = match[1];
  const base64 = match[2];
  const ext = mimeType === "image/png" ? ".png" : mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".bin";

  const id = crypto.randomUUID();
  const filename = `${id}${ext}`;
  const dir = getImagesDir();
  const filepath = join(dir, filename);

  const buffer = Buffer.from(base64, "base64");
  await Bun.write(filepath, buffer);

  let width: number | null = null;
  let height: number | null = null;
  let hasThumbnail = false;

  try {
    const metadata = await sharp(buffer).metadata();
    width = metadata.width ?? null;
    height = metadata.height ?? null;

    const sizes = getThumbnailSettings(userId);
    const [smOk, lgOk] = await Promise.all([
      generateThumbnail(buffer, join(dir, `${id}${thumbSuffix("sm")}`), sizes.smallSize),
      generateThumbnail(buffer, join(dir, `${id}${thumbSuffix("lg")}`), sizes.largeSize),
    ]);
    hasThumbnail = smOk || lgOk;
  } catch {
    // Non-image or sharp failure — skip thumbnails
  }

  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query(
      `INSERT INTO images (id, user_id, filename, original_filename, mime_type, width, height, has_thumbnail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, userId, filename, originalFilename || `image-gen-${id}${ext}`, mimeType, width, height, hasThumbnail ? 1 : 0, now);

  const image = getImage(userId, id)!;
  eventBus.emit(EventType.IMAGE_UPLOADED, { image }, userId);
  return image;
}

/** Prefix used for image gen results — only images with this prefix are publicly accessible. */
export const IMAGE_GEN_FILENAME_PREFIX = "image-gen-";

/**
 * Get an image file path without user scoping — for public access routes.
 * Only serves images whose original_filename starts with the image-gen prefix,
 * preventing the unauthenticated endpoint from leaking user-uploaded images.
 */
export async function getImageFilePathPublic(id: string, tier?: ThumbTier): Promise<string | null> {
  const row = getDb().query("SELECT * FROM images WHERE id = ?").get(id) as any;
  if (!row) return null;

  // Only allow public access to image gen results, not arbitrary user uploads
  if (!row.original_filename || !row.original_filename.startsWith(IMAGE_GEN_FILENAME_PREFIX)) return null;

  const dir = getImagesDir();
  if (tier) {
    const thumbPath = join(dir, `${id}${thumbSuffix(tier)}`);
    if (existsSync(thumbPath)) return thumbPath;
    // Lazy generate if original exists
    const originalPath = join(dir, row.filename);
    if (!existsSync(originalPath)) return null;
    const buffer = readFileSync(originalPath);
    const userId = row.user_id;
    const sizes = getThumbnailSettings(userId);
    const size = tier === "sm" ? sizes.smallSize : sizes.largeSize;
    const ok = await generateThumbnail(Buffer.from(buffer), thumbPath, size);
    return ok ? thumbPath : originalPath;
  }

  const filepath = join(dir, row.filename);
  return existsSync(filepath) ? filepath : null;
}

export function getImage(userId: string, id: string): Image | null {
  const row = getDb().query("SELECT * FROM images WHERE id = ? AND user_id = ?").get(id, userId) as any;
  return row ? rowToImage(row) : null;
}

/**
 * Returns the file path for an image, with optional tiered thumbnail.
 * `tier` can be "sm" (small, ~300px) or "lg" (large, ~700px).
 * If the thumbnail file doesn't exist, generates it lazily (~15-35ms).
 * Pass `tier = undefined` (or omit) to get the original.
 */
export async function getImageFilePath(
  userId: string,
  id: string,
  tier?: ThumbTier
): Promise<string | null> {
  const image = getImage(userId, id);
  if (!image) return null;

  const dir = getImagesDir();

  if (tier) {
    const tieredPath = join(dir, `${image.id}${thumbSuffix(tier)}`);
    if (existsSync(tieredPath)) return tieredPath;

    // Lazy generation from original
    const originalPath = join(dir, image.filename);
    if (existsSync(originalPath)) {
      const sizes = getThumbnailSettings(userId);
      const size = tier === "sm" ? sizes.smallSize : sizes.largeSize;
      const ok = await generateThumbnail(
        readFileSync(originalPath),
        tieredPath,
        size
      );
      if (ok) {
        getDb()
          .query("UPDATE images SET has_thumbnail = 1 WHERE id = ?")
          .run(image.id);
        return tieredPath;
      }
    }
  }

  const filepath = join(dir, image.filename);
  if (!existsSync(filepath)) return null;
  return filepath;
}

// ---------------------------------------------------------------------------
// Thumbnail rebuild
// ---------------------------------------------------------------------------

export interface ThumbnailRebuildProgress {
  total: number;
  current: number;
  generated: number;
  skipped: number;
  failed: number;
}

const REBUILD_BATCH = 20;

export async function rebuildAllThumbnails(
  userId: string,
  options?: { onProgress?: (p: ThumbnailRebuildProgress) => void }
): Promise<ThumbnailRebuildProgress> {
  const dir = getImagesDir();
  const sizes = getThumbnailSettings(userId);

  const rows = getDb()
    .query("SELECT id, filename FROM images WHERE user_id = ?")
    .all(userId) as Array<{ id: string; filename: string }>;

  const progress: ThumbnailRebuildProgress = {
    total: rows.length,
    current: 0,
    generated: 0,
    skipped: 0,
    failed: 0,
  };

  options?.onProgress?.({ ...progress });

  for (let i = 0; i < rows.length; i += REBUILD_BATCH) {
    const batch = rows.slice(i, i + REBUILD_BATCH);

    await Promise.all(
      batch.map(async (img) => {
        const originalPath = join(dir, img.filename);
        if (!existsSync(originalPath)) {
          progress.skipped++;
          progress.current++;
          return;
        }

        // Delete existing tier files
        for (const tier of ["sm", "lg"] as const) {
          const p = join(dir, `${img.id}${thumbSuffix(tier)}`);
          if (existsSync(p)) unlinkSync(p);
        }

        // Regenerate both tiers
        const buffer = readFileSync(originalPath);
        const [smOk, lgOk] = await Promise.all([
          generateThumbnail(buffer, join(dir, `${img.id}${thumbSuffix("sm")}`), sizes.smallSize),
          generateThumbnail(buffer, join(dir, `${img.id}${thumbSuffix("lg")}`), sizes.largeSize),
        ]);

        if (smOk || lgOk) {
          getDb().query("UPDATE images SET has_thumbnail = 1 WHERE id = ?").run(img.id);
          progress.generated++;
        } else {
          progress.failed++;
        }
        progress.current++;
      })
    );

    options?.onProgress?.({ ...progress });
  }

  return progress;
}

export function deleteImage(userId: string, id: string): boolean {
  const image = getImage(userId, id);
  if (!image) return false;

  const dir = getImagesDir();

  // Remove original file
  const filepath = join(dir, image.filename);
  if (existsSync(filepath)) unlinkSync(filepath);

  // Remove all thumbnail tiers
  for (const tier of ["sm", "lg"] as const) {
    const p = join(dir, `${image.id}${thumbSuffix(tier)}`);
    if (existsSync(p)) unlinkSync(p);
  }

  const result = getDb().query("DELETE FROM images WHERE id = ? AND user_id = ?").run(id, userId);
  if (result.changes > 0) {
    eventBus.emit(EventType.IMAGE_DELETED, { id }, userId);
  }
  return result.changes > 0;
}
