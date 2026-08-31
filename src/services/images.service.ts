import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { env } from "../env";
import { currentWorkerBudget } from "../utils/cpu-budget";
import { classifyUserMediaContentType } from "../utils/user-media-headers";
import {
  convertImageToWebp,
  readImageMetadata,
  writeInsideAvif,
  writeInsideWebp,
} from "../utils/image-pipeline";
import {
  getSharpSettingsStatus,
  type ThumbnailCodec,
} from "./sharp-settings.service";
import type { Image } from "../types/image";
import { mkdirSync, existsSync, lstatSync, readdirSync, statSync, unlinkSync } from "fs";
import { unlink } from "fs/promises";
import { join, extname, basename } from "path";
import {
  extractVideoPosterBuffer,
  isLikelyVideoUpload,
  normalizeVideoBuffer,
  stripAudioFromVideoBuffer,
  type NormalizedVideoCodec,
  type VideoTranscodeProgress,
} from "./silent-video.service";
import * as settingsSvc from "./settings.service";
import * as chatsSvc from "./chats.service";
import {
  completeImageProcessingJob,
  describeImageProcessingRecovery,
  discardRecoverableImageProcessingJobs,
  listRecoverableImageProcessingJobs,
  recordImageProcessingJob,
  summarizeImageProcessingRecovery,
  type ImageProcessingJobKind,
  type ImageProcessingQueueJob,
  type ImageProcessingQueueRecovery,
} from "./image-processing-queue";

export { describeImageProcessingRecovery };
export type { ImageProcessingQueueRecovery };

import { SERVER_IMAGE_GENERATION_PROVENANCE } from "./image-provenance";
import { validateSafeMediaBytes, validateSafeMediaFile } from "./user-data/media-validation";
import { mediaPolicyLimit } from "../types/media-limits";
import { withUserDataMutation, withUserDataMutationSync } from "./user-data/snapshot";
const IMAGES_DIR = "images";

const DEFAULT_SMALL_SIZE = 300;
const DEFAULT_LARGE_SIZE = 700;
const WEBP_QUALITY = 80;
export const WALLPAPER_LIBRARY_OWNER = "lumiverse.wallpaper";

type ThumbnailSource = Buffer | string;

const inflightThumbnailGenerations = new Map<string, Promise<boolean>>();

interface DeferredImageJob {
  persistId: string;
  run: () => Promise<void>;
}

const deferredImageQueue: DeferredImageJob[] = [];
const liveImageProcessingJobIds = new Set<string>();
let deferredImageActive = 0;
let deferredImageWaiters: Array<() => void> = [];
let deferredImageWaveTotal = 0;
let deferredImageWaveCompleted = 0;
let lastDeferredImageStatusEmitAt = 0;

const DEFERRED_IMAGE_STATUS_EMIT_MS = 150;

export interface DeferredImageProcessingStatus {
  processed: number;
  remaining: number;
  total: number;
  active: number;
  queued: number;
}

export function getDeferredImageProcessingStatus(): DeferredImageProcessingStatus {
  const live = liveDeferredImageProcessingStatus();
  if (live.remaining > 0) return live;
  if (lastExternalDeferredStatus && lastExternalDeferredStatus.remaining > 0) {
    return lastExternalDeferredStatus;
  }
  return lastExternalDeferredStatus ?? live;
}

let lastExternalDeferredStatus: DeferredImageProcessingStatus | null = null;

export function applyExternalDeferredImageProcessingStatus(
  status: DeferredImageProcessingStatus,
): void {
  lastExternalDeferredStatus = status;
}

export function setExternalThumbnailWorkActive(active: boolean): void {
  isolatedThumbnailWorkActive = active;
  if (!active) lastExternalDeferredStatus = null;
}

let isolatedThumbnailWorkActive = false;

export function getImageProcessingRecovery(): ImageProcessingQueueRecovery {
  if (isolatedThumbnailWorkActive) {
    return { pending: 0, process: 0, rebuild: 0 };
  }
  return summarizeImageProcessingRecovery(liveImageProcessingJobIds);
}


function liveDeferredImageProcessingStatus(): DeferredImageProcessingStatus {
  const queued = deferredImageQueue.length;
  const remaining = deferredImageActive + queued;
  return {
    processed: deferredImageWaveCompleted,
    remaining,
    total: deferredImageWaveTotal,
    active: deferredImageActive,
    queued,
  };
}

export type ThumbTier = "sm" | "lg";
export type ImageSpecificity = "full" | ThumbTier;

export interface ImageOwnershipOptions {
  owner_extension_identifier?: string;
  owner_character_id?: string;
  owner_chat_id?: string;
  skip_thumbnail_processing?: boolean;
  strip_audio?: boolean;
  transcode_video_codec?: NormalizedVideoCodec;
  sidecar_video_codecs?: NormalizedVideoCodec[];
  on_progress?: (progress: ImageUploadProgress) => void;
}

export interface ImageQueryOptions extends ImageOwnershipOptions {
  specificity?: ImageSpecificity;
}

export type ImageUploadProgressPhase =
  | "received"
  | "transcoding_primary"
  | "transcoding_variant"
  | "extracting_poster"
  | "finalizing"
  | "completed";

export interface ImageUploadProgress {
  phase: ImageUploadProgressPhase;
  step: number;
  totalSteps: number;
  codec?: NormalizedVideoCodec;
  phaseProgressPct?: number;
  currentTimeMs?: number;
  durationMs?: number;
  speed?: number;
}

export interface ThumbnailSettings {
  smallSize: number;
  largeSize: number;
}

