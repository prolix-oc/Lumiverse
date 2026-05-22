import { existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join, resolve, sep } from "path";
import { env } from "../env";

const NOTIFICATION_SOUNDS_DIR = "notification-sounds";
const COMPLETION_BASENAME = "completion";

export const MAX_NOTIFICATION_SOUND_BYTES = 2 * 1024 * 1024;

export interface NotificationSoundMetadata {
  /** Original filename supplied by the upload (sanitized). */
  filename: string;
  mimeType: string;
  extension: string;
  byteSize: number;
  /** Unix seconds; doubles as a cache-buster for the frontend audio element. */
  uploadedAt: number;
}

export interface StoredNotificationSound extends NotificationSoundMetadata {
  filepath: string;
}

interface DetectedAudio {
  mimeType: string;
  extension: string;
}

/**
 * Header-byte audio sniffer for the small set of web-playable formats we
 * accept. Rejects anything whose magic bytes don't match — guards against
 * disguised executables, HTML smuggling, or oversize binaries pretending
 * to be audio. `file.type` from the browser is advisory only.
 */
export function detectAudioFormat(buf: Uint8Array): DetectedAudio | null {
  if (buf.length < 12) return null;

  // ID3v2-tagged MP3 (most common in the wild). The tag prefixes raw MPEG
  // frames; web Audio decoders skip it transparently.
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return { mimeType: "audio/mpeg", extension: ".mp3" };
  }

  // Raw MPEG audio frame sync: 11 set bits (0xFF 0xEx/0xFx). MPEG version
  // bits must not be 01 (reserved). Layer bits must not be 00 (reserved).
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    const versionBits = (buf[1] >> 3) & 0x03;
    const layerBits = (buf[1] >> 1) & 0x03;
    if (versionBits !== 0x01 && layerBits !== 0x00) {
      // ADTS AAC also lives in this sync space; differentiate via layer bits
      // (always 00 for ADTS, which we excluded above) so anything matching
      // here is MPEG Layer 1/2/3 audio. Tag as MP3 — that's what browsers
      // accept under audio/mpeg.
      return { mimeType: "audio/mpeg", extension: ".mp3" };
    }
    // ADTS AAC sync: 0xFFF1 (MPEG-4) or 0xFFF9 (MPEG-2). Layer bits are 00.
    if (layerBits === 0x00 && (buf[1] === 0xf1 || buf[1] === 0xf9)) {
      return { mimeType: "audio/aac", extension: ".aac" };
    }
  }

  // RIFF....WAVE
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45
  ) {
    return { mimeType: "audio/wav", extension: ".wav" };
  }

  // OggS
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
    return { mimeType: "audio/ogg", extension: ".ogg" };
  }

  // ISO BMFF / MP4 family: bytes 4..7 are 'ftyp', then a 4-byte brand.
  // M4A audio uses brands like 'M4A ', 'M4B ', 'mp42', 'isom', 'dash'.
  // We accept the brands that browsers reliably play as audio.
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
    const audioBrands = new Set(["M4A ", "M4B ", "mp42", "mp41", "isom", "dash"]);
    if (audioBrands.has(brand)) {
      return { mimeType: "audio/mp4", extension: ".m4a" };
    }
  }

  return null;
}

function getRootDir(): string {
  const dir = join(env.dataDir, NOTIFICATION_SOUNDS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getUserDir(userId: string): string {
  // userId comes from a session-validated context (UUID), but resolve+sep
  // guard ensures we never escape the root regardless.
  const root = resolve(getRootDir());
  const dir = resolve(root, userId);
  if (!(dir === root || dir.startsWith(root + sep))) {
    throw new Error("Invalid user id");
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function findExistingCompletionFile(userDir: string): string | null {
  if (!existsSync(userDir)) return null;
  for (const entry of readdirSync(userDir)) {
    if (entry.startsWith(`${COMPLETION_BASENAME}.`)) return join(userDir, entry);
  }
  return null;
}

function sanitizeFilename(name: string): string {
  const trimmed = (name || "").trim().slice(0, 120);
  const cleaned = trimmed.replace(/[^A-Za-z0-9._ -]+/g, "_");
  return cleaned || "notification-sound";
}

export async function setCompletionSound(
  userId: string,
  file: File,
): Promise<NotificationSoundMetadata> {
  if (!file) throw new Error("Audio file is required");
  if (file.size > MAX_NOTIFICATION_SOUND_BYTES) {
    throw new Error(
      `Audio file too large (max ${MAX_NOTIFICATION_SOUND_BYTES / (1024 * 1024)}MB)`,
    );
  }
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const detected = detectAudioFormat(bytes);
  if (!detected) {
    throw new Error(
      "Unsupported or invalid audio file. Allowed formats: MP3, WAV, OGG, AAC, M4A.",
    );
  }

  const userDir = getUserDir(userId);

  // Drop any previously stored file before writing the new one so we don't
  // accumulate stale extensions if the format changes between uploads.
  const previous = findExistingCompletionFile(userDir);
  if (previous && existsSync(previous)) unlinkSync(previous);

  const filepath = join(userDir, `${COMPLETION_BASENAME}${detected.extension}`);
  await Bun.write(filepath, bytes);

  return {
    filename: sanitizeFilename(file.name),
    mimeType: detected.mimeType,
    extension: detected.extension,
    byteSize: bytes.byteLength,
    uploadedAt: Math.floor(Date.now() / 1000),
  };
}

export function getCompletionSound(userId: string): StoredNotificationSound | null {
  const root = resolve(getRootDir());
  const userDir = resolve(root, userId);
  if (!(userDir === root || userDir.startsWith(root + sep))) return null;
  if (!existsSync(userDir)) return null;
  const filepath = findExistingCompletionFile(userDir);
  if (!filepath) return null;
  const file = Bun.file(filepath);
  const ext = filepath.slice(filepath.lastIndexOf("."));
  const mimeByExt: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".aac": "audio/aac",
    ".m4a": "audio/mp4",
  };
  return {
    filepath,
    filename: `completion${ext}`,
    mimeType: mimeByExt[ext] || "application/octet-stream",
    extension: ext,
    byteSize: file.size,
    uploadedAt: 0,
  };
}

export function deleteCompletionSound(userId: string): boolean {
  const root = resolve(getRootDir());
  const userDir = resolve(root, userId);
  if (!(userDir === root || userDir.startsWith(root + sep))) return false;
  if (!existsSync(userDir)) return false;
  const filepath = findExistingCompletionFile(userDir);
  if (!filepath) return false;
  unlinkSync(filepath);
  return true;
}
