import sharp from "../utils/sharp-config";
import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { env } from "../env";
import type { Image } from "../types/image";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { join, extname } from "path";

const IMAGES_DIR = "images";

const DEFAULT_SMALL_SIZE = 300;
const DEFAULT_LARGE_SIZE = 700;
const WEBP_QUALITY = 80;

type ThumbnailSource = Buffer | string;

const inflightThumbnailGenerations = new Map<string, Promise<boolean>>();

export type ThumbTier = "sm" | "lg";
export type ImageSpecificity = "full" | ThumbTier;

export interface ImageOwnershipOptions {
  owner_extension_identifier?: string;
  owner_character_id?: string;
  owner_chat_id?: string;
}

export interface ImageQueryOptions extends ImageOwnershipOptions {
  specificity?: ImageSpecificity;
}

export interface ThumbnailSettings {
  smallSize: number;
  largeSize: number;
}

function buildImageUrl(id: string, specificity: ImageSpecificity = "full"): string {
  return specificity === "full"
    ? `/api/v1/images/${id}`
    : `/api/v1/images/${id}?size=${specificity}`;
}

function normalizeOwnershipValue(value?: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildImageFilterClause(userId: string, options?: ImageOwnershipOptions): { clause: string; params: string[] } {
  const clauses = ["user_id = ?"];
  const params = [userId];

  const extensionIdentifier = normalizeOwnershipValue(options?.owner_extension_identifier);
  if (extensionIdentifier) {
    clauses.push("owner_extension_identifier = ?");
    params.push(extensionIdentifier);
  }

  const characterId = normalizeOwnershipValue(options?.owner_character_id);
  if (characterId) {
    clauses.push("owner_character_id = ?");
    params.push(characterId);
  }

  const chatId = normalizeOwnershipValue(options?.owner_chat_id);
  if (chatId) {
    clauses.push("owner_chat_id = ?");
    params.push(chatId);
  }

  return { clause: clauses.join(" AND "), params };
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function getImagesDir(): string {
  const dir = join(env.dataDir, IMAGES_DIR);
  ensureDir(dir);
  return dir;
}

function rowToImage(row: any, specificity: ImageSpecificity = "full"): Image {
  return {
    ...row,
    has_thumbnail: !!row.has_thumbnail,
    width: row.width ?? null,
    height: row.height ?? null,
    url: buildImageUrl(row.id, specificity),
    specificity,
    owner_extension_identifier: row.owner_extension_identifier ?? null,
    owner_character_id: row.owner_character_id ?? null,
    owner_chat_id: row.owner_chat_id ?? null,
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
  source: ThumbnailSource,
  outputPath: string,
  size: number
): Promise<boolean> {
  try {
    await sharp(source)
      .resize(size, size, { fit: "cover" })
      .webp({ quality: WEBP_QUALITY })
      .toFile(outputPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureThumbnail(
  cacheKey: string,
  source: ThumbnailSource,
  outputPath: string,
  size: number,
): Promise<boolean> {
  const existing = inflightThumbnailGenerations.get(cacheKey);
  if (existing) return existing;

  const job = generateThumbnail(source, outputPath, size).finally(() => {
    inflightThumbnailGenerations.delete(cacheKey);
  });
  inflightThumbnailGenerations.set(cacheKey, job);
  return job;
}

export async function uploadImage(userId: string, file: File, options?: ImageOwnershipOptions): Promise<Image> {
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
  const ownerExtensionIdentifier = normalizeOwnershipValue(options?.owner_extension_identifier);
  const ownerCharacterId = normalizeOwnershipValue(options?.owner_character_id);
  const ownerChatId = normalizeOwnershipValue(options?.owner_chat_id);
  getDb()
    .query(
      `INSERT INTO images (
         id,
         user_id,
         filename,
         original_filename,
         mime_type,
         width,
         height,
         has_thumbnail,
         owner_extension_identifier,
         owner_character_id,
         owner_chat_id,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      filename,
      file.name,
      file.type || "",
      width,
      height,
      hasThumbnail ? 1 : 0,
      ownerExtensionIdentifier,
      ownerCharacterId,
      ownerChatId,
      now,
    );

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
  originalFilename?: string,
  options?: ImageOwnershipOptions,
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
  const ownerExtensionIdentifier = normalizeOwnershipValue(options?.owner_extension_identifier);
  const ownerCharacterId = normalizeOwnershipValue(options?.owner_character_id);
  const ownerChatId = normalizeOwnershipValue(options?.owner_chat_id);
  getDb()
    .query(
      `INSERT INTO images (
         id,
         user_id,
         filename,
         original_filename,
         mime_type,
         width,
         height,
         has_thumbnail,
         owner_extension_identifier,
         owner_character_id,
         owner_chat_id,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      filename,
      originalFilename || `image-gen-${id}${ext}`,
      mimeType,
      width,
      height,
      hasThumbnail ? 1 : 0,
      ownerExtensionIdentifier,
      ownerCharacterId,
      ownerChatId,
      now,
    );

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
    const userId = row.user_id;
    const sizes = getThumbnailSettings(userId);
    const size = tier === "sm" ? sizes.smallSize : sizes.largeSize;
    const ok = await ensureThumbnail(`${id}:${tier}:public`, originalPath, thumbPath, size);
    return ok ? thumbPath : originalPath;
  }

  const filepath = join(dir, row.filename);
  return existsSync(filepath) ? filepath : null;
}

export function getImage(userId: string, id: string, options?: ImageQueryOptions): Image | null {
  const { clause, params } = buildImageFilterClause(userId, options);
  const row = getDb().query(`SELECT * FROM images WHERE id = ? AND ${clause}`).get(id, ...params) as any;
  return row ? rowToImage(row, options?.specificity) : null;
}

export function listImages(
  userId: string,
  options?: { limit?: number; offset?: number } & ImageQueryOptions
): { data: Image[]; total: number } {
  const limit = Math.min(options?.limit || 50, 200);
  const offset = options?.offset || 0;
  const { clause, params } = buildImageFilterClause(userId, options);

  const rows = getDb()
    .query(`SELECT * FROM images WHERE ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as any[];

  const countRow = getDb()
    .query(`SELECT COUNT(*) as total FROM images WHERE ${clause}`)
    .get(...params) as { total: number };

  return {
    data: rows.map((row) => rowToImage(row, options?.specificity)),
    total: countRow.total,
  };
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
      const ok = await ensureThumbnail(`${image.id}:${tier}:${userId}`, originalPath, tieredPath, size);
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
        const [smOk, lgOk] = await Promise.all([
          generateThumbnail(originalPath, join(dir, `${img.id}${thumbSuffix("sm")}`), sizes.smallSize),
          generateThumbnail(originalPath, join(dir, `${img.id}${thumbSuffix("lg")}`), sizes.largeSize),
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