interface ThumbnailEncodingSettings {
  codec: ThumbnailCodec;
  quality: number;
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

/**
 * Write an image asset and verify that the complete payload is present before
 * its database record can be created. Bun.write reports the byte count, but a
 * short write would otherwise still leave the upload flow able to create a row
 * for an incomplete or missing file.
 */
async function writeImageFile(filepath: string, data: Uint8Array): Promise<void> {
  const expectedBytes = data.byteLength;
  const bytesWritten = await Bun.write(filepath, data);

  let actualBytes: number;
  try {
    actualBytes = statSync(filepath).size;
  } catch (err) {
    throw new Error(`Image file was not created at ${filepath}`, { cause: err });
  }

  if (bytesWritten === expectedBytes && actualBytes === expectedBytes) return;

  // The filename is a new UUID, so removing a partial result cannot affect an
  // existing upload. Do this best-effort; either way the DB insert is skipped.
  try {
    unlinkSync(filepath);
  } catch {
    // Preserve the original write-validation error below.
  }
  throw new Error(
    `Image file write was incomplete at ${filepath}: expected ${expectedBytes} bytes, wrote ${bytesWritten}, found ${actualBytes}`,
  );
}

const MIME_BY_EXT: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ico": "image/x-icon",
  ".jfif": "image/jpeg",
  ".png": "image/png",
  ".pjp": "image/jpeg",
  ".pjpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
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

function safeMediaValidationIdentity(filename: string, mimeType: string): { filename: string; mimeType: string } {
  if (extname(filename).toLowerCase() === ".apng" && mimeType === "image/apng") {
    return { filename: replaceFileExtension(filename, ".png"), mimeType: "image/png" };
  }
  return { filename, mimeType };
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
    skip_thumbnail_processing: !!row.skip_thumbnail_processing,
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
  hooks?: {
    onPosterExtractionStarted?: () => void;
    onPosterExtractionCompleted?: () => void;
  },
): Promise<{ width: number | null; height: number | null; hasThumbnail: boolean }> {
  let width: number | null = null;
  let height: number | null = null;
  let hasThumbnail = false;

  let thumbnailSource: Buffer | null = source;
  if (isLikelyVideoUpload(mimeType, originalFilename)) {
    hooks?.onPosterExtractionStarted?.();
    thumbnailSource = await extractVideoPosterBuffer(source, mimeType, originalFilename);
    hooks?.onPosterExtractionCompleted?.();
  }
  if (!thumbnailSource) return { width, height, hasThumbnail };

  try {
    const metadata = await readImageMetadata(thumbnailSource);
    width = metadata.width;
    height = metadata.height;

    const sizes = getThumbnailSettings(userId);
    const encoding = getThumbnailEncodingSettings();
    const [smOk, lgOk] = await Promise.all([
      generateThumbnail(
        thumbnailSource,
        join(dir, `${id}${thumbSuffix("sm", encoding.codec)}`),
        sizes.smallSize,
        encoding,
      ),
      generateThumbnail(
        thumbnailSource,
        join(dir, `${id}${thumbSuffix("lg", encoding.codec)}`),
        sizes.largeSize,
        encoding,
      ),
    ]);
    hasThumbnail = smOk || lgOk;
  } catch {
    // Non-image or thumbnail derivation failure — leave metadata empty.
  }

  return { width, height, hasThumbnail };
}

function emitImageUploadProgress(
  options: ImageOwnershipOptions | undefined,
  progress: ImageUploadProgress,
): void {
  try {
    options?.on_progress?.(progress);
  } catch (err) {
    console.error("[images] upload progress listener failed:", err);
  }
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

function getThumbnailEncodingSettings(): ThumbnailEncodingSettings {
  const settings = getSharpSettingsStatus().effectiveSettings;
  const codec = settings.thumbnailCodec;
  return {
    codec,
    quality: codec === "avif" ? settings.avifQuality : settings.webpQuality,
  };
}

function thumbSuffix(tier: ThumbTier, codec: ThumbnailCodec): string {
  return `_thumb_${tier}_v2.${codec}`;
}

function legacyThumbSuffix(tier: ThumbTier): string {
  return `_thumb_${tier}.webp`;
}

function thumbnailSuffixes(tier: ThumbTier): string[] {
  return [thumbSuffix(tier, "webp"), thumbSuffix(tier, "avif"), legacyThumbSuffix(tier)];
}

function isThumbnailFilename(name: string): boolean {
  return name.includes("_thumb_");
}

async function generateThumbnail(
  source: ThumbnailSource,
  outputPath: string,
  size: number,
  encoding: ThumbnailEncodingSettings,
): Promise<boolean> {
  try {
    if (encoding.codec === "avif") {
      await writeInsideAvif(source, outputPath, size, size, encoding.quality, {
        withoutEnlargement: true,
      });
    } else {
      await writeInsideWebp(source, outputPath, size, size, encoding.quality, {
        withoutEnlargement: true,
      });
    }
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
  encoding: ThumbnailEncodingSettings,
): Promise<boolean> {
  const encodingCacheKey = `${cacheKey}:${encoding.codec}:q${encoding.quality}`;
  const existing = inflightThumbnailGenerations.get(encodingCacheKey);
  if (existing) return existing;

  const job = generateThumbnail(source, outputPath, size, encoding).finally(() => {
    inflightThumbnailGenerations.delete(encodingCacheKey);
  });
  inflightThumbnailGenerations.set(encodingCacheKey, job);
  return job;
}
async function uploadImageUnsafe(userId: string, file: File, options?: ImageOwnershipOptions): Promise<Image> {
  const id = crypto.randomUUID();
  const dir = getImagesDir();

  const originalMimeType = inferUploadMimeType(file);
  const originalFilename = file.name || `upload-${id}`;
  const isVideo = isLikelyVideoUpload(originalMimeType, originalFilename);

  // Ordinary raster uploads need no request-time transformation. Persist them
  // immediately and let the bounded/recoverable worker queue derive metadata
  // and thumbnails. Video uploads stay on the synchronous path because their
  // response depends on transcoding, sidecars, and poster extraction.
  if (!isVideo) {
    emitImageUploadProgress(options, { phase: "received", step: 0, totalSteps: 1 });
    const image = await uploadImageDeferredUnsafe(userId, file, options);
    emitImageUploadProgress(options, { phase: "finalizing", step: 1, totalSteps: 1 });
    emitImageUploadProgress(options, { phase: "completed", step: 1, totalSteps: 1 });
    return image;
  }

  const originalBuffer = Buffer.from(await file.arrayBuffer());
  let buffer = Buffer.from(originalBuffer);
  let mimeType = originalMimeType;
  let storedOriginalFilename = originalFilename;
  let storedExtension = extname(storedOriginalFilename).toLowerCase() || ".bin";
  const primaryVideoCodec = options?.transcode_video_codec;
  const sidecarVideoCodecs = uniqueVideoCodecs(options?.sidecar_video_codecs)
    .filter((codec) => codec !== primaryVideoCodec);
  const totalProgressSteps = (() => {
    let total = 1; // finalizing
    if (primaryVideoCodec) total += 1;
    total += sidecarVideoCodecs.length;
    total += 1; // poster extraction
    return total;
  })();
  let currentProgressStep = 0;
  const emitProgress = (
    phase: ImageUploadProgressPhase,
    extra?: Omit<Partial<ImageUploadProgress>, "phase" | "step" | "totalSteps">,
  ) => {
    emitImageUploadProgress(options, {
      phase,
      step: currentProgressStep,
      totalSteps: totalProgressSteps,
      ...extra,
    });
  };
  const advanceProgress = (
    phase: ImageUploadProgressPhase,
    extra?: Omit<Partial<ImageUploadProgress>, "phase" | "step" | "totalSteps">,
  ) => {
    currentProgressStep = Math.min(totalProgressSteps, currentProgressStep + 1);
    emitProgress(phase, extra);
  };
  const emitTranscodeProgress = (
    phase: Extract<ImageUploadProgressPhase, "transcoding_primary" | "transcoding_variant">,
    codec: NormalizedVideoCodec,
    progress: VideoTranscodeProgress,
  ) => {
    emitProgress(phase, {
      codec,
      phaseProgressPct: progress.percent ?? undefined,
      currentTimeMs: progress.currentTimeMs ?? undefined,
      durationMs: progress.durationMs ?? undefined,
      speed: progress.speed ?? undefined,
    });
  };

  emitProgress("received");

  if (primaryVideoCodec) {
    advanceProgress("transcoding_primary", {
      codec: primaryVideoCodec,
      phaseProgressPct: 0,
    });
    const normalized = await normalizeVideoBuffer(originalBuffer, originalMimeType, originalFilename, {
      codec: primaryVideoCodec,
      stripAudio: options?.strip_audio,
      onProgress: (progress) => emitTranscodeProgress("transcoding_primary", primaryVideoCodec, progress),
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
  } else if (options?.strip_audio) {
    // Wallpaper uploads can opt into a best-effort audio-strip pass so iOS gets
    // a truly silent video without making ffmpeg a hard runtime dependency.
    const stripped = await stripAudioFromVideoBuffer(buffer, mimeType, storedOriginalFilename);
    if (stripped) buffer = Buffer.from(stripped);
  }

  const validated = validateSafeMediaBytes(buffer, {
    filename: `${id}${storedExtension}`,
    bucket: "images",
    mediaPolicy: isVideo ? "image_or_video" : "image",
    expectedMimeType: mimeType,
  });
  mimeType = validated.contentType;
  storedExtension = validated.extension;
  const filename = `${id}${storedExtension}`;
  const filepath = join(dir, filename);
  await writeImageFile(filepath, buffer);

  if (sidecarVideoCodecs.length > 0) {
    for (const codec of sidecarVideoCodecs) {
      advanceProgress("transcoding_variant", {
        codec,
        phaseProgressPct: 0,
      });
      const normalized = await normalizeVideoBuffer(originalBuffer, originalMimeType, originalFilename, {
        codec,
        stripAudio: options?.strip_audio,
        onProgress: (progress) => emitTranscodeProgress("transcoding_variant", codec, progress),
      });
      if (!normalized) continue;
      await writeImageFile(videoVariantPath(dir, id, codec), normalized.buffer);
    }
  }

  let finalizingStarted = false;
  const { width, height, hasThumbnail } = options?.skip_thumbnail_processing
    ? { width: null, height: null, hasThumbnail: false }
    : await deriveMediaMetadataAndThumbnails(
      userId,
      id,
      dir,
      buffer,
      mimeType,
      storedOriginalFilename,
      {
        onPosterExtractionStarted: () => advanceProgress("extracting_poster"),
        onPosterExtractionCompleted: () => {
          finalizingStarted = true;
          advanceProgress("finalizing");
        },
      },
    );
  if (!finalizingStarted) {
    advanceProgress("finalizing");
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
         byte_size,
         width,
         height,
         has_thumbnail,
         owner_extension_identifier,
         owner_character_id,
         owner_chat_id,
         skip_thumbnail_processing,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      options?.skip_thumbnail_processing ? 1 : 0,
      now,
    );

  const image = getImage(userId, id)!;
  emitProgress("completed");
  eventBus.emit(EventType.IMAGE_UPLOADED, { image }, userId);
  return image;
}

export async function uploadImage(userId: string, file: File, options?: ImageOwnershipOptions): Promise<Image> {
  return withUserDataMutation(userId, () => uploadImageUnsafe(userId, file, options));
}

async function uploadOptimizedWebpImageUnsafe(userId: string, file: File, options?: ImageOwnershipOptions): Promise<Image> {
  const id = crypto.randomUUID();
  const filename = `${id}.webp`;
  const dir = getImagesDir();
  const filepath = join(dir, filename);
  const inputBuffer = Buffer.from(await file.arrayBuffer());

  let width: number | null = null;
  let height: number | null = null;
  const hasThumbnail = false;

  const webpBuffer = await convertImageToWebp(inputBuffer, WEBP_QUALITY, {
    autoOrient: true,
  });
  const metadata = await readImageMetadata(webpBuffer);
  width = metadata.width;
  height = metadata.height;

  await writeImageFile(filepath, webpBuffer);

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
         skip_thumbnail_processing,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      options?.skip_thumbnail_processing ? 1 : 0,
      now,
    );

  const image = getImage(userId, id)!;
  if (!options?.skip_thumbnail_processing) {
    scheduleDeferredImageProcessing(userId, id, filepath);
  }
  eventBus.emit(EventType.IMAGE_UPLOADED, { image }, userId);
  return image;
}

export async function uploadOptimizedWebpImage(userId: string, file: File, options?: ImageOwnershipOptions): Promise<Image> {
  return withUserDataMutation(userId, () => uploadOptimizedWebpImageUnsafe(userId, file, options));
}

/**
 * Save an image from a base64 data URL (e.g. from image generation).
 * Creates the image record and queues metadata/thumbnail processing.
 */
async function saveImageFromDataUrlUnsafe(
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
  const mediaPolicy = mimeType.startsWith("video/") ? "image_or_video" : "image";
  const maxBytes = mediaPolicyLimit(mediaPolicy);
  if (maxBytes === null) throw new Error("Unsupported generated image media policy");
  // Bound the allocation before decoding: base64 expands to 3 bytes per 4 chars.
  if (Math.floor((base64.length * 3) / 4) > maxBytes) {
    throw new Error("Generated image exceeds the image byte ceiling");
  }

  const buffer = Buffer.from(base64, "base64");
  const filename = originalFilename || `image-gen-${crypto.randomUUID()}${ext}`;
  return uploadImageDeferredUnsafe(
    userId,
    new File([buffer], filename, { type: mimeType }),
    options,
    SERVER_IMAGE_GENERATION_PROVENANCE,
  );
}

export async function saveImageFromDataUrl(
  userId: string,
  dataUrl: string,
  originalFilename?: string,
  options?: ImageOwnershipOptions,
): Promise<Image> {
  return withUserDataMutation(userId, () => saveImageFromDataUrlUnsafe(userId, dataUrl, originalFilename, options));
}

export interface UploadImagesItem {
  data: Uint8Array;
  filename: string;
  mime_type: string;
  owner_character_id?: string;
  owner_chat_id?: string;
  skip_thumbnail_processing?: boolean;
}

export interface UploadImagesResult {
  id?: string;
  error?: string;
  image?: Image;
}

async function uploadImagesUnsafe(
  userId: string,
  items: ReadonlyArray<UploadImagesItem>,
  options?: {
    owner_extension_identifier?: string;
    concurrency?: number;
    /** Leave metadata/thumbnails to the existing lazy read path. */
    deferProcessing?: boolean;
    /** Server-owned provenance; intentionally unavailable on the public batch API. */
    publicProvenance?: typeof SERVER_IMAGE_GENERATION_PROVENANCE;
  },
): Promise<UploadImagesResult[]> {
  if (items.length === 0) return [];
  const concurrency = Math.min(Math.max(1, options?.concurrency ?? currentWorkerBudget().workerConcurrency), 16);
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
        const uploadMime = (item.mime_type || "").split(";")[0].trim().toLowerCase();
        const isActiveContent = classifyUserMediaContentType(uploadMime) === "active";
        if (!isActiveContent) {
          const validationIdentity = safeMediaValidationIdentity(item.filename, uploadMime);
          validateSafeMediaBytes(item.data, {
            filename: validationIdentity.filename,
            bucket: "images",
            mediaPolicy: uploadMime.startsWith("video/") ? "image_or_video" : "image",
            expectedMimeType: validationIdentity.mimeType,
          });
        }
        const id = crypto.randomUUID();
        // Active content (HTML/XHTML) is stored inert: strip the executable
        // extension and demote the mime so no serving path can render it
        // inline. This is the single choke point for every image upload path
        // (direct upload, deferred, data-URL, bulk, gallery extraction).
        const ext = isActiveContent ? ".bin" : (extname(item.filename || "").toLowerCase() || ".bin");
        const filename = `${id}${ext}`;
        const filepath = join(dir, filename);
        await writeImageFile(filepath, item.data);
        prepared[i] = {
          id,
          filename,
          filepath,
          item: isActiveContent ? { ...item, mime_type: "application/octet-stream" } : item,
          isImage: !isActiveContent && (item.mime_type || "").startsWith("image/"),
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
       skip_thumbnail_processing, public_provenance,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        p.item.skip_thumbnail_processing ? 1 : 0,
        options?.publicProvenance ?? null,
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
      skip_thumbnail_processing: !!p.item.skip_thumbnail_processing,
      url: buildImageUrl(p.id, "full"),
      specificity: "full",
      owner_extension_identifier: ownerExtensionIdentifier,
      owner_character_id: normalizeOwnershipValue(p.item.owner_character_id),
      owner_chat_id: normalizeOwnershipValue(p.item.owner_chat_id),
      created_at: now,
    };
    results[i] = { id: p.id, image };
    if (p.isImage && !p.item.skip_thumbnail_processing && options?.deferProcessing !== false) {
      scheduleDeferredImageProcessing(userId, p.id, p.filepath);
    }
  }
  return results;
}

export async function uploadImages(
  userId: string,
  items: ReadonlyArray<UploadImagesItem>,
  options?: {
    owner_extension_identifier?: string;
    concurrency?: number;
    /** Leave metadata/thumbnails to the bounded persistent worker queue. */
    deferProcessing?: boolean;
  },
): Promise<UploadImagesResult[]> {
  return withUserDataMutation(userId, () => uploadImagesUnsafe(userId, items, options));
}

/**
 * Store one ordinary image through the batched/deferred pipeline.
 *
 * Use this for request paths that do not need synchronous media transforms.
 * It keeps Sharp work off the request path while preserving the single-upload
 * ownership and IMAGE_UPLOADED semantics.
 */
type DeferredImageOwnershipOptions = Pick<
  ImageOwnershipOptions,
  "owner_extension_identifier" | "owner_character_id" | "owner_chat_id" | "skip_thumbnail_processing"
>;

async function uploadImageDeferredUnsafe(
  userId: string,
  file: File,
  options?: DeferredImageOwnershipOptions,
  publicProvenance?: typeof SERVER_IMAGE_GENERATION_PROVENANCE,
): Promise<Image> {
  const [result] = await uploadImagesUnsafe(
    userId,
    [{
      data: new Uint8Array(await file.arrayBuffer()),
      filename: file.name,
      mime_type: inferUploadMimeType(file),
      owner_character_id: options?.owner_character_id,
      owner_chat_id: options?.owner_chat_id,
      skip_thumbnail_processing: options?.skip_thumbnail_processing,
    }],
    {
      owner_extension_identifier: options?.owner_extension_identifier,
      deferProcessing: true,
      publicProvenance,
    },
  );

  if (!result?.image) {
    throw new Error(result?.error || "Image upload failed");
  }

  eventBus.emit(EventType.IMAGE_UPLOADED, { image: result.image }, userId);
  return result.image;
}

export async function uploadImageDeferred(
  userId: string,
  file: File,
  options?: DeferredImageOwnershipOptions,
): Promise<Image> {
  return withUserDataMutation(userId, () => uploadImageDeferredUnsafe(userId, file, options));
}

function notifyDeferredImageIdle(): void {
  if (deferredImageActive > 0 || deferredImageQueue.length > 0) return;
  const waiters = deferredImageWaiters;
  deferredImageWaiters = [];
  for (const resolve of waiters) resolve();
}

function emitDeferredImageStatus(force = false): void {
  const status = liveDeferredImageProcessingStatus();
  const now = Date.now();
  if (!force && lastDeferredImageStatusEmitAt > 0 && now - lastDeferredImageStatusEmitAt < DEFERRED_IMAGE_STATUS_EMIT_MS) {
    return;
  }
  lastDeferredImageStatusEmitAt = now;
  if (status.remaining > 0) lastExternalDeferredStatus = null;
  if (process.env.LUMIVERSE_ST_MIGRATION_CHILD === "1" && typeof process.send === "function") {
    process.send({ type: "thumbnailQueue", ...status });
  }
  eventBus.emit(EventType.IMAGE_THUMBNAIL_QUEUE, status);
}

function pumpDeferredImageQueue(): void {
  const limit = currentWorkerBudget().deferredImageConcurrency;
  while (deferredImageActive < limit) {
    const queued = deferredImageQueue.shift();
    if (!queued) break;
    deferredImageActive++;
    emitDeferredImageStatus();
    void queued.run().finally(() => {
      deferredImageActive--;
      deferredImageWaveCompleted++;
      completeImageProcessingJob(queued.persistId);
      liveImageProcessingJobIds.delete(queued.persistId);
      if (deferredImageQueue.length > 0) pumpDeferredImageQueue();
      else notifyDeferredImageIdle();
      emitDeferredImageStatus(deferredImageActive === 0 && deferredImageQueue.length === 0);
    });
  }
}

async function processDeferredImage(
  userId: string,
  id: string,
  filepath: string,
): Promise<void> {
  const row = getDb()
    .query("SELECT skip_thumbnail_processing FROM images WHERE id = ?")
    .get(id) as { skip_thumbnail_processing: number } | undefined;
  if (!row || row.skip_thumbnail_processing) return;

  let width: number | null = null;
  let height: number | null = null;
  try {
    const meta = await readImageMetadata(filepath);
    width = meta.width;
    height = meta.height;
  } catch {
    return;
  }
  const dir = getImagesDir();
  const sizes = getThumbnailSettings(userId);
  const encoding = getThumbnailEncodingSettings();
  // Run tiers sequentially. The outer queue owns concurrency; fanning out here
  // multiplies native libvips pipelines during bursts of embedded-image imports.
  const smOk = await ensureThumbnail(
    `${id}_sm`,
    filepath,
    join(dir, `${id}${thumbSuffix("sm", encoding.codec)}`),
    sizes.smallSize,
    encoding,
  );
  const lgOk = await ensureThumbnail(
    `${id}_lg`,
    filepath,
    join(dir, `${id}${thumbSuffix("lg", encoding.codec)}`),
    sizes.largeSize,
    encoding,
  );
  const hasThumb = smOk || lgOk;
  getDb()
    .query("UPDATE images SET width = COALESCE(?, width), height = COALESCE(?, height), has_thumbnail = ? WHERE id = ?")
    .run(width, height, hasThumb ? 1 : 0, id);
}
function enqueueDeferredImageJob(persistId: string, job: () => Promise<void>): void {
  if (deferredImageActive === 0 && deferredImageQueue.length === 0) {
    deferredImageWaveTotal = 0;
    deferredImageWaveCompleted = 0;
  }
  deferredImageWaveTotal++;
  liveImageProcessingJobIds.add(persistId);
  deferredImageQueue.push({
    persistId,
    run: async () => {
      try {
        await job();
      } catch (err) {
        console.warn("[images] deferred image processing failed:", err);
      }
    },
  });
  pumpDeferredImageQueue();
}

function enqueuePersistentImageJob(
  userId: string,
  imageId: string,
  kind: ImageProcessingJobKind,
  job: () => Promise<void>,
): void {
  const recorded = recordImageProcessingJob(userId, imageId, kind);
  enqueueDeferredImageJob(recorded.id, () => withUserDataMutation(userId, job));
}

function scheduleDeferredImageProcessing(
  userId: string,
  id: string,
  filepath: string,
): void {
  enqueuePersistentImageJob(userId, id, "process", () => processDeferredImage(userId, id, filepath));
}

function scheduleRebuildThumbnailJob(
  userId: string,
  id: string,
  filename: string,
  progress: ThumbnailRebuildProgress,
  onProgress?: (p: ThumbnailRebuildProgress) => void,
): void {
  enqueuePersistentImageJob(userId, id, "rebuild", async () => {
    try {
      const row = getDb()
        .query("SELECT skip_thumbnail_processing FROM images WHERE id = ?")
        .get(id) as { skip_thumbnail_processing: number } | undefined;
      if (!row || row.skip_thumbnail_processing) {
        progress.skipped++;
        return;
      }

      const dir = getImagesDir();
      const originalPath = join(dir, filename);
      if (!existsSync(originalPath)) {
        getDb().query("UPDATE images SET has_thumbnail = 0 WHERE id = ?").run(id);
        progress.skipped++;
        return;
      }

      const sizes = getThumbnailSettings(userId);
      const encoding = getThumbnailEncodingSettings();
      const smOk = await generateThumbnail(
        originalPath,
        join(dir, `${id}${thumbSuffix("sm", encoding.codec)}`),
        sizes.smallSize,
        encoding,
      );
      const lgOk = await generateThumbnail(
        originalPath,
        join(dir, `${id}${thumbSuffix("lg", encoding.codec)}`),
        sizes.largeSize,
        encoding,
      );

      if (smOk || lgOk) {
        getDb().query("UPDATE images SET has_thumbnail = 1 WHERE id = ?").run(id);
        progress.generated++;
        return;
      }
      progress.failed++;
    } catch (err) {
      progress.failed++;
      console.warn(`[images] rebuild thumbnail failed for ${id}:`, err);
    } finally {
      progress.current++;
      onProgress?.({ ...progress });
    }
  });
}

export async function waitForDeferredImageProcessing(): Promise<void> {
  if (deferredImageActive === 0 && deferredImageQueue.length === 0) return;
  await new Promise<void>((resolve) => {
    deferredImageWaiters.push(resolve);
    notifyDeferredImageIdle();
  });
}

export function resetDeferredImageProcessingForTests(): void {
  deferredImageQueue.length = 0;
  liveImageProcessingJobIds.clear();
  deferredImageActive = 0;
  deferredImageWaiters = [];
  deferredImageWaveTotal = 0;
  deferredImageWaveCompleted = 0;
  lastDeferredImageStatusEmitAt = 0;
  lastExternalDeferredStatus = null;
  isolatedThumbnailWorkActive = false;
}


function runRecoverableImageJob(job: ImageProcessingQueueJob, image: { id: string; filename: string }): void {
  const dir = getImagesDir();
  const filepath = join(dir, image.filename);
  if (job.kind === "rebuild") {
    const progress: ThumbnailRebuildProgress = {
      total: 1,
      current: 0,
      generated: 0,
      skipped: 0,
      failed: 0,
    };
    enqueueDeferredImageJob(job.id, () => withUserDataMutation(job.userId, () =>
      scheduleRecoverRebuildBody(job.userId, image.id, image.filename, progress)
    ));
    return;
  }
  enqueueDeferredImageJob(job.id, () => withUserDataMutation(
    job.userId,
    () => processDeferredImage(job.userId, image.id, filepath),
  ));
}

async function scheduleRecoverRebuildBody(
  userId: string,
  id: string,
  filename: string,
  progress: ThumbnailRebuildProgress,
): Promise<void> {
  const dir = getImagesDir();
  const originalPath = join(dir, filename);
  if (!existsSync(originalPath)) {
    progress.skipped++;
    return;
  }
  for (const tier of ["sm", "lg"] as const) {
    for (const suffix of thumbnailSuffixes(tier)) {
      const p = join(dir, `${id}${suffix}`);
      if (existsSync(p)) unlinkSync(p);
    }
  }
  const sizes = getThumbnailSettings(userId);
  const encoding = getThumbnailEncodingSettings();
  const smOk = await generateThumbnail(
    originalPath,
    join(dir, `${id}${thumbSuffix("sm", encoding.codec)}`),
    sizes.smallSize,
    encoding,
  );
  const lgOk = await generateThumbnail(
    originalPath,
    join(dir, `${id}${thumbSuffix("lg", encoding.codec)}`),
    sizes.largeSize,
    encoding,
  );
  if (smOk || lgOk) {
    getDb().query("UPDATE images SET has_thumbnail = 1 WHERE id = ?").run(id);
    progress.generated++;
    return;
  }
  progress.failed++;
}

export function recoverImageProcessingQueue(): ImageProcessingQueueRecovery {
  const leftovers = listRecoverableImageProcessingJobs(liveImageProcessingJobIds);
  for (const job of leftovers) {
    const image = getDb()
      .query("SELECT id, filename, skip_thumbnail_processing FROM images WHERE id = ?")
      .get(job.imageId) as { id: string; filename: string; skip_thumbnail_processing: number } | undefined;
    if (!image || image.skip_thumbnail_processing) {
      completeImageProcessingJob(job.id);
      continue;
    }
    runRecoverableImageJob(job, image);
  }
  return getImageProcessingRecovery();
}

export function discardImageProcessingQueue(): ImageProcessingQueueRecovery {
  discardRecoverableImageProcessingJobs(liveImageProcessingJobIds);
  return getImageProcessingRecovery();
}

export function getImageProcessingQueueSnapshot(): {
  queue: DeferredImageProcessingStatus;
  recovery: ImageProcessingQueueRecovery;
} {
  return {
    queue: getDeferredImageProcessingStatus(),
    recovery: getImageProcessingRecovery(),
  };
}

export const IMAGE_GEN_FILENAME_PREFIX = "image-gen-";

export interface PublicImageFile {
  filepath: string;
  contentType: string;
}

/**
 * Resolve an unauthenticated image-generation result only when the row carries
 * server-owned provenance and the stored file still passes the media-byte
 * allowlist. The filename prefix remains a compatibility guard, never the
 * authority.
 */
export async function getPublicImageFile(id: string, tier?: ThumbTier): Promise<PublicImageFile | null> {
  const row = getDb().query("SELECT * FROM images WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  if (row.public_provenance !== SERVER_IMAGE_GENERATION_PROVENANCE) return null;
  if (typeof row.original_filename !== "string" || !row.original_filename.startsWith(IMAGE_GEN_FILENAME_PREFIX)) return null;
  if (typeof row.filename !== "string" || basename(row.filename) !== row.filename) return null;

  const dir = getImagesDir();
  const filename = row.filename;
  const originalPath = join(dir, filename);
  const expectedMimeType = typeof row.mime_type === "string" ? row.mime_type : null;
  if (classifyUserMediaContentType(expectedMimeType) === "active") return null;

  const validateOriginal = (): PublicImageFile | null => {
    if (!existsSync(originalPath)) return null;
    try {
      const validated = validateSafeMediaFile(originalPath, {
        filename,
        bucket: "images",
        mediaPolicy: expectedMimeType?.startsWith("video/") ? "image_or_video" : "image",
        expectedMimeType,
      });
      return { filepath: originalPath, contentType: validated.contentType };
    } catch {
      return null;
    }
  };

  const original = validateOriginal();
  if (!tier) return original;
  if (!original) return null;
  if (row.skip_thumbnail_processing) return original;

  const encoding = getThumbnailEncodingSettings();
  const suffix = thumbSuffix(tier, encoding.codec);
  const thumbPath = join(dir, `${id}${suffix}`);
  const thumbnailMimeType = encoding.codec === "avif" ? "image/avif" : "image/webp";
  const validateThumbnail = (): PublicImageFile | null => {
    if (!existsSync(thumbPath)) return null;
    try {
      const validated = validateSafeMediaFile(thumbPath, {
        filename: `${id}${suffix}`,
        bucket: "thumbnails",
        mediaPolicy: "image",
        expectedMimeType: thumbnailMimeType,
      });
      return { filepath: thumbPath, contentType: validated.contentType };
    } catch {
      return null;
    }
  };
  const existingThumbnail = validateThumbnail();
  if (existingThumbnail) return existingThumbnail;

  const userId = typeof row.user_id === "string" ? row.user_id : "";
  const sizes = getThumbnailSettings(userId);
  const size = tier === "sm" ? sizes.smallSize : sizes.largeSize;
  const ok = await ensureThumbnail(`${id}:${tier}:public`, original.filepath, thumbPath, size, encoding);
  if (!ok) return original;
  return validateThumbnail() ?? original;
}

export async function getImageFilePathPublic(id: string, tier?: ThumbTier): Promise<string | null> {
  return (await getPublicImageFile(id, tier))?.filepath ?? null;
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
    const originalPath = join(dir, image.filename);
    if (image.skip_thumbnail_processing) {
      return existsSync(originalPath) ? originalPath : null;
    }
    const encoding = getThumbnailEncodingSettings();
    const tieredPath = join(dir, `${image.id}${thumbSuffix(tier, encoding.codec)}`);
    if (existsSync(tieredPath)) return tieredPath;

    if (existsSync(originalPath)) {
      const sizes = getThumbnailSettings(userId);
      const size = tier === "sm" ? sizes.smallSize : sizes.largeSize;

      // Older video uploads may predate poster thumbnail extraction. Generate a
      // still from the source video on demand so UI thumbnail requests resolve
      // to an image instead of falling back to the original MP4.
      const thumbnailSource = image.mime_type.startsWith("video/")
        ? await (async () => {
            try {
              const source = Buffer.from(await Bun.file(originalPath).arrayBuffer());
              return await extractVideoPosterBuffer(source, image.mime_type, image.original_filename);
            } catch {
              return null;
            }
          })()
        : originalPath;

      const ok = thumbnailSource
        ? await ensureThumbnail(`${image.id}:${tier}:${userId}`, thumbnailSource, tieredPath, size, encoding)
        : false;
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

export async function rebuildAllThumbnails(
  userId: string,
  options?: { onProgress?: (p: ThumbnailRebuildProgress) => void },
): Promise<ThumbnailRebuildProgress> {
  const rows = getDb()
    .query("SELECT id, filename, skip_thumbnail_processing FROM images WHERE user_id = ?")
    .all(userId) as Array<{ id: string; filename: string; skip_thumbnail_processing: number }>;
  const eligibleRows = rows.filter((row) => !row.skip_thumbnail_processing);
  const eligibleIds = new Set(eligibleRows.map((row) => row.id));
  const dir = getImagesDir();

  for (const name of readdirSync(dir)) {
    if (!isThumbnailFilename(name)) continue;
    const imageId = name.split("_thumb_")[0];
    if (!imageId || !eligibleIds.has(imageId)) continue;
    const path = join(dir, name);
    try {
      if (lstatSync(path).isFile()) unlinkSync(path);
    } catch {
      // Keep going so one stuck file does not abort the wipe.
    }
  }

  getDb()
    .query("UPDATE images SET has_thumbnail = 0 WHERE user_id = ? AND skip_thumbnail_processing = 0")
    .run(userId);

  const skipped = rows.length - eligibleRows.length;

  const progress: ThumbnailRebuildProgress = {
    total: rows.length,
    current: skipped,
    generated: 0,
    skipped,
    failed: 0,
  };

  options?.onProgress?.({ ...progress });
  if (rows.length === 0) return progress;

  for (const img of eligibleRows) {
    scheduleRebuildThumbnailJob(userId, img.id, img.filename, progress, options?.onProgress);
  }
  await waitForDeferredImageProcessing();
  options?.onProgress?.({ ...progress });
  return progress;
}

function imageFilePaths(dir: string, id: string, filename: string): string[] {
  const paths = [join(dir, filename)];
  for (const codec of ["h264", "hevc"] as const) paths.push(videoVariantPath(dir, id, codec));
  for (const tier of ["sm", "lg"] as const) {
    for (const suffix of thumbnailSuffixes(tier)) {
      paths.push(join(dir, `${id}${suffix}`));
    }
  }
  return paths;
}

const TRANSIENT_UNLINK_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const UNLINK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;

/**
 * `unlink` errors are not fully portable: in particular, Bun has reported
 * EPERM for an already-missing path on some Windows versions. Re-check the
 * path instead of deciding solely from the original errno. lstat is used so a
 * broken symlink is still considered an entry that should be removed.
 */
function imagePathIsGone(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (err: any) {
    return err?.code === "ENOENT" || err?.code === "ENOTDIR";
  }
}

function imagePathIsDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function unlinkFailure(path: string, err: any): string {
  return `${path}: ${err?.message ?? err}`;
}

export async function unlinkPaths(paths: readonly string[]): Promise<void> {
  const failures: string[] = [];
  let pending = [...new Set(paths)].filter((path) => !imagePathIsGone(path));

  for (let attempt = 0; pending.length > 0; attempt++) {
    const retry: string[] = [];
    for (const p of pending) {
      try {
        await unlink(p);
      } catch (err: any) {
        if (err?.code === "ENOENT" || imagePathIsGone(p)) continue;
        if (
          TRANSIENT_UNLINK_CODES.has(err?.code)
          && !imagePathIsDirectory(p)
          && attempt < UNLINK_RETRY_DELAYS_MS.length
        ) {
          retry.push(p);
        } else {
          failures.push(unlinkFailure(p, err));
        }
      }
    }
    if (retry.length === 0) break;
    await Bun.sleep(UNLINK_RETRY_DELAYS_MS[attempt]);
    pending = retry;
  }

  if (failures.length > 0) {
    throw new Error(`Could not delete ${failures.length} image file(s): ${failures.join("; ")}`);
  }
}

function unlinkPathsSync(paths: readonly string[]): void {
  const failures: string[] = [];
  let pending = [...new Set(paths)].filter((path) => !imagePathIsGone(path));

  for (let attempt = 0; pending.length > 0; attempt++) {
    const retry: string[] = [];
    for (const p of pending) {
      try {
        unlinkSync(p);
      } catch (err: any) {
        if (err?.code === "ENOENT" || imagePathIsGone(p)) continue;
        if (
          TRANSIENT_UNLINK_CODES.has(err?.code)
          && !imagePathIsDirectory(p)
          && attempt < UNLINK_RETRY_DELAYS_MS.length
        ) {
          retry.push(p);
        } else {
          failures.push(unlinkFailure(p, err));
        }
      }
    }
    if (retry.length === 0) break;
    Bun.sleepSync(UNLINK_RETRY_DELAYS_MS[attempt]);
    pending = retry;
  }

  if (failures.length > 0) {
    throw new Error(`Could not delete ${failures.length} image file(s): ${failures.join("; ")}`);
  }
}

function deleteImageUnsafe(userId: string, id: string): boolean {
  const row = getDb()
    .query("SELECT id, filename FROM images WHERE user_id = ? AND id = ?")
    .get(userId, id) as { id: string; filename: string } | undefined;
  if (!row) return false;
  unlinkPathsSync(imageFilePaths(getImagesDir(), row.id, row.filename));
  const result = getDb().query("DELETE FROM images WHERE id = ? AND user_id = ?").run(id, userId);
  if (result.changes > 0) {
    eventBus.emit(EventType.IMAGE_DELETED, { id }, userId);
  }
  return result.changes > 0;
}

export function deleteImage(userId: string, id: string): boolean {
  return withUserDataMutationSync(userId, () => deleteImageUnsafe(userId, id));
}

export function imageDeletePlan(
  userId: string,
  ids: Iterable<string>,
): { rowIds: string[]; paths: string[] } {
  const idList = [...new Set(ids)].filter((id) => typeof id === "string" && id.length > 0);
  const dir = getImagesDir();
  const rowIds: string[] = [];
  const paths: string[] = [];
  for (let i = 0; i < idList.length; i += IN_CHUNK) {
    const chunk = idList.slice(i, i + IN_CHUNK);
    const marks = chunk.map(() => "?").join(",");
    const rows = getDb()
      .query(`SELECT id, filename FROM images WHERE user_id = ? AND id IN (${marks})`)
      .all(userId, ...chunk) as Array<{ id: string; filename: string }>;
    for (const row of rows) {
      rowIds.push(row.id);
      paths.push(...imageFilePaths(dir, row.id, row.filename));
    }
  }
  return { rowIds, paths };
}

export function deleteImageRowsOnly(userId: string, rowIds: readonly string[]): number {
  let deleted = 0;
  for (let i = 0; i < rowIds.length; i += IN_CHUNK) {
    const chunk = rowIds.slice(i, i + IN_CHUNK);
    const marks = chunk.map(() => "?").join(",");
    deleted += getDb()
      .query(`DELETE FROM images WHERE user_id = ? AND id IN (${marks})`)
      .run(userId, ...chunk).changes;
  }
  return deleted;
}

export async function deleteImagesBulk(
  userId: string,
  ids: Iterable<string>,
  options?: { emitEvents?: boolean },
): Promise<number> {
  const plan = imageDeletePlan(userId, ids);
  if (plan.rowIds.length === 0) return 0;
  return withUserDataMutation(userId, async () => {
    await unlinkPaths(plan.paths);
    const deleted = getDb().transaction(() => deleteImageRowsOnly(userId, plan.rowIds))();
    if (options?.emitEvents) {
      for (const rowId of plan.rowIds) eventBus.emit(EventType.IMAGE_DELETED, { id: rowId }, userId);
    }
    return deleted;
  });
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
      `SELECT 1 AS found
         FROM character_gallery cg
         JOIN characters c ON c.id = cg.character_id
        WHERE cg.user_id = ? AND cg.image_id = ? AND c.deleting = 0
        LIMIT 1`,
      [userId, id],
    ) ||
    hasImageReference(
      `SELECT 1 AS found FROM characters
       WHERE user_id = ? AND deleting = 0 AND (
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
      "SELECT 1 AS found FROM presets WHERE user_id = ? AND metadata LIKE ? LIMIT 1",
      [userId, needle],
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

const BULK_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const IN_CHUNK = 400;
const MESSAGES_PAGE = 2000;
const BULK_SCAN_MIN_CANDIDATES = 8;

function bulkRows(sql: string, params: any[]): any[] {
  try {
    return getDb().query(sql).all(...params) as any[];
  } catch (err: any) {
    if (/no such (table|column)/i.test(String(err?.message ?? err))) return [];
    throw err;
  }
}


export function findReferencedImageIds(userId: string, candidates: ReadonlySet<string>): Set<string> {
  if (candidates.size < BULK_SCAN_MIN_CANDIDATES) {
    const referenced = new Set<string>();
    for (const id of candidates) {
      if (isImageReferenced(userId, id)) referenced.add(id);
    }
    return referenced;
  }
  const byLower = new Map<string, string>();
  for (const id of candidates) byLower.set(id.toLowerCase(), id);
  const referenced = new Set<string>();
  const done = () => referenced.size >= candidates.size;

  const scanText = (text: unknown): void => {
    if (typeof text !== "string" || text.length === 0) return;
    BULK_UUID_RE.lastIndex = 0;
    for (const m of text.matchAll(BULK_UUID_RE)) {
      const orig = byLower.get(m[0].toLowerCase());
      if (orig !== undefined) referenced.add(orig);
    }
  };
  const markHit = (hit: unknown): void => {
    if (typeof hit !== "string") return;
    const orig = byLower.get(hit.toLowerCase());
    if (orig !== undefined) referenced.add(orig);
  };

  try {
    const ids = [...byLower.keys()];
    const exactColumnQueries: ReadonlyArray<{ sql: (marks: string) => string; head: any[] }> = [
      {
        sql: (m) => `SELECT id AS hit FROM images WHERE user_id = ? AND owner_extension_identifier = ? AND id IN (${m})`,
        head: [userId, WALLPAPER_LIBRARY_OWNER],
      },
      {
        sql: (m) => `SELECT cg.image_id AS hit
                       FROM character_gallery cg
                       JOIN characters c ON c.id = cg.character_id
                      WHERE cg.user_id = ? AND c.deleting = 0 AND cg.image_id IN (${m})`,
        head: [userId],
      },
      { sql: (m) => `SELECT image_id AS hit FROM characters WHERE user_id = ? AND deleting = 0 AND image_id IN (${m})`, head: [userId] },
      { sql: (m) => `SELECT image_id AS hit FROM personas WHERE user_id = ? AND image_id IN (${m})`, head: [userId] },
      { sql: (m) => `SELECT image_id AS hit FROM theme_assets WHERE user_id = ? AND image_id IN (${m})`, head: [userId] },
    ];
    for (let i = 0; i < ids.length && !done(); i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      const marks = chunk.map(() => "?").join(",");
      for (const q of exactColumnQueries) {
        for (const row of bulkRows(q.sql(marks), [...q.head, ...chunk])) markHit(row.hit);
      }
    }

    if (!done()) {
      for (const row of bulkRows("SELECT value FROM settings WHERE user_id = ?", [userId])) scanText(row.value);
    }
    if (!done()) {
      for (const row of bulkRows("SELECT metadata FROM chats WHERE user_id = ?", [userId])) scanText(row.metadata);
    }
    if (!done()) {
      for (const row of bulkRows("SELECT metadata FROM personas WHERE user_id = ?", [userId])) scanText(row.metadata);
    }
    if (!done()) {
      for (const row of bulkRows("SELECT metadata FROM presets WHERE user_id = ?", [userId])) scanText(row.metadata);
    }
    if (!done()) {
      const rows = bulkRows(
        `SELECT extensions, description, personality, scenario, first_mes, mes_example,
                creator_notes, system_prompt, post_history_instructions, alternate_greetings
         FROM characters WHERE user_id = ? AND deleting = 0`,
        [userId],
      );
      for (const row of rows) {
        for (const v of Object.values(row)) scanText(v);
        if (done()) break;
      }
    }

    if (!done()) {
      let lastRowId = -1;
      while (!done()) {
        const rows = bulkRows(
          `SELECT m.rowid AS rid, m.extra, m.swipes, m.content
           FROM messages m JOIN chats c ON c.id = m.chat_id
           WHERE c.user_id = ? AND m.rowid > ?
           ORDER BY m.rowid LIMIT ${MESSAGES_PAGE}`,
          [userId, lastRowId],
        );
        if (rows.length === 0) break;
        for (const row of rows) {
          scanText(row.extra);
          scanText(row.swipes);
          scanText(row.content);
        }
        lastRowId = rows[rows.length - 1].rid;
        if (rows.length < MESSAGES_PAGE) break;
      }
    }
  } catch (err) {
    console.error(`[images] findReferencedImageIds failed, failing closed (no deletions): ${err instanceof Error ? err.message : String(err)}`);
    return new Set(candidates);
  }
  return referenced;
}
