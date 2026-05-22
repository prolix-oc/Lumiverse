import sharp from "../utils/sharp-config";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { extname, join, resolve, sep } from "path";
import { env } from "../env";
import { getDb } from "../db/connection";
import type { ThemeAsset } from "../types/theme-asset";
import * as imagesSvc from "./images.service";

type StorageType = ThemeAsset["storage_type"];

interface ThemeAssetRow {
  id: string;
  user_id: string;
  bundle_id: string;
  slug: string;
  storage_type: StorageType;
  image_id: string | null;
  file_name: string | null;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  tags_json: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

export interface CreateThemeAssetInput {
  bundleId: string;
  file: File;
  slug?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateThemeAssetInput {
  slug?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface StoredAssetContent {
  asset: ThemeAsset;
  filepath: string;
}

const THEME_ASSETS_DIR = "theme-assets";
const SVG_MIME = "image/svg+xml";
const SUPPORTED_ASSET_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  SVG_MIME,
  "font/woff",
  "font/woff2",
  "font/ttf",
  "font/otf",
  "application/font-woff",
  "application/x-font-woff",
  "application/x-font-ttf",
  "application/x-font-opentype",
  "application/vnd.ms-fontobject",
]);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": SVG_MIME,
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
};

function parseJsonObject(value: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return fallback;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {}
  return [];
}

