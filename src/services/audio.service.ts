import { getDb } from "../db/connection";
import { env } from "../env";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { withUserDataMutation, withUserDataMutationSync } from "./user-data/snapshot";
import { join } from "path";
import { detectAudioFormat } from "./notification-sounds.service";
import { MAX_AUDIO_BYTES } from "../types/media-limits";
export { MAX_AUDIO_BYTES } from "../types/media-limits";
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
async function saveAudioUnsafe(userId: string, input: SaveAudioInput): Promise<AudioFile> {
  const buffer = input.data instanceof Buffer ? input.data : Buffer.from(input.data);
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(`Audio payload must be between 1 and ${MAX_AUDIO_BYTES} bytes`);
  }
  const detected = detectAudioFormat(buffer);
  if (!detected) throw new Error("Unsupported or invalid audio payload");
  const id = crypto.randomUUID();
  const filename = `${id}${detected.extension}`;
  const filepath = join(getAudioDir(), filename);
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
      detected.mimeType,
      buffer.byteLength,
      input.duration_ms ?? null,
      now,
    );

  return getAudio(userId, id)!;
}

export async function saveAudio(userId: string, input: SaveAudioInput): Promise<AudioFile> {
  return withUserDataMutation(userId, () => saveAudioUnsafe(userId, input));
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

function deleteAudioUnsafe(userId: string, id: string): boolean {
  const row = getAudio(userId, id);
  if (!row) return false;
  const filepath = join(getAudioDir(), row.filename);
  if (existsSync(filepath)) {
    try {
      unlinkSync(filepath);
    } catch {
      // Tolerate races where the file was removed concurrently.
    }
  }
  const result = getDb().query("DELETE FROM audio_files WHERE id = ? AND user_id = ?").run(id, userId);
  return result.changes > 0;
}

export function deleteAudio(userId: string, id: string): boolean {
  return withUserDataMutationSync(userId, () => deleteAudioUnsafe(userId, id));
}
