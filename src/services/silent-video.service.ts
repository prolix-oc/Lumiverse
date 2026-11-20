import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { extname, join } from "path";
import { isFfmpegBinaryAvailable, resetFfmpegBinaryResolution, resolveFfmpegBinary } from "./ffmpeg-binary.service";
import { resetHardwareVideoEncoderResolution, resolveHardwareVideoEncoder } from "./ffmpeg-hardware-encoder.service";

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
  resetHardwareVideoEncoderResolution();
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

export interface VideoInputProbe {
  durationMs: number | null;
  codec: NormalizedVideoCodec | null;
  profile: string | null;
  pixelFormat: string | null;
  width: number | null;
  height: number | null;
}

export type VideoNormalizationMode = "copy" | "hardware" | "transcode";

export interface NormalizedVideoBufferResult {
  buffer: Buffer;
  ext: ".mp4";
  mimeType: "video/mp4";
  mode: VideoNormalizationMode;
  encoder?: string;
}

const COPY_SAFE_H264_PROFILES = new Set([
  "baseline",
  "constrained baseline",
  "main",
  "high",
  "constrained high",
]);

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

/**
 * Parse the first video stream from ffmpeg's stable human-readable probe
 * banner. The bundled ffmpeg-static package does not include ffprobe, so this
 * keeps probing available on hosts that have no separate ffprobe binary.
 */
export function parseFfmpegVideoProbe(stderr: string): VideoInputProbe {
  const result: VideoInputProbe = {
    durationMs: parseFfmpegDurationMs(stderr),
    codec: null,
    profile: null,
    pixelFormat: null,
    width: null,
    height: null,
  };
  const streamLine = stderr
    .split(/\r?\n/)
    .find((line) => /Stream #.*Video:\s*/i.test(line));
  if (!streamLine) return result;

  const marker = streamLine.search(/Video:\s*/i);
  if (marker < 0) return result;
  const descriptor = streamLine.slice(marker).replace(/^Video:\s*/i, "");
  const codecName = descriptor.match(/^([a-z0-9_]+)/i)?.[1]?.toLowerCase();
  if (codecName === "h264" || codecName === "hevc") result.codec = codecName;

  const firstParenthetical = descriptor.match(/^[^(,]+\(([^)]+)\)/)?.[1]?.trim() ?? null;
  // Codec tags such as `(avc1 / 0x31637661)` occupy the same position when
  // ffmpeg has no profile to report; do not mistake those for a profile.
  if (firstParenthetical && !firstParenthetical.includes("/") && !/^0x/i.test(firstParenthetical)) {
    result.profile = firstParenthetical;
  }

  const pixelMatch = descriptor.match(
    /,\s*((?:yuv|yuva|nv|p0|p2|gbrp|rgb|bgr|gray)[a-z0-9_]+)(?:\([^)]*\))?\s*,/i,
  );
  if (pixelMatch?.[1]) {
    result.pixelFormat = pixelMatch[1].toLowerCase();
    const afterPixelFormat = descriptor.slice((pixelMatch.index ?? 0) + pixelMatch[0].length);
    const dimensions = afterPixelFormat.match(/(\d{1,6})x(\d{1,6})(?:[\s,]|$)/);
    if (dimensions) {
      result.width = Number(dimensions[1]);
      result.height = Number(dimensions[2]);
    }
  }
  return result;
}

export function isVideoStreamCopyCompatible(
  probe: VideoInputProbe,
  requestedCodec: NormalizedVideoCodec,
): boolean {
  if (probe.codec !== requestedCodec || probe.pixelFormat !== "yuv420p") return false;
  if (!probe.width || !probe.height || probe.width % 2 !== 0 || probe.height % 2 !== 0) return false;

  const profile = probe.profile?.trim().toLowerCase();
  if (!profile) return false;
  if (requestedCodec === "hevc") return profile === "main";
  return COPY_SAFE_H264_PROFILES.has(profile);
}

function parseFfmpegSpeed(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "N/A") return null;
  const normalized = trimmed.endsWith("x") ? trimmed.slice(0, -1) : trimmed;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function probeInputVideo(ffmpeg: string, inputPath: string): Promise<VideoInputProbe> {
  const proc = Bun.spawn([ffmpeg, "-hide_banner", "-i", inputPath], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = proc.stderr ? await Bun.readableStreamToText(proc.stderr as ReadableStream) : "";
  await proc.exited;
  return parseFfmpegVideoProbe(stderr);
}

function emitCompletedProgress(
  onProgress: ((progress: VideoTranscodeProgress) => void) | undefined,
  durationMs: number | null,
): void {
  onProgress?.({
    currentTimeMs: durationMs,
    durationMs,
    percent: 100,
    speed: null,
    done: true,
  });
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
): Promise<NormalizedVideoBufferResult | null> {
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
    const probe = await probeInputVideo(ffmpeg, inputPath);

    if (isVideoStreamCopyCompatible(probe, options.codec)) {
      const copyArgs = [
        "-i", inputPath,
        "-map", "0:v:0",
        ...(options.stripAudio === false ? ["-map", "0:a?", "-c:a", "copy"] : ["-an"]),
        "-c:v", "copy",
        ...(options.codec === "hevc" ? ["-tag:v", "hvc1"] : []),
        "-movflags", "+faststart",
        "-y",
        outputPath,
      ];
      const copied = await runFfmpeg(copyArgs, { ffmpegBinary: ffmpeg });
      if (copied && existsSync(outputPath)) {
        const data = await Bun.file(outputPath).bytes();
        if (data.length > 0) {
          emitCompletedProgress(options.onProgress, probe.durationMs);
          return {
            buffer: Buffer.from(data),
            ext: ".mp4",
            mimeType: "video/mp4",
            mode: "copy",
          };
        }
      }
    }

    const hardwareEncoder = await resolveHardwareVideoEncoder(ffmpeg, options.codec);
    if (hardwareEncoder) {
      const hardwareArgs = [
        "-i", inputPath,
        "-map", "0:v:0",
        ...(options.stripAudio === false ? ["-map", "0:a?"] : ["-an"]),
        ...hardwareEncoder.args,
        "-pix_fmt", "yuv420p",
        ...(options.codec === "hevc" ? ["-tag:v", "hvc1"] : []),
        "-movflags", "+faststart",
        "-y",
        outputPath,
      ];
      const encoded = await runFfmpeg(hardwareArgs, {
        ffmpegBinary: ffmpeg,
        inputDurationMs: probe.durationMs,
        onProgress: options.onProgress,
      });
      if (encoded && existsSync(outputPath)) {
        const data = await Bun.file(outputPath).bytes();
        if (data.length > 0) {
          return {
            buffer: Buffer.from(data),
            ext: ".mp4",
            mimeType: "video/mp4",
            mode: "hardware",
            encoder: hardwareEncoder.encoder,
          };
        }
      }
    }

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
      inputDurationMs: probe.durationMs,
      onProgress: options.onProgress,
    });
    if (!ok || !existsSync(outputPath)) return null;

    const data = await Bun.file(outputPath).bytes();
    if (data.length === 0) return null;

    return {
      buffer: Buffer.from(data),
      ext: ".mp4",
      mimeType: "video/mp4",
      mode: "transcode",
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
