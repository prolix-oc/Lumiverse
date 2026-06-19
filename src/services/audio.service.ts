import { getDb } from "../db/connection";
import { env } from "../env";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { join, extname } from "path";

const AUDIO_DIR = "audio";

export interface AudioFile {
  id: string;
  user_id: string;
  filename: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  created_at: number;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function getAudioDir(): string {
  const dir = join(env.dataDir, AUDIO_DIR);
  ensureDir(dir);
  return dir;
}

function extForMime(mime: string): string {
  switch ((mime || "").toLowerCase()) {
    case "audio/mpeg":
    case "audio/mp3":
      return ".mp3";
    case "audio/ogg":
    case "audio/ogg; codecs=opus":
    case "audio/opus":
      return ".ogg";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/webm":
      return ".webm";
    case "audio/aac":
      return ".aac";
    case "audio/flac":
      return ".flac";
    default:
      return ".bin";
  }
}

export interface SaveAudioInput {
  data: Uint8Array | Buffer;
  mime_type: string;
  original_filename?: string;
  duration_ms?: number | null;
}

/**
 * Persist an audio buffer to disk and create a DB row. Returns the new record.
 * Mirrors images.service.uploadImage but skips all image-specific processing
 * (sharp metadata, thumbnail tiers).
 */
export async function saveAudio(userId: string, input: SaveAudioInput): Promise<AudioFile> {
  const id = crypto.randomUUID();
  const ext = extForMime(input.mime_type) || extname(input.original_filename || "") || ".bin";
  const filename = `${id}${ext}`;
  const filepath = join(getAudioDir(), filename);

  const buffer = input.data instanceof Buffer ? input.data : Buffer.from(input.data);
  await Bun.write(filepath, buffer);

  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query(
      `INSERT INTO audio_files (
         id, user_id, filename, original_filename, mime_type,
         size_bytes, duration_ms, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      filename,
      input.original_filename || filename,
      input.mime_type || "",
      buffer.byteLength,
      input.duration_ms ?? null,
      now,
    );

  return getAudio(userId, id)!;
}

export function getAudio(userId: string, id: string): AudioFile | null {
  const row = getDb()
    .query("SELECT * FROM audio_files WHERE id = ? AND user_id = ?")
    .get(id, userId) as AudioFile | null;
  return row || null;
}

export function getAudioFilePath(userId: string, id: string): string | null {
  const row = getAudio(userId, id);
  if (!row) return null;
  const filepath = join(getAudioDir(), row.filename);
  return existsSync(filepath) ? filepath : null;
}

export function deleteAudio(userId: string, id: string): boolean {
  const row = getAudio(userId, id);
  if (!row) return false;
  const filepath = join(getAudioDir(), row.filename);
  if (existsSync(filepath)) {
    try { unlinkSync(filepath); } catch { /* tolerate races / missing files */ }
  }
  const result = getDb().query("DELETE FROM audio_files WHERE id = ? AND user_id = ?").run(id, userId);
  return result.changes > 0;
}
