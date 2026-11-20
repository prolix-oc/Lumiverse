import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveFfmpegBinary } from "./ffmpeg-binary.service";
import {
  isLikelyVideoUpload,
  isVideoStreamCopyCompatible,
  normalizeVideoBuffer,
  parseFfmpegVideoProbe,
  resetSilentVideoFfmpegProbe,
  resolveVideoInputExtension,
  stripAudioFromVideoBuffer,
} from "./silent-video.service";

describe("silent-video.service", () => {
  test("parses video stream compatibility metadata from an ffmpeg probe", () => {
    const probe = parseFfmpegVideoProbe(`
      Duration: 00:01:02.50, start: 0.000000, bitrate: 1000 kb/s
      Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive, bt709), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps
    `);

    expect(probe).toEqual({
      durationMs: 62_500,
      codec: "h264",
      profile: "High",
      pixelFormat: "yuv420p",
      width: 1920,
      height: 1080,
    });
    expect(isVideoStreamCopyCompatible(probe, "h264")).toBe(true);
    expect(isVideoStreamCopyCompatible(probe, "hevc")).toBe(false);
  });

  test("rejects high-bit-depth and non-browser-safe streams from the copy path", () => {
    const probe = parseFfmpegVideoProbe(`
      Duration: 00:00:05.00, start: 0.000000, bitrate: 1000 kb/s
      Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc), 3840x2160, 30 fps
    `);
    expect(isVideoStreamCopyCompatible(probe, "hevc")).toBe(false);
  });

  test("detects common phone and desktop video uploads when mime is missing", () => {
    expect(resolveVideoInputExtension("", "clip.MOV")).toBe(".mov");
    expect(resolveVideoInputExtension("", "clip.m4v")).toBe(".m4v");
    expect(isLikelyVideoUpload("", "clip.mov")).toBe(true);
    expect(isLikelyVideoUpload("", "clip.m4v")).toBe(true);
    expect(isLikelyVideoUpload("", "image.png")).toBe(false);
  });

  test("returns null for unsupported mime types without attempting processing", async () => {
    resetSilentVideoFfmpegProbe();
    const out = await stripAudioFromVideoBuffer(Buffer.from("not-a-video"), "image/png");
    expect(out).toBeNull();
  });

  test("skips normalization for non-video uploads", async () => {
    resetSilentVideoFfmpegProbe();
    const out = await normalizeVideoBuffer(
      Buffer.from("not-a-video"),
      "image/png",
      "image.png",
      { codec: "h264", stripAudio: true },
    );
    expect(out).toBeNull();
  });

  test("normalizes a tiny mov upload to mp4 when ffmpeg is available", async () => {
    const ffmpeg = await resolveFfmpegBinary();
    if (!ffmpeg) return;

    const workdir = mkdtempSync(join(tmpdir(), "lumiverse-silent-video-test-"));
    try {
      const inputPath = join(workdir, "input.mov");
      const generator = Bun.spawn([
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=16x16:d=0.2",
        "-an",
        "-c:v",
        "mpeg4",
        "-y",
        inputPath,
      ], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await generator.exited).toBe(0);

      const input = Buffer.from(await Bun.file(inputPath).bytes());
      const out = await normalizeVideoBuffer(input, "video/quicktime", "input.mov", {
        codec: "h264",
        stripAudio: true,
      });

      expect(out).not.toBeNull();
      expect(out?.mimeType).toBe("video/mp4");
      expect(out?.ext).toBe(".mp4");
      expect(["hardware", "transcode"]).toContain(out?.mode ?? "");
      expect(out!.buffer.byteLength).toBeGreaterThan(0);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("stream-copies a compatible H.264 upload instead of re-encoding it", async () => {
    const ffmpeg = await resolveFfmpegBinary();
    if (!ffmpeg) return;

    const workdir = mkdtempSync(join(tmpdir(), "lumiverse-silent-video-copy-test-"));
    try {
      const inputPath = join(workdir, "input.mp4");
      const generator = Bun.spawn([
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:d=0.2",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-y",
        inputPath,
      ], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await generator.exited).toBe(0);

      const input = Buffer.from(await Bun.file(inputPath).bytes());
      const out = await normalizeVideoBuffer(input, "video/mp4", "input.mp4", {
        codec: "h264",
        stripAudio: true,
      });

      expect(out?.mode).toBe("copy");
      expect(out?.mimeType).toBe("video/mp4");
      expect(out!.buffer.byteLength).toBeGreaterThan(0);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("reports ffmpeg transcode progress while normalizing a mov upload", async () => {
    const ffmpeg = await resolveFfmpegBinary();
    if (!ffmpeg) return;

    const workdir = mkdtempSync(join(tmpdir(), "lumiverse-silent-video-progress-test-"));
    try {
      const inputPath = join(workdir, "progress.mov");
      const generator = Bun.spawn([
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=1280x720:d=3",
        "-an",
        "-c:v",
        "mpeg4",
        "-y",
        inputPath,
      ], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await generator.exited).toBe(0);

      const input = Buffer.from(await Bun.file(inputPath).bytes());
      const progress: Array<{ percent: number | null; done: boolean }> = [];
      const out = await normalizeVideoBuffer(input, "video/quicktime", "progress.mov", {
        codec: "h264",
        stripAudio: true,
        onProgress: (update) => {
          progress.push({ percent: update.percent, done: update.done });
        },
      });

      expect(out).not.toBeNull();
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.some((entry) => entry.done)).toBe(true);
      expect(progress.some((entry) => entry.percent === 100)).toBe(true);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
