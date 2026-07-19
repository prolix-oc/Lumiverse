import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { extname, join } from "path";
import { resolveFfmpegBinary } from "./ffmpeg-binary.service";

export type MediaSourceDTO =
  | {
      kind: "inline";
      data: Uint8Array;
      filename?: string;
      mime_type?: string;
    }
  | {
      kind: "upload";
      upload_id: string;
      filename?: string;
      mime_type?: string;
    }
  | {
      kind: "image";
      image_id: string;
    }
  | {
      kind: "audio";
      audio_id: string;
    };

export type MediaAudioFormatDTO =
  | "mp3"
  | "wav"
  | "ogg"
  | "aac"
  | "flac"
  | "m4a"
  | "webm";

export type MediaVideoFormatDTO =
  | "mp4"
  | "webm"
  | "mov"
  | "mkv";

export type MediaVideoCodecDTO =
  | "h264"
  | "hevc"
  | "vp9"
  | "av1"
  | "copy";

export type MediaAudioCodecDTO =
  | "aac"
  | "mp3"
  | "opus"
  | "vorbis"
  | "flac"
  | "pcm_s16le"
  | "copy";

export type MediaFitModeDTO = "contain" | "cover" | "stretch";

export interface MediaTransformResultDTO {
  data: Uint8Array;
  filename: string;
  mime_type: string;
  byte_size: number;
  duration_ms?: number | null;
  width?: number | null;
  height?: number | null;
}

export interface MediaConvertAudioRequestDTO {
  source: MediaSourceDTO;
  output_format: MediaAudioFormatDTO;
  audio_codec?: MediaAudioCodecDTO;
  bitrate_kbps?: number;
  sample_rate?: number;
  channels?: number;
  filename?: string;
  userId?: string;
}

export interface MediaConvertVideoRequestDTO {
  source: MediaSourceDTO;
  output_format: MediaVideoFormatDTO;
  filename?: string;
  userId?: string;
}

export interface MediaTranscodeVideoRequestDTO {
  source: MediaSourceDTO;
  output_format?: MediaVideoFormatDTO;
  video_codec?: MediaVideoCodecDTO;
  audio_codec?: MediaAudioCodecDTO | "none";
  video_bitrate_kbps?: number;
  audio_bitrate_kbps?: number;
  crf?: number;
  preset?: string;
  width?: number;
  height?: number;
  fps?: number;
  pixel_format?: string;
  faststart?: boolean;
  filename?: string;
  userId?: string;
}

export interface MediaRemoveAudioFromVideoRequestDTO {
  source: MediaSourceDTO;
  output_format?: MediaVideoFormatDTO;
  video_codec?: MediaVideoCodecDTO;
  filename?: string;
  userId?: string;
}

export interface MediaAddAudioToVideoRequestDTO {
  video: MediaSourceDTO;
  audio: MediaSourceDTO;
  output_format?: MediaVideoFormatDTO;
  video_codec?: MediaVideoCodecDTO;
  audio_codec?: MediaAudioCodecDTO;
  replace_existing_audio?: boolean;
  shortest?: boolean;
  audio_start_ms?: number;
  filename?: string;
  userId?: string;
}

export interface MediaCreateVideoFromImageAndAudioRequestDTO {
  image: MediaSourceDTO;
  audio: MediaSourceDTO;
  output_format?: MediaVideoFormatDTO;
  video_codec?: Exclude<MediaVideoCodecDTO, "copy">;
  audio_codec?: MediaAudioCodecDTO;
  width?: number;
  height?: number;
  fps?: number;
  fit_mode?: MediaFitModeDTO;
  background_color?: string;
  filename?: string;
  userId?: string;
}

export interface ResolvedMediaSourceDTO {
  path: string;
  filename?: string;
  mime_type?: string;
}

type MediaMetadata = {
  duration_ms: number | null;
  width: number | null;
  height: number | null;
};

