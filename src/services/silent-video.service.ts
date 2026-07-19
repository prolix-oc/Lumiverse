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

export interface VideoTranscodeProgress {
  currentTimeMs: number | null;
  durationMs: number | null;
  percent: number | null;
  speed: number | null;
  done: boolean;
}

interface NormalizeVideoBufferOptions {
  codec: NormalizedVideoCodec;
  stripAudio?: boolean;
  onProgress?: (progress: VideoTranscodeProgress) => void;
}

interface RunFfmpegOptions {
  ffmpegBinary?: string;
  inputDurationMs?: number | null;
  onProgress?: (progress: VideoTranscodeProgress) => void;
}

function parseFfmpegClockToMs(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fractionRaw = (match[4] || "").slice(0, 3).padEnd(3, "0");
  const millis = fractionRaw ? Number(fractionRaw) : 0;

  if (![hours, minutes, seconds, millis].every(Number.isFinite)) return null;
  return (((hours * 60) + minutes) * 60 + seconds) * 1000 + millis;
}

function parseFfmpegDurationMs(stderr: string): number | null {
  const match = stderr.match(/Duration:\s*([0-9:.]+)/);
  return parseFfmpegClockToMs(match?.[1]);
}

function parseFfmpegSpeed(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "N/A") return null;
  const normalized = trimmed.endsWith("x") ? trimmed.slice(0, -1) : trimmed;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function probeInputDurationMs(ffmpeg: string, inputPath: string): Promise<number | null> {
  const proc = Bun.spawn([ffmpeg, "-hide_banner", "-i", inputPath], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = proc.stderr ? await Bun.readableStreamToText(proc.stderr as ReadableStream) : "";
  await proc.exited;
  return parseFfmpegDurationMs(stderr);
}

async function consumeFfmpegProgress(
  stream: ReadableStream<Uint8Array>,
  inputDurationMs: number | null | undefined,
  onProgress: (progress: VideoTranscodeProgress) => void,
): Promise<boolean> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fields: Record<string, string> = {};
  let lastPercentBucket = -1;
  let seenEnd = false;

  const emit = () => {
    const marker = (fields.progress || "").trim().toLowerCase();
    if (!marker) return;

    const currentTimeMs = parseFfmpegClockToMs(fields.out_time);
    const done = marker === "end";
    const rawPercent =
      done
        ? 100
        : inputDurationMs && inputDurationMs > 0 && currentTimeMs !== null
        ? Math.max(0, Math.min(100, (currentTimeMs / inputDurationMs) * 100))
        : null;
    const roundedPercent = rawPercent === null ? null : Math.max(0, Math.min(100, Math.round(rawPercent)));

    if (!done && roundedPercent !== null && roundedPercent === lastPercentBucket) {
      fields = {};
      return;
    }

    if (roundedPercent !== null) lastPercentBucket = roundedPercent;
    if (done) seenEnd = true;

    onProgress({
      currentTimeMs,
      durationMs: inputDurationMs ?? null,
      percent: roundedPercent,
      speed: parseFfmpegSpeed(fields.speed),
      done,
    });
    fields = {};
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const splitAt = trimmed.indexOf("=");
        if (splitAt <= 0) continue;
        fields[trimmed.slice(0, splitAt)] = trimmed.slice(splitAt + 1);
        if (trimmed.startsWith("progress=")) {
          emit();
        }
      }
    }

    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing) {
      for (const line of trailing.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const splitAt = trimmed.indexOf("=");
        if (splitAt <= 0) continue;
        fields[trimmed.slice(0, splitAt)] = trimmed.slice(splitAt + 1);
      }
      emit();
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore stream cleanup failure */
    }
  }
  return seenEnd;
}

async function runFfmpeg(args: string[], options?: RunFfmpegOptions): Promise<boolean> {
  const ffmpeg = options?.ffmpegBinary ?? await resolveFfmpegBinary();
  if (!ffmpeg) return false;

  const wantProgress = typeof options?.onProgress === "function";
  const proc = Bun.spawn([
    ffmpeg,
    "-hide_banner",
    "-loglevel",
    "error",
    ...(wantProgress ? ["-progress", "pipe:1", "-nostats"] : []),
    ...args,
  ], {
    stdout: wantProgress ? "pipe" : "ignore",
    stderr: "ignore",
  });
  const progressTask =
    wantProgress && proc.stdout
      ? consumeFfmpegProgress(
          proc.stdout as ReadableStream<Uint8Array>,
          options?.inputDurationMs,
          options!.onProgress!,
        )
      : null;
  const code = await proc.exited;
  if (progressTask) {
    try {
      const sawEnd = await progressTask;
      if (!sawEnd && code === 0) {
        options?.onProgress?.({
          currentTimeMs: options.inputDurationMs ?? null,
          durationMs: options.inputDurationMs ?? null,
          percent: 100,
          speed: null,
          done: true,
        });
      }
    } catch {
      /* ignore progress stream parse failures */
    }
  }
  return code === 0;
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
    const ffmpeg = await resolveFfmpegBinary();
    if (!ffmpeg) return null;

    const inputPath = join(workdir, `input${ext}`);
    const outputPath = join(workdir, "output.mp4");
    await Bun.write(inputPath, input);
    const inputDurationMs = options.onProgress
      ? await probeInputDurationMs(ffmpeg, inputPath)
      : null;

    const codecArgs =
      options.codec === "hevc"
        ? ["-c:v", "libx265", "-preset", "fast", "-crf", "28", "-tag:v", "hvc1", "-pix_fmt", "yuv420p"]
        : ["-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p"];

    const ffmpegArgs = [
      "-i", inputPath,
      "-map", "0:v:0",
      ...(options.stripAudio === false ? ["-map", "0:a?"] : ["-an"]),
      ...codecArgs,
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ];

    const ok = await runFfmpeg(ffmpegArgs, {
      ffmpegBinary: ffmpeg,
      inputDurationMs,
      onProgress: options.onProgress,
    });
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
