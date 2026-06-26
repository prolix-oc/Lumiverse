import sharp from "../utils/sharp-config";
import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { env } from "../env";
import type { Image } from "../types/image";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { join, extname } from "path";
import {
  extractVideoPosterBuffer,
  isLikelyVideoUpload,
  normalizeVideoBuffer,
  stripAudioFromVideoBuffer,
  type NormalizedVideoCodec,
} from "./silent-video.service";
import * as settingsSvc from "./settings.service";
import * as chatsSvc from "./chats.service";

const IMAGES_DIR = "images";

const DEFAULT_SMALL_SIZE = 300;
const DEFAULT_LARGE_SIZE = 700;
const WEBP_QUALITY = 80;
export const WALLPAPER_LIBRARY_OWNER = "lumiverse.wallpaper";

type ThumbnailSource = Buffer | string;

const inflightThumbnailGenerations = new Map<string, Promise<boolean>>();

export type ThumbTier = "sm" | "lg";
export type ImageSpecificity = "full" | ThumbTier;

export interface ImageOwnershipOptions {
  owner_extension_identifier?: string;
  owner_character_id?: string;
  owner_chat_id?: string;
  strip_audio?: boolean;
  transcode_video_codec?: NormalizedVideoCodec;
  sidecar_video_codecs?: NormalizedVideoCodec[];
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

function isWallpaperRef(value: unknown, imageId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as { image_id?: unknown }).image_id === imageId;
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

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
};

function inferUploadMimeType(file: File): string {
  const explicit = (file.type || "").trim().toLowerCase();
  if (explicit) return explicit;
  return MIME_BY_EXT[extname(file.name).toLowerCase()] || "application/octet-stream";
}

function replaceFileExtension(filename: string, nextExt: string): string {
  const base = filename.replace(/\.[^.]+$/, "") || "upload";
  return `${base}${nextExt}`;
}

function uniqueVideoCodecs(codecs: readonly NormalizedVideoCodec[] | undefined): NormalizedVideoCodec[] {
  const ordered: NormalizedVideoCodec[] = [];
  for (const codec of codecs || []) {
    if (codec !== "h264" && codec !== "hevc") continue;
    if (!ordered.includes(codec)) ordered.push(codec);
  }
  return ordered;
}

function videoVariantFilename(id: string, codec: NormalizedVideoCodec): string {
  return `${id}_${codec}.mp4`;
}

function videoVariantPath(dir: string, id: string, codec: NormalizedVideoCodec): string {
  return join(dir, videoVariantFilename(id, codec));
}

