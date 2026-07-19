import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveFfmpegBinary } from "./ffmpeg-binary.service";
import {
  isLikelyVideoUpload,
  normalizeVideoBuffer,
  resetSilentVideoFfmpegProbe,
  resolveVideoInputExtension,
  stripAudioFromVideoBuffer,
} from "./silent-video.service";

describe("silent-video.service", () => {
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