const AUDIO_FORMAT_INFO: Record<MediaAudioFormatDTO, { ext: string; mime: string; defaultCodec: Exclude<MediaAudioCodecDTO, "copy"> }> = {
  mp3: { ext: ".mp3", mime: "audio/mpeg", defaultCodec: "mp3" },
  wav: { ext: ".wav", mime: "audio/wav", defaultCodec: "pcm_s16le" },
  ogg: { ext: ".ogg", mime: "audio/ogg", defaultCodec: "vorbis" },
  aac: { ext: ".aac", mime: "audio/aac", defaultCodec: "aac" },
  flac: { ext: ".flac", mime: "audio/flac", defaultCodec: "flac" },
  m4a: { ext: ".m4a", mime: "audio/mp4", defaultCodec: "aac" },
  webm: { ext: ".webm", mime: "audio/webm", defaultCodec: "opus" },
};

const VIDEO_FORMAT_INFO: Record<MediaVideoFormatDTO, { ext: string; mime: string; defaultVideoCodec: Exclude<MediaVideoCodecDTO, "copy">; defaultAudioCodec: Exclude<MediaAudioCodecDTO, "copy"> }> = {
  mp4: { ext: ".mp4", mime: "video/mp4", defaultVideoCodec: "h264", defaultAudioCodec: "aac" },
  webm: { ext: ".webm", mime: "video/webm", defaultVideoCodec: "vp9", defaultAudioCodec: "opus" },
  mov: { ext: ".mov", mime: "video/quicktime", defaultVideoCodec: "h264", defaultAudioCodec: "aac" },
  mkv: { ext: ".mkv", mime: "video/x-matroska", defaultVideoCodec: "h264", defaultAudioCodec: "aac" },
};

const VIDEO_EXT_TO_FORMAT: Record<string, MediaVideoFormatDTO> = {
  ".mp4": "mp4",
  ".m4v": "mp4",
  ".webm": "webm",
  ".mov": "mov",
  ".mkv": "mkv",
};

const VIDEO_MIME_TO_FORMAT: Record<string, MediaVideoFormatDTO> = {
  "video/mp4": "mp4",
  "video/x-m4v": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
};

const VIDEO_EXTENSIONS = new Set(Object.keys(VIDEO_EXT_TO_FORMAT).concat([
  ".avi",
  ".ogv",
  ".ogg",
  ".mpeg",
  ".mpg",
  ".ts",
  ".mts",
  ".m2ts",
  ".wmv",
]));

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".opus",
  ".aac",
  ".flac",
  ".m4a",
  ".webm",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".avif",
  ".bmp",
  ".svg",
]);

function sourceBaseName(filename: string | undefined, fallback: string): string {
  const trimmed = filename?.trim();
  if (!trimmed) return fallback;
  const ext = extname(trimmed);
  const base = ext ? trimmed.slice(0, -ext.length) : trimmed;
  const sanitized = base.replace(/[\\/:*?"<>|]/g, "_").trim();
  return sanitized || fallback;
}

function buildOutputFilename(filename: string | undefined, fallbackBase: string, ext: string): string {
  return `${sourceBaseName(filename, fallbackBase)}${ext}`;
}

function normalizedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
  return Math.max(1, Math.floor(parsed));
}

function nonNegativeInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }
  return Math.floor(parsed);
}

function normalizeFfmpegDimension(value: number | undefined, requireEven: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (!requireEven) return value;
  const even = value % 2 === 0 ? value : value - 1;
  return Math.max(2, even);
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

function parseFfmpegDimensions(stderr: string): { width: number | null; height: number | null } {
  const match = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})(?:[,\s]|$)/s);
  if (!match) return { width: null, height: null };
  const width = Number(match[1]);
  const height = Number(match[2]);
  return {
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null,
  };
}

function inferVideoFormatFromSource(source: ResolvedMediaSourceDTO): MediaVideoFormatDTO {
  const mime = normalizedString(source.mime_type)?.toLowerCase();
  if (mime && VIDEO_MIME_TO_FORMAT[mime]) return VIDEO_MIME_TO_FORMAT[mime];
  const ext = extname(source.filename || "").toLowerCase();
  return VIDEO_EXT_TO_FORMAT[ext] || "mp4";
}

function inferSourceKind(source: ResolvedMediaSourceDTO): "video" | "audio" | "image" | null {
  const mime = normalizedString(source.mime_type)?.toLowerCase();
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  if (mime?.startsWith("image/")) return "image";

  const ext = extname(source.filename || "").toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return null;
}