function rowToImage(row: any, specificity: ImageSpecificity = "full"): Image {
  return {
    ...row,
    byte_size: row.byte_size ?? 0,
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

async function deriveMediaMetadataAndThumbnails(
  userId: string,
  id: string,
  dir: string,
  source: Buffer,
  mimeType: string,
  originalFilename?: string,
): Promise<{ width: number | null; height: number | null; hasThumbnail: boolean }> {
  let width: number | null = null;
  let height: number | null = null;
  let hasThumbnail = false;

  const thumbnailSource = isLikelyVideoUpload(mimeType, originalFilename)
    ? await extractVideoPosterBuffer(source, mimeType, originalFilename)
    : source;
  if (!thumbnailSource) return { width, height, hasThumbnail };

  try {
    const metadata = await sharp(thumbnailSource).metadata();
    width = metadata.width ?? null;
    height = metadata.height ?? null;

    const sizes = getThumbnailSettings(userId);
    const [smOk, lgOk] = await Promise.all([
      generateThumbnail(thumbnailSource, join(dir, `${id}${thumbSuffix("sm")}`), sizes.smallSize),
      generateThumbnail(thumbnailSource, join(dir, `${id}${thumbSuffix("lg")}`), sizes.largeSize),
    ]);
    hasThumbnail = smOk || lgOk;
  } catch {
    // Non-image or thumbnail derivation failure — leave metadata empty.
  }

  return { width, height, hasThumbnail };
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
  return `_thumb_${tier}_v2.webp`;
}

function legacyThumbSuffix(tier: ThumbTier): string {
  return `_thumb_${tier}.webp`;
}

async function generateThumbnail(
  source: ThumbnailSource,
  outputPath: string,
  size: number
): Promise<boolean> {
  try {
    await sharp(source)
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
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
  const dir = getImagesDir();

  const originalBuffer = Buffer.from(await file.arrayBuffer());
  let buffer = Buffer.from(originalBuffer);
  const originalMimeType = inferUploadMimeType(file);
  let mimeType = originalMimeType;
  const originalFilename = file.name || `upload-${id}`;
  let storedOriginalFilename = originalFilename;
  let storedExtension = extname(storedOriginalFilename).toLowerCase() || ".bin";
  const isVideo = isLikelyVideoUpload(mimeType, storedOriginalFilename);
  const primaryVideoCodec = isVideo ? options?.transcode_video_codec : undefined;
  const sidecarVideoCodecs = uniqueVideoCodecs(options?.sidecar_video_codecs)
    .filter((codec) => codec !== primaryVideoCodec);

  if (isVideo && primaryVideoCodec) {
    const normalized = await normalizeVideoBuffer(originalBuffer, originalMimeType, originalFilename, {
      codec: primaryVideoCodec,
      stripAudio: options?.strip_audio,
    });
    if (normalized) {
      buffer = Buffer.from(normalized.buffer);
      mimeType = normalized.mimeType;
      storedExtension = normalized.ext;
      storedOriginalFilename = replaceFileExtension(storedOriginalFilename, normalized.ext);
    } else if (options?.strip_audio) {
      const stripped = await stripAudioFromVideoBuffer(buffer, mimeType, storedOriginalFilename);
      if (stripped) buffer = Buffer.from(stripped);
    }
  } else if (isVideo && options?.strip_audio) {
    // Wallpaper uploads can opt into a best-effort audio-strip pass so iOS gets
    // a truly silent video without making ffmpeg a hard runtime dependency.
    const stripped = await stripAudioFromVideoBuffer(buffer, mimeType, storedOriginalFilename);
    if (stripped) buffer = Buffer.from(stripped);
  }

  const filename = `${id}${storedExtension}`;
  const filepath = join(dir, filename);
  await Bun.write(filepath, buffer);

  if (isVideo && sidecarVideoCodecs.length > 0) {
    for (const codec of sidecarVideoCodecs) {
      const normalized = await normalizeVideoBuffer(originalBuffer, originalMimeType, originalFilename, {
        codec,
        stripAudio: options?.strip_audio,
      });
      if (!normalized) continue;
      await Bun.write(videoVariantPath(dir, id, codec), normalized.buffer);
    }
  }

  const { width, height, hasThumbnail } = await deriveMediaMetadataAndThumbnails(
    userId,
    id,
    dir,
    buffer,
    mimeType,
    storedOriginalFilename,
  );

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
      userId,
      filename,
      storedOriginalFilename,
      mimeType,
      buffer.byteLength,
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

export async function uploadOptimizedWebpImage(userId: string, file: File, options?: ImageOwnershipOptions): Promise<Image> {
  const id = crypto.randomUUID();
  const filename = `${id}.webp`;
  const dir = getImagesDir();
  const filepath = join(dir, filename);
  const inputBuffer = Buffer.from(await file.arrayBuffer());

  let width: number | null = null;
  let height: number | null = null;
  let hasThumbnail = false;

  const webpBuffer = await sharp(inputBuffer)
    .rotate()
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      width = info.width ?? null;
      height = info.height ?? null;
      return Buffer.from(data);
    });

  await Bun.write(filepath, webpBuffer);

  const derived = await deriveMediaMetadataAndThumbnails(
    userId,
    id,
    dir,
    webpBuffer,
    "image/webp",
  );
  width = derived.width ?? width;
  height = derived.height ?? height;
  hasThumbnail = derived.hasThumbnail;

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
      userId,
      filename,
      file.name,
      "image/webp",
      webpBuffer.byteLength,
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

  const { width, height, hasThumbnail } = await deriveMediaMetadataAndThumbnails(
    userId,
    id,
    dir,
    buffer,
    mimeType,
  );

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
      userId,
      filename,
      originalFilename || `image-gen-${id}${ext}`,
      mimeType,
      buffer.byteLength,
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

export interface UploadImagesItem {
  data: Uint8Array;
  filename: string;
  mime_type: string;
  owner_character_id?: string;
  owner_chat_id?: string;
}

export interface UploadImagesResult {
  id?: string;
  error?: string;
  image?: Image;
}

export async function uploadImages(
  userId: string,
  items: ReadonlyArray<UploadImagesItem>,
  options?: {
    owner_extension_identifier?: string;
    concurrency?: number;
  },
): Promise<UploadImagesResult[]> {
  if (items.length === 0) return [];
  const concurrency = Math.min(Math.max(1, options?.concurrency ?? 16), 32);
  const dir = getImagesDir();
  const ownerExtensionIdentifier = normalizeOwnershipValue(options?.owner_extension_identifier);

  type Prepared = {
    id: string;
    filename: string;
    filepath: string;
    item: UploadImagesItem;
    isImage: boolean;
  };
  const prepared: Array<Prepared | null> = new Array(items.length).fill(null);
  const errors: Array<string | null> = new Array(items.length).fill(null);

  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i]!;
      try {
        if (!(item.data instanceof Uint8Array) || item.data.byteLength === 0) {
          throw new Error("Image data must be a non-empty Uint8Array");
        }
        const id = crypto.randomUUID();
        const ext = extname(item.filename || "") || ".bin";
        const filename = `${id}${ext}`;
        const filepath = join(dir, filename);
        await Bun.write(filepath, item.data);
        prepared[i] = {
          id,
          filename,
          filepath,
          item,
          isImage: (item.mime_type || "").startsWith("image/"),
        };
      } catch (err: any) {
        errors[i] = err?.message ?? String(err);
      }
    }
  };
  const pool: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) pool.push(worker());
  await Promise.all(pool);

  const now = Math.floor(Date.now() / 1000);
  const db = getDb();
  const insertStmt = db.query(
    `INSERT INTO images (
       id, user_id, filename, original_filename, mime_type,
       byte_size, width, height, has_thumbnail,
       owner_extension_identifier, owner_character_id, owner_chat_id,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      if (!p) continue;
      insertStmt.run(
        p.id,
        userId,
        p.filename,
        p.item.filename || "",
        p.item.mime_type || "",
        p.item.data.byteLength,
        null,
        null,
        0,
        ownerExtensionIdentifier,
        normalizeOwnershipValue(p.item.owner_character_id),
        normalizeOwnershipValue(p.item.owner_chat_id),
        now,
      );
    }
  })();

  const results: UploadImagesResult[] = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const p = prepared[i];
    if (!p) {
      results[i] = { error: errors[i] ?? "unknown error" };
      continue;
    }
    const image: Image = {
      id: p.id,
      filename: p.filename,
      original_filename: p.item.filename || "",
      mime_type: p.item.mime_type || "",
      byte_size: p.item.data.byteLength,
      width: null,
      height: null,
      has_thumbnail: false,
      url: buildImageUrl(p.id, "full"),
      specificity: "full",
      owner_extension_identifier: ownerExtensionIdentifier,
      owner_character_id: normalizeOwnershipValue(p.item.owner_character_id),
      owner_chat_id: normalizeOwnershipValue(p.item.owner_chat_id),
      created_at: now,
    };
    results[i] = { id: p.id, image };
    if (p.isImage) scheduleDeferredImageProcessing(userId, p.id, p.filepath);
  }
  return results;
}

function scheduleDeferredImageProcessing(
  userId: string,
  id: string,
  filepath: string,
): void {
  void (async () => {
    try {
      const buffer = Buffer.from(await Bun.file(filepath).arrayBuffer());
      let width: number | null = null;
      let height: number | null = null;
      try {
        const meta = await sharp(buffer).metadata();
        width = meta.width ?? null;
        height = meta.height ?? null;
      } catch {
        return;
      }
      const dir = getImagesDir();
      const sizes = getThumbnailSettings(userId);
      const [smOk, lgOk] = await Promise.all([
        ensureThumbnail(`${id}_sm`, buffer, join(dir, `${id}${thumbSuffix("sm")}`), sizes.smallSize),
        ensureThumbnail(`${id}_lg`, buffer, join(dir, `${id}${thumbSuffix("lg")}`), sizes.largeSize),
      ]);
      const hasThumb = smOk || lgOk;
      getDb()
        .query("UPDATE images SET width = COALESCE(?, width), height = COALESCE(?, height), has_thumbnail = ? WHERE id = ?")
        .run(width, height, hasThumb ? 1 : 0, id);
    } catch (err) {
      console.warn(`[images] deferred image processing failed for ${id}:`, err);
    }
  })();
}

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
  tier?: ThumbTier,
  videoCodec?: NormalizedVideoCodec,
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

  if (!tier && videoCodec && image.mime_type.startsWith("video/")) {
    const variantPath = videoVariantPath(dir, image.id, videoCodec);
    if (existsSync(variantPath)) return variantPath;
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
          for (const suffix of [thumbSuffix(tier), legacyThumbSuffix(tier)]) {
            const p = join(dir, `${img.id}${suffix}`);
            if (existsSync(p)) unlinkSync(p);
          }
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

  for (const codec of ["h264", "hevc"] as const) {
    const variantPath = videoVariantPath(dir, image.id, codec);
    if (existsSync(variantPath)) unlinkSync(variantPath);
  }

  // Remove all thumbnail tiers
  for (const tier of ["sm", "lg"] as const) {
    for (const suffix of [thumbSuffix(tier), legacyThumbSuffix(tier)]) {
      const p = join(dir, `${image.id}${suffix}`);
      if (existsSync(p)) unlinkSync(p);
    }
  }

  const result = getDb().query("DELETE FROM images WHERE id = ? AND user_id = ?").run(id, userId);
  if (result.changes > 0) {
    eventBus.emit(EventType.IMAGE_DELETED, { id }, userId);
  }
  return result.changes > 0;
}

function clearWallpaperAssignments(userId: string, imageId: string): void {
  const wallpaperSetting = settingsSvc.getSetting(userId, "wallpaper");
  if (wallpaperSetting?.value && typeof wallpaperSetting.value === "object" && !Array.isArray(wallpaperSetting.value)) {
    const current = wallpaperSetting.value as Record<string, unknown>;
    if (isWallpaperRef(current.global, imageId)) {
      settingsSvc.putSetting(userId, "wallpaper", { ...current, global: null });
    }
  }

  const candidateRows = getDb()
    .query("SELECT id FROM chats WHERE user_id = ? AND metadata LIKE ?")
    .all(userId, `%${imageId}%`) as Array<{ id: string }>;

  for (const row of candidateRows) {
    const chat = chatsSvc.getChat(userId, row.id);
    if (!chat || !isWallpaperRef(chat.metadata?.wallpaper, imageId)) continue;
    chatsSvc.mergeChatMetadata(userId, row.id, { wallpaper: null });
  }
}

export function deleteWallpaperLibraryImage(userId: string, id: string): boolean {
  const image = getImage(userId, id, { owner_extension_identifier: WALLPAPER_LIBRARY_OWNER });
  if (!image) return false;

  clearWallpaperAssignments(userId, id);
  return deleteImage(userId, id);
}

function hasImageReference(sql: string, params: any[]): boolean {
  try {
    const row = getDb().query(sql).get(...params) as { found?: number } | undefined;
    return !!row?.found;
  } catch {
    // Some focused tests construct partial schemas; missing tables/columns mean
    // there cannot be a reference in that test database.
    return false;
  }
}

export function isImageReferenced(userId: string, id: string): boolean {
  const needle = `%${id}%`;
  return (
    hasImageReference(
      "SELECT 1 AS found FROM images WHERE user_id = ? AND id = ? AND owner_extension_identifier = ? LIMIT 1",
      [userId, id, WALLPAPER_LIBRARY_OWNER],
    ) ||
    hasImageReference(
      "SELECT 1 AS found FROM character_gallery WHERE user_id = ? AND image_id = ? LIMIT 1",
      [userId, id],
    ) ||
    hasImageReference(
      `SELECT 1 AS found FROM characters
       WHERE user_id = ? AND (
         image_id = ? OR extensions LIKE ? OR description LIKE ? OR personality LIKE ? OR scenario LIKE ?
         OR first_mes LIKE ? OR mes_example LIKE ? OR creator_notes LIKE ? OR system_prompt LIKE ?
         OR post_history_instructions LIKE ? OR alternate_greetings LIKE ?
       ) LIMIT 1`,
      [userId, id, needle, needle, needle, needle, needle, needle, needle, needle, needle, needle],
    ) ||
    hasImageReference(
      "SELECT 1 AS found FROM personas WHERE user_id = ? AND (image_id = ? OR metadata LIKE ?) LIMIT 1",
      [userId, id, needle],
    ) ||
    hasImageReference(
      "SELECT 1 AS found FROM theme_assets WHERE user_id = ? AND image_id = ? LIMIT 1",
      [userId, id],
    ) ||
    hasImageReference(
      "SELECT 1 AS found FROM chats WHERE user_id = ? AND metadata LIKE ? LIMIT 1",
      [userId, needle],
    ) ||
    hasImageReference(
      `SELECT 1 AS found FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE c.user_id = ? AND (m.extra LIKE ? OR m.swipes LIKE ? OR m.content LIKE ?) LIMIT 1`,
      [userId, needle, needle, needle],
    ) ||
    hasImageReference(
      "SELECT 1 AS found FROM settings WHERE user_id = ? AND value LIKE ? LIMIT 1",
      [userId, needle],
    )
  );
}

export function deleteImageIfUnreferenced(userId: string, id: string): boolean {
  if (isImageReferenced(userId, id)) return false;
  return deleteImage(userId, id);
}
