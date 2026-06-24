import { describe, expect, test } from "bun:test";
import { resetSilentVideoFfmpegProbe, stripAudioFromVideoBuffer } from "./silent-video.service";

describe("silent-video.service", () => {
  test("returns null for unsupported mime types without attempting processing", async () => {
    resetSilentVideoFfmpegProbe();
    const out = await stripAudioFromVideoBuffer(Buffer.from("not-a-video"), "image/png");
    expect(out).toBeNull();
  });
});
