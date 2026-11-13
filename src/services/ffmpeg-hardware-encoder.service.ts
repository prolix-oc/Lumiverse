import type { NormalizedVideoCodec } from "./silent-video.service";

export type HardwareEncoderBackend = "videotoolbox" | "nvenc" | "qsv" | "amf" | "mediafoundation";

export interface HardwareVideoEncoder {
  backend: HardwareEncoderBackend;
  encoder: string;
  args: string[];
}

const encoderListCache = new Map<string, Promise<Set<string>>>();
const resolvedEncoderCache = new Map<string, Promise<HardwareVideoEncoder | null>>();

/**
 * Quality-oriented, latency-tolerant settings for stored wallpaper media.
 * Each backend uses its native quality-control model; CRF is not portable to
 * hardware encoders.
 */
export function hardwareVideoEncoderCandidates(
  codec: NormalizedVideoCodec,
  platform: NodeJS.Platform = process.platform,
): HardwareVideoEncoder[] {
  const h264 = codec === "h264";
  const candidates: Record<HardwareEncoderBackend, HardwareVideoEncoder> = {
    videotoolbox: {
      backend: "videotoolbox",
      encoder: h264 ? "h264_videotoolbox" : "hevc_videotoolbox",
      args: [
        "-c:v", h264 ? "h264_videotoolbox" : "hevc_videotoolbox",
        "-q:v", "65",
        "-realtime", "0",
        "-prio_speed", "0",
        "-allow_sw", "0",
        ...(h264 ? ["-profile:v", "high", "-coder", "cabac"] : ["-profile:v", "main"]),
      ],
    },
    nvenc: {
      backend: "nvenc",
      encoder: h264 ? "h264_nvenc" : "hevc_nvenc",
      args: [
        "-c:v", h264 ? "h264_nvenc" : "hevc_nvenc",
        "-preset", "p6",
        "-tune", "hq",
        "-rc", "vbr",
        "-cq", h264 ? "23" : "28",
        "-b:v", "0",
        "-spatial_aq", "1",
        ...(h264 ? ["-profile:v", "high"] : ["-profile:v", "main"]),
      ],
    },
    qsv: {
      backend: "qsv",
      encoder: h264 ? "h264_qsv" : "hevc_qsv",
      args: [
        "-c:v", h264 ? "h264_qsv" : "hevc_qsv",
        "-preset", "slow",
        "-global_quality", h264 ? "23" : "28",
        ...(h264 ? ["-profile:v", "high"] : ["-profile:v", "main"]),
      ],
    },
    amf: {
      backend: "amf",
      encoder: h264 ? "h264_amf" : "hevc_amf",
      args: [
        "-c:v", h264 ? "h264_amf" : "hevc_amf",
        "-quality", "quality",
        "-rc", "qvbr",
        "-qvbr_quality_level", "30",
        "-vbaq", "true",
        "-preencode", "true",
        ...(h264 ? ["-profile:v", "high"] : ["-profile:v", "main"]),
      ],
    },
    mediafoundation: {
      backend: "mediafoundation",
      encoder: h264 ? "h264_mf" : "hevc_mf",
      args: [
        "-c:v", h264 ? "h264_mf" : "hevc_mf",
        "-hw_encoding", "1",
        "-rate_control", "quality",
        "-quality", "70",
      ],
    },
  };

  const order: HardwareEncoderBackend[] = platform === "darwin"
    ? ["videotoolbox"]
    : platform === "win32"
      ? ["nvenc", "qsv", "amf", "mediafoundation"]
      : ["nvenc", "qsv"];
  return order.map((backend) => candidates[backend]);
}

async function listVideoEncoders(ffmpeg: string): Promise<Set<string>> {
  let pending = encoderListCache.get(ffmpeg);
  if (!pending) {
    pending = (async () => {
      try {
        const proc = Bun.spawn([ffmpeg, "-hide_banner", "-encoders"], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const stdout = proc.stdout ? await Bun.readableStreamToText(proc.stdout as ReadableStream) : "";
        if (await proc.exited !== 0) return new Set<string>();
        const names = new Set<string>();
        for (const line of stdout.split(/\r?\n/)) {
          const match = line.match(/^\s*V\S*\s+([a-z0-9_]+)/i);
          if (match?.[1]) names.add(match[1]);
        }
        return names;
      } catch {
        return new Set<string>();
      }
    })();
    encoderListCache.set(ffmpeg, pending);
  }
  return pending;
}

async function smokeTestEncoder(ffmpeg: string, candidate: HardwareVideoEncoder): Promise<boolean> {
  try {
    const proc = Bun.spawn([
      ffmpeg,
      "-hide_banner",
      "-loglevel", "error",
      "-f", "lavfi",
      "-i", "color=c=black:s=128x128:r=24:d=0.1",
      "-an",
      ...candidate.args,
      "-pix_fmt", "yuv420p",
      "-frames:v", "1",
      "-f", "null",
      "-",
    ], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return await proc.exited === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve only encoders that are both compiled into ffmpeg and usable by the
 * current host. A one-frame trial catches missing drivers, unavailable devices,
 * and hardware session failures that `ffmpeg -encoders` cannot detect.
 */
export async function resolveHardwareVideoEncoder(
  ffmpeg: string,
  codec: NormalizedVideoCodec,
): Promise<HardwareVideoEncoder | null> {
  const cacheKey = `${ffmpeg}:${process.platform}:${codec}`;
  let pending = resolvedEncoderCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const available = await listVideoEncoders(ffmpeg);
      for (const candidate of hardwareVideoEncoderCandidates(codec)) {
        if (!available.has(candidate.encoder)) continue;
        if (await smokeTestEncoder(ffmpeg, candidate)) return candidate;
      }
      return null;
    })();
    resolvedEncoderCache.set(cacheKey, pending);
  }
  return pending;
}

export function resetHardwareVideoEncoderResolution(): void {
  encoderListCache.clear();
  resolvedEncoderCache.clear();
}