function rowToThemeAsset(row: ThemeAssetRow): ThemeAsset {
  return {
    id: row.id,
    bundle_id: row.bundle_id,
    slug: row.slug,
    storage_type: row.storage_type,
    image_id: row.image_id,
    file_name: row.file_name,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    byte_size: row.byte_size,
    tags: parseJsonArray(row.tags_json),
    metadata: parseJsonObject(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getThemeAssetsDir(): string {
  const dir = join(env.dataDir, THEME_ASSETS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureUserBundleDir(userId: string, bundleId: string): string {
  const dir = join(getThemeAssetsDir(), userId, bundleId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeBundleId(bundleId: string): string {
  const trimmed = bundleId.trim();
  if (!trimmed) throw new Error("bundle_id is required");
  if (trimmed.length > 128) throw new Error("bundle_id is too long");
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) throw new Error("bundle_id contains invalid characters");
  return trimmed;
}

function slugifySegment(segment: string): string {
  const normalized = segment
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase();
  return normalized || "asset";
}

function normalizeSlug(rawSlug: string, originalFilename?: string): string {
  const fallbackExt = extname(originalFilename || "").toLowerCase();
  let slug = rawSlug.trim().replace(/\\/g, "/");
  if (!slug) {
    const ext = fallbackExt || ".bin";
    const stem = slugifySegment((originalFilename || "asset").replace(/\.[^.]+$/, ""));
    slug = `assets/${stem}${ext}`;
  }
  slug = slug.replace(/^\.\//, "");
  slug = slug.replace(/^\/+/, "");
  const parts = slug.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("slug is required");
  const normalizedParts = parts.map((part) => {
    if (part === "." || part === "..") throw new Error("slug contains invalid path traversal");
    const ext = extname(part);
    const stem = ext ? part.slice(0, -ext.length) : part;
    const normalizedStem = slugifySegment(stem);
    const normalizedExt = ext.toLowerCase();
    return `${normalizedStem}${normalizedExt}`;
  });
  if (normalizedParts[0] !== "assets") normalizedParts.unshift("assets");
  return normalizedParts.join("/");
}

function normalizeTags(tags?: string[]): string[] {
  return Array.from(
    new Set(
      (tags || [])
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 32)
    )
  );
}

function inferMimeType(file: File): string {
  const ext = extname(file.name).toLowerCase();
  const explicit = (file.type || "").toLowerCase();
  return explicit || MIME_BY_EXT[ext] || "application/octet-stream";
}

function resolveStorageType(mimeType: string): StorageType {
  if (!SUPPORTED_ASSET_MIMES.has(mimeType)) {
    throw new Error("Unsupported asset type. Allowed types: PNG, JPG, WEBP, GIF, AVIF, SVG, WOFF, WOFF2, TTF, OTF, EOT.");
  }
  return mimeType.startsWith("image/") && mimeType !== SVG_MIME ? "image" : "file";
}

function getThemeAssetRow(userId: string, id: string): ThemeAssetRow | null {
  return getDb()
    .query("SELECT * FROM theme_assets WHERE id = ? AND user_id = ?")
    .get(id, userId) as ThemeAssetRow | null;
}

function getThemeAssetRowBySlug(userId: string, bundleId: string, slug: string): ThemeAssetRow | null {
  return getDb()
    .query("SELECT * FROM theme_assets WHERE user_id = ? AND bundle_id = ? AND slug = ?")
    .get(userId, bundleId, slug) as ThemeAssetRow | null;
}

function nextAvailableSlug(userId: string, bundleId: string, desiredSlug: string): string {
  const ext = extname(desiredSlug);
  const base = ext ? desiredSlug.slice(0, -ext.length) : desiredSlug;
  let candidate = desiredSlug;
  let counter = 2;
  while (getThemeAssetRowBySlug(userId, bundleId, candidate)) {
    candidate = `${base}-${counter}${ext}`;
    counter += 1;
  }
  return candidate;
}

async function saveFileAsset(userId: string, bundleId: string, id: string, file: File): Promise<string> {
  const bundleDir = ensureUserBundleDir(userId, bundleId);
  const ext = extname(file.name).toLowerCase() || ".bin";
  const fileName = `${id}${ext}`;
  const filepath = join(bundleDir, fileName);
  await Bun.write(filepath, file);
  return fileName;
}

async function buildStoredAssetContent(userId: string, row: ThemeAssetRow): Promise<StoredAssetContent | null> {
  const asset = rowToThemeAsset(row);
  if (row.storage_type === "image") {
    if (!row.image_id) return null;
    const filepath = await imagesSvc.getImageFilePath(userId, row.image_id);
    if (!filepath) return null;
    return { asset, filepath };
  }
  if (!row.file_name) return null;
  const base = resolve(getThemeAssetsDir(), userId, row.bundle_id);
  const filepath = resolve(base, row.file_name);
  if (!filepath.startsWith(base + sep) && filepath !== base) return null;
  if (!(await Bun.file(filepath).exists())) return null;
  return { asset, filepath };
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /unique/i.test(err.message);
}

function replaceFileExtension(filename: string, nextExt: string): string {
  const base = filename.replace(/\.[^.]+$/, "") || "asset";
  return `${base}${nextExt}`;
}

export function listThemeAssets(userId: string, bundleId: string): ThemeAsset[] {
  const normalizedBundleId = normalizeBundleId(bundleId);
  const rows = getDb()
    .query("SELECT * FROM theme_assets WHERE user_id = ? AND bundle_id = ? ORDER BY created_at ASC, id ASC")
    .all(userId, normalizedBundleId) as ThemeAssetRow[];
  return rows.map(rowToThemeAsset);
}

export function getThemeAsset(userId: string, id: string): ThemeAsset | null {
  const row = getThemeAssetRow(userId, id);
  return row ? rowToThemeAsset(row) : null;
}

export async function createThemeAsset(userId: string, input: CreateThemeAssetInput): Promise<ThemeAsset> {
  const bundleId = normalizeBundleId(input.bundleId);
  const mimeType = inferMimeType(input.file);
  const storageType = resolveStorageType(mimeType);
  const desiredSlug = normalizeSlug(input.slug || input.file.name, input.file.name);
  const slug = nextAvailableSlug(userId, bundleId, desiredSlug);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const tags = normalizeTags(input.tags);
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};

  let imageId: string | null = null;
  let fileName: string | null = null;
  if (storageType === "image") {
    const image = await imagesSvc.uploadImage(userId, input.file);
    imageId = image.id;
  } else {
    fileName = await saveFileAsset(userId, bundleId, id, input.file);
  }

  try {
    getDb()
      .query(
        `INSERT INTO theme_assets
          (id, user_id, bundle_id, slug, storage_type, image_id, file_name, original_filename, mime_type, byte_size, tags_json, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        userId,
        bundleId,
        slug,
        storageType,
        imageId,
        fileName,
        input.file.name,
        mimeType,
        input.file.size || 0,
        JSON.stringify(tags),
        JSON.stringify(metadata),
        now,
        now
      );
  } catch (err) {
    if (imageId) imagesSvc.deleteImage(userId, imageId);
    if (fileName) {
      const bundleDir = resolve(getThemeAssetsDir(), userId, bundleId);
      const filepath = resolve(bundleDir, fileName);
      if ((filepath.startsWith(bundleDir + sep) || filepath === bundleDir) && existsSync(filepath)) {
        unlinkSync(filepath);
      }
    }
    if (isUniqueConstraintError(err)) {
      throw new Error("An asset with that slug already exists in this theme bundle.");
    }
    throw err;
  }

  return getThemeAsset(userId, id)!;
}

export function updateThemeAsset(userId: string, id: string, input: UpdateThemeAssetInput): ThemeAsset | null {
  const existing = getThemeAssetRow(userId, id);
  if (!existing) return null;

  const nextSlug = input.slug === undefined
    ? existing.slug
    : normalizeSlug(input.slug, existing.original_filename);
  const nextTags = input.tags === undefined ? parseJsonArray(existing.tags_json) : normalizeTags(input.tags);
  const nextMetadata = input.metadata === undefined
    ? parseJsonObject(existing.metadata_json, {})
    : (input.metadata && typeof input.metadata === "object" ? input.metadata : {});
  const now = Math.floor(Date.now() / 1000);

  try {
    getDb()
      .query("UPDATE theme_assets SET slug = ?, tags_json = ?, metadata_json = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(nextSlug, JSON.stringify(nextTags), JSON.stringify(nextMetadata), now, id, userId);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new Error("An asset with that slug already exists in this theme bundle.");
    }
    throw err;
  }

  return getThemeAsset(userId, id);
}

export function deleteThemeAsset(userId: string, id: string): boolean {
  const existing = getThemeAssetRow(userId, id);
  if (!existing) return false;

  if (existing.storage_type === "image" && existing.image_id) {
    return imagesSvc.deleteImage(userId, existing.image_id);
  }

  if (existing.file_name) {
    const base = resolve(getThemeAssetsDir(), userId, existing.bundle_id);
    const filepath = resolve(base, existing.file_name);
    if ((filepath.startsWith(base + sep) || filepath === base) && existsSync(filepath)) {
      unlinkSync(filepath);
    }
  }

  const result = getDb().query("DELETE FROM theme_assets WHERE id = ? AND user_id = ?").run(id, userId);
  return result.changes > 0;
}

export async function optimizeThemeAssetToWebp(userId: string, id: string): Promise<ThemeAsset | null> {
  const row = getThemeAssetRow(userId, id);
  if (!row) return null;
  if (row.storage_type !== "image" || !row.image_id) {
    throw new Error("Only raster image assets can be optimized to WebP.");
  }
  if (row.mime_type === SVG_MIME) {
    throw new Error("SVG assets cannot be converted to WebP.");
  }
  if (row.mime_type === "image/webp") {
    return rowToThemeAsset(row);
  }

  const originalPath = await imagesSvc.getImageFilePath(userId, row.image_id);
  if (!originalPath) {
    throw new Error("Image file for this theme asset no longer exists.");
  }

  const originalBuffer = Buffer.from(await Bun.file(originalPath).arrayBuffer());
  let optimizedBuffer: Buffer;
  try {
    optimizedBuffer = await sharp(originalBuffer).webp({ quality: 80 }).toBuffer();
  } catch {
    throw new Error("This image could not be converted to WebP.");
  }

  const optimizedFile = new File(
    [Uint8Array.from(optimizedBuffer)],
    replaceFileExtension(row.original_filename || "asset", ".webp"),
    { type: "image/webp" }
  );
  const nextImage = await imagesSvc.uploadImage(userId, optimizedFile);
  const now = Math.floor(Date.now() / 1000);

  try {
    getDb()
      .query(
        "UPDATE theme_assets SET image_id = ?, original_filename = ?, mime_type = ?, byte_size = ?, updated_at = ? WHERE id = ? AND user_id = ?"
      )
      .run(nextImage.id, optimizedFile.name, "image/webp", optimizedBuffer.byteLength, now, id, userId);
  } catch (err) {
    imagesSvc.deleteImage(userId, nextImage.id);
    throw err;
  }

  imagesSvc.deleteImage(userId, row.image_id);
  return getThemeAsset(userId, id);
}

export async function getThemeAssetContentById(userId: string, id: string): Promise<StoredAssetContent | null> {
  const row = getThemeAssetRow(userId, id);
  if (!row) return null;
  return buildStoredAssetContent(userId, row);
}

export async function getThemeAssetContentBySlug(userId: string, bundleId: string, slug: string): Promise<StoredAssetContent | null> {
  const normalizedBundleId = normalizeBundleId(bundleId);
  const normalizedSlug = normalizeSlug(slug);
  const row = getThemeAssetRowBySlug(userId, normalizedBundleId, normalizedSlug);
  if (!row) return null;
  return buildStoredAssetContent(userId, row);
}
