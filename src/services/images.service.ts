import sharp from "sharp";
import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { env } from "../env";
import type { Image } from "../types/image";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { join, extname } from "path";

const IMAGES_DIR = "images";
const THUMB_SIZE = 200;

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

    const thumbPath = join(dir, `${id}_thumb.webp`);
    await sharp(buffer)
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: "cover" })
      .webp({ quality: 80 })
      .toFile(thumbPath);
    hasThumbnail = true;
  } catch {
    // Non-image file or sharp failure — skip thumbnail
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

export function getImage(userId: string, id: string): Image | null {
  const row = getDb().query("SELECT * FROM images WHERE id = ? AND user_id = ?").get(id, userId) as any;
  return row ? rowToImage(row) : null;
}

export function getImageFilePath(userId: string, id: string, thumbnail: boolean = false): string | null {
  const image = getImage(userId, id);
  if (!image) return null;

  const dir = getImagesDir();

  if (thumbnail && image.has_thumbnail) {
    const thumbPath = join(dir, `${image.id}_thumb.webp`);
    if (existsSync(thumbPath)) return thumbPath;
  }

  const filepath = join(dir, image.filename);
  if (!existsSync(filepath)) return null;
  return filepath;
}

export function deleteImage(userId: string, id: string): boolean {
  const image = getImage(userId, id);
  if (!image) return false;

  const dir = getImagesDir();

  // Remove original file
  const filepath = join(dir, image.filename);
  if (existsSync(filepath)) unlinkSync(filepath);

  // Remove thumbnail
  const thumbPath = join(dir, `${image.id}_thumb.webp`);
  if (existsSync(thumbPath)) unlinkSync(thumbPath);

  const result = getDb().query("DELETE FROM images WHERE id = ? AND user_id = ?").run(id, userId);
  if (result.changes > 0) {
    eventBus.emit(EventType.IMAGE_DELETED, { id }, userId);
  }
  return result.changes > 0;
}
