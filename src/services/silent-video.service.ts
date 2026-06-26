import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { extname, join } from "path";
import { isFfmpegBinaryAvailable, resetFfmpegBinaryResolution, resolveFfmpegBinary } from "./ffmpeg-binary.service";

const SUPPORTED_VIDEO_MIME_TO_EXT: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-m4v": ".m4v",
};
const KNOWN_VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
  ".mkv",
  ".avi",
  ".ogv",
  ".ogg",
  ".mpeg",
  ".mpg",
  ".ts",
  ".mts",
  ".m2ts",
  ".wmv",
]);

export async function isFfmpegAvailableForSilentVideo(): Promise<boolean> {
  return isFfmpegBinaryAvailable();
}

export function resetSilentVideoFfmpegProbe(): void {
  resetFfmpegBinaryResolution();
}

function outputExtensionForMime(mimeType: string): string | null {
  return SUPPORTED_VIDEO_MIME_TO_EXT[(mimeType || "").toLowerCase()] ?? null;
}

function sanitizeVideoExtension(originalFilename?: string): string | null {
  const ext = extname(originalFilename || "").trim().toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : null;
}

export function resolveVideoInputExtension(mimeType: string, originalFilename?: string): string | null {
  const explicit = sanitizeVideoExtension(originalFilename);
  const normalizedMime = (mimeType || "").toLowerCase().trim();
  const byMime = outputExtensionForMime(normalizedMime);

  if (normalizedMime.startsWith("video/")) {
    if (explicit && KNOWN_VIDEO_EXTENSIONS.has(explicit)) return explicit;
    return byMime || ".mp4";
  }
  if (byMime) return byMime;
  if (explicit && KNOWN_VIDEO_EXTENSIONS.has(explicit)) return explicit;
  return null;
}

export function isLikelyVideoUpload(mimeType: string, originalFilename?: string): boolean {
  const normalizedMime = (mimeType || "").toLowerCase().trim();
  if (normalizedMime.startsWith("video/")) return true;
  if (normalizedMime.startsWith("image/") || normalizedMime === "application/pdf") return false;
  return resolveVideoInputExtension("", originalFilename) !== null;
}

export type NormalizedVideoCodec = "h264" | "hevc";

interface NormalizeVideoBufferOptions {
  codec: NormalizedVideoCodec;
  stripAudio?: boolean;
}

async function runFfmpeg(args: string[]): Promise<boolean> {
  const ffmpeg = await resolveFfmpegBinary();
  if (!ffmpeg) return false;

  const proc = Bun.spawn([ffmpeg, "-hide_banner", "-loglevel", "error", ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

export async function extractVideoPosterBuffer(
  input: Buffer,
  mimeType: string,
  originalFilename?: string,
): Promise<Buffer | null> {
  const ext = resolveVideoInputExtension(mimeType, originalFilename);
  if (!ext) return null;

  const hasFfmpeg = await isFfmpegAvailableForSilentVideo();
  if (!hasFfmpeg) return null;

  const workdir = mkdtempSync(join(tmpdir(), "lumiverse-video-poster-"));
  try {
    const inputPath = join(workdir, `input${ext}`);
    const outputPath = join(workdir, "poster.png");
    await Bun.write(inputPath, input);

    const ok = await runFfmpeg([
      "-i", inputPath,
      "-vf", "thumbnail",
      "-frames:v", "1",
      "-y",
      outputPath,
    ]);
    if (!ok || !existsSync(outputPath)) return null;

    const data = await Bun.file(outputPath).bytes();
    return data.length > 0 ? Buffer.from(data) : null;
  } catch {
    return null;
  } finally {
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure */
    }
  }
}

export async function stripAudioFromVideoBuffer(
  input: Buffer,
  mimeType: string,
  originalFilename?: string,
): Promise<Buffer | null> {
  const ext = resolveVideoInputExtension(mimeType, originalFilename);
  if (!ext) return null;

  const hasFfmpeg = await isFfmpegAvailableForSilentVideo();
  if (!hasFfmpeg) return null;

  const workdir = mkdtempSync(join(tmpdir(), "lumiverse-silent-video-"));
  try {
    const inputPath = join(workdir, `input${ext}`);
    const outputPath = join(workdir, `output${ext}`);
    await Bun.write(inputPath, input);

    // Copy the video stream as-is and drop audio tracks. If ffmpeg cannot
    // remux the file cleanly, the caller falls back to the original upload.
    const ok = await runFfmpeg([
      "-i", inputPath,
      "-map", "0:v",
      "-c", "copy",
      "-an",
      "-y",
      outputPath,
    ]);
    if (!ok || !existsSync(outputPath)) return null;

    const data = await Bun.file(outputPath).bytes();
    return data.length > 0 ? Buffer.from(data) : null;
  } catch {
    return null;
  } finally {
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure */
    }
  }
}

export async function normalizeVideoBuffer(
  input: Buffer,
  mimeType: string,
  originalFilename: string | undefined,
  options: NormalizeVideoBufferOptions,
): Promise<{ buffer: Buffer; ext: ".mp4"; mimeType: "video/mp4" } | null> {
  const ext = resolveVideoInputExtension(mimeType, originalFilename);
  if (!ext || !isLikelyVideoUpload(mimeType, originalFilename)) return null;

  const hasFfmpeg = await isFfmpegAvailableForSilentVideo();
  if (!hasFfmpeg) return null;

  const workdir = mkdtempSync(join(tmpdir(), "lumiverse-normalized-video-"));
  try {
    const inputPath = join(workdir, `input${ext}`);
    const outputPath = join(workdir, "output.mp4");
    await Bun.write(inputPath, input);

    const codecArgs =
      options.codec === "hevc"
        ? ["-c:v", "libx265", "-preset", "medium", "-crf", "28", "-tag:v", "hvc1", "-pix_fmt", "yuv420p"]
        : ["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p"];

    const ffmpegArgs = [
      "-i", inputPath,
      "-map", "0:v:0",
      ...(options.stripAudio === false ? ["-map", "0:a?"] : ["-an"]),
      ...codecArgs,
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ];

    const ok = await runFfmpeg(ffmpegArgs);
    if (!ok || !existsSync(outputPath)) return null;

    const data = await Bun.file(outputPath).bytes();
    if (data.length === 0) return null;

    return {
      buffer: Buffer.from(data),
      ext: ".mp4",
      mimeType: "video/mp4",
    };
  } catch {
    return null;
  } finally {
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure */
    }
  }
}