export function assertLikelyVideoSource(source: ResolvedMediaSourceDTO, fieldName = "source"): void {
  const kind = inferSourceKind(source);
  if (kind && kind !== "video") {
    throw new Error(`${fieldName} must reference a video source`);
  }
}

export function assertLikelyImageSource(source: ResolvedMediaSourceDTO, fieldName = "image"): void {
  const kind = inferSourceKind(source);
  if (kind && kind !== "image") {
    throw new Error(`${fieldName} must reference an image source`);
  }
}

async function requireFfmpegBinary(): Promise<string> {
  const ffmpeg = await resolveFfmpegBinary();
  if (!ffmpeg) {
    throw new Error("ffmpeg is required for spindle.media operations but is unavailable");
  }
  return ffmpeg;
}

async function runFfmpeg(ffmpeg: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn([ffmpeg, "-hide_banner", "-loglevel", "error", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
  const code = await proc.exited;
  return { ok: code === 0, stderr };
}

async function probeMediaMetadata(ffmpeg: string, path: string): Promise<MediaMetadata> {
  const proc = Bun.spawn([ffmpeg, "-hide_banner", "-i", path], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
  await proc.exited;
  const { width, height } = parseFfmpegDimensions(stderr);
  return {
    duration_ms: parseFfmpegDurationMs(stderr),
    width,
    height,
  };
}

async function buildResult(
  ffmpeg: string,
  outputPath: string,
  filename: string,
  mimeType: string,
): Promise<MediaTransformResultDTO> {
  if (!existsSync(outputPath)) {
    throw new Error("ffmpeg produced no output file");
  }
  const data = new Uint8Array(await Bun.file(outputPath).arrayBuffer());
  if (data.byteLength === 0) {
    throw new Error("ffmpeg produced an empty output file");
  }
  const meta = await probeMediaMetadata(ffmpeg, outputPath);
  return {
    data,
    filename,
    mime_type: mimeType,
    byte_size: data.byteLength,
    duration_ms: meta.duration_ms,
    width: meta.width,
    height: meta.height,
  };
}

function ffmpegVideoCodecName(codec: Exclude<MediaVideoCodecDTO, "copy">): string {
  switch (codec) {
    case "h264":
      return "libx264";
    case "hevc":
      return "libx265";
    case "vp9":
      return "libvpx-vp9";
    case "av1":
      return "libaom-av1";
  }
}

function ffmpegAudioCodecName(codec: Exclude<MediaAudioCodecDTO, "copy">): string {
  switch (codec) {
    case "aac":
      return "aac";
    case "mp3":
      return "libmp3lame";
    case "opus":
      return "libopus";
    case "vorbis":
      return "libvorbis";
    case "flac":
      return "flac";
    case "pcm_s16le":
      return "pcm_s16le";
  }
}

function buildAudioCodecArgs(
  codec: MediaAudioCodecDTO,
  options?: {
    bitrate_kbps?: number;
    sample_rate?: number;
    channels?: number;
    audio_bitrate_kbps?: number;
  },
): string[] {
  if (codec === "copy") return ["-c:a", "copy"];
  const args = ["-c:a", ffmpegAudioCodecName(codec)];
  const bitrate = positiveInteger(options?.bitrate_kbps ?? options?.audio_bitrate_kbps, "bitrate_kbps");
  if (codec === "mp3" || codec === "aac" || codec === "vorbis" || codec === "opus") {
    const effectiveBitrate = bitrate ?? (codec === "opus" ? 128 : 192);
    args.push("-b:a", `${effectiveBitrate}k`);
  }
  const sampleRate = positiveInteger(options?.sample_rate, "sample_rate");
  if (sampleRate) args.push("-ar", String(sampleRate));
  const channels = positiveInteger(options?.channels, "channels");
  if (channels) args.push("-ac", String(channels));
  return args;
}

function buildVideoCodecArgs(
  codec: MediaVideoCodecDTO,
  format: MediaVideoFormatDTO,
  options: {
    video_bitrate_kbps?: number;
    crf?: number;
    preset?: string;
    pixel_format?: string;
  },
): string[] {
  if (codec === "copy") return ["-c:v", "copy"];

  const args = ["-c:v", ffmpegVideoCodecName(codec)];
  const preset = normalizedString(options.preset);
  if (preset) {
    args.push("-preset", preset);
  } else if (codec === "h264" || codec === "hevc") {
    args.push("-preset", "fast");
  }

  const bitrate = positiveInteger(options.video_bitrate_kbps, "video_bitrate_kbps");
  if (bitrate) {
    args.push("-b:v", `${bitrate}k`);
  } else if (codec === "vp9" || codec === "av1") {
    args.push("-b:v", "0");
  }

  if (options.crf !== undefined && options.crf !== null) {
    const parsed = Number(options.crf);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error("crf must be a non-negative number");
    }
    args.push("-crf", String(parsed));
  } else if (codec === "h264") {
    args.push("-crf", "23");
  } else if (codec === "hevc") {
    args.push("-crf", "28");
  } else if (codec === "vp9") {
    args.push("-crf", "32");
  } else if (codec === "av1") {
    args.push("-crf", "30");
  }

  const pixelFormat = normalizedString(options.pixel_format)
    || ((codec === "h264" || codec === "hevc") ? "yuv420p" : undefined);
  if (pixelFormat) args.push("-pix_fmt", pixelFormat);

  if (codec === "hevc" && (format === "mp4" || format === "mov")) {
    args.push("-tag:v", "hvc1");
  }
  if (codec === "av1") {
    args.push("-cpu-used", "4");
  }
  return args;
}

function buildScaleFilter(
  width: number | undefined,
  height: number | undefined,
  requireEven: boolean,
): string | null {
  const normalizedWidth = normalizeFfmpegDimension(width, requireEven);
  const normalizedHeight = normalizeFfmpegDimension(height, requireEven);

  if (normalizedWidth && normalizedHeight) return `scale=${normalizedWidth}:${normalizedHeight}`;
  if (normalizedWidth) return `scale=${normalizedWidth}:-2`;
  if (normalizedHeight) return `scale=-2:${normalizedHeight}`;
  if (requireEven) return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  return null;
}

function buildImageFitFilter(
  width: number | undefined,
  height: number | undefined,
  fitMode: MediaFitModeDTO | undefined,
  backgroundColor: string | undefined,
): string | null {
  const normalizedWidth = normalizeFfmpegDimension(width, true);
  const normalizedHeight = normalizeFfmpegDimension(height, true);
  const color = normalizedString(backgroundColor) || "black";

  if (normalizedWidth && normalizedHeight) {
    if (fitMode === "cover") {
      return `scale=${normalizedWidth}:${normalizedHeight}:force_original_aspect_ratio=increase,crop=${normalizedWidth}:${normalizedHeight}`;
    }
    if (fitMode === "stretch") {
      return `scale=${normalizedWidth}:${normalizedHeight}`;
    }
    return `scale=${normalizedWidth}:${normalizedHeight}:force_original_aspect_ratio=decrease,pad=${normalizedWidth}:${normalizedHeight}:(ow-iw)/2:(oh-ih)/2:color=${color}`;
  }

  if (normalizedWidth) return `scale=${normalizedWidth}:-2`;
  if (normalizedHeight) return `scale=-2:${normalizedHeight}`;
  return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
}

function wantsFaststart(format: MediaVideoFormatDTO, faststart: boolean | undefined): boolean {
  if (faststart === false) return false;
  return format === "mp4" || format === "mov";
}

async function runOperation(
  build: (ffmpeg: string, workdir: string) => Promise<{ outputPath: string; filename: string; mimeType: string }>,
): Promise<MediaTransformResultDTO> {
  const ffmpeg = await requireFfmpegBinary();
  const workdir = mkdtempSync(join(tmpdir(), "lumiverse-media-op-"));
  try {
    const { outputPath, filename, mimeType } = await build(ffmpeg, workdir);
    return await buildResult(ffmpeg, outputPath, filename, mimeType);
  } finally {
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure */
    }
  }
}

export async function convertAudio(
  source: ResolvedMediaSourceDTO,
  input: MediaConvertAudioRequestDTO,
): Promise<MediaTransformResultDTO> {
  const formatInfo = AUDIO_FORMAT_INFO[input.output_format];

  return runOperation(async (ffmpeg, workdir) => {
    const outputPath = join(workdir, `output${formatInfo.ext}`);
    const outputFilename = buildOutputFilename(
      input.filename || source.filename,
      "audio-convert",
      formatInfo.ext,
    );
    const codec = input.audio_codec ?? formatInfo.defaultCodec;
    const result = await runFfmpeg(ffmpeg, [
      "-i", source.path,
      "-vn",
      ...buildAudioCodecArgs(codec, {
        bitrate_kbps: input.bitrate_kbps,
        sample_rate: input.sample_rate,
        channels: input.channels,
      }),
      "-y",
      outputPath,
    ]);
    if (!result.ok) {
      throw new Error(`audio conversion failed: ${result.stderr.trim().slice(0, 500) || "ffmpeg exited unsuccessfully"}`);
    }
    return {
      outputPath,
      filename: outputFilename,
      mimeType: formatInfo.mime,
    };
  });
}

async function transcodeVideoInternal(
  source: ResolvedMediaSourceDTO,
  input: {
    output_format?: MediaVideoFormatDTO;
    video_codec?: MediaVideoCodecDTO;
    audio_codec?: MediaAudioCodecDTO | "none";
    video_bitrate_kbps?: number;
    audio_bitrate_kbps?: number;
    crf?: number;
    preset?: string;
    width?: number;
    height?: number;
    fps?: number;
    pixel_format?: string;
    faststart?: boolean;
    filename?: string;
  },
): Promise<MediaTransformResultDTO> {
  const format = input.output_format ?? inferVideoFormatFromSource(source);
  const formatInfo = VIDEO_FORMAT_INFO[format];
  const requestedVideoCodec = input.video_codec ?? formatInfo.defaultVideoCodec;
  const requestedAudioCodec = input.audio_codec === undefined ? formatInfo.defaultAudioCodec : input.audio_codec;
  const fps = positiveInteger(input.fps, "fps");
  const width = positiveInteger(input.width, "width");
  const height = positiveInteger(input.height, "height");

  if (requestedVideoCodec === "copy" && (width || height || fps || input.crf !== undefined || input.preset || input.pixel_format)) {
    throw new Error("video_codec=copy cannot be combined with width, height, fps, crf, preset, or pixel_format");
  }

  return runOperation(async (ffmpeg, workdir) => {
    const outputPath = join(workdir, `output${formatInfo.ext}`);
    const outputFilename = buildOutputFilename(
      input.filename || source.filename,
      "video-transcode",
      formatInfo.ext,
    );
    const args = [
      "-i", source.path,
      "-map", "0:v:0",
    ];

    if (requestedAudioCodec === "none") {
      args.push("-an");
    } else {
      args.push("-map", "0:a?");
    }

    const requireEven = requestedVideoCodec === "h264" || requestedVideoCodec === "hevc";
    const filter = buildScaleFilter(width, height, requireEven);
    if (filter) args.push("-vf", filter);
    if (fps) args.push("-r", String(fps));

    args.push(...buildVideoCodecArgs(requestedVideoCodec, format, {
      video_bitrate_kbps: input.video_bitrate_kbps,
      crf: input.crf,
      preset: input.preset,
      pixel_format: input.pixel_format,
    }));

    if (requestedAudioCodec !== "none") {
      args.push(...buildAudioCodecArgs(requestedAudioCodec, {
        audio_bitrate_kbps: input.audio_bitrate_kbps,
      }));
    }

    if (wantsFaststart(format, input.faststart)) {
      args.push("-movflags", "+faststart");
    }

    args.push("-y", outputPath);

    const result = await runFfmpeg(ffmpeg, args);
    if (!result.ok) {
      throw new Error(`video transcode failed: ${result.stderr.trim().slice(0, 500) || "ffmpeg exited unsuccessfully"}`);
    }
    return {
      outputPath,
      filename: outputFilename,
      mimeType: formatInfo.mime,
    };
  });
}

export async function convertVideo(
  source: ResolvedMediaSourceDTO,
  input: MediaConvertVideoRequestDTO,
): Promise<MediaTransformResultDTO> {
  const formatInfo = VIDEO_FORMAT_INFO[input.output_format];

  return runOperation(async (ffmpeg, workdir) => {
    const outputPath = join(workdir, `output${formatInfo.ext}`);
    const outputFilename = buildOutputFilename(
      input.filename || source.filename,
      "video-convert",
      formatInfo.ext,
    );

    const copyAttempt = await runFfmpeg(ffmpeg, [
      "-i", source.path,
      "-map", "0:v:0",
      "-map", "0:a?",
      "-c", "copy",
      ...(wantsFaststart(input.output_format, true) ? ["-movflags", "+faststart"] : []),
      "-y",
      outputPath,
    ]);

    if (!copyAttempt.ok) {
      const fallback = await runFfmpeg(ffmpeg, [
        "-i", source.path,
        "-map", "0:v:0",
        "-map", "0:a?",
        ...buildVideoCodecArgs(formatInfo.defaultVideoCodec, input.output_format, {}),
        ...buildAudioCodecArgs(formatInfo.defaultAudioCodec, {}),
        ...(wantsFaststart(input.output_format, true) ? ["-movflags", "+faststart"] : []),
        "-y",
        outputPath,
      ]);
      if (!fallback.ok) {
        throw new Error(`video conversion failed: ${fallback.stderr.trim().slice(0, 500) || "ffmpeg exited unsuccessfully"}`);
      }
    }

    return {
      outputPath,
      filename: outputFilename,
      mimeType: formatInfo.mime,
    };
  });
}

export async function transcodeVideo(
  source: ResolvedMediaSourceDTO,
  input: MediaTranscodeVideoRequestDTO,
): Promise<MediaTransformResultDTO> {
  return transcodeVideoInternal(source, input);
}

export async function removeAudioFromVideo(
  source: ResolvedMediaSourceDTO,
  input: MediaRemoveAudioFromVideoRequestDTO,
): Promise<MediaTransformResultDTO> {
  const format = input.output_format ?? inferVideoFormatFromSource(source);
  const formatInfo = VIDEO_FORMAT_INFO[format];
  const requestedVideoCodec = input.video_codec ?? "copy";

  return runOperation(async (ffmpeg, workdir) => {
    const outputPath = join(workdir, `output${formatInfo.ext}`);
    const outputFilename = buildOutputFilename(
      input.filename || source.filename,
      "video-no-audio",
      formatInfo.ext,
    );

    const firstAttempt = await runFfmpeg(ffmpeg, [
      "-i", source.path,
      "-map", "0:v:0",
      "-an",
      ...buildVideoCodecArgs(requestedVideoCodec, format, {}),
      ...(wantsFaststart(format, true) ? ["-movflags", "+faststart"] : []),
      "-y",
      outputPath,
    ]);

    if (!firstAttempt.ok && requestedVideoCodec === "copy" && input.video_codec === undefined) {
      const fallback = await runFfmpeg(ffmpeg, [
        "-i", source.path,
        "-map", "0:v:0",
        "-an",
        ...buildVideoCodecArgs(formatInfo.defaultVideoCodec, format, {}),
        ...(wantsFaststart(format, true) ? ["-movflags", "+faststart"] : []),
        "-y",
        outputPath,
      ]);
      if (!fallback.ok) {
        throw new Error(`remove audio failed: ${fallback.stderr.trim().slice(0, 500) || "ffmpeg exited unsuccessfully"}`);
      }
    } else if (!firstAttempt.ok) {
      throw new Error(`remove audio failed: ${firstAttempt.stderr.trim().slice(0, 500) || "ffmpeg exited unsuccessfully"}`);
    }

    return {
      outputPath,
      filename: outputFilename,
      mimeType: formatInfo.mime,
    };
  });
}

export async function addAudioToVideo(
  video: ResolvedMediaSourceDTO,
  audio: ResolvedMediaSourceDTO,
  input: MediaAddAudioToVideoRequestDTO,
): Promise<MediaTransformResultDTO> {
  const format = input.output_format ?? inferVideoFormatFromSource(video);
  const formatInfo = VIDEO_FORMAT_INFO[format];
  const replaceExistingAudio = input.replace_existing_audio !== false;
  const requestedVideoCodec = input.video_codec ?? "copy";
  const requestedAudioCodec = input.audio_codec ?? formatInfo.defaultAudioCodec;
  const audioStartMs = nonNegativeInteger(input.audio_start_ms, "audio_start_ms");

  return runOperation(async (ffmpeg, workdir) => {
    const outputPath = join(workdir, `output${formatInfo.ext}`);
    const outputFilename = buildOutputFilename(
      input.filename || video.filename,
      "video-with-audio",
      formatInfo.ext,
    );

    const buildArgs = (videoCodec: MediaVideoCodecDTO): string[] => {
      const args = ["-i", video.path];
      if (audioStartMs && audioStartMs > 0) {
        args.push("-itsoffset", (audioStartMs / 1000).toFixed(3));
      }
      args.push("-i", audio.path);
      args.push("-map", "0:v:0");
      if (!replaceExistingAudio) {
        args.push("-map", "0:a?");
      }
      args.push("-map", "1:a:0");
      args.push(...buildVideoCodecArgs(videoCodec, format, {}));
      args.push(...buildAudioCodecArgs(requestedAudioCodec, {}));
      if (input.shortest) args.push("-shortest");
      if (wantsFaststart(format, true)) args.push("-movflags", "+faststart");
      args.push("-y", outputPath);
      return args;
    };

    const firstAttempt = await runFfmpeg(ffmpeg, buildArgs(requestedVideoCodec));
    if (!firstAttempt.ok && requestedVideoCodec === "copy" && input.video_codec === undefined) {
      const fallback = await runFfmpeg(ffmpeg, buildArgs(formatInfo.defaultVideoCodec));
      if (!fallback.ok) {
        throw new Error(`add audio failed: ${fallback.stderr.trim().slice(0, 500) || "ffmpeg exited unsuccessfully"}`);
      }
    } else if (!firstAttempt.ok) {
      throw new Error(`add audio failed: ${firstAttempt.stderr.trim().slice(0, 500) || "ffmpeg exited unsuccessfully"}`);
    }

    return {
      outputPath,
      filename: outputFilename,
      mimeType: formatInfo.mime,
    };
  });
}

export async function createVideoFromImageAndAudio(
  image: ResolvedMediaSourceDTO,
  audio: ResolvedMediaSourceDTO,
  input: MediaCreateVideoFromImageAndAudioRequestDTO,
): Promise<MediaTransformResultDTO> {
  const format = input.output_format ?? "mp4";
  const formatInfo = VIDEO_FORMAT_INFO[format];
  const videoCodec = input.video_codec ?? formatInfo.defaultVideoCodec;
  const audioCodec = input.audio_codec ?? formatInfo.defaultAudioCodec;
  const fps = positiveInteger(input.fps, "fps") ?? 30;
  const width = positiveInteger(input.width, "width");
  const height = positiveInteger(input.height, "height");

  return runOperation(async (ffmpeg, workdir) => {
    const outputPath = join(workdir, `output${formatInfo.ext}`);
    const outputFilename = buildOutputFilename(
      input.filename || image.filename,
      "image-audio-video",
      formatInfo.ext,
    );
    const filter = buildImageFitFilter(width, height, input.fit_mode, input.background_color);
    const result = await runFfmpeg(ffmpeg, [
      "-loop", "1",
      "-i", image.path,
      "-i", audio.path,
      "-map", "0:v:0",
      "-map", "1:a:0",
      ...(filter ? ["-vf", filter] : []),
      "-r", String(fps),
      ...buildVideoCodecArgs(videoCodec, format, {}),
      ...buildAudioCodecArgs(audioCodec, {}),
      "-shortest",
      ...(wantsFaststart(format, true) ? ["-movflags", "+faststart"] : []),
      "-y",
      outputPath,
    ]);
    if (!result.ok) {
      throw new Error(`image+audio video creation failed: ${result.stderr.trim().slice(0, 500) || "ffmpeg exited unsuccessfully"}`);
    }
    return {
      outputPath,
      filename: outputFilename,
      mimeType: formatInfo.mime,
    };
  });
}
