import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SUPPORTED_VIDEO_MIME_TO_EXT: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

let ffmpegAvailability: boolean | null = null;

export async function isFfmpegAvailableForSilentVideo(): Promise<boolean> {
  if (ffmpegAvailability !== null) return ffmpegAvailability;
  try {
    const proc = Bun.spawn(["ffmpeg", "-version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    ffmpegAvailability = (await proc.exited) === 0;
  } catch {
    ffmpegAvailability = false;
  }
  return ffmpegAvailability;
}

export function resetSilentVideoFfmpegProbe(): void {
  ffmpegAvailability = null;
}

function outputExtensionForMime(mimeType: string): string | null {
  return SUPPORTED_VIDEO_MIME_TO_EXT[(mimeType || "").toLowerCase()] ?? null;
}

async function runFfmpeg(args: string[]): Promise<boolean> {
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

export async function stripAudioFromVideoBuffer(input: Buffer, mimeType: string): Promise<Buffer | null> {
  const ext = outputExtensionForMime(mimeType);
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
